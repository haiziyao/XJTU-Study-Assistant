# 课表导入（timetable）

把西安交通大学本科教务系统（`ehall / jwapp / wdkb`）的课表导入「日历 → 日程」。
页面在左栏「课表导入」，三段式：**登录与学期 / 预览与选择 / 已导入**。

## 数据来源（唯一）

| 用途     | 路径                                        | 参数                         | 取值位置                     |
| -------- | ------------------------------------------- | ---------------------------- | ---------------------------- |
| 课表     | `/jwapp/sys/wdkb/modules/xskcb/xskcb.do`    | `XNXQDM=<学期>`              | `datas.xskcb.rows[]`         |
| 当前学期 | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`  | 无                           | `datas.dqxnxq.rows[0].DM`    |
| 起始日   | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do`   | `XN=<学年>`、`XQ=<学期序号>` | `datas.cxjcs.rows[0].XQKSRQ` |

- 全部是 `POST` + `application/x-www-form-urlencoded`；
- 响应外壳 `{ code: "0", datas: {...} }` —— **`code` 是字符串 `"0"`**；
- 行字段大小写敏感：`KCM` 课程名、`SKJS` 教师、`JASMC` 教室、`SKXQ` 星期（1=周一）、
  `KSJC` / `JSJC` 起止节次、`SKZC` 周次位图（每位一周）、`XNXQDM` 学期；
- 未登录会 302 到 `amp-auth-adapter/login` 再跳 CAS → **401 `NOT_LOGGED_IN`**，不会当成「没有课」。

登录不在本模块实现：`auth` 模块（order=5）负责 CAS / MFA；本模块只
`auth.registerSite({id:'timetable', …})` 并在业务请求前 `auth.ensure('timetable')`。

### ★ 为什么课表还要额外的 jwapp 授权握手

**登录有效 ≠ 课表接口可用。** 只带 CAS 票据直接 POST `xskcb.do` 会稳定返回 **403 HTML**
（2026-10 真机实测：`GET/POST xskcb.do` 都是 403，会话本身完全有效）。jwapp 的每个应用
（成绩 `cjcx`、课表 `wdkb`…）都要先做一次**应用授权握手**，授权按应用登记，
所以学业模块握过的成绩应用授权**不能**给课表用：

```
GET  /jwapp/sys/wdkb/*default/index.do                       → 200 HTML，取 _JW_INIT_CONFIG.appId
GET  /jwapp/sys/funauthapp/api/getAppConfig/wdkb-<appId>.do  → 登记本账号对该应用的授权
POST /jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do           → {SFQY:'1', APP:<appId>}，刷新 _WEU
POST /jwapp/sys/wdkb/modules/xskcb/xskcb.do                  → 这才返回 {code:"0",datas}
```

握手结果按会话缓存；业务接口 403 时用**全新握手重试一次**，仍 403 就是
**502 `EHALL_HANDSHAKE_FAILED`（带 steps）**，绝不冒充 401 未登录。

同理，**站点的 `loginUrl` 必须指向 HTML 应用页**，不能指向 `xskcb.do` 这种 POST-only 的
JSON 接口：`CasAuth.begin()` 只看"有没有 `execution` 令牌 / 是否在 `/cas/login`"，
GET 一个 403 HTML 错误页会被它误判成"业务页 → 已登录"，于是 `lastOkAt` 有值、
站点 ready，但真正业务请求一打就 403 —— 用户看到的就是「课表登录态已失效」。

## HTTP 接口

| 方法 | 路径                    | 说明 |
| ---- | ----------------------- | ---- |
| GET  | `/timetable/status`     | `{loggedIn, reason?, error?, currentTerm, terms:[{value,label,current}], imported:{count,courses}, diagnose}`，只读本地 + 必要时拉一次当前学期 |
| GET  | `/timetable/status?probe=1` | 额外主动重验站点 + 跑一次授权握手，返回 `diagnose:{site:{ready,reason,lastOkAt}, handshake:{ok,appId,steps:[{step,status,error}]}, lastError}`（只读、不含 cookie / 票据） |
| GET  | `/timetable/preview?term=` | `{term, termLabel, termStart, startSource, totalWeeks, maxWeek, courses, skipped}`，只读；`&refresh=1` 绕过课表短缓存 |
| POST | `/timetable/import`     | body `{term, courseIds, untilWeek?}` → `{created, updated, skipped, skippedCount, events, removed}` |
| POST | `/timetable/remove`     | body `{term?, courseIds?, all?}` → `{removed}` |
| GET  | `/timetable/imported?term=` | `{term, count, total, courses:[{id,name,count,externalIds,…}]}`，只读本地 |

`preview.courses[]`：`{id, name, teacher, location, weekDays, periodRange, weeks:{list,runs,min,max},
slots, eventCount, schedulePreviews:[{weekDay,startTime,endTime,weeks:{start,end},date,season}]}`。

错误语义：未登录 `401 NOT_LOGGED_IN`；jwapp 应用授权握手失败 `502 EHALL_HANDSHAKE_FAILED`
（响应里 `details.handshake.steps` 指出卡在哪一步，**不引导重新登录**）；上游异常
`502 EHALL_ERROR`（消息带原始路径，**不回传上游 HTML**）；入参错误 400。

## 合并规则（merge.js）

1. **相邻同名课程合并**：同一天、同一课程名、节次连续（`上一段.end + 1 === 下一段.start`）、
   周次集合相同 → 合成一条（1-2 + 3-4 → 1-4）。
   不连续（1-2 与 5-6）、中间有空档、或周次不同 → 保持多条。
2. **教师 / 教室不同仍然合并**，用 `" / "` 并列。理由：相邻节次属于同一个连续时间块，
   拆开会把一门连堂课在日历里断成两截；并列值按节次顺序去重，结果稳定。
3. 合并后的时段再按**课程名**分组为一张课程卡片：一门课可能一周上多次，用户勾选的是
   「这门课」，勾上就导入它的全部时段。课程 id = `ttc-<hash8(规范化课程名)>`。

## 周次 → 日程

`SKZC` 位图 → 周次列表 → **连续段**（`weeksToRuns`）。每个「时段 × 连续段」写一条日程：

- `date = 学期起始日 + (段首周-1)*7 + (星期-1)`；
- `startTime/endTime` 取自 `periods.js` 的作息表；含第 5 节及以后的段若跨 5/1 或 10/1，
  会**按周切成两段**、各自用自己的作息（见下面「作息切换」）；
- `repeat = {type:'weekly', interval:1, weekdays:[星期], until:{mode:'date', date:段末周同一天}}`；
- 跨段（如 1-8 周与 10-16 周）→ **两条**日程，因为 `repeat.until` 只能表达连续区间。

`externalId = timetable:<学期>:<课程名>:<星期>:<起-止节>:<周次段哈希>`：

- 全部由学校给的事实确定性算出 → 重复导入只更新、不重复；
- 带学期 → 换学期不覆盖旧学期；
- 带周次段哈希（只哈希**段起点**）→ 跨段的两条日程互不覆盖；调小 `untilWeek` 时终点变化
  仍命中同一条日程（update），不会"新建 + 删旧"；
- 不含教师 / 教室 → 换老师、调教室不会变成一条新日程；
- 课程名做规范化（去空白、全角标点转半角）。

## 只删自己写的东西

删除只处理 `source === 'import'` **且** `externalId` 以 `timetable:` 开头的日程。
用户手建 / 手改的日程永远不会被本模块碰到 —— 前缀是「归课表导入管」的唯一凭证。
`import` 的 `removed` 也只清理「本次选中范围内、上游已不存在」的旧日程（例如调小 `untilWeek`）。

## 已知取舍

- **作息表是硬编码的**（11 节，冬 / 夏两套，5-9 月为夏季）。课表接口只给节次号，不给时刻。
  数据沿用旧实现（2026-01 真机核对）。
- **作息切换已按周切开**：学校官方作息分「夏、秋季（5/1 起）」与「冬、春季（10/1 起）」两套，
  第 1–4 节相同、第 5 节起整体差 30 分钟（来源：教务处「作息时间」页）。
  `repeat` 只能有一个 `startTime`，所以含第 5 节及以后、且跨切换日的周次段会**按周切段**，
  每段写自己的作息 —— 例如 9/14 开学、周一 5–6 节、第 1–16 周会变成
  「第 1–3 周 14:30 起」+「第 4–16 周 14:00 起」两条。预览里 `seasonSplit` 与页面文案会说明。
  周内切换按**该周周一**判定（切换日落在周中时，那几天仍按周一作息，最多错半小时、只影响那一周）。
- **官方作息表只列到第 10 节**（之后是就寝 / 熄灯）；本模块的第 11 节（21:10 / 21:40）属兜底，
  万一上游出现第 11 节也有时间可写，但不在官方表内。
- **起始日优先用 `cxjcs.do`**，拿不到（历史学期常见）时按校历惯例推断，响应里 `startSource`
  如实标注 `ehall` / `guess`。
- `wdkb` 若改版：先改 `config.js` 的 `paths` 与 `api.js` 的字段映射；三个接口都失败时
  错误里会带原始路径，便于用 DevTools 对照。
