import type { StaticTransitData, Trip, TripPattern } from "@japan-live/shared";

/** Total running time of one run of a pattern, in seconds. */
export function patternDurationSec(pattern: TripPattern): number {
  const last = pattern.stops[pattern.stops.length - 1];
  return last ? last.departureOffsetSec : 0;
}

/** How many runs this pattern makes across its service window. */
export function patternRunCount(pattern: TripPattern): number {
  if (pattern.headwaySec <= 0) return 1;
  const span = pattern.lastDepartureSec - pattern.firstDepartureSec;
  return Math.max(1, Math.floor(span / pattern.headwaySec) + 1);
}

/** Materialize run `index` of a pattern into a concrete Trip with absolute times. */
export function expandRun(pattern: TripPattern, index: number): Trip {
  const departure = pattern.firstDepartureSec + index * pattern.headwaySec;
  return {
    id: `${pattern.id}#${index}`,
    railwayId: pattern.railwayId,
    direction: pattern.direction,
    // Train numbers are synthetic for a synthetic timetable, and the UI says so.
    trainNumber: `${String(index + 1).padStart(3, "0")}${pattern.direction === 1 ? "A" : "B"}`,
    trainType: pattern.trainType,
    destinationStationId: pattern.destinationStationId,
    serviceId: pattern.serviceId,
    stops: pattern.stops.map((s) => ({
      stationId: s.stationId,
      arrivalSec: departure + s.arrivalOffsetSec,
      departureSec: departure + s.departureOffsetSec,
    })),
  };
}

/**
 * Every run of every pattern that is in motion at `serviceSec`.
 *
 * This is the hot path: it is called each simulation tick, so it walks only the runs
 * whose window can contain `serviceSec` rather than expanding the whole day.
 */
export function activeTrips(
  data: StaticTransitData,
  serviceSec: number,
  filter?: (pattern: TripPattern) => boolean,
): Trip[] {
  const out: Trip[] = [];

  for (const trip of data.trips) {
    const first = trip.stops[0];
    const last = trip.stops[trip.stops.length - 1];
    if (!first || !last) continue;
    if (serviceSec >= first.arrivalSec && serviceSec <= last.departureSec) out.push(trip);
  }

  for (const pattern of data.patterns ?? []) {
    if (filter && !filter(pattern)) continue;
    if (pattern.stops.length < 2) continue;

    const duration = patternDurationSec(pattern);
    // A run departing at D is active while serviceSec is in [D, D + duration].
    // So the runs to check are those departing in [serviceSec - duration, serviceSec].
    const earliest = serviceSec - duration;
    const headway = pattern.headwaySec > 0 ? pattern.headwaySec : duration || 1;

    let startIndex = Math.floor((earliest - pattern.firstDepartureSec) / headway);
    if (startIndex < 0) startIndex = 0;
    const runCount = patternRunCount(pattern);

    for (let i = startIndex; i < runCount; i++) {
      const departure = pattern.firstDepartureSec + i * headway;
      if (departure > serviceSec) break;
      if (departure + duration < serviceSec) continue;
      out.push(expandRun(pattern, i));
    }
  }

  return out;
}
