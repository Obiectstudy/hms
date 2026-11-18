// 体重页（SPEC §7「体重」）：刻度尺录入 upsert + 30 天折线 + 目标进度 + 历史删除。
// 存储永远是 kg；斤只是「显示与输入」单位，落库前一律过 unitToKg。
import { el, clear, rulerPicker, lineChart, bar, toast, confirmDialog, emptyState, fmt1, fmtDateCN } from '../js/ui.js';
import {
  localDateStr, bmi, bmiClass, weightStats, movingAverage,
  WEIGHT_UNITS, kgToUnit, unitToKg, weightStep, weightRange, weightUnitLabel,
} from '../js/nutrition.js';
import {
  getProfile, getGoals, getSettings, saveSettings, logWeight, deleteWeight, recentWeights,
} from '../js/store.js';

// 一格刻度对应的像素：kg（0.1/格）→ 80px/1kg，斤（0.2/格）→ 40px/1斤。
const PX_PER_STEP = 8;
// 数字标签间隔：kg 每 5 格一个（5kg），斤每 25 格一个（5斤）。
// 标签间距按"每 1kg 一个"给：刻度 8px/格，kg 10 格 = 1kg = 80px，斤 10 格 = 2 斤 = 80px。
const LABEL_EVERY = { kg: 10, jin: 10 };

/* ---------- 7 日均线叠加 ----------
   ui.lineChart 只画一条线（js/ui.js 不在本文件可写范围），
   所以每日线仍交给它画，均线按同一套几何（340×170 viewBox、同样的内边距与 12% 纵轴留白）
   叠一张透明 SVG。两层的数据和坐标同源，缩放后一定是同一条基准线。 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const AVG_CHART = { w: 340, h: 170, pad: { l: 38, r: 12, t: 14, b: 22 } };
const AVG_DASH = '6 4';

/** 与 ui.lineChart 内部一致的纵轴范围：只由每日值决定，均线不参与，避免两层各算一套。 */
export function avgChartRange(values) {
  const nums = (Array.isArray(values) ? values : []).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (max - min < 0.5) {
    min -= 1;
    max += 1;
  } else {
    min -= (max - min) * 0.12;
    max += (max - min) * 0.12;
  }
  return { min, max, span: (max - min) || 1 };
}

/** movingAverage 的结果 → 虚线 path 的 d；avg 为 null 处断线（多段 M），全空返回 ''。 */
export function buildAvgPath(series, height = AVG_CHART.h) {
  const rows = (Array.isArray(series) ? series : []).filter((row) => row && typeof row === 'object');
  if (!rows.length) return '';
  const range = avgChartRange(rows.map((row) => row.value));
  if (!range) return '';
  const h = Number(height) || AVG_CHART.h;
  const innerW = AVG_CHART.w - AVG_CHART.pad.l - AVG_CHART.pad.r;
  const innerH = h - AVG_CHART.pad.t - AVG_CHART.pad.b;
  const xOf = (i) => (rows.length === 1
    ? AVG_CHART.pad.l + innerW / 2
    : AVG_CHART.pad.l + (i * innerW) / (rows.length - 1));
  const yOf = (v) => AVG_CHART.pad.t + (1 - (v - range.min) / range.span) * innerH;
  let d = '';
  let open = false;
  rows.forEach((row, i) => {
    const avg = row.avg == null ? null : Number(row.avg);
    if (!Number.isFinite(avg)) { open = false; return; }
    d += `${open ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(avg).toFixed(1)} `;
    open = true;
  });
  return d.trim();
}

function avgOverlay(d, height) {
  const svgNode = document.createElementNS(SVG_NS, 'svg');
  svgNode.setAttribute('viewBox', `0 0 ${AVG_CHART.w} ${height}`);
  svgNode.setAttribute('preserveAspectRatio', 'none');
  svgNode.setAttribute('class', 'chart__overlay');
  svgNode.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', d);
  // 颜色在 styles.css 里用变量给；虚线间隔同时写进属性，CSS 没加载也还是虚线。
  line.setAttribute('class', 'chart__line chart__line--avg');
  line.setAttribute('stroke-dasharray', AVG_DASH);
  svgNode.appendChild(line);
  return svgNode;
}

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
      display = rulerNode.getValue(); // 键盘里输了越界值时，刻度尺的 clamp 结果才是真值
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
    valueText.textContent = fmt1(display);
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

    // 只展示真实存在的对比窗口，没有数据就明说，不摆一个「—」占位。
    const deltaText = () => {
      const signed = (v) => (v > 0 ? '+' : '') + fmt1(show(v));
      const parts = [];
      if (stats.delta7 != null) parts.push(`7 天 ${signed(stats.delta7)}`);
      if (stats.delta30 != null) parts.push(`30 天 ${signed(stats.delta30)}`);
      return parts.length ? `${parts.join(' · ')} ${label}` : '暂无历史对比';
    };

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
          el('div', { className: 'label', text: '变化' }),
          el('div', { className: 'strong', text: deltaText() }),
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
    if (!recent.length) {
      trendCard.appendChild(emptyState('近 30 天没有数据', '记录今天的体重', focusEntry));
    } else {
      // 每日线（原样式）交给 ui.lineChart；均线只叠一层虚线，两个都在同一 viewBox 里对齐。
      const dailyPoints = recent.map((w) => ({ x: w.date, y: show(w.weightKg) }));
      const avgPath = buildAvgPath(movingAverage(
        recent.map((w) => ({ date: w.date, value: show(w.weightKg) })),
        7,
      ));
      const base = lineChart({ points: dailyPoints, height: 170, yLabel: '' });
      const baseSvg = Array.from(base.childNodes || []).find((n) => n.tagName === 'svg');
      const axis = Array.from(base.childNodes || [])
        .find((n) => String(n.className).split(/\s+/).includes('chart__axis'));
      if (!baseSvg) {
        // 万一 ui.lineChart 换了结构，宁可只显示每日线也不要拼出一张错位的图。
        trendCard.appendChild(base);
      } else {
        trendCard.appendChild(el('div', { className: 'chart' },
          el('div', { className: 'chart__label label', text: `体重 ${label}` }),
          el('div', { className: 'chart-stack' },
            baseSvg,
            avgPath ? avgOverlay(avgPath, 170) : null,
          ),
          avgPath ? el('div', { className: 'chart__legend' },
            el('span', { className: 'chart__legend-item chart__legend-item--daily', text: '— 每日' }),
            el('span', { className: 'chart__legend-item chart__legend-item--avg', text: '－ － 7 日均线' }),
          ) : null,
          axis || null,
        ));
      }
    }
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