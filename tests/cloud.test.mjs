/**
 * 云同步后端（cloud/functions/hms-api/index.js）端到端测试。
 *
 * 注入内存假数据库（只有 query(sql, params) 的语义），因此不依赖 PostgreSQL、不联网、不 require('pg')。
 * 覆盖：注册 / 登录 / 失败锁定 / 恢复码重置 / 推拉 / 版本冲突 / 输入校验 / 日志脱敏 / 云函数入口降级。
 */
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const api = (await import('../cloud/functions/hms-api/index.js')).default;
const RECOVERY_ALPHABET = api.RECOVERY_ALPHABET;
const CLOCK0 = 1700000000000; // 2023-11-14T22:13:20Z
const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_RE = new RegExp('^[' + RECOVERY_ALPHABET + ']{4}(-[' + RECOVERY_ALPHABET + ']{4}){3}$');

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

const PAYLOAD = {
  账号: '小明',
  weights: [{ date: '2024-05-01', kg: 68.5, note: '早上空腹' }],
  meals: [{ id: 'm1', name: '番茄炒蛋', kcal: 178 }],
  nested: { a: [1, 2, { b: '中文 😀 混排' }], c: null, d: true },
  version: 3,
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** 内存假数据库：按 cloud/functions/hms-api/index.js 里 SQL 常量的语义实现，行为对齐 node-postgres。 */
class FakeDb {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.snapshots = [];
    this.queries = [];
    this.seq = 0;
  }

  clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  wrapped(rows) {
    return { rowCount: rows.length, rows: rows };
  }

  userByLower(lower) {
    return this.users.find((u) => u.username_lower === lower) || null;
  }

  async query(sql, params) {
    const args = Array.isArray(params) ? params : [];
    const s = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push(s);

    if (s.startsWith('INSERT INTO users')) {
      if (this.userByLower(args[1])) return this.wrapped([]); // ON CONFLICT (username_lower) DO NOTHING
      this.seq += 1;
      const user = {
        id: this.seq,
        username: args[0],
        username_lower: args[1],
        pwd_hash: args[2],
        pwd_salt: args[3],
        recovery_hash: args[4],
        recovery_salt: args[5],
        fail_count: 0,
        locked_until: null,
        created_at: args[6],
      };
      this.users.push(user);
      return this.wrapped([{ id: user.id }]);
    }
    if (s.startsWith('SELECT id, pwd_hash, pwd_salt, fail_count, locked_until FROM users')) {
      const u = this.userByLower(args[0]);
      if (!u) return this.wrapped([]);
      return this.wrapped([
        {
          id: u.id,
          pwd_hash: u.pwd_hash,
          pwd_salt: u.pwd_salt,
          fail_count: u.fail_count,
          locked_until: this.clone(u.locked_until),
        },
      ]);
    }
    if (s.startsWith('SELECT id, recovery_hash, recovery_salt FROM users')) {
      const u = this.userByLower(args[0]);
      if (!u) return this.wrapped([]);
      return this.wrapped([{ id: u.id, recovery_hash: u.recovery_hash, recovery_salt: u.recovery_salt }]);
    }
    if (s.startsWith('UPDATE users SET fail_count = fail_count + 1')) {
      const u = this.users.find((x) => x.id === args[0]);
      if (!u) return this.wrapped([]);
      u.fail_count += 1;
      return this.wrapped([{ fail_count: u.fail_count }]);
    }
    if (s.startsWith('UPDATE users SET locked_until = $2, fail_count = 0')) {
      const u = this.users.find((x) => x.id === args[0]);
      if (!u) return this.wrapped([]);
      u.locked_until = args[1];
      u.fail_count = 0;
      return this.wrapped([{ locked_until: this.clone(u.locked_until) }]);
    }
    if (s.startsWith('UPDATE users SET fail_count = 0, locked_until = NULL')) {
      const u = this.users.find((x) => x.id === args[0]);
      if (!u) return this.wrapped([]);
      u.fail_count = 0;
      u.locked_until = null;
      return this.wrapped([]);
    }
    if (s.startsWith('UPDATE users SET pwd_hash = $2')) {
      const u = this.users.find((x) => x.id === args[0]);
      if (!u) return this.wrapped([]);
      u.pwd_hash = args[1];
      u.pwd_salt = args[2];
      u.fail_count = 0;
      u.locked_until = null;
      return this.wrapped([]);
    }
    if (s.startsWith('INSERT INTO sessions')) {
      const tokenHash = args[0];
      const existing = this.sessions.find((x) => x.token_hash === tokenHash);
      if (existing) {
        existing.user_id = args[1];
        existing.created_at = args[2];
        existing.expires_at = args[3];
      } else {
        this.sessions.push({ token_hash: tokenHash, user_id: args[1], created_at: args[2], expires_at: args[3] });
      }
      return this.wrapped([]);
    }
    if (s.startsWith('SELECT user_id, expires_at FROM sessions')) {
      const row = this.sessions.find((x) => x.token_hash === args[0]);
      if (!row) return this.wrapped([]);
      return this.wrapped([{ user_id: row.user_id, expires_at: this.clone(row.expires_at) }]);
    }
    if (s.startsWith('DELETE FROM sessions WHERE user_id = $1')) {
      const before = this.sessions.length;
      this.sessions = this.sessions.filter((x) => x.user_id !== args[0]);
      return { rowCount: before - this.sessions.length, rows: [] };
    }
    if (s.startsWith('SELECT rev, saved_at, payload FROM snapshots')) {
      const snap = this.snapshots.find((x) => x.user_id === args[0]);
      if (!snap) return this.wrapped([]);
      return this.wrapped([
        { rev: snap.rev, saved_at: this.clone(snap.saved_at), payload: this.clone(snap.payload) },
      ]);
    }
    if (s.startsWith('SELECT rev FROM snapshots')) {
      const snap = this.snapshots.find((x) => x.user_id === args[0]);
      if (!snap) return this.wrapped([]);
      return this.wrapped([{ rev: snap.rev }]);
    }
    if (s.startsWith('INSERT INTO snapshots')) {
      const userId = args[0];
      const rev = args[1];
      const savedAt = args[2];
      const payload = JSON.parse(args[3]); // $4::jsonb 的真实效果
      const baseRev = args[4];
      const snap = this.snapshots.find((x) => x.user_id === userId);
      if (!snap) {
        this.snapshots.push({ user_id: userId, rev: rev, saved_at: savedAt, payload: payload });
        return this.wrapped([{ rev: rev }]);
      }
      if (snap.rev !== baseRev) return this.wrapped([]); // ON CONFLICT ... WHERE snapshots.rev = $5 未命中
      snap.rev = rev;
      snap.saved_at = savedAt;
      snap.payload = payload;
      return this.wrapped([{ rev: rev }]);
    }
    throw new Error('FakeDb 未实现的语句: ' + s.slice(0, 90));
  }

  dump() {
    return structuredClone({ users: this.users, sessions: this.sessions, snapshots: this.snapshots });
  }
}

function makeEnv(startClock) {
  const state = { clock: typeof startClock === 'number' ? startClock : CLOCK0 };
  const db = new FakeDb();
  const logs = [];
  const logger = {
    log: function () {
      logs.push(Array.prototype.map.call(arguments, (a) => String(a)).join(' '));
    },
  };
  const handler = api.createHandler({
    db: db,
    now: () => state.clock,
    randomBytes: randomBytes,
    logger: logger,
  });
  const req = async (path, body, method) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await handler({ httpMethod: method || 'POST', path: path, body: payload });
    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
  };
  return { state: state, db: db, logs: logs, handler: handler, req: req };
}

async function run() {
  const failures = [];
  let passed = 0;
  const check = (name, ok, detail) => {
    if (ok) {
      passed += 1;
      return;
    }
    failures.push({ name: name, error: detail || '断言失败' });
  };

  // ==================== 1. 注册 ====================
  const env1 = makeEnv();
  const reg = await env1.req('/register', { username: 'Alice_01', password: 'secret-pass-1' });
  check('注册成功返回 200', reg.status === 200, '实际 ' + reg.status + ' ' + reg.raw);
  check('注册返回正整数 userId', Number.isInteger(reg.body.userId) && reg.body.userId > 0, reg.raw);
  const code1 = reg.body.recoveryCode;
  check('恢复码形如 4 组 × 4 字符', typeof code1 === 'string' && code1.split('-').length === 4 && code1.split('-').every((g) => g.length === 4), String(code1));
  check('恢复码只在 Base32 去掉 0O1I 后的 30 字符集里选', RECOVERY_RE.test(code1), String(code1));
  check('恢复码不含易混字符 0 O 1 I', !/[01OI]/.test(String(code1)), String(code1));

  const user1 = env1.db.dump().users[0];
  check('用户名入库统一小写（username_lower）', user1.username_lower === 'alice_01' && user1.username === 'Alice_01', JSON.stringify(user1.username));
  check('库里不存明文密码（存 64 位十六进制哈希）', user1.pwd_hash !== 'secret-pass-1' && /^[0-9a-f]{64}$/.test(user1.pwd_hash), user1.pwd_hash);
  check('每个用户独立 16 字节随机盐', /^[0-9a-f]{32}$/.test(user1.pwd_salt) && user1.pwd_salt !== user1.recovery_salt, user1.pwd_salt);
  const recomputed = scryptSync('secret-pass-1', Buffer.from(user1.pwd_salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  check('密码哈希 = scrypt(N=16384,r=8,p=1,keylen=32) + 该用户盐', recomputed === user1.pwd_hash, '算得 ' + recomputed.slice(0, 16) + '… 库里 ' + user1.pwd_hash.slice(0, 16) + '…');
  const recoveryRecomputed = scryptSync(api.normalizeRecoveryCode(code1), Buffer.from(user1.recovery_salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  check('恢复码同样只存盐 + 哈希（规范化后再哈希）', user1.recovery_hash !== code1 && recoveryRecomputed === user1.recovery_hash, user1.recovery_hash.slice(0, 16) + '…');
  check('注册响应只有 userId 与 recoveryCode 两个字段', Object.keys(reg.body).sort().join(',') === 'recoveryCode,userId', reg.raw);

  const dupSame = await env1.req('/register', { username: 'Alice_01', password: 'another-pass-1' });
  check('用户名重复 → 409 conflict', dupSame.status === 409 && dupSame.body.error === 'conflict', dupSame.status + ' ' + dupSame.raw);
  const dupCase = await env1.req('/register', { username: 'ALICE_01', password: 'another-pass-1' });
  check('用户名大小写不敏感唯一（ALICE_01 也 409）', dupCase.status === 409, String(dupCase.status));

  const badNames = [
    ['ab', '太短'],
    ['a'.repeat(33), '太长'],
    ['bad name', '含空格'],
    ['bad-name', '含连字符'],
    ['用户1234', '含中文'],
    ['', '空串'],
  ];
  for (const [name, why] of badNames) {
    const res = await env1.req('/register', { username: name, password: 'secret-pass-1' });
    check('非法用户名（' + why + '）→ 400 bad-request', res.status === 400 && res.body.error === 'bad-request', res.status + ' ' + res.raw);
  }
  const shortPwd = await env1.req('/register', { username: 'bob_2024', password: 'short7c' });
  check('密码不足 8 字符 → 400', shortPwd.status === 400 && shortPwd.body.error === 'bad-request', shortPwd.status + ' ' + shortPwd.raw);
  const numPwd = await env1.req('/register', { username: 'bob_2024', password: 12345678 });
  check('密码不是字符串 → 400', numPwd.status === 400, String(numPwd.status));
  const noPwd = await env1.req('/register', { username: 'bob_2024' });
  check('缺 password 字段 → 400', noPwd.status === 400, String(noPwd.status));

  // ==================== 2. 登录与会话存储形态 ====================
  const badPwd = await env1.req('/login', { username: 'alice_01', password: 'wrong-pass-999' });
  const ghost = await env1.req('/login', { username: 'nobody_here', password: 'wrong-pass-999' });
  check('密码错误 → 401 unauthorized', badPwd.status === 401 && badPwd.body.error === 'unauthorized', badPwd.status + ' ' + badPwd.raw);
  check('未注册用户名 → 同样 401', ghost.status === 401, String(ghost.status));
  check('两种失败的响应体逐字节相同（无用户名枚举）', badPwd.raw === ghost.raw, badPwd.raw + ' vs ' + ghost.raw);
  check('失败文案不含「不存在 / 未注册」之类暗示', !/不存在|未注册|无此/.test(badPwd.raw), badPwd.raw);

  const login1 = await env1.req('/login', { username: 'Alice_01', password: 'secret-pass-1' });
  check('登录成功返回 token / userId / expiresAt', login1.status === 200 && typeof login1.body.token === 'string' && login1.body.userId === user1.id && typeof login1.body.expiresAt === 'number', login1.raw);
  const token1 = login1.body.token;
  check('token 是 32 字节随机数的十六进制（64 位）', /^[0-9a-f]{64}$/.test(token1), token1);
  check('expiresAt = 签发时间 + 30 天', login1.body.expiresAt === CLOCK0 + 30 * DAY_MS, String(login1.body.expiresAt));
  const dump1 = env1.db.dump();
  const sessionRow = dump1.sessions.find((s) => s.token_hash === sha256(token1));
  check('库里存的是 sha256(token) 而不是 token 明文', Boolean(sessionRow) && sessionRow.token_hash !== token1, JSON.stringify(dump1.sessions[0] || null));
  check('整库快照里都搜不到 token 明文', !JSON.stringify(dump1).includes(token1), 'token 明文出现在库里');
  check('会话表只有四列且不含明文 token 列', Object.keys(sessionRow).sort().join(',') === 'created_at,expires_at,token_hash,user_id', Object.keys(sessionRow).join(','));
  check('登录成功后 fail_count 归零', env1.db.dump().users[0].fail_count === 0, String(env1.db.dump().users[0].fail_count));

  // ==================== 3. 连续失败锁定 ====================
  const env2 = makeEnv();
  await env2.req('/register', { username: 'lockee_01', password: 'lock-pass-123' });
  const failStatuses = [];
  for (let i = 0; i < 10; i += 1) {
    failStatuses.push((await env2.req('/login', { username: 'lockee_01', password: 'nope-nope-1' })).status);
  }
  check('前 9 次失败都是 401', failStatuses.slice(0, 9).every((s) => s === 401), failStatuses.join(','));
  check('第 10 次失败仍是 401（失败本身不改成 423）', failStatuses[9] === 401, failStatuses.join(','));
  const lockedAt = env2.db.dump().users[0].locked_until;
  check('第 10 次失败后写入 locked_until = now + 15 分钟', lockedAt instanceof Date && lockedAt.getTime() === CLOCK0 + 15 * 60 * 1000, String(lockedAt));
  const lockedTry = await env2.req('/login', { username: 'lockee_01', password: 'lock-pass-123' });
  check('第 11 次（密码正确也）→ 423 locked', lockedTry.status === 423 && lockedTry.body.error === 'locked', lockedTry.status + ' ' + lockedTry.raw);
  const lockedWrong = await env2.req('/login', { username: 'lockee_01', password: 'still-wrong-1' });
  check('锁定期间密码错误同样 → 423', lockedWrong.status === 423, String(lockedWrong.status));
  check('锁定期间不再累加失败计数', env2.db.dump().users[0].fail_count === 0, String(env2.db.dump().users[0].fail_count));

  env2.state.clock += 15 * 60 * 1000 + 1;
  const unlocked = await env2.req('/login', { username: 'lockee_01', password: 'lock-pass-123' });
  check('锁定到期后正确密码可登录', unlocked.status === 200 && typeof unlocked.body.token === 'string', unlocked.status + ' ' + unlocked.raw);
  check('解锁登录后 locked_until 被清空、fail_count 归零', env2.db.dump().users[0].locked_until === null && env2.db.dump().users[0].fail_count === 0, JSON.stringify(env2.db.dump().users[0].locked_until));

  // ==================== 4. 会话有效性 ====================
  const env3 = makeEnv();
  const reg3 = await env3.req('/register', { username: 'tok_user', password: 'tok-pass-1234' });
  const token3 = (await env3.req('/login', { username: 'tok_user', password: 'tok-pass-1234' })).body.token;
  const noToken = await env3.req('/pull', {});
  check('无 token 字段 → 401 unauthorized（按认证失败处理）', noToken.status === 401 && noToken.body.error === 'unauthorized', noToken.status + ' ' + noToken.raw);
  const emptyToken = await env3.req('/pull', { token: '' });
  check('token 为空串 → 401', emptyToken.status === 401, String(emptyToken.status));
  const numToken = await env3.req('/pull', { token: 12345 });
  check('token 不是字符串 → 400 bad-request（类型非法）', numToken.status === 400 && numToken.body.error === 'bad-request', numToken.status + ' ' + numToken.raw);
  const fakeToken = await env3.req('/pull', { token: 'f'.repeat(64) });
  check('假 token → 401', fakeToken.status === 401, String(fakeToken.status));
  const goodPull = await env3.req('/pull', { token: token3 });
  check('真 token 可通过（此时还没有快照）', goodPull.status === 200 && goodPull.body.rev === 0, goodPull.raw);
  env3.state.clock += 30 * DAY_MS + 1;
  const expired = await env3.req('/pull', { token: token3 });
  check('过期 token（30 天后）→ 401', expired.status === 401, String(expired.status));
  check('过期 token 的数据没被删（只是拒绝服务）', env3.db.dump().sessions.length === 1, String(env3.db.dump().sessions.length));
  const expiredPush = await env3.req('/push', { token: token3, baseRev: 0, payload: { a: 1 } });
  check('过期 token 不能 push（401，且库里没有快照）', expiredPush.status === 401 && env3.db.dump().snapshots.length === 0, expiredPush.status + ' 快照 ' + env3.db.dump().snapshots.length);
  env3.state.clock -= 30 * DAY_MS + 1;

  // ==================== 5. 推拉与版本冲突 ====================
  const env4 = makeEnv();
  await env4.req('/register', { username: 'sync_user', password: 'sync-pass-123' });
  const token4 = (await env4.req('/login', { username: 'sync_user', password: 'sync-pass-123' })).body.token;
  const empty = await env4.req('/pull', { token: token4 });
  check('pull 无快照 → { rev: 0, savedAt: null, payload: null }', empty.status === 200 && empty.body.rev === 0 && empty.body.savedAt === null && empty.body.payload === null, empty.raw);
  check('空快照响应只有 rev / savedAt / payload 三个字段', Object.keys(empty.body).sort().join(',') === 'payload,rev,savedAt', Object.keys(empty.body).join(','));

  const push1 = await env4.req('/push', { token: token4, baseRev: 0, payload: PAYLOAD });
  check('push baseRev=0 首次写入 → 200 { rev: 1 }', push1.status === 200 && push1.body.rev === 1 && Object.keys(push1.body).join(',') === 'rev', push1.status + ' ' + push1.raw);
  const pulled1 = await env4.req('/pull', { token: token4 });
  check('pull 返回 rev = 1 与毫秒 savedAt', pulled1.body.rev === 1 && pulled1.body.savedAt === CLOCK0, JSON.stringify({ rev: pulled1.body.rev, savedAt: pulled1.body.savedAt }));
  check('pull 的 payload 与 push 进去的深度相等（含中文与嵌套）', deepEqual(pulled1.body.payload, PAYLOAD), JSON.stringify(pulled1.body.payload).slice(0, 200));
  check('库里 payload 是 jsonb 对象而不是字符串', typeof env4.db.dump().snapshots[0].payload === 'object' && env4.db.dump().snapshots[0].payload !== null, typeof env4.db.dump().snapshots[0].payload);

  const stale = await env4.req('/push', { token: token4, baseRev: 0, payload: { hijacked: true } });
  check('过期 baseRev → 409 error=rev-conflict', stale.status === 409 && stale.body.error === 'rev-conflict', stale.status + ' ' + stale.raw);
  check('409 带上服务器当前 rev', stale.body.rev === 1, stale.raw);
  check('409 响应体只有 error 与 rev（协议的例外形状）', Object.keys(stale.body).sort().join(',') === 'error,rev', Object.keys(stale.body).join(','));
  const afterConflict = await env4.req('/pull', { token: token4 });
  check('冲突后服务器数据没有被覆盖', deepEqual(afterConflict.body.payload, PAYLOAD) && afterConflict.body.rev === 1, JSON.stringify(afterConflict.body.payload).slice(0, 120));
  const push2 = await env4.req('/push', { token: token4, baseRev: 1, payload: { 账号: '小红', weights: [{ kg: 55 }] } });
  check('baseRev=1 再次写入 → rev 2', push2.status === 200 && push2.body.rev === 2, push2.raw);
  const pulled2 = await env4.req('/pull', { token: token4 });
  check('第二次 pull 深度等于第二次 push 的内容', deepEqual(pulled2.body.payload, { 账号: '小红', weights: [{ kg: 55 }] }), JSON.stringify(pulled2.body.payload));
  const race = await env4.req('/push', { token: token4, baseRev: 1, payload: { again: true } });
  check('第二次过期 baseRev → 409 且 rev = 2', race.status === 409 && race.body.rev === 2, race.raw);
  const otherUser = await env4.req('/register', { username: 'other_user', password: 'other-pass-123' });
  check('新账号 userId 自增且互不影响', otherUser.body.userId === 2, JSON.stringify(otherUser.body.userId));
  const otherToken = (await env4.req('/login', { username: 'other_user', password: 'other-pass-123' })).body.token;
  const otherPull = await env4.req('/pull', { token: otherToken });
  check('每个账号一条快照：新账号 pull 仍是空快照', otherPull.status === 200 && otherPull.body.rev === 0 && otherPull.body.payload === null, otherPull.raw);

  // ==================== 6. 恢复码重置密码 ====================
  const env5 = makeEnv();
  const reg5 = await env5.req('/register', { username: 'resetme_01', password: 'old-pass-1234' });
  const code5 = reg5.body.recoveryCode;
  const oldToken = (await env5.req('/login', { username: 'resetme_01', password: 'old-pass-1234' })).body.token;
  const wrongCode = await env5.req('/reset', { username: 'resetme_01', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'new-pass-1234' });
  check('恢复码错误 → 401 unauthorized', wrongCode.status === 401 && wrongCode.body.error === 'unauthorized', wrongCode.status + ' ' + wrongCode.raw);
  const ghostReset = await env5.req('/reset', { username: 'ghost_user', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'new-pass-1234' });
  check('未注册用户名重置 → 与恢复码错误逐字节相同的 401', ghostReset.status === 401 && ghostReset.raw === wrongCode.raw, ghostReset.raw + ' vs ' + wrongCode.raw);
  const malformedCode = await env5.req('/reset', { username: 'resetme_01', recoveryCode: 'ZZZZ', newPassword: 'new-pass-1234' });
  check('恢复码格式非法 → 400 bad-request', malformedCode.status === 400 && malformedCode.body.error === 'bad-request', malformedCode.raw);
  check('恢复码错误时旧密码仍然有效', (await env5.req('/login', { username: 'resetme_01', password: 'old-pass-1234' })).status === 200);
  const shortNew = await env5.req('/reset', { username: 'resetme_01', recoveryCode: code5, newPassword: 'short' });
  check('新密码太短 → 400 且不改动密码', shortNew.status === 400 && (await env5.req('/login', { username: 'resetme_01', password: 'old-pass-1234' })).status === 200, String(shortNew.status));

  const resetOk = await env5.req('/reset', {
    username: 'resetme_01',
    recoveryCode: code5.toLowerCase().split('-').join(' '),
    newPassword: 'new-pass-1234',
  });
  check('正确恢复码（容忍小写与空格）→ 200 { ok: true }', resetOk.status === 200 && resetOk.body.ok === true && Object.keys(resetOk.body).join(',') === 'ok', resetOk.status + ' ' + resetOk.raw);
  const deadPull = await env5.req('/pull', { token: oldToken });
  check('重置后旧 token 立即失效 → 401', deadPull.status === 401, String(deadPull.status));
  check('重置把该账号所有会话从库里删掉', env5.db.dump().sessions.length === 0, String(env5.db.dump().sessions.length));
  const oldPwdLogin = await env5.req('/login', { username: 'resetme_01', password: 'old-pass-1234' });
  check('旧密码不再能登录 → 401', oldPwdLogin.status === 401, String(oldPwdLogin.status));
  const newPwdLogin = await env5.req('/login', { username: 'resetme_01', password: 'new-pass-1234' });
  check('新密码可以登录', newPwdLogin.status === 200 && typeof newPwdLogin.body.token === 'string', newPwdLogin.status + ' ' + newPwdLogin.raw);
  const resetAgain = await env5.req('/reset', { username: 'resetme_01', recoveryCode: code5, newPassword: 'third-pass-123' });
  check('恢复码可重复使用（协议只能回 { ok: true }，无法下发新码）', resetAgain.status === 200, String(resetAgain.status));

  const env6 = makeEnv();
  const reg6 = await env6.req('/register', { username: 'locked_reset', password: 'locked-pass-1' });
  for (let i = 0; i < 10; i += 1) await env6.req('/login', { username: 'locked_reset', password: 'bad-pass-123' });
  check('被锁定的账号当前返回 423', (await env6.req('/login', { username: 'locked_reset', password: 'locked-pass-1' })).status === 423);
  check('锁定状态在库里可见（locked_until 非空）', env6.db.dump().users[0].locked_until !== null, String(env6.db.dump().users[0].locked_until));
  const lockedReset = await env6.req('/reset', { username: 'locked_reset', recoveryCode: reg6.body.recoveryCode, newPassword: 'fresh-pass-123' });
  check('锁定期间仍能用恢复码重置来解锁', lockedReset.status === 200, lockedReset.status + ' ' + lockedReset.raw);
  const unlockedAfterReset = await env6.req('/login', { username: 'locked_reset', password: 'fresh-pass-123' });
  check('重置后锁定被清除，新密码可登录', unlockedAfterReset.status === 200 && env6.db.dump().users[0].locked_until === null, unlockedAfterReset.status + ' ' + unlockedAfterReset.raw);

  // ==================== 7. 输入校验 ====================
  const env7 = makeEnv();
  await env7.req('/register', { username: 'valid_user', password: 'valid-pass-123' });
  const token7 = (await env7.req('/login', { username: 'valid_user', password: 'valid-pass-123' })).body.token;
  const badJson = await env7.req('/login', '{这不是 JSON');
  check('非法 JSON body → 400 bad-request', badJson.status === 400 && badJson.body.error === 'bad-request', badJson.raw);
  const arrayBody = await env7.req('/login', '[1,2,3]');
  check('body 是数组 → 400', arrayBody.status === 400, String(arrayBody.status));
  const emptyBody = await env7.req('/login', '');
  check('body 是空串 → 400', emptyBody.status === 400, String(emptyBody.status));
  const missingPwd = await env7.req('/login', { username: 'valid_user' });
  check('login 缺 password → 400', missingPwd.status === 400, String(missingPwd.status));
  const missingUser = await env7.req('/login', { password: 'valid-pass-123' });
  check('login 缺 username → 400', missingUser.status === 400, String(missingUser.status));
  const missingRecovery = await env7.req('/reset', { username: 'valid_user', newPassword: 'valid-pass-123' });
  check('reset 缺 recoveryCode → 400', missingRecovery.status === 400, String(missingRecovery.status));
  const arrayPayload = await env7.req('/push', { token: token7, baseRev: 0, payload: [1, 2, 3] });
  check('payload 是数组 → 400', arrayPayload.status === 400 && arrayPayload.body.error === 'bad-request', arrayPayload.raw);
  const stringPayload = await env7.req('/push', { token: token7, baseRev: 0, payload: 'nope' });
  check('payload 是字符串 → 400', stringPayload.status === 400, String(stringPayload.status));
  const nullPayload = await env7.req('/push', { token: token7, baseRev: 0, payload: null });
  check('payload 是 null → 400', nullPayload.status === 400, String(nullPayload.status));
  const missingPayload = await env7.req('/push', { token: token7, baseRev: 0 });
  check('push 缺 payload → 400', missingPayload.status === 400, String(missingPayload.status));
  const missingRev = await env7.req('/push', { token: token7, payload: {} });
  check('push 缺 baseRev → 400', missingRev.status === 400, String(missingRev.status));
  const stringRev = await env7.req('/push', { token: token7, baseRev: '0', payload: {} });
  check('baseRev 是字符串 → 400（不接受隐式转换）', stringRev.status === 400, String(stringRev.status));
  const nullRev = await env7.req('/push', '{ "token": "' + token7 + '", "baseRev": null, "payload": {} }');
  check('baseRev 是 null → 400（NaN 类输入）', nullRev.status === 400, String(nullRev.status));
  const floatRev = await env7.req('/push', { token: token7, baseRev: 1.5, payload: {} });
  check('baseRev 是小数 → 400', floatRev.status === 400, String(floatRev.status));
  const negRev = await env7.req('/push', { token: token7, baseRev: -1, payload: {} });
  check('baseRev 是负数 → 400', negRev.status === 400, String(negRev.status));
  const hugePayload = await env7.req('/push', { token: token7, baseRev: 0, payload: { big: 'x'.repeat(8 * 1024 * 1024 + 16) } });
  check('payload 超过 8MB → 400（不写库）', hugePayload.status === 400 && env7.db.dump().snapshots.length === 0, String(hugePayload.status));
  const hugeBody = await env7.req('/login', 'x'.repeat(9 * 1024 * 1024 + 16));
  check('请求体超过 9MB → 400（不尝试解析）', hugeBody.status === 400, String(hugeBody.status));
  const unknownPath = await env7.req('/nope', {});
  check('未知路径 → 404 not-found', unknownPath.status === 404 && unknownPath.body.error === 'not-found', unknownPath.status + ' ' + unknownPath.raw);
  const rootPath = await env7.req('/', {});
  check('空路径 → 404', rootPath.status === 404, String(rootPath.status));
  const getLogin = await env7.req('/login', { username: 'valid_user', password: 'valid-pass-123' }, 'GET');
  check('GET 方法 → 404（协议只允许 POST）', getLogin.status === 404 && getLogin.body.error === 'not-found', String(getLogin.status));
  const emptyUserLogin = await env7.req('/login', { username: '  ', password: 'valid-pass-123' });
  check('username 全是空格 → 400', emptyUserLogin.status === 400, String(emptyUserLogin.status));

  const objBodyRes = await env7.handler({ httpMethod: 'POST', path: '/api/pull', body: { token: 'deadbeef' } });
  check('网关已解析 body（对象）+ 带前缀路径也能路由 → 401', objBodyRes.statusCode === 401, String(objBodyRes.statusCode));
  const b64Res = await env7.handler({
    httpMethod: 'POST',
    path: '/pull',
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ token: 'deadbeef' }), 'utf8').toString('base64'),
  });
  check('isBase64Encoded 的事件体可以解析 → 401', b64Res.statusCode === 401, String(b64Res.statusCode));
  check('响应头是 application/json', objBodyRes.headers['content-type'].indexOf('application/json') === 0, objBodyRes.headers['content-type']);
  const nullEvent = await env7.handler(null);
  check('处理器对彻底非法的 event 也不抛异常，返回合法 JSON 错误体', nullEvent.statusCode === 400 && JSON.parse(nullEvent.body).error === 'bad-request', JSON.stringify(nullEvent));

  // ==================== 8. 500 / 日志脱敏 ====================
  const captured = [];
  const secretPassword = 'leak-check-9999';
  const secretToken = 'a'.repeat(64);
  const boom = new Error('db down pwd=' + secretPassword + ' token=' + secretToken + ' url=postgres://user:pw@host:5432/db');
  boom.code = '08006';
  const brokenHandler = api.createHandler({
    db: {
      query: async () => {
        throw boom;
      },
    },
    now: () => CLOCK0,
    randomBytes: randomBytes,
    logger: {
      log: function () {
        captured.push(Array.prototype.map.call(arguments, (a) => String(a)).join(' '));
      },
    },
  });
  const res500 = await brokenHandler({
    httpMethod: 'POST',
    path: '/login',
    body: JSON.stringify({ username: 'boom_user', password: secretPassword }),
  });
  const body500 = JSON.parse(res500.body);
  check('数据库炸了 → 500 server-error（不抛未捕获异常）', res500.statusCode === 500 && body500.error === 'server-error', res500.statusCode + ' ' + res500.body);
  const logText = captured.join('\n');
  check('日志不含密码', logText.indexOf(secretPassword) === -1, logText);
  check('日志不含 token', logText.indexOf(secretToken) === -1, logText);
  check('日志不含连接串', logText.indexOf('postgres://') === -1 && logText.indexOf('DATABASE_URL') === -1, logText);
  check('500 响应体不含底层错误信息', res500.body.indexOf('db down') === -1 && res500.body.indexOf(secretPassword) === -1, res500.body);
  check('日志仍记录 status 与错误类别便于排查', logText.indexOf('"status":500') !== -1 && logText.indexOf('08006') !== -1, logText);
  check('正常请求的日志也不含 token 与密码', env1.logs.join('\n').indexOf(token1) === -1 && env1.logs.join('\n').indexOf('secret-pass-1') === -1, env1.logs.join('\n').slice(0, 300));
  check('正常请求日志记录了路由与状态码', env1.logs.join('\n').indexOf('"route":"login"') !== -1 && env1.logs.join('\n').indexOf('"status":200') !== -1, env1.logs.join('\n').slice(0, 300));

  const consoleLines = [];
  const originalLog = console.log;
  let mainRes = null;
  console.log = function () {
    consoleLines.push(Array.prototype.map.call(arguments, (a) => String(a)).join(' '));
  };
  try {
    mainRes = await api.main({ httpMethod: 'POST', path: '/pull', body: JSON.stringify({ token: 'deadbeef' }) });
  } finally {
    console.log = originalLog;
  }
  check('本机没有 pg / 没有 DATABASE_URL 时 main 返回 500 而不是崩溃', Boolean(mainRes) && mainRes.statusCode === 500 && JSON.parse(mainRes.body).error === 'server-error', JSON.stringify(mainRes));
  check('main 的响应与日志都不含 DATABASE_URL 字样', String(mainRes.body).indexOf('DATABASE_URL') === -1 && consoleLines.join('\n').indexOf('DATABASE_URL') === -1, consoleLines.join('\n'));
  check('main 返回的是 CloudBase 集成响应形状（statusCode/headers/body）', Object.keys(mainRes).sort().join(',') === 'body,headers,statusCode', Object.keys(mainRes).join(','));
  check('resolveDatabaseUrl 缺失时抛错且不泄露内容', (() => {
    try {
      api.resolveDatabaseUrl({});
      return false;
    } catch (err) {
      return err.message.indexOf('DATABASE_URL') !== -1 && err.message.indexOf('://') === -1;
    }
  })(), 'resolveDatabaseUrl({})');

  // ==================== 9. 部署产物静态检查 ====================
  const schema = readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8');
  check('schema.sql 三张表都用 CREATE TABLE IF NOT EXISTS', ['users', 'sessions', 'snapshots'].every((t) => schema.indexOf('CREATE TABLE IF NOT EXISTS ' + t) !== -1), '缺表');
  check('schema.sql 的 username_lower 唯一', /username_lower\s+TEXT\s+NOT NULL UNIQUE/.test(schema), '没有 UNIQUE');
  check('schema.sql 的 sessions 主键是 token_hash', /token_hash\s+TEXT\s+PRIMARY KEY/.test(schema), '主键不对');
  check('schema.sql 的 snapshots 以 user_id 为主键且 payload 是 jsonb', /user_id\s+INTEGER\s+PRIMARY KEY/.test(schema) && /payload\s+JSONB/.test(schema), '快照表结构不对');
  check('schema.sql 建了必要索引', schema.indexOf('sessions_user_id_idx') !== -1 && schema.indexOf('sessions_expires_at_idx') !== -1, '缺索引');
  check('schema.sql 不含任何连接串或密码', schema.indexOf('postgres://') === -1 && schema.indexOf('DATABASE_URL=') === -1, 'schema 里出现连接串');

  const readme = readFileSync(new URL('../cloud/README.md', import.meta.url), 'utf8');
  check('README 给出可复制的 curl 注册与登录示例', readme.indexOf('curl') !== -1 && readme.indexOf('/register') !== -1 && readme.indexOf('/login') !== -1, '缺 curl 示例');
  check('README 说明 DATABASE_URL 环境变量怎么填', readme.indexOf('DATABASE_URL') !== -1, '没提环境变量');
  check('README 说明建表 SQL 在哪执行', readme.indexOf('schema.sql') !== -1, '没提 schema.sql');
  check('README 不含任何真实连接串', readme.indexOf('postgres://') === -1 && readme.indexOf('postgresql://') === -1, 'README 里出现连接串');

  const fnPkg = JSON.parse(readFileSync(new URL('../cloud/functions/hms-api/package.json', import.meta.url), 'utf8'));
  check('云函数 package.json 声明 pg 依赖且不是 ESM', fnPkg.dependencies && typeof fnPkg.dependencies.pg === 'string' && fnPkg.type === undefined, JSON.stringify(fnPkg));

  // ==================== 10. 前端适配器 js/cloud-api.js ====================
  const clientMod = await import('../js/cloud-api.js');
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url: url, init: init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 't-123', userId: 7, expiresAt: CLOCK0 + 30 * DAY_MS }),
    };
  };
  const client = clientMod.createCloudApi({ baseUrl: 'https://example.test/api/', fetchImpl: okFetch });
  const loginOut = await client.login('alice_01', 'secret-pass-1');
  check('cloud-api 把登录发到 POST <base>/login', calls[0].url === 'https://example.test/api/login' && calls[0].init.method === 'POST', JSON.stringify(calls[0].url));
  check('cloud-api 发送 JSON 头与协议字段', calls[0].init.headers['content-type'] === 'application/json' && JSON.parse(calls[0].init.body).username === 'alice_01', calls[0].init.body);
  check('cloud-api 原样返回服务器 JSON', loginOut.token === 't-123' && loginOut.userId === 7, JSON.stringify(loginOut));
  const conflictClient = clientMod.createCloudApi({
    baseUrl: 'https://example.test/api',
    fetchImpl: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: 'rev-conflict', rev: 3 }) }),
  });
  let thrown = null;
  try {
    await conflictClient.push('t-123', 2, { a: 1 });
  } catch (err) {
    thrown = err;
  }
  check('cloud-api 把 409 抛成带 rev 的 CloudApiError', thrown instanceof clientMod.CloudApiError && thrown.code === 'rev-conflict' && thrown.rev === 3 && thrown.isConflict === true, String(thrown && thrown.message));
  const lockedClient = clientMod.createCloudApi({
    baseUrl: 'https://example.test/api',
    fetchImpl: async () => ({ ok: false, status: 423, text: async () => JSON.stringify({ error: 'locked', message: '账号已被临时锁定，请稍后再试' }) }),
  });
  thrown = null;
  try {
    await lockedClient.login('alice_01', 'secret-pass-1');
  } catch (err) {
    thrown = err;
  }
  check('cloud-api 保留 423 锁定语义与服务器文案', Boolean(thrown) && thrown.status === 423 && thrown.isLocked === true && thrown.message.indexOf('锁定') !== -1, String(thrown && thrown.message));
  thrown = null;
  try {
    await clientMod.createCloudApi({
      baseUrl: 'https://example.test/api',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }).pull('t-123');
  } catch (err) {
    thrown = err;
  }
  check('cloud-api 把网络故障翻成 network-error', Boolean(thrown) && thrown.code === 'network-error' && thrown.isNetworkError === true, String(thrown && thrown.code));
  check('cloud-api 五个方法齐全', ['register', 'login', 'reset', 'pull', 'push'].every((k) => typeof client[k] === 'function'), Object.keys(client).join(','));
  check('cloud-api 路径常量与冻结协议一致', clientMod.CLOUD_API_PATHS.register === '/register' && clientMod.CLOUD_API_PATHS.push === '/push', JSON.stringify(clientMod.CLOUD_API_PATHS));


  // ==================== 11. 云开发 SQL HTTP API 通道 ====================
  // 共享集群没有任何数据库网络地址，pg 直连不可用；云函数改走 POST /v1/rdb/exec-pgsql。
  // 官方契约：https://docs.cloudbase.net/openapi/pgdb.v1.openapi.yaml
  const FAKE_KEY = 'test-apikey-not-real-0123456789';
  const FAKE_ENV = 'hms-env-for-test';
  const redact = (text) => String(text).split(FAKE_KEY).join('<redacted>');
  const caught = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };

  const gwReq = [];
  const gwEnv = { CLOUDBASE_APIKEY: FAKE_KEY, CLOUDBASE_ENV_ID: FAKE_ENV };
  const dbApi = api.openDatabaseViaApi({
    env: gwEnv,
    fetchImpl: async (url, init) => {
      gwReq.push({ url: url, init: init });
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 7, expires_at: '2030-01-01T00:00:00.000Z' }]) };
    },
  });
  check('API 通道暴露与 pg 同形的 query(sql, params)', Boolean(dbApi) && typeof dbApi.query === 'function', typeof dbApi);

  const apiRows = await dbApi.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', ['deadbeef']);
  check(
    'API 通道打到 POST https://<envId>.api.tcloudbasegateway.com/v1/rdb/exec-pgsql',
    gwReq[0].url === 'https://hms-env-for-test.api.tcloudbasegateway.com/v1/rdb/exec-pgsql' && gwReq[0].init.method === 'POST',
    redact(gwReq[0].url) + ' ' + gwReq[0].init.method
  );
  check(
    'API 通道用 Authorization: Bearer <API Key> 鉴权',
    gwReq[0].init.headers.authorization === 'Bearer ' + FAKE_KEY,
    'authorization = Bearer <redacted>'
  );
  check(
    'SQL 仍是 $1 占位符，值走 parameters 数组（没有拼进 SQL）',
    JSON.parse(gwReq[0].init.body).sql === 'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1' &&
      JSON.stringify(JSON.parse(gwReq[0].init.body).parameters) === '["deadbeef"]',
    'body keys = ' + Object.keys(JSON.parse(gwReq[0].init.body)).join(',')
  );
  check(
    '写操作显式指定管理角色 cloudbase_postgres（不传会落到只读角色被 42501 拒掉）',
    JSON.parse(gwReq[0].init.body).role === 'cloudbase_postgres',
    'role = ' + JSON.parse(gwReq[0].init.body).role
  );
  check(
    '成功时返回裸行数组，firstRow 的语义不变',
    Array.isArray(apiRows) && apiRows.length === 1 && apiRows[0].id === 7 && apiRows[0].expires_at === '2030-01-01T00:00:00.000Z',
    JSON.stringify(apiRows)
  );

  const gwReq2 = [];
  const dbApi2 = api.openDatabaseViaApi({
    env: { CLOUDBASE_APIKEY: FAKE_KEY, TCB_ENV: FAKE_ENV },
    fetchImpl: async (url, init) => {
      gwReq2.push({ url: url, init: init });
      return { ok: true, status: 200, text: async () => '[]' };
    },
  });
  await dbApi2.query('INSERT INTO snapshots (user_id, rev, saved_at, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    1,
    2,
    new Date(CLOCK0),
    { a: 1 },
  ]);
  const sent2 = JSON.parse(gwReq2[0].init.body);
  check(
    'Date 参数转 ISO 字符串、对象参数转 JSON 文本（$4::jsonb 照旧可用）',
    sent2.parameters[2] === new Date(CLOCK0).toISOString() && sent2.parameters[3] === '{"a":1}',
    JSON.stringify(sent2.parameters)
  );
  check(
    '环境 ID 缺失时回落到云函数注入的 TCB_ENV 拼域名',
    gwReq2[0].url.indexOf('https://' + FAKE_ENV + '.api.tcloudbasegateway.com/v1/rdb/exec-pgsql') === 0,
    redact(gwReq2[0].url)
  );

  const gwErr = (status, body) =>
    api.openDatabaseViaApi({
      env: gwEnv,
      fetchImpl: async () => ({ ok: status >= 200 && status < 300, status: status, text: async () => JSON.stringify(body) }),
    });

  const dupErr = await caught(
    gwErr(400, {
      code: 'DATABASE_23505',
      message: 'duplicate key value violates unique constraint "users_username_lower_key" Key (username_lower)=(alice_01) already exists.',
      details: 'alice_01',
      requestId: 'rq-1',
    }).query(api.SQL.insertUser, [])
  );
  check('网关 DATABASE_23505 翻成 SQLSTATE 23505，业务层的唯一冲突判定照旧生效', Boolean(dupErr) && dupErr.code === '23505', redact(String(dupErr && dupErr.code)));
  check(
    '数据级错误不回显上游 message/details（可能夹带触发冲突的用户输入）',
    Boolean(dupErr) && dupErr.message.indexOf('alice_01') === -1 && dupErr.message.indexOf('duplicate key') === -1,
    redact(String(dupErr && dupErr.message))
  );
  check('数据级错误的错误信息保留 SQLSTATE 与 requestId 便于排查', Boolean(dupErr) && dupErr.message.indexOf('23505') !== -1 && dupErr.message.indexOf('rq-1') !== -1, redact(String(dupErr && dupErr.message)));

  const synErr = await caught(gwErr(400, { code: 'DATABASE_42601', message: 'syntax error at or near "SELEC"' }).query('SELEC 1', []));
  check(
    '网关 DATABASE_42601 翻成 SQLSTATE 42601，并保留我们自己的 SQL 报错',
    Boolean(synErr) && synErr.code === '42601' && synErr.message.indexOf('syntax error') !== -1,
    redact(String(synErr && synErr.message))
  );

  const authErr = await caught(gwErr(401, { code: 'UNAUTHORIZED', message: 'invalid token' }).query('SELECT 1', []));
  check(
    'HTTP 401 UNAUTHORIZED 原样带出，不被吞成 500',
    Boolean(authErr) && authErr.code === 'UNAUTHORIZED' && authErr.status === 401,
    redact(String(authErr && authErr.code) + '/' + String(authErr && authErr.status))
  );
  const forbidErr = await caught(gwErr(403, { code: 'ACTION_FORBIDDEN' }).query('SELECT 1', []));
  check('HTTP 403 ACTION_FORBIDDEN 原样带出', Boolean(forbidErr) && forbidErr.code === 'ACTION_FORBIDDEN', redact(String(forbidErr && forbidErr.code)));
  const shapeErr = await caught(
    api
      .openDatabaseViaApi({ env: gwEnv, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"rows":[]}' }) })
      .query('SELECT 1', [])
  );
  check('返回体不是行数组时抛错，而不是把错误形状喂给业务层', Boolean(shapeErr) && shapeErr.code === 'MALFORMED', redact(String(shapeErr && shapeErr.code)));

  const netErr = await caught(
    api
      .openDatabaseViaApi({
        env: gwEnv,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED 10.0.0.1:5432 ' + FAKE_KEY);
        },
      })
      .query('SELECT 1', [])
  );
  check(
    '网络失败翻成 NETWORK，不把底层错误原样抛出',
    Boolean(netErr) && netErr.code === 'NETWORK' && netErr.message.indexOf('5432') === -1,
    redact(String(netErr && netErr.message))
  );

  const timeoutStartedAt = Date.now();
  const timeoutErr = await caught(
    api
      .openDatabaseViaApi({ env: gwEnv, timeoutMs: 80, fetchImpl: () => new Promise(() => {}) })
      .query('SELECT 1', [])
  );
  check(
    'fetch 永不返回时按超时抛错，不会把请求挂死',
    Boolean(timeoutErr) && timeoutErr.code === 'TIMEOUT' && Date.now() - timeoutStartedAt < 5000,
    redact(String(timeoutErr && timeoutErr.code)) + ' after ' + (Date.now() - timeoutStartedAt) + 'ms'
  );

  const missingKeyErr = await caught(
    (async () => api.openDatabaseViaApi({ env: {} }))()
  );
  check(
    '缺 API Key 时给出中文报错并点名变量',
    Boolean(missingKeyErr) && missingKeyErr.message.indexOf('CLOUDBASE_APIKEY') !== -1 && missingKeyErr.message.indexOf('缺少') !== -1,
    redact(String(missingKeyErr && missingKeyErr.message))
  );
  const missingEnvErr = await caught((async () => api.openDatabaseViaApi({ env: { CLOUDBASE_APIKEY: FAKE_KEY } }))());
  check(
    '缺环境 ID 时同样给出可执行的中文报错',
    Boolean(missingEnvErr) && missingEnvErr.message.indexOf('CLOUDBASE_ENV_ID') !== -1,
    redact(String(missingEnvErr && missingEnvErr.message))
  );
  const badEnvIdErr = await caught(
    (async () => api.openDatabaseViaApi({ env: { CLOUDBASE_APIKEY: FAKE_KEY, CLOUDBASE_ENV_ID: 'https://evil.example.com' } }))()
  );
  check(
    '环境 ID 里塞完整 URL 被拒（环境变量不能把请求带去别处）',
    Boolean(badEnvIdErr) && badEnvIdErr.message.indexOf('不是合法的环境 ID') !== -1,
    redact(String(badEnvIdErr && badEnvIdErr.message))
  );
  check('缺凭证的报错里不含任何密钥或连接串', Boolean(missingKeyErr) && redact(missingKeyErr.message).indexOf('<redacted>') === -1 && missingKeyErr.message.indexOf('://') === -1, redact(String(missingKeyErr && missingKeyErr.message)));

  const aliasConfig = api.resolveGatewayConfig({
    API_KEY: 'k-generic',
    CLOUDBASE_API_KEY: 'k-underscore',
    CLOUDBASE_APIKEY: 'k-official',
    CLOUDBASE_ENV_ID: FAKE_ENV,
  });
  check('API Key 变量名按官方名字优先（CLOUDBASE_APIKEY 排第一）', aliasConfig.keyEnvName === 'CLOUDBASE_APIKEY', aliasConfig.keyEnvName);
  check('兜底别名表以官方文档写死的名字开头', api.API_KEY_ENV_NAMES[0] === 'CLOUDBASE_APIKEY', api.API_KEY_ENV_NAMES.join(','));

  const leakLogs = [];
  const leakHandler = api.createHandler({
    db: api.openDatabaseViaApi({
      env: gwEnv,
      fetchImpl: async () => {
        throw new Error('upstream boom key=' + FAKE_KEY);
      },
    }),
    now: () => CLOCK0,
    randomBytes: randomBytes,
    logger: {
      log: function () {
        leakLogs.push(Array.prototype.map.call(arguments, (a) => String(a)).join(' '));
      },
    },
  });
  const leakRes = await leakHandler({ httpMethod: 'POST', path: '/login', body: JSON.stringify({ username: 'leak_user', password: 'secret-pass-1' }) });
  const leakBlob = [leakLogs.join('\n'), leakRes.body, String(netErr && netErr.message), String(authErr && authErr.message), String(dupErr && dupErr.message), gwReq[0].url].join('\n');
  check('API Key 不出现在日志、响应体与任何错误信息里', leakBlob.indexOf(FAKE_KEY) === -1, '已脱敏文本长度 ' + leakBlob.length);
  check('云函数请求仍然被兜成 500 server-error', leakRes.statusCode === 500 && JSON.parse(leakRes.body).error === 'server-error', String(leakRes.statusCode));

  check('旧的 pg 直连路径仍然导出（升级独享集群后可切回）', typeof api.openDatabase === 'function', typeof api.openDatabase);
  const legacyErr = await caught((async () => api.openDatabase({ fresh: true, env: {} }))());
  check(
    '旧 pg 路径缺 DATABASE_URL / PGHOST 时仍抛错且不泄露内容',
    Boolean(legacyErr) && legacyErr.message.indexOf('DATABASE_URL') !== -1 && legacyErr.message.indexOf('://') === -1,
    String(legacyErr && legacyErr.message)
  );
  check(
    'main() 已经改用 API 通道，源码里不再有 pg 直连调用点',
    String(api.main).indexOf('openDatabase(') === -1 && String(api.main).indexOf('openDatabaseViaApi(') !== -1,
    'main 的调用点已切换'
  );
  check(
    '本机没有安装 pg，模块仍能 import 并导出整条新通道',
    typeof api.openDatabaseViaApi === 'function' && typeof api.createApiDatabase === 'function' && typeof api.resolveGatewayConfig === 'function',
    'ok'
  );

  return { passed: passed, failed: failures.length, failures: failures };
}

export { run, FakeDb, makeEnv, deepEqual, PAYLOAD, CLOCK0 };
