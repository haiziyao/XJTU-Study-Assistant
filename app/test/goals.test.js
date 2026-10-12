/**
 * 目标模块的**服务层**测试：校验规则、进度与里程碑语义、severity / daysLeft 的边界，
 * 以及不依赖 HTTP 的 overview 三来源合并。
 *
 * 为什么服务层要单独测（`npm test` 里已经有真起后端的 goals-module.test.js）：
 *   1. **日期边界**必须用注入时钟测。"今天到期""已经逾期""跨月跨年"如果用系统时间测，
 *      只在某些日期跑得过 —— 那种测试比没有更糟（它会在某个月份突然变红，然后被人改成
 *      "反正现在过"）。这里所有服务实例都注入固定的 `now`。
 *   2. **severity 的每一档都要钉死**：它是首页排序与 AI 话术的唯一依据，改动一次影响全站。
 *   3. **合并排序的口径**：`overview` 的排序键（severity → 日期 → 来源）只能在这一层验证，
 *      走 HTTP 时还要先造一堆数据，失败原因会被埋在别处。
 *
 * 存储用内存替身（不落盘）：这一层测的是服务的行为，不是 JsonStore；
 * 真正的落盘与路由契约在 goals-module.test.js 里用临时目录验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GoalService, GPA_DISCLAIMER, daysBetweenKeys, severityOf, summarize } from '../src/modules/goals/service.js';

// ---------------------------------------------------------------- 测试替身

/**
 * 内存集合替身：只实现服务层实际用到的那几个方法（all / get / insert / update / remove）。
 *
 * 刻意**不**复刻 JsonStore 的排序与克隆语义：如果哪天服务层偷偷依赖了"all() 按 createdAt 排序"，
 * 这个替身会让它暴露出来，而不是悄悄跟着一起对。
 */
function memoryCollection() {
  const rows = new Map();
  let seq = 0;
  return {
    all: () => [...rows.values()].map((row) => ({ ...row })),
    get: (id) => (rows.has(id) ? { ...rows.get(id) } : undefined),
    async insert(data) {
      seq += 1;
      const record = { ...data, id: `t-${seq}`, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`, updatedAt: '2026-01-01T00:00:00Z' };
      rows.set(record.id, record);
      return { ...record };
    },
    async update(id, patch) {
      const current = rows.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, id, updatedAt: '2026-01-02T00:00:00Z' };
      rows.set(id, next);
      return { ...next };
    },
    async remove(id) {
      return rows.delete(id);
    },
  };
}

function makeStore() {
  return { goals: memoryCollection(), goalSettings: memoryCollection(), academicGrades: memoryCollection() };
}

/** 造一个服务，固定"今天"为 `today`（默认 2026-03-15，一个不在月初月末的日子）。 */
function makeService({ today = '2026-03-15', services = {}, store = makeStore() } = {}) {
  const goalService = new GoalService({ store, services, now: () => new Date(`${today}T09:00:00`) });
  return { goals: goalService, store };
}

/** 断言某个调用抛出 400（HttpError.badRequest 的形状）。 */
async function assertBadRequest(run, hint) {
  await assert.rejects(run, (error) => {
    assert.equal(error.status, 400, `${hint ?? ''} 应该 400，实际 ${error.status}：${error.message}`);
    assert.equal(error.code, 'BAD_REQUEST');
    return true;
  });
}

// ---------------------------------------------------------------- daysLeft / severity 边界

test('goals 服务：daysLeft 的边界 —— 今天到期 0、昨天逾期 -1、跨月跨年都按整数天算', () => {
  // 纯函数层：不依赖任何时钟
  assert.equal(daysBetweenKeys('2026-03-15', '2026-03-15'), 0, '同一天是 0');
  assert.equal(daysBetweenKeys('2026-03-15', '2026-03-16'), 1);
  assert.equal(daysBetweenKeys('2026-03-15', '2026-03-14'), -1, '昨天是 -1');
  assert.equal(daysBetweenKeys('2026-03-15', '2026-04-15'), 31, '跨月：3 月有 31 天');
  assert.equal(daysBetweenKeys('2026-02-28', '2026-03-01'), 1, '平年 2 月末到 3 月初是 1 天');
  assert.equal(daysBetweenKeys('2024-02-28', '2024-03-01'), 2, '闰年 2 月有 29 日');
  assert.equal(daysBetweenKeys('2025-12-31', '2026-01-01'), 1, '跨年是 1 天');
  assert.equal(daysBetweenKeys('2026-01-01', '2027-01-01'), 365, '平年整年 365 天');
});

test('goals 服务：severity 判定表逐档钉死（overdue / urgent / soon / later）', () => {
  assert.equal(severityOf(-30), 'overdue');
  assert.equal(severityOf(-1), 'overdue', '昨天就该是 overdue');
  assert.equal(severityOf(0), 'urgent', '今天到期是 urgent，不是 overdue');
  assert.equal(severityOf(1), 'urgent', '明天到期也是 urgent');
  assert.equal(severityOf(2), 'soon');
  assert.equal(severityOf(7), 'soon', '7 天是 soon —— 默认 remindDays 里有 7，闭区间才响得起来');
  assert.equal(severityOf(8), 'later');
  assert.equal(severityOf(365), 'later');
});

test('goals 服务：decorate 在"今天到期 / 已逾期 / 窗口外"三种情况下的派生字段', async () => {
  const { goals } = makeService({ today: '2026-03-15' });
  const todayItem = await goals.create({ title: '今天交', targetDate: '2026-03-15' });
  const pastItem = await goals.create({ title: '昨天交', targetDate: '2026-03-14' });
  const farItem = await goals.create({ title: '三个月后', targetDate: '2026-06-15' });

  assert.equal(todayItem.daysLeft, 0);
  assert.equal(todayItem.severity, 'urgent');
  assert.equal(todayItem.overdue, false, '今天到期不是逾期');

  assert.equal(pastItem.daysLeft, -1);
  assert.equal(pastItem.severity, 'overdue');
  assert.equal(pastItem.overdue, true);

  assert.equal(farItem.daysLeft, 92);
  assert.equal(farItem.severity, 'later');
  assert.equal(farItem.overdue, false);

  // 派生字段不落库：再取一次仍然按"今天"现算，而不是取存下来的旧值
  assert.equal(Object.hasOwn(goals.get(todayItem.id), 'daysLeft'), false, 'daysLeft 不该落库');
});

// ---------------------------------------------------------------- 校验

test('goals 服务：创建时的默认值（kind / status / priority / progress / remindDays / source）', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: '  考完六级  ', targetDate: '2026-12-31' });
  assert.equal(item.title, '考完六级', '标题首尾空白要修掉');
  assert.equal(item.kind, 'goal');
  assert.equal(item.status, 'active');
  assert.equal(item.priority, 0);
  assert.equal(item.progress, null, '没填进度时是 null，不是 0');
  assert.deepEqual(item.milestones, []);
  assert.deepEqual(item.remindDays, [7, 3, 1], '默认预警阈值');
  assert.equal(item.source, 'manual');
  assert.equal(item.course, null);
  assert.equal(item.note, '');
});

test('goals 服务：校验失败一律 400，并且说清是哪个字段', async () => {
  const { goals } = makeService();

  await assertBadRequest(() => goals.create({ title: '没有日期' }), 'targetDate 必填');
  await assertBadRequest(() => goals.create({ targetDate: '2026-05-01' }), 'title 必填');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026/05/01' }), '日期格式');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-02-30' }), '2 月没有 30 日');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-13-01' }), '没有 13 月');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', kind: 'project' }), 'kind 枚举');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', status: 'doing' }), 'status 枚举');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', progress: 101 }), 'progress 上限');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', progress: -1 }), 'progress 下限');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', priority: 3 }), 'priority 上限');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', remindDays: [0] }), 'remindDays 下限');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', remindDays: [90] }), 'remindDays 上限');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', milestones: [{ done: true }] }), '里程碑缺 title');
  await assertBadRequest(() => goals.create({ title: 'x', targetDate: '2026-05-01', milestones: [{ title: 'a', due: '5月1日' }] }), '里程碑 due 格式');
  await assertBadRequest(() => goals.create({ title: 'x'.repeat(121), targetDate: '2026-05-01' }), '标题超长');

  // 失败之后库里必须还是空的（校验在写之前）
  assert.equal(goals.list().count, 0, '校验失败不该留下半条记录');
});

test('goals 服务：remindDays 去重 + 升序（同一份阈值只有一种存储形态）', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: 'x', targetDate: '2026-05-01', remindDays: [3, 7, 3, 1] });
  assert.deepEqual(item.remindDays, [1, 3, 7]);
});

test('goals 服务：里程碑 id 自动补齐，且已有 id 会沿用', async () => {
  const { goals } = makeService();
  const item = await goals.create({
    title: 'x',
    targetDate: '2026-05-01',
    milestones: [{ title: '第一步' }, { id: 'keep-me', title: '第二步', done: true, due: '2026-04-01' }],
  });
  assert.ok(item.milestones[0].id, '没给 id 的里程碑要自动生成');
  assert.equal(item.milestones[1].id, 'keep-me', '给了 id 就沿用（前端手里的句柄不能失效）');
  assert.equal(item.milestones[1].done, true);
  assert.equal(item.milestones[1].due, '2026-04-01');
  assert.equal(item.milestones[0].due, null);
  assert.equal(item.milestoneTotal, 2);
  assert.equal(item.milestoneDone, 1);
});

// ---------------------------------------------------------------- 更新

test('goals 服务：PATCH 只改传了的字段', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: '原题', targetDate: '2026-05-01', course: '英语', note: '备注' });
  const updated = await goals.update(item.id, { title: '新题' });
  assert.equal(updated.title, '新题');
  assert.equal(updated.targetDate, '2026-05-01', '没传的字段保持不变');
  assert.equal(updated.course, '英语');
  assert.equal(updated.note, '备注');
  assert.equal(updated.createdAt, item.createdAt, '创建时间不该被刷新');
});

test('goals 服务：改成 done 会把进度补到 100；但里程碑全勾完不会自动改状态', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: 'x', targetDate: '2026-05-01', progress: 60, milestones: [{ title: 'a' }] });

  const done = await goals.update(item.id, { status: 'done' });
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100, '点完成却停在 60% 会被当成没保存成功');

  // 反过来：把进度改回 60 不会自动把状态翻回 active（那是用户的明确意图）
  const back = await goals.update(item.id, { progress: 60 });
  assert.equal(back.status, 'done', '进度回退不该反转状态');

  // 里程碑全勾完：进度到 100，状态仍是 active
  const other = await goals.create({ title: 'y', targetDate: '2026-05-01', milestones: [{ title: 'a' }] });
  const pushed = await goals.setProgress(other.id, { milestoneId: other.milestones[0].id, done: true });
  assert.equal(pushed.progress, 100);
  assert.equal(pushed.status, 'active', '步骤做完不等于目标达成');
});

test('goals 服务：空 patch 不写库（不刷新 updatedAt）', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: 'x', targetDate: '2026-05-01' });
  const same = await goals.update(item.id, { unknownField: 1 });
  assert.equal(same.updatedAt, item.updatedAt);
});

// ---------------------------------------------------------------- 进度与里程碑

test('goals 服务：progress / delta 的边界（越界夹紧到 0~100，非数字 400）', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: 'x', targetDate: '2026-05-01', progress: 40 });

  assert.equal((await goals.setProgress(item.id, { delta: 10 })).progress, 50);
  assert.equal((await goals.setProgress(item.id, { delta: -100 })).progress, 0, '减到负数夹到 0');
  assert.equal((await goals.setProgress(item.id, { delta: 1000 })).progress, 100, '加到超过 100 夹到 100');
  assert.equal((await goals.setProgress(item.id, { progress: 3.7 })).progress, 4, '进度取整（进度条没有小数）');
  assert.equal((await goals.setProgress(item.id, { progress: null })).progress, null, 'null 表示"还没估过"');

  await assertBadRequest(() => goals.setProgress(item.id, { delta: 'abc' }), 'delta 非数字');
  await assertBadRequest(() => goals.setProgress(item.id, {}), '什么都不给');
  await assertBadRequest(() => goals.setProgress(item.id, { delta: 5, progress: 200 }), 'progress 越界');
  await assertBadRequest(() => goals.setProgress(item.id, { progress: -1 }), 'progress 下限');
  await assertBadRequest(() => goals.setProgress(item.id, { status: 'paused' }), 'status 枚举');
});

test('goals 服务：勾里程碑 —— 最后一个勾完补 100，撤销时把 100 退回去', async () => {
  const { goals } = makeService();
  const item = await goals.create({
    title: 'x',
    targetDate: '2026-05-01',
    milestones: [{ title: 'a' }, { title: 'b' }],
  });
  const [first, second] = item.milestones;

  const one = await goals.setProgress(item.id, { milestoneId: first.id, done: true });
  assert.equal(one.milestoneDone, 1);
  assert.equal(one.progress, null, '还没全勾完，不擅自填进度');

  const two = await goals.setProgress(item.id, { milestoneId: second.id, done: true });
  assert.equal(two.milestoneDone, 2);
  assert.equal(two.progress, 100, '全勾完 → 进度补 100');

  const undone = await goals.setProgress(item.id, { milestoneId: second.id, done: false });
  assert.equal(undone.milestoneDone, 1);
  assert.equal(undone.progress, 50, '撤销勾选时把自动补的 100 退回到 1/2');

  // 不给 done 就是取反
  const toggled = await goals.setProgress(item.id, { milestoneId: second.id });
  assert.equal(toggled.milestones.find((step) => step.id === second.id).done, true);
});

test('goals 服务：勾一个不存在的里程碑 → 404', async () => {
  const { goals } = makeService();
  const item = await goals.create({ title: 'x', targetDate: '2026-05-01', milestones: [{ title: 'a' }] });
  await assert.rejects(
    () => goals.setProgress(item.id, { milestoneId: 'm-not-exist', done: true }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );
});

// ---------------------------------------------------------------- list

test('goals 服务：list 的筛选、分组计数与排序', async () => {
  const { goals } = makeService({ today: '2026-03-15' });
  const exam = await goals.create({ title: '期末考', kind: 'exam', targetDate: '2026-06-20', course: '数据结构', priority: 2 });
  await goals.create({ title: '考研', kind: 'goal', targetDate: '2026-12-20', course: null, priority: 1 });
  await goals.create({ title: '交大作业', kind: 'deadline', targetDate: '2026-03-20', course: '数据结构' });
  const finished = await goals.create({ title: '做完了的', targetDate: '2026-03-01', status: 'done' });

  const all = goals.list();
  assert.equal(all.count, 4);
  assert.equal(all.counts.total, 4);
  assert.deepEqual(all.counts.byKind, { goal: 2, deadline: 1, exam: 1 }, 'byKind 按 kind 分组：考研与"做完了的"都是 goal');
  assert.equal(all.counts.byStatus.done, 1);
  // 排序：进行中优先（按目标日升序），已完成的沉底
  assert.deepEqual(all.items.map((item) => item.title), ['交大作业', '期末考', '考研', '做完了的']);

  // 按状态筛选，但计数仍然给出全量分组（否则一点筛选，别的数字全归零）
  const active = goals.list({ status: 'active' });
  assert.equal(active.count, 3);
  assert.equal(active.counts.byStatus.done, 1, 'counts 忽略 status 维度');
  assert.equal(active.filters.status, 'active');

  // 多状态
  assert.equal(goals.list({ status: 'active,done' }).count, 4);

  // 按课程 / 关键词
  assert.equal(goals.list({ course: '数据结构' }).count, 2);
  assert.equal(goals.list({ q: '考研' }).count, 1);
  assert.equal(goals.list({ kind: 'exam' }).count, 1);
  assert.equal(goals.list({ q: '不存在的词' }).count, 0);

  // 分页
  const page = goals.list({ limit: 2, offset: 1 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].title, '期末考');
  assert.equal(page.filters.limit, 2);
  assert.equal(page.filters.offset, 1);

  assert.equal(finished.status, 'done');
  assert.equal(exam.daysLeft, 97);
});

// ---------------------------------------------------------------- overview：只读别人的数据

test('goals 服务：overview 合并目标的待办与事件，并按 severity + 日期排序', async () => {
  // 日历模块的替身：只提供本模块真正调用的只读方法（list），派生字段照它的契约给
  const services = {
    todos: {
      list: () => [
        { id: 'todo-1', title: '交作业', deadline: '2026-03-16', completed: false, priority: 2, isOverdue: false },
        { id: 'todo-2', title: '早就该交的', deadline: '2026-03-12', completed: false, priority: 0, isOverdue: true },
        { id: 'todo-3', title: '很远的', deadline: '2026-09-01', completed: false, priority: 0, isOverdue: false },
      ],
    },
    events: {
      list: () => [
        { id: 'ev-1', title: '期中考试', category: 'exam', startDate: '2026-03-18', endDate: '2026-03-18' },
        { id: 'ev-2', title: '考试周', category: 'exam', startDate: '2026-03-20', endDate: '2026-03-24' },
        { id: 'ev-3', title: '上个月的假期', category: 'holiday', startDate: '2026-02-01', endDate: '2026-02-07' },
        { id: 'ev-4', title: '很晚的活动', category: 'other', startDate: '2026-12-05', endDate: '2026-12-05' },
      ],
    },
  };
  const store = makeStore();
  const merged = new GoalService({ store, services, now: () => new Date('2026-03-15T09:00:00') });
  // 本模块：一条逾期、一条 10 天后
  await merged.create({ title: '逾期的实验报告', kind: 'deadline', targetDate: '2026-03-10' });
  await merged.create({ title: '竞赛报名', kind: 'deadline', targetDate: '2026-03-25' });

  const result = merged.overview({ days: 30 });

  // 三份来源都进来了：目标 2 + 待办 2（很远的被窗口挡掉）+ 事件 2（过去的假期与很晚的都被挡掉）
  assert.deepEqual(result.sources, { goals: 2, todos: 2, events: 2 }, `实际：${JSON.stringify(result.sources)}`);
  assert.equal(result.count, 6);

  // 逾期压在最上面，且逾期组内"更接近今天"的在前（3-12 在 3-10 之前）；
  // 其余按日期升序，与 severity 分档无关（3-24 的考试周排在 3-16 的交作业之后）。
  // 事件条目的 `source` 是 'event'、`kind` 才是 exam/deadline —— 前端按 source 决定图标、
  // 按 kind 决定话术，两者刻意分开。
  assert.deepEqual(
    result.items.map((item) => `${item.source}:${item.title}`),
    ['todo:早就该交的', 'deadline:逾期的实验报告', 'todo:交作业', 'event:期中考试', 'event:考试周', 'deadline:竞赛报名'],
  );
  assert.deepEqual(
    result.items.map((item) => item.severity),
    ['overdue', 'overdue', 'urgent', 'soon', 'later', 'later'],
    '考试周与竞赛报名都在 8 天之外 → later',
  );
  assert.deepEqual(result.items.map((item) => item.kind), ['todo', 'deadline', 'todo', 'exam', 'exam', 'deadline']);

  // 多天事件取结束日（考试周 3-20~3-24 → date=3-24，daysLeft=9）
  const examWeek = result.items.find((item) => item.title === '考试周');
  assert.equal(examWeek.date, '2026-03-24');
  assert.equal(examWeek.daysLeft, 9);
  assert.equal(examWeek.kind, 'exam', '按 category 判成考试');
  assert.equal(examWeek.endDate, '2026-03-24');

  // summary 的口径：逾期不计入任何"N 天内"
  assert.equal(result.summary.total, 6);
  assert.equal(result.summary.overdue, 2);
  assert.equal(result.summary.urgent, 1);
  assert.equal(result.summary.dueWithin7Days, 2, '3-16 与 3-18；3-24 的考试周是 9 天后，逾期项也不计入');
  assert.equal(result.summary.dueWithin30Days, 4);
  assert.equal(result.summary.next, '交作业', '最近的一条');
  assert.ok(result.disclaimer.includes('不是学校公布的保研线'));

  // 窗口：days=5 时 3-25 的目标与 3-24 的事件都该消失，但逾期项永远在
  const narrow = merged.overview({ days: 5 });
  assert.equal(narrow.items.some((item) => item.title === '竞赛报名'), false, '窗口外的目标不进清单');
  assert.equal(narrow.items.filter((item) => item.overdue).length, 2, '逾期项不受窗口影响');
  assert.equal(narrow.from, '2026-03-15');
  assert.equal(narrow.to, '2026-03-20');
});

test('goals 服务：别人的服务缺失或抛错时 overview 降级而不是 500', async () => {
  const store = makeStore();
  const { goals } = makeService({ store });
  await goals.create({ title: '只有目标', targetDate: '2026-03-20' });

  // ① 两个服务都没有（单测/裁剪装配）
  const bare = new GoalService({ store: makeStore(), services: {}, now: () => new Date('2026-03-15T09:00:00') });
  const bareResult = bare.overview({ days: 30 });
  assert.deepEqual(bareResult.sources, { goals: 0, todos: 0, events: 0 });
  assert.equal(bareResult.count, 0);

  // ② 服务存在但内部抛错 → 当作空，不影响本模块那部分
  const broken = new GoalService({
    store,
    services: {
      todos: { list: () => { throw new Error('待办炸了'); } },
      events: { list: () => { throw new Error('事件也炸了'); } },
    },
    now: () => new Date('2026-03-15T09:00:00'),
  });
  const result = broken.overview({ days: 30 });
  assert.deepEqual(result.sources, { goals: 1, todos: 0, events: 0 });
  assert.equal(result.count, 1);
});

test('goals 服务：overview 的课程筛选对目标生效、对没有课程字段的待办不生效', async () => {
  const store = makeStore();
  const services = {
    todos: { list: () => [{ id: 'todo-1', title: '通用待办', deadline: '2026-03-18', completed: false }] },
    events: { list: () => [] },
  };
  const goals = new GoalService({ store, services, now: () => new Date('2026-03-15T09:00:00') });
  await goals.create({ title: '数据结构作业', targetDate: '2026-03-20', course: '数据结构' });
  await goals.create({ title: '英语作文', targetDate: '2026-03-20', course: '英语' });

  const filtered = goals.overview({ days: 30, course: '数据结构' });
  assert.deepEqual(
    filtered.items.map((item) => item.title),
    ['通用待办', '数据结构作业'],
    '待办在 3-18、目标在 3-20，按日期升序',
  );
  assert.equal(filtered.items.some((item) => item.title === '英语作文'), false);
  assert.equal(filtered.items.some((item) => item.title === '通用待办'), true, '待办没有课程字段，课程筛选不该把它藏起来');
});

test('goals 服务：overview 不含已完成的目标，includeDone 时才带', async () => {
  const goals = new GoalService({ store: makeStore(), services: {}, now: () => new Date('2026-03-15T09:00:00') });
  await goals.create({ title: '在做', targetDate: '2026-03-20' });
  await goals.create({ title: '做完了', targetDate: '2026-03-20', status: 'done' });

  assert.deepEqual(goals.overview({ days: 30 }).items.map((item) => item.title), ['在做']);
  assert.deepEqual(goals.overview({ days: 30, includeDone: true }).items.map((item) => item.title), ['在做', '做完了']);
});

test('goals 服务：没有 goal 集合之外的依赖时 summarize 只数天数', () => {
  const rows = [
    { severity: 'overdue', daysLeft: -3, remindHit: false, overdue: true, title: 'a' },
    { severity: 'urgent', daysLeft: 0, remindHit: true, overdue: false, title: 'b' },
    { severity: 'soon', daysLeft: 7, remindHit: true, overdue: false, title: 'c' },
    { severity: 'soon', daysLeft: 8, remindHit: false, overdue: false, title: 'd' },
    { severity: 'later', daysLeft: 31, remindHit: false, overdue: false, title: 'e' },
  ];
  const summary = summarize(rows);
  assert.equal(summary.total, 5);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.urgent, 1);
  assert.equal(summary.dueWithin7Days, 2, 'daysLeft 0 与 7 都算 7 天内');
  assert.equal(summary.dueWithin30Days, 3);
  assert.equal(summary.attention, 2, '只有命中 remindDays 的算 attention');
  assert.equal(summary.next, 'b', '最近的是 daysLeft 最小的非逾期项');
});

// ---------------------------------------------------------------- alerts

test('goals 服务：alerts 只给窗口内与逾期项，并挑出命中 remindDays 的', async () => {
  const goals = new GoalService({ store: makeStore(), services: {}, now: () => new Date('2026-03-15T09:00:00') });
  await goals.create({ title: '7 天后', targetDate: '2026-03-22' }); // 命中 7
  await goals.create({ title: '3 天后', targetDate: '2026-03-18' }); // 命中 3
  await goals.create({ title: '今天', targetDate: '2026-03-15' }); // 不在 [7,3,1] 里
  await goals.create({ title: '逾期', targetDate: '2026-03-01' });
  await goals.create({ title: '很远', targetDate: '2026-06-01' });

  const result = goals.alerts({ days: 7 });
  // 逾期压最前，其余按日期升序
  assert.deepEqual(result.items.map((item) => item.title), ['逾期', '今天', '3 天后', '7 天后']);
  assert.equal(result.items.some((item) => item.title === '很远'), false, '窗口外的不进预警');
  assert.deepEqual(result.attention.map((item) => item.title), ['3 天后', '7 天后'], '只有命中 remindDays 的进 attention');
  assert.equal(result.summary.overdue, 1);
  assert.equal(result.disclaimer, GPA_DISCLAIMER);

  // 提醒阈值是用户自己的偏好：改了它，attention 跟着变
  const threeDays = goals.list().items.find((item) => item.title === '3 天后');
  assert.equal(threeDays.needsAttention, true, '3 天后命中默认的 [7,3,1]');
  await goals.update(threeDays.id, { remindDays: [1] });
  assert.equal(goals.alerts({ days: 7 }).attention.some((item) => item.id === threeDays.id), false);
  assert.equal(goals.alerts({ days: 7 }).attention.length, 1, '只剩「7 天后」那条');
});

// ---------------------------------------------------------------- 目标学分绩（诚实版）

test('goals 服务：目标学分绩的读写与清除', async () => {
  const { goals } = makeService();
  assert.deepEqual(goals.getTargetGpa(), { targetGpa: null, updatedAt: null, disclaimer: GPA_DISCLAIMER });

  const set = await goals.setTargetGpa(3.856);
  assert.equal(set.targetGpa, 3.86, '两位小数，避免浮点噪声');
  assert.equal(set.disclaimer, GPA_DISCLAIMER);
  assert.equal(goals.getTargetGpa().targetGpa, 3.86, '重新读还是这个值（单行集合）');

  const cleared = await goals.setTargetGpa(null);
  assert.equal(cleared.targetGpa, null);

  await assertBadRequest(() => goals.setTargetGpa(6), '上限 5');
  await assertBadRequest(() => goals.setTargetGpa(-1), '不能为负');
  await assertBadRequest(() => goals.setTargetGpa('很高'), '必须是数字');
});

test('goals 服务：gpa 对比 —— current 来自学业模块，gap 只是差值，disclaimer 恒在', async () => {
  const store = makeStore();
  const services = { academic: { stats: () => ({ gpa: 3.42, includedCount: 20, totalCredits: 48 }) } };
  const goals = new GoalService({ store, services, now: () => new Date('2026-03-15T09:00:00') });
  await goals.setTargetGpa(3.8);

  const gpa = goals.gpaComparison();
  assert.equal(gpa.current, 3.42);
  assert.equal(gpa.target, 3.8);
  assert.equal(gpa.gap, 0.38);
  assert.equal(gpa.source, 'academic.services.stats');
  assert.equal(gpa.includedCount, 20);
  assert.equal(gpa.reason, null);
  assert.equal(gpa.disclaimer, GPA_DISCLAIMER, '任何情况下都要带这句');
  assert.match(gpa.message, /还差 0\.38/);

  // 已达到目标时 message 不说"还差"
  await goals.setTargetGpa(3.0);
  assert.equal(goals.gpaComparison().gap, -0.42);
  assert.match(goals.gpaComparison().message, /已达到/);
});

test('goals 服务：学业模块没有数据时 gpa.current 为 null 且带 reason —— 绝不报错、绝不报 0', async () => {
  // ① 学业模块在，但一条成绩都没有（stats 的契约：无数据时 gpa 为 null）
  const withAcademics = new GoalService({
    store: makeStore(),
    services: { academic: { stats: () => ({ gpa: null, includedCount: 0, totalCredits: 0 }) } },
    now: () => new Date('2026-03-15T09:00:00'),
  });
  const none = withAcademics.gpaComparison();
  assert.equal(none.current, null, 'null 就是 null，不许变成 0');
  assert.equal(none.gap, null);
  assert.equal(none.reason, 'NO_GRADES');
  assert.equal(none.disclaimer, GPA_DISCLAIMER);

  // ② 成绩全被排除（includedCount 为 0）同样不该给出一个数字
  const allSkipped = new GoalService({
    store: makeStore(),
    services: { academic: { stats: () => ({ gpa: 0, includedCount: 0 }) } },
    now: () => new Date('2026-03-15T09:00:00'),
  });
  assert.equal(allSkipped.gpaComparison().current, null);

  // ③ 学业模块压根没装配
  const withoutAcademics = new GoalService({ store: makeStore(), services: {}, now: () => new Date('2026-03-15T09:00:00') });
  const absent = withoutAcademics.gpaComparison();
  assert.equal(absent.current, null);
  assert.equal(absent.reason, 'ACADEMIC_MODULE_UNAVAILABLE');
  assert.match(absent.message, /学业模块未装配/);
  assert.equal(absent.disclaimer, GPA_DISCLAIMER);

  // ④ 学业模块抛错（例如内部状态坏掉）也只降级
  const broken = new GoalService({
    store: makeStore(),
    services: { academic: { stats: () => { throw new Error('boom'); } } },
    now: () => new Date('2026-03-15T09:00:00'),
  });
  assert.equal(broken.gpaComparison().current, null);

  // ⑤ 服务缺席但集合里有真实成绩 → 降级路径（只做学分加权，并如实标注来源）
  const store = makeStore();
  await store.academicGrades.insert({ courseName: '数据结构', credit: 3, gradePoint: 4, included: true });
  await store.academicGrades.insert({ courseName: '英语', credit: 2, gradePoint: 3, included: true });
  await store.academicGrades.insert({ courseName: '体育', credit: 1, gradePoint: 1, included: false });
  const fallback = new GoalService({ store, services: {}, now: () => new Date('2026-03-15T09:00:00') });
  assert.equal(fallback.gpaComparison().current, 3.6, '(3×4 + 2×3) / 5 = 3.6，排除 included:false 的');
  assert.match(fallback.gpaComparison().source, /降级/);
});

test('goals 服务：overview 里始终带 gpa 与 disclaimer（前端只读一个接口）', async () => {
  const goals = new GoalService({ store: makeStore(), services: {}, now: () => new Date('2026-03-15T09:00:00') });
  const result = goals.overview({ days: 30 });
  assert.ok(result.gpa, 'overview 必须带 gpa 字段');
  assert.equal(result.gpa.disclaimer, GPA_DISCLAIMER);
  assert.equal(result.disclaimer, GPA_DISCLAIMER);
  assert.equal(goals.alerts({ days: 7 }).disclaimer, GPA_DISCLAIMER);
});
