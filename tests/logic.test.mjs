/**
 * logic-core 的可自动验证部分。
 *
 * 运行方式（本机只能用 run_code，pwsh/node 子进程不可用）：
 *   const m = await import('file:///C:/Users/Administrator/Desktop/hms/tests/logic.test.mjs');
 *   await m.run();   // -> { passed, failed, failures }
 * 直接执行本文件（node tests/logic.test.mjs）也会自己跑一遍。
 *
 * 覆盖面：nutrition.js 全部导出 + 边界、pure.js 的整形/去重/聚合/CSV、
 * 以及「导出→清空→导入」的纯逻辑往返一致性。
 * IndexedDB 路径（db.js/store.js 的异步读写）Node 里没有 indexedDB，只能靠 import 后
 * 断言「不可用时抛中文错误」+ 浏览器 #/debug 页人工确认，见回报里的已知风险。
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

// ---------- 入口 ----------

export async function run() {
  testDates();
  testMetabolism();
  testFoodMath();
  testSeries();
  testNormalize();
  testAggregate();
  testRoundTrip();
  testPurity();
  await testModules();

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
