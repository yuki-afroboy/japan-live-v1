# V2 — TOKYO RAIL NETWORK: implementation plan

**Do not start this until `/v1-quality-gate` passes.** Written now so V1's architecture
can be checked against it, not so it can be built early.

Theme: 首都圏という巨大な鉄道機械 — the metropolitan area as one enormous machine.
V1 shows that trains move. V2 should make the *system* legible: density, direction,
rush hour, through-running, the last train emptying the network.

## What V1 already provides

These need no rework, and V2 must not break them:

- `MobilityEntity` / `DataMode` / `PositionSource` — already multi-modal and
  multi-operator by construction.
- `MobilityProvider` — adding an operator is a new file plus a registry line.
- `TripPattern` expansion — only trains active *now* are materialized, which is what
  makes thousands tractable.
- Primitive-based rendering — `PointPrimitiveCollection` / `BillboardCollection`
  already batch; V1 runs ~360 trains through a path sized for far more.
- `SimulationClock` with ×1/×10/×60/×600 and LIVE exclusivity — the time model V2 needs
  is already built and tested.

## Work, in order

### 1. Operator coverage
Add `KeioProvider`, `OdakyuProvider`, `TokyuProvider`, `SeibuProvider`,
`TobuProvider`, `KeioProvider`, plus JR East once its licence is verified (D-007).
Each is a `MobilityProvider`; none may add a branch anywhere above `packages/providers`.

Enable JR East by verifying terms, then flipping `enabled` — the provider is written.

### 2. Real static data as the default
Make `npm run data:gtfs` output the shipped dataset and retire the approximate demo
geometry to a fallback. Published `shapes.txt` geometry replaces the spline where
operators provide it; `DatasetMeta.approximate` already carries this distinction to
the UI.

### 3. Service richness
`odpt:TrainInformation` is already parsed into `ServiceAlert`. V2 surfaces it properly:
delays and suspensions per line, destinations, train types (各停/急行/特急), and
through-running across operators — which needs trip identity to survive an operator
boundary, the one genuinely new modelling problem in V2.

### 4. Density rendering
At metropolitan scale, thousands of individual dots become noise. Add a density/flow
representation above ~80 km — line-weight by train count, or a flow field — while
keeping individual entities below it. This is the one place V2 should add a *new*
LOD band rather than retune existing ones.

### 5. Timetable playback
`SimulationClock` already scrubs and accelerates. V2 adds framing: named scenarios
(朝ラッシュ, 終電, 24時間を20分で), and a playback that starts from a chosen service
day rather than today.

### 6. Performance work
V2 is where measurement stops being optional. Establish the numbers V1 could not
(see "Known gaps" below), then decide whether trains need instanced geometry, whether
route polylines need per-zoom simplification tiers, and whether the entity store should
move to typed arrays.

## Constraints that carry forward unchanged

- No `REALTIME_POSITION` unless a provider genuinely publishes coordinates.
- Anything other than ×1 is `SIMULATION` / `PLAYBACK`, never LIVE.
- Provider-specific logic never reaches the UI.
- Every new source goes through `/data-source-audit` before code depends on it.
- Credentials stay in the gateway.

## Known gaps V2 must close

1. **Real-hardware performance is unmeasured.** V1's build environment has no GPU, so
   frame rate, memory and tile behaviour were never observed. Measure before optimizing.
2. **Terrain, buildings and basemap were never seen rendering with real data.** Their
   hosts are egress-blocked in the build environment (D-001). V1.1 closed part of this
   for buildings: the pipeline is now verified against a real generated 3D Tiles
   fixture, so everything except PLATEAU's own endpoints is proven. What remains
   unverified is whether those endpoints serve tiles to a browser from a github.io
   origin (their CORS allowlist is a deploy-time variable — D-012).
3. **Station labels overlap at some zooms.** Cesium's `LabelCollection` has no built-in
   declutter; V1 mitigates with distance conditions only.
4. **Metro `odpt:Train` availability is still unprobed against the live API.**
   `TokyoMetroProvider.probeRealtimeTrip()` exists and is wired but has never run
   against the real endpoint.
