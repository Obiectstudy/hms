// 用 Chrome DevTools Protocol 打开页面：抓控制台错误、等渲染、截图。
// 用法：node shoot.mjs <url> <outPng> [width] [height] [waitMs]
const url = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] || 390);
const height = Number(process.argv[5] || 844);
const waitMs = Number(process.argv[6] || 6000);
const preloadPath = process.argv[7] ? String(process.argv[7]) : null;
const probeExpr = process.argv[8] ? String(process.argv[8]) : null;
const shotDelay = Number(process.argv[9] || 600);
const fs = await import('node:fs/promises');

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('NO_TARGET'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
const logs = [];

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((res, rej) => {
    pending.set(msgId, { res, rej });
    setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error('timeout ' + method)); } }, 30000);
  });
}

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description || ''}`.trim().slice(0, 400));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    logs.push(`[log] ${m.params.entry.text}`.slice(0, 300));
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
if (preloadPath) {
  const source = await fs.readFile(preloadPath, 'utf8');
  await send('Page.addScriptToEvaluateOnNewDocument', { source });
}
await send('Page.navigate', { url });

// 等 #view 有内容（或超时）
const deadline = Date.now() + waitMs;
let rendered = false;
let viewLen = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const v = document.querySelector('#view'); return JSON.stringify({ n: v ? v.childElementCount : -1, len: v ? v.innerHTML.length : 0, title: document.title, body: document.body.innerText.slice(0,80) }); })()`,
      returnByValue: true,
    });
    const info = JSON.parse(r.result.value || '{}');
    viewLen = info.len || 0;
    if (info.n > 0 && viewLen > 200) { rendered = true; break; }
  } catch { /* 页面可能正在导航 */ }
}

await new Promise((r) => setTimeout(r, shotDelay));
const shot = await send('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(out, Buffer.from(shot.data, 'base64'));

let probe = null;
if (probeExpr) {
  try {
    const r = await send('Runtime.evaluate', { expression: probeExpr, returnByValue: true, awaitPromise: true });
    probe = r.result.value;
  } catch (e) { probe = 'PROBE_ERR ' + String(e).slice(0, 100); }
}
let installCalled = false;
try {
  const r = await send('Runtime.evaluate', { expression: 'typeof window.__installCalledWith', returnByValue: true });
  installCalled = r.result.value !== 'undefined';
} catch {}
console.log(JSON.stringify({ rendered, viewLen, installCalled, probe, errors, logs: logs.slice(0, 6) }, null, 1));
ws.close();
