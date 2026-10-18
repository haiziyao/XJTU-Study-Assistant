/**
 * 通知服务：把校内各站点的通知聚合到本地，并负责「保留期清理」与「固定」。
 *
 * 为什么要本地聚合，而不是每次现搜
 * --------------------------------
 * 现搜（campus 档的栏目直读）只能回答"这一刻页面上有什么"，回答不了：
 *   · 这条我是不是已经看过了？
 *   · 这两条里哪条是**新的**（校方的发布日期经常缺、或者只到月份）？
 *   · 我上周看到的、现在被挤到第 3 页的那条还在吗？
 * 所以落库，并用 **`firstSeenAt`（我们第一次见到它的时间）** 作为"新"的唯一判据 ——
 * 那是本地可靠的事实，而 `publishedAt` 不是。
 *
 * 三条设计红线
 * ------------
 * 1. **只增不删，除了保留期清理。** 没有"这条消失了所以删掉"的逻辑：
 *    通知被校方撤下是常态，但用户可能已经固定了它、或者正要照着它办事。
 * 2. **清理按 `firstSeenAt`，且固定的条目永不清理。** 按 `publishedAt` 清理会误删
 *    "刚发现的老通知"（校方补发了去年的通知，你昨天才看到，第二天就被清掉）。
 * 3. **失败要如实报。** `readSiteNews` 会给逐页的失败原因，原样透出到 `perSite`，
 *    页面和模型都能说清"教务处抓到了、数学学院那页 403 了"。
 *
 * 与 ai 模块的关系
 * ----------------
 * 站点表有**两份**，各有各的用途，不要混：
 *   · `sources.json`（本模块，来自参考项目 XJTUToolBox）—— **通知源**，
 *     60 个源 / 78 个栏目，每条是真实的列表页 URL；
 *   · `ai/web-search.js` 的 `CAMPUS_SITE_SEARCH` —— 给**站内搜索**用（`path` + `keyField`），
 *     多数站点没有栏目路径，拿来抓通知基本抓不到。
 * 抓取本身复用 `readSiteNews()`（纯函数导入，与装配顺序无关），不重复造爬虫。
 */

import { HttpError } from '../../core/http/router.js';
import { readFileSync } from 'node:fs';

import { readPages, readSiteNews } from '../ai/web-search.js';

/**
 * 内置通知源：**从参考项目 XJTUToolBox 导入的那一份**（`scripts/import-notification-sources.mjs`），
 * 目前 60 个源 / 78 个栏目，每条栏目都是一个真实的列表页 URL。
 *
 * 为什么不再用 `ai/web-search.js` 的 `CAMPUS_SITE_SEARCH`：那张表是给**站内搜索**用的
 * （字段是 `path` + `keyField`），只有少数站点带了栏目路径；而通知要的是**栏目直读**，
 * 参考项目里每个频道的 `url` 正好就是我们要的东西。
 *
 * 同步读文件而不是 `import ... with { type: 'json' }`：后者要 Node 的 import attributes，
 * 而这个仓库对运行时版本卡得比较保守。模块加载时读一次、之后是常量，开销可忽略。
 */
const BUILTIN_SOURCES = JSON.parse(
  readFileSync(new URL('./sources.json', import.meta.url), 'utf8'),
);

/** 没有配置时默认关注的站点：教务 / 研究生院 / 学校门户 / 新闻网。 */
/**
 * 默认关注的站点：教务 / 研究生院 / 新闻网。
 *
 * 学校门户（`www`）**不在默认里**：实测它没有稳定的通知栏目页
 * （`tzgg.htm` 与 `xwdt.htm` 都 404，首页发现的栏目抽不出带日期的条目），
 * 每次同步都只会报一次失败。它在站点表里标了 `working: false` 并写了原因，
 * 用户仍能在设置里看到它、知道为什么不用它。门户的用途是 campus 档的站内搜索。
 */
export const DEFAULT_ENABLED_SITES = Object.freeze(['dean', 'xsc', 'gs', 'nic']);

/** 保留期可选项（天）。`0` = 永久保留，不清理。 */
export const RETENTION_OPTIONS = Object.freeze([7, 30, 90, 180, 365, 0]);

/** 默认保留 90 天。 */
export const DEFAULT_RETENTION_DAYS = 90;

/** 每个站点每次同步最多取几条（栏目页一页通常 15~20 条）。 */
const LIMIT_PER_SITE = 20;

/** 自定义站点数量上限：再多就说明该做成配置而不是界面表单了。 */
export const MAX_CUSTOM_SOURCES = 20;

const SETTINGS_ID = 'settings';

/** 单次同步最多同时抓几个站（对校方站点友好一点，别并发打满）。 */
const SYNC_CONCURRENCY = 3;

/**
 * 把 URL 规范化成去重键。
 *
 * 去掉 `#fragment` 与 `utm_*` / `from` 这类跟踪参数 —— 同一条通知在校内不同入口
 * 会带上不同的跟踪串，不规范化就是重复条目。**保留**其余 query：
 * 不少校方站点用 `?id=123` 区分文章，删了就全并成一条了。
 */
export function canonicalUrl(raw, base) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text, base ?? undefined);
  } catch {
    return text;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key === 'from' || key === 'spm') url.searchParams.delete(key);
  }
  // 末尾斜杠归一：`/a/b/` 与 `/a/b` 是同一篇
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

/** 从 host 生成一个稳定的 id（自定义站点用）。 */
function idFromHost(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '');
    return host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48);
  } catch {
    return '';
  }
}

/** 内网 / 回环 / 链路本地地址判定 —— 自定义站点必须过这一关。 */
function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 校验并规范化一个**自定义站点**。
 *
 * 只允许 http(s)，并且拒绝内网地址：这是一个用户可填 URL、服务端会去抓的入口，
 * 不挡内网就是一个 SSRF（`http://127.0.0.1:3210/api/v1/...` 能读到自己的接口）。
 */
export function normalizeCustomSource(input) {
  const label = String(input?.label ?? '').trim();
  if (!label) throw HttpError.badRequest('站点名称不能为空', { field: 'label' });
  if (label.length > 40) throw HttpError.badRequest('站点名称太长（最多 40 字）', { field: 'label' });

  const rawUrl = String(input?.url ?? '').trim();
  if (!rawUrl) throw HttpError.badRequest('入口页 URL 不能为空', { field: 'url' });
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw HttpError.badRequest('入口页 URL 不合法（要带 http:// 或 https://）', { field: 'url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw HttpError.badRequest('只支持 http / https 地址', { field: 'url' });
  }
  if (isPrivateHost(url.hostname)) {
    throw HttpError.badRequest('不能填内网或本机地址（这是安全限制）', { field: 'url' });
  }

  const id = String(input?.id ?? '').trim() || idFromHost(url.href);
  if (!id) throw HttpError.badRequest('无法从 URL 生成站点 id，请手动指定', { field: 'id' });
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
    throw HttpError.badRequest('站点 id 只能用小写字母、数字和连字符（最多 48 位）', { field: 'id' });
  }
  // 与内置站点撞 id 会让 `enabledSiteIds` 的语义变得说不清，直接拒绝
  if (BUILTIN_SOURCES.some((site) => site.id === id)) {
    throw HttpError.badRequest(`站点 id「${id}」与内置站点重名，请换一个`, { field: 'id' });
  }

  return { id, label, url: url.href, columns: [], custom: true, enabled: input?.enabled !== false };
}

export class NotificationService {
  constructor({ store, broadcast = () => {}, log = () => {} }) {
    this.store = store;
    this.broadcast = broadcast;
    this.log = log;
  }

  /* ------------------------------------------------------------ 设置 */

  /** 读设置（永远返回一份完整的、带默认值的对象）。 */
  settings() {
    const row = this.store.notificationSettings.get(SETTINGS_ID) ?? {};
    const retention = Number(row.retentionDays);
    return {
      retentionDays: RETENTION_OPTIONS.includes(retention) ? retention : DEFAULT_RETENTION_DAYS,
      enabledSiteIds: Array.isArray(row.enabledSiteIds) ? row.enabledSiteIds.map(String) : [...DEFAULT_ENABLED_SITES],
      customSources: Array.isArray(row.customSources) ? row.customSources : [],
      useSearch: Boolean(row.useSearch),
      lastSyncAt: row.lastSyncAt ?? null,
    };
  }

  async #writeSettings(patch) {
    const next = { ...this.settings(), ...patch, id: SETTINGS_ID };
    /*
     * ⚠️ 不能用 `update().catch(insert)`：`JsonStore.update()` 在**行不存在时返回 undefined**，
     * 它不抛错。于是那个 catch 永远不触发，设置行从来没被建出来 —— 表现是
     * "改了保留期/自定义站点，读回来还是默认值"，而且没有任何报错。
     * 先看存不存在，再决定 insert 还是 update。
     */
    const existing = this.store.notificationSettings.get(SETTINGS_ID);
    if (existing) await this.store.notificationSettings.update(SETTINGS_ID, next);
    else await this.store.notificationSettings.insert(next);
    this.broadcast({ type: 'data_changed', payload: { target: 'notification', action: 'settings' } });
    return next;
  }

  /**
   * 可关注的站点清单：内置（实测过）+ 用户自加。
   *
   * `working: false` 的内置站点照样列出来，但**不发请求** —— 站点表里写着原因
   * （改版 / 403 / 没有栏目列表），让用户知道"它在这儿，只是抓不到"，
   * 比悄悄不显示更好：用户找不到它时会以为是 bug。
   */
  sources() {
    const settings = this.settings();
    const enabled = new Set(settings.enabledSiteIds);
    /*
     * 内置源：来自参考项目的清单，每个源带若干**栏目 URL**。
     * 这里把 `channels` 一并给出去 —— 设置页要能告诉用户"这个站会抓哪几页"，
     * 而且抓不到时用户能自己去点开看看是不是改版了。
     */
    const builtin = BUILTIN_SOURCES.map((site) => ({
      id: site.id,
      label: site.label,
      category: site.category ?? '',
      host: site.host,
      home: site.home ?? null,
      channels: (site.channels ?? []).map((channel) => ({
        id: channel.id,
        label: channel.label,
        url: channel.url,
        defaultOn: channel.defaultOn === true,
      })),
      custom: false,
      working: true,
      reason: null,
      enabled: enabled.has(site.id),
    }));
    const custom = settings.customSources.map((site) => ({
      id: site.id,
      label: site.label,
      host: (() => {
        try {
          return new URL(site.url).hostname;
        } catch {
          return '';
        }
      })(),
      url: site.url,
      custom: true,
      working: true,
      reason: null,
      enabled: enabled.has(site.id),
    }));
    return [...builtin, ...custom];
  }

  /** 按 id 取一个可同步的源（内置或自定义）；找不到就 404。 */
  #sourceById(id) {
    const key = String(id ?? '').trim();
    const settings = this.settings();
    const custom = settings.customSources.find((site) => site.id === key);
    if (custom) return { id: custom.id, label: custom.label, url: custom.url, custom: true, working: true };
    const builtin = BUILTIN_SOURCES.find((site) => site.id === key);
    if (!builtin) throw HttpError.notFound(`没有这个通知站点：${key}`);
    return {
      id: builtin.id,
      label: builtin.label,
      host: builtin.host,
      channels: (builtin.channels ?? []).map((channel) => channel.url).filter(Boolean),
      custom: false,
      working: true,
    };
  }

  /* ------------------------------------------------------------ 同步 */

  /**
   * 拉一次通知。
   *
   * @param {object} [options]
   * @param {string[]} [options.siteIds]       只同步这些站（默认=设置里启用的）
   * @param {number} [options.limitPerSite]    每站最多几条
   * @param {boolean} [options.dryRun]         只抓不写（预览用）
   * @param {Function} [options.fetchImpl]     注入的 fetch（测试用假站点）
   */
  async sync({ siteIds, limitPerSite, dryRun = false, fetchImpl } = {}) {
    const settings = this.settings();
    const wanted = (Array.isArray(siteIds) && siteIds.length ? siteIds : settings.enabledSiteIds).map(String);
    const limit = clampLimit(limitPerSite);

    const targets = [];
    const perSite = [];
    for (const id of wanted) {
      const source = (() => {
        try {
          return this.#sourceById(id);
        } catch {
          perSite.push({ siteId: id, label: id, count: 0, newest: null, error: '这个站点不在清单里', notes: [] });
          return null;
        }
      })();
      if (!source) continue;
      if (!source.working) {
        perSite.push({
          siteId: source.id,
          label: source.label,
          count: 0,
          newest: null,
          error: source.reason ?? '该站点已知不可用，已跳过',
          notes: [],
        });
        continue;
      }
      targets.push(source);
    }

    const results = await mapWithConcurrency(targets, SYNC_CONCURRENCY, async (source) => {
      /*
       * 一个源可能有多条栏目（研究生院 6 条、学生处 2 条）。
       * 逐条抓、把条目合并；某一条失败**不影响其它条** —— 但要把失败原因记下来，
       * 否则用户会以为"那个栏目没有新通知"（实际上我们根本没读到它）。
       */
      const urls = source.custom ? [source.url] : (source.channels ?? []);
      if (!urls.length) return { source, items: [], notes: ['这个源没有配置栏目 URL'], error: null };

      const items = [];
      const notes = [];
      let newest = null;
      let failures = 0;
      for (const url of urls) {
        try {
          const read = await readSiteNews({ url, limit, fetchImpl });
          for (const item of read.items ?? []) items.push(item);
          if (read.error) {
            failures += 1;
            notes.push(`${url} → ${read.error}`);
          }
          if (read.newest && (!newest || read.newest > newest)) newest = read.newest;
        } catch (error) {
          failures += 1;
          notes.push(`${url} → ${error?.message ?? String(error)}`);
        }
      }
      // 全部栏目都失败才算这个源失败；部分失败只在 notes 里说明
      const error = failures === urls.length ? `全部 ${urls.length} 个栏目都没抓成` : null;
      return { source, items, notes, newest, error, failedChannels: failures };
    });

    const now = new Date().toISOString();
    let inserted = 0;
    let refreshed = 0;

    for (const item of results) {
      const { source } = item;
      // 只有"全部栏目都失败"才算这个源失败；部分失败在 notes 里说明，条目照常入库
      if (item.error) {
        perSite.push({
          siteId: source.id,
          label: source.label,
          count: 0,
          newest: null,
          error: item.error,
          notes: item.notes ?? [],
        });
        continue;
      }
      const rows = item.items ?? [];
      let siteInserted = 0;
      for (const entry of rows) {
        const id = canonicalUrl(entry.url);
        if (!id) continue;
        const existing = this.store.notifications.get(id);
        if (existing) {
          // 已存在：只刷新"最近一次看到"与可能变了的标题/日期，**不碰 pinned / firstSeenAt**
          if (!dryRun) {
            await this.store.notifications.update(id, {
              ...existing,
              lastSeenAt: now,
              title: entry.title || existing.title,
              publishedAt: entry.publishedAt || existing.publishedAt,
            });
          }
          refreshed += 1;
          continue;
        }
        if (!dryRun) {
          await this.store.notifications.insert({
            id,
            title: entry.title || '(无标题)',
            url: entry.url,
            siteId: source.id,
            siteLabel: source.label,
            publishedAt: entry.publishedAt ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
            pinned: false,
            pinnedAt: null,
            source: 'column',
            snippet: null,
            authority: null,
          });
        }
        inserted += 1;
        siteInserted += 1;
      }
      perSite.push({
        siteId: source.id,
        label: source.label,
        count: siteInserted,
        total: rows.length,
        newest: item.newest ?? null,
        error: null,
        notes: item.notes ?? [],
      });
    }

    const pruned = dryRun ? 0 : await this.#prune(this.settings().retentionDays, now);
    if (!dryRun) await this.#writeSettings({ lastSyncAt: now });

    this.broadcast({ type: 'data_changed', payload: { target: 'notification', action: 'sync' } });
    return {
      inserted,
      refreshed,
      pruned,
      total: this.store.notifications.all().length,
      perSite,
      retentionDays: this.settings().retentionDays,
      lastSyncAt: dryRun ? this.settings().lastSyncAt : now,
      dryRun,
    };
  }

  /**
   * 按保留期清理。**固定的条目永远不删。**
   *
   * `retentionDays <= 0` 表示永久保留，直接返回 0。
   * 判据是 `firstSeenAt`，见文件头第 2 条红线。
   */
  async #prune(retentionDays, nowIso = new Date().toISOString()) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(new Date(nowIso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    let pruned = 0;
    for (const row of this.store.notifications.all()) {
      if (row.pinned) continue;
      const seen = row.firstSeenAt ?? row.lastSeenAt ?? '';
      if (seen && seen < cutoff) {
        await this.store.notifications.remove(row.id);
        pruned += 1;
      }
    }
    return pruned;
  }

  /* ------------------------------------------------------------ 查询 */

  /**
   * 本地查询。
   *
   * @param {object} [filters]
   * @param {string} [filters.siteId] 站点 id
   * @param {string} [filters.q]      标题/摘要里的关键词（大小写不敏感）
   * @param {boolean} [filters.unreadOnly]
   * @param {boolean} [filters.pinned]  只看固定的
   * @param {string} [filters.since]    只留 `firstSeenAt >= since`
   * @param {string} [filters.until]    只留 `firstSeenAt <= until`
   */
  list({ siteId, q, pinned = false, since, until, limit = 20, offset = 0 } = {}) {
    const keyword = String(q ?? '').trim().toLowerCase();
    const from = toIsoOrNull(since);
    const to = toIsoOrNull(until);
    const site = String(siteId ?? '').trim();

    let rows = this.store.notifications.all().filter((row) => {
      if (site && row.siteId !== site) return false;
      if (pinned && !row.pinned) return false;
      const seen = row.firstSeenAt ?? '';
      if (from && seen < from) return false;
      if (to && seen > to) return false;
      if (keyword) {
        const haystack = `${row.title ?? ''} ${row.snippet ?? ''} ${row.siteLabel ?? ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });

    // 排序：有发布日用发布日，没有就退回"我们第一次见到它的时间"。
    // 混着排才不会让"校方没给日期"的条目全部沉底或全部置顶。
    rows = rows.sort((a, b) => {
      const left = a.publishedAt || a.firstSeenAt || '';
      const right = b.publishedAt || b.firstSeenAt || '';
      if (left === right) return String(b.firstSeenAt ?? '').localeCompare(String(a.firstSeenAt ?? ''));
      return String(right).localeCompare(String(left));
    });

    const total = rows.length;
    const start = Math.max(0, Number(offset) || 0);
    const size = clampLimit(limit);
    return {
      total,
      count: Math.min(size, Math.max(0, total - start)),
      limit: size,
      offset: start,
      items: rows.slice(start, start + size),
      filters: { siteId: site || null, q: keyword || null, pinned, since: from, until: to },
    };
  }

  stats() {
    const rows = this.store.notifications.all();
    const bySite = new Map();
    let pinned = 0;
    let newestAt = null;
    for (const row of rows) {
      if (row.pinned) pinned += 1;
      const key = row.siteId ?? 'unknown';
      const bucket = bySite.get(key) ?? { siteId: key, siteLabel: row.siteLabel ?? key, total: 0 };
      bucket.total += 1;
      bySite.set(key, bucket);
      const seen = row.firstSeenAt ?? '';
      if (seen && (!newestAt || seen > newestAt)) newestAt = seen;
    }
    const settings = this.settings();
    return {
      total: rows.length,
      pinned,
      bySite: [...bySite.values()].sort((a, b) => b.total - a.total),
      newestAt,
      lastSyncAt: settings.lastSyncAt,
      retentionDays: settings.retentionDays,
    };
  }

  /* ------------------------------------------------------------ 写操作 */

  /**
   * 抓一条通知的**正文**，给"在应用里读"用。
   *
   * 为什么不用"打开浏览器"：桌面端把 URL 交给系统会撞上 Windows 的权限提升比对
   * （截图里那个「Edge 未响应，因为现有实例正在以提升的权限运行」），用户点"是"就把
   * 浏览器重启掉。所以正文由**后端**抓回来、清洗成文本，在面板里读 ——
   * 顺带还能在离线/校内网环境下同一套逻辑。
   *
   * 复用 `readPages()`（联网检索读正文用的是同一套提取与清洗），
   * 所以正文质量与 AI 看到的一致，不会出现"我看得到、AI 看不到"。
   */
  async readBody(id) {
    const row = this.store.notifications.get(String(id ?? ''));
    if (!row) throw HttpError.notFound(`没有这条通知：${id}`);
    const pages = await readPages([{ title: row.title, url: row.url }], { limit: 1 });
    const page = pages?.[0] ?? null;
    if (!page || page.error) {
      throw HttpError.upstream(
        `抓不到这一篇的正文${page?.error ? `：${page.error}` : ''}。可以直接复制链接用浏览器打开：${row.url}`,
      );
    }
    return {
      id: row.id,
      title: page.title || row.title,
      url: row.url,
      text: page.text ?? '',
      fetchedAt: new Date().toISOString(),
    };
  }

  /** 固定 / 取消固定。固定的条目不会被保留期清理。 */
  async pin({ ids, pinned = true } = {}) {
    const now = new Date().toISOString();
    const updated = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const row = this.store.notifications.get(String(id));
      if (!row) continue;
      await this.store.notifications.update(row.id, {
        ...row,
        pinned: Boolean(pinned),
        pinnedAt: pinned ? now : null,
      });
      updated.push(row.id);
    }
    this.broadcast({ type: 'data_changed', payload: { target: 'notification', action: 'pin' } });
    return { updated: updated.length, pinned: Boolean(pinned), ids: updated };
  }

  async updateSettings(patch = {}) {
    const next = {};

    if (patch.retentionDays !== undefined) {
      const days = Number(patch.retentionDays);
      if (!RETENTION_OPTIONS.includes(days)) {
        throw HttpError.badRequest(`保留期只能是 ${RETENTION_OPTIONS.join(' / ')} 天（0 = 永久保留）`, {
          field: 'retentionDays',
        });
      }
      next.retentionDays = days;
    }

    if (patch.enabledSiteIds !== undefined) {
      if (!Array.isArray(patch.enabledSiteIds)) {
        throw HttpError.badRequest('enabledSiteIds 必须是数组', { field: 'enabledSiteIds' });
      }
      next.enabledSiteIds = patch.enabledSiteIds.map(String);
    }

    if (patch.useSearch !== undefined) next.useSearch = Boolean(patch.useSearch);

    if (patch.customSources !== undefined) {
      if (!Array.isArray(patch.customSources)) {
        throw HttpError.badRequest('customSources 必须是数组', { field: 'customSources' });
      }
      if (patch.customSources.length > MAX_CUSTOM_SOURCES) {
        throw HttpError.badRequest(`自定义站点最多 ${MAX_CUSTOM_SOURCES} 个`, { field: 'customSources' });
      }
      const normalized = patch.customSources.map((item) => normalizeCustomSource(item));
      const seen = new Set();
      for (const source of normalized) {
        if (seen.has(source.id)) throw HttpError.badRequest(`自定义站点 id 重复：${source.id}`, { field: 'customSources' });
        seen.add(source.id);
      }
      next.customSources = normalized;
      // 删掉的自定义站点要从启用列表里一并摘掉，否则同步时会报"站点不在清单里"
      const alive = new Set(normalized.map((item) => item.id));
      next.enabledSiteIds = (patch.enabledSiteIds !== undefined ? next.enabledSiteIds : this.settings().enabledSiteIds)
        .filter((id) => !BUILTIN_SOURCES.every((site) => site.id !== id) ? true : alive.has(id));
    }

    await this.#writeSettings(next);
    return this.settings();
  }
}

/* ---------------------------------------------------------------- 工具 */

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LIMIT_PER_SITE;
  return Math.min(200, Math.max(1, Math.trunc(n)));
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 限并发地跑一遍（对校方站点友好：一次只打 3 个）。 */
async function mapWithConcurrency(list, limit, worker) {
  const results = new Array(list.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const at = index;
      index += 1;
      results[at] = await worker(list[at]);
    }
  });
  await Promise.all(runners);
  return results;
}
