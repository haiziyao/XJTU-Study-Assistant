/**
 * 通知视图的**纯逻辑**测试（不跑 DOM 渲染）。
 *
 * 这里只钉最容易被改坏、而且改坏了用户会误会的两条规则：
 *
 *   1. **校方只给到月份时，绝不补一个具体日子。**
 *      `publishedAt` 常见是 `2026-09`，如果格式化时补成 `2026-09-01`，
 *      用户会把它当成"9 月 1 日发的通知" —— 那是个编出来的事实。
 *      所以 `fmtPublished('2026-09')` 必须显式写出"（只到月份）"。
 *   2. **筛选是纯本地的**：`visible()` 只看内存里的数组，不发请求。
 *      站点/固定两个筛选是这个面板上唯一的交互状态，改它们不该触发联网。
 *
 * 用 vm 把脚本跑在一个最小的假环境里：只给 `window` / `document` 的骨架，
 * 视图注册函数记下来但不执行渲染。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'src', 'renderer', 'views', 'notifications.js');

/** 极简 DOM 节点：只满足脚本里 `createElement` + `append` 的用法。 */
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    attributes: {},
    style: {},
    append(...kids) {
      for (const kid of kids) node.children.push(kid);
    },
    appendChild(kid) {
      node.children.push(kid);
      return kid;
    },
    replaceChildren(...kids) {
      node.children = [...kids];
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return node;
}

/** 把视图脚本跑起来，返回它暴露的测试缝。 */
async function bootView() {
  const source = await readFile(SCRIPT, 'utf8');
  const registered = { views: [], settings: [] };
  const calls = [];

  const sandbox = {
    console,
    setTimeout,
    document: {
      createElement: (tag) => makeNode(tag),
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
    },
    PC: {
      api: async (route, options) => {
        calls.push({ route, options });
        return { items: [], total: 0, pinned: 0, bySite: [], retentionDays: 90 };
      },
      toast: () => {},
    },
    PCModules: {
      register: (view) => registered.views.push(view),
      registerSettingsSection: (section) => registered.settings.push(section),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: SCRIPT });
  return { seam: sandbox.__PC_NOTIF_TEST__, registered, calls, sandbox };
}

test('通知视图与设置分区都已注册', async () => {
  const { registered } = await bootView();
  assert.equal(registered.views.length, 1);
  assert.equal(registered.views[0].id, 'notifications');
  assert.equal(registered.views[0].label, '通知');
  assert.equal(registered.views[0].order, 35);
  assert.equal(registered.views[0].icon, '📣');

  assert.equal(registered.settings.length, 1, '设置页要能登记一个「通知」分区');
  assert.equal(registered.settings[0].id, 'notifications.settings');
  assert.equal(registered.settings[0].title, '通知');
});

test('★ 校方只给到月份时，不补一个具体日子', async () => {
  const { seam } = await bootView();
  assert.equal(seam.fmtPublished('2026-09'), '2026-09（只到月份）');
  // 完整日期原样（只到分钟）
  assert.equal(seam.fmtPublished('2026-09-15'), '2026-09-15');
  assert.equal(seam.fmtPublished('2026-09-15T02:30:00Z'), '2026-09-15 02:30');
  // 没有发布日期时要让调用方自己决定怎么显示（空串，不要编）
  assert.equal(seam.fmtPublished(''), '');
  assert.equal(seam.fmtPublished(null), '');
});

test('时间格式化：T 换空格、只到分钟、不因时区串到前一天', async () => {
  const { seam } = await bootView();
  assert.equal(seam.fmt('2026-10-18T16:40:00.000Z'), '2026-10-18 16:40');
  // 校方常给不带时区的串，按字面量切，不能被当成 UTC 再转本地
  assert.equal(seam.fmt('2026-10-18T00:05:00'), '2026-10-18 00:05');
  assert.equal(seam.fmt('not-a-date'), 'not-a-date');
});

test('★ 筛选是纯本地的：改站点/固定只过滤内存，不发请求', async () => {
  const { seam, calls } = await bootView();
  seam.ui.items = [
    { id: 'a', siteId: 'dean', pinned: true, title: 'A' },
    { id: 'b', siteId: 'gs', pinned: false, title: 'B' },
    { id: 'c', siteId: 'dean', pinned: false, title: 'C' },
  ];

  assert.equal(seam.visible().length, 3);

  seam.ui.filters.siteId = 'dean';
  assert.deepEqual(seam.visible().map((item) => item.id), ['a', 'c']);

  seam.ui.filters.pinned = true;
  assert.deepEqual(seam.visible().map((item) => item.id), ['a']);

  seam.ui.filters = { siteId: '', pinned: false };
  assert.equal(seam.visible().length, 3);
  assert.equal(calls.length, 0, '★ 筛选不该产生任何请求');
});

test('面板上没有「已读 / 未读」这套交互（按需求移除）', async () => {
  const { seam, registered } = await bootView();
  // 状态里不该再有 unread 相关的筛选
  assert.equal(Object.prototype.hasOwnProperty.call(seam.ui.filters, 'unreadOnly'), false);
  // 设置与视图都不该暴露标记已读的入口（函数名里带 read 的只有 readBody —— 读正文）
  const source = await readFile(SCRIPT, 'utf8');
  assert.equal(/markRead|unreadOnly|全部已读|标记已读/.test(source), false, '★ 已读功能应当整块移除');
  assert.ok(registered.views.length === 1);
});

test('★ 正文展开在条目下方：点同一条收起、点别的条目只留一个', async () => {
  const { seam } = await bootView();
  const itemA = { id: 'a', siteId: 'dean', pinned: false, title: 'A', url: 'https://x/a.htm' };
  const itemB = { id: 'b', siteId: 'dean', pinned: false, title: 'B', url: 'https://x/b.htm' };
  seam.ui.items = [itemA, itemB];
  seam.ui.filters = { siteId: '', pinned: false };

  // 渲染进一个假 mount，才能看结构
  const mount = makeNode('div');
  seam.ui.mount = mount;

  // 未展开时：两条都在，没有正文面板
  seam.paint();
  const html = () => JSON.stringify(mount, (key, value) => (key === 'children' ? value : value));
  const hasReader = (node) => {
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (String(cur.className).includes('notif-reader')) return true;
      for (const kid of cur.children ?? []) stack.push(kid);
    }
    return false;
  };
  assert.equal(hasReader(mount), false, '默认不该有正文面板');

  // 展开 A（busy 状态即可，不必真的去抓）
  seam.ui.reader = { id: 'a', title: 'A', url: 'https://x/a.htm', text: '正文', busy: false, error: null };
  seam.paint();
  assert.equal(hasReader(mount), true, '展开后应当出现正文面板');

  // ★ 展开的正文必须挂在那一条所在的 group 里，而不是列表顶部
  // 注意：每次 paint() 都会 replaceChildren 换掉整棵树，所以每次都要重新找，
  // 不能把上一次的节点引用留着用（那样读到的是旧树，断言会假过/假红）。
  const findList = () => {
    const stack = [mount];
    while (stack.length) {
      const cur = stack.pop();
      if (String(cur.className).includes('notif-list')) return cur;
      for (const kid of cur.children ?? []) stack.push(kid);
    }
    return null;
  };
  const list = findList();
  assert.ok(list, '应当有列表容器');
  const firstGroup = (list.children ?? []).find((kid) => String(kid.className).includes('notif-group'));
  assert.ok(firstGroup, '每一行外面应当有一层 group');
  assert.ok(hasReader(firstGroup), '★ 正文应当在该条目的 group 里（展开在原条目下方）');

  // 切到 B：A 收起，只剩 B 的
  seam.ui.reader = { id: 'b', title: 'B', url: 'https://x/b.htm', text: '正文', busy: false, error: null };
  seam.paint();
  const groups = (findList()?.children ?? []).filter((kid) => String(kid.className).includes('notif-group'));
  assert.equal(groups.length, 2);
  assert.equal(hasReader(groups[0]), false, '★ 点别的条目时，原来那条要收起');
  assert.equal(hasReader(groups[1]), true, '★ 新点的那条展开');

  // 再点一次同一个 → 收起
  seam.ui.reader = null;
  seam.paint();
  assert.equal(hasReader(mount), false, '★ 再点标题应当收回去');
});