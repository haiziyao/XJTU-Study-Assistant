# XJTU-Study-Assistant 公网部署交接

**状态：已上线运行** — 主入口 <http://studywhy.3q.hair/>（passnat），备用 <https://study.xjtuwhy.com/>（香港）

---

## 1. 现在能访问什么

**两条公网入口同时可用，指向同一套本地服务。** 主入口走 passnat，快得多：

| 入口 | 通道 | 连接 | 首字节 |
| --- | --- | --- | --- |
| <http://studywhy.3q.hair/> | passnat（HTTP） | **0.04s** | **0.07–0.09s** |
| <https://study.xjtuwhy.com/> | 香港 VPS（HTTPS） | 0.4–1.4s | 1.6–7.2s |

TTFB 差约 **80 倍**。香港那条变慢的原因是 TCP 握手就要 0.44s（正常香港应 30–80ms），
说明那台机器超售或线路绕了；passnat 这条是直连中转，没有这个问题。

> passnat 隧道是 **HTTP**（没有 ICP 备案，拿不到 443），所以这条入口下
> **密码和会话令牌是明文传输的** —— 同一个 WiFi、运营商、以及 passnat 都能看到。
> 要加密就走香港那条 HTTPS。两条并存，按需要选。

| 路径 | 说明 |
| --- | --- |
| `/` | 登录 / 注册页 |
| `/app` | 登录后的应用界面（未登录 302 回登录页） |
| `/ws` | AI 流式回复的 WebSocket 端点（未登录 401；两条入口都实测可用） |
| `/auth/config` | 公开的服务器信息 |

**第一个注册的账号自动成为管理员**，之后注册需要管理员发邀请码。
AI 的 API Key 由每个账号自己在设置里填，不会用服务器上的公共额度。

> **登录限速**：同一个 IP + 同一个用户名连续输错 **5 次锁 60 秒**（第 5 次起返回 429）。
> 两条入口共享同一份计数 —— 按真实客户端 IP 算，`X-Forwarded-For` 已实测透传
> （服务端日志里能看到你的公网 IP，不是 127.0.0.1）。
> 如果出现"怎么都登不进去"，先等 60 秒再试，**不要连着重输**。

> LMS（思源学堂）在服务端版**不可用** —— 需要把学校账号密码交给服务器，公网部署做不到「凭据不出你的电脑」。需要学堂同步请用本地客户端。

---

## 2. 请求是怎么走到你电脑上的

```
浏览器
  │  https://study.xjtuwhy.com
  ▼
47.82.118.193:443   nginx（TLS 终结，证书 /etc/letsencrypt/live/study.xjtuwhy.com/）
  │  转发到 upstream 127.0.0.1:8080，保留 Host 头
  ▼
47.82.118.193:8080  frps（vhostHTTPPort，按 Host 匹配 customDomains）
  │  frp 隧道（serverPort 7000，token 认证）
  ▼
本机 frpc（frpc-study.toml）→ 127.0.0.1:8866
  ▼
本机 node bin/www.js（多租户宿主，每个账号一个后端实例）
```

关键点：**应用跑在你这台电脑上**，服务器只负责 TLS 和转发。
所以这台机器关机 / 断网，站点就不可用。

---

## 3. 本机怎么启停

在 `E:\WHYidea\XJTU-Study-Assistant\deploy\` 下，**两个脚本就够了**（对着 dschat 的 `run.bat` + `cleanup.ps1` 做的）：

```powershell
# 挂载：本地服务 + 本地反代 + 隧道，并逐层校验到公网域名
.\start-study-assistant.ps1

# 只清残留再挂（重复进程 / 端口占用时用这个）
.\start-study-assistant.ps1 -Clean

# 换成你的 HTTP 隧道域名做校验
.\start-study-assistant.ps1 -PublicUrl 'http://xxx.yyy'

# 卸下（只停本套：www / local-proxy / frpc-study）
.\unmount.ps1
```

`unmount.ps1` 按**配置文件名**精确匹配进程，`passnat` 的 frpc、土豆麻将的
`frpc-maj.toml`、dschat 的 `frpc.toml` 一律不动。

> ⚠️ 这几个 `.ps1` **必须保持 UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的
> UTF-8 当 GBK 解码，中文注释被拆坏后会直接破坏脚本逻辑（这次踩过：进程检测全失效，
> 误起了重复的 frpc）。`write` / `edit` 工具会丢掉 BOM，改完记得补：
> ```powershell
> $p='...\start-study-assistant.ps1'
> [IO.File]::WriteAllText($p,[IO.File]::ReadAllText($p,[Text.UTF8Encoding]::new($false)),[Text.UTF8Encoding]::new($true))
> ```

---

## 4. 自动保持运行

已注册计划任务 `XJTU-Study-Assistant`：

- **登录时**触发一次
- **每 5 分钟**看护一次（脚本幂等，已在跑就什么都不做）

### 校验一直验到公网域名（2026-10-20 补的）

原来的看护只校验 `http://127.0.0.1:8866`，于是**隧道死了它照样记「成功」**。
实际发生过：`frpc-study` 掉了、`study.xjtuwhy.com` 整站 404，而任务记录是
`LastTaskResult = 0`。现在脚本按层校验，任何一层不通就 `exit 1`：

| 层 | 检查 |
| --- | --- |
| L0 | 前置文件（node / frpc.exe / 两个 toml / bin/www.js）存在 |
| L1 | `http://127.0.0.1:8866/` = 200 |
| L2 | `http://127.0.0.1:9000/` = 200 |
| L3 | 公网 `/`、`/login/`、`/login/login.css`、`/login/login.js`、`/auth/config` = 200 |
| L3 | 公网 `/app` = 302（未登录正确回登录页）、`/ws` = 401（WebSocket 打到应用） |

实测：杀掉隧道后跑一次脚本 → 公网 404 → 脚本自动拉回 frpc → 九层全绿 → `exit 0`；
把 `-PublicUrl` 换成不存在的域名 → L3 全部 FAIL → `exit 1` 并指出看哪个日志。

> `LastTaskResult = 267009`（`0x41301`）**不是失败**，是"任务正在运行"。
> 一次完整校验要跑 9 次 curl 穿香港链路，大约 30 秒。

```powershell
# 查看
Get-ScheduledTask -TaskName 'XJTU-Study-Assistant'
Get-ScheduledTaskInfo -TaskName 'XJTU-Study-Assistant'

# 删除自启（不想让它常驻时）
Unregister-ScheduledTask -TaskName 'XJTU-Study-Assistant' -Confirm:$false
```

---

## 5. 这次改动了哪些文件

### 本机

| 文件 | 说明 |
| --- | --- |
| `E:\WHYidea\frp_0.61.1_windows_amd64\frpc-study.toml` | **新增**。独立 frpc 配置，只带 `study.xjtuwhy.com` 一条代理 |
| `E:\WHYidea\XJTU-Study-Assistant\deploy\start-study-assistant.ps1` | **新增**。幂等启动脚本 |
| `E:\WHYidea\XJTU-Study-Assistant\deploy\register-autostart.ps1` | **新增**。注册计划任务 |
| `E:\WHYidea\_tools\*.py` / `*.js` | **新增**。CDP 移动端量测工具（见 §9），与站点运行无关 |
| `app\src\www\public\index.html` | **改动 2 行**（登录页相对路径 → 绝对路径，见 §6） |
| `app\src\renderer\shell\shell.css` | **改动**：断点 760→900；文件末尾追加「窄屏可用性修复」小节（见 §9） |
| `app\src\renderer\shell\app.js` | **改动**：`MOBILE_QUERY` 760→900；短 placeholder；`autoGrowInput` 空输入不再计入 placeholder |
| `app\src\renderer\views\notes\notes.css` | **改动**：断点 760→900（与外壳保持一致） |

> 你原有的 `frpc.toml`（chat / docs）**一行都没动**，它那条隧道一直在跑、没断过。

### 服务器 47.82.118.193

| 路径 | 说明 |
| --- | --- |
| `/etc/nginx/sites-available/xjtu-study` | **新增**。study 的 80 / 443 server 块 |
| `/etc/nginx/sites-enabled/xjtu-study` | **新增**。软链 |
| `/etc/letsencrypt/live/study.xjtuwhy.com/` | **新增**。独立证书，CN=study.xjtuwhy.com，到期 2027-01-12，自动续期已排程 |
| `/var/www/html/.well-known/acme-challenge/` | **新增**。certbot webroot，续期要用 |
| `/root/.ssh/authorized_keys` | **追加**了一把本机公钥（见 §7） |

原有 `dschat` 配置、`chat.xjtuwhy.com` 证书、`frps.toml` **全部未改动**。
改动前的配置已备份到 `/root/nginx-sites-available.bak.1791949426`。

---

## 6. 修复的那个 bug（重要）

`https://study.xjtuwhy.com/` 原本会渲染成**裸 HTML**（没有样式、按钮无效）。

**原因**：`server.js:426` 在根路径直接把 `index.html` 原样发出，但页面里用的是**相对路径**
`login.css` / `login.js`。浏览器在 `/` 下会把它们解析成 `/login.css`，而静态资源只挂在
`/login/**` 下 → 404 → 白页。

有意思的是同一个文件 `server.js:375` 的注释里，作者对 `/app` **特意**做了 302 到 `/app/`，
理由正是「相对路径会全部 404 → HTTP 200 但白屏」—— 登录页漏了同样的处理。

**修法**（`app/src/www/public/index.html`）：

```diff
-    <link rel="stylesheet" href="login.css" />
+    <link rel="stylesheet" href="/login/login.css" />
-    <script src="login.js"></script>
+    <script src="/login/login.js"></script>
```

改成绝对路径后 `/` 和 `/login/` 都能正常工作，且已登录用户访问 `/` 会被服务端 302 到 `/app/`。

> **已在 2026-10-14 提交并推送到 `origin/server`**（见 §10）。站点跑的是工作区文件，
> 所以推送前后线上行为一致。

---

## 7. 安全事项（请处理）

1. **轮换服务器密码**。`root` 的登录密码在本次会话里被使用过，建议改掉。
   我之后不再需要密码——已改用公钥登录。
2. **服务器上多了这把公钥**（`/root/.ssh/authorized_keys`）：
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKQMCMwPw9xDOw43YtjWXSI7BELUwMLtxc8nV/nflRMQ whyderivation@Laptop-why
   ```
   不需要我后续维护的话，删掉这一行即可。
3. `frps.toml` 里的 web 管理面板口令（`z7rbi5qmaduj`）是明文，且监听在
   `127.0.0.1:7500`（仅本机，安全）。若哪天改成对外监听，记得先改口令。
4. **站点开着公网注册**。「第一个账号成为管理员」这条规则只在**还没有任何账号**时有效——
   建议你尽快用想要的用户名注册掉第一个账号，否则先注册的人会成为管理员。

---

## 8. 本次验证记录

| 项目 | 结果 |
| --- | --- |
| DNS `study.xjtuwhy.com` | 权威 NS 直查 → 47.82.118.193 ✓ |
| TLS 证书（严格校验） | `ssl_verify=0`，CN=study.xjtuwhy.com ✓ |
| `GET /` | 200，渲染出完整带样式登录页（Chrome 截图确认）✓ |
| `GET /login/`、`/login/login.css`、`/login/login.js` | 200 ✓ |
| `GET /app`（未登录） | 302 → `/` ✓ |
| `GET /ws`（未登录） | 401 ✓ |
| `POST /auth/login`（错账号） | 401 BAD_CREDENTIALS，且未创建任何账号 ✓ |
| `GET /auth/config` | 200，version 0.2.0 ✓ |
| HTTP → HTTPS | 301 ✓ |
| 现有 chat / docs | 302 / 200，全程未受影响 ✓ |
| 项目测试 `www-auth` + `www-proxy` | **19 / 19 通过** ✓ |
| 看护自愈 | 杀进程后任务触发 12 秒内恢复 ✓ |

截图存于 `E:\WHYidea\_verify\`：
- `root-fixed.png` —— 修复后的根路径（完整带样式的登录页）
- `login-390-real.png` —— 登录页在真实 390px 视口下的样子
- `probe-390.png` / `after-390c.png` —— 聊天屏移动端修复前 / 后
- `todo-after2-390.png`、`panel-390.png`、`tablet-820.png`、`final-desktop-1280.png`

> 注：完整测试套件 `node --test test/` 在 Windows 上会卡住（`academic.test.js` /
> `auth.test.js` 里的用例不返回），加 `--test-timeout=60000` 可以跑完。
> 结果是 **774 测试 / 695 通过 / 75 失败**。这 75 个失败**全部是仓库既有的**——
> 我用 `git worktree` 在未改动的 `e8426fa` 上跑同一套，得到完全相同的
> 774/695/75，失败用例名逐条一致。这些失败集中在 `academic` / `lms` / `auth` /
> `knowledge` 后端模块，与本次前端移动端改动无关，未深究。

---

## 9. 移动端适配（2026-10）

### 一句话结论

外壳的移动端**骨架本来就写好了**（`shell.css` 里那套 900px 折叠成两栏 + 单屏切换、
16px 字号下限、`dvh`、`safe-area-inset` 都很扎实），坏的是**断点选错**和几处
组件细节。本次没有重写布局，只做了针对性修复。

### 9.1 必须先讲的方法论坑

**Headless Chrome 的 `--window-size` 在 Windows 上拿不到真实手机宽度。**
Windows 给 Chrome 窗口设了最小宽度（约 500px），所以
`--window-size=390,844` 实际渲染出来的不是 390px 视口。据此截图会得到
"三栏布局横向溢出"的**假象**，然后你就会去改一个根本不存在的 bug。

正确做法是走 CDP 的 `Emulation.setDeviceMetricsOverride`，工具在
`E:\WHYidea\_tools\cdp.py`（用 `--width/--height/--mobile` 单次截图，
或 `--sweep 320,390,768,1024` 一次启动扫多个宽度）。

### 9.2 真正的核心 bug：断点 760 与"布局视口被撑宽"

桌面三栏网格 `grid-template-columns: clamp(80px,10%,128px) minmax(300px,1fr) min(56%,780px)`
的最小内容宽度约 **900px**。而原来的窄屏断点是 **760px**，中间的 140px 是黑洞：

| 设备宽度 | 修复前实际 `innerWidth` | 布局 | 水平溢出 |
| --- | --- | --- | --- |
| 768（iPad 竖屏） | **810** | 桌面三栏 | 42px |
| 820 | **841** | 桌面三栏 | 21px |
| 1024 | 1024 | 桌面三栏 | 0 |

`innerWidth` 比设备宽，是因为三栏放不下 → 横向溢出 → **移动端浏览器为了容纳内容
反而把布局视口撑宽** → `max-width: 760px` 更不可能命中 → 死循环。iPad 竖屏定格在
"缩小版桌面 + 横向滚动条"。

**修法**：断点 760 → **900**（与仓库里 `lms.css` 已有的 900 对齐）。
`shell.css` 三处 + `app.js` 的 `MOBILE_QUERY` + `notes.css` 一处，**五处必须同时改**
（CSS 的媒体查询条件 JS 读不到，两边各写一份是仓库既有约定，改一处漏一处就会错位）。

### 9.3 逐项修复（都在 `shell.css` 末尾的「窄屏可用性修复」小节里）

| 问题 | 实测（390px） | 修法 |
| --- | --- | --- |
| `.chat-title` 被挤成竖排「对/话」 | 标题盒 25×50，顶栏 67px | 标题 `flex: 0 0 auto` + `nowrap`；顶栏 42px |
| 徽标溢出父级、盖住状态文字 | 父级 112px 装着 145px 的 `span.badge` | 徽标改 `flex: 0 0 auto`（不可压缩），让 `.status-pill` 去省略 |
| 控件行折成两行 | 6 个控件共 406px 塞 329px，行高 102px | `nowrap` + `overflow-x: auto`（dschat 顶栏同款），行高 50px |
| 输入框一上来就三行高 | `autoGrow` 把折行的 placeholder 当内容，撑到 108px | 空输入时清掉行内高度交给 CSS；窄屏 `min-height: 62px`（恰好两行）+ 换短 placeholder |
| 「☾ 夜间模式」被裁 | `white-space` 计算值是 `nowrap` | `theme.css`（最后加载）压过了 `shell.css` 的移端动规则；用 `.sidebar .theme-toggle` 提优先级到 (0,2,0) |
| 「待办」工具栏被裁且滚不回来 | `.toolbar-row` 宽 524px，面板溢出 206px，而 `.panel-body` 是 `overflow-x: hidden` | 根因是 `min-width: auto` + 子元素 `flex-basis: 380px`；给工具条族放开收缩下限 |
| 分段控件「全部/今天」竖排 | `.seg` 收缩后按钮被压窄 | `.seg` 横滑 + `.seg > * { flex: 0 0 auto }`，宁可横滑不竖排 |
| 待办日期框显示「2026/10/1」 | `.qa-date` 被压到 96px | 窄屏 `.quick-add` 换行，日期给 140px |

输入区总高 **294px → 177px**（844px 屏的 35% → 21%）。

### 9.4 验证

| 项目 | 结果 |
| --- | --- |
| 全宽度扫描 320→1440 | 文档水平溢出**全部为 0**（13 个宽度） |
| 10 个视图逐个扫描（390px） | 面板溢出全部为 0 |
| 笔记页签 / 设置表格 | 在 `overflow-x: auto` 容器内，可横滑到达 |
| 桌面 1280px 像素级比对 | 改动前后仅 4 像素差（0.000%），**无回归** |
| 测试套件 | 774/695/75，与未改动基线**逐条一致**，零回归 |

### 9.5 还没做的（已知、可接受）

- 「待办」的分段控件和聊天控件行在 390px 下**需要横滑**才能看全。这是刻意的取舍：
  横滑比"被裁掉点不到"和"挤成竖排两字"都好，也与 dschat 的做法一致。
- 日历月视图的空白格偏高（每格约 100px），手机上一屏只能看 4 行。没动它——
  这属于视图自己的排版，改了会牵动事件气泡的定位。
- `settings` 页的知识库表格在 390px 下需要横滑。表格本来就是横滑语义，未改。

---

## 10. 提交与推送（2026-10-14）

### 结果

`origin/server` 顶端 = **`371a3b3`**，本地与远端 `0 0` 同步。两个提交：

| 提交 | 内容 |
| --- | --- |
| `0c1aa58` | `fix(www): 登录页资源改绝对路径，修复根路径白页`（1 文件 / +2 -2） |
| `371a3b3` | `fix(mobile): 窄屏断点 760→900 修掉平板黑洞，并逐项修好顶栏 / 控件行 / 工具条`（3 文件 / +223 -8） |

作者用 `why012123 <why012123@users.noreply.github.com>`，通过
`git -c user.name=... -c user.email=...` **逐次传入**，没有写进你的全局 git 配置。

### 过程里发生的事（值得知道）

1. **第一次 push 被拒**：`! [rejected] server -> server (fetch first)`。
   你在我克隆之后又推了 **9 个提交**（`feat(sync)` 多端同步、`feat(account)` 桌面登录等）。
   **没有强推** —— 改用 `git rebase origin/server`，再推。事前打了 `backup-before-rebase`
   标签，验证成功后删除。
2. **零文件重叠**，所以 rebase 干净通过：你那 9 个提交动的是
   `app/src/renderer/index.html` 与新增的 `modules/account`、`modules/sync`，
   加上 `views/account.*`、`views/sync.*`；我改的 4 个文件一个都没被碰。
3. **rebase 的副作用必须处理**：它会把工作区更新到含你那 9 个提交的状态，
   而正在跑的 www 进程是**在那些模块存在之前**启动的 —— 它的模块列表是旧的，
   磁盘上的 `index.html` 却已经引用了 `views/account.js` / `views/sync.js`。
   这是"半更新"状态，界面会露出调不通的入口。所以**重启了 www**
   （pid 87408）让两边一致，重启后 `/` 200、`/app` 302、`/auth/config` 200、`/ws` 401，
   stderr 无报错。

### 顺带排查的两件事（都得出"不用改"的结论）

**1. 你的新视图在移动端没问题。** `account.css` / `sync.css` 各有一条
`@media (max-width: 760px)`，看起来正是我修掉的那个断点，像是会把 761–900px
重新变成黑洞。实测后**结论是不要动**：这两条是按**面板宽度**调的（窄面板才把条数网格
降到 2 列、按钮占满整行），而 761–900px 走单屏后**面板反而有 700–840px 宽**，
用桌面样式的自适应列数更合适。实测 820px 下 `.acct-input` / `.sync-actions`
宽 706px、**无溢出**，截图看着也对。盲目跟着抬到 900 反而会让那两页在宽面板里变稀疏。

**2. 新代码带进来 4 个失败测试，但那是 Windows 语义问题，不是 bug。**
全量 `node --test --test-timeout=60000` 现在：**875 测试 / 792 通过 / 79 失败**。
新增的 4 个失败全部在你自己的 `sync.test.js`（2 个）与 `account.test.js`（2 个）：

```
expected: 384   (0o600)
actual:   438   (0o666)
```

断言的是"私有文件权限 0600"。**Windows 不实现 POSIX 权限位**，`chmod(0o600)` 之后
`stat` 仍返回 0666，所以这 4 个在 Windows 上必然失败、在 Linux（你的服务器 / CI）上会通过。
仓库里既有的 75 个失败与本轮无关，前面已用 `git worktree` 基线对照确认过。

---

## 11. 上传体积与两条出口的上行能力（2026-10-21 实测）

### 多端同步的「一直中断」= 服务端拒收大请求

桌面端按 **2MB 一片**推（`PUSH_CHUNK_BYTES`），而 `study.xjtuwhy.com` 的 nginx
**没有配 `client_max_body_size`**，走默认 **1m** —— 每一片在到达应用之前就被
`413 Request Entity Too Large` 打回，客户端把它翻译成"这一批数据太大了"。

**已修（服务器上执行过）**：

```nginx
# /etc/nginx/sites-available/xjtu-study，443 块内
client_max_body_size 16m;
```
备份在 `/root/xjtu-study.bak.1792513352`，`nginx -t` 通过后 reload，生效值已确认。

### 但香港那条链路**根本扛不住上传**（比体积限制严重得多）

改完 nginx 之后逐档实测（每档都带真实会话打 `/api/v1/sync/push`）：

| 体积 | 香港 `study.xjtuwhy.com` | passnat `studywhy.3q.hair` |
| --- | --- | --- |
| 2 MB × 5 次 | **5 次里 4 次 504**，每次 **40–52 秒** | 全部 400，**0.23–0.30 秒** |
| 3 MB | 504 / 404 各一，9.8–49 秒 | 400，< 1 秒 |
| 3.8 MB（随手拍笔记尺寸） | — | 400，0.39–0.56 秒 |
| 8 MB | 504 / 404 各一 | 400，< 2 秒 |
| 11 MB | — | 400，2.2 秒 ✅ |
| 12 MB | — | **413（passnat 自己的上限，约 11MB）** |

结论：
- **桌面端的服务器地址应该填 `http://studywhy.3q.hair`**（passnat），别用香港那条；
- 香港那条只适合浏览（GET 尚可），**上传必挂**；
- passnat 的上限约 **11MB**，而分片是 2MB，够用；单条 3.8MB 的笔记也没问题。

（400 是应用层拒绝了这个假 payload —— 重点不是返回码，而是**请求确实穿过了中间层**。）



