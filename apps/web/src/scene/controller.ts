import * as Cesium from "cesium";
import type { MobilityEntity } from "@japan-live/shared";
import { LOD } from "@japan-live/shared";
import type { AppStore } from "../state/app-store.js";
import { CONFIG } from "../config.js";
import { createViewer, installBasemap, installTerrain } from "./viewer.js";
import { BuildingLayer, type BuildingDiagnostics } from "./buildings.js";
import { installLighting, isNightAt, setSceneTime } from "./lighting.js";
import { RailLayer } from "./rail-layer.js";
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
  private removeCameraChanged: Cesium.Event.RemoveCallback | null = null;
  private abort = new AbortController();

  private lastFrameAt = performance.now();
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastStatsAt = 0;
  private lastSimRefreshAt = 0;
  private lastBuildingUpdateAt = 0;
  private destroyed = false;
  private animationFrame = 0;

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

    this.removePreRender = this.viewer.scene.preRender.addEventListener(() => this.onFrame());

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
      const w = window as unknown as { __viewer?: Cesium.Viewer; Cesium?: typeof Cesium };
      w.__viewer = this.viewer;
      w.Cesium = Cesium;
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

  /** Drives continuous rendering while anything is actually moving. */
  private tickAnimation = (): void => {
    if (this.destroyed) return;
    const layers = this.store.snapshot().layers;
    if (layers.trains && this.trainLayer.count > 0) {
      this.viewer.scene.requestRender();
    }
    this.animationFrame = window.requestAnimationFrame(this.tickAnimation);
  };

  private onFrame(): void {
    if (this.destroyed) return;

    const nowReal = performance.now();
    const dt = nowReal - this.lastFrameAt;
    this.lastFrameAt = nowReal;
    if (dt > 0 && dt < 1000) {
      this.fpsAccum += 1000 / dt;
      this.fpsFrames += 1;
    }

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

    this.railLayer?.update(
      { xray: layers.xray, showRoutes: layers.railways, showStations: layers.stations },
      altitude,
    );

    this.trainLayer.render(simNow, altitude, {
      xray: layers.xray,
      show: layers.trains,
      selectedId: this.selectedId,
      followId: this.followId,
      night: isNightAt(simNow, 139.7),
    });

    if (this.followId) this.updateFollow(simNow);

    // Buildings are maintained on a timer, not on camera change alone: toggling the
    // layer does not move the camera, and loads settle after the last camera event.
    if (nowReal - this.lastBuildingUpdateAt > 400) {
      this.lastBuildingUpdateAt = nowReal;
      this.buildings.setEnabled(layers.buildings);
      this.buildings.update(altitude, viewCenter(this.viewer));
    }

    if (nowReal - this.lastStatsAt > 500) {
      this.lastStatsAt = nowReal;
      this.publishBuildingDiagnostics();
      const fps = this.fpsFrames > 0 ? this.fpsAccum / this.fpsFrames : 0;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.callbacks.onStats({
        fps,
        altitude,
        lod: this.trainLayer.currentLod,
        trains: this.trainLayer.count,
      });
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
    this.removeCameraChanged?.();
    this.handler.destroy();
    this.trainLayer.destroy();
    this.railLayer?.destroy();
    this.buildings.destroy();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
