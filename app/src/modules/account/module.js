/**
 * 账号模块：「设置 → 账号登录」的后端。
 *
 * 一句话职责：**桌面端渲染层 ↔ 公开服务端 `/auth/**` 之间的桥**。
 * 页面只跟我们自己的后端说话（`/account/**`），由后端持令牌去跟服务器说话。
 *
 * 为什么需要这座桥（不是多此一举）
 * --------------------------------
 *   - 桌面端页面在 `http://127.0.0.1:3210`，公开服务端在 `http://localhost:8866`，
 *     两者**跨域**；而服务端版**故意不发 CORS 头**（同源部署不需要，
 *     发了反而拆掉"浏览器读不到跨站响应"这层保护）。渲染层直接 fetch 会读不到响应。
 *   - 会话令牌是 `HttpOnly` Cookie，本就不该出现在页面里。由后端持有 + 转发，
 *     页面拿不到令牌，XSS 也偷不走。
 *
 * `order = 88`：
 *   - 排在 `ai`(90) **之前**，但本模块**刻意不提供任何 aiTools / aiPrompt / commands**
 *     —— 账号是用户自己的事，不该让模型碰到（既不查也不改）。顺序只是"早于聚合型模块"
 *     的常规排布，不代表有任何 AI 语义。
 *   - 与现有 id（calendar 10 / lms 20 / notes 40 / memory 45 / cards 46 / goals 47 /
 *     transfer 75 / ai 90）都不冲突。
 *
 * **不声明任何 collection**：登录凭据属于"私有文件"，放 `data/account.json`（0600）。
 * JsonStore 的集合是 0644 的业务数据，两者语义不同（契约里写死的规矩）。
 *
 * 服务端版（server 分支）复用方式：把模块配置的 `defaultServerUrl` 设为空串（= 同源），
 * 需要的话再给 `origin`，实现里对空值走相对路径。
 */

import { AccountService } from './service.js';
import { registerAccountRoutes } from './routes.js';

export default {
  id: 'account',
  title: '账号',
  order: 88,

  /**
   * @param {object} ctx
   * @param {string} ctx.dataDir `data/` 目录（`account.json` 落这里，权限 0600）
   * @param {object} ctx.options 模块配置切片：`{defaultServerUrl, origin, timeoutMs}`
   * @param {Function} [ctx.broadcast] WebSocket 广播（更改服务器地址后通知界面）
   */
  createServices({ dataDir, options, broadcast }) {
    const account = new AccountService({
      dataDir,
      // 桌面端默认指向本机服务端；服务端版传 '' 表示同源
      defaultServerUrl: options?.defaultServerUrl,
      origin: options?.origin,
      timeoutMs: options?.timeoutMs,
      broadcast,
    });
    return { account };
  },

  /**
   * 读回上次的登录态（在 listen 之前）。
   *
   * 失败降级成"未登录"而不是拖垮启动：账号文件损坏/权限不对时，用户至少还能用本地功能。
   */
  async restore({ own }) {
    await own.account.load();
  },

  registerRoutes(router, ctx) {
    registerAccountRoutes(router, ctx);
  },
};
