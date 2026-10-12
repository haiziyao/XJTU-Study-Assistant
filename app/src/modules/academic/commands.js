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
import { matchesNature } from './config.js';

/** 「这学期」在 filters.term 里的占位值，由 parser 产出、这里按"今天"推断成具体学期。 */
const CURRENT_TERM = 'current';

/**
 * 把学期写法归一到规范键 `2025-2026-1`。
 *
 * 库里两种写法并存：`record.term` 是代码（`2025-2026-1`），`record.termLabel` 是教务的
 * 中文说法（`2025-2026学年 第一学期`，也可能带间隔号写成 `2025-2026 学年 · 第 1 学期`）。
 * 代码串**不是** label 的子串，所以 `termLabel.includes(term)` 这种写法必然 0 命中；
 * 而放宽成"随便比一段子串"（比如只比学年区间 `2025-2026`）又会让第 1、第 2 学期互相串台。
 * 两边都归一到同一个规范键再比相等：两种写法都认，也**不会退化成随便子串就能中**。
 * 归不出来（只有学年没有学期序号）就返回空串，交给调用方按"认不出"处理。
 */
function canonicalTerm(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (!text) return '';
  const years = text.match(/(\d{4})[-–—~至](\d{4})/);
  if (!years) return '';
  const named = text.match(/第?([一二1１2２])学期/);
  let index = named ? (/[一1１]/.test(named[1]) ? '1' : '2') : '';
  if (!index) {
    // 纯代码写法：`2025-2026-1` 的末位数字
    const tail = text.match(/[-–—]([12])$/);
    if (tail) index = tail[1];
  }
  return index ? `${years[1]}-${years[2]}-${index}` : '';
}

/** 学期匹配：`term` 与 `termLabel` 只要有一个能归一到 filters.term 的规范形式就算命中。 */
function matchesTerm(record, term) {
  const wanted = canonicalTerm(term);
  // 认不出来的写法退回严格相等，别拿半截字符串去碰运气
  if (!wanted) return String(record.term ?? '').trim() === String(term ?? '').trim();
  return canonicalTerm(record.term) === wanted || canonicalTerm(record.termLabel) === wanted;
}

/**
 * 按"今天"推断当前学期。
 *
 * 规则按校历：9 月~次年 1 月是第 1 学期（学年 = 当年 ~ 当年+1），2~8 月是第 2 学期（学年 = 上年 ~ 当年）。
 * 刻意**只按月份推、不看数据** —— 数据里到底有没有这个学期由调用方判断，
 * 这样推断逻辑是纯函数（好测），而且"推出来的学期没记录"能被当成一个明确的状态来处理。
 */
function inferCurrentTerm(now = new Date()) {
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month >= 9) return `${year}-${year + 1}-1`;
  if (month === 1) return `${year - 1}-${year}-1`;
  return `${year - 1}-${year}-2`;
}

/**
 * 解析 filters.term：`'current'` 换成今天推断出的学期代码，其余原样返回。
 * `isCurrent` 让调用方能区分"用户明确指的学期"和"系统猜的学期" —— 猜的那个查不到时必须说明，
 * 不能装作筛选成功（写操作更是绝不能因此退化成"改全部课程"）。
 */
function resolveTerm(term) {
  const wanted = String(term ?? '').trim();
  if (!wanted) return { term: '', isCurrent: false, inferred: '' };
  if (wanted.toLowerCase() === CURRENT_TERM) {
    const inferred = inferCurrentTerm();
    return { term: inferred, isCurrent: true, inferred };
  }
  return { term: wanted, isCurrent: false, inferred: wanted };
}

/** 课程名模糊匹配：忽略大小写与首尾空白，够用且不引入拼音/分词依赖。 */
function matchesKeyword(record, keyword) {
  if (!keyword) return true;
  const needle = String(keyword).trim().toLowerCase();
  if (!needle) return true;
  const haystack = [record.courseName, record.courseCode, record.termLabel].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

/**
 * 课程性质匹配。
 *
 * `filters.nature` 从本地规则和 AI 来的是两位代码（"01"=必修、"02"=选修，见 module.js 的 aiPrompt），
 * mock 里也是 "01"；但**真实教务**返回的 KCXZDM 是一位（库里 44 条实测是 "1"/"2"），
 * 直接比相等会让「把选修课都排除掉」永远 0 命中 —— 又是一句"本地有成绩数据，但没有符合
 * 这些条件的课程"。这里把两边都去掉前导零再比（"01"≡"1"），顺带认中文标签，
 * 于是本地规则、AI 草稿、真实数据三者都能对上。
 */
// 归一逻辑与 `service.listGrades` 共用一份（`config.js` 的 matchesNature）：
// 真实教务是一位代码（"1"/"2"），接口参数与 AI 草稿是两位（"01"/"02"），两边都要对得上。

/** 不及格：`SFJG` 优先，缺失时退回总评 < 60。 */
function isFailed(record) {
  if (record.passed !== undefined && record.passed !== null && record.passed !== '') return String(record.passed) !== '1';
  return typeof record.score === 'number' && record.score < 60;
}

export function createAcademicCommands({ academic }) {
  /**
   * 按 filters 定位成绩；条件之间是「与」的关系。
   *
   * `filtersOverride` 给调用方一个"先把 term 里的 'current' 换成具体学期（或干脆去掉 term）"
   * 的机会，免得为了改一个字段就去深拷贝整个 draft。
   */
  function locate(draft, filtersOverride) {
    const filters = filtersOverride ?? draft?.filters ?? {};
    return academic.listGrades({ includeStale: filters.includeStale !== false }).filter((record) => {
      if (filters.id && record.id !== String(filters.id)) return false;
      if (filters.term && !matchesTerm(record, filters.term)) return false;
      if (filters.nature && !matchesNature(record, filters.nature)) return false;
      if (filters.included !== undefined && filters.included !== null) {
        if ((record.included !== false) !== Boolean(filters.included)) return false;
      }
      if (filters.failedOnly && !isFailed(record)) return false;
      if (!matchesKeyword(record, filters.keyword ?? filters.courseName)) return false;
      return true;
    });
  }

  /** 把 filters.term 里的 'current' 换成本次推断出的学期代码，并回报它是不是"系统猜的"。 */
  function withResolvedTerm(filters) {
    const resolved = resolveTerm(filters?.term);
    if (!resolved.isCurrent) return { filters, resolved };
    return { filters: { ...filters, term: resolved.term }, resolved };
  }

  /**
   * 只回模型/界面真正需要的字段，避免整库塞回去。
   *
   * `levelGrade` / `passedLabel` 也得带上：等级制课程没有分数也没有绩点，这两个字段是对话里
   * 唯一的"成绩"来源，缺了就显示成空分数（投影表在 module.js 的 aiQueryFields.grade 里）。
   */
  const brief = (record) => ({
    id: record.id,
    courseName: record.courseName,
    courseCode: record.courseCode,
    credit: record.credit,
    score: record.score,
    gradePoint: record.gradePointResolved ?? record.gradePoint,
    levelGrade: record.levelGrade ?? null,
    term: record.term,
    termLabel: record.termLabel,
    natureLabel: record.natureLabel,
    included: record.included !== false,
    passed: record.passed ?? null,
    passedLabel: record.passedLabel ?? null,
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
      const raw = draft?.filters ?? {};
      // 「这学期/本学期」是按今天推出来的，先拿它去查
      const { filters: pinned, resolved } = withResolvedTerm(raw);
      let filters = pinned;
      let found = locate(draft, filters);
      let note = '';
      // ★ 推断不出就**不瞎猜**：库里没有这个学期的记录时退回全部，并把原因讲清楚。
      // 否则用户看到的是"本地有成绩数据，但没有符合这些条件的课程"，只会以为筛选坏了。
      if (resolved.isCurrent && !found.length && academic.listGrades().length) {
        filters = { ...raw };
        delete filters.term;
        note = `没找到当前学期（${resolved.inferred}）的记录，先按全部列出。`;
        found = locate(draft, filters);
      }
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
        explain: items.length ? `${note}命中 ${items.length} 门课程。` : explainMiss(filters),
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
    const { filters, resolved } = withResolvedTerm(draft?.filters ?? {});
    const found = locate(draft, filters);
    if (!found.length) {
      // ★ 写操作没有"先按全部列出"这个选项：猜出来的当前学期查不到就明确报错，
      // 绝不因为"猜不准"把改动扩大到全部课程 —— 那是一次静默的全量写入。
      if (resolved.isCurrent) {
        throw new HttpError(404, 'NOT_FOUND', `没找到当前学期（${resolved.inferred}）的成绩 —— 请指明具体学期或先同步一次。`);
      }
      throw new HttpError(404, 'NOT_FOUND', `没有找到符合条件的成绩 —— ${explainMiss(filters)}`);
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
