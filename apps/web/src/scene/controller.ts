import * as Cesium from "cesium";
import type { MobilityEntity } from "@japan-live/shared";
import { LOD } from "@japan-live/shared";
import type { AppStore } from "../state/app-store.js";
import { CONFIG } from "../config.js";
import { createViewer, installBasemap, installTerrain } from "./viewer.js";
import { BuildingLayer, type BuildingDiagnostics, type TileStats } from "./buildings.js";
import { installLighting, isNightAt, setSceneTime } from "./lighting.js";
import { FrameMetrics } from "./perf.js";
import { currentProfile, type QualityProfile } from "./quality.js";
import { RailLayer } from "./rail-layer.js";
import { StabilityMonitor } from "./stability.js";
import { TrainLayer } from "./train-layer.js";
import {
  applyFollow,
  cameraAltitude,
  flyToPreset,
  playIntro,
  playTour,
  releaseFollow,
  viewCenter,
  type CameraPreset,
  type FollowView,
} from "./camera.js";

/**
 * Owns Cesium and the frame loop.
 *
 * React never touches anything in here except through these methods, and nothing in
 * here calls React except through the sparse callbacks below. That separation is what
 * keeps a 60 Hz scene from driving a 60 Hz React tree.
 */
export interface SceneCallbacks {
  onSelect: (entity: MobilityEntity | undefined) => void;
  onStationSelect: (stationId: string) => void;
  onIntroDone: () => void;
  onTourStep: (index: number) => void;
  onTourDone: () => void;
  /** Throttled to ~2 Hz for the HUD, not per frame. */
  onStats: (stats: { fps: number; altitude: number; lod: string; trains: number }) => void;
}

export class SceneController {
  readonly viewer: Cesium.Viewer;
  private readonly store: AppStore;
  private readonly callbacks: SceneCallbacks;

  private railLayer: RailLayer | null = null;
  private trainLayer: TrainLayer;
  private buildings: BuildingLayer;

  private selectedId: string | undefined;
  private followId: string | undefined;
  private followView: FollowView = "behind";

  private intro: { cancel: () => void } | null = null;
  private tour: { cancel: () => void } | null = null;

  private handler: Cesium.ScreenSpaceEventHandler;
  private removePreRender: Cesium.Event.RemoveCallback | null = null;
  private removePreUpdate: Cesium.Event.RemoveCallback | null = null;
  private removePostUpdate: Cesium.Event.RemoveCallback | null = null;
  private removePostRender: Cesium.Event.RemoveCallback | null = null;
  private removeCameraChanged: Cesium.Event.RemoveCallback | null = null;
  private removeMoveStart: Cesium.Event.RemoveCallback | null = null;
  private removeMoveEnd: Cesium.Event.RemoveCallback | null = null;
  private abort = new AbortController();

  private lastFrameAt = performance.now();
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastStatsAt = 0;
  private lastSimRefreshAt = 0;
  private lastBuildingUpdateAt = 0;
  private destroyed = false;
  private animationFrame = 0;

  private readonly metrics = new FrameMetrics();
  private readonly profile: QualityProfile = currentProfile();
  /** When train motion alone is next allowed to drive a render. */
  private nextAnimationAt = 0;
  /** True between camera moveStart and moveEnd — a drag, a pinch or a flight. */
  private cameraMoving = false;
  private lastCameraMoveAt = 0;

  /** Frame-span bookkeeping. Set in preUpdate, read in postRender, same frame. */
  private updateStartedAt = 0;
  private updateSpanMs = 0;
  private ourSpanMs = 0;
  private ourEndedAt = 0;
  private readonly stability: StabilityMonitor;
  private tileStats: TileStats = {
    pendingRequests: 0,
    tilesProcessing: 0,
    settled: 0,
    tilesets: 0,
    memoryMb: 0,
    loaded: 0,
    unloaded: 0,
    failed: 0,
  };

  constructor(container: HTMLElement, store: AppStore, callbacks: SceneCallbacks) {
    this.store = store;
    this.callbacks = callbacks;

    this.viewer = createViewer(container);
    installLighting(this.viewer);
    this.trainLayer = new TrainLayer(this.viewer);
    this.buildings = new BuildingLayer(this.viewer);

    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);
    this.handler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onClick(movement),
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    // Any manual camera input cancels an automated flight — a tour you cannot
    // interrupt is a trap.
    for (const type of [
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.ScreenSpaceEventType.RIGHT_DOWN,
      Cesium.ScreenSpaceEventType.WHEEL,
      Cesium.ScreenSpaceEventType.PINCH_START,
    ]) {
      this.handler.setInputAction(() => this.onUserInteract(), type);
    }

    this.removeCameraChanged = this.viewer.camera.changed.addEventListener(() =>
      this.onCameraChanged(),
    );
    this.viewer.camera.percentageChanged = 0.15;

    // moveStart/moveEnd bracket every camera motion — drag, pinch, wheel, flyTo and
    // Follow alike. They are what lets the animation throttle below stand down while
    // someone is actually steering, without trying to enumerate input events.
    this.removeMoveStart = this.viewer.camera.moveStart.addEventListener(() => {
      this.cameraMoving = true;
    });
    this.removeMoveEnd = this.viewer.camera.moveEnd.addEventListener(() => {
      this.cameraMoving = false;
      this.lastCameraMoveAt = performance.now();
    });

    // The four scene events bracket one call to Scene.render, in this order:
    // preUpdate -> [pass updates] -> postUpdate -> preRender -> [draw] -> postRender.
    // Timing them separately is the only way to tell an update-pass stall (3D Tiles
    // content parsing and GPU upload, which Cesium runs with no time budget) from a
    // draw stall. Our own per-layer CPU split cannot see either of them.
    this.removePreUpdate = this.viewer.scene.preUpdate.addEventListener(() => {
      this.updateStartedAt = performance.now();
    });
    this.removePostUpdate = this.viewer.scene.postUpdate.addEventListener(() => {
      this.updateSpanMs = performance.now() - this.updateStartedAt;
    });
    this.removePreRender = this.viewer.scene.preRender.addEventListener(() => this.onFrame());
    this.removePostRender = this.viewer.scene.postRender.addEventListener(() => {
      const now = performance.now();
      this.metrics.spans(
        now,
        this.updateSpanMs,
        this.ourSpanMs,
        now - this.ourEndedAt,
        this.tileStats.tilesProcessing,
        this.tileStats.pendingRequests,
      );
    });

    this.stability = new StabilityMonitor(this.viewer.canvas, (lost) => {
      this.store.setSceneHealth({
        notes: lost
          ? { buildings: "WebGL コンテキストが失われました。復帰を待っています。" }
          : {},
      });
    });

    // requestRenderMode keeps an idle map from burning a GPU, but MOTION is the whole
    // product: while trains are on screen the scene must be driven every frame.
    // Requesting a render from inside preRender does not reliably schedule the next
    // one, so an explicit ticker owns it — and stops the moment nothing is moving.
    this.tickAnimation();

    // A render error leaves a blank canvas that looks exactly like a working app with
    // nothing in view, so it must never pass silently.
    this.viewer.scene.renderError.addEventListener((_scene, error) => {
      // Print the message and stack, not the object: a minified build renders the
      // object as a two-letter class name and tells you nothing.
      const err = error as { message?: string; stack?: string; name?: string };
      console.error(
        `[JAPAN LIVE] scene render error: ${err?.name ?? "Error"}: ${err?.message ?? String(error)}\n${err?.stack ?? ""}`,
      );
      this.store.setSceneHealth({
        notes: { buildings: `描画エラー: ${err?.message ?? "unknown"}` },
      });
    });

    if (new URLSearchParams(location.search).has("debug")) {
      const w = window as unknown as {
        __viewer?: Cesium.Viewer;
        Cesium?: typeof Cesium;
        __perf?: () => unknown;
        __profile?: QualityProfile;
      };
      w.__viewer = this.viewer;
      w.Cesium = Cesium;
      // Read by the performance E2E so a measurement never depends on scraping the UI.
      w.__perf = () => ({
        ...this.metrics.snapshot(performance.now()),
        trains: this.trainLayer.count,
        trainLod: this.trainLayer.currentLod,
        wardsLoaded: this.buildings.diagnostics(cameraAltitude(this.viewer)).wardsLoaded,
        tilesetsLoaded: this.buildings.diagnostics(cameraAltitude(this.viewer)).tilesetsLoaded,
        altitude: cameraAltitude(this.viewer),
        resolutionScale: this.viewer.resolutionScale,
        devicePixelRatio: window.devicePixelRatio ?? 1,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        tier: this.profile.tier,
        tiles: this.buildings.tileStats(),
        tuning: this.profile.tiles,
        stability: this.stability.snapshot(),
      });
      w.__profile = this.profile;
    }
  }

  /** Async layers. Each one reports its own health and none of them can block startup. */
  async load(): Promise<void> {
    const terrain = await installTerrain(this.viewer);
    this.store.setSceneHealth({
      terrain: terrain.status,
      notes: terrain.note ? { terrain: terrain.note } : {},
    });

    const basemap = installBasemap(this.viewer);
    this.store.setSceneHealth({
      basemap: basemap.status,
      notes: basemap.note ? { basemap: basemap.note } : {},
    });

    if (this.store.network) {
      this.railLayer = new RailLayer(this.viewer, this.store.network);
    }

    if (!CONFIG.skipIntro) {
      this.intro = playIntro(this.viewer, () => {
        this.intro = null;
        this.callbacks.onIntroDone();
      });
    } else {
      this.callbacks.onIntroDone();
    }

    // Buildings load last: they are the heaviest layer and the least essential.
    await this.buildings.loadManifest(this.abort.signal);
    if (this.destroyed) return;
    this.buildings.update(cameraAltitude(this.viewer), viewCenter(this.viewer));
    this.publishBuildingDiagnostics();
  }

  /**
   * Drives continuous rendering while anything is actually moving.
   *
   * Measured: with the Trains layer off, this app renders ONE frame in twelve seconds.
   * Every continuously-rendered frame in the product comes from this ticker, which
   * makes its cadence the single largest lever on sustained GPU load — larger than any
   * layer, because turning a layer off only makes each frame cheaper while this
   * decides how many frames there are.
   *
   * On a phone that cadence is capped (30 Hz by default). A city visualisation does not
   * need 60 fps of train motion, and halving the frame count halves everything
   * downstream: fragment work, tile traversal, compositing, battery.
   *
   * The cap NEVER applies while the camera is moving. A throttled drag or pinch feels
   * broken, and Follow is a continuous camera motion by definition.
   */
  private tickAnimation = (): void => {
    if (this.destroyed) return;
    const now = performance.now();
    this.metrics.raf(now);
    const layers = this.store.snapshot().layers;
    if (layers.trains && this.trainLayer.count > 0 && now >= this.nextAnimationAt) {
      this.nextAnimationAt = now + this.animationIntervalMs(now);
      this.metrics.renderRequest(now);
      this.viewer.scene.requestRender();
    }
    this.animationFrame = window.requestAnimationFrame(this.tickAnimation);
  };

  /** 0 means "every animation frame" — the uncapped path, used whenever input is live. */
  private animationIntervalMs(now: number): number {
    const steering =
      this.cameraMoving ||
      now - this.lastCameraMoveAt < 400 ||
      this.followId !== undefined ||
      this.intro !== null ||
      this.tour !== null;
    if (steering) return 0;
    return 1000 / this.profile.animationHz;
  }

  private onFrame(): void {
    if (this.destroyed) return;

    const nowReal = performance.now();
    const dt = nowReal - this.lastFrameAt;
    this.lastFrameAt = nowReal;
    if (dt > 0 && dt < 1000) {
      this.fpsAccum += 1000 / dt;
      this.fpsFrames += 1;
    }
    this.metrics.frame(nowReal);

    this.store.clock.tick();
    const simNow = this.store.clock.currentTime;
    setSceneTime(this.viewer, simNow);

    const layers = this.store.snapshot().layers;
    const altitude = cameraAltitude(this.viewer);

    // In SIMULATION the timetable engine regenerates positions from the clock. At ×600
    // that must still not run per frame, so it is capped at ~10 Hz.
    if (!this.store.clock.isLive && nowReal - this.lastSimRefreshAt > 100) {
      this.lastSimRefreshAt = nowReal;
      void this.store.refreshSimulated(simNow).then(() => {
        this.trainLayer.ingest(this.store.entities, simNow, 250);
      });
    }

    // Each span is timed separately so a slow frame can be attributed rather than
    // guessed at. Four performance.now() calls per frame; the alternative is arguing
    // about which layer is expensive.
    const tRailStart = performance.now();
    this.railLayer?.update(
      { xray: layers.xray, showRoutes: layers.railways, showStations: layers.stations },
      altitude,
    );

    const tTrainStart = performance.now();
    this.trainLayer.render(simNow, altitude, {
      xray: layers.xray,
      show: layers.trains,
      selectedId: this.selectedId,
      followId: this.followId,
      night: isNightAt(simNow, 139.7),
    });

    const tFollowStart = performance.now();
    if (this.followId) this.updateFollow(simNow);

    // Buildings are maintained on a timer, not on camera change alone: toggling the
    // layer does not move the camera, and loads settle after the last camera event.
    const tBuildingsStart = performance.now();
    if (nowReal - this.lastBuildingUpdateAt > 400) {
      this.lastBuildingUpdateAt = nowReal;
      this.buildings.setEnabled(layers.buildings);
      this.buildings.update(altitude, viewCenter(this.viewer));
    }
    const tEnd = performance.now();
    this.ourSpanMs = tEnd - nowReal;
    this.ourEndedAt = tEnd;
    this.metrics.cpuFrame(
      tFollowStart - tTrainStart,
      tTrainStart - tRailStart,
      tEnd - tBuildingsStart,
      tBuildingsStart - tFollowStart,
    );

    if (nowReal - this.lastStatsAt > 500) {
      this.lastStatsAt = nowReal;
      this.publishBuildingDiagnostics();
      // Cheap enough at 2 Hz, and it is what the long-frame numbers get correlated
      // against — a 150 ms frame with 40 tiles in the processing queue is a different
      // bug from a 150 ms frame with an empty one.
      this.tileStats = this.buildings.tileStats();
      const fps = this.fpsFrames > 0 ? this.fpsAccum / this.fpsFrames : 0;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.callbacks.onStats({
        fps,
        altitude,
        lod: this.trainLayer.currentLod,
        trains: this.trainLayer.count,
      });
      this.stability.setState({
        wards: this.tileStats.tilesets,
        tilesets: this.tileStats.tilesets,
        tileMemoryMb: this.tileStats.memoryMb,
        pendingRequests: this.tileStats.pendingRequests,
        tilesProcessing: this.tileStats.tilesProcessing,
        altitude,
        trains: this.trainLayer.count,
        fps,
      });

      // Percentiles cost a sort. Only pay for it while the panel is on screen.
      if (this.store.wantsPerformance) {
        const snapshot = this.metrics.snapshot(nowReal);
        // Diagnostics first: setPerformance is what notifies subscribers, so the panel
        // must already be able to read a matching diagnostics record when it does.
        this.store.setDiagnostics({ tiles: this.tileStats, stability: this.stability.snapshot() });
        this.store.setPerformance(snapshot);
        // A stall long enough to be felt is worth surviving a reload, so it goes in the
        // persistent log with its attribution attached. Judged on the whole frame, not
        // on the spans: a frame that spends 160 ms in the compositor is the one the
        // user felt, and its visible spans are close to zero.
        const worst = snapshot.worst;
        const frameMs = worst ? (worst.frameMs > 0 ? worst.frameMs : worst.totalMs) : 0;
        if (worst && frameMs > 120) {
          this.stability.recordStall(
            frameMs,
            `upd ${Math.round(worst.updateMs)} app ${Math.round(worst.ourMs)} ` +
              `draw ${Math.round(worst.renderMs)} other ${Math.round(worst.otherMs)} ` +
              `proc ${worst.tilesProcessing}`,
          );
        }
      }
    }
  }

  /** Camera-driven building loading and LOD. Runs on camera change, not per frame. */
  private onCameraChanged(): void {
    if (this.destroyed) return;
    const altitude = cameraAltitude(this.viewer);
    const layers = this.store.snapshot().layers;

    this.buildings.setEnabled(layers.buildings);
    this.buildings.update(altitude, viewCenter(this.viewer));
    this.publishBuildingDiagnostics();
  }

  /** Push building state to the store so the diagnostics panel can show it. */
  private publishBuildingDiagnostics(): void {
    const diagnostics = this.buildings.diagnostics(cameraAltitude(this.viewer));
    this.store.setBuildingDiagnostics(diagnostics);
    this.store.setSceneHealth({
      buildings: this.buildings.status,
      notes:
        diagnostics.status === "ERROR"
          ? { buildings: diagnostics.manifestError ?? diagnostics.lastError ?? "3D建物を読み込めませんでした" }
          : {},
    });
  }

  /** Fresh entities from the providers. */
  ingest(entities: MobilityEntity[], pollIntervalMs: number): void {
    this.trainLayer.ingest(entities, this.store.clock.currentTime, pollIntervalMs);
    this.viewer.scene.requestRender();
  }

  private onClick(movement: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {
    const train = this.trainLayer.pick(movement.position);
    if (train) {
      this.select(train.id);
      this.callbacks.onSelect(train);
      return;
    }

    const picked = this.viewer.scene.pick(movement.position);
    const id = picked?.id as { kind?: string; stationId?: string } | undefined;
    if (id?.kind === "station" && id.stationId) {
      this.callbacks.onStationSelect(id.stationId);
      return;
    }

    this.select(undefined);
    this.callbacks.onSelect(undefined);
  }

  private onUserInteract(): void {
    if (this.intro) {
      this.intro.cancel();
      this.intro = null;
      this.callbacks.onIntroDone();
    }
    if (this.tour) {
      this.tour.cancel();
      this.tour = null;
      this.callbacks.onTourDone();
    }
  }

  select(id: string | undefined): void {
    this.selectedId = id;
    this.viewer.scene.requestRender();
  }

  startFollow(id: string, view: FollowView = "behind"): void {
    this.followId = id;
    this.followView = view;
    this.selectedId = id;
    this.stopTour();
    this.viewer.camera.cancelFlight();
  }

  setFollowView(view: FollowView): void {
    this.followView = view;
  }

  stopFollow(): void {
    if (!this.followId) return;
    this.followId = undefined;
    releaseFollow(this.viewer);
    this.viewer.scene.requestRender();
  }

  get following(): string | undefined {
    return this.followId;
  }

  private updateFollow(now: number): void {
    if (!this.followId) return;
    const pos = this.trainLayer.positionOf(this.followId, now);
    if (!pos) {
      // The followed train left the feed or finished its trip. Release rather than
      // leaving the camera pinned to a vehicle that no longer exists.
      this.stopFollow();
      this.callbacks.onSelect(undefined);
      return;
    }
    applyFollow(
      this.viewer,
      pos.position[0],
      pos.position[1],
      Math.max(pos.height, LOD.xrayProjectionAltitude * 0.2),
      pos.heading,
      this.followView,
    );
  }

  flyTo(preset: CameraPreset): void {
    this.onUserInteract();
    this.stopFollow();
    flyToPreset(this.viewer, preset);
  }

  flyToLonLat(longitude: number, latitude: number, height: number): void {
    this.onUserInteract();
    this.stopFollow();
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-42), roll: 0 },
      duration: 2.2,
    });
  }

  startTour(): void {
    this.stopFollow();
    this.tour = playTour(
      this.viewer,
      (i) => this.callbacks.onTourStep(i),
      () => {
        this.tour = null;
        this.callbacks.onTourDone();
      },
    );
  }

  stopTour(): void {
    if (!this.tour) return;
    this.tour.cancel();
    this.tour = null;
    this.callbacks.onTourDone();
  }

  get tourRunning(): boolean {
    return this.tour !== null;
  }

  skipIntro(): void {
    this.onUserInteract();
  }

  /** Full teardown. Every listener, layer and Cesium resource created here is released. */
  destroy(): void {
    this.destroyed = true;
    this.abort.abort();
    this.intro?.cancel();
    this.tour?.cancel();
    window.cancelAnimationFrame(this.animationFrame);
    this.removePreRender?.();
    this.removePreUpdate?.();
    this.removePostUpdate?.();
    this.removePostRender?.();
    this.stability.destroy();
    this.removeCameraChanged?.();
    this.removeMoveStart?.();
    this.removeMoveEnd?.();
    this.handler.destroy();
    this.trainLayer.destroy();
    this.railLayer?.destroy();
    this.buildings.destroy();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
