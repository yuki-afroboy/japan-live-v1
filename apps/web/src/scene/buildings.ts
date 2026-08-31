import * as Cesium from "cesium";
import { LOD } from "@japan-live/shared";
import { CONFIG } from "../config.js";
import { errName, type LayerStatus } from "./viewer.js";

/**
 * PLATEAU 3D buildings for the Tokyo 23 wards.
 *
 * Two rules from the spec drive this file:
 *  §7/§48 — never load Tokyo's buildings while the camera is looking at all of Japan;
 *  §9     — never hardcode a data year, resolve `latest` through the catalog.
 *
 * Resolution is layered so a failure at any level degrades rather than breaking:
 *   catalog API  ->  bundled seed tilesets  ->  buildings off, app still runs.
 */

export interface BuildingSet {
  tilesets: Cesium.Cesium3DTileset[];
  status: LayerStatus;
  note?: string;
  /** Where the tileset URLs came from, shown in the About panel. */
  source: "catalog" | "seed" | "none";
}

/**
 * Fallback tileset URLs used when the catalog cannot be reached.
 *
 * These are year-stamped and will eventually go stale — that is precisely why the
 * catalog is tried first. A stale seed simply fails to load and the app carries on.
 */
const SEED_TILESETS: string[] = [
  "https://assets.cms.plateau.reearth.io/assets/0e/e5948a-e95c-4e31-be85-1f8c066ed996/13101_chiyoda-ku_pref_2023_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json",
];

/** Tokyo 23-ward municipality codes. V1's building footprint. */
const TOKYO_23_WARD_CODES = new Set([
  "13101", "13102", "13103", "13104", "13105", "13106", "13107", "13108",
  "13109", "13110", "13111", "13112", "13113", "13114", "13115", "13116",
  "13117", "13118", "13119", "13120", "13121", "13122", "13123",
]);

interface CatalogRow {
  name?: string;
  type?: string;
  url?: string;
  composite_url?: string;
  city_code?: string;
  ward_code?: string;
  pref_code?: string;
  lod?: number | string;
  [key: string]: unknown;
}

/**
 * Ask the PLATEAU catalog for Tokyo building tilesets.
 *
 * The exact response shape could not be verified from the build environment
 * (docs/DECISIONS.md D-001), so this probes defensively: any row that looks like a
 * building 3D Tiles entry for a Tokyo ward is accepted, and anything unexpected is
 * skipped rather than assumed.
 */
export async function resolveFromCatalog(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(CONFIG.plateauCatalogUrl, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);

  const body = (await res.json()) as unknown;
  const rows: CatalogRow[] = Array.isArray(body)
    ? (body as CatalogRow[])
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: CatalogRow[] }).data)
      : [];

  const urls: string[] = [];
  for (const row of rows) {
    const url = row.composite_url ?? row.url;
    if (typeof url !== "string" || !url.includes("tileset.json")) continue;

    const haystack = `${row.name ?? ""} ${url}`.toLowerCase();
    if (!haystack.includes("bldg")) continue;

    const code = String(row.ward_code ?? row.city_code ?? "");
    const codeInUrl = /\b(13\d{3})\b/.exec(url)?.[1] ?? "";
    if (!TOKYO_23_WARD_CODES.has(code) && !TOKYO_23_WARD_CODES.has(codeInUrl)) continue;

    if (CONFIG.plateauPinnedYear && !url.includes(CONFIG.plateauPinnedYear)) continue;

    urls.push(url);
  }
  return urls;
}

export async function loadBuildings(
  viewer: Cesium.Viewer,
  signal?: AbortSignal,
): Promise<BuildingSet> {
  if (!CONFIG.buildingsEnabled) {
    return { tilesets: [], status: "unavailable", source: "none", note: "建物レイヤーは無効化されています" };
  }

  let urls: string[] = [];
  let source: BuildingSet["source"] = "catalog";

  try {
    urls = await resolveFromCatalog(signal);
    if (urls.length === 0) throw new Error("catalog returned no Tokyo building tilesets");
  } catch {
    urls = SEED_TILESETS;
    source = "seed";
  }

  const tilesets: Cesium.Cesium3DTileset[] = [];
  for (const url of urls) {
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
        // Explicit budgets rather than defaults (spec §46, .claude/rules/frontend.md).
        maximumScreenSpaceError: 20,
        cacheBytes: 256 * 1024 * 1024,
        maximumCacheOverflowBytes: 128 * 1024 * 1024,
        skipLevelOfDetail: true,
        preferLeaves: true,
        dynamicScreenSpaceError: true,
        // Never fetch Tokyo geometry the camera cannot see.
        cullWithChildrenBounds: true,
      });

      tileset.style = new Cesium.Cesium3DTileStyle({
        color: "color('#243247')",
      });
      tileset.show = false; // altitude gate turns it on
      viewer.scene.primitives.add(tileset);
      tilesets.push(tileset);
    } catch {
      // One bad tileset must not take the rest down.
    }
  }

  if (tilesets.length === 0) {
    return {
      tilesets: [],
      status: "unavailable",
      source: "none",
      note: "3D建物を読み込めませんでした。建物なしで表示しています。",
    };
  }

  return {
    tilesets,
    status: "ok",
    source,
    note:
      source === "seed"
        ? "PLATEAUカタログに接続できないため、既定のタイルセットを使用しています。"
        : undefined,
  };
}

/**
 * Gate the building tilesets on camera altitude.
 *
 * Called on camera change, not per frame. Above the threshold the tilesets are hidden
 * AND their screen-space error is relaxed, so Cesium stops requesting tiles rather than
 * merely not drawing them.
 */
export function updateBuildingLod(set: BuildingSet, altitude: number): boolean {
  const visible = altitude <= LOD.buildingsMaxAltitude;
  let changed = false;

  for (const tileset of set.tilesets) {
    if (tileset.show !== visible) {
      tileset.show = visible;
      changed = true;
    }
    // Finer detail only when genuinely close in; coarse detail keeps mid-range moves cheap.
    const target = altitude <= LOD.buildingsDetailAltitude ? 12 : 32;
    if (tileset.maximumScreenSpaceError !== target) {
      tileset.maximumScreenSpaceError = target;
      changed = true;
    }
  }
  return changed;
}

export function destroyBuildings(viewer: Cesium.Viewer, set: BuildingSet): void {
  for (const tileset of set.tilesets) {
    viewer.scene.primitives.remove(tileset);
    if (!tileset.isDestroyed()) tileset.destroy();
  }
  set.tilesets.length = 0;
}

export { errName };
