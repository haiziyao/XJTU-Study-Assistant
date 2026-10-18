/**
 * 「作业自动变成待办」的**学期过滤**测试。
 *
 * 用户的要求是：只同步本学期的作业，别把往年作业一股脑塞进待办。这里钉住四件事：
 *   1. 学期推算纯函数的边界（8 月底 / 9 月初、1 月底 / 2 月初，以及北京时间跨日）；
 *   2. 判定顺序：明确学期优先；没有学期才用截止日兜底；两者都没有 → term_unknown；
 *   3. currentTermOnly:false → 恢复旧的全量行为；
 *   4. 端到端：默认只收本学期、历史待办保留、开关可单独持久化。
 *
 * 纯函数用例全部注入固定 `now`，不依赖运行测试的日历日；端到端用例走
 * `test/helpers/lms-mock.js` 的本地 mock（零外网、零真实账号），夹具学期跟随今天。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import {
  SKIP_REASONS,
  deriveSchoolTerm,
  planHomeworkTodos,
  resolveCurrentTerm,
  termIdentityOfSemester,
} from '../src/modules/lms/todos-bridge.js';
import { MOCK_TERM, activityIso, startMockLms } from './helpers/lms-mock.js';

/* ==================================================== 纯函数：学期推算边界 */

test('学期推算：8 月底是第二学期、9 月初是第一学期（按北京时间）', () => {
  const aug = deriveSchoolTerm(new Date('2026-08-31T23:59:00+08:00'));
  assert.equal(aug.academicYear, '2025-2026');
  assert.equal(aug.index, 2);
  assert.equal(aug.startDate, '2026-02-01');
  assert.equal(aug.endDate, '2026-08-31');

  const sep = deriveSchoolTerm(new Date('2026-09-01T00:00:00+08:00'));
  assert.equal(sep.academicYear, '2026-2027');
  assert.equal(sep.index, 1);
  assert.equal(sep.startDate, '2026-09-01');
  assert.equal(sep.endDate, '2027-01-31');

  // 跨年：1 月仍属于上一年 9 月开学的第一学期
  assert.equal(deriveSchoolTerm(new Date('2027-01-31T23:59:00+08:00')).code, '2026-1');
  // 2 月 1 日切到第二学期
  const feb = deriveSchoolTerm(new Date('2027-02-01T00:00:00+08:00'));
  assert.equal(feb.academicYear, '2026-2027');
  assert.equal(feb.index, 2);
  assert.equal(feb.startDate, '2027-02-01');
  assert.equal(feb.endDate, '2027-08-31');
});

test('学期推算按北京时间切日，不跟进程时区走', () => {
  // UTC 8 月 31 日 16:30 = 北京时间 9 月 1 日 00:30，属于新学期
  const beijingSep = deriveSchoolTerm(new Date('2026-08-31T16:30:00Z'));
  assert.equal(beijingSep.index, 1);
  assert.equal(beijingSep.academicYear, '2026-2027');
  // 带时区的字符串同样换算到北京时间，不能只看前 10 个字符
  assert.equal(deriveSchoolTerm('2026-08-31T16:30:00Z').index, 1);
  // 纯日期字符串按"那一天"读，不做时区换算
  assert.equal(deriveSchoolTerm('2026-08-31').index, 2);
  assert.equal(deriveSchoolTerm('2026-09-01').index, 1);
});

test('学期字段解析：只有 code / 只有中文名 / 秋春英文都能认，缺年份返回 null', () => {
  const academicYear = { code: '2026-2027', name: '2026-2027学年' };
  // 真实数据里只有 code: '2026-1'
  assert.equal(termIdentityOfSemester({ code: '2026-1' }, academicYear).code, '2026-1');
  // 只有中文名 + 课程上的学年
  assert.equal(termIdentityOfSemester({ code: 'autumn', name: null }, academicYear).index, 1);
  assert.equal(termIdentityOfSemester({ name: '春季学期' }, academicYear).index, 2);
  // 完整 realName
  assert.equal(termIdentityOfSemester({ realName: '2025-2026学年春季学期' }).code, '2025-2');
  // 只有名称、没有年份 → 不猜（交给截止日兜底）
  assert.equal(termIdentityOfSemester({ name: '秋季学期' }), null);
  assert.equal(termIdentityOfSemester(null), null);
});

test('当前学期：优先取 LMS 课程里"今天正在上"的那门课的学期，没有课程才用系统推算', () => {
  const currentCourse = {
    id: 1,
    name: '数据结构',
    startDate: '2026-09-01',
    endDate: '2027-01-15',
    academicYear: { code: '2026-2027' },
    semester: { code: '2026-1', realName: '2026-2027学年秋季学期' },
  };
  const oldCourse = {
    id: 2,
    name: '大学物理',
    startDate: '2026-02-20',
    endDate: '2026-06-30',
    academicYear: { code: '2025-2026' },
    semester: { code: '2025-2', realName: '2025-2026学年春季学期' },
  };
  const now = new Date('2026-10-18T12:00:00+08:00');
  const fromLms = resolveCurrentTerm({ courses: [currentCourse, oldCourse], now });
  assert.equal(fromLms.source, 'lms');
  assert.equal(fromLms.code, '2026-1');

  const fromSystem = resolveCurrentTerm({ courses: [], now });
  assert.equal(fromSystem.source, 'system');
  assert.equal(fromSystem.code, '2026-1');

  // 课程日期都不覆盖今天时，若课程里恰好有系统推算的同一学期，仍标记 lms，但学期不变
  const noDates = resolveCurrentTerm({ courses: [{ ...currentCourse, startDate: null, endDate: null }], now });
  assert.equal(noDates.source, 'lms');
  assert.equal(noDates.code, '2026-1');

  // 学校校历比系统口径早开学（8 月底已经在秋季学期的课）：以 LMS 的课程日期为准
  const earlyStart = new Date('2026-08-25T12:00:00+08:00');
  const fromEarlyCourse = resolveCurrentTerm({
    courses: [{ ...currentCourse, startDate: '2026-08-20', endDate: '2027-01-15' }],
    now: earlyStart,
  });
  assert.equal(fromEarlyCourse.source, 'lms');
  assert.equal(fromEarlyCourse.code, '2026-1', '课程已经在上了，就该按课程挂的第一学期，而不是系统口径的第二学期');
});

/* ==================================================== 纯函数：过滤判定 */

const NOW = new Date('2026-10-18T12:00:00+08:00');

const CURRENT_COURSE = {
  id: 1,
  name: '数据结构',
  startDate: '2026-09-01',
  endDate: '2027-01-15',
  academicYear: { code: '2026-2027' },
  semester: { code: '2026-1', realName: '2026-2027学年秋季学期' },
};
const OLD_COURSE = {
  id: 2,
  name: '大学物理',
  startDate: '2026-02-20',
  endDate: '2026-06-30',
  academicYear: { code: '2025-2026' },
  semester: { code: '2025-2', realName: '2025-2026学年春季学期' },
};
const NO_TERM_COURSE = { id: 3, name: '通识课' };

/** 覆盖三种判定结果的一组活动。 */
const ACTIVITIES = [
  { id: 100, courseId: 1, type: 'homework', title: '本学期作业', endTime: '2026-10-20T23:59:00+08:00' },
  { id: 101, courseId: 1, type: 'homework', title: '本学期但没有截止日' },
  { id: 200, courseId: 2, type: 'homework', title: '历史学期作业', endTime: '2026-05-01T23:59:00+08:00' },
  // 即使截止日被改到"看起来像本学期"，明确学期仍然优先 → 仍是历史作业
  { id: 201, courseId: 2, type: 'homework', title: '历史学期但截止日在本学期', endTime: '2026-10-22T23:59:00+08:00' },
  { id: 300, courseId: 3, type: 'homework', title: '无学期但截止日在本学期', endTime: '2026-10-25T23:59:00+08:00' },
  { id: 301, courseId: 3, type: 'homework', title: '无学期且截止日明显在过去', endTime: '2026-05-01T23:59:00+08:00' },
  { id: 302, courseId: 3, type: 'homework', title: '无学期无截止日' },
  // 活动本身直接带学期（防御性支持：当前接口归一化后学期在课程上）
  { id: 400, type: 'homework', title: '活动直出学期', semester: { realName: '2025-2026学年春季学期' }, endTime: '2026-05-01T23:59:00+08:00' },
];

function plan(overrides = {}) {
  return planHomeworkTodos({
    activities: ACTIVITIES,
    courses: [CURRENT_COURSE, OLD_COURSE, NO_TERM_COURSE],
    now: NOW,
    ...overrides,
  });
}

test('过滤：本学期建；历史学期跳过（term_mismatch）；无学期按截止日兜底；两者都没有 term_unknown', () => {
  const { items, summary, currentTerm } = plan();
  assert.equal(currentTerm.code, '2026-1');
  assert.deepEqual(summary, { create: 2, update: 0, skip: 6, completed: 0 });

  const byId = new Map(items.map((item) => [item.activityId, item]));
  assert.equal(byId.get(100).action, 'create');
  assert.equal(byId.get(300).action, 'create', '无学期但截止日在本学期 → 建');

  assert.equal(byId.get(200).action, 'skip');
  assert.equal(byId.get(200).reasonCode, SKIP_REASONS.TERM_MISMATCH);
  assert.match(byId.get(200).reason, /2025-2026/);

  assert.equal(byId.get(201).action, 'skip', '明确学期优先于截止日：改到本学期的历史作业仍是历史');
  assert.equal(byId.get(201).reasonCode, SKIP_REASONS.TERM_MISMATCH);

  assert.equal(byId.get(301).action, 'skip');
  assert.equal(byId.get(301).reasonCode, SKIP_REASONS.DEADLINE_OUTSIDE_TERM);

  assert.equal(byId.get(302).action, 'skip');
  assert.equal(byId.get(302).reasonCode, SKIP_REASONS.TERM_UNKNOWN, '两者都没有 → term_unknown');

  assert.equal(byId.get(101).reasonCode, SKIP_REASONS.NO_DEADLINE, '学期对但没有截止日 → no_deadline');
  assert.equal(byId.get(400).reasonCode, SKIP_REASONS.TERM_MISMATCH, '活动直出的学期也要认');
});

test('过滤：currentTermOnly:false 恢复旧行为，历史学期作业也会建', () => {
  const { items, summary, currentTerm } = plan({ currentTermOnly: false });
  assert.equal(currentTerm, null, '关掉过滤就不需要推算学期');
  const byId = new Map(items.map((item) => [item.activityId, item]));
  assert.equal(byId.get(200).action, 'create', '旧行为：历史学期作业照常建');
  assert.equal(byId.get(201).action, 'create');
  assert.equal(byId.get(301).action, 'create', '无学期 + 过去截止日也照旧建');
  // 旧行为里"没有截止日"仍然跳过（不编日期），但不再有 term_unknown
  assert.equal(byId.get(302).reasonCode, SKIP_REASONS.NO_DEADLINE);
  assert.equal(summary.create, 6);
  assert.equal(summary.skip, 2);
});

test('过滤：已有历史待办不会因为重新打开过滤而被删掉/改动（由 skip 保证不触碰）', () => {
  const existingTodos = [
    { id: 'old', externalId: 'lms:activity:200', title: '我改过的标题', deadline: '2026-05-01', tags: ['学堂'], completed: true },
  ];
  const { items, summary } = planHomeworkTodos({
    activities: [ACTIVITIES[2]],
    courses: [OLD_COURSE],
    existingTodos,
    now: NOW,
  });
  assert.deepEqual(summary, { create: 0, update: 0, skip: 1, completed: 0 });
  assert.equal(items[0].action, 'skip');
  assert.equal(items[0].reasonCode, SKIP_REASONS.TERM_MISMATCH);
  // 计划里没有任何 update/delete 条目 —— 已有待办原样保留
  assert.equal(items.some((item) => item.action === 'update' || item.action === 'delete'), false);
});

/* ==================================================== 端到端：开关与真实写入 */

/** 起一套「后端 + 指向 mock 的思源学堂客户端」（与 lms-todos.test.js 同构）。 */
async function startApp(mock, { dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-lms-term-')));
  const app = await createServer({
    dataDir: dir,
    lms: {
      config: {
        baseUrl: mock.origin,
        casOrigin: mock.origin,
        rmsBaseUrl: `${mock.origin}/rms`,
        userAgent: 'test-agent',
        concurrency: 2,
      },
    },
  });
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
  const login = () => call('POST', '/lms/login', { username: '2021001', password: 'pw-123456' });
  const lmsTodos = async () => {
    const all = await call('GET', '/todos');
    return all.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:activity:'));
  };
  return { app, call, login, lmsTodos, dataDir: dir };
}

/** 上一学年、与当前学期序号相同的学期（保证一定不是本学期）。 */
function previousAcademicTerm() {
  const startYear = MOCK_TERM.startYear - 1;
  const endYear = startYear + 1;
  const index = MOCK_TERM.index;
  return {
    startYear,
    index,
    academicYear: `${startYear}-${endYear}`,
    startDate: index === 1 ? `${startYear}-09-01` : `${endYear}-02-01`,
    endDate: index === 1 ? `${endYear}-01-31` : `${endYear}-08-31`,
    semesterName: index === 1 ? '秋季学期' : '春季学期',
    semesterRealName: `${startYear}-${endYear}学年${index === 1 ? '秋' : '春'}季学期`,
  };
}

test('端到端：默认只同步本学期；历史学期跳过有原因；关开关可补建且不删已有待办；配置持久化', async () => {
  const mock = await startMockLms();
  const old = previousAcademicTerm();
  // 在默认数据之外加：一门历史学期课程、一门没有学期字段的课程
  mock.mutate((dataset) => {
    dataset.courses.push({
      id: 1003,
      name: '历史学期课程',
      start_date: old.startDate,
      end_date: old.endDate,
      academic_year: { id: 2, code: old.academicYear, name: `${old.academicYear}学年` },
      semester: { id: 2, code: `${old.startYear}-${old.index}`, name: old.semesterName, real_name: old.semesterRealName },
    });
    dataset.courses.push({ id: 1004, name: '通识课（无学期字段）' });
    dataset.activities[1003] = [
      {
        id: 5008,
        course_id: 1003,
        type: 'homework',
        title: '历史学期作业',
        start_time: `${old.startDate}T08:00:00+08:00`,
        end_time: `${old.startDate}T23:59:00+08:00`,
        published: true,
      },
    ];
    dataset.activities[1004] = [
      // 无学期字段，但截止日在本学期 / 未来 30 天内 → 兜底应放行
      { id: 5009, course_id: 1004, type: 'homework', title: '无学期但快截止', start_time: activityIso(2, '08:00:00'), end_time: activityIso(3, '23:59:00'), published: true },
      // 无学期字段、又没有截止日 → term_unknown
      { id: 5010, course_id: 1004, type: 'homework', title: '无学期也无截止日', published: true },
    ];
    dataset.details[5008] = { description: '旧学期作业', user_submit_count: 0 };
    dataset.details[5009] = { description: '无学期作业', user_submit_count: 0 };
  });

  let first = await startApp(mock);
  try {
    await first.login();

    const initial = await first.call('GET', '/lms/todos/config');
    assert.equal(initial.body.enabled, true);
    assert.equal(initial.body.currentTermOnly, true, '默认只同步本学期');

    // 非法值要 400，且两个字段可以单独改（只传 enabled 不重置 currentTermOnly）
    const bad = await first.call('POST', '/lms/todos/config', { currentTermOnly: 'yes' });
    assert.equal(bad.status, 400);
    const parentOff = await first.call('POST', '/lms/todos/config', { enabled: false });
    assert.equal(parentOff.body.enabled, false);
    assert.equal(parentOff.body.currentTermOnly, true, '没传 currentTermOnly 时保持原值');
    await first.call('POST', '/lms/todos/config', { enabled: true });

    // 第一次同步：4 条默认作业 + 5009（无学期但截止日在范围内）→ 建；5008 / 5010 跳过
    const firstSync = await first.call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(firstSync.body.created, 5);
    assert.equal(firstSync.body.completed, 2);
    assert.equal(firstSync.body.skipped, 2);
    assert.equal(firstSync.body.currentTermOnly, true);
    assert.equal(firstSync.body.skippedReasons.term_mismatch, 1, '历史学期要有明确原因');
    assert.equal(firstSync.body.skippedReasons.term_unknown, 1, '无学期无截止日要有明确原因');

    let todos = await first.lmsTodos();
    assert.equal(todos.length, 5);
    assert.equal(todos.some((item) => item.externalId === 'lms:activity:5008'), false, '历史学期不建');
    assert.equal(todos.some((item) => item.externalId === 'lms:activity:5009'), true, '无学期但截止日在本学期 → 建');

    // 关掉「只同步本学期」→ 恢复旧行为：历史学期作业补建
    const off = await first.call('POST', '/lms/todos/config', { currentTermOnly: false });
    assert.equal(off.body.currentTermOnly, false);
    assert.equal(off.body.enabled, true);
    const secondSync = await first.call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(secondSync.body.created, 1, '只补建那条历史作业');
    assert.equal(secondSync.body.skipped, 1, '5010 仍然没有截止日，跳过');
    todos = await first.lmsTodos();
    assert.equal(todos.length, 6);
    const historical = todos.find((item) => item.externalId === 'lms:activity:5008');
    assert.ok(historical, '关掉过滤后历史作业应被建出来');

    // 重新打开过滤：历史作业不再更新，但**已经建出来的待办必须保留**
    await first.call('POST', '/lms/todos/config', { currentTermOnly: true });
    const thirdSync = await first.call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(thirdSync.body.created, 0);
    assert.equal(thirdSync.body.skipped, 2);
    assert.equal(thirdSync.body.skippedReasons.term_mismatch, 1);
    todos = await first.lmsTodos();
    assert.equal(todos.length, 6, '过滤不是删除：已有历史待办必须保留');
    assert.ok(todos.some((item) => item.externalId === 'lms:activity:5008'), '历史待办还在');

    const status = await first.call('GET', '/lms/status');
    assert.equal(status.body.todos.currentTermOnly, true, '状态里也要暴露这个开关');
    assert.equal(status.body.todos.lastResult.skippedReasons.term_mismatch, 1, '最近一次结果要能解释为什么少了几条');

    // 持久化：改成 false 后重启，仍应是 false
    await first.call('POST', '/lms/todos/config', { currentTermOnly: false });
    const dir = first.dataDir;
    await first.app.close();

    const second = await startApp(mock, { dataDir: dir });
    try {
      const restored = await second.call('GET', '/lms/todos/config');
      assert.equal(restored.body.currentTermOnly, false, '开关要持久化');
      assert.equal(restored.body.enabled, true, '两个开关互不覆盖');
      assert.equal((await second.lmsTodos()).length, 6, '重启不会删除已有待办');
    } finally {
      await second.app.close();
    }
    first = null;
  } finally {
    if (first) await first.app.close();
    await mock.close();
  }
});
