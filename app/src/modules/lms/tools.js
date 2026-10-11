/**
 * 思源学堂能力的「工具清单」。
 *
 * 这一层是给未来的 AI Agent 用的接口契约：每个工具都对应一个已实现的 HTTP 接口，
 * 名字、参数、返回值形状固定下来，模型只需要学会调用这些工具，
 * 不需要知道 CAS 登录、Cookie、RSA 加密这些细节。
 *
 * 约定：
 * - `path` 是相对 API 前缀的路径（形如 `/lms/status`）；
 * - `requiresAuth` 为 true 的工具必须先登录，否则返回 401；
 * - `mutates` 为 true 的工具会写数据，Agent 调用前应先走 preview 并征得用户确认；
 * - `implemented: false` 表示**契约已定、接口尚未实现**（调用会拿到 501 NOT_IMPLEMENTED）。
 *   列出来是为了让 Agent 知道"这个能力正在路上"，但**不要当成现在可用的工具去调**。
 */

export const LMS_TOOL_SPECS = [
  {
    name: 'lms_status',
    description: '查看思源学堂登录状态、缓存数量与上次同步时间',
    method: 'GET',
    path: '/lms/status',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {},
  },
  {
    name: 'lms_login',
    description: '使用学号与密码登录思源学堂（可能返回需要两步验证）',
    method: 'POST',
    path: '/lms/login',
    requiresAuth: false,
    mutates: false,
    params: { username: 'string', password: 'string', captcha: 'string?' },
  },
  {
    name: 'lms_verify_mfa',
    description: '提交两步验证短信验证码，完成登录',
    method: 'POST',
    path: '/lms/mfa/verify',
    requiresAuth: false,
    mutates: false,
    params: { code: 'string' },
  },
  {
    name: 'lms_courses',
    description: '列出思源学堂课程（可按需刷新）',
    method: 'GET',
    path: '/lms/courses',
    requiresAuth: true,
    mutates: false,
    params: { refresh: 'boolean?' },
  },
  {
    name: 'lms_activities',
    description: '列出课程活动（作业 / 资料 / 回放 / 直播）',
    method: 'GET',
    path: '/lms/activities',
    requiresAuth: true,
    mutates: false,
    params: { courseId: 'number?', type: 'homework|material|lesson|lecture_live?', refresh: 'boolean?' },
  },
  {
    name: 'lms_sync_preview',
    description: '预览「把作业与直播同步到日历」会产生哪些新建 / 更新，不写数据',
    method: 'POST',
    path: '/lms/sync/preview',
    requiresAuth: true,
    mutates: false,
    params: {
      courseIds: 'number[]?',
      types: 'string[]?',
      includePast: 'boolean?',
      includeCourseRange: 'boolean?',
    },
  },
  {
    name: 'lms_settings',
    description: '修改思源学堂同步设置（自动同步开关与间隔小时数）',
    method: 'POST',
    path: '/lms/settings',
    requiresAuth: true,
    mutates: true,
    params: { autoSync: 'boolean?', autoSyncIntervalHours: 'number?' },
  },
  {
    name: 'lms_sync_apply',
    description: '执行同步（可只同步预览里选中的 keys），写入日程与日历事件',
    method: 'POST',
    path: '/lms/sync/apply',
    requiresAuth: true,
    mutates: true,
    params: { keys: 'string[]?', pruneStale: 'boolean?' },
  },

  // ---------------------------------------------------------------- 预置（尚未实现）
  //
  // 契约先行：路径、参数、返回形状都定下来了，实现留到后面 —— 现在调用会拿到
  // 501 NOT_IMPLEMENTED，且 `details.planned === true`、`details.contract` 里是这份契约。
  // 为什么照样列出来：Agent 据此知道能力边界（"有这条路，只是还没通"），
  // 也能提前按这个形状写调用代码；`implemented: false` 就是"别当成可用工具"的信号。
  {
    name: 'lms_course_detail',
    description: '查看某门课程的详情：教师、学分、学期、教学班、起止日期、课件数量',
    method: 'GET',
    path: '/lms/courses/{id}',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: { id: 'string' },
    returns: { id: 'string', name: 'string', instructors: 'array', credit: 'number', semester: 'object', startDate: 'string', endDate: 'string', materialCount: 'number' },
  },
  {
    name: 'lms_course_materials',
    description: '列出某门课程的课件与资料（文件名、类型、大小、上传时间、是否可下载）',
    method: 'GET',
    path: '/lms/courses/{id}/materials',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: { id: 'string' },
    returns: { items: '[{ id, title, kind, bytes, uploadedAt, downloadable }]' },
  },
  {
    name: 'lms_assignment_submission',
    description: '查看某次作业的提交情况：是否已提交、提交时间、得分、评语、附件',
    method: 'GET',
    path: '/lms/activities/{id}/submission',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: { id: 'string' },
    returns: { submitted: 'boolean', submittedAt: 'string?', score: 'number?', comment: 'string?', files: 'array' },
  },
  {
    name: 'lms_notices',
    description: '查看课程通知与公告（可按课程过滤），用于了解教师临时安排',
    method: 'GET',
    path: '/lms/notices',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: { courseId: 'string?' },
    returns: { items: '[{ id, courseId, courseName, title, publishedAt, body }]' },
  },
  {
    name: 'lms_grades',
    description: '查看成绩（课程总分与各项得分）',
    method: 'GET',
    path: '/lms/grades',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: {},
    returns: { items: '[{ courseId, courseName, score, fullScore, items }]' },
  },
  {
    name: 'lms_discussion_topics',
    description: '查看某门课程的讨论区主题（标题、发帖人、回复数、最后回复时间）',
    method: 'GET',
    path: '/lms/courses/{id}/discussions',
    requiresAuth: true,
    mutates: false,
    implemented: false,
    params: { id: 'string' },
    returns: { items: '[{ id, title, author, replies, lastReplyAt }]' },
  },
];
