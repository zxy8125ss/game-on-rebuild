/**
 * 数据模型 —— 赛程条目（match）的字段约定与派生逻辑。
 *
 * 字段：
 *   id       唯一标识
 *   sport    football | tennis | f1 | lol | custom
 *   sub      赛事名称，如「英超 · 第 12 轮」
 *   title    对阵或标题，如「阿森纳 vs 切尔西」
 *   teams    参赛方名称数组（用于关注匹配）
 *   bj       北京时间 "YYYY-MM-DD HH:mm"，缺省表示时间待定
 *   date     只有日期（无确切时间）时的回退字段
 *   dur      时长（分钟）
 *   result   赛果
 *   note     备注
 *   channels 转播平台
 *   squad    队伍归属标签，如「国家队」
 *   verify   'pending' 表示待复核
 */

import { DAY, MIN, parseBJ, splitBJ } from './time.js';

export const SPORTS = {
  tennis: '网球',
  f1: 'F1',
  lol: '电竞',
  football: '足球',
  custom: '其他',
};

export const SPORT_ORDER = ['football', 'tennis', 'f1', 'lol', 'custom'];

/** 每个项目默认的转播平台 */
export const DEFAULT_CHANNELS = {
  tennis: [
    ['央视体育', 'https://tv.cctv.com/'],
    ['咪咕视频', 'https://www.miguvideo.com/'],
  ],
  f1: [
    ['央视体育', 'https://tv.cctv.com/'],
    ['咪咕视频', 'https://www.miguvideo.com/'],
  ],
  lol: [
    ['哔哩哔哩', 'https://live.bilibili.com/'],
    ['虎牙', 'https://www.huya.com/'],
    ['斗鱼', 'https://www.douyu.com/'],
  ],
  football: [
    ['咪咕视频', 'https://www.miguvideo.com/'],
    ['腾讯体育', 'https://sports.qq.com/'],
  ],
};

/**
 * 给原始条目补上派生字段：known（时间是否确定）、start、end。
 */
export function normalize(raw) {
  const known = Boolean(raw.bj);
  const start = known
    ? parseBJ(splitBJ(raw.bj).date, splitBJ(raw.bj).time)
    : parseBJ(raw.date || raw.bj);
  const dur = raw.dur || 120;
  return {
    ...raw,
    known,
    start,
    end: start + dur * MIN,
    dur,
    teams: raw.teams || [],
  };
}

/**
 * 判断是否是「对阵未公布」的占位场次。
 * ESPN 对未确定的对手会写 "TBD"，这类比赛没有可读性，不该出现在推荐里。
 */
export function isTBD(m) {
  const teams = m.teams || [];
  if (teams.some((t) => /^TBD$/i.test(String(t).trim()))) return true;
  return /\bTBD\b/.test(m.title || '');
}

/**
 * 判断比赛是否已结束。
 * 有明确赛果 → 结束；有确切时间 → 过了结束时间即结束；
 * 时间待定 → 过了一整天算结束。
 */
export function isOver(m, now) {
  if (m.result) return true;
  return m.known ? m.end < now : m.start + DAY < now;
}

/**
 * 判断比赛是否正在进行。
 * 待复核的条目不推断「进行中」——否则会和「待确认」自相矛盾。
 */
export function isLive(m, now) {
  return m.known && m.verify !== 'pending' && m.start <= now && m.end > now;
}

/**
 * 推荐评分：决定「本周推荐」里哪些场次值得高亮。
 *
 * 关键设计：**不给普通联赛加分**。
 * 早先版本给五大联赛每场 +3，结果足球（19 个联赛、几百场）把每天的名额
 * 全占满，推荐栏 100% 是足球。这里只按「赛事重要性」和「用户关注」打分，
 * 跨项目公平竞争；多样性由 compute() 里的项目配额保证。
 *
 * 规则：
 *   欧国联 → 直接排除（-99）
 *   中国球队/中超 → +5
 *   决赛/奖牌战/金牌战 → +5，半决赛 → +3，八强 → +2
 *   命中关注 → +4
 *   F1 正赛 → +4
 *   电竞大赛（世界赛/MSI/EWC）→ +3
 *   待复核 → -1
 */
export function recommendScore(m, followHits) {
  const text = `${m.sub || ''} ${m.title || ''}`;
  if (/欧国联/.test(text)) return { score: -99, why: '' };

  let score = 0;
  const reasons = [];

  // 中国球队：来自中超联赛，或带 squad 标记（旧数据格式）
  const isCN = Boolean(m.squad) || /中超/.test(m.sub || '');
  if (isCN) {
    score += 5;
    reasons.push({ w: 3, why: m.squad ? m.squad.replace(' 亚运队', '') : '中超' });
  }

  // 赛事阶段：最有信息量的标签，权重最高
  // 注意两个坑：
  //  1. 电竞赛事名常含 "Championship"（锦标赛），不是决赛
  //  2. 「全球总决赛」是赛事名，不是某一场比赛是决赛 —— 不能再加一次决赛分
  const isEsportsEvent = /全球总决赛|世界赛|总决赛|MSI|电竞世界杯/i.test(text);
  const isFinal = !isEsportsEvent
    && /决赛|金牌|铜牌|奖牌|finals?\b/i.test(text)
    && !/半决赛|1\/4决赛|八强/i.test(text);
  if (isFinal) {
    score += 5;
    reasons.push({ w: 5, why: /铜牌/.test(text) ? '奖牌战' : /金牌/.test(text) ? '金牌战' : '决赛' });
  } else if (/半决赛|semifinal/i.test(text)) {
    score += 3;
    reasons.push({ w: 4, why: '半决赛' });
  } else if (/八强|1\/4决赛|四分之一|quarterfinal/i.test(text)) {
    score += 2;
    reasons.push({ w: 4, why: '八强' });
  }

  const named = followHits.some((f) => !f.sport);
  const sportOnly = followHits.some((f) => f.sport);
  if (named) {
    score += 4;
    reasons.push({ w: 1, why: '关注' });
  } else if (sportOnly) {
    score += 2;
  }

  // 足球焦点球队：五大联赛豪门之间对决是球迷最想看的
  // 单独给 3 分，让它们能进候选池；实际展示数量由「每项目每天最多 1 场」的配额控制
  if (m.sport === 'football') {
    const bigClub = /曼城|阿森纳|利物浦|曼联|切尔西|热刺|纽卡斯尔|巴塞罗那|皇家马德里|马竞|拜仁|多特蒙德|勒沃库森|莱比锡|国际米兰|AC米兰|尤文图斯|那不勒斯|罗马|拉齐奥|巴黎圣日耳曼|马赛|里昂|摩纳哥/.test(m.title);
    const bigLeague = /英超|西甲|德甲|意甲|法甲|欧冠/.test(m.sub || '');
    if (bigClub && bigLeague) {
      score += 3;
      reasons.push({ w: 2, why: '豪门对决' });
    }
  }

  if (m.sport === 'f1' && /正赛/.test(m.title)) {
    score += 4;
    reasons.push({ w: 4, why: 'F1 正赛' });
  }
  if (/S16/.test(text) && /八强|半决赛|总决赛/.test(text)) {
    score += 4;
    reasons.push({ w: 4, why: 'S16' });
  }
  // 电竞大赛
  if (m.sport === 'lol' && /世界赛|Worlds|全球总决赛|MSI|EWC/i.test(text)) {
    score += 3;
    reasons.push({ w: 3, why: '电竞大赛' });
  }

  // 网球高级别赛事：即使没有关注对象也值得推荐
  // （网球关注项在任意时间窗口常常一场都碰不到，需要独立入口）
  if (m.sport === 'tennis') {
    if (/1000|Masters|大师赛|Grand Slam|大满贯/i.test(text)) {
      score += 5;
      reasons.push({ w: 3, why: 'WTA1000/大师赛' });
    } else if (/500|公开赛|Open/i.test(text)) {
      score += 3;
      reasons.push({ w: 2, why: '公开赛' });
    }
  }

  if (m.verify === 'pending') score -= 1;

  reasons.sort((a, b) => b.w - a.w);
  return { score, why: reasons.length ? reasons[0].why : '' };
}

/**
 * 命中推荐的最低分。
 * 5 分 = 关注(4) 或 中超(5) 或 决赛阶段(5) 或 F1正赛(4)+…
 * 门槛不能太高，否则普通日子一个推荐都没有。
 */
export const RECOMMEND_THRESHOLD = 5;

/**
 * 关注匹配：判断一场比赛命中了哪些关注项。
 * 规则：
 *   - 整项关注（f.sport）→ 该项目的比赛全中
 *   - 「中超」关注 → 所有中超联赛的比赛都中
 *   - 两字以内的别名只匹配参赛方全名，避免「国」误中「中国国家队」
 *   - 三个字以上也匹配标题/赛事/备注
 */
export function matchFollows(m, follows) {
  const hits = [];
  for (const f of follows) {
    if (f.sport && f.sport === m.sport) {
      hits.push(f);
      continue;
    }
    if (/中超/.test(m.sub || '') && (f.name === '中超' || (f.aliases || []).includes('中超'))) {
      hits.push(f);
      continue;
    }
    if (m.squad && (f.name === '国足' || (f.aliases || []).includes('国足'))) {
      hits.push(f);
      continue;
    }
    const teams = (m.teams || []).map((t) => t.toLowerCase());
    const hay = `${m.title} ${m.sub || ''} ${m.note || ''}`.toLowerCase();
    const candidates = (f.aliases || []).concat(f.name);
    const hit = candidates.some((a) => {
      const key = String(a || '').toLowerCase().trim();
      if (!key) return false;
      if (teams.includes(key)) return true;
      return [...key].length >= 3 && hay.includes(key);
    });
    if (hit) hits.push(f);
  }
  return hits;
}
