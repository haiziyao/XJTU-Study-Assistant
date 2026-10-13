/**
 * 图片笔记（随手拍）的文字识别 —— 覆盖"有图被当成没内容"这条真机事故。
 *
 * CI 友好是硬要求：CI 上通常没有 `swiftc`，所以**主用例全部注入假引擎**
 * （`createServer({ notes: { ocr } })` → `options.notes.ocr` → `NoteService.recognize`），
 * 验证的是"什么时候触发识别、结果怎么写回、怎么广播、什么时候不重复识别"这些**我们的逻辑**；
 * 真实 Vision 识别能力只放在最后一条**条件 skip** 的用例里（没有 swiftc 就跳过）。
 *
 * 假引擎的形状必须和 `ocr.js` 一致：永远 resolve，绝不对上层抛异常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createServer } from '../src/server/index.js';
import { parseImageDataUrl, parseOcrLines, recognizeFile } from '../src/modules/notes/ocr.js';
import { connectWs } from './helpers/ws-client.js';

/** 1×1 的 PNG（合法图片头 + 类型），够走完"是 image/*"的判断。 */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE1GJAAAAAElFTkSuQmCC';
const TEXT_ATTACHMENT = { name: '课件.txt', type: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==' };

/**
 * 自造一张 320×120 的纯白 PNG（无字）。
 *
 * 为什么不用上面那个 1×1：Vision 会直接拒绝（"The image is too small in at least one
 * dimension 2 x 2"），那测到的是引擎的入参校验，不是"识别跑起来了"。这张图的尺寸足够
 * 让真实引擎正常返回，用来验证"纯色图不会读出字来"。
 */
const BIG_PNG_DATA_URL = (() => {
  const width = 320;
  const height = 120;
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  const raw = Buffer.alloc((width + 1) * height, 0xff); // 每行首字节是过滤方式 0，其余全白
  for (let y = 0; y < height; y += 1) raw[y * (width + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
})();

/** 假引擎：记录每次调用，可指定返回成功 / 失败；`onCall` 用来观察"到底跑了几次"。 */
function fakeEngine(result = { ok: true, text: '随手拍里的字', chars: 6, engine: 'fake' }) {
  const calls = [];
  const engine = async (dataUrl, opts) => {
    calls.push({ dataUrl, opts });
    return typeof result === 'function' ? result(dataUrl, opts) : result;
  };
  engine.calls = calls;
  return engine;
}

async function startApp({ ocr } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-notes-ocr-'));
  const app = await createServer({ dataDir, notes: ocr ? { ocr } : {} });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call, info };
}

/** 等"后台识别写回"（创建/更新是异步跑的，接口返回时可能还没写完）。 */
async function waitForOcr(call, id, predicate = (ocr) => ocr && ocr.error !== 'pending', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await call('GET', `/notes/${id}`);
    const ocr = detail.body.note?.ocr;
    if (predicate(ocr)) return ocr;
    if (Date.now() > deadline) throw new Error(`等 OCR 写回超时，最后拿到：${JSON.stringify(ocr)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('OCR 接入：非图片附件不触发识别（纯文字 / 文档笔记保持 ocr=null）', async () => {
  const ocr = fakeEngine();
  const { app, call } = await startApp({ ocr });
  try {
    const text = await call('POST', '/notes', { title: '纯文字', body: '高等数学', source: 'manual', attachments: [TEXT_ATTACHMENT] });
    assert.equal(text.status, 201);
    assert.equal(text.body.summary.ocr, null, '没有图片附件时 ocr 应该是 null（不是"识别中"）');

    const doc = await call('POST', '/notes', {
      title: '导入课件', source: 'import',
      attachments: [{ name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 3, dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,YWJj' }],
    });
    assert.equal(doc.body.summary.ocr, null);
    // 给后台任务一点时间（如果它错误地排了队，这里就会看到调用）
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ocr.calls.length, 0, '非图片附件不该送去识别');
  } finally {
    await app.close();
  }
});

test('OCR 接入：没有识别能力时如实降级（ocr.ok=false + error=ocr_unavailable），HTTP 照常成功', async () => {
  const ocr = fakeEngine({ ok: false, reason: 'ocr_unavailable', message: '本机没有 swiftc' });
  const { app, call } = await startApp({ ocr });
  try {
    const created = await call('POST', '/notes', { title: '随手拍', source: 'snapshot', attachments: [{ name: 'image.jpg', type: 'image/jpeg', size: 10, dataUrl: PNG_DATA_URL }] });
    assert.equal(created.status, 201, '识别不可用不该让创建失败');
    assert.equal(created.body.summary.ocr.error, 'pending', '创建时先标记"排队中"');

    const ocrState = await waitForOcr(call, created.body.summary.id);
    assert.equal(ocrState.ok, false);
    assert.equal(ocrState.error, 'ocr_unavailable');
    assert.equal(ocrState.text, '');
    assert.equal(ocrState.chars, 0);

    // 降级信息要能被 AI 读到（否则模型只会看到一条"正文为空"的笔记）
    const context = await call('POST', '/notes/ai-context', { ids: [created.body.summary.id] });
    assert.equal(context.body.items[0].ocr.ok, false);
    assert.equal(context.body.items[0].ocr.error, 'ocr_unavailable');
  } finally {
    await app.close();
  }
});

test('OCR 接入：识别成功写回 ocr 并广播 notes_changed；正文为空也能被关键词搜到', async () => {
  const ocr = fakeEngine({ ok: true, text: '傅里叶变换 期末重点', chars: 11, engine: 'fake' });
  const { app, call, info } = await startApp({ ocr });
  const client = await connectWs({ port: info.port });
  try {
    const created = await call('POST', '/notes', { title: '随手拍 2026/10/13', source: 'snapshot', attachments: [{ name: 'image.jpg', type: 'image/jpeg', size: 10, dataUrl: PNG_DATA_URL }] });
    const id = created.body.summary.id;
    const ocrState = await waitForOcr(call, id, (value) => value?.ok === true);
    assert.equal(ocrState.text, '傅里叶变换 期末重点');
    assert.equal(ocrState.chars, 11);
    assert.equal(ocrState.engine, 'fake');
    assert.ok(ocrState.at, 'at 记录识别时间');

    // 广播：渲染层靠它刷新，所以识别完成必须广播一次
    const broadcast = await client.waitFor((message) => message.type === 'notes_changed' && message.payload?.action === 'ocr' && message.payload?.summary?.id === id, 5000);
    assert.equal(broadcast.payload.summary.ocr.text, '傅里叶变换 期末重点');

    // 检索：正文是空的，但识别文本要让它能被搜到
    const listed = await call('GET', '/notes?query=傅里叶');
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, id);
    assert.match(listed.body.items[0].matchText, /傅里叶变换/);

    // AI 侧的只读查询（queryForAI）也要带上 ocr
    const context = await call('POST', '/notes/ai-context', { ids: [id] });
    assert.equal(context.body.items[0].text, '', '正文仍然为空（没有改动既有字段语义）');
    assert.equal(context.body.items[0].ocr.text, '傅里叶变换 期末重点');

    // 三源检索的 note 路也要带上识别文本
    const search = await call('GET', '/search?q=傅里叶变换&scope=note');
    assert.equal(search.body.count, 1);
    assert.equal(search.body.items[0].noteId, id);
    assert.match(search.body.items[0].snippet, /傅里叶变换/);
  } finally {
    client.close();
    await app.close();
  }
});

test('POST /notes/:id/ocr：同步重跑返回 200 与结果，笔记不存在 404，非图片 400 式降级', async () => {
  const ocr = fakeEngine({ ok: true, text: '第一次识别', chars: 5, engine: 'fake' });
  const { app, call } = await startApp({ ocr });
  try {
    const created = await call('POST', '/notes', { title: '随手拍', source: 'snapshot', attachments: [{ name: 'image.jpg', type: 'image/jpeg', size: 10, dataUrl: PNG_DATA_URL }] });
    const id = created.body.summary.id;
    await waitForOcr(call, id, (value) => value?.ok === true);

    ocr.calls.length = 0;
    const again = await call('POST', `/notes/${id}/ocr`);
    assert.equal(again.status, 200);
    assert.equal(again.body.ocr.ok, true);
    assert.equal(again.body.ocr.text, '第一次识别');
    assert.equal(ocr.calls.length, 1, '同步重跑要真的再识别一次');

    const missing = await call('POST', '/notes/does-not-exist/ocr');
    assert.equal(missing.status, 404);

    const textOnly = await call('POST', '/notes', { title: '没有图', body: '纯文字' });
    const noImage = await call('POST', `/notes/${textOnly.body.summary.id}/ocr`);
    assert.equal(noImage.status, 200, '没有图片不是服务器错误，如实返回原因');
    assert.equal(noImage.body.ocr.ok, false);
    assert.equal(noImage.body.ocr.reason, 'bad_image');
  } finally {
    await app.close();
  }
});

test('OCR 接入：内容未变不重复识别（改标题 / 改正文 / 附件字段被忽略；只有手动重跑才再识别）', async () => {
  const ocr = fakeEngine({ ok: true, text: '同一张图', chars: 4, engine: 'fake' });
  const { app, call } = await startApp({ ocr });
  try {
    const created = await call('POST', '/notes', {
      title: '随手拍', source: 'snapshot',
      attachments: [{ name: 'image.jpg', type: 'image/jpeg', size: 10, dataUrl: PNG_DATA_URL }],
    });
    const id = created.body.summary.id;
    await waitForOcr(call, id, (value) => value?.ok === true);
    assert.equal(ocr.calls.length, 1);

    await call('PATCH', `/notes/${id}`, { title: '改个标题' });
    await call('PATCH', `/notes/${id}`, { body: '补一句说明' });
    // PATCH 的附件字段按既有语义被忽略（见 service.update 的注释），更不该借它偷偷重跑识别
    await call('PATCH', `/notes/${id}`, { attachments: [{ name: 'image.jpg', type: 'image/jpeg', size: 10, dataUrl: PNG_DATA_URL }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ocr.calls.length, 1, '图片没变就不该再跑一次 OCR');

    const detail = await call('GET', `/notes/${id}`);
    assert.equal(detail.body.note.ocr.text, '同一张图', '不重跑也要保留上次的识别结果');
    assert.equal(detail.body.note.attachments.length, 1, 'PATCH 不该动附件（既有语义）');

    // 真要重跑只有一条路：手动触发（"重新识别"按钮）
    const again = await call('POST', `/notes/${id}/ocr`);
    assert.equal(again.status, 200);
    assert.equal(ocr.calls.length, 2, '手动重跑要再识别一次');
  } finally {
    await app.close();
  }
});

test('OCR 工具自身：dataUrl 校验与输出解析（不依赖 swiftc）', () => {
  assert.equal(parseImageDataUrl('data:text/plain;base64,YQ==').reason, 'bad_image');
  assert.equal(parseImageDataUrl('data:image/png;notbase64,xx').reason, 'bad_image');
  assert.equal(parseImageDataUrl('data:image/png;base64,').reason, 'bad_image');
  const ok = parseImageDataUrl(PNG_DATA_URL);
  assert.equal(ok.ok, true);
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.bytes.length > 8);

  // 小工具输出里混进非 JSON 行（warning）时不该整条作废
  const lines = parseOcrLines('warning: something\n{"text":"第一行","confidence":0.9}\nnot json\n{"text":"  ","confidence":1}\n{"text":"第二行","confidence":2}');
  assert.deepEqual(lines, [{ text: '第一行', confidence: 0.9 }, { text: '第二行', confidence: 1 }]);
});

test('OCR 工具自身：没有 swiftc 时 recognizeFile 返回 ocr_unavailable 而不抛异常', async (t) => {
  if (existsSync('/usr/bin/swiftc')) return t.skip('本机有 swiftc，这条专门验证"没有编译器"的降级');
  const result = await recognizeFile(path.join(tmpdir(), 'potato-ocr-not-a-real-file.png'), { assetDir: path.join(tmpdir(), 'potato-ocr-none') });
  assert.equal(result.ok, false);
  assert.ok(['bad_image', 'ocr_unavailable'].includes(result.reason), `意外的 reason：${result.reason}`);
});

test('真实识别：macOS Vision 能读出截图里的中文（没有 swiftc 时跳过）', async (t) => {
  const compiler = existsSync('/usr/bin/swiftc') || existsSync('/usr/bin/swift');
  if (!compiler) return t.skip('本机没有 swiftc / swift，跳过真实识别');

  const { app, call } = await startApp();
  try {
    // 用一张**真实截图**而不是 1×1 的空图：空图在真机上会得到 no_text，
    // 那验证不了"字真的被读出来了"。
    const screenshot = path.resolve(import.meta.dirname, '..', '.electron-bundle', 'capture-out', 'mobile', '01-mobile-chat-390x844.png');
    const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-notes-ocr-real-'));
    if (existsSync(screenshot)) {
      const assetDir = path.join(dataDir, '.ocr');
      // 直接走模块的公开入口，验证"编译 → 识别 → 有文本"整条链路。
      // 若仓库里已有编译好的小工具（app/data/.ocr/vision-ocr，用过一次就有），先拷进临时目录：
      // 编译一次要 45s 左右，单测不该每次都付这个钱。没有缓存时 `ensureBinary()` 照常现编。
      const assetDirOfRepo = path.resolve(import.meta.dirname, '..', 'data', '.ocr');
      const cached = path.join(assetDirOfRepo, 'vision-ocr');
      if (existsSync(cached)) {
        await mkdir(assetDir, { recursive: true });
        await copyFile(cached, path.join(assetDir, 'vision-ocr'));
      }
      const { recognizeFile: recognize } = await import('../src/modules/notes/ocr.js');
      const result = await recognize(screenshot, { assetDir });
      assert.equal(result.ok, true, `真实识别失败：${result.reason} ${result.message ?? ''}`);
      assert.ok(result.text.length > 0, '识别文本长度必须大于 0');
      assert.equal(result.engine, 'macos-vision');
      return;
    }

    // 截图不在（别人没跑过 capture）时退一步：用一张自造的大 PNG（纯色、无字）
    // 走完真实引擎链路，断言"引擎能跑起来、结果如实、不抛异常"，不假设图里一定有字。
    const created = await call('POST', '/notes', { title: '空图', source: 'snapshot', attachments: [{ name: 'blank.png', type: 'image/png', size: 1, dataUrl: BIG_PNG_DATA_URL }] });
    const ocrState = await waitForOcr(call, created.body.summary.id, (value) => value && value.error !== 'pending', 120000);
    // 纯色图不该"读出字来"（ok:true 说明在编造），也不该掉进我们自己的 bad_image 分支
    assert.ok(['no_text', 'ocr_unavailable', 'failed'].includes(ocrState.error), `意外的结果：${JSON.stringify(ocrState)}`);
  } finally {
    await app.close();
  }
});

test('真实识别：那条随手拍（app/data/notes.json）能被读出文字并写进 AI 能看到的字段', async (t) => {
  const compiler = existsSync('/usr/bin/swiftc') || existsSync('/usr/bin/swift');
  if (!compiler) return t.skip('本机没有 swiftc / swift，跳过真实识别');
  const notesFile = path.resolve(import.meta.dirname, '..', 'data', 'notes.json');
  if (!existsSync(notesFile)) return t.skip('本地没有 data/notes.json（运行时数据不入库）');

  const raw = JSON.parse(readFileSync(notesFile, 'utf8'));
  const note = (raw.items ?? []).find((item) => (item.attachments ?? []).some((file) => String(file.type ?? '').startsWith('image/')));
  if (!note) return t.skip('本地 notes.json 里没有图片笔记');

  const dataUrl = note.attachments.find((file) => String(file.type ?? '').startsWith('image/')).dataUrl;
  const assetDir = path.join(path.dirname(notesFile), '.ocr');
  const { recognizeImageDataUrl } = await import('../src/modules/notes/ocr.js');
  const result = await recognizeImageDataUrl(dataUrl, { assetDir });
  if (result.reason === 'ocr_unavailable') return t.skip(`本机识别不可用：${result.message}`);
  assert.equal(result.ok, true, `识别失败：${result.reason} ${result.message ?? ''}`);
  assert.ok(result.text.length > 0, '真实随手拍必须有识别文本');
  assert.ok(result.durationMs >= 0);
});
