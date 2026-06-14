// THE unified avatar model — backend #1: PURE VOXEL. A model is a fine voxel grid, authored as a
// list of filled box REGIONS (so ~25 lines describe a detailed character instead of 1000 voxels).
// Pure DATA (no three.js), so every view shares ONE source of truth (= 统一造物台):
//   · renderer.js rasterizes the boxes → ONE culled, vertex-coloured mesh   (3D, in-game)
//   · ui.js projects the boxes to a 2D canvas                                (menu preview)
//
// Coords: integer voxels, feet at y=0, x centred on 0, −z = FRONT (face). Later boxes overwrite
// earlier ones (layering), so face details (eyes) overwrite the head's front skin.

import { PALETTE, SKIN_TONES } from './constants.js';

const EYE = '#15171c';

export const AVATAR_VOX_H = 30; // model height in voxels (the grid resolution / detail ceiling knob)

// BASE BODY (素体) — proportions taken from a gpt-image-2 front/side/back turnaround: a clean blocky
// humanoid, head + eyes, torso, bare arms, two legs. Coloured by the customizable skin slots
// (head/arms = skin·k, torso = top·t, legs = pant·p). Outfits (hair/cloak/belt/boots) layer on later.
export function avatarModel(sk) {
  const skin = SKIN_TONES[sk.k], top = PALETTE[sk.t], pant = PALETTE[sk.p];
  const B = (x0, x1, y0, y1, z0, z1, color) => ({ x0, x1, y0, y1, z0, z1, color });
  const boxes = [
    // legs (≈40% of height) + pelvis
    B(-5, -1, 0, 12, -3, 3, pant), B(1, 5, 0, 12, -3, 3, pant),
    B(-5, 5, 12, 14, -3, 3, pant),
    // torso (top/shirt; depth z−3..3 read off the side view)
    B(-6, 6, 14, 23, -3, 3, top),
    // bare arms hanging at the sides, slightly proud of the torso (hands = same skin, continuous)
    B(-8, -7, 14, 23, -2, 2, skin), B(7, 8, 14, 23, -2, 2, skin),
    // head (cube on top, no neck) + two eyes on the front
    B(-4, 4, 23, 29, -3, 3, skin),
    B(-3, -2, 25, 26, -3, -3, EYE), B(2, 3, 25, 26, -3, -3, EYE),
  ];
  return { h: AVATAR_VOX_H, boxes };
}
