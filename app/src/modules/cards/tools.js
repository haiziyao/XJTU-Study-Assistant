/**
 * 卡片能力的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种）看，
 * `GET /ai/capabilities` 会把各模块的 aiTools 聚合起来并补上 `module` 字段。
 *
 * 与 memory 模块（两个工具、全都 `mutates: false`）的关键区别：
 * 卡片**允许模型直接写**，所以这里如实标 `mutates: true` 并逐条写清后果。
 * 判断依据是"写错了会怎样"：
 * - 写错一条长期记忆 → 静默污染之后每一次对话，而用户根本不知道它存在 → 只能提议；
 * - 写错一张卡片 / 记错一次评分 → 用户下次复习时看得见（正面就在屏幕上），
 *   删掉或改一次就恢复了，且排期错误只影响这一张卡 → 可以写，但必须让权限层
 *   （auto / manual / strict）有据可依，所以 `mutates` 不能标错。
 *
 * 参数形状必须与 `routes.js` / `commands.js` 一致，否则模型按 A 学会的写法在 B 上会失败。
 */

export const CARD_TOOLS = [
  {
    name: 'cards_query',
    description:
      '按条件只读检索复习卡片，返回正面、答案与调度状态（due / intervalDays / reps / lapses / suspended）。' +
      '用在"我有哪些卡片""这门课有多少卡"；filters 支持 due（只看现在到期的）、course、tag、noteId、' +
      'suspended、q（关键词）、limit、offset。返回值里的 counts 是整个库的统计，不受筛选影响。' +
      '注意：这只读卡片本身，**不代表用户复习过** —— 不许把它说成"已经帮你复习了"。',
    method: 'GET',
    path: '/cards',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      due: 'boolean?（1 只看现在到期、0 只看未到期）',
      course: 'string?',
      tag: 'string?',
      noteId: 'string?',
      suspended: 'boolean?（1 只看已暂停）',
      q: 'string?',
      limit: 'number?（默认 50，上限 500）',
      offset: 'number?',
    },
    returns: { count: 'number', counts: '{total,due,suspended,todayReviewed}', items: 'Card[]', filters: 'object' },
  },
  {
    name: 'cards_due',
    description:
      '只读「现在到期的卡片」快捷队列（等价于 /cards?due=1，已排除暂停的），按到期时间升序。' +
      '回答"今天该复习什么 / 还有几张卡"时用它；只要 5 张就带 limit=5，' +
      'count 仍然是这次筛选下的**全部**到期数（不要拿 items.length 当成总数）。',
    method: 'GET',
    path: '/cards/due',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: { limit: 'number?（默认 50）', offset: 'number?' },
    returns: { count: 'number', counts: 'object', items: 'Card[]' },
  },
  {
    name: 'cards_create',
    description:
      '新建一张卡片（正面/问题 + 答案）。写操作。一张卡只问一个知识点：front ≤500 字、back ≤2000 字。' +
      '有确切时间位置的安排（"明天交作业"）不是卡片，那是待办/日程；' +
      '整段笔记也不该直接当答案，先用 cards_generate 或拆成几张卡。',
    method: 'POST',
    path: '/cards',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      front: 'string（必填，≤500 字）',
      back: 'string（必填，≤2000 字）',
      noteId: 'string?（来自哪条笔记）',
      course: 'string?',
      tags: 'string[]?',
      source: 'string?（manual / ai / note，默认 manual）',
    },
    returns: { item: 'Card' },
  },
  {
    name: 'cards_generate',
    description:
      '从笔记生成卡片：规则化抽取（**不调模型**），把"标题+内容""冒号/问号行+下一行""列表项+子项"转成卡片。' +
      '写操作，但**幂等**：按 noteId+正面去重，同一篇笔记重复调用返回 created:0 / skipped:N，' +
      '不会产生重复卡。body 给 noteId（指定一篇）或 query（按关键词选笔记，支持 tag:/folder: 语法）。' +
      '返回的 items 里每条都带 rule（heading / colon / question / list），可以告诉用户"这张卡从哪来"。',
    method: 'POST',
    path: '/cards/generate',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      noteId: 'string?（与 query 二选一）',
      query: 'string?（笔记检索词）',
      limit: 'number?（最多扫几篇笔记，默认 5，上限 20）',
    },
    returns: { created: 'number', skipped: 'number', ignored: 'number', notes: 'number', items: 'Card[]' },
  },
  {
    name: 'cards_review',
    description:
      '记录**一次**复习的评分并推进这张卡的排期（写操作，SM-2 简化版）：' +
      'again（忘了，间隔归零、当天再来）/ hard（吃力，间隔小幅增长）/ good（记得，标准增长）/ easy（太简单，更长间隔）。' +
      '**grade 必须来自用户自己**：用户说"记住了 / 忘了 / 太简单了"才调用；' +
      '你没有资格替他评价掌握程度，缺 grade 会被 400 拒绝。调用成功后只能说"已记录这次复习，下次 X 天后再见"，' +
      '**绝不能说"你已经掌握了"**。',
    method: 'POST',
    path: '/cards/:id/review',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { id: 'string（路径参数）', grade: 'string（again / hard / good / easy，必填）' },
    returns: { item: 'Card', nextDue: 'string', scheduled: 'object', explain: 'string' },
  },
];
