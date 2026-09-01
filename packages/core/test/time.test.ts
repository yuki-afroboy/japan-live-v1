import { describe, expect, it } from "vitest";
import {
  epochForServiceSeconds,
  formatJstClock,
  formatServiceTime,
  fromJstParts,
  parseGtfsTime,
  serviceDayFor,
  serviceRunsOn,
  serviceSecondsFor,
  toJstParts,
  WEEKDAY_MASK,
  WEEKEND_MASK,
} from "@japan-live/core";

describe("JST conversion", () => {
  it("reads calendar fields in JST regardless of host timezone", () => {
    // 2026-08-18T00:00:00Z is 09:00 JST the same day.
    const p = toJstParts(Date.UTC(2026, 7, 18, 0, 0, 0));
    expect(p).toMatchObject({ year: 2026, month: 8, day: 18, hour: 9, minute: 0 });
  });

  it("crosses the date line into the next JST day", () => {
    // 2026-08-17T15:00:00Z is 2026-08-18 00:00 JST.
    const p = toJstParts(Date.UTC(2026, 7, 17, 15, 0, 0));
    expect(p).toMatchObject({ year: 2026, month: 8, day: 18, hour: 0 });
  });

  it("round-trips fromJstParts", () => {
    const ms = fromJstParts(2026, 8, 18, 7, 30, 15);
    expect(formatJstClock(ms)).toBe("07:30:15");
  });

  it("formats midnight JST as 00:00", () => {
    expect(formatJstClock(fromJstParts(2026, 8, 18, 0, 0, 0))).toBe("00:00:00");
  });
});

describe("service day", () => {
  it("assigns a normal daytime instant to the same date", () => {
    const day = serviceDayFor(fromJstParts(2026, 8, 18, 14, 0, 0));
    expect(day).toMatchObject({ year: 2026, month: 8, day: 18 });
  });

  it("assigns 01:30 to the PREVIOUS service day", () => {
    const day = serviceDayFor(fromJstParts(2026, 8, 18, 1, 30, 0));
    expect(day).toMatchObject({ year: 2026, month: 8, day: 17 });
  });

  it("expresses post-midnight time as service seconds beyond 86400", () => {
    const at = fromJstParts(2026, 8, 18, 1, 30, 0);
    const day = serviceDayFor(at);
    const secs = serviceSecondsFor(at, day);
    expect(secs).toBe(25 * 3600 + 30 * 60);
    expect(secs).toBeGreaterThan(86_400);
  });

  it("rolls back across a month boundary", () => {
    const day = serviceDayFor(fromJstParts(2026, 9, 1, 0, 45, 0));
    expect(day).toMatchObject({ year: 2026, month: 8, day: 31 });
  });

  it("rolls back across a year boundary", () => {
    const day = serviceDayFor(fromJstParts(2027, 1, 1, 2, 0, 0));
    expect(day).toMatchObject({ year: 2026, month: 12, day: 31 });
  });

  it("treats 03:00 as the start of the new service day", () => {
    expect(serviceDayFor(fromJstParts(2026, 8, 18, 3, 0, 0)).day).toBe(18);
    expect(serviceDayFor(fromJstParts(2026, 8, 18, 2, 59, 59)).day).toBe(17);
  });

  it("uses the service day's weekday, not the wall-clock weekday", () => {
    // 2026-08-17 is a Monday; 01:30 on Tuesday the 18th is still Monday's service.
    const day = serviceDayFor(fromJstParts(2026, 8, 18, 1, 30, 0));
    expect(day.weekday).toBe(1);
    expect(serviceRunsOn(WEEKDAY_MASK, day.weekday)).toBe(true);
    expect(serviceRunsOn(WEEKEND_MASK, day.weekday)).toBe(false);
  });

  it("round-trips service seconds back to an instant", () => {
    const at = fromJstParts(2026, 8, 18, 1, 30, 0);
    const day = serviceDayFor(at);
    expect(epochForServiceSeconds(day, serviceSecondsFor(at, day))).toBe(at);
  });
});

describe("GTFS times", () => {
  it("parses a normal time", () => {
    expect(parseGtfsTime("07:30:00")).toBe(27_000);
  });

  it("parses times past 24:00:00", () => {
    expect(parseGtfsTime("25:14:00")).toBe(90_840);
    expect(parseGtfsTime("24:00:00")).toBe(86_400);
  });

  it("accepts a single-digit hour", () => {
    expect(parseGtfsTime("7:30:00")).toBe(27_000);
  });

  it("returns null rather than guessing at malformed input", () => {
    for (const bad of ["", "7:30", "07:60:00", "07:30:99", "abc", "-1:00:00"]) {
      expect(parseGtfsTime(bad)).toBeNull();
    }
  });

  it("renders service times the way a timetable does", () => {
    expect(formatServiceTime(90_840)).toBe("25:14");
    expect(formatServiceTime(90_840, true)).toBe("25:14:00");
    expect(formatServiceTime(27_000)).toBe("07:30");
  });
});
