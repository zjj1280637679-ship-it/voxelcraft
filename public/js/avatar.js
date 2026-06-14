// THE unified avatar model — backend #1: PURE VOXEL. A model is a fine voxel grid, authored as a
// list of filled box REGIONS (so ~25 lines describe a detailed character instead of 1000 voxels).
// Pure DATA (no three.js), so every view shares ONE source of truth (= 统一造物台):
//   · renderer.js rasterizes the boxes → ONE culled, vertex-coloured mesh   (3D, in-game)
//   · ui.js projects the boxes to a 2D canvas                                (menu preview)
//
// Coords: integer voxels, feet at y=0, x centred on 0, −z = FRONT (face). Later boxes overwrite
// earlier ones (layering), so face details (eyes) overwrite the head's front skin.

import { PALETTE, SKIN_TONES } from './constants.js';

const EYE = '#15171c', MOUTH = '#7a5650';

export const AVATAR_VOX_H = 30; // model height in voxels (the grid resolution / detail ceiling knob)

// BASE BODY (素体) — SHAPED with many mixed-size boxes: big boxes for bulk, small boxes for detail.
// No box-count cap (the mesher rasterizes → one culled mesh regardless). Proportions from a
// gpt-image-2 front/side/back turnaround. Coloured by the customizable skin slots
// (skin/neck/arms/ears = k, torso = t, legs = p). Outfits layer on top later.
export function avatarModel(sk) {
  const skin = SKIN_TONES[sk.k], top = PALETTE[sk.t], pant = PALETTE[sk.p];
  const B = (x0, x1, y0, y1, z0, z1, color) => ({ x0, x1, y0, y1, z0, z1, color });
  const boxes = [
    // ── legs: foot + calf(narrower) + thigh(wider) — taper from big/small boxes ──
    B(-5, -1, 0, 1, -4, 3, skin), B(1, 5, 0, 1, -4, 3, skin),       // feet (forward)
    B(-5, -2, 1, 6, -2, 2, pant), B(2, 5, 1, 6, -2, 2, pant),        // calves (narrow)
    B(-5, -1, 6, 12, -3, 3, pant), B(1, 5, 6, 12, -3, 3, pant),      // thighs (wide)
    B(-5, 5, 12, 14, -3, 3, pant),                                  // pelvis
    // ── torso: waist(narrow) + chest(wide) + shoulder nubs ──
    B(-5, 5, 14, 18, -3, 3, top),                                   // waist
    B(-6, 6, 18, 22, -3, 3, top),                                   // chest
    B(-7, -6, 20, 22, -2, 2, top), B(6, 7, 20, 22, -2, 2, top),     // shoulders
    // ── arms: upper + forearm + hand (segmented) ──
    B(-8, -7, 18, 22, -2, 2, skin), B(7, 8, 18, 22, -2, 2, skin),   // upper arms
    B(-8, -7, 14, 18, -2, 2, skin), B(7, 8, 14, 18, -2, 2, skin),   // forearms
    B(-8, -7, 12, 14, -2, 2, skin), B(7, 8, 12, 14, -2, 2, skin),   // hands
    // ── neck ──
    B(-2, 2, 22, 23, -2, 2, skin),
    // ── head: cranium(wide) + jaw(narrower) + ears ──
    B(-4, 4, 24, 29, -3, 3, skin),                                  // cranium
    B(-3, 3, 23, 24, -3, 3, skin),                                  // jaw/chin
    B(-5, -4, 25, 27, -1, 1, skin), B(4, 5, 25, 27, -1, 1, skin),   // ears
    // ── face (front z=−3; nose protrudes to −4) ──
    B(-3, -2, 26, 27, -3, -3, EYE), B(2, 3, 26, 27, -3, -3, EYE),   // eyes
    B(0, 0, 25, 26, -4, -4, skin),                                  // nose
    B(-1, 1, 24, 25, -3, -3, MOUTH),                                // mouth
  ];
  return { h: AVATAR_VOX_H, boxes };
}
