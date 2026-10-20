/**
 * 对话附件的 12MB 图片上限：前端压缩预算 + 服务端请求体边界。
 *
 * 分两层测：
 *   1. **渲染层纯逻辑/管线**：`window.PCUpload` 与外壳是同一份实现（单张 12MB、合计 9MB、
 *      按张数均分、压缩失败回退/拒发）。用既有 DOM 桩求值 app.js，再喂假文件与假压缩器，
 *      不需要在 node:test 里伪造 canvas；
 *   2. **真实临时实例**：用 `node:http` 直接发 12MB / 12MB+1 的 body，断言服务端在
 *      **体积边界**上的 413 + PAYLOAD_TOO_LARGE —— 不用 fetch，避免测试自己先把大 body
 *      整块缓冲一遍（这正是本功能要避免的失败方式）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createServer } from '../src/server/index.js';
import { bootRenderer } from './helpers/renderer-dom.js';

const MB = 1024 * 1024;

/* ---------------------------------------------------------------- 渲染层 */

/** 求值全部渲染层脚本（不跑 boot），拿外壳挂出来的附件口径。 */
function uploadApi() {
  const { window } = bootRenderer({ api: async () => ({ ok: true }) });
  assert.ok(window.PCUpload, '外壳应把附件体积/压缩逻辑挂到 window.PCUpload（渲染层没有模块系统）');
  return window.PCUpload;
}

function imageFile(size, name = '大图.png', type = 'image/png') {
  return { name, type, size };
}

/** 造一个长度精确为 `length` 的 dataUrl（预算按字符串字节数算）。 */
function dataUrlOf(length) {
  const prefix = 'data:image/jpeg;base64,';
  return prefix + 'A'.repeat(Math.max(0, length - prefix.length));
}

function fakeRecord(file, dataUrlLength) {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: dataUrlOf(dataUrlLength),
    dataUrlBytes: dataUrlLength,
    originalSize: file.size,
    source: file,
    text: '',
  };
}

/** 假压缩器：记录每次调用拿到的预算，按给定体积（或"压到预算整好"）返回。 */
function fakeCompressor(sizes = null) {
  const calls = [];
  const compress = async (record, options) => {
    calls.push(options);
    const length = sizes ? sizes[calls.length - 1] : Math.min(record.dataUrl.length, options.budget);
    return {
      dataUrl: dataUrlOf(length),
      type: 'image/jpeg',
      width: 1600,
      height: 1200,
      withinBudget: length <= options.budget,
      attempts: 1,
    };
  };
  compress.calls = calls;
  return compress;
}

test('图片上限：正好 12MB 接受，12.1MB 拒绝且提示"单张图片上限 12MB"', () => {
  const upload = uploadApi();
  assert.equal(upload.MAX_IMAGE_BYTES, 12 * MB);
  assert.equal(upload.checkImageSize(12 * MB).ok, true, '12MB 应被接受');
  const over = upload.checkImageSize(12.1 * MB);
  assert.equal(over.ok, false);
  assert.match(over.message, /单张图片上限 12MB/);
  assert.match(over.message, /12\.1 MB/, '提示要带上实际大小，用户才知道差多少');
});

test('图片上限：12.1MB 在读取之前就被拦下（不占内存、不进压缩流程）', async () => {
  const upload = uploadApi();
  let reads = 0;
  const result = await upload.ingestFiles([imageFile(12.1 * MB)], {
    read: async () => {
      reads += 1;
      return null;
    },
  });
  assert.equal(reads, 0, '超限文件不该被 FileReader 读进内存');
  assert.equal(result.records.length, 0);
  assert.equal(result.added, 0);
  assert.match(result.messages.join(' '), /单张图片上限 12MB/);
});

test('12MB 图片被接受并进入压缩：单张独占 9MB 预算，压缩后 ≤ 预算', async () => {
  const upload = uploadApi();
  const file = imageFile(12 * MB);
  const compress = fakeCompressor([2 * MB]);
  const result = await upload.ingestFiles([file], {
    read: async (item) => fakeRecord(item, 10 * MB), // 12MB 原图 base64 后约 16MB，这里用 10MB 代表已超 9MB 预算
    compress,
  });
  assert.equal(result.added, 1);
  assert.equal(result.overflow, false);
  assert.equal(compress.calls.length, 1, '应真的走压缩');
  assert.equal(compress.calls[0].budget, 9 * MB, '单张图片独占 9MB 预算');
  assert.equal(result.records[0].compressed, true);
  assert.ok(result.records[0].dataUrl.length <= 9 * MB);
  assert.ok(result.records[0].size < file.size, 'chip 上的 size 要变成压缩后大小');
  assert.match(result.messages.join(' '), /已压缩 1 张图片（12\.0 MB → 1\.5 MB）/);
});

test('压缩档位：尺寸×质量序列严格变便宜，选中第一个满足预算的档位', () => {
  const upload = uploadApi();
  const plan = upload.compressionAttempts(4032, 3024);
  assert.equal(plan.length, 9, '1600/1280/1024 × 0.82/0.7/0.6');
  assert.deepEqual(
    Array.from(plan, (item) => `${item.edge}@${item.quality}`),
    ['1600@0.82', '1600@0.7', '1600@0.6', '1280@0.82', '1280@0.7', '1280@0.6', '1024@0.82', '1024@0.7', '1024@0.6'],
  );
  const costs = Array.from(plan, (item) => upload.attemptCost(item, 4032, 3024));
  for (let index = 1; index < costs.length; index += 1) {
    assert.ok(costs[index] < costs[index - 1], `第 ${index} 档应比上一档便宜：${costs.join(', ')}`);
  }
  // 用与成本同比例缩放的"模拟体积"验证选择：单调下降 + 最终 ≤ 预算
  const sizes = costs.map((cost) => Math.round(cost * 0.002));
  for (let index = 1; index < sizes.length; index += 1) assert.ok(sizes[index] < sizes[index - 1]);
  const budget = sizes[4] + 1;
  const pick = upload.pickCompressedAttempt(plan, sizes, budget);
  assert.equal(pick.index, 4, '应停在第 5 档（1280@0.7）');
  assert.ok(pick.bytes <= budget, `最终体积 ${pick.bytes} 必须 ≤ 预算 ${budget}`);

  // 全都超预算：返回最小的一档并明确标记没达标（不是"随便返回最后一档"）
  const none = upload.pickCompressedAttempt(plan, sizes, 1);
  assert.equal(none.withinBudget, false);
  assert.equal(none.bytes, Math.min(...sizes));

  // 原图比 1600 还小：不放大，三个尺寸档收成一个，只试质量
  assert.equal(upload.compressionAttempts(800, 600).length, 3);
});

test('多张图片共享 9MB：3 张各分 3MB，压完合计不超过预算', async () => {
  const upload = uploadApi();
  assert.equal(upload.imageBudgetPer(1), 9 * MB);
  assert.equal(upload.imageBudgetPer(3), 3 * MB);
  assert.equal(upload.imageBudgetPer(8), Math.floor((9 * MB) / 8));

  const files = [imageFile(6 * MB, 'a.png'), imageFile(6 * MB, 'b.png'), imageFile(6 * MB, 'c.png')];
  const compress = fakeCompressor();
  const result = await upload.ingestFiles(files, {
    read: async (item) => fakeRecord(item, 8 * MB), // 三张原始 dataUrl 合计 24MB，必压
    compress,
  });
  assert.equal(result.added, 3);
  assert.equal(result.overflow, false);
  assert.deepEqual(
    compress.calls.map((call) => call.budget),
    [3 * MB, 3 * MB, 3 * MB],
    '三张图片应各拿到 3MB 预算',
  );
  const total = upload.imageDataUrlBytes(result.records);
  assert.ok(total <= 9 * MB, `合计 dataUrl 应 ≤ 9MB，实际 ${total}`);
  assert.equal(total, 9 * MB, '每张都压到预算上限时正好用满 9MB');
});

test('张数变化会重算预算：加第二张时，第一张从 9MB 档重压到 4.5MB 档', async () => {
  const upload = uploadApi();
  const firstFile = imageFile(10 * MB, 'first.png');
  const secondFile = imageFile(10 * MB, 'second.png');

  const firstPass = fakeCompressor();
  const first = await upload.ingestFiles([firstFile], {
    read: async (item) => fakeRecord(item, 10 * MB), // 10MB dataUrl > 9MB 预算 → 压到 9MB
    compress: firstPass,
  });
  assert.equal(firstPass.calls[0].budget, 9 * MB);
  assert.equal(first.records[0].dataUrl.length, 9 * MB);

  const secondPass = fakeCompressor();
  const second = await upload.ingestFiles([secondFile], {
    existing: first.records,
    read: async (item) => fakeRecord(item, 10 * MB),
    compress: secondPass,
  });
  assert.equal(secondPass.calls.length, 2, '新图要压，第一张也要按新预算重压');
  assert.deepEqual(
    secondPass.calls.map((call) => call.budget),
    [Math.floor((9 * MB) / 2), Math.floor((9 * MB) / 2)],
  );
  assert.ok(upload.imageDataUrlBytes(second.records) <= 9 * MB);
});

test('压缩不可用（注入失败）：回退原图，合计超 9MB 时整批拒绝而不是发出去撞 413', async () => {
  const upload = uploadApi();
  const files = [imageFile(6 * MB, 'a.png'), imageFile(6 * MB, 'b.png')];
  const result = await upload.ingestFiles(files, {
    read: async (item) => fakeRecord(item, 8 * MB), // 2 × 8MB > 9MB
    compress: async () => {
      throw new Error('canvas unavailable');
    },
  });
  assert.equal(result.overflow, true);
  assert.equal(result.records.length, 0, '超预算时整批回滚，不能留下"看起来能发"的附件');
  assert.match(result.messages.join(' '), /9MB 总上限/);
  assert.match(result.messages.join(' '), /已取消添加/);
});

test('压缩不可用但体积本来就够小：回退原图照常接受（不因噎废食）', async () => {
  const upload = uploadApi();
  const result = await upload.ingestFiles([imageFile(2 * MB, 'small.png')], {
    read: async (item) => fakeRecord(item, 2 * MB),
    compress: async () => {
      throw new Error('canvas unavailable');
    },
  });
  assert.equal(result.overflow, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].dataUrl.length, 2 * MB);
});

test('文本文件不受图片预算影响：读成 text 原样入库', async () => {
  const upload = uploadApi();
  const file = { name: '笔记.md', type: 'text/markdown', size: 12 };
  const result = await upload.ingestFiles([file], {
    read: async (item) => ({ name: item.name, type: item.type, size: item.size, dataUrl: '', text: '# 标题' }),
    compress: async () => {
      throw new Error('文本不应走压缩');
    },
  });
  assert.equal(result.overflow, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, '# 标题');
});

/* ---------------------------------------------------------------- 服务端 */

/** 起一个真实临时实例（随机端口 + 临时数据目录）。 */
async function tempServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-upload-limit-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  return { app, dataDir, port: info.port };
}

/**
 * 用 node:http 发一个 body 长度**精确**为 `totalBytes` 的 JSON 请求。
 *
 * 不先拼出整块 Buffer，而是 prefix + 重复填充 + suffix 分块写：
 * 12MB 的 body 在测试进程里也只占几十 KB 的临时块。
 */
function postJsonOfSize(port, pathname, totalBytes) {
  const prefix = '{"text":"x","padding":"';
  const suffix = '"}';
  const pad = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(pad >= 0, `body 太小，放不下 ${totalBytes} 字节`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1${pathname}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': totalBytes },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    // 服务端在超限时可能提前回包并断开：响应已经拿到后，写端的 EPIPE 不该让测试失败
    let settled = false;
    req.on('response', () => {
      settled = true;
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('请求超时')));
    req.write(prefix);
    let remaining = pad;
    while (remaining > 0) {
      const size = Math.min(64 * 1024, remaining);
      req.write('a'.repeat(size));
      remaining -= size;
    }
    req.write(suffix);
    req.end();
  });
}

test('服务端体积边界：12MB 放行、12MB+1 返回 413 + PAYLOAD_TOO_LARGE（文案含 12MB）', { timeout: 60_000 }, async () => {
  const { app, dataDir, port } = await tempServer();
  try {
    const atLimit = await postJsonOfSize(port, '/ai/chat', 12 * MB);
    assert.notEqual(atLimit.status, 413, `正好 12MB 不该被体积拦，实际 ${atLimit.status} ${atLimit.body.slice(0, 200)}`);
    // 没配 AI 密钥，业务层回 501；关键是**不是** PAYLOAD_TOO_LARGE
    assert.notEqual(JSON.parse(atLimit.body).error?.code, 'PAYLOAD_TOO_LARGE');

    const below = await postJsonOfSize(port, '/ai/chat', 11 * MB);
    assert.notEqual(below.status, 413, '11MB 应通过体积检查（业务 4xx/5xx 都算没被体积拦）');
    assert.notEqual(JSON.parse(below.body).error?.code, 'PAYLOAD_TOO_LARGE');

    const over = await postJsonOfSize(port, '/ai/chat', 12 * MB + 1);
    assert.equal(over.status, 413);
    const payload = JSON.parse(over.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'PAYLOAD_TOO_LARGE');
    assert.match(payload.error.message, /12MB/, '文案要按常量算，写死 1MB 的旧提示会误导用户');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
