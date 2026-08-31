import { describe, expect, it } from "vitest";
import {
  DATA_MODES,
  DEFAULT_FRESHNESS,
  dataModeDescription,
  dataModeLabel,
  evaluateFreshness,
  formatAge,
  isRealtimeMode,
  isRealtimePosition,
  requiresSourceTimestamp,
} from "@japan-live/shared";
import type { DataMode } from "@japan-live/shared";

describe("DataMode classification", () => {
  it("treats only REALTIME_POSITION as a realtime position", () => {
    expect(isRealtimePosition("REALTIME_POSITION")).toBe(true);
    for (const m of DATA_MODES.filter((m) => m !== "REALTIME_POSITION")) {
      expect(isRealtimePosition(m)).toBe(false);
    }
  });

  it("does NOT treat REALTIME_TRIP as a realtime position", () => {
    // The whole product depends on this distinction. Toei tells us which stations a
    // train is between; it never tells us where the train is.
    expect(isRealtimeMode("REALTIME_TRIP")).toBe(true);
    expect(isRealtimePosition("REALTIME_TRIP")).toBe(false);
  });

  it("does NOT treat SCHEDULE_INTERPOLATED as realtime at all", () => {
    expect(isRealtimeMode("SCHEDULE_INTERPOLATED")).toBe(false);
    expect(isRealtimePosition("SCHEDULE_INTERPOLATED")).toBe(false);
  });

  it("requires a source timestamp for every realtime mode", () => {
    for (const m of DATA_MODES) {
      expect(requiresSourceTimestamp(m)).toBe(isRealtimeMode(m));
    }
  });

  it("gives every mode a label and a description", () => {
    for (const m of DATA_MODES) {
      expect(dataModeLabel(m).length).toBeGreaterThan(0);
      expect(dataModeDescription(m).length).toBeGreaterThan(0);
    }
  });

  it("never labels a non-position mode as a position", () => {
    for (const m of DATA_MODES.filter((m) => !isRealtimePosition(m))) {
      expect(dataModeLabel(m)).not.toBe("REALTIME POSITION");
    }
  });
});

describe("freshness degradation", () => {
  const now = 1_800_000_000_000;
  const fresh = (mode: DataMode, ageMs: number) =>
    evaluateFreshness(mode, now - ageMs, now, DEFAULT_FRESHNESS);

  it("keeps recent realtime data fresh", () => {
    expect(fresh("REALTIME_TRIP", 10_000)).toMatchObject({
      state: "FRESH",
      mode: "REALTIME_TRIP",
    });
  });

  it("marks data stale but keeps the mode at the stale threshold", () => {
    expect(fresh("REALTIME_TRIP", 120_000)).toMatchObject({
      state: "STALE",
      mode: "REALTIME_TRIP",
    });
  });

  it("degrades stale realtime data to schedule, never leaving it realtime", () => {
    const r = fresh("REALTIME_TRIP", 400_000);
    expect(r.state).toBe("DEGRADED");
    expect(r.mode).toBe("SCHEDULE_INTERPOLATED");
    expect(isRealtimeMode(r.mode)).toBe(false);
  });

  it("gives up entirely on very old data", () => {
    expect(fresh("REALTIME_TRIP", 1_000_000)).toMatchObject({
      state: "UNAVAILABLE",
      mode: "UNAVAILABLE",
    });
  });

  it("refuses a realtime claim with no timestamp", () => {
    const r = evaluateFreshness("REALTIME_POSITION", undefined, now);
    expect(r.mode).toBe("UNAVAILABLE");
    expect(r.state).toBe("UNAVAILABLE");
  });

  it("refuses a realtime claim with a non-finite timestamp", () => {
    expect(evaluateFreshness("REALTIME_TRIP", Number.NaN, now).mode).toBe("UNAVAILABLE");
  });

  it("leaves non-realtime modes untouched no matter how old", () => {
    for (const m of ["SCHEDULE_INTERPOLATED", "SIMULATED", "HISTORICAL"] as DataMode[]) {
      const r = evaluateFreshness(m, now - 10_000_000, now);
      expect(r.mode).toBe(m);
      expect(r.state).toBe("FRESH");
    }
  });

  it("never upgrades a mode", () => {
    // Ageing may only reduce confidence. A future timestamp must not promote anything.
    const r = evaluateFreshness("REALTIME_TRIP", now + 60_000, now);
    expect(r.mode).toBe("REALTIME_TRIP");
    expect(r.ageMs).toBe(0);
  });

  it("degrades every realtime mode, not just the one we use", () => {
    for (const m of ["REALTIME_POSITION", "REALTIME_TRIP", "REALTIME_STATUS"] as DataMode[]) {
      expect(isRealtimeMode(fresh(m, 400_000).mode)).toBe(false);
    }
  });
});

describe("formatAge", () => {
  it("renders the Inspector's age strings", () => {
    expect(formatAge(12_000)).toBe("12秒前");
    expect(formatAge(180_000)).toBe("3分前");
    expect(formatAge(3_900_000)).toBe("1時間5分前");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("不明");
  });
});
