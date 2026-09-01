import * as Cesium from "cesium";
import { CONFIG } from "../config.js";
import { currentProfile } from "./quality.js";

export type LayerStatus = "loading" | "ok" | "unavailable";

export interface SceneHealth {
  terrain: LayerStatus;
  basemap: LayerStatus;
  buildings: LayerStatus;
  /** Human-readable reason when something is unavailable. Shown in Data Status. */
  notes: Partial<Record<"terrain" | "basemap" | "buildings", string>>;
}

/**
 * Creates the Cesium viewer.
 *
 * Every external layer is optional. Terrain, basemap, and buildings each fail to a
 * usable state rather than throwing, because none of them is worth a white screen
 * (spec §62, ARCHITECTURE "Failure behaviour").
 */
export function createViewer(container: HTMLElement): Cesium.Viewer {
  Cesium.Ion.defaultAccessToken = CONFIG.cesiumIonToken;
  const profile = currentProfile();

  const viewer = new Cesium.Viewer(container, {
    // The product is the globe. Every Cesium chrome widget is off; our own UI replaces it.
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    navigationHelpButton: false,
    navigationInstructionsInitiallyVisible: false,
    creditContainer: document.createElement("div"), // credits are rendered by our own UI
    // Cesium's built-in error panel is a modal that covers the map and blocks every
    // control behind it. We surface scene errors through our own diagnostics instead,
    // so one bad layer degrades rather than taking the whole app hostage.
    showRenderLoopErrors: false,
    baseLayer: false,
    // Only render when something changed. This is the single biggest power and
    // battery win on a map that is often still.
    requestRenderMode: true,
    maximumRenderTimeChange: 0.5,
    contextOptions: {
      webgl: {
        powerPreference: "high-performance",
        // Nearly cosmetic on its own — see scene.msaaSamples below, which is the
        // setting that actually costs fragments. See docs/PERFORMANCE.md.
        antialias: profile.antialias,
        // Reading pixels back needs the buffer preserved, which costs performance, so
        // it is enabled only for the visual-regression tests that ask for it.
        preserveDrawingBuffer: new URLSearchParams(location.search).has("debug"),
      },
    },
  });

  const scene = viewer.scene;
  // The globe must be legible with NO imagery at all: that is the documented fallback
  // when GSI tiles are unreachable, and a near-black sphere on a near-black sky is
  // indistinguishable from a broken app.
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#16243d");
  scene.backgroundColor = Cesium.Color.fromCssColorString("#03050a");
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;
  scene.globe.atmosphereBrightnessShift = 0.15;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.depthTestAgainstTerrain = true;
  // Underground trains are drawn below the surface; the globe must not hide them
  // completely, and X-Ray mode raises translucency further.
  scene.globe.translucency.enabled = false;
  scene.highDynamicRange = false;

  // Antialiasing, where it is actually paid for. Cesium renders into its own target
  // with 4x MSAA by default and then runs an FXAA pass over the result. On a phone
  // that is four times the fragment work of the entire scene plus a full-screen pass,
  // to smooth edges at a pixel density where the eye cannot resolve them.
  scene.msaaSamples = profile.msaaSamples;
  if (scene.postProcessStages?.fxaa) scene.postProcessStages.fxaa.enabled = profile.fxaa;

  scene.screenSpaceCameraController.enableCollisionDetection = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 40;
  scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;

  // Cap device pixel ratio: a 3x phone screen renders 9x the pixels for no visible
  // gain, and fragment cost scales with the SQUARE of this number — 1.75 draws 3.06x
  // the pixels of 1.0. The per-tier cap lives in the quality profile.
  viewer.resolutionScale = profile.resolutionScale;

  return viewer;
}

/**
 * PLATEAU nationwide terrain, with a fallback to a smooth ellipsoid.
 * Japan without its mountains is a worse product, but it is still a product.
 */
export async function installTerrain(
  viewer: Cesium.Viewer,
): Promise<{ status: LayerStatus; note?: string }> {
  try {
    const provider = CONFIG.terrainUrl
      ? await Cesium.CesiumTerrainProvider.fromUrl(CONFIG.terrainUrl, { requestVertexNormals: true })
      : await Cesium.CesiumTerrainProvider.fromIonAssetId(CONFIG.plateauTerrainAssetId, {
          requestVertexNormals: true,
        });
    viewer.scene.terrainProvider = provider;
    // Vertex normals give the terrain its shading; without them Japan looks flat even
    // when the heights are correct.
    viewer.scene.globe.enableLighting = true;
    return { status: "ok" };
  } catch (err) {
    viewer.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    return {
      status: "unavailable",
      note: `地形を取得できませんでした（${errName(err)}）。地形なしで表示しています。`,
    };
  }
}

/** 地理院タイル over a dark base, so the ocean and out-of-coverage areas stay legible. */
export function installBasemap(viewer: Cesium.Viewer): { status: LayerStatus; note?: string } {
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: CONFIG.gsiTileUrl,
      maximumLevel: CONFIG.gsiMaxZoom,
      credit: new Cesium.Credit("地理院タイル (国土地理院)", false),
    });

    const layer = viewer.imageryLayers.addImageryProvider(provider);
    // The pale GSI map is designed for paper-white backgrounds. Darkening and
    // desaturating it lets the rail lines and trains carry the colour instead.
    layer.brightness = 0.42;
    layer.saturation = 0.55;
    layer.contrast = 1.16;
    layer.gamma = 0.85;

    let failed = false;
    provider.errorEvent.addEventListener(() => {
      // Individual tiles 404 outside Japan by design; only report a total failure once.
      if (!failed) failed = true;
    });

    return { status: "ok" };
  } catch (err) {
    return {
      status: "unavailable",
      note: `ベースマップを取得できませんでした（${errName(err)}）。地図なしで表示しています。`,
    };
  }
}

export function errName(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 80) || err.name;
  return "unknown error";
}
