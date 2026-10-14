/**
 * 同步模块：**同一个账号的多台设备（桌面 ↔ 服务器 ↔ 手机）保持数据一致**。
 *
 * 一句话职责：把本机数据与"这台账号自己的服务器"上的同一份数据**双向**对齐，
 * 冲突按局域网直传那套口径处理（两条都留 + 交给用户），绝不用"谁后写谁赢"。
 *
 * 为什么 `order = 89`：
 *   - 排在 `account`(88) 之后：桌面端要先能拿到"我是谁、服务器在哪、令牌是什么"
 *     （`services.account`），同步才有对象；
 *   - 排在 `ai`(90) 之前：AI 是聚合型模块（收各模块的 aiPrompt/aiTools），
 *     同步不属于任何 AI 语义，早于它装配只是"非聚合模块排在聚合模块之前"的常规排布。
 *   - 与现有 id（…account 88 / ai 90）都不冲突。
 *
 * **刻意不提供任何 AI 能力**（没有 aiTools / aiPrompt / aiQueryFields / commands）：
 * 同步是"用户自己的数据在自己设备之间流动"，与模型无关。给模型一个"触发同步"的工具，
 * 只会在用户不知情的时候把数据推上服务器 —— 账号与传输两个模块也是同样的取舍。
 *
 * **不声明任何 collection**：设备身份、开关、游标、幂等账本放模块私有文件
 * `data/sync-state.json` 与 `data/sync-ledger.json`（都是 **0600**）。
 * JsonStore 的集合是 0644 的业务数据，语义不同（契约里写死的规矩）。
 *
 * 服务端版（server 分支）复用方式：什么都不用改 —— 宿主把 `/api/v1/**` 反代给
 * 该账号自己的后端实例，而那个实例装配的是同一套模块，`/sync/push`、`/sync/pull`
 * 自然就在。见 service.js 顶部的说明。
 */

import { SyncService } from './service.js';
import { registerSyncRoutes } from './routes.js';

export default {
  id: 'sync',
  title: '多端同步',
  order: 89,

  /**
   * @param {object} ctx
   * @param {object} ctx.store       JsonStore（读写业务集合）
   * @param {Function} ctx.broadcast WebSocket 广播
   * @param {object} ctx.services    全局服务表（用 account 拿令牌、ai 写配置、auth 写凭据）
   * @param {string} ctx.dataDir     私有文件目录（`data/sync-*.json`）
   * @param {object} ctx.options     模块配置切片
   *   `{deviceName, serverUrl, timeoutMs, autoRun}`
   *   —— `deviceName` 给测试与"用户想改设备名"用；`autoRun: false` 关掉启动自动同步（测试用）
   */
  createServices({ store, broadcast, services, dataDir, options }) {
    const sync = new SyncService({ store, broadcast, services, dataDir, options });
    return { sync };
  },

  /** 读回设备身份、敏感开关、游标与幂等账本（必须在 listen 之前：状态接口一开始就要能答）。 */
  async restore({ own }) {
    await own.sync.load();
  },

  /**
   * listen 成功后：自动同步一次。
   *
   * 为什么放在这里而不是定时器里：口径是"手动 + 启动后一次"，不是常驻轮询。
   * 自动同步**失败一律静默**（没登录、服务器连不上、令牌过期都在预期内），
   * 原因记在 `lastError` 里，"设置 → 多端同步"面板上能看到。
   */
  start({ own }) {
    own.sync.start();
  },

  registerRoutes(router, ctx) {
    registerSyncRoutes(router, ctx);
  },
};
