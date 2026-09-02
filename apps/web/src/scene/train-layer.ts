import * as Cesium from "cesium";
import type { MobilityEntity } from "@japan-live/shared";
import { LOD, dataModeColor, isRealtimePosition, trainLodFor } from "@japan-live/shared";
import { createSmoothedState, retarget, sample, type SmoothedState } from "@japan-live/transit";
import type { LonLat } from "@japan-live/core";

/**
 * Every moving train on screen.
 *
 * Deliberately built on primitive collections rather than one Cesium `Entity` per train
 * (D-008): V1 runs several hundred vehicles and V2 runs thousands, and the Entity API's
 * per-entity property evaluation does not survive that.
 *
 * The layer cannot tell a realtime train from a simulated one. It reads `dataMode` to
 * decide how to draw it, and that is the only difference.
 */

interface TrainRecord {
  entity: MobilityEntity;
  smoothed: SmoothedState;
  point: Cesium.PointPrimitive;
  billboard: Cesium.Billboard;
  lastSeen: number;
  /**
   * Colours parsed once per entity, not once per entity per frame.
   *
   * `Color.fromCssColorString` parses a string and allocates; at two calls per train
   * per frame that was ~700 parses per frame at V1's scale. Measured, it cost about
   * 0.5 ms of a 300 ms frame — irrelevant today, and the reason this is a V2
   * scalability change rather than a V1 fix: the cost is linear in entity count, and
   * V2 adds buses, flights and ferries to the same loop.
   */
  lineColor: Cesium.Color;
  lineColorDim: Cesium.Color;
  modeColor: Cesium.Color;
  /** Last image assigned, so an unchanged billboard skips the setter entirely. */
  iconKey?: string;
}

/** Reused every frame. Cesium's position setters clone, so one instance is enough. */
const SCRATCH_POSITION = new Cesium.Cartesian3();

function colorsFor(entity: MobilityEntity): Pick<TrainRecord, "lineColor" | "lineColorDim" | "modeColor"> {
  const line = Cesium.Color.fromCssColorString(entity.details?.lineColor ?? "#7fd1ff");
  return {
    lineColor: line.withAlpha(0.95),
    lineColorDim: line.withAlpha(0.78),
    modeColor: Cesium.Color.fromCssColorString(dataModeColor(entity.dataMode)).withAlpha(0.9),
  };
}

/**
 * A simple box car, reused from a fixed pool.
 *
 * Spec §18 asks for a low-poly generic vehicle up close, and §D-009 forbids licensed
 * rolling-stock models. A Primitive's modelMatrix can be moved every frame without
 * rebuilding its geometry, so a small pool costs one draw call each and nothing else.
 */
interface CarSlot {
  primitive: Cesium.Primitive;
  trainId?: string;
}

const MAX_3D_CARS = 18;
/** Metres. Beyond this a box is smaller than the billboard it would replace. */
const CAR_3D_RANGE = 1_400;

export interface TrainLayerOptions {
  xray: boolean;
  show: boolean;
  /** Entity id currently selected, drawn emphasized. */
  selectedId?: string;
  /** Entity id being followed. */
  followId?: string;
  night: boolean;
}

const ICON_CACHE = new Map<string, string>();

/** A small line-coloured chevron. Generic geometry only — no licensed rolling stock (D-009). */
function trainIcon(color: string, emphasized: boolean): string {
  const key = `${color}:${emphasized}`;
  const cached = ICON_CACHE.get(key);
  if (cached) return cached;

  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.translate(size / 2, size / 2);
  if (emphasized) {
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(7.5, 9);
  ctx.lineTo(0, 5);
  ctx.lineTo(-7.5, 9);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "rgba(6,10,18,0.9)";
  ctx.stroke();

  const url = canvas.toDataURL();
  ICON_CACHE.set(key, url);
  return url;
}

export class TrainLayer {
  private readonly viewer: Cesium.Viewer;
  private readonly points: Cesium.PointPrimitiveCollection;
  private readonly billboards: Cesium.BillboardCollection;
  private readonly records = new Map<string, TrainRecord>();
  private readonly cars: CarSlot[] = [];
  private lod: ReturnType<typeof trainLodFor> = "point";
  private xray = false;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
    );
    this.billboards = viewer.scene.primitives.add(
      new Cesium.BillboardCollection({ scene: viewer.scene }),
    );
    this.buildCarPool();
  }

  /** One reusable box car per pool slot, hidden until a train claims it. */
  private buildCarPool(): void {
    const geometry = Cesium.BoxGeometry.fromDimensions({
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      // A generic ~20 m car: long, narrow, and tall enough to read as a vehicle.
      dimensions: new Cesium.Cartesian3(20.0, 3.0, 3.6),
    });

    for (let i = 0; i < MAX_3D_CARS; i++) {
      const primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE),
          },
          id: { kind: "train-car", slot: i },
        }),
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
        asynchronous: false,
        modelMatrix: Cesium.Matrix4.IDENTITY.clone(),
        show: false,
      });
      this.viewer.scene.primitives.add(primitive);
      this.cars.push({ primitive });
    }
  }

  /**
   * A new set of entities arrived from the providers.
   *
   * Existing trains are re-targeted (so they ease toward the new position rather than
   * jumping), new ones are added, and ones that stopped being reported are removed —
   * a train that vanished from the feed is not left drifting on screen.
   */
  ingest(entities: MobilityEntity[], now: number, pollIntervalMs: number): void {
    for (const entity of entities) {
      if (entity.latitude === undefined || entity.longitude === undefined) continue;
      const target: LonLat = [entity.longitude, entity.latitude];
      const heading = entity.heading ?? 0;

      const existing = this.records.get(entity.id);
      if (existing) {
        // Re-parse only when the thing the colour is derived from actually changed.
        const recolour =
          existing.entity.details?.lineColor !== entity.details?.lineColor ||
          existing.entity.dataMode !== entity.dataMode;
        existing.entity = entity;
        if (recolour) Object.assign(existing, colorsFor(entity));
        existing.smoothed = retarget(existing.smoothed, target, heading, now);
        existing.lastSeen = now;
      } else {
        this.records.set(entity.id, {
          entity,
          smoothed: createSmoothedState(target, heading, now, pollIntervalMs),
          point: this.points.add({ position: Cesium.Cartesian3.ZERO, pixelSize: 5, show: false }),
          billboard: this.billboards.add({ position: Cesium.Cartesian3.ZERO, show: false }),
          lastSeen: now,
          ...colorsFor(entity),
        });
      }
    }

    for (const [id, record] of this.records) {
      if (record.lastSeen !== now) {
        this.points.remove(record.point);
        this.billboards.remove(record.billboard);
        this.records.delete(id);
      }
    }
  }

  /**
   * Draw. Called per frame, so it does no allocation beyond the Cartesian3 each train
   * needs, and touches only the collection that the current LOD level uses.
   */
  render(now: number, altitude: number, options: TrainLayerOptions): void {
    this.xray = options.xray;
    const lod = trainLodFor(altitude);
    this.lod = lod;

    const visible = options.show && lod !== "aggregate";
    this.points.show = visible && lod === "point";
    this.billboards.show = visible && (lod === "billboard" || lod === "model");

    if (!visible) {
      for (const slot of this.cars) {
        slot.primitive.show = false;
        slot.trainId = undefined;
      }
      return;
    }

    // Up close, the nearest trains become simple 3D cars.
    const cameraPos = this.viewer.camera.positionWC;
    const near: { record: TrainRecord; distance: number; cartesian: Cesium.Cartesian3 }[] = [];

    for (const record of this.records.values()) {
      const { position, heading } = sample(record.smoothed, now);
      const height = this.heightFor(record.entity);
      // Into the scratch: both collections clone on assignment, and only the 3D-car
      // shortlist below keeps a reference past this iteration.
      const cartesian = Cesium.Cartesian3.fromDegrees(
        position[0],
        position[1],
        height,
        undefined,
        SCRATCH_POSITION,
      );

      const emphasized =
        record.entity.id === options.selectedId || record.entity.id === options.followId;

      if (lod === "model") {
        const distance = Cesium.Cartesian3.distance(cameraPos, cartesian);
        if (distance < CAR_3D_RANGE) {
          near.push({ record, distance, cartesian: Cesium.Cartesian3.clone(cartesian) });
        }
      }

      if (lod === "point") {
        const p = record.point;
        p.position = cartesian;
        p.show = true;
        // Colour by line so the network's structure is visible at range; the data
        // mode is carried by the outline, and never by colour alone.
        const underground = record.entity.details?.underground ?? false;
        p.color = underground && !this.xray ? record.lineColorDim : record.lineColor;
        p.outlineColor = record.modeColor;
        p.outlineWidth = isRealtimePosition(record.entity.dataMode) ? 2 : 1;
        p.pixelSize = emphasized ? 11 : altitude > 120_000 ? 3.5 : 5.5;
        record.billboard.show = false;
      } else {
        const b = record.billboard;
        b.position = cartesian;
        b.show = true;
        // The icon is a data: URL kilobytes long. Cesium's setter compares it against
        // the current one, so re-assigning an unchanged icon costs a string compare
        // per train per frame for nothing. Track what we set instead.
        const iconKey = `${record.entity.details?.lineColor ?? "#7fd1ff"}:${emphasized}`;
        if (record.iconKey !== iconKey) {
          b.image = trainIcon(record.entity.details?.lineColor ?? "#7fd1ff", emphasized);
          record.iconKey = iconKey;
        }
        b.rotation = Cesium.Math.toRadians(-heading);
        b.alignedAxis = Cesium.Cartesian3.ZERO;
        b.scale = emphasized ? 1.15 : lod === "model" ? 0.95 : 0.7;
        b.disableDepthTestDistance = this.xray ? Number.POSITIVE_INFINITY : 0;
        record.point.show = false;
      }
    }

    this.updateCars(near, options);
    this.viewer.scene.requestRender();
  }

  /** Assign the pool to the closest trains and place each box on the track. */
  private updateCars(
    near: { record: TrainRecord; distance: number; cartesian: Cesium.Cartesian3 }[],
    options: TrainLayerOptions,
  ): void {
    near.sort((a, b) => a.distance - b.distance);
    const chosen = near.slice(0, MAX_3D_CARS);

    for (let i = 0; i < this.cars.length; i++) {
      const slot = this.cars[i]!;
      const target = chosen[i];
      if (!target) {
        slot.primitive.show = false;
        slot.trainId = undefined;
        continue;
      }

      // A Primitive throws if its attributes are read before it finishes building.
      if (!slot.primitive.ready) {
        slot.primitive.show = false;
        continue;
      }

      const { record, cartesian } = target;
      const heading = record.entity.heading ?? 0;

      // East-north-up frame at the train, rotated so +X runs along the track.
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cartesian);
      const spin = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(90 - heading));
      Cesium.Matrix4.multiply(
        enu,
        Cesium.Matrix4.fromRotationTranslation(spin, Cesium.Cartesian3.ZERO),
        slot.primitive.modelMatrix,
      );

      const emphasized =
        record.entity.id === options.selectedId || record.entity.id === options.followId;
      const color = record.lineColor;
      try {
        const attributes = slot.primitive.getGeometryInstanceAttributes({
          kind: "train-car",
          slot: i,
        });
        if (attributes) {
          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            emphasized ? Cesium.Color.WHITE : color.brighten(0.25, new Cesium.Color()),
            attributes.color as Uint8Array,
          );
        }
      } catch {
        // Colouring a car is cosmetic; never let it take the frame down.
      }

      slot.primitive.show = true;
      slot.trainId = record.entity.id;
      // The billboard would otherwise sit on top of its own 3D car.
      record.billboard.show = false;
    }
  }

  /**
   * Rendering altitude.
   *
   * Underground trains sit below the surface, and X-Ray lifts them above it so they are
   * visible from above. That raised height is a projection and the UI says so (D-010) —
   * it is not a claim about where the train actually is.
   */
  private heightFor(entity: MobilityEntity): number {
    const underground = entity.details?.underground ?? false;
    if (!underground) return 22;
    // Below the surface the globe occludes them entirely, and every V1 line is
    // underground — so normally they sit at the surface, drawn dimmer, and X-Ray
    // raises them clear of it.
    return this.xray ? LOD.xrayProjectionAltitude : 18;
  }

  /** The entity under a screen position, for click-to-select. */
  pick(windowPosition: Cesium.Cartesian2): MobilityEntity | undefined {
    const picked = this.viewer.scene.pick(windowPosition);
    if (!picked) return undefined;
    const primitive = picked.primitive as unknown;
    for (const record of this.records.values()) {
      if (primitive === record.point || primitive === record.billboard) return record.entity;
      if (picked.id && typeof picked.id === "object" && "entityId" in picked.id) {
        const id = (picked.id as { entityId: string }).entityId;
        if (id === record.entity.id) return record.entity;
      }
    }
    return undefined;
  }

  /** Current drawn position of an entity — what Follow tracks. */
  positionOf(id: string, now: number): { position: LonLat; heading: number; height: number } | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const s = sample(record.smoothed, now);
    return { ...s, height: this.heightFor(record.entity) };
  }

  get(id: string): MobilityEntity | undefined {
    return this.records.get(id)?.entity;
  }

  get count(): number {
    return this.records.size;
  }

  get currentLod(): string {
    return this.lod;
  }

  destroy(): void {
    for (const slot of this.cars) {
      this.viewer.scene.primitives.remove(slot.primitive);
    }
    this.cars.length = 0;
    this.records.clear();
    this.viewer.scene.primitives.remove(this.points);
    this.viewer.scene.primitives.remove(this.billboards);
  }
}
