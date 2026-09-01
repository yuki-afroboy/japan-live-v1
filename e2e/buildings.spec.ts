import { expect, test, type Page } from "@playwright/test";
import {
  captureFrame,
  frameDiffRatio,
  probeGeometry,
  serveTestTileset,
} from "./helpers.js";

/**
 * PLATEAU buildings, verified as GEOMETRY — not as "a tileset object was added".
 *
 * V1 shipped believing buildings worked because the code path ran without throwing.
 * On a real iPhone at Shinjuku there were none. So these tests serve a real, valid
 * 3D Tiles tileset (e2e/fixtures/tileset, a synthetic west-Shinjuku skyline) in place
 * of PLATEAU and then establish that the scene actually contains 3D geometry.
 *
 * What this CANNOT verify: that PLATEAU's own endpoints serve these tiles to a browser
 * from a github.io origin. That needs a network this container does not have; see
 * docs/DECISIONS.md D-012.
 *
 * Sized like render.spec: loading and picking real 3D Tiles on a software rasteriser is
 * slow, and the deadline reflects the machine rather than hiding a fault.
 */
test.setTimeout(150_000);

async function boot(page: Page) {
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
}

const diag = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('section[aria-label="3D建物"]');
    return el ? (el as HTMLElement).innerText : "";
  });

test("buildings load and render at Shinjuku", async ({ page }) => {
  await serveTestTileset(page);
  await boot(page);

  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(12_000);

  const text = await diag(page);
  expect(text).toContain("PLATEAU BUILDINGS");
  // Loaded, visible, and reporting real wards — not just "no error".
  expect(text).toMatch(/OK|PARTIAL/);
  expect(text).toContain("YES");
  expect(text).toContain("新宿区");
});

test("CITY VIEW puts real 3D geometry on screen", async ({ page }) => {
  await serveTestTileset(page);
  await boot(page);

  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(12_000);

  // 1. Geometry is genuinely under the pixels, not merely loaded into a collection.
  const probe = await probeGeometry(page);
  expect(probe.samples).toBeGreaterThan(20);
  expect(probe.tileHits, "no 3D Tiles geometry was picked anywhere in the view").toBeGreaterThan(3);

  // 2. That geometry stands well above ground. This is what makes it a skyline rather
  //    than a footprint map, and it is the property the user checks on a real phone.
  if (probe.pickPositionSupported) {
    expect(probe.maxHeight, "surfaces are all at ground level; buildings have no height").toBeGreaterThan(30);
  }

  // 3. Turning buildings off visibly changes the frame.
  //
  //    Measured as a pixel DIFFERENCE, deliberately. The previous version asserted that
  //    buildings must ADD distinct colours, which is not true: a large flat-shaded mass
  //    occludes a more varied background and can reduce the palette. CI measured 1405
  //    colours with buildings against 1480 without, and failed a working skyline.
  await captureFrame(page, "buildings-on");
  await page.getByRole("button", { name: "3D建物 Buildings" }).click();
  await page.waitForTimeout(3_500);
  await captureFrame(page, "buildings-off");

  const diff = await frameDiffRatio(page, "buildings-on", "buildings-off");
  expect(diff, "toggling buildings changed almost nothing on screen").toBeGreaterThan(0.02);

  // 4. With buildings off, nothing 3D remains to pick.
  const offProbe = await probeGeometry(page);
  expect(offProbe.tileHits).toBe(0);
});

test("the camera is oblique enough to read a skyline", async ({ page }) => {
  await serveTestTileset(page);
  await boot(page);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(9_000);

  const view = await page.evaluate(() => {
    const v = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    return {
      pitchDeg: Cesium.Math.toDegrees(v.camera.pitch),
      height: v.camera.positionCartographic.height,
    };
  });

  // A near-overhead view flattens a skyline into a street map.
  expect(view.pitchDeg).toBeGreaterThan(-45);
  expect(view.pitchDeg).toBeLessThan(-5);
  expect(view.height).toBeLessThan(2_500);
});

test("only nearby wards are loaded, not all 23", async ({ page }) => {
  await serveTestTileset(page);
  await boot(page);
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(12_000);

  const loaded = await page.evaluate(() => {
    const v = (window as any).__viewer;
    let n = 0;
    for (let i = 0; i < v.scene.primitives.length; i++) {
      // Duck-typed: the class name does not survive minification in a production build.
      const p = v.scene.primitives.get(i);
      if (p && "maximumScreenSpaceError" in p) n++;
    }
    return n;
  });
  // A phone cannot hold 23 wards of geometry; the budget caps it well below that.
  expect(loaded).toBeGreaterThan(0);
  expect(loaded).toBeLessThanOrEqual(10);
});

test("a failing tileset is reported, not silently absent", async ({ page }) => {
  await serveTestTileset(page, { failStatus: 503 });
  await boot(page);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(12_000);

  const text = await diag(page);
  expect(text).toContain("ERROR");
  expect(text).toContain("NO");
  // The failure log is available rather than the user being left guessing.
  expect(text).toMatch(/詳細ログ/);
});

test("diagnostics explain an over-high camera instead of looking broken", async ({ page }) => {
  await serveTestTileset(page);
  await boot(page);
  await page.getByRole("button", { name: "日本", exact: true }).click();
  await page.waitForTimeout(9_000);

  const text = await diag(page);
  expect(text).toContain("カメラが高すぎます");
});
