/**
 * Every altitude threshold in the product, in one place, in metres of camera height.
 * Starting values chosen from the spec; tuned against measurement in Phase 6 and
 * recorded in docs/DECISIONS.md when they change.
 */
export const LOD = {
  /** Above this, individual trains are not drawn at all — only aggregate glow. */
  trainsAggregateAbove: 300_000,
  /** Between aggregate and this, trains are single points. */
  trainsPointsAbove: 40_000,
  /** Between points and this, trains are billboards. */
  trainsBillboardAbove: 2_500,
  /** Below `trainsBillboardAbove`, trains are simple 3D geometry. */

  /** Buildings are not requested at all above this. */
  buildingsMaxAltitude: 12_000,
  /** Below this the tileset is asked for its finest LOD. */
  buildingsDetailAltitude: 2_000,

  /** Routes: trunk lines only above this. */
  routesTrunkOnlyAbove: 120_000,
  /** No routes at all above this. */
  routesHiddenAbove: 900_000,

  /** Stations hidden above this. */
  stationsHiddenAbove: 60_000,
  /** Only major stations between this and `stationsHiddenAbove`. */
  stationsMajorOnlyAbove: 15_000,

  /** X-Ray lifts underground trains to this height above the surface. */
  xrayProjectionAltitude: 90,
  /** Underground trains sit at this depth when X-Ray is off. */
  undergroundDepth: -25,
} as const;

export type TrainLodLevel = "aggregate" | "point" | "billboard" | "model";

export function trainLodFor(altitude: number): TrainLodLevel {
  if (altitude > LOD.trainsAggregateAbove) return "aggregate";
  if (altitude > LOD.trainsPointsAbove) return "point";
  if (altitude > LOD.trainsBillboardAbove) return "billboard";
  return "model";
}
