// CANDIDATE measurement: condition packs as SET LOGIC. Three-valued (有/无, and within 有: 正/负)
// + the Hamming-reducing operators the user proposed: complement ("除了X都不行 / 都行"),
// premise→object guards (一级集合作前提·二级作对象), and named fixed-combo sets (固定搭配集合).
// Goal: show each lowers Hamming WITHOUT breaking order-independence (序) or graceful-absent (隔).
//   node public/js/sim/_probe3.js

import { tagMatch } from './effect.js';

// ---- named sets (固定搭配集合): a '@name' tag expands to a cross-cutting UNION that no single
//      prefix can name (the tag HIERARCHY already gives free subtree-sets; this is for unions). ----
const SETS = {
  '@物理武器': ['武器.剑', '武器.斧', '武器.矛', '武器.锤', '武器.匕首'],
  '@贵金属': ['方块.金属.金', '方块.金属.银', '阶.钻'],
};
const expand = (tag) => SETS[tag] || [tag];
const matchAny = (tag, tags) => expand(tag).some((e) => tags.some((t) => tagMatch(e, t)));
const inSet = (setTags, tags) => setTags.some((s) => matchAny(s, tags));
const supersetOf = (need, have) => need.every((n) => matchAny(n, have));   // premise: all present
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
const ham = (o) => JSON.stringify(o).length;

// ---- the candidate resolver: GATE (multiplicative set-membership mask) × BIAS (additive signed) ----
//   pack = { only?:[tags], except?:[tags], mods?:[{tag,val,when?:[tags]}] }
//   effect = base × gate(masks) × clamp(1 + Σ active biases, FLOOR, CAP)
//   gate = AND of membership tests (commutative). bias = Σ (commutative). One fixed compose order.
function gate(pack, otherTags) {
  if (pack.only && !inSet(pack.only, otherTags)) return 0;       // 除了X都不行 (whitelist)
  if (pack.except && inSet(pack.except, otherTags)) return 0;    // 除了X都行   (blacklist)
  return 1;
}
function bias(mods, otherTags, selfCtx) {
  let s = 0;
  for (const m of (mods || [])) {
    if (m.when && !supersetOf(m.when, selfCtx)) continue;        // 前提集合 must hold
    if (matchAny(m.tag, otherTags)) s += m.val;                 // 对象集合 matched → add signed val
  }
  return s;
}
function resolve(base, atk, defTags, def, atkTags, FLOOR = -Infinity, CAP = Infinity) {
  const g = gate(atk, defTags) * gate(def, atkTags);
  if (g === 0) return 0;
  const a = 1 + bias(atk.mods, defTags, atkTags) + bias(def.mods, atkTags, defTags);
  return base * g * clamp(a, FLOOR, CAP);
}

const L = (k, v) => console.log('  ' + k.padEnd(34) + v);
console.log('═══ 条件即集合逻辑:降汉明算子 — 实测 ═══\n');

// ① COMPLEMENT — "只伤X / 除X外全伤". collapses the O(roots) enumerated suppression + kills the leak.
console.log('① 补集算子 — 刺客匕首"只伤玩家zz·对万物免疫"');
const oldAssassin = [{ tag: '生物', val: -1 }, { tag: '方块', val: -1 }, { tag: '元素', val: -1 }, { tag: '物品', val: -1 }, { tag: '玩家.zz', val: 1 }];
const newAssassin = { only: ['玩家.zz'] };
const oldLeak = 10 * (1 + oldAssassin.filter((m) => ['机械.傀儡'].some((t) => tagMatch(m.tag, t))).reduce((s, m) => s + m.val, 0)); // new root not suppressed
L('旧(逐根抑制) 汉明', ham(oldAssassin) + `  zz=10  但新根 机械.傀儡 漏=${oldLeak}`);
L('新(only 补集) 汉明', ham(newAssassin) + `  zz=${resolve(10, newAssassin, ['生物.人', '玩家.zz'], {}, [])}  龙=${resolve(10, newAssassin, ['生物.龙'], {}, [])}  机械=${resolve(10, newAssassin, ['机械.傀儡'], {}, [])} (无漏)`);
L('降幅', `${ham(oldAssassin)} → ${ham(newAssassin)} 字符, 且补集是结构性的不泄漏`);

// "除了X以外都行" — a master key that opens everything EXCEPT diamond.
console.log('\n  除了X都行 — 万能钥匙(开一切方块, 唯独打不动钻石)');
const masterKey = { except: ['方块.钻'] };
L('开石/金/钻', `石=${resolve(10, masterKey, ['方块.石'], {}, [])}  金=${resolve(10, masterKey, ['方块.金属.金'], {}, [])}  钻=${resolve(10, masterKey, ['方块.钻'], {}, [])}`);

// ② PREMISE → OBJECT (一级前提·二级对象) — guarded bias active only when the actor's context holds.
console.log('\n② 前提→对象 — "对木+100%, 但仅当持有者是龙"(语境化修正)');
const dragonFireWand = { mods: [{ when: ['生物.龙'], tag: '阶.木', val: 1.0 }] };
L('龙 持杖 打木屋', resolve(10, dragonFireWand, ['方块.木', '阶.木'], {}, ['生物.龙']) + '  (前提成立 → ×2)');
L('人 持同杖 打木屋', resolve(10, dragonFireWand, ['方块.木', '阶.木'], {}, ['生物.人']) + '  (前提不成立 → ×1)');
L('汉明开销', `仅多一个 when 字段(${ham({ when: ['生物.龙'] })} 字符), 不需要的对象不写=优雅缺省`);

// ③ NAMED FIXED-COMBO SET (固定搭配集合) — a cross-cutting union referenced once vs re-listed.
console.log('\n③ 固定搭配集合 — "抗一切物理武器"');
const inlineResist = { mods: ['武器.剑', '武器.斧', '武器.矛', '武器.锤', '武器.匕首'].map((t) => ({ tag: t, val: -0.5 })) };
const namedResist = { mods: [{ tag: '@物理武器', val: -0.5 }] };
L('内联列举 汉明', ham(inlineResist));
L('具名集合引用 汉明', ham(namedResist) + `  剑打=${resolve(20, { mods: [] }, ['生物.龙'], namedResist, ['武器.剑', '元素.物理'])}  斧打=${resolve(20, {}, ['生物.龙'], namedResist, ['武器.斧'])}`);
L('降幅', `${ham(inlineResist)} → ${ham(namedResist)} 字符 (且新增物理武器自动纳入集合, 零改防御方)`);
console.log('  注:自然子树用标签层级即可(免费);具名集合只为"跨树的非前缀并集"');

// ④ DETERMINISM — gate=AND, bias=Σ are both commutative; shuffling the pack ⇒ identical result (序-safe).
console.log('\n④ 序安全 — 打乱条件顺序, 结果逐位一致(gate=与·bias=和 皆可交换)');
const pack = { mods: [{ tag: '生物', val: -1 }, { tag: '生物.龙', val: 2 }, { tag: '阶.钻', val: 0.5 }] };
const shuffled = { mods: [pack.mods[2], pack.mods[0], pack.mods[1]] };
const r1 = resolve(20, pack, ['生物.龙', '阶.钻'], {}, []);
const r2 = resolve(20, shuffled, ['生物.龙', '阶.钻'], {}, []);
L('原序 / 乱序', `${r1} / ${r2}  一致=${r1 === r2}`);

// ⑤ GRACEFUL — an empty pack {} is the identity (有/无 的"无"=干净空操作 = today's behavior).
console.log('\n⑤ 三值"无"=干净恒等 — 空包 {} ⇒ ×1, 与今天一致(隔/优雅缺省)');
L('空攻击包·空防御包', resolve(10, {}, ['生物.龙'], {}, []) + '  (=base, 无任何条件)');

console.log('\n小结(集合代数 = 两层, 都序安全):');
console.log('  GATE 乘法 {0,1} 掩码: only(只X) / except(除X) → 补集类需求 O(枚举根)→O(1)·无泄漏');
console.log('  BIAS 加法 Σ 带 when 前提: 三值(有/无·正/负) + 语境化, 仍可交换单次钳');
console.log('  具名集合: 跨树并集的引用(子树用层级即免费); when: 一级前提·tag: 二级对象');
console.log('  全程: 加法/与 皆可交换 ⇒ 不碰序契约; 空=恒等 ⇒ 隔/优雅缺省; 汉明显著下降。');
