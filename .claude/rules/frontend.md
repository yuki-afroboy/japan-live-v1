---
paths:
  - "apps/web/**"
---

# Web client rules (apps/web)

## Cesium / React separation

- React owns UI state and DOM. Cesium owns the globe, the scene graph, and the camera.
- Create the `Viewer` once, outside React render. Never store Cesium objects
  (`Viewer`, `Scene`, `Entity`, `Primitive`, `Cesium3DTileset`) in React state — keep
  them in refs or a scene controller module.
- React must not re-render per frame. Per-frame work belongs in Cesium callbacks or a
  controller loop, not in component bodies or effects.
- Talk to Cesium through a small imperative scene API (`addVehicles`, `updateVehicles`,
  `flyTo`, ...). Components call that API; they do not touch Cesium internals.
- No provider-specific code here. The UI consumes the common mobility model and
  `DataMode` only.

## Map-first UI

- The 3D map fills the viewport and is always interactive. Panels, inspectors, and lists
  are overlays or drawers over the map; none of them replaces it.
- Overlays never block the map's center. Keep them to the edges and make them dismissible.
- LIVE / SIM / DEMO state must be readable at a glance, without opening a panel, and must
  not rely on color alone — use a label plus an icon or shape.
- Never render an entity as realtime-positioned unless its `DataMode` is
  `REALTIME_POSITION`. Interpolated, simulated, historical, and stale entities are
  visually distinct and labeled with their actual mode.
- Show a source's required attribution wherever that source is displayed.

## Rendering scale and LOD

- Many entities means `Primitive` / `PointPrimitiveCollection` / `BillboardCollection`,
  not one `Entity` per vehicle. Use `Entity` only for small, dynamic, one-off features.
- Drive motion by interpolating over time, not by replacing positions on each poll.
  A vehicle update changes the target of the interpolation; it does not teleport the mesh.
- Apply LOD by camera altitude and distance: swap detailed models for billboards or
  points, drop labels, thin route geometry, and cull off-screen entities.
- Tune 3D Tiles with explicit `maximumScreenSpaceError` and memory caps rather than
  defaults. Verify tileset load behavior when the camera moves fast.
- Batch scene mutations; avoid per-entity work inside a render loop.

## Performance

- Treat frame rate as a requirement. Measure before optimizing, and say what you measured.
- Keep the main thread free: parse, decode, and transform data off the render path.
- Poll on a fixed cadence sized to the feed's real update frequency. Never poll faster
  than the source updates, and back off on errors.

## Responsive behavior

- Support desktop and mobile viewports. Overlays reflow; touch targets stay usable.
- Respect device pixel ratio limits and reduce resolution scale on weak devices rather
  than dropping frames.
- Honor `prefers-reduced-motion` for camera flights and cinematic transitions.

## Cleanup

- Every effect, listener, timer, interval, animation frame, subscription, and
  `WebSocket` must be torn down on unmount.
- Destroy Cesium resources explicitly: remove primitives and tilesets, then
  `destroy()` the viewer. Do not leak entity collections between route changes.
- Abort in-flight fetches on unmount or when a query is superseded.

## Visual verification

- Any change that renders must be looked at, not just built. Run the app, exercise the
  view, and confirm the actual result.
- Report what you verified: which view, which data mode, which viewport.
