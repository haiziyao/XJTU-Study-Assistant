/**
 * 课表行 → 「课程块」的合并与分组（纯函数，方便单测）。
 *
 * 两个层次，别混在一起：
 *
 * 1. **合并相邻同名课程**（`mergeRows`）：同一天、同一课程名、节次连续、周次相同
 *    （例如 1-2 节与 3-4 节）→ 一条 1-4 节。这是用户明确要求的：
 *    教务系统经常把一门连堂课拆成两行，日历里不该出现两个相邻的碎块。
 *    不连续（1-2 与 5-6）或有空档时**保持两条**。
 *
 * 2. **按课程分组**（`groupCourses`）：一门课可能一周上多次（周一 1-2、周三 5-6），
 *    但用户勾选的是「这门课」，不是「这个时段」。所以预览里的一个卡片 = 一个课程名，
 *    勾上它就该把它的全部时段都导入。
 *
 * 教师 / 教室不同时的合并策略（题面要求二选一并说明理由）：
 * **仍然合并，教师 / 教室用 " / " 并列**。理由：
 * - 相邻节次属于同一个连续时间块，拆成两行会让日历在 09:50 处多一条断点，
 *   而这通常只是教务把「同一门课换教室 / 换老师」拆行录入，并不是两次独立的课；
 * - 用户勾选与删除都以课程为单位，保持一条也避免「同一门课一半在、一半被删」的中间态。
 * 并列值按节次顺序去重，因此预览里显示稳定，不会因上游行序变化而抖动。
 *
 * 稳定键：`id = "ttc-" + hash8(规范化课程名)`。
 * 为什么用课程名而不是「名 + 教师 + 教室」：日程幂等键（见 to-calendar.js）按题面冻结成
 * `timetable:<学期>:<课程名>:<星期>:<起-止节>:<周次段哈希>`，本来就不含教师 / 教室，
 * 勾选与删除必须用同一套身份，否则会出现「预览选中的 id 与导入后能删掉的 id 对不上」。
 */

import { isValidPeriod } from './periods.js';
import { bitmapToWeeks, weeksToRuns } from './term.js';

/**
 * 参与比较 / 哈希的文本规范化（**已冻结**：改它等于让历史 externalId 失效）。
 *
 * 1. 全角逗号 `，`、顿号 `、` → 半角 `,`；
 * 2. 去所有空白（含全角空格 U+3000）。
 *
 * 为什么冻结：上游同一门课在不同学期 / 不同抓取里可能多一个空格，
 * 键一变就会被当成新课程，重复导入时留下两份。
 */
export function normalizeKeyPart(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\uFF0C\u3001]/g, ',')
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/** 课程分组的规范化键（只做文本规范化，不做大小写折叠 —— 中文课名大小写折叠没有收益，反而可能误并）。 */
export function normalizeCourseKey(courseName) {
  return normalizeKeyPart(courseName);
}

/** 课程稳定 id：`ttc-<8 位十六进制>`。 */
export function courseIdOf(courseName) {
  return `ttc-${hash8(normalizeCourseKey(courseName))}`;
}

/**
 * 零依赖 FNV-1a 32 位哈希，取 8 位十六进制。
 *
 * 为什么不用 `node:crypto`：这里只需要「跨 Node 版本稳定、够短」的标识，
 * 不需要密码学强度；FNV-1a 是纯整数运算，任何平台结果都一样。
 */
export function hash8(input) {
  let hash = 0x811c9dc5;
  const text = String(input ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 乘 16777619 用移位加法实现，避免 32 位溢出后变成浮点误差
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const uniquePush = (list, value) => {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) return;
  if (!list.includes(text)) list.push(text);
};

/**
 * 合并相邻同名课程，并丢弃无法解析的行。
 *
 * @param {object[]} rows normalizeTimetableRow() 的结果
 * @returns {{slots: object[], skipped: object[]}}
 *   slot = {courseName, teacher, location, teacherList, locationList,
 *           weekDay, startPeriod, endPeriod, weeksBitmap, weeks}
 */
export function mergeRows(rows) {
  const skipped = [];
  const groups = new Map();

  for (const row of rows ?? []) {
    const courseName = typeof row?.courseName === 'string' ? row.courseName.trim() : '';
    if (!courseName) {
      skipped.push({ courseName: null, reason: '缺少课程名（KCM 为空）' });
      continue;
    }
    if (!Number.isInteger(row.weekDay) || row.weekDay < 1 || row.weekDay > 7) {
      skipped.push({ courseName, reason: `星期字段不合法（SKXQ=${JSON.stringify(row.weekDay)}）` });
      continue;
    }
    if (!isValidPeriod(row.startPeriod) || !isValidPeriod(row.endPeriod) || row.endPeriod < row.startPeriod) {
      skipped.push({
        courseName,
        reason: `节次字段不合法（KSJC=${JSON.stringify(row.startPeriod)}, JSJC=${JSON.stringify(row.endPeriod)}）`,
      });
      continue;
    }
    const weeks = bitmapToWeeks(row.weeksBitmap);
    if (!weeks.length) {
      skipped.push({ courseName, reason: `周次位图里没有任何一周（SKZC=${JSON.stringify(row.weeksBitmap ?? null)}）` });
      continue;
    }

    // 合并条件里的「周次相同」用**周次集合**比较：位图尾部补零（`"1111"` vs `"11110000"`）
    // 代表同一组周次，不应该因为末尾几个 0 就拆成两条。
    const weeksKey = weeks.join(',');
    const key = `${normalizeCourseKey(courseName)}|${row.weekDay}|${weeksKey}`;
    const list = groups.get(key) ?? [];
    list.push({ row, weeks });
    groups.set(key, list);
  }

  const slots = [];
  for (const list of groups.values()) {
    // 按起始节次排序后线性扫描：只有「下一行紧接着上一行的结束节次」才合并。
    list.sort((a, b) => a.row.startPeriod - b.row.startPeriod || a.row.endPeriod - b.row.endPeriod);
    let current = null;
    for (const { row, weeks } of list) {
      if (current && row.startPeriod === current.endPeriod + 1) {
        current.endPeriod = row.endPeriod;
        uniquePush(current.teacherList, row.teacher);
        uniquePush(current.locationList, row.location);
        continue;
      }
      current = {
        courseName: row.courseName,
        weekDay: row.weekDay,
        startPeriod: row.startPeriod,
        endPeriod: row.endPeriod,
        weeksBitmap: row.weeksBitmap,
        weeks,
        teacherList: [],
        locationList: [],
      };
      uniquePush(current.teacherList, row.teacher);
      uniquePush(current.locationList, row.location);
      slots.push(current);
    }
  }

  return {
    slots: slots
      .map((slot) => ({
        courseName: slot.courseName,
        weekDay: slot.weekDay,
        startPeriod: slot.startPeriod,
        endPeriod: slot.endPeriod,
        weeksBitmap: slot.weeksBitmap,
        weeks: slot.weeks,
        teacherList: slot.teacherList,
        locationList: slot.locationList,
        teacher: slot.teacherList.join(' / ') || null,
        location: slot.locationList.join(' / ') || null,
      }))
      .sort(
        (a, b) =>
          a.weekDay - b.weekDay ||
          a.startPeriod - b.startPeriod ||
          String(a.courseName).localeCompare(String(b.courseName), 'zh-Hans-CN'),
      ),
    skipped,
  };
}

/**
 * 把合并后的时段按「课程名」分组。
 *
 * @param {object[]} slots mergeRows().slots
 * @returns {object[]} course = {
 *   id, name, teacher, location, weekDays:[], periodRange:[start,end],
 *   weeks:{list,runs,min,max}, slots:[...]
 * }
 */
export function groupCourses(slots) {
  const groups = new Map();

  for (const slot of slots ?? []) {
    const key = normalizeCourseKey(slot.courseName);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: courseIdOf(slot.courseName),
        name: slot.courseName.trim(),
        teacherList: [],
        locationList: [],
        weekDays: new Set(),
        weeks: new Set(),
        slots: [],
      };
      groups.set(key, group);
    }
    uniquePush(group.teacherList, slot.teacher);
    uniquePush(group.locationList, slot.location);
    group.weekDays.add(slot.weekDay);
    for (const week of slot.weeks) group.weeks.add(week);
    group.slots.push(slot);
  }

  const courses = [...groups.values()].map((group) => {
    const weeksList = [...group.weeks].sort((a, b) => a - b);
    const slotsSorted = [...group.slots].sort(
      (a, b) => a.weekDay - b.weekDay || a.startPeriod - b.startPeriod || a.endPeriod - b.endPeriod,
    );
    return {
      id: group.id,
      name: group.name,
      teacher: group.teacherList.join(' / ') || null,
      location: group.locationList.join(' / ') || null,
      weekDays: [...group.weekDays].sort((a, b) => a - b),
      // 跨多个时段时给出「最早开始 ~ 最晚结束」，只用于摘要展示；
      // 每个时段自己的节次在 slots / schedulePreviews 里，页面上以它们为准。
      periodRange: [
        Math.min(...slotsSorted.map((slot) => slot.startPeriod)),
        Math.max(...slotsSorted.map((slot) => slot.endPeriod)),
      ],
      weeks: {
        list: weeksList,
        runs: weeksToRuns(weeksList),
        min: weeksList[0] ?? null,
        max: weeksList[weeksList.length - 1] ?? null,
      },
      slots: slotsSorted,
    };
  });

  return courses.sort(
    (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN') || a.id.localeCompare(b.id),
  );
}
