#!/usr/bin/env node
/**
 * Build a REAL dataset from ODPT, replacing the demo dataset.
 *
 * Run this on a machine that can reach api.odpt.org, with a consumer key:
 *
 *   ODPT_CONSUMER_KEY=xxxx node scripts/data/build-gtfs-dataset.mjs
 *   ODPT_CONSUMER_KEY=xxxx node scripts/data/build-gtfs-dataset.mjs --operators Toei,TokyoMetro
 *
 * It writes apps/web/public/data/odpt-dataset.json and prints the VITE_DATASET_URL to
 * set. The output is marked `approximate: false`, so the UI stops labelling the data
 * as a demo and station matching uses exact ODPT ids instead of romanized names.
 *
 * The key is read from the environment and is never written to the output.
 *
 * Preprocessing happens here, not in the browser (spec §44): the app should load a
 * compact JSON, not parse operator feeds on every page view.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../apps/web/public/data/odpt-dataset.json");
const API = "https://api.odpt.org/api/v4";

const KEY = process.env.ODPT_CONSUMER_KEY;
if (!KEY) {
  console.error("ODPT_CONSUMER_KEY is not set.");
  console.error("Register at https://developer.odpt.org/ and export the key, e.g.:");
  console.error("  ODPT_CONSUMER_KEY=xxxx node scripts/data/build-gtfs-dataset.mjs");
  process.exit(1);
}

const argOperators = process.argv.indexOf("--operators");
const OPERATORS =
  argOperators >= 0 && process.argv[argOperators + 1]
    ? process.argv[argOperators + 1].split(",")
    : ["Toei", "TokyoMetro"];

const EARTH_R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
const haversineM = ([lon1, lat1], [lon2, lat2]) => {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
};

async function odpt(type, params = {}) {
  const url = new URL(`${API}/${type}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("acl:consumerKey", KEY);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    // Never echo the URL: it carries the key.
    throw new Error(`${type} failed with HTTP ${res.status}`);
  }
  return res.json();
}

const local = (uri) => (typeof uri === "string" ? uri.split(":").pop() : undefined);
const title = (v) => (typeof v === "string" ? v : (v?.ja ?? v?.en));

/** Parse a GTFS-style HH:MM:SS, allowing hours past 24. Returns null on anything else. */
function parseTime(value) {
  const m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Catmull-Rom through the station points, used only when a line has no published shape. */
function splineThrough(points, samplesPerSegment = 10) {
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
      const c = (a, b, cc, d) =>
        0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

const stationsOut = new Map();
const railwaysOut = [];
const tripsOut = [];
const warnings = [];
let usedPublishedShapes = 0;
let usedGeneratedShapes = 0;

for (const operator of OPERATORS) {
  const operatorUri = `odpt.Operator:${operator}`;
  console.log(`\n--- ${operator} ---`);

  const [railways, stations] = await Promise.all([
    odpt("odpt:Railway", { "odpt:operator": operatorUri }),
    odpt("odpt:Station", { "odpt:operator": operatorUri }),
  ]);
  console.log(`  railways ${railways.length}  stations ${stations.length}`);

  const stationByUri = new Map();
  for (const s of stations) {
    const uri = s["owl:sameAs"] ?? s["@id"];
    if (!uri) continue;
    const lat = s["geo:lat"];
    const lon = s["geo:long"];
    // A station with no coordinate cannot be placed. Skip it rather than invent one.
    if (typeof lat !== "number" || typeof lon !== "number") {
      warnings.push(`station without coordinates: ${uri}`);
      continue;
    }
    stationByUri.set(uri, {
      id: `st.${uri}`,
      odptId: uri,
      name: title(s["odpt:stationTitle"]) ?? s["dc:title"] ?? local(uri),
      nameEn: s["odpt:stationTitle"]?.en,
      latitude: lat,
      longitude: lon,
      railwayIds: [],
      major: false,
    });
  }

  for (const railway of railways) {
    const railwayUri = railway["owl:sameAs"] ?? railway["@id"];
    const railwayId = local(railwayUri) ? railwayUri.split(":").pop() : undefined;
    if (!railwayId) continue;

    const order = (railway["odpt:stationOrder"] ?? [])
      .slice()
      .sort((a, b) => (a["odpt:index"] ?? 0) - (b["odpt:index"] ?? 0));

    const stationIds = [];
    const coords = [];
    for (const entry of order) {
      const uri = entry["odpt:station"];
      const station = stationByUri.get(uri);
      if (!station) {
        warnings.push(`${railwayId}: station ${uri} missing or has no coordinates`);
        continue;
      }
      if (!stationsOut.has(station.id)) stationsOut.set(station.id, station);
      const stored = stationsOut.get(station.id);
      if (!stored.railwayIds.includes(railwayId)) stored.railwayIds.push(railwayId);
      stationIds.push(station.id);
      coords.push([station.longitude, station.latitude]);
    }
    if (stationIds.length < 2) continue;

    // Prefer a published shape; fall back to a spline through the stations and record
    // which was used, so the dataset can say how good its geometry is.
    let shape;
    const published = railway["ug:region"]?.coordinates;
    if (Array.isArray(published) && published.length > 2) {
      shape = published.map(([lon, lat]) => [lon, lat]);
      usedPublishedShapes++;
    } else {
      shape = splineThrough(coords);
      usedGeneratedShapes++;
    }

    const cumulative = [0];
    for (let i = 1; i < shape.length; i++) {
      cumulative.push(cumulative[i - 1] + haversineM(shape[i - 1], shape[i]));
    }
    const offsetOf = (target) => {
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
    };

    railwaysOut.push({
      id: railwayId,
      name: title(railway["odpt:railwayTitle"]) ?? railway["dc:title"] ?? railwayId,
      nameEn: railway["odpt:railwayTitle"]?.en,
      operatorId: operator,
      operatorName: operator,
      color: railway["odpt:color"] ?? "#7fd1ff",
      stationIds,
      shape: shape.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
      stationOffsetsM: coords.map((c) => Number(offsetOf(c).toFixed(1))),
      underground: true,
    });
  }

  // Timetables. These are large, so they are fetched per railway.
  for (const railway of railwaysOut.filter((r) => r.operatorId === operator)) {
    let timetables = [];
    try {
      timetables = await odpt("odpt:TrainTimetable", {
        "odpt:railway": `odpt.Railway:${railway.id}`,
      });
    } catch (err) {
      warnings.push(`${railway.id}: timetable unavailable (${err.message})`);
      continue;
    }

    let kept = 0;
    for (const tt of timetables) {
      const objects = tt["odpt:trainTimetableObject"] ?? [];
      const stops = [];
      for (const o of objects) {
        const uri = o["odpt:departureStation"] ?? o["odpt:arrivalStation"];
        const stationId = uri ? `st.${uri}` : undefined;
        if (!stationId || !stationsOut.has(stationId)) continue;
        const dep = parseTime(o["odpt:departureTime"]);
        const arr = parseTime(o["odpt:arrivalTime"]);
        const arrivalSec = arr ?? dep;
        const departureSec = dep ?? arr;
        // A stop with no usable time is dropped; it is not interpolated into existence.
        if (arrivalSec === null || departureSec === null) continue;
        stops.push({ stationId, arrivalSec, departureSec });
      }
      if (stops.length < 2) continue;

      const first = railway.stationIds.indexOf(stops[0].stationId);
      const last = railway.stationIds.indexOf(stops[stops.length - 1].stationId);
      tripsOut.push({
        id: local(tt["owl:sameAs"] ?? tt["@id"]) ?? `${railway.id}.${tripsOut.length}`,
        railwayId: railway.id,
        direction: last >= first ? 1 : -1,
        trainNumber: tt["odpt:trainNumber"] ?? "",
        trainType: local(tt["odpt:trainType"]),
        destinationStationId: (tt["odpt:destinationStation"] ?? [])[0]
          ? `st.${(tt["odpt:destinationStation"] ?? [])[0]}`
          : undefined,
        serviceId: local(tt["odpt:calendar"]) ?? "Weekday",
        stops,
      });
      kept++;
    }
    console.log(`  ${railway.name}: ${kept} trips`);
  }
}

const dataset = {
  meta: {
    id: `odpt.${OPERATORS.join("-")}`,
    name: `ODPT ${OPERATORS.join(" + ")} (${new Date().toISOString().slice(0, 10)})`,
    builtAt: Date.now(),
    // Only claim non-approximate geometry when every line had a published shape.
    approximate: usedGeneratedShapes > 0,
    note:
      usedGeneratedShapes > 0
        ? `${usedGeneratedShapes} 路線は公式の路線形状が取得できなかったため、駅座標から生成した近似形状を使用しています。`
        : undefined,
    attribution: "公共交通オープンデータセンター",
  },
  railways: railwaysOut,
  stations: [...stationsOut.values()],
  trips: tripsOut,
  patterns: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(dataset));

console.log(`\nODPT dataset -> ${OUT}`);
console.log(`  railways         ${railwaysOut.length}`);
console.log(`  stations         ${stationsOut.size}`);
console.log(`  trips            ${tripsOut.length}`);
console.log(`  published shapes ${usedPublishedShapes}`);
console.log(`  generated shapes ${usedGeneratedShapes}`);
console.log(`  size             ${(JSON.stringify(dataset).length / 1024 / 1024).toFixed(1)} MB`);
if (warnings.length) {
  console.log(`\n  ${warnings.length} warnings (first 10):`);
  for (const w of warnings.slice(0, 10)) console.log(`    - ${w}`);
}
console.log(`\nSet this in apps/web/.env.local to use it:`);
console.log(`  VITE_DATASET_URL=data/odpt-dataset.json`);
