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
    replaceChildren(...kids) { this.childNodes = []; for (const kid of kids) this.appendChild(kid); }
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
      assert.ok(text.includes('米饭'), '缺少今日餐次里的食物名');
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
