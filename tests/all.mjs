import { run as runLogic } from './logic.test.mjs';
import { run as runVision } from './vision.test.mjs';
import { run as runFoodsData } from './foods.data.test.mjs';
import { run as runUi } from './ui.smoke.mjs';
import { run as runIntegration } from './integration.mjs';

// 顺序有意义：ui.smoke 会注入假 DOM / 假 IndexedDB 并在结束时还原，必须在纯逻辑套件之后
const suites = [
  ['logic', runLogic],
  ['vision', runVision],
  ['foods-data', runFoodsData],
  ['ui', runUi],
  ['integration', runIntegration],
];

export async function runAll() {
  const results = [];
  for (const [name, fn] of suites) {
    const started = Date.now();
    try {
      const r = await fn();
      results.push({ name, ok: r.failed === 0, passed: r.passed, failed: r.failed, failures: r.failures ?? [], ms: Date.now() - started });
    } catch (e) {
      results.push({ name, ok: false, passed: 0, failed: 1, failures: [{ name: `${name} 套件抛异常`, error: String(e && e.stack || e) }], ms: Date.now() - started });
    }
  }
  const total = results.reduce((a, r) => ({ passed: a.passed + r.passed, failed: a.failed + r.failed }), { passed: 0, failed: 0 });
  return { ...total, ok: total.failed === 0, results };
}

export function report(summary) {
  for (const r of summary.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.passed} passed / ${r.failed} failed  (${r.ms}ms)`);
    for (const f of r.failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  console.log(`\n合计 ${summary.passed} passed / ${summary.failed} failed → ${summary.ok ? '全部通过' : '存在失败'}`);
  return summary;
}

// 允许 `import` 后手动调用，也允许作为脚本被直接执行
if (process.argv?.[1] && process.argv[1].endsWith('all.mjs')) {
  report(await runAll());
}
