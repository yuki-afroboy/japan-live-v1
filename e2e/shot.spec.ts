import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { serveTestTileset } from "./helpers.js";

test.setTimeout(200000);
test.skip(!process.env.CAPTURE, "set CAPTURE=1 to regenerate screenshots");

test("shot", async ({ page }) => {
  mkdirSync("screenshots", { recursive: true });
  await serveTestTileset(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45000 });
  await page.waitForTimeout(5000);
  await page.getByRole("button", { name: "CITY VIEW" }).click();
  await page.waitForTimeout(14000);
  await page.screenshot({ path: "screenshots/v11-cityview.png" });
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(13000);
  await page.screenshot({ path: "screenshots/v11-shinjuku.png" });
});
