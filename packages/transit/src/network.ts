import { ShapeIndex } from "@japan-live/core";
import type { Railway, Station, StaticTransitData, Trip } from "@japan-live/shared";

/**
 * Indexed view of a static dataset: shapes prepared once, lookups by id.
 * Built when a dataset loads, then read-only.
 */
export class TransitNetwork {
  readonly data: StaticTransitData;
  private readonly railwayById = new Map<string, Railway>();
  private readonly stationById = new Map<string, Station>();
  private readonly tripById = new Map<string, Trip>();
  private readonly shapeByRailway = new Map<string, ShapeIndex>();
  private readonly tripsByRailway = new Map<string, Trip[]>();
  /** railwayId -> stationId -> distance along the shape, in metres. */
  private readonly stationOffsets = new Map<string, Map<string, number>>();

  constructor(data: StaticTransitData) {
    this.data = data;

    for (const s of data.stations) this.stationById.set(s.id, s);

    for (const r of data.railways) {
      this.railwayById.set(r.id, r);
      if (r.shape.length > 0) {
        this.shapeByRailway.set(r.id, new ShapeIndex(r.shape.map((p) => [p[0], p[1]])));
      }
      const offsets = new Map<string, number>();
      for (let i = 0; i < r.stationIds.length; i++) {
        const id = r.stationIds[i];
        const off = r.stationOffsetsM[i];
        if (id !== undefined && off !== undefined && Number.isFinite(off)) {
          offsets.set(id, off);
        }
      }
      this.stationOffsets.set(r.id, offsets);
    }

    for (const t of data.trips) {
      this.tripById.set(t.id, t);
      let list = this.tripsByRailway.get(t.railwayId);
      if (!list) {
        list = [];
        this.tripsByRailway.set(t.railwayId, list);
      }
      list.push(t);
    }
  }

  get railways(): Railway[] {
    return this.data.railways;
  }
  get stations(): Station[] {
    return this.data.stations;
  }
  get trips(): Trip[] {
    return this.data.trips;
  }

  railway(id: string): Railway | undefined {
    return this.railwayById.get(id);
  }
  station(id: string): Station | undefined {
    return this.stationById.get(id);
  }
  trip(id: string): Trip | undefined {
    return this.tripById.get(id);
  }
  shape(railwayId: string): ShapeIndex | undefined {
    return this.shapeByRailway.get(railwayId);
  }
  tripsOn(railwayId: string): Trip[] {
    return this.tripsByRailway.get(railwayId) ?? [];
  }

  /**
   * Distance along a railway's shape at which a station sits.
   * Returns undefined when the station is not on that line — the caller then produces
   * UNAVAILABLE rather than a guessed position.
   */
  stationOffset(railwayId: string, stationId: string): number | undefined {
    return this.stationOffsets.get(railwayId)?.get(stationId);
  }

  /** Case-insensitive prefix/substring search over station and railway names. */
  search(query: string, limit = 12): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchResult[] = [];

    const score = (name: string): number => {
      const n = name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (n.includes(q)) return 2;
      return -1;
    };

    for (const s of this.stations) {
      const best = Math.min(
        ...[s.name, s.nameEn ?? ""].map((n) => {
          const v = score(n);
          return v < 0 ? Number.POSITIVE_INFINITY : v;
        }),
      );
      if (Number.isFinite(best)) {
        out.push({ kind: "station", id: s.id, name: s.name, subtitle: s.nameEn, score: best });
      }
    }
    for (const r of this.railways) {
      const best = Math.min(
        ...[r.name, r.nameEn ?? ""].map((n) => {
          const v = score(n);
          return v < 0 ? Number.POSITIVE_INFINITY : v;
        }),
      );
      if (Number.isFinite(best)) {
        out.push({ kind: "railway", id: r.id, name: r.name, subtitle: r.operatorName, score: best });
      }
    }

    out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }
}

export interface SearchResult {
  kind: "station" | "railway";
  id: string;
  name: string;
  subtitle?: string;
  score: number;
}

/** Merge datasets from several providers into one network. Ids must already be namespaced. */
export function mergeStaticData(parts: StaticTransitData[]): StaticTransitData | null {
  const present = parts.filter((p) => p.railways.length > 0 || p.stations.length > 0);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0]!;

  const stationById = new Map<string, (typeof present)[number]["stations"][number]>();
  for (const p of present) for (const s of p.stations) stationById.set(s.id, s);

  return {
    meta: {
      id: present.map((p) => p.meta.id).join("+"),
      name: present.map((p) => p.meta.name).join(" + "),
      builtAt: Math.max(...present.map((p) => p.meta.builtAt)),
      approximate: present.some((p) => p.meta.approximate),
      attribution: [...new Set(present.map((p) => p.meta.attribution))].join(" / "),
    },
    railways: present.flatMap((p) => p.railways),
    stations: [...stationById.values()],
    trips: present.flatMap((p) => p.trips),
  };
}
