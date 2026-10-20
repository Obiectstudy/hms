// 体重页（SPEC §7「体重」）：刻度尺录入 upsert + 30 天折线 + 目标进度 + 历史删除。
// 存储永远是 kg；斤只是「显示与输入」单位，落库前一律过 unitToKg。
import { el, clear, rulerPicker, lineChart, bar, toast, confirmDialog, emptyState, fmt1, fmtDateCN } from '../js/ui.js';
import {
  localDateStr, bmi, bmiClass, weightStats,
  WEIGHT_UNITS, kgToUnit, unitToKg, weightStep, weightRange, weightUnitLabel,
} from '../js/nutrition.js';
import {
  getProfile, getGoals, getSettings, saveSettings, logWeight, deleteWeight, recentWeights,
} from '../js/store.js';

// 一格刻度对应的像素：kg（0.1/格）→ 80px/1kg，斤（0.2/格）→ 40px/1斤。
const PX_PER_STEP = 8;
// 数字标签间隔：kg 每 5 格一个（5kg），斤每 25 格一个（5斤）。
const LABEL_EVERY = { kg: 50, jin: 25 };

export async function render(root) {
  const [profile, goals, weightsRaw, settings] = await Promise.all([
    getProfile(), getGoals(), recentWeights(60), getSettings(),
  ]);
  const weights = (Array.isArray(weightsRaw) ? weightsRaw : []).slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const stats = weightStats(weights);
  const today = localDateStr();

  let unit = WEIGHT_UNITS.includes(settings && settings.weightUnit) ? settings.weightUnit : 'kg';
  let mode = 'ruler';
  // 录入起点：最近一次体重按当前单位显示；没有数据时给一个常见起点，免得刻度停在边界上。
  let display = kgToUnit(stats.latest == null ? 60 : stats.latest, unit);

  const unitLabel = () => weightUnitLabel(unit);
  const show = (kgValue) => kgToUnit(kgValue, unit);

  root.appendChild(el('div', { className: 'col' },
    el('div', { className: 'h1', text: '体重' }),
    el('div', { className: 'muted', text: '每天同一时间称重，趋势比单次数值更可信' }),
  ));

  // ---- 录入 ----
  const dateInput = el('input', { className: 'input', type: 'date', value: today });
  const fatInput = el('input', { className: 'input', type: 'number', inputmode: 'decimal', step: '0.1', placeholder: '可选' });
  const noteInput = el('input', { className: 'input', type: 'text', placeholder: '可选，如「空腹」' });
  // 大号数字 + 单位 chip：数字是主角（≥44px），点 chip 在 kg / 斤 间切换。
  const valueText = el('div', { className: 'weight-value', text: fmt1(display) });
  const unitChip = el('button', {
    className: 'unit-chip',
    text: unitLabel(),
    attr: { type: 'button', 'aria-label': '切换体重单位（kg / 斤）' },
  });
  const entryBox = el('div', { className: 'weight-entry' });
  const modeHint = el('div', { className: 'muted' });
  const keypadToggle = el('button', {
    className: 'keypad-toggle',
    text: '⌨ 键盘输入',
    attr: { type: 'button', 'aria-label': '在刻度尺与键盘输入之间切换' },
  });
  const saveBtn = el('button', { className: 'btn btn--primary btn--block', text: '保存体重' });

  let rulerNode = null;
  let numberInput = null;

  function focusEntry() {
    const target = mode === 'ruler' ? rulerNode : numberInput;
    if (target && typeof target.focus === 'function') target.focus();
  }

  // 单位或数值变化后把「大号数字 + 刻度尺/输入框」一起对齐到 display。
  function syncReadout() {
    valueText.textContent = fmt1(display);
    if (mode === 'ruler' && rulerNode) rulerNode.setValue(display);
    if (mode === 'keypad' && numberInput) numberInput.value = fmt1(display);
  }

  function buildEntry() {
    clear(entryBox);
    rulerNode = null;
    numberInput = null;
    const range = weightRange(unit);
    if (mode === 'ruler') {
      rulerNode = rulerPicker({
        min: range.min,
        max: range.max,
        step: weightStep(unit),
        value: display,
        unitLabel: unitLabel(),
        majorEvery: 10,
        labelEvery: LABEL_EVERY[unit],
        pxPerStep: PX_PER_STEP,
        label: `体重刻度（${unitLabel()}）`,
        onChange: (next) => { display = next; valueText.textContent = fmt1(display); },
      });
      entryBox.appendChild(rulerNode);
      keypadToggle.textContent = '⌨ 键盘输入';
      modeHint.textContent = '左右滑动刻度，松手自动对齐';
    } else {
      numberInput = el('input', {
        className: 'input weight-input',
        type: 'number',
        step: String(weightStep(unit)),
        attr: { inputmode: 'decimal', 'aria-label': `体重（${unitLabel()}）` },
      });
      numberInput.value = fmt1(display);
      numberInput.addEventListener('input', () => {
        const typed = Number(numberInput.value);
        if (!Number.isFinite(typed)) return; // 半截输入先放过，保存时统一校验
        display = typed;
        valueText.textContent = fmt1(typed);
      });
      entryBox.appendChild(el('label', { className: 'field' },
        el('span', { className: 'field__label', text: `体重（${unitLabel()}）` }),
        numberInput,
      ));
      keypadToggle.textContent = '🎚 刻度尺';
      modeHint.textContent = '直接输入数字，保存时按当前单位换算';
    }
  }

  keypadToggle.addEventListener('click', () => {
    mode = mode === 'ruler' ? 'keypad' : 'ruler';
    buildEntry();
    focusEntry();
  });

  unitChip.addEventListener('click', async () => {
    const kg = unitToKg(display, unit); // 先折回 kg 再换单位，数值不漂移
    unit = unit === 'jin' ? 'kg' : 'jin';
    display = kgToUnit(kg, unit);
    unitChip.textContent = unitLabel();
    buildEntry();
    syncReadout();
    renderSummary();
    try {
      await saveSettings({ weightUnit: unit });
    } catch {
      /* 记住选择失败不影响本次录入，下次打开仍按默认单位 */
    }
  });

  saveBtn.addEventListener('click', async () => {
    const date = dateInput.value || today;
    const range = weightRange(unit);
    const shownValue = mode === 'keypad' && numberInput ? Number(numberInput.value) : display;
    if (!Number.isFinite(shownValue) || shownValue < range.min || shownValue > range.max) {
      toast(`体重请填写 ${range.min}~${range.max} ${unitLabel()}`, 'error');
      focusEntry();
      return;
    }
    const bodyFatPct = fatInput.value === '' ? undefined : Number(fatInput.value);
    saveBtn.disabled = true;
    try {
      await logWeight({
        date,
        weightKg: unitToKg(shownValue, unit), // 库里永远 kg
        bodyFatPct,
        note: noteInput.value.trim() || undefined,
      });
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
    el('div', { className: 'weight-readout' }, valueText, unitChip),
    entryBox,
    el('div', { className: 'row row--between' }, keypadToggle, modeHint),
    el('label', { className: 'field' }, el('span', { className: 'field__label', text: '日期' }), dateInput),
    el('div', { className: 'grid-2' },
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '体脂率 (%)' }), fatInput),
      el('label', { className: 'field' }, el('span', { className: 'field__label', text: '备注' }), noteInput),
    ),
    saveBtn,
  ));

  // ---- 最新 / 趋势 / 历史：切单位要整块重画，所以放进一个容器 ----
  const summaryBox = el('div', { className: 'col' });
  root.appendChild(summaryBox);

  function renderSummary() {
    clear(summaryBox);
    const label = unitLabel();
    const target = Number(goals.weightTargetKg) || null;

    const latestCard = el('div', { className: 'card col' },
      el('div', { className: 'card__head', style: { marginBottom: '0' } },
        el('div', { className: 'card__title', text: '最新' }),
        stats.latestDate ? el('div', { className: 'muted', text: fmtDateCN(stats.latestDate) }) : null,
      ),
    );
    if (stats.latest == null) {
      latestCard.appendChild(emptyState('还没有体重数据', '先记录一次', focusEntry));
    } else {
      latestCard.appendChild(el('div', { className: 'row row--between' },
        el('div', { className: 'stat' },
          el('div', { className: 'stat__line' },
            el('span', { className: 'stat__value', text: fmt1(show(stats.latest)) }),
            el('span', { className: 'stat__unit', text: label }),
          ),
          el('div', { className: 'stat__label', text: '当前体重' }),
        ),
        el('div', { className: 'col align-end' },
          el('div', { className: 'label', text: '较 7 天 / 30 天' }),
          el('div', {
            className: 'strong',
            text: `${stats.delta7 == null ? '—' : (stats.delta7 > 0 ? '+' : '') + fmt1(show(stats.delta7))} / ${stats.delta30 == null ? '—' : (stats.delta30 > 0 ? '+' : '') + fmt1(show(stats.delta30))} ${label}`,
          }),
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
            el('span', {
              className: 'muted',
              text: `目标 ${fmt1(show(target))} ${label} · ${diff > 0 ? '还差 ' + fmt1(show(diff)) : diff < 0 ? '已低于目标 ' + fmt1(show(-diff)) : '已达成'} ${label}`,
            }),
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
    summaryBox.appendChild(latestCard);

    const recent = weights.slice(-30);
    const trendCard = el('div', { className: 'card col' },
      el('div', { className: 'card__head', style: { marginBottom: '0' } },
        el('div', { className: 'card__title', text: '30 天趋势' }),
        el('div', { className: 'muted', text: `${recent.length} 个数据点` }),
      ),
    );
    trendCard.appendChild(recent.length
      ? lineChart({
        points: recent.map((w) => ({ x: w.date, y: show(w.weightKg) })),
        height: 170,
        yLabel: `体重 ${label}`,
      })
      : emptyState('近 30 天没有数据', '记录今天的体重', focusEntry));
    summaryBox.appendChild(trendCard);

    const historyCard = el('div', { className: 'card' },
      el('div', { className: 'card__head' },
        el('div', { className: 'card__title', text: '历史记录' }),
        el('div', { className: 'muted', text: '倒序' }),
      ),
    );
    if (!weights.length) {
      historyCard.appendChild(emptyState('暂无历史记录', '记录第一次体重', focusEntry));
    } else {
      const list = el('div', { className: 'list' });
      for (const w of weights.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
        const del = el('button', { className: 'btn btn--ghost btn--sm btn--danger', text: '删除' });
        del.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '删除这条体重记录？',
            message: `${fmtDateCN(w.date)} · ${fmt1(show(w.weightKg))} ${label}`,
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
            el('div', { className: 'strong', text: `${fmt1(show(w.weightKg))} ${label}` }),
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
    summaryBox.appendChild(historyCard);
  }

  buildEntry();
  renderSummary();
}
