/**
 * IndexedDB 薄封装：只做存储，不含任何业务规则。
 * 每个导出函数≈一个 IDB 请求，聚合/去重/整形一律交给 pure.js，这样 Node 里能测到的部分尽量大。
 */

import { normalizeRecord, planImport, BUSINESS_STORES } from './pure.js';

const DB_NAME = 'hms';
const DB_VERSION = 1;
const ALL_STORES = ['meta', ...BUSINESS_STORES, 'photos'];
// 导入时只恢复档案与目标：API Key 属于设备本地凭据，不该被一份备份文件悄悄装进来
const IMPORTABLE_META = ['profile', 'goals'];

export const IDB_UNAVAILABLE_MESSAGE = '当前浏览器禁用了本地存储，数据无法保存';

let dbPromise = null;

function unavailable() {
  return new Error(IDB_UNAVAILABLE_MESSAGE);
}

function toDbError(err) {
  if (err && err.name === 'QuotaExceededError') return new Error('本地存储空间不足，请先导出备份并清理旧数据');
  if (err && err.name === 'ConstraintError') return new Error('数据冲突：同一日期已存在记录');
  return err instanceof Error ? err : new Error(`本地数据库操作失败：${err?.message ?? '未知错误'}`);
}

function assertStore(store) {
  if (!ALL_STORES.includes(store)) throw new Error(`未知的数据表：${store}`);
}

function buildSchema(db) {
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  if (!db.objectStoreNames.contains('weights')) {
    const s = db.createObjectStore('weights', { keyPath: 'id', autoIncrement: true });
    s.createIndex('by_date', 'date', { unique: true });
  }
  if (!db.objectStoreNames.contains('meals')) {
    const s = db.createObjectStore('meals', { keyPath: 'id', autoIncrement: true });
    s.createIndex('by_date', 'date', { unique: false });
  }
  if (!db.objectStoreNames.contains('exercises')) {
    const s = db.createObjectStore('exercises', { keyPath: 'id', autoIncrement: true });
    s.createIndex('by_date', 'date', { unique: false });
  }
  if (!db.objectStoreNames.contains('waters')) {
    const s = db.createObjectStore('waters', { keyPath: 'id', autoIncrement: true });
    s.createIndex('by_date', 'date', { unique: true });
  }
  if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
}

/** 幂等单例。失败后不缓存，下一次调用可以重试（隐私模式切换、用户重开标签页等）。 */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(unavailable());
      return;
    }
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(unavailable());
      return;
    }
    req.onupgradeneeded = () => {
      try {
        buildSchema(req.result);
      } catch (err) {
        reject(toDbError(err));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* 关不掉也无所谓，下一次 openDb 会重开 */
        }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(toDbError(req.error));
    req.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭其他 HMS 页面后重试'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toDbError(request.error));
  });
}

/** 只读操作：在当前微任务里同步建事务并发请求，避免事务因 await 空转而失活。 */
async function readOp(store, fn) {
  assertStore(store);
  const db = await openDb();
  const os = db.transaction(store, 'readonly').objectStore(store);
  return fn(os);
}

/** 写操作：等事务 oncomplete 才 resolve，保证调用方拿到的是「真的落库了」。 */
async function writeOp(stores, fn) {
  const list = Array.isArray(stores) ? stores : [stores];
  for (const name of list) assertStore(name);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(list, 'readwrite');
    } catch (err) {
      reject(toDbError(err));
      return;
    }
    const box = { value: undefined };
    t.oncomplete = () => resolve(box.value);
    t.onerror = () => reject(toDbError(t.error));
    t.onabort = () => reject(toDbError(t.error));
    try {
      fn((name) => t.objectStore(name), box);
    } catch (err) {
      try {
        t.abort();
      } catch {
        /* 事务可能已结束，忽略 */
      }
      reject(toDbError(err));
    }
  });
}

/** 供首屏红条判定：IDB 是否可用。 */
export async function isAvailable() {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

export async function getAll(store) {
  return readOp(store, (os) => reqP(os.getAll()));
}

export async function get(store, key) {
  const value = await readOp(store, (os) => reqP(os.get(key)));
  return value ?? null;
}

export async function put(store, obj) {
  return writeOp(store, (s, box) => {
    const req = s(store).put(obj);
    req.onsuccess = () => {
      box.value = req.result;
    };
  });
}

export async function del(store, key) {
  await writeOp(store, (s) => {
    s(store).delete(key);
  });
}

export async function getOneByIndex(store, index, value) {
  const row = await readOp(store, (os) => reqP(os.index(index).get(value)));
  return row ?? null;
}

export async function getAllByIndex(store, index, value) {
  return readOp(store, (os) => reqP(os.index(index).getAll(value)));
}

export async function deleteAll(store) {
  await writeOp(store, (s) => {
    s(store).clear();
  });
}

export async function getMeta(key, fallback = null) {
  const rec = await get('meta', key);
  return rec && 'value' in rec ? rec.value : fallback;
}

export async function setMeta(key, value) {
  await put('meta', { key, value });
}

function byDateThenId(a, b) {
  const da = String(a?.date ?? '');
  const db2 = String(b?.date ?? '');
  if (da !== db2) return da < db2 ? -1 : 1;
  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}

export async function dumpAll() {
  const [metaRows, weights, meals, exercises, waters, photoCount] = await Promise.all([
    getAll('meta'),
    getAll('weights'),
    getAll('meals'),
    getAll('exercises'),
    getAll('waters'),
    readOp('photos', (os) => reqP(os.count())),
  ]);

  const meta = {};
  for (const rec of metaRows) meta[rec.key] = rec.value;

  return {
    schemaVersion: Number(meta.schemaVersion) || DB_VERSION,
    exportedAt: new Date().toISOString(),
    meta,
    weights: [...weights].sort(byDateThenId),
    meals: [...meals].sort(byDateThenId),
    exercises: [...exercises].sort(byDateThenId),
    waters: [...waters].sort(byDateThenId),
    // 二进制照片不进 JSON（手机上几 MB 的 base64 会把浏览器拖死），只留计数
    photoCount,
  };
}

function metaToMap(meta) {
  if (Array.isArray(meta)) {
    const map = {};
    for (const rec of meta) if (rec && rec.key) map[rec.key] = rec.value;
    return map;
  }
  return meta && typeof meta === 'object' ? meta : {};
}

async function restoreMeta(src, replace) {
  const meta = metaToMap(src.meta);
  for (const key of IMPORTABLE_META) {
    if (!(key in meta) || meta[key] == null) continue;
    if (!replace && (await getMeta(key, null)) != null) continue;
    await setMeta(key, meta[key]);
  }
}

/**
 * 导入。replace 先清空业务表；merge 只补缺失（已有键一律不覆盖），因此同一份备份
 * 重复导入不会让数据翻倍。返回实际写入条数。
 */
export async function loadAll(payload, mode = 'merge') {
  const src = payload && typeof payload === 'object' ? payload : {};
  const replace = mode === 'replace';
  const incoming = {};
  const existing = {};

  for (const name of BUSINESS_STORES) {
    incoming[name] = Array.isArray(src[name]) ? src[name] : [];
    existing[name] = replace ? [] : await getAll(name);
  }

  // 只清 4 张明细表：photos 不在 JSON 里，误删等于永久丢照片，宁可留孤儿
  if (replace) await clearStores(BUSINESS_STORES);

  const plans = {};
  const counts = { weights: 0, meals: 0, exercises: 0, waters: 0 };
  for (const name of BUSINESS_STORES) {
    plans[name] = planImport(name, existing[name], incoming[name]);
    counts[name] = plans[name].length;
  }

  await writeOp(BUSINESS_STORES, (s) => {
    for (const name of BUSINESS_STORES) {
      const os = s(name);
      for (const row of plans[name]) os.put(row);
    }
  });

  await restoreMeta(src, replace);
  return counts;
}

async function clearStores(names) {
  await writeOp(names, (s) => {
    for (const name of names) s(name).clear();
  });
}

/** 清空 5 个业务 store（4 张明细 + photos），保留 meta。 */
export async function clearBusinessData() {
  await clearStores([...BUSINESS_STORES, 'photos']);
}

export { BUSINESS_STORES, normalizeRecord };
