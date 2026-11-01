/**
 * 日历导出 —— 生成 .ics 文件与 Google Calendar 链接。
 *
 * .ics 里带 VALARM 提醒，导入手机日历后由系统负责提醒，
 * 比网页内提醒可靠（网页提醒只在页面打开时生效）。
 */

import { DAY, dayKey, hm } from './time.js';
import { DEFAULT_CHANNELS } from './model.js';

/** ICS 文本转义 */
function escICS(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** epoch → ICS UTC 时间戳（20261101T163000Z） */
function icsStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** epoch → ICS 日期（20261101） */
function icsDate(ms) {
  return dayKey(ms).replace(/-/g, '');
}

function watchList(m) {
  if (m.channels && m.channels.length) return m.channels.join('、');
  return (DEFAULT_CHANNELS[m.sport] || []).map((c) => c[0]).join('、');
}

/** 生成 .ics 文本 */
export function buildICS(m, leadMinutes = 15) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Game On Rebuild//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${m.id}@game-on-rebuild`,
    `DTSTAMP:${icsStamp(Date.now())}`,
  ];

  if (m.known) {
    lines.push(`DTSTART:${icsStamp(m.start)}`, `DTEND:${icsStamp(m.end)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(m.start)}`, `DTEND;VALUE=DATE:${icsDate(m.start + DAY)}`);
  }

  lines.push(
    `SUMMARY:${escICS((m.sub ? m.sub + ' · ' : '') + m.title)}`,
    `DESCRIPTION:${escICS([m.note, '观看：' + watchList(m)].filter(Boolean).join('\n'))}`,
    `LOCATION:${escICS(m.venue || '')}`,
    `CATEGORIES:${escICS(m.sport)}`,
  );

  if (m.known && leadMinutes > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escICS(m.title + ' 即将开赛')}`,
      `TRIGGER:-PT${leadMinutes}M`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/** 触发 .ics 下载 */
export function downloadICS(m, leadMinutes = 15) {
  const blob = new Blob([buildICS(m, leadMinutes)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(m.title || 'match').replace(/[\\/:*?"<>|]/g, '')}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}

/** Google Calendar 模板链接 */
export function googleCalendarURL(m) {
  const dates = m.known
    ? `${icsStamp(m.start)}/${icsStamp(m.end)}`
    : `${icsDate(m.start)}/${icsDate(m.start + DAY)}`;
  const details = [m.sub, m.note, '观看：' + watchList(m)].filter(Boolean).join('\n');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: (m.sub ? m.sub + ' · ' : '') + m.title,
    dates,
    details,
  });
  if (m.venue) params.set('location', m.venue);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** 纯文本信息，用于复制 */
export function shareText(m) {
  const p = new Date(m.start + 8 * 3600e3);
  const week = '日一二三四五六'[p.getUTCDay()];
  return [
    m.title,
    (m.sub || '') + (m.squad ? `（${m.squad}）` : ''),
    `北京时间 ${p.getUTCMonth() + 1}月${p.getUTCDate()}日 周${week} ${m.known ? hm(m.start) : '时间待定'}`,
    m.note || '',
    '观看：' + watchList(m),
  ].filter(Boolean).join('\n');
}
