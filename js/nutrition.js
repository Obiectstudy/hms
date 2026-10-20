/**
 * 纯计算层。硬约束：不碰 DOM / db / fetch / window，任何环境（含 Node）都能直接 import。
 *
 * 日期一律按**本地时区**换算，禁止 toISOString()：北京时间 2026-10-19 07:00 的 Date
 * 转 UTC 会掉到 10-18，体重/餐次就会串到前一天。
 */

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 保留 1 位小数；非有限值一律归 0，避免 NaN 顺着聚合污染整个页面。 */
export function round1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/** Date -> 'YYYY-MM-DD'（本地时区）。 */
export function localDateStr(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 'YYYY-MM-DD' -> 本地 00:00 的 Date；非法输入返回 Invalid Date。 */
export function parseDateStr(s) {
  const m = DATE_RE.exec(String(s ?? ''));
  if (!m) return new Date(NaN);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(year, month - 1, day);
  // 2026-02-31 这类溢出会滚到 3 月，视为非法
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return new Date(NaN);
  }
  return dt;
}

function shiftDays(dateStr, n) {
  const dt = parseDateStr(dateStr);
  if (Number.isNaN(dt.getTime())) return '';
  dt.setDate(dt.getDate() - num(n));
  return localDateStr(dt);
}

/** 今天往前第 n 天的本地日期串（n=0 即今天）。 */
export function daysAgo(n = 0) {
  return shiftDays(localDateStr(new Date()), num(n));
}

/** Mifflin-St Jeor，取整。sex 非 'female' 一律按男性公式（宁可略高不低估）。 */
export function bmrMifflinStJeor({ sex, weightKg, heightCm, age } = {}) {
  const w = num(weightKg);
  const h = num(heightCm);
  const a = num(age);
  if (w <= 0 || h <= 0 || a <= 0) return 0;
  const base = 10 * w + 6.25 * h - 5 * a;
  return Math.round(sex === 'female' ? base - 161 : base + 5);
}

/** 活动系数换算每日总消耗，取整。未知活动量按久坐处理。 */
export function tdee(bmr, activity) {
  const base = num(bmr);
  if (base <= 0) return 0;
  const factor = ACTIVITY_FACTORS[activity] ?? ACTIVITY_FACTORS.sedentary;
  return Math.round(base * factor);
}

/** 'YYYY-MM-DD' 生日 -> 周岁（按本地日期比较，未过今年生日减 1）。 */
export function ageFromBirthday(birthday) {
  const b = parseDateStr(birthday);
  if (Number.isNaN(b.getTime())) return 0;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const monthDiff = now.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < b.getDate())) age -= 1;
  return Math.max(0, age);
}

/**
 * 热量目标 -> 三大宏量克数（4/4/9 反算）。
 * ratio 允许传小数比例 {0.5,0.2,0.3} 或百分比 {50,20,30}：内部按和归一，两种约定都成立。
 */
export function targetMacros(calorieTarget, ratio = {}) {
  const kcal = num(calorieTarget);
  const raw = {
    carb: Math.max(0, num(ratio?.carb)),
    protein: Math.max(0, num(ratio?.protein)),
    fat: Math.max(0, num(ratio?.fat)),
  };
  const sum = raw.carb + raw.protein + raw.fat;
  const r = sum > 0
    ? { carb: raw.carb / sum, protein: raw.protein / sum, fat: raw.fat / sum }
    : { carb: 0.5, protein: 0.2, fat: 0.3 };
  if (kcal <= 0) return { carb: 0, protein: 0, fat: 0 };
  return {
    carb: round1((kcal * r.carb) / 4),
    protein: round1((kcal * r.protein) / 4),
    fat: round1((kcal * r.fat) / 9),
  };
}

/** 4/4/9 反算热量，取整。缺字段按 0。 */
export function kcalFromMacros({ carb, protein, fat } = {}) {
  return Math.round(4 * num(carb) + 4 * num(protein) + 9 * num(fat));
}

/** 每 100g 营养值 × 实际克数；kcal 取整，其余 1 位小数。 */
export function scaleFood(per100g, grams) {
  const p = per100g && typeof per100g === 'object' ? per100g : {};
  const f = Math.max(0, num(grams)) / 100;
  return {
    kcal: Math.round(num(p.kcal) * f),
    carb: round1(num(p.carb) * f),
    protein: round1(num(p.protein) * f),
    fat: round1(num(p.fat) * f),
    fiber: round1(num(p.fiber) * f),
    sodium: round1(num(p.sodium) * f),
  };
}

/** 条目求和；缺字段（fiber/sodium 常见缺失）按 0，非法条目跳过。 */
export function sumItems(items) {
  let kcal = 0;
  let carb = 0;
  let protein = 0;
  let fat = 0;
  let fiber = 0;
  let sodium = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    kcal += num(it.kcal);
    carb += num(it.carb);
    protein += num(it.protein);
    fat += num(it.fat);
    fiber += num(it.fiber);
    sodium += num(it.sodium);
  }
  return {
    kcal: Math.round(kcal),
    carb: round1(carb),
    protein: round1(protein),
    fat: round1(fat),
    fiber: round1(fiber),
    sodium: round1(sodium),
  };
}

/** 净值 = 摄入 − 运动消耗，取整。 */
export function netKcal(intakeKcal, burnedKcal) {
  return Math.round(num(intakeKcal) - num(burnedKcal));
}

/** BMI，1 位小数；身高体重非法返回 0。 */
export function bmi({ weightKg, heightCm } = {}) {
  const w = num(weightKg);
  const h = num(heightCm) / 100;
  if (w <= 0 || h <= 0) return 0;
  return round1(w / (h * h));
}

/** 中国成人 BMI 分级（18.5 / 24 / 28），阈值边界取「进入下一档」。 */
export function bmiClass(bmiValue) {
  const v = num(bmiValue);
  if (!(v > 0)) return { label: '未知', level: 'normal' };
  if (v < 18.5) return { label: '偏瘦', level: 'low' };
  if (v < 24) return { label: '正常', level: 'normal' };
  if (v < 28) return { label: '超重', level: 'over' };
  return { label: '肥胖', level: 'obese' };
}

function byDateAsc(a, b) {
  if (a.date === b.date) return 0;
  return a.date < b.date ? -1 : 1;
}

/**
 * 体重序列与环比差值。
 * delta7/delta30 = 最新值 − 「最新日期前 N 天时最近的一条」；该窗口内没有更早记录则为 null
 * （新手第七天不该看到一个凭空捏造的 0）。
 */
export function weightStats(weights) {
  const rows = (Array.isArray(weights) ? weights : [])
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({ date: typeof w.date === 'string' ? w.date : '', weightKg: num(w.weightKg) }))
    .filter((w) => DATE_RE.test(w.date) && w.weightKg > 0)
    .sort(byDateAsc);

  // 同日多条（历史脏数据）以后出现的为准
  const unique = new Map();
  for (const w of rows) unique.set(w.date, round1(w.weightKg));
  const series = [...unique.entries()].map(([date, weightKg]) => ({ date, weightKg }));

  if (!series.length) {
    return { latest: null, latestDate: null, delta7: null, delta30: null, series: [] };
  }

  const last = series[series.length - 1];
  const deltaFrom = (days) => {
    const cutoff = shiftDays(last.date, days);
    if (!cutoff) return null;
    let ref = null;
    for (const p of series) {
      if (p.date <= cutoff) ref = p;
      else break;
    }
    if (!ref) return null;
    return round1(last.weightKg - ref.weightKg);
  };

  return {
    latest: last.weightKg,
    latestDate: last.date,
    delta7: deltaFrom(7),
    delta30: deltaFrom(30),
    series,
  };
}

/** 按 date 分组，保持组内原始顺序。缺 date 的记录归到 '' 组，不静默丢弃。 */
export function groupByDate(records) {
  const out = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const key = r && typeof r.date === 'string' ? r.date : '';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}
