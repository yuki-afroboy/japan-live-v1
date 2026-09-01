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
  // Every value here is what V1 shipped. This commit moves the settings into one
  // place and changes nothing; the numbers are tuned once there is a measurement to
  // justify each one.
  antialias: true,
  msaaSamples: 4,
  fxaa: true,
  wardBudget: 4,
  tilesetCacheBytes: 128 * 1024 * 1024,
  tilesetOverflowBytes: 64 * 1024 * 1024,
  detailSse: 12,
  midSse: 32,
  animationHz: 120,
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
 * Both tiers currently cap at 1.75, which is what V1 shipped. The mobile cap is the
 * first thing a measurement should challenge.
 */
export function resolutionScaleFor(tier: QualityTier, devicePixelRatio: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return tier === "mobile" ? Math.min(dpr, 1.75) : Math.min(dpr, 1.75);
}

export function currentProfile(): QualityProfile {
  const width = typeof window === "undefined" ? 1_280 : window.innerWidth;
  const dpr = typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
  return profileFor(width, dpr);
}
