/**
 * 界面层 / 状态机对抗性模糊测试 —— 只找不改（本轮禁止修改任何生产代码）。
 *
 * 运行方式（本机没有浏览器，只能用假 DOM；这也是既有 tests/ui.smoke.mjs 的做法）：
 *   const m = await import('file:///C:/Users/Administrator/Desktop/hms/tests/fuzz.ui.mjs');
 *   const r = await m.run();   // -> { passed, failed, failures, findings, notes, ms }
 * 直接执行本文件（node tests/fuzz.ui.mjs）也会自己跑一遍并打印报告。
 *
 * 本文件自带一整套假 DOM / 假 IndexedDB / 假 localStorage，**不 import tests/ui.smoke.mjs**，
 * 避免两个套件互相污染（smoke 会替换全局，并且各自持有模块单例）。
 * 与 smoke 相比，本套件在三个地方**故意**做得更接近真实浏览器（否则对抗性用例没有意义）：
 *   1) 假 IndexedDB 有库名注册表：同名 open() 拿回同一个库，deleteDatabase 真的删库
 *      → 多账号"一个账号一个库"的隔离才可能被真正验证；
 *   2) 假 IndexedDB 会执行唯一索引约束：同日重复 put 抛 ConstraintError，事务走
 *      onerror/onabort 而不是静默提交 → store.js 里"撞唯一索引后重读覆盖"的兜底才会被走到；
 *   3) 假 DOM 的 appendChild 具备真实 DOM 的搬移语义（把已在别处的节点挪过来，不复制）。
 *
 * 断言口径（什么算 bug）写在每个用例的 meta 里；findings 只收真 bug，
 * 经核实属于既有设计的可疑项进 notes（带依据，例如"某条既有断言就是这么钉的"）。
 */

import assert from 'node:assert/strict';

/* ============================================================================
 * 0. 固定种子（LCG）——同一颗种子永远跑出同一条用例序列
 * ========================================================================== */

export const SEED = 0x484d5321;

/** 线性同余发生器：可复现的伪随机序列（不依赖 Math.random）。 */
export function makeRng(seed = SEED) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pickOne = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

/* ============================================================================
 * 1. 账本与断言小工具
 * ========================================================================== */

const ledger = { passed: 0, failures: [], findings: [], notes: [] };

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** 上屏脏值：模板拼接最常见的线上事故（undefined / NaN / [object Object]）。 */
function leaksIn(text) {
  const hits = [];
  if (/\bundefined\b/.test(text)) hits.push('undefined');
  if (/\bNaN\b/.test(text)) hits.push('NaN');
  if (/\[object Object\]/.test(text)) hits.push('[object Object]');
  return hits;
}

/** 小树用：整棵树的文本拼起来找脏值（口径与 tests/ui.smoke.mjs 的 assertNoLeak 一致）。 */
function assertNoLeak(text, label) {
  assert.ok(String(text).length > 0, label + ' 渲染出空文本');
  const hits = leaksIn(String(text));
  assert.equal(hits.join('/'), '', label + ' 文本上屏脏值 ' + hits.join('/') + '：' + String(text).slice(0, 200));
}

/**
 * 大树用：逐节点看自己的 _text，避免 textOf() 在 O(n) 个节点上各做一次全量子串拼接（O(n²)）。
 * 对 undefined / NaN / [object Object] 这三个模式，逐节点检查与整树拼接等价。
 */
function scanLeaks(root, label, limit = 400000) {
  const out = [];
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    seen += 1;
    if (seen > limit) { out.push('（节点数超过 ' + limit + '，扫描已截断）'); break; }
    const own = String(node._text == null ? '' : node._text);
    for (const hit of leaksIn(own)) out.push(hit + ' @<' + node.tagName + '> ' + own.slice(0, 120));
    const kids = node.childNodes || [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  assert.equal(out.slice(0, 5).join(' | '), '', label + ' 出现脏值：' + out.slice(0, 5).join(' | '));
}

const nodeText = (node) => (node && typeof node.textOf === 'function' ? node.textOf() : '');

function byClass(root, className) {
  return root.walk().filter((n) => String(n.className).split(/\s+/).includes(className));
}

function findButton(root, label) {
  return root.walk().find((n) => (n.tagName === 'button' || n.tagName === 'label') && n.textOf() === label) || null;
}

function findButtons(root, label) {
  return root.walk().filter((n) => (n.tagName === 'button' || n.tagName === 'label') && n.textOf() === label);
}

function findInput(root, predicate = () => true) {
  return root.walk().find((n) => n.tagName === 'input' && predicate(n)) || null;
}

/** 真实浏览器里 disabled 的按钮点不动：假 DOM 也必须这样，否则"连点保护"会被误判。 */
function fireClick(node, extra = {}) {
  assert.ok(node, 'fireClick 收到了空节点');
  if (node.disabled === true) return { blockedByDisabled: true };
  const event = {
    type: 'click',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    target: node,
    ...extra,
  };
  for (const fn of [...(node.listeners.click || [])]) fn(event);
  return event;
}

function fireInput(node, extra = {}) {
  const event = { type: 'input', target: node, preventDefault() {}, stopPropagation() {}, ...extra };
  for (const fn of [...(node.listeners.input || [])]) fn(event);
  return event;
}

function fireChange(node) {
  const event = { type: 'change', target: node, preventDefault() {}, stopPropagation() {} };
  for (const fn of [...(node.listeners.change || [])]) fn(event);
  return event;
}

function fireKey(node, key) {
  const event = { key, type: 'keydown', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, target: node };
  for (const fn of [...(node.listeners.keydown || [])]) fn(event);
  return event;
}

/* ============================================================================
 * 2. 假 DOM（比 smoke 多：搬移语义 / isConnected / focus / querySelectorAll / document 监听器计数）
 * ========================================================================== */

function createDom() {
  const makeStyle = () => {
    const bag = {};
    return new Proxy(bag, {
      get(target, key) {
        if (key === 'setProperty') return (name, value) => { target[name] = String(value); };
        if (key === 'removeProperty') return (name) => { delete target[name]; };
        if (key in target) return target[key];
        return '';
      },
      set(target, key, value) { target[key] = value; return true; },
    });
  };

  const documentListeners = new Map();

  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.childNodes = [];
      this.attributes = {};
      this.dataset = {};
      this.listeners = {};
      this.style = makeStyle();
      this.className = '';
      this.id = '';
      this.parentNode = null;
      this.value = '';
      this.placeholder = '';
      this.type = '';
      this.disabled = false;
      this.files = null;
      this.hidden = false;
      this.focused = false;
      this._text = '';
    }

    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.childNodes = []; }

    get firstChild() { return this.childNodes[0] || null; }
    get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
    get isConnected() {
      let cur = this;
      while (cur) { if (cur === body) return true; cur = cur.parentNode; }
      return false;
    }

    /** 真实 DOM 语义：append 一个已在别处的节点 = 搬移，不是复制。 */
    appendChild(child) {
      if (!child) return child;
      if (child === this) throw new Error('HierarchyRequestError: 不能把节点挂到自己身上');
      if (child.parentNode) child.parentNode.removeChild(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    }

    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index < 0) return this.appendChild(child);
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }

    replaceChildren(...kids) {
      for (const kid of this.childNodes) kid.parentNode = null;
      this.childNodes = [];
      for (const kid of kids) this.appendChild(kid);
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) { this.childNodes.splice(index, 1); child.parentNode = null; }
      return child;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn); }
    focus() { this.focused = true; }
    blur() { this.focused = false; }
    click() { return fireClick(this); }

    get classList() {
      const self = this;
      const current = () => self.className.split(/\s+/).filter(Boolean);
      const write = (names) => { self.className = names.join(' '); };
      return {
        add: (...names) => { const list = current(); for (const name of names) if (!list.includes(name)) list.push(name); write(list); },
        remove: (...names) => write(current().filter((name) => !names.includes(name))),
        contains: (name) => current().includes(name),
        toggle: (name, force) => {
          const list = current();
          const has = list.includes(name);
          const want = force === undefined ? !has : Boolean(force);
          if (want && !has) list.push(name);
          write(want ? list : list.filter((item) => item !== name));
          return want;
        },
      };
    }

    textOf() {
      return [this._text, ...this.childNodes.map((child) => (child.textOf ? child.textOf() : String(child)))]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    walk(out = []) {
      out.push(this);
      for (const child of this.childNodes) if (child.walk) child.walk(out);
      return out;
    }
  }

  const body = new FakeNode('body');

  const matchesSimple = (node, part) => {
    if (part.startsWith('.')) return String(node.className).split(/\s+/).includes(part.slice(1));
    if (part.startsWith('#')) return node.id === part.slice(1);
    return String(node.tagName).toLowerCase() === part.toLowerCase();
  };

  const doc = {
    body,
    documentElement: new FakeNode('html'),
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag),
    createTextNode: (text) => { const n = new FakeNode('#text'); n.textContent = String(text); return n; },
    getElementById(id) { return body.walk().find((n) => n.id === id) || null; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
      return body.walk().filter((n) => n !== body && parts.some((part) => matchesSimple(n, part)));
    },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type) || [];
      documentListeners.set(type, list.filter((x) => x !== fn));
    },
  };

  return {
    FakeNode,
    body,
    doc,
    listenerCount: (type) => (documentListeners.get(type) || []).length,
    fireDocEvent: (type, event) => { for (const fn of [...(documentListeners.get(type) || [])]) fn({ type, ...event }); },
  };
}

/* ============================================================================
 * 3. 假 IndexedDB（库名注册表 + 唯一索引约束 + deleteDatabase）
 * ========================================================================== */

function createIndexedDb() {
  const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const registry = new Map();
  const opened = [];

  class FakeRequest {
    constructor(tx, run) {
      this.tx = tx; this.result = undefined; this.error = null; this._run = run; this._ok = null; this._err = null;
      if (tx) tx.pending += 1;
      setTimeout(() => this.fire(), 0);
    }
    set onsuccess(fn) { this._ok = fn; }
    set onerror(fn) { this._err = fn; }
    fire() {
      try {
        this.result = this._run();
      } catch (err) {
        this.error = err;
        if (this._err) this._err();
        // 真实 IDB：请求失败会让整个事务 onerror/onabort，而不是静默提交
        if (this.tx) this.tx.fail(err);
        return;
      }
      if (this._ok) this._ok();
      if (this.tx) this.tx.settle();
    }
  }

  class FakeStore {
    constructor(name, options = {}) {
      this.name = name; this.keyPath = options.keyPath; this.autoIncrement = !!options.autoIncrement;
      this.data = new Map(); this.indexes = new Map(); this.seq = 0;
    }
    createIndex(name, keyPath, options = {}) {
      this.indexes.set(name, { keyPath, unique: Boolean(options && options.unique) });
    }
    nextKey(obj) {
      if (this.keyPath) {
        const existing = obj[this.keyPath];
        if (existing != null) return existing;
        if (this.autoIncrement) { this.seq += 1; obj[this.keyPath] = this.seq; return this.seq; }
        throw new Error('keyPath 为空且未启用 autoIncrement');
      }
      this.seq += 1;
      return this.seq;
    }
    getAll() { return [...this.data.values()].map(clone); }
    get(key) { const value = this.data.get(key); return value === undefined ? undefined : clone(value); }
    put(obj) {
      const key = this.nextKey(obj);
      for (const [name, def] of this.indexes) {
        if (!def.unique) continue;
        const value = obj[def.keyPath];
        if (value === undefined) continue;
        for (const [rowKey, row] of this.data) {
          if (rowKey === key) continue;
          if (row && row[def.keyPath] === value) {
            const err = new Error('ConstraintError: 唯一索引 ' + name + ' 上已有 ' + String(value));
            err.name = 'ConstraintError';
            throw err;
          }
        }
      }
      this.data.set(key, clone(obj));
      return key;
    }
    delete(key) { this.data.delete(key); }
    clear() { this.data.clear(); }
    index(name) {
      const def = this.indexes.get(name);
      if (!def) throw new Error('没有索引 ' + name);
      const self = this;
      return {
        get(value) { for (const row of self.data.values()) if (row && row[def.keyPath] === value) return clone(row); return undefined; },
        getAll(value) { return [...self.data.values()].filter((row) => row && row[def.keyPath] === value).map(clone); },
      };
    }
  }

  class FakeTransaction {
    constructor(stores, mode) {
      this.stores = stores; this.mode = mode; this.pending = 0; this.settled = false; this.error = null;
      this.oncomplete = null; this.onerror = null; this.onabort = null;
      // 零请求的写事务在真实 IDB 里照样会提交
      setTimeout(() => {
        if (this.pending !== 0 || this.settled) return;
        this.settled = true;
        setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
      }, 0);
    }
    objectStore(name) {
      const store = this.stores[name];
      if (!store) throw new Error('没有 store ' + name);
      const tx = this;
      return {
        getAll: () => new FakeRequest(tx, () => store.getAll()),
        count: () => new FakeRequest(tx, () => store.data.size),
        get: (key) => new FakeRequest(tx, () => store.get(key)),
        put: (obj) => new FakeRequest(tx, () => store.put(obj)),
        delete: (key) => new FakeRequest(tx, () => { store.delete(key); }),
        clear: () => { store.clear(); return new FakeRequest(tx, () => undefined); },
        index: (indexName) => ({
          get: (value) => new FakeRequest(tx, () => store.index(indexName).get(value)),
          getAll: (value) => new FakeRequest(tx, () => store.index(indexName).getAll(value)),
        }),
      };
    }
    fail(err) {
      if (this.settled) return;
      this.settled = true;
      this.error = err;
      setTimeout(() => { if (this.onerror) this.onerror(); if (this.onabort) this.onabort(); }, 0);
    }
    settle() {
      this.pending -= 1;
      if (this.pending <= 0 && !this.settled) {
        this.settled = true;
        setTimeout(() => { if (this.oncomplete) this.oncomplete(); }, 0);
      }
    }
    abort() { this.settled = true; }
  }

  class FakeDb {
    constructor(name, version) {
      this.name = name; this.version = version; this.stores = new Map();
      this.objectStoreNames = { contains: (needle) => this.stores.has(needle) };
      this.onversionchange = null;
      this.closed = false;
    }
    createObjectStore(name, options = {}) { const created = new FakeStore(name, options); this.stores.set(name, created); return created; }
    transaction(names, mode) {
      const list = Array.isArray(names) ? names : [names];
      const scoped = {};
      for (const name of list) {
        if (!this.stores.has(name)) throw new Error('NotFoundError: ' + name);
        scoped[name] = this.stores.get(name);
      }
      return new FakeTransaction(scoped, mode);
    }
    close() { this.closed = true; }
  }

  const indexedDB = {
    open(name, version) {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        let database = registry.get(name);
        const isNew = !database;
        if (isNew) { database = new FakeDb(name, version); registry.set(name, database); opened.push(database); }
        request.result = database;
        try {
          if (isNew || Number(version) > Number(database.version)) {
            database.version = Number(version) || database.version;
            if (request.onupgradeneeded) request.onupgradeneeded();
          }
        } catch (err) {
          request.error = err;
          if (request.onerror) request.onerror();
          return;
        }
        setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
      }, 0);
      return request;
    },
    deleteDatabase(name) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null };
      registry.delete(name);
      setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
      return request;
    },
  };

  return {
    indexedDB,
    opened,
    has: (name) => registry.has(name),
    names: () => [...registry.keys()],
    rawStore: (dbName, storeName) => {
      const database = registry.get(dbName);
      if (!database) throw new Error('假 IDB 里没有库 ' + dbName);
      const target = database.stores.get(storeName);
      if (!target) throw new Error('库 ' + dbName + ' 里没有 store ' + storeName);
      return target;
    },
  };
}

/* ============================================================================
 * 4. 假 localStorage / navigator / matchMedia
 * ========================================================================== */

function createStorage({ broken = false } = {}) {
  const map = new Map();
  const boom = () => { const err = new Error('模拟隐私模式：localStorage 不可用'); err.name = 'SecurityError'; throw err; };
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] == null ? null : [...map.keys()][index],
    getItem: (key) => { if (broken) boom(); return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem: (key, value) => { if (broken) boom(); map.set(String(key), String(value)); },
    removeItem: (key) => { if (broken) boom(); map.delete(String(key)); },
    clear: () => { if (broken) boom(); map.clear(); },
    __map: map,
  };
}

// 宿主全局里 navigator / fetch 是只读访问器（赋值在严格模式下直接抛），
// 所以这里一律走 defineProperty，并按**属性描述符**原样快照/还原（值快照对访问器无效）。
const MANAGED_GLOBALS = ['document', 'window', 'Node', 'indexedDB', 'fetch', 'localStorage', 'navigator', 'matchMedia'];

function snapshotGlobals() {
  const out = {};
  for (const key of MANAGED_GLOBALS) out[key] = Object.getOwnPropertyDescriptor(globalThis, key) || null;
  return out;
}

function setGlobal(key, value) {
  try {
    if (value === undefined) { delete globalThis[key]; return true; }
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
    return true;
  } catch {
    return false;
  }
}

function restoreGlobals(snapshot) {
  for (const [key, descriptor] of Object.entries(snapshot)) {
    try {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    } catch {
      /* 宿主把某个全局钉死了：保持原样，不影响断言 */
    }
  }
}

/* ============================================================================
 * 5. 运行器与用例账本
 * ========================================================================== */

/**
 * 一条用例：断言全过 → passed+1；断言失败 → failures+1；
 * meta.severity 非空表示"失败即 bug"，会同时产出 finding（含视图/最小复现/实际/期望/严重度）。
 */
async function runCase(meta, fn) {
  try {
    await fn();
    ledger.passed += 1;
    return true;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    ledger.failures.push({ name: meta.id + ' · ' + meta.title, error: message });
    if (meta.severity) {
      ledger.findings.push({
        id: meta.id,
        '视图/流程': meta.area,
        '严重度': meta.severity,
        '最小复现': meta.repro,
        '实际': message,
        '期望': meta.expected,
        '用户是否会遇到': meta.reach,
        area: meta.area,
        severity: meta.severity,
        repro: meta.repro,
        actual: message,
        expected: meta.expected,
        userReachable: meta.reach,
      });
    }
    return false;
  }
}

function note(id, area, text) {
  ledger.notes.push({ id, area, note: text });
}

/* ============================================================================
 * 6. 入口
 * ========================================================================== */

export async function run() {
  ledger.passed = 0;
  ledger.failures.length = 0;
  ledger.findings.length = 0;
  ledger.notes.length = 0;

  const rng = makeRng();
  const snapshot = snapshotGlobals();
  const dom = createDom();
  const fakeIdb = createIndexedDb();
  const fakeStorage = createStorage();
  const fetchCalls = [];
  const winListeners = new Map();
  const urlSnapshot = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const startedAt = Date.now();
  let host = null;
  let currentHash = '#/';
  let routeToken = 0;
  const routeDeps = {};

  const win = {
    location: { hash: '#/' },
    history: { replaceState() {} },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      winListeners.set(type, list.filter((x) => x !== fn));
    },
    scrollTo() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: dom.doc,
    HMS: {},
    alert() {},
    confirm() { return false; },
  };
  const winListenerCount = (type) => (winListeners.get(type) || []).length;

  const fakeNavigator = {
    userAgent: 'fuzz-harness (not-a-browser)',
    maxTouchPoints: 0,
    language: 'zh-CN',
    clipboard: { writeText: async () => {} },
  };

  // js/ui.js 在后面的 import 块里才加载（同名绑定不能跨块作用域），所以这里先留一个槽位。
  let ui = null;

  /**
   * 与 app.js 的 clearOverlays() 等价：app.js 自己不再实现清场，而是委托 js/ui.js 里的同一份实现
   * （每个弹层先走完 finish()，再摘残留节点；.toast 不在清理范围内 —— 它是 2.9s 自删的提示，
   * 见 js/ui.js 的 clearOverlays 注释）。这里同样委托过去，避免"测试替身"和实现漂移；
   * ui.js 还没加载时退化成「只摘节点」，与 app.js 的兜底完全一致。
   */
  const clearOverlays = () => {
    if (ui) {
      ui.clearOverlays();
      return;
    }
    for (const node of dom.doc.querySelectorAll('.sheet-backdrop, .modal-backdrop')) node.remove();
    dom.doc.body.style.overflow = '';
  };

  const parseRoute = (hash) => String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\/+/, '').split('?')[0].replace(/\/+$/, '');

  /** 与 app.js 的 renderRoute() 同形：换新 .page 容器 → 渲染 → 失败落到错误卡片上。 */
  const navigate = async (hash) => {
    const route = parseRoute(hash);
    currentHash = route ? '#/' + route : '#/';
    win.location.hash = currentHash;
    const token = (routeToken += 1);
    clearOverlays();
    if (!host) {
      host = new dom.FakeNode('div');
      host.id = 'view';
      dom.doc.body.appendChild(host);
    }
    const page = new dom.FakeNode('div');
    page.className = 'page fade-in';
    host.replaceChildren(page);
    const mod = await import('../views/' + (route || 'dashboard') + '.js');
    if (token !== routeToken) return page;
    try {
      await mod.render(page, routeDeps[route]);
    } catch (err) {
      page.renderError = err;
      const card = new dom.FakeNode('div');
      card.className = 'card col';
      const title = new dom.FakeNode('div');
      title.className = 'h2';
      title.textContent = '这个页面加载失败了';
      const detail = new dom.FakeNode('div');
      detail.className = 'muted';
      detail.textContent = err && err.message ? err.message : String(err);
      card.appendChild(title);
      card.appendChild(detail);
      page.replaceChildren(card);
    }
    return page;
  };

  win.HMS = {
    navigate: (hash) => { navigate(hash); },
    refresh: async () => { await navigate(currentHash); },
  };

  /** 视图渲染：挂在游离 root 上（与 tests/ui.smoke.mjs 的 renderView 同形），不污染 body。 */
  const renderView = async (name, deps) => {
    const mod = await import('../views/' + name + '.js');
    assert.equal(typeof mod.render, 'function', 'views/' + name + '.js 缺少 render 导出');
    const root = new dom.FakeNode('div');
    await mod.render(root, deps);
    return root;
  };

  const currentPage = () => (host && host.firstChild ? host.firstChild : null);

  let waterSheetOpener = null;

  try {
    setGlobal('document', dom.doc);
    setGlobal('window', win);
    setGlobal('Node', dom.FakeNode);
    setGlobal('indexedDB', fakeIdb.indexedDB);
    setGlobal('localStorage', fakeStorage);
    setGlobal('navigator', fakeNavigator);
    setGlobal('matchMedia', (query) => ({
      matches: false, media: String(query),
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    setGlobal('fetch', async () => { fetchCalls.push('fetch'); throw new Error('测试环境不应发出网络请求'); });
    URL.createObjectURL = () => 'blob:fuzz';
    URL.revokeObjectURL = () => {};

    const store = await import('../js/store.js');
    ui = await import('../js/ui.js'); // 清场/弹层收尾的唯一实现：clearOverlays 替身委托给它
    const db = await import('../js/db.js');
    const accounts = await import('../js/accounts.js');
    const cloudConfig = await import('../js/cloud-config.js');
    const nutrition = await import('../js/nutrition.js');
    db.resetDbConnection();

    /** 往当前账号的库里塞原始记录（绕过 store 的归一化，专门用来造畸形数据）。 */
    const injectRaw = async (storeName, rows) => {
      await db.getAll(storeName); // 先确保库真的开过
      const target = fakeIdb.rawStore(db.getDbName(), storeName);
      for (const row of rows) {
        const key = row && row.id != null ? row.id : (target.seq += 1);
        target.seq = Math.max(target.seq, Number(key) || 0);
        target.data.set(key, structuredClone(row));
      }
      return rows.length;
    };

    const today = nutrition.localDateStr();

    /* ------------------------------------------------------------------
     * A. 空状态：零记录时 8 个视图都要能渲染，且不上屏脏值
     * ------------------------------------------------------------------ */

    const EMPTY_EXPECT = [
      ['dashboard', ['今日总览', '热量', '宏量营养素', '饮水', '运动', '今日餐次', '还没有体重记录', '今天还没有饮食记录']],
      ['weight', ['体重', '30 天趋势', '历史记录', '还没有体重数据', '近 30 天没有数据', '暂无历史记录']],
      ['food', ['饮食', '拍照识别', '手动添加', '这一天还没有饮食记录', '当日合计']],
      ['exercise', ['运动', '记录运动', '今日合计', '今天还没有运动记录']],
      ['water', ['饮水', '今日饮水', '自定义', '撤销 250ml']],
      ['settings', ['个人档案', '每日目标', '视觉识别', '导出 JSON', '清空所有健康数据', '关于']],
      ['debug', ['自检', '运行自检（安全项）', '导出 → 清空 → 导入']],
      ['account', ['账号', '当前账号', '账号列表', '云同步']],
    ];

    for (const [view, needles] of EMPTY_EXPECT) {
      await runCase({
        id: 'empty.' + view,
        title: '空库渲染 ' + view,
        area: '渲染/' + view,
        severity: null,
        expected: '零记录时能渲染、有内容、不上屏 undefined/NaN/[object Object]',
        repro: '空库下 render(' + view + ')',
        reach: '-',
      }, async () => {
        const root = await renderView(view);
        assert.ok(root.childNodes.length > 0, view + ' 根节点没有子元素');
        const text = nodeText(root);
        assertNoLeak(text, view);
        for (const needle of needles) {
          assert.ok(text.includes(needle), view + ' 缺少「' + needle + '」：' + text.slice(0, 200));
        }
      });
    }

    note('empty.all', '渲染/全部', '空库下 8 个视图全部渲染成功、无脏值上屏（与 ui.smoke「空数据时 dashboard/weight/water/food 不白屏」一致，本套件把 account/debug/settings 也纳入）。');

    /* ------------------------------------------------------------------
     * B. 并发交互（空库基线，避免受种子数据干扰）
     * ------------------------------------------------------------------ */

    await runCase({
      id: 'race.water-doubletap',
      title: '饮水页「+250」同一帧连点两次',
      area: '交互/water',
      severity: '中',
      expected: '连点两次 +250 应当记 500ml（按钮既没有禁用也没有防抖，两次点击都是有效操作）',
      repro: '空库 → navigate("#/water") → 同一个 tick 里 fireClick(「+250」) 两次 → store.getWater(今天)',
      reach: '会。手机端快速连点快捷加量按钮很常见，结果是静默少记一次（用户不会收到任何提示）',
    }, async () => {
      const page = await navigate('#/water');
      assert.ok(!page.renderError, 'water 页渲染失败：' + (page.renderError && page.renderError.message));
      const before = await store.getWater(today);
      assert.equal(before, 0, '前置：空库下今日饮水应为 0，实际 ' + before);
      const plus = findButton(page, '+250');
      assert.ok(plus, '饮水页没有 +250 按钮');
      fireClick(plus);
      fireClick(plus);
      await tick(400);
      const after = await store.getWater(today);
      const rows = await db.getAllByIndex('waters', 'by_date', today);
      assert.equal(
        after,
        before + 500,
        '连点两次 +250 后今日饮水 = ' + after + ' ml（waters 表里 ' + rows.length + ' 行，ml=' + JSON.stringify(rows.map((r) => r.ml))
          + '），期望 ' + (before + 500) + ' ml —— addWater 是「读-改-写」，两次 addWater 并发读到同一个旧值，后写覆盖先写，丢了一次写入',
      );
    });

    await runCase({
      id: 'race.dashboard-plus250-doubletap',
      title: '今日页「+250 ml」同一帧连点两次',
      area: '交互/dashboard',
      severity: '中',
      expected: '连点两次 +250 应当记 500ml（与饮水页同一个 addWater 路径，同样没有禁用/防抖）',
      repro: '空库 → navigate("#/") → 同一个 tick 里 fireClick(「+250 ml」) 两次 → store.getWater(今天)',
      reach: '会。今日页是首屏，+250 ml 是最常点的按钮之一',
    }, async () => {
      await store.setWater(today, 400);
      const page = await navigate('#/');
      assert.ok(!page.renderError, 'dashboard 渲染失败：' + (page.renderError && page.renderError.message));
      const before = await store.getWater(today);
      assert.equal(before, 400, '前置：基线水量应为 400，实际 ' + before);
      const plus = findButton(page, '+250 ml');
      assert.ok(plus, '今日页没有 +250 ml 按钮');
      fireClick(plus);
      fireClick(plus);
      await tick(400);
      const after = await store.getWater(today);
      assert.equal(
        after,
        before + 500,
        '今日页连点两次 +250 ml 后是 ' + after + ' ml，期望 ' + (before + 500) + ' ml —— 与 race.water-doubletap 同源（addWater 的读改写没有并发保护）',
      );
    });

    // 收尾：把上面两处丢更新留下的水量清掉，后续用例从确定基线开始
    await store.setWater(today, 0);

    /* ------------------------------------------------------------------
     * C. 种子数据（与 ui.smoke 的 SEED 同口径，便于交叉核对）
     * ------------------------------------------------------------------ */

    const SEEDED = await (async () => {
      await store.saveProfile({ nickname: '小林', sex: 'male', birthday: '1990-03-05', heightCm: 172, activity: 'light', weightTargetKg: 65 });
      await store.saveSettings({ apiKey: '', model: 'qwen-vl-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
      await store.logWeight({ date: today, weightKg: 68.4, bodyFatPct: 18.5, note: '空腹' });
      await store.logWeight({ date: nutrition.daysAgo(7), weightKg: 69.2 });
      await store.logMeal({
        date: today, slot: 'lunch', source: 'manual',
        items: [
          { name: '米饭', grams: 200, kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6 },
          { name: '宫保鸡丁', grams: 150, kcal: 320, carb: 12, protein: 22, fat: 20 },
        ],
      });
      await store.logMeal({
        date: today, slot: 'breakfast', source: 'ai',
        items: [{ name: '鸡蛋', grams: 50, kcal: 72, carb: 0.6, protein: 6.3, fat: 5, confidence: 'high' }],
      });
      await store.logExercise({ date: today, type: 'jog', minutes: 30, kcalBurned: 280, note: '慢跑' });
      await store.setWater(today, 1000);
      return { intakeKcal: 624, burned: 280, water: 1000 };
    })();

    await runCase({
      id: 'render.dashboard-with-data',
      title: '有数据时今日页数字与种子一致',
      area: '渲染/dashboard',
      severity: null,
      expected: '摄入 624 kcal / 消耗 280 kcal / 饮水 1000 ml 且不上屏脏值',
      repro: '种子数据 → render(dashboard)',
      reach: '-',
    }, async () => {
      const root = await renderView('dashboard');
      const text = nodeText(root);
      assertNoLeak(text, 'dashboard(有数据)');
      assert.ok(text.includes(String(SEEDED.intakeKcal)), '缺少摄入 ' + SEEDED.intakeKcal + '：' + text.slice(0, 200));
      assert.ok(text.includes(String(SEEDED.burned)), '缺少消耗 ' + SEEDED.burned);
      const goals = await store.getGoals();
      assert.ok(text.includes(SEEDED.water + ' / ' + goals.waterMl + ' ml'), '饮水卡数值不对（期望 ' + SEEDED.water + ' / ' + goals.waterMl + ' ml）：' + text.slice(0, 400));
      const summary = await store.daySummary(today);
      assert.equal(summary.intake.kcal, 624, 'daySummary 摄入不对：' + summary.intake.kcal);
      assert.equal(summary.water, 1000, 'daySummary 饮水不对：' + summary.water);
    });

    /* ------------------------------------------------------------------
     * D. 弹层 / 监听器 / 节点泄漏 / 折叠开关
     * ------------------------------------------------------------------ */

    const openWaterSheet = async () => {
      const page = currentPage() || (await navigate('#/water'));
      const trigger = findButton(page, '自定义');
      assert.ok(trigger, '饮水页没有「自定义」按钮');
      fireClick(trigger);
      await tick(40);
      return dom.doc.querySelector('.sheet-backdrop');
    };
    waterSheetOpener = openWaterSheet;

    await runCase({
      id: 'overlay.sheet-open-close-8x',
      title: '同一弹层连续开关 8 次',
      area: '交互/弹层',
      severity: null,
      expected: '每次关闭后弹层节点消失；8 次之后 document 上不留 keydown 监听器、body 滚动锁复原',
      repro: '[water] 循环 8 次：点「自定义」→ 点弹层右上角 ×',
      reach: '-',
    }, async () => {
      await navigate('#/water');
      const overflowBefore = dom.doc.body.style.overflow;
      for (let i = 0; i < 8; i += 1) {
        const sheet = await openWaterSheet();
        assert.ok(sheet, '第 ' + (i + 1) + ' 次：点「自定义」没有出现弹层');
        assert.equal(dom.doc.querySelectorAll('.sheet-backdrop').length, 1, '第 ' + (i + 1) + ' 次：弹层数量不是 1');
        const close = sheet.walk().find((n) => String(n.className).split(/\s+/).includes('sheet__close'));
        assert.ok(close, '弹层没有关闭按钮');
        fireClick(close);
        await tick(40);
        assert.equal(dom.doc.querySelector('.sheet-backdrop'), null, '第 ' + (i + 1) + ' 次关闭后弹层还留在 DOM 里（僵尸节点）');
      }
      assert.equal(dom.doc.body.style.overflow, overflowBefore, '连开关 8 次后 body 的滚动锁没有复原');
      assert.equal(dom.listenerCount('keydown'), 0, '全部弹层关掉后 document 上仍残留 ' + dom.listenerCount('keydown') + ' 个 keydown 监听器');
    });

    await runCase({
      id: 'overlay.sheet-abandoned-on-route',
      title: '弹层没关就切路由 → document 监听器泄漏',
      area: '交互/弹层 + 路由',
      severity: '低',
      expected: '切路由时 app.js 的 clearOverlays() 会把弹层节点摘掉；被摘掉的弹层不该把 document 级 keydown 监听器一起留下（openSheet 的唯一出口是 finish()，摘节点不会调用它）',
      repro: '[water] 点「自定义」打开弹层 → window.HMS.navigate("#/")（等价于点底部 tab 切页）→ 数 document 上的 keydown 监听器',
      reach: '会，但影响小：切页丢掉弹层是常见操作；后果是监听器 + 整个弹层闭包（含输入内容、照片引用）一直挂着，直到某次按 Esc 才被释放',
    }, async () => {
      await navigate('#/water');
      const sheet = await openWaterSheet();
      assert.ok(sheet, '前置：弹层没有打开');
      assert.equal(dom.listenerCount('keydown'), 1, '前置：打开一个弹层应有 1 个 keydown 监听器，实际 ' + dom.listenerCount('keydown'));
      await navigate('#/');
      assert.equal(dom.doc.querySelector('.sheet-backdrop'), null, '切路由后弹层节点没有被 clearOverlays 摘掉（这条不是本用例要查的点）');
      const leaked = dom.listenerCount('keydown');
      dom.fireDocEvent('keydown', { key: 'Escape' }); // 兜底清理，别污染后续用例
      assert.equal(
        leaked,
        0,
        '切路由丢下弹层后，document 上残留了 ' + leaked + ' 个 keydown 监听器：弹层节点被 clearOverlays 摘掉了，但 openSheet 的 finish() 从没被调用，removeEventListener 也就没跑（同时那个 Promise 永远挂着）',
      );
    });

    await runCase({
      id: 'overlay.confirm-escape-cancels',
      title: '二次确认弹层按 Esc 取消：不删数据、不留节点、不留监听器',
      area: '交互/exercise',
      severity: null,
      expected: 'Esc 解析为 false → 记录保留；弹层节点与 document 监听器都回到基线',
      repro: '[exercise] 点某条记录的「删除」→ 按 Esc',
      reach: '-',
    }, async () => {
      const page = await navigate('#/exercise');
      const delBtn = findButtons(page, '删除')[0];
      assert.ok(delBtn, '运动页没有删除按钮（种子数据没生效？）');
      fireClick(delBtn);
      await tick(40);
      assert.ok(dom.doc.querySelector('.modal-backdrop'), '点删除没有出现二次确认');
      assert.equal(dom.listenerCount('keydown'), 1, '确认框应该只有 1 个 keydown 监听器');
      dom.fireDocEvent('keydown', { key: 'Escape' });
      await tick(40);
      assert.equal(dom.doc.querySelector('.modal-backdrop'), null, 'Esc 之后确认框还在 DOM 里');
      assert.equal(dom.listenerCount('keydown'), 0, 'Esc 之后 document 上还残留 keydown 监听器');
      const summary = await store.daySummary(today);
      assert.equal(summary.exercises.length, 1, 'Esc 取消后运动记录被删掉了：' + summary.exercises.length + ' 条');
    });

    await runCase({
      id: 'interaction.meal-fold-toggle-3x',
      title: '今日页「今日餐次」快速开合 3 次：aria 状态与节点数自洽',
      area: '交互/dashboard',
      severity: null,
      expected: 'aria-expanded / aria-label / 列表节点三者一致；列表节点最多 1 个，开关后不留游离副本',
      repro: '[dashboard] 连点 .meal-fold 三次 → 数 .meal-fold__list 与 aria-expanded',
      reach: '-',
    }, async () => {
      const root = await renderView('dashboard');
      const fold = root.walk().find((n) => String(n.className).split(/\s+/).includes('meal-fold'));
      assert.ok(fold, '今日餐次没有折叠开关');
      fireClick(fold);
      fireClick(fold);
      fireClick(fold);
      const lists = byClass(root, 'meal-fold__list');
      assert.equal(lists.length, 1, '开合 3 次后逐餐列表节点数为 ' + lists.length + '（期望 1，多了就是 DOM 副本）');
      assert.equal(fold.getAttribute('aria-expanded'), 'true', '开合 3 次后 aria-expanded=' + fold.getAttribute('aria-expanded'));
      assert.equal(fold.getAttribute('aria-label'), '收起今日餐次', 'aria-label 与展开态不一致：' + fold.getAttribute('aria-label'));
      assert.ok(lists[0].parentNode && lists[0].parentNode.isConnected === false, '列表节点应挂在游离的 root 上（renderView 本来就不挂 body）');
      fireClick(fold);
      assert.equal(byClass(root, 'meal-fold__list').length, 0, '再点一次收起后列表没摘掉');
      assert.equal(fold.getAttribute('aria-label'), '展开今日餐次', '收起后 aria-label 没跟着变');
    });

    await runCase({
      id: 'interaction.exercise-doubleclick-guard',
      title: '运动页「保存运动」连点两次：只落一条（对照组）',
      area: '交互/exercise',
      severity: null,
      expected: '保存按钮点了就 disabled，第二次点击不产生第二条记录 —— 说明"写入口自带的连点保护"是既有设计',
      repro: '[exercise] 填 30 分钟 → 同一 tick 连点「保存运动」两次 → 数当日运动记录',
      reach: '-',
    }, async () => {
      const page = await navigate('#/exercise');
      const minutes = findInput(page, (n) => String(n.className).split(/\s+/).includes('input') && n.type === 'number');
      assert.ok(minutes, '运动页没有时长输入框');
      minutes.value = '30';
      fireInput(minutes);
      const save = findButton(page, '保存运动');
      assert.ok(save, '运动页没有保存按钮');
      const before = (await store.daySummary(today)).exercises.length;
      fireClick(save);
      const second = fireClick(save);
      assert.equal(second.blockedByDisabled, true, '第二次点击没有被 disabled 挡住');
      await tick(300);
      const after = (await store.daySummary(today)).exercises.length;
      assert.equal(after, before + 1, '连点两次保存运动落了 ' + (after - before) + ' 条记录（期望 1）');
    });

    note('interaction.guard-contrast', '交互', '运动页/体重页/饮食页的保存按钮是"先 disabled 再写库"，天然挡住连点；饮水 +250/+500/撤销与今日页 +250ml 原先没有这层保护（race.water-doubletap / race.dashboard-plus250-doubletap 两条 finding 的成因），修复后它们也走同一套护栏（js/ui.js 的 markBusy：置灰发生在当前任务之后的微任务里，所以同一帧已经分发出来的连点仍然记账，由 store 层原子化的 addWater 如实累加，而不是被去抖丢掉）。');

    await runCase({
      id: 'interaction.rerender-no-listener-growth',
      title: '同一视图重复渲染 3 轮：不涨全局监听器、不堆 body 节点',
      area: '交互/路由',
      severity: null,
      expected: '视图渲染本身不注册 document/window 监听器；重复渲染后全局监听器计数与 body 子节点数都不变（僵尸节点/重复监听都能被这条抓住）',
      repro: '连续 renderView 8 个视图各 3 轮 → 比 document/window 监听器数与 body.childNodes.length',
      reach: '-',
    }, async () => {
      // 基线稳定：toast 是 2.9s 后自删的瞬态节点，先等前一批退场，body 子节点数才是可比的基线。
      // （这条用例查的是"渲染往 body 上堆僵尸节点"，不是"提示会不会自己消失"。）
      await tick(3100);
      const keys = ['keydown', 'click', 'input', 'change', 'pointerdown', 'pointermove', 'pointerup'];
      const docBefore = keys.map((k) => dom.listenerCount(k));
      const winBefore = keys.map((k) => winListenerCount(k));
      const bodyBefore = dom.doc.body.childNodes.length;
      for (let round = 0; round < 3; round += 1) {
        for (const [view] of EMPTY_EXPECT) {
          if (view === 'account') continue; // 账号页会装 window.HMS.cloud 调度器，单独用例覆盖
          await renderView(view);
        }
      }
      assert.deepEqual(keys.map((k) => dom.listenerCount(k)), docBefore, '重复渲染后 document 监听器变多了');
      assert.deepEqual(keys.map((k) => winListenerCount(k)), winBefore, '重复渲染后 window 监听器变多了');
      assert.equal(dom.doc.body.childNodes.length, bodyBefore, '重复渲染后 body 上的节点变多了：' + (dom.doc.body.childNodes.length - bodyBefore) + ' 个');
    });

    await runCase({
      id: 'toast.success-wiped-by-refresh',
      title: '保存成功的 toast 被同一次 refresh 立刻清掉（用户看不到任何成功提示）',
      area: '交互/toast + 路由',
      severity: '中',
      expected: 'toast 是给用户看的成功反馈：写入成功后它应该活到自己的 2.4s 退场动画 / 2.9s 自删，而不是被同一个动作触发的 refresh 同步摘掉',
      repro: '[exercise] 填 20 分钟 → 点「保存运动」（视图里是 toast("运动已记录") 紧跟 await window.HMS.refresh()）→ 立刻数 body 上的 .toast，再等 200ms 数一次',
      reach: '会，而且非常常见。受影响的是所有"先 toast、紧接着 await window.HMS.refresh()"的成功路径：'
        + 'views/exercise.js:162-163（运动已记录）、:220-221（已删除）、views/water.js:26-27（已记录 xxx ml）、'
        + 'views/weight.js:388-389（体重已保存）、:546-547（已删除）、views/settings.js:129-130 / :210-211 / :250-251（档案/目标/识别设置已保存）、'
        + ':379-382（导入完成）、:400-401（数据已清空）、views/dashboard.js:200-201（已记录 250ml）、views/account.js 的登录流程（toast 后 refresh）。'
        + 'app.js 的 renderRoute() 第一件事就是 clearOverlays()（app.js:51 定义、app.js:76 调用，全在第一个 await 之前同步执行），'
        + '它会把 .toast 一起 remove()，所以这些成功提示在真机上一帧都没画出来就被摘掉了；反过来失败提示（后面不 refresh）正常可见'
        + ' —— 用户于是"只在出错时才看得到提示"。次生影响：成功后没有任何确认，用户会重复点保存/加量（而饮水按钮恰好有丢写入的问题，两个 bug 叠加）。'
        + 'views/account.js 的切换/新建/改名/删除是"先 refresh 再 toast"，那几个提示是可见的，可以当对照组。'
        + '既有 tests/ui.smoke.mjs 没发现这条，是因为它的假 HMS.refresh 是空函数（HMS:{navigate(){},refresh:async()=>{}}），而真 app.js 的 refresh 会清 toast。',
    }, async () => {
      const page = await navigate('#/exercise');
      const minutes = findInput(page, (n) => String(n.className).split(/\s+/).includes('input') && n.type === 'number');
      minutes.value = '20';
      fireInput(minutes);
      // 记下"到底有没有把 toast 挂到 body 上"，以及挂上之后还在不在
      const created = [];
      const originalAppend = dom.doc.body.appendChild.bind(dom.doc.body);
      dom.doc.body.appendChild = (node) => {
        if (String(node.className).split(/\s+/).includes('toast')) created.push(node);
        return originalAppend(node);
      };
      try {
        fireClick(findButton(page, '保存运动'));
        await tick(250);
      } finally {
        dom.doc.body.appendChild = originalAppend;
      }
      assert.ok(created.length >= 1, '前置：这次保存根本没有生成 toast（视图逻辑本身变了？）');
      const survivors = created.filter((node) => node.parentNode === dom.doc.body);
      assert.ok(
        survivors.length >= 1,
        'toast 被创建了 ' + created.length + ' 次（文本：' + created.map((t) => t.textOf()).join(' / ') + '），但挂上后立刻从 body 上消失了：'
          + 'window.HMS.refresh() → app.js renderRoute() 的 clearOverlays()（app.js:51、app.js:76，同步执行）把 .toast 一起 remove() 掉了，'
          + 'insert 与 remove 发生在同一个同步任务里，浏览器一帧都没画出来 —— 用户看不到任何成功提示',
      );
    });

    await runCase({
      id: 'toast.error-visible-and-self-cleanup',
      title: '失败 toast 正常可见，并在 2.9s 后自删（不留僵尸节点）',
      area: '交互/toast',
      severity: null,
      expected: '错误路径不 refresh，所以提示可见；toast 到点自己 remove()，等 3.1 秒后 body 上不该再有 .toast',
      repro: '[water] 水量 0 时点「撤销 250ml」→ toast 出现 → 等 3.1s → 数 body 上的 .toast',
      reach: '-',
    }, async () => {
      await store.setWater(today, 0);
      const page = await navigate('#/water');
      fireClick(findButton(page, '撤销 250ml'));
      await tick(150);
      const texts = dom.doc.querySelectorAll('.toast').map((t) => t.textOf());
      assert.ok(texts.some((t) => t.includes('今天还没有记录')), '错误 toast 没出现：' + JSON.stringify(texts));
      await tick(3100);
      assert.equal(dom.doc.querySelectorAll('.toast').length, 0, '3.1 秒后仍有 ' + dom.doc.querySelectorAll('.toast').length + ' 个 .toast 留在 body 上');
      await store.setWater(today, 1000);
    });

    /* ------------------------------------------------------------------
     * E. 账号状态机：认领老库 → 隔离 → 8 个账号来回切 → 删当前账号 → 老账号禁删 → 降级
     * ------------------------------------------------------------------ */

    fakeStorage.clear(); // 目录从零开始（此前的所有数据都在老库 hms 里）
    db.resetDbConnection();

    await runCase({
      id: 'account.legacy-claim',
      title: '首个账号认领老库，老数据原地保留',
      area: '状态机/账号',
      severity: null,
      expected: 'currentAccount() 返回 dbName=hms 的账号，老库里的种子数据一条不少',
      repro: '清空 localStorage 目录 → store.currentAccount()',
      reach: '-',
    }, async () => {
      const current = await store.currentAccount();
      assert.ok(current, 'currentAccount() 没有返回账号');
      assert.equal(current.dbName, accounts.LEGACY_DB_NAME, '第一个账号应认领老库，实际 ' + current.dbName);
      assert.equal(await db.getDbName(), accounts.LEGACY_DB_NAME, '连接没有指向老库：' + (await db.getDbName()));
      assert.equal(accounts.listAccounts().length, 1, '目录里应只有 1 个账号');
      const weights = await db.getAll('weights');
      assert.ok(weights.length >= 2, '认领老库后读不到老数据：' + weights.length + ' 条');
      const profile = await store.getProfile();
      assert.ok(profile && profile.nickname === '小林', '老库档案丢了：' + JSON.stringify(profile));
    });

    await runCase({
      id: 'account.isolate-switch',
      title: '切账号后读的是新库：拿不到上一个账号的任何数据',
      area: '状态机/账号',
      severity: '高',
      expected: '切到账号 B 后，体重/餐次/档案全部来自 B 的库；切回 A 仍是 A 的数据；B 的标记记录在 A 里搜不到',
      repro: '本机(有种子数据) → createAccount(小号A) → switchAccount(A) → 读 weights/profile/daySummary → 写标记 → 切回本机 → 再切 A',
      reach: '会。串库是多账号功能的致命错误（A 的数据显示给 B 看、B 的写入落到 A 上）',
    }, async () => {
      const legacy = await store.currentAccount();
      const a = await accounts.createAccount({ name: '小号A' });
      await store.switchAccount(a.id);
      assert.equal(await db.getDbName(), a.dbName, '切换后连接没有指向新库：' + (await db.getDbName()));
      assert.equal((await db.getAll('weights')).length, 0, '新账号读到了别的账号的体重');
      assert.equal(await store.getProfile(), null, '新账号读到了别的账号的档案');
      assert.equal((await store.daySummary(today)).meals.length, 0, '新账号读到了别的账号的餐次');
      await store.logWeight({ date: today, weightKg: 77.7, note: '小号A的标记' });

      await store.switchAccount(legacy.id);
      assert.equal(await db.getDbName(), accounts.LEGACY_DB_NAME, '切回本机后连接没有回到老库');
      const back = await db.getAll('weights');
      assert.ok(back.length >= 2, '切回本机后读不到老数据：' + back.length + ' 条');
      assert.ok(!back.some((w) => Number(w.weightKg) === 77.7), '切回本机后读到了小号A 的记录（跨账号串库）');
      const profile = await store.getProfile();
      assert.ok(profile && profile.nickname === '小林', '切回本机后档案不对：' + JSON.stringify(profile));

      await store.switchAccount(a.id);
      const aRows = await db.getAll('weights');
      assert.equal(aRows.length, 1, '小号A 的体重记录变成了 ' + aRows.length + ' 条');
      assert.equal(Number(aRows[0].weightKg), 77.7, '小号A 的记录内容不对：' + JSON.stringify(aRows[0]));
    });

    await runCase({
      id: 'account.stress-8-switch',
      title: '建满 8 个账号并固定种子来回切 24 次：每次都要读到自己那个库',
      area: '状态机/账号',
      severity: '高',
      expected: '每个账号只读到自己写的标记体重；第 9 个账号被拒绝并给出中文原因',
      repro: 'createAccount ×7 → 每个账号写一个标记体重 → 用 LCG 随机切 24 次，每次核对库名/条数/标记值 → 再建第 9 个',
      reach: '会。多账号来回切是既有功能，串库或丢数据都会直接暴露给用户',
    }, async () => {
      // 前面的用例可能留下过账号：先清干净，本轮要精确数到 8 个
      const legacyNow = accounts.listAccounts().find((a) => a.dbName === accounts.LEGACY_DB_NAME);
      await store.switchAccount(legacyNow.id);
      for (const account of accounts.listAccounts()) {
        if (account.dbName !== accounts.LEGACY_DB_NAME) await accounts.removeAccount(account.id);
      }
      assert.equal(accounts.listAccounts().length, 1, '前置清理失败');
      for (let i = 1; i <= 7; i += 1) await accounts.createAccount({ name: '号' + i });
      const all = accounts.listAccounts();
      assert.equal(all.length, accounts.MAX_ACCOUNTS, '账号数应为 ' + accounts.MAX_ACCOUNTS + '，实际 ' + all.length);

      for (const [index, account] of all.entries()) {
        await store.switchAccount(account.id);
        await store.logWeight({ date: today, weightKg: 60 + index });
      }

      for (let round = 0; round < 24; round += 1) {
        const index = randInt(rng, 0, all.length - 1);
        const account = all[index];
        await store.switchAccount(account.id);
        assert.equal(await db.getDbName(), account.dbName, '第 ' + (round + 1) + ' 次切换后库名不对');
        const rows = await db.getAll('weights');
        const markerToday = rows.find((w) => w.date === today);
        assert.ok(markerToday, '账号 ' + account.name + ' 里找不到今天的记录：' + JSON.stringify(rows.map((w) => w.date)));
        assert.equal(Number(markerToday.weightKg), 60 + index, '账号 ' + account.name + ' 读到标记 ' + markerToday.weightKg + '（期望 ' + (60 + index) + '）：串到了别的账号的库');
        const expectedRows = account.dbName === accounts.LEGACY_DB_NAME ? 2 : 1; // 本机账号另有 7 天前那条种子体重
        assert.equal(rows.length, expectedRows, '账号 ' + account.name + ' 的体重记录数 = ' + rows.length + '（期望 ' + expectedRows + '）');
        await store.logWeight({ date: today, weightKg: 60 + index });
        assert.equal((await db.getAll('weights')).length, expectedRows, '同日重复保存后记录数 = ' + (await db.getAll('weights')).length + '（期望 ' + expectedRows + '，多了就是 upsert 失效）');
      }

      let error = null;
      try { await accounts.createAccount({ name: '第9个' }); } catch (err) { error = err; }
      assert.ok(error, '第 9 个账号没有被拒绝');
      assert.ok(String(error.message).includes('最多只能建 8 个账号'), '上限报错文案不对：' + error.message);
    });

    await runCase({
      id: 'account.view-max-8',
      title: '账号页在 8 个账号时：上限文案、禁用态、老账号禁删',
      area: '渲染/account',
      severity: null,
      expected: '显示 8 / 8；「新建账号」禁用；认领老库的那一行删除按钮禁用 + aria-disabled + 不挂 click；点它什么都不发生',
      repro: '建满 8 个账号 → render(account) → 检查按钮态 → fireClick(禁用删除)',
      reach: '-',
    }, async () => {
      const root = await renderView('account');
      const text = nodeText(root);
      assertNoLeak(text, 'account(8 个账号)');
      assert.ok(text.includes('8 / 8'), '账号数没有显示成 8 / 8：' + text.slice(0, 200));
      const rows = byClass(root, 'account-row');
      assert.equal(rows.length, 8, '账号列表行数 = ' + rows.length + '（期望 8）');
      const newBtn = findButton(root, '已达上限（8 个）');
      assert.ok(newBtn, '达到上限后没有「已达上限（8 个）」按钮');
      assert.equal(newBtn.disabled, true, '达到上限后「新建账号」没有禁用');
      const legacyRow = rows.find((r) => r.textOf().includes('本机老数据'));
      assert.ok(legacyRow, '列表里找不到认领老库的账号行');
      assert.ok(legacyRow.textOf().includes('本机数据所在账号不能删除'), '老账号行缺少禁删原因文案');
      const delBtn = findButtons(legacyRow, '删除')[0];
      assert.ok(delBtn, '老账号行没有删除按钮');
      assert.equal(delBtn.disabled, true, '老账号的删除按钮没有禁用');
      assert.equal(delBtn.getAttribute('aria-disabled'), 'true', '老账号删除按钮缺 aria-disabled');
      assert.equal((delBtn.listeners.click || []).length, 0, '禁用的按钮上居然挂了 click 监听器');
      fireClick(delBtn);
      await tick(80);
      assert.equal(dom.doc.querySelector('.modal-backdrop'), null, '点禁用的删除按钮弹出了确认框');
      assert.equal(accounts.listAccounts().length, 8, '点禁用的删除按钮后账号数变了');
    });

    await runCase({
      id: 'account.delete-current-falls-back',
      title: '删掉当前账号：切回认领老库的账号且老数据完好',
      area: '状态机/账号',
      severity: '高',
      expected: '删除后目录里少一个；它的库被删掉；当前账号回到本机；老库数据仍能读到且页面已重绘',
      repro: '切到「号1」→ 账号页点该行「删除」→ 确认 → 读 currentAccount / getDbName / 老库数据',
      reach: '会。删当前账号是账号页的主要动作之一',
    }, async () => {
      const victim = accounts.listAccounts().find((a) => a.dbName !== accounts.LEGACY_DB_NAME);
      assert.ok(victim, '找不到可删的账号');
      await store.switchAccount(victim.id);
      assert.equal(await db.getDbName(), victim.dbName, '前置：没有切到待删账号');
      const page = await navigate('#/account');
      assert.ok(!page.renderError, '账号页渲染失败：' + (page.renderError && page.renderError.message));
      const row = byClass(page, 'account-row').find((r) => r.textOf().includes(victim.name));
      assert.ok(row, '账号列表里找不到 ' + victim.name);
      fireClick(findButtons(row, '删除')[0]);
      await tick(80);
      const modal = dom.doc.querySelector('.modal-backdrop');
      assert.ok(modal, '删除账号没有二次确认');
      fireClick(findButton(modal, '删除'));
      await tick(600);
      assert.equal(accounts.listAccounts().some((a) => a.id === victim.id), false, '账号没有被删掉');
      assert.equal(fakeIdb.has(victim.dbName), false, '账号的库没有被删掉：' + victim.dbName);
      const active = await store.currentAccount();
      assert.ok(active && active.dbName === accounts.LEGACY_DB_NAME, '删掉当前账号后没有切回老库账号，实际 ' + JSON.stringify(active));
      assert.equal(await db.getDbName(), accounts.LEGACY_DB_NAME, '删掉当前账号后连接的库名不对：' + (await db.getDbName()));
      assert.ok((await db.getAll('weights')).length > 0, '切回老库后读不到老数据');
    });

    await runCase({
      id: 'account.broken-storage',
      title: 'localStorage 被禁用：建账号报中文错，页面仍能渲染',
      area: '状态机/账号',
      severity: null,
      expected: 'createAccount 抛「本地存储不可用，无法保存账号」；ensureDefaultAccount 仍返回指向老库的账号；账号页不白屏',
      repro: '把全局 localStorage 换成"读写都抛"的假实现 → createAccount / currentAccount / render(account)',
      reach: '-',
    }, async () => {
      const previous = globalThis.localStorage;
      setGlobal('localStorage', createStorage({ broken: true }));
      try {
        let error = null;
        try { await accounts.createAccount({ name: '写不进去' }); } catch (err) { error = err; }
        assert.ok(error, 'localStorage 不可用时 createAccount 竟然成功了');
        assert.ok(String(error.message).includes('本地存储不可用'), '报错文案不对：' + error.message);
        const account = await accounts.ensureDefaultAccount();
        assert.ok(account && account.dbName === accounts.LEGACY_DB_NAME, 'localStorage 不可用时没给出可用账号：' + JSON.stringify(account));
        const root = await renderView('account');
        const text = nodeText(root);
        assertNoLeak(text, 'account(localStorage 不可用)');
        assert.ok(text.includes('本机'), 'localStorage 不可用时账号页没有回落显示本机：' + text.slice(0, 200));
      } finally {
        setGlobal('localStorage', previous);
      }
    });

    await runCase({
      id: 'account.corrupt-catalog',
      title: '账号目录被改坏：listAccounts 整形、getActiveAccount 回落、页面不崩',
      area: '状态机/账号',
      severity: null,
      expected: '坏 JSON / 非数组 → []；同一个库只留先出现的账号；缺 id/name 丢弃；非法 createdAt 回落 0；active 指向不存在的 id → null',
      repro: '直接往 localStorage 的 hms.accounts 里塞坏内容与重复库名 → listAccounts / getActiveAccount / render(account)',
      reach: '-',
    }, async () => {
      const bag = fakeStorage.__map;
      const catalogRaw = bag.get(accounts.CATALOG_KEY);
      const activeRaw = bag.get(accounts.ACTIVE_KEY);
      try {
        bag.set(accounts.CATALOG_KEY, 'not-json{');
        assert.deepEqual(accounts.listAccounts(), [], '坏 JSON 应返回空目录');
        bag.set(accounts.CATALOG_KEY, JSON.stringify({ id: 'x' }));
        assert.deepEqual(accounts.listAccounts(), [], '非数组应返回空目录');
        bag.set(accounts.CATALOG_KEY, JSON.stringify([
          { id: 'a', name: 'A', dbName: 'hms-u-a', createdAt: 1 },
          { id: 'b', name: 'B', dbName: 'hms-u-a', createdAt: 2 },
          { name: '缺 id' },
          { id: 'c' },
          null, 42, 'x',
          { id: 'd', name: 'D', dbName: 'hms-u-d', createdAt: 'abc' },
        ]));
        const list = accounts.listAccounts();
        assert.equal(list.length, 2, '脏目录整形后应剩 2 条，实际 ' + JSON.stringify(list));
        assert.equal(list.map((a) => a.id).sort().join(','), 'a,d', '脏目录整形结果不对（重复库名只该留先出现的 a，缺 id/name 的丢弃）：' + JSON.stringify(list));
        assert.ok(!list.some((a) => a.id === 'b'), '共用同一个库的后出现的账号没有被丢掉');
        assert.equal(list.find((a) => a.id === 'd').createdAt, 0, '非法 createdAt 应回落 0：' + JSON.stringify(list));
        assert.ok(list.every((a) => a.dbName), '整形后每个账号都必须有库名：' + JSON.stringify(list));
        bag.set(accounts.ACTIVE_KEY, 'not-exist');
        assert.equal(accounts.getActiveAccount(), null, '当前账号指向不存在的 id 时应返回 null');
        const root = await renderView('account');
        assertNoLeak(nodeText(root), 'account(脏目录)');
      } finally {
        if (catalogRaw == null) bag.delete(accounts.CATALOG_KEY); else bag.set(accounts.CATALOG_KEY, catalogRaw);
        if (activeRaw == null) bag.delete(accounts.ACTIVE_KEY); else bag.set(accounts.ACTIVE_KEY, activeRaw);
        db.resetDbConnection();
        await db.setDbName(accounts.LEGACY_DB_NAME);
      }
    });

    // 收尾：把压测建出来的账号删干净，只留认领老库的那个（后面还要新建专用账号）
    for (const account of accounts.listAccounts()) {
      if (account.dbName !== accounts.LEGACY_DB_NAME) await accounts.removeAccount(account.id);
    }
    assert.equal(accounts.listAccounts().length, 1, '账号收尾失败：还剩 ' + accounts.listAccounts().length + ' 个账号');

    /* ------------------------------------------------------------------
     * F. 同步状态机（注入假 transport，绝不真发请求）
     * ------------------------------------------------------------------ */

    // 独立账号：conflict-pull 那条会真的用云端快照整份覆盖本机，别把老库的种子数据冲掉
    const syncAccount = await accounts.createAccount({ name: '同步库' });
    await store.switchAccount(syncAccount.id);
    await store.logWeight({ date: today, weightKg: 70.5, note: '同步库的标记' });

    const SYNC_BASE_URL = 'https://gw.fuzz.test/api';
    const syncDeps = { baseUrl: SYNC_BASE_URL, transport: null };
    routeDeps.account = syncDeps;

    const makeTransport = (handlers = {}) => {
      const calls = [];
      const state = {
        login: async () => ({ ok: true, token: 'tok-fuzz', userId: 'u-fuzz' }),
        pull: async () => ({ ok: true, rev: 0, savedAt: 0, payload: {} }),
        push: async ({ baseRev }) => ({ ok: true, rev: baseRev + 1 }),
        register: async () => ({ ok: true, userId: 'u-fuzz', recoveryCode: 'RECOVERY-CODE' }),
        reset: async () => ({ ok: true }),
        ...handlers,
      };
      const transport = { calls, handlers: state };
      for (const name of ['login', 'pull', 'push', 'register', 'reset']) {
        transport[name] = async (args) => {
          calls.push({ name, args: args || {} });
          return state[name](args || {});
        };
      }
      return transport;
    };

    const renderAccountWith = async (transport) => {
      syncDeps.transport = transport;
      return navigate('#/account');
    };

    const toastTexts = () => dom.doc.querySelectorAll('.toast').map((t) => t.textOf());

    await runCase({
      id: 'sync.success-toast-vs-stale-card',
      title: '手动同步成功后：toast 说已上传，状态行还停在「尚未同步 / 有未同步改动」',
      area: '状态机/同步 + 文案自洽',
      severity: '低',
      expected: '同一次「立即同步」成功后，界面上的结论必须一致：要么状态行跟着刷新成「已全部同步」，要么 toast 不发。绝不能一边说已上传、一边说尚未同步',
      repro: '已登录（直接写本机凭据）→ render(account) → 点「立即同步」（假 transport：pull 无快照、push 成功 rev 1）→ 对同一张卡片读文案 + 读 toast',
      reach: '会。用户点完同步看到绿 toast，卡片却还说"尚未同步 / 有未同步改动"，会怀疑到底同没同上去（切页或重开才正确）',
    }, async () => {
      await store.clearSyncState();
      const account = await store.currentAccount();
      cloudConfig.writeCloudAuth(account.id, { username: 'fuzzuser', serverId: 'u-fuzz', token: 'tok-fuzz' });
      const transport = makeTransport();
      const page = await renderAccountWith(transport);
      assert.ok(nodeText(page).includes('有未同步改动'), '前置：应显示「有未同步改动」：' + nodeText(page).slice(0, 300));
      fireClick(findButton(page, '立即同步'));
      await tick(500);
      const pushes = transport.calls.filter((c) => c.name === 'push');
      assert.equal(pushes.length, 1, '点一次「立即同步」应上传一次，实际 ' + JSON.stringify(transport.calls.map((c) => c.name)));
      const toastText = toastTexts().join(' | ');
      assert.ok(toastText.includes('已上传本机数据'), '成功同步没有对应 toast：' + toastText);
      const staleCard = nodeText(page);

      // 重渲染一次：证明同步本身成功（这是"刷新缺口"而不是"同步逻辑错"的关键证据）
      const fresh = await renderAccountWith(transport);
      const freshText = nodeText(fresh);
      assert.ok(freshText.includes('已全部同步'), '重渲染后应显示「已全部同步」：' + freshText.slice(0, 300));
      assert.ok(!/上次同步\s*尚未同步/.test(freshText), '重渲染后「上次同步」还是尚未同步：' + freshText.slice(0, 300));

      assert.ok(
        !(staleCard.includes('尚未同步') && toastText.includes('已上传本机数据')),
        '同一个页面上同时出现「已上传本机数据（云端 rev 1）」（toast）与「上次同步 尚未同步 / 有未同步改动」（状态行）：'
          + 'syncNow() 成功后没有 window.HMS.refresh()，状态行停在同步前。重渲染后是正确的（已全部同步），所以这是刷新缺口，不是同步逻辑错误。'
          + ' 卡片当时文案：' + staleCard.slice(0, 240),
      );
    });

    await runCase({
      id: 'sync.offline-failure-selfconsistent',
      title: '离线（pull 抛异常）：中文提示 + 状态行不自相矛盾 + rev 不动',
      area: '状态机/同步',
      severity: null,
      expected: 'toast 说「无法连接云端」；卡片不得出现「已全部同步」；本机改动标记保持；rev 保持 0；再点一次是第二次请求（不是重复监听器导致的连环触发）',
      repro: 'clearSyncState → render(account) → 点「立即同步」（pull 抛错）→ 读 toast + 卡片 → 再点一次',
      reach: '-',
    }, async () => {
      await store.clearSyncState();
      const transport = makeTransport({ pull: async () => { throw new Error('offline'); } });
      const page = await renderAccountWith(transport);
      fireClick(findButton(page, '立即同步'));
      await tick(400);
      const toastText = toastTexts().join(' | ');
      assert.ok(toastText.includes('无法连接云端'), '离线同步没有给出中文提示：' + toastText);
      const text = nodeText(page);
      assert.ok(!text.includes('已全部同步'), '同步失败时卡片却显示「已全部同步」：' + text.slice(0, 300));
      assert.ok(text.includes('有未同步改动'), '同步失败后卡片应保持「有未同步改动」：' + text.slice(0, 300));
      assert.equal((await store.getSyncState()).rev, 0, '失败路径不该改 rev：' + (await store.getSyncState()).rev);
      fireClick(findButton(page, '立即同步'));
      await tick(400);
      assert.equal(transport.calls.filter((c) => c.name === 'pull').length, 2, '第二次点击没有产生第二次请求：' + JSON.stringify(transport.calls.map((c) => c.name)));
    });

    await runCase({
      id: 'sync.409-then-conflict-backup',
      title: 'push 撞 409 → 再点一次走 conflict-pull：先留冲突副本再覆盖',
      area: '状态机/同步',
      severity: null,
      expected: '第一次：说清「云端已有更新（rev 5）」、本机数据与 rev 一个字节不动；第二次：远端给可用快照 → 存冲突副本 → 用云端数据覆盖 → rev=5 → 重渲染后提示「存在冲突副本」且不再说「有未同步改动」',
      repro: 'clearSyncState → pull 返回 rev 0（无可用快照）→ push 返回 {ok:false,error:"rev-conflict",rev:5} → 点同步 → 改 pull 返回 rev5 快照 → 再点同步',
      reach: '-',
    }, async () => {
      await store.clearSyncState();
      await db.del('meta', 'conflictBackup');
      const remotePayload = {
        app: 'hms',
        schemaVersion: 1,
        meta: { profile: { nickname: '云端用户' } },
        weights: [{ id: 1, date: '2010-10-10', weightKg: 70 }],
        meals: [],
        exercises: [],
        waters: [],
      };
      const transport = makeTransport({
        pull: async () => ({ ok: true, rev: 0, savedAt: 0, payload: {} }),
        push: async () => ({ ok: false, error: 'rev-conflict', rev: 5 }),
      });
      const page = await renderAccountWith(transport);
      const localBefore = (await db.getAll('weights')).length;
      fireClick(findButton(page, '立即同步'));
      await tick(400);
      const toastText = toastTexts().join(' | ');
      assert.ok(toastText.includes('云端已有更新（rev 5）'), '409 没有说清云端已有更新：' + toastText);
      assert.equal((await db.getAll('weights')).length, localBefore, '409 时本机数据被动了');
      assert.equal((await store.getSyncState()).rev, 0, '409 时本机 rev 被改了');

      transport.handlers.pull = async () => ({ ok: true, rev: 5, savedAt: 1700000000000, payload: remotePayload });
      fireClick(findButton(page, '立即同步'));
      await tick(700);
      const backup = await db.getMeta('conflictBackup', null);
      assert.ok(backup && backup.savedAt > 0 && backup.payload, '冲突副本没有落库：' + JSON.stringify(backup).slice(0, 200));
      const rows = await db.getAll('weights');
      assert.ok(rows.some((w) => w.date === '2010-10-10'), '云端数据没有落到本机：' + JSON.stringify(rows));
      assert.ok(!rows.some((w) => w.date === today), '本机数据没有被云端整份替换：' + JSON.stringify(rows.map((w) => w.date)));
      assert.equal((await store.getSyncState()).rev, 5, '拉取后 rev 应是 5');
      assert.equal(transport.calls.filter((c) => c.name === 'push').length, 1, '第二次点击又 push 了一次：' + JSON.stringify(transport.calls.map((c) => c.name)));
      const fresh = await renderAccountWith(transport);
      const freshText = nodeText(fresh);
      assert.ok(freshText.includes('存在冲突副本'), '重渲染后没有提示存在冲突副本：' + freshText.slice(0, 300));
      assert.ok(freshText.includes('已全部同步'), '拉取后应显示「已全部同步」：' + freshText.slice(0, 300));
      assert.ok(!freshText.includes('有未同步改动'), '拉取后状态行自相矛盾（同时说已全部同步与有未同步改动）：' + freshText.slice(0, 300));
    });

    await runCase({
      id: 'sync.login-then-logout',
      title: '走真实 UI 登录 → 立刻退出：令牌清掉、文案回到未登录、残留调度器不再发请求',
      area: '状态机/同步 + 账号',
      severity: null,
      expected: '登录后本机存 token + 账号页显示已登录 + 装上 window.HMS.cloud；退出后 token 清空、serverId 保留、卡片回到未登录且不再有「立即同步」；退出后残留调度器触发一次同步也不得发出任何请求',
      repro: 'render(account) → 点「登录」→ 填表单提交（假 transport）→ 立刻点「退出登录」→ 确认 → 核对凭据/文案/请求数',
      reach: '-',
    }, async () => {
      await store.clearSyncState();
      const account = await store.currentAccount();
      cloudConfig.clearCloudToken(account.id);
      const transport = makeTransport({
        login: async () => ({ ok: true, token: 'tok-login', userId: 'u-login' }),
        push: async ({ baseRev }) => { await tick(30); return { ok: true, rev: baseRev + 1 }; },
      });
      const page = await renderAccountWith(transport);
      fireClick(findButton(page, '登录'));
      await tick(80);
      const sheet = dom.doc.querySelector('.sheet-backdrop');
      assert.ok(sheet, '点「登录」没有弹出表单');
      const inputs = sheet.walk().filter((n) => n.tagName === 'input');
      assert.ok(inputs.length >= 2, '登录表单缺少输入框：' + inputs.length);
      inputs[0].value = 'fuzz_user';
      inputs[1].value = 'password123';
      fireClick(findButton(sheet, '登录'));
      await tick(500);
      const auth = cloudConfig.readCloudAuth(account.id);
      assert.ok(auth && auth.token === 'tok-login', '登录后本机没有存下令牌：' + JSON.stringify(auth));
      assert.equal(cloudConfig.readCloudAuth(account.id).serverId, 'u-login', '登录后没有记下 serverId');
      assert.ok(globalThis.window.HMS.cloud, '登录后账号页没有装上同步调度器');
      const logged = await renderAccountWith(transport);
      assert.ok(nodeText(logged).includes('已登录'), '重渲染后云卡片没有显示已登录：' + nodeText(logged).slice(0, 300));

      fireClick(findButton(logged, '退出登录'));
      await tick(100);
      const modal = dom.doc.querySelector('.modal-backdrop');
      assert.ok(modal, '退出登录没有二次确认');
      fireClick(findButton(modal, '退出登录'));
      await tick(500);
      const after = cloudConfig.readCloudAuth(account.id);
      assert.ok(after && !after.token, '退出登录后本机还留着令牌：' + JSON.stringify(after));
      assert.equal(after.serverId, 'u-login', '退出登录不该清掉绑定（serverId）');
      const page2 = await renderAccountWith(transport);
      const text2 = nodeText(page2);
      assert.ok(text2.includes('未登录'), '退出后云卡片没有回到未登录态：' + text2.slice(0, 300));
      assert.ok(!text2.includes('立即同步'), '退出后仍然显示「立即同步」');
      assert.ok(text2.includes('已绑定云端'), '退出后账号行应显示「已绑定云端」：' + text2.slice(0, 400));

      const callsBefore = transport.calls.length;
      const cloud = globalThis.window.HMS.cloud;
      if (cloud) {
        cloud.schedule('after-logout');
        const won = await cloud.flush();
        cloud.cancel();
        assert.equal(won, null, '退出登录后残留调度器仍然跑了一次同步：' + JSON.stringify(won));
      }
      assert.equal(transport.calls.length, callsBefore, '退出登录后仍然发出了网络请求：' + JSON.stringify(transport.calls.slice(callsBefore).map((c) => c.name)));
      assert.equal(fetchCalls.length, 0, '整轮下来不该有任何真实 fetch 调用：' + JSON.stringify(fetchCalls));
    });

    {
      const legacy = accounts.listAccounts().find((a) => a.dbName === accounts.LEGACY_DB_NAME);
      await store.switchAccount(legacy.id);
      await accounts.removeAccount(syncAccount.id);
    }

    /* ------------------------------------------------------------------
     * G. 超大状态：数据驱动的渲染压力（专用账号，避免污染老库）
     * ------------------------------------------------------------------ */

    await runCase({
      id: 'scale.huge-data-render',
      title: '2000 体重 / 500 餐 × 50 条 / 300 运动 下各视图仍能渲染',
      area: '渲染/超大状态',
      severity: '中',
      expected: '每个视图都不抛异常、耗时在 5s 预算内、不上屏脏值；饮食页有 500 张餐卡、库里 2000 条体重、账号页数据规模对得上',
      repro: '专用账号 → 直接往库里塞 2000 条体重 + 500 条餐（每条 50 个条目）+ 300 条运动 + 1 行饮水 → 逐视图计时 render()',
      reach: '低概率（正常使用一年也到不了这个量级），但它正是"某次改动引入 O(n²)"的探针：一旦超时就是真机上整页卡死',
    }, async () => {
      const big = await accounts.createAccount({ name: '大库' });
      await store.switchAccount(big.id);
      const weights = [];
      for (let i = 0; i < 2000; i += 1) {
        weights.push({ id: i + 1, date: nutrition.daysAgo(i), weightKg: 60 + (i % 300) * 0.1, createdAt: Date.now() - i * 1000 });
      }
      await injectRaw('weights', weights);
      const meals = [];
      for (let m = 0; m < 500; m += 1) {
        const items = [];
        for (let k = 0; k < 50; k += 1) {
          items.push({ name: '食物' + m + '-' + k, grams: 100, kcal: 50, carb: 10, protein: 5, fat: 2 });
        }
        meals.push({
          id: m + 1, date: today, slot: ['breakfast', 'lunch', 'dinner', 'snack'][m % 4],
          items, source: 'manual', createdAt: Date.now() - m * 1000,
        });
      }
      await injectRaw('meals', meals);
      const exercises = [];
      for (let e = 0; e < 300; e += 1) exercises.push({ id: e + 1, date: today, type: 'jog', minutes: 30, kcalBurned: 200, createdAt: Date.now() - e * 1000 });
      await injectRaw('exercises', exercises);
      await injectRaw('waters', [{ id: 1, date: today, ml: 2000 }]);

      const timings = [];
      const roots = {};
      for (const view of ['dashboard', 'food', 'weight', 'exercise', 'water', 'account']) {
        const started = Date.now();
        const root = await renderView(view);
        const cost = Date.now() - started;
        timings.push(view + '=' + cost + 'ms');
        assert.ok(cost < 5000, view + ' 在超大状态下的渲染耗时 ' + cost + 'ms 超过 5s 预算（实测最慢 175ms，量级回归会在这里露头）');
        assert.ok(root.childNodes.length > 0, view + ' 超大状态下渲染成空');
        scanLeaks(root, view + '(超大状态)');
        roots[view] = root;
      }
      const mealCards = byClass(roots.food, 'card').filter((c) => c.textOf().includes('删整餐'));
      assert.equal(mealCards.length, 500, '饮食页餐卡数 = ' + mealCards.length + '（期望 500）');
      const historyRows = byClass(roots.weight, 'list__item');
      assert.equal(historyRows.length, 60, '体重页历史行数 = ' + historyRows.length + '（recentWeights(60) 是 60 天窗口，期望 60）');
      assert.equal((await db.getAll('weights')).length, 2000, '库里体重条数不对（超大状态没塞满）');
      const accountText = nodeText(roots.account);
      assert.ok(accountText.includes('2000'), '账号页数据规模没有反映 2000 条体重：' + accountText.slice(0, 300));
      assert.ok(accountText.includes('500'), '账号页数据规模没有反映 500 条饮食：' + accountText.slice(0, 300));
      note('scale.timings', '渲染/超大状态', '2000 体重 / 500 餐×50 条 / 300 运动 下的 render 耗时：' + timings.join('、'));
    });

    // 超大状态的库用完就删（否则后面的用例每次读库都要拖几十兆）
    {
      const bigAccount = accounts.listAccounts().find((a) => a.name === '大库');
      if (bigAccount) {
        const legacy = accounts.listAccounts().find((a) => a.dbName === accounts.LEGACY_DB_NAME);
        await store.switchAccount(legacy.id);
        await accounts.removeAccount(bigAccount.id);
      }
    }

    /* ------------------------------------------------------------------
     * H. 畸形记录与极端数值（专用账号，逐组单独注入，避免互相甩锅）
     * ------------------------------------------------------------------ */

    /** 宽松版脏值检查：连 undefinedg 这种"拼进单词里"的漏出也要抓（正常中文文案不会出现这些串）。 */
    const assertNoLooseLeak = (text, label) => {
      const hits = [];
      if (/undefined/.test(text)) hits.push('undefined');
      if (/NaN/.test(text)) hits.push('NaN');
      if (/\[object Object\]/.test(text)) hits.push('[object Object]');
      assert.equal(hits.join('/'), '', label + ' 上屏脏值 ' + hits.join('/') + '：' + text.slice(0, 240));
    };

    const dirtyAccount = await accounts.createAccount({ name: '脏库' });
    await store.switchAccount(dirtyAccount.id);

    const MALFORMED = [
      {
        key: 'meals-null-item',
        store: 'meals',
        rows: () => [{ id: 1, date: today, slot: 'lunch', source: 'manual', createdAt: Date.now(), items: [null] }],
        views: ['dashboard', 'food'],
        severity: '中',
        expectation: '条目数组里出现 null 时应跳过这一条（sumItems/itemUnitHint 都做了空值兜底），而不是整页抛异常',
        repro: '往 meals 里塞一条 items:[null]（模拟半截写入 / 手改 / 历史脏数据）→ render(dashboard) 与 render(food)',
        reach: '低概率但后果重：库里一旦有这种记录，今日页与饮食页会整页变成「这个页面加载失败了」，用户自己没法恢复（只能清数据）',
      },
      {
        key: 'meals-items-null-field',
        store: 'meals',
        rows: () => [{ id: 1, date: today, slot: 'lunch', source: 'manual', createdAt: Date.now(), items: null }],
        views: ['dashboard', 'food'],
        severity: '低',
        expectation: 'items 整个为 null 时应按"没有条目"渲染',
        repro: '塞一条 items:null → render(dashboard) / render(food)',
        reach: '低概率',
      },
      {
        key: 'meals-item-not-object',
        store: 'meals',
        rows: () => [{ id: 1, date: today, slot: 'lunch', source: 'manual', createdAt: Date.now(), items: [42] }],
        views: ['dashboard', 'food'],
        severity: '低',
        expectation: '条目不是对象时应跳过；不许把 undefined 拼进界面（food 的元信息行会拼出「undefinedg」）',
        repro: '塞一条 items:[42] → render(dashboard) / render(food)',
        reach: '低概率',
      },
      {
        key: 'meals-missing-fields',
        store: 'meals',
        rows: () => [
          { id: 1, date: today, slot: 'brunch', items: [{ name: '缺字段', grams: -1, kcal: 'abc' }] },
          { id: 2, date: 'not-a-date', slot: 'lunch', items: [{ name: '日期坏了', grams: 100, kcal: 100 }] },
        ],
        views: ['dashboard', 'food', 'account'],
        severity: '低',
        expectation: '非法 slot / 非法日期 / 负数克数 / 非数字热量都要有兜底，不上屏脏值也不要崩',
        repro: '塞 slot=brunch、date=not-a-date、grams=-1、kcal="abc" 的记录 → 三个视图各渲染一次',
        reach: '低概率',
      },
      {
        key: 'exercises-garbage',
        store: 'exercises',
        rows: () => [{ id: 1, date: today, type: null, minutes: 'abc', kcalBurned: Infinity, createdAt: 'nope', note: '备注' }],
        views: ['dashboard', 'exercise'],
        severity: '低',
        expectation: 'type/minutes/kcalBurned/createdAt 全是垃圾时用兜底值渲染',
        repro: '塞 type=null、minutes="abc"、kcalBurned=Infinity 的运动记录 → render(dashboard) / render(exercise)',
        reach: '低概率',
      },
      {
        key: 'waters-garbage',
        store: 'waters',
        rows: () => [{ id: 1, date: today, ml: -1 }],
        views: ['dashboard', 'water'],
        severity: '低',
        expectation: '负数水量按 0 处理（waterOf 已有 Math.max(0, ...) 兜底），进度环不出现负值/NaN',
        repro: '塞一条 ml:-1 的饮水记录 → render(dashboard) / render(water)',
        reach: '低概率',
      },
      {
        key: 'weights-garbage',
        store: 'weights',
        rows: () => [{ id: 1, date: today, weightKg: 'abc' }, { id: 2, date: 'not-a-date', weightKg: 70 }],
        views: ['dashboard', 'weight'],
        severity: '低',
        expectation: 'weightKg 非数字 / 日期非法的记录要么被过滤、要么按 0 兜底，不上屏 NaN',
        repro: '塞 weightKg:"abc" 与 date:"not-a-date" 的体重记录 → render(dashboard) / render(weight)',
        reach: '低概率',
      },
      {
        key: 'weights-infinity',
        store: 'weights',
        rows: () => [{ id: 1, date: today, weightKg: Infinity }],
        views: ['dashboard', 'weight'],
        severity: '低',
        expectation: 'Infinity 体重按"非法"处理（weightStats 会过滤），不上屏 Infinity/NaN',
        repro: '塞一条 weightKg:Infinity 的体重记录 → render(dashboard) / render(weight)',
        reach: '低概率',
      },
      {
        key: 'meals-extreme-numbers',
        store: 'meals',
        rows: () => [{
          id: 1, date: today, slot: 'lunch', source: 'manual', createdAt: Date.now(),
          items: [{ name: '极端数值', grams: 0, kcal: 1e308, carb: -1, protein: 1e308, fat: 'abc' }],
        }],
        views: ['dashboard', 'food'],
        severity: '低',
        expectation: '1e308 / 负数 / 非数字的营养值兜底成可读文本，不上屏 NaN',
        repro: '塞 kcal:1e308、carb:-1、fat:"abc" 的条目 → render(dashboard) / render(food)',
        reach: '低概率（正常录入写不出 1e308）',
      },
      {
        key: 'long-text-10000',
        store: 'meals',
        rows: () => [{
          id: 1, date: today, slot: 'lunch', source: 'manual', createdAt: Date.now(),
          items: [{ name: '长'.repeat(10000), grams: 100, kcal: 100, carb: 1, protein: 1, fat: 1 }],
        }],
        views: ['dashboard', 'food'],
        severity: '低',
        expectation: '一万字的条目名不能让渲染崩掉或超时',
        repro: '塞一条 10000 字符的条目名 → render(dashboard) / render(food)',
        reach: '低概率',
      },
      {
        key: 'weights-long-note',
        store: 'weights',
        rows: () => [{ id: 1, date: today, weightKg: 70, note: '备'.repeat(10000) }],
        views: ['weight'],
        severity: '低',
        expectation: '一万字的备注不能让渲染崩掉或超时',
        repro: '塞一条 10000 字符备注的体重记录 → render(weight)',
        reach: '低概率',
      },
    ];

    for (const group of MALFORMED) {
      for (const view of group.views) {
        await runCase({
          id: 'malformed.' + group.key + '.' + view,
          title: '畸形记录（' + group.key + '）渲染 ' + view,
          area: '渲染/' + view + ' + 畸形数据',
          severity: group.severity,
          expected: group.expectation,
          repro: group.repro,
          reach: group.reach,
        }, async () => {
          await db.deleteAll(group.store);
          await injectRaw(group.store, group.rows());
          const root = await renderView(view);
          assert.ok(root.childNodes.length > 0, view + ' 渲染成空');
          const text = nodeText(root);
          assertNoLeak(text, view + '(' + group.key + ')');
          assertNoLooseLeak(text, view + '(' + group.key + ')');
        });
      }
    }

    // 畸形数据用完就清（避免后面还有用例被它拖累）
    for (const storeName of ['weights', 'meals', 'exercises', 'waters']) await db.deleteAll(storeName);

    {
      const dirty = accounts.listAccounts().find((a) => a.name === '脏库');
      if (dirty) {
        const legacy = accounts.listAccounts().find((a) => a.dbName === accounts.LEGACY_DB_NAME);
        await store.switchAccount(legacy.id);
        await accounts.removeAccount(dirty.id);
      }
    }

    await runCase({
      id: 'final.state-restored',
      title: '收尾自查：账号回到本机、老数据完好、全程零真实网络请求',
      area: '收尾',
      severity: null,
      expected: '目录只剩认领老库的账号；连接指向 hms；老库数据还在；fetchCalls 为 0',
      repro: '切回本机 → 读 listAccounts / getDbName / weights / fetchCalls',
      reach: '-',
    }, async () => {
      assert.equal(accounts.listAccounts().length, 1, '收尾后目录里还有 ' + accounts.listAccounts().length + ' 个账号');
      assert.equal(await db.getDbName(), accounts.LEGACY_DB_NAME, '收尾后连接没有回到老库');
      assert.ok((await db.getAll('weights')).length >= 2, '收尾后老库数据丢了');
      assert.equal(fetchCalls.length, 0, '全程不应有真实 fetch：' + JSON.stringify(fetchCalls));
      note('final.accounts', '收尾', '整轮跑完账号目录回到 1 个（本机），专用账号（大库/脏库）与它们的库都已删除，老库数据完好。');
    });

    /* ------------------------------------------------------------------
     * 排除项：这些"看着像 bug"的现象经核实是既有设计，依据写在这里，不进 findings
     * ------------------------------------------------------------------ */

    note('excluded.empty-block-hidden', '排除项/渲染', '空数据或当天不足 2 餐时「常吃套餐 / 整日套餐」等卡片整块不渲染 —— 既有设计。依据：tests/ui.smoke.mjs:1276-1280「无套餐 + 当天 <2 餐：整块不渲染」、:2048-2068「空数据时各页不白屏」都把它们钉成期望行为。');
    note('excluded.weight-60-day-window', '排除项/渲染', '体重页历史只渲染最近 60 天（store.recentWeights(60) 是日期窗口，不是条数上限），所以库里 2000 条体重时页面上只有 60 行 —— 既有设计，本套件改成断言"库里 2000 条 + 页面 60 行"。');
    note('excluded.number-fallbacks', '排除项/渲染', '极端数值一律兜底：kcal:1e308 上屏 "1e+308"（String(Math.round(1e308))），两条 1e308 相加溢出成 Infinity 后被 fmtKcal 兜成 "0"，weightKg:"abc" 在历史里显示 "0.0 kg" —— 都是 js/ui.js 里 fmtKcal/fmt1 与 nutrition.round1/num 的显式约定（Number.isFinite 兜底），且正常录入路径写不出这种值（grams 被 clampGrams 限在 1~2000、营养值过 nonNegative）。');
    note('excluded.water-negative-guard', '排除项/交互', '水量 0 时点「撤销 250ml」只给提示、不写负数 —— 既有设计（water.js 的 water <= 0 判断 + store.setWater 的 Math.max(0, ...)），本套件把它当"错误 toast 可见性"的对照组用。');
    note('excluded.save-button-disabled', '排除项/交互', '运动/体重/饮食的保存按钮都是"先 disabled 再写库"，连点只落一条 —— 既有设计（views/exercise.js 在 await 之前就置 disabled），本套件用 interaction.exercise-doubleclick-guard 实测钉住，作为 race.* 两条 finding 的对照组。');
    note('excluded.409-needs-second-click', '排除项/同步', 'push 撞 409 时本机数据与 rev 一个字节不动，必须再点一次「立即同步」才走 conflict-pull —— 既有设计，依据 tests/ui.smoke.mjs:3000 的断言与 sync.js 里那条中文文案。');
    note('excluded.degrade-paths', '排除项/账号', 'localStorage 不可用（Safari 隐私模式）时建账号报中文错但页面照常渲染、账号目录损坏时整形降级、账号库打不开时回落老库 —— 既有设计，依据 tests/ui.smoke.mjs:2292、:2550 已钉死。');
    note('excluded.stale-vs-wrong', '排除项/同步', '「同步成功后状态行陈旧」进了 findings（低），但要说清它不是同步逻辑错误：同一份状态在重渲染后完全正确（已全部同步 / rev 已更新），只是 syncNow() 没有触发重绘。既有 ui.smoke 的同步用例都是在 renderCloud() 重渲染之后才断言状态行，所以没覆盖到这一帧。');
    note('excluded.sheet-lives-on-body', '排除项/弹层', '弹层挂在 document.body 上、页面重绘不会把它冲掉 —— 既有设计（views/food.js 注释写明"弹层挂在 body 上，重画不会把它冲掉"），本套件只对"切路由后残留的监听器"算 bug。');
    note('excluded.constraint-fidelity', '排除项/保真度', '本套件的假 IndexedDB 会真的执行唯一索引约束（同名 by_date 重复写抛 ConstraintError，事务走 onerror/onabort），因此 waters/weights 同日并发写会真正走到 store.js 里那段"重读覆盖"的兜底。真机同样是这个语义（既有 ui.smoke 的假 IDB 会让失败的请求静默提交）—— 这是保真度差异，不是被测代码的差异。');
    note('excluded.not-covered', '未覆盖', '未覆盖区域：真机浏览器与真 IndexedDB（本机无浏览器，只能用假 DOM）、真实渲染性能与 CSS 布局、真机触摸手势、Service Worker、HmsBridge 更新条与 iOS 安装引导、js/vision.js 的真请求与照片压缩、app.js 的 hashchange 事件驱动路径（本套件直接用等价 navigate/renderRoute）、导出文件内容（只保证不抛异常）、debug 页自检按钮（假环境里没有 navigator.serviceWorker，那一行必然 FAIL，测不出真问题）、多标签页 onblocked/onversionchange、IDB 配额与大型 Blob。');

  } finally {
    restoreGlobals(snapshot);
    URL.createObjectURL = urlSnapshot.create;
    URL.revokeObjectURL = urlSnapshot.revoke;
  }

  const ms = Date.now() - startedAt;
  const order = { 高: 0, 中: 1, 低: 2 };
  ledger.findings.sort((a, b) => (order[a.severity] === undefined ? 9 : order[a.severity]) - (order[b.severity] === undefined ? 9 : order[b.severity]));
  return {
    passed: ledger.passed,
    failed: ledger.failures.length,
    failures: ledger.failures.slice(),
    findings: ledger.findings.slice(),
    notes: ledger.notes.slice(),
    ms,
    seed: SEED,
  };
}

/* ============================================================================
 * 7. 允许直接执行本文件：node tests/fuzz.ui.mjs
 * ========================================================================== */

function formatReport(result) {
  const lines = [];
  lines.push('fuzz.ui: ' + result.passed + ' passed / ' + result.failed + ' failed (' + result.ms + 'ms, seed=' + result.seed + ')');
  for (const failure of result.failures) lines.push('  FAIL  ' + failure.name + ' :: ' + failure.error);
  for (const finding of result.findings) {
    lines.push('  FINDING[' + finding.severity + '] ' + finding.id + ' · ' + finding['视图/流程']);
    lines.push('      复现: ' + finding.repro);
    lines.push('      实际: ' + finding.actual);
    lines.push('      期望: ' + finding.expected);
  }
  for (const item of result.notes) lines.push('  NOTE  ' + item.id + ' :: ' + item.note);
  return lines.join('\n');
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('fuzz.ui.mjs')) {
  const result = await run();
  console.log(formatReport(result));
}
