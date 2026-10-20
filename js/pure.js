/**
 * 记录整形 / 去重 / 聚合 / CSV —— 从 db.js、store.js 里抽出来的纯净逻辑。
 *
 * 存在的唯一理由是「可测」：Node 里没有 IndexedDB，但同日记账去重、导入合并、
 * daySummary 聚合这些决策必须被断言覆盖，所以它们不能藏在事务回调里。
 * 本文件同样禁止 DOM / db / fetch。
 */

import { round1, sumItems, netKcal, groupByDate } from './nutrition.js';

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const BUSINESS_STORES = ['weights', 'meals', 'exercises', 'waters'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIDENCE = ['high', 'medium', 'low'];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v, fallback = 0) {
  return Math.round(num(v, fallback));
}

function nonNegative(v) {
  const n = num(v);
  return n > 0 ? n : 0;
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function validDate(v) {
  const s = text(v);
  return DATE_RE.test(s) ? s : '';
}

function hasId(rec) {
  return rec && rec.id != null && Number.isFinite(Number(rec.id));
}

/** 单条食物条目：kcal 取整，其余 1 位小数；可选字段缺失就不落键，避免脏字段覆盖库值。 */
export function normalizeMealItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {
    name: text(item.name),
    grams: round1(nonNegative(item.grams)),
    kcal: int(nonNegative(item.kcal)),
    carb: round1(nonNegative(item.carb)),
    protein: round1(nonNegative(item.protein)),
    fat: round1(nonNegative(item.fat)),
  };
  if (item.fiber != null) out.fiber = round1(nonNegative(item.fiber));
  if (item.sodium != null) out.sodium = round1(nonNegative(item.sodium));
  if (CONFIDENCE.includes(item.confidence)) out.confidence = item.confidence;
  const foodId = text(item.foodId);
  if (foodId) out.foodId = foodId;
  return out;
}

export function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map(normalizeMealItem).filter(Boolean);
}

export function normalizeWeightRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const date = validDate(rec.date);
  const weightKg = round1(num(rec.weightKg));
  if (!date || !(weightKg > 0)) return null;
  const out = { date, weightKg };
  if (hasId(rec)) out.id = Number(rec.id);
  if (rec.bodyFatPct != null && Number.isFinite(Number(rec.bodyFatPct))) {
    out.bodyFatPct = round1(Number(rec.bodyFatPct));
  }
  const note = text(rec.note);
  if (note) out.note = note;
  out.createdAt = int(rec.createdAt, Date.now());
  return out;
}

export function normalizeWaterRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const date = validDate(rec.date);
  const ml = Math.max(0, int(rec.ml));
  // ml 归零在业务上等于「删除该日记录」，导入时也不该落一条 0
  if (!date || ml <= 0) return null;
  const out = { date, ml };
  if (hasId(rec)) out.id = Number(rec.id);
  return out;
}

export function normalizeMealRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const date = validDate(rec.date);
  if (!date) return null;
  const out = {
    date,
    slot: SLOTS.includes(rec.slot) ? rec.slot : 'snack',
    items: normalizeItems(rec.items),
    source: rec.source === 'ai' ? 'ai' : 'manual',
    createdAt: int(rec.createdAt, Date.now()),
  };
  if (hasId(rec)) out.id = Number(rec.id);
  const photoId = text(rec.photoId);
  if (photoId) out.photoId = photoId;
  if (typeof rec.rawAiText === 'string' && rec.rawAiText) out.rawAiText = rec.rawAiText;
  return out;
}

export function normalizeExerciseRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const date = validDate(rec.date);
  if (!date) return null;
  const out = {
    date,
    type: text(rec.type) || '其他',
    minutes: round1(nonNegative(rec.minutes)),
    kcalBurned: int(nonNegative(rec.kcalBurned)),
    createdAt: int(rec.createdAt, Date.now()),
  };
  if (hasId(rec)) out.id = Number(rec.id);
  const note = text(rec.note);
  if (note) out.note = note;
  return out;
}

export function normalizeRecord(store, rec) {
  switch (store) {
    case 'weights':
      return normalizeWeightRecord(rec);
    case 'waters':
      return normalizeWaterRecord(rec);
    case 'meals':
      return normalizeMealRecord(rec);
    case 'exercises':
      return normalizeExerciseRecord(rec);
    default:
      return rec && typeof rec === 'object' ? rec : null;
  }
}

/**
 * 去重键。
 * weights/waters 契约上按 date 唯一 → 用日期。
 * meals/exercises 是可重复条目 → 用自增 id；没 id 的历史数据退回内容指纹，
 * 保证同一份导出重复导入不会翻倍。
 */
export function keyOf(store, rec) {
  if (!rec || typeof rec !== 'object') return '';
  if (store === 'weights' || store === 'waters') return `date:${text(rec.date)}`;
  if (hasId(rec)) return `id:${Number(rec.id)}`;
  if (store === 'meals') return `fk:${text(rec.date)}:${text(rec.slot)}:${int(rec.createdAt)}`;
  return `fk:${text(rec.date)}:${text(rec.type)}:${num(rec.minutes)}:${int(rec.kcalBurned)}`;
}

/** 同键重复时后者覆盖前者。 */
export function dedupeByKey(rows, keyFn) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) map.set(keyFn(r), r);
  return [...map.values()];
}

/** 只保留 existing 中不存在的键（导入 merge 一律不覆盖已有数据）。 */
export function pickNewRows(existingRows, incomingRows, keyFn) {
  const seen = new Set((Array.isArray(existingRows) ? existingRows : []).map(keyFn));
  const out = [];
  for (const r of Array.isArray(incomingRows) ? incomingRows : []) {
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 一次导入对某个 store 的落库计划：整形 → 载荷内去重 → 去掉与现有数据冲突的行。 */
export function planImport(store, existingRows, incomingRows) {
  const keyFn = (r) => keyOf(store, r);
  const clean = (Array.isArray(incomingRows) ? incomingRows : [])
    .map((r) => normalizeRecord(store, r))
    .filter(Boolean);
  return pickNewRows(existingRows, dedupeByKey(clean, keyFn), keyFn);
}

/** 餐次聚合：把所有条目的四项 + 纤维 + 钠加到当日合计。 */
export function aggregateMeals(meals) {
  const items = [];
  for (const m of Array.isArray(meals) ? meals : []) {
    for (const it of Array.isArray(m?.items) ? m.items : []) items.push(it);
  }
  return sumItems(items);
}

export function burnedOf(exercises) {
  let total = 0;
  for (const e of Array.isArray(exercises) ? exercises : []) total += nonNegative(e?.kcalBurned);
  return Math.round(total);
}

export function waterOf(water) {
  // water 允许传当日 ml 数字，也允许传 waters 记录
  const raw = water && typeof water === 'object' ? water.ml : water;
  return Math.max(0, Math.round(num(raw)));
}

function byCreatedAtAsc(a, b) {
  return num(a?.createdAt) - num(b?.createdAt);
}

/** 视图核心：一次把当日的摄入/消耗/饮水/体重合成到位。 */
export function buildDaySummary({ date, meals = [], exercises = [], water = 0, weight = null } = {}) {
  const intake = aggregateMeals(meals);
  const burned = burnedOf(exercises);
  const waterMl = waterOf(water);
  return {
    date,
    intake,
    burned,
    water: waterMl,
    netKcal: netKcal(intake.kcal, burned),
    meals: [...(Array.isArray(meals) ? meals : [])].sort(byCreatedAtAsc),
    exercises: [...(Array.isArray(exercises) ? exercises : [])].sort(byCreatedAtAsc),
    weight: weight && typeof weight === 'object' ? weight : null,
  };
}

/** 区间表：只输出真正有数据的日期，方便折线图跳过空档而不是画一条断掉的线。 */
export function buildRangeRows({
  fromDate,
  toDate,
  weights = [],
  meals = [],
  exercises = [],
  waters = [],
} = {}) {
  const from = text(fromDate);
  const to = text(toDate);
  const inRange = (d) => typeof d === 'string' && DATE_RE.test(d) && d >= from && d <= to;
  const map = new Map();
  const row = (date) => {
    if (!map.has(date)) {
      map.set(date, { date, kcal: 0, carb: 0, protein: 0, fat: 0, burned: 0, water: 0, weightKg: null });
    }
    return map.get(date);
  };

  for (const w of Array.isArray(weights) ? weights : []) {
    if (!w || !inRange(w.date)) continue;
    const kg = round1(num(w.weightKg));
    if (kg > 0) row(w.date).weightKg = kg;
  }

  const mealsByDate = groupByDate((Array.isArray(meals) ? meals : []).filter((m) => m && inRange(m.date)));
  for (const [date, list] of mealsByDate) {
    const agg = aggregateMeals(list);
    const r = row(date);
    r.kcal = agg.kcal;
    r.carb = agg.carb;
    r.protein = agg.protein;
    r.fat = agg.fat;
  }

  const exByDate = groupByDate((Array.isArray(exercises) ? exercises : []).filter((e) => e && inRange(e.date)));
  for (const [date, list] of exByDate) row(date).burned = burnedOf(list);

  for (const w of Array.isArray(waters) ? waters : []) {
    if (!w || !inRange(w.date)) continue;
    const ml = waterOf(w);
    if (ml > 0) row(w.date).water = ml;
  }

  return [...map.values()].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',');
}

function byDateThenId(a, b) {
  if (a?.date !== b?.date) return String(a?.date ?? '') < String(b?.date ?? '') ? -1 : 1;
  return num(a?.id) - num(b?.id);
}

/**
 * 四段 CSV（体重 / 饮食明细 / 运动 / 饮水），CRLF + BOM：
 * 手机端用户大概率用 Excel/WPS 打开，缺 BOM 会把中文表头显示成乱码。
 */
export function buildCSV({ weights = [], meals = [], exercises = [], waters = [] } = {}) {
  const lines = [];
  const push = (...cells) => lines.push(csvLine(cells));

  push('# 体重');
  push('date', 'weightKg', 'bodyFatPct', 'note', 'createdAt');
  for (const w of [...(Array.isArray(weights) ? weights : [])].sort(byDateThenId)) {
    push(w.date, w.weightKg, w.bodyFatPct ?? '', w.note ?? '', w.createdAt ?? '');
  }
  lines.push('');

  push('# 饮食明细');
  push('date', 'slot', 'name', 'grams', 'kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium', 'source', 'createdAt');
  for (const m of [...(Array.isArray(meals) ? meals : [])].sort(byDateThenId)) {
    const items = Array.isArray(m.items) && m.items.length ? m.items : [null];
    for (const it of items) {
      push(
        m.date,
        m.slot,
        it?.name ?? '',
        it?.grams ?? '',
        it?.kcal ?? '',
        it?.carb ?? '',
        it?.protein ?? '',
        it?.fat ?? '',
        it?.fiber ?? '',
        it?.sodium ?? '',
        m.source ?? '',
        m.createdAt ?? '',
      );
    }
  }
  lines.push('');

  push('# 运动');
  push('date', 'type', 'minutes', 'kcalBurned', 'note', 'createdAt');
  for (const e of [...(Array.isArray(exercises) ? exercises : [])].sort(byDateThenId)) {
    push(e.date, e.type, e.minutes, e.kcalBurned, e.note ?? '', e.createdAt ?? '');
  }
  lines.push('');

  push('# 饮水');
  push('date', 'ml');
  for (const w of [...(Array.isArray(waters) ? waters : [])].sort(byDateThenId)) {
    push(w.date, w.ml);
  }

  return `\ufeff${lines.join('\r\n')}\r\n`;
}
