/**
 * 学情分析：把统计结果交给模型写一段点评；拿不到 AI 时用本地统计兜底。
 *
 * 两个设计要点：
 *
 * 1. **降级必须真的有用**。没配密钥 / 上游挂了时不能只显示"分析失败" ——
 *    本地兜底会给出确定性的统计摘要（学分绩、学分构成、拖后腿的课、未识别的成绩形式），
 *    这些信息本来就有价值。界面上会标明来源是 `local` 还是 `ai`，不含糊。
 *
 * 2. **陈旧要看得出来**。分析是对某一时刻的数据做的；用户改了纳入开关或重新同步后，
 *    旧分析就过期了。这里用一份**数据指纹**判断，而不是靠时间 ——
 *    因为"数据变了"才是关键，"过了多久"不是。
 */

import { createHash } from 'node:crypto';

/** 指纹覆盖真正影响结论的东西：被纳入的课程与它们的分数/绩点/学分。 */
export function fingerprintOf(grades, stats) {
  const basis = (grades ?? [])
    .filter((item) => item.active !== false)
    .map((item) => ({
      id: item.externalId ?? item.id,
      credit: item.credit,
      score: item.score,
      gradePoint: item.gradePoint,
      included: item.included !== false,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const payload = JSON.stringify({ basis, gpa: stats?.gpa ?? null, totalCredits: stats?.totalCredits ?? null });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** 模型能看到的材料：够它讲出有依据的话，但不至于把整库塞进去。 */
export function buildMaterials({ stats, grades, terms }) {
  const included = (grades ?? []).filter((item) => item.active !== false && item.included !== false);
  const excluded = (grades ?? []).filter((item) => item.active !== false && item.included === false);

  const courses = included
    .map((item) => ({
      name: item.courseName,
      credit: item.credit,
      score: item.score,
      gradePoint: item.gradePointResolved ?? item.gradePoint,
      term: item.termLabel ?? item.term,
      nature: item.natureLabel ?? null,
    }))
    .sort((a, b) => (a.gradePoint ?? 99) - (b.gradePoint ?? 99));

  return {
    summary: {
      gpa: stats?.gpa ?? null,
      weightedAverage: stats?.weightedAverage ?? null,
      totalCredits: stats?.totalCredits ?? null,
      earnedCredits: stats?.earnedCredits ?? null,
      includedCount: stats?.includedCount ?? included.length,
      courseCount: (grades ?? []).length,
    },
    terms: stats?.terms ?? [],
    termList: terms ?? [],
    /** 按绩点从低到高 —— 模型最容易看出"哪几门拖后腿" */
    courses,
    notCounted: excluded.map((item) => ({
      name: item.courseName,
      reason: item.gradePointResolved === null && item.gradePoint === null ? '等级制/无绩点' : '用户手动排除',
    })),
    warnings: stats?.warnings ?? [],
  };
}

/**
 * 系统提示词。
 *
 * 明确禁止编造数字、禁止给"你一定能保研"这类承诺 —— 学情点评最容易滑向鸡汤与过度承诺，
 * 而这个模块的价值恰恰在于**基于真实数据说人话**。
 */
export const ANALYSIS_SYSTEM = `你是一位学业顾问，正在为一个本科生写一段简短的学情分析。

要求：
1. **只依据给出的数据说话**。数据里没有的（比如排名、保研线、往年分数线）一律不要提，更不要编造。
2. 结构：先用一句话概括整体情况，然后指出 2-3 个具体观察（哪几门拉低了学分绩、哪个学期偏弱、
   学分构成如何），最后给 1-2 条可执行的建议。总长度控制在 200 字以内。
3. 语气平实、对事不对人。不说"你一定可以"这类空话，也不做"能不能保研/挂科"之类的断言。
4. 数据里 notCounted 是没进学分绩的课程（等级制或被手动排除）——如果它数量可观，
   要提醒用户"这部分没算进学分绩"，因为那会让学分绩看起来比实际偏低或偏高。
5. 直接输出正文，不要用 Markdown 标题，不要写"根据数据"这种开场白。`;

/** 用户消息：材料 + 一句明确的指令。 */
export function buildAnalysisUserMessage(materials) {
  return `这是我的成绩数据（JSON）：\n${JSON.stringify(materials, null, 2)}\n\n请据此写一段学情分析。`;
}

/**
 * 本地兜底分析：不依赖任何模型，纯统计。
 *
 * 它不假装是"AI 点评"，只把数据里的结论直白说出来 —— 界面会标注来源是本地统计。
 */
export function localAnalysis({ stats, grades }) {
  const included = (grades ?? []).filter((item) => item.active !== false && item.included !== false);
  if (!included.length) {
    return '还没有可用于分析的成绩。先同步一次教务成绩，或在成绩列表里把要计入的课程勾上。';
  }

  const parts = [];
  const gpa = stats?.gpa;
  const credits = stats?.totalCredits;
  if (typeof gpa === 'number') {
    parts.push(`当前学分绩 ${gpa.toFixed(3)}（按 ${stats.includedCount} 门课、${credits} 学分加权）。`);
  } else {
    parts.push(`当前有 ${included.length} 门课被纳入，但都拿不到绩点，无法计算学分绩。`);
  }

  if (typeof stats?.weightedAverage === 'number') {
    parts.push(`加权平均分 ${stats.weightedAverage.toFixed(2)}。`);
  }

  // 拖后腿的课：按绩点升序取最低的两门
  const ranked = included
    .map((item) => ({ name: item.courseName, gp: item.gradePointResolved ?? item.gradePoint, credit: item.credit }))
    .filter((item) => typeof item.gp === 'number')
    .sort((a, b) => a.gp - b.gp);
  if (ranked.length >= 2) {
    const [worst, second] = ranked;
    parts.push(`偏低的是「${worst.name}」（绩点 ${worst.gp}，${worst.credit} 学分）与「${second.name}」（绩点 ${second.gp}）。`);
  } else if (ranked.length === 1) {
    parts.push(`目前只有「${ranked[0].name}」一门有绩点。`);
  }

  // 学期差异
  const terms = (stats?.terms ?? []).filter((term) => typeof term.gpa === 'number');
  if (terms.length >= 2) {
    const best = terms.reduce((a, b) => (b.gpa > a.gpa ? b : a));
    const worst = terms.reduce((a, b) => (b.gpa < a.gpa ? b : a));
    if (best.term !== worst.term && best.gpa - worst.gpa >= 0.3) {
      parts.push(`${best.termLabel ?? best.term} 表现最好（${best.gpa}），${worst.termLabel ?? worst.term} 相对偏弱（${worst.gpa}）。`);
    }
  }

  // 没进学分绩的部分 —— 这是最容易被忽略、也最影响"看起来的分数"的
  const notCounted = (grades ?? []).filter((item) => item.active !== false && item.included === false);
  if (notCounted.length) {
    const names = notCounted.slice(0, 3).map((item) => item.courseName).join('、');
    parts.push(`另有 ${notCounted.length} 门课未计入学分绩（${names}${notCounted.length > 3 ? ' 等' : ''}），其中多数是等级制成绩。`);
  }

  parts.push('（以上为本地统计，配置 AI 后可获得更具体的点评与建议。）');
  return parts.join('');
}

/** 传给 AI 模块的调用参数。 */
export function analysisRequest({ stats, grades, terms }) {
  const materials = buildMaterials({ stats, grades, terms });
  return {
    system: ANALYSIS_SYSTEM,
    user: buildAnalysisUserMessage(materials),
    // 点评是"就着材料写一段话"，不需要思考链；开着只会更慢更贵
    thinking: 'none',
    materials,
  };
}
