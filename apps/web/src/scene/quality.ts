/**
 * Rendering quality profile, chosen from the device rather than from a settings screen.
 *
 * Every knob that trades pixels or geometry for frame rate lives here, in one place,
 * so a performance decision is a data change with a test on it instead of a number
 * buried in three files. The desktop profile is exactly what the app shipped with;
 * only the mobile profile is tuned.
 *
 * Deliberately NOT user-facing. Asking someone to pick a quality level is asking them
 * to debug our renderer.
 */

export type QualityTier = "mobile" | "desktop";

export interface QualityProfile {
  tier: QualityTier;
  /** Multiplier on CSS pixels. Cost scales with the square of this. */
  resolutionScale: number;
  /**
   * WebGL context antialiasing.
   *
   * Measured to be nearly irrelevant on its own: Cesium renders into its own
   * framebuffer, so the context flag governs a surface almost nothing is drawn to.
   * The two settings below are the ones that actually cost fragments. Kept in the
   * profile so the context is not asking for a buffer it never uses.
   */
  antialias: boolean;
  /** Cesium's own MSAA on its render target. Cesium's default is 4. 1 disables it. */
  msaaSamples: number;
  /** Cesium's FXAA post-process — one full-screen pass per frame. */
  fxaa: boolean;
  /** How many PLATEAU wards may be resident at once. */
  wardBudget: number;
  tilesetCacheBytes: number;
  tilesetOverflowBytes: number;
  /** 3D Tiles screen-space error close in (lower = more geometry). */
  detailSse: number;
  /** Screen-space error at mid range. */
  midSse: number;
  /**
   * Ceiling on how often train motion alone drives a render, in Hz.
   *
   * Camera input, flights and Follow bypass this entirely — a capped drag feels
   * broken, and MOTION is the product. This throttles only the case where nothing
   * but the vehicles has changed.
   */
  animationHz: number;
}

const DESKTOP: Omit<QualityProfile, "resolutionScale"> = {
  tier: "desktop",
  antialias: true,
  msaaSamples: 4,
  fxaa: true,
  wardBudget: 10,
  tilesetCacheBytes: 128 * 1024 * 1024,
  tilesetOverflowBytes: 64 * 1024 * 1024,
  detailSse: 12,
  midSse: 32,
  // Uncapped: a desktop GPU has the headroom and 60 fps motion is worth having.
  animationHz: 120,
};

const MOBILE: Omit<QualityProfile, "resolutionScale"> = {
  tier: "mobile",
  antialias: false,
  // THIS is the MSAA that mattered. Cesium defaults to 4 samples on its own render
  // target: four times the fragment and bandwidth cost of the whole scene, for edge
  // smoothing that is close to invisible at phone pixel density. Turning off the
  // WebGL context flag alone moved the frame time by about 2%, because Cesium barely
  // draws to that surface — the measurement is what found this.
  msaaSamples: 1,
  // One less full-screen pass per frame, on top of that.
  fxaa: false,
  wardBudget: 3,
  // A phone has neither the RAM nor the bandwidth for four 128 MB tile caches.
  tilesetCacheBytes: 48 * 1024 * 1024,
  tilesetOverflowBytes: 16 * 1024 * 1024,
  // 12 -> 16 keeps the west-Shinjuku towers clearly three-dimensional while asking
  // for measurably fewer tiles. Anything coarser starts flattening the skyline.
  detailSse: 16,
  midSse: 40,
  // A city visualisation does not need 60 fps of train motion. 30 Hz reads as smooth
  // and halves the work when the camera is still.
  animationHz: 30,
};

/**
 * The one breakpoint.
 *
 * The CSS media query, the React tab layout and the rendering tier all read this, so
 * a phone can never get the mobile layout with the desktop's pixel budget. A unit test
 * asserts the stylesheet still agrees with this number.
 */
export const NARROW_MAX_WIDTH = 780;

/** Phones and small tablets. Matches the CSS breakpoint so layout and cost agree. */
export function tierFor(width: number): QualityTier {
  return width <= NARROW_MAX_WIDTH ? "mobile" : "desktop";
}

export function profileFor(width: number, devicePixelRatio: number): QualityProfile {
  const tier = tierFor(width);
  const base = tier === "mobile" ? MOBILE : DESKTOP;
  return { ...base, resolutionScale: resolutionScaleFor(tier, devicePixelRatio) };
}

/**
 * Pixels are the dominant cost on a phone GPU and they scale quadratically:
 * 1.75x renders 3.06x the pixels of 1.0x.
 *
 * 1.25 keeps text and thin rail lines crisp — a full 1.0 on a 3x screen makes the
 * 1 px route strokes visibly ragged — while costing 1.56x instead of 3.06x, a 49%
 * reduction in fragment work.
 */
export function resolutionScaleFor(tier: QualityTier, devicePixelRatio: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return tier === "mobile" ? Math.min(dpr, 1.25) : Math.min(dpr, 1.75);
}

export function currentProfile(): QualityProfile {
  const width = typeof window === "undefined" ? 1_280 : window.innerWidth;
  const dpr = typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
  return profileFor(width, dpr);
}
