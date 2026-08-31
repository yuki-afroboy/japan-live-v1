import { describe, expect, it } from "vitest";
import { haversineM } from "@japan-live/core";
import type { StaticTransitData } from "@japan-live/shared";
import {
  TransitNetwork,
  interpolateBetweenStations,
  interpolateTrip,
  createSmoothedState,
  retarget,
  sample,
} from "@japan-live/transit";

/**
 * A three-station line with a deliberate dog-leg, so a straight-line shortcut between
 * the end stations is geometrically distinguishable from following the track.
 */
function fixture(): StaticTransitData {
  return {
    meta: {
      id: "test",
      name: "test",
      builtAt: 0,
      approximate: true,
      attribution: "test",
    },
    railways: [
      {
        id: "L1",
        name: "Test Line",
        operatorId: "OP",
        operatorName: "Test Operator",
        color: "#ff0000",
        stationIds: ["S1", "S2", "S3"],
        // East 1000 m-ish, then north.
        shape: [
          [139.700, 35.680],
          [139.710, 35.680],
          [139.710, 35.690],
        ],
        stationOffsetsM: [0, 0, 0], // replaced below
        underground: false,
      },
    ],
    stations: [
      { id: "S1", name: "S1", latitude: 35.680, longitude: 139.700, railwayIds: ["L1"], major: false },
      { id: "S2", name: "S2", latitude: 35.680, longitude: 139.710, railwayIds: ["L1"], major: false },
      { id: "S3", name: "S3", latitude: 35.690, longitude: 139.710, railwayIds: ["L1"], major: false },
    ],
    trips: [
      {
        id: "T1",
        railwayId: "L1",
        direction: 1,
        trainNumber: "101",
        serviceId: "weekday",
        stops: [
          { stationId: "S1", arrivalSec: 25_140, departureSec: 25_200 }, // 06:59 / 07:00
          { stationId: "S2", arrivalSec: 25_320, departureSec: 25_380 }, // 07:02 / 07:03
          { stationId: "S3", arrivalSec: 25_500, departureSec: 25_560 }, // 07:05 / 07:06
        ],
      },
    ],
  };
}

function buildNetwork(): TransitNetwork {
  const data = fixture();
  // Place stations at their true distance along the shape.
  const probe = new TransitNetwork(data);
  const shape = probe.shape("L1")!;
  data.railways[0]!.stationOffsetsM = [
    shape.nearestDistanceTo([139.700, 35.680]),
    shape.nearestDistanceTo([139.710, 35.680]),
    shape.nearestDistanceTo([139.710, 35.690]),
  ];
  return new TransitNetwork(data);
}

const net = buildNetwork();
const trip = net.trip("T1")!;

describe("interpolateTrip", () => {
  it("returns null before the first departure", () => {
    expect(interpolateTrip(net, trip, 25_000)).toBeNull();
  });

  it("returns null after the last arrival", () => {
    expect(interpolateTrip(net, trip, 30_000)).toBeNull();
  });

  it("sits at the origin station while dwelling", () => {
    const p = interpolateTrip(net, trip, 25_170)!;
    expect(p.atStation).toBe(true);
    expect(p.fromStationId).toBe("S1");
    expect(p.speedMps).toBe(0);
    expect(p.position[0]).toBeCloseTo(139.700, 5);
  });

  it("is between S1 and S2 mid-run", () => {
    const p = interpolateTrip(net, trip, 25_260)!;
    expect(p.atStation).toBe(false);
    expect(p.fromStationId).toBe("S1");
    expect(p.toStationId).toBe("S2");
    expect(p.segmentProgress).toBeGreaterThan(0);
    expect(p.segmentProgress).toBeLessThan(1);
  });

  it("arrives exactly at S2", () => {
    const p = interpolateTrip(net, trip, 25_320)!;
    expect(p.fromStationId).toBe("S2");
    expect(p.atStation).toBe(true);
    expect(haversineM(p.position, [139.710, 35.680])).toBeLessThan(1);
  });

  it("follows the track around the corner instead of cutting the chord", () => {
    // Midway between S2 and S3 the train must be on the northbound leg
    // (lon ~139.710), not on a diagonal from S1.
    const p = interpolateTrip(net, trip, 25_440)!;
    expect(p.position[0]).toBeCloseTo(139.710, 4);
    expect(p.position[1]).toBeGreaterThan(35.680);
    expect(p.position[1]).toBeLessThan(35.690);
  });

  it("faces east on the first leg and north on the second", () => {
    expect(interpolateTrip(net, trip, 25_260)!.heading).toBeCloseTo(90, 0);
    expect(interpolateTrip(net, trip, 25_440)!.heading).toBeCloseTo(0, 0);
  });

  it("reverses heading for a down train", () => {
    const down = { ...trip, direction: -1 as const };
    expect(interpolateTrip(net, down, 25_260)!.heading).toBeCloseTo(270, 0);
  });

  it("advances monotonically along the line for the whole trip", () => {
    let prev = -1;
    for (let s = 25_200; s <= 25_500; s += 5) {
      const p = interpolateTrip(net, trip, s);
      if (!p) continue;
      expect(p.distanceM).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = p.distanceM;
    }
  });

  it("starts and finishes each segment at zero speed", () => {
    expect(interpolateTrip(net, trip, 25_201)!.speedMps).toBeLessThan(2);
    expect(interpolateTrip(net, trip, 25_319)!.speedMps).toBeLessThan(2);
    expect(interpolateTrip(net, trip, 25_260)!.speedMps!).toBeGreaterThan(3);
  });

  it("returns null when the line has no shape rather than inventing one", () => {
    const data = fixture();
    data.railways[0]!.shape = [];
    expect(interpolateTrip(new TransitNetwork(data), trip, 25_260)).toBeNull();
  });

  it("returns null when a stop is not on the line", () => {
    const data = fixture();
    data.railways[0]!.stationIds = ["S1", "S3"];
    data.railways[0]!.stationOffsetsM = [0, 100];
    expect(interpolateTrip(new TransitNetwork(data), trip, 25_260)).toBeNull();
  });

  it("handles a post-midnight service time past 86400", () => {
    const data = fixture();
    data.trips[0]!.stops = [
      { stationId: "S1", arrivalSec: 90_000, departureSec: 90_060 }, // 25:00 / 25:01
      { stationId: "S2", arrivalSec: 90_240, departureSec: 90_300 },
      { stationId: "S3", arrivalSec: 90_480, departureSec: 90_540 },
    ];
    const n = new TransitNetwork(data);
    expect(interpolateTrip(n, n.trip("T1")!, 90_150)).not.toBeNull();
    expect(interpolateTrip(n, n.trip("T1")!, 80_000)).toBeNull();
  });
});

describe("interpolateBetweenStations (realtime segment)", () => {
  it("places a train on the track between the two reported stations", () => {
    const p = interpolateBetweenStations(net, "L1", "S1", "S2", 0.5)!;
    expect(p.position[1]).toBeCloseTo(35.680, 5);
    expect(p.position[0]).toBeGreaterThan(139.700);
    expect(p.position[0]).toBeLessThan(139.710);
  });

  it("sits at the station when only fromStation is reported", () => {
    const p = interpolateBetweenStations(net, "L1", "S2", undefined, 0)!;
    expect(p.atStation).toBe(true);
    expect(haversineM(p.position, [139.710, 35.680])).toBeLessThan(1);
  });

  it("returns null for a station that is not on the line", () => {
    expect(interpolateBetweenStations(net, "L1", "S1", "NOPE", 0.5)).toBeNull();
    expect(interpolateBetweenStations(net, "NOPE", "S1", "S2", 0.5)).toBeNull();
  });

  it("faces backwards when travelling against the shape direction", () => {
    const p = interpolateBetweenStations(net, "L1", "S2", "S1", 0.5)!;
    expect(p.heading).toBeCloseTo(270, 0);
  });

  it("clamps progress rather than running past the segment", () => {
    const over = interpolateBetweenStations(net, "L1", "S1", "S2", 5)!;
    const at = interpolateBetweenStations(net, "L1", "S1", "S2", 1)!;
    expect(over.distanceM).toBeCloseTo(at.distanceM, 6);
  });
});

describe("smoothing between polls", () => {
  it("eases toward a new position instead of teleporting", () => {
    let s = createSmoothedState([139.700, 35.680], 90, 0, 10_000);
    s = retarget(s, [139.705, 35.680], 90, 0);
    const mid = sample(s, 5_000);
    expect(mid.position[0]).toBeGreaterThan(139.700);
    expect(mid.position[0]).toBeLessThan(139.705);
  });

  it("stops at the target and never runs ahead of the data", () => {
    let s = createSmoothedState([139.700, 35.680], 90, 0, 10_000);
    s = retarget(s, [139.705, 35.680], 90, 0);
    // Long after the ease should have finished, it is still exactly on the target.
    expect(sample(s, 60_000).position[0]).toBeCloseTo(139.705, 9);
    expect(sample(s, 600_000).position[0]).toBeCloseTo(139.705, 9);
  });

  it("snaps rather than sliding across the city on a large correction", () => {
    let s = createSmoothedState([139.700, 35.680], 90, 0, 10_000);
    s = retarget(s, [139.900, 35.800], 90, 0);
    expect(sample(s, 1).position[0]).toBeCloseTo(139.900, 6);
  });
});
