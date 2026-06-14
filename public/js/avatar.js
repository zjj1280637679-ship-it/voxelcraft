// THE unified avatar model — backend #1: PURE VOXEL. A model is a fine voxel grid, authored as a
// list of filled box REGIONS (so ~25 lines describe a detailed character instead of 1000 voxels).
// Pure DATA (no three.js), so every view shares ONE source of truth (= 统一造物台):
//   · renderer.js rasterizes the boxes → ONE culled, vertex-coloured mesh   (3D, in-game)
//   · ui.js projects the boxes to a 2D canvas                                (menu preview)
//
// Coords: integer voxels, feet at y=0, x centred on 0, −z = FRONT (face). Later boxes overwrite
// earlier ones (layering), so face details (eyes) overwrite the head's front skin.

import { PALETTE, SKIN_TONES } from './constants.js';

// fixed accent palette (not in the 4-slot skin yet — the detail this backend unlocks)
const HAIR = '#3a2a1b', BOOT = '#2b2420', BELT = '#3a2a18', CLOAK = '#3f6e4a', EYE = '#15171c', MOUTH = '#6a463c';

export const AVATAR_VOX_H = 30; // model height in voxels (the grid resolution / detail ceiling knob)

export function avatarModel(sk) {
  const skin = SKIN_TONES[sk.k], top = PALETTE[sk.t], pant = PALETTE[sk.p];
  const B = (x0, x1, y0, y1, z0, z1, color) => ({ x0, x1, y0, y1, z0, z1, color });
  const boxes = [
    // ── legs + boots + hip ──
    B(-5, -1, 0, 12, -2, 2, pant), B(1, 5, 0, 12, -2, 2, pant),
    B(-5, -1, 0, 2, -3, 2, BOOT), B(1, 5, 0, 2, -3, 2, BOOT),
    B(-5, 5, 12, 13, -2, 2, pant),
    // ── torso + belt + collar/cloak ──
    B(-6, 6, 14, 22, -3, 3, top),
    B(-6, 6, 13, 14, -3, 3, BELT),
    B(-5, 5, 21, 22, -4, 3, CLOAK),
    // ── arms (sleeves) + hands ──
    B(-8, -7, 14, 22, -2, 2, top), B(7, 8, 14, 22, -2, 2, top),
    B(-8, -7, 13, 14, -2, 2, skin), B(7, 8, 13, 14, -2, 2, skin),
    // ── head ──
    B(-4, 4, 22, 28, -3, 3, skin),
    // ── hair (top / back / sides / front fringe) ──
    B(-5, 5, 27, 29, -4, 3, HAIR),
    B(-5, 5, 22, 28, 2, 3, HAIR),
    B(-5, -4, 23, 28, -3, 2, HAIR), B(4, 5, 23, 28, -3, 2, HAIR),
    B(-4, 4, 26, 27, -4, -3, HAIR),
    // ── face (overwrites the head's front skin at z=−3, nose protrudes to z=−4) ──
    B(-3, -2, 24, 25, -3, -3, EYE), B(2, 3, 24, 25, -3, -3, EYE),
    B(0, 0, 23, 24, -4, -4, skin),
    B(-1, 1, 22, 23, -3, -3, MOUTH),
  ];
  return { h: AVATAR_VOX_H, boxes };
}
