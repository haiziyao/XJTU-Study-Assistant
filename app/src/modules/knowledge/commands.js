/**
 * 只读目标 `knowledge` 的指令处理器。
 *
 * 对话里的模型用一条 `{"action":"query","target":"knowledge","filters":{"q":"转专业 条件"}}`
 * 草稿来取用政策语料；`chat-service` 的 `#runReadOnlyQueries` 会用 `dryRun: true` 执行它，
 * 结果再回灌给模型 —— 所以这里**只读**，不提供任何写动作（知识库的写入是"跑抓取脚本"，
 * 不是模型能在对话里做的事）。
 *
 * 返回结构与其它模块一致：`{ filters, count, items, explain }`（外加可选的 summary）。
 * 每条 item 都带 `url` 与 `snippet`：模型据此引用，前端据此画卡片。
 */

export function createKnowledgeCommands({ knowledge }) {
  return {
    query(draft) {
      const filters = draft?.filters ?? {};
      const result = knowledge.search({
        q: filters.q ?? filters.keyword ?? filters.query ?? '',
        category: filters.category ?? filters.categorySlug ?? '',
        path: filters.path ?? '',
        limit: filters.limit,
      });

      // 命中 0 条时把话说清楚：是"语料里没有"而不是"系统坏了"——
      // 模型看到这句才会如实说"手册里没写"，而不是回去编（见 §14.5 的硬规则）
      const explain = result.count
        ? `命中 ${result.count} 篇（${result.items.map((item) => item.category).filter((v, i, a) => a.indexOf(v) === i).join('、')}）。`
        : result.available === false
          ? '知识库语料还没就绪（没跑过 node scripts/crawl-dean.js）。'
          : `知识库里没有匹配「${result.q}」的篇目。`;

      return {
        filters,
        count: result.count,
        items: result.items,
        explain,
      };
    },
  };
}
