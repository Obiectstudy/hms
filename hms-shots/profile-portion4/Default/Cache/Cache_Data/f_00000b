// 饮食页（SPEC §7「饮食」+ §9 错误处理）：拍照识别 / 手动添加 / 当日餐次维护。
import {
  el, clear, toast, openSheet, confirmDialog, emptyState, fmtKcal, fmt1, fmtDateCN, fmtTime, bar,
} from '../js/ui.js';
import { localDateStr, parseDateStr, round1, sumItems, scaleFood as scalePer100g } from '../js/nutrition.js';
import {
  getSettings, getGoals, daySummary, logMeal, updateMeal, deleteMeal, savePhoto,
  getMealTemplates, saveMealTemplate, deleteMealTemplate, recentFoodItems,
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
// 「最近吃过」只放一屏 8 条，再多就和搜索框抢注意力了。
const RECENT_LIMIT = 8;

function slotLabel(slot) {
  const hit = SLOTS.find((s) => s.value === slot);
  return hit ? hit.label : '餐次';
}

function defaultSlot() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
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
    preview.textContent = `${fmtKcal(item.kcal)} kcal · 碳水 ${fmt1(item.carb)}g · 蛋白质 ${fmt1(item.protein)}g · 脂肪 ${fmt1(item.fat)}g`;
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
    name: food.name,
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

/* ---------- 常吃套餐（SPEC §7 饮食：一键记入 + 存为套餐） ---------- */

/** 只渲染前 6 个；脏数据（缺 name）直接丢掉，不占位。 */
export function visibleTemplates(templates) {
  const list = Array.isArray(templates) ? templates.filter((t) => t && t.name) : [];
  return list.slice(0, MAX_TEMPLATE_CHIPS);
}

/** 套餐在 chip 上要显示的总热量：与当日合计同一套求和口径。 */
export function templateKcal(template) {
  return sumItems((template && template.items) || []).kcal;
}

/** 弹层里的小表单：只收一个套餐名，空名视为取消。 */
function askTemplateName(defaultName) {
  const input = el('input', {
    className: 'input', type: 'text', value: String(defaultName || ''), placeholder: '例如：午餐套餐',
    attr: { maxlength: '20' },
  });
  return openSheet({
    title: '存为套餐',
    content: el('div', { className: 'col' },
      el('div', { className: 'muted', text: '存下来以后，在饮食页点一下就能把这份清单记入当天；同名套餐会被覆盖' }),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '套餐名' }), input),
    ),
    actions: [{ text: '保存套餐', value: 'save', primary: true }, { text: '取消', value: null }],
  }).then((value) => (value === 'save' ? String(input.value || '').trim() : ''));
}

async function recordTemplate(template, date, reload) {
  try {
    await logMeal({
      date,
      slot: template.slot,
      source: 'manual',
      items: (template.items || []).map((item) => ({ ...item })),
    });
    toast(`已记入 · ${template.name}`, 'ok');
    await reload();
  } catch (err) {
    toast(`记入失败：${err && err.message ? err.message : err}`, 'error');
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

/** 常吃套餐横条：无套餐时返回 null，调用方不 append，页面不留空白。 */
function renderTemplateCard(templates, date, reload) {
  const list = visibleTemplates(templates);
  if (!list.length) return null;
  const row = el('div', { className: 'tpl-row' });
  for (const template of list) {
    row.appendChild(el('div', { className: 'tpl-chip' },
      el('button', {
        className: 'tpl-chip__main',
        type: 'button',
        attr: { 'aria-label': `记入套餐 ${template.name}` },
        onClick: () => { recordTemplate(template, date, reload).catch((err) => toast(`记入失败：${err && err.message ? err.message : err}`, 'error')); },
      },
        el('span', { className: 'tpl-chip__name', text: template.name }),
        el('span', { className: 'tpl-chip__kcal', text: `${fmtKcal(templateKcal(template))} kcal` }),
      ),
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
      el('div', { className: 'card__title', text: '常吃套餐' }),
      el('div', { className: 'muted', text: '点一下记入当天' }),
    ),
    row,
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
      slotSelect.value = meta.slot || defaultSlot();

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
              el('div', { className: 'list__item--meta', text: `${fmtKcal(item.kcal)} kcal · 碳 ${fmt1(item.carb)} · 蛋 ${fmt1(item.protein)} · 脂 ${fmt1(item.fat)}` }),
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

      // 「最近吃过」：无数据整块不渲染，点一下直接进份量编辑（默认克数取上次）。
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
        clear(recentBox);
        recentBox.appendChild(el('div', { className: 'label', text: '最近吃过' }));
        const list = el('div', { className: 'list recent-list' });
        for (const entry of entries.slice(0, RECENT_LIMIT)) {
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
        recentBox.appendChild(list);
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
        recentBox,
        search,
        el('div', { className: 'muted', text: isDishMode ? '选一道菜，整份清单会替换成它（菜品排在前面）' : '从内置食物库选择，营养值按克数换算' }),
        results,
        detail,
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
      slot: defaultSlot(),
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
      date, source: 'manual', slot: defaultSlot(), onTemplateSaved: reload,
    });
    if (action === 'saved') { await reload(); return; }
    if (action === 'add') continue;
    return;
  }
}

async function editMealPortion(meal, index, reload) {
  const item = meal.items[index];
  const grams = el('input', { className: 'input', type: 'number', value: String(item.grams), min: '1', max: '2000', step: '1' });
  const preview = el('div', { className: 'muted portion-preview' });
  const update = () => {
    const next = rescaleItem(item, grams.value);
    preview.textContent = `${fmtKcal(next.kcal)} kcal · 碳水 ${fmt1(next.carb)}g · 蛋白质 ${fmt1(next.protein)}g · 脂肪 ${fmt1(next.fat)}g`;
  };
  // 条目存的是 foodId：能对上库内食物就把它的常用单位摆出来，选中即换算克数。
  const food = foodById(item.foodId);
  const chipRow = renderUnitChips({ units: unitsOf(food), grams, onChange: update });
  grams.addEventListener('input', () => {
    update();
    if (chipRow) chipRow.sync();
  });
  update();
  const action = await openSheet({
    title: `修改份量 · ${item.name}`,
    content: el('div', { className: 'col' },
      chipRow ? chipRow.node : null,
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '克数' }), grams),
      preview,
      el('div', { className: 'portion-ref', text: PORTION_REF_TEXT }),
    ),
    actions: [{ text: '保存', value: 'save', primary: true }, { text: '取消', value: null }],
  });
  if (action !== 'save') return;
  const nextItems = meal.items.map((it, i) => (i === index ? rescaleItem(it, grams.value) : it));
  try {
    await updateMeal(meal.id, { items: nextItems });
    toast('份量已更新', 'ok');
    await reload();
  } catch (err) {
    toast(`更新失败：${err && err.message ? err.message : err}`, 'error');
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
  (meal.items || []).forEach((item, index) => {
    const hint = itemUnitHint(item);
    list.appendChild(el('div', { className: 'list__item' },
      el('div', { className: 'list__item--main' },
        el('div', { className: 'row' },
          el('span', { className: 'strong', text: item.name }),
          item.confidence ? confidencePill(item.confidence) : null,
        ),
        el('div', { className: 'list__item--meta', text: `${item.grams}g${hint ? `（${hint}）` : ''} · ${fmtKcal(item.kcal)} kcal · 碳 ${fmt1(item.carb)} / 蛋 ${fmt1(item.protein)} / 脂 ${fmt1(item.fat)}` }),
      ),
      el('button', {
        className: 'btn btn--ghost btn--sm', text: '份量',
        onClick: () => editMealPortion(meal, index, reload),
      }),
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

  // 日期条下方：常吃套餐。没有套餐时整块不渲染，不留空白。
  const templateCard = renderTemplateCard(templates, date, reload);
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
      root.appendChild(el('div', { className: 'h2', text: `${slot.label} · ${group.reduce((s, m) => s + sumItems(m.items || []).kcal, 0)} kcal` }));
      for (const meal of group) root.appendChild(renderMealCard(meal, reload));
    }
  }

  const intake = summary.intake || { kcal: 0, carb: 0, protein: 0, fat: 0 };
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
