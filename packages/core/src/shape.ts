import { bearingDeg, haversineM, lerpLonLat, type LonLat } from "./geo.js";

/**
 * A route polyline with a cumulative distance table, so a position can be expressed as
 * "N metres along the line" and resolved back to a coordinate.
 *
 * Trains never travel in a straight line between stations (spec §14). Every position in
 * JAPAN LIVE is a distance along one of these.
 */
export interface ShapePoint {
  position: LonLat;
  heading: number;
  /** Distance from the start of the line, in metres. */
  distanceM: number;
}

export class ShapeIndex {
  readonly points: readonly LonLat[];
  /** cumulative[i] = distance from point 0 to point i. */
  readonly cumulative: readonly number[];
  readonly totalLengthM: number;

  constructor(points: LonLat[]) {
    if (points.length === 0) {
      throw new Error("ShapeIndex requires at least one point");
    }
    this.points = points;
    const cumulative = new Array<number>(points.length);
    cumulative[0] = 0;
    for (let i = 1; i < points.length; i++) {
      cumulative[i] = cumulative[i - 1]! + haversineM(points[i - 1]!, points[i]!);
    }
    this.cumulative = cumulative;
    this.totalLengthM = cumulative[cumulative.length - 1]!;
  }

  /**
   * Resolve a distance along the line to a coordinate and heading.
   * Distances outside the line are clamped to its ends — callers that must not clamp
   * check the range themselves and produce UNAVAILABLE instead.
   */
  at(distanceM: number): ShapePoint {
    const pts = this.points;
    if (pts.length === 1) {
      return { position: pts[0]!, heading: 0, distanceM: 0 };
    }
    const d = Math.max(0, Math.min(this.totalLengthM, distanceM));

    const i = this.segmentIndexFor(d);
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const segStart = this.cumulative[i]!;
    const segLen = this.cumulative[i + 1]! - segStart;
    const t = segLen > 0 ? (d - segStart) / segLen : 0;

    return {
      position: lerpLonLat(a, b, t),
      heading: bearingDeg(a, b),
      distanceM: d,
    };
  }

  /** Index of the segment containing `distanceM`. Binary search over the cumulative table. */
  private segmentIndexFor(distanceM: number): number {
    const c = this.cumulative;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid]! <= distanceM) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, c.length - 2);
  }

  /** Distance along the line of the vertex nearest to `target`. Used to place stations. */
  nearestDistanceTo(target: LonLat): number {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.points.length; i++) {
      const d = haversineM(this.points[i]!, target);
      if (d < bestDist) {
        bestDist = d;
        best = this.cumulative[i]!;
      }
    }
    return best;
  }

  /** The polyline between two distances, for drawing a highlighted segment. */
  slice(fromM: number, toM: number): LonLat[] {
    const lo = Math.max(0, Math.min(fromM, toM));
    const hi = Math.min(this.totalLengthM, Math.max(fromM, toM));
    const out: LonLat[] = [this.at(lo).position];
    for (let i = 0; i < this.points.length; i++) {
      const c = this.cumulative[i]!;
      if (c > lo && c < hi) out.push(this.points[i]!);
    }
    out.push(this.at(hi).position);
    return out;
  }
}
