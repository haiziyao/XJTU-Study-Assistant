/**
 * 模块注册表：扫描 `src/modules/<id>/module.js` 并装配成有序的模块列表。
 *
 * 这是「新增功能 = 新建一个目录」得以成立的关键：框架不再逐个 import 具体模块，
 * 而是读目录。因此两个人各加一个模块时，不会修改到同一个文件。
 *
 * 目录约定：
 *   - 每个子目录 = 一个模块；入口文件名固定为 `module.js`
 *   - 以 `.` 或 `_` 开头的目录被忽略（放草稿 / 共享工具用）
 *   - 没有 `module.js` 的目录会被跳过并告警，不影响启动
 */

import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defineModule } from './contract.js';

/** 默认模块目录：app/src/modules */
export const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

const ENTRY_FILE = 'module.js';

const exists = (file) => access(file).then(() => true, () => false);

/**
 * 加载全部模块描述符。
 * @param {object} [options]
 * @param {string} [options.dir]   模块根目录，默认 `src/modules`
 * @param {string[]} [options.only] 只加载这些 id（测试时用）
 * @returns {Promise<object[]>} 按 order 升序、同 order 按 id 字典序的模块列表
 */
export async function loadModules({ dir = MODULES_DIR, only } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const filter = only ? new Set(only) : null;
  const ids = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .filter((id) => !filter || filter.has(id))
    .sort();

  const modules = [];
  for (const id of ids) {
    const sourceDir = path.join(dir, id);
    const entryFile = path.join(sourceDir, ENTRY_FILE);
    if (!(await exists(entryFile))) {
      console.warn(`[modules] 跳过 ${id}：目录下没有 ${ENTRY_FILE}`);
      continue;
    }
    const loaded = await import(pathToFileURL(entryFile).href);
    if (!loaded.default) {
      console.warn(`[modules] 跳过 ${id}：${ENTRY_FILE} 没有默认导出`);
      continue;
    }
    modules.push(defineModule(loaded.default, { sourceDir }));
  }

  modules.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return modules;
}

/** 模块摘要，供 `GET /api/v1/modules` 自描述（不含函数）。 */
export function describeModules(modules) {
  return modules.map((mod) => ({
    id: mod.id,
    title: mod.title,
    order: mod.order,
    apiVersion: mod.apiVersion,
    collections: mod.collections.map((spec) => spec.name),
    hooks: ['createServices', 'registerRoutes', 'restore', 'start', 'stop'].filter((hook) => typeof mod[hook] === 'function'),
  }));
}
