/**
 * 西交大课表导入的端到端测试。
 *
 * 用本地 mock 服务器（test/helpers/timetable-mock.js）复刻
 * 「未登录 302 → amp-auth-adapter/login → CAS 登录页 → RSA 加密 → 种票」整条链路，
 * 以及 jwapp 的 `{code:"0",datas:{…}}` 外壳、`SKZC` 周次位图、`cxjcs` 起始日。
 * 因此整条链路都是真跑的，不依赖网络与真实账号。
 *
 * 固定时间基准：
 * - 学期 `2026-2027-1` 的起始日（第一周周一）= `2026-09-14`；
 * - 「今天」= `2026-09-13`（开学前一天，所以第 1 周不会被当成过去）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { candidateTerms } from '../src/server/timetable/config.js';
import { getClassTime, isSummerTime, periodsOfDate } from '../src/server/timetable/periods.js';
import {
  DEFAULT_TERM_WEEKS,
  SHORT_TERM_WEEKS,
  dateToWeek,
  guessTermStart,
  normalizeToMonday,
  parseTerm,
  termLength,
  validateTermStart,
  weekToDate,
} from '../src/server/timetable/term.js';
import { WeekParseError, bitmapToWeeks, parseWeeksString, weeksToBitmap } from '../src/server/timetable/weeks.js';
import { hash8, normalizeKeyPart } from '../src/server/timetable/to-calendar.js';
import { defaultTimetableDataset, startMockEhall } from './helpers/timetable-mock.js';

const TERM = '2026-2027-1';
const TERM_START = '2026-09-14';
const TODAY = '2026-09-13';

/** 起一套「后端 + 指向 mock 的课表客户端」。 */
async function startApp(mock, { dataDir, config } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-tt-')));
  const app = await createServer({
    dataDir: dir,
    timetable: { config: { baseUrl: mock.origin, casOrigin: mock.origin, userAgent: 'test-agent', ...(config ?? {}) } },
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

async function login(call, { username, password } = {}) {
  return call('POST', '/tt/login', { username: username ?? '2021001', password: password ?? 'pw-123456' });
}

/** 取本地已导入的课表日程（只认 tt: 前缀）。 */
async function ttSchedules(call) {
  const response = await call('GET', '/schedules?limit=5000');
  return response.body.items.filter((item) => String(item.externalId ?? '').startsWith('tt:'));
}

function itemOf(preview, predicate) {
  return preview.body.items.find(predicate);
}

// ---------------------------------------------------------------------------- 纯函数

test('课表：节次时刻表（冬/夏两套，按日期选表，越界报错）', () => {
  // 冬季：11 月
  assert.equal(getClassTime(1, 2, '2026-11-04').startTime, '08:00');
  assert.equal(getClassTime(1, 2, '2026-11-04').endTime, '09:50');
  // 夏季：5 月，上午两套相同
  assert.equal(getClassTime(1, 2, '2026-05-06').startTime, '08:00');
  // 第 5 节起不同：冬季 14:00、夏季 14:30
  const winter5 = getClassTime(5, 5, '2026-11-04');
  assert.equal(winter5.startTime, '14:00');
  assert.equal(winter5.endTime, '14:50');
  assert.equal(winter5.season, 'winter');
  const summer5 = getClassTime(5, 5, '2026-05-06');
  assert.equal(summer5.startTime, '14:30');
  assert.equal(summer5.endTime, '15:20');
  assert.equal(summer5.season, 'summer');
  // 连堂取「首节开始 → 末节结束」
  assert.equal(getClassTime(5, 8, '2026-05-06').endTime, '18:30');
  assert.equal(getClassTime(9, 11, '2026-11-04').startTime, '19:10');
  assert.equal(getClassTime(9, 11, '2026-11-04').endTime, '22:00');

  // 边界：4 月冬、5 月夏、9 月夏、10 月冬
  assert.equal(isSummerTime('2026-04-30'), false);
  assert.equal(isSummerTime('2026-05-01'), true);
  assert.equal(isSummerTime('2026-09-30'), true);
  assert.equal(isSummerTime('2026-10-01'), false);
  assert.equal(periodsOfDate('2026-11-04').length, 11);

  // 越界节次必须报错，而不是静默返回 undefined
  assert.throws(() => getClassTime(0, 1, '2026-11-04'), /节次/);
  assert.throws(() => getClassTime(1, 12, '2026-11-04'), /节次/);
  assert.throws(() => getClassTime(5, 3, '2026-11-04'), /不能早于/);
  assert.throws(() => getClassTime(1, 1, '2026-11-04-extra'), /日期/);
});

test('课表：周次解析（连续 / 不连续 / 单双周 / 无法解析必须报错）', () => {
  assert.deepEqual(parseWeeksString('第1-4，6-16周'), [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(parseWeeksString('3,5,7周'), [3, 5, 7]);
  assert.deepEqual(parseWeeksString('第1-16周'), Array.from({ length: 16 }, (_, i) => i + 1));

  // 单双周：后缀与括号两种写法都要支持（参考实现会在这里丢课，我们必须显式支持）
  assert.deepEqual(parseWeeksString('1-16单周'), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual(parseWeeksString('2-16双周'), [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.deepEqual(parseWeeksString('第1-16周(单)'), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual(parseWeeksString('第1-16周（双）'), [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.deepEqual(parseWeeksString('1-16双'), [2, 4, 6, 8, 10, 12, 14, 16]);
  // 奇偶与区间不矛盾时按交集取
  assert.deepEqual(parseWeeksString('第2-16周(单)'), [3, 5, 7, 9, 11, 13, 15]);

  // 无法解析的片段必须抛错，绝不能静默返回空数组（不然整门课会无声消失）
  assert.throws(() => parseWeeksString('abc'), WeekParseError);
  assert.throws(() => parseWeeksString('1-'), WeekParseError);
  assert.throws(() => parseWeeksString('1-16单双周'), WeekParseError);
  assert.throws(() => parseWeeksString('1-16周起'), WeekParseError);
  // 空输入与「解析失败」是两件事：空输入返回空数组
  assert.deepEqual(parseWeeksString(''), []);
  assert.deepEqual(parseWeeksString(null), []);

  // 位图互转
  assert.deepEqual(bitmapToWeeks('1111001111'), [1, 2, 3, 4, 7, 8, 9, 10]);
  assert.equal(weeksToBitmap([1, 2, 3, 4, 7, 8, 9, 10], 12), '111100111100');
  assert.throws(() => weeksToBitmap([30], 22), /超出位图长度/);
});

test('课表：学期解析 / 起始日推断 / 周次与日期互算', () => {
  assert.deepEqual(parseTerm('2025-2026-1'), { term: '2025-2026-1', academicYear: '2025-2026', index: 1, isShort: false, startYear: 2025 });
  assert.equal(parseTerm('2026-2027-3').isShort, true);
  assert.throws(() => parseTerm('2025-2026-4'), /格式不正确/);
  assert.throws(() => parseTerm('2025-2027-1'), /学年不连续/);

  assert.equal(termLength('2025-2026-1'), DEFAULT_TERM_WEEKS);
  assert.equal(termLength('2025-2026-3'), SHORT_TERM_WEEKS);

  // 学期 1 → 9 月第一个周一；学期 2/3 → 离 3/1、7/1 最近的周一
  assert.equal(guessTermStart('2025-2026-1'), '2025-09-01');
  assert.equal(guessTermStart('2026-2027-1'), '2026-08-31');
  assert.equal(guessTermStart('2025-2026-2'), '2026-03-02');
  assert.equal(guessTermStart('2025-2026-3'), '2026-06-29');
  assert.equal(normalizeToMonday('2026-09-16'), '2026-09-14');
  assert.equal(dateToWeek(TERM_START, weekToDate(TERM_START, 1, 3)), 1);
  assert.equal(dateToWeek(TERM_START, weekToDate(TERM_START, 7, 7)), 7);
  assert.equal(dateToWeek(TERM_START, '2026-09-13'), null, '开学前不属于任何教学周');
  assert.equal(dateToWeek(TERM_START, '2028-01-01'), null, '超出总周数');

  // 起始日校验：必须是周一，且展开区间要落在学年内
  assert.equal(validateTermStart(TERM, TERM_START).ok, true);
  assert.equal(validateTermStart(TERM, TERM_START).totalWeeks, 18);
  const notMonday = validateTermStart(TERM, '2026-09-15');
  assert.equal(notMonday.ok, false);
  assert.match(notMonday.reason, /必须是周一/);
  // 8 月底开学是合法余量（9 月第一个周一可能落在 8 月底），但 7 月开学显然不对
  assert.equal(validateTermStart(TERM, '2026-08-31').ok, true);
  const outOfYear = validateTermStart(TERM, '2026-07-06');
  assert.equal(outOfYear.ok, false);
  assert.match(outOfYear.reason, /超出了学年区间/);

  // 候选学期：围绕当前学期前后各 3 个
  const candidates = candidateTerms('2026-2027-1', 3);
  assert.equal(candidates.length, 7);
  assert.equal(candidates[3], TERM);
  assert.deepEqual(candidates.slice(0, 3), ['2025-2026-1', '2025-2026-2', '2025-2026-3']);
  assert.ok(candidates.includes('2025-2026-3'));

  // externalId 的规范化与哈希规则一旦改动就会导致重复导入，这里把规则冻结住
  assert.equal(normalizeKeyPart('  高等数学 ，A  '), '高等数学,A');
  assert.equal(normalizeKeyPart('王 老师'), '王老师');
  assert.equal(hash8('abc'), hash8('abc'));
  assert.match(hash8('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(hash8('abc'), hash8('abd'));
});

// ---------------------------------------------------------------------------- 端到端

test('课表：未登录时业务接口返回 401', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    const status = await call('GET', '/tt/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'anonymous');

    for (const [method, route] of [
      ['GET', '/tt/terms'],
      ['GET', `/tt/courses?term=${TERM}`],
      ['POST', '/tt/refresh'],
      ['POST', '/tt/preview'],
      ['POST', '/tt/apply'],
      ['POST', `/tt/terms/${TERM}`],
    ]) {
      const response = await call(method, route, method === 'POST' ? { term: TERM, startDate: TERM_START } : undefined);
      assert.equal(response.status, 401, `${method} ${route} 应返回 401`);
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
    }
    // 未登录时不应该打学校服务器
    assert.equal(mock.state.requests.filter((line) => line.includes('/jwapp/')).length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：登录链路（302 → amp-auth-adapter → CAS + RSA 加密 + Cookie）', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    const result = await login(call);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ready');
    assert.equal(result.body.currentTerm, TERM);

    // 密码必须用 RSA 公钥加密后才发出去
    assert.ok(mock.state.requests.includes('GET /cas/jwt/publicKey'));
    const detect = mock.state.contentTypes['POST /cas/mfa/detect'] ?? '';
    assert.match(detect, /x-www-form-urlencoded/, 'mfa/detect 只认表单编码');

    // 会话文件落盘且权限是 0600，且不保存密码
    const session = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.services.store.dataDir, 'timetable-session.json'), 'utf8'));
    assert.ok(Array.isArray(session.cookies) && session.cookies.length > 0);
    assert.equal(session.password, undefined);
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(path.join(app.services.store.dataDir, 'timetable-session.json'))).mode & 0o777, 0o600);

    // 登录后能取当前学期与课表
    const terms = await call('GET', '/tt/terms');
    assert.equal(terms.status, 200);
    assert.equal(terms.body.currentTerm, TERM);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：两步验证（MFA）流程', async () => {
  const mock = await startMockEhall({ needMfa: true });
  const { call, app } = await startApp(mock);
  try {
    const started = await login(call);
    assert.equal(started.body.status, 'need_mfa');
    assert.equal(started.body.mfa.flow, 'mfa');
    assert.equal(started.body.mfa.sent, false);

    const sent = await call('POST', '/tt/mfa/send', {});
    assert.equal(sent.status, 200);
    assert.equal(sent.body.phoneMasked, '138****8888');
    assert.match(mock.state.contentTypes['POST /attest/api/guard/securephone/send'] ?? '', /application\/json/);

    const wrong = await call('POST', '/tt/mfa/verify', { code: '000000' });
    assert.equal(wrong.status, 400, '验证码错误属于用户输入问题，按 400 返回');

    const right = await call('POST', '/tt/mfa/verify', { code: '654321' });
    assert.equal(right.status, 200);
    assert.equal(right.body.status, 'ready');

    // 验证码图片透传二进制
    const captcha = await call('GET', '/tt/captcha');
    assert.equal(captcha.status, 200);
    assert.equal(captcha.raw.headers.get('content-type'), 'image/png');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：学期列表 + 起始日（ehall / guess 兜底 / 手改后不被覆盖）', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const terms = await call('GET', '/tt/terms');
    assert.equal(terms.status, 200);
    assert.equal(terms.body.currentTerm, TERM);
    const byTerm = new Map(terms.body.items.map((item) => [item.term, item]));

    // 当前学期由 cxjcs.do 给出，来源标 ehall
    assert.equal(byTerm.get(TERM).startDate, TERM_START);
    assert.equal(byTerm.get(TERM).source, 'ehall');
    assert.equal(byTerm.get(TERM).totalWeeks, 18);
    assert.equal(byTerm.get(TERM).endDate, '2027-01-17');
    assert.equal(byTerm.get(TERM).validation, null);

    // 历史/未来学期拿不到起始日 → guess 兜底，并且必须显式标注来源
    assert.equal(byTerm.get('2026-2027-2').source, 'guess');
    assert.equal(byTerm.get('2026-2027-2').startDate, guessTermStart('2026-2027-2'));
    assert.equal(byTerm.get('2026-2027-3').source, 'guess');
    assert.equal(byTerm.get('2026-2027-3').totalWeeks, SHORT_TERM_WEEKS);

    // 手工改起始日：必须是周一
    const bad = await call('POST', `/tt/terms/${TERM}`, { startDate: '2026-09-15' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /必须是周一/);

    const updated = await call('POST', `/tt/terms/${TERM}`, { startDate: '2026-09-07' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.source, 'manual');
    assert.equal(updated.body.startDate, '2026-09-07');

    // 再刷新一次列表：manual 的值永远不会被自动结果覆盖
    await login(call);
    const again = await call('GET', '/tt/terms?refresh=1');
    const manual = again.body.items.find((item) => item.term === TERM);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.startDate, '2026-09-07', '手改过的起始日不能被 cxjcs 覆盖');

    // 内存缓存也被纠正（预览算出来的日期跟着走）
    const preview = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    assert.equal(preview.body.termStart, '2026-09-07');

    // 重新手改回正确的值，后面的用例才有意义（同时也验证可以反复改）
    await call('POST', `/tt/terms/${TERM}`, { startDate: TERM_START });
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：cxjcs 失败时用 guess 兜底，并保证落盘与重启后不丢', async () => {
  const mock = await startMockEhall({ termStartFails: true });
  const first = await startApp(mock);
  let second;
  try {
    await login(first.call);
    const terms = await first.call('GET', '/tt/terms');
    const current = terms.body.items.find((item) => item.term === TERM);
    assert.equal(current.source, 'guess', 'cxjcs 拿不到时必须标注来源是猜的');
    assert.equal(current.startDate, guessTermStart(TERM));

    // 起始日要落本地：重启后不再依赖学校
    await first.app.close();
    mock.state.requests.length = 0;
    second = await startApp(mock, { dataDir: first.dataDir });
    const status = await second.call('GET', '/tt/status');
    assert.equal(status.body.status, 'ready', '会话票据应该能免登录复用');
    assert.ok(status.body.terms.known > 0, '学期起始日应该已经落盘');
    const termsAgain = await second.call('GET', '/tt/terms');
    assert.equal(termsAgain.body.items.find((item) => item.term === TERM).startDate, guessTermStart(TERM));
    assert.equal(
      mock.state.requests.some((line) => line.includes('cxjcs.do')),
      false,
      '起始日还在本地缓存的新鲜期内，不该再问学校',
    );
  } finally {
    if (second) await second.app.close();
    else await first.app.close();
    await mock.close();
  }
});

test('课表：课程列表（去重后的课 / 教室 / 周次）', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const courses = await call('GET', `/tt/courses?term=${TERM}`);
    assert.equal(courses.status, 200);
    assert.equal(courses.body.termStart, TERM_START);
    assert.equal(courses.body.startDateSource, 'ehall');
    assert.equal(courses.body.count, 5, '大学英语两个时间段算一门课');

    const byName = new Map(courses.body.items.map((item) => [item.courseName, item]));
    assert.deepEqual(byName.get('数据结构').weeks, [1, 2, 3, 4, 7, 8, 9, 10]);
    assert.equal(byName.get('数据结构').weeksText, '第1-4,7-10周');
    assert.equal(byName.get('数据结构').locations[0], '主楼B-203');
    assert.deepEqual(byName.get('大学物理').weeks, [2, 4, 6, 8, 10]);
    assert.equal(byName.get('大学英语').slots.length, 2);

    // 缓存命中：第二次读不再打学校服务器
    const before = mock.state.requests.filter((line) => line.includes('xskcb.do')).length;
    await call('GET', `/tt/courses?term=${TERM}`);
    assert.equal(mock.state.requests.filter((line) => line.includes('xskcb.do')).length, before);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：逐周展开成日程（日期、时刻、externalId、提醒）', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const preview = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.termStart, TERM_START);

    // 数据结构：周一位图 1111001111 -> 第 1-4、7-10 周，共 8 条
    const ds = preview.body.items.filter((item) => item.courseName === '数据结构');
    assert.equal(ds.length, 8);
    assert.ok(ds.every((item) => item.action === 'create'));
    // 第 1 周周一 = 起始日；第 7 周周一 = 起始日 + 6*7 天
    assert.equal(itemOf(preview, (item) => item.courseName === '数据结构' && item.week === 1).date, '2026-09-14');
    assert.equal(itemOf(preview, (item) => item.courseName === '数据结构' && item.week === 7).date, '2026-10-26');
    assert.equal(itemOf(preview, (item) => item.courseName === '数据结构' && item.week === 2).date, '2026-09-21');

    const one = itemOf(preview, (item) => item.courseName === '数据结构' && item.week === 1);
    assert.equal(one.startTime, '08:00');
    assert.equal(one.endTime, '09:50');
    assert.equal(one.payload.title, '数据结构');
    assert.equal(one.payload.location, '主楼B-203');
    assert.equal(one.payload.category, 'class');
    assert.equal(one.payload.source, 'import');
    assert.deepEqual(one.payload.tags, ['课表', 'xjtu', `term:${TERM}`, 'teacher:李老师', 'weekday:1']);
    assert.deepEqual(one.payload.reminders, [{ offsetMinutes: 15, channel: 'app' }]);
    assert.equal(one.payload.externalId, one.key);
    assert.match(one.key, new RegExp(`^tt:${TERM}:[0-9a-f]{8}:1$`));
    // 逐周展开：默认没有 repeat
    assert.equal(one.payload.repeat, undefined);

    // 概率论：周三 3-4 节，第 3-10 周 -> 2026-09-30（起始日 + 2 周 + 2 天）
    const prob = itemOf(preview, (item) => item.courseName === '概率论' && item.week === 3);
    assert.equal(prob.date, '2026-09-30');
    assert.equal(prob.startTime, '10:10');
    assert.equal(prob.endTime, '12:00');

    // 总计：数据结构 8 + 物理 5 + 线代 10 + 概率论 8 + 英语 5*2 = 41
    assert.equal(preview.body.summary.create, 41);
    assert.equal(preview.body.summary.total, 41);

    // 同一门课的不同时间段算出不同的 externalId（哈希里含节次）
    const english = preview.body.items.filter((item) => item.courseName === '大学英语' && item.week === 1);
    assert.equal(english.length, 2);
    assert.notEqual(english[0].key, english[1].key);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：includePast:false 跳过已经过去的周次', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    // 第 4 周周三是 2026-10-07；把「今天」设到第 3 周（2026-09-28）之后
    const preview = await call('POST', '/tt/preview', { term: TERM, today: '2026-09-28' });
    assert.equal(preview.status, 200);

    // 线性代数每周一次，从第 1 周开始 -> 过去的第 1 周被跳过
    const linear = preview.body.items.filter((item) => item.courseName === '线性代数');
    assert.ok(linear.length > 0);
    assert.ok(linear.every((item) => item.date >= '2026-09-28'));
    assert.equal(linear.some((item) => item.date === '2026-09-18'), false, '第 1 周周五（09-18）已经过去');
    assert.ok(preview.body.skipped.some((item) => /已过去/.test(item.reason)));

    // 勾选「包含已过去」后，过去的那一周也进来
    const wide = await call('POST', '/tt/preview', { term: TERM, today: '2026-09-28', includePast: true });
    assert.equal(wide.body.summary.total > preview.body.summary.total, true);
    assert.equal(
      wide.body.items.some((item) => item.courseName === '线性代数' && item.date === '2026-09-18'),
      true,
    );
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：同一条课按日期选冬/夏作息（9 月与 11 月的下午课时刻不同）', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const preview = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    // 大学物理：周三 5-6 节；第 2 周 = 2026-09-23（仍在夏季作息）、第 8 周 = 2026-11-04（已切冬季）
    const summer = itemOf(preview, (item) => item.courseName === '大学物理' && item.week === 2);
    const winter = itemOf(preview, (item) => item.courseName === '大学物理' && item.week === 8);
    assert.equal(summer.date, '2026-09-23');
    assert.equal(summer.season, 'summer');
    assert.equal(summer.startTime, '14:30');
    assert.equal(summer.endTime, '16:20');

    assert.equal(winter.date, '2026-11-04');
    assert.equal(winter.season, 'winter');
    assert.equal(winter.startTime, '14:00');
    assert.equal(winter.endTime, '15:50');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：应用同步是幂等的，可重复执行', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const first = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true });
    assert.equal(first.status, 200);
    assert.equal(first.body.created, 41);
    assert.deepEqual(first.body.errors, []);

    const created = await ttSchedules(call);
    assert.equal(created.length, 41);
    assert.ok(created.every((item) => item.category === 'class'));
    assert.ok(created.every((item) => item.source === 'import'));
    assert.ok(created.every((item) => item.repeat.type === 'none'), '默认逐周展开，不用 repeat');

    // 再同步一次：全部跳过，不产生重复记录
    const second = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true });
    assert.equal(second.body.created, 0);
    assert.equal(second.body.updated, 0);
    assert.equal(second.body.skipped, 41);
    assert.equal((await ttSchedules(call)).length, 41);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：只应用选中的 keys；教室变了 -> 旧记录 stale + 新键 create', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const preview = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    const target = preview.body.items.find((item) => item.courseName === '数据结构' && item.week === 1);

    // keys 能跨请求生效（apply 会用上次预览的计划，不会重算丢条目）
    const applied = await call('POST', '/tt/apply', { term: TERM, keys: [target.key], pruneStale: false });
    assert.equal(applied.body.created, 1);
    const afterPartial = await ttSchedules(call);
    assert.equal(afterPartial.length, 1);
    assert.equal(afterPartial[0].externalId, target.key);
    assert.equal(afterPartial[0].date, '2026-09-14');

    // 学校把教室换了。externalId 的哈希里含教室，所以旧记录全部失效、新记录重新新建
    // （这是调研文档第 7 节说的「换源/改教室要整体替换而不是重复建」的直接体现）
    mock.mutate((dataset) => {
      dataset.rows[TERM] = dataset.rows[TERM].map((row) =>
        row.KCM === '数据结构' ? { ...row, JASMC: '主楼B-305' } : row,
      );
    });
    const changed = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true, refresh: true });
    // 注意：stale 条目来自本地已有记录，只带 title，没有 courseName
    const stale = changed.body.items.filter((item) => item.action === 'stale');
    assert.equal(stale.length, 1, '刚刚只导入过第 1 周那一条，所以只有它失效');
    assert.equal(stale[0].title, '数据结构');
    assert.equal(stale[0].existingId, afterPartial[0].id);

    const newRoom = changed.body.items.find((item) => item.courseName === '数据结构' && item.week === 1 && item.action === 'create');
    assert.equal(newRoom.location, '主楼B-305');
    assert.notEqual(newRoom.key, target.key);

    // 只把新键写进去（不清理 stale）：旧的那条还在，说明「不删用户数据」是默认行为
    await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true, refresh: true, keys: [newRoom.key] });
    const rooms = await ttSchedules(call);
    assert.equal(rooms.length, 2);
    assert.ok(rooms.some((item) => item.location === '主楼B-305'));
    assert.ok(rooms.some((item) => item.location === '主楼B-203'));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：字段真的变了 -> update 且 changes 里带 location', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true });

    // 只改教室不换键的情况：直接改本地日程的地点，再让同步把它纠正回来
    const before = (await ttSchedules(call)).find((item) => item.externalId.startsWith(`tt:${TERM}`) && item.location === '主楼B-203');
    await call('PATCH', `/schedules/${before.id}`, { location: '被人手改过的教室' });

    const autoRefresh = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    const fixed = autoRefresh.body.items.find((item) => item.key === before.externalId);
    assert.equal(fixed.action, 'update');
    assert.ok(fixed.changes.includes('location'), `changes 应包含 location，实际：${JSON.stringify(fixed.changes)}`);
    assert.equal(fixed.existingId, before.id);

    const applied = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true });
    assert.equal(applied.body.updated, 1);
    const restored = (await ttSchedules(call)).find((item) => item.id === before.id);
    assert.equal(restored.location, '主楼B-203');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：源里删掉 -> stale，且只有 pruneStale 才删；绝不碰用户自己建的日程', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true });
    const beforeCount = (await ttSchedules(call)).length;
    assert.equal(beforeCount, 41);

    // 用户自己建一条日程（不能被课表同步误删）
    const manual = await call('POST', '/schedules', { title: '我自己加的日程', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });

    // 学校把这门课整条删掉
    mock.mutate((dataset) => {
      dataset.rows[TERM] = dataset.rows[TERM].filter((row) => row.KCM !== '大学物理');
    });

    const preview = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true, refresh: true });
    const stale = preview.body.items.filter((item) => item.action === 'stale');
    assert.equal(stale.length, 5, '大学物理 5 条全部失效');
    assert.equal(preview.body.summary.stale, 5);
    assert.ok(stale.every((item) => item.payload === null));
    assert.ok(stale.every((item) => String(item.key).startsWith('tt:')));

    // 不带 pruneStale：什么都不删
    const kept = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true, refresh: true });
    assert.equal(kept.body.removed, 0);
    assert.equal((await ttSchedules(call)).length, 41);

    // 带 pruneStale：删掉失效的 5 条
    const pruned = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true, refresh: true, pruneStale: true });
    assert.equal(pruned.body.removed, 5);
    assert.equal((await ttSchedules(call)).length, 36);

    // 用户自己建的日程还在
    const schedules = await call('GET', '/schedules?limit=5000');
    assert.equal(schedules.body.items.some((item) => item.id === manual.body.item.id), true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：compact 是显式开关，默认逐周展开', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    await login(call);
    const plain = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true });
    assert.ok(plain.body.items.every((item) => item.payload.repeat === undefined));

    const compact = await call('POST', '/tt/preview', { term: TERM, today: TODAY, includePast: true, compact: true });

    // 概率论：第 3-10 周连续、每周时刻完全一致（10:10-12:00）-> 折叠成一条每周重复
    const probability = compact.body.items.filter((item) => item.courseName === '概率论');
    assert.equal(probability.length, 1);
    assert.equal(probability[0].payload.repeat.type, 'weekly');
    assert.equal(probability[0].payload.repeat.interval, 1);
    assert.deepEqual(probability[0].payload.repeat.weekdays, [3]);
    assert.equal(probability[0].payload.repeat.until.mode, 'date');
    assert.equal(probability[0].payload.repeat.until.date, weekToDate(TERM_START, 10, 3));
    assert.equal(probability[0].payload.externalId, probability[0].baseKey);
    assert.equal(probability[0].weeks.length, 8);

    // 线性代数：虽然第 1-10 周连续，但第 1-2 周是夏季作息（19:40 开始）、第 3 周起切成冬季（19:10 开始），
    // 一条 repeat 表达不了两种 startTime -> 不折叠（这是有意保守，避免生成时间会漂的重复日程）
    assert.equal(compact.body.items.filter((item) => item.courseName === '线性代数').length, 10);

    // 大学物理：第 2,4,6,8,10 周是隔周，但「第 2 周还在夏季作息（14:30 开始）、其余周已切冬季（14:00）」，
    // 一条 repeat 只能有一个 startTime，所以**不能**折叠（这正是调研文档第 7 节说的作息漂移）
    assert.equal(compact.body.items.filter((item) => item.courseName === '大学物理').length, 5);

    // 大学英语同样是隔周 + 跨作息 -> 不折叠
    assert.equal(compact.body.items.filter((item) => item.courseName === '大学英语').length, 10);

    // 数据结构第 1-4、7-10 周不连续（首周之外还有断档）-> 保持逐周展开
    assert.equal(compact.body.items.filter((item) => item.courseName === '数据结构').length, 8);

    // 折叠后条目数一定少于逐周
    assert.ok(compact.body.summary.total < plain.body.summary.total);

    // 折叠出来的记录写进日历后，range 展开要落在同样的日期上
    const applied = await call('POST', '/tt/apply', { term: TERM, today: TODAY, includePast: true, compact: true, keys: [probability[0].key] });
    assert.equal(applied.body.created, 1);
    const stored = (await ttSchedules(call)).find((item) => item.externalId === probability[0].key);
    assert.equal(stored.repeat.type, 'weekly');
    const range = await call('GET', '/schedules/range?from=2026-09-01&to=2026-12-31');
    const occurrences = range.body.items.filter((item) => item.title === '概率论');
    assert.equal(occurrences.length, 8, 'repeat 展开成 8 次（第 3-10 周）');
    assert.equal(occurrences[0].occurrenceDate, weekToDate(TERM_START, 3, 3));
    assert.equal(occurrences[occurrences.length - 1].occurrenceDate, weekToDate(TERM_START, 10, 3));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：会话持久化（重启免登录）与登录态失效提示', async () => {
  const mock = await startMockEhall();
  const first = await startApp(mock);
  await login(first.call);
  await first.app.close();

  const second = await startApp(mock, { dataDir: first.dataDir });
  try {
    const status = await second.call('GET', '/tt/status');
    assert.equal(status.body.status, 'ready');
    const terms = await second.call('GET', '/tt/terms');
    assert.equal(terms.status, 200);

    // 把会话文件换成一张学校已经不认的票
    await writeFile(
      path.join(first.dataDir, 'timetable-session.json'),
      JSON.stringify({
        savedAt: new Date().toISOString(),
        cookies: [{ name: 'EHALL_SESSION', value: 'expired', domain: '127.0.0.1', hostOnly: true, path: '/', expiresAt: null, secure: false }],
      }),
    );
    const third = await startApp(mock, { dataDir: first.dataDir });
    try {
      const failed = await third.call('GET', '/tt/terms');
      assert.equal(failed.status, 401);
      assert.match(failed.body.error.message, /失效/);
      const after = await third.call('GET', '/tt/status');
      assert.equal(after.body.status, 'anonymous');
      // 退出登录后重新登录依然可用
      const again = await login(third.call);
      assert.equal(again.body.status, 'ready');
    } finally {
      await third.app.close();
    }
  } finally {
    await second.app.close();
    await mock.close();
  }
});

test('课表：未登录时的课表行视图不会被当成登录态', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    const status = await call('GET', '/tt/status');
    assert.equal(status.body.status, 'anonymous');
    assert.equal(status.body.synced.schedules, 0);
    assert.deepEqual(status.body.cache.terms, []);

    // 登录 -> 退出：票据被清掉，业务接口立刻恢复 401
    await login(call);
    const out = await call('POST', '/tt/logout', {});
    assert.equal(out.body.status, 'anonymous');
    const blocked = await call('GET', `/tt/courses?term=${TERM}`);
    assert.equal(blocked.status, 401);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：AI 工具清单与能力接口暴露一致', async () => {
  const mock = await startMockEhall();
  const { call, app } = await startApp(mock);
  try {
    const capabilities = await call('GET', '/ai/capabilities');
    const names = capabilities.body.timetableTools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'timetable_status',
      'timetable_login',
      'timetable_verify_mfa',
      'timetable_terms',
      'timetable_set_term_start',
      'timetable_courses',
      'timetable_refresh',
      'timetable_preview',
      'timetable_apply',
    ]);
    // 写数据的工具必须标注 mutates，Agent 才知道要先预览
    for (const tool of capabilities.body.timetableTools) {
      assert.equal(typeof tool.path, 'string');
      if (tool.path.includes('/apply') || tool.path.includes('/terms/:')) assert.equal(tool.mutates, true);
    }
    // 路由注册：/tt/status 自己就能证明路由生效，另外用 registerTimetableRoutes 的清单兜底
    const status = await call('GET', '/tt/status');
    assert.equal(status.status, 200);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('课表：默认数据集覆盖了位图/单双周/起始日几个坑', async () => {
  const dataset = defaultTimetableDataset();
  assert.equal(dataset.currentTerm, TERM);
  assert.equal(dataset.termStart, TERM_START);
  // 位图长度够长，且能反解出单双周
  assert.deepEqual(bitmapToWeeks('0101010101'), [2, 4, 6, 8, 10]);
  assert.deepEqual(weeksToBitmap([2, 4, 6, 8, 10], 10), '0101010101');
  // 默认数据集里没有课程代码/学分/教学班字段（上游确实没有，不能臆造）
  for (const row of dataset.rows[TERM]) {
    assert.deepEqual(Object.keys(row).sort(), ['JASMC', 'JSJC', 'KCM', 'KSJC', 'SKJS', 'SKXQ', 'SKZC', 'XNXQDM']);
  }
});
