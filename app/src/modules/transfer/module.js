/**
 * 传输模块：局域网内**设备之间直传**（不经过任何服务器），契约 §八。
 *
 * 一句话职责：把本机勾选的数据打包，配对之后直接 POST 给另一台设备；反过来也接得住。
 *
 * 为什么 `order = 75`：
 *   - 必须**晚于**所有数据模块（calendar 10 / notes 40 / memory 45 / cards 46 / goals 47），
 *     因为接收侧要调它们的服务写入（`services.notes.create` …），createServices 时才拿得到；
 *   - 排在 `ai`(90) 之前无所谓，本模块不参与 aiPrompt 聚合 —— 它没有任何"给模型看"的语义。
 *
 * **不新增集合**（用户明确要求）：
 *   - 数据面不需要存储：数据是别人的，传完即走；
 *   - 传输日志、幂等账本、设备标识放**模块私有文件** `data/transfer-log.json`（0600）。
 *     为什么不用 JsonStore：那是一份 0644 的业务数据文件，语义是"用户的数据"；
 *     而这里存的是"哪台设备传过什么"的运行记录 + 远端 id ↔ 本地 id 的对应关系，
 *     丢了最多重传一次，权限却应该更紧（里面有设备名与远端记录 id）。
 *
 * 端口：**独立 8886**（`options.port` 可配置），主服务继续只听 127.0.0.1。
 *
 * 8886 上除了协议那 4 条路由，还有一个**默认关**的「局域网网关」（`gateway.js`）：
 * 打开后，同一个 8886 会多出 `/app/**`（托管 `src/renderer/**`）、`/api/**`（反向代理到主服务）
 * 与 `/ws`（WebSocket 代理），三者都要配对码换来的局域网令牌（HttpOnly Cookie / `X-Potato-Lan-Token`）。
 * 为什么放在这个端口而不是新开一个：不改 `src/core/**` 与主服务"只听本机"的安全默认，
 * 同时局域网上的暴露面**仍然只有 8886 一个端口**，用户关掉开关就彻底消失。
 */

import { TransferService } from './service.js';
import { registerTransferRoutes } from './routes.js';

export default {
  id: 'transfer',
  title: '传输',
  order: 75,

  createServices({ store, broadcast, services, dataDir, options }) {
    // 注入式设计：`options.port` / `options.deviceName` / `options.discovery === false`
    // 都是给测试与"端口被占用时换一个"准备的（见 service.js 的构造函数）
    const transfer = new TransferService({ store, broadcast, services, dataDir, options });
    return { transfer };
  },

  /** 读回设备标识、日志与幂等账本（必须在 listen 之前：/info 一开始就要报出稳定的设备 id）。 */
  async restore({ own }) {
    await own.transfer.load();
  },

  /** 主服务 listen 成功之后：起 UDP 监听 + 8886 上的小 HTTP 服务器。 */
  start({ own }) {
    own.transfer.start();
  },

  /** 关停：关 UDP、关 8886、落盘。必须干净（否则 `node --test` 退不出去）。 */
  stop({ own }) {
    return own.transfer.stop();
  },

  registerRoutes(router, ctx) {
    registerTransferRoutes(router, ctx);
  },
};
