// Shared game constants. This file is the single source of truth for sizes,
// block ids and player physics. Both client modules import it; the server
// duplicates only the few message-type strings it needs (JSON protocol).

export const CHUNK = 16;       // chunk is 16x16 columns
export const HEIGHT = 64;      // world height in blocks

// Block ids (0 = air). Max 255 (chunks are Uint8Array).
export const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  LOG: 5,
  LEAVES: 6,
  PLANK: 7,
  BRICK: 8,
};

// Hotbar slots (block ids, in order). Index 0..7 -> keys 1..8.
export const HOTBAR = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.SAND,
  BLOCK.LOG, BLOCK.LEAVES, BLOCK.PLANK, BLOCK.BRICK,
];

// Character skin palette: exactly 8 hex colors. skin = {s, p} are indices
// into this array for shirt (torso) and pants (legs).
export const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#5dbb46',
  '#1abc9c', '#3498db', '#9b59b6', '#e8ecf2',
];

export const PLAYER = {
  WIDTH: 0.6,    // AABB x/z size
  HEIGHT: 1.8,   // AABB y size
  EYE: 1.62,     // eye height above feet
  SPEED: 5.5,    // m/s walk speed
  JUMP: 8.5,     // jump impulse m/s
  GRAVITY: 24,   // m/s^2
  REACH: 6,      // block interaction distance
};

// chunk array index for local coords (lx,y,lz in [0,16) x [0,64) x [0,16))
export function chunkIndex(lx, y, lz) {
  return (y * CHUNK + lz) * CHUNK + lx;
}

export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

export function blockKey(x, y, z) {
  return x + ',' + y + ',' + z;
}
