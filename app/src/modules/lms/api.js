/**
 * 思源学堂业务接口封装（只读）。
 *
 * 接口清单（来自校内公开前端的实际调用，已对照 XJTUToolBox 的实现）：
 *   GET  /user/index                         当前用户信息（藏在页面 globalData 里）
 *   POST /api/my-courses                     我的课程列表
 *   GET  /api/courses/{id}                   课程详情
 *   GET  /api/courses/{id}/activities        课程活动（作业 / 资料 / 回放 / 直播）
 *   GET  /api/activities/{id}                活动详情（作业说明、成绩、提交次数…）
 *   GET  /api/activities/{id}/students/{uid}/submission_list   个人作业提交记录
 *   GET  /api/activities/{id}/groups/{gid}/submission_list     小组作业提交记录
 *
 * 所有返回值都归一化成 camelCase，并只保留本项目用得到的字段：
 * 学校接口一改字段，只需要动这一个文件。
 */

import { HttpError } from './http-client.js';

/** 从 JS 代码块里抠出一个对象字面量（键名可能没引号、可能有尾逗号）。 */
export function parseJsObject(page, key, nextKey) {
  const marker = new RegExp(`${key}\\s*:\\s*\\{`);
  const found = marker.exec(page);
  if (!found) return {};
  const start = found.index + found[0].length - 1;
  let depth = 0;
  let end = -1;
  let inString = false;
  let quote = '';
  for (let i = start; i < page.length; i += 1) {
    const char = page[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return {};
  const body = page.slice(start, end + 1);
  return coerceJsObject(body);
}

/** 把 JS 对象字面量转换成合法 JSON 再解析，失败返回 {}。 */
export function coerceJsObject(body) {
  const jsonish = body
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/:\s*None\b/g, ': null')
    .replace(/:\s*undefined\b/g, ': null')
    .replace(/:\s*True\b/g, ': true')
    .replace(/:\s*False\b/g, ': false')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(jsonish);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const toIntOrNull = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
};

const str = (value) => (value === undefined || value === null ? null : String(value));
const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * 学期信息。
 *
 * 实测学校里 `semester.name` / `semester.real_name` 都可能是 null（只给 `code: "2026-1"`），
 * 所以这里额外算一个可读的 `label`（优先 real_name > name > 「<学年> 学年 · 第 N 学期」），
 * 前端直接用 label 就不会出现「学期：」后面空白。
 */
function normalizeSemester(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name);
  const realName = str(raw.real_name ?? raw.realName);
  return { id: toIntOrNull(raw.id), code: str(raw.code), name, realName, label: realName ?? name };
}

/** 用「学年 + 学期 code」拼一个兜底 label（学年信息在课程上，所以单独处理）。 */
function withSemesterLabel(course, raw) {
  if (!course.semester || course.semester.label) return course;
  const year = str(raw?.academic_year?.name ?? raw?.academicYear?.name);
  const index = String(course.semester.code ?? '').split('-')[1];
  const parts = [year ? `${year} 学年` : null, index ? `第 ${index} 学期` : course.semester.code].filter(Boolean);
  return { ...course, semester: { ...course.semester, label: parts.length ? parts.join(' · ') : null } };
}

function normalizeInstructors(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    out.push({ id: toIntOrNull(item.id), name: str(item.name) });
  }
  return out;
}

export function normalizeCourse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = toIntOrNull(raw.id);
  if (id === null) return null;
  const attributes = raw.course_attributes ?? raw.courseAttributes ?? {};
  const course = {
    id,
    name: str(raw.name) ?? `课程 ${id}`,
    courseCode: str(raw.course_code ?? raw.courseCode),
    courseType: str(raw.course_type ?? raw.courseType),
    credit: raw.credit === undefined || raw.credit === null ? null : String(raw.credit),
    compulsory: raw.compulsory === undefined || raw.compulsory === null ? null : bool(raw.compulsory),
    subjectCode: str(raw.subject_code ?? raw.subjectCode),
    startDate: str(raw.start_date ?? raw.startDate),
    endDate: str(raw.end_date ?? raw.endDate),
    klass: str(raw.klass),
    isMute: bool(raw.is_mute ?? raw.isMute),
    published: attributes.published === undefined ? null : bool(attributes.published),
    studentCount: toIntOrNull(attributes.student_count ?? attributes.studentCount),
    teachingClassName: str(attributes.teaching_class_name ?? attributes.teachingClassName),
    academicYear: raw.academic_year
      ? { id: toIntOrNull(raw.academic_year.id), code: str(raw.academic_year.code), name: str(raw.academic_year.name) }
      : null,
    semester: normalizeSemester(raw.semester),
    department: raw.department
      ? { id: toIntOrNull(raw.department.id), name: str(raw.department.name), code: str(raw.department.code) }
      : null,
    instructors: normalizeInstructors(raw.instructors),
  };
  return withSemesterLabel(course, raw);
}

export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = toIntOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    courseId: toIntOrNull(raw.course_id ?? raw.courseId),
    type: str(raw.type) ?? 'unknown',
    title: str(raw.title) ?? `活动 ${id}`,
    moduleId: toIntOrNull(raw.module_id ?? raw.moduleId),
    startTime: str(raw.start_time ?? raw.startTime),
    endTime: str(raw.end_time ?? raw.endTime),
    published: raw.published === undefined ? null : bool(raw.published),
    submitByGroup: raw.submit_by_group === undefined && raw.submitByGroup === undefined ? null : bool(raw.submit_by_group ?? raw.submitByGroup),
    createdAt: str(raw.created_at ?? raw.createdAt),
    updatedAt: str(raw.updated_at ?? raw.updatedAt),
  };
}

/**
 * 附件类型 → 前端选图标用的粗分类。
 *
 * 学堂的 `uploads[].type` 是一串 MIME 化的字符串（`application/pdf`、
 * `video/mp4`、`application/vnd.openxmlformats-…` …），直接拿去判断分支既脆又难读。
 * 这里映射成四档；认不出的一律 `file`（**不能**当成"没有附件"丢掉）。
 */
export function uploadKind(type, name = '') {
  const text = String(type ?? '').toLowerCase();
  const ext = String(name ?? '').toLowerCase().split('.').pop() ?? '';
  if (text.startsWith('video/') || ['mp4', 'mkv', 'flv', 'mov', 'avi', 'm3u8'].includes(ext)) return 'video';
  if (text.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac'].includes(ext)) return 'audio';
  if (text.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (
    text.includes('pdf') ||
    text.includes('word') ||
    text.includes('document') ||
    text.includes('presentation') ||
    text.includes('sheet') ||
    text.includes('officedocument') ||
    ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md', 'zip', 'rar', '7z'].includes(ext)
  ) {
    return 'document';
  }
  return 'file';
}

/**
 * 一个附件上传（`uploads[]` 的一项）。
 *
 * **下载地址给的是我们自己的代理，不是学校地址** —— 学校那个 `/api/uploads/{id}/blob`
 * 必须带 CAS 会话 cookie，浏览器直连会 401；文件也跨域拿不到。
 * 所以这里只给出"点一下该请求哪条后端路由"，真正取字节由 `GET /lms/attachments/:id` 做。
 *
 * `allow_download === false` 的附件**不给下载入口**，只给预览 —— 那是老师的显式设置，
 * 我们不能凭空给个按钮然后让用户点出 403。
 */
export function normalizeUpload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = toIntOrNull(raw.id);
  const name = str(raw.name) ?? (id === null ? null : `附件 ${id}`);
  if (!name) return null;
  const size = toIntOrNull(raw.size);
  const allowDownload = raw.allow_download === undefined ? true : bool(raw.allow_download);
  const referenceId = toIntOrNull(raw.reference_id ?? raw.referenceId);
  const type = str(raw.type) ?? '';
  return {
    id,
    name,
    type,
    kind: uploadKind(type, name),
    size,
    allowDownload,
    referenceId,
    // 下载与预览都指向本机代理；没有 id 就没法代理，两个都不给
    downloadUrl: id !== null && allowDownload ? `/lms/attachments/${id}` : null,
    previewUrl: id !== null ? `/lms/attachments/${id}?inline=1` : null,
  };
}

/** 从活动详情里抠 `replay_code`：参考实现的三级兜底，缺了就拿不到回放视频。 */
function pickReplayCode(raw, data) {
  const direct = str(raw.replay_code ?? raw.replayCode);
  if (direct) return direct;
  // 2) 挂在 lesson_resource.properties 上
  const properties = raw.lesson_resource?.properties ?? raw.lessonResource?.properties;
  const nested = str(properties?.replay_code ?? properties?.replayCode);
  if (nested) return nested;
  // 3) 直播详情里的 replay_id
  const external = data?.external_live_detail ?? data?.externalLiveDetail;
  return str(external?.replay_id ?? external?.replayId);
}

export function normalizeActivityDetail(raw) {
  const brief = normalizeActivity(raw);
  if (!brief) return null;
  // 学堂把很多字段塞在 `data` 里（描述、直播详情），顶层是拿不到的 ——
  // 只读顶层会让"描述"永远是空字符串，板块看起来像没有内容。
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const uploads = Array.isArray(raw.uploads) ? raw.uploads.map(normalizeUpload).filter(Boolean) : [];
  return {
    ...brief,
    description: str(data.description ?? raw.description) ?? '',
    groupId: toIntOrNull(raw.group_id ?? raw.groupId),
    groupSetId: toIntOrNull(raw.group_set_id ?? raw.groupSetId),
    groupSetName: str(raw.group_set_name ?? raw.groupSetName),
    userSubmitCount: toIntOrNull(raw.user_submit_count ?? raw.userSubmitCount),
    averageScore: raw.average_score ?? raw.averageScore ?? null,
    highestScore: raw.highest_score ?? raw.highestScore ?? null,
    lowestScore: raw.lowest_score ?? raw.lowestScore ?? null,
    hasScoreCount: toIntOrNull(raw.has_score_count ?? raw.hasScoreCount),
    lessonStart: str(raw.lesson_start ?? raw.lessonStart),
    lessonEnd: str(raw.lesson_end ?? raw.lessonEnd),
    replayCode: pickReplayCode(raw, data),
    replayVideoCount: toIntOrNull(raw.replay_video_count ?? raw.replayVideoCount),
    uploads,
  };
}

export function normalizeSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: toIntOrNull(raw.id),
    score: raw.score ?? null,
    status: str(raw.status),
    submittedAt: str(raw.submitted_at ?? raw.submittedAt),
    comment: str(raw.comment) ?? '',
    instructorComment: str(raw.instructor_comment ?? raw.instructorComment) ?? '',
    uploads: Array.isArray(raw.uploads) ? raw.uploads.map(normalizeUpload).filter(Boolean) : [],
  };
}

/** 从地址里取一个查询参数（用来从播放地址里抠 `token` / `replay_code`）。 */
export function queryParam(url, name) {
  try {
    return new URL(String(url)).searchParams.get(name);
  } catch {
    const match = new RegExp(`[?&]${name}=([^&]*)`).exec(String(url));
    return match ? decodeURIComponent(match[1]) : null;
  }
}

/**
 * 回放视频的标签。实测只有两个值：
 *   `INSTRUCTOR` = 教室录像（拍老师和黑板），`ENCODER` = 电脑内录（投影/课件画面）。
 * 两路通常都带音轨，`is_best_audio` 标出音质更好的那一路。
 */
export const REPLAY_VIDEO_LABELS = Object.freeze({
  INSTRUCTOR: '教室录像',
  ENCODER: '电脑内录',
});

/**
 * 归一化录播站的 `lesson_videos[]` 一项。
 * 下载优先用 `download_url` 直链，没有才退回播放地址（有些录制只有播放地址）。
 */
export function normalizeReplayVideo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = String(raw.label ?? raw.video_type ?? raw.videoType ?? '').trim().toUpperCase();
  const downloadUrl = str(raw.download_url ?? raw.downloadUrl);
  const playUrl = str(raw.play_url ?? raw.playUrl ?? raw.url);
  return {
    label: label || 'VIDEO',
    labelText: REPLAY_VIDEO_LABELS[label] ?? (label || '视频'),
    downloadUrl,
    playUrl,
    url: downloadUrl ?? playUrl ?? null,
    size: toIntOrNull(raw.size ?? raw.bytes ?? raw.file_size ?? raw.fileSize),
    duration: toIntOrNull(raw.duration ?? raw.duration_seconds ?? raw.durationSeconds),
    isBestAudio: Boolean(raw.is_best_audio ?? raw.isBestAudio),
  };
}

export class LmsApi {
  constructor({ http, config }) {
    this.http = http;
    this.config = config;
    this.apiBase = `${config.baseUrl}/api`;
    this.cachedUser = null;
  }

  /** 当前登录用户；页面里解析不到时返回空对象而不报错。 */
  async userInfo({ refresh = false } = {}) {
    if (this.cachedUser && !refresh) return this.cachedUser;
    const response = await this.http.get(`${this.config.baseUrl}/user/index`, { headers: { Accept: 'text/html' } });
    if (response.url.includes('/cas/login') || response.url.includes('login.xjtu.edu.cn')) {
      throw new HttpError('登录态已失效，请重新登录思源学堂', { status: 401, url: response.url });
    }
    const user = parseJsObject(response.text, 'user', 'dept');
    const dept = parseJsObject(response.text, 'dept', 'locale');
    this.cachedUser = {
      id: toIntOrNull(user.id),
      name: str(user.name) ?? '',
      userNo: str(user.userNo ?? user.user_no) ?? '',
      role: str(user.role) ?? '',
      orgName: str(user.orgName) ?? '',
      department: str(dept.name) ?? '',
    };
    return this.cachedUser;
  }

  /** 我的课程列表。 */
  async myCourses() {
    const data = await this.#apiJson('POST', '/my-courses');
    const list = Array.isArray(data?.courses) ? data.courses : [];
    return list.map(normalizeCourse).filter(Boolean);
  }

  /** 课程详情（目前只需要课程摘要字段）。 */
  async courseDetail(courseId) {
    const data = await this.#apiJson('GET', `/courses/${encodeURIComponent(courseId)}`);
    return normalizeCourse(data?.course ?? data);
  }

  /** 课程活动列表。 */
  async courseActivities(courseId) {
    const data = await this.#apiJson('GET', `/courses/${encodeURIComponent(courseId)}/activities`);
    const list = Array.isArray(data?.activities) ? data.activities : [];
    return list.map(normalizeActivity).filter(Boolean);
  }

  /** 活动详情。 */
  async activityDetail(activityId) {
    const data = await this.#apiJson('GET', `/activities/${encodeURIComponent(activityId)}`);
    return normalizeActivityDetail(data?.activity ?? data);
  }

  /** 某次作业的提交记录（个人 / 小组自动判别）。 */
  async submissions(activityId, { detail, userId, groupId } = {}) {
    const info = detail ?? (await this.activityDetail(activityId));
    let url;
    if (info?.submitByGroup) {
      const gid = groupId ?? info.groupId;
      if (gid === null || gid === undefined) throw new HttpError('小组作业缺少 group_id，无法查询提交记录');
      url = `/activities/${encodeURIComponent(activityId)}/groups/${encodeURIComponent(gid)}/submission_list`;
    } else {
      const uid = userId ?? (await this.userInfo()).id;
      if (uid === null || uid === undefined) throw new HttpError('无法确定当前用户 ID');
      url = `/activities/${encodeURIComponent(activityId)}/students/${encodeURIComponent(uid)}/submission_list`;
    }
    const data = await this.#apiJson('GET', url);
    const list = Array.isArray(data?.submissions) ? data.submissions : Array.isArray(data?.list) ? data.list : [];
    return list.map(normalizeSubmission).filter(Boolean);
  }

  /**
   * 取一次回放的视频直链。
   *
   * **课程回放的视频不在 lms 上**，要跨到录播站（RMS），三步：
   *   1. `GET {lms}/api/lessons/{id}/player-url?from_page=course` → 一个带 `token` 的播放地址；
   *   2. `GET {rms}/api/v1/auth/embed-token?token=…` → 录播站的 Bearer 票据；
   *   3. `GET {rms}/api/embed/lesson-activities/captures/{replay_code}?lesson_activity_id=…`
   *      → `lesson_videos[]`（里面有 `download_url` 直链）。
   *
   * 三处细节是**照着 XJTUToolBox 的 lms.py 逐行对**才发现的，错一个就全盘失败：
   *   · 第 2 步返回的是 `{ data: "<票据字符串>" }` —— **票据本身就在 `data` 上**，
   *     不是 `data.token`。按对象去取会永远拿到 undefined，于是每一路回放都报"取不到票据"
   *     （这就是"全部都获取回放地址失败"的直接原因）。
   *   · 第 3 步必须带 `lesson_activity_id` 查询参数，否则录播站判为非法请求。
   *   · `replay_code` 常常只在**活动详情**里（真实数据 850 条回放只有 10 条缓存上带它），
   *     所以缺了要先去拉详情，再按三级兜底找。
   *
   * 注意：控制台日志里**不要**打这三个地址 —— 它们都带票据，等于把登录态写进日志。
   *
   * @param {object} activity 归一化后的活动（`lesson` 类型），至少要有 `id`
   * @param {object} [options]
   * @param {string|number} [options.lessonId] 显式指定 lesson id（默认用活动 id）
   */
  async replayVideos(activity, { lessonId } = {}) {
    const id = lessonId ?? activity?.id;
    if (id === null || id === undefined || id === '') {
      throw new HttpError('这个活动没有 id，拿不到回放地址', { field: 'id' });
    }

    // 第 0 步：replay_code 常常只在详情里，缓存上没有就去拉一次详情
    let replayCode = str(activity?.replayCode);
    if (!replayCode) {
      try {
        const detail = normalizeActivityDetail(await this.activityDetail(id));
        replayCode = str(detail?.replayCode);
      } catch {
        // 详情拉不到就继续走 player-url 里那条线索，不在这里就失败
      }
    }

    // 第 1 步：lms 给播放地址（参考项目取的是 `url` 字段）
    const player = await this.#apiJson('GET', `/lessons/${encodeURIComponent(id)}/player-url?from_page=course`);
    const body = player?.data && typeof player.data === 'object' ? player.data : player ?? {};
    const playerUrl = str(body.player_url ?? body.playerUrl ?? body.url);
    if (!playerUrl) {
      throw new HttpError('学堂没有返回播放地址（这门课的回放可能还没生成或未开放）', { lessonId: id });
    }

    // 第 2 步：拿地址里的 token 去录播站换票据
    const token = queryParam(playerUrl, 'token');
    if (!token) {
      throw new HttpError('播放地址里没有 token，无法换取录播站票据', { lessonId: id });
    }
    replayCode = replayCode ?? queryParam(playerUrl, 'replay_code') ?? str(body.replay_code ?? body.replayCode);

    const rms = this.config.rmsBaseUrl;
    const headers = { Referer: `${rms}/`, Accept: 'application/json, text/plain, */*' };
    const embed = await this.http.json(`${rms}/api/v1/auth/embed-token?token=${encodeURIComponent(token)}`, { headers });
    // ★ 票据就是顶层 `data`（字符串）。同时保留对象形状的兜底，
    //   是因为录播站不同版本两种形状都出现过 —— 但**字符串那条必须先判**。
    const bearer =
      str(embed?.data) ??
      str(embed?.token) ??
      str(embed?.data?.token) ??
      str(embed?.embed_token);
    if (!bearer) {
      const code = embed?.error?.code;
      const message = embed?.error?.message;
      throw new HttpError(
        code ? `录播站拒绝换票（code=${code}${message ? `，${message}` : ''}）` : '录播站没有返回票据（token 可能已过期）',
        { rms },
      );
    }

    // 第 3 步：拿 replay_code 要视频列表（必须带 lesson_activity_id）
    if (!replayCode) {
      throw new HttpError('没有 replay_code，拿不到回放视频列表', { lessonId: id });
    }
    const capturesUrl =
      `${rms}/api/embed/lesson-activities/captures/${encodeURIComponent(replayCode)}` +
      `?lesson_activity_id=${encodeURIComponent(id)}`;
    const captures = await this.http.json(capturesUrl, {
      headers: { ...headers, Authorization: `Bearer ${bearer}` },
    });
    const raw = captures?.lesson_videos ?? captures?.data?.lesson_videos ?? [];
    const videos = (Array.isArray(raw) ? raw : []).map(normalizeReplayVideo).filter(Boolean);
    return { lessonId: id, replayCode, videos };
  }

  /**
   * 打开任意媒体地址的**上游字节流**（不读进内存）。
   *
   * 回放录像动辄几百 MB，`request()` 会先 `arrayBuffer()` 全读一遍把内存打爆，
   * 所以走 `http.stream()`，交给路由 `pipeline` 到响应里。
   *
   * @returns {Promise<{status:number, headers:Headers, body:ReadableStream|null}>}
   */
  async streamMedia(url, { headers = {} } = {}) {
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new HttpError('播放地址不是 http(s)，无法转发', { status: 400, url: target });
    }
    return this.http.stream(target, { headers, follow: true });
  }
  /**
   * 取一个附件的原始字节（学校侧 `GET /api/uploads/{id}/blob`）。
   *
   * 为什么必须由后端代取，而不是把学校地址交给浏览器：
   *   1. 那个地址要 CAS 会话 cookie，浏览器直连必然 401；
   *   2. 即使带上 cookie，跨域也读不到响应体。
   * 所以前端只认我们自己的 `GET /lms/attachments/:id`，字节由这里取、由路由转发。
   *
   * 说明：这里走 `request()`（正文读进内存）。附件是课件/文档，几 MB 量级；
   * 回放视频那种几百 MB 的走 `replay-download.js` 的流式下载，不经过这里。
   * 路由层仍会挡一个上限，避免有人拿超大文件把内存打爆。
   */
  async attachmentBlob(uploadId) {
    const id = Number(uploadId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError('附件 id 非法', { status: 400, field: 'id' });
    }
    // ⚠️ `apiBase` 本身已经以 `/api` 结尾（见构造函数），这里**不能再写一遍**
    // ——写成 `${apiBase}/api/uploads/…` 会变成 `/api/api/…`，学校直接 404。
    const url = `${this.apiBase}/uploads/${id}/blob`;
    const response = await this.http.request(url, {
      headers: { Referer: `${this.config.baseUrl}/user/index` },
      follow: true,
    });
    if (response.status === 401 || response.status === 403) {
      throw new HttpError('登录态已失效，请重新登录思源学堂', { status: response.status, url });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(`取附件失败：HTTP ${response.status}`, { status: response.status, url });
    }
    return {
      bytes: response.bytes ?? new Uint8Array(0),
      contentType: response.headers?.get?.('content-type') ?? '',
    };
  }

  /**
   * 批量拉取多门课程的课程活动。返回 Map<courseId, activities[]>。
   * 单门课程失败不影响其他课程（记在 errors 里）。
   */
  async activitiesForCourses(courseIds, { concurrency = this.config.concurrency ?? 2, onProgress } = {}) {
    const result = new Map();
    const errors = [];
    const queue = [...courseIds];
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const courseId = queue.shift();
        try {
          result.set(courseId, await this.courseActivities(courseId));
        } catch (error) {
          errors.push({ courseId, message: error.message ?? String(error) });
          result.set(courseId, []);
        }
        done += 1;
        onProgress?.({ done, total: courseIds.length, courseId });
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, courseIds.length || 1)) }, worker);
    await Promise.all(workers);
    return { activities: result, errors };
  }

  /** 统一的 API 调用入口：登录态失效时抛出可识别的 401 文案。 */
  async #apiJson(method, path, body) {
    const url = `${this.apiBase}${path}`;
    const options = {
      headers: { Referer: `${this.config.baseUrl}/user/index`, 'X-Requested-With': 'XMLHttpRequest' },
      follow: true,
    };
    const response =
      method === 'POST'
        ? await this.http.postJson(url, body ?? {}, options)
        : await this.http.get(url, options);
    if (response.status === 401 || response.status === 403) {
      throw new HttpError('登录态已失效，请重新登录思源学堂', { status: response.status, url });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(`思源学堂接口 ${path} 返回 HTTP ${response.status}`, {
        status: response.status,
        url,
        body: response.text.slice(0, 300),
      });
    }
    // 被重定向回登录页时返回的是 HTML，直接提示重新登录，避免暴露解析错误
    if (response.url.includes('/cas/login')) {
      throw new HttpError('登录态已失效，请重新登录思源学堂', { status: 401, url: response.url });
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw new HttpError(`思源学堂接口 ${path} 返回的不是 JSON（可能登录态失效）`, { url, body: response.text.slice(0, 200) });
    }
  }
}
