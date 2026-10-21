/**
 * 反向代理（`/api/**`）与 WebSocket 代理（`/ws`）。
 *
 * 这一份是 `src/modules/transfer/gateway.js` 里那套**已验证**实现的等价移植（那份在
 * `test/transfer-gateway.test.js` 里被真起服务、真跑代理、真跑升级验过）。
 *
 * 为什么不直接 import 它的类、而要写第二份：
 *   - `LanGateway` 的门票是"6 位配对码换来的局域网令牌"，上游地址是"从本进程正在监听的
 *     端口里认出主服务"；而这里要的是"账号会话令牌 + 每个用户自己那台实例的端口"。
 *     把两者的鉴权/上游解析抽成公共层，等于同时动 `transfer` 模块的既有语义
 *     （硬约束：不许改），风险比多写 200 行大得多；
 *   - 于是**只**复用其中与业务无关的那部分：逐跳头过滤、超时语义、head 不能丢、
 *     失败形状与 `502/504` 的口径。这些在下面逐条注明了出处。
 *
 * 超时的取舍（照抄 gateway 的结论，理由同样成立）：
 *   - `UPSTREAM_TIMEOUT_MS` 只盖到**响应头回来之前**：后端没起来/卡住时，浏览器最终要看到
 *     一个明确的错误，而不是一个永远转圈的请求；
 *   - 响应开始之后改成**空闲超时**（每来一块数据就重置），"慢但在动"的流不会被误杀；
 *   - `text/event-stream`（SSE）与 WebSocket **完全豁免**：AI 流式回复几十秒不吐字是正常的，
 *     用总时长掐掉它，表现就是"AI 答一半就没声了"。
 */

import http from 'node:http';
import net from 'node:net';

import { HttpError } from '../core/http/router.js';

/**
 * 上游响应上限：**4 分钟**（2026-10-21 由 30 秒放宽）。
 *
 * 30 秒在真实网络下会误杀"正在干活但还没吐第一个字节"的请求 ——
 * 一次多端同步要搬数据、一次 AI 整理要调模型，在家宽上行 + 中转链路上
 * 几十秒到几分钟都算正常。放到 240 秒后，卡死的后端仍然会以 504 收场，
 * 只是等得更久一点；这比"任务其实成功了、前端却报超时"要好。
 *
 * 同一个值也用作**响应中空闲超时**（每收到一块数据就重置）：连续 4 分钟一个字节都不来，
 * 已经可以断定这条连接死了。
 */
export const UPSTREAM_TIMEOUT_MS = 240 * 1000;

/** 逐跳头（RFC 7230 §6.1）：属于"这一段连接"的，不能透传。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * **不透传**给用户后端的请求头。
 *
 * 这三样都是"宿主自己的凭据"：会话 Cookie / Bearer / `X-Potato-Token`。
 * 用户后端是本地无鉴权服务，它既用不到这些，也没有理由在自己的内存里看到它们 ——
 * 少一处凭据流转，就少一处日志或错误信息把令牌漏出去的机会。
 * （`X-Potato-Token` 在主服务里是给"本地令牌"预留的位置，宿主层既然拿它当会话令牌用，
 *   就更不能让它往下走：两套语义撞在一起时，最容易出的 bug 是"下游把它当成了别的东西"。）
 */
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'x-potato-token']);

const STATUS_TEXT = { 401: 'Unauthorized', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

/**
 * 已经升级成裸 socket 的连接上没法用 `res`，只能手写一行 HTTP 响应。
 * （浏览器在 WebSocket 失败时只看得到"连接被关闭"，所以这一行必须写清楚为什么。）
 */
export function writeSocketJson(socket, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Cache-Control: no-store',
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  socket.end();
}

/** 请求头过滤：逐跳头、宿主凭据、以及 `host`（要改成上游的 host:port）。 */
function forwardRequestHeaders(req, target) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || CREDENTIAL_HEADERS.has(lower) || lower === 'host') continue;
    headers[lower] = value;
  }
  headers.host = `${target.host}:${target.port}`;
  return headers;
}

/**
 * `req` -> 上游，上游的响应原样回给 `req`。
 *
 * `path` 用 `req.url` 原文：查询串、编码过的路径、`?` 后面的东西都要一字不差地过去
 * （`new URL()` 会规范化掉一部分，前端按相对路径拼出来的请求可能因此对不上）。
 */
export async function proxyHttp(req, res, { target, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const headers = forwardRequestHeaders(req, target);
  await new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (error) reject(error);
      else resolve();
    };

    const upstreamReq = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url ?? '/', headers },
      (upstreamRes) => {
        clearTimer();
        const contentType = String(upstreamRes.headers['content-type'] ?? '');
        const streaming = contentType.startsWith('text/event-stream');
        if (!streaming) {
          const bump = () => {
            clearTimer();
            timer = setTimeout(() => upstreamRes.destroy(new Error('WWW_IDLE_TIMEOUT')), timeoutMs);
            timer.unref?.();
          };
          bump();
          upstreamRes.on('data', bump);
        }
        const responseHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          responseHeaders[name] = value;
        }
        if (!res.writableEnded) res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.on('error', () => {
          // 响应已经开始：没法再改成 JSON 了，只能断开，让前端看到"连接中断"而不是半截数据
          res.destroy();
          finish();
        });
        upstreamRes.pipe(res);
        res.on('close', () => upstreamRes.destroy());
        upstreamRes.on('end', () => finish());
        // 客户端提前断开时 upstreamRes 会被 destroy()（不触发 end）：补一次收尾，
        // 否则这个 Promise 永远不 resolve
        upstreamRes.on('close', () => finish());
      },
    );

    // 请求阶段超时：只盖到"响应头回来之前"
    timer = setTimeout(() => upstreamReq.destroy(new Error('WWW_TIMEOUT')), timeoutMs);
    timer.unref?.();

    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
        finish();
        return;
      }
      const message = String(error?.message ?? '');
      if (message.includes('WWW_TIMEOUT')) {
        finish(new HttpError(504, 'GATEWAY_TIMEOUT', `后端 ${Math.round(timeoutMs / 1000)} 秒没响应：${target.host}:${target.port}`));
        return;
      }
      if (message.includes('WWW_IDLE_TIMEOUT')) {
        finish(new HttpError(504, 'GATEWAY_TIMEOUT', `后端 ${Math.round(timeoutMs / 1000)} 秒没有新数据`));
        return;
      }
      finish(
        new HttpError(502, 'GATEWAY_UPSTREAM_DOWN', `该账号的后端实例没在跑：连不上 ${target.host}:${target.port}`, {
          upstream: { host: target.host, port: target.port },
        }),
      );
    });

    // 客户端提前断开（锁屏、切后台、关标签页）时别让上游请求悬着
    req.on('aborted', () => upstreamReq.destroy());
    req.on('error', () => upstreamReq.destroy());
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });
}

/**
 * `/ws` 升级：把 socket 双向接到该用户的后端实例。
 *
 * 手写的原因（硬约束）：不许引 `ws` / `http-proxy` 之类依赖，而 `http` 的 `upgrade`
 * 事件已经把"还没被解析的原始 socket + 首次多读出来的 head"交给我们了 ——
 * 把请求行与头原样重写一遍给上游，然后把两个 socket 对插即可。
 * 关键是 **head 不能丢**：客户端可能在握手后立刻发了帧，那部分字节既不在 `req` 里
 * 也不会再触发一次 `data`，丢了就是"连上了但第一帧永远不到"。
 *
 * @returns {Promise<{upstream: net.Socket|null}>} 调用方拿它来配对 `socketClose()`
 */
export async function proxyUpgrade(req, socket, head, { target, onClose = null } = {}) {
  // 先暂停：写请求头之前的字节留在内核缓冲里，pipe 时不会丢
  socket.pause();
  const upstream = net.connect({ host: target.host, port: target.port });
  // `onClose`（宿主用它做"这条 WS 不再占用实例"的计数）必须**恰好调用一次**：
  // 'error' 之后紧跟 'close' 是常态，计数减两次会让实例被过早回收。
  let notified = false;
  const notify = () => {
    if (notified) return;
    notified = true;
    onClose?.();
  };
  const cleanup = () => {
    notify();
    if (!upstream.destroyed) upstream.destroy();
    if (!socket.destroyed) socket.destroy();
  };

  upstream.on('connect', () => {
    if (socket.destroyed) {
      cleanup();
      return;
    }
    const lines = [`GET ${req.url ?? '/ws'} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (value === undefined || name.toLowerCase() === 'host') continue;
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    upstream.setNoDelay(true);
    socket.setNoDelay(true);
    socket.pipe(upstream);
    upstream.pipe(socket);
    // 半关也要收干净：任一端关闭就两边都拆，避免留一个"永远挂着"的 socket
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    upstream.on('close', cleanup);
    upstream.on('error', cleanup);
  });

  upstream.on('error', () => {
    notify();
    if (!socket.destroyed) {
      writeSocketJson(socket, 502, {
        ok: false,
        error: { code: 'GATEWAY_UPSTREAM_DOWN', message: `该账号的后端实例没在跑：连不上 ${target.host}:${target.port}` },
      });
    }
  });

  return { upstream };
}
