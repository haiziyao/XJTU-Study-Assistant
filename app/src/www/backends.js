/**
 * 每账号一个后端实例的**进程内池**。
 *
 * 为什么是"每用户一个后端实例"（这是整个服务端版最关键的一个取舍）：
 *   现有模块（日历 / 笔记 / 记忆 / 卡片 / AI …）全部是**单用户**假设：JsonStore 直接按
 *   集合读写 `data/*.json`，AI key 存在 `data/ai-*.json`，谁也没带 `userId`。
 *   要在这种代码上做多租户，只有两条路：
 *     (a) 把 userId 一路透传进每个模块 —— 那是一次涉及十几个模块、上百个调用点的改造，
 *         且每加一个新模块都要重新审一遍"它有没有漏掉租户过滤"；
 *     (b) 让每个账号**拥有自己的一份 dataDir 和自己的一台后端** —— 隔离从"代码里的纪律"
 *         变成"文件系统与端口上的事实"：A 的进程根本看不到 B 的目录。
 *   选 (b)。代价是每账号常驻一份模块与内存（几十 MB 量级），换来的是**现有模块一行都不用改**、
 *   也不可能因为某个模块忘了过滤租户而串数据。
 *
 * 安全边界（必须成立，否则等于把每台用户后端裸奔在公网上）：
 *   - 一律监听 `127.0.0.1` 的**随机空闲端口**（`port: 0`，由内核分配），
 *     端口号不落盘、不进日志、不下发；
 *   - 只有宿主进程知道这些端口，公网只能通过 8866 的宿主访问；
 *   - 每台实例的模块表里**去掉** `lms`（思源学堂）与 `transfer`（局域网传输，会去起 8886）。
 *
 * 生命周期：懒启动 + 复用 + 空闲回收。
 *   - 懒启动：第一次有人真的用到这个账号时才建实例（服务器重启后不必把所有人的后端都拉起来）；
 *   - 复用：同一个账号在建实例期间/建好之后共用同一台（`inflight` 去重，避免并发建出两台，
 *     那会让同一份数据文件被两个进程同时写 —— 这是会真的丢数据的坑）；
 *   - 回收：超过 `idleMs` 没有请求、且没有在飞的请求、也没有活着的 WebSocket 时关掉实例。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createServer } from '../server/index.js';
import { loadModules } from '../core/module/registry.js';

/**
 * 服务端版**不加载**的模块。
 *
 * - `lms`：思源学堂要拿用户的学校账号密码去换票据，本机客户端上是"密码不出这台电脑"；
 *   放到公网服务器上就变成"把学校账号托管给一个陌生人运维的站点"，我们不做这件事。
 *   顺带也省掉了它定时同步在服务器上乱建日程的风险。
 * - `transfer`：设备直传会在 `start()` 里起 UDP 广播 + 8886 端口，那是**局域网**语义；
 *   公网服务器上既广播不出去，也等于多开一个没人看着的端口。
 *
 * 注意：`modules/auth`（学校统一身份认证）**保留** —— 它是教务/成绩模块的前置依赖，
 * 与"思源学堂"是两件事；而它在服务端版也不会被主动使用（没有入口去触发登录）。
 */
export const DISABLED_MODULE_IDS = ['lms', 'transfer'];

/** 默认空闲回收时间：30 分钟没有请求就关掉实例（下次访问再懒启动一次，约几百毫秒）。 */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** 回收扫描间隔。 */
const REAP_INTERVAL_MS = 60 * 1000;

export class BackendPool {
  /**
   * @param {object} options
   * @param {string} options.dataDir       账号库根目录（`data-www`）
   * @param {object} [options.logger]
   * @param {number} [options.idleMs]      空闲回收阈值；`0` 表示不回收（测试里常用）
   * @param {string[]} [options.disabled]  不加载的模块 id
   */
  constructor({ dataDir, logger = console, idleMs = DEFAULT_IDLE_MS, disabled = DISABLED_MODULE_IDS } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;
    this.idleMs = Number(idleMs) > 0 ? Number(idleMs) : 0;
    this.disabled = new Set(disabled);

    /** @type {Map<string, {host:string, port:number, app:object, userId:string, startedAt:number, lastUsedAt:number, inflight:number, sockets:number}>} */
    this.instances = new Map();
    /** 正在创建中的实例：并发的第一个请求不能各建一台（见文件头"复用"） */
    this.pending = new Map();
    /** 模块描述符在所有实例间共享（模块是**无状态描述符**，状态在各实例自己的服务对象里） */
    this.modules = null;
    this.reaper = null;
    this.closed = false;
  }

  /** 用户数据目录：`data-www/users/<userId>/`（现有 `data/` 那套文件原样搬进来）。 */
  userDir(userId) {
    return path.join(this.dataDir, 'users', String(userId));
  }

  /**
   * 取该账号的后端；没有就懒启动一台。
   * @returns {Promise<{host:string, port:number, app:object}>}
   */
  async acquire(userId) {
    if (this.closed) throw new Error('BackendPool 已关闭');
    const key = String(userId);
    const existing = this.instances.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.#start(key).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    const instance = await pending;
    instance.lastUsedAt = Date.now();
    return instance;
  }

  /** 代理请求前后配对调用：让回收器知道"这台正在被用"，不会把在飞的请求掐断。 */
  enter(instance) {
    if (instance) instance.inflight += 1;
  }

  leave(instance) {
    if (instance) {
      instance.inflight = Math.max(0, instance.inflight - 1);
      instance.lastUsedAt = Date.now();
    }
  }

  /** WebSocket 长连接也要计数：AI 流式回复期间实例不能被回收。 */
  socketOpen(instance) {
    if (instance) instance.sockets += 1;
  }

  socketClose(instance) {
    if (instance) {
      instance.sockets = Math.max(0, instance.sockets - 1);
      instance.lastUsedAt = Date.now();
    }
  }

  async #loadModuleList() {
    if (!this.modules) {
      const all = await loadModules();
      this.modules = all.filter((mod) => !this.disabled.has(mod.id));
      const skipped = all.filter((mod) => this.disabled.has(mod.id)).map((mod) => mod.id);
      if (skipped.length) this.logger?.log?.(`[www] 服务端版不加载模块：${skipped.join('、')}`);
    }
    return this.modules;
  }

  async #start(userId) {
    const dataDir = this.userDir(userId);
    // 0700：数据目录是用户私有内容（含 AI key），同机器上的其它账号不该读得到
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const modules = await this.#loadModuleList();
    const app = await createServer({ dataDir, modules });
    let info;
    try {
      // `port: 0` = 让内核挑一个空闲端口；**只绑 127.0.0.1**，公网没有到达它的路径
      info = await app.listen({ host: '127.0.0.1', port: 0 });
    } catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
    const instance = {
      userId,
      app,
      host: '127.0.0.1',
      port: info.port,
      dataDir,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      inflight: 0,
      sockets: 0,
    };
    this.instances.set(String(userId), instance);
    this.logger?.log?.(`[www] 为用户 ${String(userId).slice(0, 8)}… 启动后端实例（127.0.0.1:${info.port}，数据目录 ${dataDir}）`);
    this.#ensureReaper();
    return instance;
  }

  #ensureReaper() {
    if (this.reaper || !this.idleMs) return;
    this.reaper = setInterval(() => {
      this.reap().catch((error) => this.logger?.error?.(`[www] 回收实例失败：${error.message}`));
    }, Math.min(REAP_INTERVAL_MS, this.idleMs));
    // unref：回收器不该让进程（或 `node --test`）退不出去
    this.reaper.unref?.();
  }

  /** 回收空闲实例。导出成公开方法是为了让测试可以直接触发一次，而不必等 30 分钟。 */
  async reap() {
    if (!this.idleMs) return 0;
    const now = Date.now();
    let closed = 0;
    for (const [key, instance] of [...this.instances]) {
      if (instance.inflight > 0 || instance.sockets > 0) continue;
      if (now - instance.lastUsedAt < this.idleMs) continue;
      this.instances.delete(key);
      await instance.app.close().catch((error) => this.logger?.error?.(`[www] 关闭实例失败：${error.message}`));
      closed += 1;
      this.logger?.log?.(`[www] 用户 ${key.slice(0, 8)}… 的后端实例空闲超过 ${Math.round(this.idleMs / 60000)} 分钟，已回收`);
    }
    return closed;
  }

  /** 关停全部实例（宿主退出时调用；必须干净，否则测试进程退不出去）。 */
  async close() {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    const all = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(all.map((instance) => instance.app.close().catch(() => {})));
    return all.length;
  }

  /** 诊断快照：只给端口与计数，**不给**任何用户数据。 */
  status() {
    return [...this.instances.values()].map((instance) => ({
      userId: instance.userId,
      port: instance.port,
      startedAt: new Date(instance.startedAt).toISOString(),
      lastUsedAt: new Date(instance.lastUsedAt).toISOString(),
      inflight: instance.inflight,
      sockets: instance.sockets,
    }));
  }
}
