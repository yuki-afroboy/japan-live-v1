/**
 * Runtime configuration.
 *
 * Everything here is optional. With none of it set the app runs in DEMO MODE, which is
 * exactly what the public GitHub Pages build does (spec §43).
 *
 * NOTE: nothing secret may ever appear in this file or in any VITE_ variable — Vite
 * inlines them into the public bundle. The ODPT key lives in the gateway (spec §37).
 */

const env = import.meta.env as Record<string, string | undefined>;

function str(key: string, fallback = ""): string {
  const v = env[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function num(key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined) return fallback;
  return v === "1" || v === "true";
}

/**
 * Allow `?gateway=` to point the app at a different gateway — but ONLY when running on
 * localhost. A link that could redirect a deployed site to an arbitrary data source
 * would let anyone put fabricated trains on someone else's screen, which is the exact
 * failure this project exists to prevent. On any other origin the parameter is ignored.
 */
function gatewayOverride(): string {
  if (typeof location === "undefined") return "";
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!isLocal) return "";
  return new URLSearchParams(location.search).get("gateway") ?? "";
}

export const CONFIG = {
  /** Gateway base URL. Empty means DEMO MODE — no realtime provider is constructed. */
  gatewayUrl: gatewayOverride() || str("VITE_GATEWAY_URL"),

  /**
   * PLATEAU terrain, published by MLIT through Cesium ion (see docs/DECISIONS.md D-002).
   * The token below is the one MLIT publishes in its own terrain tutorial; override it
   * with your own ion token if you prefer.
   */
  cesiumIonToken: str(
    "VITE_CESIUM_ION_TOKEN",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiODVhMmQ5OS1hOWZjLTQ3YmYtODlmNi1lNWUwY2MwOGUxYTMiLCJpZCI6MTQ5ODk3LCJpYXQiOjE2ODc5MzQ3NDN9.OG0mc3i7ZxGwHQjlMv3TRjiOvKWpzxglxmJRaUIykTY",
  ),
  plateauTerrainAssetId: num("VITE_PLATEAU_TERRAIN_ASSET_ID", 3258112),
  /** Escape hatch for a self-hosted quantized-mesh endpoint, bypassing ion entirely. */
  terrainUrl: str("VITE_TERRAIN_URL"),

  /** 地理院タイル. Pale is the calmest base for a dark UI. */
  gsiTileUrl: str("VITE_GSI_TILE_URL", "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"),
  gsiMaxZoom: num("VITE_GSI_MAX_ZOOM", 18),

  /** PLATEAU 3D Tiles catalog. Resolved at runtime so no data year is hardcoded (spec §9). */
  plateauCatalogUrl: str(
    "VITE_PLATEAU_CATALOG_URL",
    "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets",
  ),
  /** Pin a specific PLATEAU data year instead of tracking latest. Empty = latest. */
  plateauPinnedYear: str("VITE_PLATEAU_YEAR"),
  buildingsEnabled: bool("VITE_BUILDINGS", true),

  datasetUrl: str("VITE_DATASET_URL", "data/demo-dataset.json"),

  /** Cap on simultaneously rendered vehicles. Tuned in Phase 6. */
  maxTrains: num("VITE_MAX_TRAINS", 2000),
  /** Skip the opening camera flight. */
  skipIntro: bool("VITE_SKIP_INTRO", false),
} as const;

export const IS_DEMO_MODE = CONFIG.gatewayUrl.length === 0;
