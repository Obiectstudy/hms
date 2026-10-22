'use strict';

/**
 * HMS 云同步后端（腾讯云开发 CloudBase 云函数，Node.js CommonJS）。
 *
 * 分三层，边界刻意划清：
 *   1) 纯逻辑层 createHandler({ db, now, randomBytes, logger })：只依赖 db.query(sql, params)，
 *      不 require('pg')、不读 process.env、不碰网络 —— 本机用内存假数据库即可端到端测通。
 *   2) 云函数入口 main(event)：把 HTTP 访问服务的事件（path / httpMethod / body / headers）转成内部调用。
 *   3) 真实连接 openDatabase()：唯一 require('pg') 且唯一读 DATABASE_URL 的地方，只有显式调用才执行，
 *      所以 import 本模块时即使没有 pg、没有环境变量也不会崩。
 *
 * HTTP 协议是冻结的（客户端并行实现），字段一个都不能改，见 cloud/README.md。
 */

const nodeCrypto = require('node:crypto');

// ---------- 常量 ----------

/** 快照协议版本，与前端 js/sync.js 的 SNAPSHOT_VERSION 对齐。 */
const SNAPSHOT_VERSION = 1;
/** 会话有效期 30 天。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 连续失败达到这次数即锁定。 */
const LOCK_AFTER_FAILS = 10;
/** 锁定时长 15 分钟。 */
const LOCK_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
/** Base32 字符集去掉易混的 0 O 1 I 后剩 30 个字符。 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ234567';
const RECOVERY_LEN = 16;
const RECOVERY_GROUP = 4;
/** 请求体上限（HTTP 网关本身的上限更低，这里只是兜底）。 */
const MAX_BODY_BYTES = 9 * 1024 * 1024;
/** 单个快照上限。 */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const PG_UNIQUE_VIOLATION = '23505';
/** 用户不存在时也跑一次 scrypt，拉平「用户存在与否」的响应时间差。 */
const DUMMY_SALT = '00'.repeat(SALT_BYTES);
/** 未注册用户名与密码错误必须给出完全一样的文案，杜绝用户名枚举。 */
const AUTH_FAIL_MESSAGE = '用户名或密码不正确';
const RESET_FAIL_MESSAGE = '用户名或恢复码不正确';
const SESSION_FAIL_MESSAGE = '登录已失效，请重新登录';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const RECOVERY_NORMALIZED_RE = new RegExp('^[' + RECOVERY_ALPHABET + ']{' + RECOVERY_LEN + '}$');

// ---------- SQL（唯一真相：假数据库按这些语句的语义实现） ----------

const SQL = {
  insertUser:
    'INSERT INTO users (username, username_lower, pwd_hash, pwd_salt, recovery_hash, recovery_salt, fail_count, locked_until, created_at)' +
    '\n  VALUES ($1, $2, $3, $4, $5, $6, 0, NULL, $7)' +
    '\n  ON CONFLICT (username_lower) DO NOTHING' +
    '\n  RETURNING id',
  userByUsername: 'SELECT id, pwd_hash, pwd_salt, fail_count, locked_until FROM users WHERE username_lower = $1',
  userForReset: 'SELECT id, recovery_hash, recovery_salt FROM users WHERE username_lower = $1',
  bumpFail: 'UPDATE users SET fail_count = fail_count + 1 WHERE id = $1 RETURNING fail_count',
  lockUser: 'UPDATE users SET locked_until = $2, fail_count = 0 WHERE id = $1 RETURNING locked_until',
  clearFail: 'UPDATE users SET fail_count = 0, locked_until = NULL WHERE id = $1',
  setPassword: 'UPDATE users SET pwd_hash = $2, pwd_salt = $3, fail_count = 0, locked_until = NULL WHERE id = $1',
  insertSession: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
  sessionByToken: 'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1',
  deleteSessionsByUser: 'DELETE FROM sessions WHERE user_id = $1',
  snapshotByUser: 'SELECT rev, saved_at, payload FROM snapshots WHERE user_id = $1',
  snapshotRev: 'SELECT rev FROM snapshots WHERE user_id = $1',
  upsertSnapshot:
    'INSERT INTO snapshots (user_id, rev, saved_at, payload) VALUES ($1, $2, $3, $4::jsonb)' +
    '\n  ON CONFLICT (user_id) DO UPDATE' +
    '\n    SET rev = EXCLUDED.rev, saved_at = EXCLUDED.saved_at, payload = EXCLUDED.payload' +
    '\n    WHERE snapshots.rev = $5' +
    '\n  RETURNING rev',
};

// ---------- 基础工具 ----------

class HttpError extends Error {
  constructor(status, code, message, extraBody) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.body = extraBody || null;
  }
}

function badRequest(message) {
  return new HttpError(400, 'bad-request', message);
}
function unauthorized(message) {
  return new HttpError(401, 'unauthorized', message);
}
function notFound(message) {
  return new HttpError(404, 'not-found', message);
}
function locked(message) {
  return new HttpError(423, 'locked', message);
}
/** push 的 409 是协议里唯一不走统一错误体的响应：{ error: 'rev-conflict', rev }。 */
function revConflict(rev) {
  return new HttpError(409, 'conflict', '服务器版本已更新', { error: 'rev-conflict', rev: toInt(rev) });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
/** 把 pg 可能给的 Date / number / ISO 字符串统一成毫秒；无法识别返回 null。 */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
function firstRow(result) {
  const rows = Array.isArray(result) ? result : result && Array.isArray(result.rows) ? result.rows : [];
  return rows.length ? rows[0] : null;
}
function errorName(err) {
  if (err && typeof err.name === 'string' && err.name) return err.name;
  return typeof err;
}
/** pg 的错误码是 SQLSTATE；绝不打日志的 message（可能夹带参数值）。 */
function errorCode(err) {
  if (err && (typeof err.code === 'string' || typeof err.code === 'number')) return String(err.code);
  return undefined;
}
function sha256Hex(text) {
  return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------- 口令 / 恢复码 ----------

function scryptHash(secret, saltHex) {
  const salt = Buffer.from(String(saltHex), 'hex');
  return nodeCrypto
    .scryptSync(String(secret), salt, SCRYPT_KEYLEN, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p })
    .toString('hex');
}

/** 恒定时间比较；任何异常都当作「不匹配」，不往上抛。 */
function verifySecret(secret, saltHex, expectedHex) {
  if (typeof saltHex !== 'string' || typeof expectedHex !== 'string') return false;
  let actual;
  try {
    actual = Buffer.from(scryptHash(secret, saltHex), 'hex');
  } catch (err) {
    return false;
  }
  let expected;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch (err) {
    return false;
  }
  if (actual.length === 0 || actual.length !== expected.length) return false;
  return nodeCrypto.timingSafeEqual(actual, expected);
}

/** 用户不存在时也烧掉同等时间，避免用响应时间枚举用户名。 */
function burnTime(secret) {
  try {
    scryptHash(secret, DUMMY_SALT);
  } catch (err) {
    /* 计时掩护失败不影响正确性 */
  }
}

/** 4 组 × 4 字符，组间 '-'。拒绝采样保证 30 个字符等概率。 */
function generateRecoveryCode(randomBytes) {
  const limit = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  const chars = [];
  let guard = 0;
  while (chars.length < RECOVERY_LEN) {
    guard += 1;
    if (guard > 1000) throw new Error('随机源异常，无法生成恢复码');
    const buf = randomBytes(RECOVERY_LEN);
    for (let i = 0; i < buf.length && chars.length < RECOVERY_LEN; i += 1) {
      const byte = buf[i];
      if (byte >= limit) continue;
      chars.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
    }
  }
  return chars.join('').replace(new RegExp('(.{' + RECOVERY_GROUP + '})(?=.)', 'g'), '$1-');
}

/** 大写 + 去掉一切非字母数字：容忍用户用小写、带空格或漏了横线的输入。 */
function normalizeRecoveryCode(text) {
  return typeof text === 'string' ? text.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

// ---------- 输入校验（一律抛 HttpError(400)） ----------

function requireBodyObject(value) {
  if (!isRecord(value)) throw badRequest('请求体必须是 JSON 对象');
  return value;
}

function requireUsername(value) {
  if (typeof value !== 'string') throw badRequest('username 必须是字符串');
  const username = value.trim();
  if (!USERNAME_RE.test(username)) throw badRequest('username 需为 3-32 位字母、数字或下划线');
  return username;
}

function requirePassword(value, field) {
  const name = field || 'password';
  if (typeof value !== 'string') throw badRequest(name + ' 必须是字符串');
  if (value.length < PASSWORD_MIN) throw badRequest(name + ' 至少 ' + PASSWORD_MIN + ' 个字符');
  if (value.length > PASSWORD_MAX) throw badRequest(name + ' 过长');
  return value;
}

function requireRecoveryCode(value) {
  if (typeof value !== 'string') throw badRequest('recoveryCode 必须是字符串');
  if (value.length > 64) throw badRequest('recoveryCode 格式不正确');
  const normalized = normalizeRecoveryCode(value);
  if (!RECOVERY_NORMALIZED_RE.test(normalized)) throw badRequest('recoveryCode 格式不正确');
  return normalized;
}

function requireRev(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw badRequest('baseRev 必须是 0 或正整数');
  }
  return value;
}

function requirePayload(value) {
  if (!isRecord(value)) throw badRequest('payload 必须是 JSON 对象');
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw badRequest('payload 无法序列化');
  }
  if (typeof text !== 'string') throw badRequest('payload 无法序列化');
  if (text.length > MAX_PAYLOAD_BYTES) throw badRequest('payload 过大');
  return value;
}

// ---------- 会话 ----------

async function requireSession(db, now, token) {
  // 「无 token」按认证失败处理（401）；「给了但不是字符串」属于类型非法（400）。
  if (token === undefined || token === null || token === '') throw unauthorized(SESSION_FAIL_MESSAGE);
  if (typeof token !== 'string') throw badRequest('token 必须是字符串');
  if (token.length > 256) throw badRequest('token 长度非法');
  const row = firstRow(await db.query(SQL.sessionByToken, [sha256Hex(token)]));
  if (!row) throw unauthorized(SESSION_FAIL_MESSAGE);
  const expiresAt = toMs(row.expires_at);
  if (expiresAt === null || expiresAt <= now()) throw unauthorized(SESSION_FAIL_MESSAGE);
  return toInt(row.user_id);
}

// ---------- 五个接口 ----------

async function handleRegister(body, ctx) {
  const username = requireUsername(body.username);
  const password = requirePassword(body.password);
  const usernameLower = username.toLowerCase();

  const pwdSalt = ctx.randomBytes(SALT_BYTES).toString('hex');
  const pwdHash = scryptHash(password, pwdSalt);
  const recoveryCode = generateRecoveryCode(ctx.randomBytes);
  const recoverySalt = ctx.randomBytes(SALT_BYTES).toString('hex');
  const recoveryHash = scryptHash(normalizeRecoveryCode(recoveryCode), recoverySalt);

  let result;
  try {
    result = await ctx.db.query(SQL.insertUser, [
      username,
      usernameLower,
      pwdHash,
      pwdSalt,
      recoveryHash,
      recoverySalt,
      new Date(ctx.now()),
    ]);
  } catch (err) {
    if (errorCode(err) === PG_UNIQUE_VIOLATION) throw new HttpError(409, 'conflict', '用户名已被占用');
    throw err;
  }
  const row = firstRow(result);
  if (!row) throw new HttpError(409, 'conflict', '用户名已被占用'); // ON CONFLICT DO NOTHING 命中
  return { status: 200, body: { userId: toInt(row.id), recoveryCode } };
}

async function handleLogin(body, ctx) {
  const username = requireUsername(body.username);
  const password = requirePassword(body.password);
  const user = firstRow(await ctx.db.query(SQL.userByUsername, [username.toLowerCase()]));

  if (!user) {
    burnTime(password);
    throw unauthorized(AUTH_FAIL_MESSAGE);
  }
  const lockedUntil = toMs(user.locked_until);
  if (lockedUntil !== null && lockedUntil > ctx.now()) {
    throw locked('账号已被临时锁定，请稍后再试');
  }
  if (!verifySecret(password, user.pwd_salt, user.pwd_hash)) {
    const bumped = firstRow(await ctx.db.query(SQL.bumpFail, [toInt(user.id)]));
    const fails = bumped ? toInt(bumped.fail_count) : 0;
    // 第 10 次失败只是「触发锁定」，这一次仍按认证失败回 401；此后一律 423。
    if (fails >= LOCK_AFTER_FAILS) {
      await ctx.db.query(SQL.lockUser, [toInt(user.id), new Date(ctx.now() + LOCK_MS)]);
    }
    throw unauthorized(AUTH_FAIL_MESSAGE);
  }

  await ctx.db.query(SQL.clearFail, [toInt(user.id)]);
  const token = ctx.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = ctx.now();
  const expiresAt = issuedAt + SESSION_TTL_MS;
  // 库里只落 token 的 sha256，明文 token 只出现在这一次响应里。
  await ctx.db.query(SQL.insertSession, [sha256Hex(token), toInt(user.id), new Date(issuedAt), new Date(expiresAt)]);
  return { status: 200, body: { token, userId: toInt(user.id), expiresAt } };
}

async function handleReset(body, ctx) {
  const username = requireUsername(body.username);
  const recoveryCode = requireRecoveryCode(body.recoveryCode);
  const newPassword = requirePassword(body.newPassword, 'newPassword');

  const user = firstRow(await ctx.db.query(SQL.userForReset, [username.toLowerCase()]));
  if (!user) {
    burnTime(recoveryCode);
    throw unauthorized(RESET_FAIL_MESSAGE);
  }
  if (!verifySecret(recoveryCode, user.recovery_salt, user.recovery_hash)) {
    throw unauthorized(RESET_FAIL_MESSAGE);
  }

  const pwdSalt = ctx.randomBytes(SALT_BYTES).toString('hex');
  await ctx.db.query(SQL.setPassword, [toInt(user.id), scryptHash(newPassword, pwdSalt), pwdSalt]);
  // 改密码即踢掉所有旧会话（含忘记密码前的登录状态）。
  await ctx.db.query(SQL.deleteSessionsByUser, [toInt(user.id)]);
  // 恢复码不轮换：协议只允许返回 { ok: true }，没法把新码交给用户。
  return { status: 200, body: { ok: true } };
}

async function handlePull(body, ctx) {
  const userId = await requireSession(ctx.db, ctx.now, body.token);
  const row = firstRow(await ctx.db.query(SQL.snapshotByUser, [userId]));
  if (!row) return { status: 200, body: { rev: 0, savedAt: null, payload: null } };
  const savedAt = toMs(row.saved_at);
  return {
    status: 200,
    body: {
      rev: toInt(row.rev),
      savedAt: savedAt,
      payload: isRecord(row.payload) ? row.payload : null,
    },
  };
}

async function handlePush(body, ctx) {
  const userId = await requireSession(ctx.db, ctx.now, body.token);
  const baseRev = requireRev(body.baseRev);
  const payload = requirePayload(body.payload);

  const current = firstRow(await ctx.db.query(SQL.snapshotRev, [userId]));
  const currentRev = current ? toInt(current.rev) : 0;
  if (currentRev !== baseRev) throw revConflict(currentRev);

  const savedAt = ctx.now();
  // 真正的原子性由 ON CONFLICT ... DO UPDATE ... WHERE snapshots.rev = $5 保证。
  const result = await ctx.db.query(SQL.upsertSnapshot, [
    userId,
    baseRev + 1,
    new Date(savedAt),
    JSON.stringify(payload),
    baseRev,
  ]);
  const row = firstRow(result);
  if (!row) {
    const again = firstRow(await ctx.db.query(SQL.snapshotRev, [userId]));
    throw revConflict(again ? toInt(again.rev) : 0);
  }
  return { status: 200, body: { rev: toInt(row.rev) } };
}

// ---------- 路由 ----------

/** 取路径最后一段：网关配的前缀（/api、/hms-api…）怎么变都不影响路由。 */
function routeOf(event) {
  const raw = event.path || event.rawPath || (event.requestContext && event.requestContext.path) || event.route || '';
  const text = String(raw).split('?')[0];
  const parts = text.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

function readJsonBody(event) {
  let raw = event.body;
  if (raw === null || raw === undefined) throw badRequest('请求体不能为空');
  if (typeof raw === 'string' && event.isBase64Encoded === true) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return requireBodyObject(raw); // 网关已解析
  if (typeof raw !== 'string') throw badRequest('请求体必须是 JSON');
  if (raw.length > MAX_BODY_BYTES) throw badRequest('请求体过大');
  if (!raw.trim()) throw badRequest('请求体不能为空');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw badRequest('请求体不是合法 JSON');
  }
  return requireBodyObject(parsed);
}

async function dispatch(event, ctx) {
  const method = String(event.httpMethod || event.method || 'POST').toUpperCase();
  if (method !== 'POST') throw notFound('接口不存在（所有接口都只支持 POST）');
  const route = routeOf(event);
  const body = readJsonBody(event);
  switch (route) {
    case 'register':
      return handleRegister(body, ctx);
    case 'login':
      return handleLogin(body, ctx);
    case 'reset':
      return handleReset(body, ctx);
    case 'pull':
      return handlePull(body, ctx);
    case 'push':
      return handlePush(body, ctx);
    default:
      throw notFound('接口不存在');
  }
}

/**
 * 纯逻辑入口：给定最小 db 接口（query(sql, params)）、时钟、随机源与日志器，返回请求处理器。
 * 处理器永不抛异常：一切失败都变成 { statusCode, body }。
 */
function createHandler(options) {
  const opts = options || {};
  const db = opts.db;
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createHandler 需要 { db: { query(sql, params) } }');
  }
  const injectedNow = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : nodeCrypto.randomBytes;
  const logger = opts.logger && typeof opts.logger.log === 'function' ? opts.logger : null;
  const now = () => {
    const t = Number(injectedNow());
    return Number.isFinite(t) ? t : Date.now();
  };

  function log(record) {
    if (!logger) return;
    try {
      logger.log(JSON.stringify(Object.assign({ tag: 'hms-api', at: new Date(now()).toISOString() }, record)));
    } catch (err) {
      /* 日志失败绝不影响请求 */
    }
  }

  return async function handle(rawEvent) {
    const event = isRecord(rawEvent) ? rawEvent : {};
    const startedAt = now();
    const route = routeOf(event);
    let status;
    let body;
    try {
      const result = await dispatch(event, { db, now, randomBytes });
      status = result.status;
      body = result.body;
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        body = err.body || { error: err.code, message: err.message };
      } else {
        // 未预期异常：只记错误类别与 SQLSTATE，绝不回显 message（可能夹带参数值）
        log({ route, status: 500, error: 'server-error', name: errorName(err), sqlstate: errorCode(err) });
        status = 500;
        body = { error: 'server-error', message: '服务器内部错误，请稍后再试' };
      }
    }
    log({ route, status: status, ms: Math.max(0, now() - startedAt) });
    return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body), json: body };
  };
}

// ---------- 云函数入口与真实数据库连接 ----------

let poolSingleton = null;

/** 只从环境变量读连接串；不写文件、不进日志、不出现在任何返回值里。 */
function resolveDatabaseUrl(env) {
  const source = isRecord(env) ? env : process.env;
  const url = source ? source.DATABASE_URL : undefined;
  if (typeof url !== 'string' || !url.trim()) throw new Error('缺少 DATABASE_URL 环境变量');
  return url.trim();
}

/**
 * 连接配置：优先 DATABASE_URL（连接串），否则回落到 CloudBase 注入的 libpq 风格变量。
 * 官方「服务端直连」示例用的就是 process.env.PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE，
 * 所以两种都认；两者都没有才抛错。
 */
function resolveDatabaseConfig(env) {
  const source = isRecord(env) ? env : process.env;
  const url = source ? source.DATABASE_URL : undefined;
  if (typeof url === 'string' && url.trim()) return { connectionString: url.trim() };
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  const host = text(source && source.PGHOST);
  const user = text(source && source.PGUSER);
  const database = text(source && source.PGDATABASE);
  const password = source ? source.PGPASSWORD : undefined;
  if (host && user && database && typeof password === 'string') {
    const port = Number(source.PGPORT);
    return { host: host, port: port > 0 ? port : 5432, user: user, password: password, database: database };
  }
  throw new Error('缺少 DATABASE_URL 或 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 环境变量');
}

/** 真实连接唯一入口：延迟 require('pg')，没有依赖 / 没有环境变量时只在这里失败。 */
function openDatabase(options) {
  const opts = options || {};
  if (poolSingleton && !opts.fresh) return poolSingleton;
  const config = resolveDatabaseConfig(opts.env);
  let pg;
  try {
    pg = require('pg');
  } catch (err) {
    throw new Error('未安装 pg 依赖，请重新上传并勾选「云端安装依赖」');
  }
  const pool = new pg.Pool({
    ...config,
    max: Number(opts.max) > 0 ? Number(opts.max) : 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
  // 空闲连接被服务端掐断不应该让进程崩掉
  if (typeof pool.on === 'function') pool.on('error', () => {});
  poolSingleton = pool;
  return pool;
}

function jsonFail(status, code, message) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: code, message: message }) };
}

function safeLog(record) {
  try {
    console.log(JSON.stringify(record));
  } catch (err) {
    /* ignore */
  }
}

/** CloudBase HTTP 访问服务入口。事件：{ path, httpMethod, headers, body, isBase64Encoded }。 */
async function main(event) {
  let handler;
  try {
    handler = createHandler({ db: openDatabase(), logger: console });
  } catch (err) {
    safeLog({ tag: 'hms-api', status: 500, error: 'server-error', name: errorName(err), phase: 'connect' });
    return jsonFail(500, 'server-error', '服务端数据库未配置或不可用，请联系管理员');
  }
  try {
    const res = await handler(event || {});
    return { statusCode: res.statusCode, headers: res.headers, body: res.body };
  } catch (err) {
    safeLog({ tag: 'hms-api', status: 500, error: 'server-error', name: errorName(err), phase: 'handle' });
    return jsonFail(500, 'server-error', '服务器内部错误，请稍后再试');
  }
}

module.exports = {
  createHandler: createHandler,
  main: main,
  openDatabase: openDatabase,
  resolveDatabaseUrl: resolveDatabaseUrl,
  SQL: SQL,
  RECOVERY_ALPHABET: RECOVERY_ALPHABET,
  SNAPSHOT_VERSION: SNAPSHOT_VERSION,
  SESSION_TTL_MS: SESSION_TTL_MS,
  LOCK_AFTER_FAILS: LOCK_AFTER_FAILS,
  LOCK_MS: LOCK_MS,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  generateRecoveryCode: generateRecoveryCode,
  normalizeRecoveryCode: normalizeRecoveryCode,
  scryptHash: scryptHash,
  sha256Hex: sha256Hex,
};
