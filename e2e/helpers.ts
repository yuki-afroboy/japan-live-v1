import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLodFixture, type LodFixtureOptions } from "./fixtures/lod-fixture.js";

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

const TILESET = JSON.parse(readFileSync(resolve(HERE, "fixtures/tileset/tileset.json"), "utf8"));
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
      await route.fulfill({
        status: options.failStatus,
        body: "upstream error",
      });
      return;
    }
    const url = route.request().url();
    if (url.endsWith(".glb")) {
      await route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        body: GLB,
      });
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

/**
 * Serve the three-level REPLACE hierarchy instead of the flat fixture.
 *
 * `delayLeavesMs` holds back the level-2 content. That is not an artificial
 * pathology: it is what a phone on a slow connection sees for several seconds every
 * time the camera settles somewhere new, and it is the only state in which
 * `skipLevelOfDetail` changes what is drawn. Without it, everything resolves in
 * milliseconds on a local fixture and both arms of the A/B look identical.
 */
export async function serveLodTileset(
  page: Page,
  options: { delayLeavesMs?: number; delayLeafFraction?: number } & LodFixtureOptions = {},
): Promise<{ totalBytes: number; tiles: number }> {
  const fixture = buildLodFixture({ spacing: options.spacing });
  const delay = options.delayLeavesMs ?? 0;
  // Delaying EVERY leaf produces no mixed content at all: nothing refines, so the
  // tileset just shows a coarse level. The interesting state — some descendants
  // resolved, their siblings and ancestors not — needs the delay to be uneven, which
  // is also what a real connection does.
  const delayFraction = options.delayLeafFraction ?? 1;

  for (const pattern of PLATEAU_PATTERNS.slice(1)) {
    await page.route(pattern, (route) => route.abort());
  }

  await page.route("**/datacatalog/3dtiles/**", async (route) => {
    const url = route.request().url();
    const file = url.split("/").pop()?.split("?")[0] ?? "";

    const body = fixture.content.get(file);
    if (body) {
      if (delay > 0 && file.startsWith("l2-") && shouldDelayLeaf(file, delayFraction)) {
        await new Promise((done) => setTimeout(done, delay));
      }
      await route.fulfill({ status: 200, contentType: "model/gltf-binary", body });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture.tileset),
    });
  });

  return { totalBytes: fixture.totalBytes, tiles: fixture.content.size };
}

/**
 * Run something that needs the layer controls, leaving the drawer as it was found.
 *
 * On a desktop viewport the toggle button is not rendered and the panels are always
 * on screen, so this is a no-op wrapper there.
 */
export async function withDrawer(page: Page, body: () => Promise<void>): Promise<void> {
  const toggle = page.locator(".panels-toggle");
  const needsOpening = (await toggle.isVisible()) && (await toggle.getAttribute("data-open")) !== "true";
  if (needsOpening) await toggle.click();
  await body();
  if (needsOpening) await toggle.click();
  await page.waitForTimeout(400);
}

/** Deterministic per-leaf choice, so both arms of an A/B hold back the same tiles. */
function shouldDelayLeaf(file: string, fraction: number): boolean {
  if (fraction >= 1) return true;
  if (fraction <= 0) return false;
  let hash = 0;
  for (const ch of file) hash = (hash * 31 + ch.charCodeAt(0)) % 1000;
  return hash / 1000 < fraction;
}

/**
 * How much of the frame the building layer actually paints, as a fraction of pixels.
 *
 * Measured as buildings-on against buildings-off at the SAME fixed camera with trains
 * switched off, so the only thing that can differ is the layer under test. That is not
 * the frame-to-frame diff D-015 rejected — nothing in the scene is moving — and it is
 * the only way to quantify "the buildings are see-through": a hole in the layer is
 * pixels the layer did not paint, and nothing else in the frame changes.
 *
 * Requires ?debug (preserveDrawingBuffer); returns 0..1.
 */
export async function measureBuildingCoverage(page: Page): Promise<number> {
  const grab = async (): Promise<string> => {
    await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
    await page.waitForTimeout(700);
    return page.evaluate(() => (window as any).__viewer.canvas.toDataURL("image/png"));
  };

  // Both captures are taken with the drawer CLOSED — on a phone it covers the whole
  // viewport, and a comparison made through it would be measuring the panel. The
  // toggle itself needs the drawer open, so it is opened and closed around each one.
  const withBuildings = await grab();
  await withDrawer(page, () => toggleLayer(page, "3D建物 Buildings"));
  await page.waitForTimeout(1_500);
  const withoutBuildings = await grab();
  await withDrawer(page, () => toggleLayer(page, "3D建物 Buildings"));
  await page.waitForTimeout(1_500);

  return page.evaluate(
    async ([a, b]) => {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((done, fail) => {
          const img = new Image();
          img.onload = () => done(img);
          img.onerror = fail;
          img.src = src;
        });
      const [imgA, imgB] = await Promise.all([load(a!), load(b!)]);
      const w = imgA.width;
      const h = imgA.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(imgA, 0, 0);
      const pixelsA = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(imgB, 0, 0);
      const pixelsB = ctx.getImageData(0, 0, w, h).data;

      let differing = 0;
      const total = w * h;
      for (let i = 0; i < total; i++) {
        const o = i * 4;
        const d =
          Math.abs(pixelsA[o]! - pixelsB[o]!) +
          Math.abs(pixelsA[o + 1]! - pixelsB[o + 1]!) +
          Math.abs(pixelsA[o + 2]! - pixelsB[o + 2]!);
        // 24 over three channels: well above encoder noise, well below the contrast
        // between a lit building face and the dark basemap behind it.
        if (d > 24) differing++;
      }
      return differing / total;
    },
    [withBuildings, withoutBuildings],
  );
}

/** Put the camera exactly where a screenshot can be reproduced from. */
export async function setCamera(
  page: Page,
  view: { lon: number; lat: number; height: number; heading: number; pitch: number },
): Promise<void> {
  await page.evaluate((v) => {
    const viewer = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height),
      orientation: {
        heading: Cesium.Math.toRadians(v.heading),
        pitch: Cesium.Math.toRadians(v.pitch),
        roll: 0,
      },
    });
    viewer.scene.requestRender();
  }, view);
}

/*
 * There is no frame-capture / pixel-diff helper here, and that is deliberate.
 *
 * An earlier version had one, and every assertion built on it was either wrong or
 * meaningless. JAPAN LIVE animates trains continuously — that IS the product — so the
 * frame changes on its own. Measured on CI at Shinjuku: 40.7% of pixels differ over
 * 2.5 s with nothing toggled, while removing the ENTIRE rail layer changes 9.4%. Motion
 * swamps the signal, so no threshold on a whole-frame diff can isolate a layer:
 * `diff > 0.01` passes whether or not the feature works, and `diff < 0.02` fails even
 * when it does.
 *
 * Everything visual is asserted through scene state and picking instead — see
 * `probeGeometry`, `probeRail` and `readXrayState`, and docs/DECISIONS.md D-015.
 */

export interface GeometryProbe {
  /** Screen samples that landed on 3D Tiles geometry. */
  tileHits: number;
  samples: number;
  /**
   * Highest ROOFTOP height found, in metres above the ellipsoid — measured only where
   * a sample actually hit tile geometry. Zero when nothing was hit, which is the
   * honest answer: with no buildings there are no rooftops to measure.
   */
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
    let maxHeight = 0;

    // A 5x5 grid across the middle of the frame, avoiding the HUD at the edges.
    //
    // Every pick re-renders the scene into a pick buffer, which on CI's software
    // rasteriser costs real time with 350+ trains and ten tilesets loaded. A 7x7 grid
    // that also called pickPosition at every point meant ~100 render passes per probe
    // and blew the test deadline. So: pick on a smaller grid, and measure height ONLY
    // where geometry was actually hit — which is also the more precise question, since
    // what matters is how high the rooftops are, not how high the ground is.
    for (let ix = 1; ix <= 5; ix++) {
      for (let iy = 1; iy <= 5; iy++) {
        const x = (canvas.clientWidth * ix) / 6;
        const y = (canvas.clientHeight * iy) / 6;
        const position = new Cesium.Cartesian2(x, y);
        samples++;

        const picked = scene.pick(position);
        const primitive = picked?.primitive;
        const isTileset =
          (primitive && "maximumScreenSpaceError" in primitive) ||
          (picked && typeof picked.getProperty === "function");
        if (!isTileset) continue;

        tileHits++;
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
      maxHeight,
      pickPositionSupported: Boolean(scene.pickPositionSupported),
    };
  });
}

/** Click a layer toggle in the Layers panel by its accessible name. */
export async function toggleLayer(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label }).click();
}

/**
 * Read the scene state X-Ray actually manipulates: globe translucency, and the height
 * underground track is drawn at. Deterministic, unlike a pixel comparison in a scene
 * where trains never stop moving.
 */
export async function readXrayState(page: Page): Promise<{
  translucencyEnabled: boolean;
  frontFaceAlpha: number;
  routeHeight: number;
}> {
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    const scene = viewer.scene;

    let routeHeight = Number.NaN;
    for (let i = 0; i < scene.primitives.length && Number.isNaN(routeHeight); i++) {
      const collection = scene.primitives.get(i);
      if (!collection || typeof collection.get !== "function") continue;
      const first = collection.get(0);
      if (!first || !("positions" in first) || !("width" in first)) continue;
      const position = first.positions?.[0];
      if (position) routeHeight = Cesium.Cartographic.fromCartesian(position).height;
    }

    return {
      translucencyEnabled: Boolean(scene.globe.translucency.enabled),
      frontFaceAlpha: Number(scene.globe.translucency.frontFaceAlpha),
      routeHeight,
    };
  });
}

export interface RailProbe {
  /** Rail route polylines currently visible. */
  visibleRoutes: number;
  /** Station point primitives currently visible. */
  visibleStations: number;
  /**
   * Station points that were actually pickable at their own projected screen position.
   * This is a rendering proof: a pick goes through the render pipeline, so a hit means
   * the primitive really is drawn at that pixel.
   */
  stationPickHits: number;
  stationPickAttempts: number;
}

/**
 * What the rail layers are actually doing in the scene.
 *
 * Deliberately not a full-frame pixel diff. Measured on CI: trains moving change 40.7%
 * of pixels over 2.5 s, while removing the entire rail layer changes 9.4% — motion
 * swamps the signal, so no threshold on a whole-frame diff can isolate a layer.
 *
 * Instead: count the primitives the layer owns, and pick at the exact projected
 * position of station points rather than hoping a sampling grid lands on a thin line.
 */
export async function probeRail(page: Page): Promise<RailProbe> {
  await page.evaluate(() => (window as any).__viewer?.scene?.requestRender());
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    const scene = viewer.scene;

    let visibleRoutes = 0;
    let visibleStations = 0;
    let stationPickHits = 0;
    let stationPickAttempts = 0;

    for (let i = 0; i < scene.primitives.length; i++) {
      const collection = scene.primitives.get(i);
      if (
        !collection ||
        typeof collection.get !== "function" ||
        typeof collection.length !== "number"
      ) {
        continue;
      }
      const first = collection.get(0);
      if (!first) continue;

      // Polyline is the only one of these with `positions`. Billboard also has `width`,
      // which is what made an earlier version count 356 trains as rail lines.
      const isPolyline = "positions" in first && "width" in first;
      const isPoint = "pixelSize" in first && !("image" in first);

      if (isPolyline && collection.show) {
        for (let j = 0; j < collection.length; j++) {
          if (collection.get(j)?.show) visibleRoutes++;
        }
      } else if (isPoint && collection.show) {
        for (let j = 0; j < collection.length && stationPickAttempts < 12; j++) {
          const point = collection.get(j);
          if (!point?.show || !point.position) continue;
          visibleStations++;

          const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, point.position);
          if (!win) continue;
          if (win.x < 10 || win.y < 10 || win.x > scene.canvas.clientWidth - 10) continue;
          if (win.y > scene.canvas.clientHeight - 10) continue;

          stationPickAttempts++;
          const picked = scene.pick(win);
          if (picked?.id?.kind === "station") stationPickHits++;
        }
        // Count the rest without picking; picking every station is far too slow.
        for (let j = 0; j < collection.length; j++) {
          if (j >= 12 && collection.get(j)?.show) visibleStations++;
        }
      }
    }

    return {
      visibleRoutes,
      visibleStations,
      stationPickHits,
      stationPickAttempts,
    };
  });
}

/**
 * Probe until geometry actually shows up, then return the final reading.
 *
 * Tiles finish loading when they finish; a fixed sleep either wastes time or races
 * them. The full-suite run caught this: the probe measured exactly 4 hits out of 25
 * samples against a `> 3` assertion in isolation, and fewer under load.
 *
 * Two separate things came out of that. Waiting for the condition instead of sleeping
 * is one. The other is that `> 3` was never the meaningful line: how many of 25 fixed
 * sample rays land on 25 towers depends on where the camera settles, not on whether
 * buildings work. What discriminates is presence against absence — the negative
 * controls demand exactly 0 with PLATEAU blocked and after the layer is toggled off —
 * plus surfaces standing above ground. So callers wait on `minHits` and then assert
 * `> 0`; the tight number is the wait condition, not a threshold tuned to pass.
 */
export async function waitForGeometry(
  page: Page,
  options: { minHits?: number; attempts?: number } = {},
): Promise<GeometryProbe> {
  const minHits = options.minHits ?? 1;
  const attempts = options.attempts ?? 8;
  let last = await probeGeometry(page);
  for (let i = 1; i < attempts && last.tileHits < minHits; i++) {
    await page.waitForTimeout(2_500);
    last = await probeGeometry(page);
  }
  return last;
}
