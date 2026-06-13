// Action packs = DATA, not code. Each state names a kernel PRIM + pure params;
// transitions fire on a fixed `when` vocabulary. The kernel runs the prim — packs
// can only recombine the fixed prim set, never introduce new behaviour code.
// packId = array index (stable). Folded into REGISTRY_HASH.

export const ACTION_PACKS = [
  {
    packId: 0,
    key: 'skittish_flee',
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
];
