import { HttpError } from '../../core/http/router.js';
import { extractImportedDocument } from './docx.js';

const SOURCES = new Set(['manual', 'snapshot', 'import']);
const STATUSES = new Set(['draft', 'unorganized', 'processing', 'ready', 'failed', 'archived']);
const MAX_BODY_CHARS = 200000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_DATA = 9 * 1024 * 1024;
const VERSION_LIMIT = 50;
const AUTO_VERSION_MS = 5 * 60 * 1000;

const cleanText = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const uniqueText = (value, max = 20) => [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item)).filter(Boolean))].slice(0, max);

function anchorOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value.date ?? ''))) return { type: 'date', date: String(value.date) };
  if (value.type === 'schedule' && value.scheduleId && /^\d{4}-\d{2}-\d{2}$/.test(String(value.occurrenceDate ?? ''))) {
    return { type: 'schedule', scheduleId: String(value.scheduleId), occurrenceDate: String(value.occurrenceDate) };
  }
  return null;
}

function tagsOf(value) { return uniqueText(value, 24); }

function propertiesOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 40)) {
    const key = cleanText(rawKey, 60);
    if (!key) continue;
    if (Array.isArray(rawValue)) result[key] = uniqueText(rawValue, 30);
    else if (['string', 'number', 'boolean'].includes(typeof rawValue) || rawValue === null) result[key] = typeof rawValue === 'string' ? rawValue.slice(0, 1000) : rawValue;
  }
  return result;
}

function attachmentsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ATTACHMENTS).map((item) => {
    const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl : '';
    if (dataUrl.length > MAX_ATTACHMENT_DATA) throw HttpError.badRequest(`附件 ${item?.name ?? ''} 过大`);
    return {
      name: String(item?.name ?? '附件').slice(0, 200), type: String(item?.type ?? 'application/octet-stream').slice(0, 100),
      size: Math.max(0, Number(item?.size) || 0), dataUrl,
    };
  });
}

/** Parse Obsidian-style [[title]], [[title|alias]] and [[title#heading]]. */
export function parseWikiLinks(body) {
  const links = [];
  const seen = new Set();
  const pattern = /\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  for (const match of String(body ?? '').matchAll(pattern)) {
    const target = cleanText(match[1], 200);
    if (!target) continue;
    const entry = { target, heading: cleanText(match[2], 200) || null, alias: cleanText(match[3], 200) || null };
    const key = `${entry.target.toLowerCase()}#${entry.heading ?? ''}|${entry.alias ?? ''}`;
    if (!seen.has(key)) { seen.add(key); links.push(entry); }
  }
  return links.slice(0, 500);
}

function normalized(record) {
  const importedBody = String(record.body ?? '') || (record.attachments ?? []).map(extractImportedDocument).find(Boolean) || '';
  return {
    ...record,
    title: cleanText(record.title) || '未命名笔记', folder: cleanText(record.folder, 300), aliases: uniqueText(record.aliases, 20),
    body: importedBody, properties: propertiesOf(record.properties), favorite: Boolean(record.favorite), links: parseWikiLinks(importedBody),
    revision: Math.max(1, Number(record.revision) || 1), deletedAt: record.deletedAt ?? null,
  };
}

export function noteSummary(record, matchText = '') {
  const item = normalized(record);
  return {
    id: item.id, title: item.title, source: item.source, status: item.status, anchor: item.anchor ?? null, tags: item.tags ?? [],
    folder: item.folder, aliases: item.aliases, properties: item.properties, favorite: item.favorite, links: item.links,
    revision: item.revision, deletedAt: item.deletedAt, mediaCount: item.mediaCount ?? 0,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
    previewText: String(item.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
    ...(matchText ? { matchText } : {}),
  };
}

function searchSpec(input) {
  const text = String(input ?? '').trim();
  const phrases = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1].toLowerCase());
  const rest = text.replace(/"[^"]+"/g, ' ');
  const filters = {}; const include = []; const exclude = [];
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const pair = token.match(/^(tag|folder|course|type|status):(.+)$/i);
    if (pair) filters[pair[1].toLowerCase()] = pair[2].toLowerCase();
    else if (token.startsWith('-') && token.length > 1) exclude.push(token.slice(1).toLowerCase());
    else include.push(token.toLowerCase());
  }
  return { phrases, include, exclude, filters };
}

function searchable(item) {
  return [item.title, item.body, item.folder, ...(item.tags ?? []), ...(item.aliases ?? []), ...Object.values(item.properties ?? {}).flat()]
    .filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();
}

function matchesSearch(item, spec) {
  const haystack = searchable(item);
  if (![...spec.phrases, ...spec.include].every((word) => haystack.includes(word))) return false;
  if (spec.exclude.some((word) => haystack.includes(word))) return false;
  const props = item.properties ?? {};
  if (spec.filters.tag && !(item.tags ?? []).some((tag) => tag.toLowerCase().includes(spec.filters.tag))) return false;
  if (spec.filters.folder && !String(item.folder ?? '').toLowerCase().includes(spec.filters.folder)) return false;
  for (const key of ['course', 'type', 'status']) {
    if (spec.filters[key] && !String(key === 'status' ? item.status : props[key] ?? '').toLowerCase().includes(spec.filters[key])) return false;
  }
  return true;
}

function excerpt(item, spec) {
  const needle = [...spec.phrases, ...spec.include][0];
  const text = String(item.body ?? '').replace(/\s+/g, ' ').trim();
  if (!needle) return text.slice(0, 180);
  const at = text.toLowerCase().indexOf(needle);
  return at < 0 ? text.slice(0, 180) : text.slice(Math.max(0, at - 60), at + needle.length + 100);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const BUILTIN_TEMPLATES = [
  { id: 'builtin-class', name: '课堂笔记', builtin: true, body: '# {{title}}\n\n## 核心概念\n\n## 课堂例题\n\n## 疑问\n\n## 课后总结\n', properties: { type: '课堂笔记', status: '学习中' } },
  { id: 'builtin-mistake', name: '错题笔记', builtin: true, body: '# {{title}}\n\n## 原题\n\n## 错误原因\n\n## 正确解法\n\n## 相似题\n', properties: { type: '错题', status: '待复习', mastery: 1 } },
  { id: 'builtin-lab', name: '实验报告', builtin: true, body: '# {{title}}\n\n## 实验目的\n\n## 原理\n\n## 过程与数据\n\n## 结论\n', properties: { type: '实验报告', status: '草稿' } },
  { id: 'builtin-paper', name: '论文阅读', builtin: true, body: '# {{title}}\n\n## 研究问题\n\n## 方法\n\n## 主要结论\n\n## 局限\n\n## 与已有知识的联系\n', properties: { type: '论文阅读', status: '阅读中' } },
  { id: 'builtin-daily', name: '每日学习记录', builtin: true, body: '# {{date}} 学习记录\n\n## 今日目标\n\n- [ ] \n\n## 学习记录\n\n## 明日计划\n', properties: { type: '每日笔记', status: '进行中' } },
];

export class NoteService {
  constructor({ store, broadcast }) {
    this.collection = store.notes; this.versionsCollection = store.noteVersions; this.templatesCollection = store.noteTemplates;
    this.viewsCollection = store.noteViews; this.canvasesCollection = store.noteCanvases; this.broadcast = broadcast;
  }

  all({ deleted = false } = {}) { return this.collection.all().map(normalized).filter((item) => deleted ? Boolean(item.deletedAt) : !item.deletedAt); }

  list({ source, status, query, tag, folder, favorite, deleted = 'false', limit = 100 } = {}) {
    const spec = searchSpec(query); const wantDeleted = String(deleted) === 'true'; const size = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.all({ deleted: wantDeleted }).filter((item) => {
      if (source && item.source !== source) return false;
      if (status && item.status !== status) return false;
      if (tag && !(item.tags ?? []).includes(tag)) return false;
      if (folder && item.folder !== folder) return false;
      if (favorite === 'true' && !item.favorite) return false;
      return matchesSearch(item, spec);
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, size)
      .map((item) => noteSummary(item, query ? excerpt(item, spec) : ''));
  }

  get(id, { includeDeleted = false } = {}) {
    const raw = this.collection.get(String(id));
    if (!raw || (raw.deletedAt && !includeDeleted)) throw HttpError.notFound('笔记不存在');
    return normalized(raw);
  }

  resolveMap() {
    const map = new Map();
    for (const item of this.all()) for (const name of [item.title, ...item.aliases]) if (name) map.set(name.toLowerCase(), item);
    return map;
  }

  async create(input = {}) {
    const attachments = attachmentsOf(input.attachments);
    const body = (String(input.body ?? '') || attachments.map(extractImportedDocument).find(Boolean) || '').slice(0, MAX_BODY_CHARS);
    const item = await this.collection.insert({
      title: cleanText(input.title) || '未命名笔记', source: SOURCES.has(input.source) ? input.source : 'manual',
      status: STATUSES.has(input.status) ? input.status : body || attachments.length ? 'ready' : 'draft', anchor: anchorOf(input.anchor),
      tags: tagsOf(input.tags), folder: cleanText(input.folder, 300), aliases: uniqueText(input.aliases, 20), properties: propertiesOf(input.properties),
      favorite: Boolean(input.favorite), mediaCount: Math.max(0, Number(input.mediaCount) || attachments.filter((file) => file.type.startsWith('image/')).length),
      format: input.format === 'text' ? 'text' : 'markdown', body, attachments, links: parseWikiLinks(body), revision: 1, deletedAt: null,
    });
    const summary = noteSummary(item); this.broadcast?.({ type: 'notes_changed', payload: { action: 'created', summary } }); return summary;
  }

  async snapshot(item, reason = 'manual', force = false) {
    if (!this.versionsCollection) return;
    const previous = this.versionsCollection.all().filter((version) => version.noteId === item.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!force && reason === 'autosave' && previous[0] && Date.now() - Date.parse(previous[0].createdAt) < AUTO_VERSION_MS) return;
    await this.versionsCollection.insert({ noteId: item.id, reason, snapshot: normalized(item) });
    const versions = this.versionsCollection.all().filter((version) => version.noteId === item.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const old of versions.slice(VERSION_LIMIT)) await this.versionsCollection.remove(old.id);
  }

  async update(id, input = {}) {
    const current = this.get(id);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) throw HttpError.conflict('这篇笔记已在其他页面更新。请保留当前正文，重新打开最新版本后再保存。');
    const patch = {};
    if (input.title !== undefined) patch.title = cleanText(input.title) || '未命名笔记';
    if (input.body !== undefined) {
      if (typeof input.body !== 'string' || input.body.length > MAX_BODY_CHARS) throw HttpError.badRequest(`笔记正文必须是文本，且不能超过 ${MAX_BODY_CHARS} 字符`);
      patch.body = input.body; patch.links = parseWikiLinks(input.body);
    }
    if (input.tags !== undefined) patch.tags = tagsOf(input.tags);
    if (input.folder !== undefined) patch.folder = cleanText(input.folder, 300);
    if (input.aliases !== undefined) patch.aliases = uniqueText(input.aliases, 20);
    if (input.properties !== undefined) patch.properties = propertiesOf(input.properties);
    if (input.favorite !== undefined) patch.favorite = Boolean(input.favorite);
    if (input.format !== undefined) { if (!['markdown', 'text'].includes(input.format)) throw HttpError.badRequest('不支持的笔记格式'); patch.format = input.format; }
    if (input.status !== undefined) { if (!STATUSES.has(input.status)) throw HttpError.badRequest('不支持的笔记状态'); patch.status = input.status; }
    if (!Object.keys(patch).length) return noteSummary(current);
    const rename = patch.title && patch.title !== current.title;
    await this.snapshot(current, cleanText(input.versionReason, 40) || (rename ? 'rename' : 'autosave'), rename || input.versionReason === 'manual');
    patch.revision = current.revision + 1;
    const item = await this.collection.update(String(id), patch);
    if (rename) await this.updateRenamedLinks(current.title, patch.title, id);
    const summary = noteSummary(item); this.broadcast?.({ type: 'notes_changed', payload: { action: 'updated', summary } }); return summary;
  }

  async updateRenamedLinks(oldTitle, newTitle, targetId) {
    const pattern = new RegExp(`\\[\\[${escapeRegExp(oldTitle)}(?=(?:#|\\||\\]\\]))`, 'gi');
    for (const item of this.all()) {
      if (item.id === targetId || !pattern.test(item.body ?? '')) { pattern.lastIndex = 0; continue; }
      pattern.lastIndex = 0; const body = item.body.replace(pattern, `[[${newTitle}`);
      await this.collection.update(item.id, { body, links: parseWikiLinks(body), revision: item.revision + 1 });
    }
  }

  async remove(id, { permanent = false } = {}) {
    const current = this.get(id, { includeDeleted: true });
    if (permanent) {
      if (!current.deletedAt) throw HttpError.conflict('请先将笔记移入回收站');
      await this.collection.remove(String(id));
      for (const version of this.versionsCollection.all().filter((item) => item.noteId === String(id))) await this.versionsCollection.remove(version.id);
      this.broadcast?.({ type: 'notes_changed', payload: { action: 'deleted', id: String(id) } });
      return { deleted: true, permanent: true, id: String(id) };
    }
    await this.snapshot(current, 'delete', true);
    const deletedAt = new Date().toISOString(); await this.collection.update(String(id), { deletedAt, revision: current.revision + 1 });
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'deleted', id: String(id) } });
    return { deleted: true, permanent: false, id: String(id), deletedAt };
  }

  async restore(id) {
    const current = this.get(id, { includeDeleted: true });
    if (!current.deletedAt) return noteSummary(current);
    const item = await this.collection.update(String(id), { deletedAt: null, revision: current.revision + 1 });
    const summary = noteSummary(item); this.broadcast?.({ type: 'notes_changed', payload: { action: 'updated', summary } }); return summary;
  }

  versions(id) { this.get(id, { includeDeleted: true }); return this.versionsCollection.all().filter((item) => item.noteId === String(id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }

  async restoreVersion(id, versionId) {
    const current = this.get(id, { includeDeleted: true }); const version = this.versionsCollection.get(String(versionId));
    if (!version || version.noteId !== String(id)) throw HttpError.notFound('历史版本不存在');
    await this.snapshot(current, 'before-restore', true);
    const source = version.snapshot; const patch = { ...source, deletedAt: null, revision: current.revision + 1 };
    delete patch.id; delete patch.createdAt; delete patch.updatedAt;
    const item = await this.collection.update(String(id), patch); return noteSummary(item);
  }

  links(id) {
    const current = this.get(id); const map = this.resolveMap();
    const outgoing = current.links.map((link) => ({ ...link, targetId: map.get(link.target.toLowerCase())?.id ?? null }));
    const backlinks = []; const unlinked = [];
    for (const item of this.all()) {
      if (item.id === current.id) continue;
      const matchingLinks = item.links.filter((link) => map.get(link.target.toLowerCase())?.id === current.id);
      if (matchingLinks.length) backlinks.push({ ...noteSummary(item), mentions: matchingLinks });
      else {
        const at = String(item.body ?? '').toLowerCase().indexOf(current.title.toLowerCase());
        if (at >= 0) unlinked.push({ ...noteSummary(item), matchText: String(item.body).slice(Math.max(0, at - 60), at + current.title.length + 100) });
      }
    }
    return { outgoing, backlinks, unlinked };
  }

  graph({ id, depth = 2, course, folder, tag } = {}) {
    const items = this.all().filter((item) => (!course || item.properties.course === course) && (!folder || item.folder === folder) && (!tag || item.tags.includes(tag)));
    const allowed = new Map(items.map((item) => [item.id, item])); const names = this.resolveMap(); const edges = [];
    for (const item of items) for (const link of item.links) {
      const target = names.get(link.target.toLowerCase()); if (target && allowed.has(target.id)) edges.push({ source: item.id, target: target.id, heading: link.heading });
    }
    let selected = new Set(allowed.keys());
    if (id && allowed.has(String(id))) {
      selected = new Set([String(id)]);
      for (let level = 0; level < Math.min(4, Math.max(1, Number(depth) || 2)); level += 1) {
        for (const edge of edges) if (selected.has(edge.source) || selected.has(edge.target)) { selected.add(edge.source); selected.add(edge.target); }
      }
    }
    return {
      nodes: [...selected].map((nodeId) => { const item = allowed.get(nodeId); return { id: item.id, title: item.title, folder: item.folder, tags: item.tags, properties: item.properties, favorite: item.favorite }; }),
      edges: edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
    };
  }

  templates() { return [...BUILTIN_TEMPLATES, ...this.templatesCollection.all()]; }
  template(id) { const item = BUILTIN_TEMPLATES.find((one) => one.id === id) ?? this.templatesCollection.get(String(id)); if (!item) throw HttpError.notFound('模板不存在'); return item; }
  async createTemplate(input) { return this.templatesCollection.insert({ name: cleanText(input.name) || '未命名模板', body: String(input.body ?? '').slice(0, MAX_BODY_CHARS), properties: propertiesOf(input.properties) }); }
  async updateTemplate(id, input) { if (String(id).startsWith('builtin-')) throw HttpError.conflict('内置模板不能修改'); const current = this.template(id); return this.templatesCollection.update(current.id, { ...(input.name !== undefined ? { name: cleanText(input.name) || current.name } : {}), ...(input.body !== undefined ? { body: String(input.body).slice(0, MAX_BODY_CHARS) } : {}), ...(input.properties !== undefined ? { properties: propertiesOf(input.properties) } : {}) }); }
  async removeTemplate(id) { if (String(id).startsWith('builtin-')) throw HttpError.conflict('内置模板不能删除'); this.template(id); await this.templatesCollection.remove(String(id)); return { deleted: true, id: String(id) }; }
  async instantiateTemplate(id, input = {}) {
    const template = this.template(id); const now = new Date(); const date = String(input.date ?? now.toISOString().slice(0, 10)); const time = now.toTimeString().slice(0, 5); const title = cleanText(input.title) || template.name;
    const replace = (text) => String(text).replaceAll('{{title}}', title).replaceAll('{{date}}', date).replaceAll('{{time}}', time).replaceAll('{{course}}', cleanText(input.course));
    return this.create({ ...input, title, body: replace(template.body), properties: { ...template.properties, ...propertiesOf(input.properties) }, source: 'manual' });
  }

  async daily(date = new Date().toISOString().slice(0, 10)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw HttpError.badRequest('日期格式必须是 YYYY-MM-DD');
    const existing = this.all().find((item) => item.properties.dailyDate === date); if (existing) return noteSummary(existing);
    return this.instantiateTemplate('builtin-daily', { title: `${date} 学习记录`, date, folder: '每日笔记', properties: { dailyDate: date } });
  }

  listResource(kind) { return this[`${kind}Collection`].all(); }
  getResource(kind, id) { const item = this[`${kind}Collection`].get(String(id)); if (!item) throw HttpError.notFound(kind === 'views' ? '视图不存在' : '画布不存在'); return item; }
  async createResource(kind, input = {}) {
    if (kind === 'views') return this.viewsCollection.insert({ name: cleanText(input.name) || '未命名视图', layout: ['table', 'cards', 'kanban'].includes(input.layout) ? input.layout : 'table', filters: propertiesOf(input.filters), sort: cleanText(input.sort, 60) || 'updatedAt:desc', groupBy: cleanText(input.groupBy, 60) });
    return this.canvasesCollection.insert({ name: cleanText(input.name) || '未命名画布', nodes: Array.isArray(input.nodes) ? input.nodes.slice(0, 500) : [], edges: Array.isArray(input.edges) ? input.edges.slice(0, 1000) : [], viewport: input.viewport && typeof input.viewport === 'object' ? input.viewport : { x: 0, y: 0, zoom: 1 } });
  }
  async updateResource(kind, id, input = {}) { this.getResource(kind, id); const allowed = kind === 'views' ? ['name', 'layout', 'filters', 'sort', 'groupBy'] : ['name', 'nodes', 'edges', 'viewport']; const patch = {}; for (const key of allowed) if (input[key] !== undefined) patch[key] = input[key]; return this[`${kind}Collection`].update(String(id), patch); }
  async removeResource(kind, id) { this.getResource(kind, id); await this[`${kind}Collection`].remove(String(id)); return { deleted: true, id: String(id) }; }

  queryForAI({ ids, query, limit = 10 } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String)); const spec = searchSpec(query); const size = Math.min(20, Math.max(1, Number(limit) || 10));
    return this.all().filter((item) => (!wanted.size || wanted.has(item.id)) && matchesSearch(item, spec))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, size).map((item) => ({
        id: item.id, title: item.title, format: item.format === 'text' ? 'text' : 'markdown', text: String(item.body ?? '').slice(0, 12000),
        tags: item.tags ?? [], folder: item.folder, aliases: item.aliases, properties: item.properties, links: item.links, anchor: item.anchor ?? null, updatedAt: item.updatedAt,
      }));
  }
}
