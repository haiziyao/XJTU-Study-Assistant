/**
 * 局域网网关的集成测试。
 *
 * 测试原则（与 transfer.test.js 同一套）：
 *   1. **真起主服务 + 真起网关**：网关就挂在传输模块那台设备服务器上，所以这里必须
 *      真的走一遍 HTTP 才有意义 —— 静态托管、反向代理、WebSocket 代理没有一个是
 *      "纯函数"，用假的 server 测等于没测；
 *   2. **端口全随机**：`8886` 上很可能正跑着用户自己的实例（开发机上实测就占着），
 *      测试抢这个端口会随机失败；
 *   3. **不发真 UDP、不出网卡**：`discovery: false` 关掉广播，上游一律 `127.0.0.1`；
 *   4. 一条断言对应一条契约：401 要说清去哪儿看配对码、`?code=` 必须 302 且不把 code 留在
 *      Location 里、路径穿越必须挡住、上游挂掉必须**快速**回 502、WebSocket 必须真的把
 *      后端广播送到"手机侧"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createServer } from '../src/server/index.js';
import { GATEWAY_COOKIE, GATEWAY_PREFIX } from '../src/modules/transfer/gateway.js';
import { connectWs } from './helpers/ws-client.js';

/* ---------------------------------------------------------------- 测试脚手架 */

/** 取一个空闲端口（bind 0 拿系统分配的，随即释放）。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 打一个真 HTTP 请求。
 *
 * 为什么不用 `fetch`：路径穿越那几条要**原样**把 `..` 与 `%2e%2e` 发出去，
 * 而 fetch/URL 会先做规范化；另外这里要拿到响应头原文与二进制 body。
 */
function request(port, reqPath, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${method} ${reqPath}`)));
    if (body === undefined) req.end();
    else req.end(body);
  });
}

/** 手写一次 WebSocket 升级握手，只为看服务端回的那行状态码（不解析帧）。 */
function rawUpgrade(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    const key = Buffer.from('potato-gateway-test').toString('base64');
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${reqPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n\r\n')) return;
      socket.destroy();
      resolve({ status: Number(buffer.split(' ')[1]), head: buffer });
    });
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`升级握手超时：${reqPath}`));
    });
  });
}

const cookieOf = (response) => String(response.headers['set-cookie']?.[0] ?? '').split(';')[0];

/**
 * 起一个「主服务 + 网关」的实例，跑完自动收摊。
 *
 * `gateway.upstreamPort`：
 *   - 不传 → 默认指向本实例主服务的真实端口（正常路径）；
 *   - 传 `null` → **不配置**，让网关自己去认主服务在哪个端口（覆盖自动发现那条链）；
 *   - 传别的端口 → 就指到那儿（"上游挂掉"与"假上游"两条测试靠它）。
 */
async function withGateway(run, { gateway = {}, transfer = {}, name = '网关测试机' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-gateway-'));
  const mainPort = await freePort();
  const devicePort = await freePort();
  const gatewayOptions = { enabled: true, ...gateway };
  if (gatewayOptions.upstreamPort === undefined) gatewayOptions.upstreamPort = mainPort;
  if (gatewayOptions.upstreamPort === null) delete gatewayOptions.upstreamPort;

  const app = await createServer({
    dataDir,
    transfer: { port: devicePort, discovery: false, deviceName: name, ...transfer, gateway: gatewayOptions },
  });
  const info = await app.listen({ port: mainPort, host: '127.0.0.1' });
  await app.services.transfer.ready();

  const transferService = app.services.transfer;
  const device = (reqPath, options) => request(devicePort, reqPath, options);
  const main = (reqPath, options) => request(info.port, reqPath, options);
  /** 用配对码换一张局域网令牌（第一次进门的真实路径）。 */
  const enter = async () => {
    const response = await device(`${GATEWAY_PREFIX}?code=${transferService.codeInfo().code}`);
    return { response, cookie: cookieOf(response), token: cookieOf(response).slice(GATEWAY_COOKIE.length + 1) };
  };

  try {
    await run({ app, dataDir, mainPort: info.port, devicePort, transfer: transferService, device, main, enter });
  } finally {
    // 先停传输服务器（8886 那个端口要释放、网关的 Cookie 与上游 socket 一起收），再关主服务
    await transferService.stop().catch(() => {});
    await app.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const postJson = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ================================================================ 1) 没令牌 */

test('网关：没令牌时 /api 回 401 + 可读 JSON，/app 回「需要一个 6 位配对码」的说明页', async () => {
  await withGateway(async ({ device, devicePort }) => {
    const api = await device('/api/v1/health');
    assert.equal(api.status, 401);
    const payload = JSON.parse(api.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'LAN_TOKEN_REQUIRED');
    // 光说"未授权"没用：必须告诉用户去哪儿看配对码、用什么地址进来
    assert.match(payload.error.message, /配对码/);
    assert.match(payload.error.message, /:(\d+)\/app\?code=xxxxxx/);

    const page = await device(GATEWAY_PREFIX);
    assert.equal(page.status, 401);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.body, /配对码/, '说明页必须写清"需要一个 6 位配对码"');
    assert.match(page.body, /name="code"/, '要有输入框');
    assert.match(page.body, /type="submit"/, '要有提交按钮');
    assert.doesNotMatch(page.body, /<script/i, '说明页不许带脚本（无令牌时唯一能看的页面，越简单越安全）');

    // WebSocket 同样不认白客：升级请求回 401 而不是"连上了但收不到东西"
    const upgrade = await rawUpgrade(devicePort, '/ws');
    assert.equal(upgrade.status, 401);
    assert.match(upgrade.head, /LAN_TOKEN_REQUIRED/);
  });
});

/* ================================================================ 2) 进门 → 令牌 → 代理 */

test('网关：GET /app?code=<正确码> → 302 + Set-Cookie；带 Cookie 访问 /api/health 真的通到后端', async () => {
  await withGateway(async ({ device, transfer, enter }) => {
    const code = transfer.codeInfo().code;
    assert.match(code, /^\d{6}$/);

    const entry = await device(`${GATEWAY_PREFIX}?code=${code}`);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.location, '/app/', '必须落到带斜杠的目录路径（页面资源都是相对路径）');
    assert.doesNotMatch(entry.headers.location, /code=/, 'code 不能留在地址栏/历史里');

    const setCookie = String(entry.headers['set-cookie']?.[0] ?? '');
    assert.match(setCookie, new RegExp(`^${GATEWAY_COOKIE}=[0-9a-f]{48}`), 'HttpOnly Cookie 里放 48 位十六进制令牌');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=1800/, '有效期与传输 token 一致：30 分钟');

    const cookie = cookieOf(entry);
    const health = await device('/api/v1/health', { headers: { Cookie: cookie } });
    assert.equal(health.status, 200, '带令牌的 /api 必须真的代理到主服务');
    const payload = JSON.parse(health.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.websocket.path, '/ws');

    // 静态资源：没令牌只有说明页，有令牌才是真文件
    const denied = await device(`${GATEWAY_PREFIX}/index.html`);
    assert.equal(denied.status, 401);
    assert.match(denied.body, /配对码/);
    const index = await device(`${GATEWAY_PREFIX}/index.html`, { headers: { Cookie: cookie } });
    assert.equal(index.status, 200);
    assert.match(index.body, /AI 智学/);
    // 目录默认页
    const root = await device(`${GATEWAY_PREFIX}/`, { headers: { Cookie: cookie } });
    assert.equal(root.status, 200);
    assert.equal(root.body, index.body, '/app/ 与 /app/index.html 是同一份文件');
    // 老用户（Cookie 还在）直接开 /app（没有结尾斜杠）必须 302 到 /app/：
    // index.html 里的资源都是相对路径，少了这个斜杠整页会 404 白屏
    const bare = await device(GATEWAY_PREFIX, { headers: { Cookie: cookie } });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.location, '/app/');

    // 头令牌（.ipa 壳 / curl / 调试）：Cookie 之外的第二条通道
    const token = cookie.slice(GATEWAY_COOKIE.length + 1);
    const viaHeader = await device('/api/v1/health', { headers: { 'X-Potato-Lan-Token': token } });
    assert.equal(viaHeader.status, 200);
    // 令牌状态可查（页面上要显示"现在有几台设备被授权"），但完整令牌绝不出现在响应里
    const gateway = transfer.status().gateway;
    assert.equal(gateway.enabled, true);
    assert.equal(gateway.tokenCount, 1);
    assert.equal(gateway.tokens.length, 1);
    assert.equal(gateway.tokens[0].id, token.slice(0, 6));
    assert.doesNotMatch(JSON.stringify(gateway), new RegExp(token), '状态里不能回完整令牌');
  });
});

/* ================================================================ 3) 防爆破 */

test('网关：配对码错 5 次 → 429 锁定（复用配对那套计数，令牌错不计入）', async () => {
  // 锁定时间压到 200ms：验证的是状态机，不是真等 60 秒
  await withGateway(
    async ({ device, transfer }) => {
      const code = transfer.codeInfo().code;
      const wrong = code === '000000' ? '111111' : '000000';

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await device(`${GATEWAY_PREFIX}?code=${wrong}`);
        assert.equal(response.status, 401, `第 ${attempt} 次错码应为 401`);
        assert.match(response.body, new RegExp(`还能试 ${5 - attempt} 次`), '说明页要写清还能试几次');
      }
      assert.equal(transfer.status().code.attemptsLeft, 1);

      const fifth = await device(`${GATEWAY_PREFIX}?code=${wrong}`);
      assert.equal(fifth.status, 429, '第 5 次错码直接锁定');
      assert.match(fifth.body, /锁定|错误次数过多/);
      assert.equal(transfer.status().code.locked, true);

      // 锁定期内**正确码也拒绝**（否则锁定形同虚设）
      const locked = await device(`${GATEWAY_PREFIX}?code=${code}`);
      assert.equal(locked.status, 429);
      assert.match(locked.body, /配对码/);

      // 令牌错/过期不增加失败计数：拿一个假令牌打 /api，再确认计数没动
      const before = transfer.status().code.attemptsLeft;
      const bogus = await device('/api/v1/health', { headers: { Cookie: `${GATEWAY_COOKIE}=deadbeef` } });
      assert.equal(bogus.status, 401);
      assert.equal(JSON.parse(bogus.body).error.code, 'LAN_TOKEN_INVALID');
      assert.equal(transfer.status().code.attemptsLeft, before, '令牌错不算猜码');

      // 解锁后正确码照常放行
      await sleep(260);
      const unlocked = await device(`${GATEWAY_PREFIX}?code=${code}`);
      assert.equal(unlocked.status, 302);
      assert.equal(transfer.status().code.attemptsLeft, 5);
    },
    { transfer: { lockoutMs: 200 } },
  );
});

/* ================================================================ 4) 路径穿越 */

test('网关：/app 的路径穿越一律 400/404，读不到 renderer 之外的文件', async () => {
  await withGateway(async ({ device, enter }) => {
    const { cookie } = await enter();
    const attempts = [
      // 明文 `..`：被 WHATWG URL 规范化掉，落到设备服务器的 404
      '/app/../../src/modules/ai/secret.js',
      '/app/../../package.json',
      // 编码过的 `..` 与编码过的 `/`：解码后由 resolveInside 判越界 → 400
      '/app/%2e%2e%2f%2e%2e%2fsrc%2fmodules%2fai%2fsecret.js',
      '/app/..%2f..%2fpackage.json',
    ];
    for (const target of attempts) {
      const response = await device(target, { headers: { Cookie: cookie } });
      assert.ok([400, 404].includes(response.status), `${target} 应 400/404，实际 ${response.status}`);
      assert.doesNotMatch(response.body, /xjtu-study-assistant/, `${target} 不能读到 renderer 之外的文件`);
      assert.doesNotMatch(response.body, /"private": true/, `${target} 不能读到 package.json`);
    }

    // 对照：renderer 内部的文件照常 200（证明上面挡的是"越界"，不是把静态服务整个关掉了）
    const inside = await device('/app/kit/theme.js', { headers: { Cookie: cookie } });
    assert.equal(inside.status, 200);
  });
});

/* ================================================================ 5) MIME 与缓存 */

test('网关：静态 MIME 正确（html/js/css）+ Cache-Control: no-store', async () => {
  await withGateway(async ({ device, enter }) => {
    const { cookie } = await enter();
    const cases = [
      ['/app/index.html', 'text/html'],
      ['/app/shell/shell.css', 'text/css'],
      ['/app/shell/app.js', 'text/javascript'],
      ['/app/kit/theme.js', 'text/javascript'],
    ];
    for (const [target, expected] of cases) {
      const response = await device(target, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${target} 应该存在`);
      assert.match(response.headers['content-type'], new RegExp(`^${expected}`), `${target} 的 MIME 应为 ${expected}`);
      assert.equal(response.headers['cache-control'], 'no-store', `${target} 必须 no-store（前端更新立刻生效）`);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.ok(response.raw.length > 0);
    }
    // 不存在的文件：404（不是 500，也不是空响应）
    const missing = await device('/app/nope/nothing.js', { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);
  });
});

/* ================================================================ 6) 代理逐项透传 */

test('网关：代理逐项透传（方法 / query / 二进制 body / 自定义头 / 状态码 / 响应头）', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/api/v1/teapot')) {
        res.writeHead(418, { 'Content-Type': 'application/json; charset=utf-8', 'X-Upstream': 'yes' });
        res.end(JSON.stringify({ ok: false, error: { code: 'TEAPOT', message: '我是茶壶' } }));
        return;
      }
      // 回显：二进制 body 原样回来才算"没被文本化"
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Upstream': 'yes' });
      res.end(body);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  try {
    await withGateway(
      async ({ device, enter }) => {
        const { cookie } = await enter();
        const binary = Buffer.from([0, 1, 2, 250, 251, 255, 0, 42, 13, 10]);
        const echoed = await device('/api/v1/echo?a=1&b=%E4%B8%AD%E6%96%87', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/octet-stream',
            'X-Potato-Custom': 'yes',
            Authorization: 'Bearer demo',
            'X-Potato-Lan-Token': cookie.slice(GATEWAY_COOKIE.length + 1),
          },
          body: binary,
        });
        assert.equal(echoed.status, 200);
        assert.equal(echoed.headers['content-type'], 'application/octet-stream', '响应头原样回');
        assert.equal(echoed.headers['x-upstream'], 'yes');
        assert.deepEqual(echoed.raw, binary, '二进制 body 必须一字节不差');

        const first = seen[0];
        assert.equal(first.method, 'POST', '方法透传');
        assert.equal(first.url, '/api/v1/echo?a=1&b=%E4%B8%AD%E6%96%87', 'query 原样透传（含编码）');
        assert.equal(first.headers['x-potato-custom'], 'yes', 'X-* 头透传');
        assert.equal(first.headers.authorization, 'Bearer demo', 'Authorization 透传');
        assert.equal(first.headers['content-type'], 'application/octet-stream', 'Content-Type 透传');
        assert.equal(first.headers.host, `127.0.0.1:${upstreamPort}`, 'Host 指向真实上游');
        assert.equal(first.headers['x-potato-lan-token'], undefined, '网关自己的令牌不许漏给后端');
        assert.deepEqual(first.body, binary, '请求体一字节不差');

        // 上游的非 200 状态码与错误体原样回（不是被网关包成 200/502）
        const teapot = await device('/api/v1/teapot', { headers: { Cookie: cookie } });
        assert.equal(teapot.status, 418);
        assert.equal(JSON.parse(teapot.body).error.code, 'TEAPOT');
        assert.equal(teapot.headers['x-upstream'], 'yes');
      },
      { gateway: { upstreamPort } },
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

/* ================================================================ 7) 超时取舍 */

test('网关：30s 上限只盖到响应头之前；SSE 流式响应不被掐', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/slow')) {
      // 迟迟不给响应头：超过上限就该 504，而不是让手机一直转圈
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      }, 400);
      return;
    }
    if (req.url.startsWith('/api/v1/stream')) {
      // SSE：响应头立刻回来，随后每 80ms 一块、共 4 块（总时长 > 上限）
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      let index = 0;
      const timer = setInterval(() => {
        index += 1;
        res.write(`data: chunk-${index}\n\n`);
        if (index >= 4) {
          clearInterval(timer);
          res.end();
        }
      }, 80);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  try {
    // 上限压到 150ms：验证的是"上限生效 + 流式豁免"，不是真等 30 秒
    await withGateway(
      async ({ device, enter }) => {
        const { cookie } = await enter();

        const started = Date.now();
        const slow = await device('/api/v1/slow', { headers: { Cookie: cookie } });
        const elapsed = Date.now() - started;
        assert.equal(slow.status, 504, '超过上限必须回一个明确的 504');
        assert.equal(JSON.parse(slow.body).error.code, 'GATEWAY_TIMEOUT');
        assert.ok(elapsed < 350, `不能挂住（实际 ${elapsed}ms）`);

        const streamStarted = Date.now();
        const stream = await device('/api/v1/stream', { headers: { Cookie: cookie } });
        const streamElapsed = Date.now() - streamStarted;
        assert.equal(stream.status, 200);
        assert.match(stream.headers['content-type'], /text\/event-stream/);
        for (let index = 1; index <= 4; index += 1) {
          assert.match(stream.body, new RegExp(`data: chunk-${index}`), `第 ${index} 块必须送达`);
        }
        assert.ok(streamElapsed > 150, `流式响应必须活过上限（实际 ${streamElapsed}ms）`);
      },
      { gateway: { upstreamPort, timeoutMs: 150 } },
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

/* ================================================================ 8) 上游挂掉 */

test('网关：后端没在跑 → 502 + 可读 JSON（不挂住、不是 500）', async () => {
  const deadPort = await freePort(); // 刚释放，没人监听
  await withGateway(
    async ({ device, enter }) => {
      const { cookie } = await enter();
      const started = Date.now();
      const response = await device('/api/v1/health', { headers: { Cookie: cookie } });
      const elapsed = Date.now() - started;
      assert.equal(response.status, 502);
      const payload = JSON.parse(response.body);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'GATEWAY_UPSTREAM_DOWN');
      assert.match(payload.error.message, /后端没在跑/);
      assert.equal(payload.error.details.upstream.port, deadPort);
      assert.ok(elapsed < 3000, `必须快速失败（实际 ${elapsed}ms）`);
    },
    { gateway: { upstreamPort: deadPort } },
  );
});

/* ================================================================ 9) WebSocket 代理 */

test('网关：WebSocket /ws 代理真的通（后端广播能到"手机侧"），没令牌的升级被 401 挡下', async () => {
  await withGateway(async ({ device, devicePort, enter }) => {
    const { cookie, token } = await enter();

    // 复用仓库里的 ws 客户端。浏览器的 WebSocket API 不能自定义请求头，测试这个客户端
    // 也不能 —— 所以握手用 `?lan_token=` 这条通道（浏览器的正常路径其实是同源 Cookie）。
    const client = await connectWs({ port: devicePort, path: `/ws?lan_token=${token}` });
    try {
      // 通过网关发一次**真实写入** → 后端广播 data_changed → 手机侧应该收到
      const created = await device('/api/v1/memories', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global', key: 'gateway_lan_test', text: '网关测试：这条广播应该出现在手机侧' }),
      });
      assert.equal(created.status, 201, `写入应经代理成功：${created.body.slice(0, 200)}`);
      const memoryId = JSON.parse(created.body).item.id;

      const message = await client.waitFor((item) => item.type === 'data_changed' && item.module === 'memory', 5000);
      assert.equal(message.payload.module, 'memory');
      assert.equal(message.payload.action, 'create');
      assert.equal(message.payload.id, memoryId, '收到的必须是刚才那条写入引发的广播（不是别的消息）');
    } finally {
      client.close();
    }

    // 没令牌的升级：401（而不是"连上了但永远收不到推送"）
    const denied = await rawUpgrade(devicePort, '/ws');
    assert.equal(denied.status, 401);
    assert.match(denied.head, /LAN_TOKEN_REQUIRED/);

    // 普通 HTTP 打到 /ws：与主服务口径一致（426）
    const plain = await device('/ws', { headers: { Cookie: cookie } });
    assert.equal(plain.status, 426);
    assert.equal(JSON.parse(plain.body).error.code, 'UPGRADE_REQUIRED');
  });
});

/* ================================================================ 10) 默认关闭 / 开关 / 注销 */

test('网关：默认关闭（8886 上不提供 /app），页面上打开后才出现，注销能一键踢掉所有手机', async () => {
  await withGateway(
    async ({ device, main, transfer, enter }) => {
      // ① 默认关：8886 上只剩协议那 4 条路由，/app 与 /api 都是 404
      assert.equal(transfer.status().gateway.enabled, false);
      assert.equal((await device(GATEWAY_PREFIX)).status, 404);
      assert.equal((await device('/api/v1/health')).status, 404);
      assert.equal((await device('/info')).status, 200, '网关关着不影响设备直传协议');
      // 控制面如实报告"关着"，并照样给出地址（用户要先看到地址才决定开不开）
      const off = JSON.parse((await main('/api/v1/transfer/status')).body).gateway;
      assert.equal(off.enabled, false);
      assert.equal(off.tokenCount, 0);
      assert.ok(Array.isArray(off.urls));
      assert.match(off.entry, /:(\d+)\/app\?code=xxxxxx$/);

      // ② 打开（页面上的开关就是打这个接口）
      const enabled = await main('/api/v1/transfer/gateway', postJson({ enabled: true }));
      assert.equal(enabled.status, 200);
      const on = JSON.parse(enabled.body).gateway;
      assert.equal(on.enabled, true);
      assert.ok(on.urls.length >= 1, '至少要给一个局域网地址（有非回环 IPv4 就该有）');
      assert.match(on.urls[0], /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/app$/, '地址要能被用户直接照着输/复制');
      assert.equal(on.port, transfer.status().port, '地址里的端口就是设备服务器的真实端口');

      // 打开之后才进得去
      const { cookie, token } = await enter();
      assert.equal((await device('/api/v1/health', { headers: { Cookie: cookie } })).status, 200);
      assert.equal(transfer.status().gateway.tokenCount, 1);

      // ③ 全部注销：一键踢掉所有手机
      const revoked = await main('/api/v1/transfer/gateway/revoke', postJson({}));
      assert.equal(JSON.parse(revoked.body).revoked, 1);
      assert.equal(transfer.status().gateway.tokenCount, 0);
      const kicked = await device('/api/v1/health', { headers: { Cookie: cookie } });
      assert.equal(kicked.status, 401);
      assert.equal(JSON.parse(kicked.body).error.code, 'LAN_TOKEN_INVALID');
      assert.doesNotMatch(JSON.stringify(transfer.status().gateway), new RegExp(token), '注销后状态里不该还有它');

      // ④ 关掉开关：入口立刻消失（且令牌一并作废）
      const disabled = await main('/api/v1/transfer/gateway', postJson({ enabled: false }));
      assert.equal(JSON.parse(disabled.body).gateway.enabled, false);
      assert.equal((await device(GATEWAY_PREFIX)).status, 404);
      assert.equal(transfer.status().gateway.tokenCount, 0);
    },
    { gateway: { enabled: false } },
  );
});

/* ================================================================ 11) 令牌过期 */

test('网关：令牌过期后页面能重新输码（说明页 + ?code= 两条路都在）', async () => {
  await withGateway(
    async ({ device, transfer, enter }) => {
      const { response, cookie } = await enter();
      assert.equal(response.status, 302);
      assert.equal((await device('/api/v1/health', { headers: { Cookie: cookie } })).status, 200);

      await sleep(220); // 令牌 TTL 只给 150ms

      const expired = await device('/api/v1/health', { headers: { Cookie: cookie } });
      assert.equal(expired.status, 401);
      assert.equal(JSON.parse(expired.body).error.code, 'LAN_TOKEN_INVALID');
      assert.match(JSON.parse(expired.body).error.message, /过期|失效/);

      // 页面：说明页要明确告诉用户"上次的令牌失效了，重新输码"，输入框还在
      const page = await device(GATEWAY_PREFIX, { headers: { Cookie: cookie } });
      assert.equal(page.status, 401);
      assert.match(page.body, /失效|过期/);
      assert.match(page.body, /name="code"/);

      // ?code= 这条路照常能再换一张票
      const again = await device(`${GATEWAY_PREFIX}?code=${transfer.codeInfo().code}`);
      assert.equal(again.status, 302);
      assert.equal((await device('/api/v1/health', { headers: { Cookie: cookieOf(again) } })).status, 200);
    },
    { gateway: { tokenTtlMs: 150 } },
  );
});

/* ================================================================ 12) 自动认出主服务端口 */

test('网关：不配置上游端口时自己认出主服务（不是写死 3210，也不会认成别的实例）', async () => {
  await withGateway(
    async ({ device, main, transfer, mainPort, devicePort, enter }) => {
      const { cookie } = await enter();
      const response = await device('/api/v1/transfer/status', { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, '没配置上游时也要能代理（靠进程自查 / 探测）');
      const payload = JSON.parse(response.body);
      assert.equal(payload.device.name, '网关测试机', '必须代理到"这一台"，而不是碰巧在 3210 上的别的实例');
      assert.equal(payload.port, devicePort);

      const gateway = JSON.parse((await main('/api/v1/transfer/status')).body).gateway;
      assert.equal(gateway.upstream.port, mainPort, '认出来的端口应该就是本实例主服务的端口');
      assert.ok(['self', 'scan', 'env'].includes(gateway.upstream.source), `来源应为自查/扫描，实际 ${gateway.upstream.source}`);
      assert.equal(transfer.status().gateway.enabled, true);
    },
    { gateway: { upstreamPort: null } },
  );
});

/* ================================================================ 13) 「传输」页那一块 */

/**
 * 「传输」页的渲染测试（用仓库里的 DOM 桩真跑一遍 `render()`）。
 *
 * 为什么要有它：网关的开关只存在于这一页 —— 后端接口再对，页面上没有入口（或者把
 * 风险提示写丢了）用户就永远打不开、也不知道打开了意味着什么。所以这里锁住三件事：
 *   1. 关着的时候**没有**地址、没有"全部注销"（也没有假装能用）；
 *   2. 打开后给出可复制的局域网地址 + 手机怎么用 + 已授权设备数 + 全部注销按钮；
 *   3. 风险原话必须在页面上（"拿到配对码的设备可以访问你本机的数据"）。
 */
test('传输页：网关开关默认关、风险提示在页面上；打开后给出可复制地址与「全部注销」', async () => {
  const { bootRenderer } = await import('./helpers/renderer-dom.js');

  const statusOf = (gateway) => ({
    device: { id: 'dev-1', name: '测试机', platform: 'darwin', version: null },
    port: 8886,
    configuredPort: 8886,
    host: '0.0.0.0',
    listening: true,
    error: null,
    accepting: true,
    discoverable: false,
    code: {
      code: '123456',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      remainingMs: 600_000,
      attemptsLeft: 5,
      locked: false,
      lockedUntil: null,
    },
    peers: [],
    discovery: { enabled: false, bound: false, error: null, peers: 0, port: 8886, udp: false, sent: 0, received: 0 },
    gateway,
    progress: { outgoing: null, incoming: [] },
    catalog: [],
    log: [],
    lastResult: null,
    suspects: [],
  });

  const off = bootRenderer({ api: async () => statusOf({ enabled: false, urls: ['http://192.168.1.9:8886/app'], tokens: [], tokenCount: 0, entry: 'http://<电脑IP>:8886/app?code=xxxxxx' }) });
  const offMount = await off.render('transfer', { wait: 30 });
  const offText = offMount.textContent;
  assert.match(offText, /允许手机\/平板在局域网内打开本程序/, '开关的说明文字要在页面上');
  assert.match(offText, /同一局域网内、拿到配对码的设备可以访问你本机的数据/, '风险必须写在开关旁边（不粉饰）');
  assert.equal(offMount.querySelector('.tf-lan-url'), null, '关着的时候不给地址（不给"看起来能用"的错觉）');
  assert.doesNotMatch(offText, /全部注销/, '没开就没有可注销的东西');

  const on = bootRenderer({
    api: async () => statusOf({
      enabled: true,
      urls: ['http://192.168.1.9:8886/app'],
      tokens: [{ id: 'abc123', label: 'iOS 设备', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }],
      tokenCount: 1,
      entry: 'http://<电脑IP>:8886/app?code=xxxxxx',
    }),
  });
  const onMount = await on.render('transfer', { wait: 30 });
  const onText = onMount.textContent;
  const url = onMount.querySelector('.tf-lan-url');
  assert.ok(url, '打开后必须给出局域网地址');
  assert.equal(url.textContent, 'http://192.168.1.9:8886/app');
  assert.match(onText, /添加到主屏幕/, '要告诉用户手机上怎么变成 App');
  assert.match(onText, /现在有 1 台设备被授权/);
  assert.match(onText, /iOS 设备/, '能看出被授权的是哪台设备');
  const buttons = onMount.querySelectorAll('button').map((node) => node.textContent);
  assert.ok(buttons.includes('复制'), '地址要能一键复制');
  assert.ok(buttons.includes('全部注销'), '要有一键踢掉所有手机的按钮');
});

