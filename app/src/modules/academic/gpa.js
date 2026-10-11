/**
 * 学分绩与加权平均分的**纯计算**。
 *
 * 这个文件不碰网络、不碰存储、不碰时间 —— 全部是纯函数，所以可以放心单测，
 * 也可以在界面侧复用（前端做"勾选后即时重算"时不必往返一次后端）。
 *
 * 两条口径（都只算**被纳入**的有效成绩）：
 *   - 学分绩（GPA）  = Σ(学分 × 绩点) / Σ(学分)
 *   - 加权平均分     = Σ(学分 × 总评) / Σ(学分)
 * 分母是「**有该项数据**的学分之和」，不是全部学分 —— 否则一门没有绩点的课会把
 * 平均值整体拉低，那是错的。没被计入的会在 `unmapped` 里如实报出来。
 */

import { GPA_SOURCE, GPA_TABLE } from './config.js';

/** 抹掉浮点尾差（0.1+0.2 那类），保留 4 位足够表达绩点精度。 */
export function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 转成有限数字；空串 / null / 非数字文本一律返回 null。 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 百分制分数 → 4.3 制绩点（官方换算表）。
 *
 * 按**分数下限降序**匹配首个命中，所以：
 *   - 整数分没有歧义（区间之间的空隙对整数不产生影响）；
 *   - 95 命中第一条（4.3）—— 用户给的原始区间在 95 处重叠，这是取定的约定；
 *   - 小数分（如 89.5）落入 `>=85` 一档，与「85-89 → 3.7」的书面表述略有出入，
 *     但因为教务**直接返回 XFJD**，这张表只是兜底，影响面很小。
 *
 * @param {number|string|null} score
 * @param {Array<{min:number,point:number}>} [table]
 * @returns {number|null} 无法判定时返回 null
 */
export function scoreToGradePoint(score, table = GPA_TABLE) {
  const value = toNumber(score);
  if (value === null) return null;
  const bands = [...table].sort((a, b) => b.min - a.min);
  for (const band of bands) {
    if (value >= band.min) return band.point;
  }
  return null;
}

/**
 * 判定一条成绩的绩点，**优先用教务给的 `XFJD`**。
 *
 * 实测确认教务直接返回学分绩点，且与官方换算表吻合（期末 93 → 4.0，84 → 3.3）。
 * 因此只有当 `gradePoint` 缺失时才回退到换算表，并如实标注来源，
 * 让界面能区分「学校给的」与「我们算的」。
 *
 * @returns {{ point: number|null, source: string|null }}
 */
export function gradePointOf(record = {}, table = GPA_TABLE) {
  const school = toNumber(record.gradePoint);
  if (school !== null) return { point: school, source: GPA_SOURCE.school };
  const derived = scoreToGradePoint(record.score, table);
  if (derived !== null) return { point: derived, source: GPA_SOURCE.table };
  return { point: null, source: null };
}

/** 一条成绩是否有效（`SFYX === '1'`）。缺字段时按有效处理，避免误伤旧数据。 */
export function isValid(record = {}) {
  if (record.valid === undefined || record.valid === null || record.valid === '') return true;
  return String(record.valid) === '1';
}

/** 是否被用户纳入统计（默认纳入；同步**不会**覆盖这个字段）。 */
export function isIncluded(record = {}) {
  return record.included !== false;
}

/**
 * 统计一组成绩。
 *
 * @param {Array<object>} records 归一化后的成绩记录
 * @param {object} [options]
 * @param {Array<{min:number,point:number}>} [options.table] 换算表（兜底用）
 * @param {boolean} [options.onlyIncluded=true] 是否只统计被纳入的
 * @returns {object} 统计结果（见下方字段说明）
 */
export function computeStats(records = [], options = {}) {
  const table = options.table ?? GPA_TABLE;
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];

  const invalid = [];
  const skipped = [];
  const candidates = [];
  for (const record of list) {
    if (!isValid(record)) invalid.push(record);
    else if (!isIncluded(record)) skipped.push(record);
    else candidates.push(record);
  }

  let gpaCredit = 0;
  let gpaWeighted = 0;
  let scoreCredit = 0;
  let scoreWeighted = 0;
  const counted = [];
  /** 被纳入、但拿不到绩点（因而进不了 GPA）的课程 —— 必须在界面上说出来。 */
  const unmapped = [];
  /** 学分缺失或为 0 的课程：无法加权，单独报出。 */
  const zeroCredit = [];

  for (const record of candidates) {
    const credit = toNumber(record.credit);
    if (credit === null || credit <= 0) {
      zeroCredit.push(record);
      continue;
    }
    const { point, source } = gradePointOf(record, table);
    if (point === null) {
      unmapped.push(record);
    } else {
      gpaCredit += credit;
      gpaWeighted += credit * point;
      counted.push({ record, credit, point, source });
    }
    const score = toNumber(record.score);
    if (score !== null) {
      scoreCredit += credit;
      scoreWeighted += credit * score;
    }
  }

  // 学期分组：用学期代码排序，没有代码的排最后
  const byTerm = new Map();
  for (const item of counted) {
    const key = item.record.term ?? '';
    if (!byTerm.has(key)) {
      byTerm.set(key, {
        term: key,
        termLabel: item.record.termLabel ?? key,
        credits: 0,
        weighted: 0,
        courses: 0,
      });
    }
    const bucket = byTerm.get(key);
    bucket.credits += item.credit;
    bucket.weighted += item.credit * item.point;
    bucket.courses += 1;
  }

  const terms = [...byTerm.values()]
    .map((bucket) => ({
      term: bucket.term,
      termLabel: bucket.termLabel,
      credits: round(bucket.credits, 2),
      courses: bucket.courses,
      gpa: bucket.credits > 0 ? round(bucket.weighted / bucket.credits, 4) : null,
    }))
    .sort((a, b) => String(a.term).localeCompare(String(b.term)));

  const totalCredits = round(
    candidates.reduce((sum, r) => sum + (toNumber(r.credit) ?? 0), 0),
    2,
  );

  const warnings = [];
  if (unmapped.length) {
    warnings.push(`${unmapped.length} 门课没有绩点也没法从分数换算，未计入学分绩`);
  }
  if (zeroCredit.length) {
    warnings.push(`${zeroCredit.length} 门课学分缺失或为 0，无法加权`);
  }
  if (skipped.length) warnings.push(`${skipped.length} 门课已被手动排除，未计入`);

  return {
    /** 总记录数（含无效与被排除的）。 */
    total: list.length,
    /** 有效记录数。 */
    validCount: list.length - invalid.length,
    /** 被用户排除的数量。 */
    skippedCount: skipped.length,
    /** 实际参与统计的课程数。 */
    includedCount: candidates.length,
    /** 被纳入课程的学分合计。 */
    totalCredits,
    /** 真正进了 GPA 分子分母的学分。 */
    gpaCredits: round(gpaCredit, 2),
    /** 有数值总评的学分。 */
    scoreCredits: round(scoreCredit, 2),
    /** 学分绩；无可计算项时为 null（而不是 0 —— 两者含义不同）。 */
    gpa: gpaCredit > 0 ? round(gpaWeighted / gpaCredit, 4) : null,
    /** 加权平均分。 */
    weightedAverage: scoreCredit > 0 ? round(scoreWeighted / scoreCredit, 4) : null,
    /** 按学期细分。 */
    terms,
    /** 进不了 GPA 的课程（界面上要显式提示）。 */
    unmapped: unmapped.map(brief),
    /** 学分异常的课程。 */
    zeroCredit: zeroCredit.map(brief),
    warnings,
  };
}

/** 只保留界面需要的少量字段，避免把整条记录塞进接口响应。 */
function brief(record = {}) {
  return {
    id: record.id ?? null,
    courseName: record.courseName ?? null,
    credit: toNumber(record.credit),
    score: toNumber(record.score),
    scoreText: record.scoreText ?? null,
    term: record.term ?? null,
    reason: record.reason ?? null,
  };
}

/**
 * 学分绩变化对比：给「同步后展示变化」用。
 *
 * @returns {{ delta: number|null, before: number|null, after: number|null, improved: boolean|null }}
 */
export function compareGpa(before, after) {
  const a = toNumber(before);
  const b = toNumber(after);
  if (a === null || b === null) return { before: a, after: b, delta: null, improved: null };
  const delta = round(b - a, 4);
  return { before: a, after: b, delta, improved: delta > 0 ? true : delta < 0 ? false : null };
}
