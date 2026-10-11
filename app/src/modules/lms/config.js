/**
 * 思源学堂（LMS）接入配置。
 *
 * 所有地址都可以被覆盖，目的有三个：
 * 1. 单元测试时指向本地 mock 服务器，真实网络零依赖；
 * 2. 学校更换域名时只改这里；
 * 3. 需要走 webvpn 时，只要把 baseUrl 换成对应的 webvpn 地址即可。
 */

/** 线上默认值。 */
export const LMS_DEFAULTS = Object.freeze({
  /** 业务站点（思源学堂 2.0）。 */
  baseUrl: 'https://lms.xjtu.edu.cn',
  /** 统一身份认证站点（2025-07 之后的新认证系统）。 */
  casOrigin: 'https://login.xjtu.edu.cn',
  /** 上报给服务端的浏览器标识；服务端会拒绝脚本默认 UA。 */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 单次请求超时；登录链路偶发慢响应，给得比普通接口宽一点。 */
  timeoutMs: 20_000,
  /** 单个活动详情的额外等待（作业详情要再拉一次提交列表）。 */
  detailTimeoutMs: 25_000,
  /** 抓活动时最多并发几门课程，避免把学校服务器打崩。 */
  concurrency: 2,
});

/**
 * 解析配置。优先级：显式入参 > 环境变量 > 默认值。
 * 环境变量：PC_LMS_BASE_URL / PC_LMS_CAS_ORIGIN / PC_LMS_TIMEOUT_MS
 */
export function resolveLmsConfig(overrides = {}, env = process.env) {
  const config = { ...LMS_DEFAULTS, ...overrides };
  if (!overrides.baseUrl && env.PC_LMS_BASE_URL) config.baseUrl = env.PC_LMS_BASE_URL;
  if (!overrides.casOrigin && env.PC_LMS_CAS_ORIGIN) config.casOrigin = env.PC_LMS_CAS_ORIGIN;
  if (!overrides.timeoutMs && env.PC_LMS_TIMEOUT_MS) {
    const parsed = Number(env.PC_LMS_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) config.timeoutMs = parsed;
  }
  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  config.casOrigin = String(config.casOrigin).replace(/\/+$/, '');
  return config;
}

/** 活动类型（与思源学堂 `/api/courses/{id}/activities` 返回的 type 一致）。 */
export const ACTIVITY_TYPES = ['homework', 'material', 'lesson', 'lecture_live'];

/** 同步时默认关心的活动类型：作业 + 直播（都带明确时间点，才值得进日历）。 */
export const DEFAULT_SYNC_TYPES = ['homework', 'lecture_live'];

/**
 * 活动类型分组：一个分组名 = 多个底层 type。
 *
 * `online`（网课）= 直播 + 回放 + 在线视频 —— 学堂里同一门课的不同形态（真实账号里 952 条直播、
 * 767 条回放、35 条在线视频），前端「网课」页签用同一套划分，所以 `/lms/activities?type=online`
 * 也必须返回这三类，别让接口和界面各说各话。
 * 注意：只有直播/回放带时刻，在线视频没有时间，因此它们不参与同步（见 sync.js）。
 */
export const ACTIVITY_TYPE_GROUPS = Object.freeze({
  online: Object.freeze(['lecture_live', 'lesson', 'online_video']),
});

/**
 * 把查询里的 `type` 归一成「要匹配的类型数组」。
 * 未传返回 null（不过滤）；分组名返回组内类型；其余按精确匹配处理（未知类型也能查，结果为空数组而已）。
 */
export function activityTypesOf(type) {
  const key = String(type ?? '').trim();
  if (!key) return null;
  return ACTIVITY_TYPE_GROUPS[key] ?? [key];
}

export const ACTIVITY_TYPE_LABEL = Object.freeze({
  homework: '作业',
  material: '资料',
  lesson: '课程回放',
  lecture_live: '直播',
  // 下面这些是实测真实账号里出现、但本模块不参与同步的类型，
  // 只是为了让「全部」列表里的中文标签好看一点（未知类型一律回退到原始值）
  page: '课程页面',
  forum: '讨论',
  web_link: '外部链接',
  online_video: '在线视频',
  questionnaire: '问卷',
  exam: '考试',
  unknown: '其它',
});
