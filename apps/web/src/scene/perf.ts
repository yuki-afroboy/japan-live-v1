/**
 * Frame-timing metrics.
 *
 * Exists because "the app feels heavy on my iPhone" is not something a headless
 * SwiftShader run can answer. The numbers a CI container produces are useful only as a
 * relative regression signal; the ones that decide whether this product is pleasant to
 * use come from a real GPU. So the measurement lives in the app itself, reads on the
 * device, and costs almost nothing to keep running.
 *
 * Cost control: recording a frame is two array writes and an integer bump. Everything
 * expensive — sorting for percentiles — happens only when a snapshot is asked for,
 * which the HUD does at 2 Hz.
 */

export interface PerfSnapshot {
  /** Frames actually rendered per second over the window. */
  fps: number;
  avgFrameMs: number;
  medianFrameMs: number;
  p95FrameMs: number;
  /** Frames that took longer than 33 ms (below 30 fps). */
  long33: number;
  /** Frames that took longer than 50 ms (a visible hitch). */
  long50: number;
  /** Worst single frame in the window. */
  maxFrameMs: number;
  frames: number;
  /** Actual length of the window the numbers cover, in ms. */
  windowMs: number;
  /** requestAnimationFrame callbacks per second — the ceiling the browser offers. */
  rafPerSec: number;
  /** Renders the app explicitly asked for, per second. */
  renderRequestsPerSec: number;
  /**
   * Mean CPU milliseconds per frame spent inside each layer's own update.
   *
   * This is the half of the budget we write. Whatever is left between the sum of
   * these and avgFrameMs is the browser's: culling, draw submission, rasterisation,
   * compositing. Without the split, a slow frame is unattributable — and on a
   * software rasteriser it looks like everything is the renderer's fault when it may
   * be several hundred CSS colour strings being parsed per frame.
   */
  cpu: { train: number; rail: number; buildings: number; follow: number; total: number };
}

const EMPTY: PerfSnapshot = {
  fps: 0,
  avgFrameMs: 0,
  medianFrameMs: 0,
  p95FrameMs: 0,
  long33: 0,
  long50: 0,
  maxFrameMs: 0,
  frames: 0,
  windowMs: 0,
  rafPerSec: 0,
  renderRequestsPerSec: 0,
  cpu: { train: 0, rail: 0, buildings: 0, follow: 0, total: 0 },
};

/** 10 s at 120 fps still fits, and the buffer never grows after construction. */
const CAPACITY = 1_280;

export class FrameMetrics {
  private readonly stamps = new Float64Array(CAPACITY);
  private readonly intervals = new Float64Array(CAPACITY);
  /** Scratch for percentile sorting, so a snapshot allocates nothing. */
  private readonly scratch = new Float64Array(CAPACITY);
  private head = 0;
  private size = 0;
  private last = 0;

  private rafStamps = new Float64Array(CAPACITY);
  private rafHead = 0;
  private rafSize = 0;

  private requestStamps = new Float64Array(CAPACITY);
  private requestHead = 0;
  private requestSize = 0;

  /** Summed CPU cost since the last snapshot, divided by frames when read. */
  private cpuTrain = 0;
  private cpuRail = 0;
  private cpuBuildings = 0;
  private cpuFollow = 0;
  private cpuFrames = 0;

  constructor(private readonly windowMs = 10_000) {}

  /** One rendered frame. Called from Cesium's preRender. */
  frame(now: number): void {
    if (this.last > 0) {
      const dt = now - this.last;
      // A tab that was backgrounded produces a multi-second "frame" that is not a
      // performance fact about this app. Drop it rather than poisoning p95.
      if (dt > 0 && dt < 2_000) {
        this.stamps[this.head] = now;
        this.intervals[this.head] = dt;
        this.head = (this.head + 1) % CAPACITY;
        if (this.size < CAPACITY) this.size++;
      }
    }
    this.last = now;
  }

  /** One requestAnimationFrame callback. */
  raf(now: number): void {
    this.rafStamps[this.rafHead] = now;
    this.rafHead = (this.rafHead + 1) % CAPACITY;
    if (this.rafSize < CAPACITY) this.rafSize++;
  }

  /**
   * CPU spent in the layer updates of one frame. Called once per frame with the four
   * measured spans, so the caller does the timing and this only accumulates.
   */
  cpuFrame(train: number, rail: number, buildings: number, follow: number): void {
    this.cpuTrain += train;
    this.cpuRail += rail;
    this.cpuBuildings += buildings;
    this.cpuFollow += follow;
    this.cpuFrames += 1;
  }

  /** One explicit scene.requestRender() from our own code. */
  renderRequest(now: number): void {
    this.requestStamps[this.requestHead] = now;
    this.requestHead = (this.requestHead + 1) % CAPACITY;
    if (this.requestSize < CAPACITY) this.requestSize++;
  }

  /** Frames dropped from the window are simply never counted again. */
  snapshot(now: number): PerfSnapshot {
    const cutoff = now - this.windowMs;
    let n = 0;
    let sum = 0;
    let max = 0;
    let long33 = 0;
    let long50 = 0;
    let oldest = now;

    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + CAPACITY * 2) % CAPACITY;
      const t = this.stamps[idx]!;
      if (t < cutoff) break;
      const dt = this.intervals[idx]!;
      this.scratch[n++] = dt;
      sum += dt;
      if (dt > max) max = dt;
      if (dt > 33) long33++;
      if (dt > 50) long50++;
      oldest = t - dt;
    }

    if (n === 0) return EMPTY;

    const span = Math.max(1, now - oldest);
    const window = this.scratch.subarray(0, n);
    // subarray shares the buffer, so this sorts the scratch in place — intended.
    window.sort();

    return {
      fps: (n / span) * 1000,
      avgFrameMs: sum / n,
      medianFrameMs: window[Math.floor(n * 0.5)]!,
      p95FrameMs: window[Math.min(n - 1, Math.floor(n * 0.95))]!,
      long33,
      long50,
      maxFrameMs: max,
      frames: n,
      windowMs: Math.round(span),
      rafPerSec: countSince(this.rafStamps, this.rafHead, this.rafSize, cutoff, span),
      renderRequestsPerSec: countSince(
        this.requestStamps,
        this.requestHead,
        this.requestSize,
        cutoff,
        span,
      ),
      cpu: this.drainCpu(),
    };
  }

  /** Means since the previous snapshot, then reset — so the numbers track the window. */
  private drainCpu(): PerfSnapshot["cpu"] {
    const f = Math.max(1, this.cpuFrames);
    const cpu = {
      train: this.cpuTrain / f,
      rail: this.cpuRail / f,
      buildings: this.cpuBuildings / f,
      follow: this.cpuFollow / f,
      total: (this.cpuTrain + this.cpuRail + this.cpuBuildings + this.cpuFollow) / f,
    };
    this.cpuTrain = 0;
    this.cpuRail = 0;
    this.cpuBuildings = 0;
    this.cpuFollow = 0;
    this.cpuFrames = 0;
    return cpu;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.last = 0;
    this.rafHead = 0;
    this.rafSize = 0;
    this.requestHead = 0;
    this.requestSize = 0;
    this.cpuTrain = 0;
    this.cpuRail = 0;
    this.cpuBuildings = 0;
    this.cpuFollow = 0;
    this.cpuFrames = 0;
  }
}

function countSince(
  stamps: Float64Array,
  head: number,
  size: number,
  cutoff: number,
  spanMs: number,
): number {
  let n = 0;
  for (let i = 0; i < size; i++) {
    const idx = (head - 1 - i + CAPACITY * 2) % CAPACITY;
    if (stamps[idx]! < cutoff) break;
    n++;
  }
  return (n / Math.max(1, spanMs)) * 1000;
}
