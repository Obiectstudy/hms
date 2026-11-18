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

// 同屏最多留几条 toast。切页不再清 toast（见 clearOverlays：它是自带生命周期的非阻塞提示），
// 所以数量上限必须自己管：快速连点 / 连续操作只保留最新的这几条，不会堆成一面墙。
const MAX_LIVE_TOASTS = 5;

export function toast(msg, type = 'info') {
  const node = el('div', { className: `toast toast--${type}`, attr: { role: 'status' }, text: String(msg) });
  // 达标 / 打卡反馈的视觉层：记录成功的那条 toast 会多一个对勾。
  // 只挂类，不动文本、不动出现时机（两个定时器一字未改）；类也只由 motionAllowed() 决定 ——
  // 降级时这个类根本不存在，styles.css 里的 ::before 因此完全不参与渲染，不会留下半透明残留。
  if (type === 'ok' && motionAllowed()) node.classList.add('hms-toast-ok');
  document.body.appendChild(node);
  // 超出的旧提示立刻退场（只删最老的，最新那条永远在）。
  const live = [...document.querySelectorAll('.toast')];
  for (const old of live.slice(0, Math.max(0, live.length - MAX_LIVE_TOASTS))) old.remove();
  // 动画结束后自删；用 timer 而不是 transitionend，避免被 display:none 卡住不触发。
  setTimeout(() => node.classList.add('toast--out'), 2400);
  setTimeout(() => node.remove(), 2900);
  return node;
}

/* ---------- 弹层收尾登记 + 切页清场 ---------- */

/**
 * 活着的弹层：每个 finish() 登记一次。
 * 外部把节点摘掉（切路由、整页重画）不会触发 finish()，滚动锁、document 上的 keydown 与
 * 那个 Promise 都会留在原地，所以弹层必须自己登记，由 clearOverlays() 统一通知收尾。
 */
const liveOverlays = new Set();

function registerOverlay(finish) {
  liveOverlays.add(finish);
  return () => { liveOverlays.delete(finish); };
}

/**
 * 切页 / 整页重画前的清场：先让每个弹层走完自己的 finish()（解锁滚动、摘 document 监听器、
 * resolve Promise），再把残留节点摘掉。app.js 的 renderRoute() 第一件事就是调它。
 *
 * .toast 刻意不在这里：它是 2.9s 后自删、不锁交互的非阻塞提示，不需要被导航撤销。
 * 把它一起摘掉会让「先 toast 再 await refresh()」的成功路径在同一个同步任务里
 * insert + remove —— 浏览器一帧都画不出来，用户于是只在出错时才看得到提示。
 * 堆积问题由 toast() 里的 MAX_LIVE_TOASTS 兜住，而不是靠切页清屏。
 */
export function clearOverlays() {
  if (typeof document === 'undefined') return;
  for (const finish of [...liveOverlays]) finish(null);
  for (const node of document.querySelectorAll('.sheet-backdrop, .modal-backdrop')) node.remove();
  document.body.style.overflow = '';
}

/* ---------- 提交期间的按钮护栏 ---------- */

// 微任务：老 WebView 没有 queueMicrotask 时用 Promise 兜一层（时序一样）。
const defer = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : (fn) => { Promise.resolve().then(fn); };

/**
 * 提交期间的按钮护栏：点下去就进入「不可点」状态，操作结束调用返回的函数恢复。
 *
 * 置灰放在当前任务之后的微任务里（不是同步置灰）：同一帧内已经分发出来的连点仍然是有效操作，
 * 由 store 的原子写入如实记账；之后的点击才被 disabled 真的挡住。这样「连点不丢增量」与
 * 「提交期不可点」同时成立 —— 而不是用延时/去抖把第二次点击悄悄丢掉。
 */
export function markBusy(button) {
  if (!button || button.disabled === true) return () => {};
  defer(() => { button.disabled = true; });
  return () => { button.disabled = false; };
}

function overlayBase(className) {
  return el('div', { className, attr: { role: 'presentation' } });
}

function lockScroll() {
  const prev = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => { document.body.style.overflow = prev; };
}

/**
 * 弹层退场（第三批）。调用点在 finish() 已经把 Promise settle 之后 ——
 * 动画只在视觉层跑，谁都不等它：await openSheet(...) 的时序与第三批之前一帧不差。
 *
 * 降级（motionAllowed() 为假）＝第三批之前的行为：立刻摘节点，一毫秒都不多留。
 * 动效开启时先挂 .hms-sheet-out（面板往下方位移 + 淡出，遮罩淡出、不再吃点击），
 * 由 animationend 摘节点；另起一个定时器兜底，防止动画被打断（切页、标签页被隐藏、
 * 系统临时开了减弱动效）之后节点永远留在 body 上。
 */
function dismissOverlay(backdrop) {
  if (!backdrop || typeof backdrop.remove !== 'function') return;
  if (!motionAllowed()) { backdrop.remove(); return; } // 降级：瞬时移除
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    backdrop.remove();
  };
  backdrop.classList.add('hms-sheet-out');
  backdrop.setAttribute('aria-hidden', 'true');
  if (typeof backdrop.addEventListener === 'function') backdrop.addEventListener('animationend', remove);
  setTimeout(remove, 320); // 兜底：animationend 没来（被打断 / 动画被禁用）也不会漏节点
}

export function confirmDialog({ title = '确认', message = '', okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    const unlock = lockScroll();
    let settled = false;
    const unregister = registerOverlay(() => finish(false));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unregister();
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
    const unregister = registerOverlay(() => finish(null));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      unregister();
      unlock();
      document.removeEventListener('keydown', onKey);
      // 先 settle，再放退场视觉：动画不参与 Promise（也不许参与），调用方拿到的时机不变。
      resolve(value);
      dismissOverlay(backdrop);
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
    // 开：面板从下方轻微位移 + 淡入，遮罩同步淡入（keyframes 自带 both，插入即入画，不用排帧）。
    // 降级时不挂类 → 与第三批之前完全一样（styles.css 里 .sheet 自己的入场动画不受影响）。
    if (motionAllowed()) backdrop.classList.add('hms-sheet-in');
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

// 环的线宽（与 circle 上的 stroke-width 同源）。圆头（round cap）每端多画半个线宽，
// 所以「把弧推到看不见」的起点要额外带上这段长度，不然收尾处会留一个小圆点。
const RING_STROKE = 12;

/**
 * 进度环。grow 控制第三批的「弧长生长」：可传 false 得到一条静态终值的环。
 *
 * 弧长生长怎么实现的（三条红线，改之前先读）：
 *  1. stroke-dasharray 永远写终值（实线段长 dash + 一整圈空隙）—— 它与进度一一对应，
 *     任何时刻读到的都必须等于当前百分比，动效不许碰它。
 *  2. 补间只发生在 stroke-dashoffset：把整段弧（连两端的圆头）推到路径起点之前 = 完全不可见，
 *     再补到 0 = 恰好停在终值弧上。视觉上就是从 12 点方向沿圆周「长」到当前百分比。
 *  3. 起点值不写成元素的 stroke-dashoffset，而是落在 CSS 变量 --hms-ring-from 里，
 *     由 @keyframes hms-ring-grow 的 from 去读。这样元素自身的 stroke-dashoffset 只有默认的 0：
 *     动画没跑（降级 / 减弱动效 / 老 WebView / 页面没挂 .hms-motion）时环就是终态，
 *     绝不会留下一个看不见的环。
 */
export function ring({ value = 0, max = 1, label = '', unit = '', color = 'var(--brand)', grow = true } = {}) {
  const pct = ratio(value, max);
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * pct;
  // 起点 = 弧长 + 一个线宽：弧本身（dash）和两端圆头（各半个线宽）都被推到 s<0，起点处一点残影都不剩。
  const growFrom = dash + RING_STROKE;
  const arcGrow = grow && pct > 0 && motionAllowed();
  const valueStyle = arcGrow ? `stroke:${color};--hms-ring-from:${growFrom.toFixed(2)}px` : `stroke:${color}`;
  const svgNode = svg('svg', { viewBox: '0 0 120 120', class: 'ring__svg', 'aria-hidden': 'true' },
    svg('circle', { cx: 60, cy: 60, r, fill: 'none', 'stroke-width': RING_STROKE, class: 'ring__track' }),
    // pct 为 0 时圆头会留下一个孤立圆点，看起来像坏掉的小圆——0 值直接不画。
    pct > 0
      ? svg('circle', {
        cx: 60, cy: 60, r, fill: 'none', 'stroke-width': RING_STROKE, 'stroke-linecap': 'round',
        class: arcGrow ? 'ring__value hms-ring-arc' : 'ring__value',
        'stroke-dasharray': `${dash} ${circumference}`,
        transform: 'rotate(-90 60 60)',
        style: valueStyle,
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

/* ---------- 动效（第一批：进度增长 / 数字滚动 / 错峰入场 / 点击手感） ---------- */
// 约定：动效只是视觉层。DOM 里的文字、宽度、圆弧长度、aria 值永远是终值 ——
// 任何时刻读文本 / 读属性都必须拿到终值，中间帧只允许改 transform / opacity（样式见 styles.css 的动效节）。

/**
 * 读 navigator.deviceMemory（单位 GB，浏览器会向下取整到 0.25 / 0.5 / 1 / 2 / 4 / 8）。
 *
 * 「未知」一律返回 null：字段缺失（Safari、Firefox 至今都没有这个 API）、undefined、
 * 非数字、读取时抛错，全都走这一条。null 的语义是「没证据」，由调用方按正常设备处理。
 */
function deviceMemoryGB() {
  let nav = null;
  try {
    nav = typeof navigator === 'undefined' ? null : navigator;
  } catch {
    nav = null; // 某些环境下访问 navigator 本身会抛（跨域 iframe 等）：当未知处理
  }
  if (!nav) return null;
  const gb = Number(nav.deviceMemory);
  return Number.isFinite(gb) ? gb : null;
}

/**
 * 动效总闸：能力 + 用户意愿 + 设备余量，三样都成立才允许动。
 *
 * 降级行为（一处判定，所有入口全部走它：armPageMotion / staggerEnter / countUp / toast 的达标反馈 /
 * ring 的弧长生长 / 折叠与弹层的缓动）：
 *  1. 没有 requestAnimationFrame（本机假 DOM、老 WebView）→ false：一条动效都不执行，直接呈现终值。
 *  2. 命中 prefers-reduced-motion: reduce（系统「减弱动态效果」）→ false：同上。
 *  3. 系统明确暴露 navigator.deviceMemory 且 <= 2GB（真·低端机）→ false：同上。
 *  4. 根节点带 .hms-motion-off（页面级顶层开关 / 排障兜底）→ false：同上。
 * 每次调用现算，不缓存：媒体查询的取值、设备内存与根节点上的开关都可能在运行期变化。
 */
export function motionAllowed() {
  // 没有帧回调就没有动画 —— 先判能力，这决定了假 DOM / 老 WebView 里的行为。
  if (typeof requestAnimationFrame !== 'function') return false;
  // 再看用户意愿：系统开了减弱动态效果，一律按终值呈现。
  if (typeof matchMedia === 'function') {
    let reduced = false;
    try {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      reduced = Boolean(query && query.matches);
    } catch {
      reduced = false; // matchMedia 抛错 = 没表态，按「未开启减弱动效」处理
    }
    if (reduced) return false;
  }
  // 低端机降级：判据刻意窄到只剩一个信号 —— 系统明确报出 <= 2GB。
  // 不用 UA / 屏幕尺寸 / CPU 核数去猜：那几样在好设备上误判的概率比真低端机还高，
  // 而误判的代价是「好设备被永久关掉动效」。deviceMemory 缺失时返回 null = 没证据 = 按正常设备处理：
  // 宁可让少数低端机多跑一次 280ms 的 transform，也不误伤主力机。内存约 3~4GB 的机器报 4，照常开动效。
  const memoryGB = deviceMemoryGB();
  if (memoryGB != null && memoryGB <= 2) return false;
  // 最后看页面级硬开关（styles.css 里 .hms-motion-off 会连 animation/transition 一起关掉）。
  // <html> 与 <body> 都看：开关挂在哪一层都算数。
  const doc = typeof document === 'undefined' ? null : document;
  const roots = doc ? [doc.documentElement, doc.body] : [];
  for (const rootNode of roots) {
    if (rootNode && rootNode.classList && typeof rootNode.classList.contains === 'function'
      && rootNode.classList.contains('hms-motion-off')) return false;
  }
  return true;
}

/**
 * 打开本页的动效作用域（第一批里 views/dashboard.js 与 views/food.js 各抄了一份，这里收口成唯一实现）。
 *
 * 做两件事，都只挂类、不碰内容：
 *  1. 给根节点挂 .hms-motion —— styles.css 里「点击手感 / 进度增长 / 卡片入场」的规则全部挂在它下面，
 *     没挂 = 本页不动（降级时页面直接就是终态）。
 *  2. 同一帧先挂 .hms-grow-pending（进度条 scaleX(0)、环缩小并半透明），下一帧摘掉它：
 *     transition 把视觉拉回终值。DOM 里的 width / stroke-dasharray 本来就是终值，这里从没改过。
 *
 * 降级：总闸关闭（无 rAF / 减弱动效 / 根节点 .hms-motion-off）时一个类都不挂，也不会排帧回调。
 * 返回值：1 = 已打开作用域，0 = 降级（视图不关心，测试用它核对「这一页到底动没动」）。
 */
export function armPageMotion(root) {
  if (!root || !root.classList || typeof root.classList.add !== 'function') return 0;
  if (!motionAllowed()) return 0;
  root.classList.add('hms-motion', 'hms-grow-pending');
  requestAnimationFrame(() => {
    if (root.classList) root.classList.remove('hms-grow-pending');
  });
  return 1;
}

/**
 * 卡片错峰入场：给一批节点挂 .hms-enter，并逐项递增 animation-delay（CSS 只有一条 keyframes）。
 *
 * 降级与预算：
 *  - 动效总闸关闭 → 一个类都不挂、返回 0：卡片就是终态，静态可见。
 *  - 条目数 > maxItems → 整批不做错峰，返回 0。500 张卡片各带一个 animation-delay 会把
 *    主线程和合成器一起压住，而且错峰到第 30 张时用户早就滚过去了 —— 这种规模下「不动」才是对的。
 * 返回值 = 实际挂上的节点数，方便视图 / 测试核对「这一页到底动没动」。
 */
export function staggerEnter(nodes, { stepMs = 40, maxItems = 50 } = {}) {
  const list = [];
  const source = Array.isArray(nodes) ? nodes : (isNode(nodes) ? [nodes] : (nodes ? Array.from(nodes) : []));
  for (const node of source) if (node) list.push(node);
  if (!list.length) return 0;
  if (!motionAllowed()) return 0;       // 降级：不做错峰
  if (list.length > maxItems) return 0; // 超过阈值：整批关掉（> 才关，正好 maxItems 仍然开）
  const step = Number.isFinite(Number(stepMs)) && Number(stepMs) >= 0 ? Number(stepMs) : 40;
  let applied = 0;
  list.forEach((node, index) => {
    if (!node.classList || typeof node.classList.add !== 'function') return;
    node.classList.add('hms-enter');
    node.style.animationDelay = `${index * step}ms`;
    applied += 1;
  });
  return applied;
}

/**
 * 数字滚动：把 to 的格式化结果写进 target，滚动只是叠加在它上面的视觉过渡。
 *
 * 红线：先写终值，而且永不写中间值 —— 任何时刻（同步调用之后、逐帧回调里）读 textContent
 * 都只能是终值。所谓「滚动」是 transform / opacity 的落位过渡，不是把数字从 from 一路数到 to。
 *
 * 降级：总闸关闭（无 rAF / 减弱动效 / 根节点 .hms-motion-off）时，写完终值立刻返回，
 * 连 .hms-count 类与内联样式都不碰 —— 呈现的就是终态。
 * from 只用来决定起步位移（变化越大起步稍远，最多 10px），不参与任何数值计算。
 */
export function countUp(target, from, to, formatFn) {
  if (!target) return;
  const fmt = typeof formatFn === 'function' ? formatFn : (value) => String(value);
  target.textContent = fmt(to); // 终值先落地（同步，且在挂任何动效之前）
  if (!motionAllowed()) return; // 降级：到此为止
  const start = Number(from);
  const end = Number(to);
  const delta = Number.isFinite(end) && Number.isFinite(start) ? Math.abs(end - start) : 0;
  const lift = Math.min(10, 4 + Math.log10(1 + delta) * 3);
  if (target.classList && typeof target.classList.add === 'function') target.classList.add('hms-count');
  target.style.transform = `translate3d(0, ${lift.toFixed(1)}px, 0)`;
  target.style.opacity = '0.35';
  // 下一帧摘掉起始态 → styles.css 里 .hms-count 的 transition 把它平滑送回原位。
  // 帧回调里只碰 transform / opacity，绝不碰文字。
  requestAnimationFrame(() => {
    target.style.transform = '';
    target.style.opacity = '';
  });
}

/* ---------- 动效（第三批：折叠缓动） ---------- */

/**
 * 展开一段折叠内容，返回 { node, close } 句柄；close() 同步把内容从 DOM 里摘掉。
 *
 * 为什么内容「展开后立即可读」：
 *  - 内容节点在 appendChild 的同一帧就进了 DOM，之后没有 display:none / visibility:hidden /
 *    content-visibility 之类的开关，也没有「等动画结束再插节点」这种顺序。
 *  - 高度补间只作用在外层 .hms-fold（grid-template-rows 0fr → 1fr，内层 overflow:hidden），
 *    没有把高度写死成像素，所以内容是自然尺寸，折行 / 字号变化都正确。
 *  - 因此文本、aria、选中、无障碍树从一开始就是完整的；动画只是让它「露出来」。
 *
 * 为什么收起不补间：收起必须同步把节点摘掉（既有的折叠断言要求收起后 DOM 里没有条目，
 * 「收起后不可读」也是同一条契约）。留一个正在播放退场动画的空壳会让文本在收起后继续留在
 * 无障碍树里 —— 那不是缓动，是 bug。所以 close() 直接移除，收起方向是瞬时的。
 *
 * 降级（motionAllowed() 为假）：不挂 --anim / --closed，直接 1fr —— 与第三批之前行为一致。
 */
export function revealFold(slot, content) {
  const wrap = el('div', { className: 'hms-fold' }, el('div', { className: 'hms-fold__inner' }, content));
  if (!slot || typeof slot.appendChild !== 'function') return { node: wrap, close() {} };
  slot.appendChild(wrap);
  if (motionAllowed()) {
    wrap.classList.add('hms-fold--anim', 'hms-fold--closed');
    // 下一帧摘掉起点：transition 把 grid-template-rows 从 0fr 拉到 1fr。
    // 帧回调只碰类名，不碰内容 —— 内容在上一行就已经可读了。
    requestAnimationFrame(() => wrap.classList.remove('hms-fold--closed'));
  }
  return {
    node: wrap,
    close() {
      if (wrap.parentNode) wrap.remove();
    },
  };
}

