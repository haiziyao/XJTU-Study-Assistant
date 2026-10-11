/**
 * 学情分析（步骤 7）的测试。
 *
 * 这条链路最容易出问题的地方不是"能不能调通模型"，而是**降级与新鲜度**：
 *   - 没配密钥时不能只显示"分析失败" —— 本地统计摘要本身就有价值，必须给出来；
 *   - 分析是对某一刻的数据做的，用户改了勾选或重新同步后旧结论就不成立了，
 *     这时界面必须能知道"它过期了"，否则会拿一份过时的点评去指导学生；
 *   - 数据没变时不该反复烧 token。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { fingerprintOf, localAnalysis } from '../src/modules/academic/analysis.js';
import { startMockEhall } from './helpers/ehall-mock.js';
import { startMockAi } from './helpers/ai-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';
const KEY = 'sk-test-academic-analysis';

/** @param {object} [options] @param {object} [options.ai] 传入则配好 AI */
async function startApp({ ai, mock: existing, dataDir: existingDir } = {}) {
  const mock = existing ?? (await startMockEhall());
  const dataDir = existingDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-academic-analysis-')));
  const app = await createServer({
    dataDir,
    academic: mock.config(),
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
  return { app, call, mock, dataDir };
}

/* ------------------------------------------------------------------ 纯函数 */

test('学情分析：指纹随数据变化，且与顺序无关', () => {
  const a = { externalId: 'W1', credit: 3, score: 90, gradePoint: 4, included: true, active: true };
  const b = { externalId: 'W2', credit: 2, score: 80, gradePoint: 3, included: true, active: true };
  const stats = { gpa: 3.6, totalCredits: 5 };

  const base = fingerprintOf([a, b], stats);
  assert.equal(fingerprintOf([b, a], stats), base, '同一组数据换顺序指纹应相同');

  // 改分数 / 改勾选 / 改学分，任何一个都要让指纹变
  assert.notEqual(fingerprintOf([{ ...a, score: 91 }, b], stats), base, '分数变了指纹要变');
  assert.notEqual(fingerprintOf([{ ...a, included: false }, b], stats), base, '勾选变了指纹要变');
  assert.notEqual(fingerprintOf([{ ...a, credit: 4 }, b], stats), base, '学分变了指纹要变');
  assert.notEqual(fingerprintOf([a], stats), base, '少了一门指纹要变');
  // 无效成绩不参与
  assert.equal(fingerprintOf([a, b, { externalId: 'W3', active: false, credit: 9 }], stats), base);
});

test('学情分析：本地兜底在没数据与有数据时都给得出话', () => {
  const empty = localAnalysis({ stats: { includedCount: 0 }, grades: [] });
  assert.match(empty, /还没有|先同步/);

  const text = localAnalysis({
    stats: {
      gpa: 3.29,
      weightedAverage: 84.4,
      totalCredits: 10,
      includedCount: 3,
      terms: [
        { term: '2024-2025-1', termLabel: '大一上', gpa: 3.7 },
        { term: '2024-2025-2', termLabel: '大一下', gpa: 2.5 },
      ],
    },
    grades: [
      { courseName: '高等数学', credit: 5, gradePointResolved: 4, included: true, active: true },
      { courseName: '工程制图', credit: 2, gradePointResolved: 1.5, included: true, active: true },
      { courseName: '形势与政策', credit: 1, gradePointResolved: null, gradePoint: null, included: false, active: true },
    ],
  });
  assert.match(text, /3\.290/, '应给出学分绩');
  assert.match(text, /84\.40/, '应给出加权平均分');
  assert.match(text, /工程制图/, '应点出拖后腿的课');
  assert.match(text, /大一上|大一下/, '应指出学期差异');
  assert.match(text, /未计入学分绩/, '应说明有课程没算进去');
  assert.match(text, /本地统计/, '要如实标明这是本地统计而不是 AI 点评');
});

/* ------------------------------------------------------------------ 无 AI 时的降级 */

test('学情分析：没有成绩时明确说"先同步"，而不是编一段话', async () => {
  const { app, call, mock } = await startApp();
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS, sync: false });

    const state = await call('GET', '/academic/analysis');
    assert.equal(state.body.available, false);
    assert.equal(state.body.hasData, false);

    const generated = await call('POST', '/academic/analysis', {});
    assert.equal(generated.status, 200);
    assert.equal(generated.body.ok, false);
    assert.equal(generated.body.reason, 'NO_DATA');
    assert.match(generated.body.message, /先同步/);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('学情分析：★ 未配置 AI 时退化为本地摘要，而不是报错', async () => {
  const { app, call, mock } = await startApp();
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS });

    const generated = await call('POST', '/academic/analysis', {});
    assert.equal(generated.status, 200, '没配 AI 也必须给得出东西');
    assert.equal(generated.body.ok, true);
    assert.equal(generated.body.source, 'local');
    assert.ok(generated.body.text.length > 20);
    assert.equal(generated.body.basis.gpa, 3.29, '应带上生成时的口径');
    assert.ok(generated.body.error, '应记录降级原因，便于用户知道为什么没有 AI 点评');

    const state = await call('GET', '/academic/analysis');
    assert.equal(state.body.available, true);
    assert.equal(state.body.stale, false);
    assert.equal(state.body.source, 'local');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 新鲜度与缓存 */

test('学情分析：改了勾选后旧分析标记为过期', async () => {
  const { app, call, mock } = await startApp();
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS });
    await call('POST', '/academic/analysis', {});
    assert.equal((await call('GET', '/academic/analysis')).body.stale, false);

    // 排除一门课 —— 结论就变了
    const grades = (await call('GET', '/academic/grades')).body.items;
    const target = grades.find((g) => g.courseName === '高等数学');
    await call('POST', `/academic/grades/${target.id}/included`, { included: false });

    const after = await call('GET', '/academic/analysis');
    assert.equal(after.body.stale, true, '勾选变了，旧结论不再代表现状');
    assert.ok(after.body.text, '过期也要能读到旧内容，由界面决定怎么提示');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('学情分析：数据没变时命中缓存，force 才重新生成', async () => {
  const { app, call, mock } = await startApp();
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS });
    const first = await call('POST', '/academic/analysis', {});
    assert.equal(first.body.cached, false);

    const second = await call('POST', '/academic/analysis', {});
    assert.equal(second.body.cached, true, '数据没变不该重复生成');
    assert.equal(second.body.createdAt, first.body.createdAt);

    const forced = await call('POST', '/academic/analysis', { force: true });
    assert.equal(forced.body.cached, false, 'force 应绕过缓存');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 接了 AI */

test('学情分析：配置了 AI 时用模型写点评，并记录模型名', async () => {
  const aiMock = await startMockAi({
    apiKey: KEY,
    reply: '整体处于中上水平。高等数学表现稳定，工程制图是明显的短板，建议优先补上。另有 1 门课未计入学分绩。',
  });
  const { app, call, mock } = await startApp({ ai: { apiKey: KEY, baseUrl: aiMock.baseUrl, model: 'mock-chat' } });
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS });
    const generated = await call('POST', '/academic/analysis', {});

    assert.equal(generated.body.source, 'ai');
    assert.equal(generated.body.model, 'mock-chat');
    assert.match(generated.body.text, /工程制图/);
    assert.equal(generated.body.error, null);

    // 材料里应包含真实的成绩数据，而不是空壳
    const sent = JSON.stringify(aiMock.state.bodies[0]);
    assert.match(sent, /高等数学/, '模型应看到课程名');
    assert.match(sent, /notCounted/, '模型应看到"没算进学分绩"的部分');
    assert.equal(aiMock.state.calls, 1);
  } finally {
    await app.close();
    await mock.close();
    await aiMock.close();
  }
});

test('学情分析：AI 上游故障时回落到本地摘要，并记下原因', async () => {
  const aiMock = await startMockAi({ apiKey: KEY, failWith: [1] });
  const { app, call, mock } = await startApp({ ai: { apiKey: KEY, baseUrl: aiMock.baseUrl, model: 'mock-chat' } });
  try {
    await call('POST', '/academic/login', { username: USER, password: PASS });
    const generated = await call('POST', '/academic/analysis', {});

    assert.equal(generated.status, 200, '上游挂了也不该让整个请求失败');
    assert.equal(generated.body.source, 'local');
    assert.ok(generated.body.error, '应记录失败原因');
    assert.ok(generated.body.text.length > 20);
  } finally {
    await app.close();
    await mock.close();
    await aiMock.close();
  }
});

test('学情分析：结果落盘，重启后仍能读到', async () => {
  const mock = await startMockEhall();
  const first = await startApp({ mock });
  let record;
  try {
    await first.call('POST', '/academic/login', { username: USER, password: PASS });
    record = (await first.call('POST', '/academic/analysis', {})).body;
  } finally {
    await first.app.close();
  }

  const second = await startApp({ mock, dataDir: first.dataDir });
  try {
    const state = await second.call('GET', '/academic/analysis');
    assert.equal(state.body.available, true, '分析结果应已落盘');
    assert.equal(state.body.text, record.text);
  } finally {
    await second.app.close();
    await mock.close();
  }
});
