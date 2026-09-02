import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { serveTestTileset, toggleLayer } from "./helpers.js";

/**
 * Performance measurement, not a pass/fail test.
 *
 * READ THIS BEFORE QUOTING ANY NUMBER FROM HERE.
 *
 * This runs on a headless Chromium with SwiftShader — a SOFTWARE rasteriser, no GPU.
 * The absolute frame rates it produces are not a prediction of anything an iPhone
 * does, in either direction: software rendering is far slower than a mobile GPU at
 * fragment work, and far less sensitive to some of the things that hurt a tiler.
 *
 * What it IS good for: comparing this build against the previous one under identical
 * conditions, and telling us which SCENARIO is expensive relative to the others. A
 * change that halves the work here is doing less work everywhere.
 *
 * The numbers that decide whether the product is pleasant to use come from the
 * PERFORMANCE panel on a real device.
 *
 * Excluded from `npm run e2e` on purpose — it takes minutes and asserts nothing.
 * Run with:  PERF=1 npx playwright test e2e/perf-baseline.spec.ts
 */

test.skip(!process.env.PERF, "set PERF=1 to run the performance measurement");
test.setTimeout(20 * 60_000);

const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS ?? 12_000);
const LABEL = process.env.PERF_LABEL ?? "baseline";

interface Reading {
  scenario: string;
  viewport: string;
  fps: number;
  avgFrameMs: number;
  medianFrameMs: number;
  p95FrameMs: number;
  long33: number;
  long50: number;
  long100: number;
  p99FrameMs: number;
  maxFrameMs: number;
  frames: number;
  windowMs: number;
  rafPerSec: number;
  renderRequestsPerSec: number;
  cpu: { train: number; rail: number; buildings: number; follow: number; total: number };
  cesium: {
    updateAvgMs: number;
    updateP95Ms: number;
    updateMaxMs: number;
    renderAvgMs: number;
    renderP95Ms: number;
    renderMaxMs: number;
    updateLong50: number;
    renderLong50: number;
    samples: number;
  };
  trains: number;
  trainLod: string;
  wardsLoaded: number;
  tilesetsLoaded: number;
  altitude: number;
  resolutionScale: number;
  devicePixelRatio: number;
  tier: string;
}

async function boot(page: Page): Promise<void> {
  await serveTestTileset(page);
  await page.goto("/?debug=1");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
  // Let the intro finish and the first tiles settle before anything is timed.
  await page.waitForTimeout(9_000);
}

/** On a phone the layer controls live behind a toggle; open it once, up front. */
async function openPanels(page: Page): Promise<void> {
  const toggle = page.locator(".panels-toggle");
  if (await toggle.isVisible()) await toggle.click();
}

async function flyTo(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  // The flight itself is 2.6 s; the rest is tile loading, which must not be inside
  // the measurement window or we would be timing the network fixture.
  await page.waitForTimeout(11_000);
}

/** Reset the window, wait a full window, then read. */
async function measure(page: Page, scenario: string): Promise<Reading> {
  await page.waitForTimeout(SAMPLE_MS);
  const raw = (await page.evaluate(() => (window as any).__perf?.())) as Reading | undefined;
  if (!raw) throw new Error(`__perf unavailable while measuring ${scenario}`);
  const reading: Reading = { ...raw, scenario, viewport: (raw as any).viewport };
  console.log(
    `[PERF] ${scenario.padEnd(34)} ${reading.fps.toFixed(1).padStart(5)} fps  ` +
      `med ${reading.medianFrameMs.toFixed(1).padStart(6)}ms  ` +
      `p95 ${reading.p95FrameMs.toFixed(1).padStart(6)}ms  ` +
      `p99 ${reading.p99FrameMs.toFixed(1).padStart(6)}ms  ` +
      `>33 ${String(reading.long33).padStart(4)}  >50 ${String(reading.long50).padStart(4)}  ` +
      `>100 ${String(reading.long100).padStart(4)}  ` +
      `upd p95 ${reading.cesium.updateP95Ms.toFixed(1).padStart(6)}  ` +
      `draw p95 ${reading.cesium.renderP95Ms.toFixed(1).padStart(6)}  ` +
      `cpu ${reading.cpu.total.toFixed(2).padStart(6)}ms ` +
      `(tr ${reading.cpu.train.toFixed(2)} ra ${reading.cpu.rail.toFixed(2)} bu ${reading.cpu.buildings.toFixed(2)})  ` +
      `trains ${String(reading.trains).padStart(3)} (${reading.trainLod})  ` +
      `wards ${reading.wardsLoaded}  rs ${reading.resolutionScale}`,
  );
  return reading;
}

for (const viewport of [
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "desktop-1280x800", width: 1280, height: 800 },
]) {
  test(`performance sweep — ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await boot(page);
    await openPanels(page);

    const readings: Reading[] = [];

    // 1-3: the standard camera presets, coarse to fine.
    await flyTo(page, "東京");
    readings.push(await measure(page, "1. 東京広域 (42km)"));

    await flyTo(page, "東京駅");
    readings.push(await measure(page, "2. 東京駅 (850m)"));

    await flyTo(page, "新宿");
    readings.push(await measure(page, "3. 新宿 (900m)"));

    // 4: the view the product is judged on.
    await flyTo(page, "CITY VIEW");
    readings.push(await measure(page, "4. CITY VIEW"));

    // 5-8: the same camera with layers subtracted, which is how a bottleneck is
    // attributed to a layer rather than guessed at.
    await toggleLayer(page, "3D建物 Buildings");
    await page.waitForTimeout(3_000);
    readings.push(await measure(page, "5. CITY VIEW − buildings"));
    await toggleLayer(page, "3D建物 Buildings");
    await page.waitForTimeout(6_000);

    await toggleLayer(page, "列車 Trains");
    await page.waitForTimeout(3_000);
    readings.push(await measure(page, "6. CITY VIEW − trains"));
    await toggleLayer(page, "列車 Trains");
    await page.waitForTimeout(3_000);

    await toggleLayer(page, "鉄道路線 Railways");
    await toggleLayer(page, "駅 Stations");
    await page.waitForTimeout(3_000);
    readings.push(await measure(page, "7. CITY VIEW − rail/stations"));
    await toggleLayer(page, "鉄道路線 Railways");
    await toggleLayer(page, "駅 Stations");
    await page.waitForTimeout(3_000);

    await toggleLayer(page, "3D建物 Buildings");
    await toggleLayer(page, "列車 Trains");
    await page.waitForTimeout(3_000);
    readings.push(await measure(page, "8. CITY VIEW − buildings − trains"));

    mkdirSync("perf", { recursive: true });
    writeFileSync(
      `perf/${LABEL}-${viewport.name}.json`,
      JSON.stringify({ label: LABEL, viewport: viewport.name, sampleMs: SAMPLE_MS, readings }, null, 2),
    );
  });
}
