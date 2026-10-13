/**
 * 「AI 替你写数据之后，用户和模型都得知道发生了什么」——两个跨功能测试（S3/S4）实测出的缺陷。
 *
 * 缺陷 1：auto（自动审批）档把写操作落库之后，执行结果**不回灌**给模型
 *   （循环的终止条件以前只看只读查询 `fresh`），于是模型只会说"给你加上了"，
 *   绝不提"这条和你的英语晨读重叠了" —— 而重叠信息就在执行回执的 `conflicts` 里。
 *   修法：真执行了写操作就多回灌一轮 `[系统注入]`（只为这一种情况多花一次上游调用）。
 *
 * 缺陷 2：`prompt.js` 以前要求"写入一次只提议一条"，而 auto 档每轮只执行 `freshWrites`，
 *   于是"加日程 + 加待办 + 加考试"一句话只落一件。修法：提示词允许一轮最多 3 条写入草稿，
 *   `chat-service` 每轮把**这一轮新出现的多条**都执行掉，并且同一条（轮内/跨轮）只执行一次。
 *
 * 这里用 mock 上游逐轮脚本化模型行为，断言的是三件事：
 *   1. 模型**确实收到了**系统注入（含冲突信息），并能把它说给用户；
 *   2. 三条写入草稿各自落到**对的集合**（待办不能写成日程）；
 *   3. 去重与"不多花那一轮"仍然成立（没执行写操作时，调用次数一次都不多）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-1234567890abcd';
const DAY = '2026-10-13';

async function startApp({ mock, ai } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-write-'));
  const app = await createServer({ dataDir, ai: ai ?? { apiKey: KEY, baseUrl: mock.baseUrl } });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

/** 模型输出一个 ```command 草稿块。 */
const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

/** 最后一条注入消息（回灌）的正文 —— 模型这一轮到底看到了什么，全在这里。 */
const injectedOf = (body) => String(body?.messages?.at(-1)?.content ?? '');

const overlappingSchedule = {
  ok: true,
  action: 'create',
  target: 'schedule',
  fields: { title: '小组会', date: DAY, startTime: '10:30', endTime: '11:30' },
  explain: '把小组会排进日程',
};

test('auto 档：写操作执行结果回灌给模型，模型因此能说出"和你的材料力学重叠了"', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `好，我加上。\n${fenced(overlappingSchedule)}`,
      '已经加上了。提醒一下：这条和你 10:00 的材料力学时间重叠了，要不要挪一下？',
    ],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock });
  try {
    const existing = await call('POST', '/schedules', {
      title: '材料力学',
      date: DAY,
      startTime: '10:00',
      endTime: '11:00',
    });
    assert.equal(existing.status, 201);

    const chat = await call('POST', '/ai/chat', { text: '帮我把 10:30 的小组会加进日程', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 200));

    // 1) 真的多跑了一轮：写完回灌，模型才有机会补那句提醒
    assert.equal(mock.state.bodies.length, 2, `auto 档写完应多一轮回灌，实际 ${mock.state.bodies.length} 轮`);
    assert.equal(chat.body.rounds, 2);

    // 2) 第二次请求里带着"系统做了什么"：新增的条目 + 冲突条目（标题/时刻）
    const injected = injectedOf(mock.state.bodies[1]);
    assert.match(injected, /\[系统注入\]/);
    assert.match(injected, /写操作已由系统自动执行完毕/, '要说清这是系统替他执行的');
    assert.match(injected, /"conflicts"/, '冲突要进回灌的 JSON');
    assert.match(injected, /小组会/, '新增了什么要告诉模型');
    assert.match(injected, /材料力学/, '撞上的是哪一条要点名');
    assert.match(injected, /10:00/, '冲突条目的时刻也要给，否则模型说不出"10:00 的材料力学"');
    assert.match(injected, /重叠/);

    // 3) 执行结果照旧返回给前端（回执卡），并且带着冲突
    assert.equal(chat.body.executed.length, 1);
    assert.equal(chat.body.executed[0].result.target, 'schedule');
    assert.equal(chat.body.executed[0].result.conflicts.length, 1);
    assert.equal(chat.body.executed[0].result.conflicts[0].scheduleId, existing.body.item.id);
    assert.deepEqual(chat.body.drafts, [], '自动执行的草稿不该再留确认卡');

    // 4) 用户看到的那句话里真的提到了重叠（模型用上了注入，而不是客套一句"加好了"）
    assert.match(chat.body.assistant.content, /材料力学/);
    assert.match(chat.body.assistant.content, /重叠/);

    // 5) 落库正确：两条日程，没有多写
    const schedules = await call('GET', '/schedules');
    assert.equal(schedules.body.items.length, 2);
    assert.ok(schedules.body.items.some((item) => item.title === '小组会'));
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auto 档没执行写操作时不多跑那一轮：纯聊天 1 次调用，只读查询照旧回灌', async () => {
  const chatOnly = await startMockAi({ apiKey: KEY, reply: '你好呀。' });
  const first = await startApp({ mock: chatOnly });
  try {
    const chat = await first.call('POST', '/ai/chat', { text: '你好', permission: 'auto' });
    assert.equal(chat.status, 200);
    assert.equal(chatOnly.state.bodies.length, 1, '没写任何东西，就一次调用收尾');
    assert.equal(chat.body.rounds, 1);
  } finally {
    await first.app.close();
    await chatOnly.close();
  }

  // 只读查询那条路径不受影响：仍然是"草稿 → 回灌 → 作答"两次调用，
  // 而且回灌里**不能**混进"写操作已执行"那一段（它压根没写）
  const queryDraft = { ok: true, action: 'query', target: 'schedule', filters: { from: DAY, to: DAY } };
  const queryMock = await startMockAi({
    apiKey: KEY,
    replies: [`我查一下。\n${fenced(queryDraft)}`, '你那天只有一条：10:00 的材料力学。'],
  });
  const second = await startApp({ mock: queryMock });
  try {
    await second.call('POST', '/schedules', { title: '材料力学', date: DAY, startTime: '10:00', endTime: '11:00' });
    const chat = await second.call('POST', '/ai/chat', { text: '我那天有什么日程', permission: 'auto' });
    assert.equal(chat.status, 200);
    assert.equal(queryMock.state.bodies.length, 2, '只读查询仍然要回灌一次');
    const injected = injectedOf(queryMock.state.bodies[1]);
    assert.match(injected, /\[系统注入\]/);
    assert.match(injected, /材料力学/);
    assert.doesNotMatch(injected, /写操作已由系统自动执行完毕/, '没有写操作，就不该有写操作那一段');
    assert.deepEqual(chat.body.executed, []);
    assert.equal(chat.body.queried.length, 1);
  } finally {
    await second.app.close();
    await queryMock.close();
  }
});

test('同一条写入草稿重复出现只执行一次（轮内重复 + 跨轮重复），且不会因此多绕圈', async () => {
  const todo = {
    ok: true,
    action: 'create',
    target: 'todo',
    fields: { title: '交实验报告', deadline: '2026-10-16' },
  };

  // 轮内：同一轮回复里给了两条一模一样的草稿（模型常把一件事在列表里再说一遍）
  const sameRound = await startMockAi({
    apiKey: KEY,
    replies: [`记下了。\n${fenced(todo)}\n${fenced(todo)}`, '加好了。', '（不该出现的多余轮次）'],
  });
  const first = await startApp({ mock: sameRound });
  try {
    const chat = await first.call('POST', '/ai/chat', { text: '帮我加一条待办', permission: 'auto' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.executed.length, 1, '一模一样的草稿只能执行一次');
    const todos = await first.call('GET', '/todos');
    assert.equal(todos.body.items.length, 1, `不能落两条重复记录：${JSON.stringify(todos.body.items)}`);
    assert.equal(sameRound.state.bodies.length, 2, '写完回灌一轮后收尾');
  } finally {
    await first.app.close();
    await sameRound.close();
  }

  // 跨轮：模型看到"已执行"的回灌后，下一轮又把同一件事说了一遍
  const acrossRounds = await startMockAi({
    apiKey: KEY,
    replies: [`记下了。\n${fenced(todo)}`, `我再确认一下。\n${fenced(todo)}`, '（不该出现的多余轮次）'],
  });
  const second = await startApp({ mock: acrossRounds });
  try {
    const chat = await second.call('POST', '/ai/chat', { text: '帮我加一条待办', permission: 'auto' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.executed.length, 1);
    assert.equal((await second.call('GET', '/todos')).body.items.length, 1);
    // 第二轮没有再执行任何写操作 → 循环当场收尾，不会为了同一件事烧第三轮
    assert.equal(acrossRounds.state.bodies.length, 2, `重复草稿不该再触发回灌：${acrossRounds.state.bodies.length}`);
    assert.equal(chat.body.assistant.content, '我再确认一下。');
  } finally {
    await second.app.close();
    await acrossRounds.close();
  }
});

/** 一句话三件事：日程 + 待办 + 日历事件。 */
const THREE_THINGS = [
  {
    ok: true,
    action: 'create',
    target: 'schedule',
    fields: { title: '自习', date: DAY, startTime: '19:00', endTime: '21:00' },
    explain: '周四晚上自习',
  },
  {
    ok: true,
    action: 'create',
    target: 'todo',
    fields: { title: '交实验报告', deadline: '2026-10-16' },
    explain: '周五前交实验报告',
  },
  {
    ok: true,
    action: 'create',
    target: 'event',
    fields: { title: '期中考试', startDate: '2026-11-02' },
    explain: '11 月 2 日期中考试',
  },
];

const threeThingReplies = [
  `这三件我都记上。\n${THREE_THINGS.map(fenced).join('\n')}`,
  '三件都办好了：周四 19:00 自习、10-16 前交实验报告、11-02 期中考试。',
  '（不该出现的多余轮次）',
];

test('自动审批：一句话里的三件事（日程/待办/事件）都要办掉，且各自落对集合', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: threeThingReplies });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', {
      text: '帮我加个周四晚上 19:00-21:00 自习的日程，再加一条周五交实验报告的待办，11 月 2 日期中考试也记上',
      permission: 'auto',
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 200));

    // 三条都执行了（各一次）
    assert.equal(chat.body.executed.length, 3, `三条写入都要执行：${JSON.stringify(chat.body.executed?.map((e) => e.draft?.target))}`);
    const ids = chat.body.executed.map((entry) => entry.result?.item?.id);
    assert.equal(new Set(ids).size, 3, '三条是三条不同的记录');
    assert.deepEqual(
      chat.body.executed.map((entry) => entry.draft.target).sort(),
      ['event', 'schedule', 'todo'],
    );
    assert.deepEqual(chat.body.drafts, [], 'auto 档不留确认卡');

    // **各自落对集合**：待办不能写成日程，事件也不能写成日程
    const todos = await call('GET', '/todos');
    assert.equal(todos.body.items.length, 1, `待办集合应有 1 条：${JSON.stringify(todos.body.items)}`);
    assert.equal(todos.body.items[0].title, '交实验报告');
    assert.equal(todos.body.items[0].deadline, '2026-10-16');

    const schedules = await call('GET', '/schedules');
    assert.equal(schedules.body.items.length, 1, `日程集合应有 1 条（待办/事件都不该混进来）：${JSON.stringify(schedules.body.items.map((i) => i.title))}`);
    assert.equal(schedules.body.items[0].title, '自习');
    assert.equal(schedules.body.items[0].startTime, '19:00');

    const events = await call('GET', '/events');
    assert.equal(events.body.items.length, 1, `事件集合应有 1 条：${JSON.stringify(events.body.items)}`);
    assert.equal(events.body.items[0].title, '期中考试');
    assert.equal(events.body.items[0].startDate, '2026-11-02');

    // 回灌里三条都在：模型下一轮说的"三件都办好了"才有依据
    const injected = injectedOf(mock.state.bodies[1]);
    assert.match(injected, /\[系统注入\]/);
    assert.match(injected, /自习/);
    assert.match(injected, /交实验报告/);
    assert.match(injected, /期中考试/);
    assert.match(chat.body.assistant.content, /三件都办好了/);
    assert.equal(mock.state.bodies.length, 2, '三条在同一轮执行完 → 只多一轮回灌');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('手动档：同一句话出 3 张待确认草稿，一条都不落库', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: threeThingReplies });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', {
      text: '帮我加个周四晚上 19:00-21:00 自习的日程，再加一条周五交实验报告的待办，11 月 2 日期中考试也记上',
      permission: 'manual',
    });
    assert.equal(chat.status, 200);

    // 三张确认卡，按模型给的顺序（前端 drafts 列表已经支持多条）
    assert.equal(chat.body.drafts.length, 3, JSON.stringify(chat.body.drafts?.map((e) => e.draft?.target)));
    assert.deepEqual(
      chat.body.drafts.map((entry) => entry.draft.target),
      ['schedule', 'todo', 'event'],
      '顺序应与模型输出一致，用户照着说话顺序逐张确认',
    );
    for (const entry of chat.body.drafts) {
      assert.equal(entry.error, null, `这条不该有校验错误：${JSON.stringify(entry.error)}`);
      assert.equal(entry.preview.dryRun, true);
    }
    assert.deepEqual(chat.body.executed, [], '手动档不执行任何写入');
    // 没执行、也没查询 → 一轮就收尾，不必多花上游调用
    assert.equal(mock.state.bodies.length, 1, `手动档只出草稿，不该多轮：${mock.state.bodies.length}`);

    // **一条都没落库**
    assert.equal((await call('GET', '/todos')).body.items.length, 0);
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
    assert.equal((await call('GET', '/events')).body.items.length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('手动档的确认卡在点确认前就知道撞了：草稿预览里带 conflicts', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: [`好，我准备这样加。\n${fenced(overlappingSchedule)}`] });
  const { app, call } = await startApp({ mock });
  try {
    const existing = await call('POST', '/schedules', {
      title: '材料力学',
      date: DAY,
      startTime: '10:00',
      endTime: '11:00',
    });

    // 默认就是 manual：草稿只预览、等用户点确认
    const chat = await call('POST', '/ai/chat', { text: '帮我把 10:30 的小组会加进日程' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.drafts.length, 1);

    const [entry] = chat.body.drafts;
    assert.equal(entry.preview.dryRun, true);
    assert.equal(entry.preview.conflicts?.length, 1, `确认卡的数据里要能拿到重叠：${JSON.stringify(entry.preview)}`);
    assert.equal(entry.preview.conflicts[0].scheduleId, existing.body.item.id);
    assert.equal(entry.preview.conflicts[0].title, '材料力学');
    assert.equal(entry.preview.conflicts[0].startTime, '10:00');

    // 还是那一条：预览没有写库，用户没点确认之前什么都不该发生
    assert.equal((await call('GET', '/schedules')).body.items.length, 1);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('提示词：一轮最多 3 条写入草稿，超出的用自然语言追问；auto 档说清会有执行结果回灌', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好。' });
  const { app, call } = await startApp({ mock });
  try {
    await call('POST', '/ai/chat', { text: '你好', permission: 'auto' });
    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.equal(mock.state.bodies[0].messages[0].role, 'system');

    // 「写入一次只提议一条」正是"一句话只落一件"的根因，必须已经从提示词里消失
    assert.doesNotMatch(system, /一次只给一个草稿/);
    assert.doesNotMatch(system, /写入类的操作仍然一次只提议一条/);
    assert.match(system, /一轮最多给 3 条写入草稿/);
    assert.match(system, /超过 3 件/, '超过 3 条时的口径要写清（先说清剩下的，别悄悄少办）');
    assert.match(system, /每件事各占一段/, '一段一个草稿的格式说明也要跟着放开，否则模型仍只给一条');

    // auto 档必须告诉模型"执行结果会回灌、冲突要主动提醒"，否则它拿到注入也不知道该说什么
    assert.match(system, /\[系统注入\]/);
    assert.match(system, /重叠提醒/);
  } finally {
    await app.close();
    await mock.close();
  }
});
