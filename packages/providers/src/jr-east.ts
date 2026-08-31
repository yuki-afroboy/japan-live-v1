import type {
  Attribution,
  FreshnessPolicy,
  MobilityProvider,
  ProviderCapabilities,
  RealtimeSnapshot,
  StaticTransitData,
} from "@japan-live/shared";

/**
 * JR東日本 — implemented, registered DISABLED (spec §11, D-007).
 *
 * JR East realtime distribution has been contest-scoped, time-limited and
 * licence-restricted, and the entitlement to use it could not be verified. Rather than
 * guess, this provider makes ZERO network calls and reports UNAVAILABLE. The Data Status
 * panel shows it as DISABLED with the reason.
 *
 * Enabling is a one-line change in the registry once terms are confirmed. That is V2.
 */
export class JREastProvider implements MobilityProvider {
  readonly id = "JREast";
  readonly name = "東日本旅客鉄道";
  readonly enabled = false;

  getCapabilities(): ProviderCapabilities {
    return {
      realtimePosition: false,
      realtimeTrip: false,
      realtimeStatus: false,
      staticTimetable: false,
      bestDataMode: "UNAVAILABLE",
      pollIntervalMs: 60_000,
      disabledReason:
        "利用条件（ライセンス・提供期間・認証）を確認できていないため V1 では無効化しています",
    };
  }

  getAttribution(): Attribution {
    return { text: "東日本旅客鉄道（未使用）", url: "https://developer.odpt.org/" };
  }

  getFreshnessPolicy(): FreshnessPolicy {
    return {
      staleAfterMs: 90_000,
      degradeAfterMs: 300_000,
      unavailableAfterMs: 900_000,
      degradeTo: "UNAVAILABLE",
    };
  }

  async loadStaticData(): Promise<StaticTransitData | null> {
    return null;
  }

  /** Disabled means disabled: no request is made, and nothing is claimed. */
  async getRealtimeSnapshot(now: number): Promise<RealtimeSnapshot> {
    return {
      providerId: this.id,
      entities: [],
      fetchedAt: now,
      error: "provider disabled",
    };
  }
}
