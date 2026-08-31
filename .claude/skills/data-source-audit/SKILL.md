---
name: data-source-audit
description: Audit an external dataset before adding or changing it in JAPAN LIVE — verify the official source, capabilities, authentication, update frequency, license, attribution, CORS, expiration, and DataMode, then record it in docs/DATA_SOURCES.md. Use whenever a new API, feed, tileset, or dataset is introduced, an existing one changes, or a source's terms, keys, or freshness need re-checking.
allowed-tools: Read, Glob, Grep, WebFetch, WebSearch, Edit, Write
---

# Data source audit

Run this before any code depends on an external dataset. The point is that JAPAN LIVE
never overstates what its data is. An unfinished audit means the source is not cleared
for use.

If the source is a transit feed, delegate the investigation to the
`transit-data-auditor` subagent. If it is a GIS, terrain, imagery, or 3D Tiles source,
delegate to `gis-researcher`. Then complete the steps below with what they report.

Work the steps in order. Record each answer — "unknown" is a valid answer and must be
written down as unknown, never guessed.

## 1. Official source verification

- Identify the publisher and the **current official primary documentation** URL.
- Confirm the exact endpoint(s) or download location from that documentation.
- Never assume an endpoint, dataset, layer, or field exists because it once did or
  because a third party says so. Unverified is unverified.
- Note the documentation's version and the date you read it.

## 2. Capabilities

- What data classes, entity types, and fields does it actually publish?
- Which fields are populated in practice, not merely present in the schema?
- Coverage: which operators, lines, regions, or tiles — and where coverage stops.
- Known gaps, quirks, encodings, ID formats, and units.

## 3. Authentication

- Auth scheme, how a key is obtained, and any usage tier or quota.
- Rate limits, per-key and per-endpoint.
- Confirm the credential can be held server-side in `apps/gateway`. If a source
  requires exposing a key to the browser, that is a blocker — record it and stop.

## 4. Update frequency

- Publisher's stated update interval.
- Observed interval, if you can check it.
- The freshness budget: after how long is a value stale for our purposes?

## 5. License

- Exact license or terms of use, with the URL.
- Permitted use, redistribution, caching, and derivative-work terms.
- Any restriction that conflicts with shipping this product — record it and stop.

## 6. Attribution

- The exact required credit text and any required link or logo.
- Where it must appear in the UI.
- Note it as a UI task; attribution ships with the feature, not after it.

## 7. CORS

- Does the source send usable CORS headers for browser access?
- If not — the normal case — it goes through `apps/gateway`. Record that requirement.

## 8. Expiration

- Does the key, token, dataset version, or endpoint expire or rotate?
- Is this a snapshot that goes stale, or a maintained live feed?
- What breaks silently when it lapses, and how would we notice?

## 9. DataMode

Assign the `DataMode` each stream from this source maps to, with the evidence:

`REALTIME_POSITION` · `REALTIME_TRIP` · `REALTIME_STATUS` ·
`SCHEDULE_INTERPOLATED` · `SIMULATED` · `HISTORICAL` · `UNAVAILABLE`

- **A feed offering GTFS-RT is not evidence of realtime positions.** Only confirmed,
  populated `VehiclePosition` entities justify `REALTIME_POSITION`.
- State the freshness budget after which this stream degrades, and what it degrades to.
- If the evidence is thin, choose the weaker mode. Understating is safe; overstating
  is not.

## 10. Record it

Add or update the source's entry in `docs/DATA_SOURCES.md`, covering every step above,
plus the date of this audit and who ran it. Then confirm:

- No credential appears in any committed file.
- The provider adapter that assigns this `DataMode` lives in `packages/providers`.
- The attribution task is captured.

## Report

Summarize: source, what it truly provides, auth and CORS requirements, license and
attribution, freshness budget, assigned `DataMode` per stream, anything unverified, and
any blocker found in steps 3, 5, or 8.
