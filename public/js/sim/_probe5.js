// CANDIDATE (model probe): make the INSTRUCTION half symmetric to the data half.
// An ABILITY = a referenceable doc  { on:触发, who:选择器, do:操作码, with:数据 }.
// The NEW piece worth grounding is `who` — a target SELECTOR that REUSES the same set
// algebra (tags / except / radius / cone) the EffectResolver uses for magnitude, now
// lifted from 1-vs-1 to 1-vs-many. This shows the audit's scattered gaps (on-death /
// AoE / spawn) collapse to (trigger × op) opcodes + a data doc, selector reused.
//   node public/js/sim/_probe5.js

import { tagMatch } from './effect.js';

// a tiny world: a dragon (us) at (8.5,6.5) facing south(+z); creatures ahead.
const SELF = { x: 8.5, z: 6.5, fx: 0, fz: 1 };
const ENTS = [
  { id: 1, x: 8.5, z: 12.5, tags: ['生物.石像', '阶.铁'], name: '石像' },
  { id: 2, x: 4.5, z: 12.5, tags: ['生物.石像', '阶.铁'], name: '石像' },
  { id: 3, x: 12.5, z: 12.5, tags: ['生物.石像', '阶.铁'], name: '石像' },
  { id: 4, x: 8.5, z: 8.5, tags: ['生物.兔', '阶.木'], name: '兔子' },
  { id: 5, x: 8.5, z: 4.5, tags: ['生物.龙', '阶.钻'], name: '友龙' },   // behind us + friendly
  { id: 6, x: 8.5, z: 40.5, tags: ['生物.石像', '阶.铁'], name: '远石像' }, // out of range
];

// `who` SELECTOR = the same set algebra (tag match / except), plus spatial within/cone.
function select(sel) {
  return ENTS.filter((e) => {
    const dx = e.x - SELF.x, dz = e.z - SELF.z, d = Math.hypot(dx, dz);
    if (sel.within != null && d > sel.within) return false;
    if (sel.cone != null && d > 0 && (dx * SELF.fx + dz * SELF.fz) / d < sel.cone) return false;
    if (sel.tags && !sel.tags.some((t) => e.tags.some((et) => tagMatch(t, et)))) return false;     // OR (union)
    if (sel.except && sel.except.some((t) => e.tags.some((et) => tagMatch(t, et)))) return false;  // complement
    return true;
  });
}

// `do` = a SMALL fixed opcode set (the VM instruction set). Here just logged.
const OPS = {
  effect: (d) => `施加 affinity(base=${d.base}${d.pack ? ',包=' + d.pack : ''})`,
  transform: (d) => `变身 → ${d.form}`,
  spawn: (d) => `生成 ${d.proto} @${d.at}`,
};

// ABILITY docs — each = (on 触发, who 选择器, do 操作码, with 数据). on/do are the fixed
// instruction set; who reuses set algebra; with is data (refs condition docs by @code).
const ABILITIES = {
  喷火术: { on: 'use', who: { within: 8, cone: 0.5, tags: ['生物'], except: ['生物.龙'] }, do: 'effect', with: { base: 14, pack: '@龙息' } },
  治疗光环: { on: 'tick', every: 1, who: { within: 5, tags: ['生物.龙'] }, do: 'effect', with: { base: -5 } },
  变身术: { on: 'use', who: null, do: 'transform', with: { form: 'dragon' } },     // 'who' absent = self
  凤凰: { on: 'death', who: null, do: 'spawn', with: { proto: 'self', at: 'here' } }, // ← 原 on-death 缺口
  毒云: { on: 'tick', every: 1, who: { within: 3, tags: ['生物'] }, do: 'effect', with: { base: 2, pack: '@毒' } }, // ← 原 AoE 缺口
};

const names = (es) => es.map((e) => `${e.name}#${e.id}`).join(',') || '(无)';
console.log('═══ 指令也是可引用文档:能力 = {on 触发, who 选择器, do 操作码, with 数据} ═══\n');
for (const [k, a] of Object.entries(ABILITIES)) {
  const targets = a.who ? select(a.who) : ['<自己>'];
  const trig = a.on + (a.every ? `(每${a.every})` : '');
  console.log(`  ${k.padEnd(6)} on=${trig.padEnd(10)} do=${a.do.padEnd(10)} ${OPS[a.do] ? OPS[a.do](a.with) : '?'}`);
  console.log(`         who → ${a.who ? names(targets) : '<自己>'}`);
}

console.log('\n关键验证(who = 集合代数 over 世界, 从 1v1 抬到 1v多):');
const fire = select(ABILITIES.喷火术.who);
console.log('  喷火术选中:', names(fire), ' ← 含锥内石像×3+兔子, 排除友龙(except)、身后龙、超距远石像');
console.log('  即:within(距)·cone(锥)·tags(并)·except(补) 全是之前那套算子, 复用零新机制。\n');

console.log('小结(指令半边的对称完形):');
console.log('  · 能力文档 = (on 触发, who 选择器, do 操作码, with 数据) — 像技能文档一样按代号引用、可叠');
console.log('  · 审计缺口塌成"(触发×操作码)对": 凤凰=死亡×spawn · 毒云=每帧×effect · 下蛋=每帧×spawn');
console.log('  · 要硬编码的"指令集"缩成 ~5触发 × ~5操作码 的小矩阵; 谁/参数/条件全是数据(who 复用集合代数)');
console.log('  · 纪律: 触发/操作码=固定确定性指令(序/隔/无超越); 加一条要探针证明"数据够不到"; 操作码不互调(有界)');
