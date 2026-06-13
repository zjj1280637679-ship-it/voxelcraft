// Action packs = DATA, not code. Each state names a kernel PRIM + pure params;
// transitions fire on a fixed `when` vocabulary. The kernel runs the prim — packs
// only recombine the fixed prim set, never add behaviour code. Referenced by string
// CODE (`key`). Folded into REGISTRY_HASH.

export const ACTION_PACKS = [
  {
    packId: 0, key: 'skittish_flee',
    states: [
      { id: 0, name: 'idle', prim: 'wander', speed: 1.2, sense: 6 },
      { id: 1, name: 'flee', prim: 'flee',   speed: 3.5, sense: 6 },
    ],
    transitions: [
      { from: 0, to: 1, when: 'playerNear' },
      { from: 1, to: 0, when: 'playerFar'  },
    ],
    budget: { aggression: 0, mobility: 3, sense: 6, complexity: 2 },
  },
  // —— NEW packs (pure data): generality = new behaviour with ZERO kernel change ——
  {
    packId: 1, key: 'jumpy_flee',   // faster, twitchier, longer sight
    states: [
      { id: 0, name: 'idle', prim: 'wander', speed: 2.2, sense: 9 },
      { id: 1, name: 'flee', prim: 'flee',   speed: 5.5, sense: 9 },
    ],
    transitions: [
      { from: 0, to: 1, when: 'playerNear' },
      { from: 1, to: 0, when: 'playerFar'  },
    ],
    budget: { aggression: 0, mobility: 5, sense: 9, complexity: 2 },
  },
  {
    packId: 2, key: 'fearless',     // only wanders — no flee state, ignores the player
    states: [
      { id: 0, name: 'idle', prim: 'wander', speed: 1.4, sense: 0 },
    ],
    transitions: [],
    budget: { aggression: 0, mobility: 2, sense: 0, complexity: 1 },
  },
  {
    packId: 3, key: 'hop_in_place', // 原地小范围蹦跳: holds anchor + vertical bob
    states: [
      { id: 0, name: 'hop', prim: 'hop', speed: 1, sense: 0 },
    ],
    transitions: [],
    budget: { aggression: 0, mobility: 1, sense: 0, complexity: 1 },
  },
  {
    packId: 4, key: 'fire_breath',  // 投射物:沿 dir 直飞, ttl 帧后自销(瞬态对象 lifetime)
    states: [
      { id: 0, name: 'fly', prim: 'launch', speed: 9, sense: 0, ttl: 8 },
    ],
    transitions: [],
    budget: { aggression: 0, mobility: 9, sense: 0, complexity: 1 },
  },
];

export const PACK_BY_KEY = new Map(ACTION_PACKS.map((p) => [p.key, p]));
export function packByKey(key) {
  const p = PACK_BY_KEY.get(key);
  if (!p) throw new Error('unknown pack code: ' + key);
  return p;
}
