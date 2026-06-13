// Lightweight IN-GAME PERCEPTION organ. Instead of a screenshot (heavy, occluded by
// terrain), read the world blocks + entities BY CODE and render a top-down ASCII
// "文字画" the agent can read directly — low latency, deterministic, occlusion-free.
//
// Upgrades:
//   · 增减像素  — `step` = blocks per output char. step1 = full detail; step>1 zooms
//                 out by down-sampling each step×step region to its highest-priority
//                 occupant (a creature/target never hides behind grass when zoomed).
//   · 识别标记  — `marks` flags targets of interest. Marked creatures render UPPERCASE
//                 (unmarked = lowercase) and get a 🎯 section with distance + 8-way
//                 compass bearing from you, so an agent can home in by reading alone.
//   · 形态      — a status line reports the player's current 变身 form + its combat tags.

import { BLOCK } from '../constants.js';
import { protoByKey } from './prototypes.js';

// block id → 1 char (top-down surface view)
const BLOCK_CH = {
  [BLOCK.AIR]: ' ', [BLOCK.GRASS]: '.', [BLOCK.DIRT]: ',', [BLOCK.STONE]: '#',
  [BLOCK.SAND]: '~', [BLOCK.LOG]: 'T', [BLOCK.LEAVES]: 't', [BLOCK.PLANK]: '=',
  [BLOCK.BRICK]: 'B', [BLOCK.DIAMOND]: 'D',
};

// draw priority — when a step×step region is down-sampled to one char, the highest
// priority occupant wins, so zooming out can never bury a target under terrain.
const PRI = { mark: 5, self: 4, ent: 3, struct: 2, ground: 1, air: 0 };
const GROUND = new Set([BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND]);

// 8-way compass bearing from a (dx east+, dz south+) offset — trig-free (abs+compare
// only), north = −z (up on the map), east = +x (right). 0.41 ≈ tan(22.5°).
export function bearing(dx, dz) {
  const ax = dx < 0 ? -dx : dx, az = dz < 0 ? -dz : dz;
  const ns = dz < 0 ? 'N' : 'S', ew = dx < 0 ? 'W' : 'E';
  if (ax < az * 0.41) return ns;        // mostly vertical
  if (az < ax * 0.41) return ew;        // mostly horizontal
  return ns + ew;                        // diagonal
}

// Resolve the `marks` selector to a Set of entity ids. Accepts: undefined/null (none),
// 'all', a proto CODE string (mark every entity of that kind), an id array, or a
// predicate (e) => boolean.
function resolveMarks(simDriver, marks) {
  const set = new Set();
  if (!simDriver || marks == null) return set;
  const ents = simDriver.state.ents;
  if (marks === 'all') { for (const e of ents.values()) set.add(e.id); return set; }
  if (typeof marks === 'function') { for (const e of ents.values()) if (marks(e)) set.add(e.id); return set; }
  if (typeof marks === 'string') { for (const e of ents.values()) if (e.m.p === marks) set.add(e.id); return set; }
  if (Array.isArray(marks)) { for (const v of marks) set.add(v); return set; } // entity ids
  return set;
}

// Top-down ASCII map centred on the player. north ↑ (smaller z), east → (larger x).
export function perceive({ world, simDriver, player, radius = 10, step = 1, marks }) {
  step = Math.max(1, step | 0);
  const px = player.pos.x, pz = player.pos.z;
  const cx = Math.floor(px), cz = Math.floor(pz);
  const markSet = resolveMarks(simDriver, marks);
  const ents = simDriver ? [...simDriver.state.ents.values()] : [];

  // overlay: "x,z" → {ch, pri}. Player '@'; marked ents UPPERCASE, unmarked lowercase.
  const overlay = new Map();
  overlay.set(cx + ',' + cz, { ch: '@', pri: PRI.self });
  for (const e of ents) {
    const letter = e.m.p[0] || '?';
    const marked = markSet.has(e.id);
    const cand = { ch: marked ? letter.toUpperCase() : letter.toLowerCase(), pri: marked ? PRI.mark : PRI.ent };
    const key = Math.floor(e.x) + ',' + Math.floor(e.z);
    const prev = overlay.get(key);
    if (!prev || cand.pri > prev.pri) overlay.set(key, cand);
  }

  // sample one block cell → {ch, pri} (overlay wins; else classify the surface block)
  const sample = (x, z) => {
    const o = overlay.get(x + ',' + z);
    if (o) return o;
    const y = world.surfaceHeight(x, z);
    if (y < 0) return { ch: ' ', pri: PRI.air };
    const b = world.getBlock(x, y, z);
    const ch = BLOCK_CH[b] !== undefined ? BLOCK_CH[b] : '?';
    const pri = b === BLOCK.AIR ? PRI.air : (GROUND.has(b) ? PRI.ground : PRI.struct);
    return { ch, pri };
  };

  const rows = [];
  for (let z0 = cz - radius; z0 <= cz + radius; z0 += step) {
    let row = '';
    for (let x0 = cx - radius; x0 <= cx + radius; x0 += step) {
      let best = null;                              // down-sample the step×step region
      for (let dz = 0; dz < step; dz++) {
        for (let dx = 0; dx < step; dx++) {
          const s = sample(x0 + dx, z0 + dz);
          if (!best || s.pri > best.pri) best = s;
        }
      }
      row += best.ch;
    }
    rows.push(row);
  }

  // your current 变身 form + the combat tags it resolves through
  const form = player.form ? protoByKey(player.form) : null;
  const formTags = form ? form.tags.concat(player.uidTag ? [player.uidTag] : []) : [];

  // 🎯 marked targets, each with straight-line distance + compass bearing from you
  const targets = [...markSet]
    .map((id) => (simDriver ? simDriver.state.ents.get(id) : null))
    .filter(Boolean)
    .map((e) => {
      const dx = e.x - px, dz = e.z - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      return `  ${(e.m.p[0] || '?').toUpperCase()} ${protoByKey(e.m.p).name}(${e.m.p}) 距${dist.toFixed(1)} ${bearing(dx, dz)} hp${e.hp} @(${e.x.toFixed(1)},${e.z.toFixed(1)})`;
    });

  const roster = ents.map(
    (e) => `  ${(e.m.p[0] || '?').toUpperCase()} ${e.m.p}(${e.m.a}) @(${e.x.toFixed(1)},${e.z.toFixed(1)}) hp${e.hp} bob=${(e.bob || 0).toFixed(2)}${markSet.has(e.id) ? ' ◀标记' : ''}`);

  const w = rows[0] ? rows[0].length : 1;
  const bar = '─'.repeat(w);
  const out = [
    `透视 @你(${cx},${cz}) 半径${radius} 像素${step}格/字 北↑东→`,
    `你: 形态=${form ? form.name : '?'}[${formTags.join(',')}]`,
    '图例: @你 D钻 #石 .草 ,土 ~沙 T木 t叶 =板 B砖  生物=代号首字母(标记大写/未标记小写)',
    '┌' + bar + '┐',
    ...rows.map((r) => '│' + r + '│'),
    '└' + bar + '┘',
  ];
  if (targets.length) out.push(`🎯 标记目标 ${targets.length}:`, ...targets);
  out.push(`生物 ${roster.length}:`, ...roster);
  return out.join('\n');
}

// Build a flat diamond plain "outside the world" (a floating slab above the terrain)
// and spawn a grid of in-place hoppers on it as a clean, observable test stage.
export function buildTestArena({ world, simDriver, renderer, player, spawn }) {
  const cx = 8, cz = 8, R = 8, Y = 50;
  for (let x = cx - R; x <= cx + R; x++) {
    for (let z = cz - R; z <= cz + R; z++) {
      world.setBlock(x, Y, z, BLOCK.DIAMOND);
      for (let y = Y + 1; y <= Y + 5; y++) world.setBlock(x, y, z, BLOCK.AIR);
    }
  }
  if (simDriver && spawn) {
    simDriver.clear();
    const codes = ['fowl_small', 'rabbit', 'golem'];
    let n = 0;
    for (let gx = -4; gx <= 4; gx += 4) {
      for (let gz = -4; gz <= 4; gz += 4) {
        spawn(codes[n % codes.length], 'hop_in_place', cx + gx + 0.5, cz + gz + 0.5, 0x1000 + n * 17);
        n++;
      }
    }
  }
  player.pos.x = cx + 0.5; player.pos.z = cz - 7.5; player.pos.y = Y + 2;
  player.vel.x = 0; player.vel.y = 0; player.vel.z = 0;
  player.yaw = Math.PI; player.pitch = -0.45;
  return `钻石平原 ${R * 2 + 1}×${R * 2 + 1} @ y${Y} 已搭, ${simDriver ? simDriver.state.ents.size : 0} 只蹦跳生物`;
}
