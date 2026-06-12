// Chunk mesher: naive per-face culling into one indexed BufferGeometry.
// Positions are chunk-local; the mesh is placed at (cx*16, 0, cz*16).
import * as THREE from '../lib/three.module.js';
import { CHUNK, HEIGHT, BLOCK, chunkIndex, chunkKey } from './constants.js';
import { FACE_TILES } from './textures.js';

// Face order: +x, -x, +y, -y, +z, -z.
// Corners are listed bottom-left, bottom-right, top-right, top-left as seen
// from outside the face, so indices (0,1,2)(0,2,3) wind CCW (outward) and
// UVs (u0,v0)(u1,v0)(u1,v1)(u0,v1) keep side-face textures upright
// (tile top row -> face top, which keeps the grass strip up).
const FACES = [
  { dir: [1, 0, 0],  shade: 0.72, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { dir: [-1, 0, 0], shade: 0.72, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { dir: [0, 1, 0],  shade: 1.0,  corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.5,  corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1],  shade: 0.85, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], shade: 0.85, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

export function buildChunkGeometry(world, cx, cz, tileUV) {
  const data = world.chunks.get(chunkKey(cx, cz));
  if (!data) return null;

  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const baseX = cx * CHUNK;
  const baseZ = cz * CHUNK;
  const uvCache = new Map(); // tile index -> [u0,v0,u1,v1]

  for (let y = 0; y < HEIGHT; y++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const id = data[chunkIndex(lx, y, lz)];
        if (id === BLOCK.AIR) continue;
        const tiles = FACE_TILES[id];
        if (!tiles) continue;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const d = face.dir;
          const nx = lx + d[0];
          const ny = y + d[1];
          const nz = lz + d[2];

          let nid;
          if (ny < 0) {
            nid = BLOCK.STONE; // below world is solid
          } else if (ny >= HEIGHT) {
            nid = BLOCK.AIR;   // above world is air
          } else if (nx >= 0 && nx < CHUNK && nz >= 0 && nz < CHUNK) {
            nid = data[chunkIndex(nx, ny, nz)];
          } else {
            // cross chunk-border lookup
            nid = world.getBlock(baseX + nx, ny, baseZ + nz);
          }
          if (nid !== BLOCK.AIR) continue;

          const tile = tiles[f];
          let uv = uvCache.get(tile);
          if (!uv) {
            uv = tileUV(tile);
            uvCache.set(tile, uv);
          }
          const [u0, v0, u1, v1] = uv;

          const vbase = positions.length / 3;
          const cor = face.corners;
          const s = face.shade;
          for (let i = 0; i < 4; i++) {
            positions.push(lx + cor[i][0], y + cor[i][1], lz + cor[i][2]);
            normals.push(d[0], d[1], d[2]);
            colors.push(s, s, s);
          }
          uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
          indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
        }
      }
    }
  }

  if (indices.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices); // three picks Uint16/Uint32 storage automatically
  geo.computeBoundingSphere();
  return geo;
}
