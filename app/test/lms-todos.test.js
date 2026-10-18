/**
 * 「思源学堂作业 → 待办」的端到端 + 纯函数测试。
 *
 * 全部走 `test/helpers/lms-mock.js` 的本地 mock：零真实外网、零真实账号。
 * 这里钉住的都是"改一次就会静默坏掉"的行为：
 *   1. 只有作业进待办，直播/回放/资料不进；
 *   2. 字段映射（标题「课程：作业」、截止日、tags、source、externalId）；
 *   3. 幂等：重复同步不新增、不重置完成态；
 *   4. 已提交 → 标完成（不删除）；没有截止日 → 跳过并计数；
 *   5. 未登录 → 一条都不写，且 reason 说清原因（不能假装"没有作业"）；
 *   6. 开关关闭 → 不再自动建；已有待办保留。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import lmsModule from '../src/modules/lms/module.js';
import {
  activityExternalId,
  homeworkTodoPayload,
  isSubmittedHomework,
  planHomeworkTodos,
} from '../src/modules/lms/todos-bridge.js';
import { parseLmsDate } from '../src/modules/lms/time.js';
import {
  ACTIVITY_DAY_OFFSETS,
  HOMEWORK_DEADLINE_DATE,
  activityDate,
  startMockLms,
} from './helpers/lms-mock.js';

/** 起一套「后端 + 指向 mock 的思源学堂客户端」（与 lms.test.js 同构）。 */
async function startApp(mock, { dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-lms-todos-')));
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
  /** 当前所有「来自学堂」的待办（按 externalId 前缀筛，与其它模块的待办区分开）。 */
  const lmsTodos = async () => {
    const all = await call('GET', '/todos');
    return all.body.items.filter((item) => String(item.externalId ?? '').startsWith('lms:activity:'));
  };
  return { app, call, login, lmsTodos, dataDir: dir };
}

/* ==================================================== 纯函数：字段映射与计划 */

test('作业待办字段映射：课程名：作业标题 / 截止日 / tags / source / externalId', () => {
  const payload = homeworkTodoPayload(
    {
      id: 5001,
      type: 'homework',
      courseId: 1001,
      title: '第一次作业：链表',
      endTime: '2026-10-12T23:59:00+08:00',
    },
    { courseName: '数据结构' },
  );
  assert.deepEqual(payload, {
    title: '数据结构：第一次作业：链表',
    deadline: '2026-10-12',
    description: '来自思源学堂',
    tags: ['学堂'],
    source: 'import',
    externalId: 'lms:activity:5001',
  });
  assert.equal(activityExternalId(5001), 'lms:activity:5001');

  // 课程名取不到时只用作业标题（不编课程名）
  assert.equal(homeworkTodoPayload({ id: 1, type: 'homework', title: '小测', endTime: '2026-10-12' }).title, '小测');
  // 没有标题时用 id 兜底，标题不能为空（待办 title 必填）
  assert.match(homeworkTodoPayload({ id: 7, type: 'homework', endTime: '2026-10-12' }).title, /7/);
  // 截止日优先 endTime；只有 startTime 时退而用它的日期
  assert.equal(
    homeworkTodoPayload({ id: 2, type: 'homework', title: 'T', startTime: '2026-10-10T08:00:00+08:00', endTime: '2026-10-20T23:59:00+08:00' }).deadline,
    '2026-10-20',
  );
  assert.equal(
    homeworkTodoPayload({ id: 3, type: 'homework', title: 'T', startTime: '2026-10-10T08:00:00+08:00' }).deadline,
    '2026-10-10',
  );
  // 活动链接（如果接口给了）进描述；没有就不编地址
  const withLink = homeworkTodoPayload({ id: 4, type: 'homework', title: 'T', endTime: '2026-10-12', url: 'https://lms.example/activities/4' });
  assert.match(withLink.description, /^来自思源学堂\n活动链接：https:\/\/lms\.example\/activities\/4$/);
});

test('只有作业进待办：直播 / 回放 / 资料 / 未知类型一律返回 null', () => {
  for (const type of ['lecture_live', 'lesson', 'material', 'online_video', 'questionnaire', 'unknown']) {
    assert.equal(homeworkTodoPayload({ id: 1, type, title: 'T', endTime: '2026-10-12' }), null, `${type} 不该进待办`);
  }
  // 没有截止日 → null（由调用方计入 skipped，不编日期）
  assert.equal(homeworkTodoPayload({ id: 1, type: 'homework', title: 'T' }), null);
});

test('已提交的判断只认详情里的 userSubmitCount（列表没这个字段时不当成已提交）', () => {
  assert.equal(isSubmittedHomework({ userSubmitCount: 1 }), true);
  assert.equal(isSubmittedHomework({ userSubmitCount: 0 }), false);
  assert.equal(isSubmittedHomework({}), false);
  assert.equal(isSubmittedHomework(undefined), false);
});

test('计划：已提交的作业新建即完成；无截止日跳过；已有待办只补管理字段、不翻回 completed', () => {
  const activities = [
    { id: 1, courseId: 10, type: 'homework', title: '交报告', endTime: '2026-10-20T23:59:00+08:00', userSubmitCount: 1 },
    { id: 2, courseId: 10, type: 'homework', title: '没日期', startTime: null, endTime: null },
    { id: 3, courseId: 10, type: 'lecture_live', title: '直播', startTime: '2026-10-20T10:00:00+08:00' },
    { id: 4, courseId: 10, type: 'homework', title: '改期', endTime: '2026-10-25T23:59:00+08:00' },
  ];
  const existingTodos = [
    // 用户已经手动勾掉，学校那边还没提交：不能被同步翻回未完成
    { id: 't4', externalId: 'lms:activity:4', title: '老标题', deadline: '2026-10-21', description: '来自思源学堂', tags: ['学堂'], completed: true, priority: 2, category: '我的分类' },
  ];
  const { items, summary } = planHomeworkTodos({
    activities,
    courses: [{ id: 10, name: '材料力学' }],
    existingTodos,
  });

  const byKey = new Map(items.map((item) => [item.key, item]));
  assert.equal(byKey.get('lms:activity:1').action, 'create');
  assert.equal(byKey.get('lms:activity:1').payload.completed, true, '已提交 → 新建即完成');
  assert.equal(byKey.get('lms:activity:1').payload.title, '材料力学：交报告');
  assert.equal(byKey.get('lms:activity:2').action, 'skip');
  assert.match(byKey.get('lms:activity:2').reason, /没有截止日/);
  assert.equal(byKey.has('lms:activity:3'), false, '直播不是候选，连 skip 都不计');
  assert.equal(byKey.get('lms:activity:4').action, 'update');
  assert.equal(byKey.get('lms:activity:4').patch.completed, undefined, '绝不能把用户勾掉的完成态翻回去');
  assert.equal(byKey.get('lms:activity:4').patch.title, '材料力学：改期');
  assert.equal(byKey.get('lms:activity:4').patch.deadline, '2026-10-25');
  assert.equal(byKey.get('lms:activity:4').patch.category, undefined, '用户自己的分类不能被重置');

  assert.deepEqual(summary, { create: 1, update: 1, skip: 1, completed: 1 });
});

/* ==================================================== 端到端：同步 → 待办 */

test('作业自动变成待办：字段正确，直播/回放/资料不进待办', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    const sync = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(sync.status, 200);
    // 4 条作业：5001/5006 未提交，5002（已提交）/5003（已过期但已提交）也建出来（标完成）
    assert.equal(sync.body.created, 4);
    assert.equal(sync.body.completed, 2);
    assert.equal(sync.body.skipped, 0);
    assert.equal(sync.body.enabled, true);

    const todos = await lmsTodos();
    assert.equal(todos.length, 4, `应当只有 4 条作业待办，实际 ${todos.length} 条`);
    const byId = new Map(todos.map((item) => [item.externalId, item]));

    const first = byId.get('lms:activity:5001');
    assert.equal(first.title, '数据结构：第一次作业：链表');
    assert.equal(first.deadline, HOMEWORK_DEADLINE_DATE);
    assert.match(first.description, /^来自思源学堂/);
    assert.deepEqual(first.tags, ['学堂']);
    assert.equal(first.source, 'import');
    assert.equal(first.completed, false);

    const english = byId.get('lms:activity:5006');
    assert.equal(english.title, '大学英语：Unit 3 作文');
    assert.equal(english.deadline, activityDate(ACTIVITY_DAY_OFFSETS.lectureLive + 3));

    // 非作业（5004 直播 / 5005 资料 / 5007 回放）一条都不该进待办
    for (const id of ['lms:activity:5004', 'lms:activity:5005', 'lms:activity:5007']) {
      assert.equal(byId.has(id), false, `${id} 不是作业，不该出现在待办里`);
    }

    // 活动接口本身也要给出归一化的 deadline（AI / 前端「哪天要交」直接用它）
    const activities = await call('GET', '/lms/activities?type=homework');
    const activity5001 = activities.body.items.find((item) => item.id === 5001);
    assert.equal(activity5001.deadline, HOMEWORK_DEADLINE_DATE);
    assert.equal(activity5001.submitted, false);
    assert.equal(parseLmsDate('2026-10-12T23:59:00+08:00'), '2026-10-12');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('活动同步成功后自动跑桥接（不需要用户点第二次）', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    // 第一次拉活动：缓存为空 → 自动拉取 → 自动建待办，响应里带 todos 汇总
    const first = await call('GET', '/lms/activities');
    assert.equal(first.status, 200);
    assert.equal(first.body.todos.created, 4);
    assert.equal((await lmsTodos()).length, 4);

    // 学校改期 + 改名，再强制刷新活动 → 待办跟着更新
    mock.mutate((dataset) => {
      const activity = dataset.activities[1001].find((item) => item.id === 5001);
      activity.title = '第一次作业：链表（改）';
      activity.end_time = `${activityDate(ACTIVITY_DAY_OFFSETS.homework + 2)}T23:59:00+08:00`;
    });
    const refreshed = await call('GET', '/lms/activities?refresh=1');
    assert.equal(refreshed.body.todos.created, 0);
    assert.ok(refreshed.body.todos.updated >= 1, '刷新活动后应当自动核对/更新待办');
    const updated = (await lmsTodos()).find((item) => item.externalId === 'lms:activity:5001');
    assert.equal(updated.title, '数据结构：第一次作业：链表（改）');
    assert.equal(updated.deadline, activityDate(ACTIVITY_DAY_OFFSETS.homework + 2));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('幂等：同步两次 → 第二次 created:0、updated>0，条数不变', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    const first = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(first.body.created, 4);
    assert.equal((await lmsTodos()).length, 4);

    const second = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(second.body.created, 0, '重复同步不该新建');
    assert.ok(second.body.updated > 0, '命中已有待办要计入 updated（表示已核对接管）');
    assert.equal(second.body.completed, 0, '已经完成的不会被重复计数');
    assert.equal((await lmsTodos()).length, 4, '条数必须不变');

    // 用户手动勾掉一条未提交的作业，再同步：不能被翻回未完成
    const todos = await lmsTodos();
    const open = todos.find((item) => item.externalId === 'lms:activity:5001');
    await call('PATCH', `/todos/${open.id}`, { completed: true });
    const third = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(third.body.created, 0);
    const after = (await lmsTodos()).find((item) => item.externalId === 'lms:activity:5001');
    assert.equal(after.completed, true, '同步不能重置用户手动勾掉的完成态');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('已提交的作业 → 待办 completed:true（不删除，留记录）', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    const sync = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(sync.body.completed, 2, '5002 / 5003 两条已提交');
    const submitted = (await lmsTodos()).find((item) => item.externalId === 'lms:activity:5002');
    assert.equal(submitted.completed, true);
    assert.ok(submitted.completedAt, '完成时间由待办服务统一维护');

    // 学生刚刚提交了 5001（学校详情变了）→ 再同步把它标完成
    mock.mutate((dataset) => {
      dataset.details[5001] = { ...(dataset.details[5001] ?? {}), user_submit_count: 1 };
    });
    const again = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(again.body.completed, 1, '本次只应新增一条完成');
    const nowDone = (await lmsTodos()).find((item) => item.externalId === 'lms:activity:5001');
    assert.equal(nowDone.completed, true, '提交后同步要自动标完成');
    // 记录还在（不是"交了就删"），用户还能回看
    assert.equal((await lmsTodos()).length, 4);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('没有截止日的作业 → 跳过并计入 skipped，不建待办', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    mock.mutate((dataset) => {
      dataset.activities[1001].push({
        id: 5010,
        course_id: 1001,
        type: 'homework',
        title: '没有截止日的作业（真实数据里出现过）',
        published: true,
      });
    });
    const sync = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(sync.body.skipped, 1, '没有截止日要计入 skipped，而不是静默当没有作业');
    assert.equal(sync.body.created, 4, '其余 4 条照常建');
    const ids = (await lmsTodos()).map((item) => item.externalId);
    assert.equal(ids.includes('lms:activity:5010'), false, '不能编一个日期硬建');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('未登录：不建任何待办、不写库，并如实返回 reason', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    // 未登录直接同步
    const anonymous = await call('POST', '/lms/todos/sync', {});
    assert.equal(anonymous.status, 200, '要回 200 + reason，便于调用方区分"没作业"与"没登录"');
    assert.equal(anonymous.body.created, 0);
    assert.equal(anonymous.body.updated, 0);
    assert.equal(anonymous.body.completed, 0);
    assert.match(anonymous.body.reason ?? '', /登录|失效/);
    assert.equal((await lmsTodos()).length, 0, '未登录时一条都不能写库');

    // 登录建出 4 条后再退出：同步仍然不写库、条数不变
    await login();
    await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal((await lmsTodos()).length, 4);
    await call('POST', '/lms/logout', {});
    const afterLogout = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(afterLogout.status, 200);
    assert.equal(afterLogout.body.created, 0);
    assert.equal(afterLogout.body.reason.length > 0, true);
    assert.equal((await lmsTodos()).length, 4, '退出登录不能让已有待办消失或重复');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('开关：默认开启；关闭后不再自动建，已有待办保留；重新打开可继续', async () => {
  const mock = await startMockLms();
  let first = await startApp(mock);
  try {
    const initial = await first.call('GET', '/lms/todos/config');
    assert.deepEqual(initial.body.enabled, true, '默认必须是开启的');

    // 非法值要被挡住
    const bad = await first.call('POST', '/lms/todos/config', { enabled: 'yes' });
    assert.equal(bad.status, 400);

    await first.login();
    await first.call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal((await first.lmsTodos()).length, 4);

    // 关闭：已有待办保留，但不再自动建
    const off = await first.call('POST', '/lms/todos/config', { enabled: false });
    assert.equal(off.body.enabled, false);
    const blocked = await first.call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(blocked.body.created, 0);
    assert.match(blocked.body.reason, /关闭/);
    assert.equal((await first.lmsTodos()).length, 4, '关掉开关不能删已有待办');

    // 自动路径（刷新活动）同样不该建：先把 5001 的待办删掉再刷新活动
    const todos = await first.lmsTodos();
    const target = todos.find((item) => item.externalId === 'lms:activity:5001');
    await first.call('DELETE', `/todos/${target.id}`);
    const refreshed = await first.call('GET', '/lms/activities?refresh=1');
    assert.equal(refreshed.body.todos.created, 0);
    assert.equal((await first.lmsTodos()).length, 3, '关闭后活动同步也不该把作业补回待办');

    // 重启后开关仍然关闭
    const dir = first.dataDir;
    await first.app.close();
    const second = await startApp(mock, { dataDir: dir });
    try {
      const restored = await second.call('GET', '/lms/todos/config');
      assert.equal(restored.body.enabled, false, '开关要持久化');

      // 重新打开 → 立刻可以把作业补进待办
      const on = await second.call('POST', '/lms/todos/config', { enabled: true });
      assert.equal(on.body.enabled, true);
      const sync = await second.call('POST', '/lms/todos/sync', { refresh: true });
      assert.ok(sync.body.created >= 1, '重新打开后应当能把缺的作业补回来');
      assert.equal((await second.lmsTodos()).length, 4);
    } finally {
      await second.app.close();
    }
  } finally {
    await first.app.close();
    await mock.close();
  }
});

test('活动在学堂消失：不自动删待办（可能是用户自己的记录）', async () => {
  const mock = await startMockLms();
  const { call, login, lmsTodos, app } = await startApp(mock);
  try {
    await login();
    await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal((await lmsTodos()).length, 4);

    mock.mutate((dataset) => {
      dataset.activities[1001] = dataset.activities[1001].filter((item) => item.id !== 5001);
    });
    await call('GET', '/lms/activities?refresh=1');
    const sync = await call('POST', '/lms/todos/sync', { refresh: true });
    assert.equal(sync.body.created, 0);
    const kept = (await lmsTodos()).find((item) => item.externalId === 'lms:activity:5001');
    assert.ok(kept, '学堂撤掉活动不等于用户想删待办 —— 必须保留');
    assert.equal((await lmsTodos()).length, 4);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 查询：todo 投影表包含截止日与学堂来源标记', () => {
  const fields = lmsModule.aiQueryFields?.todo ?? [];
  assert.ok(fields.includes('deadline'), 'AI 必须能拿到作业截止日');
  assert.ok(fields.includes('tags'), 'AI 要靠 tags=学堂 认出这是学堂作业');
  assert.ok(fields.includes('externalId'), 'externalId 是"这条从学堂来"的稳定标记');
  // 没有凭空声明一个不会执行的 lms target（学堂没有注册 lms 指令处理器）
  assert.equal(lmsModule.aiQueryFields?.lms, undefined);
  assert.ok(lmsModule.aiPrompt.includes('deadline'), '领域说明要告诉模型 deadline 的语义');
});
