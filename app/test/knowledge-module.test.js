/**
 * 知识库模块的集成测试：HTTP 端点、对话 target、以及"语料缺失也要能活"。
 *
 * 为什么这几条值得测：
 *   1. **引用必须能点回去**：检索结果没有 `url` 的话，模型给的校规就无法核对 ——
 *      而"照错的校规办事"比答不出来严重得多；
 *   2. **只给片段、不给全文**：整篇进提示词会淹掉对话（契约 §14.4）；
 *   3. **路径不能越界**：`/knowledge/doc?path=` 是拿文件内容的接口，`..` 必须 400；
 *   4. **语料缺失要降级**：没跑过抓取脚本的机器上，模块不能把后端带崩、也不能报 500。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, PACKAGE_ROOT } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const CORPUS_REL = 'knowledge/dean';

/**
 * 起一个真实后端（端口 0），返回一个 `call(method, route, body)`。
 *
 * 语料目录走 `createServer({ knowledge: { corpusDir } })` 而不是环境变量：
 * `PC_KNOWLEDGE_DIR` 是在模块 **import 时**求值的常量，同一个进程里起第二个服务时改它不生效
 * （第一组用例会把默认语料缓存下来）—— 用模块选项才是每次装配都能指定的写法。
 */
async function startApp({ corpusDir } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-knowledge-'));
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
    return { status: response.status, body: parsed, app, info };
  };
  return {
    app,
    info,
    call,
    async close() {
      await app.close();
    },
  };
}

test('知识库：/knowledge/stats 如实报出语料规模与来源', async () => {
  const ctx = await startApp();
  try {
    const { status, body } = await ctx.call('GET', '/knowledge/stats');
    assert.equal(status, 200);
    assert.equal(body.available, true, '仓库里应该有语料（knowledge/dean）');
    assert.equal(body.source, 'dean.xjtu.edu.cn');
    assert.ok(body.counts.documents >= 100, `篇数看起来不对：${body.counts.documents}`);
    assert.ok(body.categories.length >= 10, '栏目数量看起来不对');
    assert.ok(body.generatedAt, '要给出生成语料的时间（判断新不新）');
    for (const category of body.categories) {
      assert.match(category.slug, /^[a-z0-9-]+$/);
      assert.ok(category.count >= 1);
    }
  } finally {
    await ctx.close();
  }
});

test('知识库：/knowledge/search 命中政策，且每条都带来源 URL 与片段', async () => {
  const ctx = await startApp();
  try {
    const { status, body } = await ctx.call('GET', `/knowledge/search?q=${encodeURIComponent('转专业')}`);
    assert.equal(status, 200);
    assert.ok(body.count >= 1, '「转专业」应该能查到东西');
    for (const item of body.items) {
      assert.match(item.url, /^https:\/\/dean\.xjtu\.edu\.cn\//, '每条都要能点回教务处原文');
      assert.ok(item.title);
      assert.ok(item.category);
      assert.equal(typeof item.score, 'number');
      // 片段而不是全文：整篇进提示词会淹掉对话。默认片段 800 字（要能覆盖一整条条款），
      // 但绝不能接近整篇的长度。
      assert.ok(item.snippet.length > 0 && item.snippet.length <= 900, `snippet 长度异常：${item.snippet.length}`);
      assert.ok(Array.isArray(item.matches));
    }
    // 标题命中的那篇要排在前面（打分里标题权重远高于正文）
    const titles = body.items.map((item) => item.title).join(' | ');
    assert.match(titles, /转专业/, `排序不合理，命中的是：${titles}`);
  } finally {
    await ctx.close();
  }
});

test('知识库：q 为空 400；category 能把结果收窄到某一栏', async () => {
  const ctx = await startApp();
  try {
    const empty = await ctx.call('GET', '/knowledge/search');
    assert.equal(empty.status, 400, 'q 不能为空');

    const all = await ctx.call('GET', `/knowledge/search?q=${encodeURIComponent('方案')}&limit=10`);
    const narrowed = await ctx.call(
      'GET',
      `/knowledge/search?q=${encodeURIComponent('方案')}&category=jxxx-pyfa&limit=10`,
    );
    assert.ok(narrowed.body.count >= 1);
    assert.ok(narrowed.body.count <= all.body.count, '带栏目过滤的结果不该变多');
    for (const item of narrowed.body.items) assert.equal(item.categorySlug, 'jxxx-pyfa');
  } finally {
    await ctx.close();
  }
});

test('知识库：/knowledge/doc 能读全文，但路径越界一律 400', async () => {
  const ctx = await startApp();
  try {
    const stats = await ctx.call('GET', '/knowledge/stats');
    const list = await ctx.call('GET', `/knowledge/search?q=${encodeURIComponent('作息')}`);
    const hit = list.body.items[0];
    assert.ok(hit?.path, '应该能查到一篇（作息时间表）');

    const doc = await ctx.call('GET', `/knowledge/doc?path=${encodeURIComponent(hit.path)}`);
    assert.equal(doc.status, 200);
    assert.match(doc.body.content, /作息|起床|熄灯/, '读出来的正文应该是那一篇');
    assert.equal(doc.body.url, hit.url);
    assert.ok(stats.body.counts.documents > 0);

    for (const evil of ['../../etc/passwd', '/etc/passwd', 'knowledge/dean/../../../etc/passwd', '../../package.json']) {
      const bad = await ctx.call('GET', `/knowledge/doc?path=${encodeURIComponent(evil)}`);
      assert.equal(bad.status, 400, `越界路径必须 400：${evil}`);
    }
    // 语料目录内的文件（README / index.json）不算越界，但"没这一篇"要如实 400，
    // 不能返回一段空正文让模型以为"这篇政策是空的"
    const missing = await ctx.call('GET', '/knowledge/doc?path=nope/not-a-doc.md');
    assert.equal(missing.status, 400);
  } finally {
    await ctx.close();
  }
});

test('知识库：/knowledge/check 在真实语料上通过（索引与文件一致）', async () => {
  const ctx = await startApp();
  try {
    const { status, body } = await ctx.call('GET', '/knowledge/check');
    assert.equal(status, 200);
    assert.deepEqual(body.problems, [], `索引与文件不一致：${JSON.stringify(body.problems?.slice(0, 3))}`);
    assert.equal(body.ok, true);
  } finally {
    await ctx.close();
  }
});

test('知识库：对话 target "knowledge" 走只读查询草稿，返回带 url 的条目', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'knowledge', filters: { q: '转专业 条件', limit: 3 } },
      { dryRun: true },
    );
    assert.equal(result.target, 'knowledge');
    assert.ok(result.count >= 1);
    assert.ok(result.items.length <= 3, 'limit 要生效');
    for (const item of result.items) assert.match(item.url, /^https:\/\/dean\.xjtu\.edu\.cn\//);
    assert.match(result.explain, /命中/);

    // 查不到时也要给一句实话（模型据此说"手册里没写"，而不是回去编）
    const miss = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'knowledge', filters: { q: '紫菜蛋花汤的做法' } },
      { dryRun: true },
    );
    assert.equal(miss.count, 0);
    assert.match(miss.explain, /没有匹配/);
  } finally {
    await ctx.close();
  }
});

test('知识库：语料缺失时降级（available:false，不 500、不拖垮后端）', async () => {
  const empty = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-knowledge-empty-'));
  const ctx = await startApp({ corpusDir: empty });
  try {
    const stats = await ctx.call('GET', '/knowledge/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.available, false);
    assert.ok(stats.body.reason, '要说清为什么没有语料');

    const search = await ctx.call('GET', `/knowledge/search?q=${encodeURIComponent('转专业')}`);
    assert.equal(search.status, 200, '没语料也要照常响应（空结果），不是 500');
    assert.equal(search.body.count, 0);

    const check = await ctx.call('GET', '/knowledge/check');
    assert.equal(check.status, 200);
    assert.equal(check.body.ok, false);
    assert.ok(check.body.problems.length >= 1);

    // 其它模块不受影响：健康检查照常
    const health = await ctx.call('GET', '/health');
    assert.equal(health.status, 200);
  } finally {
    await ctx.close();
    await fs.promises.rm(empty, { recursive: true, force: true });
  }
});

test('知识库：module 描述符把目标与工具都声明齐了', async () => {
  const ctx = await startApp();
  try {
    const modules = await ctx.call('GET', '/modules');
    const descriptor = (modules.body.modules ?? modules.body.items ?? []).find((item) => item.id === 'knowledge');
    assert.ok(descriptor, '模块要出现在 /modules 里');
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));

    const caps = await ctx.call('GET', '/ai/capabilities');
    const tools = (caps.body.aiTools ?? []).filter((tool) => tool.module === 'knowledge');
    assert.ok(tools.some((tool) => tool.name === 'knowledge_search'), '要有 knowledge_search 工具');
    for (const tool of tools) assert.equal(tool.mutates, false, '知识库是只读的');
  } finally {
    await ctx.close();
  }
});

test('知识库：语料目录确实在仓库里（不是 data/）', () => {
  const dir = path.join(PACKAGE_ROOT, CORPUS_REL);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')), `${dir}/index.json 应该存在`);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), '语料目录要有 README（来源与更新方式）');
});

/**
 * 这条是被真事逼出来的：Electron 测试窗口只把 `package.json src` 暂存进
 * `ElectronTest.app/Contents/Resources/app`，语料不在 `data/` 下、也就没跟着走 ——
 * 窗口里的知识库于是显示 0 篇，而单元测试全绿（测试直接读仓库路径，看不见打包）。
 * 所以断言暂存清单里必须有 `knowledge`。
 */
test('知识库：Electron 暂存清单里带着 knowledge/（否则打包运行时 0 篇）', () => {
  const script = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'run-electron-macos.sh'), 'utf8');
  const stage = script.match(/tar[\s\S]*?-cf -([^\n]*)/);
  assert.ok(stage, '应该能在启动脚本里找到 tar 暂存行');
  for (const entry of ['package.json', 'src', 'knowledge']) {
    assert.match(stage[1], new RegExp(`(^|\\s)${entry.replace('.', '\\.')}(\\s|$)`), `暂存清单要包含 ${entry}，实际：${stage[1].trim()}`);
  }
});


/**
 * 这条来自「学生日常实测」：模型读全文时把**来源 URL**（甚至只是 URL 的路径片段）
 * 当 path 传，被 400 挡掉，而它上一句已经说了"我把原文调出来看" —— 用户只等到一句空话。
 * 用户看到的"出处"就是 URL，那 URL 就该能当 path 用。
 */
test('知识库：path 也接受来源 URL 与 URL 路径片段（用户看到的出处就该能用）', async () => {
  const ctx = await startApp();
  try {
    const byUrl = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'knowledge', filters: { path: 'https://dean.xjtu.edu.cn/info/1033/8963.htm', limit: 1 } },
      dryRun: true,
    });
    assert.equal(byUrl.status, 200, JSON.stringify(byUrl.body)?.slice(0, 240));
    assert.match(String(byUrl.body.items[0].title), /转专业实施细则/);

    const byFragment = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'knowledge', filters: { path: '/info/1033/8963.htm', limit: 1 } },
      dryRun: true,
    });
    assert.equal(byFragment.status, 200, JSON.stringify(byFragment.body)?.slice(0, 240));
    assert.equal(byFragment.body.items[0].path ?? byFragment.body.items[0].title, byFragment.body.items[0].path ?? byFragment.body.items[0].title);

    // 语料相对路径仍然照旧（别为了新写法把老写法弄坏）
    const byRelPath = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'knowledge', filters: { path: 'knowledge/dean/gzzd-jwgl/04-西安交通大学本科生转专业实施细则.md', limit: 1 } },
      dryRun: true,
    });
    assert.equal(byRelPath.status, 200, JSON.stringify(byRelPath.body)?.slice(0, 240));

    // 真不存在的，错误信息要教它怎么写
    const missing = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'knowledge', filters: { path: '没有这一篇.md', limit: 1 } },
      dryRun: true,
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error.message), /path 字段|url|filters\.q/);
  } finally {
    await ctx.close();
  }
});

/**
 * 跨功能实测的**现场复现**（这次是端到端，不是只看服务层）。
 *
 * 用户问「学校对学业预警是怎么规定的？我会不会被预警？」时，模型引用真链接、也确实按 url
 * 读到了那一篇，却给不出 12 / 8 / 4 学分三档阈值（"这一页正文读到第三条就断了"）。
 * 链路断在三处，缺一处这条用例就会红：
 *   1. `search({ path/url })` 要回长正文（service.js）；
 *   2. `filters.url` 也要被当"点名"（commands.js）；
 *   3. `aiQueryFields.knowledge` 要放行 `content`/`truncated`/`totalChars`（module.js）——
 *      投影表白名单漏字段的话，正文在服务层读出来了、到模型手里又被剥掉，症状与"读不到"一模一样。
 * 断言落在**回灌给上游的那条消息**上：那才是模型真正看得见的世界。
 */
test('知识库：模型按 url 点名读《学业预警细则》，回灌上下文里必须出现 12/8/4 学分', async () => {
  const mock = await startMockAi({
    apiKey: 'sk-test-knowledge-0001',
    replies: [
      '我先把原文调出来看。\n```command\n' +
        JSON.stringify({
          ok: true,
          action: 'query',
          target: 'knowledge',
          filters: { url: 'https://dean.xjtu.edu.cn/info/1033/1130.htm', q: '学业预警 学分' },
          explain: '读学业预警细则原文',
        }) +
        '\n```',
      '一级预警是 12 学分以上、二级 8 学分、三级 4 学分。',
    ],
  });
  const ctx = await startApp();
  try {
    const saved = await ctx.call('POST', '/ai/config', {
      apiKey: 'sk-test-knowledge-0001',
      model: 'deepseek-flash',
      baseUrl: mock.baseUrl,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));

    const sent = await ctx.call('POST', '/ai/chat', {
      text: '学校对学业预警是怎么规定的？我会不会被预警？',
      stream: false,
      search: 'off',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));

    // 回灌给模型的那一份（`#compactQueryResult` 投影之后的结果）里要有正文与阈值
    const fedBack = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(fedBack, /\[系统注入\]/, '要有回灌消息');
    assert.match(fedBack, /学业预警与学籍处理实施细则/, '回灌里要有那一篇');
    assert.match(fedBack, /12\s*学分/, '回灌里必须出现一级预警的 12 学分（这就是当初缺的那一行）');
    assert.match(fedBack, /8\s*学分/);
    assert.match(fedBack, /4\s*学分/);
    assert.match(fedBack, /"totalChars":\s*\d+/, '要如实给出原文总字数');

    // 系统提示词里要写清「具体条款先检索、别整篇读」—— 模型不知道这条就会继续整篇 read。
    const system = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(system, /具体条款优先 search/, '提示词要把「具体条款优先 search」写成硬规则');
    assert.match(system, /不要整篇 read/, '提示词要明确禁掉「整篇 read」');
    assert.match(system, /filters\.offset=nextOffset/, '提示词要教模型用 nextOffset 续读，而不是停在 4000 字');
    assert.match(system, /这是检索到的条款原文/, '提示词要求引用时说明这是检索到的条款原文');

    // 前端卡片也看得到正文（用户有权核对模型读到的到底是哪一段）
    const entry = (sent.body.queried ?? []).find((item) => item.result?.target === 'knowledge');
    assert.ok(entry?.result?.items?.[0]?.content, '查询结果里要带正文');
    assert.match(entry.result.items[0].content, /12\s*学分/);
  } finally {
    await mock.close();
    await ctx.close();
  }
});
