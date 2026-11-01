/**
 * 渲染层 —— 纯函数，输入状态输出 HTML 字符串。
 * 与原版相比的改动：
 *   - 修掉原版 renderWeek 里 chips 未按时间排序的问题（原文 sort 的是 shown 但用的是 sk 之外的条件）
 *   - 修掉原版"下一场关注"只看 m.f.length 未考虑 hidden 的问题
 *   - 修掉原版"点击列表行"会误触发文本选中导致无法展开的问题
 */

import { DAY, WEEKDAYS, bjParts, dayKey, dayStart, hm, overlap } from './time.js';
import { DEFAULT_CHANNELS, RECOMMEND_THRESHOLD, isLive, isOver, recommendScore } from './model.js';

export const escapeHTML = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

export const sportColor = (s) => `var(--${s || 'custom'})`;

export function sportIcon(s) {
  const known = ['tennis', 'f1', 'lol', 'football'].includes(s);
  return `<svg class="ic" style="--c:${sportColor(s)}" aria-hidden="true"><use href="#i-${known ? s : 'custom'}"/></svg>`;
}

/** 去掉比分里的括号补充说明，用于窄屏展示 */
export function shortResult(m) {
  return String(m.result || '')
    .replace(/（[^）]*）/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 计算全量赛程的派生数据：命中关注、推荐分、冲突检测。
 * 返回 { all, top, scores }
 */
export function compute(all, follows, hiddenSet, now) {
  const scored = all.map((m) => {
    const hits = m.f || [];
    const { score, why } = recommendScore(m, hits);
    return { ...m, score, why, f: hits };
  });

  // 关注且未结束的比赛之间做时间冲突检测
  const followed = scored.filter((m) => m.f.length && m.known && m.end > now);
  for (const a of followed) {
    a.clash = followed.filter((b) => b !== a && overlap(a.start, a.end, b.start, b.end) > 0);
  }

  // 本周推荐：未来 7 天，每天最多 3 场
  const base = dayStart(now);
  const top = new Map();
  for (let i = 0; i < 7; i++) {
    const ds = base + i * DAY;
    scored
      .filter((x) => !hiddenSet.has(x.id) && x.start >= ds && x.start < ds + DAY && x.score >= RECOMMEND_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.start - b.start)
      .slice(0, 3)
      .forEach((x) => top.set(x.id, x.why));
  }

  return { all: scored, top, scores: new Map(scored.map((x) => [x.id, x])) };
}

/** 顶栏「下一场关注」票根 */
export function renderNext(all, top, now, hasFollows) {
  const next = all.find((m) => m.f.length && m.known && m.end > now && !m.hidden);
  if (!next) {
    return `<div class="tk hero"><div class="tmain">
      <div class="eyebrow">下一场关注</div>
      <h2>暂无</h2>
      <div class="sub">${hasFollows ? '关注的比赛都已结束' : '在「关注」里加选手、战队或整个项目'}</div>
    </div><div class="stub"><div class="num t">--:--</div></div></div>`;
  }

  const live = isLive(next, now);
  const pending = next.verify === 'pending';
  const diff = next.start - now;
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / 3600e3);
  const mi = Math.ceil((diff % 3600e3) / 60e3);
  const countdown = pending && diff <= 0
    ? '原定已开赛 · 待确认'
    : live
      ? '按赛程进行中'
      : (d ? `${d}天${h}时后` : h ? `${h}时${mi}分后` : `${mi}分钟后`) + (pending ? ' · 待确认' : '');
  const p = bjParts(next.start);

  return `<div class="tk hero go" data-go="${next.id}" role="button" tabindex="0" style="--c:${sportColor(next.sport)}">
    <div class="tmain">
      <div class="eyebrow" style="display:flex;align-items:center;gap:5px">${sportIcon(next.sport)}下一场关注 · <b>${escapeHTML(countdown)}</b></div>
      <h2>${escapeHTML(next.title)}</h2>
      <div class="sub">${next.squad ? escapeHTML(next.squad) + ' · ' : ''}${escapeHTML(next.sub || '')}</div>
    </div>
    <div class="stub">
      <div class="d">${p.m}/${p.d} ${WEEKDAYS[p.w]}</div>
      <div class="num t">${hm(next.start)}</div>
      ${live ? '<span class="live">进行中</span>' : ''}
    </div>
  </div>`;
}

/** 本周推荐板：7 天，每天最多 3 场推荐 */
export function renderWeek(all, top, hiddenSet, now, selectedDay) {
  const base = dayStart(now);
  const end = bjParts(base + 6 * DAY);
  const start = bjParts(base);
  const range = `${start.m}/${start.d}–${end.m}/${end.d} · 每天最多 3 场`;

  let html = '';
  for (let i = 0; i < 7; i++) {
    const ds = base + i * DAY;
    const key = dayKey(ds);
    const p = bjParts(ds);
    const dayAll = all.filter((m) => !hiddenSet.has(m.id) && m.start >= ds && m.start < ds + DAY);
    const shown = dayAll
      .filter((m) => top.has(m.id))
      .sort((a, b) => (a.known ? a.start : a.start + DAY - 1) - (b.known ? b.start : b.start + DAY - 1));

    const chips = shown.map((m) => {
      const done = isOver(m, now);
      const why = top.get(m.id);
      const name = /vs/.test(m.title) ? m.title : `${(m.sub || '').split(' · ')[0].replace(/（.*?）/g, '')} ${m.title}`;
      const result = m.result && !m.spoilHidden;
      return `<button class="chip r ${done ? 'd' : ''} ${m.result ? 'res' : ''}" data-go="${m.id}" style="--c:${sportColor(m.sport)}">${sportIcon(m.sport)}<span class="ct">${m.result ? '完赛' : m.known ? hm(m.start) : done ? '已结束' : '待定'}</span><span class="cn">${escapeHTML(result ? shortResult(m) : name)}</span>${why ? `<span class="cw">${escapeHTML(why)}</span>` : ''}</button>`;
    }).join('');

    html += `<div class="wr ${selectedDay === key ? 'sel' : ''}">
      <button class="wl" data-day="${key}" aria-pressed="${selectedDay === key}">
        <b>${p.m}/${p.d}</b><span>${i === 0 ? '今天' : '周' + WEEKDAYS[p.w]}</span>
      </button>
      <div class="wc">${chips || `<span class="wk-none">${dayAll.length ? '无推荐 · 当天共 ' + dayAll.length + ' 场' : '无比赛'}</span>`}</div>
    </div>`;
  }
  return { html, range };
}

/** 单条比赛票根 */
export function renderRow(m, now, top, ui, state, spoilHidden) {
  // 防剧透状态优先用条目上已算好的标记
  const hideScore = m.spoilHidden !== undefined ? m.spoilHidden : Boolean(spoilHidden);
  const open = ui.open === m.id;
  const over = isOver(m, now);
  const live = isLive(m, now);
  const why = top.get(m.id);
  const mark = state.marks[m.id] || {};
  const lead = state.settings.lead;

  const channels = (m.channels && m.channels.length
    ? m.channels.map((c) => [c, null])
    : DEFAULT_CHANNELS[m.sport] || [])
    .map(([n, u]) => (u ? `<a href="${u}" target="_blank" rel="noopener">${escapeHTML(n)}</a>` : escapeHTML(n)))
    .join(' · ');

  let more = '';
  if (open) {
    let result = '';
    if (m.result) {
      result = hideScore
        ? `<div><span class="score blur">${escapeHTML(m.result)}</span> <button class="reveal" data-reveal="${m.id}">显示比分</button></div>`
        : `<div class="score">${escapeHTML(m.result)}</div>`;
    }
    const clash = !over && (m.clash || []).length
      ? `<div class="conflict">与 ${m.clash.map((c) => escapeHTML(c.title)).join('、')} 同时段</div>`
      : '';

    more = `<div class="more">
      ${m.note ? `<div class="note">${escapeHTML(m.note)}</div>` : ''}
      ${result}${clash}
      <div class="acts">
        ${over || !m.known ? '' : `<button class="lnk" data-remind="${m.id}" aria-pressed="${mark.remind === undefined ? m.f.length > 0 : mark.remind}">${mark.remind === undefined ? (m.f.length > 0 ? '已开提醒' : '开赛提醒') : (mark.remind ? '已开提醒' : '开赛提醒')}</button>`}
        <button class="lnk" data-watched="${m.id}" aria-pressed="${Boolean(mark.watched)}">${mark.watched ? '已看' : '标记已看'}</button>
        ${over ? '' : `<button class="lnk" data-ics="${m.id}">加到日历</button>`}
        <button class="lnk" data-gcal="${m.id}">Google 日历</button>
        <button class="lnk" data-copy="${m.id}">复制信息</button>
        ${m.custom
          ? `<button class="lnk" data-edit="${m.id}">编辑</button><button class="lnk" data-del="${m.id}">删除</button>`
          : `<button class="lnk" data-hide="${m.id}">隐藏</button>`}
      </div>
      <div class="ch">观看：${channels}</div>
    </div>`;
  }

  const p = bjParts(m.start);
  const statusText = m.result ? '完赛' : !m.known ? (over ? '已结束' : '待定') : m.tbdTeams ? '对阵待定' : '';

  return `<div class="tk row ${m.squad ? 'cn' : ''} ${over && !live ? 'dim' : ''}" id="m-${m.id}" data-open="${m.id}" style="--c:${sportColor(m.sport)}" role="button" tabindex="0" aria-expanded="${open}">
    <div class="tmain">
      <div class="l1">${sportIcon(m.sport)}<span class="title">${escapeHTML(m.title)}</span></div>
      ${m.result && !open ? (hideScore ? '<div class="resl hid">已完赛 · 点开看比分</div>' : `<div class="resl">${escapeHTML(m.result)}</div>`) : ''}
      <div class="l2">
        ${m.squad ? `<span class="squad">${escapeHTML(m.squad)}</span>` : ''}
        ${why ? `<span class="rec">推荐·${escapeHTML(why)}</span>` : ''}
        ${m.verify === 'pending' ? '<span class="warn">待复核</span>' : ''}
        ${m.f.length ? '<span class="star">★</span>' : ''}
        <span class="s">${escapeHTML(m.sub || '')}</span>
      </div>
      ${more}
    </div>
    <div class="stub">
      ${ui.day === 'all' || ui.q ? `<div class="d">${p.m}/${p.d}</div>` : ''}
      <div class="num t">${m.known ? hm(m.start) : '--:--'}</div>
      ${statusText ? `<div class="tt">${statusText}</div>` : ''}
      ${live ? '<span class="live">进行中</span>' : ''}
    </div>
  </div>`;
}

/** 列表区（含分组标题） */
export function renderList(all, ui, state, now, top, hiddenSet, spoilHidden) {
  const q = ui.q.trim().toLowerCase();

  let list;
  let grouped = false;
  let head = '';

  if (q) {
    const followHits = state.follows.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.aliases || []).some((a) => a.toLowerCase().includes(q)),
    );
    list = all.filter((m) => !hiddenSet.has(m.id) && (
      `${m.title}${m.sub || ''}${(m.teams || []).join(' ')}${m.note || ''}`.toLowerCase().includes(q)
      || followHits.some((f) => m.f.includes(f))
    ));
    grouped = true;
    head = `<div class="lh"><b>搜索结果</b><span>全部日期 · ${list.length} 场</span></div>`;
  } else if (ui.day === 'all') {
    list = all.filter((m) => passFilters(m, ui, state, now, hiddenSet) && (ui.past || !isOver(m, now)));
    grouped = true;
    head = `<div class="lh"><b>全部日期</b><span>${list.length} 场</span><button class="linkbtn" data-day="${dayKey(now)}" style="margin-left:auto">回到今天</button></div>`;
  } else {
    // ui.day 为空表示「今天」，由调用方兜底设置；这里再兜一层避免崩溃
    const ds = ui.day ? dayStart(parseDayKey(ui.day)) : dayStart(now);
    list = all.filter((m) => m.start >= ds && m.start < ds + DAY
      && passFilters(m, ui, state, now, hiddenSet)
      && (ui.past || !isOver(m, now) || dayKey(now) === (ui.day || dayKey(now))));
    const p = bjParts(ds);
    head = `<div class="lh"><b>${p.m}月${p.d}日 周${WEEKDAYS[p.w]}</b><span>${list.length} 场</span><button class="linkbtn" data-day="all" style="margin-left:auto">看全部日期</button></div>`;
  }

  if (!list.length) {
    const other = ui.view === 'follow' && !q ? '<br><button class="btn" data-v="all">看全部比赛</button>' : '';
    return { html: head + `<div class="empty">${q ? '没有找到相关比赛。' : '这天没有符合筛选的比赛。'}${other}</div>`, count: 0 };
  }

  const sortKey = (m) => (m.known ? m.start : m.start + DAY - 1);
  // 未结束的比赛排在前面：已结束的比赛对用户没有「提醒/加日历」的价值
  list = [...list].sort((a, b) => {
    const ao = isOver(a, now) ? 1 : 0;
    const bo = isOver(b, now) ? 1 : 0;
    if (ao !== bo) return ao - bo;
    return sortKey(a) - sortKey(b);
  });

  // 当天场次很多时，非推荐场次默认收起，避免列表刷屏
  // （数据源比原版全得多，一天可能有几十场）
  const FOLD_THRESHOLD = 12;
  let folded = 0;
  if (!q && list.length > FOLD_THRESHOLD && !ui.expandAll) {
    const keep = [];
    const rest = [];
    for (const m of list) {
      if (top.has(m.id) || m.f.length) keep.push(m);
      else rest.push(m);
    }
    // 全都是非推荐时，不折叠（否则看起来像空了）
    if (keep.length >= 3) {
      folded = rest.length;
      list = keep;
    }
  }

  let html = head;
  let lastDay = '';
  for (const m of list) {
    if (grouped) {
      const key = dayKey(m.start);
      if (key !== lastDay) {
        lastDay = key;
        const p = bjParts(m.start);
        html += `<div class="lh"><b>${p.m}/${p.d} 周${WEEKDAYS[p.w]}</b></div>`;
      }
    }
    html += renderRow(m, now, top, ui, state, spoilHidden);
  }

  if (folded > 0) {
    html += `<button class="foldmore" data-expand="1">展开其余 ${folded} 场</button>`;
  } else if (ui.expandAll && !q) {
    html += '<button class="foldmore" data-collapse="1">收起非推荐场次</button>';
  }

  return { html, count: list.length, folded };
}

/** 筛选条件：隐藏项、联赛/项目过滤、关注视图 */
export function passFilters(m, ui, state, now, hiddenSet) {
  if (hiddenSet.has(m.id)) return false;
  if (ui.sport === 'cnfb') {
    // 「中超」按联赛名过滤（ESPN 提供的 chn.1 联赛，sub 形如「中超 · 2026」）
    if (m.sport !== 'football' || !/中超/.test(m.sub || '')) return false;
  } else if (ui.sport !== 'all' && m.sport !== ui.sport) {
    return false;
  }
  if (ui.view === 'follow' && !m.f.length) return false;
  return true;
}

function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - 8 * 3600e3;
}
