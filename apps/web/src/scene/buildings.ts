import * as Cesium from "cesium";
import { LOD } from "@japan-live/shared";
import { CONFIG } from "../config.js";
import type { LayerStatus } from "./viewer.js";

/**
 * PLATEAU 3D buildings for the Tokyo 23 wards.
 *
 * V1 resolved the data catalog in the browser on every load and guessed at its
 * response shape. The guess was wrong, so the catalog yielded nothing, the code fell
 * back to a single hardcoded Chiyoda tileset, and Shinjuku — where the user actually
 * looked — had no buildings at all. See docs/DECISIONS.md D-012.
 *
 * V1.1 reads a manifest built from MLIT's official GraphQL catalog (or, until that has
 * been run with network access, from MLIT's documented composite-URL scheme). Every
 * ward carries an ordered list of candidate URLs and the loader reports exactly what
 * it tried and what happened.
 */

export interface WardEntry {
  code: string;
  name: string;
  nameEn: string;
  center: [number, number];
  radiusKm: number;
  year: number | null;
  lod1: string[];
  lod2: string[];
}

export interface BuildingManifest {
  meta: {
    builtAt: number;
    source: "catalog" | "pattern";
    apiHost: string;
    graphql: string;
    warning?: string;
    attribution: string;
    license: string;
    note?: string;
  };
  wards: WardEntry[];
}

export type BuildingStatus = "IDLE" | "LOADING" | "OK" | "PARTIAL" | "ERROR" | "DISABLED";

export interface LoadAttempt {
  ward: string;
  wardCode: string;
  url: string;
  ok: boolean;
  /** HTTP status when Cesium reported one. */
  httpStatus?: number;
  error?: string;
  ms: number;
}

/** Everything the diagnostics panel shows. Deliberately complete: this exists so a
 *  user can tell WHY there are no buildings, which V1 could not. */
export interface BuildingDiagnostics {
  status: BuildingStatus;
  /** Where the URLs came from. */
  source: "manifest-catalog" | "manifest-pattern" | "none";
  manifestError?: string;
  manifestWarning?: string;
  manifestBuiltAt?: number;
  dataYears: string;
  wardsTotal: number;
  wardsLoaded: number;
  wardsFailed: number;
  wardsInRange: number;
  tilesetsLoaded: number;
  visible: boolean;
  cameraAltitude: number;
  lod: "LOD2" | "LOD1" | "off";
  lastError?: string;
  attempts: LoadAttempt[];
  loadedWardNames: string[];
}

interface LoadedWard {
  code: string;
  name: string;
  tileset: Cesium.Cesium3DTileset;
  url: string;
  lod: 1 | 2;
}

const EARTH_R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

function distanceKm(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)))) / 1000;
}

/** Phones cannot hold 23 wards of LOD2 geometry. Desktop gets more headroom. */
function wardBudget(): number {
  const mobile = typeof window !== "undefined" && window.innerWidth < 780;
  return mobile ? 4 : 10;
}

export class BuildingLayer {
  private readonly viewer: Cesium.Viewer;
  private manifest: BuildingManifest | null = null;
  private readonly loaded = new Map<string, LoadedWard>();
  private readonly failed = new Set<string>();
  private readonly inFlight = new Set<string>();
  private attempts: LoadAttempt[] = [];
  private manifestError?: string;
  private lastError?: string;
  private enabled = true;
  private destroyed = false;
  /** Where the camera was at the last update, so a moving camera can be detected. */
  private lastCenter?: [number, number];
  private lastAltitude = 0;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  async loadManifest(signal?: AbortSignal): Promise<void> {
    if (!CONFIG.buildingsEnabled) {
      this.enabled = false;
      return;
    }
    try {
      const res = await fetch(CONFIG.plateauManifestUrl, {
        signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const body = (await res.json()) as BuildingManifest;
      if (!Array.isArray(body.wards) || body.wards.length === 0) {
        throw new Error("manifest contains no wards");
      }
      this.manifest = body;
    } catch (err) {
      this.manifestError = err instanceof Error ? err.message : "manifest unavailable";
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const w of this.loaded.values()) w.tileset.show = enabled;
    this.viewer.scene.requestRender();
  }

  /**
   * Load the wards the camera can actually see, and drop ones it has left behind.
   *
   * Called on a timer rather than only on camera change: visibility, eviction and
   * the toggle all need to take effect without the camera moving, and loads that
   * finish after the last camera event still need tidying up.
   */
  update(altitude: number, center: Cesium.Cartographic | undefined): void {
    if (!this.manifest || this.destroyed) return;
    if (!this.enabled) return;

    const visible = altitude <= LOD.buildingsMaxAltitude;
    for (const w of this.loaded.values()) {
      if (w.tileset.show !== visible) w.tileset.show = visible;
      // Above the threshold, relax the error so Cesium stops requesting tiles rather
      // than merely not drawing them.
      const sse = !visible ? 64 : altitude <= LOD.buildingsDetailAltitude ? 12 : 32;
      if (w.tileset.maximumScreenSpaceError !== sse) w.tileset.maximumScreenSpaceError = sse;
    }
    if (!visible || !center) return;

    const camera: [number, number] = [
      Cesium.Math.toDegrees(center.longitude),
      Cesium.Math.toDegrees(center.latitude),
    ];
    const wantedLod: 1 | 2 = altitude <= LOD.buildingsDetailAltitude ? 2 : 1;

    // Is the camera still flying? Starting loads mid-flight pulls in every ward the
    // camera passes over and then strands them, which is how a 10-ward budget ended
    // up holding 16 tilesets.
    const movedKm = this.lastCenter ? distanceKm(this.lastCenter, camera) : Infinity;
    const settled =
      this.lastCenter !== undefined &&
      movedKm < 0.6 &&
      Math.abs(altitude - this.lastAltitude) < altitude * 0.15;
    this.lastCenter = camera;
    this.lastAltitude = altitude;

    // Wards whose area plausibly intersects what the camera is looking at. The reach
    // grows with altitude because a higher camera sees more ground.
    const reachKm = Math.min(12, Math.max(3, altitude / 300));
    const inRange = this.manifest.wards
      .map((w) => ({ ward: w, d: Math.max(0, distanceKm(camera, w.center) - w.radiusKm) }))
      .filter((x) => x.d <= reachKm)
      .sort((a, b) => a.d - b.d);

    const budget = wardBudget();

    for (const { ward } of settled ? inRange.slice(0, budget) : []) {
      const existing = this.loaded.get(ward.code);
      if (existing && existing.lod === wantedLod) continue;
      if (existing && wantedLod === 1) continue; // keep finer detail already loaded
      if (this.inFlight.has(ward.code)) continue;
      if (this.failed.has(`${ward.code}:${wantedLod}`)) continue;
      void this.loadWard(ward, wantedLod);
    }

    // Evict the wards furthest from the camera once over budget, so a long flight
    // across Tokyo does not accumulate every tileset it passed. Runs on every update,
    // not only on camera movement, because loads finish asynchronously.
    if (this.loaded.size > budget) {
      const rank = new Map(inRange.map((x, i) => [x.ward.code, i]));
      const byDistance = [...this.loaded.entries()].sort(
        (a, b) => (rank.get(b[0]) ?? 1e6) - (rank.get(a[0]) ?? 1e6),
      );
      for (const [code, w] of byDistance) {
        if (this.loaded.size <= budget) break;
        this.viewer.scene.primitives.remove(w.tileset);
        if (!w.tileset.isDestroyed()) w.tileset.destroy();
        this.loaded.delete(code);
      }
    }
  }

  /** Try each candidate URL for a ward in order, recording every attempt. */
  private async loadWard(ward: WardEntry, lod: 1 | 2): Promise<void> {
    const urls = lod === 2 && ward.lod2.length > 0 ? [...ward.lod2, ...ward.lod1] : ward.lod1;
    if (urls.length === 0) return;

    this.inFlight.add(ward.code);
    try {
      for (const url of urls) {
        const started = performance.now();
        try {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
            maximumScreenSpaceError: 20,
            cacheBytes: 128 * 1024 * 1024,
            maximumCacheOverflowBytes: 64 * 1024 * 1024,
            skipLevelOfDetail: true,
            preferLeaves: true,
            dynamicScreenSpaceError: true,
            cullWithChildrenBounds: true,
          });
          if (this.destroyed) {
            tileset.destroy();
            return;
          }

          // A flat colour, deliberately.
          //
          // Shading by ${feature['bldg:measuredHeight']} looks better but is a
          // production hazard: Cesium's style evaluator THROWS on `undefined >= 150`,
          // and a throw inside evaluateColor kills the entire render loop and blanks
          // the map — not just the buildings. Tiles without that attribute exist, and
          // the obvious `defined()` guard is rejected by this styling language. A
          // cosmetic gradient is not worth risking the whole scene on an attribute we
          // cannot guarantee. Height still reads clearly from silhouette and lighting.
          tileset.style = new Cesium.Cesium3DTileStyle({ color: "color('#41537a')" });
          tileset.show = this.enabled;
          this.viewer.scene.primitives.add(tileset);

          const previous = this.loaded.get(ward.code);
          if (previous) this.viewer.scene.primitives.remove(previous.tileset);
          this.loaded.set(ward.code, { code: ward.code, name: ward.name, tileset, url, lod });

          this.attempts.push({
            ward: ward.name,
            wardCode: ward.code,
            url,
            ok: true,
            ms: Math.round(performance.now() - started),
          });
          this.viewer.scene.requestRender();
          return;
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          const message = err instanceof Error ? err.message : String(err);
          this.attempts.push({
            ward: ward.name,
            wardCode: ward.code,
            url,
            ok: false,
            httpStatus: typeof status === "number" ? status : undefined,
            error: message.slice(0, 160),
            ms: Math.round(performance.now() - started),
          });
          this.lastError = `${ward.name}: ${message.slice(0, 120)}`;
        }
      }
      // Every candidate failed for this LOD; do not hammer it again.
      this.failed.add(`${ward.code}:${lod}`);
    } finally {
      this.inFlight.delete(ward.code);
      // Keep the attempt log bounded; the newest entries are the useful ones.
      if (this.attempts.length > 60) this.attempts = this.attempts.slice(-60);
    }
  }

  diagnostics(altitude: number): BuildingDiagnostics {
    const wardsTotal = this.manifest?.wards.length ?? 0;
    const failedWards = new Set([...this.failed].map((k) => k.split(":")[0]!));

    let status: BuildingStatus;
    if (!this.enabled) status = "DISABLED";
    else if (this.manifestError || !this.manifest) status = "ERROR";
    else if (this.inFlight.size > 0) status = "LOADING";
    else if (this.loaded.size > 0) status = failedWards.size > 0 ? "PARTIAL" : "OK";
    else if (failedWards.size > 0) status = "ERROR";
    else status = "IDLE";

    const years = [...new Set((this.manifest?.wards ?? []).map((w) => w.year).filter(Boolean))];
    const anyLod2 = [...this.loaded.values()].some((w) => w.lod === 2);

    return {
      status,
      source: this.manifest
        ? this.manifest.meta.source === "catalog"
          ? "manifest-catalog"
          : "manifest-pattern"
        : "none",
      manifestError: this.manifestError,
      manifestWarning: this.manifest?.meta.warning,
      manifestBuiltAt: this.manifest?.meta.builtAt,
      dataYears: years.length > 0 ? years.sort().join(", ") : "latest (サーバ側で解決)",
      wardsTotal,
      wardsLoaded: this.loaded.size,
      wardsFailed: failedWards.size,
      wardsInRange: 0,
      tilesetsLoaded: this.loaded.size,
      visible: this.enabled && altitude <= LOD.buildingsMaxAltitude && this.loaded.size > 0,
      cameraAltitude: altitude,
      lod: altitude > LOD.buildingsMaxAltitude ? "off" : anyLod2 ? "LOD2" : "LOD1",
      lastError: this.lastError,
      attempts: this.attempts.slice(-12).reverse(),
      loadedWardNames: [...this.loaded.values()].map((w) => w.name),
    };
  }

  get attribution(): string | undefined {
    return this.manifest?.meta.attribution;
  }

  get status(): LayerStatus {
    if (!this.enabled) return "unavailable";
    if (this.manifestError) return "unavailable";
    return this.loaded.size > 0 ? "ok" : "loading";
  }

  destroy(): void {
    this.destroyed = true;
    for (const w of this.loaded.values()) {
      this.viewer.scene.primitives.remove(w.tileset);
      if (!w.tileset.isDestroyed()) w.tileset.destroy();
    }
    this.loaded.clear();
  }
}
