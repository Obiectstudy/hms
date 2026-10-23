/**
 * HMS 云同步后端 · 健壮性对抗测试（只找不改）
 *
 * 目标：https://<环境ID>.service.tcloudbase.com/api（5 个接口，协议见 cloud/README.md）
 *
 * 铁律：
 *   - 默认不联网：只有 HMS_FUZZ_API=1 时才真的发请求（干跑只打印计划）。
 *   - 硬上限 MAX_REQUESTS 次 HTTP 请求（含所有重试），超预算立即抛错终止。
 *   - 并发不超过 CONCURRENCY_LIMIT；不循环轰炸、不做负载压测。
 *   - 只创建 fuzz_ 前缀的测试账号（外加 1 个 3 字符长度边界账号 fz3），跑完由 CLEANUP_SQL 删除。
 *   - 只读被测代码，绝不修改任何生产文件。
 *
 * 用法：
 *   node tests/fuzz.api.mjs                 # 干跑：不联网，只列出计划
 *   $env:HMS_FUZZ_API='1'; node tests/fuzz.api.mjs
 *   $env:HMS_FUZZ_API='1'; $env:HMS_FUZZ_CEILING_TARGETS='102400,102401'; node tests/fuzz.api.mjs --ceiling
 *                                           # 独立入口：只探测网关请求体上限（目标走 env；二分用 HMS_FUZZ_CEILING_BISECT='lo,hi'）
 *
 * 清理（tcb db execute 一次只跑一条语句）：
 *   见 CLEANUP_SQL
 */

import nodeCrypto from 'node:crypto';

// ---------- 常量（全部写死，便于复核） ----------

export const MAX_REQUESTS = 200;
export const CONCURRENCY_LIMIT = 5;
export const DEFAULT_BASE = 'https://hms-d4gnh63iw73f09792.service.tcloudbase.com/api';
/** 与 cloud/functions/hms-api/index.js 对齐：单快照上限 8MiB、请求体上限 9MB。 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_BODY_BYTES = 9 * 1024 * 1024;
const TEST_PREFIX = 'fuzz_';
/** 3 字符用户名长度边界账号（无 fuzz_ 前缀，清理时按精确名字删）。 */
const BOUNDARY_USERNAMS = ['fz3'];
const RECOVERY_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export const CLEANUP_SQL = [
  "DELETE FROM users WHERE username_lower LIKE 'fuzz_%'",
  "DELETE FROM users WHERE username_lower IN ('fz3')",
  'SELECT count(*) AS users_after FROM users',
];

export const PLAN = [
  ['cors', 'OPTIONS 预检 / 错误响应 / 反射 Origin', 5],
  ['method', 'GET/PUT/DELETE 与非 POST 方法、路由大小写、空 body', 5],
  ['body', '畸形请求体：非 JSON / 数组 / 字符串 / 数字 / null / 空 / 非 json content-type', 8],
  ['register', 'username 2/3/32/33/中文/空白/非字符串；password 7/8/200/201/100000/非字符串；重名 409', 18],
  ['token', '无 token / null / 非字符串 / 257 字符 / 256 字符 / 假 token / 真 token', 9],
  ['push-valid', 'baseRev 字符串/负数/小数/1e309/越界/布尔；payload 非对象；1KB/1MB/接近上限', 16],
  ['payload-fault', 'payload 含 NUL / 落单代理项 / 4000 层嵌套 / 多字节超字节上限；写后一致性复核', 6],
  ['race', '2 并发同 baseRev（原子性）、3 并发、跨账号隔离、并发注册重名', 7],
  ['lockout', '专用账号连续失败 10 次 → 第 11 次 423；锁定期间正确口令仍 423', 12],
  ['enum+reset', '用户名枚举逐字节比对；reset 错误/畸形恢复码；重置后旧 token 失效、旧口令失效', 9],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 上下文 ----------

function createContext(baseUrl) {
  return {
    baseUrl,
    requestsUsed: 0,
    passed: 0,
    failed: 0,
    failures: [],
    findings: [],
    notes: [],
    log: [],
    leakScan: [],
    accounts: {},
    rev: 0,
    connections: [],
  };
}

class BudgetError extends Error {}

function clip(text, n = 300) {
  const t = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  return t.length > n ? t.slice(0, n) + '…(+' + (t.length - n) + ' chars)' : t;
}
function redact(text) {
  return String(text).replace(/\b[0-9a-f]{64}\b/g, '$TOKEN');
}
function byteLen(text) {
  return Buffer.byteLength(String(text), 'utf8');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function sha256Hex(text) {
  return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------- 请求 ----------

const CORS_KEYS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'vary',
  'content-type',
];

async function send(ctx, spec) {
  const label = spec.label;
  if (ctx.requestsUsed >= MAX_REQUESTS) throw new BudgetError('请求预算用尽：' + MAX_REQUESTS);
  ctx.requestsUsed += 1;
  const url = ctx.baseUrl + spec.path;
  const headers = Object.assign({}, spec.headers);
  const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (spec.body !== undefined && !hasCT) headers['content-type'] = 'application/json';
  if (spec.origin) headers.origin = spec.origin;
  const method = spec.method || 'POST';
  const timeoutMs = spec.timeoutMs || 45000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();
  let res = null;
  let text = '';
  let netErr = null;
  try {
    const init = { method, headers };
    if (spec.body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = spec.body;
    if (controller) init.signal = controller.signal;
    res = await fetch(url, init);
    text = await res.text();
  } catch (err) {
    netErr = String((err && err.message) || err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const cors = {};
  if (res) {
    for (const k of CORS_KEYS) {
      const v = res.headers.get(k);
      if (v !== null) cors[k] = v;
    }
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = null;
    }
  }
  const entry = {
    label,
    url,
    method,
    headers,
    body: typeof spec.body === 'string' ? spec.body : '',
    status: res ? res.status : 0,
    cors,
    text,
    json,
    netErr,
    ms: Date.now() - startedAt,
    bodyChars: typeof spec.body === 'string' ? spec.body.length : 0,
    bodyBytes: typeof spec.body === 'string' ? byteLen(spec.body) : 0,
  };
  ctx.log.push({
    label,
    method,
    path: spec.path,
    status: entry.status,
    ms: entry.ms,
    reqChars: entry.bodyChars,
    netErr,
  });
  // 泄漏扫描样本（只留前 200KB，足够覆盖敏感串）
  if (text) ctx.leakScan.push({ label, text: text.length > 200000 ? text.slice(0, 200000) : text });
  return entry;
}

function toCurl(entry, opts) {
  const o = opts || {};
  const parts = ['curl.exe -s -i -X ' + entry.method + ' ' + JSON.stringify(entry.url)];
  for (const [k, v] of Object.entries(entry.headers || {})) {
    parts.push('-H ' + JSON.stringify(k + ': ' + redact(clip(v, 200))));
  }
  const body = entry.body || '';
  if (body) {
    if (body.length <= 800 && o.inline !== false) parts.push('-d ' + JSON.stringify(redact(body)));
    else parts.push('--data-binary @<由 tests/fuzz.api.mjs 的 ' + (o.builder || 'buildPayload*') + '() 生成的请求体>');
  }
  return redact(parts.join(' \\' + '\n  '));
}

function toReproCode(entry, builderNote) {
  const headers = {};
  for (const [k, v] of Object.entries(entry.headers || {})) headers[k] = redact(v);
  const bodyExpr =
    entry.body && entry.body.length <= 800
      ? JSON.stringify(redact(entry.body))
      : '<由 tests/fuzz.api.mjs 导出的 ' + (builderNote || 'buildPayload*') + '() 生成>';
  return (
    'node -e "fetch(' +
    JSON.stringify(entry.url) +
    ',{method:' +
    JSON.stringify(entry.method) +
    ',headers:' +
    JSON.stringify(headers) +
    ',body:' +
    bodyExpr +
    '}).then(async r=>console.log(r.status, await r.text()))"'
  );
}

// ---------- 断言 ----------

function ok(ctx, name, condition, got, expected) {
  if (condition) {
    ctx.passed += 1;
    return true;
  }
  ctx.failed += 1;
  ctx.failures.push({ name, got: clip(typeof got === 'string' ? got : JSON.stringify(got), 400), expected: String(expected) });
  return false;
}

function expectStatus(ctx, entry, want, name) {
  const got = 'HTTP ' + entry.status + (entry.netErr ? ' netErr=' + entry.netErr : '') + ' body=' + clip(entry.text, 160);
  return ok(ctx, name, entry.status === want, got, 'HTTP ' + want);
}

function expectBodyField(ctx, entry, field, want, name) {
  const got = entry.json && typeof entry.json === 'object' ? entry.json[field] : undefined;
  return ok(ctx, name, got === want, 'HTTP ' + entry.status + ' ' + field + '=' + JSON.stringify(got), field + '=' + JSON.stringify(want));
}

function expectCors(ctx, entry, name, origin) {
  const acao = entry.cors['access-control-allow-origin'];
  const methods = entry.cors['access-control-allow-methods'] || '';
  const wantOrigin = origin || '*';
  const problems = [];
  if (acao !== wantOrigin) problems.push('allow-origin=' + JSON.stringify(acao) + ' 期望 ' + JSON.stringify(wantOrigin));
  if (!/post/i.test(methods) || !/options/i.test(methods)) problems.push('allow-methods=' + JSON.stringify(methods));
  if (!/content-type/i.test(entry.cors['access-control-allow-headers'] || '')) problems.push('allow-headers=' + JSON.stringify(entry.cors['access-control-allow-headers']));
  if (!/origin/i.test(entry.cors.vary || '')) problems.push('vary=' + JSON.stringify(entry.cors.vary));
  return ok(ctx, name, problems.length === 0, 'HTTP ' + entry.status + ' ' + JSON.stringify(entry.cors), '带 acao=' + wantOrigin + ' / allow-methods / allow-headers / vary: origin');
}

// ---------- 网关请求体上限：已记录的设计契约（不是服务端缺陷） ----------

/**
 * 事实（已用 --ceiling 入口二分钉死）：POST /api/push 的真实请求体上限由网关决定 = 102400 字节。
 *   102400 字节 → 200；102401 字节 → 413 EXCEED_MAX_PAYLOAD_SIZE；413 响应不带任何 access-control-* 头。
 * 网关先于云函数拦截：函数根本没被调用，所以服务端 MAX_PAYLOAD_BYTES=8388608 / MAX_BODY_BYTES=9437184
 * 这两个常量在真实链路上不可达 —— 这不是服务端缺陷（服务端无从修起；平台侧也改不了：tcb cors add 受
 * 套餐限制、网关行为不可配置）。
 *
 * 已实现的设计对策：客户端 PUSH_BODY_LIMIT_BYTES=100000 前置拦截 + gzip 压缩上传。
 *   - 阈值来源：js/cloud-api.js（GATEWAY_MAX_REQUEST_BYTES=102400）→ js/sync.js（PUSH_BODY_LIMIT_BYTES=100000，
 *     给 token 与包装留 2400 字节余量）；
 *   - 超限时直接返回 payload-too-large、一个请求都不发：js/cloud-transport.js；
 *   - 压缩把有效上限提到约 610KB~1.4MB（取决于压缩率）；
 *   - 守门断言在 tests/logic.test.mjs：「sync/压缩: 导出契约完整，安全阈值 = 网关硬上限 − 2400 字节余量」、
 *     「传输层: push 收到超限载荷 → 中文失败且零请求；小载荷不受影响」（断言「超限时一个请求都不许发」）。
 *
 * fuzz 这边的策略：探测照发（证明网关边界仍在），但断言的是「网关当前行为」——期望 413 +
 * EXCEED_MAX_PAYLOAD_SIZE + 不含 access-control-*，命中即用 note 记录契约、不再报 finding；
 * 平台哪天变了（放开/调小上限、补 CORS、换错误体）会立刻断言失败报警，届时按新行为更新本契约与客户端阈值。
 */
const GATEWAY_LIMIT_BYTES = 102400;
const GATEWAY_LIMIT_CODE = 'EXCEED_MAX_PAYLOAD_SIZE';

/** 各契约 note 共用的事实段（网关上限是平台行为、服务端不可修、客户端已对策）——四处记录保持一致。 */
const GATEWAY_CONTRACT_NOTE = '契约：网关 POST /push 硬上限 = 102400 字节（已二分钉死），网关在云函数之前拦截、函数根本没被调用 —— 服务端 MAX_PAYLOAD_BYTES=8388608 / MAX_BODY_BYTES=9437184 在真实链路上不可达，这不是服务端缺陷（服务端无从修起；平台侧也改不了：tcb cors add 受套餐限制、网关行为不可配置）。对策：客户端 PUSH_BODY_LIMIT_BYTES=100000 前置拦截 + gzip 压缩（有效上限约 610KB~1.4MB），超限请求根本不会发出（js/sync.js / js/cloud-transport.js；守门断言在 tests/logic.test.mjs「传输层: push 收到超限载荷 → 中文失败且零请求」断言「超限时一个请求都不许发」）。平台若变更上限或补 CORS，本处断言立刻失败报警。';

/** 断言「超限请求被网关挡下」＝当前契约：413 + EXCEED_MAX_PAYLOAD_SIZE + 无 access-control-* 头。 */
function expectGatewayOverLimit(ctx, entry, name) {
  const corsKeys = Object.keys(entry.cors || {}).filter((k) => k.indexOf('access-control-') === 0);
  const hitOk = ok(ctx, name + '：网关 413（契约：POST /push 请求体上限 ' + GATEWAY_LIMIT_BYTES + ' 字节；平台若放开上限，这里立刻报警）', entry.status === 413, 'HTTP ' + entry.status + ' body=' + clip(entry.text, 160) + ' cors=' + JSON.stringify(entry.cors), 'HTTP 413');
  const codeOk = ok(ctx, name + '：413 体含 ' + GATEWAY_LIMIT_CODE, String(entry.text || '').indexOf(GATEWAY_LIMIT_CODE) !== -1, 'body=' + clip(entry.text, 160), '含 ' + GATEWAY_LIMIT_CODE);
  const corsOk = ok(ctx, name + '：响应不含 access-control-*（网关级 413 不带 CORS，属当前平台行为）', corsKeys.length === 0, 'access-control-* = ' + JSON.stringify(corsKeys), '无 access-control-*');
  return hitOk && codeOk && corsOk;
}

/** 断言 ceiling 探测目标落在契约的哪一侧：≤ 102400 应 200，> 102400 应 413（网关行为一旦变化立刻报警）。 */
function expectGatewayBoundary(ctx, entry) {
  const t = entry.bodyBytes;
  const name = 'ceiling: body=' + t + ' bytes';
  if (t <= GATEWAY_LIMIT_BYTES) {
    return ok(ctx, name + '：≤ ' + GATEWAY_LIMIT_BYTES + ' 字节应为 200（平台若调小上限，这里立刻报警）', entry.status === 200, 'HTTP ' + entry.status + ' body=' + clip(entry.text, 160), 'HTTP 200');
  }
  return expectGatewayOverLimit(ctx, entry, name);
}

function addFinding(ctx, f) {
  ctx.findings.push({
    id: f.id,
    端点: f.endpoint,
    严重度: f.severity,
    请求: f.request,
    实际响应: f.actual,
    期望: f.expected,
    判断: f.verdict,
  });
}

function note(ctx, id, text) {
  ctx.notes.push({ id, 说明: text });
}

// ---------- 载荷构造器（导出，便于复现） ----------

/** JSON 文本长度恰好等于 MAX_PAYLOAD_BYTES 的载荷（length 用 UTF-16 码元，服务端就是这么比的）。 */
export function buildPayloadAtLimit() {
  const n = MAX_PAYLOAD_BYTES - JSON.stringify({ v: '' }).length;
  const payload = { v: 'a'.repeat(n) };
  const len = JSON.stringify(payload).length;
  if (len !== MAX_PAYLOAD_BYTES) throw new Error('载荷长度自检失败：' + len);
  return payload;
}
/** JSON 文本长度 = MAX_PAYLOAD_BYTES + 1（应当被 requirePayload 的「payload 过大」挡下）。 */
export function buildPayloadOverLimit() {
  const n = MAX_PAYLOAD_BYTES - JSON.stringify({ v: '' }).length + 1;
  return { v: 'a'.repeat(n) };
}
/** 3,000,000 个汉字：JSON 文本 3,000,008 码元 < 8MiB，但 UTF-8 字节约 9.0MB —— 探「码元比长度」还是「字节比长度」。 */
export function buildPayloadMultibyte(chars) {
  const count = Number(chars) > 0 ? Number(chars) : 3000000;
  return { v: '汉'.repeat(count) };
}
export function buildPayloadWithNul() {
  return { v: 'a\u0000b' };
}
export function buildPayloadWithLoneSurrogate() {
  return { v: '\ud800' };
}
export function buildPayloadDeepNest(depth) {
  const d = Number(depth) > 0 ? Number(depth) : 4000;
  let v = 1;
  for (let i = 0; i < d; i += 1) v = [v];
  return { v };
}

// ---------- 请求快捷方式 ----------

function apiPath(name) {
  return '/' + name;
}

async function post(ctx, label, name, body, extra) {
  const e = extra || {};
  return send(ctx, {
    label,
    path: apiPath(name),
    method: e.method || 'POST',
    headers: e.headers,
    origin: e.origin,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    timeoutMs: e.timeoutMs,
  });
}

async function register(ctx, name, password) {
  const e = await post(ctx, 'register:' + name, 'register', { username: name, password });
  if (e.status === 200 && e.json) {
    ctx.accounts[name] = { password, userId: e.json.userId, recoveryCode: e.json.recoveryCode, token: null };
  }
  return e;
}

async function login(ctx, name, password, label) {
  const e = await post(ctx, label || 'login:' + name, 'login', { username: name, password });
  if (e.status === 200 && e.json && ctx.accounts[name]) ctx.accounts[name].token = e.json.token;
  return e;
}

async function pull(ctx, token, label) {
  return post(ctx, label || 'pull', 'pull', { token });
}

async function push(ctx, label, token, baseRev, payload) {
  return post(ctx, label, 'push', { token, baseRev, payload });
}

// ---------- 各组用例 ----------

async function groupCors(ctx) {
  const webview = 'https://appassets.androidplatform.net';

  const pre = await send(ctx, { label: 'cors:preflight', path: '/push', method: 'OPTIONS', origin: webview });
  expectStatus(ctx, pre, 204, 'OPTIONS /push 预检状态码');
  expectCors(ctx, pre, 'OPTIONS /push 预检 CORS 头', webview);
  ok(ctx, 'OPTIONS /push 预检无响应体', pre.text === '', 'body=' + clip(pre.text, 80), 'body 为空');
  if (pre.cors['access-control-allow-origin'] !== webview) {
    addFinding(ctx, {
      id: 'f-cors-preflight',
      endpoint: 'OPTIONS /api/push',
      严重度: '高（真机 WebView 完全无法调用后端）',
      request: toCurl(pre) + '\n' + toReproCode(pre),
      actual: 'HTTP ' + pre.status + ' headers=' + JSON.stringify(pre.cors) + ' body=' + clip(pre.text, 120),
      expected: '204 + access-control-allow-origin: ' + webview + ' + allow-methods/allow-headers',
      verdict: '预检未反射 Origin：真机 origin 是 appassets.androidplatform.net，浏览器会直接判跨域失败，所有云同步接口不可用',
    });
  }

  const preNoOrigin = await send(ctx, { label: 'cors:preflight-no-origin', path: '/push', method: 'OPTIONS' });
  expectStatus(ctx, preNoOrigin, 204, 'OPTIONS /push（无 Origin）状态码');
  expectCors(ctx, preNoOrigin, 'OPTIONS /push（无 Origin）回落 *', '*');

  const errWithOrigin = await send(ctx, {
    label: 'cors:401-with-origin',
    path: '/pull',
    origin: webview,
    body: JSON.stringify({}),
  });
  expectStatus(ctx, errWithOrigin, 401, 'POST /pull 无 token → 401');
  expectCors(ctx, errWithOrigin, '401 错误响应带 CORS 头', webview);
  if (!errWithOrigin.cors['access-control-allow-origin']) {
    addFinding(ctx, {
      id: 'f-cors-error-response',
      endpoint: 'POST /api/pull（401）',
      严重度: '高（错误分支在真机上退化成「网络不可用」）',
      request: toCurl(errWithOrigin) + '\n' + toReproCode(errWithOrigin),
      actual: 'HTTP ' + errWithOrigin.status + ' headers=' + JSON.stringify(errWithOrigin.cors),
      expected: '所有 4xx/5xx 都带 access-control-allow-origin（cloud/README.md §13）',
      verdict: '错误响应缺 CORS 头：客户端读不到 401，只能显示网络错误',
    });
  }

  const nf = await send(ctx, { label: 'cors:404-with-origin', path: '/nope', origin: webview, body: JSON.stringify({}) });
  expectStatus(ctx, nf, 404, 'POST /nope → 404');
  expectCors(ctx, nf, '404 错误响应带 CORS 头', webview);

  const nullOrigin = await send(ctx, { label: 'cors:origin-null', path: '/push', method: 'OPTIONS', origin: 'null' });
  expectStatus(ctx, nullOrigin, 204, 'OPTIONS /push（Origin: null）状态码');
  note(
    ctx,
    'cors-null-origin',
    'Origin: null 被原样反射为 acao=null（实际 ' + JSON.stringify(nullOrigin.cors['access-control-allow-origin']) + '）。' +
      '协议刻意反射任意 Origin、且鉴权走请求体 token（无 cookie），因此 sandbox iframe 拿不到任何凭证 → 不构成风险，仅记录。'
  );
}

async function groupMethod(ctx) {
  const g1 = await send(ctx, { label: 'method:GET /pull', path: '/pull', method: 'GET' });
  expectStatus(ctx, g1, 404, 'GET /pull → 404（只支持 POST）');

  const p1 = await send(ctx, { label: 'method:PUT /register', path: '/register', method: 'PUT', body: JSON.stringify({ username: 'ab', password: '12345678' }) });
  expectStatus(ctx, p1, 404, 'PUT /register → 404');

  const d1 = await send(ctx, { label: 'method:DELETE /push', path: '/push', method: 'DELETE' });
  expectStatus(ctx, d1, 404, 'DELETE /push → 404');

  const upper = await send(ctx, {
    label: 'route:PULL+query',
    path: '/PULL?token=whatever',
    origin: 'https://appassets.androidplatform.net',
    body: JSON.stringify({}),
  });
  expectStatus(ctx, upper, 401, 'POST /api/PULL?token=whatever → 路由大小写不敏感 + 忽略查询串 → 401');

  const empty = await post(ctx, 'body:empty /pull', 'pull', '');
  expectStatus(ctx, empty, 400, 'POST /pull 空 body → 400');
  expectBodyField(ctx, empty, 'error', 'bad-request', '空 body 错误码');

  for (const e of [g1, p1, d1]) {
    if (!e.cors['access-control-allow-origin'] && !e.netErr) {
      note(ctx, 'gateway-' + e.label, e.label + ' 返回 ' + e.status + ' 且不带 CORS 头（headers=' + JSON.stringify(e.cors) + '），疑似网关直接短路、未进入云函数。');
    }
  }
}

async function groupMalformedBody(ctx) {
  const cases = [
    ['g2-1 非 JSON body', 'not-json{', 400, 'bad-request'],
    ['g2-2 顶层数组', '[]', 400, 'bad-request'],
    ['g2-3 顶层字符串', '"hello"', 400, 'bad-request'],
    ['g2-4 顶层数字', '12345', 400, 'bad-request'],
    ['g2-5 顶层 null', 'null', 400, 'bad-request'],
    ['g2-6 顶层布尔', 'true', 400, 'bad-request'],
  ];
  for (const [name, raw, want, code] of cases) {
    const e = await post(ctx, name, 'register', raw);
    expectStatus(ctx, e, want, name + ' → ' + want);
    if (e.status === want) expectBodyField(ctx, e, 'error', code, name + ' 错误码');
    if (e.status >= 500) {
      addFinding(ctx, {
        id: 'f-malformed-body-500',
        endpoint: 'POST /api/register',
        严重度: '中（未鉴权可反复触发 500，消耗数据库/函数配额）',
        request: toCurl(e),
        actual: 'HTTP ' + e.status + ' body=' + clip(e.text, 200),
        expected: '400 bad-request（畸形输入一律 4xx）',
        verdict: '畸形请求体打出了 5xx，输入校验存在漏网',
      });
    }
  }
  const raw2 = await send(ctx, {
    label: 'g2-7 content-type text/plain',
    path: '/register',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ username: 'ab', password: '12345678' }),
  });
  expectStatus(ctx, raw2, 400, 'POST /register（content-type: text/plain，合法 JSON 体）→ 400（body 仍被解析，username 太短）');
}

async function groupRegisterValidation(ctx) {
  const pw = 'Fuzz_pass_123';
  const cases = [
    ['g3-1 username 长度 2', { username: 'ab', password: pw }, 400],
    ['g3-2 username 长度 33', { username: 'a'.repeat(33), password: pw }, 400],
    ['g3-3 username 中文', { username: '用户名用户名', password: pw }, 400],
    ['g3-4 username 全空白', { username: '   ', password: pw }, 400],
    ['g3-5 username 缺失', { password: pw }, 400],
    ['g3-6 username 非字符串', { username: 12345, password: pw }, 400],
    ['g3-7 username 带连字符', { username: 'fuzz-bad', password: pw }, 400],
    ['g3-8 password 长度 7', { username: 'fuzz_pw7', password: 'p'.repeat(7) }, 400],
    ['g3-9 password 非字符串', { username: 'fuzz_pwnum', password: 12345678 }, 400],
    ['g3-10 password 长度 201', { username: 'fuzz_pw201', password: 'p'.repeat(201) }, 400],
    ['g3-11 password 长度 100000', { username: 'fuzz_pw100k', password: 'p'.repeat(100000) }, 400],
  ];
  for (const [name, body, want] of cases) {
    const e = await post(ctx, name, 'register', body);
    expectStatus(ctx, e, want, name + ' → ' + want);
    if (e.status !== want && e.status < 500) {
      addFinding(ctx, {
        id: 'f-validate-' + name.split(' ')[0],
        endpoint: 'POST /api/register',
        严重度: e.status === 200 ? '高（越界输入被接受并落库）' : '低（状态码与文档不符）',
        request: toCurl(e),
        actual: 'HTTP ' + e.status + ' body=' + clip(e.text, 200),
        expected: 'HTTP ' + want,
        verdict: '输入校验边界与文档/实现不一致',
      });
    }
  }

  // 边界内：3 字符 username + 8 字符 password（同时压两端最小值）
  const minEdge = await register(ctx, 'fz3', 'Fuzz_888');
  expectStatus(ctx, minEdge, 200, 'g3-12 username 3 字符 + password 8 字符 → 200（最小边界）');
  if (minEdge.status === 200 && minEdge.json) {
    ok(ctx, 'g3-12b 恢复码格式', RECOVERY_RE.test(String(minEdge.json.recoveryCode)), 'recoveryCode=' + JSON.stringify(minEdge.json.recoveryCode), 'XXXX-XXXX-XXXX-XXXX（去掉 0O1I 的 30 字符表）');
    ok(ctx, 'g3-12c userId 为数字', typeof minEdge.json.userId === 'number', 'userId=' + JSON.stringify(minEdge.json.userId), 'number');
  }

  const maxName = TEST_PREFIX + 'a'.repeat(32 - TEST_PREFIX.length);
  const maxEdge = await register(ctx, maxName, pw);
  expectStatus(ctx, maxEdge, 200, 'g3-13 username 32 字符 → 200（最大边界）');

  const padded = await register(ctx, ' fuzz_pad ', pw);
  expectStatus(ctx, padded, 200, 'g3-14 username 前后带空格 → trim 后 200');

  const dup1 = await register(ctx, 'fuzz_dup', pw);
  expectStatus(ctx, dup1, 200, 'g3-15 首次注册 fuzz_dup → 200');
  const dup2 = await register(ctx, 'FUZZ_DUP', pw);
  expectStatus(ctx, dup2, 409, 'g3-16 大小写变体重名 → 409');
  expectBodyField(ctx, dup2, 'error', 'conflict', '重名错误码 conflict');
  if (dup2.status === 200) {
    addFinding(ctx, {
      id: 'f-dup-case',
      endpoint: 'POST /api/register',
      严重度: '高（同一个人能建两个账号，数据分裂）',
      request: toCurl(dup2),
      actual: 'HTTP 200 body=' + clip(dup2.text, 200),
      expected: '409 conflict（唯一性按 username_lower）',
      verdict: '大小写变体绕过了唯一约束',
    });
  }

  const main = await register(ctx, 'fuzz_main', pw);
  expectStatus(ctx, main, 200, 'g3-17 主测试账号 fuzz_main → 200');
  const lock = await register(ctx, 'fuzz_lock', pw);
  expectStatus(ctx, lock, 200, 'g3-18 锁定测试账号 fuzz_lock → 200');
  const enm = await register(ctx, 'fuzz_enum', pw);
  expectStatus(ctx, enm, 200, 'g3-19 枚举测试账号 fuzz_enum → 200');
}

async function groupToken(ctx) {
  const t = await post(ctx, 'g4-1 无 token', 'pull', {});
  expectStatus(ctx, t, 401, 'pull 缺 token → 401');

  const tn = await post(ctx, 'g4-2 token=null', 'pull', { token: null });
  expectStatus(ctx, tn, 401, 'pull token=null → 401');

  const num = await post(ctx, 'g4-3 token=数字', 'pull', { token: 12345 });
  expectStatus(ctx, num, 400, 'pull token 非字符串 → 400（协议是 401，实现是 400）');

  const long = await post(ctx, 'g4-4 token=257 字符', 'pull', { token: 'a'.repeat(257) });
  expectStatus(ctx, long, 400, 'pull token 257 字符 → 400');

  const edge = await post(ctx, 'g4-5 token=256 字符', 'pull', { token: 'a'.repeat(256) });
  expectStatus(ctx, edge, 401, 'pull token 256 字符（长度边界内侧）→ 401');

  const fake = await post(ctx, 'g4-6 假 hex token', 'pull', { token: 'deadbeef'.repeat(8) });
  expectStatus(ctx, fake, 401, 'pull 假 64 hex token → 401');

  const loginMain = await login(ctx, 'fuzz_main', 'Fuzz_pass_123', 'g4-7 login fuzz_main');
  expectStatus(ctx, loginMain, 200, 'login fuzz_main → 200');
  ok(ctx, 'g4-7b token 为 64 hex', typeof (loginMain.json || {}).token === 'string' && /^[0-9a-f]{64}$/.test(loginMain.json.token), 'token=' + clip(String((loginMain.json || {}).token), 70), '64 位 hex');
  ok(ctx, 'g4-7c expiresAt 为数字毫秒', typeof (loginMain.json || {}).expiresAt === 'number', 'expiresAt=' + JSON.stringify((loginMain.json || {}).expiresAt), 'number（毫秒）');

  const first = await pull(ctx, ctx.accounts.fuzz_main.token, 'g4-8 首次 pull');
  expectStatus(ctx, first, 200, 'pull（有效 token，无快照）→ 200');
  if (first.status === 200) {
    expectBodyField(ctx, first, 'rev', 0, '首次 pull rev=0');
    ok(ctx, 'g4-8b 首次 pull savedAt=null', first.json.savedAt === null, 'savedAt=' + JSON.stringify(first.json.savedAt), 'null');
    ok(ctx, 'g4-8c 首次 pull payload=null', first.json.payload === null, 'payload=' + JSON.stringify(first.json.payload), 'null');
  }
  ctx.rev = 0;
}

async function groupPushValidation(ctx) {
  const token = ctx.accounts.fuzz_main.token;
  const cases = [
    ['g5-1 baseRev 字符串 "0"', { token, baseRev: '0', payload: { a: 1 } }, 400],
    ['g5-2 baseRev -1', { token, baseRev: -1, payload: { a: 1 } }, 400],
    ['g5-3 baseRev 1.5', { token, baseRev: 1.5, payload: { a: 1 } }, 400],
    ['g5-4 baseRev 1e309(Infinity)', { token, baseRev: Number('1e309'), payload: { a: 1 } }, 400],
    ['g5-5 baseRev 2147483648', { token, baseRev: 2147483648, payload: { a: 1 } }, 400],
    ['g5-6 baseRev 布尔', { token, baseRev: true, payload: { a: 1 } }, 400],
    ['g5-7 baseRev 2147483647', { token, baseRev: 2147483647, payload: { a: 1 } }, 409],
    ['g5-8 payload 为数组', { token, baseRev: 0, payload: [1, 2, 3] }, 400],
    ['g5-9 payload 为字符串', { token, baseRev: 0, payload: 'x' }, 400],
    ['g5-10 payload 为 null', { token, baseRev: 0, payload: null }, 400],
    ['g5-11 baseRev 缺失', { token, payload: { a: 1 } }, 400],
    ['g5-12 token 缺失', { baseRev: 0, payload: { a: 1 } }, 401],
  ];
  for (const [name, body, want] of cases) {
    const raw = name.indexOf('1e309') >= 0 ? JSON.stringify(body).replace('null', '1e309') : body;
    const e = await post(ctx, name, 'push', raw);
    expectStatus(ctx, e, want, name + ' → ' + want);
    if (e.status !== want) {
      addFinding(ctx, {
        id: 'f-push-validate-' + name.split(' ')[0],
        endpoint: 'POST /api/push',
        严重度: e.status >= 500 ? '高（5xx）' : e.status === 200 ? '高（越界 baseRev / payload 被接受，可能写坏快照序列）' : '低（状态码与文档不符）',
        request: toCurl(e),
        actual: 'HTTP ' + e.status + ' body=' + clip(e.text, 200),
        expected: 'HTTP ' + want,
        verdict: 'push 入参校验与文档不符',
      });
    }
  }

  const p1k = { kind: 'fuzz', n: 1, data: 'k'.repeat(1024) };
  const e1k = await push(ctx, 'g5-13 1KB payload', token, ctx.rev, p1k);
  expectStatus(ctx, e1k, 200, 'push 1KB payload（baseRev=' + ctx.rev + '）→ 200');
  if (e1k.status === 200) {
    ok(ctx, 'g5-13b rev 递增到 baseRev+1', e1k.json.rev === ctx.rev + 1, 'rev=' + JSON.stringify(e1k.json.rev), String(ctx.rev + 1));
    ctx.rev = e1k.json.rev;
  }

  const stale = await push(ctx, 'g5-14 过期 baseRev', token, 0, { stale: true });
  expectStatus(ctx, stale, 409, 'push 过期 baseRev=0 → 409');
  if (stale.status === 409) {
    expectBodyField(ctx, stale, 'error', 'rev-conflict', '409 体为 rev-conflict');
    expectBodyField(ctx, stale, 'rev', ctx.rev, '409 附带服务器当前 rev');
  }

  // 数据一致性的真检验：对刚刚写入成功的 1KB 载荷做完整回读比对
  const round = await pull(ctx, token, 'g5-15 push 后回读(1KB)');
  expectStatus(ctx, round, 200, 'push 后 pull → 200');
  if (round.status === 200) {
    ok(ctx, 'g5-15b rev 一致', round.json.rev === ctx.rev, 'rev=' + JSON.stringify(round.json.rev), String(ctx.rev));
    ok(ctx, 'g5-15c savedAt 为数字毫秒', typeof round.json.savedAt === 'number', 'savedAt=' + JSON.stringify(round.json.savedAt), 'number');
    const same = sha256Hex(canonicalJson(round.json.payload)) === sha256Hex(canonicalJson(p1k));
    ok(ctx, 'g5-15d 载荷逐字段回读一致', same, 'payloadHash=' + sha256Hex(canonicalJson(round.json.payload)).slice(0, 16), 'payloadHash=' + sha256Hex(canonicalJson(p1k)).slice(0, 16));
    if (!same) {
      addFinding(ctx, {
        id: 'f-payload-roundtrip',
        endpoint: 'POST /api/push → POST /api/pull',
        严重度: '高（用户数据落库后被改写/丢失）',
        request: toCurl(e1k) + '\n// 再发 POST /api/pull {"token": "$TOKEN"} 对比回读',
        actual: 'pull 回读 hash=' + sha256Hex(canonicalJson(round.json.payload)),
        expected: '与推上去的 payload 语义一致（jsonb 会重排键序，故用规范化 JSON 比对）',
        verdict: '推上去和拉下来不是同一份数据',
      });
    }
  }

  // 1MB 载荷：真实上限由网关决定（102400 字节）—— 网关先于云函数拦截。原 f-gateway-body-ceiling finding 写在了
  // 已废弃的假设上（「服务端 8MiB 允许 1MB」），现改写为「契约 note + 断言网关当前行为」：期望 413 +
  // EXCEED_MAX_PAYLOAD_SIZE + 无 access-control-*；平台若放开/调小上限或补 CORS，断言立刻失败报警。
  const p1m = { kind: 'fuzz', n: 2, blob: 'm'.repeat(1024 * 1024) };
  const e1m = await push(ctx, 'g5-16 1MB payload', token, ctx.rev, p1m);
  if (e1m.status === 413) {
    note(ctx, 'g5-16-413', '1MB payload（请求体 ' + e1m.bodyChars + ' 字节）被网关 413 拦下：' + clip(e1m.text, 160) + ' cors=' + JSON.stringify(e1m.cors) + '。' + GATEWAY_CONTRACT_NOTE + '平台放开限制后可用以下命令复验：' + toCurl(e1m, { builder: 'buildBodyOfExactLength' }) + ' ； ' + toReproCode(e1m, 'buildBodyOfExactLength'));
    expectGatewayOverLimit(ctx, e1m, 'g5-16 1MB payload');
  } else if (e1m.status === 200) {
    ctx.rev = e1m.json.rev;
    note(ctx, 'g5-16-accepted', '1MB payload（请求体 ' + e1m.bodyChars + ' 字节）被接受，rev=' + e1m.json.rev + '：网关上限疑似已被平台放开，请复核 GATEWAY_LIMIT_BYTES 契约与客户端 PUSH_BODY_LIMIT_BYTES');
    ok(ctx, 'g5-16 1MB 请求体应被网关 413 拦下（契约：上限 102400 字节），实际到了服务端', false, 'HTTP 200 rev=' + JSON.stringify(e1m.json && e1m.json.rev), 'HTTP 413 + EXCEED_MAX_PAYLOAD_SIZE');
  } else {
    ok(ctx, 'g5-16 网关行为偏离已记录契约（HTTP ' + e1m.status + '）', false, 'HTTP ' + e1m.status + ' body=' + clip(e1m.text, 160) + ' cors=' + JSON.stringify(e1m.cors), 'HTTP 413 + EXCEED_MAX_PAYLOAD_SIZE + 无 access-control-*');
  }
}

async function groupPayloadFaults(ctx) {
  const token = ctx.accounts.fuzz_main.token;
  const baseRev = ctx.rev;
  const faults = [];

  // 1) NUL 字符
  const nulPayload = buildPayloadWithNul();
  const nulBody = JSON.stringify({ token, baseRev, payload: nulPayload });
  const eNul = await post(ctx, 'pf-1 payload 含 NUL', 'push', nulBody);
  faults.push({ id: 'pf-1', name: 'payload 字符串含 U+0000', entry: eNul, payload: nulPayload, builder: 'buildPayloadWithNul' });

  // 2) 落单代理项
  if (eNul.status !== 200) {
    const lonePayload = buildPayloadWithLoneSurrogate();
    const eLone = await post(ctx, 'pf-2 payload 含落单代理项', 'push', JSON.stringify({ token, baseRev, payload: lonePayload }));
    faults.push({ id: 'pf-2', name: 'payload 含落单代理项 \\ud800', entry: eLone, payload: lonePayload, builder: 'buildPayloadWithLoneSurrogate' });
  }

  // 3) 深嵌套
  if (ctx.rev === baseRev) {
    const deepPayload = buildPayloadDeepNest(4000);
    const eDeep = await post(ctx, 'pf-3 payload 4000 层嵌套', 'push', JSON.stringify({ token, baseRev, payload: deepPayload }));
    faults.push({ id: 'pf-3', name: 'payload 4000 层嵌套数组', entry: eDeep, payload: deepPayload, builder: 'buildPayloadDeepNest' });
  }

  for (const f of faults) {
    const e = f.entry;
    if (e.status === 200) {
      // pf-1-accepted = 服务端「净化 payload 非法码元（NUL / 落单代理项）」（commit a113f1f）修复的正向验证：
      // 修复前含 U+0000 的 payload 会永久 500（走下面的 >=500 分支），修复生效后它被净化并 200 落库 —— 这条
      // note 证明修复生效，不是缺陷豁免；若哪天退回 5xx，下面的 f-payload-pf-1 finding 会立刻把它揪出来。
      ctx.rev = e.json && e.json.rev ? e.json.rev : ctx.rev;
      note(ctx, f.id + '-accepted', f.name + '：HTTP 200 rev=' + JSON.stringify(e.json && e.json.rev) + '（被接受）');
    } else if (e.status >= 500) {
      addFinding(ctx, {
        id: 'f-payload-' + f.id,
        endpoint: 'POST /api/push（已认证）',
        严重度: '中（用户数据永久写不上去：本地只要有一个这样的字符，push 永远 500，客户端会无限重试）',
        request: toCurl(e, { builder: f.builder }) + '\n' + toReproCode(e, f.builder),
        actual: 'HTTP ' + e.status + ' body=' + clip(e.text, 200) + ' cors=' + JSON.stringify(e.cors),
        expected: '200 { rev } 正常写出；或 400 bad-request 明确拒绝（合法 JSON 不该变 5xx）',
        verdict: '合法 JSON、已认证请求打出 5xx：' + f.name + ' 在 Postgres jsonb 侧不合法（\\u0000 / 落单代理项 / 深递归），服务端没有兜底转换或明确拒绝，用户数据无法同步',
      });
    } else if (e.status === 400) {
      note(ctx, f.id + '-rejected', f.name + '：HTTP 400 ' + clip(e.text, 120) + '（明确拒绝）');
    }
  }

  // 写后一致性：前面若发生 5xx，必须证明快照没被写坏
  const after = await pull(ctx, token, 'pf-verify 故障后一致性');
  expectStatus(ctx, after, 200, '故障 payload 之后 pull → 200');
  if (after.status === 200) {
    ok(ctx, 'pf-verify rev 未被半写推进', after.json.rev === (ctx.rev === baseRev ? baseRev : ctx.rev), 'rev=' + JSON.stringify(after.json.rev), '与最后一次成功写入一致');
    ok(ctx, 'pf-verify 快照仍可读（非 null）', after.json.payload !== null, 'payload=' + clip(JSON.stringify(after.json.payload), 120), '保持上一次成功写入的 payload');
  }

  // 4) 接近上限：先试超限（应被拒），再试恰好等于上限
  const over = buildPayloadOverLimit();
  const eOver = await post(ctx, 'pf-4 payload 超限 1 码元', 'push', JSON.stringify({ token, baseRev: ctx.rev, payload: over }), { timeoutMs: 90000 });
  const overChars = JSON.stringify(over).length;
  if (eOver.status === 413) {
    // 网关先于云函数拦截：原 f-payload-over-limit finding 期望的 400「payload 过大」在真实链路上不可达（函数
    // 根本没被调用），已废弃 —— 改写为「契约 note + 断言网关当前行为」；平台若放开上限（这里拿到 400/200/其它）立刻报警。
    note(ctx, 'pf-4', '超限 payload（JSON 文本 ' + overChars + ' 码元 / ' + byteLen(JSON.stringify(over)) + ' 字节，服务端上限 MAX_PAYLOAD_BYTES=' + MAX_PAYLOAD_BYTES + '）在到达函数前被网关 413 拦下：' + clip(eOver.text, 200) + ' cors=' + JSON.stringify(eOver.cors) + '。' + GATEWAY_CONTRACT_NOTE + '平台放开限制后可用以下命令复验：' + toReproCode(eOver, 'buildPayloadOverLimit') + ' ； ' + toCurl(eOver, { builder: 'buildPayloadOverLimit' }));
    expectGatewayOverLimit(ctx, eOver, 'pf-4 超限 payload');
  } else if (eOver.status >= 500) {
    addFinding(ctx, {
      id: 'f-payload-over-limit-500',
      endpoint: 'POST /api/push',
      严重度: '中',
      request: toReproCode(eOver, 'buildPayloadOverLimit'),
      actual: 'HTTP ' + eOver.status + ' body=' + clip(eOver.text, 200),
      expected: '400 bad-request「payload 过大」',
      verdict: '超限 payload 没有走校验分支而是 5xx',
    });
  } else {
    // 400 / 200 / 其它：超限请求抵达了云函数（或行为异常）—— 网关上限疑似已被平台变更，报警，不静默接受。
    ok(ctx, 'pf-4 超限 payload 应被网关 413 拦下（契约：上限 102400 字节），实际 HTTP ' + eOver.status + ' —— 请复核 GATEWAY_LIMIT_BYTES 契约', false, 'HTTP ' + eOver.status + ' body=' + clip(eOver.text, 200) + ' cors=' + JSON.stringify(eOver.cors), 'HTTP 413 + EXCEED_MAX_PAYLOAD_SIZE + 无 access-control-*');
  }

  if (ctx.rev === baseRev && eOver.status !== 200) {
    const atLimit = buildPayloadAtLimit();
    const eAt = await post(ctx, 'pf-5 payload 恰好等于上限', 'push', JSON.stringify({ token, baseRev: ctx.rev, payload: atLimit }), { timeoutMs: 90000 });
    note(ctx, 'pf-5', '恰好 ' + MAX_PAYLOAD_BYTES + ' 码元（' + byteLen(JSON.stringify(atLimit)) + ' 字节）→ HTTP ' + eAt.status + ' body=' + clip(eAt.text, 160) + ' cors=' + JSON.stringify(eAt.cors));
    if (eAt.status === 200) {
      ctx.rev = eAt.json.rev;
      ok(ctx, 'pf-5 恰好到上限的 payload 被接受', true, 'HTTP 200', 'HTTP 200 或 400 均可，但必须与 pf-4 的判定一致');
    } else if (eAt.status === 400) {
      expectBodyField(ctx, eAt, 'message', 'payload 过大', 'pf-5 恰好上限被拒的文案');
    }
  }

  // 5) 码元 vs 字节：3,000,000 汉字 ≈ 9.0MB UTF-8，但 length 只有 3,000,008 码元
  if (ctx.rev === baseRev && eOver.status !== 200) {
    const mb = buildPayloadMultibyte(3000000);
    const eMb = await post(ctx, 'pf-6 多字节超字节上限', 'push', JSON.stringify({ token, baseRev: ctx.rev, payload: mb }), { timeoutMs: 90000 });
    let accepted = eMb.status === 200;
    if (accepted) ctx.rev = eMb.json.rev;
    note(ctx, 'pf-6', '3,000,000 汉字：JSON 文本 ' + JSON.stringify(mb).length + ' 码元 / ' + byteLen(JSON.stringify(mb)) + ' 字节 → HTTP ' + eMb.status + ' body=' + clip(eMb.text, 160));
    if (accepted) {
      addFinding(ctx, {
        id: 'f-payload-bytes-vs-chars',
        endpoint: 'POST /api/push',
        严重度: '中（服务端「8MiB 快照上限」实际按 UTF-16 码元计数，中文/emoji 载荷可超限约 3 倍；存储与回传成本失控）',
        request: toReproCode(eMb, 'buildPayloadMultibyte'),
        actual: 'HTTP 200 rev=' + JSON.stringify(eMb.json.rev) + '：载荷 JSON 文本 ' + JSON.stringify(mb).length + ' 码元但 ' + byteLen(JSON.stringify(mb)) + ' UTF-8 字节（> MAX_PAYLOAD_BYTES=' + MAX_PAYLOAD_BYTES + '）',
        expected: '按字节判定（Buffer.byteLength）拒绝 > 8MiB 的载荷',
        verdict: 'code: requirePayload 用 text.length（UTF-16 码元）比较 MAX_PAYLOAD_BYTES，长度与字节混用 —— 中文用户的一份 8MiB 级数据实际可达 ~25MB',
      });
    }
  }
}

async function groupRace(ctx) {
  const main = ctx.accounts.fuzz_main.token;
  const other = ctx.accounts['fz3'].token;

  // 跨账号隔离
  const loginPad = await login(ctx, ' fuzz_pad ', 'Fuzz_pass_123', 'race:login fuzz_pad（带空格）');
  expectStatus(ctx, loginPad, 200, 'login「 fuzz_pad 」（带空格）→ 200：注册与登录都 trim');
  const padToken = (loginPad.json || {}).token;
  if (padToken) {
    const iso = await pull(ctx, padToken, 'race:隔离 pull');
    expectStatus(ctx, iso, 200, '另一账号 pull → 200');
    if (iso.status === 200) {
      ok(ctx, 'race 跨账号看不到别人的快照', iso.json.rev === 0 && iso.json.payload === null, 'rev=' + iso.json.rev + ' payload=' + clip(JSON.stringify(iso.json.payload), 80), 'rev=0 / payload=null');
    }
  }

  const baseRev = ctx.rev;
  const a = { race: 'A', n: 1 };
  const b = { race: 'B', n: 2 };
  const [ra, rb] = await Promise.all([
    push(ctx, 'race:push A', main, baseRev, a),
    push(ctx, 'race:push B', main, baseRev, b),
  ]);
  const statuses = [ra.status, rb.status].sort((x, y) => x - y);
  ok(ctx, 'race-1 2 并发同 baseRev：恰好一个 200 一个 409', statuses[0] === 200 && statuses[1] === 409, 'statuses=' + JSON.stringify([ra.status, rb.status]), '200 + 409');
  const winner = ra.status === 200 ? ra : rb;
  const loser = ra.status === 200 ? rb : ra;
  if (winner.status === 200) ctx.rev = winner.json.rev;
  if (loser.status === 409) {
    ok(ctx, 'race-2 409 附带服务器当前 rev', loser.json && loser.json.rev === ctx.rev, 'rev=' + JSON.stringify(loser.json && loser.json.rev), String(ctx.rev));
  }
  if (!(statuses[0] === 200 && statuses[1] === 409)) {
    addFinding(ctx, {
      id: 'f-race-two-push',
      endpoint: 'POST /api/push ×2 并发',
      严重度: '高（原子性失效 → 用户数据被静默覆盖/丢失）',
      request: '并发发出两次 push（同一 baseRev=' + baseRev + '）：\n' + toReproCode(ra) + '\n' + toReproCode(rb),
      actual: 'statuses=' + JSON.stringify([ra.status, rb.status]) + ' bodies=' + clip(ra.text, 120) + ' | ' + clip(rb.text, 120),
      expected: '恰好一个 200、一个 409 rev-conflict（cloud/README.md §5）',
      verdict: '并发写入的原子性不成立：可能出现两个 200（互相覆盖）或其他组合',
    });
  }

  const verify = await pull(ctx, main, 'race-3 并发后回读');
  if (verify.status === 200) {
    const stored = sha256Hex(canonicalJson(verify.json.payload));
    const hitA = stored === sha256Hex(canonicalJson(a));
    const hitB = stored === sha256Hex(canonicalJson(b));
    ok(ctx, 'race-4 并发后快照是其中一个完整载荷（非撕裂写）', verify.json.rev === ctx.rev && (hitA || hitB), 'rev=' + verify.json.rev + ' hashHitA=' + hitA + ' hashHitB=' + hitB, 'rev=' + ctx.rev + ' 且等于 A 或 B 之一');
  }

  // 3 并发
  if (verify.status === 200) {
    const base3 = ctx.rev;
    const payloads = [1, 2, 3].map((i) => ({ race: 'C' + i }));
    const rs = await Promise.all(payloads.map((p, i) => push(ctx, 'race:3push#' + i, main, base3, p)));
    const count200 = rs.filter((r) => r.status === 200).length;
    const count409 = rs.filter((r) => r.status === 409).length;
    ok(ctx, 'race-5 3 并发同 baseRev：1 个 200 + 2 个 409', count200 === 1 && count409 === 2, 'statuses=' + JSON.stringify(rs.map((r) => r.status)), '1×200 + 2×409');
    if (count200 === 1) ctx.rev = rs.find((r) => r.status === 200).json.rev;
    if (!(count200 === 1 && count409 === 2)) {
      addFinding(ctx, {
        id: 'f-race-three-push',
        endpoint: 'POST /api/push ×3 并发',
        严重度: '高（多端同时同步的概率比 2 并发更高）',
        request: '并发 3 次 push，同一 baseRev=' + base3,
        actual: 'statuses=' + JSON.stringify(rs.map((r) => r.status)),
        expected: '1×200 + 2×409',
        verdict: '多路并发下的 CAS 不满足「恰好一次成功」',
      });
    }
  }

  // 并发注册同名
  const raceName = 'fuzz_race';
  const [regA, regB] = await Promise.all([
    post(ctx, 'race:register#1', 'register', { username: raceName, password: 'Fuzz_pass_123' }),
    post(ctx, 'race:register#2', 'register', { username: raceName, password: 'Fuzz_pass_123' }),
  ]);
  const rs2 = [regA.status, regB.status].sort((x, y) => x - y);
  ok(ctx, 'race-6 并发注册同名：一个 200 一个 409', rs2[0] === 200 && rs2[1] === 409, 'statuses=' + JSON.stringify([regA.status, regB.status]), '200 + 409');
  if (!(rs2[0] === 200 && rs2[1] === 409)) {
    addFinding(ctx, {
      id: 'f-race-register',
      endpoint: 'POST /api/register ×2 并发',
      严重度: '高（可能建出重复账号或 5xx）',
      request: '并发两次注册 username=' + raceName,
      actual: 'statuses=' + JSON.stringify([regA.status, regB.status]) + ' bodies=' + clip(regA.text, 120) + ' | ' + clip(regB.text, 120),
      expected: '一个 200、一个 409 conflict',
      verdict: '并发注册的唯一性不成立',
    });
  }
}

async function groupLockout(ctx) {
  const name = 'fuzz_lock';
  const wrong = 'Wrong_pass_999';
  const statuses = [];
  for (let i = 1; i <= 10; i += 1) {
    const e = await login(ctx, name, wrong, 'lockout:fail#' + i);
    statuses.push(e.status);
  }
  ok(ctx, 'lock-1 连续 10 次失败均为 401', statuses.every((s) => s === 401), 'statuses=' + JSON.stringify(statuses), '10×401');
  if (!statuses.every((s) => s === 401)) {
    const bad = statuses.findIndex((s) => s !== 401) + 1;
    addFinding(ctx, {
      id: 'f-lock-threshold',
      endpoint: 'POST /api/login',
      严重度: '中（阈值与文档不符，用户被提前锁 / 锁定无效）',
      request: '连续 10 次错误口令：' + toReproCode(await post(ctx, 'lockout:probe', 'login', { username: name, password: wrong })),
      actual: '第 ' + bad + ' 次返回 ' + statuses[bad - 1],
      expected: '第 1..10 次都是 401（第 10 次触发锁定），第 11 次起 423',
      verdict: 'LOCK_AFTER_FAILS 的实际生效点与 README 不一致',
    });
  }

  const eleventh = await login(ctx, name, wrong, 'lockout:fail#11');
  expectStatus(ctx, eleventh, 423, 'lock-2 第 11 次失败 → 423');
  ok(ctx, 'lock-2b 423 文案为锁定提示', /锁定/.test(String(eleventh.text)), 'body=' + clip(eleventh.text, 120), '包含「锁定」');
  if (eleventh.status !== 423) {
    addFinding(ctx, {
      id: 'f-lock-enforce',
      endpoint: 'POST /api/login',
      严重度: '高（口令爆破无成本：10 次失败不清零、也不锁定）',
      request: '第 11 次错误口令登录',
      actual: 'HTTP ' + eleventh.status + ' body=' + clip(eleventh.text, 200),
      expected: 'HTTP 423 locked',
      verdict: '连续失败阈值没有生效，爆破可无限继续',
    });
  }

  const correct = await login(ctx, name, 'Fuzz_pass_123', 'lockout:correct-while-locked');
  expectStatus(ctx, correct, 423, 'lock-3 锁定期间正确口令 → 423');
  if (correct.status === 200) {
    addFinding(ctx, {
      id: 'f-lock-bypass',
      endpoint: 'POST /api/login',
      严重度: '高（锁定形同虚设，爆破可继续）',
      request: '锁定期间用正确口令登录',
      actual: 'HTTP 200 发 token 了',
      expected: 'HTTP 423（LOCK_MS 内一律拒绝）',
      verdict: '锁定时长/判定被绕过',
    });
  }
}

async function groupEnumerationAndReset(ctx) {
  const enumPw = 'Fuzz_pass_123';
  const a = await login(ctx, 'fuzz_enum', 'Not_the_pass_1', 'enum:存在用户错误口令');
  expectStatus(ctx, a, 401, 'enum-1 存在用户 + 错误口令 → 401');
  const b = await post(ctx, 'enum:不存在用户', 'login', { username: 'fuzz_nosuchuser', password: 'Not_the_pass_1' });
  expectStatus(ctx, b, 401, 'enum-2 不存在用户 → 401');
  ok(ctx, 'enum-3 两种 401 逐字节相同（不泄露用户名是否存在）', a.text === b.text, 'A=' + clip(a.text, 120) + ' B=' + clip(b.text, 120), '响应体完全一致');
  if (a.text !== b.text) {
    addFinding(ctx, {
      id: 'f-username-enumeration',
      endpoint: 'POST /api/login',
      严重度: '中（可批量判定用户名是否注册，为撞库提供有效账号清单）',
      request: toReproCode(a) + '\n' + toReproCode(b),
      actual: '存在用户=' + clip(a.text, 160) + ' / 不存在用户=' + clip(b.text, 160),
      expected: '逐字节相同的 401（AUTH_FAIL_MESSAGE）',
      verdict: '响应体差异泄露用户名存在性',
    });
  }

  const mainRecovery = ctx.accounts.fuzz_main.recoveryCode;
  const rWrong = await post(ctx, 'reset:错误恢复码', 'reset', { username: 'fuzz_main', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'Fuzz_main_456' });
  expectStatus(ctx, rWrong, 401, 'reset-1 错误恢复码 → 401');
  const rNoUser = await post(ctx, 'reset:不存在用户', 'reset', { username: 'fuzz_nosuchuser', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'Fuzz_main_456' });
  ok(ctx, 'reset-1b 两种 reset 401 逐字节相同', rWrong.text === rNoUser.text, 'A=' + clip(rWrong.text, 120) + ' B=' + clip(rNoUser.text, 120), '完全一致');
  const rBad = await post(ctx, 'reset:畸形恢复码', 'reset', { username: 'fuzz_main', recoveryCode: '!!!!', newPassword: 'Fuzz_main_456' });
  expectStatus(ctx, rBad, 400, 'reset-2 畸形恢复码 → 400');
  const rLong = await post(ctx, 'reset:超长恢复码', 'reset', { username: 'fuzz_main', recoveryCode: 'A'.repeat(100), newPassword: 'Fuzz_main_456' });
  expectStatus(ctx, rLong, 400, 'reset-3 恢复码 100 字符 → 400');

  const oldToken = ctx.accounts.fuzz_main.token;
  const rOk = await post(ctx, 'reset:正确恢复码', 'reset', { username: 'fuzz_main', recoveryCode: mainRecovery, newPassword: 'Fuzz_main_456' });
  expectStatus(ctx, rOk, 200, 'reset-4 正确恢复码 → 200 { ok: true }');
  if (rOk.status === 200) expectBodyField(ctx, rOk, 'ok', true, 'reset-4b 响应体 ok=true');

  const oldPull = await pull(ctx, oldToken, 'reset-5 旧 token 复查');
  expectStatus(ctx, oldPull, 401, 'reset-5 重置后旧 token 立即失效 → 401');

  const oldLogin = await post(ctx, 'reset:旧口令', 'login', { username: 'fuzz_main', password: 'Fuzz_pass_123' });
  expectStatus(ctx, oldLogin, 401, 'reset-6 重置后用旧口令登录 → 401');

  const newLogin = await login(ctx, 'fuzz_main', 'Fuzz_main_456', 'reset:新口令');
  expectStatus(ctx, newLogin, 200, 'reset-7 重置后用新口令登录 → 200');
}

// ---------- 网关真实上限探测（独立入口，不跑整套用例） ----------

/** 构造长度（字节）严格等于 target 的请求体；只含 ASCII，故 length === 字节数。 */
export function buildBodyOfExactLength(target, token, baseRev) {
  const overhead = JSON.stringify({ token, baseRev, payload: { v: '' } }).length;
  const n = Number(target) - overhead;
  if (n < 0) throw new Error('目标长度太小：' + target + '（开销 ' + overhead + ' 字节）');
  const body = JSON.stringify({ token, baseRev, payload: { v: 'a'.repeat(n) } });
  if (body.length !== Number(target)) throw new Error('请求体长度自检失败：' + body.length + ' != ' + target);
  return body;
}

/**
 * 独立探测「网关真实请求体上限」：fuzz_ceil 专用账号 → 二分逼近 → 上限内侧载荷回读校验。
 * 只发 5 次请求（register / login / 2 次边界探测 / pull）。
 */
export async function probePayloadCeiling(options) {
  const opts = options || {};
  const online = opts.online === true || process.env.HMS_FUZZ_API === '1';
  const baseUrl = (opts.baseUrl || process.env.HMS_FUZZ_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  if (!online) {
    return { skipped: true, requestsUsed: 0, requestsBudget: MAX_REQUESTS, findings: [], failures: [], passed: 0, failed: 0, note: '未联网：设置 HMS_FUZZ_API=1' };
  }
  const ctx = createContext(baseUrl);
  const name = 'fuzz_ceil';
  const pw = 'Fuzz_pass_123';
  const evidence = [];

  // 账号可复用：先登录，不行再注册（探测要能重复跑）
  let lg = await login(ctx, name, pw, 'ceiling: login');
  if (lg.status !== 200) {
    const reg = await register(ctx, name, pw);
    expectStatus(ctx, reg, 200, 'ceiling: 专用账号 ' + name + ' 注册 → 200');
    if (reg.status !== 200) return ceilingSummary(ctx, evidence);
    lg = await login(ctx, name, pw, 'ceiling: 新账号 login');
  }
  expectStatus(ctx, lg, 200, 'ceiling: login → 200');
  const token = (lg.json || {}).token;
  if (!token) return ceilingSummary(ctx, evidence);

  const cur = await pull(ctx, token, 'ceiling: 读取当前 rev');
  if (cur.status === 200) ctx.rev = cur.json.rev;

  const probe = async (target) => {
    const baseRev = ctx.rev;
    const body = buildBodyOfExactLength(target, token, baseRev);
    const e = await send(ctx, { label: 'ceiling: body=' + target + ' bytes', path: '/push', body, timeoutMs: 60000 });
    const rec = { target, baseRev, status: e.status, body: clip(e.text, 200), cors: e.cors, rev: e.json && e.json.rev };
    evidence.push(rec);
    if (e.status === 200) ctx.rev = e.json.rev;
    return { entry: e, rec };
  };

  const MIB = 1024 * 1024;
  const envTargets = String(process.env.HMS_FUZZ_CEILING_TARGETS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const bisectSpec = String(process.env.HMS_FUZZ_CEILING_BISECT || '').trim();
  let ceilingDesc = null;

  if (bisectSpec) {
    const parts = bisectSpec.split(',').map((s) => Number(s.trim()));
    let lo = parts[0];
    let hi = parts[1];
    let steps = 0;
    while (hi - lo > 1024 && steps < 8) {
      const mid = Math.floor((lo + hi) / 2);
      const { rec } = await probe(mid);
      steps += 1;
      if (rec.status === 200) lo = mid;
      else if (rec.status === 413) hi = mid;
      else break;
    }
    ceilingDesc = '在 (' + lo + ', ' + hi + '] 字节区间内（' + steps + ' 步二分，步长 ≤1024 停）';
    note(ctx, 'ceiling-range', '网关请求体上限落在 (' + lo + ', ' + hi + '] 字节：≤ ' + lo + ' 成功，' + hi + ' 起 413');
  } else {
    const targets = envTargets.length ? envTargets : [MIB, MIB + 1];
    for (const t of targets) {
      const { entry } = await probe(t);
      // 探测照发（证明网关边界仍在）；断言的是网关当前行为：≤102400 → 200，>102400 → 413 + EXCEED + 无 CORS。
      // 平台若调小/放开上限或补 CORS，这里立刻失败报警（契约全文见 GATEWAY_LIMIT_BYTES 注释）。
      expectGatewayBoundary(ctx, entry);
    }
    const bad = evidence.filter((e) => e.status === 413).map((e) => e.target);
    const good = evidence.filter((e) => e.status === 200).map((e) => e.target);
    if (bad.length) ceilingDesc = '上限 < ' + Math.min.apply(null, bad) + (good.length ? '，且在 ' + Math.max.apply(null, good) + ' 之上' : '');
  }

  // 最大的成功探测 → 回读校验（证明上限内侧的数据完整落库）
  const oks = evidence.filter((e) => e.status === 200); // 保持写入顺序：最后一次成功写入才是当前快照
  if (oks.length) {
    const last = oks[oks.length - 1];
    const body = buildBodyOfExactLength(last.target, token, last.baseRev);
    const storedPayload = JSON.parse(body).payload;
    const back = await pull(ctx, token, 'ceiling: 上限内侧载荷回读');
    expectStatus(ctx, back, 200, 'ceiling: 回读 → 200');
    if (back.status === 200) {
      const same = sha256Hex(canonicalJson(back.json.payload)) === sha256Hex(canonicalJson(storedPayload));
      ok(ctx, 'ceiling: ' + last.target + ' 字节请求体的载荷逐字段回读一致', same, 'hash=' + sha256Hex(canonicalJson(back.json.payload)).slice(0, 16), 'hash=' + sha256Hex(canonicalJson(storedPayload)).slice(0, 16));
      evidence.push({ roundTrip: same, rev: back.json.rev, savedAtType: typeof back.json.savedAt, target: last.target });
    }
  }

  // 契约记录：原 f-gateway-body-ceiling-exact / f-gateway-413-no-cors 两条 finding 已按「网关上限是平台行为、
  // 服务端不可修、客户端已对策」改写为 note；探测与断言仍在（见 expectGatewayBoundary），平台若变更会立刻失败报警。
  if (ceilingDesc) {
    note(ctx, 'ceiling-contract', '网关请求体上限契约：' + ceilingDesc + '；' + GATEWAY_CONTRACT_NOTE + '本次实测：' + evidence.filter((e) => e.status !== undefined).map((e) => e.target + ' 字节 → HTTP ' + e.status).join('，') + '；断言的目标行为 = 413 + ' + GATEWAY_LIMIT_CODE + ' + 无 access-control-*。平台放开限制后可用以下命令复验：curl.exe -s -i -X POST "' + ctx.baseUrl + '/push" -H "content-type: application/json" --data-binary @body.bin（body.bin 由 buildBodyOfExactLength(N, $TOKEN, 0) 生成，N 取 102400 / 102401 等边界值）');
  }
  return ceilingSummary(ctx, evidence);
}

function ceilingSummary(ctx, evidence) {
  return {
    passed: ctx.passed,
    failed: ctx.failed,
    failures: ctx.failures,
    findings: ctx.findings,
    requestsUsed: ctx.requestsUsed,
    requestsBudget: MAX_REQUESTS,
    notes: ctx.notes,
    evidence,
    accounts: Object.fromEntries(Object.entries(ctx.accounts).map(([k, v]) => [k, { userId: v.userId, hasToken: Boolean(v.token) }])),
    cleanupSql: CLEANUP_SQL,
  };
}

// ---------- 汇总 ----------

function scanLeaks(ctx) {
  const needles = [
    ['DATABASE_URL', '连接串环境变量名'],
    ['CLOUDBASE_APIKEY', 'API Key 环境变量名'],
    ['api.tcloudbasegateway.com', '云开发 SQL 网关地址'],
    ['cloudbase_postgres', '数据库管理角色名'],
    ['pwd_hash', '口令哈希字段名'],
    ['pwd_salt', '口令盐字段名'],
    ['recovery_hash', '恢复码哈希字段名'],
    ['Fuzz_pass_123', '测试账号明文口令'],
    ['Fuzz_main_456', '测试账号新口令'],
    ['Fuzz_888', '测试账号明文口令'],
  ];
  for (const sample of ctx.leakScan) {
    if (/Password|PASSWORD|secret/i.test(sample.label)) continue;
    for (const [needle, what] of needles) {
      if (sample.text.indexOf(needle) === -1) continue;
      addFinding(ctx, {
        id: 'f-leak-' + needle.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        endpoint: '任意接口的响应体',
        严重度: '高（服务端内部信息/凭证外泄）',
        request: '见 fuzz.api.mjs 中 label=' + sample.label + ' 的请求',
        actual: '响应体里出现 ' + what + '（' + needle + '）',
        expected: '响应体只含协议字段（error/message/rev/token…），永不回显内部标识与凭证明文',
        verdict: '响应泄漏服务端内部信息',
      });
    }
  }
}

function summary(ctx) {
  scanLeaks(ctx);
  return {
    passed: ctx.passed,
    failed: ctx.failed,
    failures: ctx.failures,
    findings: ctx.findings,
    requestsUsed: ctx.requestsUsed,
    requestsBudget: MAX_REQUESTS,
    notes: ctx.notes,
    log: ctx.log,
    accounts: Object.fromEntries(Object.entries(ctx.accounts).map(([k, v]) => [k, { userId: v.userId, hasToken: Boolean(v.token) }])),
    cleanupSql: CLEANUP_SQL,
    finalRev: ctx.rev,
  };
}

function dryRun(baseUrl) {
  return {
    passed: 0,
    failed: 0,
    failures: [],
    findings: [],
    requestsUsed: 0,
    requestsBudget: MAX_REQUESTS,
    skipped: true,
    baseUrl,
    note: '未联网：设置 HMS_FUZZ_API=1 才会真的发请求（默认干跑）',
    plan: PLAN.map(([g, desc, n]) => ({ group: g, desc, cases: n })),
    cleanupSql: CLEANUP_SQL,
  };
}

// ---------- 入口 ----------

export async function run(options) {
  const opts = options || {};
  const online = opts.online === true || process.env.HMS_FUZZ_API === '1';
  const baseUrl = opts.baseUrl || process.env.HMS_FUZZ_API_BASE || DEFAULT_BASE;
  if (!online) return dryRun(baseUrl);

  const ctx = createContext(baseUrl.replace(/\/+$/, ''));
  const groups = [
    ['cors', groupCors],
    ['method', groupMethod],
    ['body', groupMalformedBody],
    ['register', groupRegisterValidation],
    ['token', groupToken],
    ['push-valid', groupPushValidation],
    ['payload-fault', groupPayloadFaults],
    ['race', groupRace],
    ['lockout', groupLockout],
    ['enum+reset', groupEnumerationAndReset],
  ];
  for (const [name, fn] of groups) {
    const before = ctx.requestsUsed;
    try {
      await fn(ctx);
    } catch (err) {
      if (err instanceof BudgetError) {
        ctx.failures.push({ name: name + ' 组被预算中断', got: String(err.message), expected: '预算内完成' });
        ctx.failed += 1;
        break;
      }
      ctx.failures.push({ name: name + ' 组抛异常', got: String((err && err.stack) || err), expected: '无异常' });
      ctx.failed += 1;
    }
    ctx.log.push({ label: '#' + name, requests: ctx.requestsUsed - before });
    await sleep(120);
  }
  return summary(ctx);
}

function report(summaryOut) {
  if (summaryOut.skipped) {
    console.log('干跑（未联网）。用例组：');
    for (const p of summaryOut.plan) console.log('- ' + p.group.padEnd(14) + ' ' + String(p.cases).padStart(2) + ' 例  ' + p.desc);
    console.log('\n设 HMS_FUZZ_API=1 才会真的发请求。清理 SQL：');
    for (const s of summaryOut.cleanupSql) console.log('  ' + s);
    return summaryOut;
  }
  console.log('=== 请求用量 ===');
  console.log('requestsUsed=' + summaryOut.requestsUsed + ' / ' + summaryOut.requestsBudget);
  console.log('passed=' + summaryOut.passed + ' failed=' + summaryOut.failed + ' findings=' + summaryOut.findings.length);
  console.log('\n=== findings ===');
  for (const f of summaryOut.findings) {
    console.log('[' + f.严重度 + '] ' + f.id + '  ' + f.端点);
    console.log('  实际: ' + clip(f.实际响应, 400));
    console.log('  期望: ' + clip(f.期望, 300));
    console.log('  判断: ' + clip(f.判断, 300));
    console.log('  复现: ' + clip(f.请求, 600) + '\n');
  }
  console.log('=== 未通过断言 ===');
  for (const f of summaryOut.failures) console.log('- ' + f.name + '\n    实际: ' + f.got + '\n    期望: ' + f.expected);
  console.log('\n=== notes ===');
  for (const n of summaryOut.notes) console.log('- ' + n.id + ': ' + n.说明);
  return summaryOut;
}

if (process.argv[1] && process.argv[1].endsWith('fuzz.api.mjs')) {
  const ceilingOnly = process.argv.includes('--ceiling');
  const out = ceilingOnly ? await probePayloadCeiling({}) : await run();
  if (ceilingOnly) {
    console.log('=== ceiling 探测（独立入口）===');
    console.log('requestsUsed=' + out.requestsUsed + ' / ' + out.requestsBudget + ' passed=' + out.passed + ' failed=' + out.failed);
    for (const e of out.evidence || []) console.log('  ' + JSON.stringify(e));
    for (const f of out.findings || []) console.log('[findings] ' + f.id + ' 实际: ' + clip(f.实际响应, 400));
  } else {
    report(out);
  }
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(out));
}
