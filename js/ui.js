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
    svg('circle', {
      cx: 60, cy: 60, r, fill: 'none', 'stroke-width': 12, 'stroke-linecap': 'round',
      class: 'ring__value',
      'stroke-dasharray': `${dash} ${circumference}`,
      transform: 'rotate(-90 60 60)',
      style: `stroke:${color}`,
    }),
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
