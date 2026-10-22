/**
 * 云同步传输层：只做「POST 一个 JSON → 解析成结果」，零依赖、零业务规则、零 DOM。
 *
 * 与后端冻结的协议一一对应（字段不许改）：
 *   POST {baseUrl}/register { username, password }               → { userId, recoveryCode }
 *   POST {baseUrl}/login    { username, password }               → { token, userId, expiresAt }
 *   POST {baseUrl}/reset    { username, recoveryCode, newPassword } → { ok: true }
 *   POST {baseUrl}/pull     { token }                            → { rev, savedAt, payload }
 *   POST {baseUrl}/push     { token, baseRev, payload }          → { rev } | 409 { error:'rev-conflict', rev }
 *
 * 所有方法一律 resolve，绝不抛给界面：
 *   成功 { ok: true, ...服务端字段 }；失败 { ok: false, error, message }（message 是给人看的中文）。
 * 错误体统一 { error, message }：后端给了中文就直接透传，没给就按 code 兜底一句。
 * 网络异常 / 超时 / 非 JSON 响应一律归一成 error:'network'。
 * push 遇到 409 返回 { ok: false, error: 'rev-conflict', rev }，rev 是服务器当前版本。
 */

// 上传/下载整库快照在弱网下可能要十几秒；15 秒是「用户还愿意等」的上限。
export const CLOUD_TIMEOUT_MS = 15000;

const ENDPOINTS = {
  register: '/register',
  login: '/login',
  reset: '/reset',
  pull: '/pull',
  push: '/push',
};

/** 后端返回的 code → 兜底中文（后端自带 message 时以它为准）。 */
const CODE_MESSAGES = {
  'bad-request': '请求参数不合法',
  unauthorized: '登录已失效，请重新登录',
  'not-found': '账号不存在，请检查用户名',
  forbidden: '没有权限执行这个操作',
  conflict: '数据冲突，请重试',
  locked: '账号已被锁定，请稍后再试',
  'server-error': '服务器出错了，请稍后再试',
};

const UNCONFIGURED = '云同步未配置：还没有填好网关地址';
const NETWORK = '网络不可用，请检查网络后重试';
const TIMEOUT = `请求超时（${Math.round(CLOUD_TIMEOUT_MS / 1000)} 秒），请检查网络后重试`;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageFor(error, message, status) {
  const text = trimmed(message);
  if (text) return text;
  const known = CODE_MESSAGES[trimmed(error)];
  if (known) return known;
  return status ? `服务器返回了 HTTP ${status}` : '云端返回了无法识别的结果';
}

function failure(error, message, extra) {
  return { ok: false, error, message: messageFor(error, message, extra?.status), ...(extra ?? {}) };
}

/** 超时信号：环境没有 AbortSignal.timeout（老浏览器）就不带，退化成「一直等」。 */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * @param {{ baseUrl?: string, fetchImpl?: Function }} [options]
 * baseUrl 为空时每个方法都直接返回「未配置」，连 fetch 都不会被调用。
 */
export function createCloudTransport({ baseUrl = '', fetchImpl, timeoutMs = CLOUD_TIMEOUT_MS } = {}) {
  const root = trimmed(baseUrl).replace(/\/+$/, '');
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLOUD_TIMEOUT_MS;

  /** 唯一的出口：把一次 POST 折成 { ok:true, ...data } 或 { ok:false, error, message }。 */
  async function post(endpoint, body) {
    if (!root) return failure('bad-request', UNCONFIGURED);
    if (!doFetch) return failure('network', '当前环境不支持网络请求');

    let response;
    try {
      response = await doFetch(`${root}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(waitMs),
      });
    } catch (error) {
      const name = error && error.name ? String(error.name) : '';
      return failure('network', name === 'TimeoutError' || name === 'AbortError' ? TIMEOUT : NETWORK);
    }

    const status = Number(response && response.status) || 0;
    let data = null;
    try {
      data = typeof response?.json === 'function' ? await response.json() : null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return failure('network', '', { status });
    }
    if (response.ok === false || (status && (status < 200 || status > 299))) {
      const error = trimmed(data.error) || 'server-error';
      const extra = { status };
      // 409：服务器把当前 rev 一起给了，界面要靠它说清「云端已经有更新」
      if (Number.isInteger(data.rev) && data.rev >= 0) extra.rev = data.rev;
      return failure(error, data.message, extra);
    }
    if (trimmed(data.error)) return failure(trimmed(data.error), data.message);
    return { ok: true, ...data };
  }

  return {
    async register({ username, password } = {}) {
      if (!trimmed(username) || !trimmed(password)) {
        return failure('bad-request', '请填写用户名和密码');
      }
      return post(ENDPOINTS.register, { username: trimmed(username), password });
    },
    async login({ username, password } = {}) {
      if (!trimmed(username) || !trimmed(password)) {
        return failure('bad-request', '请填写用户名和密码');
      }
      return post(ENDPOINTS.login, { username: trimmed(username), password });
    },
    async reset({ username, recoveryCode, newPassword } = {}) {
      if (!trimmed(username) || !trimmed(recoveryCode) || !trimmed(newPassword)) {
        return failure('bad-request', '请填写用户名、恢复码和新密码');
      }
      return post(ENDPOINTS.reset, {
        username: trimmed(username),
        recoveryCode: trimmed(recoveryCode),
        newPassword,
      });
    },
    async pull({ token } = {}) {
      if (!trimmed(token)) return failure('unauthorized', '还没登录：请先登录再同步');
      return post(ENDPOINTS.pull, { token });
    },
    async push({ token, baseRev, payload } = {}) {
      if (!trimmed(token)) return failure('unauthorized', '还没登录：请先登录再同步');
      if (!payload || typeof payload !== 'object') {
        return failure('bad-request', '本机没有可上传的数据');
      }
      const rev = Number.isInteger(baseRev) && baseRev >= 0 ? baseRev : 0;
      return post(ENDPOINTS.push, { token, baseRev: rev, payload });
    },
  };
}
