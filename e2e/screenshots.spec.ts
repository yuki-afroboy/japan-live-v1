import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { serveTestTileset } from "./helpers.js";

/**
 * Visual verification (spec §65). These are not assertions — they exist so a human,
 * and the agent building this, can actually LOOK at the product rather than trusting
 * that a passing build means it renders.
 */

const OUT = "screenshots";

// Capturing the whole experience involves many camera flights and tile settles.
test.setTimeout(300_000);

// These produce images for a human to look at; they assert nothing. CI runs the
// smoke, render, live-path and mobile suites instead. Run with CAPTURE=1.
test.skip(!process.env.CAPTURE, "set CAPTURE=1 to regenerate screenshots");
test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

async function boot(page: Page) {
  await serveTestTileset(page);
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(6_000);
}

/** Cesium renders on demand; give tiles and the camera time to settle before capture. */
async function settle(page: Page, ms = 7_000) {
  await page.waitForTimeout(ms);
}

test("capture the experience", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await boot(page);

  // 1. Japan from space — the opening view.
  await page.getByRole("button", { name: "日本", exact: true }).click();
  await settle(page, 9_000);
  await page.screenshot({ path: `${OUT}/01-japan.png` });

  // 2. Kanto — the network appears.
  await page.getByRole("button", { name: "関東", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/02-kanto.png` });

  // 3. Tokyo — trains moving across the whole network.
  await page.getByRole("button", { name: "東京", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/03-tokyo.png` });

  // 4. Shinjuku close in — buildings and individual trains.
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/04-shinjuku.png` });

  // 5. Subway X-Ray.
  await page.getByRole("button", { name: "地下鉄 X-RAY" }).click();
  await settle(page, 4_000);
  await page.screenshot({ path: `${OUT}/05-xray.png` });
  await page.getByRole("button", { name: "地下鉄 X-RAY" }).click();

  // 6. Simulation at the morning rush.
  await page.getByRole("button", { name: "×60", exact: true }).click();
  await page.getByRole("slider", { name: "時刻" }).fill(String(8 * 3600));
  await settle(page, 5_000);
  await page.screenshot({ path: `${OUT}/06-simulation.png` });

  // 7. Night — scrub to 23:00 and watch the city go dark.
  await page.getByRole("slider", { name: "時刻" }).fill(String(23 * 3600));
  await settle(page, 6_000);
  await page.screenshot({ path: `${OUT}/07-night.png` });

  // 8. Mobile viewport — panels closed, so the map has the screen.
  await page.getByRole("button", { name: "LIVE" }).click();
  await page.setViewportSize({ width: 414, height: 896 });
  await settle(page, 5_000);
  await page.screenshot({ path: `${OUT}/08-mobile.png` });

  // 8b. Mobile with the panel drawer open.
  await page.locator(".panels-toggle").click();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: `${OUT}/08b-mobile-panels.png` });
});

test("capture the inspector by clicking a train", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await boot(page);

  await page.getByRole("button", { name: "東京駅", exact: true }).click();
  await settle(page, 9_000);

  // Trains are primitives, not DOM nodes, so ask the scene where one is on screen and
  // click there rather than probing the canvas blindly.
  const canvas = page.locator(".cesium-widget canvas");
  const box = (await canvas.boundingBox())!;
  let found = false;

  for (let attempt = 0; attempt < 25 && !found; attempt++) {
    const point = await page.evaluate((index) => {
      const v = (window as unknown as { __viewer?: any }).__viewer;
      if (!v) return null;
      const Cesium = (window as any).Cesium;
      const collections = [];
      for (let i = 0; i < v.scene.primitives.length; i++) {
        const p = v.scene.primitives.get(i);
        if (p && typeof p.length === "number" && typeof p.get === "function") collections.push(p);
      }
      for (const c of collections) {
        for (let i = index; i < c.length; i++) {
          const item = c.get(i);
          if (!item?.show || !item.position) continue;
          const win = Cesium
            ? Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, item.position)
            : v.scene.cartesianToCanvasCoordinates(item.position);
          if (win && win.x > 40 && win.y > 40) return { x: win.x, y: win.y };
        }
      }
      return null;
    }, attempt);

    if (!point) break;
    await page.mouse.click(box.x + point.x, box.y + point.y);
    await page.waitForTimeout(220);
    found = (await page.locator(".inspector").count()) > 0;
  }

  if (found) {
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: `${OUT}/09-inspector.png` });
    await page.getByRole("button", { name: /追跡 FOLLOW/ }).click();
    await settle(page, 6_000);
    await page.screenshot({ path: `${OUT}/10-follow.png` });
  } else {
    await page.screenshot({ path: `${OUT}/09-no-train-found.png` });
  }
});
