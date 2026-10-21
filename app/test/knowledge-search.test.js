/**
 * `modules/knowledge/search.js`（纯函数，打分 / 片段）与 `modules/knowledge/service.js`
 * （KnowledgeService：读索引、惰性加载正文、检索、读全文、自检）的行为测试。
 *
 * 三个层次的用例：
 *   1. **真实语料**（`knowledge/dean/`，148 篇）：口径本身对不对 —— 搜"转专业"要能找到
 *      实施细则并带 url、搜"作息"要能找到作息时间表、栏目能收窄、自检要过。
 *      政策语料是"用户会照着办"的东西，检索口径歪了比检索不到更危险；
 *   2. **纯函数**（人工构造的小语料）：打分公式与排序必须可解释、可复现 ——
 *      整串 > 切分 > 二元组、标题 > 正文、长文不该靠体量压过短文、片段窗口与省略号；
 *   3. **降级与边界**（`PC_KNOWLEDGE_DIR` 指向临时目录，子进程验证）：空目录 / 坏 JSON /
 *      只有图片页的语料 / 索引与文件不一致 / `path` 越界。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ELLIPSIS,
  NO_BODY_PENALTY,
  NO_TEXT_NOTE,
  countOccurrences,
  expandQuery,
  scoreDocument,
  searchDocuments,
  stripMarkdown,
} from '../src/modules/knowledge/search.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const SERVICE_URL = pathToFileURL(path.join(APP_DIR, 'src', 'modules', 'knowledge', 'service.js')).href;

/** 真实语料里的两篇"基准篇"（口径断言都落在它们身上）。 */
const ZHUANZHUANYE = 'gzzd-jwgl/04-西安交通大学本科生转专业实施细则.md';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

const service = () => new KnowledgeService({ log: () => {} });

/** 真实语料服务（已 restore）；语料缺失时用例会明确失败，而不是静默跳过。 */
async function realService() {
  const knowledge = service();
  await knowledge.restore();
  assert.equal(knowledge.available, true, '真实语料应该可用（knowledge/dean/index.json）');
  return knowledge;
}

/* ------------------------------------------------------------------ 真实语料 */

test('真实语料：restore() 后 stats() 报出 18 栏 / 148 篇，且来源与生成时间来自索引', async () => {
  const knowledge = await realService();
  const stats = knowledge.stats();
  assert.equal(stats.source, 'dean.xjtu.edu.cn');
  assert.ok(stats.generatedAt, 'generatedAt 应该照抄索引里的值');
  assert.equal(stats.counts.categories, 18);
  assert.equal(stats.counts.documents, 148);
  assert.ok(stats.counts.chars > 100000, `总字数应该像样：${stats.counts.chars}`);
  assert.equal(stats.categories.length, 18);
  const gzzd = stats.categories.find((item) => item.slug === 'gzzd-jwgl');
  assert.equal(gzzd.label, '规章制度 / 教务管理');
  assert.equal(gzzd.count, 19);
  assert.ok(gzzd.chars > 0);
  // 图片 / 附件页混在栏目里时要给出 kinds 明细（前端据此提示"正文在附件里"）
  const xssw = stats.categories.find((item) => item.slug === 'xssw-xjgl');
  assert.equal(xssw.kinds, undefined, '同一种 kind 的栏目不必背 kinds 字段');
});

test('真实语料：正文是惰性加载的（restore() / stats() 不读正文）', async () => {
  const knowledge = await realService();
  assert.equal(knowledge.texts.size, 0, 'restore() 之后不该已经把正文读进内存');
  assert.ok(knowledge.categories.every((category) => category.items.every((item) => item.text === undefined)));
  knowledge.search({ q: '转专业' }); // 第一次检索才加载
  const loaded = knowledge.categories.flatMap((category) => category.items).filter((item) => item.text !== undefined);
  assert.equal(loaded.length, 148, '第一次 search() 之后 148 篇正文都应在内存里');
});

test('真实语料：搜「转专业 条件」能命中《本科生转专业实施细则》并给出可点回的 url', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ q: '转专业 条件' });
  assert.equal(result.available, true);
  assert.equal(result.q, '转专业 条件');
  assert.ok(result.count > 0, '应该有条目命中');
  assert.ok(result.count <= 5, '默认 limit 是 5');

  const top = result.items.slice(0, 3);
  const target = top.find((item) => item.title.includes('转专业实施细则'));
  assert.ok(target, `前三条里应该有转专业实施细则：${top.map((item) => item.title).join('、')}`);
  assert.match(target.url, /^https:\/\/dean\.xjtu\.edu\.cn\//, '每条都要带能点回去的出处');
  assert.equal(target.categorySlug, 'gzzd-jwgl');
  assert.equal(target.kind, 'document');
  assert.equal(target.publishedAt, '2025-04-14');
  assert.ok(target.score > 0, 'score 要能被模型用来判断相关性');
  assert.ok(target.matches.includes('转专业'), `matches 要如实报出命中的词：${target.matches.join(',')}`);
  assert.equal(target.snippet.includes('# 标题'), false, '片段里不该残留 Markdown 标题符号');
  assert.ok(target.snippet.includes('转专业'), '片段应该包含命中位置附近的原文');
  for (const item of result.items) {
    assert.equal(typeof item.snippet, 'string');
    assert.ok(item.snippet.length > 0, '每条都要有片段（不给全文，但也不能是空串）');
    assert.equal(item.content, undefined, 'search() 绝不返回全文');
  }
  const scores = result.items.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), '结果按分数降序');
});

test('真实语料：搜「作息」能命中作息时间表（正文是表格，不是图片）', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ q: '作息' });
  assert.ok(result.count >= 1);
  const top = result.items[0];
  assert.equal(top.title, '作息时间');
  assert.equal(top.categorySlug, 'xxfw-zxsj');
  assert.equal(top.kind, 'portal');
  assert.ok(top.url.includes('dean.xjtu.edu.cn'));
  assert.ok(top.matches.includes('作息'));
  assert.notEqual(top.snippet, NO_TEXT_NOTE, '作息表是有文字表格的，不该被当成图片页');
  assert.ok(top.snippet.includes('作息'), '片段应含命中词');
});

test('真实语料：整页是图片的《校历》仍能被标题搜到，且片段如实说明正文在图片里', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ q: '校历' });
  assert.equal(result.count, 1);
  const top = result.items[0];
  assert.equal(top.title, '校历');
  assert.equal(top.kind, 'portal');
  assert.equal(top.snippet, NO_TEXT_NOTE, '没有可检索正文时要如实说明，而不是给一段空片段');
  assert.ok(top.matches.includes('校历'));
  // 但它不该压过真正有正文的篇目：正文为空的篇目有固定惩罚（见 NO_BODY_PENALTY）
  assert.ok(top.score <= 8 * NO_BODY_PENALTY + 0.001, `图片页的分数应该被压过：${top.score}`);
});

test('真实语料：category 能把结果收窄到该栏目', async () => {
  const knowledge = await realService();
  const all = knowledge.search({ q: '转专业', limit: 10 });
  const narrow = knowledge.search({ q: '转专业', category: 'gzzd-jwgl', limit: 10 });
  assert.ok(narrow.count > 0);
  assert.ok(narrow.count < all.count, `收窄后应该更少：${narrow.count} < ${all.count}`);
  for (const item of narrow.items) assert.equal(item.categorySlug, 'gzzd-jwgl');
  // 短小的流程页在 xssw-xjgl 栏，收窄后应该被排除掉
  assert.ok(all.items.some((item) => item.categorySlug === 'xssw-xjgl'));
  assert.equal(narrow.items.some((item) => item.categorySlug === 'xssw-xjgl'), false);
  // 不存在的栏目 → 空结果（不是报错）
  assert.deepEqual(knowledge.search({ q: '转专业', category: '不存在的栏目' }).count, 0);
});

test('真实语料：q 为空且没有 path 时返回空结果而不抛错', async () => {
  const knowledge = await realService();
  for (const q of ['', '   ', undefined, null]) {
    const result = knowledge.search({ q });
    assert.equal(result.available, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.items, []);
  }
});

test('真实语料：search({ path }) 直接定位那一篇，返回 1 条带片段的结果', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ path: ZHUANZHUANYE, q: '条件' });
  assert.equal(result.count, 1);
  const [item] = result.items;
  assert.equal(item.title, '西安交通大学本科生转专业实施细则');
  assert.equal(item.path, `knowledge/dean/${ZHUANZHUANYE}`);
  assert.equal(item.score, null, '直接定位不是排序出来的，score 给 null 比编一个诚实');
  assert.ok(item.matches.includes('条件'));
  assert.ok(item.snippet.includes('条件'));
  // path 形式也认语料相对路径（模型可能照抄 search() 的 path）
  assert.equal(knowledge.search({ path: ZHUANZHUANYE }).items[0].title, item.title);
});

test('真实语料：read() 给出正文（去重标题行、默认 4000 字窗口可续读）', async () => {
  const knowledge = await realService();
  const doc = knowledge.read({ path: ZHUANZHUANYE });
  assert.equal(doc.title, '西安交通大学本科生转专业实施细则');
  assert.equal(doc.category, '规章制度 / 教务管理');
  assert.equal(doc.kind, 'document');
  assert.ok(doc.content.includes('第一章 总则'));
  assert.equal(doc.content.startsWith('# '), false, 'content 不该再重复一遍 title 那行');
  assert.equal(doc.truncated, false);

  const clipped = knowledge.read({ path: ZHUANZHUANYE, maxChars: 60 });
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.content.length, 60);

  // 4000 字默认窗口：正文最长的那些篇目在默认参数下应被截断，但能按 offset 续读
  const longest = knowledge.categories
    .flatMap((category) => category.items)
    .reduce((best, item) => (item.chars > best.chars ? item : best));
  const big = knowledge.read({ path: longest.path });
  assert.equal(big.truncated, true, `最长的一篇（${longest.chars} 字）在 4000 字窗口下应被截断`);
  assert.equal(big.content.length, 4000);
  assert.equal(big.offset, 0);
  assert.equal(big.nextOffset, 4000);
  const rest = knowledge.read({ path: longest.path, offset: big.nextOffset });
  assert.equal(rest.offset, 4000);
  assert.equal(rest.content.length, 4000);
  assert.equal(rest.nextOffset, 8000);
  assert.notEqual(rest.content.slice(0, 50), big.content.slice(0, 50), 'offset 之后应该是另一段正文');
});

test('真实语料：read() 的 path 越界一律 400（HttpError.badRequest）', async () => {
  const knowledge = await realService();
  const escapes = [
    '../index.json',
    '../../../etc/passwd',
    'gzzd-jwgl/../../index.json',
    'knowledge/dean/../../package.json',
    '/etc/passwd',
    '',
  ];
  for (const bad of escapes) {
    assert.throws(
      () => knowledge.read({ path: bad }),
      (error) => error.name === 'HttpError' && error.status === 400 && error.code === 'BAD_REQUEST',
      `path=${JSON.stringify(bad)} 应该 400`,
    );
  }
  // 越界同样在 search({ path }) 上生效（同一条路径判定）
  assert.throws(() => knowledge.search({ path: '../index.json' }), (error) => error.status === 400);
});

test('真实语料：check() 与抓取器同一套判据，在真实语料上 ok', async () => {
  const knowledge = await realService();
  const result = knowledge.check();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('真实语料：reload() 重新读索引并返回新的 stats()', async () => {
  const knowledge = await realService();
  const before = knowledge.stats();
  const after = await knowledge.reload();
  assert.equal(after.available, true);
  assert.deepEqual(after.counts, before.counts);
  assert.equal(knowledge.texts.size, 0, 'reload() 之后正文缓存要清掉，下次检索重新加载');
});

/* ------------------------------------------------------------------ 打分与排序（纯函数） */

/**
 * 人工小语料：字段与 `KnowledgeService` 传给 `searchDocuments` 的形状一致。
 * 用它把"排序合理"拆成可以逐条断言的规则。
 */
const DOCS = [
  {
    title: '转专业实施细则',
    path: 'a.md',
    text: '申请转专业条件：一、二年级学生可申请。转专业条件每年由学院公布。',
  },
  {
    title: '学生手册',
    path: 'b.md',
    text: `学籍管理章节。${'其'.repeat(3000)}转专业需要满足条件并提交申请。`,
  },
  {
    title: '社团招新',
    path: 'c.md',
    text: `本社团欢迎转专业条件相关同学咨询。${'文'.repeat(400)}`,
  },
  { title: '校园卡办理', path: 'd.md', text: '办卡地点在行政楼一层。' },
];

test('纯函数：整串 > 切分 > 二元组（词权重分档）', () => {
  const query = expandQuery('转专业 条件');
  const weight = (value) => query.terms.find((term) => term.value === value)?.weight;
  assert.equal(weight('转专业条件'), 1, '整串权重最高（归一化后为 1）');
  assert.equal(weight('转专业'), 0.5, '切分出的词是第二档');
  assert.equal(weight('条件'), 0.5);
  assert.equal(weight('专业'), 0.25, '二元组权重最低');
  assert.equal(weight('转专'), 0.25);
  assert.equal(query.normalized, '转专业条件', '整串是去掉空白与标点后的形式');

  // 标点（含全角）与空白一样只是分隔符：整串相同、切分词相同；
  // 二元组会多出跨标点的"业条"——这是刻意的"保召回"，它权重最低（0.25）
  const punctuation = expandQuery('转专业，条件！');
  assert.equal(punctuation.normalized, '转专业条件', '全角标点会被 NFKC 折掉，不能留在整串里');
  assert.equal(punctuation.terms.find((term) => term.value === '转专业条件').weight, 1);
  assert.equal(punctuation.terms.find((term) => term.value === '转专业').weight, 0.5);
  assert.equal(punctuation.terms.find((term) => term.value === '条件').weight, 0.5);
  assert.equal(punctuation.terms.find((term) => term.value === '业条').kind, 'bigram');
  assert.ok(punctuation.terms.find((term) => term.value === '业条').weight < 0.5, '跨标点的二元组权重最低');
  // 分档齐全：整串 / 切分词 / 二元组各就各位
  assert.deepEqual([...new Set(query.terms.map((term) => term.kind))].sort(), ['bigram', 'full', 'token']);

  // 中文只切二元组、不引第三方分词；英文按空白切词
  assert.deepEqual(expandQuery('LMS').terms.map((term) => term.value), ['LMS']);
  assert.deepEqual(expandQuery('').terms, []);
  assert.deepEqual(expandQuery('   ').terms, []);
});

test('纯函数：排序——整串命中 > 只命中切分词 > 只命中二元组', () => {
  const result = searchDocuments(DOCS, '转专业 条件', { limit: 5 });
  assert.deepEqual(
    result.items.map((item) => item.path),
    ['a.md', 'c.md', 'b.md'],
    'a 有整串命中，b/c 没有；b 正文长（长度归一后被压到 c 后面）',
  );
  assert.equal(result.items[0].matches.includes('转专业条件'), true);
  // 一句"办卡地点"里没有"转专业"，不该被召回
  assert.equal(result.items.some((item) => item.path === 'd.md'), false);
});

test('纯函数：标题命中权重远高于正文命中（8 : 1）', () => {
  const term = '作息时间';
  // 两篇其余条件完全一样（同样长度、同样没有其它命中），只有"命中在标题还是正文"不同
  const filler = '无关内容。';
  const docs = [
    { title: '作息时间', path: 'title.md', text: filler },
    { title: '校园生活指南', path: 'body.md', text: `${term}${filler}` },
  ];
  const result = searchDocuments(docs, term, { limit: 5 });
  assert.equal(result.items[0].path, 'title.md', '标题命中应该排第一');
  const byPath = Object.fromEntries(result.items.map((item) => [item.path, item]));
  const ratio = byPath['title.md'].score / byPath['body.md'].score;
  assert.ok(ratio > 4, `标题命中应当显著高于正文命中（实测 ${ratio.toFixed(2)} 倍）`);

  // 公式本身：整串命中标题 = 词权重 1 × 8；空正文还要乘 NO_BODY_PENALTY
  const query = expandQuery(term);
  const scored = scoreDocument({ title: term, text: '' }, query);
  // 期望值照着公式算（不写死常数），公式一旦改动测试会立刻指出来
  const expectedTitleHits = query.terms.reduce((sum, t) => sum + t.weight * Math.min(2, countOccurrences(term, t.value)), 0);
  assert.ok(expectedTitleHits >= 1, '整串至少命中一次');
  assert.equal(scored.titleHits, expectedTitleHits);
  // score 保留 3 位小数，期望值也照同样的口径取整，避免浮点尾差把断言变成噪声
  const expectedScore = Math.round(expectedTitleHits * 8 * NO_BODY_PENALTY * 1000) / 1000;
  assert.equal(scored.score, expectedScore, '空正文：标题命中 × 8 × 空正文惩罚');
});

test('纯函数：长度归一，长文不该靠体量压过短文', () => {
  const base = '转专业 条件 与 申请流程。';
  const docs = [
    { title: '短公告', path: 'short.md', text: base },
    { title: '长规定', path: 'long.md', text: `${base}${'附'.repeat(8000)}` },
  ];
  const result = searchDocuments(docs, '转专业 条件', { limit: 5 });
  assert.deepEqual(result.items.map((item) => item.path), ['short.md', 'long.md'], '短文排在长文前面');
  const [short, long] = result.items;
  assert.ok(short.score > long.score * 1.5, `长度阻尼要明显：${short.score} vs ${long.score}`);
  assert.ok(short.bodyHits === long.bodyHits, '两篇的命中完全一样，差别只在长度');

  // 词频不再无限加分：长度相同的前提下，"出现 5 次"与"出现 2 次"同分（单次命中封顶 2 次）
  // 两段文本**等长**（每条 5 个格子，每格 4 字），差别只有几格里写了"转专业"
  const sameLength = (count) =>
    Array.from({ length: 5 }, (_, index) => (index < count ? '转专业。' : '说明文。')).join('');
  const five = sameLength(5);
  const two = sameLength(2);
  assert.equal(five.length, two.length, '两个文本必须等长，才是在比"词频"而不是比长度');
  assert.ok(countOccurrences(five, '转专业') > countOccurrences(two, '转专业'), '两篇的词频确实不同');
  assert.equal(
    scoreDocument({ title: 'x', text: five }, expandQuery('转专业')).score,
    scoreDocument({ title: 'x', text: two }, expandQuery('转专业')).score,
    '单次命中封顶 2 次：出现 5 次不该比出现 2 次分高',
  );
  // 同时确认计数本身是**重叠**计数，不是 stride 漏数：
  // "AAAA" 里 "AA" 出现在 0/1/2 三处（stride 会只数出 2 处）
  assert.equal(countOccurrences('AAAA', 'AA'), 3);
  assert.equal(countOccurrences('作息时间', '息时'), 1);
});

test('纯函数：二元组命中也能召回（低权重保召回，不至于全是噪音）', () => {
  // "年级"只作为二元组出现（a.md 里的"一、二年级学生"），不是查询里的整串或切分词
  const bigram = searchDocuments(DOCS, '年级', { limit: 5 });
  const full = searchDocuments(DOCS, '转专业', { limit: 5 });
  assert.ok(bigram.count > 0, '二元组要能召回');
  for (const item of bigram.items) assert.ok(item.matches.includes('年级'));
  assert.ok(bigram.count < full.count, '二元组召回不该多于整词');

  // DOCS 里 a 写了"一、二年级学生可申请"：二元组权重低于整词
  const a = full.items.find((item) => item.path === 'a.md');
  const b = bigram.items.find((item) => item.path === 'a.md');
  assert.ok(a.score > b.score, '整词命中的分数应高于二元组命中');
});

test('纯函数：limit 与空查询', () => {
  assert.equal(searchDocuments(DOCS, '转专业', { limit: 2 }).count, 2);
  assert.deepEqual(searchDocuments(DOCS, '', { limit: 5 }).items, []);
  assert.deepEqual(searchDocuments([], '转专业').items, []);
});

/* ------------------------------------------------------------------ 片段 */

test('纯函数：片段 = 命中位置前后各约 snippetChars/2，首尾带省略号', () => {
  const head = '前'.repeat(600);
  const tail = '后'.repeat(600);
  const doc = { title: '长文', path: 's.md', text: `${head}关键条款在这里${tail}` };
  const [item] = searchDocuments([doc], '关键条款', { snippetChars: 240 }).items;
  assert.equal(item.matches.includes('关键条款'), true);
  assert.ok(item.snippet.includes('关键条款'), '片段必须包含命中位置');
  assert.ok(item.snippet.startsWith(ELLIPSIS), '前面被截断要有省略号');
  assert.ok(item.snippet.endsWith(ELLIPSIS), '后面被截断要有省略号');
  assert.ok(item.snippet.length <= 240 + 2, `片段长度应该在 snippetChars 附近：${item.snippet.length}`);
  assert.ok(item.snippet.length > 200, '不该截得太短，片段要够引用的上下文');
  // 片段窗口确实是以命中点为中心的（左侧 120 字上下文）
  const inside = item.snippet.slice(1, -1);
  assert.ok(inside.includes('关键条款'));
  assert.ok(inside.indexOf('关键条款') <= 130, '命中点应该落在窗口的左半部分');
});

test('纯函数：短文命中时不加省略号（片段就是全文）', () => {
  const doc = { title: '短公告', path: 's.md', text: '转专业 条件 与 申请流程。' };
  const [item] = searchDocuments([doc], '转专业', { snippetChars: 240 }).items;
  assert.equal(item.snippet.includes(ELLIPSIS), false);
  assert.equal(item.snippet, doc.text);
});

test('纯函数：只有标题命中时，片段给正文开头（帮助判断这篇讲什么）', () => {
  const text = '内容'.repeat(300);
  const [item] = searchDocuments([{ title: '转专业实施细则', path: 't.md', text }], '转专业').items;
  assert.equal(item.matches.includes('转专业'), true);
  assert.ok(item.snippet.startsWith('内容'), '正文里没命中就给开头');
  assert.ok(item.snippet.endsWith(ELLIPSIS));
  assert.ok(item.snippet.length <= 242);
});

test('纯函数：没有可检索正文的篇目，片段如实说明"正文在图片/附件里"', () => {
  const docs = [
    { title: '校历', path: 'xl.md', kind: 'portal', text: '' },
    { title: '课程调整申请表', path: 'bg.md', kind: 'attachments', text: '' },
    { title: '站外入口清单', path: 'wb.md', kind: 'external-links', text: '' },
  ];
  const result = searchDocuments(docs, '校历', { limit: 5 });
  assert.equal(result.count, 1, '图片页靠标题也要能搜到');
  assert.equal(result.items[0].snippet, NO_TEXT_NOTE);
  // 其余两篇的标题不含"校历"，不该被召回
  assert.equal(result.items[0].path, 'xl.md');
});

test('纯函数：stripMarkdown 去掉图片、压平链接、不残留表格分隔行', () => {
  const raw = [
    '# 标题',
    '',
    '[![图片](http://a/b.jpg)](http://a/b.jpg)',
    '',
    '| | 项目 | 时间 |',
    '| --- | --- | --- |',
    '| | 第一节课 | 8:00 |',
    '',
    '**加粗**与[附件1：指南.pdf](https://x/y.pdf)',
  ].join('\n');
  const clean = stripMarkdown(raw);
  assert.equal(clean.includes('http://'), false, '图片与链接的地址不该留在片段里');
  assert.equal(clean.includes('!['), false);
  assert.equal(clean.includes('---'), false, '表格分隔行要丢掉');
  assert.ok(clean.includes('第一节课'));
  assert.ok(clean.includes('附件1：指南.pdf'), '链接文字（附件名）信息量高，要保留');
  assert.ok(clean.includes('加粗'));
});

/* ------------------------------------------------------------------ 降级与边界（临时语料） */

const tmpDirs = [];

/** 建一个临时语料目录；`files` 是相对路径 → 内容。 */
function corpusDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-knowledge-'));
  tmpDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 指向临时语料的 KnowledgeService。
 *
 * 走**构造函数选项** `corpusDir`，而不是在同一个进程里改 `process.env`：
 * `CORPUS_DIR` 是模块加载时求值的常量，import 之后再改环境变量已经晚了
 * （env 覆盖的用例见文件末尾那条子进程测试，那里在 import 之前就把变量设好了）。
 */
const serviceAt = async (dir) => {
  const knowledge = new KnowledgeService({ log: () => {}, corpusDir: dir });
  await knowledge.restore();
  return knowledge;
};

test('边界：语料目录不存在 → available:false + reason，检索返回空结果而不抛错', async () => {
  const missing = path.join(os.tmpdir(), `potato-knowledge-missing-${Date.now()}`);
  const knowledge = await serviceAt(missing);
  const stats = knowledge.stats();
  assert.equal(stats.available, false);
  assert.match(stats.reason, /index\.json/, 'reason 要说清是缺索引');
  assert.equal(stats.counts.documents, 0);
  assert.deepEqual(stats.categories, []);
  assert.equal(knowledge.search({ q: '转专业' }).available, false);
  assert.equal(knowledge.search({ q: '转专业' }).count, 0);
  assert.throws(() => knowledge.read({ path: 'a.md' }), (error) => error.status === 400);
  const check = knowledge.check();
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((line) => line.includes('index.json')));
});

test('边界：index.json 是坏 JSON → 降级为空语料，不抛错', async () => {
  const dir = corpusDir({ 'index.json': '{ "categories": [ 这不是 JSON' });
  const knowledge = await serviceAt(dir);
  assert.equal(knowledge.stats().available, false);
  assert.match(knowledge.stats().reason, /JSON/);
  assert.equal(knowledge.search({ q: '转专业' }).count, 0);
  const check = knowledge.check();
  assert.equal(check.ok, false, '索引坏了，自检不能报 ok');
  assert.ok(check.problems.some((line) => line.includes('index.json')));
});

test('边界：索引合法但没有篇目 → 也算不可用（reason 说清"没有任何篇目"）', async () => {
  const dir = corpusDir({ 'index.json': JSON.stringify({ source: 'dean.xjtu.edu.cn', categories: [] }) });
  const knowledge = await serviceAt(dir);
  const stats = knowledge.stats();
  assert.equal(stats.available, false);
  assert.match(stats.reason, /没有任何篇目/);
  assert.equal(knowledge.search({ q: '转专业' }).count, 0);
});

test('边界：只有图片页（portal/attachments）的语料，标题能搜到、片段如实说明、自检要报缺文件', async () => {
  const dir = corpusDir({
    'xk/01-校历.md': ['---', 'title: "校历"', 'kind: portal', '---', '', '# 校历', '', '![图片](http://x/y.jpg)'].join('\n'),
    'index.json': JSON.stringify({
      source: 'dean.xjtu.edu.cn',
      generatedAt: '2026-10-12T00:00:00.000Z',
      counts: { categories: 1, documents: 2, chars: 20 },
      categories: [
        {
          slug: 'xk',
          label: '信息服务 / 校历',
          listingUrl: 'https://dean.xjtu.edu.cn/xk.htm',
          count: 2,
          items: [
            { title: '校历', url: 'https://dean.xjtu.edu.cn/xk.htm', path: 'xk/01-校历.md', publishedAt: null, kind: 'portal' },
            { title: '作息时间', url: 'https://dean.xjtu.edu.cn/zxsj.htm', path: 'xk/02-作息.md', kind: 'attachments' },
          ],
        },
      ],
    }),
  });
  const knowledge = await serviceAt(dir);
  const stats = knowledge.stats();
  assert.equal(stats.available, true);
  assert.equal(stats.counts.documents, 2);
  assert.deepEqual(stats.categories[0].kinds, { portal: 1, attachments: 1 });

  const hit = knowledge.search({ q: '校历' });
  assert.equal(hit.count, 1, '图片页靠标题命中');
  assert.equal(hit.items[0].title, '校历');
  assert.equal(hit.items[0].kind, 'portal');
  assert.equal(hit.items[0].snippet, NO_TEXT_NOTE);
  assert.equal(hit.items[0].url, 'https://dean.xjtu.edu.cn/xk.htm', '没有正文更要给得出出处');

  assert.equal(knowledge.search({ q: '完全无关的词' }).count, 0);
  assert.equal(knowledge.read({ path: 'xk/01-校历.md' }).title, '校历');

  // 第二篇在索引里、磁盘上没有 → check() 必须报出来（这就是"索引飘了"的样子）
  const check = knowledge.check();
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((line) => line.includes('02-作息.md')));
});

test('边界：正文被手改过 → check() 报"内容与索引不一致"，且带 path', async () => {
  const body = '# 转专业实施细则\n\n第一条 为规范转专业工作。';
  const dir = corpusDir({
    'gz/01.md': ['---', 'title: "转专业实施细则"', '---', '', body].join('\n'),
    'index.json': JSON.stringify({
      source: 'dean.xjtu.edu.cn',
      categories: [
        {
          slug: 'gz',
          label: '规章',
          count: 1,
          items: [{ title: '转专业实施细则', url: 'https://x/y.htm', path: 'gz/01.md', chars: body.length, sha256: sha256(body) }],
        },
      ],
    }),
  });
  const clean = await serviceAt(dir);
  assert.deepEqual(clean.check(), { ok: true, problems: [] });

  // 改了正文、索引没重建 → 必须报出来（并指出是哪一篇）
  fs.writeFileSync(path.join(dir, 'gz', '01.md'), ['---', 'title: "转专业实施细则"', '---', '', body, '第二条 新增条款。'].join('\n'), 'utf8');
  const broken = await serviceAt(dir);
  const check = broken.check();
  assert.equal(check.ok, false);
  assert.equal(check.problems.length, 1);
  assert.match(check.problems[0], /gz\/01\.md/);
  assert.match(check.problems[0], /不一致/);
});

test('边界：临时语料里也能正常检索与读全文（含索引里的仓库相对路径）', async () => {
  const body = '# 转专业实施细则\n\n第一条 申请转专业应满足下列条件：一、二年级在籍学生。';
  const dir = corpusDir({
    'gz/01.md': ['---', 'title: "转专业实施细则"', 'url: "https://dean.xjtu.edu.cn/info/1.htm"', '---', '', body].join('\n'),
    'index.json': JSON.stringify({
      source: 'dean.xjtu.edu.cn',
      categories: [
        {
          slug: 'gz',
          label: '规章制度 / 教务管理',
          count: 1,
          items: [
            {
              title: '转专业实施细则',
              url: 'https://dean.xjtu.edu.cn/info/1.htm',
              path: 'knowledge/dean/gz/01.md', // 抓取器写的是仓库相对路径，也要能认
              chars: body.length,
              sha256: sha256(body),
            },
          ],
        },
      ],
    }),
  });
  const knowledge = await serviceAt(dir);
  const hit = knowledge.search({ q: '转专业 条件' });
  assert.equal(hit.count, 1);
  assert.equal(hit.items[0].url, 'https://dean.xjtu.edu.cn/info/1.htm');
  assert.ok(hit.items[0].snippet.includes('条件'));

  // 两种 path 写法都要能读到同一篇
  for (const given of ['knowledge/dean/gz/01.md', 'gz/01.md']) {
    const doc = knowledge.read({ path: given });
    assert.equal(doc.title, '转专业实施细则');
    assert.ok(doc.content.includes('一、二年级在籍学生'));
  }
  assert.throws(() => knowledge.read({ path: '../index.json' }), (error) => error.status === 400);
  assert.deepEqual(knowledge.check(), { ok: true, problems: [] });
});

test('边界：PC_KNOWLEDGE_DIR 在 import 之前设置时生效（子进程验证）', () => {
  const body = '# 校历\n';
  const dir = corpusDir({
    'xl/01.md': ['---', 'title: "校历"', 'kind: portal', '---', '', body].join('\n'),
    'index.json': JSON.stringify({
      source: 'dean.xjtu.edu.cn',
      categories: [
        {
          slug: 'xl',
          label: '信息服务 / 校历',
          count: 1,
          items: [{ title: '校历', url: 'https://dean.xjtu.edu.cn/xl.htm', path: 'xl/01.md', chars: body.length, sha256: sha256(body), kind: 'portal' }],
        },
      ],
    }),
  });
  // 环境变量必须在 import **之前**设好：`CORPUS_DIR` 是模块加载时求值的常量
  const script = `
const { CORPUS_DIR, KnowledgeService } = await import(${JSON.stringify(SERVICE_URL)});
const knowledge = new KnowledgeService({ log: () => {} });
await knowledge.restore();
process.stdout.write(JSON.stringify({ dir: CORPUS_DIR, stats: knowledge.stats() }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, PC_KNOWLEDGE_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `子进程失败：${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.dir, dir, 'PC_KNOWLEDGE_DIR 覆盖了语料目录');
  assert.equal(out.stats.counts.documents, 1);
  assert.equal(out.stats.categories[0].slug, 'xl');
});
