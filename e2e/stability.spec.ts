import { test, expect } from "@playwright/test";
import { blockPlateau } from "./helpers.js";

/**
 * The reload record has to survive the thing it is recording.
 *
 * A page killed by iOS runs none of our code on the way out, so every fact about the
 * crash has to already be in storage before it happens. These tests exercise the two
 * halves of that: a record written by one page load is read by the next, and a WebGL
 * context loss — the failure that turns the map permanently blank — is observed rather
 * than silently swallowed.
 *
 * Not a performance test. Deterministic, and part of `npm run e2e`.
 */

async function stability(page: import("@playwright/test").Page): Promise<any> {
  return page.evaluate(() => (window as any).__perf?.()?.stability);
}

test.describe("stability record", () => {
  test("a reload can see how long the previous page lived", async ({ page }) => {
    await blockPlateau(page);
    await page.goto("/?debug=1");
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });

    const first = await stability(page);
    expect(first.sessionId).toBeTruthy();
    // Nothing ran before this page, or a previous test did; either way this page's own
    // record is what the next load must be able to read.
    await page.waitForTimeout(3_000);

    await page.reload();
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
    const second = await stability(page);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.previous).toBeTruthy();
    expect(second.previous.id).toBe(first.sessionId);
    // The heartbeat is what makes uptime survive a kill; without it this is 0.
    expect(second.previous.uptimeMs).toBeGreaterThan(1_000);
    // A deliberate reload gives the page a pagehide, so it must NOT be counted as an
    // unexpected restart — otherwise the counter reports noise instead of crashes.
    expect(second.previous.closedCleanly).toBe(true);
    expect(second.navigationType).toBe("reload");
  });

  test("a WebGL context loss is recorded rather than silently blanking the map", async ({
    page,
  }) => {
    await blockPlateau(page);
    await page.goto("/?debug=1");
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const before = await stability(page);
    expect(before.contextLost).toBe(false);

    // WEBGL_lose_context is the standard way to simulate what the OS does to a tab
    // under memory pressure. Without a handler this event passes unobserved and the
    // canvas simply stops drawing.
    await page.evaluate(() => {
      const canvas = (window as any).__viewer.canvas as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      (gl as any).getExtension("WEBGL_lose_context").loseContext();
    });
    await page.waitForTimeout(1_500);

    const after = await stability(page);
    expect(after.contextLosses).toBe(before.contextLosses + 1);
    expect(after.contextLost).toBe(true);
    expect(after.log.some((e: { kind: string }) => e.kind === "webgl-lost")).toBe(true);
  });

  test("the panel reports the WebGL context the scene is actually using", async ({ page }) => {
    await blockPlateau(page);
    await page.goto("/?debug=1");
    await page.waitForSelector(".cesium-widget canvas", { timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const webgl = (await stability(page)).webgl;
    expect(["webgl1", "webgl2"]).toContain(webgl.version);
    expect(webgl.maxTextureSize).toBeGreaterThan(0);
    // Cesium asks for a stencil buffer by default and its 3D Tiles selection depends
    // on one. A context without it is worth knowing about before the buildings look wrong.
    expect(webgl.stencilBits).toBeGreaterThanOrEqual(8);
    expect(webgl.drawingBuffer).toMatch(/^\d+x\d+$/);
  });
});
