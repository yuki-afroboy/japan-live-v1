import { expect, test } from "@playwright/test";
import {
  blockPlateau,
  captureFrame,
  frameDiffRatio,
  measureDrift,
  readXrayState,
} from "./helpers.js";

/**
 * Does the scene actually DRAW anything?
 *
 * Every other test can pass against a completely black canvas — the UI is HTML and
 * renders regardless. This one samples the WebGL buffer, because "the globe is
 * invisible" is a failure mode that looks identical to success from the DOM.
 *
 * `?debug=1` turns on preserveDrawingBuffer so the pixels can be read back.
 *
 * These are the slowest tests in the suite and the deadline is sized for that. The
 * reason is structural, not a bug being papered over: JAPAN LIVE drives a continuous
 * render loop while trains are moving (that IS the product), and on CI's software
 * rasteriser the main thread never goes idle, so every Playwright action competes with
 * a fully loaded event loop. The separate problem that actually broke CI — non-building
 * tests downloading real PLATEAU tiles — is fixed in `blockPlateau`, not here.
 */
test.setTimeout(150_000);

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
  // This file is about rail, trains and X-Ray. Letting it fetch real PLATEAU tiles
  // saturated the software rasteriser in CI until clicks could not settle and the
  // suite timed out; buildings have their own file.
  await blockPlateau(page);
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
  await page.waitForTimeout(7_000);

  // How much does the frame change on its own? Trains never stop moving — that is the
  // product — so this is the floor any layer change has to clear. Without the control,
  // `diff > 0.01` passes on animation alone and proves nothing about the rail layers.
  const drift = await measureDrift(page, 2_500);

  await captureFrame(page, "rail-on");
  await page.getByRole("button", { name: "鉄道路線 Railways" }).click();
  await page.getByRole("button", { name: "駅 Stations" }).click();
  await page.getByRole("button", { name: "列車 Trains" }).click();
  await page.waitForTimeout(2_500);
  await captureFrame(page, "rail-off");

  const change = await frameDiffRatio(page, "rail-on", "rail-off");
  expect(
    change,
    `removing rail, stations and trains changed the frame no more than motion alone ` +
      `(change ${change.toFixed(3)} vs drift ${drift.toFixed(3)})`,
  ).toBeGreaterThan(drift * 1.5);
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

test("X-Ray changes the scene, and changes the state it is supposed to", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "新宿", exact: true }).click();
  await page.waitForTimeout(7_000);

  // X-Ray makes the globe translucent so the underground network reads through it.
  // Asserting that directly is deterministic; asserting on pixels alone is not,
  // because trains move whether or not X-Ray does anything.
  const before = await readXrayState(page);
  expect(before.translucencyEnabled).toBe(false);

  const drift = await measureDrift(page, 2_500);
  await captureFrame(page, "xray-off");

  await page.getByRole("button", { name: "地下鉄 X-RAY" }).click();
  await page.waitForTimeout(2_500);
  await captureFrame(page, "xray-on");

  const after = await readXrayState(page);
  expect(after.translucencyEnabled).toBe(true);
  expect(after.frontFaceAlpha).toBeLessThan(before.frontFaceAlpha);

  const change = await frameDiffRatio(page, "xray-off", "xray-on");
  expect(
    change,
    `X-Ray changed the frame no more than motion alone ` +
      `(change ${change.toFixed(3)} vs drift ${drift.toFixed(3)})`,
  ).toBeGreaterThan(drift * 1.2);
});
