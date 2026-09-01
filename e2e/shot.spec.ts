import { test } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const TILESET = JSON.parse(readFileSync(resolve(HERE, "fixtures/tileset/tileset.json"), "utf8"));
const GLB = readFileSync(resolve(HERE, "fixtures/tileset/buildings.glb"));
test.setTimeout(200000);
test("shot", async ({ page }) => {
  mkdirSync("screenshots", { recursive: true });
  await page.route("**/datacatalog/3dtiles/**", async (r) => {
    const u = r.request().url();
    if (u.endsWith(".glb")) return r.fulfill({ status: 200, contentType: "model/gltf-binary", body: GLB });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TILESET) });
  });
  await page.route("**/*.glb", (r) => r.fulfill({ status: 200, contentType: "model/gltf-binary", body: GLB }));
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
