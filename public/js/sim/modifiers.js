// id-tag modifier packs = the DATA tier/克制 system (§3.2). A weapon or tool is just a
// {tag,val}[] pack fed to the EffectResolver: effect = base × (1 + Σ matching mods).
//
// 等级不是代码,是一组数据:木剑对越高阶减伤越多,对钻阶几乎砍不动;木铲更弱,对钻阶
// 总和 < −100% ⇒ 负伤害 = 回血(被按摩)。换一把武器 = 换一个数据包,零代码改动。
// 这些 tag 走前缀匹配,所以 '阶.钻' 命中任何 '阶.钻' 标签的对象——包括变身成龙的玩家。

// `tags` = the weapon's OWN id-tags (damage type / material) — these are the ATTACKER tags the
// defender's defense pack (combat.def) matches against (two-sided resolve). `use` cites a named
// 等级 doc (KITS) instead of re-listing its 减伤表 (iron_sword 召唤 @铁级).
export const WEAPONS = {
  fist:          { key: 'fist',          name: '空手', base: 2,  tags: ['元素.物理'], mods: [] },
  wood_sword:    { key: 'wood_sword',    name: '木剑', base: 10, tags: ['武器.剑', '元素.物理'],
    mods: [{ tag: '阶.石', val: -0.5 }, { tag: '阶.铁', val: -0.75 }, { tag: '阶.金', val: -0.9 }, { tag: '阶.钻', val: -0.95 }] },
  wood_shovel:   { key: 'wood_shovel',   name: '木铲', base: 6, tags: ['武器.铲', '元素.物理'],   // 对钻阶变负 = 按摩回血
    mods: [{ tag: '阶.石', val: -0.6 }, { tag: '阶.铁', val: -0.9 }, { tag: '阶.金', val: -1.2 }, { tag: '阶.钻', val: -1.5 }] },
  iron_sword:    { key: 'iron_sword',    name: '铁剑', base: 18, tags: ['武器.剑', '元素.物理'],
    use: ['@铁级'] },   // = 召唤铁级文档(对金-50%/钻-80%),零内联表
  diamond_sword: { key: 'diamond_sword', name: '钻剑', base: 30, tags: ['武器.剑', '元素.物理'], mods: [] },
};

export const WEAPON_KEYS = Object.keys(WEAPONS);
