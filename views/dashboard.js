// 今日总览（SPEC §7「今日」）。只读聚合 + 两个快捷写入（饮水）。
import { el, ring, bar, toast, emptyState, fmtKcal, fmtDateCN, fmtTime, fmt1, markBusy } from '../js/ui.js';
import { localDateStr, targetMacros, weightStats, sumItems, round1, kgToUnit, weightUnitLabel } from '../js/nutrition.js';
import { daySummary, getGoals, recentWeights, addWater, getSettings, exportStatus } from '../js/store.js';
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
        el('span', { className: 'muted', text: ` / ${Math.round(target)} ${unit}` }),
      ),
    ),
    bar({ value, max: target, color }),
  );
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
 * 膳食纤维一行（用户决策：只显示摄取量，不设每日目标 —— 所以这里没有进度条、没有 target）。
 * 缺数据的条目不参与累加，但必须说出来：一个不声不响的和会让人以为这就是全部摄入。
 * 文案口径与 views/food.js 的 fiberSummaryText() 一致（两页说同一件事，用户不会看到两种解释）。
 */
function fiberRow(items) {
  let total = 0;
  let known = 0;
  let sum = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    total += 1;
    if (item.fiber == null || !Number.isFinite(Number(item.fiber))) continue;
    known += 1;
    sum += Number(item.fiber);
  }
  if (!total) return null;
  const value = known ? `${fmt1(round1(sum))} g` : '暂无数据';
  const note = !known ? '食物库暂无纤维数据' : total > known ? '部分食物无数据' : '';
  return el('div', { className: 'col macro' },
    el('div', { className: 'row row--between' },
      el('span', { className: 'label', text: '膳食纤维' }),
      el('span', { className: 'macro__nums' }, el('span', { className: 'strong', text: value })),
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

export async function render(root) {
  const date = localDateStr();
  const [summary, goals, weights, settings, exportState] = await Promise.all([
    daySummary(date),
    getGoals(),
    recentWeights(30),
    getSettings(),
    exportStatus(),
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

  const macroTargets = targetMacros(calorieTarget, {
    carb: goals.carbPct, protein: goals.proteinPct, fat: goals.fatPct,
  });
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '宏量营养素' }),
    ),
    macroRow({ label: '碳水', value: intake.carb, target: macroTargets.carb, color: 'var(--carb)' }),
    macroRow({ label: '蛋白质', value: intake.protein, target: macroTargets.protein, color: 'var(--protein)' }),
    macroRow({ label: '脂肪', value: intake.fat, target: macroTargets.fat, color: 'var(--fat)' }),
    fiberRow(dayItems),
  ));

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
