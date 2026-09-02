# Device checks

**Nothing in this file can be verified by CI, and a green CI run is never evidence that
any of it passed.** The container has no GPU, runs at devicePixelRatio 1, and cannot
reach any Japanese data host. These checks need a real iPhone, a real GPU, and real
PLATEAU tiles.

Open the deployed page, then **レイヤー / データ → 性能**. Scroll: the V1.2 sections
(TILES, WEBGL, SESSION, STABILITY) are below the frame timings.

## Reading the panel

The two rows that decide what to do next:

**最悪フレーム** breaks the slowest frame in the last 10 seconds into four parts.

- `その他` is the largest → the frame is GPU or compositor bound. Pixels, overdraw and
  geometry are the levers: resolution scale, MSAA, FXAA, screen-space error, how many
  wards are resident.
- `更新` is the largest → 3D Tiles content parsing and GPU upload. Cesium does this with
  no time budget, so the lever is how many tiles arrive at once (`?req=`).
- `アプリ` is the largest → our own layer code. It has never been more than a fraction
  of a millisecond; if this is ever the largest, something has gone badly wrong.

**予期しない再起動** counts pages that went away without the browser giving notice. A
deliberate refresh does not increment it. Anything above 0 is the reload being reported.

## A — the reload

1. Note **SESSION → 予期しない再起動** when you start.
2. Use the app normally for 10 minutes: CITY VIEW, 新宿, 渋谷, 東京駅, drag, pinch,
   follow a train.
3. If the page restarts, open 性能 immediately and record:
   - **予期しない再起動** — did it go up? If it did not, the page was reloaded by
     something that gave notice (a refresh, a navigation), not killed.
   - **前回セッション** — how long it survived, and the last event before it ended.
   - **終了時の状態** — tile memory, tileset count, altitude at the moment it died.
   - **STABILITY ログ** — the last few entries, especially any `stall` or `webgl-lost`.
4. **コンテキスト消失** must be 0. Anything else means WebGL was lost; the app now asks
   the browser to restore it, and the count says whether it happened at all.

A screenshot of the scrolled 性能 tab captures all of this in one image.

## B — the long frames

Target: normal camera work ≥ 30 fps, CITY VIEW ≥ 24–30 fps, p95 ≤ 50 ms, as few frames
over 100 ms as possible.

Read **p95 / p99 / 長いフレーム / 最悪フレーム** in each of these, letting the window
fill (about 10 s) before reading:

| Condition | How |
| --- | --- |
| Tile loading | immediately after flying somewhere new |
| Settled | 30 s after arriving, camera still |
| Camera moving | during a continuous drag |
| Buildings off | レイヤー → 3D建物 off |
| Trains off | レイヤー → 列車 off |
| Rail/stations off | レイヤー → 鉄道路線 and 駅 off |
| 新宿 / 東京駅 / CITY VIEW | camera presets |

The question is not which one has the lowest average. It is **which bucket the worst
frame is in**, and whether that changes between loading and settled.

## C — the see-through buildings

At 西新宿, same camera each time, with the 性能 tab open so `TILES 配信中` says whether
the tileset is still streaming:

| URL | What it changes |
| --- | --- |
| `?sklod=1` | shipped: descendants may render before ancestors resolve |
| `?sklod=0` | no skip-LOD selection; refine only when every child is ready |
| `?sklod=1&leaves=0` | skip-LOD without leaf-first requesting |
| `?dsse=0` | no dynamic screen-space error |

For each: does the see-through appear **while `TILES 配信中` shows outstanding
requests**, or does it persist after `TILES 常駐` reports the tileset settled? Only the
second is a rendering fault. Note also whether it differs between LOD1 and LOD2 — the
`3D建物` tab reports which is loaded.

A screenshot from the same camera in each arm is worth more than a description.

## Recording the result

Paste the panel numbers, not a summary of them, and say which condition each set came
from. `docs/PERFORMANCE.md` quotes device numbers verbatim for exactly this reason:
a number without its conditions cannot be compared to anything later.
