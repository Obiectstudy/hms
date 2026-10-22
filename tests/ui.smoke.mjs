/**
 * ui-shell 的自动化冒烟套件（补齐 SPEC §10.1 里「视图层」的空白）。
 *
 * 运行方式（本机 pwsh / node 子进程均不可用，只能用 run_code）：
 *   const m = await import('file:///C:/Users/Administrator/Desktop/hms/tests/ui.smoke.mjs');
 *   await m.run();   // -> { passed, failed, failures: [{ name, error }] }
 * 直接执行本文件（node tests/ui.smoke.mjs）也会自己跑一遍。
 *
 * 为什么这么测：浏览器自动化在本机不可用，DOM / IndexedDB 没法真跑。
 * 这里用「最小 DOM + 最小 IndexedDB」把 views/*.js 的 render() 真正执行一遍，
 * 目的不是替代真机，而是把「视图渲染抛异常 / 空状态白屏 / 文本里漏出 NaN·undefined /
 * 关键数值没出现 / 无 Key 时误发请求」这类结构性错误挡在提交前。
 *
 * 约定：所有全局替换（document/window/Node/indexedDB/fetch）都在 run() 内建立并在
 * finally 里还原，且会重置 db.js 的单例连接，避免污染同进程的其他套件。
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import * as store from '../js/store.js';
import * as nutrition from '../js/nutrition.js';
import * as db from '../js/db.js';

const VIEWS = ['dashboard', 'weight', 'food', 'exercise', 'water', 'settings', 'debug'];

// 期望的种子数据（改动种子函数时要同步这里）
const SEED = {
  weightKg: 68.4,
  intakeKcal: 624, // 232 + 320 + 72
  burned: 280,
  water: 1000,
  meals: 2,
  burnedLabel: '慢跑',
};

const failures = [];
let passed = 0;

function record(name, error) {
  failures.push({ name, error: error && error.message ? error.message : String(error) });
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    record(name, err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    record(name, err);
  }
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeText(node) {
  return node && typeof node.textOf === 'function' ? node.textOf() : '';
}

function findButton(root, label) {
  return root.walk().find((n) => (n.tagName === 'button' || n.tagName === 'label') && n.textOf() === label);
}

function fireClick(node, extra = {}) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, target: node, ...extra };
  for (const fn of node.listeners.click || []) fn(event);
  return event;
}

function fireInput(node) {
  for (const fn of node.listeners.input || []) fn({ target: node, preventDefault() {}, stopPropagation() {} });
}

/** select 的 change：和 input 分开，视图里两件事的语义不同（类型换档要重建强度下拉）。 */
function fireChange(node) {
  for (const fn of node.listeners.change || []) fn({ target: node, preventDefault() {}, stopPropagation() {} });
}

/** 指针事件：rulerPicker 用 pointerdown/move/up 覆盖触摸与鼠标，这里按同一形状投递。 */
function firePointer(node, type, extra = {}) {
  const event = {
    type,
    clientX: 0,
    clientY: 0,
    button: 0,
    pointerId: 1,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    target: node,
    ...extra,
  };
  for (const fn of node.listeners[type] || []) fn(event);
  return event;
}

function fireKey(node, key) {
  const event = {
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    target: node,
  };
  for (const fn of node.listeners.keydown || []) fn(event);
  return event;
}

/** 按 className 精确取节点（刻度尺里 .ruler__strip 也含 "ruler" 前缀，不能用 includes）。 */
function byClass(root, className) {
  return root.walk().filter((n) => String(n.className).split(/\s+/).includes(className));
}

/** SVG 的 class 走 setAttribute，不落在 className 上，只能读属性。 */
function byAttrClass(root, className) {
  return root.walk().filter((n) => String(n.getAttribute('class') || '').split(/\s+/).includes(className));
}

/**
 * 伪造 APK 内置桥：version() 报本地 4/1.3.0，checkUpdate 异步回调 __hmsUpdate，
 * installUpdate 只记录参数（真机由原生侧去下载安装）。
 */
function fakeBridge(remote, calls) {
  return {
    version: () => JSON.stringify({ versionCode: 4, versionName: '1.3.0' }),
    checkUpdate() {
      calls.push('checkUpdate');
      setTimeout(() => {
        const win = globalThis.window;
        if (typeof win.__hmsUpdate === 'function') win.__hmsUpdate(remote);
        else calls.push('no-handler');
      }, 0);
    },
    installUpdate(payload) { calls.push({ install: payload }); },
  };
}

/** PWA 里没有桥：连同我们挂的两个全局回调一起清掉。 */
function dropBridge() {
  const win = globalThis.window;
  delete win.HmsBridge;
  delete win.__hmsUpdate;
  delete win.__hmsUpdateProgress;
}

/** 文本里不能漏出 undefined / NaN——这是模板拼接最常见的线上事故。 */
function assertNoLeak(text, label) {
  assert.ok(text.length > 0, `${label} 渲染出空文本`);
  assert.ok(!/\bundefined\b/.test(text), `${label} 文本漏出 undefined：${text.slice(0, 160)}`);
  assert.ok(!/\bNaN\b/.test(text), `${label} 文本漏出 NaN：${text.slice(0, 160)}`);
}

/* ---------------- 最小 DOM ---------------- */

function createDom() {
  const makeStyle = () => {
    const bag = {};
    return new Proxy(bag, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => { t[k] = v; return true; } });
  };

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
      this._text = '';
    }

    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.childNodes = []; }

    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
    // 设置页导出走 <a download>.click()：没有它，备份提醒的「导出」在假 DOM 里会抛。
    click() {
      for (const fn of this.listeners.click || []) fn({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }
    replaceChildren(...kids) { this.childNodes = []; for (const kid of kids) this.appendChild(kid); }
    // 更新提示条落在「今日页最顶部」：异步回调要插到 firstChild 之前。
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index < 0) return this.appendChild(child);
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) { this.childNodes = this.childNodes.filter((x) => x !== child); return child; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn); }
    get firstChild() { return this.childNodes[0] || null; }

    // ui.toast 的收尾动画用 classList；没有它，2.4s 后的定时器会在套件结束后抛
    // uncaught 异常，把 `node tests/all.mjs` 的退出码变成 1。这里补齐最小实现。
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
  const documentListeners = {};
  const doc = {
    body,
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag),
    createTextNode: (text) => { const n = new FakeNode('#text'); n.textContent = String(text); return n; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { documentListeners[type] = (documentListeners[type] || []).filter((x) => x !== fn); },
  };
  return { FakeNode, body, doc };
}

/* ---------------- 最小 IndexedDB ---------------- */

function createIndexedDb() {
  const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
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
      try { this.result = this._run(); } catch (err) { this.error = err; if (this._err) this._err(); if (this.tx) this.tx.settle(); return; }
      if (this._ok) this._ok();
      if (this.tx) this.tx.settle();
    }
  }

  class FakeStore {
    constructor(name, options = {}) {
      this.name = name; this.keyPath = options.keyPath; this.autoIncrement = !!options.autoIncrement;
      this.data = new Map(); this.indexes = new Map(); this.seq = 0;
    }
    createIndex(name, keyPath) { this.indexes.set(name, { keyPath }); }
    // 真实 IDB 在 autoIncrement + keyPath 时会把生成的 key 回写到对象上，这里必须一致，
    // 否则同日两条记录会落到同一个 undefined 键上互相覆盖。
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
    put(obj) { const key = this.nextKey(obj); this.data.set(key, clone(obj)); return key; }
    delete(key) { this.data.delete(key); }
    clear() { this.data.clear(); }
    index(name) {
      const def = this.indexes.get(name);
      if (!def) throw new Error(`没有索引 ${name}`);
      const self = this;
      return {
        get(value) { for (const row of self.data.values()) if (row[def.keyPath] === value) return clone(row); return undefined; },
        getAll(value) { return [...self.data.values()].filter((row) => row[def.keyPath] === value).map(clone); },
      };
    }
  }

  class FakeTransaction {
    constructor(stores, mode) { this.stores = stores; this.mode = mode; this.pending = 0; this.settled = false; this.oncomplete = null; this.onerror = null; this.onabort = null; }
    objectStore(name) {
      const store = this.stores[name];
      if (!store) throw new Error(`没有 store ${name}`);
      const tx = this;
      return {
        getAll: () => new FakeRequest(tx, () => store.getAll()),
        // 真实 IDBObjectStore.count()：导出备份要用它给照片计数（dumpAll 里的 photoCount）。
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
      this.objectStoreNames = { contains: (name2) => this.stores.has(name2) };
      this.onversionchange = null;
    }
    createObjectStore(name, options = {}) { const created = new FakeStore(name, options); this.stores.set(name, created); return created; }
    transaction(names, mode) {
      const list = Array.isArray(names) ? names : [names];
      const scoped = {};
      for (const name of list) {
        if (!this.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
        scoped[name] = this.stores.get(name);
      }
      return new FakeTransaction(scoped, mode);
    }
    close() {}
  }

  const indexedDB = {
    open(name, version) {
      const database = new FakeDb(name, version);
      opened.push(database);
      const request = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        try {
          if (request.onupgradeneeded) request.onupgradeneeded();
        } catch (err) {
          request.error = err;
          if (request.onerror) request.onerror();
          return;
        }
        setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
      }, 0);
      return request;
    },
  };

  return { indexedDB, opened };
}

/* ---------------- 全局替换与还原 ---------------- */

function setGlobal(key, value) {
  if (value === undefined) { delete globalThis[key]; return; }
  globalThis[key] = value;
}

function snapshotGlobals() {
  return {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
  };
}

function restoreGlobals(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) setGlobal(key, value);
}

/* ---------------- 种子数据 ---------------- */

async function seed() {
  const today = nutrition.localDateStr();
  await store.saveProfile({ nickname: '小林', sex: 'male', birthday: '1990-03-05', heightCm: 172, activity: 'light', weightTargetKg: 65 });
  await store.saveSettings({ apiKey: '', model: 'qwen-vl-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  await store.logWeight({ date: today, weightKg: SEED.weightKg, bodyFatPct: 18.5, note: '空腹' });
  await store.logWeight({ date: nutrition.daysAgo(7), weightKg: 69.2 });
  await store.logMeal({
    date: today,
    slot: 'lunch',
    source: 'manual',
    items: [
      { name: '米饭', grams: 200, kcal: 232, carb: 51.8, protein: 5.2, fat: 0.6 },
      { name: '宫保鸡丁', grams: 150, kcal: 320, carb: 12, protein: 22, fat: 20 },
    ],
  });
  await store.logMeal({
    date: today,
    slot: 'breakfast',
    source: 'ai',
    items: [{ name: '鸡蛋', grams: 50, kcal: 72, carb: 0.6, protein: 6.3, fat: 5, confidence: 'high' }],
  });
  await store.logExercise({ date: today, type: 'jog', minutes: 30, kcalBurned: SEED.burned, note: SEED.burnedLabel });
  await store.addWater(today, SEED.water);
  return today;
}

/* ---------------- 入口 ---------------- */

export async function run() {
  // 同一进程里重复调用时按次计分，避免计数累加把闸门的数字搅浑。
  passed = 0;
  failures.length = 0;
  const snapshot = snapshotGlobals();
  const dom = createDom();
  const fakeIdb = createIndexedDb();
  let fetchCalls = 0;
  let urlSnapshot = null;
  const roots = new Map();

  const loadView = async (name) => {
    const mod = await import(`../views/${name}.js`);
    assert.equal(typeof mod.render, 'function', `views/${name}.js 缺少 render 导出`);
    return mod;
  };

  const renderView = async (name) => {
    const mod = await loadView(name);
    const root = new dom.FakeNode('div');
    await mod.render(root);
    roots.set(name, root);
    return root;
  };

  try {
    setGlobal('document', dom.doc);
    setGlobal('window', {
      location: { hash: '' },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      scrollTo() {},
      setTimeout,
      clearTimeout,
      document: dom.doc,
      HMS: { navigate() {}, refresh: async () => {} },
    });
    setGlobal('Node', dom.FakeNode);
    setGlobal('indexedDB', fakeIdb.indexedDB);
    // 视图若要发请求会走 globalThis.fetch；这里让它计数并直接失败，便于断言「没有发请求」。
    setGlobal('fetch', async () => {
      fetchCalls += 1;
      throw new Error('测试环境不应发出网络请求');
    });
    // 导出下载用 Blob + createObjectURL；假 DOM 只关心调用链不抛异常。
    urlSnapshot = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => 'blob:hms-smoke';
    URL.revokeObjectURL = () => {};

    const today = await seed();

    // ---- 1. 七个视图在有数据时都要能渲染 ----
    await checkAsync('dashboard 渲染', async () => {
      const root = await renderView('dashboard');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'dashboard');
      for (const needle of ['今日总览', '热量', '碳水', '蛋白质', '饮水']) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
      assert.ok(text.includes(SEED.weightKg.toFixed(1)), `缺少最新体重 ${SEED.weightKg}`);
      assert.ok(text.includes(String(SEED.intakeKcal)), `缺少当日摄入 ${SEED.intakeKcal} kcal`);
      // 「今日餐次」默认折叠成一行：展开后再核对逐餐内容
      const fold = root.walk().find((n) => String(n.className).split(/\s+/).includes('meal-fold'));
      assert.ok(fold, '今日餐次没有折叠行');
      fireClick(fold);
      assert.ok(nodeText(root).includes('米饭'), '缺少今日餐次里的食物名');
    });

    await checkAsync('weight 渲染', async () => {
      const root = await renderView('weight');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'weight');
      for (const needle of ['体重', '30 天趋势', '历史记录', 'BMI']) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
      assert.ok(text.includes(SEED.weightKg.toFixed(1)), `缺少体重值 ${SEED.weightKg}`);
      // 两条记录 + 7 天前那条应体现在折线/历史里
      assert.ok(text.includes('kg'), '缺少单位 kg');
    });

    await checkAsync('food 渲染', async () => {
      const root = await renderView('food');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'food');
      for (const needle of ['拍照识别', '手动添加', '米饭', '当日合计', '午餐']) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
      assert.ok(text.includes(String(SEED.intakeKcal)), `当日合计缺少数值 ${SEED.intakeKcal}`);
    });

    await checkAsync('exercise 渲染', async () => {
      const root = await renderView('exercise');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'exercise');
      for (const needle of ['记录运动', '今日合计', SEED.burnedLabel, String(SEED.burned)]) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
    });

    await checkAsync('water 渲染', async () => {
      const root = await renderView('water');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'water');
      for (const needle of ['今日饮水', '自定义', '撤销', String(SEED.water)]) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
    });

    await checkAsync('settings 渲染', async () => {
      const root = await renderView('settings');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'settings');
      for (const needle of ['个人档案', '每日目标', '视觉识别', '导出 JSON', '清空所有健康数据']) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
      // API Key 必须是密码框（明文展示会在真机上被旁人看到）
      const keyInput = root.walk().find((n) => n.tagName === 'input' && (n.type === 'password' || n.attributes.type === 'password'));
      assert.ok(keyInput, 'API Key 输入框不是 type=password');
    });

    await checkAsync('debug 渲染', async () => {
      const root = await renderView('debug');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '根节点没有子元素');
      assertNoLeak(text, 'debug');
      for (const needle of ['自检', '运行自检（安全项）', '导出 → 清空 → 导入']) {
        assert.ok(text.includes(needle), `缺少「${needle}」`);
      }
    });

    // ---- 1.5 体重刻度尺：纯函数 / 拖动改值 / 单位切换 ----
    await checkAsync('刻度尺纯函数：snapToStep / valueFromDrag / rulerTicks', async () => {
      const ui = await import('../js/ui.js');

      // 吸附：非整倍数就近取整、边界 clamp、非法输入不抛异常、浮点尾巴不漏到显示
      assert.equal(ui.snapToStep(68.44, 0.1, 20, 300), 68.4);
      assert.equal(ui.snapToStep(181.28, 0.1, 20, 300), 181.3);
      assert.equal(ui.snapToStep(0, 0.1, 20, 300), 20, '低于下限应 clamp 到 min');
      assert.equal(ui.snapToStep(9999, 0.1, 20, 300), 300, '高于上限应 clamp 到 max');
      assert.equal(ui.snapToStep(-5, 0.2, 40, 600), 40);
      assert.equal(ui.snapToStep(Number.NaN, 0.2, 40, 600), 40, 'NaN 应回落到下限');
      assert.equal(String(ui.snapToStep(181.2, 0.2, 40, 600)), '181.2', '0.2 网格上不应出现浮点尾巴');

      // 拖动换算：向右拖（deltaPx > 0）数值变小，向左拖变大，拖过头 clamp 到边界
      const pull = (deltaPx, startValue = 181.2) => ui.valueFromDrag({ startValue, deltaPx, pxPerStep: 8, step: 0.2, min: 40, max: 600 });
      assert.equal(pull(0), 181.2);
      assert.equal(pull(80), 179.2, '右拖 10 格应减 2 斤');
      assert.equal(pull(-80), 183.2, '左拖 10 格应加 2 斤');
      assert.equal(pull(8000), 40, '右拖过头应 clamp 到 min');
      assert.equal(pull(-24000), 600, '左拖过头应 clamp 到 max');

      // 刻度分层：label 一定也是 major，首尾都在，网格值不带浮点尾巴
      const ticks = ui.rulerTicks({ min: 0, max: 10, step: 0.5, majorEvery: 2, labelEvery: 4 });
      assert.equal(ticks.length, 21);
      assert.deepEqual(ticks[0], { value: 0, kind: 'label' });
      assert.equal(ticks[1].kind, 'minor');
      assert.equal(ticks[2].kind, 'major');
      assert.equal(ticks[4].kind, 'label');
      assert.deepEqual(ticks[ticks.length - 1], { value: 10, kind: 'label' });
      const jinTicks = ui.rulerTicks({ min: 40, max: 42, step: 0.2, majorEvery: 10, labelEvery: 25 });
      assert.equal(jinTicks.length, 11);
      assert.equal(jinTicks[0].value, 40);
      assert.equal(jinTicks[0].kind, 'label');
      assert.equal(jinTicks[10].value, 42);
      assert.equal(jinTicks[10].kind, 'major');
    });

    await checkAsync('weight 刻度尺拖动改值，保存后库里是 kg', async () => {
      const root = await renderView('weight');
      const ruler = root.walk().find((n) => String(n.className).split(/\s+/).includes('ruler') && n.getAttribute('role') === 'slider');
      assert.ok(ruler, '体重录入没有渲染刻度尺（role=slider）');
      assert.ok(byClass(ruler, 'ruler__pointer').length === 1, '刻度尺缺少中心固定指针');
      assert.ok(byClass(ruler, 'ruler__label').length > 3, '刻度尺缺少数字标签');
      assert.ok(byClass(ruler, 'ruler__tick--major').length > 10, '刻度尺缺少 major 刻度线');

      const valueNode = () => root.walk().find((n) => String(n.className).split(/\s+/).includes('weight-value'));
      assert.ok(valueNode(), '没有大号体重数字');
      const before = Number(valueNode().textOf());
      assert.equal(before, SEED.weightKg, '大号数字没按最近一次体重初始化');

      // 刻度条位移必须与数值同步（kg：20 起、0.1/格、8px/格 → 68.4 = 3872px）
      const strip = byClass(ruler, 'ruler__strip')[0];
      assert.ok(strip, '刻度尺缺少刻度条容器');
      assert.equal(strip.style.transform, 'translate3d(-3872px, 0, 0)', '刻度条初始位移不对');
      const labelTexts = byClass(ruler, 'ruler__label').map((n) => n.textOf());
      assert.ok(labelTexts.includes('25') && labelTexts.includes('30'), `刻度数字标签不对：${labelTexts.slice(0, 6)}`);

      // 默认 kg：step 0.1、8px/格。左拖 80px = +1.0kg，再左拖到 -200（累计 400px）= +5.0kg
      firePointer(ruler, 'pointerdown', { clientX: 200 });
      firePointer(ruler, 'pointermove', { clientX: 120 });
      const mid = Number(valueNode().textOf());
      assert.ok(mid > before, `拖动中数字没有实时变大：${before} → ${mid}`);
      assert.equal(mid, 69.4, `拖动中数字应吸附到网格：${mid}`);
      firePointer(ruler, 'pointermove', { clientX: -200 });
      firePointer(ruler, 'pointerup', { clientX: -200 });
      assert.equal(Number(valueNode().textOf()), 73.4, '左拖 400px 应加 5.0kg');
      assert.equal(strip.style.transform, 'translate3d(-4272px, 0, 0)', '松手后刻度条位置没跟上数值');
      assert.equal(ruler.getAttribute('aria-valuenow'), '73.4', 'aria-valuenow 没跟上拖动');

      // 键盘可达：← 减一格
      fireKey(ruler, 'ArrowLeft');
      assert.equal(Number(valueNode().textOf()), 73.3, '← 应减一个 step');

      fireClick(findButton(root, '保存体重'));
      await tick(140);
      const summary = await store.daySummary(today);
      assert.ok(summary.weight, '保存后当日没有体重记录');
      assert.equal(summary.weight.weightKg, 73.3, '落库值应等于大号数字（kg）');
      assertNoLeak(nodeText(root), 'weight(拖动后)');
    });

    await checkAsync('体重单位切换往返不漂移，键盘输入按当前单位换算入库', async () => {
      const root = await renderView('weight');
      const valueNode = () => root.walk().find((n) => String(n.className).split(/\s+/).includes('weight-value'));
      const chip = byClass(root, 'unit-chip')[0];
      assert.ok(chip, '没有单位 chip');
      assert.equal(chip.textOf(), 'kg', '默认单位应是 kg');

      const kgBefore = Number(valueNode().textOf());
      assert.equal(kgBefore, 73.3, '应沿用上一条用例存的体重');

      fireClick(chip);
      await tick(160);
      assert.equal(chip.textOf(), '斤', '点一下应切到斤');
      assert.equal(Number(valueNode().textOf()), 146.6, '切到斤应按换算显示（73.3kg → 146.6斤）');
      assert.equal((await store.getSettings()).weightUnit, 'jin', '单位选择没有写进设置');

      fireClick(chip);
      await tick(160);
      assert.equal(chip.textOf(), 'kg', '再点一下应切回 kg');
      const kgAfter = Number(valueNode().textOf());
      assert.ok(Math.abs(kgAfter - kgBefore) <= 0.05, `kg→斤→kg 出现漂移：${kgBefore} → ${kgAfter}`);
      assert.equal((await store.getSettings()).weightUnit, 'kg', '切回后设置没同步');

      // 切到键盘输入，按「斤」录入 181.2 → 库里必须是 90.6 kg
      fireClick(chip);
      await tick(160);
      const toggle = byClass(root, 'keypad-toggle')[0];
      assert.ok(toggle, '没有切键盘输入的按钮');
      fireClick(toggle);
      await tick(60);
      const numberInput = root.walk().find((n) => n.tagName === 'input'
        && String(n.className).split(/\s+/).includes('weight-input'));
      assert.ok(numberInput, '切到键盘模式后没有数字输入框');
      assert.equal(Number(numberInput.value), 146.6, '键盘框没有按当前单位预填');

      numberInput.value = '181.2';
      fireInput(numberInput);
      assert.equal(Number(valueNode().textOf()), 181.2, '键盘输入没有同步到大号数字');

      fireClick(findButton(root, '保存体重'));
      await tick(140);
      const summary = await store.daySummary(today);
      assert.equal(summary.weight.weightKg, 90.6, '181.2 斤应存成 90.6 kg');

      // 今日页体重卡也要按设置单位显示（差值同样换算：21.4kg → 42.8斤）
      const dash = await renderView('dashboard');
      const dashText = nodeText(dash);
      assert.ok(dashText.includes('181.2'), `dashboard 没有按斤显示最近体重：${dashText.slice(0, 160)}`);
      assert.ok(dashText.includes('42.8'), `dashboard 的 7 天差值没有换算：${dashText.slice(0, 160)}`);
      assert.ok(dashText.includes('斤'), 'dashboard 缺少单位文案');

      await store.saveSettings({ weightUnit: 'jin' }); // 直接改设置，验证「下次打开」的初始单位
      const reopened = await renderView('weight');
      const reopenedChip = byClass(reopened, 'unit-chip')[0];
      assert.equal(reopenedChip.textOf(), '斤', '重新打开时应沿用设置里的单位');
      const reopenedValue = reopened.walk().find((n) => String(n.className).split(/\s+/).includes('weight-value'));
      assert.equal(Number(reopenedValue.textOf()), 181.2, '重新打开时应按设置单位显示最近体重');

      await store.saveSettings({ weightUnit: 'kg' }); // 复原，别把单位状态漏给后续用例
    });

    // ---- 1.7 7 日均线：折线叠加一条虚线，且原有刻度尺/历史/目标不回退 ----
    await checkAsync('weight 7 日均线：多一条虚线 path，刻度尺与历史仍在', async () => {
      const weightView = await import('../views/weight.js');
      // 有效点不足时均线是假信号：全 null 不能画线，也不能出图例
      assert.equal(weightView.buildAvgPath([{ value: 68, avg: null }, { value: 68.4, avg: null }]), '', '均线全空时不应产出路径');
      assert.ok(weightView.buildAvgPath([{ value: 68, avg: null }, { value: 68.4, avg: 68.2 }, { value: 68.1, avg: 68.1 }]).includes('L'), '均线路径应有折线段');

      // 补几个更早的点，让 7 日窗口真正滚起来（只有 2 个点时窗口内 < 2 个有效点）
      for (let d = 10; d >= 3; d -= 1) await store.logWeight({ date: nutrition.daysAgo(d), weightKg: 70 + (d % 3) * 0.1 });

      const root = await renderView('weight');
      const text = nodeText(root);
      assertNoLeak(text, 'weight(均线)');
      for (const needle of ['7 日均线', '每日', '历史记录', '目标体重进度']) {
        assert.ok(text.includes(needle), `均线版体重页缺少「${needle}」`);
      }

      const avgPaths = byAttrClass(root, 'chart__line--avg');
      assert.equal(avgPaths.length, 1, `均线虚线 path 数量不对：${avgPaths.length}`);
      const d = avgPaths[0].getAttribute('d') || '';
      assert.ok(d.startsWith('M'), `均线 path 没有起点：${d.slice(0, 40)}`);
      assert.ok(d.includes('L'), '均线 path 只有单点，画不出趋势');
      assert.ok(avgPaths[0].getAttribute('stroke-dasharray'), '均线 path 没有 stroke-dasharray，不是虚线');
      assert.ok(byAttrClass(root, 'chart__line').length >= 1, '每日折线不见了');
      assert.equal(byClass(root, 'ruler').length, 1, '滑动刻度尺被回退了');
      assert.ok(byClass(root, 'unit-chip').length === 1, 'kg/斤 切换被回退了');
    });

    // ---- 1.8 备份提醒：days >= 7 出现，点导出后消失 ----
    await checkAsync('dashboard 备份提醒：days >= 7 出现，导出后消失', async () => {
      const dashboardView = await import('../views/dashboard.js');
      assert.equal(dashboardView.needsBackupReminder({ hasData: true, days: null }), true, '从未备份应提醒');
      assert.equal(dashboardView.needsBackupReminder({ hasData: true, days: 7 }), true, '满 7 天应提醒');
      assert.equal(dashboardView.needsBackupReminder({ hasData: true, days: 6 }), false, '不足 7 天不应提醒');
      assert.equal(dashboardView.needsBackupReminder({ hasData: false, days: 30 }), false, '没有数据时不该提醒');

      // 直接改 meta 里的备份时间，构造「已 8 天没备份」。
      // 取 8 天前的中午而不是 now-8*24h：有夏令时的时区也不会被整点差推到 7/9 天。
      const exportedAt = nutrition.parseDateStr(nutrition.daysAgo(8));
      exportedAt.setHours(12, 0, 0, 0);
      await db.setMeta('lastExportedAt', exportedAt.getTime());
      const root = await renderView('dashboard');
      const bar = root.walk().find((n) => String(n.className).split(/\s+/).includes('backup-bar'));
      assert.ok(bar, 'days >= 7 时今日页顶部没有备份提醒条');
      assert.ok(bar.textOf().includes('已 8 天没备份'), `提醒文案不对：${bar.textOf()}`);
      assertNoLeak(nodeText(root), 'dashboard(备份提醒)');

      // 关闭只作用于这一次：重画后仍会提醒，不会被记成「永不提醒」
      fireClick(findButton(bar, '×'));
      assert.ok(!root.walk().some((n) => String(n.className).split(/\s+/).includes('backup-bar')), '点关闭后提醒条没有消失');
      const again = await renderView('dashboard');
      const barAgain = again.walk().find((n) => String(n.className).split(/\s+/).includes('backup-bar'));
      assert.ok(barAgain, '关闭被持久化了：重画后不应还提醒');

      fireClick(findButton(barAgain, '导出'));
      await tick(320);
      assert.ok(!again.walk().some((n) => String(n.className).split(/\s+/).includes('backup-bar')), '导出成功后提醒条没有消失');
      const status = await store.exportStatus();
      assert.equal(status.days, 0, '导出后没有记下备份时间');

      // 设置页「数据」区也要能看到上次备份时间（状态是异步读的，等一拍再断言）
      const settingsRoot = await renderView('settings');
      await tick(120);
      const settingsText = nodeText(settingsRoot);
      assert.ok(settingsText.includes('上次备份：今天'), `设置页没有显示上次备份：${settingsText.slice(0, 260)}`);
    });

    // ---- 1.9 应用内更新提示条：纯函数 / 只在有桥时渲染 / 安装与进度 ----
    await checkAsync('更新纯函数：parseBridgeJson 容错、isNewer 严格大于、shouldPrompt 忽略已稍后', async () => {
      const update = await import('../js/update.js');

      assert.deepEqual(update.parseBridgeJson('{"versionCode":5,"versionName":"1.4.0"}'), { versionCode: 5, versionName: '1.4.0' });
      assert.deepEqual(update.parseBridgeJson({ versionCode: 5 }), { versionCode: 5 }, '对象输入应原样接受');
      for (const bad of [null, undefined, '', '   ', 'not json', '{"versionCode":', '[1,2]', 'null', '"更新"', 42, true]) {
        assert.equal(update.parseBridgeJson(bad), null, `非法输入应返回 null：${String(bad)}`);
      }

      assert.equal(update.isNewer(4, 5), true, '远端 code 更大才是新版');
      assert.equal(update.isNewer(5, 5), false, '等值不算新版本');
      assert.equal(update.isNewer(5, 4), false, '远端更旧不提示');
      assert.equal(update.isNewer(4, 'abc'), false, '非法数字不算新版');
      assert.equal(update.isNewer(undefined, 5), false, '本地版本未知时不瞎提示');

      assert.equal(update.shouldPrompt({ ok: true, versionCode: 5 }, 0), true);
      assert.equal(update.shouldPrompt({ ok: true, versionCode: 5 }, '5'), false, '点过「稍后」的同一版本不再提示');
      assert.equal(update.shouldPrompt({ ok: true, versionCode: 6 }, 5), true, '换新版应再次提示');
      assert.equal(update.shouldPrompt({ ok: false, error: '网络错误' }, 0), false, '失败结果不提示');
      assert.equal(update.shouldPrompt({ versionName: '1.4.0' }, 0), false, '缺 versionCode 不提示');
      assert.equal(update.shouldPrompt(null, 0), false);

      assert.equal(update.DISMISS_KEY, 'hms.update.dismissed', '「稍后」的存储键改名了');
      assert.equal(typeof update.createUpdateBanner, 'function');
      assert.equal(typeof update.initUpdateBanner, 'function');
    });

    await checkAsync('dashboard 更新条：无桥不渲染；有桥时渲染并跟随下载进度', async () => {
      const calls = [];
      const win = globalThis.window;
      dropBridge();

      // PWA：不渲染、不请求、也不留下全局回调
      const plain = await renderView('dashboard');
      await tick(60);
      assert.equal(byClass(plain, 'update-bar').length, 0, 'PWA（无桥）里不应出现更新条');
      assert.equal(win.__hmsUpdate, undefined, '无桥时不应挂 __hmsUpdate');
      assert.equal(win.__hmsUpdateProgress, undefined, '无桥时不应挂 __hmsUpdateProgress');

      win.HmsBridge = fakeBridge({
        ok: true,
        versionCode: 5,
        versionName: '1.4.0',
        notes: '修复备份导出时文件名重复的问题',
        // 原生 HmsBridge 回调里是 url；apkUrl 是任务书里的另一种叫法，两种都要原样透传。
        url: 'https://example.com/dist/HMS-latest.apk',
        apkUrl: 'https://example.com/dist/HMS-latest.apk',
        sha256: 'abc123',
        size: 1710227,
      }, calls);

      try {
        const root = await renderView('dashboard');
        await tick(80);
        const bar = byClass(root, 'update-bar')[0];
        assert.ok(bar, '有桥且版本更新时，今日页顶部没有更新条');
        assert.equal(byClass(root, 'update-bar').length, 1, '更新条重复渲染');
        assert.ok(bar.textOf().includes('发现新版本 1.4.0'), `更新条文案不对：${bar.textOf()}`);
        assert.ok(bar.textOf().includes('修复备份导出时文件名重复的问题'), `更新条缺少 notes 副文案：${bar.textOf()}`);
        assert.equal(calls.filter((c) => c === 'checkUpdate').length, 1, '一次渲染应只 checkUpdate 一次');
        assertNoLeak(nodeText(root), 'dashboard(更新条)');

        // 原生侧重复回调不该插出第二条
        win.__hmsUpdate({ ok: true, versionCode: 6, versionName: '1.9.9', apkUrl: 'https://example.com/x.apk', sha256: 'xxx' });
        assert.equal(byClass(root, 'update-bar').length, 1, '重复回调插出了第二条更新条');

        const install = findButton(bar, '立即更新');
        assert.ok(install, '更新条没有「立即更新」按钮');
        fireClick(install);
        assert.equal(install.disabled, true, '点「立即更新」后按钮应禁用');
        assert.equal(install.textOf(), '准备中…', `准备中状态文案不对：${install.textOf()}`);

        const installCall = calls.find((c) => c && typeof c === 'object' && c.install);
        assert.ok(installCall, '点「立即更新」没有调用 HmsBridge.installUpdate');
        const sent = JSON.parse(installCall.install);
        assert.equal(sent.apkUrl, 'https://example.com/dist/HMS-latest.apk', 'installUpdate 参数丢了 apkUrl');
        assert.equal(sent.url, 'https://example.com/dist/HMS-latest.apk', 'installUpdate 参数丢了 url（原生实际字段名）');
        assert.equal(sent.sha256, 'abc123', 'installUpdate 参数丢了 sha256');

        win.__hmsUpdateProgress({ state: 'downloading', percent: 42 });
        assert.ok(install.textOf().includes('42%'), `下载进度没有落到按钮上：${install.textOf()}`);
        win.__hmsUpdateProgress('{"state":"verifying"}');
        assert.equal(install.textOf(), '校验中…', '校验状态文案不对');
        win.__hmsUpdateProgress({ state: 'opening' });
        assert.equal(install.textOf(), '正在打开安装…', '安装状态文案不对');
        win.__hmsUpdateProgress({ state: 'error', message: '签名校验失败' });
        assert.equal(install.disabled, false, '出错后按钮应恢复可点');
        assert.equal(install.textOf(), '立即更新', '出错后按钮文案应恢复');
        assert.ok(
          dom.body.childNodes.some((n) => String(n.className).split(/\s+/).includes('toast') && n.textOf().includes('签名校验失败')),
          '出错后没有 toast 错误原因',
        );
      } finally {
        dropBridge();
      }
    });

    await checkAsync('dashboard 更新条：「稍后」记住 versionCode，同版本不再打扰，换新版再提示', async () => {
      const calls = [];
      const win = globalThis.window;
      const previousStorage = globalThis.localStorage;
      const bag = new Map();
      globalThis.localStorage = {
        getItem: (key) => (bag.has(key) ? bag.get(key) : null),
        setItem: (key, value) => { bag.set(key, String(value)); },
        removeItem: (key) => { bag.delete(key); },
      };
      win.HmsBridge = fakeBridge({ ok: true, versionCode: 5, versionName: '1.4.0', apkUrl: 'https://example.com/a.apk', sha256: 'aaa' }, calls);

      try {
        const root = await renderView('dashboard');
        await tick(80);
        const bar = byClass(root, 'update-bar')[0];
        assert.ok(bar, '更新条没有出现（「稍后」用例的前置）');

        fireClick(findButton(bar, '稍后'));
        await tick(20);
        assert.equal(bag.get('hms.update.dismissed'), '5', '点「稍后」没有把 versionCode 写进 localStorage');
        assert.equal(byClass(root, 'update-bar').length, 0, '点「稍后」后更新条没有消失');

        const again = await renderView('dashboard');
        await tick(80);
        assert.equal(byClass(again, 'update-bar').length, 0, '同一版本被「稍后」后不应再提示');

        // 换新版：versionCode 6 应重新提示，且不显示旧版本号
        win.HmsBridge = fakeBridge({ ok: true, versionCode: 6, versionName: '1.5.0', apkUrl: 'https://example.com/b.apk', sha256: 'bbb' }, calls);
        const newer = await renderView('dashboard');
        await tick(80);
        const newerBar = byClass(newer, 'update-bar')[0];
        assert.ok(newerBar, '换新版后没有再次提示');
        assert.ok(newerBar.textOf().includes('1.5.0'), `新版本文案不对：${newerBar.textOf()}`);
        assert.ok(!newerBar.textOf().includes('1.4.0'), `换新版后仍显示旧版本号：${newerBar.textOf()}`);

        // 本机已是最新（versionCode 相等）：不提示
        win.HmsBridge = fakeBridge({ ok: true, versionCode: 4, versionName: '1.3.0', apkUrl: 'https://example.com/c.apk', sha256: 'ccc' }, calls);
        const same = await renderView('dashboard');
        await tick(80);
        assert.equal(byClass(same, 'update-bar').length, 0, 'versionCode 相等时不应提示');

        // 桥报失败 / 非法 JSON：同样不渲染
        win.HmsBridge = fakeBridge({ ok: false, error: '检查更新失败' }, calls);
        const failed = await renderView('dashboard');
        await tick(80);
        assert.equal(byClass(failed, 'update-bar').length, 0, '桥返回 ok:false 时不应渲染更新条');
        win.HmsBridge = fakeBridge('not json', calls);
        const broken = await renderView('dashboard');
        await tick(80);
        assert.equal(byClass(broken, 'update-bar').length, 0, '桥返回非法 JSON 时不应渲染更新条');
      } finally {
        dropBridge();
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
      }
    });

    await checkAsync('更新条与备份提醒条同时存在，互不覆盖', async () => {
      const calls = [];
      const win = globalThis.window;
      win.HmsBridge = fakeBridge({ ok: true, versionCode: 7, versionName: '1.6.0', apkUrl: 'https://example.com/d.apk', sha256: 'ddd' }, calls);
      try {
        const exportedAt = nutrition.parseDateStr(nutrition.daysAgo(9));
        exportedAt.setHours(12, 0, 0, 0);
        await db.setMeta('lastExportedAt', exportedAt.getTime());

        const root = await renderView('dashboard');
        await tick(80);
        assert.equal(byClass(root, 'update-bar').length, 1, '更新条不见了');
        assert.equal(byClass(root, 'backup-bar').length, 1, '备份提醒条不见了');
        assert.ok(
          root.firstChild && String(root.firstChild.className).split(/\s+/).includes('update-bar'),
          `更新条没有贴在今日页最顶部：${String(root.firstChild && root.firstChild.className)}`,
        );
        assert.ok(byClass(root, 'backup-bar')[0].textOf().includes('已 9 天没备份'), '备份提醒文案被更新条影响');

        // 关掉更新条不影响备份提醒
        fireClick(findButton(byClass(root, 'update-bar')[0], '稍后'));
        await tick(20);
        assert.equal(byClass(root, 'backup-bar').length, 1, '关掉更新条后备份提醒也被带走了');
      } finally {
        dropBridge();
        await store.markExported();
      }
    });

    // ---- 2. 手动添加整链：搜索 → 定克数 → 加入清单 → 落库 ----
    await checkAsync('food 手动添加链路', async () => {
      let root = roots.get('food');
      if (!root) root = await renderView('food');
      const before = await store.daySummary(today);

      const addButton = findButton(root, '手动添加');
      assert.ok(addButton, '找不到「手动添加」按钮');
      fireClick(addButton);
      await tick(120);

      const sheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(sheet, '没有弹出手动添加层');
      const search = sheet.walk().find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      assert.ok(search, '没有搜索输入框');
      fireInput(search); // 空查询应给热门条目
      await tick(280);
      assert.ok(sheet.walk().some((n) => n.className === 'list__item pick-item'), '空查询没有给出热门食物');

      search.value = '米饭';
      fireInput(search);
      await tick(280);
      const hits = sheet.walk().filter((n) => n.className === 'list__item pick-item');
      assert.ok(hits.length > 0, '搜索「米饭」没有命中');
      fireClick(hits[0]);
      await tick(60);

      const grams = sheet.walk().find((n) => n.tagName === 'input' && (n.type === 'number' || n.attributes.type === 'number'));
      assert.ok(grams, '选中食物后没有克数输入框');
      grams.value = '150';
      fireInput(grams);
      const addToList = findButton(sheet, '加入清单');
      assert.ok(addToList, '没有「加入清单」按钮');
      fireClick(addToList);
      await tick(160);

      const draft = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('确认食物'));
      assert.ok(draft, '没有进入可编辑清单');
      const saveButton = findButton(draft, '保存到当日');
      assert.ok(saveButton, '清单里没有保存按钮');
      fireClick(saveButton);
      await tick(320);

      const after = await store.daySummary(today);
      assert.equal(after.meals.length, before.meals.length + 1, '保存后餐次数没有增加');
      const saved = after.meals.find((meal) => (meal.items || []).some((item) => item.grams === 150));
      assert.ok(saved, '没有找到刚保存的 150g 条目');
      assert.equal(saved.source, 'manual', '手动添加的来源应记为 manual');
      assert.ok(after.intake.kcal > before.intake.kcal, '保存后当日摄入没有增加');
      assert.ok(!dom.body.childNodes.some((n) => n.className === 'sheet-backdrop'), '保存后弹层没有关闭');
      assert.equal(fetchCalls, 0, '手动添加不应发出网络请求');
    });

    // ---- 2.5 「整份是一道菜」：识别把一道菜拆成原料时一键还原 ----
    await checkAsync('food 整份是一道菜：2 项清单合并成 1 项', async () => {
      const foodView = await import('../views/food.js');
      const foodsMod = await import('../js/foods.js');
      // 数据侧还在补 kind，测试不能绑死某一条：优先真菜，退化为任意已知条目。
      const target = foodsMod.FOODS.find((f) => f.kind === 'dish') || foodsMod.FOODS.find((f) => f.name === '米饭');
      assert.ok(target, '食物库里找不到可用于合并的条目');

      const two = [
        { name: '鸡蛋', grams: 50, kcal: 72, carb: 0.8, protein: 6.7, fat: 4.4, confidence: 'high' },
        { name: '菠菜', grams: 100, kcal: 28, carb: 4.5, protein: 2.6, fat: 0.3 },
      ];
      const done = foodView.openDraftSheet(two, { date: today, source: 'ai', slot: 'lunch' });
      await tick(60);

      const draft = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('识别结果'));
      assert.ok(draft, '没有弹出识别结果清单');
      const rows = () => draft.walk().filter((n) => n.className === 'list__item item-row');
      assert.equal(rows().length, 2, '识别清单应有 2 项');

      const mergeButton = findButton(draft, '整份是一道菜');
      assert.ok(mergeButton, '识别清单里没有「整份是一道菜」入口');
      fireClick(mergeButton);
      await tick(160);

      const pickSheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('选一道菜'));
      assert.ok(pickSheet, '点击合并入口后没有打开选菜弹层');

      const search = pickSheet.walk().find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      assert.ok(search, '选菜弹层没有搜索框');
      search.value = target.name;
      fireInput(search);
      await tick(280);

      const hit = pickSheet.walk()
        .filter((n) => n.className === 'list__item pick-item')
        .find((n) => n.textOf().startsWith(target.name));
      assert.ok(hit, `搜索「${target.name}」没有命中`);
      fireClick(hit);
      await tick(60);

      const gramsInput = pickSheet.walk().find((n) => n.tagName === 'input' && (n.type === 'number' || n.attributes.type === 'number'));
      assert.ok(gramsInput, '选中食物后没有份量输入框');
      const grams = Number(gramsInput.value);
      assert.ok(grams > 0, '份量默认值不是正数');

      const useButton = findButton(pickSheet, '就用这道菜');
      assert.ok(useButton, '选菜弹层没有确认按钮');
      fireClick(useButton);
      await tick(120);

      const modal = dom.body.childNodes.find((n) => n.className === 'modal-backdrop');
      assert.ok(modal, '合并前没有二次确认');
      assert.ok(modal.textOf().includes(`当前 2 项将被替换成「${target.name}」`), `二次确认文案不对：${modal.textOf()}`);
      fireClick(findButton(modal, '替换'));
      await tick(120);

      assert.equal(rows().length, 1, '合并后清单应只剩 1 项');
      const expected = nutrition.scaleFood(target.per100g, grams);
      const mergedText = rows()[0].textOf();
      assert.ok(mergedText.includes(target.name), `合并后名称不是菜名：${mergedText}`);
      assert.ok(mergedText.includes(String(expected.kcal)), `合并后 kcal 不等于 scaleFood 结果 ${expected.kcal}：${mergedText}`);

      fireClick(findButton(draft, '保存到当日'));
      assert.equal(await done, 'saved', '保存后没有返回 saved');
      await tick(80);

      const summary = await store.daySummary(today);
      // 同一天可能已有别的同 foodId 记录（前一个用例刚存过米饭），只认最后写入的那条。
      const saved = summary.meals.filter((meal) => (meal.items || []).some((it) => it.foodId === target.id)).pop();
      assert.ok(saved, '落库后找不到合并出来的那一条');
      const item = saved.items.find((it) => it.foodId === target.id);
      assert.equal(item.name, target.name, '落库名称不是菜名');
      assert.equal(item.grams, grams, '落库克数不是选中的默认份量');
      assert.equal(item.kcal, expected.kcal, '落库 kcal 不等于 scaleFood 结果');
    });

    await checkAsync('food 手动清单同样能整份合并', async () => {
      const root = await renderView('food');
      fireClick(findButton(root, '手动添加'));
      await tick(140);

      const pickSheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(pickSheet, '没有弹出手动添加层');
      const search = pickSheet.walk().find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      search.value = '鸡蛋';
      fireInput(search);
      await tick(280);
      const hit = pickSheet.walk().filter((n) => n.className === 'list__item pick-item')
        .find((n) => n.textOf().startsWith('鸡蛋'));
      assert.ok(hit, '搜索「鸡蛋」没有命中');
      fireClick(hit);
      await tick(60);
      fireClick(findButton(pickSheet, '加入清单'));
      await tick(160);

      const draft = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('确认食物'));
      assert.ok(draft, '没有进入手动清单');
      const mergeButton = findButton(draft, '整份是一道菜');
      assert.ok(mergeButton, '手动清单里没有「整份是一道菜」入口');
      fireClick(mergeButton);
      await tick(160);

      const dishSheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('选一道菜'));
      assert.ok(dishSheet, '手动清单点合并后没有打开选菜弹层');

      const dishSearch = dishSheet.walk().find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      dishSearch.value = '米饭';
      fireInput(dishSearch);
      await tick(280);
      const dishHit = dishSheet.walk().filter((n) => n.className === 'list__item pick-item')
        .find((n) => n.textOf().startsWith('米饭'));
      assert.ok(dishHit, '选菜弹层搜索「米饭」没有命中');
      fireClick(dishHit);
      await tick(60);
      fireClick(findButton(dishSheet, '就用这道菜'));
      await tick(120);
      const modal = dom.body.childNodes.find((n) => n.className === 'modal-backdrop');
      assert.ok(modal, '手动清单合并前没有二次确认');
      assert.ok(modal.textOf().includes('当前 1 项将被替换成「米饭」'), `二次确认文案不对：${modal.textOf()}`);
      fireClick(findButton(modal, '替换'));
      await tick(120);

      const rows = draft.walk().filter((n) => n.className === 'list__item item-row');
      assert.equal(rows.length, 1, '手动清单合并后应只剩 1 项');
      assert.ok(rows[0].textOf().includes('米饭'), `手动清单合并后名称不对：${rows[0].textOf()}`);

      // 收尾：关掉清单，不留残留弹层影响后续用例
      fireClick(findButton(draft, '×'));
      await tick(60);
      assert.ok(!dom.body.childNodes.some((n) => n.className === 'sheet-backdrop'), '关闭后仍有残留弹层');
    });

    await checkAsync('菜品优先展示并渲染「菜」徽标', async () => {
      const foodView = await import('../views/food.js');
      const dish = { id: 'test-dish', name: '菠菜炒鸡蛋', kind: 'dish', per100g: { kcal: 90, carb: 3, protein: 7, fat: 6 }, unit: { name: '1 盘', grams: 300 } };
      const ingredient = { id: 'test-egg', name: '鸡蛋', per100g: { kcal: 144, carb: 1.5, protein: 13.3, fat: 8.8 }, unit: { name: '1 个', grams: 50 } };

      const ordered = foodView.orderFoodsForPick([ingredient, dish]);
      assert.deepEqual(ordered.map((f) => f.id), ['test-dish', 'test-egg'], '菜品没有排到搜索结果前面');

      const row = foodView.renderPickRow(dish, () => {});
      const badge = row.walk().find((n) => String(n.className).includes('pill--dish'));
      assert.ok(badge, '菜品行没有「菜」徽标');
      assert.equal(badge.textOf(), '菜', '徽标文字不是「菜」');
      const plain = foodView.renderPickRow(ingredient, () => {});
      assert.ok(!plain.walk().some((n) => String(n.className).includes('pill--dish')), '原料行不该有「菜」徽标');

      assert.equal(foodView.pickDefaultGrams(dish), 300, '选中菜品时份量默认值应取 unit.grams');
      const detailText = row.textOf();
      assert.ok(detailText.includes('1 盘'), `搜索行没有显示单位名：${detailText}`);

      const merged = foodView.mergeToDish([ingredient, { name: '菠菜', grams: 100, kcal: 28 }], dish);
      const expected = nutrition.scaleFood(dish.per100g, 300);
      assert.equal(merged.length, 1, '合并后应只有 1 项');
      assert.equal(merged[0].name, '菠菜炒鸡蛋');
      assert.equal(merged[0].grams, 300);
      assert.equal(merged[0].foodId, 'test-dish');
      assert.equal(merged[0].kcal, expected.kcal, '合并数值没有走 nutrition.scaleFood');
      assert.equal(merged[0].carb, expected.carb);
    });

    await checkAsync('food.kind 缺失时按原料处理不抛异常', async () => {
      const foodView = await import('../views/food.js');
      const legacy = { id: 'legacy-food', name: '老数据食物', per100g: { kcal: 100, carb: 10, protein: 5, fat: 2 } };
      assert.equal(foodView.isDish(legacy), false, '缺 kind 应判定为原料');
      assert.equal(foodView.isDish(null), false);
      assert.doesNotThrow(() => foodView.renderPickRow(legacy, () => {}), '缺 kind 的行渲染抛异常');
      assert.equal(foodView.pickDefaultGrams(legacy), 100, '无单位的原料默认 100g');
      assert.equal(foodView.defaultDishGrams({ name: '无单位菜', kind: 'dish', per100g: {} }), 200, '菜无单位时默认 200g');

      const ordered = foodView.orderFoodsForPick([legacy, { id: 'd', name: '某菜', kind: 'dish', per100g: {} }]);
      assert.equal(ordered.length, 2);
      assert.equal(ordered[0].id, 'd');

      const merged = foodView.mergeToDish([{ name: '鸡蛋', grams: 50, kcal: 72 }], legacy);
      assert.equal(merged.length, 1, '旧数据也能合并');
      assert.equal(merged[0].name, '老数据食物');
      assert.equal(merged[0].grams, 200, '旧数据无 unit 时默认 200g');
      assert.equal(merged[0].kcal, nutrition.scaleFood(legacy.per100g, 200).kcal);
    });

    // ---- 2.6 常吃套餐：点 chip 记入当前日期对应餐次 ----
    await checkAsync('food 常吃套餐：点 chip 后当日餐次 +1，可删除', async () => {
      const foodView = await import('../views/food.js');
      // chip 上限 6 个；缺名字的脏套餐直接过滤
      assert.equal(foodView.visibleTemplates(Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `套餐${i}` }))).length, 6, '套餐 chip 最多显示 6 个');
      assert.equal(foodView.visibleTemplates([null, { id: 'x' }, { id: 'y', name: '有名字' }]).length, 1, '缺 name 的套餐应被过滤');

      const template = await store.saveMealTemplate({
        name: '测试午餐套餐',
        slot: 'lunch',
        items: [{ name: '套餐测试饭', grams: 150, kcal: 321, carb: 20, protein: 30, fat: 10 }],
      });
      assert.ok(template && template.id, 'saveMealTemplate 没有返回套餐');

      const root = await renderView('food');
      const chip = root.walk().find((n) => String(n.className).split(/\s+/).includes('tpl-chip__main'));
      assert.ok(chip, '日期条下方没有渲染常吃套餐 chip');
      assert.ok(chip.textOf().includes('测试午餐套餐'), `chip 没有显示套餐名：${chip.textOf()}`);
      assert.ok(chip.textOf().includes('321'), `chip 没有显示套餐总热量：${chip.textOf()}`);

      const before = await store.daySummary(today);
      fireClick(chip);
      await tick(220);
      const after = await store.daySummary(today);
      assert.equal(after.meals.length, before.meals.length + 1, '点套餐后餐次数没有 +1');
      const added = after.meals.filter((meal) => (meal.items || []).some((it) => it.name === '套餐测试饭')).pop();
      assert.ok(added, '落库后找不到套餐记入的条目');
      assert.equal(added.slot, 'lunch', '套餐没有记入它自己的餐次');
      assert.equal(after.intake.kcal, before.intake.kcal + 321, '热量没有按套餐累加');
      assert.ok(
        dom.body.childNodes.some((n) => String(n.className).split(/\s+/).includes('toast') && n.textOf().includes('已记入 · 测试午餐套餐')),
        '没有「已记入 · 套餐名」的 toast',
      );
      // 连点会产生多条：允许重复记入
      const reopened = await renderView('food');
      const chipAgain = reopened.walk().find((n) => String(n.className).split(/\s+/).includes('tpl-chip__main'));
      fireClick(chipAgain);
      await tick(220);
      assert.equal((await store.daySummary(today)).meals.length, after.meals.length + 1, '连点第二次没有产生新记录');

      // 删除套餐：二次确认后才真的删，无套餐时整块不渲染
      const forDelete = await renderView('food');
      const del = forDelete.walk().find((n) => String(n.className).split(/\s+/).includes('tpl-chip__del'));
      assert.ok(del, '套餐 chip 没有删除入口');
      fireClick(del);
      await tick(80);
      const modal = dom.body.childNodes.find((n) => n.className === 'modal-backdrop');
      assert.ok(modal, '删除套餐没有二次确认');
      fireClick(findButton(modal, '删除'));
      await tick(220);
      assert.equal((await store.getMealTemplates()).length, 0, '确认后套餐没有被删除');
      // 无套餐 + 当天 ≥2 餐：卡片改叫「整日套餐」，只留「把今天存为整日套餐」入口——
      // 那正是新用户要做的第一个动作，整块不渲染等于没有入口。
      const cleared = await renderView('food');
      assert.ok(!nodeText(cleared).includes('常吃套餐'), '没有套餐时不应再显示「常吃套餐」标题');
      assert.ok(nodeText(cleared).includes('整日套餐'), '无套餐但当天已有 ≥2 餐时应渲染整日套餐卡片');
      assert.ok(findButton(cleared, '把今天存为整日套餐'), '整日套餐卡片缺少存入口');
      assert.equal(byClass(cleared, 'tpl-chip').length, 0, '没有套餐时不该有 chip');
      // 无套餐 + 当天 <2 餐：整块不渲染（翻到前一天，那里一餐都没有）
      fireClick(findButton(cleared, '‹ 前一天'));
      await tick(300);
      assert.ok(!nodeText(cleared).includes('整日套餐'), '当天 <2 餐时不应渲染整日套餐卡片');
      assert.ok(!findButton(cleared, '把今天存为整日套餐'), '当天 <2 餐时不应出现存入口');
    });

    // ---- 2.65 存为套餐：草稿弹层起名 → 落库 → 饮食页出现 chip ----
    await checkAsync('food 存为套餐：草稿弹层起名后可在饮食页看到', async () => {
      const foodView = await import('../views/food.js');
      const done = foodView.openDraftSheet(
        [{ name: '番茄炒蛋', grams: 200, kcal: 210, carb: 8, protein: 12, fat: 14 }],
        { date: today, source: 'manual', slot: 'lunch' },
      );
      await tick(80);
      const draft = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(draft, '没有弹出可编辑清单');
      const saveAsTemplate = findButton(draft, '存为套餐');
      assert.ok(saveAsTemplate, '草稿弹层缺少「存为套餐」入口');
      fireClick(saveAsTemplate);
      await tick(100);

      const nameSheet = dom.body.childNodes.filter((n) => n.className === 'sheet-backdrop').pop();
      assert.ok(nameSheet && nameSheet.textOf().includes('存为套餐'), '起名弹层没有打开');
      const nameInput = nameSheet.walk().find((n) => n.tagName === 'input' && n.type === 'text');
      assert.ok(nameInput, '起名弹层没有输入框');
      assert.equal(nameInput.value, '午餐套餐', `默认套餐名应按餐次建议：${nameInput.value}`);
      nameInput.value = '我的常吃套餐';
      fireClick(findButton(nameSheet, '保存套餐'));
      await tick(180);

      const saved = await store.getMealTemplates();
      assert.equal(saved.length, 1, '存为套餐后没有落库');
      assert.equal(saved[0].name, '我的常吃套餐', '落库的套餐名不对');
      assert.equal(saved[0].slot, 'lunch', '落库的餐次不对');
      assert.equal(saved[0].items[0].name, '番茄炒蛋', '落库的条目不对');

      const root = await renderView('food');
      assert.ok(nodeText(root).includes('我的常吃套餐'), '存完套餐后饮食页没有显示 chip');

      // 收尾：删套餐 + 关草稿，别把状态漏给后续用例
      await store.deleteMealTemplate(saved[0].id);
      fireClick(findButton(draft, '×'));
      await tick(60);
      assert.equal(await done, null, '关闭草稿应返回 null');
      assert.equal((await store.getMealTemplates()).length, 0, '收尾没有删掉套餐');
    });

    // ---- 2.7 最近吃过：点一下直接进份量编辑，默认克数取上次 ----
    await checkAsync('food 最近吃过：点一下进入份量编辑', async () => {
      const expected = await store.recentFoodItems(8);
      assert.ok(expected.length > 0, '种子数据下 recentFoodItems 为空');

      const root = await renderView('food');
      fireClick(findButton(root, '手动添加'));
      await tick(260);
      const sheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(sheet, '没有弹出手动添加层');
      assert.ok(sheet.textOf().includes('最近吃过'), '手动添加层里没有「最近吃过」');
      // 默认折叠成一行：先点开折叠行，再看条目
      const head = sheet.walk().find((n) => String(n.className).split(/\s+/).includes('recent-head'));
      assert.ok(head, '最近吃过没有折叠行');
      fireClick(head);

      const rows = sheet.walk().filter((n) => String(n.className).split(/\s+/).includes('recent-item'));
      assert.equal(rows.length, expected.length, `最近吃过的条数不对：${rows.length} / ${expected.length}`);
      assert.ok(rows[0].textOf().includes(expected[0].name), `第一条不是最近吃的：${rows[0].textOf()}`);
      assert.ok(rows[0].textOf().includes(expected[0].lastDate), '没有显示上次日期');

      fireClick(rows[0]);
      await tick(80);
      const grams = sheet.walk().find((n) => n.tagName === 'input' && (n.type === 'number' || n.attributes.type === 'number'));
      assert.ok(grams, '点最近吃过没有进入份量编辑');
      assert.equal(Number(grams.value), Number(expected[0].item.grams), '默认克数不是上次的克数');
      assert.ok(sheet.textOf().includes(String(expected[0].item.kcal)), `份量预览没有按上次的营养值算：${sheet.textOf().slice(0, 160)}`);

      // 改克数后加入清单：数值按比例缩放，落到可编辑清单里
      grams.value = String(Number(expected[0].item.grams) * 2);
      fireInput(grams);
      fireClick(findButton(sheet, '加入清单'));
      await tick(160);
      const draft = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('确认食物'));
      assert.ok(draft, '最近吃过后没有进入可编辑清单');
      const row = draft.walk().find((n) => String(n.className).split(/\s+/).includes('item-row'));
      assert.ok(row && row.textOf().includes(expected[0].name), '清单里没有最近吃过的条目');
      fireClick(findButton(draft, '×'));
      await tick(80);
    });

    // ---- 2.75 手动添加层：搜索框在最上，「最近吃过」折成一行 ----
    await checkAsync('food 手动添加层：搜索框在「最近吃过」之前', async () => {
      const root = await renderView('food');
      fireClick(findButton(root, '手动添加'));
      await tick(260);
      const sheet = dom.body.childNodes.filter((n) => n.className === 'sheet-backdrop').pop();
      assert.ok(sheet, '没有弹出手动添加层');

      const nodes = sheet.walk();
      const search = nodes.find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      const head = nodes.find((n) => String(n.className).split(/\s+/).includes('recent-head'));
      assert.ok(search, '手动添加层没有搜索框');
      assert.ok(head, '最近吃过没有折叠行');
      assert.ok(nodes.indexOf(search) < nodes.indexOf(head), '搜索框在 DOM 中不在「最近吃过」之前');
      assert.ok(head.textOf().includes('最近吃过'), `折叠行文案不对：${head.textOf()}`);
      assert.ok(/最近吃过 \(\d+\)/.test(head.textOf()), `折叠行没有条数：${head.textOf()}`);

      fireClick(findButton(sheet, '×'));
      await tick(60);
      assert.ok(!dom.body.childNodes.some((n) => n.className === 'sheet-backdrop'), '收尾时搜索弹层没关掉');
    });

    // ---- 2.76 最近吃过：默认折叠成一行，点开出现条目，再点收起 ----
    await checkAsync('food 最近吃过：默认折叠一行，点开出现条目，再点收起', async () => {
      const expected = await store.recentFoodItems(8);
      assert.ok(expected.length > 0, '种子数据下 recentFoodItems 为空');

      const root = await renderView('food');
      fireClick(findButton(root, '手动添加'));
      await tick(260);
      const sheet = dom.body.childNodes.filter((n) => n.className === 'sheet-backdrop').pop();
      assert.ok(sheet, '没有弹出手动添加层');

      const rows = () => sheet.walk().filter((n) => String(n.className).split(/\s+/).includes('recent-item'));
      const head = sheet.walk().find((n) => String(n.className).split(/\s+/).includes('recent-head'));
      assert.ok(head, '最近吃过没有折叠行');
      assert.equal(head.getAttribute('aria-expanded'), 'false', '最近吃过默认不是折叠状态');
      assert.equal(rows().length, 0, '折叠时不应渲染条目');

      fireClick(head);
      assert.equal(head.getAttribute('aria-expanded'), 'true', '点开后没有展开态');
      assert.equal(rows().length, expected.length, `展开后的条数不对：${rows().length} / ${expected.length}`);
      assert.ok(head.textOf().includes('▲'), `展开后没有可见的状态提示：${head.textOf()}`);

      fireClick(head);
      assert.equal(rows().length, 0, '再点一次没有收起');
      assert.ok(head.textOf().includes('▼'), `收起后没有回到折叠态：${head.textOf()}`);

      fireClick(findButton(sheet, '×'));
      await tick(60);
    });

    // ---- 2.77 今日餐次：默认折成一行（餐数 + 总热量），点开出现逐餐行 ----
    await checkAsync('dashboard 今日餐次：默认折成一行，点开出现逐餐行', async () => {
      const summary = await store.daySummary(today);
      assert.ok(summary.meals.length >= 2, '当天餐次不足，无法验证折叠行');
      const totalKcal = Math.round(summary.meals.reduce((sum, meal) => sum + nutrition.sumItems(meal.items || []).kcal, 0));

      const root = await renderView('dashboard');
      const fold = root.walk().find((n) => String(n.className).split(/\s+/).includes('meal-fold'));
      assert.ok(fold, '今日餐次没有折叠行');
      assert.ok(fold.textOf().includes(`${summary.meals.length} 餐`), `折叠行没有餐数：${fold.textOf()}`);
      assert.ok(fold.textOf().includes(String(totalKcal)), `折叠行没有总热量 ${totalKcal}：${fold.textOf()}`);
      assert.equal(fold.getAttribute('aria-expanded'), 'false', '今日餐次默认不是折叠状态');
      assert.equal(byClass(root, 'meal-fold__list').length, 0, '折叠时不应渲染逐餐列表');

      const record = findButton(root, '去记录');
      assert.ok(record, '折叠行右侧没有「去记录」');
      fireClick(record);
      assert.equal(byClass(root, 'meal-fold__list').length, 0, '点「去记录」不应展开逐餐列表');

      fireClick(fold);
      const lists = byClass(root, 'meal-fold__list');
      assert.equal(lists.length, 1, '点折叠行没有展开逐餐列表');
      const mealRows = lists[0].walk().filter((n) => String(n.className).split(/\s+/).includes('list__item'));
      assert.equal(mealRows.length, summary.meals.length, `展开后的逐餐行数不对：${mealRows.length} / ${summary.meals.length}`);
      assert.ok(fold.textOf().includes('▲'), `展开后没有可见的状态提示：${fold.textOf()}`);
    });

    // ---- 2.78 整日套餐 chip：点一下把 meals 里每一餐都记入当天 ----
    await checkAsync('food 整日套餐 chip：点一下把每一餐都记入当天', async () => {
      const dayTpl = await store.saveDayTemplate({
        name: '测试整日套餐',
        meals: [
          { slot: 'breakfast', items: [{ name: '整日早餐蛋', grams: 50, kcal: 78, carb: 1, protein: 6, fat: 5 }] },
          { slot: 'lunch', items: [{ name: '整日午餐饭', grams: 200, kcal: 260, carb: 58, protein: 5, fat: 1 }] },
          { slot: 'dinner', items: [{ name: '整日晚餐菜', grams: 150, kcal: 180, carb: 8, protein: 12, fat: 10 }] },
        ],
      });
      assert.ok(dayTpl && dayTpl.id, 'saveDayTemplate 没有返回套餐');

      const root = await renderView('food');
      const chip = byClass(root, 'tpl-chip__main').find((n) => n.textOf().includes('测试整日套餐'));
      assert.ok(chip, '饮食页没有渲染整日套餐 chip');
      assert.ok(chip.textOf().includes('518'), `chip 没有显示总热量：${chip.textOf()}`);
      assert.ok(chip.textOf().includes('早+午+晚'), `chip 没有显示餐次副标题：${chip.textOf()}`);

      const before = await store.daySummary(today);
      fireClick(chip);
      await tick(260);
      const after = await store.daySummary(today);
      assert.equal(after.meals.length, before.meals.length + 3, '整日套餐没有按 meals 数量增加餐次');
      assert.equal(after.intake.kcal, before.intake.kcal + 518, '整日套餐的热量没有全部累加');
      for (const [slot, name] of [['breakfast', '整日早餐蛋'], ['lunch', '整日午餐饭'], ['dinner', '整日晚餐菜']]) {
        const hit = after.meals.filter((m) => m.slot === slot && (m.items || []).some((it) => it.name === name)).pop();
        assert.ok(hit, `整日套餐没有把 ${slot} 记入当天`);
      }
      assert.ok(
        dom.body.childNodes.some((n) => String(n.className).split(/\s+/).includes('toast') && n.textOf().includes('已记入 3 餐 · 测试整日套餐')),
        '没有「已记入 3 餐 · 套餐名」的 toast',
      );

      await store.deleteMealTemplate(dayTpl.id);
      assert.equal((await store.getMealTemplates()).length, 0, '收尾没有删掉整日套餐');
    });

    // ---- 2.79 把今天存为整日套餐：不足 2 餐给提示，足够时落库为 kind=day ----
    await checkAsync('food 把今天存为整日套餐：不足时提示，足够时落库', async () => {
      await store.saveMealTemplate({
        name: '入口测试套餐',
        slot: 'snack',
        items: [{ name: '入口测试坚果', grams: 20, kcal: 120, carb: 3, protein: 4, fat: 10 }],
      });

      // 不足 2 餐：切到没有任何记录的昨天，点入口只提示、不弹命名表单
      const root = await renderView('food');
      fireClick(findButton(root, '‹ 前一天'));
      await tick(200);
      const entry = findButton(root, '把今天存为整日套餐');
      assert.ok(entry, '套餐卡片头没有「把今天存为整日套餐」入口');
      fireClick(entry);
      await tick(140);
      assert.ok(
        dom.body.childNodes.some((n) => String(n.className).split(/\s+/).includes('toast') && n.textOf().includes('今天还没有足够的餐次可存')),
        '当天餐次不足时没有给提示',
      );
      assert.equal((await store.getMealTemplates()).length, 1, '当天餐次不足时不应写入整日套餐');

      // 足够 2 餐：今天的饮食页 → 命名弹层 → 落库
      const todayRoot = await renderView('food');
      const entryToday = findButton(todayRoot, '把今天存为整日套餐');
      assert.ok(entryToday, '今天的饮食页没有整日套餐入口');
      fireClick(entryToday);
      await tick(140);
      const nameSheet = dom.body.childNodes.filter((n) => n.className === 'sheet-backdrop').pop();
      assert.ok(nameSheet && nameSheet.textOf().includes('存为整日套餐'), '没有打开整日套餐命名弹层');
      const input = nameSheet.walk().find((n) => n.tagName === 'input' && n.type === 'text');
      assert.ok(input, '命名弹层没有输入框');
      assert.equal(input.value, '工作日常餐', `整日套餐的默认名不对：${input.value}`);
      fireClick(findButton(nameSheet, '保存套餐'));
      await tick(240);

      const saved = (await store.getMealTemplates()).filter((t) => t.kind === 'day');
      assert.equal(saved.length, 1, '足够餐次时没有落库整日套餐');
      assert.equal(saved[0].name, '工作日常餐', '落库的整日套餐名不对');
      assert.ok(saved[0].meals.length >= 2, `整日套餐的餐次不足 2：${saved[0].meals.length}`);
      const slots = saved[0].meals.map((m) => m.slot);
      assert.ok(slots.includes('breakfast') && slots.includes('lunch'), `当天餐次没有按 slot 分组：${slots.join('/')}`);

      // 收尾：删掉两个套餐，别把状态漏给后续用例
      for (const t of await store.getMealTemplates()) await store.deleteMealTemplate(t.id);
      assert.equal((await store.getMealTemplates()).length, 0, '收尾没有删掉套餐');
    });

    // ---- 3. 无 API Key：走「去设置」引导，绝不发请求 ----
    await checkAsync('food 无 API Key 时给引导且不发请求', async () => {
      const root = await renderView('food');
      const text = nodeText(root);
      assert.ok(text.includes('未配置 Key'), '没有显示未配置 Key 的提示');
      assertNoLeak(text, 'food(无 Key)');

      const camera = findButton(root, '拍照识别');
      assert.ok(camera, '找不到拍照入口');
      const fileInput = camera.walk().find((n) => n.tagName === 'input' && (n.type === 'file' || n.attributes.type === 'file'));
      assert.ok(fileInput, '拍照入口里没有 file input');
      assert.equal(fileInput.attributes.capture, 'environment', 'file input 缺少 capture=environment');

      const event = fireClick(camera);
      assert.ok(event.defaultPrevented, '无 Key 时没有阻止打开文件选择器');
      await tick(80);

      const sheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop' && n.textOf().includes('还没配置 API Key'));
      assert.ok(sheet, '无 Key 时没有弹出引导');
      assert.ok(sheet.textOf().includes('去设置页填写'), '引导里缺少「去设置页填写」');
      assert.equal(fetchCalls, 0, '无 Key 时不应发出任何网络请求');

      const cancel = findButton(sheet, '取消');
      if (cancel) fireClick(cancel);
      await tick(40);
    });

    // ---- 3.5 份量单位：详情层 chip / 无单位退化 / 搜索行主单位 / 已存条目参照 ----
    await checkAsync('food 份量单位 chip：点第二个后克数=grams、预览随之变化', async () => {
      const foodView = await import('../views/food.js');
      const fake = {
        id: 'test-multi-unit',
        name: '测试鸡腿',
        per100g: { kcal: 200, carb: 0, protein: 20, fat: 12 },
        units: [
          { name: '1 只（去皮，去骨）', grams: 90 },
          { name: '1 只（带骨）', grams: 120 },
        ],
      };
      const panel = foodView.renderPortionDetail(fake, {});
      const chips = byClass(panel, 'portion-chip--unit');
      assert.equal(chips.length, 2, `应渲染 2 个单位 chip，实际 ${chips.length}`);
      assert.ok(chips[0].textOf().includes('1 只（去皮，去骨）'), `chip 缺少单位名：${chips[0].textOf()}`);
      assert.ok(chips[0].textOf().includes('90g'), `chip 没写明这个单位多少克：${chips[0].textOf()}`);
      assert.ok(chips[1].textOf().includes('120g'), `第二个 chip 没写明克数：${chips[1].textOf()}`);
      assert.ok(panel.textOf().includes('1 拳 ≈ 150g · 1 掌心 ≈ 100g · 1 汤匙 ≈ 15g'), '缺少目测参考文案');

      const input = panel.walk().find((n) => n.tagName === 'input' && n.type === 'number');
      assert.ok(input, '详情层没有克数输入框');
      assert.equal(Number(input.value), 90, '默认克数应取第一个单位');
      const preview = () => byClass(panel, 'portion-preview')[0].textOf();
      assert.ok(chips[0].className.split(/\s+/).includes('is-active'), '默认 chip 没有选中态');

      const before = preview();
      fireClick(chips[1]);
      assert.equal(Number(input.value), 120, '点 chip 后克数输入框没有填成该单位的 grams');
      assert.ok(chips[1].className.split(/\s+/).includes('is-active'), '点击后第二个 chip 没有选中态');
      assert.ok(!chips[0].className.split(/\s+/).includes('is-active'), '旧 chip 的选中态没撤掉');
      const after = preview();
      assert.notEqual(after, before, '热量预览没有随单位变化');
      assert.ok(after.includes(String(nutrition.scaleFood(fake.per100g, 120).kcal)), `预览热量不对：${after}`);

      // 手动改克数：选中态跟随输入，不留错挂的 chip
      input.value = '90';
      fireInput(input);
      assert.ok(chips[0].className.split(/\s+/).includes('is-active'), '手动改回 90g 后第一个 chip 应重新选中');
    });

    await checkAsync('food 无 units 食物：不渲染 chip 区且不抛异常', async () => {
      const foodView = await import('../views/food.js');
      const legacy = { id: 'test-no-unit', name: '无单位食物', per100g: { kcal: 100, carb: 10, protein: 5, fat: 2 } };
      let panel;
      assert.doesNotThrow(() => { panel = foodView.renderPortionDetail(legacy, {}); }, '无 units 的食物渲染详情抛异常了');
      assert.equal(byClass(panel, 'portion-units').length, 0, '无 units 时不应渲染 chip 区');
      assert.equal(byClass(panel, 'portion-chip').length, 0, '无 units 时不应有任何 chip');
      const input = panel.walk().find((n) => n.tagName === 'input' && n.type === 'number');
      assert.ok(input, '无 units 时克数输入框不见了');
      assert.equal(Number(input.value), 100, '无 units 的原料默认 100g');
      input.value = '150';
      assert.doesNotThrow(() => fireInput(input), '无 units 时手动改克数抛异常');
      assert.ok(byClass(panel, 'portion-preview')[0].textOf().includes('150'), '无 units 时预览没有按克数换算');

      assert.deepEqual(foodView.unitsOf(legacy), [], '无 units 的 unitsOf 应返回空数组');
      assert.equal(foodView.itemUnitHint({ foodId: 'test-no-unit', grams: 100 }), '', '无单位条目不应给参照');
      assert.doesNotThrow(() => foodView.renderPickRow(legacy, () => {}), '无 units 的搜索行渲染抛异常');
    });

    await checkAsync('food 搜索行显示主单位（foodUnits[0]），且只占元信息一行', async () => {
      const foodView = await import('../views/food.js');
      const fake = {
        id: 'test-row-unit',
        name: '测试多单位饭',
        per100g: { kcal: 116, carb: 25.9, protein: 2.6, fat: 0.3 },
        units: [{ name: '1 碗', grams: 200 }, { name: '1 大碗', grams: 320 }],
      };
      const row = foodView.renderPickRow(fake, () => {});
      const text = row.textOf();
      assert.ok(text.includes('1 碗 ≈ 200g'), `搜索行没有主单位文案：${text}`);
      assert.ok(!text.includes('1 大碗'), '搜索行只应显示主单位，不该平铺全部单位');
      assert.equal(byClass(row, 'list__item--meta').length, 1, '主单位应并进元信息一行，避免撑高行高');
      const plain = foodView.renderPickRow({ id: 'test-row-plain', name: '无单位食物', per100g: { kcal: 100 } }, () => {});
      assert.ok(!plain.textOf().includes('≈'), '无单位食物的搜索行不应显示份量参照');

      // 真实搜索链路：库里有单位的食物，结果行同样带主单位
      const foodsMod = await import('../js/foods.js');
      const target = foodsMod.FOODS.find((f) => f && f.name && foodView.unitsOf(f).length);
      assert.ok(target, '食物库里找不到带单位的食物');
      const unit = foodView.unitsOf(target)[0];
      const root = await renderView('food');
      fireClick(findButton(root, '手动添加'));
      await tick(160);
      const sheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(sheet, '没有弹出手动添加层');
      const search = sheet.walk().find((n) => n.tagName === 'input' && (n.type === 'search' || n.attributes.type === 'search'));
      search.value = target.name;
      fireInput(search);
      await tick(280);
      const hit = sheet.walk().filter((n) => n.className === 'list__item pick-item')
        .find((n) => n.textOf().startsWith(target.name));
      assert.ok(hit, `搜索「${target.name}」没有命中`);
      assert.ok(hit.textOf().includes(`${unit.name} ≈ ${unit.grams}g`), `搜索结果行没有主单位：${hit.textOf()}`);
      fireClick(findButton(sheet, '×'));
      await tick(60);
      assert.ok(!dom.body.childNodes.some((n) => n.className === 'sheet-backdrop'), '收尾时搜索弹层没关掉');
    });

    await checkAsync('food 已保存条目：接近单位才显示 ≈1 碗，差距大不显示', async () => {
      const foodView = await import('../views/food.js');
      const foodsMod = await import('../js/foods.js');
      const single = foodsMod.FOODS.find((f) => f && f.name && foodView.unitsOf(f).length === 1);
      assert.ok(single, '食物库里找不到单单位食物');
      const unit = foodView.unitsOf(single)[0];

      assert.equal(foodView.unitHintFor(unit.grams, [unit]), `≈${unit.name}`, '正好的克数应给参照');
      assert.equal(foodView.unitHintFor(Math.round(unit.grams * 1.1), [unit]), `≈${unit.name}`, '±15% 内应给参照');
      assert.equal(foodView.unitHintFor(Math.round(unit.grams * 1.3), [unit]), '', '超过 ±15% 不应给参照');
      assert.equal(foodView.unitHintFor(unit.grams, []), '', '没有单位时不给参照');

      const nearName = `参照测试近-${single.id}`;
      const farName = `参照测试远-${single.id}`;
      const macros = { kcal: 100, carb: 10, protein: 5, fat: 3 };
      const farGrams = Math.round(unit.grams * 2);
      assert.ok(farGrams > unit.grams * 1.15, '测试用的「远」克数没有拉开差距');
      await store.logMeal({
        date: today, slot: 'snack', source: 'manual',
        items: [{ name: nearName, grams: unit.grams, foodId: single.id, ...macros }],
      });
      await store.logMeal({
        date: today, slot: 'snack', source: 'manual',
        items: [{ name: farName, grams: farGrams, foodId: single.id, ...macros }],
      });

      const root = await renderView('food');
      const rows = byClass(root, 'list__item');
      const nearRow = rows.find((n) => n.textOf().includes(nearName));
      assert.ok(nearRow, '餐次列表里找不到接近单位的那条');
      assert.ok(nearRow.textOf().includes(`≈${unit.name}`), `接近单位时应显示参照：${nearRow.textOf()}`);
      const farRow = rows.find((n) => n.textOf().includes(farName));
      assert.ok(farRow, '餐次列表里找不到差距大的那条');
      assert.ok(!farRow.textOf().includes('≈'), `差距大时不该显示参照：${farRow.textOf()}`);
    });

    await checkAsync('food 编辑已有条目的份量层：单位 chip 可点并换算克数', async () => {
      const foodView = await import('../views/food.js');
      const foodsMod = await import('../js/foods.js');
      const single = foodsMod.FOODS.find((f) => f && f.name && foodView.unitsOf(f).length === 1);
      assert.ok(single, '食物库里找不到单单位食物');
      const unit = foodView.unitsOf(single)[0];
      const name = `份量编辑测试-${single.id}`;
      await store.logMeal({
        date: today, slot: 'snack', source: 'manual',
        items: [{ name, grams: Math.round(unit.grams * 2), foodId: single.id, kcal: 100, carb: 10, protein: 5, fat: 3 }],
      });
      const root = await renderView('food');
      const row = byClass(root, 'list__item').find((n) => n.textOf().includes(name));
      assert.ok(row, '餐次列表里找不到测试条目');
      fireClick(findButton(row, '份量'));
      await tick(100);

      const sheet = dom.body.childNodes.find((n) => n.className === 'sheet-backdrop');
      assert.ok(sheet, '点「份量」没有打开编辑层');
      const chips = byClass(sheet, 'portion-chip--unit');
      assert.equal(chips.length, 1, `编辑层应渲染该食物的 1 个单位 chip：${chips.length}`);
      assert.ok(chips[0].textOf().includes(`${unit.grams}g`), `编辑层 chip 没写明克数：${chips[0].textOf()}`);
      const input = sheet.walk().find((n) => n.tagName === 'input' && (n.type === 'number' || n.attributes.type === 'number'));
      assert.ok(input, '编辑层没有克数输入框');
      fireClick(chips[0]);
      assert.equal(Number(input.value), unit.grams, '点单位 chip 后克数没有换算成该单位');
      assert.ok(byClass(sheet, 'portion-preview')[0].textOf().includes('kcal'), '编辑层预览没有刷新');

      fireClick(findButton(sheet, '取消'));
      await tick(80);
      assert.ok(!dom.body.childNodes.some((n) => n.className === 'sheet-backdrop'), '取消后编辑层没有关闭');
    });

    // ---- 3.9 BMI 可视化：四档小人 / 指针百分比 / 边界提示 ----
    // 前面的用例拖过刻度尺、存过别的体重；这一段依赖种子状态（今天 68.4kg / 172cm），
    // 先把它钉回去（logWeight 按日期覆盖），免得断言跟着跑过的用例漂。
    await store.logWeight({ date: today, weightKg: SEED.weightKg });
    await checkAsync('weight BMI 区块：四档小人 + 当前档位高亮 + 指针百分比', async () => {
      const weightView = await import('../views/weight.js');
      const root = await renderView('weight');
      assertNoLeak(nodeText(root), 'weight(BMI)');

      // 种子：172cm / 68.4kg → 23.1（正常）
      const bmiValue = nutrition.bmi({ weightKg: SEED.weightKg, heightCm: 172 });
      assert.equal(bmiValue, 23.1, `种子数据下 BMI 应为 23.1：${bmiValue}`);

      const panel = byClass(root, 'bmi-panel');
      assert.equal(panel.length, 1, `BMI 区块应恰好一个：${panel.length}`);
      // 旧的「BMI + 药丸标签」一行必须已经换掉，不能两套并存
      assert.ok(!byClass(root, 'pill').some((n) => n.textOf().includes('BMI')), '旧的 BMI 药丸标签仍在');
      assert.equal(byClass(panel[0], 'bmi-value__num')[0].textOf(), '23.1', 'BMI 大号数值不对');
      assert.equal(byClass(panel[0], 'bmi-value__unit')[0].textOf(), 'BMI', '大号数值缺少 BMI 单位');

      // 四档小人：每档一个圆头 + 躯干/双臂/双腿三条 path，只有当前档位带 is-active
      const figures = byClass(panel[0], 'bmi-figure');
      assert.equal(figures.length, 4, `体态小人应为 4 档：${figures.length}`);
      assert.deepEqual(figures.map((n) => n.textOf()), ['偏瘦', '正常', '超重', '肥胖']);
      const active = figures.filter((n) => String(n.className).split(/\s+/).includes('is-active'));
      assert.equal(active.length, 1, `当前档位应恰好高亮一个：${active.length}`);
      assert.equal(active[0].textOf(), '正常', `高亮档位应与 bmiClass 一致：${active[0].textOf()}`);
      const drawn = byAttrClass(figures[0], 'bmi-body-line');
      assert.equal(drawn.length, 4, `小人应有 4 条描线（头 + 躯干 + 双臂 + 双腿）：${drawn.length}`);
      assert.equal(drawn.filter((n) => n.tagName === 'circle').length, 1, '小人缺少圆头');
      assert.equal(drawn.filter((n) => n.tagName === 'path').length, 3, '小人缺少躯干/双臂/双腿 path');
      assert.equal(byAttrClass(figures[3], 'bmi-body-line').length, 4, '四档小人应共用同一套骨架');
      // 骨架按档位变宽：肥胖档的肩宽必须大于偏瘦档，否则四条线看起来一模一样
      const shoulderOf = (node) => Number(/M (-?[\d.]+) /.exec(byAttrClass(node, 'bmi-body-line')[1].getAttribute('d'))[1]);
      assert.ok(Math.abs(shoulderOf(figures[3])) > Math.abs(shoulderOf(figures[0])), '肥胖档小人没有比偏瘦档更宽');

      // 指针位置 = (BMI − 14) / (34 − 14) × 100%，保留 1 位；端点与越界夹取
      const marker = byClass(panel[0], 'bmi-marker');
      assert.equal(marker.length, 1, '区间条缺少气泡指针');
      assert.equal(weightView.bmiScalePos(bmiValue), 45.5, `23.1 应对应 45.5%：${weightView.bmiScalePos(bmiValue)}`);
      assert.equal(marker[0].style.left, '45.5%', `指针位置不对：${marker[0].style.left}`);
      assert.equal(weightView.bmiScalePos(14), 0, '14 应对应 0%');
      assert.equal(weightView.bmiScalePos(18.5), 22.5, '18.5 应对应 22.5%');
      assert.equal(weightView.bmiScalePos(24), 50, '24 应对应 50%');
      assert.equal(weightView.bmiScalePos(28), 70, '28 应对应 70%');
      assert.equal(weightView.bmiScalePos(34), 100, '34 应对应 100%');
      assert.equal(weightView.bmiScalePos(9), 0, '低于 14 应夹到 0%');
      assert.equal(weightView.bmiScalePos(40), 100, '高于 34 应夹到 100%');
      assert.equal(weightView.bmiScalePos(Number.NaN), 0, '非法值不该算出 NaN%');
      assert.equal(byClass(marker[0], 'bmi-bubble')[0].textOf(), '23.1', '气泡没有显示当前 BMI');

      // 刻度与区间条同源：每个刻度落在自己的百分比上（指针因此对得上刻度）
      const ticks = byClass(panel[0], 'bmi-tick');
      assert.deepEqual(ticks.map((n) => n.textOf()), ['14', '18.5', '24', '28', '34']);
      assert.deepEqual(ticks.map((n) => n.style.left), ['0%', '22.5%', '50%', '70%', '100%'], '刻度位置与区间边界不对齐');
      const segs = byClass(panel[0], 'bmi-seg');
      assert.equal(segs.length, 4, `区间条应分 4 段：${segs.length}`);
      assert.deepEqual(segs.map((n) => n.style.width), ['22.5%', '27.5%', '20%', '30%'], '四段宽度不对');
      assert.deepEqual(byClass(panel[0], 'bmi-band').map((n) => n.textOf()), ['偏瘦', '正常', '超重', '肥胖']);
      assert.ok(nodeText(root).includes('区间后段'), '23.1 在正常档 83.6% 处，应显示「区间后段」');
    });

    await checkAsync('weight BMI 区块：上下两条边界提示与 bmiGaps 同源', async () => {
      const weightView = await import('../views/weight.js');
      const root = await renderView('weight');
      const text = nodeText(root);

      const gaps = nutrition.bmiGaps(23.1, 172);
      assert.deepEqual(gaps, { lower: { label: '偏瘦', kg: 13.6 }, upper: { label: '超重', kg: 2.7 } }, 'bmiGaps 结果与预期不符');
      assert.equal(byClass(root, 'bmi-gap').length, 2, '上下两条边界提示都要显示');
      assert.ok(text.includes('距「超重」还差 2.7 kg'), `缺少上边界提示：${text.slice(0, 240)}`);
      assert.ok(text.includes('距「偏瘦」还有 13.6 kg'), '缺少下边界提示');

      // 前 / 中 / 后段按档位内的相对位置算：<35% 前段、35–65% 中段、>65% 后段
      assert.equal(weightView.bmiBandPhase(18.5), '前段', '刚进正常档应是前段');
      assert.equal(weightView.bmiBandPhase(20.4), '前段', '34.5% 仍是前段');
      assert.equal(weightView.bmiBandPhase(20.5), '中段', '36.4% 进入中段');
      assert.equal(weightView.bmiBandPhase(23.1), '后段', '83.6% 是后段');
      assert.equal(weightView.bmiBandPhase(25), '前段', '超重档的 25% 是前段');
      assert.equal(weightView.bmiBandPhase(26), '中段', '超重档的一半是中段');
      assert.equal(weightView.bmiBandPhase(Number.NaN), '中段', '非法值回落到中段而不是 NaN');
    });

    await checkAsync('weight BMI 区块：缺身高或体重时整块不渲染', async () => {
      const weightView = await import('../views/weight.js');
      // 纯函数层：身高/体重缺一都返回 null，绝不产出 0 / NaN 的区块
      assert.equal(weightView.bmiPanel(SEED.weightKg, 0), null, '没有身高时不该出区块');
      assert.equal(weightView.bmiPanel(SEED.weightKg, Number.NaN), null, '身高非法时不该出区块');
      assert.equal(weightView.bmiPanel(0, 172), null, '没有体重时不该出区块');
      assert.equal(weightView.bmiPanel(null, 172), null, '体重为空时不该出区块');

      // DOM 层：把档案身高抹掉，整页不应再出现 BMI 区块
      const profile = await store.getProfile();
      assert.equal(Number(profile.heightCm), 172, '种子档案应带 172cm 身高');
      await store.saveProfile({ ...profile, heightCm: 0 });
      const noHeight = await renderView('weight');
      assert.equal(byClass(noHeight, 'bmi-panel').length, 0, '没有身高时仍渲染了 BMI 区块');
      assert.ok(!nodeText(noHeight).includes('BMI'), '没有身高时不该出现 BMI 字样');
      assert.equal(byClass(noHeight, 'bmi-figure').length, 0, '没有身高时不该有体态小人');
      // 还原档案，后面的用例还要用
      await store.saveProfile(profile);
      const restored = await renderView('weight');
      assert.equal(byClass(restored, 'bmi-panel').length, 1, '恢复身高后 BMI 区块没有回来');
    });

    // ---- 3.95 运动页：类型分组 / 强度档位 / 净消耗 ----
    await checkAsync('exercise 强度档位：每个类型记住上次的选择', async () => {
      const bag = new Map();
      const previous = globalThis.localStorage;
      globalThis.localStorage = {
        getItem: (k) => (bag.has(k) ? bag.get(k) : null),
        setItem: (k, v) => { bag.set(k, String(v)); },
        removeItem: (k) => { bag.delete(k); },
      };
      try {
        let root = await renderView('exercise');
        const typeSel = () => byClass(root, 'type-field')[0].walk().find((n) => n.tagName === 'select');
        const intSel = () => byClass(root, 'intensity-field')[0].walk().find((n) => n.tagName === 'select');

        typeSel().value = 'bike';
        fireChange(typeSel());
        assert.equal(intSel().value, 'road', '骑行第一次进来应是数据侧的中档（公路车）');

        intSel().value = 'commute';
        fireChange(intSel());
        assert.equal(bag.get('hms.ex.intensity.bike'), 'commute', '选了通勤档却没有记住');

        root = await renderView('exercise');
        typeSel().value = 'bike';
        fireChange(typeSel());
        assert.equal(intSel().value, 'commute', '重新进入运动页没有恢复上次的档位');

        typeSel().value = 'jog';
        fireChange(typeSel());
        assert.equal(intSel().value, 'steady', '没选过的类型该回到默认档，不该被骑行的记忆串味');
      } finally {
        if (previous === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previous;
      }
    });

    await checkAsync('exercise 类型下拉：EXERCISE_TYPES 全量 + 按 group 分组', async () => {
      const root = await renderView('exercise');
      const field = byClass(root, 'type-field')[0];
      assert.ok(field, '运动页没有类型字段');
      const select = field.walk().find((n) => n.tagName === 'select');
      assert.ok(select, '类型字段里没有 select');

      assert.ok(nutrition.EXERCISE_TYPES.length >= 20, `类型不足 20 种：${nutrition.EXERCISE_TYPES.length}`);
      const groups = field.walk().filter((n) => n.tagName === 'optgroup');
      assert.deepEqual(
        groups.map((n) => n.getAttribute('label')),
        [...new Set(nutrition.EXERCISE_TYPES.map((t) => t.group))],
        'optgroup 的分组与顺序应照 EXERCISE_TYPES',
      );
      assert.ok(groups.length >= 3, `分组太少：${groups.length}`);

      const options = groups.flatMap((g) => g.walk().filter((n) => n.tagName === 'option'));
      assert.deepEqual(
        options.map((n) => n.value),
        nutrition.EXERCISE_TYPES.map((t) => t.value),
        '下拉里的类型与 EXERCISE_TYPES 不一致',
      );
      assert.ok(options.every((n) => n.textOf().length > 0), '有类型没有中文标签');
      assert.equal(select.value, nutrition.EXERCISE_TYPES[0].value, '类型下拉的初值应为第一项');
    });

    await checkAsync('exercise 强度下拉：带 intensities 的类型才出现，估算随档位变化', async () => {
      const root = await renderView('exercise');
      const hintText = () => byClass(root, 'estimate-hint')[0].textOf();
      const typeSelect = byClass(root, 'type-field')[0].walk().find((n) => n.tagName === 'select');
      const minutes = root.walk().find((n) => n.tagName === 'input' && n.type === 'number');
      minutes.value = '30';
      fireInput(minutes);

      // 不带档位的类型（椭圆机）：整块强度下拉不出现
      typeSelect.value = 'elliptical';
      fireChange(typeSelect);
      assert.equal(byClass(root, 'intensity-field').length, 0, '椭圆机没有档位，不该出现强度下拉');
      assert.equal(hintText(), '估算 137 kcal（椭圆机 · 30 分钟 · 净消耗）', `无档位类型的文案不对：${hintText()}`);

      // 带档位的类型（骑行，5 档）：出现强度下拉，默认取 met 与该类型默认 met 相同的一档
      const bike = nutrition.EXERCISE_TYPES.find((t) => t.value === 'bike');
      typeSelect.value = 'bike';
      fireChange(typeSelect);
      const field = byClass(root, 'intensity-field');
      assert.equal(field.length, 1, '骑行有 5 档，应出现强度下拉');
      assert.equal(field[0].walk().find((n) => n.tagName === 'span').textOf(), '强度 / 配速');
      const intensitySelect = field[0].walk().find((n) => n.tagName === 'select');
      assert.deepEqual(
        intensitySelect.walk().filter((n) => n.tagName === 'option').map((n) => n.value),
        bike.intensities.map((i) => i.value),
        '强度选项应来自该类型的 intensities',
      );
      assert.equal(intensitySelect.value, 'road', `默认档位应取 met=8 那一档：${intensitySelect.value}`);
      assert.equal(hintText(), `估算 239 kcal（骑行 · ${bike.intensities.find((i) => i.value === 'road').label} · 30 分钟 · 净消耗）`, `默认档位文案不对：${hintText()}`);

      // 换档位：估算数值随之变化
      intensitySelect.value = 'spin';
      fireChange(intensitySelect);
      assert.equal(hintText(), `估算 257 kcal（骑行 · ${bike.intensities.find((i) => i.value === 'spin').label} · 30 分钟 · 净消耗）`, `换档位后文案不对：${hintText()}`);
      assert.notEqual(
        nutrition.estimateBurn({ type: 'bike', minutes: 30, weightKg: 68.4, intensity: 'road' }),
        nutrition.estimateBurn({ type: 'bike', minutes: 30, weightKg: 68.4, intensity: 'spin' }),
        '两个档位的估算值不该相同',
      );

      // 换回不带到档位的类型：下拉整块收回
      typeSelect.value = 'yoga';
      fireChange(typeSelect);
      assert.equal(byClass(root, 'intensity-field').length, 0, '瑜伽没有档位，强度下拉应收回');
      assert.equal(hintText(), '估算 51 kcal（瑜伽 · 30 分钟 · 净消耗）', `换类型后文案不对：${hintText()}`);
    });

    await checkAsync('exercise 估算走净消耗口径：同一输入小于旧的 met×kg×h', async () => {
      const root = await renderView('exercise');
      const hintText = () => byClass(root, 'estimate-hint')[0].textOf();
      const typeSelect = byClass(root, 'type-field')[0].walk().find((n) => n.tagName === 'select');
      const minutes = root.walk().find((n) => n.tagName === 'input' && n.type === 'number');
      minutes.value = '30';
      fireInput(minutes);
      typeSelect.value = 'bike';
      fireChange(typeSelect);

      const net = nutrition.estimateBurn({ type: 'bike', minutes: 30, weightKg: SEED.weightKg, intensity: 'road' });
      const gross = Math.round(nutrition.exerciseMet('bike', 'road') * SEED.weightKg * 0.5);
      assert.equal(net, 239, `净消耗应为 (8−1)×68.4×0.5 = 239：${net}`);
      assert.equal(gross, 274, `旧口径应为 8×68.4×0.5 = 274：${gross}`);
      assert.ok(net < gross, `净消耗 ${net} 必须小于总消耗 ${gross}`);
      assert.equal(net, Math.round((nutrition.exerciseMet('bike', 'road') - 1) * SEED.weightKg * 0.5), '净消耗公式应扣掉 1 个 MET');
      assert.ok(hintText().includes('239'), `页面估算没有用净消耗：${hintText()}`);
      assert.ok(!hintText().includes('274'), `页面出现的还是旧口径的总额：${hintText()}`);
      assert.ok(hintText().includes('净消耗'), '文案没有写明净消耗口径');
      assert.ok(nodeText(root).includes('不含基础代谢'), '页面顶部没有说明净消耗口径');
      assert.ok(nodeText(root).includes(`按当前体重 ${SEED.weightKg} kg`), '页面顶部没有写明估算用的体重');
    });

    await checkAsync('exercise 保存：类型 / 强度 / 净消耗一起落库，列表显示中文标签', async () => {
      const root = await renderView('exercise');
      const typeSelect = byClass(root, 'type-field')[0].walk().find((n) => n.tagName === 'select');
      const minutes = root.walk().find((n) => n.tagName === 'input' && n.type === 'number');
      minutes.value = '30';
      fireInput(minutes);
      typeSelect.value = 'bike';
      fireChange(typeSelect);
      const intensitySelect = byClass(root, 'intensity-field')[0].walk().find((n) => n.tagName === 'select');
      intensitySelect.value = 'spin';
      fireChange(intensitySelect);

      fireClick(findButton(root, '保存运动'));
      await tick(220);
      const after = await store.daySummary(today);
      const saved = after.exercises.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      assert.ok(saved, '保存后当天没有新增运动记录');
      assert.equal(saved.type, 'bike', '落库类型不对');
      assert.equal(saved.intensity, 'spin', 'intensity 没有一起落库');
      assert.equal(saved.minutes, 30, '落库时长不对');
      assert.equal(saved.kcalBurned, 257, `落库的应是净消耗估算值：${saved.kcalBurned}`);
      assert.ok(
        dom.body.childNodes.some((n) => String(n.className).split(/\s+/).includes('toast') && n.textOf().includes('运动已记录')),
        '保存后没有 toast 反馈',
      );

      const listed = await renderView('exercise');
      assert.ok(nodeText(listed).includes('骑行'), '列表没有显示中文类型标签');
      assert.ok(
        nodeText(listed).includes(nutrition.EXERCISE_TYPES.find((t) => t.value === 'bike').intensities.find((i) => i.value === 'spin').label),
        '列表没有带上档位名',
      );
      await store.deleteExercise(saved.id);
      assert.equal((await store.daySummary(today)).exercises.some((e) => e.id === saved.id), false, '收尾没有删掉测试记录');
    });

    await checkAsync('exercise 历史记录：旧 type 值（bike 等）仍渲染中文标签', async () => {
      const exerciseView = await import('../views/exercise.js');
      for (const legacyType of ['walk', 'jog', 'bike', 'swim', 'strength', 'other']) {
        const label = exerciseView.exerciseLabel(legacyType, '');
        assert.ok(label && !/[A-Za-z]/.test(label), `旧 type=${legacyType} 没有中文标签：${label}`);
      }
      assert.ok(exerciseView.exerciseLabel('bike', 'road').startsWith('骑行 · '), '带档位的记录应显示「类型 · 档位」');
      assert.equal(exerciseView.exerciseLabel('unknown-type', ''), '运动', '未知类型回落到「运动」');
      assert.equal(exerciseView.exerciseLabel('bike', 'not-a-real-intensity'), '骑行', '档位对不上时不硬贴一个名字');

      // 落一条旧形状的记录（type=bike，没有 intensity）：列表里仍要是「骑行」
      await store.logExercise({ date: today, type: 'bike', minutes: 20, kcalBurned: 100, note: '旧记录' });
      const root = await renderView('exercise');
      const text = nodeText(root);
      assert.ok(text.includes('骑行'), `旧记录 type=bike 没有中文标签：${text.slice(0, 300)}`);
      assert.ok(text.includes('旧记录'), '旧记录的备注没有渲染');
      assert.ok(!text.includes('bike ·'), '列表里漏出了英文 type 值');
      // 收尾：按备注找回这条（logExercise 返回的是 key，不是带 id 的记录）
      for (const row of (await store.daySummary(today)).exercises) {
        if (row.note === '旧记录') await store.deleteExercise(row.id);
      }
      assert.equal((await store.daySummary(today)).exercises.some((row) => row.note === '旧记录'), false, '收尾没有删掉旧记录用例');
    });

    // ---- 3.97 整日套餐入口：无套餐 + 当天 ≥2 餐也要可达 ----
    await checkAsync('food 整日套餐入口：无套餐且当天 ≥2 餐仍渲染，<2 餐整块不渲染', async () => {
      for (const template of await store.getMealTemplates()) await store.deleteMealTemplate(template.id);
      assert.equal((await store.getMealTemplates()).length, 0, '起点应是「一个套餐都没有」');
      const summary = await store.daySummary(today);
      assert.ok(summary.meals.length >= 2, `种子数据当天应已有 ≥2 餐：${summary.meals.length}`);

      const root = await renderView('food');
      const text = nodeText(root);
      assert.equal(byClass(root, 'template-card').length, 1, '无套餐 + 当天 ≥2 餐时应渲染套餐卡片');
      assert.ok(text.includes('整日套餐'), '卡片标题应为「整日套餐」而不是空无内容的「常吃套餐」');
      assert.ok(!text.includes('常吃套餐'), '一个套餐都没有时不该说「常吃套餐」');
      assert.ok(findButton(root, '把今天存为整日套餐'), '整日套餐卡片缺少「把今天存为整日套餐」入口');
      assert.equal(byClass(root, 'tpl-chip').length, 0, '没有套餐时不该有 chip');

      // 翻到前一天（一餐都没有）：整块不渲染
      fireClick(findButton(root, '‹ 前一天'));
      await tick(300);
      const yesterdayText = nodeText(root);
      assert.ok(yesterdayText.includes('这一天还没有饮食记录'), `没翻到前一天：${yesterdayText.slice(0, 160)}`);
      assert.equal(byClass(root, 'template-card').length, 0, '当天 <2 餐时不该渲染套餐卡片');
      assert.ok(!yesterdayText.includes('整日套餐'), '当天 <2 餐时不该出现「整日套餐」');
      assert.ok(!findButton(root, '把今天存为整日套餐'), '当天 <2 餐时不该出现存入口');
      assert.ok(!yesterdayText.includes('常吃套餐'), '当天 <2 餐时不该出现「常吃套餐」');
    });

    // ---- 4. 空数据态：不能白屏、不能 NaN ----
    await checkAsync('空数据时 dashboard 不白屏', async () => {
      await store.clearAllData();
      const root = await renderView('dashboard');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '空数据时根节点没有子元素');
      assertNoLeak(text, 'dashboard(空)');
      for (const needle of ['还没有体重记录', '今天还没有饮食记录', '今日总览']) {
        assert.ok(text.includes(needle), `空状态缺少「${needle}」`);
      }
    });

    await checkAsync('空数据时 weight 不白屏', async () => {
      const root = await renderView('weight');
      const text = nodeText(root);
      assert.ok(root.childNodes.length > 0, '空数据时根节点没有子元素');
      assertNoLeak(text, 'weight(空)');
      assert.ok(text.includes('还没有体重数据') || text.includes('暂无历史记录'), '空状态缺少引导文案');
      assert.ok(text.includes('保存体重'), '空状态仍应能录入');
    });

    await checkAsync('空数据时 water / exercise / food 同样可用', async () => {
      for (const name of ['water', 'exercise', 'food']) {
        const root = await renderView(name);
        assertNoLeak(nodeText(root), `${name}(空)`);
        assert.ok(root.childNodes.length > 0, `${name} 空数据时白屏`);
      }
    });
  } finally {
    if (urlSnapshot) {
      if (typeof urlSnapshot.create === 'function') URL.createObjectURL = urlSnapshot.create;
      else delete URL.createObjectURL;
      if (typeof urlSnapshot.revoke === 'function') URL.revokeObjectURL = urlSnapshot.revoke;
      else delete URL.revokeObjectURL;
    }
    // 先让 db.js 丢掉缓存的连接，再还原全局，否则后续套件会拿到这个假数据库。
    try {
      const database = await db.openDb();
      if (database && typeof database.onversionchange === 'function') database.onversionchange();
    } catch {
      /* 连不上就不用重置 */
    }
    restoreGlobals(snapshot);
  }

  const result = { passed, failed: failures.length, failures };
  console.log(`[ui.smoke] passed=${result.passed} failed=${result.failed}`);
  for (const failure of result.failures) console.log(`  FAIL ${failure.name}: ${failure.error}`);
  return result;
}

const isMain = (() => {
  try {
    const entry = process?.argv?.[1];
    return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = await run();
  if (result.failed > 0) process.exitCode = 1;
}
