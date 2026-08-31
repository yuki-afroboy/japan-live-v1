import type { Attribution, RealtimeSnapshot } from "./mobility.js";
import type { DataMode } from "./data-mode.js";
import type { FreshnessPolicy } from "./freshness.js";
import type { StaticTransitData } from "./transit-model.js";

/**
 * What a provider can actually do. Probed or documented — never assumed.
 * The Data Status panel renders straight from this.
 */
export interface ProviderCapabilities {
  /** Does the feed publish true vehicle coordinates? Almost always false in Japan. */
  realtimePosition: boolean;
  /** Does it publish which stations a vehicle is between? */
  realtimeTrip: boolean;
  /** Does it publish delays / suspensions? */
  realtimeStatus: boolean;
  /** Is there a timetable to interpolate from? */
  staticTimetable: boolean;
  /** The best mode this provider can honestly claim right now. */
  bestDataMode: DataMode;
  /** Milliseconds between polls. Set from the feed's documented cadence. */
  pollIntervalMs: number;
  /** Why the provider is off, when it is. Shown to the user. */
  disabledReason?: string;
}

export type ProviderStatus =
  | "LIVE"
  | "SCHEDULE"
  | "DEMO"
  | "DISABLED"
  | "ERROR"
  | "STALE";

export interface MobilityProvider {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;

  getCapabilities(): ProviderCapabilities;
  getAttribution(): Attribution;
  getFreshnessPolicy(): FreshnessPolicy;

  /** Static timetable/geometry. Returns null when this provider has none of its own. */
  loadStaticData(): Promise<StaticTransitData | null>;

  /**
   * One poll. Must never throw: a failure comes back as a snapshot carrying `error`
   * and no entities, so the caller degrades rather than crashing.
   */
  getRealtimeSnapshot(now: number): Promise<RealtimeSnapshot>;
}
