import * as Cesium from "cesium";
import { LOD } from "@japan-live/shared";
import { simplifyPolyline } from "@japan-live/core";
import type { TransitNetwork } from "@japan-live/transit";

/**
 * Route lines and stations.
 *
 * Both are static geometry, so they are built once as primitives and thereafter only
 * shown or hidden. Nothing here is rebuilt per frame.
 */

export interface RailLayerOptions {
  /** Underground lines are drawn below the surface unless X-Ray lifts them. */
  xray: boolean;
  showRoutes: boolean;
  showStations: boolean;
}

interface RailwayLine {
  id: string;
  name: string;
  underground: boolean;
  major: boolean;
  /** One polyline per detail level, so zooming out does not draw 3000 vertices. */
  surface: Cesium.Primitive;
  color: Cesium.Color;
}

export class RailLayer {
  private readonly viewer: Cesium.Viewer;
  private readonly network: TransitNetwork;
  private readonly routeCollection: Cesium.PolylineCollection;
  private readonly stationPoints: Cesium.PointPrimitiveCollection;
  private readonly stationLabels: Cesium.LabelCollection;
  private readonly polylineByRailway = new Map<string, Cesium.Polyline>();
  private readonly stationEntries: {
    primitive: Cesium.PointPrimitive;
    label: Cesium.Label;
    major: boolean;
  }[] = [];
  private xray = false;

  constructor(viewer: Cesium.Viewer, network: TransitNetwork) {
    this.viewer = viewer;
    this.network = network;

    this.routeCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.stationPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.stationLabels = viewer.scene.primitives.add(
      new Cesium.LabelCollection({ scene: viewer.scene }),
    );

    this.buildRoutes();
    this.buildStations();
  }

  private buildRoutes(): void {
    for (const railway of this.network.railways) {
      const shape = this.network.shape(railway.id);
      if (!shape) continue;

      // 3277 vertices across 13 lines is more than any zoom needs; 12 m of tolerance
      // keeps every curve while dropping roughly half the points.
      const simplified = simplifyPolyline(
        railway.shape.map((p) => [p[0], p[1]] as [number, number]),
        12,
      );

      const color = Cesium.Color.fromCssColorString(railway.color);
      const polyline = this.routeCollection.add({
        positions: this.positionsFor(simplified, railway.underground),
        width: 2.4,
        material: Cesium.Material.fromType("PolylineOutline", {
          color: color.withAlpha(this.alphaFor(railway.underground)),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
          outlineWidth: 1.0,
        }),
        id: { kind: "railway", railwayId: railway.id },
      });
      this.polylineByRailway.set(railway.id, polyline);
    }
  }

  /**
   * Underground track sits below the surface so it reads as underground; X-Ray raises
   * it above so it can be seen at all. Both are stated in the UI (D-010) — the raised
   * altitude is a projection, not the real depth.
   */
  private positionsFor(points: [number, number][], underground: boolean): Cesium.Cartesian3[] {
    const height = underground ? (this.xray ? LOD.xrayProjectionAltitude : 10) : 6;
    return points.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height));
  }

  /** Underground lines read faintly at the surface, and brightly once X-Ray lifts them. */
  private alphaFor(underground: boolean): number {
    if (!underground) return 0.92;
    return this.xray ? 0.95 : 0.42;
  }

  private buildStations(): void {
    for (const station of this.network.stations) {
      const railway = station.railwayIds[0]
        ? this.network.railway(station.railwayIds[0])
        : undefined;
      const color = railway
        ? Cesium.Color.fromCssColorString(railway.color)
        : Cesium.Color.fromCssColorString("#8fa3bf");

      const position = Cesium.Cartesian3.fromDegrees(station.longitude, station.latitude, 12);

      const primitive = this.stationPoints.add({
        position,
        pixelSize: station.major ? 7 : 4.5,
        color: Cesium.Color.WHITE.withAlpha(0.95),
        outlineColor: color,
        outlineWidth: station.major ? 2.5 : 1.5,
        // Cesium fades and hides the point itself past these distances, so
        // out-of-range stations cost nothing to keep in the collection.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          station.major ? LOD.stationsHiddenAbove : LOD.stationsMajorOnlyAbove,
        ),
        translucencyByDistance: new Cesium.NearFarScalar(2_000, 1.0, 40_000, 0.35),
        id: { kind: "station", stationId: station.id },
      });

      const label = this.stationLabels.add({
        position,
        text: station.name,
        font: "500 12px 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#e8eef7"),
        outlineColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.85),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        // Labels are noise at range: majors appear earlier, minors only close in.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          station.major ? 26_000 : 6_500,
        ),
        scaleByDistance: new Cesium.NearFarScalar(1_500, 1.0, 20_000, 0.72),
        // Cesium's own declutter: overlapping labels are dropped rather than stacked.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });

      this.stationEntries.push({ primitive, label, major: station.major });
    }
  }

  setXray(xray: boolean): void {
    if (this.xray === xray) return;
    this.xray = xray;

    for (const railway of this.network.railways) {
      if (!railway.underground) continue;
      const polyline = this.polylineByRailway.get(railway.id);
      if (!polyline) continue;
      const simplified = simplifyPolyline(
        railway.shape.map((p) => [p[0], p[1]] as [number, number]),
        12,
      );
      polyline.positions = this.positionsFor(simplified, true);
      polyline.material = Cesium.Material.fromType("PolylineOutline", {
        color: Cesium.Color.fromCssColorString(railway.color).withAlpha(this.alphaFor(true)),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
        outlineWidth: 1.0,
      });
    }

    // In X-Ray the globe goes translucent so the network reads as a system beneath
    // the city rather than a set of lines painted on the ground.
    const globe = this.viewer.scene.globe;
    globe.translucency.enabled = xray;
    globe.translucency.frontFaceAlpha = xray ? 0.55 : 1.0;
    this.viewer.scene.requestRender();
  }

  update(options: RailLayerOptions, altitude: number): void {
    this.setXray(options.xray);

    const routesVisible = options.showRoutes && altitude < LOD.routesHiddenAbove;
    const trunkOnly = altitude > LOD.routesTrunkOnlyAbove;

    for (const railway of this.network.railways) {
      const polyline = this.polylineByRailway.get(railway.id);
      if (!polyline) continue;
      // Above the trunk threshold only the busiest lines are drawn, so a nationwide
      // view shows structure rather than a solid smear.
      const show = routesVisible && (!trunkOnly || railway.stationIds.length >= 20);
      if (polyline.show !== show) polyline.show = show;
      // Lines thicken as you approach so they read at street level too.
      const width = altitude < 4_000 ? 4.2 : altitude < 30_000 ? 3.0 : 2.0;
      if (polyline.width !== width) polyline.width = width;
    }

    const stationsVisible = options.showStations && altitude < LOD.stationsHiddenAbove;
    if (this.stationPoints.show !== stationsVisible) {
      this.stationPoints.show = stationsVisible;
      this.stationLabels.show = stationsVisible;
    }
  }

  destroy(): void {
    this.viewer.scene.primitives.remove(this.routeCollection);
    this.viewer.scene.primitives.remove(this.stationPoints);
    this.viewer.scene.primitives.remove(this.stationLabels);
    this.polylineByRailway.clear();
    this.stationEntries.length = 0;
  }
}
