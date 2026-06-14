// CLIENT-LOCAL presentation config — pure resolver + data + signal probe.
//
// NOT shared, NEVER in REGISTRY_HASH, never touches the deterministic sim. It MAY read runtime
// signals (fps / compute pressure) precisely BECAUSE it is local — same resolver shape as the
// EffectResolver (condition gate + precedence + clamp), on the PRESENTATION operand space.
//
// A setting = a priority-ordered rule list. To change behaviour you edit DATA (RENDER_CONFIG):
//   · every setting flows through the ONE resolver (no per-setting branch = no redundancy)
//   · a threshold tweak = one number changed (tiny Hamming)
//   · this file has ZERO renderer/DOM dependency (node-testable, decoupled from how it's applied)

// A condition is pure DATA {sig, op, val}: the resolver reads ctx.signals[sig] and compares.
const OPS = {
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b,
  '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};
function condHolds(c, ctx) {
  const v = ctx.signals ? ctx.signals[c.sig] : undefined;
  return v !== undefined && !!OPS[c.op] && OPS[c.op](v, c.val);
}
function ruleActive(r, ctx) {
  if (r.scope && r.scope !== (ctx.scope || 'global')) return false;   // 单独设定的作用域门
  if (r.when) for (let i = 0; i < r.when.length; i++) if (!condHolds(r.when[i], ctx)) return false;
  return true;
}

// Resolve ONE setting (rule list) → effective value. Precedence: the active rule with the highest
// `priority` PICKS the value (default specificity: global 0 < conditional 1 < scoped 2). `ceil`
// rules never pick — they CLAMP the picked value DOWN (numeric → min, boolean → AND).
//   "全局默认不覆盖单独设定(更具体优先);条件门可钳所有人(只降不升)。"
export function resolveSetting(rules, ctx) {
  ctx = ctx || {};
  let chosen, chosenP = -Infinity;
  const ceils = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!ruleActive(r, ctx)) continue;
    if (r.ceil) { ceils.push(r.value); continue; }
    const p = r.priority != null ? r.priority : (r.scope ? 2 : (r.when ? 1 : 0));
    if (p >= chosenP) { chosenP = p; chosen = r.value; }
  }
  for (let i = 0; i < ceils.length; i++) {
    const c = ceils[i];
    if (typeof chosen === 'number' && typeof c === 'number') { if (c < chosen) chosen = c; }
    else if (typeof chosen === 'boolean' && typeof c === 'boolean') chosen = chosen && c;
  }
  return chosen;
}

// Resolve every setting in a bundle → { key: value }. `ctx.scope` (optional) selects per-object rules.
export function resolveAll(config, ctx) {
  const out = {};
  for (const k in config) out[k] = resolveSetting(config[k], ctx);
  return out;
}

// Smoothed runtime pressure probe (frame-time EMA). Deliberately DUMB — hysteresis/thresholds live
// in the DATA (RENDER_CONFIG), not here, so the probe stays reusable.
export class Signals {
  constructor() { this._ft = 16.7; this.fps = 60; this.gpu = 0; }
  sample(dtMs) {
    if (dtMs > 0 && dtMs < 1000) this._ft += (dtMs - this._ft) * 0.1;     // EMA frame time
    this.fps = Math.round(1000 / this._ft);
    this.gpu = Math.min(1, Math.max(0, (this._ft - 12) / 21));            // ~12ms→0 .. ~33ms→1
  }
  get values() { return { fps: this.fps, gpu: +this.gpu.toFixed(3) }; }
}

// THE DATA — edit this to change behaviour (data-only, no code, low Hamming). One rule list per knob.
export const RENDER_CONFIG = {
  resolution: [
    { value: 1.0 },                                                       // 全局默认
    { scope: 'hero', value: 1.5 },                                        // 单独:hero 对象超采样
    { when: [{ sig: 'fps', op: '<', val: 45 }], value: 0.7, ceil: true }, // 压力门:掉帧→往下钳
    { when: [{ sig: 'fps', op: '<', val: 30 }], value: 0.5, ceil: true }, // 更卡→钳更狠
  ],
  raytrace: [
    { value: true },
    { when: [{ sig: 'fps', op: '<', val: 40 }], value: false, ceil: true }, // 卡→强制关
  ],
  framerate: [
    { value: 60 },
    { when: [{ sig: 'gpu', op: '>', val: 0.85 }], value: 30, ceil: true },  // 高压→限 30
  ],
};
