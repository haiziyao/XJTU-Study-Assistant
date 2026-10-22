#!/usr/bin/env node
/**
 * 本地反代：127.0.0.1:9000 -> 127.0.0.1:8866
 *
 * 为什么存在：给 frpc 的 http 隧道一个**固定端口**的入口。应用自己的端口变了、
 * 或者要临时换一个监听地址，都只改这一个文件，隧道那边不用动。
 *
 * 三个必须做对的地方（否则隧道那头会"能打开但用不了"）：
 *   1. WebSocket：必须手工转 `upgrade`，普通 HTTP 转发不处理它 —— 智学的 /ws
 *      承担 AI 流式回复，坏了表现是"发了消息没反应"。
 *   2. 不做缓冲：响应体直接 pipe 给客户端。一旦中间层攒满才吐，
 *      前端的流式输出就变成"憋很久然后整段蹦出来"。
 *   3. 超时：AI 一轮可能几十秒不吐字，默认超时会把长连接掐掉。
 *
 * 不引入任何依赖（和应用本体同一个思路：Node 内置模块够用）。
 */
'use strict';

const http = require('node:http');
const net = require('node:net');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.PROXY_PORT || 9000);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.PROXY_TARGET_PORT || 8866);

const stamp = () => new Date().toISOString();
const log = (...args) => console.log(`[${stamp()}] [local-proxy]`, ...args);

/* --------------------------------------------------------------- HTTP 转发 */
const server = http.createServer((req, res) => {
  const headers = { ...req.headers };

  // 隧道那头的 nginx/frps 一般已经带了 x-forwarded-*；缺的才补。
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = req.headers.host || '';

  // Host 原样透传：应用只把它当 URL 解析的 base，不做域名校验。
  headers.connection = 'keep-alive';

  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
    (up) => {
      // 不缓冲，直接流式回传
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    log(`上游 ${TARGET_PORT} 出错: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`上游 ${TARGET_HOST}:${TARGET_PORT} 不可用：${err.message}\n`);
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

/* ---------------------------------------------------------- WebSocket 转发 */
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    // 原样重放请求行与头，握手才不会被中间层改坏
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', (err) => {
    log(`WS 上游出错: ${err.message}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});

/* ------------------------------------------------ 关闭所有「会掐长连接」的超时 */
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 65_000;

server.on('error', (err) => {
  log(`监听 ${LISTEN_PORT} 失败: ${err.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`就绪  http://${LISTEN_HOST}:${LISTEN_PORT}  ->  http://${TARGET_HOST}:${TARGET_PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭`);
    server.close(() => process.exit(0));
  });
}
