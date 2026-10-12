# aisearch —— 三源统一检索

> 一次查询，同时查**校规语料**（教务处 148 篇）+ **我的笔记** + **长期记忆**，合并排序、
> 跨源去重后统一返回，每条都带来源标注。

## 为什么单独一个模块

三路本来各自能查（`target: knowledge` / `note` / `memory`），但对话里的模型：
要么**漏一路**（只查校规就回答"转专业要什么条件"，完全没看用户自己记过什么），
要么**发三次查询**——而 `chat-service` 每轮最多自动执行 3 条只读查询、整个对话最多 5 轮，
三次查询就把额度烧光了，后面需要"再查一步"时已经没得查。

所以这个模块存在的唯一理由是**省额度 + 不漏路**：一条 `target: "search"` 查询草稿换三路结果。

## 依赖与装配顺序

| 依赖 | order | 用到的东西 |
| --- | --- | --- |
| `notes` | 40 | `notes.all()`（未删除的笔记） |
| `memory` | 45 | `memory.list({ status, limit })` |
| `knowledge` | 70 | `knowledge.search({ q, limit })` · `knowledge.stats()` |
| **本模块** | **85** | 必须在上面三个之后、`ai`(90) 之前 |
| `ai` | 90 | 聚合 `aiPrompt` / `aiQueryFields` / `aiQueryLimits` |

`order` 排小了**不会报错**，只会静默失效（某一路永远 `available: false`）——
这是本模块最容易踩的坑，所以写在这里。

只调上面三个**公开只读方法**，不碰任何集合、不 import 别人的内部文件。
不声明 `collections`：**纯检索，一个字节都不写**（不落库、不广播、不建私有文件）。

服务句柄是 **`services.aisearch`**（`services.aisearch.search({ q, … })`）：
`services` 是各模块 `Object.assign` 合并的，重名会静默顶掉别人，
而 `search` 是个很容易被别的模块占用的名字 —— 所以内部句柄带模块前缀；
**给模型看的指令 target 仍然是 `search`**。

## 接口

### `GET /api/v1/search`

| 参数 | 说明 |
| --- | --- |
| `q` | **必填**，关键词（空白也 400）。 |
| `scope` | `all`（缺省）/ `knowledge` / `note` / `memory`；**非法值 400**。 |
| `limit` | 合并去重后的总条数，缺省 10、上限 20；非整数或越界 400。 |
| `perSource` | 每路先取几条，缺省 `ceil(limit/3)`、上限 5。 |
| `course` | 只看某门课的笔记（`properties.course`）；记忆按"`global` + `course:<课程>`"两条 scope 算相关。 |
| `noteIds` | 逗号分隔，只在这些笔记 id 里找。 |
| `memoryStatus` | 记忆取哪些状态，缺省 `active`（`superseded`/`rejected` 的旧结论不进统一检索）。 |

返回（片段示例，完整示例见交付报告）：

```json
{
  "ok": true,
  "q": "转专业", "scope": "all", "limit": 10, "perSource": 4, "course": null,
  "count": 3,
  "items": [
    {
      "source": "note", "sources": ["note"], "id": "n-…", "noteId": "n-…",
      "title": "高数课上的转专业念头", "snippet": "…转专业申请在大二下学期开放…",
      "score": 0.7832,
      "meta": { "rawScore": 14.447, "tags": ["转专业"], "course": "高等数学", "merged": [] }
    },
    {
      "source": "knowledge", "sources": ["knowledge"], "id": "knowledge/dean/gzzd-jwgl/11-….md",
      "title": "西安交通大学本科生专业选择与转专业管理办法",
      "url": "https://dean.xjtu.edu.cn/info/1033/1140.htm",
      "path": "knowledge/dean/gzzd-jwgl/11-….md",
      "snippet": "…", "score": 0.6679,
      "meta": { "rawScore": 8.044, "category": "规章制度 / 教务管理", "kind": "document", "matches": ["转专业", "专业", "转专"] }
    }
  ],
  "sources": [
    { "source": "knowledge", "label": "校规语料", "queried": true, "available": true, "total": 148, "count": 2, "truncated": true, "tookMs": 14, "error": null },
    { "source": "note", "label": "你的笔记", "queried": true, "available": true, "total": 1, "count": 1, "truncated": false, "tookMs": 1, "error": null },
    { "source": "memory", "label": "长期记忆", "queried": true, "available": true, "total": 1, "count": 1, "truncated": false, "tookMs": 0, "error": null }
  ],
  "notes": [
    "三路命中 4 条（合并去重后）：校规语料 2 条 / 你的笔记 1 条 / 长期记忆 1 条。",
    "校规语料按每路 2 条截断（返回 2 条）：要看更多请提高 limit。"
  ],
  "tookMs": 14, "searchedAt": "2026-…"
}
```

**`notes` 是给人/模型看的说明**（不是"笔记"这个来源，容易看混，所以这里说清楚）：
空结果时必须能读懂"是没命中、还是某一路没查成"，例如
`三路都没命中「紫菜蛋花汤配方」：校规语料 148 条、你的笔记 2 条、长期记忆 1 条里都没有相关内容。`
某一路失败时另起一条：`校规语料这一路没查成：语料索引不是合法 JSON…。`

### `GET /api/v1/search/sources`

三路各自是否可用 / 多少条（界面显示规模、排查"哪一路坏了"）：

```json
{
  "ok": true, "count": 3,
  "items": [
    { "source": "knowledge", "label": "校规语料", "available": true, "total": 148, "error": null,
      "detail": { "categories": 18, "chars": 111720, "source": "dean.xjtu.edu.cn", "generatedAt": "…" } },
    { "source": "note", "label": "你的笔记", "available": true, "total": 2, "error": null },
    { "source": "memory", "label": "长期记忆", "available": true, "total": 1, "error": null }
  ],
  "notes": ["三路可检索：校规语料 148 条 / 你的笔记 2 条 / 长期记忆 1 条。"]
}
```

## 打分口径（跨源为什么能比）

两步，见 `scoring.js` 文件头：

1. **原始分用同一个公式族** —— `(标题命中×8 + 正文命中) / (1 + log(1 + 字数/1000))`，
   单词命中封顶 2 次（词频是"提及"，不是"相关"）。
   - 知识库那一侧**不重算**：直接采信 `knowledge.search()` 的 `score`（要求如此），
     它与本公式同形，所以三个 raw 同量纲；
   - 笔记：标题 = `title`，正文 = `body`；记忆：标题 = `key`，正文 = `text`；
   - 三档词权重（整串 4 / 切分词 2 / 中文二元组 1）**故意与知识库一致**，
     同一个 `q` 在三个源里切出同一批词、同一批权重，分数才有可比性。
2. **归一化到 `[0,1]`**：`score = raw / (raw + 4)`。单调、有界、不依赖"本次结果集里最大是多少"。
   语义：raw = 4 → 0.5（约一次整串正文命中），raw = 8（标题整串命中）→ 0.667。
   `meta.rawScore` 保留原始分，方便解释"为什么这条排前面"。

排序：`score` 降序 → 来源序（knowledge > note > memory，同分时权威来源优先）→ 标题 → id，
**完全确定**（同一查询两次结果逐字一致）。

## 去重口径

**跨源**按"归一化标题"（NFKC → 小写 → 去掉空白/标点/符号）判定为同一篇内容，合并成一条：
`sources: ['note','knowledge']`（`sources[0]` 恒等于 `source`，即分数最高那一路），
被并掉的那一路的身份记进 `meta.merged[]`；`noteId` / `url` 只要存在就都保留（合并去掉的是重复，
不是入口）。**同源**不去重——同名但同源的两条是不同条目，合并会凭空吞掉真数据。
记忆不参与合并：它是一句"关于用户本人的话"，不是某篇内容的副本。

## 降级行为

- 三路**并发**（`Promise.allSettled`）且每路自己 try/catch：**任何一路挂掉都不让整体失败**；
- 失败如实写进 `sources[].error`（形如 `ENOENT: …` / `语料索引不是合法 JSON…`）与 `notes[]`；
- 另两路照常返回，HTTP 仍然是 `200`；
- 只有**参数**不合法（缺 q / 未知 scope / limit 越界）才 `400`。

## AI 接线

- `aiPrompt`：写清何时用 `search`、何时仍该用单独的 target、以及**引用规则**
  （知识条目必须带 `url`；笔记要说"你的笔记"；记忆要说"你之前提过"；
  `summary.sources[].error` 非空 = 那一路没查成，不能当成"那一路里没有"）。
- `aiQueryFields.search = ['source','title','snippet','url','noteId','score']`，
  `aiQueryLimits.search = 12`。
- 只读指令：`{"ok":true,"action":"query","target":"search","filters":{"q":"…","scope":"all"}}`
  → `chat-service` 自动 `dryRun` 执行并回灌（**不需要用户确认**）。
  返回里的 `summary` 带三路状态（`#compactQueryResult` 会丢掉顶层 `sources`，所以走 `summary`）。
- `aiTools`：`search_unified` / `search_sources`，都是 `mutates: false`。

## 前端接线要点

- 列表项按 `source` 分组或打标签：`knowledge` → 显示"校规"徽章 + `url` 外链；
  `note` → 显示"我的笔记"徽章，点击用 `noteId` 打开笔记（`GET /notes/:id`）；
  `memory` → 显示"你之前提过"，可用 `meta.kind` / `meta.memoryScope` 补充说明。
- `meta.merged.length > 0` 时给一条"也在…里命中"的提示（`meta.merged[].source`）。
- `score` 可直接做排序/弱化显示；`meta.rawScore` 只用于排查。
- `notes[]` 建议原样展示（它是"这次到底发生了什么"的唯一权威说明）；
  `sources[]` 里 `available: false` 或 `error` 非空时给一个黄条，别让用户以为"搜不到 = 不存在"。
- 首屏不需要额外请求：`search` 返回里已经带了 `sources[]` 的三路规模。
