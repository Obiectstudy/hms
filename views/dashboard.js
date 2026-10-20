// 今日总览（SPEC §7「今日」）。只读聚合 + 两个快捷写入（饮水）。
import { el, ring, bar, toast, emptyState, fmtKcal, fmtKg, fmtDateCN, fmtTime, fmt1 } from '../js/ui.js';
import { localDateStr, targetMacros, weightStats, sumItems } from '../js/nutrition.js';
import { daySummary, getGoals, recentWeights, addWater } from '../js/store.js';

const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const go = (hash) => window.HMS.navigate(hash);

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
  const [summary, goals, weights] = await Promise.all([
    daySummary(date),
    getGoals(),
    recentWeights(30),
  ]);

  const intake = summary.intake || { kcal: 0, carb: 0, protein: 0, fat: 0 };
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
      statBlock('最近一次', fmtKg(stats.latest), 'kg'),
      el('div', { className: 'col align-end' },
        el('div', { className: 'label', text: '较 7 天前' }),
        el('div', {
          className: `strong ${delta != null && delta > 0 ? 'trend-up' : 'trend-down'}`,
          text: delta == null ? '—' : `${delta > 0 ? '+' : ''}${fmt1(delta)} kg`,
        }),
        el('div', { className: 'muted', text: stats.latestDate || '' }),
      ),
    ));
  }
  root.appendChild(weightCard);

  const waterTarget = Number(goals.waterMl) || 2000;
  const water = Number(summary.water) || 0;
  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '饮水' }),
      el('div', { className: `pill ${water >= waterTarget ? 'pill--ok' : ''}`, text: `${water} / ${waterTarget} ml` }),
    ),
    bar({ value: water, max: waterTarget, color: 'var(--water)' }),
    el('div', { className: 'row', style: { marginTop: '12px' } },
      el('button', {
        className: 'btn btn--primary',
        text: '+250 ml',
        onClick: async () => {
          await addWater(date, 250);
          toast('已记录 250ml', 'ok');
          await window.HMS.refresh();
        },
      }),
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

  const mealCard = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '今日餐次' }),
      el('button', { className: 'btn btn--ghost btn--sm', text: '去记录', onClick: () => go('#/food') }),
    ),
  );
  const meals = Array.isArray(summary.meals) ? summary.meals : [];
  if (!meals.length) {
    mealCard.appendChild(emptyState('今天还没有饮食记录', '拍照记录第一餐', () => go('#/food')));
  } else {
    const list = el('div', { className: 'list' });
    for (const meal of meals.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      const total = sumItems(meal.items || []);
      const names = (meal.items || []).map((i) => i.name).filter(Boolean);
      const summaryText = names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 项` : names.join('、');
      list.appendChild(el('div', { className: 'list__item' },
        el('div', { className: 'list__item--main' },
          el('div', { className: 'strong', text: `${SLOT_LABEL[meal.slot] || '餐次'} · ${fmtKcal(total.kcal)} kcal` }),
          el('div', { className: 'list__item--meta', text: `${summaryText || '无条目'}${meal.createdAt ? ' · ' + fmtTime(meal.createdAt) : ''}` }),
        ),
        el('div', { className: 'pill', text: meal.source === 'ai' ? 'AI' : '手动' }),
      ));
    }
    mealCard.appendChild(list);
  }
  root.appendChild(mealCard);
}
