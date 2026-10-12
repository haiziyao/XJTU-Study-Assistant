/**
 * 指令目标 `weekly` 的处理器（`services.commands.registerHandler('weekly', ...)`）。
 *
 * 为什么只给两个 action：
 *
 * - `query` **只读**：会被 chat-service 的只读查询循环用 `dryRun: true` 自动执行 ——
 *   用户问"上周学了什么"时，模型必须先能读到已有周报，而读取**绝不能**触发模型调用
 *   （否则一次提问会连带生成一份周报，白花 token，还可能把"生成"混进闲聊里）。
 *   它顺带把现算的 stats 摘要放进 `summary`：没有周报时模型也能用真实数字回答，
 *   而不是说"我看不到"。
 *
 * - `create` 是**唯一会花钱**的动作：它调 `weekly.generate()`，而 generate 内部会调一次模型
 *   （同一周已有报告则命中缓存、不重复花）。`dryRun` 分支**不调模型**：确认卡要在用户点之前
 *   就把"将生成哪一周"摆清楚，而"点之前的预览"没有任何理由消耗额度。
 *
 * 返回结构与其它模块一致：查询给 `{ filters, count, items, explain }`，
 * 写操作给 `{ item, affected, explain }`（ai/chat-service.js 的 #compactQueryResult 按这个形状投影）。
 */

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

/** 查询条件：只认 from / to / id / limit，别的键一律忽略（宁可不查，也不猜）。 */
function filtersOf(draft) {
  const filters = draft?.filters ?? {};
  const fields = draft?.fields ?? {};
  return {
    id: trim(filters.id) || trim(fields.id) || undefined,
    from: trim(filters.from) || trim(fields.from) || undefined,
    to: trim(filters.to) || trim(fields.to) || undefined,
    limit: Number.isInteger(filters.limit) ? filters.limit : undefined,
  };
}

/** 把一条周报压成查询结果项（正文字段名沿用落库名 `report`）。 */
function toItem(record) {
  return {
    id: record.id,
    from: record.from,
    to: record.to,
    week: record.week,
    report: record.report,
    generatedAt: record.generatedAt ?? null,
    model: record.model ?? null,
    fallback: Boolean(record.fallback),
    reason: record.reason ?? null,
  };
}

export function createWeeklyCommands({ weekly }) {
  return {
    /** 只读查询：读已有周报；没有报告时给 stats 摘要，并明说"还没生成"。 */
    query(draft) {
      const filters = filtersOf(draft);

      if (filters.id) {
        const record = weekly.get(filters.id);
        return {
          filters,
          count: 1,
          items: [toItem(record)],
          summary: { stats: weekly.digestOf(record.stats ?? weekly.stats({ from: record.from, to: record.to })) },
          explain: `${record.week}（${record.from} ~ ${record.to}）的周报${record.fallback ? '（规则小结，未由模型撰写）' : ''}。`,
        };
      }

      // 指了区间（或只指一端）就读那一周：有报告给报告，没有就只给数字
      if (filters.from || filters.to) {
        const result = weekly.getReport({ from: filters.from, to: filters.to });
        const summary = { stats: weekly.digestOf(result.stats), missing: result.stats.missing };
        if (!result.cached) {
          return {
            filters: { ...filters, from: result.from, to: result.to },
            count: 0,
            items: [],
            summary,
            explain: `${result.week}（${result.from} ~ ${result.to}）还没有生成周报；要生成就对 target "weekly" 发 create（会调用一次模型，同一周不会重复花）。下面是这一周的现算统计。`,
          };
        }
        return {
          filters: { ...filters, from: result.from, to: result.to },
          count: 1,
          items: [
            {
              id: result.id,
              from: result.from,
              to: result.to,
              week: result.week,
              report: result.report,
              generatedAt: result.generatedAt,
              model: result.model,
              fallback: result.fallback,
              reason: result.reason,
            },
          ],
          summary,
          explain: `${result.week}（${result.from} ~ ${result.to}）的周报${result.fallback ? '（规则小结，未由模型撰写）' : ''}${
            result.statsChangedSinceReport ? '；注意：正文生成之后这周的数据又有变化，可以 force 重写。' : '。'
          }`,
        };
      }

      // 没给区间就列最近的几份（默认 3：模型用不着一次看十几份几百字的正文）
      const limit = Math.min(Math.max(filters.limit ?? 3, 1), 20);
      const listed = weekly.list({ limit });
      return {
        filters,
        count: listed.items.length,
        items: listed.items.map(toItem),
        summary: { total: listed.total, latest: listed.items[0] ? weekly.digestOf(listed.items[0].stats ?? {}) : null },
        explain: listed.items.length
          ? `最近 ${listed.items.length} 份周报（共 ${listed.total} 份），从 ${listed.items[0].week} 起倒序。`
          : '还没有任何周报；用户想生成时对 target "weekly" 发 create。',
      };
    },

    /**
     * 生成（唯一会花 token 的动作）。
     *
     * `dryRun`：只回"将生成哪一周"和现算统计，**不调模型、不落库** —— 这是自动审批档
     * （permission=auto）与确认卡共用的一条路径，预览消耗额度是说不过去的。
     */
    async create(draft, options = {}) {
      const fields = draft?.fields ?? {};
      const force = fields.force === true || draft?.force === true;
      // 先把区间规范化（非法日期在这里就 400），后续预览与生成用的是同一个区间
      const range = weekly.resolveRange({ from: trim(fields.from) || undefined, to: trim(fields.to) || undefined });

      if (options.dryRun) {
        // 读一次 getReport 就够：它的 `stats` 是现算的、`cached` 说明这周是否已有报告
        const current = weekly.getReport({ from: range.from, to: range.to });
        return {
          dryRun: true,
          planned: { action: 'create', target: 'weekly', fields: { from: range.from, to: range.to, force } },
          cached: Boolean(current.cached),
          stats: current.stats,
          explain: current.cached
            ? `${range.week}（${range.from} ~ ${range.to}）已经有周报了，直接读取即可（要重写才带 force）。`
            : `将为 ${range.week}（${range.from} ~ ${range.to}）生成周报：会调用一次模型；未配置 AI 时降级为规则小结。`,
        };
      }

      const result = await weekly.generate({ from: range.from, to: range.to, force });
      return {
        item: result,
        affected: [{ id: result.id, title: `${result.week} 周报（${result.from} ~ ${result.to}）` }],
        cached: Boolean(result.cached),
        explain: result.cached
          ? `${result.week} 的周报已经生成过，直接返回缓存（没有重复调用模型）。`
          : result.fallback
            ? `已生成 ${result.week} 周报：模型不可用（${result.reason}），先用规则小结代替。`
            : `已生成 ${result.week}（${result.from} ~ ${result.to}）的学习周报。`,
      };
    },
  };
}
