import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOKYO_WARDS } from "../../../scripts/data/tokyo-wards.mjs";

/**
 * The manifest decides whether buildings appear at all. V1 shipped with a single
 * hardcoded Chiyoda tileset and nobody noticed until a phone was pointed at Shinjuku,
 * so its shape is asserted here rather than assumed.
 */
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../public/data/plateau-manifest.json"), "utf8"),
) as {
  meta: { source: string; attribution: string; graphql: string };
  wards: { code: string; name: string; center: [number, number]; radiusKm: number; lod1: string[]; lod2: string[] }[];
};

describe("PLATEAU manifest", () => {
  it("covers all 23 Tokyo wards", () => {
    expect(manifest.wards).toHaveLength(23);
    const codes = new Set(manifest.wards.map((w) => w.code));
    for (const ward of TOKYO_WARDS as { code: string }[]) expect(codes.has(ward.code)).toBe(true);
  });

  it("includes Shinjuku, the ward that was missing in V1", () => {
    const shinjuku = manifest.wards.find((w) => w.code === "13104");
    expect(shinjuku).toBeDefined();
    expect(shinjuku!.name).toBe("新宿区");
    expect(shinjuku!.lod1.length).toBeGreaterThan(0);
  });

  it("gives every ward at least one candidate URL at LOD1", () => {
    for (const w of manifest.wards) {
      expect(w.lod1.length, `${w.name} has no LOD1 URL`).toBeGreaterThan(0);
      for (const url of [...w.lod1, ...w.lod2]) {
        expect(url).toMatch(/^https:\/\//);
        expect(url).toMatch(/tileset\.json$/);
      }
    }
  });

  it("uses the official composite endpoint with the ward's own area code", () => {
    for (const w of manifest.wards) {
      const composite = w.lod1.find((u) => u.includes("/datacatalog/3dtiles/"));
      expect(composite, `${w.name} has no composite URL`).toBeDefined();
      expect(composite).toContain(`${w.code}-bldg-lod1`);
    }
  });

  it("tracks the latest data year rather than hardcoding one", () => {
    // spec §9: no data year may be baked into a URL.
    for (const w of manifest.wards) {
      const composite = w.lod1.find((u) => u.includes("/datacatalog/3dtiles/"))!;
      expect(composite).toContain("-latest/");
      expect(composite).not.toMatch(/-20\d\d\//);
    }
  });

  it("records where its URLs came from, so provenance is never assumed", () => {
    expect(["catalog", "pattern"]).toContain(manifest.meta.source);
    expect(manifest.meta.attribution).toContain("Project PLATEAU");
    expect(manifest.meta.graphql).toContain("/datacatalog/graphql");
  });

  it("gives every ward a centre and radius for proximity loading", () => {
    for (const w of manifest.wards) {
      expect(w.center[0]).toBeGreaterThan(139.4);
      expect(w.center[0]).toBeLessThan(140.0);
      expect(w.center[1]).toBeGreaterThan(35.5);
      expect(w.center[1]).toBeLessThan(35.9);
      expect(w.radiusKm).toBeGreaterThan(1);
      expect(w.radiusKm).toBeLessThan(10);
    }
  });
});
