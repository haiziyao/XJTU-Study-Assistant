/**
 * 成长模块自己的「存储适配层」。
 *
 * 为什么需要它：源项目（Brain Online）用的是它自己的 `JsonStore`，
 * 集合对象直接挂在 `store.collection(name)` 上，并且提供 `one / patch / insertMany /
 * replace` 与单文档 `doc()`。XJTU 的框架存储（`core/store/json-store.js`）只有
 * `all / get / find / insert / update / remove`，而且是**同步读、异步写**；
 * 单文档也没有独立概念。
 *
 * 硬约束要求**不能改 core**，所以适配放在模块内：
 *   - `collection()` 把框架集合包成源项目那套异步接口，业务代码可以基本原样搬过来；
 *   - `doc()` 用「集合里一条固定 id = doc 的记录」模拟单文档，语义与源项目一致；
 *   - `replace()` 是备份恢复用的整集合替换。框架没有公开 replace，这里直接操作
 *     Collection 的公共 `records` Map + `persist()` 保持内存与磁盘一致；
 *     这是模块内唯一的“贴框架内部”的地方，写清楚是为了将来 framework 补 replace 时一处替换。
 *
 * 数据边界：集合名一律以 `growth` 开头（`growthStates` 等），由 `module.js` 声明，
 * 框架启动时创建。档案 / 设置这类“单文档”也走集合（业务数据、可同步、可备份），
 * 只有会话存档快照与 AI key 这类私有文件才直接落 `dataDir`。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { iso } from './time.js';

/** 单文档记录在集合里的固定 id。 */
const DOC_ID = 'doc';
const FILE_MODE = 0o600;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * 同一集合的写入必须串行（模块内保险）。
 *
 * 为什么 core 已经有 writeQueue 还要再加一层：XJTU 的 `Collection.persist()` 用固定的
 * 临时文件名 `${filePath}.${pid}.tmp`，而它的队列是先 `await this.writeQueue` 再替换队列，
 * 两个并发的 `insert()` 可能同时通过 await 点、各自启动一次写盘 —— 同一个 tmp 被先完成
 * 的那次 rename 走，后一次 rename 直接 ENOENT（实测 30 并发必现）。
 * 硬约束不允许改 `core/**`，所以成长模块在适配层把所有写操作按文件路径串行化。
 * 无论从哪个 `collection()` 包装实例发起，都共享同一个队列。
 */
const writeQueues = new Map();

function withWriteQueue(filePath, task) {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeQueues.set(filePath, next);
  return next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
}

/** 去掉存储层附加字段，保证单文档返回的形状与源项目 `Document.read()` 一致。 */
function stripMeta(record) {
  if (!record) return null;
  const { id, createdAt, updatedAt, ...value } = record;
  return value;
}

/**
 * 把 XJTU 的 Collection 包成源项目那套异步接口。
 * @param {object} store JsonStore
 * @param {string} name 集合名（必须已在 module.js 的 collections 里声明）
 */
export function collection(store, name) {
  const raw = store.collection(name);
  if (!raw) throw new Error(`成长模块缺少集合 ${name}`);

  return {
    name,
    /** 源项目里 all() 是 async；框架里是同步返回副本，这里统一包成 async 不改调用方。 */
    async all() {
      return raw.all();
    },
    async count() {
      return raw.all().length;
    },
    async find(predicate) {
      return raw.find(predicate);
    },
    async one(predicate) {
      return raw.find(predicate)[0] ?? null;
    },
    async get(id) {
      return raw.get(id) ?? null;
    },
    async insert(doc) {
      return withWriteQueue(raw.filePath, () => raw.insert(doc));
    },
    /** 逐条插入（框架没有批量 API）；任一条失败会停下，由调用方决定是否回滚。 */
    async insertMany(docs) {
      return withWriteQueue(raw.filePath, async () => {
        const out = [];
        for (const doc of docs) out.push(await raw.insert(doc));
        return out;
      });
    },
    async patch(id, changes) {
      return withWriteQueue(raw.filePath, async () => (await raw.update(id, changes)) ?? null);
    },
    async remove(id) {
      return withWriteQueue(raw.filePath, () => raw.remove(id));
    },
    /**
     * 整集合替换（备份恢复）。
     *
     * 框架没有 replace，也不能改 core：直接清空 `records` 再按备份写回，最后 `persist()`。
     * 这样内存缓存与磁盘是同一份，且**保留备份里的 id / createdAt**（源项目 replace 的语义）；
     * 如果走 remove + insert，insert 会把 createdAt 刷成恢复时刻，历史排序会变。
     */
    async replace(list) {
      return withWriteQueue(raw.filePath, async () => {
        const now = new Date().toISOString();
        raw.records.clear();
        for (const doc of list) {
          const id = doc.id ?? randomUUID();
          raw.records.set(id, {
            ...clone(doc),
            id,
            createdAt: doc.createdAt ?? now,
            updatedAt: doc.updatedAt ?? now,
          });
        }
        await raw.persist();
        return raw.records.size;
      });
    },
    /** 文件路径（存档测试会用它确认落盘位置）。 */
    get filePath() {
      return raw.filePath;
    },
  };
}

/**
 * 单文档：源项目 `store.doc(name, defaults)` 的等价物。
 *
 * 用集合里的一条固定 id 记录模拟；`id` 默认 'doc'（同一集合可放多个单文档，例如
 * 'settings' 与 'ai' 共用一个 `growthSettings` 集合）；`read()` 每次把默认值合并回去 ——
 * 所以旧版本数据缺字段时不需要迁移（与源项目「缺字段回落默认值」的承诺一致）。
 */
export function doc(store, collectionName, defaults = {}, id = DOC_ID) {
  const col = collection(store, collectionName);

  async function read() {
    const raw = await col.get(id);
    return { ...clone(defaults), ...(stripMeta(raw) ?? {}) };
  }

  async function set(value) {
    const payload = stripMeta(clone(value)) ?? {};
    if (payload.id) delete payload.id;
    if (payload.createdAt) delete payload.createdAt;
    if (payload.updatedAt) delete payload.updatedAt;
    const current = await col.get(id);
    const saved = current ? await col.patch(id, payload) : await col.insert({ ...payload, id });
    return stripMeta(saved);
  }

  return {
    read,
    set,
    async update(changes) {
      const current = await read();
      return set({ ...current, ...changes });
    },
    /** 只改嵌套键，避免上层误覆盖（与源项目 Document.merge 同款）。 */
    async merge(nested, changes) {
      const current = await read();
      return set({ ...current, [nested]: { ...(current[nested] ?? {}), ...changes } });
    },
  };
}

/**
 * 原子写 JSON 文件（会话存档 / 恢复前快照）。
 *
 * 与源项目一致的取舍：先写 `.tmp` 再 rename，断电不会留下半个文件；
 * 0600 因为存档里可能有当天的日记与状态。
 */
export async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, FILE_MODE);
  } catch {
    /* Windows 上 chmod 可能不支持，忽略 */
  }
}

/**
 * 数据变更广播（统一的 WS 形状）。
 *
 * 源项目用 SSE 的多种事件类型（state/tasks/plan/session/reminder…）；XJTU 的实时通道是
 * WebSocket，约定形状是 `{ type:'data_changed', module, payload }`。这里把所有事件都
 * 收敛成同一外壳，用 `payload.target` / `payload.event` 区分具体来源 ——
 * 前端只需要一个 `data_changed` 监听器，按 module='growth' 过滤即可。
 */
export function createEmitter(broadcast, clock) {
  return function emit(target, payload = {}, event = null) {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast({
        type: 'data_changed',
        module: 'growth',
        payload: {
          target,
          ...(event ? { event } : {}),
          ...payload,
          at: iso(clock.now()),
        },
      });
    } catch {
      /* 推送失败不影响写入（与源项目 Bus 的取舍相同） */
    }
  };
}
