// Shared PURE-VOXEL mesher: box regions → ONE culled, vertex-coloured BufferGeometry. Used by the
// in-game renderer AND the standalone model-viewer (model-viewer.html) so both show the SAME mesh.

import * as THREE from '../lib/three.module.js';

export const VOX = 0.06; // world units per avatar voxel (≈ 1.8 tall for a 30-voxel model)

// 6 cube faces: outward normal + 4 corner offsets (CCW from outside → front-facing). tris (0,1,2)+(0,2,3).
const VOX_FACES = [
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], v: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

// rasterize box regions → a voxel grid, then emit ONE BufferGeometry with only faces exposed to air.
// centred on x/z, feet at y=0, positions baked in world units (×VOX).
export function buildVoxelGeometry(boxes) {
  const vox = new Map();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) {
      vox.set(x + ',' + y + ',' + z, b.color);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const cx = (minX + maxX + 1) / 2, cz = (minZ + maxZ + 1) / 2;
  const has = (x, y, z) => vox.has(x + ',' + y + ',' + z);
  const P = [], N = [], C = [], col = new THREE.Color();
  const order = [0, 1, 2, 0, 2, 3];
  for (const [key, color] of vox) {
    const p = key.split(','), x = +p[0], y = +p[1], z = +p[2];
    col.set(color);
    for (let f = 0; f < 6; f++) {
      const n = VOX_FACES[f].n;
      if (has(x + n[0], y + n[1], z + n[2])) continue;
      const v = VOX_FACES[f].v;
      for (let i = 0; i < 6; i++) {
        const o = v[order[i]];
        P.push((x + o[0] - cx) * VOX, (y + o[1]) * VOX, (z + o[2] - cz) * VOX);
        N.push(n[0], n[1], n[2]);
        C.push(col.r, col.g, col.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}
