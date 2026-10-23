/**
 * logic-core 的可自动验证部分。
 *
 * 运行方式（本机只能用 run_code，pwsh/node 子进程不可用）：
 *   const m = await import('file:///C:/Users/Administrator/Desktop/hms/tests/logic.test.mjs');
 *   await m.run();   // -> { passed, failed, failures }
 * 直接执行本文件（node tests/logic.test.mjs）也会自己跑一遍。
 *
 * 覆盖面：nutrition.js 全部导出 + 边界（含 kg/斤 换算、移动平均）、pure.js 的整形/去重/聚合/CSV/
 * 套餐模板/最近吃过/导出天数，以及「导出→清空→导入」的纯逻辑往返一致性；
 * 文件末尾另有一段「本地多账号」用例：账号目录本身、切换账号后的库名与连接、以及
 * A/B 两库的物理隔离（持久化假 IDB + 假 localStorage）。
 * IndexedDB 路径：Node 没有 indexedDB，默认只能断言「不可用时抛中文错误」；
 * 唯一例外是 store 的 settings / 套餐 / 导出状态，用文件末尾的最小假 IDB 真跑一遍后立即清理。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import * as nutrition from '../js/nutrition.js';
import * as pure from '../js/pure.js';
import * as db from '../js/db.js';
import * as store from '../js/store.js';
import * as accounts from '../js/accounts.js';
import * as sync from '../js/sync.js';
import * as cloudApi from '../js/cloud-api.js';
import * as cloudTransport from '../js/cloud-transport.js';

const IDB_MSG = '当前浏览器禁用了本地存储，数据无法保存';

// Node 里本来没有 indexedDB；若宿主进程注入过（自测用的 FakeIDB），
// 「不可用即抛中文错误」这组断言就没有意义了，显式跳过而不是误报
const IDB_ABSENT = typeof globalThis.indexedDB === 'undefined';

const failures = [];
let passed = 0;

function record(name, error) {
  failures.push({ name, error: error && error.message ? error.message : String(error) });
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    record(name, err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    record(name, err);
  }
}

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
}

function deep(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

function ok(value, msg) {
  assert.ok(value, msg);
}

function near(actual, expected, eps, msg) {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= eps,
    `${msg ?? '数值不在容差内'}：actual=${actual} expected=${expected} eps=${eps}`,
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function shiftDateStr(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// 纯模块的边界守卫：源码里不允许出现 DOM / 网络 / 存储入口
function sourceOf(fileName) {
  const url = new URL(`../js/${fileName}`, import.meta.url);
  return fs
    .readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// ---------- nutrition: 日期 ----------

function testDates() {
  check('localDateStr 用本地时区拼日期（不用 toISOString）', () => {
    const d = new Date(2026, 0, 1, 0, 30, 0);
    eq(nutrition.localDateStr(d), '2026-01-01');
    const late = new Date(2026, 11, 31, 23, 59, 59);
    eq(nutrition.localDateStr(late), '2026-12-31');
    eq(nutrition.localDateStr(new Date(2026, 8, 9)), '2026-09-09');
  });

  check('localDateStr 默认参数为今天且返回 10 位', () => {
    const s = nutrition.localDateStr();
    ok(/^\d{4}-\d{2}-\d{2}$/.test(s), `格式不对：${s}`);
    eq(s.length, 10);
  });

  check('localDateStr 非法 Date 返回空串', () => {
    eq(nutrition.localDateStr(new Date(NaN)), '');
  });

  check('parseDateStr 得到本地 00:00，且与 localDateStr 互补', () => {
    const d = nutrition.parseDateStr('2026-03-05');
    eq(d.getFullYear(), 2026);
    eq(d.getMonth(), 2);
    eq(d.getDate(), 5);
    eq(d.getHours(), 0);
    eq(d.getMinutes(), 0);
    eq(nutrition.localDateStr(d), '2026-03-05');
    eq(nutrition.localDateStr(nutrition.parseDateStr('2024-02-29')), '2024-02-29');
  });

  check('parseDateStr 拒绝非法/溢出日期', () => {
    ok(Number.isNaN(nutrition.parseDateStr('2026-02-31').getTime()), '2026-02-31 应非法');
    ok(Number.isNaN(nutrition.parseDateStr('2026-13-01').getTime()), '13 月应非法');
    ok(Number.isNaN(nutrition.parseDateStr('2026/01/01').getTime()), '斜杠格式应非法');
    ok(Number.isNaN(nutrition.parseDateStr(null).getTime()), 'null 应非法');
    ok(Number.isNaN(nutrition.parseDateStr('').getTime()), '空串应非法');
  });

  check('daysAgo 0/1/30 与本地日期一致', () => {
    eq(nutrition.daysAgo(0), nutrition.localDateStr());
    eq(nutrition.daysAgo(1), shiftDateStr(1));
    eq(nutrition.daysAgo(30), shiftDateStr(30));
    eq(nutrition.daysAgo(), shiftDateStr(0));
  });
}

// ---------- nutrition: 代谢 ----------

function testMetabolism() {
  check('bmrMifflinStJeor 男/女/非法', () => {
    eq(nutrition.bmrMifflinStJeor({ sex: 'male', weightKg: 70, heightCm: 175, age: 30 }), 1649);
    eq(nutrition.bmrMifflinStJeor({ sex: 'female', weightKg: 70, heightCm: 175, age: 30 }), 1483);
    eq(nutrition.bmrMifflinStJeor({ sex: 'male', weightKg: 0, heightCm: 175, age: 30 }), 0);
    eq(nutrition.bmrMifflinStJeor({}), 0);
    eq(nutrition.bmrMifflinStJeor(), 0);
  });

  check('tdee 活动系数与未知值兜底', () => {
    eq(nutrition.tdee(1649, 'sedentary'), 1979);
    eq(nutrition.tdee(1649, 'light'), 2267);
    eq(nutrition.tdee(1649, 'moderate'), 2556);
    eq(nutrition.tdee(1649, 'active'), 2845);
    eq(nutrition.tdee(1649, 'very_active'), 3133);
    eq(nutrition.tdee(1649, 'unknown'), 1979);
    eq(nutrition.tdee(1649, undefined), 1979);
    eq(nutrition.tdee(0, 'light'), 0);
    eq(nutrition.tdee(NaN, 'light'), 0);
  });

  check('ageFromBirthday 周岁边界', () => {
    const y = new Date().getFullYear();
    eq(nutrition.ageFromBirthday(`${y - 30}-01-01`), 30);
    eq(nutrition.ageFromBirthday(''), 0);
    eq(nutrition.ageFromBirthday('abc'), 0);
    // 生日今年还没到 -> 少一岁（除今天恰好是 12-31 的极端情况）
    const now = new Date();
    if (!(now.getMonth() === 11 && now.getDate() === 31)) {
      eq(nutrition.ageFromBirthday(`${y - 30}-12-31`), 29);
    }
  });

  check('targetMacros 比例/百分比两种约定等价', () => {
    const a = nutrition.targetMacros(2000, { carb: 0.5, protein: 0.2, fat: 0.3 });
    const b = nutrition.targetMacros(2000, { carb: 50, protein: 20, fat: 30 });
    eq(a.carb, 250);
    eq(a.protein, 100);
    eq(a.fat, 66.7);
    deep(a, b);
  });

  check('targetMacros 空比例/零热量兜底', () => {
    const def = nutrition.targetMacros(2000, {});
    eq(def.carb, 250);
    eq(def.protein, 100);
    eq(def.fat, 66.7);
    deep(nutrition.targetMacros(0, { carb: 0.5 }), { carb: 0, protein: 0, fat: 0 });
    deep(nutrition.targetMacros(2000), { carb: 250, protein: 100, fat: 66.7 });
  });

  check('kcalFromMacros 4/4/9 且与 targetMacros 自洽', () => {
    eq(nutrition.kcalFromMacros({ carb: 250, protein: 100, fat: 66.7 }), 2000);
    eq(nutrition.kcalFromMacros({ carb: 0, protein: 0, fat: 0 }), 0);
    eq(nutrition.kcalFromMacros({}), 0);
    eq(nutrition.kcalFromMacros(), 0);
    for (const target of [1200, 1500, 1800, 2000, 2400, 3000]) {
      const grams = nutrition.targetMacros(target, { carb: 0.45, protein: 0.25, fat: 0.3 });
      near(nutrition.kcalFromMacros(grams), target, 3, `${target}kcal 反算应自洽`);
    }
  });
}

// ---------- nutrition: 食物与聚合 ----------

function testFoodMath() {
  check('scaleFood 按克数换算（kcal 取整，其余 1 位）', () => {
    const rice = { kcal: 116, carb: 25.9, protein: 2.6, fat: 0.3, fiber: 0.3, sodium: 1.1 };
    const s = nutrition.scaleFood(rice, 200);
    eq(s.kcal, 232);
    eq(s.carb, 51.8);
    eq(s.protein, 5.2);
    eq(s.fat, 0.6);
    eq(s.fiber, 0.6);
    eq(s.sodium, 2.2);
  });

  check('scaleFood 零克/缺字段/非法入参', () => {
    deep(nutrition.scaleFood({ kcal: 116 }, 0), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    deep(nutrition.scaleFood(null, 100), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    deep(nutrition.scaleFood({ kcal: 100 }, undefined), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    eq(nutrition.scaleFood({ kcal: 100 }, 50).kcal, 50);
  });

  check('sumItems 空数组/缺字段/非法条目', () => {
    deep(nutrition.sumItems([]), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    deep(nutrition.sumItems(), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    deep(nutrition.sumItems([null, 1, 'x']), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    const one = nutrition.sumItems([{ kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6 }]);
    eq(one.fiber, 0);
    eq(one.sodium, 0);
    const two = nutrition.sumItems([
      { kcal: 232.4, carb: 51.8, protein: 5.2, fat: 0.6, fiber: 0.6, sodium: 2.2 },
      { kcal: 248, carb: 0, protein: 46.5, fat: 5.4 },
    ]);
    eq(two.kcal, 480);
    eq(two.carb, 51.8);
    eq(two.protein, 51.7);
    eq(two.fat, 6);
    eq(two.fiber, 0.6);
    eq(two.sodium, 2.2);
  });

  check('netKcal 与 round1', () => {
    eq(nutrition.netKcal(1500, 300), 1200);
    eq(nutrition.netKcal(0, 0), 0);
    eq(nutrition.netKcal(120, 220.4), -100);
    eq(nutrition.round1(1.005), 1);
    eq(nutrition.round1(2.25), 2.3);
    eq(nutrition.round1('3.14'), 3.1);
    eq(nutrition.round1(NaN), 0);
    eq(nutrition.round1(Infinity), 0);
    eq(nutrition.round1(-0.04), 0);
  });

  check('bmi 与其分级边界', () => {
    eq(nutrition.bmi({ weightKg: 70, heightCm: 175 }), 22.9);
    eq(nutrition.bmi({ weightKg: 0, heightCm: 175 }), 0);
    eq(nutrition.bmi({}), 0);
    eq(nutrition.bmiClass(18.4).level, 'low');
    eq(nutrition.bmiClass(18.5).level, 'normal');
    eq(nutrition.bmiClass(23.9).level, 'normal');
    eq(nutrition.bmiClass(24).level, 'over');
    eq(nutrition.bmiClass(27.9).level, 'over');
    eq(nutrition.bmiClass(28).level, 'obese');
    eq(nutrition.bmiClass(0).label, '未知');
    eq(nutrition.bmiClass('abc').level, 'normal');
    eq(nutrition.bmiClass(30).label, '肥胖');
  });
}

// ---------- nutrition: BMI 边界体重（界面可视化用） ----------

function testBmiBoundaries() {
  check('weightForBmi 由 BMI 反算体重，非法输入 null', () => {
    eq(nutrition.weightForBmi(24, 175), 73.5);
    eq(nutrition.weightForBmi(18.5, 175), 56.7);
    eq(nutrition.weightForBmi(22, 160), 56.3);
    eq(nutrition.weightForBmi('24', '175'), 73.5, '数字字符串应当可用');
    eq(nutrition.weightForBmi(0, 175), null);
    eq(nutrition.weightForBmi(-24, 175), null);
    eq(nutrition.weightForBmi(NaN, 175), null);
    eq(nutrition.weightForBmi(Infinity, 175), null);
    eq(nutrition.weightForBmi(24, 0), null);
    eq(nutrition.weightForBmi(24, -175), null);
    eq(nutrition.weightForBmi(24, Infinity), null);
    eq(nutrition.weightForBmi(24, 'abc'), null);
  });

  check('bmiGaps 给出相邻档位边界的距离（23.3 → 上界超重 2.1kg）', () => {
    const g = nutrition.bmiGaps(23.3, 175);
    eq(g.upper.label, '超重');
    near(g.upper.kg, 2.1, 0.2, '23.3 → 24 边界应约 2.1kg');
    eq(g.lower.label, '偏瘦');
    near(g.lower.kg, 14.7, 0.2, '23.3 → 18.5 边界应约 14.7kg');
    ok(g.upper.kg > 0 && g.lower.kg > 0, 'kg 是绝对差，必须为正');
    // kg 保留 1 位
    for (const side of [g.lower, g.upper]) {
      near(side.kg * 10, Math.round(side.kg * 10), 1e-9, 'kg 必须落在 0.1 网格上');
    }

    const lean = nutrition.bmiGaps(17, 175);
    deep(lean.lower, null, '最低档没有更低边界');
    eq(lean.upper.label, '正常');
    near(lean.upper.kg, 4.6, 0.2);

    const obese = nutrition.bmiGaps(29, 175);
    deep(obese.upper, null, '最高档没有更高边界');
    eq(obese.lower.label, '超重');
    near(obese.lower.kg, 3.1, 0.2);

    // 边界值本身进入下一档，与 bmiClass 的口径一致
    eq(nutrition.bmiClass(28).label, '肥胖');
    deep(nutrition.bmiGaps(28, 175).upper, null);
    eq(nutrition.bmiGaps(28, 175).lower.label, '超重');
    eq(nutrition.bmiClass(18.5).label, '正常');
    eq(nutrition.bmiGaps(18.5, 175).lower.label, '偏瘦');
  });

  check('bmiGaps 非法输入返回双 null，label 来自 bmiClass 的档位名', () => {
    deep(nutrition.bmiGaps(0, 175), { lower: null, upper: null });
    deep(nutrition.bmiGaps(-1, 175), { lower: null, upper: null });
    deep(nutrition.bmiGaps(NaN, 175), { lower: null, upper: null });
    deep(nutrition.bmiGaps(23.3, 0), { lower: null, upper: null });
    deep(nutrition.bmiGaps(23.3, -175), { lower: null, upper: null });
    deep(nutrition.bmiGaps(23.3, NaN), { lower: null, upper: null });
    deep(nutrition.bmiGaps('abc', 'abc'), { lower: null, upper: null });
    // 四个档位名必须与 bmiClass() 一致（界面直接显示这四个词）
    for (const [probe, label] of [[17, '偏瘦'], [20, '正常'], [25, '超重'], [29, '肥胖']]) {
      eq(nutrition.bmiClass(probe).label, label);
    }
    eq(nutrition.bmiGaps(20, 175).lower.label, '偏瘦');
    eq(nutrition.bmiGaps(20, 175).upper.label, '超重');
    eq(nutrition.bmiGaps(25, 175).lower.label, '正常');
    eq(nutrition.bmiGaps(25, 175).upper.label, '肥胖');
  });
}

// ---------- nutrition: 运动净消耗 ----------

function testExerciseBurn() {
  check('estimateBurn 走净消耗口径 (MET−1)，小于旧的总消耗', () => {
    const net = nutrition.estimateBurn({ type: 'bike', intensity: 'road', minutes: 30, weightKg: 70 });
    eq(net, Math.round((8.0 - 1) * 70 * 0.5));
    eq(net, 245);
    const oldGross = 8.0 * 70 * 0.5;
    eq(oldGross, 280);
    ok(net < oldGross, `净消耗 ${net} 必须小于旧的总消耗 ${oldGross}`);
    near(net, Math.round(oldGross * (7 / 8)), 1, '净额应约为总量的 (MET−1)/MET');
  });

  check('骑行分档：休闲明显低于公路车，未选强度时用中档默认', () => {
    const burn = (intensity) => nutrition.estimateBurn({ type: 'bike', intensity, minutes: 30, weightKg: 70 });
    eq(burn('casual'), Math.round((4.0 - 1) * 70 * 0.5));
    eq(burn('commute'), Math.round((6.0 - 1) * 70 * 0.5));
    eq(burn('road'), 245);
    eq(burn('climb'), Math.round((10.0 - 1) * 70 * 0.5));
    ok(burn('casual') < burn('road') * 0.6, '休闲档必须明显低于公路车档');
    ok(burn('road') < burn('climb'), '爬坡档必须高于公路车档');
    // 不选强度：取中档（公路车 8.0）
    eq(nutrition.exerciseMet('bike'), 8.0);
    eq(nutrition.estimateBurn({ type: 'bike', minutes: 30, weightKg: 70 }), 245);
    eq(nutrition.exerciseMet('bike', 'road'), 8.0);
    eq(nutrition.exerciseMet('bike', '  road  '), 8.0, '强度值应 trim');
    eq(nutrition.exerciseMet('bike', '没这档'), 8.0, '未知强度回退该类型的默认 met');
  });

  check('estimateBurn 边界：非正/非有限数一律 0，且不会算出负数', () => {
    eq(nutrition.estimateBurn({ type: 'bike', intensity: 'road', minutes: 0, weightKg: 70 }), 0);
    eq(nutrition.estimateBurn({ type: 'bike', intensity: 'road', minutes: -30, weightKg: 70 }), 0);
    eq(nutrition.estimateBurn({ type: 'bike', intensity: 'road', minutes: 30, weightKg: 0 }), 0);
    eq(nutrition.estimateBurn({ type: 'bike', intensity: 'road', minutes: 30, weightKg: -70 }), 0);
    eq(nutrition.estimateBurn({ minutes: NaN, weightKg: 70 }), 0);
    eq(nutrition.estimateBurn({ minutes: Infinity, weightKg: 70 }), 0);
    eq(nutrition.estimateBurn({ minutes: 30, weightKg: Infinity }), 0);
    eq(nutrition.estimateBurn({ minutes: 'abc', weightKg: 'abc' }), 0);
    eq(nutrition.estimateBurn({}), 0);
    eq(nutrition.estimateBurn(), 0);
    eq(nutrition.estimateBurn(null), 0);
    // 未知类型回退 'other'
    eq(nutrition.estimateBurn({ type: 'no-such-type', minutes: 30, weightKg: 70 }), Math.round((4.0 - 1) * 70 * 0.5));
    // 全表 MET > 1：任何 类型 × 强度 都算不出负数（MET ≤ 1 才可能为负）
    for (const t of nutrition.EXERCISE_TYPES) {
      ok(t.met > 1, `${t.value} 的 met 必须 > 1，否则净消耗会变成负数`);
      ok(nutrition.estimateBurn({ type: t.value, minutes: 30, weightKg: 70 }) >= 0, `${t.value} 算出了负数`);
      for (const i of t.intensities ?? []) ok(i.met > 1, `${t.value}/${i.value} 的 met 必须 > 1`);
    }
  });

  check('EXERCISE_TYPES 结构：≥20 种、value 唯一、都有 group、强度递增、含 6 个旧值', () => {
    const types = nutrition.EXERCISE_TYPES;
    ok(Array.isArray(types), 'EXERCISE_TYPES 必须是数组');
    ok(types.length >= 20, `类型数 ${types.length} 应 ≥ 20`);
    const values = types.map((t) => t.value);
    eq(new Set(values).size, values.length, 'value 必须唯一');
    for (const t of types) {
      ok(typeof t.value === 'string' && t.value.length > 0, 'value 必须是非空字符串');
      ok(typeof t.label === 'string' && t.label.length > 0, `${t.value} 缺 label`);
      ok(typeof t.group === 'string' && t.group.length > 0, `${t.value} 缺 group`);
      ok(Number.isFinite(t.met) && t.met > 1, `${t.value} 的 met 必须是 >1 的有限数`);
      if (t.intensities != null) {
        ok(Array.isArray(t.intensities) && t.intensities.length >= 2, `${t.value} 的 intensities 至少 2 档`);
        let prev = 0;
        for (const i of t.intensities) {
          ok(typeof i.value === 'string' && i.value.length > 0, `${t.value} 的强度缺 value`);
          ok(typeof i.label === 'string' && i.label.length > 0, `${t.value}/${i.value} 缺 label`);
          ok(Number.isFinite(i.met) && i.met > prev, `${t.value} 的强度 met 必须严格递增`);
          prev = i.met;
        }
        eq(t.met, t.intensities[Math.floor(t.intensities.length / 2)].met, `${t.value} 的 met 应取中档`);
      }
    }
    for (const legacy of ['walk', 'jog', 'bike', 'swim', 'strength', 'other']) {
      const hit = types.find((t) => t.value === legacy);
      ok(hit, `历史记录里的 ${legacy} 必须继续有效`);
      ok(hit.label.length > 0, `旧值 ${legacy} 必须能查到标签`);
      ok(nutrition.exerciseMet(legacy) > 1, `旧值 ${legacy} 必须能算出 met`);
    }
    for (const group of ['有氧', '户外', '力量', '球类', '其他']) {
      ok(types.some((t) => t.group === group), `缺分组 ${group}`);
    }
    // 要求 1：整表平均下调 15–30%（净/总 = (MET−1)/MET）
    const avgDrop = types.reduce((sum, t) => sum + 1 / t.met, 0) / types.length;
    ok(avgDrop >= 0.15 && avgDrop <= 0.30, `整表平均降幅 ${(avgDrop * 100).toFixed(1)}% 应落在 15–30%`);
  });

  check('每个类型都能给出有限正 MET，未知类型/强度都有兜底', () => {
    for (const t of nutrition.EXERCISE_TYPES) {
      const met = nutrition.exerciseMet(t.value);
      ok(Number.isFinite(met) && met > 1, `${t.value} 的默认 met 非法`);
      for (const i of t.intensities ?? []) eq(nutrition.exerciseMet(t.value, i.value), i.met);
      eq(nutrition.exerciseMet(t.value, '没这档'), t.met, `${t.value} 未知强度应回退默认 met`);
      eq(nutrition.exerciseMet(t.value, null), t.met);
    }
    const otherMet = nutrition.EXERCISE_TYPES.find((t) => t.value === 'other').met;
    eq(otherMet, 4.0);
    eq(nutrition.exerciseMet('no-such-type'), otherMet);
    eq(nutrition.exerciseMet('no-such-type', 'road'), otherMet);
    eq(nutrition.exerciseMet(''), otherMet);
    eq(nutrition.exerciseMet(null), otherMet);
    eq(nutrition.exerciseMet('walk', 'brisk'), 4.3);
  });
}

// ---------- nutrition: 序列 ----------

function testSeries() {
  check('weightStats 空数据', () => {
    deep(nutrition.weightStats([]), { latest: null, latestDate: null, delta7: null, delta30: null, series: [] });
    deep(nutrition.weightStats(), { latest: null, latestDate: null, delta7: null, delta30: null, series: [] });
    deep(
      nutrition.weightStats([{ date: 'bad', weightKg: 70 }, { date: '2026-10-01', weightKg: 0 }]),
      { latest: null, latestDate: null, delta7: null, delta30: null, series: [] },
    );
  });

  check('weightStats 单条：有最新值，环比为 null', () => {
    const s = nutrition.weightStats([{ date: '2026-10-01', weightKg: 70.04 }]);
    eq(s.latest, 70);
    eq(s.latestDate, '2026-10-01');
    eq(s.delta7, null);
    eq(s.delta30, null);
    deep(s.series, [{ date: '2026-10-01', weightKg: 70 }]);
  });

  check('weightStats 跨月 delta7/delta30 与升序', () => {
    const rows = [
      { date: '2026-09-01', weightKg: 72 },
      { date: '2026-09-20', weightKg: 70.5 },
      { date: '2026-10-01', weightKg: 69 },
    ];
    const s = nutrition.weightStats(rows);
    eq(s.latest, 69);
    eq(s.latestDate, '2026-10-01');
    eq(s.delta7, -1.5); // 10-01 往前 7 天 = 09-24，最近一条是 09-20
    eq(s.delta30, -3); // 10-01 往前 30 天 = 09-01
    deep(s.series.map((p) => p.date), ['2026-09-01', '2026-09-20', '2026-10-01']);
  });

  check('weightStats 窗口内没有更早记录时 delta 为 null', () => {
    const rows = [
      { date: '2026-10-18', weightKg: 70 },
      { date: '2026-10-19', weightKg: 69.5 },
    ];
    const s = nutrition.weightStats(rows);
    eq(s.delta7, null);
    eq(s.delta30, null);
  });

  check('weightStats 乱序输入与同日多条（后者优先）', () => {
    const s = nutrition.weightStats([
      { date: '2026-10-02', weightKg: 68 },
      { date: '2026-10-01', weightKg: 70 },
      { date: '2026-10-01', weightKg: 71 },
    ]);
    deep(s.series, [
      { date: '2026-10-01', weightKg: 71 },
      { date: '2026-10-02', weightKg: 68 },
    ]);
    eq(s.latest, 68);
    eq(s.delta7, null);
  });

  check('groupByDate 分组、顺序与缺失日期', () => {
    const rows = [
      { id: 1, date: '2026-10-02' },
      { id: 2, date: '2026-10-01' },
      { id: 3, date: '2026-10-02' },
      { id: 4 },
    ];
    const g = nutrition.groupByDate(rows);
    ok(g instanceof Map, '应返回 Map');
    eq(g.size, 3);
    deep(g.get('2026-10-02').map((r) => r.id), [1, 3]);
    eq(g.get('2026-10-01').length, 1);
    eq(g.get('').length, 1);
    eq(nutrition.groupByDate().size, 0);
  });
}

// ---------- nutrition: 移动平均 ----------

/** 造一组按日期升序的序列；值原样塞进去（含 NaN/undefined）。 */
function seriesOf(values, start = '2026-10-01') {
  const base = nutrition.parseDateStr(start);
  return values.map((value, i) => {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + i);
    return { date: nutrition.localDateStr(d), value };
  });
}

function testMovingAverage() {
  check('movingAverage 正常 7 点窗口（第 1 点 avg=null）', () => {
    const series = seriesOf([10, 20, 30, 40, 50, 60, 70]);
    const out = nutrition.movingAverage(series, 7);
    eq(out.length, 7);
    deep(out.map((p) => p.avg), [null, 15, 20, 25, 30, 35, 40]);
    deep(out.map((p) => p.date), series.map((p) => p.date));
    deep(out.map((p) => p.value), [10, 20, 30, 40, 50, 60, 70]);
  });

  check('movingAverage 窗口按最近 N 点滑动（window=3）', () => {
    const out = nutrition.movingAverage(seriesOf([10, 20, 30, 40, 50]), 3);
    deep(out.map((p) => p.avg), [null, 15, 20, 30, 40]);
  });

  check('movingAverage 点数 < 2：单点/空/非数组', () => {
    deep(nutrition.movingAverage([{ date: '2026-10-01', value: 70 }]), [
      { date: '2026-10-01', value: 70, avg: null },
    ]);
    deep(nutrition.movingAverage([]), []);
    deep(nutrition.movingAverage(), []);
    deep(nutrition.movingAverage(null), []);
    deep(nutrition.movingAverage(seriesOf([70, 72])).map((p) => p.avg), [null, 71]);
  });

  check('movingAverage 窗口大于序列长度：用全部可用点', () => {
    const out = nutrition.movingAverage(seriesOf([10, 20, 30]), 30);
    deep(out.map((p) => p.avg), [null, 15, 20]);
  });

  check('movingAverage NaN/undefined 点 avg=null 且不进窗口统计', () => {
    const series = [
      { date: '2026-10-01', value: 10 },
      { date: '2026-10-02', value: NaN },
      { date: '2026-10-03', value: 30 },
      { date: '2026-10-04' },
      { date: '2026-10-05', value: 50 },
    ];
    const out = nutrition.movingAverage(series, 7);
    deep(out.map((p) => p.avg), [null, null, 20, null, 30]);
    eq(out[3].value, undefined);
  });

  check('movingAverage 不修改入参且不复用入参对象', () => {
    const series = seriesOf([10, 20, 30]);
    const snapshot = JSON.stringify(series);
    const out = nutrition.movingAverage(series, 7);
    eq(JSON.stringify(series), snapshot, '入参被改坏');
    ok(out[0] !== series[0], '应返回新对象');
    deep(Object.keys(out[0]).sort(), ['avg', 'date', 'value']);
  });

  check('movingAverage window=1：窗口最多 1 个有效点 -> avg 恒为 null', () => {
    deep(nutrition.movingAverage(seriesOf([10, 20, 30, 40]), 1).map((p) => p.avg), [null, null, null, null]);
    // window<=0 按 1 处理，不抛异常
    deep(nutrition.movingAverage(seriesOf([10, 20]), 0).map((p) => p.avg), [null, null]);
  });

  check('movingAverage 平均值保留 1 位小数', () => {
    eq(nutrition.movingAverage(seriesOf([1, 2, 2]), 7)[2].avg, 1.7);
    eq(nutrition.movingAverage(seriesOf([1, 2]), 7)[1].avg, 1.5);
  });
}

// ---------- nutrition: 体重单位换算（斤=0.5kg，存储永远 kg） ----------

function decimalsOf(v) {
  const s = String(v);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

function testWeightUnits() {
  check('WEIGHT_UNITS 顺序与标签（未知单位回退 kg）', () => {
    deep(nutrition.WEIGHT_UNITS, ['kg', 'jin']);
    eq(nutrition.weightUnitLabel('kg'), 'kg');
    eq(nutrition.weightUnitLabel('jin'), '斤');
    eq(nutrition.weightUnitLabel('lb'), 'kg');
    eq(nutrition.weightUnitLabel(undefined), 'kg');
  });

  check('斤换算：90.6kg <-> 181.2斤，kg 原样返回', () => {
    eq(nutrition.kgToUnit(90.6, 'jin'), 181.2);
    eq(nutrition.unitToKg(181.2, 'jin'), 90.6);
    eq(nutrition.kgToUnit(70, 'kg'), 70);
    eq(nutrition.unitToKg(70, 'kg'), 70);
    eq(nutrition.kgToUnit(0, 'jin'), 0);
    eq(nutrition.unitToKg(0, 'jin'), 0);
  });

  check('斤往返无漂移：40–300kg 步进 0.7，误差 ≤0.05kg', () => {
    let checked = 0;
    for (let i = 0; 40 + i * 0.7 <= 300; i += 1) {
      const kg = 40 + i * 0.7;
      const back = nutrition.unitToKg(nutrition.kgToUnit(kg, 'jin'), 'jin');
      ok(Math.abs(back - kg) <= 0.05, `${kg}kg 往返后变成 ${back}`);
      checked += 1;
    }
    ok(checked > 300, `样本太少：${checked}`);
  });

  check('精度：斤 ≤1 位小数，kg ≤2 位小数，无浮点尾巴', () => {
    for (const kg of [40, 55.55, 70, 90.6, 123.45, 299.9]) {
      const jin = nutrition.kgToUnit(kg, 'jin');
      ok(decimalsOf(jin) <= 1, `kgToUnit(${kg},'jin')=${jin} 超过 1 位小数`);
      const back = nutrition.unitToKg(jin, 'jin');
      ok(decimalsOf(back) <= 2, `unitToKg(${jin},'jin')=${back} 超过 2 位小数`);
      ok(!/0000000/.test(String(jin)) && !/0000000/.test(String(back)), `出现浮点尾巴：${jin} / ${back}`);
    }
  });

  check('步长与刻度区间（两套单位边界换算一致）', () => {
    eq(nutrition.weightStep('kg'), 0.1);
    eq(nutrition.weightStep('jin'), 0.2);
    eq(nutrition.weightStep('lb'), 0.1);
    deep(nutrition.weightRange('kg'), { min: 20, max: 300 });
    deep(nutrition.weightRange('jin'), { min: 40, max: 600 });
    deep(nutrition.weightRange('lb'), { min: 20, max: 300 });
    eq(nutrition.kgToUnit(20, 'jin'), nutrition.weightRange('jin').min);
    eq(nutrition.kgToUnit(300, 'jin'), nutrition.weightRange('jin').max);
    // 返回的是副本，改它不会污染下一次调用
    const range = nutrition.weightRange('jin');
    range.min = 1;
    eq(nutrition.weightRange('jin').min, 40);
  });

  check('未知单位按 kg 处理且不抛异常', () => {
    eq(nutrition.kgToUnit(70, 'lb'), 70);
    eq(nutrition.unitToKg(70, 'lb'), 70);
    eq(nutrition.kgToUnit(70), 70);
    eq(nutrition.unitToKg(70), 70);
    eq(nutrition.kgToUnit(NaN, 'jin'), 0);
    eq(nutrition.unitToKg(Infinity, 'jin'), 0);
  });
}

// ---------- pure: 整形与去重 ----------

function testNormalize() {
  check('normalizeMealItem 取整与可选字段', () => {
    const it = pure.normalizeMealItem({
      name: ' 米饭 ',
      grams: 199.96,
      kcal: 232.6,
      carb: 51.84,
      protein: 5.24,
      fat: 0.64,
      fiber: 0.6,
      sodium: 2.2,
      confidence: 'high',
      foodId: 'f_rice',
    });
    deep(it, {
      name: '米饭',
      grams: 200,
      kcal: 233,
      carb: 51.8,
      protein: 5.2,
      fat: 0.6,
      fiber: 0.6,
      sodium: 2.2,
      confidence: 'high',
      foodId: 'f_rice',
    });
    const minimal = pure.normalizeMealItem({ name: 'x' });
    ok(!('fiber' in minimal), '缺 fiber 不应补键');
    ok(!('confidence' in minimal), '非法 confidence 应丢弃');
    eq(pure.normalizeMealItem(null), null);
    eq(pure.normalizeItems([null, { name: 'a' }]).length, 1);
    deep(pure.normalizeItems(), []);
  });

  check('normalizeWeightRecord 校验与 id 保留', () => {
    const r = pure.normalizeWeightRecord({ id: 7, date: '2026-10-01', weightKg: 70.44, bodyFatPct: 18.24, note: ' 晨起 ', createdAt: 1 });
    deep(r, { date: '2026-10-01', weightKg: 70.4, id: 7, bodyFatPct: 18.2, note: '晨起', createdAt: 1 });
    eq(pure.normalizeWeightRecord({ date: '2026-10-01', weightKg: 0 }), null);
    eq(pure.normalizeWeightRecord({ date: 'nope', weightKg: 70 }), null);
    eq(pure.normalizeWeightRecord(null), null);
  });

  check('normalizeWaterRecord 归零即丢弃', () => {
    deep(pure.normalizeWaterRecord({ date: '2026-10-01', ml: 250.4 }), { date: '2026-10-01', ml: 250 });
    eq(pure.normalizeWaterRecord({ date: '2026-10-01', ml: 0 }), null);
    eq(pure.normalizeWaterRecord({ date: '2026-10-01', ml: -50 }), null);
    eq(pure.normalizeWaterRecord({ date: '', ml: 250 }), null);
  });

  check('normalizeMealRecord 槽位/source 兜底', () => {
    const r = pure.normalizeMealRecord({ date: '2026-10-01', slot: 'brunch', source: 'x', items: [{ name: 'a' }], createdAt: 5 });
    eq(r.slot, 'snack');
    eq(r.source, 'manual');
    eq(r.items.length, 1);
    eq(pure.normalizeMealRecord({ date: '2026-10-01', slot: 'lunch', source: 'ai' }).source, 'ai');
    eq(pure.normalizeMealRecord({ slot: 'lunch' }), null);
  });

  check('normalizeExerciseRecord 默认类型与取整', () => {
    const r = pure.normalizeExerciseRecord({ date: '2026-10-01', minutes: 30.44, kcalBurned: 280.6, createdAt: 1 });
    eq(r.type, '其他');
    eq(r.minutes, 30.4);
    eq(r.kcalBurned, 281);
    eq(pure.normalizeExerciseRecord({}), null);
  });

  check('keyOf 按 store 选择 date/id/内容指纹', () => {
    eq(pure.keyOf('weights', { id: 1, date: '2026-10-01' }), 'date:2026-10-01');
    eq(pure.keyOf('waters', { date: '2026-10-01' }), 'date:2026-10-01');
    eq(pure.keyOf('meals', { id: 3, date: '2026-10-01' }), 'id:3');
    // 指纹格式已随 MEAL_REIMPORT_DOUBLES 修复改为内容摘要（不再带 createdAt），断言同步更新为精确值
    eq(pure.keyOf('meals', { date: '2026-10-01', slot: 'lunch', createdAt: 9 }), 'fk:2026-10-01:lunch:741638a509dad92d');
    eq(pure.keyOf('meals', { date: '2026-10-01', slot: 'lunch' }), 'fk:2026-10-01:lunch:741638a509dad92d', 'createdAt 不参与指纹');
    ok(pure.keyOf('exercises', { date: '2026-10-01', type: '慢跑', minutes: 30, kcalBurned: 280 }).startsWith('fk:'));
  });

  check('dedupeByKey / pickNewRows / planImport', () => {
    const dupe = pure.dedupeByKey(
      [{ date: '2026-10-01', weightKg: 70 }, { date: '2026-10-01', weightKg: 71 }],
      (r) => pure.keyOf('weights', r),
    );
    deep(dupe, [{ date: '2026-10-01', weightKg: 71 }]);

    const add = pure.pickNewRows(
      [{ date: '2026-10-01' }],
      [{ date: '2026-10-01' }, { date: '2026-10-02' }],
      (r) => pure.keyOf('weights', r),
    );
    deep(add, [{ date: '2026-10-02' }]);

    // replace：existing 为空 -> 全部写入
    const replacePlan = pure.planImport('weights', [], [
      { date: '2026-10-01', weightKg: 70 },
      { date: '2026-10-01', weightKg: 71 },
      { date: '2026-10-02', weightKg: 72 },
      { date: 'bad', weightKg: 1 },
    ]);
    eq(replacePlan.length, 2);
    eq(replacePlan[0].weightKg, 71);

    // merge：已有日期不覆盖
    const mergePlan = pure.planImport('weights', [{ date: '2026-10-01', weightKg: 65 }], [
      { date: '2026-10-01', weightKg: 70 },
      { date: '2026-10-02', weightKg: 72 },
    ]);
    deep(mergePlan.map((r) => r.date), ['2026-10-02']);
  });
}

// ---------- pure: 运动记录的强度字段 ----------

function testExerciseRecordShape() {
  check('normalizeExerciseRecord 保留合法 intensity，丢弃超长/非字符串', () => {
    const base = { date: '2026-10-01', type: 'bike', minutes: 30, kcalBurned: 245, createdAt: 1 };
    eq(pure.normalizeExerciseRecord({ ...base, intensity: '  road  ' }).intensity, 'road', 'intensity 应 trim 后落库');
    eq('intensity' in pure.normalizeExerciseRecord(base), false, '缺字段不落键');
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: '' }), false, '空串不落键');
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: '   ' }), false, '全空白不落键');
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: 123 }), false, '非字符串丢弃');
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: null }), false);
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: {} }), false, '对象丢弃');
    eq('intensity' in pure.normalizeExerciseRecord({ ...base, intensity: 'x'.repeat(17) }), false, '17 字符超长丢弃');
    eq(pure.normalizeExerciseRecord({ ...base, intensity: 'x'.repeat(16) }).intensity, 'x'.repeat(16), '16 字符是边界，保留');
    // 其余字段语义不变
    const r = pure.normalizeExerciseRecord({ ...base, intensity: 'road', minutes: 30.44 });
    eq(r.type, 'bike');
    eq(r.minutes, 30.4);
    eq(r.kcalBurned, 245);
    eq(pure.normalizeExerciseRecord({}), null);
  });

  check('keyOf 与 CSV 导出不受 intensity 影响（列不变）', () => {
    const row = { date: '2026-10-01', type: 'bike', minutes: 30, kcalBurned: 245, intensity: 'road' };
    ok(pure.keyOf('exercises', row).startsWith('fk:'), '无 id 时仍走内容指纹');
    eq(
      pure.keyOf('exercises', row),
      pure.keyOf('exercises', { ...row, intensity: 'climb' }),
      '内容指纹不应因强度改变（历史导出照旧去重）',
    );
    eq(pure.keyOf('exercises', { id: 7, ...row }), 'id:7');

    const csv = pure.buildCSV({ exercises: [{ ...row, note: '通勤', createdAt: 5 }] });
    ok(csv.includes('date,type,minutes,kcalBurned,note,createdAt'), '运动段表头必须保持不变');
    eq(csv.includes('intensity'), false, 'CSV 不应新增 intensity 列');
    eq(csv.includes('road'), false, '强度值不应出现在 CSV 里');
    ok(csv.includes('2026-10-01,bike,30,245,通勤,5'), '行内容保持旧格式');
  });
}

// ---------- pure: 套餐模板 / 最近吃过 ----------

function testMealTemplatePure() {
  check('normalizeMealTemplates 过滤脏数据并兜底 slot', () => {
    deep(pure.normalizeMealTemplates(null), []);
    deep(pure.normalizeMealTemplates('oops'), []);
    const rows = pure.normalizeMealTemplates([
      null,
      { id: 't1', name: ' 早餐 ', slot: 'lunch', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
      { id: 't2', name: '' },
      { name: '无 id' },
      { id: 't1', name: '重复 id' },
      { id: 't3', name: '加餐', slot: 'brunch', items: 'bad' },
    ]);
    deep(rows.map((t) => t.id), ['t1', 't3']);
    eq(rows[0].name, '早餐');
    eq(rows[1].slot, 'snack');
    deep(rows[1].items, []);
  });

  check('planMealTemplateSave 同名覆盖保留原 id，空名抛中文错', () => {
    const first = pure.planMealTemplateSave(
      [],
      { name: ' 减脂早餐 ', slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
      1000,
    );
    eq(first.template.id, '1000');
    eq(first.template.name, '减脂早餐');
    eq(first.templates.length, 1);

    const second = pure.planMealTemplateSave(
      first.templates,
      { name: '减脂早餐', slot: 'lunch', items: [{ name: '牛奶', grams: 250, kcal: 140 }] },
      2000,
    );
    eq(second.templates.length, 1, '同名不应新增第二条');
    eq(second.template.id, '1000', '同名覆盖必须保留原 id');
    eq(second.template.slot, 'lunch');
    eq(second.template.items[0].name, '牛奶');

    let msg = '';
    try {
      pure.planMealTemplateSave([], { name: '   ' });
    } catch (err) {
      msg = err.message;
    }
    eq(msg, '套餐名称不能为空');

    // 同一毫秒内连存两个新套餐：id 顺延，不能互顶
    const a = pure.planMealTemplateSave([], { name: 'A' }, 5000);
    const b = pure.planMealTemplateSave(a.templates, { name: 'B' }, 5000);
    ok(b.template.id !== a.template.id, '同毫秒新建应顺延 id');
    deep(pure.removeMealTemplate(b.templates, a.template.id).map((t) => t.name), ['B']);
    deep(pure.removeMealTemplate(b.templates, '不存在').map((t) => t.name), ['A', 'B']);
  });

  check('normalizeMealTemplates 老记录无 kind 补 meal，整日套餐按 kind=day 归一化', () => {
    const rows = pure.normalizeMealTemplates([
      { id: 'old1', name: '老单餐', slot: 'lunch', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
      {
        id: 'day1',
        name: '整日',
        kind: 'day',
        meals: [
          { slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
          { slot: 'brunch', items: [{ name: '牛奶', grams: 250, kcal: 140 }] },
          { slot: 'dinner', items: [] },
        ],
      },
      { id: 'day2', name: '只剩一餐', kind: 'day', meals: [{ slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] }] },
      { id: 'day3', name: '坏整日', kind: 'day', meals: 'oops' },
    ]);
    deep(rows.map((t) => t.id), ['old1', 'day1']);
    eq(rows[0].kind, 'meal', '老记录必须归一化成单餐套餐');
    eq(rows[0].slot, 'lunch');
    eq(rows[0].items[0].name, '米饭');
    eq(rows[0].items[0].grams, 150);
    eq('meals' in rows[0], false, '单餐套餐不应带 meals 键');
    eq(rows[1].kind, 'day');
    deep(rows[1].meals.map((m) => m.slot), ['breakfast', 'snack'], '非法 slot 回退 snack，空 items 餐次剔除');
    eq('slot' in rows[1], false, '整日套餐不应带单餐 slot 键');
  });

  check('normalizeDayMeals 非数组/非对象条目一律丢弃', () => {
    deep(pure.normalizeDayMeals('oops'), []);
    deep(pure.normalizeDayMeals(null), []);
    deep(pure.normalizeDayMeals([null, 'x', { slot: 'lunch' }]), []);
  });

  check('planDayTemplateSave 同名覆盖保留 id，空名/不足两餐抛中文错', () => {
    const first = pure.planDayTemplateSave(
      [],
      {
        name: ' 整日减脂餐 ',
        meals: [
          { slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
          { slot: 'lunch', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
        ],
      },
      3000,
    );
    eq(first.template.id, '3000');
    eq(first.template.name, '整日减脂餐');
    eq(first.template.kind, 'day');
    deep(first.template.meals.map((m) => m.slot), ['breakfast', 'lunch']);
    eq(first.templates.length, 1);

    const second = pure.planDayTemplateSave(
      first.templates,
      {
        name: '整日减脂餐',
        meals: [
          { slot: 'lunch', items: [{ name: '鸡胸肉', grams: 100, kcal: 133 }] },
          { slot: 'dinner', items: [{ name: '西兰花', grams: 200, kcal: 68 }] },
          { slot: 'brunch', items: [{ name: '酸奶', grams: 100, kcal: 72 }] },
          { slot: 'snack', items: [] },
        ],
      },
      4000,
    );
    eq(second.templates.length, 1, '同名不应新增第二条');
    eq(second.template.id, '3000', '同名覆盖必须保留原 id');
    deep(second.template.meals.map((m) => m.slot), ['lunch', 'dinner', 'snack']);
    eq(second.template.meals[2].items[0].name, '酸奶');

    for (const [input, expected] of [
      [{ name: '   ', meals: first.template.meals }, '套餐名称不能为空'],
      [{ name: '零餐' }, '整日套餐至少要两餐'],
      [{ name: '全非法', meals: [{ slot: 'lunch', items: [] }, null, 'oops'] }, '整日套餐至少要两餐'],
      [{ name: '只剩一餐', meals: [{ slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] }] }, '整日套餐至少要两餐'],
    ]) {
      let msg = '';
      try {
        pure.planDayTemplateSave([], input);
      } catch (err) {
        msg = err.message;
      }
      eq(msg, expected);
    }

    // 同名覆盖是跨种类的：整日套餐用掉的名字，单餐套餐也能覆盖回来（反之亦然）
    const asMeal = pure.planMealTemplateSave(second.templates, { name: '整日减脂餐', slot: 'dinner', items: [] }, 6000);
    eq(asMeal.templates.length, 1);
    eq(asMeal.template.id, '3000');
    eq(asMeal.template.kind, 'meal');
    eq('meals' in asMeal.template, false);
  });
}

function testRecentFoodItemsPure() {
  const d0 = nutrition.daysAgo(0);
  const d1 = nutrition.daysAgo(1);
  const d2 = nutrition.daysAgo(2);
  const meals = [
    { date: d2, slot: 'dinner', createdAt: 200, items: [{ name: '米饭', kcal: 200 }, { name: '西兰花', kcal: 34 }] },
    { date: d0, slot: 'breakfast', createdAt: 100, items: [{ name: '米饭', kcal: 232 }, { name: '鸡蛋', kcal: 90 }] },
    { date: d0, slot: 'lunch', createdAt: 300, items: [{ name: '米饭', kcal: 260 }, { name: '鸡胸肉', kcal: 248 }] },
    { date: d1, slot: 'snack', createdAt: 50, items: [{ name: '牛奶', kcal: 140 }] },
  ];

  check('collectRecentFoodItems 日期/createdAt 降序 + 按名字去重保留最新', () => {
    const out = pure.collectRecentFoodItems(meals, 12);
    deep(out.map((r) => r.name), ['米饭', '鸡胸肉', '鸡蛋', '牛奶', '西兰花']);
    eq(out[0].lastDate, d0);
    eq(out[0].slot, 'lunch');
    eq(out[0].item.kcal, 260, '同名应保留最新一次出现的条目信息');
    eq(out[2].slot, 'breakfast');
    eq(out[3].lastDate, d1);
    eq(out[4].lastDate, d2);
  });

  check('collectRecentFoodItems limit 在去重之后生效', () => {
    deep(pure.collectRecentFoodItems(meals, 2).map((r) => r.name), ['米饭', '鸡胸肉']);
    deep(pure.collectRecentFoodItems(meals, 0), []);
    eq(pure.collectRecentFoodItems(meals).length, 5);
  });

  check('collectRecentFoodItems 只取最近 200 条 meals', () => {
    const many = [];
    for (let i = 0; i < 205; i += 1) {
      many.push({ date: d0, slot: 'snack', createdAt: i, items: [{ name: `食物${i}` }] });
    }
    const out = pure.collectRecentFoodItems(many, 500);
    eq(out.length, 200);
    eq(out[0].name, '食物204');
    ok(!out.some((r) => r.name === '食物4'), '最老的 5 条不应参与计算');
  });
}

// ---------- pure: 聚合与 CSV ----------

function testAggregate() {
  const meals = [
    { id: 2, date: '2026-10-01', slot: 'lunch', createdAt: 20, items: [{ kcal: 248, carb: 0, protein: 46.5, fat: 5.4 }] },
    {
      id: 1,
      date: '2026-10-01',
      slot: 'breakfast',
      createdAt: 10,
      items: [{ kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6, fiber: 0.6, sodium: 2.2 }],
    },
  ];

  check('aggregateMeals 跨餐次累加纤维与钠', () => {
    const agg = pure.aggregateMeals(meals);
    eq(agg.kcal, 480);
    eq(agg.carb, 51.8);
    eq(agg.protein, 51.7);
    eq(agg.fat, 6);
    eq(agg.fiber, 0.6);
    eq(agg.sodium, 2.2);
    deep(pure.aggregateMeals([]), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
  });

  check('burnedOf / waterOf', () => {
    eq(pure.burnedOf([{ kcalBurned: 280 }, { kcalBurned: 120.4 }]), 400);
    eq(pure.burnedOf([]), 0);
    eq(pure.burnedOf(), 0);
    eq(pure.waterOf({ ml: 1250 }), 1250);
    eq(pure.waterOf(1250), 1250);
    eq(pure.waterOf(null), 0);
  });

  check('buildDaySummary 一次给全（含 meals 排序与 netKcal）', () => {
    const s = pure.buildDaySummary({
      date: '2026-10-01',
      meals,
      exercises: [{ kcalBurned: 280 }, { kcalBurned: 20 }],
      water: { ml: 1250 },
      weight: { date: '2026-10-01', weightKg: 70 },
    });
    eq(s.date, '2026-10-01');
    eq(s.intake.kcal, 480);
    eq(s.burned, 300);
    eq(s.water, 1250);
    eq(s.netKcal, 180);
    eq(s.weight.weightKg, 70);
    deep(s.meals.map((m) => m.id), [1, 2]);
    eq(s.exercises.length, 2);
  });

  check('buildDaySummary 空输入不炸', () => {
    const s = pure.buildDaySummary({ date: '2026-10-01' });
    eq(s.intake.kcal, 0);
    eq(s.burned, 0);
    eq(s.water, 0);
    eq(s.netKcal, 0);
    eq(s.weight, null);
    deep(s.meals, []);
    deep(s.exercises, []);
    deep(pure.buildDaySummary().meals, []);
  });

  check('buildRangeRows 区间闭区间、跨月、只输出有数据的日期', () => {
    const rows = pure.buildRangeRows({
      fromDate: '2026-09-01',
      toDate: '2026-10-31',
      weights: [{ date: '2026-09-30', weightKg: 71 }, { date: '2026-11-01', weightKg: 60 }],
      meals: [
        { date: '2026-10-01', items: [{ kcal: 500, carb: 60, protein: 30, fat: 10 }] },
        { date: '2026-10-03', items: [{ kcal: 300, carb: 20, protein: 20, fat: 10 }] },
        { date: '2026-08-30', items: [{ kcal: 999 }] },
      ],
      exercises: [{ date: '2026-10-01', kcalBurned: 280 }],
      waters: [{ date: '2026-10-01', ml: 1250 }, { date: '2026-10-02', ml: 0 }],
    });
    deep(rows.map((r) => r.date), ['2026-09-30', '2026-10-01', '2026-10-03']);
    deep(rows[0], { date: '2026-09-30', kcal: 0, carb: 0, protein: 0, fat: 0, burned: 0, water: 0, weightKg: 71 });
    eq(rows[1].kcal, 500);
    eq(rows[1].burned, 280);
    eq(rows[1].water, 1250);
    eq(rows[1].weightKg, null);
    eq(rows[2].kcal, 300);
  });

  check('buildCSV 四段 + BOM + 转义', () => {
    const csv = pure.buildCSV({
      weights: [{ id: 1, date: '2026-10-01', weightKg: 70.5, bodyFatPct: 18.2, note: '晨起', createdAt: 1 }],
      meals: [
        {
          id: 1,
          date: '2026-10-01',
          slot: 'lunch',
          source: 'ai',
          createdAt: 2,
          items: [{ name: '米饭,"大碗"', grams: 200, kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6 }],
        },
      ],
      exercises: [{ id: 1, date: '2026-10-01', type: '慢跑', minutes: 30, kcalBurned: 280, createdAt: 3 }],
      waters: [{ id: 1, date: '2026-10-01', ml: 1250 }],
    });
    ok(csv.startsWith('\ufeff'), '应以 BOM 开头');
    for (const head of ['# 体重', '# 饮食明细', '# 运动', '# 饮水']) {
      ok(csv.includes(head), `缺少段落：${head}`);
    }
    ok(csv.includes('"米饭,""大碗"""'), '含逗号引号的字段应转义');
    ok(csv.includes('2026-10-01,lunch,'), '饮食明细应逐条目成行');
    ok(csv.includes('\r\n'), '应使用 CRLF');
    ok(pure.buildCSV({}).includes('# 饮水'), '空数据也应输出表头');
  });
}

// ---------- 往返：导出 → 清空 → 导入 ----------

const RT_DATE = '2026-10-19';

function roundTripDataset() {
  return {
    weights: [{ id: 1, date: RT_DATE, weightKg: 70.5, bodyFatPct: 18.2, note: '晨起', createdAt: 100 }],
    meals: [
      {
        id: 1,
        date: RT_DATE,
        slot: 'breakfast',
        source: 'manual',
        createdAt: 110,
        items: [{ name: '米饭', grams: 200, kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6, fiber: 0.6, sodium: 2.2 }],
      },
      {
        id: 2,
        date: RT_DATE,
        slot: 'lunch',
        source: 'ai',
        createdAt: 120,
        rawAiText: '{"items":[]}',
        items: [
          { name: '鸡胸肉', grams: 150, kcal: 248, carb: 0, protein: 46.5, fat: 5.4 },
          { name: '西兰花', grams: 100, kcal: 34, carb: 6.6, protein: 2.8, fat: 0.4, fiber: 2.6, sodium: 18.8 },
        ],
      },
    ],
    exercises: [{ id: 1, date: RT_DATE, type: '慢跑', minutes: 30, kcalBurned: 280, createdAt: 130 }],
    waters: [{ id: 1, date: RT_DATE, ml: 1250 }],
  };
}

// 与 store.daySummary 的取数方式一致：按 by_date 索引取当日那一条
function summaryOf(data) {
  return pure.buildDaySummary({
    date: RT_DATE,
    meals: data.meals.filter((m) => m.date === RT_DATE),
    exercises: data.exercises.filter((e) => e.date === RT_DATE),
    water: data.waters.find((w) => w.date === RT_DATE) ?? 0,
    weight: data.weights.find((w) => w.date === RT_DATE) ?? null,
  });
}

function testRoundTrip() {
  const data = roundTripDataset();
  const before = summaryOf(data);
  // 走一遍真实的 JSON 序列化：这就是 exportJSON → 文件 → importJSON 的数据形态
  const exported = JSON.parse(JSON.stringify({ app: 'hms', schemaVersion: 1, exportedAt: new Date().toISOString(), ...data }));
  // replace：existing 为空
  const imported = {
    weights: pure.planImport('weights', [], exported.weights),
    meals: pure.planImport('meals', [], exported.meals),
    exercises: pure.planImport('exercises', [], exported.exercises),
    waters: pure.planImport('waters', [], exported.waters),
  };
  const after = summaryOf(imported);

  check('往返无损：导出→清空→导入后 daySummary 完全一致', () => {
    deep(after, before);
  });

  check('往返无损：条数与关键数值对得上', () => {
    eq(imported.weights.length, 1);
    eq(imported.meals.length, 2);
    eq(imported.meals[1].items.length, 2);
    eq(imported.exercises.length, 1);
    eq(imported.waters.length, 1);
    eq(after.intake.kcal, 514);
    eq(after.intake.carb, 58.4);
    eq(after.intake.protein, 54.5);
    eq(after.intake.fat, 6.4);
    eq(after.intake.fiber, 3.2);
    eq(after.intake.sodium, 21);
    eq(after.burned, 280);
    eq(after.water, 1250);
    eq(after.netKcal, 234);
    eq(after.weight.weightKg, 70.5);
    eq(exported.schemaVersion, 1);
    ok(typeof exported.exportedAt === 'string');
  });

  check('replace 语义：空 existing 全量写入，id/date 原样保留', () => {
    deep(imported.meals.map((m) => m.id), [1, 2]);
    eq(imported.weights[0].date, RT_DATE);
    eq(imported.meals[1].rawAiText, '{"items":[]}');
    eq(imported.meals[0].source, 'manual');
  });

  check('merge 幂等：同一份备份再导入一次不新增任何记录', () => {
    for (const name of pure.BUSINESS_STORES) {
      eq(pure.planImport(name, imported[name], exported[name]).length, 0, `${name} 第二次导入不应写入`);
    }
  });
}

// ---------- 边界守卫：纯模块不得引用 DOM/网络 ----------

function testPurity() {
  check('nutrition.js / pure.js 源码不含 DOM / fetch / indexedDB', () => {
    for (const file of ['nutrition.js', 'pure.js']) {
      const src = sourceOf(file);
      for (const token of ['document', 'window', 'indexedDB', 'localStorage', 'fetch(']) {
        ok(!src.includes(token), `${file} 不应出现 ${token}`);
      }
    }
  });
}

// ---------- db.js / store.js 的契约面 ----------

const DB_EXPORTS = [
  'openDb', 'getAll', 'get', 'put', 'del', 'getOneByIndex', 'getAllByIndex',
  'deleteAll', 'getMeta', 'setMeta', 'dumpAll', 'loadAll', 'clearBusinessData',
  // 自动同步的接线点（缺口 4）：注册 / 注销写入通知与静默窗口
  'onMutation', 'withMutedMutations',
  // 多账号：库名可切换，否则账号切换对存储层无效
  'getDbName', 'setDbName', 'resetDbConnection', 'prepareDatabase',
];
const ACCOUNT_EXPORTS = [
  'listAccounts', 'getActiveAccount', 'setActiveAccount', 'createAccount',
  'renameAccount', 'removeAccount', 'ensureDefaultAccount', 'dbNameForAccount',
];
const STORE_EXPORTS = [
  'getProfile', 'saveProfile', 'getGoals', 'saveGoals', 'computeDefaultGoals', 'getSettings', 'saveSettings',
  'logWeight', 'deleteWeight', 'logMeal', 'updateMeal', 'deleteMeal', 'logExercise', 'deleteExercise',
  'getWater', 'setWater', 'addWater', 'savePhoto', 'getPhoto', 'daySummary', 'rangeSummary',
  'recentWeights', 'exportJSON', 'importJSON', 'exportCSV', 'clearAllData',
  'getMealTemplates', 'saveMealTemplate', 'saveDayTemplate', 'deleteMealTemplate',
  'recentFoodItems', 'markExported', 'exportStatus',
  'currentAccount', 'switchAccount',
  // 云同步的纯数据面（网络在阶段 3 的适配器里）
  'getSyncState', 'setSyncState', 'clearSyncState', 'getSyncPayload',
];

async function testModules() {
  check('db.js 导出契约完整', () => {
    for (const name of DB_EXPORTS) eq(typeof db[name], 'function', `db.${name} 缺失`);
  });

  check('store.js 导出契约完整', () => {
    for (const name of STORE_EXPORTS) eq(typeof store[name], 'function', `store.${name} 缺失`);
  });

  await checkAsync('openDb 在无 indexedDB 时抛明确中文错误', async () => {
    if (!IDB_ABSENT) return;
    let caught = null;
    try {
      await db.openDb();
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof Error, '应抛出 Error');
    eq(caught.message, IDB_MSG);
  });

  await checkAsync('openDb 失败不缓存：第二次仍抛同一错误', async () => {
    if (!IDB_ABSENT) return;
    let msg = '';
    try {
      await db.openDb();
    } catch (err) {
      msg = err.message;
    }
    eq(msg, IDB_MSG);
  });

  await checkAsync('isAvailable 在无 indexedDB 时返回 false', async () => {
    if (!IDB_ABSENT) return;
    eq(await db.isAvailable(), false);
  });

  await checkAsync('getMeta / dumpAll / loadAll 都把不可用转成中文错误', async () => {
    if (!IDB_ABSENT) return;
    for (const call of [
      () => db.getMeta('profile'),
      () => db.dumpAll(),
      () => db.loadAll({ weights: [] }, 'merge'),
      () => db.getAll('meals'),
      () => db.put('weights', { date: RT_DATE, weightKg: 70 }),
    ]) {
      let msg = '';
      try {
        await call();
      } catch (err) {
        msg = err.message;
      }
      eq(msg, IDB_MSG);
    }
  });

  await checkAsync('store 的读路径把不可用错误透传给视图层', async () => {
    if (!IDB_ABSENT) return;
    for (const call of [() => store.getProfile(), () => store.getGoals(), () => store.daySummary(RT_DATE), () => store.getWater(RT_DATE)]) {
      let msg = '';
      try {
        await call();
      } catch (err) {
        msg = err.message;
      }
      eq(msg, IDB_MSG);
    }
  });

  await checkAsync('computeDefaultGoals 无档案时给安全默认值（不落库、不抛错）', async () => {
    deep(await store.computeDefaultGoals(null), {
      calorieTarget: 1800,
      carbPct: 50,
      proteinPct: 20,
      fatPct: 30,
      waterMl: 2000,
      weightTargetKg: null,
    });
  });

  await checkAsync('computeDefaultGoals 有档案但无体重时也返回可用的目标', async () => {
    const goals = await store.computeDefaultGoals({
      nickname: '我',
      sex: 'male',
      birthday: '1990-01-01',
      heightCm: 175,
      activity: 'light',
      weightTargetKg: 65,
    });
    ok(goals.calorieTarget >= 1200 && goals.calorieTarget <= 4000, `热量目标越界：${goals.calorieTarget}`);
    eq(goals.waterMl % 50, 0);
    eq(goals.carbPct + goals.proteinPct + goals.fatPct, 100);
    eq(goals.weightTargetKg, 65);
  });

  await checkAsync('importJSON 拒绝非对象载荷', async () => {
    let msg = '';
    try {
      await store.importJSON(null, 'merge');
    } catch (err) {
      msg = err.message;
    }
    ok(msg.includes('导入失败'), `应提示导入失败，实际：${msg}`);
  });
}

// ---------- store: weightUnit 持久化（Node 没有 indexedDB，用最小假实现真跑一遍） ----------

/**
 * 只够 db.js 跑通的假 IndexedDB：meta 的 get/put + schema 建表。
 * 用完必须把 dbPromise 缓存也清掉（调 db 实例的 onversionchange），
 * 否则后面的「IDB 不可用」断言会拿到这个假库而假通过。
 */
function createFakeIndexedDb(options = {}) {
  // persistent：同名库在多次 open 之间保留数据（真浏览器就是这样），账号隔离用例必须用它
  // deleteBlocked：deleteDatabase 永远 onblocked，模拟别的标签页占着不让删
  const persistent = !!options.persistent;
  const deleteBlocked = !!options.deleteBlocked;
  const databases = [];
  const byName = new Map();
  const opened = [];
  const deleted = [];
  const closes = [];
  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  class FakeRequest {
    constructor(tx, run) {
      this.tx = tx;
      this.result = undefined;
      this.error = null;
      this._run = run;
      this._ok = null;
      this._err = null;
      if (tx) tx.pending += 1;
      setTimeout(() => this.fire(), 0);
    }
    set onsuccess(fn) { this._ok = fn; }
    set onerror(fn) { this._err = fn; }
    fire() {
      try {
        this.result = this._run();
      } catch (err) {
        this.error = err;
        if (this._err) this._err();
        if (this.tx) this.tx.settle();
        return;
      }
      if (this._ok) this._ok();
      if (this.tx) this.tx.settle();
    }
  }

  class FakeStore {
    constructor(name, options = {}) {
      this.name = name;
      this.keyPath = options.keyPath;
      this.autoIncrement = !!options.autoIncrement;
      this.data = new Map();
      this.indexes = new Map();
      this.seq = 0;
    }
    createIndex(name, keyPath) { this.indexes.set(name, { keyPath }); }
    nextKey(obj) {
      if (this.keyPath) {
        if (obj[this.keyPath] != null) return obj[this.keyPath];
        if (this.autoIncrement) { this.seq += 1; obj[this.keyPath] = this.seq; return this.seq; }
        throw new Error('keyPath 为空且未启用 autoIncrement');
      }
      this.seq += 1;
      return this.seq;
    }
    get(key) { const v = this.data.get(key); return v === undefined ? undefined : clone(v); }
    getAll() { return [...this.data.values()].map(clone); }
    put(obj) { const key = this.nextKey(obj); this.data.set(key, clone(obj)); return key; }
    delete(key) { this.data.delete(key); }
    clear() { this.data.clear(); }
    count() { return this.data.size; }
    index(name) {
      const def = this.indexes.get(name);
      if (!def) throw new Error(`没有索引 ${name}`);
      const self = this;
      return {
        get(value) {
          const hit = [...self.data.values()].find((row) => row[def.keyPath] === value);
          return hit === undefined ? undefined : clone(hit);
        },
        getAll(value) {
          return [...self.data.values()].filter((row) => row[def.keyPath] === value).map(clone);
        },
      };
    }
  }

  class FakeTransaction {
    constructor(stores, mode) {
      this.stores = stores;
      this.mode = mode;
      this.pending = 0;
      this.settled = false;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
    // 真实 IDB 里「一个请求都没发」的写事务照样会提交并触发 oncomplete；
    // 不补这一条，零请求的写事务（db.loadAll 传空数组时就会出现）会永远挂着，
    // 整套用例会被静默截断：进程 0 退出、连汇总都不打印。
    setTimeout(() => {
      if (this.pending !== 0 || this.settled) return;
      this.settled = true;
      setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
    }, 0);
    }
    objectStore(name) {
      const store = this.stores[name];
      if (!store) throw new Error(`没有 store ${name}`);
      const tx = this;
      return {
        get: (key) => new FakeRequest(tx, () => store.get(key)),
        getAll: () => new FakeRequest(tx, () => store.getAll()),
        put: (obj) => new FakeRequest(tx, () => store.put(obj)),
        delete: (key) => new FakeRequest(tx, () => { store.delete(key); }),
        clear: () => new FakeRequest(tx, () => { store.clear(); }),
        count: () => new FakeRequest(tx, () => store.count()),
        index: (indexName) => ({
          get: (value) => new FakeRequest(tx, () => store.index(indexName).get(value)),
          getAll: (value) => new FakeRequest(tx, () => store.index(indexName).getAll(value)),
        }),
      };
    }
    settle() {
      this.pending -= 1;
      if (this.pending <= 0 && !this.settled) {
        this.settled = true;
        setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
      }
    }
    abort() { this.settled = true; }
  }

  class FakeDb {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      this.onversionchange = null;
      this.closed = 0;
    }
    createObjectStore(name, options = {}) {
      const store = new FakeStore(name, options);
      this.stores.set(name, store);
      return store;
    }
    transaction(names, mode) {
      const list = Array.isArray(names) ? names : [names];
      const scoped = {};
      for (const n of list) {
        if (!this.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
        scoped[n] = this.stores.get(n);
      }
      return new FakeTransaction(scoped, mode);
    }
    close() {
      this.closed += 1;
      closes.push(this.name);
    }
  }

  const indexedDB = {
    open(name, version) {
      opened.push(name);
      let database = persistent ? byName.get(name) : null;
      if (!database) {
        database = new FakeDb(name, version);
        if (persistent) byName.set(name, database);
        databases.push(database);
      }
      const request = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        try {
          if (request.onupgradeneeded) request.onupgradeneeded();
        } catch (err) {
          request.error = err;
          if (request.onerror) request.onerror();
          return;
        }
        setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
      }, 0);
      return request;
    },
    deleteDatabase(name) {
      deleted.push(name);
      const request = { error: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        if (deleteBlocked) {
          if (request.onblocked) request.onblocked();
          return;
        }
        // 真浏览器先给已打开的连接发 versionchange，让它们自己让路
        for (const database of databases.filter((d) => d.name === name)) {
          try { if (database.onversionchange) database.onversionchange(); } catch { /* 忽略 */ }
        }
        byName.delete(name);
        const at = databases.findIndex((d) => d.name === name);
        if (at >= 0) databases.splice(at, 1);
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };

  return { indexedDB, databases, opened, deleted, closes, db: (name) => byName.get(name) };
}

async function testStoreSettings() {
  await checkAsync('store: 默认 weightUnit=kg，部分更新不丢键，可切斤并读回', async () => {
    const fake = createFakeIndexedDb();
    const prev = globalThis.indexedDB;
    globalThis.indexedDB = fake.indexedDB;
    try {
      const fresh = await store.getSettings();
      eq(fresh.weightUnit, 'kg', '默认应为 kg');
      eq(fresh.model, 'qwen3-vl-plus');

      await store.saveSettings({ apiKey: 'x' });
      const afterKey = await store.getSettings();
      eq(afterKey.apiKey, 'x');
      eq(afterKey.weightUnit, 'kg', '只改 apiKey 不能把 weightUnit 冲掉');
      eq(afterKey.model, 'qwen3-vl-plus', '只改 apiKey 不能把 model 冲掉');

      await store.saveSettings({ weightUnit: 'jin' });
      const afterJin = await store.getSettings();
      eq(afterJin.weightUnit, 'jin');
      eq(afterJin.apiKey, 'x', '切单位不能把 apiKey 冲掉');
      eq(afterJin.model, 'qwen3-vl-plus');

      // 旧数据 / 手改数据：缺键或非法值都回退 kg
      await db.setMeta('settings', { apiKey: 'k', model: 'm' });
      eq((await store.getSettings()).weightUnit, 'kg');
      await db.setMeta('settings', { apiKey: 'k', model: 'm', weightUnit: 'lb' });
      eq((await store.getSettings()).weightUnit, 'kg');
    } finally {
      // 让 db.js 丢掉这个假库的 dbPromise 缓存，后续断言仍然对着「无 IDB」的场景
      for (const database of fake.databases) {
        try { if (database.onversionchange) database.onversionchange(); } catch { /* 忽略 */ }
      }
      if (prev === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = prev;
    }
  });

  await checkAsync('store: 假 IDB 撤走后 db.js 缓存已失效', async () => {
    if (!IDB_ABSENT) return;
    let msg = '';
    try {
      await store.getSettings();
    } catch (err) {
      msg = err.message;
    }
    eq(msg, IDB_MSG);
  });
}

// ---------- store: 套餐 / 最近吃过 / 导出状态（同样用最小假 IDB，用完必须清理） ----------

/** 注入假 IDB 跑一段断言，结束后无条件清掉 db.js 的单例并还原全局。 */
async function withFakeIdb(fn) {
  const fake = createFakeIndexedDb();
  const prev = globalThis.indexedDB;
  globalThis.indexedDB = fake.indexedDB;
  try {
    return await fn(fake);
  } finally {
    for (const database of fake.databases) {
      try { if (database.onversionchange) database.onversionchange(); } catch { /* 忽略 */ }
    }
    if (prev === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = prev;
  }
}

async function testStoreMealTemplates() {
  await checkAsync('store: 套餐保存→读取→同名覆盖(id 不变)→删除→再读为空', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      deep(await store.getMealTemplates(), []);

      const t1 = await store.saveMealTemplate({
        name: '  减脂早餐 ',
        slot: 'breakfast',
        items: [{ name: '鸡蛋', grams: 60, kcal: 90, carb: 0.6, protein: 7.2, fat: 6 }],
      });
      eq(t1.name, '减脂早餐');
      eq(t1.slot, 'breakfast');
      eq(typeof t1.id, 'string');
      eq(t1.items.length, 1);

      const list1 = await store.getMealTemplates();
      eq(list1.length, 1);
      deep(list1[0], t1);

      const t2 = await store.saveMealTemplate({
        name: '减脂早餐',
        slot: 'lunch',
        items: [{ name: '牛奶', grams: 250, kcal: 140 }],
      });
      eq(t2.id, t1.id, '同名覆盖必须保留原 id');
      const list2 = await store.getMealTemplates();
      eq(list2.length, 1);
      eq(list2[0].slot, 'lunch');
      eq(list2[0].items[0].name, '牛奶');

      const t3 = await store.saveMealTemplate({ name: '加餐', slot: 'snack', items: [] });
      ok(t3.id !== t1.id, '不同套餐应有不同 id');
      eq((await store.getMealTemplates()).length, 2);

      await store.deleteMealTemplate(t1.id);
      const list3 = await store.getMealTemplates();
      eq(list3.length, 1);
      eq(list3[0].id, t3.id);
      await store.deleteMealTemplate(t3.id);
      deep(await store.getMealTemplates(), []);
    });
  });

  await checkAsync('store: 空套餐名抛中文错误且不落库', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      for (const bad of [{ name: '   ', slot: 'lunch' }, {}, undefined]) {
        let msg = '';
        try {
          await store.saveMealTemplate(bad);
        } catch (err) {
          msg = err.message;
        }
        eq(msg, '套餐名称不能为空');
      }
      deep(await store.getMealTemplates(), []);
    });
  });

  await checkAsync('store: getMealTemplates 遇到脏 meta 不抛，返回过滤后的列表', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await db.setMeta('mealTemplates', 'oops');
      deep(await store.getMealTemplates(), []);

      await db.setMeta('mealTemplates', [
        null,
        { id: 't1', name: '早餐', slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
        { id: 't2', name: '' },
        { name: '无 id' },
        { id: 't3', name: '加餐', slot: 'brunch' },
      ]);
      const rows = await store.getMealTemplates();
      deep(rows.map((t) => t.id), ['t1', 't3']);
      eq(rows[1].slot, 'snack');
      deep(rows[1].items, []);
    });
  });

  await checkAsync('store: 老格式套餐(无 kind)读出补 kind=meal，slot/items 不变且可继续覆盖', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await db.setMeta('mealTemplates', [
        { id: 'old1', name: '老套餐', slot: 'lunch', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
      ]);
      const rows = await store.getMealTemplates();
      eq(rows.length, 1);
      eq(rows[0].kind, 'meal', '老记录必须被识别成单餐套餐');
      eq(rows[0].slot, 'lunch');
      eq(rows[0].items.length, 1);
      eq(rows[0].items[0].name, '米饭');
      eq(rows[0].items[0].grams, 150);

      // 不重存也能继续用：同名覆盖保留老 id
      const saved = await store.saveMealTemplate({
        name: '老套餐',
        slot: 'dinner',
        items: [{ name: '面条', grams: 200, kcal: 280 }],
      });
      eq(saved.id, 'old1');
      eq(saved.kind, 'meal');
      eq((await store.getMealTemplates()).length, 1);
    });
  });

  await checkAsync('store: saveDayTemplate 保存→读取→同名覆盖(id 不变)→删除', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      deep(await store.getMealTemplates(), []);

      const day = await store.saveDayTemplate({
        name: ' 整日三餐 ',
        meals: [
          { slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90, carb: 0.6, protein: 7.2, fat: 6 }] },
          { slot: 'lunch', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
        ],
      });
      eq(day.name, '整日三餐');
      eq(day.kind, 'day');
      eq(typeof day.id, 'string');
      eq(day.meals.length, 2);
      eq('slot' in day, false, '整日套餐不应带单餐 slot');

      const list = await store.getMealTemplates();
      eq(list.length, 1);
      deep(list[0], day, '落库读回应与返回值一致');
      deep(list[0].meals.map((m) => m.slot), ['breakfast', 'lunch']);
      eq(list[0].meals[0].items[0].name, '鸡蛋');
      eq(list[0].meals[1].items[0].kcal, 174);

      const over = await store.saveDayTemplate({
        name: '整日三餐',
        meals: [
          { slot: 'lunch', items: [{ name: '鸡胸肉', grams: 100, kcal: 133 }] },
          { slot: 'brunch', items: [{ name: '酸奶', grams: 100, kcal: 72 }] },
          { slot: 'snack', items: [] },
        ],
      });
      eq(over.id, day.id, '同名覆盖必须保留原 id');
      eq((await store.getMealTemplates()).length, 1);
      const stored = (await store.getMealTemplates())[0];
      deep(stored.meals.map((m) => m.slot), ['lunch', 'snack'], '非法 slot 回退 snack、空 items 餐次剔除');
      eq(stored.meals[1].items[0].name, '酸奶');

      await store.deleteMealTemplate(day.id);
      deep(await store.getMealTemplates(), [], '应按 id 删掉整日套餐');
    });
  });

  await checkAsync('store: saveDayTemplate 非法输入抛中文错且不落库', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const valid = [
        { slot: 'lunch', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
        { slot: 'dinner', items: [{ name: '青菜', grams: 200, kcal: 30 }] },
      ];
      for (const [input, expected] of [
        [{ name: '   ', meals: valid }, '套餐名称不能为空'],
        [{ name: '整日' }, '整日套餐至少要两餐'],
        [{ name: '整日', meals: [] }, '整日套餐至少要两餐'],
        [{ name: '整日', meals: [{ slot: 'lunch', items: [] }, 'oops'] }, '整日套餐至少要两餐'],
      ]) {
        let msg = '';
        try {
          await store.saveDayTemplate(input);
        } catch (err) {
          msg = err.message;
        }
        eq(msg, expected);
      }
      deep(await store.getMealTemplates(), [], '抛错时不能把半成品写进 meta');
    });
  });

  await checkAsync('store: 脏 meta 混入空名/重复 id/坏整日条目也绝不抛', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await db.setMeta('mealTemplates', [
        {
          id: 'd1',
          name: '整日',
          kind: 'day',
          meals: [
            { slot: 'breakfast', items: [{ name: '鸡蛋', grams: 60, kcal: 90 }] },
            { slot: 'nope', items: [{ name: '米饭', grams: 150, kcal: 174 }] },
            { slot: 'lunch', items: [] },
          ],
        },
        { name: '' },
        { id: 'd1', name: '重复 id 只留第一条' },
        { id: 'd2', name: '坏整日', kind: 'day', meals: [] },
        { id: 'm1', name: '老单餐' },
      ]);
      const rows = await store.getMealTemplates();
      deep(rows.map((t) => t.id), ['d1', 'm1']);
      eq(rows[0].kind, 'day');
      deep(rows[0].meals.map((m) => m.slot), ['breakfast', 'snack']);
      eq(rows[1].kind, 'meal');
      eq(rows[1].slot, 'snack', '老单餐缺 slot 回退 snack');
      // 脏数据不影响下一次保存：整日套餐与单餐套餐能共存
      await store.saveDayTemplate({ name: '新整日', meals: [
        { slot: 'breakfast', items: [{ name: '包子', grams: 100, kcal: 220 }] },
        { slot: 'dinner', items: [{ name: '面条', grams: 200, kcal: 280 }] },
      ] });
      deep((await store.getMealTemplates()).map((t) => t.kind), ['day', 'meal', 'day']);
    });
  });

  await checkAsync('store: recentFoodItems 走真 meals 表并按 limit 截断', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const d0 = nutrition.daysAgo(0);
      const d1 = nutrition.daysAgo(1);
      await db.put('meals', {
        date: d1,
        slot: 'dinner',
        source: 'manual',
        createdAt: 10,
        items: [{ name: '米饭', kcal: 200 }],
      });
      await db.put('meals', {
        date: d0,
        slot: 'breakfast',
        source: 'manual',
        createdAt: 20,
        items: [{ name: '米饭', kcal: 232 }, { name: '鸡蛋', kcal: 90 }],
      });

      const rows = await store.recentFoodItems(2);
      deep(rows.map((r) => r.name), ['米饭', '鸡蛋']);
      eq(rows[0].lastDate, d0);
      eq(rows[0].item.kcal, 232);
      deep(await store.recentFoodItems(0), []);
    });
  });

  await checkAsync('store: 新增假 IDB 测试结束后 db.js 缓存再次失效', async () => {
    if (!IDB_ABSENT) return;
    let msg = '';
    try {
      await store.getMealTemplates();
    } catch (err) {
      msg = err.message;
    }
    eq(msg, IDB_MSG);
  });
}

async function testStoreExportStatus() {
  await checkAsync('store: exportStatus 无记录 days=null / markExported 后 0 / 8 天前 -> 8', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      deep(await store.exportStatus(), { lastExportedAt: null, days: null, hasData: false });

      await store.markExported();
      const marked = await store.exportStatus();
      ok(typeof marked.lastExportedAt === 'number' && marked.lastExportedAt > 0, '应记录毫秒时间戳');
      eq(marked.days, 0);
      eq(marked.hasData, false);

      await db.put('weights', { date: nutrition.daysAgo(0), weightKg: 70, createdAt: 1 });
      eq((await store.exportStatus()).hasData, true);

      const eightDaysAgo = nutrition.parseDateStr(nutrition.daysAgo(8)).getTime() + 12 * 3600 * 1000;
      await db.setMeta('lastExportedAt', eightDaysAgo);
      const stale = await store.exportStatus();
      eq(stale.lastExportedAt, eightDaysAgo);
      eq(stale.days, 8);

      // 脏 meta 按从未导出处理，不抛
      await db.setMeta('lastExportedAt', 'not-a-time');
      deep(await store.exportStatus(), { lastExportedAt: null, days: null, hasData: true });
    });
  });

  await checkAsync('store: exportJSON 成功返回前 markExported，days 归 0', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await db.setMeta('lastExportedAt', nutrition.parseDateStr(nutrition.daysAgo(8)).getTime());
      eq((await store.exportStatus()).days, 8);

      await db.put('meals', {
        date: nutrition.daysAgo(0),
        slot: 'lunch',
        source: 'manual',
        createdAt: 5,
        items: [{ name: '米饭', grams: 100, kcal: 116 }],
      });
      const payload = await store.exportJSON();
      eq(payload.app, 'hms');
      eq(payload.schemaVersion, 1);
      eq(payload.meals.length, 1);
      eq(payload.weights.length, 0);

      const after = await store.exportStatus();
      eq(after.days, 0);
      eq(after.hasData, true);
    });
  });
}

// ---------- pure / store: 整日套餐的报错文案 ----------

function testDayTemplateMessage() {
  check('整日套餐错误文案已改为「至少要两餐」，且两餐真的能存', () => {
    const two = [{ slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] }, { slot: 'dinner', items: [{ name: '面', kcal: 200 }] }];
    const one = [{ slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] }];
    for (const [input, expected] of [
      [{ name: '零餐' }, '整日套餐至少要两餐'],
      [{ name: '只剩一餐', meals: one }, '整日套餐至少要两餐'],
      [{ name: '非法餐次', meals: [{ slot: 'lunch', items: [] }, 'oops'] }, '整日套餐至少要两餐'],
      [{ name: ' ', meals: two }, '套餐名称不能为空'],
    ]) {
      let msg = '';
      try {
        pure.planDayTemplateSave([], input);
      } catch (err) {
        msg = err.message;
      }
      eq(msg, expected);
    }
    // 文案说「至少两餐」，那两餐就必须是合法下限
    const okTwo = pure.planDayTemplateSave([], { name: '两餐', meals: two });
    eq(okTwo.template.meals.length, 2);
    eq(okTwo.template.kind, 'day');
    eq('slot' in okTwo.template, false, '整日套餐不带单餐 slot');
  });
}

// ---------- store: 运动落库（含强度，同样用最小假 IDB） ----------

async function testStoreExerciseLog() {
  await checkAsync('store: logExercise 落库 intensity 并读回，取整/日期语义不变', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const date = nutrition.localDateStr();
      // 既有语义：logExercise 返回 db.put 的主键（id），记录本身要从库里读回
      const id = await store.logExercise({
        date, type: 'bike', minutes: 30.44, kcalBurned: 245.6, note: '通勤', intensity: '  road  ',
      });
      eq(typeof id, 'number');

      const rows = await db.getAll('exercises');
      eq(rows.length, 1);
      eq(rows[0].id, id);
      eq(rows[0].intensity, 'road', 'intensity 应 trim 后落库');
      eq(rows[0].type, 'bike');
      eq(rows[0].minutes, 30.4);
      eq(rows[0].kcalBurned, 246);
      eq(rows[0].date, date);
      eq(rows[0].note, '通勤');

      const summary = await store.daySummary(date);
      eq(summary.exercises.length, 1);
      eq(summary.exercises[0].intensity, 'road', 'daySummary 读回的运动记录应带强度');

      // 不带强度 / 超长强度：字段不落键，其余照旧
      await store.logExercise({ date, type: 'walk', minutes: 20, kcalBurned: 80 });
      await store.logExercise({ date, type: 'walk', minutes: 20, kcalBurned: 80, intensity: 'y'.repeat(20) });
      const all = await db.getAll('exercises');
      eq(all.length, 3, '三条都该落库');
      eq('intensity' in all[1], false);
      eq('intensity' in all[2], false, '超长强度不应落库');

      // 非法日期串回退今天（todayOf 的既有语义）
      const fallbackId = await store.logExercise({ date: 'not-a-date', type: 'walk', minutes: 20, kcalBurned: 80 });
      eq((await db.get('exercises', fallbackId)).date, date);
    });
  });

  await checkAsync('store: saveDayTemplate 的报错文案同样是「至少要两餐」', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      let msg = '';
      try {
        await store.saveDayTemplate({ name: '只一餐', meals: [{ slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] }] });
      } catch (err) {
        msg = err.message;
      }
      eq(msg, '整日套餐至少要两餐');

      const t = await store.saveDayTemplate({
        name: '两餐',
        meals: [
          { slot: 'lunch', items: [{ name: '米饭', kcal: 174 }] },
          { slot: 'dinner', items: [{ name: '面', kcal: 200 }] },
        ],
      });
      eq(t.kind, 'day');
      eq(t.meals.length, 2);
      eq((await store.getMealTemplates()).length, 1);
    });
  });
}

// ---------- 本地多账号：目录 / 切换 / 两库物理隔离 ----------

/**
 * 账号用例的舞台：同名 open 拿到同一份数据的假 IDB（真浏览器行为）+ 假 localStorage。
 * 既有的 withFakeIdb 每次 open 都是空库，只够单库场景，证明不了「两个账号不串库」。
 */
async function withFakeAccounts(fn, options = {}) {
  const fake = createFakeIndexedDb({ persistent: true, ...options });
  const bag = new Map();
  const prevIdb = globalThis.indexedDB;
  const prevStorage = globalThis.localStorage;
  globalThis.indexedDB = fake.indexedDB;
  globalThis.localStorage = {
    getItem: (key) => (bag.has(key) ? bag.get(key) : null),
    setItem: (key, value) => { bag.set(key, String(value)); },
    removeItem: (key) => { bag.delete(key); },
  };
  try {
    return await fn(fake);
  } finally {
    // 与 withFakeIdb 同样的收尾：别把假库的单例或全局漏给后面的套件
    for (const database of fake.databases) {
      try { if (database.onversionchange) database.onversionchange(); } catch { /* 忽略 */ }
    }
    try { await db.setDbName(accounts.LEGACY_DB_NAME); } catch { /* 没有 IDB 就忽略 */ }
    db.resetDbConnection();
    if (prevIdb === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = prevIdb;
    if (prevStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevStorage;
  }
}

function catalogRaw() {
  return JSON.parse(globalThis.localStorage.getItem(accounts.CATALOG_KEY));
}

function activeRaw() {
  return globalThis.localStorage.getItem(accounts.ACTIVE_KEY);
}

async function testAccountsContract() {
  check('accounts.js 导出契约与常量完整', () => {
    eq(accounts.CATALOG_KEY, 'hms.accounts');
    eq(accounts.ACTIVE_KEY, 'hms.activeAccount');
    eq(accounts.LEGACY_DB_NAME, 'hms');
    eq(accounts.MAX_ACCOUNTS, 8);
    for (const name of ACCOUNT_EXPORTS) eq(typeof accounts[name], 'function', "accounts." + name + " 缺失");
  });

  check('accounts.js 只认 localStorage / indexedDB 两个入口，不碰 DOM 与网络', () => {
    const src = sourceOf('accounts.js');
    for (const token of ['document', 'window', 'fetch(']) ok(!src.includes(token), "accounts.js 不应出现 " + token);
  });

  await checkAsync('db.setDbName 在没有 indexedDB 时抛中文错误（不让调用方以为切库成功了）', async () => {
    if (!IDB_ABSENT) return;
    let msg = '';
    try {
      await db.setDbName('hms-u-x');
    } catch (err) {
      msg = err.message;
    }
    eq(msg, IDB_MSG);
    db.resetDbConnection();
  });
}

async function testAccountsCatalog() {
  await checkAsync('accounts: ensureDefaultAccount 首次运行认领老库 hms 并设为当前', async () => {
    await withFakeAccounts(async (fake) => {
      deep(accounts.listAccounts(), [], '还没有账号时目录是空的');
      eq(accounts.getActiveAccount(), null);

      const a = await accounts.ensureDefaultAccount();
      eq(a.dbName, 'hms', '第一个账号必须认领老库，不搬迁任何数据');
      eq(a.name, '本机');
      eq(typeof a.id, 'string');
      ok(a.id.length > 0, 'id 不能为空');
      ok(a.createdAt > 0, 'createdAt 要有效');
      eq(accounts.getActiveAccount().id, a.id, '第一个账号要成为当前账号');
      eq(activeRaw(), a.id);
      eq(catalogRaw().length, 1);
      deep(accounts.listAccounts()[0], a);
      deep(fake.opened, [], '登记账号不该顺手打开数据库');

      const again = await accounts.ensureDefaultAccount();
      eq(again.id, a.id, '重复调用必须是同一个账号');
      eq(catalogRaw().length, 1);
      eq(accounts.listAccounts().length, 1);
    });
  });

  await checkAsync('accounts: ensureDefaultAccount 幂等，坏目录也能自愈且不重复建', async () => {
    await withFakeAccounts(async () => {
      const a = await accounts.ensureDefaultAccount();
      for (let i = 0; i < 3; i += 1) eq((await accounts.ensureDefaultAccount()).id, a.id);
      eq(accounts.listAccounts().length, 1);

      // 有账号但当前账号丢了（手改/清键）：认最早的，不新建
      const b = await accounts.createAccount({ name: '爸爸' });
      globalThis.localStorage.removeItem(accounts.ACTIVE_KEY);
      eq(accounts.getActiveAccount(), null);
      eq((await accounts.ensureDefaultAccount()).id, a.id, '没有当前账号时认最早的账号');
      eq(accounts.listAccounts().length, 2, '自愈不该多建账号');
      ok(catalogRaw().some((row) => row.id === b.id), '另一个账号不能被自愈冲掉');
    });
  });

  await checkAsync('accounts: createAccount 建出 hms-u-<id> 的独立库并建全 store / 索引', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '  爸爸 ' });
      eq(b.name, '爸爸', '名称应去掉首尾空白');
      eq(b.dbName, 'hms-u-' + b.id);
      ok(b.dbName !== 'hms' && b.dbName !== a.dbName, '新账号必须有自己的库');
      eq(catalogRaw().length, 2);
      deep(accounts.listAccounts().map((x) => x.dbName), ['hms', b.dbName], '目录按创建顺序升序');

      ok(fake.opened.includes(b.dbName), 'createAccount 应该把新库建出来');
      const created = fake.db(b.dbName);
      ok(created, '新库不存在');
      for (const storeName of ['meta', 'weights', 'meals', 'exercises', 'waters', 'photos']) {
        ok(created.stores.has(storeName), "新库缺 object store：" + storeName);
      }
      for (const entry of [['weights', 'by_date'], ['meals', 'by_date'], ['exercises', 'by_date'], ['waters', 'by_date']]) {
        ok(created.stores.get(entry[0]).indexes.has(entry[1]), "新库缺索引：" + entry.join('.'));
      }
      ok(created.closed >= 1, '建库的临时连接要关掉，不能占着');
      eq(db.getDbName(), 'hms', '建别人的库不该动当前连接');

      const c = await accounts.createAccount('妈妈');
      eq(c.name, '妈妈', '直接传名字也要能用');
      eq(accounts.listAccounts().length, 3);
    });
  });

  await checkAsync('accounts: 超过 MAX_ACCOUNTS 抛「最多只能建 8 个账号」', async () => {
    await withFakeAccounts(async () => {
      await accounts.ensureDefaultAccount();
      for (let i = 1; i < accounts.MAX_ACCOUNTS; i += 1) await accounts.createAccount({ name: "账号" + i });
      eq(accounts.listAccounts().length, 8);
      let msg = '';
      try { await accounts.createAccount({ name: '第九个' }); } catch (err) { msg = err.message; }
      eq(msg, '最多只能建 8 个账号');
      eq(accounts.listAccounts().length, 8, '被拒绝时不能留下半个账号');
      eq(catalogRaw().length, 8);
    });
  });

  await checkAsync('accounts: createAccount / renameAccount 空名抛「账号名称不能为空」', async () => {
    await withFakeAccounts(async () => {
      const a = await accounts.ensureDefaultAccount();
      for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
        let msg = '';
        try { await accounts.createAccount({ name: bad }); } catch (err) { msg = err.message; }
        eq(msg, '账号名称不能为空', "createAccount 空名应报错：" + JSON.stringify(bad));
        msg = '';
        try { accounts.renameAccount(a.id, bad); } catch (err) { msg = err.message; }
        eq(msg, '账号名称不能为空', "renameAccount 空名应报错：" + JSON.stringify(bad));
      }
      eq(accounts.listAccounts().length, 1);
      eq(accounts.listAccounts()[0].name, '本机');
    });
  });

  await checkAsync('accounts: renameAccount 改名不换库；setActiveAccount 只认目录里的 id', async () => {
    await withFakeAccounts(async () => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });

      const renamed = accounts.renameAccount(b.id, ' 老爸 ');
      eq(renamed.id, b.id);
      eq(renamed.name, '老爸');
      eq(renamed.dbName, b.dbName, '改名不能换库');
      eq(accounts.listAccounts().find((x) => x.id === b.id).name, '老爸');
      eq(catalogRaw().find((x) => x.id === b.id).name, '老爸');
      eq(accounts.listAccounts().find((x) => x.id === a.id).name, '本机', '改名不能碰到别人');

      let msg = '';
      try { accounts.renameAccount('nope', '谁'); } catch (err) { msg = err.message; }
      eq(msg, '账号不存在');

      eq(accounts.setActiveAccount(b.id).id, b.id);
      eq(accounts.getActiveAccount().id, b.id);
      eq(activeRaw(), b.id);
      for (const bad of ['nope', '', '   ', null, undefined, 42, {}, a.id + 'x', b.dbName]) {
        eq(accounts.setActiveAccount(bad), null, "setActiveAccount 传不存在的 id 应返回 null：" + JSON.stringify(bad));
      }
      eq(accounts.getActiveAccount().id, b.id, '找不到的 id 不能改当前账号');
      eq(activeRaw(), b.id);
      eq(accounts.setActiveAccount(a.id).id, a.id);
      eq(accounts.getActiveAccount().id, a.id);
    });
  });
}

async function testAccountsDirtyStorage() {
  await checkAsync('accounts: 脏 localStorage 一律安全降级（坏 JSON / 非数组 / 缺字段）', async () => {
    await withFakeAccounts(async () => {
      const dirty = [
        '{oops', 'null', '"x"', '123', '{"a":1}', '[1,2,3]', '[null]',
        '[{"name":"没有id"}]', '[{"id":"x"}]', '[{"id":"","name":"空id"}]',
        '[{"id":"x","name":"   "}]', '[{"id":1,"name":2}]',
      ];
      for (const raw of dirty) {
        globalThis.localStorage.setItem(accounts.CATALOG_KEY, raw);
        deep(accounts.listAccounts(), [], "脏目录应返回 []：" + raw);
        eq(accounts.getActiveAccount(), null, "脏目录下不该有当前账号：" + raw);
      }

      // 缺 dbName 的记录按 id 推库名：绝不能都回落到老库，否则两个账号会串
      globalThis.localStorage.setItem(accounts.CATALOG_KEY, JSON.stringify([{ id: 'u1', name: '爸爸', createdAt: 1 }]));
      globalThis.localStorage.setItem(accounts.ACTIVE_KEY, 'u1');
      const repaired = accounts.getActiveAccount();
      eq(repaired.id, 'u1');
      eq(repaired.dbName, 'hms-u-u1');
      eq(accounts.dbNameForAccount(repaired), 'hms-u-u1');
      eq(accounts.dbNameForAccount(null), 'hms', '取不到账号时回落老库名');
      eq(accounts.dbNameForAccount({}), 'hms');
      eq(accounts.dbNameForAccount({ dbName: '   ' }), 'hms');

      // 同一个库被两个账号认领（目录被改坏）：只认先出现的那个
      globalThis.localStorage.setItem(
        accounts.CATALOG_KEY,
        JSON.stringify([{ id: 'a', name: '甲', dbName: 'hms' }, { id: 'b', name: '乙', dbName: 'hms' }]),
      );
      eq(accounts.listAccounts().length, 1, '同一个库只能有一个账号');

      // 目录被写坏时还能自愈出一个可用账号，且自愈本身也幂等
      globalThis.localStorage.setItem(accounts.CATALOG_KEY, '{oops');
      globalThis.localStorage.setItem(accounts.ACTIVE_KEY, 'u1');
      const healed = await accounts.ensureDefaultAccount();
      eq(healed.dbName, 'hms');
      eq(accounts.listAccounts().length, 1);
      eq((await accounts.ensureDefaultAccount()).id, healed.id);
    });
  });

  await checkAsync('accounts: localStorage 被禁用 / 不存在时照样降级，不白屏', async () => {
    const fake = createFakeIndexedDb({ persistent: true });
    const prevIdb = globalThis.indexedDB;
    const prevStorage = globalThis.localStorage;
    globalThis.indexedDB = fake.indexedDB;
    globalThis.localStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    try {
      deep(accounts.listAccounts(), []);
      eq(accounts.getActiveAccount(), null);
      eq(accounts.setActiveAccount('x'), null);

      const a = await accounts.ensureDefaultAccount();
      eq(a.dbName, 'hms', '存不进去也要给一个能跑起来的账号');
      eq(accounts.listAccounts().length, 0, '写不进去时目录只能是空的');

      let msg = '';
      try { await accounts.createAccount({ name: '爸爸' }); } catch (err) { msg = err.message; }
      eq(msg, '本地存储不可用，无法保存账号', '写不进去要明说，不能假装建好了');
      msg = '';
      try { accounts.renameAccount('x', '谁'); } catch (err) { msg = err.message; }
      eq(msg, '账号不存在');

      // 连 localStorage 对象都没有（老 WebView）
      delete globalThis.localStorage;
      deep(accounts.listAccounts(), []);
      eq(accounts.getActiveAccount(), null);
      deep(fake.deleted, []);
    } finally {
      db.resetDbConnection();
      if (prevIdb === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = prevIdb;
      if (prevStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevStorage;
    }
  });
}

async function testAccountsIsolation() {
  await checkAsync('db: 还没有任何账号时默认还是老库 hms（老用户开箱即用）', async () => {
    await withFakeAccounts(async (fake) => {
      eq(accounts.listAccounts().length, 0);
      eq(db.getDbName(), 'hms');
      await db.setMeta('probe', '老数据');
      eq(await db.getMeta('probe'), '老数据');
      ok(fake.opened.includes('hms'), '老用户读写必须落在 hms 库上');
    });
  });

  await checkAsync('accounts: 隔离——A 写的体重切到 B 读不到，切回 A 还在（两库物理分开）', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });
      const date = nutrition.localDateStr();

      await store.switchAccount(a.id);
      eq(db.getDbName(), 'hms');
      await store.logWeight({ date, weightKg: 70.5 });

      await store.switchAccount(b.id);
      eq(db.getDbName(), b.dbName, '切账号后读写目标库必须跟着变');
      eq((await db.getAll('weights')).length, 0, '切到 B 不能读到 A 的体重');
      eq(await store.getWater(date), 0);
      await store.logWeight({ date, weightKg: 61 });
      eq((await db.getAll('weights')).length, 1);

      await store.switchAccount(a.id);
      eq(db.getDbName(), 'hms');
      const rows = await db.getAll('weights');
      eq(rows.length, 1, '切回 A 后 A 的数据必须还在');
      eq(rows[0].weightKg, 70.5);
      eq(rows[0].date, date);

      // 不是同一份数据加了过滤，而是两个独立的库各存各的
      const dbA = fake.db('hms');
      const dbB = fake.db(b.dbName);
      ok(dbA && dbB && dbA !== dbB, 'A / B 必须是两个不同的库');
      eq(dbA.stores.get('weights').data.size, 1);
      eq(dbB.stores.get('weights').data.size, 1);
      eq(dbA.stores.get('weights').get(1).weightKg, 70.5);
      eq(dbB.stores.get('weights').get(1).weightKg, 61);
      eq(dbB.stores.get('meals').data.size, 0);
      eq(dbB.stores.get('meta').data.size, 0, 'B 的 meta 也是空的');
    });
  });

  await checkAsync('db: 切换账号会关掉旧连接，不会把 A 的写入落到 B', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });

      await store.switchAccount(a.id);
      const connA = fake.db('hms');
      eq(fake.closes.includes('hms'), false, '切走之前 A 的连接该是活的');

      await store.switchAccount(b.id);
      eq(accounts.getActiveAccount().id, b.id);
      eq(db.getDbName(), b.dbName);
      ok(fake.closes.includes('hms'), '切走时旧连接必须被关掉，否则 A 的写入会落到 B');
      ok(connA.closed >= 1);

      await store.switchAccount(a.id);
      eq(db.getDbName(), 'hms');
      ok(fake.closes.includes(b.dbName), '切回时 B 的连接也要关掉');
      eq((await store.currentAccount()).id, a.id);
      ok(fake.opened.filter((name) => name === 'hms').length >= 2, '单例被重置后才可能重开同名库');
    });
  });

  await checkAsync('db: setDbName / resetDbConnection 语义（切库真的换库、只清单例不换库）', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });
      await store.switchAccount(a.id);
      await db.setMeta('probe', 'A');

      await db.setDbName(b.dbName);
      eq(db.getDbName(), b.dbName);
      eq(await db.getMeta('probe'), null, '换库后读到的是 B 的空库');
      await db.setMeta('probe', 'B');

      db.resetDbConnection();
      eq(db.getDbName(), b.dbName, '只清单例，不改库名');
      eq(await db.getMeta('probe'), 'B', '重开后还是同一个库');

      await store.switchAccount(a.id);
      eq(db.getDbName(), 'hms');
      eq(await db.getMeta('probe'), 'A', '切回 A 必须读到 A 自己的数据');

      const c = await accounts.createAccount({ name: '妈妈' });
      eq(db.getDbName(), 'hms', '建别人的库不该动当前连接');
      ok(fake.db(c.dbName).stores.has('photos'), 'prepareDatabase 要把新库建全');

      await db.setDbName('hms-u-不存在的库');
      eq(db.getDbName(), 'hms-u-不存在的库', 'setDbName 钉住的库名优先');
      eq(await db.getMeta('probe'), null);
    });
  });
}

async function testAccountsRemoval() {
  await checkAsync('accounts: removeAccount 删账号 + 删库，数据随之消失', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });
      const date = nutrition.localDateStr();
      await store.switchAccount(b.id);
      await store.logWeight({ date, weightKg: 61 });
      eq(fake.db(b.dbName).stores.get('weights').data.size, 1);

      await accounts.removeAccount(b.id);
      ok(fake.deleted.includes(b.dbName), '必须调用 indexedDB.deleteDatabase');
      ok(fake.closes.includes(b.dbName), '删库前要先关掉这条连接，否则 onblocked 自锁');
      eq(accounts.listAccounts().length, 1);
      eq(accounts.listAccounts()[0].id, a.id);
      eq(accounts.getActiveAccount().id, a.id, '删掉当前账号后目录应指向剩下的账号');
      eq(catalogRaw().length, 1);
      eq(fake.db(b.dbName), undefined, '删掉的库不该还留在盘上');

      // 数据真的没了：重新打开这个名字只能是空库
      await db.setDbName(b.dbName);
      eq((await db.getAll('weights')).length, 0, '删库后不该还能读到 B 的体重');
    });
  });

  await checkAsync('accounts: 认领 hms 的账号禁止删除（「本机数据所在账号不能删除」）', async () => {
    await withFakeAccounts(async (fake) => {
      const a = await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });
      eq(a.dbName, 'hms');

      let msg = '';
      try { await accounts.removeAccount(a.id); } catch (err) { msg = err.message; }
      eq(msg, '本机数据所在账号不能删除');
      eq(accounts.listAccounts().length, 2, '拒绝时目录不能被改');
      eq(accounts.getActiveAccount().id, a.id, '拒绝时当前账号不能被改');
      deep(fake.deleted, [], '拒绝时不能删任何库');

      // 删不存在的账号：幂等，什么都不做
      await accounts.removeAccount('nope');
      await accounts.removeAccount(null);
      await accounts.removeAccount('');
      eq(accounts.listAccounts().length, 2);

      await accounts.removeAccount(b.id);
      eq(accounts.listAccounts().length, 1);
      ok(fake.deleted.includes(b.dbName));
      eq(accounts.getActiveAccount().id, a.id);
    });
  });

  await checkAsync('accounts: removeAccount 遇到 onblocked 也绝不永远挂着（超时兜底后照常结束）', async () => {
    await withFakeAccounts(async (fake) => {
      await accounts.ensureDefaultAccount();
      const b = await accounts.createAccount({ name: '爸爸' });
      const started = Date.now();
      await accounts.removeAccount(b.id);
      const cost = Date.now() - started;
      ok(fake.deleted.includes(b.dbName), 'deleteDatabase 仍要被调用');
      ok(cost < 3000, "被 blocked 时也要兜底结束，实际用了 " + cost + "ms");
      eq(accounts.listAccounts().length, 1);
    }, { deleteBlocked: true });
  });

  await checkAsync('store: currentAccount 没账号时自动认领老库，switchAccount 只认目录里的 id', async () => {
    await withFakeAccounts(async () => {
      deep(accounts.listAccounts(), []);
      const a = await store.currentAccount();
      eq(a.dbName, 'hms');
      eq(accounts.listAccounts().length, 1);
      eq((await store.currentAccount()).id, a.id, '第二次调用不该再建账号');

      const b = await accounts.createAccount({ name: '爸爸' });
      eq((await store.switchAccount(b.id)).id, b.id);
      eq((await store.currentAccount()).id, b.id);
      eq(db.getDbName(), b.dbName);

      let msg = '';
      try { await store.switchAccount('nope'); } catch (err) { msg = err.message; }
      eq(msg, '账号不存在');
      eq(accounts.getActiveAccount().id, b.id, '失败时不能改当前账号');
      eq(db.getDbName(), b.dbName, '失败时不能切库');
    });
  });
}

// ---------- 云同步纯函数层（js/sync.js） ----------

const SYNC_EXPORTS = [
  'SNAPSHOT_VERSION', 'SYNC_STATE_KEY', 'checksum', 'buildSnapshot', 'parseSnapshot',
  'planSync', 'makeConflictBackup', 'isConflictBackup', 'createDebouncer', 'snapshotSummary',
  // 缺口 1 / 缺口 3 新增的三个函数（SYNC_EXCLUDED_SETTINGS 是常量，单独断言）
  'stripSyncSecrets', 'mergeRemoteIntoLocal', 'businessRecordCount',
];

const SNAP_PAYLOAD = {
  app: 'hms',
  weights: [{ date: '2026-01-01', weightKg: 70 }],
  meals: [{ date: '2026-01-01', slot: 'lunch' }],
  exercises: [],
  waters: [{ date: '2026-01-01', ml: 500 }],
};

/** 可控假时钟 + 定时器队列：注入 now/setTimer/clearTimer 后时间可确定性推进。 */
function fakeClock(start = 0) {
  let time = start;
  let seq = 0;
  const tasks = new Map();
  const calls = { set: 0, clear: 0 };
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      calls.set += 1;
      const id = (seq += 1);
      tasks.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      calls.clear += 1;
      tasks.delete(id);
    },
    live: () => tasks.size,
    calls,
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...tasks.entries()].filter((entry) => entry[1].at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        time = due[1].at;
        due[1].fn(); // 到期时刻先落到 time 上，再触发，waited 才是确定值
      }
      time = target;
    },
  };
}

function testSyncPure() {
  check('sync.js 导出契约完整（阶段 3 的适配器按这些名字调用）', () => {
    eq(sync.SNAPSHOT_VERSION, 1);
    eq(sync.SYNC_STATE_KEY, 'syncState');
    for (const name of SYNC_EXPORTS) ok(name in sync, 'sync.' + name + ' 缺失');
    for (const name of SYNC_EXPORTS.slice(2)) eq(typeof sync[name], 'function', name + ' 应是函数');
  });

  check('sync.js 源码零网络零 DOM（纯函数层，不许自己发请求）', () => {
    const src = sourceOf('sync.js');
    for (const token of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'document', 'window', 'localStorage', 'indexedDB', 'import']) {
      ok(!src.includes(token), 'sync.js 不应出现 ' + token);
    }
  });

  // ----- checksum -----

  check('checksum: 同样的数据永远得同一个值，且是 8 位十六进制', () => {
    const a = sync.checksum({ weights: [{ date: '2026-01-01', weightKg: 70 }], meals: [] });
    const b = sync.checksum({ weights: [{ date: '2026-01-01', weightKg: 70 }], meals: [] });
    eq(a, b);
    ok(/^[0-9a-f]{8}$/.test(a), '不是 8 位十六进制：' + a);
  });

  check('checksum: 对象键顺序不影响（含嵌套对象）', () => {
    eq(sync.checksum({ a: 1, b: 2 }), sync.checksum({ b: 2, a: 1 }));
    eq(sync.checksum({ x: { a: 1, b: { c: 3, d: 4 } } }), sync.checksum({ x: { b: { d: 4, c: 3 }, a: 1 } }));
  });

  check('checksum: 数组顺序影响（顺序变了就算本地有改动）', () => {
    ok(sync.checksum({ list: [1, 2, 3] }) !== sync.checksum({ list: [3, 2, 1] }));
    ok(sync.checksum([1, 2]) !== sync.checksum([2, 1]));
    eq(sync.checksum({ list: [1, 2, 3] }), sync.checksum({ list: [1, 2, 3] }));
  });

  check('checksum: 值变了校验和就变（数字 / 字符串 / 多一个键）', () => {
    ok(sync.checksum({ v: 1 }) !== sync.checksum({ v: 2 }));
    ok(sync.checksum({ v: '1' }) !== sync.checksum({ v: 1 }));
    ok(sync.checksum({ a: 1 }) !== sync.checksum({ a: 1, b: 0 }));
  });

  check('checksum: 中文字符串可用，不同中文不同值', () => {
    const a = sync.checksum({ note: '早餐吃了两个鸡蛋' });
    ok(/^[0-9a-f]{8}$/.test(a), '中文输入也要出十六进制：' + a);
    ok(a !== sync.checksum({ note: '午餐吃了两个鸡蛋' }));
    eq(a, sync.checksum({ note: '早餐吃了两个鸡蛋' }));
  });

  check('checksum: 异常输入（函数 / Symbol / BigInt / 循环引用）不抛，兜底值稳定', () => {
    const circular = { name: '环' };
    circular.self = circular;
    const values = [() => {}, Symbol('s'), 10n, circular, { deep: circular }].map((input) => sync.checksum(input));
    for (const value of values) ok(/^[0-9a-f]{8}$/.test(value), '兜底值格式不对：' + value);
    eq(new Set(values).size, 1, '异常输入的兜底值必须稳定且相同');
  });

  check('checksum: 与 JSON.stringify 语义一致（undefined/函数值的键被丢弃、Date 走 toJSON、过一遍 JSON 不变）', () => {
    eq(sync.checksum({ a: 1, b: () => {}, c: undefined }), sync.checksum({ a: 1 }));
    eq(sync.checksum({ d: new Date(0) }), sync.checksum({ d: '1970-01-01T00:00:00.000Z' }));
    const payload = { meta: { z: 1, a: { b: [1, 2, { c: '中' }] } }, weights: [3, 1, 2] };
    eq(sync.checksum(payload), sync.checksum(JSON.parse(JSON.stringify(payload))), '过一遍 JSON 不能改校验和');
  });

  // ----- buildSnapshot / parseSnapshot -----

  check('buildSnapshot: 正常构造（账号去空格、rev/savedAt 保留、payload 原样引用）', () => {
    const snap = sync.buildSnapshot({ accountId: ' u_1 ', rev: 7, savedAt: 1700000000000, payload: SNAP_PAYLOAD });
    eq(snap.v, 1);
    eq(snap.accountId, 'u_1');
    eq(snap.rev, 7);
    eq(snap.savedAt, 1700000000000);
    eq(snap.payload, SNAP_PAYLOAD, 'payload 应原样带过去，不做深拷贝');
  });

  check('buildSnapshot: rev/savedAt 缺省时回落（rev=0、savedAt 用当前时间）', () => {
    const before = Date.now();
    const snap = sync.buildSnapshot({ accountId: 'u_1', payload: {} });
    eq(snap.rev, 0);
    ok(snap.savedAt >= before && snap.savedAt <= Date.now(), 'savedAt 应回落到当前时间：' + snap.savedAt);
  });

  check('buildSnapshot: 账号标识为空抛「快照缺少账号标识」', () => {
    for (const accountId of ['', '   ', undefined, null, 42]) {
      let msg = '';
      try { sync.buildSnapshot({ accountId, payload: {} }); } catch (err) { msg = err.message; }
      eq(msg, '快照缺少账号标识', 'accountId=' + String(accountId) + ' 时应抛中文错误');
    }
  });

  check('buildSnapshot: payload 不是对象抛「快照缺少数据体」', () => {
    for (const payload of [undefined, null, 'x', 42, [], () => {}]) {
      let msg = '';
      try { sync.buildSnapshot({ accountId: 'u_1', payload }); } catch (err) { msg = err.message; }
      eq(msg, '快照缺少数据体', 'payload=' + String(payload) + ' 时应抛中文错误');
    }
  });

  check('parseSnapshot: buildSnapshot 的产物能原样解析回来（含过一遍 JSON）', () => {
    const snap = sync.buildSnapshot({ accountId: 'u_1', rev: 3, savedAt: 1000, payload: SNAP_PAYLOAD });
    deep(sync.parseSnapshot(snap), snap);
    deep(sync.parseSnapshot(JSON.parse(JSON.stringify(snap))), snap);
  });

  check('parseSnapshot: 非对象一律 null，绝不抛', () => {
    for (const raw of [null, undefined, 0, 1, true, 'v1', '{}', [], () => {}, Symbol('s')]) {
      eq(sync.parseSnapshot(raw), null, String(raw) + ' 应返回 null');
    }
  });

  check('parseSnapshot: 版本不符 / 缺 v 一律 null', () => {
    const base = { accountId: 'u_1', rev: 0, savedAt: 1000, payload: {} };
    for (const v of [undefined, null, 0, 2, '1']) {
      eq(sync.parseSnapshot({ ...base, v }), null, 'v=' + String(v) + ' 应返回 null');
    }
  });

  check('parseSnapshot: rev 负数 / 非整数一律 null', () => {
    const base = { v: 1, accountId: 'u_1', savedAt: 1000, payload: {} };
    for (const rev of [-1, 1.5, '1', NaN, Infinity, null, undefined]) {
      eq(sync.parseSnapshot({ ...base, rev }), null, 'rev=' + String(rev) + ' 应返回 null');
    }
  });

  check('parseSnapshot: 缺 accountId（空串 / 纯空白 / 非字符串）一律 null', () => {
    const base = { v: 1, rev: 0, savedAt: 1000, payload: {} };
    for (const accountId of [undefined, null, '', '   ', 42]) {
      eq(sync.parseSnapshot({ ...base, accountId }), null, 'accountId=' + String(accountId) + ' 应返回 null');
    }
  });

  check('parseSnapshot: 缺 payload（null / 字符串 / 数组）一律 null', () => {
    const base = { v: 1, accountId: 'u_1', rev: 0, savedAt: 1000 };
    for (const payload of [undefined, null, 'x', 42, []]) {
      eq(sync.parseSnapshot({ ...base, payload }), null, 'payload=' + String(payload) + ' 应返回 null');
    }
  });

  check('parseSnapshot: savedAt 缺失或非法一律 null', () => {
    const base = { v: 1, accountId: 'u_1', rev: 0, payload: {} };
    for (const savedAt of [undefined, null, 0, -1, 'x', NaN, Infinity]) {
      eq(sync.parseSnapshot({ ...base, savedAt }), null, 'savedAt=' + String(savedAt) + ' 应返回 null');
    }
  });

  // ----- planSync：六条规则逐条钉死 -----

  check('planSync 1/6: remote 为 null → push（首次上传）', () => {
    const direct = sync.planSync({ localRev: 0, localChecksum: 'aaaa0000', syncedChecksum: null, remote: null });
    eq(direct.action, 'push');
    eq(direct.reason, '远端没有可用的快照，上传本机数据');
    eq(sync.planSync({ remote: null }).action, 'push');
  });

  check('planSync 2/6: 本地无改动且 remote.rev === localRev → none', () => {
    const r = sync.planSync({ localRev: 4, localChecksum: 'abcd1234', syncedChecksum: 'abcd1234', remote: { rev: 4 } });
    eq(r.action, 'none');
    eq(r.reason, '本地无改动且远端版本一致，无需同步');
  });

  check('planSync 3/6: 本地无改动且 remote.rev > localRev → pull（别的设备更新过）', () => {
    const r = sync.planSync({ localRev: 4, localChecksum: 'abcd1234', syncedChecksum: 'abcd1234', remote: { rev: 9 } });
    eq(r.action, 'pull');
    eq(r.reason, '本地无改动，远端版本更新，拉取远端');
  });

  check('planSync 4/6: 本地有改动且 remote.rev === localRev → push', () => {
    const r = sync.planSync({ localRev: 4, localChecksum: 'ffff0000', syncedChecksum: 'abcd1234', remote: { rev: 4 } });
    eq(r.action, 'push');
    eq(r.reason, '本地有改动，远端版本一致，上传本机数据');
  });

  check('planSync 5/6: 本地有改动且 remote.rev > localRev → conflict-pull（不静默丢数据）', () => {
    const r = sync.planSync({ localRev: 4, localChecksum: 'ffff0000', syncedChecksum: 'abcd1234', remote: { rev: 9 } });
    eq(r.action, 'conflict-pull');
    eq(r.reason, '本地与远端都有改动，先备份本机数据再拉取远端');
  });

  check('planSync 6/6: remote.rev < localRev（远端倒退，异常）→ push 纠正', () => {
    const r = sync.planSync({ localRev: 9, localChecksum: 'abcd1234', syncedChecksum: 'abcd1234', remote: { rev: 4 } });
    eq(r.action, 'push');
    eq(r.reason, '远端版本落后于本机，上传本机数据纠正远端');
    // 远端倒退 + 本地也改过：仍然是 push，不能被误判成 pull 把本地改动冲掉
    eq(sync.planSync({ localRev: 9, localChecksum: 'ffff0000', syncedChecksum: 'abcd1234', remote: { rev: 4 } }).action, 'push');
  });

  check('planSync: 从没同步过（syncedChecksum=null）一律算本地有改动，绝不静默丢数据', () => {
    eq(sync.planSync({ localRev: 0, localChecksum: 'x1', syncedChecksum: null, remote: { rev: 0 } }).action, 'push');
    eq(sync.planSync({ localRev: 0, localChecksum: 'x1', syncedChecksum: null, remote: { rev: 3 } }).action, 'conflict-pull');
    eq(sync.planSync({ localRev: 0, localChecksum: 'x1', syncedChecksum: null, remote: null }).action, 'push');
  });

  check('planSync: 远端脏数据（非对象 / rev 不是非负整数）按「没有可用快照」处理 → push', () => {
    for (const remote of [{}, { rev: 'x' }, { rev: -1 }, { rev: 1.5 }, 'oops', 5, []]) {
      const r = sync.planSync({ localRev: 2, localChecksum: 'aaaa0000', syncedChecksum: 'aaaa0000', remote });
      eq(r.action, 'push', 'remote=' + JSON.stringify(remote) + ' 应变通为首次上传');
    }
  });

  // ----- 冲突副本 -----

  check('makeConflictBackup / isConflictBackup: 正例（savedAt + payload，可过 JSON）', () => {
    const backup = sync.makeConflictBackup({ payload: SNAP_PAYLOAD, savedAt: 1700000000000 });
    deep(backup, { savedAt: 1700000000000, payload: SNAP_PAYLOAD });
    eq(sync.isConflictBackup(backup), true);
    eq(sync.isConflictBackup(JSON.parse(JSON.stringify(backup))), true);
  });

  check('makeConflictBackup: savedAt 缺省时回落到当前时间', () => {
    const before = Date.now();
    const backup = sync.makeConflictBackup({ payload: { a: 1 } });
    ok(backup.savedAt >= before && backup.savedAt <= Date.now(), 'savedAt 不在当前时间附近：' + backup.savedAt);
    eq(sync.isConflictBackup(backup), true);
  });

  check('isConflictBackup: 反例（只有半个形状 / 类型错 / 根本不是对象）', () => {
    const bad = [null, undefined, 0, 'x', true, [], {}, { savedAt: 1 }, { payload: {} }, { savedAt: 0, payload: {} },
      { savedAt: 'x', payload: {} }, { savedAt: 1, payload: [] }, { savedAt: 1, payload: 'x' }];
    for (const raw of bad) eq(sync.isConflictBackup(raw), false, String(raw) + ' 不是冲突副本');
  });

  check('isConflictBackup: 正式快照不算副本（副本不带 v/accountId/rev）', () => {
    const snap = sync.buildSnapshot({ accountId: 'u_1', rev: 1, savedAt: 1000, payload: {} });
    eq(sync.isConflictBackup(snap), false);
    eq('v' in sync.makeConflictBackup({ payload: {}, savedAt: 1 }), false, '副本不该带 v');
    eq('rev' in sync.makeConflictBackup({ payload: {}, savedAt: 1 }), false, '副本不该带 rev');
  });

  // ----- 防抖调度 -----

  check('createDebouncer: 连续 schedule 只 fire 一次，reason 取最后一次，计时被重置', () => {
    const clock = fakeClock();
    const fired = [];
    const d = sync.createDebouncer({ delayMs: 5000, onFire: (reason, waited) => fired.push([reason, waited]), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

    d.schedule('第一次改动');
    clock.advance(1000);
    d.schedule('第二次改动'); // 距第一次到期还有 4000ms
    clock.advance(4000);
    eq(fired.length, 0, '还没到第二次的窗口，不该 fire');
    eq(d.pending(), true);
    clock.advance(1000);
    eq(fired.length, 1, '连续 schedule 只能触发一次');
    deep(fired[0], ['第二次改动', 5000], 'onFire 应收到最后一次 reason 与真实等待时长');
    eq(d.pending(), false);
    eq(clock.live(), 0, 'fire 之后不该留下计时器');
  });

  check('createDebouncer: cancel 后不 fire，并且还能重新 schedule', () => {
    const clock = fakeClock();
    const fired = [];
    const d = sync.createDebouncer({ delayMs: 5000, onFire: (reason) => fired.push(reason), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

    d.schedule('被取消');
    clock.advance(2000);
    d.cancel();
    eq(d.pending(), false);
    eq(clock.live(), 0, 'cancel 应把计时器清掉');
    clock.advance(60000);
    eq(fired.length, 0, 'cancel 之后不能再 fire');

    d.schedule('第二次');
    eq(d.pending(), true);
    clock.advance(5000);
    deep(fired, ['第二次'], 'cancel 之后重新 schedule 要能正常触发');
  });

  check('createDebouncer: flush 立即 fire、清零计时、只触发一次', () => {
    const clock = fakeClock();
    const fired = [];
    const d = sync.createDebouncer({ delayMs: 5000, onFire: (reason, waited) => fired.push([reason, waited]), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

    d.schedule('手动同步');
    d.flush();
    deep(fired, [['手动同步', 0]], 'flush 必须同步触发，且 waited=0');
    eq(d.pending(), false);
    eq(clock.live(), 0, 'flush 应把计时器清掉');
    clock.advance(60000);
    eq(fired.length, 1, 'flush 之后旧窗口不能再补一枪');
    d.flush();
    eq(fired.length, 1, '没有未决触发时 flush 是空操作');
  });

  check('createDebouncer: 触发后回到空闲，可以再次被 schedule 触发', () => {
    const clock = fakeClock();
    const fired = [];
    const d = sync.createDebouncer({ delayMs: 5000, onFire: (reason) => fired.push(reason), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    d.schedule('a');
    clock.advance(5000);
    d.schedule('b');
    clock.advance(4999);
    eq(fired.length, 1);
    clock.advance(1);
    deep(fired, ['a', 'b']);
  });

  check('createDebouncer: 注入的假时钟/定时器真的被用上，默认 delayMs=5000', () => {
    const seen = [];
    let ticks = 0;
    const d = sync.createDebouncer({
      onFire: () => {},
      now: () => { ticks += 1; return 100; },
      setTimer: (fn, ms) => { seen.push(['set', ms]); return 'id-1'; },
      clearTimer: (id) => seen.push(['clear', id]),
    });
    d.schedule('x');
    ok(ticks > 0, '注入的 now 必须被调用');
    deep(seen, [['set', 5000]], '默认 delayMs 是 5000');
    d.schedule('y');
    deep(seen, [['set', 5000], ['clear', 'id-1'], ['set', 5000]], '再次 schedule 要先清掉旧计时再重排');
    d.cancel();
    deep(seen[seen.length - 1], ['clear', 'id-1']);
    eq(d.pending(), false);
  });

  check('createDebouncer: 什么都不注入也能构造（默认 Date.now/setTimeout）', () => {
    const d = sync.createDebouncer();
    eq(d.pending(), false);
    d.flush();  // 没有未决触发 → 空操作，不抛
    d.cancel();
    eq(d.pending(), false);
  });

  // ----- 摘要 -----

  check('snapshotSummary: records 合计 weights+meals+exercises+waters，bytes>0', () => {
    const snap = sync.buildSnapshot({ accountId: 'u_1', rev: 1, savedAt: 1700000000000, payload: SNAP_PAYLOAD });
    const sum = sync.snapshotSummary(snap);
    eq(sum.records, 3, 'weights 1 + meals 1 + waters 1 = 3');
    eq(sum.savedAt, 1700000000000);
    eq(sum.bytes, JSON.stringify(SNAP_PAYLOAD).length);
    ok(sum.bytes > 0);
  });

  check('snapshotSummary: 缺数组字段按 0 条算，payload 为空对象时 bytes 仍 > 0', () => {
    const snap = sync.buildSnapshot({ accountId: 'u_1', payload: { app: 'hms' } });
    const sum = sync.snapshotSummary(snap);
    eq(sum.records, 0);
    ok(sum.bytes > 0, 'bytes=' + sum.bytes);
  });

  check('snapshotSummary: 非法输入一律 null', () => {
    const bad = [null, undefined, 42, 'x', [], { v: 2 }, { v: 1, accountId: 'u_1', rev: 0, savedAt: 1 }, { v: 1, accountId: '', rev: 0, savedAt: 1, payload: {} }];
    for (const raw of bad) eq(sync.snapshotSummary(raw), null, String(raw) + ' 应返回 null');
  });
}

// ---------- 云同步的密钥边界（缺口 1）与「空库首次登录」（缺口 3） ----------

/** 假密钥：判据就是「剥离后的序列化结果里搜不到这个串」。 */
const FAKE_API_KEY = 'sk-live-DEADBEEF-0123456789';

/** runSyncOnce 的最小假存储：只记调用，不碰 IDB（决策与剥离/合并都不需要真库）。 */
function fakeSyncStorage(dump, state) {
  const log = { loadAll: [], setMeta: [], setSyncState: [], dumped: 0 };
  return {
    log,
    async dumpAll() {
      log.dumped += 1;
      return dump;
    },
    async getSyncState() {
      return state;
    },
    async setSyncState(next) {
      log.setSyncState.push(next);
    },
    async loadAll(payload, mode) {
      log.loadAll.push({ payload, mode });
    },
    async getMeta() {
      return null;
    },
    async setMeta(key, value) {
      log.setMeta.push([key, value]);
    },
  };
}

async function testSyncSecrets() {
  check('sync/pure: 密钥边界的三个导出是同一份实现（pure.js 只是再导出，不存在两份漂移）', () => {
    eq(pure.stripSyncSecrets, sync.stripSyncSecrets);
    eq(pure.mergeRemoteIntoLocal, sync.mergeRemoteIntoLocal);
    eq(pure.SYNC_EXCLUDED_SETTINGS, sync.SYNC_EXCLUDED_SETTINGS);
    deep(sync.SYNC_EXCLUDED_SETTINGS, ['apiKey']);
  });

  check('stripSyncSecrets: 删掉顶层 settings.apiKey，其它设置键原样保留', () => {
    const out = pure.stripSyncSecrets({
      settings: { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', weightUnit: 'jin' },
      weights: [],
    });
    eq('apiKey' in out.settings, false, 'apiKey 必须消失');
    eq(out.settings.model, 'qwen3-vl-plus');
    eq(out.settings.weightUnit, 'jin');
  });

  check('stripSyncSecrets: 快照真实形状（meta.settings）里的密钥也删掉，其它 meta 不动', () => {
    const dump = {
      app: 'hms',
      meta: {
        profile: { nickname: '小林' },
        settings: { apiKey: FAKE_API_KEY, model: 'm', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', weightUnit: 'kg' },
        mealTemplates: [{ id: '1', name: '早餐' }],
      },
      weights: [{ date: '2026-01-01', weightKg: 70 }],
    };
    const out = pure.stripSyncSecrets(dump);
    eq('apiKey' in out.meta.settings, false, 'meta.settings.apiKey 必须消失');
    eq(out.meta.settings.model, 'm');
    eq(out.meta.settings.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    eq(out.meta.settings.weightUnit, 'kg');
    deep(out.meta.profile, { nickname: '小林' });
    deep(out.meta.mealTemplates, [{ id: '1', name: '早餐' }]);
    eq(out.app, 'hms');
    eq(out.weights[0].weightKg, 70);
  });

  check('stripSyncSecrets: 返回深层新对象，改返回值（含嵌套）都不影响入参', () => {
    const settings = { apiKey: FAKE_API_KEY, model: 'm' };
    const templates = [{ id: '1', name: '早餐', items: [{ name: '鸡蛋', kcal: 90 }] }];
    const weights = [{ date: '2026-01-01', weightKg: 70 }];
    const dump = { meta: { settings, mealTemplates: templates }, weights };
    const out = pure.stripSyncSecrets(dump);

    ok(out !== dump && out.meta !== dump.meta && out.meta.settings !== settings, '每一层都必须是新对象');
    ok(out.meta.mealTemplates !== templates && out.meta.mealTemplates[0] !== templates[0], '数组与数组项也要新对象');
    ok(out.weights[0] !== weights[0], '业务记录也要新对象');

    out.meta.settings.model = '改了';
    out.meta.mealTemplates[0].name = '改了';
    out.meta.mealTemplates[0].items[0].kcal = 1;
    out.weights.push({ date: '2026-01-02' });

    eq(settings.model, 'm', '改返回值不能改到入参');
    eq(templates[0].name, '早餐');
    eq(templates[0].items[0].kcal, 90);
    eq(weights.length, 1);
    eq('apiKey' in settings, true, '剥离只发生在返回的副本上，入参一个键都不许少');
  });

  check('stripSyncSecrets: settings 缺失 / null / 非对象都不抛；非对象入参返回安全空对象', () => {
    for (const payload of [{}, { meta: {} }, { settings: null }, { settings: 'oops' }, { meta: null }, { meta: { settings: 42 } }, { meta: { settings: [] } }, { meta: { settings: null } }]) {
      const out = pure.stripSyncSecrets(payload);
      ok(out && typeof out === 'object' && !Array.isArray(out), '应返回对象：' + JSON.stringify(payload));
    }
    deep(pure.stripSyncSecrets(null), {});
    deep(pure.stripSyncSecrets(undefined), {});
    deep(pure.stripSyncSecrets('x'), {});
    deep(pure.stripSyncSecrets([]), {});
  });

  check('stripSyncSecrets: 剥离后的序列化结果里搜不到密钥串，业务数据一个不少', () => {
    const dump = {
      meta: { settings: { apiKey: FAKE_API_KEY, model: 'm' } },
      weights: [{ date: '2026-01-01', weightKg: 70 }],
      meals: [{ date: '2026-01-01', slot: 'lunch', items: [{ name: '米饭', kcal: 232 }] }],
    };
    const before = JSON.stringify(dump);
    const after = JSON.stringify(pure.stripSyncSecrets(dump));
    ok(before.includes(FAKE_API_KEY), '前置：原始 dump 里确实有密钥');
    eq(after.includes(FAKE_API_KEY), false, '剥离后不许再出现密钥串');
    ok(after.includes('2026-01-01') && after.includes('米饭'), '业务数据不能跟着丢');
  });

  check('mergeRemoteIntoLocal: 以远端为基准，远端设置覆盖本机', () => {
    const merged = pure.mergeRemoteIntoLocal({
      remote: { meta: { settings: { model: '远端模型', weightUnit: 'jin' } }, weights: [{ date: 'R' }] },
      local: { meta: { settings: { model: '本机模型', weightUnit: 'kg', baseUrl: '本机地址' }, profile: { nickname: '本机' } }, weights: [{ date: 'L' }] },
    });
    eq(merged.meta.settings.model, '远端模型');
    eq(merged.meta.settings.weightUnit, 'jin');
    eq(merged.meta.settings.baseUrl, undefined, '远端没表态的键不该由本机补上（设置以远端为准）');
    eq(merged.meta.profile, undefined, '本机没被覆盖的其它 meta 不该混进来');
    deep(merged.weights.map((w) => w.date), ['R'], '业务数据以远端为准');
  });

  check('mergeRemoteIntoLocal: 本机的 apiKey 原样保留（远端是被剥过的那份）', () => {
    const merged = pure.mergeRemoteIntoLocal({
      remote: { meta: { settings: { model: 'm', baseUrl: 'https://x/v1', weightUnit: 'kg' } } },
      local: { meta: { settings: { apiKey: FAKE_API_KEY, model: '旧模型', baseUrl: '旧地址', weightUnit: 'jin' } } },
    });
    eq(merged.meta.settings.apiKey, FAKE_API_KEY, '本机密钥必须留下');
    eq(merged.meta.settings.model, 'm', '非密钥键仍然以远端为准');
    eq(merged.meta.settings.weightUnit, 'kg');
  });

  check('mergeRemoteIntoLocal: 远端带来的排除键一律丢弃（老版本传上去的密钥不会传回本机）', () => {
    const merged = pure.mergeRemoteIntoLocal({
      remote: { meta: { settings: { apiKey: '云端那份密钥', model: 'm' } } },
      local: { meta: { settings: { model: '本机' } } },
    });
    eq('apiKey' in merged.meta.settings, false, '远端密钥不许进本机');
    eq(merged.meta.settings.model, 'm');
  });

  check('mergeRemoteIntoLocal: 远端没有 settings（或只有空对象）时本机设置不丢', () => {
    const local = { meta: { settings: { apiKey: FAKE_API_KEY, model: '本机模型', baseUrl: '本机地址', weightUnit: 'jin' } } };

    const missing = pure.mergeRemoteIntoLocal({ remote: { meta: { profile: { nickname: '云端用户' } } }, local });
    deep(missing.meta.settings, { apiKey: FAKE_API_KEY, model: '本机模型', baseUrl: '本机地址', weightUnit: 'jin' }, '远端没带设置 → 本机设置整份保留');
    eq(missing.meta.profile.nickname, '云端用户');

    const empty = pure.mergeRemoteIntoLocal({ remote: { meta: { settings: {} } }, local });
    eq(empty.meta.settings.model, '本机模型', '远端 settings 为空对象 = 没表态，本机设置照旧');
    eq(empty.meta.settings.apiKey, FAKE_API_KEY);
  });

  check('mergeRemoteIntoLocal: 非法输入一律不抛（两边都不是对象 → 安全空对象）', () => {
    deep(pure.mergeRemoteIntoLocal(), {});
    deep(pure.mergeRemoteIntoLocal({}), {});
    deep(pure.mergeRemoteIntoLocal({ remote: null, local: null }), {});
    deep(pure.mergeRemoteIntoLocal({ remote: 'x', local: 42 }), {});
    deep(pure.mergeRemoteIntoLocal({ remote: [], local: [] }), {});
    const out = pure.mergeRemoteIntoLocal({ remote: 'x', local: { settings: { apiKey: FAKE_API_KEY } } });
    eq(out.settings.apiKey, FAKE_API_KEY, '远端整份不可用时也不能把本机的密钥弄丢');
  });

  check('mergeRemoteIntoLocal: 结果与两个入参互不共享引用', () => {
    const remote = { meta: { settings: { model: 'm' } } };
    const local = { meta: { settings: { apiKey: FAKE_API_KEY } } };
    const merged = pure.mergeRemoteIntoLocal({ remote, local });
    ok(merged !== remote && merged.meta !== remote.meta && merged.meta.settings !== remote.meta.settings);
    merged.meta.settings.model = '改了';
    eq(remote.meta.settings.model, 'm');
    eq(local.meta.settings.apiKey, FAKE_API_KEY);
  });

  // ----- 缺口 3：空库 + 从没同步过 = 新设备首次登录 -----

  check('businessRecordCount: 四张明细表条数合计（照片与 meta 不计入）', () => {
    eq(sync.businessRecordCount({}), 0);
    eq(sync.businessRecordCount({ meta: { settings: { apiKey: FAKE_API_KEY } }, photoCount: 9 }), 0, '只有 meta / photoCount 也算空库');
    eq(sync.businessRecordCount({ weights: [1], meals: [1, 2], exercises: [], waters: [1], photoCount: 9 }), 4);
    eq(sync.businessRecordCount(null), 0);
  });

  check('planSync: 空库 + 从没同步过 + 远端更新 → pull（不留空的冲突副本）', () => {
    const r = sync.planSync({ localRev: 0, localChecksum: 'e3b0c442', syncedChecksum: null, remote: { rev: 5 }, localRecordCount: 0 });
    eq(r.action, 'pull');
    eq(r.reason, '本机没有业务数据且从没同步过，直接拉取远端');
  });

  check('planSync: 空库 + 从没同步过（版本一致 → none；远端没有快照 → push）', () => {
    eq(sync.planSync({ localRev: 0, localChecksum: 'x', syncedChecksum: null, remote: { rev: 0 }, localRecordCount: 0 }).action, 'none');
    eq(sync.planSync({ localRev: 0, localChecksum: 'x', syncedChecksum: null, remote: null, localRecordCount: 0 }).action, 'push');
  });

  check('planSync: 本地有业务记录、或同步过一次，规则照旧（例外没被放宽）', () => {
    eq(sync.planSync({ localRev: 0, localChecksum: 'x', syncedChecksum: null, remote: { rev: 5 }, localRecordCount: 1 }).action, 'conflict-pull');
    eq(sync.planSync({ localRev: 0, localChecksum: 'x', syncedChecksum: null, remote: { rev: 5 } }).action, 'conflict-pull', '不传记录数 = 旧调用方，行为必须不变');
    eq(sync.planSync({ localRev: 2, localChecksum: 'y', syncedChecksum: 'x', remote: { rev: 5 }, localRecordCount: 0 }).action, 'conflict-pull', '空库但同步过一次，再有改动仍先留副本');
    eq(sync.planSync({ localRev: 2, localChecksum: 'x', syncedChecksum: 'x', remote: { rev: 5 }, localRecordCount: 0 }).action, 'pull');
  });

  await checkAsync('runSyncOnce: 空库 + 从没同步过 → pull，setMeta(conflictBackup) 一次都没被调用', async () => {
    const dump = {
      app: 'hms',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      meta: { settings: { apiKey: FAKE_API_KEY, model: '本机模型' } },
      weights: [],
      meals: [],
      exercises: [],
      waters: [],
      photoCount: 0,
    };
    const storage = fakeSyncStorage(dump, { rev: 0, savedAt: null, checksum: null });
    const remotePayload = {
      app: 'hms',
      schemaVersion: 1,
      meta: { settings: { model: '云端模型' }, profile: { nickname: '云端用户' } },
      weights: [{ id: 1, date: '2020-01-01', weightKg: 60, createdAt: 1 }],
      meals: [],
      exercises: [],
      waters: [],
      photoCount: 0,
    };
    const result = await sync.runSyncOnce({
      accountId: 'acc_1',
      token: 'tok',
      storage,
      transport: {
        async pull() {
          return { ok: true, rev: 5, savedAt: 1700000000000, payload: remotePayload };
        },
        async push() {
          throw new Error('空库首次登录不该走上传');
        },
      },
    });

    eq(result.ok, true);
    eq(result.action, 'pull');
    eq(result.rev, 5);
    eq(storage.log.setMeta.length, 0, '不该写任何 meta（冲突副本就是走这里）');
    eq(storage.log.loadAll.length, 1);
    eq(storage.log.loadAll[0].mode, 'replace');
    deep(storage.log.loadAll[0].payload.weights.map((w) => w.date), ['2020-01-01'], '云端数据要落到本机');
    eq(storage.log.loadAll[0].payload.meta.settings.model, '云端模型', '远端设置覆盖本机');
    eq(storage.log.loadAll[0].payload.meta.settings.apiKey, FAKE_API_KEY, '本机密钥要跟着落库数据一起带上');
    eq(storage.log.setSyncState.length, 1);
    eq(storage.log.setSyncState[0].rev, 5);
    eq(storage.log.setSyncState[0].savedAt, 1700000000000);
  });

  await checkAsync('runSyncOnce: 本机有记录 + 从没同步过 → 仍然 conflict-pull 且副本里没有密钥', async () => {
    const dump = {
      app: 'hms',
      schemaVersion: 1,
      meta: { settings: { apiKey: FAKE_API_KEY, model: '本机模型' } },
      weights: [{ id: 1, date: '2026-05-05', weightKg: 70, createdAt: 1 }],
      meals: [],
      exercises: [],
      waters: [],
      photoCount: 0,
    };
    const storage = fakeSyncStorage(dump, { rev: 0, savedAt: null, checksum: null });
    const result = await sync.runSyncOnce({
      accountId: 'acc_1',
      token: 'tok',
      storage,
      transport: {
        async pull() {
          return { ok: true, rev: 5, savedAt: 1700000000000, payload: { app: 'hms', meta: {}, weights: [{ id: 9, date: '2020-01-01', weightKg: 60 }], meals: [], exercises: [], waters: [] } };
        },
        async push() {
          throw new Error('conflict-pull 不该走上传');
        },
      },
    });

    eq(result.action, 'conflict-pull');
    const backups = storage.log.setMeta.filter(([key]) => key === sync.CONFLICT_BACKUP_KEY);
    eq(backups.length, 1, '本机有数据时必须留下副本');
    ok(sync.isConflictBackup(backups[0][1]), '副本形状要对');
    ok(backups[0][1].payload.weights.some((w) => w.date === '2026-05-05'), '副本里是被覆盖掉的本机数据');
    eq(JSON.stringify(backups[0][1].payload).includes(FAKE_API_KEY), false, '副本里同样不许出现密钥串');
  });

  await checkAsync('runSyncOnce: 上传的 payload 里搜不到密钥串，锚点也按剥离后的内容算', async () => {
    const dump = {
      app: 'hms',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      meta: {
        settings: { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', weightUnit: 'jin' },
        profile: { nickname: '小林' },
      },
      weights: [{ id: 1, date: '2026-01-01', weightKg: 70, createdAt: 1 }],
      meals: [],
      exercises: [],
      waters: [],
      photoCount: 3,
    };
    const storage = fakeSyncStorage(dump, { rev: 0, savedAt: null, checksum: null });
    const pushed = [];
    const result = await sync.runSyncOnce({
      accountId: 'acc_1',
      token: 'tok',
      storage,
      transport: {
        async pull() {
          return { ok: true, rev: 0, savedAt: 0, payload: {} };
        },
        async push(args) {
          pushed.push(args);
          return { ok: true, rev: 1 };
        },
      },
    });

    eq(result.action, 'push');
    eq(pushed.length, 1);
    const json = JSON.stringify(pushed[0].payload);
    eq(json.includes(FAKE_API_KEY), false, '上传内容里不许出现密钥串');
    eq('apiKey' in pushed[0].payload.meta.settings, false);
    eq(pushed[0].payload.meta.settings.model, 'qwen3-vl-plus', '其它设置必须还在');
    eq(pushed[0].payload.meta.settings.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    eq(pushed[0].payload.meta.settings.weightUnit, 'jin');
    eq(pushed[0].payload.weights[0].weightKg, 70, '业务数据不能跟着丢');
    eq(pushed[0].payload.photoCount, 3);
    eq(storage.log.setSyncState[0].checksum, sync.checksum(pushed[0].payload), '锚点记的是「云端收到的那份」');
  });
}

// ---------- store 的同步锚点与数据体（最小假 IDB，跑完清 db.js 单例） ----------

async function testSyncStore() {
  await checkAsync('store: getSyncState 默认值 { rev:0, savedAt:null, checksum:null }', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      deep(await store.getSyncState(), { rev: 0, savedAt: null, checksum: null });
    });
  });

  await checkAsync('store: setSyncState / getSyncState 往返，落在 meta.syncState，非法值归一化', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await store.setSyncState({ rev: 3, savedAt: 1700000000000, checksum: 'abcd1234' });
      deep(await store.getSyncState(), { rev: 3, savedAt: 1700000000000, checksum: 'abcd1234' });
      // 键名必须就是 sync.js 的 SYNC_STATE_KEY（store 里写的是字面量，靠这条钉死不许漂）
      deep(await db.getMeta(sync.SYNC_STATE_KEY, null), { rev: 3, savedAt: 1700000000000, checksum: 'abcd1234' });

      await store.setSyncState({ rev: -1, savedAt: 'x', checksum: 42 });
      deep(await store.getSyncState(), { rev: 0, savedAt: null, checksum: null });
      await store.setSyncState();
      deep(await store.getSyncState(), { rev: 0, savedAt: null, checksum: null });
    });
  });

  await checkAsync('store: clearSyncState 删掉 meta.syncState（不是写 null）后回到默认值', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await store.setSyncState({ rev: 2, savedAt: 1, checksum: 'ff' });
      await store.clearSyncState();
      deep(await store.getSyncState(), { rev: 0, savedAt: null, checksum: null });
      eq(await db.getMeta(sync.SYNC_STATE_KEY, null), null);
    });
  });

  await checkAsync('store: getSyncPayload 复用 exportJSON，抹掉易变字段后连续两次校验和一致', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await store.logWeight({ date: '2026-01-01', weightKg: 70 });
      const p1 = await store.getSyncPayload();
      const p2 = await store.getSyncPayload();

      eq(p1.app, 'hms');
      ok(p1.schemaVersion >= 1);
      eq(typeof p1.photoCount, 'number');
      deep(p1.weights.map((w) => w.date), ['2026-01-01']);
      for (const key of ['meals', 'exercises', 'waters']) ok(Array.isArray(p1[key]), key + ' 应是数组');
      eq(sync.checksum(p1), sync.checksum(p2), '同一次数据算两次必须同值，否则永远算「有改动」');

      // 三个每次导出/同步都会变的字段必须抹掉
      eq('exportedAt' in p1, false, '顶层 exportedAt 每次都变');
      eq('syncState' in p1.meta, false, 'meta.syncState 写锚点时会变');
      eq('lastExportedAt' in p1.meta, false, 'meta.lastExportedAt 每次 exportJSON 都会变');

      // 真有改动 → 校验和必须变
      await store.logWeight({ date: '2026-01-02', weightKg: 71 });
      const p3 = await store.getSyncPayload();
      ok(sync.checksum(p3) !== sync.checksum(p1), '写了新记录，校验和必须变');

      // 写同步锚点不能把自己算成「有改动」（否则同步完立刻又是脏的）
      await store.setSyncState({ rev: 1, savedAt: 1700000000000, checksum: sync.checksum(p3) });
      const p4 = await store.getSyncPayload();
      eq(sync.checksum(p4), sync.checksum(await store.getSyncPayload()), '锚点变化不算本地改动');

      // 端到端串一次决策：刚同步过 + 远端同版本 → none
      const state = await store.getSyncState();
      const plan = sync.planSync({ localRev: state.rev, localChecksum: sync.checksum(p4), syncedChecksum: state.checksum, remote: { rev: state.rev } });
      eq(plan.action, 'none', '刚同步完应判「无需同步」，实际：' + JSON.stringify(plan));
    });
  });

  await checkAsync('store: 假 IDB 撤走后 getSyncState 仍抛中文错误（单例确实清了）', async () => {
    if (!IDB_ABSENT) return;
    let msg = '';
    try { await store.getSyncState(); } catch (err) { msg = err.message; }
    eq(msg, IDB_MSG);
  });
}

// ---------- 写入通知 / 静默窗口（缺口 4 的接线点）与导入恢复范围（缺口 2） ----------

async function testMutationHooks() {
  await checkAsync('db: onMutation 在写入落库后触发，注销后不再触发', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const seen = [];
      const off = db.onMutation((info) => seen.push(info));
      try {
        await store.logWeight({ date: '2027-01-01', weightKg: 70 });
        eq(seen.length, 1, '写一条体重应触发一次');
        deep(seen[0].stores, ['weights']);
        await db.setMeta('profile', { nickname: 'x' });
        eq(seen.length, 2, 'meta 写入同样算本机改动');
        deep(seen[1].stores, ['meta']);
        off();
        await store.logWeight({ date: '2027-01-02', weightKg: 71 });
        eq(seen.length, 2, '注销后不该再有通知');
      } finally {
        off();
      }
    });
  });

  await checkAsync('db: withMutedMutations 期间静默、支持嵌套，结束后恢复触发', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const seen = [];
      const off = db.onMutation(() => seen.push(1));
      try {
        await db.withMutedMutations(async () => {
          await store.logWeight({ date: '2027-02-01', weightKg: 70 });
          eq(seen.length, 0, '静默期间不该触发');
          await db.withMutedMutations(async () => {
            await store.logWeight({ date: '2027-02-02', weightKg: 71 });
          });
          eq(seen.length, 0, '内层结束后外层仍然静默（嵌套计数）');
          await db.setMeta('profile', { nickname: 'y' });
          eq(seen.length, 0);
        });
        eq(seen.length, 0, '静默块结束不该补发通知');
        await store.logWeight({ date: '2027-02-03', weightKg: 72 });
        eq(seen.length, 1, '静默结束后恢复正常触发');
      } finally {
        off();
      }
    });
  });

  await checkAsync('db: withMutedMutations 异常安全（抛错后静默计数也要放回去）', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const seen = [];
      const off = db.onMutation(() => seen.push(1));
      try {
        let msg = '';
        try {
          await db.withMutedMutations(async () => {
            await store.logWeight({ date: '2027-03-01', weightKg: 70 });
            throw new Error('静默块里炸了');
          });
        } catch (err) {
          msg = err.message;
        }
        eq(msg, '静默块里炸了', '异常必须原样抛出');
        await store.logWeight({ date: '2027-03-02', weightKg: 71 });
        eq(seen.length, 1, '异常路径后仍要恢复触发（finally 放回计数）');
      } finally {
        off();
      }
    });
  });

  await checkAsync('db: handler 抛错 / 返回 rejected promise 都不影响写入，其它 handler 照常收到', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const okStores = [];
      const off1 = db.onMutation(() => {
        throw new Error('handler 同步炸了');
      });
      const off2 = db.onMutation(() => Promise.reject(new Error('handler 异步炸了')));
      const off3 = db.onMutation((info) => okStores.push(info.stores.join(',')));
      try {
        await store.logWeight({ date: '2027-04-01', weightKg: 68 });
        deep(okStores, ['weights'], '一个 handler 炸掉不该挡住其它 handler');
        const dump = await db.dumpAll();
        ok(dump.weights.some((w) => w.date === '2027-04-01'), '写入必须真的落库');
      } finally {
        off1();
        off2();
        off3();
      }
    });
  });

  await checkAsync('db: 同步锚点 / 导出时间 / 照片都不算本机改动（否则自动同步自我循环）', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const seen = [];
      const off = db.onMutation((info) => seen.push(info.stores.join(',')));
      try {
        await db.setMeta('syncState', { rev: 1, savedAt: 1, checksum: 'aa' });
        await db.setMeta('lastExportedAt', Date.now());
        await db.del('meta', 'syncState');
        await db.put('photos', { id: 'p1', blob: 'fake-blob', mime: 'image/jpeg', createdAt: 1 });
        eq(seen.length, 0, '锚点 / 导出时间 / 照片都不该通知');
        await db.setMeta('profile', { nickname: 'z' });
        eq(seen.length, 1, '真改动仍然照常通知');
      } finally {
        off();
      }
    });
  });

  await checkAsync('db: 导入备份 / 应用云端快照（loadAll）与清空数据期间都静默', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      const seen = [];
      const off = db.onMutation(() => seen.push(1));
      try {
        await db.loadAll({
          meta: {
            profile: { nickname: '导入的' },
            settings: { apiKey: 'key-from-backup', model: 'backup-model' },
            mealTemplates: [{ id: '1', name: '早餐', slot: 'breakfast', items: [{ name: '鸡蛋', kcal: 90 }] }],
          },
          weights: [{ date: '2026-06-01', weightKg: 66 }],
        }, 'replace');
        eq(seen.length, 0, 'loadAll 期间必须静默（否则刚拉下来就推回去）');
        await db.clearBusinessData();
        eq(seen.length, 0, '清空数据期间必须静默');
        await store.logWeight({ date: '2026-06-02', weightKg: 67 });
        eq(seen.length, 1, '静默结束后恢复正常触发');
      } finally {
        off();
      }
    });
  });

  await checkAsync('db: 导入 / 拉取能恢复 meta.settings 与 meta.mealTemplates（密钥按边界处理）', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await store.saveSettings({ apiKey: 'local-key-keep', model: 'local-model', weightUnit: 'kg' });
      const backup = {
        meta: {
          settings: { apiKey: 'key-from-backup', model: 'backup-model', baseUrl: 'https://backup.example/v1', weightUnit: 'jin' },
          mealTemplates: [
            { id: '1', name: '减脂早餐', slot: 'breakfast', items: [{ name: '鸡蛋', kcal: 90 }] },
            { id: '2', name: '整日套餐', kind: 'day', meals: [{ slot: 'lunch', items: [{ name: '米饭', kcal: 232 }] }, { slot: 'dinner', items: [{ name: '鸡胸', kcal: 165 }] }] },
          ],
        },
        weights: [{ date: '2026-06-01', weightKg: 66 }],
      };

      // merge：已有设置保留（「只补缺失」的老语义），套餐是补进来的
      await db.loadAll(backup, 'merge');
      let settings = await store.getSettings();
      eq(settings.model, 'local-model', 'merge 不该覆盖本机已有设置');

      // replace（云端拉取走的就是它）：设置 / 套餐都跟着备份数据走，但密钥只认本机
      await db.loadAll(backup, 'replace');
      settings = await store.getSettings();
      eq(settings.model, 'backup-model', '模型名要跟着备份/云端走');
      eq(settings.baseUrl, 'https://backup.example/v1');
      eq(settings.weightUnit, 'jin', '单位偏好要跟着备份/云端走');
      eq(settings.apiKey, 'local-key-keep', '备份里的密钥不许装进来，本机密钥不许被冲掉');

      const templates = await store.getMealTemplates();
      deep(templates.map((t) => t.name), ['减脂早餐', '整日套餐'], '常吃套餐要跟着走');
      eq(templates[1].kind, 'day');
      eq(templates[1].meals.length, 2);
      eq(templates[0].items[0].name, '鸡蛋');
    });
  });

  await checkAsync('db: 远端 settings 里的 apiKey 为空值时也不覆盖本机密钥', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await store.saveSettings({ apiKey: 'local-key-keep', model: 'local-model' });
      await db.loadAll({ meta: { settings: { apiKey: '', model: 'remote-model', weightUnit: 'jin' } }, weights: [] }, 'replace');
      const settings = await store.getSettings();
      eq(settings.apiKey, 'local-key-keep', '空值同样不许覆盖本机密钥');
      eq(settings.model, 'remote-model', '非密钥键仍然跟着远端走');
      eq(settings.weightUnit, 'jin');
    });
  });

  await checkAsync('db: 照片不进快照（只留 photoCount），导入 / 拉取也不会删本机照片', async () => {
    if (!IDB_ABSENT) return;
    await withFakeIdb(async () => {
      await db.put('photos', { id: 'p1', blob: 'fake-blob', mime: 'image/jpeg', createdAt: 1 });
      const dump = await db.dumpAll();
      eq(dump.photoCount, 1);
      eq('photos' in dump, false, '照片本体不进 JSON');
      await db.loadAll({ meta: {}, weights: [{ date: '2026-07-01', weightKg: 70 }] }, 'replace');
      eq((await db.dumpAll()).photoCount, 1, '导入 / 拉取不该删照片');
    });
  });
}

// ---------- 入口 ----------

// ---------- 云同步的载荷压缩（网关请求体上限 102400 字节） ----------
//
// 网关对 /push 请求体的硬上限是 102400 字节，超一个字节就是 413 EXCEED_MAX_PAYLOAD_SIZE，
// 而那个 413 不带 CORS 头 —— 真机上只会显示「网络不可用」。所以判断必须发生在发请求之前。
// 这一节盯四件事：UTF-8 字节数算对、压缩往返不丢数据、超限一次请求都不发、老快照照旧能读。

/** 确定性伪随机串：给「压不动的大载荷」用（xorshift32 高低位都均匀，gzip 压不下去）。 */
function randomText(size, alphabet) {
  const chars = alphabet || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 0x2f6e2b1;
  const out = [];
  for (let i = 0; i < size; i += 1) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    out.push(chars[state % chars.length]);
  }
  return out.join('');
}

/** 读起来像真实用户数据的快照载荷：中文 / emoji / 嵌套，每条略有不同（不像 fixture 那样压到 2%）。 */
function userShapedPayload(records) {
  const foods = ['米饭', '鸡蛋', '牛奶', '鸡胸肉', '西兰花', '苹果', '全麦面包', '酸奶', '牛肉', '豆腐', '菠菜', '香蕉'];
  const slots = ['早餐', '午餐', '晚餐', '加餐'];
  const total = Number.isFinite(records) && records > 0 ? Math.floor(records) : 20;
  const meals = [];
  for (let i = 0; i < total; i += 1) {
    meals.push({
      id: i + 1,
      date: '2026-03-' + String(1 + (i % 28)).padStart(2, '0'),
      slot: slots[i % 4],
      items: [{
        name: foods[i % foods.length] + (i % 7 === 0 ? ' 🍚' : ''),
        grams: 100 + (i % 7) * 25,
        kcal: 120 + (i % 13) * 17,
        carbs: Number((12.5 + (i % 11) * 1.7).toFixed(1)),
        protein: Number((5.5 + (i % 9) * 2.1).toFixed(1)),
        fat: Number((3.2 + (i % 5) * 1.3).toFixed(1)),
      }],
      note: i % 5 === 0 ? '外食，少油' : '',
      createdAt: 1772000000000 + i * 3600000,
    });
  }
  const weights = [];
  for (let i = 0; i < Math.max(1, Math.round(total / 10)); i += 1) {
    weights.push({ date: '2026-02-' + String(1 + (i % 28)).padStart(2, '0'), weightKg: Number((70 - i * 0.15).toFixed(1)) });
  }
  return {
    app: 'hms',
    schemaVersion: 1,
    meta: { settings: { model: 'qwen3-vl-plus', weightUnit: 'kg' }, profile: { nickname: '小林 🌱', sex: 'male', birthday: '1990-01-01', heightCm: 175 } },
    weights,
    meals,
    exercises: [],
    waters: [{ date: '2026-03-01', ml: 1500 }],
    photoCount: 0,
  };
}

/** 与浏览器等价、但走 node:zlib 的压缩器：这组用例不依赖全局 CompressionStream。 */
function zlibCompressor() {
  return {
    async compressToBase64(text) {
      return zlib.gzipSync(Buffer.from(String(text), 'utf8')).toString('base64');
    },
    async decompressFromBase64(base64) {
      return zlib.gunzipSync(Buffer.from(String(base64), 'base64')).toString('utf8');
    },
  };
}

/** 临时摘掉一个全局（TextEncoder / CompressionStream 之类），无论如何都装回去。 */
async function withoutGlobal(name, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  delete globalThis[name];
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, name, had);
  }
}

function bodyBytesOf(payload, token, baseRev) {
  return sync.utf8Bytes(sync.pushBodyText({ token, baseRev, payload }));
}

function fakePullTransport(pull) {
  const pushes = [];
  return {
    pushes,
    async pull() {
      return pull;
    },
    async push(args) {
      pushes.push(args);
      return { ok: true, rev: 1 };
    },
  };
}

async function testSyncCompression() {
  // ----- 契约与字节数 -----

  check('sync/压缩: 导出契约完整，安全阈值 = 网关硬上限 − 2400 字节余量', () => {
    for (const name of ['GZIP_MARKER_KEY', 'PUSH_BODY_LIMIT_BYTES', 'PUSH_COMPRESS_MIN_BYTES', 'utf8Bytes',
      'pushBodyText', 'compressedPayloadOf', 'isCompressedPayload', 'createStreamCompressor',
      'encodePayloadForUpload', 'decodePayloadFromCloud']) {
      ok(name in sync, 'sync.' + name + ' 缺失');
    }
    eq(sync.GZIP_MARKER_KEY, '__gz');
    eq(sync.PUSH_BODY_LIMIT_BYTES, 100000, '安全阈值取 100000 字节');
    eq(sync.PUSH_BODY_LIMIT_BYTES, cloudApi.GATEWAY_MAX_REQUEST_BYTES - 2400, '阈值必须给 token 与包装留出 2400 字节余量');
    ok(sync.PUSH_COMPRESS_MIN_BYTES > 0 && sync.PUSH_COMPRESS_MIN_BYTES < sync.PUSH_BODY_LIMIT_BYTES);
    deep(sync.compressedPayloadOf('AAA'), { __gz: 'AAA' });
  });

  check('sync/压缩: utf8Bytes 按 UTF-8 算（中文 3 / emoji 4 / 英文 1），与 Buffer.byteLength 一致', () => {
    const samples = ['', 'abc', '中文', '中'.repeat(50), '小林 🌱', 'a中文b', '😀😀', 'é€', JSON.stringify(userShapedPayload(5))];
    for (const text of samples) {
      eq(sync.utf8Bytes(text), Buffer.byteLength(text, 'utf8'), 'UTF-8 字节数不一致: ' + text.slice(0, 16));
    }
    eq('中文'.length, 2, '前置: 这两个字的字符数只有 2');
    eq(sync.utf8Bytes('中文'), 6);
    eq(sync.utf8Bytes('中'.repeat(5)), 15);
    eq(sync.utf8Bytes('a'.repeat(5)), 5);
    eq(sync.utf8Bytes('😀'), 4);
    eq(sync.utf8Bytes('中'.repeat(10)) === sync.utf8Bytes('a'.repeat(10)), false, '同样字符数的中文与英文字节数必须不同');
    ok(sync.utf8Bytes('中文') > '中文'.length, '按字符数算会小三分之二: 正好是最危险的方向');
  });

  await checkAsync('sync/压缩: 没有 TextEncoder 时兜底算法结果不变（与 TextEncoder 逐项一致）', async () => {
    const samples = ['abc', '中文测试', '小林 🌱 emoji 😀', JSON.stringify(userShapedPayload(3))];
    const expected = samples.map((text) => sync.utf8Bytes(text));
    await withoutGlobal('TextEncoder', async () => {
      eq(typeof globalThis.TextEncoder, 'undefined', '前置: 全局确实被摘掉了');
      samples.forEach((text, index) => eq(sync.utf8Bytes(text), expected[index], '兜底算法与 TextEncoder 不一致: ' + text.slice(0, 12)));
      eq(sync.utf8Bytes('中文'), 6);
      eq(sync.utf8Bytes('😀'), 4);
    });
    eq(typeof globalThis.TextEncoder, 'function', '跑完必须把全局装回去');
  });

  check('sync/压缩: 只认 { __gz } 包装，普通 JSON 老快照不被误判', () => {
    ok(sync.isCompressedPayload({ __gz: 'H4sIAAAA' }));
    eq(sync.isCompressedPayload({ __gz: '' }), true, '有键就是压缩体: 空串要在解压时报错，而不是当数据读');
    eq(sync.compressedPayloadOf('x')[sync.GZIP_MARKER_KEY], 'x');
    for (const legacy of [SNAP_PAYLOAD, { app: 'hms' }, {}, { gz: 'x' }, { gzipped: true }, { __gz: 5 }, { __gz: null }, null, undefined, 'x', 7, [], [{ __gz: 'z' }]]) {
      eq(sync.isCompressedPayload(legacy), false, '被误判成压缩体: ' + JSON.stringify(legacy));
    }
  });

  check('sync/压缩: 量的是完整请求体（token / baseRev 都算进去）', () => {
    const payload = { a: 1 };
    const withToken = bodyBytesOf(payload, 'x'.repeat(500), 9);
    const withoutToken = bodyBytesOf(payload, '', 9);
    ok(withToken - withoutToken >= 500, 'token 的长度必须计入: ' + (withToken - withoutToken));
    eq(sync.pushBodyText({ token: 't', baseRev: 1, payload }).includes('"baseRev":1'), true, 'baseRev 在同一个请求体里');
    const text = sync.pushBodyText({ token: '中文令牌', baseRev: 1, payload });
    eq(sync.utf8Bytes(text), Buffer.byteLength(text, 'utf8'), '中文 token 也要按字节算');
  });

  // ----- 往返 -----

  await checkAsync('sync/压缩: 中文 / emoji / 嵌套载荷编码 → { __gz } → 解码往返深度相等', async () => {
    const payload = userShapedPayload(60);
    const codec = zlibCompressor();
    const encoded = await sync.encodePayloadForUpload({ payload, token: 'tok', baseRev: 3, compressor: codec });
    eq(encoded.ok, true);
    eq(encoded.mode, 'gzip');
    eq(encoded.compressed, true);
    ok(sync.isCompressedPayload(encoded.payload), '上传的载荷应该是 { __gz } 包装');
    eq(Object.keys(encoded.payload).join(','), '__gz', '包装体只该有 __gz 一个键');
    eq(typeof encoded.payload.__gz, 'string');
    eq(encoded.body.includes('西兰花'), false, '压缩后的请求体里不该还能看到明文');
    eq(encoded.body.includes('__gz'), true, '请求体里应该出现标记键');
    const decoded = await sync.decodePayloadFromCloud(encoded.payload, { compressor: codec });
    eq(decoded.ok, true);
    eq(decoded.compressed, true);
    deep(decoded.payload, payload, '往返必须深度相等');
    deep(JSON.parse(encoded.body).payload, encoded.payload, '服务端视角: 它拿到的就是一个普通 JSON 对象');
  });

  await checkAsync('sync/压缩: 环境默认压缩器（CompressionStream）同样能往返，且与 zlib 互相认得', async () => {
    const codec = sync.createStreamCompressor();
    ok(codec, '这个运行环境应该有 CompressionStream / DecompressionStream');
    eq(sync.createStreamCompressor({}), null, '没有这两个能力的 scope 必须返回 null');
    const payload = userShapedPayload(75); // 13KB 量级：超过默认压缩阈值，走真实默认策略
    const encoded = await sync.encodePayloadForUpload({ payload, token: 't', baseRev: 0, compressor: codec });
    eq(encoded.mode, 'gzip');
    ok(encoded.rawBytes > sync.PUSH_COMPRESS_MIN_BYTES, '前置: 这份载荷在默认阈值之上');
    const decoded = await sync.decodePayloadFromCloud(encoded.payload, { compressor: codec });
    eq(decoded.ok, true);
    deep(decoded.payload, payload);
    const viaZlib = await sync.decodePayloadFromCloud(encoded.payload, { compressor: zlibCompressor() });
    eq(viaZlib.ok, true);
    deep(viaZlib.payload, payload, '默认实现产出的 gzip 流必须能被 zlib 解开');
  });

  // ----- 压缩比 / 回退 -----

  await checkAsync('sync/压缩: ≥20KB 样例压后不到原始的 60%（用户 13KB 规模同样生效）', async () => {
    const payload = userShapedPayload(120);
    const rawBytes = bodyBytesOf(payload, 'tok', 1);
    ok(rawBytes >= 20000, '前置: 样例要 ≥20KB，实际 ' + rawBytes);
    const encoded = await sync.encodePayloadForUpload({ payload, token: 'tok', baseRev: 1, compressor: zlibCompressor() });
    eq(encoded.mode, 'gzip');
    eq(encoded.rawBytes, rawBytes);
    ok(encoded.bytes < rawBytes * 0.6, '压缩后 ' + encoded.bytes + ' 应不到原始的 60%（原始 ' + rawBytes + '）');
    ok(encoded.bytes < encoded.rawBytes);

    const userPayload = userShapedPayload(75);
    const userRaw = bodyBytesOf(userPayload, 'tok', 1);
    ok(userRaw >= 12000, '前置: 用户规模样例要 ≥12KB，实际 ' + userRaw);
    const userEncoded = await sync.encodePayloadForUpload({ payload: userPayload, token: 'tok', baseRev: 1, compressor: zlibCompressor() });
    eq(userEncoded.mode, 'gzip');
    ok(userEncoded.bytes < userRaw * 0.4, '13KB 规模压缩后 ' + userEncoded.bytes + ' 应不到原始的 40%（原始 ' + userRaw + '）');
  });

  await checkAsync('sync/压缩: 压缩后反而更大时选择不压缩（小数据不吃 base64 膨胀）', async () => {
    const payload = { app: 'hms', weights: [{ date: '2026-03-01', weightKg: 70 }], meals: [], exercises: [], waters: [] };
    const codec = zlibCompressor();
    const rawBytes = bodyBytesOf(payload, '', 0);
    const envelope = sync.compressedPayloadOf(await codec.compressToBase64(JSON.stringify(payload)));
    const gzipBytes = bodyBytesOf(envelope, '', 0);
    ok(gzipBytes > rawBytes, '前置: 这份小载荷的压缩包装确实更大（' + gzipBytes + ' > ' + rawBytes + '）');
    const encoded = await sync.encodePayloadForUpload({ payload, token: '', baseRev: 0, compressor: codec, compressMinBytes: 1 });
    eq(encoded.mode, 'raw', '压缩更大时必须原样上传');
    eq(encoded.compressed, false);
    ok(encoded.gzipBytes > encoded.rawBytes, '诊断字段也要说清压缩不划算');
    deep(encoded.payload, payload, '不压缩时必须原样交出载荷');
    eq(encoded.bytes, rawBytes);
    eq(encoded.overLimit, false);
  });

  await checkAsync('sync/压缩: 默认阈值以下的小载荷原样上传（老客户端也读得懂）', async () => {
    const encoded = await sync.encodePayloadForUpload({ payload: SNAP_PAYLOAD, token: 'tok', baseRev: 0, compressor: zlibCompressor() });
    eq(encoded.mode, 'raw');
    eq(encoded.compressed, false);
    ok(encoded.rawBytes < sync.PUSH_COMPRESS_MIN_BYTES, '前置: 小载荷要在压缩阈值以下');
    deep(encoded.payload, SNAP_PAYLOAD);
    eq(encoded.bytes, bodyBytesOf(SNAP_PAYLOAD, 'tok', 0));
    eq(encoded.body, sync.pushBodyText({ token: 'tok', baseRev: 0, payload: SNAP_PAYLOAD }));
  });

  // ----- 超限拦截（编码层） -----

  await checkAsync('sync/压缩: 压缩后仍超限 → ok:false + 中文原因，且不交出载荷', async () => {
    const huge = { app: 'hms', meta: { bulk: randomText(260 * 1024) }, weights: [], meals: [], exercises: [], waters: [] };
    const encoded = await sync.encodePayloadForUpload({ payload: huge, token: 'tok', baseRev: 2, compressor: zlibCompressor() });
    eq(encoded.ok, false);
    eq(encoded.error, 'payload-too-large');
    eq(encoded.overLimit, true);
    ok(encoded.bytes > encoded.limitBytes, '压完还是超限: ' + encoded.bytes);
    ok(encoded.gzipBytes > encoded.limitBytes, '前置: 这份数据压不动（压缩后 ' + encoded.gzipBytes + ' 仍超限）');
    eq(encoded.payload, null, '超限时不该交出任何载荷');
    eq(encoded.body, '', '超限时不该交出请求体');
    ok(encoded.message.includes('上限'), '必须有明确中文原因: ' + encoded.message);
    ok(/[\u4e00-\u9fa5]/.test(encoded.message), '提示必须是中文: ' + encoded.message);
    eq(encoded.message.includes('本机数据一个字节都没动'), true, '要让用户知道数据没丢');
  });

  await checkAsync('sync/压缩: 非对象 / 无法序列化的载荷 → ok:false + 中文（不静默丢数据）', async () => {
    for (const payload of [null, undefined, 'x', 7, [], [{ a: 1 }]]) {
      const encoded = await sync.encodePayloadForUpload({ payload, token: 't', baseRev: 0, compressor: zlibCompressor() });
      eq(encoded.ok, false, '非对象载荷必须拒绝: ' + JSON.stringify(payload));
      eq(encoded.error, 'bad-payload');
      eq(encoded.overLimit, false, '这不是超限，是载荷本身不合法');
      ok(/[\u4e00-\u9fa5]/.test(encoded.message), '中文原因: ' + encoded.message);
    }
    const circular = { app: 'hms', meta: {} };
    circular.meta.self = circular;
    const encoded = await sync.encodePayloadForUpload({ payload: circular, token: 't', baseRev: 0, compressor: zlibCompressor() });
    eq(encoded.ok, false);
    eq(encoded.error, 'bad-payload');
    ok(encoded.message.includes('无法序列化'), '要说清是序列化不了: ' + encoded.message);
  });

  await checkAsync('sync/压缩: 压缩不可用（注入 null / 全局缺失）时回退原样上传，同步照常成功', async () => {
    const payload = userShapedPayload(30);
    const injected = await sync.encodePayloadForUpload({ payload, token: 't', baseRev: 0, compressor: null });
    eq(injected.ok, true);
    eq(injected.mode, 'raw');
    deep(injected.payload, payload);
    eq(injected.gzipBytes, 0, '压不动时不该有压缩大小');

    const localDump = { app: 'hms', meta: {}, weights: [{ date: '2026-03-01', weightKg: 70 }], meals: [], exercises: [], waters: [] };
    await withoutGlobal('CompressionStream', async () => {
      eq(sync.createStreamCompressor(), null, '没有 CompressionStream 必须返回 null');
      const encoded = await sync.encodePayloadForUpload({ payload, token: 't', baseRev: 0 });
      eq(encoded.mode, 'raw', '老 WebView 必须回退成不压缩');
      eq(encoded.ok, true);
      const storage = fakeSyncStorage(localDump, null);
      const transport = fakePullTransport({ ok: true, rev: 0, savedAt: 0, payload: null });
      const result = await sync.runSyncOnce({ accountId: 'acc', token: 'tok', storage, transport });
      eq(result.ok, true, '没有压缩能力也必须能同步: ' + result.message);
      eq(transport.pushes.length, 1);
      eq(Array.isArray(transport.pushes[0].payload.weights), true, '回退时上传的是原样 JSON');
    });
    eq(typeof globalThis.CompressionStream, 'function', '跑完必须把全局装回去');
  });

  await checkAsync('sync/压缩: 环境不支持解压时给出明确中文，而不是写坏本机数据', async () => {
    await withoutGlobal('DecompressionStream', async () => {
      const decoded = await sync.decodePayloadFromCloud({ __gz: 'AAAA' });
      eq(decoded.ok, false);
      eq(decoded.error, 'no-decompressor');
      eq(decoded.payload, undefined, '解不出来就绝不交出载荷');
      ok(decoded.message.includes('不支持解压'), '要说清是环境不支持: ' + decoded.message);
      const localDump = { app: 'hms', meta: {}, weights: [{ date: '2026-03-01', weightKg: 70 }], meals: [], exercises: [], waters: [] };
      const storage = fakeSyncStorage(localDump, { rev: 1, checksum: sync.syncDigestOf(localDump).checksum });
      const transport = fakePullTransport({ ok: true, rev: 5, savedAt: 1, payload: { __gz: 'AAAA' } });
      const result = await sync.runSyncOnce({ accountId: 'acc', token: 'tok', storage, transport });
      eq(result.ok, false);
      eq(storage.log.loadAll.length, 0, '本机数据必须原样保留');
      eq(storage.log.setSyncState.length, 0, '也不该写锚点');
      ok(result.message.includes('本机数据没有被改动'), '要让用户放心: ' + result.message);
    });
  });

  // ----- 解码失败 / 向后兼容 -----

  await checkAsync('sync/压缩: 老格式（无 __gz）解码原样返回，runSyncOnce 照旧拉取', async () => {
    const decoded = await sync.decodePayloadFromCloud(SNAP_PAYLOAD, { compressor: zlibCompressor() });
    eq(decoded.ok, true);
    eq(decoded.compressed, false);
    ok(decoded.payload === SNAP_PAYLOAD, '没标记就该原样返回同一个对象，不拷贝也不改造');
    const localDump = { app: 'hms', meta: {}, weights: [{ date: '2026-01-01', weightKg: 71 }], meals: [], exercises: [], waters: [] };
    const storage = fakeSyncStorage(localDump, { rev: 1, checksum: sync.syncDigestOf(localDump).checksum });
    const transport = fakePullTransport({ ok: true, rev: 2, savedAt: 1700000000000, payload: SNAP_PAYLOAD });
    const result = await sync.runSyncOnce({ accountId: 'acc', token: 'tok', storage, transport, compressor: zlibCompressor() });
    eq(result.ok, true, result.message);
    eq(result.action, 'pull');
    deep(storage.log.loadAll[0].payload.weights, SNAP_PAYLOAD.weights, '老快照的数据必须完整落到本机');
    eq(transport.pushes.length, 0, '拉取不该顺带再上传');
  });

  await checkAsync('sync/压缩: 坏 base64 / 非 gzip 数据 / 解出来不是对象 → 全部 ok:false + 中文', async () => {
    const codec = zlibCompressor();
    for (const payload of [{ __gz: '!!!这不是 base64!!!' }, { __gz: Buffer.from('这压根不是 gzip 数据').toString('base64') }]) {
      const decoded = await sync.decodePayloadFromCloud(payload, { compressor: codec });
      eq(decoded.ok, false, '必须报错而不是当数据读: ' + JSON.stringify(payload).slice(0, 40));
      eq(decoded.compressed, true);
      eq(decoded.payload, undefined, '失败时绝不交出载荷');
      ok(decoded.message.includes('解压失败'), '要明确说解压失败: ' + decoded.message);
    }
    const notObject = sync.compressedPayloadOf(await codec.compressToBase64('[1,2,3]'));
    const arrayDecoded = await sync.decodePayloadFromCloud(notObject, { compressor: codec });
    eq(arrayDecoded.ok, false);
    ok(arrayDecoded.message.includes('快照对象'), '要说清不是快照对象: ' + arrayDecoded.message);
    const badJson = sync.compressedPayloadOf(await codec.compressToBase64('{不是 JSON'));
    const badJsonDecoded = await sync.decodePayloadFromCloud(badJson, { compressor: codec });
    eq(badJsonDecoded.ok, false);
    ok(badJsonDecoded.message.includes('合法 JSON'), '要说清 JSON 坏了: ' + badJsonDecoded.message);
  });

  // ----- 量出来的大小 = 发出去的大小 -----

  await checkAsync('sync/压缩: 量出来的请求体与 cloud-api 真正发出的 body 逐字节一致', async () => {
    const payload = userShapedPayload(75); // 13KB 量级：默认策略下会走压缩分支
    const sent = [];
    const client = cloudApi.createCloudApi({
      baseUrl: 'https://cloud.test/api',
      fetchImpl: async (url, options) => {
        sent.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ rev: 7 }) };
      },
    });
    await client.push('tok-中文', 3, payload);
    eq(sent.length, 1);
    eq(sent[0].url, 'https://cloud.test/api/push');
    eq(sent[0].options.body, sync.pushBodyText({ token: 'tok-中文', baseRev: 3, payload }), '两边序列化必须一模一样');
    eq(sync.utf8Bytes(sent[0].options.body), bodyBytesOf(payload, 'tok-中文', 3));

    const encoded = await sync.encodePayloadForUpload({ payload, token: 'tok-中文', baseRev: 3, compressor: zlibCompressor() });
    eq(encoded.mode, 'gzip');
    await client.push('tok-中文', 3, encoded.payload);
    eq(sent[1].options.body, encoded.body, '压缩包的请求体也要逐字节一致');
    eq(sync.utf8Bytes(sent[1].options.body), encoded.bytes, '真正发出去的字节数必须等于量出来的 bytes');
  });

  // ----- runSyncOnce / 传输层：一次请求都不许发 -----

  await checkAsync('runSyncOnce: 超限载荷 → 一次 push 都没发、锚点没写、中文原因（本机数据未变）', async () => {
    const dump = {
      app: 'hms',
      meta: { bulk: randomText(260 * 1024) },
      weights: [{ date: '2026-03-01', weightKg: 70 }],
      meals: [],
      exercises: [],
      waters: [],
    };
    const storage = fakeSyncStorage(dump, null);
    const transport = fakePullTransport({ ok: true, rev: 0, savedAt: 0, payload: null });
    const result = await sync.runSyncOnce({ accountId: 'acc', transport, token: 'tok', storage, compressor: zlibCompressor() });
    eq(result.ok, false);
    eq(result.action, 'push');
    eq(result.error, 'payload-too-large');
    eq(transport.pushes.length, 0, '超限时绝不许发出上传请求');
    eq(storage.log.setSyncState.length, 0, '超限时不该写同步锚点');
    eq(storage.log.loadAll.length, 0);
    eq(storage.log.setMeta.length, 0);
    ok(result.message.includes('上限'), '必须有可读中文原因: ' + result.message);
    ok(/[\u4e00-\u9fa5]/.test(result.message), '提示必须是中文: ' + result.message);
    deep(dump.weights, [{ date: '2026-03-01', weightKg: 70 }], '本机数据必须原封不动');
  });

  await checkAsync('runSyncOnce: 接真实传输层时超限同样发不出请求（只发了 pull）', async () => {
    const calls = [];
    const transport = cloudTransport.createCloudTransport({
      baseUrl: 'https://cloud.test/api',
      fetchImpl: async (url, options) => {
        calls.push({ url, body: options.body });
        return { ok: true, status: 200, json: async () => ({ rev: 0, savedAt: 0, payload: null }) };
      },
    });
    const storage = fakeSyncStorage({ app: 'hms', meta: { bulk: randomText(260 * 1024) }, weights: [], meals: [], exercises: [], waters: [] }, null);
    const result = await sync.runSyncOnce({ accountId: 'acc', transport, token: 'tok', storage });
    eq(calls.length, 1, '只该有一次请求（pull），超限的 push 必须被拦下: ' + JSON.stringify(calls.map((c) => c.url)));
    eq(calls[0].url, 'https://cloud.test/api/pull');
    eq(result.ok, false);
    eq(result.error, 'payload-too-large');
    ok(result.message.includes('上限'), '中文原因: ' + result.message);
  });

  await checkAsync('传输层: push 收到超限载荷 → 中文失败且零请求；小载荷不受影响', async () => {
    const calls = [];
    const transport = cloudTransport.createCloudTransport({
      baseUrl: 'https://cloud.test/api',
      fetchImpl: async (url, options) => {
        calls.push({ url, body: options.body });
        return { ok: true, status: 200, json: async () => ({ rev: 4 }) };
      },
    });
    const huge = { app: 'hms', meta: { bulk: randomText(200 * 1024) }, weights: [] };
    const blocked = await transport.push({ token: 'tok', baseRev: 1, payload: huge });
    eq(blocked.ok, false);
    eq(blocked.error, 'payload-too-large');
    eq(calls.length, 0, '超限时一个请求都不许发');
    ok(blocked.message.includes('上限'), '网络边界的说明也要是可读中文: ' + blocked.message);
    const small = await transport.push({ token: 'tok', baseRev: 1, payload: SNAP_PAYLOAD });
    eq(small.ok, true);
    eq(calls.length, 1);
    eq(calls[0].url, 'https://cloud.test/api/push');
    deep(JSON.parse(calls[0].body).payload, SNAP_PAYLOAD, '小载荷必须原样发出，不许误伤');
  });

  await checkAsync('runSyncOnce: 云端 { __gz } 压缩快照 → 解压后按普通快照落库', async () => {
    const remotePayload = userShapedPayload(20);
    const codec = zlibCompressor();
    const envelope = sync.compressedPayloadOf(await codec.compressToBase64(JSON.stringify(remotePayload)));
    const localDump = { app: 'hms', meta: {}, weights: [], meals: [], exercises: [], waters: [] };
    const storage = fakeSyncStorage(localDump, null);
    const transport = fakePullTransport({ ok: true, rev: 4, savedAt: 1700000000000, payload: envelope });
    const result = await sync.runSyncOnce({ accountId: 'acc', token: 'tok', storage, transport, compressor: codec });
    eq(result.ok, true, result.message);
    eq(result.action, 'pull');
    eq(result.rev, 4);
    eq(storage.log.loadAll.length, 1);
    eq(storage.log.loadAll[0].mode, 'replace');
    deep(storage.log.loadAll[0].payload.weights, remotePayload.weights, '落库的必须是解压后的数据');
    eq(storage.log.loadAll[0].payload.meals.length, remotePayload.meals.length);
    eq(storage.log.loadAll[0].payload.meals[0].items[0].name.includes('米饭'), true, '中文内容必须完好');
    eq(storage.log.setSyncState[0].rev, 4);
  });

  await checkAsync('runSyncOnce: 云端压缩快照解不开 → 明确中文、不落库、不写锚点（本机数据保留）', async () => {
    const localDump = { app: 'hms', meta: {}, weights: [{ date: '2026-03-01', weightKg: 70 }], meals: [], exercises: [], waters: [] };
    const storage = fakeSyncStorage(localDump, { rev: 1, checksum: sync.syncDigestOf(localDump).checksum });
    const transport = fakePullTransport({ ok: true, rev: 5, savedAt: 1, payload: { __gz: '!!!坏掉的压缩快照!!!' } });
    const result = await sync.runSyncOnce({ accountId: 'acc', token: 'tok', storage, transport, compressor: zlibCompressor() });
    eq(result.ok, false);
    eq(result.action, 'pull');
    eq(storage.log.loadAll.length, 0, '解不开就不许覆盖本机数据');
    eq(storage.log.setSyncState.length, 0, '不许写锚点（写了下次就以为同步过了）');
    eq(storage.log.setMeta.length, 0, '什么都没发生，也不该留冲突副本');
    ok(result.message.includes('本机数据没有被改动'), '要让用户知道数据没丢: ' + result.message);
    eq(result.rev, 1, 'rev 必须停在本机原值');
  });

  await checkAsync('sync/压缩: 两台设备经真实传输层往返（A 压缩上传 → B 拉取还原，载荷等价）', async () => {
    // 假网关：按协议原样存 / 取 payload，不做任何加工（真网关也一样 —— payload 对它是不透明 JSON）
    let stored = null;
    let storedRev = 0;
    let pushBytes = 0;
    const gateway = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/push')) {
        if (body.baseRev !== storedRev) {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'rev-conflict', rev: storedRev }) };
        }
        pushBytes = sync.utf8Bytes(options.body);
        storedRev += 1;
        stored = body.payload;
        return { ok: true, status: 200, text: async () => JSON.stringify({ rev: storedRev }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ rev: storedRev, savedAt: 1772000000000, payload: stored }) };
    };
    const makeTransport = () => cloudTransport.createCloudTransport({ baseUrl: 'https://cloud.test/api', fetchImpl: gateway });

    const dumpA = userShapedPayload(75); // 用户当前规模：13KB 量级
    const storageA = fakeSyncStorage(dumpA, null);
    const deviceA = await sync.runSyncOnce({ accountId: 'acc', transport: makeTransport(), token: 'tok', storage: storageA });
    eq(deviceA.ok, true, 'A 上传必须成功: ' + deviceA.message);
    eq(deviceA.action, 'push');
    eq(sync.isCompressedPayload(stored), true, '云端的载荷应该是 { __gz } 压缩体');
    ok(pushBytes > 0 && pushBytes < sync.PUSH_BODY_LIMIT_BYTES, '上传请求体 ' + pushBytes + ' 字节必须在阈值内');
    const rawBytes = bodyBytesOf(dumpA, 'tok', 0);
    ok(pushBytes < rawBytes * 0.4, '压缩后 ' + pushBytes + ' 字节应远小于原样 ' + rawBytes + ' 字节');

    // B 设备：空库 + 从没同步过 → 直接拉，落库的数据必须等于 A 想备份的那份
    const storageB = fakeSyncStorage({ app: 'hms', meta: {}, weights: [], meals: [], exercises: [], waters: [] }, null);
    const deviceB = await sync.runSyncOnce({ accountId: 'acc', transport: makeTransport(), token: 'tok', storage: storageB });
    eq(deviceB.ok, true, 'B 拉取必须成功: ' + deviceB.message);
    eq(deviceB.action, 'pull');
    eq(storageB.log.loadAll.length, 1);
    deep(storageB.log.loadAll[0].payload, sync.syncDigestOf(dumpA).payload, 'B 上落库的数据必须与 A 要备份的数据等价');
    deep(storageB.log.loadAll[0].payload.meals, dumpA.meals, '中文饮食记录必须逐条一致');
  });
}

// ---------- 回归：tests/fuzz.data.mjs 找出的 8 条数据层 bug（逐条钉住修复后的契约）----------

/** 迷你 RFC4180 解析器：与 fuzz.data.mjs 同口径（BOM / CRLF / "" 反转义），只用于 CSV 往返验证。 */
function parseCsvText(text) {
  const s = text.startsWith('\ufeff') ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else if (ch === '\r' || ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

async function testFuzzDataRegressions() {
  // M2：ID_EMPTY_BECOMES_ZERO
  check('回归 ID_EMPTY_BECOMES_ZERO：空串 / [] / false 不算 id，不落 id 键也不折叠去重键', () => {
    for (const junk of ['', '   ', [], [7], false, true, {}, new Date(0)]) {
      const w = pure.normalizeWeightRecord({ date: '2026-10-01', weightKg: 70, id: junk });
      eq('id' in w, false, 'id=' + String(junk) + ' 不该落 id 键');
      ok(pure.keyOf('meals', { date: '2026-10-01', slot: 'lunch', id: junk }).startsWith('fk:'), 'id=' + String(junk) + ' 应退回内容指纹');
    }
    eq(pure.normalizeMealRecord({ date: '2026-10-01', slot: 'lunch', items: [], id: 7 }).id, 7, '数值 id 必须保留');
    eq(pure.normalizeMealRecord({ date: '2026-10-01', slot: 'lunch', items: [], id: '7' }).id, 7, '数字串 id 归一成数值');
    eq(pure.normalizeMealRecord({ date: '2026-10-01', slot: 'lunch', items: [], id: null }).id, undefined, 'null 不算 id');

    const plan = pure.planImport('meals', [], [
      { id: '', date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] },
      { id: '', date: '2026-05-01', slot: 'dinner', items: [{ name: '面条', grams: 300, kcal: 330 }] },
    ]);
    eq(plan.length, 2, '两条空 id 的不同记录不该被折叠成一条');
    deep(plan.map((r) => r.items[0].name), ['米饭', '面条']);

    const ex = pure.planImport('exercises', [], [
      { id: [], date: '2026-05-01', type: '跑步', minutes: 30, kcalBurned: 300 },
      { id: [], date: '2026-05-01', type: '游泳', minutes: 40, kcalBurned: 400 },
    ]);
    eq(ex.length, 2, 'exercises 的空数组 id 也不该折叠');
  });

  // L3：MEAL_REIMPORT_DOUBLES
  check('回归 MEAL_REIMPORT_DOUBLES：缺 createdAt 的餐次重复导入不翻倍（指纹不含现生成的 createdAt）', () => {
    const realNow = Date.now;
    let t = 1700000000000;
    Date.now = () => t;
    try {
      const raw = { date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] };
      const first = pure.planImport('meals', [], [raw]);
      eq(first.length, 1, '首次导入应落一行');
      t += 60000;
      const second = pure.planImport('meals', first, [raw]);
      eq(second.length, 0, '第二次导入同一份 JSON 不该新增行');
      t += 60000;
      eq(pure.planImport('meals', first.concat(second), [raw]).length, 0, '第三次导入不该新增行');
    } finally {
      Date.now = realNow;
    }
    const lunch = { date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] };
    eq(
      pure.keyOf('meals', lunch),
      pure.keyOf('meals', { ...lunch, createdAt: 999 }),
      '指纹不该随 createdAt 变化（与 exercises 的内容指纹口径一致）',
    );
    ok(pure.keyOf('meals', lunch) !== pure.keyOf('meals', { ...lunch, slot: 'dinner' }), '餐次不同必须指纹不同');
    ok(
      pure.keyOf('meals', lunch) !== pure.keyOf('meals', { ...lunch, items: [{ name: '面条', grams: 300, kcal: 330 }] }),
      '内容不同必须指纹不同',
    );
    ok(pure.keyOf('meals', lunch).startsWith('fk:2026-05-01:lunch:'), '指纹应保留 date/slot 前缀可读性');
  });

  // M1：CSV_FORMULA_INJECTION
  check('回归 CSV_FORMULA_INJECTION：= + - @ 开头的单元格被中和，CSV 仍可逐格还原', () => {
    const csv = pure.buildCSV({
      weights: [{ date: '2026-10-01', weightKg: 70, note: '=1+1' }],
      meals: [{
        date: '2026-10-01',
        slot: 'lunch',
        source: 'manual',
        createdAt: 1,
        items: [{ name: "=cmd|' /C calc'!A0", grams: 100, kcal: 1 }, { name: '=a,b', grams: 50, kcal: 1 }],
      }],
      exercises: [
        { date: '2026-10-01', type: '+1+1', minutes: 30, kcalBurned: 1, createdAt: 1 },
        { date: '2026-10-01', type: '@SUM(A1:A2)', minutes: 1, kcalBurned: 1, createdAt: 2 },
        { date: '2026-10-01', type: '-1+1', minutes: 1, kcalBurned: 1, createdAt: 3 },
      ],
      waters: [{ date: '2026-10-01', ml: 500 }],
    });
    const rows = parseCsvText(csv);
    for (const row of rows) for (const cell of row) eq(/^[=+\-@]/.test(cell), false, '公式前缀单元格未中和: ' + cell);
    const cells = rows.flat();
    ok(cells.includes("'=1+1"), '备注应被中和成前置单引号');
    ok(cells.includes("'=cmd|' /C calc'!A0"), '条目名应被中和');
    ok(cells.includes("'=a,b"), '同时含逗号的公式单元格：中和 + RFC4180 引号包裹后仍应逐格还原');
    ok(cells.includes("'+1+1") && cells.includes("'@SUM(A1:A2)") && cells.includes("'-1+1"), '四种触发字符都要中和');
    eq(rows[rows.findIndex((r) => r[0] === '# 运动') + 1].length, 6, '中和不该改变列数');
    ok(pure.buildCSV({ weights: [{ date: '2026-10-01', weightKg: -5 }] }).includes('2026-10-01,-5,'), '纯数字（-5）保持数字语义，不加前缀');
  });

  // L1：NUMERIC_OVERFLOW_INFINITY
  check('回归 NUMERIC_OVERFLOW_INFINITY：有限大数溢出后归 0，不吐 ±Infinity', () => {
    eq(nutrition.round1(1e308), 0);
    eq(nutrition.round1(-1e308), 0);
    eq(nutrition.round1(Number.MAX_VALUE), 0, 'MAX_VALUE 乘 10 溢出后必须归 0');
    const huge = { kcal: 1e308, carb: 1e308, protein: 1e308, fat: 1e308, fiber: 1e308, sodium: 1e308 };
    deep(nutrition.sumItems([huge, huge]), { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 }, '累加溢出必须归 0');
    ok(Number.isFinite(nutrition.sumItems([huge]).kcal), '没有溢出的有限和要原样保留，不许一刀切归零');
    deep(
      nutrition.scaleFood({ kcal: 1e308, carb: 1e308, protein: 1e308, fat: 1e308, fiber: 1e308, sodium: 1e308 }, 1e308),
      { kcal: 0, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 },
    );
    eq(nutrition.kcalFromMacros({ carb: 1e308, protein: 1e308, fat: 1e308 }), 0);
    eq(nutrition.netKcal(1e308, -1e308), 0);
    eq(nutrition.estimateBurn({ type: 'jog', minutes: 1e15, weightKg: 1e308 }), 0);
    eq(nutrition.movingAverage([{ date: 'd1', value: 1e308 }, { date: 'd2', value: 1e308 }], 7)[1].avg, 0);
    const item = pure.normalizeMealItem({ name: '米饭', grams: 1e308, kcal: 1e308, carb: 1e308, protein: 1e308, fat: 1e308, fiber: 1e308, sodium: 1e308 });
    // kcal 走 int(Math.round) 不会溢出，1e308 原样保留；其余走 round1（×10 溢出）→ 0。全都必须是有限数。
    deep(item, { name: '米饭', grams: 0, kcal: 1e308, carb: 0, protein: 0, fat: 0, fiber: 0, sodium: 0 });
    ok(Object.values(item).every((v) => typeof v === 'string' || Number.isFinite(v)), '整形结果不许出现 ±Infinity');
    deep(pure.normalizeMealItem(item), item, '溢出输入上 normalizeMealItem 必须幂等');
    eq(pure.buildDaySummary({ date: '2026-10-01', meals: [{ date: '2026-10-01', items: [{ carb: 1e308, kcal: 1e308 }] }] }).intake.carb, 0);
  });

  // L2：DATE_SHAPE_ONLY
  check('回归 DATE_SHAPE_ONLY：日历非法日期与 parseDateStr 口径一致，不落库也不进区间图', () => {
    eq(pure.normalizeWeightRecord({ date: '2026-02-31', weightKg: 70 }), null);
    eq(pure.normalizeMealRecord({ date: '2026-13-01', slot: 'lunch', items: [] }), null);
    eq(pure.normalizeWaterRecord({ date: '2026-02-30', ml: 500 }), null);
    eq(pure.normalizeExerciseRecord({ date: '2026-04-31', type: '慢跑', minutes: 30 }), null);
    ok(pure.normalizeWeightRecord({ date: '2024-02-29', weightKg: 70 }), '闰年 2-29 仍应合法');
    eq(pure.normalizeWeightRecord({ date: '2026-02-29', weightKg: 70 }), null, '平年 2-29 应非法');
    const w = pure.normalizeWeightRecord({ date: '2026-02-31', weightKg: 70 });
    deep(pure.buildRangeRows({ fromDate: '2026-02-01', toDate: '2026-03-31', weights: w ? [w] : [] }), [], '非法日期不该出现在区间图里');
    eq(pure.keyOf('weights', { date: '2026-02-31' }), 'date:2026-02-31', 'weights 仍按日期键（与 normalize 的合法性判定无关）');
  });

  // M3：MERGE_DROPS_LOCAL_SETTINGS
  check('回归 MERGE_DROPS_LOCAL_SETTINGS：远端设置只剩密钥时等于没表态，本机设置整份沿用', () => {
    const local = {
      settings: { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', weightUnit: 'jin' },
      meta: { settings: { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', weightUnit: 'jin' } },
    };
    const remote = { settings: { apiKey: '云端那份' }, meta: { settings: { apiKey: '云端那份' } } };
    const out = pure.mergeRemoteIntoLocal({ remote, local });
    deep(out.settings, { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', weightUnit: 'jin' }, '顶层 settings 不该被掏空');
    deep(out.meta.settings, { apiKey: FAKE_API_KEY, model: 'qwen3-vl-plus', weightUnit: 'jin' }, 'meta.settings 同上');
    deep(pure.mergeRemoteIntoLocal({ remote: { settings: { apiKey: '云端那份' } } }), { settings: {} }, '本机没有密钥时远端密钥仍必须被剥掉');
    const mixed = pure.mergeRemoteIntoLocal({ remote: { settings: { apiKey: '云端那份', model: '远端模型' } }, local });
    eq(mixed.settings.model, '远端模型', '剥完还有非密钥键 → 仍以远端为准');
    eq(mixed.settings.apiKey, FAKE_API_KEY, '密钥只认本机');
    eq(mixed.settings.weightUnit, undefined, '远端没表态的非密钥键不该由本机补上');
    deep(remote, { settings: { apiKey: '云端那份' }, meta: { settings: { apiKey: '云端那份' } } }, '入参不得被改动');
  });

  // L5：DEBOUNCER_FLUSH_WAITEDMS
  check('回归 DEBOUNCER_FLUSH_WAITEDMS：flush 的 waitedMs 恒为 0，定时器到点仍报真实时长', () => {
    const clock = fakeClock();
    const fired = [];
    const d = sync.createDebouncer({ delayMs: 5000, onFire: (r, w) => fired.push([r, w]), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    d.schedule('手动同步');
    clock.advance(3000);
    d.flush();
    deep(fired, [['手动同步', 0]], 'flush 立即触发时 waitedMs 必须是 0');

    const clock2 = fakeClock();
    const fired2 = [];
    const d2 = sync.createDebouncer({ delayMs: 5000, onFire: (r, w) => fired2.push([r, w]), now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer });
    d2.schedule('到点');
    clock2.advance(5000);
    deep(fired2, [['到点', 5000]], '定时器自然到点必须报告真实等待时长');
  });

  // L4：MERGEDISH_NAMELESS_ITEM
  await checkAsync('回归 MERGEDISH_NAMELESS_ITEM：缺 name 的食物合并后 name 兜底为空串', async () => {
    const foodView = await import('../views/food.js');
    const item = foodView.mergeToDish([{ name: '鸡蛋' }], { id: 'x', per100g: { kcal: 100, carb: 1, protein: 1, fat: 1 } }, 100)[0];
    eq(item.name, '', '缺 name 必须是空串，不是 undefined');
    eq('name' in item, true);
    deep(Object.keys(item).sort(), ['carb', 'fat', 'foodId', 'grams', 'kcal', 'name', 'protein']);
    for (const key of ['grams', 'kcal', 'carb', 'protein', 'fat', 'foodId']) ok(item[key] !== undefined, '合并条目不该带 undefined 值: ' + key);
  });
}

export async function run() {
  testDates();
  await testFuzzDataRegressions();
  testMetabolism();
  testBmiBoundaries();
  testExerciseBurn();
  testFoodMath();
  testSeries();
  testMovingAverage();
  testWeightUnits();
  testNormalize();
  testExerciseRecordShape();
  testMealTemplatePure();
  testDayTemplateMessage();
  testRecentFoodItemsPure();
  testAggregate();
  testRoundTrip();
  testPurity();
  testSyncPure();
  testSyncSecrets();
  await testSyncCompression();
  await testModules();
  // 放最后：它会临时注入假 indexedDB 并清理，不干扰上面的「IDB 不可用」断言
  await testStoreSettings();
  // 同样注入假 indexedDB；每段都在 finally 里清掉 db.js 单例
  await testStoreMealTemplates();
  await testStoreExerciseLog();
  await testStoreExportStatus();
  await testSyncStore();
  // 写入通知 / 静默窗口 + 导入恢复范围：同样用最小假 IDB，跑完清单例
  await testMutationHooks();
  // 账号用例放最后：注入持久化假 IDB + 假 localStorage，每段都在 finally 里把单例与全局还原
  await testAccountsContract();
  await testAccountsCatalog();
  await testAccountsDirtyStorage();
  await testAccountsIsolation();
  await testAccountsRemoval();

  const result = { passed, failed: failures.length, failures };
  console.log(`[logic.test] passed=${result.passed} failed=${result.failed}`);
  if (!IDB_ABSENT) console.log('[logic.test] 已注入 indexedDB：跳过 5 项「IDB 不可用」断言');
  for (const f of result.failures) console.log(`  FAIL ${f.name}: ${f.error}`);
  return result;
}

const isMain = (() => {
  try {
    const entry = process?.argv?.[1];
    return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = await run();
  if (result.failed > 0) process.exitCode = 1;
}
