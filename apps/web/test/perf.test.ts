import { describe, expect, it } from "vitest";
import { FrameMetrics } from "../src/scene/perf.js";

/**
 * The measuring instrument gets its own tests.
 *
 * A performance panel that quietly reports the wrong number is worse than no panel:
 * it is the thing a decision gets made on, on a device where nothing else can be
 * checked. So the arithmetic is asserted against inputs whose answers are known by
 * construction.
 */

/** Feed n frames spaced exactly `intervalMs` apart, starting at t0. */
function feed(m: FrameMetrics, count: number, intervalMs: number, t0 = 1_000): number {
  let t = t0;
  for (let i = 0; i <= count; i++) {
    m.frame(t);
    t += intervalMs;
  }
  return t - intervalMs;
}

describe("FrameMetrics", () => {
  it("reports nothing before it has seen a second frame", () => {
    const m = new FrameMetrics();
    m.frame(1_000);
    const s = m.snapshot(1_000);
    expect(s.frames).toBe(0);
    expect(s.fps).toBe(0);
  });

  it("computes fps and frame time from a steady stream", () => {
    const m = new FrameMetrics();
    const last = feed(m, 100, 20); // 50 fps exactly
    const s = m.snapshot(last);
    expect(s.frames).toBe(100);
    expect(s.avgFrameMs).toBeCloseTo(20, 5);
    expect(s.medianFrameMs).toBeCloseTo(20, 5);
    expect(s.p95FrameMs).toBeCloseTo(20, 5);
    expect(s.fps).toBeCloseTo(50, 1);
    expect(s.long33).toBe(0);
    expect(s.long50).toBe(0);
  });

  it("separates the tail from the average", () => {
    const m = new FrameMetrics();
    // 95 fast frames and 5 slow ones: the mean barely moves, p95 tells the truth.
    let t = 1_000;
    m.frame(t);
    for (let i = 0; i < 95; i++) {
      t += 10;
      m.frame(t);
    }
    for (let i = 0; i < 5; i++) {
      t += 120;
      m.frame(t);
    }
    const s = m.snapshot(t);
    expect(s.frames).toBe(100);
    expect(s.medianFrameMs).toBeCloseTo(10, 5);
    expect(s.p95FrameMs).toBeGreaterThan(100);
    expect(s.maxFrameMs).toBeCloseTo(120, 5);
    expect(s.long33).toBe(5);
    expect(s.long50).toBe(5);
    // The average alone would read as a comfortable 16 ms and hide the stutter.
    expect(s.avgFrameMs).toBeLessThan(20);
  });

  it("drops the multi-second gap a backgrounded tab produces", () => {
    const m = new FrameMetrics();
    m.frame(1_000);
    m.frame(1_016);
    m.frame(41_016); // 40 s in another app: not a fact about our frame rate
    m.frame(41_032);
    const s = m.snapshot(41_032);
    // The 40 s gap is never recorded, so it cannot become the p95 or the max. The
    // frame before it is real but now sits outside the 10 s window, which leaves one.
    expect(s.maxFrameMs).toBeLessThan(100);
    expect(s.frames).toBe(1);
    expect(s.avgFrameMs).toBeCloseTo(16, 5);
  });

  it("forgets frames older than its window", () => {
    const m = new FrameMetrics(1_000);
    feed(m, 50, 10, 0); // ends at t=500
    const later = feed(m, 50, 10, 5_000); // a second burst, 5 s later
    const s = m.snapshot(later);
    // Only the second burst is inside a 1 s window.
    expect(s.frames).toBe(50);
    expect(s.windowMs).toBeLessThanOrEqual(1_000);
  });

  it("counts rAF callbacks and explicit render requests separately", () => {
    const m = new FrameMetrics();
    let t = 1_000;
    m.frame(t);
    for (let i = 0; i < 60; i++) {
      t += 16;
      m.frame(t);
      m.raf(t);
      // Half the animation frames ask for a render — a 30 Hz cadence on a 60 Hz rAF.
      if (i % 2 === 0) m.renderRequest(t);
    }
    const s = m.snapshot(t);
    expect(s.rafPerSec).toBeGreaterThan(55);
    expect(s.renderRequestsPerSec).toBeGreaterThan(25);
    expect(s.renderRequestsPerSec).toBeLessThan(s.rafPerSec);
  });

  it("averages per-layer CPU cost and resets it each snapshot", () => {
    const m = new FrameMetrics();
    let t = 1_000;
    m.frame(t);
    for (let i = 0; i < 10; i++) {
      t += 16;
      m.frame(t);
      m.cpuFrame(2, 0.5, 1, 0.25);
    }
    const first = m.snapshot(t);
    expect(first.cpu.train).toBeCloseTo(2, 5);
    expect(first.cpu.rail).toBeCloseTo(0.5, 5);
    expect(first.cpu.buildings).toBeCloseTo(1, 5);
    expect(first.cpu.follow).toBeCloseTo(0.25, 5);
    expect(first.cpu.total).toBeCloseTo(3.75, 5);

    // A second read with no new frames must not re-report the same work.
    t += 16;
    m.frame(t);
    const second = m.snapshot(t);
    expect(second.cpu.total).toBe(0);
  });

  it("survives more frames than its buffer holds", () => {
    const m = new FrameMetrics();
    const last = feed(m, 5_000, 1, 0);
    const s = m.snapshot(last);
    expect(s.frames).toBeGreaterThan(0);
    expect(Number.isFinite(s.p95FrameMs)).toBe(true);
    expect(s.medianFrameMs).toBeCloseTo(1, 5);
  });
});
