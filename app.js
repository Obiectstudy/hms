// 应用外壳（SPEC §5.7）：哈希路由 + tabbar 高亮 + 统一错误卡片。
// 顶层不碰 window/document，浏览器入口在文件末尾的 boot() 里。

export const ROUTES = {
  '': () => import('./views/dashboard.js'),
  'weight': () => import('./views/weight.js'),
  'food': () => import('./views/food.js'),
  'exercise': () => import('./views/exercise.js'),
  'water': () => import('./views/water.js'),
  'settings': () => import('./views/settings.js'),
  'account': () => import('./views/account.js'),
  'debug': () => import('./views/debug.js'),
};

// 账号页不是高频页面，只从设置页进入，不占底部 tab。
export const TAB_ROUTES = ['', 'weight', 'food', 'exercise', 'water'];

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
  // 启动链是异步的：宿主里已经没有 document 时静默退出，不往外抛未处理的异常。
  const host = typeof document === 'undefined' ? null : document.getElementById('view');
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
  // APK 内资源本来就在安装包里，Service Worker 没有收益，反而会：升级 APK 后
  // 首次打开仍由旧 SW 提供旧页面（缓存优先），导致新代码要等第二次启动才生效。
  if (window.HmsBridge) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      if (typeof console !== 'undefined') console.warn('[HMS] Service Worker 注册失败：', error);
    });
  });
}

// ---------- iOS 安装引导（Safari → 分享 → 添加到主屏幕）----------
// iOS 没有 beforeinstallprompt，只能在 Safari 里用文案引导；已经全屏运行（standalone）时绝不出现。

export const IOS_HINT_DISMISSED_KEY = 'hms.ios.hint.dismissed';

function readDismissed(storage) {
  try {
    return Boolean(storage && storage.getItem(IOS_HINT_DISMISSED_KEY));
  } catch {
    return false; // 隐私模式下 localStorage 会抛，当成「没关过」也不算事故
  }
}

function writeDismissed(storage) {
  try {
    if (storage) storage.setItem(IOS_HINT_DISMISSED_KEY, '1');
  } catch {
    /* 存不下就只在本次会话里生效 */
  }
}

function isIosSafari(userAgent, maxTouchPoints) {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  // iPadOS 13+ 默认发桌面 UA（Macintosh），靠触点数把它和真 Mac 区分开。
  return /Macintosh/.test(userAgent) && Number(maxTouchPoints) > 1;
}

function inStandaloneDisplay(win) {
  try {
    if (win.navigator && win.navigator.standalone) return true; // iOS Safari 的老属性
  } catch {
    /* 某些 WebView 里取这个属性会抛 */
  }
  try {
    if (typeof win.matchMedia === 'function') return win.matchMedia('(display-mode: standalone)').matches === true;
  } catch {
    /* 不支持 matchMedia 时按「非 standalone」处理 */
  }
  return false;
}

export function shouldShowIosHint(env = {}) {
  const win = env.win ?? (typeof window !== 'undefined' ? window : null);
  const nav = env.nav ?? (typeof navigator !== 'undefined' ? navigator : null);
  const storage = env.storage !== undefined ? env.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!win || !nav) return false;
  if (win.HmsBridge) return false; // APK 内走原生桥，不需要安装引导
  if (inStandaloneDisplay(win)) return false;
  if (!isIosSafari(String(nav.userAgent || ''), nav.maxTouchPoints)) return false;
  return !readDismissed(storage);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function createIosHint(doc, onClose) {
  const create = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const box = create('div', 'ios-hint');
  box.setAttribute('role', 'note');

  const icon = doc.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('class', 'ios-hint__icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3.6v11', 'M8.1 7.5 12 3.6l3.9 3.9', 'M5.6 12.6v6a1.8 1.8 0 0 0 1.8 1.8h9.2a1.8 1.8 0 0 0 1.8-1.8v-6']) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    icon.appendChild(path);
  }

  const text = create('div', 'ios-hint__text');
  text.appendChild(create('div', 'ios-hint__title', '添加到主屏幕，像 App 一样全屏使用'));
  text.appendChild(create('div', 'ios-hint__sub', '点 Safari 底部的「分享」→「添加到主屏幕」'));

  const close = create('button', 'ios-hint__close', '×');
  close.setAttribute('type', 'button');
  close.setAttribute('aria-label', '关闭安装引导');
  close.addEventListener('click', onClose);

  box.appendChild(icon);
  box.appendChild(text);
  box.appendChild(close);
  return box;
}

let iosHintNode = null;

export function setupIosInstallHint(env = {}) {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return null;
  if (!shouldShowIosHint(env)) return null;
  if (iosHintNode && iosHintNode.isConnected !== false) return null; // 同一次会话里只挂一次
  const storage = env.storage !== undefined ? env.storage : (typeof localStorage !== 'undefined' ? localStorage : null);

  let node = null;
  const dismiss = () => {
    writeDismissed(storage);
    if (node && typeof node.remove === 'function') node.remove();
    else if (node && node.parentNode) node.parentNode.removeChild(node);
  };
  node = createIosHint(doc, dismiss);
  iosHintNode = node;
  // 插到文档最前面：和 #banner 一样是页面顶部的通栏提示位。
  doc.body.insertBefore(node, doc.body.firstChild);
  return node;
}

// ---------- 存储持久化 ----------
// iOS 只在「添加到主屏幕」之后才可能授予持久化；拿不到也不能影响渲染，所以只记日志。
export async function requestPersistentStorage() {
  try {
    if (typeof navigator === 'undefined') return false;
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    const granted = await storage.persist();
    if (typeof console !== 'undefined') console.info('[HMS] 持久化存储：', granted ? '已授予' : '未授予');
    return Boolean(granted);
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[HMS] 持久化存储请求失败：', error);
    return false;
  }
}

// 老库名：账号层拿不到时也要回到用户数据所在的那个库。
const LEGACY_FALLBACK_DB = 'hms';
const ACCOUNT_DEGRADE_MESSAGE = '账号初始化失败，已继续使用本机数据';

let accountNoticeShown = false;

/** 降级提示只出现一次：boot 重跑或多处调用都不该刷屏。 */
async function notifyAccountDegrade(message) {
  if (typeof console !== 'undefined') console.warn('[HMS]', message);
  if (accountNoticeShown) return;
  accountNoticeShown = true;
  try {
    const ui = await import('./js/ui.js');
    ui.toast(message, 'error');
  } catch {
    /* 连提示都挂不出来时也已经降级继续跑了 */
  }
}

/**
 * 账号就绪。必须早于第一次渲染：库名跟着账号走，渲染在前就会把首屏读到别的库上。
 * 任何一步失败都降级回老库 hms 继续跑（绝不白屏），并只提示一次。
 */
export async function prepareAccounts() {
  try {
    const [accounts, db] = await Promise.all([import('./js/accounts.js'), import('./js/db.js')]);
    const account = await accounts.ensureDefaultAccount();
    const name = accounts.dbNameForAccount(account);
    if (db.getDbName() !== name) await db.setDbName(name);
    return account;
  } catch (error) {
    try {
      const db = await import('./js/db.js');
      if (db.getDbName() !== LEGACY_FALLBACK_DB) await db.setDbName(LEGACY_FALLBACK_DB);
    } catch {
      /* 存储整体不可用：probeStorage 的横幅已经在提示了 */
    }
    await notifyAccountDegrade(`${ACCOUNT_DEGRADE_MESSAGE}（${error && error.message ? error.message : error}）`);
    return null;
  }
}

export function boot() {
  window.HMS = { navigate, refresh };
  window.addEventListener('hashchange', () => { renderRoute(); });
  registerServiceWorker();
  probeStorage();
  requestPersistentStorage(); // 不 await：拿不到持久化也不能挡住首屏
  setupIosInstallHint();
  if (!window.location.hash) {
    // 用 replaceState 补默认路由，避免多一次 hashchange 触发两遍渲染。
    try {
      window.history.replaceState(null, '', '#/');
    } catch {
      window.location.hash = '#/';
    }
  }
  // 账号先就绪，再渲染首屏；prepareAccounts 自己吞掉失败，这里只兜底一次。
  return prepareAccounts().then(() => renderRoute(), (error) => {
    if (typeof console !== 'undefined') console.error('[HMS] 启动失败：', error);
    return renderRoute();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot().catch((error) => {
    if (typeof console !== 'undefined') console.error('[HMS] 启动失败：', error);
  });
}
