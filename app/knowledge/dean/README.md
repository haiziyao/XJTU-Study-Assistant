# 教务处政策语料（`knowledge/dean/`）

从**西安交通大学教务处官网** <https://dean.xjtu.edu.cn/> 抓下来的公开政策 / 规章 / 办事依据文本，
给 AI 当**可引用的知识**用（转专业条件、考试纪律、学籍处理、毕业学位要求这类问题，
模型靠"记忆"是编不出来的，必须有原文）。

> 这不是"用户记忆"。接口文档 §10 的 `memories` 集合存的是**关于你本人的事实**
> （「我习惯晚上学习」，≤ 200 字、会直接进提示词、有注入预算）；这里是**外部知识**，
> 体量在十万字量级，**不能整篇塞提示词**，只能按需检索后引用片段。两者别混。

## 目录结构

```
knowledge/dean/
├── README.md            # 本文件（人手维护）
├── index.json           # 全量索引（由 scripts/crawl-dean.js 生成，别手改）
├── xssw-xjgl/           # 学生事务 / 学籍管理
│   ├── 01-<标题>.md
│   └── …
├── gzzd-jwgl/           # 规章制度 / 教务管理
└── …
```

栏目 slug 与官网路径一一对应（`<大类>-<栏目>`），清单见 `index.json` 的 `categories`，
也见 `scripts/crawl-dean.js` 顶部的 `CATEGORIES` 常量（**唯一真源**）。

## 每篇的格式

```markdown
---
title: "西安交通大学本科生转专业实施细则"
url: "https://dean.xjtu.edu.cn/info/1033/8963.htm"
category: "规章制度 / 教务管理"
categorySlug: "gzzd-jwgl"
publishedAt: "2025-04-14"     # 页面上找不到就是 null（**不编**）
fetchedAt: "2026-10-12T11:30:00+08:00"
source: dean.xjtu.edu.cn
kind: document                # document | portal | attachments | external-links
---

# 西安交通大学本科生转专业实施细则

正文（Markdown：段落 / 列表 / 表格 / 附件链接）
```

- **`url` 必须保留**：回答说"按学校规定…"时要把出处给出来，用户得能点回去核对；
- `publishedAt` 来自页面的「发布时间」，抓不到就 `null`；
- 附件（PDF/Excel）只记名字与链接，**不下载正文**——那些要么是表格模板，要么体量大且常更新；
  正文薄到只剩"具体见附件"时会标 `kind: attachments`（检索时就知道这篇的政策全文在附件里）；
- `kind` 的四种取值：`document`（正常文章）/ `portal`（入口页，正文就在本页但常是图片或表格，如校历、作息时间）/
  `attachments`（正文在附件里）/ `external-links`（`00-站外入口.md`：本栏目有若干条目挂在站外系统，
  按"只收 dean.xjtu.edu.cn"的约定不抓正文，但如实记下来）。

## 怎么更新

```bash
cd app
node scripts/crawl-dean.js                 # 全量重抓并重建索引（串行 + 400ms 间隔）
node scripts/crawl-dean.js --only=gzzd-jwgl,xssw-xjgl   # 只刷某几个栏目
node scripts/crawl-dean.js --index-only    # 不联网，只按现有文件重建索引
node scripts/crawl-dean.js --check         # 校验索引与文件是否一致（CI/自检）
npm test                                   # test/knowledge.test.js 会做同样的校验
```

- **内容没变就不动文件**（连 `fetchedAt` 一起保留），所以重抓一次不会刷出一堆无意义的 diff；
- 政策下架后，重抓会把它从对应目录里删掉，索引同步更新；
- **不要手改正文**：改了 `--check` 与测试会红。要改就走抓取器（或者改完跑 `--index-only` 重算哈希）。

## 给 AI / 记忆功能的使用约定

1. **只按需检索，不整篇注入**：`index.json` 里每篇带 `title / category / publishedAt / chars / sha256`，
   按关键词（标题 + 正文）与栏目筛出候选，只把**命中的段落**（几百字）与 `url` 一起给模型；
2. **回答必须带出处**：政策会修订，`publishedAt` 早的条款可能已经变了 ——
   交给用户的每句话都要能追到某一篇 + 那个 URL；
3. **区分"政策原文"与"模型推断"**：模型只能引用语料里有的字；语料里没有的（比如"今年保研名额"）要如实说不知道；
4. **时效性内容不要进语料**：教学通知 / 教学动态这类几天就过期的页面**故意没抓**
   （`test/knowledge.test.js` 里有断言防止有人手滑加进来）；
5. 检索方式按接口文档 §10 的口径：**关键词 + 栏目**，本版**不做**向量检索（本地零依赖，且这个量级够用）。

## 来源与边界

- 全部内容来自教务处官网的公开页面，仅作**个人学习工具**的本地知识库使用；转载请以官网为准；
- 抓取是**串行 + 节流**的（每次请求间隔 400ms、明确的 User-Agent、失败退避重试一次），
  不是爬虫，也不需要登录 —— 只用公开页面；
- 语料里没有个人信息、没有需要登录才能看的内容；如果某篇抓下来的正文明显是空壳（例如整页只有一张图），
  那是官网本身如此，`chars` 会很短，检索时自然权重低。
