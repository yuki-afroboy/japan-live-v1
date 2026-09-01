import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Visual verification (spec §65). These are not assertions — they exist so a human,
 * and the agent building this, can actually LOOK at the product rather than trusting
 * that a passing build means it renders.
 */

const OUT = "screenshots";

// Capturing the whole experience involves many camera flights and tile settles.
test.setTimeout(300_000);
test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

async function boot(page: Page) {
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
  await page.getByRole("button", { name: "×60" }).click();
  await page.getByRole("slider", { name: "時刻" }).fill(String(8 * 3600));
  await settle(page, 5_000);
  await page.screenshot({ path: `${OUT}/06-simulation.png` });

  // 7. Night — scrub to 23:00 and watch the city go dark.
  await page.getByRole("slider", { name: "時刻" }).fill(String(23 * 3600));
  await settle(page, 6_000);
  await page.screenshot({ path: `${OUT}/07-night.png` });

  // 8. Mobile viewport.
  await page.getByRole("button", { name: "LIVE" }).click();
  await page.setViewportSize({ width: 414, height: 896 });
  await settle(page, 5_000);
  await page.screenshot({ path: `${OUT}/08-mobile.png` });
});

test("capture the inspector by clicking a train", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await boot(page);

  await page.getByRole("button", { name: "東京駅", exact: true }).click();
  await settle(page, 9_000);

  // Trains are primitives, so find one by probing the canvas rather than by selector.
  const canvas = page.locator(".cesium-widget canvas");
  const box = (await canvas.boundingBox())!;
  let found = false;

  for (let ring = 0; ring < 14 && !found; ring++) {
    const r = 28 + ring * 26;
    for (let a = 0; a < 12 && !found; a++) {
      const angle = (a / 12) * Math.PI * 2;
      await page.mouse.click(
        box.x + box.width / 2 + Math.cos(angle) * r,
        box.y + box.height / 2 + Math.sin(angle) * r,
      );
      await page.waitForTimeout(90);
      found = (await page.locator(".inspector").count()) > 0;
    }
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
