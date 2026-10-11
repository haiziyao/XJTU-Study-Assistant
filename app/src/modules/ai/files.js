/**
 * 文件服务：把图片上传到上游 Files API，之后用 `file_id` 引用。
 *
 * 官方（api-docs.deepseek.com/zh-cn/guides/files_api）的要点：
 *   - `POST /files`，`multipart/form-data`，字段 `file` + `purpose=user_data`（**必填**）；
 *   - 响应 `{ id: "file-api-…", bytes, created_at, filename, purpose }`；
 *   - 对话里用 `{ type: "file", file_id: "…" }` 引用；**只有图片**（JPEG/PNG/GIF/WebP）；
 *   - 单文件 64 MiB（比内联 base64 的 32 MiB 宽），单用户 25 GiB / 10000 个文件。
 *
 * 为什么要本地记一份（`aiFiles` 集合）：
 *   1. **按内容去重**：同一张图第二轮再发就不重复上传（官方推荐的用法就是"多轮复用"）；
 *   2. 把 `file_id` 记在消息附件上，历史里能看出这张图当时用的是哪个文件；
 *   3. 本地能列出/删除，不至于在平台上留一堆自己都不知道的垃圾文件。
 *
 * 本地只存**元信息**（hash / 名字 / 大小 / file_id），不存图片字节：
 * 原始字节属于平台侧，本地再存一份等于双倍隐私面。
 */

import { createHash } from 'node:crypto';

import { HttpError } from '../../core/http/router.js';

/** 官方支持的图片格式（按内容判断，这里只能按声明的 MIME 先筛）。 */
const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

/** data URL → 字节；不是 data URL 或不是 base64 就返回 null。 */
export function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
  if (!match) return null;
  const [, mime, isBase64, payload] = match;
  try {
    const bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime: mime || '', bytes };
  } catch {
    return null;
  }
}

/** 内容指纹：同一张图重复发送时用它命中本地记录。 */
export function contentHash(dataUrl) {
  if (!dataUrl) return null;
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return null;
  return createHash('sha256').update(decoded.bytes).digest('hex');
}

export class AiFiles {
  /**
   * @param {object} deps
   * @param {object} deps.store 全局 store（用 `store.aiFiles` 这个集合）
   * @param {object} deps.provider AI provider（提供 uploadFile / listFiles / deleteFile）
   */
  constructor({ store, provider }) {
    this.store = store;
    this.provider = provider;
  }

  list() {
    const items = (this.store.aiFiles?.all?.() ?? [])
      .slice()
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    const bytes = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    return { ok: true, count: items.length, bytes, items };
  }

  get(id) {
    const record = this.store.aiFiles?.get?.(id);
    if (!record) throw HttpError.notFound(`本地没有文件记录 ${id}`);
    return record;
  }

  /** 问上游要一份文件列表（本地记录之外的真源）。 */
  async listUpstream() {
    return this.provider.listFiles();
  }

  /**
   * 上传一个附件（图片）。已有同内容记录时**直接复用**，不再打上游。
   * 返回 `{ fileId, reused }`；非图片或不是 data URL 时返回 `null`（调用方决定怎么办）。
   */
  async ensureUploaded(file) {
    if (!file?.dataUrl) return null;
    if (!IMAGE_TYPES.includes(String(file.type ?? '').toLowerCase())) return null;

    const hash = contentHash(file.dataUrl);
    if (hash) {
      const existing = (this.store.aiFiles?.all?.() ?? []).find((item) => item.hash === hash);
      if (existing?.fileId) return { fileId: existing.fileId, reused: true, record: existing };
    }

    const decoded = decodeDataUrl(file.dataUrl);
    if (!decoded || !decoded.bytes.length) return null;

    const uploaded = await this.provider.uploadFile({
      filename: String(file.name ?? 'image').slice(0, 512),
      contentType: file.type || decoded.mime || 'application/octet-stream',
      bytes: decoded.bytes,
    });

    const record = await this.store.aiFiles.insert({
      hash,
      name: String(file.name ?? 'image').slice(0, 512),
      type: file.type || decoded.mime || '',
      size: decoded.bytes.length,
      fileId: uploaded.id,
      upstream: uploaded,
    });
    return { fileId: uploaded.id, reused: false, record };
  }

  /** 删本地记录 + 删上游文件（上游失败也把本地删掉，否则会一直重试失败的那个）。 */
  async remove(id) {
    const record = this.get(id);
    let upstream = null;
    let upstreamError = null;
    if (record.fileId) {
      try {
        upstream = await this.provider.deleteFile(record.fileId);
      } catch (error) {
        upstreamError = error?.message ?? String(error);
      }
    }
    await this.store.aiFiles.remove(record.id);
    return { ok: true, deleted: true, id: record.id, fileId: record.fileId, upstream, upstreamError };
  }
}
