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

/**
 * 缓存版本号。
 * 改动图标 / JS / CSS 时必须同步 bump，否则 Service Worker 会继续用旧缓存，
 * 用户的手机上还是旧图标。图标变更时尤其重要 —— 浏览器会单独缓存图标。
 */
const VERSION = 'v3';
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
      .then((cache) => Promise.all(
        SHELL.map(async (url) => {
          // 逐个抓取并重试：单个资源失败不应让整个安装流程崩掉，
          // 但也不该静默留下空洞——重试一次仍失败才放弃这一项。
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const res = await fetch(new Request(url, { cache: 'reload' }));
              if (res.ok) {
                await cache.put(url, res);
                return true;
              }
            } catch (e) { /* 下面重试 */ }
          }
          return false;
        }),
      ))
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
      .then(() => self.clients.claim())
      // 首次访问时 SW 还没接管页面，页面发的 fetch 不经过 fetch handler，
      // 数据不会被缓存。这里主动预取一次，保证「装到桌面后立刻断网」也能用。
      .then(() => precacheData()),
  );
});

/**
 * 主动预取赛程数据进缓存。
 *
 * 注意路径：GitHub Pages 部署在子目录（如 /game-on-rebuild/），
 * 必须用相对路径 './data/...' 解析到 SW 作用域内。
 * 早先写成绝对路径 '/data/schedule.json' 会指向站点根目录，
 * 在子目录部署时 404，数据永远进不了缓存。
 */
async function precacheData() {
  const cache = await caches.open(DATA_CACHE);
  const files = ['./data/schedule.json', './data/catalog.json'];
  await Promise.all(files.map(async (path) => {
    const url = new URL(path, self.registration.scope).href;
    if (await cache.match(url)) return;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res && res.ok) await cache.put(url, res);
    } catch (e) { /* 网络不通就算了，等页面在线时再缓存 */ }
  }));
}

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
  // 关键：缓存 key 必须剥掉 query string。页面用 ?t=时间戳 防 HTTP 缓存，
  // 若把 query 带进缓存 key，每次时间戳变化都会 miss，离线时取不到数据。
  if (url.pathname.endsWith('/data/schedule.json') || url.pathname.endsWith('/data/catalog.json')) {
    const cacheKey = url.origin + url.pathname;
    // 拉干净 URL（不带 ?t=），让 HTTP 缓存也能正常工作，减少请求
    const cleanUrl = cacheKey;
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(cacheKey);
        const network = fetch(cleanUrl, { cache: 'no-cache' })
          .then((res) => {
            if (res && res.ok) cache.put(cacheKey, res.clone());
            return res;
          })
          .catch(() => null);
        if (cached) {
          network; // 后台更新，不阻塞响应
          return cached;
        }
        const fresh = await network;
        return fresh || new Response('{"matches":[]}', {
          headers: { 'Content-Type': 'application/json' },
        });
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
