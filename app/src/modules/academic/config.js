/**
 * 学业模块的配置：**所有与教务系统耦合的东西都集中在这里**。
 *
 * 为什么单独一个文件：上游（金智 jwapp）改 appId、改动作名、改字段名是常态 ——
 * 本项目调研期间就实测到课表应用从 `wdkb` 变成了 `kcbcx`。把路径与字段名收在一处，
 * 改版时只动这个文件，业务代码（`api.js` / `service.js` / `gpa.js`）一行都不用碰。
 *
 * 事实来源：`docs/教务成绩接口调研.md`（真机实测，含浏览器 DevTools 抓包与本地
 * 参考实现 `个人教务系统/app.py` 的握手序列）。
 */

/** 教务系统基址。 */
export const EHALL_BASE = 'https://ehall.xjtu.edu.cn';

/**
 * 登录入口。
 *
 * ⚠️ **绝不能指向门户页** `https://ehall.xjtu.edu.cn/new/index.html` ——
 * 那是纯静态 SPA 外壳，未登录也返回 200 且页面里没有 `execution` 令牌，
 * 会让 `CasAuth.begin()` 误判成「已登录」并跳过登录，之后所有业务请求再被 302 踢回 CAS。
 * 必须是 jwapp 业务 URL（它会引出完整的 4 跳 CAS OAuth2 链）。
 */
export const LOGIN_URL = `${EHALL_BASE}/jwapp/sys/cjcx/*default/index.do`;

/**
 * 成绩查询应用的路径表。
 *
 * 取数必须走完**四步握手**（第 4 步之前任何直接请求都会 403）：
 *   1. GET  indexPath     建 jwapp 子系统会话，并从页面里取 appId
 *   2. GET  appConfig     授权握手 —— 少了这步必然 403
 *   3. POST appInit       body `{SFQY:'1', APP:<appId>}`，刷新 `_WEU` 防伪 token
 *   4. POST gradePath     body `{XNXQDM:'*'}`，拿到 datas.xscjcx.rows
 */
export const APP = {
  /** 应用名，用于拼模块路径与 Referer。 */
  name: 'cjcx',
  /** 应用 ID（也在应用页里动态取，这里作为兜底）。 */
  id: '4768574631264620',
  indexPath: '/jwapp/sys/cjcx/*default/index.do',
  gradePath: '/jwapp/sys/cjcx/modules/cjcx/xscjcx.do',
  appInitPath: '/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do',
  /** 授权握手地址是「应用名-应用ID」形式，用函数拼以免写错。 */
  appConfigPath: (appName = APP.name, appId = APP.id) => `/jwapp/sys/funauthapp/api/getAppConfig/${appName}-${appId}.do`,
};

/** 从应用页 HTML 里取 appId。 */
export const APP_ID_PATTERN = /"appId"\s*:\s*"(\d+)"/;

/** 成绩查询的请求体：`XNXQDM: '*'` = 全部学期。 */
export const GRADE_BODY = { XNXQDM: '*' };

/** 成绩行在响应里的位置：`datas.xscjcx.rows`。 */
export const GRADE_ROWS_PATH = ['datas', 'xscjcx', 'rows'];

/** 响应成功码是**字符串** `"0"`，不是数字 0（用 `=== 0` 判断会全部失败）。 */
export const SUCCESS_CODE = '0';

/** `SFYX`（是否有效）为这个值时才是有效成绩。 */
export const VALID_FLAG = '1';

/**
 * 教务字段 → 内部字段的映射。
 *
 * 只列本项目用到的；完整字段表（含 `QTCJ1..10` / `BY1..10` 等未使用项）见调研文档第 4 节。
 * 带 `_DISPLAY` 后缀的是给界面看的中文值，`display` 里单独列。
 */
export const FIELDS = {
  /** 课程名称 */
  courseName: 'KCM',
  /** 课程号 */
  courseCode: 'KCH',
  /** 学分 */
  credit: 'XF',
  /** ★ 学分绩点（学校直接给出，优先使用） */
  gradePoint: 'XFJD',
  /** 总评成绩（数值） */
  score: 'ZCJ',
  /** 期末成绩（可能是文本，等级制走这里） */
  finalScore: 'QMCJ',
  /** 期中成绩 */
  midScore: 'QZCJ',
  /** 平时成绩 */
  usualScore: 'PSCJ',
  /** 学期代码，形如 `2025-2026-1` */
  term: 'XNXQDM',
  /** 课程性质代码 */
  nature: 'KCXZDM',
  /** 课程类别代码 */
  category: 'KCLBDM',
  /** 考试类型代码 */
  examType: 'KSLXDM',
  /** 学时 */
  hours: 'XS',
  /** 是否有效 */
  valid: 'SFYX',
  /** 是否及格 */
  passed: 'SFJG',
  /** 等级成绩名称（等级制成绩走这里） */
  levelGrade: 'DJCJMC',
  /** 记录 ID —— 幂等键首选 */
  externalId: 'WID',
  /** 教学班 ID —— `externalId` 缺失时的幂等键备选 */
  classId: 'JXBID',
};

/** 需要一并保留的中文展示字段（教务以 `_DISPLAY` 后缀给出）。 */
export const DISPLAY_FIELDS = {
  term: 'XNXQDM',
  nature: 'KCXZDM',
  category: 'KCLBDM',
  examType: 'KSLXDM',
  valid: 'SFYX',
  passed: 'SFJG',
  finalScore: 'QMCJ',
};

/** 展示字段在原始行里的键名（`XNXQDM` → `XNXQDM_DISPLAY`）。 */
export const displayKey = (rawKey) => `${rawKey}_DISPLAY`;

/**
 * 官方百分制 → 4.3 制换算表（西安交通大学本科）。
 *
 * ⚠️ **这只是兜底**。实测发现教务**直接返回 `XFJD`（学分绩点）**，
 * 且与下表完全吻合（期末 93 → 4.0，84 → 3.3）。所以正常情况下用不到它；
 * 只有在 `XFJD` 缺失时才据此推算，并在记录上标 `gradePointSource: 'table'` 以便界面区分。
 *
 * 表本身按「分数下限」降序匹配（见 `gpa.js` 的 `scoreToGradePoint`）。
 * 用户给的原始区间在 95 处有重叠（`95-100` 与 `90-95` 都含 95），
 * 这里按降序取首个命中，即 **95 → 4.3**；这是个一行可改的约定。
 */
export const GPA_TABLE = [
  { min: 95, point: 4.3 },
  { min: 90, point: 4.0 },
  { min: 85, point: 3.7 },
  { min: 82, point: 3.3 },
  { min: 78, point: 3.0 },
  { min: 75, point: 2.7 },
  { min: 72, point: 2.3 },
  { min: 68, point: 2.0 },
  { min: 64, point: 1.5 },
  { min: 60, point: 1.0 },
  { min: 0, point: 0 },
];

/** 学分绩点的来源，用于在界面上如实标注。 */
export const GPA_SOURCE = {
  /** 教务直接给出，权威 */
  school: 'school',
  /** 按上表推算 */
  table: 'table',
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 合并模块配置：`options` 里给的同名字段覆盖默认值（浅合并，`app` 与 `fields` 逐层合并）。
 *
 * @param {object} [options] 来自 `createServer({ academic: {...} })` 或模块 options
 */
export function resolveAcademicConfig(options = {}) {
  const source = isPlainObject(options) ? options : {};
  return {
    baseUrl: source.baseUrl ?? EHALL_BASE,
    loginUrl: source.loginUrl ?? LOGIN_URL,
    app: { ...APP, ...(isPlainObject(source.app) ? source.app : {}) },
    gradeBody: { ...GRADE_BODY, ...(isPlainObject(source.gradeBody) ? source.gradeBody : {}) },
    gradeRowsPath: source.gradeRowsPath ?? GRADE_ROWS_PATH,
    successCode: source.successCode ?? SUCCESS_CODE,
    validFlag: source.validFlag ?? VALID_FLAG,
    fields: { ...FIELDS, ...(isPlainObject(source.fields) ? source.fields : {}) },
    gpaTable: Array.isArray(source.gpaTable) ? source.gpaTable : GPA_TABLE,
    /** 自动同步间隔（毫秒）；0 表示关闭定时同步。 */
    syncIntervalMs: Number.isFinite(source.syncIntervalMs) ? source.syncIntervalMs : 0,
    /** 单次同步的请求超时。 */
    timeoutMs: Number.isFinite(source.timeoutMs) ? source.timeoutMs : 25_000,
  };
}

/** 拼出完整 URL。 */
export function absolute(config, pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${config.baseUrl}${pathOrUrl}`;
}
