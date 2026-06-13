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
  DIAMOND: 9,   // dev static-craft segment (9..63); test-arena floor
};

// Hotbar slots (block ids, in order). Index 0..7 -> keys 1..8.
export const HOTBAR = [
  BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.SAND,
  BLOCK.LOG, BLOCK.LEAVES, BLOCK.PLANK, BLOCK.BRICK,
];

// Character color palette: exactly 8 hex colors. skin v2 = {b,t,p,k};
// t (top) and p (pants) index into this array.
export const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#5dbb46',
  '#1abc9c', '#3498db', '#9b59b6', '#e8ecf2',
];

// 6 skin tones, light -> dark. Index 1 === the legacy fixed head color #e0ac69,
// so migrated characters keep their old look.
export const SKIN_TONES = ['#f7d7b6', '#e0ac69', '#c98e54', '#a9743f', '#8d5524', '#5d3a1a'];

// 8 body types for skin v2. w scales avatar box x/z, h scales y; fem additionally
// scales the TORSO x/z by 0.92 (applied at render time, not stored here).
// (瘦 w=0.82, 壮 w=1.18, reference standard = 1; 矮 h=0.86, 高 h=1.08.)
export const BODIES = [
  { label: '男·矮瘦', w: 0.82, h: 0.86, fem: false }, // 0
  { label: '男·高瘦', w: 0.82, h: 1.08, fem: false }, // 1  <- legacy-migration default
  { label: '男·矮壮', w: 1.18, h: 0.86, fem: false }, // 2
  { label: '男·高壮', w: 1.18, h: 1.08, fem: false }, // 3
  { label: '女·矮瘦', w: 0.82, h: 0.86, fem: true  }, // 4
  { label: '女·高瘦', w: 0.82, h: 1.08, fem: true  }, // 5
  { label: '女·矮壮', w: 1.18, h: 0.86, fem: true  }, // 6
  { label: '女·高壮', w: 1.18, h: 1.08, fem: true  }, // 7
];

export const PLAYER = {
  WIDTH: 0.6,    // AABB x/z size
  HEIGHT: 1.8,   // AABB y size
  EYE: 1.62,     // eye height above feet
  SPEED: 5.5,    // m/s walk speed
  JUMP: 8.5,     // jump impulse m/s
  FLY: 9,        // m/s vertical flight speed (dragon form)
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
