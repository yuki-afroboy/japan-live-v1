import { describe, expect, it } from "vitest";
import { smoothstep, smootherstep, trainProgress, trainSpeedFactor } from "@japan-live/core";

describe("trainProgress", () => {
  it("starts at the departure station and ends at the arrival station", () => {
    expect(trainProgress(0)).toBeCloseTo(0, 6);
    expect(trainProgress(1)).toBeCloseTo(1, 6);
  });

  it("never moves backwards", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const p = trainProgress(t);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it("stays within the segment", () => {
    for (let t = -0.5; t <= 1.5; t += 0.05) {
      const p = trainProgress(t);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("accelerates out of the station rather than starting at full speed", () => {
    // Constant speed would put it at 5% after 5% of the time. Accelerating puts it behind.
    expect(trainProgress(0.05)).toBeLessThan(0.05);
  });

  it("brakes into the station", () => {
    // Symmetrically, it is ahead of linear near the end as it has already cruised.
    expect(trainProgress(0.95)).toBeGreaterThan(0.95);
  });

  it("is symmetric for symmetric accel/decel", () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(trainProgress(t)).toBeCloseTo(1 - trainProgress(1 - t), 6);
    }
  });

  it("reduces to linear when there is no accel or decel phase", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(trainProgress(t, 0, 0)).toBeCloseTo(t, 6);
    }
  });
});

describe("trainSpeedFactor", () => {
  it("is zero at both stations and full at cruise", () => {
    expect(trainSpeedFactor(0)).toBeCloseTo(0, 6);
    expect(trainSpeedFactor(0.5)).toBeCloseTo(1, 6);
    expect(trainSpeedFactor(1)).toBeCloseTo(0, 6);
  });
});

describe("smoothstep", () => {
  it("clamps and hits its endpoints", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 6);
  });
});
