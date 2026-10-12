/**
 * 指令目标 `memory` 的处理器（§10.9：`registerHandler('memory')`）。
 *
 * 为什么会话里的模型能"记住"东西，但只能经由这一层落库：
 * - `query` **只读**，会被 chat-service 的 `#runReadOnlyQueries` 用 `dryRun: true` 自动执行
 *   —— 问「你还记得…」不需要用户点确认，查询也不该写数据（连指令日志都不写）；
 * - `create` 是**用户确认之后**才走到的那一步：`POST /memories/propose` 给的草稿被点确认后
 *   由 `/commands/execute` 执行。它尊重 `fields.source`，所以确认一条 AI 提议落库的是
 *   `source: "ai"`（§10.2：模型提议后经确认），而不是被改写成"用户明说"。
 *
 * 返回结构与其它模块一致：写操作给 `{ item, affected, explain }`，查询给
 * `{ filters, count, items, explain }`（chat-service 的 `#compactQueryResult` 按这个形状投影）。
 */

import { HttpError } from '../../core/http/router.js';
import { KIND_LABEL } from './service.js';

const trimText = (value) => (typeof value === 'string' ? value.trim() : '');

/** 查询过滤条件：模型给的键名允许几种自然写法（keyword/query → q）。 */
function filtersOf(draft) {
  const filters = draft?.filters ?? {};
  return {
    scope: trimText(filters.scope) || undefined,
    kind: trimText(filters.kind) || undefined,
    status: trimText(filters.status) || undefined,
    key: trimText(filters.key) || undefined,
    q: trimText(filters.q) || trimText(filters.keyword) || trimText(filters.query) || undefined,
    dueReview: filters.dueReview === true,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * 定位"要改/要删的那一条"。
 *
 * 记忆没有自然语言的定位语法（不像日程有"明天的项目周会"），所以只认两种定位：
 * 明确的 `id`，或能唯一定位的 `scope + key`。找不到就 404、给多了就 400 ——
 * 改错一条长期偏好的代价见 §10.6，这一层宁可报错也不猜。
 */
function locate(memory, draft) {
  const filters = draft?.filters ?? {};
  const fields = draft?.fields ?? {};
  const id = trimText(filters.id) || trimText(fields.id);
  if (id) return memory.get(id);

  const scope = trimText(filters.scope) || trimText(fields.scope) || 'global';
  const key = trimText(filters.key) || trimText(fields.key);
  if (key) {
    const found = memory.activeByKey(scope, key);
    if (found) return found;
    throw HttpError.notFound(`没有匹配的记忆：scope=${scope} key=${key}`);
  }
  throw HttpError.badRequest('定位记忆需要 id，或 scope + key', { field: 'id', hint: '先用 {"action":"query","target":"memory"} 查出 id' });
}

export function createMemoryCommands({ memory }) {
  return {
    /** 只读查询：AI 自动执行的那条路径（`dryRun` 不影响它，反正不写库）。 */
    query(draft) {
      const filters = filtersOf(draft);
      const result = memory.list({
        scope: filters.scope,
        kind: filters.kind,
        status: filters.status,
        key: filters.key,
        q: filters.q,
        dueReview: filters.dueReview,
        limit: filters.limit,
        offset: filters.offset,
      });

      // 0 条时把话说清楚，模型才知道下一步：同键查不到 = 可以提议；
      // 查到 rejected = 绝不重提（§10.4 的负记忆）；语料为空 = 用户还没记过任何东西。
      const explain = result.count
        ? `命中 ${result.count} 条记忆。`
        : filters.key
          ? `没有 scope=${filters.scope ?? 'global'} key=${filters.key} 的记忆（可以提议）。`
          : '没有找到符合条件的记忆。';

      return { filters, count: result.count, items: result.items, explain };
    },

    /**
     * 落库（用户确认之后）。`dryRun` 只做校验 —— 确认卡要在用户点之前就能报出
     * "超过 200 字""含敏感信息"这类错误，而不是点完才发现什么都没发生。
     */
    async create(draft, options = {}) {
      const fields = draft?.fields ?? {};
      if (options.dryRun) {
        const validated = memory.validate(fields, { defaultSource: fields.source ?? 'ai' });
        return { dryRun: true, planned: { action: 'create', target: 'memory', fields }, validated };
      }
      const result = await memory.createFromCommand(fields, { confidence: draft?.confidence });
      const item = result.item;
      return {
        item,
        duplicated: Boolean(result.duplicated),
        replaced: result.replaced ?? null,
        affected: [{ id: item.id, title: item.text }],
        explain: result.duplicated
          ? `这条已经记过了：${item.text}`
          : `记住了（${KIND_LABEL[item.kind] ?? item.kind}，来源 ${item.source}）：${item.text}`,
      };
    },

    /** 改正既有记忆（`fields` 里给要改的字段，定位靠 `id` 或 `scope + key`）。 */
    async update(draft, options = {}) {
      const current = locate(memory, draft);
      const fields = { ...(draft?.fields ?? {}) };
      // id 只用于定位，不是可改字段；source/confidence/supersededBy 由服务层按 §10.4 管
      delete fields.id;
      delete fields.source;
      delete fields.supersededBy;
      if (options.dryRun) {
        const validated = memory.validate({ ...current, ...fields }, { defaultSource: current.source });
        return { dryRun: true, planned: { action: 'update', target: 'memory', ids: [current.id], fields }, validated };
      }
      const item = await memory.update(current.id, fields);
      return { item, affected: [{ id: item.id, title: item.text }], explain: `已改正：${item.text}` };
    },

    /** 删除（不可逆，§10.4）。`dryRun` 只回报会删哪一条。 */
    async delete(draft, options = {}) {
      const current = locate(memory, draft);
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: 'memory', ids: [current.id], text: current.text } };
      }
      await memory.remove(current.id);
      return { affected: [{ id: current.id, title: current.text }], explain: `已删除记忆：${current.text}` };
    },
  };
}
