/**
 * 状态存储 —— 本地 localStorage + 可选的跨设备同步。
 *
 * 本地永远先写（同步失败不丢数据），随后异步推送到账号。
 * 同步通道优先使用 WorkBuddy 云服务；不可用时静默降级为纯本地。
 */

const STATE_KEY = 'gameon-state-v1';
const UI_KEY = 'gameon-ui-v1';

/**
 * 默认关注项。
 * 依据当前数据源（ESPN：欧洲五大联赛 + 欧冠 + ATP/WTA + F1）挑选，
 * 全部能命中实际抓到的赛程，避免首屏「关注」视图为空。
 * 用户可在「关注」面板里增删。
 */
export const DEFAULT_STATE = {
  follows: [
    { id: 'fmc', name: '曼城', aliases: ['曼城', 'Man City', 'Manchester City'] },
    { id: 'fars', name: '阿森纳', aliases: ['阿森纳', 'Arsenal'] },
    { id: 'fliv', name: '利物浦', aliases: ['利物浦', 'Liverpool'] },
    { id: 'frma', name: '曼联', aliases: ['曼联', 'Man Utd', 'Manchester United'] },
    { id: 'fbar', name: '巴萨', aliases: ['巴塞罗那', '巴萨', 'Barcelona', 'FC Barcelona'] },
    { id: 'frma1', name: '皇马', aliases: ['皇家马德里', '皇马', 'Real Madrid'] },
    { id: 'fbm', name: '拜仁', aliases: ['拜仁慕尼黑', '拜仁', 'Bayern Munich', 'FC Bayern München'] },
    { id: 'fiv', name: '国米', aliases: ['国际米兰', '国米', 'Inter Milan', 'Internazionale'] },
    { id: 'fju', name: '尤文', aliases: ['尤文图斯', '尤文', 'Juventus'] },
    { id: 'fpg', name: '巴黎圣日耳曼', aliases: ['巴黎圣日耳曼', '大巴黎', 'PSG', 'Paris Saint-Germain'] },
    { id: 'ff1', name: 'F1', sport: 'f1', aliases: [] },
    { id: 'fzq', name: '郑钦文', aliases: ['郑钦文', 'Zheng Qinwen', 'Queen Wen'] },
    { id: 'fsw', name: '斯瓦泰', aliases: ['斯瓦泰', '斯瓦泰克', 'Iga Swiatek'] },
    { id: 'fsb', name: '萨巴伦卡娃', aliases: ['萨巴伦卡娃', '斯沃洛娃', 'Aryna Sabalenka'] },
  ],
  custom: [],
  marks: {},
  removed: [],
  pins: [],
  settings: { lead: 15, spoiler: false },
};

export const DEFAULT_UI = {
  // 默认展示「全部」：首次打开时关注项可能一场都没匹配上，
  // 空白的首屏对用户没有信息量。切到「关注」是一键操作。
  view: 'all',
  sport: 'all',
  q: '',
  past: false,
  day: null,
  open: null,
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

export class Store {
  constructor() {
    this.state = clone(DEFAULT_STATE);
    this.ui = clone(DEFAULT_UI);
    this.cloud = null;
    this.listeners = new Set();
    this.saveTimer = null;
    this.syncing = false;
    this.dirty = false;
    this.lastSyncNote = '';
    this.#loadLocal();
  }

  #loadLocal() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) this.#merge(JSON.parse(raw));
    } catch (e) { /* 首次运行或存储不可用 */ }
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (raw) this.ui = { ...this.ui, ...JSON.parse(raw) };
    } catch (e) { /* 忽略 */ }
  }

  /** 合并远端/本地状态，远端为准但保留本地独有项 */
  #merge(src) {
    if (!src) return;
    for (const k of ['follows', 'custom', 'marks', 'settings', 'removed', 'pins']) {
      if (src[k] === undefined) continue;
      if (k === 'settings') {
        this.state[k] = {
          lead: src[k].lead ?? DEFAULT_STATE.settings.lead,
          spoiler: src[k].spoiler ?? DEFAULT_STATE.settings.spoiler,
        };
      } else {
        this.state[k] = src[k];
      }
    }
    // 被删掉的默认关注项不再复活
    const removed = new Set(this.state.removed || []);
    this.state.follows = this.state.follows.filter((f) => !removed.has(f.id));
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  /** 本地立即落盘 + 延迟推送云端 */
  save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch (e) { /* 配额或隐私模式 */ }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
    this.#emit();
  }

  saveUI() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(this.ui));
    } catch (e) { /* 忽略 */ }
  }

  /** 推送到云端。失败不影响本地数据。 */
  async flush() {
    if (!this.cloud) return;
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    this.syncing = true;
    try {
      await this.cloud.set(clone(this.state));
      this.lastSyncNote = '关注、提醒等设置已同步到你的账号。';
    } catch (e) {
      this.lastSyncNote = '同步失败，改动暂存在本机。';
    } finally {
      this.syncing = false;
      if (this.dirty) {
        this.dirty = false;
        this.flush();
      }
    }
  }

  /** 从云端拉取并合并 */
  async pull() {
    if (!this.cloud) return false;
    try {
      const remote = await this.cloud.get();
      if (!remote) return false;
      this.#merge(remote);
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
      } catch (e) { /* 忽略 */ }
      this.lastSyncNote = '已从账号同步最新设置。';
      this.#emit();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 绑定云端通道（实现 {get, set} 即可） */
  attachCloud(adapter) {
    this.cloud = adapter;
  }

  /** 标记某场次的状态（已看、提醒、隐藏等） */
  mark(id, patch) {
    this.state.marks[id] = { ...(this.state.marks[id] || {}), ...patch };
    this.save();
  }

  isWatched(id) {
    return Boolean(this.state.marks[id]?.watched);
  }

  isHidden(id) {
    return Boolean(this.state.marks[id]?.hidden);
  }
}
