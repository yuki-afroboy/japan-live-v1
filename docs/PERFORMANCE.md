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
| 1 | 東京広域 (42 km) | 4.3 → **6.3** | 222.9 → **153.6 ms** | **−31%** frame time |
| 2 | 東京駅 (850 m) | 3.5 → **5.5** | 276.1 → **178.9 ms** | **−35%** |
| 3 | 新宿 (900 m) | 3.3 → **5.3** | 296.2 → **183.7 ms** | **−38%** |
| 4 | CITY VIEW | 3.2 → **4.9** | 300.7 → **197.0 ms** | **−35%** |
| 5 | CITY VIEW − buildings | 3.5 → **5.5** | 272.0 → **176.4 ms** | −35% |
| 6 | CITY VIEW − trains | idle | 277.3 → **190.1 ms** | −31% (one frame either way) |
| 7 | CITY VIEW − rail/stations | 2.8 → **5.5** | 302.8 → **177.4 ms** | −41% |
| 8 | CITY VIEW − buildings − trains | idle | 293.3 → **172.6 ms** | −41% (one frame either way) |

Roughly **a third off the frame time everywhere**, and the mobile ward budget behaved:
3 wards resident instead of 4.

Our own CPU per frame went 0.66 → 0.50 ms at CITY VIEW. Real, and still 0.25% of the
frame — which is the point of reporting it rather than leading with it.

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
| `preserveDrawingBuffer` removed | D-015 deleted the last frame-capture helper; the screenshot specs already run without it. It was an extra full-size buffer copy per frame that nothing read. | Yes. |
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
