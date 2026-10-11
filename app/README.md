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
| `calendar` | 10 | 日历事件 + 日程（时段）+ 提醒 + 重复规则 + ICS 导出 + dschat 2 兼容 + 中文指令添加 + 顺延 | ✅ |
| `lms` | 20 | 思源学堂：统一身份认证登录、课程/作业/网课（直播 + 回放）拉取、预览后同步到日历、自动同步 | ✅ |
| `ai` | 90 | AI 接入：OpenAI 兼容 provider、多轮对话与流式、会话落库、上下文注入、模型草稿预校验（**模型不许直接写库**） | ✅ 未配密钥时自动降级到本地规则 |
| — | — | 框架级：指令记录、设置、AI 契约（`aiBridge` / `aiTools` 聚合） | ✅ |
| 学情 / 笔记系统 / 随手拍 | — | 左栏已占位（`shell/planned.js`），实现同名视图即自动接管 | 🚧 规划中 |

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

# 3) 测试（零依赖，116 个用例；含思源学堂与 AI 上游的本地 mock、农历权威向量、分类注册表与日历/待办端到端测试）
npm test
```

后端零运行时依赖（只用 Node 内置模块），因此**不装 Electron 也能完整联调接口**。

### 想用 AI 对话？（可选，不配也能跑）

AI 模块（`src/modules/ai/`）兼容任何 OpenAI 协议的端点，默认指向 DeepSeek。**不配密钥时一切照旧**：
`/ai/nl2command` 返回 501，传 `fallback: "rules"` 仍然走本地规则，`/ai/capabilities` 的 `available` 为 `false`。

```bash
export PC_AI_API_KEY=sk-…      # 或 POST /api/v1/ai/config {"apiKey":"sk-…"}（落 data/ai-config.json，0600）
npm run start:server

curl -s -X POST localhost:3210/api/v1/ai/chat -H 'Content-Type: application/json' \
  -d '{"text":"明天交实验报告，预计两小时"}'
```

接口清单与「模型只能提议、用户确认才落库」的约定见 [接口文档.md 6.4](docs/接口文档.md)。
前端中栏目前仍只走本地规则，**还没接上这套接口**（见「AI 接入还差什么」第 1 条）。

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
| 左栏（约 10% 宽） | 日历 / 待办 / 思源学堂 / 学情 / 笔记系统 / 随手拍 / 消息，底部独立「设置」 |
| 中栏 | 对话：自然语言 → **指令草稿确认卡** → 点「确认执行」才落库（可取消）；AI 未接入时由本地规则解析 |
| 右栏 | 左栏所选功能的视图，右上角 `⟩` 可收起（收起后中间变宽，周视图置灰） |

功能视图（本模块负责的部分）：

- **日历**：月视图（7×6 格子、时段色条、待办小圆点、每格农历、节日高亮、今日高亮、悬停 `+` 快捷新建）、周视图（24 小时时间轴、重叠日程自动分列、全天行放当天截止的待办标记、点空白按 30 分钟吸附新建）、日视图（Apple 风格时间轴 + 日期下方的干支农历与节日 + 「全天」行放当天截止的待办，逐条可编辑·删除）、**年视图**（4×3 迷你月、今天高亮、有内容的日期带小圆点、点月份标题进月视图、点某天进日视图，窄栏自动两列）；周视图需要右栏展开（宽度不足时自动回退月视图）。
- **农历**：1900–2100 查表换算（干支年 / 生肖 / 月日 / 闰月），节日只做农历那九个（春节、元宵、端午、七夕、中元、中秋、重阳、腊八 + 除夕），**不做节气**（节气要天文算法，近似值就是错数据）。`GET /meta/lunar` 支持单日与批量。
- **待办**：全部 / 今天 / 本周 / 逾期 / 已完成筛选，顶部快速添加，按「已逾期 / 今天到期 / 本周到期 / 未完成 / 已完成」分组，卡片显示截止日、相对日（已逾期 N 天）、优先级、复杂度色点与预估工时，支持勾选完成、顺延未完成到本周，底部显示完成率、计划时长与逾期数。
- **新建 / 编辑弹层**：待办 / 日程 / 日历事件三个页签，支持重复规则（每天 / 每周 + 星期集合 / 每月 / 每年 / 工作日 + 间隔 + 结束条件）、提醒档位、优先级、预估时长、地点、备注。
- **设置 → 日程**：日程分类与日历事件分类可自己建（名称 + 12 色板或取色器），能改名、改色、删除；编辑器选分类是**带色点的下拉**，颜色贯穿日 / 周 / 月三个视图。删除一个在用分类不会丢数据 —— 相关日程会被改成「其它」并告诉你改了几条（「其它」是兜底分类，不可删除）。
- **思源学堂**：登录 / 验证码 / 两步验证、课程列表、活动列表（页签：全部 / 作业 / **网课** / 资料；网课 = 直播 + 回放 + 在线视频，逐条仍标注具体是哪种）、同步预览与应用、自动同步设置。**网课没有独立入口** —— 它本来就来自学堂，左栏那个「网课」占位页已删；接口侧同样认 `GET /lms/activities?type=online`。
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

1. **登录**：学号 + 密码。密码用 `/cas/jwt/publicKey` 的 RSA 公钥加密后才发出，**明文密码不出本机**；若学校要求两步验证，界面会让你发短信验证码并输入；连续失败 3 次会出现图形验证码。
2. **课程 / 活动**：登录后自动拉取「我的课程」与每门课的作业、直播、回放、资料，并缓存到本地（断网也能看上次结果）。
3. **同步到日历**：点「预览同步」先看清单（新建 / 更新 / 跳过 / 失效），勾选后再点「同步选中」。
   - 作业 → **待办**（截止日；同一天两端都有明确时刻时才做成时段日程），已在学堂提交的作业直接标成「已完成」；
   - 直播 → **时段日程**（有真实起止时刻，分类「上课」）；只有日期、没有时刻的直播与回放 → **全天日历事件**；
   - 回放 / 资料默认不导入，可在选项里打开；
   - 每条记录带 `externalId = lms:activity:<活动 ID>`，**重复同步只更新不新增**，而且不会覆盖你手动改过的完成状态与提醒。

同步也可以交给后台自动做：打开「自动同步」后，服务每 30 分钟检查一次，间隔到了就按同一套规则执行
（**只新建与更新，绝不删除**），适合「作业一发布就自动出现在待办里」。默认关闭。

登录票据单独存在 `data/lms-session.json`（权限 `0600`，7 天后失效），**不保存密码**；
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
> 全部 14 项相关用例都用本地 mock 服务器跑（`test/helpers/lms-mock.js` 复刻了 CAS 登录、RSA 加密、Cookie、两步验证与失败提示），
> 因此**不需要真实账号**也能验证整条链路。

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
└── test/                       # node:test 用例（接口 / 兼容层 / 思源学堂 / 农历 / 分类 / 渲染层，100 个）
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
| 前端对话与确认卡 | `src/renderer/shell/app.js`（中栏，不属于日历视图） | ✅ 「自然语言 → 草稿确认卡 → 点确认才落库 → 可取消」，本地规则下就能用 |
| provider 注册位 | `src/server/index.js` 的 `services = { store, commands, aiBridge, hub, broadcast }` | ✅ 模块在自己的 `createServices({ services })` 里就能注册 provider |

### 还差的（按重要性）

1. **前端还没接 `/ai/chat`**：中栏对话目前仍只调 `/commands/parse`（本地规则），
   既没调 AI、也没有流式渲染与"正在输入"的增量气泡。后端接口与 WS 事件都已就绪
   （[接口文档 6.4](docs/接口文档.md)），差的是一次 renderer 侧接线 + 一个「设置 → AI」的密钥输入框。

2. **产出的 `source` 没能区分人机**：本地规则解析器写 `"command"`，模型草稿目前也走同一条
   `/commands/execute`，所以同样是 `command`。要在数据上区分「这条是模型加的」，
   可以给草稿打 `fields.source = "ai"` —— 注意这与"用户确认后才落库"并不冲突：
   人确认的是**内容**，不是**来源**。`Event` / `Schedule` 的 `source` 枚举已含 `manual / command / ai / import`。

3. **没有工具调用循环**：`aiTools` 只是一份清单，框架不会替模型执行 tool call。
   走 Agent 路线（模型自己查数据、自己决定调哪个工具）需要实现「模型 → 调工具 → 回灌结果」的循环，
   工具落点就是清单里那些已实现的 HTTP 接口。建议只读工具先放开，写操作仍走草稿确认。

4. **记忆（Agent 记忆）只有契约**：[接口文档 §10](docs/接口文档.md) 把数据模型、6 个接口、
   注入预算与排序、「AI 推断的记忆一律不能直接写」都定死了，`/ai/context` 的钩子也留好了
   （记忆模块只要暴露 `services.memory.inject` 就自动生效），差的只是一个模块。

5. **没有写入权限边界**：目前任何调用方都能 `POST /commands/execute` 直接落库（本机 Electron 壳下可接受）。
   真要开放 Agent，需要决定「谁能写」以及写操作是否强制先跑 `dryRun` 预览。

6. **没有写入权限边界**：目前任何调用方都能 `POST /commands/execute` 直接落库（本机 Electron 壳下可接受）。
   真要开放 Agent，需要决定「谁能写」以及写操作是否强制先跑 `dryRun` 预览。

## 待办 / 扩展点

> 下面这些「加一个功能」的活，都按 [模块开发指南.md](docs/模块开发指南.md) 的方式做：
> 新建 `src/modules/<id>/` + `src/renderer/views/<id>.js`，不用修改 `src/core` 与外壳。

- **前端接上 AI 对话**：中栏改调 `POST /ai/chat`，订阅 WebSocket 的 `ai_delta` 做流式气泡，
  并在「设置 → AI」加一个密钥输入框（走 `POST /ai/config`，密钥永不回显）—— 后端已经全部就绪；
- **工具调用循环**（让模型自己查数据）：在 `modules/ai/` 里实现「模型 → 调工具 → 回灌结果」，
  工具落点就是 `aiTools` 清单里的 HTTP 接口；建议只读先放开，写操作仍走草稿确认；
- **记忆模块**（`src/modules/memory/` + 设置页里的管理区块）：契约已定，照 [接口文档.md 第 10 节](docs/接口文档.md) 实现即可 ——
  数据模型、6 个接口、注入预算与排序、负记忆（`rejected`）与冲突 409 都写好了，`/ai/context` 会自动接上；
- 节气与农历节日扩展（节气需要真正的天文算法，别用近似表）；
- 导入 PotatoTimer 学习记录（`source: "import"` + `externalId` 去重）；
- 移动教务（jwapp）课表导入：思源学堂没有上课时间/地点，真正的「自动生成课表」需要接这一路的接口；
- 重复日程的单次例外（`exceptions` 字段）；
- ICS 导入（当前只支持导出）；
- 数据规模变大后把 JSON 存储替换为 SQLite（服务层接口不变）。
