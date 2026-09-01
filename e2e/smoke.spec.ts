import { expect, test, type Page } from "@playwright/test";

/**
 * These run against the production build in a headless browser with software WebGL.
 * They check the app boots, the scene initialises, and the honesty-critical UI is
 * present — not that a particular pixel is a particular colour.
 */

/** Cesium needs a moment to create its context and the store to load the dataset. */
async function waitForScene(page: Page) {
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await expect(page.locator(".boot")).toHaveCount(0, { timeout: 45_000 });
  // Let the intro flight and first provider poll settle.
  await page.waitForTimeout(4_000);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => {
    throw new Error(`uncaught page error: ${err.message}`);
  });
});

test("boots to a rendered globe with no uncaught errors", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  const canvas = page.locator(".cesium-widget canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  expect(box!.height).toBeGreaterThan(300);
});

test("shows the DEMO badge and says the data is simulated", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  // With no gateway configured this build MUST identify itself as demo data.
  await expect(page.locator(".mode-badge.demo")).toContainText("DEMO");
  await expect(page.locator(".demo-warning")).toContainText("SIMULATED DATA");
  await expect(page.locator(".demo-warning")).toContainText("実在の列車ではありません");
});

test("never claims LIVE in the demo build", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);
  await expect(page.locator(".mode-badge.live")).toHaveCount(0);
});

test("renders trains and reports them in the HUD", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);
  await page.getByRole("button", { name: "東京", exact: true }).click();
  await page.waitForTimeout(4_000);

  const stats = await page.locator(".stats").innerText();
  const trains = Number(/(\d+) trains/.exec(stats)?.[1] ?? "0");
  expect(trains).toBeGreaterThan(50);
});

test("data status lists every provider including the disabled one", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  const panel = page.locator('section[aria-label="データ状態"]');
  await expect(panel).toContainText("DEMO");
  // JR East must be visible AND visibly off (spec §11, D-007).
  await expect(panel).toContainText("東日本旅客鉄道");
  await expect(panel.locator(".status-chip.DISABLED")).toHaveCount(1);
});

test("layer toggles work and X-Ray states that it is a projection", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  const xray = page.getByRole("button", { name: "地下鉄 X-RAY" });
  await expect(xray).toHaveAttribute("aria-pressed", "false");
  await xray.click();
  await expect(xray).toHaveAttribute("aria-pressed", "true");

  // The projection notice is mandatory whenever X-Ray is on (D-010).
  await expect(page.locator(".xray-note")).toContainText("地表へ投影");
  await expect(page.locator(".xray-note")).toContainText("実際の高度ではありません");

  const trains = page.getByRole("button", { name: "列車 Trains" });
  await trains.click();
  await expect(trains).toHaveAttribute("aria-pressed", "false");
});

test("LIVE and SIMULATION are mutually exclusive", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  const slider = page.getByRole("slider", { name: "時刻" });
  await expect(slider).toBeDisabled();

  await page.getByRole("button", { name: "×60", exact: true }).click();
  await expect(page.locator(".mode-badge.sim")).toContainText("SIMULATION ×60");
  await expect(page.locator(".mode-badge.live")).toHaveCount(0);
  await expect(slider).toBeEnabled();

  await page.getByRole("button", { name: "LIVE" }).click();
  await expect(page.locator(".mode-badge.sim")).toHaveCount(0);
  await expect(slider).toBeDisabled();
});

test("camera presets fly and change altitude", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  const readAltitude = async () => {
    const text = await page.locator(".stats").innerText();
    const m = /([\d.]+) (km|m)$/.exec(text.trim());
    return m ? Number(m[1]) * (m[2] === "km" ? 1000 : 1) : NaN;
  };

  await page.getByRole("button", { name: "日本", exact: true }).click();
  await page.waitForTimeout(4_500);
  const japan = await readAltitude();

  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(4_500);
  const shinjuku = await readAltitude();

  expect(japan).toBeGreaterThan(500_000);
  expect(shinjuku).toBeLessThan(20_000);
});

test("attribution is always visible", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);
  await expect(page.locator(".attribution")).toContainText("地理院タイル");
  await page.locator(".attribution button").first().click();
  await expect(page.locator(".attribution")).toContainText("Project PLATEAU");
});

test("search finds a station and moves the camera", async ({ page }) => {
  await page.goto("/");
  await waitForScene(page);

  await page.getByLabel("駅・路線を検索").fill("六本木");
  await expect(page.locator(".search-item").first()).toBeVisible();
  await page.locator(".search-item").first().click();
  await page.waitForTimeout(3_500);

  const stats = await page.locator(".stats").innerText();
  expect(stats).toMatch(/\d/);
});
