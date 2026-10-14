# 多端同步（`sync` 模块）

同一个账号的多台设备（**桌面 ↔ 服务器 ↔ 手机**）保持数据一致。

- 模块 id `sync`，`order = 89`（在 `account`(88) 之后、`ai`(90) 之前）
- **不提供任何 AI 工具 / 查询**（没有 `aiTools` / `aiPrompt` / `aiQueryFields` / `commands`）：
  同步是"用户自己的数据在自己设备之间流动"，与模型无关
- **不声明任何业务集合**：设备身份、开关、游标、幂等账本都在模块私有文件里（0600）
- 零 npm 依赖、ESM；合并口径复用「局域网直传」（`../transfer/`）那套已经验过的规则

## 为什么不需要另写服务端

服务端版（`server` 分支 `src/www/**`）在登录后把 `/api/v1/**` 与 `/ws` 反代到**该账号自己的**
后端实例，数据在 `data-www/users/<id>/`。也就是说"服务器上的数据"就是**另一台跑着同一套模块的后端**。
于是同步做成**模块路由**就同时适用于本地与服务器：

```
桌面端 A ──┐                                  ┌── 桌面端 B
           ├─► POST /api/v1/sync/push|pull ──► │  （同一套 sync 模块）
手机 App ──┘   Authorization: Bearer <令牌>     └── 服务端版每用户实例
```

## 文件

| 文件 | 干什么 |
| --- | --- |
| `module.js` | 模块描述符（order 89、无 AI 能力、私有文件） |
| `catalog.js` | **同步范围**：哪些集合、怎么读、怎么写、能不能同步删除、"同名"判定 |
| `merge.js` | **合并口径**（纯函数）：`planMerge` 决策表、冲突副本 id、内容指纹、脱敏 |
| `runtime.js` | 运行环境判定（网页版 / 原生客户端 / 未知），纯函数 |
| `client.js` | 桌面端 → 服务器的 HTTP（Bearer、超时、错误码翻译） |
| `service.js` | 状态、开关、账本、服务端侧 push/pull、桌面端侧一站式 `run` |
| `routes.js` | 六条路由（见下） |
| `private-file.js` | 0600 私有 JSON 文件（原子替换 + 写入串行化） |

私有文件（都在 `data/` 下，权限 **0600**）：

- `sync-state.json` —— `{deviceId, deviceName, lastPullAt, lastPushAt, cursor, syncSecrets, lastError, lastReceivedAt, lastServedAt}`
- `sync-ledger.json` —— 幂等账本：`<对端>|<集合>|<id>` → 最近几版的内容指纹；
  以及跨设备的**版本索引** `<集合>|<id>` → 这条记录在本机历史上出现过的所有指纹
  （识别"陈旧推送"用，见下文）

## 接口（冻结）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sync/status` | `{deviceId, deviceName, lastPullAt, lastPushAt, lastError, collections: {<name>: {count, maxUpdatedAt}}}`（+ `cursor` / `syncSecrets` / `runtime` / `account` / `deleteSync`） |
| POST | `/sync/pull` | `{deviceId, since}` → `{serverTime, collections: {<name>: [items]}, deleted: {<name>: [ids]}}`（+ `nextSince` / `truncated` / `errors`） |
| POST | `/sync/push` | `{deviceId, deviceName, collections, deleted}` → `{accepted, skipped, renamed, groups: {<name>: {...}}, duplicates: [...], conflicts: [...], serverTime}` |
| POST | `/sync/run` | `{serverUrl?}` → **一站式**：读本地 → push → pull → 就地合并，返回人话报告 `{pushed, pulled, skipped, renamed, duplicates, conflicts, durationMs, at}` |
| GET | `/sync/settings` | `{deviceId, deviceName, syncSecrets: {aiConfig, lms}}` |
| POST | `/sync/settings` | `{syncSecrets: {aiConfig, lms}}` → 200 回同样结构 |

⚠️ `run` 报告里的 `skipped` 一个字段两种语义（接口冻结，只能靠类型区分）：
**数字** = "跳过多少条"；**`true`（布尔）** = 这一轮根本没跑（`reason: 'no_server' | 'no_account' | 'bad_server'`）。
前端判断"没跑"必须写 `report.skipped === true`。

## 同步范围

会同步（11 个集合）：`notes`、`todos`、`schedules`、`events`、`cards`（含复习进度）、`goals`、
`memories`、`ai-conversations`、`ai-messages`、`ai-schedules`、`ai-config`（★敏感）。

**不**同步（以及为什么）：

| 不同步 | 原因 |
| --- | --- |
| `academic-*`（成绩、学业元信息） | 成绩隐私最重；它是教务系统拉下来的**只读投影**，不参与跨设备搬运 |
| `lms-*`（学堂课程/活动/元信息） | 学堂数据在服务端版根本不可用（宿主明确 403）；且它是"从学校拉下来的投影"，不是用户自己的编辑 |
| `ai-usage`（后台调用用量账本） | 每台设备各自花掉的 token 是**本机事实**，合并起来只会得到一个谁也解释不通的数字 |
| `commandLogs`、传输日志 | 运行日志，不是用户数据 |
| `account.json`（账号令牌） | 令牌属于"这台设备与那台服务器之间的会话"，不该被复制到别的设备上 |
| `ai-files`、`note-versions` 等派生数据 | 派生/缓存，能重建；同步它们只会放大体积 |

敏感数据（**默认不同步**，只能在**非网页客户端**里逐台勾选）：

- `ai-config`（含 API key）—— 开关 `syncSecrets.aiConfig`
- `lms-credentials`（`data/auth-session.json`，0600）—— 开关 `syncSecrets.lms`
  - 实际文件是 **`auth-session.json`**：学堂与教务共用同一个学校票据（CAS/Keycloak SSO），
    老的 `lms-session.json` 已被 auth 模块迁移并删除；
  - 程序**从不保存密码明文**（密码只在登录那一刻用一次），所以这里同步的是**登录后的会话票据**；
  - 服务端版**只存储不使用**（服务端的每用户实例连 `lms` 模块都不加载，`/api/v1/lms/**` 一律 403）。

## 合并口径（与局域网直传同一套）

- **绝不"谁后写谁赢"**：整套决策里没有一次时间比较；
- 同 id 同内容 → 跳过（幂等）；
- 同 id 内容不同 → **两条都留**：本机保留原 id，来的一条存成确定性的副本 id
  `<id>-h<内容指纹前 8 位>`，冲突记进 `conflicts`（带 `origin` 设备名与 alias）；
- 不同 id 同名 → 两条都留 + 进 `duplicates`（"疑似重复"清单）；
- 唯一允许"就地覆盖"的分支是：**账本能证明**"本机这一版就是对面之前正式采纳过的那一版"
  （对面在更新它自己的记录）。证明不了就一律走"两条都留"；
- **陈旧推送**（离线很久的设备推上来一个本机早就有的旧版本）→ 跳过。
  没有这一条，一台落后两个版本的设备推一次就会生成一份**带着旧内容**的副本 ——
  等于把用户刚删掉/刚改掉的东西又"复活"一份。区分"陈旧推送"与"主动改回旧版本"
  靠的是"对面见过本机当前版本没有"。

与局域网直传**刻意不同**的两点：

1. **保留 id**：直传是单向导入（本地 id 由模块自己生成 + 账本映射）；同步两侧互相推，
   必须收敛到同一个 id，否则同一条笔记会在两台设备上各长一份、越同步越多；
2. **搬复习进度**：直传刻意不搬卡片的 `due`/`ease`/`reps`（那是"我复习到哪了"，导入到别人机器上
   会悄悄改掉对方的复习计划）；同步搬 —— 同一账号的同一张卡，进度本来就该一致。

## 删除同步的支持范围

| 集合 | 支持情况 | 说明 |
| --- | --- | --- |
| `notes` | ✅ 软删除随记录同步 | 回收站（`deletedAt`）是记录上的字段，跟着记录一起走：A 删掉 → B 的列表里也消失、进回收站；从回收站恢复同理 |
| 其余全部 | ❌ 不支持 | 它们的删除是**硬删除**（记录直接消失），本机无法区分"被删了"与"从未同步过"；口径明确**不为它们发明墓碑字段**（不去改别的模块的删除语义）。后果：A 上删掉的待办/日程，会在下一次同步时从 B 那边"回来" |

接口里的 `deleted: {<集合>: [id]}` 仍然保留并处理：对 `notes` 会走 notes 模块自己的软删除入口；
对其余集合**如实拒绝**并在报告 `unsupportedDeletes` 里说明原因。桌面端自己**不产生墓碑**
（它无法可靠地识别硬删除），所以服务端 pull 回来的 `deleted` 目前恒为 `{}`。

## 触发时机

1. **手动**：设置 → 多端同步 → 「立即同步」（`POST /sync/run`）；
2. **启动后自动一次**：装配层 `start()` 里跑一次，**失败静默**（没登录 / 连不上 / 令牌过期
   都在预期内），原因记在 `lastError` 里，只在面板上显示。

`/sync/run` 的顺序是 **读本地 → push → pull（到内存）→ 校验 → 逐集合合并落盘**：

- push 在前：先让远端拿到本机的新数据，pull 回来的增量里才会带上"远端为这次冲突生成的副本"；
- pull 到内存再校验再落盘：远端不可达 / 401 / 响应畸形时，**本地业务数据一个字节都不改**；
- 逐集合隔离失败：某个集合出错只记这一条 `error`，其余照常合并；
- 令牌只出现在 `Authorization: Bearer` 头里，不进 URL、不进报告、不进状态文件、不进日志。

## 已知取舍

- **push 每次发全量**（服务端按内容指纹跳过）：换来的好处是"状态文件丢了也不会漏推"，
  代价是大集合（几万条消息）每轮都要序列化一遍；请求体按 2 MB 分片（复用直传的 `buildChunks`），
  不会撞上主服务 12 MB 的请求体上限；
- **单次 pull 每个集合最多回 2000 条**（`PULL_MAX_ITEMS`），截断时游标只推进到
  "所有被截断的集合都送到过的时间点"，剩下的下一轮继续；
- **`createdAt` 由接收侧按落库时间写**（JsonStore 的既有口径）：记录内容与 id 都保留，
  但首次同步大量历史数据时，本机的"创建时间"会挤在一起；
- **网页版不给敏感数据开关**（后端 403 兜底）：判定见 `runtime.js`，探测失败时按原生处理并如实标注；
- **并发**：同一进程内同一时刻只允许一轮 `run`（后到的直接复用前一轮结果）；多进程同时同步
  同一份数据目录不在支持范围内（JsonStore 本身也没有跨进程锁）。
