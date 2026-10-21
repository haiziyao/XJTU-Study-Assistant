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
      /**
       * `path` 与 `url` 都当"点名读这一篇"。
       *
       * 为什么 url 也得认：模型手里最容易攥着的是**它已经引用过的出处**（结果里的 url 字段），
       * 用户看到的"来源"也是 url。实测它就是这样发查询的，而以前只有 HTTP 的
       * `/knowledge/doc` 认 url、对话这条通道不认 —— 于是它明明点名了却只拿到 240 字片段
       * （"这一页正文读到第三条就断了"），关键的 12/8/4 学分阈值全在片段后面。
       * 服务层的 `read()` 本来就认 url（含 URL 路径片段），这一层不该再拦一道。
       */
      const requestedPath = filters.path ?? filters.url ?? '';
      const wantedSection = String(filters.section ?? filters.sectionTitle ?? '').trim();
      const result = knowledge.search({
        q: filters.q ?? filters.keyword ?? filters.query ?? '',
        category: filters.category ?? filters.categorySlug ?? '',
        path: requestedPath,
        limit: filters.limit,
        // 续读：模型从检索结果的 `offset` / `nextOffset` 拿到位置后，下一轮直接传回来。
        // 不传时行为不变（片段 / 从第 0 字读），所以老提示词也不会被破坏。
        offset: filters.offset ?? filters.fromOffset ?? 0,
        // 精确到小节：例如「第六章 退学警告与退学」「第二十七条」。
        section: wantedSection,
        // 允许模型一次多要一点正文；上限仍由服务层夹紧（路由层另有 500~20000 的约束）。
        pathMaxChars: filters.maxChars ?? filters.pathMaxChars,
      });

      const doc = result.items?.[0];
      const sectionName = typeof doc?.section === 'object' ? doc.section.title : typeof doc?.section === 'string' ? doc.section : '';
      // 命中 0 条时把话说清楚：是"语料里没有"而不是"系统坏了"——
      // 模型看到这句才会如实说"手册里没写"，而不是回去编（见 §14.5 的硬规则）。
      // 点名读一篇（count 1 且有 content）时说清"给的是正文还是片段"：模型据此才知道
      // 自己能不能读出条款里的数字，以及 truncated 时该不该承认"只读到一部分"。
      const explain = result.count
        ? requestedPath && doc?.content !== undefined
          ? `已读取《${doc.title}》${sectionName ? `「${sectionName}」` : '正文'}` +
            `第 ${doc.offset}–${doc.offset + doc.content.length} 字（原文共 ${doc.totalChars} 字` +
            `${doc.truncated ? `，**本次窗口没给全**：用 filters.offset=${doc.nextOffset} 继续读` : '，这一节/这一篇已给全'}）。` +
            (doc.matchOffset !== undefined ? `命中位置在第 ${doc.matchOffset} 字。` : '') +
            '这是检索到的条款原文，引用时请带 url 与小节名。'
          : `命中 ${result.count} 篇（${result.items.map((item) => item.category).filter((v, i, a) => a.indexOf(v) === i).join('、')}）。` +
            `每条给的是「检索到的条款原文」片段（约 800 字，命中位置附近），不是全文；` +
            '要读条款原文就用结果里的 path + offset 续读（或带 section 精确到小节），不要整篇 read。'
        : result.available === false
          ? '知识库语料还没就绪（没跑过 node scripts/crawl-dean.js）。'
          : requestedPath && wantedSection
            ? `《${result.title ?? result.path}》里没有找到小节「${wantedSection}」；换一个 section 名（如“第六章 退学警告与退学”“第二十七条”），或改用 filters.q 关键词检索。`
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
