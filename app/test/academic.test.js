/**
 * 学业模块爬取层与同步的端到端测试。
 *
 * 全程走 `test/helpers/ehall-mock.js`：一个复刻了真实教务行为的本地服务器，
 * 其中**成绩接口强制校验授权握手**（`_WEU` 不是当前值就 403）。
 * 所以这些用例不只是"测代码"，而是在钉住那条来之不易的结论：
 * 少了握手，成绩接口一定 403。
 *
 * 覆盖：
 *   - 四步握手确实被走完，且不握手拿不到数据；
 *   - 同步幂等（重复同步不产生重复记录）；
 *   - **同步不覆盖用户意志**（手工排除的课不会被勾回来）；
 *   - 绩点优先用教务给的 XFJD、缺失才回退换算表；
 *   - 无效成绩（SFYX=0）与等级制成绩的处理；
 *   - 各类失败被翻译成可区分的错误码（401 / 403 / 非 JSON / code!=0 / 结构变化）；
 *   - 403 时自动重握手再试一次；
 *   - 上游少返回记录时标 stale 而不是删除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { CookieJar, HttpClient } from '../src/modules/lms/http-client.js';
import { AcademicApi, AcademicError, ACADEMIC_ERROR, normalizeGrade } from '../src/modules/academic/api.js';
import { resolveAcademicConfig } from '../src/modules/academic/config.js';
import { startMockEhall } from './helpers/ehall-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';

/** 起一套「后端 + 指向 mock 教务的 academic 模块」。 */
async function startApp({ mock, dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-academic-')));
  const app = await createServer({ dataDir: dir, academic: mock.config() });
  const info = await app.listen({ port: 0 });
  return { app, info, dir, service: app.services.academic };
}

/**
 * 起一套「已登录」的服务。
 * @param {object} [opts] 传给 mock 的选项
 * @param {object} [opts.mock] 复用已有的 mock（**别在断言失败路径里另起一个**，
 *   否则测的和断言的不是同一套服务 —— 这里踩过一次）
 */
async function loggedIn({ mock: existing, dataDir, ...mockOptions } = {}) {
  const mock = existing ?? (await startMockEhall(mockOptions));
  const ctx = await startApp({ mock, dataDir });
  const result = await ctx.service.login({ username: USER, password: PASS });
  assert.equal(result.status, 'ready', `登录应成功：${JSON.stringify(result).slice(0, 200)}`);
  return { ...ctx, mock };
}

/* ------------------------------------------------------------------ 握手本身 */

test('academic：没有授权握手时成绩接口返回 403 —— 这是真机行为，必须被复刻', async () => {
  const mock = await startMockEhall();
  try {
    // 直接用裸客户端 + 一个"已登录"的会话（服务端认 EHALL_SESSION）
    const jar = new CookieJar();
    const http = new HttpClient({ userAgent: 'test', timeoutMs: 5000, jar });
    await http.get(`${mock.origin}/jwapp/sys/cjcx/*default/index.do`, { follow: true });
    // 上面会 302 到 CAS；这里手动补一个会话票来模拟"已登录但未握手"
    jar.setFromResponse(`${mock.origin}/`, new Headers({ 'set-cookie': 'EHALL_SESSION=ok; Path=/' }));

    const bare = await http.postForm(
      `${mock.origin}/jwapp/sys/cjcx/modules/cjcx/xscjcx.do`,
      { XNXQDM: '*' },
      { follow: true },
    );
    assert.equal(bare.status, 403, '不握手就该 403');

    // 走完握手后同一个客户端就能拿到数据
    await http.get(`${mock.origin}/jwapp/sys/funauthapp/api/getAppConfig/cjcx-${mock.appId}.do`, { follow: true });
    await http.postForm(`${mock.origin}/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do`, { SFQY: '1', APP: mock.appId }, { follow: true });
    const ok = await http.postForm(`${mock.origin}/jwapp/sys/cjcx/modules/cjcx/xscjcx.do`, { XNXQDM: '*' }, { follow: true });
    assert.equal(ok.status, 200, '握手之后应能取数');
    assert.equal(JSON.parse(ok.text).code, '0', '成功码是字符串 "0"');
  } finally {
    await mock.close();
  }
});

test('academic：fetchGrades 会自动走完四步握手', async () => {
  const mock = await startMockEhall();
  try {
    const jar = new CookieJar();
    const http = new HttpClient({ userAgent: 'test', timeoutMs: 5000, jar });
    jar.setFromResponse(`${mock.origin}/`, new Headers({ 'set-cookie': 'EHALL_SESSION=ok; Path=/' }));
    const api = new AcademicApi({ http, config: resolveAcademicConfig(mock.config()) });

    const { rows, handshake } = await api.fetchGrades();
    assert.ok(rows.length > 0, '应取到成绩');
    assert.equal(mock.state.appConfigCalls, 1, '应调用一次 getAppConfig');
    assert.equal(mock.state.appInitCalls, 1, '应调用一次 cxjwggbbdqx');
    assert.equal(handshake.weuRefreshed, true, '_WEU 应被刷新（这正是 403 的根因）');
    assert.equal(handshake.appId, mock.appId, 'appId 应从应用页里取到');
  } finally {
    await mock.close();
  }
});

test('academic：403 时自动重握手再试一次，而不是直接失败', async () => {
  const mock = await startMockEhall();
  try {
    const jar = new CookieJar();
    const http = new HttpClient({ userAgent: 'test', timeoutMs: 5000, jar });
    jar.setFromResponse(`${mock.origin}/`, new Headers({ 'set-cookie': 'EHALL_SESSION=ok; Path=/' }));
    const api = new AcademicApi({ http, config: resolveAcademicConfig(mock.config()) });
    await api.authorize();

    // 握手后服务端又轮换了 _WEU（模拟会话过期）→ 第一次查必然 403
    mock.state.weu = 'weu-stale';
    const { rows } = await api.fetchGrades();
    assert.ok(rows.length > 0, '自动重握手后应能取到数据');
    assert.ok(mock.state.appConfigCalls >= 2, '应重新做过握手');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 归一化 */

test('academic：字段映射与幂等键', () => {
  const config = resolveAcademicConfig(mockConfigStub());
  const grade = normalizeGrade(
    { WID: 'W1', KCM: '线性代数', KCH: 'MATH2001', XF: 3, XFJD: 3.7, ZCJ: 87, XNXQDM: '2024-2025-1', KCXZDM_DISPLAY: '必修', SFYX: '1' },
    config,
  );
  assert.equal(grade.externalId, 'W1');
  assert.equal(grade.courseName, '线性代数');
  assert.equal(grade.credit, 3);
  assert.equal(grade.gradePoint, 3.7);
  assert.equal(grade.gradePointSource, 'school');
  assert.equal(grade.term, '2024-2025-1');
  assert.equal(grade.natureLabel, '必修');
  assert.equal(grade.active, true);
});

test('academic：没有 WID 时用「课程号@学期」兜底，两者都没有才为 null', () => {
  const config = resolveAcademicConfig(mockConfigStub());
  assert.equal(normalizeGrade({ KCM: 'A', KCH: 'K1', XNXQDM: 'T1' }, config).externalId, 'K1@T1');
  assert.equal(normalizeGrade({ KCM: 'A' }, config).externalId, null);
  assert.equal(normalizeGrade({ KCM: '', KCH: '' }, config), null, '连名字和课号都没有的行直接丢弃');
});

function mockConfigStub() {
  return { baseUrl: 'https://example.invalid' };
}

/* ------------------------------------------------------------------ 同步与统计 */

test('academic：同步后学分绩按真实口径算出（优先 XFJD，缺失才换算）', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    const result = await service.sync();
    assert.equal(result.ok, true);
    assert.equal(result.counts.inserted, mock.grades.length, '首次同步应全部新增');

    const stats = service.stats();
    // 参与计算的是：高数 5学分/4.0、大物 3学分/3.3、工程制图 2学分/1.5（换算）
    // 形势与政策（等级制，默认不纳入）、已撤销课程（SFYX=0）都不算
    //   (5×4 + 3×3.3 + 2×1.5) / 10 = (20 + 9.9 + 3) / 10 = 3.29
    assert.equal(stats.gpa, 3.29);
    assert.equal(stats.gpaCredits, 10);
    // 加权平均分：(5×92 + 3×84 + 2×66) / 10 = (460 + 252 + 132) / 10 = 84.4
    assert.equal(stats.weightedAverage, 84.4);
    // totalCredits 只算**被纳入**的；等级制那门默认不纳入，所以是 10
    assert.equal(stats.totalCredits, 10);
    // earnedCredits 不随勾选变化：通过的课都算（高数/大物/工程制图/形势与政策 = 11 学分；
    // 已撤销课程 SFYX=0 不计）
    assert.equal(stats.earnedCredits, 11);
    assert.equal(stats.includedCount, 3);
    assert.equal(stats.validCount, mock.grades.length - 1, '有一条 SFYX=0');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：同步是幂等的 —— 重复同步不产生重复记录', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const first = service.listGrades().length;
    const second = await service.sync();
    assert.equal(service.listGrades().length, first, '记录数不应变化');
    assert.equal(second.counts.inserted, 0, '不应有新增');
    assert.equal(second.counts.updated, 0, '内容没变就不该有更新');
    assert.equal(second.counts.unchanged, mock.grades.length, '应全部判定为未变化');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：★ 同步不覆盖用户意志 —— 手工排除的课不会被勾回来', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const target = service.listGrades().find((g) => g.courseName === '高等数学');
    assert.equal(target.included, true, '前置条件：默认是纳入的');

    await service.setIncluded(target.id, false);
    assert.equal(service.listGrades().find((g) => g.id === target.id).included, false);

    // 再同步一次：内容有变（改一门课的分数），但排除状态必须保留
    mock.grades[0].ZCJ = 95;
    mock.grades[0].XFJD = 4.3;
    const after = await service.sync();
    assert.ok(after.counts.updated >= 1, '分数变化应被同步进来');

    const refreshed = service.listGrades().find((g) => g.id === target.id);
    assert.equal(refreshed.included, false, '★ 用户的排除选择被同步覆盖了');
    assert.equal(refreshed.score, 95, '但分数本身应更新');
    assert.equal(refreshed.gradePoint, 4.3);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：等级制成绩默认不纳入，并出现在 needsAttention 里', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const level = service.listGrades().find((g) => g.courseName === '形势与政策');
    assert.equal(level.included, false, '算不出绩点的课默认不纳入，避免静默污染学分绩');
    assert.equal(level.gradePointSource, null);

    const stats = service.stats();
    assert.equal(stats.needsAttention.length, 1);
    assert.equal(stats.needsAttention[0].courseName, '形势与政策');
    assert.equal(stats.gpa, 3.29, '它不该影响学分绩');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：无效成绩（SFYX=0）不计入统计，但记录仍然保留', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const revoked = service.listGrades().find((g) => g.courseName === '已撤销课程');
    assert.ok(revoked, '记录应保留，便于用户看到');
    assert.equal(revoked.active, false);
    assert.equal(service.stats().gpa, 3.29, '无效成绩不该进分母');
    assert.equal(service.stats().earnedCredits, 11, '撤销的 2 学分不该算进已修学分');
    assert.equal(service.status().grades.active, mock.grades.length - 1, '有效条数应少一条');
    assert.equal(service.status().grades.total, mock.grades.length, '总条数不变');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：上游少返回记录时标 stale 而不是删除', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const before = service.listGrades().length;

    mock.grades.splice(1, 1); // 大物这次没返回
    const result = await service.sync();
    assert.equal(result.counts.stale, 1);
    assert.equal(service.listGrades().length, before, '记录不该被删掉');

    const gone = service.listGrades().find((g) => g.courseName === '大学物理');
    assert.equal(gone.stale, true);
    assert.equal(service.status().grades.stale, 1);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：预览（dryRun）不写库', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    const result = await service.sync({ dryRun: true });
    assert.equal(result.counts.inserted, mock.grades.length);
    assert.equal(service.listGrades().length, 0, 'dryRun 不应落库');
    assert.equal(service.status().lastSyncAt, null);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 批量开关 */

test('academic：批量纳入 —— 按学期、按预设（不及格/未映射）', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();

    // 先全部排除（默认纳入的是 4 门：等级制那门本来就是 false，所以变化数是 4）
    const all = await service.setIncludedBulk({ only: 'all', included: false });
    assert.equal(all.changed, 4);
    assert.equal(service.stats().gpa, null, '全排除后没有可计算的');

    // 只纳入第一学期
    const byTerm = await service.setIncludedBulk({ term: '2024-2025-1', included: true });
    assert.equal(byTerm.changed, 2, '第一学期有高数与大物');
    //   (5×4 + 3×3.3) / 8 = 3.7375
    assert.equal(service.stats().gpa, 3.7375);

    // 重置回默认
    await service.resetIncluded();
    assert.equal(service.stats().gpa, 3.29);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：setIncluded 对不存在的 id 报 404', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await assert.rejects(() => service.setIncluded('nope', true), (error) => error.status === 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 失败翻译 */

async function expectSyncError(setup, expectedCode) {
  // 只起**一个** mock，并让服务挂在它上面 —— 否则测的和断言的不是同一套（踩过这个坑）
  const { app, service, mock } = await loggedIn();
  try {
    setup(mock);
    await assert.rejects(
      () => service.sync(),
      (error) => {
        assert.ok(error instanceof AcademicError, '应抛 AcademicError');
        assert.equal(error.code, expectedCode, `错误码应为 ${expectedCode}，实际 ${error.code}（${error.message}）`);
        return true;
      },
    );
    // 失败信息要能被界面直接展示
    assert.ok(service.status().lastError?.message, '应记录 lastError');
  } finally {
    await app.close();
    await mock.close();
  }
}

test('academic：403 被翻译成"握手失败"而不是"没权限"', async () => {
  // 服务端无论怎么握手都判 403：重试也没用，此时错误信息必须点明是握手问题
  const { app, service, mock } = await loggedIn({ alwaysInvalidWeu: true });
  try {
    await assert.rejects(
      () => service.sync(),
      (error) => {
        assert.equal(error.code, ACADEMIC_ERROR.HANDSHAKE_FAILED);
        assert.equal(error.status, 403);
        assert.match(error.message, /握手/, '错误信息要点明是握手问题，否则会误导排查方向');
        return true;
      },
    );
    assert.equal(service.status().lastError.code, ACADEMIC_ERROR.HANDSHAKE_FAILED);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：401 被翻译成"需要重新登录"，并清掉本地票据', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    mock.state.failNextGradeWith = 401;
    await assert.rejects(
      () => service.sync(),
      (error) => error.code === ACADEMIC_ERROR.NOT_LOGGED_IN && error.status === 401,
    );
    assert.equal(service.status().status, 'anonymous', '票据应已被清掉，避免下次还拿过期会话去撞');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：返回非 JSON 时报"接口可能改版"', async () => {
  await expectSyncError((mock) => {
    mock.state.gradeOverride = '<html><body>登录超时</body></html>';
  }, ACADEMIC_ERROR.INTERFACE_CHANGED);
});

test('academic：code 不是 "0" 时报业务错误', async () => {
  await expectSyncError((mock) => {
    mock.state.gradeOverride = JSON.stringify({ code: '500', msg: '查询失败' });
  }, ACADEMIC_ERROR.BUSINESS_ERROR);
});

test('academic：响应里没有 rows 时报"结构可能已变"', async () => {
  await expectSyncError((mock) => {
    mock.state.omitRows = true;
  }, ACADEMIC_ERROR.INTERFACE_CHANGED);
});

test('academic：未登录时同步直接抛 401，不发请求', async () => {
  const mock = await startMockEhall();
  const { app, service } = await startApp({ mock });
  try {
    await assert.rejects(
      () => service.sync(),
      (error) => error.code === ACADEMIC_ERROR.NOT_LOGGED_IN && error.status === 401,
    );
    assert.equal(mock.state.gradeCalls, 0, '不该真的去请求');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 会话与状态 */

test('academic：会话落盘后重启，restore 不会崩（会话失配时安静降级）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-academic-session-'));
  const first = await loggedIn({ dataDir: dir });
  // 票据文件确实写下来了，且是 0600（Windows 只认只读位，跳过权限断言）
  const sessionPath = path.join(dir, 'academic-session.json');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.ok(session.cookies.length > 0, '会话票据应落盘');
  assert.ok(session.cookies.every((cookie) => typeof cookie.name === 'string'));
  if (process.platform !== 'win32') {
    const info = await stat(sessionPath);
    assert.equal(info.mode & 0o777, 0o600, '会话票据必须是 0600');
  }
  await first.app.close();
  await first.mock.close();

  // 换一个 mock（端口不同 → 旧票据对它无效）重建服务，restore 应安静降级而不是抛
  const mock2 = await startMockEhall();
  const second = await startApp({ mock: mock2, dataDir: dir });
  try {
    assert.ok(['anonymous', 'ready'].includes(second.service.status().status));
  } finally {
    await second.app.close();
    await mock2.close();
  }
});

test('academic：status() 的字段够界面直接渲染', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.sync();
    const status = service.status();
    assert.equal(status.status, 'ready');
    assert.equal(status.loggedIn, true);
    assert.equal(status.grades.total, mock.grades.length);
    assert.equal(status.grades.active, mock.grades.length - 1, '有一条 SFYX=0');
    assert.deepEqual(status.grades.terms, ['2024-2025-1', '2024-2025-2']);
    assert.equal(status.gpa, 3.29);
    assert.equal(typeof status.lastSyncAt, 'string');
    assert.equal(status.lastSyncCounts.inserted, mock.grades.length);
    assert.ok(status.handshake.appId, '应能看到握手诊断信息');
    assert.equal(status.handshake.weuRefreshed, true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：logout 清掉票据与会话状态', async () => {
  const { app, service, mock } = await loggedIn();
  try {
    await service.logout();
    const status = service.status();
    assert.equal(status.status, 'anonymous');
    assert.equal(status.loggedIn, false);
    await assert.rejects(() => service.sync(), (error) => error.status === 401);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：登录密码错误时不进入 ready 状态', async () => {
  const mock = await startMockEhall();
  const { app, service } = await startApp({ mock });
  try {
    const result = await service.login({ username: USER, password: 'wrong-password' });
    assert.notEqual(result.status, 'ready');
    assert.equal(service.status().loggedIn, false);
  } finally {
    await app.close();
    await mock.close();
  }
});
