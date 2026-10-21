// 视图共用 DOM/SVG 原语（SPEC §5.6）。
// 约束：模块顶层不触碰 document/window，保证 Node 里可 import 做签名冒烟测试。

const SVG_NS = 'http://www.w3.org/2000/svg';

function isNode(value) {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (isNode(child)) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
    } else if (key === 'attr') {
      for (const [k, v] of Object.entries(value)) {
        if (v == null || v === false) continue;
        node.setAttribute(k, v === true ? '' : String(v));
      }
    } else if (key === 'style') {
      for (const [k, v] of Object.entries(value)) {
        if (v == null) continue;
        if (k.startsWith('--')) node.style.setProperty(k, String(v));
        else node.style[k] = String(v);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

// 数字排版：关键数值大、单位小灰（样式在 styles.css）。
export function fmtKcal(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v)) : '0';
}

export function fmtKg(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}

export function fmt1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(1) : '0.0';
}

export function fmtDateCN(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
}

export function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toast(msg, type = 'info') {
  const node = el('div', { className: `toast toast--${type}`, attr: { role: 'status' }, text: String(msg) });
  document.body.appendChild(node);
  // 动画结束后自删；用 timer 而不是 transitionend，避免被 display:none 卡住不触发。
  setTimeout(() => node.classList.add('toast--out'), 2400);
  setTimeout(() => node.remove(), 2900);
  return node;
}

function overlayBase(className) {
  return el('div', { className, attr: { role: 'presentation' } });
}

function lockScroll() {
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => { document.body.style.overflow = prev; };
}

export function confirmDialog({ title = '确认', message = '', okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    const unlock = lockScroll();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unlock();
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };
    const backdrop = overlayBase('modal-backdrop');
    const dialog = el('div', { className: 'modal', attr: { role: 'dialog', 'aria-modal': 'true' } },
      el('div', { className: 'modal__title', text: String(title) }),
      message ? el('div', { className: 'modal__msg', text: String(message) }) : null,
      el('div', { className: 'modal__actions' },
        el('button', { className: 'btn btn--ghost', text: cancelText, onClick: () => finish(false) }),
        el('button', { className: 'btn btn--primary', text: okText, onClick: () => finish(true) }),
      ),
    );
    backdrop.appendChild(dialog);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
  });
}

// 底部弹层。actions: [{ text, value, primary?, danger? }]，解析为被点按钮的 value；
// 遮罩/关闭按钮/Esc 解析为 null。content 可传元素，或传 fn({ close }) 以便内部程序化关闭。
export function openSheet({ title = '', content = null, actions = [] } = {}) {
  return new Promise((resolve) => {
    const unlock = lockScroll();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unlock();
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    const backdrop = overlayBase('sheet-backdrop');
    const body = el('div', { className: 'sheet__body' });
    const sheet = el('div', { className: 'sheet', attr: { role: 'dialog', 'aria-modal': 'true' } },
      el('div', { className: 'sheet__head' },
        el('div', { className: 'sheet__title', text: String(title) }),
        el('button', { className: 'sheet__close', text: '×', attr: { 'aria-label': '关闭' }, onClick: () => finish(null) }),
      ),
      body,
    );
    if (actions.length) {
      sheet.appendChild(el('div', { className: 'sheet__actions' },
        actions.map((action) => el('button', {
          className: `btn ${action.primary ? 'btn--primary' : action.danger ? 'btn--danger' : 'btn--ghost'} btn--block`,
          text: action.text,
          onClick: () => finish(action.value === undefined ? action.text : action.value),
        })),
      ));
    }
    backdrop.appendChild(sheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
    document.addEventListener('keydown', onKey);
    // content 在 close 可用之后才能渲染，否则内部按钮无法关闭弹层。
    const rendered = typeof content === 'function' ? content({ close: finish }) : content;
    if (rendered) appendChildren(body, [rendered]);
    document.body.appendChild(backdrop);
  });
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.appendChild(child);
  }
  return node;
}

function ratio(value, max) {
  const v = Number(value);
  const m = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 0;
  return Math.min(1, Math.max(0, v / m));
}

export function ring({ value = 0, max = 1, label = '', unit = '', color = 'var(--brand)' } = {}) {
  const pct = ratio(value, max);
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * pct;
  const svgNode = svg('svg', { viewBox: '0 0 120 120', class: 'ring__svg', 'aria-hidden': 'true' },
    svg('circle', { cx: 60, cy: 60, r, fill: 'none', 'stroke-width': 12, class: 'ring__track' }),
    // pct 为 0 时圆头会留下一个孤立圆点，看起来像坏掉的小圆——0 值直接不画。
    pct > 0
      ? svg('circle', {
        cx: 60, cy: 60, r, fill: 'none', 'stroke-width': 12, 'stroke-linecap': 'round',
        class: 'ring__value',
        'stroke-dasharray': `${dash} ${circumference}`,
        transform: 'rotate(-90 60 60)',
        style: `stroke:${color}`,
      })
      : null,
  );
  return el('div', { className: 'ring' },
    svgNode,
    el('div', { className: 'ring__center' },
      el('div', { className: 'ring__num', text: fmtKcal(value) }),
      unit ? el('div', { className: 'ring__unit', text: unit }) : null,
      label ? el('div', { className: 'ring__label', text: label }) : null,
    ),
  );
}

export function bar({ value = 0, max = 1, color = 'var(--brand)' } = {}) {
  const pct = ratio(value, max) * 100;
  return el('div', { className: 'bar', attr: { role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 } },
    el('div', { className: 'bar__fill', style: { width: `${pct}%`, background: color } }),
  );
}

// 手写内联 SVG 折线：不引图表库，points 为 [{ x: 'YYYY-MM-DD', y: number }]。
export function lineChart({ points = [], height = 170, yLabel = '' } = {}) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.y)))
    .map((p) => ({ x: String(p.x), y: Number(p.y) }));
  if (!pts.length) return el('div', { className: 'chart chart--empty muted', text: '暂无数据' });

  const w = 340;
  const h = Number(height) || 170;
  const pad = { l: 38, r: 12, t: 14, b: 22 };
  const ys = pts.map((p) => p.y);
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  // 单点或全平时给一个人造区间，否则折线贴边或除零。
  if (max - min < 0.5) {
    min -= 1;
    max += 1;
  } else {
    min -= (max - min) * 0.12;
    max += (max - min) * 0.12;
  }
  const span = max - min;
  const innerW = w - pad.l - pad.r;
  const px = (i) => (pts.length === 1 ? pad.l + innerW / 2 : pad.l + (i * innerW) / (pts.length - 1));
  const py = (v) => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  const area = `${path} L${px(pts.length - 1).toFixed(1)},${(h - pad.b).toFixed(1)} L${px(0).toFixed(1)},${(h - pad.b).toFixed(1)} Z`;

  const gridValues = [max, (max + min) / 2, min];
  const svgNode = svg('svg', {
    viewBox: `0 0 ${w} ${h}`, class: 'chart__svg', preserveAspectRatio: 'none',
    attr: { role: 'img', 'aria-label': `折线图，共 ${pts.length} 个数据点` },
  },
    ...gridValues.map((v) => svg('line', {
      x1: pad.l, x2: w - pad.r, y1: py(v).toFixed(1), y2: py(v).toFixed(1), class: 'chart__grid',
    })),
    svg('path', { d: area, class: 'chart__area' }),
    svg('path', { d: path, class: 'chart__line' }),
    ...(pts.length <= 40
      ? pts.map((p, i) => svg('circle', { cx: px(i).toFixed(1), cy: py(p.y).toFixed(1), r: 2.6, class: 'chart__dot' }))
      : []),
  );

  const legend = el('div', { className: 'chart__axis' },
    el('span', { text: pts[0].x.slice(5) }),
    el('span', { text: `${fmt1(max)} ~ ${fmt1(min)}` }),
    el('span', { text: pts[pts.length - 1].x.slice(5) }),
  );

  return el('div', { className: 'chart' },
    yLabel ? el('div', { className: 'chart__label label', text: yLabel }) : null,
    svgNode,
    legend,
  );
}

export function emptyState(text, actionText, onAction) {
  return el('div', { className: 'empty' },
    el('div', { className: 'empty__text', text: String(text || '') }),
    actionText ? el('button', {
      className: 'btn btn--primary empty__btn',
      text: actionText,
      onClick: () => { if (typeof onAction === 'function') onAction(); },
    }) : null,
  );
}

/* ---------- 体重刻度尺（SPEC §7 体重：左右滑动录入） ---------- */

// 刻度网格以 0 为原点：step=0.1 时 68.4 落在网格上，step=0.2 时 181.2 也落在网格上，
// 所以 kg ⇄ 斤 切换后同一物理重量仍然是刻度点。
const RULER_MAX_TICKS = 20000;

function stepDecimals(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

function roundToDecimals(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const r = Number(n.toFixed(Math.min(6, Math.max(0, decimals))));
  return Object.is(r, -0) ? 0 : r;
}

function bounds(min, max) {
  const lo = Number(min);
  const hi = Number(max);
  return { lo: Number.isFinite(lo) ? lo : -Infinity, hi: Number.isFinite(hi) ? hi : Infinity };
}

function gridIndex(value, step) {
  return Math.round(Number(value) / Number(step));
}

/** 就近吸附到 step 的整数倍，再 clamp 到 [min, max]；非法输入回落到 min，绝不抛异常。 */
export function snapToStep(value, step, min, max) {
  const { lo, hi } = bounds(min, max);
  const raw = Number(value);
  const start = Number.isFinite(raw) ? raw : (Number.isFinite(lo) ? lo : 0);
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return Math.min(hi, Math.max(lo, start));
  const snapped = roundToDecimals(Math.round(start / s) * s, stepDecimals(step));
  // 边界优先：min/max 本身可能不在网格上，clamp 后不再二次吸附，避免越界。
  return Math.min(hi, Math.max(lo, snapped));
}

/**
 * 拖动位移 → 吸附后的显示值。
 * deltaPx > 0 表示手指向右拖（刻度条右移，指针指到更小的刻度），
 * 因此 显示值 = startValue − deltaPx / pxPerStep × step。
 */
export function valueFromDrag({ startValue = 0, deltaPx = 0, pxPerStep = 8, step = 1, min = -Infinity, max = Infinity } = {}) {
  const { lo, hi } = bounds(min, max);
  const s = Number(step);
  const perStep = Number(pxPerStep);
  const start = Number(startValue);
  const safeStart = Number.isFinite(start) ? start : (Number.isFinite(lo) ? lo : 0);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(perStep) || perStep <= 0) {
    return snapToStep(safeStart, step, lo, hi);
  }
  const delta = Number(deltaPx);
  const steps = Number.isFinite(delta) ? delta / perStep : 0;
  return snapToStep(safeStart - steps * s, s, lo, hi);
}

/** 刻度清单：kind 依次为 label（带数字，一定也是 major）> major > minor。 */
export function rulerTicks({ min = 0, max = 100, step = 1, majorEvery = 10, labelEvery = 50 } = {}) {
  const s = Number(step);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const major = Number.isFinite(Number(majorEvery)) && Number(majorEvery) > 0 ? Math.round(Number(majorEvery)) : 0;
  const label = Number.isFinite(Number(labelEvery)) && Number(labelEvery) > 0 ? Math.round(Number(labelEvery)) : 0;
  const decimals = stepDecimals(s);
  // 1e-9 抵消 20/0.1=199.99999… 这类除法尾巴，否则首尾刻度会少一根。
  const first = Math.ceil(lo / s - 1e-9);
  const last = Math.floor(hi / s + 1e-9);
  const ticks = [];
  for (let i = first; i <= last && ticks.length < RULER_MAX_TICKS; i += 1) {
    const kind = label > 0 && i % label === 0 ? 'label' : major > 0 && i % major === 0 ? 'major' : 'minor';
    ticks.push({ value: roundToDecimals(i * s, decimals), kind });
  }
  return ticks;
}

/** 刻度上的数字：整数不带小数尾巴，其余保留 1 位。 */
function tickLabel(value) {
  const v = Number(value);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * 刻度尺选择器：中心固定指针 + 随拖动位移的刻度条。
 * 手势走 pointerdown/move/up（触摸与鼠标同一套），松手直接吸附到 step 网格，没有惯性动画。
 * 返回的节点额外挂 setValue(v) / getValue()，供视图做单位切换与测试断言。
 */
export function rulerPicker({
  min = 0,
  max = 100,
  step = 1,
  value = 0,
  unitLabel = '',
  majorEvery = 10,
  labelEvery = 50,
  pxPerStep = 8,
  label = '滑动选值',
  onChange,
} = {}) {
  const { lo, hi } = bounds(min, max);
  const s = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 1;
  const perStep = Number.isFinite(Number(pxPerStep)) && Number(pxPerStep) > 0 ? Number(pxPerStep) : 8;
  const decimals = Math.max(stepDecimals(s), 1);
  let current = snapToStep(value, s, lo, hi);

  // 位置一律取到 0.001px：20/0.1 这类除法会留下 199.99999999999997 的长尾巴。
  const offsetOf = (v) => Math.round(((v - lo) / s) * perStep * 1000) / 1000;

  const strip = el('div', { className: 'ruler__strip' });
  for (const tick of rulerTicks({ min: lo, max: hi, step: s, majorEvery, labelEvery })) {
    const x = offsetOf(tick.value);
    const modifier = tick.kind === 'label' ? ' ruler__tick--major ruler__tick--label' : tick.kind === 'major' ? ' ruler__tick--major' : '';
    strip.appendChild(el('div', {
      className: `ruler__tick${modifier}`,
      style: { left: `${x}px` },
      attr: { 'aria-hidden': 'true' },
    }));
    if (tick.kind === 'label') {
      strip.appendChild(el('div', { className: 'ruler__label', style: { left: `${x}px` }, attr: { 'aria-hidden': 'true' }, text: tickLabel(tick.value) }));
    }
  }

  const root = el('div', {
    className: 'ruler',
    attr: {
      role: 'slider',
      tabindex: '0',
      'aria-label': label,
      'aria-valuemin': lo,
      'aria-valuemax': hi,
    },
  },
    el('div', { className: 'ruler__pointer', attr: { 'aria-hidden': 'true' } }),
    strip,
  );

  const shown = () => roundToDecimals(current, decimals);

  function paint() {
    strip.style.transform = `translate3d(${-offsetOf(current)}px, 0, 0)`;
    root.setAttribute('aria-valuenow', String(shown()));
    root.setAttribute('aria-valuetext', `${shown()}${unitLabel ? ` ${unitLabel}` : ''}`);
  }

  function emit() {
    if (typeof onChange === 'function') onChange(shown());
  }

  function setValue(next, silent = false) {
    current = snapToStep(next, s, lo, hi);
    paint();
    if (!silent) emit();
    return shown();
  }

  let drag = null;
  root.addEventListener('pointerdown', (event) => {
    if (event && event.button != null && event.button !== 0) return;
    drag = { startX: Number(event && event.clientX), startValue: current, pointerId: event && event.pointerId };
    if (typeof root.setPointerCapture === 'function' && drag.pointerId != null) {
      try { root.setPointerCapture(drag.pointerId); } catch { /* 老浏览器没有指针捕获，退化为容器内拖动 */ }
    }
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    // 拖动后仍可用键盘微调：部分浏览器不会自动把焦点给到 tabindex 容器。
    if (typeof root.focus === 'function') {
      try { root.focus({ preventScroll: true }); } catch { root.focus(); }
    }
    root.classList.add('ruler--dragging');
  });
  root.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const x = Number(event && event.clientX);
    if (!Number.isFinite(x)) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setValue(valueFromDrag({ startValue: drag.startValue, deltaPx: x - drag.startX, pxPerStep: perStep, step: s, min: lo, max: hi }));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    root.classList.remove('ruler--dragging');
    // 拖动中已逐帧吸附，这里再对齐一次，保证松手值与屏幕上指针所指刻度一致。
    setValue(current);
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener('keydown', (event) => {
    const key = event && event.key;
    let next = null;
    if (key === 'ArrowLeft' || key === 'ArrowDown') next = current - s;
    else if (key === 'ArrowRight' || key === 'ArrowUp') next = current + s;
    else if (key === 'Home') next = lo;
    else if (key === 'End') next = hi;
    if (next == null) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setValue(next);
  });

  root.getValue = shown;
  root.setValue = (next) => setValue(next, true);
  paint();
  return root;
}

export function field({ label = '', type = 'text', value = '', placeholder = '', onInput } = {}) {
  const input = el('input', {
    className: 'input',
    type,
    value: value == null ? '' : value,
    placeholder: placeholder || '',
  });
  if (typeof onInput === 'function') input.addEventListener('input', onInput);
  return el('label', { className: 'field' },
    label ? el('span', { className: 'field__label', text: String(label) }) : null,
    input,
  );
}
