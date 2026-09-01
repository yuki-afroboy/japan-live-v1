# Decision log

Architectural decisions, why they were taken, and what would reverse them.

---

### D-001 — Development container cannot reach any Japanese data host

**Context.** The session's egress policy returns HTTP 403 for `*.odpt.org`,
`*.gsi.go.jp`, `*.mlit.go.jp`, `assets.cms.plateau.reearth.io`, and every CDN except the
npm registry and GitHub.

**Decision.** Verify endpoints from official documentation reachable on GitHub (MLIT's
own `plateau-streaming-tutorial`) and official catalogue pages; mark anything not
verifiable as UNVERIFIED in `DATA_SOURCES.md`; make **every** external source fail soft
so an incorrect assumption degrades the app instead of breaking it. Ship a synthetic
demo dataset so the product is fully exercisable without network access to Japan.

**Consequence.** The static GTFS pipeline (`scripts/data/build-gtfs-dataset.mjs`) is
written to be run by the operator on an unrestricted network, not during this build.
The committed dataset is `SIMULATED` and labelled as such everywhere.

**Reverses when.** Run from an unrestricted network; re-run `/data-source-audit`.

---

### D-002 — PLATEAU Terrain is loaded via Cesium ion

**Context.** Spec §5 asks to avoid requiring Cesium ion and to use PLATEAU's official
distribution directly.

**Decision.** Use ion asset `3258112` with the public token MLIT publishes in its own
terrain tutorial. MLIT's official distribution *is* ion for this dataset; no MLIT-hosted
quantized-mesh `layer.json` is documented.

**Mitigations.** The token and asset ID are configuration (`VITE_CESIUM_ION_TOKEN`,
`VITE_PLATEAU_TERRAIN_ASSET_ID`), never hardcoded in logic. A `VITE_TERRAIN_URL` escape
hatch accepts any self-hosted quantized-mesh endpoint. Terrain failure falls back to an
ellipsoid globe rather than crashing.

**Reverses when.** MLIT documents a direct quantized-mesh endpoint, or a self-hosted
tileset is built with `Cesium-Terrain-Builder`.

---

### D-003 — Toei realtime is `REALTIME_TRIP`, never `REALTIME_POSITION`

**Context.** ODPT's `odpt:Train` reports `fromStation` / `toStation` / `delay` /
`dc:date`. It contains no latitude or longitude.

**Decision.** Classify it `REALTIME_TRIP`. The coordinate drawn on screen is produced by
interpolating along the route shape between the two reported stations, and is tagged
`positionSource: INTERPOLATED_FROM_REALTIME_SEGMENT`. The Inspector states both.

**Why it matters.** This is the single most tempting place in the whole product to
overstate the data. A dot moving smoothly along a line *looks* like GPS. It is not.

---

### D-004 — `dataMode` and `positionSource` are separate fields

**Context.** "How fresh is the information" and "how was this pixel placed" are
different questions, and collapsing them is how realtime gets faked.

**Decision.** `dataMode` describes the **data**. `positionSource` describes the
**geometry**. A `REALTIME_TRIP` entity has an interpolated position; a `SIMULATED` entity
has a simulated one. Both are stated.

---

### D-005 — One render path for LIVE and SIM

**Decision.** The simulation engine and realtime providers both emit `MobilityEntity[]`
into the same store and the same Cesium primitives. The renderer distinguishes them only
by reading `dataMode`.

**Consequence.** SIM mode continuously exercises the LIVE code path, so the demo cannot
drift away from reality. It also means a rendering bug cannot show up in only one mode.

---

### D-006 — Time acceleration cancels LIVE

**Decision.** Any speed other than ×1 switches the app out of LIVE, stops realtime
polling, and displays `SIMULATION ×N`. There is no blended state.

**Why.** Accelerated realtime data is not realtime. Mixing them would put a timestamp on
screen that means nothing.

---

### D-007 — JR East ships disabled

**Context.** Spec §11. JR East realtime distribution has been contest-scoped and
licence-restricted; entitlement could not be verified (see D-001).

**Decision.** Implement `JREastProvider` fully, register it with `enabled: false`, make
zero network calls, and surface it in the Data Status panel as `DISABLED`. Enabling is a
one-line registry change after terms are verified.

---

### D-008 — Trains are primitives, not entities

**Decision.** Render trains through `PointPrimitiveCollection` / `BillboardCollection`
and a small pool of instanced geometry, not one Cesium `Entity` each.

**Why.** V1 is hundreds of trains; V2 is thousands. The `Entity` API's per-entity
property evaluation does not survive that, and retrofitting the render path later would
touch every UI surface.

---

### D-009 — Simple generic train geometry

**Decision.** Near-field trains are a low-poly generic vehicle built from box geometry in
Cesium, coloured by line. No real rolling-stock models.

**Why.** Photorealistic train models are copyrighted. Spec §18 forbids unlicensed use.

---

### D-010 — Subway X-Ray is a projection and says so

**Decision.** X-Ray raises underground trains and track to a surface-relative altitude so
they are visible from above. Whenever it is on, the UI displays
`地下鉄 X-RAY — 地表へ投影して表示しています`.

**Why.** The altitude shown is not the real one. Unlabelled, it would be a spatial lie in
a product whose whole premise is not lying about data.

---

### D-011 — Gateway is required for LIVE, not for the app

**Decision.** The web app runs standalone in DEMO MODE with no gateway and no
credentials, and GitHub Pages serves exactly that. Configuring
`VITE_GATEWAY_URL` switches it to LIVE.

**Why.** Spec §41-43. Development and public review must not be blocked on an account
only the operator can create.

---

### D-012 — PLATEAU buildings load from a committed manifest, not a runtime catalog query

**Context.** V1 resolved MLIT's data catalog in the browser on every page load and
guessed at the response shape. The guess was wrong, the filter matched nothing, and the
code fell back to a single hardcoded Chiyoda tileset. On a real iPhone at Shinjuku there
were no buildings at all, and nothing on screen explained why.

**Decision.** Three layers, in this order:

1. **A manifest committed to the repository** (`apps/web/public/data/plateau-manifest.json`),
   holding an ordered list of candidate tileset URLs for each of the 23 wards. The app
   reads a static file it controls.
2. **A builder** (`scripts/data/build-plateau-manifest.mjs`) that queries MLIT's official
   GraphQL catalog for the real `latestUrl` / `url` values, run by CI at deploy time and
   by the operator on demand. It refuses to downgrade a catalog-derived manifest to a
   pattern-derived one when the network is unavailable.
3. **The documented composite URL scheme** as the always-present fallback inside every
   manifest entry: `…/datacatalog/3dtiles/{area}-bldg-lod{N}-latest/tileset.json`.

**Rejected: resolving the catalog at runtime.** It puts a third-party API on the critical
path of every page load, and a schema change, an outage, or a CORS refusal then means no
buildings at all — which is exactly what happened. The user's own guidance was explicit:
buildings appearing reliably on GitHub Pages matters more than resolving `latest` in the
browser. `latest` is still honoured, because the composite endpoint resolves it
server-side.

**Provenance is recorded, not assumed.** The manifest carries `meta.source`, either
`catalog` (read back from the API) or `pattern` (derived from the documented scheme), and
the diagnostics panel displays which one is in use.

**Consequence.** The manifest shipped in this branch is `pattern`-derived, because the
build container cannot reach any PLATEAU host (D-001). CI regenerates it on deploy.

---

### D-013 — No 3D Tiles style expression may reference an attribute we cannot guarantee

**Context.** Shading buildings by `${feature['bldg:measuredHeight']}` looked better. It
also blanked the entire map: Cesium's style evaluator throws a `RuntimeError` on
`undefined >= 150`, the throw propagates out of `evaluateColor`, and the render loop
stops. Not just the buildings disappear — everything does. The obvious guard,
`defined()`, is rejected by this styling language ("Unexpected function call").

**Decision.** Buildings use a flat colour. Height is conveyed by silhouette and lighting,
which needs no attribute at all.

**Rule.** A cosmetic style expression is never worth a whole-scene failure mode on an
attribute whose presence we cannot verify across every tileset. If height-based shading
is wanted later, it must be applied after confirming the attribute exists on the actual
tiles, and behind a guard that has been shown to work.

**Found by:** the building diagnostics panel, which reported
`板橋区: Unexpected function call "defined"` while the map was blank — the exact class of
failure V1 gave no way to diagnose.

---

### D-014 — Tests that are not about buildings do not talk to PLATEAU

**Context.** V1.1's building loader fetches tiles for the wards near the camera. That is
correct product behaviour. But CI runners have open network, so *every* test that flew
the camera low over Tokyo — rail, X-Ray, layer toggles — downloaded real PLATEAU tiles
for up to ten wards and decoded them on a software rasteriser.

The CI timings named the cause exactly: tests that stayed at altitude passed in 35-42 s;
tests that descended over Tokyo took 78-108 s or hit the deadline. With the main thread
saturated, Playwright's actionability checks could not settle, so a button that had been
*resolved* never became *clickable*.

**Decision.** `e2e/helpers.ts` owns two fixtures. `blockPlateau` aborts every PLATEAU
host, used by smoke, render, live-path and mobile. `serveTestTileset` serves the local
generated skyline, used by the building tests.

**This changes no production behaviour.** The app still requests PLATEAU exactly as it
does for a user; in those tests the requests simply fail, which is a path it already
handles and reports in diagnostics. The alternative — a test-only switch in application
code — would mean the thing under test is not the thing that ships.

**Note on route order.** Playwright matches the most recently registered route first. A
manifest URL matches both the host-wide block and the fixture pattern, so the block must
be registered *first* for the fixture to win. Registering it last silently served zero
tilesets.

---

### D-015 — Rendering assertions measure difference, not palette size

**Context.** "Buildings must add distinct colours" is a plausible-sounding proxy that is
simply false. A large flat-shaded mass occludes a more varied background, so it can
*reduce* the palette. CI measured 1405 colours with buildings against 1480 without, and
failed a skyline that was rendering correctly.

**Decision.** Three assertions replace it, each testing the actual claim:

- `scene.pick` across a screen grid — is 3D Tiles geometry genuinely under the pixels?
- `scene.pickPosition` — do the surfaces there stand above ground? (215.8 m measured
  against a fixture whose tallest tower is 250 m.)
- ON/OFF **pixel difference ratio** — direction-agnostic, so it cannot be fooled by
  whether an overlay adds or removes variety.

The same change applies to the rail and X-Ray tests, which had the same flaw.

**And a test of the test.** `e2e/probe-check.spec.ts` runs the probe with PLATEAU blocked
and requires zero hits, no height, and no frame change. An assertion that passes whether
or not the feature works is worse than no assertion, and this is the second time in this
project that a green test hid a blank screen.

---

### D-016 — A layer's status reports data availability, never user preference

**Context.** `BuildingLayer.status` returned `"unavailable"` whenever the layer was
switched off. `LayerPanel` disables a control whose layer is unavailable. So turning 3D
buildings off disabled the buildings toggle: they could be switched off exactly once and
never back on.

**Decision.** Layer status describes whether the data *can* be shown — manifest missing,
tilesets failed — and never whether the user currently *wants* it shown. Only the former
may disable a control.

**Found by:** the geometry probe added in D-015, whose second toggle click hung until the
test deadline. The three "timeouts" that followed were this one bug, not slow rendering;
raising the deadline would have hidden a real defect behind a plausible excuse.
