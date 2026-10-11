/**
 * AI 模块暴露给 Agent 的工具清单（会被聚合进 `GET /ai/capabilities` 的 `aiTools`）。
 *
 * 这份清单刻意很短：对话本身不该被当成"工具"（那等于让 Agent 自己跟自己说话），
 * 真正对外有用的是**上下文**——主程序每轮对话前先拿它，才知道今天几号、用户有什么偏好。
 * 记忆模块落地后（接口文档 §10.9），`memory_search / memory_write / memory_forget`
 * 会由那个模块自己声明，仍不需要改这里。
 */

export const AI_TOOL_SPECS = [
  {
    name: 'ai_context_get',
    description:
      '取「给模型的上下文」：预算内的长期记忆 + 今天日期与星期 + 近期数据摘要（未完成/逾期待办、今天日程与事件）。Agent 每轮对话开头先调它，不要自己猜日期与数量',
    method: 'GET',
    path: '/ai/context',
    requiresAuth: false,
    mutates: false,
    params: {
      view: 'string?（当前视图 id，如 calendar / todo / lms，用于挑选相关记忆）',
      module: 'string?（当前模块 id，如 calendar）',
      courseId: 'number?（对话涉及某门课时传，用于取出该课的记忆）',
      maxItems: 'number?（注入条数上限，默认 8）',
      maxChars: 'number?（注入字符上限，默认 600）',
    },
  },
  {
    name: 'ai_conversation_list',
    description: '列出本地对话会话（按最后一条消息时间倒序），用于"继续上次那件事"这类跨会话操作',
    method: 'GET',
    path: '/ai/conversations',
    requiresAuth: false,
    mutates: false,
    params: {},
  },
];
