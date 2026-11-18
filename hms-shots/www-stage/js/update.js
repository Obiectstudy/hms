// 应用内更新提示条（SPEC §5.7 / §7 今日页顶部）。
// 只在内置 HmsBridge 的 APK 里生效：PWA 没有桥，initUpdateBanner 直接返回 null，不请求、不渲染。
// 约束：模块顶层不触碰 window / document / localStorage，Node 里可以直接 import。

import { el, toast } from './ui.js';

/**
 * 旧版把「稍后」写进这个键，而且永久生效（同一版本从此再也不提示，重启也没用）。
 * 现在它只剩迁移用途：读到就删掉，里面的值不参与任何判断。
 */
export const DISMISS_KEY = 'hms.update.dismissed';

const INSTALL_TEXT = '立即更新';

/**
 * 「稍后」只对本次运行有效：存在模块内存里，清后台重开（js/update.js 重新加载）就归零。
 * 不能写 localStorage —— 那等于把「稍后」变成「这个版本我永远不要了」，用户再也点不到更新。
 */
let dismissedThisRun = 0;

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

/** 桥回来的结果可能是 JSON 字符串，也可能已经是对象；其余输入一律当作「没有结果」。 */
export function parseBridgeJson(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      return asPlainObject(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return asPlainObject(raw);
}

/** versionCode 严格大于本地版本才算新版；非法数字一律不算。 */
export function isNewer(currentCode, remoteCode) {
  const current = Number(currentCode);
  const remote = Number(remoteCode);
  if (!Number.isFinite(current) || !Number.isFinite(remote)) return false;
  return remote > current;
}

/** 远端版本值不值得提示：失败结果、缺 versionCode、已被「稍后」过的版本都不提示。 */
export function shouldPrompt(remote, dismissedCode) {
  const info = asPlainObject(remote);
  if (!info) return false;
  if (info.ok === false) return false;
  const code = Number(info.versionCode);
  if (!Number.isFinite(code) || code <= 0) return false;
  const dismissed = Number(dismissedCode);
  return !(Number.isFinite(dismissed) && code <= dismissed);
}

export function versionLabel(info) {
  const name = String(info.versionName == null ? '' : info.versionName).trim();
  if (name) return name;
  const code = Number(info.versionCode);
  return Number.isFinite(code) && code > 0 ? `版本 ${code}` : '';
}

/**
 * 提示条本体：文案固定为「发现新版本 x.y.z / notes / 立即更新 / 稍后」。
 * 返回的节点额外挂 applyProgress(payload)，供全局的 __hmsUpdateProgress 驱动按钮态。
 */
export function createUpdateBanner({ remote, onInstall, onDismiss } = {}) {
  const info = asPlainObject(remote) || {};
  const version = versionLabel(info);
  const notes = String(info.notes == null ? '' : info.notes).trim();

  const installBtn = el('button', { className: 'btn btn--primary update-bar__btn', text: INSTALL_TEXT });
  const laterBtn = el('button', { className: 'btn btn--ghost update-bar__later', text: '稍后' });

  const bar = el('div', { className: 'update-bar', attr: { role: 'status' } },
    el('div', { className: 'update-bar__text' },
      el('span', { className: 'update-bar__icon', text: '↑', attr: { 'aria-hidden': 'true' } }),
      el('div', { className: 'update-bar__copy' },
        el('span', { className: 'update-bar__title', text: version ? `发现新版本 ${version}` : '发现新版本' }),
        notes ? el('span', { className: 'update-bar__notes', text: notes }) : null,
      ),
    ),
    el('div', { className: 'update-bar__actions' }, installBtn, laterBtn),
  );

  const setInstallText = (text) => { installBtn.textContent = text; };

  function fail(error) {
    installBtn.disabled = false;
    setInstallText(INSTALL_TEXT);
    const reason = error && error.message ? error.message : String(error || '未知错误');
    toast(`更新失败：${reason}`, 'error');
  }

  installBtn.addEventListener('click', () => {
    if (installBtn.disabled) return;
    installBtn.disabled = true;
    setInstallText('准备中…');
    try {
      // 没传 onInstall 时直接走共享安装入口（与设置页「下载并安装」是同一个函数）。
      const result = typeof onInstall === 'function' ? onInstall(info) : installUpdate(info);
      if (result && result.ok === false) fail(result.reason || '安装不可用');
    } catch (error) {
      fail(error);
    }
  });

  laterBtn.addEventListener('click', () => {
    try {
      if (typeof onDismiss === 'function') onDismiss(info);
    } finally {
      // 只是这一次不打扰：记的是 versionCode，下次换新版仍会提示。
      bar.remove();
    }
  });

  bar.applyProgress = (payload) => {
    const data = asPlainObject(payload) || {};
    const state = String(data.state || '');
    const percent = Number(data.percent);
    if (state === 'downloading') {
      installBtn.disabled = true;
      setInstallText(Number.isFinite(percent) ? `下载中 ${Math.round(percent)}%` : '下载中…');
    } else if (state === 'verifying') {
      installBtn.disabled = true;
      setInstallText('校验中…');
    } else if (state === 'opening') {
      installBtn.disabled = true;
      setInstallText('正在打开安装…');
    } else if (state === 'error') {
      fail(data.message);
    }
  };

  return bar;
}

/* ---------- 宿主环境（全部在函数内取，模块顶层不碰任何全局） ---------- */

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 当前环境的原生桥（模块顶层不碰 window，一律现取）。 */
function currentBridge() {
  try {
    return typeof window === 'undefined' || !window ? null : window.HmsBridge;
  } catch {
    return null;
  }
}

/**
 * 旧版的持久化「稍后」：读到就删，值直接丢弃 —— 它正是「点过稍后再也看不到更新」的根源。
 * 脏数据（非数字 / 负数 / Infinity / 空白）同样只是被删掉，不进任何判断，也不抛异常。
 */
function dropLegacyDismissed() {
  const box = storage();
  if (!box) return;
  try {
    const legacy = typeof box.getItem === 'function' ? box.getItem(DISMISS_KEY) : null;
    if (legacy != null && typeof box.removeItem === 'function') box.removeItem(DISMISS_KEY);
  } catch {
    /* 隐私模式（Safari / 无痕）下 localStorage 会抛：删不掉就等于没有，下次仍会提示。 */
  }
}

/** 本次运行内被「稍后」掉的最高 versionCode（顺带把旧键清掉）。重启后归零。 */
export function readDismissed() {
  dropLegacyDismissed();
  return dismissedThisRun;
}

/** 点「稍后」：只记到本次运行结束，不落盘。重启后同一版本会再次提示。 */
export function dismissVersion(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return;
  if (n > dismissedThisRun) dismissedThisRun = n;
}

/** 清掉抑制状态（设置页「检查更新」发现新版时调用：用户主动来要更新，就不能再替他压着）。 */
export function clearDismissed() {
  dismissedThisRun = 0;
  dropLegacyDismissed();
}

function safeRead(readCode) {
  try {
    const code = Number(readCode());
    return Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

/** 本机版本（桥的 version()）；取不到就是 code 0 / name ''，绝不抛。 */
export function localVersion(bridge) {
  const b = bridge || currentBridge();
  let info = null;
  try {
    info = parseBridgeJson(b && typeof b.version === 'function' ? b.version() : null);
  } catch {
    info = null;
  }
  const code = info ? Number(info.versionCode) : NaN;
  const name = info && info.versionName != null ? String(info.versionName).trim() : '';
  return { versionCode: Number.isFinite(code) ? code : 0, versionName: name };
}

function installedVersionCode(bridge) {
  return localVersion(bridge).versionCode;
}

function placeBanner(mount, node) {
  if (typeof mount === 'function') {
    mount(node);
    return;
  }
  if (mount && typeof mount.appendChild === 'function') mount.appendChild(node);
}

// 当前页面上活着的那一条：进度回调来自原生，只能靠这个引用找到它。
let activeBanner = null;

/**
 * 挂载更新提示条。桥不存在（PWA）时同步返回 null，不请求、不挂全局回调。
 * 桥的回调是异步的，所以返回 Promise<HTMLElement|null>；调用方不必等它，靠 mount 决定落点。
 */
export async function initUpdateBanner({ mount, getDismissed, setDismissed } = {}) {
  const bridge = typeof window === 'undefined' || !window ? null : window.HmsBridge;
  if (!bridge || typeof bridge.checkUpdate !== 'function') return null;
  if (!mount) return null;

  const readCode = typeof getDismissed === 'function' ? getDismissed : readDismissed;
  const saveCode = typeof setDismissed === 'function' ? setDismissed : dismissVersion;
  const installedCode = installedVersionCode(bridge);
  const dismissedCode = safeRead(readCode);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (node) => {
      if (settled) return;
      settled = true;
      resolve(node);
    };

    window.__hmsUpdate = (raw) => {
      // 原生侧重复回调只认第一条，否则会插出第二条提示条。
      if (settled) return;
      const remote = parseBridgeJson(raw);
      if (!remote || !isNewer(installedCode, remote.versionCode) || !shouldPrompt(remote, dismissedCode)) {
        finish(null);
        return;
      }
      let banner;
      try {
        banner = createUpdateBanner({
          remote,
          // 走共享安装入口：与设置页「下载并安装」是同一个函数、同一份参数。
          onInstall: (payload) => installUpdate(payload, bridge),
          onDismiss: () => { saveCode(Number(remote.versionCode)); },
        });
        placeBanner(mount, banner);
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[HMS] 更新提示条渲染失败：', error);
        finish(null);
        return;
      }
      activeBanner = banner;
      finish(banner);
    };

    // 下载/校验/拉起安装的进度只更新按钮文案，不改条的结构。
    window.__hmsUpdateProgress = (raw) => {
      const payload = parseBridgeJson(raw);
      if (!payload || !activeBanner || typeof activeBanner.applyProgress !== 'function') return;
      activeBanner.applyProgress(payload);
    };

    try {
      bridge.checkUpdate();
    } catch (error) {
      if (typeof console !== 'undefined') console.warn('[HMS] 检查更新失败：', error);
      finish(null);
    }
  });
}

/* ---------- 设置页「检查更新」：查一次结果 + 唯一的安装入口 ---------- */

/** iOS / iPadOS（含发桌面 UA 的 iPad）：网页版只能靠刷新页面拿新版本。口径与 app.js 的安装引导一致。 */
export function isIosLike(nav) {
  const n = nav || (typeof navigator === 'undefined' ? null : navigator);
  if (!n) return false;
  const ua = String(n.userAgent || '');
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && Number(n.maxTouchPoints) > 1;
}

/** 没有原生桥（PWA / 浏览器 / iOS）时该怎么说：告诉用户真能用的办法，而不是给一个点不动的按钮。 */
export function webUpdateGuidance(nav) {
  return isIosLike(nav)
    ? '网页版没有安装按钮：用 Safari 打开本站并下拉刷新即可用上新版本（从主屏幕图标进入的，刷新后也是最新版）。'
    : '网页版没有安装按钮：刷新本页即可用上新版本（下拉刷新或按 Ctrl+R / F5）。';
}

/** 能不能真的下载安装：只有带 installUpdate 的原生桥支持。 */
export function isInstallAvailable(bridge) {
  const b = bridge || currentBridge();
  return Boolean(b && typeof b.installUpdate === 'function');
}

/**
 * 唯一的安装入口：今日页「立即更新」与设置页「下载并安装」都走这里，不另写下载逻辑。
 * 不抛异常，结果用返回值表达：{ ok: true } / { ok: false, reason }。
 */
export function installUpdate(info, bridge) {
  const b = bridge || currentBridge();
  if (!b || typeof b.installUpdate !== 'function') return { ok: false, reason: '当前环境不支持应用内安装' };
  try {
    // 原生侧自己会解析 JSON：传字符串比传对象更稳妥。
    b.installUpdate(JSON.stringify(info || {}));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error || '未知错误') };
  }
}

/**
 * 手动检查更新（设置页）：临时接管 window.__hmsUpdate 拿一次结果，用完立刻还原给今日页提示条。
 * status: 'unavailable' | 'new' | 'latest' | 'error' | 'timeout'；永不 reject。
 */
export function checkForUpdate({ bridge, timeoutMs = 15000 } = {}) {
  const b = bridge || currentBridge();
  const local = localVersion(b);
  if (!b || typeof b.checkUpdate !== 'function') return Promise.resolve({ status: 'unavailable', remote: null, local });
  const hasWindow = typeof window !== 'undefined' && Boolean(window);
  return new Promise((resolve) => {
    const previous = hasWindow ? window.__hmsUpdate : undefined;
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer != null) clearTimeout(timer);
      if (hasWindow) window.__hmsUpdate = previous;
      resolve(result);
    };
    if (hasWindow) {
      window.__hmsUpdate = (raw) => {
        const remote = parseBridgeJson(raw);
        if (!remote) { finish({ status: 'error', remote: null, local, error: '返回内容无法解析' }); return; }
        if (remote.ok === false) { finish({ status: 'error', remote, local, error: String(remote.error || '检查失败') }); return; }
        finish(isNewer(local.versionCode, remote.versionCode)
          ? { status: 'new', remote, local }
          : { status: 'latest', remote, local });
      };
    }
    const wait = Number(timeoutMs);
    timer = setTimeout(() => finish({ status: 'timeout', remote: null, local }), Number.isFinite(wait) && wait > 0 ? wait : 15000);
    try {
      b.checkUpdate();
    } catch (error) {
      finish({ status: 'error', remote: null, local, error: error && error.message ? error.message : '未知错误' });
    }
  });
}
