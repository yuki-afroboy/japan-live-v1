#!/usr/bin/env node
/**
 * Build the DEMO dataset.
 *
 * Produces a StaticTransitData JSON from the approximate geometry in
 * `tokyo-rail-source.mjs`. Everything it emits is `approximate: true` and is rendered
 * as SIMULATED. It exists so JAPAN LIVE runs with no credentials (spec §41-43); it is
 * not, and never claims to be, real operator data.
 *
 *   node scripts/data/build-demo-dataset.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, ROMAJI, STATIONS, displayName } from "./tokyo-rail-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../apps/web/public/data/demo-dataset.json");

const EARTH_R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;

function haversineM([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Catmull-Rom spline through the station points.
 *
 * Real track is curved, and a polyline of straight station-to-station hops looks like a
 * schematic rather than a railway. This is a stand-in for GTFS `shapes.txt`: it is
 * plausible track geometry, not surveyed track geometry, and the dataset says so.
 */
function splineThrough(points, samplesPerSegment = 12, tension = 0.5) {
  if (points.length < 3) return points.slice();
  const out = [points[0]];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const coord = (a, b, c, d) =>
        0.5 *
        (2 * b +
          (-a + c) * t * (2 * tension) +
          (2 * a - 5 * b + 4 * c - d) * t2 * (2 * tension) +
          (-a + 3 * b - 3 * c + d) * t3 * (2 * tension));
      out.push([
        coord(p0[0], p1[0], p2[0], p3[0]),
        coord(p0[1], p1[1], p2[1], p3[1]),
      ]);
    }
  }
  return out;
}

/** Distance along a polyline of the vertex nearest to `target`. */
function offsetOf(shape, cumulative, target) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const d = haversineM(shape[i], target);
    if (d < bestDist) {
      bestDist = d;
      best = cumulative[i];
    }
  }
  return best;
}

const SERVICE_START = 5 * 3600; // 05:00
const SERVICE_END = 24 * 3600 + 30 * 60; // 24:30 — a service second, not a clock time
const ALL_DAYS = 0b1111111;

const stationsOut = new Map();
const railwaysOut = [];
const patternsOut = [];

for (const line of LINES) {
  const coords = line.stations.map((key) => {
    const s = STATIONS[key];
    if (!s) throw new Error(`${line.id}: unknown station ${key}`);
    return [s[0], s[1]];
  });

  const shape = splineThrough(coords);
  const cumulative = [0];
  for (let i = 1; i < shape.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(shape[i - 1], shape[i]));
  }

  const stationIds = [];
  const stationOffsetsM = [];

  for (let i = 0; i < line.stations.length; i++) {
    const key = line.stations[i];
    const src = STATIONS[key];
    const name = displayName(key);
    // Interchanges share one station id so the network graph stays connected.
    const id = `st.${name}`;

    const existing = stationsOut.get(id);
    if (existing) {
      if (!existing.railwayIds.includes(line.id)) existing.railwayIds.push(line.id);
      if (src[2]) existing.major = true;
    } else {
      stationsOut.set(id, {
        id,
        name,
        nameEn: ROMAJI[name],
        latitude: src[1],
        longitude: src[0],
        railwayIds: [line.id],
        major: Boolean(src[2]),
      });
    }

    stationIds.push(id);
    stationOffsetsM.push(offsetOf(shape, cumulative, coords[i]));
  }

  railwaysOut.push({
    id: line.id,
    name: line.name,
    nameEn: line.nameEn,
    operatorId: line.operatorId,
    operatorName: line.operatorName,
    color: line.color,
    stationIds,
    shape: shape.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
    stationOffsetsM: stationOffsetsM.map((v) => Number(v.toFixed(1))),
    underground: line.underground,
  });

  // Timetable: run times from inter-station distance at the line's average speed,
  // floored so no hop is implausibly quick.
  const mps = (line.avgSpeedKmh * 1000) / 3600;

  for (const direction of [1, -1]) {
    const order = direction === 1 ? stationIds : [...stationIds].reverse();
    const offsets = direction === 1 ? stationOffsetsM : [...stationOffsetsM].reverse();

    const stops = [];
    let t = 0;
    for (let i = 0; i < order.length; i++) {
      if (i > 0) {
        const spanM = Math.abs(offsets[i] - offsets[i - 1]);
        t += Math.max(60, Math.round(spanM / mps));
      }
      const arrivalOffsetSec = t;
      const departureOffsetSec = i === order.length - 1 ? t : t + line.dwellSec;
      t = departureOffsetSec;
      stops.push({ stationId: order[i], arrivalOffsetSec, departureOffsetSec });
    }

    patternsOut.push({
      id: `${line.id}.${direction === 1 ? "up" : "down"}`,
      railwayId: line.id,
      direction,
      serviceId: "demo.allday",
      trainType: "各駅停車",
      destinationStationId: order[order.length - 1],
      stops,
      firstDepartureSec: SERVICE_START,
      lastDepartureSec: SERVICE_END,
      headwaySec: line.headwaySec,
    });
  }
}

const dataset = {
  meta: {
    id: "demo.tokyo.v1",
    name: "DEMO dataset (approximate geometry, synthetic timetable)",
    builtAt: Date.now(),
    approximate: true,
    note:
      "実在の運行データではありません。路線形状・駅位置は概算、時刻表は自動生成です。" +
      "実データは scripts/data/build-gtfs-dataset.mjs で置き換えてください。",
    attribution: "JAPAN LIVE demo dataset — not operator data",
  },
  railways: railwaysOut,
  stations: [...stationsOut.values()],
  trips: [],
  patterns: patternsOut,
  serviceCalendar: { "demo.allday": ALL_DAYS },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(dataset));

const shapePoints = railwaysOut.reduce((a, r) => a + r.shape.length, 0);
const runs = patternsOut.reduce(
  (a, p) => a + Math.floor((p.lastDepartureSec - p.firstDepartureSec) / p.headwaySec) + 1,
  0,
);
const sizeKb = (JSON.stringify(dataset).length / 1024).toFixed(0);

console.log(`DEMO dataset -> ${OUT}`);
console.log(`  railways        ${railwaysOut.length}`);
console.log(`  stations        ${stationsOut.size}`);
console.log(`  shape points    ${shapePoints}`);
console.log(`  patterns        ${patternsOut.length}`);
console.log(`  runs/day        ${runs}`);
console.log(`  size            ${sizeKb} KB`);
console.log(`  approximate     true  (rendered as SIMULATED)`);
