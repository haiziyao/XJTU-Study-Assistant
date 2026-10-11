/**
 * 学业视图的渲染测试：用 DOM 桩真实跑一遍 `render()`，再断言节点结构。
 *
 * 重点不在"像素好不好看"，而在几条会被用户直接看到的规则：
 *   - 没登录时给登录表单，而不是空白或报错；
 *   - 学分绩**直接展示后端算出来的数**（前端不自己算，否则两边会漂移）；
 *   - 未计入的课程行要能被一眼看出来（压暗），但不能被藏起来；
 *   - 分析卡必须如实标注来源（AI 点评 / 本地统计）与过期状态；
 *   - 勾选框点一下要真的打到后端接口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootRenderer } from './helpers/renderer-dom.js';

/* ------------------------------------------------------------------ 伪后端 */

const GRADE_INCLUDED = {
  id: 'g1',
  externalId: 'W1',
  courseName: '高等数学',
  credit: 5,
  score: 92,
  gradePoint: 4,
  gradePointResolved: 4,
  term: '2024-2025-1',
  termLabel: '2024-2025学年第一学期',
  natureLabel: '必修',
  included: true,
};

const GRADE_EXCLUDED = {
  id: 'g2',
  externalId: 'W4',
  courseName: '形势与政策',
  credit: 1,
  score: null,
  gradePoint: null,
  gradePointResolved: null,
  term: '2024-2025-2',
  termLabel: '2024-2025学年第二学期',
  natureLabel: '必修',
  included: false,
};

/**
 * @param {object} [overrides] 覆盖某个接口的返回
 */
function makeApi(overrides = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    for (const [prefix, value] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return typeof value === 'function' ? value(url, options) : value;
    }
    if (url.startsWith('/academic/status')) {
      return {
        status: 'ready',
        loggedIn: true,
        grades: { total: 2, active: 2, stale: 0, excluded: 1, terms: ['2024-2025-1'] },
        gpa: 3.29,
        lastSyncAt: '2026-10-11T02:00:00.000Z',
        handshake: { appId: '4768574631264620', weuRefreshed: true },
      };
    }
    if (url.startsWith('/academic/grades/included/')) return { changed: 1, stats: { gpa: 4 } };
    if (url.startsWith('/academic/grades/')) return { grade: {}, stats: { gpa: 4 } };
    if (url.startsWith('/academic/grades')) return { items: [GRADE_INCLUDED, GRADE_EXCLUDED], count: 2 };
    if (url.startsWith('/academic/stats')) {
      return {
        gpa: 3.29,
        weightedAverage: 84.4,
        totalCredits: 10,
        earnedCredits: 11,
        includedCount: 3,
        terms: [],
        warnings: ['1 门课没有绩点也没法从分数换算，未计入学分绩'],
        needsAttention: [{ courseName: '形势与政策', termLabel: '2024-2025学年第二学期', scoreText: '优秀' }],
      };
    }
    if (url.startsWith('/academic/terms')) {
      return { items: [{ term: '2024-2025-1', label: '2024-2025学年第一学期', courses: 2 }], count: 1 };
    }
    if (url.startsWith('/academic/analysis')) return overrides['/academic/analysis-default'] ?? { available: false };
    return {};
  };
  return { api, calls };
}

/** 收集挂载点下的所有元素（深度优先）。 */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

const textsOf = (mount) => walk(mount).map((node) => node.textContent).join('\n');
const findByClass = (mount, className) => walk(mount).filter((node) => String(node.className).split(' ').includes(className));
const buttonsOf = (mount) => walk(mount).filter((node) => node.tagName === 'BUTTON');
const findButton = (mount, label) => buttonsOf(mount).find((node) => node.textContent.includes(label));

/* ------------------------------------------------------------------ 用例 */

test('学业视图：未登录时给登录表单，并说明凭据去向', async () => {
  const { api } = makeApi({ '/academic/status': { status: 'anonymous', loggedIn: false } });
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const inputs = walk(mount).filter((node) => node.tagName === 'INPUT');
  assert.equal(inputs.length, 2, '应有学号与密码两个输入框');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[1].type, 'password', '密码框必须是 password 类型');
  assert.ok(findButton(mount, '登录'), '应有登录按钮');

  const text = textsOf(mount);
  assert.match(text, /统一身份认证/);
  assert.match(text, /不保存/, '要如实说明凭据不会被本程序保存');
});

test('学业视图：登录后展示后端算出的学分绩等指标', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const values = findByClass(mount, 'ac-stat-value').map((node) => node.textContent);
  assert.deepEqual(values, ['3.290', '84.40', '10.00'], '学分绩/加权/学分应直接展示后端给的值');
  assert.match(textsOf(mount), /其中已获得 11\.0/, '已获得学分要单独给出');
});

test('学业视图：成绩表逐行渲染，未计入的行压暗但不隐藏', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  // 只要 tbody 里的数据行（表头行是 TH，会一起被 TR 匹配到）
  const rows = walk(mount).filter(
    (node) => node.tagName === 'TR' && node.children.length >= 6 && node.children.every((cell) => cell.tagName === 'TD'),
  );
  assert.equal(rows.length, 2, '两门课各一行');

  const checks = walk(mount).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].checked, true);
  assert.equal(checks[1].checked, false, '被排除的课勾选框应为未选中');

  // 压暗而不隐藏：行还在、内容还能读到，只是加了标记类
  const off = rows.filter((row) => String(row.className).includes('ac-row-off'));
  assert.equal(off.length, 1);
  assert.match(textsOf(mount), /形势与政策/, '被排除的课仍要显示出来，用户得知道自己排除了什么');
  assert.match(textsOf(mount), /等级制/, '等级制课程要标注出来');
});

test('学业视图：点击勾选框会调用后端单项开关接口', async () => {
  const { api, calls } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const checks = walk(mount).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
  const handler = checks[0].listeners?.change?.[0];
  assert.equal(typeof handler, 'function', '勾选框应挂上 change 监听');
  checks[0].checked = false;
  handler();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(
    calls.some((entry) => entry === 'POST /academic/grades/g1/included'),
    `应调用单项开关接口，实际调用：${calls.join(' | ')}`,
  );
});

test('学业视图：分析卡如实标注来源与过期状态', async () => {
  const local = makeApi({
    '/academic/analysis': () => ({ available: true, text: '当前学分绩 3.290。', source: 'local', stale: true, error: 'AI 模块未装配' }),
  });
  const mountLocal = await bootRenderer({ api: local.api }).render('academic');
  const textLocal = textsOf(mountLocal);
  assert.match(textLocal, /本地统计/, '本地兜底必须标明来源，不能冒充 AI 点评');
  assert.match(textLocal, /已过期/, '过期要显眼标出来');
  assert.match(textLocal, /未使用 AI/, '要说明为什么没用上 AI');

  const ai = makeApi({
    '/academic/analysis': () => ({ available: true, text: '整体中上。', source: 'ai', model: 'mock-chat', stale: false, createdAt: '2026-10-11T02:00:00.000Z' }),
  });
  const mountAi = await bootRenderer({ api: ai.api }).render('academic');
  const textAi = textsOf(mountAi);
  assert.match(textAi, /AI 点评/);
  assert.match(textAi, /mock-chat/, '应显示用的哪个模型');
  assert.doesNotMatch(textAi, /已过期/);
});

test('学业视图：没有分析且没有数据时给出可操作的提示', async () => {
  const { api } = makeApi({ '/academic/analysis': { available: false, hasData: false } });
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const card = findByClass(mount, 'ac-analysis')[0];
  assert.ok(card, '应渲染分析卡');
  assert.match(card.textContent, /先同步/, '空态要告诉用户下一步做什么');
});

test('学业视图：把「需要留意」的课程与警告列出来', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const text = textsOf(mount);
  assert.match(text, /需要留意/);
  assert.match(text, /没有绩点也没法从分数换算/, '应展示后端的 warning');
  assert.match(text, /形势与政策/, '应列出未识别成绩形式的课程');
  assert.match(text, /等级制/, '要解释它为什么没进学分绩');
});

test('学业视图：空成绩列表时说明这个范围内没有成绩', async () => {
  const { api } = makeApi({ '/academic/grades': { items: [], count: 0 } });
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  assert.match(textsOf(mount), /这个范围内没有成绩/);
});

test('学业视图：同步按钮会真的打同步接口', async () => {
  const { api, calls } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const sync = findButton(mount, '同步成绩');
  assert.ok(sync, '应有同步按钮');
  sync.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(
    calls.includes('POST /academic/sync/apply'),
    `应调用同步接口，实际：${calls.join(' | ')}`,
  );
});
