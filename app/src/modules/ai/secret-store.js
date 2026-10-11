/**
 * 存放 API 密钥的小文件（0600）。
 *
 * 为什么不用 JsonStore：密钥属于凭据，应该
 *   - 单独文件、单独权限（仅当前用户可读）；
 *   - 不进业务数据文件，便于一键清除；
 *   - 不参与 `data_changed` 广播（业务数据变了前端要刷新，密钥变了不需要）。
 * 这里只做「JSON 文件 + 严格权限」，不做加密：真正的保护来自文件系统权限，
 * 与 `modules/lms/secret-store.js` 是同一套做法（那个文件是模块私有的，不能跨模块引，
 * 若将来第三个模块也要用，应该由框架层收进 `src/shared/`）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class JsonFile {
  constructor(filePath, { mode = 0o600 } = {}) {
    this.filePath = filePath;
    this.mode = mode;
  }

  async read() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 内容损坏时不静默覆盖：备份后当作「没有配置」
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      return null;
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: this.mode });
    await fs.rename(tmp, this.filePath);
    // rename 不会带上权限位，显式再收一次
    await fs.chmod(this.filePath, this.mode).catch(() => {});
    return this;
  }

  async remove() {
    await fs.rm(this.filePath, { force: true });
  }
}
