/**
 * Motion shaping.
 *
 * A train does not cover the distance between two stations at a constant rate: it
 * accelerates, cruises, then brakes. Spec §15 asks for that to be visible. These are
 * shape functions over normalized time, not a physics model — they exist so the motion
 * reads as a train rather than a slider.
 */

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Fraction of a station-to-station run completed at normalized time `t`.
 *
 * Trapezoidal speed profile: accelerate for `accelFrac`, cruise, brake for `decelFrac`.
 * Returns distance fraction, so it starts and ends at zero speed — which is what makes
 * a train look like it is pulling in and pulling out rather than sliding through.
 */
export function trainProgress(t: number, accelFrac = 0.25, decelFrac = 0.25): number {
  const x = clamp01(t);
  const a = Math.max(0, Math.min(0.5, accelFrac));
  const d = Math.max(0, Math.min(0.5, decelFrac));
  const cruise = 1 - a - d;

  // Peak speed such that the area under the speed curve is exactly 1.
  const area = a / 2 + cruise + d / 2;
  if (area <= 0) return x;
  const vMax = 1 / area;

  if (x < a) {
    // Ramping up: area of a triangle.
    return (vMax * x * x) / (2 * a);
  }
  const accelArea = (vMax * a) / 2;
  if (x < a + cruise) {
    return accelArea + vMax * (x - a);
  }
  const cruiseArea = vMax * cruise;
  const td = x - a - cruise;
  // Ramping down: full rectangle minus the remaining triangle.
  return accelArea + cruiseArea + vMax * td - (vMax * td * td) / (2 * d || 1);
}

/**
 * Speed at normalized time `t`, as a fraction of peak. Used to report a plausible
 * speed ONLY where the underlying data justifies one; never invented on its own.
 */
export function trainSpeedFactor(t: number, accelFrac = 0.25, decelFrac = 0.25): number {
  const x = clamp01(t);
  const a = Math.max(0, Math.min(0.5, accelFrac));
  const d = Math.max(0, Math.min(0.5, decelFrac));
  if (x < a) return a > 0 ? x / a : 1;
  if (x > 1 - d) return d > 0 ? (1 - x) / d : 1;
  return 1;
}
