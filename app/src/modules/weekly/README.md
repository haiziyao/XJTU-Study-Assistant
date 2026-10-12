# 学习周报（`weekly`）

一周结束时自动汇总：**聊了什么 / 写了哪些笔记 / 复习了多少卡片 / 目标与待办有什么变化**，
并（可选地）用模型写成一段中文简报。

- 模块：`id: 'weekly'`、`order: 48`、集合 `weeklyReports` → `data/weekly-reports.json`（一周一条）。
- 依赖：**没有任何必需依赖**。统计只读各模块已落库的集合；`services.ai` 是惰性依赖
  （ai 的 order=90，只能请求时取），拿不到就降级成规则小结。
- 前端：本模块只有后端（页面在「复习」页里接，见 `docs/AI中枢-实施进度与契约.md`）。

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

`stats` 恒有 `{ from, to, week, days, partial, missing, conversations, notes, cards, goals, schedule, grades }`。
**时间一律用记录里的 ISO 时间戳与本地日界闭区间 `[from 00:00:00.000, to 23:59:59.999]` 比较。**

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
| `cards.due`（当前到期） | `services.cards.stats()` → `dueNow` | 语义由 cards 模块定义（未暂停且 `due <= now`）；服务不在时才读 `cards` 集合按 `due` 时间戳现算 |
| `cards.total` | 同上 → `total` | 卡片总数 |
| `cards.reviewedCards`（本周复习过的卡片数） | `cards` | `lastReviewedAt` ∈ 区间。**精确**口径，但它是"卡片数"不是"次数" |
| `cards.reviews`（区间复习次数） | `cardReviews`/`reviewLogs`… | 复习流水时间 ∈ 区间。**cards 现在没有流水** → `null` + `partial` |
| `cards.learned`（这周新学会） | 同上 | 每张卡**最早**一条流水落在区间内（= reps 从 0 变正）；没有流水 → `null` + `partial` |
| `goals.updated` | `goals` | `updatedAt` ∈ 区间（"本周有改动"，不等于进度前进） |
| `goals.progressChanges` | `goals` | `progressLog`/`history`/`updates` 条目时间 ∈ 区间；**goals 现在没有流水** → `null` + `partial` |
| `goals.completed` | `goals` | `completedAt`/`finishedAt`/`doneAt` ∈ 区间；goals 没有完成时间字段，回落"`status === 'done'` 且 `updatedAt` ∈ 区间"（近似，已记 `partial`） |
| `goals.overdue` / `dueSoon` | `goals` | `status === 'active'` 且 `targetDate` < 今天 / ∈ [今天, 今天+7]（与 `decorate().overdue`、`remindDays` 同口径） |
| `goals.active` / `total` | `goals` | `status === 'active'` / 全部（`status` ∈ active/done/archived） |
| `schedule.todosCreated` | `todos` | `createdAt` ∈ 区间 |
| `schedule.todosCompleted` | `todos` | `completed === true` 且 `completedAt` ∈ 区间 |
| `schedule.todosOverdue` / `todosDueSoon` | `todos` | 未完成且 `deadline` < 今天 / ∈ [今天, 今天+7] |
| `schedule.attention` | `todos` | 上述条目的 `title` + `deadline`（最多 3 条，逾期优先） |
| `grades.changed` / `updated` / `synced` | `academicGrades` | `updatedAt` / `syncedAt` ∈ 区间 |
| `grades.gpa` / `includedCount` | `services.academic.stats()` | 现算学分绩（`gpa: null` = 没有可计算的成绩，**不是 0**） |

> 卡片与目标的**当前状态**字段（`due`/`total`/`status`/`targetDate`）都按各自模块的定义读，
> 不自己发明第二套口径 —— 否则周报上的"到期 8 张"会和复习页上的数字对不上。

**"逾期 / 临近"按统计时刻的今天判断**，不是区间末尾：周报的用途是提醒"下一步做什么"，
一周结束时生成两者恰好重合，回看历史周时"现在仍逾期"才是需要行动的信息。

### `missing`：取不到就说取不到

```jsonc
"missing": [{ "source": "cards", "reason": "unavailable", "detail": "cards 模块未装配（…）" }]
```

- `unavailable`：这个来源整个不存在（模块没装配 / 没有对应集合 / 对方服务没有口径方法）→ 该来源为 `null`；
- `partial`：来源在，但只有一部分字段能算（如没有复习流水 → `reviews`/`learned` 为 `null`，`due` 照给）；
- `read_failed`：集合存在但读失败（文件损坏等）→ 该来源为 `null`，错误原话进 `detail`。

**绝不把"没数据"写成 0**：0 与缺失对用户的含义完全不同。单个来源读失败不会让接口 500。

## 4. 报告生成与降级

1. `POST /weekly/report/generate` → 现算 `stats` → 同一周已有记录且 `force` 不为真 → **返回缓存**（结束，不花 token）。
2. 否则把 `stats` 压成中文键摘要（`buildDigest`）交给 `services.ai.complete({ system, user, temperature, thinking })`。
   提示词三条硬规则：**只依据给定数字**、**明说没有"学习时长"数据源**、**`null` 是"没有数据"不是 0**。
   输出格式：一句话总结 + `学习投入 / 复习与笔记 / 需要注意的事` 三小节，≤400 字。
3. `services.ai` 拿不到、未配置密钥（501）、上游失败（502）、返回空内容 → **降级**：
   `report` = `fallbackReport(stats)`（纯规则、逐句对应一个字段，缺的小节写"暂无数据"），
   `fallback: true`、`reason` 记原话、`model: null`、**`ok` 仍是 `true`**。
4. 落库 `weeklyReports`：`{ id, from, to, week, stats, report, generatedAt, model, fallback, reason, reportTruncated }`，
   同一周原地更新（一周一条），并广播 `data_changed`（`target: 'weeklyReport'`）。

> 降级结果也进缓存：否则每次打开都会重试模型、白烧 token。要重写就带 `force: true`。

## 5. 与 cards / goals 的对接状态（父智能体需要知道的两点）

`cards`（order 46，集合 `cards`）与 `goals`（order 47，集合 `goals`）已经装配，
本模块 `order = 48` 排在它们之后，**没有改动它们的任何文件**，按下面的顺序自适应：

1. **服务口径优先**：`services.cards.stats()`（`dueNow` / `total`）与
   `services.goals.weeklyStats({from,to})` / `stats({from,to})`（若将来提供）。
   缺哪个字段就 `null` + `missing.partial`，不会拿 0 顶上。
2. **集合兜底**：直接读 `store.cards` / `store.goals` 现算。集合名候选表在 `sources.js` 顶部
   （`CARD_COLLECTIONS` / `REVIEW_COLLECTIONS` / `GOAL_COLLECTIONS`）；命名若变，**只改那三张表**。

**还差一块（需要 cards 侧决定，不是本模块能补的）**：`cards` 目前只保存每张卡的最后复习时间
（`lastReviewedAt`）与累计 `reps`，**没有复习流水**，因此"区间复习次数"和"这周新学会"无法还原
（一张卡这周复习了 3 次也只留下最后那一次）。本模块现在的处理是：

- 如实给 `reviews: null` / `learned: null` + `missing[].reason = 'partial'`（**不拿 0 或"卡片数"冒充**）；
- 同时给出可精确计算的 `reviewedCards`（`lastReviewedAt` 落在区间内的卡片数），
  报告与降级小结里写作「复习过 N 张卡片」，与"复习次数"分开表述。

只要 cards 之后落了复习流水（例如追加 `{ cardId, reviewedAt, reps, grade }` 的
`cardReviews` 集合），或提供 `services.cards.weeklyStats({from,to})`，
**本模块不改一行代码**就会用上更精确的口径。

## 6. 已知边界

- `GET /weekly/report` 每次现算 stats（内存扫描，几十~几千条量级），**不写库、不调模型**。
- 一周一条：`from` 是键（`to` 一起比对，避免自定义区间与自然周互相顶掉）；`force` 重写不新增记录。
- 只统计"今天"之前的数据也会算进去（区间是闭区间，未来的数据落在区间内同样计入 —— 例如
  提前写好的日程待办）；本模块不判断"是否已发生"。
