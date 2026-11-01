/**
 * 时间工具 —— 全站统一使用北京时间（UTC+8），与设备时区无关。
 * 所有对外暴露的函数都接受/返回 epoch 毫秒。
 */
export const HOUR = 3600e3;
export const MIN = 60e3;
export const DAY = 24 * HOUR;
export const TZ = 8 * HOUR;

export const WEEKDAYS = '日一二三四五六';

/** 把 epoch 毫秒拆成北京时间的各字段 */
export function bjParts(ms) {
  const d = new Date(ms + TZ);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    w: d.getUTCDay(),
  };
}

export const pad = (n) => String(n).padStart(2, '0');

/** 北京时间的 YYYY-MM-DD */
export function dayKey(ms) {
  const p = bjParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 北京时间的 HH:mm */
export function hm(ms) {
  const p = bjParts(ms);
  return pad(p.h) + ':' + pad(p.mi);
}

/** "2026-11-01 19:35" → epoch 毫秒（按北京时间解释） */
export function parseBJ(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - TZ;
}

/** 北京时间当天 00:00 对应的 epoch 毫秒 */
export function dayStart(ms) {
  return Math.floor((ms + TZ) / DAY) * DAY - TZ;
}

/** 两个时间区间的重叠时长（毫秒） */
export function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** "2026-11-01 19:35" → {date:'2026-11-01', time:'19:35'} */
export function splitBJ(bj) {
  const [date, time = '00:00'] = String(bj).split(' ');
  return { date, time };
}

/** 供 <input type="date"> / <input type="time"> 使用 */
export function dateInputValue(ms) {
  const p = bjParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function timeInputValue(ms) {
  const p = bjParts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** UTC ISO → 北京时间 "YYYY-MM-DD HH:mm" */
export function utcToBJ(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const p = bjParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}
