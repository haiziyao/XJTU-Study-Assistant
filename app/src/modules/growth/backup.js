/**
 * 备份与恢复：把成长模块的核心集合打成一个 JSON，随时能带走、能放回来。
 *
 * 本地优先的承诺里，"数据是你的"这句话只有在**能导出去也能导回来**时才成立。
 *
 * 两条安全规则：
 * 1. 恢复前先把当前数据整份写进 `archive/pre-restore-<时间>.json`，
 *    恢复错了还能回去；
 * 2. 只接受本程序导出的格式（`app: "brain-online"` + `collections`），
 *    不做"猜你要导入什么"的宽容解析 —— 猜错就是数据丢失。
 *
 * 与源项目的差别（AI key）：
 * 源项目的备份里 `ai-config` 是它自己的密钥文件，`?secrets=1` 会把密钥带出去。
 * 成长模块现在**不持有密钥**（密钥在 XJTU ai 模块的私有文件里），
 * 所以这里永远只导出非密钥字段；恢复时备份里的 `apiKey` 一律丢弃，绝不写进成长集合。
 * 备份仍然是 `app: "brain-online"`，这样 Brain Online 导出的旧备份也能直接恢复。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { badRequest } from './errors.js';
import { iso } from './time.js';
import { collection, doc, writeJsonFile } from './store-utils.js';
import { ARCHIVE_DIRNAME } from './session.js';

export const COLLECTIONS = ['states', 'plans', 'tasks', 'sessions', 'logs'];
export const DOCS = ['character', 'ai-config', 'template-overrides'];
const FORMAT = 1;

const COLLECTION_MAP = {
  states: 'growthStates',
  plans: 'growthPlans',
  tasks: 'growthTasks',
  sessions: 'growthSessions',
  logs: 'growthLogs',
};

const DOC_MAP = {
  character: 'growthRpg',
  // AI 回落配置与提醒设置同集合、不同记录（id='ai'）
  'ai-config': 'growthSettings',
  'template-overrides': 'growthTemplates',
};

/** 文档在集合里的记录 id：只有 ai-config 不是默认的 'doc'。 */
const DOC_IDS = { 'ai-config': 'ai' };

export function createBackupService({ store, clock, dataDir }) {
  const archiveDir = path.join(dataDir, ARCHIVE_DIRNAME);

  /** 导出整库。AI key 永远不进入成长模块的备份（理由见文件头）。 */
  async function exportBundle() {
    const collections = {};
    for (const name of COLLECTIONS) collections[name] = await collection(store, COLLECTION_MAP[name]).all();

    const docs = {};
    for (const name of DOCS) docs[name] = await doc(store, DOC_MAP[name], {}, DOC_IDS[name] ?? 'doc').read();
    if (docs['ai-config']) {
      docs['ai-config'] = { ...docs['ai-config'], apiKey: '' };
    }

    const counts = Object.fromEntries(Object.entries(collections).map(([name, rows]) => [name, rows.length]));
    return {
      app: 'brain-online',
      format: FORMAT,
      exportedAt: iso(clock.now()),
      counts,
      collections,
      docs,
    };
  }

  /** 恢复：先留档，再逐集合替换。 */
  async function restoreBundle(bundle) {
    if (!bundle || typeof bundle !== 'object' || bundle.app !== 'brain-online') {
      throw badRequest('INVALID_BACKUP', '这不是 Brain Online 的备份文件');
    }
    if (Number(bundle.format ?? 0) > FORMAT) {
      throw badRequest('BACKUP_TOO_NEW', '备份来自更新的版本，当前程序还不认识它的格式');
    }
    if (!bundle.collections || typeof bundle.collections !== 'object') {
      throw badRequest('INVALID_BACKUP', '备份里没有 collections');
    }
    for (const name of COLLECTIONS) {
      const rows = bundle.collections[name];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) throw badRequest('INVALID_BACKUP', `collections.${name} 不是数组`);
    }

    // 1) 先给当前数据留一份
    let snapshotFile = null;
    try {
      const snapshot = await exportBundle();
      const name = `pre-restore-${iso(clock.now()).replace(/[^0-9]/g, '').slice(0, 14)}.json`;
      await fs.mkdir(archiveDir, { recursive: true });
      const file = path.join(archiveDir, name);
      await writeJsonFile(file, snapshot);
      snapshotFile = name;
    } catch (err) {
      throw badRequest('SNAPSHOT_FAILED', `恢复前的自动存档失败，已中止恢复：${err.message}`);
    }

    // 2) 逐集合替换（走模块适配层，内存缓存与磁盘保持一致）
    const counts = {};
    for (const name of COLLECTIONS) {
      const rows = bundle.collections[name];
      if (!Array.isArray(rows)) continue;
      counts[name] = await collection(store, COLLECTION_MAP[name]).replace(rows);
    }

    // 3) 单文档
    const docs = {};
    for (const name of DOCS) {
      const value = bundle.docs?.[name];
      if (!value || typeof value !== 'object') continue;
      const clean = { ...value };
      // AI key 不属于成长模块：旧备份里的 key 直接丢弃，绝不写进集合
      delete clean.apiKey;
      await doc(store, DOC_MAP[name], {}, DOC_IDS[name] ?? 'doc').set(clean);
      docs[name] = true;
    }

    return { ok: true, counts, docs, snapshotFile, restoredAt: iso(clock.now()) };
  }

  return { exportBundle, restoreBundle };
}

export { FORMAT as BACKUP_FORMAT };
