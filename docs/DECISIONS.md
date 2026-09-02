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
- ON/OFF geometry cycle — present, gone, present again.

**A pixel difference ratio was tried next and also abandoned.** It is direction-agnostic,
which fixes the first problem, but it cannot isolate a layer at all: measured on CI at
Shinjuku, trains moving change 40.7% of pixels over 2.5 s while removing the ENTIRE rail
layer changes 9.4%. Motion swamps any layer's contribution, so no threshold works in
either direction. There is now no frame-capture helper in the suite.

The rail and X-Ray tests are asserted the same way — through scene state and picking:
visible route/station primitive counts, station points picked at their own projected
screen positions, globe translucency, and the height underground track is drawn at.

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

---

### D-017 — On a phone the drawer is the only scroll container

**Context.** V1.1 shipped a PLATEAU diagnostics panel that a phone user could not reach.
The mobile drawer scrolled, and every `.panel-body` inside it also scrolled, capped at
`26vh`. iOS Safari gives the drag to the innermost scrollable ancestor, so a finger
starting in LAYERS moved LAYERS and stopped there; PLATEAU BUILDINGS and DATA STATUS
below it were in the DOM and unreachable. Measured at 390×844: the drawer held 761 px of
content in a 387 px window, and the LAYERS body alone held 408 px inside 219 px.

**Decision.** One scroll container per screen. On mobile `.right-stack` scrolls; panel
bodies lay out at natural height (`max-height: none; overflow: visible`). The single
exception is the developer log, which is opt-in and bounded at 150 px.

Two supporting changes follow from the same measurement: the six V2 placeholder toggles,
about half the LAYERS panel, collapse behind a disclosure, and CITY VIEW and TOUR move
out of the horizontally scrolling preset row into a pinned group. CITY VIEW is the view
that shows whether buildings loaded — at 375 px the old single row pushed it past the
right edge, so the control for diagnosing the bug was itself only findable by swiping.

**Tested as reachability, not presence.** `e2e/mobile-diagnostics.spec.ts` runs at 390×844
and 375×667 and asserts `toBeInViewport()` after scrolling, that no panel body is its own
scroller, and — the gesture that actually failed — that a wheel scroll starting over the
LAYERS body moves the drawer. Verified against the pre-fix code: that test reports "a
scroll starting inside LAYERS did not move the drawer; the panel trapped it".

**Known limitation.** `scrollIntoViewIfNeeded()` can drive an inner scroller
programmatically where a finger cannot, so the reachability assertions alone pass on the
old code too. The structural and gesture assertions are the ones that discriminate.

---

### D-018 — A wheel event is not a finger

**Context.** D-017 removed the nested scrollers so the mobile drawer was the single
scroll container, and proved it with an E2E that drove `page.mouse.wheel` from inside
the LAYERS body: the test failed on the old code with "the panel trapped it" and passed
on the new. On a real iPhone the diagnostics were still unreachable.

**Root cause.** `.hud > *` sets `pointer-events: none` on every grid cell so empty
strips do not steal map drags, and only `.panel`, `button`, `input` and `a` get it back.
`.right-stack` — the scroll container itself — was never in that list. iOS Safari picks
a pan's scroll container by hit-testing, found a `.panel` that no longer scrolled
(D-017 had just removed its `overflow`), and gave the gesture to the map. Chromium's
synthetic wheel event takes a different path entirely: it walks the containing-block
chain from the element under the cursor and does not care that an ancestor opted out of
hit-testing. The test could not have caught this.

**Decision.** Two things, and the second is the one that matters.

`.right-stack[data-open="true"]` gets `pointer-events: auto` on mobile — the narrow fix.

And the structure stops depending on a gesture at all: on a phone the drawer is a **tab
strip**, one panel at a time, every panel two taps from the map. `100vh` also became
`100dvh`, because iOS resolves `vh` against the large viewport and a `vh`-sized box hangs
below what you can see.

**The rule this leaves behind: do not prove a touch-scrolling fix with a wheel event.**
Playwright can drive a scroller that a finger cannot reach. Where a gesture is
unavoidable, assert the CSS property that decides whether the gesture can land — which
is what the pointer-events test now does — and prefer a structure that needs no gesture.

---

### D-019 — Measure first: our JavaScript was 0.2% of the frame

**Context.** The app felt heavy on an iPhone, and the obvious suspects were the train
loop (several hundred vehicles updated per frame, with a CSS colour string parsed twice
per vehicle) and PLATEAU buildings.

**What the measurement said.** Per-layer CPU timing inside the frame loop, over 8
scenarios: the whole train layer costs about **0.55 ms** and the building update about
**0.1 ms**, inside a frame taking **300 ms**. Subtracting the entire buildings layer
moved the frame by 9%. Rail and stations were inside the noise.

And the finding that redirected the work: with Trains off, the app rendered **one frame
in twelve seconds**. Every continuously rendered frame comes from the animation ticker.

**Decision.** Optimise pixels and cadence, not code.

- Mobile `resolutionScale` 1.75 → 1.25. Cost is quadratic, so this is a 49% cut.
- Mobile MSAA off — and note *which* MSAA. Turning off the WebGL context `antialias`
  flag moved the frame by ~2%, because Cesium 1.144 renders into its own target, not
  the default framebuffer. `scene.msaaSamples` (default 4) plus the FXAA post-process
  stage are the settings that cost fragments. The first pass would have shipped a
  changelog line claiming antialiasing was disabled while 4× MSAA kept running.
- Train-only render cadence capped at 30 Hz on mobile, bypassed entirely while the
  camera is moving, following, or flying.
- `preserveDrawingBuffer` was removed as dead code and then put back. It is not dead:
  `render.spec.ts` samples the canvas to catch a black globe, and two render tests went
  red. Production never sets `?debug`, so it costs a user nothing. Its removal had also
  inflated the first "after" sweep, which ran under `?debug` with the flag off against
  a baseline that had it on; the published numbers are the re-measurement.

The train-loop colour caching was kept, but it is filed as **V2 scalability**, not as a
V1 performance fix, because 0.5 ms of 300 is not a fix. Saying otherwise would make the
next person trust a number that does not deserve it.

**Two of these cannot be measured in CI.** Headless dpr is 1, so the resolution cap never
binds; CI runs at 3–4 fps, so a 30 Hz cap never engages. CI locks the *settings* instead
(`apps/web/test/quality.test.ts`), and the device reports the *result* through the
PERFORMANCE panel. A CI frame rate is a regression signal and nothing more.
