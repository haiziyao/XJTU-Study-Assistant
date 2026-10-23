/**
 * 桌面端 → 服务器的 HTTP 客户端（`/api/v1/sync/pull`、`/api/v1/sync/push`）。
 *
 * 三条硬规矩
 * ----------
 * 1. **令牌只出现在 Authorization 头里**：不进 URL（URL 会进访问日志）、不进报告、
 *    不进 `sync-state.json`。错误信息在返回之前一律过 `redactSecrets()`；
 * 2. **失败要能分辨**：连不上 / 超时 / 401 令牌过期 / 404 服务器没有同步接口 / 4xx 业务错误 /
 *    5xx 服务端错误 / 响应不是 JSON —— 面板给用户的下一步动作完全不同
 *    （401 是"重新登录"，404 是"这台服务器不是本程序的服务端"，连不上是"检查地址与端口"）；
 * 3. **不抛异常给上层**：返回 `{ok:false, error:{code,message}}`，由 `service.js` 决定
 *    报告怎么写 —— 同步失败绝不该以"异常冒泡"的方式结束（那会让本地合并逻辑半途而废）。
 *
 * 为什么用 `Authorization: Bearer`：服务端版宿主（`src/www/server.js`）在 Cookie 之外
 * 明确接受 `Authorization: Bearer <会话令牌>`（手机客户端最自然的方式），
 * 而桌面端的令牌本来就是后端持有的（页面拿不到），这里只是把它转成头带出去。
 */

import { resolveUpstream } from '../account/service.js';
import { redactSecrets } from './merge.js';

/** 默认超时：一次同步要搬的数据可能不小，180 秒给"数据多 / 对端慢"留足余量（网关侧另有 240 秒上游超时，见 README）。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** 同步接口的路径（冻结契约）。 */
export const SYNC_PATHS = Object.freeze({
  push: '/api/v1/sync/push',
  pull: '/api/v1/sync/pull',
  status: '/api/v1/sync/status',
});

/**
 * 把 fetch 抛出来的东西翻成"人话 + 可判断的错误码"。
 *
 * @param {Error} error
 * @param {string} where 出错的动作（写进日志/报告用，如 `push`）
 */
export function mapTransportError(error, where = 'sync') {
  const name = String(error?.name ?? '');
  const raw = String(error?.message ?? error ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || /aborted|timeout/i.test(raw)) {
    return { code: 'SERVER_TIMEOUT', message: `服务器响应太慢，${where} 超时了：检查网络，或在网络好的时候再试一次。` };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket hang up|certificate/i.test(raw)) {
    return { code: 'SERVER_UNREACHABLE', message: '连不上这个服务器：检查地址与端口，确认对方在跑（以及网络通不通）。' };
  }
  return { code: 'SERVER_UNREACHABLE', message: `连不上这个服务器：${redactSecrets(raw)}` };
}

/** 上游错误体 → 人话（**只按错误码/消息映射，绝不整段透传**）。 */
function mapHttpError(status, body) {
  const upstream = body?.error && typeof body.error === 'object' ? body.error : null;
  const message = redactSecrets(upstream?.message ?? '');
  if (status === 401) return { code: 'TOKEN_EXPIRED', message: '登录已过期：请到「设置 → 账号登录」重新登录这台服务器。' };
  if (status === 403) return { code: 'FORBIDDEN', message: message || '这台服务器不允许这次同步（账号权限或环境限制）。' };
  if (status === 404) return { code: 'SYNC_UNAVAILABLE', message: '这台服务器上没有同步接口：它可能不是本程序的服务端，或者版本太旧（请升级服务器）。' };
  if (status === 413) return { code: 'PAYLOAD_TOO_LARGE', message: '这一批数据太大了，服务器拒收：稍后重试（同步是分批发的，重试会从当前进度继续）。' };
  if (status >= 500) return { code: 'SERVER_ERROR', message: message || `服务器内部错误（HTTP ${status}），可以稍后再试。` };
  return { code: upstream?.code ?? `HTTP_${status}`, message: message || `服务器返回 HTTP ${status}` };
}

export class SyncClient {
  /**
   * @param {object} options
   * @param {string} options.serverUrl 服务器地址（已归一化；空串 = 同源，本客户端不支持）
   * @param {string} options.token     会话令牌（**只在内存里**）
   * @param {Function} [options.fetchImpl] 注入 fetch（测试用）
   * @param {number} [options.timeoutMs]
   */
  constructor({ serverUrl, token, fetchImpl, timeoutMs, logger = console } = {}) {
    this.serverUrl = String(serverUrl ?? '').trim();
    this.token = String(token ?? '');
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.logger = logger;
  }

  /** 一次 JSON POST；**永远不抛**，失败以 `{ok:false, error}` 回来。 */
  async #post(pathname, body) {
    if (typeof this.fetchImpl !== 'function') return { ok: false, error: { code: 'NO_FETCH', message: '这个运行环境没有 fetch，无法访问服务器。' } };
    let url;
    try {
      url = resolveUpstream(this.serverUrl, pathname);
    } catch (error) {
      return { ok: false, error: { code: 'BAD_SERVER_URL', message: redactSecrets(error?.message ?? String(error)) } };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 令牌只在这里出现一次；任何错误路径都不会把它带进消息
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body ?? {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      return { ok: false, error: mapTransportError(error, pathname.split('/').pop() ?? 'sync') };
    } finally {
      if (timer) clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) return { ok: false, status: response.status, error: mapHttpError(response.status, payload) };
    if (!payload || typeof payload !== 'object') return { ok: false, status: response.status, error: { code: 'BAD_RESPONSE', message: '服务器返回的不是 JSON（可能被网关或登录页拦下了），本轮不改动本机数据。' } };
    return { ok: true, status: response.status, body: payload };
  }

  /** 推一批（未分片的一批；调用方负责在超大时切成多批）。 */
  push(body) {
    return this.#post(SYNC_PATHS.push, body);
  }

  /** 拉增量。 */
  pull(body) {
    return this.#post(SYNC_PATHS.pull, body);
  }
}
