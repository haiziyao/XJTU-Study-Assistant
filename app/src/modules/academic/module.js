/**
 * 学业情况查询模块。
 *
 * 职责：从本科教务系统拉取成绩 → 落本地 → 算学分绩（每门课可单独选择是否纳入）→
 * 供界面展示、供 AI 读取并出学情分析。
 *
 * `order: 30` 是有意的：排在 `lms`(20) 之后、`ai`(90) 之前 ——
 * ai 模块要聚合本模块声明的 `aiPrompt` / `aiQueryFields`，所以必须排在它前面。
 */

import { defineModule } from '../../core/module/contract.js';
import { AcademicService } from './service.js';

export default defineModule({
  id: 'academic',
  title: '学业',
  order: 30,

  collections: [
    {
      name: 'academicGrades',
      file: 'academic-grades.json',
      // externalId 是幂等键（教务的 WID），term 用于按学期筛选
      indexes: ['externalId', 'term'],
    },
  ],

  createServices({ store, broadcast, services, dataDir, options }) {
    const academic = new AcademicService({
      store,
      broadcast,
      services,
      config: options ?? {},
      dataDir,
    });
    return { academic };
  },

  /** 启动时恢复上次会话；失败只降级为未登录，不阻断整个进程。 */
  async restore({ own }) {
    await own.academic.restore();
  },
});
