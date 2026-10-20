// 体重页（SPEC §7「体重」）：录入 upsert + 30 天折线 + 目标进度 + 历史删除。
import { el, lineChart, bar, toast, confirmDialog, emptyState, fmtKg, fmt1, fmtDateCN } from '../js/ui.js';
import { localDateStr, bmi, bmiClass, weightStats } from '../js/nutrition.js';
import { getProfile, getGoals, logWeight, deleteWeight, recentWeights } from '../js/store.js';

export async function render(root) {
  const [profile, goals, weightsRaw] = await Promise.all([getProfile(), getGoals(), recentWeights(60)]);
  const weights = (Array.isArray(weightsRaw) ? weightsRaw : []).slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const stats = weightStats(weights);
  const today = localDateStr();

  root.appendChild(el('div', { className: 'col' },
    el('div', { className: 'h1', text: '体重' }),
    el('div', { className: 'muted', text: '每天同一时间称重，趋势比单次数值更可信' }),
  ));

  // ---- 录入 ----
  const dateInput = el('input', { className: 'input', type: 'date', value: today });
  const weightInput = el('input', { className: 'input', type: 'number', inputmode: 'decimal', step: '0.1', placeholder: '例如 68.4' });
  const fatInput = el('input', { className: 'input', type: 'number', inputmode: 'decimal', step: '0.1', placeholder: '可选' });
  const noteInput = el('input', { className: 'input', type: 'text', placeholder: '可选，如「空腹」' });
  const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存体重' });

  saveBtn.addEventListener('click', async () => {
    const date = dateInput.value || today;
    const weightKg = Number(weightInput.value);
    if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) {
      toast('体重请填写 20~400 之间的数字', 'error');
      weightInput.focus();
      return;
    }
    const bodyFatPct = fatInput.value === '' ? undefined : Number(fatInput.value);
    saveBtn.disabled = true;
    try {
      await logWeight({ date, weightKg, bodyFatPct, note: noteInput.value.trim() || undefined });
      toast('体重已保存', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`保存失败：${err && err.message ? err.message : err}`, 'error');
      saveBtn.disabled = false;
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '记录' }),
      el('div', { className: 'muted', text: '同一天再次保存会覆盖' }),
    ),
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '日期' }), dateInput),
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '体重 (kg)' }), weightInput),
    el('div', { className: 'grid-2' },
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '体脂率 (%)' }), fatInput),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '备注' }), noteInput),
    ),
    saveBtn,
  ));

  // ---- 最新 + 目标 ----
  const target = Number(goals.weightTargetKg) || null;
  const latestCard = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '最新' }),
      stats.latestDate ? el('div', { className: 'muted', text: fmtDateCN(stats.latestDate) }) : null,
    ),
  );
  if (stats.latest == null) {
    latestCard.appendChild(emptyState('还没有体重数据', '先记录一次', () => {
      weightInput.focus();
    }));
  } else {
    latestCard.appendChild(el('div', { className: 'row row--between' },
      el('div', { className: 'stat' },
        el('div', { className: 'stat__line' },
          el('span', { className: 'stat__value', text: fmtKg(stats.latest) }),
          el('span', { className: 'stat__unit', text: 'kg' }),
        ),
        el('div', { className: 'stat__label', text: '当前体重' }),
      ),
      el('div', { className: 'col align-end' },
        el('div', { className: 'label', text: '较 7 天 / 30 天' }),
        el('div', { className: 'strong', text: `${stats.delta7 == null ? '—' : (stats.delta7 > 0 ? '+' : '') + fmt1(stats.delta7)} / ${stats.delta30 == null ? '—' : (stats.delta30 > 0 ? '+' : '') + fmt1(stats.delta30)} kg` }),
      ),
    ));

    if (profile && Number(profile.heightCm) > 0) {
      const bmiValue = bmi({ weightKg: stats.latest, heightCm: profile.heightCm });
      const klass = bmiClass(bmiValue);
      latestCard.appendChild(el('div', { className: 'row row--between divider' },
        el('span', { className: 'label', text: 'BMI' }),
        el('span', { className: `pill ${klass.level === 'normal' ? 'pill--ok' : 'pill--warn'}`, text: `${fmt1(bmiValue)} · ${klass.label}` }),
      ));
    }

    if (target && stats.series.length) {
      const start = stats.series[0].weightKg;
      const span = start - target;
      const done = span === 0 ? 1 : (start - stats.latest) / span;
      const pct = Math.max(0, Math.min(1, done));
      const diff = stats.latest - target;
      latestCard.appendChild(el('div', { className: 'col divider' },
        el('div', { className: 'row row--between' },
          el('span', { className: 'label', text: '目标体重进度' }),
          el('span', { className: 'muted', text: `目标 ${fmtKg(target)} kg · ${diff > 0 ? '还差 ' + fmt1(diff) : diff < 0 ? '已低于目标 ' + fmt1(-diff) : '已达成'} kg` }),
        ),
        bar({ value: pct, max: 1, color: 'var(--brand)' }),
      ));
    } else if (!target) {
      latestCard.appendChild(el('div', { className: 'row row--between divider' },
        el('span', { className: 'label', text: '目标体重' }),
        el('button', { className: 'btn btn--ghost btn--sm', text: '去设置', onClick: () => window.HMS.navigate('#/settings') }),
      ));
    }
  }
  root.appendChild(latestCard);

  // ---- 30 天趋势 ----
  const recent = weights.slice(-30);
  const trendCard = el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '30 天趋势' }),
      el('div', { className: 'muted', text: `${recent.length} 个数据点` }),
    ),
  );
  trendCard.appendChild(recent.length
    ? lineChart({ points: recent.map((w) => ({ x: w.date, y: w.weightKg })), height: 170, yLabel: '体重 kg' })
    : emptyState('近 30 天没有数据', '记录今天的体重', () => weightInput.focus()));
  root.appendChild(trendCard);

  // ---- 历史 ----
  const historyCard = el('div', { className: 'card' },
    el('div', { className: 'card__head' },
      el('div', { className: 'card__title', text: '历史记录' }),
      el('div', { className: 'muted', text: '倒序' }),
    ),
  );
  if (!weights.length) {
    historyCard.appendChild(emptyState('暂无历史记录', '记录第一次体重', () => weightInput.focus()));
  } else {
    const list = el('div', { className: 'list' });
    for (const w of weights.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
      const del = el('button', { className: 'btn btn--ghost btn--sm btn--danger', text: '删除' });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '删除这条体重记录？',
          message: `${fmtDateCN(w.date)} · ${fmtKg(w.weightKg)} kg`,
          okText: '删除',
        });
        if (!ok) return;
        try {
          await deleteWeight(w.date);
          toast('已删除', 'ok');
          await window.HMS.refresh();
        } catch (err) {
          toast(`删除失败：${err && err.message ? err.message : err}`, 'error');
        }
      });
      list.appendChild(el('div', { className: 'list__item' },
        el('div', { className: 'list__item--main' },
          el('div', { className: 'strong', text: `${fmtKg(w.weightKg)} kg` }),
          el('div', {
            className: 'list__item--meta',
            text: [fmtDateCN(w.date), w.bodyFatPct != null ? `体脂 ${fmt1(w.bodyFatPct)}%` : '', w.note || ''].filter(Boolean).join(' · '),
          }),
        ),
        del,
      ));
    }
    historyCard.appendChild(list);
  }
  root.appendChild(historyCard);
}
