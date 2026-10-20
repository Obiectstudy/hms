/**
 * 业务编排层：视图层唯一入口。
 * 这里只做「按契约把参数变成记录、按契约把记录拼成视图需要的形状」，
 * 真正碰 IDB 的活全在 db.js，真正算数的活全在 nutrition.js / pure.js。
 */

import * as db from './db.js';
import {
  localDateStr,
  daysAgo,
  ageFromBirthday,
  bmrMifflinStJeor,
  tdee,
  weightStats,
  round1,
} from './nutrition.js';
import {
  normalizeItems,
  normalizeMealRecord,
  normalizeWeightRecord,
  normalizeExerciseRecord,
  normalizeRecord,
  buildDaySummary,
  buildRangeRows,
  buildCSV,
} from './pure.js';

// 与 js/vision.js 的 DEFAULT_* 保持一致；这里写字面量是为了不跨边界 import 别人的文件
// qwen-vl-max 在部分百炼账号上返回 404 model_not_found，实测可用的默认是 qwen3-vl-plus
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'qwen3-vl-plus',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const SAFE_GOALS = {
  calorieTarget: 1800,
  carbPct: 50,
  proteinPct: 20,
  fatPct: 30,
  waterMl: 2000,
  weightTargetKg: null,
};

const ACTIVITIES = ['sedentary', 'light', 'moderate', 'active', 'very_active'];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function todayOf(date) {
  const s = text(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : localDateStr();
}

// ---------- 档案 / 目标 / 设置 ----------

export async function getProfile() {
  const p = await db.getMeta('profile', null);
  return p && typeof p === 'object' ? p : null;
}

export async function saveProfile(p) {
  const src = p && typeof p === 'object' ? p : {};
  const profile = {
    nickname: text(src.nickname),
    sex: src.sex === 'female' ? 'female' : 'male',
    birthday: text(src.birthday),
    heightCm: clamp(round1(num(src.heightCm)), 0, 250),
    activity: ACTIVITIES.includes(src.activity) ? src.activity : 'sedentary',
  };
  if (src.weightTargetKg != null && num(src.weightTargetKg) > 0) {
    profile.weightTargetKg = round1(num(src.weightTargetKg));
  }
  await db.setMeta('profile', profile);
}

async function latestWeightKg() {
  try {
    const rows = await db.getAll('weights');
    const stats = weightStats(rows);
    return stats.latest;
  } catch {
    // 目标估算不该因为 IDB 不可用就整页崩掉，退化成按 60kg 估水
    return null;
  }
}

async function safeGetProfile() {
  try {
    return await getProfile();
  } catch {
    return null;
  }
}

/** 依据档案估算目标。不落库；调用方要保存才调 saveGoals。 */
export async function computeDefaultGoals(profile) {
  const p = profile === undefined ? await safeGetProfile() : profile;
  if (!p || typeof p !== 'object') return { ...SAFE_GOALS };

  const weightKg = await latestWeightKg();
  const weightTargetKg = num(p.weightTargetKg) > 0 ? round1(num(p.weightTargetKg)) : null;
  const age = ageFromBirthday(p.birthday) || 30;
  const bmr = bmrMifflinStJeor({
    sex: p.sex,
    weightKg: weightKg || 0,
    heightCm: num(p.heightCm),
    age,
  });
  if (!bmr) return { ...SAFE_GOALS, weightTargetKg };

  const daily = tdee(bmr, p.activity);
  return {
    calorieTarget: clamp(Math.round(daily), 1200, 4000),
    carbPct: 50,
    proteinPct: 20,
    fatPct: 30,
    // 35ml/kg，取整到 50ml，别给用户一个 2437ml 这种没法执行的数
    waterMl: clamp(Math.round(((weightKg || 60) * 35) / 50) * 50, 1500, 4000),
    weightTargetKg,
  };
}

function normalizeGoals(g) {
  const src = g && typeof g === 'object' ? g : {};
  return {
    calorieTarget: clamp(Math.round(num(src.calorieTarget, SAFE_GOALS.calorieTarget)), 800, 6000),
    carbPct: clamp(Math.round(num(src.carbPct, SAFE_GOALS.carbPct)), 0, 100),
    proteinPct: clamp(Math.round(num(src.proteinPct, SAFE_GOALS.proteinPct)), 0, 100),
    fatPct: clamp(Math.round(num(src.fatPct, SAFE_GOALS.fatPct)), 0, 100),
    waterMl: clamp(Math.round(num(src.waterMl, SAFE_GOALS.waterMl)), 200, 8000),
    weightTargetKg: num(src.weightTargetKg) > 0 ? round1(num(src.weightTargetKg)) : null,
  };
}

export async function getGoals() {
  const saved = await db.getMeta('goals', null);
  if (saved && typeof saved === 'object') return normalizeGoals(saved);
  return computeDefaultGoals(await getProfile());
}

export async function saveGoals(g) {
  await db.setMeta('goals', normalizeGoals(g));
}

export async function getSettings() {
  const saved = await db.getMeta('settings', null);
  const src = saved && typeof saved === 'object' ? saved : {};
  return {
    apiKey: text(src.apiKey),
    model: text(src.model) || DEFAULT_SETTINGS.model,
    baseUrl: text(src.baseUrl) || DEFAULT_SETTINGS.baseUrl,
  };
}

export async function saveSettings(s) {
  const cur = await getSettings();
  const src = s && typeof s === 'object' ? s : {};
  const next = {
    apiKey: src.apiKey === undefined ? cur.apiKey : text(src.apiKey),
    model: text(src.model) || cur.model || DEFAULT_SETTINGS.model,
    baseUrl: text(src.baseUrl) || cur.baseUrl || DEFAULT_SETTINGS.baseUrl,
  };
  await db.setMeta('settings', next);
}

// ---------- 体重 ----------

/**
 * weights / waters 的 by_date 是唯一索引：先查再写。
 * 手机端双击保存会让两条写并发跑同一段「查不到 -> add」，第二条撞 ConstraintError；
 * 这里重读一次把 id 带上再覆盖，用户看到的只是「保存成功」。
 */
async function upsertByDate(storeName, date, build) {
  const existing = await db.getOneByIndex(storeName, 'by_date', date);
  const record = build(existing);
  try {
    await db.put(storeName, record);
  } catch (err) {
    const again = await db.getOneByIndex(storeName, 'by_date', date);
    if (!again) throw err;
    await db.put(storeName, build(again));
  }
}

/** 按 date upsert：weights 的 by_date 是唯一索引，同日写两次必须是一条记录。 */
export async function logWeight({ date, weightKg, bodyFatPct, note } = {}) {
  const targetDate = todayOf(date);
  await upsertByDate('weights', targetDate, (existing) => {
    const record = normalizeWeightRecord({
      date: targetDate,
      weightKg,
      bodyFatPct,
      note,
      // createdAt 记首次录入时间，编辑不改它（列表按 date 排序，不靠它）
      createdAt: existing?.createdAt ?? Date.now(),
    });
    if (!record) throw new Error('体重数据无效：请填写大于 0 的数值');
    if (existing) record.id = existing.id;
    return record;
  });
}

export async function deleteWeight(date) {
  const existing = await db.getOneByIndex('weights', 'by_date', todayOf(date));
  if (existing) await db.del('weights', existing.id);
}

export async function recentWeights(days = 30) {
  const span = Math.max(1, Math.round(num(days, 30)));
  const cutoff = daysAgo(span - 1);
  const rows = await db.getAll('weights');
  return rows
    .filter((w) => typeof w?.date === 'string' && w.date >= cutoff)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
    .map((w) => ({ ...w }));
}

// ---------- 饮食 ----------

export async function logMeal({ date, slot, items, photoId, source, rawAiText } = {}) {
  const record = normalizeMealRecord({
    date: todayOf(date),
    slot,
    items: normalizeItems(items),
    photoId,
    source,
    rawAiText,
    createdAt: Date.now(),
  });
  if (!record) throw new Error('饮食记录日期无效');
  return db.put('meals', record);
}

export async function updateMeal(id, patch = {}) {
  const key = Number(id);
  const existing = await db.get('meals', key);
  if (!existing) throw new Error('这条饮食记录已不存在，请刷新后重试');
  const record = normalizeMealRecord({
    ...existing,
    ...patch,
    id: existing.id,
    date: patch.date ?? existing.date,
    createdAt: existing.createdAt,
  });
  if (!record) throw new Error('饮食记录更新失败：参数无效');
  await db.put('meals', record);
}

export async function deleteMeal(id) {
  await db.del('meals', Number(id));
}

// ---------- 运动 ----------

export async function logExercise({ date, type, minutes, kcalBurned, note } = {}) {
  const record = normalizeExerciseRecord({
    date: todayOf(date),
    type,
    minutes,
    kcalBurned,
    note,
    createdAt: Date.now(),
  });
  if (!record) throw new Error('运动记录日期无效');
  return db.put('exercises', record);
}

export async function deleteExercise(id) {
  await db.del('exercises', Number(id));
}

// ---------- 饮水 ----------

export async function getWater(date) {
  const row = await db.getOneByIndex('waters', 'by_date', todayOf(date));
  return row ? Math.max(0, Math.round(num(row.ml))) : 0;
}

/** 归零即删除该日记录，保证「撤销到 0」不会留下一条 0ml 的脏记录。 */
export async function setWater(date, ml) {
  const targetDate = todayOf(date);
  const value = Math.max(0, Math.round(num(ml)));
  if (value <= 0) {
    const existing = await db.getOneByIndex('waters', 'by_date', targetDate);
    if (existing) await db.del('waters', existing.id);
    return;
  }
  await upsertByDate('waters', targetDate, (existing) =>
    normalizeRecord('waters', { date: targetDate, ml: value, id: existing?.id }),
  );
}

export async function addWater(date, deltaMl) {
  const targetDate = todayOf(date);
  const current = await getWater(targetDate);
  const next = Math.max(0, Math.round(current + num(deltaMl)));
  await setWater(targetDate, next);
  return next;
}

// ---------- 照片 ----------

let photoSeq = 0;

function newPhotoId() {
  const rand = globalThis.crypto?.randomUUID?.();
  if (rand) return `p_${rand}`;
  photoSeq += 1;
  return `p_${Date.now().toString(36)}_${photoSeq}`;
}

export async function savePhoto(blob, mime) {
  const id = newPhotoId();
  await db.put('photos', { id, blob, mime: text(mime) || 'image/jpeg', createdAt: Date.now() });
  return id;
}

export async function getPhoto(id) {
  if (!id) return null;
  const rec = await db.get('photos', id);
  return rec && rec.blob ? rec.blob : null;
}

// ---------- 汇总 ----------

/** 视图核心：当日摄入四项+纤维+钠、消耗、饮水、体重、净值，一次取全。 */
export async function daySummary(date) {
  const targetDate = todayOf(date);
  const [meals, exercises, waterRow, weight] = await Promise.all([
    db.getAllByIndex('meals', 'by_date', targetDate),
    db.getAllByIndex('exercises', 'by_date', targetDate),
    db.getOneByIndex('waters', 'by_date', targetDate),
    db.getOneByIndex('weights', 'by_date', targetDate),
  ]);
  return buildDaySummary({
    date: targetDate,
    meals,
    exercises,
    water: waterRow,
    weight,
  });
}

export async function rangeSummary(fromDate, toDate) {
  const from = todayOf(fromDate);
  const to = todayOf(toDate);
  const [weights, meals, exercises, waters] = await Promise.all([
    db.getAll('weights'),
    db.getAll('meals'),
    db.getAll('exercises'),
    db.getAll('waters'),
  ]);
  return buildRangeRows({ fromDate: from, toDate: to, weights, meals, exercises, waters });
}

// ---------- 导入导出 ----------

/** 导出全量 JSON：schemaVersion / exportedAt 由 db.dumpAll 提供。 */
export async function exportJSON() {
  const payload = await db.dumpAll();
  return { app: 'hms', ...payload };
}

export async function importJSON(obj, mode = 'merge') {
  if (!obj || typeof obj !== 'object') throw new Error('导入失败：文件内容不是合法的 JSON 对象');
  return db.loadAll(obj, mode === 'replace' ? 'replace' : 'merge');
}

export async function exportCSV() {
  const [weights, meals, exercises, waters] = await Promise.all([
    db.getAll('weights'),
    db.getAll('meals'),
    db.getAll('exercises'),
    db.getAll('waters'),
  ]);
  return buildCSV({ weights, meals, exercises, waters });
}

/** 业务数据 + photos 清空，保留 profile / goals / settings。 */
export async function clearAllData() {
  await db.clearBusinessData();
}
