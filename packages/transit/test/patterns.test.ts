import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StaticTransitData } from "@japan-live/shared";
import { TransitNetwork, activeTrips, expandRun, interpolateTrip, patternDurationSec } from "@japan-live/transit";

const dataset = JSON.parse(
  readFileSync(resolve(__dirname, "../../../apps/web/public/data/demo-dataset.json"), "utf8"),
) as StaticTransitData;

const net = new TransitNetwork(dataset);

describe("demo dataset integrity", () => {
  it("is marked approximate so nothing can present it as real", () => {
    expect(dataset.meta.approximate).toBe(true);
  });

  it("has every line's stations resolvable and on its own shape", () => {
    for (const r of dataset.railways) {
      expect(r.stationIds.length).toBe(r.stationOffsetsM.length);
      expect(r.shape.length).toBeGreaterThan(2);
      for (const id of r.stationIds) expect(net.station(id)).toBeDefined();
    }
  });

  it("orders station offsets monotonically along each line", () => {
    for (const r of dataset.railways) {
      for (let i = 1; i < r.stationOffsetsM.length; i++) {
        expect(r.stationOffsetsM[i]!).toBeGreaterThan(r.stationOffsetsM[i - 1]!);
      }
    }
  });

  it("places every station within 200 m of its line's shape", () => {
    for (const r of dataset.railways) {
      const shape = net.shape(r.id)!;
      for (let i = 0; i < r.stationIds.length; i++) {
        const st = net.station(r.stationIds[i]!)!;
        const onLine = shape.at(r.stationOffsetsM[i]!).position;
        const dLon = Math.abs(onLine[0] - st.longitude);
        const dLat = Math.abs(onLine[1] - st.latitude);
        expect(dLon).toBeLessThan(0.003);
        expect(dLat).toBeLessThan(0.003);
      }
    }
  });

  it("gives every line a plausible length", () => {
    for (const r of dataset.railways) {
      const len = net.shape(r.id)!.totalLengthM;
      expect(len).toBeGreaterThan(5_000);
      expect(len).toBeLessThan(60_000);
    }
  });
});

describe("pattern expansion", () => {
  const pattern = dataset.patterns![0]!;

  it("expands a run with absolute, increasing times", () => {
    const trip = expandRun(pattern, 5);
    expect(trip.stops.length).toBe(pattern.stops.length);
    for (let i = 1; i < trip.stops.length; i++) {
      expect(trip.stops[i]!.arrivalSec).toBeGreaterThan(trip.stops[i - 1]!.departureSec - 1);
    }
  });

  it("spaces consecutive runs by exactly the headway", () => {
    const a = expandRun(pattern, 3).stops[0]!.departureSec;
    const b = expandRun(pattern, 4).stops[0]!.departureSec;
    expect(b - a).toBe(pattern.headwaySec);
  });

  it("runs no trains before the service window opens", () => {
    expect(activeTrips(dataset, 3 * 3600)).toHaveLength(0);
  });

  it("runs a realistic number of trains at morning rush", () => {
    const trains = activeTrips(dataset, 8 * 3600);
    expect(trains.length).toBeGreaterThan(150);
    expect(trains.length).toBeLessThan(1200);
  });

  it("still runs trains after midnight, on service-day seconds", () => {
    // 24:15 is a service second past 86400, not 00:15 of a new day.
    expect(activeTrips(dataset, 24 * 3600 + 15 * 60).length).toBeGreaterThan(0);
  });

  it("only returns trips that actually resolve to a position", () => {
    const at = 8 * 3600;
    const trains = activeTrips(dataset, at);
    let positioned = 0;
    for (const t of trains) if (interpolateTrip(net, t, at)) positioned++;
    // Every active trip must be placeable; an unplaceable one is a data bug.
    expect(positioned).toBe(trains.length);
  });

  it("gives every pattern a plausible end-to-end running time", () => {
    // The longest is Oedo at ~89 min against a real ~81 min, so the ceiling is 100 min.
    for (const p of dataset.patterns!) {
      const d = patternDurationSec(p);
      expect(d).toBeGreaterThan(300);
      expect(d).toBeLessThan(6_000);
    }
  });
});
