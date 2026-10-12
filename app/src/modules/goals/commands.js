/**
 * 指令目标 `goal` 的处理器（`services.commands.registerHandler('goal', ...)`）。
 *
 * 为什么 target 叫 `goal` 而不是 `goals`：指令对象里的 `target` 是**单数实体名**（`todo` /
 * `schedule` / `event` / `grade` / `memory`），与集合名（`todos` / `goals`）刻意不同 ——
 * 混用会让"这条指令操作的是哪张表"变得含糊。
 *
 * 五个 action：
 *   - `query`  **只读**，会被 chat-service 的只读查询循环自动执行（dryRun: true 也会跑），
 *              问「我最近有什么 DDL」不需要用户点确认；
 *   - `overview` 只读，返回合并后的"接下来要面对什么"（含 gpa 对比）；
 *   - `create` / `update` / `delete` / `progress` 是写操作，`dryRun` 时**只校验不落库** ——
 *              确认卡要在用户点之前就能报出"日期格式不对"这类错误。
 *
 * 返回结构与其它模块一致：写操作给 `{ item, affected, explain }`，查询给
 * `{ filters, count, items, summary?, explain }`（chat-service 的 `#compactQueryResult`
 * 按这个形状投影，并且会把 `summary` 原样回灌给模型 —— 学分绩就靠它）。
 */

import { HttpError } from '../../core/http/router.js';
import { KIND_LABEL, SEVERITY_LABEL } from './service.js';

const trimText = (value) => (typeof value === 'string' ? value.trim() : '');

/** 查询过滤条件：模型给的键名允许几种自然写法（keyword/query → q）。 */
function filtersOf(draft) {
  const filters = draft?.filters ?? {};
  return {
    status: trimText(filters.status) || undefined,
    kind: trimText(filters.kind) || undefined,
    course: trimText(filters.course) || undefined,
    q:
      trimText(filters.q) ||
      trimText(filters.keyword) ||
      trimText(filters.query) ||
      trimText(filters.title) ||
      undefined,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/**
 * 定位"要改 / 要删 / 要推进的那一条"。
 *
 * 只认两种定位：明确的 `id`（模型查过之后手里就有），或**标题唯一匹配**的 `title` / `keyword`。
 * 标题匹配到多条时**报错并列出来**，绝不替用户挑一条 —— 改错一条目标的代价是静默改掉
 * 一个别的事（"考研"和"考研数学"只差两个字）。
 */
function locate(goals, draft) {
  const filters = draft?.filters ?? {};
  const fields = draft?.fields ?? {};
  const id = trimText(filters.id) || trimText(fields.id);
  if (id) return goals.get(id);

  const keyword = trimText(filters.title) || trimText(filters.keyword) || trimText(fields.title);
  if (keyword) {
    const hits = goals.list({ q: keyword, limit: 5 }).items;
    if (!hits.length) throw HttpError.notFound(`没有标题含「${keyword}」的目标`);
    if (hits.length > 1) {
      throw HttpError.conflict(`「${keyword}」匹配到 ${hits.length} 条目标，请先查询再用 id 指定`, {
        field: 'id',
        candidates: hits.map((item) => ({ id: item.id, title: item.title, targetDate: item.targetDate })),
      });
    }
    return goals.get(hits[0].id);
  }
  throw HttpError.badRequest('定位目标需要 id，或能唯一匹配的标题', {
    field: 'id',
    hint: '先用 {"action":"query","target":"goal"} 查出 id',
  });
}

/** 一句话说清一条合并条目：`[已逾期 3 天] 交实验报告（待办，10-24）`。 */
function describeRow(row) {
  const when = row.overdue
    ? `已逾期 ${Math.abs(row.daysLeft)} 天`
    : row.daysLeft === 0
      ? '今天到期'
      : `还有 ${row.daysLeft} 天`;
  return `[${SEVERITY_LABEL[row.severity] ?? row.severity}·${when}] ${row.title}（${row.kind}，${row.date}）`;
}

export function createGoalCommands({ goals }) {
  return {
    /** 只读查询：AI 自动执行的那条路径。 */
    query(draft) {
      const filters = filtersOf(draft);
      const result = goals.list({
        status: filters.status,
        kind: filters.kind,
        course: filters.course,
        q: filters.q,
        limit: filters.limit,
        offset: filters.offset,
      });

      /**
       * `summary` 是给模型的**聚合口径**：条数、逾期数、最近一条。
       *
       * 为什么不能只给 items：模型拿不到"一共几条逾期"时，会数 items 里的条数 ——
       * 而 items 是分页的，于是它会用一页的数字回答"总共有多少"。
       */
      const summary = {
        total: result.counts.total,
        byStatus: result.counts.byStatus,
        byKind: result.counts.byKind,
        overdue: result.counts.overdue,
        dueSoon: result.counts.dueSoon,
      };

      const explain = result.count
        ? `命中 ${result.count} 条目标（其中逾期 ${summary.overdue} 条）。`
        : '没有找到符合条件的目标。';

      return { filters, count: result.count, summary, counts: result.counts, items: result.items, explain };
    },

    /**
     * 只读：三来源合并的"接下来要面对什么"。
     *
     * 这是本模块给模型的**首选查询**：用户问"我最近有什么要交的""接下来有什么要准备的"，
     * 一次就能拿到目标 + 待办 + 事件，并且已经按严重度排好序。`summary` 里带学分绩对比，
     * 模型回答"我离目标还差多少"时直接用，不必再查学业模块。
     */
    overview(draft) {
      const filters = draft?.filters ?? {};
      const result = goals.overview({
        days: filters.days,
        limit: filters.limit,
        includeDone: filters.includeDone === true,
        course: trimText(filters.course) || undefined,
      });
      const head = result.items.slice(0, 5).map(describeRow);
      return {
        filters: { days: result.days, limit: filters.limit ?? 50, course: filters.course ?? null },
        count: result.count,
        summary: {
          ...result.summary,
          window: { from: result.from, to: result.to, days: result.days },
          sources: result.sources,
          gpa: result.gpa,
          disclaimer: result.disclaimer,
        },
        items: result.items,
        explain: result.count
          ? `未来 ${result.days} 天（含逾期）：逾期 ${result.summary.overdue} 条、7 天内 ${result.summary.dueWithin7Days} 条。最要紧的：${head.join('；')}`
          : `未来 ${result.days} 天没有要面对的目标、待办或事件。`,
      };
    },

    /** 落库（用户确认之后）。`dryRun` 只做校验。 */
    async create(draft, options = {}) {
      const fields = draft?.fields ?? {};
      if (options.dryRun) {
        const validated = goals.validate(fields);
        return { dryRun: true, planned: { action: 'create', target: 'goal', fields }, validated };
      }
      const item = await goals.create(fields);
      return {
        item,
        affected: [{ id: item.id, title: item.title }],
        explain: `已建${KIND_LABEL[item.kind] ?? '目标'}「${item.title}」：${item.targetDate}（还有 ${item.daysLeft} 天）`,
      };
    },

    /** 局部更新（`fields` 里给要改的字段，定位靠 `id` 或唯一标题）。 */
    async update(draft, options = {}) {
      const current = locate(goals, draft);
      const fields = { ...(draft?.fields ?? {}) };
      // id 只用于定位，不是可改字段（改了会把记录指到别处）
      delete fields.id;
      if (options.dryRun) {
        const validated = goals.validate({ ...current, ...fields });
        return { dryRun: true, planned: { action: 'update', target: 'goal', ids: [current.id], fields }, validated };
      }
      const item = await goals.update(current.id, fields);
      return {
        item,
        affected: [{ id: item.id, title: item.title }],
        explain: `已更新「${item.title}」：目标日 ${item.targetDate}，状态 ${item.status}`,
      };
    },

    /** 删除（不可逆）。`dryRun` 只回报会删哪一条。 */
    async delete(draft, options = {}) {
      const current = locate(goals, draft);
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: 'goal', ids: [current.id], title: current.title } };
      }
      await goals.remove(current.id);
      return { affected: [{ id: current.id, title: current.title }], explain: `已删除目标「${current.title}」` };
    },

    /**
     * 推进进度 / 勾里程碑 / 改状态。
     *
     * 与 `update` 分开是因为它们的语义不同：`update` 改的是"这个目标是什么"，
     * `progress` 改的是"做到哪了"。混在一起时，模型很容易在"勾个里程碑"时顺手把
     * `targetDate` 也改掉（它会把当前记录整份回传）。
     */
    async progress(draft, options = {}) {
      const current = locate(goals, draft);
      const fields = draft?.fields ?? {};
      const payload = {
        progress: fields.progress,
        delta: fields.delta,
        milestoneId: fields.milestoneId,
        done: fields.done,
        status: fields.status,
      };
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'progress', target: 'goal', ids: [current.id], fields: payload } };
      }
      const item = await goals.setProgress(current.id, payload);
      const done = item.progress === null ? '未估' : `${item.progress}%`;
      return {
        item,
        affected: [{ id: item.id, title: item.title }],
        explain: `「${item.title}」进度 ${done}（里程碑 ${item.milestoneDone}/${item.milestoneTotal}）`,
      };
    },
  };
}
