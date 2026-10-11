/**
 * 课表 → 日程的映射（纯函数，方便单测）。
 *
 * 结论（见 `docs/课表接入调研.md` 第 5 节）：**逐周展开成独立 Schedule，默认不用 `repeat`**。
 * 原因：
 * 1. 我们的 `repeat` 没有 `exceptions` / EXDATE 字段，调课、停课、放假都改不了某一天；
 * 2. `interval: 2` 只能表达等差数列，`{3,5,7,11,13}` 这类不连续周表达不了；
 * 3. 夏/冬作息不同，一条 `repeat` 记录只能有一个固定 `startTime`（9 月的课 10 月时间会漂）；
 * 4. 数据量很小：18 周 × ~15 门 ≈ 270 条/学期；
 * 5. 与参考实现一致，且 `externalId` 里带 `week`，天然逐条幂等。
 *
 * 压缩成 `repeat` 只作为**显式开关**（`compact: true`）且仅在周次真的成等差时使用。
 */

import { getClassTime } from './periods.js';
import { bitmapToWeeks } from './weeks.js';
import { termLength, weekToDate } from './term.js';

const TAG = '课表';
const SOURCE = 'xjtu';
const PREFIX = 'tt:';

/** 上课提醒：提前 15 分钟（调研文档的约定）。 */
export const CLASS_REMINDER = Object.freeze({ offsetMinutes: 15, channel: 'app' });

/**
 * 字段规范化规则（**已冻结**，改它等于让所有历史 `externalId` 失效，会导致重复导入）。
 *
 * 1. 去首尾空白；
 * 2. 去所有空白（含全角空格 U+3000）；
 * 3. 全角逗号 `，` 与顿号 `、` 统一成半角 `,`。
 *
 * 之所以要冻结：`externalId` 的哈希输入是「课程名|教师|星期|节次|教室」，
 * 只要规范化规则变一下，同一条课就会算出新的哈希 → 幂等匹配失败 → 日历里出现重复课。
 */
export function normalizeKeyPart(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\uFF0C\u3001]/g, ',')
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/**
 * 零依赖 FNV-1a 32 位哈希，取 8 位十六进制。
 *
 * 为什么不用 `node:crypto`：哈希要跨 Node 版本稳定，而且这里只是「给人看的短标识 + 幂等键的一部分」，
 * 不需要密码学强度。FNV-1a 是纯整数运算，任何 Node 版本、任何平台结果都一样。
 */
export function hash8(input) {
  let hash = 0x811c9dc5;
  const text = String(input ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 乘 16777619 用移位加法实现，避免 Math.imul 之外的浮点误差
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 是否本模块产生的记录（应用同步时只动这些，绝不碰用户手改的日程）。 */
export function isTimetableExternalId(externalId) {
  return typeof externalId === 'string' && externalId.startsWith(PREFIX);
}

/**
 * 一条课记录（课程 + 星期 + 节次 + 教室）的稳定基键。
 * 不含周次 —— 周次跟在后面，保证「同一条课的第 N 周」唯一。
 */
export function baseExternalId({ term, courseName, teacher, weekDay, startPeriod, endPeriod, location }) {
  const key = [
    normalizeKeyPart(courseName),
    normalizeKeyPart(teacher),
    normalizeKeyPart(weekDay),
    `${normalizeKeyPart(startPeriod)}-${normalizeKeyPart(endPeriod)}`,
    normalizeKeyPart(location),
  ].join('|');
  return `${PREFIX}${term}:${hash8(key)}`;
}

/** 逐周的完整 externalId。 */
export function externalIdFor(parts, week) {
  return `${baseExternalId(parts)}:${week}`;
}

/** 日程标题：课程名，超过 120 字截断（与 Schedule 的字段约束一致）。 */
function clipTitle(courseName) {
  const text = String(courseName ?? '').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** 课程描述的固定形状（预览里给用户看，也写进日程 description）。 */
export function describeCourse({ courseName, teacher, location, weekDay, startPeriod, endPeriod }) {
  return [
    `课程：${courseName}`,
    teacher ? `教师：${teacher}` : null,
    location ? `教室：${location}` : null,
    `时间：周${'一二三四五六日'[weekDay - 1] ?? weekDay} 第 ${startPeriod}-${endPeriod} 节`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 一条课记录的标签（调研文档第 5 节）。 */
export function tagsFor({ term, teacher, weekDay }) {
  return [TAG, SOURCE, `term:${term}`, teacher ? `teacher:${teacher}` : null, `weekday:${weekDay}`].filter(Boolean);
}

/**
 * 把课表行逐周展开成日程草稿。
 *
 * @param {object[]} rows 归一化后的课表行（见 api.js normalizeTimetableRow）
 * @param {object} options
 * @param {string} options.term 学期编号
 * @param {string} options.termStart 第一周周一（`YYYY-MM-DD`）
 * @param {string} [options.today] 用于 `includePast`
 * @param {boolean} [options.includePast=false] 是否导入已经过去的周次
 * @param {number} [options.totalWeeks] 覆盖总周数
 * @returns {{items:object[], skipped:object[]}} items 已按日期排序
 */
export function expandRows(rows, { term, termStart, today, includePast = false, totalWeeks } = {}) {
  const weeks = totalWeeks ?? termLength(term);
  const items = [];
  const skipped = [];
  const seen = new Set();

  for (const row of rows ?? []) {
    const bitmap = row.weeksBitmap;
    if (!bitmap) {
      skipped.push({ row, reason: '课表行没有周次位图（SKZC 为空）' });
      continue;
    }
    const rowWeeks = bitmapToWeeks(bitmap);
    if (!rowWeeks.length) {
      skipped.push({ row, reason: `周次位图里没有任何一周：${bitmap}` });
      continue;
    }
    if (!row.weekDay || row.weekDay < 1 || row.weekDay > 7) {
      skipped.push({ row, reason: `星期字段不合法：${JSON.stringify(row.weekDay)}` });
      continue;
    }
    if (!row.startPeriod || !row.endPeriod) {
      skipped.push({ row, reason: `节次字段不合法：${JSON.stringify(row.startPeriod)}-${JSON.stringify(row.endPeriod)}` });
      continue;
    }

    for (const week of rowWeeks) {
      if (week > weeks) {
        skipped.push({ row, week, reason: `第 ${week} 周超出了学期总周数（${weeks}）` });
        continue;
      }
      const date = weekToDate(termStart, week, row.weekDay);
      if (!includePast && today && date < today) {
        skipped.push({ row, week, reason: '已过去的周次（可勾选「包含已过去」再导入）' });
        continue;
      }
      // 夏/冬作息按当天的日期现选：9 月的下午课与 10 月的时间不一样
      const { startTime, endTime, season } = getClassTime(row.startPeriod, row.endPeriod, date);
      const externalId = externalIdFor(row, week);
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      const payload = {
        title: clipTitle(row.courseName),
        description: describeCourse(row),
        category: 'class',
        date,
        startTime,
        endTime,
        allDay: false,
        status: 'pending',
        priority: 1,
        tags: tagsFor({ term, teacher: row.teacher, weekDay: row.weekDay }),
        reminders: [{ ...CLASS_REMINDER }],
        source: 'import',
        externalId,
      };
      if (row.location) payload.location = row.location;

      items.push({
        key: externalId,
        baseKey: baseExternalId(row),
        kind: 'schedule',
        courseName: row.courseName,
        teacher: row.teacher ?? null,
        location: row.location ?? null,
        week,
        weekDay: row.weekDay,
        season,
        date,
        startTime,
        endTime,
        payload,
      });
    }
  }

  items.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return String(a.courseName).localeCompare(String(b.courseName), 'zh-Hans-CN');
  });
  return { items, skipped };
}

/** 只有这些字段算「学校给的事实」，变了才更新（用户自己改的提醒等不回滚）。 */
const DIFF_FIELDS = ['title', 'description', 'category', 'date', 'startTime', 'endTime', 'allDay', 'status', 'priority', 'location', 'repeat'];

function diffFields(existing, payload) {
  const changed = [];
  for (const field of DIFF_FIELDS) {
    // payload 里没有这个字段 = 「这条映射不关心它」，绝不能当成「把它清空」：
    // 日程落库后 `repeat` 会被补成 {type:'none',…}、`location` 会被补成 ''，
    // 如果拿它们跟 payload 的 undefined 比，第二次同步会把每条记录都误判成 update。
    if (payload[field] === undefined) continue;
    const before = existing[field];
    const after = payload[field];
    if (field === 'repeat') {
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changed.push(field);
      continue;
    }
    if (String(before ?? '') !== String(after ?? '')) changed.push(field);
  }
  const beforeTags = (existing.tags ?? []).join('|');
  const afterTags = (payload.tags ?? []).join('|');
  if (beforeTags !== afterTags) changed.push('tags');
  return changed;
}

function finalizeItem(item, existing) {
  if (!existing) return { ...item, action: 'create' };
  const changes = diffFields(existing, item.payload);
  if (!changes.length) return { ...item, action: 'skip', reason: '已是最新', existingId: existing.id };
  return { ...item, action: 'update', existingId: existing.id, changes };
}

/**
 * 把「逐周的条目」按需折叠成 `repeat`（默认关闭）。
 *
 * 折叠条件很保守，只有同时满足才折叠：
 * - 同一个基键（课程/教师/星期/节次/教室完全一致）；
 * - 周次是等差数列（公差 1 = 每周，公差 2 = 单/双周，起点必须落在对应奇偶类）；
 * - 同一条课的时间在所有周里完全一致（跨 9/10 月的下午课会因夏冬作息不同而落选）；
 * - 学期内没有任何单周改动/停课（上游位图里本来就缺的不算改动，缺周会直接不折叠）。
 */
export function compactItems(items) {
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.baseKey) ?? [];
    list.push(item);
    groups.set(item.baseKey, list);
  }
  const out = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.week - b.week);
    const weeks = sorted.map((item) => item.week);
    const shifted = weeks.map((week) => week - weeks[0]);
    const sameTime = sorted.every((item) => item.startTime === sorted[0].startTime && item.endTime === sorted[0].endTime);
    // 夏/冬作息是否一致。注意：**不能要求「连续周必须同一作息」**，否则秋季学期几乎所有课都折不了
    // ——9 月还是夏季作息、10 月已经切成冬季，第 4 周就跨过去了。
    const sameSeason = sorted.every((item) => item.season === sorted[0].season);
    let interval = null;
    if (shifted.every((offset) => offset === shifted.indexOf(offset))) interval = 1; // 连续周
    else if (shifted.every((offset) => offset % 2 === 0)) interval = 2; // 单/双周
    // 折叠条件（保守）：一条 `repeat` 只能有一个固定 startTime。
    // - 连续周（interval 1）：每一次的「开始/结束时刻」都必须一样 —— 允许周次横跨 9→10 月的
    //   作息切换（上午课、节次时长不变的课都在此列），只是不能出现两种 startTime；
    // - 隔周（interval 2）：除了 startTime，`interval:2 + 起点` 还要求整段作息一致，
    //   否则 5-9 月的单双周课会被折叠出漂移半小时的重复日程。
    const foldable = interval === 1 ? sameTime : sameTime && sameSeason;
    if (!interval || !foldable || weeks.length < 2) {
      out.push(...sorted);
      continue;
    }
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    out.push({
      ...first,
      key: first.baseKey,
      weeks,
      action: null,
      payload: {
        ...first.payload,
        externalId: first.baseKey,
        repeat: {
          type: 'weekly',
          weekdays: [first.weekDay],
          interval,
          until: { mode: 'date', date: last.date },
        },
      },
    });
  }
  return out;
}

/**
 * 生成课表同步计划（纯函数）。
 *
 * @param {object} input
 * @param {object[]} input.rows          归一化课表行
 * @param {string}   input.term          学期编号
 * @param {string}   input.termStart     第一周周一
 * @param {string}   input.today         `YYYY-MM-DD`
 * @param {object[]} input.existingSchedules 现有日程（用于幂等判断）
 * @param {object}   [input.options]     { includePast, compact, totalWeeks }
 * @returns {{items:object[], summary:object, skipped:object[]}}
 */
export function buildTimetablePlan({ rows = [], term, termStart, today, existingSchedules = [], options = {} }) {
  const resolved = { includePast: false, compact: false, totalWeeks: undefined, ...options };
  const existingByExternalId = new Map();
  for (const item of existingSchedules) {
    if (isTimetableExternalId(item.externalId)) existingByExternalId.set(item.externalId, item);
  }

  const expanded = expandRows(rows, {
    term,
    termStart,
    today,
    includePast: resolved.includePast,
    totalWeeks: resolved.totalWeeks,
  });

  // 逐周条目先按 externalId 匹配出动作；compact 模式再折叠（「已是最新」的照样折叠，避免切换开关后刷不出差异）
  const prepared = expanded.items.map((item) => finalizeItem(item, existingByExternalId.get(item.key)));
  const candidates = resolved.compact ? compactItems(prepared) : prepared;
  const items = candidates.map((item) => {
    if (resolved.compact && item.action === null) {
      return finalizeItem(item, existingByExternalId.get(item.key));
    }
    return item;
  });

  // 源里已经没有的（老师调课删掉、周次位图改了）→ stale。只认 tt: 前缀，绝不碰用户手改的日程。
  const seenKeys = new Set();
  for (const item of items) {
    seenKeys.add(item.key);
    for (const week of item.weeks ?? [item.week]) seenKeys.add(`${item.baseKey}:${week}`);
  }
  for (const [externalId, existing] of existingByExternalId) {
    if (seenKeys.has(externalId)) continue;
    items.push({
      key: externalId,
      kind: 'schedule',
      action: 'stale',
      existingId: existing.id,
      title: existing.title,
      reason: '课表里已经查不到这条记录了',
      payload: null,
    });
  }

  const summary = { create: 0, update: 0, skip: 0, stale: 0, total: items.length };
  for (const item of items) summary[item.action] = (summary[item.action] ?? 0) + 1;
  return { items, summary, skipped: expanded.skipped, term, termStart, today };
}

/** 今天的 `YYYY-MM-DD`（本地时区），与 shared/time.js 的 todayKey 行为一致。 */
export { weekToDate };
