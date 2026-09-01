import type {
  Attribution,
  FreshnessPolicy,
  MobilityProvider,
  ProviderCapabilities,
  RealtimeSnapshot,
  ServiceAlert,
  StaticTransitData,
} from "@japan-live/shared";
import { TimetableEngine } from "@japan-live/simulation";
import type { GatewayClient } from "./gateway-client.js";
import { odptDate, odptText, type OdptTrainInformation } from "./odpt-types.js";
import { odptRailwayToId } from "./toei.js";

/**
 * 東京メトロ (Tokyo Metro).
 *
 * Position comes from the timetable, so it is SCHEDULE_INTERPOLATED. When
 * `odpt:TrainInformation` is available it is overlaid as REALTIME_STATUS — but the
 * position stays schedule-derived, because a delay message does not tell us where a
 * train is (spec §10, "SCHEDULE + LIVE STATUS").
 *
 * Whether Metro also publishes `odpt:Train` could not be verified (see DATA_SOURCES §5),
 * so the capability is probed at runtime rather than assumed: `probeRealtimeTrip()` asks
 * the gateway once and only then promotes the provider.
 */
export class TokyoMetroProvider implements MobilityProvider {
  readonly id = "TokyoMetro";
  readonly name = "東京地下鉄";
  readonly enabled = true;

  private readonly client: GatewayClient | null;
  private engine: TimetableEngine | null = null;
  private readonly railwayIds: Set<string>;
  private readonly serviceSecondsAt: () => number;
  /** Left null until probed. Never assumed true. */
  private realtimeTripAvailable: boolean | null = null;

  constructor(options: {
    client: GatewayClient | null;
    staticData: StaticTransitData | null;
    serviceSecondsAt: () => number;
  }) {
    this.client = options.client;
    this.serviceSecondsAt = options.serviceSecondsAt;
    this.railwayIds = new Set(
      (options.staticData?.railways ?? [])
        .filter((r) => r.operatorId === "TokyoMetro")
        .map((r) => r.id),
    );
    if (options.staticData && this.railwayIds.size > 0) {
      this.engine = new TimetableEngine(options.staticData, {
        providerId: this.id,
        dataMode: "SCHEDULE_INTERPOLATED",
        railwayIds: this.railwayIds,
      });
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      realtimePosition: false,
      realtimeTrip: this.realtimeTripAvailable === true,
      realtimeStatus: this.client !== null,
      staticTimetable: this.engine !== null,
      bestDataMode: this.engine ? "SCHEDULE_INTERPOLATED" : "UNAVAILABLE",
      pollIntervalMs: 60_000,
    };
  }

  getAttribution(): Attribution {
    return {
      text: "東京地下鉄 / 公共交通オープンデータセンター",
      url: "https://developer.odpt.org/",
      license: "ODPT 利用規約",
    };
  }

  getFreshnessPolicy(): FreshnessPolicy {
    return {
      staleAfterMs: 300_000,
      degradeAfterMs: 900_000,
      unavailableAfterMs: 1_800_000,
      degradeTo: "SCHEDULE_INTERPOLATED",
    };
  }

  async loadStaticData(): Promise<StaticTransitData | null> {
    return null;
  }

  async getRealtimeSnapshot(now: number): Promise<RealtimeSnapshot> {
    const entities = this.engine ? this.engine.entitiesAt(this.serviceSecondsAt(), now) : [];

    let alerts: ServiceAlert[] = [];
    if (this.client) {
      const info = await this.client.get<OdptTrainInformation[]>("/v1/metro/status");
      if (info.ok && Array.isArray(info.data)) {
        alerts = info.data.flatMap((row) => {
          const text = odptText(row["odpt:trainInformationText"]);
          if (!text) return [];
          const railwayUri = row["odpt:railway"];
          return [
            {
              id: row["@id"] ?? `metro:${text.slice(0, 24)}`,
              railwayId: typeof railwayUri === "string" ? odptRailwayToId(railwayUri) : undefined,
              text,
              status: odptText(row["odpt:trainInformationStatus"]),
              sourceTimestamp: odptDate(row["dc:date"]),
            },
          ];
        });
      }
    }

    // Positions here are schedule-derived and stay that way. Alerts ride alongside as
    // REALTIME_STATUS; they never promote an entity's mode.
    return { providerId: this.id, entities, fetchedAt: now, alerts };
  }

  /** Ask the gateway once whether Metro realtime trip data exists. Never assumed. */
  async probeRealtimeTrip(): Promise<boolean> {
    if (!this.client) return false;
    if (this.realtimeTripAvailable !== null) return this.realtimeTripAvailable;
    const res = await this.client.get<unknown[]>("/v1/metro/trains");
    this.realtimeTripAvailable = res.ok && Array.isArray(res.data) && res.data.length > 0;
    return this.realtimeTripAvailable;
  }
}
