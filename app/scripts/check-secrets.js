#!/usr/bin/env node
/**
 * 凭据泄漏扫描。
 *
 * 用途：在把代码推到远程之前，确认**测试账号 / 密码没有落进任何会被提交的文件**。
 *
 * 关键设计：敏感串**从不写进本文件**，只从环境变量读取 —— 因此这个脚本本身可以安全入库。
 *
 *   # Windows PowerShell
 *   $env:PC_EHALL_USER='...'; $env:PC_EHALL_PASS='...'; npm run check:secrets
 *   # macOS / Linux
 *   PC_EHALL_USER='...' PC_EHALL_PASS='...' npm run check:secrets
 *
 * 还可以额外扫描任意串（逗号分隔）：
 *   PC_SECRETS_EXTRA='张三,2021001' npm run check:secrets
 *
 * 扫描范围 = 「可能被提交的内容」。**默认扫到仓库根**（`app/` 的上一级，存在 `.git`
 * 或根 `.gitignore` 时才算），因为要上传的是整个仓库而不是 `app/` —— 仓库根下还有
 * `参考/` 这类目录，只扫 `app/` 会留一个看不见的缺口（这个缺口真的存在过）。
 * 跳过 `.git` / node_modules / data / dist / out 等已知不入库的目录，并跳过二进制与大文件。
 * 不依赖 git 命令，因此在任何环境下都能跑。
 *
 * 退出码：0 = 干净；1 = 命中（会打印 文件:行号:片段）；2 = 没给敏感串（fail-closed）。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包（`app/`）的根。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 实际扫描起点：优先仓库根（`app/` 的上一级），拿不到就退回 `app/`。
 *
 * 为什么要往上找：`npm run check:secrets` 在 `app/` 下执行，但 `git push` 推的是整个仓库。
 * 仓库根可能还有别的目录（本项目就有 `参考/`），只扫 `app/` 等于没扫全。
 * 用「存在 .git 或根 .gitignore」来判定，避免把 `app/` 拷到别处时误扫到无关目录。
 */
async function resolveScanRoot() {
  const candidate = path.resolve(PACKAGE_ROOT, '..');
  if (candidate === PACKAGE_ROOT) return PACKAGE_ROOT;
  for (const marker of ['.git', '.gitignore']) {
    try {
      await stat(path.join(candidate, marker));
      return candidate;
    } catch {
      /* 换下一个标记 */
    }
  }
  return PACKAGE_ROOT;
}

/** 这些目录不会进仓库，跳过（`.git` 尤其要跳过：里面本来就有历史）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', 'out', '.electron-bundle', '.cache']);
/** 二进制/大文件跳过。 */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.zip', '.pdf', '.exe', '.dll', '.node']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 收集敏感串：去掉空白与过短的值（1~2 个字符的串会把整个仓库都扫成命中）。 */
function collectSecrets() {
  const raw = [process.env.PC_EHALL_USER, process.env.PC_EHALL_PASS, ...(process.env.PC_SECRETS_EXTRA ?? '').split(',')];
  return [...new Set(raw.map((item) => String(item ?? '').trim()).filter((item) => item.length >= 4))];
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    yield full;
  }
}

/**
 * 在一个文件里找所有敏感串。
 * @returns {Promise<Array<{ line: number, secret: string, text: string }>>}
 */
async function scanFile(file, secrets) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return [];
  }
  if (info.size > MAX_FILE_BYTES) return [];

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  // 含 NUL 视为二进制，跳过
  if (text.includes('\u0000')) return [];

  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const secret of secrets) {
      if (lines[index].includes(secret)) {
        // 回显时把命中串本身打码，避免扫描报告又把凭据写进日志/终端历史
        hits.push({ line: index + 1, secret, text: lines[index].trim().slice(0, 160).replaceAll(secret, '«已打码»') });
      }
    }
  }
  return hits;
}

async function main() {
  const secrets = collectSecrets();
  if (!secrets.length) {
    console.error('没有可扫描的敏感串。请先设置环境变量（fail-closed，不当作通过）：');
    console.error("  $env:PC_EHALL_USER='<学号>'; $env:PC_EHALL_PASS='<密码>'; npm run check:secrets");
    console.error('也可以附加 PC_SECRETS_EXTRA 扫描姓名、其它账号等。');
    process.exitCode = 2;
    return;
  }

  const root = await resolveScanRoot();
  const found = [];
  let scanned = 0;
  for await (const file of walk(root)) {
    scanned += 1;
    const hits = await scanFile(file, secrets);
    for (const hit of hits) found.push({ file: path.relative(root, file), ...hit });
  }

  const scope = path.relative(PACKAGE_ROOT, root) || '(app)';
  if (!found.length) {
    console.log(`干净：扫描 ${scanned} 个文件（范围 ${scope === '(app)' ? 'app/' : `${scope}/ 整个仓库`}），${secrets.length} 个敏感串均未出现。`);
    return;
  }

  console.error(`!! 发现 ${found.length} 处命中 —— 提交前必须清理：\n`);
  for (const hit of found) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
  console.error('\n注意：命中可能是无关的巧合（例如学号同时是别的数字），请逐个确认。');
  process.exitCode = 1;
}

await main();
