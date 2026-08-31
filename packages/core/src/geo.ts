/** Geodesy limited to what the product actually needs, on a spherical earth. */

export const EARTH_RADIUS_M = 6_371_008.8;

export type LonLat = [number, number];

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. Haversine — accurate enough at rail scale. */
export function haversineM(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing in degrees clockwise from north. */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Linear interpolation between two points. Fine over the sub-kilometre spans we use it for. */
export function lerpLonLat(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Shortest signed difference between two bearings, in degrees, within [-180, 180). */
export function angleDeltaDeg(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Interpolate a heading the short way round, so a train never spins through 359°. */
export function lerpHeadingDeg(from: number, to: number, t: number): number {
  return (from + angleDeltaDeg(from, to) * t + 360) % 360;
}

/**
 * Douglas-Peucker simplification, tolerance in metres.
 * Route shapes arrive with far more vertices than any zoom level can show.
 */
export function simplifyPolyline(points: LonLat[], toleranceM: number): LonLat[] {
  if (points.length <= 2 || toleranceM <= 0) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    const a = points[start]!;
    const b = points[end]!;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceM(points[i]!, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index > 0 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  const out: LonLat[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

function perpendicularDistanceM(p: LonLat, a: LonLat, b: LonLat): number {
  // Local equirectangular projection — the spans involved are short enough.
  const latRef = toRad((a[1] + b[1]) / 2);
  const mx = EARTH_RADIUS_M * Math.cos(latRef);
  const my = EARTH_RADIUS_M;
  const px = toRad(p[0]) * mx;
  const py = toRad(p[1]) * my;
  const ax = toRad(a[0]) * mx;
  const ay = toRad(a[1]) * my;
  const bx = toRad(b[0]) * mx;
  const by = toRad(b[1]) * my;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
