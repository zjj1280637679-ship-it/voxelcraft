// CANDIDATE measurement: named, referenceable condition-packs ("可召唤的技能文档").
// A tier/affix/enchant/skill = a DATA pack registered by opaque code; an object stops CARRYING
// the conditions and starts CITING them (`use:['@铁级']`). = §0.7 快捷设定包 + master-law signifier
// (content writes the ref code, the resolver flattens it, no one forges the signified), now COMPOSABLE.
//   node public/js/sim/_probe4.js

import { tagMatch } from './effect.js';

// ---- KITS: the "skill docs". Each is a self-contained, human-readable bundle of conditions,
//      addressed by an opaque code. Balance lives HERE, not smeared across every object. ----
const KITS = {
  '@铁级': [{ tag: '生物.金', val: -0.5 }, { tag: '生物.钻', val: -0.75 }],   // 用户的例子:铁级武器 对金生物-50% 对钻生物-75%
  '@木级': [{ tag: '生物.石', val: -0.5 }, { tag: '生物.铁', val: -0.75 }, { tag: '生物.金', val: -0.9 }, { tag: '生物.钻', val: -0.95 }],
  '@附魔·焚': [{ tag: '生物', val: 0.2 }, { tag: '生物.冰', val: 1.5 }],
};

// flatten a pack's `use:[@code,...]` refs into one flat mod list — bounded depth + cycle-guarded,
// deterministic (concat order fixed). Σ is commutative so the merged order never changes the result.
function flatten(pack, seen = new Set()) {
  let mods = [...(pack.mods || [])];
  for (const ref of (pack.use || [])) {
    if (seen.has(ref)) continue;                       // cycle guard
    seen.add(ref);
    const kit = KITS[ref];
    if (Array.isArray(kit)) mods = mods.concat(kit);
    else if (kit) mods = mods.concat(flatten(kit, seen).mods);   // kit-of-kits, guarded
  }
  return { ...pack, mods };
}
function sumMatch(mods, tags) { let s = 0; for (const m of mods) for (const t of tags) { if (tagMatch(m.tag, t)) { s += m.val; break; } } return s; }
const effectK = (base, pack, targetTags) => base * (1 + sumMatch(flatten(pack).mods, targetTags));
const ham = (o) => JSON.stringify(o).length;
const L = (k, v) => console.log('  ' + k.padEnd(30) + v);

console.log('═══ 可召唤的技能文档:具名条件包(召唤=按代号引用)— 实测 ═══\n');

// ① 召唤即引用 vs 内联 — Hamming
console.log('① 一把铁剑:引用 @铁级 vs 内联整张减伤表');
const ironInline = { mods: [{ tag: '生物.金', val: -0.5 }, { tag: '生物.钻', val: -0.75 }] };
const ironRef = { use: ['@铁级'] };
L('内联 汉明', ham(ironInline));
L('召唤 @铁级 汉明', ham(ironRef) + `   对金生物=${effectK(10, ironRef, ['生物.金'])}  对钻生物=${effectK(10, ironRef, ['生物.钻'])} (×0.5/×0.25 如你所述)`);
L('降幅', `${ham(ironInline)} → ${ham(ironRef)} 字符 / 每把铁武器`);

// ② 集中平衡:一处改文档 → 所有引用者同步(开发期设计一次,修改期零散改)
console.log('\n② 集中平衡 — 改一次"文档", 所有召唤它的对象同步');
const ironSword = { use: ['@铁级'] }, ironAxe = { use: ['@铁级'] };
L('改前 剑/斧 对银生物', `${effectK(10, ironSword, ['生物.银'])} / ${effectK(10, ironAxe, ['生物.银'])} (无条目=满伤)`);
KITS['@铁级'].push({ tag: '生物.银', val: -0.6 });   // ← 一处编辑:给铁级补一条"对银-60%"
L('改后 剑/斧 对银生物', `${effectK(10, ironSword, ['生物.银'])} / ${effectK(10, ironAxe, ['生物.银'])} (1 处改, 两把武器同步)`);

// ③ 组合多张文档:武器 = 基底 + @铁级 + @附魔·焚, 且合并顺序无关(Σ 可交换 → 序安全)
console.log('\n③ 叠文档 — 铁剑 + 焚之附魔, 合并顺序不影响结果');
const enchIron = { use: ['@铁级', '@附魔·焚'] };
const enchIronRev = { use: ['@附魔·焚', '@铁级'] };
L('对冰生物(铁级+焚)', `${effectK(10, enchIron, ['生物.冰'])}  顺序颠倒=${effectK(10, enchIronRev, ['生物.冰'])}  一致=${effectK(10, enchIron, ['生物.冰']) === effectK(10, enchIronRev, ['生物.冰'])}`);
L('对钻生物(铁级减伤)', `${effectK(10, enchIron, ['生物.钻'])}`);

// ④ 这就是 master-law / §0.7:文档按不透明代号寻址, 解析器只 flatten+Σ, 没人能伪造所指
console.log('\n④ 召唤=寻址 — 写错代号优雅降级(缺文档=空贡献), 不崩');
L('召唤不存在的 @幽灵级', `对金生物=${effectK(10, { use: ['@幽灵级'] }, ['生物.金'])} (=10, 缺文档=空, §3.7 隔)`);

console.log('\n小结:');
console.log('  · "铁级/附魔/技能" = 具名条件包(KITS), 对象用 use:[@代号] 召唤 → 汉明 O(表)→O(引用)');
console.log('  · 平衡集中在文档里:改一次, 全部引用者同步(开发期设计↔修改期近零)');
console.log('  · flatten 在 GATE×BIAS 之前跑:纯数据展开, 有界深度+环防护+Σ可交换 ⇒ 不碰序/隔');
console.log('  · = §0.7 快捷设定包 / §0.1 寻址(代号)用在条件包上, 不是新机制, 是同一招再用一层');
