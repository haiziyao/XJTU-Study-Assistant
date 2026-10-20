import path from 'node:path';
import { HttpError } from '../../core/http/router.js';
import { extractImportedDocument } from './docx.js';
import { firstImageAttachment, recognizeImageDataUrl } from './ocr.js';

const SOURCES = new Set(['manual', 'snapshot', 'import']);
const STATUSES = new Set(['draft', 'unorganized', 'processing', 'ready', 'failed', 'archived']);
const MAX_BODY_CHARS = 200000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_DATA = 9 * 1024 * 1024;
const MAX_OCR_CHARS = 20000;
const VERSION_LIMIT = 50;
const AUTO_VERSION_MS = 5 * 60 * 1000;
const CANVAS_SCHEMA_VERSION = 2;
const MAX_CANVAS_NODES = 500;
const MAX_CANVAS_EDGES = 1000;

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

/**
 * Canvas v2：普通卡片与原“思维导图节点”使用同一模型。
 * 这里只返回兼容视图，不改写集合；旧数据会在用户下一次保存画布时自然升级。
 */
function normalizeCanvas(value = {}) {
  const rawNodes = Array.isArray(value.nodes) ? value.nodes.slice(0, MAX_CANVAS_NODES) : [];
  const nodes = rawNodes.map((raw, index) => {
    const node = { ...raw };
    node.id = cleanText(node.id, 120) || `node-${index + 1}`;
    if (node.type === 'mind') node.type = 'text';
    node.type = ['text', 'file', 'group'].includes(node.type) ? node.type : 'text';
    node.parentId = node.parentId ? String(node.parentId) : null;
    node.order = Number.isFinite(Number(node.order)) ? Number(node.order) : index;
    node.collapsed = Boolean(node.collapsed);
    node.locked = Boolean(node.locked);
    delete node.mindMapId;
    delete node.mindLevel;
    delete node.role;
    return node;
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(value.edges) ? value.edges : []).slice(0, MAX_CANVAS_EDGES).map((raw, index) => {
    const edge = { ...raw };
    edge.id = cleanText(edge.id, 120) || `edge-${index + 1}`;
    edge.fromNode = String(edge.fromNode ?? '');
    edge.toNode = String(edge.toNode ?? '');
    edge.kind = edge.kind === 'hierarchy' || edge.kind === 'association' ? edge.kind : edge.mindmap ? 'hierarchy' : 'association';
    delete edge.mindmap;
    delete edge.mindMapId;
    return edge;
  }).filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode) && edge.fromNode !== edge.toNode);

  // 旧版层级同时写在 parentId 与 mindmap edge 中。优先保留 parentId，缺失时从旧连线补齐。
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    if (edge.kind !== 'hierarchy') continue;
    const child = byId.get(edge.toNode);
    if (child && !child.parentId) child.parentId = edge.fromNode;
  }
  for (const node of nodes) if (node.parentId && !ids.has(node.parentId)) node.parentId = null;

  // 损坏的历史数据不能让整张画布打不开：发现环时只把该节点提升为根节点。
  for (const node of nodes) {
    const seen = new Set([node.id]); let cursor = node;
    while (cursor.parentId) {
      if (seen.has(cursor.parentId)) { node.parentId = null; break; }
      seen.add(cursor.parentId); cursor = byId.get(cursor.parentId);
      if (!cursor) break;
    }
  }

  const hierarchyPairs = new Set(edges.filter((edge) => edge.kind === 'hierarchy').map((edge) => `${edge.fromNode}:${edge.toNode}`));
  for (const node of nodes) if (node.parentId && !hierarchyPairs.has(`${node.parentId}:${node.id}`)) {
    edges.push({ id: `hierarchy-${node.id}`, fromNode: node.parentId, toNode: node.id, kind: 'hierarchy', lineType: 'curve', lineStyle: 'solid', arrow: 'none' });
  }
  return {
    ...value,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    revision: Math.max(0, Number(value.revision) || 0),
    nodes,
    edges,
    viewport: value.viewport && typeof value.viewport === 'object' ? { ...value.viewport } : { x: 0, y: 0, zoom: 1 },
  };
}

function validateCanvas(value) {
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  if (rawNodes.length > MAX_CANVAS_NODES) throw HttpError.badRequest(`单个画布最多 ${MAX_CANVAS_NODES} 个节点`);
  if (rawEdges.length > MAX_CANVAS_EDGES) throw HttpError.badRequest(`单个画布最多 ${MAX_CANVAS_EDGES} 条连线`);

  // 写入时必须拒绝坏结构；只有读取历史数据时才由 normalizeCanvas 做温和修复。
  const rawIds = new Set();
  for (let index = 0; index < rawNodes.length; index += 1) {
    const id = cleanText(rawNodes[index]?.id, 120) || `node-${index + 1}`;
    if (rawIds.has(id)) throw HttpError.badRequest(`画布节点 ID 重复：${id}`);
    rawIds.add(id);
  }
  const rawParents = new Map();
  for (const node of rawNodes) {
    if (!node?.parentId) continue;
    const id = cleanText(node.id, 120);
    const parentId = String(node.parentId);
    if (!rawIds.has(parentId)) throw HttpError.badRequest('父节点不存在');
    rawParents.set(id, parentId);
  }
  for (const edge of rawEdges) {
    const from = String(edge?.fromNode ?? ''); const to = String(edge?.toNode ?? '');
    if (!rawIds.has(from) || !rawIds.has(to)) throw HttpError.badRequest('画布连线引用了不存在的节点');
    if (from === to) throw HttpError.badRequest('节点不能连接到自己');
    const kind = edge.kind === 'hierarchy' || edge.mindmap ? 'hierarchy' : 'association';
    if (kind !== 'hierarchy') continue;
    const previous = rawParents.get(to);
    if (previous && previous !== from) throw HttpError.badRequest('一个节点只能有一个层级父节点');
    rawParents.set(to, from);
  }
  for (const id of rawIds) {
    const seen = new Set([id]); let cursor = id;
    while (rawParents.has(cursor)) {
      cursor = rawParents.get(cursor);
      if (seen.has(cursor)) throw HttpError.badRequest('层级关系不能形成循环');
      seen.add(cursor);
    }
  }

  const canvas = normalizeCanvas(value);
  const ids = new Set();
  for (const node of canvas.nodes) {
    if (ids.has(node.id)) throw HttpError.badRequest(`画布节点 ID 重复：${node.id}`);
    ids.add(node.id);
  }
  const parents = new Map();
  for (const edge of canvas.edges) {
    if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) throw HttpError.badRequest('画布连线引用了不存在的节点');
    if (edge.fromNode === edge.toNode) throw HttpError.badRequest('节点不能连接到自己');
    if (edge.kind !== 'hierarchy') continue;
    const previous = parents.get(edge.toNode);
    if (previous && previous !== edge.fromNode) throw HttpError.badRequest('一个节点只能有一个层级父节点');
    parents.set(edge.toNode, edge.fromNode);
  }
  for (const node of canvas.nodes) {
    if (node.parentId && !ids.has(node.parentId)) throw HttpError.badRequest('父节点不存在');
    if (node.parentId && parents.has(node.id) && parents.get(node.id) !== node.parentId) throw HttpError.badRequest('节点父级与层级连线不一致');
    if (node.parentId) parents.set(node.id, node.parentId);
  }
  for (const id of ids) {
    const seen = new Set([id]); let cursor = id;
    while (parents.has(cursor)) {
      cursor = parents.get(cursor);
      if (seen.has(cursor)) throw HttpError.badRequest('层级关系不能形成循环');
      seen.add(cursor);
    }
  }
  canvas.nodes.forEach((node) => { node.parentId = parents.get(node.id) || null; });
  return canvas;
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

/**
 * 图片指纹：判断"这篇笔记里的图片还是不是上次识别的那张"。
 *
 * 用**文件名 + 类型 + 字节数 + dataUrl 长度**而不是整段 dataUrl 做键：
 * 随手拍的 dataUrl 有 380 万字符，把它塞进每条笔记的摘要里只为比一下"变没变"太亏。
 * 这四样凑起来足以区分"换了张图"与"同一张图又保存了一次正文" ——
 * 后者不该再跑一遍 OCR（Vision 一张要几百毫秒到几秒，还很吃 CPU）。
 * 没有图片附件时返回 `null`（明确表示"这篇没有图可识别"，与"还没识别"区分开）。
 */
function imageFingerprint(attachments) {
  const images = (Array.isArray(attachments) ? attachments : []).filter((item) => String(item?.type ?? '').startsWith('image/'));
  if (!images.length) return null;
  return images.map((item) => `${item.name}|${item.type}|${item.size}|${String(item.dataUrl ?? '').length}`).join(';');
}

/** OCR 结果落库前的清洗：只留约定字段，文本截断，`at` 由调用方给。 */
function normalizeOcr(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ocr = {
    ok: Boolean(value.ok),
    text: String(value.text ?? '').slice(0, MAX_OCR_CHARS),
    chars: Math.max(0, Number(value.chars) || 0),
    engine: String(value.engine ?? '').slice(0, 60),
    at: String(value.at ?? '').slice(0, 40),
  };
  if (value.error) ocr.error = String(value.error).slice(0, 200);
  return ocr;
}

/**
 * "还没识别"的占位值。
 *
 * 为什么不用 `null` 表示"排队中"：`null` 与"这篇笔记没有图片"完全同形，
 * 模型和界面都无法区分"等一下就有"和"永远不会有"。用 `ok:false` + `error:'pending'`
 * 把三态说清楚：排队中 / 识别失败 / 识别成功（哪怕成功但一个字都没识别出来）。
 */
function pendingOcr() {
  return { ok: false, text: '', chars: 0, engine: '', at: '', error: 'pending' };
}

/**
 * 送去检索/回答的图片文字：**只有识别成功且非空**才算数。
 *
 * 识别失败（没装 swiftc、超时、图里没字）时返回空串 —— 空串不会污染关键词匹配，
 * 而"没识别到"这件事由 `ocr.ok/error` 字段告诉模型，不需要往正文里塞一句假文字。
 */
function ocrBody(record) {
  const ocr = record?.ocr;
  return ocr && ocr.ok && typeof ocr.text === 'string' ? ocr.text : '';
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
    // 图片识别结果（见 ocr.js）：识别文本同样截断，避免一条坏数据把整份笔记文件撑大
    ocr: normalizeOcr(record.ocr),
  };
}

export function noteSummary(record, matchText = '') {
  const item = normalized(record);
  return {
    id: item.id, title: item.title, source: item.source, status: item.status, anchor: item.anchor ?? null, tags: item.tags ?? [],
    folder: item.folder, aliases: item.aliases, properties: item.properties, favorite: item.favorite, links: item.links,
    revision: item.revision, deletedAt: item.deletedAt, mediaCount: item.mediaCount ?? 0, ocr: item.ocr,
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

/**
 * 参与关键词匹配的全部文本。
 *
 * **OCR 文本在这里**：随手拍笔记的正文是空的，字全在图片里；不把识别结果并进来，
 * "我刚拍的那张写了什么"这类查询就永远匹配不到那条笔记（这正是要修的那个 bug）。
 * 没有识别结果时 `ocrBody()` 给空串，等于没加任何东西。
 */
function searchable(item) {
  return [item.title, item.body, ocrBody(item), item.folder, ...(item.tags ?? []), ...(item.aliases ?? []), ...Object.values(item.properties ?? {}).flat()]
    .filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();
}

/**
 * 暴露给别的检索入口（`aisearch` 的 note 源按自己的评分公式召回笔记）。
 * 各入口的打分方式不同，但"哪些文本算这篇笔记的内容"必须只有一处定义 ——
 * 否则统一检索会搜不到笔记模块自己搜得到的东西。
 */
export function noteSearchText(item) {
  return [String(item?.body ?? ''), ocrBody(item)].filter(Boolean).join('\n');
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

/**
 * 搜索命中处的一段摘要。正文为空但有识别文本时用识别文本（随手拍就是这种情况）——
 * 否则列表里那条笔记会显示成"什么都没有"，而它其实是有内容的。
 */
function excerpt(item, spec) {
  const needle = [...spec.phrases, ...spec.include][0];
  const text = String(item.body ?? '').replace(/\s+/g, ' ').trim() || ocrBody(item).replace(/\s+/g, ' ').trim();
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
  /**
   * @param {object} deps
   * @param {Function} [deps.recognize] 图片文字识别实现（默认本机 Vision，见 ocr.js）。
   *   注入点是为测试留的：CI 上没有 swiftc，用假引擎就能验证"识别 → 写回 → 广播"整条链路。
   * @param {string} [deps.dataDir] 数据目录：编译好的 OCR 小工具放在 `<dataDir>/.ocr`。
   */
  constructor({ store, broadcast, recognize, dataDir, services = null, audit = null }) {
    this.collection = store.notes; this.versionsCollection = store.noteVersions; this.templatesCollection = store.noteTemplates;
    this.viewsCollection = store.noteViews; this.canvasesCollection = store.noteCanvases; this.broadcast = broadcast;
    // 用户经界面/HTTP 写笔记时记一条 actor:'user'；AI 执行草稿期间（services.__actor === 'ai'）
    // 跳过，因为 chat-service 会为同一次写入记 actor:'ai'（避免一条改动两条日志）。
    this.services = services; this.audit = audit;
    // 属性名**不能**叫 `recognize`：那是下面同步重识别方法的原型方法名，
    // 同名实例属性会把它整个盖掉（那个 bug 会让 POST /notes/:id/ocr 连不存在的笔记都返回 200）。
    this.ocrEngine = typeof recognize === 'function' ? recognize : recognizeImageDataUrl;
    this.ocrAssetDir = dataDir ? path.join(dataDir, '.ocr') : null;
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
    const fingerprint = imageFingerprint(attachments);
    const item = await this.collection.insert({
      title: cleanText(input.title) || '未命名笔记', source: SOURCES.has(input.source) ? input.source : 'manual',
      status: STATUSES.has(input.status) ? input.status : body || attachments.length ? 'ready' : 'draft', anchor: anchorOf(input.anchor),
      tags: tagsOf(input.tags), folder: cleanText(input.folder, 300), aliases: uniqueText(input.aliases, 20), properties: propertiesOf(input.properties),
      favorite: Boolean(input.favorite), mediaCount: Math.max(0, Number(input.mediaCount) || attachments.filter((file) => file.type.startsWith('image/')).length),
      format: input.format === 'text' ? 'text' : 'markdown', body, attachments, links: parseWikiLinks(body), revision: 1, deletedAt: null,
      // 「还没识别」的初值：`ok:false` + `error:'pending'` 明确区别于"识别过、图里没字"。
      // 没有图片附件时留 null —— 一篇纯文字笔记不该显示"图片识别中"。
      ocr: fingerprint ? pendingOcr() : null, ocrFingerprint: fingerprint,
    });
    const summary = noteSummary(item);
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'created', summary } });
    if (this.services?.__actor !== 'ai') this.audit?.record({ actor: 'user', source: 'api', module: 'note', action: 'create', targetId: item.id, title: item.title, after: item });
    // 后台异步跑，**不阻塞 HTTP**：随手拍 3.8MB 的 dataUrl 走一次 Vision 要几百毫秒到几秒，
    // 卡在响应里会让"按下快门 → 等保存"变得明显。
    this.#scheduleOcr(item.id, fingerprint);
    return summary;
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
    /**
     * **刻意不碰附件、也不在这里重排 OCR**（保持既有语义）：
     * 编辑接口只允许改编辑字段，附件、来源、日历关联由创建方负责 ——
     * `test/notes-routes.test.js` 明确断言"PATCH 传 `attachments: []` 也不会清掉已有附件"，
     * 笔记模块是协作者的地盘，这条语义不能顺手改掉。
     * 图片没变就没有重新识别的理由（"内容未变不重复识别"）：要重跑走 `POST /notes/:id/ocr`
     * （`recognize()`），识别失败后的重试也在那里。
     */
    if (!Object.keys(patch).length) return noteSummary(current);
    const rename = patch.title && patch.title !== current.title;
    await this.snapshot(current, cleanText(input.versionReason, 40) || (rename ? 'rename' : 'autosave'), rename || input.versionReason === 'manual');
    patch.revision = current.revision + 1;
    const item = await this.collection.update(String(id), patch);
    if (rename) await this.updateRenamedLinks(current.title, patch.title, id);
    const summary = noteSummary(item); this.broadcast?.({ type: 'notes_changed', payload: { action: 'updated', summary } });
    if (this.services?.__actor !== 'ai') this.audit?.record({ actor: 'user', source: 'api', module: 'note', action: 'update', targetId: String(id), title: summary.title, before: current, after: item });
    return summary;
  }

  /* ------------------------------------------------------------ 图片文字识别（OCR） */

  /**
   * 后台排一次识别。**故意不 await、故意不把异常抛出去**：
   * 识别是"锦上添花"的能力，失败也必须让创建/更新照常成功
   * （真出问题时结果里会留下 `ocr.ok:false` + `error`，用户看得见、也能重试）。
   */
  #scheduleOcr(id, fingerprint) {
    const noteId = String(id);
    const source = this.ocrEngine;
    const assetDir = this.ocrAssetDir;
    Promise.resolve()
      .then(async () => {
        const note = this.get(noteId, { includeDeleted: true });
        const image = firstImageAttachment(note.attachments);
        if (!image) return null;
        const raw = await source(image.dataUrl, { assetDir });
        return { raw, fingerprint };
      })
      .then((outcome) => (outcome ? this.#storeOcr(noteId, outcome.raw, outcome.fingerprint) : null))
      .catch((error) => {
        // 走到这里说明连"取笔记 / 找图片"都失败了（笔记已被永久删除是最常见的一种）：静默记录即可
        this.broadcast?.({ type: 'notes_ocr_failed', payload: { id: noteId, message: String(error?.message ?? error) } });
      });
  }

  /** 把识别结果写回笔记并广播；笔记在识别期间被删掉就安静放弃。 */
  async #storeOcr(id, raw, fingerprint) {
    const result = raw && typeof raw === 'object' ? raw : {};
    const text = String(result.text ?? '');
    const ocr = normalizeOcr({
      ok: result.ok === true,
      text: result.ok === true ? text : '',
      chars: result.ok === true ? (Number(result.chars) || text.length) : 0,
      engine: result.ok === true ? (result.engine ?? 'macos-vision') : '',
      at: new Date().toISOString(),
      error: result.ok === true ? undefined : (result.reason ?? 'failed'),
    });
    try {
      const item = await this.collection.update(String(id), { ocr, ocrFingerprint: fingerprint ?? null });
      const summary = noteSummary(item);
      // 与笔记其它变更同一口径（`notes_changed`）广播：渲染层据此刷新，也能看到"图片识别完成"
      this.broadcast?.({ type: 'notes_changed', payload: { action: 'ocr', summary } });
      return summary;
    } catch {
      return null;
    }
  }

  /**
   * 同步重识别（`POST /notes/:id/ocr`，"重新识别"按钮走这里）。
   *
   * 与后台那一路共用同一套识别实现，区别只是**等它跑完再返回** —— 用户点了按钮，
   * 就该看到明确结果，而不是"过一会儿再看列表"。
   */
  async recognize(id) {
    const current = this.get(id);
    const image = firstImageAttachment(current.attachments);
    const fingerprint = imageFingerprint(current.attachments);
    if (!image) {
      return { ok: false, reason: 'bad_image', message: '这篇笔记里没有图片附件，没有可识别的文字' };
    }
    const raw = await this.ocrEngine(image.dataUrl, { assetDir: this.ocrAssetDir });
    await this.#storeOcr(current.id, raw, fingerprint);
    const stored = this.collection.get(String(current.id));
    return { ...(stored?.ocr ?? normalizeOcr({ ...raw, at: new Date().toISOString() })), reason: raw?.reason, message: raw?.message };
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
      if (this.services?.__actor !== 'ai') this.audit?.record({ actor: 'user', source: 'api', module: 'note', action: 'delete', targetId: String(id), title: current.title, before: current, summary: '永久删除笔记' });
      return { deleted: true, permanent: true, id: String(id) };
    }
    await this.snapshot(current, 'delete', true);
    const deletedAt = new Date().toISOString(); await this.collection.update(String(id), { deletedAt, revision: current.revision + 1 });
    this.broadcast?.({ type: 'notes_changed', payload: { action: 'deleted', id: String(id) } });
    if (this.services?.__actor !== 'ai') this.audit?.record({ actor: 'user', source: 'api', module: 'note', action: 'delete', targetId: String(id), title: current.title, before: current });
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

  listResource(kind) { return this[`${kind}Collection`].all().map((item) => normalizeCanvas(item)); }
  getResource(kind, id) { const item = this[`${kind}Collection`].get(String(id)); if (!item) throw HttpError.notFound('画布不存在'); return normalizeCanvas(item); }
  async createResource(kind, input = {}) {
    const canvas = validateCanvas({ name: cleanText(input.name) || '未命名画布', nodes: input.nodes, edges: input.edges, viewport: input.viewport, revision: 0 });
    return this.canvasesCollection.insert(canvas);
  }
  async updateResource(kind, id, input = {}) {
    const current = this.getResource(kind, id);
    if (input.revision !== undefined && Number(input.revision) !== current.revision) throw HttpError.conflict('画布已在其他位置更新，请刷新后重试');
    const merged = validateCanvas({ ...current, ...Object.fromEntries(['name', 'nodes', 'edges', 'viewport'].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])), revision: current.revision + 1 });
    return this[`${kind}Collection`].update(String(id), merged);
  }
  async removeResource(kind, id) { this.getResource(kind, id); await this[`${kind}Collection`].remove(String(id)); return { deleted: true, id: String(id) }; }

  queryForAI({ ids, query, limit = 10 } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String)); const spec = searchSpec(query); const size = Math.min(20, Math.max(1, Number(limit) || 10));
    return this.all().filter((item) => (!wanted.size || wanted.has(item.id)) && matchesSearch(item, spec))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, size).map((item) => ({
        id: item.id, title: item.title, format: item.format === 'text' ? 'text' : 'markdown', text: String(item.body ?? '').slice(0, 12000),
        // 图片笔记的正文是空的，字全在 ocr.text 里；不给模型这个字段，它就只能回答"正文是空的"
        ocr: item.ocr,
        tags: item.tags ?? [], folder: item.folder, aliases: item.aliases, properties: item.properties, links: item.links, anchor: item.anchor ?? null, updatedAt: item.updatedAt,
      }));
  }
}
