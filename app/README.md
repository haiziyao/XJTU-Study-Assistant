# Potato Calendar · 日历与日程模块

> **AI 智学程序**的一个子模块：把**日历（日期粒度）**与**日程（时段粒度）**统一管理，支持**指令添加**。
> 后端 Node.js，前端 Electron（**当前窗口仅用于联调测试，正式 UI 由主程序提供**）；AI 能力本阶段**只留接口**。

- 接口契约见 [接口文档.md](接口文档.md)
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)
- 参考实现：同工作区 `../potatocalendar`（Python/PySide6 版）与 `../dschat 2`

## 状态

| 能力 | 状态 |
| --- | --- |
| 日历事件 CRUD + 区间/重复展开 | ✅ 已实现 |
| 日程 CRUD + 状态流转 + 冲突提示 | ✅ 已实现 |
| 提醒（WebSocket 推送 + 系统通知） | ✅ 已实现 |
| 指令添加（中文规则解析 → 落库） | ✅ 已实现 |
| 顺延未完成日程到本周 | ✅ 已实现 |
| 聚合视图接口（日/周/月/年通用） | ✅ 已实现 |
| ICS 导出（可订阅到系统日历） | ✅ 已实现 |
| dschat 2 兼容（字段别名 / 标记行 / 兼容接口） | ✅ 已实现 |
| 思源学堂接入（CAS 登录 / 课程 / 作业 / 直播 → 同步到日历） | ✅ 已实现（见下文，第 9 节接口见 [接口文档.md](接口文档.md)） |
| 测试窗口（浏览器 `/app` 或 Electron） | ✅ 已实现（三栏界面：功能栏 / 对话 / 功能视图） |
| AI 接入（NL → 指令对象） | 🚧 仅契约与占位（`/ai/*`） |
| 农历 / 学习记录导入 | 🚧 仅契约 |

## 快速开始

```bash
cd calendar

# 1) 只跑后端（接口联调推荐，零运行时依赖）
npm run start:server          # http://127.0.0.1:3210/api/v1
npm run dev:server            # 带 --watch 自动重启

# 2) 跑 Electron 测试窗口（需先装依赖）
npm install                   # electron 为 devDependency
npm run dev:app

# 3) 测试（零依赖，44 个用例；含思源学堂的本地 mock 端到端测试）
npm test
```

后端零运行时依赖（只用 Node 内置模块），因此**不装 Electron 也能完整联调接口**。

### 打开测试窗口的两种方式

**方式 A（推荐，零依赖）：浏览器打开后端托管的测试页面**

```bash
npm run start:server
open http://127.0.0.1:3210/app        # 页面与接口同源，无需额外配置
```

`/app`、`/app/app.js`、`/app/views.js`、`/app/styles.css` 由后端直接托管（白名单静态文件），页面会自动使用同源地址作为 API 基址。
访问 `/app`（无尾斜杠）会 302 到 `/app/`：页面内的资源都是相对路径，否则浏览器会以 `/` 为基准解析导致整页无样式无脚本。

**方式 B：Electron 测试窗口**

```bash
npm install
npm run dev:app            # 常规环境（直接 electron .）
npm run dev:app:macos      # 沙箱环境 / 需要 LaunchServices 启动时（见下）
```

`npm run dev:app:macos` 会做三件事：把 Electron 运行时复制到工作区内的 `.electron-bundle/`（首次约 130MB）、
把 `package.json + src` 同步进 `ElectronTest.app/Contents/Resources/app`、写入 `data-dir.txt` 让窗口与项目
**共用同一份数据**（`calendar/data`），最后用 `open -n` 启动。日志与数据位置会在启动后打印出来。

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

主进程刻意使用 CommonJS（`src/main/main.cjs`）：在 ESM 下 `import ... from 'electron'` 会被 Node 解析到
node_modules 里的 npm 包（导出二进制路径字符串），拿不到 `app`/`BrowserWindow`；需要 ESM 模块时用动态 `import()`。

### 测试窗口界面

三栏布局，无框架、无构建步骤（原生 HTML/CSS/JS）：

| 区域 | 内容 |
| --- | --- |
| 左栏（约 10% 宽） | 日历 / 待办 / 学情 / 拍题 / 网课 / 消息，底部独立「设置」 |
| 中栏 | 对话：自然语言 → **指令草稿确认卡** → 点「确认执行」才落库（可取消）；AI 未接入时由本地规则解析 |
| 右栏 | 左栏所选功能的视图，右上角 `⟩` 可收起（收起后中间变宽，周视图置灰） |

功能视图（本模块负责的部分）：

- **日历**：月视图（7×6 格子、分类色条、今日高亮、悬停 `+` 快捷新建）、周视图（24 小时时间轴、重叠日程自动分列、点空白按 30 分钟吸附新建）、日视图（全天 / 时段分段，逐条可完成·取消·编辑·删除）；周视图需要右栏展开（宽度不足时自动回退月视图）。
- **待办**：全部 / 今天 / 本周 / 逾期 / 已完成筛选，顶部快速添加（不填时间即全天待办），按日期分组并标注「今天 / 已逾期 N 天」，支持勾选完成、顺延未完成到本周，底部显示本周完成率与计划时长。
- **新建 / 编辑弹层**：日程与日历事件两个页签，支持重复规则（每天 / 每周 + 星期集合 / 每月 / 每年 / 工作日 + 间隔 + 结束条件）、提醒档位、优先级、预估时长、地点、备注。
- 学情 / 拍题 / 网课为**占位页**（说明各自的数据挂载点，能力属于 AI 智学主程序）。

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
   - 作业 → **日程**（截止日；同一天有明确起止时刻则做成时段块）；
   - 直播 → **日程**（真实起止时刻，分类「上课」）；
   - 回放 / 资料默认不导入，可在选项里打开；
   - 每条记录带 `externalId = lms:activity:<活动 ID>`，**重复同步只更新不新增**，而且不会覆盖你手动改过的状态与提醒。

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
calendar/
├── bin/server.js               # 独立启动后端（联调 / 自动化）
├── src/
│   ├── main/                   # Electron 主进程（main.cjs + preload.cjs）
│   ├── renderer/               # 测试窗口：index.html + styles.css + app.js（外壳/对话）+ views.js（视图）
│   ├── shared/                 # 前后端共享：constants.js / time.js / theme.js
│   └── server/
│       ├── index.js            # 装配：store + services + router + ws + 提醒
│       ├── http/               # 零依赖路由、WebSocket（RFC6455 文本帧子集）
│       ├── store/              # JSON 集合存储（原子写 + 逐条容错）
│       ├── services/           # 事件 / 日程 / 提醒 / 指令 / 重复规则 / 校验 / ICS / dschat2 兼容
│       ├── parser/             # 中文指令解析 + dschat2 标记行解析
│       ├── routes/             # 全部 REST 路由（含 lms.js 思源学堂路由）
│       ├── lms/                # 思源学堂接入（CAS 登录 / API 归一化 / 同步映射 / 工具清单）
│       └── ai/ai-bridge.js     # AI provider 注册与契约（占位）
├── data/                       # 运行时数据（events / schedules / command-logs / lms-*）
├── scripts/                    # run-electron-macos.sh（沙箱启动）+ seed-demo.js（演示数据）
└── test/                       # node:test 用例（解析器 + 接口 + 兼容层 + 思源学堂，44 个）
```

## 架构

```
Electron 渲染层（测试窗口：左功能栏 + 中对话 + 右功能视图）
        │  HTTP + WebSocket（仅 127.0.0.1）
        ▼
Node.js 后端 ── 路由层 ── 服务层 ── JSON 存储（原子写）
                    │         ├── 提醒扫描（30s，到点 WS 推送 + 系统通知）
                    │         └── 思源学堂客户端（CAS 登录 + 课程/活动缓存 + 同步计划）
                    └── 指令解析器（规则版）／AI Bridge（待接入模型）
```

主进程会在同进程内启动后端（端口被占用时自动递增），并通过 IPC 把实际地址与主题令牌交给渲染层；
渲染层不接触 Node API（`contextIsolation: true`、`nodeIntegration: false`）。

## 设计要点

1. **双粒度建模**：`Event` 管日期/区间（假期、考试周、截止日），`Schedule` 管时段（上课、会议、自习）；`Schedule.allDay` 退化为日期锚点，等价于待办。
2. **指令与 AI 同构**：本地规则解析器与未来的大模型产出**同一种指令对象**（`action / target / fields / filters / confidence / warnings`），落库逻辑只写一遍。
3. **AI 只负责理解**：provider 返回 draft，不直接写库；校验与业务规则仍在服务层，避免模型产出脏数据。
4. **数据安全**：写入走临时文件 + rename；单文件损坏先备份再启动，不做静默清空（修正 PotatoCalendar 的数据丢失级缺陷）。
5. **顺延可追溯**：顺延引入 `rolled` 状态与 `rolledFrom / rolledTo` 双向引用，不再把「被顺延」当作「已完成」。
6. **结构化重复**：支持间隔、星期集合、结束条件（日期/次数），并修正「31 号在 2 月消失」等问题。
7. **零依赖后端**：只用 Node 内置模块，测试与联调不依赖网络安装；Electron 仅作为可选的前端壳。
8. **外部系统只读接入**：思源学堂走「登录 → 拉取 → 预览 → 应用」四步，写库前一定先给用户看清单；每条记录带 `externalId`，重复同步只更新不新增，且不会回滚用户手改的状态。
9. **与 dschat 2 平滑对接**：`/compat/dschat/*` 兼容其 snake_case 字段与按标题删除；`/commands/markup` 直接吃它那套中文标记行；反向可导出 ICS。映射与差异见 [接口文档.md](接口文档.md) 第 8 节。

## 与 dschat 2 的关系（一句话版）

`dschat 2`（同工作区）是「轻量单日事件」模型：无跨天、无状态、无提醒、重复规则较弱，AI 侧靠中文标记行而非 tool schema。
本模块是更完整的日历 + 日程引擎，并**兼容**它的字段与标记行，因此可作为其日历后端的替代或补充。

## 待办 / 扩展点

- 接入 AI provider（`aiBridge.registerProvider`）实现自然语言理解；
- 农历能力（建议接 `lunar-javascript`，不要移植旧查表实现）；
- 导入 PotatoTimer 学习记录（`source: "import"` + `externalId` 去重）；
- 移动教务（jwapp）课表导入：思源学堂没有上课时间/地点，真正的「自动生成课表」需要接这一路的接口；
- 重复日程的单次例外（`exceptions` 字段）；
- ICS 导入（当前只支持导出）；
- 数据规模变大后把 JSON 存储替换为 SQLite（服务层接口不变）。
