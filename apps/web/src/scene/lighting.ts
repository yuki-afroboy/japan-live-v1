import * as Cesium from "cesium";

/**
 * Day and night (spec §31).
 *
 * Cesium already computes the sun's position from the scene clock, so the honest way to
 * light the globe is to keep that clock pointed at the time the app is displaying —
 * whether that is now (LIVE) or an arbitrary instant (SIMULATION). Night in the app is
 * then night in Tokyo, not a mood setting.
 */
export function installLighting(viewer: Cesium.Viewer): void {
  const scene = viewer.scene;
  scene.globe.enableLighting = true;
  // Without this the night side is pure black and the city disappears.
  scene.globe.nightFadeInDistance = 4_000_000;
  scene.globe.nightFadeOutDistance = 100_000;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.atmosphereLightIntensity = 8.0;
  scene.sun = new Cesium.Sun();
  scene.moon = new Cesium.Moon();
  scene.skyBox = createStarField();
  viewer.clock.shouldAnimate = false;
}

/**
 * Point the scene clock at the instant being displayed.
 *
 * Called whenever the app's clock moves — so scrubbing to 05:00 in SIMULATION brings
 * the sunrise with it.
 */
export function setSceneTime(viewer: Cesium.Viewer, epochMs: number): void {
  const julian = Cesium.JulianDate.fromDate(new Date(epochMs));
  viewer.clock.currentTime = julian;
  viewer.clock.startTime = julian;
  viewer.clock.stopTime = Cesium.JulianDate.addHours(julian, 1, new Cesium.JulianDate());
}

/** Cesium ships a star box; using it avoids shipping our own textures. */
function createStarField(): Cesium.SkyBox {
  const base = `${Cesium.buildModuleUrl("Assets/Textures/SkyBox")}`;
  return new Cesium.SkyBox({
    sources: {
      positiveX: `${base}/tycho2t3_80_px.jpg`,
      negativeX: `${base}/tycho2t3_80_mx.jpg`,
      positiveY: `${base}/tycho2t3_80_py.jpg`,
      negativeY: `${base}/tycho2t3_80_my.jpg`,
      positiveZ: `${base}/tycho2t3_80_pz.jpg`,
      negativeZ: `${base}/tycho2t3_80_mz.jpg`,
    },
  });
}

/** Is it night at this longitude, roughly? Used to bias train glow, not to state facts. */
export function isNightAt(epochMs: number, longitudeDeg: number): boolean {
  const utcHours = new Date(epochMs).getUTCHours() + new Date(epochMs).getUTCMinutes() / 60;
  const solarHour = (utcHours + longitudeDeg / 15 + 24) % 24;
  return solarHour < 5.5 || solarHour > 18.5;
}
