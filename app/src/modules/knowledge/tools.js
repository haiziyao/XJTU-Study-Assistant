/**
 * 知识库能力的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种，不是对话里的只读草稿）看。
 *
 * 为什么和 `aiPrompt` 同时存在、各管一段：
 * - `module.js` 的 `aiPrompt` 是**对话模型**看的领域说明（它通过 `target: knowledge`
 *   的只读查询草稿取语料，见 §14.5）；
 * - 这里的 `aiTools` 是**工具调用型 Agent** 看的接口契约（`GET /ai/capabilities` 会把
 *   各模块的 aiTools 聚合起来并补上 `module` 字段）。
 * 两者是同一份语料的两条取用通道，参数形状必须一致，否则模型按 A 学会的写法在 B 上会失败。
 *
 * 约定（与 lms/tools.js、academic/module.js 保持一致）：
 * - `path` 是相对 API 前缀的路径（形如 `/knowledge/search`）；
 * - `mutates: false` —— 知识库对外**只有读**：语料的写入是"用户显式跑
 *   `node scripts/crawl-dean.js`"，不是 Agent 能在请求里做的事（§14.3 明确不提供抓取接口）。
 *   标出来是为了让 Agent 放心重试、并发调用，不必像对待写接口那样先预览再确认；
 * - `implemented: true` —— 这两条接口是真的写完了的；标 false 会让 Agent 以为不能用；
 * - `requiresAuth: false` —— 语料在本地仓库里，不依赖学校登录态（这也是它比成绩接口
 *   更可靠的原因：教务处改版不会让它失效）。
 *
 * 语料里的 `kind` 是 `portal` / `attachments` / `external-links` 的篇目**没有可检索正文**
 * （正文在图片或附件里），只能按标题命中。这个事实写在 description 里而不是藏起来：
 * Agent 拿到这类命中时应该告诉用户"原文见此链接"，而不是照着标题编内容。
 */

export const KNOWLEDGE_TOOLS = [
  {
    name: 'knowledge_search',
    description:
      '检索本地教务处政策/规章/校历语料（148 篇：学籍管理、课程考核、学业预警、毕业学位、培养方案、校历与作息时间等），' +
      '只读、不写数据、不联网。**具体条款优先用它**：问"挂几科会被退学""转专业要绩点多少""补考怎么算"这类' +
      '具体条款 / 数字 / 条件时，先用 q 关键词检索命中片段（默认约 800 字，含命中位置附近原文与 offset），' +
      '不要一上来按篇目整篇读；片段不够再用 knowledge_doc 的 offset 续读，或传 section 精确到小节。' +
      '每条结果都带来源 url，引用校规必须带这个 url；语料里没有的要如实说不知道，不许凭记忆编校规。' +
      'kind 为 portal / attachments / external-links 的篇目没有可检索正文（正文在附件或图片里），' +
      '只能回复"原文见此链接"。',
    method: 'GET',
    path: '/knowledge/search',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    // 与服务层一致：q 必填（空白 → 400），limit 缺省 5、夹在 1~10；section 精确到章/条
    params: { q: 'string', category: 'string?', section: 'string?', limit: 'number?' },
    returns: { count: 'number', items: 'KnowledgeHit[]' },
  },
  {
    name: 'knowledge_doc',
    description:
      '按 knowledge_search 返回的 path 读取某一篇教务处政策原文（只读、不联网），' +
      '返回正文窗口（HTTP 默认前 8000 字）与来源 url、栏目、发布日期、kind，' +
      '并带 offset / nextOffset / truncated / totalChars：窗口没给全时用 offset=nextOffset 继续读，' +
      '不要以为原文只有 8000 字。用在已经检索定位到具体篇目、需要引用条款原文或续读的时候；' +
      '具体条款优先先用 knowledge_search，不要一上来整篇 read —— 整篇读也只能拿到一个窗口，' +
      '关键条款可能在第 8000 字之后。path 必须落在语料目录内，越界（含 ..）会被拒。',
    method: 'GET',
    path: '/knowledge/doc',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    // maxChars 缺省 8000（HTTP 契约，交给服务层显式指定）；offset 从第 N 字续读
    params: { path: 'string', maxChars: 'number?', offset: 'number?' },
    returns: { title: 'string', url: 'string', content: 'string', offset: 'number', nextOffset: 'number|null', truncated: 'boolean', totalChars: 'number' },
  },
];
