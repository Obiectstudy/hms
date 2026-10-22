/**
 * 记录整形 / 去重 / 聚合 / CSV —— 从 db.js、store.js 里抽出来的纯净逻辑。
 *
 * 存在的唯一理由是「可测」：Node 里没有 IndexedDB，但同日记账去重、导入合并、
 * daySummary 聚合这些决策必须被断言覆盖，所以它们不能藏在事务回调里。
 * 本文件同样禁止 DOM / db / fetch。
 */

import { round1, sumItems, netKcal, groupByDate, localDateStr, parseDateStr } from './nutrition.js';

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
  // 强度档：trim 后 ≤16 字符才落库，超长/非字符串一律丢弃（不写进 CSV 列）
  const intensity = text(rec.intensity);
  if (intensity && intensity.length <= 16) out.intensity = intensity;
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

// ---------- 套餐模板（meta.mealTemplates） ----------
// 套餐存在 meta 里而不是新 object store：加 store 要抬 IDB 版本号，
// 老设备的升级失败率远高于这点收益。脏数据一律过滤，绝不抛。
// 两种形状共用同一个 id/name 空间：单餐 kind='meal'（slot+items），整日 kind='day'（meals ≥ 2）。
// v1.4 之前落库的记录没有 kind，一律按单餐识别 —— 老数据不需要用户重存。

/** 整日套餐的餐次：非法 slot 回退 snack，空 items 的餐次直接剔除。 */
export function normalizeDayMeals(meals) {
  const out = [];
  for (const rec of Array.isArray(meals) ? meals : []) {
    if (!rec || typeof rec !== 'object') continue;
    const items = normalizeItems(rec.items);
    if (!items.length) continue;
    out.push({ slot: SLOTS.includes(rec.slot) ? rec.slot : 'snack', items });
  }
  return out;
}

/** 单条套餐：id 与 name 缺一不可；kind='day' 的 meals 归一化后不足 2 餐视为非法。 */
export function normalizeMealTemplate(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const id = rec.id == null ? '' : String(rec.id).trim();
  const name = text(rec.name);
  if (!id || !name) return null;
  if (rec.kind === 'day') {
    const meals = normalizeDayMeals(rec.meals);
    return meals.length >= 2 ? { id, name, kind: 'day', meals } : null;
  }
  return {
    id,
    name,
    kind: 'meal',
    slot: SLOTS.includes(rec.slot) ? rec.slot : 'snack',
    items: normalizeItems(rec.items),
  };
}

/** 数组级整形：非数组 -> []，非法条目忽略，重复 id 只留第一条。 */
export function normalizeMealTemplates(rows) {
  const out = [];
  const seen = new Set();
  for (const rec of Array.isArray(rows) ? rows : []) {
    const t = normalizeMealTemplate(rec);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * 保存单餐套餐的纯逻辑（不碰 IDB）：name 去首尾空格，同名覆盖并保留原 id。
 * now 只在新建时用来生成 id（String(now)），测试可注入固定时间。
 */
export function planMealTemplateSave(existing, input, now = Date.now()) {
  const list = normalizeMealTemplates(existing);
  const src = input && typeof input === 'object' ? input : {};
  const name = text(src.name);
  if (!name) throw new Error('套餐名称不能为空');
  const slot = SLOTS.includes(src.slot) ? src.slot : 'snack';
  const items = normalizeItems(src.items);

  const index = list.findIndex((t) => t.name === name);
  if (index >= 0) {
    // 显式重建而不是展开旧对象：被同名整日套餐覆盖时不能把 meals 键留下来
    const template = { id: list[index].id, name, kind: 'meal', slot, items };
    list[index] = template;
    return { templates: list, template: { ...template } };
  }

  const used = new Set(list.map((t) => t.id));
  let stamp = Math.trunc(num(now, Date.now()));
  // 同一毫秒内连存两个新套餐时，硬撞 id 会把前一个顶掉：顺延到下一个空位
  while (used.has(String(stamp))) stamp += 1;
  const template = { id: String(stamp), name, kind: 'meal', slot, items };
  list.push(template);
  return { templates: list, template: { ...template } };
}

/**
 * 保存整日套餐的纯逻辑：与单餐套餐同一套名称覆盖语义（同名保留原 id）。
 * meals 归一化后不足 2 餐（空数组、全非法、或只剩一餐）抛中文错。
 */
export function planDayTemplateSave(existing, input, now = Date.now()) {
  const list = normalizeMealTemplates(existing);
  const src = input && typeof input === 'object' ? input : {};
  const name = text(src.name);
  if (!name) throw new Error('套餐名称不能为空');
  const meals = normalizeDayMeals(src.meals);
  if (meals.length < 2) throw new Error('整日套餐至少要两餐');

  const index = list.findIndex((t) => t.name === name);
  if (index >= 0) {
    const template = { id: list[index].id, name, kind: 'day', meals };
    list[index] = template;
    return { templates: list, template: { ...template } };
  }

  const used = new Set(list.map((t) => t.id));
  let stamp = Math.trunc(num(now, Date.now()));
  while (used.has(String(stamp))) stamp += 1;
  const template = { id: String(stamp), name, kind: 'day', meals };
  list.push(template);
  return { templates: list, template: { ...template } };
}

export function removeMealTemplate(templates, id) {
  const key = id == null ? '' : String(id).trim();
  return normalizeMealTemplates(templates).filter((t) => t.id !== key);
}

// ---------- 最近吃过的食物 ----------

function byRecentFirst(a, b) {
  const da = text(a?.date);
  const dbDate = text(b?.date);
  if (da !== dbDate) return da < dbDate ? 1 : -1;
  return num(b?.createdAt) - num(a?.createdAt);
}

/**
 * 最近 200 条 meals（date 降序、同日 createdAt 降序）里按 item.name 去重，
 * 保留每个名字**最新一次**出现的信息（首次遍历到的即最新）。
 * 输出顺序 = 首次出现顺序（最新的在最前），limit 在去重之后生效。
 */
export function collectRecentFoodItems(meals, limit = 12) {
  const max = Math.max(0, Math.floor(num(limit, 12)));
  if (max <= 0) return [];
  const rows = (Array.isArray(meals) ? meals : [])
    .filter((m) => m && typeof m === 'object')
    .sort(byRecentFirst)
    .slice(0, 200);

  const out = [];
  const seen = new Set();
  for (const meal of rows) {
    const date = text(meal.date);
    for (const item of Array.isArray(meal.items) ? meal.items : []) {
      if (!item || typeof item !== 'object') continue;
      const name = text(item.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        lastDate: date,
        slot: SLOTS.includes(meal.slot) ? meal.slot : 'snack',
        item,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 上次导出的本地日期与今天相差几天；时间戳非法返回 null。未来时间按今天算（0）。 */
export function daysSinceExport(lastExportedAt, now = new Date()) {
  const ts = Number(lastExportedAt);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const exported = localDateStr(new Date(ts));
  const today = localDateStr(now);
  if (!exported || !today) return null;
  const diff = parseDateStr(today).getTime() - parseDateStr(exported).getTime();
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, Math.round(diff / 86400000));
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
