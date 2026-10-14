/**
 * 服务端版（www 宿主）测试脚手架。
 *
 * 三条原则（与 transfer-gateway.test.js 一致）：
 *   1. **真起宿主**：账号接口、静态托管、反向代理、WebSocket 代理没有一个是纯函数，
 *      用假的 server 测等于没测；
 *   2. **端口全随机 + 数据目录进临时目录**：开发机上 8866 很可能正跑着用户自己的实例，
 *      抢端口会随机失败；数据目录更不能碰 `app/data-www`（那是真账号）；
 *   3. **零真实外网**：所有上游都是本进程内的 127.0.0.1 随机端口。
 */

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createWwwServer } from '../../src/www/server.js';

/** 取一个空闲端口（bind 0 拿系统分配的，随即释放）。 */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 打一个真 HTTP 请求。
 *
 * 为什么不用 `fetch`：这里要**原样**把带编码的 `..` 发出去（fetch/URL 会先规范化），
 * 还要拿到 `Set-Cookie` 原文与响应头原文 —— curl 能做的、断言需要的，都要能拿到。
 */
export function request(port, reqPath, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload !== null && finalHeaders['content-type'] === undefined && finalHeaders['Content-Type'] === undefined) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    if (payload !== null) finalHeaders['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, text, json, cookie: cookieOf(res.headers['set-cookie']) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${method} ${reqPath}`)));
    if (payload === null) req.end();
    else req.end(payload);
  });
}

/** 从 `Set-Cookie` 里取出"名字=值"那一段（`Cookie` 请求头要的就是它）。 */
export function cookieOf(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const first = list[0];
  if (!first) return null;
  return String(first).split(';')[0];
}

/** 手写一次 WebSocket 升级握手，只看服务端回的那行状态码（不解析帧）。 */
export function rawUpgrade(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    const key = Buffer.from('potato-www-test').toString('base64');
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
      const status = Number(buffer.split(' ')[1]);
      socket.destroy();
      resolve({ status, head: buffer.slice(0, buffer.indexOf('\r\n\r\n')) });
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`升级握手超时：${reqPath}`));
    });
  });
}

/**
 * 起一台宿主（临时数据目录 + 随机端口），并返回它的地址与一个便捷的 `call()`。
 * @param {object} [options] 透传给 createWwwServer
 */
export async function startWww(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-www-'));
  const www = await createWwwServer({
    dataDir: dir,
    idleMs: 0, // 默认不回收：回收单独用 reap() 显式触发，避免测试被后台定时器干扰
    logger: { log() {}, warn() {}, error() {} },
    ...options,
  });
  await www.init();
  const info = await www.listen({ port: 0 });
  return {
    www,
    dir,
    port: info.port,
    url: info.url,
    call: (reqPath, opts) => request(info.port, reqPath, opts),
    async close() {
      await www.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 注册一个账号，返回 `{user, cookie, token, status, body}`（cookie 已是 `Cookie` 头的形状）。 */
export async function register(app, { username, password = 'password1', inviteCode } = {}) {
  const res = await app.call('/auth/register', { method: 'POST', body: { username, password, inviteCode } });
  return {
    status: res.status,
    body: res.json,
    user: res.json?.user,
    cookie: res.cookie,
    // 会话令牌同时也接受 Bearer / X-Potato-Token，测试里要拿它来验手机客户端的路径
    token: res.cookie ? String(res.cookie).split('=')[1] : null,
  };
}

/** 登录取 Cookie。 */
export async function login(app, { username, password }) {
  const res = await app.call('/auth/login', { method: 'POST', body: { username, password } });
  return { status: res.status, body: res.json, cookie: res.cookie, token: res.cookie ? String(res.cookie).split('=')[1] : null };
}
