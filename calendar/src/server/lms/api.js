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

export function normalizeActivityDetail(raw) {
  const brief = normalizeActivity(raw);
  if (!brief) return null;
  return {
    ...brief,
    description: str(raw.description) ?? '',
    groupId: toIntOrNull(raw.group_id ?? raw.groupId),
    userSubmitCount: toIntOrNull(raw.user_submit_count ?? raw.userSubmitCount),
    averageScore: raw.average_score ?? raw.averageScore ?? null,
    highestScore: raw.highest_score ?? raw.highestScore ?? null,
    lowestScore: raw.lowest_score ?? raw.lowestScore ?? null,
    lessonStart: str(raw.lesson_start ?? raw.lessonStart),
    lessonEnd: str(raw.lesson_end ?? raw.lessonEnd),
    replayCode: str(raw.replay_code ?? raw.replayCode),
    replayVideoCount: toIntOrNull(raw.replay_video_count ?? raw.replayVideoCount),
    uploads: Array.isArray(raw.uploads)
      ? raw.uploads.map((item) => ({ id: toIntOrNull(item?.id), name: str(item?.name), size: toIntOrNull(item?.size) }))
      : [],
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
    uploads: Array.isArray(raw.uploads)
      ? raw.uploads.map((item) => ({ id: toIntOrNull(item?.id), name: str(item?.name), size: toIntOrNull(item?.size) }))
      : [],
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
