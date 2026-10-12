# AI 智学程序 · 后端与测试窗口

> **框架（`src/core`）+ 可插拔功能模块（`src/modules`）** 的结构：内核提供 HTTP/WebSocket、
> JSON 存储、指令系统、AI 接入契约与三栏测试界面；每个功能是一个自包含目录，**新增功能不需要改框架代码**。
>
> 后端 Node.js **零运行时依赖**；前端 Electron 或浏览器均可（**当前窗口仅用于联调测试，正式 UI 由主程序提供**）；
> AI 能力本阶段**只留接口**。

- **要加功能？先看 [模块开发指南.md](docs/模块开发指南.md)**
- 接口契约见 [docs/接口文档.md](docs/接口文档.md)
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)

## 已装配的模块

| 模块 | order | 能力 | 状态 |
| --- | --- | --- | --- |
| `auth` | **5** | **全局统一身份认证**：登录收敛到一处（设置页），学堂与教务共享 Cookie 罐里的 CAS 票据实现**单点登录**（实测双向成立，底层是 Keycloak）；逐站点状态、短信/二次认证、图形验证码；给 AI 的工具契约 2 个已实现 | ✅ |
| `calendar` | 10 | 日历事件 + 日程（时段）+ 提醒 + 重复规则 + ICS 导出 + dschat 2 兼容 + 中文指令添加 + 顺延 | ✅ |
| `lms` | 20 | 思源学堂：课程/作业/网课（直播 + 回放）拉取、**按学期 → 课程 → 活动三级分类**、**课程页**（课程信息 / 回放 / 作业 / 资料 / 直播，可折叠）、**回放下载**（录播站三步取链，落盘本地）、自动同步；**登录已交给 `auth`**（本视图没有密码表单，也**不展示账号信息**）；给 AI 的工具契约 **11 个已实现 + 5 个预置未实现** | ✅ |
| `academic` | 30 | **学业情况查询**：从本科教务系统拉取官方成绩单（四步授权握手），学分绩 / 加权平均分计算，**每一项都可单独选择是否计入学分绩（也支持整个学期一键计入/屏蔽）**，同步后出 AI 学情分析（未配密钥时退化为本地统计摘要）；**登录已交给 `auth`**；给 AI 的工具契约 **11 个已实现** | ✅ |
| `knowledge` | 70 | **知识库**：教务处政策语料（148 篇 / 18 栏 / 11.5 万字，仓库内 `knowledge/dean/`）的关键词检索与原文读取；**只读、不联网**、每条结果都带来源 URL、**只给片段不回灌全文**；给 AI 的工具契约 2 个 | ✅ |
| `ai` | 90 | AI 接入：OpenAI 兼容 provider、多轮对话与流式、会话落库、上下文注入、模型草稿预校验（**模型不许直接写库**）；聚合各模块的 `aiPrompt` / `aiQueryFields` / `aiTools` | ✅ 未配密钥时自动降级到本地规则 |
| — | — | 框架级：指令记录、设置、AI 契约（`aiBridge` / `aiTools` 聚合） | ✅ |
| 笔记系统 / 随手拍 | — | 左栏已占位（`shell/planned.js`），实现同名视图即自动接管 | 🚧 规划中 |

运行时可探测：`curl -s localhost:3210/api/v1/modules | jq`

## 快速开始

```bash
cd app

# 1) 只跑后端（接口联调推荐，零运行时依赖）
npm run start:server          # http://127.0.0.1:3210/api/v1
npm run dev:server            # 带 --watch 自动重启

# 2) 跑 Electron 测试窗口（需先装依赖）
npm install                   # electron 为 devDependency
npm run dev:app

# 3) 测试（零依赖，369 个用例；含思源学堂/教务/AI 上游的本地 mock、**单点登录的两个站点联动**、绩点与学分绩口径、视图渲染、农历权威向量、日历/待办端到端测试）
npm test
```

后端零运行时依赖（只用 Node 内置模块），因此**不装 Electron 也能完整联调接口**。

### 想用 AI 对话？（可选，不配也能跑）

AI 模块（`src/modules/ai/`）兼容任何 OpenAI 协议的端点，默认指向 DeepSeek。**不配密钥时一切照旧**：
`/ai/nl2command` 返回 501，传 `fallback: "rules"` 仍然走本地规则，`/ai/capabilities` 的 `available` 为 `false`。

对话支持：Markdown + **LaTeX 公式排版**（`$…$` / `$$…$$`）、**```svg 绘图**（设置页可开关，
说「画个图」也能临时触发）、以及**默认折叠的操作卡**（日程橙 / 待办紫 / 事件蓝）。

```bash
export PC_AI_API_KEY=sk-…      # 或启动后在「设置 → AI 接入」里填（落 data/ai-config.json，0600）
npm run start:server

curl -s -X POST localhost:3210/api/v1/ai/chat -H 'Content-Type: application/json' \
  -d '{"text":"明天交实验报告，预计两小时"}'
```

**最省事的验证方式**是直接在窗口里说话：中栏输入「明天交实验报告，预计两小时」，
回复会逐字长出来，末尾附一张待办确认卡，点「确认执行」才落库 —— 模型只提议，不直接写数据。

接口清单与「模型只能提议、用户确认才落库」的约定见 [接口文档.md 6.4](docs/接口文档.md)。

### 打开测试窗口的两种方式

**方式 A（推荐，零依赖）：浏览器打开后端托管的测试页面**

```bash
npm run start:server
open http://127.0.0.1:3210/app        # 页面与接口同源，无需额外配置
```

`/app/**` 整目录由后端按前缀托管（带越界防护，且只走白名单 MIME 类型），页面会自动使用同源地址作为 API 基址。
因此**新增前端文件不需要改后端代码**，只要在 `index.html` 里加一行 `<script>` / `<link>`。
访问 `/app`（无尾斜杠）会 302 到 `/app/`：页面内的资源都是相对路径，否则浏览器会以 `/` 为基准解析导致整页无样式无脚本。

**方式 B：Electron 测试窗口**

```bash
npm install
npm run dev:app            # 常规环境（直接 electron .）
npm run dev:app:macos      # 沙箱环境 / 需要 LaunchServices 启动时（见下）
```

`npm run dev:app:macos` 会做三件事：把 Electron 运行时复制到工作区内的 `.electron-bundle/`（首次约 130MB）、
把 `package.json + src` 同步进 `ElectronTest.app/Contents/Resources/app`、写入 `data-dir.txt` 让窗口与项目
**共用同一份数据**（`app/data`），最后用 `open -n` 启动。日志与数据位置会在启动后打印出来。

Electron 的 npm 包只含脚本，真正的二进制默认从 GitHub Releases 下载；若网络不可达会报 `fetch failed`，可指定镜像重试（本机验证可用）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
# 若仍失败，可直接下载解压：https://cdn.npmmirror.com/binaries/electron/<版本>/electron-v<版本>-darwin-arm64.zip
# 解压到 node_modules/electron/dist，并写入 node_modules/electron/path.txt（内容：Electron.app/Contents/MacOS/Electron）
```

> ⚠️ **沙箱环境下的注意事项**（本机 macOS 26 + 宿主沙箱，已逐条验证）：
>
> 1. **直接运行 `electron .` 会崩溃**：进程继承宿主沙箱 profile 后，Electron 在 `ElectronMain` 启动阶段
>    以 `EXC_BREAKPOINT (SIGTRAP)` 退出，且早于应用主脚本执行（最小空白窗口应用同样复现，与本模块代码无关）。
>    **经 LaunchServices（`open`）启动的 app 由 launchd 赋予独立运行环境，可以正常工作** —— 这正是
>    `npm run dev:app:macos` 存在的原因。
> 2. **`open ... --args <未打包应用目录>` 不会加载我们的应用**（主脚本不执行）；必须把应用放进
>    `Electron.app/Contents/Resources/app`，脚本已自动处理。
> 3. 若宿主设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会被当作普通 Node 运行，
>    表现为 `Cannot read properties of undefined (reading 'handle')`；启动前需 `env -u ELECTRON_RUN_AS_NODE`。
> 4. 应用包**不能放在 `~/Library/Application Support` 等沙箱外路径**（写入会被拒绝），脚本默认放
>    工作区内的 `.electron-bundle/`。

> ⚠️ **Windows + 受限会话的注意事项**（已实测）：
>
> 如果宿主环境限制了 GUI/子进程创建，Electron 会**窗口一闪即逝、进程干净退出**。
> 诊断入口是主进程日志（GUI 启动看不到 stdout，所以刻意落盘）：
>
> ```powershell
> Get-Content data\electron-main.log -Encoding UTF8 -Tail 30
> ```
>
> 典型日志与含义：
>
> | 日志 | 含义 |
> | --- | --- |
> | `!! 子进程退出: type=GPU reason=launch-failed` | Chromium 起不了 GPU 子进程 → 用下面的 `dev:app:safe` |
> | `Cannot read properties of undefined (reading 'handle')` | 宿主设了 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成普通 Node |
> | 停在「测试窗口已创建」之后再无输出 | 窗口被外部关闭；`window-all-closed` 会记一条「窗口已关闭」 |
> | `!! 未捕获异常` / `!! 渲染进程退出` | 真正的崩溃，堆栈会跟在后面 |
>
> 另有两点 Windows 与 macOS 的差异（都已在**测试侧**打补丁，应用代码不变，macOS 行为不受影响）：
>
> | 差异 | 处理 |
> | --- | --- |
> | **POSIX 权限位**：Windows 只认只读位，`0600` 与 `0666` 在 `stat().mode` 上无法区分（实测 0600/0644/0400 → 666/666/444） | `test/ai.test.js` 的 `0600` 断言在 `win32` 上跳过；`secret-store.js` 仍照常按 `0600` 请求，macOS/Linux 照常校验 |
> | **GUI 子进程**：受限会话下 Electron 起不来 | 用 `npm run dev:app:safe` 或浏览器方式（见下）；`scripts/run-electron-macos.sh` 与 `dev:app:macos` 保持原样 |
>
> 规避 GPU 子进程失败（禁用 GPU 与渲染进程沙箱，仅适用于本机联调窗口）：
>
> ```powershell
> npm run dev:app:safe
> ```
>
> **若仍无法启动**：该环境大概率禁止创建 GUI 子进程（`notepad` 同样起不来，事件日志里没有崩溃记录）。
> 这种情况别再折腾 Electron —— 用**浏览器方式**，UI 与功能完全一致，只是没有系统通知：
>
> ```powershell
> npm run start:server
> # 浏览器打开 http://127.0.0.1:3210/app
> ```

主进程刻意使用 CommonJS（`src/main/main.cjs`）：在 ESM 下 `import ... from 'electron'` 会被 Node 解析到
node_modules 里的 npm 包（导出二进制路径字符串），拿不到 `app`/`BrowserWindow`；需要 ESM 模块时用动态 `import()`。

### 测试窗口界面

三栏布局，无框架、无构建步骤（原生 HTML/CSS/JS）：

| 区域 | 内容 |
| --- | --- |
| 左栏（约 10% 宽） | 日历 / 待办 / 思源学堂 / **学业** / 笔记系统 / 随手拍 / 消息，底部独立「设置」 |
| 中栏 | 输入区：左侧「**+**」可加图片/文件（图片转多模态、文本内联、读不了的如实说明）；输入框**两行高**（自动增高到 180px），**下面没有小字提示**（Enter/Shift+Enter 挪到悬停 title）。下一行**左边**是「**联网搜索**」（地球图标，点开向上弹：不联网 / 从校外网搜索 / 从校内网搜索）与「**思考模式**」（无/低/高/最高，对应官方 `reasoning_effort` 的 none/low/high/max），**右边**是三个小图标：**权限**（盾牌：自动审批 / 手动审批 / 全部确认）、**用量**（柱子：token 与缓存命中率）、**绘图**（画笔：蓝=允许画 ```svg，灰=关）；图标 19px、**无边框无底色**，**颜色即状态**，权限与联网的选择记在本地，重开窗口不丢；下拉菜单**不用 ✓**（选中项是整行淡蓝底 + 蓝字，所有行等高，不会有错位）；**除顶栏外菜单一律向上展开，且不影响输入框那一行**。顶栏「**AI：<具体模型名>**」点开可选模型（列表问上游 `GET /models`，拿不到给内置候选；顶栏在最上面，所以这个菜单**向下**展开，输入区那几个才是向上）。对话：配了 AI 密钥就走模型（**边生成边渲染**）：一次发言最多 **5 轮**（模型可以连着查几次再回答，回灌那几轮同样流式），回复按 Markdown + LaTeX 渲染（**公式排版**、可画 **```svg 图形**），安排渲染成**指令草稿确认卡** → 点「确认执行」才落库（「自动审批」档由系统直接执行并出回执卡）；查询/写入结果渲染成**默认折叠的操作卡**（日程橙 / 待办紫 / 事件蓝 / 成绩青 / 写入绿，点开看明细）；**操作卡在上、回复正文在下** —— 结论永远是这一轮最后一个节点，卡片再多也挤不掉它；没配密钥则走本地规则解析 |
| 右栏 | 左栏所选功能的视图，右上角 `⟩` 可收起（收起后中间变宽，周视图置灰）；设置页内容超高时可滚动 |

功能视图（本模块负责的部分）：

- **日历**：月视图（7×6 格子、时段色条、待办小圆点、每格农历、节日高亮、今日高亮、悬停 `+` 快捷新建）、周视图（24 小时时间轴、重叠日程自动分列、全天行放当天截止的待办标记、点空白按 30 分钟吸附新建）、日视图（Apple 风格时间轴 + 日期下方的干支农历与节日 + 「全天」行放当天截止的待办，逐条可编辑·删除）、**年视图**（4×3 迷你月、今天高亮、有内容的日期带小圆点、点月份标题进月视图、点某天进日视图，窄栏自动两列）；周视图需要右栏展开（宽度不足时自动回退月视图）。
- **农历**：1900–2100 查表换算（干支年 / 生肖 / 月日 / 闰月），节日只做农历那九个（春节、元宵、端午、七夕、中元、中秋、重阳、腊八 + 除夕），**不做节气**（节气要天文算法，近似值就是错数据）。`GET /meta/lunar` 支持单日与批量。
- **待办**：全部 / 今天 / 本周 / 逾期 / 已完成筛选，顶部快速添加，按「已逾期 / 今天到期 / 本周到期 / 未完成 / 已完成」分组，卡片显示截止日、相对日（已逾期 N 天）、优先级、复杂度色点与预估工时，支持勾选完成、顺延未完成到本周，底部显示完成率、计划时长与逾期数。
- **新建 / 编辑弹层**：待办 / 日程 / 日历事件三个页签，支持重复规则（每天 / 每周 + 星期集合 / 每月 / 每年 / 工作日 + 间隔 + 结束条件）、提醒档位、优先级、预估时长、地点、备注。
- **设置 → 日程**：日程分类与日历事件分类可自己建（名称 + 12 色板或取色器），能改名、改色、删除；编辑器选分类是**带色点的下拉**，颜色贯穿日 / 周 / 月三个视图。删除一个在用分类不会丢数据 —— 相关日程会被改成「其它」并告诉你改了几条（「其它」是兜底分类，不可删除）。
- **设置 → 统一身份认证**（`auth.account`，order 10）：**全程序唯一的登录入口**。填一次学号密码，学堂与学业情况**都**会就绪 —— 两个模块用的是同一个学校账号，共享 Cookie 罐里的 CAS 票据做单点登录（实测双向成立，底层是 Keycloak 而非单纯 CAS）。卡片逐站点显示状态（学堂 ✓ / 教务 未登录 + 原因），每个站点带「重新连接」可单独重试；短信验证码、二次认证、图形验证码都在这里完成。**密码提交后立刻从内存清掉，不落盘、不保存**。
  - 退出登录是**全局的**：单点登录下 TGC 还在，只退某一个站点下次会被静默重新认证（看起来就是"退不掉"），所以 `/lms/logout`、`/academic/logout` 与这个按钮是同一个动作。
  - 票据统一落在 `data/auth-session.json`（0600）。旧版的 `lms-session.json` / `academic-session.json` 会在首次启动时被并进共享罐后删除。
- **设置 → AI 接入**：填 API Key / 模型 / 接口地址（密钥落本机 `data/ai-config.json`，0600，**接口与界面都只回显末四位**），显示当前状态与会话数，可「新对话」「清空全部会话」。保存后徽标与中栏立刻切成模型驱动（`data_changed` 广播 + 主动刷新两条路都走）。
- **思源学堂**：**首页只有「自动同步 + 课程」两张卡**（连顶部的「账号与同步」工具条都没有）。活动与课程按**学期**分类（三级：学期 → 课程 → 活动）。**登录与账号信息都不在这里** —— 未登录时只给一张引导卡，点「去设置里登录」跳到设置页（见上）；账号、缓存统计、服务地址、退出登录一律不重复展示，退出走设置页那个**全局退出**。
  - **自动同步**：首页第一张小卡，开关 + 间隔（1~168 小时）+ 最近一次自动同步时间，改动即时生效；默认关闭，只新建与更新，**不会删除任何日程**；
  - **课程**：按学期分组，表头给 N 门，可折叠；**新学期在前**（依据：学期内最晚的活动时间 → 课程起止日期 → 学期 code），课程缓存里查不到的落到「未知学期」并永远排最后；**学期层看整批条数**（> 12 门只默认展开最新学期，先给概览），另有「全部展开 / 全部收起」；
    每门课带一行活动分布（作业 / 网课 / 其它，含未提交与未查数），**点一下进课程页**；
  - **课程页**（单独一屏，左上角「← 返回」回首页）：课程信息 → **作业** → **课程回放** / 资料 / 直播 / 其它，各分节都可折叠（作业排第一：进课程页先看有什么要交的）；
  - **回放下载**：点「取视频」列出两路录制（教室录像 / 电脑内录，并标出音质更好的那路），点「下载」真下到本地，
    界面显示进度与速度、可取消；落盘 `<dataDir>/downloads/<课程>/<活动>/<标签>_<体积>.mp4`，
    先写 `.part` 再改名 —— 中途失败不会留下半个"看起来正常"的视频。
  - 「活动」与「同步到日历」两张卡这一轮按要求从首页撤掉了：同步的**接口与 AI 工具都还在**
    （`/lms/sync/preview`、`/lms/sync/apply`），只是界面上暂时没有入口；活动改由课程页按课程呈现。
  - 网课 = 直播 + 回放 + 在线视频，逐条仍标注具体是哪种。**网课没有独立入口** —— 它本来就来自学堂，左栏那个「网课」占位页已删；接口侧同样认 `GET /lms/activities?type=online`。
- 学情 / 笔记系统 / 随手拍为**占位页**（说明各自的数据挂载点，能力属于 AI 智学主程序）；笔记系统与随手拍是一对：先拍下来，再整理成笔记，必要时一键转成待办 / 日程。

演示数据（可选，方便评审各视图）：

```bash
node scripts/seed-demo.js          # 写入 16 条演示记录（日期相对今天生成，带 tags: ["demo"]）
node scripts/seed-demo.js --clear  # 只删除演示记录，不影响手动添加的数据
```

### 思源学堂接入（LMS）

把「思源学堂里有哪些课程、作业什么时候截止、什么时候直播」变成日历里的待办与日程。
参考实现是 [yan-xiaoo/XJTUToolBox](https://github.com/yan-xiaoo/XJTUToolBox) 的 `lms/` + `auth/`（Python），
这里用**零依赖 Node** 重写，并且**只读**学校数据（不代交作业、不改任何学校侧内容）。

在测试窗口左栏点「思源学堂」即可使用：

1. **登录**（在**设置 → 统一身份认证**里做，只做一次）：学号 + 密码。密码用 `/cas/jwt/publicKey` 的 RSA 公钥加密后才发出，**明文密码不出本机**；若学校要求两步验证，会让你发短信验证码并输入；连续失败 3 次会出现图形验证码。登录之后学堂与学业情况**同时**就绪。
2. **课程 / 活动**：登录后自动拉取「我的课程」与每门课的作业、直播、回放、资料，并缓存到本地（断网也能看上次结果）。
3. **同步到日历**：点「预览同步」先看清单（新建 / 更新 / 跳过 / 失效），勾选后再点「同步选中」。
   - 作业 → **待办**（截止日；同一天两端都有明确时刻时才做成时段日程），已在学堂提交的作业直接标成「已完成」；
   - 直播 → **时段日程**（有真实起止时刻，分类「上课」）；只有日期、没有时刻的直播与回放 → **全天日历事件**；
   - 回放 / 资料默认不导入，可在选项里打开；
   - 每条记录带 `externalId = lms:activity:<活动 ID>`，**重复同步只更新不新增**，而且不会覆盖你手动改过的完成状态与提醒。

同步也可以交给后台自动做：打开「自动同步」后，服务每 30 分钟检查一次，间隔到了就按同一套规则执行
（**只新建与更新，绝不删除**），适合「作业一发布就自动出现在待办里」。默认关闭。

票据统一存在 `data/auth-session.json`（权限 `0600`，7 天后失效），**不保存密码**；
旧版的 `data/lms-session.json` 会在首次启动时并入它之后删除。
不登录时仍然可以查看缓存的课程与活动（响应里 `loggedIn: false`），但同步等写操作会返回 401。

想先看效果但不想用真账号？可以起一个**本地假思源学堂**（内置 2 门课 / 4 个作业 / 1 场直播 / 1 个回放）：

```bash
node scripts/mock-lms-server.js --port 4599            # 终端 A：假站点（加 --mfa 可演示两步验证）
PC_LMS_BASE_URL=http://127.0.0.1:4599 \
PC_LMS_CAS_ORIGIN=http://127.0.0.1:4599 \
PORT=3210 node bin/server.js                          # 终端 B：后端指向假站点
# 再打开 http://127.0.0.1:3210/app/  ，用 2021001 / pw-123456 登录
```

（Electron 测试窗口也可以用同一份假站点：把上面的两个地址写进数据目录的 `lms-config.json`
—— `{"baseUrl":"http://127.0.0.1:4599","casOrigin":"http://127.0.0.1:4599"}` —— 再 `npm run dev:app:macos`。
GUI 由 LaunchServices 启动，**不会继承终端环境变量**，所以用配置文件而不是环境变量。）

登录出问题时先跑自检脚本（不需要账号，只检查跳转链、公钥、验证码接口）：

```bash
node scripts/lms-probe.js
```

> 思源学堂**不提供上课时间/地点**，所以「自动生成课表」还需要另接移动教务（jwapp）的课表接口，本阶段没做。
>
> **AI 侧的工具契约分了两种状态**：`implemented: true` 的 8 个现在就能调；
> `implemented: false` 的 6 个（课程详情、课件清单、作业提交情况、通知公告、成绩、讨论区）
> 只有**契约**，调用返回 `501 NOT_IMPLEMENTED` 且 `details.planned = true` ——
> 刻意不用 404，这样 AI 能分清"这个能力我认识、只是还没做"和"路径写错了"。
>
> 界面上「**未提交 N**」和「**未查 N**」是两件事：活动列表接口**不返回**提交状态，
> 要补拉详情（预览同步时最多补 40 条）才知道，"没查过"不会被说成"没提交"。
> 全部 14 项相关用例都用本地 mock 服务器跑（`test/helpers/lms-mock.js` 复刻了 CAS 登录、RSA 加密、Cookie、两步验证与失败提示），
> 因此**不需要真实账号**也能验证整条链路。

### 学业情况查询（教务成绩）

把「我这学期考了多少、学分绩多少」变成程序里能看到、能算、能问的数据。左栏点「**学业**」。

- **取数**：只读，从本科教务系统拉官方成绩单，落 `data/academic-grades.json`，断网也能看上次结果；
- **按学期一键**：成绩明细按学期分组，每个学期行右侧有**三态勾选框**「整学期计入」（全计入 / 混合 / 全屏蔽，点一下全计入、再点一下全屏蔽）；
- **学分绩**：`Σ(学分 × 绩点) / Σ(学分)`，只统计**你勾选**的课程 —— **每一门都可以单独选择算不算**，
  另有「全部计入 / 全部排除 / 本学期排除 / 不及格排除 / 恢复默认」几个批量动作；
- **绩点用学校给的**：教务直接返回 `XFJD`（实测与官方 4.3 制表吻合：期末 93 → 4.0，84 → 3.3），
  只有缺失时才按换算表推算，并在数据里标明来源；
- **学情分析**：每次同步后自动生成一段点评（200 字内，只依据真实数据，不会编排名与保研线）；
  **没配 AI 密钥也不失败** —— 退化成确定性统计摘要并标注「本地统计」。改了勾选后旧分析会被标成「已过期」；
- **对话里也能问**：「我学分绩多少」「把选修课都排除掉」「同步一下成绩」都能被本地规则或 AI 处理。

> ⚠️ **取数前必须做四步「应用授权握手」**，否则教务的成绩接口会**稳定返回 403**。
> 这一点与"路径写错了""账号没权限"都不一样，排查时很容易被带偏 ——
> 完整根因与真实字段表见 [docs/教务成绩接口调研.md](docs/教务成绩接口调研.md)。
> `test/helpers/ehall-mock.js` **强制校验这个握手**（`_WEU` 不是当前值就 403），
> 所以哪天有人图省事把它删了，测试会立刻红。
>
> 与思源学堂是**两套独立会话**（同一套 CAS，但票据不共用）：退出其一不影响另一个。
> 思源学堂的 `lms_grades` 是学堂视角的「课程总分与各项得分」，**不是**官方成绩单；
> 学分、绩点、学分绩只由本模块提供 —— 提示词里特意点明了这个区别，避免模型混用。

### 教务处政策语料（`knowledge/dean/`）

把教务处官网 <https://dean.xjtu.edu.cn/> 的公开政策文本抓成本地语料，**进仓库、协作者共用**：
转专业条件、考试纪律、学籍处理、毕业学位要求这类问题，模型靠"记忆"是编不出来的，必须有原文可引。

- **规模**：18 个栏目 / **148 篇** / 约 **11.5 万字**（学生事务、规章制度、教学业务三大块 + 校历 / 作息时间 / Q&A / 培养方案）；
- **形态**：每篇一个 Markdown（YAML 头带 `title / url / publishedAt / category / kind`），
  外加 `index.json`（逐篇 `chars` 与 `sha256`，供检索与一致性校验）。附件只记链接不下载正文；
- **可复现**：`node scripts/crawl-dean.js` 一条命令重抓并重建索引（串行 + 400ms 间隔 + 失败退避）；
  `--only=<slug>` 只刷某几栏、`--index-only` 离线重建索引、`--check` 校验索引与文件一致、
  `--url=<页面>` 打印单页的转换结果（排查"这篇抓歪了"）。抓取器零依赖；
- **有意不抓**：教学通知 / 教学动态这类几天就过期的页面 —— 进了语料只会让模型答出过时结论
  （`test/knowledge.test.js` 里有断言挡着）；
- **给 AI 的用法**：只**按需检索**命中段落 + `url`，**不整篇注入提示词**；
  本版明确不做向量检索（关键词 + 栏目够用，见接口文档 §10 的取舍）。
  怎么更新、字段含义、使用约定见 [`knowledge/dean/README.md`](knowledge/dean/README.md)。

### 冒烟示例

```bash
# 指令添加
curl -s localhost:3210/api/v1/commands/run \
  -H 'Content-Type: application/json' \
  -d '{"text":"添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒"}' | jq

# 今日日程
curl -s "localhost:3210/api/v1/schedules/agenda" | jq

# dschat 2 风格的标记行（AI 输出可直接投喂）
curl -s localhost:3210/api/v1/commands/markup -H 'Content-Type: application/json' \
  -d '{"text":"[新增日程] 每周例会 | 2026-09-20 | 10:00 | 11:00 | 三教101 | 每2周 | 2026-12-31"}'

# 导出 ICS
curl -s "localhost:3210/api/v1/ics" -o potato.ics

# 指令语法速查
curl -s localhost:3210/api/v1/commands/grammar | jq

# 思源学堂：状态 / 课程 / 同步预览（未登录时前两个返回 401）
curl -s localhost:3210/api/v1/lms/status | jq
curl -s -X POST localhost:3210/api/v1/lms/sync/preview -H 'Content-Type: application/json' -d '{}' | jq
```

## 目录结构

```
app/
├── bin/server.js               # 独立启动后端（联调 / 自动化）
├── docs/
│   ├── 模块开发指南.md          # ★ 要加功能先读这个
│   └── 接口文档.md              # 框架 + 各模块的接口契约
├── src/
│   ├── main/                   # Electron 主进程（main.cjs + preload.cjs）
│   ├── shared/                 # 前后端共享：constants.js / time.js / theme.js
│   ├── core/                   # ★ 框架层（组员不改）
│   │   ├── http/               #   零依赖路由 + WebSocket + 静态文件服务
│   │   ├── store/json-store.js #   JSON 集合存储（原子写 + 逐条容错 + 模块集合注入）
│   │   ├── commands/           #   指令分发（解析器/处理器双注册表）+ 中文解析原子函数
│   │   ├── module/             #   模块契约 contract.js + 目录扫描 registry.js
│   │   ├── ai/ai-bridge.js     #   AI provider 注册与契约（占位）
│   │   ├── validate.js         #   通用入参校验
│   │   └── routes.js           #   框架级路由（元信息/health/modules/指令/AI/静态资源）
│   ├── modules/                # ★ 业务层：一人一个目录，互不越界
│   │   ├── calendar/           #   日历与待办（module/service/routes/parser/commands…）
│   │   └── lms/                #   思源学堂（CAS 登录 / API 归一化 / 同步映射 / 工具清单）
│   ├── server/index.js         # 装配：注册表驱动，只做装配不含业务
│   └── renderer/               # 测试窗口（classic script，无构建步骤）
│       ├── index.html          #   入口 + 资源清单
│       ├── shell/              #   外壳：app.js / planned.js / message.js / settings.js / shell.css
│       ├── kit/                #   公共积木：registry.js / util.js / labels.js / dom.js
│       └── views/              # ★ 一人一个 .js + .css
├── data/                       # 运行时数据（集合文件由各模块声明）
├── scripts/                    # run-electron-macos.sh + seed-demo.js + lms-probe.js + mock-lms-server.js
└── test/                       # node:test 用例（接口 / 兼容层 / 思源学堂 / 农历 / 分类 / 渲染层，145 个）
```

## 架构

```
┌─ 渲染层（测试窗口：左功能栏 + 中对话 + 右功能视图）────────────────┐
│  外壳 shell/app.js 只认识「视图注册表」PCModules，不认识任何具体功能 │
│  各 views/<id>.js 自我登记：{ id, label, icon, order, render }      │
└────────────────────────────────────────────────────────────────────┘
        │  HTTP + WebSocket（仅 127.0.0.1）
        ▼
┌─ 后端 ─────────────────────────────────────────────────────────────┐
│  core/routes.js（框架级）+ 各模块 routes.js                         │
│         │                                                          │
│         ▼                                                          │
│  全局 services  ← 由模块的 createServices 提供                      │
│         │                                                          │
│         ▼                                                          │
│  JsonStore（集合清单由模块的 collections 声明自动注册）              │
│                                                                    │
│  指令系统：registerParser（中文→指令对象）+ registerHandler（→落库） │
│  写操作 → broadcast(data_changed) → 前端防抖 150ms 自动刷新当前视图  │
└────────────────────────────────────────────────────────────────────┘
```

装配流程（`src/server/index.js`，**新增功能不用改这个文件**）：

1. `loadModules()` 扫描 `src/modules/<id>/module.js`，按 `order` 排序
2. 建 `JsonStore`（框架集合 + 各模块声明的集合）
3. 逐模块 `createServices`（order 小的先建，后面的模块能拿到前面的服务）
4. 逐模块 `restore`（listen 之前；单个失败降级继续，不拖垮启动）
5. 注册框架路由 + 各模块 `registerRoutes`
6. `listen` 成功后逐模块 `start`；`close` 时**逆序** `stop`

主进程会在同进程内启动后端（端口被占用时自动递增），并通过 IPC 把实际地址与主题令牌交给渲染层；
渲染层不接触 Node API（`contextIsolation: true`、`nodeIntegration: false`）。

## 设计要点

> **框架与功能分离**（最重要的一条结构约定）：`src/core` 只认识「模块描述符」，功能全部在
> `src/modules/<id>/`；后端装配靠目录扫描（新增模块零公共改动），跨模块依赖靠 `order` 表达；
> 前端导航靠视图注册表 `PCModules`。因此**两个人各加一个功能时不会改到同一个文件**。
> 详见 [模块开发指南.md](docs/模块开发指南.md)。

1. **三件事各归其位**：`Event` 管日期/区间（假期、考试周、截止日），`Schedule` 管**时段**（上课、会议、自习，`startTime` 必填、没有完成态），`Todo` 管**截止日 + 完成态**（作业、报名、打卡，独立集合 `/todos`）。日程与待办是两种东西：日程不可「完成」，待办不占时间轴。
2. **指令与 AI 同构**：本地规则解析器与未来的大模型产出**同一种指令对象**（`action / target / fields / filters / confidence / warnings`），落库逻辑只写一遍。
3. **AI 只负责理解**：provider 返回 draft，不直接写库；校验与业务规则仍在服务层，避免模型产出脏数据。
4. **数据安全**：写入走临时文件 + rename；单文件损坏先备份再启动，不做静默清空（修正 PotatoCalendar 的数据丢失级缺陷）。
5. **顺延可追溯**：顺延引入 `rolled` 状态与 `rolledFrom / rolledTo` 双向引用，不再把「被顺延」当作「已完成」。
6. **结构化重复**：支持间隔、星期集合、结束条件（日期/次数），并修正「31 号在 2 月消失」等问题。
7. **零依赖后端**：只用 Node 内置模块，测试与联调不依赖网络安装；Electron 仅作为可选的前端壳。
8. **外部系统只读接入**：思源学堂走「登录 → 拉取 → 预览 → 应用」四步，写库前一定先给用户看清单；每条记录带 `externalId`，重复同步只更新不新增，且不会回滚用户手改的状态。
9. **与 dschat 2 平滑对接**：`/compat/dschat/*` 兼容其 snake_case 字段与按标题删除；`/commands/markup` 直接吃它那套中文标记行；反向可导出 ICS。映射与差异见 [接口文档.md](接口文档.md) 第 8 节。
10. **农历不靠猜**：查表法（1900–2100）按标准编码读（闰月在低 4 位），并**逐日比对 1901–2099 全部 72684 天**、对齐两个独立实现（表驱动的 `zhdate` + 天文算法的寿星天文历 `sxtwl`），顺带修掉常用表里 2097 的错处；向量写进测试，改表就会红。

## 与 dschat 2 的关系（一句话版）

`dschat 2`（同工作区）是「轻量单日事件」模型：无跨天、无状态、无提醒、重复规则较弱，AI 侧靠中文标记行而非 tool schema。
本模块是更完整的日历 + 日程引擎，并**兼容**它的字段与标记行，因此可作为其日历后端的替代或补充。

## AI 接入还差什么

> 一句话现状：**provider 已经接上了（`modules/ai/`），密钥一配就能对话**；
> 没配密钥时行为与以前一致 —— `/ai/nl2command` 返回 `501 AI_UNAVAILABLE`，
> 传 `fallback: "rules"` 走本地规则，界面右上角显示「AI 未接入」。
> 补齐不需要改 `src/core`：`services.aiBridge` 已在全局服务表里，新模块能直接拿到。
>
> 模型要建**待办/日程**时的调用姿势（选哪个集合、哪些字段必填、五个常见错误写法）在
> [接口文档.md 的「★ AI 速查」](docs/接口文档.md) 里；同一套判定表也被写进了系统提示词
> （`modules/ai/prompt.js`），并有测试守着文档与工具清单不漂移。

### 已经就绪的

| 环节 | 位置 | 状态 |
| --- | --- | --- |
| 指令对象契约 | `src/core/ai/ai-bridge.js` 顶部注释 | `action / target / fields / filters / confidence / warnings / explain`，与本地规则解析器**同一种结构** |
| **provider 实现** | `modules/ai/{provider,config}.js` | ✅ OpenAI 兼容（默认 DeepSeek）：SSE 流式、超时、错误映射；密钥落 `data/ai-config.json`（0600），接口只回显末四位 |
| **多轮对话与流式** | `modules/ai/chat-service.js` + WebSocket `ai_delta` / `ai_message` | ✅ 会话与消息落库，历史按轮数截断后带给上游；HTTP 仍一次返回最终结果 |
| **上下文注入** | `GET /ai/context`（`modules/ai/chat-service.js`） | ✅ 今天/星期/视图 + 近期数据摘要 + 记忆预算（记忆未装配时为空，见 [接口文档 §10](docs/接口文档.md)） |
| **模型草稿预校验** | `modules/ai/drafts.js` → `commands.execute(dryRun)` | ✅ 模型只能提议：抽 ```command 草稿 → 真实字段校验（不写库）→ 确认卡 → 用户点了才落库 |
| 落库链路 | `modules/calendar/module.js` 里 `registerHandler('event' / 'schedule' / 'todo')` | ✅ 实测：`/ai/nl2command { fallback: "rules" }` 拿到 draft → `/commands/execute { draft }` 真的建出日程与待办 |
| 降级解析 | `CommandService.tryParse`（约定不抛异常） | ✅ **未配密钥时不注册 provider**，`fallback: "rules"` 不会被挡死；AI 挂了也能用 |
| 能力清单 | `GET /ai/capabilities` 聚合各模块 `aiTools` | ✅ 日历 **19** 个 + 思源学堂 **8** 个 + AI **2** 个（共 29），每项带 `module` |
| **前端接线** | `src/renderer/shell/app.js`（中栏）+ `shell/settings.js`（配置区） | ✅ 配了密钥就走 `/ai/chat`：**边生成边渲染**（WS `ai_delta`，实测 35 块增量）、回复里的草稿渲染成确认卡、失败卡片给「改用本地规则」按钮；设置页能填密钥/模型/接口地址，并管理会话 |
| 降级与文案 | `send()` 按 `state.ai.available` 分流 | ✅ 没配密钥时中栏走本地规则，徽标/欢迎语/底部提示都说明"当前是规则解析"并指路设置页 |
| **只读查询自动执行** | `modules/ai/chat-service.js` 的 `#runReadOnlyQueries` / `#withQueryResults` | ✅ 「我明天有什么日程」不再变成一张确认卡：查询（`dryRun`，只读）自动跑 → 结果回灌 → 模型用自然语言答，界面同时列出数据行；**写操作仍然必须点确认** |
| **多轮工具循环** | `modules/ai/chat-service.js` 的 `send()` | ✅ 一次发言最多 **5 轮**上游调用：每轮都能发查询草稿，执行后回灌继续问，直到模型不再查新东西或到上限。回灌那几轮**也流式**（以前是静默几秒，看着像断了）；新一轮的正文会**替换**掉"我查一下…"的前言，最终答案只有一个；重复查询自动去重，到上限会留一句说明而不是断在半截 |
| **自动审批真的自动** | 同上，`#autoExecuteWrites` | ✅ 以前只在**第一轮**执行写草稿 —— 模型"先查冲突再写"时写草稿落在回灌后那轮，永远变成确认卡（用户原话"自动审批没啥用"）。现在**每一轮**的写草稿都会在 `auto` 档直接落库并出「已自动执行」回执卡，`manual` 档照旧点确认 |
| **成绩单能查** | `modules/academic/` + `modules/ai/prompt.js` | ✅ 对话里能问"把成绩单列出来 / 我这学期成绩"（`target: "grade"`）。原来提示词写着"target **只能**取 todo/schedule/event"、与 academic 的声明互相矛盾，现在改成认各模块声明的 target；成绩单不再被 20 条腰斩（`aiQueryLimits.grade = 300`），查询卡按课程名/学分/成绩/绩点/学期渲染、「在右侧查看」跳到**学业**视图；没配密钥时本地规则也不会再把"我的成绩单"解析成"新增待办" |
| **AI 配置广播不再重建右栏** | `app.js` 的 socket `data_changed` 分支 | ✅ `POST /ai/config`（换模型 / 切绘图 / 改密钥）以前也走 `refresh()`，右侧视图整体重建 —— 每点一次画笔右边栏就闪一下；现在 `ai_config` 只刷徽标与模型列表 |
| **输入区控件** | `app.js` 的 `composeSelect` / `renderControls` + `shell.css` | ✅ 下拉菜单去掉 ✓（选中项＝整行淡蓝底 + 蓝字，固定 `min-height` 所以行高一致、高光不会错位）；图标 19px 无边框，颜色即状态；输入框两行高、底部小字提示删除 |
| **知识库检索（校规）** | `modules/knowledge/` + `prompt.js` 的 `aiPrompt` | ✅ 对话里问「转专业要什么条件」会走**只读** `target: "knowledge"` 草稿检索语料：命中片段（不是全文）+ 出处 URL 一起回灌，回答必须带出处、查不到要说不知道（§15.5 三条硬规则）。打分＝标题×8 + 正文，长度归一；`kind` 为 portal/attachments 的篇目仍能被标题搜到，片段会如实说"正文在图片或附件里" |
| **设置 → 知识库** | `views/knowledge-settings.js` | ✅ 语料概况（来源 / 生成时间 / 栏目表 / 篇数字数）、「重新读取索引」（跑完抓取脚本不用重启）、「自检」（索引与文件是否一致）。**故意没有"从网上下载"的按钮** —— 联网抓教务处必须由用户显式跑脚本 |
| **联网搜索开关** | `app.js` 的 `renderControls()` + `prompt.js` | 🚧 **只有开关与状态位**（不联网 / 从校外网搜索 / 从校内网搜索），检索通道**还没接入** —— 打开后模型会**如实说"联网检索还没接入"**，绝不编造搜到的内容 |
| **公式与富文本** | `kit/richtext.js`（零依赖，纯字符串→HTML） | ✅ Markdown 子集 + LaTeX 子集（分数/根号/上下标/求和/希腊字母/函数/向量/文本）；识别不了的命令**原样显示**不静默吞；流式半截公式不崩。刻意**不引** MathJax/KaTeX —— CSP 是 `default-src 'self'` 且零依赖 |
| **AI 绘图** | `prompt.js` 的 `DRAW_NOTE` + `chat-service.js` 的 `DRAW_KEYWORDS` + `richtext.js` 的 sanitize | ✅ 按 dschat2 的 ```svg 约定；比 dschat2 多两条本地约束：**禁用 `style` 属性**（CSP 会拦）与深色背景配色。设置页可开关；关掉后说「画个图」仍临时触发 |
| **附件 / 思考强度 / 权限** | `app.js` 的 `readFile` / `composeSelect` + `chat-service.js` 的 `normalizeAttachments` / `buildUserContent` / `#autoExecuteWrites` | ✅ 附件：图片走多模态、文本内联（单文件 2 万字、合计 6 万字上限）、其它只登记文件名；**base64 不落库**。思考强度映射官方 `reasoning_effort`（none/low/high/max；默认 high = 官方默认，关闭思考必须显式传 `none`）。思维链 `reasoning_content` 收成默认折叠的「思考过程」卡。**看图只有 `deepseek-flash` 支持**，格式只认 JPEG/PNG/GIF/WebP。权限三档决定查询是否自动执行、写操作是否要确认（`auto` 会替你点确认，风险自负） |
| **Files API** | `modules/ai/files.js` + `provider.js` 的 `uploadFile/listFiles/deleteFile` | ✅ 图片先上传再引用（`{type:"file", file_id}`），**按内容 sha256 去重**（同图多轮复用不重传）、本地只记元信息不存字节、上传失败退回内联 base64 并在 `warnings` 里说明；不受 48MiB 请求体 / 32MiB 单图内联限制 |
| **用量与缓存命中率** | `GET /ai/usage` + `app.js` 的 `usageSelect()` | ✅ 对官方 `usage` 求和：总量 / 缓存命中率 / 未缓存输入 / 缓存读取 / 输出 / 思考 token；命中率按输入侧 `hit ÷ (hit + miss)` 算；**查询回灌那一次的用量也计入**（`calls` 会大于回复条数） |
| **模型选择器** | `GET /ai/models` + `app.js` 的 `wireModelPicker()` | ✅ 顶栏显示**具体模型名**（不是 provider 名），点开选模型并即时 `POST /ai/config`；上游列不出模型时给内置候选并标明。顶栏在最上面，菜单**向下**展开（输入区那几个才向上） |
| **旧模型名迁移** | `modules/ai/config.js` 的 `LEGACY_MODEL_ALIASES` | ✅ 老配置里的 `deepseek-chat` / `deepseek-reasoner`（官方已不接受）在**官方端点**上自动换成 `deepseek-flash`，`/ai/status.modelMigratedFrom` 回显原名、设置页提示一次；自建端点的同名模型不动 |
| **操作卡折叠** | `app.js` 的 `opCard()` | ✅ 查询/写入结果默认折叠成一行（「查看日程 · 2026-10-12 · 点开看明细」），点击展开；按 target 配色：日程橙 / 待办紫 / 事件蓝 / 写入绿 |
| **课程页 + 回放下载** | `views/lms.js` 的 `lmsCourseView()` + `modules/lms/replay-download.js` | ✅ 课程页单独一屏（返回键 + 可折叠分节）；回放走录播站三步取链（lms player-url → embed-token → captures），下载先写 `.part` 再改名、进度节流广播或轮询、可取消、同视频不重复下、超时只管到响应头 |
| **学堂首页只留两张卡** | `views/lms.js` 的 `lmsPaint()` | ✅ 顶部「账号与同步」工具条与「账号状态」卡（账号 / 上次同步 / 缓存 / 服务地址 / 退出登录）整体删除，只留「自动同步」小卡 + 「课程」；未登录时给引导卡（「去设置里登录」跳设置页），登录态快照带 1s TTL，设置页登录/退出后切回来立刻重新取状态 |
| provider 注册位 | `src/server/index.js` 的 `services = { store, commands, aiBridge, hub, broadcast }` | ✅ 模块在自己的 `createServices({ services })` 里就能注册 provider |

### 还差的（按重要性）

1. **产出的 `source` 没能区分人机**：本地规则解析器写 `"command"`，模型草稿目前也走同一条
   `/commands/execute`，所以同样是 `command`。要在数据上区分「这条是模型加的」，
   可以给草稿打 `fields.source = "ai"` —— 注意这与"用户确认后才落库"并不冲突：
   人确认的是**内容**，不是**来源**。`Event` / `Schedule` 的 `source` 枚举已含 `manual / command / ai / import`。

2. **工具调用循环已经有了，但还不是原生 function calling**：模型依旧用"回复里附一段 ```command 草稿"
   来表达动作（各家 OpenAI 兼容端点对 `tools` / `role:"tool"` 的校验不一致，走文本更稳）。
   区别是现在**最多 5 轮**：每一轮都能发查询草稿，后端执行后把结果回灌、接着问，直到模型不再查新东西或到上限；
   写操作**每一轮**都会被处理（`auto` 档直接落库并出「已自动执行」回执）。
   还没做的：模型不能自己从 `aiTools` 清单里挑"调哪个 HTTP 工具"（那份清单是给外部 Agent 看的），
   也没有失败重试与并行调用。

3. **记忆（Agent 记忆）只有契约**：[接口文档 §10](docs/接口文档.md) 把数据模型、6 个接口、
   注入预算与排序、「AI 推断的记忆一律不能直接写」都定死了，`/ai/context` 的钩子也留好了
   （记忆模块只要暴露 `services.memory.inject` 就自动生效），差的只是一个模块。

4. **没有写入权限边界**：目前任何调用方都能 `POST /commands/execute` 直接落库（本机 Electron 壳下可接受）。
   真要开放 Agent，需要决定「谁能写」以及写操作是否强制先跑 `dryRun` 预览。

## 待办 / 扩展点

> 下面这些「加一个功能」的活，都按 [模块开发指南.md](docs/模块开发指南.md) 的方式做：
> 新建 `src/modules/<id>/` + `src/renderer/views/<id>.js`，不用修改 `src/core` 与外壳。

- **原生 function calling 与更多轮次**：现在是「文本草稿 + 最多 5 轮回灌」的循环（见上），
  要变成模型自己按 `aiTools` 清单挑 HTTP 工具，得先解决各兼容端点对 `tools` / `role:"tool"` 校验不一致的问题；
  顺带可以做失败重试、并行查询与每轮预算；
- **联网搜索的检索通道**：开关与状态位已经在输入框下面（校外网 / 校内网），
  真正抓取还没接 —— 校外网要一个搜索服务（Tavily / 博查 / Bing…），校内网可以复用学堂与教务的登录态；
- **会话列表 UI**：会话已经落库（`aiConversations` / `aiMessages`，设置页能看到数量、能一键清空），
  但还没有"历史对话列表 + 点开某条继续聊"的界面；`state.conversationId` 目前只活在内存里，
  重开窗口会开新会话（`GET /ai/conversations` 已经能列出历史）；
- **记忆模块**（`src/modules/memory/` + 设置页里的管理区块）：契约已定，照 [接口文档.md 第 10 节](docs/接口文档.md) 实现即可 ——
  数据模型、6 个接口、注入预算与排序、负记忆（`rejected`）与冲突 409 都写好了，`/ai/context` 会自动接上；
- 节气与农历节日扩展（节气需要真正的天文算法，别用近似表）；
- 导入 PotatoTimer 学习记录（`source: "import"` + `externalId` 去重）；
- 移动教务（jwapp）课表导入：思源学堂没有上课时间/地点，真正的「自动生成课表」需要接这一路的接口；
- 重复日程的单次例外（`exceptions` 字段）；
- ICS 导入（当前只支持导出）；
- 数据规模变大后把 JSON 存储替换为 SQLite（服务层接口不变）。
