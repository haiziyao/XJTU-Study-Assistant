/**
 * dschat 2 标记行解析（伪工具调用）。
 *
 * dschat 2 用「提示词约定 + 前端正则」触发日历写入，标记行形如：
 *   [新增日程] 标题 | 日期 | 开始时间 | 结束时间 | 地点 | 重复 | 重复截止
 *   [删除日程] 标题
 *   [新增待办] 标题 | 优先级 | 截止日期 | 科目
 *   [新增学期] 名称 | 起始日期 | 周数
 *
 * 本解析器把标记行转成与本项目其它入口**完全一致的指令对象**，
 * 因此主程序既可以用结构化 draft，也可以直接投喂大模型输出的标记行。
 *
 * 兼容性：dschat 2 的 docs.html 写 8 字段（重复与间隔分列），而 server.py 实际注入 7 字段
 * （如 `每2周`）。这里两者都支持：若第 7 列是纯数字，则按 8 字段解析。
 */

import { addDays } from '../../shared/time.js';
import { normalizeLooseClock, normalizeLooseDate, repeatFromDschat } from './compat.js';

const MARKUP_RE = /^\s*[\[【]\s*(新增|删除|添加|完成)?\s*(日程|待办|学期)\s*[\]】]\s*(.*)$/;

const PRIORITY_TABLE = {
  high: 2, 高: 2, 重要: 2, 紧急: 2, 2: 2,
  medium: 1, 中: 1, 普通: 1, 一般: 1, 1: 1,
  low: 0, 低: 0, 不急: 0, 次要: 0, 0: 0,
};

const UNKNOWN = new Set(['', '无', 'none', 'null', '-']);

/** `HH:MM` 加一小时（用于标记行只给了开始时间的情况）。 */
function addHour(clock) {
  const [h, m] = String(clock).split(':').map(Number);
  const total = ((h || 0) * 60 + (m || 0) + 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function splitFields(rest) {
  return rest.split(/[|｜]/).map((part) => part.trim());
}

function isUnknown(value) {
  return UNKNOWN.has(String(value ?? '').trim().toLowerCase());
}

function pick(parts, index) {
  const value = parts[index];
  return isUnknown(value) ? undefined : value;
}

/**
 * 解析一段文本（可含多行标记行）。
 * @returns {{drafts: object[], unparsed: string[]}}
 */
export function parseMarkup(text) {
  const drafts = [];
  const unparsed = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(MARKUP_RE);
    if (!match) {
      unparsed.push(line);
      continue;
    }
    const [, verbRaw, kind, rest] = match;
    const verb = verbRaw ?? '新增';
    const action = /删除/.test(verb) ? 'delete' : /完成/.test(verb) ? 'complete' : 'create';
    const parts = splitFields(rest);
    const draft = kind === '日程' ? scheduleDraft(line, action, parts) : kind === '待办' ? todoDraft(line, action, parts) : semesterDraft(line, action, parts);
    drafts.push(draft);
  }
  return { drafts, unparsed };
}

function scheduleDraft(raw, action, parts) {
  const title = pick(parts, 0);
  if (action !== 'create') {
    return {
      ok: Boolean(title),
      raw,
      action,
      target: 'schedule',
      filters: title ? { keyword: title } : {},
      confidence: title ? 0.9 : 0.3,
      warnings: title ? [] : ['标记行缺少日程标题'],
      explain: `${action === 'delete' ? '删除' : '完成'}日程「${title ?? '未命名'}」`,
      markup: { type: 'schedule', fields: 7 },
    };
  }

  const warnings = [];
  const date = normalizeLooseDate(pick(parts, 1));
  const startTime = normalizeLooseClock(pick(parts, 2));
  const endTime = normalizeLooseClock(pick(parts, 3));
  const location = pick(parts, 4);
  let repeatText = pick(parts, 5);
  let repeatEnd = pick(parts, 6);
  // 8 字段旧格式：第 7 列为纯数字间隔，第 8 列为重复截止
  if (repeatEnd && /^\d+$/.test(repeatEnd)) {
    repeatText = `${repeatText ?? '每'}${repeatEnd}`;
    repeatEnd = pick(parts, 7);
  }
  if (!title) warnings.push('标记行缺少日程标题');
  if (!date) warnings.push('标记行缺少日期，默认今天');

  // 日程必须是时段：标记行没给时刻时补一个默认时段（不再退化成全天/待办）
  const timed = Boolean(startTime || endTime);
  if (!timed) warnings.push('标记行缺少开始时间，默认 09:00-10:00');
  const fields = {
    title: title ?? '未命名日程',
    date: date ?? new Date().toISOString().slice(0, 10),
    startTime: startTime ?? '09:00',
    endTime: endTime ?? (startTime ? addHour(startTime) : '10:00'),
    source: 'command',
  };
  if (location) fields.location = location;
  const repeat = repeatFromDschat({ repeat: repeatText, repeat_end: repeatEnd });
  if (repeat.type !== 'none') fields.repeat = repeat;

  return {
    ok: true,
    raw,
    action: 'create',
    target: 'schedule',
    fields,
    confidence: warnings.length ? 0.6 : 0.9,
    warnings,
    explain: `${fields.startTime}-${fields.endTime} ${fields.date} 添加日程「${fields.title}」`,
    markup: { type: 'schedule', fields: 7 },
  };
}

function todoDraft(raw, action, parts) {
  const title = pick(parts, 0);
  if (action !== 'create') {
    return {
      ok: Boolean(title),
      raw,
      action,
      target: 'todo',
      filters: title ? { keyword: title, completed: action === 'complete' ? false : undefined } : {},
      confidence: title ? 0.85 : 0.3,
      warnings: title ? [] : ['标记行缺少待办标题'],
      explain: `${action === 'delete' ? '删除' : '完成'}待办「${title ?? '未命名'}」`,
      markup: { type: 'todo' },
    };
  }

  const warnings = [];
  const priorityText = String(pick(parts, 1) ?? '').toLowerCase();
  const priority = PRIORITY_TABLE[priorityText] ?? 1;
  const date = normalizeLooseDate(pick(parts, 2));
  const subject = pick(parts, 3);
  if (!title) warnings.push('标记行缺少待办标题');
  // 待办的截止日是可选的：标记行没写日期就不设，不要编一个今天（会污染逾期提醒）。
  if (!date) warnings.push('标记行缺少截止日期，不设截止日');

  const fields = {
    title: title ?? '未命名待办',
    deadline: date ?? null,
    priority,
    source: 'command',
  };
  // dschat 2 的「科目」是自由文本，待办没有分类枚举，因此原文存入 tags 保留信息
  if (subject) fields.tags = [subject];

  return {
    ok: true,
    raw,
    action: 'create',
    target: 'todo',
    fields,
    confidence: warnings.length ? 0.6 : 0.88,
    warnings,
    explain: date
      ? `添加待办「${fields.title}」（截止 ${date}，优先级 ${priority}）`
      : `添加待办「${fields.title}」（不设截止日，优先级 ${priority}）`,
    markup: { type: 'todo' },
  };
}

function semesterDraft(raw, action, parts) {
  const name = pick(parts, 0);
  if (action !== 'create') {
    return {
      ok: Boolean(name),
      raw,
      action,
      target: 'event',
      filters: name ? { keyword: name } : {},
      confidence: name ? 0.8 : 0.3,
      warnings: name ? [] : ['标记行缺少学期名称'],
      explain: `删除学期「${name ?? '未命名'}」`,
      markup: { type: 'semester' },
    };
  }
  const warnings = [];
  const startDate = normalizeLooseDate(pick(parts, 1));
  const weeks = Number(pick(parts, 2) ?? 18) || 18;
  if (!name) warnings.push('标记行缺少学期名称');
  if (!startDate) warnings.push('标记行缺少起始日期，默认今天');
  const start = startDate ?? new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    raw,
    action: 'create',
    target: 'event',
    fields: {
      title: name ?? '未命名学期',
      category: 'study',
      startDate: start,
      endDate: addDays(start, Math.max(1, weeks) * 7 - 1),
      allDay: true,
      tags: [`共 ${weeks} 周`],
      source: 'command',
    },
    confidence: warnings.length ? 0.6 : 0.85,
    warnings,
    explain: `添加学期「${name ?? '未命名学期'}」：${start} 起 ${weeks} 周`,
    markup: { type: 'semester', weeks },
  };
}

/** 标记行的语法说明，供 /commands/grammar 追加展示。 */
export const MARKUP_GRAMMAR = {
  note: 'dschat 2 兼容：中文标记行会被转换为与 /commands/parse 相同的指令对象',
  lines: [
    '[新增日程] 标题 | 日期 | 开始时间 | 结束时间 | 地点 | 重复 | 重复截止',
    '[删除日程] 标题',
    '[完成日程] 标题',
    '[新增待办] 标题 | 优先级 | 截止日期 | 科目',
    '[删除待办] 标题',
    '[新增学期] 名称 | 起始日期 | 周数',
    '[删除学期] 名称',
  ],
  examples: [
    '[新增日程] 每周例会 | 2026-09-20 | 10:00 | 11:00 | 三教101 | 每2周 | 2026-12-31',
    '[新增日程] 数学考试 | 2026-09-30 | 09:00 | 11:00 | 三教101 | 无 | 无',
    '[新增待办] 高数作业 | 高 | 2026-09-25 | 数学',
  ],
};
