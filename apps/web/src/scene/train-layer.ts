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
  model?: Cesium.Primitive;
  lastSeen: number;
}

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
        existing.entity = entity;
        existing.smoothed = retarget(existing.smoothed, target, heading, now);
        existing.lastSeen = now;
      } else {
        this.records.set(entity.id, {
          entity,
          smoothed: createSmoothedState(target, heading, now, pollIntervalMs),
          point: this.points.add({ position: Cesium.Cartesian3.ZERO, pixelSize: 5, show: false }),
          billboard: this.billboards.add({ position: Cesium.Cartesian3.ZERO, show: false }),
          lastSeen: now,
        });
      }
    }

    for (const [id, record] of this.records) {
      if (record.lastSeen !== now) {
        this.points.remove(record.point);
        this.billboards.remove(record.billboard);
        if (record.model) {
          this.viewer.scene.primitives.remove(record.model);
        }
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

    if (!visible) return;

    for (const record of this.records.values()) {
      const { position, heading } = sample(record.smoothed, now);
      const height = this.heightFor(record.entity);
      const cartesian = Cesium.Cartesian3.fromDegrees(position[0], position[1], height);

      const emphasized =
        record.entity.id === options.selectedId || record.entity.id === options.followId;
      const lineColor = record.entity.details?.lineColor ?? "#7fd1ff";

      if (lod === "point") {
        const p = record.point;
        p.position = cartesian;
        p.show = true;
        // Colour by line so the network's structure is visible at range; the data
        // mode is carried by the outline, and never by colour alone.
        const underground = record.entity.details?.underground ?? false;
        p.color = Cesium.Color.fromCssColorString(lineColor).withAlpha(
          underground && !this.xray ? 0.78 : 0.95,
        );
        p.outlineColor = Cesium.Color.fromCssColorString(
          dataModeColor(record.entity.dataMode),
        ).withAlpha(0.9);
        p.outlineWidth = isRealtimePosition(record.entity.dataMode) ? 2 : 1;
        p.pixelSize = emphasized ? 11 : altitude > 120_000 ? 3.5 : 5.5;
        record.billboard.show = false;
      } else {
        const b = record.billboard;
        b.position = cartesian;
        b.show = true;
        b.image = trainIcon(lineColor, emphasized);
        b.rotation = Cesium.Math.toRadians(-heading);
        b.alignedAxis = Cesium.Cartesian3.ZERO;
        b.scale = emphasized ? 1.15 : lod === "model" ? 0.95 : 0.7;
        b.disableDepthTestDistance = this.xray ? Number.POSITIVE_INFINITY : 0;
        record.point.show = false;
      }
    }
    this.viewer.scene.requestRender();
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
    for (const record of this.records.values()) {
      if (record.model) this.viewer.scene.primitives.remove(record.model);
    }
    this.records.clear();
    this.viewer.scene.primitives.remove(this.points);
    this.viewer.scene.primitives.remove(this.billboards);
  }
}
