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
  { protoId: 4, key: 'dragon',     tags: ['生物.龙', '阶.钻'], tier: 4, hp: 200, name: '巨龙',
    behavior: { packs: ['skittish_flee'] }, combat: { atk: 12, def: 8 } },

  // —— NEW creatures added as PURE DATA (generality test: distinct behaviour from data,
  //    zero kernel change). They reference packs by code too. ——
  { protoId: 5, key: 'rabbit', tags: ['生物.兔', '阶.木'], tier: 0, hp: 5, name: '兔子',
    behavior: { packs: ['jumpy_flee'] }, combat: { atk: 0, def: 0 } },   // fast + very skittish
  { protoId: 6, key: 'golem',  tags: ['生物.石像', '阶.铁'], tier: 2, hp: 40, name: '石像',
    behavior: { packs: ['fearless'] }, combat: { atk: 6, def: 6 } },      // slow, ignores the player
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
