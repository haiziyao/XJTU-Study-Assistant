#!/usr/bin/env node
/**
 * 独立启动后端（不启动 Electron），用于接口联调与自动化测试。
 *
 * 环境变量：
 * - PORT / HOST    监听地址，默认 127.0.0.1:3210
 * - DATA_DIR       数据目录，默认 <项目根>/data
 */

import path from 'node:path';
import { createServer, PACKAGE_ROOT } from '../src/server/index.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/shared/constants.js';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? DEFAULT_HOST;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined;

const app = await createServer({ dataDir });
const info = await app.listen({ host, port });

console.log('[potato-calendar] 后端已启动');
console.log(`  REST      ${info.baseUrl}`);
console.log(`  WebSocket ${info.wsUrl}`);
console.log(`  数据目录  ${app.dataDir}`);
console.log(`  项目根    ${PACKAGE_ROOT}`);

const shutdown = async (signal) => {
  console.log(`\n[potato-calendar] 收到 ${signal}，正在关闭...`);
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
