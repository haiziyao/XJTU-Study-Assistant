/**
 * 「AI 一轮最多执行几个操作」（`maxActionsPerTurn`）的契约测试。
 *
 * 背景：这个上限以前只写在**提示词**里（"一轮最多 3 条写入草稿"），服务端一轮给几条就执行几条。
 * 提示词是"请求"，不是"事实" —— 模型完全可以一口气给 5 条，于是用户设了 3 也可能被自动改 5 处。
 * 现在它有三层：
 *   1. 配置（默认 3 / 1–50 / 0 = 不限制，越界 400）；
 *   2. 提示词（N 与配置**同源**，0 与 N>0 两套措辞，不做字符串替换）；
 *   3. 服务端真正执行（auto 档只执行前 N 条，其余留成待确认卡 + 回灌里说明）。
 *
 * 测试全部打本地 mock 上游，不联网、不花钱。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import {
  AI_DEFAULTS,
  MAX_ACTIONS_MAX,
  aiConfigFromEnv,
  assertAiConfigInput,
  maskAiConfig,
  normalizeAiConfig,
} from '../src/modules/ai/config.js';
import { buildChatSystemPrompt } from '../src/modules/ai/prompt.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-actions-0001';
const DAY = '2026-10-13';

async function startApp({ mock, maxActionsPerTurn } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-actions-'));
  const ai = { apiKey: KEY, baseUrl: mock.baseUrl };
  if (maxActionsPerTurn !== undefined) ai.maxActionsPerTurn = maxActionsPerTurn;
  const app = await createServer({ dataDir, ai });
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

/** 把几条草稿拼成一段模型回复（正文 + 多个代码块）。 */
const withDrafts = (drafts, lead = '这几件我都记上。') => `${lead}\n${drafts.map(fenced).join('\n')}`;

/** 五条互不相同的待办草稿（标题不同 = 业务指纹不同 = 都该独立处理）。 */
const FIVE_TODOS = ['A 交实验报告', 'B 复习高数', 'C 写课程论文', 'D 准备英语六级', 'E 整理笔记'].map((title, index) => ({
  ok: true,
  action: 'create',
  target: 'todo',
  fields: { title, deadline: `2026-10-${16 + index}` },
  explain: `记下${title}`,
}));

/** 最后一条注入消息（回灌）的正文：模型这一轮到底看到了什么。 */
const injectedOf = (body) => String(body?.messages?.at(-1)?.content ?? '');

/* ============================================================ 1) 配置 */

test('配置：maxActionsPerTurn 默认 3、0 合法（不限制）、1–50 合法、越界 400', async () => {
  // 默认值：与"设置项出现之前提示词里写死的 3"一致，用户不动设置时行为不变
  assert.equal(AI_DEFAULTS.maxActionsPerTurn, 3);
  assert.equal(normalizeAiConfig({}).maxActionsPerTurn, 3);
  assert.equal(MAX_ACTIONS_MAX, 50);

  // 归一化：0 不被当成"脏值"回落默认；1 与 50 是边界；小数取整
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 0 }).maxActionsPerTurn, 0, '0 表示不限制，必须保留');
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 1 }).maxActionsPerTurn, 1);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 50 }).maxActionsPerTurn, 50);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 7 }).maxActionsPerTurn, 7);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: '7' }).maxActionsPerTurn, 7);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: '0' }).maxActionsPerTurn, 0, '表单/环境变量传字符串也要认');
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 7.9 }).maxActionsPerTurn, 7);

  // 磁盘 / 环境变量里的脏值静默回落默认（不能因此让服务起不来）
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 51 }).maxActionsPerTurn, 3);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: -1 }).maxActionsPerTurn, 3);
  assert.equal(normalizeAiConfig({ maxActionsPerTurn: 'abc' }).maxActionsPerTurn, 3);

  // 环境变量 PC_AI_MAX_ACTIONS_PER_TURN
  assert.equal(normalizeAiConfig(aiConfigFromEnv({ PC_AI_MAX_ACTIONS_PER_TURN: '7' })).maxActionsPerTurn, 7);
  assert.equal(normalizeAiConfig(aiConfigFromEnv({ PC_AI_MAX_ACTIONS_PER_TURN: '0' })).maxActionsPerTurn, 0);
  assert.equal(normalizeAiConfig(aiConfigFromEnv({ PC_AI_MAX_ACTIONS_PER_TURN: '99' })).maxActionsPerTurn, 3, '越界脏值回落默认');

  // 用户输入那条路径必须严格：0 / 1 / 50 通过，其余（含小数、负数、51）一律 400
  assert.doesNotThrow(() => assertAiConfigInput({ maxActionsPerTurn: 0 }));
  assert.doesNotThrow(() => assertAiConfigInput({ maxActionsPerTurn: 1 }));
  assert.doesNotThrow(() => assertAiConfigInput({ maxActionsPerTurn: 50 }));
  for (const bad of [-1, 51, 1.5, 'abc', true]) {
    assert.throws(
      () => assertAiConfigInput({ maxActionsPerTurn: bad }),
      (error) => {
        assert.equal(error.status, 400, `收到 ${bad} 时必须是 400`);
        assert.equal(error.details?.field, 'maxActionsPerTurn');
        assert.match(error.message, /0（不限制）|必须是整数|必须是数字/);
        return true;
      },
    );
  }

  // mask / publicConfig 回显：密钥之外的配置项该带出来
  const masked = maskAiConfig(normalizeAiConfig({ maxActionsPerTurn: 9 }));
  assert.equal(masked.maxActionsPerTurn, 9);
  assert.equal(maskAiConfig(normalizeAiConfig({})).maxActionsPerTurn, 3);
});

test('配置：GET /ai/config 回显该字段，POST 越界 400、0 可保存，/ai/status 同步', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好。' });
  const { app, call } = await startApp({ mock, maxActionsPerTurn: 5 });
  try {
    const got = await call('GET', '/ai/config');
    assert.equal(got.status, 200);
    assert.equal(got.body.config.maxActionsPerTurn, 5, 'GET /ai/config 要回显当前值');

    const saved = await call('POST', '/ai/config', { maxActionsPerTurn: 0 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.maxActionsPerTurn, 0, '0 = 不限制，必须原样回显');

    const again = await call('GET', '/ai/config');
    assert.equal(again.body.config.maxActionsPerTurn, 0);

    const status = await call('GET', '/ai/status');
    assert.equal(status.body.config.maxActionsPerTurn, 0, '/ai/status 的公开配置里也要有它');

    const tooBig = await call('POST', '/ai/config', { maxActionsPerTurn: 51 });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error?.details?.field, 'maxActionsPerTurn');

    const negative = await call('POST', '/ai/config', { maxActionsPerTurn: -1 });
    assert.equal(negative.status, 400);

    const ok = await call('POST', '/ai/config', { maxActionsPerTurn: 50 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.maxActionsPerTurn, 50);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ============================================================ 2) 提示词 */

test('提示词：3 / 7 生成"最多 N 条"，0 生成"任意多条 / 不限制"，且不再写死 3', () => {
  const prompt = (maxActionsPerTurn) => buildChatSystemPrompt({ maxActionsPerTurn, permission: 'auto' });

  const three = prompt(3);
  assert.match(three, /一轮最多给 3 条写入草稿/);
  assert.match(three, /超过 3 件/);
  assert.match(three, /写入最多 3 段/);
  assert.doesNotMatch(three, /一轮最多给 7 条写入草稿/);

  const seven = prompt(7);
  assert.match(seven, /一轮最多给 7 条写入草稿/);
  assert.match(seven, /超过 7 件/);
  assert.match(seven, /写入最多 7 段/);
  assert.doesNotMatch(seven, /一轮最多给 3 条写入草稿/, '提示词里不许残留写死的 3');

  const zero = prompt(0);
  assert.match(zero, /一轮里可以给出任意多条写入草稿/);
  assert.match(zero, /不限制/);
  assert.match(zero, /写入段数不限/);
  assert.doesNotMatch(zero, /一轮最多给 \d+ 条写入草稿/, '0 = 不限制时不能再出现"最多 N 条"');

  // 不传 context 时用默认 3（旧行为不变）
  assert.match(buildChatSystemPrompt({}), /一轮最多给 3 条写入草稿/);

  // manual 档那句"多件事给多张草稿"的条数也要跟着配置走
  assert.match(buildChatSystemPrompt({ maxActionsPerTurn: 7, permission: 'manual' }), /最多 7 条/);
  assert.match(buildChatSystemPrompt({ maxActionsPerTurn: 0, permission: 'manual' }), /条数不限/);
});

/* ============================================================ 3) auto 档真正执行 */

test('auto 档：一轮 5 条写入 + 上限 3 → 只执行前 3 条，另 2 条进 drafts 并在回灌/回执里说明', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [withDrafts(FIVE_TODOS), '三件已经自动办好了；另外两件超出本轮上限，等你确认后我再办。'],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock, maxActionsPerTurn: 3 });
  try {
    const chat = await call('POST', '/ai/chat', {
      text: '帮我记五件事：交实验报告、复习高数、写课程论文、准备英语六级、整理笔记',
      permission: 'auto',
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));

    // 只执行前 3 条（顺序 = 模型输出顺序 = 用户说话顺序）
    assert.equal(chat.body.executed.length, 3, `上限 3 只能执行 3 条，实际 ${chat.body.executed.length}`);
    assert.deepEqual(
      chat.body.executed.map((entry) => entry.result?.item?.title),
      FIVE_TODOS.slice(0, 3).map((draft) => draft.fields.title),
    );
    assert.equal((await call('GET', '/todos')).body.items.length, 3, '库里只能落下 3 条');

    // 另外 2 条**没丢**：留在 drafts 里走人工确认卡（manual 语义）
    assert.equal(chat.body.drafts.length, 2, `超出的 2 条要留在 drafts，实际 ${chat.body.drafts.length}`);
    assert.deepEqual(
      chat.body.drafts.map((entry) => entry.draft?.fields?.title),
      FIVE_TODOS.slice(3).map((draft) => draft.fields.title),
    );
    for (const entry of chat.body.drafts) {
      assert.equal(entry.error, null, `草稿本身是合法的：${JSON.stringify(entry.error)}`);
      assert.match(
        entry.draft.warnings.join('\n'),
        /超出.*上限|没有自动执行/,
        `确认卡上要说明为什么没执行：${JSON.stringify(entry.draft.warnings)}`,
      );
    }

    // 机读回执：设了 3、执行 3、截下 2
    assert.deepEqual(chat.body.actionLimit, { max: 3, unlimited: false, executed: 3, deferred: 2 });
    assert.deepEqual(chat.body.assistant.actionLimit, { max: 3, unlimited: false, executed: 3, deferred: 2 });

    // 回灌（模型下一轮看到的那条系统注入）里必须说"还有 2 条没执行"
    assert.equal(mock.state.bodies.length, 2, '执行掉写操作后要回灌一轮');
    const injected = injectedOf(mock.state.bodies[1]);
    assert.match(injected, /\[系统注入\]/);
    assert.match(injected, /还有 2 条写入草稿\*\*没有执行\*\*/);
    assert.match(injected, /超出本轮上限/);
    assert.match(injected, /D 准备英语六级/);
    assert.match(injected, /E 整理笔记/);

    // 提示词里给的也是 3（与真正执行同一个值）
    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.match(system, /一轮最多给 3 条写入草稿/);

    // 模型按注入改口，正文不再谎报"五件全办好了"
    assert.match(chat.body.assistant.content, /另外两件超出本轮上限/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auto 档：上限 0 = 不限制 → 5 条全部执行、drafts 为空；提示词也换成"任意多条"', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [withDrafts(FIVE_TODOS), '五件都办好了。'],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock, maxActionsPerTurn: 0 });
  try {
    const chat = await call('POST', '/ai/chat', { text: '这五件都帮我记上', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.executed.length, 5, `不限制时 5 条都要执行，实际 ${chat.body.executed.length}`);
    assert.deepEqual(chat.body.drafts, [], '全部执行掉就不该再留确认卡');
    assert.deepEqual(chat.body.actionLimit, { max: 0, unlimited: true, executed: 5, deferred: 0 });
    assert.equal((await call('GET', '/todos')).body.items.length, 5);

    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.match(system, /一轮里可以给出任意多条写入草稿/);
    assert.match(system, /不限制/);
    assert.doesNotMatch(system, /一轮最多给 \d+ 条写入草稿/);

    const injected = injectedOf(mock.state.bodies[1]);
    assert.doesNotMatch(injected, /没有执行/, '全部执行时不该出现"没执行"的说明');
    assert.equal(mock.state.bodies.length, 2, '五条在同一轮执行完 → 只多一轮回灌');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ============================================================ 4) 去重 / manual 档 */

test('去重仍生效：上限 0 时重复草稿只执行一次；上限 2 时按去重后的顺序执行前 2 条', async () => {
  // ① 不限制 + 轮内重复：A A B C D → 只落 4 条，A 不会执行两次
  const dupMock = await startMockAi({
    apiKey: KEY,
    replies: [withDrafts([FIVE_TODOS[0], FIVE_TODOS[0], FIVE_TODOS[1], FIVE_TODOS[2], FIVE_TODOS[3]]), '办好了。'],
    reply: '（不该出现的多余轮次）',
  });
  const first = await startApp({ mock: dupMock, maxActionsPerTurn: 0 });
  try {
    const chat = await first.call('POST', '/ai/chat', { text: '记几件事', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.executed.length, 4, `重复的一条只能执行一次，实际 ${chat.body.executed.length}`);
    const titles = chat.body.executed.map((entry) => entry.result?.item?.title);
    assert.equal(new Set(titles).size, 4, `不能落重复记录：${JSON.stringify(titles)}`);
    assert.equal((await first.call('GET', '/todos')).body.items.length, 4);
  } finally {
    await first.app.close();
    await dupMock.close();
  }

  // ② 上限 2 + 轮内重复：去重后是 A B C D，执行 A B、留下 C D
  const limitedMock = await startMockAi({
    apiKey: KEY,
    replies: [withDrafts([FIVE_TODOS[0], FIVE_TODOS[0], FIVE_TODOS[1], FIVE_TODOS[2], FIVE_TODOS[3]]), '前两件办好了，后面两件等你确认。'],
    reply: '（不该出现的多余轮次）',
  });
  const second = await startApp({ mock: limitedMock, maxActionsPerTurn: 2 });
  try {
    const chat = await second.call('POST', '/ai/chat', { text: '记几件事', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.executed.length, 2, '上限 2，执行 2 条');
    assert.deepEqual(
      chat.body.executed.map((entry) => entry.result?.item?.title),
      [FIVE_TODOS[0].fields.title, FIVE_TODOS[1].fields.title],
      '去重后再截断，顺序与模型输出一致',
    );
    assert.equal(chat.body.drafts.length, 2, '去重后剩下的 2 条留成确认卡');
    assert.deepEqual(
      chat.body.drafts.map((entry) => entry.draft?.fields?.title),
      [FIVE_TODOS[2].fields.title, FIVE_TODOS[3].fields.title],
    );
    assert.equal((await second.call('GET', '/todos')).body.items.length, 2);
  } finally {
    await second.app.close();
    await limitedMock.close();
  }
});

test('manual 档不受执行上限约束：上限 2 也给 5 张确认卡、一条都不执行', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: [withDrafts(FIVE_TODOS)] });
  const { app, call } = await startApp({ mock, maxActionsPerTurn: 2 });
  try {
    const chat = await call('POST', '/ai/chat', { text: '这五件都帮我记上', permission: 'manual' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.executed.length, 0, 'manual 档一条都不自动执行');
    assert.equal(chat.body.drafts.length, 5, '确认卡列表不截断：用户自己决定点哪几张');
    for (const entry of chat.body.drafts) {
      assert.equal(entry.error, null);
      assert.doesNotMatch((entry.draft.warnings ?? []).join('\n'), /超出.*上限|没有自动执行/, 'manual 档不该出现"被上限截断"的提示');
    }
    assert.deepEqual(chat.body.actionLimit, { max: 2, unlimited: false, executed: 0, deferred: 0 });
    assert.equal((await call('GET', '/todos')).body.items.length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ============================================================ 5) 跨轮累计 */

test('auto 档：上限按**整个回合**累计（不是每轮各给一份），第二轮多给的写草稿只留确认卡', async () => {
  const firstThree = FIVE_TODOS.slice(0, 3);
  const lastTwo = FIVE_TODOS.slice(3);
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      withDrafts(firstThree),
      withDrafts(lastTwo, '还有两件也记上。'),
      '前三件办好了，后两件超出本轮上限，等你确认。',
    ],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock, maxActionsPerTurn: 3 });
  try {
    const chat = await call('POST', '/ai/chat', { text: '帮我记五件事', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    // 第一轮用满 3 个名额；第二轮即便模型又给 2 条，也不再自动执行
    assert.equal(chat.body.executed.length, 3, `整个回合最多执行 3 条，实际 ${chat.body.executed.length}`);
    assert.equal(chat.body.drafts.length, 2, '第二轮的两条留成确认卡');
    assert.deepEqual(
      chat.body.drafts.map((entry) => entry.draft?.fields?.title),
      lastTwo.map((draft) => draft.fields.title),
    );
    assert.deepEqual(chat.body.actionLimit, { max: 3, unlimited: false, executed: 3, deferred: 2 });
    assert.equal((await call('GET', '/todos')).body.items.length, 3);

    // 第二轮被截断后仍然回灌了一轮，模型据此改口（三轮调用：写 3 → 截 2 → 收尾）
    assert.equal(mock.state.bodies.length, 3);
    assert.match(injectedOf(mock.state.bodies[2]), /还有 2 条写入草稿\*\*没有执行\*\*/);
    assert.match(chat.body.assistant.content, /后两件超出本轮上限/);
  } finally {
    await app.close();
    await mock.close();
  }
});
