import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NARROW_MAX_WIDTH,
  profileFor,
  resolutionScaleFor,
  tierFor,
  tileTuningFrom,
} from "../src/scene/quality.js";

/**
 * A performance budget nobody can accidentally spend.
 *
 * These are not "is it fast" tests — a CI container cannot answer that, and pretending
 * otherwise is how you end up with a green suite and a phone that stutters. They are
 * regression locks on the SETTINGS a measurement chose, so raising the mobile pixel
 * budget back to desktop levels, or quietly loading ten wards on a phone again, breaks
 * a test instead of a device.
 */

const css = readFileSync(resolve(__dirname, "../src/ui/styles.css"), "utf8");

describe("the breakpoint is one number", () => {
  it("the stylesheet uses the same width the layout and the quality tier use", () => {
    // Three places used to know this independently. If they drift, a phone gets the
    // mobile layout with the desktop's pixel budget, or vice versa, and the symptom is
    // "it's slow on some devices" — the hardest kind of bug to chase.
    expect(css).toContain(`@media (max-width: ${NARROW_MAX_WIDTH}px)`);
  });

  it("classifies phones as mobile and laptops as desktop", () => {
    expect(tierFor(375)).toBe("mobile"); // iPhone SE
    expect(tierFor(390)).toBe("mobile"); // iPhone 14/15
    expect(tierFor(NARROW_MAX_WIDTH)).toBe("mobile"); // exactly at the query bound
    expect(tierFor(NARROW_MAX_WIDTH + 1)).toBe("desktop");
    expect(tierFor(1280)).toBe("desktop");
  });
});

describe("resolution scale", () => {
  it("caps a 3x phone screen well below the desktop cap", () => {
    expect(resolutionScaleFor("mobile", 3)).toBe(1.25);
    expect(resolutionScaleFor("desktop", 3)).toBe(1.75);
  });

  it("never upscales a 1x screen", () => {
    expect(resolutionScaleFor("mobile", 1)).toBe(1);
    expect(resolutionScaleFor("desktop", 1)).toBe(1);
  });

  it("survives a nonsense devicePixelRatio", () => {
    expect(resolutionScaleFor("mobile", 0)).toBe(1);
    expect(resolutionScaleFor("desktop", -4)).toBe(1);
  });

  it("cuts phone fragment work by more than half against the old 1.75 cap", () => {
    // Cost scales with the square. This is the actual claim being made, so it is the
    // one asserted, rather than the scale value on its own.
    const before = 1.75 ** 2;
    const after = resolutionScaleFor("mobile", 3) ** 2;
    expect(after / before).toBeLessThan(0.55);
  });
});

describe("mobile profile", () => {
  const mobile = profileFor(390, 3);

  it("is the mobile tier", () => {
    expect(mobile.tier).toBe("mobile");
  });

  it("turns off MSAA where it is actually paid for", () => {
    // The context flag is nearly cosmetic; msaaSamples is Cesium's own render target
    // and defaults to 4, which is 4x the fragment cost of the whole scene.
    expect(mobile.antialias).toBe(false);
    expect(mobile.msaaSamples).toBe(1);
    expect(mobile.fxaa).toBe(false);
  });

  it("caps how much PLATEAU geometry may be resident", () => {
    expect(mobile.wardBudget).toBeLessThanOrEqual(3);
    // Still more than one: CITY VIEW straddles 新宿区 and its neighbours, and dropping
    // to a single ward makes the skyline end at a boundary line.
    expect(mobile.wardBudget).toBeGreaterThanOrEqual(2);
  });

  it("keeps the tile cache inside a phone's memory", () => {
    expect(mobile.tilesetCacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(mobile.tilesetOverflowBytes).toBeLessThanOrEqual(mobile.tilesetCacheBytes);
  });

  it("keeps buildings detailed enough to read as buildings", () => {
    // Above roughly 24 the west-Shinjuku towers stop resolving as separate masses.
    expect(mobile.detailSse).toBeLessThanOrEqual(20);
    expect(mobile.midSse).toBeGreaterThan(mobile.detailSse);
  });

  it("throttles train animation without stopping it", () => {
    expect(mobile.animationHz).toBeLessThanOrEqual(30);
    // A city visualisation at 15 Hz reads as broken, not as economical.
    expect(mobile.animationHz).toBeGreaterThanOrEqual(24);
  });
});

describe("desktop profile is unchanged from what V1 shipped", () => {
  const desktop = profileFor(1280, 2);

  it("keeps every value the desktop had before the mobile tuning", () => {
    expect(desktop).toMatchObject({
      tier: "desktop",
      antialias: true,
      msaaSamples: 4,
      fxaa: true,
      wardBudget: 10,
      tilesetCacheBytes: 128 * 1024 * 1024,
      tilesetOverflowBytes: 64 * 1024 * 1024,
      detailSse: 12,
      midSse: 32,
    });
    expect(desktop.resolutionScale).toBe(1.75);
  });

  it("does not throttle animation", () => {
    // Anything at or above the display's own rate is no cap at all.
    expect(desktop.animationHz).toBeGreaterThanOrEqual(60);
  });
});

describe("mobile costs strictly less than desktop everywhere it matters", () => {
  const mobile = profileFor(390, 3);
  const desktop = profileFor(1280, 3);

  it("spends fewer pixels, less geometry, less memory and fewer frames", () => {
    expect(mobile.resolutionScale).toBeLessThan(desktop.resolutionScale);
    expect(mobile.wardBudget).toBeLessThan(desktop.wardBudget);
    expect(mobile.tilesetCacheBytes).toBeLessThan(desktop.tilesetCacheBytes);
    expect(mobile.detailSse).toBeGreaterThan(desktop.detailSse);
    expect(mobile.animationHz).toBeLessThan(desktop.animationHz);
    expect(mobile.msaaSamples).toBeLessThan(desktop.msaaSamples);
    expect(mobile.antialias).toBe(false);
    expect(mobile.fxaa).toBe(false);
  });
});

/**
 * 3D Tiles tuning.
 *
 * These four settings are the ones the V1.2 investigation actually changed, so they
 * are locked here: an accidental revert to Cesium's skip-LOD defaults brings back
 * buildings that paint nothing while their descendants load, and an unbounded request
 * count brings back the frame that parses forty tiles at once.
 */
describe("tile tuning", () => {
  it("keeps skip-LOD selection on, which is what the A/B supported", () => {
    // Measured, not assumed: turning it off made the layer paint LESS while tiles were
    // still arriving, because Cesium then refuses to refine until every child is ready.
    // See docs/PERFORMANCE.md V1.2 and perf/skiplod/result.json.
    expect(profileFor(390, 3).tiles.skipLevelOfDetail).toBe(true);
    expect(profileFor(1280, 2).tiles.skipLevelOfDetail).toBe(true);
  });

  it("leaves the request scheduler at Cesium's defaults, because nothing measured said otherwise", () => {
    // Deliberately NOT tuned. A cap looked plausible from the Cesium source and the
    // CI A/B could not show a benefit, so it stays a knob rather than a decision.
    // If a device measurement ever justifies a cap, this test is where it lands.
    const mobile = profileFor(390, 3).tiles;
    expect(mobile.maximumRequests).toBe(50);
    expect(mobile.maximumRequestsPerServer).toBe(18);
  });
});

describe("tileTuningFrom", () => {
  const base = profileFor(390, 3).tiles;

  it("changes nothing for a normal load", () => {
    expect(tileTuningFrom("", base)).toEqual(base);
    expect(tileTuningFrom("?debug=1", base)).toEqual(base);
  });

  it("lets a measurement run take the other side of the A/B", () => {
    const tuned = tileTuningFrom("?sklod=1&leaves=1", base);
    expect(tuned.skipLevelOfDetail).toBe(true);
    expect(tuned.preferLeaves).toBe(true);
    // Untouched parameters keep the shipped value, so an arm differs in one thing only.
    expect(tuned.maximumRequests).toBe(base.maximumRequests);
  });

  it("reads 0 as off, not as absent", () => {
    const on = tileTuningFrom("?dsse=1", base);
    const off = tileTuningFrom("?dsse=0", base);
    expect(on.dynamicScreenSpaceError).toBe(true);
    expect(off.dynamicScreenSpaceError).toBe(false);
  });

  it("ignores a request count that is not a usable number", () => {
    expect(tileTuningFrom("?req=abc", base).maximumRequests).toBe(base.maximumRequests);
    expect(tileTuningFrom("?req=0", base).maximumRequests).toBe(base.maximumRequests);
    expect(tileTuningFrom("?req=-4", base).maximumRequests).toBe(base.maximumRequests);
    expect(tileTuningFrom("?req=6", base).maximumRequests).toBe(6);
  });
});
