/** 诊断：线上缓存里到底有什么，断网时数据从哪来 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.argv[2] || 'https://zxy8125ss.github.io/game-on-rebuild/';
const CDP_PORT = 9337;

let chrome, ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const p = { id, method, params };
  if (sessionId) p.sessionId = sessionId;
  ws.send(JSON.stringify(p));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'err');
  return r.result.value;
}

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameon-diag-'));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`, '--no-first-run', '--disable-gpu', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);

  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(5000);

  console.log('=== 在线时缓存清单 ===');
  console.log(await ev(sessionId, `(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(k => new URL(k.url).pathname + new URL(k.url).search);
    }
    return JSON.stringify(out, null, 1);
  })()`));

  console.log('\n=== 在线时 app 内部状态 ===');
  console.log(await ev(sessionId, `JSON.stringify({
    rows: document.querySelectorAll('#list .row').length,
    sync: document.getElementById('sync').textContent,
    controller: !!navigator.serviceWorker.controller
  })`));

  // 断网
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  await sleep(500);
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(4500);

  console.log('\n=== 断网后 ===');
  console.log(await ev(sessionId, `JSON.stringify({
    rows: document.querySelectorAll('#list .row').length,
    sync: document.getElementById('sync').textContent,
    controller: !!navigator.serviceWorker.controller
  })`));

  console.log('\n=== 断网后 fetch schedule.json 的实际返回 ===');
  console.log(await ev(sessionId, `(async () => {
    try {
      const r = await fetch('data/schedule.json?t=' + Date.now());
      const txt = await r.text();
      return 'HTTP ' + r.status + ' | fromSW=' + (!!r.headers.get('content-type')) + ' | 长度=' + txt.length + ' | 开头=' + txt.slice(0,120);
    } catch(e) { return 'fetch 失败: ' + e.message; }
  })()`));

  console.log('\n=== 断网后缓存清单 ===');
  console.log(await ev(sessionId, `(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(k => new URL(k.url).pathname);
    }
    return JSON.stringify(out, null, 1);
  })()`));

  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('异常:', e.message); if (chrome) chrome.kill(); process.exit(1); });
