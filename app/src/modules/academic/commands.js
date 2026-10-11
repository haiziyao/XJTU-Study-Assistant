/**
 * 学业模块的对话指令处理器，注册给 target `grade`。
 *
 * 有了它，「我高数考了多少分」「把选修课都排除掉」「重新同步一下成绩」这类话
 * 既能被本地规则解析，也能被 AI 出草稿后执行 —— 而且 AI 走的是同一条 `query` 只读路径，
 * 所以它回答成绩问题时看到的就是库里真实的数据。
 *
 * 处理器契约见 core/commands/command-service.js：
 *   键 = action 名，值 = (draft, options) => object；`options.dryRun` 时只预览不写库。
 *
 * 语义约定：
 * - `query` **只读**，永远不写库，也不受 dryRun 影响；
 * - `include` / `exclude` 是写操作，dryRun 时只回报"会影响哪几门"；
 * - `sync` 是唯一会访问外部网络的 action，dryRun 时不落库。
 */

import { HttpError } from '../../core/http/router.js';

/** 课程名模糊匹配：忽略大小写与首尾空白，够用且不引入拼音/分词依赖。 */
function matchesKeyword(record, keyword) {
  if (!keyword) return true;
  const needle = String(keyword).trim().toLowerCase();
  if (!needle) return true;
  const haystack = [record.courseName, record.courseCode, record.termLabel].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

/** 不及格：`SFJG` 优先，缺失时退回总评 < 60。 */
function isFailed(record) {
  if (record.passed !== undefined && record.passed !== null && record.passed !== '') return String(record.passed) !== '1';
  return typeof record.score === 'number' && record.score < 60;
}

export function createAcademicCommands({ academic }) {
  /** 按 filters 定位成绩；条件之间是「与」的关系。 */
  function locate(draft) {
    const filters = draft?.filters ?? {};
    return academic.listGrades({ includeStale: filters.includeStale !== false }).filter((record) => {
      if (filters.id && record.id !== String(filters.id)) return false;
      if (filters.term && record.term !== filters.term) return false;
      if (filters.nature && record.nature !== filters.nature) return false;
      if (filters.included !== undefined && filters.included !== null) {
        if ((record.included !== false) !== Boolean(filters.included)) return false;
      }
      if (filters.failedOnly && !isFailed(record)) return false;
      if (!matchesKeyword(record, filters.keyword ?? filters.courseName)) return false;
      return true;
    });
  }

  /** 只回模型/界面真正需要的字段，避免整库塞回去。 */
  const brief = (record) => ({
    id: record.id,
    courseName: record.courseName,
    courseCode: record.courseCode,
    credit: record.credit,
    score: record.score,
    gradePoint: record.gradePointResolved ?? record.gradePoint,
    term: record.term,
    termLabel: record.termLabel,
    natureLabel: record.natureLabel,
    included: record.included !== false,
    passed: record.passed ?? null,
  });

  /** 空结果和"查不到"要分得清：前者说明筛选条件太窄，后者说明还没同步。 */
  function explainMiss(filters) {
    const total = academic.store.academicGrades.all().length;
    if (total === 0) return '本地还没有成绩数据，需要先同步一次。';
    return '本地有成绩数据，但没有符合这些条件的课程 —— 可能是学期或课程名不对。';
  }

  return {
    /** 只读查询。 */
    query(draft) {
      const filters = draft?.filters ?? {};
      const found = locate(draft);
      const items = found.map(brief);
      const stats = academic.stats();
      return {
        filters,
        count: items.length,
        items,
        // 顺带把整体口径带上，模型回答「我的学分绩多少」时不必再查一次
        summary: {
          gpa: stats.gpa,
          weightedAverage: stats.weightedAverage,
          totalCredits: stats.totalCredits,
          earnedCredits: stats.earnedCredits,
          includedCount: stats.includedCount,
        },
        explain: items.length
          ? `命中 ${items.length} 门课程。`
          : explainMiss(filters),
      };
    },

    /** 纳入（写）。 */
    async include(draft, options = {}) {
      return applyToggle(draft, options, true);
    },

    /** 排除（写）。 */
    async exclude(draft, options = {}) {
      return applyToggle(draft, options, false);
    },

    /** 同步（写，唯一访问外部网络的 action）。 */
    async sync(draft, options = {}) {
      const result = await academic.sync({ dryRun: Boolean(options.dryRun) });
      return {
        synced: !options.dryRun,
        counts: result.counts,
        gpa: result.stats.gpa,
        weightedAverage: result.stats.weightedAverage,
        totalCredits: result.stats.totalCredits,
        warnings: result.stats.warnings,
        explain: options.dryRun
          ? `预览：将新增 ${result.counts.inserted} 门、更新 ${result.counts.updated} 门。`
          : `同步完成：新增 ${result.counts.inserted} 门、更新 ${result.counts.updated} 门。`,
      };
    },
  };

  /** include / exclude 的公共实现：先定位，再按 dryRun 决定是否真的写。 */
  async function applyToggle(draft, options, included) {
    const found = locate(draft);
    if (!found.length) {
      throw new HttpError(404, 'NOT_FOUND', `没有找到符合条件的成绩 —— ${explainMiss(draft?.filters ?? {})}`);
    }
    const already = found.filter((record) => (record.included !== false) === included);
    const targets = found.filter((record) => (record.included !== false) !== included);

    if (options.dryRun) {
      return {
        dryRun: true,
        willChange: targets.map(brief),
        affected: targets.map((record) => record.id),
        unchanged: already.length,
        explain: `将把 ${targets.length} 门课程设为${included ? '纳入' : '排除'}${already.length ? `（另有 ${already.length} 门已经是该状态）` : ''}。`,
      };
    }

    if (!targets.length) {
      return {
        changed: 0,
        affected: [],
        unchanged: already.length,
        explain: `这 ${already.length} 门课程已经是${included ? '纳入' : '排除'}状态，无需改动。`,
      };
    }

    const result = await academic.setIncludedBulk({ ids: targets.map((record) => record.id), included });
    return {
      changed: result.changed,
      affected: targets.map((record) => record.id),
      courses: targets.map(brief),
      stats: academic.stats(),
      explain: `已把 ${result.changed} 门课程设为${included ? '纳入' : '排除'}。`,
    };
  }
}
