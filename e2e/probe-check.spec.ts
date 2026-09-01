import { expect, test } from "@playwright/test";
import { blockPlateau, probeGeometry, captureFrame, frameDiffRatio, serveTestTileset } from "./helpers.js";

test.setTimeout(150_000);

/**
 * A test of the tests.
 *
 * Does the new geometry assertion actually discriminate?
 *
 * A test that passes whether or not the feature works is worse than no test. This
 * runs the exact CITY VIEW probe with PLATEAU blocked instead of served: if the
 * assertions still passed here, they would be meaningless.
 */
test("the geometry probe FAILS when buildings are absent", async ({ page }) => {
  await blockPlateau(page);
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(12_000);

  const probe = await probeGeometry(page);
  // No tileset was served, so nothing 3D may be picked and no surface stands up.
  expect(probe.tileHits).toBe(0);
  if (probe.pickPositionSupported) {
    expect(probe.maxHeight).toBeLessThan(30);
  }

  await captureFrame(page, "a");
  await page.getByRole("button", { name: "3D建物 Buildings" }).click();
  await page.waitForTimeout(3_500);
  await captureFrame(page, "b");
  // With no buildings, toggling the layer changes essentially nothing.
  expect(await frameDiffRatio(page, "a", "b")).toBeLessThan(0.02);
});

test("the same probe PASSES when buildings are served", async ({ page }) => {
  await serveTestTileset(page);
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(12_000);

  const probe = await probeGeometry(page);
  expect(probe.tileHits).toBeGreaterThan(3);
  if (probe.pickPositionSupported) expect(probe.maxHeight).toBeGreaterThan(30);
  console.log(`PROBE served: tileHits=${probe.tileHits}/${probe.samples} maxHeight=${probe.maxHeight.toFixed(1)}m pickPos=${probe.pickPositionSupported}`);
});
