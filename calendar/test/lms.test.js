/**
 * 思源学堂接入的端到端测试。
 *
 * 用本地 mock 服务器（test/helpers/lms-mock.js）复刻统一身份认证 + 思源学堂接口，
 * 因此整条链路（RSA 加密登录 → Cookie → 课程 / 活动 → 同步到日历）都是真跑的，
 * 不依赖网络与真实账号。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { buildSyncPlan } from '../src/server/lms/sync.js';
import { parseLmsTime } from '../src/server/lms/time.js';
import { startMockLms } from './helpers/lms-mock.js';

const TODAY = '2026-10-11';

/** 起一套「后端 + 指向 mock 的思源学堂客户端」。 */
async function startApp(mock, { dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-lms-')));
  const app = await createServer({
    dataDir: dir,
    lms: { config: { baseUrl: mock.origin, casOrigin: mock.origin, userAgent: 'test-agent', concurrency: 2 } },
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

    // 未提交的作业 -> 新建日程，截止日为准，标题带课程名
    const first = byKey.get('lms:activity:5001');
    assert.equal(first.action, 'create');
    assert.equal(first.kind, 'schedule');
    assert.equal(first.payload.date, '2026-10-14');
    assert.equal(first.payload.allDay, true, '跨天的作业按全天待办处理');
    assert.equal(first.payload.category, 'study');
    assert.equal(first.payload.externalId, 'lms:activity:5001');
    assert.equal(first.payload.title, '[数据结构] 第一次作业：链表');
    assert.deepEqual(first.payload.tags.slice(0, 2), ['思源学堂', '作业']);
    assert.match(first.payload.description, /课程：数据结构/);

    // 直播 -> 带起止时刻的时段日程
    const live = byKey.get('lms:activity:5004');
    assert.equal(live.action, 'create');
    assert.equal(live.payload.date, '2026-10-13');
    assert.equal(live.payload.startTime, '10:00');
    assert.equal(live.payload.endTime, '11:40');
    assert.equal(live.payload.allDay, false);
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
    assert.equal(expired.kind, 'schedule');
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
    assert.equal(wideSubmitted.payload.status, 'done', '已提交的作业同步成已完成');

    // 回放默认不导入，开启后作为时段日程进入计划
    assert.equal(byKey.has('lms:activity:5007'), false, '回放默认被跳过');
    const lesson = wide.body.items.find((item) => item.key === 'lms:activity:5007');
    assert.equal(lesson.payload.date, '2026-10-06');
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
    assert.equal(first.body.created, 3, '三条未提交的未来作业/直播');

    const schedules = await call('GET', '/schedules');
    const created = schedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    assert.equal(created.length, 3);
    assert.ok(created.every((item) => item.source === 'import'));
    assert.equal(created[0].reminders.length, 1);

    // 再同步一次：全部跳过，不产生重复记录
    const second = await call('POST', '/lms/sync/apply', { today: TODAY });
    assert.equal(second.body.created, 0);
    assert.equal(second.body.updated, 0);
    assert.equal(second.body.skipped, 5);
    const after = await call('GET', '/schedules');
    assert.equal(after.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 3);
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
      activity.end_time = '2026-10-16T23:59:00+08:00';
    });

    const preview = await call('POST', '/lms/sync/preview', { today: TODAY, refresh: true });
    const changed = preview.body.items.find((item) => item.key === 'lms:activity:5001');
    assert.equal(changed.action, 'update');
    assert.ok(changed.changes.includes('title'));
    assert.ok(changed.changes.includes('date'));

    const applied = await call('POST', '/lms/sync/apply', { today: TODAY, refresh: true });
    assert.equal(applied.body.updated, 1);
    const schedules = await call('GET', '/schedules');
    const updated = schedules.body.items.find((item) => item.externalId === 'lms:activity:5001');
    assert.equal(updated.date, '2026-10-16');
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
    const finalSchedules = await call('GET', '/schedules');
    assert.equal(finalSchedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:')).length, 2);
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
    const schedules = await call('GET', '/schedules');
    const items = schedules.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:'));
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

  // 把会话文件换成一张学校已经不认的票（模拟服务端让会话过期）
  await writeFile(
    path.join(first.dataDir, 'lms-session.json'),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      user: { name: '张三', userNo: '2021001' },
      cookies: [{ name: 'LMS_SESSION', value: 'expired', domain: '127.0.0.1', hostOnly: true, path: '/', expiresAt: null, secure: false }],
    }),
  );

  const second = await startApp(mock, { dataDir: first.dataDir });
  try {
    const failed = await second.call('POST', '/lms/sync/preview', { today: TODAY });
    assert.equal(failed.status, 401);
    assert.match(failed.body.error.message, /失效/);
    // 失效后本地票据被清掉，状态回到未登录
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

test('思源学堂：同步计划在缺少 today 时直接报错', () => {
  assert.throws(() => buildSyncPlan({ courses: [], activities: [] }), /today/);
});
