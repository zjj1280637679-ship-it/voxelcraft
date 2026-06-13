// Read-only prototype registry. LOCKED essence lives here; a Definition only refs
// it by protoId (invariant: no Presentation/Tune key can write these). Ordered
// array, protoId = index, never reused. Folded into REGISTRY_HASH.
//
// tags = id hierarchy paths (dotted). EffectResolver prefix-matches against these.
// (slice uses readable strings; production interns them to small int handles.)

export const PROTOTYPES = [
  // —— blocks (HP = toughness; tier + material tags drive interaction) ——
  { protoId: 0, key: 'stone',         kind: 'block',    tier: 1, tags: ['方块.石',      '阶.石'], toughness: 5,  maxHp: 5  },
  { protoId: 1, key: 'gold_block',    kind: 'block',    tier: 3, tags: ['方块.金属.金', '阶.金'], toughness: 10, maxHp: 10 },
  { protoId: 2, key: 'diamond_block', kind: 'block',    tier: 4, tags: ['方块.钻',      '阶.钻'], toughness: 14, maxHp: 14 },

  // —— creatures (block = creature with behaviour facet off; same substrate) ——
  { protoId: 3, key: 'fowl_small',    kind: 'creature', tier: 0, role: 'prey', tags: ['生物.禽', '阶.木'],
    maxHp: 8,   baseAtk: 0,  baseDef: 0, allow: { actionPacks: [0] } },
  { protoId: 4, key: 'dragon',        kind: 'creature', tier: 4, role: 'boss', tags: ['生物.龙', '阶.钻'],
    maxHp: 200, baseAtk: 12, baseDef: 8, allow: { actionPacks: [0] } },
];

export const PROTO_COUNT = PROTOTYPES.length;
