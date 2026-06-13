// Locked-essence registry = the read-only "preset packs" (快捷设定包 / exemplars).
// NOT deleted — it's the forge-proof backbone (§1.3.1): locked tokens players can't
// write, folded into REGISTRY_HASH. A Definition only refs an entry by protoId.
//
// ★ ONE uniform shape for every object (§0.7 万物皆对象). A capability slot ABSENT =
//   that capability dormant — NOT a different type. A "block" = an entry with the
//   behavior/combat slots absent; a "creature" = the SAME shape with them filled.
//   `kind` is NOT stored and NEVER branched on — it is derived (kindOf) for UI/logs
//   only; the kernel dispatches on has(slot)/prim, never on a kind string.
//
// tags = id hierarchy paths (生物.龙 / 方块.金属.金 / 阶.钻). EffectResolver prefix-
// matches these. tier (number) is kept for the load-time monotonicity assertion; the
// 阶.* tag mirrors it for affinity matching.

export const PROTOTYPES = [
  // —— behavior/combat slots ABSENT ⇒ dormant ⇒ "block" (derived). Same shape, fewer slots filled.
  { protoId: 0, key: 'stone',         tags: ['方块.石',      '阶.石'], tier: 1, hp: 5  },
  { protoId: 1, key: 'gold_block',    tags: ['方块.金属.金', '阶.金'], tier: 3, hp: 10 },
  { protoId: 2, key: 'diamond_block', tags: ['方块.钻',      '阶.钻'], tier: 4, hp: 14 },

  // —— SAME shape + behavior/combat slots FILLED ⇒ "creature" (derived). No new type.
  { protoId: 3, key: 'fowl_small',    tags: ['生物.禽', '阶.木'], tier: 0, hp: 8,
    behavior: { packs: [0] }, combat: { atk: 0, def: 0 } },
  { protoId: 4, key: 'dragon',        tags: ['生物.龙', '阶.钻'], tier: 4, hp: 200,
    behavior: { packs: [0] }, combat: { atk: 12, def: 8 } },
];

export const PROTO_COUNT = PROTOTYPES.length;

// Derived label — UI / logging / coarse scheduling ONLY. The kernel must never
// switch on this; it dispatches on has(behavior) / prim (§0.7 review red line).
export function kindOf(p) {
  if (p.behavior) return 'creature';
  return p.tags.some((t) => t.startsWith('方块')) ? 'block' : 'object';
}

// Capability probes — this is how the kernel decides, not via kind.
export const canAct = (p) => !!p.behavior;      // has behavior facet ⇒ ticks/acts ⇒ lives as an Instance
export const canFight = (p) => !!p.combat;       // has combat facet ⇒ has atk/def tokens
