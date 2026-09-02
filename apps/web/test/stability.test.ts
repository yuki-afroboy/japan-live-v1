import { describe, expect, it } from "vitest";
import {
  previousFrom,
  restartCountFrom,
  type StoredSession,
} from "../src/scene/stability.js";

/**
 * The reload record is the only evidence we will ever have about a crash.
 *
 * The page that dies does not get to run any code, so everything depends on the record
 * written before it and read after it. If this arithmetic is wrong, the panel confidently
 * reports "0 unexpected restarts" on a device that restarted six times — which is worse
 * than reporting nothing, because it would close the investigation.
 */
function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    v: 1,
    id: "abc123",
    startedAt: 1_000_000,
    lastBeatAt: 1_042_000,
    closedCleanly: false,
    navigationType: "navigate",
    state: null,
    log: [],
    unexpectedRestarts: 0,
    contextLosses: 0,
    ...overrides,
  };
}

describe("restartCountFrom", () => {
  it("is zero on a device that has never run the app", () => {
    expect(restartCountFrom(null)).toBe(0);
  });

  it("counts a record left behind without a pagehide as an unexpected restart", () => {
    expect(restartCountFrom(session({ closedCleanly: false }))).toBe(1);
  });

  it("does not count a session the browser told us was ending", () => {
    expect(restartCountFrom(session({ closedCleanly: true }))).toBe(0);
  });

  it("accumulates across sessions rather than resetting each load", () => {
    expect(restartCountFrom(session({ unexpectedRestarts: 4, closedCleanly: false }))).toBe(5);
    expect(restartCountFrom(session({ unexpectedRestarts: 4, closedCleanly: true }))).toBe(4);
  });
});

describe("previousFrom", () => {
  it("reports how long the previous session survived", () => {
    const previous = previousFrom(session({ startedAt: 1_000_000, lastBeatAt: 1_042_000 }));
    expect(previous.uptimeMs).toBe(42_000);
  });

  it("never reports negative uptime when the clock moved backwards", () => {
    const previous = previousFrom(session({ startedAt: 2_000_000, lastBeatAt: 1_000_000 }));
    expect(previous.uptimeMs).toBe(0);
  });

  it("surfaces the last thing that happened before the session ended", () => {
    const previous = previousFrom(
      session({
        log: [
          { t: 0, kind: "boot" },
          { t: 8_000, kind: "stall", detail: "168ms upd 152" },
        ],
      }),
    );
    expect(previous.lastEvent?.kind).toBe("stall");
    expect(previous.lastEvent?.detail).toContain("168ms");
  });

  it("carries the scene state the session died holding", () => {
    const previous = previousFrom(
      session({
        state: {
          wards: 3,
          tilesets: 3,
          tileMemoryMb: 187,
          pendingRequests: 9,
          tilesProcessing: 22,
          altitude: 620,
          trains: 348,
          fps: 23.5,
        },
      }),
    );
    expect(previous.state?.tileMemoryMb).toBe(187);
    expect(previous.state?.tilesProcessing).toBe(22);
  });
});
