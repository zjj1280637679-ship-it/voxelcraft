// Headless coverage of the client render-config resolver (presentation-local, pure).
//   node public/js/_clientconfig_test.js

import { resolveSetting, resolveAll, resolveWithPrefs, RENDER_CONFIG, DEFAULT_PREFS, Signals } from './clientconfig.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(44)} got=${JSON.stringify(got)}${ok ? '' : ' want=' + JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}
const sig = (o) => ({ signals: o });

// a LOCAL rule list to exercise the RESOLVER itself (decoupled from the shipped config data)
const R = [
  { value: 1.0 },                                                   // global default
  { scope: 'hero', value: 1.5 },                                   // per-object
  { when: [{ sig: 'fps', op: '<', val: 45 }], value: 0.7, ceil: true },
  { when: [{ sig: 'fps', op: '<', val: 30 }], value: 0.5, ceil: true },
];

console.log('=== 客户端画质设定解析器:场景覆盖 ===\n');

console.log('① 全局默认');
eq('默认', resolveSetting(R, {}), 1.0);

console.log('\n② 单独设定胜过全局(全局不覆盖单独)');
eq('scope=hero → 1.5', resolveSetting(R, { scope: 'hero' }), 1.5);
eq('scope=global → 1.0', resolveSetting(R, { scope: 'global' }), 1.0);

console.log('\n③ 条件门:压力自适应往下钳(只降不升)');
eq('fps=50 不触发 → 1.0', resolveSetting(R, sig({ fps: 50 })), 1.0);
eq('fps=40 → 0.7', resolveSetting(R, sig({ fps: 40 })), 0.7);
eq('fps=25 两道ceil取最低 → 0.5', resolveSetting(R, sig({ fps: 25 })), 0.5);

console.log('\n④ 关键:压力门钳"单独设定"(全局不覆盖hero,压力把hero也拉下来)');
eq('hero(1.5)+fps=25 → 0.5', resolveSetting(R, { scope: 'hero', signals: { fps: 25 } }), 0.5);
eq('hero(1.5)+fps=60 → 1.5', resolveSetting(R, { scope: 'hero', signals: { fps: 60 } }), 1.5);

console.log('\n⑤ 布尔ceil/缺信号惰性/纯函数');
eq('布尔强制关', resolveSetting([{ value: true }, { when: [{ sig: 'fps', op: '<', val: 40 }], value: false, ceil: true }], sig({ fps: 35 })), false);
eq('缺信号→回落默认', resolveSetting(R, { scope: 'global' }), 1.0);
const a = resolveSetting(R, sig({ fps: 25 })), b = resolveSetting(R, sig({ fps: 25 }));
eq('同输入两次一致', a, b);

console.log('\n⑥ 玩家上限语义 resolveWithPrefs(设定=允许上限,自适应只降不升)');
eq('默认空闲', resolveWithPrefs(DEFAULT_PREFS, sig({ fps: 60, gpu: 0.1 })), { resolution: 1.0, raytrace: true, framerate: 60 });
eq('默认高压→全钳', resolveWithPrefs(DEFAULT_PREFS, sig({ fps: 25, gpu: 0.95 })), { resolution: 0.5, raytrace: false, framerate: 30 });
eq('玩家设上限2.0空闲→2.0', resolveWithPrefs({ resolution: 2.0, raytrace: true, framerate: 120 }, sig({ fps: 60, gpu: 0.1 })).resolution, 2.0);
eq('玩家设2.0但高压→钳0.5', resolveWithPrefs({ resolution: 2.0, raytrace: true, framerate: 120 }, sig({ fps: 25 })).resolution, 0.5);
eq('玩家设上限0.5→永不超(空闲也0.5)', resolveWithPrefs({ resolution: 0.5, raytrace: false, framerate: 30 }, sig({ fps: 60 })).resolution, 0.5);
eq('玩家关光追→恒false', resolveWithPrefs({ resolution: 1, raytrace: false, framerate: 60 }, sig({ fps: 60 })).raytrace, false);

console.log('\n⑦ Signals 探针:卡顿→fps降·gpu压力升');
const s = new Signals();
for (let i = 0; i < 40; i++) s.sample(40);
const v = s.values;
eq('40ms帧 → fps≈25', v.fps <= 28 && v.fps >= 22, true);
eq('40ms帧 → gpu压力高', v.gpu > 0.85, true);

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'} ${pass}/${pass + fail}`);
