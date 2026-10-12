/**
 * 统一检索的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种，不是对话里的只读草稿）看。
 *
 * 与 `module.js` 的 `aiPrompt` 分工一致（见 knowledge/tools.js 的同一段说明）：
 * - `aiPrompt` 是**对话模型**看的领域说明（它用 `target: "search"` 的只读查询草稿取数）；
 * - 这里的 `aiTools` 是**工具调用型 Agent** 看的接口契约，`GET /ai/capabilities` 会聚合，
 *   并自动补上 `module: "aisearch"`。
 * 两条通道的参数形状必须一致（q / scope / limit / course），否则模型按 A 学会的写法在 B 上会失败。
 *
 * `mutates: false` 是真的：本模块**一个字节都不写**（不落库、不广播、不建集合）——
 * 它只读另外三个模块的公开方法。Agent 可以放心重试与并发调用。
 *
 * 引用规则写在 description 里而不是留给 Agent 猜：一次查询会同时给出校规、用户笔记、
 * 用户长期记忆三种性质完全不同的内容，混淆它们（把"我笔记里写的"说成"学校规定"）
 * 是这条链路最危险的失败方式。
 */

export const AISEARCH_TOOLS = [
  {
    name: 'search_unified',
    description:
      '一次查询同时检索三路：教务处校规语料（148 篇）、用户自己的笔记、关于用户本人的长期记忆。' +
      '只读、不写数据、不联网。每条结果都带 source（knowledge = 校规语料 / note = 用户的笔记 / memory = 用户的长期记忆），' +
      'score 已跨源归一到 0~1 可直接比较，三路命中的同一篇内容已合并成一条（sources 里列出涉及的来源）。' +
      '用在"一个问题既涉及校规、又要看用户自己记过什么"的场景（"转专业要什么条件，顺便看看我记过什么"），' +
      '可以省下有限的只读查询额度；只查校规条款、只想读某条笔记全文、或要按 scope+key 精确定位记忆时，' +
      '仍应分别用 knowledge_search / notes_query / 记忆的查询。' +
      '引用规则：source=knowledge 的条目必须带 url 出处，语料里没有的如实说不知道，不许凭记忆编校规；' +
      'source=note 的条目要说明是"你的笔记里写的"；source=memory 的条目要说明是"你之前提过"。' +
      'sources[].error 非空 = 那一路这次没查成（例如语料还没抓取），不能当成"那一路里没有"。',
    method: 'GET',
    path: '/search',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: { q: 'string', scope: 'string?', limit: 'number?', perSource: 'number?', course: 'string?', noteIds: 'string?' },
    returns: { count: 'number', items: 'SearchHit[]', sources: 'SearchSourceReport[]', notes: 'string[]' },
  },
  {
    name: 'search_sources',
    description:
      '查看统一检索三路各自是否可用、一共有多少条（校规语料 148 篇 / 笔记 N 条 / 长期记忆 M 条），' +
      '只读、不检索具体内容。用在：回答"我能不能搜到校规"、界面显示数据规模、' +
      '以及检索结果异常（某一路 error 非空）时判断到底是哪一路出了问题 —— ' +
      'knowledge 的 available=false 通常意味着这台机器还没跑过 node scripts/crawl-dean.js。',
    method: 'GET',
    path: '/search/sources',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {},
    returns: { count: 'number', items: 'SearchSourceReport[]' },
  },
];
