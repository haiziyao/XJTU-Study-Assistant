/**
 * 极简 JSON 集合存储。
 *
 * 设计取舍（单机单用户场景）：
 * - 一个集合 = 一个 JSON 文件，进程内全量驻留内存，读取零 IO。
 * - 写入采用「先写临时文件再 rename」的原子替换，避免进程中断产生半截文件。
 * - 同一集合的写入串行化（promise 链），避免并发覆盖。
 * - 不引入数据库依赖，方便测试与打包；后续若数据量增大，只需替换本文件实现。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export class Collection {
  /**
   * @param {object} options
   * @param {string} options.filePath  数据文件绝对路径
   * @param {string[]} options.indexes 需要建立内存索引的字段
   */
  constructor({ filePath, indexes = [] }) {
    this.filePath = filePath;
    this.indexes = indexes;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
      let skipped = 0;
      for (const item of items) {
        // 逐条容错：单条记录损坏不会拖垮整个文件（PotatoCalendar 的整表清空是数据丢失级缺陷）
        if (item && typeof item === 'object' && item.id) this.records.set(item.id, item);
        else skipped += 1;
      }
      if (skipped) console.warn(`[store] ${this.filePath} 跳过 ${skipped} 条无效记录`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.persist();
      } else {
        // 文件损坏时先备份原件再以空集合启动，绝不静默覆盖用户数据
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        console.error(`[store] ${this.filePath} 解析失败（${error.message}），已备份到 ${backup}`);
        await this.persist();
      }
    }
    this.loaded = true;
    return this;
  }

  async persist() {
    const payload = { schemaVersion: SCHEMA_VERSION, items: [...this.records.values()] };
    await this.writeQueue.catch(() => {});
    this.writeQueue = (async () => {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.filePath);
    })();
    return this.writeQueue;
  }

  /** 全部记录（按 createdAt 升序的副本）。 */
  all() {
    return [...this.records.values()]
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
      .map(clone);
  }

  get(id) {
    return clone(this.records.get(id));
  }

  find(predicate) {
    return this.all().filter(predicate);
  }

  async insert(data) {
    const now = new Date().toISOString();
    const record = {
      ...clone(data),
      id: data.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    await this.persist();
    return clone(record);
  }

  async update(id, patch) {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    await this.persist();
    return clone(next);
  }

  async remove(id) {
    const existed = this.records.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async removeMany(ids) {
    let removed = 0;
    for (const id of ids) if (this.records.delete(id)) removed += 1;
    if (removed) await this.persist();
    return removed;
  }
}

/**
 * 数据层门面。
 *
 * 集合分两类：
 * - **框架集合**：`commandLogs`（指令日志，跨模块共用），固定由本文件创建；
 * - **模块集合**：由模块描述符的 `collections` 声明，装配时注入（见 core/module/contract.js）。
 *   这样新增功能不必修改本文件，只需在自己的 module.js 里声明。
 *
 * 集合实例按名字挂在 store 上（`store.events`、`store.lmsCourses` …），`collection(name)`
 * 是等价的显式取用方式。
 */
export class JsonStore {
  constructor({ dataDir, collections = [] }) {
    this.dataDir = dataDir;
    /** @type {string[]} 已注册的集合名（含框架集合），init() 按它逐个加载。 */
    this.collectionNames = [];

    /** 指令历史，供前端「最近指令」与后续 AI 训练/回放使用（框架级，不属于任何模块）。 */
    this.#register({ name: 'commandLogs', file: 'command-logs.json' });

    for (const spec of collections) this.#register(spec);
  }

  #register({ name, file, indexes = [] }) {
    if (typeof name !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(`集合名不合法: ${JSON.stringify(name)}`);
    }
    if (this.collectionNames.includes(name)) {
      throw new Error(`集合名冲突: ${name}（同名集合只能由一个模块声明）`);
    }
    if (!file) throw new Error(`集合 ${name} 缺少 file`);
    this[name] = new Collection({ filePath: path.join(this.dataDir, file), indexes });
    this.collectionNames.push(name);
    return this[name];
  }

  async init() {
    await Promise.all(this.collectionNames.map((name) => this[name].load()));
    return this;
  }

  collection(name) {
    const target = this[name];
    if (!(target instanceof Collection)) throw new Error(`未知集合: ${name}`);
    return target;
  }
}

