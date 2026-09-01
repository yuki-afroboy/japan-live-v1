import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Shared test scaffolding.
 *
 * The important one is `blockPlateau`. CI runners have open network, so any test that
 * flies the camera low over Tokyo downloads real PLATEAU building tiles for up to ten
 * wards and decodes them on a software rasteriser. That saturates the main thread,
 * which makes Playwright's actionability checks (visible AND stable across two frames)
 * unable to settle — so clicks time out and cumulative test time blows past the
 * deadline. Only the building tests need real tiles; everything else blocks them.
 *
 * This is test-side isolation only. No production behaviour is changed: the app still
 * requests PLATEAU exactly as it does for a user, and simply sees the requests fail,
 * which is a path it already handles and reports.
 */

/** Every host the building layer may talk to. */
const PLATEAU_PATTERNS = [
  "**/datacatalog/3dtiles/**",
  "**/api.plateauview.mlit.go.jp/**",
  "**/api.plateau.reearth.io/**",
  "**/assets.cms.plateau.reearth.io/**",
];

/**
 * Make PLATEAU unreachable for this page.
 *
 * Requests are aborted rather than delayed, so the layer fails fast and reports the
 * failure instead of holding the frame. Use in every test that is not about buildings.
 */
export async function blockPlateau(page: Page): Promise<void> {
  for (const pattern of PLATEAU_PATTERNS) {
    await page.route(pattern, (route) => route.abort());
  }
}

const TILESET = JSON.parse(
  readFileSync(resolve(HERE, "fixtures/tileset/tileset.json"), "utf8"),
);
const GLB = readFileSync(resolve(HERE, "fixtures/tileset/buildings.glb"));

/**
 * Serve the generated west-Shinjuku fixture in place of PLATEAU, so the building
 * pipeline is exercised against real 3D Tiles without depending on a third party.
 */
export async function serveTestTileset(
  page: Page,
  options: { failStatus?: number } = {},
): Promise<void> {
  // ORDER MATTERS. Playwright matches the most recently registered route first, and a
  // manifest URL is https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/… which
  // matches both patterns below. The host-wide block goes first so the fixture route,
  // registered after it, wins.
  for (const pattern of PLATEAU_PATTERNS.slice(1)) {
    await page.route(pattern, (route) => route.abort());
  }

  await page.route("**/datacatalog/3dtiles/**", async (route) => {
    if (options.failStatus) {
      await route.fulfill({ status: options.failStatus, body: "upstream error" });
      return;
    }
    const url = route.request().url();
    if (url.endsWith(".glb")) {
      await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: GLB });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TILESET),
    });
  });
  await page.route("**/*.glb", (route) =>
    route.fulfill({ status: 200, contentType: "model/gltf-binary", body: GLB }),
  );
}

export interface FrameStats {
  lit: number;
  distinctColors: number;
}

/**
 * Force a render, then capture the frame into the page for later comparison.
 *
 * The scene renders on demand, so without an explicit request this samples whatever
 * was last drawn, which may be nothing.
 */
export async function captureFrame(page: Page, slot: string): Promise<FrameStats> {
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(600);
  return page.evaluate((key: string) => {
    const source = document.querySelector(".cesium-widget canvas") as HTMLCanvasElement;
    const off = document.createElement("canvas");
    off.width = 320;
    off.height = 200;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(source, 0, 0, off.width, off.height);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;

    const store = ((window as any).__frames ??= {});
    store[key] = Array.from(data);

    let lit = 0;
    const colors = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! + data[i + 1]! + data[i + 2]! > 45) lit++;
      colors.add(((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3));
    }
    return { lit: lit / (data.length / 4), distinctColors: colors.size };
  }, slot);
}

/**
 * Fraction of pixels that differ meaningfully between two captured frames.
 *
 * Direction-agnostic on purpose. Counting distinct colours is not: a large flat-shaded
 * mass can REDUCE the palette by occluding a more varied background, which is exactly
 * how a working skyline failed an "it must add colours" assertion.
 */
export async function frameDiffRatio(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    ([keyA, keyB]: [string, string]) => {
      const store = (window as any).__frames ?? {};
      const first: number[] = store[keyA];
      const second: number[] = store[keyB];
      if (!first || !second || first.length !== second.length) return -1;
      let changed = 0;
      const pixels = first.length / 4;
      for (let i = 0; i < first.length; i += 4) {
        const d =
          Math.abs(first[i]! - second[i]!) +
          Math.abs(first[i + 1]! - second[i + 1]!) +
          Math.abs(first[i + 2]! - second[i + 2]!);
        if (d > 24) changed++;
      }
      return changed / pixels;
    },
    [a, b] as [string, string],
  );
}

export interface GeometryProbe {
  /** Screen samples that landed on 3D Tiles geometry. */
  tileHits: number;
  samples: number;
  /** Highest surface height found, in metres above the ellipsoid. */
  maxHeight: number;
  pickPositionSupported: boolean;
}

/**
 * Probe for actual 3D geometry under the pixels.
 *
 * This is the assertion that matters: `pick` says a tileset is genuinely under the
 * cursor, and `pickPosition` says the surface there stands well above ground. Together
 * they establish that buildings exist as geometry with vertical extent — which no
 * summary of the colour histogram can.
 */
export async function probeGeometry(page: Page): Promise<GeometryProbe> {
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    const scene = viewer.scene;
    const canvas = viewer.canvas;

    let tileHits = 0;
    let samples = 0;
    let maxHeight = -Infinity;

    // A grid across the middle of the frame, avoiding the HUD at the edges.
    for (let ix = 2; ix <= 8; ix++) {
      for (let iy = 2; iy <= 8; iy++) {
        const x = (canvas.clientWidth * ix) / 10;
        const y = (canvas.clientHeight * iy) / 10;
        const position = new Cesium.Cartesian2(x, y);
        samples++;

        const picked = scene.pick(position);
        const primitive = picked?.primitive;
        const isTileset =
          (primitive && "maximumScreenSpaceError" in primitive) ||
          (picked && typeof picked.getProperty === "function");
        if (isTileset) tileHits++;

        if (scene.pickPositionSupported) {
          const cartesian = scene.pickPosition(position);
          if (Cesium.defined(cartesian)) {
            const height = Cesium.Cartographic.fromCartesian(cartesian).height;
            if (Number.isFinite(height)) maxHeight = Math.max(maxHeight, height);
          }
        }
      }
    }

    return {
      tileHits,
      samples,
      maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
      pickPositionSupported: Boolean(scene.pickPositionSupported),
    };
  });
}
