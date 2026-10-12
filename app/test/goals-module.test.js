/**
 * 目标模块的**集成测试**：真起一个后端（临时 dataDir + 端口 0），把 REST 契约、
 * 三来源合并、gpa 降级、commands 目标与 /ai/capabilities 全走一遍。
 *
 * 为什么这些必须在真实后端上测（而不是只测服务层）：
 *   1. **路由顺序**：`/goals/overview` 与 `/goals/:id` 的先后是这一层才能验证的 ——
 *      顺序写反时 `overview` 会被当成一个目标 id，服务层测试永远发现不了；
 *   2. **合并的真实来源**：待办与事件是**日历模块**的数据，必须用它们自己的接口
 *      （`POST /todos`、`POST /events`）造，否则测的是替身而不是真实契约
 *      （字段名、派生字段、区间语义都可能不一致）。这里**绝不直接写文件**。
 *   3. **gpa 的降级路径**：`current` 要么来自学业模块的真实统计、要么为 null + reason，
 *      这条边界涉及两个模块的装配关系，只有真后端能覆盖；
 *   4. **commands 与 /ai/capabilities**：外部 Agent 只凭这两处判断"能不能写、怎么写"。
 *
 * 不访问外网：全部请求打在 127.0.0.1 的临时实例上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

/** 起一个真实后端（端口 0），返回 `call(method, route, body)` 与临时 dataDir。 */
async function startApp(options = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-goals-http-'));
  const app = await createServer({ dataDir, ...options });
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
      /**
       * 临时目录删不掉**不能让用例失败**。
       *
       * JsonStore 的落盘是异步的（`persist()` 排在 writeQueue 上），`app.close()` 返回时
       * 最后一次写入可能刚把文件重建出来，于是 `rm -rf` 偶发 `ENOTEMPTY`。这是清理动作的
       * 竞态，不是被测行为的问题；真正该断言的东西（接口契约、落盘内容）在用例里已经断言过。
       * 目录留在系统临时区，由系统回收。
       */
      try {
        await fs.promises.rm(dataDir, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

/** 今天 + n 天的日期键（用本地时间算，与服务层的口径一致）。 */
function dateAfter(days) {
  const now = new Date();
  now.setDate(now.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------- 装配

test('goals：模块出现在 /modules 里，声明了 goals / goalSettings 两个集合与路由钩子', async () => {
  const ctx = await startApp();
  try {
    const descriptor = (await ctx.call('GET', '/modules')).body.items.find((item) => item.id === 'goals');
    assert.ok(descriptor, 'goals 模块要出现在 /modules 里');
    assert.equal(descriptor.title, '目标');
    assert.equal(descriptor.order, 47, 'order 必须小于 ai(90)，否则 aiPrompt 聚合会静默失效');
    assert.deepEqual(descriptor.collections, ['goals', 'goalSettings']);
    assert.ok(ctx.app.store.goals.filePath.endsWith('goals.json'), '落盘文件必须是 goals.json');
    assert.ok(ctx.app.store.goalSettings.filePath.endsWith('goal-settings.json'));
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));

    // 空库时列表是空的，不是 404
    const list = await ctx.call('GET', '/goals');
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 0);
    assert.deepEqual(list.body.items, []);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- CRUD

test('goals：POST /goals 落库 201 并返回派生字段', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/goals', {
      title: '考完六级',
      kind: 'exam',
      targetDate: dateAfter(30),
      course: '大学英语',
      note: '12 月那次',
      priority: 2,
      remindDays: [14, 7, 3, 1],
      milestones: [{ title: '背完单词' }, { title: '刷完真题' }],
    });
    assert.equal(created.status, 201);
    const item = created.body.item;
    assert.equal(item.title, '考完六级');
    assert.equal(item.kind, 'exam');
    assert.equal(item.course, '大学英语');
    assert.equal(item.status, 'active');
    assert.equal(item.progress, null);
    assert.equal(item.daysLeft, 30);
    assert.equal(item.severity, 'later');
    assert.equal(item.overdue, false);
    assert.equal(item.milestoneTotal, 2);
    assert.equal(item.milestoneDone, 0);
    assert.deepEqual(item.remindDays, [1, 3, 7, 14], '阈值统一成升序');
    assert.ok(item.createdAt && item.updatedAt);
    assert.ok(item.milestones.every((step) => step.id), '里程碑 id 由服务端补');

    // 落盘了才叫真落库
    const file = JSON.parse(await fs.promises.readFile(ctx.app.store.goals.filePath, 'utf8'));
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].title, '考完六级');
    assert.equal(file.items[0].daysLeft, undefined, '派生字段不落库');
  } finally {
    await ctx.close();
  }
});

test('goals：GET /goals 的筛选与分组计数；PATCH / DELETE 的状态码', async () => {
  const ctx = await startApp();
  try {
    const exam = (await ctx.call('POST', '/goals', { title: '期末考', kind: 'exam', targetDate: dateAfter(40), course: '数据结构' })).body.item;
    await ctx.call('POST', '/goals', { title: '考研', kind: 'goal', targetDate: dateAfter(200) });
    await ctx.call('POST', '/goals', { title: '交大作业', kind: 'deadline', targetDate: dateAfter(3), course: '数据结构' });

    const all = await ctx.call('GET', '/goals');
    assert.equal(all.body.count, 3);
    assert.equal(all.body.counts.total, 3);
    assert.equal(all.body.counts.byKind.exam, 1);
    assert.deepEqual(all.body.items.map((item) => item.title), ['交大作业', '期末考', '考研'], '按目标日升序');

    const byCourse = await ctx.call('GET', '/goals?course=数据结构');
    assert.equal(byCourse.body.count, 2);
    const byKind = await ctx.call('GET', '/goals?kind=exam');
    assert.equal(byKind.body.count, 1);
    const byQuery = await ctx.call('GET', '/goals?q=考研');
    assert.equal(byQuery.body.count, 1);

    // 非法枚举要 400，而不是静默返回空列表
    assert.equal((await ctx.call('GET', '/goals?kind=project')).status, 400);
    assert.equal((await ctx.call('GET', '/goals?status=doing')).status, 400);
    assert.equal((await ctx.call('GET', '/goals?limit=abc')).status, 400);
    assert.equal((await ctx.call('GET', '/goals?limit=9999')).status, 400);

    // 单条
    const one = await ctx.call('GET', `/goals/${exam.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.item.title, '期末考');
    assert.equal((await ctx.call('GET', '/goals/nope')).status, 404);

    // PATCH：只改传了的
    const patched = await ctx.call('PATCH', `/goals/${exam.id}`, { title: '期末考（改）', priority: 1 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.item.title, '期末考（改）');
    assert.equal(patched.body.item.priority, 1);
    assert.equal(patched.body.item.targetDate, exam.targetDate, '没传的字段不变');
    assert.equal((await ctx.call('PATCH', `/goals/${exam.id}`, { progress: 200 })).status, 400);
    assert.equal((await ctx.call('PATCH', '/goals/nope', { title: 'x' })).status, 404);

    // POST 的校验：缺字段 / 坏日期
    const bad = await ctx.call('POST', '/goals', { title: '没有日期' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.field, 'targetDate');
    assert.equal((await ctx.call('POST', '/goals', { title: 'x', targetDate: '2026-02-30' })).status, 400);
    assert.equal((await ctx.call('POST', '/goals', {})).status, 400);

    // DELETE
    const removed = await ctx.call('DELETE', `/goals/${exam.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await ctx.call('GET', '/goals')).body.count, 2);
  } finally {
    await ctx.close();
  }
});

test('goals：POST /goals/:id/progress 改进度、勾里程碑、改状态', async () => {
  const ctx = await startApp();
  try {
    const item = (
      await ctx.call('POST', '/goals', {
        title: '考研复习',
        targetDate: dateAfter(120),
        milestones: [{ title: '数学一轮' }, { title: '英语一轮' }],
      })
    ).body.item;
    const [first, second] = item.milestones;

    const set = await ctx.call('POST', `/goals/${item.id}/progress`, { progress: 30 });
    assert.equal(set.status, 200);
    assert.equal(set.body.item.progress, 30);

    const plus = await ctx.call('POST', `/goals/${item.id}/progress`, { delta: 15 });
    assert.equal(plus.body.item.progress, 45);

    const step = await ctx.call('POST', `/goals/${item.id}/progress`, { milestoneId: first.id, done: true });
    assert.equal(step.body.item.milestoneDone, 1);
    assert.equal(step.body.item.progress, 45, '没全勾完就不动进度');

    const all = await ctx.call('POST', `/goals/${item.id}/progress`, { milestoneId: second.id, done: true });
    assert.equal(all.body.item.milestoneDone, 2);
    assert.equal(all.body.item.progress, 100, '全勾完补 100');

    // 完成：状态与进度一起变
    const done = await ctx.call('POST', `/goals/${item.id}/progress`, { status: 'done' });
    assert.equal(done.body.item.status, 'done');
    assert.equal(done.body.item.progress, 100);

    // 非法输入
    assert.equal((await ctx.call('POST', `/goals/${item.id}/progress`, { milestoneId: 'm-x', done: true })).status, 404);
    assert.equal((await ctx.call('POST', `/goals/${item.id}/progress`, {})).status, 400);
    assert.equal((await ctx.call('POST', '/goals/nope/progress', { progress: 10 })).status, 404);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- ★ overview：三种来源合并

test('goals：GET /goals/overview 合并目标 + 待办 + 事件，并按逾期/日期排序', async () => {
  const ctx = await startApp();
  try {
    // ① 本模块：一条逾期、一条一周内
    const overdueGoal = (
      await ctx.call('POST', '/goals', { title: '逾期的大作业', kind: 'deadline', targetDate: dateAfter(-4), course: '计算机组成' })
    ).body.item;
    await ctx.call('POST', '/goals', { title: '竞赛报名', kind: 'deadline', targetDate: dateAfter(6) });

    // ② 日历待办（走它自己的接口）：一条逾期、一条 2 天内、一条已完成（不该出现）、一条很远（窗口外）
    const overdueTodo = (await ctx.call('POST', '/todos', { title: '交实验报告', deadline: dateAfter(-1), priority: 2 })).body.item;
    await ctx.call('POST', '/todos', { title: '英语作业', deadline: dateAfter(2) });
    const doneTodo = (await ctx.call('POST', '/todos', { title: '已经做完的', deadline: dateAfter(1) })).body.item;
    await ctx.call('POST', `/todos/${doneTodo.id}/completed`, { completed: true });
    await ctx.call('POST', '/todos', { title: '下个学期的事', deadline: dateAfter(200) });

    // ③ 日历事件：一场考试、一个报名截止、一个过去的假期（不该出现）
    const examEvent = (
      await ctx.call('POST', '/events', { title: '数据结构期中考试', category: 'exam', startDate: dateAfter(4), endDate: dateAfter(4) })
    ).body.item;
    await ctx.call('POST', '/events', { title: '四六级报名截止', category: 'deadline', startDate: dateAfter(9), endDate: dateAfter(9) });
    await ctx.call('POST', '/events', { title: '上个月的假期', category: 'holiday', startDate: dateAfter(-20), endDate: dateAfter(-15) });

    const overview = await ctx.call('GET', '/goals/overview?days=30');
    assert.equal(overview.status, 200);
    const body = overview.body;

    // 三份来源各自的条数：goals 2 / todos 2（完成与很远的不算）/ events 2（过去的不算）
    assert.deepEqual(body.sources, { goals: 2, todos: 2, events: 2 }, `实际 ${JSON.stringify(body.sources)}`);
    assert.equal(body.count, 6);
    assert.equal(body.days, 30);
    assert.equal(body.from, dateAfter(0));
    assert.equal(body.to, dateAfter(30));

    // 逾期项压最前（更接近今天的在前），其余按日期升序
    assert.deepEqual(body.items.map((item) => item.title), [
      '交实验报告',
      '逾期的大作业',
      '英语作业',
      '数据结构期中考试',
      '竞赛报名',
      '四六级报名截止',
    ]);
    assert.deepEqual(body.items.map((item) => item.source), ['todo', 'deadline', 'todo', 'event', 'deadline', 'event']);
    assert.deepEqual(body.items.map((item) => item.severity), ['overdue', 'overdue', 'soon', 'soon', 'soon', 'later']);
    assert.deepEqual(body.items.map((item) => item.daysLeft), [-1, -4, 2, 4, 6, 9]);
    assert.deepEqual(body.items.map((item) => item.overdue), [true, true, false, false, false, false]);

    // 每条都带要求的字段
    for (const item of body.items) {
      for (const key of ['source', 'id', 'title', 'date', 'daysLeft', 'overdue', 'severity', 'kind', 'course']) {
        assert.ok(Object.hasOwn(item, key), `条目缺字段 ${key}：${JSON.stringify(item)}`);
      }
    }

    // 事件的 kind 由 category 判定；目标的 source 就是它的 kind
    const examRow = body.items.find((item) => item.id === examEvent.id);
    assert.equal(examRow.kind, 'exam');
    assert.equal(examRow.source, 'event');
    assert.equal(body.items.find((item) => item.id === overdueGoal.id).source, 'deadline');
    assert.equal(body.items.find((item) => item.id === overdueTodo.id).source, 'todo');

    // summary：逾期 2、7 天内 3、30 天内 4
    assert.deepEqual(body.summary, {
      total: 6,
      overdue: 2,
      urgent: 0,
      dueWithin7Days: 3,
      dueWithin30Days: 4,
      attention: 0,
      next: '英语作业',
    });

    // 已完成的目标/待办都不在清单里
    const titles = body.items.map((item) => item.title);
    assert.equal(titles.includes('已经做完的'), false, '完成的待办不该出现在"接下来要面对什么"');
    assert.equal(titles.includes('下个学期的事'), false, '窗口外的待办不进清单');
    assert.equal(titles.includes('上个月的假期'), false, '过去的事件不进清单');

    // 窗口收窄到 3 天：逾期项必须仍在（隐藏逾期等于骗人）
    const narrow = await ctx.call('GET', '/goals/overview?days=3');
    assert.equal(narrow.body.to, dateAfter(3));
    assert.equal(narrow.body.items.filter((item) => item.overdue).length, 2);
    assert.equal(narrow.body.items.some((item) => item.title === '数据结构期中考试'), false);

    // days / limit 的边界
    assert.equal((await ctx.call('GET', '/goals/overview?days=0')).status, 400);
    assert.equal((await ctx.call('GET', '/goals/overview?days=400')).status, 400);
    assert.equal((await ctx.call('GET', '/goals/overview?limit=2')).body.items.length, 2);
    assert.equal((await ctx.call('GET', '/goals/overview?limit=2')).body.count, 6, 'count 是排序后的总条数，不是本页条数');
  } finally {
    await ctx.close();
  }
});

test('goals：课程筛选对目标生效，对没有课程字段的待办不生效', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/goals', { title: '数据结构作业', targetDate: dateAfter(5), course: '数据结构' });
    await ctx.call('POST', '/goals', { title: '英语作文', targetDate: dateAfter(5), course: '大学英语' });
    await ctx.call('POST', '/todos', { title: '通用待办', deadline: dateAfter(5) });

    const filtered = await ctx.call('GET', '/goals/overview?course=数据结构');
    const titles = filtered.body.items.map((item) => item.title);
    assert.equal(titles.includes('英语作文'), false, '别的课程的目标要被筛掉');
    assert.equal(titles.includes('数据结构作业'), true);
    assert.equal(titles.includes('通用待办'), true, '待办没有 course 字段，课程筛选不该把它藏起来');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- alerts

test('goals：GET /goals/alerts 是精简预警版（含 attention 与 summary）', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/goals', { title: '7 天后', targetDate: dateAfter(7) }); // 命中默认阈值
    await ctx.call('POST', '/goals', { title: '3 天后', targetDate: dateAfter(3) }); // 命中默认阈值
    await ctx.call('POST', '/goals', { title: '今天', targetDate: dateAfter(0) });
    await ctx.call('POST', '/goals', { title: '逾期了', targetDate: dateAfter(-2) });
    await ctx.call('POST', '/goals', { title: '很远', targetDate: dateAfter(60) });
    await ctx.call('POST', '/todos', { title: '明天的待办', deadline: dateAfter(1) });

    const alerts = await ctx.call('GET', '/goals/alerts');
    assert.equal(alerts.status, 200);
    const body = alerts.body;
    assert.equal(body.days, 7);
    assert.deepEqual(body.items.map((item) => item.title), ['逾期了', '今天', '明天的待办', '3 天后', '7 天后']);
    assert.equal(body.items.some((item) => item.title === '很远'), false);
    assert.deepEqual(body.attention.map((item) => item.title), ['3 天后', '7 天后'], '只有本模块目标有 remindDays 阈值');
    assert.equal(body.summary.overdue, 1);
    assert.equal(body.summary.dueWithin7Days, 4);
    assert.ok(body.disclaimer.includes('不是学校公布的保研线'));
    // 精简版条目只给能据此行动的字段
    assert.deepEqual(Object.keys(body.items[0]).sort(), ['course', 'date', 'daysLeft', 'id', 'kind', 'overdue', 'remindHit', 'severity', 'source', 'title']);

    // days 参数生效
    const narrow = await ctx.call('GET', '/goals/alerts?days=2');
    assert.equal(narrow.body.items.some((item) => item.title === '3 天后'), false);
    assert.equal((await ctx.call('GET', '/goals/alerts?days=999')).status, 400);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 目标学分绩（诚实版）

test('goals：目标学分绩接口；没有学业数据时 overview.gpa 为 null 且不报错', async () => {
  const ctx = await startApp();
  try {
    // 初始：没设过目标
    const initial = await ctx.call('GET', '/goals/target-gpa');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.targetGpa, null);
    assert.equal(initial.body.disclaimer, '目标是用户自己填的，不是学校公布的保研线');

    // 设置
    const set = await ctx.call('POST', '/goals/target-gpa', { targetGpa: 3.8 });
    assert.equal(set.status, 200);
    assert.equal(set.body.targetGpa, 3.8);
    assert.equal(set.body.writes, true);
    assert.equal(set.body.disclaimer, '目标是用户自己填的，不是学校公布的保研线');
    assert.equal((await ctx.call('POST', '/goals/target-gpa', { targetGpa: 9 })).status, 400);
    assert.equal((await ctx.call('POST', '/goals/target-gpa', { targetGpa: '很高' })).status, 400);

    /**
     * 关键：这个实例里**没有任何成绩数据**（临时 dataDir，也没有登录教务）。
     * 接口必须 200，`gpa.current` 为 null + reason，而不是 500、也不是 0。
     */
    const overview = await ctx.call('GET', '/goals/overview');
    assert.equal(overview.status, 200);
    const gpa = overview.body.gpa;
    assert.equal(gpa.current, null, '没有成绩数据时 current 必须是 null，不能是 0');
    assert.equal(gpa.target, 3.8, '目标值仍然回显（它跟有没有成绩无关）');
    assert.equal(gpa.gap, null, '没有 current 就没有 gap');
    assert.equal(gpa.reason, 'NO_GRADES');
    assert.ok(gpa.message.includes('成绩'), `reason 之外还要有一句人话：${gpa.message}`);
    assert.equal(gpa.disclaimer, '目标是用户自己填的，不是学校公布的保研线');
    assert.equal(overview.body.disclaimer, '目标是用户自己填的，不是学校公布的保研线');
    assert.equal((await ctx.call('GET', '/goals/alerts')).body.gpa.current, null);

    // 清除目标
    const cleared = await ctx.call('POST', '/goals/target-gpa', { targetGpa: null });
    assert.equal(cleared.body.targetGpa, null);
    assert.equal((await ctx.call('GET', '/goals/overview')).body.gpa.target, null);
  } finally {
    await ctx.close();
  }
});

test('goals：有成绩数据时 gpa.current 来自学业模块的真实统计，gap 只是两个数相减', async () => {
  const ctx = await startApp();
  try {
    /**
     * 成绩只能从教务同步进来，没有 POST 接口 —— 所以这里**直接往学业模块自己的集合**
     * 里种两条记录（测试布置数据，不是"本模块写别人的数据"：写它的是测试，不是 GoalService）。
     * `stats()` 是纯本地计算，不联网也不需要登录，因此这条链路在离线环境里是稳定的。
     */
    await ctx.app.store.academicGrades.insert({ courseName: '数据结构', credit: 3, gradePoint: 3, included: true });
    await ctx.app.store.academicGrades.insert({ courseName: '大学英语', credit: 1, gradePoint: 4, included: true });

    // 先用学业模块自己的接口确认它算出来是多少（口径以它为准，本模块只做搬运）
    const stats = await ctx.call('GET', '/academic/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.gpa, 3.25);

    await ctx.call('POST', '/goals/target-gpa', { targetGpa: 3.8 });
    const gpa = (await ctx.call('GET', '/goals/overview')).body.gpa;
    assert.equal(gpa.current, 3.25, 'current 必须来自学业模块的统计');
    assert.equal(gpa.target, 3.8);
    assert.equal(gpa.gap, 0.55);
    assert.equal(gpa.source, 'academic.services.stats');
    assert.equal(gpa.includedCount, 2);
    assert.equal(gpa.reason, null);
    assert.equal(gpa.disclaimer, '目标是用户自己填的，不是学校公布的保研线');
    assert.match(gpa.message, /还差 0\.55/);

    // 学年绩点也不该被本模块改写成别的口径
    await ctx.call('POST', '/goals/target-gpa', { targetGpa: 3 });
    assert.equal((await ctx.call('GET', '/goals/overview')).body.gpa.gap, -0.25, '已超过目标时 gap 为负');
  } finally {
    await ctx.close();
  }
});

test('goals：只装配 calendar + ai + goals 时 gpa 照样是 null + reason，接口不失败', async () => {
  // 不装 academic 模块：连集合都不存在，降级路径必须自己扛住
  const ctx = await startApp({ onlyModules: ['calendar', 'ai', 'goals'] });
  try {
    const created = await ctx.call('POST', '/goals', { title: '考研', targetDate: dateAfter(100) });
    assert.equal(created.status, 201, '没有 academic 模块时 CRUD 完全不受影响');

    const overview = await ctx.call('GET', '/goals/overview?days=365');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.gpa.current, null);
    assert.equal(overview.body.gpa.reason, 'ACADEMIC_MODULE_UNAVAILABLE');
    assert.match(overview.body.gpa.message, /学业模块未装配/);
    assert.equal(overview.body.gpa.disclaimer, '目标是用户自己填的，不是学校公布的保研线');

    // 合并视图里只有本模块那条（calendar 是空的；days=365 才盖得住 100 天后的考研）
    assert.equal(overview.body.count, 1);
    assert.equal(overview.body.sources.goals, 1);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 对话指令

test('goals：/commands/parse 认「我打算 12 月前考完六级」，/commands/run 能落库', async () => {
  const ctx = await startApp();
  try {
    const parsed = await ctx.call('POST', '/commands/parse', { text: '我打算 12 月前考完六级' });
    assert.equal(parsed.status, 200);
    const draft = parsed.body.draft;
    assert.equal(draft.ok, true);
    assert.equal(draft.target, 'goal');
    assert.equal(draft.action, 'create');
    assert.equal(draft.fields.kind, 'exam');
    assert.match(draft.fields.title, /六级/);
    assert.match(draft.fields.targetDate, /^\d{4}-12-31$/, '「12 月前」= 12 月底之前');
    assert.equal(draft.fields.source, 'command');

    // 「记住…」仍然属于记忆模块（不能被目标解析器抢走）
    const memory = await ctx.call('POST', '/commands/parse', { text: '记住 我习惯晚上学习' });
    assert.equal(memory.body.draft.target, 'memory');

    // 「明天交实验报告」仍然属于待办
    const todo = await ctx.call('POST', '/commands/parse', { text: '明天 交实验报告' });
    assert.equal(todo.body.draft.target, 'todo');

    // dryRun 不落库
    const dry = await ctx.call('POST', '/commands/run', { text: '我打算 12 月前考完六级', dryRun: true });
    assert.equal(dry.body.ok, true);
    assert.equal((await ctx.call('GET', '/goals')).body.count, 0, 'dryRun 绝不能写库');
    assert.ok(dry.body.dryRun === true || dry.body.planned, `dryRun 要给出预览：${JSON.stringify(dry.body)}`);

    // 真执行
    const run = await ctx.call('POST', '/commands/run', { text: '我打算 12 月前考完六级' });
    assert.equal(run.body.ok, true);
    assert.equal(run.body.affected.length, 1);
    const list = await ctx.call('GET', '/goals');
    assert.equal(list.body.count, 1);
    assert.match(list.body.items[0].title, /六级/);

    // 查询目标（只读）
    const query = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'goal', filters: { status: 'active' } },
    });
    assert.equal(query.body.ok, true);
    assert.equal(query.body.count, 1);
    assert.equal(query.body.summary.total, 1);

    // overview 也是只读 action，能直接执行
    const overview = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'overview', target: 'goal', filters: { days: 365 } },
    });
    assert.equal(overview.body.ok, true);
    assert.ok(overview.body.summary.gpa, 'overview 的 summary 要带上 gpa 对比');
    assert.equal(overview.body.summary.disclaimer, '目标是用户自己填的，不是学校公布的保研线');

    // 改进度
    const id = list.body.items[0].id;
    const progress = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'progress', target: 'goal', filters: { id }, fields: { progress: 50 } },
    });
    assert.equal(progress.body.ok, true);
    assert.equal(progress.body.item.progress, 50);

    // 写操作在 dryRun 下不落库，且已存在的目标不会被改
    const dryUpdate = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'update', target: 'goal', filters: { id }, fields: { title: '改名' } },
      dryRun: true,
    });
    assert.equal(dryUpdate.body.ok, true);
    assert.equal((await ctx.call('GET', `/goals/${id}`)).body.item.title.includes('六级'), true);

    // 不支持的动作要给"可用：…"的明确错误
    const bad = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'archive', target: 'goal', filters: { id } },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /不支持 action/);

    // 删除
    const removed = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'goal', filters: { id } },
    });
    assert.equal(removed.body.ok, true);
    assert.equal((await ctx.call('GET', '/goals')).body.count, 0);
  } finally {
    await ctx.close();
  }
});

test('goals：定位目标优先用 id；只用标题且匹配到多条时要求先查询', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/goals', { title: '考研数学', targetDate: dateAfter(100) });
    await ctx.call('POST', '/goals', { title: '考研英语', targetDate: dateAfter(100) });

    const ambiguous = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'update', target: 'goal', filters: { keyword: '考研' }, fields: { priority: 2 } },
    });
    assert.equal(ambiguous.status, 409, '两条都匹配时必须让调用方先查清楚，不许替用户挑一条');
    assert.equal(ambiguous.body.error.details.candidates.length, 2);

    const single = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'update', target: 'goal', filters: { keyword: '考研数学' }, fields: { priority: 2 } },
    });
    assert.equal(single.body.ok, true);
    assert.equal(single.body.item.priority, 2);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- AI 能力清单

test('goals：aiTools 聚合进 /ai/capabilities，mutates 如实标注', async () => {
  const ctx = await startApp();
  try {
    const capabilities = await ctx.call('GET', '/ai/capabilities');
    assert.equal(capabilities.status, 200);
    const mine = capabilities.body.aiTools.filter((tool) => tool.module === 'goals');
    assert.ok(mine.length >= 8, `目标工具至少 8 个，实际 ${mine.length}`);

    const names = mine.map((tool) => tool.name);
    for (const expected of ['goals_overview', 'goals_alerts', 'goals_list', 'goals_create', 'goals_update', 'goals_progress', 'goals_delete']) {
      assert.ok(names.includes(expected), `缺工具 ${expected}`);
    }

    for (const tool of mine) {
      assert.equal(tool.implemented, true, `${tool.name} 应该标 implemented: true（接口真写完了）`);
      assert.equal(typeof tool.mutates, 'boolean', `${tool.name} 必须如实标注 mutates`);
      assert.ok(tool.path.startsWith('/goals'), `${tool.name} 的 path 要在 /goals 下`);
      // 取单条的 description 可以短，但"要不要用它、怎么用"必须写在描述里
      if (tool.name !== 'goals_get') {
        assert.ok(tool.description.length > 20, `${tool.name} 的 description 太短，模型看不懂`);
      }
    }

    const readOnly = ['goals_overview', 'goals_alerts', 'goals_list', 'goals_get', 'goals_target_gpa'];
    for (const name of readOnly) {
      assert.equal(mine.find((tool) => tool.name === name).mutates, false, `${name} 是只读的`);
    }
    const writing = ['goals_create', 'goals_update', 'goals_progress', 'goals_delete', 'goals_set_target_gpa'];
    for (const name of writing) {
      assert.equal(mine.find((tool) => tool.name === name).mutates, true, `${name} 是写操作，必须标 true`);
    }

    // 免责声明必须写进工具描述里，Agent 才不会把 targetGpa 说成保研线
    const targetGpaTool = mine.find((tool) => tool.name === 'goals_target_gpa');
    assert.ok(targetGpaTool.description.includes('不是学校公布的保研线'));
  } finally {
    await ctx.close();
  }
});

test('goals：aiPrompt / aiQueryFields / aiQueryLimits 真的被 ai 模块聚合（否则模型不知道有 goal 这个 target）', async () => {
  const ctx = await startApp();
  try {
    // 描述符上的声明
    const mod = ctx.app.modules.find((item) => item.id === 'goals');
    assert.ok(mod, 'goals 模块要在装配列表里');
    assert.ok(mod.aiPrompt.includes('学习目标'), 'aiPrompt 要讲清目标领域');
    assert.ok(mod.aiPrompt.includes('保研线'), 'aiPrompt 必须写清不许编造保研线');
    assert.ok(mod.aiPrompt.includes('不是学校公布的保研线'), '免责声明要原样写进提示词');
    assert.ok(Array.isArray(mod.aiQueryFields.goal), 'aiQueryFields 要有 goal 投影表');
    assert.equal(mod.aiQueryLimits.goal, 60);

    // ★ 聚合结果：ai 模块 order=90 排在最后，在 createServices 里收集各模块的声明。
    //   这里直接读它持有的那份（chat-service 的 domainBlocks / queryFields / queryLimits），
    //   验证"声明 → 真的进了系统提示词与回灌投影"这条链路，而不是只看描述符。
    const ai = ctx.app.services.ai;
    assert.ok(Array.isArray(ai.domainBlocks), 'chat-service 要暴露聚合后的领域说明');
    assert.ok(ai.domainBlocks.some((block) => block.includes('学习目标 / DDL 追踪')), 'goals 的领域说明要进 domainBlocks');
    assert.deepEqual(ai.queryFields.goal.includes('daysLeft'), true, 'goal 投影表要含 daysLeft');
    assert.equal(ai.queryLimits.goal, 60, 'goal 的回灌条数上限要被 ai 采纳');

    // 只读查询的结果里字段要够模型用（投影表就是照这些字段挑的）
    await ctx.call('POST', '/goals', { title: '考研', kind: 'goal', targetDate: dateAfter(100) });
    const query = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'goal', filters: {} },
    });
    const item = query.body.items[0];
    for (const key of ai.queryFields.goal) {
      assert.ok(Object.hasOwn(item, key), `查询结果缺 ${key}，模型就看不到它`);
    }
  } finally {
    await ctx.close();
  }
});
