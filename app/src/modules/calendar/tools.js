/**
 * 日历与待办能力的「工具清单」。
 *
 * 这一层是给 AI Agent 用的接口契约：每个工具都对应一个已实现的 HTTP 接口，
 * 名字、参数、返回值形状固定下来，模型只需要学会调用这些工具，不需要了解
 * 存储布局、重复规则展开、冲突检测这些细节。
 *
 * 约定（与 modules/lms/tools.js 一致）：
 * - `path` 是相对 API 前缀的路径（形如 `/schedules`）；`{id}` 是路径参数，调用时替换；
 * - `requiresAuth` 为 true 的工具必须先登录 —— 日历是本地数据，全部为 false；
 * - `mutates` 为 true 的工具会写数据，Agent 调用前应先让用户确认（可用 `dryRun` 的工具优先预览）。
 *
 * 集合归属（重要，改错集合用户就看不见东西）：
 * - **日历事件** `Event`：日期 / 日期区间粒度（假期、考试周、纪念日）→ `/events`；
 * - **日程 + 待办** `Schedule`：时段粒度；没有时刻时退化为全天（`date` + `allDay` + `status`），
 *   也就是界面上的「待办」→ `/schedules`。待办列表只读 schedules 集合。
 */

export const CALENDAR_TOOL_SPECS = [
  // ---------------------------------------------------------------- 读
  {
    name: 'calendar_range',
    description: '按日期区间读日历：每一天的事件与日程实例（含重复展开），周/月视图用',
    method: 'GET',
    path: '/calendar',
    requiresAuth: false,
    mutates: false,
    params: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD（不能早于 from，区间上限 400 天）' },
  },
  {
    name: 'calendar_schedule_list',
    description: '按日期/区间/状态/关键词查日程与待办（待办 = status pending 的全天日程）',
    method: 'GET',
    path: '/schedules',
    requiresAuth: false,
    mutates: false,
    params: {
      date: 'YYYY-MM-DD?',
      from: 'YYYY-MM-DD?',
      to: 'YYYY-MM-DD?',
      status: 'pending|done|cancelled|rolled?（可逗号分隔）',
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
    description: '区间日程统计：总数、完成率、计划时长，用于「这周忙不忙」这类总结',
    method: 'GET',
    path: '/schedules/stats',
    requiresAuth: false,
    mutates: false,
    params: { from: 'YYYY-MM-DD?', to: 'YYYY-MM-DD?' },
  },

  // ---------------------------------------------------------------- 写：日程 / 待办
  {
    name: 'calendar_schedule_create',
    description: '新建日程；不传起止时刻则为全天（即待办）。响应附带同时间段冲突提示',
    method: 'POST',
    path: '/schedules',
    requiresAuth: false,
    mutates: true,
    params: {
      title: 'string（≤120，必填）',
      date: 'YYYY-MM-DD（必填，重复日程为首发日）',
      startTime: 'HH:mm（非全天必填）',
      endTime: 'HH:mm?（须 ≥ startTime，不支持跨零点）',
      allDay: 'boolean?（默认 false；true 时忽略起止时刻）',
      status: 'pending|done|cancelled?（默认 pending）',
      priority: '0|1|2?（默认 1）',
      category: 'class|study|meeting|exam|activity|other?',
      description: 'string?',
      location: 'string?',
      estimatedMinutes: 'number?',
      reminders: 'Reminder[]?（最多 5 条）',
      repeat: 'Repeat?（默认 { type: "none" }）',
    },
  },
  {
    name: 'calendar_schedule_update',
    description: '局部更新一条日程（只传要改的字段）',
    method: 'PATCH',
    path: '/schedules/{id}',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', '…': '同 calendar_schedule_create 的字段，均可选' },
  },
  {
    name: 'calendar_schedule_complete',
    description: '把日程/待办标记为完成（或其它状态），「完成今天的作业」走这里',
    method: 'POST',
    path: '/schedules/{id}/status',
    requiresAuth: false,
    mutates: true,
    params: { id: 'string（路径参数）', status: 'pending|done|cancelled（必填，通常 done）' },
  },
  {
    name: 'calendar_schedule_rollover',
    description: '把未完成的日程顺延到指定周的周一（原记录置 rolled 并记 rolledTo）',
    method: 'POST',
    path: '/schedules/rollover',
    requiresAuth: false,
    mutates: true,
    params: { weekStart: 'YYYY-MM-DD?（必须是周一，缺省本周一）', from: 'YYYY-MM-DD?（只顺延这一天及之后的）' },
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
    params: { text: 'string（必填，例如「明天 15:00 开会」）' },
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
