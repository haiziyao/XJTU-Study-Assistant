# Changelog

本文件记录 AI 智学程序后端的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 重构：框架与功能模块分离

> 目标：**新增一个功能 = 新建一个目录 + 新建一个文件**，不需要修改框架代码，也不会和别人的改动冲突。
> 目录 `calendar/` 更名为 `app/`，其内容从「一个日历模块」升级为「应用框架 + 可插拔模块」。
> 新增 [模块开发指南.md](docs/模块开发指南.md)。

### 结构（破坏性变更：所有路径都变了）

- `calendar/` → `app/`；`src/server/{http,store,ai}` → `src/core/{http,store,ai}`
- 业务代码从「按层横切」改为「按功能纵切」：
  - `src/modules/calendar/` —— 日历与待办（event/schedule/reminder/recurrence/ics/compat/parser/schema/commands/routes）
  - `src/modules/lms/` —— 思源学堂（原 `src/server/lms/*` 与 `src/server/routes/lms.js`）
  - `src/core/` —— 框架：HTTP/WS/静态服务、JSON 存储、指令系统、模块契约、通用校验、框架路由
  - `src/server/index.js` —— 只剩装配，且**不再 import 任何具体模块**
- 前端 `src/renderer/` 拆分为 `shell/`（外壳与自带视图）、`kit/`（公共积木与注册表）、`views/`（一人一个）
- 文档移入 `docs/`；`styles.css`(1951 行)、`views.js`(2532 行) 拆散

### 新增（框架能力）

- **模块契约** `core/module/contract.js` + **目录扫描注册表** `core/module/registry.js`：
  扫描 `src/modules/<id>/module.js`，按 `order` 装配；新增模块零公共改动。
  钩子：`collections` / `createServices` / `restore` / `registerRoutes` / `start` / `stop` / `aiTools`。
- **声明式数据集合**：模块在 `collections` 里声明，`JsonStore` 自动创建，不再硬编码集合清单。
- **指令系统通用化**：`CommandService` 改为「解析器 + 处理器」双注册表
  （`registerParser` / `registerHandler`），框架不再有 `switch(action)`，也不认识 `event/schedule`；
  新增 `tryParse()` 作为不抛异常的解析入口，供 AI 降级路径使用。
- **静态文件按目录前缀托管**（`core/http/static.js`）：带越界防护与 MIME 白名单，
  新增前端文件不再需要改路由代码；顺带支持图片/字体等二进制资源。
- **前端视图注册表** `kit/registry.js`（`PCModules`）：视图自我登记导航项、排序、插槽与渲染函数；
  外壳不再持有 `NAV` / `views{}` 硬编码表。同名 id 后注册者覆盖，占位页与真实实现可共存。
- 新增 `GET /api/v1/modules`（模块自描述）；`/health` 的 `counts` 改为按模块声明的集合自动汇总；
  `/ai/capabilities` 的 `lmsTools` 改为通用的 **`aiTools`**（各模块声明后聚合，每项带 `module`）。

### 新增（前端测试）

- `test/renderer.test.js`（4 个用例）：资源可达性与 MIME、无浏览器环境下全部脚本求值
  （捕获语法/顶层引用错误，避免整页白屏）、视图注册表顺序与插槽、静态资源越界防护。

### 修复 / 加固

- 模块 `restore()` 抛错不再炸掉整个后端启动，改为记录错误后降级继续。
- `core/http/router.js` 支持 `*` 通配段（静态资源需要覆盖任意深度路径）。
- 拆分 `validate.js` 为 `core/validate.js`（通用）与 `modules/calendar/schema.js`（日期/重复/提醒/复杂度），
  消除「框架依赖模块」的反向依赖。

### 兼容性

- **HTTP 接口路径与响应结构全部保持不变**，前端与既有调用方无需改动，除以下两点：
  - `GET /ai/capabilities` 的 `lmsTools` 更名为 `aiTools`（结构不变，每项多一个 `module` 字段）；
  - `GET /health` 的 `counts` 现在包含**全部**集合（含 `lmsCourses` / `lmsActivities`）。
- `createServer({ dataDir, [模块id]: 配置 })` 的注入方式不变（如 `{ lms: { config } }`）。
- 测试从 49 个增至 **53 个**，全部通过。

## [Unreleased]

### 新增（知识库功能：把教务处政策接进对话）

- **新模块 `modules/knowledge/`**（只读）：语料概况、关键词检索、读原文、一致性自检，
  外加对话里的只读目标 `target: "knowledge"` 与两条 aiTools（`knowledge_search` / `knowledge_doc`）。
  设计契约见 [接口文档 §15](docs/接口文档.md)。
- **回答必须带出处**：检索结果每条都带 `url`，提示词把三条硬规则写死 ——
  引用校规必须给链接、语料里没有的（如"今年保研名额"）如实说不知道、**绝不许用模型自己的记忆编校规**
  （照错的校规办事比答不出来危险得多）。
- **只给片段，不整篇进提示词**：命中位置前后各 120 字（默认 240），全文只能走 `/knowledge/doc`；
  打分 `(标题命中×8 + 正文命中) / (1 + log(1 + 字数/1000)) × 正文为空惩罚`，
  中文不引分词库（整串 + 切分 + 二元组，重叠计数）。
- **图片/附件型篇目如实处理**：语料里 56/148 篇清洗后没有可见正文（流程图 PNG、校历图、附件 PDF），
  它们**仍能被标题搜到**（问"校历"能找到那一篇），片段里的说明是"正文在图片或附件里，请点链接看原文"，
  不会返回空串让模型误判成"没搜到"。
- **设置 → 知识库**：语料概况（来源 / 生成时间 / 栏目表）、「重新读取索引」「自检」。
  **没有"从网上下载"的按钮**：抓教务处必须由用户显式跑 `node scripts/crawl-dean.js`（服务端不替用户联网）。
- **对话里的查询卡认 `knowledge`**：卡头「查看校规」，每行给标题 +「栏目 · 日期」+ 来源 URL（纯文本，可复制）
  + 片段；按钮是「去设置里看知识库」而不是跳日历（知识库没有对应的右侧视图）。
- **抓取器变成真正幂等**（顺手修掉两个真 bug）：写文件前先 `rm` 整个目录的旧 `.md`，导致
  `writeDoc` 永远看到"文件不存在"、每次重抓都把 148 篇全写一遍（`fetchedAt` 全变）——
  README 里"内容没变就不动文件"的承诺从来没生效过；现在改成**先写、再按本次实际写到的文件清下架的**，
  并且内容与上次完全一致时连 `index.json` 的 `generatedAt` 都沿用。实测：重抓一次 **git 零 diff**。
- 测试 +39：检索纯函数 30 条（含打分公式与片段窗口）、模块集成 9 条（HTTP、对话目标、语料缺失降级、路径越界 400）。

### 新增（教务处政策语料 `knowledge/dean/`）

- **从教务处官网抓下 18 个栏目 / 148 篇 / 约 11.5 万字**公开政策文本（学生事务、规章制度、教学业务 +
  校历 / 作息时间 / Q&A / 培养方案），**进仓库**（`app/knowledge/dean/`），协作者拉下来就有。
  为什么需要它：转专业条件、考试纪律、学籍处理、毕业学位要求这类问题**必须引原文**，
  模型靠"记忆"只会编。
- **可复现的抓取器** `scripts/crawl-dean.js`（零依赖）：`node scripts/crawl-dean.js` 重抓并重建
  `index.json`；`--only=<slug>` 单栏重刷、`--index-only` 离线重建、`--check` 校验索引与文件一致、
  `--url=<页面>` 打印单页转换结果。串行 + 400ms 间隔 + 明确 UA + 失败退避，失败如实记 `error` 不编内容。
- **抓取器踩过的坑（都已修，写在这里免得下次重踩）**：
  - `<(em|i)[^>]*>` 会把 `<img>` 当斜体吃掉（`<(strong|b)[^>]*>` 同理吃 `<body>`）——
    校历整页曾经抓成一个 `*`；
  - 分页**不能按序号猜**：`gzzd/jwgl` 的「尾页」是 `jwgl/1.htm`、「下页」是 `jwgl/2.htm`，
    必须跟随页面上的分页链接（CDN 偶尔还会对分页请求回第 1 页内容 → 加时间戳穿透一次）；
  - 表格必须处理 `rowspan/colspan`：作息时间表首列是 `rowspan=21` 的竖排表名，不展开会整体错位一列；
  - 附件**不在**正文容器里（挂在 `div_vote_id` 之后），只抓容器会丢掉整份政策；
  - 只收 `dean.xjtu.edu.cn`：Q&A 栏目有一半条目在 `syxt.xjtu.edu.cn`，混进来就变成"抓了外站当政策"；
  - 索引与文件的 `chars/sha256` 必须**同一口径**（正文含不含那行 H1 差一个字符，148 篇会全部"对不上"）。
- **`test/knowledge.test.js`**：语料结构、索引与文件一致、每篇都有来源 URL、以及
  "没把通知/动态这类时效性栏目误抓进来"四条断言，防止有人手改语料或改坏抓取器。
- 有意**不抓**教学通知 / 教学动态（几天就过期，进了语料只会让模型答出过时结论）。

### 变更（AI 对话：真正的多轮工具循环 + 自动审批 + 成绩单 + 输入区图标）

- **对话不再"调用完工具就结束"**：`send()` 从"固定回灌一次"改成**最多 5 轮**的循环
  （`MAX_ROUNDS`）—— 每一轮都能发查询草稿，执行后回灌继续问，直到模型不再查新东西或到上限。
  以前只回灌一次，模型"先查一次、再写一条"的两步动作永远走不完。
  - 回灌那几轮**也流式**（以前是静默几秒，看着像断了）；新一轮的第一块 delta 带 `reset: true`，
    前端清空上一轮那句"我查一下…"，最终只留答案。
  - 完整重复的查询自动去重；到上限还没查完会标 `roundLimit` 并留一句说明，不会断在半截。
  - 第 2 轮及以后失败只标 `PARTIAL`（数据照给），第 1 轮失败才整条 `failed`。
  - `usageRounds` 记录逐轮 usage，`/ai/usage` 把它们都算进 `calls` 与 token 汇总。
- **「自动审批」真的自动了**：以前写草稿只在**第一轮**（回灌之前）被自动执行，
  于是"先查冲突再写"的写草稿永远落在回灌后那轮、永远变成确认卡（用户原话"自动审批没啥用"）。
  现在**每一轮**的写草稿都会在 `auto` 档直接落库并出「已自动执行」回执卡。
- **档位与联网开关写进提示词**：`permission` 三档各有自己的口径（`auto` 可以直说"加好了"但不许编造细节、
  `strict` 必须说"点确认后我才能看到数据"），新增 `search`（不联网 / 校外网 / 校内网）——
  检索通道还没接入，提示词要求模型**如实说明**、绝不编造搜索结果。
- **成绩单能在对话里调取**：提示词原来写死"target 只能取 todo/schedule/event"，
  与 academic 声明的 `grade` 自相矛盾（模型可能根本不敢查）。现在改成认各模块声明的 target，
  并补了 grade 示例与"按学期分组简表 + 基于真实数据的点评、不编排名/保研线"的规则；
  新增 `aiQueryLimits` 扩展点（`grade: 300`，默认 20 条会把 44 门课腰斩）；
  查询卡按课程名 / 学分 / 成绩 / 绩点 / 学期渲染（以前每行只有一个 uuid），
  「在右侧查看」跳**学业**视图；`parser.js` 也不再让"我的成绩单"退化成"新增待办"。
- **输入框下面那一行重排**：左边新增**联网搜索**（地球图标，向上弹：不联网 / 从校外网搜索 / 从校内网搜索）
  与思考模式，右边三个小图标 —— **权限**（盾牌）、**用量**（柱子）、**绘图**（画笔，蓝=开、灰=关）；
  图标颜色即状态，权限与联网的选择记在 `localStorage`（以前权限只活在内存，刷新就回「手动审批」），
  底部提示语跟着档位变。绘图开关以前只在设置页，现在随手可切（设置页保留并加了指引）。

### 变更（输入区：去掉小字、加高输入框、图标放大去边框、下拉去掉 ✓）

- **删掉输入框下面那行小字**（`Enter 发送 · Shift + Enter 换行 · 由 xx 驱动…`）：
  `paintHint()` 整个函数一起删了，Enter/Shift+Enter 的说明挪到输入框的 `title`（悬停可见）。
- **输入框加高**：`min-height: 58px`（原来是单行细缝），自动增高上限抬到 180px。
- **图标放大、去掉外边框**：输入区右侧（权限 / 用量 / 绘图）与左侧（联网）的小图标从 26×22 的
  描边胶囊改成 32×30、无边框无底色的纯图标，图标本体 14px → 19px；**颜色就是状态**（灰=关、蓝=开），
  悬浮/开启时只给一层很淡的底色。
- **下拉菜单删掉 ✓**：选中项以前同时用「行首 ✓ + 蓝字」标出，而 ✓ 那一行"有字"、别的行"没字"，
  行高被撑出细微差别，看起来就是**勾和高光错位**。现在**只留整行淡蓝底 + 蓝字**，
  并且给每行固定 `min-height: 30px`，行高彻底一致；模型选择器菜单同样处理。
  实机验证：三个下拉各点一遍，落库的 `thinking / permission / search` 确实是新值
  （`low` / `strict` / `web`），不是"看起来切了、其实没切"。
- **点「绘图」不再让右边栏闪一下**：`POST /ai/config` 会广播 `data_changed`，而外壳以前对任何
  `data_changed` 都 `refresh()` 一次（右侧视图整体重建）。现在 `module==='ai' && payload.target==='ai_config'`
  只刷徽标与模型列表，不重建右侧视图。

### 变更（学业 / 思源学堂：按学期全选、课程页顺序、刷新不再跳顶部）

- **学业成绩明细**：每个学期行右侧新增**三态勾选框**「整学期计入」——
  全计入 / 混合（`indeterminate`）/ 全屏蔽一眼可辨，点一下就是整学期全计入、再点一下整学期屏蔽。
  44 门课一门一门点的时代结束了。提交走 `ids`（不是 `term`），所以「未标注学期」那一组也能整组操作。
- **思源学堂课程页**的分节顺序改成 **课程信息 → 作业 → 课程回放 → 资料 / 直播 / 其它**：
  进课程页第一件事是看有什么要交的，回放排第二。
- **刷新不再跳回页面顶部**：这两个视图的 `paint()` 都是 `mount.innerHTML = ''` 整体重建，
  而真正滚动的是里面的 `.view-content`，DOM 一换 `scrollTop` 就归零 —— 勾一门课、拉一次数据、
  收到一次 `data_changed` 广播都会弹回顶部。现在外壳提供 `PC.snapshotScroll()` / `PC.keepScroll(fn)`
  （按选择器记账，重建后把位置还给新节点），两个视图的重画都包了一层；
  `renderPanel()` 默认保位置，**切换视图**时才回到顶部。

### 变更（思源学堂首页：撤掉登录信息栏）

- 首页不再展示登录信息：**顶部的「账号与同步」工具条**与**「账号状态」卡**（已登录徽标 / 账号 / 上次同步 /
  已同步条数 / 本地缓存 / 缓存时间 / 服务地址 / 退出登录）整体删除。登录与退出统一在「设置 → 统一身份认证」，
  那里退出本来就是**全局退出**（单点登录下 TGT 还在，只退一个站点下次会被静默重新认证），这里不再重复一份。
- 未登录时不再有密码表单（与 `auth` 的设计对齐）：只给一张引导卡，点「去设置里登录」跳设置页；
  两步验证与图形验证码同样在设置里完成，视图里不再有 `field()` 表单、验证码 `<img>` 与 MFA 卡。
- 「自动同步」留成首页第一张小卡（开关 + 间隔 + 最近一次自动同步时间），下面就是「课程」。
- 登录态快照加 `STATUS_TTL_MS = 1000`：在设置页登录 / 退出后切回学堂页会重新取状态
  （此前只在"从没取过"时取一次，会停在旧登录态上显示「未登录」）；登录态翻转时顺带丢掉课程 / 活动缓存。
- 界面在切换登录态时不再停在课程页（没有登录态就没有"这一门课"可看）。

### 新增（思源学堂接入：课程 / 作业 / 直播 → 日历）

- **统一身份认证登录**（`src/server/lms/cas-auth.js`）：零依赖实现 `login.xjtu.edu.cn` 的登录状态机 ——
  拉取登录页 `execution`、用 `/cas/jwt/publicKey` 的 RSA 公钥加密密码（`__RSA__` + PKCS1v1.5）、
  `mfa/detect` 探测两步验证、安全手机验证码（`initByType` → `send` → `valid`）、
  二次认证（Safety Verify）、连续失败 3 次后的图形验证码；登录失败页（`el-alert`）与「还停在登录页」都能识别。
- **HTTP 客户端**（`src/server/lms/http-client.js`）：自带 Cookie 罐 + 手动跟踪重定向。
  Node 的 `fetch` 没有 Cookie 罐，自动重定向会丢掉 CAS 每次跳转种下的会话票（表现为「密码对了但回到登录页」）。
- **思源学堂接口封装**（`src/server/lms/api.js`）：用户信息（从 `/user/index` 的 `globalData` 里解析）、
  我的课程、课程活动、活动详情、作业提交记录；字段统一归一化为 camelCase，学校改字段只需改这一个文件。
- **同步映射**（`src/server/lms/sync.js`，纯函数）：作业 → 待办/时段日程（截止日为准、分类 study、按剩余天数给优先级）、
  直播 → 时段日程（分类 class）、回放/资料默认不导入、课程可选整学期做成日历事件；
  每条记录带 `externalId = lms:activity:<活动 ID>`，重复同步只更新不新增，**不会覆盖用户手改的状态与提醒**；
  思源学堂查不到的活动会以 `stale` 报出，可选择清理。
- **REST 接口** `/api/v1/lms/*`（`src/server/routes/lms.js`）：status / login / mfa / captcha / logout /
  courses / activities / activities/:id / sync/preview / sync/apply。写操作一律「先预览后应用」，未登录返回 `401 UNAUTHORIZED`。
- **本地缓存**：新增 `data/lms-courses.json`、`data/lms-activities.json` 两个集合；未登录时仍可读缓存（响应带 `loggedIn: false`）。
- **会话持久化**：`data/lms-session.json`（权限 `0600`，7 天失效），**不保存密码**；进程重启免登录。
- **AI 工具契约**：`src/server/lms/tools.js` 定义 7 个工具（name / method / path / params / requiresAuth / mutates），
  通过 `GET /ai/capabilities` 的 `lmsTools` 暴露，未来接入模型时直接注册成 function-calling 工具。
- **自动同步（可选）**：`POST /lms/settings { autoSync, autoSyncIntervalHours }` 打开后，服务每 30 分钟检查一次，
  到间隔就按默认规则执行同步（只新建/更新，**不删除**任何记录），结果写入 `data/lms-meta.json`；默认关闭。
- **真机数据适配**（用真实账号拉 54 门课 / 单课 24 条活动后修正）：
  学期字段只有 `code`（如 `2026-1`），`name` / `real_name` 都是 null，现在补一个可读 `label`
  （`2026-2027 学年 · 第 1 学期`），界面不会再显示空的「学期：」；
  直播标题形如 `2026-09-14-材料力学`（去掉日期前缀、课程名不重复加前缀），
  回放标题形如 `材料力学 教2楼-西203 2026-09-14 08:00:00-08:50:00`（把教室提取为日程 `location`）。
- **自检脚本** `scripts/lms-probe.js`：不需要账号密码，打印真实跳转链（lms → identity1 → CAS）、
  `execution` / `mfaEnabled` 解析结果、RSA 公钥与加密结果、验证码接口可用性，用于区分「环境问题」与「账号问题」。
- **测试**：`test/helpers/lms-mock.js` 复刻 CAS + 思源学堂（含 RSA 加密校验、Cookie、两步验证、失败提示、验证码图片），
  `test/lms.test.js` 覆盖登录、验证码、MFA、二次认证、课程/活动缓存、映射规则、幂等、改期更新、失效清理、只同步选中项、会话持久化与失效 —— 共 14 项，用例总数 30 → 44。
- 日程新增 `externalId` 字段（幂等同步用）；`ERROR_CODES` 新增 `UNAUTHORIZED` / `UPSTREAM_ERROR`；`HttpError` 新增 `unauthorized()` / `upstream()`。
- 文档：[接口文档.md](接口文档.md) 新增第 9 节「思源学堂接入（LMS）」（含登录流程、接口清单、映射表、同步动作表、安全说明）；README 新增「思源学堂接入（LMS）」一节。

### 新增（测试窗口重做为三栏界面）

- **三栏布局**：左栏功能栏（约 10% 宽，日历 / 待办 / 学情 / 拍题 / 网课 / 消息 + 底部设置）、中间对话面板、右侧功能视图；
  右侧可收起（`⟩`），收起后中间变宽且周视图置灰（宽度不足）。
- **日历视图**（`src/renderer/views.js`）：月视图、周视图（仅右栏展开时可用）、日视图；月视图支持分类色条与悬停快捷新建，
  周视图为 24 小时时间轴并对重叠日程自动分列、点空白按 30 分钟吸附新建，日视图可逐条完成 / 取消 / 编辑 / 删除。
- **待办视图**：全部 / 今天 / 本周 / 逾期 / 已完成筛选、顶部快速添加（不填时间即全天待办）、按日期分组并标注逾期天数、
  底部本周完成率进度条，以及「顺延未完成到本周」。
- **新建 / 编辑弹层**：日程与日历事件两个页签；重复规则支持类型 / 间隔 / 星期集合 / 结束条件（日期、次数），
  另有提醒档位、优先级、预估时长、地点、备注。
- **对话即指令入口**：自然语言 → 干跑预览 → **草稿确认卡**（展示字段、条件、置信度、警告）→ 点「确认执行」才落库，可取消；
  查询类指令直接在对话里列出结果并可跳转到右侧对应日期。AI 未接入时由本地规则解析（`fallback: rules`）。
- **演示数据脚本** `scripts/seed-demo.js`：写入 16 条相对今天的演示记录（带 `tags: ["demo"]`），`--clear` 只删演示数据。
- 新增 `GET /app/views.js` 静态白名单；README 增补「测试窗口界面」一节。

### 修复

- **真实账号登录卡在两步验证**（已用真机抓包定位并实测修复）：`POST /cas/mfa/detect` 只接受
  `application/x-www-form-urlencoded`，之前按 JSON 发送，学校返回
  `400 Required String parameter 'username' is not present`，界面表现为
  「两步验证探测返回了无法解析的内容」。同一轮实测还确认了 `/attest/api/guard/securephone/{send,valid}`
  **只能**用 JSON（传表单会 415），两种编码现在都按真机行为固定下来，并由 mock 强制校验（防回归）。
- 学校 `/cas/login` 成功后的跳转链会经过 `identity1.xjtu.edu.cn` 代理，跳转上限从 8 提到 20，
  避免长链路被误判为失败。
- `scripts/run-electron-macos.sh` 在并发/目录被清理时写 `data-dir.txt` 会因父目录不存在中断，已先 `mkdir -p`。

- **界面只渲染骨架、无导航 / 无对话 / 无视图**：`app.js` 中 `dom` 声明为 `const` 却在 `boot()` 内重新赋值，
  抛出 `TypeError: Assignment to constant variable` 且被启动期 `catch` 吞掉。改为 `let`，并让启动异常强制写入控制台。
- **浏览器访问 `/app`（无尾斜杠）整页无样式无脚本**：页面内资源为相对路径，会被解析到根目录而 404；
  现在裸路径 302 到 `/app/`，测试补充该断言（30 个用例）。
- 测试页面断言原先匹配的是重做前的标题文案，改为校验三栏骨架的关键节点。

### 计划中

- 接入 AI provider（自然语言 → 指令对象），落地 `/ai/nl2command`。
- 农历能力（`GET /meta/lunar` 目前返回 501 与契约）。
- 导入 PotatoTimer 学习记录（`source: "import"` + `externalId`）。
- 移动教务（jwapp）课表导入：思源学堂没有上课时间/地点，「自动生成课表」需要接这一路接口。
- 重复日程的单次例外（`exceptions`）。
- ICS 导入（当前只支持导出）。
- 存储层替换为 SQLite（服务层接口保持不变）。

## [0.1.0] - 2025-10-11

首个可运行版本：后端接口 + 指令添加 + 测试窗口（浏览器 `/app` 或 Electron），含 dschat 2 兼容层。

### 新增（测试窗口与运行环境适配）

- **浏览器托管的测试页面**：后端新增白名单静态路由 `GET /app`、`/app/app.js`、`/app/styles.css`，
  页面在同源下自动以当前 origin 作为 API 基址；`npm run start:server` + `open http://127.0.0.1:3210/app` 即可查看，
  不再强依赖 Electron。
- **主进程改为 CommonJS**（`src/main/main.cjs`，删除原 ESM `main.js`）：ESM 下 `import ... from 'electron'`
  会被解析到 npm 包（导出二进制路径字符串），拿不到 `app`/`BrowserWindow`；后端等 ESM 模块改用动态 `import()`。
- **主进程启动日志**：写入 `data/electron-main.log`（GUI 方式启动时看不到 stdout），并记录页面加载失败与渲染进程退出事件。
- **macOS 启动脚本** `scripts/run-electron-macos.sh`（`npm run dev:app:macos`）：把 Electron 运行时复制到工作区
  `.electron-bundle/`、同步 `package.json + src` 进 `Contents/Resources/app`、写入 `data-dir.txt` 让测试窗口与项目
  **共用同一份数据**，最后用 `open -n` 经 LaunchServices 启动。
- **`GET /health` 增加 `websocket.clients`**：可据此确认测试窗口/浏览器页面是否已连上推送通道。
- **主进程支持数据目录覆盖**：`POTATO_DATA_DIR` 环境变量，或应用目录下的 `data-dir.txt`（脚本写入）。
- 文档补充环境限制与对策：带沙箱的 macOS 环境下 `electron .` 会在 `ElectronMain` 启动阶段 `SIGTRAP` 崩溃
  （最小空白窗口应用同样复现，与本模块代码无关），需经 LaunchServices + 已打包应用的方式启动；
  `open --args <未打包目录>` 不生效；宿主若设置 `ELECTRON_RUN_AS_NODE=1` 需先 `env -u`。

### 新增（对齐 dschat 2）

- **兼容层** `src/server/services/compat.js`：宽松日期/时刻归一化（`2026-9-1`、`2026/09/01`、`2026年9月1日`、`9:00`）、
  snake_case → camelCase 字段别名、dschat 2 扁平重复字段（`repeat` + `repeat_interval` + `repeat_end`）与本模块结构化
  `repeat` 的双向转换、单日事件与 `Schedule`/`Event` 的互转。
- **标记行解析** `src/server/parser/markup-parser.js` + `POST /commands/markup`：直接消费 dschat 2 的中文标记行
  （`[新增日程] 标题 | 日期 | 开始时间 | 结束时间 | 地点 | 重复 | 重复截止` 等），一次多行、逐条返回结果，
  并兼容其「7 字段 / 8 字段」两种历史写法。
- **兼容接口** `/compat/dschat/events`（列表 / 创建 / 更新 / 删除）与 `/compat/dschat/events/delete`（按标题精确批量删除）。
- **ICS 导出** `GET /ics`（`text/calendar`）：全天事项 `DTEND` 按 RFC 5545 取次日，重复完整导出
  `RRULE`（`FREQ` / `INTERVAL` / `BYDAY` / `UNTIL` / `COUNT`），UID 形如 `<id>@potato-calendar`。
- **CORS**：允许浏览器直接打开测试页面联调（服务仅监听 127.0.0.1，且支持 `OPTIONS` 预检）。
- **测试页面回退**：无 Electron preload 时渲染层回退到默认后端地址，可用 `?api=&ws=` 覆盖。
- 文档：`接口文档.md` 新增第 3.5 节（导出与兼容接口）、第 8 节（与 dschat 2 的对照、可对齐/不可对齐清单）；
  `test/compat.test.js` 12 个用例（含标记行、宽松日期、RRULE、ICS、CORS、端到端）。

### 新增

**领域模型**

- 日历事件 `Event`：日期/日期区间粒度，分类枚举，标签，支持重复规则与外部 id。
- 日程 `Schedule`：时段粒度（`startTime`/`endTime`），`allDay` 时退化为日期锚点；含四态状态机
  `pending / done / cancelled / rolled`、三档优先级、预估时长与派生的 `complexity`、地点、提醒。
- 结构化重复规则 `repeat`：`daily / weekly / monthly / yearly / weekday` + `interval` + `weekdays` + 结束条件
  `until: { mode: never | date | count }`；月末与 31 号场景做了修正。
- 提醒 `reminders`：提前分钟数 + 渠道 + 按发生日去重的 `sent` 记录。

**接口（REST，前缀 `/api/v1`）**

- 服务自描述与 `GET /health`、`GET /meta/theme`、`GET /meta/lunar`（占位 501）。
- 事件：列表、区间展开、创建、详情、局部更新、删除（`/events*`）。
- 日程：列表 + 区间统计、区间展开、单日 `agenda`、`stats`、创建（附带冲突提示）、局部更新、
  状态流转 `POST /schedules/{id}/status`、删除、顺延 `POST /schedules/rollover`。
- 聚合视图 `GET /calendar?from=&to=&view=`：按天分桶的 events + schedules + 统计，最长 400 天。
- 指令：`POST /commands/parse`、`POST /commands/execute`、`POST /commands/run`（均支持 `dryRun`）、
  `GET /commands/grammar`、`GET /commands/logs`。
- AI 占位：`GET /ai/capabilities`、`POST /ai/nl2command`（默认 501 `AI_UNAVAILABLE`，
  传 `fallback: "rules"` 时降级到本地规则解析器）。

**指令添加**

- 中文规则解析器：动作/对象识别（未指明对象时按是否含具体时刻推断）、相对与绝对日期
  （今天…大后天、周X/下周X、X月X日、`YYYY-MM-DD`、日期区间）、时刻（`15:00`、`下午3点半`、区间、时长）、
  重复（每天/每周X/每两周/工作日）、提醒（提前10分钟/半小时/1天）、分类关键词、优先级、标题抽取与清理。
- 产出一致的「指令对象」（`action / target / fields / filters / confidence / warnings / explain`），
  供前端确认卡片与未来 AI provider 复用；低置信度场景给出 `warnings`。
- 重复日程锚点落在过去时自动滚动到下一个命中日。

**运行时与基础设施**

- 零依赖 HTTP 路由（路径参数、查询串、JSON body、统一错误响应 `{ ok, error: { code, message, details } }`）。
- 零依赖 WebSocket 服务端（RFC 6455 文本帧子集）+ 进程内订阅者（主进程用于系统通知）。
- JSON 集合存储：临时文件 + rename 原子写、写入串行化、**单条容错**、文件损坏时备份为
  `*.corrupt-<时间戳>` 后以空集合启动（避免静默覆盖）。
- 提醒服务：默认 30 秒扫描，定时日程以 `date + startTime`、全天日程以当天 08:00 为基准，
  超过 12 小时的过期提醒不补发。
- 设计令牌 `src/shared/theme.js`：沿用深色配色与复杂度阈值，去掉 Qt QSS 与 macOS 私有字体。

**前端（测试用）**

- Electron 主进程：同进程启动后端、端口占用自动递增、通过 IPC 暴露实际地址与主题、提醒转系统通知。
- 最简测试窗口：指令输入（解析/执行）、今日日程列表、示例指令、WebSocket 重连与 toast 提示。
- `contextIsolation: true`、`nodeIntegration: false`，渲染层不接触 Node API。

**测试与文档**

- `node:test` 用例 17 个：解析器 9 个（固定时钟保证稳定）+ 接口 8 个（真实起服务、临时数据目录）。
- 文档：`接口文档.md`（模型、接口、指令语法、WebSocket、AI 契约、与参考实现的差异）、`README.md`。

### 与参考实现（PotatoCalendar）的关键差异

- 拆分 `events.json` 的「整天事件」与「时段事件」，并统一字段命名为 `startDate/endDate/startTime/endTime`。
- 重复规则从「逐日取模 + 无结束条件」升级为结构化规则 + `until`。
- 「顺延」不再克隆后把原条目标记为已完成，改用 `rolled` 状态与 `rolledFrom`/`rolledTo` 双向引用。
- id 从「微秒时间戳字符串」改为 `randomUUID()`，并统一三类记录的主键风格。
- 写入从「直接覆写整文件」改为原子写 + 逐条容错 + 损坏备份。
- 新增提醒、冲突提示、聚合视图与指令系统。
- 未移植农历查表（经逐日校验偏差率 99.7%）与 Qt 相关的绘制/样式代码。
