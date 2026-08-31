import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StaticTransitData } from "@japan-live/shared";
import { isRealtimeMode, isRealtimePosition } from "@japan-live/shared";
import { TimetableEngine } from "@japan-live/simulation";

const dataset = JSON.parse(
  readFileSync(resolve(__dirname, "../../../apps/web/public/data/demo-dataset.json"), "utf8"),
) as StaticTransitData;

const NOW = 1_800_000_000_000;

function engine(dataMode: "SIMULATED" | "SCHEDULE_INTERPOLATED" = "SIMULATED") {
  return new TimetableEngine(dataset, { providerId: "demo", dataMode });
}

describe("TimetableEngine", () => {
  it("produces a full rush hour of trains", () => {
    const e = engine().entitiesAt(8 * 3600, NOW);
    expect(e.length).toBeGreaterThan(150);
  });

  it("produces nothing before the service day starts", () => {
    expect(engine().entitiesAt(3 * 3600, NOW)).toHaveLength(0);
  });

  it("NEVER claims a realtime mode from a timetable", () => {
    for (const ent of engine().entitiesAt(8 * 3600, NOW)) {
      expect(isRealtimeMode(ent.dataMode)).toBe(false);
      expect(isRealtimePosition(ent.dataMode)).toBe(false);
    }
  });

  it("tags simulated entities as SIMULATED with a simulated position source", () => {
    const ent = engine("SIMULATED").entitiesAt(8 * 3600, NOW)[0]!;
    expect(ent.dataMode).toBe("SIMULATED");
    expect(ent.positionSource).toBe("SIMULATED");
  });

  it("tags timetable entities as schedule-interpolated, not simulated", () => {
    const ent = engine("SCHEDULE_INTERPOLATED").entitiesAt(8 * 3600, NOW)[0]!;
    expect(ent.dataMode).toBe("SCHEDULE_INTERPOLATED");
    expect(ent.positionSource).toBe("INTERPOLATED_FROM_SCHEDULE");
  });

  it("carries no source timestamp, because a timetable has no observation", () => {
    for (const ent of engine().entitiesAt(8 * 3600, NOW)) {
      expect(ent.sourceTimestamp).toBeUndefined();
    }
  });

  it("gives every entity a usable position and heading", () => {
    for (const ent of engine().entitiesAt(8 * 3600, NOW)) {
      expect(ent.latitude).toBeGreaterThan(35.4);
      expect(ent.latitude).toBeLessThan(36.0);
      expect(ent.longitude).toBeGreaterThan(139.4);
      expect(ent.longitude).toBeLessThan(140.1);
      expect(ent.heading).toBeGreaterThanOrEqual(0);
      expect(ent.heading).toBeLessThan(360);
    }
  });

  it("fills in the details the Inspector shows", () => {
    const ent = engine().entitiesAt(8 * 3600, NOW).find((e) => !e.details?.atStation)!;
    expect(ent.details?.railwayName).toBeTruthy();
    expect(ent.details?.operatorName).toBeTruthy();
    expect(ent.details?.fromStation).toBeTruthy();
    expect(ent.details?.toStation).toBeTruthy();
    expect(ent.details?.lineColor).toMatch(/^#/);
  });

  it("leaves delay undefined rather than reporting a synthetic zero", () => {
    for (const ent of engine().entitiesAt(8 * 3600, NOW)) {
      expect(ent.details?.delaySeconds).toBeUndefined();
    }
  });

  it("moves trains continuously between ticks", () => {
    const e = engine();
    const a = new Map(e.entitiesAt(8 * 3600, NOW).map((x) => [x.id, x]));
    const b = new Map(e.entitiesAt(8 * 3600 + 30, NOW).map((x) => [x.id, x]));
    let moved = 0;
    let teleported = 0;
    for (const [id, ea] of a) {
      const eb = b.get(id);
      if (!eb) continue;
      const d = Math.hypot((eb.longitude! - ea.longitude!) * 90_000, (eb.latitude! - ea.latitude!) * 111_000);
      if (d > 1) moved++;
      if (d > 3_000) teleported++;
    }
    expect(moved).toBeGreaterThan(50);
    expect(teleported).toBe(0);
  });

  it("filters to selected railways", () => {
    const only = new Set(["Toei.Oedo"]);
    const e = new TimetableEngine(dataset, {
      providerId: "demo",
      dataMode: "SIMULATED",
      railwayIds: only,
    });
    const out = e.entitiesAt(8 * 3600, NOW);
    expect(out.length).toBeGreaterThan(0);
    for (const ent of out) expect(ent.routeId).toBe("Toei.Oedo");
  });

  it("respects the entity cap", () => {
    const e = new TimetableEngine(dataset, {
      providerId: "demo",
      dataMode: "SIMULATED",
      maxEntities: 25,
    });
    expect(e.entitiesAt(8 * 3600, NOW).length).toBeLessThanOrEqual(25);
  });

  it("runs trains after midnight on service-day seconds", () => {
    expect(engine().entitiesAt(24 * 3600 + 20 * 60, NOW).length).toBeGreaterThan(0);
  });
});
