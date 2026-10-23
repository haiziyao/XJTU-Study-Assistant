/**
 * 同步服务：把「本机数据」与「这台账号的服务器上的同一份数据」双向对齐。
 *
 * 为什么同步接口做成**模块路由**（而不是另写一套服务端）
 * ----------------------------------------------------------
 * 服务端版（`server` 分支的 `src/www/**`）在登录后把 `/api/v1/**` 反代到**该账号自己的**
 * 后端实例，数据落在 `data-www/users/<id>/`。也就是说"服务器上的数据"就是**另一台跑着同一套
 * 模块的后端**。于是同步不需要任何服务端专属代码：本模块的 `/sync/pull`、`/sync/push`
 * 既服务本机页面，也服务远端的另一台实例 —— 桌面端 ↔ 服务器 ↔ 手机走的都是这几条路由。
 *
 * 一次「立即同步」（`POST /sync/run`）的顺序与理由
 * ----------------------------------------------
 *   ① 读本地 → ② push 给远端 → ③ pull 到**内存** → ④ 校验 → ⑤ 逐集合合并落盘 → ⑥ 记状态
 *
 *   - **push 在前**：先让远端拿到本机的新数据，pull 回来的增量里才会带上"远端为这次冲突
 *     生成的副本"，一次 run 就能把两边的结果对齐；
 *   - **pull 到内存再校验再落盘**：远端连不上、401、响应是半截 JSON、某个集合的形状不对时，
 *     **本地一个字节都不改**（"远端不可达 → 本地零改动"是硬要求：同步失败最多是没同步上，
 *     绝不能把本地数据写坏）；
 *   - **逐集合隔离失败**：某一个集合合并出错（比如某条记录的字段类型畸形）只记这一条的 error，
 *     其余集合照常合并 —— 一条脏记录不该让整轮同步白跑；
 *   - **绝不"谁后写谁赢"**：合并口径见 `merge.js`（同 id 内容不同 → 两条都留 + 交点清单）。
 *
 * 身份与状态文件（都在 `data/` 下，**0600**）
 * -----------------------------------------
 *   `sync-state.json`  `{deviceId（首次生成 uuid）, deviceName（默认 os.hostname()）,
 *                       lastPullAt, lastPushAt, cursor, syncSecrets, lastError, ...}`
 *   `sync-ledger.json` 幂等账本：`<设备>|<集合>|<id>` → 最近几版的内容指纹与本地 id。
 *                       为什么单独一个文件：状态文件要求小而稳定（接口直接回它），
 *                       账本会长到几千条；两者读写频率与体量完全不同。
 *
 * 凭据不出门
 * ----------
 * `data/account.json` 里的会话令牌只在这一层用于 `Authorization: Bearer`，**绝不**写进
 * 报告、日志、`sync-state.json`（`test/sync.test.js` 里有一条断言：run 的返回里搜不到令牌）。
 */

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../core/http/router.js';
import { buildChunks, shortDeviceId } from '../transfer/protocol.js';
import { normalizeServerUrl } from '../account/service.js';
import {
  SYNC_COLLECTIONS,
  allOf,
  enabledEntries,
  entryOf,
  planSingletonMerge,
  project,
  readFileEntry,
  readSingleton,
  removeRecord,
  secretNames,
  singletonIsEmpty,
  statsOf,
  writeRecord,
  writeSingleton,
} from './catalog.js';
import { contentHash, copyId, ledgerKey, parseCopyId, planMerge, pushHistory, pushVersion, redactSecrets, versionKey } from './merge.js';
import { PrivateJsonFile } from './private-file.js';
import { explainRuntime, secretsAllowed } from './runtime.js';
import { SyncClient } from './client.js';

/** 设备身份与同步游标（0600）。 */
export const STATE_FILE = 'sync-state.json';
/** 幂等账本（0600）。 */
export const LEDGER_FILE = 'sync-ledger.json';

/** 协议版本：字段语义变化时递增（跟着 push/pull 的 body 一起走）。 */
export const SYNC_SCHEMA = 1;

/** 账本最多保留多少个 `<设备>|<集合>|<id>` 键（超了从最老的开始丢；丢了最坏是重判一次，不丢数据）。 */
export const LEDGER_LIMIT = 5000;
/** 一次 pull 每个集合最多回多少条（防"第一次同步把几万条消息一次性塞进内存"）。 */
export const PULL_MAX_ITEMS = 2000;
/** push 单批上限：主服务的请求体上限是 12 MB，这里按 1 MB 切（与直传同一个量级）。 */
export const PUSH_CHUNK_BYTES = 1024 * 1024;
/** 单条记录上限：超过就不参与本次同步（单条无法再切片；网关超时 2026-10-21 已放宽到 240s，但超大单条仍可能顶满） */
export const MAX_SINGLE_RECORD_BYTES = 900 * 1024;
/** 报告里逐条明细最多回多少条（页面只用来列"疑似重复/冲突"，不需要几万条）。 */
export const REPORT_ITEM_LIMIT = 200;
/** 远端请求超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 新账本项（时间戳统一由注入的时钟给，测试才能固定时间）。 */
const nowIso = (now) => new Date(now()).toISOString();

export class SyncService {
  /**
   * @param {object} options
   * @param {object} options.store      JsonStore（读写业务集合）
   * @param {Function} [options.broadcast] WebSocket 广播（写完广播 `data_changed`）
   * @param {object} [options.services]  全局服务表（用 account / ai / auth / notes）
   * @param {string} [options.dataDir]   私有文件目录
   * @param {object} [options.options]   模块配置切片 `{deviceName, serverUrl, timeoutMs, autoRun}`
   * @param {Function} [options.now]     注入时钟（测试用）
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   */
  constructor({ store, broadcast = () => {}, services = {}, dataDir = process.cwd(), options = {}, now = () => Date.now(), logger = console, fetchImpl } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.dataDir = dataDir;
    this.options = options ?? {};
    this.now = now;
    this.logger = logger;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;

    this.stateFile = new PrivateJsonFile(path.join(dataDir, STATE_FILE));
    this.ledgerFile = new PrivateJsonFile(path.join(dataDir, LEDGER_FILE));
    this.accountFile = new PrivateJsonFile(path.join(dataDir, 'account.json'));

    /** @type {{deviceId:string, deviceName:string, lastPullAt:string|null, lastPushAt:string|null, cursor:string|null, syncSecrets:{aiConfig:boolean,lms:boolean}, lastError:object|null, lastReceivedAt:string|null, lastServedAt:string|null}} */
    this.state = {
      deviceId: '',
      deviceName: String(this.options.deviceName ?? '').trim() || os.hostname() || '未命名设备',
      lastPullAt: null,
      lastPushAt: null,
      cursor: null,
      syncSecrets: { aiConfig: false, lms: false },
      lastError: null,
      lastReceivedAt: null,
      lastServedAt: null,
    };
    /** @type {Map<string, Array<object>>} 幂等账本（键见 `ledgerKey`）。 */
    this.ledger = new Map();
    /**
     * @type {Map<string, string[]>} 版本索引（键见 `versionKey`）：跨设备记录"这条记录在本机
     * 历史上长什么样"。合并决策用它识别"对面推的是本机早就有过的旧版本"（merge.js 规则 ③）。
     */
    this.versions = new Map();
    /** 最近一次 run 的报告（面板刷新时还能看到上一次结果）。 */
    this.lastResult = null;
    /** 同一时刻只允许一轮 run（自动同步与「立即同步」可能撞车）。 */
    this.running = null;
  }

  /** 装配层在 listen 之前调用：读回设备身份、开关与账本。 */
  async load() {
    const saved = await this.stateFile.read();
    this.state = {
      deviceId: typeof saved?.deviceId === 'string' && saved.deviceId ? saved.deviceId : randomUUID(),
      deviceName: String(saved?.deviceName ?? '').trim() || this.state.deviceName,
      lastPullAt: saved?.lastPullAt ?? null,
      lastPushAt: saved?.lastPushAt ?? null,
      cursor: saved?.cursor ?? null,
      // 开关随设备走：文件里存什么就是什么，缺省一律 false（敏感数据默认不同步）
      syncSecrets: {
        aiConfig: saved?.syncSecrets?.aiConfig === true,
        lms: saved?.syncSecrets?.lms === true,
      },
      lastError: saved?.lastError ?? null,
      lastReceivedAt: saved?.lastReceivedAt ?? null,
      lastServedAt: saved?.lastServedAt ?? null,
    };
    const ledger = await this.ledgerFile.read();
    this.ledger = new Map(Object.entries(ledger?.entries ?? {}).filter(([, list]) => Array.isArray(list)));
    this.versions = new Map(Object.entries(ledger?.versions ?? {}).filter(([, list]) => Array.isArray(list)));
    // 设备身份一生成就落盘：/sync/status 报出来的 id 必须与文件里的一致（测试有断言）。
    // 账本也一起写一次：文件"从启动起就存在"（0600），而不是等到第一次合并才出现。
    await Promise.all([this.#saveState(), this.ledgerFile.write({ version: 1, entries: {}, versions: {}, ...ledger })]);
    return this;
  }

  async #saveState() {
    await this.stateFile.write({
      deviceId: this.state.deviceId,
      deviceName: this.state.deviceName,
      lastPullAt: this.state.lastPullAt,
      lastPushAt: this.state.lastPushAt,
      cursor: this.state.cursor,
      syncSecrets: this.state.syncSecrets,
      lastError: this.state.lastError,
      lastReceivedAt: this.state.lastReceivedAt,
      lastServedAt: this.state.lastServedAt,
    });
  }

  async #saveLedger() {
    // 超出上限时从最老的键开始丢（Map 保持插入顺序）：丢掉的只是"这一版我见过"的记忆，
    // 最坏让那条记录被重判一次（再判一次的结果仍是"两条都留"或"跳过"，不会丢数据）
    while (this.ledger.size > LEDGER_LIMIT) this.ledger.delete(this.ledger.keys().next().value);
    while (this.versions.size > LEDGER_LIMIT) this.versions.delete(this.versions.keys().next().value);
    await this.ledgerFile.write({ version: 1, entries: Object.fromEntries(this.ledger), versions: Object.fromEntries(this.versions) });
  }

  /** 记一笔"这条记录在本机历史上长这样"（合并决策识别陈旧版本要用，见 merge.js 规则 ③）。 */
  #noteVersion(collection, id, hash) {
    if (!hash) return;
    this.versions.set(versionKey(collection, id), pushVersion(this.versions.get(versionKey(collection, id)), hash));
  }

  /** 本模块的读写上下文（传给 catalog 的适配函数）。 */
  get ctx() {
    return { store: this.store, broadcast: this.broadcast, dataDir: this.dataDir, services: this.services };
  }

  /* ================================================================ 状态 / 设置 */

  /**
   * `GET /sync/status` 的数据。
   *
   * 冻结字段：`{deviceId, deviceName, lastPullAt, lastPushAt, lastError, collections}`；
   * 其余是给面板与手机端用的补充（`cursor`、`syncSecrets`、`runtime`、`account`、`deleteSync`）。
   *
   * @param {object} [input]
   * @param {string} [input.hostname] 页面的主机名（只有渲染层知道，见 runtime.js）
   * @param {boolean|null} [input.authConfigReachable] 同源 `/auth/config` 是否可达
   */
  async status({ hostname, authConfigReachable } = {}) {
    const collections = {};
    for (const entry of SYNC_COLLECTIONS) {
      const enabled = !entry.secret || this.state.syncSecrets?.[entry.secret] === true;
      if (entry.kind === 'file') {
        const single = await readSingleton(this.ctx, entry);
        collections[entry.name] = {
          // 单例的"条数"= 有没有内容（面板显示"已配置/未配置"）
          count: single.record && !singletonIsEmpty(entry, single.record) ? 1 : 0,
          maxUpdatedAt: null,
          label: entry.label,
          kind: entry.kind,
          secret: entry.secret,
          enabled,
          deleteSync: entry.deleteSync,
        };
        continue;
      }
      const stats = statsOf(this.store, entry);
      collections[entry.name] = {
        ...stats,
        label: entry.label,
        kind: entry.kind,
        secret: entry.secret,
        enabled,
        deleteSync: entry.deleteSync,
      };
    }
    let account = null;
    try {
      const raw = this.services.account?.status?.();
      account = raw ? { connected: Boolean(raw.connected), serverUrl: raw.serverUrl ?? '', user: raw.user ?? null } : null;
      // 令牌绝不出这一层：这里显式只挑三个无敏感字段
    } catch {
      account = null;
    }
    return {
      deviceId: this.state.deviceId,
      deviceName: this.state.deviceName,
      lastPullAt: this.state.lastPullAt,
      lastPushAt: this.state.lastPushAt,
      lastError: this.state.lastError,
      // ---- 以下为补充字段（冻结接口之外，纯增量）----
      cursor: this.state.cursor,
      syncSecrets: { ...this.state.syncSecrets },
      lastReceivedAt: this.state.lastReceivedAt,
      lastServedAt: this.state.lastServedAt,
      lastResult: this.lastResult,
      runtime: explainRuntime({ hostname, hasSameOriginAuthConfig: authConfigReachable }),
      account,
      serverUrl: this.#targetUrl(account?.serverUrl),
      collections,
    };
  }

  /** `GET /sync/settings`：设备身份 + 两个敏感开关（默认都 false）。 */
  settings({ hostname, authConfigReachable } = {}) {
    const runtime = explainRuntime({ hostname, hasSameOriginAuthConfig: authConfigReachable });
    return {
      deviceId: this.state.deviceId,
      deviceName: this.state.deviceName,
      syncSecrets: { ...this.state.syncSecrets },
      // 补充：面板据此决定显不显示这两个复选框
      runtime,
      canSyncSecrets: secretsAllowed(runtime.kind),
    };
  }

  /**
   * `POST /sync/settings`：改敏感数据开关。
   *
   * 三条规矩：
   *   1. 只认布尔（`true`/`false`；字符串 'true'/'false' 也认，表单来的值更宽松）；
   *   2. **网页版不许打开**：运行环境判定为 `web` 时，把开关置 `true` 直接 403
   *      （面板本来就不显示这两个复选框，这里是后端兜底 —— 否则"网页版不提供这个开关"
   *      就只是一句 UI 上的客气话）；
   *   3. 只写本机文件（`data/sync-state.json`），**不通知任何远端** —— 开关是"这台设备同不同意"
   *      的本地决定，不该由服务器替用户决定。
   */
  async updateSettings({ syncSecrets, hostname, authConfigReachable } = {}) {
    const runtime = explainRuntime({ hostname, hasSameOriginAuthConfig: authConfigReachable });
    const next = { ...this.state.syncSecrets };
    const names = secretNames();
    for (const [key, value] of Object.entries(syncSecrets ?? {})) {
      if (!(key in names)) throw HttpError.badRequest(`不认识的开关 ${key}（可选：${Object.keys(names).join(' / ')}）`, { field: `syncSecrets.${key}` });
      const parsed = parseBool(value);
      if (parsed === null) throw HttpError.badRequest(`${key} 只能是 true 或 false`, { field: `syncSecrets.${key}` });
      if (parsed === true && !secretsAllowed(runtime.kind)) {
        throw new HttpError(
          403,
          'SECRETS_NOT_ALLOWED_HERE',
          '网页版不提供敏感数据同步：要同步学堂账号与 API key，请在桌面端或手机 App 的「设置 → 多端同步」里开启。',
          { runtime: runtime.kind },
        );
      }
      next[key] = parsed;
    }
    this.state.syncSecrets = next;
    await this.#saveState();
    this.broadcast?.({ type: 'data_changed', module: 'sync', payload: { target: 'sync_settings' } });
    return this.settings({ hostname, authConfigReachable });
  }

  /* ================================================================ 服务端侧：接收 push */

  /**
   * 处理一台设备推上来的数据（`POST /sync/push`）。
   *
   * 逐集合 try/catch：某一个集合炸了只记这个集合的 error，别的照常落库
   * （"一条脏记录不该让整轮同步白跑"）。
   *
   * @param {object} body `{deviceId, deviceName, collections, deleted}`
   */
  async applyPush(body = {}) {
    const deviceId = String(body?.deviceId ?? '').trim();
    if (!deviceId) throw HttpError.badRequest('缺少 deviceId（每台设备在 data/sync-state.json 里都有一个）', { field: 'deviceId' });
    const deviceName = String(body?.deviceName ?? '').trim().slice(0, 80) || '未命名设备';
    const incoming = body?.collections && typeof body.collections === 'object' && !Array.isArray(body.collections) ? body.collections : {};
    const deleted = body?.deleted && typeof body.deleted === 'object' && !Array.isArray(body.deleted) ? body.deleted : {};

    /** @type {Record<string, object>} */
    const groups = {};
    const duplicates = [];
    const conflicts = [];
    const totals = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
    const peerKey = `device:${deviceId}`;

    for (const [name, list] of Object.entries(incoming)) {
      const entry = entryOf(name);
      if (!entry) {
        groups[name] = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: Array.isArray(list) ? list.length : 0, error: `本机不认识集合 ${name}，已整批忽略` };
        totals.errors += Array.isArray(list) ? list.length : 0;
        continue;
      }
      const group = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
      try {
        if (!Array.isArray(list)) throw new Error('集合内容不是数组');
        const before = this.ledger.size;
        await this.#mergeIncoming({ peerKey, peerId: deviceId, peerName: deviceName, entry, items: list, group, duplicates, conflicts });
        if (this.ledger.size !== before) group.touchedLedger = true;
      } catch (error) {
        group.errors += 1;
        group.error = redactSecrets(error?.message ?? String(error));
      }
      groups[name] = group;
      for (const key of ['accepted', 'skipped', 'updated', 'renamed', 'deleted', 'errors']) totals[key] += group[key] ?? 0;
    }

    const unsupportedDeletes = await this.#applyDeletes({ deleted, peerKey, peerName: deviceName, groups, totals });

    this.state.lastReceivedAt = nowIso(this.now);
    this.state.lastError = null;
    await Promise.all([this.#saveState(), this.#saveLedger()]);

    return {
      accepted: totals.accepted,
      skipped: totals.skipped,
      renamed: totals.renamed,
      // ---- 冻结字段之外的补充 ----
      updated: totals.updated,
      deleted: totals.deleted,
      errors: totals.errors,
      groups,
      duplicates: duplicates.slice(0, REPORT_ITEM_LIMIT),
      duplicatesTruncated: duplicates.length > REPORT_ITEM_LIMIT,
      conflicts: conflicts.slice(0, REPORT_ITEM_LIMIT),
      conflictsTruncated: conflicts.length > REPORT_ITEM_LIMIT,
      unsupportedDeletes,
      serverTime: nowIso(this.now),
      serverDeviceId: this.state.deviceId,
      /** 本机对这几个集合**不支持删除同步**（面板/README 都照它说） */
      deleteSync: Object.fromEntries(SYNC_COLLECTIONS.map((entry) => [entry.name, entry.deleteSync])),
      schema: SYNC_SCHEMA,
    };
  }

  /** 应用 `deleted: {<集合>: [id]}`：只对"软删除"集合执行（见 catalog.js 的口径）。 */
  async #applyDeletes({ deleted, peerKey, peerName, groups, totals }) {
    const unsupported = [];
    for (const [name, ids] of Object.entries(deleted ?? {})) {
      const entry = entryOf(name);
      const list = Array.isArray(ids) ? ids : [];
      if (!entry) {
        unsupported.push({ collection: name, label: name, count: list.length, reason: `本机不认识集合 ${name}` });
        continue;
      }
      if (entry.deleteSync !== 'soft') {
        unsupported.push({
          collection: name,
          label: entry.label,
          count: list.length,
          reason: `${entry.label}不支持删除同步：它的删除是硬删除（记录直接消失），本机无法区分"被删了"与"从未同步过"，同步不给它发明墓碑字段。`,
        });
        continue;
      }
      const group = (groups[name] ??= { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 });
      for (const raw of list) {
        const id = String(raw ?? '').trim();
        if (!id) continue;
        try {
          const result = await removeRecord(this.ctx, entry, id);
          if (result.removed) {
            group.deleted += 1;
            totals.deleted += 1;
            this.ledger.set(ledgerKey(peerKey, name, id), pushHistory(this.ledger.get(ledgerKey(peerKey, name, id)) ?? [], {
              hash: '__deleted__',
              localId: id,
              origin: peerName,
              at: nowIso(this.now),
            }));
          } else {
            group.errors += 1;
            group.error = '本机没有可用的删除入口';
          }
        } catch (error) {
          // 已经删过（或不存在）不该算失败：删除本来就是幂等的
          const message = redactSecrets(error?.message ?? String(error));
          group.skipped += 1;
          group.note = message;
        }
      }
    }
    return unsupported;
  }

  /* ================================================================ 服务端侧：响应 pull */

  /**
   * 增量拉取（`POST /sync/pull`）：`since` 之后的记录 + 单例集合。
   *
   * 时间口径两条（都容易写错，写清楚）：
   *   1. **`serverTime` 取"这次查询开始的那一刻"**，不是结束时刻 —— 否则查询期间写进来的记录
   *      会因为"更新时间早于 serverTime"被永久跳过；
   *   2. 过滤是 `updatedAt >= since`（**含等号**）：边界上明明有两条同一个毫秒的记录时，
   *      少了等号就会漏掉一条；重复送一遍是幂等的（接收侧按内容指纹跳过），漏一条则永远补不回来。
   */
  async collectChanges({ since, deviceId, deviceName } = {}) {
    const startedAt = nowIso(this.now);
    const sinceValue = typeof since === 'string' && since.trim() ? since.trim() : null;
    const collections = {};
    const truncated = {};
    const errors = {};

    for (const entry of SYNC_COLLECTIONS) {
      try {
        if (entry.kind === 'file') {
          // 单例没有 updatedAt：只要"有内容"就每次都带上（重复应用是幂等的，
          // 而"换台新设备拿到配置"恰恰依赖它每次都来）
          const items = (await readFileEntry(this.ctx, entry)).filter((item) => !singletonIsEmpty(entry, item));
          if (items.length) collections[entry.name] = items;
          continue;
        }
        let items = allOf(this.store, entry);
        if (sinceValue) items = items.filter((item) => String(item?.updatedAt ?? item?.createdAt ?? '') >= sinceValue);
        items.sort((a, b) => String(a?.updatedAt ?? '').localeCompare(String(b?.updatedAt ?? '')));
        if (items.length > PULL_MAX_ITEMS) {
          truncated[entry.name] = items.length;
          items = items.slice(0, PULL_MAX_ITEMS);
        }
        if (items.length) collections[entry.name] = items;
      } catch (error) {
        // 单个集合读失败不影响其它集合：**不要**往 collections 里塞假记录
        // （那会被客户端当成一批脏记录），单独用一个 errors 字段如实回报
        errors[entry.name] = redactSecrets(error?.message ?? String(error));
      }
    }

    // 游标只推进到"所有被截断的集合都送到过的那个时间点"，否则剩下的记录会被永久跳过
    let nextSince = startedAt;
    for (const [name, count] of Object.entries(truncated)) {
      if (count <= 0) continue;
      const list = collections[name] ?? [];
      const last = list[list.length - 1];
      const at = String(last?.updatedAt ?? last?.createdAt ?? '');
      if (at && at < nextSince) nextSince = at;
    }

    this.state.lastServedAt = startedAt;
    await this.#saveState();

    return {
      serverTime: startedAt,
      // ---- 冻结字段之外的补充 ----
      nextSince,
      serverDeviceId: this.state.deviceId,
      serverDeviceName: this.state.deviceName,
      // 本机（作为一个"设备"）自己的开关，客户端可据此提示"服务器侧没开敏感同步"
      syncSecrets: { ...this.state.syncSecrets },
      collections,
      /**
       * 墓碑清单：**当前恒为空对象**。
       *
       * 为什么：同步范围里只有 `notes` 有软删除，而软删除是记录上的字段（`deletedAt`），
       * 它跟着记录本身一起走 —— 不需要墓碑。其余集合的删除是硬删除，口径明确"不为它们
       * 发明墓碑"（见 catalog.js）。字段保留是因为接口冻结，且**客户端会照它执行删除**
       * （未来手机端如果自己维护了墓碑，推上来之后经 `deleted` 转发的语义就完整了）。
       */
      deleted: {},
      truncated,
      errors,
      schema: SYNC_SCHEMA,
      requestedBy: deviceId ? { deviceId, deviceName: String(deviceName ?? '') } : null,
    };
  }

  /* ================================================================ 合并核心（两个方向共用） */

  /**
   * 把一批远端记录合并进本机（服务端收到 push、桌面端 pull 回来后合并，走的是**同一段代码**）。
   *
   * @param {object} input
   * @param {string} input.peerKey  账本键前缀（服务端侧 = `device:<id>`；桌面端侧 = `server:<url>`）
   * @param {string} input.peerId   对端设备 id（用于冲突副本的 alias）
   * @param {string} input.peerName 对端设备名（origin，记在账本里供追溯）
   * @param {object} input.entry    目录项
   * @param {object[]} input.items  远端记录
   * @param {object} input.group    计数桶（会被就地累加）
   * @param {object[]} input.duplicates 疑似重复清单（会被就地追加）
   * @param {object[]} input.conflicts  冲突清单（会被就地追加）
   */
  async #mergeIncoming({ peerKey, peerId, peerName, entry, items, group, duplicates, conflicts }) {
    if (entry.kind === 'file') {
      await this.#mergeSingleton({ peerKey, peerId, peerName, entry, items, group, conflicts });
      return;
    }
    const collection = this.store?.[entry.store];
    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) {
        group.errors += 1;
        continue;
      }
      const projected = project(item);
      const incomingHash = contentHash(projected);
      const key = ledgerKey(peerKey, entry.name, id);
      const history = this.ledger.get(key) ?? [];
      const local = collection?.get?.(id) ?? null;
      const localHash = local ? contentHash(project(local)) : null;
      // 这是一条"冲突副本"（id 形如 `<父id>-h<指纹>`）吗？本机是不是已经有同内容的那条了？
      const variant = parseCopyId(id);
      let variantContentPresent = false;
      if (!local && variant) {
        const parent = collection?.get?.(variant.parentId) ?? null;
        if (parent && contentHash(project(parent)) === incomingHash) variantContentPresent = true;
      }

      const decision = planMerge({
        id,
        incomingHash,
        localHash,
        localExists: Boolean(local),
        history,
        // 本机历史上这条记录出现过的所有版本（跨设备）：用来识别"陈旧推送"（merge.js 规则 ③）
        knownBefore: this.versions.get(versionKey(entry.name, id)) ?? [],
        variantContentPresent,
      });
      let localId = id;
      let action = decision.action;

      if (action === 'added') {
        await writeRecord(this.ctx, entry, id, projected);
        group.accepted += 1;
        this.#noteDuplicate(entry, id, projected, duplicates, peerId, peerName);
      } else if (action === 'updated') {
        await writeRecord(this.ctx, entry, id, projected);
        group.updated += 1;
      } else if (action === 'conflict') {
        // 两条都留：本机这条原样不动，来的一条另存成"内容指纹不同的那个 id"
        const variantId = copyId(id, incomingHash);
        const already = collection?.get?.(variantId) ?? null;
        if (already) {
          group.skipped += 1;
          localId = variantId;
        } else {
          await writeRecord(this.ctx, entry, variantId, projected);
          group.renamed += 1;
          localId = variantId;
          action = 'renamed';
          this.#noteDuplicate(entry, variantId, projected, duplicates, peerId, peerName);
        }
        conflicts.push({
          collection: entry.name,
          label: entry.label,
          id,
          title: safeTitle(entry, projected),
          variantId,
          // 与直传同一套 alias 口径：`<远端 id>-from-<设备短 id>`（人看的溯源信息，
          // 记录本身不带这个字段 —— 带上会破坏"两侧同一条记录内容一致"的收敛性）
          alias: `${id}-from-${shortDeviceId(peerId)}`,
          origin: { id: peerId, name: peerName },
          reason: 'same-id-different-content',
          detail: '同一条记录在两台设备上被改成了不同的内容：两条都留（本机这条保留原 id，来的一条存成上面那个副本 id），请自己决定留哪条。',
          at: nowIso(this.now),
        });
      } else {
        group.skipped += 1;
        if (decision.reason === 'variant-present') localId = variant?.parentId ?? id;
      }

      // 版本索引：把"这一版"和"现在本机这一版"都记下来（陈旧判定的依据）
      this.#noteVersion(entry.name, id, incomingHash);
      if (localId === id) this.#noteVersion(entry.name, id, localHash ?? incomingHash);
      if (action === 'renamed') {
        this.#noteVersion(entry.name, localId, incomingHash);
        this.#noteVersion(entry.name, localId, contentHash(project(collection?.get?.(localId) ?? {})));
      }

      this.ledger.set(key, pushHistory(history, {
        hash: incomingHash,
        localId,
        alias: action === 'renamed' ? `${id}-from-${shortDeviceId(peerId)}` : null,
        origin: peerName,
        conflict: action === 'renamed',
        at: nowIso(this.now),
      }));
    }
  }

  /** 单例集合（ai-config / 学堂凭据）的合并：填空白、绝不覆盖本机非空值。 */
  async #mergeSingleton({ peerKey, peerId, peerName, entry, items, group, conflicts }) {
    const incoming = items.find((item) => item && typeof item === 'object');
    if (!incoming) {
      group.skipped += 1;
      return;
    }
    const local = await readSingleton(this.ctx, entry);
    if (singletonIsEmpty(entry, incoming)) {
      group.skipped += 1;
      return;
    }
    const hash = contentHash(project(incoming));
    const key = ledgerKey(peerKey, entry.name, entry.name);
    const history = this.ledger.get(key) ?? [];
    const plan = planSingletonMerge({
      local: local.record,
      incoming,
      fileExists: local.fileExists,
      secretFields: entry.secretFields ?? [],
    });
    if (plan.conflicts.length) {
      conflicts.push({
        collection: entry.name,
        label: entry.label,
        id: entry.name,
        title: safeTitle(entry, incoming),
        fields: plan.conflicts,
        origin: { id: peerId, name: peerName },
        reason: 'singleton-field-conflict',
        // 只说"哪个字段不一样"，**绝不说值**（密钥/票据一旦进了消息就会出现在页面、截图、工单里）
        detail: `这些字段两台设备上都有值但不一样：${plan.conflicts.join(' / ')}。已保留本机值（绝不静默覆盖），需要改请手动在本机设置里改。`,
        at: nowIso(this.now),
      });
    }
    if (Object.keys(plan.patch).length) {
      await writeSingleton(this.ctx, entry, plan.patch, { local: local.record, fileExists: local.fileExists });
      group.updated += 1;
      this.ledger.set(key, pushHistory(history, { hash, localId: entry.name, origin: peerName, at: nowIso(this.now) }));
      return;
    }
    if (history.some((one) => one?.hash === hash)) group.skipped += 1;
    else {
      group.skipped += 1;
      this.ledger.set(key, pushHistory(history, { hash, localId: entry.name, origin: peerName, at: nowIso(this.now) }));
    }
  }

  /** 「不同 id 同名」→ 疑似重复清单（口径与直传一致：两条都留，交给用户）。 */
  #noteDuplicate(entry, id, projected, sink, peerId, peerName) {
    if (typeof entry.duplicateKey !== 'function') return;
    if (projected?.deletedAt) return; // 软删的不参与"同名"判定（与直传的 sendFilter 同一口径）
    let wanted;
    try {
      wanted = entry.duplicateKey(projected);
    } catch {
      return;
    }
    if (!wanted) return;
    for (const local of allOf(this.store, entry)) {
      if (local?.id === id) continue;
      if (entry.live && !entry.live(local)) continue;
      try {
        if (entry.duplicateKey(local) === wanted) {
          sink.push({
            collection: entry.name,
            label: entry.label,
            id,
            title: safeTitle(entry, projected),
            existingId: local.id,
            existingTitle: safeTitle(entry, local),
            origin: { id: peerId, name: peerName },
            reason: 'same-name-different-id',
            detail: '本机已有一条同名记录，两条都留了，你可以自己删掉多余的一条。',
            at: nowIso(this.now),
          });
          return;
        }
      } catch {
        /* 单条记录字段缺失就跳过，不能让一条脏数据挡住整轮同步 */
      }
    }
  }

  /* ================================================================ 桌面端侧：一次 run */

  /**
   * 一站式同步（`POST /sync/run`，桌面端面板就调它）：
   * 读本地 → push → pull → 就地合并 → 返回**人话报告**。
   *
   * 失败路径（未登录 / 地址为空 / 连不上 / 401 / 响应畸形）在**写任何本地数据之前**就返回，
   * 只把 `lastError` 记进状态文件 —— 本地业务数据一个字节都不动。
   *
   * @param {object} [input]
   * @param {string} [input.serverUrl] 覆盖服务器地址（缺省用账号登录时记下的那个）
   * @param {string} [input.hostname] 页面主机名（环境判定，见 runtime.js）
   * @param {boolean|null} [input.authConfigReachable] 同源 /auth/config 是否可达
   */
  async run({ serverUrl, hostname, authConfigReachable } = {}) {
    const startedAt = this.now();
    const runtime = explainRuntime({ hostname, hasSameOriginAuthConfig: authConfigReachable });
    const at = new Date(startedAt).toISOString();
    const base = emptyReport({ at, runtime, durationMs: 0 });

    if (this.running) {
      // 并发保护：自动同步与用户点「立即同步」撞在一起时，后到的一轮直接复用前一轮的结果
      return this.running;
    }
    this.running = this.#run({ serverUrl, runtime, startedAt, at, base }).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #run({ serverUrl, runtime, startedAt, at, base }) {
    // ---------------------------------------------------------- ① 服务器地址 + ② 账号令牌
    // 地址来源的优先级（与 account 模块的口径一致）：显式传参 > 登录时记下的 > 账号模块的默认值 > 模块配置。
    // 顺序很重要：判断"地址为空"必须在"有没有登录"之前 —— 服务端版每用户实例的账号默认地址
    // 就是空串（同源），那种情况下 `/sync/run` 应当是 `no_server`（本机自己同步自己没有意义），
    // 而不是让用户去登录一个并不存在的账号。
    const session = await this.#session();
    const accountStatus = (() => {
      try {
        return this.services.account?.status?.() ?? null;
      } catch {
        return null;
      }
    })();
    const explicit = serverUrl === undefined || serverUrl === null ? '' : String(serverUrl).trim();
    const candidate = explicit || String(session?.serverUrl ?? '').trim() || String(accountStatus?.serverUrl ?? '').trim() || String(this.options.serverUrl ?? '').trim();
    if (!candidate) {
      // serverUrl 为空 = "本机自己同步自己"，没有任何意义：直接如实回报，一个请求都不发
      return { ...base, skipped: true, reason: 'no_server', durationMs: Math.max(0, this.now() - startedAt) };
    }
    let target = '';
    try {
      target = normalizeServerUrl(candidate);
    } catch (error) {
      return this.#fail({ ...base, skipped: true, reason: 'bad_server' }, { code: 'BAD_SERVER_URL', message: redactSecrets(error?.message ?? String(error)) }, startedAt);
    }
    if (!target) return { ...base, skipped: true, reason: 'no_server', durationMs: Math.max(0, this.now() - startedAt) };
    base.serverUrl = target;
    if (!session?.token) {
      return this.#fail(
        { ...base, skipped: true, reason: 'no_account' },
        { code: 'NOT_LOGGED_IN', message: '还没有登录：请先在「设置 → 账号登录」里登录这台服务器。' },
        startedAt,
      );
    }

    const client = new SyncClient({ serverUrl: target, token: session.token, fetchImpl: this.fetchImpl, timeoutMs: this.options.timeoutMs, logger: this.logger });

    // ---------------------------------------------------------- ③ 读本地 + push
    // 本机开关裁掉的敏感集合**既不推也不合并**（`pull` 侧还要额外报 skippedSecrets，见下）
    const enabled = new Set(enabledEntries(this.state.syncSecrets).map((entry) => entry.name));
    const payload = await this.#collectLocal(enabled);
    const pushTotals = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
    const duplicates = [];
    const conflicts = [];
    const pushGroups = {};
    let serverDeviceId = null;

    const chunks = buildChunks({ deviceId: this.state.deviceId, deviceName: this.state.deviceName, schema: SYNC_SCHEMA }, payload.entries, PUSH_CHUNK_BYTES);
    for (const [index, chunk] of chunks.entries()) {
      const response = await client.push({
        deviceId: this.state.deviceId,
        deviceName: this.state.deviceName,
        collections: chunk.collections,
        // 墓碑清单只在第一批带一次；本机当前不产生墓碑（见 collectChanges 的说明）
        deleted: index === 0 ? payload.deleted : {},
      });
      if (!response.ok) {
        return this.#fail({ ...base, pushed: pushTotals.accepted, skipped: pushTotals.skipped }, response.error, startedAt);
      }
      const body = response.body ?? {};
      for (const key of ['accepted', 'skipped', 'updated', 'renamed', 'deleted', 'errors']) pushTotals[key] += Number(body[key]) || 0;
      if (Array.isArray(body.duplicates)) duplicates.push(...body.duplicates);
      if (Array.isArray(body.conflicts)) conflicts.push(...body.conflicts);
      for (const [name, group] of Object.entries(body.groups ?? {})) {
        pushGroups[name] = mergeGroup(pushGroups[name], group);
      }
      serverDeviceId = body.serverDeviceId ?? serverDeviceId;
    }
    this.state.lastPushAt = nowIso(this.now);

    // ---------------------------------------------------------- ④ pull 到内存
    const pullResponse = await client.pull({ deviceId: this.state.deviceId, since: this.state.cursor });
    if (!pullResponse.ok) {
      return this.#fail({ ...base, pushed: pushTotals.accepted, skipped: pushTotals.skipped }, pullResponse.error, startedAt);
    }
    const pulled = pullResponse.body ?? {};
    const shapeError = checkPullShape(pulled);
    if (shapeError) {
      return this.#fail(
        { ...base, pushed: pushTotals.accepted, skipped: pushTotals.skipped },
        { code: 'BAD_RESPONSE', message: `服务器返回的同步数据看不懂（${shapeError}），本轮不改动本机数据` },
        startedAt,
      );
    }
    serverDeviceId = pulled.serverDeviceId ?? serverDeviceId;

    // ---------------------------------------------------------- ⑤ 逐集合合并落盘
    const peerKey = `server:${target}`;
    const peerId = pulled.serverDeviceId ?? target;
    const peerName = pulled.serverDeviceName ?? target;
    const pullGroups = {};
    const skippedSecrets = [];
    const unsupportedDeletes = [];
    const localDuplicates = [];
    const localConflicts = [];
    for (const [name, items] of Object.entries(pulled.collections ?? {})) {
      const entry = entryOf(name);
      if (!entry) {
        pullGroups[name] = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 1, error: `本机不认识集合 ${name}，已忽略` };
        continue;
      }
      const group = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
      if (entry.secret && !enabled.has(entry.name)) {
        // **本机没勾这个开关 → 服务器上的敏感数据一律不落本机**（面板会说清楚跳过了什么）
        skippedSecrets.push(entry.name);
        group.skipped = items.length;
        group.note = '本机没有开启这项同步，服务器上的数据没有被写入本机';
        pullGroups[name] = group;
        continue;
      }
      try {
        // 单个集合失败不影响其它集合：逐集合 try/catch，失败只记这个集合的 error
        await this.#mergeIncoming({ peerKey, peerId, peerName, entry, items, group, duplicates: localDuplicates, conflicts: localConflicts });
      } catch (error) {
        group.errors += 1;
        group.error = redactSecrets(error?.message ?? String(error));
      }
      pullGroups[name] = group;
    }

    // 服务端读某个集合失败时会在 `errors` 里逐集合说明（不是把假记录塞进 collections）：
    // 如实并进逐集合报告，用户能看到"哪一块没同步上"
    for (const [name, message] of Object.entries(pulled.errors ?? {})) {
      const entry = entryOf(name);
      pullGroups[name] = {
        ...(pullGroups[name] ?? { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 }),
        errors: (pullGroups[name]?.errors ?? 0) + 1,
        error: `服务器读这个集合失败：${redactSecrets(message)}`,
        ...(entry ? { label: entry.label } : {}),
      };
    }

    // 服务端送来的墓碑（当前恒为空；接口冻结，客户端照执行）
    for (const [name, ids] of Object.entries(pulled.deleted ?? {})) {
      const entry = entryOf(name);
      const list = Array.isArray(ids) ? ids : [];
      if (!entry) continue;
      if (entry.deleteSync !== 'soft') {
        unsupportedDeletes.push({ collection: name, label: entry.label, count: list.length, reason: `${entry.label}不支持删除同步` });
        continue;
      }
      const group = (pullGroups[name] ??= { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 });
      for (const raw of list) {
        const id = String(raw ?? '').trim();
        if (!id) continue;
        try {
          const result = await removeRecord(this.ctx, entry, id);
          if (result.removed) group.deleted += 1;
          else group.skipped += 1;
        } catch (error) {
          group.errors += 1;
          group.error = redactSecrets(error?.message ?? String(error));
        }
      }
    }

    // ---------------------------------------------------------- ⑥ 状态 + 报告
    // 游标只在 pull 成功并合并完之后推进：中途失败留着旧游标，下一轮重新拉（幂等，不会重复写）
    const previousCursor = this.state.cursor;
    this.state.cursor = pulled.nextSince ?? pulled.serverTime ?? this.state.cursor;
    this.state.lastPullAt = nowIso(this.now);
    this.state.lastError = null;
    await Promise.all([this.#saveState(), this.#saveLedger()]);

    const pullTotals = sumGroups(pullGroups);
    const allDuplicates = [...duplicates, ...localDuplicates];
    const allConflicts = [...conflicts, ...localConflicts];
    const report = {
      ...base,
      serverUrl: target,
      serverDeviceId,
      since: previousCursor,
      nextSince: this.state.cursor,
      serverTime: pulled.serverTime ?? null,
      pushed: pushTotals.accepted,
      pulled: pullTotals.accepted,
      updated: pushTotals.updated + pullTotals.updated,
      skipped: pushTotals.skipped + pullTotals.skipped,
      renamed: pushTotals.renamed + pullTotals.renamed,
      deleted: pushTotals.deleted + pullTotals.deleted,
      duplicates: allDuplicates.slice(0, REPORT_ITEM_LIMIT),
      duplicatesTruncated: allDuplicates.length > REPORT_ITEM_LIMIT,
      conflicts: allConflicts.slice(0, REPORT_ITEM_LIMIT),
      conflictsTruncated: allConflicts.length > REPORT_ITEM_LIMIT,
      skippedSecrets,
      unsupportedDeletes,
      /** 如实标注：哪些记录因为单条超过上限没参与本轮同步（原因见 #collectLocal） */
      oversized: payload.oversized,
      /** 如实标注：哪些集合不支持删除同步（面板与 README 都照它说） */
      deleteSync: Object.fromEntries(SYNC_COLLECTIONS.map((entry) => [entry.name, entry.deleteSync])),
      groups: mergeGroups(pushGroups, pullGroups),
      errors: pushTotals.errors + pullTotals.errors,
      durationMs: Math.max(0, this.now() - startedAt),
      ok: true,
    };
    this.lastResult = {
      at: report.at,
      ok: true,
      pushed: report.pushed,
      pulled: report.pulled,
      skipped: report.skipped,
      renamed: report.renamed,
      updated: report.updated,
      duplicates: report.duplicates.length,
      conflicts: report.conflicts.length,
      durationMs: report.durationMs,
    };
    await this.#saveState();
    this.broadcast?.({ type: 'data_changed', module: 'sync', payload: { target: 'sync_run', ...this.lastResult } });
    return report;
  }

  /** 读出要推给远端的本地数据（只读！失败/不可达时本地零改动的前提）。 */
  async #collectLocal(enabled) {
    const collections = {};
    const entries = [];
    /**
     * 单条记录超过这个体积就**不参与本次同步**。
     *
     * 为什么：同步是按体积切片发的（PUSH_CHUNK_BYTES），但**单条记录不能再切**。
     * 真机上一条内联了照片的笔记就有 3.7MB，推到小服务器上要几十秒，
     * 网关（www 的 UPSTREAM_TIMEOUT_MS，2026-10-21 由 30s 放宽到 240s）在超大单条上仍可能先超时
     * —— 整次同步因此永远失败，
     * 用户看到的就是"服务器响应太慢 / 一直中断"。与其让它卡死整批，不如跳过并如实报出来。
     * 网关超时已放宽到 240s（2026-10-21），但单条上限仍按 900KB 保守留着：
     * 一条 3.7MB 的记录在慢上行链路上本身就可能要几十秒，且中途断了要整条重来。
     * 真要放开，调 `MAX_SINGLE_RECORD_BYTES` 即可，与网关无关。
     */
    const oversized = [];
    const pick = (name, items) => {
      const kept = [];
      for (const item of items) {
        const projected = project(item);
        const bytes = Buffer.byteLength(JSON.stringify(projected) ?? '', 'utf8');
        if (bytes > MAX_SINGLE_RECORD_BYTES) {
          oversized.push({ collection: name, id: projected?.id ?? null, title: projected?.title ?? '', bytes });
          continue;
        }
        kept.push({ raw: item, projected });
      }
      return kept;
    };
    for (const entry of SYNC_COLLECTIONS) {
      if (!enabled.has(entry.name)) continue;
      if (entry.kind === 'file') {
        const items = (await readFileEntry(this.ctx, entry)).filter((item) => !singletonIsEmpty(entry, item));
        if (!items.length) continue;
        const picked = pick(entry.name, items);
        if (!picked.length) continue;
        collections[entry.name] = picked.map((p) => p.raw);
        for (const p of picked) entries.push({ collection: entry.name, item: p.projected });
        continue;
      }
      const items = allOf(this.store, entry).filter((item) => item && typeof item.id === 'string');
      const picked = pick(entry.name, items);
      collections[entry.name] = picked.map((p) => p.raw);
      for (const p of picked) entries.push({ collection: entry.name, item: p.projected });
    }
    return { collections, entries, deleted: {}, oversized };
  }

  /** 账号会话（本机后端持有令牌；这里只读，绝不外传）。 */
  async #session() {
    const live = this.services.account?.session;
    if (live?.token) return { serverUrl: live.serverUrl ?? '', token: String(live.token) };
    const saved = await this.accountFile.read();
    if (saved?.token) return { serverUrl: saved.serverUrl ?? '', token: String(saved.token) };
    return null;
  }

  /** 本次同步的目标地址：显式配置 > 上一次同步记住的 > 账号里的。 */
  #targetUrl(accountServerUrl) {
    const explicit = String(this.options.serverUrl ?? '').trim();
    if (explicit) return explicit;
    if (accountServerUrl) return String(accountServerUrl);
    return '';
  }

  /** 失败收尾：记 lastError（**只动状态文件**），本地业务数据一个字节都不碰。 */
  async #fail(report, error, startedAt) {
    const message = redactSecrets(error?.message ?? '同步失败');
    this.state.lastError = { at: nowIso(this.now), code: error?.code ?? 'SYNC_FAILED', message };
    await this.#saveState().catch(() => {});
    this.lastResult = { at: report.at, ok: false, error: message, durationMs: Math.max(0, this.now() - startedAt) };
    this.broadcast?.({ type: 'data_changed', module: 'sync', payload: { target: 'sync_run', ok: false, error: message } });
    return { ...report, ok: false, error: { code: error?.code ?? 'SYNC_FAILED', message }, durationMs: Math.max(0, this.now() - startedAt) };
  }

  /** 装配层在 listen 成功后调用：启动后自动同步一次（失败静默，只在面板显示）。 */
  start() {
    if (this.options.autoRun === false) return null;
    const task = (async () => {
      // 没登录就没有可同步的对象（服务端版每用户实例就是这种情形）：直接跳过，不产生任何请求
      const session = await this.#session().catch(() => null);
      if (!session?.token) return null;
      try {
        // 自动同步不传页面主机名：环境判定会是 `unknown`（按 native 处理），
        // 这只影响面板文案，不影响这一次同步的合并口径
        return await this.run({});
      } catch (error) {
        // 自动同步**失败要静默**：用户没点它，弹一个错误只会让人困惑；原因记在 lastError 里，
        // 打开「设置 → 多端同步」就能看到
        this.logger?.warn?.(`[sync] 启动自动同步失败：${redactSecrets(error?.message ?? error)}`);
        return null;
      }
    })();
    task.catch(() => {});
    return task;
  }
}

/* ================================================================ 纯工具 */

/**
 * 空报告骨架：字段名是**冻结**的（面板/手机照它读），一个都不能少。
 *
 * ⚠️ `skipped` 一个字段两种语义（接口冻结，不能改名，只能在类型上说清楚）：
 *   - **数字**（`0/7/…`）：正常跑完的轮次里"跳过多少条"；
 *   - **`true`（布尔）**：这一轮**根本没跑**（`reason: 'no_server' | 'no_account' | 'bad_server'`）。
 * 前端判断"没跑"必须用 `report.skipped === true`，写真值判断会把"跳过 7 条"误显示成"未登录"。
 */
export function emptyReport({ at, runtime, durationMs = 0 } = {}) {
  return {
    ok: true,
    at,
    durationMs,
    serverUrl: '',
    pushed: 0,
    pulled: 0,
    updated: 0,
    skipped: 0,
    renamed: 0,
    deleted: 0,
    duplicates: [],
    conflicts: [],
    skippedSecrets: [],
    unsupportedDeletes: [],
    oversized: [],
    errors: 0,
    groups: {},
    runtime: runtime ?? null,
  };
}

/** `'true'/'false'` 也认（表单来的值就是字符串）；其它一律 null（调用方负责 400）。 */
function parseBool(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

/** 结果明细里的标题：目录没给 title 函数就退回 id（绝不让报告因为一条脏记录整个失败）。 */
function safeTitle(entry, record) {
  try {
    const value = typeof entry.title === 'function' ? entry.title(record) : null;
    return value ? String(value).slice(0, 80) : String(record?.id ?? '');
  } catch {
    return String(record?.id ?? '');
  }
}

/** pull 响应形状校验：**先校验再合并**，畸形响应绝不进合并流程。 */
export function checkPullShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '响应不是对象';
  if (body.collections !== undefined && (typeof body.collections !== 'object' || body.collections === null || Array.isArray(body.collections))) return 'collections 不是对象';
  for (const [name, list] of Object.entries(body.collections ?? {})) {
    if (!Array.isArray(list)) return `集合 ${name} 不是数组`;
    for (const item of list) {
      if (!item || typeof item !== 'object') return `集合 ${name} 里有非对象记录`;
      if (typeof item.id !== 'string' || !item.id) return `集合 ${name} 里有记录缺 id（同步必须按 id 合并）`;
    }
  }
  if (body.deleted !== undefined) {
    if (typeof body.deleted !== 'object' || body.deleted === null || Array.isArray(body.deleted)) return 'deleted 不是对象';
    for (const [name, ids] of Object.entries(body.deleted)) {
      if (!Array.isArray(ids)) return `deleted.${name} 不是数组`;
    }
  }
  return null;
}

/** 计数桶相加（push 分片、push+pull 汇总都用它）。 */
const COUNT_KEYS = ['accepted', 'skipped', 'updated', 'renamed', 'deleted', 'errors'];

function mergeGroup(target, source) {
  const base = target ?? { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
  for (const key of COUNT_KEYS) base[key] = (base[key] ?? 0) + (Number(source?.[key]) || 0);
  if (source?.error && !base.error) base.error = source.error;
  if (source?.note && !base.note) base.note = source.note;
  return base;
}

function sumGroups(groups) {
  const total = { accepted: 0, skipped: 0, updated: 0, renamed: 0, deleted: 0, errors: 0 };
  for (const group of Object.values(groups ?? {})) for (const key of COUNT_KEYS) total[key] += Number(group?.[key]) || 0;
  return total;
}

/** push 与 pull 两个方向的逐集合计数合成一份（面板逐集合显示用）。 */
function mergeGroups(pushGroups, pullGroups) {
  const names = new Set([...Object.keys(pushGroups ?? {}), ...Object.keys(pullGroups ?? {})]);
  const out = {};
  for (const name of names) out[name] = { push: pushGroups?.[name] ?? null, pull: pullGroups?.[name] ?? null };
  return out;
}
