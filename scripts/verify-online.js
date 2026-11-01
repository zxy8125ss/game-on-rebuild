/**
 * 线上验证脚本：在真实 HTTPS 地址上验证 Service Worker 注册与离线能力。
 * 本地 localhost 通过不代表线上通过 —— SW 的安全上下文要求在生产环境才真正生效。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.argv[2] || 'https://zxy8125ss.github.io/game-on-rebuild/';
const CDP_PORT = 9336;
const OUT = path.join(__dirname, 'shots');

let chrome, ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameon-online-'));

  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox',
    '--window-size=430,932',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error('CDP 未就绪');

  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || 'exception');
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
  }, sessionId);

  /* ---------- 1. 线上加载 ---------- */
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(4000);

  const page = await evaluate(sessionId, `({
    title: document.title,
    secure: window.isSecureContext,
    rows: document.querySelectorAll('#list .row').length,
    weekRows: document.querySelectorAll('#wk .wr').length,
    chips: document.querySelectorAll('#wk .chip').length,
    sync: document.getElementById('sync').textContent,
    listHTML: document.getElementById('list').innerHTML.length,
  })`);

  check('线上页面加载', page.title.includes('Game On'), page.title);
  check('HTTPS 安全上下文', page.secure === true, 'isSecureContext=' + page.secure);
  check('赛程列表有内容', page.rows > 0, page.rows + ' 条');
  check('本周推荐板渲染', page.weekRows === 7, page.weekRows + ' 天');
  check('推荐 chip 渲染', page.chips > 0, page.chips + ' 个');
  check('数据源状态显示', page.sync.length > 0, page.sync);

  /* ---------- 2. Service Worker 在生产环境注册 ---------- */
  // SW 从 installing 到 active 需要时间，且数据缓存要等 SW 接管后才写入
  let sw = { state: 'none' };
  for (let i = 0; i < 30; i++) {
    sw = await evaluate(sessionId, `(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return { state: 'none' };
      return {
        state: reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'unknown',
        scope: reg.scope,
        controller: !!navigator.serviceWorker.controller,
      };
    })()`);
    if (sw.state === 'active') break;
    await sleep(1000);
  }
  check('线上 Service Worker 已激活', sw.state === 'active', JSON.stringify(sw));
  check('SW 作用域正确', sw.scope && sw.scope.includes('game-on-rebuild'), sw.scope);

  /* ---------- 3. 缓存内容 ---------- */
  // 等 SW 激活 + 数据缓存写入
  let cache = { names: [], count: 0, all: [] };
  for (let i = 0; i < 15; i++) {
    cache = await evaluate(sessionId, `(async () => {
      const names = await caches.keys();
      const all = [];
      for (const n of names) {
        const c = await caches.open(n);
        const keys = await c.keys();
        all.push(...keys.map(k => new URL(k.url).pathname));
      }
      return { names, count: all.length, all };
    })()`);
    if (cache.all.some((p) => p.includes('schedule.json'))) break;
    await sleep(1000);
  }
  check('线上缓存已建立', cache.count > 8, `${cache.count} 个 @ ${cache.names.join(',')}`);
  check('外壳与数据均已缓存',
    cache.all.some((p) => p.endsWith('/index.html'))
    && cache.all.some((p) => p.endsWith('/js/app.js'))
    && cache.all.some((p) => p.includes('schedule.json')),
    cache.all.filter((p) => p.includes('schedule') || p.endsWith('app.js') || p.endsWith('index.html')).join(', '));

  /* ---------- 4. 线上断网仍可用（核心能力） ---------- */
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  }, sessionId);
  await sleep(600);
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(4000);

  const offline = await evaluate(sessionId, `({
    rows: document.querySelectorAll('#list .row').length,
    weekRows: document.querySelectorAll('#wk .wr').length,
    badge: !document.getElementById('b-offline').hidden,
    badgeText: document.getElementById('b-offline').textContent,
    hasContent: document.getElementById('list').innerText.trim().length > 20,
  })`);
  check('❗线上断网后仍能打开', offline.weekRows === 7 && offline.rows > 0,
    `${offline.weekRows} 天 / ${offline.rows} 条`);
  check('❗线上断网有明确指示', offline.badge === true, '徽标=' + offline.badgeText);
  check('❗线上断网内容非空', offline.hasContent);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '05-online-offline.png'), Buffer.from(shot.data, 'base64'));

  /* ---------- 5. 恢复网络 ---------- */
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }, sessionId);
  await evaluate(sessionId, `window.dispatchEvent(new Event('online')); true`);
  await sleep(1500);
  const back = await evaluate(sessionId, `document.getElementById('b-offline').hidden`);
  check('恢复网络后徽标隐藏', back === true);

  /* ---------- 6. 线上截图 ---------- */
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(3000);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '06-online.png'), Buffer.from(shot2.data, 'base64'));

  console.log('\n控制台错误:', consoleErrors.length ? consoleErrors : '无');
  const failed = results.filter((r) => !r.pass);
  console.log(`\n线上验证 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) failed.forEach((f) => console.log('  FAILED: ' + f.name + ' — ' + f.detail));

  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* 清理失败无妨 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('线上验证异常:', e.message);
  if (chrome) chrome.kill();
  process.exit(1);
});
