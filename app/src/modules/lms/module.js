/**
 * 思源学堂（LMS）模块：统一身份认证登录 → 课程/活动缓存 → 同步到日历。
 *
 * 依赖声明
 * --------
 * - order = 20 > calendar(10)：同步时要调用 `services.schedules/events` 写日程，
 *   并直接读 `store.schedules/events` 统计已同步条数。**把 order 调小会静默失败**。
 * - 需要 `ctx.dataDir`：会话 Cookie 落在 `<dataDir>/lms-session.json`（0600），
 *   设置落在 `lms-meta.json`（0644）。这两个是模块私有文件，不走 JsonStore。
 *
 * 配置
 * ----
 * `createServer({ lms: {...} })` 的切片会**整份**透传给 LmsService。
 * 注意 LmsService 的子组件拿到的是原始 config 而非解析结果，因此：
 * 要么不传 `config`（走 `PC_LMS_*` 环境变量 + 内置默认值），
 * 要么传**完整**的 config（部分覆盖会让 baseUrl 变成 undefined）。
 * 测试即用 `{ config: { baseUrl, casOrigin, ... } }` 指向 mock 站点。
 */

import { LmsService } from '../../server/lms/service.js';
import { LMS_TOOL_SPECS } from '../../server/lms/tools.js';

export default {
  id: 'lms',
  title: '思源学堂',
  order: 20,

  collections: [
    { name: 'lmsCourses', file: 'lms-courses.json' },
    { name: 'lmsActivities', file: 'lms-activities.json' },
  ],

  /** 聚合进 GET /api/v1/ai/capabilities，供 AI Agent 按 name + params 调用，无需了解登录细节。 */
  aiTools: LMS_TOOL_SPECS,

  createServices({ store, broadcast, services, dataDir, options }) {
    const lms = new LmsService({ store, services, broadcast, dataDir, ...options });
    return { lms };
  },

  /** 恢复上次会话（可能读盘失败，由装配层兜底降级）。 */
  async restore({ own }) {
    await own.lms.restore();
  },

  start({ own }) {
    own.lms.startAutoSync();
  },

  stop({ own }) {
    own.lms.stopAutoSync();
  },
};
