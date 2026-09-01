#!/usr/bin/env node
/**
 * Generate a REAL, valid 3D Tiles tileset for tests.
 *
 * The build environment cannot reach PLATEAU, so the only way to prove the building
 * pipeline actually renders geometry — rather than merely that a tileset object was
 * pushed into an array — is to serve a genuine tileset of our own and check pixels.
 *
 * Emits a 3D Tiles 1.1 tileset whose content is a glTF binary containing a cluster of
 * tall boxes, transformed onto west Shinjuku.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../e2e/fixtures/tileset");

// West Shinjuku, roughly the 都庁 block.
const ORIGIN = { lon: 139.6917, lat: 35.6895, height: 0 };

const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const rad = (d) => (d * Math.PI) / 180;

/** Geodetic -> ECEF. */
function toEcef(lon, lat, h) {
  const sinLat = Math.sin(rad(lat));
  const cosLat = Math.cos(rad(lat));
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * Math.cos(rad(lon)),
    (N + h) * cosLat * Math.sin(rad(lon)),
    (N * (1 - WGS84_E2) + h) * sinLat,
  ];
}

/** East-North-Up basis at a point, as a column-major 4x4 for the 3D Tiles transform. */
function enuTransform(lon, lat, h) {
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

/** A grid of boxes of varying height, standing on the local ground plane. */
function buildGeometry() {
  const positions = [];
  const indices = [];
  const towers = [];
  for (let gx = -2; gx <= 2; gx++) {
    for (let gy = -2; gy <= 2; gy++) {
      // A plausible skyline: tallest near the centre.
      const d = Math.hypot(gx, gy);
      towers.push({ x: gx * 140, y: gy * 140, w: 46, h: Math.max(50, 250 - d * 55) });
    }
  }

  for (const t of towers) {
    const base = positions.length / 3;
    const hw = t.w / 2;
    // 8 corners: local X east, Y north, Z up.
    const corners = [
      [t.x - hw, t.y - hw, 0], [t.x + hw, t.y - hw, 0],
      [t.x + hw, t.y + hw, 0], [t.x - hw, t.y + hw, 0],
      [t.x - hw, t.y - hw, t.h], [t.x + hw, t.y - hw, t.h],
      [t.x + hw, t.y + hw, t.h], [t.x - hw, t.y + hw, t.h],
    ];
    for (const c of corners) positions.push(c[0], c[1], c[2]);
    const faces = [
      [0, 1, 2], [0, 2, 3], // bottom
      [4, 6, 5], [4, 7, 6], // top
      [0, 5, 1], [0, 4, 5],
      [1, 6, 2], [1, 5, 6],
      [2, 7, 3], [2, 6, 7],
      [3, 4, 0], [3, 7, 4],
    ];
    for (const f of faces) indices.push(base + f[0], base + f[1], base + f[2]);
  }
  return { positions, indices, towers };
}

const { positions, indices, towers } = buildGeometry();

const posArray = new Float32Array(positions);
const idxArray = new Uint32Array(indices);
const posBytes = posArray.byteLength;
const idxBytes = idxArray.byteLength;
const posOffset = 0;
const idxOffset = Math.ceil(posBytes / 4) * 4;
const binLength = idxOffset + idxBytes;

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < positions.length; i += 3) {
  minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
  minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
}

const gltf = {
  asset: { version: "2.0", generator: "japan-live test fixture" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  // 3D Tiles places content in a Z-up local frame; glTF is Y-up, so the standard
  // x-rotation puts the boxes upright.
  nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
  materials: [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [0.62, 0.70, 0.82, 1.0],
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
    { buffer: 0, byteOffset: posOffset, byteLength: posBytes, target: 34962 },
    { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
  ],
  buffers: [{ byteLength: binLength }],
};

const jsonText = JSON.stringify(gltf);
const jsonPadded = jsonText + " ".repeat((4 - (Buffer.byteLength(jsonText) % 4)) % 4);
const jsonBuf = Buffer.from(jsonPadded, "utf8");

const binBuf = Buffer.alloc(Math.ceil(binLength / 4) * 4);
Buffer.from(posArray.buffer).copy(binBuf, posOffset);
Buffer.from(idxArray.buffer).copy(binBuf, idxOffset);

const glb = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + binBuf.length);
let o = 0;
glb.write("glTF", o, "ascii"); o += 4;
glb.writeUInt32LE(2, o); o += 4;
glb.writeUInt32LE(glb.length, o); o += 4;
glb.writeUInt32LE(jsonBuf.length, o); o += 4;
glb.writeUInt32LE(0x4e4f534a, o); o += 4; // 'JSON'
jsonBuf.copy(glb, o); o += jsonBuf.length;
glb.writeUInt32LE(binBuf.length, o); o += 4;
glb.writeUInt32LE(0x004e4942, o); o += 4; // 'BIN'
binBuf.copy(glb, o);

const halfSpanDeg = 0.006;
const tileset = {
  asset: { version: "1.1" },
  geometricError: 500,
  root: {
    transform: enuTransform(ORIGIN.lon, ORIGIN.lat, ORIGIN.height),
    boundingVolume: {
      region: [
        rad(ORIGIN.lon - halfSpanDeg), rad(ORIGIN.lat - halfSpanDeg),
        rad(ORIGIN.lon + halfSpanDeg), rad(ORIGIN.lat + halfSpanDeg),
        -20, 300,
      ],
    },
    geometricError: 0,
    refine: "ADD",
    content: { uri: "buildings.glb" },
  },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "tileset.json"), JSON.stringify(tileset, null, 2));
writeFileSync(resolve(OUT, "buildings.glb"), glb);

console.log(`test tileset -> ${OUT}`);
console.log(`  towers   ${towers.length}`);
console.log(`  vertices ${positions.length / 3}`);
console.log(`  glb      ${glb.length} bytes`);
console.log(`  origin   ${ORIGIN.lat}, ${ORIGIN.lon} (西新宿)`);
