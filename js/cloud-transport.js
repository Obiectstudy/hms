/**
 * 云同步传输层（薄适配层）：网络请求只有一份实现，在 js/cloud-api.js。
 *
 * 这一层只剩三件事：入参校验、把 CloudApiError 折成界面要的结果、给错误码配中文。
 * URL 拼接、请求头、超时、响应解析都在 cloud-api.js，这里没有第二份。
 *
 * 所有方法一律 resolve，绝不抛给界面：
 *   成功 { ok: true, ...服务端字段 }；失败 { ok: false, error, message }（message 是给人看的中文）。
 * 错误体统一 { error, message }：后端给了中文就直接透传，没给就按 code 兜底一句。
 * 网络异常 / 超时 / 非 JSON 响应一律归一成 error:'network'。
 * push 遇到 409 返回 { ok: false, error: 'rev-conflict', rev }，rev 是服务器当前版本。
 */

import { createCloudApi } from './cloud-api.js';

// 上传/下载整库快照在弱网下可能要十几秒；15 秒是「用户还愿意等」的上限。
export const CLOUD_TIMEOUT_MS = 15000;

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

/** CloudApiError → 界面要的失败结果；错误码与中文文案的取舍只在这一层。 */
function fromApiError(err) {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const body = err && err.body;
  // 拿不到响应（fetch 自己抛了）：cloud-api 把原始异常留在 cause 上，超时靠它认出来。
  if (err && err.cause) {
    const name = err.cause.name ? String(err.cause.name) : '';
    return failure('network', name === 'TimeoutError' || name === 'AbortError' ? TIMEOUT : NETWORK);
  }
  // 非 JSON / 不是对象（cloud-api 记为 bad-response，body 为空）→ 界面只认 network。
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('network', '', { status });
  const error = trimmed(body.error) || 'server-error';
  const extra = { status };
  // 409：服务器把当前 rev 一起给了，界面要靠它说清「云端已经有更新」。
  if (Number.isInteger(body.rev) && body.rev >= 0) extra.rev = body.rev;
  return failure(error, body.message, extra);
}

/**
 * @param {{ baseUrl?: string, fetchImpl?: Function, timeoutMs?: number }} [options]
 * baseUrl 为空时每个方法都直接返回「未配置」，连 fetch 都不会被调用。
 */
export function createCloudTransport({ baseUrl = '', fetchImpl, timeoutMs = CLOUD_TIMEOUT_MS } = {}) {
  const root = trimmed(baseUrl).replace(/\/+$/, '');
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLOUD_TIMEOUT_MS;
  // 唯一真正发请求的对象：五个路径、请求头、超时、响应解析都在 cloud-api.js 里。
  const api = doFetch ? createCloudApi({ baseUrl: root, fetchImpl: doFetch, timeoutMs: waitMs }) : null;

  /** 唯一的出口：委托 cloud-api 的一个方法，把结果折成 { ok:true, ...data } 或 { ok:false, error, message }。 */
  async function delegate(send) {
    if (!root) return failure('bad-request', UNCONFIGURED);
    if (!api) return failure('network', '当前环境不支持网络请求');
    let data;
    try {
      data = await send(api);
    } catch (err) {
      return fromApiError(err);
    }
    if (trimmed(data.error)) return failure(trimmed(data.error), data.message);
    return { ok: true, ...data };
  }

  return {
    async register({ username, password } = {}) {
      if (!trimmed(username) || !trimmed(password)) {
        return failure('bad-request', '请填写用户名和密码');
      }
      return delegate((client) => client.register(trimmed(username), password));
    },
    async login({ username, password } = {}) {
      if (!trimmed(username) || !trimmed(password)) {
        return failure('bad-request', '请填写用户名和密码');
      }
      return delegate((client) => client.login(trimmed(username), password));
    },
    async reset({ username, recoveryCode, newPassword } = {}) {
      if (!trimmed(username) || !trimmed(recoveryCode) || !trimmed(newPassword)) {
        return failure('bad-request', '请填写用户名、恢复码和新密码');
      }
      return delegate((client) => client.reset(trimmed(username), trimmed(recoveryCode), newPassword));
    },
    async pull({ token } = {}) {
      if (!trimmed(token)) return failure('unauthorized', '还没登录：请先登录再同步');
      return delegate((client) => client.pull(token));
    },
    async push({ token, baseRev, payload } = {}) {
      if (!trimmed(token)) return failure('unauthorized', '还没登录：请先登录再同步');
      if (!payload || typeof payload !== 'object') {
        return failure('bad-request', '本机没有可上传的数据');
      }
      const rev = Number.isInteger(baseRev) && baseRev >= 0 ? baseRev : 0;
      return delegate((client) => client.push(token, rev, payload));
    },
  };
}
