/**
 * JAPAN LIVE data gateway.
 *
 * The single reason this exists: an ODPT consumer key must never reach a browser
 * (spec §37). Everything else here — CORS, caching, rate control, response shaping —
 * follows from putting a server in front of the feed.
 *
 * Invariants:
 *  - the key is read from a Worker secret and appears in exactly one place, below;
 *  - it is never echoed in a body, header, redirect, or error;
 *  - clients name a route key, never a URL, so this cannot become an open proxy;
 *  - a failure returns a stable, non-leaking error envelope, never an upstream body.
 */
import { specFor, type EndpointSpec } from "./endpoints.js";

export interface Env {
  /** Worker secret. Set with `wrangler secret put ODPT_CONSUMER_KEY`. */
  ODPT_CONSUMER_KEY?: string;
  /** Comma-separated origin allowlist. No wildcard in production. */
  ALLOWED_ORIGINS?: string;
  /** Requests per minute per client IP. */
  RATE_LIMIT_PER_MIN?: string;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  endpoint: string;
  fetchedAt: number;
  sourceTimestamp?: number;
  stale?: boolean;
  cache?: "hit" | "miss";
  data?: T;
  error?: { code: string; message: string };
}

/** Fixed-window rate limiter. Per isolate, which is enough to blunt a runaway client. */
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

/** Collapses concurrent identical upstream fetches into one. */
const inFlight = new Map<string, Promise<Response>>();

export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "accept,content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };

  // Only ever echo an origin that is explicitly allowed. Never reflect an arbitrary one,
  // and never send `*` alongside credentials.
  if (origin && allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  } else if (allowed.includes("*")) {
    headers["access-control-allow-origin"] = "*";
  }
  return headers;
}

function json(body: Envelope, status: number, cors: Record<string, string>, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "content-type": "application/json; charset=utf-8",
      // Tell the browser the truth about how long this may be reused.
      "cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });
}

export function checkRateLimit(ip: string, env: Env, now: number): boolean {
  const limit = Number(env.RATE_LIMIT_PER_MIN ?? "120");
  if (!Number.isFinite(limit) || limit <= 0) return true;

  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/** The newest `dc:date` in an ODPT array — the closest thing to a feed timestamp. */
export function newestSourceTimestamp(data: unknown): number | undefined {
  if (!Array.isArray(data)) return undefined;
  let newest: number | undefined;
  for (const row of data) {
    const raw = (row as Record<string, unknown> | null)?.["dc:date"];
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (newest === undefined || ms > newest) newest = ms;
  }
  return newest;
}

async function fetchUpstream(spec: EndpointSpec, key: string): Promise<Response> {
  const url = new URL(spec.url);
  for (const [k, v] of Object.entries(spec.params)) url.searchParams.set(k, v);
  // The one and only place the credential is attached.
  url.searchParams.set("acl:consumerKey", key);

  const cacheKey = `${spec.label}`;
  const existing = inFlight.get(cacheKey);
  if (existing) return (await existing).clone();

  const promise = fetch(url.toString(), {
    headers: { accept: "application/json" },
    cf: { cacheTtl: spec.cacheSeconds, cacheEverything: true },
  } as RequestInit);

  inFlight.set(cacheKey, promise);
  try {
    const res = await promise;
    return res.clone();
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function handleRequest(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET") {
    return json(
      { ok: false, endpoint: url.pathname, fetchedAt: now, error: { code: "METHOD_NOT_ALLOWED", message: "GET only" } },
      405,
      cors,
    );
  }

  if (url.pathname === "/v1/health") {
    // Reports WHETHER a key is configured. Never any part of the key itself.
    return json(
      {
        ok: true,
        endpoint: "health",
        fetchedAt: now,
        data: {
          live: Boolean(env.ODPT_CONSUMER_KEY),
          endpoints: Object.keys(await import("./endpoints.js").then((m) => m.ENDPOINTS)),
        },
      },
      200,
      cors,
    );
  }

  const spec = specFor(url.pathname);
  if (!spec) {
    return json(
      { ok: false, endpoint: url.pathname, fetchedAt: now, error: { code: "NOT_FOUND", message: "unknown endpoint" } },
      404,
      cors,
    );
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!checkRateLimit(ip, env, now)) {
    return json(
      { ok: false, endpoint: spec.label, fetchedAt: now, error: { code: "RATE_LIMITED", message: "too many requests" } },
      429,
      cors,
    );
  }

  const key = env.ODPT_CONSUMER_KEY;
  if (!key) {
    // No key is a normal, expected state: the client falls back to DEMO mode.
    return json(
      {
        ok: false,
        endpoint: spec.label,
        fetchedAt: now,
        error: { code: "NOT_CONFIGURED", message: "gateway has no upstream credential configured" },
      },
      503,
      cors,
    );
  }

  try {
    const upstream = await fetchUpstream(spec, key);

    if (!upstream.ok) {
      // Upstream status only. Never the upstream body, which could echo the request URL.
      console.log(`[${spec.label}] upstream status=${upstream.status}`);
      return json(
        {
          ok: false,
          endpoint: spec.label,
          fetchedAt: now,
          error: { code: `UPSTREAM_${upstream.status}`, message: "upstream request failed" },
        },
        502,
        cors,
      );
    }

    const data = (await upstream.json()) as unknown;
    const sourceTimestamp = newestSourceTimestamp(data);
    const count = Array.isArray(data) ? data.length : 0;
    const ageMs = sourceTimestamp === undefined ? undefined : now - sourceTimestamp;

    // Operational facts only: no payloads, no keys, no URLs.
    console.log(
      `[${spec.label}] ok count=${count} age=${ageMs === undefined ? "n/a" : `${Math.round(ageMs / 1000)}s`}`,
    );

    return json(
      {
        ok: true,
        endpoint: spec.label,
        fetchedAt: now,
        sourceTimestamp,
        stale: ageMs !== undefined && ageMs > spec.cacheSeconds * 1000 * 6,
        data,
      },
      200,
      cors,
      spec.cacheSeconds,
    );
  } catch (err) {
    console.log(`[${spec.label}] error=${err instanceof Error ? err.name : "unknown"}`);
    return json(
      { ok: false, endpoint: spec.label, fetchedAt: now, error: { code: "UPSTREAM_ERROR", message: "upstream unavailable" } },
      502,
      cors,
    );
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
