import { describe, expect, it } from "vitest";
import { ShapeIndex, haversineM, simplifyPolyline, lerpHeadingDeg, angleDeltaDeg } from "@japan-live/core";
import type { LonLat } from "@japan-live/core";

// An L-shaped line: east along a parallel, then north.
const L: LonLat[] = [
  [139.7, 35.68],
  [139.71, 35.68],
  [139.71, 35.69],
];

describe("ShapeIndex", () => {
  const idx = new ShapeIndex(L);

  it("builds a cumulative distance table", () => {
    expect(idx.cumulative[0]).toBe(0);
    expect(idx.cumulative[1]).toBeCloseTo(haversineM(L[0]!, L[1]!), 6);
    expect(idx.totalLengthM).toBeCloseTo(
      haversineM(L[0]!, L[1]!) + haversineM(L[1]!, L[2]!),
      6,
    );
  });

  it("returns the start at distance 0 and the end at total length", () => {
    expect(idx.at(0).position).toEqual(L[0]);
    const end = idx.at(idx.totalLengthM).position;
    expect(end[0]).toBeCloseTo(L[2]![0], 9);
    expect(end[1]).toBeCloseTo(L[2]![1], 9);
  });

  it("follows the corner rather than cutting across it", () => {
    // Halfway by distance must sit ON the polyline, not on the chord from start to end.
    const mid = idx.at(idx.totalLengthM / 2).position;
    const onFirstLeg = Math.abs(mid[1] - 35.68) < 1e-9;
    const onSecondLeg = Math.abs(mid[0] - 139.71) < 1e-9;
    expect(onFirstLeg || onSecondLeg).toBe(true);
  });

  it("turns the corner: heading is east on leg 1 and north on leg 2", () => {
    const firstLeg = idx.cumulative[1]!;
    expect(idx.at(firstLeg * 0.5).heading).toBeCloseTo(90, 0);
    expect(idx.at(firstLeg + 100).heading).toBeCloseTo(0, 0);
  });

  it("clamps out-of-range distances to the ends", () => {
    expect(idx.at(-500).distanceM).toBe(0);
    expect(idx.at(idx.totalLengthM + 500).distanceM).toBe(idx.totalLengthM);
  });

  it("advances monotonically along the line", () => {
    let prev = -1;
    for (let d = 0; d <= idx.totalLengthM; d += idx.totalLengthM / 50) {
      const p = idx.at(d);
      expect(p.distanceM).toBeGreaterThanOrEqual(prev);
      prev = p.distanceM;
    }
  });

  it("finds the distance of the nearest vertex", () => {
    expect(idx.nearestDistanceTo(L[1]!)).toBeCloseTo(idx.cumulative[1]!, 6);
  });

  it("slices a sub-polyline between two distances", () => {
    const seg = idx.slice(0, idx.cumulative[1]!);
    expect(seg.length).toBeGreaterThanOrEqual(2);
    expect(seg[0]![0]).toBeCloseTo(L[0]![0], 9);
  });

  it("handles a degenerate single-point shape without throwing", () => {
    const single = new ShapeIndex([[139.7, 35.68]]);
    expect(single.totalLengthM).toBe(0);
    expect(single.at(100).position).toEqual([139.7, 35.68]);
  });
});

describe("simplifyPolyline", () => {
  it("drops collinear points but keeps the endpoints", () => {
    const straight: LonLat[] = [
      [139.7, 35.68],
      [139.705, 35.68],
      [139.71, 35.68],
      [139.715, 35.68],
    ];
    const out = simplifyPolyline(straight, 5);
    expect(out).toEqual([straight[0], straight[3]]);
  });

  it("keeps a corner that exceeds the tolerance", () => {
    expect(simplifyPolyline(L, 5)).toHaveLength(3);
  });
});

describe("heading interpolation", () => {
  it("takes the short way round 0/360", () => {
    expect(lerpHeadingDeg(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(angleDeltaDeg(350, 10)).toBeCloseTo(20, 6);
  });
});
