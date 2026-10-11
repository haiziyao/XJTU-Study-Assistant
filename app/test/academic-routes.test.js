/**
 * 学业模块的 HTTP 端点、对话 target 与本地解析器的测试。
 *
 * 关注三件容易出错的事：
 *   1. **错误翻译**：403 必须说成"授权握手失败"并给 502（不是 500、也不是"没权限"），
 *      未登录必须 401 —— 前端靠状态码决定弹登录框还是报上游故障；
 *   2. **写操作要么走预览、要么明确标记**：`/sync/preview` 不能落库；
 *   3. **本地解析器不能抢走日历的输入** —— `tryParse` 取第一个成功的解析器，
 *      学业解析器一旦贪心，「明天下午三点开会」就再也到不了日历模块。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { AcademicParser } from '../src/modules/academic/parser.js';
import { startMockEhall } from './helpers/ehall-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';

async function startApp({ mock } = {}) {
  const server = mock ?? (await startMockEhall());
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-academic-http-'));
  const app = await createServer({ dataDir, academic: server.config() });
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
  return { app, call, mock: server, dataDir };
}

async function synced() {
  const ctx = await startApp();
  const login = await ctx.call('POST', '/academic/login', { username: USER, password: PASS });
  assert.equal(login.status, 200, JSON.stringify(login.body).slice(0, 200));
  return ctx;
}

/* ------------------------------------------------------------------ 登录与状态 */

test('academic HTTP：登录会顺手同步一次，并把学分绩带回来', async () => {
  const { app, call, mock } = await startApp();
  try {
    const login = await call('POST', '/academic/login', { username: USER, password: PASS });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'ready');
    assert.ok(login.body.synced, '登录后应顺手同步');
    assert.equal(login.body.synced.counts.inserted, mock.grades.length);
    assert.equal(login.body.synced.gpa, 3.29);
    assert.equal(login.body.syncError, undefined);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：可以要求登录后不自动同步', async () => {
  const { app, call, mock } = await startApp();
  try {
    const login = await call('POST', '/academic/login', { username: USER, password: PASS, sync: false });
    assert.equal(login.body.status, 'ready');
    assert.equal(login.body.synced, undefined);
    assert.equal((await call('GET', '/academic/grades')).body.items.length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：未登录时受保护的端点返回 401 UNAUTHORIZED', async () => {
  const { app, call, mock } = await startApp();
  try {
    for (const [method, route] of [
      ['POST', '/academic/sync/apply'],
      ['POST', '/academic/sync/preview'],
    ]) {
      const result = await call(method, route, {});
      assert.equal(result.status, 401, `${route} 应 401`);
      assert.equal(result.body.error.code, 'UNAUTHORIZED');
    }
    // 只读端点未登录时返回空列表而不是报错，界面才好渲染空态
    const empty = await call('GET', '/academic/grades');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.items, []);
    assert.equal((await call('GET', '/academic/status')).body.loggedIn, false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：/status 带握手诊断信息', async () => {
  const { app, call, mock } = await synced();
  try {
    const status = await call('GET', '/academic/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.loggedIn, true);
    assert.equal(status.body.grades.total, mock.grades.length);
    assert.equal(status.body.gpa, 3.29);
    assert.equal(status.body.handshake.weuRefreshed, true, '握手诊断要能证明 _WEU 被刷新过');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 查询与统计 */

test('academic HTTP：/grades 支持按学期与纳入状态过滤', async () => {
  const { app, call, mock } = await synced();
  try {
    const all = await call('GET', '/academic/grades');
    assert.equal(all.body.count, 5);
    assert.ok(Array.isArray(all.body.items), '必须是数组（裸数组会被路由层展开成数字键对象）');

    const term = await call('GET', '/academic/grades?term=2024-2025-1');
    assert.equal(term.body.count, 2);

    const excluded = await call('GET', '/academic/grades?included=false');
    assert.equal(excluded.body.count, 1, '默认只有等级制那门是排除的');
    assert.equal(excluded.body.items[0].courseName, '形势与政策');

    const byNature = await call('GET', '/academic/grades?nature=01');
    assert.equal(byNature.body.count, 2, 'mock 里带 KCXZDM=01 的只有高数与大物');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：/stats 与 /terms', async () => {
  const { app, call, mock } = await synced();
  try {
    const stats = await call('GET', '/academic/stats');
    assert.equal(stats.body.gpa, 3.29);
    assert.equal(stats.body.earnedCredits, 11);
    assert.equal(stats.body.totalCredits, 10);
    assert.equal(stats.body.needsAttention.length, 1);
    assert.equal(stats.body.terms.length, 2);

    const termStats = await call('GET', '/academic/stats?term=2024-2025-1');
    assert.equal(termStats.body.gpa, 3.7375);

    const terms = await call('GET', '/academic/terms');
    assert.deepEqual(
      terms.body.items.map((item) => item.term),
      ['2024-2025-2', '2024-2025-1'],
    );
    // 第二学期有 3 条记录（工程制图 + 形势与政策 + 已撤销课程）—— terms 数的是记录，不是有效成绩
    assert.equal(terms.body.items[0].courses, 3);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 同步 */

test('academic HTTP：/sync/preview 不落库，/sync/apply 才落库', async () => {
  const { app, call, mock } = await startApp();
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS, sync: false });

    const preview = await call('POST', '/academic/sync/preview', {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.counts.inserted, mock.grades.length);
    assert.equal((await call('GET', '/academic/grades')).body.items.length, 0, 'preview 不能落库');

    const apply = await call('POST', '/academic/sync/apply', {});
    assert.equal(apply.status, 200);
    assert.equal(apply.body.counts.inserted, mock.grades.length);
    assert.equal((await call('GET', '/academic/grades')).body.items.length, mock.grades.length);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 纳入开关 */

test('academic HTTP：单项纳入开关会同时返回新的统计', async () => {
  const { app, call, mock } = await synced();
  try {
    const grades = (await call('GET', '/academic/grades')).body.items;
    const target = grades.find((g) => g.courseName === '高等数学');

    const off = await call('POST', `/academic/grades/${target.id}/included`, { included: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.grade.included, false);
    // 去掉 5 学分/4.0 后：(3×3.3 + 2×1.5) / 5 = 2.58
    assert.equal(off.body.stats.gpa, 2.58);

    const on = await call('POST', `/academic/grades/${target.id}/included`, { included: true });
    assert.equal(on.body.stats.gpa, 3.29);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：批量开关支持 ids / term / only 预设', async () => {
  const { app, call, mock } = await synced();
  try {
    const byTerm = await call('POST', '/academic/grades/included/bulk', { term: '2024-2025-2', included: false });
    // 第二学期默认纳入的是工程制图与已撤销课程（后者 SFYX=0，但确实有绩点值 0）—— 等级制那门本来就是排除的
    assert.equal(byTerm.body.changed, 2);
    assert.equal(byTerm.body.stats.gpa, 3.7375);

    const onlyAll = await call('POST', '/academic/grades/included/bulk', { only: 'all', included: false });
    assert.equal(onlyAll.body.stats.gpa, null);

    const reset = await call('POST', '/academic/grades/included/reset', {});
    assert.ok(reset.body.changed > 0);
    assert.equal(reset.body.stats.gpa, 3.29, 'reset 应回到同步时的默认状态');

    const ids = (await call('GET', '/academic/grades')).body.items.filter((g) => g.included).slice(0, 2).map((g) => g.id);
    const byIds = await call('POST', '/academic/grades/included/bulk', { ids, included: false });
    assert.equal(byIds.body.changed, 2);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：不存在的成绩单条开关返回 404', async () => {
  const { app, call, mock } = await synced();
  try {
    const result = await call('POST', '/academic/grades/nope/included', { included: true });
    assert.equal(result.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 错误翻译 */

test('academic HTTP：握手失败返回 502 且文案点明是握手问题', async () => {
  const mock = await startMockEhall({ alwaysInvalidWeu: true });
  const { app, call } = await startApp({ mock });
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS, sync: false });
    const result = await call('POST', '/academic/sync/apply', {});
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'UPSTREAM_ERROR');
    assert.match(result.body.error.message, /握手/, '文案必须点明握手，否则会把排查方向带偏');
    assert.match(result.body.error.details.hint, /getAppConfig/, '应给出可操作的提示');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：上游结构变化返回 502 而不是 500', async () => {
  const mock = await startMockEhall();
  const { app, call } = await startApp({ mock });
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS, sync: false });
    mock.state.gradeOverride = '<html>不是 JSON</html>';
    const result = await call('POST', '/academic/sync/apply', {});
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'UPSTREAM_ERROR');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：登录时若同步失败，登录本身仍算成功并把原因带回来', async () => {
  const mock = await startMockEhall({ alwaysInvalidWeu: true });
  const { app, call } = await startApp({ mock });
  try {
    const login = await call('POST', '/academic/login', { username: USER, password: PASS });
    assert.equal(login.status, 200, '登录成功不该被同步失败拖垮');
    assert.equal(login.body.status, 'ready');
    assert.ok(login.body.syncError, '应带回同步失败的原因');
    assert.match(login.body.syncError.message, /握手/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic HTTP：登录缺字段返回 400', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('POST', '/academic/login', { username: USER });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'BAD_REQUEST');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 对话 target */

test('academic 指令：query 只读返回成绩与汇总口径', async () => {
  const { app, mock } = await synced();
  try {
    const result = await app.services.commands.execute({
      ok: true,
      action: 'query',
      target: 'grade',
      filters: { term: '2024-2025-1' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(result.summary.gpa, 3.29);
    assert.equal(result.summary.earnedCredits, 11);
    assert.ok(result.items.every((item) => item.term === '2024-2025-1'));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic 指令：exclude 先预览再执行，且 dryRun 不写库', async () => {
  const { app, mock } = await synced();
  try {
    const draft = { ok: true, action: 'exclude', target: 'grade', filters: { nature: '01' } };
    const preview = await app.services.commands.execute(draft, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.willChange.length, 2, '必修课里默认纳入的是高数与大物');
    assert.equal(app.services.academic.stats().gpa, 3.29, 'dryRun 不能改统计');

    const applied = await app.services.commands.execute(draft);
    assert.equal(applied.changed, preview.affected.length);
    assert.equal(app.services.academic.stats().gpa, 1.5, '排除必修后只剩工程制图(2学分/1.5)');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic 指令：查不到时返回 404 并说明可能是条件不对', async () => {
  const { app, mock } = await synced();
  try {
    await assert.rejects(
      () =>
        app.services.commands.execute({
          ok: true,
          action: 'exclude',
          target: 'grade',
          filters: { keyword: '不存在的课程' },
        }),
      (error) => {
        assert.equal(error.status, 404);
        assert.match(error.message, /没有找到/, '错误信息要能指导用户改条件');
        return true;
      },
    );
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic 指令：sync 走同一条服务路径', async () => {
  const { app, mock } = await startApp();
  try {
    await app.services.academic.login({ username: USER, password: PASS });
    const result = await app.services.commands.execute({ ok: true, action: 'sync', target: 'grade' });
    assert.equal(result.synced, true);
    assert.equal(result.counts.inserted, mock.grades.length);
    assert.match(result.explain, /同步完成/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic 指令：空库时 query 说明需要先同步', async () => {
  const { app, mock } = await startApp();
  try {
    const result = await app.services.commands.execute({ ok: true, action: 'query', target: 'grade' });
    assert.equal(result.count, 0);
    assert.match(result.explain, /同步/);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 本地解析器 */

test('academic 解析器：认得学业指令', () => {
  const parser = new AcademicParser();
  const cases = [
    ['我的学分绩是多少', 'query'],
    ['高等数学考了多少分', 'query'],
    ['有哪些不及格的课', 'query'],
    ['把选修课都排除掉', 'exclude'],
    ['把高等数学纳入学分绩', 'include'],
    ['同步一下成绩', 'sync'],
    ['刷新成绩', 'sync'],
  ];
  for (const [text, action] of cases) {
    const draft = parser.parse(text);
    assert.equal(draft.ok, true, `「${text}」应被识别`);
    assert.equal(draft.action, action, `「${text}」应为 ${action}`);
    assert.equal(draft.target, 'grade');
  }
});

test('academic 解析器：从文本里提取学期与课程名', () => {
  const parser = new AcademicParser();
  const withTerm = parser.parse('2024-2025-1 学期我考了多少分');
  assert.equal(withTerm.ok, true);
  assert.equal(withTerm.filters.term, '2024-2025-1');

  const withCourse = parser.parse('高等数学考了多少分');
  assert.equal(withCourse.filters.keyword, '高等数学');

  const named = parser.parse('2024-2025学年第二学期有哪些课不及格');
  assert.equal(named.filters.term, '2024-2025-2');
  assert.equal(named.filters.failedOnly, true);
});

test('academic 解析器：★ 不抢日历模块的输入', () => {
  const parser = new AcademicParser();
  // 这些必须全部返回 ok:false，否则 tryParse 取第一个成功者，日历模块就收不到输入了
  for (const text of [
    '明天下午三点开会',
    '周五交作业',
    '下周一上午九点组会',
    '把明天的会推迟到后天',
    '每天晚上八点跑步',
    '删掉上周的日程',
    '今天有什么安排',
    '提醒我半小时后打电话',
    '完成写实验报告',
  ]) {
    assert.equal(parser.parse(text).ok, false, `「${text}」不该被学业解析器接管`);
  }
});

test('academic 解析器：接入真实 CommandService 后与日历解析器共存', async () => {
  const { app, mock } = await startApp();
  try {
    // 学业指令走学业
    const grade = await app.services.commands.tryParse('我的学分绩是多少');
    assert.equal(grade.ok, true);
    assert.equal(grade.target, 'grade');

    // 日历指令仍走日历
    const calendar = await app.services.commands.tryParse('明天下午三点开会');
    assert.equal(calendar.ok, true);
    assert.notEqual(calendar.target, 'grade', '日历指令不能被学业解析器抢走');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ AI 声明 */

test('academic：aiTools 聚合进 /ai/capabilities 且都标了 implemented', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('GET', '/ai/capabilities');
    assert.equal(result.status, 200);
    const tools = result.body.aiTools ?? [];
    const mine = tools.filter((tool) => tool.module === 'academic' || String(tool.name).startsWith('academic_'));
    assert.equal(mine.length, 11, `应有 11 个学业工具，实际 ${mine.length}`);
    assert.ok(
      mine.every((tool) => tool.implemented === true),
      '这些接口都真写完了，标成 false 会让 Agent 以为不能用',
    );
    assert.ok(mine.every((tool) => tool.returns), '应给出返回形状');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('academic：aiPrompt 进了系统提示词，并点明与 lms_grades 的区别', async () => {
  const { app, mock } = await startApp();
  try {
    const mod = app.modules?.find?.((item) => item.id === 'academic');
    const blocks = (mod ? [mod] : []).map((item) => item.aiPrompt).filter(Boolean);
    assert.equal(blocks.length, 1, 'academic 应声明 aiPrompt');
    const prompt = blocks[0];
    assert.match(prompt, /target 是 "grade"/);
    assert.match(prompt, /XFJD/, '要说明绩点由教务直接给出');
    assert.match(prompt, /等级制/, '要说明等级制课程不进学分绩');
    assert.match(prompt, /lms_grades/, '必须点明与学堂那套分数的区别，否则模型会混用');
  } finally {
    await app.close();
    await mock.close();
  }
});
