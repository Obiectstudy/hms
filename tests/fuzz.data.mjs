/**
 * 数据层对抗性模糊测试（adversarial fuzz；本轮「只找不改」）。
 *
 * 运行方式：
 *   node -e "import('./tests/fuzz.data.mjs').then(m=>m.run()).then(r=>console.log(r.passed, r.failed, JSON.stringify(r.findings,null,1)))"
 *   node tests/fuzz.data.mjs      # 自带人读 report
 *
 * 设计原则：
 * - 固定种子 LCG（SEED 常量）：随机部分完全可复现，不依赖 Math.random / 当前时间（唯一例外见 MEAL_REIMPORT 探针，它临时桩住 Date.now 且用完还原）。
 * - 边界值表（0 / -0 / NaN / ±Infinity / 1e308 / 空串 / null / undefined / [] / {} / emoji / 公式前缀 / 超长串）
 *   与固定种子伪随机生成器双管齐下。
 * - 每个 sweep 把 N 组输入压成 1 条 check（违规样例进错误信息，不刷屏）；单个 bug 用 bug() 探针单列一条。
 * - 契约判据取自函数自身的文档注释 / SPEC，不是测试口味：不抛异常、数值必须有限、结构字段类型稳定、
 *   字符串里不出现 undefined / null / [object Object]、幂等与往返性质、密钥不出网、本机记录不被静默丢弃。
 * - bug() 的探针与断言同源：只有「实测 ≠ 期望」才登记 finding，所以每条 finding 都带真实实测值。
 *
 * 失败项（failures）= 本轮找出的 bug，每条对应 findings 里同 id 的一条；不是测试写错。
 * 未覆盖区域见文件末尾注释。
 */

import assert from 'node:assert/strict';

import * as nutrition from '../js/nutrition.js';
import * as pure from '../js/pure.js';
import * as foods from '../js/foods.js';
import * as sync from '../js/sync.js';
import * as accounts from '../js/accounts.js';
import * as foodView from '../views/food.js'; // mergeToDish 实测住在 views/food.js:317，不在 js/foods.js

/* ============================================================
 * 0. 工具：固定种子 LCG / 输入池 / 断言壳
 * 约定：本文件零反斜杠转义（用 charCode 常量拼控制字符），排版不受转义影响。
 * ============================================================ */

const SEED = 20261019;

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xD800);
const ZWSP = String.fromCharCode(0x200B);
const RLO = String.fromCharCode(0x202E);
const BOM = String.fromCharCode(0xFEFF);
const BS = String.fromCharCode(92);

function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const D0 = new Date(0);
const D_BAD = new Date(NaN);

const NUM_POOL = [
  0, -0, 1, -1, 0.5, -0.5, 0.1, 0.2, 0.25, 1e-7, 1e15, 1e308, -1e308, Infinity, -Infinity, NaN,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.EPSILON, 2147483647, 4294967296,
  18.4, 18.5, 24, 27.9, 28, 100, 150, 170, 175.5, 2000, 2001, 20000, 0.04, 0.05, -2000,
];

const STR_POOL = [
  '', ' ', '   ', TAB, LF, CR + LF, '0', '-0', '1e3', '  42  ', 'NaN', 'Infinity', '-Infinity',
  'undefined', 'null', '[object Object]', '五十', '170cm', '１７０', '70.5',
  '🍚🥗', '🙂'.repeat(50), '中'.repeat(1000), 'a'.repeat(100000), 'a'.repeat(1000000),
  '=1+1', "=cmd|' /C calc'!A0", '+1+1', '-1+1', '@SUM(A1:A2)',
  TAB + '=1+1', '=HYPERLINK("http://x","y")', '"quoted"', 'a,b', 'a"b', 'a' + LF + 'b', 'a' + CR + 'b',
  NUL + 'nul', LONE, ZWSP, RLO + 'abc', 'ｗｉｄｅ', 'NaN' + LF + 'undefined', BS + 'x', ' 等 ',
];

const ANY_POOL = [
  ...NUM_POOL,
  ...STR_POOL.slice(0, 26),
  null, undefined, true, false, [], {}, [1, 2, 3], { a: 1 }, { length: 5, 0: 'x' },
  D0, D_BAD,
];

const DATES = ['2026-05-01', '2026-05-02', '2026-01-31', '2026-02-31', '2025-12-31', '', '2026-13-01',
  '2026-05-01T00:00:00Z', '2026-5-1', '9999-99-99', '2026-05-01 ', ' 2026-05-01'];

const RAND_CHARS = ['a', 'b', 'Z', '0', '9', ' ', TAB, LF, CR, '中', '米', '饭', '🍚', '=',
  '+', '-', '@', '"', "'", ',', ';', BS, '|', NUL, LONE, ZWSP, '（', '）', '/', '%', '.', '️'];

const RAND_KEYS = ['date', 'id', 'name', 'grams', 'kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium',
  'slot', 'items', 'type', 'minutes', 'kcalBurned', 'createdAt', 'ml', 'weightKg', 'bodyFatPct', 'note',
  'source', 'intensity', 'value', 'settings', 'meta', 'apiKey', 'payload', 'rev', 'savedAt', 'accountId', 'v'];

function randInt(rng, n) {
  return Math.floor(rng() * n);
}
function pick(rng, arr) {
  return arr[randInt(rng, arr.length)];
}
function randString(rng, maxLen = 12) {
  let out = '';
  const n = randInt(rng, maxLen + 1);
  for (let i = 0; i < n; i += 1) out += pick(rng, RAND_CHARS);
  return out;
}
function randValue(rng, depth = 0) {
  const r = rng();
  if (depth < 2 && r < 0.16) {
    const n = randInt(rng, 4);
    const arr = [];
    for (let i = 0; i < n; i += 1) arr.push(randValue(rng, depth + 1));
    return arr;
  }
  if (depth < 2 && r < 0.34) {
    const out = {};
    const n = 1 + randInt(rng, 3);
    for (let i = 0; i < n; i += 1) out[pick(rng, RAND_KEYS)] = randValue(rng, depth + 1);
    return out;
  }
  if (r < 0.60) return pick(rng, NUM_POOL);
  if (r < 0.94) return randString(rng);
  return pick(rng, [null, undefined, true, false, [], {}]);
}

function rep(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '-0';
    return String(v);
  }
  if (typeof v === 'string') return v.length > 80 ? JSON.stringify(v.slice(0, 40)) + '…(' + v.length + '字)' : JSON.stringify(v);
  if (typeof v === 'undefined') return 'undefined';
  if (typeof v === 'function') return 'function';
  if (typeof v === 'symbol') return String(v);
  if (v === null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return '[' + v.slice(0, 5).map(rep).join(',') + (v.length > 5 ? ',…' : '') + ']';
  if (v instanceof Date) return 'Date(' + (Number.isNaN(v.getTime()) ? 'Invalid' : v.toISOString()) + ')';
  // 对象用 canon 渲染：保住 Infinity / -0 / undefined（JSON.stringify 会把它们变成 null 或删掉，报告里会看不懂）
  try {
    const s = canon(v);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch (e) {
    return '{循环/不可序列化}';
  }
}

function canon(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canon(v[k]);
    }).join(',') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'undefined') return '<undefined>';
  return String(v);
}

/* 结构比较：键序无关、值为 undefined 的键视同不存在（其余严格） */
function sameValue(a, b) {
  return canon(a) === canon(b);
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* 「字面量泄漏」：字符串里出现 undefined / null / [object Object] */
function leaksLiteral(s) {
  if (typeof s !== 'string') return false;
  return s.includes('undefined') || s.includes('null') || s.includes('[object Object]');
}

/* ---------- CSV 迷你解析器（RFC4180 口径，用于往返验证） ---------- */

const C_QUOTE = 34;
const C_COMMA = 44;

function parseCSV(text) {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (inQuotes) {
      if (code === C_QUOTE) {
        if (s.charCodeAt(i + 1) === C_QUOTE) { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cell += s[i]; i += 1; continue;
    }
    if (code === C_QUOTE && cell === '') { inQuotes = true; i += 1; continue; }
    if (code === C_COMMA) { row.push(cell); cell = ''; i += 1; continue; }
    if (code === 13 && s.charCodeAt(i + 1) === 10) { row.push(cell); rows.push(row); row = []; cell = ''; i += 2; continue; }
    if (code === 13 || code === 10) { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue; }
    cell += s[i]; i += 1;
  }
  row.push(cell);
  rows.push(row);
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function cellText(v) {
  return v == null ? '' : String(v);
}

/* 数据单元格的「写出形态」：= + - @ 开头且不是纯数字时，js/pure.js 的 csvCell 会前置一个单引号中和
   （CSV 的引号包裹挡不住 Excel 求值）。往返用例验证的就是「写出的那一格能被 RFC4180 解析器逐格还原成这个形态」，
   规则与 pure.js 的 CSV_NUMBER_ONLY 保持同一份口径。 */
const CELL_NUMBER_ONLY = new RegExp('^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)([eE][+-]?[0-9]+)?$');
function writtenCell(v) {
  const s = cellText(v);
  if (!s || '=+-@'.indexOf(s[0]) < 0 || CELL_NUMBER_ONLY.test(s)) return s;
  return "'" + s;
}

const FORMULA_TRIGGERS = '=+-@';

function isFormulaStart(cell) {
  return typeof cell === 'string' && cell.length > 0 && FORMULA_TRIGGERS.indexOf(cell[0]) >= 0;
}

/* ---------- 记录生成器 ---------- */

function randWeightRec(rng) {
  return { date: pick(rng, DATES), weightKg: randValue(rng, 1), id: randValue(rng, 1), bodyFatPct: randValue(rng, 1), note: randValue(rng, 1), createdAt: randValue(rng, 1) };
}
function randMealItem(rng) {
  return {
    name: randValue(rng, 1), grams: randValue(rng, 1), kcal: randValue(rng, 1), carb: randValue(rng, 1),
    protein: randValue(rng, 1), fat: randValue(rng, 1), fiber: randValue(rng, 1), sodium: randValue(rng, 1),
    confidence: pick(rng, ['high', 'medium', 'low', 'HIGH', 0.9, 0.55, null, 'x']), foodId: randValue(rng, 1),
  };
}
function randMealRec(rng) {
  const n = randInt(rng, 4);
  const items = [];
  for (let i = 0; i < n; i += 1) items.push(randMealItem(rng));
  return {
    date: pick(rng, DATES), slot: pick(rng, ['breakfast', 'lunch', 'dinner', 'snack', 'brunch', '', null, undefined]),
    items, source: pick(rng, ['ai', 'manual', 'x', null, 3]), createdAt: randValue(rng, 1), id: randValue(rng, 1),
  };
}
function randExerciseRec(rng) {
  return { date: pick(rng, DATES), type: randValue(rng, 1), minutes: randValue(rng, 1), kcalBurned: randValue(rng, 1), note: randValue(rng, 1), intensity: randValue(rng, 1), createdAt: randValue(rng, 1), id: randValue(rng, 1) };
}
function randWaterRec(rng) {
  return { date: pick(rng, DATES), ml: randValue(rng, 1), id: randValue(rng, 1) };
}

/* ============================================================
 * 主入口
 * ============================================================ */

export async function run() {
  const failures = [];
  const findings = [];
  const findingIds = new Set();
  let passed = 0;
  let cases = 0;

  function check(name, fn, findingId) {
    try {
      fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, error: err && err.message ? err.message : String(err), findingId: findingId || null });
    }
  }

  async function checkAsync(name, fn, findingId) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, error: err && err.message ? err.message : String(err), findingId: findingId || null });
    }
  }

  function sweep(name, list, fn, findingId) {
    const bad = [];
    let violations = 0;
    for (const c of list) {
      cases += 1;
      let errs = null;
      try {
        errs = fn(c.arg, c) || [];
      } catch (e) {
        errs = ['对 ' + c.label + ' 抛异常 ' + (e && e.name) + ': ' + (e && e.message)];
      }
      if (errs.length) {
        violations += 1;
        if (bad.length < 3) bad.push({ 输入: c.label, 违规: errs });
      }
    }
    check('sweep ' + name + '（' + list.length + ' 组）', function () {
      assert.equal(violations, 0, violations + '/' + list.length + ' 组违规: ' + JSON.stringify(bad));
    }, findingId || null);
  }

  function bug(spec) {
    let actual;
    let threw = null;
    try {
      actual = spec.probe();
    } catch (e) {
      threw = (e && e.name) + ': ' + (e && e.message);
      actual = null;
    }
    const expected = typeof spec.want === 'function' ? spec.want() : spec.want;
    const same = !threw && sameValue(actual, expected);
    check(spec.id + ' · ' + spec.name, function () {
      assert.ok(same, spec.name + ' → 实际 = ' + (threw ? '抛异常 ' + threw : rep(actual)) + '；期望 = ' + rep(expected));
    }, spec.id);
    if (!same) {
      findingIds.add(spec.id);
      findings.push({
        id: spec.id,
        模块: spec.模块,
        严重度: spec.严重度,
        最小复现: spec.复现,
        实际输出: threw ? '抛出异常 ' + threw : rep(actual),
        期望: spec.期望 || rep(expected),
        你的判断: spec.判断,
        影响面: spec.影响面,
      });
    }
  }

  function cases1(pool, prefix) {
    return pool.map(function (v, i) { return { label: (prefix || '') + '[' + i + ']=' + rep(v), arg: v }; });
  }

  function casesN(pool, arity, k, prefix) {
    const out = [];
    for (const v of pool) out.push({ label: (prefix || '') + '(' + rep(v) + ')×' + arity, arg: new Array(arity).fill(v) });
    for (let i = 0; i < k; i += 1) {
      const row = [];
      for (let j = 0; j < arity; j += 1) row.push(pick(rng, pool));
      out.push({ label: (prefix || '') + 'rnd' + i + '(' + row.map(rep).join(',') + ')', arg: row });
    }
    return out;
  }

  const rng = makeRng(SEED);

  /* ============================================================
   * 1. js/nutrition.js
   * ============================================================ */

  const bmiCases = casesN(ANY_POOL, 2, 70, 'bmi').map(function (c) {
    return { label: c.label, arg: { weightKg: c.arg[0], heightCm: c.arg[1] } };
  });
  sweep('bmi(w,h) 不抛异常 / 只返回有限非负数', bmiCases, function (arg) {
    const out = nutrition.bmi(arg);
    if (!finite(out)) return ['返回 ' + rep(out) + '（契约：非法输入 → 0，绝不出 NaN）'];
    if (out < 0) return ['返回负数 ' + rep(out)];
    return [];
  });
  check('bmi 精确值', function () {
    assert.equal(nutrition.bmi({ weightKg: 70, heightCm: 175 }), 22.9);
    assert.equal(nutrition.bmi({ weightKg: 0, heightCm: 175 }), 0);
    assert.equal(nutrition.bmi({}), 0);
    assert.equal(nutrition.bmi(), 0);
    assert.equal(nutrition.bmi({ weightKg: -70, heightCm: -175 }), 0);
    assert.equal(nutrition.bmi({ weightKg: 1e308, heightCm: 1e308 }), 0);
  });

  sweep('bmiClass(v) 结构稳定 / 文案干净', cases1(ANY_POOL, 'bmiClass'), function (v) {
    const errs = [];
    const out = nutrition.bmiClass(v);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return ['返回非对象 ' + rep(out)];
    if (typeof out.label !== 'string' || out.label === '') errs.push('label 不是非空字符串: ' + rep(out.label));
    if (typeof out.level !== 'string' || ['low', 'normal', 'over', 'obese'].indexOf(out.level) < 0) errs.push('level 越界: ' + rep(out.level));
    if (leaksLiteral(out.label)) errs.push('label 泄漏字面量: ' + rep(out.label));
    return errs;
  });
  check('bmiClass 档位边界（18.5 / 24 / 28 进入下一档）', function () {
    assert.equal(nutrition.bmiClass(18.49).label, '偏瘦');
    assert.equal(nutrition.bmiClass(18.5).label, '正常');
    assert.equal(nutrition.bmiClass(23.99).label, '正常');
    assert.equal(nutrition.bmiClass(24).label, '超重');
    assert.equal(nutrition.bmiClass(27.99).label, '超重');
    assert.equal(nutrition.bmiClass(28).label, '肥胖');
    assert.equal(nutrition.bmiClass(0).label, '未知');
    assert.equal(nutrition.bmiClass(NaN).label, '未知');
    assert.equal(nutrition.bmiClass(-5).label, '未知');
    assert.equal(nutrition.bmiClass('').label, '未知');
  });

  sweep('weightForBmi(bmi,h) 只返回 null 或有限非负数', casesN(ANY_POOL, 2, 60, 'wfb'), function (pair) {
    const out = nutrition.weightForBmi(pair[0], pair[1]);
    if (out === null) return [];
    if (!finite(out)) return ['返回 ' + rep(out) + '（契约：非法 → null；有限 → kg）'];
    if (out < 0) return ['返回负数 ' + rep(out)];
    return [];
  });
  check('weightForBmi 往返一致（±0.3 BMI）', function () {
    const bad = [];
    for (let i = 0; i < 200; i += 1) {
      const bmi = 12 + rng() * 25;
      const h = 140 + rng() * 60;
      const kg = nutrition.weightForBmi(bmi, h);
      const back = nutrition.bmi({ weightKg: kg, heightCm: h });
      if (!finite(back) || Math.abs(back - bmi) > 0.3) bad.push({ bmi: Number(bmi.toFixed(2)), h: Number(h.toFixed(1)), kg, back });
    }
    assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3)));
  });

  const gapCases = casesN(ANY_POOL, 2, 60, 'bmiGaps').map(function (c) {
    return { label: c.label, arg: { bmi: c.arg[0], h: c.arg[1] } };
  });
  sweep('bmiGaps(bmi,h) 结构 / kg 必须有限', gapCases, function (arg) {
    const errs = [];
    const out = nutrition.bmiGaps(arg.bmi, arg.h);
    if (!out || typeof out !== 'object') return ['返回非对象 ' + rep(out)];
    for (const side of ['lower', 'upper']) {
      const gap = out[side];
      if (gap === null) continue;
      if (!gap || typeof gap !== 'object') { errs.push(side + ' 既不是 null 也不是对象: ' + rep(gap)); continue; }
      if (typeof gap.label !== 'string' || gap.label === '') errs.push(side + '.label 非法: ' + rep(gap.label));
      if (!finite(gap.kg)) errs.push(side + '.kg 不是有限数: ' + rep(gap.kg));
      else if (gap.kg < 0) errs.push(side + '.kg 为负: ' + rep(gap.kg));
      if (leaksLiteral(gap.label)) errs.push(side + '.label 泄漏字面量: ' + rep(gap.label));
    }
    return errs;
  });
  check('bmiGaps 档位端点语义（最低档无 lower / 最高档无 upper）', function () {
    assert.equal(nutrition.bmiGaps(17, 170).lower, null);
    assert.equal(nutrition.bmiGaps(17, 170).upper.label, '正常');
    assert.equal(nutrition.bmiGaps(25, 170).upper.label, '肥胖');
    assert.equal(nutrition.bmiGaps(25, 170).lower.label, '正常');
    assert.equal(nutrition.bmiGaps(30, 170).upper, null);
    assert.deepEqual(nutrition.bmiGaps(NaN, 170), { lower: null, upper: null });
    assert.deepEqual(nutrition.bmiGaps(25, 0), { lower: null, upper: null });
  });

  const metCases = [];
  for (const type of nutrition.EXERCISE_TYPES) {
    metCases.push({ label: 'type=' + type.value + ' 默认', arg: [type.value, undefined] });
    for (const it of type.intensities || []) metCases.push({ label: 'type=' + type.value + '/int=' + it.value, arg: [type.value, it.value] });
  }
  for (const v of ANY_POOL) metCases.push({ label: 'junk(' + rep(v) + ')', arg: [v, v] });
  let allMetsAboveOne = true;
  sweep('exerciseMet(type,intensity) 只返回有限正数', metCases, function (arg) {
    const out = nutrition.exerciseMet(arg[0], arg[1]);
    if (!finite(out) || out <= 0) return ['返回 ' + rep(out)];
    if (arg[0] === 'jog' && arg[1] === 'fast' && out !== 11) return ['已知档位取值错误: ' + out];
    return [];
  });
  check('exerciseMet：所有登记档位 MET > 1（净消耗公式不出负）', function () {
    for (const type of nutrition.EXERCISE_TYPES) {
      if (!(type.met > 1)) allMetsAboveOne = false;
      for (const it of type.intensities || []) if (!(it.met > 1)) allMetsAboveOne = false;
    }
    assert.ok(allMetsAboveOne, '存在 MET <= 1 的档位，estimateBurn 会被 Math.max 夹成 0');
    assert.equal(nutrition.exerciseMet('不存在', 'x'), 4);
    assert.equal(nutrition.exerciseMet('jog', ' fast '), 11);
    assert.equal(nutrition.exerciseMet('jog', 'FAST'), 9);
  });

  const burnCases = [];
  for (const v of ANY_POOL) burnCases.push({ label: 'single(' + rep(v) + ')', arg: v });
  for (let i = 0; i < 80; i += 1) {
    burnCases.push({
      label: 'rnd' + i,
      arg: { type: pick(rng, ['walk', 'jog', 'other', '', null, 7, {}]), intensity: randValue(rng, 1), minutes: randValue(rng, 1), weightKg: randValue(rng, 1) },
    });
  }
  sweep('estimateBurn(rec) 只返回有限非负整数', burnCases, function (rec) {
    const out = nutrition.estimateBurn(rec);
    if (!finite(out)) return ['返回 ' + rep(out)];
    if (out < 0) return ['返回负数 ' + rep(out)];
    if (Math.round(out) !== out) return ['返回非整数 ' + rep(out)];
    return [];
  }, 'NUMERIC_OVERFLOW_INFINITY');
  check('estimateBurn 精确值（净消耗 = (MET-1) × kg × 小时）', function () {
    assert.equal(nutrition.estimateBurn({ type: 'jog', intensity: 'fast', minutes: 60, weightKg: 70 }), 700);
    assert.equal(nutrition.estimateBurn({ type: '不存在', minutes: 60, weightKg: 70 }), 210);
    assert.equal(nutrition.estimateBurn({ type: 'jog', minutes: 0, weightKg: 70 }), 0);
    assert.equal(nutrition.estimateBurn({ type: 'jog', minutes: 60, weightKg: 0 }), 0);
    assert.equal(nutrition.estimateBurn({ type: 'jog', minutes: Infinity, weightKg: 70 }), 0);
    assert.equal(nutrition.estimateBurn(), 0);
    assert.equal(nutrition.estimateBurn(null), 0);
  });

  const maCases = [];
  for (let i = 0; i < 90; i += 1) {
    const n = randInt(rng, 6);
    const series = [];
    for (let j = 0; j < n; j += 1) {
      if (rng() < 0.25) series.push(randValue(rng, 1));
      else series.push({ date: randString(rng, 6), value: randValue(rng, 1) });
    }
    maCases.push({
      label: 'rnd' + i,
      arg: { series, size: pick(rng, [1, 2, 3, 7, 30, 0, -1, 1.7, 1e9, Infinity, NaN, null, undefined, '', '7', {}]) },
    });
  }
  for (const size of [1, 2, 3, 7, 0, -3, 1.5, 1e6, Infinity, NaN, 'x', null, '', {}]) {
    maCases.push({ label: 'size=' + rep(size), arg: { series: [{ date: 'a', value: 70 }, { date: 'b', value: 80 }, { date: 'c', value: 90 }], size } });
  }
  sweep('movingAverage 长度/顺序/字段类型/不改入参', maCases, function (arg) {
    const errs = [];
    const snapshot = JSON.parse(JSON.stringify(arg.series));
    const out = nutrition.movingAverage(arg.series, arg.size);
    if (!Array.isArray(out)) return ['返回非数组 ' + rep(out)];
    if (out.length !== arg.series.length) errs.push('长度变化 ' + arg.series.length + ' → ' + out.length);
    for (let i = 0; i < out.length; i += 1) {
      const row = out[i];
      const src = arg.series[i];
      if (!row || typeof row !== 'object') { errs.push('第 ' + i + ' 项不是对象'); continue; }
      const wantDate = src && typeof src === 'object' && typeof src.date === 'string' ? src.date : '';
      if (row.date !== wantDate) errs.push('第 ' + i + ' 项 date 变了: ' + rep(row.date) + ' ≠ ' + rep(wantDate));
      if (!('value' in row) || !sameValue(row.value, src && typeof src === 'object' ? src.value : undefined)) errs.push('第 ' + i + ' 项 value 不是原样透传');
      if (row.avg !== null && !finite(row.avg)) errs.push('第 ' + i + ' 项 avg 既不是 null 也不是有限数: ' + rep(row.avg));
      if (Object.keys(row).sort().join(',') !== 'avg,date,value') errs.push('第 ' + i + ' 项字段集异常: ' + Object.keys(row).join(','));
    }
    if (!sameValue(JSON.parse(JSON.stringify(arg.series)), snapshot)) errs.push('入参被改动（契约：不改入参、不重排）');
    return errs;
  }, 'NUMERIC_OVERFLOW_INFINITY');
  check('movingAverage：单点 / window=1 恒为 null（文档语义）', function () {
    assert.deepEqual(nutrition.movingAverage([{ date: 'a', value: 70 }], 7), [{ date: 'a', value: 70, avg: null }]);
    assert.deepEqual(nutrition.movingAverage([{ date: 'a', value: 70 }, { date: 'b', value: 80 }], 1), [
      { date: 'a', value: 70, avg: null }, { date: 'b', value: 80, avg: null },
    ]);
    assert.deepEqual(nutrition.movingAverage([], 7), []);
    assert.equal(nutrition.movingAverage([{ date: 'a', value: 70 }, { date: 'b', value: 80 }, { date: 'c', value: 90 }], 7)[2].avg, 80);
  });

  check('kgToUnit / unitToKg 往返（20-300kg 与 40-600斤）', function () {
    const bad = [];
    for (let i = 0; i < 500; i += 1) {
      const kg = 20 + rng() * 280;
      for (const unit of ['kg', 'jin', '斤', 'unknown', '', null]) {
        const shown = nutrition.kgToUnit(kg, unit);
        const back = nutrition.unitToKg(shown, unit);
        if (!finite(shown) || !finite(back)) { bad.push({ kg: Number(kg.toFixed(2)), unit, shown, back }); continue; }
        if (Math.abs(back - kg) > 0.051) bad.push({ kg: Number(kg.toFixed(2)), unit, shown, back, diff: Math.abs(back - kg) });
      }
    }
    assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3)));
  });
  check('斤/公斤显示互算一致（kgToUnit 与 jin 差 2 倍以内 0.11）', function () {
    const bad = [];
    for (let i = 0; i < 300; i += 1) {
      const kg = 20 + rng() * 280;
      if (Math.abs(nutrition.kgToUnit(kg, 'jin') - nutrition.kgToUnit(kg, 'kg') * 2) > 0.11) bad.push(kg);
    }
    assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3)));
  });
  check('weightStep / weightRange 契约（未知单位回落 kg + 返回新对象）', function () {
    assert.equal(nutrition.weightStep('jin'), 0.2);
    assert.equal(nutrition.weightStep('kg'), 0.1);
    assert.equal(nutrition.weightStep('nope'), 0.1);
    assert.equal(nutrition.weightStep(null), 0.1);
    const kg = nutrition.weightRange('kg');
    const jin = nutrition.weightRange('jin');
    assert.deepEqual(kg, { min: 20, max: 300 });
    assert.deepEqual(jin, { min: 40, max: 600 });
    assert.deepEqual(nutrition.weightRange('nope'), { min: 20, max: 300 });
    assert.equal(jin.min * 0.5, kg.min);
    assert.equal(jin.max * 0.5, kg.max);
    const first = nutrition.weightRange('kg');
    first.min = 999;
    assert.equal(nutrition.weightRange('kg').min, 20, 'weightRange 返回了共享对象，调用方能改坏配置');
  });

  const wsCases = [];
  for (let i = 0; i < 60; i += 1) {
    const n = randInt(rng, 5);
    const rows = [];
    for (let j = 0; j < n; j += 1) rows.push(randWeightRec(rng));
    wsCases.push({ label: 'rnd' + i, arg: rows });
  }
  for (const v of ANY_POOL) wsCases.push({ label: 'single(' + rep(v) + ')', arg: v });
  sweep('weightStats 结构稳定 / 数值有限', wsCases, function (rows) {
    const errs = [];
    const out = nutrition.weightStats(rows);
    if (!out || typeof out !== 'object') return ['返回非对象'];
    if (out.latest !== null && !finite(out.latest)) errs.push('latest 非有限数: ' + rep(out.latest));
    if (out.latestDate !== null && typeof out.latestDate !== 'string') errs.push('latestDate 非字符串');
    for (const k of ['delta7', 'delta30']) if (out[k] !== null && !finite(out[k])) errs.push(k + ' 非有限数: ' + rep(out[k]));
    if (!Array.isArray(out.series)) errs.push('series 不是数组');
    else {
      for (let i = 1; i < out.series.length; i += 1) {
        if (out.series[i].date <= out.series[i - 1].date) errs.push('series 未按日期升序 / 同日期未去重: ' + out.series[i].date);
      }
      for (const row of out.series) if (!finite(row.weightKg) || row.weightKg < 0) errs.push('series 含非法体重: ' + rep(row.weightKg));
    }
    return errs;
  });

  sweep('sumItems / netKcal / scaleFood / kcalFromMacros 只出有限数', cases1(ANY_POOL, 'num'), function (v) {
    const errs = [];
    const items = nutrition.sumItems([v, 1, '2', { kcal: v, carb: v, protein: v, fat: v, fiber: v, sodium: v }]);
    for (const k of Object.keys(items)) if (!finite(items[k])) errs.push('sumItems.' + k + ' = ' + rep(items[k]));
    if (!finite(nutrition.netKcal(v, v))) errs.push('netKcal 非有限数');
    if (!finite(nutrition.kcalFromMacros({ carb: v, protein: v, fat: v }))) errs.push('kcalFromMacros 非有限数');
    if (!finite(nutrition.round1(v))) errs.push('round1 非有限数');
    const scaled = nutrition.scaleFood({ kcal: v, carb: v, protein: v, fat: v, fiber: v, sodium: v }, v);
    for (const k of Object.keys(scaled)) if (!finite(scaled[k]) || scaled[k] < 0) errs.push('scaleFood.' + k + ' = ' + rep(scaled[k]));
    if (!finite(nutrition.tdee(v, v))) errs.push('tdee 非有限数');
    return errs;
  }, 'NUMERIC_OVERFLOW_INFINITY');

  check('round1 收口（-0 / NaN / Infinity）', function () {
    assert.equal(nutrition.round1(-0.04), 0);
    assert.equal(Object.is(nutrition.round1(-0.04), -0), false, 'round1 泄漏了 -0');
    assert.equal(nutrition.round1(NaN), 0);
    assert.equal(nutrition.round1(Infinity), 0);
    assert.equal(nutrition.round1(0.25), 0.3);
    assert.equal(nutrition.round1('1.24'), 1.2);
  });

  bug({
    id: 'NUMERIC_OVERFLOW_INFINITY',
    name: '有限但极大的输入让「防 NaN 污染」的数值函数吐出 ±Infinity',
    模块: 'js/nutrition.js round1 / sumItems / scaleFood / kcalFromMacros / estimateBurn / movingAverage',
    严重度: 'low',
    复现: [
      "const nutrition = await import('./js/nutrition.js');",
      'nutrition.round1(1e308);                    // → Infinity（文档说非有限值归 0 就是为了不污染聚合，可它对有限大数自己吐 Infinity）',
      'nutrition.sumItems([{ kcal: 1e308, carb: 1e308 }]);',
      'nutrition.scaleFood({ kcal: 1e308 }, 1e308);',
      "nutrition.movingAverage([{ date: 'd1', value: 1e308 }, { date: 'd2', value: 1e308 }], 7)[1].avg;   // → Infinity",
      "nutrition.estimateBurn({ type: 'jog', minutes: 1e15, weightKg: 1e308 });   // → Infinity",
      "// 连带：normalizeMealItem/protein: 1e308 → Infinity，回灌一次又变 0（normalize 在溢出输入上不幂等）",
    ].join(LF),
    probe: function () {
      return {
        round1_1e308: nutrition.round1(1e308),
        sumItems_carb: nutrition.sumItems([{ kcal: 1e308, carb: 1e308 }]).carb,
        scaleFood_kcal: nutrition.scaleFood({ kcal: 1e308 }, 1e308).kcal,
        kcalFromMacros: nutrition.kcalFromMacros({ carb: 1e308, protein: 1e308, fat: 1e308 }),
        movingAverage_avg: nutrition.movingAverage([{ date: 'd1', value: 1e308 }, { date: 'd2', value: 1e308 }], 7)[1].avg,
        estimateBurn: nutrition.estimateBurn({ type: 'jog', minutes: 1e15, weightKg: 1e308 }),
      };
    },
    want: { round1_1e308: 0, sumItems_carb: 0, scaleFood_kcal: 0, kcalFromMacros: 0, movingAverage_avg: 0, estimateBurn: 0 },
    期望: '有限数（溢出时按各自兜底语义归 0），不得是 ±Infinity —— round1 的注释明确说「非有限值一律归 0，避免 NaN 顺着聚合污染整个页面」',
    判断: '这一族只挡了「入参非有限」，没挡「计算过程溢出」：round1 的 Math.round(v*10)、sumItems 的累加、scaleFood 的比例乘、estimateBurn 的乘积都会溢出成 ±Infinity，之后和 NaN 一样把页面数字污染成 Infinity。属于低危健壮性缺口。',
    影响面: '需要 1e308 量级入参才会命中（正常体重/克数/时长不可能）；手改或第三方导入的 JSON 里带这种数字时，界面/图表会显示 Infinity，且 normalize* 在这类输入上不幂等。',
  });

  bug({
    id: 'DATE_SHAPE_ONLY',
    name: '日期只做形状校验：2026-02-31 / 2026-13-01 能进库',
    模块: 'js/pure.js validDate / normalize*Record',
    严重度: 'low',
    复现: [
      "const pure = await import('./js/pure.js');",
      "pure.normalizeWeightRecord({ date: '2026-02-31', weightKg: 70 });          // 并未判非法",
      "pure.normalizeMealRecord({ date: '2026-13-01', slot: 'lunch', items: [] }); // date 原样落库",
      "// 对照：nutrition.parseDateStr('2026-02-31') → Invalid Date（同一个仓库里对日历非法日期的判定不一致）",
    ].join(LF),
    probe: function () {
      const w = pure.normalizeWeightRecord({ date: '2026-02-31', weightKg: 70 });
      const m = pure.normalizeMealRecord({ date: '2026-13-01', slot: 'lunch', items: [] });
      const rows = pure.buildRangeRows({ fromDate: '2026-02-01', toDate: '2026-03-31', weights: w ? [w] : [] });
      return { 体重记录date: w && w.date, 餐次date: m && m.date, 区间图里的日期: rows.map(function (r) { return r.date; }) };
    },
    want: { 体重记录date: null, 餐次date: null, 区间图里的日期: [] },
    期望: '与 nutrition.parseDateStr 一致：日历非法的日期判非法（返回 null / 不落库）',
    判断: 'validDate 只测 /^\d{4}-\d{2}-\d{2}$/ 这个形状，2026-02-31、2026-13-01 都能过。同一仓库的 parseDateStr 明确把这类日期判非法（注释：「2026-02-31 这类溢出会滚到 3 月，视为非法」）。另一种解读是「导入尽量宽容」，但那样这些记录既进不了任何一天的视图，又会在区间图/CSV 里以不存在的日期出现。',
    影响面: '只能由导入/手改 JSON 触发（应用内写入的日期都来自 localDateStr/parseDateStr）；后果是脏日期记录只出现在导出与区间图里、永远打不开对应那一天。',
  });

  check('日期工具：parseDateStr / localDateStr / daysAgo 不抛且类型稳定', function () {
    for (const v of ANY_POOL) {
      const d = nutrition.parseDateStr(v);
      assert.ok(d instanceof Date, 'parseDateStr 必须返回 Date');
      assert.ok(Number.isNaN(d.getTime()) || (d.getHours() === 0 && d.getMinutes() === 0), 'parseDateStr 必须落在本地 00:00');
      assert.equal(typeof nutrition.localDateStr(v), 'string');
      assert.equal(typeof nutrition.daysAgo(v), 'string');
      assert.equal(typeof nutrition.bmrMifflinStJeor(v && typeof v === 'object' ? v : {}), 'number');
      assert.equal(typeof nutrition.ageFromBirthday(v), 'number');
      assert.equal(typeof nutrition.targetMacros(v).carb, 'number');
    }
    assert.ok(Number.isNaN(nutrition.parseDateStr('2026-02-31').getTime()), '2026-02-31 应判非法');
    assert.ok(Number.isNaN(nutrition.parseDateStr('0000-01-01').getTime()), '公元 0 年应判非法');
    assert.equal(nutrition.localDateStr('不是日期'), '');
    assert.equal(nutrition.daysAgo('x'), nutrition.daysAgo(0), "非数字 n 走 num 兜底 0 = 今天");
    assert.match(nutrition.daysAgo(0), /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  });

  /* ============================================================
   * 2. js/pure.js（记录整形 / 去重 / 聚合 / CSV）
   * ============================================================ */

  function findNonFiniteNumbers(value, at) {
    const bad = [];
    if (typeof value === 'number' && !Number.isFinite(value)) bad.push(at + '=' + rep(value));
    else if (Array.isArray(value)) value.forEach(function (v, i) { bad.push.apply(bad, findNonFiniteNumbers(v, at + '[' + i + ']')); });
    else if (value && typeof value === 'object') for (const k of Object.keys(value)) bad.push.apply(bad, findNonFiniteNumbers(value[k], at + '.' + k));
    return bad;
  }

  function isDateLike(s) {
    return typeof s === 'string' && s.length === 10 && s[4] === '-' && s[7] === '-';
  }

  const STORES = ['weights', 'meals', 'exercises', 'waters'];

  /* ---------- 2.1 buildDaySummary ---------- */

  const summaryCases = [];
  for (let i = 0; i < 60; i += 1) {
    summaryCases.push({
      label: 'rnd' + i,
      arg: {
        date: pick(rng, DATES),
        meals: [randMealRec(rng), randMealRec(rng), randValue(rng, 1)],
        exercises: [randExerciseRec(rng), randValue(rng, 1)],
        water: randValue(rng, 1),
        weight: randValue(rng, 1),
      },
    });
  }
  for (const v of ANY_POOL) summaryCases.push({ label: 'junk(' + rep(v) + ')', arg: { date: v, meals: v, exercises: v, water: v, weight: v } });
  sweep('buildDaySummary 结构 / 数值有限 / 排序 / 不改入参', summaryCases, function (arg) {
    const errs = [];
    const mealsSnapshot = JSON.parse(JSON.stringify(arg.meals === undefined ? null : arg.meals));
    const out = pure.buildDaySummary(arg);
    if (!out || typeof out !== 'object') return ['返回非对象 ' + rep(out)];
    // NaN !== NaN 是 JS 的语义（不是「date 没透传」）：两边都是 NaN 时视为同一个值，其余仍用严格不等
    const bothNaN = typeof out.date === 'number' && typeof arg.date === 'number' && Number.isNaN(out.date) && Number.isNaN(arg.date);
    if (out.date !== arg.date && !bothNaN) errs.push('date 未透传: ' + rep(out.date));
    if (!out.intake || typeof out.intake !== 'object') errs.push('intake 不是对象');
    else {
      for (const k of ['kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium']) if (!finite(out.intake[k])) errs.push('intake.' + k + ' = ' + rep(out.intake[k]));
    }
    for (const k of ['burned', 'water', 'netKcal']) if (!finite(out[k])) errs.push(k + ' 不是有限数: ' + rep(out[k]));
    if (!Array.isArray(out.meals) || !Array.isArray(out.exercises)) errs.push('meals/exercises 不是数组');
    else {
      if (!Array.isArray(arg.meals) && out.meals.length !== 0) errs.push('非数组 meals 应产出空数组');
      const cnum = function (v) { const n = Number(v); return Number.isFinite(n) ? n : 0; };
      // 注意：JS 规范要求 sort 把 undefined 元素强制排到末尾（不调用比较函数），不算实现违规
      const definedMeals = out.meals.filter(function (m) { return m !== undefined; });
      for (let i = 1; i < definedMeals.length; i += 1) {
        const prevC = cnum(definedMeals[i - 1] && definedMeals[i - 1].createdAt);
        const curC = cnum(definedMeals[i] && definedMeals[i].createdAt);
        if (curC < prevC) errs.push('meals 未按 createdAt 升序：' + rep(definedMeals[i - 1] && definedMeals[i - 1].createdAt) + ' → ' + rep(definedMeals[i] && definedMeals[i].createdAt));
      }
      if (Number.isFinite(out.intake.kcal) && finite(out.burned) && out.netKcal !== out.intake.kcal - out.burned) {
        errs.push('netKcal ≠ intake.kcal - burned（' + out.netKcal + ' vs ' + (out.intake.kcal - out.burned) + '）');
      }
    }
    if (!sameValue(JSON.parse(JSON.stringify(arg.meals === undefined ? null : arg.meals)), mealsSnapshot)) errs.push('入参 meals 被排序改动');
    if (out.weight !== null && typeof out.weight !== 'object') errs.push('weight 既不是 null 也不是对象');
    return errs;
  }, 'NUMERIC_OVERFLOW_INFINITY');
  check('buildDaySummary 精确值', function () {
    const out = pure.buildDaySummary({
      date: '2026-05-01',
      meals: [{ date: '2026-05-01', createdAt: 2, items: [{ kcal: 100, carb: 10, protein: 5, fat: 2 }] }, { date: '2026-05-01', createdAt: 1, items: [{ kcal: 50, carb: 5, protein: 1, fat: 1, fiber: 2, sodium: 3 }] }],
      exercises: [{ kcalBurned: 120 }, { kcalBurned: -50 }],
      water: { ml: 800 },
      weight: { date: '2026-05-01', weightKg: 70 },
    });
    assert.equal(out.intake.kcal, 150);
    assert.equal(out.intake.fiber, 2);
    assert.equal(out.intake.sodium, 3);
    assert.equal(out.burned, 120);
    assert.equal(out.water, 800);
    assert.equal(out.netKcal, 30);
    assert.equal(out.meals[0].createdAt, 1);
    assert.equal(pure.buildDaySummary().netKcal, 0);
    assert.equal(pure.buildDaySummary({ water: -800 }).water, 0);
    assert.equal(pure.buildDaySummary({ water: '800' }).water, 800);
  });

  /* ---------- 2.2 buildRangeRows ---------- */

  const rangeCases = [];
  for (let i = 0; i < 60; i += 1) {
    rangeCases.push({
      label: 'rnd' + i,
      arg: { fromDate: pick(rng, DATES), toDate: pick(rng, DATES), weights: [randWeightRec(rng), randWeightRec(rng)], meals: [randMealRec(rng)], exercises: [randExerciseRec(rng)], waters: [randWaterRec(rng)] },
    });
  }
  for (const v of ANY_POOL) rangeCases.push({ label: 'junk(' + rep(v) + ')', arg: { fromDate: v, toDate: v, weights: v, meals: v, exercises: v, waters: v } });
  sweep('buildRangeRows 结构 / 数值有限 / 只出有数据的日期且升序', rangeCases, function (arg) {
    const errs = [];
    const out = pure.buildRangeRows(arg);
    if (!Array.isArray(out)) return ['返回非数组 ' + rep(out)];
    const keys = ['burned', 'carb', 'date', 'fat', 'kcal', 'protein', 'water', 'weightKg'];
    for (let i = 0; i < out.length; i += 1) {
      const row = out[i];
      if (!row || typeof row !== 'object') { errs.push('第 ' + i + ' 项不是对象'); continue; }
      if (Object.keys(row).sort().join(',') !== keys.join(',')) errs.push('第 ' + i + ' 项字段集异常: ' + Object.keys(row).join(','));
      if (!isDateLike(row.date)) errs.push('第 ' + i + ' 项 date 非法: ' + rep(row.date));
      for (const k of ['kcal', 'carb', 'protein', 'fat', 'burned', 'water']) if (!finite(row[k])) errs.push('第 ' + i + ' 项 ' + k + ' = ' + rep(row[k]));
      if (row.water < 0) errs.push('第 ' + i + ' 项 water 为负: ' + rep(row.water));
      if (row.weightKg !== null && (!finite(row.weightKg) || row.weightKg <= 0)) errs.push('第 ' + i + ' 项 weightKg = ' + rep(row.weightKg));
      if (i > 0 && row.date <= out[i - 1].date) errs.push('输出未按日期升序或含重复日期: ' + row.date);
      if (isDateLike(row.date) && typeof arg.fromDate === 'string' && typeof arg.toDate === 'string' && (row.date < arg.fromDate || row.date > arg.toDate)) errs.push('越界日期 ' + row.date);
    }
    return errs;
  }, 'NUMERIC_OVERFLOW_INFINITY');
  check('buildRangeRows：只输出真正有数据的日期', function () {
    const out = pure.buildRangeRows({
      fromDate: '2026-05-01', toDate: '2026-05-31',
      weights: [{ date: '2026-05-01', weightKg: 70 }, { date: '2026-05-02', weightKg: NaN }],
      meals: [{ date: '2026-05-03', items: [{ kcal: 100, carb: 1, protein: 2, fat: 3 }] }],
      exercises: [{ date: '2026-05-03', kcalBurned: 200 }],
      waters: [{ date: '2026-05-03', ml: 500 }, { date: '2026-05-04', ml: 0 }],
    });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(function (r) { return r.date; }), ['2026-05-01', '2026-05-03']);
    assert.equal(out[1].kcal, 100);
    assert.equal(out[1].burned, 200);
    assert.equal(out[1].water, 500);
    assert.equal(out[0].weightKg, 70);
    assert.equal(out[1].weightKg, null);
    assert.equal(pure.buildRangeRows({ fromDate: '2026-05-02', toDate: '2026-05-01' }).length, 0);
  });

  /* ---------- 2.3 buildCSV ---------- */

  function csvSections(csv) {
    const rows = parseCSV(csv);
    const sections = [];
    let cur = null;
    for (const row of rows) {
      const first = row[0] || '';
      if (first.startsWith('#')) { cur = { title: first, header: null, data: [] }; sections.push(cur); continue; }
      if (!cur) continue;
      if (row.length === 1 && row[0] === '') continue;
      if (!cur.header) { cur.header = row; continue; }
      cur.data.push(row);
    }
    return sections;
  }

  function expectedWeightRows(weights) {
    return weights.map(function (w) {
      return [writtenCell(w.date), writtenCell(w.weightKg), writtenCell(w.bodyFatPct), writtenCell(w.note), writtenCell(w.createdAt)];
    });
  }
  function expectedMealRows(meals) {
    const out = [];
    for (const m of meals) {
      const items = Array.isArray(m.items) && m.items.length ? m.items : [null];
      for (const it of items) {
        const field = function (k) { return it && typeof it === 'object' ? it[k] : undefined; };
        out.push([writtenCell(m.date), writtenCell(m.slot), writtenCell(field('name')), writtenCell(field('grams')), writtenCell(field('kcal')), writtenCell(field('carb')),
          writtenCell(field('protein')), writtenCell(field('fat')), writtenCell(field('fiber')), writtenCell(field('sodium')), writtenCell(m.source), writtenCell(m.createdAt)]);
      }
    }
    return out;
  }
  function expectedExerciseRows(exercises) {
    return exercises.map(function (e) {
      return [writtenCell(e.date), writtenCell(e.type), writtenCell(e.minutes), writtenCell(e.kcalBurned), writtenCell(e.note), writtenCell(e.createdAt)];
    });
  }
  function expectedWaterRows(waters) {
    return waters.map(function (w) { return [writtenCell(w.date), writtenCell(w.ml)]; });
  }
  function rowKey(row) {
    return JSON.stringify(row);
  }

  check('buildCSV 骨架：BOM + CRLF + 四段 + 表头列数', function () {
    const csv = pure.buildCSV({});
    assert.ok(csv.startsWith(BOM), '缺少 BOM（Excel 中文表头会乱码）');
    assert.ok(csv.endsWith(CR + LF), '结尾不是 CRLF');
    const sections = csvSections(csv);
    assert.equal(sections.length, 4, '段数错误: ' + sections.map(function (s) { return s.title; }).join(','));
    assert.deepEqual(sections.map(function (s) { return s.title; }), ['# 体重', '# 饮食明细', '# 运动', '# 饮水']);
    assert.deepEqual(sections.map(function (s) { return s.header.length; }), [5, 12, 6, 2]);
    assert.equal(sections.reduce(function (a, s) { return a + s.data.length; }, 0), 0, '空数据应无数据行');
  });

  const csvCases = [];
  for (let i = 0; i < 60; i += 1) {
    csvCases.push({
      label: 'rnd' + i,
      arg: { weights: [randWeightRec(rng), randWeightRec(rng)], meals: [randMealRec(rng), randMealRec(rng)], exercises: [randExerciseRec(rng)], waters: [randWaterRec(rng)] },
    });
  }
  sweep('buildCSV 行数/字段数/转义往返（nasty 字段）', csvCases, function (arg) {
    const errs = [];
    const csv = pure.buildCSV(arg);
    const sections = csvSections(csv);
    if (sections.length !== 4) return ['段数 ' + sections.length];
    const expect = [
      expectedWeightRows(arg.weights),
      expectedMealRows(arg.meals),
      expectedExerciseRows(arg.exercises),
      expectedWaterRows(arg.waters),
    ];
    for (let s = 0; s < 4; s += 1) {
      const got = sections[s].data.map(rowKey).sort();
      const want = expect[s].map(rowKey).sort();
      if (got.length !== want.length) { errs.push('第 ' + s + ' 段行数 ' + got.length + ' ≠ ' + want.length); continue; }
      for (let i = 0; i < want.length; i += 1) if (got[i] !== want[i]) { errs.push('第 ' + s + ' 段往返不一致: ' + rep(got[i]) + ' ≠ ' + rep(want[i])); break; }
      for (const row of sections[s].data) if (row.length !== sections[s].header.length) { errs.push('第 ' + s + ' 段字段数 ' + row.length + ' ≠ ' + sections[s].header.length); break; }
    }
    return errs;
  });

  check('buildCSV 转义：逗号/引号/换行/emoji/超长字段', function () {
    const nasty = 'a,b"c' + LF + 'd' + CR + 'e,🍚' + '中'.repeat(2000);
    const csv = pure.buildCSV({
      weights: [{ date: '2026-05-01', weightKg: 70, note: nasty }],
      meals: [{ date: '2026-05-01', slot: 'lunch', source: 'manual', createdAt: 1, items: [{ name: nasty, grams: 100, kcal: 1 }] }],
      exercises: [{ date: '2026-05-01', type: nasty, minutes: 1, kcalBurned: 1, createdAt: 1 }],
      waters: [],
    });
    const sections = csvSections(csv);
    assert.equal(sections[0].data.length, 1);
    assert.equal(sections[0].data[0].length, 5);
    assert.equal(sections[0].data[0][3], nasty, '含逗号/引号/换行的字段往返失败');
    assert.equal(sections[1].data[0][2], nasty, '饮食明细名称往返失败');
    assert.equal(sections[2].data[0][1], nasty, '运动类型往返失败');
    const huge = pure.buildCSV({ meals: [{ date: '2026-05-01', slot: 'lunch', source: 'manual', createdAt: 1, items: [{ name: 'a'.repeat(1000000), grams: 1, kcal: 1 }] }] });
    assert.equal(csvSections(huge)[1].data[0][2].length, 1000000, '1e6 字符字段被截断或转义坏掉');
  });

  check('buildCSV 干净记录里不得出现 undefined / null / [object Object]', function () {
    const csv = pure.buildCSV({
      weights: [{ date: '2026-05-01', weightKg: 70 }],
      meals: [{ date: '2026-05-01', slot: 'lunch', source: 'manual', createdAt: 1, items: [{ name: '米饭', grams: 200, kcal: 232 }] }],
      exercises: [{ date: '2026-05-01', type: '跑步', minutes: 30, kcalBurned: 300 }],
      waters: [{ date: '2026-05-01', ml: 500 }],
    });
    for (const row of parseCSV(csv)) {
      for (const cell of row) {
        if (cell.includes('[object Object]')) throw new Error('CSV 里出现 [object Object]: ' + rep(cell));
        if (cell === 'undefined') throw new Error('CSV 里出现 undefined 字面量');
      }
    }
    assert.ok(csv.includes('2026-05-01,70,,,'), '空列应留空而不是 undefined: ' + rep(csv.split(CR + LF)[2]));
  });

  bug({
    id: 'CSV_FORMULA_INJECTION',
    name: '导出 CSV 的公式前缀未被中和（= + - @ 开头原样落盘）',
    模块: 'js/pure.js buildCSV / csvCell',
    严重度: 'medium',
    复现: [
      "const pure = await import('./js/pure.js');",
      "const Q = String.fromCharCode(39);   // 单引号，避免引号嵌套",
      "const csv = pure.buildCSV({",
      "  weights: [{ date: '2026-05-01', weightKg: 70, note: '=1+1' }],",
      "  meals: [{ date: '2026-05-01', slot: 'lunch', source: 'manual', createdAt: 1, items: [{ name: '=cmd|' + Q + ' /C calc' + Q + '!A0', grams: 100, kcal: 1 }] }],",
      "  exercises: [{ date: '2026-05-01', type: '+1+1', minutes: 30, kcalBurned: 1, createdAt: 1 }],",
      '});',
      'csv.split(String.fromCharCode(13, 10)).filter(function (l) { return l.indexOf(String.fromCharCode(61)) >= 0 || l.indexOf(String.fromCharCode(43)) === 0; });',
      '// 数据行里会出现 =1+1 与 =cmd|... ：Excel/WPS 打开时会当公式执行',
    ].join(LF),
    probe: function () {
      const csv = pure.buildCSV({
        weights: [{ date: '2026-05-01', weightKg: 70, note: '=1+1' }],
        meals: [{ date: '2026-05-01', slot: 'lunch', source: 'manual', createdAt: 1, items: [{ name: "=cmd|' /C calc'!A0", grams: 100, kcal: 1 }] }],
        exercises: [{ date: '2026-05-01', type: '+1+1', minutes: 30, kcalBurned: 1, createdAt: 1 }],
        waters: [],
      });
      const offending = [];
      for (const line of csv.split(CR + LF)) {
        const cells = parseCSV(line + CR + LF)[0] || [];
        for (const cell of cells) if (isFormulaStart(cell)) offending.push(cell);
      }
      return offending;
    },
    want: [],
    期望: '[]（数据单元格不得以 = + - @ 开头；CSV 的引号包裹并不能阻止 Excel 求值，需要加前置文本标记中和）',
    判断: 'csvCell 只在含逗号/引号/换行时加引号，完全没处理公式触发字符；Excel/WPS 打开导出文件时会把 =1+1、=cmd|... 当公式/DDE 执行。属于经典的 CSV 注入（导出侧）。',
    影响面: '本机数据不丢；影响的是「导出文件被 Excel/WPS 打开」这条链路——用户自己或把导出文件发给别人的机器上可能执行公式。记录里的名称/备注/运动类型都可能带此类字符串（手工输入、AI 识别结果、别人给的 JSON 导入）。',
  });

  /* ---------- 2.4 normalize* 整形 ---------- */

  const normCases = [];
  for (let i = 0; i < 45; i += 1) normCases.push({ label: 'weight rnd' + i, arg: { store: 'weights', rec: randWeightRec(rng) } });
  for (let i = 0; i < 45; i += 1) normCases.push({ label: 'meal rnd' + i, arg: { store: 'meals', rec: randMealRec(rng) } });
  for (let i = 0; i < 45; i += 1) normCases.push({ label: 'exercise rnd' + i, arg: { store: 'exercises', rec: randExerciseRec(rng) } });
  for (let i = 0; i < 30; i += 1) normCases.push({ label: 'water rnd' + i, arg: { store: 'waters', rec: randWaterRec(rng) } });
  for (const store of STORES) for (const v of ANY_POOL) normCases.push({ label: store + ' junk(' + rep(v) + ')', arg: { store, rec: v } });

  check('normalizeRecord：null 或干净对象 / 无 NaN / 无 undefined 值 / 幂等', function () {
    const realNow = Date.now;
    Date.now = function () { return 1700000000000; };
    const bad = [];
    try {
      for (const c of normCases) {
        cases += 1;
        const first = pure.normalizeRecord(c.arg.store, c.arg.rec);
        if (first === null) continue;
        if (typeof first !== 'object' || Array.isArray(first)) { bad.push(c.label + ' → 非对象 ' + rep(first)); continue; }
        const undef = Object.keys(first).filter(function (k) { return first[k] === undefined; });
        if (undef.length) bad.push(c.label + ' → 值为 undefined 的键 ' + undef.join(','));
        const nonFinite = findNonFiniteNumbers(first, c.label);
        if (nonFinite.length) bad.push(c.label + ' → ' + nonFinite.join(','));
        if ('date' in first && !isDateLike(first.date)) bad.push(c.label + ' → date 非法 ' + rep(first.date));
        const second = pure.normalizeRecord(c.arg.store, first);
        if (!sameValue(second, first)) bad.push(c.label + ' → 不幂等: ' + rep(first) + ' vs ' + rep(second));
      }
    } finally {
      Date.now = realNow;
    }
    assert.equal(bad.length, 0, bad.slice(0, 4).join(' | '));
  }, 'NUMERIC_OVERFLOW_INFINITY');

  check('normalize* 精确契约（阈值 / 缺键不落 / 非法丢弃）', function () {
    assert.equal(pure.normalizeWeightRecord({ date: '2026-05-01', weightKg: 0 }), null);
    // DATE_SHAPE_ONLY 修复后：日历非法日期与 nutrition.parseDateStr 同口径，一律判非法（不再落库）
    assert.equal(pure.normalizeWeightRecord({ date: '2026-02-31', weightKg: 70 }), null, '2026-02-31 必须判非法');
    assert.equal(pure.normalizeWeightRecord({ date: '2024-02-29', weightKg: 70 }).date, '2024-02-29', '闰年 2-29 仍应合法');
    assert.equal(pure.normalizeWeightRecord({ date: '2026-05-01', weightKg: '70.55' }).weightKg, 70.6);
    assert.equal('bodyFatPct' in pure.normalizeWeightRecord({ date: '2026-05-01', weightKg: 70, bodyFatPct: 'x' }), false);
    assert.equal(pure.normalizeWaterRecord({ date: '2026-05-01', ml: 0 }), null);
    assert.equal(pure.normalizeWaterRecord({ date: '2026-05-01', ml: -5 }), null);
    assert.equal(pure.normalizeMealRecord({ date: '2026-05-01' }).slot, 'snack');
    assert.equal(pure.normalizeMealRecord({ date: '2026-05-01', source: 'ai' }).source, 'ai');
    assert.equal(pure.normalizeMealRecord({ date: '2026-05-01', source: '其它' }).source, 'manual');
    assert.equal(pure.normalizeMealRecord({ date: '2026-05-01', items: 'x' }).items.length, 0);
    assert.equal(pure.normalizeExerciseRecord({ date: '2026-05-01' }).type, '其他');
    assert.equal('intensity' in pure.normalizeExerciseRecord({ date: '2026-05-01', intensity: 'x'.repeat(17) }), false);
    assert.equal(pure.normalizeExerciseRecord({ date: '2026-05-01', intensity: ' fast ' }).intensity, 'fast');
    const item = pure.normalizeMealItem({ name: '米饭', grams: -5, kcal: NaN });
    assert.deepEqual(item, { name: '米饭', grams: 0, kcal: 0, carb: 0, protein: 0, fat: 0 });
    assert.equal('fiber' in pure.normalizeMealItem({ name: 'x', fiber: null }), false);
    assert.equal('fiber' in pure.normalizeMealItem({ name: 'x', fiber: 0 }), true);
    assert.equal(pure.normalizeMealItem(null), null);
    assert.equal(pure.normalizeItems(null).length, 0);
    assert.equal(pure.normalizeRecord('photos', { any: 1 }).any, 1);
    assert.equal(pure.normalizeRecord('photos', 'x'), null);
  });

  check('normalize*：id 只接受真正有限数值（空串 / [] / false 不算 id）', function () {
    const bad = [];
    for (const v of ['', '   ', 'abc', [], {}, false, true, '1e3', ' 7 ', 0, -1, 1.5, '0', null, undefined]) {
      const out = pure.normalizeWeightRecord({ date: '2026-05-01', weightKg: 70, id: v });
      const id = out && ('id' in out ? out.id : undefined);
      if (v === '' || v === '   ' || Array.isArray(v) || v === false) {
        if (id !== undefined) bad.push('id=' + rep(v) + ' 被当成 ' + rep(id));
      }
    }
    assert.equal(bad.length, 0, bad.join(' | '));
  }, 'ID_EMPTY_BECOMES_ZERO');

  /* ---------- 2.5 keyOf / dedupe / planImport ---------- */

  const planCases = [];
  for (let i = 0; i < 50; i += 1) {
    const store = pick(rng, STORES);
    const existing = [];
    const incoming = [];
    for (let j = 0; j < randInt(rng, 4); j += 1) existing.push(randValue(rng, 1));
    for (let j = 0; j < randInt(rng, 4); j += 1) incoming.push(store === 'weights' ? randWeightRec(rng) : store === 'meals' ? randMealRec(rng) : store === 'exercises' ? randExerciseRec(rng) : randWaterRec(rng));
    planCases.push({ label: store + ' rnd' + i, arg: { store, existing, incoming } });
  }
  for (const store of STORES) for (const v of ANY_POOL) planCases.push({ label: store + ' junk(' + rep(v) + ')', arg: { store, existing: v, incoming: v } });
  sweep('planImport：不抛 / 结果干净 / 键唯一 / 不覆盖已有键', planCases, function (arg) {
    const errs = [];
    const out = pure.planImport(arg.store, arg.existing, arg.incoming);
    if (!Array.isArray(out)) return ['返回非数组 ' + rep(out)];
    const keys = out.map(function (r) { return pure.keyOf(arg.store, r); });
    if (new Set(keys).size !== keys.length) errs.push('结果里有重复键: ' + JSON.stringify(keys));
    const existingKeys = new Set((Array.isArray(arg.existing) ? arg.existing : []).map(function (r) { return pure.keyOf(arg.store, r); }));
    for (const k of keys) if (existingKeys.has(k)) errs.push('覆盖了已有键 ' + rep(k));
    for (const row of out) {
      if (!row || typeof row !== 'object') { errs.push('结果含非对象 ' + rep(row)); continue; }
      const again = pure.normalizeRecord(arg.store, row);
      if (!sameValue(again, row)) errs.push('结果不是稳定形: ' + rep(row) + ' vs ' + rep(again));
    }
    for (const k of keys) {
      if (typeof k !== 'string' || k === '') errs.push('keyOf 返回非法键 ' + rep(k));
      else if (k.includes('undefined') || k.includes('[object Object]')) errs.push('keyOf 键里泄漏字面量: ' + rep(k));
    }
    return errs;
  }, 'NUMERIC_OVERFLOW_INFINITY');
  check('keyOf：weights/waters 按日期、有 id 按 id、无 id 走内容指纹', function () {
    assert.equal(pure.keyOf('weights', { date: '2026-05-01', weightKg: 70 }), 'date:2026-05-01');
    assert.equal(pure.keyOf('waters', { date: '2026-05-01', ml: 500 }), 'date:2026-05-01');
    assert.equal(pure.keyOf('meals', { date: '2026-05-01', slot: 'lunch', id: 7, createdAt: 1 }), 'id:7');
    // MEAL_REIMPORT_DOUBLES 修复后指纹是内容摘要（不再带现生成的 createdAt），断言的精确值随之更新
    assert.equal(pure.keyOf('meals', { date: '2026-05-01', slot: 'lunch', createdAt: 1 }), 'fk:2026-05-01:lunch:741638a509dad92d');
    assert.equal(pure.keyOf('meals', { date: '2026-05-01', slot: 'lunch' }), 'fk:2026-05-01:lunch:741638a509dad92d', 'createdAt 不参与 meals 指纹');
    assert.equal(pure.keyOf('exercises', { date: '2026-05-01', type: '跑步', minutes: 30, kcalBurned: 300 }), 'fk:2026-05-01:跑步:30:300');
    assert.equal(pure.keyOf('meals', null), '');
    assert.equal(pure.keyOf('meals', undefined), '');
  });
  check('dedupeByKey / pickNewRows 语义（同键后者覆盖 / 已有键不覆盖）', function () {
    const rows = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }];
    const deduped = pure.dedupeByKey(rows, function (r) { return String(r.id); });
    assert.deepEqual(deduped.slice().sort(function (a, b) { return a.id - b.id; }), [{ id: 1, v: 'c' }, { id: 2, v: 'b' }], '同键后者覆盖前者（顺序按首次插入位置，不是契约内容）');
    assert.equal(deduped.length, 2);
    assert.deepEqual(pure.pickNewRows([{ id: 1 }], [{ id: 1 }, { id: 2 }, { id: 2 }], function (r) { return String(r.id); }), [{ id: 2 }]);
    assert.deepEqual(pure.dedupeByKey(null, function () { return 'x'; }), []);
    assert.deepEqual(pure.pickNewRows(null, null, function () { return 'x'; }), []);
  });

  bug({
    id: 'ID_EMPTY_BECOMES_ZERO',
    name: '空串 / 空数组 id 被归一成 0，导致 keyOf 折叠（导入静默丢行）',
    模块: 'js/pure.js hasId / normalize*Record / keyOf',
    严重度: 'medium',
    复现: [
      "const pure = await import('./js/pure.js');",
      "const rows = [",
      "  { id: '', date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] },",
      "  { id: '', date: '2026-05-01', slot: 'dinner', items: [{ name: '面条', grams: 300, kcal: 330 }] },",
      '];',
      "pure.normalizeMealRecord(rows[0]).id;      // → 0（空串被 Number('') 吃成 0）",
      "pure.planImport('meals', [], rows).length; // → 1（期望 2：午餐被晚餐顶掉）",
    ].join(LF),
    probe: function () {
      const rows = [
        { id: '', date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] },
        { id: '', date: '2026-05-01', slot: 'dinner', items: [{ name: '面条', grams: 300, kcal: 330 }] },
      ];
      const plan = pure.planImport('meals', [], rows);
      return {
        空串id归一化后的id: pure.normalizeMealRecord({ date: '2026-05-01', id: '', items: [] }).id,
        空数组id归一化后的id: pure.normalizeMealRecord({ date: '2026-05-01', id: [], items: [] }).id,
        落库行数: plan.length,
        保留的名字: plan.map(function (r) { return r.items[0].name; }),
      };
    },
    want: {
      空串id归一化后的id: undefined,
      空数组id归一化后的id: undefined,
      落库行数: 2,
      保留的名字: ['米饭', '面条'],
    },
    期望: 'id 键不落（非法 id 不参与去重键），两行都保留',
    判断: 'hasId() 用 Number.isFinite(Number(rec.id)) 判定，Number("") === 0、Number([]) === 0 且都有限，于是空 id 被写成 id:0；keyOf 随之为所有这类记录返回同一个 "id:0"，dedupeByKey 只留最后一条。同一处也影响 exercises（id:0 折叠）。',
    影响面: '导入一份「id 为空串/空数组」的 JSON（手改、第三方导出、老版本数据）时，同一 store 的多条不同记录会被折叠成一条 → 静默丢数据（当天摄入/消耗少算）。正常应用内数据 id 是数字，不受影响。',
  });

  bug({
    id: 'MEAL_REIMPORT_DOUBLES',
    name: '无 id 且无 createdAt 的餐次记录每次重复导入都新增一行（内容指纹不稳定）',
    模块: 'js/pure.js keyOf / normalizeMealRecord / planImport',
    严重度: 'low',
    复现: [
      "const pure = await import('./js/pure.js');",
      "const raw = { date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] };",
      "const first = pure.planImport('meals', [], [raw]);",
      "await new Promise(function (r) { setTimeout(r, 5); });          // 隔一会儿（真实导入间隔）",
      "pure.planImport('meals', first, [raw]).length;                  // → 1（又落一条）；期望 0",
      "// 对照：exercises 的指纹不含 createdAt，重复导入返回 0 行",
    ].join(LF),
    probe: function () {
      const realNow = Date.now;
      let t = 1700000000000;
      Date.now = function () { return t; };
      try {
        const raw = { date: '2026-05-01', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] };
        const first = pure.planImport('meals', [], [raw]);
        t += 60000;
        const second = pure.planImport('meals', first, [raw]);
        t += 60000;
        const third = pure.planImport('meals', first.concat(second), [raw]);
        return [first.map(function (r) { return pure.keyOf('meals', r); }), second.map(function (r) { return pure.keyOf('meals', r); }), third.map(function (r) { return pure.keyOf('meals', r); })];
      } finally {
        Date.now = realNow;
      }
    },
    // 指纹已改为内容摘要（不含现生成的 createdAt），只更新期望里的键字面量，语义仍是「只有第一次导入落一行」
    want: [['fk:2026-05-01:lunch:4ac6e8f07a736c28'], [], []],
    期望: '[[fk:2026-05-01:lunch:4ac6e8f07a736c28], [], []]（只有第一次导入落一行；指纹与 createdAt 无关）',
    判断: 'planImport 先 normalize，normalizeMealRecord 给缺失的 createdAt 填 Date.now()，而 keyOf 的 meals 指纹里带了 createdAt → 每次导入都是新指纹，函数注释承诺的「同一份导出重复导入不会翻倍」在缺 createdAt 时失效。exercises 的指纹不含 createdAt，所以没这个问题（不一致）。',
    影响面: '导入「餐具/手改/第三方」JSON（记录没有 createdAt）时，同一份文件重复导入 N 次 → 当天餐次与热量翻 N 倍。应用自身导出的 JSON 带 createdAt，往返导入不翻倍（已用往返用例验证）。',
  });

  /* ---------- 2.6 套餐模板 ---------- */

  const templateCases = [];
  for (let i = 0; i < 40; i += 1) {
    const kind = pick(rng, ['meal', 'day', undefined, 'x']);
    templateCases.push({
      label: 'rnd' + i,
      arg: {
        id: randValue(rng, 1), name: randValue(rng, 1), kind,
        slot: randValue(rng, 1), items: randValue(rng, 1),
        meals: [randValue(rng, 1), randValue(rng, 1), randValue(rng, 1)],
      },
    });
  }
  for (const v of ANY_POOL) templateCases.push({ label: 'junk(' + rep(v) + ')', arg: v });
  sweep('normalizeMealTemplate(s) 不抛 / 结构稳定 / id 去重', templateCases, function (arg) {
    const errs = [];
    const one = pure.normalizeMealTemplate(arg);
    if (one !== null) {
      if (typeof one.id !== 'string' || one.id === '') errs.push('id 非法 ' + rep(one.id));
      if (typeof one.name !== 'string' || one.name === '') errs.push('name 非法 ' + rep(one.name));
      if (!Array.isArray(one.items) && one.kind !== 'day') errs.push('items 不是数组');
      if (one.kind === 'day' && (!Array.isArray(one.meals) || one.meals.length < 2)) errs.push('day 套餐 meals < 2');
      if (leaksLiteral(one.name)) errs.push('name 泄漏字面量');
    }
    const list = pure.normalizeMealTemplates([arg, arg, arg]);
    if (!Array.isArray(list)) return errs.concat('数组版返回非数组');
    if (list.length > 1) errs.push('重复 id 未去重: ' + list.length + ' 条');
    return errs;
  });
  check('planMealTemplateSave / planDayTemplateSave 语义（同名覆盖 + id 顺延）', function () {
    const a = pure.planMealTemplateSave([], { name: '  午餐  ', slot: 'lunch', items: [{ name: '米饭', grams: 200, kcal: 232 }] }, 1000);
    assert.equal(a.template.name, '午餐');
    assert.equal(a.template.id, '1000');
    assert.equal(a.template.kind, 'meal');
    const b = pure.planMealTemplateSave(a.templates, { name: '午餐', slot: 'dinner', items: [] }, 1000);
    assert.equal(b.templates.length, 1, '同名套餐应覆盖而不是新增');
    assert.equal(b.template.id, '1000', '同名覆盖要保留原 id');
    assert.equal(b.template.slot, 'dinner');
    const c = pure.planMealTemplateSave(b.templates, { name: '新套餐', slot: 'x', items: [] }, 1000);
    assert.equal(c.template.id, '1001', '同毫秒新建应顺延 id 而不是顶掉前一个');
    assert.equal(c.template.slot, 'snack', '非法 slot 应回退 snack');
    const day = pure.planDayTemplateSave([], { name: '一天', meals: [{ slot: 'breakfast', items: [{ name: '鸡蛋', grams: 50, kcal: 72 }] }, { slot: '午餐', items: [{ name: '米饭', grams: 200, kcal: 232 }] }] }, 5);
    assert.equal(day.template.kind, 'day');
    assert.equal(day.template.meals.length, 2);
    assert.equal(day.template.meals[1].slot, 'snack', '整日套餐里的非法 slot 应回退 snack');
    assert.throws(function () { pure.planMealTemplateSave([], { name: '  ', items: [] }); }, /套餐名称不能为空/);
    assert.throws(function () { pure.planDayTemplateSave([], { name: 'x', meals: [] }); }, /至少/);
    assert.throws(function () { pure.planDayTemplateSave([], { name: 'x', meals: [{ slot: 'lunch', items: [] }] }); }, /至少/);
    const over = pure.planMealTemplateSave([{ id: '1', name: '一天', kind: 'day', meals: [{ slot: 'lunch', items: [{ name: 'x', grams: 1, kcal: 1 }] }, { slot: 'dinner', items: [{ name: 'y', grams: 1, kcal: 1 }] }] }], { name: '一天', slot: 'lunch', items: [{ name: 'z', grams: 1, kcal: 1 }] }, 9);
    assert.equal('meals' in over.template, false, '同名整日套餐被单餐覆盖后不能残留 meals 键');
    assert.deepEqual(pure.removeMealTemplate(a.templates, '1000'), []);
    assert.deepEqual(pure.removeMealTemplate(null, 'x'), []);
  });

  /* ---------- 2.7 最近吃过 / 导出天数 / 其它聚合 ---------- */

  const recentCases = [];
  for (let i = 0; i < 40; i += 1) {
    const meals = [];
    for (let j = 0; j < randInt(rng, 5); j += 1) meals.push(randMealRec(rng));
    recentCases.push({ label: 'rnd' + i, arg: { meals, limit: pick(rng, [0, 1, 3, 8, 12, -1, 2.9, 1e6, Infinity, NaN, null, 'x', undefined, {}]) } });
  }
  for (const v of ANY_POOL) recentCases.push({ label: 'junk(' + rep(v) + ')', arg: { meals: v, limit: v } });
  sweep('collectRecentFoodItems 结构 / 名字去重 / 上限', recentCases, function (arg) {
    const errs = [];
    const out = pure.collectRecentFoodItems(arg.meals, arg.limit);
    if (!Array.isArray(out)) return ['返回非数组'];
    const names = out.map(function (r) { return r.name; });
    if (new Set(names).size !== names.length) errs.push('名字未去重: ' + JSON.stringify(names));
    for (const row of out) {
      if (typeof row.name !== 'string' || row.name === '') errs.push('name 非法 ' + rep(row.name));
      if (typeof row.lastDate !== 'string') errs.push('lastDate 非字符串 ' + rep(row.lastDate));
      if (!row.item || typeof row.item !== 'object') errs.push('item 非对象');
      if (['breakfast', 'lunch', 'dinner', 'snack'].indexOf(row.slot) < 0) errs.push('slot 越界 ' + rep(row.slot));
    }
    const max = Math.max(0, Math.floor(Number(arg.limit)));
    if (Number.isFinite(max) && max >= 0 && out.length > max) errs.push('超过 limit ' + max + ': ' + out.length);
    return errs;
  });
  check('collectRecentFoodItems：date 降序 + 同日 createdAt 降序 + limit 在去重后生效', function () {
    const meals = [
      { date: '2026-05-01', slot: 'lunch', createdAt: 1, items: [{ name: '米饭' }] },
      { date: '2026-05-02', slot: 'dinner', createdAt: 2, items: [{ name: '面条' }, { name: '米饭' }] },
      { date: '2026-05-02', slot: 'breakfast', createdAt: 9, items: [{ name: '鸡蛋' }] },
    ];
    assert.deepEqual(pure.collectRecentFoodItems(meals, 12).map(function (r) { return r.name; }), ['鸡蛋', '面条', '米饭']);
    assert.equal(pure.collectRecentFoodItems(meals, 2).length, 2);
    assert.deepEqual(pure.collectRecentFoodItems(meals, 0), []);
    assert.deepEqual(pure.collectRecentFoodItems([{ date: '2026-05-01', items: [{ name: '  ' }] }], 5), []);
    assert.equal(pure.collectRecentFoodItems(meals, 12)[2].lastDate, '2026-05-02', '去重应保留最新一次出现的信息（米饭最新出现在 05-02 晚餐）');
    assert.equal(pure.collectRecentFoodItems(meals, 12)[2].slot, 'dinner');
  });

  sweep('daysSinceExport / burnedOf / waterOf / aggregateMeals 只出安全值', cases1(ANY_POOL, 'v'), function (v) {
    const errs = [];
    const days = pure.daysSinceExport(v);
    if (days !== null && (!finite(days) || days < 0 || Math.round(days) !== days)) errs.push('daysSinceExport = ' + rep(days));
    const burned = pure.burnedOf(v);
    if (!finite(burned) || burned < 0) errs.push('burnedOf = ' + rep(burned));
    const water = pure.waterOf(v);
    if (!finite(water) || water < 0) errs.push('waterOf = ' + rep(water));
    const agg = pure.aggregateMeals(v);
    for (const k of Object.keys(agg)) if (!finite(agg[k])) errs.push('aggregateMeals.' + k + ' = ' + rep(agg[k]));
    return errs;
  });
  check('daysSinceExport 契约（今天 → 0 / 未来 → 0 / 非法 → null）', function () {
    assert.equal(pure.daysSinceExport(Date.now()), 0);
    assert.equal(pure.daysSinceExport(Date.now() + 86400000 * 3), 0);
    assert.equal(pure.daysSinceExport(0), null);
    assert.equal(pure.daysSinceExport(-1), null);
    assert.equal(pure.daysSinceExport('x'), null);
    assert.equal(pure.daysSinceExport(1e308), null);
    assert.equal(typeof pure.daysSinceExport(Date.now() - 86400000 * 2), 'number');
  });

  /* ============================================================
   * 3. js/foods.js（检索 / 名称归一 / 份量单位 / 校准）+ views/food.js::mergeToDish
   * ============================================================ */

  const notes = {};

  check('FOODS 数据自洽（id/name 唯一非空、per100g 有限）', function () {
    const bad = [];
    const ids = new Set();
    const names = new Set();
    let withoutUnits = 0;
    for (const f of foods.FOODS) {
      if (!f || typeof f !== 'object') { bad.push('非对象条目'); continue; }
      if (typeof f.id !== 'string' || !f.id) bad.push('id 非法: ' + rep(f.id));
      else if (ids.has(f.id)) bad.push('id 重复: ' + f.id);
      else ids.add(f.id);
      if (typeof f.name !== 'string' || !f.name) bad.push('name 非法: ' + rep(f.name));
      else if (names.has(f.name)) bad.push('name 重复: ' + f.name);
      else names.add(f.name);
      if (f.aliases !== undefined && !Array.isArray(f.aliases)) bad.push(f.name + ' aliases 非数组');
      const p = f.per100g || {};
      for (const k of ['kcal', 'carb', 'protein', 'fat']) if (!finite(p[k]) || p[k] < 0) bad.push(f.name + ' per100g.' + k + ' = ' + rep(p[k]));
      const units = foods.foodUnits(f);
      if (!units.length) withoutUnits += 1;
      for (const u of units) {
        if (typeof u.name !== 'string' || !u.name.trim()) bad.push(f.name + ' 单位名非法');
        if (!finite(u.grams) || u.grams <= 0) bad.push(f.name + ' 单位克数非法: ' + rep(u.grams));
      }
    }
    notes.foodsTotal = foods.FOODS.length;
    notes.foodsWithoutUnits = withoutUnits;
    assert.equal(bad.length, 0, bad.slice(0, 5).join(' | '));
  });

  check('searchFoods：空查询给热门、库内每条名称都能召回自身', function () {
    const hot = foods.searchFoods('', 10);
    assert.equal(Array.isArray(hot), true);
    assert.ok(hot.length > 0, '空查询应给热门食物');
    const missing = [];
    for (const f of foods.FOODS) {
      cases += 1;
      const hits = foods.searchFoods(f.name, 8);
      if (!Array.isArray(hits) || !hits.some(function (h) { return h && h.id === f.id; })) missing.push(f.name);
    }
    assert.equal(missing.length, 0, '这些库内名称搜不到自己: ' + missing.slice(0, 5).join(','));
  });

  const searchCases = [];
  for (let i = 0; i < 60; i += 1) searchCases.push({ label: 'rnd' + i, arg: [randString(rng, 10), pick(rng, [0, 1, 5, 20, 200, 1e9, -3, 3.7, NaN, Infinity, '5', null, '', undefined, {}])] });
  for (const v of ANY_POOL) searchCases.push({ label: 'q(' + rep(v) + ')', arg: [v, 20] });
  sweep('searchFoods(query,limit) 不抛 / 结果属于 FOODS / 上限生效', searchCases, function (arg) {
    const errs = [];
    const out = foods.searchFoods(arg[0], arg[1]);
    if (!Array.isArray(out)) return ['返回非数组 ' + rep(out)];
    const ids = out.map(function (f) { return f && f.id; });
    if (new Set(ids).size !== ids.length) errs.push('结果有重复条目: ' + JSON.stringify(ids));
    for (const f of out) if (foods.FOODS.indexOf(f) < 0) errs.push('结果含库外条目 ' + rep(f));
    const max = Math.max(0, Number(arg[1]) || 0);
    if (Number.isFinite(max) && out.length > max) errs.push('超过 limit ' + max + ': ' + out.length);
    return errs;
  });
  check('searchFoods 排序契约（精确命中在前 / 菜品优先于原料）', function () {
    assert.equal(foods.searchFoods('米饭', 5)[0].name, '米饭');
    assert.equal(foods.searchFoods('米饭', 5)[0].kind, 'dish');
    const noodleHits = foods.searchFoods('面', 10);
    assert.ok(noodleHits.length > 0);
    assert.equal(noodleHits.filter(function (f) { return f.kind === 'dish'; }).length > 0, true);
    assert.deepEqual(foods.searchFoods('🍚🍚', 5), []);
    assert.equal(foods.searchFoods('米饭', 1).length, 1);
  });

  const findCases = [];
  for (let i = 0; i < 60; i += 1) findCases.push({ label: 'rnd' + i, arg: randString(rng, 8) });
  for (const v of ANY_POOL) findCases.push({ label: 'name(' + rep(v) + ')', arg: v });
  findCases.push({ label: 'emem 1e5', arg: '米'.repeat(100000) });
  sweep('findFood(name) 不抛 / 只返回 null 或库内条目', findCases, function (v) {
    const out = foods.findFood(v);
    if (out === null || out === undefined) return [];
    if (typeof out !== 'object') return ['返回非对象 ' + rep(out)];
    if (foods.FOODS.indexOf(out) < 0) return ['返回库外条目 ' + rep(out)];
    return [];
  });
  sweep('findFood(name,{kind}) 提示不影响合法性', cases1(ANY_POOL, 'hint'), function (v) {
    for (const kind of ['dish', 'ingredient', 'x', null, 3]) {
      const out = foods.findFood(v, { kind });
      if (out !== null && out !== undefined && foods.FOODS.indexOf(out) < 0) return ['kind=' + rep(kind) + ' 返回库外条目'];
    }
    return [];
  });
  check('findFood：库内 name 与 aliases 都能解析（菜名优先于原料）', function () {
    const bad = [];
    for (const f of foods.FOODS) {
      cases += 1;
      const self = foods.findFood(f.name);
      if (!self || self.id !== f.id) bad.push(f.name + ' → ' + (self ? self.name : 'null'));
      for (const alias of f.aliases || []) {
        const hit = foods.findFood(alias);
        if (!hit) bad.push('别名 ' + alias + ' 解析为 null');
      }
    }
    assert.equal(bad.length, 0, bad.slice(0, 5).join(' | '));
    assert.equal(foods.findFood(''), null);
    assert.equal(foods.findFood('一份红烧茄子').name, '红烧茄子');
    const shredded = foods.findFood('土豆丝');
    assert.ok(shredded && shredded.name.indexOf('土豆丝') >= 0, '「土豆丝」应命中名字含土豆丝的条目，实际 ' + (shredded && shredded.name));
    assert.equal(shredded.kind, 'dish', '命中菜名而非原料');
  });

  sweep('normalizeName / stripQuantity / stripModifiers 只出字符串且幂等', cases1(ANY_POOL, 'v'), function (v) {
    const errs = [];
    const a = foods.normalizeName(v);
    if (typeof a !== 'string') errs.push('normalizeName 非字符串 ' + rep(a));
    if (foods.normalizeName(a) !== a) errs.push('normalizeName 不幂等: ' + rep(a));
    const b = foods.stripQuantity(v);
    if (typeof b !== 'string') errs.push('stripQuantity 非字符串 ' + rep(b));
    const c = foods.stripModifiers(v);
    if (typeof c !== 'string') errs.push('stripModifiers 非字符串 ' + rep(c));
    if (foods.stripModifiers(c) !== c) errs.push('stripModifiers 不幂等: ' + rep(c));
    if (typeof v === 'string' && v.trim() !== '' && b === '' && c === '') errs.push('非空字符串被清成空串');
    return errs;
  });
  check('normalizeName 精确契约（去括号注释 / 去空格标点 / 小写）', function () {
    assert.equal(foods.normalizeName('红烧肉（小份）'), '红烧肉');
    assert.equal(foods.normalizeName(' 米饭  1 碗 '), '米饭1碗');
    assert.equal(foods.normalizeName('A B-C_D'), 'abcd');
    assert.equal(foods.normalizeName(null), '');
    assert.equal(foods.normalizeName({}), '[objectobject]');
    assert.equal(foods.stripQuantity('米饭 200g'), '米饭');
    assert.equal(foods.stripQuantity('米饭 一碗'), '米饭');
    assert.equal(foods.stripQuantity('200g'), '200g');
    assert.equal(foods.stripModifiers('一份红烧茄子'), '红烧茄子');
    assert.equal(foods.stripModifiers('家常豆腐'), '豆腐');
    assert.equal(foods.stripModifiers('一份'), '一份');
  });

  sweep('foodUnits 只出干净单位 / 不改入参 / 不共享引用', cases1(ANY_POOL, 'food'), function (v) {
    const errs = [];
    const src = v && typeof v === 'object' ? v : null;
    const before = src ? JSON.stringify(src) : null;
    const out = foods.foodUnits(v);
    if (!Array.isArray(out)) return ['返回非数组'];
    for (const u of out) {
      if (!u || typeof u !== 'object') { errs.push('单位非对象 ' + rep(u)); continue; }
      if (typeof u.name !== 'string' || !u.name.trim()) errs.push('单位名非法 ' + rep(u.name));
      if (!finite(u.grams) || u.grams <= 0) errs.push('单位克数非法 ' + rep(u.grams));
    }
    if (src && JSON.stringify(src) !== before) errs.push('入参被改动');
    if (out.length && src && src.units && out[0] === src.units[0]) errs.push('返回了入参对象本身（调用方一改就污染库数据）');
    return errs;
  });
  check('foodUnits 精确契约（脏单位丢弃 / 空板回退 unit）', function () {
    assert.deepEqual(foods.foodUnits({ units: [{ name: '1 碗', grams: 200 }, { name: '', grams: 10 }, { name: 'x', grams: 0 }, { name: 'y', grams: NaN }, null] }), [{ name: '1 碗', grams: 200 }]);
    assert.deepEqual(foods.foodUnits({ unit: { name: '1 个', grams: 50 } }), [{ name: '1 个', grams: 50 }]);
    assert.deepEqual(foods.foodUnits({ units: [], unit: { name: '1 个', grams: 50 } }), [{ name: '1 个', grams: 50 }]);
    assert.deepEqual(foods.foodUnits(null), []);
    assert.deepEqual(foods.foodUnits({}), []);
  });

  const calibCases = [];
  for (let i = 0; i < 70; i += 1) {
    const n = randInt(rng, 4);
    const arr = [];
    for (let j = 0; j < n; j += 1) {
      if (rng() < 0.2) { arr.push(randValue(rng, 1)); continue; }
      arr.push({
        name: pick(rng, ['米饭', '菠菜炒鸡蛋', '土豆丝', randString(rng, 6), '', null, 5, '  鸡蛋  ']),
        grams: randValue(rng, 1), kcal: randValue(rng, 1), carb: randValue(rng, 1), protein: randValue(rng, 1),
        fat: randValue(rng, 1), fiber: randValue(rng, 1), sodium: randValue(rng, 1),
        confidence: randValue(rng, 1), kind: pick(rng, ['dish', 'ingredient', 'x', undefined]),
      });
    }
    calibCases.push({ label: 'rnd' + i, arg: arr });
  }
  for (const v of [null, undefined, [], [null], ['x'], [5], {}, 0]) calibCases.push({ label: 'junk(' + rep(v) + ')', arg: v });
  sweep('calibrateItems 输出结构 / 库值一致 / 只抛契约异常', calibCases, function (arg) {
    const errs = [];
    let out;
    try {
      out = foods.calibrateItems(arg);
    } catch (e) {
      if (e && typeof e.message === 'string' && e.message.indexOf('没识别出食物') >= 0) return [];
      return ['抛出非契约异常 ' + (e && e.name) + ': ' + (e && e.message)];
    }
    if (!Array.isArray(out) || out.length === 0) return ['返回空/非数组 ' + rep(out)];
    for (const item of out) {
      if (typeof item.name !== 'string' || item.name === '') errs.push('name 非法 ' + rep(item.name));
      if (!finite(item.grams) || item.grams <= 0 || item.grams > 500) errs.push('grams 越界 ' + rep(item.grams));
      for (const k of ['kcal', 'carb', 'protein', 'fat']) if (!finite(item[k]) || item[k] < 0) errs.push(k + ' 非法 ' + rep(item[k]));
      for (const k of ['fiber', 'sodium']) if (k in item && (!finite(item[k]) || item[k] < 0)) errs.push(k + ' 非法 ' + rep(item[k]));
      if ('confidence' in item && ['high', 'medium', 'low'].indexOf(item.confidence) < 0) errs.push('confidence 越界 ' + rep(item.confidence));
      if ('kind' in item && ['dish', 'ingredient'].indexOf(item.kind) < 0) errs.push('kind 越界 ' + rep(item.kind));
      if (item.foodId) {
        const f = foods.FOODS.find(function (x) { return x.id === item.foodId; });
        if (!f) errs.push('foodId 不在库内 ' + item.foodId);
        else if (Math.abs(item.kcal - Math.round(f.per100g.kcal * item.grams / 100)) > 1) errs.push('kcal 与库值不符: ' + item.kcal + ' vs ' + (f.per100g.kcal * item.grams / 100));
      }
    }
    return errs;
  });
  check('calibrateItems 精确契约（克数兜底 / 置信度映射 / 无库命中时反算）', function () {
    const rice = foods.calibrateItems([{ name: '米饭', grams: 200 }])[0];
    assert.equal(rice.kcal, 232);
    assert.equal(rice.foodId, 'rice');
    assert.equal(rice.kind, 'dish');
    const bad = foods.calibrateItems([{ name: '不存在的东西', grams: 0 }])[0];
    assert.equal(bad.grams, 50);
    assert.equal(bad.confidence, 'low');
    assert.equal(foods.calibrateItems([{ name: '不存在的东西', grams: 5000 }])[0].grams, 500);
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, confidence: 0.9 }])[0].confidence, 'high');
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, confidence: 0.6 }])[0].confidence, 'medium');
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, confidence: '高' }])[0].confidence, 'high');
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, confidence: '?' }])[0].confidence, undefined);
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, carb: 10, protein: 10, fat: 10 }])[0].kcal, 170);
    assert.equal(foods.calibrateItems([{ name: 'x', grams: 100, kcal: 400 }])[0].carb, 50);
    assert.throws(function () { foods.calibrateItems([]); }, /没识别出食物/);
    assert.throws(function () { foods.calibrateItems([null]); }, /没识别出食物/);
    assert.throws(function () { foods.calibrateItems([null]); }, /没识别出食物/);
  });

  const mergeCases = [];
  for (let i = 0; i < 40; i += 1) {
    mergeCases.push({
      label: 'rnd' + i,
      arg: {
        items: [{ name: randString(rng, 6), grams: pick(rng, [0, 50, 200]), kcal: pick(rng, [0, 72, 232]) }, { name: '菠菜', grams: 100, kcal: 28 }],
        food: rng() < 0.3 ? null : pick(rng, foods.FOODS),
        grams: pick(rng, [0, -1, 0.4, 1, 100, 2000, 5000, NaN, Infinity, -Infinity, 'abc', null, undefined, {}]),
      },
    });
  }
  sweep('mergeToDish 结构性契约（数组 / 克数夹紧 / 数值有限）', mergeCases, function (arg) {
    const errs = [];
    const out = foodView.mergeToDish(arg.items, arg.food, arg.grams);
    if (!Array.isArray(out)) return ['返回非数组 ' + rep(out)];
    if (!arg.food) {
      if (out.length !== arg.items.length) errs.push('无 food 时应原样复制，长度 ' + out.length + ' ≠ ' + arg.items.length);
      for (let i = 0; i < out.length; i += 1) {
        if (out[i] === arg.items[i]) errs.push('第 ' + i + ' 项是同一个对象引用（应为副本）');
        if (!sameValue(out[i], arg.items[i])) errs.push('第 ' + i + ' 项内容变了: ' + rep(out[i]) + ' ≠ ' + rep(arg.items[i]));
      }
      return errs;
    }
    if (out.length !== 1) errs.push('有 food 时应只剩 1 项，实际 ' + out.length);
    const item = out[0];
    if (!item || typeof item !== 'object') return errs.concat('条目非对象');
    if (!finite(item.grams) || item.grams < 1 || item.grams > 2000) errs.push('grams 未夹紧到 [1,2000]: ' + rep(item.grams));
    for (const k of ['kcal', 'carb', 'protein', 'fat']) if (!finite(item[k]) || item[k] < 0) errs.push(k + ' 非法 ' + rep(item[k]));
    if (item.foodId !== arg.food.id) errs.push('foodId 不是被合并的食物: ' + rep(item.foodId));
    return errs;
  });
  check('mergeToDish 精确契约（走 nutrition.scaleFood / 无单位默认 200g / 缺 food 复制清单）', function () {
    const dish = { id: 'test-dish', name: '菠菜炒鸡蛋', kind: 'dish', per100g: { kcal: 90, carb: 3, protein: 7, fat: 6, fiber: 1, sodium: 10 }, unit: { name: '1 盘', grams: 300 } };
    const merged = foodView.mergeToDish([{ name: '鸡蛋', grams: 50, kcal: 72 }], dish);
    const expected = nutrition.scaleFood(dish.per100g, 300);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].grams, 300);
    assert.equal(merged[0].kcal, expected.kcal);
    assert.equal(merged[0].carb, expected.carb);
    assert.equal(merged[0].sodium, expected.sodium);
    assert.equal(foodView.mergeToDish([{ name: '鸡蛋' }], { id: 'x', name: '无单位菜', kind: 'dish', per100g: {} })[0].grams, 200);
    assert.equal(foodView.mergeToDish([{ name: '鸡蛋' }], { id: 'x', name: '原料', per100g: {} })[0].grams, 200, '无单位食物也走默认 200g');
    const copied = foodView.mergeToDish([{ name: '鸡蛋', grams: 50, kcal: 72 }], null);
    assert.equal(copied.length, 1);
    assert.notEqual(copied[0], undefined);
    assert.deepEqual(copied, [{ name: '鸡蛋', grams: 50, kcal: 72 }]);
    assert.deepEqual(foodView.mergeToDish(), []);
    assert.deepEqual(foodView.mergeToDish('x', null, 100), []);
    assert.equal(foodView.defaultDishGrams({ units: [{ name: '1 盘', grams: 300 }] }), 300);
    assert.equal(foodView.defaultDishGrams({ unit: { name: '1 个', grams: 80 } }), 80);
    assert.equal(foodView.defaultDishGrams({}), 200);
    assert.deepEqual(foodView.unitsOf({ unit: { name: '1 个', grams: 0 } }), [], '克数 <= 0 的单位应被丢掉');
    assert.equal(foodView.unitHintFor(295, [{ name: '1 盘', grams: 300 }]), '≈1 盘');
    assert.equal(foodView.unitHintFor(100, [{ name: '1 盘', grams: 300 }]), '');
  });

  bug({
    id: 'MERGEDISH_NAMELESS_ITEM',
    name: 'mergeToDish 对缺 name 的食物产出 name=undefined 的条目',
    模块: 'views/food.js mergeToDish / scaleFood',
    严重度: 'low',
    复现: [
      "const foodView = await import('../views/food.js');",
      "const item = foodView.mergeToDish([{ name: '鸡蛋', grams: 50, kcal: 72 }], { id: 'x', per100g: { kcal: 100 } }, 100)[0];",
      'item.name;      // → undefined',
      "'name in item'  // → true（键存在但值 undefined，渲染层会显示 undefined）",
    ].join(LF),
    probe: function () {
      const item = foodView.mergeToDish([{ name: '鸡蛋' }], { id: 'x', per100g: { kcal: 100, carb: 1, protein: 1, fat: 1 } }, 100)[0];
      return { name: item.name, 有name键: 'name' in item, 其余键: Object.keys(item).sort() };
    },
    want: { name: '', 有name键: true, 其余键: ['carb', 'fat', 'foodId', 'grams', 'kcal', 'name', 'protein'] },
    期望: "name 应是字符串（缺名时用 '' 兜底），不该是 undefined",
    判断: 'scaleFood 直接写 name: food.name，food 缺 name 时该字段就是 undefined；UI 渲染 item.name 会显示 undefined 字面量。契约上 mergeToDish 已经用 if (!food) 兜了「没食物」，但没兜「食物缺名字」。',
    影响面: '生产路径的 food 都来自 searchFoods（库内条目必有 name），所以当前不可达；属于导出 API 的健壮性缺口（若以后有调用方传自定义食物就会漏到界面上）。',
  });

  /* ============================================================
   * 4. js/sync.js
   * ============================================================ */

  const checksumCases = [];
  for (let i = 0; i < 80; i += 1) checksumCases.push({ label: 'rnd' + i, arg: randValue(rng, 2) });
  for (const v of ANY_POOL) checksumCases.push({ label: 'junk(' + rep(v) + ')', arg: v });
  checksumCases.push({ label: 'bigint', arg: 1n });
  checksumCases.push({ label: 'function', arg: function () {} });
  checksumCases.push({ label: 'symbol', arg: Symbol('x') });
  sweep('checksum 总是 8 位十六进制小写 / 不抛', checksumCases, function (v) {
    const out = sync.checksum(v);
    if (typeof out !== 'string') return ['返回非字符串 ' + rep(out)];
    if (!(out.length === 8 && out.toLowerCase() === out && Array.prototype.every.call(out, function (c) { return '0123456789abcdef'.indexOf(c) >= 0; }))) return ['不是 8 位小写 hex: ' + rep(out)];
    return [];
  });
  check('checksum 稳定性（键序无关 / JSON 往返一致 / 循环与深嵌套走兜底）', function () {
    assert.equal(sync.checksum({ a: 1, b: [2, { c: 3 }] }), sync.checksum({ b: [2, { c: 3 }], a: 1 }));
    const deep = JSON.parse('{"a":[1,2,{"b":null,"c":"中"}],"d":{"e":[true,false]}}');
    assert.equal(sync.checksum(deep), sync.checksum(JSON.parse(JSON.stringify(deep))));
    const cyc = {};
    cyc.self = cyc;
    assert.equal(sync.checksum(cyc), '00000000');
    assert.equal(sync.checksum(1n), '00000000');
    let nested = {};
    let cur = nested;
    for (let i = 0; i < 20000; i += 1) { cur.n = {}; cur = cur.n; }
    assert.equal(sync.checksum(nested).length, 8, '2 万层嵌套还没到栈上限，应正常算出校验和');
    let deeper = {};
    let cur2 = deeper;
    for (let i = 0; i < 200000; i += 1) { cur2.n = {}; cur2 = cur2.n; }
    assert.equal(sync.checksum(deeper), '00000000', '20 万层嵌套应走序列化失败兜底，绝不抛');
    const twice = { o: {} };
    twice.a = twice.o;
    twice.b = twice.o;
    assert.notEqual(sync.checksum(twice), '00000000', '同对象出现在兄弟位置不是循环引用，不该走兜底');
    assert.equal(sync.checksum(undefined), '00000000', 'undefined 本身就进不了 JSON，走兜底');
    assert.equal(sync.checksum(null).length, 8, 'null 是可序列化值（"null"），不是兜底');
  });
  check('checksum 对内容变化敏感（5000 个单点改动互不碰撞）', function () {
    const seen = new Map();
    const bad = [];
    for (let i = 0; i < 5000; i += 1) {
      const sum = sync.checksum({ app: 'hms', weights: [{ date: '2026-05-01', weightKg: 70 + i / 10 }] });
      if (seen.has(sum)) bad.push(seen.get(sum) + ' 与 ' + i + ' 撞车 → ' + sum);
      else seen.set(sum, i);
    }
    assert.equal(bad.length, 0, bad.slice(0, 3).join(' | '));
  });

  const stripCases = [];
  for (let i = 0; i < 60; i += 1) {
    stripCases.push({
      label: 'rnd' + i,
      arg: { app: 'hms', settings: { apiKey: 'SECRET-' + i, model: 'm' }, meta: { settings: { apiKey: 'SECRET-META-' + i } }, weights: randValue(rng, 1) },
    });
  }
  for (const v of ANY_POOL) stripCases.push({ label: 'junk(' + rep(v) + ')', arg: v });
  sweep('stripSyncSecrets：深拷贝 / 密钥不落序列化 / 不动入参', stripCases, function (v) {
    const errs = [];
    const before = JSON.stringify(v && typeof v === 'object' ? v : null);
    const out = sync.stripSyncSecrets(v);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return ['返回非对象 ' + rep(out)];
    const text = JSON.stringify(out);
    if (text.includes('SECRET-')) errs.push('密钥泄漏到序列化结果里');
    if (v && typeof v === 'object' && JSON.stringify(v) !== before) errs.push('入参被改动（应只改副本）');
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const second = sync.stripSyncSecrets(out);
      if (!sameValue(second, out)) errs.push('不幂等: ' + rep(out) + ' vs ' + rep(second));
    }
    return errs;
  });
  check('stripSyncSecrets 精确契约（两处容器都清 / 非对象给 {} / 嵌套密钥边界）', function () {
    const out = sync.stripSyncSecrets({ settings: { apiKey: 'S1', model: 'm' }, meta: { settings: { apiKey: 'S2', unit: 'kg' } } });
    assert.deepEqual(out, { settings: { model: 'm' }, meta: { settings: { unit: 'kg' } } });
    const src = { settings: { apiKey: 'S' } };
    sync.stripSyncSecrets(src);
    assert.equal(src.settings.apiKey, 'S', '入参被就地删除');
    assert.deepEqual(sync.stripSyncSecrets(null), {});
    assert.deepEqual(sync.stripSyncSecrets([]), {});
    assert.deepEqual(sync.stripSyncSecrets('x'), {});
    const frozen = Object.freeze({ settings: Object.freeze({ apiKey: 'S', model: 'm' }) });
    assert.deepEqual(sync.stripSyncSecrets(frozen), { settings: { model: 'm' } }, '冻结对象不该抛');
    assert.equal('apiKey' in sync.stripSyncSecrets({ settings: Object.create(null) }).settings, false);
  });

  const mergeCases2 = [];
  for (let i = 0; i < 60; i += 1) {
    const localKey = rng() < 0.7 ? 'LOCAL-' + i : undefined;
    mergeCases2.push({
      label: 'rnd' + i,
      arg: {
        remote: { settings: rng() < 0.5 ? { apiKey: 'REMOTE', model: 'm' } : {}, meta: { settings: { apiKey: 'REMOTE' } }, weights: randValue(rng, 1) },
        local: localKey === undefined ? { settings: {}, meta: {} } : { settings: { apiKey: localKey, model: 'loc', weightUnit: 'jin' }, meta: { settings: { apiKey: localKey } } },
      },
    });
  }
  for (const v of ANY_POOL) mergeCases2.push({ label: 'junk(' + rep(v) + ')', arg: { remote: v, local: v } });
  mergeCases2.push({ label: 'remote=undefined', arg: { remote: undefined, local: { settings: { apiKey: 'L' } } } });
  mergeCases2.push({ label: 'local=undefined', arg: { remote: { settings: { apiKey: 'R' } }, local: undefined } });
  sweep('mergeRemoteIntoLocal：本机 apiKey 必在 / 结果干净 / 不动入参', mergeCases2, function (arg) {
    const errs = [];
    const beforeRemote = JSON.stringify(arg.remote === undefined ? null : arg.remote);
    const beforeLocal = JSON.stringify(arg.local === undefined ? null : arg.local);
    const out = sync.mergeRemoteIntoLocal(arg);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return ['返回非对象 ' + rep(out)];
    const localKey = arg.local && arg.local.settings && typeof arg.local.settings.apiKey === 'string' ? arg.local.settings.apiKey : null;
    const gotKey = out.settings && out.settings.apiKey;
    if (localKey && gotKey !== localKey) errs.push('本机 apiKey 丢了: ' + rep(gotKey) + ' ≠ ' + rep(localKey));
    if (!localKey && out.settings && 'apiKey' in out.settings) errs.push('本机没有密钥时不该保留远端密钥: ' + rep(out.settings.apiKey));
    if (JSON.stringify(arg.remote === undefined ? null : arg.remote) !== beforeRemote) errs.push('入参 remote 被改动');
    if (JSON.stringify(arg.local === undefined ? null : arg.local) !== beforeLocal) errs.push('入参 local 被改动');
    return errs;
  });
  check('mergeRemoteIntoLocal 精确契约（远端没表态 → 整份沿用本机设置）', function () {
    const local = { settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' }, meta: { settings: { apiKey: 'L', model: 'qwen3-vl-plus' } } };
    const emptyRemote = sync.mergeRemoteIntoLocal({ remote: { settings: {}, meta: { settings: {} } }, local });
    assert.equal(emptyRemote.settings.model, 'qwen3-vl-plus');
    assert.equal(emptyRemote.settings.weightUnit, 'jin');
    assert.equal(emptyRemote.meta.settings.model, 'qwen3-vl-plus');
    const missingRemote = sync.mergeRemoteIntoLocal({ remote: { weights: [] }, local });
    assert.equal(missingRemote.settings.model, 'qwen3-vl-plus');
    assert.deepEqual(sync.mergeRemoteIntoLocal(), {});
    assert.deepEqual(sync.mergeRemoteIntoLocal({ remote: [] }), {});
    assert.deepEqual(sync.mergeRemoteIntoLocal({ remote: { settings: { apiKey: 'R' } } }), { settings: {} }, '本机没有密钥时远端密钥应被删掉');
  });

  bug({
    id: 'MERGE_DROPS_LOCAL_SETTINGS',
    name: '远端 settings 只含密钥时，本机设置（model/weightUnit/baseUrl）被空的 settings 覆盖',
    模块: 'js/sync.js mergeRemoteIntoLocal',
    严重度: 'medium',
    复现: [
      "const sync = await import('./js/sync.js');",
      "const local = { settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' }, meta: { settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' } } };",
      "// 老版本客户端把密钥一起传上去了（函数注释里明确要防这种快照）",
      "const remote = { settings: { apiKey: 'R' }, meta: { settings: { apiKey: 'R' } } };",
      'sync.mergeRemoteIntoLocal({ remote, local });',
      "// → { settings: { apiKey: 'L' }, meta: { settings: { apiKey: 'L' } } }：model/weightUnit 全没了",
    ].join(LF),
    probe: function () {
      const local = { settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' }, meta: { settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' } } };
      const remote = { settings: { apiKey: 'R' }, meta: { settings: { apiKey: 'R' } } };
      const out = sync.mergeRemoteIntoLocal({ remote, local });
      return { settings: out.settings, metaSettings: out.meta.settings };
    },
    want: {
      settings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' },
      metaSettings: { apiKey: 'L', model: 'qwen3-vl-plus', weightUnit: 'jin' },
    },
    期望: '远端这个容器剥掉密钥后是空的（等于没表态）→ 整份沿用本机 settings（函数注释第 2 条的原意）',
    判断: '判定「远端有没有表态」用的是「容器非空」，而排除键是在这之后才删的：container 因为只有 apiKey 显得「有表态」，删完却成了 {}，于是 writePath 整份沿用的分支被跳过 → 本机非密钥设置被空对象顶掉。修法方向：先把远端容器按排除键清洗，再判空。',
    影响面: '拉取（pull / conflict-pull）之后，本机的 model / baseUrl / weightUnit 被静默重置为默认值（DEFAULT_SETTINGS），用户会看到模型名与单位偏好突然变回默认。触发条件：远端快照的 settings 只含密钥（老版本上传 / 手改快照）。正常剥过密钥的新快照不会命中。',
  });

  const planSyncCases = [];
  for (let i = 0; i < 80; i += 1) {
    planSyncCases.push({
      label: 'rnd' + i,
      arg: {
        localRev: pick(rng, [0, 1, 2, 5, -1, 1.5, NaN, Infinity, '3', null, undefined]),
        localChecksum: pick(rng, ['a', 'b', '', null, undefined, 0, 3]),
        syncedChecksum: pick(rng, ['a', 'b', null, undefined, 0, 3]),
        remote: pick(rng, [null, undefined, {}, { rev: 0 }, { rev: 1 }, { rev: 3, payload: {} }, { rev: -1 }, { rev: 1.5 }, { rev: '2' }, 'x', [], 5]),
        localRecordCount: pick(rng, [0, 1, 5, '0', '3', NaN, null, undefined, Infinity]),
      },
    });
  }
  sweep('planSync 决策只出合法动作 / 判据自洽 / 确定', planSyncCases, function (arg) {
    const errs = [];
    const out = sync.planSync(arg);
    if (!out || typeof out !== 'object') return ['返回非对象'];
    if (['push', 'pull', 'conflict-pull', 'none'].indexOf(out.action) < 0) errs.push('非法动作 ' + rep(out.action));
    if (typeof out.reason !== 'string' || out.reason === '') errs.push('reason 非法 ' + rep(out.reason));
    if (!sameValue(sync.planSync(arg), out)) errs.push('同一输入两次决策不一致');
    const rev = Number.isInteger(arg.localRev) && arg.localRev >= 0 ? arg.localRev : 0;
    const usable = arg.remote && typeof arg.remote === 'object' && !Array.isArray(arg.remote) && Number.isInteger(arg.remote.rev) && arg.remote.rev >= 0;
    if (!usable && out.action !== 'push') errs.push('远端不可用时应 push，实际 ' + out.action);
    if (usable) {
      const remoteRev = arg.remote.rev;
      if (out.action === 'pull' && !(remoteRev > rev)) errs.push('pull 但远端版本没更新');
      if (out.action === 'conflict-pull' && !(remoteRev > rev)) errs.push('conflict-pull 但远端版本没更新');
      if (out.action === 'none' && remoteRev !== rev) errs.push('none 但版本不一致');
      if (out.action === 'push' && remoteRev > rev) errs.push('push 但远端更新（会覆盖云端）');
    }
    return errs;
  });
  check('planSync 精确决策表', function () {
    assert.equal(sync.planSync().action, 'push');
    assert.equal(sync.planSync({ localRev: 0, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: 1 }, localRecordCount: 5 }).action, 'pull');
    assert.equal(sync.planSync({ localRev: 0, localChecksum: 'b', syncedChecksum: 'a', remote: { rev: 1 }, localRecordCount: 5 }).action, 'conflict-pull');
    assert.equal(sync.planSync({ localRev: 0, localChecksum: 'b', syncedChecksum: null, remote: { rev: 1 }, localRecordCount: 0 }).action, 'pull');
    assert.equal(sync.planSync({ localRev: 0, localChecksum: 'b', syncedChecksum: null, remote: { rev: 1 }, localRecordCount: 3 }).action, 'conflict-pull');
    assert.equal(sync.planSync({ localRev: 2, localChecksum: 'b', syncedChecksum: 'a', remote: { rev: 1 }, localRecordCount: 3 }).action, 'push');
    assert.equal(sync.planSync({ localRev: 1, localChecksum: 'b', syncedChecksum: 'a', remote: { rev: 1 }, localRecordCount: 3 }).action, 'push');
    assert.equal(sync.planSync({ localRev: 1, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: 1 }, localRecordCount: 3 }).action, 'none');
    assert.equal(sync.planSync({ localRev: -5, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: 0 }, localRecordCount: 1 }).action, 'none');
    assert.equal(sync.planSync({ localRev: 1, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: 1.5 } }).action, 'push');
    assert.equal(sync.planSync({ localRev: 1, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: Infinity } }).action, 'push');
    assert.equal(sync.planSync({ localRev: 1, localChecksum: 'a', syncedChecksum: 'a', remote: { rev: 7 }, localRecordCount: '3' }).action, 'pull');
  });

  const snapCases = [];
  for (let i = 0; i < 60; i += 1) {
    snapCases.push({ label: 'rnd' + i, arg: { v: pick(rng, [1, 0, 2, '1', null]), accountId: randValue(rng, 1), rev: randValue(rng, 1), savedAt: randValue(rng, 1), payload: randValue(rng, 1) } });
  }
  for (const v of ANY_POOL) snapCases.push({ label: 'junk(' + rep(v) + ')', arg: v });
  sweep('parseSnapshot 只出 null 或干净快照 / 绝不抛', snapCases, function (v) {
    let out;
    try {
      out = sync.parseSnapshot(v);
    } catch (e) {
      return ['抛异常 ' + (e && e.name) + ': ' + (e && e.message)];
    }
    if (out === null) return [];
    if (!out || typeof out !== 'object') return ['返回非对象 ' + rep(out)];
    const errs = [];
    if (out.v !== sync.SNAPSHOT_VERSION) errs.push('v 非法');
    if (typeof out.accountId !== 'string' || out.accountId === '') errs.push('accountId 非法');
    if (!Number.isInteger(out.rev) || out.rev < 0) errs.push('rev 非法 ' + rep(out.rev));
    if (!finite(out.savedAt) || out.savedAt <= 0) errs.push('savedAt 非法 ' + rep(out.savedAt));
    if (!out.payload || typeof out.payload !== 'object' || Array.isArray(out.payload)) errs.push('payload 非法');
    if (sync.snapshotSummary(out) === null && out.payload) {
      let serial = true;
      try { JSON.stringify(out.payload); } catch (e) { serial = false; }
      if (serial) errs.push('snapshotSummary 对合法快照返回 null');
    }
    return errs;
  });
  check('buildSnapshot / parseSnapshot / snapshotSummary 往返', function () {
    const snap = sync.buildSnapshot({ accountId: '  acc-1  ', rev: 3, savedAt: 1700000000000, payload: { weights: [{ date: '2026-05-01' }], meals: [], exercises: [], waters: [{ date: '2026-05-01' }], meta: { settings: { apiKey: 'S' } } } });
    assert.equal(snap.accountId, 'acc-1');
    assert.equal(snap.v, sync.SNAPSHOT_VERSION);
    const parsed = sync.parseSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.deepEqual(parsed, snap, '往返丢字段');
    const summary = sync.snapshotSummary(snap);
    assert.equal(summary.records, 2);
    assert.equal(summary.savedAt, 1700000000000);
    assert.equal(summary.bytes, String(JSON.stringify(snap.payload)).length);
    assert.equal(sync.snapshotSummary({ v: 1, accountId: 'a', rev: 0, savedAt: 1, payload: { self: null } }).records, 0);
    assert.equal(sync.snapshotSummary(null), null);
    assert.equal(sync.snapshotSummary({ v: 2, accountId: 'a', rev: 0, savedAt: 1, payload: {} }), null);
    assert.equal(sync.parseSnapshot({ v: 1, accountId: 'a', rev: 0, savedAt: 0, payload: {} }), null, 'savedAt=0 应判非法');
    assert.equal(sync.parseSnapshot({ v: 1, accountId: 'a', rev: -1, savedAt: 1, payload: {} }), null);
    assert.equal(sync.parseSnapshot({ v: 1, accountId: 'a', rev: 0, savedAt: 1, payload: [] }), null);
    assert.throws(function () { sync.buildSnapshot({ accountId: '  ', payload: {} }); }, /账号标识/);
    assert.throws(function () { sync.buildSnapshot({ accountId: 'a', payload: [] }); }, /数据体/);
    assert.equal(sync.parseSnapshot(sync.buildSnapshot({ accountId: 'a', payload: {} })).rev, 0);
  });

  sweep('businessRecordCount 只出非负整数', cases1(ANY_POOL, 'payload'), function (v) {
    const out = sync.businessRecordCount(v);
    if (!Number.isInteger(out) || out < 0) return ['返回 ' + rep(out)];
    const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    let want = 0;
    for (const k of ['weights', 'meals', 'exercises', 'waters']) if (Array.isArray(src[k])) want += src[k].length;
    if (out !== want) return ['与手算条数不符 ' + out + ' ≠ ' + want];
    return [];
  });

  check('syncDigestOf：剥密钥 + 抹易变 meta + 校验和稳定', function () {
    const dump = {
      app: 'hms',
      exportedAt: 1700000000001,
      settings: { apiKey: 'SECRET-DIGEST', model: 'm' },
      meta: { syncState: { rev: 9 }, lastExportedAt: 1700000000000, settings: { apiKey: 'SECRET-DIGEST', model: 'm' }, mealTemplates: [] },
      weights: [{ date: '2026-05-01', weightKg: 70 }],
    };
    const a = sync.syncDigestOf(dump);
    assert.equal(JSON.stringify(a.payload).includes('SECRET-DIGEST'), false, '密钥进了本机指纹数据体');
    assert.equal('exportedAt' in a.payload, false, '顶层 exportedAt 未抹掉');
    assert.equal('syncState' in a.payload.meta, false, 'meta.syncState 未抹掉');
    assert.equal('lastExportedAt' in a.payload.meta, false, 'meta.lastExportedAt 未抹掉');
    assert.equal(a.payload.app, 'hms');
    const b = sync.syncDigestOf({ ...dump, exportedAt: 1799999999999, meta: { ...dump.meta, syncState: { rev: 99 }, lastExportedAt: 1 } });
    assert.equal(a.checksum, b.checksum, '易变 meta 变了指纹就变了（同步会退化成每次全量对推）');
    const c = sync.syncDigestOf({ ...dump, weights: [{ date: '2026-05-01', weightKg: 71 }] });
    assert.notEqual(a.checksum, c.checksum, '业务数据变了指纹没变');
    const d = sync.syncDigestOf({ ...dump, settings: { ...dump.settings, apiKey: 'SECRET-OTHER' } });
    assert.equal(a.checksum, d.checksum, '密钥变了不该算本机改动');
    assert.equal(typeof sync.syncDigestOf(null).checksum, 'string');
    assert.equal(sync.syncDigestOf(null).payload.app, 'hms');
  });

  /* ---------- createDebouncer（注入假时钟/假定时器） ---------- */

  function fakeClock() {
    let t = 10000;
    const live = new Map();
    const stale = [];
    let id = 0;
    return {
      now: function () { return t; },
      setTimer: function (fn) { id += 1; live.set(id, fn); return id; },
      clearTimer: function (myId) { if (live.has(myId)) { stale.push(live.get(myId)); live.delete(myId); } },
      advance: function (ms) { t += ms; },
      fireLive: function () { const fns = Array.from(live.values()); live.clear(); fns.forEach(function (fn) { fn(); }); },
      fireStale: function () { const fns = stale.slice(); stale.length = 0; fns.forEach(function (fn) { fn(); }); },
      liveCount: function () { return live.size; },
    };
  }

  check('createDebouncer：合并窗口 + waitedMs + cancel + flush + 陈旧定时器守卫', function () {
    const c = fakeClock();
    const log = [];
    const d = sync.createDebouncer({ delayMs: 5000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onFire: function (r, w) { log.push([r, w]); } });
    assert.equal(d.pending(), false);
    d.schedule('a');
    assert.equal(d.pending(), true);
    c.advance(2000);
    d.schedule('b');
    assert.equal(c.liveCount(), 1, '重复 schedule 应合并成一个定时器');
    c.advance(5000);
    c.fireLive();
    assert.deepEqual(log, [['b', 5000]], '合并后应只触发一次，且 waitedMs = 距最后一次 schedule');
    assert.equal(d.pending(), false);

    d.schedule('c');
    c.advance(3000);
    d.flush();
    assert.deepEqual(log[1], ['c', 0], 'flush 立即触发 → waitedMs 按注释归 0（见 DEBOUNCER_FLUSH_WAITEDMS）');
    assert.equal(d.pending(), false);

    d.schedule('d');
    d.cancel();
    c.fireStale();
    c.fireLive();
    assert.equal(log.length, 2, 'cancel 后不该触发');
    assert.equal(d.pending(), false);

    d.schedule('e');
    d.schedule('f');
    c.fireStale();
    assert.equal(log.length, 2, '被换掉的旧定时器回调再次执行时必须被 generation 守卫挡住');
    assert.equal(d.pending(), true);
    c.fireLive();
    assert.deepEqual(log[2], ['f', 0]);

    const c2 = fakeClock();
    const log2 = [];
    const d2 = sync.createDebouncer({ delayMs: 0, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer, onFire: function (r, w) { log2.push(r); } });
    d2.schedule('zero');
    c2.fireLive();
    assert.deepEqual(log2, ['zero'], 'delay 0 也要能触发一次');
    d2.schedule();
    d2.flush();
    assert.deepEqual(log2, ['zero', null], 'schedule() 无 reason 时 reason 应为 null');
    const noop = sync.createDebouncer({ delayMs: NaN, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    noop.schedule('x');
    noop.flush();
    assert.equal(noop.pending(), false, '没有 onFire 也要能安全 flush');
  });

  bug({
    id: 'DEBOUNCER_FLUSH_WAITEDMS',
    name: 'createDebouncer.flush() 的 waitedMs 不是文档写的 0',
    模块: 'js/sync.js createDebouncer',
    严重度: 'low',
    复现: [
      "const sync = await import('./js/sync.js');",
      "let t = 0; const timers = new Map(); let id = 0; const log = [];",
      "const d = sync.createDebouncer({ delayMs: 5000, now: function () { return t; }, setTimer: function (fn) { id += 1; timers.set(id, fn); return id; }, clearTimer: function (k) { timers.delete(k); }, onFire: function (r, w) { log.push([r, w]); } });",
      "d.schedule('x'); t = 3000; d.flush();",
      'log;   // → [["x", 3000]]；文档（sync.js:284）说 flush 立即触发时是 0',
    ].join(LF),
    probe: function () {
      const c = fakeClock();
      const log = [];
      const d = sync.createDebouncer({ delayMs: 5000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onFire: function (r, w) { log.push([r, w]); } });
      d.schedule('x');
      c.advance(3000);
      d.flush();
      return log;
    },
    want: [['x', 0]],
    期望: "[['x', 0]]（按 sync.js:284 的注释：flush 立即触发时为 0）",
    判断: 'trigger() 一律用 clock() - scheduledAt 算 waitedMs，flush 路径没有归零。要么文档要改，要么触发时区分「定时器到点」与「手动 flush」。目前没有调用方读第二个参数（createSyncScheduler 只转发 reason），所以是文档/实现一致性问题。',
    影响面: '无功能影响（无调用方消费 waitedMs）；但如果以后用它做「是否真的等满防抖窗口」的判断就会误判。',
  });

  /* ---------- runSyncOnce（假 storage + 假 transport） ---------- */

  function fakeStorage(opts) {
    const o = opts || {};
    const calls = [];
    const meta = new Map();
    const state = { calls, meta, loaded: null, syncState: null, backup: null };
    return {
      state,
      dumpAll: o.dumpAll || async function () { calls.push('dumpAll'); return o.dump !== undefined ? o.dump : { meta: {}, weights: [], meals: [], exercises: [], waters: [] }; },
      getSyncState: async function () { calls.push('getSyncState'); return o.syncState === undefined ? null : o.syncState; },
      setSyncState: async function (v) { calls.push('setSyncState'); if (o.failSetSyncState) throw new Error('锚点写不进去'); state.syncState = v; return v; },
      loadAll: async function (payload, mode) { calls.push('loadAll:' + mode); if (o.failLoadAll) throw new Error('写库失败'); state.loaded = payload; return payload; },
      getMeta: async function (k) { calls.push('getMeta:' + k); return meta.has(k) ? meta.get(k) : null; },
      setMeta: async function (k, v) { calls.push('setMeta:' + k); if (o.failSetMeta) throw new Error('meta 写不进去'); meta.set(k, v); state.backup = v; return v; },
    };
  }
  function fakeTransport(opts) {
    const o = opts || {};
    const calls = [];
    return {
      calls,
      pull: async function () { calls.push('pull'); if (o.pullThrows) throw new Error('网络断了'); return o.pull === undefined ? { ok: true, rev: 0, savedAt: 1, payload: {} } : o.pull; },
      push: async function (args) { calls.push('push'); state_lastPush = args; if (o.pushThrows) throw new Error('上传炸了'); return o.push === undefined ? { ok: true, rev: 1 } : o.push; },
    };
  }
  let state_lastPush = null;

  const LOCAL_DUMP = {
    app: 'hms',
    settings: { apiKey: 'SECRET-LOCAL', model: 'qwen3-vl-plus', weightUnit: 'jin' },
    meta: { settings: { apiKey: 'SECRET-LOCAL', model: 'qwen3-vl-plus' } },
    weights: [{ date: '2026-05-01', weightKg: 70 }],
    meals: [], exercises: [], waters: [],
  };

  await checkAsync('runSyncOnce：前置校验与错误分支都不抛', async function () {
    const r1 = await sync.runSyncOnce({});
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'no-storage');
    const storage = fakeStorage();
    const r2 = await sync.runSyncOnce({ storage, token: 't' });
    assert.equal(r2.error, 'not-configured');
    const r3 = await sync.runSyncOnce({ storage, transport: fakeTransport(), token: '   ' });
    assert.equal(r3.error, 'unauthorized');
    const r4 = await sync.runSyncOnce({ storage: fakeStorage({ dumpAll: async function () { throw new Error('本机读不出来'); } }), transport: fakeTransport(), token: 't' });
    assert.equal(r4.error, 'local-error');
    const r5 = await sync.runSyncOnce({ storage, transport: fakeTransport({ pullThrows: true }), token: 't' });
    assert.equal(r5.error, 'network');
    const r6 = await sync.runSyncOnce({ storage, transport: fakeTransport({ pull: { ok: false, error: 'expired', message: '令牌过期' } }), token: 't' });
    assert.equal(r6.ok, false);
    assert.equal(r6.error, 'expired');
    assert.equal(r6.message, '令牌过期');
    for (const r of [r1, r2, r3, r4, r5, r6]) {
      assert.equal(typeof r.ok, 'boolean');
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 0, 'message 不应为空');
    }
  });

  await checkAsync('runSyncOnce：push 路径（上传体不得带密钥 / 锚点写回 / rev-conflict 不写锚点）', async function () {
    const storage = fakeStorage({ dump: LOCAL_DUMP });
    const transport = fakeTransport({ pull: { ok: true, rev: 0, savedAt: 1, payload: {} }, push: { ok: true, rev: 1 } });
    state_lastPush = null;
    const r = await sync.runSyncOnce({ storage, transport, token: 'tk', accountId: 'acc-1', now: function () { return 1700000000000; } });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'push');
    assert.equal(r.rev, 1);
    assert.equal(JSON.stringify(state_lastPush.payload).includes('SECRET-LOCAL'), false, '上传体里出现了本机密钥');
    assert.equal(state_lastPush.baseRev, 0);
    assert.equal(storage.state.syncState.rev, 1);
    assert.equal(storage.state.syncState.checksum, sync.syncDigestOf(LOCAL_DUMP).checksum);

    const storage2 = fakeStorage({ dump: LOCAL_DUMP });
    const transport2 = fakeTransport({ pull: { ok: true, rev: 0, savedAt: 1, payload: {} }, push: { ok: false, error: 'rev-conflict', rev: 7 } });
    const r2 = await sync.runSyncOnce({ storage: storage2, transport: transport2, token: 'tk' });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'rev-conflict');
    assert.equal(r2.rev, 7);
    assert.ok(r2.message.indexOf('7') >= 0, 'rev-conflict 提示里应带服务端 rev');
    assert.equal(storage2.state.calls.includes('setSyncState'), false, 'rev-conflict 时不该写锚点');

    const storage3 = fakeStorage({ dump: LOCAL_DUMP, failSetSyncState: true });
    const transport3 = fakeTransport({ pull: { ok: true, rev: 0, savedAt: 1, payload: {} }, push: { ok: true, rev: 1 } });
    const r3 = await sync.runSyncOnce({ storage: storage3, transport: transport3, token: 'tk' });
    assert.equal(r3.ok, false);
    assert.equal(r3.action, 'push');
    assert.ok(r3.message.indexOf('锚点') >= 0, '锚点写失败应给中文提示: ' + r3.message);

    const storage4 = fakeStorage({ dump: LOCAL_DUMP });
    const transport4 = fakeTransport({ pull: { ok: true, rev: 0, savedAt: 1, payload: {} }, pushThrows: true });
    const r4 = await sync.runSyncOnce({ storage: storage4, transport: transport4, token: 'tk' });
    assert.equal(r4.ok, false);
    assert.equal(r4.error, 'network');
  });

  await checkAsync('runSyncOnce：pull / conflict-pull（本机密钥必留 / 冲突副本先落盘）', async function () {
    const checksum = sync.syncDigestOf(LOCAL_DUMP).checksum;
    const storage = fakeStorage({ dump: LOCAL_DUMP, syncState: { rev: 0, checksum } });
    const remotePayload = { app: 'hms', settings: { apiKey: 'REMOTE' }, meta: { settings: { apiKey: 'REMOTE', model: 'remote-model' } }, weights: [], meals: [], exercises: [], waters: [] };
    const transport = fakeTransport({ pull: { ok: true, rev: 2, savedAt: 1700000000000, payload: remotePayload } });
    const r = await sync.runSyncOnce({ storage, transport, token: 'tk', accountId: 'acc-1' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'pull');
    assert.equal(r.rev, 2);
    assert.equal(r.backupAt, null);
    assert.ok(storage.state.calls.some(function (c) { return c === 'loadAll:replace'; }), 'pull 必须走 loadAll(replace)');
    assert.equal(storage.state.loaded.settings.apiKey, 'SECRET-LOCAL', '拉取后本机密钥丢了');
    assert.equal(storage.state.syncState.rev, 2);

    const storage2 = fakeStorage({ dump: LOCAL_DUMP, syncState: { rev: 0, checksum: 'different-checksum' } });
    const transport2 = fakeTransport({ pull: { ok: true, rev: 3, savedAt: 1700000000000, payload: remotePayload } });
    const r2 = await sync.runSyncOnce({ storage: storage2, transport: transport2, token: 'tk', accountId: 'acc-1' });
    assert.equal(r2.ok, true);
    assert.equal(r2.action, 'conflict-pull');
    assert.ok(r2.backupAt > 0, 'conflict-pull 必须先落冲突副本');
    assert.ok(storage2.state.backup && storage2.state.backup.payload, '冲突副本形状不对: ' + rep(storage2.state.backup));
    assert.equal(sync.isConflictBackup(storage2.state.backup), true);
    assert.equal(storage2.state.loaded.settings.apiKey, 'SECRET-LOCAL');

    const storage3 = fakeStorage({ dump: LOCAL_DUMP, syncState: { rev: 0, checksum: 'x' }, failSetMeta: true });
    const transport3 = fakeTransport({ pull: { ok: true, rev: 3, savedAt: 1, payload: remotePayload } });
    const r3 = await sync.runSyncOnce({ storage: storage3, transport: transport3, token: 'tk' });
    assert.equal(r3.ok, false);
    assert.equal(r3.action, 'conflict-pull');
    assert.equal(storage3.state.calls.includes('loadAll:replace'), false, '备份失败还敢覆盖本机数据');

    const storage4 = fakeStorage({ dump: LOCAL_DUMP, syncState: { rev: 0, checksum: 'x' }, failLoadAll: true });
    const transport4 = fakeTransport({ pull: { ok: true, rev: 3, savedAt: 1, payload: remotePayload } });
    const r4 = await sync.runSyncOnce({ storage: storage4, transport: transport4, token: 'tk' });
    assert.equal(r4.ok, false);
    assert.equal(r4.error, 'local-error');

    const storage5 = fakeStorage({ dump: { app: 'hms', meta: {}, weights: [], meals: [], exercises: [], waters: [] }, syncState: null });
    const transport5 = fakeTransport({ pull: { ok: true, rev: 4, savedAt: 1, payload: remotePayload } });
    const r5 = await sync.runSyncOnce({ storage: storage5, transport: transport5, token: 'tk' });
    assert.equal(r5.action, 'pull', '空本机 + 从没同步过应直接 pull');

    const storage6 = fakeStorage({ dump: LOCAL_DUMP, syncState: { rev: 1, checksum: sync.syncDigestOf(LOCAL_DUMP).checksum } });
    const transport6 = fakeTransport({ pull: { ok: true, rev: 1, savedAt: 1, payload: remotePayload } });
    const r6 = await sync.runSyncOnce({ storage: storage6, transport: transport6, token: 'tk' });
    assert.equal(r6.action, 'none');
    assert.equal(r6.ok, true);
  });

  await checkAsync('runSyncOnce：随机脏 storage/transport 永不抛', async function () {
    const bad = [];
    for (let i = 0; i < 60; i += 1) {
      cases += 1;
      const junkMethod = function () {
        const v = randValue(rng, 1);
        if (rng() < 0.2) return async function () { throw new Error('假故障' + i); };
        return async function () { return v; };
      };
      const storage = {};
      for (const k of ['dumpAll', 'getSyncState', 'setSyncState', 'loadAll', 'getMeta', 'setMeta']) {
        if (rng() < 0.85) storage[k] = junkMethod();
      }
      const transport = rng() < 0.1 ? randValue(rng, 1) : { pull: junkMethod(), push: junkMethod() };
      let r;
      try {
        r = await sync.runSyncOnce({ accountId: pick(rng, ['a', '', null, undefined, 5]), transport, token: pick(rng, ['t', '  ', '', null, undefined, 5]), storage, now: rng() < 0.3 ? undefined : function () { return pick(rng, [0, -1, NaN, Infinity, 1700000000000]); } });
      } catch (e) {
        bad.push('第 ' + i + ' 次抛了 ' + (e && e.name) + ': ' + (e && e.message));
        continue;
      }
      if (!r || typeof r !== 'object') { bad.push('第 ' + i + ' 次返回 ' + rep(r)); continue; }
      if (typeof r.ok !== 'boolean') bad.push('第 ' + i + ' 次 ok 不是布尔: ' + rep(r.ok));
      if (r.message == null || String(r.message).length === 0) bad.push('第 ' + i + ' 次 message 为空: ' + rep(r.message));
      if (r.ok === true && (!Number.isInteger(r.rev) || r.rev < 0)) bad.push('第 ' + i + ' 次 ok=true 但 rev 非法: ' + rep(r.rev));
    }
    assert.equal(bad.length, 0, bad.slice(0, 3).join(' | '));
  });

  /* ============================================================
   * 5. js/accounts.js（纯逻辑 + 损坏 localStorage 降级）
   * ============================================================ */

  function memStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
      map,
      getItem: function (k) { return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(k, String(v)); },
      removeItem: function (k) { map.delete(k); },
    };
  }
  function withFakeStorage(impl, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const prev = had ? globalThis.localStorage : undefined;
    Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true });
    try {
      return fn();
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true, writable: true });
      else delete globalThis.localStorage;
    }
  }
  /* await 版的假 storage：必须等 fn 的 promise 结算后再还原 localStorage */
  async function withFakeStorageAsync(impl, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const prev = had ? globalThis.localStorage : undefined;
    Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true });
    try {
      return await fn();
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true, writable: true });
      else delete globalThis.localStorage;
    }
  }

  check('listAccounts 降级：storage 缺失 / 抛异常 / 坏 JSON / 非数组 → []', function () {
    assert.deepEqual(withFakeStorage(null, function () { return accounts.listAccounts(); }), []);
    assert.deepEqual(withFakeStorage({ getItem: function () { throw new Error('隐私模式'); } }, function () { return accounts.listAccounts(); }), []);
    for (const s of ['{not json', 'null', '"x"', '{}', '3', '[', '', 'undefined', '[1,2,3]']) {
      assert.deepEqual(withFakeStorage(memStorage({ 'hms.accounts': s }), function () { return accounts.listAccounts(); }), [], '目录 ' + rep(s) + ' 应判空');
    }
    assert.deepEqual(accounts.listAccounts(), [], 'Node 里没有 localStorage 应返回 []');
    assert.equal(accounts.getActiveAccount(), null);
  });

  const catalogCases = [];
  for (let i = 0; i < 40; i += 1) catalogCases.push({ label: 'rnd' + i, arg: JSON.stringify(randValue(rng, 2)) });
  for (const v of ANY_POOL) catalogCases.push({ label: 'junk(' + rep(v) + ')', arg: typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v) });
  catalogCases.push({ label: '重复 dbName', arg: JSON.stringify([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', dbName: 'hms-u-a' }, { id: 'c', name: 'C', dbName: 'hms-u-c' }]) });
  catalogCases.push({ label: '同 id 多份', arg: JSON.stringify([{ id: 'a', name: '1' }, { id: 'a', name: '2' }]) });
  sweep('listAccounts 契约（脏目录 → 结构化结果 / 同库去重 / createdAt 升序 / 字段干净）', catalogCases, function (raw) {
    const list = withFakeStorage(memStorage({ 'hms.accounts': raw }), function () { return accounts.listAccounts(); });
    if (!Array.isArray(list)) return ['返回非数组 ' + rep(list)];
    const errs = [];
    const dbNames = new Set();
    for (const a of list) {
      if (!a || typeof a !== 'object') { errs.push('条目非对象 ' + rep(a)); continue; }
      if (typeof a.id !== 'string' || a.id === '' || a.id !== a.id.trim()) errs.push('id 非法 ' + rep(a.id));
      if (typeof a.name !== 'string' || a.name === '' || a.name !== a.name.trim()) errs.push('name 非法 ' + rep(a.name));
      if (typeof a.dbName !== 'string' || a.dbName === '') errs.push('dbName 非法 ' + rep(a.dbName));
      else if (dbNames.has(a.dbName)) errs.push('同一个库出现两个账号 ' + a.dbName);
      else dbNames.add(a.dbName);
      if (!finite(a.createdAt) || a.createdAt < 0) errs.push('createdAt 非法 ' + rep(a.createdAt));
      for (const k of Object.keys(a)) if (a[k] === undefined) errs.push('值为 undefined 的键 ' + k);
    }
    for (let i = 1; i < list.length; i += 1) if (list[i].createdAt < list[i - 1].createdAt) errs.push('createdAt 未升序');
    return errs;
  });
  check('listAccounts 精确契约（丢半个账号 / 同库只认先出现的 / 排序稳定）', function () {
    const raw = JSON.stringify([
      null, 3, 'x', [], {},
      { id: '', name: 'A' }, { id: 'a', name: '' },
      { id: 'a', name: 'A' }, { id: 'b', name: 'B', dbName: 'hms-u-a' },
      { id: 'c', name: 'C', createdAt: '5' }, { id: 'd', name: 'D', createdAt: -1 }, { id: 'e', name: 'E', dbName: 'hms' },
    ]);
    const list = withFakeStorage(memStorage({ 'hms.accounts': raw }), function () { return accounts.listAccounts(); });
    assert.deepEqual(list.map(function (a) { return a.id; }), ['a', 'd', 'e', 'c']);
    assert.equal(list[0].dbName, 'hms-u-a');
    assert.equal(list[2].dbName, 'hms');
    assert.equal(list[1].createdAt, 0);
    assert.equal(list[3].createdAt, 5);
    const same = withFakeStorage(memStorage({ 'hms.accounts': JSON.stringify([{ id: 'x', name: 'X', createdAt: 0 }, { id: 'y', name: 'Y', createdAt: 0 }]) }), function () { return accounts.listAccounts(); });
    assert.deepEqual(same.map(function (a) { return a.id; }), ['x', 'y'], 'createdAt 相同时应保持目录顺序');
  });

  check('dbNameForAccount / getActiveAccount / setActiveAccount 契约', function () {
    assert.equal(accounts.dbNameForAccount(null), 'hms');
    assert.equal(accounts.dbNameForAccount({}), 'hms');
    assert.equal(accounts.dbNameForAccount({ dbName: '   ' }), 'hms');
    assert.equal(accounts.dbNameForAccount({ dbName: ' hms-u-1 ' }), 'hms-u-1');
    const store = memStorage({ 'hms.accounts': JSON.stringify([{ id: 'u1', name: 'U1', createdAt: 1 }, { id: 'u2', name: 'U2', createdAt: 2 }]), 'hms.activeAccount': 'u1' });
    withFakeStorage(store, function () {
      assert.equal(accounts.getActiveAccount().id, 'u1');
      store.map.set('hms.activeAccount', 'nope');
      assert.equal(accounts.getActiveAccount(), null, '指向已删除账号应回落 null');
      store.map.set('hms.activeAccount', '');
      assert.equal(accounts.getActiveAccount(), null);
      const notified = [];
      accounts.connectDb({ onSwitch: function () { notified.push('switch'); } });
      assert.equal(accounts.setActiveAccount('u2').id, 'u2');
      assert.deepEqual(notified, ['switch'], '切换成功应通知 db 层');
      assert.equal(accounts.setActiveAccount('nope'), null);
      assert.deepEqual(notified, ['switch'], '切换失败不该通知 db 层');
      assert.equal(accounts.setActiveAccount(''), null);
      assert.equal(accounts.setActiveAccount({}), null);
      assert.equal(accounts.setActiveAccount(), null);
      assert.equal(store.map.get('hms.activeAccount'), 'u2');
      accounts.connectDb({ onSwitch: 42 });
      assert.equal(accounts.setActiveAccount('u1').id, 'u1', 'onSwitch 不是函数时也不该炸');
      assert.deepEqual(notified, ['switch']);
      accounts.connectDb(null);
      accounts.connectDb('x');
    });
    const refusing = memStorage({ 'hms.accounts': store.map.get('hms.accounts'), 'hms.activeAccount': 'u1' });
    refusing.setItem = function () { throw new Error('配额满'); };
    withFakeStorage(refusing, function () {
      assert.equal(accounts.setActiveAccount('u2'), null, '写不进去必须返回 null 而不是假装成功');
      assert.equal(refusing.map.get('hms.activeAccount'), 'u1');
    });
  });

  await checkAsync('createAccount / renameAccount / removeAccount / ensureDefaultAccount 契约', async function () {
    const store = memStorage({ 'hms.accounts': JSON.stringify([{ id: 'legacy', name: '本机', dbName: 'hms', createdAt: 1 }]), 'hms.activeAccount': 'legacy' });
    await withFakeStorageAsync(store, async function () {
      const created = await accounts.createAccount({ name: '  新账号  ' });
      assert.equal(created.name, '新账号');
      assert.ok(created.dbName.indexOf('hms-u-') === 0, '新账号应是独立库: ' + created.dbName);
      assert.equal(accounts.listAccounts().length, 2);
      await accounts.createAccount('字符串名字');
      assert.equal(accounts.listAccounts().length, 3);
      await assert.rejects(function () { return accounts.createAccount({ name: '   ' }); }, /账号名称不能为空/);
      await assert.rejects(function () { return accounts.createAccount(); }, /账号名称不能为空/);

      const renamed = accounts.renameAccount('legacy', ' 改名了 ');
      assert.equal(renamed.name, '改名了');
      assert.throws(function () { return accounts.renameAccount('nope', 'x'); }, /账号不存在/);
      assert.throws(function () { return accounts.renameAccount('legacy', ''); }, /账号名称不能为空/);

      await assert.rejects(function () { return accounts.removeAccount('legacy'); }, /不能删除/, '认领老库的账号禁止删除');
      await accounts.removeAccount('legacy2');
      const kept = accounts.setActiveAccount('legacy');
      assert.equal(kept.id, 'legacy');
      const before = accounts.listAccounts().length;
      await accounts.removeAccount(''); 
      assert.equal(accounts.listAccounts().length, before, '空 id 不该删掉任何账号');
      const ensured = await accounts.ensureDefaultAccount();
      assert.ok(ensured && typeof ensured.id === 'string' && ensured.id !== '');
      assert.equal(accounts.getActiveAccount().id, ensured.id);
    });

    const full = [];
    for (let i = 0; i < accounts.MAX_ACCOUNTS; i += 1) full.push({ id: 'a' + i, name: 'A' + i, createdAt: i + 1 });
    await withFakeStorageAsync(memStorage({ 'hms.accounts': JSON.stringify(full) }), async function () {
      await assert.rejects(function () { return accounts.createAccount({ name: '第九个' }); }, /最多只能建/, 'MAX_ACCOUNTS 上限应生效');
    });

    const broken = memStorage({});
    broken.setItem = function () { throw new Error('配额满'); };
    await withFakeStorageAsync(broken, async function () {
      const ensured = await accounts.ensureDefaultAccount();
      assert.equal(ensured.dbName, 'hms', '存不进目录也要回落老库账号');
      assert.equal(ensured.name, '本机');
      await assert.rejects(function () { return accounts.createAccount({ name: 'x' }); }, /本地存储不可用/);
      assert.throws(function () { return accounts.renameAccount('a', 'b'); }, /账号不存在/);
    });

    const empty = memStorage({});
    await withFakeStorageAsync(empty, async function () {
      const first = await accounts.ensureDefaultAccount();
      assert.equal(first.dbName, 'hms');
      const again = await accounts.ensureDefaultAccount();
      assert.equal(again.id, first.id, 'ensureDefaultAccount 必须幂等');
      assert.equal(accounts.listAccounts().length, 1);
    });
  });

  notes.checksRun = passed + failures.length;
  notes.casesRun = cases;

  return {
    passed,
    failed: failures.length,
    failures,
    findings,
    cases,
    checks: passed + failures.length,
    seed: SEED,
    notes,
  };
}

/* 直接执行本文件时自报一份人读结果 */
if (process.argv && process.argv[1] && process.argv[1].endsWith('fuzz.data.mjs')) {
  const r = await run();
  console.log('fuzz.data: ' + r.passed + ' passed / ' + r.failed + ' failed / ' + r.findings.length + ' findings（' + r.cases + ' 组输入，seed=' + r.seed + '）');
  for (const f of r.failures) console.log('  ✗ ' + f.name + ': ' + f.error);
  for (const f of r.findings) console.log('  ● [' + f.严重度 + '] ' + f.id + ' — ' + f.模块);
}

/* 未覆盖区域（本轮明确没打的地方）：
 * - IndexedDB / store.js / db.js 真路径（本机没有真 IDB；那部分由 tests/logic.test.mjs 的假 IDB 覆盖）
 * - js/cloud-api.js、js/cloud-transport.js、js/vision.js（网络与模型层，本轮不联网）
 * - views/** 的 DOM 渲染路径（只打了 views/food.js 的纯函数 mergeToDish / unitsOf / unitHintFor / defaultDishGrams）
 * - Excel/WPS 对公式的真实求值语义（CSV_FORMULA_INJECTION 断言的是「数据单元格以公式触发字符开头」这一可静态判定的性质）
 * - runSyncOnce 的并发/中断、createSyncScheduler 的计时路径（只覆盖了 createDebouncer）
 * - Symbol / 抛异常的 Proxy 作为入参（JS 语义层面对 Number(Symbol) / 属性访问抛错，不属于数据层契约）
 */
