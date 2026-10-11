/**
 * 日历与待办能力的「工具清单」。
 *
 * 这一层是给 AI Agent 用的接口契约：每个工具都对应一个已实现的 HTTP 接口，
 * 名字、参数、返回值形状固定下来，模型只需要学会调用这些工具，不需要了解
 * 存储布局、重复规则展开、冲突检测这些细节。
 *
 * 约定（与 modules/lms/tools.js 一致）：
 * - `path` 是相对 API 前缀的路径（形如 `/todos`）；`{id}` 是路径参数，调用时替换；
 * - `requiresAuth` 为 true 的工具必须先登录 —— 日历是本地数据，全部为 false；
 * - `mutates` 为 true 的工具会写数据，Agent 调用前应先让用户确认（可用 `dryRun` 的工具优先预览）。
 *
 * 三件事，三个集合（**选错集合用户就看不见东西**）：
 * - **待办** `Todo`：只有截止日 + 完成态。「完成」只属于它 → `/todos`；
 * - **日程** `Schedule`：必须是时段（`startTime` 必填），没有完成态 → `/schedules`；
 * - **日历事件** `Event`：日期 / 日期区间粒度，没有完成态 → `/events`。
 */

export const CALENDAR_TOOL_SPECS = [
  // ---------------------------------------------------------------- 读
  {
    name: 'calendar_range',
    description:
      '按日期区间读日历：每一天的事件、时段日程、当天截止的待办（含重复展开），以及导入桶（externalId 的日期锚点，只读）',
    method: 'GET',
    path: '/calendar',
    requiresAuth: false,
    mutates: false,
    params: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD（不能早于 from，区间上限 400 天）' },
  },
  {
    name: 'calendar_todo_list',
    description:
      '查待办：只有截止日、完成态、预估工时、优先级。带 isOverdue / isToday / daysRemaining / complexity 等派生字段，并返回 stats',
    method: 'GET',
    path: '/todos',
    requiresAuth: false,
    mutates: false,
    params: {
      date: 'YYYY-MM-DD?（截止日 = 该日）',
      from: 'YYYY-MM-DD?',
      to: 'YYYY-MM-DD?',
      completed: 'boolean?（true 只看已完成，false 只看未完成）',
      priority: '0|1|2?（0 低 / 1 普通 / 2 紧急）',
      overdue: 'boolean?（true = 未完成且已过期）',
      keyword: 'string?',
      limit: 'number?',
    },
  },
  {
    name: 'calendar_todo_upcoming',
    description: '接下来要做的待办：未完成 + 按截止日升序，用于「最近有什么要交」这类回答',
    method: 'GET',
    path: '/todos/upcoming',
    requiresAuth: false,
    mutates: false,
    params: { limit: 'number?（缺省 50）' },
  },
  {
    name: 'calendar_schedule_list',
    description:
      '查时段日程（上课 / 开会 / 自习）。日程必须有 startTime，**没有完成态**；只有日期的条目是待办，请用 calendar_todo_list',
    method: 'GET',
    path: '/schedules',
    requiresAuth: false,
    mutates: false,
    params: {
      date: 'YYYY-MM-DD?',
      from: 'YYYY-MM-DD?',
      to: 'YYYY-MM-DD?',
      category: 'class|study|meeting|exam|activity|other?',
      priority: '0|1|2?',
      keyword: 'string?',
      limit: 'number?',
    },
  },
  {
    name: 'calendar_event_list',
    description: '按日期区间/分类/关键词查日历事件（假期、考试周、纪念日这类日期粒度记录）',
    method: 'GET',
    path: '/events',
    requiresAuth: false,
    mutates: false,
    params: {
      from: 'YYYY-MM-DD?',
      to: 'YYYY-MM-DD?',
      category: 'study|exam|holiday|anniversary|deadline|other?',
      keyword: 'string?',
      limit: 'number?',
    },
  },
  {
    name: 'calendar_stats',
    description: '区间日程统计：条数与计划时长（日程没有完成率；完成率看待办的 stats）',
    method: 'GET',
    path: '/schedules/stats',
    requiresAuth: false,
    mutates: false,
    params: { from: 'YYYY-MM-DD?', to: 'YYYY-MM-DD?' },
  },

  // ---------------------------------------------------------------- 写：待办
  {
    name: 'calendar_todo_create',
    description: '新建待办（只有截止日、没有时刻的东西都属于这里，例如「明天交实验报告」）',
    method: 'POST',
    path: '/todos',
    requiresAuth: false,
    mutates: true,
    params: {
      title: 'string（≤120，必填）',
      deadline: 'YYYY-MM-DD（必填，截止日）',
      estimatedHours: 'number?（预估工时，默认 1；≤1 简单 / ≤3 一般 / ≤10 复杂 / >10 繁琐）',
      priority: '0|1|2?（默认 0 低）',
      description: 'string?',
      tags: 'string[]?',
    },
  },
  {
    name: 'calendar_todo_update',
    description: '局部更新一条待办（只传要改的字段）',
    method: 'PATCH',
    path: '/todos/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', '…': '同 calendar_todo_create 的字段，均可选' },
  },
  {
    name: 'calendar_todo_complete',
    description: '勾选 / 取消勾选待办（写或清 completedAt）。「完成」只属于待办：日程与日历事件都没有完成态',
    method: 'POST',
    path: '/todos/{id}/completed',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', completed: 'boolean（必填，true 完成 / false 取消完成）' },
  },
  {
    name: 'calendar_todo_delete',
    description: '删除一条待办',
    method: 'DELETE',
    path: '/todos/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）' },
  },
  {
    name: 'calendar_todo_rollover',
    description:
      '顺延：把未完成且截止日早于目标周一的待办，挪到目标周的同一星期几（该日已过则落到周一），并记录 rolledFrom',
    method: 'POST',
    path: '/todos/rollover',
    requiresAuth: false,
    mutates: true,
    params: { weekStart: 'YYYY-MM-DD?（必须是周一，缺省本周一）' },
  },

  // ---------------------------------------------------------------- 写：日程
  {
    name: 'calendar_schedule_create',
    description: '新建时段日程（上课 / 开会 / 自习）。startTime 必填；只有日期的条目请用 calendar_todo_create',
    method: 'POST',
    path: '/schedules',
    requiresAuth: false,
    mutates: true,
    params: {
      title: 'string（≤120，必填）',
      date: 'YYYY-MM-DD（必填，重复日程为首发日）',
      startTime: 'HH:mm（必填）',
      endTime: 'HH:mm?（须 ≥ startTime，不支持跨零点）',
      category: 'class|study|meeting|exam|activity|other?',
      priority: '0|1|2?（默认 1）',
      description: 'string?',
      location: 'string?',
      estimatedMinutes: 'number?',
      reminders: 'Reminder[]?（最多 5 条）',
      repeat: 'Repeat?（默认 { type: "none" }）',
    },
  },
  {
    name: 'calendar_schedule_update',
    description: '局部更新一条日程（只传要改的字段；日程没有 status，别传）',
    method: 'PATCH',
    path: '/schedules/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', '…': '同 calendar_schedule_create 的字段，均可选' },
  },
  {
    name: 'calendar_schedule_delete',
    description: '删除一条日程',
    method: 'DELETE',
    path: '/schedules/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）' },
  },

  // ---------------------------------------------------------------- 写：日历事件
  {
    name: 'calendar_event_create',
    description: '新建日历事件（日期或日期区间粒度，例如考试周、假期、截止日）',
    method: 'POST',
    path: '/events',
    requiresAuth: false,
    mutates: true,
    params: {
      title: 'string（≤120，必填）',
      startDate: 'YYYY-MM-DD（必填）',
      endDate: 'YYYY-MM-DD?（含当天，缺省等于 startDate）',
      category: 'study|exam|holiday|anniversary|deadline|other?',
      description: 'string?',
      repeat: 'Repeat?',
      tags: 'string[]?',
    },
  },
  {
    name: 'calendar_event_update',
    description: '局部更新一个日历事件',
    method: 'PATCH',
    path: '/events/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', '…': '同 calendar_event_create 的字段，均可选' },
  },
  {
    name: 'calendar_event_delete',
    description: '删除一个日历事件',
    method: 'DELETE',
    path: '/events/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）' },
  },

  // ---------------------------------------------------------------- 自然语言入口
  {
    name: 'calendar_command_parse',
    description: '把一句中文变成指令对象（不落库，供确认后再执行）',
    method: 'POST',
    path: '/commands/parse',
    requiresAuth: false,
    mutates: false,
    params: { text: 'string（必填，例如「明天 15:00 开会」「明天 交实验报告」）' },
  },
  {
    name: 'calendar_command_run',
    description: '一句话直达：解析并执行（dryRun 时只预览不写库）',
    method: 'POST',
    path: '/commands/run',
    requiresAuth: false,
    mutates: true,
    params: { text: 'string（必填）', dryRun: 'boolean?（默认 false）' },
  },
];
