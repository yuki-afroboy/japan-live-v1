# JAPAN LIVE — Roadmap

The end state is V4. V1 is built to completion first, and its architecture is chosen so
V2-V4 slot in without a rewrite. Work does not begin on a later version until the
`/v1-quality-gate` procedure passes.

## V1 — TOKYO TRAINS  *(current)*

"The trains of Tokyo are moving."

3D Japan terrain · nationwide relief · seamless zoom to Tokyo · PLATEAU 3D buildings ·
rail routes · stations · moving trains · JST clock · realtime + schedule train positions ·
train follow · LIVE mode · SIMULATION mode · subway X-Ray · train/station click ·
DataMode confidence display · camera presets.

Primary realtime target: **都営地下鉄 (Toei)** via ODPT `odpt:Train` → `REALTIME_TRIP`.
**東京メトロ** via timetable interpolation + live status overlay.
**JR東日本** provider exists but is **disabled** pending licence verification.

## V2 — TOKYO RAIL NETWORK

"The metropolitan area as one enormous machine."

JR · private railways · subway · monorail · new transit · Shinkansen · delays ·
suspensions · destinations · train types · through-service · timetable playback ·
morning rush · last train · time acceleration ×1/×10/×60/×600.

Anything not ×1 is labelled `SIMULATION` / `PLAYBACK`, never LIVE.

## V3 — JAPAN TRANSPORT

"Everything in Japan is moving."

Buses · aircraft · ferries · other available public transport, with zoom-driven modal
switching: nationwide shows flights/ships/long-distance rail; Kanto shows rail/bus/air;
Tokyo shows rail/bus; street level shows individual vehicles and 3D buildings.

Aircraft and ships without true position data are never drawn as `REALTIME_POSITION`.

## V4 — JAPAN LIVE

"Japan itself is alive."

Real day/night and sun position · weather · rain clouds · precipitation · typhoons ·
road traffic and congestion · people flow · station crowding · urban activity · air and
maritime traffic · disaster information · events.

Constraints that hold throughout: no fabricated realtime data; aggregate-only human
movement, never individual tracking; no scraping of third-party services; anything
without an official source ships as `SIMULATED` / `ESTIMATED` / `HISTORICAL`.

## Explicitly not built before V1 passes

Buses · aircraft · ships · people flow · cars · advanced weather · disasters · the
national rail network · every private railway · photorealistic train models.
Only the architecture that keeps them possible.

## The performance contract every future layer inherits

Measured in V1.1 (`docs/PERFORMANCE.md`), and binding on Bus, Flight, Ferry, Weather,
Traffic and People when they arrive:

1. **Detail is a function of camera scale, not of layer.** Nation → aggregate or heatmap.
   City → points and clusters. Street → individual objects, with 3D models only for the
   nearest handful. Trains already do this; nothing new may skip it.
2. **No layer updates every object at full fidelity every frame.** The frame budget is
   shared across all layers, so per-object work has to fall off with distance.
3. **Frame count is one global budget.** The animation ticker is shared. A new moving
   layer joins the existing cadence; it does not add a second reason to render.
4. **Every layer reports its own CPU cost per frame** through the PERFORMANCE panel, so
   the next bottleneck is attributed rather than guessed at.
5. **Quality settings live in one profile** (`apps/web/src/scene/quality.ts`) with tests
   on them, not scattered as literals across the scene code.
