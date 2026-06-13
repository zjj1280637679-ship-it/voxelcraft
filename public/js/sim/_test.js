// Headless proof: pure kernel + EffectResolver run, are deterministic, and the engine
// GENERALISES — new creatures/behaviours are pure DATA (registry entries referenced by
// string code), zero kernel change.   node public/js/sim/_test.js

import { makeState, makeEntity, reduce } from './kernel.js';
import { effect } from './effect.js';
import { REGISTRY_HASH } from './registry-hash.js';
import { protoByKey } from './prototypes.js';
import { WEAPONS } from './modifiers.js';
import { bearing } from './perceive.js';

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

// ---- 4. 变身术: the player resolves through the SAME registry — who you ARE decides
//        what a weapon does TO you. Same weapon, swap your form, opposite outcome. ----
console.log('\n=== 4. 变身术: 同一把武器,玩家换形态 → 数据决定结果(player 与 dragon 同走 protoByKey)===');
const uid = '玩家.zz';
const asHuman  = protoByKey('player').tags.concat([uid]);   // 生物.人, 阶.木, 玩家.zz
const asDragon = protoByKey('dragon').tags.concat([uid]);   // 生物.龙, 阶.钻, 玩家.zz
const hit = (label, w, tags) => {
  const v = effect(w.base, w.mods, tags);
  console.log('  ' + label.padEnd(30) + ' = ' + v.toFixed(1).padStart(6)
    + '  → ' + (v > 0 ? '伤害' : v < 0 ? '回血(被按摩)' : '免疫'));
};
hit('木剑 打 你(人形/阶.木)',   WEAPONS.wood_sword,  asHuman);   // 10 (no match)
hit('木剑 打 你(龙形/阶.钻)',   WEAPONS.wood_sword,  asDragon);  // 0.5 chip
hit('木铲 打 你(人形/阶.木)',   WEAPONS.wood_shovel, asHuman);   // 6
hit('木铲 打 你(龙形/阶.钻)',   WEAPONS.wood_shovel, asDragon);  // -3 回血(按摩)
// player-bane: a +50% vs the uid tag follows you THROUGH 变身 (用代号防同义字乌龙)
const baneSword = { base: 10, mods: [{ tag: uid, val: 0.5 }] };
hit('学过你的剑 打 你(人形)',   baneSword, asHuman);             // 15
hit('学过你的剑 打 你(龙形)',   baneSword, asDragon);            // 15 — 变身甩不掉"你是你"
const dragonNoUid = protoByKey('dragon').tags;                   // a wild dragon (no uid)
hit('学过你的剑 打 野生龙(无uid)', baneSword, dragonNoUid);       // 10 — only YOU are baned

// ---- 5. perception bearing: trig-free 8-way compass from a (dx,dz) offset ----
console.log('\n=== 5. 感知器测向(trig-free 8 向罗盘, 北=−z 东=+x)===');
const bcheck = [[0, -5, 'N'], [5, 0, 'E'], [0, 5, 'S'], [-5, 0, 'W'], [4, -4, 'NE'], [-4, 4, 'SW']];
let bpass = true;
for (const [dx, dz, want] of bcheck) {
  const got = bearing(dx, dz); if (got !== want) bpass = false;
  console.log(`  (dx=${dx},dz=${dz}) → ${got}  ${got === want ? '✓' : '✗ 期望' + want}`);
}
console.log('  测向: ' + (bpass ? 'PASS' : 'FAIL'));

// ---- 6. 龙的设计: 投射物 lifetime 自销(launch+ttl) + 喷火伤害(同一 EffectResolver)----
console.log('\n=== 6. 龙: 火投射物 ttl 自销 + 喷火走 EffectResolver ===');
const fst = makeState();
fst.ents.set(1, makeEntity(1, 'fire', 'fire_breath', 0, 51, 0, 7)); // ttl=8 ticks
const sizes = [];
for (let f = 0; f < 10; f++) { reduce(fst, { players: [] }, 0.1, { out: [] }); sizes.push(fst.ents.size); }
const reaped = fst.ents.size === 0;
console.log(`  火投射物每 tick 存活数 ${JSON.stringify(sizes)} → 寿终自销: ${reaped ? 'PASS' : 'FAIL'}`);
const F = protoByKey('dragon').fire;
const fireOn = (label, tags) => {
  const v = effect(F.base, F.mods, tags);
  console.log('  ' + label.padEnd(22) + ' = ' + v.toFixed(1).padStart(6) + '  → ' + (v > 0 ? '烧伤' : v < 0 ? '回血' : '免疫'));
};
fireOn('龙息 喷 石像(生物.石像)', protoByKey('golem').tags);   // 14 full
fireOn('龙息 喷 兔子(生物.兔)',   protoByKey('rabbit').tags);  // 14 → one-shot hp5
fireOn('龙息 喷 龙(生物.龙)',     protoByKey('dragon').tags);  // 14×(1-0.9)=1.4 近免疫
fireOn('龙息 喷 钻石块(方块.钻)', protoByKey('diamond_block').tags); // 14×0.5=7
fireOn('龙息 喷 火(元素.火)',     protoByKey('fire').tags);    // 14×(1-2)=-14 回血
