// 应用外壳（SPEC §5.7）：哈希路由 + tabbar 高亮 + 统一错误卡片。
// 顶层不碰 window/document，浏览器入口在文件末尾的 boot() 里。

const ROUTES = {
  '': () => import('./views/dashboard.js'),
  'weight': () => import('./views/weight.js'),
  'food': () => import('./views/food.js'),
  'exercise': () => import('./views/exercise.js'),
  'water': () => import('./views/water.js'),
  'settings': () => import('./views/settings.js'),
  'debug': () => import('./views/debug.js'),
};

const TAB_ROUTES = ['', 'weight', 'food', 'exercise', 'water'];

let renderToken = 0;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '').replace(/^\/+/, '').split('?')[0].replace(/\/+$/, '');
  return Object.prototype.hasOwnProperty.call(ROUTES, raw) ? raw : (raw === '' ? '' : null);
}

function normalizeHash(hash) {
  const raw = String(hash == null ? '' : hash).trim().replace(/^#/, '').replace(/^\/+/, '');
  return raw ? `#/${raw}` : '#/';
}

export function navigate(hash) {
  const normalized = normalizeHash(hash);
  if (window.location.hash === normalized) {
    refresh();
    return;
  }
  window.location.hash = normalized;
}

export async function refresh() {
  await renderRoute();
}

function clearOverlays() {
  for (const node of document.querySelectorAll('.sheet-backdrop, .modal-backdrop, .toast')) node.remove();
  document.body.style.overflow = '';
}

function errorCard(error) {
  const message = error && error.message ? error.message : String(error);
  const card = make('div', 'card col');
  card.appendChild(make('div', 'h2', '这个页面加载失败了'));
  card.appendChild(make('div', 'muted', message));
  const retry = make('button', 'btn btn--primary btn--block', '重试');
  retry.addEventListener('click', () => { refresh(); });
  const home = make('button', 'btn btn--ghost btn--block', '回到今日');
  home.addEventListener('click', () => { navigate('#/'); });
  card.appendChild(retry);
  card.appendChild(home);
  return card;
}

async function renderRoute() {
  const host = document.getElementById('view');
  if (!host) return;
  const token = ++renderToken;
  const route = parseRoute(window.location.hash);

  clearOverlays();

  if (route == null) {
    // 未知路由不做静默兜底，先给一次明确跳转再渲染今日，避免用户看到空白。
    window.location.hash = '#/';
    return;
  }

  // 每次渲染都换一个全新的 .page 容器：上一轮若还在 await 后追加节点，
  // 只会写进已被移除的旧容器，不会污染新页面。
  const page = make('div', 'page fade-in');
  host.replaceChildren(page);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('tab--active', tab.dataset.route === route && TAB_ROUTES.includes(route));
  }

  try {
    const mod = await ROUTES[route]();
    if (token !== renderToken) return;
    if (!mod || typeof mod.render !== 'function') throw new Error('视图模块缺少 render 导出');
    await mod.render(page);
    if (token !== renderToken) return;
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (error) {
    if (token !== renderToken) return;
    page.replaceChildren(errorCard(error));
    if (typeof console !== 'undefined') console.error('[HMS] 视图渲染失败：', error);
  }
}

async function probeStorage() {
  const banner = document.getElementById('banner');
  if (!banner) return;
  try {
    const store = await import('./js/store.js');
    await store.getProfile();
  } catch (error) {
    banner.hidden = false;
    banner.textContent = '浏览器存储不可用（隐私模式下常见），数据无法保存。请用普通窗口打开。';
    if (typeof console !== 'undefined') console.warn('[HMS] IndexedDB 不可用：', error);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      if (typeof console !== 'undefined') console.warn('[HMS] Service Worker 注册失败：', error);
    });
  });
}

export function boot() {
  window.HMS = { navigate, refresh };
  window.addEventListener('hashchange', () => { renderRoute(); });
  registerServiceWorker();
  probeStorage();
  if (!window.location.hash) {
    // 用 replaceState 补默认路由，避免多一次 hashchange 触发两遍渲染。
    try {
      window.history.replaceState(null, '', '#/');
    } catch {
      window.location.hash = '#/';
    }
  }
  renderRoute();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
}
