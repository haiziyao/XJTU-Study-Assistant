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
 * - `mutates` 为 true 的工具会写数据，Agent 调用前应先走 preview 并征得用户确认。
 */

export const LMS_TOOL_SPECS = [
  {
    name: 'lms_status',
    description: '查看思源学堂登录状态、缓存数量与上次同步时间',
    method: 'GET',
    path: '/lms/status',
    requiresAuth: false,
    mutates: false,
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
];
