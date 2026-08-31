import { formatJstClock, formatJstDate, serviceDayFor, serviceSecondsFor } from "@japan-live/core";

export type ClockMode = "LIVE" | "SIMULATION";

/** The speeds the UI offers. ×1 is the only one compatible with LIVE. */
export const SPEEDS = [1, 10, 60, 600] as const;
export type Speed = (typeof SPEEDS)[number];

export interface ClockState {
  mode: ClockMode;
  speed: Speed;
  /** Simulated instant, epoch ms. Meaningful in SIMULATION; tracks wall clock in LIVE. */
  currentTime: number;
}

/**
 * One clock with two modes.
 *
 * The rule that matters (spec §25, D-006): the instant the speed leaves ×1 the app is
 * no longer LIVE. There is no blended state, because accelerated realtime data is not
 * realtime and a timestamp on screen would mean nothing.
 */
export class SimulationClock {
  private mode: ClockMode = "LIVE";
  private speed: Speed = 1;
  private simTime: number;
  private lastRealTime: number;
  private paused = false;

  constructor(now: number = Date.now()) {
    this.simTime = now;
    this.lastRealTime = now;
  }

  /** Advance. Call once per frame with the real wall clock. */
  tick(realNow: number = Date.now()): void {
    const deltaReal = realNow - this.lastRealTime;
    this.lastRealTime = realNow;

    if (this.mode === "LIVE") {
      this.simTime = realNow;
      return;
    }
    if (!this.paused) {
      this.simTime += deltaReal * this.speed;
    }
  }

  getState(): ClockState {
    return { mode: this.mode, speed: this.speed, currentTime: this.simTime };
  }

  get currentTime(): number {
    return this.simTime;
  }
  get currentMode(): ClockMode {
    return this.mode;
  }
  get currentSpeed(): Speed {
    return this.speed;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  /** True only at ×1 in LIVE. Realtime polling is gated on exactly this. */
  get isLive(): boolean {
    return this.mode === "LIVE" && this.speed === 1;
  }

  /** Return to LIVE. Forces ×1 — the two cannot disagree. */
  goLive(realNow: number = Date.now()): void {
    this.mode = "LIVE";
    this.speed = 1;
    this.paused = false;
    this.simTime = realNow;
    this.lastRealTime = realNow;
  }

  /** Enter SIMULATION at an instant. */
  goSimulation(atTime: number, speed: Speed = 1, realNow: number = Date.now()): void {
    this.mode = "SIMULATION";
    this.speed = speed;
    this.simTime = atTime;
    this.lastRealTime = realNow;
  }

  /**
   * Change speed. Anything but ×1 drops LIVE, keeping the current instant as the
   * simulation's starting point so the transition is continuous on screen.
   */
  setSpeed(speed: Speed, realNow: number = Date.now()): void {
    if (speed !== 1 && this.mode === "LIVE") {
      this.mode = "SIMULATION";
      this.lastRealTime = realNow;
    }
    this.speed = speed;
  }

  setPaused(paused: boolean): void {
    if (this.mode === "SIMULATION") this.paused = paused;
  }

  /** Scrub. Only meaningful in SIMULATION; ignored in LIVE so the live clock can't lie. */
  seek(atTime: number, realNow: number = Date.now()): void {
    if (this.mode === "LIVE") return;
    this.simTime = atTime;
    this.lastRealTime = realNow;
  }

  /** Jump to a service-day second on the current service day. */
  seekServiceSeconds(seconds: number, realNow: number = Date.now()): void {
    if (this.mode === "LIVE") return;
    const day = serviceDayFor(this.simTime);
    this.seek(day.startEpochMs + seconds * 1000, realNow);
  }

  get serviceSeconds(): number {
    return serviceSecondsFor(this.simTime);
  }
  get serviceDay(): ReturnType<typeof serviceDayFor> {
    return serviceDayFor(this.simTime);
  }

  formatClock(withSeconds = true): string {
    return formatJstClock(this.simTime, withSeconds);
  }
  formatDate(): string {
    return formatJstDate(this.simTime);
  }
}
