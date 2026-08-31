import type {
  Attribution,
  MobilityEntity,
  MobilityProvider,
  ProviderCapabilities,
  RealtimeSnapshot,
  ServiceAlert,
  StaticTransitData,
} from "@japan-live/shared";
import type { FreshnessPolicy } from "@japan-live/shared";
import { TransitNetwork, interpolateBetweenStations } from "@japan-live/transit";
import type { GatewayClient } from "./gateway-client.js";
import {
  odptDate,
  odptLocalName,
  odptText,
  type OdptTrain,
  type OdptTrainInformation,
} from "./odpt-types.js";

/**
 * 東京都交通局 (Toei) — V1's primary realtime source.
 *
 * The critical classification (D-003): `odpt:Train` publishes which stations a train is
 * between, its delay, and a timestamp. It publishes NO coordinate. That makes it
 * REALTIME_TRIP, not REALTIME_POSITION, and the position drawn on screen is our own
 * interpolation along the route shape — recorded as such in `positionSource`.
 */
export class ToeiProvider implements MobilityProvider {
  readonly id = "Toei";
  readonly name = "東京都交通局";
  readonly enabled: boolean;

  private readonly client: GatewayClient | null;
  private readonly network: TransitNetwork | null;
  /** Maps an ODPT station id fragment to a station id in our network. */
  private readonly stationResolver: (railwayId: string, odptStation: string) => string | undefined;

  constructor(options: {
    client: GatewayClient | null;
    network: TransitNetwork | null;
    stationResolver?: (railwayId: string, odptStation: string) => string | undefined;
  }) {
    this.client = options.client;
    this.network = options.network;
    this.enabled = options.client !== null;
    this.stationResolver = options.stationResolver ?? defaultStationResolver(options.network);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      // Verified against the ODPT catalogue: no coordinates are published.
      realtimePosition: false,
      realtimeTrip: true,
      realtimeStatus: true,
      staticTimetable: true,
      bestDataMode: this.enabled ? "REALTIME_TRIP" : "UNAVAILABLE",
      pollIntervalMs: 20_000,
      disabledReason: this.enabled ? undefined : "ゲートウェイ未設定のため LIVE データは取得しません",
    };
  }

  getAttribution(): Attribution {
    return {
      text: "東京都交通局 / 公共交通オープンデータセンター",
      url: "https://developer.odpt.org/",
      license: "ODPT 利用規約",
    };
  }

  getFreshnessPolicy(): FreshnessPolicy {
    // The feed updates every 10-30 s while trains run.
    return {
      staleAfterMs: 90_000,
      degradeAfterMs: 300_000,
      unavailableAfterMs: 900_000,
      degradeTo: "SCHEDULE_INTERPOLATED",
    };
  }

  async loadStaticData(): Promise<StaticTransitData | null> {
    // Static geometry comes from the shared dataset, not from this provider.
    return null;
  }

  async getRealtimeSnapshot(now: number): Promise<RealtimeSnapshot> {
    if (!this.client) {
      return { providerId: this.id, entities: [], fetchedAt: now, error: "gateway not configured" };
    }

    const [trains, info] = await Promise.all([
      this.client.get<OdptTrain[]>("/v1/toei/trains"),
      this.client.get<OdptTrainInformation[]>("/v1/toei/status"),
    ]);

    const alerts = info.ok && Array.isArray(info.data) ? parseAlerts(info.data) : [];

    if (!trains.ok || !Array.isArray(trains.data)) {
      // A failed poll claims nothing at all.
      return {
        providerId: this.id,
        entities: [],
        fetchedAt: now,
        error: trains.error?.code ?? "UPSTREAM_ERROR",
        alerts,
      };
    }

    const entities: MobilityEntity[] = [];
    for (const raw of trains.data) {
      const entity = this.toEntity(raw, trains.fetchedAt ?? now, now);
      if (entity) entities.push(entity);
    }

    return {
      providerId: this.id,
      entities,
      sourceTimestamp: trains.sourceTimestamp,
      fetchedAt: now,
      alerts,
    };
  }

  /**
   * One `odpt:Train` -> one MobilityEntity.
   *
   * Returns null when the record cannot be honestly placed. Skipping a train is correct;
   * drawing it at a guessed location is not.
   */
  private toEntity(raw: OdptTrain, fetchedAt: number, now: number): MobilityEntity | null {
    const railwayUri = raw["odpt:railway"];
    const trainNumber = raw["odpt:trainNumber"];
    if (typeof railwayUri !== "string" || !trainNumber) return null;

    const railwayId = odptRailwayToId(railwayUri);
    if (!railwayId) return null;

    // A realtime record with no timestamp cannot be aged, so it is not trusted.
    const sourceTimestamp = odptDate(raw["dc:date"]);
    if (sourceTimestamp === undefined) return null;

    const fromUri = raw["odpt:fromStation"];
    if (typeof fromUri !== "string") return null;
    const fromStationId = this.stationResolver(railwayId, fromUri);
    if (!fromStationId) return null;

    const toUri = raw["odpt:toStation"];
    const toStationId =
      typeof toUri === "string" ? this.stationResolver(railwayId, toUri) : undefined;

    let latitude: number | undefined;
    let longitude: number | undefined;
    let heading: number | undefined;
    let segmentProgress: number | undefined;

    if (this.network) {
      // The feed gives no progress within the segment, so a train reported as "between
      // A and B" is placed mid-segment. The Inspector says the resolution is the
      // segment, not the point.
      const pos = interpolateBetweenStations(
        this.network,
        railwayId,
        fromStationId,
        toStationId,
        toStationId ? 0.5 : 0,
      );
      if (pos) {
        longitude = pos.position[0];
        latitude = pos.position[1];
        heading = pos.heading;
        segmentProgress = pos.segmentProgress;
      }
    }

    const railway = this.network?.railway(railwayId);
    const destinationUri = raw["odpt:destinationStation"];
    const destinationRaw = Array.isArray(destinationUri) ? destinationUri[0] : destinationUri;

    return {
      id: `${this.id}:${railwayId}:${trainNumber}`,
      kind: "train",
      providerId: this.id,
      routeId: railwayId,
      latitude,
      longitude,
      heading,
      // The feed publishes no speed, so we report none rather than deriving a fiction.
      dataMode: latitude === undefined ? "REALTIME_STATUS" : "REALTIME_TRIP",
      positionSource:
        latitude === undefined ? "NONE" : "INTERPOLATED_FROM_REALTIME_SEGMENT",
      sourceTimestamp,
      lastFetchedAt: fetchedAt || now,
      label: trainNumber,
      details: {
        operatorName: this.name,
        railwayName: railway?.name,
        railwayId,
        lineColor: railway?.color,
        trainNumber,
        trainType: odptLocalName(raw["odpt:trainType"]),
        destination: this.network?.station(
          this.stationResolver(railwayId, String(destinationRaw ?? "")) ?? "",
        )?.name,
        fromStation: this.network?.station(fromStationId)?.name,
        toStation: toStationId ? this.network?.station(toStationId)?.name : undefined,
        delaySeconds: typeof raw["odpt:delay"] === "number" ? raw["odpt:delay"] : undefined,
        carComposition:
          typeof raw["odpt:carComposition"] === "number" ? raw["odpt:carComposition"] : undefined,
        direction: odptLocalName(raw["odpt:railDirection"]),
        atStation: toStationId === undefined,
        segmentProgress,
        underground: railway?.underground ?? true,
      },
    };
  }
}

/** `odpt.Railway:Toei.Oedo` -> `Toei.Oedo`. */
export function odptRailwayToId(uri: string): string | undefined {
  const idx = uri.indexOf(":");
  const tail = idx >= 0 ? uri.slice(idx + 1) : uri;
  return tail.length > 0 ? tail : undefined;
}

/**
 * Resolve an ODPT station URI to a station in our network.
 *
 * ODPT ids are romanized (`odpt.Station:Toei.Oedo.Roppongi`) while the dataset is keyed
 * by Japanese name, so this matches on the railway's own station list by romanized
 * name where the dataset provides one, and returns undefined otherwise — an
 * unresolvable station means the train is skipped, not placed.
 */
export function defaultStationResolver(
  network: TransitNetwork | null,
): (railwayId: string, odptStation: string) => string | undefined {
  if (!network) return () => undefined;

  const byRailway = new Map<string, Map<string, string>>();
  for (const railway of network.railways) {
    const map = new Map<string, string>();
    for (const stationId of railway.stationIds) {
      const station = network.station(stationId);
      if (!station) continue;
      if (station.nameEn) map.set(normalizeRomaji(station.nameEn), stationId);
      map.set(normalizeRomaji(station.name), stationId);
      map.set(station.name, stationId);
    }
    byRailway.set(railway.id, map);
  }

  return (railwayId, odptStation) => {
    const local = odptLocalName(odptStation);
    if (!local) return undefined;
    const map = byRailway.get(railwayId);
    if (!map) return undefined;
    return map.get(normalizeRomaji(local)) ?? map.get(local);
  };
}

function normalizeRomaji(value: string): string {
  return value.toLowerCase().replace(/[\s'’\-_.]/g, "");
}

function parseAlerts(rows: OdptTrainInformation[]): ServiceAlert[] {
  const out: ServiceAlert[] = [];
  for (const row of rows) {
    const text = odptText(row["odpt:trainInformationText"]);
    if (!text) continue;
    const railwayUri = row["odpt:railway"];
    out.push({
      id: row["@id"] ?? `${railwayUri ?? "unknown"}:${text.slice(0, 24)}`,
      railwayId: typeof railwayUri === "string" ? odptRailwayToId(railwayUri) : undefined,
      text,
      status: odptText(row["odpt:trainInformationStatus"]),
      sourceTimestamp: odptDate(row["dc:date"]),
    });
  }
  return out;
}
