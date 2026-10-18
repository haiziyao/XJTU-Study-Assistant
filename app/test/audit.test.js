/**
 * 更改日志（audit）的端到端测试。
 *
 * 覆盖四类“坏了用户会直接发现”的行为：
 *   1. **谁改的**：用户经 HTTP 建待办 → actor:'user'；AI 自动执行草稿 → actor:'ai'；
 *   2. **不会无限长大**：5000 条上限丢最旧、文件 0600、limit 最多 500；
 *   3. **不会泄露凭据**：password / apiKey / token / cookie 落盘只有 `***`；
 *   4. **AI 能读、不能改**：只读 target `log` 能查最近记录，删除/修改动作会被拒绝。
 *
 * 全部用真实后端 + 临时 dataDir（端口 0），不访问外网；AI 用本地 mock 上游。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-audit-test-123456';

async function startApp({ ai } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-audit-'));
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
  return {
    app,
    info,
    call,
    dataDir,
    filePath: path.join(dataDir, 'audit-log.json'),
    audit: app.services.audit,
    async close() {
      await app.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    },
  };
}

const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

// ---------------------------------------------------------------- 装配 / 用户写入

test('audit 模块：order 6、紧跟 auth；用户经 HTTP 建待办后出现 actor:user 的日志', async () => {
  const ctx = await startApp();
  try {
    const listed = await ctx.call('GET', '/modules');
    const audit = (listed.body.items ?? []).find((item) => item.id === 'audit');
    assert.ok(audit, 'audit 模块要出现在 /modules 里');
    assert.equal(audit.title, '更改日志');
    assert.equal(audit.order, 6, 'order 6 = 紧跟 auth(5) 之后，早于 calendar(10)');
    assert.ok(audit.hooks.includes('createServices'));
    assert.ok(audit.hooks.includes('registerRoutes'));

    const created = await ctx.call('POST', '/todos', { title: '审计：用户新建待办', deadline: '2026-10-20' });
    assert.equal(created.status, 201);
    const id = created.body.item.id;

    const logs = await ctx.call('GET', '/audit/log?actor=user');
    assert.equal(logs.status, 200);
    const entry = logs.body.items.find((item) => item.targetId === id);
    assert.ok(entry, '用户经 HTTP 的写入必须留下日志');
    assert.equal(entry.actor, 'user');
    assert.equal(entry.module, 'todo');
    assert.equal(entry.action, 'create');
    assert.equal(entry.title, '审计：用户新建待办');
    assert.equal(entry.source, 'api');
    assert.equal(entry.after?.title, '审计：用户新建待办');
    assert.equal(entry.after?.deadline, '2026-10-20');
    // 整条待办（description / tags 等）不抄进日志，只留关键字段
    assert.equal(entry.after?.body, undefined);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- AI 写入

test('AI 自动执行写草稿后出现 actor:ai / source:chat 的一条日志（且不冒充用户）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `好的，加上。\n${fenced({
        ok: true,
        action: 'create',
        target: 'todo',
        fields: { title: 'AI 写入的待办', deadline: '2026-10-21' },
        explain: '把这条待办加上',
      })}`,
      '已经加好了。',
    ],
  });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    const chat = await ctx.call('POST', '/ai/chat', { text: '帮我加一条 AI 写入的待办', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.executed?.length, 1);

    const aiLogs = await ctx.call('GET', '/audit/log?actor=ai');
    const entry = aiLogs.body.items.find((item) => item.title === 'AI 写入的待办');
    assert.ok(entry, 'AI 自动执行的写入必须出现 actor:ai 的日志');
    assert.equal(entry.source, 'chat');
    assert.equal(entry.module, 'todo');
    assert.equal(entry.action, 'create');
    assert.ok(entry.targetId, '日志要带真实记录 id，便于追到是哪一条');
    assert.equal(entry.after?.deadline, '2026-10-21');

    // 同一笔写入不能被服务端再记成一条“用户”的（actor 判定方案的核心断言）
    const userLogs = await ctx.call('GET', '/audit/log?actor=user');
    assert.equal(
      userLogs.body.items.filter((item) => item.targetId === entry.targetId).length,
      0,
      'AI 的写入不该同时冒充用户写入',
    );
  } finally {
    await ctx.close();
    await mock.close();
  }
});

// ---------------------------------------------------------------- 裁剪 / 分页 / since

test('record 后立即 stop()：同步落盘，不依赖 200ms 定时器（close 不 await stop 的兜底）', async () => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-audit-stop-'));
  try {
    const { AuditService } = await import('../src/modules/audit/service.js');
    const audit = new AuditService({ dataDir });
    audit.record({ actor: 'system', module: 'test', action: 'settings', title: '停机前最后一条' });
    audit.stop();
    const items = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'audit-log.json'), 'utf8'));
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '停机前最后一条');
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});

test('裁剪：写 6000 条只保留最新 5000 条，且文件是裸 JSON 数组、权限 0600', async () => {
  const ctx = await startApp();
  try {
    for (let index = 1; index <= 6000; index += 1) {
      ctx.audit.record({
        actor: 'system',
        module: 'test',
        action: 'create',
        targetId: `t-${index}`,
        title: `第 ${index} 条`,
      });
    }
    const flushed = await ctx.audit.flush();
    assert.equal(flushed.total, 5000);

    const raw = await fs.promises.readFile(ctx.filePath, 'utf8');
    const items = JSON.parse(raw);
    assert.ok(Array.isArray(items), 'audit-log.json 必须是裸 JSON 数组（不是 {items} 包装）');
    assert.equal(items.length, 5000);
    assert.equal(items[0].title, '第 1001 条', '超出上限要丢最旧');
    assert.equal(items.at(-1).title, '第 6000 条');

    const mode = (await fs.promises.stat(ctx.filePath)).mode & 0o777;
    assert.equal(mode, 0o600, '日志文件必须是 0600');
  } finally {
    await ctx.close();
  }
});

test('分页：limit 最大 500；offset 可取剩余；since 只返回该时刻之后的记录', async () => {
  const ctx = await startApp();
  try {
    for (let index = 0; index < 520; index += 1) {
      ctx.audit.record({
        actor: 'user',
        module: 'todo',
        action: 'update',
        targetId: `todo-${index}`,
        title: `分页 ${index}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString(),
      });
    }
    await ctx.audit.flush();

    const capped = await ctx.call('GET', '/audit/log?limit=1000');
    assert.equal(capped.status, 200);
    assert.equal(capped.body.limit, 500, 'limit 超过 500 要夹到 500');
    assert.equal(capped.body.items.length, 500);
    assert.equal(capped.body.total, 520);
    assert.equal(capped.body.hasMore, true);

    const next = await ctx.call('GET', '/audit/log?limit=500&offset=500');
    assert.equal(next.body.items.length, 20);
    assert.equal(next.body.hasMore, false);

    // 2026-01-01T00:08:20Z 起只剩最后 20 条（index 500..519）
    const since = await ctx.call('GET', '/audit/log?since=2026-01-01T00:08:20Z&limit=500');
    assert.equal(since.body.total, 20, 'since 过滤要按时间比较，不是按字符串前缀');
    assert.ok(since.body.items.every((item) => item.at >= '2026-01-01T00:08:20.000Z'));

    const bad = await ctx.call('GET', '/audit/log?actor=robot');
    assert.equal(bad.status, 400, '非法 actor 要 400，而不是静默返回全部');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 打码

test('敏感字段打码：password / apiKey / token / cookie 落盘只写 ***，原值不出现', async () => {
  const ctx = await startApp();
  try {
    ctx.audit.record({
      actor: 'user',
      module: 'account',
      action: 'settings',
      title: '修改账号设置',
      summary: 'password=super-secret token=tok-live-123 sk-summary-abcdef',
      before: {
        title: '旧设置',
        password: 'p@ssw0rd-旧',
        apiKey: 'sk-live-abcdef',
        token: 'tok-live-123',
        cookie: 'session=abc123',
        body: '整篇正文不该进日志',
      },
      after: {
        title: '新设置',
        password: 'p@ssw0rd-新',
        apiKey: 'sk-live-xyz',
        accessToken: 'access-xyz',
      },
    });
    await ctx.audit.flush();

    const raw = await fs.promises.readFile(ctx.filePath, 'utf8');
    for (const secret of [
      'p@ssw0rd-旧',
      'p@ssw0rd-新',
      'sk-live-abcdef',
      'sk-live-xyz',
      'tok-live-123',
      'session=abc123',
      'access-xyz',
      'super-secret',
      'sk-summary-abcdef',
      '整篇正文不该进日志',
    ]) {
      assert.ok(!raw.includes(secret), `落盘内容不能包含敏感原值：${secret}`);
    }
    assert.match(raw, /"\*\*\*"/, '敏感字段应落成 ***');

    const logs = await ctx.call('GET', '/audit/log');
    const entry = logs.body.items[0];
    assert.equal(entry.before?.password, '***');
    assert.equal(entry.before?.apiKey, '***');
    assert.equal(entry.before?.body, undefined, 'before/after 只存关键字段');
    assert.equal(entry.after?.accessToken, '***');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- AI 读取

test('AI 能通过只读 target log 查最近记录；不能删除/修改日志', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/todos', { title: '供 AI 查日志的待办', deadline: '2026-10-22' });

    const queried = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'log', filters: { actor: 'user', limit: 5 }, explain: '查最近的更改' },
    });
    assert.equal(queried.status, 200, JSON.stringify(queried.body).slice(0, 300));
    assert.equal(queried.body.target, 'log');
    assert.ok(queried.body.items.length >= 1);
    const item = queried.body.items.find((entry) => entry.title === '供 AI 查日志的待办');
    assert.ok(item);
    for (const key of ['at', 'actor', 'module', 'action']) assert.ok(item[key], `AI 查询结果要带 ${key}`);

    const descriptor = ctx.app.modules.find((module) => module.id === 'audit');
    assert.deepEqual(descriptor.aiQueryFields.log, ['at', 'actor', 'module', 'action', 'targetId', 'title', 'summary']);
    assert.match(descriptor.aiPrompt, /你之前改过什么/);
    assert.match(descriptor.aiPrompt, /只读/);
    assert.ok(ctx.app.services.commands.targets.includes('log'));

    for (const action of ['delete', 'update', 'create']) {
      const denied = await ctx.call('POST', '/commands/execute', {
        draft: { ok: true, action, target: 'log', filters: { id: item.id } },
      });
      assert.equal(denied.status, 400, `AI 不能对日志执行 ${action}`);
      assert.match(denied.body.error.message, /不支持 action/);
    }

    // AI 读取工具是只读的，且能力清单里不存在删除日志的工具
    const capabilities = await ctx.call('GET', '/ai/capabilities');
    const tool = capabilities.body.aiTools.find((entry) => entry.name === 'audit_log_query');
    assert.ok(tool);
    assert.equal(tool.mutates, false);
    assert.ok(!capabilities.body.aiTools.some((entry) => entry.name === 'audit_log_delete'));
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 视图源码

test('「消息」视图已改名为「日志」并读 /audit/log（源码级断言）', async () => {
  const source = await fs.promises.readFile(new URL('../src/renderer/shell/message.js', import.meta.url), 'utf8');
  assert.match(source, /title: '日志'/);
  assert.match(source, /label: '日志'/);
  assert.match(source, /icon: 'clock'/);
  assert.match(source, /\/audit\/log/);
  assert.doesNotMatch(source, /\/commands\/logs/);
  for (const text of ['全部', '只看 AI', '只看我', '只看系统', '刷新', '还没有任何更改记录']) {
    assert.ok(source.includes(text), `日志视图应包含「${text}」`);
  }
  // CSP 禁 inline style：视图里不能写 style="..." / style 属性
  assert.doesNotMatch(source, /\sstyle\s*=/);
});
