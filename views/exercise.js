// 运动页（SPEC §7「运动」）：MET × 体重 × 时长自动估算消耗，可手改。
import { el, toast, confirmDialog, emptyState, fmtKcal, fmtDateCN, fmtTime } from '../js/ui.js';
import { localDateStr } from '../js/nutrition.js';
import { daySummary, logExercise, deleteExercise, recentWeights } from '../js/store.js';

const TYPES = [
  { value: 'walk', label: '走路', met: 3.5 },
  { value: 'jog', label: '慢跑', met: 8.0 },
  { value: 'bike', label: '骑行', met: 6.8 },
  { value: 'swim', label: '游泳', met: 7.0 },
  { value: 'strength', label: '力量训练', met: 5.0 },
  { value: 'other', label: '其他', met: 4.0 },
];

function metOf(type) {
  const hit = TYPES.find((t) => t.value === type);
  return hit ? hit.met : TYPES[TYPES.length - 1].met;
}

export async function render(root) {
  const date = localDateStr();
  const [summary, weights] = await Promise.all([daySummary(date), recentWeights(1)]);
  const latest = (Array.isArray(weights) && weights.length)
    ? weights.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    : null;
  // 没有体重数据时用 65kg 兜底，否则估算会变成 0 让用户以为功能坏了。
  const weightKg = latest && Number(latest.weightKg) > 0 ? Number(latest.weightKg) : 65;

  root.appendChild(el('div', { className: 'col' },
    el('div', { className: 'h1', text: '运动' }),
    el('div', { className: 'muted', text: `按当前体重 ${weightKg} kg 估算消耗，可手动修改` }),
  ));

  const select = el('select', { className: 'select' },
    TYPES.map((t) => el('option', { value: t.value, text: t.label })),
  );
  const minutesInput = el('input', { className: 'input', type: 'number', inputmode: 'numeric', min: '1', max: '600', step: '1', placeholder: '例如 30' });
  const kcalInput = el('input', { className: 'input', type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '自动估算' });
  const noteInput = el('input', { className: 'input', type: 'text', placeholder: '可选，如「晚饭后快走」' });
  const estimateHint = el('div', { className: 'muted', text: '' });

  const estimate = () => {
    const minutes = Number(minutesInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return Math.max(0, Math.round(metOf(select.value) * weightKg * (minutes / 60)));
  };
  const refreshEstimate = () => {
    const kcal = estimate();
    kcalInput.placeholder = kcal == null ? '自动估算' : `自动估算 ${kcal} kcal`;
    estimateHint.textContent = kcal == null
      ? '填写时长后自动估算消耗'
      : `估算 ${kcal} kcal（${TYPES.find((t) => t.value === select.value).label} · ${minutesInput.value} 分钟）`;
  };
  select.addEventListener('change', refreshEstimate);
  minutesInput.addEventListener('input', refreshEstimate);
  refreshEstimate();

  const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存运动' });
  saveBtn.addEventListener('click', async () => {
    const minutes = Number(minutesInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) {
      toast('时长请填写 1~600 分钟', 'error');
      minutesInput.focus();
      return;
    }
    const auto = estimate();
    const manual = kcalInput.value === '' ? null : Number(kcalInput.value);
    const kcalBurned = Number.isFinite(manual) ? Math.max(0, Math.round(manual)) : (auto == null ? 0 : auto);
    saveBtn.disabled = true;
    try {
      await logExercise({ date, type: select.value, minutes, kcalBurned, note: noteInput.value.trim() || undefined });
      toast('运动已记录', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      saveBtn.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '记录运动' }),
      el('div', { className: 'muted', text: fmtDateCN(date) }),
    ),
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '类型' }), select),
    el('div', { className: 'grid-2' },
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '时长 (分钟)' }), minutesInput),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '消耗 (kcal)' }), kcalInput),
    ),
    estimateHint,
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '备注' }), noteInput),
    saveBtn,
  ));

  const exercises = Array.isArray(summary.exercises) ? summary.exercises : [];
  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '今日合计' }),
      el('div', { className: 'stat__line' },
        el('span', { className: 'stat__value', text: fmtKcal(summary.burned) }),
        el('span', { className: 'stat__unit', text: 'kcal' }),
      ),
    ),
  ));

  const listCard = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '今日记录' }),
      el('div', { className: 'muted', text: `${exercises.length} 条` }),
    ),
  );
  if (!exercises.length) {
    listCard.appendChild(emptyState('今天还没有运动记录', '填一条', () => minutesInput.focus()));
  } else {
    const list = el('div', { className: 'list' });
    for (const item of exercises.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
      const label = (TYPES.find((t) => t.value === item.type) || { label: '运动' }).label;
      const del = el('button', { className: 'btn btn--ghost btn--sm btn--danger', text: '删除' });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '删除这条运动记录？',
          message: `${label} · ${item.minutes} 分钟`,
          okText: '删除',
        });
        if (!ok) return;
        try {
          await deleteExercise(item.id);
          toast('已删除', 'ok');
          await window.HMS.refresh();
        } catch (err) {
          toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
        }
      });
      list.appendChild(el('div', { className: 'list__item' },
        el('div', { className: 'list__item--main' },
          el('div', { className: 'strong', text: `${label} · ${fmtKcal(item.kcalBurned)} kcal` }),
          el('div', {
            className: 'list__item--meta',
            text: [item.minutes ? `${item.minutes} 分钟` : '', item.createdAt ? fmtTime(item.createdAt) : '', item.note || ''].filter(Boolean).join(' · '),
          }),
        ),
        del,
      ));
    }
    listCard.appendChild(list);
  }
  root.appendChild(listCard);
}
