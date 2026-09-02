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
  /**
   * 3D Tiles traversal and streaming options.
   *
   * These are in the quality profile rather than hardcoded at the load site because
   * they are the settings the V1.2 investigation A/B-tested, and an A/B you cannot
   * re-run is a claim, not a measurement. `tileTuningFrom` lets a measurement run
   * override them from the URL without touching the shipped defaults.
   */
  tiles: TileTuning;
}

export interface TileTuning {
  /**
   * Render descendants before their ancestors have loaded.
   *
   * Kept ON, which is where it shipped, because the measurement said so: with the
   * three-level fixture and half its leaves held back, turning it OFF *reduced* the
   * pixels the layer painted (27.6% against 41.5%) — Cesium refuses to refine until
   * every child is ready, so the view sits on the coarsest level for longer.
   *
   * It is exposed here because it is the first thing to A/B when buildings look wrong
   * on a device. While a tileset has mixed content, Cesium gives every not-yet-final
   * tile an extra depth-only back-face pass (`deriveSkipLodBackfaceCommand`, colour
   * mask off, polygon offset 5/5) so that resolved tiles cannot be occluded by their
   * unresolved ancestors. That trick assumes closed solids; on an open or inverted
   * mesh the "back face" can land in front, and then real surfaces fail the depth
   * test and leave holes. Our synthetic fixture is closed boxes and cannot exercise
   * that, so it stays a hypothesis about real data — see docs/PERFORMANCE.md V1.2.
   */
  skipLevelOfDetail: boolean;
  /** Request leaf tiles first. With skipLevelOfDetail, keeps ancestors unresolved. */
  preferLeaves: boolean;
  dynamicScreenSpaceError: boolean;
  /**
   * Ceiling on simultaneous tile requests, applied to Cesium's global RequestScheduler.
   *
   * Cesium parses and uploads every queued tile inside one frame with no time budget
   * (Cesium3DTileset.prePassesUpdate -> processTiles), so the number of tiles that can
   * ARRIVE at once is the only lever we have on how long that frame can get.
   */
  maximumRequests: number;
  maximumRequestsPerServer: number;
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
  tiles: {
    skipLevelOfDetail: true,
    preferLeaves: true,
    dynamicScreenSpaceError: true,
    // Cesium's own defaults.
    maximumRequests: 50,
    maximumRequestsPerServer: 18,
  },
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
  // Every 3D Tiles setting is unchanged from V1.1, on purpose.
  //
  // The suspicion going in was that a phone should stream fewer tiles at once, because
  // Cesium parses and uploads every arrived tile inside one unbudgeted frame. The
  // measurement did not support changing it: on CI the whole fixture is 2.5 MB over
  // localhost, so no processing stall occurs to reduce, and capping requests only made
  // content arrive later. Shipping a cap on that evidence would be guessing with a
  // number attached. The knob is exposed (`?req=`) so the A/B can be run where the
  // stall actually happens — see docs/PERFORMANCE.md V1.2.
  tiles: {
    skipLevelOfDetail: true,
    preferLeaves: true,
    dynamicScreenSpaceError: true,
    maximumRequests: 50,
    maximumRequestsPerServer: 18,
  },
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

/**
 * Measurement-only overrides, read from the query string.
 *
 * `?sklod=1&leaves=0&dsse=0&req=6` — used by the A/B sweeps so both arms of a
 * comparison run the same build. Absent parameters keep the shipped default, so a
 * normal load is unaffected.
 */
export function tileTuningFrom(search: string, base: TileTuning): TileTuning {
  const params = new URLSearchParams(search);
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  };
  const int = (name: string, fallback: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    skipLevelOfDetail: flag("sklod", base.skipLevelOfDetail),
    preferLeaves: flag("leaves", base.preferLeaves),
    dynamicScreenSpaceError: flag("dsse", base.dynamicScreenSpaceError),
    maximumRequests: int("req", base.maximumRequests),
    maximumRequestsPerServer: int("reqserver", base.maximumRequestsPerServer),
  };
}

export function currentProfile(): QualityProfile {
  const width = typeof window === "undefined" ? 1_280 : window.innerWidth;
  const dpr = typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
  const profile = profileFor(width, dpr);
  if (typeof window === "undefined") return profile;
  return { ...profile, tiles: tileTuningFrom(window.location.search, profile.tiles) };
}
