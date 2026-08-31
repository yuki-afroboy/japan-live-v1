---
name: v1-quality-gate
description: Run the V1 TOKYO TRAINS acceptance procedure for JAPAN LIVE — verify 3D Japan terrain, Tokyo 3D buildings, routes, stations, moving trains, DataMode correctness, realtime/schedule distinction, X-Ray, LIVE/SIM, Inspector, Follow, camera presets, fallback behavior, attribution, tests and build, with real visual verification. Use when checking whether V1 is done, before declaring V1 complete, and before starting any V2 or later feature.
allowed-tools: Read, Glob, Grep, Bash, Edit, Write
---

# V1 quality gate — TOKYO TRAINS

The acceptance run for V1. **No V2-V4 feature work begins until this passes.**

Rules for this run:

- **Actually look at the app.** Build it, run it, and exercise each item in a browser.
  A passing build is not verification, and reading the code is not verification.
- Every item is PASS, FAIL, or BLOCKED with a reason. Nothing is assumed.
- Any data-integrity failure (sections 6-8) fails the whole gate outright, however good
  everything else looks.
- Record what you observed, not what should happen.

## 1. 3D Japan terrain

- Terrain loads and renders with real elevation; relief is visible where it should be.
- Terrain is correct around Tokyo and still loads elsewhere in Japan.
- No holes, seams, z-fighting, or flickering under camera movement.

## 2. Tokyo 3D buildings

- Tokyo building tiles load and are positioned correctly against terrain.
- Tiles refine and coarsen sensibly as the camera moves; no thrash, no stuck low LOD.
- Memory stays bounded during an extended fly-around.

## 3. Routes

- Rail routes render as geometry on the map, following real alignments.
- Lines are distinguishable and legible at both city and street scale.
- Route geometry thins or hides at distance rather than turning into visual noise.

## 4. Stations

- Stations render at correct positions with correct names.
- Labels are readable, do not overlap into unreadability, and declutter at zoom.
- Selecting a station gives a sensible result.

## 5. Moving trains

- Trains appear and move continuously along their routes. No teleporting between polls.
- Heading follows the route shape.
- Movement holds up at target scale — check frame rate with the full set loaded.
- Trains appear and disappear correctly at trip start and end.

## 6. Correct DataMode

- Every rendered vehicle carries an explicit `DataMode`.
- `DataMode` is assigned in the provider adapter and never raised downstream.
- Every realtime mode carries an observation timestamp.
- Stale data degrades to `SCHEDULE_INTERPOLATED` or `UNAVAILABLE` as specified — force
  this by stalling or blocking the feed and watch it happen.
- Missing values are `null` with `UNAVAILABLE`, never invented or defaulted.

## 7. Realtime / schedule distinction

- `REALTIME_POSITION` entities are visually distinct from `SCHEDULE_INTERPOLATED` ones,
  at a glance, without opening a panel, and not by color alone.
- No label, tooltip, icon, or copy string implies "live" for non-realtime data.
- Confirm against the real feed what is actually realtime — do not take the UI's word
  for it.

## 8. X-Ray

- The X-Ray view exposes the underlying data state per entity: mode, source, timestamps,
  freshness, and provenance.
- It agrees with what the map is showing. Any disagreement is a gate failure.

## 9. LIVE / SIM

- The LIVE/SIM indicator is persistent, legible, and correct in both states.
- Switching to SIM is unmistakable; nothing in SIM can be mistaken for live data.
- Simulated entities normalize into the same mobility model, carrying `SIMULATED`.

## 10. Inspector

- Selecting a train opens an inspector with the correct trip, route, and status.
- Fields are grouped and scannable; unknown fields read as unknown.
- The inspector closes cleanly and does not leak listeners or block the map.

## 11. Follow

- Follow attaches the camera to a moving train and tracks it smoothly.
- The followed state is obvious and exitable at any time.
- Follow survives a data update and ends gracefully when the trip ends.

## 12. Camera presets

- Each preset flies to its intended framing.
- Flights are smooth, interruptible, and respect `prefers-reduced-motion`.
- Presets behave from any starting camera position.

## 13. Fallback behavior

Exercise each failure deliberately:

- Feed unreachable → `UNAVAILABLE`, honest UI, no stale data shown as current.
- Feed stale → correct degradation, visible to the user.
- Partial coverage → covered entities live, uncovered ones honestly labeled.
- Tileset or terrain unavailable → app still usable, failure stated.
- No crash, no blank map, no silent empty list presented as "no trains".

## 14. Attribution

- Every source requiring credit displays its exact required text where required.
- Attribution is visible in the running app, not only in `docs/DATA_SOURCES.md`.
- `docs/DATA_SOURCES.md` matches the sources actually in use.

## 15. Tests

- The full test suite runs and passes. Report the command and the result.
- Coverage exists for service-day handling, shape interpolation, and `DataMode`
  assignment and degradation.
- No test is skipped or disabled to make this pass.

## 16. Build

- A clean production build succeeds with no errors.
- No secret, key, or token appears in build output. Grep the bundle to confirm.
- Bundle size and load time are recorded.

## 17. Visual verification

- Run the production build and walk the whole experience: load, fly, select, inspect,
  follow, preset, X-Ray, LIVE/SIM, and each fallback.
- Check desktop and a mobile viewport.
- Capture screenshots of the key states.

## Report

A table of all 17 sections with PASS / FAIL / BLOCKED, the evidence for each, screenshots
or described observations, and an explicit overall verdict. If any section fails, the
gate fails: list what must be fixed, and do not begin V2-V4 work.
