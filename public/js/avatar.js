// THE unified avatar model spec — ONE definition of "what a character looks like" given skin
// {b,t,p,k}. Pure DATA (no three.js): a flat list of boxes in WORLD coords (feet at y=0, facing −z,
// units where ~1.8 = a body). Both backends consume it, so they can never drift apart:
//   · renderer.js builds Three.js boxes from it      (3D, in-game + other players + creatures)
//   · ui.js projects it to a 2D canvas               (menu 人物展示 / 人物设计 preview)
// = the unified 造物台. Change the model HERE and every view updates. (present-facet "model" as data)

import { BODIES, PALETTE, SKIN_TONES } from './constants.js';

export function avatarParts(sk) {
  const body = BODIES[sk.b] || BODIES[1];
  const w = body.w, h = body.h, tw = body.fem ? w * 0.92 : w;
  const skinCol = SKIN_TONES[sk.k], topCol = PALETTE[sk.t], pantCol = PALETTE[sk.p];
  const legH = 0.72 * h, torsoH = 0.60 * h, headS = 0.52 * w, headH = 0.50 * h;
  const torsoW = 0.50 * tw, torsoD = 0.28 * tw, torsoY = legH + torsoH / 2;
  const armW = 0.17 * w, armH = 0.58 * h, armX = torsoW / 2 + armW / 2;
  const shoulderY = legH + torsoH - armH / 2, headY = legH + torsoH + headH / 2;
  // `parent:'head'` parts are head-attached in 3D (so they tilt with a pitch look); their x/y/z here
  // are still WORLD coords — the 3D backend subtracts the head's position, the 2D backend uses as-is.
  return [
    { id: 'legL',  sx: 0.24 * w,        sy: legH,     sz: 0.26 * w,        x: -0.13 * w, y: legH / 2,          z: 0,                  color: pantCol },
    { id: 'legR',  sx: 0.24 * w,        sy: legH,     sz: 0.26 * w,        x:  0.13 * w, y: legH / 2,          z: 0,                  color: pantCol },
    { id: 'torso', sx: torsoW,          sy: torsoH,   sz: torsoD,          x: 0,         y: torsoY,            z: 0,                  color: topCol },
    { id: 'armL',  sx: armW,            sy: armH,     sz: 0.22 * w,        x: -armX,     y: shoulderY,         z: 0,                  color: topCol },
    { id: 'armR',  sx: armW,            sy: armH,     sz: 0.22 * w,        x:  armX,     y: shoulderY,         z: 0,                  color: topCol },
    { id: 'head',  sx: headS,           sy: headH,    sz: headS,           x: 0,         y: headY,             z: 0,                  color: skinCol },
    { id: 'hair',  sx: headS + 0.02 * w, sy: 0.16 * h, sz: headS + 0.02 * w, x: 0,       y: headY + headH / 2 - 0.05 * h, z: 0,       color: '#4a3526', parent: 'head' },
    { id: 'eyeL',  sx: 0.1 * w,         sy: 0.1 * h,  sz: 0.04 * w,        x: -0.12 * w, y: headY + 0.03 * h,  z: -headS / 2 - 0.001, color: '#20242b', parent: 'head' },
    { id: 'eyeR',  sx: 0.1 * w,         sy: 0.1 * h,  sz: 0.04 * w,        x:  0.12 * w, y: headY + 0.03 * h,  z: -headS / 2 - 0.001, color: '#20242b', parent: 'head' },
  ];
}
