# JAPAN LIVE

Permanent project rules. These hold for every session and every version.

## Product

- **Product name:** JAPAN LIVE
- **Ultimate target (V4):** a Japanese real-time digital twin — nationwide, multi-modal.
- **Current target (V1):** TOKYO TRAINS — Tokyo rail, map-first, in 3D.
- **Do not implement later-version (V2-V4) features until the V1 quality gate passes.**
  Out-of-scope ideas go to `docs/ROADMAP.md`, not into code.

## Priorities

1. **SCALE** — many moving entities at once; data paths that can grow past Tokyo.
2. **MOTION** — continuous, smooth movement; never teleporting position steps.
3. **IMMERSION** — 3D, cinematic, map-first.
4. **DATA INTEGRITY** — the constraint on the other three, not the last of four. When
   the first three conflict with each other, resolve in the order above. When any of
   them conflicts with data integrity, data integrity wins: degrade the visual, never
   the truth.

## Data integrity (non-negotiable)

Never represent inferred, schedule-based, simulated, stale, or unavailable data as
realtime positioning — in the UI, in logs, in docs, or in API responses.

Every mobility entity carries an explicit `DataMode`:

| DataMode | Meaning |
| --- | --- |
| `REALTIME_POSITION` | Provider published an actual observed vehicle position. |
| `REALTIME_TRIP` | Realtime trip/delay data; no published position. |
| `REALTIME_STATUS` | Realtime service status or alerts only. |
| `SCHEDULE_INTERPOLATED` | Position derived from timetable plus route shape. |
| `SIMULATED` | Synthetic or demo motion. |
| `HISTORICAL` | Replay of past data. |
| `UNAVAILABLE` | No usable data. |

- `DataMode` is assigned where data enters the system (the provider adapter), and is
  never guessed or upgraded downstream.
- A realtime `DataMode` requires an observation timestamp. Past its freshness budget it
  degrades to `SCHEDULE_INTERPOLATED` or `UNAVAILABLE`; it never silently persists.
- A feed offering GTFS-RT does not mean it publishes VehiclePosition. Verify per feed.
- The UI must distinguish LIVE / SIM / DEMO at a glance, without opening a panel.
- Missing data is `null` plus `UNAVAILABLE`. Never invent, pad, or default a value.

## External data

- Verify changing external-data claims — endpoints, auth, fields, coverage, update
  frequency, licenses, rate limits — against current official primary documentation
  before implementing. Do not rely on memory, blog posts, or an older note in this repo.
- Record every external dataset and its license in `docs/DATA_SOURCES.md`.
  Use `/data-source-audit` when adding or changing a source.
- Render each source's required attribution in the app.

## Secrets

- Never commit or expose API tokens, credentials, or secrets — not in code, tests,
  fixtures, logs, docs, commit messages, or anything shipped to the browser.
- Provider credentials live server-side in `apps/gateway` only. The browser never
  receives, stores, or sends a provider key.
- Configuration comes from environment variables. `.env` files are gitignored.

## Architecture

Planned layout:

| Path | Holds |
| --- | --- |
| `apps/web` | Cesium + React client. The map-first experience. |
| `apps/gateway` | Server-side provider proxy. Holds credentials. |
| `packages/transit` | GTFS/GTFS-RT parsing, service days, interpolation, mobility model. |
| `packages/providers` | One adapter per data provider. |
| `scripts/data` | Offline dataset fetch and build. |
| `docs` | `DATA_SOURCES.md` and design notes. |

- Provider-specific logic stays in `packages/providers` and never reaches UI rendering
  code. The UI reads the common mobility model only.
- Realtime and simulation normalize into that same common mobility model, so a renderer
  cannot tell them apart except by `DataMode`.
- Keep the primary experience map-first: the 3D map is the app. Panels, lists, and
  timetables are overlays on it, never a replacement for it.
- Treat performance as a product requirement, not a later optimization pass.

Path-scoped detail lives in `.claude/rules/` and loads when working in those trees:
`frontend.md`, `transit-data.md`, `gateway-security.md`.

## Working agreement

- **Main Claude owns integration.** Cross-cutting edits, wiring, and merges happen in
  the main session.
- **Use specialists for independent research and review**, not for parallel feature work:
  - `gis-researcher` — Cesium, PLATEAU, GSI, terrain, 3D Tiles, LOD, licensing.
  - `transit-data-auditor` — ODPT and other transit feeds, GTFS/GTFS-RT, DataMode.
  - `frontend-ux-reviewer` — map-first UX, LIVE/SIM/DEMO clarity, presentation.
  - `performance-reviewer` — rendering scale, rerenders, polling, memory.
- **Avoid concurrent edits to the same files.** One writer per file at a time; give
  subagents read-only research or review scope.
- **Build, test, and visually verify meaningful changes** before calling them done. For
  anything that renders, actually look at it — a passing build is not verification.
- **Wait for long commands; do not poll them.** Block on completion (a wait/until
  condition, a background task's own notification) rather than re-checking status every
  few seconds, and skip the running commentary. If a status check is genuinely needed,
  leave a generous interval. Report the final result once the run finishes — and
  intervene mid-run only on an error.
- Agent Teams stay off for V1. Reconsider for V2 once the architecture has settled.
- Add MCP servers, plugins, frameworks, and dependencies only when a task genuinely
  needs one. Prefer what is already here.

## Skills

- `/data-source-audit` — adding or changing an external dataset.
- `/v1-quality-gate` — the V1 TOKYO TRAINS acceptance run.
