/**
 * 全局常量与枚举。
 *
 * 该文件同时被后端（src/server）与 Electron 前端（src/main、src/renderer）引用，
 * 因此禁止引入任何 Node.js 专有依赖。
 */

/** 后端服务默认监听地址（仅本机，不对外暴露）。 */
export const DEFAULT_HOST = '127.0.0.1';
/** 后端服务默认端口。 */
export const DEFAULT_PORT = 3210;

/** REST 接口前缀。 */
export const API_PREFIX = '/api/v1';
/** WebSocket 推送路径。 */
export const WS_PATH = '/ws';

/** 数据文件所在目录（相对 package 根目录）。 */
export const DATA_DIR = 'data';

/**
 * 日历事件（event）：以“日期 / 日期区间”为主，允许全天、允许跨天。
 * 用于假期、纪念日、考试、截止日等。
 */
export const EVENT_CATEGORIES = ['study', 'exam', 'holiday', 'anniversary', 'deadline', 'other'];

/**
 * 日程（schedule）：挂在某一天之下、有明确起止时刻的安排。
 * 用于上课、自习、会议、约见等。
 */
export const SCHEDULE_CATEGORIES = ['class', 'study', 'meeting', 'exam', 'activity', 'other'];

/**
 * 日程状态机：pending(待进行) -> done(已完成) / cancelled(已取消) / rolled(已顺延)。
 *
 * 说明：PotatoCalendar 的「顺延」把原计划直接标记为已完成，导致历史与统计失真；
 * 这里单独引入 rolled 状态，并保留 rolledTo / rolledFrom 双向引用，
 * 使「被顺延」与「已完成」在数据上可区分。
 */
export const SCHEDULE_STATUS = ['pending', 'done', 'cancelled', 'rolled'];

/** 重复规则类型：none 表示单次。 */
export const REPEAT_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'weekday'];

/** 重复规则的默认结束方式：永不结束 / 指定日期 / 指定次数。 */
export const REPEAT_UNTIL_MODES = ['never', 'date', 'count'];

/** 提醒提前量（分钟），0 表示准点。前端只提供这几个档位，后端接受任意非负整数。 */
export const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 1440];

/** 指令操作类型。rollover 用于「顺延未完成日程到本周」。 */
export const COMMAND_ACTIONS = ['create', 'query', 'update', 'delete', 'complete', 'rollover'];

/** 指令作用对象。 */
export const COMMAND_TARGETS = ['event', 'schedule'];

/** WebSocket 下行消息类型。 */
export const WS_MESSAGE_TYPES = {
  READY: 'ready',
  REMINDER: 'reminder',
  DATA_CHANGED: 'data_changed',
  ERROR: 'error',
};

/** 后端错误码，与 HTTP 状态码解耦，便于前端口径统一。 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PARSE_FAILED: 'PARSE_FAILED',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL',
  /** 需要先登录外部系统（思源学堂）。 */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 外部系统（学校服务器）返回了错误或无法解析的内容。 */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
};

/** AI 能力开关：本阶段统一关闭，仅保留接口契约。 */
export const AI_FEATURES = {
  /** 自然语言 -> 指令（由大模型完成，当前返回 501 占位）。 */
  NL_TO_COMMAND: 'nl_to_command',
  /** 指令 -> 结构化预览说明（当前由规则解析器本地降级实现）。 */
  COMMAND_EXPLAIN: 'command_explain',
  /** 学习计划建议（未接入）。 */
  PLAN_SUGGESTION: 'plan_suggestion',
};
