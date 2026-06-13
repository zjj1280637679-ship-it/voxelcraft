// Procedural pixel-art texture atlas. All tiles are original generative art:
// flat base colors plus seeded speckle/stripes drawn pixel-by-pixel on canvas.
import * as THREE from '../lib/three.module.js';
import { BLOCK } from './constants.js';

const TILE = 16;       // tile size in px
const GRID = 4;        // 4x4 tiles
const ATLAS = TILE * GRID;  // 64
const INSET = 0.5 / ATLAS;  // half-pixel UV inset against bleeding

// Per-block tile indices, face order: +x, -x, +y, -y, +z, -z.
export const FACE_TILES = {
  [BLOCK.GRASS]:  [1, 1, 0, 2, 1, 1],
  [BLOCK.DIRT]:   [2, 2, 2, 2, 2, 2],
  [BLOCK.STONE]:  [3, 3, 3, 3, 3, 3],
  [BLOCK.SAND]:   [4, 4, 4, 4, 4, 4],
  [BLOCK.LOG]:    [5, 5, 6, 6, 5, 5],
  [BLOCK.LEAVES]: [7, 7, 7, 7, 7, 7],
  [BLOCK.PLANK]:  [8, 8, 8, 8, 8, 8],
  [BLOCK.BRICK]:  [9, 9, 9, 9, 9, 9],
  [BLOCK.DIAMOND]:[10, 10, 10, 10, 10, 10],
};

// Small deterministic PRNG so the atlas looks identical on every client.
function rng32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(ctx, rand, colors, density) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (rand() < density) {
        ctx.fillStyle = colors[(rand() * colors.length) | 0];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

function paintDirtBase(ctx, rand) {
  ctx.fillStyle = '#7a5538';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#6b4a30', '#876045', '#5f4029', '#8d6849'], 0.42);
}

function paintGrassTop(ctx, rand) {
  ctx.fillStyle = '#4f9e33';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#58ab3a', '#47912c', '#61b542', '#3f8527'], 0.45);
}

function paintGrassSide(ctx, rand) {
  paintDirtBase(ctx, rand);
  // jagged green strip along the tile top (= top of the block side face)
  const greens = ['#4f9e33', '#58ab3a', '#47912c'];
  for (let x = 0; x < TILE; x++) {
    let depth = 2;
    if (rand() < 0.5) depth++;
    if (rand() < 0.2) depth++;
    for (let y = 0; y < depth; y++) {
      ctx.fillStyle = greens[(rand() * greens.length) | 0];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function paintStone(ctx, rand) {
  ctx.fillStyle = '#8b8b8b';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#7d7d7d', '#989898', '#717171', '#a3a3a3'], 0.4);
  // a few short dark crack dashes
  ctx.fillStyle = '#5e5e5e';
  for (let i = 0; i < 5; i++) {
    const x = (rand() * 13) | 0;
    const y = (rand() * 16) | 0;
    ctx.fillRect(x, y, 2 + ((rand() * 2) | 0), 1);
  }
}

function paintSand(ctx, rand) {
  ctx.fillStyle = '#d9c98c';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#cfbe7c', '#e2d49c', '#c5b272', '#e9ddaa'], 0.45);
}

function paintLogSide(ctx, rand) {
  const cols = ['#5d3f24', '#6b4a2b', '#74522f', '#523620'];
  for (let x = 0; x < TILE; x++) {
    ctx.fillStyle = cols[(rand() * cols.length) | 0];
    ctx.fillRect(x, 0, 1, TILE);
    for (let y = 0; y < TILE; y++) {
      if (rand() < 0.12) {
        ctx.fillStyle = '#46301c';
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

function paintLogEnd(ctx, rand) {
  ctx.fillStyle = '#5d3f24'; // bark border
  ctx.fillRect(0, 0, TILE, TILE);
  ctx.fillStyle = '#c49a5e'; // wood core
  ctx.fillRect(2, 2, 12, 12);
  speckle(ctx, rand, ['#bd9356', '#cba267'], 0.2);
  // growth rings as concentric square outlines
  ringRect(ctx, 4, 4, 8, 8, '#9c7544');
  ringRect(ctx, 6, 6, 4, 4, '#9c7544');
  ctx.fillStyle = '#8a6238';
  ctx.fillRect(7, 7, 2, 2);
}

function ringRect(ctx, x0, y0, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, w, 1);
  ctx.fillRect(x0, y0 + h - 1, w, 1);
  ctx.fillRect(x0, y0, 1, h);
  ctx.fillRect(x0 + w - 1, y0, 1, h);
}

function paintLeaves(ctx, rand) {
  ctx.fillStyle = '#2f6c20';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#275a1b', '#368026', '#1e4a13', '#3d8a2c'], 0.55);
  speckle(ctx, rand, ['#16330d'], 0.08); // dark gaps
}

function paintPlank(ctx, rand) {
  const tints = ['#b3884f', '#ab8048', '#ba9057', '#b08549'];
  for (let b = 0; b < 4; b++) {
    const y = b * 4;
    ctx.fillStyle = tints[(rand() * tints.length) | 0];
    ctx.fillRect(0, y, TILE, 4);
    ctx.fillStyle = '#7d5c33';
    ctx.fillRect(0, y + 3, TILE, 1);                  // horizontal seam
    const jx = (b * 5 + 3 + ((rand() * 4) | 0)) % TILE;
    ctx.fillRect(jx, y, 1, 3);                        // staggered butt joint
  }
  speckle(ctx, rand, ['#9c7440', '#c09a60'], 0.12);   // grain flecks
}

function paintBrick(ctx, rand) {
  const cols = ['#a2402f', '#984031', '#aa4636', '#93392b'];
  for (let row = 0; row < 4; row++) {
    const off = (row % 2) * 4;
    for (let k = -1; k < 3; k++) {
      ctx.fillStyle = cols[(rand() * cols.length) | 0];
      ctx.fillRect(k * 8 + off, row * 4 + 1, 8, 3);
    }
  }
  speckle(ctx, rand, ['#8f3527', '#b04b39'], 0.1);
  // mortar lines (horizontal courses + staggered vertical joints)
  ctx.fillStyle = '#b9b3a8';
  for (let row = 0; row < 4; row++) {
    ctx.fillRect(0, row * 4, TILE, 1);
    const off = (row % 2) * 4;
    for (let k = 0; k < 3; k++) {
      ctx.fillRect((k * 8 + off) % TILE, row * 4, 1, 4);
    }
  }
}

function paintDiamond(ctx, rand) {
  ctx.fillStyle = '#39c6d6'; // bright cyan base
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, rand, ['#2fb3c2', '#5fd9e6', '#27a0ad', '#7fe6f0'], 0.4);
  // a few light facet glints
  ctx.fillStyle = '#d9fbff';
  for (let i = 0; i < 6; i++) {
    const x = (rand() * 15) | 0;
    const y = (rand() * 15) | 0;
    ctx.fillRect(x, y, 1, 1);
    if (rand() < 0.5) ctx.fillRect(x + 1, y, 1, 1);
  }
}

const PAINTERS = [
  paintGrassTop,   // 0
  paintGrassSide,  // 1
  paintDirtBase,   // 2
  paintStone,      // 3
  paintSand,       // 4
  paintLogSide,    // 5
  paintLogEnd,     // 6
  paintLeaves,     // 7
  paintPlank,      // 8
  paintBrick,      // 9
  paintDiamond,    // 10
];

export function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS;
  canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, ATLAS, ATLAS);

  for (let t = 0; t < PAINTERS.length; t++) {
    const rand = rng32(0x9e3779b9 ^ Math.imul(t + 1, 0x85ebca6b));
    ctx.save();
    ctx.translate((t % GRID) * TILE, Math.floor(t / GRID) * TILE);
    // clip so painters that overdraw (bricks) never leak into neighbor tiles
    ctx.beginPath();
    ctx.rect(0, 0, TILE, TILE);
    ctx.clip();
    PAINTERS[t](ctx, rand);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  // [u0, v0, u1, v1] = min-u, min-v, max-u, max-v with flipY texture orientation:
  // v1 corresponds to the tile's drawn top row.
  function tileUV(tile) {
    const col = tile % GRID;
    const row = Math.floor(tile / GRID);
    const u0 = (col * TILE) / ATLAS + INSET;
    const u1 = ((col + 1) * TILE) / ATLAS - INSET;
    const v1 = 1 - ((row * TILE) / ATLAS + INSET);
    const v0 = 1 - (((row + 1) * TILE) / ATLAS - INSET);
    return [u0, v0, u1, v1];
  }

  function blockIcon(id) {
    const tiles = FACE_TILES[id];
    const tile = tiles ? tiles[0] : 3;
    const icon = document.createElement('canvas');
    icon.width = 32;
    icon.height = 32;
    const ictx = icon.getContext('2d');
    ictx.imageSmoothingEnabled = false;
    ictx.drawImage(
      canvas,
      (tile % GRID) * TILE, Math.floor(tile / GRID) * TILE, TILE, TILE,
      0, 0, 32, 32
    );
    return icon.toDataURL('image/png');
  }

  return { texture, tileUV, blockIcon };
}
