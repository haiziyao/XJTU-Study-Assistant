/**
 * 学业模块的本地规则解析器（target `grade`）。
 *
 * 作用：**没接 AI 时也能用**。「我学分绩多少」「把选修课都排除掉」「同步一下成绩」
 * 这类话不必依赖模型；接了 AI 时它也是更便宜、更确定的第一道。
 *
 * ⚠️ 必须**保守**：`CommandService.tryParse` 按注册顺序取**第一个** `ok:true` 的结果，
 * 所以本解析器只能在自己确实认得时才成功 —— 否则会把
 * 「明天下午三点开会」这类日历指令抢过来，让日历模块永远收不到输入。
 * 因此下面每一条规则都要求出现**明确的学业词**（成绩 / 学分 / 绩点 / 课程名 + 纳入排除）。
 */

/**
 * 「在聊学业」的信号词。
 *
 * 刻意不包含裸的「课」：日历解析器是个"什么都能接"的兜底解析器（任何文本都能给出
 * 0.82~0.85 的置信度），所以本解析器只有在自己**确实认得**时才该成功。
 * 少了这道门槛，「把明天的会排除掉」会被当成"排除某门课"。
 */
const GRADE_WORDS = /成绩|分数|学分|学分绩|绩点|GPA|gpa|考了|考多少|不及格|挂科|重修|课程|选修|必修/;
const TOGGLE_WORDS = /纳入|计入|排除|不算|去掉|勾上|取消勾选/;
const SYNC_WORDS = /同步|刷新|更新/;
const QUERY_WORDS = /多少|几门|查|看看|有没有|哪些|列出|统计|怎么样/;

/**
 * 去掉口语里的疑问尾巴与语气词，剩下的当课程名。
 *
 * 先整块吃掉疑问短语，再清零散成分 —— 否则「高等数学考了多少分」会剩下「高等数学考了分」
 * （「多少」被吃掉但「分」还在），拿去做关键词匹配就永远查不到。
 */
function extractCourseName(text) {
  let name = text;
  for (const pattern of [
    /(考了多少分|考了多少|考了几分|考多少分|考多少|多少分|几分|是多少|是几|多少|怎么样|如何)/g,
    /^(把|将|帮我|请|给我)+/,
    /(都|全部|全都)/g,
    /(纳入|计入|排除|不算|去掉|勾上|取消勾选)/g,
    /(学分绩|绩点|成绩|分数|课程|选修课|必修课|选修|必修)/g,
    /(这门|那门|的课|课)/g,
    /(吗|呢|？|\?|。|！|!)/g,
  ]) {
    name = name.replace(pattern, '');
  }
  name = name.replace(/^[的了是]+/, '').replace(/[的了是]+$/, '').trim();
  // 剩下的若是代词或空串，说明用户没指定具体课程
  if (!name || /^(我|我的|你|他|她|它|这门|那门|全部|所有|一切)$/.test(name)) return '';
  return name;
}

/** 从文本里认出学期，形如「2024-2025-1」「2024-2025学年第一学期」。 */
function extractTerm(text) {
  const code = text.match(/(\d{4})\s*[-–]\s*(\d{4})\s*[-–]\s*([12])/);
  if (code) return `${code[1]}-${code[2]}-${code[3]}`;
  const named = text.match(/(\d{4})\s*[-–]\s*(\d{4})\s*学年\s*第?\s*([一二1２])\s*学期/);
  if (named) {
    const index = /[一1１]/.test(named[3]) ? '1' : '2';
    return `${named[1]}-${named[2]}-${index}`;
  }
  return undefined;
}

export class AcademicParser {
  /** @param {{ academic?: object }} [deps] 目前不需要依赖，留作后续扩展。 */
  constructor(deps = {}) {
    this.deps = deps;
  }

  parse(rawText) {
    const raw = typeof rawText === 'string' ? rawText.trim() : '';
    const miss = { ok: false, raw: rawText, warnings: [] };
    if (!raw) return miss;

    // ---- 同步：要求「同步/刷新/更新」与学业词同现，避免抢走「刷新一下页面」这类 ----
    if (SYNC_WORDS.test(raw) && GRADE_WORDS.test(raw)) {
      return {
        ok: true,
        raw,
        action: 'sync',
        target: 'grade',
        filters: {},
        confidence: 0.92,
        explain: '同步教务成绩',
      };
    }

    const term = extractTerm(raw);
    const isGradeTalk = GRADE_WORDS.test(raw);
    // ★ 必须真的提到学业才继续 —— 日历解析器是兜底的，这里放宽就会把它抢了
    if (!isGradeTalk) return miss;

    const wantsToggle = TOGGLE_WORDS.test(raw);
    const include = /纳入|计入|勾上/.test(raw);
    const exclude = /排除|不算|去掉|取消勾选/.test(raw);

    // ---- 纳入 / 排除 ----
    if (wantsToggle && (include || exclude)) {
      const filters = {};
      if (term) filters.term = term;
      if (/选修/.test(raw)) filters.nature = '02';
      if (/必修/.test(raw)) filters.nature = '01';
      if (/不及格|挂科|没过的/.test(raw)) filters.failedOnly = true;

      const courseName = extractCourseName(raw);
      if (courseName) filters.keyword = courseName;

      return {
        ok: true,
        raw,
        action: include ? 'include' : 'exclude',
        target: 'grade',
        filters,
        confidence: 0.9,
        explain: `${include ? '纳入' : '排除'}${courseName ? `「${courseName}」` : '符合条件的课程'}`,
      };
    }

    // ---- 查询：需要疑问/列举意图，否则「我的课程设计」这类会被当成查询 ----
    const isListing = QUERY_WORDS.test(raw) || /不及格|挂科|没过的|全部|所有|列一下|有哪些/.test(raw);
    if (isListing) {
      const filters = {};
      if (term) filters.term = term;
      if (/必修/.test(raw)) filters.nature = '01';
      if (/选修/.test(raw)) filters.nature = '02';
      if (/不及格|挂科|没过的/.test(raw)) filters.failedOnly = true;
      if (/没纳入|已排除|不算的/.test(raw)) filters.included = false;
      if (/已纳入|算进去的|计入的/.test(raw)) filters.included = true;

      const courseName = extractCourseName(raw);
      if (courseName) filters.keyword = courseName;

      return {
        ok: true,
        raw,
        action: 'query',
        target: 'grade',
        filters,
        confidence: 0.9,
        explain: courseName ? `查询「${courseName}」的成绩` : '查询成绩',
      };
    }

    return miss;
  }
}
