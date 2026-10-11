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
| 测试窗口（浏览器 `/app` 或 Electron） | ✅ 已实现（Electron 运行时受宿主沙箱限制，见下） |
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

# 3) 测试（零依赖，29 个用例）
npm test
```

后端零运行时依赖（只用 Node 内置模块），因此**不装 Electron 也能完整联调接口**。

### 打开测试窗口的两种方式

**方式 A（推荐，零依赖）：浏览器打开后端托管的测试页面**

```bash
npm run start:server
open http://127.0.0.1:3210/app        # 页面与接口同源，无需额外配置
```

`/app`、`/app/app.js`、`/app/styles.css` 由后端直接托管（白名单静态文件），页面会自动使用同源地址作为 API 基址。

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
```

## 目录结构

```
calendar/
├── bin/server.js               # 独立启动后端（联调 / 自动化）
├── src/
│   ├── main/                   # Electron 主进程（main.js + preload.cjs）
│   ├── renderer/               # 测试窗口（原生 HTML/CSS/JS，无构建步骤）
│   ├── shared/                 # 前后端共享：constants.js / time.js / theme.js
│   └── server/
│       ├── index.js            # 装配：store + services + router + ws + 提醒
│       ├── http/               # 零依赖路由、WebSocket（RFC6455 文本帧子集）
│       ├── store/              # JSON 集合存储（原子写 + 逐条容错）
│       ├── services/           # 事件 / 日程 / 提醒 / 指令 / 重复规则 / 校验 / ICS / dschat2 兼容
│       ├── parser/             # 中文指令解析 + dschat2 标记行解析
│       ├── routes/             # 全部 REST 路由
│       └── ai/ai-bridge.js     # AI provider 注册与契约（占位）
├── data/                       # 运行时数据（events / schedules / command-logs）
└── test/                       # node:test 用例（解析器 + 接口 + 兼容层，29 个）
```

## 架构

```
Electron 渲染层（测试窗口：指令框 + 今日日程）
        │  HTTP + WebSocket（仅 127.0.0.1）
        ▼
Node.js 后端 ── 路由层 ── 服务层 ── JSON 存储（原子写）
                    │         └── 提醒扫描（30s，到点 WS 推送 + 系统通知）
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
8. **与 dschat 2 平滑对接**：`/compat/dschat/*` 兼容其 snake_case 字段与按标题删除；`/commands/markup` 直接吃它那套中文标记行；反向可导出 ICS。映射与差异见 [接口文档.md](接口文档.md) 第 8 节。

## 与 dschat 2 的关系（一句话版）

`dschat 2`（同工作区）是「轻量单日事件」模型：无跨天、无状态、无提醒、重复规则较弱，AI 侧靠中文标记行而非 tool schema。
本模块是更完整的日历 + 日程引擎，并**兼容**它的字段与标记行，因此可作为其日历后端的替代或补充。

## 待办 / 扩展点

- 接入 AI provider（`aiBridge.registerProvider`）实现自然语言理解；
- 农历能力（建议接 `lunar-javascript`，不要移植旧查表实现）；
- 导入 PotatoTimer 学习记录（`source: "import"` + `externalId` 去重）；
- 重复日程的单次例外（`exceptions` 字段）；
- ICS 导入（当前只支持导出）；
- 数据规模变大后把 JSON 存储替换为 SQLite（服务层接口不变）。
