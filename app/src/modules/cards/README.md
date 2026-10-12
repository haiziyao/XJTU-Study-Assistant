# 复习卡片模块（`cards`）

把笔记变成卡片，按遗忘曲线安排"学过的东西回来找你"。
模块 `id: cards`、`order: 46`、集合 `cards → data/cards.json`。

- 不依赖任何第三方库；只读 `services.notes`（`get` / `list`）取笔记，**不写别人的数据**。
- 排期算法在 `scheduler.js`（纯函数，可单独测）；抽取规则在 `extract.js`（纯函数，不调模型）。

---

## 1. 数据模型（`data/cards.json` 的 items）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | UUID，由 JsonStore 生成 |
| `front` | string | 正面 / 问题，**≤500 字**（超过就是材料不是问题） |
| `back` | string | 答案，**≤2000 字**（答案要自足，但不能是一页纸） |
| `noteId` | string \| null | 来自哪条笔记。只校验格式，**不校验存在性**：笔记删了，复习记录还在 |
| `course` | string \| null | 课程分组（生成时取自笔记的 `properties.course`） |
| `tags` | string[] | ≤24 个、每个 ≤40 字，写入时去重 |
| `source` | `note` \| `manual` \| `ai` | 从哪来的（排查"这批卡是不是模型生成的"） |
| `due` | ISO string | 下次复习时刻。**由调度器算，接口不接受客户端写** |
| `intervalDays` | number | 当前间隔（天），0 = 当天还要再来一次 |
| `ease` | number | 易度因子，夹在 1.3 ~ 3.0 |
| `reps` | number | 连续答对次数（`again` 归零） |
| `lapses` | number | 遗忘次数（只增不减，判断"这张卡是否天生难"） |
| `lastReviewedAt` | ISO string \| null | 上次复习时刻 |
| `lastGrade` | `again`/`hard`/`good`/`easy` \| null | 上次评分 |
| `suspended` | boolean | 暂停：**不参与到期队列**，但保留在库与统计的"总数"里 |
| `createdAt` / `updatedAt` | ISO string | 由存储层维护 |

字段校验与读出归一化在 `model.js`（读出时缺字段会补默认值，读取路径零写入）。

## 2. 调度算法（SM-2 简化版）

`computeNext(card, grade, now)` 是**纯函数**（同输入恒等、不改入参、不读时钟）。

| 评分 | 间隔 | ease | reps | lapses |
| --- | --- | --- | --- | --- |
| `again` 忘了 | 0（`due = now + 10 分钟`） | −0.2 | 归零 | +1 |
| `hard` 吃力 | 当前 <1 天 → 1；否则 `max(间隔+1, round(间隔×1.2))` | 不变 | +1 | 不变 |
| `good` 记得 | 当前 <1 天 → 1；第二次成功 → 3；否则 `round(间隔×ease)` | 不变 | +1 | 不变 |
| `easy` 太简单 | 当前 <1 天 → 4；否则 `max(good 的结果+1, round(间隔×ease×1.3))` | +0.15 | +1 | 不变 |

- 所有间隔封顶 **365 天**；ease 夹在 **[1.3, 3.0]**。
- 到期时间按**日历加法**推进（保留复习时刻，不受夏令时影响）；`again` 用 10 分钟冷却，
  避免"刷新一下它又回来了"。
- `hard` 不调 ease、`good` 不调 ease：只有"真的忘了"才说明这张卡难。

## 3. REST（前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cards?due=1&course=&tag=&noteId=&suspended=&q=&limit=&offset=` | 列表；`counts` **不受筛选影响** |
| GET | `/cards/stats` | 总数 / `dueNow` / `dueToday` / 未来 7 天 `byDay` / `suspended` / `byCourse` |
| GET | `/cards/due?limit=` | 到期队列快捷方式，等价于 `?due=1`（给定时唤醒用） |
| POST | `/cards` | 手工加卡 → **201**；排期从零开始（`due = now`） |
| PATCH | `/cards/:id` | 改 `front` / `back` / `tags` / `course` / `suspended` |
| DELETE | `/cards/:id` | 删除（不可逆） |
| POST | `/cards/:id/review` | body `{ grade }` → `{ item, nextDue, previousDue, scheduled, explain }` |
| POST | `/cards/generate` | body `{ noteId }` 或 `{ query, limit }` → `{ created, skipped, ignored, notes, items }` |

`GET /cards` 返回：

```json
{
  "count": 12,
  "counts": { "total": 40, "due": 12, "suspended": 3, "todayReviewed": 5 },
  "items": [ /* Card */ ],
  "filters": { "due": true, "course": null, "tag": null, "noteId": null, "suspended": null, "q": null, "limit": 50, "offset": 0 }
}
```

- `count` = 筛选后的条数；`counts` = 整库统计（界面顶部）。
- `?due=1` 比 `now`（现在就能复习）；**`service.dueToday()`** 比"今天结束"（含 again 后排到今晚的卡）。
- `?due=0` 只看还没到期的；`?suspended=1` 只看已暂停。

错误：字段不合法 `400`（`error.details.field`）、卡片不存在 `404`、`limit/offset/due` 非法 `400`。

## 4. 从笔记生成（`POST /cards/generate`）

规则化抽取，**不调模型**；三条规则（回执里每条卡带 `rule`）：

| 规则 | 识别 |
| --- | --- |
| `heading` | `## 标题` + 紧随的**第一个内容块**（空行即止） |
| `colon` | 以 `：`/`:` 结尾的行 + 下一行（或紧随的列表） |
| `question` | 以 `？`/`?` 结尾的行 + 下一行（或紧随的列表） |
| `list` | 列表项 + 其子项；列表项内是「术语：解释」时按它拆 |

- **幂等**：按 `noteId + 正面`（全角折叠、空白折叠、小写）去重，重复生成返回 `created: 0, skipped: N`。
- 复选框行（`- [ ] …`）、裸列表项、纯符号内容不成卡；过长（正面 >500 / 答案 >2000）计入 `ignored`，**不静默截断**。
- `limit` = 最多扫几篇笔记（默认 5、上限 20）；单次最多建 200 张。

## 5. 对话指令（target `card`）

| action | 输入 | `dryRun` |
| --- | --- | --- |
| `query` | `filters`: `due` / `course` / `tag` / `noteId` / `suspended` / `q` / `limit` | 只读，返回 `{ filters, count, items, explain }` |
| `create` | `fields`: `front` / `back` / `course` / `tags` / `noteId` / `source` | 只校验并回 `validated` |
| `update` | 定位用 `filters.id` 或 `filters.q`；**新正面放 `fields.front`** | 回 `planned` |
| `delete` | 定位同上 | 回 `planned` |
| `review` | `fields`: `{ id, grade }`（**grade 必填**，缺了 400） | 回 `planned` |

定位规则：`id`，或正面文字唯一匹配；匹配 0 条 → `404`，多条 → `400`（附候选 id）。

中文解析器（`registerParser('card', …)`，parser 名 `card`）：

- `加一张卡片：正面？答案`、`加一张卡片：正面 | 答案`、`… #标签`（置信度 0.95）；
- `今天要复习哪些卡片` / `有哪些卡片到期` / `查看我的卡片` → 只读 query（置信度 0.93，
  高于日历兜底解析器的 0.9，否则会被它建成一条待办）。

## 6. AI 扩展点

- `aiTools`：`cards_query` / `cards_due`（只读，`mutates: false`）、
  `cards_create` / `cards_generate` / `cards_review`（`mutates: true`，要用户确认）。
- `aiQueryFields.card`：`id, front, back, due, intervalDays, ease, reps, lapses, suspended, lastGrade, course, tags, noteId`；
  `aiQueryLimits.card = 8`。
- `aiPrompt`：什么该做成卡片、什么时候查到期、**不许把"复习"说成"已完成"**
  （只有真的调用过 `review` 并拿到回执，才能说"这次复习记下了"）。

## 7. 给别的模块接线

```js
// 定时唤醒（ai 模块的调度 runner 或任务提示词）
const due = services.cards.dueToday({ limit: 5 });   // Card[]，按 due 升序、已排除暂停
if (due.length) { /* 提示词里带上 due.map(c => c.front) */ }
// 或让模型自己查：GET /cards/due?limit=5（返回 count = 今天到期的**全部**条数）
```

前端渲染层需要的字段：`front` / `back` / `due` / `intervalDays` / `ease` / `reps` / `lapses` /
`lastReviewedAt` / `lastGrade` / `suspended` / `course` / `tags` / `noteId` / `source`。
界面顶部统计用 `GET /cards` 的 `counts` 或 `GET /cards/stats`；复习按钮直接
`POST /cards/:id/review { grade }`，返回的 `nextDue` 就是"下次什么时候见"。

## 8. 测试

```bash
cd app
node --test test/cards.test.js          # 调度纯函数 + 抽取规则（13 例）
node --test test/cards-module.test.js   # 真起后端：REST / 指令 / 生成 / AI 扩展点（9 例）
npm test                                # 全量（含这两个文件）
```

测试**不访问外网**：全部请求打在 `createServer({ dataDir: 临时目录 })` 起在 `127.0.0.1:0` 的实例上；
时钟通过 `createServer({ cards: { now } })` 注入，排期用例不依赖真实时间。
