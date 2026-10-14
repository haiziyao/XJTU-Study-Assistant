/**
 * 模块私有 JSON 文件（**0600**，原子替换 + 写入串行化）。
 *
 * 与 `src/modules/account/service.js` 里的 `PrivateJsonFile`、`src/modules/lms/secret-store.js`
 * 的 `JsonFile` 是同一套口径（这三处各有一份，是因为模块之间不互相 import 私有文件实现）：
 *   - **0600**：同步状态文件里有 `deviceId`（设备身份），账本里有"哪台设备给过我哪条记录"，
 *     学堂凭据文件里更是学校的会话票据 —— 都不该是 0644 的"业务数据"；
 *   - **先写临时文件再 rename**：进程被杀不会留下半截 JSON；
 *   - **写入串行化**：同一份文件被并发写（自动同步 + 用户点「立即同步」）时按顺序落盘；
 *   - **损坏不静默覆盖**：备份成 `.corrupt-<时间>` 后当作"没有"，最坏是重同步一次。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PRIVATE_MODE = 0o600;

export class PrivateJsonFile {
  constructor(filePath, { mode = PRIVATE_MODE } = {}) {
    this.filePath = filePath;
    this.mode = mode;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      return null;
    }
  }

  exists() {
    return fs.access(this.filePath).then(() => true, () => false);
  }

  write(data) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: this.mode });
      await fs.rename(tmp, this.filePath);
      // rename 不带权限位：显式再收一次（老文件可能是 0644）
      await fs.chmod(this.filePath, this.mode).catch(() => {});
    });
    return this.queue;
  }

  remove() {
    this.queue = this.queue.catch(() => {}).then(() => fs.rm(this.filePath, { force: true }));
    return this.queue;
  }
}

/** 文件是否存在（同步用它区分"从没配过"与"配过但是默认值"）。 */
export const exists = (filePath) => fs.access(filePath).then(() => true, () => false);
