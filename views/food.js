// 饮食页（SPEC §7「饮食」+ §9 错误处理）：拍照识别 / 手动添加 / 当日餐次维护。
import {
  el, clear, toast, openSheet, confirmDialog, emptyState, fmtKcal, fmt1, fmtDateCN, fmtTime, bar,
} from '../js/ui.js';
import { localDateStr, parseDateStr, round1, slotFromMinutes, sumItems, scaleFood as scalePer100g } from '../js/nutrition.js';
import {
  getSettings, getGoals, daySummary, logMeal, updateMeal, deleteMeal, savePhoto,
  getMealTemplates, saveMealTemplate, saveDayTemplate, deleteMealTemplate, recentFoodItems,
} from '../js/store.js';
import { fileToDataUrl, analyzeFoodPhoto, MODEL_CANDIDATES } from '../js/vision.js';
import * as foodsLib from '../js/foods.js';

const { searchFoods } = foodsLib;

const SLOTS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

const go = (hash) => window.HMS.navigate(hash);

// 常吃套餐的 chip 上限：横条只放一屏，超出的靠删除旧套餐腾位置。
export const MAX_TEMPLATE_CHIPS = 6;
// 整日套餐至少要覆盖 2 餐：早餐 + 午餐才叫「这一天」。
const MIN_DAY_TEMPLATE_MEALS = 2;
// 「最近吃过」只放一屏 8 条，再多就和搜索框抢注意力了。
const RECENT_LIMIT = 8;

function slotLabel(slot) {
  const hit = SLOTS.find((s) => s.value === slot);
  return hit ? hit.label : '餐次';
}

/**
 * 默认餐次：按用户设置的「作息偏移」整体后移判定。
 * 偏移为正 = 作息整体后移（新疆约 +2 小时）：10:30 的早饭不会被记成午餐。
 * minutesOfDay 只用于测试注入；不传则取当前时刻。
 */
export function defaultSlot(offsetMinutes = 0, minutesOfDay) {
  const now = new Date();
  const m = Number.isFinite(Number(minutesOfDay)) ? Number(minutesOfDay) : now.getHours() * 60 + now.getMinutes();
  return slotFromMinutes(m, Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 0);
}

/** 读作息偏移；设置读不到或字段缺失一律回落 0——不允许因为读设置失败而让"记饮食"中断。 */
async function slotOffsetOf() {
  try {
    const s = await getSettings();
    const v = s ? Number(s.slotOffsetMinutes) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch (err) {
    return 0;
  }
}

function shiftDate(dateStr, delta) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + delta);
  return localDateStr(d);
}

// 已有条目改克数时按原比例缩放：库值已在识别/添加时算好，这里不重新查库。
function rescaleItem(item, grams) {
  const next = Math.max(1, Math.min(2000, Math.round(Number(grams) || 0)));
  const ratio = Number(item.grams) > 0 ? next / Number(item.grams) : 0;
  const out = { ...item, grams: next };
  for (const key of ['kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium']) {
    if (item[key] == null) continue;
    const scaled = Number(item[key]) * ratio;
    out[key] = key === 'kcal' ? Math.round(scaled) : round1(scaled);
  }
  return out;
}

function clampGrams(value) {
  return Math.max(1, Math.min(2000, Math.round(Number(value) || 0)));
}

/* ---------- 份量单位（数据层 foodUnits + 旧 unit 字段） ---------- */

// 目测参考：没有厨房秤时的兜底口径，单位层与保存条目层共用同一句文案。
export const PORTION_REF_TEXT = '1 拳 ≈ 150g · 1 掌心 ≈ 100g · 1 汤匙 ≈ 15g';
// 克数离常用份量超过这个比例就不给「≈1 碗」参照，避免误导。
const UNIT_HINT_TOLERANCE = 0.15;

/** 单位归一化：缺 name 或克数非正的脏数据直接丢掉，界面不因数据层扩展而报错。 */
function normalizeUnits(list) {
  const out = [];
  const seen = new Set();
  for (const unit of Array.isArray(list) ? list : []) {
    if (!unit) continue;
    const grams = Math.round(Number(unit.grams));
    const name = String(unit.name == null ? '' : unit.name).trim();
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;
    const key = `${name}|${grams}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, grams: clampGrams(grams) });
  }
  return out;
}

/**
 * 份量单位清单。优先数据层 foodUnits(food)；并行扩展尚未落地（或它抛错）时
 * 按同一签名退化到旧字段 unit，保证视图层不因数据侧中间状态整页白屏。
 */
export function unitsOf(food) {
  if (!food) return [];
  if (typeof foodsLib.foodUnits === 'function') {
    try {
      return normalizeUnits(foodsLib.foodUnits(food));
    } catch {
      /* 数据层脏数据不该炸界面，继续走旧字段 */
    }
  }
  return normalizeUnits(Array.isArray(food.units) ? food.units : [food.unit]);
}

function foodById(id) {
  if (!id || !Array.isArray(foodsLib.FOODS)) return null;
  return foodsLib.FOODS.find((food) => food && food.id === id) || null;
}

/** 克数接近某个常用份量（±15%）时才返回「≈1 碗」；否则返回空串。 */
export function unitHintFor(grams, units) {
  const value = Number(grams);
  if (!Number.isFinite(value) || value <= 0) return '';
  let best = null;
  let bestDiff = Infinity;
  for (const unit of Array.isArray(units) ? units : []) {
    const unitGrams = Number(unit && unit.grams);
    if (!Number.isFinite(unitGrams) || unitGrams <= 0) continue;
    const diff = Math.abs(value - unitGrams) / unitGrams;
    if (diff <= UNIT_HINT_TOLERANCE && diff < bestDiff) {
      best = unit;
      bestDiff = diff;
    }
  }
  return best ? `≈${best.name}` : '';
}

/** 已保存条目：能按 foodId 对上库内食物且克数接近某个单位时给参照，取不到就不显示。 */
export function itemUnitHint(item) {
  const food = foodById(item && item.foodId);
  if (!food) return '';
  return unitHintFor(item.grams, unitsOf(food));
}

/** 搜索行主单位文案：`1 碗 ≈ 200g`；无单位返回空串。 */
function mainUnitText(food) {
  const unit = unitsOf(food)[0];
  return unit ? `${unit.name} ≈ ${unit.grams}g` : '';
}

/**
 * 份量 chip 排：点一下把克数填成该单位并刷新预览，选中态用品牌色。
 * 没有单位时返回 null（调用方不渲染 chip 区，退化为纯克数输入）。
 */
function renderUnitChips({ units, lastGrams, grams, onChange } = {}) {
  const list = normalizeUnits(units);
  const last = Number(lastGrams) > 0 ? clampGrams(lastGrams) : 0;
  if (!list.length) return null;

  const buttons = [];
  const activate = (key) => {
    for (const btn of buttons) {
      const on = btn.dataset.key === key;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  const choose = (key, value) => {
    if (grams) grams.value = String(value);
    activate(key);
    if (typeof onChange === 'function') onChange();
  };
  const row = el('div', { className: 'portion-units chips' });

  list.forEach((unit, index) => {
    const btn = el('button', {
      className: 'portion-chip portion-chip--unit',
      type: 'button',
      dataset: { key: `unit-${index}`, grams: unit.grams },
      attr: { 'aria-label': `${unit.name}，${unit.grams} 克`, 'aria-pressed': 'false' },
      onClick: () => choose(`unit-${index}`, unit.grams),
    },
      el('span', { className: 'portion-chip__name', text: unit.name }),
      el('span', { className: 'portion-chip__g', text: `${unit.grams}g` }),
    );
    buttons.push(btn);
    row.appendChild(btn);
  });

  const quick = el('button', {
    className: 'portion-chip portion-chip--quick',
    type: 'button',
    dataset: { key: 'quick-100', grams: 100 },
    attr: { 'aria-label': '100 克', 'aria-pressed': 'false' },
    onClick: () => choose('quick-100', 100),
  }, el('span', { text: '100g' }));
  buttons.push(quick);
  row.appendChild(quick);

  if (last) {
    const lastBtn = el('button', {
      className: 'portion-chip portion-chip--last',
      type: 'button',
      dataset: { key: 'last', grams: last },
      attr: { 'aria-label': `上次 ${last} 克`, 'aria-pressed': 'false' },
      onClick: () => choose('last', last),
    }, el('span', { text: `上次 ${last}g` }));
    buttons.push(lastBtn);
    row.appendChild(lastBtn);
  }

  // 初始/实时选中态：克数与某颗 chip 完全一致才高亮，不替用户猜单位。
  const sync = () => {
    const value = Number(grams && grams.value);
    const hit = buttons.find((btn) => Number(btn.dataset.grams) === value);
    activate(hit ? hit.dataset.key : null);
  };
  sync();
  return { node: row, sync };
}

/**
 * 份量详情面板：食物名 + 单位 chip + 克数输入 + 实时营养预览 + 目测参考。
 * onSubmit(item) 由调用方接到「加入清单 / 就用这道菜」的收尾（关闭弹层等）。
 */
export function renderPortionDetail(food, options = {}) {
  const baseItem = options.baseItem || null;
  const defaultGrams = Number(options.grams) > 0 ? clampGrams(options.grams) : pickDefaultGrams(food);
  const grams = el('input', {
    className: 'input', type: 'number', inputmode: 'decimal', min: '1', max: '2000', step: '1',
    value: String(defaultGrams), attr: { 'aria-label': `${food.name} 克数` },
  });
  const preview = el('div', { className: 'muted portion-preview' });
  const itemAt = (value) => (baseItem ? rescaleItem(baseItem, value) : scaleFood(food, value));
  const updatePreview = () => {
    const item = itemAt(grams.value);
    // 纤维只在条目真有数据时追加：缺数据不显示，也不写「膳食纤维 0g」。
    preview.textContent = `${fmtKcal(item.kcal)} kcal · 碳水 ${fmt1(item.carb)}g · 蛋白质 ${fmt1(item.protein)}g · 脂肪 ${fmt1(item.fat)}g${fiberPreviewSuffix(item)}`;
  };
  const chipRow = renderUnitChips({
    units: unitsOf(food),
    lastGrams: baseItem && baseItem.grams,
    grams,
    onChange: updatePreview,
  });
  grams.addEventListener('input', () => {
    updatePreview();
    if (chipRow) chipRow.sync();
  });
  updatePreview();

  const submit = el('button', {
    className: 'btn btn--primary btn--block',
    text: options.dishMode ? '就用这道菜' : '加入清单',
    onClick: () => {
      const value = Number(grams.value);
      if (!Number.isFinite(value) || value <= 0) {
        toast('请填写克数', 'error');
        return;
      }
      if (typeof options.onSubmit === 'function') options.onSubmit(itemAt(value));
    },
  });

  return el('div', { className: 'col portion-detail' },
    el('div', { className: 'row row--between divider' },
      el('div', { className: 'row' },
        el('span', { className: 'strong', text: food.name }),
        isDish(food) ? el('span', { className: 'pill pill--dish', text: '菜' }) : null,
      ),
      el('span', { className: 'muted', text: `每 100g ${fmtKcal(food.per100g && food.per100g.kcal)} kcal` }),
    ),
    chipRow ? chipRow.node : null,
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '克数' }), grams),
    preview,
    el('div', { className: 'portion-ref', text: PORTION_REF_TEXT }),
    submit,
  );
}

// 复合菜在数据侧用 kind === 'dish' 标记（另一人并行补数据，字段可能暂时缺失）。
// 判定只认这一个字段：缺失 / 其它值一律按原料处理，不抛错。
export function isDish(food) {
  return Boolean(food && food.kind === 'dish');
}

/** 整份克数：优先第一个常用单位（1 盘 ≈ 300g），缺省 200g。 */
export function defaultDishGrams(food) {
  const unit = unitsOf(food)[0];
  return unit ? clampGrams(unit.grams) : 200;
}

/** 选中食物时份量框默认值：菜品按整份算，原料沿用首个单位或 100g。 */
export function pickDefaultGrams(food) {
  const unit = unitsOf(food)[0];
  if (unit) return clampGrams(unit.grams);
  return isDish(food) ? 200 : 100;
}

/** 搜索结果排序：菜品整体前置，两组内保持库内相对顺序。 */
export function orderFoodsForPick(foods) {
  const list = Array.isArray(foods) ? foods.filter(Boolean) : [];
  return [...list.filter(isDish), ...list.filter((food) => !isDish(food))];
}

// 每 100g 数值换算到实际克数（计算统一走 nutrition.scaleFood，避免两套公式漂移）。
function scaleFood(food, grams) {
  const g = clampGrams(grams);
  const p = (food && food.per100g) || {};
  const scaled = scalePer100g(p, g);
  const item = {
    // 缺名字的食物（自定义 / 脏数据）不能把 undefined 漏进条目：渲染层会显示 undefined 字面量
    name: typeof food.name === 'string' ? food.name : '',
    grams: g,
    kcal: scaled.kcal,
    carb: scaled.carb,
    protein: scaled.protein,
    fat: scaled.fat,
    foodId: food.id,
  };
  if (p.fiber != null) item.fiber = scaled.fiber;
  if (p.sodium != null) item.sodium = scaled.sodium;
  return item;
}

/** 整份合并：把清单里的全部条目换成选中的这一道菜（保留数组引用，调用方原地替换）。 */
export function mergeToDish(items, food, grams) {
  const current = Array.isArray(items) ? items : [];
  if (!food) return current.map((item) => ({ ...item }));
  const g = Number(grams) > 0 ? clampGrams(grams) : defaultDishGrams(food);
  return [scaleFood(food, g)];
}

export function mergeConfirmMessage(itemCount, food) {
  const name = food && food.name ? food.name : '这道菜';
  return `当前 ${Math.max(0, Number(itemCount) || 0)} 项将被替换成「${name}」`;
}

/**
 * 替换条目：用户手选了一个新食物，把这一项换成它。
 * 克数沿用「修改」面板里的当前值；越界（<1 或 >2000）时回落到新食物的默认份量。
 * 营养按新食物的每 100g 重算，name/foodId 跟着换，confidence 记手选的「高」；
 * note 等其它字段原样保留（新食物缺 fiber/sodium 就不继承旧值，免得张冠李戴）。
 * 注：替换成手选食物后**不写 confidence**——那个字段表达的是「AI 识别的可信度」，
 * 手工挑选没有识别过程，标一个置信度反而是噪音；同时数据层白名单（js/pure.js 的 CONFIDENCE）
 * 只收 high/medium/low，写「高」会在归一化时被滤掉，等于两处都不一致。
 */
export function replaceMealItem(item, food, grams) {
  const base = item && typeof item === 'object' ? item : {};
  const value = Number(grams);
  const keep = Number.isFinite(value) && value >= 1 && value <= 2000 ? clampGrams(value) : pickDefaultGrams(food);
  const merged = { ...base, ...scaleFood(food, keep) };
  delete merged.confidence;
  const per100g = (food && food.per100g) || {};
  if (per100g.fiber == null) delete merged.fiber;
  if (per100g.sodium == null) delete merged.sodium;
  return merged;
}

/* ---------- 膳食纤维（SPEC §7 饮食：只显示摄取量，不设每日目标） ---------- */

/**
 * 条目的纤维算不算「有数据」：null / 缺省 = 不知道，0 是「确实为 0」。
 * 不知道就不显示 —— 把缺数据显示成「纤 0」等于替食物库撒谎；
 * 非数字（手改过的脏库）同样算不知道，Number('abc') 之类折成 0 也是假数据。
 */
export function hasFiber(item) {
  if (!item || typeof item !== 'object' || item.fiber == null) return false;
  return Number.isFinite(Number(item.fiber));
}

/** 条目行 meta 的纤维片段：` / 纤 6.2`；没有数据返回空串（不是 ` / 纤 0`）。 */
export function fiberMetaSuffix(item) {
  return hasFiber(item) ? ` / 纤 ${fmt1(item.fiber)}` : '';
}

/** 营养预览的纤维片段：` · 膳食纤维 6.2g`；没有数据返回空串。 */
export function fiberPreviewSuffix(item) {
  return hasFiber(item) ? ` · 膳食纤维 ${fmt1(item.fiber)}g` : '';
}

/**
 * 汇总纤维：只累加已知值，并把「有多少条缺数据」一起带出来。
 * known = 0 时 value 是 null —— 界面据此说「暂无数据」，而不是报一个看起来像
 * 「一点纤维都没吃」的 0。total 只数对象条目，半截写入的脏记录不算一项。
 */
export function fiberTotals(items) {
  let total = 0;
  let known = 0;
  let sum = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    total += 1;
    if (!hasFiber(item)) continue;
    known += 1;
    sum += Number(item.fiber);
  }
  return { value: known > 0 ? round1(sum) : null, known, total, missing: total - known };
}

/**
 * 汇总处的一句话：`6.2 g（部分食物无数据）` / `6.2 g` / `暂无数据`。
 * 这一天一条条目都没有时返回空串：整行不渲染，比写一个「暂无数据」占位干净。
 */
export function fiberSummaryText(totals) {
  const t = totals || {};
  const total = Number(t.total) || 0;
  const known = Number(t.known) || 0;
  if (!total) return '';
  if (!known) return '暂无数据';
  return `${fmt1(t.value)} g${Number(t.missing) > 0 ? '（部分食物无数据）' : ''}`;
}

/** 每餐小计（「午餐 · 620 kcal」那一行）的纤维片段：一条数据都没有就什么都不加。 */
export function fiberSubtotalSuffix(items) {
  const t = fiberTotals(items);
  if (!t.known) return '';
  return ` · 纤 ${fmt1(t.value)}${t.missing > 0 ? '（部分食物无数据）' : ''}`;
}

/* ---------- 常吃套餐（SPEC §7 饮食：一键记入 + 存为套餐） ---------- */

/** 只渲染前 6 个；脏数据（缺 name）直接丢掉，不占位。 */
export function visibleTemplates(templates) {
  const list = Array.isArray(templates) ? templates.filter((t) => t && t.name) : [];
  return list.slice(0, MAX_TEMPLATE_CHIPS);
}

/**
 * 套餐在 chip 上要显示的总热量：单餐看 items，整日看每一餐的 items，
 * 与当日合计走同一套求和口径。
 */
export function templateKcal(template) {
  const items = [];
  if (template && template.kind === 'day') {
    for (const meal of Array.isArray(template.meals) ? template.meals : []) {
      for (const item of Array.isArray(meal && meal.items) ? meal.items : []) items.push(item);
    }
  } else {
    for (const item of Array.isArray(template && template.items) ? template.items : []) items.push(item);
  }
  return sumItems(items).kcal;
}

/** 整日套餐的副标题：把覆盖到的餐次缩写连起来（早+午+晚），一眼看出这一天有哪些餐。 */
export function dayTemplateSlots(template) {
  const meals = Array.isArray(template && template.meals) ? template.meals : [];
  return meals.map((meal) => slotLabel(meal && meal.slot).replace('餐', '')).join('+');
}

/** 弹层里的小表单：只收一个套餐名，空名视为取消。title/hint 让整日套餐复用同一张表单。 */
function askTemplateName(defaultName, { title = '存为套餐', hint = '存下来以后，在饮食页点一下就能把这份清单记入当天；同名套餐会被覆盖' } = {}) {
  const input = el('input', {
    className: 'input', type: 'text', value: String(defaultName || ''), placeholder: '例如：午餐套餐',
    attr: { maxlength: '20' },
  });
  return openSheet({
    title,
    content: el('div', { className: 'col' },
      el('div', { className: 'muted', text: hint }),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '套餐名' }), input),
    ),
    actions: [{ text: '保存套餐', value: 'save', primary: true }, { text: '取消', value: null }],
  }).then((value) => (value === 'save' ? String(input.value || '').trim() : ''));
}

async function recordTemplate(template, date, reload) {
  try {
    if (template && template.kind === 'day') {
      const meals = Array.isArray(template.meals) ? template.meals : [];
      // 整日套餐逐餐记入：每餐一条记录，与手动记一餐完全同构。
      for (const meal of meals) {
        await logMeal({
          date,
          slot: meal.slot,
          source: 'manual',
          items: (meal.items || []).map((item) => ({ ...item })),
        });
      }
      toast(`已记入 ${meals.length} 餐 · ${template.name}`, 'ok');
    } else {
      await logMeal({
        date,
        slot: template.slot,
        source: 'manual',
        items: (template.items || []).map((item) => ({ ...item })),
      });
      toast(`已记入 · ${template.name}`, 'ok');
    }
    await reload();
  } catch (err) {
    toast(`记入失败：${err && err.message ? err.message : err}`, 'error');
  }
}

/** 当天已有餐次按 slot 归并：同餐次的多条记录合成一份清单，空餐次直接不出现。 */
export function groupDayMeals(meals) {
  const out = [];
  for (const slot of SLOTS) {
    const items = [];
    for (const meal of Array.isArray(meals) ? meals : []) {
      if (!meal || meal.slot !== slot.value) continue;
      for (const item of Array.isArray(meal.items) ? meal.items : []) items.push({ ...item });
    }
    if (items.length) out.push({ slot: slot.value, items });
  }
  return out;
}

/** 把当天已有餐次存成整日套餐：不足 2 餐只提示，不落库（saveDayTemplate 同样会拒）。 */
async function saveTodayAsDayTemplate(date, reload) {
  let summary;
  try {
    summary = await daySummary(date);
  } catch (err) {
    toast(`读取当天饮食失败：${err && err.message ? err.message : err}`, 'error');
    return;
  }
  const meals = groupDayMeals(summary && summary.meals);
  if (meals.length < MIN_DAY_TEMPLATE_MEALS) {
    toast('今天还没有足够的餐次可存', 'error');
    return;
  }
  const name = await askTemplateName('工作日常餐', {
    title: '存为整日套餐',
    hint: '存下来以后，点一下就能把这一天的每一餐都记入当天；同名套餐会被覆盖',
  });
  if (!name) return;
  try {
    await saveDayTemplate({ name, meals });
    toast(`已存为整日套餐 · ${name}`, 'ok');
    await reload();
  } catch (err) {
    toast(`保存整日套餐失败：${err && err.message ? err.message : err}`, 'error');
  }
}

async function removeTemplate(template, reload) {
  const ok = await confirmDialog({
    title: '删除这个套餐？',
    message: `「${template.name}」删除后需要重新保存，已记入的记录不受影响。`,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await deleteMealTemplate(template.id);
    toast('套餐已删除', 'ok');
    await reload();
  } catch (err) {
    toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
  }
}

/* ---------- 套餐原地编辑（改的是原套餐，不是派生一份新的） ---------- */

/**
 * 保存参数：带 id 交给数据层「原地更新原套餐」（不带 id 会按新套餐落库，等于派生一份）。
 * 套餐名与餐次沿用原套餐：编辑界面只改条目 —— 顺手改名会变成「改了名字的另一个套餐」。
 */
export function templateEditPayload(template, items) {
  const t = template && typeof template === 'object' ? template : {};
  return {
    id: t.id,
    name: t.name,
    slot: t.slot,
    items: (Array.isArray(items) ? items : []).map((item) => ({ ...item })),
  };
}

/** 编辑层里的一行：条目名 + 营养（含纤维）+ 删。 */
function renderTemplateEditRow(item, onRemove) {
  return el('div', { className: 'list__item item-row' },
    el('div', { className: 'col item-row__main' },
      el('div', { className: 'strong', text: itemLabel(item) }),
      el('div', { className: 'list__item--meta', text: `${fmtKcal(item.kcal)} kcal · 碳 ${fmt1(item.carb)} / 蛋 ${fmt1(item.protein)} / 脂 ${fmt1(item.fat)}${fiberMetaSuffix(item)}` }),
    ),
    el('button', {
      className: 'btn btn--ghost btn--sm btn--danger', text: '删',
      attr: { 'aria-label': `从套餐里删掉 ${itemLabel(item) || '这一项'}` },
      onClick: onRemove,
    }),
  );
}

/**
 * 编辑套餐：删条目 / 加食物，保存时按 id 原地覆盖原套餐。
 * 原地覆盖没有退路（数据层不留旧版本），所以标题、说明与保存前的二次确认三处都要说清这一点。
 * 整日套餐（kind === 'day'）不走这里：它没有 items，保存接口也是另一套。
 */
async function editTemplateFlow(template, reload) {
  // 只留能渲染的对象条目：脏记录进不了编辑层，也就不会原样写回去。
  const items = (Array.isArray(template.items) ? template.items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...item }));

  const action = await openSheet({
    title: `编辑套餐 · ${template.name}`,
    actions: [],
    content: ({ close }) => {
      const listNode = el('div', { className: 'list' });
      const totalNode = el('div', { className: 'muted' });
      const repaint = () => {
        clear(listNode);
        items.forEach((item, index) => {
          listNode.appendChild(renderTemplateEditRow(item, () => { items.splice(index, 1); repaint(); }));
        });
        totalNode.textContent = `共 ${items.length} 项 · ${fmtKcal(sumItems(items).kcal)} kcal`;
      };
      repaint();

      const addFood = async () => {
        const pick = await openPickFoodSheet({ title: '加进套餐' });
        if (!pick || !pick.item) return;
        items.push(pick.item);
        repaint();
      };

      // 保存按钮放在内容里而不是 openSheet 的 actions 上：空套餐时要在弹层内直接拒绝，
      // 不能一点就把弹层关掉（actions 一旦被点就 resolve 收摊，没有挽回的余地）。
      const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存到原套餐' });
      saveBtn.addEventListener('click', async () => {
        if (!items.length) {
          toast('套餐里至少要留一项食物，空套餐不能保存', 'error');
          return;
        }
        const ok = await confirmDialog({
          title: '更新原套餐？',
          message: `「${template.name}」会被这 ${items.length} 项覆盖，原套餐不会另存一份。`,
          okText: '更新',
        });
        if (!ok) return;
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        try {
          await saveMealTemplate(templateEditPayload(template, items));
          toast(`套餐已更新 · ${template.name}`, 'ok');
          close('saved');
          await reload();
        } catch (err) {
          toast(`保存套餐失败：${err && err.message ? err.message : err}`, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = '保存到原套餐';
        }
      });

      return el('div', { className: 'col' },
        el('div', { className: 'muted', text: '保存后原套餐会被更新（不会另存一份），先确认条目再保存。' }),
        el('div', { className: 'divider' }),
        listNode,
        totalNode,
        el('button', {
          className: 'btn btn--ghost btn--block', text: '加食物',
          attr: { 'aria-label': `往 ${template.name} 里加一样食物` },
          onClick: () => { addFood().catch((err) => toast(`添加失败：${err && err.message ? err.message : err}`, 'error')); },
        }),
        saveBtn,
        el('button', { className: 'btn btn--ghost btn--block', text: '取消', onClick: () => close(null) }),
      );
    },
  });
  return action;
}

/**
 * 常吃套餐横条：单餐与整日两类共用一行。
 * 一个套餐都没有时不能整块消失：当天已有 ≥2 餐的话，「把今天存为整日套餐」正是新用户
 * 要做的第一个动作，藏起来等于没有入口——这时标题改成「整日套餐」并只留那个入口，
 * 免得空无一物的「常吃套餐」误导人。当天不足 2 餐才整块不渲染，不留空白。
 */
function renderTemplateCard(templates, date, reload, dayMealCount) {
  const list = visibleTemplates(templates);
  const canSaveDay = Number(dayMealCount) >= MIN_DAY_TEMPLATE_MEALS;
  if (!list.length && !canSaveDay) return null;
  const row = el('div', { className: 'tpl-row' });
  for (const template of list) {
    const isDay = template.kind === 'day';
    const sub = isDay ? dayTemplateSlots(template) : '';
    row.appendChild(el('div', { className: 'tpl-chip' },
      el('button', {
        className: 'tpl-chip__main',
        type: 'button',
        attr: { 'aria-label': `${isDay ? '记入整日套餐' : '记入套餐'} ${template.name}` },
        onClick: () => { recordTemplate(template, date, reload).catch((err) => toast(`记入失败：${err && err.message ? err.message : err}`, 'error')); },
      },
        el('span', { className: 'tpl-chip__name', text: template.name }),
        el('span', { className: 'tpl-chip__kcal', text: `${fmtKcal(templateKcal(template))} kcal` }),
        sub ? el('span', { className: 'tpl-chip__sub', text: sub }) : null,
      ),
      // 只有单餐套餐能原地编辑：整日套餐没有 items，保存接口也是另一套。
      isDay ? null : el('button', {
        className: 'btn btn--ghost btn--sm',
        type: 'button',
        text: '编辑',
        attr: { 'aria-label': `编辑套餐 ${template.name}` },
        onClick: () => { editTemplateFlow(template, reload).catch((err) => toast(`编辑套餐失败：${err && err.message ? err.message : err}`, 'error')); },
      }),
      el('button', {
        className: 'tpl-chip__del',
        type: 'button',
        text: '×',
        attr: { 'aria-label': `删除套餐 ${template.name}` },
        onClick: () => { removeTemplate(template, reload).catch((err) => toast(`删除失败：${err && err.message ? err.message : err}`, 'error')); },
      }),
    ));
  }
  return el('div', { className: 'card col template-card' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: list.length ? '常吃套餐' : '整日套餐' }),
      el('button', {
        className: 'btn btn--ghost btn--sm tpl-save-day',
        type: 'button',
        text: '把今天存为整日套餐',
        onClick: () => { saveTodayAsDayTemplate(date, reload).catch((err) => toast(`保存整日套餐失败：${err && err.message ? err.message : err}`, 'error')); },
      }),
    ),
    list.length ? row : null,
  );
}

/* ---------- 最近吃过 ---------- */

/**
 * 最近吃过的条目 → 详情层需要的「类食物」对象。
 * 营养值按上次的克数折回每 100g；真正的换算仍走 baseItem，避免二次取整漂移。
 * 条目带 foodId 且能对上库内食物时，把常用份量一并带过去，最近吃过的详情层同样能选单位。
 */
export function recentToFood(entry) {
  const item = (entry && entry.item) || {};
  const grams = Number(item.grams) > 0 ? Number(item.grams) : 100;
  const per100g = {};
  for (const key of ['kcal', 'carb', 'protein', 'fat', 'fiber', 'sodium']) {
    if (item[key] == null) continue;
    per100g[key] = (Number(item[key]) || 0) * 100 / grams;
  }
  const out = {
    id: item.foodId,
    name: String((entry && entry.name) || item.name || '食物'),
    per100g,
  };
  const food = foodById(item.foodId);
  if (food) out.units = unitsOf(food);
  return out;
}

/** 搜索结果单行：菜品带「菜」徽标，原料不带；主单位并进元信息行，保持两行以内。 */
export function renderPickRow(food, onPick) {
  const meta = [`${fmtKcal(food.per100g && food.per100g.kcal)} kcal / 100g`];
  const unitText = mainUnitText(food);
  if (unitText) meta.push(unitText);
  return el('button', {
    className: 'list__item pick-item', type: 'button',
    onClick: onPick,
  },
    el('div', { className: 'list__item--main' },
      el('div', { className: 'row' },
        el('span', { className: 'strong', text: food.name }),
        isDish(food) ? el('span', { className: 'pill pill--dish', text: '菜' }) : null,
      ),
      el('div', { className: 'list__item--meta', text: meta.join(' · ') }),
    ),
    el('span', { className: 'muted', text: '选择' }),
  );
}

function dataUrlToBlob(dataUrl, mime = 'image/jpeg') {
  const [head, body] = String(dataUrl).split(',');
  const isBase64 = /;base64$/i.test(head || '');
  const raw = isBase64 ? atob(body || '') : decodeURIComponent(body || '');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function confidencePill(confidence) {
  if (confidence === 'high') return el('span', { className: 'pill pill--ok', text: '高置信' });
  if (confidence === 'low') return el('span', { className: 'pill pill--warn', text: '低置信' });
  return el('span', { className: 'pill', text: '中置信' });
}

function totalsBlock(items) {
  const t = sumItems(items);
  return el('div', { className: 'grid-2 totals' },
    el('div', { className: 'stat' },
      el('div', { className: 'stat__line' }, el('span', { className: 'stat__value stat__value--sm', text: fmtKcal(t.kcal) }), el('span', { className: 'stat__unit', text: 'kcal' })),
      el('div', { className: 'stat__label', text: '热量' }),
    ),
    el('div', { className: 'stat' },
      el('div', { className: 'stat__line' }, el('span', { className: 'stat__value stat__value--sm', text: fmt1(t.carb) }), el('span', { className: 'stat__unit', text: 'g' })),
      el('div', { className: 'stat__label', text: '碳水' }),
    ),
    el('div', { className: 'stat' },
      el('div', { className: 'stat__line' }, el('span', { className: 'stat__value stat__value--sm', text: fmt1(t.protein) }), el('span', { className: 'stat__unit', text: 'g' })),
      el('div', { className: 'stat__label', text: '蛋白质' }),
    ),
    el('div', { className: 'stat' },
      el('div', { className: 'stat__line' }, el('span', { className: 'stat__value stat__value--sm', text: fmt1(t.fat) }), el('span', { className: 'stat__unit', text: 'g' })),
      el('div', { className: 'stat__label', text: '脂肪' }),
    ),
  );
}

// 可编辑清单：改克数、删单项、整份合并成一道菜、实时合计、选餐次、保存。
// 返回 'saved' | 'add' | null。AI 识别与手动添加共用同一张表（只有标题/来源不同）。
export async function openDraftSheet(initialItems, meta) {
  // 在异步作用域先取偏移：内部的 content 回调不是 async，不能在里面 await。
  const slotOffset = await slotOffsetOf();
  const items = initialItems.map((i) => ({ ...i }));
  // 存套餐后让调用方重画饮食页（弹层挂在 body 上，重画不会把它冲掉）。
  const notifyTemplatesChanged = async () => {
    if (typeof meta.onTemplateSaved === 'function') await meta.onTemplateSaved();
  };
  return openSheet({
    title: meta.source === 'ai' ? '识别结果（可编辑）' : '确认食物',
    actions: [],
    content: ({ close }) => {
      const listNode = el('div', { className: 'list' });
      const totalsNode = el('div', {});
      const slotSelect = el('select', { className: 'select' },
        SLOTS.map((s) => el('option', { value: s.value, text: s.label })),
      );
      slotSelect.value = meta.slot || defaultSlot(slotOffset);

      const repaint = () => {
        clear(listNode);
        items.forEach((item, index) => {
          const grams = el('input', {
            className: 'input input--grams', type: 'number', inputmode: 'decimal',
            min: '1', max: '2000', step: '1', value: String(item.grams),
            attr: { 'aria-label': `${item.name} 克数` },
          });
          grams.addEventListener('change', () => {
            items[index] = rescaleItem(items[index], grams.value);
            grams.value = String(items[index].grams);
            repaint();
          });
          const del = el('button', {
            className: 'btn btn--ghost btn--sm btn--danger', text: '删',
            attr: { 'aria-label': `删除 ${item.name}` },
            onClick: () => { items.splice(index, 1); repaint(); },
          });
          listNode.appendChild(el('div', { className: 'list__item item-row' },
            el('div', { className: 'col item-row__main' },
              el('div', { className: 'row' },
                el('span', { className: 'strong', text: item.name }),
                item.confidence ? confidencePill(item.confidence) : null,
              ),
              el('div', { className: 'list__item--meta', text: `${fmtKcal(item.kcal)} kcal · 碳 ${fmt1(item.carb)} · 蛋 ${fmt1(item.protein)} · 脂 ${fmt1(item.fat)}${fiberMetaSuffix(item)}` }),
            ),
            el('div', { className: 'row item-row__edit' }, grams, el('span', { className: 'muted', text: 'g' }), del),
          ));
        });
        clear(totalsNode);
        totalsNode.appendChild(totalsBlock(items));
      };
      repaint();

      // 模型常把一道家常菜拆成多个原料（鸡蛋 + 菠菜），这里给一条「还原成一道菜」的出口。
      const runMerge = async () => {
        if (!items.length) {
          toast('清单是空的，先加点食物', 'error');
          return;
        }
        const pick = await openPickFoodSheet({ title: '整份是一道菜', mode: 'dish' });
        if (!pick || !pick.food) return;
        const ok = await confirmDialog({
          title: '整份是一道菜？',
          message: mergeConfirmMessage(items.length, pick.food),
          okText: '替换',
        });
        if (!ok) return;
        const merged = mergeToDish(items, pick.food, pick.item && pick.item.grams);
        items.splice(0, items.length, ...merged);
        toast(`已记成一道菜：${items[0] ? items[0].name : ''}`, 'ok');
        repaint();
      };
      // 把这份清单固化下来，下次在饮食页一键记入。
      const saveAsTemplate = async () => {
        if (!items.length) {
          toast('清单是空的，先加点食物', 'error');
          return;
        }
        const name = await askTemplateName(`${slotLabel(slotSelect.value)}套餐`);
        if (!name) return;
        try {
          await saveMealTemplate({ name, slot: slotSelect.value, items: items.map((i) => ({ ...i })) });
          toast(`已存为套餐 · ${name}`, 'ok');
          await notifyTemplatesChanged();
        } catch (err) {
          toast(`保存套餐失败：${err && err.message ? err.message : err}`, 'error');
        }
      };

      const mergeBar = el('div', { className: 'merge-bar merge-bar--split' },
        el('button', {
          className: 'btn btn--ghost merge-bar__btn',
          text: '存为套餐',
          attr: { 'aria-label': '把这份清单存为常吃套餐' },
          onClick: () => {
            saveAsTemplate().catch((err) => toast(`保存套餐失败：${err && err.message ? err.message : err}`, 'error'));
          },
        }),
        el('button', {
          className: 'btn btn--ghost merge-bar__btn',
          text: '整份是一道菜',
          attr: { 'aria-label': '整份是一道菜：用库里的一道菜替换整个清单' },
          onClick: () => {
            runMerge().catch((err) => toast(`合并失败：${err && err.message ? err.message : err}`, 'error'));
          },
        }),
      );

      const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存到当日' });
      saveBtn.addEventListener('click', async () => {
        if (!items.length) {
          toast('清单是空的，先加点食物', 'error');
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        try {
          let photoId;
          if (meta.photo) {
            // 存压缩后的图，避免把原图（数 MB）塞进 IndexedDB。
            photoId = await savePhoto(meta.photo.blob, meta.photo.mime);
          }
          await logMeal({
            date: meta.date,
            slot: slotSelect.value,
            items: items.map((i) => ({ ...i })),
            photoId,
            source: meta.source,
            rawAiText: meta.raw || undefined,
          });
          toast('已保存到当日饮食', 'ok');
          close('saved');
        } catch (err) {
          toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = '保存到当日';
        }
      });

      return el('div', { className: 'col' },
        meta.raw ? el('details', { className: 'details' },
          el('summary', { className: 'muted', text: '查看模型原文' }),
          el('pre', { className: 'details__pre', text: meta.raw }),
        ) : null,
        mergeBar,
        listNode,
        totalsNode,
        el('div', { className: 'divider' }),
        el('label', { className: 'field' }, el('span', { className: 'field__label', text: '记到哪一餐' }), slotSelect),
        saveBtn,
        meta.source === 'manual' ? el('button', {
          className: 'btn btn--ghost btn--block', text: '继续添加',
          onClick: () => close('add'),
        }) : null,
      );
    },
  });
}

// 食物搜索 + 份量选择，解析为 { food, item }（item 为按克数算好的 MealItem）或 null。
// mode === 'dish' 时给的是「整份替换」语境：文案改成挑一道菜，数据侧没菜时也照常可选原料。
function openPickFoodSheet({ title = '手动添加', mode = 'pick' } = {}) {
  const isDishMode = mode === 'dish';
  return openSheet({
    title,
    actions: [],
    content: ({ close }) => {
      const search = el('input', { className: 'input', type: 'search', placeholder: isDishMode ? '搜索菜名，如「菠菜炒鸡蛋」' : '搜索食物，如「米饭」「鸡蛋」' });
      const results = el('div', { className: 'list pick-list' });
      const detail = el('div', { className: 'col' });
      const recentBox = el('div', { className: 'col recent-block' });

      // options.grams 覆盖默认份量（最近吃过用上次的克数）；
      // options.baseItem 有值时按它等比缩放，保住上次记录里的原始数值。
      const showDetail = (food, options = {}) => {
        clear(detail);
        detail.appendChild(renderPortionDetail(food, {
          baseItem: options.baseItem || null,
          grams: options.grams,
          dishMode: isDishMode,
          onSubmit: (item) => close({ food, item }),
        }));
      };

      // 「最近吃过」：无数据整块不渲染；默认折叠成一行，点开才 inline 展开。
      // 折叠时不建行节点，弹层一打开不会先被 8 条历史占满一屏。
      const showRecent = async () => {
        if (isDishMode) return;
        let entries = [];
        try {
          entries = await recentFoodItems(RECENT_LIMIT);
        } catch {
          // 最近吃过只是锦上添花：读不到就整块不渲染，不影响搜索与手动添加。
          return;
        }
        if (!Array.isArray(entries) || !entries.length) return;
        const rows = entries.slice(0, RECENT_LIMIT);
        const list = el('div', { className: 'list recent-list' });
        for (const entry of rows) {
          const item = entry.item || {};
          list.appendChild(el('button', {
            className: 'list__item recent-item',
            type: 'button',
            attr: { 'aria-label': `编辑 ${entry.name} 的份量` },
            onClick: () => showDetail(recentToFood(entry), { grams: item.grams, baseItem: item }),
          },
            el('div', { className: 'list__item--main' },
              el('div', { className: 'strong', text: entry.name }),
              el('div', { className: 'list__item--meta', text: `上次 ${entry.lastDate} · ${fmtKcal(item.kcal)} kcal / ${fmtKcal(item.grams)} g` }),
            ),
            el('span', { className: 'muted', text: '份量' }),
          ));
        }
        const caret = el('span', { className: 'recent-head__caret', text: '▼', attr: { 'aria-hidden': 'true' } });
        const toggle = el('button', {
          className: 'recent-head',
          type: 'button',
          attr: { 'aria-expanded': 'false', 'aria-label': `展开最近吃过（${rows.length} 条）` },
          onClick: () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}最近吃过（${rows.length} 条）`);
            caret.textContent = open ? '▲' : '▼';
            if (open) recentBox.appendChild(list);
            else list.remove();
          },
        },
          el('span', { text: `最近吃过 (${rows.length})` }),
          caret,
        );
        clear(recentBox);
        recentBox.appendChild(toggle);
      };

      const runSearch = () => {
        const foods = orderFoodsForPick(searchFoods(search.value.trim(), 20));
        clear(results);
        if (!foods.length) {
          results.appendChild(el('div', { className: 'empty', text: '没有匹配的食物，换个关键词试试' }));
          return;
        }
        for (const food of foods) {
          results.appendChild(renderPickRow(food, () => showDetail(food)));
        }
      };

      // 输入即筛，200ms 防抖避免每敲一个字都重排 100+ 条。
      let timer = 0;
      search.addEventListener('input', () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(runSearch, 200);
      });
      runSearch();
      showRecent();

      return el('div', { className: 'col' },
        search,
        el('div', { className: 'muted', text: isDishMode ? '选一道菜，整份清单会替换成它（菜品排在前面）' : '从内置食物库选择，营养值按克数换算' }),
        results,
        detail,
        recentBox,
      );
    },
  });
}

// 带可取消遮罩的异步任务：返回 { value } | { error } | { cancelled }。
async function withLoading(title, task) {
  let closeSheet = null;
  const sheetPromise = openSheet({
    title,
    actions: [{ text: '取消', value: 'cancel' }],
    content: ({ close }) => {
      closeSheet = close;
      return el('div', { className: 'col center loading' },
        el('div', { className: 'spinner', attr: { 'aria-hidden': 'true' } }),
        el('div', { className: 'muted', text: '正在识别食物，通常 5~20 秒' }),
      );
    },
  }).then(() => ({ type: 'cancel' }));
  const taskPromise = Promise.resolve()
    .then(task)
    .then((value) => ({ type: 'ok', value }), (error) => ({ type: 'error', error }));
  const first = await Promise.race([sheetPromise, taskPromise]);
  if (closeSheet) closeSheet(null);
  // analyzeFoodPhoto 没有 AbortSignal 参数，取消只能丢弃在途结果；界面上的取消立即生效。
  if (first.type === 'cancel') return { cancelled: true };
  return first;
}

// 无 Key 时不进请求，直接给去设置页的出口（SPEC §9）。
async function offerApiKeyHelp(date, reload) {
  const action = await openSheet({
    title: '还没配置 API Key',
    content: el('div', { className: 'col' },
      el('div', { className: 'muted', text: '拍照识别需要阿里百炼 DashScope 的 API Key。Key 只保存在本机 IndexedDB，只用于直连识别接口。' }),
    ),
    actions: [
      { text: '去设置页填写', value: 'settings', primary: true },
      { text: '先手动添加', value: 'manual' },
      { text: '取消', value: null },
    ],
  });
  if (action === 'settings') go('#/settings');
  if (action === 'manual') await manualFlow(date, reload);
}

async function startPhoto(file, date, reload) {
  const settings = await getSettings();
  const apiKey = (settings && settings.apiKey ? String(settings.apiKey) : '').trim();
  if (!apiKey) {
    await offerApiKeyHelp(date, reload);
    return;
  }

  const attempt = async (currentFile) => {
    const prep = await withLoading('正在处理照片…', () => fileToDataUrl(currentFile));
    if (prep.cancelled) { toast('已取消', 'info'); return; }
    if (prep.error) {
      toast(`照片处理失败：${prep.error.message || prep.error}`, 'error');
      return;
    }
    const compressed = prep.value;
    const run = await withLoading('正在识别食物…', () => analyzeFoodPhoto(currentFile, {
      apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
    }));
    if (run.cancelled) {
      toast('已取消识别，照片没有上传结果', 'info');
      return;
    }
    if (run.error) {
      const message = run.error && run.error.message ? run.error.message : String(run.error);
      const raw = run.error && (run.error.raw || run.error.rawText);
      const actions = [
        { text: '重试', value: 'retry', primary: true },
        { text: '手动添加', value: 'manual' },
        { text: '取消', value: null },
      ];
      if (/401|403|无效|未开通|权限/i.test(message)) {
        actions.unshift({ text: '去设置检查 Key', value: 'settings', primary: true });
      }
      const action = await openSheet({
        title: '识别失败',
        content: el('div', { className: 'col' },
          el('div', { className: 'error-text', text: message }),
          /404|模型|model/i.test(message)
            ? el('div', { className: 'muted', text: `可在设置里切换模型后重试，候选：${MODEL_CANDIDATES.join(' / ')}` })
            : null,
          raw ? el('details', { className: 'details' },
            el('summary', { className: 'muted', text: '查看模型原文' }),
            el('pre', { className: 'details__pre', text: String(raw) }),
          ) : null,
          el('div', { className: 'muted', text: '照片还在本机，可直接重试，或手动录入这一餐。' }),
        ),
        actions,
      });
      if (action === 'retry') await attempt(currentFile);
      if (action === 'manual') await manualFlow(date, reload);
      if (action === 'settings') go('#/settings');
      return;
    }

    const items = (run.value && Array.isArray(run.value.items)) ? run.value.items : [];
    if (!items.length) {
      toast('没识别出食物，换个角度重拍或手动添加', 'error');
      return;
    }
    const saved = await openDraftSheet(items, {
      date,
      source: 'ai',
      raw: run.value.raw,
      slot: defaultSlot(await slotOffsetOf()),
      onTemplateSaved: reload,
      photo: compressed && compressed.dataUrl
        ? { blob: dataUrlToBlob(compressed.dataUrl, compressed.mime || 'image/jpeg'), mime: compressed.mime || 'image/jpeg' }
        : { blob: currentFile, mime: currentFile.type || 'image/jpeg' },
    });
    if (saved === 'saved') await reload();
  };

  await attempt(file);
}

async function manualFlow(date, reload) {
  const picked = [];
  for (;;) {
    const pick = await openPickFoodSheet();
    if (!pick || !pick.item) break;
    picked.push(pick.item);
    const action = await openDraftSheet(picked, {
      date, source: 'manual', slot: defaultSlot(await slotOffsetOf()), onTemplateSaved: reload,
    });
    if (action === 'saved') { await reload(); return; }
    if (action === 'add') continue;
    return;
  }
}

/** 条目在界面上的名字：脏记录（缺 name / 非字符串）不给 undefined，退化成空串。 */
function itemLabel(item) {
  return item && typeof item === 'object' && typeof item.name === 'string' ? item.name.trim() : '';
}

/** 这一项是不是这餐里最后一个能渲染的条目（后面再没有别的对象条目）。 */
function isLastRenderableItem(items, index) {
  return !(Array.isArray(items) ? items : []).some((it, i) => i !== index && it && typeof it === 'object');
}

/**
 * 删条目的二次确认：列表直删与「修改」面板内删除共用这一份文案 ——
 * 两处说同一句话，改文案只改这一个地方，不会只改到一边。
 */
function confirmRemoveItem(item, index, items) {
  const name = itemLabel(item) || '这一项';
  return confirmDialog({
    title: '删除这一项？',
    message: isLastRenderableItem(items, index)
      ? `${name} · 这是这一餐的最后一项，整餐会一起删掉`
      : `${name} · ${fmtKcal(item.grams)}g`,
    okText: '删除',
  });
}

/**
 * 餐卡列表上的直删：删一条不用先打开「修改」面板。
 * 二次确认与面板内删除同源，删除本身也走同一个 removeMealItem ——
 * 「删最后一项连整餐一起删」的提示因此不可能出现两种说法。
 */
async function removeItemFromList(meal, index, reload) {
  const items = Array.isArray(meal.items) ? meal.items : [];
  const item = items[index];
  // 脏记录防御：非对象条目没有可删的内容，提示一句就退（索引仍是原始数组位置）。
  if (!item || typeof item !== 'object') {
    toast('这一项读不出来，刷新后再试', 'error');
    return;
  }
  if (!(await confirmRemoveItem(item, index, items))) return;
  await removeMealItem(meal, index, reload);
}

// 「修改」面板：改克数（单位 chip + 克数 + 实时预览 + 目测参考）/ 替换食物 / 删除这一项。
// index 始终是原始 items 数组里的位置 —— 列表渲染层传进来的索引语义不变。
async function editMealPortion(meal, index, reload) {
  const items = Array.isArray(meal.items) ? meal.items : [];
  const item = items[index];
  // 脏记录防御：非对象条目没有可编辑的内容，提示一句就退，不让 undefined 漏进面板。
  if (!item || typeof item !== 'object') {
    toast('这一项读不出来，刷新后再试', 'error');
    return;
  }
  const grams = el('input', { className: 'input', type: 'number', value: String(item.grams), min: '1', max: '2000', step: '1' });
  const preview = el('div', { className: 'muted portion-preview' });
  const update = () => {
    const next = rescaleItem(item, grams.value);
    // rescaleItem 只缩放已有的键：缺 fiber 的条目预览里也不会凭空出现纤维。
    preview.textContent = `${fmtKcal(next.kcal)} kcal · 碳水 ${fmt1(next.carb)}g · 蛋白质 ${fmt1(next.protein)}g · 脂肪 ${fmt1(next.fat)}g${fiberPreviewSuffix(next)}`;
  };
  // 条目存的是 foodId：能对上库内食物就把它的常用单位摆出来，选中即换算克数。
  const food = foodById(item.foodId);
  const chipRow = renderUnitChips({ units: unitsOf(food), grams, onChange: update });
  grams.addEventListener('input', () => {
    update();
    if (chipRow) chipRow.sync();
  });
  update();

  // 替换食物要先记下面板里的当前克数：选完新食物按它重算，越界才回落新食物的默认份量。
  let gramsAtClose = String(grams.value);
  let closeSheet = () => {};
  const action = await openSheet({
    title: `修改 · ${item.name}`,
    content: ({ close }) => {
      closeSheet = close;
      return el('div', { className: 'col' },
        chipRow ? chipRow.node : null,
        el('label', { className: 'field' }, el('span', { className: 'field__label', text: '克数' }), grams),
        preview,
        el('div', { className: 'portion-ref', text: PORTION_REF_TEXT }),
        el('button', {
          className: 'btn btn--ghost btn--block', type: 'button', text: '替换食物',
          attr: { 'aria-label': `把 ${item.name} 换成别的食物` },
          onClick: () => {
            gramsAtClose = String(grams.value);
            closeSheet('replace');
          },
        }),
      );
    },
    actions: [
      { text: '保存', value: 'save', primary: true },
      { text: '删除这一项', value: 'delete', danger: true },
      { text: '取消', value: null },
    ],
  });
  if (action === 'delete') {
    // 危险操作：先问一句（文案与列表直删共用）。删掉最后一条能渲染的条目后这一餐就空了，连整餐一起删。
    if (!(await confirmRemoveItem(item, index, items))) return;
    await removeMealItem(meal, index, reload);
    return;
  }
  if (action === 'replace') {
    await replaceMealItemFlow(meal, index, item, gramsAtClose, reload);
    return;
  }
  if (action !== 'save') return;
  const nextItems = items.map((it, i) => (i === index ? rescaleItem(it, grams.value) : it));
  try {
    await updateMeal(meal.id, { items: nextItems });
    toast('份量已更新', 'ok');
    await reload();
  } catch (err) {
    toast(`更新失败：${err && err.message ? err.message : err}`, 'error');
  }
}

// 删除这一项：剩下的条目里再没有能渲染的对象时，这一餐已经空了，连整餐一起删。
async function removeMealItem(meal, index, reload) {
  const items = Array.isArray(meal.items) ? meal.items : [];
  const rest = items.filter((_, i) => i !== index);
  const hasItemLeft = rest.some((it) => it && typeof it === 'object');
  try {
    if (hasItemLeft) {
      await updateMeal(meal.id, { items: rest });
      toast('已删除这一项', 'ok');
    } else {
      await deleteMeal(meal.id);
      toast('已删除最后一项，整餐已移除', 'ok');
    }
    await reload();
  } catch (err) {
    toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
  }
}

// 替换食物：复用既有的食物搜索弹层（openPickFoodSheet），选中后整项换成新食物。
async function replaceMealItemFlow(meal, index, item, rawGrams, reload) {
  const pick = await openPickFoodSheet({ title: '换成别的食物', mode: 'pick' });
  if (!pick || !pick.food) return;
  const next = replaceMealItem(item, pick.food, rawGrams);
  // 只替换原始数组里的这一格，其余条目原样带回去。
  const items = Array.isArray(meal.items) ? meal.items : [];
  const nextItems = items.map((it, i) => (i === index ? next : it));
  try {
    await updateMeal(meal.id, { items: nextItems });
    toast(`已换成 ${next.name}`, 'ok');
    await reload();
  } catch (err) {
    toast(`替换失败：${err && err.message ? err.message : err}`, 'error');
  }
}

function renderMealCard(meal, reload) {
  const card = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'row' },
        el('span', { className: 'card__title', text: slotLabel(meal.slot) }),
        el('span', { className: 'pill', text: meal.source === 'ai' ? 'AI' : '手动' }),
      ),
      el('div', { className: 'row' },
        el('span', { className: 'muted', text: meal.createdAt ? fmtTime(meal.createdAt) : '' }),
        el('button', {
          className: 'btn btn--ghost btn--sm btn--danger', text: '删整餐',
          onClick: async () => {
            const ok = await confirmDialog({
              title: '删除这一餐？',
              message: `${slotLabel(meal.slot)} · ${(meal.items || []).length} 项`,
              okText: '删除',
            });
            if (!ok) return;
            try {
              await deleteMeal(meal.id);
              toast('已删除整餐', 'ok');
              await reload();
            } catch (err) {
              toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
            }
          },
        }),
      ),
    ),
  );
  const list = el('div', { className: 'list' });
  const mealItems = Array.isArray(meal.items) ? meal.items : [];
  mealItems.forEach((item, index) => {
    // 脏记录防御：条目不是对象就跳过渲染（索引仍对应原始数组位置，份量按钮靠它定位原条目）。
    if (!item || typeof item !== 'object') return;
    const itemName = typeof item.name === 'string' ? item.name.trim() : '';
    const itemGrams = Number.isFinite(Number(item.grams)) ? String(item.grams) : '—';
    const hint = itemUnitHint(item);
    list.appendChild(el('div', { className: 'list__item' },
      el('div', { className: 'list__item--main' },
        el('div', { className: 'row' },
          el('span', { className: 'strong', text: itemName }),
          item.confidence ? confidencePill(item.confidence) : null,
        ),
        el('div', { className: 'list__item--meta', text: `${itemGrams}g${hint ? `（${hint}）` : ''} · ${fmtKcal(item.kcal)} kcal · 碳 ${fmt1(item.carb)} / 蛋 ${fmt1(item.protein)} / 脂 ${fmt1(item.fat)}${fiberMetaSuffix(item)}` }),
      ),
      // 「修改」旁边给一个直删入口：删一条不该逼用户先打开整张修改面板。
      el('div', { className: 'row item-row__edit' },
        el('button', {
          className: 'btn btn--ghost btn--sm', text: '修改',
          onClick: () => editMealPortion(meal, index, reload),
        }),
        el('button', {
          className: 'btn btn--ghost btn--sm btn--danger', text: '删',
          attr: { 'aria-label': `删除 ${itemName || '这一项'}` },
          onClick: () => removeItemFromList(meal, index, reload),
        }),
      ),
    ));
  });
  card.appendChild(list);
  return card;
}

async function paint(root, date, reload) {
  const today = localDateStr();
  const [summary, settings, goals, templates] = await Promise.all([
    daySummary(date), getSettings(), getGoals(), getMealTemplates(),
  ]);

  const hasKey = Boolean(settings && settings.apiKey && String(settings.apiKey).trim());
  root.appendChild(el('div', { className: 'col' },
    el('div', { className: 'h1', text: '饮食' }),
    el('div', { className: 'muted', text: `${fmtDateCN(date)}${date === today ? '（今天）' : ''}` }),
  ));

  const nav = el('div', { className: 'card row row--between' },
    el('button', { className: 'btn btn--ghost btn--sm', text: '‹ 前一天', onClick: async () => reload(shiftDate(date, -1)) }),
    el('div', { className: 'row' },
      date !== today ? el('button', { className: 'btn btn--ghost btn--sm', text: '回到今天', onClick: async () => reload(today) }) : null,
      el('span', { className: 'strong', text: fmtDateCN(date) }),
    ),
    el('button', {
      className: `btn btn--ghost btn--sm ${date >= today ? 'is-disabled' : ''}`,
      text: '后一天 ›',
      onClick: async () => { if (date < today) await reload(shiftDate(date, 1)); },
    }),
  );
  root.appendChild(nav);

  // 日期条下方：常吃套餐。没有套餐且当天不足 2 餐时整块不渲染，不留空白。
  const templateCard = renderTemplateCard(templates, date, reload, groupDayMeals(summary.meals).length);
  if (templateCard) root.appendChild(templateCard);

  // 相机/相册各一个 label 包 input：label 点击即原生打开选择器，没有额外的用户手势损耗。
  const cameraInput = el('input', { className: 'hidden-file', type: 'file', accept: 'image/*', attr: { capture: 'environment' } });
  const albumInput = el('input', { className: 'hidden-file', type: 'file', accept: 'image/*' });
  const onPick = (input) => async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) await startPhoto(file, date, reload);
  };
  cameraInput.addEventListener('change', onPick(cameraInput));
  albumInput.addEventListener('change', onPick(albumInput));
  const guardKey = (event) => {
    if (hasKey) return;
    event.preventDefault();
    offerApiKeyHelp(date, reload);
  };
  const cameraLabel = el('label', { className: 'btn btn--primary btn--block' }, cameraInput, '拍照识别');
  const albumLabel = el('label', { className: 'btn btn--ghost btn--block' }, albumInput, '从相册选择');
  cameraLabel.addEventListener('click', guardKey);
  albumLabel.addEventListener('click', guardKey);

  const actionCard = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '记录一餐' }),
      el('div', { className: `pill ${hasKey ? 'pill--ok' : 'pill--warn'}`, text: hasKey ? 'AI 已就绪' : '未配置 Key' }),
    ),
    cameraLabel,
    albumLabel,
    el('button', { className: 'btn btn--ghost btn--block', text: '手动添加', onClick: () => manualFlow(date, reload) }),
  );
  root.appendChild(actionCard);

  const meals = Array.isArray(summary.meals) ? summary.meals : [];
  if (!meals.length) {
    root.appendChild(el('div', { className: 'card' },
      emptyState('这一天还没有饮食记录', '拍照识别第一餐', () => {
        if (hasKey) cameraInput.click();
        else offerApiKeyHelp(date, reload);
      }),
    ));
  } else {
    for (const slot of SLOTS) {
      const group = meals.filter((m) => m.slot === slot.value);
      if (!group.length) continue;
      const slotItems = [];
      for (const groupMeal of group) {
        for (const item of (Array.isArray(groupMeal.items) ? groupMeal.items : [])) slotItems.push(item);
      }
      root.appendChild(el('div', { className: 'h2', text: `${slot.label} · ${group.reduce((s, m) => s + sumItems(m.items || []).kcal, 0)} kcal${fiberSubtotalSuffix(slotItems)}` }));
      for (const meal of group) root.appendChild(renderMealCard(meal, reload));
    }
  }

  const intake = summary.intake || { kcal: 0, carb: 0, protein: 0, fat: 0 };
  // 当日纤维：只累加有数据的条目，缺数据的条数一并带出来给用户一句实话。
  const dayItems = [];
  for (const dayMeal of meals) {
    for (const item of (Array.isArray(dayMeal.items) ? dayMeal.items : [])) dayItems.push(item);
  }
  const fiberText = fiberSummaryText(fiberTotals(dayItems));
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '当日合计' }),
      el('div', { className: 'muted', text: `运动消耗 ${fmtKcal(summary.burned)} kcal` }),
    ),
    el('div', { className: 'row row--between' },
      el('div', { className: 'stat' },
        el('div', { className: 'stat__line' },
          el('span', { className: 'stat__value', text: fmtKcal(intake.kcal) }),
          el('span', { className: 'stat__unit', text: 'kcal' }),
        ),
        el('div', { className: 'stat__label', text: '总摄入' }),
      ),
      el('div', { className: 'col align-end' },
        el('div', { className: 'label', text: '碳水 / 蛋白质 / 脂肪' }),
        el('div', { className: 'strong', text: `${fmt1(intake.carb)} / ${fmt1(intake.protein)} / ${fmt1(intake.fat)} g` }),
        // 用户决策：纤维只报摄取量，不给每日目标 —— 所以这里没有进度条。
        fiberText ? el('div', { className: 'label', text: '膳食纤维' }) : null,
        fiberText ? el('div', { className: 'strong', text: fiberText }) : null,
      ),
    ),
    bar({ value: intake.kcal, max: Math.max(1, Number(goals.calorieTarget) || 1), color: 'var(--brand)' }),
    el('div', { className: 'muted', text: `目标的 ${Math.round((intake.kcal / Math.max(1, Number(goals.calorieTarget) || 1)) * 100)}%` }),
  ));
}

export async function render(root) {
  let date = localDateStr();
  let seq = 0;
  const reload = async (nextDate) => {
    if (nextDate) date = nextDate;
    const current = ++seq;
    // 连点套餐、快速切日期都会并发触发 reload：先画到临时容器，最后一次整体替换，
    // 否则两次 paint 交错会把整页内容追加两遍。
    const staging = el('div');
    await paint(staging, date, reload);
    if (current !== seq) return;
    const kids = Array.from(staging.childNodes);
    clear(root);
    for (const child of kids) root.appendChild(child);
  };
  await reload();
}
