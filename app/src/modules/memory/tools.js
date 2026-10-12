/**
 * 记忆能力的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种）看，
 * `GET /ai/capabilities` 会把各模块的 aiTools 聚合起来并补上 `module` 字段。
 *
 * 为什么只有两个工具，而且两个都 `mutates: false`（§10.6 是硬规则）：
 *
 * - `memory_search` 只读检索 —— 标 `mutates: false` 是告诉 Agent 可以放心重试、并发调用；
 * - `memory_propose` **只产出草稿，一个字节都不落库**（§10.5 的 `writes: false`），
 *   所以它同样是 `mutates: false`。写错的偏好会静默污染之后每一次对话，而用户根本不知道
 *   它存在 —— 所以模型这条路**没有**直接写入的工具：用户确认后由 `/commands/execute`
 *   （target `memory`）落库。这不是漏了一个 `memory_write`，是刻意不给。
 *
 * 参数形状必须与 `routes.js` / `commands.js` 一致，否则模型按 A 学会的写法在 B 上会失败。
 */

export const MEMORY_TOOLS = [
  {
    name: 'memory_search',
    description:
      '检索用户本人的长期记忆（跨会话可复用的偏好 / 限制 / 事实 / 经历 / 取舍），只读、不写数据。' +
      '用在"你还记得…"、要针对某门课给建议、以及**提议之前先查重**：status 为 rejected 的同 scope+key ' +
      '是被用户否决过的负记忆，绝不能再提议；已经 active 且内容等价的也不要重复提议。' +
      'filters 支持 scope（global / course:<课程id> / module:<模块id>）、kind、status、key、q（关键词）、limit。' +
      '注意：每轮对话自动注入的只是预算内的一小部分（默认 ≤8 条 / 600 字），没被注入的要用这个工具查。',
    method: 'GET',
    path: '/memories',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      scope: 'string?',
      kind: 'string?（fact / preference / constraint / episodic / decision）',
      status: 'string?（active / superseded / archived / rejected，逗号分隔）',
      key: 'string?',
      q: 'string?',
      limit: 'number?（默认 50，上限 200）',
      offset: 'number?',
      dueReview: 'boolean?（只给到期待复核的）',
    },
    returns: { count: 'number', items: 'Memory[]' },
  },
  {
    name: 'memory_propose',
    description:
      '**提议**一条要长期记住的事（关于用户本人的事实/偏好/限制/取舍），返回草稿与冲突提示，' +
      '**不落库**（writes: false）。这是模型唯一的写入口：用户点确认后系统才真正保存；' +
      '你**绝不可以说"已经记住了"**。一轮对话最多提议 3 条；只提用户自己说过的事，不提推测。' +
      '有确切日期/时刻的安排（"明天下午三点开会"）要走日程或待办，不要提议成记忆；' +
      '校规、政策、课程安排这类**外部事实**也不是记忆（那是知识库）。' +
      '同 scope+key 已被否决（rejected）时接口会返回 draft: null + suppressed: "rejected"，此时不要再提。' +
      'text 写完整句、主语是用户、≤200 字，不要以"记住"开头、不要抄对话原文、不要写日期。',
    method: 'POST',
    path: '/memories/propose',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      scope: 'string?（默认 global）',
      kind: 'string?（默认 fact）',
      key: 'string?（稳定键，小写字母/数字/下划线，≤40）',
      text: 'string（必填，1~200 字）',
      value: 'object?（结构化值，如 {"from":"19:00"}）',
      sourceRef: 'object?（从哪学的，如 {"messageId":"m-183"}）',
      confidence: 'number?（0~1）',
    },
    returns: { draft: 'CommandDraft|null', conflicts: 'Memory[]', writes: 'false' },
  },
];
