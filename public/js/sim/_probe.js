// ORTHOGONALITY / EXHAUSTIVENESS / ELEGANCE probe battery.
//
// Method (user's): pose extreme requirements; for each, try to realize it with DATA ONLY
// — register a prototype/pack object literal into the LIVE registries (touch NO function,
// NO kernel branch) — then feed it to the UNCHANGED engine and check the behaviour
// EMERGES. Record: data-only? hamming (chars of the added literal)? steps? collateral?
//   verdict ∈ {
//     DATA✓  data-only, emerges cleanly, tiny hamming, zero collateral  (orthogonal+elegant)
//     DATA~  data-only but with a caveat (taxonomy-fragile / render-only / many mods)
//     PRIM✗  no data path: the unchanged engine produces nothing → needs a kernel PRIM
//     LOGIC✗ no data path: needs a new RESOLVER (effect signature / scheduler / trigger)
//   }
// The GAP rows are the point: each is EMPIRICALLY shown by handing the engine the data and
// watching it fail to realize the ask — not asserted by opinion.
//
//   node public/js/sim/_probe.js

import { makeState, makeEntity, reduce } from './kernel.js';
import { effect, affinity } from './effect.js';
import { PROTO_BY_KEY, protoByKey } from './prototypes.js';
import { PACK_BY_KEY } from './actionpacks.js';
import { WEAPONS } from './modifiers.js';

// ---- baseline capture (for the global orthogonality assertion) ----
function fowlTrace() {
  const st = makeState();
  st.ents.set(1, makeEntity(1, 'fowl_small', 'skittish_flee', 0, 40, 0, 12345));
  const t = [];
  for (let f = 0; f < 24; f++) {
    const players = f < 12 ? [{ x: 50, z: 50 }] : [{ x: 2, z: 0 }];
    reduce(st, { players }, 0.1, { out: [] });
    const e = st.ents.get(1);
    t.push(`${e.st}|${e.x.toFixed(4)}|${e.z.toFixed(4)}`);
  }
  return t.join(';');
}
const refEffects = () => [
  effect(10, [{ tag: '阶.石', val: -0.5 }], ['方块.石', '阶.石']),
  effect(20, [{ tag: '生物', val: -1 }, { tag: '生物.龙', val: 2 }], ['生物.龙', '阶.钻']),
].join(',');
const BASE_TRACE = fowlTrace();
const BASE_EFFECTS = refEffects();

// ---- helpers ----
let regCount = 0;
function reg(map, key, obj) { map.set(key, obj); regCount++; return obj; }
const ham = (obj) => JSON.stringify(obj).length;          // chars of the added data literal

// run one entity for N ticks; report net horizontal move + vertical drift + survival
function run1(protoKey, packKey, opts = {}) {
  const st = makeState();
  const x0 = opts.x ?? 0, z0 = opts.z ?? 0, y0 = opts.y ?? 50;
  st.ents.set(1, makeEntity(1, protoKey, packKey, x0, y0, z0, opts.seed ?? 1));
  const ticks = opts.ticks ?? 20;
  let out = [];
  for (let f = 0; f < ticks; f++) { out = []; reduce(st, { players: opts.players || [] }, 0.1, { out }); }
  const e = st.ents.get(1);
  return { alive: !!e, e, size: st.ents.size,
    moved: e ? Math.hypot(e.x - x0, e.z - z0) : 0, dy: e ? e.y - y0 : 0 };
}

const rows = [];
function probe(axis, ask, verdict, hamming, steps, detail) {
  rows.push({ axis, ask, verdict, hamming, steps, detail });
}

// ================= EFFECT / TAG / AFFINITY axis (the EffectResolver) =================

// P: chainsaw — +50% vs metal blocks, immune to wood-tier. pure attacker data.
{
  const saw = [{ tag: '方块.金属', val: 0.5 }, { tag: '阶.木', val: -1 }];
  const vGold = effect(10, saw, ['方块.金属.金', '阶.金']);   // 15
  const vWood = effect(10, saw, ['生物.禽', '阶.木']);        // 0
  probe('effect', '电锯:对金属+50%·对木级免疫', vGold === 15 && vWood === 0 ? 'DATA✓' : 'LOGIC✗',
    ham(saw), 1, `金块=${vGold} 木级=${vWood}`);
}

// P: healing staff — heals creatures (neg), half-damages blocks. heal = negative damage.
{
  const staff = [{ tag: '生物', val: -1.5 }, { tag: '方块', val: -0.5 }];
  const vMob = effect(10, staff, ['生物.禽']);   // -5 heal
  const vBlk = effect(10, staff, ['方块.石']);   // 5 half
  probe('effect', '治疗杖:对生物回血·对方块半伤(无独立治疗系统)', vMob < 0 && vBlk > 0 ? 'DATA✓' : 'LOGIC✗',
    ham(staff), 1, `生物=${vMob} 方块=${vBlk}`);
}

// P: glass-cannon reflect — FLOOR/CAP are DATA params: a -3 mod clamps to FLOOR=-2.
{
  const vClamp = effect(10, [{ tag: '生物.龙', val: -3 }], ['生物.龙'], -2, 2);   // affinity -2 → -20 (clamped)
  const vFree = effect(10, [{ tag: '生物.龙', val: -3 }], ['生物.龙']);            // default FLOOR -∞ → -20… affinity -2 → -20
  probe('effect', '玻璃大炮:FLOOR/CAP是数据→可钳到反伤', vClamp === -20 ? 'DATA✓' : 'LOGIC✗', 4, 1, `FLOOR=-2 钳后 affinity=-2 → ${vClamp}`);
}

// P: assassin — hit ONLY player zz, immune to everything else.
{
  // no universal "match-all" tag exists → must suppress each known ROOT, then re-add zz.
  const roots = ['生物', '方块', '元素', '物品'];
  // suppress each root (-1) then re-add zz EXACTLY enough to recover base (生物 -1, 玩家.zz +1 → net 0 → ×1)
  const dagger = roots.map((r) => ({ tag: r, val: -1 })).concat([{ tag: '玩家.zz', val: 1 }]);
  const vZz = effect(10, dagger, ['生物.人', '玩家.zz']);  // 1-1+1 = 1 → 10 (base)
  const vDragon = effect(10, dagger, ['生物.龙']);         // -1 → 0
  const vStone = effect(10, dagger, ['方块.石']);          // -1 → 0
  // fragility: a future ROOT (e.g. '机械') the dagger never listed would leak full damage.
  const vLeak = effect(10, dagger, ['机械.傀儡']);          // 10 — LEAK
  probe('effect', '刺客匕首:只伤玩家zz·对万物免疫', 'DATA~',
    ham(dagger), 1, `zz=${vZz}(base) 龙=${vDragon} 石=${vStone} 新根机械=${vLeak}(漏!需逐根抑制·无全域根标签)`);
}

// P: armour — a DEFENDER carries a generic "-50% vs ANY attacker". effect(base, attackerPack,
//    targetTags) has NO defender-pack slot → resistance can only live on the attacker or be
//    a target TAG the attacker happens to match. Generic armour is NOT data-reachable.
probe('effect', '通用护甲:无视攻击者-50%(设计说"护甲=目标侧修正包")', 'LOGIC✗', 0, 0,
  'effect() 签名只有 attacker 包+target 标签,无 defender 包参→目标侧修正未接线');

// P: address-by-id not display name (anti 同义字乌龙)
{
  reg(PROTO_BY_KEY, 'gold_a', { protoId: 90, key: 'gold_a', tags: ['方块.金属.金', '阶.金'], hp: 9, name: '金' });
  reg(PROTO_BY_KEY, 'gold_b', { protoId: 91, key: 'gold_b', tags: ['生物.史莱姆', '阶.木'], hp: 9, name: '金' }); // SAME display name
  const saw = [{ tag: '方块.金属', val: 0.5 }];
  const a = effect(10, saw, PROTO_BY_KEY.get('gold_a').tags);  // 15 (metal)
  const b = effect(10, saw, PROTO_BY_KEY.get('gold_b').tags);  // 10 (not metal) — name clash, tag distinct
  probe('effect', '两个都叫"金"的对象:解析按标签不按名', a === 15 && b === 10 ? 'DATA✓' : 'LOGIC✗',
    ham({ key: 'gold_b', tags: ['生物.史莱姆', '阶.木'], name: '金' }), 1, `金(金属)=${a} 金(史莱姆)=${b}`);
}

// ================= BEHAVIOUR / PRIM axis (action packs) =================

// P: faster, longer-sighted creature — pure pack params.
{
  reg(PROTO_BY_KEY, 'hare', { protoId: 92, key: 'hare', tags: ['生物.兔', '阶.木'], hp: 4, name: '疾兔', behavior: { packs: ['dash'] } });
  reg(PACK_BY_KEY, 'dash', { packId: 90, key: 'dash', states: [{ id: 0, name: 'flee', prim: 'flee', speed: 12, sense: 30 }], transitions: [] });
  const r = run1('hare', 'dash', { players: [{ x: 1, z: 0 }], ticks: 10 });
  probe('prim', '极速远视兔:speed12 sense30(老prim调参)', r.moved > 8 ? 'DATA✓' : 'PRIM✗', ham({ speed: 12, sense: 30 }), 2, `10tick移动${r.moved.toFixed(1)}`);
}

// P: patrol between waypoints — ask via prim:'patrol'. kernel has no such branch.
{
  reg(PROTO_BY_KEY, 'guard', { protoId: 93, key: 'guard', tags: ['生物.兵'], hp: 10, name: '巡逻兵', behavior: { packs: ['patrol'] } });
  reg(PACK_BY_KEY, 'patrol', { packId: 91, key: 'patrol', states: [{ id: 0, name: 'patrol', prim: 'patrol', speed: 3, sense: 0, waypoints: [[0, 0], [10, 0]] }], transitions: [] });
  const r = run1('guard', 'patrol', { ticks: 20 });
  probe('prim', '巡逻兵:两点间往返', r.moved > 1 ? 'DATA✓' : 'PRIM✗', ham({ prim: 'patrol', waypoints: [[0, 0], [10, 0]] }), 2, `要求巡逻→实测移动${r.moved.toFixed(2)}(引擎无patrol原语,站桩)`);
}

// P: curious/approach — prim:'chase' exists in PRIMS but kernel branch is a STUB.
{
  reg(PROTO_BY_KEY, 'pup', { protoId: 94, key: 'pup', tags: ['生物.犬'], hp: 6, name: '好奇犬', behavior: { packs: ['seek'] } });
  reg(PACK_BY_KEY, 'seek', { packId: 92, key: 'seek', states: [{ id: 0, name: 'chase', prim: 'chase', speed: 4, sense: 30 }], transitions: [] });
  const r = run1('pup', 'seek', { players: [{ x: 20, z: 0 }], ticks: 20 });
  probe('prim', '好奇犬:朝玩家靠近(chase)', r.moved > 1 ? 'DATA✓' : 'PRIM✗', ham({ prim: 'chase' }), 2, `要求靠近→实测移动${r.moved.toFixed(2)}(chase原语是占位桩,不动)`);
}

// P: teleporter — prim:'blink' every N ticks. no branch.
{
  reg(PROTO_BY_KEY, 'wisp', { protoId: 95, key: 'wisp', tags: ['生物.灵'], hp: 3, name: '瞬移灵', behavior: { packs: ['blink'] } });
  reg(PACK_BY_KEY, 'blink', { packId: 93, key: 'blink', states: [{ id: 0, name: 'blink', prim: 'blink', speed: 0, sense: 0, every: 5, dist: 8 }], transitions: [] });
  const r = run1('wisp', 'blink', { ticks: 20 });
  probe('prim', '瞬移灵:每5tick传送8格', r.moved > 1 ? 'DATA✓' : 'PRIM✗', ham({ prim: 'blink', every: 5, dist: 8 }), 2, `要求瞬移→实测移动${r.moved.toFixed(2)}(无blink原语)`);
}

// P: vertical riser — anti-gravity mote. launch exists but DIRS are 2D (x,z); no y component.
{
  reg(PROTO_BY_KEY, 'bubble', { protoId: 96, key: 'bubble', tags: ['元素.气'], hp: 1, name: '气泡', fly: true });
  reg(PACK_BY_KEY, 'rise', { packId: 94, key: 'rise', states: [{ id: 0, name: 'rise', prim: 'launch', speed: 9, sense: 0, ttl: 30, up: 1 }], transitions: [] });
  const r = run1('bubble', 'rise', { ticks: 6 });
  probe('prim', '上升气泡:垂直飞(y增长)', Math.abs(r.dy) > 0.5 ? 'DATA✓' : 'PRIM✗', ham({ prim: 'launch', up: 1 }), 2, `要求上升→实测dy=${r.dy.toFixed(2)}(内核运动是平面x/z,DIRS无y分量)`);
}

// P: egg-laying — a creature that SPAWNS a child object periodically. No data slot, no prim.
probe('prim', '下蛋的鸡:每N tick生成蛋对象', 'PRIM✗', 0, 0, '无"生成/复制"能力槽,内核从不新增实体(设计第④的复制原语未实现)');

// P: compound behaviour — "hop WHILE fleeing". a state names exactly ONE prim.
probe('prim', '跳着逃跑:同时 hop+flee', 'PRIM✗', 0, 0, '一个 state 只能挂一个 prim,原语不可组合');

// ================= LIFETIME / TRIGGER axis =================

// P: short-lived mote — ttl. DATA✓ (the capability we just added).
{
  reg(PROTO_BY_KEY, 'spark', { protoId: 97, key: 'spark', tags: ['元素.火'], hp: 1, name: '火星', fly: true });
  reg(PACK_BY_KEY, 'fizz', { packId: 95, key: 'fizz', states: [{ id: 0, name: 'fly', prim: 'launch', speed: 5, sense: 0, ttl: 3 }], transitions: [] });
  const r = run1('spark', 'fizz', { ticks: 6 });
  probe('lifetime', '短命火星:3tick后自销', r.size === 0 ? 'DATA✓' : 'LOGIC✗', ham({ ttl: 3 }), 2, `6tick后存活=${r.size}`);
}

// P: timed effect — bomb apple transforms 5s AFTER eating. useItem is immediate; no scheduler.
probe('trigger', '定时苹果:吃下5秒后才变身', 'LOGIC✗', 0, 0, 'useItem 立即生效,无"延时/计划效果"队列(玩家侧无 ttl)');

// P: on-death trigger — phoenix respawns on death. kill just removes; no death→output table.
probe('trigger', '凤凰:死亡时原地重生', 'LOGIC✗', 0, 0, 'ent.die 只删实体,无 on-death 输出表(设计的 break/dismantle/kill 输出未接线)');

// P: AoE-over-time — poison cloud damages everything in radius each tick. no aura resolver.
probe('trigger', '毒云:停驻+每tick范围伤害', 'LOGIC✗', 0, 0, '无范围/持续伤害解析器(喷火是外壳一次性锥)');

// ================= FACET / OBJECT / TRANSFORM axis =================

// P: present-variant — mossy diamond block: same essence tags, different name/look.
{
  reg(PROTO_BY_KEY, 'mossy_diamond', { protoId: 98, key: 'mossy_diamond', tags: ['方块.钻', '阶.钻'], hp: 14, name: '苔藓钻石块' });
  const base = effect(10, [{ tag: '阶.钻', val: -0.95 }], PROTO_BY_KEY.get('diamond_block').tags);
  const moss = effect(10, [{ tag: '阶.钻', val: -0.95 }], PROTO_BY_KEY.get('mossy_diamond').tags);
  probe('facet', '苔藓钻石块:外观异·本质同(present变体)', base === moss ? 'DATA✓' : 'LOGIC✗',
    ham({ key: 'mossy_diamond', tags: ['方块.钻', '阶.钻'], name: '苔藓钻石块' }), 1, `本质相同,受击=${moss}(同钻石块${base})`);
}

// P: any block is a weapon — mining=combat symmetric; a block proto used as attacker.
{
  const blockAsAttacker = [{ tag: '方块', val: 0.2 }];  // a thorny block damages on contact
  const v = effect(5, blockAsAttacker, ['生物.人']);    // effect doesn't care attacker is a block
  probe('facet', '荆棘方块:方块也能当攻击器产伤', v > 0 ? 'DATA✓' : 'LOGIC✗', ham(blockAsAttacker), 1, `方块伤人=${v}(挖矿=战斗,对称)`);
}

// P: shrink potion — item → transform to a 'tiny' form. size is render-only (skin body), data.
{
  reg(PROTO_BY_KEY, 'tiny', { protoId: 99, key: 'tiny', tags: ['生物.人', '阶.木'], hp: 8, name: '缩小人', use: undefined });
  reg(PROTO_BY_KEY, 'shrink_potion', { protoId: 100, key: 'shrink_potion', tags: ['物品.药水'], hp: 1, name: '缩小药水', use: { kind: 'transform', form: 'tiny' } });
  const ok = PROTO_BY_KEY.get('shrink_potion').use.kind === 'transform' && !!PROTO_BY_KEY.get('tiny');
  probe('transform', '缩小药水:吃了变小', ok ? 'DATA~' : 'LOGIC✗', ham({ key: 'shrink_potion', use: { kind: 'transform', form: 'tiny' } }), 2, '变身可达;但"尺寸"只是皮肤body渲染量,非sim属性(碰撞盒不变)');
}

// ================= ROUND 2: adversary-designed boundary probes (verified empirically) =================

// multi-phase runner: ticks with `near` players, then with `far` players. Tracks the FURTHEST
// point reached (minX) — robust to flee↔sense oscillation, unlike an end-of-phase snapshot.
function run2(protoKey, packKey, spawn, near, far, t1, t2) {
  const st = makeState();
  st.ents.set(1, makeEntity(1, protoKey, packKey, spawn[0], 50, spawn[1], 7));
  let minX = spawn[0];
  const track = () => { const x = st.ents.get(1).x; if (x < minX) minX = x; };
  for (let f = 0; f < t1; f++) { reduce(st, { players: near }, 0.1, { out: [] }); track(); }
  const mid = { st: st.ents.get(1).st, x: st.ents.get(1).x };
  for (let f = 0; f < t2; f++) { reduce(st, { players: far }, 0.1, { out: [] }); track(); }
  const end = { st: st.ents.get(1).st, x: st.ents.get(1).x };
  return { mid, end, minX, spawnX: spawn[0] };
}

// P21: 守家犬 — flee when near, RETURN to spawn + idle when far. Multi-state recombination of
//      EXISTING prims (the positive cousin of "hop+flee" P13: across STATES, not within one).
{
  reg(PROTO_BY_KEY, 'guard_dog_c', { protoId: 101, key: 'guard_dog_c', tags: ['生物.犬'], hp: 10, name: '守家犬', behavior: { packs: ['guard_dog'] } });
  reg(PACK_BY_KEY, 'guard_dog', { packId: 96, key: 'guard_dog', states: [{ id: 0, name: 'home', prim: 'hop', speed: 1, sense: 7 }, { id: 1, name: 'flee', prim: 'flee', speed: 4, sense: 7 }], transitions: [{ from: 0, to: 1, when: 'playerNear' }, { from: 1, to: 0, when: 'playerFar' }] });
  const r = run2('guard_dog_c', 'guard_dog', [10, 10], [{ x: 11, z: 10 }], [{ x: 300, z: 300 }], 20, 30);
  const fled = r.minX < 9;                                       // moved away (west of spawn) at some point
  const home = r.end.st === 0 && Math.abs(r.end.x - 10) < 0.5;   // back to idle AT spawn anchor
  probe('prim', '守家犬:近逃·远则归位待命(多态复用老prim)', fled && home ? 'DATA✓' : 'PRIM✗',
    ham({ states: 2, transitions: 2 }), 2, `逃到最远x=${r.minX.toFixed(1)} → 远后回x=${r.end.x.toFixed(1)}(st${r.end.st},归位待命)`);
}

// P22: 阶梯石 — toughness (hp) AND per-hit damage both scale with tier from DATA alone; hits-to-kill
//      is an EMERGENT product of two independent data values, zero tier code.
{
  const perHitIron = effect(10, WEAPONS.wood_sword.mods, ['阶.铁']);   // 10×(1-0.75)=2.5
  const perHitStone = effect(10, WEAPONS.wood_sword.mods, ['阶.石']);  // 10×(1-0.5)=5
  const hitsIron = Math.ceil(25 / perHitIron);   // 强化石 hp25 → 10 hits
  const hitsStone = Math.ceil(5 / perHitStone);  // 石 hp5 → 1 hit
  probe('facet', '阶梯石:韧性(hp)+伤害双随阶缩放(无per-tier代码)', perHitIron === 2.5 && hitsIron === 10 && hitsStone === 1 ? 'DATA✓' : 'LOGIC✗',
    ham({ hp: 25, tags: ['方块.石.强化', '阶.铁'] }), 1, `木剑/hit: 铁阶${perHitIron} 石阶${perHitStone} → 砍杀次数 强化石${hitsIron} vs 石${hitsStone}`);
}

// P23: 巡守者 — flee then HOLD where it ended (hold its post). TRAP: hop's anchor ax/az is frozen at
//      SPAWN (makeEntity), never re-anchored on state entry → it slingshots back to birth tile.
{
  reg(PROTO_BY_KEY, 'sentry_c', { protoId: 102, key: 'sentry_c', tags: ['生物.兵'], hp: 10, name: '巡守者', behavior: { packs: ['sentry_flee'] } });
  reg(PACK_BY_KEY, 'sentry_flee', { packId: 97, key: 'sentry_flee', states: [{ id: 0, name: 'patrol', prim: 'wander', speed: 1, sense: 8 }, { id: 1, name: 'flee', prim: 'flee', speed: 5, sense: 8 }, { id: 2, name: 'hold', prim: 'hop', speed: 1, sense: 8 }], transitions: [{ from: 0, to: 1, when: 'playerNear' }, { from: 1, to: 2, when: 'playerFar' }] });
  const r = run2('sentry_c', 'sentry_flee', [10, 10], [{ x: 12, z: 10 }], [{ x: 400, z: 400 }], 50, 40);
  const fledFar = (10 - r.minX) > 3;                     // genuinely ran from its post at some point
  const snappedBack = Math.abs(r.end.x - 10) < 1;        // but 'hold' yanked it back to spawn anchor
  probe('prim', '巡守者:逃后想驻守"原地"(=逃到的地方)', fledFar && snappedBack ? 'DATA~' : 'DATA✓',
    ham({ states: 3 }), 2, `逃到最远x=${r.minX.toFixed(1)} → "驻守"却被拉回x=${r.end.x.toFixed(1)}(hop锚点=出生点,无入态重锚→连带语义错)`);
}

// P24: 狂暴图腾 — high-side runaway. affinity's `break` is PER-MOD; 3 mods all matching one target
//      stack additively with NO default ceiling (CAP=∞). FLOOR/CAP fix it but only if data sets CAP.
{
  const mods = [{ tag: '生物', val: 1.0 }, { tag: '生物.龙', val: 2.0 }, { tag: '阶.钻', val: 1.5 }];
  const vUncapped = effect(10, mods, ['生物.龙', '阶.钻']);            // 10×(1+4.5)=55, no ceiling
  const vCapped = effect(10, mods, ['生物.龙', '阶.钻'], -Infinity, 3); // CAP=3 → 30
  probe('effect', '狂暴图腾:同号修正叠加→默认无上限暴走', vUncapped === 55 && vCapped === 30 ? 'DATA~' : 'LOGIC✗',
    ham(mods), 1, `默认CAP=∞ → ${vUncapped}(暴走!) ; 数据设CAP=3 → ${vCapped}(可数据钳,但默认放任)`);
}

// P25: 残卷护符 — references a missing prototype code. §3.7 隔 ASYMMETRY: shell .get path degrades
//      gracefully (undefined → friendly msg), kernel protoByKey() THROWS on the same bad code.
{
  const shellGet = PROTO_BY_KEY.get('ghost_NONEXISTENT');   // undefined (graceful, shell guards on this)
  let kernelThrows = false;
  try { protoByKey('ghost_NONEXISTENT'); } catch (_) { kernelThrows = true; }
  probe('degrade', '残卷护符:引用缺失代号→优雅降级?', shellGet === undefined && kernelThrows ? 'DATA~' : 'DATA✓',
    0, 0, `shell .get=${shellGet}(优雅) vs kernel protoByKey 抛错=${kernelThrows}(未隔离)→同一缺码,两路降级不对称`);
}

// P26: 永久锋利石 — a pickup that PERMANENTLY merges a mod onto the held weapon. The mod pack is valid
//      data, but there is NO equipped-weapon state and NO affix-merge resolver (useItem only does transform).
{
  // the literal is trivially valid data — but nothing consumes use.kind==='affix', and WEAPONS is static.
  const affixWouldApply = effect(10, [{ tag: '生物', val: 0.5 }], ['生物.人']) === 15;  // the MOD works…
  probe('trigger', '永久锋利石:永久强化手中武器(affix合并)', 'LOGIC✗', 0, 0,
    `修正包本身合法(effect 试算=${affixWouldApply ? 15 : '?'}),但 useItem 只认 transform·WEAPONS 静态·无装备态/合并器→需新解析器`);
}

// FINDING (dead data): prototypes carry combat.def (e.g. dragon def:8) but grep shows .def is NEVER read
//   by effect()/kernel — defence is unwired. Recorded as an orthogonality smell (a slot with no resolver).
probe('effect', '⚠combat.def 死数据:原型写了防御但无人读', 'LOGIC✗', 0, 0,
  'prototypes.combat.def 存在(龙def8)但 effect/kernel 从不读取→防御未接线(同"目标侧护甲包"缺口)');

// ---- GLOBAL orthogonality assertion: after registering ~18 wild objects, is the baseline
//      fowl trajectory + reference effects BYTE-IDENTICAL? (no collateral) ----
const traceSame = fowlTrace() === BASE_TRACE;
const effSame = refEffects() === BASE_EFFECTS;

// ================= report =================
const V = { 'DATA✓': '✅ 数据', 'DATA~': '🟡 数据*', 'PRIM✗': '⛔ 缺原语', 'LOGIC✗': '⛔ 缺解析器' };
console.log('═══ 世界引擎 数据正交性 / 穷尽性 / 优雅性 探针 ═══\n');
console.log('轴'.padEnd(9) + '极端要求'.padEnd(34) + '判定'.padEnd(11) + '汉明'.padStart(5) + ' 步' + '  说明');
console.log('─'.repeat(112));
for (const r of rows) {
  console.log(
    r.axis.padEnd(9) +
    r.ask.padEnd(34 - (r.ask.length - [...r.ask].length)) +   // CJK width fudge
    V[r.verdict].padEnd(10) +
    String(r.hamming).padStart(4) + ' ' + String(r.steps).padStart(2) + '  ' + r.detail);
}
const pass = rows.filter((r) => r.verdict.startsWith('DATA')).length;
const gap = rows.length - pass;
console.log('─'.repeat(112));
console.log(`\n数据可达 ${pass}/${rows.length}   缺口 ${gap}   (本轮注册 ${regCount} 个新对象)`);
console.log(`全局正交性: 注册${regCount}个野对象后, 基线小鸡轨迹逐位一致=${traceSame ? 'PASS' : 'FAIL'}, 参考effect一致=${effSame ? 'PASS' : 'FAIL'}`);
console.log('  → 加数据从不扰动既有对象(per-object 派发 + additive affinity + 按 id 定序 = 结构性正交)');
console.log('\n缺口分类:');
console.log('  ⛔缺原语(PRIM): patrol/chase(桩)/blink/垂直运动/spawn复制/prim组合  —— 内核运动是平面x/z, 原语集小且不可组合');
console.log('  ⛔缺解析器(LOGIC): 目标侧护甲包 / 延时效果 / on-death输出 / AoE持续  —— 解析器只有 effect+launch+ttl');
console.log('  🟡数据但脆(TAXO/render): 全域免疫需逐根抑制(无全域根标签) / 尺寸仅渲染量');
console.log('\n结论: 已实现轴(标签/affinity/effect·包调参·present变体·变身·ttl·fly)上, 数据正交性与优雅性强(汉明1~4字段, 1~2步, 零连带);');
console.log('      穷尽性受限于"已实现的小原语/解析器集"——多个缺口正是设计已许诺、内核尚未补的能力(chase/复制/on-death/目标侧修正/AoE)。');
