/**
 * 只读目标 `search` 的指令处理器 —— 就是"一次查询三路"落到 AI 对话里的那个入口。
 *
 * 模型写一条 `{"action":"query","target":"search","filters":{"q":"转专业","scope":"all"}}`，
 * `chat-service` 的 `#runReadOnlyQueries` 会用 `dryRun: true` 执行它（只读查询不需要用户确认），
 * 再把结果投影后回灌。所以这里**只有 query 一个动作**：统一检索不改任何数据，
 * 写库永远走各模块自己的 target（memory 的 create、calendar 的 create…）。
 *
 * 返回里有两点是刻意设计的：
 *
 * 1. **`summary` 里带上 per-source 的状态**。`#compactQueryResult` 只保留
 *    `filters / count / truncated / explain / items`（外加可选的 `summary`），
 *    `sources` 与 `notes` 会被丢掉 —— 但"校规那一路这次没查成"是模型**必须**知道的事
 *    （否则它会把"没查成"说成"校规里没有这条规定"）。`summary` 是现成的扩展点：
 *    学业模块用它带学分绩，这里用它带三路状态。
 * 2. **条数默认取满 `aiQueryLimits.search`（12）**：模块在描述符里声明了 12，
 *    处理器不照着给就白声明了（投影那一步按 12 裁剪，给 10 条等于自己砍掉 2 条）。
 */

/** 与 module.js 的 `aiQueryLimits.search` 保持一致（只读查询回灌给模型的条数）。 */
export const AI_QUERY_LIMIT = 12;

export function createSearchCommands({ search }) {
  return {
    /**
     * 三路统一检索（只读）。
     *
     * `filters` 接受的键与 HTTP 接口同口径：q / scope / limit / perSource / course / noteIds。
     * 另外兼容 `query` / `keyword` 这两个模型爱写的别名（与 knowledge、memory 两个 target 一致）。
     */
    async query(draft) {
      const filters = draft?.filters ?? {};
      const result = await search.search({
        q: filters.q ?? filters.query ?? filters.keyword ?? '',
        scope: filters.scope,
        limit: filters.limit ?? AI_QUERY_LIMIT,
        perSource: filters.perSource,
        course: filters.course,
        noteIds: filters.noteIds ?? filters.ids,
        memoryStatus: filters.memoryStatus,
      });

      const hits = result.sources
        .filter((report) => report.queried && report.count)
        .map((report) => `${report.label} ${report.count} 条`);
      const broken = result.sources.filter((report) => report.queried && !report.available);

      // 空结果时直接用 notes[0]（它已经说清"三路都没命中"以及每条路各有多少条可查），
      // 别在这里再编一句更含糊的话
      let explain = result.count
        ? `统一检索命中 ${result.count} 条（合并去重后：${hits.join(' / ')}）。`
        : (result.notes[0] ?? `统一检索没有命中「${result.q}」。`);
      if (broken.length) {
        explain += ` 注意：${broken.map((report) => `${report.label}没查成（${report.error}）`).join('；')}。`;
      }

      return {
        filters,
        count: result.count,
        items: result.items,
        // 见文件头：`sources` 会被投影丢掉，所以用 summary 把三路状态一起送进上下文
        summary: {
          scope: result.scope,
          perSource: result.perSource,
          sources: result.sources,
          notes: result.notes,
          scoreNote: 'score 已跨源归一到 0~1（rawScore 在 meta 里），可以直接比较不同来源的相关性。',
        },
        explain,
      };
    },
  };
}
