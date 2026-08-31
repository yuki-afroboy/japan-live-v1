/**
 * Compact static transit model. This is what `scripts/data` produces from GTFS or ODPT
 * timetables, and what the demo dataset builder produces synthetically.
 * It is provider-neutral by construction.
 */

export interface StaticTransitData {
  /** Identifies the dataset build so the UI can state what it is showing. */
  meta: DatasetMeta;
  railways: Railway[];
  stations: Station[];
  trips: Trip[];
}

export interface DatasetMeta {
  id: string;
  /** Human label, e.g. "DEMO dataset" or "ODPT GTFS 2026-08". */
  name: string;
  builtAt: number;
  /** True when the geometry is approximate/hand-authored rather than survey data. */
  approximate: boolean;
  /** Free text shown in the About panel. */
  note?: string;
  attribution: string;
}

export interface Railway {
  id: string;
  name: string;
  nameEn?: string;
  operatorId: string;
  operatorName: string;
  /** Official line colour where known. */
  color: string;
  /** Ordered station ids along the line. */
  stationIds: string[];
  /** Polyline the trains actually travel, [lon, lat] pairs. GTFS `shapes.txt` equivalent. */
  shape: [number, number][];
  /** Distance in metres along `shape` at which each station in `stationIds` sits. */
  stationOffsetsM: number[];
  underground: boolean;
}

export interface Station {
  id: string;
  name: string;
  nameEn?: string;
  latitude: number;
  longitude: number;
  railwayIds: string[];
  /** Major interchanges appear at higher altitudes than minor stops. */
  major: boolean;
}

export interface Trip {
  id: string;
  railwayId: string;
  /** 1 = along stationIds order, -1 = against it. */
  direction: 1 | -1;
  trainNumber: string;
  trainType?: string;
  destinationStationId?: string;
  /** Service-day seconds (may exceed 86400 — GTFS 25:14:00 is legal and meaningful). */
  stops: TripStop[];
  /** Which service days this runs on. */
  serviceId: string;
}

export interface TripStop {
  stationId: string;
  /** Seconds from the start of the service day. May exceed 86400. */
  arrivalSec: number;
  departureSec: number;
}

export interface ServiceCalendar {
  /** serviceId -> weekday bitmask (bit 0 = Sunday .. bit 6 = Saturday). */
  [serviceId: string]: number;
}
