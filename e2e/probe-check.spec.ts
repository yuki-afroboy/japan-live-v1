import { expect, test } from "@playwright/test";
import {
  blockPlateau,
  probeGeometry,
  serveTestTileset,
  toggleLayer,
  waitForGeometry,
} from "./helpers.js";

test.setTimeout(150_000);

/**
 * A test of the tests.
 *
 * `probeGeometry` is what establishes that buildings exist as 3D geometry. If it
 * reported hits whether or not buildings were present, every building test would be
 * worthless — and this project has already shipped once believing a green suite meant
 * a working feature. So this file drives the probe from both sides.
 *
 * Deliberately geometry-only. An earlier version also asserted that the frame barely
 * changes when buildings are absent, which is false by construction: trains animate
 * continuously, so the frame changes about 20% on its own over any few seconds. That
 * assertion tested the product's core motion, not its buildings.
 */

async function bootAt(page: import("@playwright/test").Page, preset = "CITY VIEW") {
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: preset }).click();
  await page.waitForTimeout(12_000);
}

test("with PLATEAU blocked, the probe reports no geometry — and keeps reporting none", async ({
  page,
}) => {
  await blockPlateau(page);
  await bootAt(page);

  const initial = await probeGeometry(page);
  expect(initial.samples).toBe(25);
  expect(initial.tileHits, "geometry was picked with no tileset served").toBe(0);
  if (initial.pickPositionSupported) {
    expect(initial.maxHeight, "a surface stood above ground with no buildings").toBeLessThan(30);
  }

  // Toggling the layer must not conjure geometry that was never loaded.
  await toggleLayer(page, "3D建物 Buildings");
  await page.waitForTimeout(2_500);
  const afterOff = await probeGeometry(page);
  expect(afterOff.tileHits).toBe(0);
  if (afterOff.pickPositionSupported) expect(afterOff.maxHeight).toBeLessThan(30);

  await toggleLayer(page, "3D建物 Buildings");
  await page.waitForTimeout(3_000);
  const afterOn = await probeGeometry(page);
  expect(afterOn.tileHits, "geometry appeared from a blocked source").toBe(0);
  if (afterOn.pickPositionSupported) expect(afterOn.maxHeight).toBeLessThan(30);
});

test("with the fixture served, geometry appears, disappears on toggle, and returns", async ({
  page,
}) => {
  await serveTestTileset(page);
  await bootAt(page);

  // ON: real geometry, standing above ground.
  const on = await waitForGeometry(page, { minHits: 3 });
  expect(on.tileHits, "no 3D Tiles geometry picked while buildings are served").toBeGreaterThan(0);
  if (on.pickPositionSupported) {
    expect(on.maxHeight, "surfaces are all at ground level").toBeGreaterThan(30);
  }

  // OFF: the geometry itself stops being pickable, not merely dimmed.
  await toggleLayer(page, "3D建物 Buildings");
  await page.waitForTimeout(2_500);
  const off = await probeGeometry(page);
  expect(off.tileHits, "buildings were still pickable after being switched off").toBe(0);

  // ON again: it comes back. This is the pair that makes the probe meaningful —
  // it responds to the feature and to nothing else.
  await toggleLayer(page, "3D建物 Buildings");
  const back = await waitForGeometry(page, { minHits: 3 });
  expect(back.tileHits, "buildings did not return after being switched back on").toBeGreaterThan(0);
  if (back.pickPositionSupported) expect(back.maxHeight).toBeGreaterThan(30);

  console.log(
    `PROBE on=${on.tileHits}/${on.samples} h=${on.maxHeight.toFixed(1)}m | ` +
      `off=${off.tileHits} | back=${back.tileHits}/${back.samples} h=${back.maxHeight.toFixed(1)}m`,
  );
});
