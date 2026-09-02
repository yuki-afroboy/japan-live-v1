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
  /** Frames that took longer than 100 ms (a stall, not a slow frame). */
  long100: number;
  p99FrameMs: number;
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
  /**
   * Cesium's own halves of the frame, which our per-layer CPU split cannot see.
   *
   * `update` is scene.preUpdate -> scene.postUpdate: the pass-invariant work plus
   * globe update, the 3D Tiles preload passes and — the reason this exists —
   * Cesium3DTileset.prePassesUpdate, which parses and uploads every queued tile with
   * no per-frame time budget. `render` is the end of our own preRender handler to
   * scene.postRender: draw-command execution plus Cesium's after-render callbacks.
   *
   * A 150 ms frame is either update-dominant or render-dominant, and those have
   * completely different fixes. Averages hide that; these do not.
   */
  cesium: {
    updateAvgMs: number;
    updateP95Ms: number;
    updateMaxMs: number;
    renderAvgMs: number;
    renderP95Ms: number;
    renderMaxMs: number;
    /** Frames whose update pass alone exceeded 50 ms. */
    updateLong50: number;
    /** Frames whose render pass alone exceeded 50 ms. */
    renderLong50: number;
    samples: number;
  };
  /** The single most expensive frame in the window, broken down. Null before any. */
  worst: WorstFrame | null;
}

/** One frame, attributed. Kept so a stall can be named rather than described. */
export interface WorstFrame {
  /**
   * The browser's animation-frame period around this render, rAF to rAF.
   *
   * Deliberately NOT the interval between rendered frames. With requestRenderMode and
   * a 30 Hz animation cap, consecutive renders are ~33 ms apart even when the device
   * is completely idle between them, and subtracting our spans from that would charge
   * 30 ms of doing nothing to the GPU. The rAF period is what the browser actually
   * took to turn one frame around, so what is left after our spans is real work.
   */
  frameMs: number;
  /** updateMs + ourMs + renderMs — the part we can see. */
  totalMs: number;
  updateMs: number;
  /** Our own preRender handler: the layer updates. */
  ourMs: number;
  renderMs: number;
  /**
   * Time inside the browser's frame that is in neither span: GPU execution, buffer
   * swap, compositing, and anything else on the main thread that is not ours.
   *
   * This is not a rounding error. Measured on CI's software rasteriser, a 713 ms frame
   * had 0.2 ms of update and 9.8 ms of draw submission in it — 700 ms of it was here.
   * A stall that lands in `other` cannot be fixed by scheduling work differently; it is
   * pixels, overdraw or geometry. One that lands in `update` is tile processing. The
   * whole point of the split is that those two have nothing in common.
   */
  otherMs: number;
  /** 3D Tiles waiting to be parsed and uploaded when this frame ran. */
  tilesProcessing: number;
  pendingRequests: number;
}

const EMPTY: PerfSnapshot = {
  fps: 0,
  avgFrameMs: 0,
  medianFrameMs: 0,
  p95FrameMs: 0,
  long33: 0,
  long50: 0,
  long100: 0,
  p99FrameMs: 0,
  maxFrameMs: 0,
  frames: 0,
  windowMs: 0,
  rafPerSec: 0,
  renderRequestsPerSec: 0,
  cpu: { train: 0, rail: 0, buildings: 0, follow: 0, total: 0 },
  cesium: {
    updateAvgMs: 0,
    updateP95Ms: 0,
    updateMaxMs: 0,
    renderAvgMs: 0,
    renderP95Ms: 0,
    renderMaxMs: 0,
    updateLong50: 0,
    renderLong50: 0,
    samples: 0,
  },
  worst: null,
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

  /** Cesium's update and render spans, one entry per frame. */
  private readonly updateMs = new Float64Array(CAPACITY);
  private readonly renderMs = new Float64Array(CAPACITY);
  private readonly spanStamps = new Float64Array(CAPACITY);
  /** Own scratch, so sorting spans can never disturb the frame percentiles. */
  private readonly updateScratch = new Float64Array(CAPACITY);
  private readonly renderScratch = new Float64Array(CAPACITY);
  private spanHead = 0;
  private spanSize = 0;

  /** The worst frame seen since the last snapshot, with its attribution intact. */
  private worst: WorstFrame | null = null;
  private lastRafAt = 0;
  private lastRafIntervalMs = 0;

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
    if (this.lastRafAt > 0) {
      const dt = now - this.lastRafAt;
      // A backgrounded tab produces a multi-second gap that is not a frame.
      this.lastRafIntervalMs = dt > 0 && dt < 2_000 ? dt : 0;
    }
    this.lastRafAt = now;
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

  /**
   * One frame's Cesium spans, recorded at postRender so all three belong to the same
   * scene.render() call rather than being smeared across two.
   *
   * `tilesProcessing` and `pendingRequests` ride along because the whole point is to
   * find out whether the long frames coincide with tile content arriving. A stall with
   * 40 tiles in the processing queue and one with an empty queue are different bugs.
   */
  spans(
    now: number,
    updateMs: number,
    ourMs: number,
    renderMs: number,
    tilesProcessing: number,
    pendingRequests: number,
  ): void {
    this.spanStamps[this.spanHead] = now;
    this.updateMs[this.spanHead] = updateMs;
    this.renderMs[this.spanHead] = renderMs;
    this.spanHead = (this.spanHead + 1) % CAPACITY;
    if (this.spanSize < CAPACITY) this.spanSize++;

    const frameMs = this.lastRafIntervalMs;
    const total = updateMs + ourMs + renderMs;
    // Ranked by the whole frame where we have one: a stall that happens outside both
    // spans is still the stall the user felt, and picking the worst by span total would
    // report a busy frame instead of the slow one.
    const rank = frameMs > 0 ? frameMs : total;
    const currentRank = this.worst
      ? this.worst.frameMs > 0
        ? this.worst.frameMs
        : this.worst.totalMs
      : -1;
    if (rank > currentRank) {
      this.worst = {
        frameMs,
        totalMs: total,
        updateMs,
        ourMs,
        renderMs,
        otherMs: frameMs > 0 ? Math.max(0, frameMs - total) : 0,
        tilesProcessing,
        pendingRequests,
      };
    }
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
    let long100 = 0;
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
      if (dt > 100) long100++;
      oldest = t - dt;
    }

    // No rendered frames in the window does not mean nothing happened: a single frame
    // long enough to swallow the whole window still has spans, and that is precisely
    // the case worth seeing.
    if (n === 0) {
      return { ...EMPTY, cesium: this.cesiumSpans(cutoff), worst: this.drainWorst() };
    }

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
      long100,
      p99FrameMs: window[Math.min(n - 1, Math.floor(n * 0.99))]!,
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
      cesium: this.cesiumSpans(cutoff),
      worst: this.drainWorst(),
    };
  }

  /**
   * Percentiles over the two Cesium spans.
   *
   * Sorted separately from the frame intervals because they answer a different
   * question: not "how bad was the worst frame" but "which half of the frame was it".
   */
  private cesiumSpans(cutoff: number): PerfSnapshot["cesium"] {
    let n = 0;
    let updateSum = 0;
    let renderSum = 0;
    let updateMax = 0;
    let renderMax = 0;
    let updateLong50 = 0;
    let renderLong50 = 0;

    for (let i = 0; i < this.spanSize; i++) {
      const idx = (this.spanHead - 1 - i + CAPACITY * 2) % CAPACITY;
      if (this.spanStamps[idx]! < cutoff) break;
      const u = this.updateMs[idx]!;
      const r = this.renderMs[idx]!;
      this.updateScratch[n] = u;
      this.renderScratch[n] = r;
      n++;
      updateSum += u;
      renderSum += r;
      if (u > updateMax) updateMax = u;
      if (r > renderMax) renderMax = r;
      if (u > 50) updateLong50++;
      if (r > 50) renderLong50++;
    }

    if (n === 0) return EMPTY.cesium;

    const updates = this.updateScratch.subarray(0, n);
    const renders = this.renderScratch.subarray(0, n);
    updates.sort();
    renders.sort();
    const p95 = Math.min(n - 1, Math.floor(n * 0.95));

    return {
      updateAvgMs: updateSum / n,
      updateP95Ms: updates[p95]!,
      updateMaxMs: updateMax,
      renderAvgMs: renderSum / n,
      renderP95Ms: renders[p95]!,
      renderMaxMs: renderMax,
      updateLong50,
      renderLong50,
      samples: n,
    };
  }

  /** The worst frame belongs to the window that reported it, so it resets with it. */
  private drainWorst(): WorstFrame | null {
    const worst = this.worst;
    this.worst = null;
    return worst;
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
    this.spanHead = 0;
    this.spanSize = 0;
    this.worst = null;
    this.lastRafAt = 0;
    this.lastRafIntervalMs = 0;
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
