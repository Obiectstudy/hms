// 今日总览（SPEC §7「今日」）。只读聚合 + 两个快捷写入（饮水）。
import { el, ring, bar, toast, emptyState, fmtKcal, fmtDateCN, fmtTime, fmt1, markBusy } from '../js/ui.js';
import { localDateStr, targetMacros, weightStats, sumItems, round1, kgToUnit, weightUnitLabel } from '../js/nutrition.js';
import { daySummary, getGoals, recentWeights, addWater, getSettings, exportStatus } from '../js/store.js';
// currentDailyTargets 走命名空间导入：命名导入缺导出会在模块链接期直接抛 SyntaxError（整页连同套件一起崩），
// 而这条接口由并行的实现方交付 —— 中间态必须能降级。与 views/food.js 里 foodsLib.foodUnits 同一套防御。
import * as storeApi from '../js/store.js';
// 导出下载只有一份实现（view 之间共用，避免两处逻辑漂移）。
import { exportBackupJSON } from './settings.js';

const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
// 提醒阈值：从未备份，或上次备份已满 7 天。
const BACKUP_REMIND_DAYS = 7;
const go = (hash) => window.HMS.navigate(hash);

/** 「还没有备份过」/「已 N 天没备份」。 */
export function backupReminderText(status) {
  const days = status && status.days;
  if (days == null || !Number.isFinite(Number(days))) return '还没有备份过';
  return `已 ${Math.max(0, Math.round(Number(days)))} 天没备份`;
}

/** hasData 且（从未备份 或 距上次 ≥ 7 天）才提醒；没数据时提醒等于噪音。 */
export function needsBackupReminder(status) {
  const s = status || {};
  if (!s.hasData) return false;
  if (s.days == null) return true;
  const days = Number(s.days);
  return Number.isFinite(days) && days >= BACKUP_REMIND_DAYS;
}

/**
 * 条目标题：只有「是对象、且 name 是有内容的字符串」才算一项。
 * 半截写入 / 手改过的库里可能有 null 或数字，渲染层要跳过它们 —— 但不上屏 undefined，
 * 也不因为一条脏记录把整页变成「这个页面加载失败了」。（数据层该怎么校验是数据层的事。）
 */
function itemNames(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => (item && typeof item === 'object' && typeof item.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
}

/** 脏条目也一并交给 sumItems 兜底（它按字段逐个取值），但 items 本身不是数组时按「无条目」处理。 */
function safeItems(items) {
  return Array.isArray(items) ? items : [];
}

function macroRow({ label, value, target, color, unit = 'g' }) {
  return el('div', { className: 'col macro' },
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: label }),
      el('span', { className: 'macro__nums' },
        el('span', { className: 'strong', text: fmt1(value) }),
        // 目标用与「每日目标」表同一套数字文本：同屏两处不该出现 126 / 125.5 这种分歧。
        el('span', { className: 'muted', text: ` / ${numText(target) || '0'} ${unit}` }),
      ),
    ),
    bar({ value, max: target, color }),
  );
}

/**
 * 三大宏量进度条的上限：优先用 currentDailyTargets() 的克数（与「每日目标」表同源），
 * 目标拿不到时才回落到 goals 占比的 4/4/9 反算 —— 降级不等于让进度条消失。
 */
function targetMacroGrams(targets, goals) {
  const fallback = targetMacros(Number(goals.calorieTarget) || 1, {
    carb: goals.carbPct, protein: goals.proteinPct, fat: goals.fatPct,
  });
  const t = normalizeDailyTargets(targets);
  if (!t) return fallback;
  const pick = (key) => {
    const grams = Number(t[key] && t[key].g);
    return Number.isFinite(grams) && grams > 0 ? grams : fallback[key];
  };
  return { carb: pick('carb'), protein: pick('protein'), fat: pick('fat') };
}

/* ---------- 每日目标（用户决策：指南口径 + 蛋白 g/kg + 纤维 / 钠纳入目标） ---------- */

/** 数字文本：整数不带小数点、有小数保留 1 位；非有限值（脏数据 / 溢出）返回空串，由调用方整行不渲染。 */
function numText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 10) / 10;
  if (!Number.isFinite(r)) return '';
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 目标对象是否可用：热量是有限正数才算（空对象 / 脏值 / 接口没落地一律 null → 降级卡）。 */
export function normalizeDailyTargets(raw) {
  const t = raw && typeof raw === 'object' ? raw : null;
  if (!t) return null;
  const kcal = Number(t.calorieTarget);
  return Number.isFinite(kcal) && kcal > 0 ? t : null;
}

/**
 * 目标载入守卫：接口没落地 / 读库抛错 一律降级成 null（目标卡退化成一行说明，不整页白屏）。
 * fetcher 只用于测试注入，生产路径永远是 store.currentDailyTargets()。
 */
export async function dailyTargetsOrNull(fetcher) {
  const load = typeof fetcher === 'function'
    ? fetcher
    : (typeof storeApi.currentDailyTargets === 'function' ? () => storeApi.currentDailyTargets() : null);
  if (!load) return null;
  try {
    return await load();
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[HMS] 每日目标不可用：', error);
    return null;
  }
}

/** 目标表：热量 + 三大宏量，宏量一行里同时给克数与供能比（如「碳水 260 g · 52%」）。 */
export function dailyTargetRows(targets) {
  const t = normalizeDailyTargets(targets);
  if (!t) return [];
  const rows = [];
  const kcal = numText(t.calorieTarget);
  if (kcal) rows.push({ key: 'kcal', label: '热量', text: `${kcal} kcal` });
  for (const [key, label] of [['carb', '碳水'], ['protein', '蛋白质'], ['fat', '脂肪']]) {
    const grams = numText(t[key] && t[key].g);
    const pct = numText(t[key] && t[key].pct);
    if (!grams || !pct) continue;
    rows.push({ key, label, text: `${grams} g · ${pct}%` });
  }
  return rows;
}

/** 推算依据一行：按减脂目标 · 蛋白 1.4 g/kg · 热量 −20%（缺字段就只说能说的那几段）。 */
export function basisText(basis) {
  const b = basis && typeof basis === 'object' ? basis : {};
  const kind = { cut: '减脂', maintain: '维持', bulk: '增肌' }[b.goalKind];
  const adjust = Number(b.calorieAdjustPct);
  const parts = [];
  if (kind) parts.push(`按${kind}目标`);
  const perKg = numText(b.gPerKg);
  if (perKg) parts.push(`蛋白 ${perKg} g/kg`);
  if (Number.isFinite(adjust) && adjust !== 0) parts.push(`热量 ${adjust > 0 ? '+' : '−'}${numText(Math.abs(adjust))}%`);
  return parts.join(' · ');
}

/**
 * 上限型目标（钠）的进度：超了说「已超」，没超说「距上限」。
 * 方向不能反 —— 钠是「不超过」，超了是风险，不是「完成得更多」。
 */
export function limitProgress(value, limit, unit = '') {
  const v = Number(value);
  const m = Number(limit);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
  const over = v > m;
  return {
    warn: over,
    main: `${numText(v)} / ${numText(m)}${unit}`,
    note: over
      ? `已超 ${numText(round1(v - m))}${unit} · 钠是上限目标`
      : `距上限还有 ${numText(round1(m - v))}${unit}`,
  };
}

/** 下限型目标（纤维）的进度：「还差 X」/「已达标」；超了不是问题。 */
export function floorProgress(value, target, unit = '') {
  const v = Number(value);
  const m = Number(target);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
  const done = v >= m;
  return {
    warn: false,
    main: `${numText(v)} / ${numText(m)}${unit}`,
    note: done ? '已达标' : `还差 ${numText(round1(m - v))}${unit}`,
  };
}

/**
 * 纤维 / 钠的进度行。缺数据的条目只报「暂无数据」，不画进度条 —— 缺数据不是 0。
 * missing > 0 时追加一句实话（与 views/food.js 的纤维口径一致），免得用户以为这就是全部摄入。
 */
function progressRow({ label, totals, targets, unit, kind, color }) {
  const value = totals.value;
  const target = Number(targets);
  const progress = value == null
    ? null
    : (kind === 'limit' ? limitProgress(value, target, unit) : floorProgress(value, target, unit));
  const main = progress
    ? progress.main
    : (value == null ? '暂无数据' : `${numText(value)}${unit}`);
  const note = progress
    ? `${progress.note}${totals.missing > 0 ? '（部分食物无数据）' : ''}`
    : (value == null ? '食物库暂无这项数据' : '目标数据不完整');
  return el('div', { className: 'col macro target-row' },
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: label }),
      el('span', { className: 'macro__nums strong', text: main }),
    ),
    progress ? bar({ value, max: target, color: progress.warn ? 'var(--warn)' : color }) : null,
    note ? el('div', { className: `muted${progress && progress.warn ? ' trend-up' : ''}`, text: note }) : null,
  );
}

/**
 * 每日目标卡：目标表（比例 + 克数）+ 纤维 / 钠进度 + 推算依据。
 * 数据一律来自 currentDailyTargets()：这里不重算 BM / TDEE，也没有第二套口径。
 */
function targetCard(targets, dayItems) {
  const card = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '每日目标' }),
    ),
  );
  const t = normalizeDailyTargets(targets);
  if (!t) {
    card.appendChild(el('div', { className: 'muted', text: '目标数据暂不可用' }));
    return card;
  }
  for (const row of dailyTargetRows(t)) {
    card.appendChild(el('div', { className: 'col macro target-row' },
      el('div', { className: 'row row--between' },
        el('span', { className: 'label', text: row.label }),
        el('span', { className: 'macro__nums strong', text: row.text }),
      ),
    ));
  }
  card.appendChild(progressRow({
    label: '膳食纤维', totals: nutrientTotals(dayItems, 'fiber'), targets: t.fiber && t.fiber.g,
    unit: ' g', kind: 'floor', color: 'var(--brand-2)',
  }));
  card.appendChild(progressRow({
    label: '钠', totals: nutrientTotals(dayItems, 'sodium'), targets: t.sodium && t.sodium.mg,
    unit: ' mg', kind: 'limit', color: 'var(--brand-2)',
  }));
  const basis = basisText(t.basis);
  if (basis) card.appendChild(el('div', { className: 'muted', text: basis }));
  return card;
}

/** 顶部备份提醒条：--warn 系配色，导出成功后自己消失；关闭只作用于当前这次渲染，不写进设置。 */
function backupBar(status) {
  const exportBtn = el('button', { className: 'btn btn--sm backup-bar__btn', text: '导出' });
  const closeBtn = el('button', {
    className: 'backup-bar__close',
    text: '×',
    attr: { type: 'button', 'aria-label': '关闭备份提醒' },
  });
  const bar = el('div', { className: 'backup-bar', attr: { role: 'status' } },
    el('div', { className: 'backup-bar__text' },
      el('span', { className: 'backup-bar__icon', text: '!', attr: { 'aria-hidden': 'true' } }),
      el('span', { text: `${backupReminderText(status)}，导出 JSON 备份一下` }),
    ),
    el('div', { className: 'backup-bar__actions' }, exportBtn, closeBtn),
  );
  closeBtn.addEventListener('click', () => {
    // 只关掉这一次：不持久化，下次打开仍会提醒，不会变成「永不提醒」。
    bar.remove();
  });
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      await exportBackupJSON();
      const next = await exportStatus();
      if (!needsBackupReminder(next)) bar.remove();
      else exportBtn.disabled = false;
      toast('备份已导出', 'ok');
    } catch (err) {
      toast(`导出失败：${err && err.message ? err.message : err}`, 'error');
      exportBtn.disabled = false;
    }
  });
  return bar;
}

/**
 * 只累加有已知值的条目，并把「有多少条缺数据」一起带出来。
 * known = 0 时 value 是 null —— 界面据此说「暂无数据」，而不是报一个看起来像「一点都没吃」的 0。
 */
function nutrientTotals(items, key) {
  let total = 0;
  let known = 0;
  let sum = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    total += 1;
    const raw = item[key];
    if (raw == null || !Number.isFinite(Number(raw))) continue;
    known += 1;
    sum += Number(raw);
  }
  return { value: known ? round1(sum) : null, known, total, missing: total - known };
}

/**
 * 膳食纤维一行（宏量营养素卡里的「当日摄取」口径：只报摄取量，进度在「每日目标」卡里给）。
 * 缺数据的条目不参与累加，但必须说出来：一个不声不响的和会让人以为这就是全部摄入。
 * 文案口径与 views/food.js 的 fiberSummaryText() 一致（两页说同一件事，用户不会看到两种解释）。
 */
function fiberRow(items) {
  const { value, known, total } = nutrientTotals(items, 'fiber');
  if (!total) return null;
  const shown = value == null ? '暂无数据' : `${fmt1(value)} g`;
  const note = !known ? '食物库暂无纤维数据' : total > known ? '部分食物无数据' : '';
  return el('div', { className: 'col macro' },
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: '膳食纤维' }),
      el('span', { className: 'macro__nums' }, el('span', { className: 'strong', text: shown })),
    ),
    note ? el('div', { className: 'muted', text: note }) : null,
  );
}

function statBlock(label, value, unit) {
  return el('div', { className: 'stat' },
    el('div', { className: 'stat__line' },
      el('span', { className: 'stat__value', text: value }),
      unit ? el('span', { className: 'stat__unit', text: unit }) : null,
    ),
    el('div', { className: 'stat__label', text: label }),
  );
}

/**
 * targets 只用于测试注入（钉住「读数全部来自 currentDailyTargets()」这条契约）；
 * 生产路径不传，走 store.currentDailyTargets()。
 */
export async function render(root, options = {}) {
  const date = localDateStr();
  const injected = options && 'targets' in options ? options.targets : undefined;
  const [summary, goals, weights, settings, exportState, targets] = await Promise.all([
    daySummary(date),
    getGoals(),
    recentWeights(30),
    getSettings(),
    exportStatus(),
    // 目标只读 + 失败降级：取不到就画一句说明，不让异常冒到渲染外面（今日页其余部分照常）。
    injected !== undefined ? Promise.resolve(injected) : dailyTargetsOrNull(),
  ]);
  // 体重只按「设置里的单位」显示；库里始终是 kg，差值同样要换算（0.1kg = 0.2斤）。
  const weightUnit = settings && settings.weightUnit === 'jin' ? 'jin' : 'kg';
  const weightLabel = weightUnitLabel(weightUnit);
  const showWeight = (kg) => kgToUnit(kg, weightUnit);

  const intake = summary.intake || { kcal: 0, carb: 0, protein: 0, fat: 0 };
  // 当日纤维：把所有餐次的条目摊平交给 fiberRow（它自己数缺数据的条数）。
  const dayItems = [];
  for (const meal of (Array.isArray(summary.meals) ? summary.meals : [])) {
    for (const item of (Array.isArray(meal.items) ? meal.items : [])) dayItems.push(item);
  }
  const burned = Number(summary.burned) || 0;
  const net = Number.isFinite(summary.netKcal) ? summary.netKcal : intake.kcal - burned;
  const calorieTarget = Number(goals.calorieTarget) || 1;

  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: fmtDateCN(date) }),
      el('div', { className: 'muted', text: '今日总览' }),
    ),
    el('button', {
      className: 'btn btn--ghost icon-btn',
      text: '⚙',
      attr: { 'aria-label': '设置', title: '设置' },
      onClick: () => go('#/settings'),
    }),
  ));

  // 顶部提醒条：数据在、且该备份了才出现。
  if (needsBackupReminder(exportState)) root.appendChild(backupBar(exportState));

  // 应用更新提示条（仅 APK 内置 HmsBridge 时出现）：按需加载这段逻辑，
  // PWA 里 initUpdateBanner 直接返回 null，不请求也不渲染。
  // 桥的回复是异步的，所以回调里插到根节点最前面（今日页顶部，与备份提醒条各占一行）。
  // 更新提示只是附加能力：加载失败不能把今日页拖进错误卡片。
  try {
    const { initUpdateBanner } = await import('../js/update.js');
    initUpdateBanner({
      mount: (node) => { root.insertBefore(node, root.firstChild); },
    });
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[HMS] 更新提示不可用：', error);
  }

  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '热量' }),
      el('div', { className: 'pill', text: `目标 ${fmtKcal(calorieTarget)} kcal` }),
    ),
    el('div', { className: 'ring-wrap' }, ring({ value: net, max: calorieTarget, label: '净热量', unit: 'kcal', color: 'var(--brand)' })),
    el('div', { className: 'grid-3' },
      statBlock('摄入', fmtKcal(intake.kcal), 'kcal'),
      statBlock('运动消耗', fmtKcal(burned), 'kcal'),
      statBlock('剩余可吃', fmtKcal(Math.max(0, calorieTarget - net)), 'kcal'),
    ),
  ));

  const macroTargets = targetMacroGrams(targets, goals);
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '宏量营养素' }),
    ),
    macroRow({ label: '碳水', value: intake.carb, target: macroTargets.carb, color: 'var(--carb)' }),
    macroRow({ label: '蛋白质', value: intake.protein, target: macroTargets.protein, color: 'var(--protein)' }),
    macroRow({ label: '脂肪', value: intake.fat, target: macroTargets.fat, color: 'var(--fat)' }),
    fiberRow(dayItems),
  ));

  // 每日目标（比例 + 克数 + 纤维 / 钠进度 + 推算依据）：口径与克数一律取自 currentDailyTargets()，
  // 这里不重算 BM / TDEE，也不再存第二套目标。
  root.appendChild(targetCard(targets, dayItems));

  // 体重卡：没有数据时给下一步按钮，避免用户看死胡同。
  const stats = weightStats(Array.isArray(weights) ? weights : []);
  const weightCard = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '体重' }),
      el('button', { className: 'btn btn--ghost btn--sm', text: '记录', onClick: () => go('#/weight') }),
    ),
  );
  if (stats.latest == null) {
    weightCard.appendChild(emptyState('还没有体重记录', '记录第一次体重', () => go('#/weight')));
  } else {
    const delta = stats.delta7;
    weightCard.appendChild(el('div', { className: 'row row--between' },
      statBlock('最近一次', fmt1(showWeight(stats.latest)), weightLabel),
      el('div', { className: 'col align-end' },
        el('div', { className: 'label', text: '较 7 天前' }),
        el('div', {
          className: `strong ${delta != null && delta > 0 ? 'trend-up' : 'trend-down'}`,
          text: delta == null ? '—' : `${delta > 0 ? '+' : ''}${fmt1(showWeight(delta))} ${weightLabel}`,
        }),
        el('div', { className: 'muted', text: stats.latestDate || '' }),
      ),
    ));
  }
  root.appendChild(weightCard);

  const waterTarget = Number(goals.waterMl) || 2000;
  const water = Number(summary.water) || 0;

  // 快捷加量：写入在 store 层是原子的（同一帧连点两次各记各的），这里只把「正在提交」
  // 画出来（按钮置灰），失败时给一句中文提示 —— 不再让异常冒到事件循环外面去。
  const quickWaterButton = () => {
    const button = el('button', { className: 'btn btn--primary', text: '+250 ml' });
    button.addEventListener('click', async () => {
      const release = markBusy(button);
      try {
        await addWater(date, 250);
        toast('已记录 250ml', 'ok');
        await window.HMS.refresh();
      } catch (err) {
        toast(`记录失败：${err && err.message ? err.message : err}`, 'error');
      } finally {
        release();
      }
    });
    return button;
  };

  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '饮水' }),
      el('div', { className: `pill ${water >= waterTarget ? 'pill--ok' : ''}`, text: `${water} / ${waterTarget} ml` }),
    ),
    bar({ value: water, max: waterTarget, color: 'var(--water)' }),
    el('div', { className: 'row', style: { marginTop: '12px' } },
      quickWaterButton(),
      el('button', { className: 'btn btn--ghost', text: '去饮水页', onClick: () => go('#/water') }),
    ),
  ));

  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '运动' }),
      el('button', { className: 'btn btn--ghost btn--sm', text: '记录', onClick: () => go('#/exercise') }),
    ),
    el('div', { className: 'row row--between' },
      statBlock('今日消耗', fmtKcal(burned), 'kcal'),
      el('div', { className: 'col align-end' },
        el('div', { className: 'label', text: '运动次数' }),
        el('div', { className: 'strong', text: `${(summary.exercises || []).length} 次` }),
      ),
    ),
  ));

  // 「今日餐次」默认折成一行：头行本身就是折叠开关，点它才展开逐餐列表；
  // 「去记录」是并列的按钮（不是头行的子节点），点它只跳饮食页、不触发展开。
  const meals = Array.isArray(summary.meals) ? summary.meals : [];
  const mealCard = el('div', { className: 'card' });
  const recordBtn = el('button', { className: 'btn btn--ghost btn--sm', text: '去记录', onClick: () => go('#/food') });
  if (!meals.length) {
    mealCard.appendChild(el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '今日餐次' }),
      recordBtn,
    ));
    mealCard.appendChild(emptyState('今天还没有饮食记录', '拍照记录第一餐', () => go('#/food')));
  } else {
    const totalKcal = meals.reduce((sum, meal) => sum + sumItems(safeItems(meal.items)).kcal, 0);
    const list = el('div', { className: 'list meal-fold__list' });
    for (const meal of meals.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      const total = sumItems(safeItems(meal.items));
      const names = itemNames(meal.items);
      const summaryText = names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 项` : names.join('、');
      list.appendChild(el('div', { className: 'list__item' },
        el('div', { className: 'list__item--main' },
          el('div', { className: 'strong', text: `${SLOT_LABEL[meal.slot] || '餐次'} · ${fmtKcal(total.kcal)} kcal` }),
          el('div', { className: 'list__item--meta', text: `${summaryText || '无条目'}${meal.createdAt ? ' · ' + fmtTime(meal.createdAt) : ''}` }),
        ),
        el('div', { className: 'pill', text: meal.source === 'ai' ? 'AI' : '手动' }),
      ));
    }
    const caret = el('span', { className: 'meal-fold__caret', text: '▼', attr: { 'aria-hidden': 'true' } });
    const toggle = el('button', {
      className: 'meal-fold',
      type: 'button',
      attr: { 'aria-expanded': 'false', 'aria-label': '展开今日餐次' },
      onClick: () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}今日餐次`);
        caret.textContent = open ? '▲' : '▼';
        if (open) mealCard.appendChild(list);
        else list.remove();
      },
    },
      el('span', { className: 'card__title', text: `今日餐次 · ${meals.length} 餐 ${fmtKcal(totalKcal)} kcal` }),
      caret,
    );
    mealCard.appendChild(el('div', { className: 'card__head meal-fold__head' }, toggle, recordBtn));
  }
  root.appendChild(mealCard);
}
