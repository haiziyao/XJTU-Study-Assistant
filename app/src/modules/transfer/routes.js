/**
 * 「传输」模块在本机主服务上的控制面路由（`/api/v1/transfer/...`）。
 *
 * 为什么控制面与数据面分开：
 *   - **数据面**（设备服务器，8886）只认协议四件事：`/info`、`/pair`、`/transfer`、`/progress`；
 *     它是给"另一台设备"用的，必须在局域网上可达。
 *   - **控制面**（这里）只服务本机页面：设备名、可被发现开关、配对码、附近设备、发送、日志、
 *     疑似重复清单。它挂在主服务上（127.0.0.1），**不对外**。
 * 两边共用同一个 `TransferService` 实例，所以页面上看到的进度就是设备服务器上发生的事。
 */

import { catalog } from './catalog.js';

export function registerTransferRoutes(router, { own, apiPrefix }) {
  const transfer = own.transfer;
  const P = `${apiPrefix}/transfer`;

  // 一次拿全（页面每 2 秒轮询它）：设备/端口状态、配对码、开关、附近设备、进度、日志、集合目录、待处理清单
  const status = () => transfer.status();
  router.get(P, status);
  router.get(`${P}/status`, status);

  /** 换一个配对码（用户点「换一个」）。 */
  router.post(`${P}/code`, () => ({ code: transfer.regenerateCode() }));

  /** 改设备名 / 可被发现 / 允许接收。 */
  router.post(`${P}/settings`, ({ body }) => transfer.updateSettings(body ?? {}));

  /** 集合清单：哪些能传、哪些接收侧写不进来（界面直接照着显示原因）。 */
  router.get(`${P}/catalog`, () => ({ catalog: catalog() }));

  /** 附近设备（UDP 发现的 + 手工添加的）。 */
  router.get(`${P}/peers`, () => ({ peers: transfer.peers() }));

  /** 手工添加 `IP:8886`：会先探一次 `/info`，地址写错当场报错。 */
  router.post(`${P}/peers`, async ({ body }) => ({ peer: await transfer.addManualPeer(body ?? {}) }));

  /** 发送（手动触发；同步等到传完，结果里有每一批的汇总）。 */
  router.post(`${P}/send`, ({ body }) => transfer.sendTo(body ?? {}));

  /** 当前发送/接收进度。 */
  router.get(`${P}/progress`, () => transfer.progress());

  /** 传输日志（谁、什么时候、传了什么、成功/跳过/重命名各几条）。 */
  router.get(`${P}/log`, ({ query }) => ({ items: transfer.logs({ limit: query?.limit }) }));

  /** 最近一次传输的逐条明细（含疑似重复 / 记忆冲突清单）。 */
  router.get(`${P}/result`, () => ({ result: transfer.result() }));

  /** 处理疑似重复：删掉刚收下的那条，或保留（两条都留）。 */
  router.post(`${P}/result/resolve`, ({ body }) => transfer.resolveSuspect(body ?? {}));
}
