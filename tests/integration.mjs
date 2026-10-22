/**
 * 集成闸门：不依赖浏览器，静态核对「文件是否齐全、import 是否解析、导出是否真实存在」。
 * Node 无 DOM/IndexedDB，所以这里只验证契约面，不验证渲染结果。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

const MODULES = [
  'app.js',
  'js/nutrition.js',
  'js/pure.js',
  'js/accounts.js',
  'js/sync.js',
  'js/cloud-config.js',
  'js/cloud-transport.js',
  'js/db.js',
  'js/store.js',
  'js/foods.js',
  'js/vision.js',
  'js/ui.js',
  'js/update.js',
  'views/dashboard.js',
  'views/weight.js',
  'views/food.js',
  'views/exercise.js',
  'views/water.js',
  'views/settings.js',
  'views/account.js',
  'views/debug.js',
];

const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))\s+from\s+['"]([^'"]+)['"]/g;

async function namedExportsOf(file) {
  const mod = await import(pathToFileURL(path.join(ROOT, file)).href);
  return new Set(Object.keys(mod));
}

export async function run() {
  const results = [];
  const add = (name, ok, detail = '') => results.push({ name, ok, detail });

  // 1. 文件齐备
  for (const f of MODULES) add(`文件存在: ${f}`, existsSync(path.join(ROOT, f)), existsSync(path.join(ROOT, f)) ? '' : '缺失');

  // 2. 每个模块都能被 import 且无顶层副作用抛错
  const exportsMap = {};
  for (const f of MODULES) {
    try {
      exportsMap[f] = await namedExportsOf(f);
      add(`import 成功: ${f}`, true, `${exportsMap[f].size} 个导出`);
    } catch (e) {
      add(`import 成功: ${f}`, false, String(e && e.message || e).slice(0, 180));
    }
  }

  // 3. 每个 import 的符号在目标模块里真实存在（跨边界契约）
  for (const f of MODULES) {
    let src = '';
    try { src = await readFile(path.join(ROOT, f), 'utf8'); } catch { continue; }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[5];
      if (!spec.startsWith('.')) continue;
      const target = rel(path.resolve(ROOT, path.dirname(f), spec));
      const targetExports = exportsMap[target] ?? new Set();
      const symbols = (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      // `import * as ns` / 默认导入不需要逐个核对符号，模块能 import 就成立
      const defaults = !m[2] ? [m[1] || m[4]].filter(Boolean) : [];
      for (const s of [...symbols, ...defaults]) {
        add(`${f} ← ${spec} 的 ${s}`, targetExports.has(s), targetExports.has(s) ? '' : `目标导出: ${[...targetExports].slice(0, 12).join(',')}`);
      }
    }
  }

  // 4. 视图契约：每个 views/*.js 导出 render
  for (const f of MODULES.filter((x) => x.startsWith('views/'))) {
    add(`视图导出 render: ${f}`, (exportsMap[f] ?? new Set()).has('render'), '');
  }
  add('app.js 导出 navigate/refresh', ['navigate', 'refresh'].every((k) => (exportsMap['app.js'] ?? new Set()).has(k)), '');

  // 5. index.html 引用的资源全部存在
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  for (const r of [...new Set(refs)]) add(`index.html 引用存在: ${r}`, existsSync(path.join(ROOT, r)), '');

  // 6. sw.js PRECACHE 与磁盘一一对应，且覆盖全部运行时模块
  const sw = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
  const block = sw.match(/PRECACHE\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const precache = [...block.matchAll(/['"](\.\/[^'"]*)['"]/g)].map((m) => m[1]);
  for (const p of precache) {
    const disk = p === './' ? '.' : p.replace(/^\.\//, '');
    add(`预缓存存在: ${p}`, existsSync(path.join(ROOT, disk)), '');
  }
  for (const f of MODULES) {
    const want = './' + f;
    add(`预缓存覆盖: ${f}`, precache.includes(want), precache.includes(want) ? '' : '未预缓存 → 离线会缺依赖');
  }
  add('CACHE_NAME 带版本', /CACHE_NAME\s*=\s*['"]hms-v[\d.]+['"]/.test(sw), '');

  // 7. manifest 合法性 + 图标可用 + maskable 存在
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    add('manifest 是合法 JSON', true, '');
  } catch (e) {
    add('manifest 是合法 JSON', false, String(e.message).slice(0, 120));
  }
  if (manifest) {
    add('manifest display=standalone', manifest.display === 'standalone', String(manifest.display));
    add('manifest start_url 相对', String(manifest.start_url ?? '').startsWith('./'), String(manifest.start_url));
    add('manifest scope 相对', String(manifest.scope ?? '').startsWith('./'), String(manifest.scope));
    for (const icon of manifest.icons ?? []) {
      add(`manifest 图标存在: ${icon.src}`, existsSync(path.join(ROOT, String(icon.src).replace(/^\.\//, ''))), '');
    }
    add('manifest 含 maskable 图标', (manifest.icons ?? []).some((i) => String(i.purpose ?? '').includes('maskable')), '');
  }

  // 8. 绝对路径检查（GitHub Pages 子路径必挂）
  for (const f of [...MODULES, 'index.html', 'styles.css']) {
    let src = '';
    try { src = await readFile(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const abs = f.endsWith('.html')
      ? [...src.matchAll(/(?:href|src)="(\/[^/][^"]*)"/g)].map((m) => m[1])
      : [...src.matchAll(/['"](\/(?!\/)[\w.-]+\/[\w./-]+)['"]/g)].map((m) => m[1]);
    add(`无绝对路径: ${f}`, abs.length === 0, abs.slice(0, 3).join(', '));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return { passed, failed, failures: results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.detail })), results };
}

const isMain = process.argv?.[1] && process.argv[1].endsWith('integration.mjs');
if (isMain) {
  const r = await run();
  for (const x of r.results) if (!x.ok) console.log(`FAIL  ${x.name}  ${x.detail}`);
  console.log(`\n集成闸门：${r.passed} passed / ${r.failed} failed`);
  if (r.failed) process.exitCode = 1;
}
