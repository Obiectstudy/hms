/**
 * 记录整形 / 去重 / 聚合 / CSV —— 从 db.js、store.js 里抽出来的纯净逻辑。
 *
 * 存在的唯一理由是「可测」：Node 里没有 IndexedDB，但同日记账去重、导入合并、
 * daySummary 聚合这些决策必须被断言覆盖，所以它们不能藏在事务回调里。
 * 本文件同样禁止 DOM / db / fetch。
 */

import { round1, sumItems, netKcal, groupByDate, localDateStr, parseDateStr } from './nutrition.js';

/**
 * 云同步的密钥边界（SYNC_EXCLUDED_SETTINGS / stripSyncSecrets / mergeRemoteIntoLocal）
 * 实现住在 js/sync.js：那边被既有断言钉死「源码零网络零 DOM 且不含跨模块引用」，实现只能放在那边。
 * 这里原样再导出，所以 db.js / store.js 拿到的与 sync.js 用的是同一份实现
 * （logic 用例钉住三个名字身份相等，杜绝两份实现漂移）。
 */
export { SYNC_EXCLUDED_SETTINGS, stripSyncSecrets, mergeRemoteIntoLocal } from './sync.js';

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

/**
 * 日期：先过形状，再过日历 —— parseDateStr 会把 2026-02-31 / 13 月 / 0000-01-01 判成 Invalid Date。
 * 与 nutrition.parseDateStr 同口径，避免「形状合法但不存在」的日期落库后打不开任何一天。
 */
function validDate(v) {
  const s = text(v);
  if (!DATE_RE.test(s)) return '';
  return Number.isNaN(parseDateStr(s).getTime()) ? '' : s;
}

/**
 * 记录有没有「真正的」id：只认有限数值与非空数字串。
 * 不能用 Number.isFinite(Number(rec.id)) —— Number('') === 0、Number([]) === 0、Number(false) === 0，
 * 空 id 会被折成 id:0，去重键随之把所有这类记录折叠成一条（导入静默丢行）。
 */
function hasId(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const id = rec.id;
  if (typeof id === 'number') return Number.isFinite(id);
  if (typeof id === 'string') return id.trim() !== '' && Number.isFinite(Number(id));
  return false;
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
 * 内容摘要（FNV-1a 双种子拼成 16 位 hex = 64 位）。
 * 指纹里不放原始文本：条目名可能自带 'undefined' / '[object Object]' 字面量，键必须干净；
 * 摘要同时也比整串 items 紧凑得多。
 */
function digest16(value) {
  let a = 0x811c9dc5;
  let b = 0x7f4a7c15;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 餐次内容指纹：字段顺序固定，先按落库口径整形再摘要（raw 与已落库的记录算出同一个键）。 */
function mealItemsDigest(items) {
  const rows = normalizeItems(items).map((it) => [
    it.name, it.grams, it.kcal, it.carb, it.protein, it.fat,
    it.fiber ?? null, it.sodium ?? null, it.confidence ?? null, it.foodId ?? null,
  ]);
  return digest16(JSON.stringify(rows));
}

/**
 * 去重键。
 * weights/waters 契约上按 date 唯一 → 用日期。
 * meals/exercises 是可重复条目 → 用自增 id；没 id 的历史数据退回**内容**指纹，
 * 保证同一份导出重复导入不会翻倍。
 * meals 的指纹不含 createdAt：那是 normalize 时现生成的 Date.now()，带进指纹的话
 * 「没有 createdAt 的 JSON」每导入一次都算新记录（当天餐次与热量翻倍）。
 */
export function keyOf(store, rec) {
  if (!rec || typeof rec !== 'object') return '';
  if (store === 'weights' || store === 'waters') return `date:${text(rec.date)}`;
  if (hasId(rec)) return `id:${Number(rec.id)}`;
  if (store === 'meals') {
    const slot = SLOTS.includes(rec.slot) ? rec.slot : 'snack';
    return `fk:${text(rec.date)}:${slot}:${mealItemsDigest(rec.items)}`;
  }
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

/**
 * 套餐的 createdAt：只认有限数值与数字串（取整），其余（缺键 / null / 'abc' / 对象）一律 null。
 * 老记录没有这个键 -> 不补：凭空编一个时间戳会让「原地编辑保留 createdAt」变成假承诺。
 */
function templateCreatedAt(rec) {
  const raw = rec ? rec.createdAt : null;
  if (raw == null || (typeof raw !== 'number' && typeof raw !== 'string')) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? int(n) : null;
}

/** 单条套餐：id 与 name 缺一不可；kind='day' 的 meals 归一化后不足 2 餐视为非法。 */
export function normalizeMealTemplate(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const id = rec.id == null ? '' : String(rec.id).trim();
  const name = text(rec.name);
  if (!id || !name) return null;
  const createdAt = templateCreatedAt(rec);
  if (rec.kind === 'day') {
    const meals = normalizeDayMeals(rec.meals);
    if (meals.length < 2) return null;
    const day = { id, name, kind: 'day', meals };
    if (createdAt != null) day.createdAt = createdAt;
    return day;
  }
  const template = {
    id,
    name,
    kind: 'meal',
    slot: SLOTS.includes(rec.slot) ? rec.slot : 'snack',
    items: normalizeItems(rec.items),
  };
  if (createdAt != null) template.createdAt = createdAt;
  return template;
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
 * 原地替换 list[index] 那一条单餐套餐：位置与 id 保留，原来带 createdAt 的照旧带过去。
 * 显式重建而不是展开旧对象：被同名整日套餐覆盖时不能把 meals 键留下来。
 */
function replaceMealTemplate(list, index, { name, slot, items }) {
  const prev = list[index];
  const template = { id: prev.id, name, kind: 'meal', slot, items };
  if (prev.createdAt != null) template.createdAt = prev.createdAt;
  list[index] = template;
  return { templates: list, template: { ...template } };
}

/** 新建时的时间戳 id：同一毫秒内连存两个新套餐不能互顶，顺延到下一个空位。 */
function nextTemplateStamp(list, now) {
  const used = new Set(list.map((t) => t.id));
  let stamp = Math.trunc(num(now, Date.now()));
  while (used.has(String(stamp))) stamp += 1;
  return stamp;
}

/**
 * 保存单餐套餐的纯逻辑（不碰 IDB）：name 去首尾空格，空名抛中文错。
 * 三种走法：
 *   1) 入参带 id 且命中已有套餐 -> **原地替换那一条**（保留原 id 与 createdAt，位置不变）；
 *   2) 不带 id（或 id 不存在）但名称撞上已有套餐 -> 同名覆盖，保留原 id 与 createdAt；
 *   3) 否则新建：id = String(now)，createdAt = 同一个时间戳。
 * now 只在新建时用来生成 id / createdAt，测试可注入固定时间。
 */
export function planMealTemplateSave(existing, input, now = Date.now()) {
  const list = normalizeMealTemplates(existing);
  const src = input && typeof input === 'object' ? input : {};
  const name = text(src.name);
  if (!name) throw new Error('套餐名称不能为空');
  const slot = SLOTS.includes(src.slot) ? src.slot : 'snack';
  const items = normalizeItems(src.items);

  // 显式 id 优先：视图层的「编辑这条套餐」走的就是它，不能退化成同名覆盖（改名后就找不到旧记录了）
  const wantId = src.id == null ? '' : String(src.id).trim();
  const idIndex = wantId ? list.findIndex((t) => t.id === wantId) : -1;
  if (idIndex >= 0) return replaceMealTemplate(list, idIndex, { name, slot, items });

  const index = list.findIndex((t) => t.name === name);
  if (index >= 0) return replaceMealTemplate(list, index, { name, slot, items });

  const stamp = nextTemplateStamp(list, now);
  const template = { id: String(stamp), name, kind: 'meal', slot, items, createdAt: stamp };
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
    const prev = list[index];
    const template = { id: prev.id, name, kind: 'day', meals };
    if (prev.createdAt != null) template.createdAt = prev.createdAt;
    list[index] = template;
    return { templates: list, template: { ...template } };
  }

  const stamp = nextTemplateStamp(list, now);
  const template = { id: String(stamp), name, kind: 'day', meals, createdAt: stamp };
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

// Excel / WPS 打开 CSV 时会把 = + - @ 开头的单元格当公式甚至 DDE 执行，引号包裹挡不住求值。
// 中和办法：数据单元格前置一个单引号（Excel 当文本），再照常走 RFC4180 转义 —— 标准解析器仍能逐格还原。
// 纯数字（-1 / +2.5 / 1e308）不是公式，保持数字语义不加前缀（否则 Excel 里会退化成文本）。
const CSV_NUMBER_ONLY = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function csvNeedsNeutralize(s) {
  return s.length > 0 && '=+-@'.includes(s[0]) && !CSV_NUMBER_ONLY.test(s);
}

function csvCell(v) {
  if (v == null) return '';
  const raw = String(v);
  const s = csvNeedsNeutralize(raw) ? "'" + raw : raw;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
