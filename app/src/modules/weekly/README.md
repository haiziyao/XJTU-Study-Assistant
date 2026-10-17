# 学习周报（`weekly`）

一周结束时汇总：**聊了什么 / 写了哪些笔记 / 待办完成了什么 / 成绩有什么变动**，
并（可选地）用模型写成一段中文简报。

- 模块：`id: 'weekly'`、`order: 48`、集合 `weeklyReports` → `data/weekly-reports.json`（一周一条）。
- 依赖：**没有任何必需依赖**。统计只读各模块已落库的集合；`services.ai` 是惰性依赖
  （ai 的 order=90，只能请求时取），拿不到就降级成规则小结。
- 前端：**不占左栏入口**。周报面板挂在「待办」页里（`views/weekly-panel.js`）：
  待办页顶部有「学习周报」按钮，点开后在同一块内容区显示统计、缺失项、正文与历史；
  再点一次（或点面板里的「返回待办」）回到待办列表。

## 1. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/weekly/report?from=&to=` | 读某周。**有缓存给缓存**；没有则 `report: null` + `hint` + 现算 `stats`。**永不调用模型** |
| POST | `/weekly/report/generate` | 生成（body `{ from?, to?, force? }`）。唯一会花 token 的入口；同一周命中缓存 |
| GET | `/weekly/reports?limit=` | 历史周报列表（按周倒序，默认 20、上限 200） |
| DELETE | `/weekly/reports/:id` | 删除一条（未知 id → 404） |

区间规则：`from`/`to` 都是 **`YYYY-MM-DD`（本地日期）**。

- 都不给 → **本周**（自然周，周一 ~ 周日）；
- 只给一端 → **那一天所在的自然周**（"给我 1 月 7 号那一周"，不必自己算周一）；
- 两端都给 → 原样采用（允许自定义区间）；
- 非法日期（含 `2026-02-30` 这种不存在的日期）→ **400**；`to < from` → **400**。错误 `details.field` 指明是哪个字段。

### 响应要点

```jsonc
// GET /weekly/report（没有缓存时）
{ "ok": true, "from": "2026-10-12", "to": "2026-10-18", "week": "2026-W42", "days": 7,
  "cached": false, "report": null, "hint": "这一周还没有生成周报：POST /weekly/report/generate …",
  "stats": { /* 见第 3 节，永远现算 */ } }

// POST /weekly/report/generate（模型不可用 → 降级；ok 仍是 true）
{ "ok": true, "cached": false, "id": "…", "from": "…", "to": "…", "week": "2026-W42",
  "stats": {…}, "report": "2026-W42（… ~ …，共 7 天）小结：…",
  "generatedAt": "2026-10-13T02:00:00.000Z", "model": null, "fallback": true,
  "reason": "AI 尚未配置密钥", "reportTruncated": false }
```

- `cached: true` → 直接返回缓存，`generatedAt` 不变（**不重复花 token**）。
- `fallback: true` + `reason` → 正文是**规则小结**（不是错误状态）；`model` 为 `null`。
- `force: true` → 忽略缓存重写，同一条记录原地更新（保留 `id`，`generatedAt` 刷新）。
- `statsChangedSinceReport`（只在 GET 里）→ 正文生成之后这周的数据又变了。

## 2. 指令与 AI 工具

| 目标 | action | 语义 |
| --- | --- | --- |
| `weekly` | `query` | **只读**读周报（`filters: { id?, from?, to?, limit? }`）。没有报告时返回 `count: 0` + 现算统计，**不花钱** |
| `weekly` | `create` | 生成（`fields: { from?, to?, force? }`）。`dryRun` 只预览、**不调模型**；真正执行才花一次 |

工具（`GET /ai/capabilities` 聚合）：`weekly_report_get`（`mutates: false`）、
`weekly_report_generate`（`mutates: true`，描述里写明"会花 token / 同周命中缓存 / 失败会降级"）。

`aiQueryFields.weekly` = `id, from, to, week, report, generatedAt, model, fallback, reason`；
`aiQueryLimits.weekly` = `4`（一份正文 300~400 字，回灌再多会挤掉对话）。

## 3. `stats` 每个字段的数据来源（一个字段一个出处）

`stats` 恒有 `{ from, to, week, days, partial, missing, conversations, notes, schedule, grades }`，
**只有四个来源**。**时间一律用记录里的 ISO 时间戳与本地日界闭区间 `[from 00:00:00.000, to 23:59:59.999]` 比较。**

| stats 字段 | 集合 | 字段 |
| --- | --- | --- |
| `conversations.newConversations` | `aiConversations` | `createdAt` ∈ 区间 |
| `conversations.messages` / `userMessages` / `assistantMessages` | `aiMessages` | `createdAt` ∈ 区间，按 `role` 分 |
| `conversations.activeConversations` | `aiMessages` | 区间内出现过的不同 `conversationId` 数 |
| `conversations.titles` | `aiConversations` | 区间内新会话的 `title`（最多 3 条） |
| `notes.created` | `notes` | `createdAt` ∈ 区间 且 `deletedAt` 为空 |
| `notes.updated` / `updatedOnly` | `notes` | `updatedAt` ∈ 区间（`updatedOnly` 再排除区间内新建的） |
| `notes.deleted` | `notes` | `deletedAt` ∈ 区间 |
| `notes.titles` | `notes` | 上述笔记按 `updatedAt` 倒序的 `title`（最多 5 条） |
| `schedule.todosCreated` | `todos` | `createdAt` ∈ 区间 |
| `schedule.todosCompleted` | `todos` | `completed === true` 且 `completedAt` ∈ 区间 |
| `schedule.todosOpen` | `todos` | `completed !== true` |
| `schedule.todosOverdue` / `todosDueSoon` | `todos` | 未完成且 `deadline` < 今天 / ∈ [今天, 今天+7] |
| `schedule.attention` | `todos` | 上述条目的 `title` + `deadline`（最多 3 条，逾期优先） |
| `grades.changed` / `updated` / `synced` | `academicGrades` | `updatedAt` / `syncedAt` ∈ 区间 |
| `grades.gpa` / `includedCount` | `services.academic.stats()` | 现算学分绩（`gpa: null` = 没有可计算的成绩，**不是 0**） |

**"逾期 / 临近"按统计时刻的今天判断**，不是区间末尾：周报的用途是提醒"下一步做什么"，
一周结束时生成两者恰好重合，回看历史周时"现在仍逾期"才是需要行动的信息。

> 本次改版删除了间隔重复卡片与学习目标两个功能，它们的数据集合与统计项一并移除。
> `stats` 里不再有这两项，`missing` 里也不会再出现它们 —— 不是"取不到"，是系统不再统计。

### `missing`：取不到就说取不到

```jsonc
"missing": [{ "source": "conversations", "reason": "unavailable", "detail": "ai 模块未装配（…）" }]
```

- `unavailable`：这个来源整个不存在（模块没装配 / 没有对应集合）→ 该来源为 `null`；
- `partial`：来源在，但只有一部分字段能算（如 academic 服务不在 → 学分绩为 `null`，成绩记录数照给）；
- `read_failed`：集合存在但读失败（文件损坏等）→ 该来源为 `null`，错误原话进 `detail`。

**绝不把"没数据"写成 0**：0 与缺失对用户的含义完全不同。单个来源读失败不会让接口 500。

## 4. 报告生成与降级

1. `POST /weekly/report/generate` → 现算 `stats` → 同一周已有记录且 `force` 不为真 → **返回缓存**（结束，不花 token）。
2. 否则把 `stats` 压成中文键摘要（`buildDigest`）交给 `services.ai.complete({ system, user, temperature, thinking })`。
   提示词三条硬规则：**只依据给定数字**、**明说没有"学习时长"数据源**、**`null` 是"没有数据"不是 0**。
   输出格式：一句话总结 + `学习投入 / 笔记与成绩 / 需要注意的事` 三小节，≤400 字。
3. `services.ai` 拿不到、未配置密钥（501）、上游失败（502）、返回空内容 → **降级**：
   `report` = `fallbackReport(stats)`（纯规则、逐句对应一个字段，缺的小节写"暂无数据"），
   `fallback: true`、`reason` 记原话、`model: null`、**`ok` 仍是 `true`**。
4. 落库 `weeklyReports`：`{ id, from, to, week, stats, report, generatedAt, model, fallback, reason, reportTruncated }`，
   同一周原地更新（一周一条），并广播 `data_changed`（`target: 'weeklyReport'`）。

> 降级结果也进缓存：否则每次打开都会重试模型、白烧 token。要重写就带 `force: true`。

## 5. 界面：待办页里的子功能

- 待办页工具栏第二行有「**学习周报**」按钮；按钮带 `aria-pressed`，面板打开时按钮为选中态。
- 面板打开后**替换**待办列表那一块内容（不叠在列表上、也不把列表挤扁），顶部有「← 返回待办」。
- 面板里依次是：本周区间 +「生成本周周报 / 刷新」、客观统计表、`missing` 说明、正文（含降级标记）、历史周报；
  点历史条目会读取并展示那一周的现算统计与正文，可「重新生成（force）」或删除。
- 手机（≤900px）：统计行改为上下两行、按钮换行、正文与历史条目 `overflow-wrap: anywhere`，
  面板自身不产生横向滚动（`views/weekly.css`）。

## 6. 已知边界

- `GET /weekly/report` 每次现算 stats（内存扫描，几十~几千条量级），**不写库、不调模型**。
- 一周一条：`from` 是键（`to` 一起比对，避免自定义区间与自然周互相顶掉）；`force` 重写不新增记录。
- 只统计"今天"之前的数据也会算进去（区间是闭区间，未来的数据落在区间内同样计入 —— 例如
  提前写好的日程待办）；本模块不判断"是否已发生"。
- 统计不覆盖日程（`schedules`）与日历事件（`events`）：它们没有"完成"语义，硬算成"学习投入"
  会造出用户没做过的数字。待办已经能回答"这周做完了什么"。
