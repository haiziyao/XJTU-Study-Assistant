/**
 * 后端装配与启动。
 *
 * Electron 主进程与 `npm run start:server` 都通过这里启动同一套服务，
 * 保证「测试窗口」与「独立调试」看到的是同一份数据与同一套接口。
 *
 * 装配流程（由模块注册表驱动，**新增功能不需要修改本文件**）：
 *   1. `loadModules()` 扫描 src/modules/<id>/module.js，按 order 排序
 *   2. 建数据层：JsonStore（框架集合 + 各模块声明的集合）
 *   3. 逐模块 `createServices`（order 小的先建，后面的模块能看到前面的服务）
 *   4. 逐模块 `restore`（在 listen 之前；单个失败降级继续，不拖垮启动）
 *   5. 注册路由：核心路由 + 各模块 `registerRoutes`
 *   6. `listen` 成功后逐模块 `start`；`close` 时**逆序** `stop`
 *
 * 跨模块依赖靠 `order` 表达（例：lms 20 依赖 calendar 10），契约见 core/module/contract.js。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PREFIX, DATA_DIR, DEFAULT_HOST, DEFAULT_PORT, WS_PATH } from '../shared/constants.js';
import { JsonStore } from '../core/store/json-store.js';
import { createRouter } from '../core/http/router.js';
import { WebSocketHub } from '../core/http/websocket.js';
import { AiBridge } from '../core/ai/ai-bridge.js';
import { describeModules, loadModules } from '../core/module/registry.js';
import { CommandService } from '../core/commands/command-service.js';
import { CommandParser } from '../modules/calendar/parser.js';
import { registerRoutes } from './routes/index.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function createServer(options = {}) {
  const dataDir = options.dataDir ?? path.join(PACKAGE_ROOT, DATA_DIR);

  // ---------------------------------------------------------------- 1) 发现模块
  const modules = options.modules ?? (await loadModules({ only: options.onlyModules }));

  // ---------------------------------------------------------------- 2) 数据层
  const store = await new JsonStore({
    dataDir,
    collections: modules.flatMap((mod) => mod.collections),
  }).init();

  const hub = new WebSocketHub({ path: WS_PATH });
  const broadcast = (message) => hub.broadcast(message);

  // ---------------------------------------------------------------- 3) 框架服务
  const parser = new CommandParser();
  const aiBridge = new AiBridge({ parser });
  const services = { store, aiBridge, hub, broadcast };

  // ---------------------------------------------------------------- 3') 模块服务
  const booted = [];
  for (const mod of modules) {
    const base = {
      store,
      broadcast,
      services,
      dataDir,
      options: options[mod.id] ?? {},
      module: mod,
    };
    const own = (await mod.createServices?.(base)) ?? {};
    Object.assign(services, own);
    booted.push({ mod, own, ctx: { ...base, own } });
  }

  // 指令服务需要日历服务。P5 把 CommandService 改成 handler 注册表后，这两个直接依赖即可删除。
  services.commands = new CommandService({
    parser,
    eventService: services.events,
    scheduleService: services.schedules,
    store,
    aiBridge,
  });

  // ---------------------------------------------------------------- 4) 恢复（listen 之前）
  for (const { mod, ctx } of booted) {
    if (typeof mod.restore !== 'function') continue;
    try {
      await mod.restore(ctx);
    } catch (error) {
      // 恢复失败（会话文件损坏、权限不足…）不应该让整个后端起不来
      console.error(`[modules] ${mod.id} 恢复失败，已降级启动：`, error.message);
    }
  }

  // ---------------------------------------------------------------- 5) 路由
  const router = createRouter();
  const routeCtx = {
    services,
    aiBridge,
    hub,
    modules,
    dataDir,
    version: options.version ?? '0.1.0',
    apiPrefix: API_PREFIX,
  };

  registerRoutes(router, routeCtx);
  for (const { mod, ctx } of booted) {
    mod.registerRoutes?.(router, { ...ctx, ...routeCtx });
  }

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
    modules,

    /** 模块自描述，供调试与 `GET /api/v1/modules` 使用。 */
    describeModules() {
      return describeModules(modules);
    },

    listen({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          for (const { mod, ctx } of booted) {
            try {
              mod.start?.(ctx);
            } catch (error) {
              console.error(`[modules] ${mod.id} 启动钩子失败：`, error.message);
            }
          }
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
      // 逆序停止：依赖方先于被依赖方释放
      for (const { mod, ctx } of [...booted].reverse()) {
        try {
          mod.stop?.(ctx);
        } catch (error) {
          console.error(`[modules] ${mod.id} 停止钩子失败：`, error.message);
        }
      }
      for (const socket of [...hub.clients]) hub.close(socket);
      // 测试与退出场景下必须主动断开 keep-alive 连接，否则 server.close() 会一直等待
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return api;
}

export { PACKAGE_ROOT };
