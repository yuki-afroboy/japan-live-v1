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

/**
 * The V1.2 additions: the tail of the distribution, and Cesium's own two spans.
 *
 * The device report that opened V1.2 had a median of 17 ms and a p95 of 157 ms. An
 * instrument that only reported an average would have called that "42 ms" and sent us
 * looking for a uniform 24 fps problem that does not exist. These assertions exist so
 * the tail cannot silently stop being measured.
 */
describe("FrameMetrics — long-frame tail", () => {
  it("separates p95, p99 and the >100 ms count from the median", () => {
    const m = new FrameMetrics();
    let t = 1_000;
    // 98 fast frames and 2 stalls: a median of 16, a p99 in the stalls.
    const frames = [
      ...Array<number>(98).fill(16),
      150,
      180,
    ];
    for (const dt of frames) {
      t += dt;
      m.frame(t);
    }
    const s = m.snapshot(t);

    expect(s.medianFrameMs).toBe(16);
    expect(s.p99FrameMs).toBeGreaterThanOrEqual(150);
    expect(s.long100).toBe(2);
    expect(s.long50).toBe(2);
    // The average alone would read ~19 ms and hide both stalls entirely.
    expect(s.avgFrameMs).toBeLessThan(25);
  });

  it("counts a 100 ms frame in long33 and long50 as well", () => {
    const m = new FrameMetrics();
    m.frame(1_000);
    m.frame(1_120);
    const s = m.snapshot(1_120);
    expect(s.long33).toBe(1);
    expect(s.long50).toBe(1);
    expect(s.long100).toBe(1);
  });
});

describe("FrameMetrics — Cesium span attribution", () => {
  it("attributes an update-pass stall to update, not to draw", () => {
    const m = new FrameMetrics();
    let t = 1_000;
    for (let i = 0; i < 40; i++) {
      t += 16;
      m.frame(t);
      m.spans(t, 2, 0.2, 6, 0, 0);
    }
    // One frame where the tile processing queue drained inside the update pass.
    t += 160;
    m.frame(t);
    m.spans(t, 148, 0.2, 6, 37, 4);

    const s = m.snapshot(t);
    expect(s.cesium.updateMaxMs).toBe(148);
    expect(s.cesium.renderMaxMs).toBe(6);
    expect(s.cesium.updateLong50).toBe(1);
    expect(s.cesium.renderLong50).toBe(0);
    expect(s.worst?.updateMs).toBe(148);
    expect(s.worst?.tilesProcessing).toBe(37);
  });

  it("attributes a draw stall to draw", () => {
    const m = new FrameMetrics();
    m.spans(1_000, 2, 0.2, 140, 0, 0);
    m.spans(1_150, 2, 0.2, 140, 0, 0);
    const s = m.snapshot(1_150);
    expect(s.cesium.renderLong50).toBe(2);
    expect(s.cesium.updateLong50).toBe(0);
    expect(s.worst?.renderMs).toBe(140);
  });

  /**
   * The finding that made this bucket necessary: on CI's software rasteriser a 713 ms
   * frame contained 0.2 ms of update and 9.8 ms of draw submission. Without `other`,
   * the panel would have reported a 10 ms frame and the 700 ms would have been
   * invisible — and a GPU-bound stall would have been mistaken for a fast one.
   */
  it("charges frame time outside both spans to `other` rather than losing it", () => {
    const m = new FrameMetrics();
    m.raf(1_000);
    m.raf(1_713); // the browser took 713 ms to turn this frame around
    m.spans(1_713, 0.2, 0.1, 9.8, 0, 0);

    const worst = m.snapshot(1_713).worst!;
    expect(worst.frameMs).toBe(713);
    expect(worst.totalMs).toBeCloseTo(10.1, 5);
    expect(worst.otherMs).toBeCloseTo(702.9, 5);
  });

  /**
   * The trap this guards against.
   *
   * With requestRenderMode and a 30 Hz animation cap, two consecutive renders are 33 ms
   * apart on a device that is doing nothing at all in between. Measuring the frame from
   * render to render would charge that idle time to the GPU and report a stall on an
   * idle phone. The browser's own frame period cannot be inflated that way.
   */
  it("measures the frame the browser took, not the gap between throttled renders", () => {
    const m = new FrameMetrics();
    // 60 Hz browser, but the app only renders every other frame.
    m.raf(1_000);
    m.raf(1_016.7);
    m.spans(1_016.7, 0.5, 0.2, 2, 0, 0);
    m.raf(1_033.4);
    m.raf(1_050.1);
    m.spans(1_050.1, 0.5, 0.2, 2, 0, 0);

    const worst = m.snapshot(1_050.1).worst!;
    expect(worst.frameMs).toBeCloseTo(16.7, 1);
    // Not 33 ms, and therefore not ~30 ms of phantom GPU time.
    expect(worst.otherMs).toBeLessThan(15);
  });

  it("ranks the worst frame by the whole frame, not by the spans it can see", () => {
    const m = new FrameMetrics();
    m.raf(1_000);
    m.raf(1_016);
    m.spans(1_016, 1, 0.1, 1, 0, 0);
    // A busy frame: 60 ms of visible work in a 70 ms browser frame.
    m.raf(1_086);
    m.spans(1_086, 40, 0.1, 20, 5, 1);
    // A slow frame: almost no visible work, but the browser took 300 ms. This is the
    // one the user felt.
    m.raf(1_386);
    m.spans(1_386, 1, 0.1, 2, 0, 0);

    const worst = m.snapshot(1_386).worst!;
    expect(worst.frameMs).toBe(300);
    expect(worst.otherMs).toBeGreaterThan(290);
  });

  it("does not invent a frame length for the first frame or after a backgrounded tab", () => {
    const m = new FrameMetrics();
    m.raf(1_000);
    m.spans(1_000, 1, 0.1, 1, 0, 0);
    expect(m.snapshot(1_000).worst?.frameMs).toBe(0);

    const n = new FrameMetrics();
    n.raf(1_000);
    // Five seconds later: the tab was hidden. That is not a five-second frame.
    n.raf(6_000);
    n.spans(6_000, 1, 0.1, 1, 0, 0);
    expect(n.snapshot(6_000).worst?.frameMs).toBe(0);
  });

  it("reports the worst frame once, then starts a new window", () => {
    const m = new FrameMetrics();
    m.spans(1_000, 120, 0.2, 5, 12, 3);
    expect(m.snapshot(1_000).worst?.totalMs).toBeCloseTo(125.2, 5);
    // A stall belongs to the window that reported it; the next window is its own.
    expect(m.snapshot(1_000).worst).toBeNull();
  });

  it("has no span numbers at all before any frame is recorded", () => {
    const m = new FrameMetrics();
    const s = m.snapshot(1_000);
    expect(s.cesium.samples).toBe(0);
    expect(s.worst).toBeNull();
  });
});
