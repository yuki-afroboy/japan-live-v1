/**
 * Why did the page restart?
 *
 * On an iPhone the app was observed reloading itself during normal use. "Probably iOS
 * memory pressure" is a guess, and a guess cannot be fixed or verified. The renderer
 * process dies without running any of our code, so the only way to learn anything is
 * to write the facts down BEFORE the crash and read them back afterwards.
 *
 * So this keeps a small record in localStorage: a session id, a heartbeat, the last
 * known scene state, and a ring buffer of the events that lead up to an ending. After
 * a restart the previous record is still there, and the difference between "the last
 * thing that happened was pagehide" and "the last thing that happened was a heartbeat
 * while visible" is exactly the difference between a normal navigation and a kill.
 *
 * Everything here is standard DOM API. No Cesium private API is used.
 */

export type StabilityEventKind =
  | "boot"
  | "pagehide"
  | "pageshow"
  | "hidden"
  | "visible"
  | "freeze"
  | "resume"
  | "webgl-lost"
  | "webgl-restored"
  | "error"
  | "rejection"
  | "stall"
  | "beat";

export interface StabilityEvent {
  /** ms since this session booted. */
  t: number;
  kind: StabilityEventKind;
  detail?: string;
}

/** What the scene looked like at the last heartbeat. Written by the controller. */
export interface SceneState {
  wards: number;
  tilesets: number;
  tileMemoryMb: number;
  pendingRequests: number;
  tilesProcessing: number;
  altitude: number;
  trains: number;
  fps: number;
}

export interface StoredSession {
  v: 1;
  id: string;
  startedAt: number;
  /** Wall-clock of the last heartbeat, so uptime survives a kill. */
  lastBeatAt: number;
  /** True once pagehide has been seen — i.e. the browser gave us notice. */
  closedCleanly: boolean;
  navigationType: string;
  state: SceneState | null;
  log: StabilityEvent[];
  /** Sessions that started without the previous one closing cleanly. */
  unexpectedRestarts: number;
  contextLosses: number;
}

export interface PreviousSession {
  id: string;
  uptimeMs: number;
  closedCleanly: boolean;
  lastEvent?: StabilityEvent;
  state: SceneState | null;
  log: StabilityEvent[];
}

export interface StabilitySnapshot {
  sessionId: string;
  uptimeMs: number;
  /** How this document was loaded, per the Navigation Timing API. */
  navigationType: string;
  /** Unexpected restarts observed on this device, cumulative. */
  unexpectedRestarts: number;
  /** WebGL context losses seen, cumulative across sessions on this device. */
  contextLosses: number;
  contextLost: boolean;
  previous?: PreviousSession;
  log: StabilityEvent[];
  storage: "ok" | "unavailable";
  webgl: WebglInfo;
}

export interface WebglInfo {
  version: string;
  vendor?: string;
  renderer?: string;
  maxTextureSize: number;
  /** Stencil bits on the default framebuffer. 0 breaks 3D Tiles skip-LOD selection. */
  stencilBits: number;
  antialias: boolean;
  depth: boolean;
  stencil: boolean;
  drawingBuffer: string;
}

/**
 * What a stored record from the previous run means.
 *
 * Separated from the monitor because this is the only real logic in the file and it
 * is the part a wrong answer would mislead on: "the app restarted itself" and "the
 * user navigated away and came back" produce the same fresh page, and only the
 * absence of a pagehide distinguishes them.
 */
export function previousFrom(prior: StoredSession): PreviousSession {
  return {
    id: prior.id,
    uptimeMs: Math.max(0, prior.lastBeatAt - prior.startedAt),
    closedCleanly: prior.closedCleanly,
    lastEvent: prior.log[prior.log.length - 1],
    state: prior.state,
    log: prior.log,
  };
}

/**
 * Running total of restarts nobody asked for.
 *
 * A record left behind WITHOUT `closedCleanly` means the page went away without the
 * browser giving us a pagehide — a renderer kill, an OOM, a crash. That is the event
 * the user reported, so it is counted and kept across sessions rather than being
 * inferred from navigation type, which reports "reload" for a deliberate pull-to-
 * refresh just as readily.
 */
export function restartCountFrom(prior: StoredSession | null): number {
  if (!prior) return 0;
  return prior.unexpectedRestarts + (prior.closedCleanly ? 0 : 1);
}

const KEY = "japanlive.stability.v1";
const LOG_CAPACITY = 40;
const BEAT_MS = 2_000;

/** localStorage throws in some privacy modes; the app must not care. */
function readStore(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function navigationType(): string {
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return entries[0]?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function readWebglInfo(canvas: HTMLCanvasElement): WebglInfo {
  // Asking the canvas for its context again returns the SAME context it already has,
  // so this observes Cesium's context without creating or touching a second one.
  const gl =
    (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
    (canvas.getContext("webgl") as WebGLRenderingContext | null);
  if (!gl) {
    return {
      version: "none",
      maxTextureSize: 0,
      stencilBits: 0,
      antialias: false,
      depth: false,
      stencil: false,
      drawingBuffer: "0x0",
    };
  }
  const attrs = gl.getContextAttributes();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    version: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
      ? "webgl2"
      : "webgl1",
    vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : undefined,
    renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : undefined,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    stencilBits: Number(gl.getParameter(gl.STENCIL_BITS)) || 0,
    antialias: Boolean(attrs?.antialias),
    depth: Boolean(attrs?.depth),
    stencil: Boolean(attrs?.stencil),
    drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
  };
}

export class StabilityMonitor {
  private readonly startedAt = performance.now();
  private readonly sessionId = Math.random().toString(36).slice(2, 8);
  private readonly log: StabilityEvent[] = [];
  private readonly previous?: PreviousSession;
  private readonly navType = navigationType();
  private readonly canvas: HTMLCanvasElement;
  private readonly onContextChange: (lost: boolean) => void;

  private storageOk = true;
  private unexpectedRestarts = 0;
  private contextLosses = 0;
  private contextLost = false;
  private state: SceneState | null = null;
  private beat = 0;
  private webgl: WebglInfo;
  private destroyed = false;
  /**
   * True once the browser has told us the page is going away.
   *
   * Sticky on purpose. Chrome fires visibilitychange around pagehide, and an ordinary
   * flush from that handler used to write the flag back to false — so a deliberate
   * reload was recorded as an unexpected restart and the counter reported noise
   * instead of crashes. The E2E caught it. Nothing that happens after a pagehide can
   * un-give the notice; only a bfcache restore, which starts the page living again.
   */
  private closed = false;

  constructor(canvas: HTMLCanvasElement, onContextChange: (lost: boolean) => void = () => {}) {
    this.canvas = canvas;
    this.onContextChange = onContextChange;

    const prior = readStore();
    if (prior) {
      this.previous = previousFrom(prior);
      this.unexpectedRestarts = restartCountFrom(prior);
      this.contextLosses = prior.contextLosses;
    }

    this.webgl = readWebglInfo(canvas);
    this.record("boot", `${this.navType} · ${this.webgl.renderer ?? this.webgl.version}`);

    canvas.addEventListener("webglcontextlost", this.onLost, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("error", this.onError);
    window.addEventListener("unhandledrejection", this.onRejection);

    this.beat = window.setInterval(this.heartbeat, BEAT_MS);
    this.flush();
  }

  /**
   * The one piece of real mitigation here: without preventDefault the context is gone
   * for good, and a lost context in Cesium means a permanently blank map. With it the
   * browser may restore it — and either way we now KNOW it happened, which is the
   * difference between a bug report and a shrug.
   */
  private onLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.contextLosses += 1;
    this.record("webgl-lost", this.describeState());
    this.flush();
    this.onContextChange(true);
  };

  private onRestored = (): void => {
    this.contextLost = false;
    this.record("webgl-restored");
    this.flush();
    this.onContextChange(false);
  };

  private onPageHide = (event: PageTransitionEvent): void => {
    this.closed = true;
    this.record("pagehide", event.persisted ? "bfcache" : "unload");
    this.flush();
  };

  private onPageShow = (event: PageTransitionEvent): void => {
    // Restored from the back/forward cache: this page is alive again, so a kill from
    // here on is once more a kill.
    this.closed = false;
    this.record("pageshow", event.persisted ? "from bfcache" : "fresh");
    this.flush();
  };

  private onVisibility = (): void => {
    this.record(document.visibilityState === "hidden" ? "hidden" : "visible");
    this.flush();
  };

  private onError = (event: ErrorEvent): void => {
    this.record("error", String(event.message ?? "error").slice(0, 120));
    this.flush();
  };

  private onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as { message?: string } | undefined;
    this.record("rejection", String(reason?.message ?? reason ?? "rejection").slice(0, 120));
    this.flush();
  };

  private heartbeat = (): void => {
    this.flush();
  };

  /** Called by the scene so the record carries what the app was doing when it died. */
  setState(state: SceneState): void {
    this.state = state;
  }

  /** A frame long enough to be worth remembering after a restart. */
  recordStall(frameMs: number, detail: string): void {
    this.record("stall", `${Math.round(frameMs)}ms ${detail}`);
  }

  private describeState(): string {
    const s = this.state;
    if (!s) return "no scene state";
    return `wards ${s.wards} · tiles ${s.tileMemoryMb.toFixed(0)}MB · alt ${Math.round(s.altitude)}m`;
  }

  private record(kind: StabilityEventKind, detail?: string): void {
    this.log.push({ t: Math.round(performance.now() - this.startedAt), kind, detail });
    if (this.log.length > LOG_CAPACITY) this.log.splice(0, this.log.length - LOG_CAPACITY);
  }

  private flush(): void {
    if (this.destroyed && !this.closed) return;
    const record: StoredSession = {
      v: 1,
      id: this.sessionId,
      startedAt: Date.now() - (performance.now() - this.startedAt),
      lastBeatAt: Date.now(),
      closedCleanly: this.closed,
      navigationType: this.navType,
      state: this.state,
      log: this.log,
      unexpectedRestarts: this.unexpectedRestarts,
      contextLosses: this.contextLosses,
    };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(record));
      this.storageOk = true;
    } catch {
      // Private browsing, or the quota is full. Diagnostics are not worth an exception.
      this.storageOk = false;
    }
  }

  snapshot(): StabilitySnapshot {
    return {
      sessionId: this.sessionId,
      uptimeMs: performance.now() - this.startedAt,
      navigationType: this.navType,
      unexpectedRestarts: this.unexpectedRestarts,
      contextLosses: this.contextLosses,
      contextLost: this.contextLost,
      previous: this.previous,
      log: [...this.log].reverse(),
      storage: this.storageOk ? "ok" : "unavailable",
      webgl: this.webgl,
    };
  }

  /** Re-read WebGL facts after a restore, when the context is a different object. */
  refreshWebgl(): void {
    this.webgl = readWebglInfo(this.canvas);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearInterval(this.beat);
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("error", this.onError);
    window.removeEventListener("unhandledrejection", this.onRejection);
  }
}
