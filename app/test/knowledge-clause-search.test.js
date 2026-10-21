/**
 * 「问具体条款 → 先检索、再续读」的回归测试。
 *
 * 背景（真机缺陷）：用户问「挂几科会被退学」，模型整篇 `read` 知识库，只拿到前 4000 字，
 * 于是回答"我只能读到 4000 字"。可条款明明在语料里：
 *   - 《西安交通大学本科生学籍管理与学位授予规定（2017）》正文 8213 字，
 *     「第六章 退学警告与退学」从第 4860 字才开始（24 / 54 / 80 / 104 学分四档都在这一章）；
 *   - 旧的 `read()` 只给前 4000 字、且没有 offset，模型没有任何手段读到第 4860 字。
 *
 * 修复后的契约（本文件逐条钉住）：
 *   1. 具体条款用 `search({ q })`：片段默认 800 字，且带 `offset`（命中在全文第几字）；
 *   2. `read({ offset })` 能续读，返回 `nextOffset` / `truncated` / `totalChars`；
 *   3. `search({ path, q })` 的窗口开在命中处附近，`search({ section })` 能精确到章/条；
 *   4. AI 真实链路（mock 上游）第一轮必须发 `filters.q` 检索，而不是按 path 整篇读，
 *      回灌片段后模型能看到"8 门"并据此回答；
 *   5. 系统提示词与 aiTools 契约把「具体条款优先 search / 不要整篇 read」写成硬规则。
 *
 * 用**合成语料**（8400 字，把"挂 8 门退学"放在第 5100 字之后）验证长文场景，
 * 用**真实语料**验证线上那篇学籍规定确实在第 4000 字之后藏着条款。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createServer } from '../src/server/index.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { createKnowledgeCommands } from '../src/modules/knowledge/commands.js';
import knowledgeModule from '../src/modules/knowledge/module.js';
import { KNOWLEDGE_TOOLS } from '../src/modules/knowledge/tools.js';
import { startMockAi } from './helpers/ai-mock.js';

const H1 = '# 长文测试规定';
const LONG_PATH = 'knowledge/dean/gz/01-长文测试规定.md';
const LONG_URL = 'https://dean.xjtu.edu.cn/info/9999/1.htm';
/** 8400 字：默认窗口 4000，offset=4000 时还能再给 4000，`nextOffset` 正好到 8000。 */
const LONG_CHARS = 8400;
/** 关键条款放在第 5100 字之后，保证默认窗口读不到。 */
const CLAUSE = '\n\n第八章 退学\n\n挂 8 门课程者，予以退学处理。\n\n';
const CLAUSE_TEXT = '挂 8 门课程者，予以退学处理。';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** 临时语料目录（索引 + 一篇 8400 字长文）。 */
function makeCorpus() {
  const prefix = '甲'.repeat(5100);
  const suffixLen = LONG_CHARS - prefix.length - CLAUSE.length;
  assert.ok(suffixLen > 0, '合成语料的长度算式应该成立');
  const body = `${H1}\n\n${prefix}${CLAUSE}${'乙'.repeat(suffixLen)}`;
  // `read()` 会去掉 H1，所以正文口径正好是 8400 字，且"挂 8 门"在第 5100 字之后
  assert.equal(body.replace(/^\s*#\s+.*(\r?\n)+/, '').trim().length, LONG_CHARS);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-clause-'));
  const file = path.join(dir, 'gz', '01-长文测试规定.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    ['---', 'title: "长文测试规定"', `url: "${LONG_URL}"`, 'publishedAt: "2026-01-01"', '---', '', body].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      source: 'dean.xjtu.edu.cn',
      generatedAt: '2026-01-01T00:00:00.000Z',
      counts: { categories: 1, documents: 1, chars: LONG_CHARS },
      categories: [
        {
          slug: 'gz',
          label: '规章制度 / 教务管理',
          listingUrl: 'https://dean.xjtu.edu.cn/gz.htm',
          count: 1,
          items: [
            {
              title: '长文测试规定',
              url: LONG_URL,
              path: LONG_PATH,
              publishedAt: '2026-01-01',
              chars: LONG_CHARS,
              sha256: sha256(body),
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  return dir;
}

/** 临时语料服务。 */
async function serviceAt(dir) {
  const knowledge = new KnowledgeService({ log: () => {}, corpusDir: dir });
  await knowledge.restore();
  assert.equal(knowledge.available, true, '临时语料应该可用');
  return knowledge;
}

/** 起一个真实后端（端口 0），返回 `call(method, route, body)`。 */
async function startApp(corpusDir) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-clause-data-'));
  const app = await createServer({ dataDir, knowledge: { corpusDir } });
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
  return { app, dataDir, call, async close() { await app.close(); } };
}

/* ------------------------------------------------------------------ 合成长文：offset / 片段 */

test('长文：read 默认只回前 4000 字，offset 能续读到第 5000 字之后的条款', async () => {
  const dir = makeCorpus();
  try {
    const knowledge = await serviceAt(dir);
    const first = knowledge.read({ path: LONG_PATH });
    assert.equal(first.totalChars, LONG_CHARS, '总字数要如实（不含 H1）');
    assert.equal(first.content.length, 4000, '默认窗口是 4000 字');
    assert.equal(first.truncated, true);
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 4000);
    assert.doesNotMatch(first.content, /挂 8 门/, '关键条款在第 5000 字之后，默认窗口读不到');

    const second = knowledge.read({ path: LONG_PATH, offset: first.nextOffset });
    assert.equal(second.offset, 4000);
    assert.equal(second.content.length, 4000);
    assert.equal(second.truncated, true);
    assert.equal(second.nextOffset, 8000);
    assert.match(second.content, /挂 8 门/, 'offset=4000 的窗口应该覆盖第 5100 字之后的条款');

    const tail = knowledge.read({ path: LONG_PATH, offset: 8000 });
    assert.equal(tail.offset, 8000);
    assert.equal(tail.content.length, 400, '最后一段只有 400 字');
    assert.equal(tail.nextOffset, null, '读到结尾时 nextOffset 必须是 null');
    assert.equal(tail.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('长文：search 命中条款、片段含「8 门」，offset 落在第 5000 字之后', async () => {
  const dir = makeCorpus();
  try {
    const knowledge = await serviceAt(dir);
    const result = knowledge.search({ q: '退学' });
    assert.equal(result.count, 1);
    const [hit] = result.items;
    assert.match(hit.snippet, /8\s*门/, `片段必须包含判定数字：${hit.snippet}`);
    assert.ok(hit.offset > 5000, `offset 应该指向第 5000 字之后的命中：${hit.offset}`);
    assert.ok(hit.offset < 5400, `offset 不该偏得太远：${hit.offset}`);
    // 关键词检索仍然只给片段，不把全文倒进上下文
    assert.equal(hit.content, undefined, '关键词检索不许返回正文');
    assert.equal(hit.totalChars, undefined, '关键词检索不许返回 totalChars');

    // 模型拿 offset 直接续读，就能读到条款原文
    const continued = knowledge.read({ path: hit.path, offset: hit.offset });
    assert.match(continued.content, /挂 8 门/, '按命中 offset 续读应该读到条款');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('长文：search 支持 section 精确到章，path + q 的窗口也开在命中处附近', async () => {
  const dir = makeCorpus();
  try {
    const knowledge = await serviceAt(dir);

    const bySection = knowledge.search({ q: '退学', section: '第八章 退学' });
    assert.equal(bySection.count, 1);
    const [scoped] = bySection.items;
    assert.equal(scoped.section?.kind, 'chapter');
    assert.ok(scoped.section?.offset > 5000);
    assert.match(scoped.snippet, /8\s*门/, '小节内的片段应该直接包含条款');

    const byPath = knowledge.search({ path: LONG_PATH, q: '退学' });
    const [read] = byPath.items;
    assert.ok(read.matchOffset > 5000, `matchOffset 要指向命中：${read.matchOffset}`);
    assert.ok(read.offset < read.matchOffset, '窗口起点应该在命中点之前一点');
    assert.match(read.content, /挂 8 门/, 'path+q 的正文窗口必须包含命中处');
    assert.equal(read.totalChars, LONG_CHARS);

    const bySectionPath = knowledge.search({ path: LONG_PATH, section: '第八章 退学' });
    const [sectionRead] = bySectionPath.items;
    assert.equal(sectionRead.section?.kind, 'chapter');
    assert.match(sectionRead.content, /^第八章 退学/, '按小节读时正文从节首开始');
    assert.match(sectionRead.content, /挂 8 门/);
    assert.equal(sectionRead.truncated, false, '这一节本身没超过窗口');

    // 不存在的小节要说 0 条（不是拿整篇来充数）
    assert.equal(knowledge.search({ path: LONG_PATH, section: '不存在的第九章' }).count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('长文：commands 把检索、续读、小节都串起来，explain 说清读的是哪一段', async () => {
  const dir = makeCorpus();
  try {
    const knowledge = await serviceAt(dir);
    const commands = createKnowledgeCommands({ knowledge });

    const searched = commands.query({ filters: { q: '退学' } });
    assert.equal(searched.count, 1);
    assert.match(searched.explain, /检索到的条款原文/, '关键词检索要说明这是检索到的条款原文');
    assert.match(searched.explain, /offset/, '要告诉模型下一轮怎么续读');
    assert.match(searched.items[0].snippet, /8\s*门/);

    const continued = commands.query({ filters: { path: LONG_PATH, offset: searched.items[0].offset } });
    assert.match(continued.items[0].content, /挂 8 门/, 'filters.offset 要能续读到条款');
    assert.match(continued.explain, /读取/);

    const sectioned = commands.query({ filters: { path: LONG_PATH, section: '第八章 退学' } });
    assert.match(sectioned.items[0].content, /挂 8 门/);
    assert.match(sectioned.explain, /第八章 退学/, 'explain 要写清读的是哪一节');

    const missing = commands.query({ filters: { path: LONG_PATH, section: '不存在的第九章' } });
    assert.equal(missing.count, 0);
    assert.match(missing.explain, /没有找到小节/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('长文：HTTP 路由也支持 offset / section，/knowledge/doc 仍保持 8000 字既有契约', async () => {
  const dir = makeCorpus();
  const ctx = await startApp(dir);
  try {
    const def = await ctx.call('GET', `/knowledge/doc?path=${encodeURIComponent(LONG_PATH)}`);
    assert.equal(def.status, 200);
    assert.equal(def.body.content.length, 8000, 'HTTP /knowledge/doc 默认仍是 8000 字');
    assert.equal(def.body.truncated, true);
    assert.equal(def.body.nextOffset, 8000);

    const continued = await ctx.call(
      'GET',
      `/knowledge/doc?path=${encodeURIComponent(LONG_PATH)}&offset=4000`,
    );
    assert.equal(continued.status, 200);
    assert.equal(continued.body.offset, 4000);
    assert.match(continued.body.content, /挂 8 门/);

    const searched = await ctx.call(
      'GET',
      `/knowledge/search?q=${encodeURIComponent('退学')}&section=${encodeURIComponent('第八章 退学')}`,
    );
    assert.equal(searched.status, 200);
    assert.equal(searched.body.count, 1);
    assert.match(searched.body.items[0].snippet, /8\s*门/);
    assert.equal(searched.body.items[0].section.kind, 'chapter');
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ AI 真实链路 */

test('AI 链路：问「挂几科会被退学」→ 第一轮先 search（filters.q），回灌片段后答出 8 门', async () => {
  const dir = makeCorpus();
  const mock = await startMockAi({
    apiKey: 'sk-test-clause-0001',
    replies: [
      '我先查一下具体条款。\n```command\n' +
        JSON.stringify({
          ok: true,
          action: 'query',
          target: 'knowledge',
          filters: { q: '退学 挂科', limit: 5 },
          explain: '检索退学条款',
        }) +
        '\n```',
      '按检索到的条款，挂 8 门课程会被退学处理。',
    ],
  });
  const ctx = await startApp(dir);
  try {
    const saved = await ctx.call('POST', '/ai/config', {
      apiKey: 'sk-test-clause-0001',
      model: 'deepseek-flash',
      baseUrl: mock.baseUrl,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));

    const sent = await ctx.call('POST', '/ai/chat', {
      text: '挂几科会被退学？',
      stream: false,
      search: 'off',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));

    // 1) 第一轮是关键词检索，不是按 path/url 整篇 read
    assert.equal(mock.state.calls, 2, '一次查询 + 一次作答');
    const [entry] = sent.body.queried;
    assert.equal(entry.draft.target, 'knowledge');
    assert.ok(entry.draft.filters.q, '必须先用 filters.q 检索');
    assert.equal(entry.draft.filters.path, undefined, '第一轮不该整篇 read');
    assert.equal(entry.draft.filters.url, undefined, '第一轮不该按 url 整篇 read');
    assert.equal(entry.result.items[0].content, undefined, '关键词检索不返回全文');

    // 2) 回灌给模型的片段里有"8 门"和"offset"，它不需要读整篇
    const injected = mock.state.bodies[1].messages.at(-1);
    assert.equal(injected.role, 'user');
    assert.match(injected.content, /\[系统注入\]/);
    assert.match(injected.content, /8\s*门/, '片段里必须有判定数字');
    assert.match(injected.content, /"offset":\s*\d+/, '检索结果必须带 offset，方便续读');
    assert.match(injected.content, /检索到的条款原文/, 'explain 要告诉模型这是条款原文');

    // 3) 模型据此回答（mock 的第二条回复被原样返回）
    assert.match(sent.body.assistant.content, /8\s*门/);

    // 4) 前端卡片也能核对检索到的片段与位置
    assert.ok(entry.result.items[0].offset > 5000);
    assert.match(entry.result.items[0].snippet, /8\s*门/);
  } finally {
    await ctx.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ 提示词 / 工具契约 */

test('契约：aiPrompt 把「具体条款优先 search、不要整篇 read」写成硬规则', () => {
  const prompt = knowledgeModule.aiPrompt;
  assert.match(prompt, /具体条款优先 search/);
  assert.match(prompt, /不要整篇 read/);
  assert.match(prompt, /filters\.offset=nextOffset/, '要教模型用 nextOffset 续读');
  assert.match(prompt, /这是检索到的条款原文/, '回答要说明这是检索到的条款原文');
  assert.match(prompt, /filters\.section/, '要教模型用 section 精确到小节');
  assert.doesNotMatch(prompt, /240 字片段/, '旧的 240 字片段说法必须改掉');
});

test('契约：aiQueryFields / aiTools 暴露 offset、nextOffset、section 等续读字段', () => {
  for (const field of ['snippet', 'offset', 'matchOffset', 'nextOffset', 'section', 'path', 'content', 'truncated', 'totalChars']) {
    assert.ok(knowledgeModule.aiQueryFields.knowledge.includes(field), `aiQueryFields.knowledge 缺 ${field}`);
  }

  const searchTool = KNOWLEDGE_TOOLS.find((tool) => tool.name === 'knowledge_search');
  assert.ok(searchTool, '要有 knowledge_search');
  assert.match(searchTool.description, /具体条款优先用它/, 'search 工具描述要写清具体条款优先用它');
  assert.equal(searchTool.params.section, 'string?', 'search 工具要有 section 参数');

  const docTool = KNOWLEDGE_TOOLS.find((tool) => tool.name === 'knowledge_doc');
  assert.ok(docTool, '要有 knowledge_doc');
  assert.match(docTool.description, /offset/, 'read 工具描述要写清 offset 续读');
  assert.equal(docTool.params.offset, 'number?', 'read 工具要有 offset 参数');
  assert.match(docTool.returns.nextOffset, /number/, 'read 工具要返回 nextOffset');
});

/* ------------------------------------------------------------------ 真实语料：线上那篇学籍规定 */

test('真实语料：学籍规定第六章在第 4000 字之后，检索 + 续读能读到 24 学分等条款', async () => {
  const knowledge = new KnowledgeService({ log: () => {} });
  await knowledge.restore();
  assert.equal(knowledge.available, true, '真实语料应该可用');

  const rel = 'knowledge/dean/gzzd-jwgl/13-西安交通大学本科生学籍管理与学位授予规定（2017）.md';
  const first = knowledge.read({ path: rel });
  assert.ok(first.totalChars > 5000, `这篇应该是长文：${first.totalChars}`);
  assert.equal(first.truncated, true);
  assert.doesNotMatch(first.content, /第六章 退学警告与退学/, '默认窗口读不到第六章（这就是用户遇到的截断）');

  // 精确到章检索：片段必须直接给出 24/54/80/104 四档学分
  const result = knowledge.search({ q: '退学警告', section: '第六章 退学警告与退学' });
  assert.equal(result.count, 1);
  const [item] = result.items;
  assert.ok(item.section?.offset > 4000, `第六章的起点应该在第 4000 字之后：${item.section?.offset}`);
  assert.match(item.snippet, /24\s*学分/, `片段里要有条款数字：${item.snippet.slice(0, 120)}`);
  assert.match(item.snippet, /第二十六条/);

  // 从节首 / 命中 offset 续读，能读到完整条款
  const continued = knowledge.read({ path: rel, offset: item.section.offset });
  assert.match(continued.content, /第二十六条/);
  assert.match(continued.content, /104\s*学分/);
});
