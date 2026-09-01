import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { blockPlateau } from "./helpers.js";
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(200_000);
test.skip(!process.env.CAPTURE, "set CAPTURE=1 to regenerate screenshots");

test("mobile drawer", async ({ page }) => {
  mkdirSync("screenshots", { recursive: true });
  await blockPlateau(page);
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: "screenshots/m1-closed.png" });

  await page.locator(".panels-toggle").click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/m2-drawer-top.png" });

  await page.locator(".right-stack").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "screenshots/m3-drawer-bottom.png" });
});
