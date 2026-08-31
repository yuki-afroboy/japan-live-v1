# JAPAN LIVE — Architecture

## Goal

Watching Japan move. Not a journey planner, not a status board. The product value is
**SCALE, MOTION, IMMERSION**, constrained absolutely by **DATA INTEGRITY**.

## Layout

```
apps/
  web/            React + TypeScript + Vite + CesiumJS. The experience.
  gateway/        Cloudflare Worker. Hides API keys, adds CORS/cache/rate control.
packages/
  shared/         DataMode, MobilityEntity, Attribution, provider contracts. No deps.
  core/           Geodesy, polyline distance tables, JST time, service days, easing.
  transit/        Static transit model, timetable interpolation, staleness, registry.
  providers/      MobilityProvider implementations. One per operator.
  simulation/     Simulation clock and the entity engine both LIVE and SIM run through.
scripts/data/     Offline GTFS/ODPT -> compact dataset pipeline. Demo dataset builder.
docs/             This file, DATA_SOURCES.md, ROADMAP.md, DECISIONS.md.
```

Dependency direction is strictly one-way:

```
shared  <-  core  <-  transit  <-  providers
                            \         /
                             simulation
                                  |
                              apps/web  ->  apps/gateway (HTTP)
```

`apps/web` never imports a provider-specific module. It consumes `MobilityEntity[]` and
`DataMode`, nothing else.

## The one rule everything is built around

Every moving thing carries a `DataMode`:

```
REALTIME_POSITION | REALTIME_TRIP | REALTIME_STATUS
SCHEDULE_INTERPOLATED | SIMULATED | HISTORICAL | UNAVAILABLE
```

- It is assigned **in the provider adapter**, at the boundary where data enters.
- Nothing downstream may raise it. `transit`, `simulation`, and `web` only read or
  *degrade* it.
- Degradation is time-driven and explicit: `FreshnessPolicy` turns a realtime mode into
  `SCHEDULE_INTERPOLATED` and then `UNAVAILABLE` as `sourceTimestamp` ages.
- V1 produces **no** `REALTIME_POSITION`, because no V1 source publishes true vehicle
  coordinates. See `DATA_SOURCES.md`.

### Where positions come from

ODPT tells us "train 1234 is between 六本木 and 麻布十番". That is *realtime*, but it is
not a *coordinate*. Turning it into a lat/lon is our inference, so:

```
odpt:Train (fromStation, toStation, delay, dc:date)     <- REALTIME_TRIP
        |
        v  resolve station pair -> shape segment
   ShapeIndex.positionAt(distanceAlongLine)             <- our geometry
        |
        v
   MobilityEntity { lat, lon, heading, dataMode: REALTIME_TRIP,
                    positionSource: "INTERPOLATED_FROM_REALTIME_SEGMENT" }
```

`positionSource` is carried separately from `dataMode` so the Inspector and X-Ray can
say precisely how a dot on the screen came to be there.

## Rendering model

One render path. `simulation` and realtime providers both emit `MobilityEntity[]`; the
scene cannot tell them apart except by reading `dataMode`. That is deliberate — it means
SIM mode exercises exactly the code LIVE mode uses.

```
Provider poll (10-30s)  ->  EntityStore  ->  Interpolator (per frame)  ->  Cesium
Simulation tick         ->  EntityStore  ->        "                  ->    "
```

- Providers poll on their own documented cadence. Never per frame.
- Between polls, `Interpolator` advances each entity smoothly toward its next known
  position. It **never advances past** what the data supports — it eases toward the
  reported segment, it does not extrapolate ahead of it.
- Cesium receives batched writes into a `PointPrimitiveCollection` / `BillboardCollection`
  and a small pool of instanced train models. No `Entity` per train.

## LOD

Two independent ladders, both driven by camera altitude and both measured rather than
guessed (`packages/shared/src/lod.ts` holds the thresholds in one place).

| Altitude | Buildings | Trains | Routes | Stations |
| --- | --- | --- | --- | --- |
| > 300 km | off | aggregate glow | trunk only | off |
| 50-300 km | off | points | major | off |
| 10-50 km | off (LOD1 optional) | points | all | major only |
| 2-10 km | Tokyo LOD1/2 | billboards | all | all |
| < 2 km | Tokyo LOD2 | simple 3D car | all | all |

## Time

Two clocks, one interface.

- `LiveClock` — wall clock, always `Asia/Tokyo` for display, UTC internally.
- `SimulationClock` — arbitrary start instant, speed ×1/×10/×60/×600, scrubbable.

The moment speed leaves ×1, the app **is not LIVE** and says `SIMULATION ×N`. Realtime
providers stop polling; the simulation engine drives everything. There is no state in
which live and accelerated data are mixed.

Service days, not calendar days: GTFS `25:14:00` is a real time on the previous service
day. `core/time` owns this and is unit-tested against midnight, post-midnight, and
`>24:00:00` cases.

## Gateway

The browser must never hold an ODPT key. `apps/gateway` is a Cloudflare Worker that:

- injects `acl:consumerKey` server-side from a Worker secret,
- allows only a fixed set of upstream ODPT endpoints (no client-supplied URLs),
- caches 10-20 s so N browsers cost the upstream one request,
- rate-limits inbound per IP and de-duplicates concurrent identical upstream fetches,
- normalizes responses into the common model and **strips every auth field**,
- returns `{ dataMode, sourceTimestamp, fetchedAt, stale }` so the client can be honest,
- logs endpoint/status/latency/counts only, never payloads or keys.

Without a configured gateway the app runs in **DEMO MODE** — full experience, synthetic
data, permanent `DEMO / SIMULATED DATA` badge.

## Failure behaviour

Nothing external is allowed to white-screen the app.

| Failure | Result |
| --- | --- |
| Terrain unavailable | ellipsoid globe, "terrain unavailable" in Data Status |
| Basemap tiles fail | dark globe, app fully usable |
| PLATEAU catalog down | bundled seed tilesets |
| Seed tilesets fail | buildings off, notice shown |
| Gateway down / no key | DEMO MODE, badge shown |
| Realtime feed stale | STALE badge, then degrade to schedule, then UNAVAILABLE |
| Feed returns empty | "no trains reported" — never silently drawn as zero traffic |
