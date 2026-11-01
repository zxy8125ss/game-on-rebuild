/**
 * Game On · 主应用
 *
 * 复刻自 zxy8125ss/Game-On，改进点：
 *   1. 真正可离线 —— 原版只有 manifest 没有 Service Worker，装到桌面后断网打不开
 *   2. 模块化 —— 原版 816 行单文件，拆成 time/model/store/render/calendar 五个模块
 *   3. 数据源换成 ESPN 官方公开接口（免费、无需 Key、原版依赖 Gemini）
 *   4. 离线状态显式可见，顶栏有指示器
 */

import { DAY, MIN, bjParts, dayKey, dayStart, hm, parseBJ, splitBJ, WEEKDAYS } from './time.js';
import { SPORTS, isLive, isOver, matchFollows, normalize } from './model.js';
import { Store } from './store.js';
import {
  compute, escapeHTML, renderList, renderNext, renderWeek, sportIcon,
} from './render.js';
import { downloadICS, googleCalendarURL, shareText } from './calendar.js';

const $ = (id) => document.getElementById(id);

/* 全局状态 */
const store = new Store();
let all = [];
let catalog = [];
let live = null;            // 服务端下发的最新赛程
let top = new Map();
let hiddenSet = new Set();
let scored = [];
let busy = false;
let fired = new Set();      // 已弹过提醒的场次，避免重复
let editing = null;
let installPrompt = null;

/* ---------- 节假日 ---------- */
// 2026 年法定节假日与调休（数据来自国务院办公厅安排）
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);
const MAKEUP = new Set(['2026-02-14', '2026-02-28', '2026-04-26', '2026-05-09', '2026-09-20', '2026-10-10']);

function holidayLabel(key) {
  if (HOLIDAYS.has(key)) return '假';
  if (MAKEUP.has(key)) return '班';
  return null;
}

/* ---------- 数据装载 ---------- */

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSchedule(manual = false) {
  try {
    const data = await fetchJSON(`data/schedule.json?t=${Date.now()}`);
    if (!data || !Array.isArray(data.matches)) throw new Error('数据格式不对');
    live = data;
    if (manual) showSync(`已刷新 · ${stampOf(data)}`);
    else showSync();
    render();
  } catch (e) {
    if (manual) showSync('刷新失败，请检查网络后再试');
  }
}

async function loadCatalog() {
  try {
    const data = await fetchJSON(`data/catalog.json?t=${Date.now()}`);
    if (data && Array.isArray(data.matches)) {
      catalog = data.matches;
      render();
    }
  } catch (e) { /* 目录是可选的，失败不影响主流程 */ }
}

function fmtStamp(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || '';
  const p = bjParts(t);
  return `${p.m}/${p.d} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

function stampOf(data) {
  if (!data) return '';
  const u = Date.parse(data.updatedAt || '');
  const r = Date.parse(data.review?.at || '');
  if (Number.isNaN(u) && Number.isNaN(r)) return '赛程数据：内置版本';
  if (!Number.isNaN(r) && (Number.isNaN(u) || r > u)) {
    return `赛程更新于 ${fmtStamp(data.review.at)}（人工复核）`;
  }
  return `赛程更新于 ${fmtStamp(data.updatedAt)}`;
}

function showSync(text) {
  $('sync').textContent = text || stampOf(live);
}

/* ---------- 赛程集合 ---------- */

function buildAll() {
  const base = [...(live?.matches || []), ...store.state.custom];
  const seen = new Set(base.map((m) => m.id));
  const pinned = new Set(store.state.pins || []);

  // catalog 里命中关注或被手动钉住的条目也并进来
  const extra = catalog.filter((c) => !seen.has(c.id)
    && (pinned.has(c.id) || matchFollows(c, store.state.follows).length > 0));

  return [...base, ...extra].map(normalize).sort((a, b) => a.start - b.start);
}

/* ---------- 渲染 ---------- */

function currentSpoilHidden(m) {
  const mark = store.state.marks[m.id] || {};
  return store.state.settings.spoiler && !mark.watched && !mark.reveal;
}

function render() {
  const now = Date.now();
  const ui = store.ui;

  hiddenSet = new Set(
    Object.entries(store.state.marks)
      .filter(([, v]) => v && v.hidden)
      .map(([k]) => k),
  );

  all = buildAll();
  for (const m of all) {
    m.f = matchFollows(m, store.state.follows);
    m.spoilHidden = currentSpoilHidden(m);
  }

  const computed = compute(all, store.state.follows, hiddenSet, now);
  scored = computed.all;
  top = computed.top;

  // 同步筛选按钮状态
  document.querySelectorAll('#seg-view button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.v === ui.view);
  });
  document.querySelectorAll('#seg-sport button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.s === ui.sport);
  });

  // 下一场关注
  $('next').innerHTML = renderNext(scored, top, now, store.state.follows.length > 0);

  // 本周推荐
  if (!ui.day) ui.day = dayKey(now);
  const week = renderWeek(scored, top, hiddenSet, now, ui.day);
  $('wk-range').textContent = week.range;
  $('wk').innerHTML = week.html;

  // 列表
  const list = renderList(scored, ui, store.state, now, top, hiddenSet, null);
  $('list').innerHTML = list.html;

  // 防剧透需要在 renderRow 内部判定，这里统一回填
  if (store.state.settings.spoiler) {
    $('list').innerHTML = renderList(scored, ui, store.state, now, top, hiddenSet, true).html;
  }

  store.saveUI();
  updateOfflineBadge();
}

/* ---------- 离线状态 ---------- */

function updateOfflineBadge() {
  const badge = $('b-offline');
  const offline = !navigator.onLine;
  badge.hidden = !offline;
  badge.classList.toggle('off', offline);
  badge.textContent = '离线';
}

function updateReminderLabel() {
  const banner = $('banner');
  if (!banner.hidden) banner.hidden = true;
}

/* ---------- 提醒 ---------- */

let audioCtx = null;

function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { /* 不支持就算了 */ }
}

function chime() {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    [[659.3, 0], [987.8, 0.18]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.18, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.9);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 1);
    });
  } catch (e) { /* 忽略 */ }
}

function checkReminders() {
  const now = Date.now();
  const lead = (store.state.settings.lead || 0) * MIN;
  if (!lead) return;

  for (const m of all) {
    if (!m.known || fired.has(m.id)) continue;
    if (store.state.marks[m.id]?.notified) continue;
    const mark = store.state.marks[m.id] || {};
    const remindOn = mark.remind === undefined ? m.f.length > 0 : mark.remind;
    if (!remindOn || hiddenSet.has(m.id)) continue;
    if (now >= m.start - lead && now < m.start) {
      fired.add(m.id);
      store.mark(m.id, { notified: true });
      const mins = Math.max(1, Math.ceil((m.start - now) / MIN));
      $('bannertext').textContent = `${m.title} ${mins} 分钟后开赛（${hm(m.start)}）`;
      $('banner').hidden = false;
      chime();
    }
  }
}

/* ---------- 交互 ---------- */

function goTo(id) {
  const m = scored.find((x) => x.id === id);
  if (!m) return;
  const ui = store.ui;
  ui.q = '';
  $('q').value = '';
  $('searchbar').hidden = true;
  $('filters').hidden = false;
  ui.day = dayKey(m.start);
  ui.open = id;
  // 如果目标比赛被当前筛选挡掉了，放宽筛选
  const pass = m.sport === ui.sport || ui.sport === 'all'
    || (ui.sport === 'cnfb' && m.squad);
  if (!pass || (ui.view === 'follow' && !m.f.length)) {
    ui.view = 'all';
    ui.sport = 'all';
  }
  render();
  const el = $('m-' + id);
  if (el) {
    el.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }
}

const splitList = (s) => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a, [data-open], [data-go]');
  if (!t) return;

  // 选中文本时不触发点击，避免复制文字时误展开
  if (t.tagName !== 'BUTTON' && t.tagName !== 'A') {
    const sel = window.getSelection && String(window.getSelection());
    if (sel && sel.trim()) return;
  }

  unlockAudio();
  if (t.tagName === 'A') return;

  const d = t.dataset;

  if (d.v) {
    store.ui.view = d.v;
    render();
  } else if (d.s) {
    store.ui.sport = d.s;
    render();
  } else if (d.day) {
    store.ui.day = d.day;
    store.ui.open = null;
    render();
    $('list').scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  } else if (d.go) {
    goTo(d.go);
  } else if (d.ics) {
    const m = scored.find((x) => x.id === d.ics);
    if (m) downloadICS(m, store.state.settings.lead);
  } else if (d.gcal) {
    const m = scored.find((x) => x.id === d.gcal);
    if (m) window.open(googleCalendarURL(m), '_blank', 'noopener');
  } else if (d.copy) {
    const m = scored.find((x) => x.id === d.copy);
    if (!m) return;
    const text = shareText(m);
    const done = () => {
      t.textContent = '已复制';
      setTimeout(() => { t.textContent = '复制信息'; }, 1500);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch (_) {
        t.textContent = '请长按文字复制';
      }
      ta.remove();
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch (_) {
      fallback();
    }
  } else if (d.remind) {
    const m = scored.find((x) => x.id === d.remind);
    if (m) {
      const mark = store.state.marks[m.id] || {};
      const on = mark.remind === undefined ? m.f.length > 0 : mark.remind;
      store.mark(m.id, { remind: !on });
    }
  } else if (d.watched) {
    const mark = store.state.marks[d.watched] || {};
    store.mark(d.watched, { watched: !mark.watched });
  } else if (d.reveal) {
    store.mark(d.reveal, { reveal: true });
  } else if (d.hide) {
    store.ui.open = null;
    store.mark(d.hide, { hidden: true });
  } else if (d.del) {
    store.state.custom = store.state.custom.filter((c) => c.id !== d.del);
    store.save();
    render();
  } else if (d.edit) {
    openAdd(store.state.custom.find((c) => c.id === d.edit));
  } else if (t.hasAttribute('data-close')) {
    t.closest('dialog').close();
  } else if (d.unf) {
    store.state.removed = [...new Set([...(store.state.removed || []), d.unf])];
    store.state.follows = store.state.follows.filter((f) => f.id !== d.unf);
    store.save();
    renderFollows();
    render();
  } else if (d.open) {
    store.ui.open = store.ui.open === d.open ? null : d.open;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  const d = e.target.dataset;
  if ((e.key === 'Enter' || e.key === ' ') && d && (d.open || d.go) && e.target.tagName === 'DIV') {
    e.preventDefault();
    e.target.click();
  }
});

/* 搜索 */
$('b-search').onclick = () => {
  $('filters').hidden = true;
  $('searchbar').hidden = false;
  $('q').focus();
};
$('b-search-x').onclick = () => {
  store.ui.q = '';
  $('q').value = '';
  $('searchbar').hidden = true;
  $('filters').hidden = false;
  render();
};
$('q').addEventListener('input', (e) => {
  store.ui.q = e.target.value;
  render();
});

/* 添加 / 编辑 */
function openAdd(c) {
  editing = c || null;
  $('add-title').textContent = c ? '编辑比赛' : '添加比赛';
  $('a-sport').value = c?.sport || 'tennis';
  $('a-sub').value = c?.sub || '';
  $('a-title').value = c?.title || '';
  $('a-teams').value = (c?.teams || []).join(', ');
  $('a-date').value = c
    ? (c.bj ? splitBJ(c.bj).date : c.date)
    : (store.ui.day && store.ui.day !== 'all' ? store.ui.day : dayKey(Date.now()));
  $('a-time').value = c?.bj ? splitBJ(c.bj).time : '';
  $('a-dur').value = c?.dur || 120;
  $('a-ch').value = (c?.channels || []).join(', ');
  $('a-note').value = c?.note || '';
  $('a-manual').open = Boolean(c);
  $('a-q').value = '';
  searchAdd();
  $('d-add').showModal();
  if (!c) setTimeout(() => $('a-q').focus(), 50);
}

$('b-add').onclick = () => openAdd();

function searchAdd() {
  const q = $('a-q').value.trim().toLowerCase();
  const box = $('a-res');
  if (!q) {
    box.innerHTML = '<p class="help">输入人名、球队、赛事或日期，空格分隔多个词。</p>';
    return;
  }
  const tokens = q.split(/\s+/);
  const pool = new Map([...catalog, ...(live?.matches || [])].map((x) => [x.id, x]));
  const inList = new Set(all.map((m) => m.id));
  const now = Date.now();

  const hits = [...pool.values()]
    .filter((x) => {
      const d = x.bj || x.date || '';
      const [y, mo, da] = d.slice(0, 10).split('-');
      const hay = [
        x.title, x.sub, (x.teams || []).join(' '), x.note, d,
        `${Number(mo)}/${Number(da)}`, `${Number(mo)}月${Number(da)}日`, SPORTS[x.sport],
      ].join(' ').toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .map((x) => ({ x, t: parseBJ(...String(x.bj || x.date).split(' ')) }))
    .filter((o) => o.t > now - 2 * DAY)
    .sort((a, b) => a.t - b.t)
    .slice(0, 30);

  if (!hits.length) {
    box.innerHTML = '<p class="help">没找到。可以先去「关注」里加这个人，赛程一出来会自动出现；或点下面手动填写。</p>';
    return;
  }

  box.innerHTML = hits.map(({ x }) => {
    const p = bjParts(parseBJ(...String(x.bj || x.date).split(' ')));
    const has = inList.has(x.id);
    return `<div class="fitem"><div><b>${escapeHTML(x.title)}</b><small>${p.m}/${p.d} ${x.bj ? x.bj.slice(11) : '时间待定'} · ${escapeHTML(x.sub || SPORTS[x.sport])}</small></div>${has ? '<span class="help">已在列表</span>' : `<button type="button" class="x" data-pin="${x.id}">添加</button>`}</div>`;
  }).join('');
}

$('a-q').addEventListener('input', searchAdd);
$('a-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

$('a-res').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pin]');
  if (!b) return;
  store.state.pins = [...new Set([...(store.state.pins || []), b.dataset.pin])];
  store.state.removed = (store.state.removed || []).filter((x) => x !== b.dataset.pin);
  store.save();
  render();
  searchAdd();
});

$('f-add').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('a-manual').open || !$('a-title').value.trim() || !$('a-date').value) {
    $('d-add').close();
    return;
  }
  const date = $('a-date').value;
  const time = $('a-time').value;
  const c = {
    id: editing?.id || ('c' + Date.now().toString(36)),
    custom: true,
    sport: $('a-sport').value,
    sub: $('a-sub').value.trim(),
    title: $('a-title').value.trim(),
    teams: splitList($('a-teams').value),
    dur: Math.max(15, Number($('a-dur').value) || 120),
    channels: splitList($('a-ch').value),
    note: $('a-note').value.trim(),
  };
  if (time) c.bj = `${date} ${time}`;
  else c.date = date;

  store.state.custom = store.state.custom.filter((x) => x.id !== c.id).concat(c);
  store.save();
  $('d-add').close();
  render();
  goTo(c.id);
});

/* 关注管理 */
function renderFollows() {
  $('flist').innerHTML = store.state.follows.map((f) => `
    <div class="fitem">
      <div><b>${escapeHTML(f.name)}</b><small>${f.sport ? '整项关注 · ' + SPORTS[f.sport] : escapeHTML((f.aliases || []).join('、'))}</small></div>
      <button type="button" class="x" data-unf="${f.id}">移除</button>
    </div>`).join('') || '<p class="help">还没有关注对象。</p>';
}

$('b-follow').onclick = () => {
  renderFollows();
  $('d-follow').showModal();
};

$('f-follow').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('fl-name').value.trim();
  const sport = $('fl-sport').value;
  if (!name && !sport) return;
  store.state.follows.push({
    id: 'f' + Date.now().toString(36),
    name: name || SPORTS[sport],
    sport: sport || undefined,
    aliases: splitList($('fl-alias').value).concat(name ? [name] : []),
  });
  $('fl-name').value = '';
  $('fl-alias').value = '';
  $('fl-sport').value = '';
  store.save();
  renderFollows();
  render();
});

/* 设置 */
$('b-settings').onclick = () => {
  const s = store.state.settings;
  $('s-lead').value = s.lead;
  $('s-spoil').checked = s.spoiler;
  $('s-past').checked = store.ui.past;
  $('savestate').textContent = store.lastSyncNote || '关注、提醒、已看等设置保存在这台设备的浏览器里。';
  $('d-settings').showModal();
};

$('f-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  store.state.settings = {
    lead: Math.max(0, Number($('s-lead').value) || 0),
    spoiler: $('s-spoil').checked,
  };
  store.ui.past = $('s-past').checked;
  store.save();
  $('d-settings').close();
  render();
});

$('bannerok').onclick = () => { $('banner').hidden = true; };

/* 刷新 */
$('b-refresh').onclick = async () => {
  if (busy) return;
  busy = true;
  $('b-refresh').disabled = true;
  showSync('正在刷新…');
  try {
    await loadSchedule(true);
    await loadCatalog();
  } finally {
    busy = false;
    $('b-refresh').disabled = false;
  }
};

/* ---------- 安装引导 ---------- */

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('installbanner').hidden = false;
});

$('installok').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installbanner').hidden = true;
};

$('installclose').onclick = () => { $('installbanner').hidden = true; };

window.addEventListener('appinstalled', () => {
  $('installbanner').hidden = true;
  installPrompt = null;
});

/* ---------- Service Worker ---------- */

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    // 有新版本就绪时提示刷新
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          showSync('有新版本，刷新页面即可更新');
        }
      });
    });
  } catch (e) {
    console.warn('Service Worker 注册失败', e);
  }
}

/* ---------- 启动 ---------- */

function tickClock() {
  const p = bjParts(Date.now());
  $('clock').textContent = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

function boot() {
  tickClock();
  setInterval(tickClock, 5000);

  showSync();
  render();
  updateReminderLabel();

  loadSchedule(false).then(loadCatalog);

  // 每 10 分钟拉一次；页面重新可见时也拉
  setInterval(() => loadSchedule(false), 10 * MIN);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadSchedule(false);
  });

  // 每 15 秒重渲染（推进「进行中」状态）并检查提醒
  let lastMinute = -1;
  setInterval(() => {
    const m = Math.floor(Date.now() / MIN);
    const sel = window.getSelection && String(window.getSelection()).trim();
    if (m !== lastMinute && !sel) {
      lastMinute = m;
      render();
    }
    checkReminders();
  }, 15000);
  checkReminders();

  window.addEventListener('online', () => {
    updateOfflineBadge();
    loadSchedule(false);
  });
  window.addEventListener('offline', updateOfflineBadge);
  updateOfflineBadge();

  registerSW();
}

boot();
