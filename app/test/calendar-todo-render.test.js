/**
 * 待办页渲染层结构测试（分类筛选条 / 父子缩进 / 父行进度 / 表单字段）。
 *
 * 用 `test/helpers/renderer-dom.js` 的 DOM 桩真实跑一遍 render()，再断言节点结构 ——
 * 比 grep 源码字符串稳（改名 / 挪位置都还能查出来），又能跑在 node:test 里。
 *
 * 这里盯住四件事（都是"改坏了界面上立刻看得出来"的）：
 *   1. 顶部分类筛选条：全部 / 未分类 / 各分类，带条数，点一下真的改了筛选状态；
 *   2. 列表按「分类 → 顶层 → 子（缩进）」渲染，层级用 class 表达（CSP 禁行内 style）；
 *   3. 父行有展开箭头与 `1/2` 进度，收起后子行不渲染；
 *   4. 新建 / 编辑表单里有分类输入（带 datalist）与父待办选择（排除自己与后代）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_CSS = path.join(HERE, '../src/renderer/views/calendar.css');
const WEEKLY_CSS = path.join(HERE, '../src/renderer/views/weekly.css');
const WEEKLY_JS = path.join(HERE, '../src/renderer/views/weekly-panel.js');

/** 一条待办的公共形状（与真实 /todos 响应对齐，派生字段一个不少）。 */
function todo(overrides) {
  return {
    title: '待办',
    deadline: '2099-12-20',
    estimatedHours: 1,
    priority: 0,
    completed: false,
    completedAt: null,
    description: '',
    tags: [],
    source: 'manual',
    category: '',
    parentId: null,
    autoCompletedBy: null,
    childCount: 0,
    childDoneCount: 0,
    hasChildren: false,
    isOverdue: false,
    isToday: false,
    daysRemaining: 100,
    complexity: 'simple',
    complexityLabel: '简单',
    ...overrides,
  };
}

/**
 * 伪后端：一棵三层的树 + 两条分类。
 * p1(期末复习) ├─ c1(复习第一章，已完成)
 *              └─ c2(复习第二章) └─ g1(看例题)
 * p2(交实验报告，未分类)
 */
function makeApi() {
  const calls = [];
  const tree = [
    todo({
      id: 'p1',
      title: '期末复习',
      category: '期末复习',
      childCount: 2,
      childDoneCount: 1,
      hasChildren: true,
      children: [
        todo({ id: 'c1', title: '复习第一章', parentId: 'p1', category: '期末复习', completed: true, completedAt: '2099-12-01T00:00:00.000Z', children: [] }),
        todo({
          id: 'c2',
          title: '复习第二章',
          parentId: 'p1',
          category: '期末复习',
          childCount: 1,
          hasChildren: true,
          children: [todo({ id: 'g1', title: '看例题', parentId: 'c2', category: '期末复习', children: [] })],
        }),
      ],
    }),
    todo({ id: 'p2', title: '交实验报告', category: '', children: [] }),
  ];

  /** 周报面板的伪后端：一个"本周还没有正文"的统计快照（字段与 GET /weekly/report 一致）。 */
  const weeklyStats = {
    from: '2099-12-01',
    to: '2099-12-07',
    week: '2099-W49',
    days: 7,
    conversations: { newConversations: 1, messages: 3, userMessages: 2, assistantMessages: 1, activeConversations: 1, titles: [] },
    notes: { created: 2, updated: 3, updatedOnly: 1, deleted: 0, titles: [] },
    schedule: { todosCreated: 1, todosCompleted: 1, todosOpen: 2, todosOverdue: 0, todosDueSoon: 1, attention: [] },
    grades: { gpa: 3.42, includedCount: 10, total: 10, updated: 0, synced: 0, changed: false },
    partial: false,
    missing: [],
  };

  const api = async (url) => {
    calls.push(url);
    if (url.startsWith('/weekly/report?')) {
      return {
        ok: true,
        ...weeklyStats,
        stats: weeklyStats,
        cached: false,
        report: null,
        generatedAt: null,
        model: null,
        fallback: null,
        reason: null,
        statsChangedSinceReport: null,
        hint: '这一周还没有生成周报',
      };
    }
    if (url.startsWith('/weekly/reports')) return { items: [], count: 0, total: 0 };
    if (url.startsWith('/todos/categories')) {
      return { items: [{ name: '期末复习', total: 3, open: 2 }, { name: '', total: 1, open: 1 }] };
    }
    if (/^\/todos\/[^?]+$/.test(url)) {
      // 编辑器按 id 拉单条（GET /todos/:id）——返回的记录形状与真实接口一致
      const id = url.split('/').pop();
      const find = (nodes) => {
        for (const node of nodes) {
          if (node.id === id) return node;
          const hit = find(node.children ?? []);
          if (hit) return hit;
        }
        return null;
      };
      return { item: find(tree) };
    }
    if (url.startsWith('/todos?')) {
      return {
        items: tree,
        count: 2,
        totalCount: 4,
        stats: { total: 2, completed: 0, pending: 2, overdue: 0, completionRate: 0, plannedHours: 2 },
      };
    }
    return {};
  };
  api.calls = calls;
  return api;
}

function boot() {
  const api = makeApi();
  const state = {
    calendar: { mode: 'month', anchor: '2099-12-01', categories: {} },
    todo: { filter: 'all' },
    panelCollapsed: false,
  };
  return { api, state, ...bootRenderer({ api, state }) };
}

// 标题行里还有展开箭头 / 进度 / 标签，只取第一个 span（标题本身）
const rowTitles = (mount) =>
  mount.querySelectorAll('.todo-row').map((row) => (row.querySelector('.tr-title').querySelectorAll('span')[0] ?? {}).textContent);

test('分类筛选条：全部 / 未分类 / 各分类，带条数；点一下改筛选状态', async () => {
  const { mount, PC } = (() => {
    const booted = boot();
    return { PC: booted.PC, mount: booted };
  })();
  const rendered = await mount.render('todo', { wait: 30 });
  const chips = rendered.querySelectorAll('.cat-chip');
  const labels = chips.map((chip) => chip.textContent);
  assert.deepEqual(labels, ['全部 4', '未分类 1', '期末复习 3'], '分类条要有全部 / 未分类 / 各分类，并带条数');
  assert.ok(rendered.querySelector('.tcb-scroll'), '分类条要放在横向滚动容器里（手机上才不撑破页面）');

  // 默认「全部」是选中态
  assert.ok(chips[0].className.includes('active'), '默认选中「全部」');

  // 点「期末复习」→ 筛选状态落到 state.todo.category
  const subject = chips.find((chip) => chip.textContent.startsWith('期末复习'));
  subject.listeners.click[0]();
  assert.equal(PC.state.todo.category, '期末复习');

  // 再点一次同一个分类 = 取消筛选（回到全部）
  subject.listeners.click[0]();
  assert.equal(PC.state.todo.category, null);

  // 点「未分类」用的是空串（不是 null）：空串是"未分类"这个具体的桶
  const unclassified = chips.find((chip) => chip.textContent.startsWith('未分类'));
  unclassified.listeners.click[0]();
  assert.equal(PC.state.todo.category, '');
});

test('列表按「分类 → 顶层 → 子（缩进）」渲染，最多 3 层且每层有独立 class', async () => {
  const { render } = boot();
  const mount = await render('todo', { wait: 30 });

  const heads = mount.querySelectorAll('.group-head').map((head) => head.querySelector('.gh-date').textContent);
  assert.deepEqual(heads, ['期末复习', '未分类'], '分类分组：条数多的在前，未分类在后');

  const titles = rowTitles(mount);
  assert.deepEqual(titles, ['期末复习', '复习第一章', '复习第二章', '看例题', '交实验报告'], '子任务要紧跟在父任务后面');

  const levels = mount.querySelectorAll('.todo-row').map((row) => row.className.match(/todo-level-(\d)/)?.[1]);
  assert.deepEqual(levels, ['1', '2', '2', '3', '1'], '父 / 子 / 孙分别是 1 / 2 / 3 级');

  // 父行：展开箭头 + 1/2 进度
  const parentRow = mount.querySelectorAll('.todo-row')[0];
  assert.equal(parentRow.querySelector('.todo-parent-toggle').textContent, '▾', '默认展开，箭头朝下');
  assert.equal(parentRow.querySelector('.todo-parent-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(parentRow.querySelector('.todo-progress').textContent, '1/2', '父行显示「已完成子任务/子任务总数」');

  // 连带完成的子任务有「连带完成」标记（autoCompletedBy 非空）
  const autoBoot = bootRenderer({
    api: async (url) => {
      if (url.startsWith('/todos/categories')) return { items: [{ name: '复习', total: 2, open: 0 }] };
      if (url.startsWith('/todos?')) {
        return {
          items: [
            todo({
              id: 'p9',
              title: '父',
              category: '复习',
              childCount: 1,
              childDoneCount: 1,
              hasChildren: true,
              completed: true,
              children: [todo({ id: 'c9', title: '子', parentId: 'p9', category: '复习', completed: true, autoCompletedBy: 'p9' })],
            }),
          ],
          stats: { total: 1, completed: 1, pending: 0, overdue: 0, completionRate: 100, plannedHours: 1 },
        };
      }
      return {};
    },
    state: { calendar: { mode: 'month', anchor: '2099-12-01', categories: {} }, todo: { filter: 'all' }, panelCollapsed: false },
  });
  const autoMount = await autoBoot.render('todo', { wait: 30 });
  const tag = autoMount.querySelector('.tag.auto');
  assert.ok(tag, '被连带完成的子任务要有「连带完成」小标');
  assert.equal(tag.textContent, '连带完成');
});

test('收起父任务后子行不渲染（默认展开，状态记在 state.todo.collapsed）', async () => {
  const { render, PC } = boot();
  const first = await render('todo', { wait: 30 });
  assert.equal(first.querySelectorAll('.todo-row').length, 5, '默认展开：全部 5 行都在');

  const toggle = first.querySelector('.todo-parent-toggle');
  toggle.listeners.click[0]();
  assert.equal(PC.state.todo.collapsed.p1, true, '点一下箭头把父任务记为收起');

  const second = await render('todo', { wait: 30 });
  assert.deepEqual(rowTitles(second), ['期末复习', '交实验报告'], '收起后只剩父行与其它顶层项');
  assert.equal(second.querySelector('.todo-parent-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(second.querySelector('.todo-parent-toggle').textContent, '▸');
});

test('编辑器：分类输入带 datalist 建议，父待办下拉排除自己与后代、只列前两层', async () => {
  const { PC, window, api } = boot();
  const editor = window.PCModules.getService('editor');
  assert.equal(typeof editor, 'function', '编辑器通过 PCModules.service("editor") 暴露，测试才拿得到');
  editor({ target: 'todo', defaults: { deadline: '2099-12-01' } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const body = window.document.body;
  const category = body.querySelector('.f-todo-category');
  assert.ok(category, '待办表单要有分类输入框');
  assert.equal(category.getAttribute('list'), 'todo-category-suggestions');
  assert.equal(category.maxLength, 24, '分类最长 24 字（与服务端上限一致）');

  const datalist = body.querySelector('datalist');
  assert.ok(datalist, '分类建议要用 datalist（自由输入 + 已有分类建议）');
  assert.deepEqual(datalist.querySelectorAll('option').map((node) => node.value), ['期末复习'], '建议来自 /todos/categories，未分类不进建议');

  const parent = body.querySelector('.f-parent');
  assert.ok(parent, '待办表单要有父待办选择');
  const options = parent.querySelectorAll('option');
  assert.equal(options[0].textContent, '（无：作为顶层待办）');
  const values = options.map((node) => node.value);
  assert.ok(values.includes('p1'), '顶层待办可以当父');
  assert.ok(values.includes('c1'), '第二层待办可以当父（新任务成为第 3 层）');
  assert.ok(!values.includes('g1'), '第 3 层不能再当父（否则会超 3 层）');
  assert.equal(values.filter((value) => value === '').length, 1, '空值只出现在「无：作为顶层待办」这一项');
  assert.equal(api.calls.some((entry) => entry.includes('tree=1')), true, '候选来自树形列表');
});

test('编辑器：自带子树的待办不给超层的父级选项（服务端同样会 400）', async () => {
  const { window } = boot();
  const editor = window.PCModules.getService('editor');
  editor({ target: 'todo', id: 'p1' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const parent = window.document.body.querySelector('.f-parent');
  const values = parent.querySelectorAll('option').map((node) => node.value);
  // p1 下面还有两层（c1/c2 与 g1）：再往上挂就是第 4 层，所以一个候选都不给
  assert.deepEqual(values, [''], '只剩「无：作为顶层待办」一项');
});

test('分类条与缩进的样式：横向滚动、窄屏缩进收紧、不用行内 style', () => {
  const css = readFileSync(CALENDAR_CSS, 'utf8');
  assert.match(css, /\.tcb-scroll\s*\{[^}]*overflow-x:\s*auto/s, '分类条要横向滚动');
  assert.match(css, /\.tcb-scroll\s*\{[^}]*min-width:\s*0/s, 'min-width:0 才能不让 flex 子项撑破容器');
  assert.match(css, /\.cat-chip\s*\{[^}]*max-width/s, '单个分类名的宽度要设上限，避免撑出屏幕');
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.todo-row\.todo-level-3/s, '窄屏要收紧三级缩进');
  assert.match(css, /\.todo-row\.todo-level-2\s*\{[^}]*margin-left/s, '二级缩进由 class 控制');
  assert.match(css, /\.todo-row\.todo-level-3\s*\{[^}]*margin-left/s, '三级缩进由 class 控制');
});


test('周报面板样式：自建滚动容器、900px 断点、不写行内 style', () => {
  const css = readFileSync(WEEKLY_CSS, 'utf8');
  assert.match(css, /\.todo-weekly-host\s*\{[^}]*overflow:\s*auto/s, '周报容器要自己滚（与 .todo-list 同一份滚动契约）');
  assert.match(css, /\.todo-weekly-host\s*\{[^}]*min-height:\s*0/s, 'min-height:0 才能在 flex 里拿到确定高度');
  assert.match(css, /\.todo-weekly-host\s*\{[^}]*min-width:\s*0/s, 'min-width:0 防止长统计行撑破外壳');
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.wk-table-row\s*\{[^}]*flex-direction:\s*column/s, '手机上统计行改上下排');
  assert.match(css, /\.wk-report\s*\{[^}]*overflow-wrap:\s*anywhere/s, '长正文必须能断行，不能把页面撑宽');
  const js = readFileSync(WEEKLY_JS, 'utf8');
  assert.equal(/\.style\./.test(js), false, 'CSP 的 style-src self 会拦行内 style');
});

test('周报：待办页顶部有入口，点开显示统计与缺失项，返回后回到待办列表', async () => {
  const ctx = boot();
  const first = await ctx.render('todo', { wait: 30 });

  const entry = first.querySelector('.todo-weekly-btn');
  assert.ok(entry, '待办页工具栏里要有「学习周报」入口（这是唯一的界面入口）');
  assert.equal(entry.textContent, '学习周报');
  assert.equal(entry.getAttribute('aria-pressed'), 'false');

  // 点入口 → 服务打开面板；外壳的 PC.refresh 在测试桩里是 no-op，手动重画一次
  entry.listeners.click[0]();
  assert.equal(ctx.window.PCModules.getService('weeklyPanel').isOpen(), true, '点一下要真的打开周报');

  const panel = await ctx.render('todo', { wait: 30 });
  assert.ok(panel.querySelector('.wk-panel'), '打开后要有周报面板');
  assert.equal(panel.querySelector('.wk-title').textContent, '学习周报', '面板标题要一眼看出这是周报');
  assert.ok(panel.querySelector('.todo-list') === null, '面板打开时替换待办列表，不挤占主列表');
  assert.match(panel.querySelector('.wk-range').textContent, /2099-W49/, '面板要显示周区间');

  // 四个来源的统计行（卡片 / 目标已随功能移除，不该再出现）
  const keys = panel.querySelectorAll('.wk-table-key').map((node) => node.textContent);
  assert.deepEqual(keys, ['AI 对话', '笔记', '待办', '成绩']);
  const scheduleLine = panel.querySelectorAll('.wk-table-row').find((row) => row.querySelector('.wk-table-key').textContent === '待办');
  assert.match(scheduleLine.querySelector('.wk-table-value').textContent, /完成 1/);

  // 没有缺失项时给"都读到了"，不是空白
  assert.match(panel.querySelector('.wk-note').textContent, /生成会真的调用一次模型/);

  // 面板里的「← 返回待办」关掉面板，待办列表回来
  panel.querySelector('.wk-back').listeners.click[0]();
  assert.equal(ctx.window.PCModules.getService('weeklyPanel').isOpen(), false);
  const back = await ctx.render('todo', { wait: 30 });
  assert.ok(back.querySelector('.todo-list'), '关掉周报后待办列表要回来');
  assert.equal(back.querySelector('.wk-panel'), null, '关掉后不该残留面板节点');
});
