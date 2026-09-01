import * as Cesium from "cesium";

export interface CameraPreset {
  id: string;
  label: string;
  labelEn: string;
  longitude: number;
  latitude: number;
  /** Metres above the ellipsoid. */
  height: number;
  pitch: number;
  heading?: number;
}

/**
 * Spec §22. Japan down to individual districts, one click each.
 *
 * The city-scale presets are deliberately low and steeply oblique. A near-overhead
 * view flattens a skyline into a street map: you cannot tell a 200 m tower from a
 * car park. Pitch around -25° with the camera below roof-height-times-ten is what
 * makes 3D buildings read as buildings.
 */
export const CAMERA_PRESETS: CameraPreset[] = [
  { id: "japan", label: "日本", labelEn: "Japan", longitude: 138.2, latitude: 36.5, height: 2_200_000, pitch: -80 },
  { id: "kanto", label: "関東", labelEn: "Kanto", longitude: 139.6, latitude: 35.7, height: 420_000, pitch: -70 },
  { id: "tokyo", label: "東京", labelEn: "Tokyo", longitude: 139.75, latitude: 35.66, height: 42_000, pitch: -55 },
  //
  // These are positioned by geometry, not by eye: at height H and pitch p the camera
  // looks at ground roughly H/tan(|p|) ahead, so each one is placed that far back from
  // the landmark it should frame. Pointing a low oblique camera at the sky over a
  // district is how the first attempt put the skyline off the bottom of the screen.
  //
  // 西新宿の超高層ビル群 (139.692, 35.690), framed from the south-west.
  { id: "shinjuku", label: "新宿", labelEn: "Shinjuku", longitude: 139.6800, latitude: 35.6766, height: 900, pitch: -24, heading: 33 },
  // 丸の内 (139.766, 35.681), framed from the south-west.
  { id: "tokyo-station", label: "東京駅", labelEn: "Tokyo Sta.", longitude: 139.7546, latitude: 35.6689, height: 850, pitch: -24, heading: 36 },
  // 渋谷スクランブル周辺 (139.7016, 35.6595), framed from the south.
  { id: "shibuya", label: "渋谷", labelEn: "Shibuya", longitude: 139.6968, latitude: 35.6480, height: 780, pitch: -23, heading: 22 },
];

/**
 * CITY VIEW — the framing that shows Tokyo as a three-dimensional city.
 * Low, oblique, and pointed at 西新宿, which has the densest cluster of tall
 * buildings in the PLATEAU data.
 */
export const CITY_VIEW: CameraPreset = {
  id: "city",
  label: "CITY VIEW",
  labelEn: "City View",
  // 1.5 km south-west of the cluster at 600 m and -22°, so the towers sit in the
  // middle of the frame with sky behind them.
  longitude: 139.6822,
  latitude: 35.6784,
  height: 600,
  pitch: -22,
  heading: 35,
};

export function flyToPreset(viewer: Cesium.Viewer, preset: CameraPreset, duration = 2.6): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(preset.longitude, preset.latitude, preset.height),
    orientation: {
      heading: Cesium.Math.toRadians(preset.heading ?? 0),
      pitch: Cesium.Math.toRadians(preset.pitch),
      roll: 0,
    },
    duration,
  });
}

/** Camera height above the ellipsoid, in metres. The input to every LOD decision. */
export function cameraAltitude(viewer: Cesium.Viewer): number {
  return viewer.camera.positionCartographic.height;
}

/** Ground position at the centre of the view, for deciding what is nearby. */
export function viewCenter(viewer: Cesium.Viewer): Cesium.Cartographic | undefined {
  const ray = viewer.camera.getPickRay(
    new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2),
  );
  if (!ray) return undefined;
  const point = viewer.scene.globe.pick(ray, viewer.scene);
  return point ? Cesium.Cartographic.fromCartesian(point) : undefined;
}

/**
 * The opening flight (spec §21): Japan from space, then in toward Tokyo.
 * Always skippable — `cancel()` stops it immediately and leaves the camera where it is.
 */
export function playIntro(viewer: Cesium.Viewer, onDone?: () => void): { cancel: () => void } {
  let cancelled = false;
  const japan = CAMERA_PRESETS[0]!;
  const tokyo = CAMERA_PRESETS[2]!;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(japan.longitude, japan.latitude - 6, 9_500_000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 },
  });

  const timer = window.setTimeout(() => {
    if (cancelled) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(tokyo.longitude, tokyo.latitude, tokyo.height),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(tokyo.pitch),
        roll: 0,
      },
      duration: 7.5,
      complete: () => {
        if (!cancelled) onDone?.();
      },
      cancel: () => onDone?.(),
    });
  }, 900);

  return {
    cancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      viewer.camera.cancelFlight();
    },
  };
}

/**
 * TOUR (spec §57): a hands-off circuit of the city, for watching rather than driving.
 * Any user interaction cancels it — a tour you cannot escape is a trap, not a feature.
 */
export interface TourStep {
  preset: CameraPreset;
  holdMs: number;
}

export const TOUR_STEPS: TourStep[] = [
  { preset: CAMERA_PRESETS[3]!, holdMs: 7_000 },
  { preset: CAMERA_PRESETS[4]!, holdMs: 7_000 },
  { preset: CAMERA_PRESETS[5]!, holdMs: 7_000 },
  { preset: CAMERA_PRESETS[2]!, holdMs: 8_000 },
  { preset: CAMERA_PRESETS[1]!, holdMs: 6_000 },
];

export function playTour(
  viewer: Cesium.Viewer,
  onStep: (index: number) => void,
  onDone: () => void,
): { cancel: () => void } {
  let cancelled = false;
  let timer = 0;

  const run = (index: number) => {
    if (cancelled) return;
    if (index >= TOUR_STEPS.length) {
      onDone();
      return;
    }
    const step = TOUR_STEPS[index]!;
    onStep(index);
    flyToPreset(viewer, step.preset, 4.0);
    timer = window.setTimeout(() => run(index + 1), step.holdMs);
  };

  run(0);

  return {
    cancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      viewer.camera.cancelFlight();
    },
  };
}

/**
 * Follow a moving vehicle (spec §29).
 *
 * The camera is placed each frame relative to the target rather than parented to an
 * entity, so following works identically for a realtime train and a simulated one.
 */
export type FollowView = "behind" | "above" | "side";

export function applyFollow(
  viewer: Cesium.Viewer,
  longitude: number,
  latitude: number,
  altitude: number,
  heading: number,
  view: FollowView,
): void {
  const target = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);

  switch (view) {
    case "above":
      viewer.camera.lookAt(
        target,
        new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(-85), 900),
      );
      break;
    case "side":
      viewer.camera.lookAt(
        target,
        new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading + 90), Cesium.Math.toRadians(-12), 340),
      );
      break;
    case "behind":
    default:
      viewer.camera.lookAt(
        target,
        new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading - 180), Cesium.Math.toRadians(-22), 420),
      );
      break;
  }
}

/** Release the follow transform. Forgetting this leaves the camera stuck at a point. */
export function releaseFollow(viewer: Cesium.Viewer): void {
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}
