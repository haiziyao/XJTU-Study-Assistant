/**
 * 学业情况查询模块。
 *
 * 职责：从本科教务系统拉取成绩 → 落本地 → 算学分绩（每门课可单独选择是否纳入）→
 * 供界面展示、供 AI 读取并出学情分析。
 *
 * `order: 30` 是有意的：排在 `lms`(20) 之后、`ai`(90) 之前 ——
 * ai 模块要聚合本模块声明的 `aiPrompt` / `aiQueryFields`，所以必须排在它前面。
 */

import { defineModule } from '../../core/module/contract.js';
import { AcademicService } from './service.js';
import { AcademicParser } from './parser.js';
import { createAcademicCommands } from './commands.js';
import { registerAcademicRoutes } from './routes.js';

/**
 * 给对话模型看的领域说明。
 *
 * 两件事必须说清楚，否则模型一定会答错：
 * 1. 有 `grade` 这个 target 可以查，以及它的动作与筛选条件；
 * 2. **它和 `lms_grades` 不是一回事** —— 后者是思源学堂视角的「课程总分与各项得分」，
 *    本模块是教务系统的官方成绩单（含学分与绩点）。两者同时存在时模型很容易混用。
 */
const AI_PROMPT = `【学业成绩（教务系统）】
用户可以查询自己在**本科教务系统**里的官方成绩单。相关的 target 是 "grade"：
- 查成绩：{"action":"query","target":"grade","filters":{...}}
  可选 filters：term（学期代码，形如 "2025-2026-1"）、keyword（课程名关键词）、
  nature（"01"=必修，"02"=选修）、failedOnly（true 只看不及格）、
  included（true/false 只看已纳入/已排除的）
  query 是只读的，会直接返回结果，里面带 summary（gpa 学分绩、weightedAverage 加权平均分、
  totalCredits 参与计算的学分、earnedCredits 已获得学分），回答「我学分绩多少」直接用 summary。
- 纳入/排除某门课：{"action":"include"|"exclude","target":"grade","filters":{...}}
  这是**写操作**，必须先 dryRun 预览并让用户确认。

学情分析：接口 /academic/analysis（GET 读已存的、POST 生成一段新的）。
  用户问「分析一下我的学习情况」「我该怎么提升学分绩」时，可以直接读这段分析作为依据；
  但要注意它可能是**过期的**（返回里的 stale 为 true 就说明成绩或勾选已经变了），
  过期时应当以 grade 查询的实时数据为准，或提示用户重新生成。

三条口径，答问时要按它说，不要自己另立算法：
- **学分绩（GPA）**只统计**被纳入**的课程，按学分加权：Σ(学分×绩点)/Σ(学分)；
- 每门课的**绩点由教务直接给出**（字段 XFJD），不要自己按分数换算；
- 少数课程是**等级制**（优秀/良好这类），没有绩点也进不了学分绩，默认不纳入，
  在 needsAttention 里单独列出 —— 用户问起时要说明这一点，不要说成"缺数据"。

注意与思源学堂的 lms_grades 区分：那是学堂里每门课的总分与各项得分（平时分、作业分），
**不是**官方成绩单；学分、绩点、学分绩只由本模块的 grade 提供。`;

export default defineModule({
  id: 'academic',
  title: '学业',
  order: 30,

  collections: [
    {
      name: 'academicGrades',
      file: 'academic-grades.json',
      // externalId 是幂等键（教务的 WID），term 用于按学期筛选
      indexes: ['externalId', 'term'],
    },
  ],

  createServices({ store, broadcast, services, dataDir, options }) {
    const academic = new AcademicService({
      store,
      broadcast,
      services,
      config: options ?? {},
      dataDir,
    });

    // 登记对话能力：登记之后 /commands/parse|execute|run 就能操作 grade，
    // 框架无需认识"学业"这个概念。
    services.commands.registerParser('academic', new AcademicParser({ academic }));
    services.commands.registerHandler('grade', createAcademicCommands({ academic }));

    return { academic };
  },

  /** 启动时恢复上次会话；失败只降级为未登录，不阻断整个进程。 */
  async restore({ own }) {
    await own.academic.restore();
  },

  registerRoutes(router, { own, apiPrefix }) {
    registerAcademicRoutes(router, { academic: own.academic, apiPrefix });
  },

  /**
   * 暴露给 AI Agent 的工具清单。
   *
   * 全部标 `implemented: true` —— 与学堂模块那 6 条"契约先行"的预置项不同，
   * 这里的接口是真写完了的，标成 false 会让 Agent 以为不能用。
   */
  aiTools: [
    {
      name: 'academic_status',
      description: '学业模块状态：登录态、成绩条数、学分绩、上次同步时间、授权握手诊断',
      method: 'GET',
      path: '/academic/status',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: {},
      returns: {
        status: 'string',
        loggedIn: 'boolean',
        grades: 'object',
        gpa: 'number|null',
        weightedAverage: 'number|null',
        lastSyncAt: 'string|null',
        handshake: 'object',
      },
    },
    {
      name: 'academic_login',
      description: '用统一身份认证登录教务系统（可能需要短信验证码）',
      method: 'POST',
      path: '/academic/login',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: { username: 'string', password: 'string', captcha: 'string?' },
      returns: { status: 'string', mfa: 'object|null' },
    },
    {
      name: 'academic_grades',
      description: '列出已同步的成绩；支持 ?term= 与 ?included= 过滤',
      method: 'GET',
      path: '/academic/grades',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { term: 'string?', included: 'boolean?' },
      returns: { items: 'array', count: 'number' },
    },
    {
      name: 'academic_stats',
      description: '学分绩与加权平均分统计（可按学期）；含未纳入却算不出绩点的课程清单',
      method: 'GET',
      path: '/academic/stats',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { term: 'string?' },
      returns: {
        gpa: 'number|null',
        weightedAverage: 'number|null',
        totalCredits: 'number',
        earnedCredits: 'number',
        terms: 'array',
        needsAttention: 'array',
      },
    },
    {
      name: 'academic_terms',
      description: '有成绩的学期清单，用于渲染筛选项',
      method: 'GET',
      path: '/academic/terms',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { items: 'array', count: 'number' },
    },
    {
      name: 'academic_toggle_included',
      description: '设置某门成绩是否计入学分绩（写操作，需用户确认）',
      method: 'POST',
      path: '/academic/grades/{id}/included',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: { id: 'string', included: 'boolean' },
      returns: { grade: 'object', stats: 'object' },
    },
    {
      name: 'academic_toggle_bulk',
      description: '批量设置是否计入学分绩；可给 ids，也可给 term 或 only（all/failed/unmapped/stale）',
      method: 'POST',
      path: '/academic/grades/included/bulk',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: { ids: 'array?', term: 'string?', only: 'string?', included: 'boolean' },
      returns: { changed: 'number', stats: 'object' },
    },
    {
      name: 'academic_sync_preview',
      description: '预览同步教务成绩（只读，不写库）',
      method: 'POST',
      path: '/academic/sync/preview',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { counts: 'object', stats: 'object' },
    },
    {
      name: 'academic_sync_apply',
      description: '从教务系统同步成绩并落库（写操作，Agent 必须先预览并征得确认）',
      method: 'POST',
      path: '/academic/sync/apply',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: {},
      returns: { counts: 'object', stats: 'object' },
    },
    {
      name: 'academic_analysis',
      description: '读取已有的学情分析（含 stale 标记：成绩或勾选变了以后旧结论就不代表现状）',
      method: 'GET',
      path: '/academic/analysis',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { available: 'boolean', stale: 'boolean', text: 'string?', source: 'string?', basis: 'object?' },
    },
    {
      name: 'academic_analyze',
      description: '生成一段学情分析；未配置 AI 时退化为本地统计摘要（source 为 local）',
      method: 'POST',
      path: '/academic/analysis',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { force: 'boolean?' },
      returns: { ok: 'boolean', text: 'string', source: 'string', basis: 'object' },
    },
  ],

  aiPrompt: AI_PROMPT,

  /** 只读查询结果回灌给模型时保留这些字段（覆盖 ai 模块内置的投影表）。 */
  aiQueryFields: {
    grade: ['id', 'courseName', 'credit', 'score', 'gradePoint', 'term', 'natureLabel', 'included'],
  },
});
