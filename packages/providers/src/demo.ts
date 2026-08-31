import type {
  Attribution,
  FreshnessPolicy,
  MobilityProvider,
  ProviderCapabilities,
  RealtimeSnapshot,
  StaticTransitData,
} from "@japan-live/shared";
import { TimetableEngine } from "@japan-live/simulation";

/**
 * The DEMO provider.
 *
 * Runs the whole product with no credentials (spec §41-43) from the synthetic dataset.
 * Everything it emits is SIMULATED and the UI carries a permanent DEMO badge. It is
 * never dressed up as real data.
 */
export class DemoProvider implements MobilityProvider {
  readonly id = "Demo";
  readonly name = "DEMO (模擬データ)";
  readonly enabled = true;

  private readonly engine: TimetableEngine | null;
  private readonly serviceSecondsAt: () => number;

  constructor(options: {
    staticData: StaticTransitData | null;
    serviceSecondsAt: () => number;
    /** Restrict to these railways, e.g. to stand in only for operators that are offline. */
    railwayIds?: Set<string>;
    maxEntities?: number;
  }) {
    this.serviceSecondsAt = options.serviceSecondsAt;
    this.engine = options.staticData
      ? new TimetableEngine(options.staticData, {
          providerId: this.id,
          dataMode: "SIMULATED",
          railwayIds: options.railwayIds,
          maxEntities: options.maxEntities,
        })
      : null;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      realtimePosition: false,
      realtimeTrip: false,
      realtimeStatus: false,
      staticTimetable: this.engine !== null,
      bestDataMode: "SIMULATED",
      // Regenerated every frame from the clock; no network, so no poll interval matters.
      pollIntervalMs: 1_000,
    };
  }

  getAttribution(): Attribution {
    return { text: "JAPAN LIVE デモデータ（実在の運行データではありません）" };
  }

  getFreshnessPolicy(): FreshnessPolicy {
    // Simulated data does not age: it was never an observation.
    return {
      staleAfterMs: Number.POSITIVE_INFINITY,
      degradeAfterMs: Number.POSITIVE_INFINITY,
      unavailableAfterMs: Number.POSITIVE_INFINITY,
      degradeTo: "SIMULATED",
    };
  }

  async loadStaticData(): Promise<StaticTransitData | null> {
    return null;
  }

  async getRealtimeSnapshot(now: number): Promise<RealtimeSnapshot> {
    return {
      providerId: this.id,
      entities: this.engine ? this.engine.entitiesAt(this.serviceSecondsAt(), now) : [],
      fetchedAt: now,
    };
  }
}
