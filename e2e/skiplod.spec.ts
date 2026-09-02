import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  measureBuildingCoverage,
  serveLodTileset,
  setCamera,
  toggleLayer,
  withDrawer,
} from "./helpers.js";

/**
 * Why do the buildings look see-through?
 *
 * Cesium 1.144 implements `skipLevelOfDetail` by drawing tiles that are not yet at
 * final resolution with the colour mask DISABLED — depth only — and stencilling the
 * resolved ones over the top (ModelDrawCommand.deriveSkipLodBackfaceCommand:
 * "Write just backface depth of unresolved tiles so resolved stenciled tiles do not
 * appear in front"). `hasMixedContent` is what switches that path on, and it is set
 * only by the skip traversal: with `skipLevelOfDetail: false` the base traversal
 * clears it every frame and no tile is ever drawn invisibly.
 *
 * That is a reading of the source. This is the experiment. Both arms run the same
 * build, the same three-level REPLACE fixture and the same fixed camera; the only
 * difference is the tuning flags, supplied by URL so nothing has to be rebuilt.
 *
 * The measurement is buildings-on minus buildings-off at a still camera: the fraction
 * of the frame the layer actually paints. A tile drawn with the colour mask off
 * contributes nothing to it, which is exactly the symptom being chased.
 */

// 西新宿, looking north-east across the fixture. To reproduce by hand: open with
// ?debug=1 and run, in the console,
//   __viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139.6889, 35.6858, 620),
//     orientation: { heading: Cesium.Math.toRadians(28), pitch: Cesium.Math.toRadians(-22), roll: 0 } })
const NISHI_SHINJUKU = {
  lon: 139.6889,
  lat: 35.6858,
  height: 620,
  heading: 28,
  pitch: -22,
};

/** Long enough that the held-back leaves are still outstanding while frames are measured. */
const LEAF_DELAY_MS = 30_000;
/** Half the leaves arrive, half do not — the mixed-content state, on purpose. */
const LEAF_DELAY_FRACTION = 0.5;

interface Arm {
  label: string;
  search: string;
  coverage: number;
  wardsLoaded: number;
  pendingRequests: number;
  tilesProcessing: number;
  updateP95Ms: number;
  updateMaxMs: number;
}

async function runArm(browser: Browser, label: string, search: string): Promise<Arm> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  try {
    // Explicitly, on the page: the phone tier is the one under investigation, and it
    // is also the one whose ward budget keeps the fixture from being loaded ten times
    // over at the same coordinates.
    await page.setViewportSize({ width: 390, height: 844 });
    await serveLodTileset(page, {
      delayLeavesMs: LEAF_DELAY_MS,
      delayLeafFraction: LEAF_DELAY_FRACTION,
    });
    await page.goto(`/?debug=1&${search}`);
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
    await page.waitForTimeout(3_000);

    // No click to cancel the intro: setCamera calls camera.cancelFlight(), which ends
    // it. Clicking the canvas is the trap here — Playwright's actionability check waits
    // for the point to receive pointer events, and the HUD covers most of the globe, so
    // a canvas click can hang until the test timeout.
    // Trains off: the coverage measurement compares two captures, and a moving vehicle
    // would land in the difference as if it were a building.
    await withDrawer(page, () => toggleLayer(page, "列車 Trains"));

    await setCamera(page, NISHI_SHINJUKU);
    // Long enough for the root and level-1 tiles to arrive, short enough that the
    // level-2 requests are still outstanding. That window IS the bug's habitat.
    await page.waitForTimeout(7_000);
    await setCamera(page, NISHI_SHINJUKU);
    await page.waitForTimeout(2_000);

    const coverage = await measureBuildingCoverage(page);
    await setCamera(page, NISHI_SHINJUKU);
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: `perf/skiplod/${label}.png` });

    const stats = (await page.evaluate(() => (window as any).__perf?.())) as any;
    const arm: Arm = {
      label,
      search,
      coverage,
      wardsLoaded: stats?.wardsLoaded ?? -1,
      pendingRequests: stats?.tiles?.pendingRequests ?? -1,
      tilesProcessing: stats?.tiles?.tilesProcessing ?? -1,
      updateP95Ms: stats?.cesium?.updateP95Ms ?? -1,
      updateMaxMs: stats?.cesium?.updateMaxMs ?? -1,
    };
    console.log(`[SKIPLOD] ${label} ${JSON.stringify(arm)}`);
    return arm;
  } finally {
    await context.close();
  }
}

test("skipLevelOfDetail A/B at 西新宿, level-2 content delayed", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  mkdirSync("perf/skiplod", { recursive: true });

  const on = await runArm(browser, "skiplod-on", "sklod=1&leaves=1");
  const off = await runArm(browser, "skiplod-off", "sklod=0&leaves=0");

  writeFileSync("perf/skiplod/result.json", JSON.stringify({ on, off }, null, 2));

  // The regression this guards: with the shipped settings, coarse levels must be
  // visible while the fine ones load. If the layer's painted coverage collapses toward
  // zero during loading, the buildings have gone see-through again.
  expect(off.coverage).toBeGreaterThan(0.02);
});
