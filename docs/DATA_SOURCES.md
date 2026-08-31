# Data sources

Every external dataset JAPAN LIVE uses is recorded here. Entries are added or changed by
running `/data-source-audit`. No credentials, tokens, or keys belong in this file.

**Verification note.** The development container this was authored in has an outbound
egress policy that blocks every Japanese data host (`*.odpt.org`, `*.gsi.go.jp`,
`*.mlit.go.jp`, `assets.cms.plateau.reearth.io`) with HTTP 403 at the proxy. Endpoints
below were therefore verified against **official primary documentation reachable from
GitHub** (the `Project-PLATEAU/plateau-streaming-tutorial` repository, which is MLIT's
own tutorial) and official ODPT catalogue pages, not by calling the endpoints. Anything
that could not be verified this way is marked **UNVERIFIED** and the app treats it as
possibly-absent: every one of these sources fails soft. Re-run `/data-source-audit` from
an unrestricted network before relying on a field marked UNVERIFIED.

---

## 1. PLATEAU Terrain (全国3D地形)

| Field | Value |
| --- | --- |
| Publisher | 国土交通省 Project PLATEAU (MLIT) |
| Official documentation | https://github.com/Project-PLATEAU/plateau-streaming-tutorial (terrain/), https://docs.plateauview.mlit.go.jp/ |
| Distribution | Cesium ion asset, quantized-mesh. Asset ID `3258112`, with the public access token published in MLIT's own tutorial. |
| Format | quantized-mesh-1.0 |
| Authentication | Public ion token published by MLIT for this asset. Overridable via `VITE_CESIUM_ION_TOKEN`. |
| Coverage | Japan nationwide (global tileset, Japanese detail) |
| Update frequency | Irregular; dataset revisions published without notice |
| License | PLATEAU / 国土地理院 derived. Attribution required. |
| Required attribution | `地形データ: Project PLATEAU (国土交通省) / 国土地理院 (承認番号 R3JHs 778)` |
| CORS | Served by Cesium ion CDN; browser-accessible. No gateway needed. |
| Expiration | Token is MLIT-published and could rotate. App falls back to ellipsoid terrain. |
| DataMode | n/a (basemap layer, not a mobility entity) |
| Fallback | On any failure the app runs in **no-terrain mode** and says so. Never crashes. |
| Audited | 2026-08-31, from MLIT's own streaming tutorial |

Spec §5 asks to avoid depending on Cesium ion. Noted, but MLIT's *own* official tutorial
distributes PLATEAU Terrain through ion; there is no MLIT-hosted quantized-mesh endpoint
documented. See `docs/DECISIONS.md` D-002.

## 2. 地理院タイル (GSI basemap)

| Field | Value |
| --- | --- |
| Publisher | 国土地理院 (Geospatial Information Authority of Japan) |
| Official documentation | https://maps.gsi.go.jp/development/ichiran.html , 仕様 https://maps.gsi.go.jp/development/siyou.html |
| Endpoints | `https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png` (淡色, z5-18, Japan only) · `.../xyz/std/{z}/{x}/{y}.png` (標準) · `.../xyz/seamlessphoto/{z}/{x}/{y}.jpg` (写真) |
| Format | Raster XYZ tiles (PNG / JPEG) |
| Authentication | None |
| Coverage | Japan and surrounding area only. Outside coverage the tile 404s — a dark ocean base layer sits underneath. |
| Update frequency | Continuous, irregular |
| License | 国土地理院コンテンツ利用規約 (基本測量成果) |
| Required attribution | `地理院タイル (国土地理院)` with a link to https://maps.gsi.go.jp/development/ichiran.html |
| CORS | Publicly tiled for web map use. **UNVERIFIED** from this container. Failure is non-fatal. |
| Expiration | None |
| DataMode | n/a |
| Fallback | Tile errors leave the dark base globe visible. Never crashes. |
| Audited | 2026-08-31, from GSI tile list and 仕様 pages via official references |

## 3. PLATEAU 3D Tiles (東京 3D建築物)

| Field | Value |
| --- | --- |
| Publisher | 国土交通省 Project PLATEAU (MLIT) |
| Official documentation | https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/ , `Project-PLATEAU/plateau-streaming-tutorial` `3d-tiles/` |
| Catalog API | `https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets` → JSON list with `name`, ward codes, `type`, `url`, `composite_url` |
| Tileset URL | `composite_url` resolves to a `tileset.json`. Direct asset form: `https://assets.cms.plateau.reearth.io/assets/<hash>/<code>_<ward>_pref_<year>_citygml_<v>_op_bldg_3dtiles_<code>_<ward>_lod<N>/tileset.json` |
| Versioning | The catalog supports a `…-latest` designation (e.g. `13101-bldg-lod2-latest`) so a year is never hardcoded. The app resolves through the catalog at runtime and can be pinned by config. |
| Format | 3D Tiles (b3dm) |
| Authentication | None |
| Coverage | Per-municipality. V1 loads Tokyo 23 wards only. |
| Update frequency | Annual data releases, revisions without notice |
| License | PLATEAU open data, CC BY 4.0 (G空間情報センター). **Confirm the per-dataset licence line in the catalog response.** |
| Required attribution | `3D都市モデル: Project PLATEAU (国土交通省)` |
| CORS | **UNVERIFIED** from this container. Loaded directly by CesiumJS; failure is non-fatal. |
| Expiration | Asset URLs are year-stamped; the catalog `latest` path avoids pinning. |
| DataMode | n/a |
| Fallback | Catalog unreachable → bundled seed tileset list. Seed list fails → **buildings-off mode**, app still runs. |
| Audited | 2026-08-31, from MLIT streaming tutorial + PLATEAU 配信サービス docs |

## 4. ODPT — 東京都交通局 (Toei) 列車ロケーション情報

**This is V1's primary realtime source.**

| Field | Value |
| --- | --- |
| Publisher | 公共交通オープンデータセンター (ODPT) / 東京都交通局 |
| Official documentation | https://developer.odpt.org/ , catalogue https://ckan.odpt.org/dataset/r_train_location-toei |
| Endpoint | `https://api.odpt.org/api/v4/odpt:Train?odpt:operator=odpt.Operator:Toei&acl:consumerKey=<KEY>` |
| Related | `odpt:TrainTimetable`, `odpt:TrainInformation` (運行情報), `odpt:Station`, `odpt:Railway`, GTFS-RT Alert (`r_train_gtfs_rt-odpt_train-toei`) |
| Capabilities | `odpt:trainNumber`, `odpt:railway`, `odpt:trainType`, `odpt:destinationStation`, `odpt:fromStation`, `odpt:toStation`, `odpt:delay` (seconds), `odpt:railDirection`, `odpt:carComposition`, `dc:date`, `dct:valid` |
| **No latitude/longitude** | Position is expressed as *between two stations*, or *at a station* when only `fromStation` is set. There is no GPS coordinate in this feed. |
| Authentication | `acl:consumerKey` query parameter. Held **server-side in apps/gateway only**. |
| Update frequency | Roughly every 10-30 s while trains run; first train to last train only. Outside service hours the feed is legitimately empty. |
| Freshness budget | 90 s → STALE. 300 s → degrade to `SCHEDULE_INTERPOLATED`. |
| License | ODPT terms of use; attribution required; redistribution restricted |
| Required attribution | `東京都交通局 / 公共交通オープンデータセンター` |
| CORS | Not usable directly from a browser with a secret key. **Always via gateway.** |
| Expiration | Keys are per-developer-account and can be revoked |
| **DataMode** | **`REALTIME_TRIP`** — realtime, but *not* a realtime coordinate. The lat/lon shown is interpolated onto the route shape between the reported stations. It is **never** labelled `REALTIME_POSITION`. |
| Degrades to | `SCHEDULE_INTERPOLATED` when stale, `UNAVAILABLE` when the feed errors |
| Audited | 2026-08-31 |

## 5. ODPT — 東京メトロ (Tokyo Metro)

| Field | Value |
| --- | --- |
| Publisher | ODPT / 東京地下鉄株式会社 |
| Official documentation | https://ckan.odpt.org/dataset/r_train_status-tokyometro |
| Endpoints | `odpt:TrainTimetable`, `odpt:Station`, `odpt:Railway`, `odpt:TrainInformation`. `odpt:Train` availability for Metro is **UNVERIFIED** from this container. |
| **DataMode** | `SCHEDULE_INTERPOLATED`, upgraded to `REALTIME_STATUS` overlay when `odpt:TrainInformation` (delay/suspension) is present. If `odpt:Train` turns out to be available at runtime, the provider promotes to `REALTIME_TRIP` — the capability is probed, never assumed. |
| Everything else | As ODPT above (same auth, gateway, licence, attribution) |
| Audited | 2026-08-31 |

## 6. JR東日本 (JR East) — **DISABLED in V1**

| Field | Value |
| --- | --- |
| Status | Provider implemented, registered **disabled**. No requests are made. |
| Reason | JR East realtime/GTFS-RT distribution has historically been contest-scoped, time-limited, or licence-restricted. The eligibility to use it could not be verified from this container, and spec §11 forbids using it without confirming entitlement. |
| Enable | Verify current terms, then set `enabled: true` in the provider registry. V2 work. |
| DataMode | `UNAVAILABLE` while disabled |

## 7. JAPAN LIVE Demo dataset — **not real data**

| Field | Value |
| --- | --- |
| Publisher | This repository. Generated by `scripts/data/build-demo-dataset.mjs`. |
| Purpose | Let the app run, and the public GitHub Pages build be viewable, with no credentials (spec §41-43) |
| Content | Approximate Toei + Tokyo Metro line geometry and station positions, and a synthetic timetable |
| **Accuracy** | Geometry is **approximate and hand-authored**, not survey data. It is a stand-in for real GTFS `shapes.txt`, and is replaced the moment `scripts/data/build-gtfs-dataset.mjs` is run against real feeds. |
| **DataMode** | **`SIMULATED`**, always. The UI shows a persistent `DEMO / SIMULATED DATA` badge whenever it is in use. It is never presented as real, live, or realtime. |
| License | This repository's licence |

---

## DataMode assignment summary

| Source | DataMode | Why |
| --- | --- | --- |
| Toei `odpt:Train` | `REALTIME_TRIP` | Realtime, station-pair resolution, no coordinate |
| Toei `odpt:TrainInformation` | `REALTIME_STATUS` | Delay/suspension overlay only |
| Tokyo Metro timetable | `SCHEDULE_INTERPOLATED` | Timetable + shape interpolation |
| Tokyo Metro + 運行情報 | `SCHEDULE_INTERPOLATED` + `REALTIME_STATUS` overlay | Position is still schedule-derived |
| JR East | `UNAVAILABLE` | Provider disabled |
| Demo dataset | `SIMULATED` | Synthetic |
| Any of the above, stale | degraded, then `UNAVAILABLE` | Never shown as current |

**Nothing in JAPAN LIVE V1 produces `REALTIME_POSITION`.** No V1 source publishes true
vehicle coordinates. The renderer supports the mode; no provider claims it. That is the
honest result of the audit, and the UI states it.
