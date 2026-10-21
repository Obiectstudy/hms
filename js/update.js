// 应用内更新提示条（SPEC §5.7 / §7 今日页顶部）。
// 只在内置 HmsBridge 的 APK 里生效：PWA 没有桥，initUpdateBanner 直接返回 null，不请求、不渲染。
// 约束：模块顶层不触碰 window / document / localStorage，Node 里可以直接 import。

import { el, toast } from './ui.js';

/** 「稍后」记下的 versionCode 存这个键；换新版（code 更大）会再次提示。 */
export const DISMISS_KEY = 'hms.update.dismissed';

const INSTALL_TEXT = '立即更新';

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

function versionLabel(info) {
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
      if (typeof onInstall === 'function') onInstall(info);
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

function readDismissed() {
  const box = storage();
  if (!box) return 0;
  try {
    const code = Number(box.getItem(DISMISS_KEY));
    return Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

function writeDismissed(code) {
  const box = storage();
  if (!box) return;
  try {
    box.setItem(DISMISS_KEY, String(code));
  } catch {
    /* 隐私模式下写不进去：下次仍会提示，不是错误。 */
  }
}

function safeRead(readCode) {
  try {
    const code = Number(readCode());
    return Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

function installedVersionCode(bridge) {
  try {
    const info = parseBridgeJson(typeof bridge.version === 'function' ? bridge.version() : null);
    const code = info ? Number(info.versionCode) : NaN;
    return Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
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
  const saveCode = typeof setDismissed === 'function' ? setDismissed : writeDismissed;
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
          // 原生侧自己会解析 JSON：传字符串比传对象更稳妥。
          onInstall: (payload) => { bridge.installUpdate(JSON.stringify(payload)); },
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
