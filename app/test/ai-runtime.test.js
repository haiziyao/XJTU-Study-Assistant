/**
 * 「对话运行时」的三件事：能自己重试（检索预算）、能中途停（stop）、能看出来它在干什么（plan）。
 *
 * 为什么要单独一个文件、而且要真起后端：
 *   这三件事全都跨"HTTP + 存储 + WebSocket"三层 —— 契约里的每一条（`POST /ai/chat/stop` 的
 *   两种返回、被停止的消息必须**落库**成 `status:"stopped"`、`plan` 事件的全量快照、
 *   检索预算用尽后不再发出请求）都只有在真服务上才验得出来。
 *
 * 三个"假世界"，都不联网、不花钱：
 *   - `startSlowAi`：逐字慢慢吐的上游 —— 只有它才能造出"流到一半"这个稳定窗口；
 *   - `startMockAi`：逐轮脚本化的上游（复用现成 helper），用来演"模型一直换词重搜"；
 *   - `startFakeWeb`：本地假搜索引擎（空结果 / 有结果两种），由 `createServer({ai:{searchFetch}})` 注入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { AI_DEFAULTS, aiConfigFromEnv, normalizeAiConfig } from '../src/modules/ai/config.js';
import { startMockAi } from './helpers/ai-mock.js';
import { connectWs } from './helpers/ws-client.js';

const KEY = 'sk-test-runtime-0001';
const DAY = '2026-10-13';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

/**
 * 「慢慢吐字」的假上游：一个字一块、块间隔 `chunkDelayMs`。
 *
 * 为什么不能用现成的 `startMockAi` 的 `delayMs`：那是"响应前延迟一次"，
 * 而停止要验的是**流到一半**（正文已经有一截了）时按下去会发生什么。
 */
async function startSlowAi({ apiKey = KEY, replies = [], chunkDelayMs = 25 } = {}) {
  const state = { calls: 0, bodies: [], closed: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* 忽略 */
      }
      state.calls += 1;
      state.bodies.push(body);
      if (String(req.headers.authorization ?? '') !== `Bearer ${apiKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      const reply = replies[state.calls - 1] ?? '好的。';
      if (!body?.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'chatcmpl-slow',
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        );
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      /**
       * 客户端挂断的判定必须看 **res**（响应）而不是 req（请求）：
       * Node 里 `req` 的 'close' 在"请求体读完"时就会触发（那时连接明明还好着），
       * 用它当"断开了"会让假上游只吐一个字就自己收工 —— 测出来的是假象。
       */
      let gone = false;
      res.on('close', () => {
        if (res.writableFinished) return;
        gone = true;
        state.closed += 1;
      });
      // 一块一个字：停止时"已经生成到哪儿"因此是可控的、可断言的
      for (const piece of [...String(reply)]) {
        if (gone) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
        await sleep(chunkDelayMs);
      }
      if (gone) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl: `${origin}/v1`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/**
 * 假搜索引擎 + 假文章页。
 * `empty: true` 时结果页一条都没有（用来造"没搜到"）；`delayMs` 让引擎慢回（用来造"检索还没回来"）。
 */
async function startFakeWeb({ empty = false, delayMs = 0 } = {}) {
  const hits = [];
  /**
   * 端口**先取一次存下来**：`server.address()` 在 `close()` 之后返回 null，
   * 而 `delayMs` 那条路径上的响应可能在测试结束、服务器已关之后才走到这里
   * （读 `server.address().port` 会抛 TypeError，变成 unhandledRejection 把整个文件判失败）。
   */
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/doc1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><html><head><title>通知</title></head><body><article><h1>关于转专业的通知</h1>' +
          '<p>转专业申请时间为每学年春季学期，需提交成绩单。</p></article></body></html>',
      );
    }
    hits.push(url.search);
    if (delayMs) await sleep(delayMs);
    // 慢回的那条：测试可能已经结束、连接已经被关掉了，什么都不用再写
    if (res.destroyed || res.writableEnded) return undefined;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (empty) {
      // 结构正常、只是没有结果的页面：这正是"搜到了但没有可用结果"的样子
      return res.end('<!doctype html><html><body><ol id="b_results"></ol></body></html>');
    }
    const items = [1, 2, 3, 4, 5, 6]
      .map(
        (n) =>
          `<li class="b_algo"><h2><a href="http://127.0.0.1:${port}/doc1?i=${n}">转专业 相关通知 第 ${n} 条</a></h2>` +
          `<p>教务处关于转专业申请的通知摘要（第 ${n} 条）</p></li>`,
      )
      .join('');
    return res.end(`<!doctype html><html><body><ol id="b_results">${items}</ol></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const ENGINE_HOSTS = /(^|\.)(bing\.com|baidu\.com|sogou\.com|so\.com|duckduckgo\.com|mojeek\.com)$/i;
  /** 注入用 fetch：引擎域名改写到本地假引擎；其它外网地址一律抛错（测试不联网是**强制**的）。 */
  const fetchImpl = (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url ?? String(input);
    const url = new URL(raw);
    if (ENGINE_HOSTS.test(url.hostname)) return fetch(`${origin}/search?${url.searchParams.toString()}`, init);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return fetch(raw, init);
    throw new Error(`测试不该访问外网：${raw}`);
  };
  /** 这一轮真正发出去过的**检索词**（同一查询可能试多个引擎，所以要去重）。 */
  const queries = () =>
    [
      ...new Set(
        hits
          .map((search) => {
            const params = new URLSearchParams(search.replace(/^\?/, ''));
            return params.get('q') ?? params.get('query') ?? params.get('wd') ?? '';
          })
          .filter(Boolean),
      ),
    ];
  return {
    hits,
    queries,
    fetchImpl,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 起后端；`ai` 切片直接透传给 createServer（apiKey/baseUrl/searchFetch 都从这里进去）。 */
async function startApp(ai) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-runtime-'));
  const app = await createServer({ dataDir, ...(ai ? { ai } : {}) });
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
  return { app, info, call };
}

/** 把 WS 上收到过的某类事件按顺序取出来。 */
const eventsOf = (ws, type) => ws.messages.filter((message) => message.type === type);

/* ------------------------------------------------------------------ 停止 */

test('停止：流到一半按停止 → HTTP stopped:true、消息落库 stopped（保留半截正文）、上游只调一次、WS 收到 chat_stopped', async () => {
  // 够长的回答：一个字一块 × 25ms，保证"停止"发生在流的中途而不是结尾
  const FULL = '这是一段会一个字一个字慢慢吐出来的回答，用来验证中途停止到底留住了什么。'.repeat(2);
  const mock = await startSlowAi({ replies: [FULL], chunkDelayMs: 25 });
  const { app, info, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  const ws = await connectWs({ port: info.port });
  try {
    // 不 await：这条请求会一直挂着，直到被停止 —— 它就是"正在跑的回合"
    const pending = call('POST', '/ai/chat', { text: '随便讲一段', stream: true });
    // 等到真的开始吐字（此刻 conversationId / messageId 都已经是稳定的）
    const delta = await ws.waitFor((message) => message.type === 'ai_delta' && message.payload?.delta);
    const { conversationId, messageId } = delta.payload;
    assert.ok(conversationId && messageId, '增量广播里必须带会话与消息 id');
    // 再多吐几个字，确保落库的正文非空
    await sleep(120);

    const stopped = await call('POST', '/ai/chat/stop', { conversationId });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.ok, true);
    assert.equal(stopped.body.stopped, true);
    assert.equal(stopped.body.conversationId, conversationId);
    assert.equal(stopped.body.messageId, messageId, '停止要指向那一条正在生成的消息');

    // 契约：同时通过既有 WebSocket 广播 chat_stopped
    const event = await ws.waitFor((message) => message.type === 'chat_stopped', 3000);
    assert.deepEqual(event.payload, { conversationId, messageId });

    // /ai/chat 自己也要正常结束（不是 500），并且明确告诉调用方"这条被停了"
    const chat = await pending;
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.stopped, true);
    assert.equal(chat.body.assistant.status, 'stopped');

    // 落库：状态、正文（停止前已生成的部分）、停止时间
    const detail = await call('GET', `/ai/conversations/${conversationId}`);
    const assistant = detail.body.messages.find((item) => item.id === messageId);
    assert.ok(assistant, '被停止的消息必须还在库里（不能整条删掉）');
    assert.equal(assistant.status, 'stopped');
    assert.ok(assistant.content.length > 0, '停止前已经生成的那部分正文必须留着');
    assert.ok(FULL.startsWith(assistant.content), `正文应是停止前已生成的那一段，实际：${assistant.content}`);
    assert.ok(assistant.content.length < FULL.length, '不该是完整回答');
    assert.ok(assistant.stoppedAt, '要写上 stoppedAt');
    assert.equal(chat.body.assistant.status, 'stopped', '不许把半截回答当成正常完成');

    // 被中断的那条 assistant 消息**只有一条**，而且是 stopped —— 没有"继续下一轮"的痕迹
    const assistants = detail.body.messages.filter((item) => item.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal(mock.state.calls, 1, '停止之后不许再调用上游（没有继续下一轮）');
  } finally {
    ws.close();
    await app.close();
    await mock.close();
  }
});

test('停止：没有在跑的回合 → stopped:false + reason:idle，且不是 500', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '（本用例不该调用模型）' });
  const { app, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  try {
    const created = await call('POST', '/ai/conversations', { title: '空闲会话' });
    const conversationId = created.body.conversation.id;

    const idle = await call('POST', '/ai/chat/stop', { conversationId });
    assert.equal(idle.status, 200, '空闲停止不是错误，绝不能 500');
    assert.deepEqual(idle.body, { ok: true, stopped: false, reason: 'idle' });

    // 未知会话同样是 idle（前端可能拿着一份过期的 id 来点停止）
    const unknown = await call('POST', '/ai/chat/stop', { conversationId: 'conv-does-not-exist' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.stopped, false);

    // 真的没给会话 id 才是 400：那是请求本身不完整，不是"没有在跑的回合"
    const missing = await call('POST', '/ai/chat/stop', {});
    assert.equal(missing.status, 400);
    assert.equal(mock.state.calls, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* -------------------------------------------------------------- 检索预算 */

test('检索预算：连续搜不到时回灌"第 N 次 / 还剩 M 次 + 三条建议"，用尽后不再发请求并回灌 SEARCH_RETRY_EXHAUSTED', async () => {
  const webQuery = (query) => `我再查一下。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query }, explain: '联网查一下' })}`;
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      webQuery('转专业 条件'),
      webQuery('转专业 材料'),
      webQuery('转专业 时间'),
      '这次确实没拿到，建议你直接打开教务处网站的通知栏目看一眼。',
    ],
    reply: '（不该出现的多余轮次）',
  });
  const web = await startFakeWeb({ empty: true });
  const { app, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl, searchFetch: web.fetchImpl });
  try {
    // 预算设成 2：第 3 次检索必然被预算挡住
    const saved = await call('POST', '/ai/config', { searchProvider: 'scrape', searchMaxPages: 5, searchRetryMax: 2 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.searchRetryMax, 2, 'searchRetryMax 要进配置回显');

    const sent = await call('POST', '/ai/chat', { text: '帮我搜一下转专业条件', search: 'web', stream: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));

    const queried = sent.body.queried ?? [];
    assert.equal(queried.length, 3, `三次检索草稿都要有交代，实际 ${queried.length}`);
    assert.equal(queried[0].result?.attempt, 1, '第一次检索要带 attempt');
    assert.equal(queried[0].result?.remaining, 1, '第一次之后还剩 1 次');
    assert.equal(queried[1].result?.remaining, 0, '第二次之后还剩 0 次');
    assert.equal(queried[2].error?.code, 'SEARCH_RETRY_EXHAUSTED', '预算用尽要回灌明确错误码，不能静默丢弃');
    assert.match(queried[2].error.message, /已用完/);

    // 真的只发了两次检索请求：用尽之后**不再执行**新的 web 查询
    assert.deepEqual(web.queries().sort(), ['转专业 材料', '转专业 条件'].sort(), `实际发出去的检索词：${web.queries().join(' | ')}`);

    // 回灌文案：次数、剩余、三条具体建议，一样都不能少
    const fedBack = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(fedBack, /本次检索是第 1 次，还剩 1 次/, '第一次回灌要写清第几次/还剩几次');
    assert.match(fedBack, /本次检索是第 2 次，还剩 0 次/, '第二次回灌同样要写清');
    assert.match(fedBack, /换一组更短、更具体的关键词/);
    assert.match(fedBack, /直接读那个网址/);
    assert.match(fedBack, /如实告诉用户/);
    assert.match(fedBack, /SEARCH_RETRY_EXHAUSTED|联网检索次数已用完/, '预算用尽要明确告诉模型"不会再搜了"');
    assert.match(fedBack, /联网检索预算/, '回灌里要有一段专门的预算说明');
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});

test('检索预算：搜到结果的一次不浪费额度（attempt=1 / remaining=max-1，且不带失败建议）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我查一下。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业 通知' }, explain: '查一下' })}`,
      '查到了，通知里写了申请时间。',
    ],
  });
  const web = await startFakeWeb();
  const { app, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl, searchFetch: web.fetchImpl });
  try {
    await call('POST', '/ai/config', { searchProvider: 'scrape', searchMaxPages: 5, searchRetryMax: 3 });
    const sent = await call('POST', '/ai/chat', { text: '搜一下转专业通知', search: 'web', stream: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));

    const entry = (sent.body.queried ?? [])[0];
    assert.ok(entry?.result, JSON.stringify(sent.body.queried));
    assert.equal(entry.result.attempt, 1, '一次成功只该用掉一次');
    assert.equal(entry.result.remaining, 2, '上限 3，用掉 1 次还剩 2 次');
    assert.ok(entry.result.items.some((item) => item.text), '要真的读到正文');

    const fedBack = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(fedBack, /本次检索是第 1 次，还剩 2 次/);
    assert.doesNotMatch(fedBack, /没有拿到可用结果/, '成功的一次不该出现"失败建议"');
    assert.equal(web.queries().length, 1, '同一条查询不该被搜两遍');
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});

test('配置：searchRetryMax 越界 400、脏值回落默认、环境变量可覆盖', async () => {
  const { app, call } = await startApp();
  try {
    const bad = await call('POST', '/ai/config', { searchRetryMax: 0 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error?.details?.field ?? bad.body.details?.field, 'searchRetryMax');

    const tooBig = await call('POST', '/ai/config', { searchRetryMax: 99 });
    assert.equal(tooBig.status, 400);

    const ok = await call('POST', '/ai/config', { searchRetryMax: 6 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.searchRetryMax, 6);

    const status = await call('GET', '/ai/status');
    assert.equal(status.body.config.searchRetryMax, 6, '/ai/status 的公开配置里也要有它');

    // 三层来源：内置默认 3、环境变量可覆盖、磁盘/手改的脏值静默回落默认
    assert.equal(AI_DEFAULTS.searchRetryMax, 3);
    assert.equal(normalizeAiConfig(aiConfigFromEnv({ PC_AI_SEARCH_RETRY_MAX: '5' })).searchRetryMax, 5);
    assert.equal(normalizeAiConfig(aiConfigFromEnv({ PC_AI_SEARCH_RETRY_MAX: '0' })).searchRetryMax, 3, '越界的脏值回落默认');
    assert.equal(normalizeAiConfig({ searchRetryMax: 99 }).searchRetryMax, 3);
  } finally {
    await app.close();
  }
});

/* ---------------------------------------------------------------- plan */

test('plan：一轮里一条查询 + 一条写入 → 多份全量快照、状态依次推进、最后全部 done', async () => {
  const queryDraft = {
    ok: true,
    action: 'query',
    target: 'schedule',
    filters: { from: DAY, to: DAY },
    explain: '看看今天的日程',
  };
  const writeDraft = {
    ok: true,
    action: 'create',
    target: 'schedule',
    fields: { title: '项目周会', date: DAY, startTime: '14:00', endTime: '15:00' },
    explain: '把周会排进日程',
  };
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`我先看一眼日程，再写进去。\n${fenced(queryDraft)}\n${fenced(writeDraft)}`, '已经写好了。'],
  });
  const { app, info, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  const ws = await connectWs({ port: info.port });
  try {
    const sent = await call('POST', '/ai/chat', { text: '看看今天日程，再把项目周会写进去', permission: 'auto' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));
    await ws.waitFor((message) => message.type === 'ai_message');

    const plans = eventsOf(ws, 'plan');
    assert.ok(plans.length >= 3, `两条草稿应该带来多份 plan 快照，实际 ${plans.length}`);

    // 同一回合内 messageId / conversationId 不变（前端按它们找卡片）
    const messageId = sent.body.assistant.id;
    for (const plan of plans) {
      assert.equal(plan.payload.messageId, messageId);
      assert.equal(plan.payload.conversationId, sent.body.conversation.id);
      assert.equal(plan.payload.steps.length, 2, '每次都是**全量** steps：两条草稿就该有两步');
      assert.deepEqual(
        plan.payload.steps.map((step) => step.id),
        ['q1', 'w1'],
      );
    }
    // 步骤文案：只读查询 → 检索/查询，写入 → 写入/修改/删除
    const labels = plans.at(-1).payload.steps.map((step) => step.label);
    assert.match(labels[0], /^查询/);
    assert.match(labels[0], /日程|2026-10-13/);
    assert.match(labels[1], /^写入/);
    assert.match(labels[1], /项目周会/);
    assert.equal(plans.at(-1).payload.steps[0].target, 'schedule');
    assert.equal(plans.at(-1).payload.steps[1].target, 'schedule');

    // 状态推进：出现过 pending / running，最后一份必须全部是终态
    const statuses = plans.flatMap((plan) => plan.payload.steps.map((step) => step.status));
    assert.ok(statuses.includes('pending'), '要有 pending');
    assert.ok(statuses.includes('running'), '要有 running');
    assert.deepEqual(
      plans.at(-1).payload.steps.map((step) => step.status),
      ['done', 'done'],
      '收尾时全部落成终态，不能留下转圈的步骤',
    );
    // 每一步都真的走到过终态（而不是一直 pending 到收尾才被"算完成"）
    const runningSeen = plans.some((plan) => plan.payload.steps.some((step) => step.status === 'running'));
    assert.equal(runningSeen, true);
  } finally {
    ws.close();
    await app.close();
    await mock.close();
  }
});

test('plan：纯聊天一条草稿都没有 → 一份 plan 都不广播（不给简单问题套假进度条）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '你好，有什么可以帮你的？' });
  const { app, info, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  const ws = await connectWs({ port: info.port });
  try {
    const sent = await call('POST', '/ai/chat', { text: '你好', stream: true });
    assert.equal(sent.status, 200);
    await ws.waitFor((message) => message.type === 'ai_message');
    assert.equal(eventsOf(ws, 'plan').length, 0, '纯聊天不该有 plan');
    assert.equal(sent.body.rounds, 1, '纯聊天一轮就结束');
  } finally {
    ws.close();
    await app.close();
    await mock.close();
  }
});

test('plan：被停止的回合不留下转圈的步骤（最后一份里全部是终态）', async () => {
  const queryDraft = { ok: true, action: 'query', target: 'schedule', filters: { from: DAY, to: DAY }, explain: '看看今天的日程' };
  const mock = await startSlowAi({
    replies: [`我先看一眼日程。\n${fenced(queryDraft)}\n我这就去看。`, '（不该出现的轮次）'],
    chunkDelayMs: 25,
  });
  const { app, info, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  const ws = await connectWs({ port: info.port });
  try {
    const pending = call('POST', '/ai/chat', { text: '看看今天日程', stream: true });
    const delta = await ws.waitFor((message) => message.type === 'ai_delta' && message.payload?.delta);
    await call('POST', '/ai/chat/stop', { conversationId: delta.payload.conversationId });
    const chat = await pending;
    assert.equal(chat.status, 200);
    assert.equal(chat.body.assistant.status, 'stopped');

    const plans = eventsOf(ws, 'plan');
    if (plans.length) {
      const last = plans.at(-1).payload.steps;
      assert.ok(
        last.every((step) => step.status === 'done' || step.status === 'failed'),
        `停止后不能留下 pending/running，实际 ${JSON.stringify(last)}`,
      );
    }
    // 停止之后不再有任何新的 plan 广播（最后一份之后就安静了）
    const chatStopped = await ws.waitFor((message) => message.type === 'chat_stopped');
    assert.ok(chatStopped);
    const planCountAtStop = eventsOf(ws, 'plan').length;
    await sleep(150);
    assert.equal(eventsOf(ws, 'plan').length, planCountAtStop, '停止之后不该再冒出步骤');
  } finally {
    ws.close();
    await app.close();
    await mock.close();
  }
});

/* -------------------------------------------------------------- 消息排队 */

test('排队：同一个会话同时发两条 → 串行执行，消息顺序不乱、上游不会被"抢答"', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    // 每条要 250ms 才回：第二条如果不等第一条，就会先拿到第 2 条回复并先落库
    delayMs: 250,
    replies: ['第一条的完整回答。', '第二条的完整回答。'],
  });
  const { app, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl });
  try {
    const created = await call('POST', '/ai/conversations', { title: '排队' });
    const conversationId = created.body.conversation.id;

    const first = call('POST', '/ai/chat', { text: '第一句', conversationId, stream: false });
    // 等第一条真的跑起来（否则两条都只是排在那里，测不出"串行"）
    await sleep(80);
    const second = call('POST', '/ai/chat', { text: '第二句', conversationId, stream: false });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 200));
    assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 200));
    assert.equal(mock.state.calls, 2);

    // 串行的证据：消息顺序是一问一答、再一问一答（并行的话会是 用户1/用户2/助手2/助手1）
    const detail = await call('GET', `/ai/conversations/${conversationId}`);
    assert.deepEqual(
      detail.body.messages.map((message) => `${message.role}:${message.content}`),
      ['user:第一句', 'assistant:第一条的完整回答。', 'user:第二句', 'assistant:第二条的完整回答。'],
    );
    assert.equal(a.body.assistant.content, '第一条的完整回答。');
    assert.equal(b.body.assistant.content, '第二条的完整回答。');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('停止：联网检索还在路上时按停止 → 立刻收尾，不等检索跑完', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我查一下。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业 通知' } })}`,
      '（停止之后不该再有这一轮）',
    ],
  });
  // 引擎 3 秒后才回：如果停止不能打断"等检索"，这条用例会等满 3 秒
  const web = await startFakeWeb({ delayMs: 3000 });
  const { app, info, call } = await startApp({ apiKey: KEY, baseUrl: mock.baseUrl, searchFetch: web.fetchImpl });
  const ws = await connectWs({ port: info.port });
  try {
    const pending = call('POST', '/ai/chat', { text: '搜一下转专业通知', search: 'web', stream: true });
    // 模型先吐"我查一下。"，脚本块被抽走 → 这一轮结束就会去检索（此刻检索正在路上）
    const delta = await ws.waitFor((message) => message.type === 'ai_delta' && message.payload?.delta);
    await sleep(120);
    const startedAt = Date.now();
    const stopped = await call('POST', '/ai/chat/stop', { conversationId: delta.payload.conversationId });
    assert.equal(stopped.body.stopped, true);
    const chat = await pending;
    const elapsed = Date.now() - startedAt;
    assert.equal(chat.status, 200);
    assert.equal(chat.body.assistant.status, 'stopped');
    assert.ok(elapsed < 1500, `停止不该等检索跑完（等了 ${elapsed}ms，说明 #abortable 没生效）`);
    assert.equal(mock.state.calls, 1, '停止之后不许再调用上游');

    // 停止那一刻要广播**最后一份** steps，而且没跑完的必须是终态（failed），不能留着转圈
    const plans = eventsOf(ws, 'plan');
    assert.ok(plans.length >= 1, `检索草稿要带来 plan 事件，实际收到：${JSON.stringify(ws.messages.map((m) => m.type))}`);
    const lastSteps = plans.at(-1).payload.steps;
    assert.match(lastSteps[0].label, /^检索/);
    assert.deepEqual(lastSteps.map((step) => step.status), ['failed'], '检索被停止 = 这一步没做成，要落成 failed');
  } finally {
    ws.close();
    await app.close();
    await web.close();
    await mock.close();
  }
});
