// Deterministic terrain generation. Same seed -> identical chunks anywhere,
// including trees straddling chunk borders (2-block margin scan per DESIGN).

import { CHUNK, HEIGHT, BLOCK, chunkIndex } from './constants.js';
import { makeNoise2D, hash2 } from './noise.js';

const TREE_CHANCE = 0.01;
const BEACH_MAX = 21; // h <= 21 -> sand top (no grass, no trees)
const MARGIN = 2;     // canopy radius: trees up to 2 blocks outside still reach in
const SCAN = CHUNK + MARGIN * 2;

export function makeGenerator(seed) {
  const n1 = makeNoise2D(seed);
  const n2 = makeNoise2D(seed + 1337);

  function heightAt(x, z) {
    let h = Math.round(26 + n1(x * 0.012, z * 0.012) * 10 + n2(x * 0.05, z * 0.05) * 4);
    if (h < 4) h = 4;
    else if (h > 50) h = 50;
    return h;
  }

  function generateChunk(cx, cz) {
    const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;

    // Height map for the chunk plus a 2-block margin (shared by fill & trees).
    const hs = new Int32Array(SCAN * SCAN);
    for (let i = 0; i < SCAN; i++) {
      for (let j = 0; j < SCAN; j++) {
        hs[i * SCAN + j] = heightAt(x0 + i - MARGIN, z0 + j - MARGIN);
      }
    }

    // Column fill: stone core, dirt+grass cap, or 4 sand layers on beaches.
    for (let lx = 0; lx < CHUNK; lx++) {
      for (let lz = 0; lz < CHUNK; lz++) {
        const h = hs[(lx + MARGIN) * SCAN + (lz + MARGIN)];
        const beach = h <= BEACH_MAX;
        for (let y = 0; y <= h; y++) {
          let id;
          if (beach && y >= h - 3) id = BLOCK.SAND;
          else if (y < h - 3) id = BLOCK.STONE;
          else if (y < h) id = BLOCK.DIRT;
          else id = BLOCK.GRASS;
          data[chunkIndex(lx, y, lz)] = id;
        }
      }
    }

    // Writes a tree block if it falls inside this chunk. Leaves only fill AIR
    // (so they never overwrite LOG or terrain); trunks always win. The result
    // per block is order-independent, hence identical from any chunk's scan.
    function put(wx, y, wz, id, onlyAir) {
      if (y < 0 || y >= HEIGHT) return;
      const lx = wx - x0;
      const lz = wz - z0;
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) return;
      const idx = chunkIndex(lx, y, lz);
      if (onlyAir && data[idx] !== BLOCK.AIR) return;
      data[idx] = id;
    }

    // Trees: scan columns x0-2 .. x0+17 (same for z) in fixed coordinate order.
    for (let i = 0; i < SCAN; i++) {
      const wx = x0 + i - MARGIN;
      for (let j = 0; j < SCAN; j++) {
        const h = hs[i * SCAN + j];
        if (h <= BEACH_MAX) continue; // top is SAND, trees need GRASS
        const wz = z0 + j - MARGIN;
        if (hash2(wx, wz, seed) >= TREE_CHANCE) continue;

        const trunkH = 4 + Math.floor(hash2(wx, wz, seed + 7) * 2);
        const top = h + trunkH; // y of topmost LOG

        for (let y = h + 1; y <= top; y++) put(wx, y, wz, BLOCK.LOG, false);

        // Canopy: two radius-2 layers, one radius-1 layer, one cap block.
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              put(wx + dx, top + dy, wz + dz, BLOCK.LEAVES, true);
            }
          }
        }
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            put(wx + dx, top + 1, wz + dz, BLOCK.LEAVES, true);
          }
        }
        put(wx, top + 2, wz, BLOCK.LEAVES, true);
      }
    }

    return data;
  }

  return { generateChunk, heightAt };
}
