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

/* ---------- 版本清单：有序地址 + 逐个尝试（与 HmsBridge.MANIFEST_URLS 一致） ---------- */

/**
 * 清单地址按顺序尝试，第一个给出可用清单的就是结果，后面的不再请求。
 * CloudBase 在前：国内直连；GitHub Pages 只作回退（国内多半连不上——「检查更新失败」就是它）。
 * 顺序即优先级，改动这里要同步 android 侧的 MANIFEST_URLS。
 */
export const MANIFEST_URLS = Object.freeze([
  'https://hms-d4gnh63iw73f09792-1513758162.tcloudbaseapp.com/version.json',
  'https://obiectstudy.github.io/hms/version.json',
]);

/** 单个地址的默认超时：两个地址轮完最多两倍，不能让「检查更新」无限转圈。 */
const MANIFEST_TIMEOUT_MS = 8000;

/** 老壳子把「已是最新」当失败回传时用的文案前缀。 */
const LATEST_PREFIX = /^已是最新版本/;

/** 失败类型：决定设置页说「网络不通」还是「清单内容不对」。 */
const FAILURE_KINDS = ['network', 'manifest', 'timeout'];

function invalidManifest(reason) {
  const error = new Error(reason);
  error.name = 'ManifestInvalid';
  return error;
}

function offlineManifest(reason) {
  const error = new Error(reason);
  error.name = 'ManifestOffline';
  return error;
}

function timeoutManifest() {
  const error = new Error('请求超时');
  error.name = 'ManifestTimeout';
  return error;
}

function reasonOf(error) {
  if (!error) return '';
  return String(error.message != null ? error.message : error).trim();
}

/** 地址列表归一：接受单个字符串或数组（缺省用 MANIFEST_URLS）；空值丢掉，顺序不变。 */
export function manifestUrls(urls) {
  const source = urls == null ? MANIFEST_URLS : (Array.isArray(urls) ? urls : [urls]);
  return source.map((url) => String(url == null ? '' : url).trim()).filter(Boolean);
}

/** 清单可用 = 有正数 versionCode（版本号缺失的清单不能拿来做比较）。 */
export function hasVersionCode(manifest) {
  const code = Number(manifest && manifest.versionCode);
  return Number.isFinite(code) && code > 0;
}

/**
 * 一次请求 + 解析。三类失败各自带名字，上层才能区分：
 *   ManifestTimeout 超时 / ManifestOffline 连不上或非 2xx / ManifestInvalid 内容不对。
 */
async function requestManifest(fetchImpl, url, timeoutMs) {
  const wait = Number(timeoutMs);
  const limitMs = Number.isFinite(wait) && wait > 0 ? wait : MANIFEST_TIMEOUT_MS;
  let controller = null;
  try {
    controller = typeof AbortController === 'function' ? new AbortController() : null;
  } catch {
    controller = null;
  }
  const request = (async () => {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response) throw invalidManifest('响应为空');
    const status = Number(response.status);
    if (response.ok === false || (Number.isFinite(status) && (status < 200 || status >= 300))) {
      throw offlineManifest(`HTTP ${Number.isFinite(status) ? status : '错误'}`);
    }
    let body = null;
    if (typeof response.json === 'function') {
      try {
        body = await response.json();
      } catch {
        throw invalidManifest('不是合法 JSON');
      }
    } else if (typeof response.text === 'function') {
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw invalidManifest('不是合法 JSON');
      }
    } else {
      throw invalidManifest('响应体无法读取');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidManifest('不是 JSON 对象');
    return body;
  })();
  // 超时判负后请求仍可能失败：先挂一个兜底 handler，别变成未处理的 rejection。
  request.catch(() => {});
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch { /* 不支持 abort 的实现：忽略 */ }
      }
      reject(timeoutManifest());
    }, limitMs);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * 逐个尝试清单地址，第一份「能解析且带 versionCode」的清单直接采用，不再试后面的。
 * 永不 reject；status：
 *   'ok'          + remote/url/attempts
 *   'error'       + kind 'network'（一个都连不上）或 'manifest'（答话了但内容不对）
 *   'timeout'     + kind 'timeout'（全部超时）
 *   'unavailable' 没有地址或环境不支持请求
 * error 永远是能直接给用户看的中文，且带「已试 N 个地址」。
 */
export async function fetchManifest({ urls, fetchImpl, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  const list = manifestUrls(urls);
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!list.length) {
    return { status: 'unavailable', remote: null, kind: 'unavailable', attempts: 0, tried: [], error: '没有配置版本清单地址' };
  }
  if (!doFetch) {
    return { status: 'unavailable', remote: null, kind: 'unavailable', attempts: 0, tried: [], error: '当前环境不能发起网络请求' };
  }
  const tried = [];
  let badContent = '';
  let timeouts = 0;
  for (const url of list) {
    tried.push(url);
    try {
      const remote = await requestManifest(doFetch, url, timeoutMs);
      if (!hasVersionCode(remote)) throw invalidManifest('缺少 versionCode');
      return { status: 'ok', remote, url, attempts: tried.length, tried };
    } catch (error) {
      const name = error && error.name;
      if (name === 'ManifestTimeout') timeouts += 1;
      else if (name === 'ManifestInvalid') badContent = reasonOf(error) || '内容不对';
      // 其余（fetch 抛错 / HTTP 非 2xx）算这个地址不通，继续试下一个。
    }
  }
  const attempts = tried.length;
  const count = `（已试 ${attempts} 个地址）`;
  if (badContent) {
    return { status: 'error', remote: null, kind: 'manifest', attempts, tried, error: `版本清单内容不对：${badContent}${count}` };
  }
  if (timeouts === attempts) {
    return { status: 'timeout', remote: null, kind: 'timeout', attempts, tried, error: `检查超时，请确认网络后重试${count}` };
  }
  return { status: 'error', remote: null, kind: 'network', attempts, tried, error: `网络不通，无法检查更新${count}` };
}

/** web 层的检查更新：自己拉清单，返回与 checkForUpdate 同一套 status（字段语义不变）。 */
export async function checkForUpdateFromWeb({ bridge, local, urls, fetchImpl, timeoutMs } = {}) {
  const me = local && typeof local === 'object' ? local : localVersion(bridge);
  const found = await fetchManifest({ urls, fetchImpl, timeoutMs });
  if (found.status === 'ok') {
    const shared = { remote: found.remote, local: me, attempts: found.attempts, source: found.url };
    return isNewer(me.versionCode, found.remote.versionCode)
      ? { status: 'new', ...shared }
      : { status: 'latest', ...shared };
  }
  return {
    status: found.status,
    remote: null,
    local: me,
    error: found.error,
    kind: found.kind,
    attempts: found.attempts,
    tried: found.tried,
  };
}

/** 原生桥只给一句中文（老壳子）时，从文案里认失败类型，设置页才说得出人话。 */
function bridgeKind(remote, error) {
  const given = String((remote && remote.kind) || '').trim();
  if (FAILURE_KINDS.includes(given)) return given;
  const text = String(error || '');
  if (/超时|timeout/i.test(text)) return 'timeout';
  if (/网络|断网|无法连接|connect/i.test(text)) return 'network';
  if (/清单|manifest|versionCode|JSON/i.test(text)) return 'manifest';
  return '';
}

/**
 * 设置页要显示的那句话：网络不通 / 清单内容不对 / 超时分开说，不再一律「检查失败」。
 * 原生桥与 fetchManifest 给的 error 已是成品句（自带「已试 N 个地址」），原样返回；
 * 只有拿不到失败类型的老壳子才退回「检查失败：…」。
 */
export function updateErrorText(result) {
  const r = result && typeof result === 'object' ? result : {};
  const error = String(r.error || '').trim();
  const kind = String(r.kind || '');
  const attempts = Number(r.attempts);
  const count = Number.isFinite(attempts) && attempts > 0 ? `（已试 ${attempts} 个地址）` : '';
  if (kind === 'network') return error || `网络不通，无法检查更新${count}`;
  if (kind === 'manifest') return error || `版本清单内容不对${count}`;
  if (kind === 'timeout') return error || `检查超时，请确认网络后重试${count}`;
  return error ? `检查失败：${error}` : '检查失败：未知错误';
}

/**
 * 手动检查更新（设置页）：临时接管 window.__hmsUpdate 拿一次结果，用完立刻还原给今日页提示条。
 * status: 'unavailable' | 'new' | 'latest' | 'error' | 'timeout'；永不 reject。
 * 没有原生桥时走 web 层（传 fetchImpl 才启用，PWA 不会因此偷偷发请求）。
 */
export function checkForUpdate({ bridge, timeoutMs = 15000, fetchImpl, urls, manifestTimeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  const b = bridge || currentBridge();
  const local = localVersion(b);
  if (!b || typeof b.checkUpdate !== 'function') {
    if (typeof fetchImpl === 'function') {
      return checkForUpdateFromWeb({ bridge: b, local, urls, fetchImpl, timeoutMs: manifestTimeoutMs });
    }
    return Promise.resolve({ status: 'unavailable', remote: null, local });
  }
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
        if (remote.ok === false) {
          const error = String(remote.error || '检查失败');
          // 老壳子把「已是最新」当失败回传：清单读到了、只是没新版，这不是错误。
          if (LATEST_PREFIX.test(error)) { finish({ status: 'latest', remote, local }); return; }
          const kind = bridgeKind(remote, error);
          const attempts = Number(remote.attempts);
          finish({
            status: kind === 'timeout' ? 'timeout' : 'error',
            remote,
            local,
            error,
            kind,
            attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 0,
          });
          return;
        }
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
