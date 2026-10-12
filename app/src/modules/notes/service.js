import { HttpError } from '../../core/http/router.js';

const SOURCES = new Set(['manual', 'snapshot', 'import']);
const STATUSES = new Set(['draft', 'processing', 'ready', 'failed']);
const MAX_BODY_CHARS = 200000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_DATA = 750000;

function anchorOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value.date ?? ''))) {
    return { type: 'date', date: String(value.date) };
  }
  if (value.type === 'schedule' && value.scheduleId && /^\d{4}-\d{2}-\d{2}$/.test(String(value.occurrenceDate ?? ''))) {
    return { type: 'schedule', scheduleId: String(value.scheduleId), occurrenceDate: String(value.occurrenceDate) };
  }
  return null;
}

function tagsOf(value) {
  return Array.isArray(value) ? value.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 12) : [];
}

function attachmentsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ATTACHMENTS).map((item) => {
    const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl : '';
    if (dataUrl.length > MAX_ATTACHMENT_DATA) throw HttpError.badRequest(`附件 ${item?.name ?? ''} 过大`);
    return {
      name: String(item?.name ?? '附件').slice(0, 200),
      type: String(item?.type ?? 'application/octet-stream').slice(0, 100),
      size: Math.max(0, Number(item?.size) || 0),
      dataUrl,
    };
  });
}

export function noteSummary(record) {
  return {
    id: record.id,
    title: record.title,
    source: record.source,
    status: record.status,
    anchor: record.anchor ?? null,
    tags: record.tags ?? [],
    mediaCount: record.mediaCount ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    previewText: String(record.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

export class NoteService {
  constructor({ store, broadcast }) {
    this.collection = store.notes;
    this.broadcast = broadcast;
  }

  list({ source, status, query, limit = 100 } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    const size = Math.min(100, Math.max(1, Number(limit) || 100));
    return this.collection.all().filter((item) => {
      if (source && item.source !== source) return false;
      if (status && item.status !== status) return false;
      if (needle && ![item.title, item.body, ...(item.tags ?? [])].join(' ').toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, size).map(noteSummary);
  }

  get(id) {
    const item = this.collection.get(String(id));
    if (!item) throw HttpError.notFound('笔记不存在');
    return item;
  }

  async create(input = {}) {
    const body = String(input.body ?? '').slice(0, MAX_BODY_CHARS);
    const attachments = attachmentsOf(input.attachments);
    const item = await this.collection.insert({
      title: String(input.title ?? '').trim().slice(0, 200) || '未命名笔记',
      source: SOURCES.has(input.source) ? input.source : 'manual',
      status: STATUSES.has(input.status) ? input.status : body || attachments.length ? 'ready' : 'draft',
      anchor: anchorOf(input.anchor),
      tags: tagsOf(input.tags),
      mediaCount: Math.max(0, Number(input.mediaCount) || attachments.filter((file) => file.type.startsWith('image/')).length),
      format: input.format === 'text' ? 'text' : 'markdown',
      body,
      attachments,
    });
    const summary = noteSummary(item);
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'created', summary } });
    return summary;
  }

  async update(id, input = {}) {
    const current = this.get(id);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
      throw HttpError.conflict('这篇笔记已在其他页面更新。请保留当前正文，重新打开最新版本后再保存。');
    }
    const patch = {};
    if (input.title !== undefined) patch.title = String(input.title).trim().slice(0, 200) || '未命名笔记';
    if (input.body !== undefined) {
      if (typeof input.body !== 'string' || input.body.length > MAX_BODY_CHARS) {
        throw HttpError.badRequest(`笔记正文必须是文本，且不能超过 ${MAX_BODY_CHARS} 字符`);
      }
      patch.body = input.body;
    }
    if (input.tags !== undefined) patch.tags = tagsOf(input.tags);
    if (input.format !== undefined) {
      if (!['markdown', 'text'].includes(input.format)) throw HttpError.badRequest('不支持的笔记格式');
      patch.format = input.format;
    }
    if (input.status !== undefined) {
      if (!STATUSES.has(input.status)) throw HttpError.badRequest('不支持的笔记状态');
      patch.status = input.status;
    }
    const item = await this.collection.update(String(id), patch);
    const summary = noteSummary(item);
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'updated', summary } });
    return summary;
  }

  async remove(id) {
    this.get(id);
    await this.collection.remove(String(id));
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'deleted', id: String(id) } });
    return { ok: true, deleted: true, id: String(id) };
  }

  queryForAI({ ids, query, limit = 10 } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
    const needle = String(query ?? '').trim().toLowerCase();
    const size = Math.min(20, Math.max(1, Number(limit) || 10));
    return this.collection.all().filter((item) => {
      if (wanted.size && !wanted.has(item.id)) return false;
      if (needle && ![item.title, item.body, ...(item.tags ?? [])].join(' ').toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, size).map((item) => ({
      id: item.id,
      title: item.title,
      format: item.format === 'text' ? 'text' : 'markdown',
      text: String(item.body ?? '').slice(0, 12000),
      tags: item.tags ?? [],
      anchor: item.anchor ?? null,
      updatedAt: item.updatedAt,
    }));
  }
}
