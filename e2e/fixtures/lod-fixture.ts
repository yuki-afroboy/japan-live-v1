/**
 * A multi-level 3D Tiles hierarchy, built in memory at test time.
 *
 * The committed fixture (`fixtures/tileset`) is one ADD tile with no children. It
 * proves buildings render; it cannot answer either V1.2 question, because both depend
 * on a REPLACE hierarchy deep enough to have ancestors and descendants selected at the
 * same time, and on tiles heavy enough that parsing one costs something.
 *
 * Built rather than committed because a realistic leaf is megabytes. Twenty of those in
 * git, to be regenerated whenever the shape changes, is not worth it — and generating
 * them here means the density is a test parameter rather than a checked-in constant.
 */

// West Shinjuku, the same block the committed fixture uses, so one camera preset
// reaches both.
export const ORIGIN = { lon: 139.6917, lat: 35.6895, height: 0 };
const HALF_SPAN_DEG = 0.006;

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const rad = (d: number): number => (d * Math.PI) / 180;

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos(rad(ORIGIN.lat));
const HALF_X = HALF_SPAN_DEG * M_PER_DEG_LON;
const HALF_Y = HALF_SPAN_DEG * M_PER_DEG_LAT;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface LodFixture {
  tileset: unknown;
  /** File name -> GLB bytes. */
  content: Map<string, Buffer>;
  /** Total content size, so a test can say what it actually served. */
  totalBytes: number;
}

export interface LodFixtureOptions {
  /**
   * Tower spacing in metres at each level, coarse to fine. Smaller means more
   * geometry per tile: the lever that turns a 4 KB toy tile into something whose
   * parse and GPU upload cost is comparable to a real PLATEAU tile.
   */
  spacing?: [number, number, number];
}

function toEcef(lon: number, lat: number, h: number): [number, number, number] {
  const sinLat = Math.sin(rad(lat));
  const cosLat = Math.cos(rad(lat));
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * Math.cos(rad(lon)),
    (N + h) * cosLat * Math.sin(rad(lon)),
    (N * (1 - WGS84_E2) + h) * sinLat,
  ];
}

function enuTransform(lon: number, lat: number, h: number): number[] {
  const [x, y, z] = toEcef(lon, lat, h);
  const sinLon = Math.sin(rad(lon));
  const cosLon = Math.cos(rad(lon));
  const sinLat = Math.sin(rad(lat));
  const cosLat = Math.cos(rad(lat));
  return [
    -sinLon, cosLon, 0, 0,
    -sinLat * cosLon, -sinLat * sinLon, cosLat, 0,
    cosLat * cosLon, cosLat * sinLon, sinLat, 0,
    x, y, z, 1,
  ];
}

/** Boxes filling one rectangle of the local ENU plane. Every level covers the same
 *  ground; only the spacing changes, so a missing level reads as a hole. */
function buildGeometry(bounds: Bounds, spacing: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const width = spacing * 0.42;

  for (let x = bounds.minX + spacing / 2; x < bounds.maxX; x += spacing) {
    for (let y = bounds.minY + spacing / 2; y < bounds.maxY; y += spacing) {
      const d = Math.hypot(x, y) / 400;
      const h = Math.max(45, 240 - d * 90);
      const hw = width / 2;
      const base = positions.length / 3;
      const corners: [number, number, number][] = [
        [x - hw, y - hw, 0], [x + hw, y - hw, 0],
        [x + hw, y + hw, 0], [x - hw, y + hw, 0],
        [x - hw, y - hw, h], [x + hw, y - hw, h],
        [x + hw, y + hw, h], [x - hw, y + hw, h],
      ];
      for (const c of corners) positions.push(c[0], c[1], c[2]);
      const faces = [
        [0, 1, 2], [0, 2, 3],
        [4, 6, 5], [4, 7, 6],
        [0, 5, 1], [0, 4, 5],
        [1, 6, 2], [1, 5, 6],
        [2, 7, 3], [2, 6, 7],
        [3, 4, 0], [3, 7, 4],
      ];
      for (const f of faces) indices.push(base + f[0]!, base + f[1]!, base + f[2]!);
    }
  }
  return { positions, indices };
}

function encodeGlb(
  geometry: { positions: number[]; indices: number[] },
  color: [number, number, number],
): Buffer {
  const { positions, indices } = geometry;
  const posArray = new Float32Array(positions);
  const idxArray = new Uint32Array(indices);
  const posBytes = posArray.byteLength;
  const idxBytes = idxArray.byteLength;
  const idxOffset = Math.ceil(posBytes / 4) * 4;
  const binLength = idxOffset + idxBytes;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }

  const gltf = {
    asset: { version: "2.0", generator: "japan-live lod fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // 3D Tiles content is Z-up; glTF is Y-up, so this rotation stands the boxes upright.
    nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [...color, 1.0],
          metallicFactor: 0.05,
          roughnessFactor: 0.85,
        },
        doubleSided: true,
      },
    ],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3",
        min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
      },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
    ],
    buffers: [{ byteLength: binLength }],
  };

  const jsonText = JSON.stringify(gltf);
  const jsonPadded = jsonText + " ".repeat((4 - (Buffer.byteLength(jsonText) % 4)) % 4);
  const jsonBuf = Buffer.from(jsonPadded, "utf8");
  const binBuf = Buffer.alloc(Math.ceil(binLength / 4) * 4);
  Buffer.from(posArray.buffer).copy(binBuf, 0);
  Buffer.from(idxArray.buffer).copy(binBuf, idxOffset);

  const glb = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + binBuf.length);
  let o = 0;
  glb.write("glTF", o, "ascii"); o += 4;
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(glb.length, o); o += 4;
  glb.writeUInt32LE(jsonBuf.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonBuf.copy(glb, o); o += jsonBuf.length;
  glb.writeUInt32LE(binBuf.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4;
  binBuf.copy(glb, o);
  return glb;
}

function region(x0: number, x1: number, y0: number, y1: number): number[] {
  const span = HALF_SPAN_DEG * 2;
  return [
    rad(ORIGIN.lon - HALF_SPAN_DEG + span * x0),
    rad(ORIGIN.lat - HALF_SPAN_DEG + span * y0),
    rad(ORIGIN.lon - HALF_SPAN_DEG + span * x1),
    rad(ORIGIN.lat - HALF_SPAN_DEG + span * y1),
    -20,
    300,
  ];
}

function boundsFor(x0: number, x1: number, y0: number, y1: number): Bounds {
  return {
    minX: -HALF_X + 2 * HALF_X * x0,
    maxX: -HALF_X + 2 * HALF_X * x1,
    minY: -HALF_Y + 2 * HALF_Y * y0,
    maxY: -HALF_Y + 2 * HALF_Y * y1,
  };
}

/** 1 + 4 + 16 tiles, REPLACE refinement, three levels of detail over one block. */
export function buildLodFixture(options: LodFixtureOptions = {}): LodFixture {
  const [s0, s1, s2] = options.spacing ?? [300, 150, 75];
  const content = new Map<string, Buffer>();

  const emit = (name: string, bounds: Bounds, spacing: number, color: [number, number, number]) => {
    content.set(name, encodeGlb(buildGeometry(bounds, spacing), color));
  };

  emit("l0.glb", boundsFor(0, 1, 0, 1), s0!, [0.42, 0.48, 0.6]);

  const level1: unknown[] = [];
  let q = 0;
  for (const [x0, x1] of [[0, 0.5], [0.5, 1]] as const) {
    for (const [y0, y1] of [[0, 0.5], [0.5, 1]] as const) {
      const name = `l1-${q}.glb`;
      emit(name, boundsFor(x0, x1, y0, y1), s1!, [0.52, 0.58, 0.7]);

      const children: unknown[] = [];
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      let g = 0;
      for (const [cx0, cx1] of [[x0, mx], [mx, x1]] as const) {
        for (const [cy0, cy1] of [[y0, my], [my, y1]] as const) {
          const leaf = `l2-${q}-${g}.glb`;
          emit(leaf, boundsFor(cx0, cx1, cy0, cy1), s2!, [0.62, 0.7, 0.82]);
          children.push({
            boundingVolume: { region: region(cx0, cx1, cy0, cy1) },
            geometricError: 0,
            refine: "REPLACE",
            content: { uri: leaf },
          });
          g++;
        }
      }

      level1.push({
        boundingVolume: { region: region(x0, x1, y0, y1) },
        geometricError: 30,
        refine: "REPLACE",
        content: { uri: name },
        children,
      });
      q++;
    }
  }

  const tileset = {
    asset: { version: "1.1" },
    geometricError: 500,
    root: {
      transform: enuTransform(ORIGIN.lon, ORIGIN.lat, ORIGIN.height),
      boundingVolume: { region: region(0, 1, 0, 1) },
      geometricError: 120,
      refine: "REPLACE",
      content: { uri: "l0.glb" },
      children: level1,
    },
  };

  let totalBytes = 0;
  for (const buf of content.values()) totalBytes += buf.length;
  return { tileset, content, totalBytes };
}
