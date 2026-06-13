// Pure simulation kernel. reduce(state, inputs, dtWall, ctx) → evolves entities.
// NO DOM / three.js / timers / Math.random / Date.now. Deterministic & bit-identical
// across devices: uses only the noise.js integer hash + add/mul (NO runtime sin/cos/
// atan2 — transcendentals aren't ULP-stable across platforms). Both host & members
// run THIS exact function over the same registries ⇒ same input → same state.

import { hash2 } from '../noise.js';
import { DT_FIXED, MAX_CATCHUP_TICKS } from './constants-sim.js';
import { packByKey } from './actionpacks.js';
import { protoByKey } from './prototypes.js';

// 8 baked unit directions (f64 literals = identical on every device). Movement picks
// one of these instead of computing sin/cos at runtime.
const Q = 0.70710678118654752; // 1/√2 as a fixed literal
const DIRS = [
  [1, 0], [Q, Q], [0, 1], [-Q, Q], [-1, 0], [-Q, -Q], [0, -1], [Q, -Q],
];

export function makeState() {
  return { acc: 0, tick: 0, ents: new Map() };
}

export function makeEntity(id, protoKey, packKey, x, y, z, seed) {
  return {
    id, m: { p: protoKey, a: packKey },  // manifest: string CODES into the registries
    x, y, z, dir: 0,                     // dynamic state (evolved each tick)
    ax: x, az: z, bob: 0,                // hop anchor + vertical bob phase (render reads bob)
    hp: protoByKey(protoKey).hp,
    st: 0, stT: 0,                       // action-pack state index + ticks-in-state
    seed: seed >>> 0,                    // deterministic RNG seed (travels in snapshot)
  };
}

function nearest(e, players) {
  let best = null;
  for (let i = 0; i < players.length; i++) {
    const dx = players[i].x - e.x, dz = players[i].z - e.z;
    const d2 = dx * dx + dz * dz;
    if (best === null || d2 < best.d2) best = { dx, dz, d2 };
  }
  return best; // {dx,dz toward player, d2} or null
}

function stepFixed(state, inputs, dt, out) {
  const players = inputs.players || [];
  // 序 contract: iterate by sorted entity id, never Map insertion order.
  const ids = [...state.ents.keys()].sort((a, b) => a - b);
  for (let k = 0; k < ids.length; k++) {
    const e = state.ents.get(ids[k]);
    const pack = packByKey(e.m.a);
    const near = nearest(e, players);
    const sense = pack.states[e.st].sense;
    const isNear = near !== null && near.d2 < sense * sense;

    // transitions (data-driven; `when` ∈ fixed vocabulary)
    for (let t = 0; t < pack.transitions.length; t++) {
      const tr = pack.transitions[t];
      if (tr.from !== e.st) continue;
      if ((tr.when === 'playerNear' && isNear) || (tr.when === 'playerFar' && !isNear)) {
        if (e.st !== tr.to) { e.st = tr.to; e.stT = 0; }
        break;
      }
    }

    // run the current state's prim (kernel-fixed behaviour; data only tunes speed/sense)
    const cur = pack.states[e.st];
    let vx = 0, vz = 0;
    e.bob = 0;
    if (cur.prim === 'wander') {
      if (e.stT % 12 === 0) e.dir = (hash2(e.id, state.tick, e.seed) * 8) | 0; // deterministic heading
      const d = DIRS[e.dir & 7]; vx = d[0] * cur.speed; vz = d[1] * cur.speed;
    } else if (cur.prim === 'flee' && near !== null && near.d2 > 1e-6) {
      // pick the baked direction best pointing AWAY from the player — dot products only
      let bi = 0, bestDot = -Infinity;
      for (let i = 0; i < 8; i++) {
        const dot = DIRS[i][0] * -near.dx + DIRS[i][1] * -near.dz;
        if (dot > bestDot) { bestDot = dot; bi = i; }
      }
      e.dir = bi; const d = DIRS[bi]; vx = d[0] * cur.speed; vz = d[1] * cur.speed;
    } else if (cur.prim === 'hop') {
      // 原地小范围蹦跳: hold the anchor (ease back, never drifts) + a deterministic
      // triangle bob the renderer lifts the avatar by. speed tunes bounciness.
      const ph = e.stT % 12;
      e.bob = (ph < 6 ? ph : 12 - ph) / 6 * (cur.speed || 1);  // 0→1→0 hop height
      vx = (e.ax - e.x) * 2; vz = (e.az - e.z) * 2;
    } // idle / chase → stand still (chase prim is a stub for a later slice)

    e.x += vx * dt; e.z += vz * dt; e.stT++;
    out.push({ t: 'ent.move', id: e.id, x: e.x, z: e.z, dir: e.dir, st: e.st });
  }
  state.tick++;
}

// Fixed-step accumulator. Drivers feed dtWall (browser rAF dt clamped, or server hrtime).
export function reduce(state, inputs, dtWall, ctx) {
  let acc = state.acc + dtWall, ticks = 0;
  const out = ctx.out;
  while (acc >= DT_FIXED && ticks < MAX_CATCHUP_TICKS) {
    stepFixed(state, inputs, DT_FIXED, out);
    acc -= DT_FIXED; ticks++;
  }
  state.acc = acc;
  return { state, out };
}
