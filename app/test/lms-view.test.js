/**
 * 思源学堂视图的三级导航行为测试。
 *
 * 钉住四条"改一次就会坏、而且肉眼很难发现"的不变式：
 *   1. 课程页有**四个板块页签**，每个带条数（0 也显示）；
 *   2. **切页签不联网** —— 它只是本地过滤，点一下必须立刻出东西；
 *   3. 点活动行进**独立详情页**，不同板块给不同内容；
 *   4. 详情页的返回键回到**原来那个板块**，不是跳回第一个。
 *
 * 用 `test/helpers/mini-dom.js` 的桩 + 视图自己的测试缝（`__PC_LMS_TEST__`）。
 * 装配方式与 `sidebar-nav.test.js` 一致：把 index.html 引用的脚本按顺序求值一次，
 * 只是这里**不**把视图的 render 换成空实现 —— 要测的正是它的渲染。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { makeDom } from './helpers/mini-dom.js';

/** 一份课程页数据：四类各有内容，用来验证页签条数与内容切换。 */
const PAGE = {
  course: { id: 1001, name: '数据结构', courseCode: 'COMP2001', instructors: [{ name: '李老师' }], credit: '3.0' },
  groups: {
    homework: [
      { id: 5001, type: 'homework', title: '第一次作业：链表', startTime: '2026-10-05T08:00:00+08:00', endTime: '2026-10-14T23:59:00+08:00', userSubmitCount: 0 },
      { id: 5002, type: 'homework', title: '第二次作业：二叉树', userSubmitCount: 1 },
    ],
    material: [{ id: 5005, type: 'material', title: '课件：第 6 章' }],
    replay: [{ id: 5007, type: 'lesson', title: '第 5 周回放', replayCode: 'rc-5007', startTime: '2026-10-13T10:00:00+08:00' }],
    live: [{ id: 5004, type: 'lecture_live', title: '第 6 周直播课', startTime: '2026-10-13T10:00:00+08:00' }],
    other: [],
  },
  counts: { homework: 2, material: 1, replay: 1, live: 1, other: 0 },
  refreshError: null,
  loggedIn: true,
};

const DETAIL = {
  5001: {
    item: {
      id: 5001,
      type: 'homework',
      title: '第一次作业：链表',
      description: '<p>实现单链表并提交源码</p><ul><li>用 C 语言</li><li>不要用库函数</li></ul>',
      userSubmitCount: 0,
      averageScore: 82,
      uploads: [
        { id: 9001, name: '作业要求.pdf', size: 2048, kind: 'document', allowDownload: true, downloadUrl: '/lms/attachments/9001', previewUrl: '/lms/attachments/9001?inline=1' },
        { id: 9002, name: '评分细则.docx', size: 4096, kind: 'document', allowDownload: false, downloadUrl: null, previewUrl: '/lms/attachments/9002?inline=1' },
      ],
    },
  },
  5005: {
    item: {
      id: 5005,
      type: 'material',
      title: '课件：第 6 章',
      description: '第 6 章课件',
      uploads: [{ id: 9003, name: '第6章.pptx', size: 8192, kind: 'document', allowDownload: true, downloadUrl: '/lms/attachments/9003', previewUrl: '/lms/attachments/9003?inline=1' }],
    },
  },
  5007: { item: { id: 5007, type: 'lesson', title: '第 5 周回放', replayCode: 'rc-5007', uploads: [] } },
  5004: { item: { id: 5004, type: 'lecture_live', title: '第 6 周直播课', startTime: '2026-10-13T10:00:00+08:00', lessonStart: null, uploads: [] } },
};

const SUBMISSION = {
  activityId: '5001',
  submitted: false,
  count: 0,
  submissions: [],
};

async function bootView() {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-lms-view-')) });
  try {
    return await wire(app);
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function wire(app) {
  const info = await app.listen({ port: 0 });
  const origin = info.baseUrl.replace(/\/api\/v1$/, '');
  const html = await (await fetch(`${origin}/app/`)).text();
  const assets = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [];
  for (const asset of assets) scripts.push(await (await fetch(`${origin}/app/${asset}`)).text());

  const dom = makeDom();
  /** 被 window.open 打开过的地址（在线播放走这条路）。 */
  const opened = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, Date, Math, JSON, Promise, Error, TypeError,
    Number, String, Boolean, Array, Object, RegExp, Map, Set, Intl, isNaN, parseInt, parseFloat,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    WebSocket: function WebSocket() { this.close = () => {}; },
    location: { protocol: 'http:', host: '127.0.0.1:3210', hostname: '127.0.0.1', pathname: '/app/', search: '', hash: '', origin },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    document: dom.document,
    // window.open 替身：lmsOpenExternal 走的就是它（不是 <a>），这里记下开了什么
    open: (url) => { opened.push(String(url)); return null; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(scripts.join('\n;\n'), vm.createContext(sandbox), { filename: 'renderer-bundle.js' });

  // `/api` 请求全部走替身：记下调用，按路径回固定的假数据
  const calls = [];
  sandbox.PC = {
    state: { apiBase: origin, wsUrl: null, socket: null },
    api: async (route) => {
      calls.push(route);
      if (route.startsWith('/lms/status')) return { status: 'ready', user: { name: '张三' } };
      if (route.startsWith('/lms/courses/1001')) return PAGE;
      if (route.startsWith('/lms/courses')) return { items: [], count: 0 };
      if (route.startsWith('/lms/activities')) {
        const id = Number((/\/lms\/activities\/(\d+)/.exec(route) ?? [])[1]);
        if (route.endsWith('/submission')) return SUBMISSION;
        if (route.endsWith('/replays')) return { videos: [{ label: 'hd', labelText: '高清', size: 1048576, sizeText: '1.0 MB', downloadUrl: 'https://rms/download/1', playUrl: 'https://rms/play/1' }] };
        return DETAIL[id] ?? { item: null };
      }
      if (route.startsWith('/lms/downloads')) return { items: [], dir: '/tmp' };
      return {};
    },
    toast: () => {},
    snapshotScroll: () => () => {},
    refresh: () => {},
  };

  const view = sandbox.window.PCModules.get('lms');
  const seam = sandbox.window.__PC_LMS_TEST__;
  assert.ok(seam, 'lms 视图应挂载 __PC_LMS_TEST__（测试缝）');

  // 建一个 mount，把视图渲染进去（真实运行时是外壳调 render 的）
  const mount = dom.createElement('div');
  dom.document.body.appendChild(mount);
  view.render({ mount, api: sandbox.PC.api, state: sandbox.PC.state, toast: () => {}, refresh: () => {} });

  // 让视图进入"已登录 + 在课程页"的状态
  seam.ui.status = { status: 'ready', user: { name: '张三' } };
  seam.openCourse(1001);
  await new Promise((resolve) => setTimeout(resolve, 0));
  seam.setCoursePage(PAGE);

  const texts = (node) => {
    const out = [];
    const walk = (current) => {
      if (!current) return;
      if (current._innerText) out.push(current._innerText);
      for (const child of current.childNodes ?? []) walk(child);
    };
    walk(node);
    return out.join(' ');
  };
  const all = (cls) => dom.document.querySelectorAll(`.${cls}`);
  const byClass = (cls) => all(cls);

  return { app, dom, sandbox, calls, seam, mount, texts, byClass, opened };
}

/* ================================================================== 用例 */

test('课程页渲染出四个板块页签，各带条数', async () => {
  const ctx = await bootView();
  try {
    const tabs = ctx.byClass('lms-tab');
    assert.equal(tabs.length, 4, `★ 应当正好四个板块，实际 ${tabs.length}`);
    const labels = tabs.map((tab) => ctx.texts(tab.querySelector('.lms-tab-label') ?? tab));
    assert.deepEqual(Array.from(labels), ['作业', '资料', '课程回放', '直播']);
    // 条数徽标：作业 2 条，其余各 1 条
    const counts = tabs.map((tab) => ctx.texts(tab.querySelector('.lms-tab-count')));
    assert.deepEqual(Array.from(counts), ['2', '1', '1', '1']);
    // 默认停在「作业」
    assert.equal(tabs[0].classList.contains('active'), true, '默认应选中作业');
  } finally {
    await ctx.app.close();
  }
});

test('页签条数为 0 也显示（"没有资料"是有效信息）', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.setCoursePage({ ...PAGE, groups: { ...PAGE.groups, material: [] }, counts: { ...PAGE.counts, material: 0 } });
    const tabs = ctx.byClass('lms-tab');
    const materialTab = tabs[1];
    assert.equal(ctx.texts(materialTab.querySelector('.lms-tab-count')), '0');
  } finally {
    await ctx.app.close();
  }
});

test('★ 切页签不联网：只是本地过滤', async () => {
  const ctx = await bootView();
  try {
    const before = ctx.calls.length;
    ctx.seam.selectTab('material');
    ctx.seam.selectTab('replay');
    ctx.seam.selectTab('homework');
    assert.equal(ctx.calls.length, before, '★ 切页签不该触发任何请求');

    // 最后停在「直播」：内容与该页签的高亮都要对上
    ctx.seam.selectTab('live');
    const tabs = ctx.byClass('lms-tab');
    assert.equal(tabs[3].classList.contains('active'), true, '「直播」应高亮');
    assert.equal(tabs[0].classList.contains('active'), false, '「作业」不该还亮着');
    assert.ok(ctx.texts(ctx.mount).includes('第 6 周直播课'), '直播板块应显示直播那条');
    assert.ok(!ctx.texts(ctx.mount).includes('第一次作业：链表'), '切走之后不该还渲染上一个板块的内容');
    assert.equal(ctx.calls.length, before, '切到底也不该联网');
  } finally {
    await ctx.app.close();
  }
});

test('点活动行进入独立详情页，作业显示描述/附件/我的提交', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.seam.ui.page, 'activity');
    const text = ctx.texts(ctx.mount);
    assert.ok(text.includes('实现单链表并提交源码'), '应显示描述（它藏在 data.description 里，取错就是空）');
    assert.ok(text.includes('作业要求.pdf'), '应列出附件');
    assert.ok(text.includes('我的提交'), '作业详情要有提交区');
    // 附件按钮：可下载的给「下载」，禁止下载的只给「预览」
    const buttons = ctx.byClass('lms-file-btn').map((node) => ctx.texts(node));
    assert.equal(buttons.filter((label) => label === '下载').length, 1, '★ 只有允许下载的那个有「下载」');
    assert.equal(buttons.filter((label) => label === '预览').length, 2, '两个都可预览');
  } finally {
    await ctx.app.close();
  }
});

test('★ 详情页返回后回到原来那个板块，不是跳回第一个', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.selectTab('live');
    assert.equal(ctx.seam.ui.tab, 'live');
    ctx.seam.openActivity(5004);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.seam.ui.page, 'activity');
    ctx.seam.backToCourse();
    assert.equal(ctx.seam.ui.page, 'course');
    assert.equal(ctx.seam.ui.tab, 'live', '★ 返回后应停在「直播」，而不是回到「作业」');
  } finally {
    await ctx.app.close();
  }
});

test('资料详情只给附件，不给作业的提交区', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5005);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = ctx.texts(ctx.mount);
    assert.ok(text.includes('第6章.pptx'), '应列出资料附件');
    assert.ok(!text.includes('我的提交'), '资料不该出现作业的提交区');
  } finally {
    await ctx.app.close();
  }
});

test('回放详情复用视频下载行（不是重造一套）', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5007);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = ctx.texts(ctx.mount);
    assert.ok(text.includes('第 5 周回放'));
    assert.ok(text.includes('取视频'), '回放详情应有「取视频」按钮（复用 lmsReplayRow）');
  } finally {
    await ctx.app.close();
  }
});

/* ------------------------- 说明是 HTML / 回放在线播放 / 直播跳回放 */

test('★ 作业说明是 HTML，但页面上不该出现标签', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = ctx.texts(ctx.mount);
    assert.ok(text.includes('实现单链表并提交源码'), '正文要显示出来');
    assert.ok(!text.includes('<p>'), '★ 不该显示 <p> 标签（用户报的就是这个）');
    assert.ok(!text.includes('</p>'), '★ 不该显示闭合标签');
    assert.ok(!text.includes('<li>'), '不该显示 <li>');
    // 列表要变成项目符号，而不是被压成一行
    assert.ok(text.includes('• 用 C 语言'), '列表项应变成项目符号');
    assert.ok(text.includes('• 不要用库函数'));
  } finally {
    await ctx.app.close();
  }
});

test('HTML 说明转文本：段落/列表/表格/实体', async () => {
  const ctx = await bootView();
  try {
    const toText = ctx.seam.htmlToText;
    assert.equal(toText('<p>实现单链表并提交源码</p>'), '实现单链表并提交源码');
    assert.equal(
      toText('<p>要求：</p><ul><li>用 C 语言</li><li>不要用库函数</li></ul>'),
      '要求：\n• 用 C 语言\n• 不要用库函数',
    );
    assert.equal(toText('第一行<br>第二行'), '第一行\n第二行');
    assert.equal(toText('<p>见 <a href="x">附件</a>&nbsp;&amp;&nbsp;注意</p>'), '见 附件 & 注意');
    assert.equal(toText('<table><tr><td>权重</td><td>30%</td></tr></table>'), '权重 30%');
    // 已经是纯文本的别误伤（正文里可能有 "<"）
    assert.equal(toText('纯文本没有标签 < 这里'), '纯文本没有标签 < 这里');
    assert.equal(toText(''), '');
    assert.equal(toText(null), '');
  } finally {
    await ctx.app.close();
  }
});

test('回放的每个视频都给「在线播放」和「下载」两个出口', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5007);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.seam.loadReplays({ id: 5007, type: 'lesson', title: '第 5 周回放' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const play = ctx.byClass('lms-replay-play');
    assert.equal(play.length, 1, '★ 应有「在线播放」');
    // ★ 它必须在**页面里**播，不能把地址交给系统浏览器：
    //   Electron 把 URL 交给操作系统时会比对权限等级，用户那边弹的
    //   「Edge 未响应，因为现有实例正在以提升的权限运行」就是这么来的（点"是"会重启 Edge）。
    assert.equal(play[0].tagName, 'BUTTON', '在线播放应是按钮，不是 <a>');
    play[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(ctx.opened, [], '★ 不能把地址交给浏览器/系统');
    const player = ctx.byClass('lms-player-video');
    assert.equal(player.length, 1, '★ 应当在页面里出现播放器');
    // ★ 指向的是**我们自己的转发路由**，不是录播站地址：//   媒体地址有防盗链、<video> 改不了 Referer，直接指过去必然加载失败。
    assert.match(player[0].src, /\/lms\/replay\/stream\?activityId=5007/, '播放器应走本机转发路由');
    const labels = ctx.byClass('ghost-btn').map((node) => ctx.texts(node));
    assert.ok(labels.includes('下载'), '下载按钮应同时存在');
  } finally {
    await ctx.app.close();
  }
});

test('★ 直播详情能一键跳到对应回放', async () => {
  const ctx = await bootView();
  try {
    ctx.seam.openActivity(5004);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ctx.texts(ctx.mount).includes('关联回放'), '直播详情应有「关联回放」一块');

    const jump = ctx.byClass('primary-btn').find((node) => ctx.texts(node).includes('回放'));
    assert.ok(jump, '★ 应给出跳到回放的按钮');

    jump.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.seam.ui.page, 'activity');
    assert.equal(ctx.seam.ui.activityId, '5007', '★ 应当跳到 5007 那条回放');
    assert.ok(ctx.texts(ctx.mount).includes('第 5 周回放'), '落地页应是那条回放');
  } finally {
    await ctx.app.close();
  }
});

test('直播没有对应录像时不给按钮，只说明去处', async () => {
  const ctx = await bootView();
  try {
    // 把回放清空 —— 匹配不到就不该出现"点了没反应"的按钮
    ctx.seam.setCoursePage({ ...PAGE, groups: { ...PAGE.groups, replay: [] } });
    ctx.seam.openActivity(5004);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = ctx.texts(ctx.mount);
    assert.ok(text.includes('关联回放'));
    // 没有可配对的回放 → 明说"没有关联录像"，别留空也别给一个点了没反应的按钮
    assert.ok(
      text.includes('这次直播没有关联的录像') || text.includes('去「课程回放」板块找'),
      '应说明情况，而不是留空',
    );
    const jump = ctx.byClass('primary-btn').filter((node) => ctx.texts(node).includes('回放'));
    assert.equal(jump.length, 0, '★ 匹配不到就不该给按钮');
  } finally {
    await ctx.app.close();
  }
});
