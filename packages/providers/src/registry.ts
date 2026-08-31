import type {
  Attribution,
  DataMode,
  MobilityEntity,
  MobilityProvider,
  ProviderStatus,
  ServiceAlert,
} from "@japan-live/shared";
import { evaluateFreshness } from "@japan-live/shared";

/** What the Data Status panel shows for one provider. */
export interface ProviderState {
  id: string;
  name: string;
  status: ProviderStatus;
  /** The mode its entities actually carry right now, after degradation. */
  effectiveDataMode: DataMode;
  entityCount: number;
  lastFetchedAt?: number;
  lastSourceTimestamp?: number;
  error?: string;
  disabledReason?: string;
  attribution: Attribution;
}

export interface PollResult {
  entities: MobilityEntity[];
  alerts: ServiceAlert[];
  states: ProviderState[];
}

/**
 * Runs the providers and merges their output.
 *
 * Two things happen here that must not happen anywhere else:
 *  - each entity is aged through its provider's freshness policy, so a quiet feed
 *    degrades instead of going on claiming to be live;
 *  - a provider that fails contributes nothing rather than an empty list that would
 *    read as "no trains running".
 */
export class ProviderRegistry {
  private readonly providers: MobilityProvider[] = [];
  private readonly lastSnapshotAt = new Map<string, number>();
  private readonly lastError = new Map<string, string | undefined>();

  register(provider: MobilityProvider): this {
    this.providers.push(provider);
    return this;
  }

  get all(): readonly MobilityProvider[] {
    return this.providers;
  }

  /** Providers that should be polled at `now`, given each one's own cadence. */
  due(now: number): MobilityProvider[] {
    return this.providers.filter((p) => {
      if (!p.enabled) return false;
      const last = this.lastSnapshotAt.get(p.id);
      if (last === undefined) return true;
      return now - last >= p.getCapabilities().pollIntervalMs;
    });
  }

  /** Poll a set of providers and normalize everything they return. */
  async poll(providers: MobilityProvider[], now: number): Promise<PollResult> {
    const entities: MobilityEntity[] = [];
    const alerts: ServiceAlert[] = [];
    const states: ProviderState[] = [];

    const snapshots = await Promise.all(
      providers.map(async (p) => {
        try {
          return { provider: p, snapshot: await p.getRealtimeSnapshot(now) };
        } catch (err) {
          // A provider must never throw, but if one does the app keeps running.
          return {
            provider: p,
            snapshot: {
              providerId: p.id,
              entities: [],
              fetchedAt: now,
              error: err instanceof Error ? err.message : "provider threw",
            },
          };
        }
      }),
    );

    for (const { provider, snapshot } of snapshots) {
      this.lastSnapshotAt.set(provider.id, now);
      this.lastError.set(provider.id, snapshot.error);

      const policy = provider.getFreshnessPolicy();
      const caps = provider.getCapabilities();
      let worst: DataMode = caps.bestDataMode;
      let anyStale = false;

      for (const entity of snapshot.entities) {
        const f = evaluateFreshness(entity.dataMode, entity.sourceTimestamp, now, policy);
        if (f.state === "UNAVAILABLE") continue; // Nothing is claimed for it.
        if (f.state === "STALE" || f.state === "DEGRADED") anyStale = true;

        entities.push(
          f.mode === entity.dataMode
            ? entity
            : {
                ...entity,
                dataMode: f.mode,
                // A degraded entity's position is no longer realtime-derived either.
                positionSource:
                  entity.positionSource === "INTERPOLATED_FROM_REALTIME_SEGMENT"
                    ? "INTERPOLATED_FROM_SCHEDULE"
                    : entity.positionSource,
              },
        );
        worst = f.mode;
      }

      if (snapshot.alerts) alerts.push(...snapshot.alerts);

      states.push({
        id: provider.id,
        name: provider.name,
        status: statusFor(provider, snapshot.error, anyStale, snapshot.entities.length),
        effectiveDataMode: snapshot.entities.length > 0 ? worst : "UNAVAILABLE",
        entityCount: snapshot.entities.length,
        lastFetchedAt: snapshot.fetchedAt,
        lastSourceTimestamp: snapshot.sourceTimestamp,
        error: snapshot.error,
        disabledReason: caps.disabledReason,
        attribution: provider.getAttribution(),
      });
    }

    return { entities, alerts, states };
  }

  /** Attribution for every registered provider that is actually contributing. */
  attributions(): Attribution[] {
    const seen = new Set<string>();
    const out: Attribution[] = [];
    for (const p of this.providers) {
      if (!p.enabled) continue;
      const a = p.getAttribution();
      if (seen.has(a.text)) continue;
      seen.add(a.text);
      out.push(a);
    }
    return out;
  }
}

function statusFor(
  provider: MobilityProvider,
  error: string | undefined,
  stale: boolean,
  count: number,
): ProviderStatus {
  if (!provider.enabled) return "DISABLED";
  if (error) return "ERROR";
  if (stale) return "STALE";

  const caps = provider.getCapabilities();
  if (caps.bestDataMode === "SIMULATED") return "DEMO";
  if (caps.bestDataMode === "SCHEDULE_INTERPOLATED") return "SCHEDULE";
  // A live feed reporting zero vehicles outside service hours is legitimate, and is
  // still LIVE — the count is shown separately so it reads as "0 trains", not "no data".
  return count >= 0 && (caps.realtimeTrip || caps.realtimePosition) ? "LIVE" : "SCHEDULE";
}
