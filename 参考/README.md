# 参考实现（reference）

本目录存放 XJTU-Study-Assistant 的**参考资料**，不属于主程序运行代码，仅供对照与借鉴。

## dschat — DeepSeek 网页聊天（含日历 / 待办 / 设置页）

| 项目 | 说明 |
| --- | --- |
| 技术栈 | 纯 Python 标准库（`http.server` + `sqlite3`）+ 原生 JS/HTML/CSS，无框架、无构建；依赖仅 `openai` |
| 能力 | 多用户登录（PBKDF2 密码哈希 + 邀请码）、AI 对话（DeepSeek API，SSE 流式 + 思考过程）、图片输入、智能体情绪、作图模式（SVG）、余额显示、待办清单、日历（月/周/日视图 + 学期周次 + ICS 导出）、联网搜索、会话导出 |
| 启动 | `python3 chattest.py`（或 `./run.sh`），默认 http://127.0.0.1:8799；首次启动自动创建管理员并打印随机密码（可用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量指定），数据库与图片写入 `data/`（自动建库） |
| 与 calendar 模块的关系 | `calendar/` 的字段映射（`date` / `start_time` / `end_time` / `all_day` / `repeat…`）与 AI 中文标记行格式即参考本实现，详见 [calendar/接口文档.md](../../calendar/接口文档.md) 第 8 节 |

### 文件

```
参考/dschat/
├── chattest.py            # 入口（python3 chattest.py）
├── run.sh                 # 启动脚本（自动挑选已装 openai 的解释器）
├── requirements.txt       # 唯一依赖：openai>=1.0.0
└── app/
    ├── server.py          # HTTP 路由、SSE 流式、导出、日历/待办 API
    ├── storage.py         # SQLite：agents/conversations/messages/users/sessions/…（自动建表）
    ├── auth.py            # PBKDF2 密码哈希 + 会话令牌 + 邀请码
    ├── config.py          # 配置（API key 从环境变量或用户级配置读取）
    ├── deepseek.py        # DeepSeek API 客户端
    ├── mood.py            # 智能体情绪
    ├── websearch.py       # 联网搜索（多引擎）
    └── static/            # 前端页面：聊天 / 日历 / 待办 / 设置 / 文档
```

## 开源前的脱敏处理

**已整体移除**：

| 内容 | 原因 |
| --- | --- |
| `data/chat.db` | 真实聊天记录、92 条个人日程、用户账号与密码哈希、活动会话令牌、**明文 API key** |
| `data/images/`（54 个文件） | 用户拍摄/上传的照片，其中 33 张含 iPhone 机型、拍摄时间与 **GPS 定位** EXIF |
| `sources/images/`（15 个文件） | 个人界面素材截图 |
| `.venv/`、`__pycache__/` | 本机环境；且 `__pycache__` 里的 `.pyc` 把 API key 编译进了字节码 |
| `deploy/`、`test/` | 个人服务器部署脚本与探测脚本（含真实域名、公网 IP、frp token、隧道 UUID） |
| `dschatmac/` | `app/` 的同步副本 + 从个人服务器拉数据的 `sync.py` |
| `run.bat`、`cleanup.ps1`、`*.lnk` | Windows 启动/清理脚本与快捷方式（含本机用户名、主机名、自定义盘符路径） |

**已替换为占位符**：个人域名 → `chat.example.com` / `docs.example.com`；公网 IP → `YOUR_SERVER_IP`；frp token → `YOUR_FRP_TOKEN`；frp 面板口令 → `YOUR_ADMIN_PASSWORD`；隧道 UUID → `YOUR_TUNNEL_UUID`；本机用户名 → `youruser`；服务器所在地 → 「境外」。

**已核查**：本目录不再出现原域名、公网 IP、API key、密码/token/隧道 UUID、本机用户名与主机名、真实姓名、学校名、课表、教学楼房间号、邮箱与手机号；代码内无硬编码口令（管理员口令运行时生成或读环境变量）。

> 这是**参考快照**，不是可直接上线的部署包：`data/` 为空，首次运行会自动建库并生成管理员账号。
> 若要从零启动：`pip install -r requirements.txt && python3 chattest.py`。
