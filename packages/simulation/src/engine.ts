import type { DataMode, MobilityEntity, PositionSource, StaticTransitData } from "@japan-live/shared";
import { TransitNetwork, activeTrips, interpolateTrip } from "@japan-live/transit";

export interface EngineOptions {
  providerId: string;
  /**
   * What the produced entities claim to be.
   * `SIMULATED` for the demo dataset; `SCHEDULE_INTERPOLATED` for a real timetable.
   * Never a realtime mode — this engine reads a timetable, not a feed.
   */
  dataMode: Extract<DataMode, "SIMULATED" | "SCHEDULE_INTERPOLATED" | "HISTORICAL">;
  /** Only include these railways. Undefined means all of them. */
  railwayIds?: Set<string>;
  /** Cap on entities produced, so a dense timetable cannot stall a frame. */
  maxEntities?: number;
}

/**
 * Turn a timetable into moving things.
 *
 * This is the shared path (D-005): the demo provider and the schedule-based operators
 * both run through here, and the renderer cannot distinguish their output from a
 * realtime provider's except by reading `dataMode`.
 */
export class TimetableEngine {
  readonly network: TransitNetwork;
  private readonly data: StaticTransitData;
  private readonly options: EngineOptions;

  constructor(data: StaticTransitData, options: EngineOptions) {
    this.data = data;
    this.network = new TransitNetwork(data);
    this.options = options;
  }

  /**
   * Every vehicle running at `serviceSec`.
   *
   * A trip whose position cannot be resolved is omitted entirely rather than placed
   * somewhere plausible — an unplaceable train is not drawn.
   */
  entitiesAt(serviceSec: number, now: number): MobilityEntity[] {
    const { providerId, dataMode, railwayIds, maxEntities } = this.options;
    const positionSource: PositionSource =
      dataMode === "SIMULATED" ? "SIMULATED" : "INTERPOLATED_FROM_SCHEDULE";

    const trips = activeTrips(
      this.data,
      serviceSec,
      railwayIds ? (p) => railwayIds.has(p.railwayId) : undefined,
    );

    const out: MobilityEntity[] = [];
    for (const trip of trips) {
      if (railwayIds && !railwayIds.has(trip.railwayId)) continue;
      if (maxEntities !== undefined && out.length >= maxEntities) break;

      const pos = interpolateTrip(this.network, trip, serviceSec);
      if (!pos) continue;

      const railway = this.network.railway(trip.railwayId);
      const fromStation = this.network.station(pos.fromStationId);
      const toStation = pos.toStationId ? this.network.station(pos.toStationId) : undefined;
      const destination = trip.destinationStationId
        ? this.network.station(trip.destinationStationId)
        : undefined;

      out.push({
        id: `${providerId}:${trip.id}`,
        kind: "train",
        providerId,
        routeId: trip.railwayId,
        tripId: trip.id,
        latitude: pos.position[1],
        longitude: pos.position[0],
        heading: pos.heading,
        speed: pos.speedMps,
        dataMode,
        positionSource,
        // A timetable position is generated for `now`; there is no upstream observation.
        lastFetchedAt: now,
        label: trip.trainNumber,
        details: {
          operatorName: railway?.operatorName,
          railwayName: railway?.name,
          railwayId: trip.railwayId,
          lineColor: railway?.color,
          trainNumber: trip.trainNumber,
          trainType: trip.trainType,
          destination: destination?.name,
          fromStation: fromStation?.name,
          toStation: toStation?.name,
          atStation: pos.atStation,
          segmentProgress: pos.segmentProgress,
          direction: trip.direction === 1 ? "up" : "down",
          underground: railway?.underground ?? false,
        },
      });
    }
    return out;
  }
}
