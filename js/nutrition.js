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

/** 取整；非有限值一律归 0（与 round1 同口径：溢出也是「非有限」，不许吐 ±Infinity）。 */
function safeInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * 保留 1 位小数；非有限值一律归 0，避免 NaN 顺着聚合污染整个页面。
 * 「非有限」既指入参，也指中间量：1e308 这类有限大数乘 10 就溢出成 Infinity，
 * 只挡入参的话结果会带着 Infinity 漏进聚合，所以舍入后要再挡一次。
 */
export function round1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10) / 10;
  if (!Number.isFinite(r)) return 0;
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

// ---------- 作息偏移 → 餐次槽位 ----------
// 窗口口径沿用 views/food.js defaultSlot()：<10 点早餐 / <15 点午餐 / <21 点晚餐 / 其余加餐，
// 换算成「一天中的第几分钟」就是 600 / 900 / 1260 三个边界。

const SLOT_DAY_MINUTES = 1440;
const SLOT_EDGES = [
  { until: 600, slot: 'breakfast' },
  { until: 900, slot: 'lunch' },
  { until: 1260, slot: 'dinner' },
];

/** 分钟 / 偏移的脏值归零：非有限、Symbol、连 Number() 都不吃的一律当 0（不抛）。 */
function slotNumber(value) {
  if (typeof value === 'symbol') return 0;
  try {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 一天中的第几分钟（0..1439）→ 餐次槽位。
 * offsetMinutes 是作息偏移（分钟，可正可负）：判定前先把当前时刻**减去**偏移，
 * 整条窗口随之平移 —— 偏移为正 = 作息整体后移，+120 分钟时 14:00 按 12:00 判定。
 * 越界（含跨午夜）按一天 1440 分钟循环折算；非有限入参回落到 0 分（凌晨），绝不抛异常。
 */
export function slotFromMinutes(minutes, offsetMinutes = 0) {
  const shifted = Math.round(slotNumber(minutes)) - Math.round(slotNumber(offsetMinutes));
  let m = shifted % SLOT_DAY_MINUTES;
  if (!Number.isFinite(m)) m = 0;
  if (m < 0) m += SLOT_DAY_MINUTES;
  for (const edge of SLOT_EDGES) {
    if (m < edge.until) return edge.slot;
  }
  return 'snack';
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

/** 4/4/9 反算热量，取整。缺字段按 0；乘积/加和溢出成 ±Infinity 时归 0。 */
export function kcalFromMacros({ carb, protein, fat } = {}) {
  return safeInt(4 * num(carb) + 4 * num(protein) + 9 * num(fat));
}

/** 每 100g 营养值 × 实际克数；kcal 取整，其余 1 位小数（比例乘法溢出时归 0）。 */
export function scaleFood(per100g, grams) {
  const p = per100g && typeof per100g === 'object' ? per100g : {};
  const f = Math.max(0, num(grams)) / 100;
  return {
    kcal: safeInt(num(p.kcal) * f),
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
    kcal: safeInt(kcal),
    carb: round1(carb),
    protein: round1(protein),
    fat: round1(fat),
    fiber: round1(fiber),
    sodium: round1(sodium),
  };
}

/** 净值 = 摄入 − 运动消耗，取整；相减溢出（1e308 − (−1e308)）时归 0。 */
export function netKcal(intakeKcal, burnedKcal) {
  return safeInt(num(intakeKcal) - num(burnedKcal));
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

/**
 * BMI 反算体重（kg），保留 1 位；身高或 BMI 非法返回 null。
 * 给「距下一档边界还差几公斤」的标尺用。
 */
export function weightForBmi(bmiValue, heightCm) {
  const b = num(bmiValue);
  const h = num(heightCm) / 100;
  if (!(b > 0) || !(h > 0)) return null;
  return round1(b * h * h);
}

// 中国成人分档的边界：<18.5 偏瘦 | 18.5–24 正常 | 24–28 超重 | ≥28 肥胖
const BMI_THRESHOLDS = [18.5, 24, 28];
const BMI_LABELS = ['偏瘦', '正常', '超重', '肥胖'];

function bmiBandIndex(v) {
  if (v < BMI_THRESHOLDS[0]) return 0;
  if (v < BMI_THRESHOLDS[1]) return 1;
  if (v < BMI_THRESHOLDS[2]) return 2;
  return 3;
}

/**
 * 距相邻档位的边界还差多少 kg（当前体重与边界体重的差的绝对值，1 位小数）。
 * lower = 更低一档的边界，已是最低档 → null；upper = 更高一档的边界，已是最高档 → null。
 * label 取相邻档位的名字（跨过该边界就会进入那一档），与 bmiClass() 的档位名一致。
 */
export function bmiGaps(bmiValue, heightCm) {
  const v = num(bmiValue);
  const h = num(heightCm) / 100;
  if (!(v > 0) || !(h > 0)) return { lower: null, upper: null };
  const band = bmiBandIndex(v);
  const kgTo = (boundary) => round1(Math.abs(v * h * h - boundary * h * h));
  return {
    lower: band > 0
      ? { label: BMI_LABELS[band - 1], kg: kgTo(BMI_THRESHOLDS[band - 1]) }
      : null,
    upper: band < BMI_LABELS.length - 1
      ? { label: BMI_LABELS[band + 1], kg: kgTo(BMI_THRESHOLDS[band]) }
      : null,
  };
}

// ---------- 运动消耗 ----------
// MET 量级取自 Compendium of Physical Activities（那是**总消耗**口径）；
// 记账用 estimateBurn 换算成净消耗 (MET − 1)，只算「因为运动额外多烧的」。
// group 供界面做 optgroup；带 intensities 的类型 met 取中档（不选强度时的默认）。

const OTHER_MET = 4.0;

export const EXERCISE_TYPES = [
  {
    value: 'walk', label: '走路', group: '有氧', met: 3.5,
    intensities: [
      { value: 'stroll', label: '散步 <4km/h', met: 3.0 },
      { value: 'normal', label: '常速 4–5.5km/h', met: 3.5 },
      { value: 'brisk', label: '快走 >5.5km/h', met: 4.3 },
    ],
  },
  {
    value: 'jog', label: '跑步', group: '有氧', met: 9.0,
    intensities: [
      { value: 'easy', label: '慢跑', met: 6.0 },
      { value: 'steady', label: '中速', met: 9.0 },
      { value: 'fast', label: '快跑', met: 11.0 },
    ],
  },
  {
    value: 'swim', label: '游泳', group: '有氧', met: 7.0,
    intensities: [
      { value: 'easy', label: '慢速', met: 5.0 },
      { value: 'steady', label: '一般', met: 7.0 },
      { value: 'fast', label: '快速', met: 9.8 },
    ],
  },
  {
    value: 'rope', label: '跳绳', group: '有氧', met: 11.0,
    intensities: [
      { value: 'easy', label: '慢速', met: 8.8 },
      { value: 'steady', label: '一般', met: 11.0 },
      { value: 'fast', label: '快速', met: 12.3 },
    ],
  },
  { value: 'elliptical', label: '椭圆机', group: '有氧', met: 5.0 },
  {
    value: 'rower', label: '划船机', group: '有氧', met: 7.0,
    intensities: [
      { value: 'light', label: '轻', met: 4.8 },
      { value: 'steady', label: '中', met: 7.0 },
      { value: 'hard', label: '重', met: 8.5 },
    ],
  },
  {
    value: 'stairs', label: '爬楼梯', group: '有氧', met: 8.0,
    intensities: [
      { value: 'down', label: '下楼', met: 3.5 },
      { value: 'up', label: '上楼', met: 8.0 },
      { value: 'both', label: '上下往返', met: 9.0 },
    ],
  },
  {
    value: 'hiit', label: 'HIIT', group: '有氧', met: 9.0,
    intensities: [
      { value: 'light', label: '轻', met: 7.0 },
      { value: 'steady', label: '中', met: 9.0 },
      { value: 'hard', label: '重', met: 11.0 },
    ],
  },
  {
    value: 'dance', label: '舞蹈', group: '有氧', met: 5.5,
    intensities: [
      { value: 'social', label: '休闲', met: 4.5 },
      { value: 'general', label: '一般', met: 5.5 },
      { value: 'aerobic', label: '剧烈', met: 7.3 },
    ],
  },
  {
    value: 'hike', label: '徒步', group: '户外', met: 6.3,
    intensities: [
      { value: 'flat', label: '平地', met: 5.0 },
      { value: 'hill', label: '爬坡', met: 6.3 },
      { value: 'loaded', label: '重装爬坡', met: 8.0 },
    ],
  },
  {
    value: 'bike', label: '骑行', group: '户外', met: 8.0,
    intensities: [
      { value: 'casual', label: '休闲 <16km/h', met: 4.0 },
      { value: 'commute', label: '通勤 16–19km/h', met: 6.0 },
      { value: 'road', label: '公路车 20–25km/h', met: 8.0 },
      { value: 'spin', label: '动感单车', met: 8.5 },
      { value: 'climb', label: '爬坡 / >25km/h', met: 10.0 },
    ],
  },
  { value: 'climb', label: '攀岩', group: '户外', met: 8.0 },
  { value: 'ski', label: '滑雪', group: '户外', met: 7.0 },
  { value: 'skate', label: '滑板', group: '户外', met: 5.0 },
  {
    value: 'strength', label: '力量训练', group: '力量', met: 5.0,
    intensities: [
      { value: 'light', label: '轻', met: 3.5 },
      { value: 'steady', label: '中', met: 5.0 },
      { value: 'hard', label: '重', met: 6.0 },
    ],
  },
  {
    value: 'badminton', label: '羽毛球', group: '球类', met: 5.5,
    intensities: [
      { value: 'casual', label: '休闲', met: 4.5 },
      { value: 'general', label: '一般', met: 5.5 },
      { value: 'match', label: '比赛', met: 7.0 },
    ],
  },
  { value: 'pingpong', label: '乒乓球', group: '球类', met: 4.0 },
  { value: 'basketball', label: '篮球', group: '球类', met: 6.5 },
  { value: 'soccer', label: '足球', group: '球类', met: 7.0 },
  { value: 'tennis', label: '网球', group: '球类', met: 7.3 },
  { value: 'yoga', label: '瑜伽', group: '其他', met: 2.5 },
  { value: 'pilates', label: '普拉提', group: '其他', met: 3.0 },
  { value: 'taichi', label: '太极', group: '其他', met: 3.0 },
  { value: 'other', label: '其他', group: '其他', met: OTHER_MET },
];

/** 类型的 MET；未知 type → 'other' 的 MET，未知 intensity → 该类型的默认 MET。 */
export function exerciseMet(type, intensity) {
  const hit = EXERCISE_TYPES.find((t) => t.value === type);
  if (!hit) return OTHER_MET;
  const list = Array.isArray(hit.intensities) ? hit.intensities : [];
  const want = typeof intensity === 'string' ? intensity.trim() : '';
  if (want) {
    const found = list.find((i) => i.value === want);
    if (found) return found.met;
  }
  return hit.met;
}

/**
 * 运动净消耗，取整：max(0, (MET − 1) × 体重kg × 小时)。
 * 扣掉 1 个 MET 的基础代谢，得到「因为运动额外多烧的」热量——减脂记账该用的数。
 * 时长 / 体重非正或非有限数一律 0。
 */
export function estimateBurn(rec = {}) {
  const src = rec && typeof rec === 'object' ? rec : {};
  const minutes = num(src.minutes);
  const weightKg = num(src.weightKg);
  if (!(minutes > 0) || !(weightKg > 0)) return 0;
  // 乘积可能溢出成 Infinity（时长/体重是有限大数时），Math.max(0, Infinity) 挡不住 → 先归 0
  return Math.max(0, safeInt((exerciseMet(src.type, src.intensity) - 1) * weightKg * (minutes / 60)));
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

/**
 * 移动平均：avg = 最近 window 个点（含当前点）的算术平均，1 位小数。
 * - 入参 series 按 date 升序，返回**同长度、同顺序**的 [{ date, value, avg }]，不改入参、不重排。
 * - 窗口内有效点 < 2 → avg = null：单点连不成趋势，画出来是假信号。
 *   由此推出 window=1 的语义：窗口最多只装得下 1 个有效点，所以 avg 恒为 null。
 * - value 非有限数的点 avg=null，且不参与任何窗口的平均（脏点不能污染趋势）。
 */
export function movingAverage(series, size = 7) {
  const rows = Array.isArray(series) ? series : [];
  const span = Math.max(1, Math.floor(num(size, 7)));
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
    const date = typeof row.date === 'string' ? row.date : '';
    const values = [];
    for (let j = Math.max(0, i - span + 1); j <= i; j += 1) {
      const n = Number(rows[j]?.value);
      if (Number.isFinite(n)) values.push(n);
    }
    const avg = Number.isFinite(Number(row.value)) && values.length >= 2
      ? round1(values.reduce((sum, n) => sum + n, 0) / values.length)
      : null;
    out.push({ date, value: row.value, avg });
  }
  return out;
}

// ---------- 体重单位换算 ----------
// 存储永远是 kg（weights.weightKg / daySummary().weight / weightStats() 都不变），
// 斤只是「显示与输入」单位；导出 CSV/JSON 同样保持 kg，跨单位备份才一致。

/** 'jin' = 斤（1 斤 = 0.5 kg）。数组顺序即界面里的切换顺序。 */
export const WEIGHT_UNITS = Object.freeze(['kg', 'jin']);

const UNIT_LABELS = { kg: 'kg', jin: '斤' };
const UNIT_STEPS = { kg: 0.1, jin: 0.2 };
const UNIT_RANGES = { kg: { min: 20, max: 300 }, jin: { min: 40, max: 600 } };

/** 未知单位（旧数据、手改数据）一律按 kg 处理，绝不抛异常。 */
function unitKey(unit) {
  return unit === 'jin' ? 'jin' : 'kg';
}

/** 保留 2 位小数；用途同 round1，把 90.60000000000001 这类浮点尾巴收口，乘 100 溢出同样归 0。 */
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 100) / 100;
  if (!Number.isFinite(r)) return 0;
  return Object.is(r, -0) ? 0 : r;
}

export function weightUnitLabel(unit) {
  return UNIT_LABELS[unitKey(unit)];
}

/** kg -> 显示单位，1 位小数。 */
export function kgToUnit(kg, unit) {
  const v = num(kg);
  return unitKey(unit) === 'jin' ? round1(v * 2) : round1(v);
}

/** 显示单位 -> kg（入库前必须过这一步），2 位小数。 */
export function unitToKg(value, unit) {
  const v = num(value);
  return unitKey(unit) === 'jin' ? round2(v / 2) : round2(v);
}

/** 刻度步长：斤的步长取 0.2，换算后仍落在 0.1kg 网格上。 */
export function weightStep(unit) {
  return UNIT_STEPS[unitKey(unit)];
}

/** 滑动刻度的边界（返回新对象，调用方改不坏配置）。 */
export function weightRange(unit) {
  const r = UNIT_RANGES[unitKey(unit)];
  return { min: r.min, max: r.max };
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
