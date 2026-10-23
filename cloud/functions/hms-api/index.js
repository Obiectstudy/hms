'use strict';

/**
 * HMS 云同步后端（腾讯云开发 CloudBase 云函数，Node.js CommonJS）。
 *
 * 分三层，边界刻意划清：
 *   1) 纯逻辑层 createHandler({ db, now, randomBytes, logger })：只依赖 db.query(sql, params)，
 *      不 require('pg')、不读 process.env、不碰网络 —— 本机用内存假数据库即可端到端测通。
 *   2) 云函数入口 main(event)：把 HTTP 访问服务的事件（path / httpMethod / body / headers）转成内部调用。
 *   3) 真实数据库两条通道：
 *      - openDatabaseViaApi()：main 实际使用的通道，走云开发 SQL HTTP API（POST /v1/rdb/exec-pgsql），
 *        只认注入的 API Key + 环境 ID，不需要任何数据库网络地址 —— 共享集群下唯一可用。
 *      - openDatabase()：旧的 pg 直连，保留但 main 不再调用；它仍是唯一 require('pg') 的地方，
 *        所以本机没有 pg、没有环境变量时 import 本模块一切正常。
 *
 * HTTP 协议是冻结的（客户端并行实现），字段一个都不能改，见 cloud/README.md。
 */

const nodeCrypto = require('node:crypto');
// gunzipSync 是同步的：一次解压最多 8MiB（maxOutputLength 兜底），几十毫秒量级，不需要异步化。
const nodeZlib = require('node:zlib');

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
/** 压缩上传（{ __gz: '<base64(gzip(JSON))>' }）的标记键，与前端 js/sync.js 的 GZIP_MARKER_KEY 对齐。 */
const COMPRESSED_FIELD = '__gz';
/** 严格 base64 字符集：标准字母表 + 可选尾部 padding。 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
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

/**
 * CORS：真机 WebView 的页面 origin 是 https://appassets.androidplatform.net，而接口在
 * *.service.tcloudbase.com —— 跨域。平台侧没有任何可用的 CORS 开关（tcb cors add 在免费体验版报
 * [CreateAuthDomain] 当前套餐无法执行此操作），所以由函数自己发头。
 * 鉴权只走 authorization: Bearer，不用 cookie，因此反射 Origin 即可，不需要 allow-credentials。
 */
const CORS_ALLOW_METHODS = 'POST, OPTIONS';
const CORS_ALLOW_HEADERS = 'content-type, authorization';
const CORS_MAX_AGE = '86400';
/** 预检固定 204：网关只透传上游自定义头，状态码也由这里决定。 */
const PREFLIGHT_STATUS = 204;

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
/**
 * 「超限」是一类必须能被认出来的情况：网关对自己拦下的超限请求会自产 413，而那条响应**不带 CORS 头**
 * （网关改不了），真机 WebView 读不到它，只能显示「网络不可用」，用户没法自救。
 * 网关那一条我们碰不到，所以这里只做能做的两件事：
 *   - 响应体保持冻结协议不变（400 + bad-request +「payload 过大」/「请求体过大」），一个字段都不加；
 *   - 把「这是服务端判定的超限」挂到错误对象上，由 createHandler 记进日志（tooLarge + limit）。
 * 于是生产日志里能认出这一类：有 tooLarge 日志 = 服务端判定超限；客户端拿到不带 CORS 的 413
 * 而同一次请求在服务端没有任何日志 = 网关提前拦的（请求根本没到函数）。这是真实链路上唯一可做的区分。
 * 两个上限常量一个字都不改（线上不可达的死代码，见 README 第 15 节）。
 */
const TOO_LARGE_LOG_FIELD = 'tooLarge';
function payloadTooLarge(message, limit) {
  const err = badRequest(message);
  err.tooLarge = true;
  err.limit = toInt(limit);
  return err;
}
/** push 的 409 是协议里唯一不走统一错误体的响应：{ error: 'rev-conflict', rev }。 */
function revConflict(rev) {
  return new HttpError(409, 'conflict', '服务器版本已更新', { error: 'rev-conflict', rev: toInt(rev) });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/** 头名大小写不敏感：网关给的是 Origin 还是 origin 都要认；取不到返回空串。 */
function headerValue(headers, name) {
  if (!isRecord(headers)) return '';
  const want = String(name).toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() !== want) continue;
    const value = headers[keys[i]];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0].trim();
  }
  return '';
}
/** 反射请求的 Origin；请求没带 Origin（非浏览器调用、curl 手测）时回落到 *。 */
function resolveOrigin(event) {
  return headerValue(event && event.headers, 'origin') || '*';
}
/** 每个响应（含错误与预检）都要带的 CORS 头；vary: origin 保证中间缓存按 Origin 分开。 */
function corsHeaders(event) {
  return {
    'access-control-allow-origin': resolveOrigin(event),
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': CORS_MAX_AGE,
    vary: 'origin',
  };
}
/** 请求方法判定：预检与业务路由共用同一套兜底（httpMethod / method，缺省 POST）。 */
function methodOf(event) {
  return String((event && (event.httpMethod || event.method)) || 'POST').toUpperCase();
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
  if (text.length > MAX_PAYLOAD_BYTES) throw payloadTooLarge('payload 过大', MAX_PAYLOAD_BYTES);
  return value;
}

// ---------- payload 净化（jsonb 不接受 NUL 与落单代理项） ----------
//
// 现场：合法 JSON 里可以有 `\u0000`（NUL）与**落单代理项**（lone surrogate，如 `\ud800`），
// 但 PostgreSQL 的 jsonb 两者都不收：写库时报 22P05 unsupported Unicode escape sequence。
// 服务端过去只做结构与长度校验，随后就 `$4::jsonb` 直接写进去 —— 于是已登录用户只要本机
// 数据里混进一个这样的字符，push 就永远 500、rev 永不推进、客户端无限重试、快照永远传不上去。
//
// 修法：写库之前把这些字符从字符串里**删掉**（删成空串）。
//   - 不替换成「·」之类可见字符：那会污染用户数据，用户会看到自己从没输入过的内容。
//   - 合法字符一个都不动：emoji 是合法代理对（`\ud83d\ude00`）、中文、组合字符、换行与制表符全部原样保留。
//   - 对象 / 数组 / 字符串逐层处理，**键名也处理**。
//   - 遍历用显式栈而不是递归：4000 层嵌套也压不爆调用栈；循环引用与共享引用由 memo 表兜住。
//   - 没有深度上限：多深都要净化到，否则「深处的非法字符」照样能把 push 打回 500。
//   - 整份 payload 净化后变成空对象 {} 照常接受：用户数据就是这样，不是错误。

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function isHighSurrogateCode(code) {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}
function isLowSurrogateCode(code) {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * 删除字符串里的 U+0000 与落单代理项（每删掉一个码元算一处）。
 * 返回 { text, removed }：没有可删内容时 text 就是原字符串本身（引用相等，零改动）。
 */
function sanitizeText(text) {
  let removed = 0;
  let out = '';
  let copying = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    let keep = '';
    let width = 1;
    if (code === 0 || isLowSurrogateCode(code)) {
      removed += 1;
    } else if (isHighSurrogateCode(code)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (isLowSurrogateCode(next)) {
        keep = text.slice(i, i + 2); // 合法代理对（emoji 等）：原样保留
        width = 2;
      } else {
        removed += 1; // 落单的高代理项
      }
    } else {
      keep = text.charAt(i);
    }
    if (!copying && removed > 0) {
      out = text.slice(0, i); // 第一次遇到非法字符：先把前面的合法部分搬过来
      copying = true;
    }
    if (copying && keep) out += keep;
    i += width - 1;
  }
  return { text: copying ? out : text, removed: removed };
}

/** 只走数组与自己造出来的普通对象；Date、Buffer 之类非普通对象原样保留，不拆不丢。 */
function isWalkablePayloadNode(node) {
  if (Array.isArray(node)) return true;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}

/** 键名 __proto__ 走 defineProperty：JSON.parse 出来的对象带这个自有关键字是合法的，直接赋值会改掉原型。 */
function setOwnKey(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}

/**
 * 递归净化一个 JSON 值：字符串里的 NUL / 落单代理项删掉，对象与数组逐层复制，键名同样净化。
 * 返回 { value, removed }：removed 为 0 时 value 就是入参本身（一个字节都没动）。
 * 不抛异常：循环引用 / 共享引用都指向同一个副本，超深嵌套走显式栈（没有深度上限）。
 * 键名被删成空串的整条丢弃（原本就是空键名 "" 的合法情况保留）；两个键名净化后撞名时后写的胜出。
 */
function sanitizePayload(root) {
  if (typeof root === 'string') {
    const text = sanitizeText(root);
    return { value: text.text, removed: text.removed };
  }
  if (root === null || typeof root !== 'object' || !isWalkablePayloadNode(root)) {
    return { value: root, removed: 0 };
  }

  let removed = 0;
  const clones = new Map();
  const stack = [];
  const rootClone = Array.isArray(root) ? new Array(root.length) : {};
  clones.set(root, rootClone);
  stack.push({ src: root, dst: rootClone });

  const assign = (value, target, key) => {
    if (typeof value === 'string') {
      const text = sanitizeText(value);
      removed += text.removed;
      setOwnKey(target, key, text.text);
      return;
    }
    if (value !== null && typeof value === 'object' && isWalkablePayloadNode(value)) {
      let clone = clones.get(value);
      if (!clone) {
        clone = Array.isArray(value) ? new Array(value.length) : {};
        clones.set(value, clone);
        stack.push({ src: value, dst: clone });
      }
      setOwnKey(target, key, clone);
      return;
    }
    setOwnKey(target, key, value); // 数字 / 布尔 / null / 非普通对象（如 Date）原样带过去
  };

  while (stack.length > 0) {
    const frame = stack.pop();
    const src = frame.src;
    const dst = frame.dst;
    if (Array.isArray(src)) {
      for (let i = 0; i < src.length; i += 1) assign(src[i], dst, i);
      continue;
    }
    const keys = Object.keys(src);
    for (let k = 0; k < keys.length; k += 1) {
      const key = keys[k];
      const keyText = sanitizeText(key);
      removed += keyText.removed;
      // 键名里的非法字符被删光就没法表示了：整条丢弃（原本就是合法空键名 "" 的保留）
      if (keyText.text === '' && key !== '') continue;
      assign(src[key], dst, keyText.text);
    }
  }

  return { value: removed > 0 ? rootClone : root, removed: removed };
}

// ---------- 压缩上传载荷的解压（{ __gz } → 明文 JSON） ----------
//
// 现场：网关对请求体的上限约 100KB（实测 102400 字节，它自产的 413 不带 CORS 头，真机上只会显示
// 「网络不可用」）。客户端于是把大快照压成 { "__gz": "<base64(gzip(utf8(JSON)))>" } 再上传。
//
// 风险（实测，不是推测）：库里只要存着 { __gz }，**读得懂压缩体的就只有新客户端**。旧版 App
// （网页资源内嵌、不会自动更新）读到它不报错，反而把 { __gz } 当成普通数据 loadAll(replace)
// 写进本机业务表并推进 rev，之后回推就把这份垃圾当成云端快照传上来 —— 旧客户端没有任何自我保护。
//
// 修法：服务端在写库之前解压，库里永远只存**明文 JSON**。所有客户端（含旧版）pull 到的仍是普通
// 快照，行为与改动前完全一致：压缩只是「上传通道」的一种编码，不是存储格式。
//
// 安全（gzip 炸弹是真实威胁）：100KB 的请求体可以解出几十 GB。所以 gunzipSync **必须**给
// maxOutputLength（与快照上限同值 MAX_PAYLOAD_BYTES）—— 没有它，一次请求就能把函数内存打爆。
// 任何失败一律 400 bad-request + 中文（500 会让客户端无限重试），且绝不把内容写进日志。

/**
 * 严格 base64 解码：Buffer.from(s, 'base64') 对非法输入是**静默**的（'!!!' → 空 buffer，
 * 非法字符被直接丢掉），所以必须自己挡两道：
 *   - 正则挡非法字符，以及长度 % 4 == 1（1 个字符连一个字节都不够）；
 *   - 往返比对挡「非规范尾比特」（如 'AB==' 会被解成 0x00，但按标准它不该被接受）。
 * 非法一律 400：绝不把坏数据带进后续流程。
 */
function decodeBase64Strict(text) {
  const compact = text.replace(/[\r\n\t ]/g, '');
  if (!BASE64_RE.test(compact) || compact.length % 4 === 1) throw badRequest('payload.__gz 不是合法的 base64');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw badRequest('payload.__gz 不是合法的 base64');
  }
  return bytes;
}

/**
 * 解压压缩载荷；不是压缩体就返回 null（调用方按明文处理，零回归）。
 * 返回 { value, bytes }：value 是解出来的**对象**，bytes 是解压后的字节数（只进日志的元信息）。
 * 抛出的都是 HttpError(400)：base64 非法 / 不是 gzip / 超 maxOutputLength / 解出来不是合法 JSON 对象。
 */
function decompressPayload(payload) {
  const wrapped = payload[COMPRESSED_FIELD];
  // 只有「非空字符串」才算压缩体：空串 / 数字 / null / 对象一律按普通数据走 ——
  // 用户数据里恰好有个叫 __gz 的普通字段，不该把这次 push 打成 400。
  if (typeof wrapped !== 'string' || wrapped.length === 0) return null;

  const gzipped = decodeBase64Strict(wrapped);
  let inflated;
  try {
    // maxOutputLength 是这里唯一的内存防线：超了直接抛 ERR_BUFFER_TOO_LARGE，不会先把几十 GB 解出来
    inflated = nodeZlib.gunzipSync(gzipped, { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch (err) {
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw payloadTooLarge('payload.__gz 解压后过大', MAX_PAYLOAD_BYTES);
    // Z_DATA_ERROR（incorrect header check）/ Z_BUF_ERROR（数据被截断）等：都不是 gzip
    throw badRequest('payload.__gz 不是合法的 gzip 数据');
  }

  const bytes = inflated.length;
  let value;
  try {
    value = JSON.parse(inflated.toString('utf8'));
  } catch (err) {
    throw badRequest('payload.__gz 解压后不是合法 JSON');
  }
  if (!isRecord(value)) throw badRequest('payload.__gz 解压后必须是 JSON 对象');
  // 解压路径不许比明文路径宽松：同样要过「是对象 + 序列化后不超过 8MiB」
  requirePayload(value);
  return { value: value, bytes: bytes };
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
  const outer = requirePayload(body.payload);
  // 压缩上传（{ __gz }）在写库前解回明文：库里永远只存普通 JSON，旧客户端 pull 到的仍是老样子。
  // 不是压缩体时 inflated === null，payload 就是原对象，一个字节都不动（零回归）。
  const inflated = decompressPayload(outer);
  const payload = inflated ? inflated.value : outer;
  // 写库前净化：jsonb 不收 NUL 与落单代理项，直接写会让合法 JSON 变成永久 500（见 sanitizePayload）
  const cleaned = sanitizePayload(payload);

  const current = firstRow(await ctx.db.query(SQL.snapshotRev, [userId]));
  const currentRev = current ? toInt(current.rev) : 0;
  if (currentRev !== baseRev) throw revConflict(currentRev);

  const savedAt = ctx.now();
  // 真正的原子性由 ON CONFLICT ... DO UPDATE ... WHERE snapshots.rev = $5 保证。
  const result = await ctx.db.query(SQL.upsertSnapshot, [
    userId,
    baseRev + 1,
    new Date(savedAt),
    JSON.stringify(cleaned.value),
    baseRev,
  ]);
  const row = firstRow(result);
  if (!row) {
    const again = firstRow(await ctx.db.query(SQL.snapshotRev, [userId]));
    throw revConflict(again ? toInt(again.rev) : 0);
  }
  // sanitized 只用于日志计数（删了几处），decompressed 只用于日志记「解压后字节数」，两者都绝不带内容
  return {
    status: 200,
    body: { rev: toInt(row.rev) },
    sanitized: cleaned.removed,
    decompressed: inflated ? inflated.bytes : null,
  };
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
  if (raw.length > MAX_BODY_BYTES) throw payloadTooLarge('请求体过大', MAX_BODY_BYTES);
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
  if (methodOf(event) !== 'POST') throw notFound('接口不存在（所有接口都只支持 POST）');
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
    const cors = corsHeaders(event);
    const method = methodOf(event);
    // 预检短路：不读 body、不进 dispatch，所以不会被当成「非 POST 一律 404」的业务错误。
    if (method === 'OPTIONS') {
      log({ route, status: PREFLIGHT_STATUS, ms: Math.max(0, now() - startedAt) });
      return { statusCode: PREFLIGHT_STATUS, headers: cors, body: '' };
    }
    let status;
    let body;
    let sanitized = 0;
    let tooLargeLimit = null;
    let decompressedBytes = null;
    try {
      const result = await dispatch(event, { db, now, randomBytes });
      status = result.status;
      body = result.body;
      sanitized = toInt(result.sanitized);
      decompressedBytes = result.decompressed === null || result.decompressed === undefined
        ? null
        : toInt(result.decompressed);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        body = err.body || { error: err.code, message: err.message };
        if (err.tooLarge === true) tooLargeLimit = toInt(err.limit);
      } else {
        // 未预期异常：只记错误类别与 SQLSTATE，绝不回显 message（可能夹带参数值）
        log({ route, status: 500, error: 'server-error', name: errorName(err), sqlstate: errorCode(err) });
        status = 500;
        body = { error: 'server-error', message: '服务器内部错误，请稍后再试' };
      }
    }
    const record = { route: route, status: status, ms: Math.max(0, now() - startedAt) };
    // 净化只记「删了几处」，绝不记被删掉的内容（payload 是用户数据）
    if (sanitized > 0) record.sanitized = sanitized;
    // 压缩上传只记元信息：这次是不是压缩体、解压后多少字节 —— 绝不记 base64 原文或解压结果
    if (decompressedBytes !== null) {
      record.compressed = true;
      record.decompressedBytes = decompressedBytes;
    }
    // 超限类别也进日志：网关拦下的 413 不会有任何服务端日志，这一条就是区分的锚点
    if (tooLargeLimit !== null) {
      record[TOO_LARGE_LOG_FIELD] = true;
      record.limit = tooLargeLimit;
    }
    log(record);
    // 成功与失败一视同仁地带 CORS 头（JSON 主体与状态码不变）
    const headers = Object.assign({}, JSON_HEADERS, cors);
    return { statusCode: status, headers: headers, body: JSON.stringify(body), json: body };
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

// ---------- 云开发 SQL HTTP API 通道 ----------
//
// 依据（官方 OpenAPI，勿凭记忆改动）：
//   https://docs.cloudbase.net/openapi/pgdb.v1.openapi.yaml
//     servers: https://{envId}.api.tcloudbasegateway.com
//     POST /v1/rdb/exec-pgsql   body: { sql, parameters[], role }
//     200 → 行对象组成的 JSON 数组（DDL 为 []）
//     400 → { code, message, details, requestId }，code 形如 DATABASE_23505
//   https://docs.cloudbase.net/cloud-function/resource-integration/cloudbase
//     「API Key（推荐）：在函数环境变量中配置 CLOUDBASE_APIKEY」
// 共享集群没有任何数据库网络地址，pg 直连无路可走，只能走这条 API 通道。

const GATEWAY_HOST_SUFFIX = '.api.tcloudbasegateway.com';
const EXEC_PGSQL_PATH = '/v1/rdb/exec-pgsql';
/** 不传 role 默认落到只读角色，本后端的 INSERT/UPDATE/DELETE 会被 42501 拒掉，必须显式指定管理角色。 */
const EXEC_PGSQL_ADMIN_ROLE = 'cloudbase_postgres';
const API_TIMEOUT_MS = 15000;

/**
 * API Key 环境变量候选，按优先级排列。第一个是官方文档里写死的名字，其余只是兜底别名。
 * 永远不要反过来：别名是给历史环境擦屁股的，不是新部署的标准。
 */
const API_KEY_ENV_NAMES = ['CLOUDBASE_APIKEY', 'CLOUDBASE_API_KEY', 'TCB_API_KEY', 'API_KEY'];
/** 环境 ID 候选：CLOUDBASE_ENV_ID 是配套变量，TCB_ENV 是云函数运行时注入的环境 ID。 */
const ENV_ID_ENV_NAMES = ['CLOUDBASE_ENV_ID', 'TCB_ENV', 'TENCENTCLOUD_TCB_ENVID', 'TCB_ENV_ID'];
/** 环境 ID 只允许小写字母、数字与连字符，防止环境变量里塞进完整的 URL 把请求带去别处。 */
const ENV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** 只有「SQL 与结构级」错误的上游 message 才是我们自己的 SQL，可以带出来排查。 */
const GATEWAY_ECHOABLE_CODES = ['INVALID_PARAM', 'DATABASE_42601', 'DATABASE_42P01'];

function pickEnvValue(source, names) {
  for (let i = 0; i < names.length; i += 1) {
    const value = source ? source[names[i]] : undefined;
    if (typeof value === 'string' && value.trim()) return { name: names[i], value: value.trim() };
  }
  return null;
}

/** 只从环境变量取凭证；绝不写文件、不进日志、不出现在任何返回值里。 */
function resolveGatewayConfig(env) {
  const source = isRecord(env) ? env : process.env;
  const key = pickEnvValue(source, API_KEY_ENV_NAMES);
  const envId = pickEnvValue(source, ENV_ID_ENV_NAMES);
  const missing = [];
  if (!key) missing.push(API_KEY_ENV_NAMES[0]);
  if (!envId) missing.push(ENV_ID_ENV_NAMES[0]);
  if (missing.length) {
    throw new Error('缺少云开发环境变量 ' + missing.join(' 与 ') + '，请在云函数「环境变量」里配置后重新部署');
  }
  if (!ENV_ID_RE.test(envId.value)) {
    throw new Error('环境变量 ' + envId.name + ' 不是合法的环境 ID');
  }
  return {
    endpoint: 'https://' + envId.value + GATEWAY_HOST_SUFFIX + EXEC_PGSQL_PATH,
    apiKey: key.value,
    keyEnvName: key.name,
    envIdEnvName: envId.name,
  };
}

/**
 * pg 的 $n 参数可以是 Date 或对象，网关的 parameters 只接受 string|number|boolean|null：
 * Date 转 ISO 字符串（timestamptz 认这个格式），对象与数组转 JSON 文本（配合 SQL 里的 ::jsonb）。
 */
function normalizeParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  return JSON.stringify(value);
}

function normalizeParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map(normalizeParam);
}

/** 网关错误码是 `DATABASE_<SQLSTATE>`，业务层按 pg 的 SQLSTATE 判定（如 23505 唯一冲突）。 */
function sqlStateOf(code) {
  if (typeof code !== 'string' || !code) return 'UNKNOWN';
  return /^DATABASE_[0-9A-Z]{5}$/.test(code) ? code.slice('DATABASE_'.length) : code;
}

function gatewayFailure(status, code, message) {
  const err = new Error(message);
  err.name = 'GatewayError';
  err.code = sqlStateOf(code);
  err.status = toInt(status);
  return err;
}

/**
 * 数据级错误（如 23505 唯一冲突）的上游 message / details 可能夹带触发冲突的用户输入，
 * 一律不回显；响应里只留状态码、SQLSTATE 与 requestId。
 */
function describeGatewayFailure(status, code, payload) {
  const parts = ['云开发 SQL 接口失败', 'HTTP ' + toInt(status), 'code=' + sqlStateOf(code)];
  const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
  if (requestId) parts.push('requestId=' + requestId);
  if (GATEWAY_ECHOABLE_CODES.indexOf(code) !== -1 && payload && typeof payload.message === 'string') {
    parts.push('message=' + payload.message);
  }
  return parts.join(' ');
}

/** 请求自带超时：即使 fetch 实现不认 AbortSignal，也一定会按时抛错而不是挂死。 */
function fetchWithTimeout(fetchImpl, url, init, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(gatewayFailure(0, 'TIMEOUT', '云开发 SQL 接口超时'));
    }, timeoutMs);
    const settle = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    try {
      fetchImpl(url, init).then(settle(resolve), settle(reject));
    } catch (err) {
      settle(reject)(err);
    }
  });
}

/**
 * 云开发 API 通道的 db 接口：与 pg 的 db.query(sql, params) 完全同形 ——
 * 成功返回行对象数组（网关就是裸数组），失败抛出的错误带 pg 风格的 SQLSTATE 放在 err.code。
 */
function createApiDatabase(options) {
  const opts = options || {};
  const config = opts.config || resolveGatewayConfig(opts.env);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('运行环境没有 fetch，无法调用云开发 SQL 接口');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : API_TIMEOUT_MS;

  return {
    query: async function query(sql, params) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let res;
      try {
        res = await fetchWithTimeout(
          fetchImpl,
          config.endpoint,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + config.apiKey,
            },
            body: JSON.stringify({
              sql: String(sql),
              parameters: normalizeParams(params),
              role: EXEC_PGSQL_ADMIN_ROLE,
            }),
            signal: controller ? controller.signal : undefined,
          },
          timeoutMs,
          () => {
            if (controller) controller.abort();
          }
        );
      } catch (err) {
        if (err && err.name === 'GatewayError') throw err;
        throw gatewayFailure(0, 'NETWORK', '云开发 SQL 接口网络请求失败');
      }

      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        throw gatewayFailure(res && res.status, 'BODY_READ_FAILED', '云开发 SQL 接口响应读取失败');
      }
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (err) {
          payload = null;
        }
      }
      const status = toInt(res && res.status);
      const ok = (res && res.ok === true) || (status >= 200 && status < 300);
      if (!ok) {
        const code = payload && typeof payload.code === 'string' ? payload.code : 'HTTP_' + status;
        throw gatewayFailure(status, code, describeGatewayFailure(status, code, payload));
      }
      if (!Array.isArray(payload)) {
        throw gatewayFailure(status, 'MALFORMED', '云开发 SQL 接口返回的不是行数组');
      }
      return payload;
    },
  };
}

/** main 实际使用的通道入口：与 openDatabase() 同形，但不需要任何数据库网络地址。 */
function openDatabaseViaApi(options) {
  return createApiDatabase(options);
}

function jsonFail(status, code, message, event) {
  return {
    statusCode: status,
    headers: Object.assign({}, JSON_HEADERS, corsHeaders(event)),
    body: JSON.stringify({ error: code, message: message }),
  };
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
  const safeEvent = isRecord(event) ? event : {};
  // 预检必须在连数据库之前短路：env 没配 / 数据库不可用时，预检失败会让真机连"网络不可用"都分不清。
  if (methodOf(safeEvent) === 'OPTIONS') {
    return { statusCode: PREFLIGHT_STATUS, headers: corsHeaders(safeEvent), body: '' };
  }
  let handler;
  try {
    handler = createHandler({ db: openDatabaseViaApi(), logger: console });
  } catch (err) {
    safeLog({ tag: 'hms-api', status: 500, error: 'server-error', name: errorName(err), phase: 'connect' });
    return jsonFail(500, 'server-error', '服务端数据库未配置或不可用，请联系管理员', safeEvent);
  }
  try {
    const res = await handler(safeEvent);
    return { statusCode: res.statusCode, headers: res.headers, body: res.body };
  } catch (err) {
    safeLog({ tag: 'hms-api', status: 500, error: 'server-error', name: errorName(err), phase: 'handle' });
    return jsonFail(500, 'server-error', '服务器内部错误，请稍后再试', safeEvent);
  }
}

module.exports = {
  createHandler: createHandler,
  main: main,
  openDatabase: openDatabase,
  openDatabaseViaApi: openDatabaseViaApi,
  createApiDatabase: createApiDatabase,
  resolveGatewayConfig: resolveGatewayConfig,
  resolveDatabaseUrl: resolveDatabaseUrl,
  normalizeParams: normalizeParams,
  corsHeaders: corsHeaders,
  resolveOrigin: resolveOrigin,
  sqlStateOf: sqlStateOf,
  API_KEY_ENV_NAMES: API_KEY_ENV_NAMES,
  ENV_ID_ENV_NAMES: ENV_ID_ENV_NAMES,
  EXEC_PGSQL_PATH: EXEC_PGSQL_PATH,
  SQL: SQL,
  RECOVERY_ALPHABET: RECOVERY_ALPHABET,
  SNAPSHOT_VERSION: SNAPSHOT_VERSION,
  SESSION_TTL_MS: SESSION_TTL_MS,
  LOCK_AFTER_FAILS: LOCK_AFTER_FAILS,
  LOCK_MS: LOCK_MS,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  TOO_LARGE_LOG_FIELD: TOO_LARGE_LOG_FIELD,
  COMPRESSED_FIELD: COMPRESSED_FIELD,
  sanitizePayload: sanitizePayload,
  decompressPayload: decompressPayload,
  sanitizeText: sanitizeText,
  generateRecoveryCode: generateRecoveryCode,
  normalizeRecoveryCode: normalizeRecoveryCode,
  scryptHash: scryptHash,
  sha256Hex: sha256Hex,
};
