/**
 * 本地多账号目录：只做「账号清单（localStorage）+ 库名分配」，不含任何业务规则。
 *
 * 隔离原则：一个账号一个独立 IndexedDB 库，隔离靠库名，不靠任何过滤条件 ——
 * 切到哪个账号，读写就落在哪个库，不可能触到另一个账号的数据。
 * 第一个账号直接认领老库 'hms'（用户手机上已有的数据就在那里），不做任何搬迁。
 *
 * 顶层零副作用、不 import 任何模块；localStorage 被禁用或内容损坏一律安全降级
 * （返回 [] / null，绝不抛异常）。与 js/db.js 的协作只有两处，见下面各自的注释。
 */

export const CATALOG_KEY = 'hms.accounts';
export const ACTIVE_KEY = 'hms.activeAccount';
export const LEGACY_DB_NAME = 'hms';
export const MAX_ACCOUNTS = 8;

const DEFAULT_ACCOUNT_NAME = '本机';
// onblocked 后的兜底等待：别的标签页不肯让路时也不能让删账号永远挂着
const BLOCKED_GRACE_MS = 1000;

// ---------- localStorage 安全读写 ----------

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari 隐私模式下连访问 localStorage 都会抛
    return null;
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

/** 写不进去返回 false（被禁用 / 配额满），由调用方决定是降级还是报错。 */
function writeRaw(key, value) {
  try {
    const s = storage();
    if (!s) return false;
    if (value == null) s.removeItem(key);
    else s.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

// ---------- 整形 ----------

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function newId() {
  const rand = globalThis.crypto?.randomUUID?.();
  if (rand) return String(rand);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function dbNameForId(id) {
  return `${LEGACY_DB_NAME}-u-${id}`;
}

/**
 * 记录整形：缺 id 或 name 一律丢弃（脏数据不能变成半个账号）。
 * dbName 缺失时按 id 推出来，保证任何一个账号都指向一个确定的库。
 */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id);
  const name = text(raw.name);
  if (!id || !name) return null;
  const createdAt = Number(raw.createdAt);
  const account = {
    id,
    name,
    dbName: text(raw.dbName) || dbNameForId(id),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
  if (text(raw.email)) account.email = text(raw.email);
  if (text(raw.serverId)) account.serverId = text(raw.serverId);
  return account;
}

function accountName(input) {
  const name = text(typeof input === 'string' ? input : input?.name);
  if (!name) throw new Error('账号名称不能为空');
  return name;
}

/** 写目录：写不进去要报出来，不能假装改名/删号成功了。 */
function writeCatalog(list) {
  if (writeRaw(CATALOG_KEY, JSON.stringify(list))) return true;
  throw new Error('本地存储不可用，无法保存账号');
}

function commitActive(account) {
  const ok = writeRaw(ACTIVE_KEY, account.id);
  notifyDbLayer();
  return ok;
}

// ---------- db 层桥（js/db.js 惰性注入；顶层不谈副作用） ----------

let dbBridge = null;

/**
 * @internal 仅供 js/db.js 注入 `{ onSwitch }`，不属于对外契约。
 * db.js 在第一次打开数据库时调用，所以本模块顶层依旧零副作用。
 */
export function connectDb(bridge) {
  dbBridge = bridge && typeof bridge === 'object' ? bridge : null;
}

function notifyDbLayer() {
  try {
    dbBridge?.onSwitch?.();
  } catch {
    // db 层没准备好也不能让账号操作失败；正确性由 db 层每次取连接时重算库名兜底
  }
}

function tick() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 让 js/db.js 用它自己那份 schema 把新库建全（不在这里复制一份 buildSchema）。
 * 拿不到 db 层（或当前环境没有 IDB）就跳过：第一次切到这个账号时 openDb 的
 * onupgradeneeded 还会建一次，功能不受影响。
 */
async function prepareDatabase(dbName) {
  try {
    const mod = await import('./db.js');
    await mod.prepareDatabase?.(dbName);
  } catch {
    /* 建库失败不阻塞创建账号 */
  }
}

/** 删库：认领的老库禁删由调用方把关；这里只负责「先让路、再删、绝不挂死」。 */
function deleteDatabase(name) {
  return new Promise((resolve) => {
    const idb = globalThis.indexedDB;
    if (!idb || typeof idb.deleteDatabase !== 'function') {
      resolve();
      return;
    }
    let timer = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    let req;
    try {
      req = idb.deleteDatabase(name);
    } catch {
      finish();
      return;
    }
    if (!req) {
      finish();
      return;
    }
    req.onsuccess = finish;
    req.onerror = finish;
    req.onblocked = () => {
      // 还有连接没关（别的标签页）：给一点时间自己让路，超时也照常结束，绝不永远挂着
      if (!settled && !timer) timer = setTimeout(finish, BLOCKED_GRACE_MS);
    };
  });
}

// ---------- 对外契约 ----------

/** 目录里的账号：脏记录丢弃，同一个库只留一个账号，按 createdAt 升序。绝不抛。 */
export function listAccounts() {
  const raw = readRaw(CATALOG_KEY);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const usedDbNames = new Set();
  const out = [];
  for (const row of parsed) {
    const account = normalizeAccount(row);
    if (!account) continue;
    // 两个账号指到同一个库 = 隔离被目录改坏了，只认先出现的那个
    if (usedDbNames.has(account.dbName)) continue;
    usedDbNames.add(account.dbName);
    out.push(account);
  }
  // 只比 createdAt：同一毫秒建的两个账号保持目录顺序（Array#sort 稳定），结果才是确定的
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** 当前账号：没有、或 id 已不在目录里（被删/被改坏）→ null。 */
export function getActiveAccount() {
  const id = readRaw(ACTIVE_KEY);
  if (!id) return null;
  return listAccounts().find((account) => account.id === id) ?? null;
}

/** 库名取不到时回落老库名：宁可回到有数据的老库，也不要一个空库名。 */
export function dbNameForAccount(account) {
  return text(account?.dbName) || LEGACY_DB_NAME;
}

/**
 * 切当前账号。写 ACTIVE_KEY 的同时通知 db 层：db.js 收到通知就放掉旧连接，
 * 下一次读写按新账号的库名重开，所以这里不需要（也做不到）await 切换。
 * 传不存在的 id → 返回 null 且不改当前账号。
 */
export function setActiveAccount(id) {
  const key = text(id);
  const account = key ? listAccounts().find((a) => a.id === key) ?? null : null;
  if (!account) return null;
  if (!writeRaw(ACTIVE_KEY, account.id)) return null;
  notifyDbLayer();
  return account;
}

/** 新建账号：独立的库 hms-u-<id>，并让 db 层把这个库建全。 */
export async function createAccount(input = {}) {
  const name = accountName(input);
  const existing = listAccounts();
  if (existing.length >= MAX_ACCOUNTS) throw new Error(`最多只能建 ${MAX_ACCOUNTS} 个账号`);
  const id = newId();
  const account = { id, name, dbName: dbNameForId(id), createdAt: Date.now() };
  writeCatalog([...existing, account]);
  await prepareDatabase(account.dbName);
  return account;
}

export function renameAccount(id, name) {
  const clean = accountName(name);
  const key = text(id);
  const list = listAccounts();
  const index = list.findIndex((account) => account.id === key);
  if (index < 0) throw new Error('账号不存在');
  const next = { ...list[index], name: clean };
  list[index] = next;
  writeCatalog(list);
  return next;
}

/**
 * 删账号 = 删账号记录 + 删它的数据库。
 * 认领了老库 'hms' 的账号禁止删除（用户的数据就在那里，删掉等于清空手机上的数据）。
 */
export async function removeAccount(id) {
  const key = text(id);
  const list = listAccounts();
  const account = key ? list.find((a) => a.id === key) ?? null : null;
  if (!account) return;
  if (account.dbName === LEGACY_DB_NAME) throw new Error('本机数据所在账号不能删除');

  const wasActive = list.find((a) => a.id === readRaw(ACTIVE_KEY))?.id === account.id;
  const remaining = list.filter((a) => a.id !== account.id);
  writeCatalog(remaining);
  // 删的是当前账号：先把目录指向别的账号（或清空），db 层才会放开这条连接
  if (wasActive) writeRaw(ACTIVE_KEY, remaining.length ? remaining[0].id : null);
  notifyDbLayer();
  await tick();
  await deleteDatabase(account.dbName);
}

/**
 * 首次运行：把现有的老库登记成「本机」账号并设为当前（数据原地不动）。
 * 幂等：目录里已经有当前账号就直接返回；有账号但没有当前账号 → 认最早的。
 * 目录写不进去（隐私模式）也照样返回一个指向老库的账号，绝不白屏。
 */
export async function ensureDefaultAccount() {
  const active = getActiveAccount();
  if (active) return active;

  const existing = listAccounts();
  const account = existing[0] ?? {
    id: newId(),
    name: DEFAULT_ACCOUNT_NAME,
    dbName: LEGACY_DB_NAME,
    createdAt: Date.now(),
  };
  if (!existing[0]) {
    try {
      writeCatalog([account]);
    } catch {
      /* 存不进去也要能用：这个账号指向老库 */
    }
  }
  commitActive(account);
  return account;
}
