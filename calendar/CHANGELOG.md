# Changelog

本文件记录 Potato Calendar（AI 智学程序 · 日历与日程模块）的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
