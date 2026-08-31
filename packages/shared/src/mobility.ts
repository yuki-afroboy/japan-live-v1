import type { DataMode, PositionSource } from "./data-mode.js";

export type MobilityKind = "train" | "bus" | "flight" | "ferry";

/**
 * The one model every moving thing normalizes into, whatever produced it.
 * The renderer consumes this and nothing else — it cannot tell a realtime train from a
 * simulated one except by reading `dataMode`.
 */
export interface MobilityEntity {
  id: string;
  kind: MobilityKind;
  providerId: string;

  routeId?: string;
  tripId?: string;

  /** Degrees. Undefined when no position could be determined honestly. */
  latitude?: number;
  longitude?: number;
  /** Metres. For trains this is a rendering altitude, not a survey value. */
  altitude?: number;
  /** Degrees clockwise from north. */
  heading?: number;
  /** Metres per second. Only set when derived from data, never invented. */
  speed?: number;

  dataMode: DataMode;
  positionSource: PositionSource;

  /** When the provider says the observation was made. Required for realtime modes. */
  sourceTimestamp?: number;
  /** When we fetched it. */
  lastFetchedAt: number;

  /** True when the entity's position was projected for X-Ray rather than shown at depth. */
  projected?: boolean;

  label?: string;
  details?: MobilityDetails;
}

/** Everything the Inspector shows. Every field is optional — unknown stays unknown. */
export interface MobilityDetails {
  operatorName?: string;
  railwayName?: string;
  railwayId?: string;
  lineColor?: string;
  trainNumber?: string;
  trainType?: string;
  destination?: string;
  fromStation?: string;
  toStation?: string;
  /** Seconds. Undefined means "not reported", which is not the same as zero. */
  delaySeconds?: number;
  carComposition?: number;
  direction?: string;
  /** True when the vehicle is stopped at `fromStation` rather than between stations. */
  atStation?: boolean;
  /** 0..1 progress between fromStation and toStation, when known. */
  segmentProgress?: number;
  underground?: boolean;
}

/** One provider's answer for one poll. */
export interface RealtimeSnapshot {
  providerId: string;
  entities: MobilityEntity[];
  /** When the upstream says the data was generated, if it says. */
  sourceTimestamp?: number;
  fetchedAt: number;
  /** Set when this poll failed. `entities` is then empty and nothing is claimed. */
  error?: string;
  /** Realtime service alerts, independent of positions. */
  alerts?: ServiceAlert[];
}

export interface ServiceAlert {
  id: string;
  railwayId?: string;
  railwayName?: string;
  /** The operator's own text. Never paraphrased. */
  text: string;
  status?: string;
  sourceTimestamp?: number;
}

export interface Attribution {
  /** Shown verbatim wherever this source's data appears. */
  text: string;
  url?: string;
  /** Licence name, when the source states one. */
  license?: string;
}
