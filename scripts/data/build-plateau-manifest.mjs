#!/usr/bin/env node
/**
 * Build the PLATEAU 3D Tiles manifest for the Tokyo 23 wards.
 *
 *   node scripts/data/build-plateau-manifest.mjs
 *   node scripts/data/build-plateau-manifest.mjs --offline   (pattern-derived, no network)
 *
 * Queries MLIT's official PLATEAU data catalog GraphQL API for the real tileset URLs
 * of each ward's building model, and writes apps/web/public/data/plateau-manifest.json.
 *
 * Why a manifest instead of resolving the catalog in the browser:
 * resolving at runtime puts a third-party API on the critical path of every page load,
 * and a schema change or a CORS refusal then means no buildings at all with no warning.
 * The manifest is built once, committed, refreshed by CI at deploy time, and the app
 * reads a static file it controls. See docs/DECISIONS.md D-012.
 *
 * Official sources (verified 2026-09-01):
 *   GraphQL   https://api.plateauview.mlit.go.jp/datacatalog/graphql
 *   Schema    github.com/eukarya-inc/PLATEAU-VIEW server/datacatalog/plateauapi/schema.graphql
 *   3D Tiles  https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{spec}/tileset.json
 *   Docs      https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKYO_WARDS, TOKYO_WARD_CODES } from "./tokyo-wards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../apps/web/public/data/plateau-manifest.json");

const API_HOST = process.env.PLATEAU_API_HOST ?? "https://api.plateauview.mlit.go.jp";
const GRAPHQL = `${API_HOST}/datacatalog/graphql`;
const OFFLINE = process.argv.includes("--offline");

const ATTRIBUTION = "3D都市モデル: Project PLATEAU (国土交通省)";
const LICENSE = "CC BY 4.0 (G空間情報センター) — 各データセットの表示を確認すること";

/**
 * The composite endpoint resolves {area}-{type}-lod{N}-{year|latest} server-side.
 * `latest` follows each municipality's newest published year automatically, which is
 * what spec §9 asks for and removes any hardcoded data year.
 *
 * Derived from MLIT's own URL builder:
 *   PLATEAU-VIEW/server/datacatalog/plateauapi/composite_url.go BuildPlateauItemDynamicURL
 */
function compositeUrl(areaCode, lod) {
  return `${API_HOST}/datacatalog/3dtiles/${areaCode}-bldg-lod${lod}-latest/tileset.json`;
}

const QUERY = `
query TokyoBuildings($codes: [AreaCode!]) {
  datasets(input: { areaCodes: $codes, includeTypes: ["bldg"], shallow: false }) {
    id
    name
    year
    ... on PlateauDataset {
      wardCode
      cityCode
      typeCode
      ward { code name }
      city { code name }
      items {
        id
        name
        format
        lod
        texture
        url
        compositeUrl
        latestUrl
      }
    }
  }
}`;

async function queryCatalog() {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { codes: TOKYO_WARD_CODES } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL error: ${body.errors[0].message}`);
  const datasets = body.data?.datasets;
  if (!Array.isArray(datasets)) throw new Error("GraphQL returned no datasets array");
  return datasets;
}

/** Pick the best 3D Tiles item per ward per LOD, preferring a texture-less LOD1 and any LOD2. */
function collectFromCatalog(datasets) {
  /** @type {Map<string, {lod1: string[], lod2: string[], year: number|null, name: string}>} */
  const byWard = new Map();

  for (const ds of datasets) {
    const code = ds.wardCode ?? ds.cityCode;
    if (!code || !TOKYO_WARD_CODES.includes(String(code))) continue;
    if (ds.typeCode && ds.typeCode !== "bldg") continue;

    const entry = byWard.get(String(code)) ?? {
      lod1: [],
      lod2: [],
      year: null,
      name: ds.ward?.name ?? ds.city?.name ?? ds.name ?? "",
    };
    if (typeof ds.year === "number") entry.year = Math.max(entry.year ?? 0, ds.year);

    for (const item of ds.items ?? []) {
      if (item.format !== "CESIUM3DTILES") continue;
      // latestUrl auto-follows new data years; url is the direct CDN asset and is the
      // fallback when the composite endpoint refuses our origin.
      const urls = [item.latestUrl, item.compositeUrl, item.url].filter(
        (u) => typeof u === "string" && u.length > 0,
      );
      if (urls.length === 0) continue;
      const bucket = item.lod === 2 ? entry.lod2 : item.lod === 1 ? entry.lod1 : null;
      if (bucket) for (const u of urls) if (!bucket.includes(u)) bucket.push(u);
    }
    byWard.set(String(code), entry);
  }
  return byWard;
}

let source = "pattern";
let byWard = new Map();
let warning;

if (!OFFLINE) {
  try {
    console.log(`Querying ${GRAPHQL} …`);
    byWard = collectFromCatalog(await queryCatalog());
    const withUrls = [...byWard.values()].filter((e) => e.lod1.length + e.lod2.length > 0);
    if (withUrls.length === 0) throw new Error("catalog returned no 3D Tiles items for Tokyo");
    source = "catalog";
    console.log(`  catalog returned tilesets for ${withUrls.length} wards`);
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
    console.warn(`  catalog unavailable (${warning}) — falling back to the documented URL pattern`);
  }
}

const wards = TOKYO_WARDS.map((ward) => {
  const found = byWard.get(ward.code);
  // Even from the catalog, always keep the documented composite URLs as fallbacks:
  // they are stable and year-independent, and cost nothing until they are needed.
  const lod1 = [...new Set([...(found?.lod1 ?? []), compositeUrl(ward.code, 1)])];
  const lod2 = [...new Set([...(found?.lod2 ?? []), compositeUrl(ward.code, 2)])];
  return {
    code: ward.code,
    name: ward.name,
    nameEn: ward.nameEn,
    center: ward.center,
    radiusKm: ward.radiusKm,
    year: found?.year ?? null,
    lod1,
    lod2,
  };
});

const manifest = {
  meta: {
    builtAt: Date.now(),
    // "catalog" = URLs came from the official GraphQL API.
    // "pattern" = URLs derived from MLIT's documented composite endpoint scheme only.
    source,
    apiHost: API_HOST,
    graphql: GRAPHQL,
    warning,
    attribution: ATTRIBUTION,
    license: LICENSE,
    note:
      "PLATEAU 3D Tiles for the Tokyo 23 wards. 'latest' composite URLs follow each " +
      "municipality's newest published data year, so no year is hardcoded.",
  },
  wards,
};

mkdirSync(dirname(OUT), { recursive: true });
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

// Never downgrade a catalog-verified manifest to a pattern-derived one just because the
// network happened to be unavailable on this run.
if (source === "pattern" && previous?.meta?.source === "catalog") {
  console.log("\nKeeping the existing catalog-derived manifest; this run had no catalog access.");
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(manifest, null, 2));

console.log(`\nPLATEAU manifest -> ${OUT}`);
console.log(`  source        ${source}${warning ? ` (${warning})` : ""}`);
console.log(`  wards         ${wards.length}`);
console.log(`  lod1 urls     ${wards.reduce((a, w) => a + w.lod1.length, 0)}`);
console.log(`  lod2 urls     ${wards.reduce((a, w) => a + w.lod2.length, 0)}`);
console.log(`  Shinjuku      ${wards.find((w) => w.code === "13104").lod1[0]}`);
if (source === "pattern") {
  console.log(`\n  NOTE: URLs are derived from MLIT's documented composite endpoint scheme,`);
  console.log(`  not read back from the catalog. Re-run with network access to verify them.`);
}
