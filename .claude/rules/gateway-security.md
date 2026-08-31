---
paths:
  - "apps/gateway/**"
---

# Gateway rules (apps/gateway)

The gateway exists so that provider credentials stay off the client. Every rule here
follows from that.

## Secret protection

- Read credentials from environment variables at startup. Fail fast and loudly if a
  required one is missing.
- **Never return a provider credential to the browser** — not in a body, a header, a
  redirect URL, a query string, an error message, or a debug field.
- Never proxy a client-supplied URL or client-supplied auth to a provider. Endpoints are
  chosen server-side from a fixed allowlist.
- Strip provider auth headers from anything derived from an upstream response before it
  is returned.
- No credentials in code, tests, fixtures, sample configs, or commit messages.

## CORS

- Allowlist explicit origins. Never `*` on a route that carries cookies or credentials,
  and never reflect an arbitrary `Origin` header back.
- Allow only the methods and headers the client actually uses.
- Keep the allowlist configurable per environment; development origins must not ship in
  the production default.

## Caching

- Cache upstream responses server-side, keyed by endpoint and parameters, with a TTL no
  longer than the feed's real update interval.
- Never cache across users or credentials in a way that leaks one caller's data to
  another.
- Send cache headers to the client that match reality. A cached realtime response must
  carry the upstream observation timestamp so staleness stays visible downstream.
- Serve stale-on-upstream-error only when the response is explicitly marked stale; the
  client must be able to degrade its `DataMode`.

## Rate control

- Respect each provider's published rate limits. Enforce them at the gateway with a
  scheduler or token bucket, not by hoping clients behave.
- Deduplicate concurrent identical upstream requests into one in-flight fetch.
- Rate-limit inbound client requests per origin/IP so one browser cannot amplify traffic
  to a provider.
- Back off with jitter on 429 and 5xx. Never retry in a tight loop.

## Response normalization

- Return the common mobility model, not raw provider payloads. Provider field names,
  encodings, and ID formats stop at the gateway.
- Every response carries `DataMode` and, for realtime modes, the observation timestamp.
- Errors return a consistent shape with a stable code and a safe message. Never leak
  upstream URLs, stack traces, or provider error bodies to the client.
- Upstream failure yields `UNAVAILABLE`, not an empty list presented as "no vehicles".

## Safe logging

- Redact tokens, keys, `Authorization` headers, and query-string secrets before logging.
  Redact at the logger, so no call site can leak by accident.
- Do not log full request or response bodies of provider feeds by default.
- Log operational facts — endpoint name, status, latency, cache hit, entity counts,
  freshness — not payloads.
