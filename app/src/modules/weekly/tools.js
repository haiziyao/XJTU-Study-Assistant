/**
 * 学习周报的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种）看，
 * `GET /ai/capabilities` 会聚合各模块的 aiTools 并补上 `module` 字段。
 *
 * 为什么是两个工具、且一个 `mutates: false` 一个 `mutates: true`：
 *
 * - `weekly_report_get` 只读，标 `mutates: false` 是告诉 Agent **可以放心重试和轮询**；
 *   它还有一个重要性质要写进描述里：**没有缓存时它不会偷偷生成**（只返回 stats + hint）。
 *   否则 Agent 会以为"调 GET 就能拿到文章"，反复调用、每次都以为系统坏了。
 *
 * - `weekly_report_generate` 会**调用模型**（花 token），所以必须标 `mutates: true`
 *   并且把三件事讲清楚：① 同一周已有报告时命中缓存、不重复花；
 *   ② 未配置 AI 时返回的是 `fallback: true` 的规则小结，`ok` 仍是 true；
 *   ③ 要重写已有报告得带 `force: true`。
 *   把"会花钱"写在描述里，是 Agent 决定"要不要先问用户一句"的唯一依据。
 *
 * 参数形状必须与 `routes.js` 一致，否则模型按 A 学会的写法在 B 上会失败。
 */

export const WEEKLY_TOOLS = [
  {
    name: 'weekly_report_get',
    description:
      '读某一周的学习周报（聊了什么/写了哪些笔记/复习了多少卡片/目标与待办有什么变化）。只读，不写数据、不调用模型。' +
      '有已生成的报告就返回正文；没有则返回 `report: null` + `hint`，同时**照常给出这一周的现算统计**（stats）——' +
      '要生成报告必须用 weekly_report_generate。' +
      'from/to 都是 YYYY-MM-DD（本地日期）；都不传 = 本周（周一起算），只传一个 = 那一天所在的自然周；' +
      'stats 里为 null 的来源表示**没有数据**（如复习卡片/学习目标模块未装配），不是 0，也不要猜。',
    method: 'GET',
    path: '/weekly/report',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      from: 'string?（YYYY-MM-DD）',
      to: 'string?（YYYY-MM-DD，不得早于 from）',
    },
    returns: {
      cached: 'boolean（是否有已生成的报告）',
      report: 'string|null（简报正文）',
      fallback: 'boolean|null（正文是否由规则生成）',
      stats: 'object（区间统计，永远现算）',
      statsChangedSinceReport: 'boolean|null（正文生成后数据是否又变了）',
      hint: 'string|null',
    },
  },
  {
    name: 'weekly_report_generate',
    description:
      '**生成**某一周的学习周报（中文简报，≤400 字；会调用一次模型，消耗 token）。' +
      '同一周已经有报告时**直接返回缓存**（cached: true，不重复花）；要重写才传 force: true。' +
      '未配置 AI 密钥或模型调用失败时**不是错误**：返回 ok: true + fallback: true + reason，并给出规则生成的客观小结。' +
      '正文只依据 stats 里的数字；系统没有"学习时长/专注时长"数据源，报告里不会出现这类数字，你也不要向用户编造。',
    method: 'POST',
    path: '/weekly/report/generate',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      from: 'string?（YYYY-MM-DD）',
      to: 'string?（YYYY-MM-DD，不得早于 from）',
      force: 'boolean?（true = 忽略缓存重新生成；默认 false）',
    },
    returns: {
      ok: 'true',
      cached: 'boolean（命中缓存）',
      id: 'string',
      week: 'string（如 2026-W02）',
      stats: 'object',
      report: 'string',
      generatedAt: 'string（ISO）',
      model: 'string|null（降级时为 null）',
      fallback: 'boolean',
      reason: 'string|null（降级原因）',
    },
  },
];
