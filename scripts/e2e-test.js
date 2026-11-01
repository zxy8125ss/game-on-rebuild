/**
 * Game On 复刻版端到端自测
 * 用 CDP 直连本机 Chrome（无需 playwright），验证真实浏览器行为。
 *
 * 覆盖：
 *   - 首屏渲染 / 赛程数据加载
 *   - 筛选（全部↔关注、项目筛选）、搜索
 *   - 关注匹配、关注项增删
 *   - 本周推荐板、下一场关注票根
 *   - 展开详情、ICS 日历导出内容
 *   - Service Worker 注册 + App Shell 预缓存
 *   - 断网后仍能打开（这是原版缺失的关键能力）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.PORT || 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9334;
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameon-chrome-'));

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

  /* ---------- 1. 首屏 ---------- */
  await send('Page.navigate', { url: BASE + '/index.html' }, sessionId);
  await sleep(3000);

  const title = await evaluate(sessionId, 'document.title');
  check('页面标题正确', title.includes('Game On'), title);

  const shell = await evaluate(sessionId, `({
    logo: !!document.querySelector('.logo'),
    clock: document.getElementById('clock').textContent,
    sync: document.getElementById('sync').textContent,
    nextHero: !!document.querySelector('#next .tk'),
    weekRows: document.querySelectorAll('#wk .wr').length,
    listRows: document.querySelectorAll('#list .row').length,
    chips: document.querySelectorAll('#wk .chip').length,
  })`);
  check('顶栏与时钟渲染', shell.logo && /^\d\d:\d\d$/.test(shell.clock), '时钟=' + shell.clock);
  check('本周推荐板 7 天', shell.weekRows === 7, shell.weekRows + ' 行');
  check('下一场关注票根存在', shell.nextHero);
  check('赛程列表有内容', shell.listRows > 0, shell.listRows + ' 条');
  check('推荐 chip 有内容', shell.chips > 0, shell.chips + ' 个');
  check('数据源状态已显示', shell.sync.length > 0, shell.sync);

  /* ---------- 2. 数据真实加载（不是内置假数据） ---------- */
  const dataCheck = await evaluate(sessionId, `(async () => {
    const r = await fetch('data/schedule.json?t=' + Date.now());
    const d = await r.json();
    return { n: d.matches.length, updated: d.updatedAt, sports: [...new Set(d.matches.map(m=>m.sport))] };
  })()`);
  check('schedule.json 可访问且非空', dataCheck.n > 0, dataCheck.n + ' 场 / ' + dataCheck.updated);
  check('覆盖多个项目', dataCheck.sports.length >= 2, dataCheck.sports.join(','));

  /* ---------- 3. 筛选：全部 ↔ 关注 ---------- */
  const beforeFollow = await evaluate(sessionId, `document.querySelectorAll('#list .row').length`);
  await evaluate(sessionId, `document.querySelector('#seg-view [data-v="all"]').click(); true`);
  await sleep(400);
  const afterAll = await evaluate(sessionId, `document.querySelectorAll('#list .row').length`);
  check('切到「全部」后条数增加', afterAll >= beforeFollow, `${beforeFollow} → ${afterAll}`);

  await evaluate(sessionId, `document.querySelector('#seg-view [data-v="follow"]').click(); true`);
  await sleep(400);
  const afterFollow = await evaluate(sessionId, `document.querySelectorAll('#list .row').length`);
  check('切回「关注」生效', afterFollow <= afterAll, `${afterAll} → ${afterFollow}`);

  /* ---------- 4. 项目筛选 ---------- */
  await evaluate(sessionId, `document.querySelector('#seg-sport [data-s="football"]').click(); true`);
  await sleep(500);
  const fbOnly = await evaluate(sessionId, `({
    rows: document.querySelectorAll('#list .row').length,
    allFootball: [...document.querySelectorAll('#list .row')].every(r => r.querySelector('use[href="#i-football"]'))
  })`);
  check('项目筛选生效（足球）', fbOnly.rows > 0 && fbOnly.allFootball, fbOnly.rows + ' 条');

  await evaluate(sessionId, `document.querySelector('#seg-sport [data-s="all"]').click(); true`);
  await sleep(400);

  /* ---------- 5. 搜索 ---------- */
  await evaluate(sessionId, `document.getElementById('b-search').click(); true`);
  await sleep(200);
  await evaluate(sessionId, `(() => {
    const q = document.getElementById('q');
    q.value = '利物浦';
    q.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  await sleep(600);
  const searchResult = await evaluate(sessionId, `({
    rows: document.querySelectorAll('#list .row').length,
    head: document.querySelector('#list .lh')?.textContent || '',
    allMatch: [...document.querySelectorAll('#list .row .title')].every(t => t.textContent.includes('利物浦'))
  })`);
  check('搜索返回结果', searchResult.rows > 0, searchResult.head.trim());
  check('搜索结果全部相关', searchResult.allMatch);

  await evaluate(sessionId, `document.getElementById('b-search-x').click(); true`);
  await sleep(400);

  /* ---------- 6. 展开详情 ---------- */
  // 挑一场「未结束」的比赛来展开：已结束的比赛不显示「加到日历」按钮
  const openTarget = await evaluate(sessionId, `(() => {
    const rows = [...document.querySelectorAll('#list .row')];
    const row = rows.find(r => r.querySelector('[data-open]')) || rows[0];
    const id = row.getAttribute('data-open');
    row.click();
    return id;
  })()`);
  await sleep(600);
  const expanded = await evaluate(sessionId, `({
    hasMore: !!document.querySelector('#list .row .more'),
    icsBtn: !!document.querySelector('#list [data-ics]'),
    gcalBtn: !!document.querySelector('#list [data-gcal]'),
    copyBtn: !!document.querySelector('#list [data-copy]'),
    watchedBtn: !!document.querySelector('#list [data-watched]'),
    hideBtn: !!document.querySelector('#list [data-hide]'),
  })`);
  check('点开显示详情面板', expanded.hasMore, openTarget);
  check('详情内有日历/复制/已看/隐藏按钮',
    expanded.icsBtn && expanded.gcalBtn && expanded.copyBtn && expanded.watchedBtn && expanded.hideBtn,
    JSON.stringify(expanded));

  /* ---------- 7. ICS 内容正确性 ---------- */
  const ics = await evaluate(sessionId, `(async () => {
    const mod = await import('./js/calendar.js');
    const res = await fetch('data/schedule.json');
    const d = await res.json();
    // 必须用 normalize 后的对象：buildICS 依赖 start/end/known
    const { normalize } = await import('./js/model.js');
    const m = d.matches.map(normalize).find(x => x.known && !x.result);
    return mod.buildICS(m, 15);
  })()`);
  check('ICS 结构完整',
    ics.startsWith('BEGIN:VCALENDAR') && ics.includes('BEGIN:VEVENT') && ics.trim().endsWith('END:VCALENDAR'));
  check('ICS 含开赛时间', /DTSTART:\d{8}T\d{6}Z/.test(ics), (ics.match(/DTSTART:[^\r\n]+/) || [])[0]);
  check('ICS 含 VALARM 提醒', ics.includes('BEGIN:VALARM') && ics.includes('TRIGGER:-PT15M'));
  check('ICS 行尾用 CRLF', ics.includes('\r\n'));

  /* ---------- 8. 关注管理 ---------- */
  const followCount = await evaluate(sessionId, `(() => {
    const btn = document.getElementById('b-follow');
    btn.click();
    return document.querySelectorAll('#flist .fitem').length;
  })()`);
  check('关注列表已渲染', followCount > 0, followCount + ' 项');

  const addFollow = await evaluate(sessionId, `(() => {
    const n = document.getElementById('fl-name');
    n.value = '测试关注项';
    const al = document.getElementById('fl-alias');
    al.value = '测试别名';
    document.getElementById('f-follow').requestSubmit();
    return document.querySelectorAll('#flist .fitem').length;
  })()`);
  check('新增关注成功', addFollow === followCount + 1, `${followCount} → ${addFollow}`);

  const persisted = await evaluate(sessionId, `(() => {
    const s = JSON.parse(localStorage.getItem('gameon-state-v1') || '{}');
    return (s.follows || []).length;
  })()`);
  check('关注已持久化到 localStorage', persisted === addFollow, `${persisted} 项`);

  await evaluate(sessionId, `document.querySelector('#d-follow').close(); true`);

  /* ---------- 9. Service Worker ---------- */
  const swState = await evaluate(sessionId, `(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? (reg.active ? 'active' : reg.installing ? 'installing' : 'waiting') : 'none';
  })()`);
  check('Service Worker 已注册', swState === 'active' || swState === 'installing', swState);

  await sleep(2500);
  const cached = await evaluate(sessionId, `(async () => {
    const names = await caches.keys();
    let all = [];
    for (const n of names) {
      const c = await caches.open(n);
      const keys = await c.keys();
      all.push(...keys.map(k => new URL(k.url).pathname));
    }
    return { names, all, count: all.length };
  })()`);
  check('缓存已建立', cached.count > 8, `${cached.count} 个条目 @ ${cached.names.join(',')}`);
  check('应用外壳已预缓存',
    cached.all.some(p => p.endsWith('/index.html'))
    && cached.all.some(p => p.endsWith('/js/app.js'))
    && cached.all.some(p => p.endsWith('/css/styles.css')));
  check('赛程数据已缓存', cached.all.some(p => p.includes('schedule.json')));

  /* ---------- 10. 断网仍能打开（关键能力） ---------- */
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  }, sessionId);
  await sleep(500);

  await send('Page.navigate', { url: BASE + '/index.html', params: {} }, sessionId);
  await sleep(3000);

  const offline = await evaluate(sessionId, `({
    rows: document.querySelectorAll('#list .row').length,
    weekRows: document.querySelectorAll('#wk .wr').length,
    offlineBadge: !document.getElementById('b-offline').hidden,
    badgeText: document.getElementById('b-offline').textContent,
    bodyText: document.body.innerText.slice(0, 80),
  })`);
  check('❗断网后页面仍能打开', offline.weekRows === 7 && offline.rows > 0,
    `${offline.weekRows} 天 / ${offline.rows} 条`);
  check('❗断网状态有明确指示', offline.offlineBadge, '徽标=' + offline.badgeText);

  const shotOffline = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '02-offline.png'), Buffer.from(shotOffline.data, 'base64'));

  /* ---------- 11. 恢复网络 ---------- */
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }, sessionId);
  await evaluate(sessionId, `window.dispatchEvent(new Event('online')); true`);
  await sleep(1500);
  const backOnline = await evaluate(sessionId, `document.getElementById('b-offline').hidden`);
  check('恢复网络后离线徽标隐藏', backOnline === true);

  /* ---------- 12. 截图 ---------- */
  await send('Page.navigate', { url: BASE + '/index.html' }, sessionId);
  await sleep(2500);
  await evaluate(sessionId, `document.getElementById('b-search-x')?.click(); true`);
  await sleep(300);
  const shot1 = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '01-mobile.png'), Buffer.from(shot1.data, 'base64'));

  await send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 1100, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await sleep(600);
  const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  fs.writeFileSync(path.join(OUT, '03-desktop.png'), Buffer.from(shot2.data, 'base64'));

  // 深色模式
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  }, sessionId);
  await sleep(500);
  const shot3 = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '04-dark.png'), Buffer.from(shot3.data, 'base64'));

  /* ---------- 汇总 ---------- */
  console.log('\n控制台错误:', consoleErrors.length ? consoleErrors : '无');
  const failed = results.filter((r) => !r.pass);
  console.log(`\n总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) failed.forEach((f) => console.log('  FAILED: ' + f.name + ' — ' + f.detail));

  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败无妨 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自测异常:', e.message);
  if (chrome) chrome.kill();
  process.exit(1);
});
