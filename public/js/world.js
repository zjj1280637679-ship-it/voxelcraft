// World data store: chunk map, edit log, dirty tracking, voxel raycast.
// Pure data module — no three.js imports. raycast accepts any {x,y,z}-like.

import { CHUNK, HEIGHT, BLOCK, chunkIndex, chunkKey, blockKey } from './constants.js';
import { makeGenerator } from './terrain.js';

export class World {
  constructor(seed) {
    this.seed = seed;
    this.chunks = new Map(); // Map<chunkKey, Uint8Array>
    this.edits = new Map();  // Map<blockKey, id>
    this.dirty = new Set();  // Set<chunkKey> — renderer consumes & clears
    // Per-chunk edit index so ensureChunk replays only the edits inside the
    // generated chunk instead of scanning the whole global edit log.
    this._editsByChunk = new Map(); // Map<chunkKey, Map<chunkIndex, id>>
    this._gen = makeGenerator(seed);
    this._rings = new Map(); // radius -> [dx,dz] offsets sorted nearest-first
  }

  getBlock(x, y, z) {
    if (y < 0) return BLOCK.STONE;
    if (y >= HEIGHT) return BLOCK.AIR;
    x = Math.floor(x);
    z = Math.floor(z);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return BLOCK.AIR;
    return chunk[chunkIndex(x - cx * CHUNK, Math.floor(y), z - cz * CHUNK)];
  }

  setBlock(x, y, z, id) {
    this._set(x, y, z, id);
  }

  // Same behavior as setBlock; semantic entry point for network/initial edits.
  applyEdit(x, y, z, id) {
    this._set(x, y, z, id);
  }

  _set(x, y, z, id) {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    // NaN coords false-pass the y range check below and would pollute the
    // edit log with 'NaN,NaN,NaN' keys — reject non-finite inputs outright.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (y < 0 || y >= HEIGHT) return;
    this.edits.set(blockKey(x, y, z), id);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cz);
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    const idx = chunkIndex(lx, y, lz);
    let byChunk = this._editsByChunk.get(key);
    if (!byChunk) {
      byChunk = new Map();
      this._editsByChunk.set(key, byChunk);
    }
    byChunk.set(idx, id);
    const chunk = this.chunks.get(key);
    if (!chunk) return; // recorded; applied when the chunk generates
    chunk[idx] = id;
    this.dirty.add(key);
    // Border edits change face culling of neighbor meshes too.
    if (lx === 0) this._dirtyIfPresent(cx - 1, cz);
    if (lx === CHUNK - 1) this._dirtyIfPresent(cx + 1, cz);
    if (lz === 0) this._dirtyIfPresent(cx, cz - 1);
    if (lz === CHUNK - 1) this._dirtyIfPresent(cx, cz + 1);
  }

  _dirtyIfPresent(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) this.dirty.add(key);
  }

  // Generate the chunk if missing, replay stored edits that fall inside it,
  // mark it dirty. Returns true if a new chunk was generated.
  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) return false;
    const data = this._gen.generateChunk(cx, cz);
    const stored = this._editsByChunk.get(key);
    if (stored) {
      for (const [idx, id] of stored) data[idx] = id;
    }
    this.chunks.set(key, data);
    this.dirty.add(key);
    // Existing neighbors gain interior faces along the new border — remesh.
    this._dirtyIfPresent(cx - 1, cz);
    this._dirtyIfPresent(cx + 1, cz);
    this._dirtyIfPresent(cx, cz - 1);
    this._dirtyIfPresent(cx, cz + 1);
    return true;
  }

  // Ensure chunks in a square radius around world pos (x,z), nearest-first,
  // generating at most maxPerCall new chunks. Returns count generated.
  ensureAround(x, z, radius, maxPerCall = 2) {
    const ccx = Math.floor(x / CHUNK);
    const ccz = Math.floor(z / CHUNK);
    const ring = this._ring(radius);
    let made = 0;
    for (let i = 0; i < ring.length; i++) {
      const o = ring[i];
      if (this.ensureChunk(ccx + o[0], ccz + o[1])) {
        made++;
        if (made >= maxPerCall) break;
      }
    }
    return made;
  }

  _ring(radius) {
    let ring = this._rings.get(radius);
    if (!ring) {
      ring = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          ring.push([dx, dz]);
        }
      }
      ring.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
      this._rings.set(radius, ring);
    }
    return ring;
  }

  // Top-most non-air y in the column (-1 if the column is entirely air).
  surfaceHeight(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    this.ensureChunk(cx, cz);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    for (let y = HEIGHT - 1; y >= 0; y--) {
      if (chunk[chunkIndex(lx, y, lz)] !== BLOCK.AIR) return y;
    }
    return -1;
  }

  // Amanatides-Woo DDA voxel walk. origin/dir: {x,y,z}-like, dir normalized.
  // Returns { x, y, z, face:[nx,ny,nz] } (face = normal of the entered face)
  // or null. The voxel containing the origin itself is never reported.
  raycast(origin, dir, maxDist) {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);

    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dir.x); // Infinity when component is 0
    const tDeltaY = Math.abs(1 / dir.y);
    const tDeltaZ = Math.abs(1 / dir.z);
    let tMaxX = tDeltaX === Infinity ? Infinity : (stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX;
    let tMaxY = tDeltaY === Infinity ? Infinity : (stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY;
    let tMaxZ = tDeltaZ === Infinity ? Infinity : (stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ;

    let nx = 0, ny = 0, nz = 0;
    for (;;) {
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        if (tMaxX > maxDist) return null;
        x += stepX; tMaxX += tDeltaX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY <= tMaxZ) {
        if (tMaxY > maxDist) return null;
        y += stepY; tMaxY += tDeltaY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        if (tMaxZ > maxDist) return null;
        z += stepZ; tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
      if (this.getBlock(x, y, z) !== BLOCK.AIR) {
        return { x, y, z, face: [nx, ny, nz] };
      }
    }
  }
}
