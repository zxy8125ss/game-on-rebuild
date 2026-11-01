/**
 * 电竞赛程抓取（Leaguepedia）
 *
 * 数据源：Leaguepedia / LoL Esports Wiki 的 MediaWiki API。
 * 用 action=parse 取渲染后的 HTML 再解析 —— Cargo 接口结构化但限流极严，
 * action=parse 反而稳定。
 *
 * 覆盖页面：各联赛当季页面（LPL / LCK / LEC / LCS ...）+ 总决赛页。
 * 每场比赛对应一个 <tr data-date="..."> 行，内含队名、UTC 时间、比分。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES_FILE = path.join(ROOT, 'data', 'names.json');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const TZ = 8 * HOUR;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://lol.fandom.com/api.php';

const pad = (n) => String(n).padStart(2, '0');
const bj = (ms) => {
  const d = new Date(ms + TZ);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const names = fs.existsSync(NAMES_FILE)
  ? JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'))
  : {};

/**
 * 队名转中文/缩写。
 * Leaguepedia 的队名常带地区后缀（如 "Ninjas in Pyjamas.CN"、"Bilibili Gaming (BLG)"），
 * 先精确匹配，再去掉后缀与括号重试，最后做不区分大小写的宽松匹配。
 */
function zh(s) {
  if (!s) return s;
  if (names[s]) return names[s];

  const variants = [
    s.replace(/\s*\([^)]*\)\s*$/, '').trim(),   // 去括号后缀
    s.replace(/\.[A-Z]{2,3}$/, '').trim(),      // 去 .CN / .KR 地区后缀
    s.replace(/\s*\([^)]*\)\s*$/, '').replace(/\.[A-Z]{2,3}$/, '').trim(),
  ];
  for (const v of variants) {
    if (v && names[v]) return names[v];
  }

  // 宽松匹配：忽略大小写与空格
  const key = s.toLowerCase().replace(/\s+/g, '');
  for (const [k, v] of Object.entries(names)) {
    if (k.toLowerCase().replace(/\s+/g, '') === key) return v;
  }
  return s;
}

/**
 * 待抓取的页面。
 * 路径规则（Leaguepedia 实际结构）：
 *   LPL/2026 Season/Split 1..3、…/Split N Playoffs、…/Grand Finals
 *   LCK/2026 Season/Rounds 1-2、…/Season Playoffs、…/Season Play-In
 *   2026 Season World Championship/Main Event、…/Play-In
 *   2026 Mid-Season Invitational
 */
function targetPages(year) {
  const pages = [];

  // LPL：分季 + 季后赛 + 总决赛
  for (let i = 1; i <= 3; i++) {
    pages.push(`LPL/${year} Season/Split ${i}`);
    pages.push(`LPL/${year} Season/Split ${i} Playoffs`);
  }
  pages.push(`LPL/${year} Season/Grand Finals`);
  pages.push(`LPL/${year} Season/Regional Finals`);

  // LCK
  pages.push(`LCK/${year} Season`);
  pages.push(`LCK/${year} Season/Rounds 1-2`);
  pages.push(`LCK/${year} Season/Rounds 3-4`);
  pages.push(`LCK/${year} Season/Season Play-In`);
  pages.push(`LCK/${year} Season/Season Playoffs`);

  // 三大赛区
  for (const lg of ['LEC', 'LCS', 'LCP', 'LCO', 'CBLOL', 'NLC', 'LFL']) {
    pages.push(`${lg}/${year} Season`);
    pages.push(`${lg}/${year} Season/Playoffs`);
  }

  // 全球赛事
  pages.push(`${year} Season World Championship/Main Event`);
  pages.push(`${year} Season World Championship/Play-In`);
  pages.push(`${year} Mid-Season Invitational`);
  pages.push(`Esports World Cup ${year}`);
  pages.push(`${year} Season World Championship`);

  return pages;
}

async function getJSON(url, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取页面渲染后的 HTML（带重试，避开限流） */
async function fetchPage(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await getJSON(url);
      if (data.error) throw new Error(data.error.info || 'parse error');
      return data.parse?.text || '';
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(4000 * (attempt + 1));
    }
  }
  return '';
}

const decodeEntities = (s) => String(s)
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ');

/** 从页面 HTML 中抽取所有比赛 */
function parseMatches(html, pageName) {
  const start = html.indexOf('id="matchlist-content-wrapper"');
  if (start < 0) return [];

  const seg = html.slice(start);
  const rows = seg.match(/<tr\b[^>]*data-date="[^"]+"[^>]*>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g) || [];
  const out = [];

  for (const row of rows) {
    const date = (row.match(/data-date="([^"]+)"/) || [])[1];
    const t1 = (row.match(/data-teamhighlight="([^"]+)"[^>]*class="matchlist-team1/)
      || row.match(/class="matchlist-team1[^"]*"[^>]*data-teamhighlight="([^"]+)"/) || [])[1];
    const t2 = (row.match(/data-teamhighlight="([^"]+)"[^>]*class="matchlist-team2/)
      || row.match(/class="matchlist-team2[^"]*"[^>]*data-teamhighlight="([^"]+)"/) || [])[1];
    // countdowndate 里是 UTC 精确时间："22 July 2026 09:00:00 +0000"
    const cd = (row.match(/<span class="countdowndate">([^<]+)<\/span>/) || [])[1];

    if (!t1 || !t2 || !cd) continue;

    const scores = (row.match(/class="matchlist-score[^"]*"[^>]*>\s*([\d\-–—]*)/g) || [])
      .map((s) => (s.match(/>\s*([\d\-–—]*)/) || [])[1])
      .filter((x) => x !== undefined);

    const ms = Date.parse(cd.trim());
    if (Number.isNaN(ms)) continue;

    const name1 = decodeEntities(t1);
    const name2 = decodeEntities(t2);

    let result;
    if (scores.length >= 2 && /^\d+$/.test(scores[0]) && /^\d+$/.test(scores[1])) {
      result = `${zh(name1)} ${scores[0]}:${scores[1]} ${zh(name2)}`;
    }

    // 赛事名：页面名去掉 "/2026 Season/..." 后缀
    const sub = pageName.replace(/^\/+/, '').replace(/\/(\d{4}) Season.*$/, ' $1');

    out.push({
      id: `lol-${pageName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${date}-${name1}-${name2}`.slice(0, 90),
      sport: 'lol',
      sub,
      title: `${zh(name1)} vs ${zh(name2)}`,
      teams: [zh(name1), zh(name2)],
      bj: bj(ms),
      dur: 120,
      result,
    });
  }
  return out;
}

/** 主流程 */
export async function fetchEsports(now) {
  const year = new Date(now + TZ).getUTCFullYear();
  const pages = targetPages(year);
  const all = new Map();
  const report = [];

  for (const page of pages) {
    try {
      const html = await fetchPage(page);
      if (!html) {
        report.push(`电竞 ${page}: 无内容`);
        continue;
      }
      const matches = parseMatches(html, page);
      matches.forEach((m) => all.set(m.id, m));
      report.push(`电竞 ${page}: ${matches.length} 场`);
    } catch (e) {
      report.push(`电竞 ${page}: 跳过（${e.message}）`);
    }
    // 限流保护：请求之间留间隔
    await sleep(1200);
  }

  return { matches: [...all.values()], report };
}

// 独立运行：node scripts/fetch-esports.mjs
if (process.argv[1] && process.argv[1].endsWith('fetch-esports.mjs')) {
  const now = Date.now();
  const { matches, report } = await fetchEsports(now);
  console.log(`[GameOn] 电竞共 ${matches.length} 场`);
  report.forEach((r) => console.log('  - ' + r));
  matches.slice(0, 12).forEach((m) => {
    console.log(`  ${m.bj} | ${m.title} | ${m.sub}${m.result ? ' | ' + m.result : ''}`);
  });
}
