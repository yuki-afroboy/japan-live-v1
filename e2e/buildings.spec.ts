import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * PLATEAU buildings, verified as GEOMETRY — not as "a tileset object was added".
 *
 * V1 shipped believing buildings worked because the code path ran without throwing.
 * On a real iPhone at Shinjuku there were none. So these tests serve a real, valid
 * 3D Tiles tileset (e2e/fixtures/tileset, a synthetic west-Shinjuku skyline) in place
 * of PLATEAU and then check that the frame actually changes and that the silhouette
 * has height when the camera tilts.
 *
 * What this CANNOT verify: that PLATEAU's own endpoints serve these tiles to a browser
 * from a github.io origin. That needs a network this container does not have; see
 * docs/DECISIONS.md D-012.
 */

const TILESET = JSON.parse(
  readFileSync(resolve(HERE, "fixtures/tileset/tileset.json"), "utf8"),
);
const GLB = readFileSync(resolve(HERE, "fixtures/tileset/buildings.glb"));

/** Stand in for every PLATEAU 3D Tiles endpoint. */
async function serveTileset(page: Page, options: { fail?: number } = {}) {
  await page.route("**/datacatalog/3dtiles/**", async (route) => {
    const url = route.request().url();
    if (options.fail) {
      await route.fulfill({ status: options.fail, body: "upstream error" });
      return;
    }
    if (url.endsWith("buildings.glb")) {
      await route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        body: GLB,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TILESET),
    });
  });
  await page.route("**/*.glb", async (route) => {
    await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: GLB });
  });
}

async function boot(page: Page) {
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
}

async function sample(page: Page) {
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const s = document.querySelector(".cesium-widget canvas") as HTMLCanvasElement;
    const off = document.createElement("canvas");
    off.width = 480;
    off.height = 300;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(s, 0, 0, off.width, off.height);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    const colors = new Set<number>();
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! + d[i + 1]! + d[i + 2]! > 45) lit++;
      colors.add(((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3));
    }
    return { lit: lit / (d.length / 4), colors: colors.size };
  });
}

const diag = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('section[aria-label="3D建物"]');
    return el ? (el as HTMLElement).innerText : "";
  });

test("buildings load and render at Shinjuku", async ({ page }) => {
  await serveTileset(page);
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

test("CITY VIEW shows buildings with visible height", async ({ page }) => {
  await serveTileset(page);
  await boot(page);

  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(12_000);
  const withBuildings = await sample(page);

  // Turning buildings off must visibly change the frame. If it does not, whatever the
  // diagnostics claim, nothing was being drawn.
  await page.getByRole("button", { name: "3D建物 Buildings" }).click();
  await page.waitForTimeout(3_500);
  const without = await sample(page);

  expect(withBuildings.colors).toBeGreaterThan(without.colors);
});

test("the camera is oblique enough to read a skyline", async ({ page }) => {
  await serveTileset(page);
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
  await serveTileset(page);
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
  await serveTileset(page, { fail: 503 });
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
  await serveTileset(page);
  await boot(page);
  await page.getByRole("button", { name: "日本", exact: true }).click();
  await page.waitForTimeout(9_000);

  const text = await diag(page);
  expect(text).toContain("カメラが高すぎます");
});
