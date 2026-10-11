/**
 * 西交大课表能力的「工具清单」。
 *
 * 与 `src/server/lms/tools.js` 完全同一套契约（`name / method / path / params / requiresAuth / mutates`）：
 * 每个工具都对应一个已实现的 HTTP 接口，模型只需要学会调用这些工具，
 * 不需要知道 CAS 登录、Cookie、RSA 加密、周次位图这些东西。
 *
 * 两个约定：
 * - `requiresAuth: true` 的工具必须先登录教务系统，否则返回 401；
 * - `mutates: true` 的工具会写日历数据，Agent 必须先调 `timetable_preview` 并征得用户确认。
 */

export const TIMETABLE_TOOL_SPECS = [
  {
    name: 'timetable_status',
    description: '查看教务课表登录状态、学期起始日缓存与已导入课表日程数量',
    method: 'GET',
    path: '/tt/status',
    requiresAuth: false,
    mutates: false,
    params: {},
  },
  {
    name: 'timetable_login',
    description: '用学号与密码登录教务系统（统一身份认证，可能返回需要两步验证）',
    method: 'POST',
    path: '/tt/login',
    requiresAuth: false,
    mutates: false,
    params: { username: 'string', password: 'string', captcha: 'string?' },
  },
  {
    name: 'timetable_verify_mfa',
    description: '提交两步验证短信验证码，完成登录',
    method: 'POST',
    path: '/tt/mfa/verify',
    requiresAuth: false,
    mutates: false,
    params: { code: 'string' },
  },
  {
    name: 'timetable_terms',
    description: '列出可选学期（含第一周周一、来源 ehall/guess/manual、总周数）',
    method: 'GET',
    path: '/tt/terms',
    requiresAuth: true,
    mutates: false,
    params: { refresh: 'boolean?' },
  },
  {
    name: 'timetable_set_term_start',
    description: '手工指定某学期的第一周周一（必须是周一；此后不会被自动值覆盖）',
    method: 'POST',
    path: '/tt/terms/:term',
    requiresAuth: true,
    mutates: true,
    params: { term: 'string', startDate: 'string' },
  },
  {
    name: 'timetable_courses',
    description: '列出某学期的课程（去重后的课程名、教师、教室、星期与节次、周次）',
    method: 'GET',
    path: '/tt/courses',
    requiresAuth: true,
    mutates: false,
    params: { term: 'string?', refresh: 'boolean?' },
  },
  {
    name: 'timetable_refresh',
    description: '从教务系统拉取某学期课表并写入本地缓存',
    method: 'POST',
    path: '/tt/refresh',
    requiresAuth: true,
    mutates: false,
    params: { term: 'string?' },
  },
  {
    name: 'timetable_preview',
    description:
      '预览「把课表逐周展开成日程」会产生哪些新建 / 更新 / 失效，不写数据（默认不导入已经过去的周次）',
    method: 'POST',
    path: '/tt/preview',
    requiresAuth: true,
    mutates: false,
    params: { term: 'string?', includePast: 'boolean?', compact: 'boolean?', refresh: 'boolean?', today: 'string?' },
  },
  {
    name: 'timetable_apply',
    description: '执行课表同步（可只写预览里选中的 keys）；只动 externalId 以 tt: 开头的日程',
    method: 'POST',
    path: '/tt/apply',
    requiresAuth: true,
    mutates: true,
    params: { term: 'string?', keys: 'string[]?', pruneStale: 'boolean?', includePast: 'boolean?', compact: 'boolean?' },
  },
];
