// Locked-essence registry = read-only "preset packs" (exemplars). Forge-proof
// backbone (§1.3.1), folded into REGISTRY_HASH. ONE uniform shape per object
// (§0.7 万物皆对象): an absent capability slot = that capability dormant, NOT a
// different type. `kind` is derived (kindOf), never branched on.
//
// ★ Each object is referenced by an OPAQUE STRING CODE (`key`) — a non-linguistic,
//   engine-uninterpreted identifier, robust + position-independent (NOT a magic int
//   index, NOT the player-facing display name). Everything (spawn / worldgen / edges)
//   references this code; model/attrs/tags/display-name/notes all BIND to it. The
//   engine only ever holds codes; rebinding or mis-referencing a code = a data edit.

export const PROTOTYPES = [
  // —— behavior/combat absent ⇒ "block" (derived). ——
  { protoId: 0, key: 'stone',         tags: ['方块.石',      '阶.石'], tier: 1, hp: 5,  name: '石头' },
  { protoId: 1, key: 'gold_block',    tags: ['方块.金属.金', '阶.金'], tier: 3, hp: 10, name: '金块' },
  { protoId: 2, key: 'diamond_block', tags: ['方块.钻',      '阶.钻'], tier: 4, hp: 14, name: '钻石块' },

  // —— behavior/combat filled ⇒ "creature" (derived). Same shape, no new type. ——
  { protoId: 3, key: 'fowl_small', tags: ['生物.禽', '阶.木'], tier: 0, hp: 8, name: '小鸡',
    behavior: { packs: ['skittish_flee'] }, combat: { atk: 0, def: 0 } },
  // 巨龙:会飞(fly 分面 → 玩家变身后启用飞行,不再受重力)+ 会喷火(fire = 一个
  //   id标签修正数据包,喂同一 EffectResolver:对龙近乎免疫、对火元素回血、对方块减半)。
  // combat.def REVIVED (was dead scalar): now a defender condition pack — conditions vs the
  //   ATTACKER's tags (two-sided resolve). 龙鳞:对物理攻击 −30%(对火/魔法不减)。
  { protoId: 4, key: 'dragon',     tags: ['生物.龙', '阶.钻'], tier: 4, hp: 200, name: '巨龙',
    behavior: { packs: ['fearless'] }, combat: { atk: 12, def: [{ tag: '元素.物理', val: -0.3 }] },
    fly: true,
    fire: { base: 14, mods: [{ tag: '方块', val: -0.5 }, { tag: '生物.龙', val: -0.9 }, { tag: '元素.火', val: -2.0 }] } },

  // —— NEW creatures added as PURE DATA (generality test: distinct behaviour from data,
  //    zero kernel change). They reference packs by code too. ——
  { protoId: 5, key: 'rabbit', tags: ['生物.兔', '阶.木'], tier: 0, hp: 5, name: '兔子',
    behavior: { packs: ['jumpy_flee'] }, combat: { atk: 0, def: 0 } },   // fast + very skittish
  { protoId: 6, key: 'golem',  tags: ['生物.石像', '阶.铁'], tier: 2, hp: 40, name: '石像',
    behavior: { packs: ['fearless'] }, combat: { atk: 6, def: [{ tag: '元素.物理', val: -0.5 }] } }, // 石躯:抗物理 −50%

  // —— the PLAYER is the SAME substrate (§0.7 万物皆对象): an object whose behavior
  //    facet is replaced by INPUT-CONTROL (the shell drives it; the kernel never ticks
  //    it). Its combat + tags resolve through THIS registry exactly like a dragon's ⇒
  //    变身术 = rebinding which prototype the player's identity-core points at. No
  //    player-specific code path — the boss and the player are one shape, differing by
  //    which row of this table they bind to.
  { protoId: 7, key: 'player', tags: ['生物.人', '阶.木'], tier: 0, hp: 20, name: '玩家',
    combat: { atk: 1, def: 0 } },

  // —— items are objects too. 变龙苹果:一个食物对象,"使用"分面 = 对使用者施加一次
  //    变身 effect(form: dragon)。useItem 解析器读 `use` 数据,无苹果专用代码。
  { protoId: 8, key: 'dragon_apple', tags: ['物品.食物', '物品.魔法'], tier: 0, hp: 1, name: '变龙苹果',
    use: { kind: 'transform', form: 'dragon' } },

  // —— 火:龙喷出的投射物对象(会动的"火方块")。launch 行为包让它直飞+到寿命自销;
  //    fly 分面让它在空中(按 e.y)渲染。伤害由喷火者的攻击器(EffectResolver)产生。
  { protoId: 9, key: 'fire', tags: ['元素.火', '方块.火'], tier: 0, hp: 1, name: '火', fly: true },
];

export const PROTO_COUNT = PROTOTYPES.length;

// code → prototype. The single resolver; everything references the string code.
export const PROTO_BY_KEY = new Map(PROTOTYPES.map((p) => [p.key, p]));
export function protoByKey(key) {
  const p = PROTO_BY_KEY.get(key);
  if (!p) throw new Error('unknown proto code: ' + key); // §3.7 隔: caller isolates
  return p;
}

// Derived label — UI / logging ONLY. Kernel dispatches on has(behavior)/prim, never kind.
export function kindOf(p) {
  if (p.behavior) return 'creature';
  return p.tags.some((t) => t.startsWith('方块')) ? 'block' : 'object';
}
export const canAct = (p) => !!p.behavior;   // has behavior facet ⇒ ticks/acts ⇒ Instance
export const canFight = (p) => !!p.combat;
