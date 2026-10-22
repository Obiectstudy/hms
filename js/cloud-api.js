/**
 * 云同步客户端：把冻结的 HTTP 协议（cloud/README.md）封装成五个 Promise 函数。
 *
 * 设计约束：
 *   - 零依赖、不碰 localStorage / DOM：token 由调用方（app.js）自己保存，这里只做网络与错误翻译。
 *   - 所有请求都是 POST + JSON，路径固定 /register /login /reset /pull /push。
 *   - 服务器错误统一抛 CloudApiError，调用方可以按 code / status 分支（重登、重拉、退避重试）。
 *   - 与 js/sync.js 的分工：那个文件决定「该推还是该拉」，这个文件只负责「怎么发出去」。
 *     推拉冲突（409 rev-conflict）会带上服务器当前 rev，交给 sync.js 的 planSync 决策。
 */

export const CLOUD_API_PATHS = Object.freeze({
  register: '/register',
  login: '/login',
  reset: '/reset',
  pull: '/pull',
  push: '/push',
});

/** 服务端会话有效期 30 天，与后端 SESSION_TTL_MS 对齐。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_MESSAGES = {
  'bad-request': '请求参数不合法',
  unauthorized: '用户名或密码不正确',
  'not-found': '接口不存在',
  conflict: '请求冲突',
  locked: '账号已被临时锁定，请稍后再试',
  'server-error': '服务器开小差了，请稍后再试',
  'network-error': '网络不可用，请检查网络后重试',
  'bad-response': '服务器返回了无法解析的响应',
};

export class CloudApiError extends Error {
  constructor(info) {
    const data = info || {};
    super(data.message || DEFAULT_MESSAGES[data.code] || '请求失败');
    this.name = 'CloudApiError';
    this.code = data.code || 'server-error';
    this.status = typeof data.status === 'number' ? data.status : 0;
    this.body = data.body === undefined ? null : data.body;
    if (data.rev !== undefined) this.rev = data.rev;
  }

  get isAuthError() {
    return this.status === 401;
  }

  get isLocked() {
    return this.status === 423 || this.code === 'locked';
  }

  get isConflict() {
    return this.code === 'rev-conflict' || this.status === 409;
  }

  get isNetworkError() {
    return this.code === 'network-error';
  }
}

function normalizeBase(baseUrl) {
  const text = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return text.replace(/\/+$/, '');
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof fetch === 'function') return fetch.bind(null);
  throw new Error('当前环境没有 fetch，请在 createCloudApi 里注入 fetchImpl');
}

async function readText(res) {
  if (!res) return '';
  if (typeof res.text === 'function') {
    try {
      return await res.text();
    } catch (err) {
      return '';
    }
  }
  return '';
}

/**
 * @param {{ baseUrl?: string, fetchImpl?: Function, timeoutMs?: number }} [options]
 *   baseUrl 形如 https://<环境ID>.service.tcloudbase.com/api（HTTP 访问服务绑定的路径）。
 */
export function createCloudApi(options) {
  const opts = options || {};
  const root = normalizeBase(opts.baseUrl);
  const doFetch = resolveFetch(opts.fetchImpl);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000;

  async function call(path, payload) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await doFetch(root + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw new CloudApiError({
        code: 'network-error',
        message: DEFAULT_MESSAGES['network-error'],
        status: 0,
        body: null,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const text = await readText(res);
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        body = null;
      }
    }

    if (!res.ok) {
      const code = body && typeof body.error === 'string' ? body.error : 'server-error';
      throw new CloudApiError({
        code: code,
        message: body && typeof body.message === 'string' ? body.message : DEFAULT_MESSAGES[code] || '请求失败',
        status: typeof res.status === 'number' ? res.status : 0,
        body: body,
        rev: body ? body.rev : undefined,
      });
    }
    if (!body || typeof body !== 'object') {
      throw new CloudApiError({
        code: 'bad-response',
        message: DEFAULT_MESSAGES['bad-response'],
        status: res.status,
        body: null,
      });
    }
    return body;
  }

  return {
    baseUrl: root,
    /** POST /register → { userId, recoveryCode }（恢复码只在这里出现一次，务必让用户抄下来） */
    register(username, password) {
      return call(CLOUD_API_PATHS.register, { username: username, password: password });
    },
    /** POST /login → { token, userId, expiresAt }（毫秒时间戳） */
    login(username, password) {
      return call(CLOUD_API_PATHS.login, { username: username, password: password });
    },
    /** POST /reset → { ok: true }；成功会踢掉该账号所有旧会话 */
    reset(username, recoveryCode, newPassword) {
      return call(CLOUD_API_PATHS.reset, {
        username: username,
        recoveryCode: recoveryCode,
        newPassword: newPassword,
      });
    },
    /** POST /pull → { rev, savedAt, payload }；没有快照时是 { rev: 0, savedAt: null, payload: null } */
    pull(token) {
      return call(CLOUD_API_PATHS.pull, { token: token });
    },
    /** POST /push → { rev }；baseRev 过期会抛 CloudApiError(code='rev-conflict', rev=<服务器当前 rev>) */
    push(token, baseRev, payload) {
      return call(CLOUD_API_PATHS.push, { token: token, baseRev: baseRev, payload: payload });
    },
  };
}
