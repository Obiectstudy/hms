// 饮食页（SPEC §7「饮食」+ §9 错误处理）：拍照识别 / 手动添加 / 当日餐次维护。
import {
  el, clear, toast, openSheet, confirmDialog, emptyState, fmtKcal, fmt1, fmtDateCN, fmtTime, bar,
} from '../js/ui.js';
import { localDateStr, parseDateStr, round1, sumItems, scaleFood as scalePer100g } from '../js/nutrition.js';
import { getSettings, getGoals, daySummary, logMeal, updateMeal, deleteMeal, savePhoto } from '../js/store.js';
import { fileToDataUrl, analyzeFoodPhoto, MODEL_CANDIDATES } from '../js/vision.js';
import { searchFoods } from '../js/foods.js';

const SLOTS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

const go = (hash) => window.HMS.navigate(hash);

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

// 复合菜在数据侧用 kind === 'dish' 标记（另一人并行补数据，字段可能暂时缺失）。
// 判定只认这一个字段：缺失 / 其它值一律按原料处理，不抛错。
export function isDish(food) {
  return Boolean(food && food.kind === 'dish');
}

/** 整份克数：优先单位换算（1 盘 ≈ 300g），缺省 200g。 */
export function defaultDishGrams(food) {
  const unitGrams = Number(food && food.unit && food.unit.grams);
  if (Number.isFinite(unitGrams) && unitGrams > 0) return clampGrams(unitGrams);
  return 200;
}

/** 选中食物时份量框默认值：菜品按整份算，原料沿用 unit.grams 或 100g。 */
export function pickDefaultGrams(food) {
  if (isDish(food)) return defaultDishGrams(food);
  const unitGrams = Number(food && food.unit && food.unit.grams);
  if (Number.isFinite(unitGrams) && unitGrams > 0) return clampGrams(unitGrams);
  return 100;
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

/** 搜索结果单行：菜品带「菜」徽标，原料不带。 */
export function renderPickRow(food, onPick) {
  const meta = [`${fmtKcal(food.per100g && food.per100g.kcal)} kcal / 100g`];
  if (food.unit) meta.push(`1 ${food.unit.name}=${food.unit.grams}g`);
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
      const mergeBar = el('div', { className: 'merge-bar' },
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

      const showDetail = (food) => {
        clear(detail);
        const defaultGrams = pickDefaultGrams(food);
        const unitText = food.unit ? `1 ${food.unit.name} ≈ ${food.unit.grams}g` : '';
        const grams = el('input', { className: 'input', type: 'number', inputmode: 'decimal', min: '1', max: '2000', step: '1', value: String(defaultGrams) });
        const preview = el('div', { className: 'muted' });
        const updatePreview = () => {
          const item = scaleFood(food, grams.value);
          preview.textContent = `${fmtKcal(item.kcal)} kcal · 碳水 ${fmt1(item.carb)}g · 蛋白质 ${fmt1(item.protein)}g · 脂肪 ${fmt1(item.fat)}g`;
        };
        grams.addEventListener('input', updatePreview);
        updatePreview();
        const quick = [];
        if (food.unit) {
          quick.push(el('button', {
            className: 'chip', text: `1 ${food.unit.name} ≈ ${food.unit.grams}g`,
            onClick: () => { grams.value = String(food.unit.grams); updatePreview(); },
          }));
        }
        quick.push(el('button', {
          className: 'chip', text: '100g',
          onClick: () => { grams.value = '100'; updatePreview(); },
        }));
        const detailParts = [
          el('div', { className: 'row row--between divider' },
            el('div', { className: 'row' },
              el('span', { className: 'strong', text: food.name }),
              isDish(food) ? el('span', { className: 'pill pill--dish', text: '菜' }) : null,
            ),
            el('span', { className: 'muted', text: `每 100g ${fmtKcal(food.per100g && food.per100g.kcal)} kcal` }),
          ),
          el('div', { className: 'row chips' }, quick),
          el('label', { className: 'field' }, el('span', { className: 'field__label', text: unitText ? `克数（${unitText}）` : '克数' }), grams),
          preview,
          el('button', {
            className: 'btn btn--primary btn--block', text: isDishMode ? '就用这道菜' : '加入清单',
            onClick: () => {
              const g = Number(grams.value);
              if (!Number.isFinite(g) || g <= 0) { toast('请填写克数', 'error'); return; }
              close({ food, item: scaleFood(food, g) });
            },
          }),
        ];
        for (const part of detailParts) detail.appendChild(part);
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

      return el('div', { className: 'col' },
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
    const action = await openDraftSheet(picked, { date, source: 'manual', slot: defaultSlot() });
    if (action === 'saved') { await reload(); return; }
    if (action === 'add') continue;
    return;
  }
}

async function editMealPortion(meal, index, reload) {
  const item = meal.items[index];
  const grams = el('input', { className: 'input', type: 'number', value: String(item.grams), min: '1', max: '2000', step: '1' });
  const preview = el('div', { className: 'muted' });
  const update = () => {
    const next = rescaleItem(item, grams.value);
    preview.textContent = `${fmtKcal(next.kcal)} kcal · 碳水 ${fmt1(next.carb)}g · 蛋白质 ${fmt1(next.protein)}g · 脂肪 ${fmt1(next.fat)}g`;
  };
  grams.addEventListener('input', update);
  update();
  const action = await openSheet({
    title: `修改份量 · ${item.name}`,
    content: el('div', { className: 'col' },
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '克数' }), grams),
      preview,
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
    list.appendChild(el('div', { className: 'list__item' },
      el('div', { className: 'list__item--main' },
        el('div', { className: 'row' },
          el('span', { className: 'strong', text: item.name }),
          item.confidence ? confidencePill(item.confidence) : null,
        ),
        el('div', { className: 'list__item--meta', text: `${item.grams}g · ${fmtKcal(item.kcal)} kcal· 碳 ${fmt1(item.carb)} / 蛋 ${fmt1(item.protein)} / 脂 ${fmt1(item.fat)}` }),
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
  const [summary, settings, goals] = await Promise.all([daySummary(date), getSettings(), getGoals()]);

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
  const reload = async (nextDate) => {
    if (nextDate) date = nextDate;
    clear(root);
    await paint(root, date, reload);
  };
  await reload();
}
