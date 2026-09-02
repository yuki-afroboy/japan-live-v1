# Performance

Measured before it was tuned, and re-measured after. Every number below says where it
came from, because the two sources answer different questions and mixing them up is how
a team ships a "60 fps" app that stutters on a phone.

## Two kinds of number, never mixed

| | CI sweep | PERFORMANCE panel |
| --- | --- | --- |
| Renderer | headless Chromium, **SwiftShader — software, no GPU** | the device's real GPU |
| devicePixelRatio | always **1** | 2 or 3 on a phone |
| Good for | comparing build A with build B under identical conditions; attributing cost between layers | deciding whether the product is actually pleasant to use |
| Not good for | predicting any real frame rate, in either direction | comparing against anyone else's run |

**A CI frame rate is never evidence about an iPhone.** It is a regression signal only.
Two of the changes below cannot be measured in CI *at all* — the reasons are stated
where they appear rather than hidden behind an average.

Reproduce the sweep:

```
PERF=1 npx playwright test e2e/perf-baseline.spec.ts        # writes perf/*.json
PERF=1 PERF_LABEL=after npx playwright test e2e/perf-baseline.spec.ts
```

On a device: open **レイヤー / データ → 性能**. The panel reports a rolling 10 s window
of real frame intervals, plus the quality profile in effect.

## What the baseline actually showed

Mobile viewport (390×844), demo dataset, ~358 trains, west-Shinjuku fixture tileset.

| # | Scenario | fps | median | p95 | >33 ms | our CPU / frame |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 東京広域 (42 km) | 4.3 | 222.9 ms | 265.7 ms | 43 | 0.70 ms |
| 2 | 東京駅 (850 m) | 3.5 | 276.1 ms | 293.1 ms | 36 | 0.78 ms |
| 3 | 新宿 (900 m) | 3.3 | 296.2 ms | 316.0 ms | 33 | 0.67 ms |
| 4 | CITY VIEW | 3.2 | 300.7 ms | 327.5 ms | 33 | 0.66 ms |
| 5 | CITY VIEW − buildings | 3.5 | 272.0 ms | 301.1 ms | 36 | 0.49 ms |
| 6 | CITY VIEW − trains | **idle** | 277.3 ms | 277.3 ms | **1** | 0.44 ms |
| 7 | CITY VIEW − rail/stations | 2.8 | 302.8 ms | 475.2 ms | 28 | 0.54 ms |
| 8 | CITY VIEW − buildings − trains | **idle** | 293.3 ms | 293.3 ms | **1** | 0.56 ms |

Desktop viewport (1280×800), same run, for contrast — note it holds 10 wards, not 3:

| # | Scenario | fps | median | p95 | our CPU / frame |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | 東京広域 (42 km) | 2.1 | 445.7 ms | 460.3 ms | 0.95 ms |
| 2 | 東京駅 (850 m) | 1.4 | 664.5 ms | 710.4 ms | 1.16 ms |
| 3 | 新宿 (900 m) | 1.1 | 740.8 ms | 1212.4 ms | 1.01 ms |
| 4 | CITY VIEW | 1.0 | 837.0 ms | 1285.2 ms | 0.74 ms |
| 5 | CITY VIEW − buildings | 1.3 | 697.8 ms | 737.6 ms | 0.80 ms |
| 6 | CITY VIEW − trains | 1.1 | 808.7 ms | 857.8 ms | 0.57 ms |
| 7 | CITY VIEW − rail/stations | 1.2 | 776.8 ms | 949.5 ms | 0.61 ms |
| 8 | CITY VIEW − buildings − trains | 1.1 | 706.5 ms | 1053.4 ms | 0.62 ms |

A software rasteriser at 1280×800 shades 2.5× the pixels of 390×844, which is the whole
of the difference. It is not a statement about desktop hardware.

Three findings, in order of how much they changed the plan.

**1. Our own JavaScript is 0.2–0.3% of a frame.** The per-layer CPU split says the
train layer costs about 0.55 ms and the building update about 0.1 ms, inside a frame
that takes 300 ms. Rewriting the train loop would have been optimising a rounding
error. The frame is rasterisation, essentially all of it.

**2. Scenario 6 is the whole story about cadence.** With the Trains layer off, the app
rendered **one frame in twelve seconds** — `requestRenderMode` was already doing its
job, and every continuously rendered frame in this product comes from the train
animation ticker. That makes the ticker's *rate* a bigger lever than any layer's *cost*:
a layer toggle changes what a frame costs, the ticker changes how many frames exist.

**3. Subtracting a layer barely moves the frame time.** Buildings account for about 9%
of the CITY VIEW frame (300.7 → 272.0 ms), rail and stations for a few percent inside
the run-to-run noise. Neither is the bottleneck. The bottleneck is pixels — and on a
phone, pixels are the one thing this app was spending most freely.

## Result

Same harness, same fixture, same scenarios; only the build differs. Mobile viewport
(390×844). Remember what this is: a **software rasteriser at dpr 1**, so these are
relative numbers, and two of the changes cannot show up here at all.

| # | Scenario | fps before → after | median before → after | change |
| --- | --- | ---: | ---: | ---: |
| 1 | 東京広域 (42 km) | 4.3 → **6.4** | 222.9 → **151.7 ms** | **−32%** frame time |
| 2 | 東京駅 (850 m) | 3.5 → **5.6** | 276.1 → **174.0 ms** | **−37%** |
| 3 | 新宿 (900 m) | 3.3 → **5.2** | 296.2 → **188.3 ms** | **−36%** |
| 4 | CITY VIEW | 3.2 → **4.9** | 300.7 → **197.5 ms** | **−34%** |
| 5 | CITY VIEW − buildings | 3.5 → **5.7** | 272.0 → **169.9 ms** | −38% |
| 6 | CITY VIEW − trains | idle | 277.3 → **174.5 ms** | −37% (one frame either way) |
| 7 | CITY VIEW − rail/stations | 2.8 → **5.4** | 302.8 → **180.3 ms** | −40% |
| 8 | CITY VIEW − buildings − trains | idle | 293.3 → **180.5 ms** | −38% (one frame either way) |

Roughly **a third off the frame time everywhere**, and the mobile ward budget behaved:
3 wards resident instead of 4.

Our own CPU per frame at CITY VIEW: 0.66 → 0.71 ms, i.e. unchanged inside the noise.
The colour cache is real but it is 0.5 ms of a 200 ms frame, and saying so is the point
of measuring it rather than leading with it.

Desktop, where nothing was tuned, came back flat — which is the control this needed:

| # | Scenario | fps before → after | median before → after |
| --- | --- | ---: | ---: |
| 1 | 東京広域 | 2.1 → 1.8 | 445.7 → 531.7 ms |
| 2 | 東京駅 | 1.4 → 1.3 | 664.5 → 745.6 ms |
| 3 | 新宿 | 1.1 → 1.2 | 740.8 → 792.7 ms |
| 4 | CITY VIEW | 1.0 → 1.1 | 837.0 → 862.3 ms |
| 5 | − buildings | 1.3 → 1.2 | 697.8 → 761.0 ms |
| 6 | − trains | 1.1 → 1.1 | 808.7 → 846.9 ms |
| 7 | − rail/stations | 1.2 → 1.1 | 776.8 → 856.2 ms |
| 8 | − buildings − trains | 1.1 → 1.2 | 706.5 → 775.4 ms |

Scattered a few percent either way, some rows better and some worse. Read it as noise,
for two reasons: the box is a **4-core container running at load average 4.0+**, where a
software rasteriser is fully CPU-bound and contends with everything else; and no
desktop-affecting setting changed. `scene.msaaSamples` is set to 4 on desktop, which is
Cesium's own default (`msaaSamples = options.msaaSamples ?? 4` in the shipped build), so
that line is a no-op there.

The mobile improvement is trustworthy precisely because it does **not** look like this:
31–41% in the same direction on all eight scenarios, measured in the same processes and
under the same load as this flat desktop set. A load artefact would have moved both.

**What these numbers do NOT include**, because the harness cannot produce them:

- the mobile `resolutionScale` cap (headless dpr is 1, so 1.25 never binds — on a 3×
  iPhone screen this is a further **49% cut in pixels shaded**, by arithmetic);
- the 30 Hz animation cap (CI never reaches 30 fps, so the cap never engages — on a
  phone hitting 60 it halves the number of frames rendered when only trains move).

Both are device-side, and both are why the PERFORMANCE panel exists.

## What changed, and what the evidence for it is

### Kept, and why

| Change | Evidence | Measurable in CI? |
| --- | --- | --- |
| `resolutionScale` 1.75 → **1.25** on mobile | Fragment cost scales with the square: 3.06× → 1.56×, a **49% cut in pixels shaded**. Arithmetic, not a guess. | **No** — headless dpr is 1, so the cap never binds. Device-only. |
| `scene.msaaSamples` 4 → **1** and FXAA **off** on mobile | Cesium renders into its own target with 4× MSAA by default, then runs a full-screen FXAA pass. That is 4× the fragment and bandwidth cost of the whole scene to smooth edges the eye cannot resolve at phone pixel density. | Yes. |
| WebGL context `antialias` **off** on mobile | Almost nothing on its own — see below. Kept so the context stops allocating a multisample surface Cesium barely draws to. | Yes, and it measured ~2%. |
| Train-only render cadence capped to **30 Hz** on mobile | Scenario 6: all sustained frames come from this ticker. Halving its rate halves sustained GPU load, battery and heat. | **No** — CI already runs at 3–4 fps, far below the 30 Hz cap, so the cap never engages. Device-only. |
| Mobile ward budget 4 → **3**, tile cache 128 MB → **48 MB** | Four 128 MB caches is more memory than a phone gives one tab; the budget bounds how many can exist. | Partly (fewer tiles fetched). |
| Mobile 3D-Tiles SSE 12 → **16** close in, 32 → **40** mid | Fewer tiles for the same silhouette. Looked at, not just measured: `screenshots/m6-cityview-buildings.png` is CITY VIEW at 390×844 on the mobile profile, and the west-Shinjuku towers still read as separate masses with depth rather than one slab. (That is the synthetic fixture tileset, not live PLATEAU — the container cannot reach MLIT. It answers the geometry question, not the coverage one.) | Yes. |
| Building diagnostics no longer re-render React on every camera event | The altitude threshold was an absolute 25 m, which is noise at 400 km altitude and fires on nearly every event during a flight. Now relative (8%). | Marginal. |
| Train colours parsed once per entity instead of once per entity per frame | ~700 `Color.fromCssColorString` calls per frame at V1's scale. | Yes, but it is **0.5 ms of 300** — this is a **V2 scalability** change, not a V1 fix. Said plainly rather than dressed up. |

### One measurement that changed the fix

The first pass turned off the **WebGL context** `antialias` flag and re-measured: the
frame moved by about **2%**. That is not what disabling MSAA should look like.

The reason is that Cesium 1.144 does not draw the scene to the default framebuffer. It
renders into its own target, whose sampling is controlled by `scene.msaaSamples`
(default **4**) and followed by an FXAA post-process stage. The context flag governs a
surface almost nothing lands on. Turning off the two settings that Cesium actually uses
is what the second pass does.

Worth stating plainly because the first version of this work would have shipped a
"disabled antialiasing" line in the changelog while leaving 4× MSAA running.

### One change that was made, measured, and then reverted

`preserveDrawingBuffer` is enabled under `?debug`, and removing it looked free: D-015
had deleted the pixel-diff helper, so nothing appeared to read the buffer back.

Nothing except `render.spec.ts`, whose `sample()` still copies the canvas with
`drawImage` to check that the globe is not black — the one failure mode every
DOM-based test sails straight through. Two render tests went red on the full suite
run, which is exactly what that test exists to catch.

It is restored. Production never sets `?debug`, so it costs a real user nothing, and
the belief that it was dead code was simply wrong.

It also put the numbers in doubt, so they were taken again. The first "after" sweep
ran under `?debug` with the flag off against a baseline that had it on, which is not a
fair comparison. Re-measured with the flag restored on both sides, the result barely
moves — CITY VIEW 197.0 → 197.5 ms, 東京広域 153.6 → 151.7 ms. So the flag was never
where the gain came from; it was the MSAA and FXAA change all along. The table above
is that re-measurement, and the suspicion is recorded rather than the relief.

### Deliberately not done

- **Rewriting the train update loop** (per-frame allocation removal beyond the colour
  cache, spatial culling, staggered far-LOD updates). Measurement says the entire loop
  is 0.55 ms of a 300 ms frame. It would add risk to the layer that carries the
  product's core motion, for no gain a user could perceive. The V2 design note below
  records what to do when entity counts make it matter.
- **Lowering `resolutionScale` to 1.0.** 1.0 on a 3× screen makes the 1 px route strokes
  visibly ragged; 1.25 already takes half the pixel cost away. Revisit with a device
  measurement, not an opinion.
- **Reducing the ward budget to 2.** CITY VIEW straddles 新宿区 and its neighbours; at 2
  the skyline ends on a ward boundary, which is a data-integrity-shaped visual lie.
- **Turning `antialias` off on desktop.** No evidence it is a problem there, and desktop
  was not the complaint.

## Budget for entering V2

Targets, on a real device, not CI gates:

| | Target |
| --- | --- |
| Normal camera work | stable ≥ 30 fps |
| CITY VIEW | ≥ 24–30 fps |
| Camera drag / pinch | smooth; no throttle applies while the camera moves |
| UI interaction | no visible freeze |
| 10 minutes of use | no progressive degradation |

CI does **not** assert any of these. What CI asserts is that the *settings* a
measurement chose are still in place — see `apps/web/test/quality.test.ts`. A future
change that puts the mobile pixel budget back to desktop levels, or loads ten wards on
a phone again, fails a test instead of a device.

## Designing for V2–V4

The scale target is nationwide, multi-modal, individual vehicles. The pattern already
in use for trains generalises and every new layer is expected to follow it:

| Camera scale | Representation |
| --- | --- |
| Nation | aggregate — counts, heatmap, no individuals |
| City | points or clusters |
| Street | individual objects, then 3D models for the nearest few |

Two rules follow from this baseline:

1. **No layer may update every object at the same fidelity every frame.** Trains already
   switch point → billboard → model by altitude; the next step, when entity counts make
   the CPU split non-trivial, is to update distant objects at a lower cadence than near
   ones. The measurement hook for deciding that is already in place: the per-layer CPU
   numbers in the PERFORMANCE panel.
2. **Frame count is a shared budget, not a per-layer one.** The animation ticker is
   global. When buses and flights join trains, they share the same cadence rather than
   each adding a reason to render.

---

# V1.2 — mobile stability

The V1.1 stabilization shipped and was verified on an iPhone. It did not meet its
targets, and the device report was specific enough to be worth quoting:

```
FPS 23.5 · avg 42.5 ms · median 17.0 ms · p95 157.0 ms · worst 183.0 ms
>33 ms 61/225 · >50 ms 56/225 · render req ~13/s · rAF ~23/s · app CPU 0.13 ms
rs 1.25 · DPR 3 · MSAA x1 · FXAA OFF · wards 3 · 30 Hz · 402x714
```

Three separate complaints came with it: the page reloads itself, the frame times are
bimodal, and the buildings look see-through. They are investigated separately below,
because nothing about them says they share a cause.

**The first thing that report says is that this is not a slow app.** A median of 17 ms
is 59 fps. An average of 42.5 ms is an artefact of a long tail, and any change judged on
the average would be judged on the wrong number. Everything below is about the tail.

## What Cesium 1.144 actually does

Read out of the installed package, not from memory. File references are to
`node_modules/@cesium/engine/Source`.

**One `Scene.render` call raises four events, in this order** (`Scene/Scene.js`):
`preUpdate` → pass updates → `postUpdate` → `preRender` → draw →
`callAfterRenderFunctions` → `postRender`. `preRender` and `postRender` fire only on
frames that actually render; the update pair fires every time. Timing between them is
the only way to separate an update stall from a draw stall, and it is what the app now
does.

**`CesiumWidget` runs its own `requestAnimationFrame` loop and calls `scene.render()` on
every frame** (`Widget/CesiumWidget.js`), regardless of `requestRenderMode`. Request
render mode decides whether the *draw* happens; the update passes run either way.

**3D Tiles content is parsed and uploaded in the update pass, with no time budget.**
`Cesium3DTileset.prototype.prePassesUpdate` calls `processTiles`, which loops over the
entire processing queue calling `tile.process(...)`. Its only exit is
`totalMemoryUsageInBytes > cacheBytes + maximumCacheOverflowBytes`
(`Scene/Cesium3DTileset.js`). So the number of tiles that finish downloading at the same
moment sets how long a single frame can become, and `RequestScheduler.maximumRequests` /
`maximumRequestsPerServer` (both public API) are the only handles on it.

**`Cesium3DTileset.statistics` is not public.** It exists at runtime — `processTiles`
destructures it — but it is absent from the shipped `Cesium.d.ts`, so the diagnostics
deliberately do not use it. Everything the panel reports comes from documented API:
the `loadProgress` event (pending requests, tiles processing), `tileLoad` / `tileUnload`
/ `tileFailed`, `tilesLoaded`, and `totalMemoryUsageInBytes`. No private API is used
anywhere in this work.

**A theory that was checked and eliminated:** that the mobile profile's
`scene.msaaSamples = 1` leaves the render target without a stencil buffer, breaking the
3D Tiles skip-LOD selection that depends on one. It does not. `SceneFramebuffer`
constructs both of its framebuffer managers with `depthStencil: true` unconditionally
(`Scene/SceneFramebuffer.js`), and Cesium requests `stencil: true` on the context by
default (`Renderer/Context.js`). The panel reports the actual stencil bit depth so this
never has to be assumed again.

## A. The page reloads itself

Not diagnosed. **Made observable**, which is the part that could be done without the
device.

A tab killed by iOS runs none of our code on the way out, so every fact about it has to
be written down before it happens. The app now keeps a record in `localStorage`
(`apps/web/src/scene/stability.ts`): a session id, a 2 s heartbeat, the last known scene
state, and a ring buffer of events. After a restart the previous record is still there.

The distinction that matters is not the Navigation Timing type — a deliberate
pull-to-refresh reports `reload` exactly like a crash recovery does. It is whether a
`pagehide` was ever recorded. A record left behind without one means the page went away
without the browser giving notice, and that is counted as an **unexpected restart** and
kept across sessions.

Alongside it: `webglcontextlost` and `webglcontextrestored` are now handled. The handler
calls `preventDefault()`, which is what allows the browser to restore a context at all —
without it a lost context is permanent and the map is blank for the rest of the session.
Nothing in the codebase listened for either event before.

What the 性能 tab now shows, and what to read from it after the next reload:

| Row | What it answers |
| --- | --- |
| SESSION / 予期しない再起動 | Did the page die, or did you refresh it? |
| 前回セッション | How long it survived, and the last event before it ended |
| 終了時の状態 | Tile memory, tileset count and altitude at the moment it died |
| STABILITY ログ | `stall`, `hidden`, `webgl-lost`, `error` — in order, with timings |
| コンテキスト消失 | Whether WebGL was lost, cumulative across sessions |

If `終了時の状態` shows a large tile memory figure, the mobile budget is the first thing
to cut: three wards at 48 MB + 16 MB overflow each is up to **192 MB of tile memory**,
which is arithmetic, not a measurement. That change was NOT made here, because cutting a
budget on arithmetic alone is the guess this phase was supposed to replace.

## B. The long frames

The app now times three parts of every frame and reports the fourth by subtraction:

| Bucket | Covers |
| --- | --- |
| `更新` | `preUpdate` → `postUpdate`: globe update, 3D Tiles preload passes, and tile content parse + GPU upload |
| `アプリ` | our own `preRender` handler: the train, rail, follow and building layer updates |
| `描画` | end of our handler → `postRender`: draw-command execution and Cesium's after-render callbacks |
| `その他` | the browser's animation-frame period minus the three above: GPU execution, buffer swap, compositing |

**`その他` is the bucket that turned out to matter**, and it was not in the original
design. Measured on CI at 390×844 with PLATEAU blocked
(`screenshots/m5-tab-performance.png`), the worst frame in a 10 s window was

```
最悪フレーム  157.5 ms
              更新 0.0 · アプリ 0.40 · 描画 2.3 · その他 154.8 ms
```

— 98 % of the stall in the bucket that did not exist before this change. In the
heavy-fixture sweep a 713 ms frame contained 0.2 ms of update and 9.8 ms of draw
submission. Without the subtraction the panel would have reported a 3 ms frame and
called it healthy.

The period is measured **rAF to rAF, not render to render**, and that distinction is not
cosmetic. With `requestRenderMode` and the 30 Hz mobile animation cap, two consecutive
renders are 33 ms apart on a phone that is doing nothing whatsoever in between;
subtracting the spans from *that* would invent 30 ms of GPU time on an idle device and
report a stall that does not exist. The browser's own frame period cannot be inflated
that way — if it is 157 ms, the browser really did take 157 ms.

This is what makes the device readout actionable, because the two large buckets have
nothing in common:

- **`その他` dominates** → the frame is GPU / compositor bound. The levers are pixels,
  overdraw and geometry: resolution scale, MSAA, FXAA, screen-space error, ward count.
- **`更新` dominates** → 3D Tiles content processing. The levers are how many tiles may
  arrive at once (`?req=`) and how much is resident.
- **`アプリ` dominates** → our code. It never has: 0.13 ms on the device, 2.4 ms on a
  software rasteriser.

### The request-cap A/B, and why nothing shipped from it

The Cesium source above says an unbounded burst of arriving tiles can produce an
unbounded frame. The obvious change is to cap `RequestScheduler.maximumRequests` on
mobile. It was measured before being made, over a purpose-built three-level tileset with
leaf tiles heavy enough to cost something to parse
(`PERF=1 npx playwright test e2e/stall-isolation.spec.ts`):

| Scenario | median | p95 | update p95 / max | draw p95 / max |
| --- | --- | --- | --- | --- |
| req 50 — tile loading | 542.7 | 811.2 | 12.2 / 12.2 | 27.9 / 27.9 |
| req 50 — settled | 713.5 | 755.9 | 0.2 / 0.2 | 9.8 / 9.8 |
| req 6 — tile loading | 159.3 | 411.8 | 0.8 / 13.0 | 21.0 / 61.6 |
| req 6 — settled | 703.3 | 744.7 | 0.3 / 0.3 | 8.8 / 8.8 |

The loading row looks like a large win and is not one: with `req 6` the arm had loaded
0 MB against the other arm's 7 MB, so it was drawing less, not stalling less. Settled,
the two arms are the same frame time. And in every arm the update pass stayed under
13 ms — **there was no processing stall to remove**, because the whole fixture is 2.5 MB
served from localhost while a real PLATEAU tile is orders of magnitude larger.

So the request cap **was not shipped**. It is exposed as `?req=` and `?reqserver=` so the
A/B can be run where the stall actually exists. Shipping it on this evidence would have
been a guess with a number attached to make it look measured.

## C. The see-through buildings

**Not reproduced, and not conclusively explained.** What follows is what was established
and what remains open, kept separate on purpose.

The starting hypothesis was read out of the Cesium source: `skipLevelOfDetail` draws
not-yet-final tiles with the colour mask off, so a tileset mid-load contains invisible
geometry. **That reading was wrong, and the experiment is what caught it.** In
`Model/ModelDrawCommand.js`, a tile in a mixed-content tileset gets its normal
stencil-tested colour command *and*, if it is not at final resolution, an **additional**
depth-only back-face command. The colour mask is off on the extra pass, not on the tile.

The A/B says the same thing (`npx playwright test e2e/skiplod.spec.ts`; both arms at
390×844, three-level REPLACE fixture, half the leaves held back 30 s, identical fixed
camera over 西新宿, trains off, measured as building-layer painted pixel coverage):

| Arm | Coverage | Screenshot |
| --- | --- | --- |
| `?sklod=1&leaves=1` (shipped) | **41.5 %** | `perf/skiplod/skiplod-on.png` |
| `?sklod=0&leaves=0` | **27.6 %** | `perf/skiplod/skiplod-off.png` |

Turning skip-LOD off makes the layer paint **less** while tiles are arriving, not more:
Cesium then refuses to refine until every child of a tile is ready, so the view sits on
the coarsest level for longer. **So nothing was changed.** Changing a renderer setting
because a symptom disappeared, when the measurement points the other way, is exactly the
"it seems fixed now" this phase was told not to produce.

What survives as a hypothesis, narrowed rather than abandoned: that extra back-face pass
(`deriveSkipLodBackfaceCommand`, polygon offset 5/5) assumes tile geometry is a closed
solid. PLATEAU LOD1 buildings are extruded footprints and are not reliably closed; on an
open or inverted mesh the "back face" can land in front of the front face, and then real
surfaces fail the depth test and leave holes. The fixture here is closed boxes with
`doubleSided: true`, so it cannot exercise that path, and **this container cannot reach
PLATEAU at all** — every Japanese data host (`*.plateau.reearth.io`, `*.mlit.go.jp`,
`*.gsi.go.jp`, `*.odpt.org`) returns HTTP 403 through the egress proxy.

So the A/B moves to the device, which is why the tuning is URL-addressable. At 西新宿 on
the phone, with the 性能 tab open:

```
https://<pages-url>/?sklod=1        ← shipped behaviour
https://<pages-url>/?sklod=0        ← no skip-LOD selection
https://<pages-url>/?sklod=1&leaves=0
https://<pages-url>/?dsse=0         ← no dynamic screen-space error
```

The panel's `3D Tiles` row states which combination is live, and `TILES 配信中` /
`TILES 常駐` state whether the tileset is still streaming or settled — which separates
"see-through while loading" from "see-through when finished". Those are different bugs
and only the second one is a rendering fault.

## What shipped, and what did not

| Change | Evidence |
| --- | --- |
| Frame split into update / app / draw / other, with p99 and >100 ms | The device's own numbers were bimodal and unattributable |
| Whole-frame ranking of the worst frame | A 713 ms frame showed 10 ms of visible work; ranking by spans reported the wrong frame |
| Persistent session record, heartbeat, unexpected-restart count | A killed tab runs no code; the record has to predate the crash |
| `webglcontextlost` / `restored` handling with `preventDefault()` | Nothing listened; a lost context was silent and permanent |
| 3D Tiles streaming counters from public API only | `Cesium3DTileset.statistics` is not in the 1.144 type definitions |
| Tile tuning exposed as URL parameters | The A/B that matters can only be run on the device |
| **Not shipped:** mobile request cap | Measured; no stall to remove in this environment |
| **Not shipped:** `skipLevelOfDetail: false` | Measured; it painted less, not more |
| **Not shipped:** smaller tile cache / ward budget | Only arithmetic supports it; the record will now say whether memory was the cause |

## Verifying A, B and C on the device

CI cannot pass or fail any of this. The procedure is in `docs/DEVICE-CHECKS.md`.
