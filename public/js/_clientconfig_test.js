// Headless coverage of the client render-config resolver (presentation-local, pure).
//   node public/js/_clientconfig_test.js

import { resolveSetting, resolveAll, RENDER_CONFIG, Signals } from './clientconfig.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(46)} got=${JSON.stringify(got)}${ok ? '' : ' want=' + JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}

const R = RENDER_CONFIG.resolution;
const sig = (o) => ({ signals: o });

console.log('=== 客户端画质设定解析器:场景覆盖 ===\n');

console.log('① 全局默认(无信号·无作用域)');
eq('resolution 默认', resolveSetting(R, {}), 1.0);
eq('raytrace 默认', resolveSetting(RENDER_CONFIG.raytrace, {}), true);
eq('framerate 默认', resolveSetting(RENDER_CONFIG.framerate, {}), 60);

console.log('\n② 单独设定胜过全局(更具体优先,全局不覆盖)');
eq('scope=hero → 超采样1.5', resolveSetting(R, { scope: 'hero' }), 1.5);
eq('scope=global → 仍全局1.0', resolveSetting(R, { scope: 'global' }), 1.0);

console.log('\n③ 条件门:压力自适应往下钳(只降不升)');
eq('fps=50 → 不触发,1.0', resolveSetting(R, sig({ fps: 50 })), 1.0);
eq('fps=40 → 钳到0.7', resolveSetting(R, sig({ fps: 40 })), 0.7);
eq('fps=25 → 两道ceil取最低0.5', resolveSetting(R, sig({ fps: 25 })), 0.5);

console.log('\n④ 关键:压力门钳"单独设定"——全局不覆盖hero,但压力把hero也拉下来');
eq('hero(1.5)+fps=25 → min→0.5', resolveSetting(R, { scope: 'hero', signals: { fps: 25 } }), 0.5);
eq('hero(1.5)+fps=60 → 不钳,1.5', resolveSetting(R, { scope: 'hero', signals: { fps: 60 } }), 1.5);

console.log('\n⑤ 布尔 ceil = 强制关 / gpu 门限帧');
eq('raytrace fps=35 → 强制false', resolveSetting(RENDER_CONFIG.raytrace, sig({ fps: 35 })), false);
eq('raytrace fps=60 → true', resolveSetting(RENDER_CONFIG.raytrace, sig({ fps: 60 })), true);
eq('framerate gpu=0.9 → 限30', resolveSetting(RENDER_CONFIG.framerate, sig({ gpu: 0.9 })), 30);
eq('framerate gpu=0.5 → 60', resolveSetting(RENDER_CONFIG.framerate, sig({ gpu: 0.5 })), 60);

console.log('\n⑥ 缺信号 → 条件规则惰性(不崩,回落默认)');
eq('resolution 无 signals 键', resolveSetting(R, { scope: 'global' }), 1.0);
eq('resolveAll 高压一把出', resolveAll(RENDER_CONFIG, sig({ fps: 25, gpu: 0.95 })), { resolution: 0.5, raytrace: false, framerate: 30 });
eq('resolveAll 空闲一把出', resolveAll(RENDER_CONFIG, sig({ fps: 60, gpu: 0.1 })), { resolution: 1.0, raytrace: true, framerate: 60 });

console.log('\n⑦ 纯函数:同输入逐次一致(可换/无副作用)');
const a = resolveAll(RENDER_CONFIG, sig({ fps: 25, gpu: 0.95 }));
const b = resolveAll(RENDER_CONFIG, sig({ fps: 25, gpu: 0.95 }));
eq('两次 resolveAll 一致', a, b);

console.log('\n⑧ Signals 探针:卡顿→fps降·gpu压力升');
const s = new Signals();
for (let i = 0; i < 40; i++) s.sample(40);   // sustained 40ms frames (~25fps)
const v = s.values;
eq('40ms帧 → fps≈25', v.fps <= 28 && v.fps >= 22, true);
eq('40ms帧 → gpu压力高', v.gpu > 0.85, true);

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'} ${pass}/${pass + fail}`);
