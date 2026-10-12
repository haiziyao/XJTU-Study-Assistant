/**
 * 局域网直传服务（§八）—— 设备之间直接传数据，不经过任何服务器。
 *
 * 三块拼在一起：
 *   1. **设备服务器**：独立端口（默认 8886）上的小 HTTP 服务，只有 4 条路由
 *      `GET /info`、`POST /pair`、`POST /transfer`、`GET /progress`。
 *      为什么另起一个端口而不是挂在主服务上：主服务监听 127.0.0.1（只有本机能访问），
 *      把它改成 0.0.0.0 等于把**所有接口**（含笔记正文、AI 密钥配置）暴露给整个局域网；
 *      这里只放"传数据"需要的 4 条路由，边界一眼能看清，出问题也只影响这一条通道。
 *   2. **发现通道**：`discovery.js` 的 UDP 广播（可被发现开关默认**关**）。
 *   3. **配对 + 收发**：6 位配对码 → token → 分批 POST bundle → 按 §8.1 的合并策略落库。
 *
 * 安全边界（如实写进传输页与 README，不粉饰）：
 *   - 只在局域网监听，不做任何公网暴露（没有 UPnP、没有打洞、没有中继）；
 *   - **内容不加密**（用户明确说不需要端到端加密）：同一局域网内、拿到配对码的同伴
 *     在配对后可以看到传输内容；
 *   - 成绩（`grades`）不参与传输；传输日志谁都能在本机页面上看到。
 *
 * 收下别人的数据时**只走各模块自己的服务**（`services.notes.create` 等）：
 * 直接改别人的 JSON 文件会绕过校验、广播与索引，晚一点必然对不上（契约里写死的规则）。
 * 哪些集合没有写入口，见 catalog.js 的 `importable: false` 与 reason —— 那种情况
 * 一律跳过并在结果里如实说明，绝不硬写文件。
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { HttpError } from '../../core/http/router.js';
import { COLLECTIONS, COLLECTION_NAMES, catalog, entryOf } from './catalog.js';
import { createDiscovery } from './discovery.js';
import {
  BROADCAST_INTERVAL_MS,
  CHUNK_BYTES,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  DEFAULT_PORT,
  LEDGER_LIMIT,
  LOCKOUT_MS,
  LOG_LIMIT,
  MAX_DEVICE_BODY_BYTES,
  TOKEN_TTL_MS,
  TRANSFER_SCHEMA,
  buildChunks,
  countItems,
  fingerprint,
  pickCollections,
  shortDeviceId,
} from './protocol.js';

/** 本机私有状态文件：传输日志 + 幂等账本 + 设备标识（0600）。 */
const STATE_FILE = 'transfer-log.json';
/** 状态文件里最多留多少条日志 / 未处理清单。 */
const SUSPECT_LIMIT = 200;
/** 单次结果里保留多少条逐条明细（再多就该落文件了，界面上也看不完）。 */
const RESULT_ITEM_LIMIT = 300;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 远端设备描述（只保留协议认识的字段，防止对面塞任意键进来）。 */
function normalizeDevice(input) {
  return {
    id: String(input?.id ?? '').trim().slice(0, 128),
    name: String(input?.name ?? '').trim().slice(0, 80) || '未命名设备',
    platform: String(input?.platform ?? '').trim().slice(0, 40) || null,
  };
}

/**
 * 私有 JSON 文件（0600）。
 *
 * 为什么不复用 `modules/ai/secret-store.js`：那个文件明说了它是模块私有的、不许跨模块引
 * （该收进 shared 的前置条件还没发生）。这里只做"JSON + 严格权限 + 原子替换"这一件事。
 */
class PrivateStateFile {
  constructor(filePath, { mode = 0o600 } = {}) {
    this.filePath = filePath;
    this.mode = mode;
    /** 写入串行化：同一份状态被两次写覆盖，日志就丢了一条。 */
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 损坏时不静默覆盖：备份成 .corrupt-<时间>，当作"没有历史"继续（不能拖垮启动）
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      return null;
    }
  }

  /** 等队列里已经排上的写入全部落地（`stop()` 用它保证"返回后不再有写入"）。 */
  idle() {
    return this.queue.catch(() => {});
  }

  write(data) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: this.mode });
      await fs.rename(tmp, this.filePath);
      // rename 不带权限位，显式再收一次
      await fs.chmod(this.filePath, this.mode).catch(() => {});
    });
    return this.queue;
  }
}

export class TransferService {
  /**
   * @param {object} options
   * @param {object} options.store        JsonStore（**只读**别人的集合）
   * @param {Function} options.broadcast  WebSocket 广播
   * @param {object} options.services     全局服务表（写入只走这里）
   * @param {string} options.dataDir      私有状态文件目录
   * @param {object} [options.options]    模块配置切片：`{ port, host, deviceName, accepting, discoverable, udp }`
   * @param {Function} [options.now]      可注入时钟（测试配对码过期/锁定用）
   */
  constructor({ store, broadcast = () => {}, services = {}, dataDir = process.cwd(), options = {}, now = () => Date.now(), logger = console } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.logger = logger;
    this.now = now;
    this.options = options ?? {};

    this.port = Number(this.options.port) > 0 ? Number(this.options.port) : DEFAULT_PORT;
    /** 只监听局域网可达的地址：主服务是 127.0.0.1，这里必须是 0.0.0.0，否则对面连不上。 */
    this.host = this.options.host ?? '0.0.0.0';
    this.chunkBytes = Number(this.options.chunkBytes) > 0 ? Number(this.options.chunkBytes) : CHUNK_BYTES;
    this.tokenTtlMs = Number(this.options.tokenTtlMs) > 0 ? Number(this.options.tokenTtlMs) : TOKEN_TTL_MS;
    this.codeTtlMs = Number(this.options.codeTtlMs) > 0 ? Number(this.options.codeTtlMs) : CODE_TTL_MS;
    this.lockoutMs = Number(this.options.lockoutMs) > 0 ? Number(this.options.lockoutMs) : LOCKOUT_MS;

    /** 本机身份：id 持久化（对面的幂等账本按它记），名字可改。 */
    this.device = {
      id: randomUUID(),
      name: String(this.options.deviceName ?? '').trim() || os.hostname() || '这台设备',
      platform: process.platform,
      version: this.options.version ?? null,
    };

    /** 「允许接收」默认开：不打开就没人能传进来；「可被发现」默认关（§8.2）。 */
    this.accepting = this.options.accepting !== false;
    this.discoverable = this.options.discoverable === true;

    /** 配对码与失败计数。 */
    this.code = null;
    this.codeAttempts = 0;
    this.lockedUntil = 0;
    /** token -> { device, expiresAt } */
    this.tokens = new Map();

    /** 接收状态：bundleId -> 进度；发送状态：当前那一轮。 */
    this.incoming = new Map();
    this.outgoing = null;
    this.lastResult = null;

    this.logEntries = [];
    /** 幂等账本：`<设备id>|<集合>|<远端id>` -> [{ hash, localId, alias, origin, at }] */
    this.ledger = new Map();
    /** 疑似重复 / 记忆冲突清单（等用户选"删除本机这条"还是"保留"）。 */
    this.suspects = [];

    this.file = new PrivateStateFile(path.join(dataDir, STATE_FILE));
    /**
     * 是否需要落盘。
     *
     * 为什么要有这个标记：`stop()` 是异步的，而框架的 `close()` 不等模块的 stop
     * （`mod.stop?.(ctx)` 的返回值被丢掉）。如果每次启动都无条件写一次状态文件，
     * 测试在 `close()` 之后立刻 `rm -rf dataDir` 就会撞上"文件刚被创建"→
     * `ENOTEMPTY: rmdir`（实测把 memory 的集成测试整片打挂）。
     * 只在实际发生变化时写，既消除了这个竞态，也少了一堆无意义的磁盘写。
     */
    this.dirty = false;
    this.server = null;
    this.serverError = null;
    this.listening = false;
    this.actualPort = null;
    this.readyPromise = null;
    this.stopping = null;

    /**
     * UDP 发现通道。
     *
     * `options.discovery === false` 时**不开真 socket**（测试、无网环境），但同伴记账照常：
     * 手工添加 `IP:8886` 与注入的报文仍然能进列表 —— 否则"关掉发现"会连手工添加一起废掉。
     */
    this.discovery = createDiscovery({
      port: this.port,
      udp: this.options.discovery !== false,
      intervalMs: Number(this.options.broadcastIntervalMs) > 0 ? Number(this.options.broadcastIntervalMs) : BROADCAST_INTERVAL_MS,
      info: () => this.info(),
      logger,
      ...(this.options.udp ?? {}),
    });
  }

  /* ============================================================ 生命周期 */

  /** 读回上次的设备标识、日志与幂等账本（模块 `restore` 钩子调用，listen 之前）。 */
  async load() {
    const state = await this.file.read();
    if (state?.device?.id) this.device.id = String(state.device.id);
    // 名字的优先级：显式配置 > 上次用户改过的 > 主机名。用户改过的名字不能被重启抹掉。
    if (!this.options.deviceName && state?.device?.name) this.device.name = String(state.device.name).slice(0, 80);
    if (Array.isArray(state?.logs)) this.logEntries = state.logs.slice(0, LOG_LIMIT);
    if (Array.isArray(state?.suspects)) this.suspects = state.suspects.filter((item) => item && !item.resolvedAt).slice(0, SUSPECT_LIMIT);
    if (state?.ledger && typeof state.ledger === 'object') {
      for (const [key, value] of Object.entries(state.ledger)) {
        if (Array.isArray(value) && value.length) this.ledger.set(key, value.slice(-8));
      }
    }
    return this;
  }

  /** 落盘（内部用；stop() 会等它）。没有变化时什么都不做（见构造函数的 dirty 说明）。 */
  async #flush() {
    if (!this.dirty) return undefined;
    this.dirty = false;
    const ledger = {};
    // 只保留最近 LEDGER_LIMIT 个键：Map 保持插入顺序，从最老的开始丢
    const keys = [...this.ledger.keys()].slice(-LEDGER_LIMIT);
    for (const key of keys) ledger[key] = this.ledger.get(key);
    return this.file.write({
      schemaVersion: TRANSFER_SCHEMA,
      device: { id: this.device.id, name: this.device.name },
      logs: this.logEntries.slice(0, LOG_LIMIT),
      ledger,
      suspects: this.suspects.slice(0, SUSPECT_LIMIT),
    });
  }

  /** 启动：UDP 监听 + 独立端口的 HTTP 服务器（模块 `start` 钩子；不 await 也安全）。 */
  start() {
    this.discovery?.start();
    this.discovery?.setEnabled(this.discoverable);
    this.#startDeviceServer();
    return this;
  }

  /** 端口就绪（测试与需要知道真实端口的场景用；失败也 resolve，靠 status().error 判断）。 */
  ready() {
    return this.readyPromise ?? Promise.resolve(null);
  }

  /**
   * 停止：关 UDP、关 HTTP（含在飞请求与 keep-alive 连接）、落盘。
   *
   * 两条硬契约（框架的 close() **不会 await** 模块的 stop，所以这里必须自己保证）：
   *   1. **返回之后不再写 dataDir**：先 await 落盘，再等写入队列排空；
   *   2. **返回之后不再持有任何资源**：UDP socket、广播定时器、HTTP server 全部关掉。
   * `node --test` 会等到所有 handle 释放才退出，留一个 server 或定时器就能把整个测试
   * 进程挂住（"单独跑每个文件都过、npm test 却不出结果"就是这类问题）。
   *
   * 刻意**不写成 async 方法**：那样每次调用都会把同一个 Promise 再包一层，
   * 并发/重复调用拿到的就不是同一个对象了（本文件与测试都按"复用同一个 Promise"用）。
   */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      // ① 发现通道：定时器 + UDP socket
      this.discovery?.stop();

      // ② 待写状态：只写"有过变化"的（从没传过东西的实例不该在 dataDir 里留下文件 ——
      //    否则测试 close() 之后立刻 rm -rf dataDir 会撞上 ENOTEMPTY），
      //    然后等写入队列排空：可能有一次更早发起、还没落地的写入排在队列里
      await this.#flush().catch(() => {});
      await this.file.idle().catch(() => {});

      // ③ 设备服务器：先断连接（在飞请求就此中止，不干等），再 close
      const server = this.server;
      this.server = null;
      this.listening = false;
      this.actualPort = null;
      if (server) {
        server.closeAllConnections?.();
        if (server.listening) {
          // 看门狗：万一某个连接卡在 close 上，也不能让 stop() 永远不返回
          await Promise.race([
            new Promise((resolve) => server.close(() => resolve())),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 2000);
              timer.unref?.();
            }),
          ]);
        } else {
          // 端口没绑上（EADDRINUSE 等）：close 只是为了释放对象，回调里的错误可以忽略
          server.close(() => {});
        }
      }
      return this;
    })();
    return this.stopping;
  }

  /**
   * 诊断：现在还持有哪些资源（测试用来锁 `stop()` 的契约）。
   *
   * 全是"应该为假"的东西：HTTP server、监听态、UDP socket、待写标记。
   */
  handles() {
    return {
      http: this.server !== null,
      listening: this.listening,
      udp: Boolean(this.discovery?.status?.().bound),
      broadcasting: Boolean(this.discovery?.isEnabled?.()),
      pendingWrite: this.dirty,
    };
  }

  /* ============================================================ 设备服务器（8886） */

  #startDeviceServer() {
    if (this.server || this.stopping) return;
    const server = http.createServer((req, res) => {
      this.#handleRequest(req, res).catch((error) => {
        this.logger?.warn?.(`[transfer] 处理 ${req.method} ${req.url} 失败：${error?.message ?? error}`);
        sendError(res, error);
      });
    });
    server.on('error', (error) => {
      // 端口被占用是**最常见**的失败：不影响主服务，只在传输页上写清楚怎么办
      this.serverError =
        error?.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被占用（可能开了两个本程序实例，或被别的软件占用）。可在模块配置里换一个端口。`
          : error?.message ?? String(error);
      this.logger?.warn?.(`[transfer] 设备服务器未启动：${this.serverError}`);
    });
    this.server = server;
    this.readyPromise = new Promise((resolve) => {
      server.listen(this.port, this.host, () => {
        this.listening = true;
        this.serverError = null;
        this.actualPort = server.address()?.port ?? this.port;
        resolve({ port: this.actualPort });
      });
      server.once('error', () => resolve(null));
    });
  }

  async #handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '0.0.0.0'}`);
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      // 故意**不**回 CORS 头：设备服务器不是给浏览器页面用的（本机页面走主服务的
      // /api/v1/transfer）。不给 CORS 头，网页脚本就读不到响应，少一条被网页扫描的路。
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && pathname === '/info') {
      sendJson(res, 200, { ok: true, app: 'potato-transfer', schema: TRANSFER_SCHEMA, ...this.info() });
      return;
    }
    if (method === 'POST' && pathname === '/pair') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, ...(await this.pair(body)) });
      return;
    }
    if (method === 'POST' && pathname === '/transfer') {
      const body = await readJsonBody(req);
      // 「允许接收」在 token 之前判：关了接收就一律 403，即便对面拿着刚才还有效的 token
      //（updateSettings 也会清 token，这里再判一次是为了"开关与行为永远一致"）
      if (!this.accepting) throw new HttpError(403, 'NOT_ACCEPTING', '本机当前没有开启「允许接收数据」');
      const session = this.#authorize(req, body);
      sendJson(res, 200, { ok: true, ...(await this.receive(body, session)) });
      return;
    }
    if (method === 'GET' && pathname === '/progress') {
      const session = this.#authorize(req, null, url.searchParams.get('token'));
      sendJson(res, 200, { ok: true, ...this.receiveProgress(url.searchParams.get('bundleId'), session) });
      return;
    }
    throw HttpError.notFound(`未找到接口 ${method} ${pathname}`);
  }

  /* ============================================================ 配对 */

  /** 本机信息（广播、/info、界面共用一份，避免三处各说各话）。 */
  info() {
    return {
      device: { id: this.device.id, name: this.device.name, platform: this.device.platform, version: this.device.version },
      port: this.actualPort ?? this.port,
      accepting: this.accepting,
      discoverable: this.discoverable,
    };
  }

  /** 当前配对码（没有或过期就生成一个）。只有本机页面能看到它。 */
  ensureCode(at = this.now()) {
    if (!this.code || this.code.expiresAt <= at) {
      this.code = {
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        createdAt: new Date(at).toISOString(),
        expiresAt: at + this.codeTtlMs,
      };
      this.codeAttempts = 0;
    }
    return this.code;
  }

  /** 换一个配对码（页面上那个按钮）。 */
  regenerateCode() {
    this.code = null;
    this.codeAttempts = 0;
    this.lockedUntil = 0;
    this.ensureCode();
    return this.codeInfo();
  }

  codeInfo(at = this.now()) {
    const current = this.ensureCode(at);
    return {
      code: current.code,
      createdAt: current.createdAt,
      expiresAt: new Date(current.expiresAt).toISOString(),
      remainingMs: Math.max(0, current.expiresAt - at),
      attemptsLeft: Math.max(0, CODE_MAX_ATTEMPTS - this.codeAttempts),
      locked: this.lockedUntil > at,
      lockedUntil: this.lockedUntil > at ? new Date(this.lockedUntil).toISOString() : null,
    };
  }

  /**
   * 配对（`POST /pair`）。
   *
   * 为什么要有配对码：同一局域网里任何人都可能往你设备推数据，6 位码是"用户在场"的证明。
   * 失败计数按 §8.1：最多错 5 次锁 60 秒 —— 6 位码 100 万种可能，不锁的话脚本几分钟就能撞开。
   */
  async pair(body = {}) {
    const at = this.now();
    if (!this.accepting) throw new HttpError(403, 'NOT_ACCEPTING', '对方没有开启「允许接收数据」');
    if (this.lockedUntil > at) {
      const retryAfterMs = this.lockedUntil - at;
      throw new HttpError(429, 'RATE_LIMITED', `配对码错误次数过多，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`, {
        locked: true,
        retryAfterMs,
      });
    }
    const code = String(body?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) throw HttpError.badRequest('配对码必须是 6 位数字', { field: 'code' });

    const current = this.ensureCode(at);
    if (code !== current.code) {
      this.codeAttempts += 1;
      if (this.codeAttempts >= CODE_MAX_ATTEMPTS) {
        this.lockedUntil = at + this.lockoutMs;
        this.codeAttempts = 0;
        throw new HttpError(429, 'RATE_LIMITED', `配对码连续错误 ${CODE_MAX_ATTEMPTS} 次，已锁定 ${Math.round(this.lockoutMs / 1000)} 秒`, {
          locked: true,
          retryAfterMs: this.lockoutMs,
        });
      }
      throw HttpError.unauthorized('配对码不对', { attemptsLeft: CODE_MAX_ATTEMPTS - this.codeAttempts });
    }

    this.codeAttempts = 0;
    const device = normalizeDevice(body?.device);
    if (!device.id) throw HttpError.badRequest('缺少 device.id');
    const token = randomBytes(24).toString('hex');
    const expiresAt = at + this.tokenTtlMs;
    this.tokens.set(token, { device, expiresAt, issuedAt: at });
    this.logger?.log?.(`[transfer] ${device.name} 已配对（token 30 分钟内有效）`);
    return { token, expiresAt: new Date(expiresAt).toISOString(), ttlMs: this.tokenTtlMs, device: this.info().device, accepting: this.accepting };
  }

  /** 校验 token（`POST /transfer`、`GET /progress`）。错/过期一律 401，让对面重新配对。 */
  #authorize(req, body = null, queryToken = null) {
    const header = req?.headers?.['x-potato-transfer-token'];
    const token = String(header ?? body?.token ?? queryToken ?? '').trim();
    if (!token) throw HttpError.unauthorized('需要先配对：POST /pair { code, device } 拿 token');
    const session = this.tokens.get(token);
    if (!session) throw HttpError.unauthorized('token 无效或已失效，请重新配对');
    if (session.expiresAt <= this.now()) {
      this.tokens.delete(token);
      throw HttpError.unauthorized('token 已过期，请重新配对');
    }
    return session;
  }

  /* ============================================================ 接收 */

  /** `GET /progress`：这一轮收到哪一批了（发送端可以据此显示进度）。 */
  receiveProgress(bundleId = null, session = null) {
    if (bundleId) {
      const state = this.incoming.get(String(bundleId));
      if (!state) throw HttpError.notFound(`没有这个 bundleId 的传输记录：${bundleId}`);
      return { bundle: this.#incomingSummary(state) };
    }
    return {
      active: [...this.incoming.values()].filter((state) => state.status === 'receiving').map((state) => this.#incomingSummary(state)),
      last: this.lastResult?.direction === 'in' ? this.#trimResult(this.lastResult) : null,
      device: session?.device ?? null,
    };
  }

  #incomingSummary(state) {
    return {
      bundleId: state.bundleId,
      from: state.from,
      status: state.status,
      chunks: { received: state.chunks.size, total: state.total },
      items: state.counts,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      finishedAt: state.finishedAt ?? null,
    };
  }

  #incomingState(bundleId, from, total) {
    let state = this.incoming.get(bundleId);
    if (!state) {
      state = {
        bundleId,
        from,
        total: Math.max(1, Number(total) || 1),
        chunks: new Set(),
        chunkResults: new Map(),
        counts: { added: 0, skipped: 0, renamed: 0, conflicts: 0, errors: 0 },
        items: [],
        suspects: [],
        status: 'receiving',
        startedAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        finishedAt: null,
      };
      this.incoming.set(bundleId, state);
      // 只留最近 20 轮：接收状态是给"正在进行/刚刚完成"看的，不是历史（历史在日志里）
      if (this.incoming.size > 20) this.incoming.delete([...this.incoming.keys()][0]);
    }
    return state;
  }

  /**
   * 收一批（`POST /transfer`）。
   *
   * 幂等有两层，缺一不可：
   *   1. **批次层**：同一个 bundleId 的同一个 `chunk.index` 重放，直接回上次的结果，不再落库；
   *   2. **条目层**：换了 bundleId 重发同样的数据（用户再点一次发送），靠内容指纹跳过
   *      —— 这才是"重放同一 bundle 不重复写入"真正的保证。
   */
  async receive(bundle = {}, session = null) {
    if (!this.accepting) throw new HttpError(403, 'NOT_ACCEPTING', '本机当前没有开启「允许接收数据」');
    if (Number(bundle?.schema) !== TRANSFER_SCHEMA) {
      throw HttpError.badRequest(`协议版本不一致：对方是 schema ${bundle?.schema}，本机是 ${TRANSFER_SCHEMA}`, {
        schema: bundle?.schema,
        expected: TRANSFER_SCHEMA,
      });
    }
    const bundleId = String(bundle?.bundleId ?? '').trim();
    if (!bundleId) throw HttpError.badRequest('缺少 bundleId');
    const from = normalizeDevice(bundle?.from);
    if (!from.id) throw HttpError.badRequest('缺少 bundle.from.id');

    const rawChunk = bundle?.chunk;
    const chunk = rawChunk
      ? {
          index: Number(rawChunk.index),
          total: Number(rawChunk.total),
          bundleId: String(rawChunk.bundleId ?? bundleId),
        }
      : null;
    if (chunk && (!Number.isInteger(chunk.index) || chunk.index < 0 || !Number.isInteger(chunk.total) || chunk.total < 1 || chunk.index >= chunk.total)) {
      throw HttpError.badRequest('分片信息不合法（chunk.index / chunk.total）', { chunk: rawChunk });
    }

    const state = this.#incomingState(bundleId, from, chunk?.total ?? 1);
    state.updatedAt = new Date(this.now()).toISOString();

    // ① 批次层幂等：这一片已经收过了，直接回上次的结果
    if (chunk && state.chunks.has(chunk.index)) {
      const cached = state.chunkResults.get(chunk.index);
      return { ...clone(cached), replayed: true, progress: this.#incomingSummary(state) };
    }

    const results = [];
    const suspects = [];
    const counts = { added: 0, skipped: 0, renamed: 0, conflicts: 0, errors: 0 };
    const collections = bundle?.collections && typeof bundle.collections === 'object' ? bundle.collections : {};

    for (const [name, list] of Object.entries(collections)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const result = await this.#applyItem(name, item, from, bundleId);
        // action → 计数字段：新增用 added，记忆冲突单列（它不是失败，但需要人看一眼）
        const bucket = { added: 'added', skipped: 'skipped', renamed: 'renamed', conflict: 'conflicts', failed: 'errors' }[result.action];
        counts[bucket ?? 'errors'] += 1;
        if (result.suspect) suspects.push(result.suspect);
        results.push(result);
      }
    }

    state.counts.added += counts.added;
    state.counts.skipped += counts.skipped;
    state.counts.renamed += counts.renamed;
    state.counts.conflicts += counts.conflicts;
    state.counts.errors += counts.errors;
    state.items.push(...results);
    state.suspects.push(...suspects);
    // 不分片的单发 bundle：记成"1/1 批已完成"，否则 /progress 会显示 0/1 让人以为还差一批
    if (chunk) state.chunks.add(chunk.index);
    else state.chunks.add(0);

    const chunkResult = {
      bundleId,
      from,
      chunk: chunk ? { index: chunk.index, total: chunk.total } : null,
      counts,
      items: results.slice(0, RESULT_ITEM_LIMIT),
      itemsTruncated: results.length > RESULT_ITEM_LIMIT,
      suspects,
    };
    if (chunk) state.chunkResults.set(chunk.index, chunkResult);

    const done = !chunk || state.chunks.size >= state.total;
    if (done) {
      state.status = 'done';
      state.finishedAt = new Date(this.now()).toISOString();
      await this.#finishIncoming(state);
    }

    // 本机页面据此刷新进度与结果（对面看不到这条广播，它是 WebSocket，走主服务）
    this.broadcast({
      type: 'transfer_progress',
      payload: { direction: 'in', ...this.#incomingSummary(state), counts },
    });

    return { ...chunkResult, progress: this.#incomingSummary(state) };
  }

  /** 一轮接收结束：写日志、留最后结果、落盘。 */
  async #finishIncoming(state) {
    const openSuspects = state.suspects.map((item) => item.id);
    const log = {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      direction: 'in',
      peer: { id: state.from.id, name: state.from.name, platform: state.from.platform, host: null, port: null },
      bundleId: state.bundleId,
      collections: countByCollection(state.items),
      summary: { ...state.counts },
      status: state.counts.errors ? 'partial' : 'ok',
      durationMs: Math.max(0, this.now() - Date.parse(state.startedAt)),
    };
    this.lastResult = {
      direction: 'in',
      bundleId: state.bundleId,
      peer: log.peer,
      at: log.at,
      collections: log.collections,
      summary: { ...state.counts },
      items: state.items.slice(0, RESULT_ITEM_LIMIT),
      itemsTruncated: state.items.length > RESULT_ITEM_LIMIT,
      suspects: state.suspects.slice(0, SUSPECT_LIMIT),
      openSuspects,
      durationMs: log.durationMs,
    };
    this.dirty = true;
    this.logEntries.unshift(log);
    this.logEntries = this.logEntries.slice(0, LOG_LIMIT);
    for (const suspect of state.suspects) this.suspects.unshift(suspect);
    this.suspects = this.suspects.filter((item) => !item.resolvedAt).slice(0, SUSPECT_LIMIT);
    await this.#flush().catch((error) => this.logger?.warn?.(`[transfer] 写传输日志失败：${error?.message ?? error}`));
    this.broadcast({ type: 'transfer_received', payload: { bundleId: state.bundleId, from: state.from, summary: log.summary } });
  }

  /**
   * 落一条远端记录（合并策略见 §8.1 的表，逐条在下面注释里对上）。
   *
   * @returns {Promise<object>} 逐条结果（`action` 取 added / skipped / renamed / conflict / failed）
   */
  async #applyItem(name, item, from, bundleId) {
    const base = { collection: name, remoteId: typeof item?.id === 'string' ? item.id : null };
    const entry = entryOf(name);
    if (!entry) return { ...base, label: name, action: 'failed', reason: `本机不认识集合 ${name}` };
    if (!item || typeof item !== 'object' || Array.isArray(item) || !base.remoteId) {
      return { ...base, label: entry.label, action: 'failed', reason: '这条记录没有 id，无法幂等合并，已跳过' };
    }
    // 没有写入口的集合：跳过并如实说明（绝不直接改别人的 JSON 文件）
    if (!entry.importable) return { ...base, label: entry.label, action: 'skipped', reason: entry.reason };

    const fields = entry.project ? entry.project(item) : item;
    const hash = fingerprint(fields);
    const ledgerKey = `${from.id}|${name}|${base.remoteId}`;
    const history = this.ledger.get(ledgerKey) ?? [];
    const title = typeof entry.title === 'function' ? entry.title(fields) : base.remoteId;

    // ① 同 id、内容相同 → 跳过（幂等）。指纹算的是"将要写入的字段"，不是整条记录：
    //    updatedAt / revision 这类字段每次都会变，算进去会让重放变成"新建一份"
    if (history.some((one) => one.hash === hash)) {
      return { ...base, label: entry.label, title, action: 'skipped', reason: 'identical', localId: history.find((one) => one.hash === hash)?.localId ?? null };
    }
    // ② 同 id、内容不同 → 两条都留：新来的记 `-from-<设备短id>` 的别名 + origin（见 catalog.js 顶部说明）
    const renamed = history.length > 0;
    const alias = renamed ? `${base.remoteId}-from-${shortDeviceId(from.id)}` : null;

    // ③ 不同 id、标题/正文相同 → 默认两条都留，进「疑似重复」清单让用户自己删
    const duplicate = this.#findDuplicate(entry, fields);

    let outcome;
    try {
      outcome = await entry.create({ services: this.services, store: this.store }, fields, {
        device: from,
        deviceShortId: shortDeviceId(from.id),
        alias,
        origin: from.name,
      });
    } catch (error) {
      return { ...base, label: entry.label, title, alias, origin: from.name, action: 'failed', reason: error?.message ?? String(error) };
    }

    const localId = outcome?.record?.id ?? outcome?.record?.item?.id ?? null;
    // 记账：远端 id 与本地 id 的对应关系（以及它是不是"改名收下的"）
    const next = [...history, { hash, localId, alias, origin: from.name, at: new Date(this.now()).toISOString() }].slice(-8);
    this.dirty = true;
    this.ledger.set(ledgerKey, next);
    if (this.ledger.size > LEDGER_LIMIT) this.ledger.delete([...this.ledger.keys()][0]);

    // 记忆 scope+key 冲突：两条都在、**没有**自动取代；冲突列进清单等用户选
    if (outcome?.conflict) {
      const suspect = this.#newSuspect({
        kind: 'memory-conflict',
        bundleId,
        collection: name,
        label: entry.label,
        from,
        remoteId: base.remoteId,
        alias,
        title,
        localId,
        existingId: outcome.conflict.existingId,
        existingTitle: outcome.conflict.existingText,
        detail: `同 scope+key 已有一条记忆，按"不自动取代"的约定并存：新条记在 key「${outcome.conflict.newKey}」下。`,
      });
      return { ...base, label: entry.label, title, alias, origin: from.name, action: 'conflict', localId, conflict: outcome.conflict, suspect };
    }

    // 模块自己做了幂等（记忆同文去重）：如实记成"跳过"，别把它算成"新增了一条"
    if (outcome?.duplicated) {
      return { ...base, label: entry.label, title, alias, origin: from.name, action: 'skipped', reason: 'duplicate', localId };
    }

    const verify = entry.verify ? entry.verify({ services: this.services, store: this.store }, outcome.record, item) : null;
    const verbose = verify?.truncated
      ? `${entry.label}模块按自己的上限截断了正文（原文 ${verify.truncated.wanted} 字，落库 ${verify.truncated.got} 字）`
      : null;

    const suspect = duplicate
      ? this.#newSuspect({
          kind: 'duplicate',
          bundleId,
          collection: name,
          label: entry.label,
          from,
          remoteId: base.remoteId,
          alias,
          title,
          localId,
          existingId: duplicate.id,
          existingTitle: typeof entry.title === 'function' ? entry.title(duplicate) : duplicate.id,
          detail: `本机已有一条同名记录，两条都留了，你可以在这里删掉多余的一条。`,
        })
      : null;

    return {
      ...base,
      label: entry.label,
      title,
      alias,
      origin: from.name,
      action: renamed ? 'renamed' : 'added',
      localId,
      ...(verify?.truncated ? { truncated: verify.truncated } : {}),
      ...(verbose ? { note: verbose } : {}),
      ...(suspect ? { suspect } : {}),
    };
  }

  /** 「同名」判定：拿目录里的 duplicateKey 在本机集合里找第一条（读别人的集合是允许的）。 */
  #findDuplicate(entry, fields) {
    if (typeof entry.duplicateKey !== 'function') return null;
    const wanted = entry.duplicateKey(fields);
    if (!wanted) return null;
    const collection = this.store?.[entry.collection];
    if (!collection?.all) return null;
    for (const local of collection.all()) {
      if (entry.sendFilter && !entry.sendFilter(local)) continue;
      try {
        if (entry.duplicateKey(local) === wanted) return local;
      } catch {
        /* 单条记录字段缺失就跳过，不能让一条脏数据挡住整轮传输 */
      }
    }
    return null;
  }

  #newSuspect(input) {
    return {
      id: randomUUID(),
      kind: input.kind,
      at: new Date(this.now()).toISOString(),
      bundleId: input.bundleId,
      collection: input.collection,
      label: input.label,
      origin: { id: input.from.id, name: input.from.name },
      remoteId: input.remoteId,
      alias: input.alias ?? null,
      title: input.title ?? '',
      localId: input.localId ?? null,
      existingId: input.existingId ?? null,
      existingTitle: input.existingTitle ?? '',
      detail: input.detail ?? '',
      resolvedAt: null,
      resolution: null,
    };
  }

  /**
   * 处理「疑似重复 / 冲突」清单里的一条。
   *
   * `action: 'delete'` 删掉**刚收下的那条**（用户在本机看到的两条里，新的那条更可能是多余的）；
   * `action: 'keep'` 只是把这条从清单里划掉（两条都留）。删除同样走模块自己的 remove。
   */
  async resolveSuspect({ id, action } = {}) {
    const suspect = this.suspects.find((item) => item.id === String(id ?? ''));
    if (!suspect) throw HttpError.notFound('这条记录不在待处理清单里（可能已经处理过）');
    const wanted = String(action ?? '').trim();
    if (!['delete', 'keep'].includes(wanted)) throw HttpError.badRequest('action 只能是 delete 或 keep', { field: 'action' });

    let deleted = false;
    if (wanted === 'delete') {
      const entry = entryOf(suspect.collection);
      if (!entry?.remove) throw HttpError.badRequest(`${suspect.collection} 没有可用的删除入口`);
      if (!suspect.localId) throw HttpError.badRequest('这条记录没有本地 id，无法删除');
      await entry.remove({ services: this.services, store: this.store }, suspect.localId);
      deleted = true;
      // 账本里把这次映射标掉：否则用户删掉之后，同一台设备再传一次又会写回来
      for (const [key, list] of this.ledger) {
        if (!key.endsWith(`|${suspect.collection}|${suspect.remoteId}`)) continue;
        this.ledger.set(
          key,
          list.filter((one) => one.localId !== suspect.localId),
        );
      }
    }
    this.dirty = true;
    suspect.resolvedAt = new Date(this.now()).toISOString();
    suspect.resolution = wanted;
    this.suspects = this.suspects.filter((item) => !item.resolvedAt);
    await this.#flush().catch(() => {});
    this.broadcast({ type: 'transfer_suspect_resolved', payload: { id: suspect.id, action: wanted, deleted } });
    return { id: suspect.id, action: wanted, deleted, localId: suspect.localId };
  }

  /* ============================================================ 发送 */

  /** 读出要打包的数据：**只读**别人的集合，绝不改动。 */
  #collect(names) {
    const entries = [];
    const counts = {};
    for (const name of names) {
      const entry = entryOf(name);
      if (!entry) continue;
      const collection = this.store?.[entry.collection];
      if (!collection?.all) {
        counts[name] = 0;
        continue;
      }
      const items = collection
        .all()
        .filter((item) => (typeof entry.sendFilter === 'function' ? entry.sendFilter(item) : true))
        .filter((item) => item && typeof item.id === 'string');
      counts[name] = items.length;
      for (const item of items) entries.push({ collection: name, item });
    }
    return { entries, counts };
  }

  /**
   * 发送：读本机数据 → 配对 → 分批 POST（单批 ≤ 2 MB，同一 bundleId 幂等）。
   *
   * @param {object} input
   * @param {string} input.host        对方地址（UDP 发现的，或手工填的 IP）
   * @param {number} [input.port]      对方端口（默认 8886）
   * @param {string} input.code        对方页面上显示的 6 位配对码
   * @param {string[]} input.collections 要传的集合（协议名）
   * @returns {Promise<object>} `{ sent, skipped, renamed, conflicts, errors, batches, collections, items, duplicates }`
   */
  async sendTo({ host, port = DEFAULT_PORT, code, collections = [], timeoutMs = 15_000 } = {}) {
    const peerHost = String(host ?? '').trim();
    if (!peerHost) throw HttpError.badRequest('缺少对方地址（IP 或主机名）');
    const peerPort = Number(port) > 0 ? Number(port) : DEFAULT_PORT;
    const names = pickCollections(collections, COLLECTION_NAMES);
    if (!names.length) throw HttpError.badRequest('至少勾选一个要传的集合');
    const pairCode = String(code ?? '').trim();
    if (!/^\d{6}$/.test(pairCode)) throw HttpError.badRequest('需要对方「传输」页上的 6 位配对码', { field: 'code' });

    const target = { host: peerHost, port: peerPort };
    const startedAt = this.now();
    const bundleId = randomUUID();

    // ① 先问一句"你是谁、收不收"（/info 免配对）：省得让用户先输码再被告知对方关了接收
    const info = await this.#fetchJson(target, '/info', { timeoutMs });
    if (Number(info?.schema) !== TRANSFER_SCHEMA) {
      throw HttpError.conflict(`对面的协议版本不一致（对方 schema ${info?.schema}，本机 ${TRANSFER_SCHEMA}），请把两台设备升级到同一版本`);
    }
    if (info?.accepting === false) {
      throw HttpError.conflict(`「${info?.device?.name ?? peerHost}」当前没有开启「允许接收数据」，请让对方在传输页打开`);
    }
    const peer = { id: info?.device?.id ?? null, name: info?.device?.name ?? peerHost, platform: info?.device?.platform ?? null, host: peerHost, port: peerPort };

    // ② 配对拿 token（配对码错了就在这一步失败，不会白传一半）
    const paired = await this.#fetchJson(target, '/pair', { method: 'POST', body: { code: pairCode, device: this.info().device }, timeoutMs });
    const token = String(paired?.token ?? '');
    if (!token) throw HttpError.upstream('对方没有返回 token，配对失败');

    // ③ 打包 + 分片
    const { entries, counts } = this.#collect(names);
    const base = {
      bundleId,
      schema: TRANSFER_SCHEMA,
      from: { ...this.device },
      createdAt: new Date(startedAt).toISOString(),
    };
    const chunks = entries.length ? buildChunks(base, entries, this.chunkBytes) : [];
    const aggregate = { sent: 0, skipped: 0, renamed: 0, conflicts: 0, errors: 0 };
    const items = [];
    const duplicates = [];

    this.outgoing = {
      bundleId,
      peer,
      batches: { index: 0, total: chunks.length },
      bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
      ...aggregate,
      collections: counts,
      status: chunks.length ? 'sending' : 'done',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: chunks.length ? null : new Date(startedAt).toISOString(),
      error: null,
    };

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const payload = {
          ...base,
          chunk: { index, total: chunks.length, bundleId },
          collections: chunk.collections,
          counts: countItems(chunk.collections),
          ...(chunk.oversized ? { oversized: true } : {}),
        };
        const response = await this.#fetchJson(target, '/transfer', {
          method: 'POST',
          body: payload,
          token,
          // 一批可能是 2 MB 甚至更大（单条超标独占一批），给足时间
          timeoutMs: Math.max(timeoutMs, 60_000),
        });
        const chunkCounts = response?.counts ?? {};
        aggregate.sent += Number(chunkCounts.added) || 0;
        aggregate.skipped += Number(chunkCounts.skipped) || 0;
        aggregate.renamed += Number(chunkCounts.renamed) || 0;
        aggregate.conflicts += Number(chunkCounts.conflicts) || 0;
        aggregate.errors += Number(chunkCounts.errors) || 0;
        if (Array.isArray(response?.items)) items.push(...response.items);
        if (Array.isArray(response?.suspects)) duplicates.push(...response.suspects);

        this.outgoing = {
          ...this.outgoing,
          batches: { index: index + 1, total: chunks.length },
          ...aggregate,
        };
        this.broadcast({ type: 'transfer_progress', payload: { direction: 'out', ...this.outgoing } });
      }
    } catch (error) {
      if (this.outgoing) {
        this.outgoing = { ...this.outgoing, status: 'failed', error: error?.message ?? String(error), finishedAt: new Date(this.now()).toISOString() };
      }
      await this.#appendLog({
        direction: 'out',
        peer,
        bundleId,
        collections: counts,
        summary: { ...aggregate },
        status: 'failed',
        error: error?.message ?? String(error),
        durationMs: Math.max(0, this.now() - startedAt),
      });
      throw error;
    }

    const durationMs = Math.max(0, this.now() - startedAt);
    // `added` 与 `sent` 是同一个数：发送侧习惯叫 sent，接收侧叫 added，日志与界面按 added 统一读
    const summary = { ...aggregate, added: aggregate.sent };
    const result = {
      direction: 'out',
      bundleId,
      peer,
      at: new Date(startedAt).toISOString(),
      batches: { total: chunks.length, oversized: chunks.filter((chunk) => chunk.oversized).length, bytes: this.outgoing.bytes },
      collections: counts,
      summary,
      ...aggregate,
      items: items.slice(0, RESULT_ITEM_LIMIT),
      itemsTruncated: items.length > RESULT_ITEM_LIMIT,
      duplicates,
      durationMs,
    };
    this.lastResult = result;
    if (this.outgoing) this.outgoing = { ...this.outgoing, status: 'done', finishedAt: new Date(this.now()).toISOString() };
    await this.#appendLog({ direction: 'out', peer, bundleId, collections: counts, summary, status: aggregate.errors ? 'partial' : 'ok', durationMs });
    this.broadcast({ type: 'transfer_done', payload: { direction: 'out', ...result, items: undefined } });
    return result;
  }

  async #appendLog(entry) {
    this.dirty = true;
    this.logEntries.unshift({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      bundleId: entry.bundleId,
      direction: entry.direction,
      peer: entry.peer,
      collections: entry.collections,
      summary: entry.summary,
      status: entry.status,
      error: entry.error ?? null,
      durationMs: entry.durationMs ?? null,
    });
    this.logEntries = this.logEntries.slice(0, LOG_LIMIT);
    await this.#flush().catch((error) => this.logger?.warn?.(`[transfer] 写传输日志失败：${error?.message ?? error}`));
  }

  /** 一个极小的 HTTP 客户端：只认 JSON、只连对方的设备服务器、错误信息尽量说人话。 */
  async #fetchJson(target, pathname, { method = 'GET', body, token, timeoutMs = 15_000 } = {}) {
    const url = `http://${target.host}:${target.port}${pathname}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Potato-Transfer-Token': token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `对方 ${timeoutMs / 1000} 秒没有响应` : error?.message ?? String(error);
      throw HttpError.upstream(`连不上 ${target.host}:${target.port}（${reason}）。确认两台设备在同一局域网、对方程序在运行。`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const status = response.status >= 400 ? response.status : 502;
      throw new HttpError(
        status,
        payload?.error?.code ?? 'PEER_ERROR',
        `对方（${target.host}）返回：${payload?.error?.message ?? `HTTP ${response.status}`}`,
        payload?.error?.details,
      );
    }
    return payload;
  }

  /* ============================================================ 本机页面用到的读/改 */

  peers() {
    return this.discovery?.list() ?? [];
  }

  /** 手工添加 `IP:8886`：跨网段、广播被拦时唯一入口。 */
  async addManualPeer({ host, port = DEFAULT_PORT } = {}) {
    const peerHost = String(host ?? '').trim();
    if (!peerHost) throw HttpError.badRequest('请填对方地址（例如 192.168.1.8:8886）');
    const peerPort = Number(port) > 0 ? Number(port) : DEFAULT_PORT;
    // 探一次 /info：地址写错要当场知道，而不是等到发送时才失败
    const info = await this.#fetchJson({ host: peerHost, port: peerPort }, '/info', { timeoutMs: 5_000 });
    const device = normalizeDevice(info?.device);
    if (!device.id) throw HttpError.upstream('对面返回的设备信息不完整');
    if (device.id === this.device.id) throw HttpError.badRequest('这就是本机');
    const peer = this.discovery?.remember({ ...device, port: peerPort, accepting: info?.accepting }, peerHost, 'manual');
    return peer ?? { ...device, host: peerHost, port: peerPort, accepting: Boolean(info?.accepting), via: 'manual' };
  }

  async updateSettings({ deviceName, discoverable, accepting } = {}) {
    if (deviceName !== undefined) {
      const name = String(deviceName ?? '').trim().slice(0, 80);
      if (!name) throw HttpError.badRequest('设备名不能为空');
      this.device.name = name;
    }
    if (discoverable !== undefined) {
      this.discoverable = Boolean(discoverable);
      this.discovery?.setEnabled(this.discoverable);
    }
    if (accepting !== undefined) {
      this.accepting = Boolean(accepting);
      // 关掉接收时顺手把已发出的 token 作废：否则"关了还能传"会让人以为开关坏了
      if (!this.accepting) this.tokens.clear();
    }
    this.dirty = true;
    // 立刻 await 落盘：这里绝不能 fire-and-forget（写完 stop() 就返回，目录里却还在冒文件）
    await this.#flush().catch(() => {});
    return this.status();
  }

  progress() {
    return {
      outgoing: this.outgoing ? clone(this.outgoing) : null,
      incoming: [...this.incoming.values()]
        .filter((state) => state.status === 'receiving' || this.now() - Date.parse(state.updatedAt) < 60_000)
        .map((state) => this.#incomingSummary(state)),
    };
  }

  /** 传输页要的一切（一次请求拿全，页面每 2 秒轮询它）。 */
  status({ logLimit = 20 } = {}) {
    return {
      device: { ...this.device },
      port: this.actualPort ?? this.port,
      configuredPort: this.port,
      host: this.host,
      listening: this.listening,
      error: this.serverError,
      accepting: this.accepting,
      discoverable: this.discoverable,
      code: this.codeInfo(),
      peers: this.peers(),
      discovery: this.discovery?.status() ?? { enabled: false, bound: false, error: null, peers: 0, port: this.port },
      progress: this.progress(),
      catalog: catalog(),
      log: this.logEntries.slice(0, logLimit),
      lastResult: this.#trimResult(this.lastResult),
      suspects: this.suspects.filter((item) => !item.resolvedAt).slice(0, SUSPECT_LIMIT),
    };
  }

  #trimResult(result) {
    if (!result) return null;
    return { ...clone(result), items: (result.items ?? []).slice(0, 60), itemsTruncated: Boolean(result.itemsTruncated) || (result.items?.length ?? 0) > 60 };
  }

  logs({ limit = 50 } = {}) {
    return this.logEntries.slice(0, Math.max(1, Math.min(LOG_LIMIT, Number(limit) || 50)));
  }

  /** 最近一次传输的逐条明细（发送或接收，方向由 `direction` 区分）。 */
  result() {
    return this.#trimResult(this.lastResult);
  }
}

/** 逐条结果按集合归拢（日志里"传了什么、各几条"）。 */
function countByCollection(items) {
  const out = {};
  for (const item of items) out[item.collection] = (out[item.collection] ?? 0) + 1;
  return out;
}

/* ---------------------------------------------------------------- 设备服务器的 HTTP 细节 */

/**
 * 回 JSON。
 *
 * 这里**故意不加 CORS 头**：设备服务器只服务"另一台装了本程序的设备"，
 * 加了 `Access-Control-Allow-Origin: *` 反而让任意网页都能读到局域网里有哪些设备。
 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 错误响应与主服务保持同一形状（`{ ok:false, error:{ code, message, details } }`），便于复用前端。 */
function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL';
  const payload = { ok: false, error: { code, message: error?.message ?? '设备服务器内部错误' } };
  if (error instanceof HttpError && error.details !== undefined) payload.error.details = error.details;
  sendJson(res, status, payload);
}

/** 读请求体（上限 16 MB：单批 ≤ 2 MB，但"单条超标独占一批"可能更大）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DEVICE_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体过大（上限 ${Math.round(MAX_DEVICE_BODY_BYTES / 1024 / 1024)} MB）`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw HttpError.badRequest('请求体不是合法的 JSON 对象');
  }
}

export { COLLECTIONS, catalog };
