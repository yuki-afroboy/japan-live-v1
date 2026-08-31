import { lerpHeadingDeg, lerpLonLat, haversineM, type LonLat } from "@japan-live/core";

/**
 * Between polls, a train must not teleport (spec §16) — but it must also not run ahead
 * of what the data says (spec §16, §79).
 *
 * So this eases the *rendered* position toward the last position the data supports, and
 * stops there. It never extrapolates past it. If a feed goes quiet, the train arrives at
 * its last known position and waits, and the freshness badge explains why.
 */
export interface SmoothedState {
  position: LonLat;
  heading: number;
  /** The data-supported target we are easing toward. */
  target: LonLat;
  targetHeading: number;
  /** When the current target was set. */
  targetSetAt: number;
  /** How long the ease should take, matched to the provider's poll interval. */
  durationMs: number;
}

export function createSmoothedState(
  position: LonLat,
  heading: number,
  now: number,
  durationMs: number,
): SmoothedState {
  return {
    position,
    heading,
    target: position,
    targetHeading: heading,
    targetSetAt: now,
    durationMs,
  };
}

/**
 * A new poll arrived. Ease from wherever we are drawing now toward the new position.
 *
 * A jump larger than `snapThresholdM` is snapped rather than animated: that is a train
 * re-identified or a data correction, and sliding it across Tokyo would be a lie about
 * a journey that never happened.
 */
export function retarget(
  state: SmoothedState,
  target: LonLat,
  targetHeading: number,
  now: number,
  snapThresholdM = 3_000,
): SmoothedState {
  const current = sample(state, now);
  const jump = haversineM(current.position, target);

  if (jump > snapThresholdM) {
    return {
      position: target,
      heading: targetHeading,
      target,
      targetHeading,
      targetSetAt: now,
      durationMs: state.durationMs,
    };
  }

  return {
    position: current.position,
    heading: current.heading,
    target,
    targetHeading,
    targetSetAt: now,
    durationMs: state.durationMs,
  };
}

/** Where to draw right now. Clamps at the target — never past it. */
export function sample(state: SmoothedState, now: number): { position: LonLat; heading: number } {
  const elapsed = now - state.targetSetAt;
  if (state.durationMs <= 0 || elapsed >= state.durationMs) {
    return { position: state.target, heading: state.targetHeading };
  }
  const t = Math.max(0, elapsed / state.durationMs);
  return {
    position: lerpLonLat(state.position, state.target, t),
    heading: lerpHeadingDeg(state.heading, state.targetHeading, t),
  };
}
