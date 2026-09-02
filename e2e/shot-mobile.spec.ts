import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { blockPlateau, serveTestTileset } from "./helpers.js";

/**
 * Screenshots of the phone drawer, for looking at rather than asserting on.
 * A passing test is not verification that a UI reads correctly.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(240_000);
test.skip(!process.env.CAPTURE, "set CAPTURE=1 to regenerate screenshots");

test("mobile drawer tabs", async ({ page }) => {
  mkdirSync("screenshots", { recursive: true });
  await blockPlateau(page);
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(7_000);
  await page.screenshot({ path: "screenshots/m1-closed.png" });

  await page.locator(".panels-toggle").click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/m2-tab-layers.png" });

  await page.getByRole("tab", { name: "3D建物" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/m3-tab-buildings.png" });

  await page.getByRole("tab", { name: "データ" }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/m4-tab-data.png" });

  await page.getByRole("tab", { name: "性能" }).click();
  // The rolling window needs frames before it can report percentiles.
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: "screenshots/m5-tab-performance.png" });
  // The V1.2 sections live below the fold of a 390x844 phone, and the whole point of
  // them is that a user can screenshot them into a bug report. Capture the scrolled
  // state too, or nobody sees whether SESSION and STABILITY actually fit.
  await page.locator(".right-stack").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "screenshots/m7-tab-performance-stability.png" });
});

/**
 * The one that backs the SSE claim.
 *
 * Mobile profile means screen-space error 16 instead of 12. That is a real reduction in
 * requested geometry, and the question it has to answer is visual: does west-Shinjuku
 * still read as separate towers, or has it flattened into a slab? A frame rate cannot
 * answer that, so this exists to be looked at.
 */
test("mobile CITY VIEW with buildings served", async ({ page }) => {
  await serveTestTileset(page);
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(7_000);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(16_000);
  await page.screenshot({ path: "screenshots/m6-cityview-buildings.png" });
});
