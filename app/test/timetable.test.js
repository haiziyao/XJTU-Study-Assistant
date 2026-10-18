/**
 * 课表导入模块：解析 / 合并 / 周次拆分 / 导入幂等 / 删除安全边界 / 错误语义。
 *
 * 全程走 `test/helpers/timetable-mock.js`（本地假 ehall + CAS），**零真实外网**。
 * 假服务器刻意复刻真机行为：未登录时 jwapp 接口 302 到 CAS 登录页（不是 401），
 * 成功码是字符串 `"0"`，课表行字段是全大写拼音缩写。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { EhallApi, TIMETABLE_ERROR, normalizeTimetableRow, parseEhallDate } from '../src/modules/timetable/api.js';
import { candidateTerms, resolveTimetableConfig, termLabel } from '../src/modules/timetable/config.js';
import { courseIdOf, groupCourses, mergeRows } from '../src/modules/timetable/merge.js';
import {
  bitmapToWeeks,
  describeWeeks,
  guessTermStart,
  isoWeekday,
  parseTerm,
  termLength,
  weekToDate,
  weeksToRuns,
} from '../src/modules/timetable/term.js';
import {
  buildEventsForCourse,
  decorateCourse,
  externalIdFor,
  groupImportedSchedules,
  isTimetableExternalId,
  parseExternalId,
} from '../src/modules/timetable/to-calendar.js';
import { defaultTimetableRows, startMockTimetable } from './helpers/timetable-mock.js';

const TERM = '2026-2027-1';
const TERM_START = '2026-09-07';

/* ------------------------------------------------------------------ 小工具 */

/** 归一化行（与 normalizeTimetableRow 的输出同形）。 */
function row(overrides = {}) {
  return {
    courseName: '高等数学',
    teacher: '张老师',
    location: '主A-101',
    weekDay: 1,
    startPeriod: 1,
    endPeriod: 2,
    weeksBitmap: '111111110000000000',
    term: TERM,
    ...overrides,
  };
}

/**
 * 用假的 http 客户端构造 EhallApi（不需要起服务器）。
 *
 * 现在业务请求前要先过 jwapp 授权握手，所以假客户端必须同时支持：
 * - `get(应用页)` → 带 `_JW_INIT_CONFIG` 的 HTML（可取到 appId）；
 * - `get(getAppConfig)` → JSON；
 * - `postForm(appInit)` → `{code:"0"}`；
 * - 其余 `postForm` → 测试指定的业务响应。
 */
function apiReturning(
  text,
  { status = 200, url = 'https://ehall.xjtu.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do', appId = '4770397878132218' } = {},
) {
  const config = resolveTimetableConfig({ baseUrl: 'https://ehall.xjtu.edu.cn' });
  const http = {
    async get(target) {
      if (String(target).includes('/jwapp/sys/funauthapp/api/getAppConfig/')) {
        return { status: 200, url: target, text: '{"APP_ID":"4770397878132218","MODULES":[]}' };
      }
      const appPage = `<html><script>window._JW_INIT_CONFIG = {"appId":"${appId}"};</script></html>`;
      return { status: 200, url: target, text: appPage };
    },
    async postForm(target) {
      if (String(target).includes('/jwpubapp/')) return { status: 200, url: target, text: '{"code":"0","datas":{}}' };
      return { status, url, text };
    },
  };
  return new EhallApi({ http, config });
}

async function startApp(mock) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-timetable-'));
  const app = await createServer({ dataDir, timetable: mock.config() });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  return { app, info, call, dataDir };
}

async function loggedIn(options = {}) {
  const mock = await startMockTimetable(options);
  const ctx = await startApp(mock);
  const result = await ctx.app.services.auth.login({
    username: '2024001',
    password: 'secret-pass',
    siteId: 'timetable',
  });
  assert.equal(result.status, 'ready', `登录应成功：${JSON.stringify(result).slice(0, 300)}`);
  return { ...ctx, mock };
}

const timetableSchedules = (app) =>
  app.store.schedules.all().filter((item) => isTimetableExternalId(item.externalId));

/* ------------------------------------------------------------------ 解析与外壳 */

test('timetable：行字段归一化（大小写敏感）+ 日期解析', () => {
  const raw = defaultTimetableRows()[0];
  // 夹具钉住真实字段名：上游就是这套大写拼音缩写，大小写漂移会让整张课表变成空
  for (const key of ['KCM', 'SKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'XNXQDM']) {
    assert.ok(Object.hasOwn(raw, key), `真实夹具应包含字段 ${key}`);
  }
  const normalized = normalizeTimetableRow(raw);
  assert.equal(normalized.courseName, '高等数学');
  assert.equal(normalized.teacher, '张老师');
  assert.equal(normalized.location, '主A-101');
  assert.equal(normalized.weekDay, 1);
  assert.equal(normalized.startPeriod, 1);
  assert.equal(normalized.endPeriod, 2);
  assert.equal(normalized.weeksBitmap, '111111110000000000');
  assert.equal(normalized.term, TERM);
  // 上游多给的字段（KCH / *_DISPLAY）不臆造成内部字段
  assert.equal(Object.hasOwn(normalized, 'KCH'), false);

  // 小写字段名不是同一套协议 → 直接丢弃，避免「看起来解析成功、其实全是 null」
  assert.equal(normalizeTimetableRow({ kcm: '高等数学', skxq: '1' }), null);
  assert.equal(normalizeTimetableRow({ KCM: '   ' }), null);
  assert.equal(normalizeTimetableRow(null), null);

  assert.equal(parseEhallDate('2026-09-07 00:00:00'), '2026-09-07');
  assert.equal(parseEhallDate('2026/9/7'), '2026-09-07');
  assert.equal(parseEhallDate(''), null);
});

test('timetable：响应外壳 —— code 是字符串 "0"，非 0 是业务错误且不带 HTML', async () => {
  const ok = await apiReturning(
    JSON.stringify({ code: '0', datas: { xskcb: { rows: [defaultTimetableRows()[0]] } } }),
  ).timetableRows(TERM);
  assert.equal(ok.length, 1, '字符串 "0" 必须被接受');

  // 数字 0 也兼容（String(0) === '0'）；但 "1" / 1 一律拒绝
  const numeric = await apiReturning(JSON.stringify({ code: 0, datas: { xskcb: { rows: [] } } })).timetableRows(TERM);
  assert.deepEqual(numeric, []);

  // 数字 0 也兼容（String(0) === '0'），但 "1" / 1 一律拒绝
  await assert.rejects(
    apiReturning(JSON.stringify({ code: '1', msg: '<b>选课数据异常</b>', datas: null })).timetableRows(TERM),
    (error) => {
      assert.equal(error.code, TIMETABLE_ERROR.EHALL_ERROR);
      assert.match(error.message, /xskcb\.do/);
      assert.match(error.message, /code="1"/);
      assert.match(error.message, /选课数据异常/);
      assert.doesNotMatch(error.message, /<b>/, '上游 HTML 不能原样透给前端');
      assert.equal(error.details.code, '1');
      return true;
    },
  );

  await assert.rejects(apiReturning(JSON.stringify({ code: '0' })).timetableRows(TERM), /缺少 datas/);
  await assert.rejects(apiReturning('<html>整页 HTML</html>').timetableRows(TERM), /不是 JSON/);
});

test('timetable：上游 500 带原始路径；302 到 CAS 视为未登录（不是"没有课"）', async () => {
  await assert.rejects(
    apiReturning('<html>500</html>', { status: 500 }).timetableRows(TERM),
    (error) => {
      assert.equal(error.code, TIMETABLE_ERROR.EHALL_ERROR);
      assert.match(error.message, /xskcb\.do/);
      assert.equal(error.details.status, 500);
      return true;
    },
  );

  await assert.rejects(
    apiReturning('<html><form><input name="execution" value="e1"></form></html>', {
      status: 200,
      url: 'https://ehall.xjtu.edu.cn/cas/login?service=x',
    }).timetableRows(TERM),
    (error) => {
      assert.equal(error.code, TIMETABLE_ERROR.NOT_LOGGED_IN);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('timetable：当前学期与学期起始日接口', async () => {
  const termApi = apiReturning(JSON.stringify({ code: '0', datas: { dqxnxq: { rows: [{ DM: TERM }] } } }));
  assert.equal(await termApi.currentTerm(), TERM);

  const startApi = apiReturning(
    JSON.stringify({ code: '0', datas: { cxjcs: { rows: [{ XQKSRQ: `${TERM_START} 00:00:00` }] } } }),
  );
  assert.deepEqual(await startApi.termStartDate(TERM), { startDate: TERM_START, raw: `${TERM_START} 00:00:00` });

  // 历史学期 cxjcs 为空是**预期内**的，返回 null 让上层用本地推断兜底
  const emptyApi = apiReturning(JSON.stringify({ code: '0', datas: { cxjcs: { rows: [] } } }));
  assert.equal((await emptyApi.termStartDate(TERM)).startDate, null);
});

/* ------------------------------------------------------------------ 周次 */

test('timetable：SKZC 位图 → 周次列表 → 连续段', () => {
  assert.deepEqual(bitmapToWeeks('111111110000000000'), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(bitmapToWeeks('111111110111111100'), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(bitmapToWeeks(''), []);
  assert.deepEqual(bitmapToWeeks(null), []);
  // 只认 '1'，其它字符（含空格）都当不上课
  assert.deepEqual(bitmapToWeeks('101 1'), [1, 3, 5]);

  assert.deepEqual(weeksToRuns([1, 2, 3, 4, 7, 8]), [
    { start: 1, end: 4 },
    { start: 7, end: 8 },
  ]);
  assert.deepEqual(weeksToRuns([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]), [
    { start: 1, end: 8 },
    { start: 10, end: 16 },
  ]);
  assert.deepEqual(weeksToRuns([]), []);
  assert.equal(describeWeeks([1, 2, 3, 8, 9]), '第1-3,8-9周');
});

test('timetable：学期编号、候选学期（前后各 3 个）与起始日推断', () => {
  const parts = parseTerm(TERM);
  assert.equal(parts.academicYear, '2026-2027');
  assert.equal(parts.index, 1);
  assert.equal(termLength(parts), 18);
  assert.equal(termLength('2026-2027-3'), 8);
  assert.equal(termLabel('2026-2027-1'), '2026-2027 学年 · 第 1 学期');
  assert.equal(termLabel('2026-2027-3'), '2026-2027 学年 · 小学期');

  const terms = candidateTerms(TERM, 3);
  assert.equal(terms.length, 7, '前后各 3 个 + 当前 = 7');
  assert.ok(terms.includes('2025-2026-3'));
  assert.ok(terms.includes('2027-2028-1'));

  // cxjcs 拿不到时的兜底必须是周一
  assert.equal(isoWeekday(guessTermStart(TERM)), 1);
  assert.equal(isoWeekday(guessTermStart('2026-2027-2')), 1);
  assert.equal(weekToDate(TERM_START, 8, 3), '2026-10-28');
});

/* ------------------------------------------------------------------ 合并 */

test('timetable：相邻同名课程合并成一条（1-2 + 3-4 → 1-4）', () => {
  const { slots, skipped } = mergeRows([row(), row({ startPeriod: 3, endPeriod: 4 })]);
  assert.equal(skipped.length, 0);
  assert.equal(slots.length, 1);
  assert.deepEqual([slots[0].startPeriod, slots[0].endPeriod], [1, 4]);
  assert.deepEqual(slots[0].weeks, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('timetable：不连续（1-2 与 5-6）≠ 合并；不同课程名 / 不同周次也不合并', () => {
  const nonAdjacent = mergeRows([row(), row({ startPeriod: 5, endPeriod: 6 })]);
  assert.equal(nonAdjacent.slots.length, 2);

  const differentName = mergeRows([row(), row({ courseName: '大学物理', startPeriod: 3, endPeriod: 4 })]);
  assert.equal(differentName.slots.length, 2);

  const differentWeeks = mergeRows([
    row(),
    row({ startPeriod: 3, endPeriod: 4, weeksBitmap: '111111111111111100' }),
  ]);
  assert.equal(differentWeeks.slots.length, 2);

  const differentDay = mergeRows([row(), row({ weekDay: 2, startPeriod: 3, endPeriod: 4 })]);
  assert.equal(differentDay.slots.length, 2);
});

test('timetable：教师 / 教室不同的相邻节次仍合并（" / " 并列，理由见 merge.js）', () => {
  const { slots } = mergeRows([
    row(),
    row({ startPeriod: 3, endPeriod: 4, teacher: '李老师', location: '主B-203' }),
  ]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].teacher, '张老师 / 李老师');
  assert.equal(slots[0].location, '主A-101 / 主B-203');
});

test('timetable：非法行被跳过，不产出"没有时间"的日程', () => {
  const { slots, skipped } = mergeRows([
    row({ weekDay: 9 }),
    row({ startPeriod: 0 }),
    row({ weeksBitmap: '000000000000000000' }),
    row({ courseName: '' }),
    row(),
  ]);
  assert.equal(slots.length, 1);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((item) => typeof item.reason === 'string' && item.reason.length > 0));
});

test('timetable：课程分组 —— 一门课多个时段合成一张卡片，id 稳定', () => {
  const { slots } = mergeRows([
    row(),
    row({ startPeriod: 3, endPeriod: 4 }),
    row({ weekDay: 3, startPeriod: 5, endPeriod: 6 }),
  ]);
  const courses = groupCourses(slots);
  assert.equal(courses.length, 1);
  const [course] = courses;
  assert.equal(course.id, courseIdOf('高等数学'));
  assert.deepEqual(course.weekDays, [1, 3]);
  assert.deepEqual(course.periodRange, [1, 6]);
  assert.equal(course.slots.length, 2, '周一 1-4 是一段、周三 5-6 是另一段');
  assert.equal(course.weeks.max, 8);
});

/* ------------------------------------------------------------------ 周次跨段 / 截断 */

test('timetable：周次跨段 1-8 与 10-16 → 两条日程，repeat.until 各自正确', () => {
  const { slots } = mergeRows([
    row({ courseName: '程序设计', weekDay: 3, startPeriod: 1, endPeriod: 2, weeksBitmap: '111111110111111100' }),
  ]);
  const [course] = groupCourses(slots);
  const decorated = decorateCourse(course, { term: TERM, termStart: TERM_START });
  assert.equal(decorated.eventCount, 2);
  assert.deepEqual(decorated.schedulePreviews.map((item) => item.weeks), [
    { start: 1, end: 8 },
    { start: 10, end: 16 },
  ]);
  assert.equal(decorated.schedulePreviews[0].date, '2026-09-09');
  assert.equal(decorated.schedulePreviews[1].date, '2026-11-11');

  const { events } = buildEventsForCourse(course, { term: TERM, termStart: TERM_START });
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.repeat.until.date, '2026-10-28', '第 8 周周三');
  assert.equal(events[1].payload.repeat.until.date, '2026-12-23', '第 16 周周三');
  assert.equal(events[0].payload.repeat.type, 'weekly');
  assert.deepEqual(events[0].payload.repeat.weekdays, [3]);
  assert.notEqual(events[0].externalId, events[1].externalId, '两条日程的幂等键必须不同');
});

test('timetable：untilWeek=8 截断 —— 后半段去掉；整门被截掉的课进 skipped', () => {
  const { slots } = mergeRows([
    row({ courseName: '程序设计', weekDay: 3, startPeriod: 1, endPeriod: 2, weeksBitmap: '111111110111111100' }),
    row({ courseName: '物理实验', weekDay: 4, startPeriod: 9, endPeriod: 10, weeksBitmap: '000000000111111100' }),
  ]);
  const courses = groupCourses(slots);
  const programming = courses.find((course) => course.name === '程序设计');
  const experiment = courses.find((course) => course.name === '物理实验');

  const truncated = buildEventsForCourse(programming, { term: TERM, termStart: TERM_START, untilWeek: 8 });
  assert.equal(truncated.events.length, 1, '只剩第 1-8 周那一条');
  assert.equal(truncated.events[0].payload.repeat.until.date, '2026-10-28');

  const cut = buildEventsForCourse(experiment, { term: TERM, termStart: TERM_START, untilWeek: 8 });
  assert.equal(cut.events.length, 0);
  assert.equal(cut.skipped.length, 1);
  assert.match(cut.skipped[0].reason, /第 8 周/);
});

/* ------------------------------------------------------------------ 幂等键 */

test('timetable：externalId 结构稳定、可解析，且只在「周次段」上不同', () => {
  const first = externalIdFor({
    term: TERM,
    courseName: '程序设计',
    weekDay: 3,
    startPeriod: 1,
    endPeriod: 2,
    run: { start: 1, end: 8 },
  });
  const again = externalIdFor({
    term: TERM,
    courseName: '程序设计',
    weekDay: 3,
    startPeriod: 1,
    endPeriod: 2,
    run: { start: 1, end: 8 },
  });
  const later = externalIdFor({
    term: TERM,
    courseName: '程序设计',
    weekDay: 3,
    startPeriod: 1,
    endPeriod: 2,
    run: { start: 10, end: 16 },
  });
  assert.equal(first, again, '同样的事实必须得到同样的键（幂等的前提）');
  assert.notEqual(first, later);
  assert.match(first, /^timetable:2026-2027-1:程序设计:3:1-2:[0-9a-f]{8}$/);

  const parsed = parseExternalId(first);
  assert.equal(parsed.term, TERM);
  assert.equal(parsed.courseName, '程序设计');
  assert.equal(parsed.weekDay, 3);
  assert.equal(parsed.startPeriod, 1);
  assert.equal(parsed.endPeriod, 2);
  assert.equal(parsed.courseId, courseIdOf('程序设计'));

  // 课程名里的空格 / 全角标点被规范化，不会因为上游格式漂移产生第二条
  assert.equal(
    externalIdFor({ term: TERM, courseName: '程序 设计', weekDay: 3, startPeriod: 1, endPeriod: 2, run: { start: 1, end: 8 } }),
    first,
  );

  assert.equal(isTimetableExternalId(first), true);
  assert.equal(isTimetableExternalId('lms:123'), false);
  assert.equal(parseExternalId('timetable:坏数据'), null);
});

test('timetable：已导入分组从 tags 还原周次（不需要登录也能看）', () => {
  const schedules = [
    {
      id: 's1',
      title: '程序设计',
      source: 'import',
      externalId: externalIdFor({
        term: TERM,
        courseName: '程序设计',
        weekDay: 3,
        startPeriod: 1,
        endPeriod: 2,
        run: { start: 1, end: 8 },
      }),
      tags: ['课表', `term:${TERM}`, 'weekday:3', 'periods:1-2', 'weeks:1-8'],
    },
    {
      id: 's2',
      title: '程序设计',
      source: 'import',
      externalId: externalIdFor({
        term: TERM,
        courseName: '程序设计',
        weekDay: 3,
        startPeriod: 1,
        endPeriod: 2,
        run: { start: 10, end: 16 },
      }),
      tags: ['课表', `term:${TERM}`, 'weekday:3', 'periods:1-2', 'weeks:10-16'],
    },
    // 手建日程不应该出现在「已导入」里
    { id: 'm1', title: '手建', source: 'manual', externalId: null, tags: [] },
  ];
  const grouped = groupImportedSchedules(schedules);
  assert.equal(grouped.total, 2);
  assert.equal(grouped.courses.length, 1);
  assert.equal(grouped.courses[0].count, 2);
  assert.deepEqual(grouped.courses[0].weeks.list, [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(grouped.courses[0].weeksText, '第1-8,10-16周');
});

/* ------------------------------------------------------------------ 端到端：未登录 */

test('timetable HTTP：未登录预览/导入 → 401 NOT_LOGGED_IN，且不写入任何日程', async () => {
  const mock = await startMockTimetable();
  const ctx = await startApp(mock);
  try {
    const status = await ctx.call('GET', '/timetable/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.loggedIn, false);
    assert.deepEqual(status.body.terms, []);
    assert.equal(status.body.imported.count, 0);

    const preview = await ctx.call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 401);
    assert.equal(preview.body.error.code, 'NOT_LOGGED_IN');

    const imported = await ctx.call('POST', '/timetable/import', { term: TERM, courseIds: ['ttc-x'] });
    assert.equal(imported.status, 401);
    assert.equal(imported.body.error.code, 'NOT_LOGGED_IN');

    assert.equal(timetableSchedules(ctx.app).length, 0, '未登录绝不能写入日程');
    // 假服务器确实走了 302 到 CAS（而不是返回空 rows）
    assert.ok(mock.state.requests.some((item) => item.includes('/cas/')), '应访问过 CAS 登录页');
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 端到端：预览 */

test('timetable HTTP：登录后 status / preview（真实字段夹具）', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const status = await call('GET', '/timetable/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.loggedIn, true);
    assert.equal(status.body.currentTerm, TERM);
    assert.equal(status.body.terms.length, 7);
    assert.equal(status.body.terms.filter((item) => item.current).length, 1);
    assert.equal(status.body.imported.count, 0);

    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.term, TERM);
    assert.equal(preview.body.termStart, TERM_START);
    assert.equal(preview.body.startSource, 'ehall');
    assert.equal(preview.body.maxWeek, 18);
    assert.equal(preview.body.count, 7);

    const byName = new Map(preview.body.courses.map((course) => [course.name, course]));
    assert.deepEqual(byName.get('高等数学').periodRange, [1, 4], '1-2 + 3-4 应合并为 1-4');
    assert.equal(byName.get('高等数学').eventCount, 1);
    assert.equal(byName.get('线性代数').slots.length, 2, '1-2 与 5-6 不连续，保持两段');
    assert.equal(byName.get('线性代数').eventCount, 2);
    assert.deepEqual(byName.get('程序设计').weeks.runs, [
      { start: 1, end: 8 },
      { start: 10, end: 16 },
    ]);
    assert.equal(byName.get('程序设计').eventCount, 2);
    assert.deepEqual(byName.get('物理实验').weeks.list, [10, 11, 12, 13, 14, 15, 16]);

    // 起始日接口带对了 XN / XQ（这是 cxjcs.do 的必填参数）
    assert.deepEqual(mock.state.lastTermStartQuery, { XN: '2026-2027', XQ: '1' });
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable HTTP：?probe=1 主动重试站点认证 —— 共享票据还在时能静默恢复', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    // 模拟「auth 眼里本站点暂时不可用」：普通 status 只读本地状态，不会自己重试
    app.services.auth.invalidate('timetable');
    const cold = await call('GET', '/timetable/status');
    assert.equal(cold.body.loggedIn, false);

    // 页面上的「刷新状态」带 probe=1：auth.ensure 会拿共享罐里的会话静默恢复
    const probe = await call('GET', '/timetable/status?probe=1');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.loggedIn, true);
    assert.equal(probe.body.currentTerm, TERM);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable HTTP：cxjcs 为空时用本地推断，并在 startSource 如实标注', async () => {
  const { app, call, mock } = await loggedIn({ termStart: null });
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.startSource, 'guess');
    assert.equal(isoWeekday(preview.body.termStart), 1);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 端到端：导入幂等 / 截断 */

test('timetable HTTP：导入幂等 —— 第二次 created:0 / updated>0，日程条数不变', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    const courseIds = preview.body.courses.map((course) => course.id);

    const first = await call('POST', '/timetable/import', { term: TERM, courseIds, untilWeek: 8 });
    assert.equal(first.status, 200);
    assert.equal(first.body.skippedCount, 1, '物理实验只有 10-16 周，截到第 8 周后应跳过');
    assert.match(first.body.skipped[0].reason, /第 8 周/);
    assert.equal(first.body.created, 7);
    assert.equal(first.body.updated, 0);
    assert.equal(first.body.events, 7);

    const countAfterFirst = timetableSchedules(app).length;
    assert.equal(countAfterFirst, 7);

    const second = await call('POST', '/timetable/import', { term: TERM, courseIds, untilWeek: 8 });
    assert.equal(second.body.created, 0, '第二次不应新建');
    assert.ok(second.body.updated > 0, '第二次应更新已有日程');
    assert.equal(second.body.events, second.body.updated);
    assert.equal(timetableSchedules(app).length, countAfterFirst, '日程条数不变（幂等）');

    // 重新按整学期导入：补齐后半段，仍然不产生重复
    const full = await call('POST', '/timetable/import', { term: TERM, courseIds });
    assert.equal(full.body.created, 2, '程序设计后半段 + 物理实验');
    assert.equal(full.body.updated, 7);
    assert.equal(timetableSchedules(app).length, 9);

    const fullAgain = await call('POST', '/timetable/import', { term: TERM, courseIds });
    assert.equal(fullAgain.body.created, 0);
    assert.equal(fullAgain.body.updated, 9);
    assert.equal(timetableSchedules(app).length, 9);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable HTTP：调小 untilWeek 重新导入会清掉多余的旧日程（removed）', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    const courseIds = preview.body.courses.map((course) => course.id);
    const full = await call('POST', '/timetable/import', { term: TERM, courseIds });
    assert.equal(full.body.events, 9);

    const truncated = await call('POST', '/timetable/import', { term: TERM, courseIds, untilWeek: 8 });
    assert.equal(truncated.body.updated, 7);
    assert.equal(truncated.body.removed, 2, '程序设计第 10-16 周与物理实验应被清掉');
    const remaining = timetableSchedules(app);
    assert.equal(remaining.length, 7);
    assert.ok(remaining.every((item) => !item.externalId.includes('物理实验')));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable HTTP：只导入选中的课程', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    const math = preview.body.courses.find((course) => course.name === '高等数学');
    const result = await call('POST', '/timetable/import', { term: TERM, courseIds: [math.id] });
    assert.equal(result.body.created, 1);
    assert.equal(timetableSchedules(app).length, 1);
    assert.equal(timetableSchedules(app)[0].title, '高等数学');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 端到端：删除 */

test('timetable HTTP：按课程删 / all 只删 timetable: 前缀，手建日程不受影响', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const manual = await app.services.schedules.create({
      title: '手建日程',
      date: '2026-09-07',
      startTime: '18:00',
      endTime: '19:00',
    });
    const foreign = await app.services.schedules.create({
      title: '别的导入',
      date: '2026-09-08',
      startTime: '18:00',
      endTime: '19:00',
      source: 'import',
      externalId: 'other:123',
    });

    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    const courseIds = preview.body.courses.map((course) => course.id);
    await call('POST', '/timetable/import', { term: TERM, courseIds });
    assert.equal(timetableSchedules(app).length, 9);

    // 按课程删：只删「高等数学」
    const math = preview.body.courses.find((course) => course.name === '高等数学');
    const one = await call('POST', '/timetable/remove', { term: TERM, courseIds: [math.id] });
    assert.equal(one.status, 200);
    assert.equal(one.body.removed, 1);
    assert.equal(timetableSchedules(app).length, 8);
    assert.ok(app.store.schedules.get(manual.id), '手建日程必须还在');
    assert.ok(app.store.schedules.get(foreign.id), '非 timetable: 前缀的记录也不能被删');

    // 全部删除（当前学期）
    const all = await call('POST', '/timetable/remove', { term: TERM, all: true });
    assert.equal(all.body.removed, 8);
    assert.equal(timetableSchedules(app).length, 0);
    assert.ok(app.store.schedules.get(manual.id), '手建日程必须还在（all 也不行）');
    assert.ok(app.store.schedules.get(foreign.id), '别的来源必须还在');

    const imported = await call('GET', `/timetable/imported?term=${TERM}`);
    assert.equal(imported.body.total, 0);
    assert.deepEqual(imported.body.courses, []);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable HTTP：remove 既没 courseIds 也没 all → 400', async () => {
  const mock = await startMockTimetable();
  const ctx = await startApp(mock);
  try {
    const result = await ctx.call('POST', '/timetable/remove', { term: TERM });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'BAD_REQUEST');
    const badTerm = await ctx.call('POST', '/timetable/remove', { term: '2026-1', all: true });
    assert.equal(badTerm.status, 400);
    // 正则能过、但学年不连续的脏值也必须 400（不能落到服务层变成 500）
    const badYear = await ctx.call('POST', '/timetable/remove', { term: '2026-2028-1', all: true });
    assert.equal(badYear.status, 400);
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 端到端：错误语义 */

test('timetable HTTP：上游 500 / 非 JSON / code!=="0" → 502 EHALL_ERROR 且带原始路径', async () => {
  const mock = await startMockTimetable();
  const ctx = await startApp(mock);
  try {
    await ctx.app.services.auth.login({ username: '2024001', password: 'secret-pass', siteId: 'timetable' });

    mock.state.failNextTimetableWith = 500;
    const failed = await ctx.call('GET', `/timetable/preview?term=${TERM}&refresh=1`);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'EHALL_ERROR');
    assert.match(failed.body.error.message, /xskcb\.do/);
    assert.equal(failed.body.error.details.path, '/jwapp/sys/wdkb/modules/xskcb/xskcb.do');

    mock.state.timetableOverride = '<html><body>整页错误</body></html>';
    const nonJson = await ctx.call('GET', `/timetable/preview?term=${TERM}&refresh=1`);
    assert.equal(nonJson.status, 502);
    assert.equal(nonJson.body.error.code, 'EHALL_ERROR');
    assert.doesNotMatch(JSON.stringify(nonJson.body), /<html>/, '不能把上游 HTML 透给前端');

    mock.state.timetableOverride = null;
    mock.state.timetableCode = '1';
    mock.state.timetableMessage = '<b>选课数据异常</b>';
    const business = await ctx.call('GET', `/timetable/preview?term=${TERM}&refresh=1`);
    assert.equal(business.status, 502);
    assert.match(business.body.error.message, /code="1"/);
    assert.doesNotMatch(JSON.stringify(business.body), /<b>/);
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 缓存 */

test('timetable：预览 + 导入复用课表行缓存，只打一次 xskcb', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    await call('GET', `/timetable/preview?term=${TERM}`);
    await call('GET', `/timetable/preview?term=${TERM}`);
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    const courseIds = preview.body.courses.map((course) => course.id);
    await call('POST', '/timetable/import', { term: TERM, courseIds });
    assert.equal(mock.state.timetableCalls, 1, '60 秒内重复预览 / 导入不应反复打学校服务器');
  } finally {
    await app.close();
    await mock.close();
  }
});
