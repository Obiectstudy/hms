/* HMS Service Worker：预缓存全部静态资源，保证断网可打开。
   改任何文件都要同时改 CACHE_NAME 的版本号，否则用户拿到的是旧缓存。
   所有路径均为相对路径：站点可能挂在 GitHub Pages 的子路径下。 */

const CACHE_NAME = 'hms-v1.0.27';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './js/db.js',
  './js/store.js',
  './js/nutrition.js',
  './js/vision.js',
  './js/pure.js',
  './js/foods.js',
  './js/ui.js',
  './js/update.js',
  './views/dashboard.js',
  './views/weight.js',
  './views/food.js',
  './views/exercise.js',
  './views/water.js',
  './views/settings.js',
  './js/accounts.js',
  './js/sync.js',
  './js/cloud-config.js',
  './js/cloud-api.js',
  './js/cloud-transport.js',
  './views/account.js',
  './views/debug.js',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon.svg',
];

// 单个资源失败（例如图标还没部署）不应连累整份缓存，否则 SW 直接装不上。
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    const failed = results
      .map((result, index) => (result.status === 'rejected' ? PRECACHE[index] : null))
      .filter(Boolean);
    if (failed.length) console.warn('[HMS SW] 预缓存失败：', failed.join(', '));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 跨域请求（DashScope 识别接口）不经过缓存，避免把 API 响应留在本地。
  if (url.origin !== self.location.origin) return;

  // 导航请求走网络优先：更新即时可见，断网时回落到缓存的 index.html。
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (error) {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('./index.html') || await cache.match('./');
        return cached || Response.error();
      }
    })());
    return;
  }

  // 静态资源缓存优先：离线可用的前提，版本更新靠 CACHE_NAME 换代。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch (error) {
      return Response.error();
    }
  })());
});
