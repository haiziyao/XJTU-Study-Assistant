/**
 * 思源学堂接入的端到端测试。
 *
 * 用本地 mock 服务器（test/helpers/lms-mock.js）复刻统一身份认证 + 思源学堂接口，
 * 因此整条链路（RSA 加密登录 → Cookie → 课程 / 活动 → 同步到日历）都是真跑的，
 * 不依赖网络与真实账号。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { normalizeCourse } from '../src/modules/lms/api.js';
import { ACTIVITY_TYPE_LABEL, activityTypesOf } from '../src/modules/lms/config.js';
import { buildSyncPlan, refineActivityTitle } from '../src/modules/lms/sync.js';
import { parseLmsTime } from '../src/modules/lms/time.js';
import { ACTIVITY_DAY_OFFSETS, HOMEWORK_DEADLINE_DATE, activityDate, activityIso, startMockLms } from './helpers/lms-mock.js';

const TODAY = '2026-10-11';

/**
 * mock 的活动日期是**相对今天**生成的（见 helpers/lms-mock.js 的 ACTIVITY_DAY_OFFSETS），
 * 这里据此推出期望值，而不是抄一份字面日期 —— 抄一次就等于把用例绑死在某个日历日上：
 * 「自动同步设置与执行」按真实时钟过滤过期条目，写死的未来日期迟早会变成过去时。
 */
const HOMEWORK_POSTPONE_DAYS = ACTIVITY_DAY_OFFSETS.homework + ACTIVITY_DAY_OFFSETS.homeworkPostpone;

/** 起一套「后端 + 指向 mock 的思源学堂客户端」。 */
async function startApp(mock, { dataDir, downloadDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-lms-')));
  const app = await createServer({
    dataDir: dir,
    lms: {
      config: {
        baseUrl: mock.origin,
        casOrigin: mock.origin,
        // 录播站（课程回放的视频不在 lms 上）：mock 把 /rms 挂在同一个进程里
        rmsBaseUrl: `${mock.origin}/rms`,
        downloadDir: downloadDir ?? path.join(dir, 'downloads'),
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
    return { status: response.status, body: parsed, raw: response };
  };
  return { app, info, call, dataDir: dir };
}

async function login(call, { username, password, captcha } = {}) {
  return call('POST', '/lms/login', { username: username ?? '2021001', password: password ?? 'pw-123456', captcha });
}

test('思源学堂：未登录时业务接口返回 401', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    const status = await call('GET', '/lms/status');
    assert.equal(status.body.status, 'anonymous');

    const courses = await call('GET', '/lms/courses');
    assert.equal(courses.status, 401);
    assert.equal(courses.body.error.code, 'UNAUTHORIZED');

    const preview = await call('POST', '/lms/sync/preview', {});
    assert.equal(preview.status, 401);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：登录链路（RSA 加密 + Cookie + 用户信息）', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    const result = await login(call);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ready');
    assert.equal(result.body.user.name, '张三');
    assert.equal(result.body.user.userNo, '2021001');
    assert.equal(result.body.user.department, '电子与信息学部');

    // 服务端确实收到过公钥请求与用 __RSA__ 加密的密码
    assert.ok(mock.state.requests.includes('GET /cas/jwt/publicKey'));
    const status = await call('GET', '/lms/status');
    assert.equal(status.body.status, 'ready');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：密码错误提示 + 连续失败后要求图形验证码', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    const first = await login(call, { password: 'wrong-password' });
    assert.equal(first.body.status, 'error');
    assert.match(first.body.error, /用户名或密码错误/);
    assert.equal(first.body.captchaRequired, false);

    await login(call, { password: 'wrong-password' });
    const third = await login(call, { password: 'wrong-password' });
    assert.equal(third.body.captchaRequired, true);

    // 第四次不带验证码 -> 直接被拦下
    const fourth = await login(call, { password: 'wrong-password' });
    assert.equal(fourth.body.status, 'need_captcha');

    // 带验证码后回到正常校验流程（密码仍然是错的）
    const withCaptcha = await login(call, { password: 'wrong-password', captcha: 'abcd' });
    assert.equal(withCaptcha.body.status, 'error');

    // 验证码图片能透传二进制
    const captcha = await call('GET', '/lms/captcha');
    assert.equal(captcha.status, 200);
    assert.equal(captcha.raw.headers.get('content-type'), 'image/png');

    // 密码正确后即使之前失败过也能登录成功
    const ok = await login(call, { captcha: 'abcd' });
    assert.equal(ok.body.status, 'ready');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：密码正确但仍停在登录页时给出明确提示', async () => {
  const mock = await startMockLms({ stuckOnLogin: true });
  const { call, app } = await startApp(mock);
  try {
    const result = await login(call);
    assert.equal(result.body.status, 'error');
    assert.match(result.body.error, /未完成/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：两步验证（MFA）流程', async () => {
  const mock = await startMockLms({ needMfa: true });
  const { call, app } = await startApp(mock);
  try {
    const started = await login(call);
    assert.equal(started.body.status, 'need_mfa');
    assert.equal(started.body.mfa.flow, 'mfa');
    assert.equal(started.body.mfa.sent, false);

    const sent = await call('POST', '/lms/mfa/send', {});
    assert.equal(sent.status, 200);
    // 真机实测：mfa/detect 只认表单，attest 系列只认 JSON，两种编码都不能错
    assert.match(mock.state.contentTypes['POST /cas/mfa/detect'] ?? '', /x-www-form-urlencoded/);
    assert.match(mock.state.contentTypes['POST /attest/api/guard/securephone/send'] ?? '', /application\/json/);
    assert.equal(sent.body.phone, '13800008888');
    assert.equal(sent.body.phoneMasked, '138****8888');

    const wrong = await call('POST', '/lms/mfa/verify', { code: '000000' });
    assert.equal(wrong.status, 400, '验证码错误属于用户输入问题，按 400 返回');
    assert.match(wrong.body.error.message, /验证码不正确/);

    const right = await call('POST', '/lms/mfa/verify', { code: '654321' });
    assert.equal(right.status, 200);
    assert.equal(right.body.status, 'ready');
    // 校验接口同样必须是 JSON 编码（真机传表单会 415）
    assert.match(mock.state.contentTypes['POST /attest/api/guard/securephone/valid'] ?? '', /application\/json/);
    assert.equal(right.body.user.name, '张三');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：二次认证（Safety Verify）流程', async () => {
  const mock = await startMockLms({ safetyVerify: true });
  const { call, app } = await startApp(mock);
  try {
    const started = await login(call);
    assert.equal(started.body.status, 'need_mfa');
    assert.equal(started.body.mfa.flow, 'sec');

    await call('POST', '/lms/mfa/send', {});
    const done = await call('POST', '/lms/mfa/verify', { code: '654321' });
    assert.equal(done.body.status, 'ready');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：课程与活动拉取并落地缓存', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    await login(call);

    const courses = await call('GET', '/lms/courses');
    assert.equal(courses.body.count, 2);
    const data = courses.body.items.find((item) => item.id === 1001);
    assert.equal(data.name, '数据结构');
    assert.equal(data.credit, '3.0');
    assert.equal(data.instructors[0].name, '李老师');
    assert.equal(data.semester.realName, '2026-2027学年秋季学期');
    assert.equal(data.teachingClassName, '数据结构-01班');

    const activities = await call('GET', '/lms/activities');
    assert.equal(activities.body.count, 7);

    const homework = await call('GET', '/lms/activities?type=homework');
    assert.equal(homework.body.count, 4);

    // 强制刷新时也必须按 type 过滤（曾经只有缓存分支过滤）
    const homeworkFresh = await call('GET', '/lms/activities?type=homework&refresh=1');
    assert.equal(homeworkFresh.body.count, 4);
    assert.ok(homeworkFresh.body.items.every((item) => item.type === 'homework'));

    // 「网课」= 直播 + 回放：界面上的网课页签与这里的 type=online 必须是同一套划分
    const online = await call('GET', '/lms/activities?type=online');
    assert.equal(online.body.count, 2);
    assert.deepEqual(online.body.items.map((item) => item.type).sort(), ['lecture_live', 'lesson']);
    const onlineFresh = await call('GET', '/lms/activities?type=online&refresh=1');
    assert.equal(onlineFresh.body.count, 2, 'refresh 分支也要认分组名');
    // 单个底层类型仍然可以精确查
    assert.equal((await call('GET', '/lms/activities?type=lesson')).body.count, 1);
    // 分组划分本身：在线视频（真实账号里有 35 条）也算网课，但它没有时刻，不参与同步
    assert.deepEqual(activityTypesOf('online'), ['lecture_live', 'lesson', 'online_video']);
    assert.deepEqual(activityTypesOf('homework'), ['homework']);
    assert.equal(activityTypesOf(''), null, '不传 type 表示不过滤');

    const one = await call('GET', '/lms/activities/5001');
    assert.equal(one.body.item.type, 'homework');
    assert.match(one.body.item.description, /单链表/);
    assert.equal(one.body.item.userSubmitCount, 0);

    // 缓存命中：第二次读取不再打学校服务器
    const before = mock.state.requests.filter((line) => line.includes('/api/my-courses')).length;
    await call('GET', '/lms/courses');
    const after = mock.state.requests.filter((line) => line.includes('/api/my-courses')).length;
    assert.equal(before, after);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：同步预览的映射规则', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const preview = await call('POST', '/lms/sync/preview', { today: TODAY });
    assert.equal(preview.status, 200);
    const items = preview.body.items;
    const byKey = new Map(items.map((item) => [item.key, item]));

    // 未提交的作业 -> 新建**待办**（作业没有具体时刻，它不是日程）
    const first = byKey.get('lms:activity:5001');
    assert.equal(first.action, 'create');
    assert.equal(first.kind, 'todo', '没有时刻的作业落到待办集合');
    assert.equal(first.payload.deadline, HOMEWORK_DEADLINE_DATE);
    assert.equal(first.payload.allDay, undefined, '待办没有 allDay');
    assert.equal(first.payload.status, undefined, '待办用 completed，没有 status');
    assert.equal(first.payload.category, undefined, '待办没有分类');
    assert.equal(first.payload.reminders, undefined, '待办没有提醒');
    assert.equal(first.payload.completed, undefined, '未提交的作业不该被标成完成');
    assert.equal(first.payload.externalId, 'lms:activity:5001');
    assert.equal(first.payload.title, '[数据结构] 第一次作业：链表');
    assert.deepEqual(first.payload.tags.slice(0, 2), ['思源学堂', '作业']);
    assert.match(first.payload.description, /课程：数据结构/);

    // 直播 -> 有起止时刻，仍然是时段日程
    const live = byKey.get('lms:activity:5004');
    assert.equal(live.action, 'create');
    assert.equal(live.kind, 'schedule');
    assert.equal(live.payload.date, activityDate(ACTIVITY_DAY_OFFSETS.lectureLive));
    assert.equal(live.payload.startTime, '10:00');
    assert.equal(live.payload.endTime, '11:40');
    assert.equal(live.payload.allDay, undefined, '日程没有 allDay');
    assert.equal(live.payload.category, 'class');

    // 已提交的作业默认不导入
    const submitted = byKey.get('lms:activity:5002');
    assert.equal(submitted.action, 'skip');
    assert.match(submitted.reason, /已提交/);

    // 过期的作业默认不导入
    const expired = byKey.get('lms:activity:5003');
    assert.equal(expired.action, 'skip');
    assert.match(expired.reason, /已过期/);
    // 跳过/失效条目也要带 kind 和 payload（前端不必靠猜字段是否存在）
    // 过期作业仍然是「没有时刻的作业」= 待办
    assert.equal(expired.kind, 'todo');
    assert.equal(expired.payload, null);

    // 勾选「包含过期」+「已提交也导入」后，两条都能进来
    const wide = await call('POST', '/lms/sync/preview', {
      today: TODAY,
      includePast: true,
      skipSubmitted: false,
      types: ['homework', 'lecture_live', 'lesson', 'material'],
    });
    const wideKeys = wide.body.items.map((item) => item.key);
    assert.ok(wideKeys.includes('lms:activity:5003'));
    assert.ok(wideKeys.includes('lms:activity:5002'));
    const wideSubmitted = wide.body.items.find((item) => item.key === 'lms:activity:5002');
    assert.equal(wideSubmitted.kind, 'todo');
    assert.equal(wideSubmitted.payload.completed, true, '已提交的作业同步成「待办已完成」');

    // 回放默认不导入，开启后作为时段日程进入计划
    assert.equal(byKey.has('lms:activity:5007'), false, '回放默认被跳过');
    const lesson = wide.body.items.find((item) => item.key === 'lms:activity:5007');
    assert.equal(lesson.kind, 'schedule', '回放有时刻 -> 时段日程');
    assert.equal(lesson.payload.date, activityDate(ACTIVITY_DAY_OFFSETS.lesson));
    assert.equal(lesson.payload.startTime, '10:00');
    assert.equal(lesson.payload.category, 'class');

    // 整学期课程区间是可选能力，默认不出现
    assert.equal(wide.body.items.some((item) => item.type === 'course'), false);
    const withRange = await call('POST', '/lms/sync/preview', { today: TODAY, includeCourseRange: true });
    const range = withRange.body.items.find((item) => item.key === 'lms:course-range:1001');
    assert.equal(range.kind, 'event');
    assert.equal(range.payload.startDate, '2026-09-01');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：应用同步是幂等的，可重复执行', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const first = await call('POST', '/lms/sync/apply', { today: TODAY });
    assert.equal(first.status, 200);
    assert.equal(first.body.created, 3, '两条未提交的未来作业 + 一条直播');
    // 逐条核对归属：5001/5006 是待办，5004 是时段日程
    const byKey = new Map(first.body.results.map((item) => [item.key, item]));
    assert.equal(byKey.get('lms:activity:5001').kind, 'todo');
    assert.equal(byKey.get('lms:activity:5006').kind, 'todo');
    assert.equal(byKey.get('lms:activity:5004').kind, 'schedule');

    // 时段日程：只有那条直播
    const schedules = await call('GET', '/schedules');
    const createdSchedules = schedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    assert.equal(createdSchedules.length, 1);
    assert.equal(createdSchedules[0].externalId, 'lms:activity:5004');
    assert.ok(createdSchedules.every((item) => item.source === 'import'));
    assert.equal(createdSchedules[0].reminders.length, 1);

    // 待办：两条作业，截止日就是作业的截止日
    const todos = await call('GET', '/todos');
    const createdTodos = todos.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    assert.equal(createdTodos.length, 2);
    assert.deepEqual(createdTodos.map((item) => item.externalId).sort(), ['lms:activity:5001', 'lms:activity:5006']);
    assert.equal(createdTodos.find((item) => item.externalId === 'lms:activity:5001').deadline, HOMEWORK_DEADLINE_DATE);
    assert.ok(createdTodos.every((item) => item.source === 'import' && item.completed === false));

    // 再同步一次：全部跳过，不产生重复记录
    const second = await call('POST', '/lms/sync/apply', { today: TODAY });
    assert.equal(second.body.created, 0);
    assert.equal(second.body.updated, 0);
    assert.equal(second.body.skipped, 5);
    const afterSchedules = await call('GET', '/schedules');
    assert.equal(afterSchedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 1);
    const afterTodos = await call('GET', '/todos');
    assert.equal(afterTodos.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 2);
    // 幂等：重跑不会把作业重复建进待办
    assert.equal(second.body.created, 0);
    assert.equal(second.body.updated, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：作业改期 -> 更新；作业消失 -> stale', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    await call('POST', '/lms/sync/apply', { today: TODAY });

    // 学校把作业改期并改名
    mock.mutate((dataset) => {
      const activity = dataset.activities[1001].find((item) => item.id === 5001);
      activity.title = '第一次作业：链表（改）';
      activity.end_time = activityIso(HOMEWORK_POSTPONE_DAYS, '23:59:00');
    });

    const preview = await call('POST', '/lms/sync/preview', { today: TODAY, refresh: true });
    const changed = preview.body.items.find((item) => item.key === 'lms:activity:5001');
    assert.equal(changed.action, 'update');
    assert.equal(changed.kind, 'todo', '作业改期改的是待办的截止日');
    assert.ok(changed.changes.includes('title'));
    assert.ok(changed.changes.includes('deadline'));

    const applied = await call('POST', '/lms/sync/apply', { today: TODAY, refresh: true });
    assert.equal(applied.body.updated, 1);
    const todos = await call('GET', '/todos');
    const updated = todos.body.items.find((item) => item.externalId === 'lms:activity:5001');
    assert.equal(updated.deadline, activityDate(HOMEWORK_POSTPONE_DAYS));
    assert.equal(updated.title, '[数据结构] 第一次作业：链表（改）');

    // 学校删掉了直播活动 -> 已同步的记录变成 stale，可选清理
    mock.mutate((dataset) => {
      dataset.activities[1001] = dataset.activities[1001].filter((item) => item.id !== 5004);
    });
    const stalePreview = await call('POST', '/lms/sync/preview', { today: TODAY, refresh: true });
    const stale = stalePreview.body.items.find((item) => item.key === 'lms:activity:5004');
    assert.equal(stale.action, 'stale');
    assert.equal(stalePreview.body.summary.stale, 1);

    const pruned = await call('POST', '/lms/sync/apply', { today: TODAY, refresh: true, pruneStale: true });
    assert.equal(pruned.body.removed, 1);
    // 直播被清理后，日程里已经没有 lms 记录了（作业都在 todos 里）
    const finalSchedules = await call('GET', '/schedules');
    assert.equal(finalSchedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 0);
    const finalTodos = await call('GET', '/todos');
    assert.equal(finalTodos.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 2);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：只同步选中的 keys', async () => {
  const mock = await startMockLms();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const applied = await call('POST', '/lms/sync/apply', { today: TODAY, keys: ['lms:activity:5001'] });
    assert.equal(applied.body.created, 1);
    assert.equal(applied.body.results[0].kind, 'todo', '只勾选的这条作业是待办');
    // 没被勾选的直播不该被建出来
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
    const todos = await call('GET', '/todos');
    const items = todos.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    assert.equal(items.length, 1);
    assert.equal(items[0].externalId, 'lms:activity:5001');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('思源学堂：会话持久化，重启后免登录', async () => {
  const mock = await startMockLms();
  const first = await startApp(mock);
  await login(first.call);
  await first.call('GET', '/lms/courses');
  await first.app.close();

  const second = await startApp(mock, { dataDir: first.dataDir });
  try {
    const status = await second.call('GET', '/lms/status');
    assert.equal(status.body.status, 'ready');
    assert.equal(status.body.user.name, '张三');
    const courses = await second.call('GET', '/lms/courses');
    assert.equal(courses.body.count, 2);

    // 退出后：缓存仍然可读（离线可用），但会明确标记为未登录；写操作一律要求重新登录
    await second.call('POST', '/lms/logout', {});
    const afterLogout = await second.call('GET', '/lms/courses');
    assert.equal(afterLogout.status, 200);
    assert.equal(afterLogout.body.loggedIn, false);
    assert.equal(afterLogout.body.count, 2);
    const blocked = await second.call('POST', '/lms/sync/preview', { today: TODAY });
    assert.equal(blocked.status, 401);
    const status2 = await second.call('GET', '/lms/status');
    assert.equal(status2.body.status, 'anonymous');
  } finally {
    await second.app.close();
    await mock.close();
  }
});

test('思源学堂：登录态失效时给出明确提示', async () => {
  const mock = await startMockLms();
  const first = await startApp(mock);
  await login(first.call);
  await first.app.close();

  // 把**共享会话文件**换成一张学校已经不认的票（模拟服务端让会话过期）。
  // 注意文件变了：票据现在由全局认证模块统一持有（auth-session.json），
  // 不再有 lms-session.json —— 那正是"登录收敛到一处"的直接体现。
  await writeFile(
    path.join(first.dataDir, 'auth-session.json'),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      cookies: [{ name: 'LMS_SESSION', value: 'expired', domain: '127.0.0.1', hostOnly: true, path: '/', expiresAt: null, secure: false }],
      sites: { lms: { lastOkAt: new Date().toISOString() } },
    }),
  );

  const second = await startApp(mock, { dataDir: first.dataDir });
  try {
    const failed = await second.call('POST', '/lms/sync/preview', { today: TODAY });
    assert.equal(failed.status, 401);
    assert.match(failed.body.error.message, /失效/);
    // 失效后本模块的登录态回到未登录（共享票据由 auth 决定去留，本模块不擅自清）
    const status = await second.call('GET', '/lms/status');
    assert.equal(status.body.status, 'anonymous');
    // 重新登录依然可用
    const again = await login(second.call);
    assert.equal(again.body.status, 'ready');
  } finally {
    await second.app.close();
    await mock.close();
  }
});

test('思源学堂：自动同步设置与执行', async () => {
  const mock = await startMockLms();
  let first;
  let second;
  try {
  first = await startApp(mock);
  await login(first.call);

  // 默认关闭：直接跑一次会被跳过
  const off = await first.app.services.lms.runAutoSyncOnce();
  assert.equal(off.ran, false);
  assert.match(off.reason, /未开启/);

  // 打开开关并设置间隔
  const settings = await first.call('POST', '/lms/settings', { autoSync: true, autoSyncIntervalHours: 12 });
  assert.equal(settings.body.autoSync.enabled, true);
  assert.equal(settings.body.autoSync.intervalHours, 12);
  const bad = await first.call('POST', '/lms/settings', { autoSyncIntervalHours: 999 });
  assert.equal(bad.status, 400);

  // 手动跑一次：默认规则会把三条未来的作业/直播建出来，且不会删除任何东西
  const run = await first.app.services.lms.runAutoSyncOnce({ force: true });
  assert.equal(run.ran, true);
  assert.equal(run.created, 3);
  assert.equal(run.removed, 0);

  // 再跑一次：幂等，不新增
  const again = await first.app.services.lms.runAutoSyncOnce({ force: true });
  assert.equal(again.created, 0);

  // 间隔未到（不 force）时跳过
  const throttled = await first.app.services.lms.runAutoSyncOnce();
  assert.equal(throttled.ran, false);
  assert.match(throttled.reason, /间隔/);

  // 重启后设置仍然生效
  const dir = first.dataDir;
  await first.app.close();
  first = null;
  second = await startApp(mock, { dataDir: dir });
  const status = await second.call('GET', '/lms/status');
  assert.equal(status.body.autoSync.enabled, true);
  assert.equal(status.body.autoSync.intervalHours, 12);
  assert.ok(status.body.autoSync.lastRunAt);
  } finally {
    if (first) await first.app.close();
    if (second) await second.app.close();
    await mock.close();
  }
});

test('思源学堂：清洗真实活动标题并提取教室', () => {
  // 实测学校返回：直播标题带日期前缀，回放标题里夹着教室与时段
  assert.deepEqual(refineActivityTitle('材料力学 教2楼-西203 2026-09-14 08:00:00-08:50:00', '材料力学'), { title: '材料力学', location: '教2楼-西203' });
  assert.deepEqual(refineActivityTitle('2026-09-14-材料力学', '材料力学'), { title: '材料力学', location: null });
  assert.deepEqual(refineActivityTitle('第一次作业：链表', '数据结构'), { title: '第一次作业：链表', location: null });
  assert.deepEqual(refineActivityTitle('', '数据结构'), { title: '数据结构', location: null });

  const plan = buildSyncPlan({
    courses: [{ id: 1, name: '材料力学' }],
    activities: [
      { id: 900, courseId: 1, type: 'lesson', title: '材料力学 教2楼-西203 2026-10-14 08:00:00-08:50:00', startTime: '2026-10-14T08:00:00+08:00', endTime: '2026-10-14T08:50:00+08:00' },
      { id: 901, courseId: 1, type: 'lecture_live', title: '2026-10-15-材料力学', startTime: '2026-10-15T10:00:00+08:00', endTime: '2026-10-15T10:50:00+08:00' },
    ],
    options: { today: '2026-10-11', types: ['lesson', 'lecture_live'] },
  });
  const lesson = plan.items.find((item) => item.key === 'lms:activity:900');
  assert.equal(lesson.payload.title, '材料力学', '标题里已有课程名就不再重复加前缀');
  assert.equal(lesson.payload.location, '教2楼-西203', '回放标题里的教室要变成日程地点');
  assert.equal(lesson.payload.startTime, '08:00');
  const live = plan.items.find((item) => item.key === 'lms:activity:901');
  assert.equal(live.payload.title, '材料力学', '直播标题的日期前缀要去掉');
  assert.equal(live.payload.location, null ?? live.payload.location, '没有教室信息时不写 location');
  assert.equal(live.payload.location, undefined);
});

test('思源学堂：真实账号出现过的活动类型都有中文标签', () => {
  // 实测 54 门课的 1894 条活动里除四种主类型外还有这些（不参与同步，但列表要显示得像样）
  for (const [type, label] of [
    ['page', '课程页面'],
    ['forum', '讨论'],
    ['web_link', '外部链接'],
    ['online_video', '在线视频'],
    ['questionnaire', '问卷'],
  ]) {
    assert.equal(ACTIVITY_TYPE_LABEL[type], label);
  }
  // 没见过的类型回退到原始英文，而不是 undefined
  const plan = buildSyncPlan({
    courses: [{ id: 1, name: 'X' }],
    activities: [{ id: 1, courseId: 1, type: 'brand_new_type', title: 'T', endTime: '2026-10-20T23:59:00+08:00' }],
    options: { today: '2026-10-11', types: ['brand_new_type'] },
  });
  assert.equal(plan.items[0].action, 'skip');
  assert.match(plan.items[0].reason, /brand_new_type不参与同步/);
});

test('思源学堂：时间解析按北京时间处理两种格式', () => {
  assert.deepEqual(parseLmsTime('2026-10-13T10:00:00+08:00'), { date: '2026-10-13', time: '10:00', iso: '2026-10-13T02:00:00.000Z' });
  assert.deepEqual(parseLmsTime('2026-10-13T10:00:00'), { date: '2026-10-13', time: '10:00', iso: null });
  assert.equal(parseLmsTime('2026-10-13').date, '2026-10-13', '只有日期时退化到日期');
  assert.equal(parseLmsTime('2026-10-13').time, null);
  assert.equal(parseLmsTime(''), null);
  assert.equal(parseLmsTime(null), null);
  // 同一时刻的 UTC 写法（Z）也必须落到北京时间同一天
  assert.equal(parseLmsTime('2026-10-12T17:30:00Z').date, '2026-10-13');
});

test('思源学堂：真实数据里学期只有 code 时也能给出可读标签', () => {
  // 实测学校返回：semester.name / real_name 都是 null，只有 code = "2026-1"
  const onlyCode = normalizeCourse({ id: 1, name: '材料力学', academic_year: { code: '2026', name: '2026-2027' }, semester: { id: 23, code: '2026-1', name: null, real_name: null } });
  assert.equal(onlyCode.semester.label, '2026-2027 学年 · 第 1 学期');
  const withName = normalizeCourse({ id: 2, name: 'X', semester: { id: 1, code: '2026-1', name: '秋季学期' } });
  assert.equal(withName.semester.label, '秋季学期');
  const noSemester = normalizeCourse({ id: 3, name: 'Y' });
  assert.equal(noSemester.semester, null);
  assert.equal(normalizeCourse({ name: '没有 id' }), null, '缺 id 的脏数据直接丢弃');
});

test('思源学堂：同步计划在缺少 today 时直接报错', () => {
  assert.throws(() => buildSyncPlan({ courses: [], activities: [] }), /today/);
});

test('LMS：预置接口返回 501 而不是 404（让 AI 能区分"没实现"和"路径写错"）', async () => {
  const { LMS_TOOL_SPECS } = await import('../src/modules/lms/tools.js');
  const planned = LMS_TOOL_SPECS.filter((tool) => tool.implemented === false);
  assert.ok(planned.length >= 5, '至少要有几个预置契约');

  const dir = await mkdtemp(path.join(tmpdir(), 'potato-lms-planned-'));
  const app = await createServer({ dataDir: dir });
  const info = await app.listen({ port: 0 });
  try {
    for (const tool of planned) {
      // 把 {id} 之类的占位符换成具体值，直接按工具清单拼调用
      const url = `${info.baseUrl}${tool.path.replace('{id}', '1')}`;
      const response = await fetch(url);
      const body = await response.json();
      assert.equal(response.status, 501, `${tool.name} 应返回 501`);
      assert.equal(body.error.code, 'NOT_IMPLEMENTED');
      assert.equal(body.error.details.planned, true, `${tool.name} 的 details.planned 应为 true`);
      assert.ok(body.error.details.contract, `${tool.name} 应带上契约本身`);
      // 契约要和工具清单对得上（否则 Agent 拿到的"承诺"和清单是两套）
      assert.deepEqual(body.error.details.contract.params ?? {}, tool.params, `${tool.name} 的 params 与工具清单不一致`);
      assert.ok(tool.requiresAuth, `${tool.name} 属于学堂内容，应标 requiresAuth`);
    }

    // 聚合到 /ai/capabilities 时，已实现/未实现要能分辨
    const capabilities = await (await fetch(`${info.baseUrl}/ai/capabilities`)).json();
    const mine = capabilities.aiTools.filter((tool) => tool.module === 'lms');
    assert.equal(mine.filter((tool) => tool.implemented === false).length, planned.length);
    assert.ok(mine.filter((tool) => tool.implemented !== false).length >= 11, '课程页与回放下载已实现');

    // 清单说"已实现"的，路径就必须真的存在 —— 调用不能返回 501 NOT_IMPLEMENTED
    // （401/404 都算"路由在"：401 是没登录，404 是本地缓存里没这条记录）
    for (const tool of mine.filter((item) => item.implemented !== false)) {
      assert.ok(tool.path.startsWith('/lms/'), `${tool.name} 路径应在 /lms 下`);
      const response = await fetch(`${info.baseUrl}${tool.path.replace('{id}', '1')}`, {
        method: tool.method,
        headers: { 'Content-Type': 'application/json' },
        body: tool.method === 'POST' ? '{}' : undefined,
      });
      assert.notEqual(response.status, 501, `${tool.name} 标了已实现，实际却返回 501`);
    }
  } finally {
    await app.close();
  }
});

test('接口文档与 LMS 工具清单一致（含"预置未实现"必须标明）', async () => {
  const doc = await readFile(new URL('../docs/接口文档.md', import.meta.url), 'utf8');
  const { LMS_TOOL_SPECS } = await import('../src/modules/lms/tools.js');

  for (const tool of LMS_TOOL_SPECS) {
    assert.ok(doc.includes(tool.path), `接口文档缺少 ${tool.name} 的路径 ${tool.path}`);
    assert.ok(doc.includes(tool.name), `接口文档缺少工具名 ${tool.name}`);
  }
  // 未实现的必须写清楚"未实现"，不能只列个路径让人以为能用
  for (const tool of LMS_TOOL_SPECS.filter((item) => item.implemented === false)) {
    const index = doc.indexOf(tool.path);
    const around = doc.slice(Math.max(0, index - 400), index + 400);
    assert.ok(/尚未实现|预置|未实现/.test(around), `${tool.name} 附近必须写明"尚未实现"`);
  }
});

test('LMS：课程页 —— 课程信息 + 该课活动按 回放/作业/资料/直播 分组（全走缓存）', async () => {
  const mock = await startMockLms();
  const { app, call } = await startApp(mock);
  try {
    await login(call);
    await call('GET', '/lms/courses?refresh=1');
    await call('GET', '/lms/activities?refresh=1');

    const page = await call('GET', '/lms/courses/1001');
    assert.equal(page.status, 200);
    assert.equal(page.body.course.name, '数据结构');
    assert.equal(Number(page.body.course.credit), 3, '学分接口给的是字符串，别在断言里假设是数字');
    assert.ok(page.body.course.instructors.some((item) => item.name === '李老师'));
    assert.deepEqual(page.body.counts, { replay: 1, homework: 3, material: 1, live: 1, other: 0 });
    assert.equal(page.body.groups.replay[0].title, '第 5 周回放');
    assert.equal(page.body.groups.homework.length, 3);
    // 活动行要能直接喂给回放接口，所以 id 必须是学校的数字 id
    assert.equal(page.body.groups.replay[0].id, 5007);

    // 缓存里没有的课程 → 404（而不是编一个空课程出来）
    assert.equal((await call('GET', '/lms/courses/9999')).status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('LMS：课程回放取链真的走完三步（lms player-url → 录播站 embed-token → captures）', async () => {
  const mock = await startMockLms();
  const { app, call } = await startApp(mock);
  try {
    await login(call);
    await call('GET', '/lms/courses?refresh=1');
    await call('GET', '/lms/activities?refresh=1');

    const replays = await call('GET', '/lms/activities/5007/replays');
    assert.equal(replays.status, 200);
    assert.equal(replays.body.replayCode, 'rc-5007');
    assert.equal(replays.body.videos.length, 2);
    const [instructor, encoder] = replays.body.videos;
    assert.equal(instructor.labelText, '教室录像');
    assert.equal(encoder.labelText, '电脑内录');
    assert.equal(instructor.isBestAudio, true);
    assert.match(instructor.downloadUrl, /\/rms\/media\/rc-5007-instructor\.mp4$/);
    assert.equal(instructor.size, 1024);
    assert.equal(instructor.sizeText, '1.00KB');

    // 三步都得留痕：少一步就说明链路被抄近路了
    assert.deepEqual(mock.state.playerUrlFetched, [5007], '第一步：lms 换播放地址');
    assert.deepEqual(mock.state.embedTokenFetched, ['tk-5007'], '第二步：用 token 换录播站票据');
    assert.deepEqual(mock.state.capturesFetched, ['rc-5007'], '第三步：用 replay_code 要视频列表');

    // 拿作业去要回放 → 学堂说这不是 lesson，我们不该硬编一个视频出来
    const wrong = await call('GET', '/lms/activities/5001/replays');
    assert.ok(wrong.status >= 400 && wrong.status !== 501, `作业不该给出回放地址，实际 ${wrong.status}`);
    assert.ok(wrong.body.error, '应有结构化错误');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('LMS：回放下载真落盘 —— 按课程/活动分层、先写 .part 再改名、字节与源一致', async () => {
  const mock = await startMockLms();
  const { app, call, dataDir } = await startApp(mock);
  try {
    await login(call);
    await call('GET', '/lms/courses?refresh=1');
    await call('GET', '/lms/activities?refresh=1');
    const replays = await call('GET', '/lms/activities/5007/replays');
    const video = replays.body.videos[0];

    const started = await call('POST', '/lms/downloads', { activityId: 5007, video });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, 'running');
    assert.match(started.body.path.replaceAll('\\', '/'), /downloads\/数据结构\/第 5 周回放\/教室录像_1\.00KB\.mp4$/);

    let job = started.body;
    for (let i = 0; i < 60 && job.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const listed = await call('GET', '/lms/downloads');
      job = listed.body.items.find((item) => item.id === started.body.id);
    }
    assert.equal(job.status, 'done', `下载应完成，实际 ${job.status} ${job.error ?? ''}`);
    assert.equal(job.total, 64);
    assert.equal(job.bytes, 64);
    assert.equal(job.percent, 100);

    const bytes = await readFile(job.path);
    assert.equal(bytes.length, 64);
    assert.equal(bytes[0], 0x49, '教室录像应该是 0x49 填充的假视频');
    // .part 必须已经不在了（下完改名）
    await assert.rejects(() => readFile(`${job.path}.part`));

    // 落盘目录就报给前端（界面要显示"存到哪了"）
    const listed = await call('GET', '/lms/downloads');
    assert.equal(listed.body.downloadDir, path.join(dataDir, 'downloads'));
    assert.equal(listed.body.active, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('LMS：回放下载能取消（半成品 .part 删掉）、同一视频重复点不会下两份', async () => {
  // 让假视频慢一点，好让任务停在"下载中"
  const mock = await startMockLms({ mediaDelayMs: 400, mediaBytes: 4096 });
  const { app, call } = await startApp(mock);
  try {
    await login(call);
    await call('GET', '/lms/courses?refresh=1');
    await call('GET', '/lms/activities?refresh=1');
    const replays = await call('GET', '/lms/activities/5007/replays');
    const video = replays.body.videos[0];

    const first = await call('POST', '/lms/downloads', { activityId: 5007, video });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await call('POST', '/lms/downloads', { activityId: 5007, video });
    assert.equal(second.body.id, first.body.id, '同一个视频正在下就别再开一个任务');

    const cancelled = await call('POST', `/lms/downloads/${first.body.id}/cancel`);
    assert.equal(cancelled.status, 200);
    for (let i = 0; i < 40 && cancelled.body.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const listed = await call('GET', '/lms/downloads');
      const job = listed.body.items.find((item) => item.id === first.body.id);
      if (job.status !== 'running') {
        assert.equal(job.status, 'cancelled');
        assert.equal(job.error, null, '用户取消不是错误');
        await assert.rejects(() => readFile(job.path), '取消后不该留下"看起来正常"的文件');
        await assert.rejects(() => readFile(`${job.path}.part`), '.part 半成品要清掉');
        return;
      }
    }
    assert.fail('任务应该被取消');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('回放下载器：文件名安全化 / 体积文案 / 非法分段不越界', async () => {
  const { sanitizeSegment, humanSize } = await import('../src/modules/lms/replay-download.js');
  // 学堂的标题里什么都有：冒号、斜杠、问号、前后空白
  // 中文冒号是安全的，保留；半角 / 与 ? 必须换掉
  assert.equal(sanitizeSegment('第6周：直播/回放?'), '第6周：直播_回放_');
  assert.equal(sanitizeSegment('   '), '未命名');
  assert.equal(sanitizeSegment('...'), '未命名');
  // 关键不是"变成某个具体字符串"，而是**不能越界**：没有分隔符、不以点开头
  const traversal = sanitizeSegment('../../../etc/passwd');
  assert.ok(!traversal.includes('/'), '路径分隔符必须被替换掉');
  assert.ok(!/^\./.test(traversal), '不能以点开头（避免 .. 之类的相对路径语义）');
  assert.equal(traversal, '_.._.._etc_passwd');
  assert.ok(!sanitizeSegment('a'.repeat(200)).includes('/'));
  assert.ok(sanitizeSegment('a'.repeat(200)).length <= 80);

  assert.equal(humanSize(64), '64B');
  assert.equal(humanSize(1024), '1.00KB');
  assert.equal(humanSize(1024 * 1024 * 350), '350MB');
  assert.equal(humanSize(0), '');
  assert.equal(humanSize(null), '');
});
