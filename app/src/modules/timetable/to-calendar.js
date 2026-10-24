/**
 * 课表 → 日程的映射（纯函数，方便单测）。
 *
 * ## 为什么一个「周次连续段」写一条日程
 *
 * 日程的 `repeat` 是 `{type:'weekly', interval:1, weekdays:[星期], until:{mode:'date', date}}`，
 * `until` **只能表达一个连续的结束点**。而 `SKZC` 位图可以把周次表达成任意集合
 * （`1-8 周 + 10-16 周`、单双周、临时停课……）。所以：
 *
 * - `1-8 与 10-16` 必须拆成**两条**日程（一条到第 8 周、一条从第 10 周到第 16 周）；
 * - 连续段内部的每周由 `repeat` 自动展开，不再逐周写一条（否则 16 周 × 十几门课
 *   会在日历里堆出几百条重复记录，改一次时间还要改几百条）。
 *
 * 这也是为什么 `externalId` 里要带「周次段」标识：同一条课（同课程/星期/节次）的不同周次段
 * 是两条独立日程，幂等键必须能区分它们，否则第二次导入会用第 10-16 周那条覆盖掉第 1-8 周。
 *
 * ## 为什么 externalId 长这样
 *
 * `timetable:<学期>:<课程名>:<星期>:<起-止节>:<周次段哈希>`
 *
 * - **确定性**：全部由学校给的事实（学期、课名、星期、节次、周次段）算出，
 *   同一份课表重复导入一定得到同一个键 → 只更新、不重复；
 * - **带学期**：换学期导入不会覆盖旧学期的日程；
 * - **带周次段哈希**：跨段课程的两条日程互不覆盖；哈希只认**段起点**，
 *   所以把 `untilWeek` 从 18 调到 8 时是同一条日程被 update，而不是"新建 + 删旧"；
 * - **不含教师 / 教室**：它们是易变字段（换老师、调教室很常见），
 *   不能因为老师变了就变成一条新日程、把旧日程留在日历里；
 * - **课程名做规范化**（去空白、统一全半角标点）：上游格式漂移不会造成重复。
 *
 * ## 作息切换日（5/1、10/1）必须切开
 *
 * 官方作息每学年两套、切换日是 5 月 1 日与 10 月 1 日（第 5 节起相差 30 分钟，
 * 见 periods.js 的文件头）。而一条 `repeat` 日程只能有**一个**固定 `startTime`：
 * 一个「周次连续段」如果从 9 月跨到 10 月，日历要么整段按夏季、要么整段按冬季，
 * 另一半日期必然错半小时 —— 秋季学期第 1 周导入的下午课，到了第 10 周还在用 14:30。
 *
 * 解决办法是**在写日程之前**把这种段沿切换日切成两段（必要时多段），每段用自己的作息，
 * 代价只是一门课在预览 / 日历里多出一两条日程。上午课（第 1-4 节）两套时刻完全相同，
 * 切了也只会多一条一模一样的时间，所以不切。
 *
 * ### 为什么按「周」切，而不是按天
 *
 * `repeat.until` 只能表达连续周次，`startTime` 又是一个日程一个值。要按天切，
 * 就得把「同一星期几、第 3 周 14:30、第 4 周 14:00」写成两条同 `weekdays` 的日程；
 * 而 `repeat` 无法表达「这条只到 10/1 为止、那条从 10/2 开始」，最后只能退化成逐周写，
 * 16 周 × 十几门课就是几百条重复记录。按周切是 `repeat` 能表达的最小粒度，
 * 也保证每一段的 `weeks:{start,end}` 仍然连续（见 splitRunBySeason 的说明）。
 *
 * ### 周内切换按「该周周一」判定
 *
 * 一周的课表在排课 / 校历里是整体（周次按周数），所以整周统一用「周一所在作息」：
 * 周一在 5~9 月 → 整周夏季；周一在 10~4 月 → 整周冬季。
 * 这样同一周里所有课程、所有星期几的口径一致，结果稳定可复现。
 * 代价：5/1 或 10/1 落在周中时，切换日之后那几天仍沿用周一的作息（最多错半小时、最多一周）；
 * 对比旧做法「整段用段首那天的作息」，误差从「整个后半学期」缩小到「切换日所在的那一周」。
 *
 * ## 只删 `timetable:` 前缀
 *
 * 删除接口只处理 `externalId` 以 `timetable:` 开头、且 `source === 'import'` 的日程。
 * 用户手建的日程（`source: 'manual'`、没有 externalId）**永远不会**被这个模块碰到，
 * 哪怕同一天同一时段、哪怕课程名相同 —— 前缀是「这条记录归课表导入管」的唯一凭证。
 */

import {
  FIRST_SEASON_SENSITIVE_PERIOD,
  SEASON_LABEL,
  getClassTimeOfSeason,
  isValidPeriod,
  seasonOfDate,
} from './periods.js';
import { courseIdOf, hash8, normalizeKeyPart } from './merge.js';
import { describeWeeks, weekToDate, weeksToRuns } from './term.js';

/** 本模块写入日程的 externalId 前缀（删除 / 幂等匹配的唯一依据）。 */
export const EXTERNAL_ID_PREFIX = 'timetable:';

/** 是否本模块产生的记录。 */
export function isTimetableExternalId(externalId) {
  return typeof externalId === 'string' && externalId.startsWith(EXTERNAL_ID_PREFIX);
}

const WEEKDAY_CN = Object.freeze([null, '周一', '周二', '周三', '周四', '周五', '周六', '周日']);

/**
 * 周次段哈希：同一时段的连续段互不重叠，**起点唯一**，所以只哈希起点。
 *
 * 为什么不把终点也哈希进去：用户把「导入到第几周」从 18 调到 8 时，
 * 终点变化会让整条日程换一个键 —— 表现成「旧日程被删、新日程新建」，
 * 而用户的本意只是「同一条课少导入几周」。只认起点，截断就落到 update 上。
 *
 * 反过来，如果上游把 1-16 周拆成 1-8 + 10-16，第一段起点仍是 1（update），
 * 第二段起点是 10（create），也不会重复。
 *
 * 作息切换切出来的两段同样靠「起点不同」区分：切点一定落在两个不同的周次上
 * （例如 1-16 周切成 1-3 与 4-16），所以第二段不会被当成第一段的重复而覆盖。
 */
export function runHash(run) {
  return hash8(`w${run.start}`);
}

/**
 * 一条「课程 + 星期 + 节次 + 周次段」的幂等键。
 * @param {{term:string, courseName:string, weekDay:number, startPeriod:number, endPeriod:number, run:{start:number,end:number}}} input
 */
export function externalIdFor({ term, courseName, weekDay, startPeriod, endPeriod, run }) {
  const name = normalizeKeyPart(courseName) || '未命名课程';
  return `${EXTERNAL_ID_PREFIX}${term}:${name}:${weekDay}:${startPeriod}-${endPeriod}:${runHash(run)}`;
}

/**
 * 把一个「周次连续段」沿作息切换日（5/1、10/1）切成若干段，每段整段用同一套作息。
 *
 * 规则：
 * 1. 只有**含第 5 节及以后**的课才可能受影响（第 1-4 节两套时刻逐值相同，切了只是多一条）；
 * 2. 以**该周周一**的日期判定整周作息（周一在 5~9 月 → 夏季，10~4 月 → 冬季）；
 * 3. 返回的每一段仍是**连续周次**，供 `repeat.until` 表达。
 *
 * 为什么必须切：一条 `repeat` 日程只有一个固定 `startTime`，不切就会让切换日之后的
 * 所有周次沿用旧作息，整段错半小时（详见文件头）。切出来的段起点各不相同，
 * 因此 externalId 的周次段哈希天然不同，不会互相覆盖（见 runHash 的说明）。
 *
 * 为什么按周对齐、周内按周一判定：见文件头「为什么按周切」「周内切换按该周周一判定」。
 *
 * @param {object} input
 * @param {string} input.termStart 第一周周一
 * @param {number} input.startPeriod 起始节次
 * @param {number} input.endPeriod 结束节次
 * @param {{start:number,end:number}} input.run 周次连续段
 * @returns {{run:{start:number,end:number}, season:'summer'|'winter'}[]} 至少一段
 */
export function splitRunBySeason({ termStart, startPeriod, endPeriod, run } = {}) {
  const start = Number(run?.start);
  const end = Number(run?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`周次段不合法：${JSON.stringify(run)}`);
  }
  const rangeStart = Number(startPeriod);
  const rangeEnd = Number(endPeriod);
  if (!isValidPeriod(rangeStart) || !isValidPeriod(rangeEnd) || rangeEnd < rangeStart) {
    throw new Error(`节次范围不合法：${JSON.stringify({ startPeriod, endPeriod })}`);
  }

  // 上午课：两套作息表第 1-4 节完全相同，切开只会在日历里多一条一模一样时间的日程。
  if (rangeEnd < FIRST_SEASON_SENSITIVE_PERIOD) {
    return [{ run: { start, end }, season: seasonOfWeek(termStart, start) }];
  }

  const segments = [];
  for (let week = start; week <= end; week += 1) {
    const season = seasonOfWeek(termStart, week);
    const last = segments[segments.length - 1];
    if (last && last.season === season) {
      last.run.end = week;
    } else {
      segments.push({ run: { start: week, end: week }, season });
    }
  }
  return segments;
}

/** 第 `week` 周属于哪套作息：按该周**周一**的日期判定（整周口径统一）。 */
function seasonOfWeek(termStart, week) {
  return seasonOfDate(weekToDate(termStart, week, 1));
}

/**
 * 解析本模块写的 externalId。结构对不上返回 null（例如上游 / 旧版本写坏的数据），
 * 调用方据此决定「跳过」而不是「猜一个课程名去删」。
 */
export function parseExternalId(externalId) {
  if (!isTimetableExternalId(externalId)) return null;
  const matched = /^timetable:(\d{4}-\d{4}-[123]):(.+):([1-7]):(\d{1,2})-(\d{1,2}):([0-9a-f]{8})$/.exec(
    externalId,
  );
  if (!matched) return null;
  const [, term, courseName, weekDay, startPeriod, endPeriod] = matched;
  return {
    term,
    courseName,
    weekDay: Number(weekDay),
    startPeriod: Number(startPeriod),
    endPeriod: Number(endPeriod),
    courseId: courseIdOf(courseName),
  };
}

function clipTitle(courseName) {
  const text = String(courseName ?? '').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function describeCourse(course, slot, run, time) {
  const lines = [`课程：${course.name}`];
  if (course.teacher) lines.push(`教师：${course.teacher}`);
  if (slot.location) lines.push(`教室：${slot.location}`);
  lines.push(
    `时间：${WEEKDAY_CN[slot.weekDay]} 第 ${slot.startPeriod}-${slot.endPeriod} 节（${time.startTime}-${time.endTime}，${SEASON_LABEL[time.season]}）`,
  );
  lines.push(`周次：${describeWeeks(rangeToWeeks(run))}`);
  return lines.join('\n');
}

/** `{start,end}` → `[start..end]`，只用于描述文字。 */
function rangeToWeeks(run) {
  const weeks = [];
  for (let week = run.start; week <= run.end; week += 1) weeks.push(week);
  return weeks;
}

/** 写进日程的 tags：`imported` 分组靠 `weeks:` 标签还原周次范围（不需要再问学校）。 */
function tagsFor({ term, slot, run }) {
  return [
    '课表',
    'timetable',
    `term:${term}`,
    `weekday:${slot.weekDay}`,
    `periods:${slot.startPeriod}-${slot.endPeriod}`,
    `weeks:${run.start}-${run.end}`,
    slot.teacher ? `teacher:${slot.teacher}` : null,
  ].filter(Boolean);
}

/**
 * 预览与导入共用的规划：每个「时段 × 周次连续段」先按作息切换日切分，
 * 再逐段算出日期、时刻、幂等键与说明字段。
 *
 * 预览和写入**必须走同一个规划函数**，否则会出现「预览说 2 条、导入后 3 条」。
 * 切分规则见 splitRunBySeason；上午课不切，所以绝大多数课程仍然是一段一条。
 *
 * @param {object} course groupCourses() 的一项（带 term）
 * @param {{termStart:string}} options
 * @returns {{previews:object[], seasonSplit:object|null}}
 */
function planCourseSegments(course, { termStart } = {}) {
  const previews = [];
  const seen = new Set();
  const splitGroups = [];
  const splitSeen = new Set();

  for (const slot of course.slots ?? []) {
    for (const run of weeksToRuns(slot.weeks)) {
      const segments = splitRunBySeason({
        termStart,
        startPeriod: slot.startPeriod,
        endPeriod: slot.endPeriod,
        run,
      });
      const parts = [];
      for (const segment of segments) {
        const date = weekToDate(termStart, segment.run.start, slot.weekDay);
        const time = getClassTimeOfSeason(slot.startPeriod, slot.endPeriod, segment.season);
        const part = {
          weeks: { start: segment.run.start, end: segment.run.end },
          season: time.season,
          date,
          startTime: time.startTime,
          endTime: time.endTime,
        };
        parts.push(part);
        const externalId = externalIdFor({
          term: course.term ?? '',
          courseName: course.name,
          weekDay: slot.weekDay,
          startPeriod: slot.startPeriod,
          endPeriod: slot.endPeriod,
          run: segment.run,
        });
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        previews.push({
          weekDay: slot.weekDay,
          ...part,
          periodRange: [slot.startPeriod, slot.endPeriod],
        });
      }
      if (segments.length > 1) {
        // 说明字段给前端 / API 消费者看：这条课为什么多出日程、每段覆盖哪些周、用什么作息。
        // 与预览用同一份 parts，避免「说明里 2 段、条数却对不上」。
        const key = `${slot.weekDay}|${slot.startPeriod}-${slot.endPeriod}|${parts
          .map((part) => `${part.weeks.start}-${part.weeks.end}`)
          .join(',')}`;
        if (!splitSeen.has(key)) {
          splitSeen.add(key);
          splitGroups.push({
            weekDay: slot.weekDay,
            periodRange: [slot.startPeriod, slot.endPeriod],
            parts,
          });
        }
      }
    }
  }

  previews.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  if (!splitGroups.length) return { previews, seasonSplit: null };
  const segments = splitGroups.reduce((total, group) => total + group.parts.length, 0);
  return {
    previews,
    seasonSplit: {
      /** 被作息切换切开的原始「连续周次段」数量。 */
      runs: splitGroups.length,
      /** 这些原始段切分后对应的日程条数（通常 = runs + 1，必要时更多）。 */
      segments,
      /** 因切分多出来的日程条数（eventCount 会比不切时多这么多）。 */
      extraEvents: segments - splitGroups.length,
      /** 每一处切分的细节：星期、节次、各段的周次 / 作息 / 首日 / 首末时刻。 */
      groups: splitGroups,
    },
  };
}

/**
 * 预览里每个课程卡片的「会写入哪些日程」。
 *
 * 每条 = 一个时段的一个周次段（也就是将来的一条日程）；作息切换日会再切一次，
 * 所以一条下午课可能对应两条（详见文件头）。`weeks` 用 `{start,end}` 而不是数组，
 * 因为 `repeat.until` 表达的就是这个连续区间。
 *
 * @param {object} course groupCourses() 的一项
 * @param {{termStart:string}} options
 */
export function buildSchedulePreviews(course, options = {}) {
  return planCourseSegments(course, options).previews;
}

/**
 * 给课程卡片补上 eventCount / schedulePreviews / seasonSplit，供 `GET /timetable/preview` 直接返回。
 * `term` 只在生成 externalId 时用；预览响应里的课程对象本身不重复存它。
 * `seasonSplit` 只在真的被作息切换切开时出现；没切过的课程保持原形状。
 */
export function decorateCourse(course, { term, termStart }) {
  const withTerm = { ...course, term };
  const { previews, seasonSplit } = planCourseSegments(withTerm, { termStart });
  const decorated = {
    ...course,
    eventCount: previews.length,
    schedulePreviews: previews,
  };
  if (seasonSplit) decorated.seasonSplit = seasonSplit;
  return decorated;
}

/**
 * 一门课要写入的日程草稿（按周次段拆分，已按 `untilWeek` 截断）。
 *
 * @param {object} course groupCourses() 的一项
 * @param {object} options
 * @param {string} options.term 学期编号
 * @param {string} options.termStart 第一周周一
 * @param {number} [options.untilWeek] 只导入 ≤ N 的周次；截断后空的时段不产事件
 * @returns {{events:object[], skipped:object[]}}
 */
export function buildEventsForCourse(course, { term, termStart, untilWeek } = {}) {
  const events = [];
  const skipped = [];
  const seen = new Set();

  for (const slot of course.slots ?? []) {
    const weeks = (slot.weeks ?? []).filter((week) => untilWeek === undefined || untilWeek === null || week <= untilWeek);
    if (!weeks.length) {
      skipped.push({
        courseId: course.id,
        courseName: course.name,
        weekDay: slot.weekDay,
        periodRange: [slot.startPeriod, slot.endPeriod],
        reason: `导入到第 ${untilWeek} 周后没有可写入的周次`,
      });
      continue;
    }
    for (const run of weeksToRuns(weeks)) {
      // 先沿作息切换日切开：每段整段一套作息，避免「整段用段首作息」让后半学期错半小时。
      let segments;
      try {
        segments = splitRunBySeason({
          termStart,
          startPeriod: slot.startPeriod,
          endPeriod: slot.endPeriod,
          run,
        });
      } catch (error) {
        skipped.push({
          courseId: course.id,
          courseName: course.name,
          weekDay: slot.weekDay,
          periodRange: [slot.startPeriod, slot.endPeriod],
          reason: `节次时间换算失败：${error.message}`,
        });
        continue;
      }

      for (const segment of segments) {
        const date = weekToDate(termStart, segment.run.start, slot.weekDay);
        const lastDate = weekToDate(termStart, segment.run.end, slot.weekDay);
        // 时刻按**切分后的段**取表：段内作息一致，不再用段首日期反推（见 periods.js）。
        const time = getClassTimeOfSeason(slot.startPeriod, slot.endPeriod, segment.season);
        const externalId = externalIdFor({
          term,
          courseName: course.name,
          weekDay: slot.weekDay,
          startPeriod: slot.startPeriod,
          endPeriod: slot.endPeriod,
          run: segment.run,
        });
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        events.push({
          externalId,
          courseId: course.id,
          courseName: course.name,
          weekDay: slot.weekDay,
          periodRange: [slot.startPeriod, slot.endPeriod],
          weeks: { start: segment.run.start, end: segment.run.end },
          date,
          payload: {
            title: clipTitle(course.name),
            // 日程字段有长度上限（title 120 / description 2000 / location 120）；
            // 上游脏数据（超长教室名、同名课拼出很长的教师串）不该让整批导入 400。
            description: describeCourse(course, slot, segment.run, time).slice(0, 2000),
            category: 'class',
            date,
            startTime: time.startTime,
            endTime: time.endTime,
            location: String(slot.location ?? '').slice(0, 120),
            tags: tagsFor({ term, slot, run: segment.run }),
            repeat: {
              type: 'weekly',
              interval: 1,
              weekdays: [slot.weekDay],
              // repeat.until 只能是连续区间 —— 这就是「周次跨段必须拆多条」的根因；
              // 作息切换也按周切，切出来的段同样能用一个 until 表达。
              until: { mode: 'date', date: lastDate },
            },
            source: 'import',
            externalId,
          },
        });
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.payload.startTime.localeCompare(b.payload.startTime));
  return { events, skipped };
}

/** 从日程 tags 里还原它覆盖的周次（导入时写入 `weeks:a-b`）。 */
export function weeksFromTags(tags) {
  const weeks = new Set();
  for (const tag of tags ?? []) {
    const matched = /^weeks:(\d{1,2})-(\d{1,2})$/.exec(String(tag));
    if (!matched) continue;
    const start = Number(matched[1]);
    const end = Number(matched[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) continue;
    for (let week = start; week <= end; week += 1) weeks.add(week);
  }
  return [...weeks].sort((a, b) => a - b);
}

/**
 * 已导入日程 → 按课程分组（纯函数）。
 *
 * 周次从 tags 里的 `weeks:a-b` 还原，而不是拿 `date` 反推：
 * 后者需要学期起始日，而查看「已导入」不应该要求用户先登录。
 *
 * @param {object[]} schedules store.schedules.all()
 * @param {{term?:string}} [options]
 * @returns {{total:number, courses:object[]}}
 */
export function groupImportedSchedules(schedules, { term } = {}) {
  const groups = new Map();
  let total = 0;

  for (const item of schedules ?? []) {
    // 双保险：前缀 + source。两者都满足才归本模块管。
    if (item?.source !== 'import' || !isTimetableExternalId(item.externalId)) continue;
    const parsed = parseExternalId(item.externalId);
    if (!parsed) continue;
    if (term && parsed.term !== term) continue;

    total += 1;
    const key = `${parsed.term}|${parsed.courseId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: parsed.courseId,
        name: item.title || parsed.courseName,
        term: parsed.term,
        count: 0,
        externalIds: [],
        scheduleIds: [],
        weekDays: new Set(),
        weeks: new Set(),
        periods: [],
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.externalIds.push(item.externalId);
    group.scheduleIds.push(item.id);
    group.weekDays.add(parsed.weekDay);
    group.periods.push([parsed.startPeriod, parsed.endPeriod]);
    for (const week of weeksFromTags(item.tags)) group.weeks.add(week);
  }

  const courses = [...groups.values()]
    .map((group) => {
      const weeksList = [...group.weeks].sort((a, b) => a - b);
      return {
        id: group.id,
        name: group.name,
        term: group.term,
        count: group.count,
        externalIds: group.externalIds,
        scheduleIds: group.scheduleIds,
        weekDays: [...group.weekDays].sort((a, b) => a - b),
        periodRange: [Math.min(...group.periods.map((p) => p[0])), Math.max(...group.periods.map((p) => p[1]))],
        weeks: {
          list: weeksList,
          runs: weeksToRuns(weeksList),
          min: weeksList[0] ?? null,
          max: weeksList[weeksList.length - 1] ?? null,
        },
        weeksText: describeWeeks(weeksList),
      };
    })
    .sort(
      (a, b) =>
        String(a.term).localeCompare(String(b.term)) ||
        String(a.name).localeCompare(String(b.name), 'zh-Hans-CN') ||
        a.id.localeCompare(b.id),
    );

  return { total, courses };
}
