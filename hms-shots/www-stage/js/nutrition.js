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
  try {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    // Number(Symbol()) 会抛 TypeError；纯计算层不许把异常漏给调用方
    return fallback;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 夹取到区间；两侧都必须是有限数（调用方只传常量，不做脏值防御）。 */
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
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

// ---------- 《中国居民膳食指南(2022)》每日目标口径 ----------
// 纯函数层：只算数、不碰 DOM / 存储，Node 里可直接 import（顶层零副作用）。

/**
 * 指南口径常量。每条的依据：
 * - carbPctMin/Max 50~65%、fatPctMin/Max 20~30%：指南「平衡膳食宝塔」给出的三大营养素供能比区间。
 * - proteinGPerKg 分档：指南建议成人 1.0~1.2 g/kg；减脂 1.2~1.6、增肌 1.6~2.0 是运动营养学的常见扩展档。
 * - mealSlotPct 30/40/30：早/午/晚三餐供能比，晚餐不过量。
 * - fiber 25~30g：指南膳食纤维推荐量（成人 25~30 g/d）。
 * - sodium ≤2000mg（= 食盐 <5g）：指南「少盐」限值，5g 盐 × 39.3% 钠占比 ≈ 1965mg，取整到 2000mg。
 * - water：指南基线（男 1700 / 女 1500 ml）与 35 ml/kg 取大者 —— 运动量/体重越大越该多喝。
 */
export const GUIDE = Object.freeze({
  carbPctMin: 50,
  carbPctMax: 65,
  fatPctMin: 20,
  fatPctMax: 30,
  fatPctTarget: 25,
  // 碳水 = 剩余供能，但不能低过指南下限（见 dailyTargets 的 50% 兜底）
  carbPctFloor: 50,
  proteinGPerKg: Object.freeze({
    cut: Object.freeze({ min: 1.2, max: 1.6 }),
    maintain: Object.freeze({ min: 1.0, max: 1.2 }),
    bulk: Object.freeze({ min: 1.6, max: 2.0 }),
  }),
  mealSlotPct: Object.freeze({ breakfast: 30, lunch: 40, dinner: 30 }),
  fiberMinG: 25,
  fiberMaxG: 30,
  fiberDefaultG: 25,
  sodiumMaxMg: 2000,
  saltMaxG: 5,
  waterBaseMaleMl: 1700,
  waterBaseFemaleMl: 1500,
  waterPerKgMl: 35,
  waterMinMl: 1500,
  waterMaxMl: 4000,
  calorieTargetMin: 1200,
  calorieTargetMax: 4000,
  // 目标方向 → 在 TDEE 上的调整幅度（%）：减脂 −20 / 维持 0 / 增肌 +10
  calorieAdjustPct: Object.freeze({ cut: -20, maintain: 0, bulk: 10 }),
});

/**
 * 安全默认（档案缺失时用）：60kg / 170cm / 30 岁 / 久坐 / 男。
 * 它是「兜底」，不是「估算」—— 只保证不抛、不 NaN、落在合理区间，方便用户再手改。
 */
export const SAFE_TARGET_INPUT = Object.freeze({
  sex: 'male',
  weightKg: 60,
  heightCm: 170,
  age: 30,
  activity: 'sedentary',
});

const MIN_WEIGHT_KG = 20;
const MAX_WEIGHT_KG = 300;
const MIN_HEIGHT_CM = 80;
const MAX_HEIGHT_CM = 250;
const MIN_AGE = 10;
const MAX_AGE = 120;

const GOAL_KINDS = ['cut', 'maintain', 'bulk'];

// 显式档位名的别名（中文界面直接传 '减脂' 也要认出）
const GOAL_KIND_ALIASES = {
  cut: 'cut', 减脂: 'cut', 减肥: 'cut', 减重: 'cut',
  maintain: 'maintain', 维持: 'maintain', 保持: 'maintain',
  bulk: 'bulk', 增肌: 'bulk', 增重: 'bulk',
};

/** 档位名归一：认英文/中文别名，认不出来返回 null（交给调用方回落推断）。 */
function goalKindOf(value) {
  if (typeof value !== 'string') return null;
  return GOAL_KIND_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** 档内取中值：减脂 1.4 / 维持 1.1 / 增肌 1.8 g/kg。 */
function midOf(range) {
  return (range.min + range.max) / 2;
}

/**
 * 目标方向推断：目标体重 < 当前 → 减脂；> → 增肌；相等 / 缺失 → 维持。
 * 导出给 store.js 复用，避免两处各写一份推断逻辑后慢慢跑偏。
 */
export function inferGoalKind(weightKg, weightTargetKg) {
  const target = num(weightTargetKg);
  if (!(target > 0) || !(weightKg > 0)) return 'maintain';
  const diff = round1(weightKg - target);
  if (diff > 0) return 'cut';
  if (diff < 0) return 'bulk';
  return 'maintain';
}

/** 三餐供能比合计必定 100。 */
function mealPctSum() {
  const slots = Object.keys(GUIDE.mealSlotPct);
  return slots.reduce((sum, slot) => sum + GUIDE.mealSlotPct[slot], 0);
}

/**
 * 按个人数据推算每日营养目标：比例与克数都给。非法 / 缺失入参一律回落安全默认，绝不抛、绝不 NaN。
 *
 * 口径（《中国居民膳食指南(2022)》）：
 * - 热量：Mifflin-St Jeor BMR × 活动量 = TDEE，再按目标方向调整（减脂 −20% / 维持 0% / 增肌 +10%），clamp 1200~4000。
 * - 蛋白质：体重 × 档内中值 g/kg（显式 proteinGPerKg 优先，越界夹到该档区间）。
 * - 脂肪：指南中值 25% 供能 → 克数 = 热量 × 25% ÷ 9。
 * - 碳水：剩余供能（100% − 蛋白 − 脂肪）÷ 4；低于指南下限 50% 时按 50% 兜底并把
 *   蛋白/脂肪按比例压回剩余供能，保证三者占比仍自洽（和恒为 100）。
 * - 纤维 25g（可在入参覆盖）/ 钠 ≤2000mg（同上）；饮水取 max(指南基线, 35ml/kg)，取整 50ml。
 *
 * 克数与占比都按同一组份额反算，所以 4×蛋白 + 4×碳水 + 9×脂肪 ≈ 热量（1 位小数舍入误差 ≤ 2 kcal）。
 */
export function dailyTargets(input) {
  const src = input && typeof input === 'object' ? input : {};
  const sex = src.sex === 'female' ? 'female' : 'male';

  // 体重 / 身高 / 年龄为 0 或非有限 → 回落安全默认（调用方如果真给了 0，说明档案没填）
  // 真实体重（可能缺失）；下面给 BMR/饮水用的兜底值不能拿去推断目标方向，
  // 否则「没有体重记录 + 目标体重 65」会被拿 60kg 兜底值判成增肌。
  const rawWeightKg = num(src.weightKg);
  let weightKg = rawWeightKg;
  if (!(weightKg > 0)) weightKg = SAFE_TARGET_INPUT.weightKg;
  weightKg = Math.min(MAX_WEIGHT_KG, Math.max(MIN_WEIGHT_KG, weightKg));

  let heightCm = num(src.heightCm);
  if (!(heightCm > 0)) heightCm = SAFE_TARGET_INPUT.heightCm;
  heightCm = Math.min(MAX_HEIGHT_CM, Math.max(MIN_HEIGHT_CM, heightCm));

  let age = num(src.age);
  if (!(age > 0)) age = SAFE_TARGET_INPUT.age;
  age = Math.min(MAX_AGE, Math.max(MIN_AGE, age));

  const activity = ACTIVITY_FACTORS[src.activity] ? src.activity : 'sedentary';
  const weightTargetKg = num(src.weightTargetKg) > 0 ? num(src.weightTargetKg) : null;

  // 目标方向：显式 > 按目标体重推断
  const explicit = goalKindOf(src.goalKind);
  const goalKind = explicit || inferGoalKind(rawWeightKg, weightTargetKg);
  const range = GUIDE.proteinGPerKg[goalKind];
  const calorieAdjustPct = GUIDE.calorieAdjustPct[goalKind];

  // 蛋白质 g/kg：显式值合法就用它，否则取档内中值；显式值越界 / 脏值一律夹到该档区间
  const wanted = num(src.proteinGPerKg);
  const gPerKg = wanted > 0
    ? Math.min(range.max, Math.max(range.min, wanted))
    : midOf(range);

  const fiberRaw = num(src.fiberG);
  const fiberG = round1(fiberRaw > 0
    ? clamp(fiberRaw, GUIDE.fiberMinG, GUIDE.fiberMaxG)
    : GUIDE.fiberDefaultG);

  const sodiumRaw = num(src.sodiumMg);
  const sodiumMg = Math.round(sodiumRaw > 0
    ? clamp(sodiumRaw, 500, GUIDE.sodiumMaxMg)
    : GUIDE.sodiumMaxMg);

  const bmr = bmrMifflinStJeor({ sex, weightKg, heightCm, age });
  const daily = tdee(bmr, activity);
  const rawKcal = daily * (1 + calorieAdjustPct / 100);
  const autoKcal = clamp(
    Math.round(Number.isFinite(rawKcal) ? rawKcal : GUIDE.calorieTargetMin),
    GUIDE.calorieTargetMin,
    GUIDE.calorieTargetMax,
  );
  // 用户在设置里填过热量目标就以它为准：否则今日页顶部的环/pill（用 goals.calorieTarget）
  // 会与这里的推算值打架，同一屏出现两个热量目标。克数一律按最终热量反算。
  const overrideKcal = num(src.calorieTarget);
  const calorieTarget = overrideKcal > 0
    ? clamp(Math.round(overrideKcal), GUIDE.calorieTargetMin, GUIDE.calorieTargetMax)
    : autoKcal;

  // ---- 三大营养素：先算份额，再按同一组份额反算克数（保证「占比和 = 100%」和克数守恒同时成立）----
  let proteinShare = (weightKg * gPerKg * 4) / calorieTarget;
  let fatShare = GUIDE.fatPctTarget / 100;

  if (proteinShare + fatShare > 1) {
    // 极端档案（体重大 / 热量低）下蛋白+脂肪会吃满热量，碳水就没位置了
    proteinShare = Math.min(1, proteinShare);
    fatShare = 0;
  }
  let carbShare = 1 - proteinShare - fatShare;

  if (carbShare < GUIDE.carbPctFloor / 100) {
    // 碳水低于指南下限：兜到 50%，蛋白与脂肪按现有份额的比例压回剩下 50%（保持相对关系不失真）
    const rest = Math.max(1e-9, proteinShare + fatShare);
    const scale = 0.5 / rest;
    carbShare = 0.5;
    proteinShare *= scale;
    fatShare *= scale;
  }

  // 占比取整：碳水 = 100 − 蛋白 − 脂肪，保证整数和恒为 100
  const proteinPctInt = Math.round(proteinShare * 100);
  const fatPctInt = Math.round(fatShare * 100);
  const carbPctInt = 100 - proteinPctInt - fatPctInt;

  // 克数按各自的占比反算（同一组份额），4/4/9 反推热量 ≈ calorieTarget
  const proteinG = round1((proteinShare * calorieTarget) / 4);
  const fatG = round1((fatShare * calorieTarget) / 9);
  const carbG = round1((carbShare * calorieTarget) / 4);

  // 饮水：指南基线（男 1700 / 女 1500）与 35ml/kg 取大者，取整到 50ml，clamp 1500~4000
  const waterBaseMl = sex === 'female' ? GUIDE.waterBaseFemaleMl : GUIDE.waterBaseMaleMl;
  const waterRaw = Math.max(waterBaseMl, weightKg * GUIDE.waterPerKgMl);
  const waterMl = clamp(Math.round(waterRaw / 50) * 50, GUIDE.waterMinMl, GUIDE.waterMaxMl);

  return {
    calorieTarget,
    protein: { g: proteinG, pct: proteinPctInt, gPerKg: round1(gPerKg) },
    fat: { g: fatG, pct: fatPctInt },
    carb: { g: carbG, pct: carbPctInt },
    fiber: { g: fiberG },
    sodium: { mg: sodiumMg },
    water: { ml: waterMl },
    // 界面「依据」行用：基础代谢 → 每日消耗 → 目标调整
    basis: { calorieFromGoal: overrideKcal > 0, autoCalorieTarget: autoKcal,
      goalKind,
      gPerKg: round1(gPerKg),
      calorieAdjustPct,
      bmr,
      tdee: daily,
    },
  };
}

/**
 * 某一餐应吃多少：取 dailyTargets 的结果 + 餐次，按三餐供能比（早 30 / 午 40 / 晚 30）切分。
 * 'snack'（加餐）不分配 → 返回 null；非法 slot / 非法 targets 同样返回 null（调用方不必先校验）。
 */
export function mealTargetsOf(targets, slot) {
  const share = typeof slot === 'string' ? GUIDE.mealSlotPct[slot] : undefined;
  if (!share) return null;
  const t = targets && typeof targets === 'object' ? targets : null;
  if (!t) return null;
  const kcal = num(t.calorieTarget);
  if (!(kcal > 0) || !Number.isInteger(kcal)) return null;
  const shareSum = mealPctSum();
  const pct = share / shareSum;
  const grams = (value) => round1(num(value) * pct);
  const out = {
    kcal: Math.round(kcal * pct),
    carbG: grams(t.carb?.g),
    proteinG: grams(t.protein?.g),
    fatG: grams(t.fat?.g),
    fiberG: grams(t.fiber?.g),
  };
  // 三餐热量之和必须正好等于日总量（独立取整会让 30/40/30 对不上）：
  // 前两餐按比例取整，最后一餐吃余数 —— 它是 round(kcal×0.3) + round(kcal×0.4) 的差，
  // 与独立取整最多差 1 kcal。
  const lastSlot = Object.keys(GUIDE.mealSlotPct).pop();
  if (slot === lastSlot) out.kcal = kcal - lastMealKcalBefore(kcal, shareSum, lastSlot);
  return out;
}

/** 最后一餐之前各餐的取整热量之和。 */
function lastMealKcalBefore(kcal, shareSum, lastSlot) {
  let sum = 0;
  for (const [key, pct] of Object.entries(GUIDE.mealSlotPct)) {
    if (key === lastSlot) continue;
    sum += Math.round((kcal * pct) / shareSum);
  }
  return sum;
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
