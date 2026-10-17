/**
 * 思源学堂（LMS）路由。
 *
 * 全部挂在 `/api/v1/lms` 下，只有「登录 / 验证码 / 同步」三类动作。
 * 约定：
 * - 所有写操作都必须先通过 `/lms/sync/preview` 预览，再带 keys 调 `/lms/sync/apply`；
 * - `/lms/captcha` 直接回二进制图片，方便 `<img src>` 直接用；
 * - 未登录时统一返回 401 UNAUTHORIZED，前端据此弹登录框。
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from '../../core/http/router.js';
import { activityTypesOf } from './config.js';

const MAX_BODY_KEYS = 2000;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  return value.trim();
}

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * 按扩展名猜 `Content-Type`。
 *
 * 什么时候需要它：学校返回的 blob 响应不一定带 `Content-Type`，而浏览器
 * 拿到 `application/octet-stream` 的 PDF 会直接下载而不是预览 —— 点「预览」却弹下载框，
 * 用户会以为按钮坏了。猜不出来才退回 octet-stream。
 */
function guessContentType(filename) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop() ?? '';
  const table = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return table[ext] ?? '';
}

function normalizeKeys(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw HttpError.badRequest('字段 keys 必须是数组');
  if (value.length > MAX_BODY_KEYS) throw HttpError.badRequest(`字段 keys 最多 ${MAX_BODY_KEYS} 项`);
  return value.map((item) => String(item));
}

function normalizeCourseIds(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const ids = list
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return ids.length ? ids : null;
}

/** 把请求体里的同步选项整理成服务层认识的形状。 */
function syncOptionsFrom(body = {}) {
  const types = Array.isArray(body.types) ? body.types.map(String) : null;
  return {
    types,
    courseIds: normalizeCourseIds(body.courseIds),
    includePast: asBool(body.includePast),
    includeCourseRange: asBool(body.includeCourseRange),
    skipSubmitted: body.skipSubmitted === undefined ? true : asBool(body.skipSubmitted),
    markSubmittedDone: body.markSubmittedDone === undefined ? true : asBool(body.markSubmittedDone),
    pruneStale: asBool(body.pruneStale),
    refresh: asBool(body.refresh),
    today: typeof body.today === 'string' && body.today ? body.today : undefined,
    keys: normalizeKeys(body.keys),
  };
}

export function registerLmsRoutes(router, { lms, apiPrefix }) {
  const P = `${apiPrefix}/lms`;
  if (!lms) return;

  router.get(`${P}/status`, () => lms.status());

  router.post(`${P}/login`, async ({ body }) => {
    const username = requireText(body?.username, 'username');
    const password = requireText(body?.password, 'password');
    const captcha = typeof body?.captcha === 'string' ? body.captcha.trim() : undefined;
    return lms.login({ username, password, captcha, trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent) });
  });

  router.post(`${P}/mfa/send`, () => lms.sendMfaCode());

  router.post(`${P}/mfa/verify`, async ({ body }) => {
    const code = requireText(body?.code, 'code');
    return lms.verifyMfaCode(code);
  });

  router.get(`${P}/captcha`, async () => {
    const { bytes, contentType } = await lms.captcha();
    return { __raw: { contentType, body: Buffer.from(bytes) } };
  });

  router.post(`${P}/logout`, () => lms.logout());

  router.post(`${P}/settings`, ({ body }) => lms.updateSettings({ autoSync: body?.autoSync, autoSyncIntervalHours: body?.autoSyncIntervalHours }));

  router.get(`${P}/courses`, async ({ query }) => {
    if (asBool(query.refresh)) return lms.refreshCourses();
    const cached = lms.listCourses();
    // 第一次访问且没有缓存时自动拉一次，避免前端要多点一下
    if (!cached.count) return lms.refreshCourses();
    return cached;
  });

  router.post(`${P}/courses/refresh`, () => lms.refreshCourses());

  router.get(`${P}/activities`, async ({ query }) => {
    const courseIds = normalizeCourseIds(query.courseId ?? query.courseIds);
    // 与 lms.listActivities 用同一套归一：type 可以是 lesson/homework 这类底层类型，也可以是 online（网课 = 直播 + 回放 + 在线视频）分组
    const types = activityTypesOf(query.type);
    const typeFilter = (items) => (types ? items.filter((item) => types.includes(item.type)) : items);
    if (asBool(query.refresh)) {
      const refreshed = await lms.refreshActivities({ courseIds, force: true });
      return { ...refreshed, items: typeFilter(refreshed.items), count: typeFilter(refreshed.items).length };
    }
    const cached = lms.listActivities({ courseIds, type: query.type });
    if (!cached.count) {
      const refreshed = await lms.refreshActivities({ courseIds });
      const items = typeFilter(refreshed.items);
      return { ...refreshed, items, count: items.length };
    }
    return cached;
  });

  router.post(`${P}/activities/refresh`, ({ body }) => lms.refreshActivities({ courseIds: normalizeCourseIds(body?.courseIds), force: true }));

  router.get(`${P}/activities/:id`, ({ params }) => lms.activityDetail(params.id));

  /* ------------------------------------------------------------ 预置接口（尚未实现）
   *
   * 契约先定下来，实现留到后面。这里刻意返回 **501 而不是 404**：
   * 让调用方（尤其是 AI Agent）能区分「这个能力我认识，只是还没做」和「路径写错了」。
   * 对应的工具清单见 tools.js 里 `implemented: false` 的那几个。
   */
  const planned = (summary, contract) => () => {
    throw HttpError.notImplemented(`${summary}：接口已预置、尚未实现`, { planned: true, contract });
  };

  /**
   * 课程页：课程信息 + 这门课的活动（按 回放/作业/资料/直播 分组）。
   *
   * `?refresh=1` 强制重拉这门课的活动（用户点了刷新按钮）；不传时服务层按
   * `ACTIVITY_TTL_MS` 节流地自动补齐 —— 缓存新鲜就直接读本地，不再打学校接口。
   */
  router.get(`${P}/courses/:id`, ({ params, query }) => lms.coursePage(params.id, { refresh: asBool(query?.refresh) }));

  /**
   * 回放视频的**字节转发**（`<video>` 直接用这条路由播放）。
   *
   * 为什么不把录播站地址直接给 `<video>`：媒体地址通常带防盗链（校验 Referer、要票据），
   * 而浏览器的 `<video>` 无法自定义 Referer，直接指过去必然加载失败。
   * 这里由后端带上来源头取流、再流式转发 —— 顺便也绕开了跨域。
   *
   * 实现要点：**直接写 `res`**（`pipeline` 到响应），不缓冲整段视频；
   * 路由层有 `if (res.writableEnded) return;`，所以写完返回即可，不会被再发一次 JSON。
   */
  router.get(`${P}/replay/stream`, async ({ req, query, res }) => {
    const activityId = query?.activityId;
    if (!activityId) throw HttpError.badRequest('缺少 activityId');
    const source = await lms.replayStreamSource({ activityId, label: query?.label });

    /*
     * **转发 Range**：`<video>` 拖进度条靠的就是它。
     *
     * 浏览器发 `Range: bytes=N-`，上游回 `206 + Content-Range`；这里原样转发请求头、
     * 也原样把 206 / Content-Range 传回去。之前写死 `Accept-Ranges: none` 又不转 Range，
     * 等于告诉浏览器"这片不能跳" —— 进度条能拖、画面不动，用户报的就是这个。
     */
    const range = req.headers.range;
    const upstream = await lms.openReplayStream(source.url, { range });
    const ok = (upstream.status >= 200 && upstream.status < 300) || upstream.status === 206;
    if (!ok || !upstream.body) {
      throw HttpError.upstream(`录播站返回 HTTP ${upstream.status}，取不到录像流`);
    }

    const pass = (name) => upstream.headers?.get?.(name) ?? null;
    const headers = {
      'Content-Type': pass('content-type') || 'video/mp4',
      'Cache-Control': 'private, max-age=300',
      // 上游能分段就如实告诉浏览器；不能就写 none，别骗它说可以跳
      'Accept-Ranges': pass('accept-ranges') || (upstream.status === 206 ? 'bytes' : 'none'),
    };
    const length = pass('content-length');
    if (length) headers['Content-Length'] = length;
    const contentRange = pass('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    res.writeHead(upstream.status, headers);
    await pipeline(Readable.fromWeb(upstream.body), res);
    // 故意不返回实体：`res.writableEnded` 已为真，路由会直接结束
  });
  /** 某个回放的视频列表（要联网换录播站票据，所以是显式动作）。 */
  router.get(`${P}/activities/:id/replays`, ({ params }) => lms.replayVideos(params.id));

  /* ------------------------------------------------------------ 回放下载 */

  /** 开始下载：`{ activityId, video: { downloadUrl|playUrl, label, labelText, size } }`。 */
  router.post(`${P}/downloads`, ({ body }) => lms.startDownload({ activityId: body?.activityId, video: body?.video }));

  /** 下载任务列表（前端轮询进度用）+ 落盘目录。 */
  router.get(`${P}/downloads`, () => lms.listDownloads());

  router.post(`${P}/downloads/:id/cancel`, ({ params }) => lms.cancelDownload(params.id));

  /** 清掉已结束的任务记录（不删文件）。 */
  router.post(`${P}/downloads/clear`, () => lms.clearDownloads());

  /**
   * 某门课的课件/资料清单。
   *
   * 学堂没有独立的资料接口 —— 资料就是一种课程活动（`type: 'material'`），
   * 附件挂在它的详情里。`?detail=1` 时顺带把每条资料的附件补上（会多打 N 次详情接口）。
   */
  router.get(`${P}/courses/:id/materials`, ({ params, query }) =>
    lms.materials(params.id, { withDetail: asBool(query?.detail) }),
  );

  /** 某门课的讨论区主题。 */
  router.get(
    `${P}/courses/:id/discussions`,
    planned('课程讨论区', { params: { id: 'string' }, returns: { items: '[{ id, title, author, replies, lastReplyAt }]' } }),
  );

  /** 某次作业的提交情况（是否提交、时间、得分、评语、附件）。 */
  router.get(`${P}/activities/:id/submission`, ({ params }) => lms.submission(params.id));

  /**
   * 附件/提交文件的字节转发。
   *
   * 学校那个 `blob` 地址要 CAS cookie，浏览器直连必 401 —— 所以字节由后端代取再转发。
   * `inline=1` 时让浏览器直接预览（PDF/图片），否则按下载处理。
   * `name` 只用于拼 `Content-Disposition`，**绝不参与路径拼接**。
   */
  router.get(`${P}/attachments/:id`, async ({ params, query }) => {
    const result = await lms.attachment(params.id);
    const inline = asBool(query?.inline);
    const filename = typeof query?.name === 'string' ? query.name : '';
    const contentType = result.contentType || guessContentType(filename) || 'application/octet-stream';
    // 文件名里的非 ASCII（中文课件名很常见）必须走 RFC 5987 的 filename*，
    // 直接塞进 filename= 会被某些浏览器丢成乱码或截断。
    const disposition = inline ? 'inline' : 'attachment';
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(result.bytes.length),
      'Cache-Control': 'private, max-age=300',
    };
    if (filename) {
      const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      headers['Content-Disposition'] = `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    } else {
      headers['Content-Disposition'] = disposition;
    }
    return { __raw: { status: 200, body: Buffer.from(result.bytes), headers } };
  });

  /** 课程通知/公告（可按课程过滤）。 */
  router.get(
    `${P}/notices`,
    planned('课程通知与公告', { params: { courseId: 'string?' }, returns: { items: '[{ id, courseId, courseName, title, publishedAt, body }]' } }),
  );

  /** 课程通知/公告（可按课程过滤）。 */
  router.get(
    `${P}/notices`,
    planned('课程通知与公告', { params: { courseId: 'string?' }, returns: { items: '[{ id, courseId, courseName, title, publishedAt, body }]' } }),
  );

  /** 成绩（课程总分与各项得分）。 */
  router.get(
    `${P}/grades`,
    planned('成绩', { params: {}, returns: { items: '[{ courseId, courseName, score, fullScore, items }]' } }),
  );


  router.post(`${P}/sync/preview`, ({ body }) => lms.preview(syncOptionsFrom(body)));

  router.post(`${P}/sync/apply`, async ({ body }) => {
    if (body?.keys !== undefined && (!Array.isArray(body.keys) || !body.keys.length)) {
      throw HttpError.badRequest('字段 keys 不能为空数组（不传表示同步预览中的全部条目）');
    }
    return lms.apply(syncOptionsFrom(body));
  });
}
