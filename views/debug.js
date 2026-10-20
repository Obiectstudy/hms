// 自检页（SPEC §10.2）。这是唯一直接调用 js/db.js 的视图：
// 「五个 store 读写删」需要 store 层之下的原语，其余视图仍只走 store。
import { el, toast, confirmDialog } from '../js/ui.js';
import { localDateStr } from '../js/nutrition.js';
import { openDb, put, get, del, getAllByIndex, getOneByIndex } from '../js/db.js';
import { daySummary, exportJSON, importJSON, clearAllData } from '../js/store.js';

// 探针日期放在 2099，避免碰到任何真实记录。
const PROBE_DATE = '2099-01-01';
const BACKUP_KEY = 'hms.debugBackup';

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function resultRow() {
  const name = el('div', { className: 'strong', text: '' });
  const meta = el('div', { className: 'list__item--meta', text: '等待运行' });
  const badge = el('span', { className: 'pill', text: '—' });
  const node = el('div', { className: 'list__item' },
    el('div', { className: 'list__item--main' }, name, meta),
    badge,
  );
  return {
    node,
    start(label) {
      name.textContent = label;
      meta.textContent = '运行中…';
      badge.className = 'pill';
      badge.textContent = '…';
    },
    done(ok, ms, detail) {
      badge.className = `pill ${ok ? 'pill--ok' : 'pill--warn'}`;
      badge.textContent = ok ? 'PASS' : 'FAIL';
      meta.textContent = `${ok ? '通过' : '失败'} · ${Math.round(ms)} ms${detail ? ' · ' + detail : ''}`;
    },
  };
}

function prewarm(store, value) {
  // 上次异常退出可能留下探针，先清掉，避免唯一索引冲突。
  return getOneByIndex(store, 'by_date', value).then((hit) => (hit ? del(store, hit.id) : null)).catch(() => null);
}

async function checkDbOpen() {
  const db = await openDb();
  if (!db) throw new Error('openDb 没有返回数据库');
  const missing = ['meta', 'weights', 'meals', 'exercises', 'waters', 'photos']
    .filter((name) => !db.objectStoreNames.contains(name));
  if (missing.length) throw new Error(`缺少 store：${missing.join(', ')}`);
  return `版本 ${db.version}，store 齐全`;
}

async function checkStores() {
  const passed = [];

  await put('meta', { key: '__debug', value: { at: Date.now() } });
  const meta = await get('meta', '__debug');
  if (!meta || !meta.value) throw new Error('meta 读回失败');
  await del('meta', '__debug');
  if (await get('meta', '__debug')) throw new Error('meta 删除失败');
  passed.push('meta');

  await prewarm('weights', PROBE_DATE);
  const weightId = await put('weights', { date: PROBE_DATE, weightKg: 66.6, createdAt: Date.now() });
  const weight = await getOneByIndex('weights', 'by_date', PROBE_DATE);
  if (!weight || Math.abs(Number(weight.weightKg) - 66.6) > 0.01) throw new Error('weights 读回失败');
  await del('weights', weightId);
  if (await getOneByIndex('weights', 'by_date', PROBE_DATE)) throw new Error('weights 删除失败');
  passed.push('weights');

  const mealId = await put('meals', { date: PROBE_DATE, slot: 'snack', items: [], source: 'manual', createdAt: Date.now() });
  const meals = await getAllByIndex('meals', 'by_date', PROBE_DATE);
  if (!Array.isArray(meals) || !meals.length) throw new Error('meals 读回失败');
  await del('meals', mealId);
  if ((await getAllByIndex('meals', 'by_date', PROBE_DATE)).length) throw new Error('meals 删除失败');
  passed.push('meals');

  const exerciseId = await put('exercises', { date: PROBE_DATE, type: 'walk', minutes: 1, kcalBurned: 1, createdAt: Date.now() });
  const exercises = await getAllByIndex('exercises', 'by_date', PROBE_DATE);
  if (!Array.isArray(exercises) || !exercises.length) throw new Error('exercises 读回失败');
  await del('exercises', exerciseId);
  if ((await getAllByIndex('exercises', 'by_date', PROBE_DATE)).length) throw new Error('exercises 删除失败');
  passed.push('exercises');

  await prewarm('waters', PROBE_DATE);
  const waterId = await put('waters', { date: PROBE_DATE, ml: 1 });
  const water = await getOneByIndex('waters', 'by_date', PROBE_DATE);
  if (!water || Number(water.ml) !== 1) throw new Error('waters 读回失败');
  await del('waters', waterId);
  if (await getOneByIndex('waters', 'by_date', PROBE_DATE)) throw new Error('waters 删除失败');
  passed.push('waters');

  return passed.join(' / ');
}

async function checkDaySummary() {
  const date = localDateStr();
  const summary = await daySummary(date);
  if (!summary || typeof summary !== 'object') throw new Error('daySummary 没有返回对象');
  for (const key of ['kcal', 'carb', 'protein', 'fat']) {
    if (!Number.isFinite(Number(summary.intake && summary.intake[key]))) {
      throw new Error(`intake.${key} 不是数字`);
    }
  }
  if (!Array.isArray(summary.meals) || !Array.isArray(summary.exercises)) throw new Error('meals/exercises 不是数组');
  if (!Number.isFinite(Number(summary.water))) throw new Error('water 不是数字');
  const expectedNet = Number(summary.intake.kcal) - Number(summary.burned);
  if (Math.abs(Number(summary.netKcal) - expectedNet) > 1) {
    throw new Error(`netKcal 不一致（${summary.netKcal} vs ${expectedNet}）`);
  }
  return `${date} · 摄入 ${summary.intake.kcal} kcal · 饮水 ${summary.water} ml · 餐次 ${summary.meals.length}`;
}

async function checkServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker');
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('尚未注册，刷新一次页面后再试');
  const state = reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none';
  if (!reg.active) throw new Error(`状态 ${state}，刷新页面后再试`);
  return `scope ${reg.scope} · 受控：${navigator.serviceWorker.controller ? '是' : '否（刷新一次）'}`;
}

function checkDateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const actual = localDateStr();
  if (actual !== expected) throw new Error(`localDateStr=${actual}，系统=${expected}`);
  return actual;
}

function fingerprint(dump) {
  const sorted = (rows, keyFn) => (Array.isArray(rows) ? rows.map(keyFn).sort() : []);
  return JSON.stringify({
    weights: sorted(dump.weights, (r) => `${r.date}|${r.weightKg}|${r.bodyFatPct ?? ''}|${r.note ?? ''}`),
    meals: sorted(dump.meals, (r) => `${r.date}|${r.slot}|${r.source}|${(r.items || []).length}|${(r.items || []).reduce((s, i) => s + Number(i.kcal || 0), 0)}`),
    exercises: sorted(dump.exercises, (r) => `${r.date}|${r.type}|${r.minutes}|${r.kcalBurned}`),
    waters: sorted(dump.waters, (r) => `${r.date}|${r.ml}`),
  });
}

async function runChecks(rows, runButton) {
  const checks = [
    ['IndexedDB 打开', checkDbOpen],
    ['五个 store 读写删', checkStores],
    ['daySummary 聚合', checkDaySummary],
    ['Service Worker 注册', checkServiceWorker],
    ['localDateStr 与系统日期一致', checkDateStr],
  ];
  runButton.disabled = true;
  try {
    for (const [label, fn] of checks) {
      const row = resultRow();
      rows.appendChild(row.node);
      row.start(label);
      const t0 = now();
      try {
        const detail = await fn();
        row.done(true, now() - t0, detail);
      } catch (err) {
        row.done(false, now() - t0, err && err.message ? err.message : String(err));
      }
    }
  } finally {
    runButton.disabled = false;
  }
}

export async function render(root) {
  root.appendChild(el('div', { className: 'row row--between' },
    el('div', { className: 'col' },
      el('div', { className: 'h1', text: '自检' }),
      el('div', { className: 'muted', text: '逐项验证存储、聚合、离线与日期' }),
    ),
    el('button', { className: 'btn btn--ghost btn--sm', text: '返回设置', onClick: () => window.HMS.navigate('#/settings') }),
  ));

  const rows = el('div', { className: 'list' });
  const runBtn = el('button', { className: 'btn btn--primary btn--block', text: '运行自检（安全项）' });
  runBtn.addEventListener('click', () => runChecks(rows, runBtn));

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '自动检查' }),
      el('div', { className: 'muted', text: '不修改真实数据' }),
    ),
    runBtn,
    rows,
  ));

  // 往返测试会临时清空并恢复，单独按钮 + 二次确认，避免误触丢数据。
  const roundRows = el('div', { className: 'list' });
  const roundBtn = el('button', { className: 'btn btn--ghost btn--block', text: '运行导出 → 清空 → 导入往返测试' });
  roundBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '运行往返测试？',
      message: '会先导出全部记录，再清空并立即用这份导出恢复。备份 JSON 不含照片，照片会被清除。若恢复失败，页面会把备份留在本机 localStorage（hms.debugBackup），可据此手动恢复。',
      okText: '开始测试',
    });
    if (!ok) return;
    roundBtn.disabled = true;
    const row = resultRow();
    roundRows.appendChild(row.node);
    row.start('导出 → 清空 → 导入');
    const t0 = now();
    let backup = null;
    let stored = false;
    try {
      backup = await exportJSON();
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
        stored = true;
      } catch {
        // 隐私模式下 localStorage 可能不可用，内存里的 backup 仍然有效。
      }
      await clearAllData();
      await importJSON(backup, 'replace');
      const after = await exportJSON();
      const a = fingerprint(backup);
      const b = fingerprint(after);
      if (a !== b) throw new Error('往返后数据不一致（详见浏览器控制台）');
      if (stored) localStorage.removeItem(BACKUP_KEY);
      row.done(true, now() - t0, '各表内容一致');
      toast('往返测试通过', 'ok');
    } catch (err) {
      row.done(false, now() - t0, err && err.message ? err.message : String(err));
      toast('往返测试失败，备份已保留', 'error');
    } finally {
      roundBtn.disabled = false;
    }
  });

  const restoreBtn = el('button', { className: 'btn btn--ghost btn--block', text: '用本机备份恢复数据' });
  restoreBtn.addEventListener('click', async () => {
    let raw = null;
    try {
      raw = localStorage.getItem(BACKUP_KEY);
    } catch {
      raw = null;
    }
    if (!raw) {
      toast('本机没有备份（只有往返测试失败时才会留下）', 'error');
      return;
    }
    const ok = await confirmDialog({ title: '用备份覆盖当前数据？', message: '会用本机备份覆盖现有记录。', okText: '恢复' });
    if (!ok) return;
    try {
      const parsed = JSON.parse(raw);
      await importJSON(parsed, 'replace');
      toast('已用备份恢复', 'ok');
      await window.HMS.refresh();
    } catch (err) {
      toast(`恢复失败：${err && err.message ? err.message : err}`, 'error');
    }
  });

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__head', style: { marginBottom: '0' } },
      el('div', { className: 'card__title', text: '数据往返' }),
      el('div', { className: 'pill pill--warn', text: '会临时清空' }),
    ),
    el('div', { className: 'muted', text: '验证「导出 JSON → 清空 → 导入」后各表内容一致。运行前请确认已导出过备份。' }),
    roundBtn,
    roundRows,
    el('div', { className: 'divider' }),
    restoreBtn,
  ));

  root.appendChild(el('div', { className: 'card col' },
    el('div', { className: 'card__title', text: '人工确认项' }),
    el('div', { className: 'muted', text: '以下只能在真机上肉眼确认：底部安全区是否留白、拍照是否唤起相机、识别结果数字是否合理、添加到主屏幕后图标与名称、断网后能否打开。' }),
  ));
}
