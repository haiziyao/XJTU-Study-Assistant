/**
 * AI 聊天接口的端到端测试。
 *
 * 用本地 mock 上游（test/helpers/ai-mock.js）复刻 OpenAI 兼容的 chat completions，
 * 所以「配置 → 对话 → 抽草稿 → dryRun 预览 → 用户确认 → 真正落库」整条链路都是真跑的，
 * 不依赖网络、不需要 API Key。
 *
 * 重点覆盖几处「一旦写错就会静默出事」的地方：
 *   - 密钥只进不出（接口不回显、错误信息里也不许出现）；
 *   - 模型**不能**直接写库：草稿只做 dryRun 预览，落库必须经 /commands/execute；
 *   - **只读查询要自动执行并把结果回灌给模型**（否则模型只能说"我拿不到数据"，
 *     用户问"我明天有什么日程"却什么也看不到 —— 这是实测反馈的 bug）；
 *   - 流式增量走 WebSocket，且 HTTP 仍然一次拿到最终结果（重连不会丢）；
 *   - 多轮历史真的进了上游请求体；
 *   - 上游 401 / 超时翻译成 502，而不是 500 或一直挂着。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import { connectWs } from './helpers/ws-client.js';

const KEY = 'sk-test-1234567890abcd';

/** 起一套「后端 + 指向 mock 上游的 AI provider」。 */
async function startApp({ mock, ai, dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-ai-')));
  const app = await createServer({
    dataDir: dir,
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
  return { app, info, call, dataDir: dir, mock };
}

test('AI：未配置密钥时状态明确，对话返回 501 而不是 500', async () => {
  const { app, call } = await startApp();
  try {
    const status = await call('GET', '/ai/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, false);
    assert.equal(status.body.ready, false);
    assert.equal(status.body.config.hasKey, false);
    assert.equal(status.body.config.keyHint, null);
    // 就算没配密钥，也要说清楚模型和地址是什么，便于用户判断
    assert.equal(status.body.config.model, 'deepseek-flash');
    assert.match(status.body.config.baseUrl, /^https:\/\//);

    const chat = await call('POST', '/ai/chat', { text: '你好' });
    assert.equal(chat.status, 501);
    assert.equal(chat.body.error.code, 'AI_UNAVAILABLE');
    assert.match(chat.body.error.details.hint, /ai\/config/);
  } finally {
    await app.close();
  }
});

test('AI：配置密钥落盘 0600，接口只回显末四位', async () => {
  const { app, call, dataDir } = await startApp();
  try {
    const saved = await call('POST', '/ai/config', { apiKey: KEY, model: 'deepseek-v4-pro', temperature: 0.1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.hasKey, true);
    assert.equal(saved.body.config.keyHint, '…abcd');
    assert.equal(saved.body.config.model, 'deepseek-v4-pro');
    // 接口响应里绝不能出现原值
    assert.equal(JSON.stringify(saved.body).includes(KEY), false);

    const fetched = await call('GET', '/ai/config');
    assert.equal(JSON.stringify(fetched.body).includes(KEY), false);
    assert.equal(fetched.body.config.hasKey, true);

    // 磁盘上是 0600，且确实存了密钥（本地单用户，靠文件权限保护）
    const file = path.join(dataDir, 'ai-config.json');
    // Windows 不支持 POSIX 权限位（只有只读位生效），0600 与 0666 在 stat 上无法区分，
    // 因此这里只在 POSIX 平台断言。应用代码仍照常按 0600 请求权限，macOS / Linux 不受影响；
    // 详见 README「Windows + 受限会话」一节。
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY);

    const status = await call('GET', '/ai/status');
    assert.equal(status.body.ready, true);
    assert.equal(status.body.provider, 'deepseek');

    // 清空配置：密钥消失，状态回到未配置
    const cleared = await call('DELETE', '/ai/config');
    assert.equal(cleared.body.config.hasKey, false);
    assert.equal((await call('GET', '/ai/status')).body.ready, false);
  } finally {
    await app.close();
  }
});

test('AI：一次对话自动建会话、存两条消息，并记录模型与用量', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好的，明天上午提醒你交作业。' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const chat = await call('POST', '/ai/chat', { text: '明天记得提醒我交作业' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.assistant.content, '好的，明天上午提醒你交作业。');
    assert.equal(chat.body.assistant.status, 'done');
    assert.equal(chat.body.assistant.model, 'mock-chat');
    assert.deepEqual(chat.body.assistant.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.deepEqual(chat.body.drafts, []);

    const { conversation, messages } = chat.body;
    assert.equal(conversation.title, '明天记得提醒我交作业');
    assert.equal(conversation.messageCount, 2);

    const detail = await call('GET', `/ai/conversations/${conversation.id}`);
    assert.equal(detail.body.count, 2);
    assert.deepEqual(detail.body.messages.map((m) => m.role), ['user', 'assistant']);

    const list = await call('GET', '/ai/conversations');
    assert.equal(list.body.count, 1);

    // 提示词里必须带上「三件事」的判定表与今天的绝对日期 —— 这是模型选对集合的唯一依据
    const sent = mock.state.bodies[0];
    const system = sent.messages[0];
    assert.equal(system.role, 'system');
    assert.match(system.content, /待办 Todo/);
    assert.match(system.content, /日程必须有 startTime/);
    assert.match(system.content, /今天/);
    // 字段名必须是模型真正能用的那些：备注叫 description（写 notes 会被静默丢掉），
    // priority 是整数（写 "high" 会被 400）—— 这两条都是真机/单测抓出来的
    assert.match(system.content, /description（备注）/);
    assert.match(system.content, /不是 notes/);
    assert.match(system.content, /priority（整数 0=低/);
    assert.match(system.content, /不是 "high"/);
    // 待办的工时字段必须是 estimatedHours（S3：提示词原先写成 estimatedMinutes，
    // 而服务端只认 estimatedHours，用户说的"两小时"被静默丢成默认 1 小时）
    assert.match(system.content, /estimatedHours（预估\*\*工时\*\*/);
    assert.match(system.content, /estimatedMinutes（整数分钟），系统会换算/);
    assert.match(system.content, /不会静默丢弃/);
    // 记忆的 key 规则（S5：模型写中文 key → 确认卡必然 400，因为提示词从没教过它格式）
    assert.match(system.content, /默认省略/);
    assert.match(system.content, /别写中文 key/);
    assert.equal(sent.model, 'mock-chat');
    assert.equal(sent.stream, false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：模型给的草稿只做 dryRun 预览，用户确认后才落库', async () => {
  const reply = [
    '我准备这样加一个待办，你确认一下。',
    '```command',
    JSON.stringify({
      ok: true,
      action: 'create',
      target: 'todo',
      fields: { title: '交实验报告', deadline: '2026-10-13', estimatedMinutes: 120, priority: 2 },
      confidence: 0.9,
      explain: '明天交实验报告',
    }),
    '```',
  ].join('\n');
  const mock = await startMockAi({ apiKey: KEY, reply });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const chat = await call('POST', '/ai/chat', { text: '明天交实验报告，预计两小时' });
    assert.equal(chat.status, 200);

    // 给用户看的文本里不该出现代码块
    assert.equal(chat.body.assistant.content, '我准备这样加一个待办，你确认一下。');
    assert.equal(chat.body.assistant.content.includes('```'), false);
    // 原文留档，便于排查"模型到底说了啥"
    assert.match(chat.body.assistant.raw, /```command/);

    assert.equal(chat.body.drafts.length, 1);
    const [entry] = chat.body.drafts;
    assert.equal(entry.draft.target, 'todo');
    assert.equal(entry.error, null);
    assert.equal(entry.preview.ok, true);
    assert.equal(entry.preview.dryRun, true);
    // planned 是模型原样给的字段；validated 是跑过真实校验/归一化后的最终值
    assert.equal(entry.preview.planned.fields.title, '交实验报告');
    assert.equal(entry.preview.validated.title, '交实验报告');
    assert.equal(entry.preview.validated.priority, 2);
    assert.equal(entry.preview.validated.completed, false);
    assert.equal(entry.preview.validated.source, 'command', '草稿经命令管线执行，source 应标成 command');

    // 关键：这一步之后库里**还不该有**这条待办
    const before = await call('GET', '/todos');
    assert.equal(before.body.items.length, 0);

    // 用户点确认 → 走的就是本地规则那条路
    const executed = await call('POST', '/commands/execute', { draft: entry.draft });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.target, 'todo');

    const after = await call('GET', '/todos');
    assert.equal(after.body.items.length, 1);
    assert.equal(after.body.items[0].deadline, '2026-10-13');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：模型的草稿不合法时保留草稿并给出字段错误，聊天本身仍然成功', async () => {
  const bad = { ok: true, action: 'create', target: 'schedule', fields: { title: '自习', date: '2026-10-13' } };
  const mock = await startMockAi({ apiKey: KEY, reply: `试一下。\n\`\`\`command\n${JSON.stringify(bad)}\n\`\`\`` });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const chat = await call('POST', '/ai/chat', { text: '明天自习' });
    assert.equal(chat.status, 200, '草稿不合法不该让整次对话失败');
    const [entry] = chat.body.drafts;
    assert.equal(entry.preview, null);
    assert.equal(entry.error.code, 'BAD_REQUEST');
    assert.match(entry.error.message, /startTime/);
    assert.equal(entry.error.details.field, 'startTime');
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：多轮对话把历史带给上游，且只带 role 与 content', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['第一轮回复', '第二轮回复'] });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const first = await call('POST', '/ai/chat', { text: '明天有什么安排' });
    const id = first.body.conversation.id;
    const second = await call('POST', '/ai/chat', { conversationId: id, text: '那把自习安排在下午' });

    assert.equal(second.status, 200);
    assert.equal(second.body.assistant.content, '第二轮回复');

    const sent = mock.state.bodies[1];
    assert.deepEqual(
      sent.messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'user'],
    );
    assert.equal(sent.messages[1].content, '明天有什么安排');
    assert.equal(sent.messages[2].content, '第一轮回复');
    assert.equal(sent.messages[3].content, '那把自习安排在下午');
    // 消息对象里不许混进我们自己的字段（conversationId / status / usage…）
    for (const message of sent.messages.slice(1)) {
      assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
    }

    const detail = await call('GET', `/ai/conversations/${id}`);
    assert.equal(detail.body.count, 4);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：流式对话通过 WebSocket 推增量，HTTP 仍返回最终结果', async () => {
  const reply = '我先看一下你的待办，然后给你排个顺序。';
  const mock = await startMockAi({ apiKey: KEY, reply });
  const { app, info, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const ws = await connectWs({ port: info.port });
    try {
      const chat = await call('POST', '/ai/chat', { text: '帮我排一下今天的事', stream: true });
      assert.equal(chat.status, 200);
      assert.equal(chat.body.assistant.content, reply);

      // 增量必须拼得回原文，且 messageId 与最终消息一致
      const done = await ws.waitFor((message) => message.type === 'ai_message' && message.module === 'ai');
      const deltas = ws.messages.filter((message) => message.type === 'ai_delta');
      assert.ok(deltas.length > 1, `应该收到多块增量，实际 ${deltas.length}`);
      assert.equal(deltas.map((m) => m.payload.delta).join(''), reply);
      assert.equal(deltas[0].payload.messageId, done.payload.message.id);
      assert.equal(done.payload.message.content, reply);
      assert.equal(done.payload.message.status, 'done');

      // 每个 delta 都带会话 id，前端才能过滤出当前会话
      assert.equal(deltas[0].payload.conversationId, chat.body.conversation.id);
      // 增量是按顺序发的
      assert.equal(deltas.at(-1).payload.text, reply);
    } finally {
      ws.close();
    }
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：上游 401 翻译成 502，且错误里不出现密钥', async () => {
  const mock = await startMockAi({ apiKey: 'another-key' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const chat = await call('POST', '/ai/chat', { text: '你好' });
    assert.equal(chat.status, 502);
    assert.equal(chat.body.error.code, 'UPSTREAM_ERROR');
    assert.equal(chat.body.error.details.upstreamStatus, 401);
    assert.match(chat.body.error.details.hint, /API Key/);
    // 上游把 Authorization 回显进了报错，我们必须在 details.body 里抹掉
    assert.equal(JSON.stringify(chat.body).includes(KEY), false);
    assert.match(chat.body.error.details.body, /\*\*\*/);

    // 失败的那条消息仍然落库并标成 failed，用户能看到"刚才那次没成"
    const list = await call('GET', '/ai/conversations');
    const detail = await call('GET', `/ai/conversations/${list.body.items[0].id}`);
    const assistant = detail.body.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.status, 'failed');
    assert.equal(assistant.error.code, 'UPSTREAM_ERROR');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：上游超时按配置的 timeoutMs 报错，不会一直挂着', async () => {
  const mock = await startMockAi({ apiKey: KEY, hang: true });
  const { app, call } = await startApp({
    mock,
    ai: { apiKey: KEY, baseUrl: mock.baseUrl, timeoutMs: 1000 },
  });
  try {
    const started = Date.now();
    const chat = await call('POST', '/ai/chat', { text: '在吗' });
    assert.equal(chat.status, 502);
    assert.match(chat.body.error.message, /超时/);
    assert.ok(Date.now() - started < 5000, '不该等到默认的 60 秒');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：注册 provider 之后，/ai/capabilities 与 /ai/nl2command 真正可用', async () => {
  const draft = {
    ok: true,
    action: 'create',
    target: 'schedule',
    fields: { title: '项目周会', date: '2026-10-13', startTime: '15:00', endTime: '16:00' },
    confidence: 0.88,
  };
  const mock = await startMockAi({ apiKey: KEY, reply: JSON.stringify(draft) });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const capabilities = await call('GET', '/ai/capabilities');
    assert.equal(capabilities.body.available, true);
    assert.equal(capabilities.body.provider, 'deepseek');
    // AI 模块自己的工具也要出现在聚合清单里，并带上 module
    const tool = capabilities.body.aiTools.find((item) => item.name === 'ai_context_get');
    assert.ok(tool, 'ai_context_get 应该在 aiTools 里');
    assert.equal(tool.module, 'ai');

    // 这条路以前是 501 占位，现在真的能产出草稿了
    const nl = await call('POST', '/ai/nl2command', { text: '明天下午三点到四点项目周会' });
    assert.equal(nl.status, 200);
    assert.equal(nl.body.draft.target, 'schedule');
    // provider 由框架（ai-bridge）盖章，模块自己不写这个字段
    assert.equal(nl.body.draft.provider, 'deepseek');

    // 单指令这条路的提示词必须是"只吐 JSON"，且温度是 0
    assert.match(mock.state.bodies[0].messages[0].content, /只输出一个 JSON 对象/);
    assert.equal(mock.state.bodies[0].temperature, 0);

    const executed = await call('POST', '/commands/execute', { draft: nl.body.draft });
    assert.equal(executed.status, 200);
    const schedules = await call('GET', '/schedules');
    assert.equal(schedules.body.items.length, 1);
    assert.equal(schedules.body.items[0].startTime, '15:00');

    // 已配置时 provider 优先，显式要 fallback 也不会绕过模型（避免"以为用了模型其实没用"）
    const explicit = await call('POST', '/ai/nl2command', { text: '明天交作业', fallback: 'rules' });
    assert.equal(explicit.body.draft.provider, 'deepseek');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：没配密钥时不注册 provider，/ai/nl2command 的 fallback=rules 仍然可用', async () => {
  // 这是框架的明文承诺（「AI 挂了也能用」）：装了 AI 模块但没配密钥时，
  // 绝不能因为"注册了一个不可用的 provider"把降级路径挡死。
  const { app, call } = await startApp();
  try {
    const capabilities = await call('GET', '/ai/capabilities');
    assert.equal(capabilities.body.available, false, '未配置时不该声称 AI 可用');
    assert.equal(capabilities.body.provider, null);

    const fallback = await call('POST', '/ai/nl2command', { text: '明天交作业', fallback: 'rules' });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.draft.provider, 'rules');
    assert.equal(fallback.body.draft.degraded, true);
    assert.equal(fallback.body.draft.target, 'todo');

    // 不传 fallback 时仍然是 501（明确告诉调用方"AI 没接"）
    const strict = await call('POST', '/ai/nl2command', { text: '明天交作业' });
    assert.equal(strict.status, 501);
    assert.equal(strict.body.error.code, 'AI_UNAVAILABLE');
  } finally {
    await app.close();
  }
});

test('AI：运行时配置密钥后 provider 立刻生效，清空后降级路径立刻恢复', async () => {
  const draft = { ok: true, action: 'create', target: 'todo', fields: { title: '背单词', deadline: '2026-10-20' } };
  const mock = await startMockAi({ apiKey: KEY, reply: JSON.stringify(draft) });
  const { app, call } = await startApp();
  try {
    assert.equal((await call('GET', '/ai/capabilities')).body.available, false);

    await call('POST', '/ai/config', { apiKey: KEY, baseUrl: mock.baseUrl });
    assert.equal((await call('GET', '/ai/capabilities')).body.available, true, '配置后应立刻可用，不用重启');
    const used = await call('POST', '/ai/nl2command', { text: '20 号前背单词' });
    assert.equal(used.body.draft.provider, 'deepseek');
    assert.equal(used.body.draft.target, 'todo');

    await call('DELETE', '/ai/config');
    assert.equal((await call('GET', '/ai/capabilities')).body.available, false, '清空后不该继续声称可用');
    const fallback = await call('POST', '/ai/nl2command', { text: '明天交作业', fallback: 'rules' });
    assert.equal(fallback.body.draft.provider, 'rules');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：上下文接口符合 §10.7 的形状（记忆未装配时给空预算）', async () => {
  const { app, call } = await startApp();
  try {
    const context = await call('GET', '/ai/context?view=calendar&module=calendar');
    assert.equal(context.status, 200);
    assert.match(context.body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(context.body.view, 'calendar');
    assert.deepEqual(context.body.memory.injected, []);
    assert.equal(context.body.memory.budget.maxItems, 8);
    assert.equal(context.body.memory.budget.maxChars, 600);
    assert.equal(context.body.memory.budget.truncated, false);
    assert.equal(typeof context.body.recent.todos.open, 'number');
    assert.equal(typeof context.body.recent.today.schedules, 'number');

    // 预算可以按次覆盖
    const custom = await call('GET', '/ai/context?maxItems=2&maxChars=50');
    assert.equal(custom.body.memory.budget.maxItems, 2);
    assert.equal(custom.body.memory.budget.maxChars, 50);
  } finally {
    await app.close();
  }
});

test('AI：会话可列举、可删除，删会话连带删消息', async () => {
  const mock = await startMockAi({ apiKey: KEY });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const a = await call('POST', '/ai/chat', { text: '第一件事' });
    await call('POST', '/ai/chat', { text: '第二件事' });
    const list = await call('GET', '/ai/conversations');
    assert.equal(list.body.count, 2);
    // 倒序：最近说话的排前面
    assert.equal(list.body.items[0].title, '第二件事');

    const removed = await call('DELETE', `/ai/conversations/${a.body.conversation.id}`);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.messages, 2);
    assert.equal((await call('GET', '/ai/conversations')).body.count, 1);
    assert.equal((await call('GET', '/ai/status')).body.messages, 2, '剩下的会话还留着它的两条消息');

    const missing = await call('GET', '/ai/conversations/does-not-exist');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：上下文摘要真的来自业务数据（未完成待办 / 今天日程）', async () => {
  const { app, call } = await startApp();
  try {
    const today = (await call('GET', '/ai/context')).body.today;
    await call('POST', '/todos', { title: '写实验报告', deadline: today });
    await call('POST', '/todos', { title: '早就该交的', deadline: '2020-01-01' });
    await call('POST', '/schedules', { title: '自习', date: today, startTime: '19:00', endTime: '21:00' });

    const context = await call('GET', '/ai/context');
    assert.equal(context.body.recent.todos.open, 2);
    assert.equal(context.body.recent.todos.overdue, 1);
    assert.equal(context.body.recent.todos.dueToday, 1);
    assert.equal(context.body.recent.today.schedules, 1);
  } finally {
    await app.close();
  }
});

test('AI：清空全部会话（设置页那一键）连消息一起删干净', async () => {
  const mock = await startMockAi({ apiKey: KEY });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/ai/chat', { text: '第一件事' });
    await call('POST', '/ai/chat', { text: '第二件事' });
    assert.equal((await call('GET', '/ai/conversations')).body.count, 2);

    const cleared = await call('DELETE', '/ai/conversations');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.conversations, 2);
    assert.equal(cleared.body.messages, 4);

    assert.equal((await call('GET', '/ai/conversations')).body.count, 0);
    const status = await call('GET', '/ai/status');
    assert.equal(status.body.conversations, 0);
    assert.equal(status.body.messages, 0);

    // 单条删除仍然可用（别把 :id 那条路由吃掉）
    await call('POST', '/ai/chat', { text: '第三件事' });
    const one = (await call('GET', '/ai/conversations')).body.items[0];
    assert.equal((await call('DELETE', `/ai/conversations/${one.id}`)).body.deleted, true);
    assert.equal((await call('GET', '/ai/conversations')).body.count, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：只读查询自动执行 + 结果回灌，模型能说出具体安排（不再"我拿不到数据"）', async () => {
  const DAY = '2026-10-13';
  const queryDraft = {
    ok: true,
    action: 'query',
    target: 'schedule',
    filters: { from: DAY, to: DAY },
    explain: `查询 ${DAY} 的日程`,
  };
  // 第一次回查询草稿，第二次（拿到结果后）才给自然语言答案
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我查一下你明天（${DAY}）的日程。\n\`\`\`command\n${JSON.stringify(queryDraft)}\n\`\`\``,
      '你明天只有一件事：10:00–11:00 在 教2楼-西203 上材料力学。',
    ],
  });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/schedules', { title: '材料力学', date: DAY, startTime: '10:00', endTime: '11:00', location: '教2楼-西203' });

    const chat = await call('POST', '/ai/chat', { text: '我明天有什么日程' });
    assert.equal(chat.status, 200);

    // 1) 上游被调了两次：先出草稿，再据结果作答
    assert.equal(mock.state.bodies.length, 2, '应该有一次回灌后的第二次调用');

    // 2) 第二次请求里带着**真实数据**，并且明确告诉模型别再推诿
    const injected = mock.state.bodies[1].messages.at(-1);
    assert.equal(injected.role, 'user');
    assert.match(injected.content, /\[系统注入\]/);
    assert.match(injected.content, /材料力学/);
    assert.match(injected.content, /教2楼-西203/);
    assert.match(injected.content, /不要再输出查询草稿/);
    assert.match(injected.content, /不要再说"需要你确认"/);

    // 3) 给用户看的是答案，而不是"准备执行：查询日程"的确认卡
    assert.match(chat.body.assistant.content, /材料力学/);
    assert.deepEqual(chat.body.drafts, [], '查询不该再产出确认卡');

    // 4) 数据原样返回给前端画数据卡片
    assert.equal(chat.body.queried.length, 1);
    assert.equal(chat.body.queried[0].result.count, 1);
    assert.equal(chat.body.queried[0].result.items[0].title, '材料力学');
    assert.equal(chat.body.queried[0].result.items[0].startTime, '10:00');
    assert.equal(chat.body.queried[0].draft.filters.from, DAY);

    // 5) 只读就是只读：日程没被改动
    const schedules = await call('GET', '/schedules');
    assert.equal(schedules.body.items.length, 1);
    assert.equal(schedules.body.items[0].title, '材料力学');
    assert.equal(schedules.body.items[0].updatedAt, schedules.body.items[0].createdAt, '查询不该写任何东西');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：模型把查询条件写进 fields.date 时会被兜住（否则等于查了整个库）', async () => {
  const today = '2026-10-11';
  const badShape = {
    ok: true,
    action: 'query',
    target: 'schedule',
    // 实测模型就是这么写的：条件在 fields 里，而查询处理器只读 filters
    fields: { date: '2026-10-13' },
    explain: '查询 2026-10-13 的日程',
  };
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`\`\`\`command\n${JSON.stringify(badShape)}\n\`\`\``, '那天没有安排。'],
  });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    // 两条日程：一条在查询日，一条在别的日子 —— 没兜住的话会把两条都查出来
    await call('POST', '/schedules', { title: '目标那天', date: '2026-10-13', startTime: '10:00' });
    await call('POST', '/schedules', { title: '别的日子', date: today, startTime: '08:00' });

    const chat = await call('POST', '/ai/chat', { text: '10 月 13 号有什么日程' });
    const [entry] = chat.body.queried;
    assert.deepEqual(entry.draft.filters, { from: '2026-10-13', to: '2026-10-13' }, 'fields.date 应被搬进 filters');
    assert.equal(entry.result.count, 1, '只该命中目标那天');
    assert.equal(entry.result.items[0].title, '目标那天');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：总结那一步失败也不丢数据（查询结果照样返回给前端）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `\`\`\`command\n${JSON.stringify({ ok: true, action: 'query', target: 'todo', filters: {} })}\n\`\`\``,
      '这次总结不该成功',
    ],
    failWith: [2],
  });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/todos', { title: '写实验报告', deadline: '2026-10-20' });
    const chat = await call('POST', '/ai/chat', { text: '我有哪些待办' });
    assert.equal(chat.status, 200, '总结失败不该让整次对话失败');
    assert.equal(chat.body.queried[0].result.items[0].title, '写实验报告');
    assert.equal(chat.body.assistant.error?.code, 'PARTIAL');
    assert.match(chat.body.assistant.error.message, /500/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：公式规范常驻提示词；绘图说明按开关注入，指令词能临时触发', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['好', '好', '好'] });

  // 1) 默认（drawMode 默认开）：公式 + 绘图说明都在
  const on = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const status = await on.call('GET', '/ai/status');
    assert.equal(status.body.config.drawMode, true, '默认应开用作图');

    await on.call('POST', '/ai/chat', { text: '这个公式怎么推' });
    const system = mock.state.bodies[0].messages[0].content;
    assert.match(system, /【数学公式：用 LaTeX/, '公式规范应常驻');
    assert.match(system, /不支持.*矩阵|矩阵\/分段函数/s);
    assert.match(system, /【绘图能力】/);
    assert.match(system, /不要用 style 属性/, 'CSP 会拦内联样式，必须写进提示词');
    assert.match(system, /深色背景/);
  } finally {
    await on.app.close();
  }

  // 2) 关掉作图 + 普通提问：不应注入绘图说明（省 token）
  const off = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, drawMode: false } });
  try {
    assert.equal((await off.call('GET', '/ai/config')).body.config.drawMode, false);
    await off.call('POST', '/ai/chat', { text: '这个公式怎么推' });
    const plain = mock.state.bodies[1].messages[0].content;
    assert.match(plain, /【数学公式：用 LaTeX/);
    assert.equal(plain.includes('【绘图能力】'), false, '关掉后不该注入绘图说明');

    // 3) 但用户用了指令词「画个图」→ 临时触发
    await off.call('POST', '/ai/chat', { text: '帮我画个函数图像' });
    const byKeyword = mock.state.bodies[2].messages[0].content;
    assert.match(byKeyword, /【绘图能力】/, '用户明说要画应临时开启');

    // 4) 配置能保存与回读
    const saved = await off.call('POST', '/ai/config', { drawMode: true });
    assert.equal(saved.body.config.drawMode, true);
    assert.equal((await off.call('GET', '/ai/config')).body.config.drawMode, true);
  } finally {
    await off.app.close();
    await mock.close();
  }
});

test('AI：思考强度对齐官方取值（none/low/high/max），默认 high，且必须显式传', async () => {
  // 官方文档：思考模式**默认打开**、effort 默认 high；合法取值 none/low/high/max（medium 只是别名→high）
  const mock = await startMockAi({ apiKey: KEY, replies: ['好', '好', '好', '好', '好'] });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/ai/chat', { text: '默认档' });
    assert.equal(mock.state.bodies[0].reasoning_effort, 'high', '不传时应与官方默认一致（high）');

    await call('POST', '/ai/chat', { text: '不想思考', thinking: 'none' });
    assert.equal(mock.state.bodies[1].reasoning_effort, 'none', '关闭思考必须显式传 none，省略 ≠ 关闭');

    await call('POST', '/ai/chat', { text: '想久一点', thinking: 'max' });
    assert.equal(mock.state.bodies[2].reasoning_effort, 'max');

    await call('POST', '/ai/chat', { text: '旧前端的 medium', thinking: 'medium' });
    assert.equal(mock.state.bodies[3].reasoning_effort, 'high', 'medium 是兼容别名，映射成 high');

    await call('POST', '/ai/chat', { text: '乱传一个', thinking: '不存在的档位' });
    assert.equal(mock.state.bodies[4].reasoning_effort, 'high', '非法档位回落到官方默认');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：思维链（reasoning_content）被单独收好，且**不回传**给下一轮', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['4 条', '好'], reasoning: '先数一数……4 个 R' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const first = await call('POST', '/ai/chat', { text: 'strawberry 里有几个 r' });
    assert.equal(first.body.assistant.reasoning, '先数一数……4 个 R');
    // 正文里不该混进思维链
    assert.equal(first.body.assistant.content, '4 条');

    // 第二轮：官方文档说未携带 tools 时 reasoning_content 不该回传（传了也会被忽略）
    await call('POST', '/ai/chat', { conversationId: first.body.conversation.id, text: '再来' });
    const history = mock.state.bodies[1].messages;
    assert.equal(JSON.stringify(history).includes('先数一数'), false, '思维链不进上下文');
    for (const message of history.slice(1)) {
      assert.deepEqual(Object.keys(message).sort(), ['content', 'role'], '历史消息只带 role/content');
    }
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：看图能力按官方文档把关（只有 flash 支持，格式只认四种）', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['看到了'] });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'deepseek-v4-pro' } });
  try {
    const rejected = await call('POST', '/ai/chat', {
      text: '看看这张图',
      attachments: [{ name: 'a.png', type: 'image/png', size: 100, dataUrl: 'data:image/png;base64,AAAA' }],
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.details.field, 'attachments');
    assert.match(rejected.body.error.message, /deepseek-flash/);
  } finally {
    await app.close();
    await mock.close();
  }

  // 换成 flash：图片正常；不支持的类型（bmp）降级成"读不了的文件"，不硬塞给上游
  const flash = await startMockAi({ apiKey: KEY, replies: ['看到了'] });
  const ok = await startApp({ mock: flash, ai: { apiKey: KEY, baseUrl: flash.baseUrl, model: 'deepseek-flash' } });
  try {
    const chat = await ok.call('POST', '/ai/chat', {
      text: '这两张',
      attachments: [
        { name: 'a.png', type: 'image/png', size: 100, dataUrl: 'data:image/png;base64,AAAA' },
        { name: 'b.bmp', type: 'image/bmp', size: 100, dataUrl: 'data:image/bmp;base64,BBBB' },
      ],
    });
    assert.equal(chat.status, 200);
    const content = flash.state.bodies[0].messages.at(-1).content;
    const carriers = content.filter((part) => part.type === 'file' || part.type === 'image_url');
    assert.equal(carriers.length, 1, '只把官方支持的格式当图片送');
    assert.equal(carriers[0].type, 'file', '上传成功后用 file 块');
    assert.match(content.find((part) => part.type === 'text').text, /b\.bmp/);
    assert.match(content.find((part) => part.type === 'text').text, /读不了/);
  } finally {
    await ok.app.close();
    await flash.close();
  }
});

test('AI：写入权限三档 —— 全部确认连查询都要确认，自动审批直接执行写操作', async () => {
  const query = { ok: true, action: 'query', target: 'todo', filters: { completed: false } };
  const create = { ok: true, action: 'create', target: 'todo', fields: { title: '写实验报告', deadline: '2026-10-20' } };
  // 逐次调用脚本（mock 按调用次序取）：
  //   strict 轮 → 查询草稿（不自动执行，所以只有 1 次调用）
  //   manual 轮 → 查询草稿 + 回灌后的作答
  //   auto  轮 → 写操作草稿（自动执行）
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `\`\`\`command\n${JSON.stringify(query)}\n\`\`\``,
      `\`\`\`command\n${JSON.stringify(query)}\n\`\`\``,
      '你有 1 条待办。',
      `\`\`\`command\n${JSON.stringify(create)}\n\`\`\``,
    ],
  });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    // strict：查询也不自动执行 → 只返回草稿，等用户确认；上游只被调了一次
    const strict = await call('POST', '/ai/chat', { text: '我有哪些待办', permission: 'strict' });
    assert.equal(strict.body.queried.length, 0);
    assert.equal(strict.body.drafts.length, 1);
    assert.equal(strict.body.drafts[0].draft.action, 'query');
    assert.equal(mock.state.bodies.length, 1, 'strict 下不该有第二次回灌调用');
    assert.equal((await call('GET', '/todos')).body.items.length, 0, '待办还没被创建');

    // manual（默认）：查询自动执行，写操作等确认
    const manual = await call('POST', '/ai/chat', { text: '我有哪些待办' });
    assert.equal(manual.body.queried.length, 1);
    assert.equal(manual.body.permission, 'manual');

    // auto：写操作直接执行，drafts 被清空、executed 带结果
    const auto = await call('POST', '/ai/chat', { text: '帮我加一条待办', permission: 'auto' });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.executed.length, 1);
    assert.equal(auto.body.executed[0].result.target, 'todo');
    assert.deepEqual(auto.body.drafts, [], '自动执行的草稿不再留确认卡');
    const todos = await call('GET', '/todos');
    assert.equal(todos.body.items.length, 1);
    assert.equal(todos.body.items[0].title, '写实验报告');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：附件 —— 文本内联进提示词、图片转多模态、读不了的文件如实说明', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '看过了。' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const chat = await call('POST', '/ai/chat', {
      text: '看看这份笔记',
      attachments: [
        { name: '笔记.md', type: 'text/markdown', size: 12, text: '# 第三章\n牛顿定律' },
        { name: '照片.png', type: 'image/png', size: 1024, dataUrl: 'data:image/png;base64,AAAA' },
        { name: '讲义.pdf', type: 'application/pdf', size: 20480 },
      ],
    });
    assert.equal(chat.status, 200);

    const sent = mock.state.bodies[0].messages.at(-1);
    assert.equal(sent.role, 'user');
    assert.ok(Array.isArray(sent.content), '有图片时应使用多模态数组');
    const text = sent.content.find((part) => part.type === 'text').text;
    assert.match(text, /看看这份笔记/);
    assert.match(text, /牛顿定律/, '文本附件内容应内联');
    assert.match(text, /讲义\.pdf/);
    assert.match(text, /读不了/, '读不了的文件要如实说明，别让模型假装看过');
    // 图片优先走官方 Files API 的 file 块（假上游支持 /files）
    const image = sent.content.find((part) => part.type === 'file');
    assert.match(image.file_id, /^file-api-/, '应使用官方 file 内容块引用已上传的图片');
    assert.equal(sent.content.some((part) => part.type === 'image_url'), false);

    // 只落元信息：base64 不进 JSON 集合
    const [message] = chat.body.conversation ? [chat.body.user] : [];
    assert.equal(message.attachments.length, 3);
    assert.equal(JSON.stringify(message).includes('base64,AAAA'), false);
    assert.equal(message.attachments[0].name, '笔记.md');

    // 只发附件不写字也可以
    const onlyFile = await call('POST', '/ai/chat', { attachments: [{ name: 'a.txt', type: 'text/plain', size: 3, text: 'abc' }] });
    assert.equal(onlyFile.status, 200);
    // 两者都空则 400
    assert.equal((await call('POST', '/ai/chat', { text: '   ' })).status, 400);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：模型列表 —— 上游给就用上游的，给不了回落内置候选', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const listed = await call('GET', '/ai/models');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.source, 'upstream');
    // 当前模型必须在列表里，否则选择器显示不出选中项
    assert.ok(listed.body.models.some((item) => item.id === 'mock-chat'));
    assert.ok(listed.body.models.some((item) => item.id === 'mock-model'));
    assert.equal(listed.body.current, 'mock-chat');
  } finally {
    await app.close();
    await mock.close();
  }

  // 未配置密钥 → 内置候选
  const bare = await startApp();
  try {
    const fallback = await bare.call('GET', '/ai/models');
    assert.equal(fallback.body.source, 'builtin');
    // 官方 Chat Completions 的合法取值只有这两个
    assert.ok(fallback.body.models.some((item) => item.id === 'deepseek-flash'));
    assert.ok(fallback.body.models.some((item) => item.id === 'deepseek-v4-pro'));
  } finally {
    await bare.app.close();
  }
});

test('AI：图片走官方 Files API —— 用 file_id 引用，同内容只上传一次', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['看到了', '又看到了'] });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'deepseek-flash' } });
  const image = { name: 'photo.png', type: 'image/png', size: 20, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  try {
    const first = await call('POST', '/ai/chat', { text: '看看这张图', attachments: [image] });
    assert.equal(first.status, 200);
    assert.equal(mock.state.fileUploads.length, 1, '第一次应上传');

    const content = mock.state.bodies[0].messages.at(-1).content;
    const block = content.find((part) => part.type === 'file');
    assert.ok(block, '上传成功后应使用官方 file 内容块');
    assert.match(block.file_id, /^file-api-/);
    assert.equal(content.some((part) => part.type === 'image_url'), false, '有 file_id 就不再用内联 base64');

    // 附件元信息里记下 fileId（历史里能看出当时用的是哪个文件）
    assert.match(first.body.user.attachments[0].fileId, /^file-api-/);

    // 同一张图再来一次：内容指纹命中，不再打上游
    await call('POST', '/ai/chat', { text: '再看', attachments: [image] });
    assert.equal(mock.state.fileUploads.length, 1, '同内容应复用，不重复上传');
    const second = mock.state.bodies[1].messages.at(-1).content.find((part) => part.type === 'file');
    assert.equal(second.file_id, block.file_id);

    // 本地账本
    const listed = await call('GET', '/ai/files');
    assert.equal(listed.body.count, 1);
    assert.equal(listed.body.bytes, 8, '账本记的是真实字节数（base64 解出来的，含 = 补位）');
    const upstream = await call('GET', '/ai/files/upstream');
    assert.equal(upstream.body.files.length, 1);

    // 删除：本地 + 上游都动
    const removed = await call('DELETE', `/ai/files/${listed.body.items[0].id}`);
    assert.equal(removed.body.deleted, true);
    assert.equal(mock.state.fileDeletes.length, 1);
    assert.equal((await call('GET', '/ai/files')).body.count, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：上传失败不阻断对话 —— 退回内联图片，并在响应里说明', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '看到了', filesFail: true });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'deepseek-flash' } });
  try {
    const chat = await call('POST', '/ai/chat', {
      text: '看图',
      attachments: [{ name: 'a.png', type: 'image/png', size: 20, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    assert.equal(chat.status, 200, 'Files API 挂了不该让对话失败');
    assert.equal(chat.body.warnings.length, 1);
    assert.match(chat.body.warnings[0], /上传失败.*已改用内联/);
    const content = mock.state.bodies[0].messages.at(-1).content;
    assert.ok(content.find((part) => part.type === 'image_url'), '应退回内联 base64');
    assert.equal(content.find((part) => part.type === 'image_url').image_url.url.startsWith('data:image/png'), true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：Token 用量与缓存命中率按输入侧算（官方 prompt_cache_hit/miss_tokens）', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['一', '二'] });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    // 一条靠后的属性：让假上游返回官方形状的 usage（含缓存细分与思考 token）
    // 同一个会话里聊两轮，"对话累计"才有意义（不传 conversationId 会各开一个新会话）
    const first = await call('POST', '/ai/chat', { text: '你好' });
    const id = first.body.conversation.id;
    await call('POST', '/ai/chat', { conversationId: id, text: '再问一次' });

    // 用真实消息目录改 usage：3 条回复，命中 300 / 未命中 100 / 输出 50
    const store = app.store;
    const messages = store.aiMessages.all().filter((m) => m.role === 'assistant');
    assert.ok(messages.length >= 2);
    for (const [index, message] of messages.entries()) {
      const usage = index === 0
        ? { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50, completion_tokens_details: { reasoning_tokens: 8 } }
        : { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 };
      await store.aiMessages.update(message.id, { usage });
    }

    const usage = await call('GET', `/ai/usage?conversationId=${id}`);
    assert.equal(usage.status, 200);
    assert.equal(usage.body.tokens.cached, 300);
    assert.equal(usage.body.tokens.uncached, 100);
    assert.equal(usage.body.tokens.output, 50);
    assert.equal(usage.body.tokens.input, 400, '输入 = 命中 + 未命中');
    assert.equal(usage.body.tokens.reasoning, 8);
    assert.equal(Math.round(usage.body.cacheHitRate * 1000) / 1000, 0.75, '命中率 = 300/400');
    assert.equal(usage.body.calls, 2, '两条回复 = 两次调用');
    assert.equal(usage.body.replies, 2);


    // 只给 prompt_tokens（没有缓存细分）的端点：按"全未命中"算，不该显示成 100% 命中
    await store.aiMessages.update(messages[0].id, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const mixed = await call('GET', '/ai/usage');
    assert.equal(mixed.body.tokens.input, 210);
    assert.equal(mixed.body.tokens.cached, 150);
    assert.equal(mixed.body.replies, messages.length);

    // 只读查询会带来第二次上游调用（回灌），那一次的用量也要算进去。
    // 放在最后做：这一步会改变累计值（messages[0] 的 usage 刚被换成"无缓存细分"那条）
    await store.aiMessages.update(messages[1].id, {
      usageFollowup: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 0 },
    });
    const withFollowup = await call('GET', `/ai/usage?conversationId=${id}`);
    assert.equal(withFollowup.body.calls, 3, '回灌那次也要计入');
    assert.equal(withFollowup.body.tokens.cached, 350, '150（第二条命中）+ 200（回灌命中）');
    assert.equal(withFollowup.body.tokens.uncached, 60);

    // 完全没有用量时：命中率给 null（而不是 0）
    const bare = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
    try {
      const empty = await bare.call('GET', '/ai/usage');
      assert.equal(empty.body.cacheHitRate, null);
      assert.equal(empty.body.tokens.total, 0);
    } finally {
      await bare.app.close();
    }
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI：老配置里的旧模型名会被迁移（但只对官方端点，免得误伤自建代理）', async () => {
  const { normalizeAiConfig } = await import('../src/modules/ai/config.js');

  // 官方端点 + 已下线的旧名字 → 换成当前合法取值
  assert.equal(normalizeAiConfig({ model: 'deepseek-chat' }).model, 'deepseek-flash');
  assert.equal(normalizeAiConfig({ model: 'deepseek-reasoner' }).model, 'deepseek-flash');
  // 自建/代理端点可能真的还有同名模型 → 一个字节都不动
  assert.equal(
    normalizeAiConfig({ baseUrl: 'http://127.0.0.1:9999/v1', model: 'deepseek-chat' }).model,
    'deepseek-chat',
  );
  // 当前合法值不受影响
  assert.equal(normalizeAiConfig({ model: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');

  // 落盘的老配置会被读出来并迁移，同时 /ai/status 回显原名字
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-ai-migrate-'));
  await writeFile(
    path.join(dir, 'ai-config.json'),
    JSON.stringify({ apiKey: 'sk-old', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  );
  const app = await createServer({ dataDir: dir });
  const info = await app.listen({ port: 0 });
  const response = await fetch(`${info.baseUrl}/ai/status`);
  const status = await response.json();
  try {
    assert.equal(status.config.model, 'deepseek-flash', '读出老配置时应已迁移');
    assert.equal(status.modelMigratedFrom, 'deepseek-chat', '要能告诉界面"原名字是什么"');
  } finally {
    await app.close();
  }
});

test('AI：提示词讲清「笔记」的边界 —— 不否认它存在、不擅自塞进待办、也不许编 note target', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/ai/chat', { text: '随便聊聊' });
    const system = mock.state.bodies[0].messages.find((message) => message.role === 'system').content;

    // 界面上确实有笔记系统，AI 不能再说"没有笔记这个类型"
    assert.ok(system.includes('笔记 Note'), '提示词要提到笔记');
    assert.ok(system.includes('笔记系统还没接入'), '要说清写入通道还没接');
    // 但也别让它自作主张把笔记落成待办 —— 那正是用户抱怨的行为
    assert.ok(system.includes('不要**擅自**把它落成待办'), '要明确禁止擅自降级成待办');
    // 关键：不能让它编一个还不存在的 target。
    // 注意这一条的措辞在 multi-round 那一轮改过：notes 模块**确实**声明了只读的 note 查询，
    // 所以现在禁的是 note 的**写入**草稿（create/update/delete），而不是 note 本身。
    assert.ok(system.includes('输出 target: "note" 的**写入**草稿'), '要明确禁止输出 note 的写入草稿');
    // target 只能来自各模块声明：不能自己发明（note 写入、lms 之类都不许）。
    // 措辞在 2026-10-13 改过：把"当前有哪些"从写死的一句改成分类清单 ——
    // 那时新增了记忆/校规/三源检索/周报，写死的清单立刻就过期了，
    // 而模型看不到某个 target 就等于那个功能对它不存在。
    // 2026-10 再改：复习卡片与学习目标两个 target 随功能一起移除，这里不再列它们。
    assert.ok(system.includes('**只能取下面「领域说明」里真的出现过的那些**'), '协议里要收死 target 取值');
    for (const target of ['`todo`', '`schedule`', '`event`', '`grade`', '`note`', '`search`', '`weekly`', '`web`', '`memory`']) {
      assert.ok(system.includes(target), `已声明的 target 要列进协议：${target}`);
    }
    assert.ok(system.includes('三源统一检索'), '要讲清 search 是干什么的（跨来源一次查完）');
  } finally {
    await app.close();
    await mock.close();
  }
});
