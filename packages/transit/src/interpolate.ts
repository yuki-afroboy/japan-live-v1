import { trainProgress, trainSpeedFactor, type LonLat } from "@japan-live/core";
import type { Trip } from "@japan-live/shared";
import type { TransitNetwork } from "./network.js";

/**
 * A resolved position along a route, plus how it was arrived at.
 * `null` is a legitimate and common answer — a trip that is not running, a station pair
 * that is not on the line, a shape that is missing. We return null; we never guess.
 */
export interface InterpolatedPosition {
  position: LonLat;
  heading: number;
  distanceM: number;
  /** 0..1 within the current station-to-station segment. */
  segmentProgress: number;
  fromStationId: string;
  toStationId?: string;
  /** True when the vehicle is dwelling at `fromStationId`. */
  atStation: boolean;
  /** Metres per second, derived from the timetable's own distance and duration. */
  speedMps?: number;
}

/**
 * Where is this trip at `serviceSec`?
 *
 * Returns null before the first departure and after the last arrival — a train that is
 * not running does not get drawn somewhere plausible.
 */
export function interpolateTrip(
  network: TransitNetwork,
  trip: Trip,
  serviceSec: number,
): InterpolatedPosition | null {
  const stops = trip.stops;
  if (stops.length < 2) return null;

  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  // A train dwelling at its origin platform before departure is running and visible;
  // one that has terminated is not. Bracket on arrival at the first stop, not departure.
  if (serviceSec < first.arrivalSec || serviceSec > last.departureSec) return null;

  const shape = network.shape(trip.railwayId);
  if (!shape) return null;

  // Find the stop pair bracketing `serviceSec`.
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;

    // Dwelling at a station.
    if (serviceSec >= a.arrivalSec && serviceSec <= a.departureSec) {
      const offset = network.stationOffset(trip.railwayId, a.stationId);
      if (offset === undefined) return null;
      const pt = shape.at(offset);
      return {
        position: pt.position,
        heading: headingFor(shape, offset, trip.direction),
        distanceM: offset,
        segmentProgress: 0,
        fromStationId: a.stationId,
        toStationId: b.stationId,
        atStation: true,
        speedMps: 0,
      };
    }

    // Running between a and b.
    if (serviceSec > a.departureSec && serviceSec < b.arrivalSec) {
      const fromOffset = network.stationOffset(trip.railwayId, a.stationId);
      const toOffset = network.stationOffset(trip.railwayId, b.stationId);
      if (fromOffset === undefined || toOffset === undefined) return null;

      const runSec = b.arrivalSec - a.departureSec;
      if (runSec <= 0) return null;

      const t = (serviceSec - a.departureSec) / runSec;
      // Accelerate, cruise, brake — not a constant slide (spec §15).
      const eased = trainProgress(t);
      const distanceM = fromOffset + (toOffset - fromOffset) * eased;

      const spanM = Math.abs(toOffset - fromOffset);
      const peakMps = spanM > 0 ? (spanM / runSec) / 0.75 : 0;

      return {
        position: shape.at(distanceM).position,
        heading: headingFor(shape, distanceM, trip.direction),
        distanceM,
        segmentProgress: eased,
        fromStationId: a.stationId,
        toStationId: b.stationId,
        atStation: false,
        speedMps: peakMps * trainSpeedFactor(t),
      };
    }
  }

  // Dwelling at the final stop.
  if (serviceSec >= last.arrivalSec) {
    const offset = network.stationOffset(trip.railwayId, last.stationId);
    if (offset === undefined) return null;
    return {
      position: shape.at(offset).position,
      heading: headingFor(shape, offset, trip.direction),
      distanceM: offset,
      segmentProgress: 1,
      fromStationId: last.stationId,
      atStation: true,
      speedMps: 0,
    };
  }

  return null;
}

/**
 * Position a train reported as "between station A and station B" by a realtime feed.
 *
 * This is the Toei case. The feed is realtime; the coordinate is ours. `progress` is a
 * caller-supplied estimate of how far along the segment the train is — when the feed
 * gives no basis for one, pass 0.5 and the UI reports the position as segment-level.
 */
export function interpolateBetweenStations(
  network: TransitNetwork,
  railwayId: string,
  fromStationId: string,
  toStationId: string | undefined,
  progress: number,
  direction: 1 | -1 = 1,
): InterpolatedPosition | null {
  const shape = network.shape(railwayId);
  if (!shape) return null;

  const fromOffset = network.stationOffset(railwayId, fromStationId);
  if (fromOffset === undefined) return null;

  if (!toStationId) {
    return {
      position: shape.at(fromOffset).position,
      heading: headingFor(shape, fromOffset, direction),
      distanceM: fromOffset,
      segmentProgress: 0,
      fromStationId,
      atStation: true,
      speedMps: 0,
    };
  }

  const toOffset = network.stationOffset(railwayId, toStationId);
  if (toOffset === undefined) return null;

  const clamped = Math.max(0, Math.min(1, progress));
  const eased = trainProgress(clamped);
  const distanceM = fromOffset + (toOffset - fromOffset) * eased;
  const dir: 1 | -1 = toOffset >= fromOffset ? 1 : -1;

  return {
    position: shape.at(distanceM).position,
    heading: headingFor(shape, distanceM, dir),
    distanceM,
    segmentProgress: eased,
    fromStationId,
    toStationId,
    atStation: false,
  };
}

/** Shape headings always run along the polyline; a down train faces the other way. */
function headingFor(
  shape: { at(d: number): { heading: number } },
  distanceM: number,
  direction: 1 | -1,
): number {
  const h = shape.at(distanceM).heading;
  return direction === 1 ? h : (h + 180) % 360;
}
