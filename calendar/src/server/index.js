/**
 * 后端装配与启动。
 *
 * Electron 主进程与 `npm run start:server` 都通过这里启动同一套服务，
 * 保证「测试窗口」与「独立调试」看到的是同一份数据与同一套接口。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PREFIX, DATA_DIR, DEFAULT_HOST, DEFAULT_PORT, WS_PATH } from '../shared/constants.js';
import { JsonStore } from './store/json-store.js';
import { createRouter } from './http/router.js';
import { WebSocketHub } from './http/websocket.js';
import { EventService } from './services/event-service.js';
import { ScheduleService } from './services/schedule-service.js';
import { ReminderService } from './services/reminder-service.js';
import { CommandService } from './services/command-service.js';
import { CommandParser } from './parser/command-parser.js';
import { AiBridge } from './ai/ai-bridge.js';
import { LmsService } from './lms/service.js';
import { registerRoutes } from './routes/index.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function createServer(options = {}) {
  const dataDir = options.dataDir ?? path.join(PACKAGE_ROOT, DATA_DIR);
  const store = await new JsonStore({ dataDir }).init();

  const hub = new WebSocketHub({ path: WS_PATH });
  const broadcast = (message) => hub.broadcast(message);

  const events = new EventService({ store, broadcast });
  const schedules = new ScheduleService({ store, broadcast });
  const parser = new CommandParser();
  const aiBridge = new AiBridge({ parser });
  const commands = new CommandService({ parser, eventService: events, scheduleService: schedules, store, aiBridge });
  const reminders = new ReminderService({ store, scheduleService: schedules, broadcast });
  // 思源学堂接入：登录态 + 课程/活动缓存 + 同步。可用 options.lms 覆盖配置（测试时指向 mock 服务器）。
  const lms = new LmsService({ store, services: { events, schedules }, broadcast, dataDir, ...(options.lms ?? {}) });
  await lms.restore();

  const router = createRouter();
  const services = { store, events, schedules, commands, reminders, lms };
  registerRoutes(router, { services, aiBridge, hub, version: options.version });

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ws')) {
      res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'UPGRADE_REQUIRED', message: '该路径需要 WebSocket 升级' } }));
      return;
    }
    router.handle(req, res, { services, broadcast });
  });

  server.on('upgrade', (req, socket) => {
    if (hub.matches(req)) hub.handleUpgrade(req, socket);
    else socket.destroy();
  });

  const api = {
    store,
    hub,
    router,
    services,
    aiBridge,
    dataDir,

    listen({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          reminders.start();
          lms.startAutoSync();
          const actual = server.address();
          resolve({
            host,
            port: actual.port,
            baseUrl: `http://${host}:${actual.port}${API_PREFIX}`,
            wsUrl: `ws://${host}:${actual.port}${WS_PATH}`,
          });
        });
      });
    },

    async close() {
      reminders.stop();
      lms.stopAutoSync();
      for (const socket of [...hub.clients]) hub.close(socket);
      // 测试与退出场景下必须主动断开 keep-alive 连接，否则 server.close() 会一直等待
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return api;
}

export { PACKAGE_ROOT };
