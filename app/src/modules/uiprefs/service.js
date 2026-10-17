/**
 * 界面偏好服务：一张 `键 → JSON 值` 的表。
 *
 * 设计上是**故意小**的：它只解决"浏览器与桌面端存不住同一份偏好"这一个问题。
 * 任何有业务含义的数据都该进它自己的模块，不要往这里塞。
 */

import { HttpError } from '../../core/http/router.js';

/** 单个值的字节上限：偏好表不是数据库，超过这个量级说明放错了地方。 */
const MAX_VALUE_BYTES = 16 * 1024;

/** 键名白名单：小写字母/数字/点/连字符，首字符必须是字母。 */
const KEY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export class UiPrefService {
  constructor({ store, broadcast = () => {} } = {}) {
    this.store = store;
    this.broadcast = broadcast;
  }

  /** 校验并归一一个键名（不合法就 400，而不是静默丢弃）。 */
  #key(raw) {
    const key = String(raw ?? '').trim();
    if (!KEY_PATTERN.test(key)) {
      throw HttpError.badRequest(`偏好键名不合法：${JSON.stringify(raw)}（只允许小写字母/数字/点/连字符）`, {
        field: 'key',
      });
    }
    return key;
  }

  /** 全部偏好，形状是 `{ [key]: value }`（前端一次取回，不用逐键请求）。 */
  all() {
    const items = {};
    for (const row of this.store.uiPrefs.all()) {
      if (typeof row?.id === 'string') items[row.id] = row.value ?? null;
    }
    return { items };
  }

  /** 读一个键；没有就返回 `{ key, value: null }`（null 表示"从未设置过"）。 */
  get(rawKey) {
    const key = this.#key(rawKey);
    const row = this.store.uiPrefs.get(key);
    return { key, value: row?.value ?? null };
  }

  /**
   * 写一个键。
   *
   * `value === null` 语义是**删除**（回到默认），而不是存一个 null ——
   * "恢复默认"就靠这个，免得前端还要另开一个 DELETE 路由。
   */
  async set(rawKey, value) {
    const key = this.#key(rawKey);
    if (value === null || value === undefined) {
      await this.store.uiPrefs.remove(key);
      this.broadcast({ type: 'data_changed', payload: { target: 'uiprefs', action: 'remove', key } });
      return { key, value: null, removed: true };
    }

    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw HttpError.badRequest('偏好值无法序列化为 JSON', { field: 'value' });
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_VALUE_BYTES) {
      throw HttpError.badRequest(`偏好值太大（${bytes} 字节，上限 ${MAX_VALUE_BYTES}）—— 界面偏好不该存这么多`, {
        field: 'value',
      });
    }

    await this.store.uiPrefs.insert({ id: key, value, updatedAt: new Date().toISOString() });
    this.broadcast({ type: 'data_changed', payload: { target: 'uiprefs', action: 'set', key } });
    return { key, value };
  }
}
