/**
 * 界面偏好（UI preferences）模块。
 *
 * 为什么需要它：**`localStorage` 在桌面端靠不住。**
 * Web UI 的页面由后端在 `http://127.0.0.1:PORT` 提供，`localStorage` 按这个来源持久化；
 * 而 Electron 主进程用 `loadFile()` 加载页面，来源变成 `file://` —— 两份存储互不相干，
 * 换端口也会换一份。于是"自定义侧边栏顺序"在浏览器里记得住、在桌面端下次打开就没了。
 *
 * 所以把这类偏好落到**后端**：两个环境读的是同一份，清缓存/换端口也不丢。
 * 前端仍然会在 `localStorage` 里留一份缓存，只为**首帧就能按用户顺序画**（不必等请求回来）。
 *
 * 边界
 * ----
 * - 只存**界面偏好**，不存业务数据。业务数据有自己的模块与集合。
 * - 值按 JSON 存，**限长 16 KB**：这是个偏好表，不是第二个数据库。
 * - 键名必须是小写字母/数字/点/连字符（如 `sidebar`），避免被当成路径或注入。
 */

import { UiPrefService } from './service.js';
import { registerUiPrefRoutes } from './routes.js';

export default {
  id: 'uiprefs',
  title: '界面偏好',
  /**
   * `order: 95` —— 排在所有业务模块之后、ai(90) **之后**也无所谓：
   * 本模块不提供 aiTools / aiPrompt / commands，不参与提示词聚合，
   * 也没有任何模块依赖它。选 95 只是让它在装配表里靠后，不挡任何东西。
   */
  order: 95,

  collections: [{ name: 'uiPrefs', file: 'ui-prefs.json' }],

  createServices({ store, broadcast }) {
    const prefs = new UiPrefService({ store, broadcast });
    return { prefs };
  },

  registerRoutes(router, ctx) {
    registerUiPrefRoutes(router, { prefs: ctx.own.prefs, apiPrefix: ctx.apiPrefix });
  },
};
