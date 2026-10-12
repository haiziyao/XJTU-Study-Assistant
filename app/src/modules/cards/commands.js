/**
 * 指令目标 `card` 的处理器（`services.commands.registerHandler('card', …)`）。
 *
 * 五个动作，写操作全部尊重 `options.dryRun`（只预览不落库）：
 *
 *   query   只读，会被 chat-service 的 `#runReadOnlyQueries` 用 `dryRun: true` 自动执行 ——
 *           问「今天要复习什么」不需要用户点确认，也不该写数据（连指令日志都不写）；
 *   create  / update / delete  用户确认之后才走到这里；
 *   review  **同样是写操作**：它会真的推进这张卡的排期，所以它只在用户自己说了评分
 *           （忘了 / 吃力 / 记得 / 太简单）之后才允许被调用，并且**没有默认评分** ——
 *           默认成 good 等于替用户宣称"记住了"，之后所有排期都建立在一句没人说过的话上。
 *
 * 返回结构与其它模块一致：写操作给 `{ item, affected, explain }`，查询给
 * `{ filters, count, items, explain }`（chat-service 的 `#compactQueryResult` 按这个形状投影）。
 */

import { HttpError } from '../../core/http/router.js';
import { GRADES, GRADE_LABEL } from './scheduler.js';

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

/** 查询条件：模型给的键名允许几种自然写法（keyword/query → q）。 */
function filtersOf(draft) {
  const filters = draft?.filters ?? {};
  const due = filters.due ?? filters.dueOnly;
  return {
    due: due === true || due === 'true' || due === 1 ? true : undefined,
    course: trim(filters.course) || undefined,
    tag: trim(filters.tag) || undefined,
    noteId: trim(filters.noteId) || undefined,
    suspended: filters.suspended === true || filters.suspended === 'true' ? true : undefined,
    q: trim(filters.q) || trim(filters.keyword) || trim(filters.query) || trim(filters.front) || undefined,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * 定位"要改 / 要删 / 要复习的那一张"。
 *
 * 卡片没有唯一的名字，所以只认两种定位：明确的 `id`，或能唯一定位的正面文字。
 * **一条都不匹配就 404、匹配到多条就 400** —— 改错/删错一张卡的代价是用户白复习一轮，
 * 这一层宁可报错也不猜（与 memory 的 `locate()` 同一原则）。
 *
 * `allowFields: false` 用于 update：那里 `fields.front` 是"要改成的新正面"，
 * 拿它当定位条件会把"把 A 改成 B"读成"找到 B 再改成 B"。
 */
function locate(cards, draft, { allowFields = true } = {}) {
  const filters = draft?.filters ?? {};
  const fields = allowFields ? (draft?.fields ?? {}) : {};

  const id = trim(filters.id) || trim(fields.id);
  if (id) return cards.get(id);

  const text =
    trim(filters.front) || trim(fields.front) || trim(filters.q) || trim(filters.keyword) || trim(filters.query);
  if (!text) {
    throw HttpError.badRequest(
      allowFields
        ? '定位卡片需要 id，或正面文字（filters.front / filters.q）'
        : '定位卡片需要 id 或 filters.q（要改成的新正面请放 fields.front）',
      { field: 'id', hint: '先用 {"action":"query","target":"card","filters":{"q":"关键词"}} 查出 id' },
    );
  }

  const matched = cards.findByFront(text);
  if (matched.length === 1) return matched[0];
  if (!matched.length) throw HttpError.notFound(`没有匹配的卡片：${text}`);
  throw HttpError.badRequest(`有 ${matched.length} 张卡片的正面包含「${text}」，请给更精确的文字或直接给 id`, {
    field: 'front',
    ids: matched.map((card) => card.id),
  });
}

export function createCardCommands({ cards }) {
  return {
    /** 只读查询：AI 自动执行的那条路径（`dryRun` 不影响它，反正不写库）。 */
    query(draft) {
      const filters = filtersOf(draft);
      const result = cards.list(filters);

      // 0 条时把话说清楚：是"今天没有到期的"还是"库里根本没有这张卡"——
      // 两者对用户的下一步完全不同（去休息 vs 去建卡），模型看到这句才不会瞎猜
      const explain = result.count
        ? `命中 ${result.count} 张卡片（现在到期 ${result.counts.due} 张、已暂停 ${result.counts.suspended} 张）。`
        : filters.due
          ? '现在没有到期的卡片。'
          : '没有找到符合条件的卡片。';

      return { filters, count: result.count, items: result.items, explain };
    },

    /**
     * 加卡。`dryRun` 只做校验 —— 确认卡要在用户点之前就能报出"答案不能为空""超过 2000 字"，
     * 而不是点完才发现什么都没发生。
     */
    async create(draft, options = {}) {
      const fields = { ...(draft?.fields ?? {}) };
      const defaultSource = fields.source ?? 'ai';
      if (options.dryRun) {
        const validated = cards.validate(fields, { defaultSource });
        return { dryRun: true, planned: { action: 'create', target: 'card', fields }, validated };
      }
      const item = await cards.create(fields, { defaultSource });
      return {
        item,
        affected: [{ id: item.id, title: item.front }],
        explain: `已加卡片：${item.front}`,
      };
    },

    /** 改正面 / 答案 / 标签 / 课程 / 暂停；`source` 与排期字段不接受修改（服务层会忽略）。 */
    async update(draft, options = {}) {
      const current = locate(cards, draft, { allowFields: false });
      const fields = { ...(draft?.fields ?? {}) };
      delete fields.id;
      delete fields.source;
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'update', target: 'card', ids: [current.id], fields } };
      }
      const item = await cards.update(current.id, fields);
      return { item, affected: [{ id: item.id, title: item.front }], explain: `已改正卡片：${item.front}` };
    },

    /** 删除（不可逆）。`dryRun` 先把"要删的是哪一张"回报清楚。 */
    async delete(draft, options = {}) {
      const current = locate(cards, draft);
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: 'card', ids: [current.id], front: current.front } };
      }
      await cards.remove(current.id);
      return { affected: [{ id: current.id, title: current.front }], explain: `已删除卡片：${current.front}` };
    },

    /**
     * 记一次复习评分（**写操作**：会推进这张卡的排期）。
     *
     * 缺少 grade 一律 400，不猜、不默认：评分是用户对"自己记住了多少"的判断，
     * 这是整个模块里唯一不能由系统代劳的输入。
     */
    async review(draft, options = {}) {
      const current = locate(cards, draft);
      const grade = trim(draft?.fields?.grade) || trim(draft?.filters?.grade);
      if (!grade) {
        throw HttpError.badRequest(
          `复习必须给出评分（${GRADES.join(' / ')}）—— 它代表用户自己的判断，不能由系统默认`,
          { field: 'grade', allowed: [...GRADES] },
        );
      }
      if (!GRADES.includes(grade)) {
        throw HttpError.badRequest(`字段 grade 不合法：取值必须是 ${GRADES.join(' / ')} 之一`, {
          field: 'grade',
          allowed: [...GRADES],
        });
      }
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'review', target: 'card', ids: [current.id], grade } };
      }
      const result = await cards.review(current.id, grade);
      return {
        item: result.item,
        nextDue: result.nextDue,
        affected: [{ id: result.item.id, title: result.item.front }],
        // 回执要把"用户说的是哪一档"和"下次什么时候见"都说清楚：
        // 这正是唯一可以去对用户说"这次复习记下了"的场合
        explain: `已记录复习（${GRADE_LABEL[grade] ?? grade}）：${result.item.front}，${result.explain}`,
      };
    },
  };
}
