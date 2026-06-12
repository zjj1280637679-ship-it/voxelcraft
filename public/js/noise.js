// Deterministic noise & hashing. No imports, pure math. Uses only IEEE-754
// add/sub/mul/div/sqrt and 32-bit integer ops, all of which are exactly
// specified — same seed yields bit-identical results on every device.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fast deterministic per-coordinate hash -> [0,1). Used for tree placement.
export function hash2(x, z, seed) {
  let h = Math.imul(x | 0, 0x85ebca6b) ^ Math.imul(z | 0, 0xc2b2ae35) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x045d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x045d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Seeded 2D simplex noise -> roughly [-1,1]. Self-contained implementation
// (classic Gustavson formulation, permutation table shuffled via mulberry32).
export function makeNoise2D(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const GRADX = [1, -1, 1, -1, 1, -1, 0, 0];
  const GRADY = [1, 1, -1, -1, 0, 0, 1, -1];

  return function noise2D(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]] & 7;
      t0 *= t0;
      n0 = t0 * t0 * (GRADX[g] * x0 + GRADY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]] & 7;
      t1 *= t1;
      n1 = t1 * t1 * (GRADX[g] * x1 + GRADY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]] & 7;
      t2 *= t2;
      n2 = t2 * t2 * (GRADX[g] * x2 + GRADY[g] * y2);
    }
    return 70 * (n0 + n1 + n2);
  };
}
