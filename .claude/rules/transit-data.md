---
paths:
  - "packages/transit/**"
  - "packages/providers/**"
  - "scripts/data/**"
---

# Transit data rules (packages/transit, packages/providers, scripts/data)

## GTFS correctness

- Parse GTFS by spec, not by assumption: `stop_times` sequences may have gaps,
  `shape_dist_traveled` is optional, `trips` may lack a `shape_id`, and files such as
  `frequencies.txt` and `calendar_dates.txt` may or may not exist.
- Resolve service days through both `calendar.txt` and `calendar_dates.txt`. Exceptions
  override the weekly pattern.
- `arrival_time` / `departure_time` can exceed 24:00:00. Treat them as seconds after the
  service day start, not as wall-clock times.
- Validate referential integrity when ingesting (trip to route, stop_time to stop and
  trip, shape points ordered). Reject or quarantine a bad feed; never half-load it.

## GTFS-RT correctness

- Handle the three entity types separately and honestly:
  `VehiclePosition` → `REALTIME_POSITION`, `TripUpdate` → `REALTIME_TRIP`,
  `Alert` → `REALTIME_STATUS`.
- **A feed offering GTFS-RT does not mean it publishes VehiclePosition.** Confirm per
  feed, per operator, and record what it actually publishes in `docs/DATA_SOURCES.md`.
- Respect `FeedHeader.timestamp` and per-entity timestamps. Data older than the feed's
  freshness budget is stale — degrade it, do not display it as current.
- Honor `incrementality`. Handle DIFFERENTIAL feeds correctly or reject them explicitly;
  do not treat a differential feed as a full snapshot.
- Match realtime entities to static trips on the trip's service day, not on today's date.

## Time and service days

- All internal time is UTC or an explicit instant. Convert at the edges only.
- Japan is JST (UTC+9), no daylight saving. Never assume the host machine's zone; use an
  explicit zone identifier.
- The service day is not the calendar day: late-night trips belong to the previous
  service day. Compute the service day explicitly before any timetable lookup.

## Shape-based interpolation

- Interpolate position along the route shape, never as a straight line between stops.
- Build a cumulative-distance table for each shape once, then map progress to a point on
  the polyline. Interpolate heading from the shape tangent.
- Anything positioned this way is `SCHEDULE_INTERPOLATED`, always — even when the
  timetable is exact, and even when a realtime delay refined the estimate.
- Off-shape, past-terminus, or ambiguous progress yields `null` position with
  `UNAVAILABLE`, not a clamped guess.

## DataMode integrity

- Assign `DataMode` in the provider adapter, at the point data enters the system.
  Downstream code reads it; downstream code never raises it.
- Every realtime mode carries the observation timestamp it was derived from.
- Degrade explicitly on staleness. There is no implicit "probably still fine".
- Simulation produces `SIMULATED` and normalizes into the same mobility model as real
  data — same shape, same fields, different mode.

## Null rather than invented data

- Unknown means `null` plus `UNAVAILABLE`. Never substitute a default, a last-known
  value presented as current, a zero, or a plausible-looking estimate.
- Do not fill gaps by averaging, extrapolating past the data's validity, or copying a
  sibling vehicle's state.
- Log dropped or unparseable records with counts, so silent data loss is visible.

## Provider separation

- One adapter per provider under `packages/providers`, each exposing the same interface.
- Provider quirks — field names, auth, pagination, rate limits, ID formats, encodings —
  stay inside the adapter. Nothing above it may branch on provider identity.
- `packages/transit` holds the common mobility model and provider-neutral logic only.
- Adding a provider must not require changing UI code.

## Source verification

- Before implementing against a feed, verify endpoint, auth, fields, update frequency,
  license, and attribution against current official primary documentation.
  Run `/data-source-audit` and record the result in `docs/DATA_SOURCES.md`.
- Never hardcode credentials in `scripts/data` or in fixtures. Read them from the
  environment.
- Commit small, redacted fixtures for tests. Do not commit bulk feed dumps.
