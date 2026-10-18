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

## HTTP 接口

| 方法 | 路径                    | 说明 |
| ---- | ----------------------- | ---- |
| GET  | `/timetable/status`     | `{loggedIn, reason?, currentTerm, terms:[{value,label,current}], imported:{count,courses}}`，只读本地 + 必要时拉一次当前学期 |
| GET  | `/timetable/preview?term=` | `{term, termLabel, termStart, startSource, totalWeeks, maxWeek, courses, skipped}`，只读；`&refresh=1` 绕过课表短缓存 |
| POST | `/timetable/import`     | body `{term, courseIds, untilWeek?}` → `{created, updated, skipped, skippedCount, events, removed}` |
| POST | `/timetable/remove`     | body `{term?, courseIds?, all?}` → `{removed}` |
| GET  | `/timetable/imported?term=` | `{term, count, total, courses:[{id,name,count,externalIds,…}]}`，只读本地 |

`preview.courses[]`：`{id, name, teacher, location, weekDays, periodRange, weeks:{list,runs,min,max},
slots, eventCount, schedulePreviews:[{weekDay,startTime,endTime,weeks:{start,end},date,season}]}`。

错误语义：未登录 `401 NOT_LOGGED_IN`；上游异常 `502 EHALL_ERROR`（消息带原始路径，
**不回传上游 HTML**）；入参错误 400。

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
- `startTime/endTime` 取自 `periods.js` 的作息表（按段首那天的日期选冬 / 夏作息）；
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
- **跨 9/10 月的下午课段按段首作息**（`repeat` 只能有一个固定 `startTime`）。上午课与
  节次时长不变的课不受影响；需要精确到半小时的用户可手动改那几条日程。
- **起始日优先用 `cxjcs.do`**，拿不到（历史学期常见）时按校历惯例推断，响应里 `startSource`
  如实标注 `ehall` / `guess`。
- `wdkb` 若改版：先改 `config.js` 的 `paths` 与 `api.js` 的字段映射；三个接口都失败时
  错误里会带原始路径，便于用 DevTools 对照。
