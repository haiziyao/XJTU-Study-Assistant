/**
 * 学习周报模块的集成测试：**真起一个后端**（临时 dataDir、端口 0），数据全部用各模块
 * **自己的接口**造（`POST /notes`、`POST /todos`、`POST /ai/chat`），再断言周报里的数字
 * 与造出来的**完全一致**。
 *
 * 为什么必须这样测（而不是只测服务层）：
 *   1. **数字是周报的全部价值**。口径写错一个字段（例如把 `updatedAt` 当 `createdAt`、
 *      把软删除的笔记也算进去）在服务层单测里看不出来，但用户一眼就会发现"我没写 5 篇笔记"；
 *   2. **"不偷偷花钱"是契约**。`GET /weekly/report` 必须永远不调用模型，只有 POST generate 才调 ——
 *      这条只能靠假上游的调用计数来证明（mock.state.calls）；
 *   3. **降级不是错误**：没有密钥时必须 200 + `fallback: true` + `reason`，且 stats 照样完整；
 *   4. **缺模块不能拖垮接口**：用只在 `onlyModules` 里装配 weekly/notes/calendar 的实例来证明
 *      "AI 对话 / 成绩不在时接口仍 200、missing 如实列出"。
 *
 * 统计来源**只有四个**（AI 对话 / 笔记 / 待办 / 成绩）。间隔重复卡片与学习目标两个功能
 * 已整体移除，本测试同时断言 `stats` 里不会重新长出这两项。
 *
 * 不访问真实网络：AI 全部指向本地 mock（test/helpers/ai-mock.js）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { addDays, todayKey } from '../src/shared/time.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-weekly-test-1234567890';

/** 起一个真实后端（端口 0）。`onlyModules` 用来构造"某些模块没装配"的世界。 */
async function startApp({ onlyModules, ai } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-weekly-'));
  const app = await createServer({
    dataDir,
    ...(onlyModules ? { onlyModules } : {}),
    ...(ai ? { ai } : {}),
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
  return {
    app,
    info,
    call,
    dataDir,
    async close() {
      await app.close();
      // 清理临时目录是**尽力而为**：并行开发中的模块（如 transfer 的设备服务器）可能在
      // app.close() 之后仍有异步写盘，正好卡在 rm 的 readdir 与 rmdir 之间（ENOTEMPTY）。
      // 删不掉一个系统临时目录不该让周报的测试变红 —— 重试几次，仍失败就留给系统清。
      await fs.promises
        .rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        .catch(() => {});
    },
  };
}

const missingOf = (stats, source) => stats.missing.find((item) => item.source === source) ?? null;

// ---------------------------------------------------------------- 模块装配

test('周报：模块出现在 /modules 里，集合落在 weekly-reports.json', async () => {
  const ctx = await startApp();
  try {
    const listed = await ctx.call('GET', '/modules');
    const descriptor = (listed.body.items ?? []).find((item) => item.id === 'weekly');
    assert.ok(descriptor, 'weekly 模块要在 /modules 里');
    assert.equal(descriptor.title, '学习周报');
    assert.ok(descriptor.collections.includes('weeklyReports'), '集合名必须是 weeklyReports');
    assert.ok(ctx.app.store.weeklyReports.filePath.endsWith('weekly-reports.json'), '落盘文件必须是 weekly-reports.json');
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));
    assert.equal((await ctx.call('GET', '/weekly/reports')).status, 200, '接口必须已注册');
    // 服务是共享注册表里的一员（ai 模块之后仍能拿到它）
    assert.ok(ctx.app.services.weekly, 'services.weekly 应该存在');
    assert.ok(ctx.app.services.commands.targets.includes('weekly'), '指令 target weekly 要注册');
    // 本次移除的两个模块不该再出现在后端模块表里
    const ids = (listed.body.items ?? []).map((item) => item.id);
    for (const gone of ['cards', 'goals']) assert.equal(ids.includes(gone), false, `${gone} 模块必须整体移除`);
  } finally {
    await ctx.close();
  }
});

test('周报：不给 from/to 时按自然周（周一 ~ 周日）算区间', async () => {
  const ctx = await startApp();
  try {
    const today = todayKey();
    const result = await ctx.call('GET', '/weekly/report');
    assert.equal(result.status, 200);
    assert.equal(result.body.stats.days, 7);
    assert.ok(result.body.from <= today && today <= result.body.to, `${result.body.from} ~ ${result.body.to} 应当包含今天`);
    assert.equal(new Date(`${result.body.from}T00:00:00`).getDay(), 1, '自然周必须从周一开始');
    assert.match(result.body.week, /^\d{4}-W\d{2}$/);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 数字与造的数据一致

test('周报：GET /weekly/report 的数字与各模块接口造出来的完全一致（且不调用模型）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好的，记下了。' });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const today = todayKey();

    // ① 笔记：两篇新建，其中一篇再改一次
    const noteA = (await ctx.call('POST', '/notes', { title: '线代错题整理', body: '特征值那几道重做一遍' })).body.summary;
    await ctx.call('POST', '/notes', { title: '英语作文模板', body: '开头句与过渡句' });
    await ctx.call('PATCH', `/notes/${noteA.id}`, { body: '特征值那几道重做一遍，补两个例题' });

    // ② 待办：三条新增，其中一条今天完成；一条已逾期；一条 3 天后到期
    const urgent = (await ctx.call('POST', '/todos', { title: '交实验报告', deadline: today })).body.item;
    await ctx.call('POST', '/todos', { title: '背单词 100 个', deadline: addDays(today, 3) });
    await ctx.call('POST', '/todos', { title: '补交物理作业', deadline: addDays(today, -2) });
    await ctx.call('POST', `/todos/${urgent.id}/completed`, { completed: true });

    // ③ 对话：一次提问 = 1 个新会话 + 2 条消息（1 user + 1 assistant）
    const chat = await ctx.call('POST', '/ai/chat', { text: '今天有什么安排？' });
    assert.equal(chat.status, 200);
    const callsAfterSeeding = mock.state.calls;

    // ④ 读周报（区间 = 今天这一天）：数字必须与上面造的**完全一致**
    const result = await ctx.call('GET', `/weekly/report?from=${today}&to=${today}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.from, today);
    assert.equal(result.body.to, today);
    assert.equal(result.body.days, 1);
    const stats = result.body.stats;

    // 统计项只有四个来源：卡片 / 目标不但在 missing 里没有，连字段都不该存在
    for (const gone of ['cards', 'goals']) {
      assert.equal(Object.prototype.hasOwnProperty.call(stats, gone), false, `${gone} 统计项必须彻底移除`);
      assert.equal(missingOf(stats, gone), null, `${gone} 不该再出现在 missing 里`);
    }

    assert.equal(stats.conversations.newConversations, 1);
    assert.equal(stats.conversations.messages, 2);
    assert.equal(stats.conversations.userMessages, 1);
    assert.equal(stats.conversations.assistantMessages, 1);
    assert.equal(stats.conversations.activeConversations, 1);
    assert.deepEqual(stats.conversations.titles, ['今天有什么安排？']);

    assert.equal(stats.notes.created, 2);
    assert.equal(stats.notes.updated, 2, '两篇都是今天动过的（新建即 updatedAt）');
    assert.equal(stats.notes.updatedOnly, 0);
    assert.equal(stats.notes.deleted, 0);
    assert.deepEqual([...stats.notes.titles].sort(), ['线代错题整理', '英语作文模板']);

    assert.equal(stats.schedule.todosCreated, 3);
    assert.equal(stats.schedule.todosCompleted, 1, '只有勾选完成的那条算完成');
    assert.equal(stats.schedule.todosOpen, 2);
    assert.equal(stats.schedule.todosOverdue, 1, '补交物理作业已逾期');
    assert.equal(stats.schedule.todosDueSoon, 1, '背单词 3 天后到期（今天到期那条已完成，不算）');
    assert.equal(stats.schedule.attention[0].title, '补交物理作业', '逾期排在最前面');

    // 成绩：装好了 academic 但一条成绩都没有 → gpa 是 null（不是 0）、没有变化
    assert.ok(stats.grades, 'academic 装配了就该有 grades');
    assert.equal(stats.grades.gpa, null);
    assert.equal(stats.grades.changed, false);

    assert.equal(stats.partial, stats.missing.length > 0);

    // ⑤ GET 绝不调用模型：上游调用次数在读取前后不变
    assert.equal(mock.state.calls, callsAfterSeeding, 'GET /weekly/report 不许调用模型');
    // ⑥ 没有缓存时只给 stats，report 必须是 null + hint（不偷偷生成）
    assert.equal(result.body.cached, false);
    assert.equal(result.body.report, null);
    assert.match(result.body.hint, /generate/);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('周报：空区间给 0 与 null（而不是编数字），接口仍 200', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.call('GET', '/weekly/report?from=2000-01-03&to=2000-01-09');
    assert.equal(result.status, 200);
    const stats = result.body.stats;
    assert.equal(stats.week, '2000-W01');
    assert.equal(stats.conversations.newConversations, 0, '来源可用时给 0');
    assert.equal(stats.notes.created, 0);
    assert.equal(stats.schedule.todosCreated, 0);
    assert.equal(result.body.report, null);
    assert.equal(result.body.statsChangedSinceReport, null);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 生成 / 缓存 / 降级

test('周报：没有配置 AI 密钥时 generate 走降级 —— ok + fallback + reason，stats 照常完整', async () => {
  // apiKey: '' 显式清空（并盖掉可能存在的 PC_AI_API_KEY 环境变量），保证这条路径确定走降级
  const ctx = await startApp({ ai: { apiKey: '' } });
  try {
    const today = todayKey();
    await ctx.call('POST', '/notes', { title: '概率论公式整理', body: '贝叶斯那节' });
    await ctx.call('POST', '/notes', { title: '数据结构错题', body: '红黑树删除' });
    await ctx.call('POST', '/notes', { title: '英语听力笔记', body: '连读规则' });
    await ctx.call('POST', '/todos', { title: '交作业', deadline: today });

    const caps = await ctx.call('GET', '/ai/capabilities');
    assert.equal(caps.body.available, false, '这条测试的前提是"没有可用模型"');

    const generated = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    assert.equal(generated.status, 200, '报告生成失败不该是错误状态');
    assert.equal(generated.body.ok, true);
    assert.equal(generated.body.cached, false);
    assert.equal(generated.body.fallback, true);
    assert.equal(generated.body.model, null, '降级时不许留着模型名');
    assert.ok(typeof generated.body.reason === 'string' && generated.body.reason.length > 0, '要带降级原因');
    assert.ok(generated.body.id, '要落库成一条周报');
    assert.equal(generated.body.week, generated.body.stats.week);

    // stats 照常完整、且与造的数据一致
    const stats = generated.body.stats;
    assert.equal(stats.notes.created, 3);
    assert.equal(stats.schedule.todosCreated, 1);
    assert.equal(generated.body.report.includes('新写 3 篇笔记'), true, `规则小结要用真实数字：${generated.body.report}`);
    assert.equal(generated.body.report.includes('学习投入'), true);
    assert.equal(generated.body.report.includes('笔记与成绩'), true);
    assert.equal(generated.body.report.includes('需要注意的事'), true);
    assert.equal(/小时/.test(generated.body.report), false, '系统没有"学习时长"数据源，任何路径都不许出现小时数');
    // 已移除功能的概念不许被报告重新编出来
    assert.equal(/卡片|学习目标|复习/.test(generated.body.report), false, `报告不该提已移除的功能：${generated.body.report}`);
    assert.ok(generated.body.report.length <= 2000);

    // 落库了，GET 立刻能读到（并且是缓存）
    const read = await ctx.call('GET', `/weekly/report?from=${today}&to=${today}`);
    assert.equal(read.body.cached, true);
    assert.equal(read.body.id, generated.body.id);
    assert.equal(read.body.report, generated.body.report);
    assert.equal(read.body.fallback, true);
    assert.equal(read.body.statsChangedSinceReport, false);

    // 历史列表里也有它
    const listed = await ctx.call('GET', '/weekly/reports');
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.items[0].report, generated.body.report);
  } finally {
    await ctx.close();
  }
});

test('周报：同一周第二次 generate 命中缓存（不加调用），force 才重新生成', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '2026-W02（共 1 天）小结：这周以整理笔记为主。' });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const today = todayKey();
    await ctx.call('POST', '/notes', { title: '离散数学笔记', body: '图论' });

    const first = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    assert.equal(first.status, 200);
    assert.equal(first.body.cached, false);
    assert.equal(first.body.fallback, false, '配了假上游就该真的走模型');
    assert.equal(first.body.model, 'mock-chat');
    assert.equal(first.body.report, '2026-W02（共 1 天）小结：这周以整理笔记为主。');
    const callsAfterFirst = mock.state.calls;
    assert.equal(callsAfterFirst >= 1, true, '第一次生成确实调用了上游');

    // 第二次：命中缓存，**不再调用上游**，generatedAt 不变
    const second = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    assert.equal(second.body.cached, true);
    assert.equal(second.body.id, first.body.id, '一周一条：原地返回，不新增');
    assert.equal(second.body.generatedAt, first.body.generatedAt);
    assert.equal(second.body.report, first.body.report);
    assert.equal(mock.state.calls, callsAfterFirst, '命中缓存不许重复花 token');
    assert.equal((await ctx.call('GET', '/weekly/reports')).body.total, 1);

    // force: 重新生成（同一条记录原地更新，generatedAt 变新）
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forced = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today, force: true });
    assert.equal(forced.body.cached, false);
    assert.equal(forced.body.id, first.body.id, 'force 也是同一条，不产生重复周报');
    assert.notEqual(forced.body.generatedAt, first.body.generatedAt);
    assert.equal(mock.state.calls > callsAfterFirst, true, 'force 必须真的再调一次上游');
    assert.equal((await ctx.call('GET', '/weekly/reports')).body.total, 1);

    // 模型这一次收到的提示词里必须带三条硬规则（只依据数字 / 没有学习时长 / null 不是 0）
    const prompt = mock.state.bodies.at(-1).messages.map((item) => item.content).join('\n');
    assert.match(prompt, /只依据/);
    assert.match(prompt, /学习时长/);
    assert.match(prompt, /400 字/);
    assert.match(prompt, /学习投入|笔记与成绩|需要注意的事/);
    // 提示词不许再提已移除的功能，否则模型会照着旧概念编数字
    assert.equal(/卡片|学习目标/.test(prompt), false, '统计提示词里不该出现已移除功能的概念');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

// ---------------------------------------------------------------- 缺模块

test('周报：缺 AI 对话 / 成绩时 missing 如实列出、接口仍 200、其它来源照常有数', async () => {
  // 只装配 weekly + notes + calendar：ai / academic 都不在
  const ctx = await startApp({ onlyModules: ['weekly', 'notes', 'calendar'] });
  try {
    const today = todayKey();
    await ctx.call('POST', '/notes', { title: '这周的读书笔记', body: '第一章' });
    await ctx.call('POST', '/todos', { title: '写实验报告', deadline: today });

    const result = await ctx.call('GET', `/weekly/report?from=${today}&to=${today}`);
    assert.equal(result.status, 200, '缺模块绝不能把接口打挂');
    const stats = result.body.stats;

    for (const source of ['conversations', 'grades', 'pomodoro']) {
      assert.equal(stats[source], null, `${source} 没装配时必须 null`);
      const item = missingOf(stats, source);
      assert.ok(item, `${source} 必须出现在 missing 里`);
      assert.equal(item.reason, 'unavailable');
      assert.ok(item.detail.length > 0, 'missing 要说清为什么');
    }
    assert.equal(stats.partial, true);

    // 装配了的来源照常有数字（缺别人不影响自己）
    assert.equal(stats.notes.created, 1);
    assert.equal(stats.schedule.todosCreated, 1);

    // 生成也照常能用：降级成规则小结，并在正文里如实说明缺了什么
    const generated = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.ok, true);
    assert.equal(generated.body.fallback, true);
    assert.equal(generated.body.report.includes('缺：'), true, `降级正文要列缺失来源：${generated.body.report}`);
    assert.equal(/AI 对话/.test(generated.body.report), true);
    assert.equal(/成绩/.test(generated.body.report), true);
    assert.equal(generated.body.stats.missing.length, 3);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 校验与错误

test('周报：时间参数 400（含不存在的日期）、to 早于 from 400、未知 id 404、limit 校验', async () => {
  const ctx = await startApp();
  try {
    for (const [route, field] of [
      ['/weekly/report?from=2026-1-5', 'from'],
      ['/weekly/report?from=2026-02-30', 'from'],
      ['/weekly/report?to=昨天', 'to'],
      [`/weekly/report?from=${todayKey()}&to=2000-01-01`, 'to'],
    ]) {
      const bad = await ctx.call('GET', route);
      assert.equal(bad.status, 400, `${route} 应该 400`);
      assert.equal(bad.body.error.code, 'BAD_REQUEST');
      assert.equal(bad.body.error.details.field, field);
    }
    for (const body of [
      { from: '2026-13-01' },
      { to: '2026-02-30' },
      { from: '2026-05-01', to: '2026-04-01' },
      'not-an-object',
    ]) {
      const bad = await ctx.call('POST', '/weekly/report/generate', body);
      assert.equal(bad.status, 400, `generate ${JSON.stringify(body)} 应该 400`);
    }
    // 空串当"没传"（前端清空输入框就是这么发的），不该 400
    assert.equal((await ctx.call('GET', '/weekly/report?from=&to=')).status, 200);

    for (const route of ['/weekly/reports?limit=abc', '/weekly/reports?limit=0', '/weekly/reports?limit=999']) {
      const bad = await ctx.call('GET', route);
      assert.equal(bad.status, 400, `${route} 应该 400`);
      assert.equal(bad.body.error.details.field, 'limit');
    }

    const missing = await ctx.call('DELETE', '/weekly/reports/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  } finally {
    await ctx.close();
  }
});

test('周报：历史按周倒序、DELETE 删掉一条、再删同一条 404', async () => {
  const ctx = await startApp({ ai: { apiKey: '' } });
  try {
    const today = todayKey();
    const thisWeek = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    const lastWeekDay = addDays(today, -7);
    const lastWeek = await ctx.call('POST', '/weekly/report/generate', { from: lastWeekDay, to: lastWeekDay });
    assert.equal(thisWeek.status, 200);
    assert.equal(lastWeek.status, 200);

    const listed = await ctx.call('GET', '/weekly/reports');
    assert.equal(listed.body.total, 2);
    assert.deepEqual(
      listed.body.items.map((item) => item.from),
      [today, lastWeekDay],
      '按周倒序（from 倒序）',
    );
    assert.equal((await ctx.call('GET', '/weekly/reports?limit=1')).body.count, 1);

    const removed = await ctx.call('DELETE', `/weekly/reports/${lastWeek.body.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await ctx.call('GET', '/weekly/reports')).body.total, 1);
    assert.equal((await ctx.call('DELETE', `/weekly/reports/${lastWeek.body.id}`)).status, 404);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 指令与工具

test('周报：commands 目标 weekly —— query 只读、create 生成、dryRun 不调模型', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '本周小结：笔记与待办都动了一点。' });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const today = todayKey();
    await ctx.call('POST', '/notes', { title: '操作系统笔记', body: '进程调度' });

    // ① query：还没有报告 → count 0，但 summary 里有现算的真实数字（模型据此也能回答）
    const before = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'weekly', filters: { from: today, to: today } },
      { dryRun: true },
    );
    assert.equal(before.ok, true);
    assert.equal(before.target, 'weekly');
    assert.equal(before.count, 0);
    assert.deepEqual(before.items, []);
    assert.equal(before.summary.stats['笔记'].新建, 1, '没报告时也要把现算数字给模型');
    assert.match(before.explain, /还没有生成周报/);
    assert.equal((await ctx.call('GET', '/commands/logs')).body.items.length, 0, 'dryRun 连指令日志都不写');

    // ② dryRun create：只预览，**不调用模型**
    const callsBefore = mock.state.calls;
    const preview = await ctx.call('POST', '/commands/execute', {
      dryRun: true,
      draft: { ok: true, action: 'create', target: 'weekly', fields: { from: today, to: today } },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.deepEqual(preview.body.planned.fields, { from: today, to: today, force: false });
    assert.equal(preview.body.cached, false);
    assert.equal(preview.body.stats.notes.created, 1);
    assert.equal(mock.state.calls, callsBefore, 'dryRun 预览不许花 token');

    // ③ 真正执行：走 /commands/run 之外的另一条路（直接给 draft），会生成并落库
    const executed = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'create', target: 'weekly', fields: { from: today, to: today } },
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.item.fallback, false);
    assert.equal(executed.body.affected.length, 1);
    assert.equal(mock.state.calls > callsBefore, true, '真正执行才调用模型');

    // ④ 再 query：这次能读到报告正文
    const after = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'weekly', filters: { from: today, to: today } },
      { dryRun: true },
    );
    assert.equal(after.count, 1);
    assert.equal(after.items[0].report, '本周小结：笔记与待办都动了一点。');
    assert.equal(after.items[0].week, executed.body.item.week);

    // ⑤ 不支持的 action 要给"可用：…"的明确错误，而不是静默
    await assert.rejects(
      () => ctx.app.services.commands.execute({ ok: true, action: 'delete', target: 'weekly', filters: { id: 'x' } }),
      (error) => error.status === 400 && /query/.test(error.message),
    );

    // ⑥ 自然语言解析不是本模块的入口（没有注册解析器）——但 target 是注册过的
    assert.ok(ctx.app.services.commands.targets.includes('weekly'));
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('周报：/ai/capabilities 里两个工具一读一写，且与路由一致', async () => {
  const ctx = await startApp();
  try {
    const caps = await ctx.call('GET', '/ai/capabilities');
    const tools = (caps.body.aiTools ?? []).filter((tool) => tool.module === 'weekly');
    assert.equal(tools.length, 2);
    const get = tools.find((tool) => tool.name === 'weekly_report_get');
    const generate = tools.find((tool) => tool.name === 'weekly_report_generate');
    assert.ok(get && generate, '要声明 weekly_report_get 与 weekly_report_generate');
    assert.equal(get.method, 'GET');
    assert.equal(get.path, '/weekly/report');
    assert.equal(get.mutates, false, '读取必须标成只读');
    assert.equal(get.implemented, true);
    assert.equal(generate.method, 'POST');
    assert.equal(generate.path, '/weekly/report/generate');
    assert.equal(generate.mutates, true, '生成会调用模型并写库');
    assert.equal(generate.implemented, true);
    assert.match(generate.description, /token|缓存|降级/);
    assert.match(get.description, /null/);
    for (const tool of tools) assert.equal(tool.requiresAuth, false, '周报是本机数据，不依赖学校登录');
  } finally {
    await ctx.close();
  }
});

test('周报：aiPrompt 会被 ai 模块聚合进系统提示词（没有学习时长这条硬规则）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '收到。' });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    await ctx.call('POST', '/ai/chat', { text: '你好' });
    const system = mock.state.bodies.at(-1).messages[0].content;
    assert.match(system, /学习周报/);
    assert.match(system, /学习时长/, '要明说没有"学习时长"这个数据源');
    assert.match(system, /weekly_report_generate|target.*weekly/);
  } finally {
    await ctx.close();
    await mock.close();
  }
});


/**
 * 跨功能测试（B 组 S23/S24）发现的缺陷：`ai.complete()` 的用量**完全不计入** `/ai/usage`，
 * 于是周报这类"后台自动花的钱"在用量统计里看不见，用户会低估账单。
 * 现在按天+用途记进 `aiUsage` 账本，并在 usage 响应里单独报 `background`。
 */
test('周报：后台模型调用的用量要计入 /ai/usage（background 字段）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '本周小结：新写 2 篇笔记。' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const before = (await call('GET', '/ai/usage')).body;
    const generated = await call('POST', '/weekly/report/generate', { from: '2026-10-12', to: '2026-10-12', force: true });
    assert.equal(generated.status, 200, JSON.stringify(generated.body)?.slice(0, 200));
    assert.equal(generated.body.fallback, false, '这次应该真的调用了模型（否则测不到记账）');

    const after = (await call('GET', '/ai/usage')).body;
    assert.ok(
      (after.background?.calls ?? 0) > (before.background?.calls ?? 0),
      `后台调用次数要 +1：before=${JSON.stringify(before.background)} after=${JSON.stringify(after.background)}`,
    );
    assert.ok((after.background?.total ?? 0) > (before.background?.total ?? 0), '后台 token 也要累计');
    assert.ok((after.tokens?.total ?? 0) >= (after.background?.total ?? 0), '总量里要含后台那部分');
  } finally {
    await app.close();
    await mock.close();
  }
});
