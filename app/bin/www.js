#!/usr/bin/env node
/**
 * 服务端版（公开网页）入口：`node bin/www.js` 起 8866。
 *
 * 与 `bin/server.js` 的关系：
 *   - `bin/server.js` 起的是**单用户本地后端**（只监听 127.0.0.1:3210，给 Electron 与联调用）；
 *   - 本文件起的是**多租户宿主**：对外一个端口（默认 8866），对内为每个账号懒启动一台
 *     `bin/server.js` 那样的后端实例（127.0.0.1 的随机端口，公网不可达）。
 *   两者共用同一份 `src/modules/**`，所以功能不会分叉。
 *
 * 环境变量：
 * - POTATO_WWW_PORT  监听端口，默认 8866（`PORT` 也认，方便某些 PaaS/隧道）
 * - POTATO_WWW_HOST  监听地址，默认 127.0.0.1（反代/隧道场景可设 0.0.0.0，见 README 的警告）
 * - POTATO_WWW_DIR   账号库与每用户数据目录，默认 `<app>/data-www`
 * - POTATO_WWW_TRUST_PROXY=1  信任 `X-Forwarded-For`（反代后面才打开，直连时**不要**开）
 * - POTATO_WWW_SECURE_COOKIES=1  反代是 HTTPS 时给会话 Cookie 加 `Secure`
 * - POTATO_WWW_IDLE_MS  每用户后端实例的空闲回收阈值（毫秒；0 = 不回收）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWwwServer, WWW_DIR, WWW_PORT } from '../src/www/server.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.env.POTATO_WWW_PORT ?? process.env.PORT ?? WWW_PORT);
const host = process.env.POTATO_WWW_HOST ?? '127.0.0.1';
const dataDir = process.env.POTATO_WWW_DIR ? path.resolve(process.env.POTATO_WWW_DIR) : path.join(PACKAGE_ROOT, WWW_DIR);
const trustProxy = process.env.POTATO_WWW_TRUST_PROXY === '1';
const secureCookies = process.env.POTATO_WWW_SECURE_COOKIES === '1';
const idleMs = process.env.POTATO_WWW_IDLE_MS !== undefined ? Number(process.env.POTATO_WWW_IDLE_MS) : undefined;

const www = await createWwwServer({ dataDir, trustProxy, secureCookies, idleMs });
await www.init();
const info = await www.listen({ host, port });

console.log('[AI 智学] 服务端版已启动');
console.log(`  网页      ${info.url}`);
console.log(`  账号库    ${www.dataDir}`);
console.log(`  每用户数据 ${path.join(www.dataDir, 'users', '<userId>')}`);
console.log(`  首个注册的账号自动成为管理员；之后注册需要管理员发邀请码`);
if (!trustProxy) console.log('  提示：若前面挂了反向代理/隧道，请用 POTATO_WWW_TRUST_PROXY=1 让登录限速认到真实客户端 IP');

const shutdown = async (signal) => {
  console.log(`\n[AI 智学] 收到 ${signal}，正在关闭…`);
  try {
    await www.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
