import { test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { serveLodTileset, setCamera, toggleLayer, withDrawer } from "./helpers.js";

/**
 * Where are the long frames?
 *
 * The device report that opened V1.2 was bimodal: median 17 ms — a smooth 59 fps —
 * against a p95 of 157 ms. That is not a slow app, it is a fast app with stalls in it,
 * and an average cannot see the difference. So this measures the DISTRIBUTION, and
 * splits each frame into Cesium's update pass, our own layer code, and Cesium's draw,
 * because those three have completely different fixes.
 *
 * The suspected mechanism, read out of the installed Cesium 1.144:
 * `Cesium3DTileset.prePassesUpdate` calls `processTiles`, which walks the whole
 * processing queue parsing and uploading every downloaded tile. It runs from
 * `Scene.render` on EVERY animation frame regardless of `requestRenderMode`, and it
 * has no time budget — its only exit is the memory cap. So the number of tiles that
 * can finish downloading at the same moment sets how long one frame can get, and the
 * only handle on that is `RequestScheduler.maximumRequests`.
 *
 * The two arms below are exactly that handle. Everything else is identical: same
 * build, same fixture, same camera, same tile bytes.
 *
 * CI caveat, unchanged: SwiftShader, no GPU. Absolute milliseconds are not an iPhone
 * prediction. What transfers is which span the time lands in, and whether the cap moves it.
 *
 *   PERF=1 npx playwright test e2e/stall-isolation.spec.ts
 */

test.skip(!process.env.PERF, "set PERF=1 to run the stall isolation measurement");

const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS ?? 10_000);

const NISHI_SHINJUKU = { lon: 139.6889, lat: 35.6858, height: 620, heading: 28, pitch: -22 };
const TOSHIMA = { lon: 139.703, lat: 35.699, height: 700, heading: 200, pitch: -26 };

/**
 * Leaf tiles with enough geometry that parsing one is not free.
 *
 * The committed 4 KB fixture cannot produce a processing stall no matter how many
 * arrive at once, so measuring against it would have "proved" there is no problem.
 */
const HEAVY_SPACING: [number, number, number] = [300, 80, 12];

interface Reading {
  scenario: string;
  fps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  long33: number;
  long50: number;
  long100: number;
  frames: number;
  cesium: Record<string, number>;
  worst: Record<string, number> | null;
  tiles: Record<string, number>;
  cpuTotal: number;
}

async function read(page: Page, scenario: string): Promise<Reading> {
  const raw = (await page.evaluate(() => (window as any).__perf?.())) as any;
  if (!raw) throw new Error(`__perf unavailable while measuring ${scenario}`);
  const reading: Reading = {
    scenario,
    fps: raw.fps,
    medianFrameMs: raw.medianFrameMs,
    p95FrameMs: raw.p95FrameMs,
    p99FrameMs: raw.p99FrameMs,
    maxFrameMs: raw.maxFrameMs,
    long33: raw.long33,
    long50: raw.long50,
    long100: raw.long100,
    frames: raw.frames,
    cesium: raw.cesium,
    worst: raw.worst,
    tiles: raw.tiles,
    cpuTotal: raw.cpu.total,
  };
  console.log(
    `[STALL] ${scenario.padEnd(34)} ` +
      `med ${reading.medianFrameMs.toFixed(1).padStart(7)} ` +
      `p95 ${reading.p95FrameMs.toFixed(1).padStart(7)} ` +
      `p99 ${reading.p99FrameMs.toFixed(1).padStart(7)} ` +
      `max ${reading.maxFrameMs.toFixed(1).padStart(7)}  ` +
      `>50 ${String(reading.long50).padStart(4)} >100 ${String(reading.long100).padStart(4)}  ` +
      `upd p95 ${reading.cesium.updateP95Ms!.toFixed(1).padStart(7)} max ${reading.cesium.updateMaxMs!.toFixed(1).padStart(7)}  ` +
      `draw p95 ${reading.cesium.renderP95Ms!.toFixed(1).padStart(7)} max ${reading.cesium.renderMaxMs!.toFixed(1).padStart(7)}  ` +
      `long50 upd/draw ${reading.cesium.updateLong50}/${reading.cesium.renderLong50}  ` +
      `proc ${reading.tiles.tilesProcessing} pend ${reading.tiles.pendingRequests} ` +
      `mem ${reading.tiles.memoryMb!.toFixed(0)}MB`,
  );
  return reading;
}

/** A real drag: a synthetic camera nudge does not go through the input controller. */
async function orbit(page: Page, durationMs: number): Promise<void> {
  const box = await page.locator(".cesium-widget canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await page.mouse.move(cx - 80, cy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(cx - 80 + i * 7, cy + Math.sin(i / 4) * 10);
    }
    await page.mouse.up();
  }
}

async function runArm(browser: Browser, label: string, search: string): Promise<Reading[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const readings: Reading[] = [];
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const served = await serveLodTileset(page, { spacing: HEAVY_SPACING });
    console.log(`[STALL] ${label}: fixture ${served.tiles} tiles, ${(served.totalBytes / 1e6).toFixed(1)} MB`);

    await page.goto(`/?debug=1&${search}`);
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
    await page.waitForTimeout(3_000);

    // 1. The camera arrives and tiles stream in. This is the window the device's p95
    //    came from: the app is not idle, it is ingesting.
    await setCamera(page, NISHI_SHINJUKU);
    await page.waitForTimeout(SAMPLE_MS);
    readings.push(await read(page, `${label} / 1. tile loading`));

    // 2. Everything has arrived; only the trains move.
    await page.waitForTimeout(15_000);
    await page.waitForTimeout(SAMPLE_MS);
    readings.push(await read(page, `${label} / 2. settled`));

    // 3. Continuous camera input over tiles that are already resident.
    await orbit(page, SAMPLE_MS);
    readings.push(await read(page, `${label} / 3. settled + camera moving`));

    // 4-5: the settled camera with one layer subtracted, to keep the layer question
    //      answerable in the same run.
    await withDrawer(page, () => toggleLayer(page, "3D建物 Buildings"));
    await page.waitForTimeout(SAMPLE_MS);
    readings.push(await read(page, `${label} / 4. settled − buildings`));
    await withDrawer(page, () => toggleLayer(page, "3D建物 Buildings"));
    await page.waitForTimeout(6_000);

    await withDrawer(page, () => toggleLayer(page, "列車 Trains"));
    await page.waitForTimeout(SAMPLE_MS);
    readings.push(await read(page, `${label} / 5. settled − trains`));
    await withDrawer(page, () => toggleLayer(page, "列車 Trains"));
    await page.waitForTimeout(4_000);

    // 6. A second load burst somewhere new, so the first is not taken for a warm-up.
    await setCamera(page, TOSHIMA);
    await page.waitForTimeout(SAMPLE_MS);
    readings.push(await read(page, `${label} / 6. second load burst`));

    return readings;
  } finally {
    await context.close();
  }
}

test("long-frame isolation: request cap A/B over heavy tiles", async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  mkdirSync("perf", { recursive: true });

  // Cesium's own default is 50 simultaneous requests, 18 per server: effectively
  // "as many tiles as the network will give you, all landing in the same frame".
  const uncapped = await runArm(browser, "req50", "req=50&reqserver=18");
  const capped = await runArm(browser, "req6", "req=6&reqserver=6");

  writeFileSync(
    `perf/stalls-${process.env.PERF_LABEL ?? "ab"}.json`,
    JSON.stringify({ sampleMs: SAMPLE_MS, spacing: HEAVY_SPACING, uncapped, capped }, null, 2),
  );
});
