// CANDIDATE measurement: "every object carries +/- conditions" — a TWO-SIDED resolver.
// Does NOT touch the live engine; it prototypes effect2 next to the real tagMatch to MEASURE
// how much the data-reachability ceiling rises, what it costs, and what it does NOT change.
//
//   node public/js/sim/_probe2.js

import { tagMatch, effect } from './effect.js';

// Σ of every modifier whose tag prefix-matches ANY of the other party's tags (each mod once).
function sumMatch(pack, tags) {
  let s = 0;
  for (const m of pack) for (const t of tags) { if (tagMatch(m.tag, t)) { s += m.val; break; } }
  return s;
}

// TWO-SIDED: affinity = 1 + Σ(attacker offense vs DEFENDER tags) + Σ(defender DEFENSE vs ATTACKER tags).
// One extra additive pass over the SAME prefix-match → still order-independent, 序-safe, single clamp.
// Both packs optional (absent = []) ⇒ graceful default == today's one-sided effect().
function effect2(base, atkOff, defTags, defDef, atkTags, FLOOR = -Infinity, CAP = Infinity) {
  const a = 1 + sumMatch(atkOff || [], defTags) + sumMatch(defDef || [], atkTags || []);
  return base * (a < FLOOR ? FLOOR : (a > CAP ? CAP : a));
}

const line = (k, v) => console.log('  ' + k.padEnd(40) + v);
console.log('═══ 候选:两侧条件解析器 effect2 — 上限提升实测 ═══\n');

// ---------- 1. 通用护甲(按属性键):一次设计,对所有同属性攻击者生效 ----------
console.log('① 通用护甲(原 LOGIC✗ 缺口)→ 现在 DATA✓');
const dragonTags = ['生物.龙', '阶.钻'];
const dragonDef = [{ tag: '元素.物理', val: -0.5 }];   // 一行:对一切"物理"攻击 -50%
const sword = { tags: ['武器.剑', '元素.物理', '阶.铁'], off: [] };
const axe = { tags: ['武器.斧', '元素.物理', '阶.金'], off: [] };
const fireWand = { tags: ['法器', '元素.火'], off: [] };
line('剑(物理)打龙', effect2(20, sword.off, dragonTags, dragonDef, sword.tags) + '  (原 20 → 半伤,护甲生效)');
line('斧(物理)打龙', effect2(20, axe.off, dragonTags, dragonDef, axe.tags) + '  (同一行护甲,零逐武器改)');
line('火杖(非物理)打龙', effect2(20, fireWand.off, dragonTags, dragonDef, fireWand.tags) + '  (非物理,护甲不触发)');
line('一侧版 effect() 能表达?', '不能 — 签名无 defender 包参(audit #5)');

// ---------- 2. 弱点 / 易伤(防御侧正条件):局部在对象上 ----------
console.log('\n② 弱点火(怕火 +100%)→ DATA✓, 且局部在生物上(非摊到每把火武器)');
const iceGolemTags = ['生物.石像.冰', '阶.铁'];
const iceGolemDef = [{ tag: '元素.火', val: 1.0 }];     // 一行:受到"火" +100%
line('任意火源打冰傀儡', effect2(14, fireWand.off, iceGolemTags, iceGolemDef, fireWand.tags) + '  (×2)');
line('物理源打冰傀儡', effect2(14, sword.off, iceGolemTags, iceGolemDef, sword.tags) + '  (不触发)');

// ---------- 3. 局部性 / 正交性 增益:把"龙抗物理"做成数据,要改几处?连带几处? ----------
console.log('\n③ 关键增益 — "龙抗物理-50%" 的真实成本(局部性=实用正交性)');
const PHYS_WEAPONS = ['剑', '斧', '矛', '锤', '匕首'];   // 物理武器集
line('一侧模型:改哪里', `每把物理武器加 {生物.龙,-0.5} = ${PHYS_WEAPONS.length} 处编辑`);
line('一侧模型:连带', '这些武器对"其他也带 生物.龙 的对象"也变弱 = 连带泄漏');
line('两侧模型:改哪里', '龙身上加 1 行 {元素.物理,-0.5} = 1 处编辑');
line('两侧模型:连带', '0(只描述龙自己;新武器自动适用)');

// ---------- 4. 优雅降级:无 def 包 ⇒ 与今天逐位一致(增量采用,非强制完整设计) ----------
console.log('\n④ 向后兼容 — 无防御包的对象,effect2 == 今天的 effect()');
const woodMods = [{ tag: '阶.钻', val: -0.95 }];
const a = effect(10, woodMods, dragonTags);              // 现行
const b = effect2(10, woodMods, dragonTags, undefined, ['武器.木剑']);  // 候选,龙无 def
line('木剑打龙 现行/候选', `${a.toFixed(3)} / ${b.toFixed(3)}  (一致=${Math.abs(a - b) < 1e-9})`);
console.log('  → "完整设计"是 pay-as-you-go:缺防御包=空=默认行为,只为真要的对象写条件');

// ---------- 5. 边界:effect2 只抬"交互轴"上限;运动/生成/寿命缺口它一概不碰 ----------
console.log('\n⑤ 不改变的(防投机泛化)— 这是交互轴,与下列正交');
line('垂直运动/patrol/chase/spawn复制', 'PRIM✗ 照旧(条件化属性救不了运动原语)');
line('延时/on-death/AoE', 'LOGIC✗ 照旧(那是触发/调度轴,非 effect 轴)');
console.log('  → 别把"非交互属性"(位置/渲染/寿命)也条件化:那才是无回报的完整设计负担');

// ---------- 6. 还剩的硬限:"对万物免疫"仍需全域根标签(两侧也不凭空造 match-all) ----------
console.log('\n⑥ 仍存的限 — "无条件对一切 X" 仍需一个万物共享的根标签(两侧不解决 taxonomy 缺根)');

console.log('\n小结: effect2 = 加 1 个 defender 包参 + 1 个 additive pass(汉明极小、保持序/隔/加法可交换)。');
console.log('  抬升: 目标侧护甲/弱点/抗性/克制 全部 DATA✓, 且从"改 O(攻击者) 处+连带" 降到 "改 1 处+零连带"(局部性=更强实用正交)。');
console.log('  代价: 对象可选携带防御条件(缺=优雅默认), 真正成本是"为想差异化的对象设计条件", 增量可控。');
console.log('  界限: 只抬交互轴; 运动/生成/触发缺口不动。把 combat.def 这类死槽接到这条 pass 上即可救活。');
