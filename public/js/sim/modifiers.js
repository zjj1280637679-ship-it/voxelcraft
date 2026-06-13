// id-tag modifier packs = the DATA tier/克制 system (§3.2). A weapon or tool is just a
// {tag,val}[] pack fed to the EffectResolver: effect = base × (1 + Σ matching mods).
//
// 等级不是代码,是一组数据:木剑对越高阶减伤越多,对钻阶几乎砍不动;木铲更弱,对钻阶
// 总和 < −100% ⇒ 负伤害 = 回血(被按摩)。换一把武器 = 换一个数据包,零代码改动。
// 这些 tag 走前缀匹配,所以 '阶.钻' 命中任何 '阶.钻' 标签的对象——包括变身成龙的玩家。

export const WEAPONS = {
  fist:          { key: 'fist',          name: '空手', base: 2,  mods: [] },
  wood_sword:    { key: 'wood_sword',    name: '木剑', base: 10,
    mods: [{ tag: '阶.石', val: -0.5 }, { tag: '阶.铁', val: -0.75 }, { tag: '阶.金', val: -0.9 }, { tag: '阶.钻', val: -0.95 }] },
  wood_shovel:   { key: 'wood_shovel',   name: '木铲', base: 6,   // 更弱的挖掘工具:对钻阶变负 = 按摩回血
    mods: [{ tag: '阶.石', val: -0.6 }, { tag: '阶.铁', val: -0.9 }, { tag: '阶.金', val: -1.2 }, { tag: '阶.钻', val: -1.5 }] },
  iron_sword:    { key: 'iron_sword',    name: '铁剑', base: 18,
    mods: [{ tag: '阶.金', val: -0.5 }, { tag: '阶.钻', val: -0.8 }] },
  diamond_sword: { key: 'diamond_sword', name: '钻剑', base: 30,  mods: [] },
};

export const WEAPON_KEYS = Object.keys(WEAPONS);
