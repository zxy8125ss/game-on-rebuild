# Game On Rebuild · 赛程

北京时间赛程表：足球、网球、F1、电竞。手机一屏看完，可安装到桌面，**断网也能看**。

复刻自 [zxy8125ss/Game-On](https://github.com/zxy8125ss/Game-On)，在原版基础上重做了工程结构和数据管线。

## 与原版的差异

### 1. 真正能离线（最关键的修复）

原版有 `manifest.webmanifest`，但**没有 Service Worker**——装到手机桌面后一断网就打不开，manifest 形同虚设。

复刻版补上完整实现：

- 应用外壳预缓存（HTML / CSS / 6 个 JS 模块 / 图标 / 字体）
- 赛程数据 stale-while-revalidate：先给缓存秒开，后台静默更新
- 导航请求网络优先，失败回落到应用外壳
- 顶栏有显式「离线」徽标
- 端到端测试里有一条专门验证「断网后页面仍能打开」

### 2. 模块化

原版是 816 行单文件（HTML + CSS + JS 全塞一起）。复刻版拆成 6 个 ES 模块：

| 模块 | 职责 |
|---|---|
| `js/time.js` | 北京时间换算（UTC+8，与设备时区无关） |
| `js/model.js` | 数据模型、推荐评分、关注匹配 |
| `js/store.js` | localStorage 持久化 + 跨设备同步接口 |
| `js/render.js` | 纯渲染函数 |
| `js/calendar.js` | ICS / Google Calendar 导出 |
| `js/app.js` | 主流程与事件绑定 |

### 3. 数据源换成全免费接口，且覆盖更全

原版结构化数据走 ESPN、其余交给 Gemini 整理（需要 `GEMINI_API_KEY`）。复刻版**全部用免费公开接口，零 Key**：

- **ESPN site API** —— 19 个足球联赛（含中超）、ATP/WTA 网球、F1
- **Jolpica/Ergast** —— F1 练习赛/排位赛/正赛分场次
- **Leaguepedia**（MediaWiki API）—— 电竞：LPL / LCK / LEC / LCS / LCP / 世界赛 / MSI / EWC

**逐日抓取**：ESPN 的 scoreboard 不带 `dates` 参数时只返回「当前轮次」，会漏掉后续几轮
（德甲 11/1 只给 2 场，11/7 的多特蒙德 vs 埃尔沃斯贝格完全拿不到）。必须带 `dates=YYYYMMDD`
逐日请求才能覆盖整段时间窗 —— 这是复刻版比赛数量追上原版的关键。

中文名映射表 `data/names.json`（735 条）合并了原版实测数据 + ESPN 队名补充 + 电竞队名。

### 4. 修掉的问题

- **比赛数量不足**：复刻版初版把非焦点比赛全踢出首页，11/5-11/7 几乎空白。
  改为「首页展示全部近期比赛，焦点只影响推荐排序」
- **轮次覆盖不全**：ESPN scoreboard 需逐日请求才能拿到后续轮次（见上）
- **电竞完全缺失**：补 Leaguepedia 数据源，覆盖 LPL/LCK/世界赛/MSI/EWC
- **TBD 占位符**：ESPN 用 `TBD` 表示对阵未定，原版直接显示，现已过滤
- **列表排序**：已结束的比赛不再排在未结束的前面（已结束的没有「加到日历」价值）
- **列表刷屏**：当天场次多时，非推荐场次默认收起，底部可展开
- **崩溃隐患**：`ui.day` 为空时的空指针、`splitBJ` 返回值类型误用

## 功能

- **下一场关注** —— 票根卡片显示倒计时与「进行中」
- **折叠展开** —— 当天超量时只显示推荐场次，底部可展开其余
- **本周推荐** —— 7 天一屏，每天最多 3 场，按评分排序
- **筛选与搜索** —— 关注/全部切换、项目筛选（国足/网球/F1/电竞/足球）、全文搜索
- **关注管理** —— 名字、别名、整项关注；两字别名只匹配全名避免误命中
- **冲突检测** —— 自动标出时间重叠的比赛
- **防剧透** —— 没标记「已看」的比赛隐藏比分
- **加到日历** —— 导出 .ics（含开赛前提醒）或 Google Calendar 链接
- **手动添加** —— 搜不到可直接手填
- **离线可用** —— 断网可看已缓存赛程

## 数据流

```
ESPN / Jolpica
   ↓  scripts/update.mjs
data/schedule.json  首页赛程（近 30 天，~930 场）
data/catalog.json   全量赛程（半年内，搜索与手动添加用，~1080 场）
data/names.json     外文名 → 中文名映射
   ↓
Service Worker 缓存 → 离线可读
```

## 本地运行

```bash
python3 -m http.server 8788 --bind 127.0.0.1
# 打开 http://127.0.0.1:8788/
```

> Service Worker 只在 HTTPS 或 localhost 下生效。本地开发用 `127.0.0.1` 即可；线上必须是 HTTPS。

## 抓取最新赛程

```bash
node scripts/update.mjs
```

会依次抓取 19 个足球联赛 + ATP/WTA + F1 + 电竞（Leaguepedia），输出到 `data/`。
单个来源失败只跳过该来源，不会冲掉已有数据。

耗时约 5 分钟（逐日请求 × 19 联赛 + 40 个电竞页面）。

## 端到端自测

```bash
node scripts/e2e-test.js
```

用 CDP 直连本机 Chrome（无需 playwright），30 项断言：

- 首屏渲染、时钟、本周推荐板、下一场票根
- 筛选切换、项目筛选、搜索结果相关性
- 详情展开、ICS 结构与内容（CRLF / DTSTART / VALARM）
- 关注增删与持久化
- Service Worker 注册、缓存条目校验
- **断网后页面仍能打开**
- 控制台错误与失败请求监听

截图输出在 `scripts/shots/`。

## 自动更新

`.github/workflows/update-schedule.yml` 每天北京时间 07:18 / 12:18 / 16:48 / 22:18 跑一次，抓完自动提交。也可在 Actions 页面手动触发。

## 目录

```
├── index.html               单页外壳
├── css/styles.css           票根风样式（含深色模式）
├── js/                      6 个 ES 模块
├── sw.js                    Service Worker
├── manifest.webmanifest     PWA 清单
├── data/
│   ├── schedule.json        焦点赛程
│   ├── catalog.json         全量赛程
│   └── names.json           中文名映射
├── scripts/
│   ├── update.mjs           抓取脚本
│   ├── make-icons.py        图标生成
│   └── e2e-test.js          端到端自测
├── icons/                   PNG + SVG 图标
└── fonts/                   Barlow Condensed（数字比分用）
```

## 已知限制

- **微信内置浏览器装不了 PWA**：链接能打开能用，但无法「添加到桌面」
- **iOS 推送通知**需 16.4+ 且必须从桌面图标启动
- **网球冷门选手无中文译名**：735 条映射覆盖焦点对象，剩余保留外文（体育媒体通行做法）
- **电竞只覆盖欧美韩赛区**：Leaguepedia 有 LPL/LCK/LEC/LCS/LCP/MSI/世界赛/EWC，
  但部分赛区页面结构不同（如 LCO/CBLOL 的赛程表未识别），这部分留空
- **iOS 上 PWA 与 Safari 共享存储**：Safari 清数据可能连带清掉本地状态
