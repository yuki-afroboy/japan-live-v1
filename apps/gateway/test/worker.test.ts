import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, corsHeaders, handleRequest, newestSourceTimestamp, type Env } from "../src/worker.js";

const SECRET = "super-secret-consumer-key-do-not-leak";
const NOW = 1_800_000_000_000;

const env: Env = {
  ODPT_CONSUMER_KEY: SECRET,
  ALLOWED_ORIGINS: "https://example.github.io,http://localhost:5173",
  RATE_LIMIT_PER_MIN: "1000",
};

const sample = [
  { "@id": "a", "dc:date": "2026-08-18T07:30:12+09:00", "odpt:trainNumber": "0712A" },
  { "@id": "b", "dc:date": "2026-08-18T07:30:40+09:00", "odpt:trainNumber": "0713A" },
];

let fetchSpy: ReturnType<typeof vi.spyOn>;
let requestedUrls: string[];

beforeEach(() => {
  requestedUrls = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(sample), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

const get = (path: string, origin = "https://example.github.io", extra: Partial<Env> = {}) =>
  handleRequest(
    new Request(`https://gw.example.com${path}`, { headers: { origin, "cf-connecting-ip": "1.2.3.4" } }),
    { ...env, ...extra },
    NOW,
  );

describe("credential protection", () => {
  it("attaches the key to the upstream request", async () => {
    await get("/v1/toei/trains");
    const url = new URL(requestedUrls[0]!);
    expect(url.host).toBe("api.odpt.org");
    expect(url.searchParams.get("acl:consumerKey")).toBe(SECRET);
  });

  it("NEVER returns the key in the response body", async () => {
    const res = await get("/v1/toei/trains");
    expect(await res.text()).not.toContain(SECRET);
  });

  it("never returns the key in any response header", async () => {
    const res = await get("/v1/toei/trains");
    for (const [, v] of res.headers) expect(v).not.toContain(SECRET);
  });

  it("never leaks the key on an upstream error", async () => {
    fetchSpy.mockImplementation((async () => new Response("upstream said: key=" + SECRET, { status: 500 })) as unknown as typeof fetch);
    const res = await get("/v1/toei/trains");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("upstream said");
    expect(res.status).toBe(502);
  });

  it("never leaks the key when fetch throws", async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error(`connect failed for acl:consumerKey=${SECRET}`);
    }) as unknown as typeof fetch);
    const res = await get("/v1/toei/trains");
    expect(await res.text()).not.toContain(SECRET);
  });

  it("health reports only WHETHER a key exists, never the key", async () => {
    const res = await get("/v1/health");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).data.live).toBe(true);
  });

  it("reports live:false with no key configured", async () => {
    const res = await get("/v1/health", "https://example.github.io", { ODPT_CONSUMER_KEY: undefined });
    expect(JSON.parse(await res.text()).data.live).toBe(false);
  });
});

describe("endpoint allowlist", () => {
  it("serves only known route keys", async () => {
    expect((await get("/v1/toei/trains")).status).toBe(200);
    expect((await get("/v1/metro/status")).status).toBe(200);
  });

  it("404s an unknown route and makes no upstream call", async () => {
    const res = await get("/v1/anything/else");
    expect(res.status).toBe(404);
    expect(requestedUrls).toHaveLength(0);
  });

  it("cannot be used as an open proxy via a client-supplied URL", async () => {
    const res = await get("/v1/toei/trains?url=https://evil.example.com");
    expect(res.status).toBe(200);
    // The query parameter was ignored entirely; only the allowlisted upstream was called.
    expect(requestedUrls[0]).toContain("api.odpt.org");
    expect(requestedUrls.join()).not.toContain("evil.example.com");
  });

  it("rejects non-GET methods", async () => {
    const res = await handleRequest(
      new Request("https://gw.example.com/v1/toei/trains", { method: "POST" }),
      env,
      NOW,
    );
    expect(res.status).toBe(405);
  });
});

describe("CORS", () => {
  it("echoes an allowlisted origin", () => {
    const h = corsHeaders("https://example.github.io", env);
    expect(h["access-control-allow-origin"]).toBe("https://example.github.io");
  });

  it("does NOT reflect an origin that is not allowlisted", () => {
    const h = corsHeaders("https://evil.example.com", env);
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends no allow-origin at all when nothing is configured", () => {
    expect(corsHeaders("https://x.example", { })["access-control-allow-origin"]).toBeUndefined();
  });

  it("varies on origin so a cache cannot serve one site's headers to another", () => {
    expect(corsHeaders("https://example.github.io", env)["vary"]).toBe("origin");
  });

  it("answers preflight", async () => {
    const res = await handleRequest(
      new Request("https://gw.example.com/v1/toei/trains", {
        method: "OPTIONS",
        headers: { origin: "https://example.github.io" },
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.github.io");
  });
});

describe("response envelope", () => {
  it("returns the newest upstream timestamp so the client can judge freshness", async () => {
    const body = await (await get("/v1/toei/trains")).json();
    expect(body.ok).toBe(true);
    expect(body.sourceTimestamp).toBe(Date.parse("2026-08-18T07:30:40+09:00"));
    expect(body.data).toHaveLength(2);
  });

  it("caches no longer than the feed's update interval", async () => {
    const res = await get("/v1/toei/trains");
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
  });

  it("never caches an error response", async () => {
    const res = await get("/v1/nope");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a stable error shape when unconfigured, so the client falls back to DEMO", async () => {
    const res = await get("/v1/toei/trains", "https://example.github.io", { ODPT_CONSUMER_KEY: undefined });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("NOT_CONFIGURED");
    expect(requestedUrls).toHaveLength(0);
  });

  it("marks data stale when the newest record is far older than the cache window", async () => {
    fetchSpy.mockImplementation((async () =>
      new Response(JSON.stringify([{ "dc:date": new Date(NOW - 600_000).toISOString() }]), {
        status: 200,
      })) as unknown as typeof fetch);
    expect((await (await get("/v1/toei/trains")).json()).stale).toBe(true);
  });
});

describe("rate limiting", () => {
  it("allows traffic under the limit and blocks above it", () => {
    const e: Env = { RATE_LIMIT_PER_MIN: "3" };
    expect(checkRateLimit("ip-a", e, NOW)).toBe(true);
    expect(checkRateLimit("ip-a", e, NOW)).toBe(true);
    expect(checkRateLimit("ip-a", e, NOW)).toBe(true);
    expect(checkRateLimit("ip-a", e, NOW)).toBe(false);
  });

  it("keeps buckets separate per client", () => {
    const e: Env = { RATE_LIMIT_PER_MIN: "1" };
    expect(checkRateLimit("ip-b", e, NOW)).toBe(true);
    expect(checkRateLimit("ip-c", e, NOW)).toBe(true);
  });

  it("resets after the window", () => {
    const e: Env = { RATE_LIMIT_PER_MIN: "1" };
    expect(checkRateLimit("ip-d", e, NOW)).toBe(true);
    expect(checkRateLimit("ip-d", e, NOW)).toBe(false);
    expect(checkRateLimit("ip-d", e, NOW + 61_000)).toBe(true);
  });

  it("returns 429 rather than calling upstream", async () => {
    const e = { ...env, RATE_LIMIT_PER_MIN: "1" };
    await get("/v1/toei/trains", "https://example.github.io", e);
    requestedUrls = [];
    const res = await get("/v1/toei/trains", "https://example.github.io", e);
    expect(res.status).toBe(429);
    expect(requestedUrls).toHaveLength(0);
  });
});

describe("newestSourceTimestamp", () => {
  it("ignores unparseable and missing dates", () => {
    expect(newestSourceTimestamp([{ "dc:date": "nope" }, {}, null])).toBeUndefined();
  });
  it("returns undefined for a non-array", () => {
    expect(newestSourceTimestamp({ "dc:date": "2026-08-18T07:30:12+09:00" })).toBeUndefined();
  });
});
