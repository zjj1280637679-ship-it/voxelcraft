// Headless proof: pure kernel + EffectResolver run, are deterministic, and the engine
// GENERALISES — new creatures/behaviours are pure DATA (registry entries referenced by
// string code), zero kernel change.   node public/js/sim/_test.js

import { makeState, makeEntity, reduce } from './kernel.js';
import { effect } from './effect.js';
import { REGISTRY_HASH } from './registry-hash.js';

// ---- 1. determinism: one skittish fowl, wander then flee, ran twice = bit-identical ----
function runFowl() {
  const st = makeState();
  st.ents.set(1, makeEntity(1, 'fowl_small', 'skittish_flee', 0, 40, 0, 12345));
  const trace = [];
  for (let f = 0; f < 24; f++) {
    const players = f < 12 ? [{ x: 50, z: 50 }] : [{ x: 2, z: 0 }];
    reduce(st, { players }, 0.1, { out: [] });
    const e = st.ents.get(1);
    trace.push(`${e.st === 0 ? 'wander' : 'flee'} x=${e.x.toFixed(2)} z=${e.z.toFixed(2)}`);
  }
  return trace;
}
const a = runFowl(), b = runFowl();

// ---- 2. generality: 3 creatures = 3 registry rows, all same distance from a near player ----
function runGenerality() {
  const st = makeState();
  st.ents.set(1, makeEntity(1, 'fowl_small', 'skittish_flee', 4, 0, 0, 11));  // sense 6, flee 3.5
  st.ents.set(2, makeEntity(2, 'rabbit',     'jumpy_flee',    0, 0, 4, 22));  // sense 9, flee 5.5
  st.ents.set(3, makeEntity(3, 'golem',      'fearless',      0, 0, -4, 33)); // sense 0, never flees
  const start = new Map([...st.ents].map(([id, e]) => [id, { x: e.x, z: e.z }]));
  for (let f = 0; f < 20; f++) reduce(st, { players: [{ x: 0, z: 0 }] }, 0.1, { out: [] }); // player at origin
  const rows = [];
  for (const [id, e] of st.ents) {
    const s = start.get(id);
    const moved = Math.hypot(e.x - s.x, e.z - s.z);
    rows.push(`  ${e.m.p.padEnd(11)}(${e.m.a.padEnd(13)}) st=${e.st === 0 ? 'wander' : 'flee  '} moved=${moved.toFixed(1)}`);
  }
  return rows;
}

console.log('REGISTRY_HASH =', REGISTRY_HASH);
console.log('\n=== 1. determinism (fowl wander→flee, ran twice bit-identical): '
  + (JSON.stringify(a) === JSON.stringify(b) ? 'PASS' : 'FAIL') + ' ===');
console.log('\n=== 2. generality: 3 creatures = 3 DATA rows, distinct behaviour vs a near player ===');
console.log(runGenerality().join('\n'));
console.log('  (fowl & rabbit flee — rabbit faster/further; golem ignores the player, just wanders)');

console.log('\n=== 3. EffectResolver: effect = base × (1 + Σ matching id-tag mods) ===');
const woodSword  = [{ tag: '阶.石', val: -0.5 }, { tag: '阶.铁', val: -0.75 }, { tag: '阶.金', val: -0.9 }, { tag: '阶.钻', val: -0.95 }];
const dragonBane = [{ tag: '生物', val: -1.0 }, { tag: '生物.龙', val: 2.0 }];
const healWand   = [{ tag: '生物', val: -1.5 }];
const stone = ['方块.石', '阶.石'], diamond = ['方块.钻', '阶.钻'], fowl = ['生物.禽', '阶.木'], dragon = ['生物.龙', '阶.钻'];
const show = (label, v) => console.log('  ' + label.padEnd(26) + ' effect = ' + v.toFixed(2).padStart(7)
  + '  → ' + (v > 0 ? '伤害' : v < 0 ? '治疗(+HP)' : '免疫'));
show('木剑(10) 打 石块', effect(10, woodSword, stone));
show('木剑(10) 打 钻石块', effect(10, woodSword, diamond));
show('屠龙剑(20) 打 普通生物', effect(20, dragonBane, fowl));
show('屠龙剑(20) 打 龙', effect(20, dragonBane, dragon));
show('治疗杖(10) 对 生物', effect(10, healWand, fowl));
