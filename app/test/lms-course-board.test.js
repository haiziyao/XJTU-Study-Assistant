/**
 * 思源学堂「课程 → 四板块 → 详情」的后端行为测试。
 *
 * 这一轮补的是"点进去要有东西"：
 *   · 打开课程会**自动拉一次**这门课的活动（按课程节流），不再是四个空板块；
 *   · 附件归一化带上可用的下载/预览地址，并且**禁止下载的附件不给下载入口**；
 *   · 附件字节由**后端代取**（学校那条要 CAS cookie，浏览器直连必 401）；
 *   · 作业能查到自己的提交记录；资料清单能列出来。
 *
 * 归一化里的几个坑（`data.description`、`replay_code` 三级兜底、中文附件名）
 * 都有专门的用例 —— 它们错了不会报错，只会让页面"看起来没有内容"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { normalizeActivityDetail, normalizeUpload, uploadKind } from '../src/modules/lms/api.js';
import { startMockLms } from './helpers/lms-mock.js';

const USER = '2021001';
const PASS = 'pw-123456';

/** 起一套 auth + calendar + lms 的服务，指向 mock 站点。 */
async function startApp() {
  const mock = await startMockLms();
  const app = await createServer({
    dataDir: await mkdtemp(path.join(tmpdir(), 'potato-lms-board-')),
    auth: { casOrigin: mock.origin },
    lms: { config: { baseUrl: mock.origin, casOrigin: mock.origin, rmsBaseUrl: mock.origin + '/rms' } },
  });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, raw: buffer, headers: response.headers, body: null };
    }
    return { status: response.status, body: await response.json(), headers: response.headers, raw: null };
  };
  /** 带 Range 头发一次请求（模拟 <video> 拖进度条）。 */
  const callRange = async (method, route, range) => {
    const response = await fetch(`${info.baseUrl}${route}`, { method, headers: { Range: range } });
    const type = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, raw: buffer, body: type.includes('json') ? JSON.parse(buffer.toString('utf8')) : null };
  };

  const close = async () => {
    await app.close();
    await mock.close();
  };
  const login = async () => {
    const result = await call('POST', '/auth/login', { username: USER, password: PASS, siteId: 'lms' });
    assert.equal(result.body.status, 'ready', `登录应成功：${JSON.stringify(result.body).slice(0, 200)}`);
  };
  return { app, call, callRange, close, login, mock };
}

/* ==================================================== 归一化（纯函数） */

test('活动详情的 description 从 data 里取（取顶层永远是空的）', () => {
  const withData = normalizeActivityDetail({ id: 1, type: 'homework', data: { description: '来自 data 的说明' } });
  assert.equal(withData.description, '来自 data 的说明');
  // 顶层也有时仍然认（两种形状都见过）
  assert.equal(normalizeActivityDetail({ id: 1, type: 'homework', description: '顶层说明' }).description, '顶层说明');
});

test('replay_code 三级兜底：顶层 → lesson_resource.properties → 直播详情', () => {
  const top = normalizeActivityDetail({ id: 1, type: 'lesson', replay_code: 'rc-top' });
  assert.equal(top.replayCode, 'rc-top');

  const nested = normalizeActivityDetail({ id: 1, type: 'lesson', lesson_resource: { properties: { replay_code: 'rc-nested' } } });
  assert.equal(nested.replayCode, 'rc-nested');

  const external = normalizeActivityDetail({ id: 1, type: 'lesson', data: { external_live_detail: { replay_id: 'rc-external' } } });
  assert.equal(external.replayCode, 'rc-external');
});

test('附件：可下载的给下载+预览，禁止下载的只给预览', () => {
  const open = normalizeUpload({ id: 11, name: '作业要求.pdf', size: 2048, type: 'application/pdf', allow_download: true });
  assert.equal(open.downloadUrl, '/lms/attachments/11');
  assert.equal(open.previewUrl, '/lms/attachments/11?inline=1');
  assert.equal(open.kind, 'document');
  assert.equal(open.size, 2048);

  const locked = normalizeUpload({ id: 12, name: '评分细则.docx', allow_download: false });
  assert.equal(locked.downloadUrl, null, '★ 老师关掉下载就不该给下载入口');
  assert.equal(locked.previewUrl, '/lms/attachments/12?inline=1');
  assert.equal(locked.allowDownload, false);

  // 没有 id 就代理不了，两个入口都不给（而不是给一个点了会 404 的地址）
  const noId = normalizeUpload({ name: '没有 id 的附件' });
  assert.equal(noId.downloadUrl, null);
  assert.equal(noId.previewUrl, null);

  assert.equal(normalizeUpload(null), null, '脏数据要被过滤掉而不是抛错');
});

test('附件类型归类：认不出的归 file，不能当成"没有附件"', () => {
  assert.equal(uploadKind('application/pdf'), 'document');
  assert.equal(uploadKind('video/mp4'), 'video');
  assert.equal(uploadKind('image/png'), 'image');
  assert.equal(uploadKind('audio/mpeg'), 'audio');
  assert.equal(uploadKind('application/zip'), 'file');
  assert.equal(uploadKind(''), 'file');
  // 没有 MIME 时按扩展名兜底
  assert.equal(uploadKind('', '课件.PPTX'), 'document');
});

/* ==================================================== 路由与网络行为 */

test('打开课程会自动拉活动（不再需要手动点刷新）', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    await ctx.call('POST', '/lms/courses/refresh');
    const page = await ctx.call('GET', '/lms/courses/1001');
    assert.equal(page.status, 200);
    assert.ok(page.body.groups, '应返回分组');
    const total = Object.values(page.body.groups ?? {}).reduce((sum, list) => sum + list.length, 0);
    assert.ok(total > 0, `★ 第一次打开就该有内容，实际 ${total} 条`);
    assert.equal(page.body.refreshError, null, '自动刷新不该报错');
  } finally {
    await ctx.close();
  }
});

test('课程页按课程节流：10 分钟内重复打开只打一次上游', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    await ctx.call('POST', '/lms/courses/refresh');
    const before = ctx.mock.state.requests.filter((line) => line.includes('/api/courses/1001/activities')).length;
    for (let i = 0; i < 3; i += 1) await ctx.call('GET', '/lms/courses/1001');
    const after = ctx.mock.state.requests.filter((line) => line.includes('/api/courses/1001/activities')).length;
    assert.equal(after - before, 1, '★ 连开三次只该拉一次（按课程节流，不是按全局时间戳）');
    // 显式刷新要绕过节流
    await ctx.call('GET', '/lms/courses/1001?refresh=1');
    const bumped = ctx.mock.state.requests.filter((line) => line.includes('/api/courses/1001/activities')).length;
    assert.equal(bumped - before, 2, 'refresh=1 应当强制再拉一次');
  } finally {
    await ctx.close();
  }
});

test('★ 附件由后端代取，并把字节原样转发', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/attachments/9001?name=%E4%BD%9C%E4%B8%9A%E8%A6%81%E6%B1%82.pdf');
    assert.equal(result.status, 200);
    assert.equal(result.raw.toString('utf8'), 'blob-of-9001', '★ 转发的应当是学校那个文件本身');
    assert.equal(result.headers.get('content-type'), 'application/pdf');
    assert.match(result.headers.get('content-disposition') ?? '', /^attachment;/, '默认按下载处理');
    // 中文名必须走 RFC 5987 的 filename*，否则浏览器里是乱码
    const disposition = result.headers.get('content-disposition') ?? '';
    assert.match(disposition, /filename\*=UTF-8''/, '中文文件名要用 filename*');
    assert.ok(disposition.includes(encodeURIComponent('作业要求.pdf')), 'filename* 里应是 UTF-8 编码的原名');
    assert.ok(ctx.mock.state.blobFetched.includes(9001), '★ 应当真的去学校取过这个 blob');
  } finally {
    await ctx.close();
  }
});

test('附件预览：inline=1 时按预览处理', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/attachments/9001?inline=1');
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-disposition') ?? '', /^inline/);
  } finally {
    await ctx.close();
  }
});

test('附件不存在时给 404，而不是 500', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/attachments/9009');
    assert.ok(result.status === 404 || result.status === 502, `应是明确的错误码，实际 ${result.status}`);
    assert.ok(result.body?.error?.message, '要带人能看懂的说明');
  } finally {
    await ctx.close();
  }
});

test('附件 id 非法时给 400（不让它变成 500）', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/attachments/abc');
    assert.ok(result.status === 400 || result.status === 404, `实际 ${result.status}`);
  } finally {
    await ctx.close();
  }
});

test('作业提交记录：拿得到分数与状态', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/activities/5001/submission');
    assert.equal(result.status, 200);
    assert.equal(result.body.submitted, true);
    assert.ok(result.body.count >= 1);
    const first = result.body.submissions[0];
    assert.equal(first.score, 95);
    assert.ok(first.status, '应带状态');
  } finally {
    await ctx.close();
  }
});

test('课程资料清单：只含资料类活动，带附件', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    // materials 只读缓存（它是给工具用的，不替用户联网）；先把这门课的活动拉一遍
    await ctx.call('POST', '/lms/courses/refresh');
    await ctx.call('POST', '/lms/activities/refresh', { courseIds: [1001] });
    const result = await ctx.call('GET', '/lms/courses/1001/materials?detail=1');
    assert.equal(result.status, 200);
    for (const item of result.body.items) {
      assert.equal(item.type, 'material', '资料清单里不该混进别的类型');
    }
    const withFiles = result.body.items.filter((item) => item.uploads?.length);
    assert.ok(withFiles.length > 0, '★ 至少有一条资料带附件（否则资料板块还是空的）');
    const upload = withFiles[0].uploads[0];
    assert.ok(upload.name, '附件要有名字');
    assert.ok(upload.downloadUrl?.startsWith('/lms/attachments/'), '附件要给出代理地址');
  } finally {
    await ctx.close();
  }
});

test('不存在的课程给 404 且说明原因', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/courses/99999');
    assert.equal(result.status, 404);
    assert.ok(result.body.error.message.includes('99999') || result.body.error.message.includes('课程'));
  } finally {
    await ctx.close();
  }
});

/* ------------------------------------------------ 在线播放：后端转发流 */

test('★ 在线播放走本机转发：后端补上 Referer 才取得到，字节原样转给浏览器', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    await ctx.call('POST', '/lms/courses/refresh');
    await ctx.call('POST', '/lms/activities/refresh', { courseIds: [1001] });

    const result = await ctx.call('GET', '/lms/replay/stream?activityId=5007&label=%E6%95%99%E5%AE%A4%E5%BD%95%E5%83%8F');
    assert.equal(result.status, 200, `转发应成功，实际 ${result.status}`);
    assert.match(result.headers.get('content-type') ?? '', /video\/mp4/, '应按上游的媒体类型回');
    assert.ok(result.raw.length > 0, '应当有真实字节');
    assert.equal(result.raw.length, 64, '转发的应当就是上游那个文件（mock 的媒体是 64 字节）');

    // ★ 录播站校验 Referer（防盗链）：后端必须补上才取得到 —— 这正是"直接给 <video> 播不了"的原因
    assert.ok(ctx.mock.state.mediaFetched.length > 0, '★ 后端应当真的去录播站取过流');
    const last = ctx.mock.state.mediaFetched.at(-1);
    assert.ok(last.referer, '★ 取流时必须带上 Referer —— 录播站防盗链靠它，而 <video> 自己发不出来');
  } finally {
    await ctx.close();
  }
});

test('在线播放：活动不存在时给明确错误，而不是空响应', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    const result = await ctx.call('GET', '/lms/replay/stream?activityId=999999');
    assert.ok(result.status === 404 || result.status === 502, `实际 ${result.status}`);
    assert.ok(result.body?.error?.message, '要带人能看懂的原因');
  } finally {
    await ctx.close();
  }
});

test('★ 拖进度条：Range 请求被原样转发，206 与 Content-Range 一并回给浏览器', async () => {
  const ctx = await startApp();
  try {
    await ctx.login();
    await ctx.call('POST', '/lms/courses/refresh');
    await ctx.call('POST', '/lms/activities/refresh', { courseIds: [1001] });

    // 直接带 Range 头请求转发路由（浏览器拖进度条时发的就是它）
    const result = await ctx.callRange('GET', '/lms/replay/stream?activityId=5007', 'bytes=10-');
    assert.equal(result.status, 206, `应当回 206（分段），实际 ${result.status}`);
    assert.ok(result.headers.get('content-range'), '★ 必须带 Content-Range，否则 <video> 不知道该往哪跳');
    assert.equal(result.headers.get('accept-ranges'), 'bytes');
    assert.ok(ctx.mock.state.rangeFetched.length > 0, '★ 后端应当把 Range 转给了上游');
    assert.equal(ctx.mock.state.rangeFetched.at(-1), 'bytes=10-', '转发的应当是同一个 Range');
  } finally {
    await ctx.close();
  }
});