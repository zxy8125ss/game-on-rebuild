/**
 * Service Worker —— 让 Game On 真正可以离线用。
 *
 * 原版仓库只有 manifest.webmanifest，没有 Service Worker：
 * 装到桌面后断网直接打不开，manifest 形同虚设。
 * 这里补上完整实现：
 *   - 应用外壳预缓存（HTML/CSS/JS/图标/字体）
 *   - 赛程数据 stale-while-revalidate —— 秒开同时后台更新
 *   - 导航请求网络优先、失败回落到外壳
 *   - 换版本时清掉旧缓存
 */

const VERSION = 'v1';
const SHELL_CACHE = `gameon-shell-${VERSION}`;
const DATA_CACHE = `gameon-data-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/time.js',
  './js/model.js',
  './js/store.js',
  './js/render.js',
  './js/calendar.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
  './icons/icon.svg',
  './fonts/barlow-condensed-latin-600-normal.woff2',
  './fonts/barlow-condensed-latin-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('gameon-') && k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data === 'clear-data') {
    event.waitUntil(caches.delete(DATA_CACHE));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先，断网回落到应用外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  // 赛程数据：stale-while-revalidate —— 先给缓存立刻渲染，后台再更新
  if (url.pathname.endsWith('/data/schedule.json') || url.pathname.endsWith('/data/catalog.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || network.then((r) => r || new Response('[]', {
          headers: { 'Content-Type': 'application/json' },
        }));
      }),
    );
    return;
  }

  // 静态资源：缓存优先
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
