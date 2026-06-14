// Named, referenceable DATA docs the EffectResolver expands. Pure frozen data, addressed by an
// opaque '@code' (master-law signifier: content writes the ref, the resolver flattens it).
//
//   SETS — cross-cutting tag UNIONS. A condition tag '@name' matches ANY tag in the set
//          (use this only for non-prefix unions; natural subtrees are free via the hierarchy).
//   KITS — condition packs = "等级 / 附魔 / 技能 文档". A pack's `use:['@code']` flattens these
//          in (bounded depth + cycle-guarded). Balance lives HERE; objects just cite by code.

export const SETS = {
  '@物理武器': ['武器.剑', '武器.斧', '武器.矛', '武器.锤', '武器.匕首'],
};

export const KITS = {
  // 铁级武器:对越高阶的目标减伤越多(对金-50%、对钻-80%)。一份"可召唤文档",铁武器 use 它即可。
  '@铁级': { mods: [{ tag: '阶.金', val: -0.5 }, { tag: '阶.钻', val: -0.8 }] },
  '@木级': { mods: [{ tag: '阶.石', val: -0.5 }, { tag: '阶.铁', val: -0.75 }, { tag: '阶.金', val: -0.9 }, { tag: '阶.钻', val: -0.95 }] },
};
