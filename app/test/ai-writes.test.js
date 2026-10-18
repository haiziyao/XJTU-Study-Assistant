/**
 * AI 写入扩展：`target: category`（日程/事件分类）与 `target: settings`（软件设置白名单）。
 *
 * 覆盖三层：
 *   1. **命令层**：真实走 `/commands/execute`，分类真的落库、设置真的生效；
 *      重名 / 被引用删除 / 白名单外的键都要失败且错误可读。
 *   2. **权限档**：`auto` 档由 chat-service 自动执行；`manual` 只出确认卡、一条都不落库。
 *   3. **提示词**：模型必须知道 `target: category` / `target: settings` 存在，
 *      并且知道“不能改密钥/账号”是硬边界 —— 否则它又会回答“不在我的能力范围里”。
 *
 * 设置部分的断言刻意走 `GET /ai/config` 与 `GET /ui/prefs/:key`：
 * 验证的是“外部可观察的生效”，而不是只相信命令返回值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-1234567890abcd';

async function startApp({ mock } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-writes-'));
  const app = await createServer({ dataDir, version: '0.1.0-test', ai: mock ? { apiKey: KEY, baseUrl: mock.baseUrl } : undefined });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  /** 直接执行一条草稿（确认卡点“确认执行”走的就是这条接口）。 */
  const exec = (draft, dryRun = false) => call('POST', '/commands/execute', { draft, dryRun });
  return { app, call, exec, dataDir };
}

const categoryDraft = (fields, action = 'create', extra = {}) => ({
  ok: true,
  action,
  target: 'category',
  fields,
  ...extra,
});

const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

async function findCategory(call, name, kind = 'schedule') {
  const response = await call('GET', `/categories?kind=${kind}`);
  return response.body.items.find((item) => item.label === name);
}

test('category（auto/命令层）：create / update / delete 真的落库，颜色归一化，query 返回 AI 字段', async () => {
  const { app, call, exec } = await startApp();
  try {
    // create：模型按提示词给 name/color（大写颜色会被 CategoryService 归一成小写）
    const created = await exec(categoryDraft({ name: '竞赛', color: '#F59E0B' }, 'create', { explain: '新建日程分类「竞赛」，橙色' }));
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
    assert.equal(created.body.action, 'create');
    assert.equal(created.body.target, 'category');
    assert.equal(created.body.item.name, '竞赛');
    assert.equal(created.body.item.kind, 'schedule');
    assert.equal(created.body.item.color, '#f59e0b', '颜色要按服务层规则归一成小写 6 位');
    assert.equal(created.body.item.sort, 60, '新建分类排在已有分类之后');
    assert.match(created.body.explain, /已新建日程分类「竞赛」/);
    const id = created.body.item.id;
    assert.ok(id);

    // 真的在分类集合里（不是只回了一个对象）
    assert.equal((await findCategory(call, '竞赛')).id, id);

    // update：按 name 定位（AI 最自然的说法），改色后落库
    const updated = await exec({
      ok: true,
      action: 'update',
      target: 'category',
      filters: { name: '竞赛' },
      fields: { color: '#ef4444' },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body).slice(0, 300));
    assert.equal(updated.body.item.color, '#ef4444');
    assert.equal(updated.body.item.name, '竞赛', '只改颜色时名字不变');
    assert.match(updated.body.explain, /颜色改为 #ef4444/);
    assert.equal((await findCategory(call, '竞赛')).color, '#ef4444');

    // query：AI 投影字段是 name/color/sort/usage，不是服务层的 label/order/inUse
    const queried = await exec({
      ok: true,
      action: 'query',
      target: 'category',
      filters: { kind: 'schedule' },
    });
    assert.equal(queried.status, 200);
    const hit = queried.body.items.find((item) => item.id === id);
    assert.deepEqual(Object.keys(hit).sort(), ['builtin', 'color', 'id', 'kind', 'locked', 'name', 'sort', 'usage']);
    assert.equal(hit.name, '竞赛');
    assert.equal(hit.usage, 0);

    // delete：没有记录引用时可以删，真的从集合里消失
    const deleted = await exec({
      ok: true,
      action: 'delete',
      target: 'category',
      filters: { name: '竞赛' },
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body).slice(0, 300));
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.reassigned, 0);
    assert.equal(await findCategory(call, '竞赛'), undefined);
  } finally {
    await app.close();
  }
});

test('category：重名被拒、被记录引用时删不掉，错误信息可读（默认数据里的「考试」也按重名处理）', async () => {
  const { app, call, exec } = await startApp();
  try {
    // 默认数据里已经有「考试」；再建同名必须失败，并告诉用户改用 update
    const duplicateBuiltin = await exec(categoryDraft({ name: '考试', color: '#f59e0b' }));
    assert.equal(duplicateBuiltin.status, 400);
    assert.match(duplicateBuiltin.body.error.message, /已经有「考试」/);
    assert.match(duplicateBuiltin.body.error.message, /action: "update"/);
    assert.equal(duplicateBuiltin.body.error.details.id, 'exam');

    const created = await exec(categoryDraft({ name: '竞赛', color: '#f59e0b' }));
    assert.equal(created.status, 200);
    const id = created.body.item.id;

    // 同一 kind 重名 → 400
    const duplicate = await exec(categoryDraft({ name: '竞赛', color: '#123456' }));
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error.message, /已经有「竞赛」/);

    // 改名撞上另一个已有分类 → 同样拒绝（不能靠 update 绕过唯一性）
    const other = await exec(categoryDraft({ name: '实验', color: '#5cdb8b' }));
    assert.equal(other.status, 200);
    const renameConflict = await exec({
      ok: true,
      action: 'update',
      target: 'category',
      filters: { name: '竞赛', kind: 'schedule' },
      fields: { name: '实验' },
    });
    assert.equal(renameConflict.status, 400);
    assert.match(renameConflict.body.error.message, /已经有「实验」/);

    // 不同 kind 可以同名（日程分类 / 事件分类本来就是两套）；不带 kind 时按名字定位会要求说清楚
    const eventCreated = await exec(categoryDraft({ name: '竞赛', color: '#c792ea', kind: 'event' }));
    assert.equal(eventCreated.status, 200);
    const ambiguous = await exec({
      ok: true,
      action: 'update',
      target: 'category',
      filters: { name: '竞赛' },
      fields: { color: '#000000' },
    });
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error.message, /找到 2 个同名分类/);
    assert.match(ambiguous.body.error.message, /filters.kind/);

    // 被日程引用 → 不能删（AI 不沿用 REST 的“静默改派到 other”）
    const schedule = await call('POST', '/schedules', {
      title: '竞赛辅导',
      date: '2030-01-07',
      startTime: '08:00',
      category: id,
    });
    assert.equal(schedule.status, 201);
    const rejected = await exec({
      ok: true,
      action: 'delete',
      target: 'category',
      filters: { name: '竞赛', kind: 'schedule' },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /还有 1 条记录在用/);
    assert.match(rejected.body.error.message, /不能删除/);
    // 记录还在，分类也还在（没有被偷偷改派）
    assert.equal((await call('GET', `/schedules/${schedule.body.item.id}`)).body.item.category, id);
    assert.equal((await findCategory(call, '竞赛')).id, id);

    // 没被引用的事件分类可以正常删除
    const removedEvent = await exec({
      ok: true,
      action: 'delete',
      target: 'category',
      filters: { name: '竞赛', kind: 'event' },
    });
    assert.equal(removedEvent.status, 200);
    assert.equal(await findCategory(call, '竞赛', 'event'), undefined);
  } finally {
    await app.close();
  }
});

test('settings：白名单内生效并回显；白名单外（apiKey/account）400 SETTING_NOT_WRITABLE，且不部分写入', async () => {
  const { app, call, exec } = await startApp();
  try {
    const before = await call('GET', '/ai/config');
    assert.equal(before.body.config.permission, 'manual', '默认权限是 manual');
    assert.equal(before.body.config.searchProvider, 'auto');

    // 凭据/账号：永远不能由 AI 写
    for (const fields of [{ apiKey: 'sk-should-never-be-written' }, { account: 'someone' }, { searchApiKey: 'sk-x' }, { password: 'x' }]) {
      const rejected = await exec({ ok: true, action: 'update', target: 'settings', fields });
      assert.equal(rejected.status, 400, `${JSON.stringify(fields)} 必须被拒`);
      assert.equal(rejected.body.error.code, 'SETTING_NOT_WRITABLE');
      assert.match(rejected.body.error.message, /不能由 AI 修改/);
      assert.match(rejected.body.error.message, /密钥/);
    }

    // 混合了合法键与非法键：整条拒绝，合法键也不能偷偷写进去（原子性）
    const mixed = await exec({
      ok: true,
      action: 'update',
      target: 'settings',
      fields: { permission: 'auto', apiKey: 'sk-nope' },
    });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'SETTING_NOT_WRITABLE');
    assert.equal((await call('GET', '/ai/config')).body.config.permission, 'manual', '被拒的草稿不能留下半截修改');
    assert.equal((await call('GET', '/ai/config')).body.config.hasKey, false);

    // 合法值越界仍然按既有设置校验报 400
    const badRange = await exec({ ok: true, action: 'update', target: 'settings', fields: { searchMaxPages: 99 } });
    assert.equal(badRange.status, 400);
    assert.match(badRange.body.error.message, /5–30/);
    const badPermission = await exec({ ok: true, action: 'update', target: 'settings', fields: { permission: 'root' } });
    assert.equal(badPermission.status, 400);
    assert.match(badPermission.body.error.message, /auto \/ manual \/ strict/);

    // 合法更新：permission 落 uiprefs、AI 配置落 ai-config.json，两边都回显
    const saved = await exec({
      ok: true,
      action: 'update',
      target: 'settings',
      fields: { permission: 'auto', searchProvider: 'brave', searchMaxPages: 12, searchRetryMax: 4, contextWindow: 99_999, theme: 'dark' },
      explain: '把默认权限改成自动审批',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 500));
    assert.deepEqual(saved.body.changed.sort(), ['contextWindow', 'permission', 'searchMaxPages', 'searchProvider', 'searchRetryMax', 'theme']);
    assert.deepEqual(saved.body.ignored, []);
    assert.match(saved.body.explain, /默认写入权限/);
    assert.match(saved.body.explain, /不再逐条确认/);
    assert.ok(saved.body.warnings.some((text) => /不再逐条确认/.test(text)), 'permission=auto 必须带危险警告');

    const after = await call('GET', '/ai/config');
    assert.equal(after.body.config.permission, 'auto');
    assert.equal(after.body.config.searchProvider, 'brave');
    assert.equal(after.body.config.searchMaxPages, 12);
    assert.equal(after.body.config.searchRetryMax, 4);
    assert.equal(after.body.config.contextWindow, 99_999);
    assert.equal((await call('GET', '/ui/prefs/permission')).body.value, 'auto');
    assert.equal((await call('GET', '/ui/prefs/theme')).body.value, 'dark');

    // 已经是这个值：changed 为空、ignored 如实列，不谎报“改了”
    const again = await exec({ ok: true, action: 'update', target: 'settings', fields: { permission: 'auto' } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.changed, []);
    assert.deepEqual(again.body.ignored, ['permission']);
    assert.match(again.body.explain, /没有变化/);
  } finally {
    await app.close();
  }
});

test('真实链路：auto 档 mock 上游返回 category + settings 草稿 → 自动执行并落库', async () => {
  const drafts = [
    { ok: true, action: 'create', target: 'category', fields: { name: '竞赛', color: '#f59e0b' }, explain: '新建竞赛分类' },
    { ok: true, action: 'update', target: 'settings', fields: { permission: 'auto', searchProvider: 'brave' }, explain: '改默认权限和搜索服务' },
  ];
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`好，这两件我办一下。\n${drafts.map(fenced).join('\n')}`, '两件都办好了。'],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', { text: '建个竞赛分类，再把默认权限改成自动、搜索换成 brave', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));

    assert.equal(chat.body.executed.length, 2, JSON.stringify(chat.body.executed?.map((entry) => entry.draft.target)));
    assert.deepEqual(chat.body.executed.map((entry) => entry.draft.target).sort(), ['category', 'settings']);
    assert.deepEqual(chat.body.drafts, [], 'auto 档不留确认卡');
    // 写操作要回灌一轮，模型才能按真实结果收尾
    assert.equal(mock.state.bodies.length, 2);

    // 分类真的建了
    const category = await findCategory(call, '竞赛');
    assert.ok(category, 'category 草稿必须真的落进 scheduleCategories');
    assert.equal(category.color, '#f59e0b');

    // 配置真的变了（GET 回显是外部可观察的口径）
    const config = (await call('GET', '/ai/config')).body.config;
    assert.equal(config.permission, 'auto');
    assert.equal(config.searchProvider, 'brave');

    // 系统注入里带上了两条写操作的结果，模型下一轮才有依据
    const injected = String(mock.state.bodies[1]?.messages?.at(-1)?.content ?? '');
    assert.match(injected, /\[系统注入\]/);
    assert.match(injected, /竞赛/);
    assert.match(injected, /brave/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('真实链路：auto 档的 category update / delete 也自动执行（改色 → 删除，按草稿顺序）', async () => {
  const drafts = [
    { ok: true, action: 'update', target: 'category', filters: { name: '竞赛', kind: 'schedule' }, fields: { color: '#ef4444' } },
    { ok: true, action: 'delete', target: 'category', filters: { name: '竞赛', kind: 'schedule' } },
  ];
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`好，我改完再删。\n${drafts.map(fenced).join('\n')}`, '改完也删掉了。'],
    reply: '（不该出现的多余轮次）',
  });
  const { app, call } = await startApp({ mock });
  try {
    // 先在同一个数据目录里经 REST 建一个分类，再看 AI 的 update / delete 是否真的走自动执行
    const created = await call('POST', '/categories', { kind: 'schedule', label: '竞赛', color: '#111111' });
    assert.equal(created.status, 201);
    const id = created.body.item.id;

    const chat = await call('POST', '/ai/chat', { text: '把竞赛分类改成红色，然后删掉它', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.equal(chat.body.executed.length, 2, JSON.stringify(chat.body.executed));
    const [updated, deleted] = chat.body.executed;
    assert.equal(updated.draft.action, 'update');
    assert.equal(updated.result.item.color, '#ef4444', 'update 真的改了颜色');
    assert.equal(deleted.draft.action, 'delete');
    assert.equal(deleted.result.deleted, true);
    assert.equal(await findCategory(call, '竞赛'), undefined, 'delete 后分类真的没了');
    assert.equal((await call('GET', `/categories/${id}?kind=schedule`)).status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('真实链路：manual 档同样的草稿只出确认卡，分类/配置一条都不落库', async () => {
  const drafts = [
    { ok: true, action: 'create', target: 'category', fields: { name: '竞赛', color: '#f59e0b' }, explain: '新建竞赛分类' },
    { ok: true, action: 'update', target: 'settings', fields: { permission: 'auto', searchProvider: 'brave' }, explain: '改默认权限和搜索服务' },
  ];
  const mock = await startMockAi({ apiKey: KEY, replies: [`好，我准备这样改。\n${drafts.map(fenced).join('\n')}`], reply: '（不该出现的多余轮次）' });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', { text: '建个竞赛分类，再把默认权限改成自动', permission: 'manual' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.deepEqual(chat.body.executed, [], 'manual 档不执行任何写入');
    assert.equal(chat.body.drafts.length, 2, JSON.stringify(chat.body.drafts?.map((entry) => entry.draft.target)));

    for (const entry of chat.body.drafts) {
      assert.equal(entry.error, null, JSON.stringify(entry.error));
      assert.equal(entry.preview.dryRun, true);
    }

    // 确认卡上必须能看见危险项警告：渲染层读的是 draft.explain / draft.warnings
    const settingsEntry = chat.body.drafts.find((entry) => entry.draft.target === 'settings');
    assert.match(settingsEntry.draft.explain, /不再逐条确认/);
    assert.ok(settingsEntry.draft.warnings.some((text) => /不再逐条确认/.test(text)));

    // 一条都没落库
    assert.equal(await findCategory(call, '竞赛'), undefined);
    const config = (await call('GET', '/ai/config')).body.config;
    assert.equal(config.permission, 'manual');
    assert.equal(config.searchProvider, 'auto');
    assert.equal(mock.state.bodies.length, 1, 'manual 档只出草稿，不该多跑回灌轮');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('真实链路：模型想新建默认数据里已有的「考试」→ 确认卡上直接给出可读的拒绝原因', async () => {
  const draft = { ok: true, action: 'create', target: 'category', fields: { name: '考试', color: '#f59e0b' }, explain: '新建考试分类' };
  const mock = await startMockAi({ apiKey: KEY, replies: [`好。\n${fenced(draft)}`], reply: 'x' });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', { text: '新建个日程分类名为考试，用橙色表示', permission: 'manual' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.drafts.length, 1);
    assert.equal(chat.body.drafts[0].error.code, 'BAD_REQUEST');
    assert.match(chat.body.drafts[0].error.message, /已经有「考试」/);
    assert.match(chat.body.drafts[0].error.message, /action: "update"/);
    // 预览阶段就失败 → 没有落库，也没有确认按钮
    assert.equal((await call('GET', '/categories?kind=schedule')).body.items.filter((item) => item.label === '考试').length, 1);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('提示词：声明 target: category / target: settings，并写死“不能改密钥/账号”', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好。' });
  const { app, call } = await startApp({ mock });
  try {
    await call('POST', '/ai/chat', { text: '你好', permission: 'auto' });
    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.equal(mock.state.bodies[0].messages[0].role, 'system');

    // 三处硬断言（任务书要求）
    assert.match(system, /target: category/);
    assert.match(system, /target: settings/);
    assert.match(system, /不能改密钥\/账号/);

    // 三个 category 草稿示例 + 一个 settings 草稿示例真的在提示词里
    assert.match(system, /"target":"category"/);
    assert.match(system, /"filters":\{"name":"考试"\}/);
    assert.match(system, /"permission":"auto"/);
    // 关键规则：重名、被引用删不掉、白名单错误码、改设置前说明行为变化
    assert.match(system, /分类名在同一个 kind 内不能重复/);
    assert.match(system, /被日程\/事件引用的分类删不掉/);
    assert.match(system, /SETTING_NOT_WRITABLE/);
    assert.match(system, /改设置前先说明会改变什么行为/);
    // 旧版“分类不在能力范围”的说法必须消失
    assert.doesNotMatch(system, /分类的创建不在我的能力范围/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('分类查询回灌：AI 看到的是 name/sort/usage（module.js 的 aiQueryFields.category 生效）', async () => {
  const queryDraft = { ok: true, action: 'query', target: 'category', filters: { kind: 'schedule' } };
  const mock = await startMockAi({ apiKey: KEY, replies: [`我查一下。\n${fenced(queryDraft)}`, '你有一个「考试」分类。'], reply: 'x' });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', { text: '我有哪些日程分类', permission: 'manual' });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.queried.length, 1);
    const injected = String(mock.state.bodies[1]?.messages?.at(-1)?.content ?? '');
    assert.match(injected, /"name":"考试"/);
    assert.match(injected, /"sort":/);
    assert.match(injected, /"usage":/);
    assert.doesNotMatch(injected, /"label":/, '回灌不要泄露服务层字段名');
  } finally {
    await app.close();
    await mock.close();
  }
});
