// Headless proof that the pure kernel + EffectResolver run and are deterministic.
//   node public/js/sim/_test.js
// Verifies: (1) a fleeing creature evolves by the pure kernel via fed dt;
//           (2) running it twice is bit-identical (cross-device determinism premise);
//           (3) the WHOLE damage/mining/heal/克制 system is one effect() + data.

import { makeState, makeEntity, reduce } from './kernel.js';
import { effect } from './effect.js';
import { REGISTRY_HASH } from './registry-hash.js';

function runCreature() {
  const st = makeState();
  st.ents.set(1, makeEntity(1, /*fowl_small*/3, /*skittish_flee*/0, 0, 40, 0, 12345));
  const trace = [];
  for (let f = 0; f < 30; f++) {
    const players = f < 15 ? [{ x: 50, z: 50 }] : [{ x: 2, z: 0 }]; // far → near @ frame 15
    const ctx = { out: [] };
    reduce(st, { players }, 0.1, ctx);
    const e = st.ents.get(1);
    trace.push(`f${String(f).padStart(2)} st=${e.st === 0 ? 'wander' : 'flee  '} x=${e.x.toFixed(2)} z=${e.z.toFixed(2)}`);
  }
  return trace;
}

const a = runCreature();
const b = runCreature();
const deterministic = JSON.stringify(a) === JSON.stringify(b);

console.log('REGISTRY_HASH =', REGISTRY_HASH);
console.log('\n=== pure kernel: skittish fowl (wander, then flee when player nears @f15) ===');
console.log(a.join('\n'));
console.log('\n=== determinism (ran twice, bit-identical): ' + (deterministic ? 'PASS' : 'FAIL') + ' ===');

console.log('\n=== EffectResolver: effect = base × (1 + Σ matching id-tag mods) ===');
const woodSword  = [{ tag: '阶.石', val: -0.5 }, { tag: '阶.铁', val: -0.75 }, { tag: '阶.金', val: -0.9 }, { tag: '阶.钻', val: -0.95 }];
const dragonBane = [{ tag: '生物', val: -1.0 }, { tag: '生物.龙', val: 2.0 }];
const healWand   = [{ tag: '生物', val: -1.5 }];
const stone = ['方块.石', '阶.石'], diamond = ['方块.钻', '阶.钻'], fowl = ['生物.禽', '阶.木'], dragon = ['生物.龙', '阶.钻'];

function show(label, v) {
  const kind = v > 0 ? '伤害' : (v < 0 ? '治疗(+HP)' : '免疫');
  console.log('  ' + label.padEnd(30) + ' effect = ' + v.toFixed(2).padStart(7) + '  → ' + kind);
}
show('木剑(10) 打 石块', effect(10, woodSword, stone));
show('木剑(10) 打 钻石块', effect(10, woodSword, diamond));   // 无免疫: 0.50, still > 0
show('屠龙剑(20) 打 普通生物', effect(20, dragonBane, fowl));  // 生物 -100% → 0, 专精免疫
show('屠龙剑(20) 打 龙', effect(20, dragonBane, dragon));      // -100%+200% → ×2 = 40
show('治疗杖(10) 对 生物', effect(10, healWand, fowl));        // -150% → -5, 负=奶
