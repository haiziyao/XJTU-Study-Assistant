/**
 * 宿主的静态托管：公开登录页（`/login/**`）与登录后的应用页面（`/app/**`）。
 *
 * 路径穿越防护与 `LanGateway#serveStatic` 同一套（那套已经在测试里被 `..`、`%2e%2e%2f`
 * 与 `\0` 打过）：
 *   1. `decodeURIComponent` 之后再判 —— 编码过的 `/`（`%2f`）骗不过 WHATWG URL 的规范化，
 *      但编码过的 `.` 能，所以解码必须在规范化之后；
 *   2. 用 core 的 `resolveInside()` 判"解析结果是否仍在根目录内"（**只读复用**，不改 core）；
 *   3. 只发实际存在的普通文件，目录自动补 `index.html`；
 *   4. 一律 `no-store`：前端更新要立刻生效，否则手机上会一直跑旧代码。
 *
 * 与网关的唯一区别：根目录有两个（登录页 / 渲染层），路由归属由调用方决定。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HttpError } from '../core/http/router.js';
import { contentTypeOf, resolveInside } from '../core/http/static.js';

/**
 * 把 `<prefix>/**` 下的相对路径解析成根目录内的绝对文件路径。
 * @returns {Promise<{file: string, stat: import('node:fs').Stats}>}
 */
export async function resolveStaticFile(root, relative, { label = '静态资源' } = {}) {
  const clean = String(relative ?? '');
  if (clean.includes('\0')) throw HttpError.badRequest(`${label}路径包含非法字符`);
  const file = resolveInside(root, clean);
  if (!file) {
    // 越界：400 而不是"悄悄 404"，排查时能立刻看出是攻击还是相对路径写错了
    throw HttpError.badRequest(`${label}越界：${clean}`);
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw HttpError.notFound(`${label}不存在：${clean}`);
  }
  if (stat.isDirectory()) {
    const index = path.join(file, 'index.html');
    try {
      stat = await fs.stat(index);
    } catch {
      throw HttpError.notFound(`${label}不存在：${clean}index.html`);
    }
    return { file: index, stat };
  }
  return { file, stat };
}

/** 发一个文件（二进制安全）。 */
export async function sendFile(res, file, { extraHeaders = {} } = {}) {
  const body = await fs.readFile(file);
  if (res.writableEnded) return;
  res.writeHead(200, {
    'Content-Type': contentTypeOf(file),
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

/** 裸前缀（没有结尾斜杠）302 到带斜杠的目录路径。 */
export function redirectToDirectory(res, prefix, search = '') {
  res.writeHead(302, {
    Location: `${prefix}/${search ? `?${search}` : ''}`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': 0,
    'Cache-Control': 'no-store',
  });
  res.end();
}

/**
 * 发一段 HTML 字符串（登录页是**文件**，但 `GET /` 要按登录态在页面之间切换，
 * 所以由宿主读文件后原样发出 —— 不在代码里内联 HTML）。
 */
export function sendHtml(res, html, { status = 200, extraHeaders = {} } = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}
