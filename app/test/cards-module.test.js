/**
 * 卡片模块的集成测试：真起一个后端（临时 dataDir，端口 0），把 REST、指令、AI 扩展点
 * 与"从笔记生成"的整条链路走一遍。**不访问外网**（全部请求打在 127.0.0.1 的临时实例上）。
 *
 * 为什么这些必须在真实后端上测（而不是只测服务层）：
 *   1. **路由契约**：状态码（201/200/400/404）、`counts` 的统计口径、`/cards/due` 与
 *      `?due=1` 是否真的等价 —— 这些是界面与定时唤醒真正依赖的东西，服务层对了但路由
 *      包错了照样是坏的；
 *   2. **生成链路**：卡片要读**笔记模块的服务**（不是直连集合），所以"笔记写进去 →
 *      生成出卡片 → 再生成一次不重复"必须跨模块跑一遍；
 *   3. **指令链路**：模型不会直接调 REST，它出的是 `{"action":"query","target":"card"}`
 *      这样的草稿，而"今天要复习哪些卡片"这句中文还会和日历的兜底解析器抢靶
 *      （日历对任何中文都能给出 0.9 的草稿）—— 只有走真实的 CommandService 才测得到；
 *   4. **AI 扩展点**：`/ai/capabilities` 里 `mutates` 标错一个，外部 Agent 就会以为
 *      写卡片不用确认。这条只有装配之后才看得见。
 *
 * 时钟可注入：所有断言都基于固定时刻（本地 2026-03-05 09:00）与"把钟往前拨"，
 * 而不是等一天 —— 排期相关的用例因此完全可复现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { toDateKey } from '../src/shared/time.js';
import { buildChatSystemPrompt } from '../src/modules/ai/prompt.js';

/** 固定的"现在"（本地时间，不写 Z，避免被时区推走）。 */
const FIXED = new Date('2026-03-05T09:00:00');

/**
 * 起一个真实后端（端口 0），返回 `call(method, route, body)` 与一个**可拨动的时钟**。
 *
 * `cards.now` 是模块级选项（`createServer({ cards: { now } })`）：复习排期与到期队列
 * 都读它，因此"复习完 → 今天不再出现 → 拨到明天 → 又出现"可以在毫秒内验证完。
 */
async function startApp({ now = FIXED } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-cards-http-'));
  const clock = { value: new Date(now) };
  const app = await createServer({ dataDir, cards: { now: () => new Date(clock.value) } });
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
    clock,
    dataDir,
    /** 造一张卡并返回它（省掉每个用例重复写 4 行）。 */
    async add(input) {
      const created = await call('POST', '/cards', input);
      assert.equal(created.status, 201, `建卡失败：${JSON.stringify(created.body)}`);
      return created.body.item;
    },
    async close() {
      await app.close();
      // `maxRetries`：并行开发的 transfer 模块（`transfer-log.json`）会在装配之后
      // 异步写自己的私有文件，正好撞上删临时目录时会 ENOTEMPTY。这里重试就够了 ——
      // 目标只是别在系统临时目录里留垃圾，而 ENOENT/ENOTEMPTY 都不是本模块的问题。
      await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** 笔记正文：标题+内容、问句+答案、列表项+子项 三种结构各来一条，再加一个待办复选框。 */
const NOTE_BODY = [
  '# 数据结构',
  '',
  '## 二叉树的遍历',
  '前序遍历的顺序是「根 → 左 → 右」。',
  '',
  '图的最短路径算法有哪些？',
  'Dijkstra 与 Bellman-Ford。',
  '',
  '- 中序遍历：左 → 根 → 右',
  '- 后序遍历：',
  '  - 先左子树',
  '  - 再右子树',
  '  - 最后根',
  '',
  '- [ ] 复习第三章',
  '',
].join('\n');

async function addNote(ctx, extra = {}) {
  const created = await ctx.call('POST', '/notes', {
    title: '数据结构笔记',
    tags: ['数据结构'],
    properties: { course: '数据结构' },
    body: NOTE_BODY,
    ...extra,
  });
  assert.equal(created.status, 201);
  return created.body.summary.id;
}

// ---------------------------------------------------------------- 装配

test('卡片：模块出现在 /modules，集合落 data/cards.json，空库统计全 0', async () => {
  const ctx = await startApp();
  try {
    const listed = await ctx.call('GET', '/modules');
    const descriptor = (listed.body.items ?? []).find((item) => item.id === 'cards');
    assert.ok(descriptor, 'cards 模块要在 /modules 里');
    assert.equal(descriptor.title, '复习卡片');
    assert.equal(descriptor.order, 46, 'order=46：排在 notes(40) 之后、ai(90) 之前');
    assert.deepEqual(descriptor.collections, ['cards']);
    assert.ok(ctx.app.store.cards.filePath.endsWith('cards.json'), '落盘文件必须是 cards.json');
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));

    const list = await ctx.call('GET', '/cards');
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 0);
    assert.deepEqual(list.body.counts, { total: 0, due: 0, suspended: 0, todayReviewed: 0 });
    assert.deepEqual(list.body.filters, {
      due: null,
      course: null,
      tag: null,
      noteId: null,
      suspended: null,
      q: null,
      limit: 50,
      offset: 0,
    });

    const stats = await ctx.call('GET', '/cards/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.total, 0);
    assert.equal(stats.body.byDay.length, 7, '未来 7 天（含今天）');
    assert.deepEqual(stats.body.byCourse, []);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- CRUD 与校验

test('卡片：POST 201 / 校验 400 / PATCH 与 DELETE 的 404', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/cards', {
      front: '  什么是熵？  ',
      back: '混乱度的度量',
      course: '热力学',
      tags: ['热力学', '热力学', '  '],
      noteId: 'note-x',
    });
    assert.equal(created.status, 201);
    const item = created.body.item;
    assert.equal(item.front, '什么是熵？', '前后空白要去掉');
    assert.deepEqual(item.tags, ['热力学'], '标签去重、空标签丢弃');
    assert.equal(item.noteId, 'note-x');
    assert.equal(item.course, '热力学');
    assert.equal(item.source, 'manual', '手工建卡默认 source=manual');
    assert.equal(item.suspended, false);
    assert.equal(item.due, FIXED.toISOString(), '新卡立刻进入今天的队列');
    assert.equal(item.intervalDays, 0);
    assert.equal(item.ease, 2.5);
    assert.equal(item.reps, 0);
    assert.equal(item.lapses, 0);
    assert.equal(item.lastReviewedAt, null);
    assert.equal(item.lastGrade, null);
    assert.ok(item.createdAt && item.updatedAt);

    // 单条读取：列表是分页的，详情不能依赖"那张卡刚好在已加载的这一页里"
    const one = await ctx.call('GET', `/cards/${item.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.item.id, item.id);
    assert.equal(one.body.item.front, '什么是熵？');
    assert.equal((await ctx.call('GET', '/cards/does-not-exist')).status, 404);
    // `/cards/stats` 与 `/cards/due` 不能被 `:id` 抢走（路由按注册顺序匹配）
    assert.equal((await ctx.call('GET', '/cards/stats')).body.total, 1);
    assert.equal((await ctx.call('GET', '/cards/due')).body.count, 1);

    // ---- 校验：字段级 400
    assert.equal((await ctx.call('POST', '/cards', { back: '只有答案' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards', { front: '只有问题' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards', { front: '   ', back: 'x' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards', { front: 'x'.repeat(501), back: 'y' })).status, 400, '正面上限 500');
    assert.equal((await ctx.call('POST', '/cards', { front: 'x', back: 'y'.repeat(2001) })).status, 400, '答案上限 2000');
    assert.equal((await ctx.call('POST', '/cards', { front: 'x', back: 'y', source: 'model' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards', { front: 'x', back: 'y', tags: 'not-an-array' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards', ['nope'])).status, 400, '请求体必须是 JSON 对象');

    // ---- PATCH：只允许改 front / back / tags / course / suspended
    const patched = await ctx.call('PATCH', `/cards/${item.id}`, {
      front: '熵是什么？',
      back: '混乱度的度量（单位 J/K）',
      tags: ['热力学', '物理'],
      course: '热力学基础',
      suspended: true,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.item.front, '熵是什么？');
    assert.equal(patched.body.item.back, '混乱度的度量（单位 J/K）');
    assert.deepEqual(patched.body.item.tags, ['热力学', '物理']);
    assert.equal(patched.body.item.course, '热力学基础');
    assert.equal(patched.body.item.suspended, true);
    assert.equal(patched.body.item.id, item.id, 'id 与 createdAt 不变');

    const cheat = await ctx.call('PATCH', `/cards/${item.id}`, { intervalDays: 999, due: '2099-01-01T00:00:00Z' });
    assert.equal(cheat.status, 400, '调度状态只能由复习评分推进（否则一张卡可以被改成永不出现）');
    assert.equal((await ctx.call('PATCH', `/cards/${item.id}`, {})).status, 400);
    assert.equal((await ctx.call('PATCH', '/cards/does-not-exist', { front: 'x' })).status, 404);

    // ---- DELETE
    const removed = await ctx.call('DELETE', `/cards/${item.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.id, item.id);
    assert.equal((await ctx.call('DELETE', `/cards/${item.id}`)).status, 404);
    assert.equal((await ctx.call('GET', '/cards?noteId=note-x')).body.count, 0);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 到期队列与筛选

test('卡片：due=1 队列、counts 不受筛选影响、暂停卡不进队列', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.add({ front: '二叉树的遍历顺序', back: '根 → 左 → 右', course: '数据结构', tags: ['树'] });
    const second = await ctx.add({ front: 'Dijkstra 的适用条件', back: '边权非负', course: '数据结构' });
    const third = await ctx.add({ front: 'P 与 NP 的关系', back: '未解之谜', course: '算法' });

    const due = await ctx.call('GET', '/cards?due=1');
    assert.equal(due.status, 200);
    assert.equal(due.body.count, 3);
    assert.equal(due.body.counts.total, 3);
    assert.equal(due.body.filters.due, true);

    // counts 是"整个库"的统计：按课程筛选之后 total/due 一个都不能变
    const filtered = await ctx.call('GET', '/cards?course=算法');
    assert.equal(filtered.body.count, 1);
    assert.equal(filtered.body.items[0].id, third.id);
    assert.equal(filtered.body.counts.total, 3, 'counts 不受筛选影响');
    assert.equal(filtered.body.counts.due, 3);
    assert.equal(filtered.body.filters.course, '算法');

    // 暂停：不进到期队列，但仍在总数里、且能被 ?suspended=1 找到
    await ctx.call('PATCH', `/cards/${third.id}`, { suspended: true });
    const afterPark = await ctx.call('GET', '/cards?due=1');
    assert.equal(afterPark.body.count, 2, '暂停卡不进到期队列');
    assert.equal(afterPark.body.counts.total, 3);
    assert.equal(afterPark.body.counts.suspended, 1);
    const parked = await ctx.call('GET', '/cards?suspended=1');
    assert.equal(parked.body.count, 1);
    assert.equal(parked.body.items[0].id, third.id);
    assert.equal((await ctx.call('GET', '/cards?suspended=0')).body.count, 2);

    // 标签 / 关键词 / 分页
    assert.equal((await ctx.call('GET', '/cards?tag=树')).body.count, 1);
    assert.equal((await ctx.call('GET', `/cards?q=${encodeURIComponent('非负')}`)).body.count, 1, '答案也能搜到');
    assert.equal((await ctx.call('GET', '/cards?limit=1')).body.items.length, 1);
    assert.equal((await ctx.call('GET', '/cards?limit=1&offset=1')).body.items[0].id, second.id);

    // 非法查询参数一律 400（静默回落默认值会让界面以为"一共就这么多"）
    assert.equal((await ctx.call('GET', '/cards?limit=abc')).status, 400);
    assert.equal((await ctx.call('GET', '/cards?limit=0')).status, 400);
    assert.equal((await ctx.call('GET', '/cards?limit=9999')).status, 400);
    assert.equal((await ctx.call('GET', '/cards?due=maybe')).status, 400);
    assert.equal((await ctx.call('GET', '/cards?offset=-1')).status, 400);

    assert.equal(first.id === second.id, false);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 复习推进排期

test('卡片：review 推进 due（四档不同）、/cards/due 与 ?due=1 等价、非法 grade 400', async () => {
  const ctx = await startApp();
  try {
    const good = await ctx.add({ front: 'good 卡', back: '答案' });
    const again = await ctx.add({ front: 'again 卡', back: '答案' });
    const hard = await ctx.add({ front: 'hard 卡', back: '答案' });
    const easy = await ctx.add({ front: 'easy 卡', back: '答案' });

    const reviewed = await ctx.call('POST', `/cards/${good.id}/review`, { grade: 'good' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.item.intervalDays, 1);
    assert.equal(reviewed.body.nextDue, reviewed.body.item.due, '要显式回一个 nextDue');
    assert.equal(reviewed.body.previousDue, FIXED.toISOString());
    assert.equal(reviewed.body.scheduled.lastGrade, 'good');
    assert.equal(toDateKey(new Date(reviewed.body.nextDue)), '2026-03-06');
    assert.match(reviewed.body.explain, /下次复习/);

    // 复习过就不再出现在"现在到期"里；今天复习过的计数 +1
    const queue = await ctx.call('GET', '/cards?due=1');
    assert.equal(queue.body.count, 3);
    assert.equal(queue.body.counts.todayReviewed, 1);

    // 时钟拨到明天 → 又到期；快捷方式与 ?due=1 必须给出同一批
    ctx.clock.value = new Date('2026-03-06T09:00:00');
    const shortcut = await ctx.call('GET', '/cards/due?limit=5');
    assert.equal(shortcut.status, 200);
    const same = await ctx.call('GET', '/cards?due=1');
    assert.deepEqual(shortcut.body.items.map((item) => item.id), same.body.items.map((item) => item.id));
    assert.equal(shortcut.body.count, same.body.count);

    // 四档各自的间隔
    const failed = await ctx.call('POST', `/cards/${again.id}/review`, { grade: 'again' });
    assert.equal(failed.body.item.intervalDays, 0);
    assert.equal(failed.body.item.ease, 2.3);
    assert.equal(failed.body.item.lapses, 1);
    assert.equal(failed.body.item.reps, 0);
    assert.ok(Date.parse(failed.body.nextDue) > ctx.clock.value.getTime(), 'again 之后有 10 分钟冷却');
    assert.equal(toDateKey(new Date(failed.body.nextDue)), '2026-03-06', '仍然排在今天');

    const hardReviewed = await ctx.call('POST', `/cards/${hard.id}/review`, { grade: 'hard' });
    assert.equal(hardReviewed.body.item.intervalDays, 1);
    assert.equal(hardReviewed.body.item.ease, 2.5);

    const easyReviewed = await ctx.call('POST', `/cards/${easy.id}/review`, { grade: 'easy' });
    assert.equal(easyReviewed.body.item.intervalDays, 4);
    assert.equal(easyReviewed.body.item.ease, 2.65);
    assert.equal(toDateKey(new Date(easyReviewed.body.nextDue)), '2026-03-10');

    // 非法 grade / 不存在的卡
    assert.equal((await ctx.call('POST', `/cards/${good.id}/review`, { grade: 'perfect' })).status, 400);
    assert.equal((await ctx.call('POST', `/cards/${good.id}/review`, {})).status, 400);
    assert.equal((await ctx.call('POST', `/cards/${good.id}/review`, 'good')).status, 400);
    assert.equal((await ctx.call('POST', '/cards/no-such-card/review', { grade: 'good' })).status, 404);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 统计口径

test('卡片：/cards/stats 的口径（今日含逾期、7 天曲线、暂停排除、按课程分组）', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.add({ front: 'A', back: 'aa', course: '数据结构' });
    const second = await ctx.add({ front: 'B', back: 'bb', course: '数据结构' });
    const third = await ctx.add({ front: 'C', back: 'cc', course: '算法' });
    const fourth = await ctx.add({ front: 'D', back: 'dd', course: '算法' });

    await ctx.call('POST', `/cards/${second.id}/review`, { grade: 'good' }); // 明天到期
    await ctx.call('POST', `/cards/${fourth.id}/review`, { grade: 'easy' }); // 4 天后到期
    await ctx.call('PATCH', `/cards/${third.id}`, { suspended: true }); // 暂停

    const stats = (await ctx.call('GET', '/cards/stats')).body;
    assert.equal(stats.days, 7);
    assert.equal(stats.total, 4, '总数含暂停的卡');
    assert.equal(stats.dueNow, 1, '现在能复习的只有 A');
    assert.equal(stats.dueToday, 1);
    assert.equal(stats.suspended, 1);
    assert.equal(stats.reviewedToday, 2, 'B 与 D 今天复习过');
    assert.equal(stats.byDay.length, 7);
    assert.equal(stats.byDay[0].date, toDateKey(FIXED));
    assert.deepEqual(
      stats.byDay.map((day) => day.count),
      [1, 1, 0, 0, 1, 0, 0],
      '今天 A；明天 B；3-09 是 D（easy=4 天）；暂停的 C 不进曲线',
    );
    assert.deepEqual(stats.byCourse, [
      { course: '数据结构', total: 2, due: 1 },
      { course: '算法', total: 2, due: 0 },
    ]);
    assert.ok(stats.generatedAt);

    // 逾期归今天：3 天后 A / B 都过期，仍要出现在"今天"这一格（否则用户以为清完了）
    ctx.clock.value = new Date('2026-03-08T09:00:00');
    const later = (await ctx.call('GET', '/cards/stats')).body;
    assert.equal(later.byDay[0].date, '2026-03-08');
    assert.equal(later.byDay[0].count, 2, '3-05 到期的 A 归进今天');
    assert.equal(later.byDay[1].count, 1, 'B 在 3-06 就到期了，也已逾期 → 归今天');
    assert.equal(later.dueNow, 2);

    assert.equal((await ctx.call('GET', '/cards/stats')).body.total, ctx.app.services.cards.all().length);
    assert.equal(first.course, '数据结构');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 从笔记生成

test('卡片：从笔记生成（三种规则、幂等、按 noteId 过滤、缺参数 400）', async () => {
  const ctx = await startApp();
  try {
    const noteId = await addNote(ctx);

    const generated = await ctx.call('POST', '/cards/generate', { noteId });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.created, 4);
    assert.equal(generated.body.skipped, 0);
    assert.equal(generated.body.ignored, 0);
    assert.equal(generated.body.notes, 1);
    const fronts = generated.body.items.map((item) => item.front);
    assert.deepEqual(fronts, ['二叉树的遍历', '图的最短路径算法有哪些？', '中序遍历', '后序遍历']);
    for (const item of generated.body.items) {
      assert.equal(item.source, 'note');
      assert.equal(item.noteId, noteId);
      assert.equal(item.course, '数据结构', '课程从笔记的 properties.course 带过来');
      assert.deepEqual(item.tags, ['数据结构']);
      assert.equal(item.due, FIXED.toISOString());
      assert.ok(['heading', 'question', 'list'].includes(item.rule), '回执要说明这张卡是抽出来的');
    }

    // 幂等：同一篇笔记再点一次「生成」不会出现第二套卡
    const again = await ctx.call('POST', '/cards/generate', { noteId });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped, 4);
    assert.deepEqual(again.body.items, []);
    assert.equal((await ctx.call('GET', `/cards?noteId=${noteId}`)).body.count, 4);

    // query 路径：按关键词选笔记（选到的还是同一篇 → 全部跳过）
    const byQuery = await ctx.call('POST', '/cards/generate', { query: '数据结构' });
    assert.equal(byQuery.body.notes, 1);
    assert.equal(byQuery.body.created, 0);
    assert.equal(byQuery.body.skipped, 4);

    // 参数校验：既没有 noteId 也没有 query → 400；笔记不存在 → 404
    assert.equal((await ctx.call('POST', '/cards/generate', {})).status, 400);
    assert.equal((await ctx.call('POST', '/cards/generate', { query: '' })).status, 400);
    assert.equal((await ctx.call('POST', '/cards/generate', { noteId: 'no-such-note' })).status, 404);
    assert.equal((await ctx.call('POST', '/cards/generate', { query: '不可能存在的关键词-zzz' })).body.created, 0);

    // 第二篇不同笔记里的同名概念**不算重复**（去重键是 noteId + 正面）
    const other = await addNote(ctx, { title: '另一份笔记', properties: {}, tags: [] });
    const second = await ctx.call('POST', '/cards/generate', { noteId: other });
    assert.equal(second.body.created, 4, '不同笔记各自的「后序遍历」是两件真实的事');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 指令

test('卡片：指令 target card（create/query/update/delete/review）与中文解析器', async () => {
  const ctx = await startApp();
  try {
    // 「加一张卡片：正面？答案」→ 草稿（用户确认前不落库）
    const parsed = await ctx.call('POST', '/commands/parse', {
      text: '加一张卡片：二叉树的遍历顺序是什么？根 → 左 → 右',
    });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.draft.target, 'card');
    assert.equal(parsed.body.draft.action, 'create');
    assert.equal(parsed.body.draft.parser, 'card');
    assert.equal(parsed.body.draft.fields.front, '二叉树的遍历顺序是什么？');
    assert.equal(parsed.body.draft.fields.back, '根 → 左 → 右');
    assert.equal(parsed.body.draft.fields.source, 'manual');
    assert.equal((await ctx.call('GET', '/cards')).body.count, 0, '只解析不写库');

    // 真正落库：`#标签` 也要摘出来
    const run = await ctx.call('POST', '/commands/run', { text: '加一张卡片：熵是什么？混乱度的度量 #热力学' });
    assert.equal(run.status, 200);
    assert.equal(run.body.target, 'card');
    assert.equal(run.body.item.front, '熵是什么？');
    assert.deepEqual(run.body.item.tags, ['热力学']);
    const id = run.body.item.id;

    // 缺少答案时给出警告而不是退化成待办（否则日历兜底会建一条「加一张卡片：熵」）
    const incomplete = await ctx.call('POST', '/commands/parse', { text: '加一张卡片：熵' });
    assert.equal(incomplete.body.draft.target, 'card');
    assert.equal(incomplete.body.draft.fields.back, '');
    assert.ok(incomplete.body.draft.warnings.some((line) => line.includes('缺答案')));
    assert.equal((await ctx.call('POST', '/commands/run', { text: '加一张卡片：熵' })).status, 400, '真的执行时才报缺字段');

    // 只读查询：`due: true` 的草稿会被 AI 自动执行（dryRun 也不写库）
    const query = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'card', filters: { due: true } },
      dryRun: true,
    });
    assert.equal(query.status, 200);
    assert.equal(query.body.count, 1);
    assert.equal(query.body.items[0].id, id);
    assert.equal(query.body.filters.due, true);

    // 「今天要复习哪些卡片」必须被卡片解析器接住（日历兜底对任何中文都给 0.9 的草稿）
    const ask = await ctx.call('POST', '/commands/parse', { text: '今天要复习哪些卡片' });
    assert.equal(ask.body.draft.target, 'card');
    assert.equal(ask.body.draft.action, 'query');
    assert.equal(ask.body.draft.filters.due, true);
    // 普通日程指令不能被卡片解析器抢走
    const schedule = await ctx.call('POST', '/commands/parse', { text: '添加日程 明天 15:00-16:00 项目周会' });
    assert.equal(schedule.body.draft.target, 'schedule');

    // review 是写操作：dryRun 只预览，不推进排期
    const preview = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'review', target: 'card', filters: { id }, fields: { grade: 'good' } },
      dryRun: true,
    });
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.planned.grade, 'good');
    assert.equal((await ctx.call('GET', `/cards?q=${encodeURIComponent('熵是什么')}`)).body.items[0].intervalDays, 0);

    const reviewed = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'review', target: 'card', filters: { id }, fields: { grade: 'good' } },
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.item.intervalDays, 1);
    assert.equal(reviewed.body.nextDue, reviewed.body.item.due);

    // 没有评分 = 拒绝（评分是用户的判断，系统不能替他默认）
    const noGrade = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'review', target: 'card', filters: { id } },
    });
    assert.equal(noGrade.status, 400);
    assert.match(noGrade.body.error.message, /评分/);

    // update：定位用 filters.q，新正面放 fields.front
    const updated = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'update', target: 'card', filters: { q: '熵是什么' }, fields: { front: '熵的定义是什么？' } },
    });
    assert.equal(updated.body.item.front, '熵的定义是什么？');
    assert.equal(updated.body.item.intervalDays, 1, '改正面不动排期');

    // delete
    const deleted = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'card', filters: { id } },
    });
    assert.equal(deleted.status, 200);
    assert.match(deleted.body.explain, /熵/);
    assert.equal((await ctx.call('GET', '/cards')).body.count, 0);

    // 定位不到 / 定位到多张都拒绝
    assert.equal(
      (await ctx.call('POST', '/commands/execute', { draft: { ok: true, action: 'delete', target: 'card', filters: { q: '不存在' } } })).status,
      404,
    );
    await ctx.add({ front: '偏导数是什么？', back: '沿一个方向的变化率' });
    await ctx.add({ front: '偏导数怎么算？', back: '固定其它变量求导' });
    const ambiguous = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'card', filters: { q: '偏导数' } },
    });
    assert.equal(ambiguous.status, 400, '定位到多张时报错让用户说清楚，而不是替他挑一张');
    assert.equal(ambiguous.body.error.details.ids.length, 2);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 定时唤醒与 AI 扩展点

test('卡片：service.dueToday() 给定时唤醒用（含"今天稍后"的卡），与 due=1 语义不同', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.add({ front: 'A', back: 'aa' });
    const second = await ctx.add({ front: 'B', back: 'bb' });

    // A 刚"忘了"→ 排到 10 分钟后：现在还不在 due=1 队列里，但今天之内一定会出现
    await ctx.call('POST', `/cards/${first.id}/review`, { grade: 'again' });
    assert.equal((await ctx.call('GET', '/cards?due=1')).body.count, 1, 'due=1 比 now');
    const dueToday = ctx.app.services.cards.dueToday();
    assert.equal(dueToday.length, 2, 'dueToday() 比"今天结束"，包含今晚还要再来的那张');
    assert.deepEqual(dueToday.map((card) => card.front).sort(), ['A', 'B']);
    assert.equal(ctx.app.services.cards.dueToday({ limit: 1 }).length, 1);

    // 暂停的不算
    await ctx.call('PATCH', `/cards/${second.id}`, { suspended: true });
    assert.deepEqual(ctx.app.services.cards.dueToday().map((card) => card.front), ['A']);

    // 排到明天的也不算
    await ctx.call('POST', `/cards/${first.id}/review`, { grade: 'good' });
    assert.deepEqual(ctx.app.services.cards.dueToday(), []);
    assert.equal((await ctx.call('GET', '/cards')).body.count, 2, 'dueToday() 只读，不改数据');
  } finally {
    await ctx.close();
  }
});

test('卡片：/ai/capabilities 的工具声明与系统提示词注入', async () => {
  const ctx = await startApp();
  try {
    const capabilities = (await ctx.call('GET', '/ai/capabilities')).body;
    const tools = capabilities.aiTools.filter((tool) => tool.module === 'cards');
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), [
      'cards_create',
      'cards_due',
      'cards_generate',
      'cards_query',
      'cards_review',
    ]);
    // mutates 必须如实：读了这份清单，Agent 才知道哪些调用要用户确认
    assert.equal(byName.cards_query.mutates, false);
    assert.equal(byName.cards_due.mutates, false);
    assert.equal(byName.cards_create.mutates, true);
    assert.equal(byName.cards_generate.mutates, true, '生成卡片是会写库的');
    assert.equal(byName.cards_review.mutates, true, '记一次复习会推进排期');
    for (const tool of tools) {
      assert.equal(tool.implemented, true);
      assert.ok(tool.description.length > 10);
      assert.ok(tool.returns && tool.params);
    }

    // 声明的路径必须真的可用：按 cards_review 描述的路径实际操作一次
    const card = await ctx.add({ front: '工具声明自检', back: '路径要真的能用' });
    const reviewPath = byName.cards_review.path.replace(':id', card.id);
    const reviewed = await ctx.call('POST', reviewPath, { grade: 'good' });
    assert.equal(reviewed.status, 200, `工具声明的路径必须可用：${reviewPath}`);
    assert.equal((await ctx.call(byName.cards_due.method, byName.cards_due.path)).status, 200);

    // 字段投影与条数上限：模型回灌时靠它们决定"看得到什么"
    assert.deepEqual(ctx.app.services.ai.queryFields.card, [
      'id',
      'front',
      'back',
      'due',
      'intervalDays',
      'ease',
      'reps',
      'lapses',
      'suspended',
      'lastGrade',
      'course',
      'tags',
      'noteId',
    ]);
    assert.equal(ctx.app.services.ai.queryLimits.card, 8);

    // aiPrompt 真的进了聚合后的系统提示词（否则模型不知道有卡片这个 target）
    const blocks = ctx.app.services.ai.domainBlocks;
    assert.ok(blocks.some((block) => block.includes('【复习卡片与间隔重复】')), 'aiPrompt 要被 ai 模块聚合');
    const prompt = buildChatSystemPrompt({ domainBlocks: blocks });
    assert.ok(prompt.includes('【复习卡片与间隔重复】'));
    assert.ok(prompt.includes('绝不许把"复习"说成"已完成"'), '最关键的一条硬规则必须在提示词里');
  } finally {
    await ctx.close();
  }
});
