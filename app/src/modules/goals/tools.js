/**
 * 目标能力的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种）看，
 * `GET /ai/capabilities` 会把各模块的 aiTools 聚合起来并补上 `module` 字段。
 *
 * `mutates` 如实标注（这是这份清单唯一的硬要求）：
 *   - 只读工具（查询 / 概览 / 预警 / 读目标学分绩）标 `mutates: false`，Agent 可以放心重试与并发；
 *   - 写工具（新建 / 更新 / 删除 / 推进度 / 设目标学分绩）标 `mutates: true`，
 *     Agent 必须先说明再执行，且不要把 `delete` 与别的写操作打包成一次"顺手清理"。
 *
 * 参数形状必须与 `routes.js` / `commands.js` 一致，否则模型按 A 学会的写法在 B 上会失败。
 * `path` 都是**相对 `/api/v1`** 的（与其它模块的工具清单同一约定）。
 */

export const GOAL_TOOLS = [
  {
    name: 'goals_overview',
    description:
      '★ 「接下来要面对什么」：把本模块的目标/截止/考试、日历里未完成的待办、日历事件（考试周、报名截止）' +
      '合成一条按严重度排好序的清单。回答"我最近有什么要交的""接下来要准备什么""我是不是快来不及了"用它，' +
      '不要分别去查 todo 和 event 再自己合并（排序与口径会不一致）。' +
      'severity 只由天数决定：overdue（已逾期）/ urgent（今天或明天）/ soon（7 天内）/ later。' +
      '返回里的 gpa 是"当前学分绩（来自学业模块的真实数据）vs 用户自己填的目标学分绩"，' +
      'disclaimer 明确写了**不是学校公布的保研线** —— 复述时必须带上这个限定，绝不许换算成保研概率或预测分数。' +
      '学业模块没数据时 gpa.current 为 null 且带 reason，那是正常降级，不要当成错误去解释。',
    method: 'GET',
    path: '/goals/overview',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      days: 'number?（未来窗口天数，默认 30，上限 365；逾期项永远包含）',
      limit: 'number?（返回条数上限，默认 50，上限 500）',
      includeDone: 'boolean?（默认 false，只看进行中的）',
      course: 'string?（只看某门课；待办没有课程字段，因此不受它过滤）',
    },
    returns: {
      days: 'number',
      from: 'string（YYYY-MM-DD）',
      to: 'string',
      count: 'number',
      summary: 'object（overdue / urgent / dueWithin7Days / dueWithin30Days / attention / next）',
      sources: 'object（goals / todos / events 各自条数）',
      gpa: 'object|null（current / target / gap / source / reason / disclaimer）',
      disclaimer: 'string（恒为「目标是用户自己填的，不是学校公布的保研线」）',
      items: 'OverviewRow[]（source / id / title / date / daysLeft / overdue / severity / kind / course）',
    },
  },
  {
    name: 'goals_alerts',
    description:
      '预警精简版：只给未来 N 天内与已逾期的条目，字段少而够用，供定时唤醒 / 首页横幅使用。' +
      '`attention` 是命中**用户自己设的** remindDays 阈值的那几条 —— 决定要不要打扰用户时以它为准，' +
      '不要自己另定一个"7 天内就算紧急"的规则（用户的阈值就是他自己的偏好）。',
    method: 'GET',
    path: '/goals/alerts',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: { days: 'number?（默认 7，上限 90）' },
    returns: { count: 'number', summary: 'object', attention: 'array', items: 'array', disclaimer: 'string' },
  },
  {
    name: 'goals_list',
    description:
      '列出目标（长期目标 goal / 一次性截止 deadline / 考试 exam）。每条带 daysLeft、severity、' +
      '进度与里程碑完成度。filters 支持 status（active/done/archived）、kind、course、q（标题/备注/课程关键词）。' +
      '要"接下来要面对什么"请用 goals_overview（它还会合上待办与事件）。',
    method: 'GET',
    path: '/goals',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      status: 'string?（active / done / archived，逗号分隔）',
      kind: 'string?（goal / deadline / exam，逗号分隔）',
      course: 'string?',
      q: 'string?',
      limit: 'number?（默认 50，上限 500）',
      offset: 'number?',
    },
    returns: { count: 'number', counts: 'object', items: 'Goal[]', filters: 'object' },
  },
  {
    name: 'goals_get',
    description: '取一条目标的完整字段（含里程碑明细）。',
    method: 'GET',
    path: '/goals/{id}',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: { id: 'string' },
    returns: { item: 'Goal（含 daysLeft / severity / milestoneDone / milestoneTotal）' },
  },
  {
    name: 'goals_create',
    description:
      '新建一条目标（写操作）。**只在用户明确说要长期跟踪某件事时用**：' +
      '有确切日期与时刻的安排走日程，单日要交的一件事走待办（POST /todos），跨天的日期区间走事件。' +
      '目标是"一个方向 + 一个较远的目标日 + 可能分几步"（考研、保研、绩点目标、竞赛、证书）。' +
      'kind 必选其一：goal（长期方向）/ deadline（一次性截止）/ exam（考试）；' +
      'targetDate 必填（没有目标日就没有倒计时，不要把今天当默认值塞进去）；' +
      'remindDays 缺省 [7,3,1]，除非用户说了"提前一个月提醒我"否则别改。',
    method: 'POST',
    path: '/goals',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      title: 'string（必填，≤120 字）',
      kind: 'string?（goal 默认 / deadline / exam）',
      targetDate: 'string（必填，YYYY-MM-DD）',
      course: 'string?（课程名，可空）',
      progress: 'number?（0~100；不确定就留空，不要填 0）',
      milestones: 'array?（[{ title, due?, done? }]）',
      priority: 'number?（0 普通 / 1 重要 / 2 紧急）',
      note: 'string?',
      remindDays: 'number[]?（提前几天预警，默认 [7,3,1]，取值 1~60）',
      status: 'string?（active 默认 / done / archived）',
    },
    returns: { item: 'Goal' },
  },
  {
    name: 'goals_update',
    description:
      '局部更新一条目标（写操作）：只传要改的字段。把 status 改成 done 会把进度补到 100。' +
      '**改状态前要让用户确认** —— "我考完了"和"我不想考了"都会被人说成"这个不用管了"。',
    method: 'PATCH',
    path: '/goals/{id}',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      id: 'string',
      title: 'string?',
      kind: 'string?',
      targetDate: 'string?',
      course: 'string?',
      progress: 'number?',
      milestones: 'array?',
      priority: 'number?',
      note: 'string?',
      remindDays: 'number[]?',
      status: 'string?',
    },
    returns: { item: 'Goal' },
  },
  {
    name: 'goals_progress',
    description:
      '推进度 / 勾里程碑（写操作）。三选一或组合：progress（直接给 0~100）、delta（相对增减，如 +10）、' +
      'milestoneId + done（勾选某一步，勾完最后一步会自动把进度补到 100）。' +
      '**不要**因为里程碑全勾完就替用户把 status 改成 done —— 步骤做完不等于目标达成（例如六级单词背完还要考试）。',
    method: 'POST',
    path: '/goals/{id}/progress',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      id: 'string',
      progress: 'number?（0~100）',
      delta: 'number?（相对当前进度增减）',
      milestoneId: 'string?',
      done: 'boolean?（配合 milestoneId；缺省为取反）',
      status: 'string?',
    },
    returns: { item: 'Goal' },
  },
  {
    name: 'goals_delete',
    description: '删除一条目标（写操作，不可逆）。删除前必须让用户确认，且不要顺手批量删。',
    method: 'DELETE',
    path: '/goals/{id}',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { id: 'string' },
    returns: { id: 'string', deleted: 'true' },
  },
  {
    name: 'goals_target_gpa',
    description:
      '读用户**自己填的**目标学分绩（可能为 null，表示还没设）。' +
      '它只是用户给自己定的靶子，**不是学校公布的保研线**，也绝不能据此预测保研结果或换算概率；' +
      '当前真实学分绩请从 goals_overview 的 gpa.current 取（那来自学业模块的成绩数据）。',
    method: 'GET',
    path: '/goals/target-gpa',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {},
    returns: { targetGpa: 'number|null', updatedAt: 'string|null', disclaimer: 'string' },
  },
  {
    name: 'goals_set_target_gpa',
    description:
      '设置（或清除）目标学分绩（写操作）。**只在用户自己说出一个数时调用**：' +
      '绝不许根据当前学分绩"建议"一个目标然后直接写进去，也不许把它说成保研线。' +
      '不同学校满绩口径不同（4.0 / 4.3 / 5.0），本接口只做 0~5 的范围校验，不假定口径。',
    method: 'POST',
    path: '/goals/target-gpa',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { targetGpa: 'number|null（0~5，null 表示清除目标）' },
    returns: { targetGpa: 'number|null', updatedAt: 'string|null', disclaimer: 'string' },
  },
];
