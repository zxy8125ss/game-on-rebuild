#!/usr/bin/env node
/**
 * Game On 赛程抓取脚本
 *
 * 数据源全部为免费公开接口，无需任何 API Key：
 *   - ESPN site API：足球（19 个联赛）、网球（ATP/WTA）、F1
 *   - Jolpica/Ergast：F1 补充（练习赛/排位赛/正赛分场次）
 *
 * 输出三个文件：
 *   data/schedule.json  焦点赛程（首页展示）
 *   data/catalog.json   全量赛程（供搜索与「添加比赛」模糊匹配）
 *   data/names.json     外文队名 → 中文名映射（增量累积）
 *
 * 任何单个来源失败都只跳过该来源，不会冲掉已有数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEsports } from './fetch-esports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SCHEDULE_FILE = path.join(DATA, 'schedule.json');
const CATALOG_FILE = path.join(DATA, 'catalog.json');
const NAMES_FILE = path.join(DATA, 'names.json');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const TZ = 8 * HOUR;

const now = Date.now();
const FROM = now - 7 * DAY;      // 保留 1 周历史，用于回看赛果
const TO = now + 30 * DAY;       // 向前看 4 周
const CATALOG_TO = now + 120 * DAY; // 目录额外覆盖半年内（供搜索/手动添加）

const pad = (n) => String(n).padStart(2, '0');
const bj = (ms) => {
  const d = new Date(ms + TZ);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const startOf = (m) => {
  const raw = m.bj ? m.bj.replace(' ', 'T') : `${m.date}T00:00`;
  return Date.parse(`${raw}:00+08:00`);
};
const slug = (s) => String(s).toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

/* ---------- HTTP ---------- */

/* ESPN 的 WAF 会拦截非浏览器 UA（403），必须伪装成常规浏览器 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function get(url, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'application/json,text/plain,*/*',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const getJSON = async (url) => (await get(url)).json();

/* ---------- 中文队名映射 ---------- */



/* 焦点对象：命中的比赛进 schedule.json，其余进 catalog.json */
const FOCUS_TEAMS = new Set([
  'Manchester City', 'Arsenal', 'Liverpool', 'Manchester United', 'Chelsea',
  'Tottenham Hotspur', 'Newcastle United', 'Real Madrid', 'Barcelona',
  'Atlético Madrid', 'Bayern Munich', 'Borussia Dortmund', 'Bayer Leverkusen',
  'RB Leipzig', 'Juventus', 'Inter Milan', 'AC Milan', 'Napoli', 'Inter',
  'Paris Saint-Germain', 'Marseille', 'Lyon', 'Monaco', 'Real Madrid',
  'Shandong Taishan', 'Shanghai Port', 'Shanghai Shenhua', 'Beijing Guoan',
  'Chengdu Rongcheng', 'Tianjin Jinmen Tiger',
]);

const FOCUS_LEAGUES = new Set([
  'English Premier League', 'Spanish LALIGA', 'German Bundesliga',
  'Italian Serie A', 'French Ligue 1', 'UEFA Champions League',
  'UEFA Europa League', 'Chinese Super League',
]);

const FOCUS_PLAYERS = new Set([
  'Zheng Qinwen', 'Xinyu Wang', 'Xiyu Wang', 'Yue Yuan', 'Han Shi',
  'Shuai Zhang', 'Lin Zhu', 'Hanyu Guo', 'Zhuoxuan Bai', 'Yafan Wang',
  'Xiaodi You', 'Aryna Sabalenka', 'Elena Rybakina', 'Coco Gauff',
  'Iga Swiatek', 'Jessica Pegula', 'Mirra Andreeva', 'Jasmine Paolini',
  'Aoi Ito', 'Mai Honoma',
]);

/**
 * 焦点判定分档：
 *   tier 0 —— 顶级焦点（豪门/大赛），进首页
 *   tier 1 —— 次级（其余五大联赛、焦点选手、WTA 主力轮），只进 catalog
 *   tier 2 —— 其余，只进 catalog
 * 原版的问题是把整个 WTA 塞进首页，足球全被挤掉；这里按档位控制。
 */
const FOCUS_TIERS = {
  TOP_LEAGUES: new Set([
    'English Premier League', 'Spanish LALIGA', 'German Bundesliga',
    'Italian Serie A', 'French Ligue 1', 'UEFA Champions League',
  ]),
  SECOND_LEAGUES: new Set([
    'UEFA Europa League', 'UEFA Conference League', 'Dutch Eredivisie',
    'Portuguese Primeira Liga', 'Turkish Super Lig', 'Scottish Premiership',
    'Chinese Super League',
  ]),
  ALL_LEAGUES: new Set([
    'English Premier League', 'Spanish LALIGA', 'German Bundesliga',
    'Italian Serie A', 'French Ligue 1', 'UEFA Champions League',
    'UEFA Europa League', 'UEFA Conference League', 'Dutch Eredivisie',
    'Portuguese Primeira Liga', 'Turkish Super Lig', 'Scottish Premiership',
    'MLS', 'Mexican Liga BBVA MX', 'Brazilian Serie A', 'Japanese J.League',
    'Australian A-League Men', 'FIFA World Cup Qualifying - UEFA',
  ]),
};

/* ---------- 数据源 ---------- */

const SOCCER_LEAGUES = [
  ['eng.1', '英超'], ['esp.1', '西甲'], ['ger.1', '德甲'], ['ita.1', '意甲'],
  ['fra.1', '法甲'], ['uefa.champions', '欧冠'], ['uefa.europa', '欧联'],
  ['uefa.europa.conf', '欧协联'], ['ned.1', '荷甲'], ['por.1', '葡超'],
  ['tur.1', '土超'], ['sco.1', '苏超'], ['usa.1', '美职联'],
  ['mex.1', '墨超'], ['bra.1', '巴甲'], ['jpn.1', 'J联赛'], ['aus.1', '澳超'],
  ['chn.1', '中超'], ['fifa.worldq.uefa', '世预赛欧洲区'],
];

const report = [];
const AUTO = new Map();      // 焦点赛程
const CATALOG = new Map();  // 全量赛程
const names = fs.existsSync(NAMES_FILE)
  ? JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'))
  : {};
const discoveredNames = {};

const zh = (s) => {
  if (!s) return s;
  return names[s] || s;
};

/**
 * 把一条赛程写入集合。
 *
 * 分档含义（2026-11 修正）：
 *   tier 0 → 进首页 schedule.json。首页要展示「近期有什么比赛」，
 *            焦点与否只影响网页上的推荐排序，不影响可见性。
 *   tier 1 → 只进 catalog.json（冷门巡回赛等，供搜索与手动添加用）。
 *
 * 之前把非焦点比赛全踢出首页，导致首页只有 26 场、11/5-11/7 几乎空白。
 */
function add(m, tier = 0) {
  const t = startOf(m);
  if (t < FROM || t > CATALOG_TO) return;

  // 过滤占位符：ESPN 用 "TBD" 表示对阵未定，这类没有可读性
  const teams = (m.teams || []).filter((x) => x && !/^TBD$/i.test(String(x).trim()));
  if (!teams.length && m.sport === 'tennis') return;

  m.teams = teams;
  m.id = m.id || slug(`${m.sport}-${m.sub}-${m.title}-${m.bj || m.date}`);
  CATALOG.set(m.id, m);
  // 首页窗口内的、且 tier 为 0 的才进 AUTO
  if (tier === 0 && t <= TO) AUTO.set(m.id, m);
}

/* --- 足球 --- */

/** 并发受限的批量请求 */
async function mapLimit(items, limit, worker) {
  const out = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await worker(items[i]);
      } catch (e) {
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 逐日抓取。
 * ESPN 的 scoreboard 不带 dates 参数时只返回「当前轮次」，会漏掉后续几轮
 * （例如德甲 11/1 有 2 场，但 11/7 的多特蒙德 vs 埃尔沃斯贝格完全拿不到）。
 * 必须带 dates=YYYYMMDD 逐日请求才能覆盖整段时间窗。
 */
async function srcSoccer() {
  const days = Math.ceil((TO - FROM) / DAY);
  // 生成窗口内的所有日期（YYYYMMDD）
  const dateList = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(FROM + i * DAY + TZ);
    dateList.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);
  }

  for (const [slugId, leagueName] of SOCCER_LEAGUES) {
    try {
      const head = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slugId}/scoreboard`);
      const league = head.leagues?.[0]?.name || leagueName;
      const seasonYear = head.season?.year || new Date(now + TZ).getUTCFullYear();

      // 逐日请求，5 路并发，避免触发风控
      const dayResults = await mapLimit(dateList, 5, async (ds) => {
        const day = await getJSON(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${slugId}/scoreboard?dates=${ds}`,
        );
        return day.events || [];
      });

      const events = new Map();
      for (const list of dayResults) {
        for (const ev of list || []) events.set(ev.id, ev);
      }

      let n = 0;
      for (const ev of events.values()) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;

        const competitors = comp.competitors || [];
        const home = competitors.find((c) => c.homeAway === 'home');
        const away = competitors.find((c) => c.homeAway === 'away');
        const homeEn = home?.team?.displayName || '';
        const awayEn = away?.team?.displayName || '';
        if (!homeEn || !awayEn) continue;

        const homeZh = zh(homeEn);
        const awayZh = zh(awayEn);
        const status = comp.status?.type || {};
        const completed = Boolean(status.completed);

        let result = '';
        if (completed && home?.score !== undefined && away?.score !== undefined) {
          result = `${homeZh} ${home.score}:${away.score} ${awayZh}`;
        }

        const channels = (comp.broadcasts || [])
          .map((b) => b.names?.[0]?.shortName || b.names?.[0]?.longName)
          .filter(Boolean);

        const venue = comp.venue?.fullName || '';

        add({
          id: `fb-${slugId}-${ev.id}`,
          sport: 'football',
          sub: `${zh(league)} · ${seasonYear}`.trim(),
          title: `${homeZh} vs ${awayZh}`,
          teams: [homeZh, awayZh],
          bj: bj(Date.parse(comp.startDate || ev.date)),
          dur: 115,
          result: result || undefined,
          note: venue || undefined,
          channels: channels.length ? channels.slice(0, 3) : undefined,
        });
        n++;
      }
      report.push(`足球 ${zh(league)}: ${n} 场`);
    } catch (e) {
      report.push(`足球 ${leagueName}: 跳过（${e.message}）`);
    }
  }
}

/* --- 网球 --- */

/**
 * 网球：ESPN 的网球 scoreboard 带 groupings → competitions 结构。
 * 不带 dates 时只返回当前赛事，需要逐日请求覆盖多站赛事。
 */
async function srcTennis(tour) {
  try {
    const head = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard`);
    const days = Math.ceil((TO - FROM) / DAY);
    const dateList = [];
    for (let i = 0; i <= days; i++) {
      const d = new Date(FROM + i * DAY + TZ);
      dateList.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);
    }

    const dayResults = await mapLimit(dateList, 5, async (ds) => {
      const day = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${ds}`);
      return day.events || [];
    });

    // 同一赛事的多天可能重复，按 (赛事id, 场次id) 去重
    const seen = new Set();
    let n = 0;

    for (const events of dayResults) {
      for (const tourney of events || []) {
        const tourneyName = zh(tourney.name);
        const venue = tourney.venue?.fullName || '';

        for (const grouping of tourney.groupings || []) {
          const groupName = grouping.grouping?.displayName || '';
          for (const comp of grouping.competitions || []) {
            const key = `${tourney.id}-${comp.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const competitors = comp.competitors || [];
            if (competitors.length < 2) continue;

            const namesEn = competitors.map((c) => c.athlete?.displayName || '').filter(Boolean);
            if (!namesEn.length) continue;
            if (namesEn.every((x) => /^TBD$/i.test(x))) continue;

            const namesZh = namesEn.map(zh);
            const status = comp.status?.type || {};
            const completed = Boolean(status.completed);

            let result = '';
            const scoreText = (comp.notes || []).map((n) => n.text).filter(Boolean)[0];
            if (completed && scoreText) {
              result = scoreText.replace(/ \(.*\)/, '');
            } else if (completed) {
              const scores = competitors.map((c) => c.score);
              if (scores.every((s) => s !== undefined)) {
                result = `${namesZh[0]} ${scores[0]}:${scores[1]} ${namesZh[1]}`;
              }
            }

            // 焦点选手一律进首页
            const isFocusPlayer = namesEn.some((x) => FOCUS_PLAYERS.has(x));
            // 高级别赛事（1000/500/大师赛）进首页，冷门巡回赛只进目录
            const isBigTour = /1000|500|Masters|Open|Grand Slam|Challenger/i.test(tourneyName);

            add({
              id: `tn-${tour}-${comp.id}`,
              sport: 'tennis',
              sub: `${tourneyName}${groupName ? ' · ' + zh(groupName) : ''}`,
              title: namesZh.join(' vs '),
              teams: namesZh,
              bj: bj(Date.parse(comp.startDate || comp.date)),
              dur: 150,
              result: result || undefined,
              note: venue || undefined,
            }, isFocusPlayer || isBigTour ? 0 : 1);
            n++;
          }
        }
      }
    }
    report.push(`网球 ${tour.toUpperCase()}: ${n} 场`);
  } catch (e) {
    report.push(`网球 ${tour}: 跳过（${e.message}）`);
  }
}

/* --- F1 --- */

async function srcF1() {
  try {
    const data = await getJSON('https://api.jolpi.ca/ergast/f1/current/races.json?limit=100');
    const races = data.MRData?.RaceTable?.Races || [];
    let n = 0;

    for (const race of races) {
      const gpName = zh(race.raceName);
      const circuit = zh(race.Circuit?.circuitName || '');
      const round = race.round;

      const sessions = [
        [null, 'r', '正赛', 120],
        ['Qualifying', 'q', '排位赛', 60],
        ['Sprint', 's', '冲刺赛', 45],
      ];

      for (const [key, suf, title, dur] of sessions) {
        const s = key ? race[key] : { date: race.date, time: race.time };
        if (!s?.date || !s?.time) continue;

        add({
          id: `f1-${race.season}-${round}-${suf}`,
          sport: 'f1',
          sub: `${gpName}（第${round}站）`,
          title,
          teams: [],
          bj: bj(Date.parse(`${s.date}T${s.time}`)),
          dur,
          note: circuit || undefined,
          focus: true,
        });
        n++;
      }
    }
    report.push(`F1: ${n} 场`);
  } catch (e) {
    report.push(`F1: 跳过（${e.message}）`);
  }
}

/* --- 额外：抓取未知外文名的候选，供人工补映射 --- */
function collectUnknownNames() {
  for (const m of CATALOG.values()) {
    for (const t of m.teams || []) {
      if (/[A-Za-z]{3,}/.test(t) && !names[t]) discoveredNames[t] = (discoveredNames[t] || 0) + 1;
    }
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  console.log('[GameOn] 开始抓取赛程…');

  await srcSoccer();
  await srcTennis('atp');
  await srcTennis('wta');
  await srcF1();

  // 电竞：Leaguepedia（免费，含 LPL/LCK/世界赛/MSI/EWC）
  try {
    const { matches, report: espReport } = await fetchEsports(now);
    for (const m of matches) {
      add(m);
    }
    report.push(...espReport);
  } catch (e) {
    report.push(`电竞: 跳过（${e.message}）`);
  }

  collectUnknownNames();

  // 首页赛程：按时间排序，焦点比赛不特殊对待（可见性由网页的推荐算法决定）
  const focusList = [...AUTO.values()]
    .sort((a, b) => startOf(a) - startOf(b));

  const catalogList = [...CATALOG.values()]
    .sort((a, b) => startOf(a) - startOf(b));

  const clean = (m) => {
    const o = { ...m };
    delete o.focus;
    if (!o.result) delete o.result;
    if (!o.note) delete o.note;
    if (!o.channels?.length) delete o.channels;
    return o;
  };

  const schedule = {
    updatedAt: new Date().toISOString(),
    note: `自动更新 ${report.filter((r) => !/跳过/.test(r)).length}/${report.length} 项成功`,
    matches: focusList.map(clean),
    sources: report,
  };

  const catalog = {
    updatedAt: new Date().toISOString(),
    matches: catalogList.map(clean),
  };

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 1) + '\n');
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 1) + '\n');
  fs.writeFileSync(NAMES_FILE, JSON.stringify(names, null, 1) + '\n');

  console.log(`[GameOn] 焦点赛程 ${focusList.length} 场 / 全量 ${catalogList.length} 场`);
  console.log(`[GameOn] 中文名映射 ${Object.keys(names).length} 条`);
  report.forEach((r) => console.log('  - ' + r));
}

main().catch((e) => {
  console.error('[GameOn] 抓取失败:', e.message);
  process.exit(1);
});
