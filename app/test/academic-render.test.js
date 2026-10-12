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
    // ⚠️ 每次都返回**新对象**：视图在点击勾选框后会把 included 写回列表元素，
    // 若共用同一批对象，前一个用例的改动会污染后一个用例（会表现为"顺序一变就挂"）。
    if (url.startsWith('/academic/grades')) return { items: [{ ...GRADE_INCLUDED }, { ...GRADE_EXCLUDED }], count: 2 };

    if (url.startsWith('/academic/stats')) {
      return {
        gpa: 3.29,
        weightedAverage: 84.4,
        totalCredits: 10,
        earnedCredits: 11,
        includedCount: 3,
        // 学期细分：界面上的学期分隔行直接读它，不另算一套
        terms: [
          { term: '2024-2025-1', termLabel: '2024-2025学年第一学期', courses: 1, credits: 5, gpa: 4 },
          { term: '2024-2025-2', termLabel: '2024-2025学年第二学期', courses: 1, credits: 1, gpa: null },
        ],
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

test('学业视图：未登录时给的是引导卡，不是登录表单', async () => {
  const { api } = makeApi({ '/academic/status': { status: 'anonymous', loggedIn: false } });
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  // 登录已收敛到「设置 → 统一身份认证」（教务与学堂用的是同一个学校账号），
  // 所以这里**不该**再有密码输入框 —— auth-render.test.js 里有同类断言。
  const inputs = walk(mount).filter((node) => node.tagName === 'INPUT');
  assert.equal(
    inputs.filter((node) => node.type === 'password').length,
    0,
    '学业视图不该再出现密码输入框',
  );
  assert.ok(findButton(mount, '去设置里登录'), '应当给一个去设置里登录的按钮');

  const text = textsOf(mount);
  assert.match(text, /统一身份认证/, '要说清登录入口在哪');
  assert.match(text, /同一个学校账号/, '要说明为什么只需要登一次');
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

  // 勾选框现在有两类：课程行那个「计入」+ 学期行那个三态「整学期计入」。
  // 这里只数课程行的（按 `data-grade-id` 认，比按位置稳）。
  const checks = walk(mount).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
  const rowChecks = checks.filter((node) => node.dataset?.gradeId);
  assert.equal(rowChecks.length, 2, '两门课各一个「计入」勾选框');
  assert.equal(rowChecks.map((node) => node.dataset.gradeId).join(','), 'g1,g2');
  assert.equal(rowChecks[0].checked, true);
  assert.equal(rowChecks[1].checked, false, '被排除的课勾选框应为未选中');
  // 学期行另有整学期开关：两门课分属两个学期，所以是两个三态框
  assert.equal(checks.length - rowChecks.length, 2, '每个学期行一个三态「整学期计入」');

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
  const box = checks.find((node) => node.dataset?.gradeId === 'g1');
  assert.ok(box, '要能找到 g1 那一行的勾选框');
  const handler = box.listeners?.change?.[0];
  assert.equal(typeof handler, 'function', '勾选框应挂上 change 监听');
  box.checked = false;
  handler();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(
    calls.some((entry) => entry === 'POST /academic/grades/g1/included'),
    `应调用单项开关接口，实际调用：${calls.join(' | ')}`,
  );
});

test('学业视图：学期行有「整学期计入」三态开关，点击按整学期提交', async () => {
  const { api, calls } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const toggles = walk(mount).filter(
    (node) => node.tagName === 'INPUT' && node.type === 'checkbox' && !node.dataset?.gradeId,
  );
  assert.equal(toggles.length, 2, '两个学期各一个整学期开关');

  // 只有一个学期是"全部计入"（g1），另一个是"全不选"（g2 被排除）→ 三态要如实反映
  const states = toggles.map((node) => ({ checked: node.checked, mixed: node.indeterminate }));
  assert.deepEqual(states, [
    { checked: true, mixed: false },
    { checked: false, mixed: false },
  ]);

  const handler = toggles[1].listeners?.change?.[0];
  assert.equal(typeof handler, 'function', '整学期开关要挂 change 监听');
  toggles[1].checked = true;
  handler();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 用 ids 提交（不是 term）：学期分组里可能有"未标注学期"，按 term 会打偏
  const bulkCall = calls.find((entry) => entry.includes('/academic/grades/included/bulk'));
  assert.ok(bulkCall, `应调用批量接口，实际调用：${calls.join(' | ')}`);
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

/* ------------------------------------------------------------------ 布局约定

   这一组是**用户实测反馈**后补的：原先内容直接 append 到 `.panel-body` 上，
   而它的样式是 `display:flex; flex-direction:column; overflow:hidden`、
   **没有内边距也不滚动** —— 表现就是「无论 UI 还是字体都贴着边缘，而且不能上下滚」。
   修法是把内容放进共享的 `.view-content`（`flex:1; overflow:auto; padding:12px 14px 16px`），
   按钮放进 `.toolbar`（固定在顶部不随滚动）。下面几条把这些约定钉死。 */

test('学业视图：内容放在 .view-content 里，而不是直接挂在 .panel-body 上', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const content = findByClass(mount, 'view-content');
  assert.equal(content.length, 1, '必须有且只有一个 .view-content（内边距与滚动由它提供）');

  // `.panel-body`（即 mount）的直接子元素里不该出现卡片/统计/表格 ——
  // 出现就说明又绕过 .view-content 了，会重新变成贴边且不能滚
  for (const node of mount.children) {
    const cls = String(node.className);
    for (const bad of ['ac-card', 'ac-stats', 'ac-analysis', 'ac-bulk']) {
      assert.ok(!cls.includes(bad), `「${bad}」不能直接挂在 .panel-body 上（会贴边且无法滚动）`);
    }
  }

  // 卡片应该都在 view-content 里面
  assert.ok(findByClass(content[0], 'ac-card').length >= 3, '卡片应全部位于 .view-content 内');
});

test('学业视图：工具条用共享的 .toolbar 类（自带左右内边距并固定在顶部）', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const bars = findByClass(mount, 'toolbar');
  assert.equal(bars.length, 1, '应有且只有一个 .toolbar');
  assert.equal(bars[0].parentNode, mount, '.toolbar 应是 .panel-body 的直接子元素（这样它不随内容滚动）');
  assert.ok(findButton(bars[0], '同步成绩'), '同步按钮应在工具条里');
  assert.ok(findButton(bars[0], '退出登录'), '退出登录应在工具条里');
});

/* ------------------------------------------------------------------ 学期分隔 */

/** 按学期分隔行把 tbody 切成若干组。 */
function termGroups(mount) {
  const tbody = walk(mount).find((node) => node.tagName === 'TBODY');
  if (!tbody) return [];
  const groups = [];
  for (const row of tbody.children) {
    if (String(row.className).includes('ac-term-row')) groups.push({ header: row, rows: [] });
    else if (groups.length) groups[groups.length - 1].rows.push(row);
  }
  return groups;
}

test('学业视图：成绩按学期分组，每组一条分隔行并给出该学期口径', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const groups = termGroups(mount);
  assert.equal(groups.length, 2, '两门课分属两个学期，应分成两组');

  const names = findByClass(mount, 'ac-term-name').map((node) => node.textContent);
  assert.deepEqual(names, ['2024-2025学年第一学期', '2024-2025学年第二学期'], '学期名应来自 termLabel');

  // 每组的分隔行都必须排在它自己的课程行之前，且课程行数对得上
  for (const group of groups) {
    assert.equal(group.rows.length, 1, `「${group.header.textContent}」应有 1 行课程`);
    assert.equal(group.rows[0].children.length, 6, '课程行应为 6 列（学期已提到分隔行，不再占一列）');
  }
  // tbody 的第一行就是分隔行，不能直接是课程行
  assert.ok(String(groups[0].header.className).includes('ac-term-row'));
  assert.equal(mount.textContent.includes('学期学分绩'), true, '分隔行要给出该学期学分绩（取自 stats.terms，不另算一套）');
});

test('学业视图：某学期有课程未计入时，那一组的分隔行要说明', async () => {
  const { api } = makeApi();
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  const metas = findByClass(mount, 'ac-term-meta').map((node) => node.textContent);
  assert.equal(metas.length, 2);
  // 第一学期那门是纳入的 -> 不需要额外说明
  assert.doesNotMatch(metas[0], /已计入/, '全部纳入时不该出现「已计入」提示');
  // 第二学期那门是排除的 -> 要说明，否则用户会以为它算进去了
  assert.match(metas[1], /已计入 0 门/, '有课程被排除时要说明');
});

/* ------------------------------------------------------------------ 登录后自动出分析 */

test('学业视图：★ 登录进来就有学情分析，不必手动点一次同步', async () => {
  // 复刻真实情形：登录接口本身会同步成绩，但不会生成分析；
  // 用户此时最想看到的恰恰是那段点评。
  const { api, calls } = makeApi({
    '/academic/analysis': (url, options) =>
      options.method === 'POST'
        ? { ok: true, text: '自动补上的学情分析。', source: 'local', stale: false }
        : { available: false, hasData: true },
  });
  const { render } = bootRenderer({ api });
  const mount = await render('academic');

  assert.ok(
    calls.some((entry) => entry === 'POST /academic/analysis'),
    `有成绩但没有分析时应自动生成，实际调用：${calls.join(' | ')}`,
  );
  assert.match(textsOf(mount), /自动补上的学情分析/, '生成后应直接展示出来');
});

test('学业视图：没有成绩时不会去硬生成分析', async () => {
  const { api, calls } = makeApi({
    '/academic/grades': { items: [], count: 0 },
    '/academic/stats': { gpa: null, includedCount: 0, totalCredits: 0, earnedCredits: 0, terms: [], warnings: [], needsAttention: [] },
    '/academic/analysis': { available: false, hasData: false },
  });
  const { render } = bootRenderer({ api });
  await render('academic');

  assert.ok(
    !calls.some((entry) => entry === 'POST /academic/analysis'),
    '没成绩时不该调生成接口',
  );
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
