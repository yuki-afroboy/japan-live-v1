import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StaticTransitData } from "@japan-live/shared";
import { isRealtimePosition } from "@japan-live/shared";
import { TransitNetwork } from "@japan-live/transit";
import { GatewayClient, ToeiProvider, odptDate, odptLocalName, odptText } from "@japan-live/providers";

const dataset = JSON.parse(
  readFileSync(resolve(__dirname, "../../../apps/web/public/data/demo-dataset.json"), "utf8"),
) as StaticTransitData;
const network = new TransitNetwork(dataset);

const trains = JSON.parse(readFileSync(resolve(__dirname, "fixtures/toei-trains.json"), "utf8"));
const status = JSON.parse(readFileSync(resolve(__dirname, "fixtures/toei-status.json"), "utf8"));

const NOW = Date.parse("2026-08-18T07:30:20+09:00");

/** A gateway stand-in. No network is touched in unit tests (spec §60). */
function stubClient(routes: Record<string, unknown>, ok = true): GatewayClient {
  return new GatewayClient({
    baseUrl: "https://stub.invalid",
    fetchImpl: (async (url: string) => {
      const path = new URL(url).pathname;
      const body = ok
        ? { ok: true, endpoint: path, fetchedAt: NOW, sourceTimestamp: NOW, data: routes[path] ?? [] }
        : { ok: false, endpoint: path, fetchedAt: NOW, error: { code: "UPSTREAM", message: "down" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
}

const liveRoutes = { "/v1/toei/trains": trains, "/v1/toei/status": status };

describe("ToeiProvider capabilities", () => {
  it("declares that it has NO realtime position", () => {
    // odpt:Train carries no coordinate. Claiming otherwise is the failure this
    // whole project is built to prevent.
    const caps = new ToeiProvider({ client: stubClient(liveRoutes), network }).getCapabilities();
    expect(caps.realtimePosition).toBe(false);
    expect(caps.realtimeTrip).toBe(true);
    expect(caps.bestDataMode).toBe("REALTIME_TRIP");
    expect(isRealtimePosition(caps.bestDataMode)).toBe(false);
  });

  it("is disabled with a reason when no gateway is configured", () => {
    const p = new ToeiProvider({ client: null, network });
    expect(p.enabled).toBe(false);
    expect(p.getCapabilities().disabledReason).toBeTruthy();
  });

  it("attributes the operator and the data centre", () => {
    const a = new ToeiProvider({ client: null, network }).getAttribution();
    expect(a.text).toContain("東京都交通局");
    expect(a.text).toContain("公共交通オープンデータセンター");
  });
});

describe("ToeiProvider parsing", () => {
  it("parses a running train into REALTIME_TRIP with an interpolated position", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    const oedo = snap.entities.find((e) => e.label === "0712A")!;

    expect(oedo.dataMode).toBe("REALTIME_TRIP");
    // The mode is realtime; the pixel is ours. Both are stated.
    expect(oedo.positionSource).toBe("INTERPOLATED_FROM_REALTIME_SEGMENT");
    expect(oedo.latitude).toBeGreaterThan(35.6);
    expect(oedo.longitude).toBeGreaterThan(139.7);
    expect(oedo.sourceTimestamp).toBe(Date.parse("2026-08-18T07:30:12+09:00"));
  });

  it("places the train between the two reported stations, not at either", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    const oedo = snap.entities.find((e) => e.label === "0712A")!;
    const roppongi = network.station("st.六本木")!;
    const azabu = network.station("st.麻布十番")!;
    const dTo = (s: { latitude: number; longitude: number }) =>
      Math.hypot(oedo.latitude! - s.latitude, oedo.longitude! - s.longitude);
    expect(dTo(roppongi)).toBeGreaterThan(0.0005);
    expect(dTo(azabu)).toBeGreaterThan(0.0005);
  });

  it("reports a train standing at a station when only fromStation is given", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    const asakusa = snap.entities.find((e) => e.label === "0701T")!;
    expect(asakusa.details?.atStation).toBe(true);
    expect(asakusa.details?.fromStation).toBe("大門");
    expect(asakusa.details?.toStation).toBeUndefined();
  });

  it("carries the reported delay, and leaves it undefined when unreported", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    expect(snap.entities.find((e) => e.label === "0712A")!.details?.delaySeconds).toBe(60);
    // A reported zero delay is data and must survive as zero, not become undefined.
    expect(snap.entities.find((e) => e.label === "0701T")!.details?.delaySeconds).toBe(0);
  });

  it("DROPS a realtime record with no timestamp rather than trusting it", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    expect(snap.entities.find((e) => e.label === "0900I")).toBeUndefined();
  });

  it("DROPS a record whose stations cannot be resolved rather than guessing a position", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    expect(snap.entities.find((e) => e.label === "9999X")).toBeUndefined();
  });

  it("drops a record with no railway", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    expect(snap.entities.find((e) => e.label === "1234Z")).toBeUndefined();
  });

  it("never emits a speed, because the feed does not publish one", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    for (const e of snap.entities) expect(e.speed).toBeUndefined();
  });

  it("never emits REALTIME_POSITION for any record", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    for (const e of snap.entities) expect(isRealtimePosition(e.dataMode)).toBe(false);
  });

  it("parses service alerts, including a plain-string body", async () => {
    const snap = await new ToeiProvider({ client: stubClient(liveRoutes), network }).getRealtimeSnapshot(NOW);
    expect(snap.alerts).toHaveLength(2);
    const oedo = snap.alerts!.find((a) => a.railwayId === "Toei.Oedo")!;
    expect(oedo.text).toContain("5分の遅れ");
    expect(oedo.status).toBe("遅延");
  });

  it("claims NOTHING when the upstream fails", async () => {
    const snap = await new ToeiProvider({
      client: stubClient(liveRoutes, false),
      network,
    }).getRealtimeSnapshot(NOW);
    expect(snap.entities).toHaveLength(0);
    expect(snap.error).toBeTruthy();
  });

  it("does not throw when the gateway is unreachable", async () => {
    const client = new GatewayClient({
      baseUrl: "https://stub.invalid",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const snap = await new ToeiProvider({ client, network }).getRealtimeSnapshot(NOW);
    expect(snap.entities).toHaveLength(0);
    expect(snap.error).toBe("NETWORK");
  });

  it("survives a malformed gateway body", async () => {
    const client = new GatewayClient({
      baseUrl: "https://stub.invalid",
      fetchImpl: (async () =>
        new Response("not json at all", { status: 200 })) as unknown as typeof fetch,
    });
    const snap = await new ToeiProvider({ client, network }).getRealtimeSnapshot(NOW);
    expect(snap.entities).toHaveLength(0);
    expect(snap.error).toBeTruthy();
  });
});

describe("ODPT field helpers", () => {
  it("reads multilingual text, preferring Japanese", () => {
    expect(odptText({ ja: "遅延", en: "Delay" })).toBe("遅延");
    expect(odptText({ en: "Delay" })).toBe("Delay");
    expect(odptText("plain")).toBe("plain");
    expect(odptText(undefined)).toBeUndefined();
    expect(odptText("   ")).toBeUndefined();
  });

  it("takes the local name off a URI", () => {
    expect(odptLocalName("odpt.Station:Toei.Oedo.Roppongi")).toBe("Roppongi");
    expect(odptLocalName(undefined)).toBeUndefined();
    expect(odptLocalName("")).toBeUndefined();
  });

  it("returns undefined for an unparseable date instead of NaN or now", () => {
    expect(odptDate("2026-08-18T07:30:12+09:00")).toBe(Date.parse("2026-08-18T07:30:12+09:00"));
    expect(odptDate("garbage")).toBeUndefined();
    expect(odptDate(undefined)).toBeUndefined();
  });
});
