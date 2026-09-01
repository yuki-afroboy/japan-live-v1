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

/** Spec §22. Japan down to individual districts, one click each. */
export const CAMERA_PRESETS: CameraPreset[] = [
  { id: "japan", label: "日本", labelEn: "Japan", longitude: 138.2, latitude: 36.5, height: 2_200_000, pitch: -80 },
  { id: "kanto", label: "関東", labelEn: "Kanto", longitude: 139.6, latitude: 35.7, height: 420_000, pitch: -70 },
  { id: "tokyo", label: "東京", labelEn: "Tokyo", longitude: 139.75, latitude: 35.66, height: 42_000, pitch: -55 },
  { id: "tokyo-station", label: "東京駅", labelEn: "Tokyo Sta.", longitude: 139.7671, latitude: 35.6760, height: 1_900, pitch: -38 },
  { id: "shinjuku", label: "新宿", labelEn: "Shinjuku", longitude: 139.7005, latitude: 35.6860, height: 1_700, pitch: -35 },
  { id: "shibuya", label: "渋谷", labelEn: "Shibuya", longitude: 139.7016, latitude: 35.6550, height: 1_500, pitch: -34 },
];

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
