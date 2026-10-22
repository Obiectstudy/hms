/**
 * logic-core 的可自动验证部分。
 *
 * 运行方式（本机只能用 run_code，pwsh/node 子进程不可用）：
 *   const m = await import('file:///C:/Users/Administrator/Desktop/hms/tests/logic.test.mjs');
 *   await m.run();   // -> { passed, failed, failures }
 * 直接执行本文件（node tests/logic.test.mjs）也会自己跑一遍。
 *
 * 覆盖面：nutrition.js 全部导出 + 边界（含 kg/斤 换算、移动平均）、pure.js 的整形/去重/聚合/CSV/
 * 套餐模板/最近吃过/导出天数，以及「导出→清空→导入」的纯逻辑往返一致性。
 * IndexedDB 路径：Node 没有 indexedDB，默认只能断言「不可用时抛中文错误」；
 * 唯一例外是 store 的 settings / 套餐 / 导出状态，用文件末尾的最小假 IDB 真跑一遍后立即清理。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as nutrition from '../js/nutrition.js';
import * as pure from '../js/pure.js';
import * as db from '../js/db.js';
import * as store from '../js/store.js';

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
    eq(pure.keyOf('meals', { date: '2026-10-01', slot: 'lunch', createdAt: 9 }), 'fk:2026-10-01:lunch:9');
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
];
const STORE_EXPORTS = [
  'getProfile', 'saveProfile', 'getGoals', 'saveGoals', 'computeDefaultGoals', 'getSettings', 'saveSettings',
  'logWeight', 'deleteWeight', 'logMeal', 'updateMeal', 'deleteMeal', 'logExercise', 'deleteExercise',
  'getWater', 'setWater', 'addWater', 'savePhoto', 'getPhoto', 'daySummary', 'rangeSummary',
  'recentWeights', 'exportJSON', 'importJSON', 'exportCSV', 'clearAllData',
  'getMealTemplates', 'saveMealTemplate', 'saveDayTemplate', 'deleteMealTemplate',
  'recentFoodItems', 'markExported', 'exportStatus',
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
function createFakeIndexedDb() {
  const databases = [];
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
    close() {}
  }

  const indexedDB = {
    open(name, version) {
      const database = new FakeDb(name, version);
      databases.push(database);
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
  };

  return { indexedDB, databases };
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

// ---------- 入口 ----------

export async function run() {
  testDates();
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
  await testModules();
  // 放最后：它会临时注入假 indexedDB 并清理，不干扰上面的「IDB 不可用」断言
  await testStoreSettings();
  // 同样注入假 indexedDB；每段都在 finally 里清掉 db.js 单例
  await testStoreMealTemplates();
  await testStoreExerciseLog();
  await testStoreExportStatus();

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
