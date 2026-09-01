import { describe, expect, it } from "vitest";
import type { MobilityEntity, MobilityProvider, RealtimeSnapshot } from "@japan-live/shared";
import { isRealtimeMode } from "@japan-live/shared";
import { JREastProvider, ProviderRegistry } from "@japan-live/providers";

const NOW = 1_800_000_000_000;

function entity(over: Partial<MobilityEntity> = {}): MobilityEntity {
  return {
    id: "e1",
    kind: "train",
    providerId: "P",
    dataMode: "REALTIME_TRIP",
    positionSource: "INTERPOLATED_FROM_REALTIME_SEGMENT",
    sourceTimestamp: NOW,
    lastFetchedAt: NOW,
    latitude: 35.68,
    longitude: 139.76,
    ...over,
  };
}

function fakeProvider(over: Partial<MobilityProvider> & { snapshot?: RealtimeSnapshot } = {}): MobilityProvider {
  const snapshot = over.snapshot;
  return {
    id: "P",
    name: "Fake",
    enabled: true,
    getCapabilities: () => ({
      realtimePosition: false,
      realtimeTrip: true,
      realtimeStatus: false,
      staticTimetable: false,
      bestDataMode: "REALTIME_TRIP",
      pollIntervalMs: 20_000,
    }),
    getAttribution: () => ({ text: "Fake source" }),
    getFreshnessPolicy: () => ({
      staleAfterMs: 90_000,
      degradeAfterMs: 300_000,
      unavailableAfterMs: 900_000,
      degradeTo: "SCHEDULE_INTERPOLATED",
    }),
    loadStaticData: async () => null,
    getRealtimeSnapshot: async () =>
      snapshot ?? { providerId: "P", entities: [entity()], fetchedAt: NOW },
    ...over,
  } as MobilityProvider;
}

describe("ProviderRegistry freshness enforcement", () => {
  it("passes fresh entities through untouched", async () => {
    const r = new ProviderRegistry().register(fakeProvider());
    const out = await r.poll([...r.all], NOW);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.dataMode).toBe("REALTIME_TRIP");
    expect(out.states[0]!.status).toBe("LIVE");
  });

  it("DEGRADES a stale realtime entity and downgrades its position source too", async () => {
    const p = fakeProvider({
      snapshot: {
        providerId: "P",
        entities: [entity({ sourceTimestamp: NOW - 400_000 })],
        fetchedAt: NOW,
      },
    });
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.entities[0]!.dataMode).toBe("SCHEDULE_INTERPOLATED");
    expect(isRealtimeMode(out.entities[0]!.dataMode)).toBe(false);
    // The position was derived from a realtime segment that is no longer realtime.
    expect(out.entities[0]!.positionSource).toBe("INTERPOLATED_FROM_SCHEDULE");
    expect(out.states[0]!.status).toBe("STALE");
  });

  it("DROPS an entity whose data has aged out entirely", async () => {
    const p = fakeProvider({
      snapshot: {
        providerId: "P",
        entities: [entity({ sourceTimestamp: NOW - 5_000_000 })],
        fetchedAt: NOW,
      },
    });
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.entities).toHaveLength(0);
  });

  it("drops a realtime entity with no timestamp", async () => {
    const p = fakeProvider({
      snapshot: {
        providerId: "P",
        entities: [entity({ sourceTimestamp: undefined })],
        fetchedAt: NOW,
      },
    });
    expect((await new ProviderRegistry().register(p).poll([p], NOW)).entities).toHaveLength(0);
  });

  it("reports ERROR and contributes nothing when a provider fails", async () => {
    const p = fakeProvider({
      snapshot: { providerId: "P", entities: [], fetchedAt: NOW, error: "UPSTREAM" },
    });
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.entities).toHaveLength(0);
    expect(out.states[0]!.status).toBe("ERROR");
    expect(out.states[0]!.effectiveDataMode).toBe("UNAVAILABLE");
  });

  it("survives a provider that throws", async () => {
    const p = fakeProvider({
      getRealtimeSnapshot: async () => {
        throw new Error("boom");
      },
    });
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.states[0]!.status).toBe("ERROR");
    expect(out.entities).toHaveLength(0);
  });

  it("does not treat simulated data as ageing", async () => {
    const p = fakeProvider({
      getCapabilities: () => ({
        realtimePosition: false,
        realtimeTrip: false,
        realtimeStatus: false,
        staticTimetable: true,
        bestDataMode: "SIMULATED",
        pollIntervalMs: 1_000,
      }),
      snapshot: {
        providerId: "P",
        entities: [
          entity({ dataMode: "SIMULATED", positionSource: "SIMULATED", sourceTimestamp: undefined }),
        ],
        fetchedAt: NOW,
      },
    });
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.entities).toHaveLength(1);
    expect(out.states[0]!.status).toBe("DEMO");
  });
});

describe("ProviderRegistry scheduling", () => {
  it("polls a provider immediately, then respects its interval", async () => {
    const p = fakeProvider();
    const r = new ProviderRegistry().register(p);
    expect(r.due(NOW)).toHaveLength(1);
    await r.poll([p], NOW);
    expect(r.due(NOW + 5_000)).toHaveLength(0);
    expect(r.due(NOW + 25_000)).toHaveLength(1);
  });

  it("never schedules a disabled provider", () => {
    const r = new ProviderRegistry().register(new JREastProvider());
    expect(r.due(NOW)).toHaveLength(0);
  });
});

describe("JREastProvider stays off", () => {
  it("is disabled with a stated reason", () => {
    const p = new JREastProvider();
    expect(p.enabled).toBe(false);
    expect(p.getCapabilities().disabledReason).toContain("利用条件");
    expect(p.getCapabilities().bestDataMode).toBe("UNAVAILABLE");
  });

  it("makes no request and claims nothing", async () => {
    const snap = await new JREastProvider().getRealtimeSnapshot(NOW);
    expect(snap.entities).toHaveLength(0);
    expect(snap.error).toBe("provider disabled");
  });

  it("shows as DISABLED in the status panel", async () => {
    const p = new JREastProvider();
    const out = await new ProviderRegistry().register(p).poll([p], NOW);
    expect(out.states[0]!.status).toBe("DISABLED");
    expect(out.states[0]!.disabledReason).toBeTruthy();
  });
});
