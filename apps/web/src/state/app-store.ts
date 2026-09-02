import type {
  Attribution,
  MobilityEntity,
  ServiceAlert,
  StaticTransitData,
} from "@japan-live/shared";
import { serviceSecondsFor } from "@japan-live/core";
import { TransitNetwork } from "@japan-live/transit";
import { SimulationClock, type Speed } from "@japan-live/simulation";
import {
  DemoProvider,
  GatewayClient,
  JREastProvider,
  ProviderRegistry,
  TokyoMetroProvider,
  ToeiProvider,
  type ProviderState,
} from "@japan-live/providers";
import { CONFIG, IS_DEMO_MODE } from "../config.js";
import type { SceneHealth } from "../scene/viewer.js";
import type { BuildingDiagnostics } from "../scene/buildings.js";
import type { PerfSnapshot } from "../scene/perf.js";

export interface LayerToggles {
  terrain: boolean;
  buildings: boolean;
  railways: boolean;
  stations: boolean;
  trains: boolean;
  xray: boolean;
}

export const DEFAULT_LAYERS: LayerToggles = {
  terrain: true,
  buildings: true,
  railways: true,
  stations: true,
  trains: true,
  xray: false,
};

export interface AppSnapshot {
  ready: boolean;
  loadError?: string;
  demoMode: boolean;
  clock: { mode: "LIVE" | "SIMULATION"; speed: Speed; currentTime: number; paused: boolean };
  layers: LayerToggles;
  providers: ProviderState[];
  alerts: ServiceAlert[];
  attributions: Attribution[];
  trainCount: number;
  dataset?: { name: string; approximate: boolean; note?: string };
  sceneHealth: SceneHealth;
  buildings?: BuildingDiagnostics;
}

type Listener = (snapshot: AppSnapshot) => void;

/**
 * Everything that is not Cesium.
 *
 * React subscribes to snapshots of this; the scene reads `entities` directly each frame.
 * Keeping the two apart is what stops React re-rendering at 60 Hz.
 */
export class AppStore {
  readonly clock = new SimulationClock();
  private readonly registry = new ProviderRegistry();
  private readonly listeners = new Set<Listener>();

  network: TransitNetwork | null = null;
  entities: MobilityEntity[] = [];

  private layers: LayerToggles = { ...DEFAULT_LAYERS };
  private providerStates: ProviderState[] = [];
  private alerts: ServiceAlert[] = [];
  private ready = false;
  private loadError?: string;
  private dataset?: { name: string; approximate: boolean; note?: string };
  private sceneHealth: SceneHealth = {
    terrain: "loading",
    basemap: "loading",
    buildings: "loading",
    notes: {},
  };
  private buildingDiagnostics?: BuildingDiagnostics;
  /**
   * Frame metrics live OUTSIDE the main snapshot, with their own subscribers.
   *
   * They change twice a second by nature. Putting them in the app snapshot would
   * re-render the whole tree at 2 Hz forever, which is a strange way to build a
   * performance feature. Only the panel that displays them subscribes, and the scene
   * skips computing them entirely when nobody is looking.
   */
  private perf: PerfSnapshot | null = null;
  private readonly perfListeners = new Set<() => void>();
  private polling = false;
  private lastPollAt = 0;
  /**
   * useSyncExternalStore compares snapshots by identity, so getSnapshot MUST return the
   * same object until something actually changes — building a fresh one each call is an
   * infinite render loop.
   */
  private cached: AppSnapshot | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Invalidate the cached snapshot and notify subscribers. */
  private emit(): void {
    this.cached = null;
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  snapshot(): AppSnapshot {
    if (this.cached) return this.cached;
    this.cached = this.buildSnapshot();
    return this.cached;
  }

  private buildSnapshot(): AppSnapshot {
    return {
      ready: this.ready,
      loadError: this.loadError,
      demoMode: IS_DEMO_MODE,
      clock: {
        mode: this.clock.currentMode,
        speed: this.clock.currentSpeed,
        currentTime: this.clock.currentTime,
        paused: this.clock.isPaused,
      },
      layers: this.layers,
      providers: this.providerStates,
      alerts: this.alerts,
      attributions: this.attributions(),
      trainCount: this.entities.length,
      dataset: this.dataset,
      sceneHealth: this.sceneHealth,
      buildings: this.buildingDiagnostics,
    };
  }

  /** Load the static dataset and construct providers around it. */
  async init(): Promise<void> {
    let data: StaticTransitData | null = null;
    try {
      const res = await fetch(CONFIG.datasetUrl, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`dataset HTTP ${res.status}`);
      data = (await res.json()) as StaticTransitData;
      this.network = new TransitNetwork(data);
      this.dataset = {
        name: data.meta.name,
        approximate: data.meta.approximate,
        note: data.meta.note,
      };
    } catch (err) {
      // Without a dataset there is no rail network to draw, but the globe still works.
      this.loadError = `路線データを読み込めませんでした: ${
        err instanceof Error ? err.message : "unknown"
      }`;
    }

    const client = CONFIG.gatewayUrl ? new GatewayClient({ baseUrl: CONFIG.gatewayUrl }) : null;
    const serviceSecondsAt = () => serviceSecondsFor(this.clock.currentTime);

    if (client && this.network) {
      // LIVE: Toei realtime, Metro schedule + status.
      this.registry.register(new ToeiProvider({ client, network: this.network }));
      this.registry.register(
        new TokyoMetroProvider({ client, staticData: data, serviceSecondsAt }),
      );
      // Toei's own timetable still drives the display outside the realtime feed's hours
      // and for trains it does not report. It is SIMULATED here and labelled as such.
      this.registry.register(
        new DemoProvider({
          staticData: data,
          serviceSecondsAt,
          railwayIds: new Set(
            data?.railways.filter((r) => r.operatorId === "Toei").map((r) => r.id) ?? [],
          ),
          maxEntities: CONFIG.maxTrains,
        }),
      );
    } else {
      // DEMO: everything from the synthetic dataset.
      this.registry.register(
        new DemoProvider({ staticData: data, serviceSecondsAt, maxEntities: CONFIG.maxTrains }),
      );
    }

    // Always registered, always off, always visible in Data Status (D-007).
    this.registry.register(new JREastProvider());

    // Seed a row for every provider so disabled ones (JR East) are visible from the
    // start rather than only appearing if they happen to be polled.
    this.providerStates = this.registry.initialStates();

    this.ready = true;
    await this.poll(Date.now(), true);
    this.emit();
  }

  /**
   * Poll due providers.
   *
   * In SIMULATION the realtime providers are skipped entirely: accelerated time and a
   * live feed cannot be reconciled, so the app stops asking (D-006).
   */
  async poll(now: number, force = false): Promise<void> {
    if (this.polling) return;

    const live = this.clock.isLive;
    const due = force ? [...this.registry.all].filter((p) => p.enabled) : this.registry.due(now);
    const selected = due.filter((p) => {
      const caps = p.getCapabilities();
      const isRealtime = caps.realtimeTrip || caps.realtimePosition || caps.realtimeStatus;
      return live || !isRealtime;
    });

    // Simulated and schedule providers are cheap and time-driven, so they run every
    // tick in SIMULATION; realtime ones are rate-limited by their own cadence.
    if (selected.length === 0 && !force) return;

    this.polling = true;
    try {
      const result = await this.registry.poll(selected, now);
      const untouched = this.entities.filter(
        (e) => !selected.some((p) => p.id === e.providerId),
      );
      this.entities = [...untouched, ...result.entities];
      this.alerts = result.alerts;

      const byId = new Map(this.providerStates.map((s) => [s.id, s]));
      for (const s of result.states) byId.set(s.id, s);
      this.providerStates = [...byId.values()];
      this.lastPollAt = now;
    } finally {
      this.polling = false;
      this.emit();
    }
  }

  /** SIMULATION regenerates entities from the clock every tick, with no network. */
  async refreshSimulated(now: number): Promise<void> {
    const simProviders = [...this.registry.all].filter((p) => {
      if (!p.enabled) return false;
      const caps = p.getCapabilities();
      return !caps.realtimeTrip && !caps.realtimePosition && !caps.realtimeStatus;
    });
    if (simProviders.length === 0) return;

    const result = await this.registry.poll(simProviders, now);
    const untouched = this.entities.filter((e) => !simProviders.some((p) => p.id === e.providerId));
    this.entities = [...untouched, ...result.entities];

    const byId = new Map(this.providerStates.map((s) => [s.id, s]));
    for (const s of result.states) byId.set(s.id, s);
    this.providerStates = [...byId.values()];
  }

  setLayer<K extends keyof LayerToggles>(key: K, value: LayerToggles[K]): void {
    this.layers = { ...this.layers, [key]: value };
    this.emit();
  }

  setSpeed(speed: Speed): void {
    this.clock.setSpeed(speed);
    this.emit();
  }

  goLive(): void {
    this.clock.goLive();
    this.emit();
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
    this.emit();
  }

  seekServiceSeconds(seconds: number): void {
    this.clock.seekServiceSeconds(seconds);
    this.emit();
  }

  subscribePerf(listener: () => void): () => void {
    this.perfListeners.add(listener);
    return () => {
      this.perfListeners.delete(listener);
    };
  }

  /** The scene asks this before doing any percentile work. */
  get wantsPerformance(): boolean {
    return this.perfListeners.size > 0;
  }

  perfSnapshot(): PerfSnapshot | null {
    return this.perf;
  }

  setPerformance(next: PerfSnapshot): void {
    this.perf = next;
    for (const listener of this.perfListeners) listener();
  }

  /**
   * Building state arrives ~2x/second while tiles stream. Only re-notify React when
   * something a human would notice actually changed, or the panel would drive a
   * render at the scene's frame rate.
   */
  setBuildingDiagnostics(next: BuildingDiagnostics): void {
    const prev = this.buildingDiagnostics;
    const changed =
      !prev ||
      prev.status !== next.status ||
      prev.wardsLoaded !== next.wardsLoaded ||
      prev.wardsFailed !== next.wardsFailed ||
      prev.visible !== next.visible ||
      prev.lod !== next.lod ||
      prev.lastError !== next.lastError ||
      // Relative, not absolute: 25 m is noise at 400 km and the whole story at 600 m.
      // An absolute threshold re-rendered the tree on almost every camera event.
      Math.abs(prev.cameraAltitude - next.cameraAltitude) > Math.max(25, next.cameraAltitude * 0.08);
    this.buildingDiagnostics = next;
    if (changed) this.emit();
  }

  setSceneHealth(patch: Partial<SceneHealth>): void {
    this.sceneHealth = {
      ...this.sceneHealth,
      ...patch,
      notes: { ...this.sceneHealth.notes, ...(patch.notes ?? {}) },
    };
    this.emit();
  }

  /** Every attribution that must be displayed, from data sources and map layers alike. */
  attributions(): Attribution[] {
    const out: Attribution[] = [
      { text: "地理院タイル (国土地理院)", url: "https://maps.gsi.go.jp/development/ichiran.html" },
      {
        text: "地形データ: Project PLATEAU (国土交通省) / 国土地理院 (承認番号 R3JHs 778)",
        url: "https://www.mlit.go.jp/plateau/",
      },
    ];
    if (this.layers.buildings) {
      out.push({
        text: "3D都市モデル: Project PLATEAU (国土交通省)",
        url: "https://www.mlit.go.jp/plateau/",
      });
    }
    out.push(...this.registry.attributions());
    return out;
  }

  get lastPoll(): number {
    return this.lastPollAt;
  }
}
