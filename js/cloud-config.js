/**
 * 云同步的本机配置：网关地址 + 本机凭据（token / serverId / username）。
 *
 * 网关地址留空 = 整个云功能显示为「未配置」：界面只给说明，不发任何请求、不报错、不影响本地使用。
 * 部署完成后由调度者把下面这一行改成真实地址（例如 'https://sync.example.com'）。
 *
 * 凭据只落在 localStorage（token 属于设备本地凭据，不进 IndexedDB、不进导出的备份文件），
 * 按账号分键存放：hms.cloud.auth.<账号 id>。模块顶层零副作用，localStorage 被禁用时一律安全降级。
 */
import { CATALOG_KEY } from './accounts.js';

// 腾讯云开发 CloudBase 的 HTTP 访问服务地址。这个地址不是机密：它只是网关入口，
// 真正的鉴权发生在登录后的 token 上（服务端 API Key 只存在于云函数运行环境里，从不下发到浏览器）。
export const baseUrl = 'https://hms-d4gnh63iw73f09792.service.tcloudbase.com/api';

/** 本机凭据的键前缀：一个账号一份。 */
export const CLOUD_AUTH_PREFIX = 'hms.cloud.auth.';

// ---------- localStorage 安全读写 ----------

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Safari 隐私模式下连访问 localStorage 都会抛
  }
}

function readRaw(key) {
  try {
    const value = storage()?.getItem(key);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  try {
    const box = storage();
    if (!box) return false;
    if (value == null) box.removeItem(key);
    else box.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeExpiresAt(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? Math.floor(at) : null;
}

/** 网关地址非空才算配置好；空白字符一律按未配置处理。 */
export function isCloudConfigured(url = baseUrl) {
  return text(url).length > 0;
}

function authKey(accountId) {
  const id = text(accountId);
  return id ? `${CLOUD_AUTH_PREFIX}${id}` : '';
}

/** 本机凭据：脏数据/缺账号一律 null，绝不抛。没有 token 也可能是「已绑定但已退出登录」。 */
export function readCloudAuth(accountId) {
  const key = authKey(accountId);
  if (!key) return null;
  const raw = readRaw(key);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const auth = {
    serverId: text(parsed.serverId),
    username: text(parsed.username),
    token: text(parsed.token),
    expiresAt: normalizeExpiresAt(parsed.expiresAt),
    // 注册时拿到、但用户还没点「我已保存」的恢复码：先留在本机，切页也不会永久丢掉
    pendingRecoveryCode: text(parsed.pendingRecoveryCode),
  };
  if (!auth.serverId && !auth.username && !auth.token && !auth.pendingRecoveryCode) return null;
  return auth;
}

/** 部分更新：只传 token 时不会把 serverId / username 冲掉。写不进去返回 null。 */
export function writeCloudAuth(accountId, patch = {}) {
  const key = authKey(accountId);
  if (!key) return null;
  const current = readCloudAuth(accountId) ?? { serverId: '', username: '', token: '', expiresAt: null, pendingRecoveryCode: '' };
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = {
    serverId: src.serverId === undefined ? current.serverId : text(src.serverId),
    username: src.username === undefined ? current.username : text(src.username),
    token: src.token === undefined ? current.token : text(src.token),
    expiresAt: src.expiresAt === undefined ? current.expiresAt : normalizeExpiresAt(src.expiresAt),
    pendingRecoveryCode: src.pendingRecoveryCode === undefined
      ? current.pendingRecoveryCode
      : text(src.pendingRecoveryCode),
  };
  // 四项都空（例如恢复码确认完之后）就不留垃圾键
  const meaningful = next.serverId || next.username || next.token || next.pendingRecoveryCode;
  const ok = writeRaw(key, meaningful ? JSON.stringify(next) : null);
  return ok ? next : null;
}

/**
 * 退出登录：只清 token（本机数据与 serverId / username 都留着，界面还要显示「已绑定云端」）。
 * 没有任何账号信息可留时直接删键。返回是否真的写成功了。
 */
export function clearCloudToken(accountId) {
  const key = authKey(accountId);
  if (!key) return false;
  const current = readCloudAuth(accountId);
  if (!current) return false;
  if (!current.serverId && !current.username) return writeRaw(key, null);
  return writeRaw(key, JSON.stringify({ ...current, token: '', expiresAt: null }));
}

/**
 * 把云端 userId 写回账号目录（js/accounts.js 的 CATALOG_KEY）。
 * accounts.js 不在本次可改清单里，所以这里做一次最小改写：只给指定账号补一个 serverId 键，
 * 其余字段与顺序原样保留；accounts.js 的 normalizeAccount 本来就会读出 serverId。
 * 目录不存在 / 坏 JSON / 找不到账号 / 写不进去一律返回 false，绝不抛。
 */
export function bindAccountServerId(accountId, serverId) {
  const id = text(accountId);
  const value = text(serverId);
  if (!id || !value) return false;
  const raw = readRaw(CATALOG_KEY);
  if (!raw) return false;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(list)) return false;
  const index = list.findIndex((row) => row && typeof row === 'object' && text(row.id) === id);
  if (index < 0) return false;
  list[index] = { ...list[index], serverId: value };
  return writeRaw(CATALOG_KEY, JSON.stringify(list));
}
