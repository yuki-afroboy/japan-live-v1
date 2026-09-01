import { expect, test } from "@playwright/test";

/**
 * Does the scene actually DRAW anything?
 *
 * Every other test can pass against a completely black canvas — the UI is HTML and
 * renders regardless. This one samples the WebGL buffer, because "the globe is
 * invisible" is a failure mode that looks identical to success from the DOM.
 *
 * `?debug=1` turns on preserveDrawingBuffer so the pixels can be read back.
 */

interface Coverage {
  lit: number;
  distinctColors: number;
}

async function sample(page: import("@playwright/test").Page): Promise<Coverage> {
  // The scene renders on demand, so force a frame before reading the buffer —
  // otherwise this samples whatever was last drawn, which may be nothing.
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(600);

  return page.evaluate(() => {
    const source = document.querySelector(".cesium-widget canvas") as HTMLCanvasElement;
    const off = document.createElement("canvas");
    off.width = Math.min(source.width, 640);
    off.height = Math.min(source.height, 400);
    const ctx = off.getContext("2d")!;
    ctx.drawImage(source, 0, 0, off.width, off.height);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;

    let lit = 0;
    const colors = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r + g + b > 45) lit++;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    return { lit: lit / (data.length / 4), distinctColors: colors.size };
  });
}

async function boot(page: import("@playwright/test").Page) {
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(6_000);
}

test("the globe is visible even with no imagery available", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "日本", exact: true }).click();
  await page.waitForTimeout(9_000);

  const { lit } = await sample(page);
  // Almost the whole frame is Earth at this altitude. Near zero means we are drawing
  // space, which is what a failed globe looks like.
  //
  // Only brightness is asserted, not detail: with no imagery and no terrain — the
  // documented fallback, and the state of the build container — a correctly rendered
  // globe IS a single flat colour. Detail is asserted at city scale below.
  expect(lit).toBeGreaterThan(0.5);
});

test("the scene gains detail as the camera descends", async ({ page }) => {
  await boot(page);

  await page.getByRole("button", { name: "東京", exact: true }).click();
  await page.waitForTimeout(8_000);
  const city = await sample(page);

  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(8_000);
  const street = await sample(page);

  // Rail lines, stations and trains are the only things adding colour here, so more
  // detail closer in means they are genuinely being drawn.
  expect(city.distinctColors).toBeGreaterThan(10);
  expect(street.distinctColors).toBeGreaterThan(city.distinctColors);
});

test("the rail network is drawn over Tokyo", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(9_000);

  const withRail = await sample(page);

  await page.getByRole("button", { name: "鉄道路線 Railways" }).click();
  await page.getByRole("button", { name: "駅 Stations" }).click();
  await page.getByRole("button", { name: "列車 Trains" }).click();
  await page.waitForTimeout(3_000);
  const without = await sample(page);

  // Turning the rail layers off must visibly change the frame; if it does not,
  // they were never being drawn.
  expect(withRail.distinctColors).toBeGreaterThan(without.distinctColors);
});

test("trains are drawn at the Kanto scale, not only close in", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "関東", exact: true }).click();
  await page.waitForTimeout(8_000);

  // Spec §18: Kanto shows small points, not the nationwide aggregate view.
  const stats = await page.locator(".stats").innerText();
  expect(stats).toContain("point");
  expect(stats).not.toContain("aggregate");
});

test("X-Ray visibly changes the scene", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(8_000);
  const before = await sample(page);

  await page.getByRole("button", { name: "地下鉄 X-RAY" }).click();
  await page.waitForTimeout(4_000);
  const after = await sample(page);

  expect(Math.abs(after.lit - before.lit) + Math.abs(after.distinctColors - before.distinctColors)).toBeGreaterThan(0);
});
