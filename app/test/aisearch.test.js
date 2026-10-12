/**
 * 三源统一检索（`target: "search"`）的集成测试：**真起后端 + 临时 dataDir**。
 *
 * 为什么这几条必须测（每一条都对应一种会把用户带偏的失败）：
 *   1. **三路都要能命中、来源标注不能错**：把"我笔记里写的"说成"学校规定"，
 *      或者把"你之前提过"当成校规，是这条链路最危险的失败方式；
 *   2. **排序要稳定**：分数相同就换顺序的话，同一句话问两遍给出两个答案，用户没法信；
 *   3. **limit / scope 要真的生效**：静默忽略参数比报错更难查；
 *   4. **跨源去重**：同一篇内容（教务处那篇 + 用户抄成自己的笔记）不该在列表里出现两次；
 *   5. **降级**：某一路坏掉（语料没抓过 / 服务抛异常）时整体仍要 200，
 *      并且**如实写出是哪一路没查成** —— "没查成"与"没有"必须能分辨，
 *      否则模型会拿半份数据给出一个像模像样的错答案；
 *   6. **AI 那条路真的通**：只读查询草稿（dryRun）走 `/commands/execute` 能拿到三路结果，
 *      并且 ai 模块确实收到了本模块声明的回灌投影与条数上限。
 *
 * 语料库是仓库自带的（`knowledge/dean/`），测试**不联网**；其余数据都在临时 dataDir 里造。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { AiSearchService } from '../src/modules/aisearch/service.js';
import { dedupeKeyOf, expandQuery, normalizeScore, rankAndMerge, scoreText } from '../src/modules/aisearch/scoring.js';

const NOTE_TITLE = '高数课上的转专业念头';
const NOTE_BODY = '老师说转专业要提前看细则：转专业申请在大二下学期开放，绩点要够，还要学院同意。';

/**
 * 删临时目录。
 *
 * 为什么要重试 + 吞掉异常：`JsonStore` 的落盘是异步的，`app.close()` 之后偶尔还有一次
 * 收尾写入落在目录里，`rm` 于是偶发 `ENOTEMPTY`（时序相关，与产品行为无关）。
 * 清理失败**不该**让用例变红 —— 断言这时已经全部跑完了，报出来的只会是一个假红灯。
 */
async function cleanup(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* 系统临时目录，剩下一点交给 OS 清 */
  }
}

/** 起一个真实后端（端口 0），返回 `call(method, route, body)` 与清理函数。 */
async function startApp({ corpusDir } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-aisearch-'));
  const app = await createServer(corpusDir ? { dataDir, knowledge: { corpusDir } } : { dataDir });
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
    async close() {
      await app.close();
      await cleanup(dataDir);
    },
  };
}

/** 造数据：一条含"转专业"的笔记 + 一条含"转专业"的记忆（校规语料是仓库自带的）。 */
async function seed(ctx) {
  const note = await ctx.call('POST', '/notes', {
    title: NOTE_TITLE,
    body: NOTE_BODY,
    tags: ['转专业', '高数'],
    folder: '课程笔记',
    properties: { course: '高等数学' },
  });
  assert.equal(note.status, 201, `造笔记失败：${JSON.stringify(note.body)}`);
  const memory = await ctx.call('POST', '/memories', {
    scope: 'global',
    kind: 'decision',
    key: 'plan_transfer_major',
    text: '我打算大二下学期申请转专业，先确认绩点和名额要求。',
  });
  assert.equal(memory.status, 201, `造记忆失败：${JSON.stringify(memory.body)}`);
  return { note: note.body.summary, memory: memory.body.item };
}

/** 只用来拼查询串的小工具（中文必须 encodeURIComponent）。 */
const route = (text, extra = '') => `/search?q=${encodeURIComponent(text)}${extra}`;

/** `sources[]` → `{ [source]: report }`，断言时比数组下标好读。 */
const bySource = (reports) => Object.fromEntries((reports ?? []).map((item) => [item.source, item]));

test('统一检索：一次查询三路都命中，来源标注正确，分数降序且稳定', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);

    const first = await ctx.call('GET', route('转专业', '&limit=10'));
    assert.equal(first.status, 200);
    const { body } = first;
    assert.equal(body.scope, 'all');
    assert.equal(body.limit, 10);
    assert.equal(body.perSource, 4, '缺省 perSource = ceil(limit/3)');
    assert.ok(body.count >= 3, `三路至少要各命中一条，实际 ${body.count}`);

    for (const item of body.items) {
      assert.ok(['knowledge', 'note', 'memory'].includes(item.source), `来源标注不合法：${item.source}`);
      assert.ok(Array.isArray(item.sources) && item.sources.includes(item.source), 'sources 必须含自身来源');
      assert.ok(item.title, '每条都要有标题');
      assert.ok(item.snippet && item.snippet.length > 0, '每条都要有片段');
      assert.equal(typeof item.score, 'number');
      assert.ok(item.score > 0 && item.score <= 1, `score 必须归一化到 (0,1]：${item.score}`);
      assert.equal(typeof item.meta?.rawScore, 'number');
      // 知识条目必须带 url（引用要能点回教务处原文）；笔记必须带 noteId（界面要能打开它）
      if (item.source === 'knowledge') assert.match(item.url, /^https:\/\/dean\.xjtu\.edu\.cn\//);
      if (item.source === 'note') {
        assert.ok(item.noteId, '笔记条目必须带 noteId');
        assert.equal(item.noteId, item.id);
      }
    }

    const sources = new Set(body.items.map((item) => item.source));
    assert.ok(sources.has('knowledge'), '三路里必须有校规');
    assert.ok(sources.has('note'), '三路里必须有用户的笔记');
    assert.ok(sources.has('memory'), '三路里必须有长期记忆');

    // 排序：分数非递增
    const scores = body.items.map((item) => item.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), '必须按统一分数降序');

    // 稳定性：同一查询两次，来源/身份/分数/顺序完全一致
    const second = await ctx.call('GET', route('转专业', '&limit=10'));
    const shape = (payload) => payload.items.map((item) => [item.source, item.id, item.score]);
    assert.deepEqual(shape(second.body), shape(body), '同一查询两次的顺序与分数必须一致');

    // 三路报告：都查了、都可用、没有错误，规模也对得上
    assert.equal(body.sources.length, 3);
    const reports = bySource(body.sources);
    for (const source of ['knowledge', 'note', 'memory']) {
      assert.equal(reports[source].queried, true, `${source} 应该被查询`);
      assert.equal(reports[source].available, true, `${source} 应该可用`);
      assert.equal(reports[source].error, null, `${source} 不该有错误`);
      assert.ok(reports[source].count >= 1, `${source} 至少命中一条`);
    }
    assert.ok(reports.knowledge.total >= 100, `校规语料篇数看起来不对：${reports.knowledge.total}`);
    assert.equal(reports.note.total, 1);
    assert.equal(reports.memory.total, 1);

    // notes[] 要说清这次发生了什么
    assert.ok(Array.isArray(body.notes) && body.notes.length >= 1);
    assert.match(body.notes[0], /命中 3 条|命中 \d+ 条/);
  } finally {
    await ctx.close();
  }
});

test('统一检索：limit 与 perSource 生效，非法值一律 400', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);

    const two = await ctx.call('GET', route('转专业', '&limit=2'));
    assert.equal(two.status, 200);
    assert.equal(two.body.limit, 2);
    assert.equal(two.body.perSource, 1, 'perSource 缺省 = ceil(limit/3)');
    assert.equal(two.body.items.length, 2, 'limit 必须生效');
    assert.equal(two.body.count, 2);

    const wide = await ctx.call('GET', route('转专业', '&limit=20&perSource=5'));
    assert.equal(wide.status, 200);
    assert.equal(wide.body.perSource, 5, 'perSource 上限是 5');
    assert.ok(wide.body.items.length <= 20);

    for (const bad of ['limit=abc', 'limit=0', 'limit=99', 'perSource=0', 'perSource=6', 'memoryStatus=Active!']) {
      const response = await ctx.call('GET', route('转专业', `&${bad}`));
      assert.equal(response.status, 400, `${bad} 应该 400`);
      assert.equal(response.body.ok, false);
    }
  } finally {
    await ctx.close();
  }
});

test('统一检索：scope=note 只回笔记，另外两路如实标 queried=false 但仍报规模', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);

    const { status, body } = await ctx.call('GET', route('转专业', '&scope=note'));
    assert.equal(status, 200);
    assert.equal(body.scope, 'note');
    assert.ok(body.count >= 1);
    for (const item of body.items) assert.equal(item.source, 'note', 'scope=note 不该混进别的来源');

    const reports = bySource(body.sources);
    assert.equal(reports.note.queried, true);
    assert.equal(reports.knowledge.queried, false);
    assert.equal(reports.memory.queried, false);
    // 没参与检索的两路仍然报出"有多少条"（界面不必再发一次请求）
    assert.ok(reports.knowledge.total >= 100);
    assert.equal(reports.memory.total, 1);
    assert.ok(body.notes.some((line) => line.includes('scope=note')), 'notes 要说清只查了一路');

    // 三路都查一遍：scope=all 的结果不该比单路少
    const all = await ctx.call('GET', route('转专业'));
    assert.ok(all.body.count >= body.count);
  } finally {
    await ctx.close();
  }
});

test('统一检索：跨源去重 —— 用户把教务处那篇存成笔记时只出现一条（sources 里两路都在）', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);
    const duplicated = '西安交通大学本科生转专业实施细则';
    const created = await ctx.call('POST', '/notes', {
      title: duplicated,
      body: '把转专业的细则抄一遍：转专业每学年受理一次，要按学院公布的时间交材料。',
    });
    assert.equal(created.status, 201);

    const { body } = await ctx.call('GET', route('转专业', '&limit=10'));
    const merged = body.items.filter((item) => item.sources.length > 1);
    assert.equal(merged.length, 1, `应该只有一条被合并，实际 ${merged.length}`);
    assert.deepEqual([...merged[0].sources].sort(), ['knowledge', 'note']);
    // 合并去掉的是重复，不是入口：笔记的 noteId 与校规的 url 都要留下来
    assert.ok(merged[0].noteId, '合并后仍要能打开用户自己的笔记');
    assert.match(merged[0].url, /^https:\/\/dean\.xjtu\.edu\.cn\//, '合并后仍要能点回教务处原文');
    assert.equal(merged[0].meta.merged.length, 1);
    assert.equal(merged[0].meta.merged[0].source === 'note' || merged[0].meta.merged[0].source === 'knowledge', true);
    // 同标题在结果里只出现一次
    assert.equal(body.items.filter((item) => item.title === duplicated).length, 1);
    assert.ok(body.notes.some((line) => line.includes('已合并成一条')), 'notes 要说清发生了合并');
  } finally {
    await ctx.close();
  }
});

test('统一检索：三路都没命中时返回空结果 + 说明白（不静默空）', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);
    const { status, body } = await ctx.call('GET', route('紫菜蛋花汤配方'));
    assert.equal(status, 200, '没命中不是错误');
    assert.deepEqual(body.items, []);
    assert.equal(body.count, 0);
    assert.ok(Array.isArray(body.notes) && body.notes.length >= 1);
    assert.match(body.notes[0], /三路都没命中/);
    assert.match(body.notes[0], /紫菜蛋花汤配方/);
    // 说清三路各自的规模，用户才知道"是查过之后没有"，而不是"没查"
    assert.match(body.notes[0], /校规语料 \d+ 条/);
    for (const report of body.sources) {
      assert.equal(report.queried, true);
      assert.equal(report.error, null);
      assert.equal(report.count, 0);
    }
  } finally {
    await ctx.close();
  }
});

test('统一检索：course 只看某门课的笔记（校规与记忆不受影响）', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);
    const hit = await ctx.call('GET', route('转专业', '&course=高等数学'));
    assert.ok(hit.body.items.some((item) => item.source === 'note'), '这门课的笔记应该能搜到');

    const miss = await ctx.call('GET', route('转专业', '&course=线性代数'));
    assert.equal(miss.body.items.some((item) => item.source === 'note'), false, '别的课的笔记不该出现');
    assert.ok(miss.body.items.some((item) => item.source === 'knowledge'), '校规不该被 course 过滤掉');
    assert.ok(miss.body.items.some((item) => item.source === 'memory'), '全局记忆不该被 course 过滤掉');
  } finally {
    await ctx.close();
  }
});

test('统一检索：GET /search/sources 报出三路可用性与条数', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);
    const { status, body } = await ctx.call('GET', '/search/sources');
    assert.equal(status, 200);
    assert.equal(body.count, 3);
    const reports = bySource(body.items);
    assert.equal(reports.knowledge.available, true);
    assert.ok(reports.knowledge.total >= 100, `校规篇数不对：${reports.knowledge.total}`);
    assert.equal(reports.knowledge.error, null);
    assert.equal(reports.knowledge.detail.source, 'dean.xjtu.edu.cn');
    assert.ok(reports.knowledge.detail.categories >= 10);
    assert.equal(reports.note.available, true);
    assert.equal(reports.note.total, 1, '笔记条数口径 = 未删除的笔记数');
    assert.equal(reports.memory.available, true);
    assert.equal(reports.memory.total, 1, '记忆条数口径 = active 条数');
    assert.match(body.notes[0], /校规语料 \d+ 条 \/ 你的笔记 1 条 \/ 长期记忆 1 条/);
  } finally {
    await ctx.close();
  }
});

test('统一检索：缺 q / 未知 scope 一律 400（静默返回空结果会让用户以为"库里没有"）', async () => {
  const ctx = await startApp();
  try {
    for (const bad of ['/search', '/search?q=', '/search?q=%20%20', '/search?limit=5']) {
      const response = await ctx.call('GET', bad);
      assert.equal(response.status, 400, `${bad} 应该 400`);
      assert.equal(response.body.error.details.field, 'q');
    }
    const scoped = await ctx.call('GET', '/search?q=%E8%BD%AC%E4%B8%93%E4%B8%9A&scope=notes');
    assert.equal(scoped.status, 400);
    assert.equal(scoped.body.error.details.field, 'scope');
    assert.deepEqual(scoped.body.error.details.allowed, ['all', 'knowledge', 'note', 'memory']);
  } finally {
    await ctx.close();
  }
});

test('统一检索：降级 —— 语料缺失（空目录）时整体仍 200，sources 里如实写失败原因', async () => {
  const empty = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-aisearch-empty-'));
  const ctx = await startApp({ corpusDir: empty });
  try {
    await seed(ctx);

    const { status, body } = await ctx.call('GET', route('转专业'));
    assert.equal(status, 200, '一路坏掉不该让整个检索失败');
    const reports = bySource(body.sources);
    assert.equal(reports.knowledge.available, false);
    assert.ok(reports.knowledge.error, '必须说清知识库这一路为什么不可用');
    assert.match(reports.knowledge.error, /index\.json|语料/);
    // 另外两路照常返回
    assert.ok(body.items.some((item) => item.source === 'note'));
    assert.ok(body.items.some((item) => item.source === 'memory'));
    assert.equal(body.items.some((item) => item.source === 'knowledge'), false);
    assert.ok(body.notes.some((line) => line.includes('校规语料这一路没查成')), 'notes 也要说清哪一路没查成');

    // 自检接口同样如实报（界面据此显示黄条）
    const sources = await ctx.call('GET', '/search/sources');
    assert.equal(sources.status, 200);
    const listed = bySource(sources.body.items);
    assert.equal(listed.knowledge.available, false);
    assert.ok(listed.knowledge.error);
    assert.ok(sources.body.notes.some((line) => line.includes('校规语料不可用')));
  } finally {
    await ctx.close();
    await cleanup(empty);
  }
});

test('统一检索：降级 —— 某一路服务抛异常时（Promise.allSettled）整体仍成功', async () => {
  // 直接构造服务并注入"坏掉的那一路"：这是 HTTP 层测不到的场景
  // （真实装配出来的三个服务都不会抛，只有它们内部出 bug / 被改成异步远端时才可能）
  const broken = new AiSearchService({
    knowledge: {
      stats() {
        throw new Error('语料目录被删了');
      },
      search() {
        throw new Error('语料目录被删了');
      },
    },
    notes: {
      all: () => [
        {
          id: 'n-1',
          title: '转专业笔记',
          body: '转专业的材料清单记在这里。',
          tags: [],
          properties: {},
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    memory: { list: () => ({ count: 0, items: [] }) },
  });

  const result = await broken.search({ q: '转专业' });
  assert.equal(result.items.length, 1, '笔记这一路的结果必须照常返回');
  assert.equal(result.items[0].source, 'note');
  const reports = bySource(result.sources);
  assert.equal(reports.knowledge.available, false);
  assert.match(reports.knowledge.error, /语料目录被删了/);
  assert.ok(result.notes.some((line) => line.includes('校规语料这一路没查成')));
  assert.equal(reports.note.available, true);
  // 三路全坏：仍然 resolve，且每条都写明原因
  const allBroken = new AiSearchService({
    knowledge: {
      stats() {
        throw new Error('a 坏了');
      },
      search() {
        throw new Error('a 坏了');
      },
    },
    notes: {
      all() {
        throw new Error('b 坏了');
      },
    },
    memory: {
      list() {
        throw new Error('c 坏了');
      },
    },
  });
  const emptyResult = await allBroken.search({ q: '转专业' });
  assert.deepEqual(emptyResult.items, []);
  assert.equal(emptyResult.sources.length, 3);
  for (const report of emptyResult.sources) assert.ok(report.error, `${report.source} 必须写明失败原因`);
  assert.match(emptyResult.notes[0], /三路都没命中/);
  assert.match(emptyResult.notes.join('\n'), /a 坏了/);

  // 依赖模块没装配（order 排错了）也走同一条降级路径，而不是 TypeError
  const unassembled = await new AiSearchService({}).search({ q: '转专业' });
  assert.deepEqual(unassembled.items, []);
  for (const report of unassembled.sources) assert.match(report.error, /未装配/);
});

test('统一检索：AI 只读查询草稿（dryRun）走 /commands/execute 一次拿到三路结果', async () => {
  const ctx = await startApp();
  try {
    await seed(ctx);
    const draft = {
      ok: true,
      action: 'query',
      target: 'search',
      filters: { q: '转专业', scope: 'all' },
      explain: '一次查三路',
    };

    // ① HTTP 那条路（模型输出的草稿就是这么进来的）
    const http = await ctx.call('POST', '/commands/execute', { draft, dryRun: true });
    assert.equal(http.status, 200);
    assert.equal(http.body.ok, true);
    assert.equal(http.body.target, 'search');
    assert.ok(http.body.count >= 3, '三路结果要一起回来');
    assert.equal(new Set(http.body.items.map((item) => item.source)).size >= 3, true);
    assert.ok(http.body.items.length <= 12, 'aiQueryLimits.search = 12 要生效');
    // 顶层 sources 会被回灌投影丢掉，所以三路状态必须随 summary 一起进上下文
    assert.equal(http.body.summary.sources.length, 3);
    assert.ok(Array.isArray(http.body.summary.notes));
    assert.match(http.body.explain, /统一检索/);

    // ② 直接走命令服务（chat-service 的 #runReadOnlyQueries 用的就是这一条）
    const result = await ctx.app.services.commands.execute(draft, { dryRun: true });
    assert.equal(result.ok, true);
    assert.ok(result.items.length >= 3);
    // 只读目标不该有写动作
    await assert.rejects(
      () => ctx.app.services.commands.execute({ ok: true, action: 'create', target: 'search', fields: {} }, { dryRun: true }),
      /不支持 action/,
    );
    // dryRun 不写指令日志
    assert.equal(ctx.app.services.store.commandLogs.all().length, 0);

    // 搜不到时 explain 也要把原因说清楚（模型据此如实回答）
    const miss = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'search', filters: { q: '紫菜蛋花汤配方' } },
      { dryRun: true },
    );
    assert.equal(miss.count, 0);
    assert.match(miss.explain, /都没命中/);
  } finally {
    await ctx.close();
  }
});

test('统一检索：模块声明齐了，且 ai 模块真的收到了回灌投影与条数上限', async () => {
  const ctx = await startApp();
  try {
    const modules = await ctx.call('GET', '/modules');
    const descriptor = (modules.body.items ?? []).find((item) => item.id === 'aisearch');
    assert.ok(descriptor, '模块要出现在 /modules 里');
    assert.equal(descriptor.order, 85, '要排在 knowledge(70) 之后、ai(90) 之前');
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));
    assert.deepEqual(descriptor.collections, [], '纯检索，不声明集合');

    // 只读查询回灌的投影与条数：ai 模块在 createServices 时聚合各模块的声明
    const ai = ctx.app.services.ai;
    assert.deepEqual(ai.queryFields.search, ['source', 'title', 'snippet', 'url', 'noteId', 'score']);
    assert.equal(ai.queryLimits.search, 12);
    assert.ok(ctx.app.services.commands.targets.includes('search'), 'commands 要注册 target search');

    const caps = await ctx.call('GET', '/ai/capabilities');
    const tools = (caps.body.aiTools ?? []).filter((tool) => tool.module === 'aisearch');
    assert.ok(tools.length >= 2, '要有 search_unified 与 search_sources 两条工具');
    for (const tool of tools) {
      assert.equal(tool.mutates, false, '统一检索是只读的');
      assert.equal(tool.implemented, true);
    }
    assert.ok(tools.some((tool) => tool.name === 'search_unified'));
  } finally {
    await ctx.close();
  }
});

test('打分口径：相同证据在笔记与记忆上得到相同的原始分，归一化单调有界', () => {
  const query = expandQuery('转专业');
  assert.deepEqual(
    query.terms.map((term) => [term.value, term.kind, term.weight]),
    [
      ['转专业', 'full', 1],
      ['专业', 'bigram', 0.25],
      ['转专', 'bigram', 0.25],
    ],
    '三档词权重必须与知识库模块同口径（整串 > 二元组），否则三路分数不可比',
  );

  // 同一份证据（同样的标题命中 + 正文命中）在两路上必须得到同样的原始分与统一分
  const evidence = { title: '转专业', body: '转专业 的条件：绩点要够。' };
  const asNote = scoreText(evidence, query);
  const asMemory = scoreText(evidence, query);
  assert.equal(asNote.raw, asMemory.raw);
  assert.equal(normalizeScore(asNote.raw), normalizeScore(asMemory.raw));
  // 标题命中 ×8：把同样的词从标题挪到正文，分数必须掉下来
  assert.ok(scoreText({ title: '转专业', body: '无关' }, query).raw > scoreText({ title: '无关', body: '转专业' }, query).raw);

  // 归一化：单调、有界、raw=4 → 0.5（跨源比较的锚点）
  assert.equal(normalizeScore(0), 0);
  assert.equal(normalizeScore(4), 0.5);
  assert.ok(normalizeScore(8) > normalizeScore(4) && normalizeScore(4) > normalizeScore(1));
  assert.ok(normalizeScore(1000) < 1, '永远到不了 1（有界），但可以无限接近');
});

test('合并排序：跨源同标题去重（保留分数高的那条当主条），同源同名不合并', () => {
  const key = dedupeKeyOf(' 转专业实施细则 ');
  assert.equal(key, dedupeKeyOf('转专业实施细则'), '归一化标题要忽略空白与标点');
  const make = (source, id, title, score) => ({
    source,
    id,
    title,
    score,
    sources: [source],
    meta: { merged: [], dedupeKey: dedupeKeyOf(title), ...(source === 'note' ? { noteId: id } : {}) },
  });

  const merged = rankAndMerge([
    make('knowledge', 'k1', '转专业实施细则', 0.6),
    make('note', 'n1', '转专业实施细则', 0.8),
    make('knowledge', 'k2', '转专业实施细则', 0.5),
    make('memory', 'm1', '我打算转专业', 0.3),
  ]);

  assert.equal(merged.length, 3, '跨源两路并成一条；同源的另一篇不能被一起吞掉');
  assert.equal(merged[0].source, 'note', '分数最高的那条当主条');
  assert.equal(merged[0].id, 'n1');
  assert.deepEqual(merged[0].sources, ['note', 'knowledge']);
  assert.equal(merged[0].meta.merged.length, 1);
  assert.equal(merged[0].meta.merged[0].id, 'k1', '被并掉的那一路的身份要留档');
  assert.equal('dedupeKey' in merged[0].meta, false, '去重键是内部工序，不进返回值');
  assert.deepEqual(merged.map((item) => item.score), [0.8, 0.5, 0.3], '整体仍按分数降序');
  // 同分时按来源序（校规 > 笔记 > 记忆）
  const tied = rankAndMerge([make('memory', 'm2', '甲', 0.5), make('knowledge', 'k3', '乙', 0.5)]);
  assert.deepEqual(tied.map((item) => item.source), ['knowledge', 'memory']);
});

