/**
 * 联网检索适配层（后端，零依赖）。
 *
 * 设计目标：让 AI 在多轮对话里完成「搜网页 → 读正文 → 带出处回答」这条链路，
 * 而**不引入任何运行时依赖**（不用 cheerio / jsdom / axios，只用 Node 内置 fetch + 正则）。
 *
 * 三层降级（按配置自动选择，见 `resolveSearchBackend`）
 * ---------------------------------------------------
 *   1. **配置了 API key** → 走官方 API（Tavily / Brave / Serper / Bing Web Search 任一），
 *      结构化 JSON，最稳；
 *   2. **没配 key** → 解析公共搜索引擎的结果页（Bing 优先，失败退百度），拿到标题 + 链接 + 摘要；
 *   3. **结果页也被反爬/改版挡住** → 返回**空数组**，并把原因写进 `log`。
 *
 * 第 3 条是本文件最重要的约定：**搜不到就如实说搜不到**。
 * 绝不允许返回伪造结果，也不允许把「没配置 / 被拦截」静默成「搜到 0 条」——
 * 后者会让模型在用户面前编出"我查了一下，没有相关结果"这种假结论，比直接说"检索失败"更糟。
 *
 * 两种模式（`mode`）
 * ----------------
 *   - `web`    ：校外，全网检索；
 *   - `campus` ：四条通道，**顺序就是优先级**（见 `searchWebDetailed` 里的执行注释）：
 *                ⓪ **栏目列表直读**（`readSiteNews`）：问法像"最近/最新有什么"、又能从检索词里
 *                   认出目标站点时，直接把该站点的新闻/通知**栏目页**抓下来，取按发布日期倒序的
 *                   前几条（`matchedBy: 'column'` + `publishedAt`）。**为什么不靠站内搜索**：
 *                   VSB 站群的列表页常常没被站内搜索收录、或收录明显滞后，真机上"最近学院有什么
 *                   新闻"就是因此失手的；而列表页是静态 HTML，抓下来就是最新几条；
 *                ① **站内直搜**（`searchCampusSites`）：直接打校内站点自己的检索接口，
 *                   命中的才必然是"校内的东西"；
 *                ② **公共结果页**：把检索词收窄到校内站点（`site:` + 校名，见 `campusScopedQuery`），
 *                   覆盖站内直搜够不到的部分（新子站、没有搜索入口的站、需登录的站）；
 *                ③ **mention 兜底分桶**：公网结果里标题/摘要提到本校的算作校内相关，并如实标注来源。
 *                另外：**校内域名探测可达时**再并走一次不分域的公网检索（原来就有的一路）。
 *                注意：探测只能判断「校内域名可达」，**不能证明当前真的走了校园网**
 *                （校内站点也可能对公网开放），所以它只作为"是否并走公网"的启发式，
 *                并且在返回值里带 `caveat` 如实说明这一点。
 *
 * 可测试性
 * --------
 * 所有网络动作都走 `fetchImpl`（默认 `globalThis.fetch`），测试可注入本地假服务器；
 * 端点也允许用 `config.searchEndpoints` 覆盖，于是"假搜索引擎"可以是一个 127.0.0.1 上的
 * `node:http` 服务，测试**完全不碰真实外网**。
 */

const noop = () => {};

/** 一次检索最多读几页的合法区间（对应设置里的「网络搜索最大条数」）。 */
export const SEARCH_LIMIT_MIN = 5;
export const SEARCH_LIMIT_MAX = 30;
/** 设置里没填时的默认值（与 config.js 的 AI_DEFAULTS.searchMaxPages 保持一致）。 */
export const SEARCH_LIMIT_DEFAULT = 8;

/** 单页正文默认截断长度（字）。4000 字≈6~8k token，8 页全读也就 5 万 token 上下。 */
export const READ_MAX_CHARS = 4_000;
/** 读正文的并发上限：再高容易把目标站打出 429，收益也有限。 */
export const READ_CONCURRENCY_MAX = 4;
export const READ_CONCURRENCY_DEFAULT = 3;

/** 工具可选的模式（注意：对话层的 `search` 还有第三档 `off`，那一档根本不会调到本文件）。 */
export const WEB_SEARCH_MODES = Object.freeze(['web', 'campus']);

/** 支持"填了 key 就优先走 API"的四家。数组顺序 = auto 模式下的优先级。 */
export const SEARCH_PROVIDERS = Object.freeze(['tavily', 'brave', 'serper', 'bing']);

/**
 * 校内站点后缀。`*.xjtu.edu.cn` 覆盖教务/图书馆/学院/研究生院等子站。
 * 判据用**后缀**而不是硬编码主机名，新开一个子站不用改代码。
 */
export const CAMPUS_HOST_SUFFIXES = Object.freeze(['xjtu.edu.cn']);

/**
 * 默认探测目标：都是本仓库其它模块里**已经在用**的真实主机名
 * （`dean.xjtu.edu.cn` 来自校规知识库抓取源、`lms/ehall` 来自 lms/academic 模块），
 * 不是我凭空编的域名。
 */
export const CAMPUS_PROBES = Object.freeze([
  { url: 'https://dean.xjtu.edu.cn/', label: '教务处（dean）' },
  { url: 'https://gs.xjtu.edu.cn/', label: '研究生院（gs）' },
  { url: 'https://lms.xjtu.edu.cn/', label: '思源学堂（lms）' },
  { url: 'https://ehall.xjtu.edu.cn/', label: '师生服务大厅（ehall）' },
]);

/** 探测结论里必须带上的一句话，避免调用方把「可达」误读成「在校园网内」。 */
export const CAMPUS_PROBE_CAVEAT =
  '探测只能说明「校内域名在当前离线环境下可达」，不能证明流量真的走了校园网：' +
  '校内站点也可能对公网开放，反之校园网内的 DNS/代理异常也会造成误判。';

/**
 * 校内站点直搜配置表（**逐条真机实测过**，不是照模板猜的）。
 *
 * 为什么要有这张表：校内站点绝大多数是同一套「博达 VSB（Visual SiteBuilder）站群」，
 * 检索接口的形状完全一致，站点之间只差三件事 ——
 *   ① 搜索页路径：各站自己起名，实测见过 `search.jsp` / `ssjgy.jsp` / `soso.jsp` / `soso_2.jsp` /
 *      `ss.jsp` / `ssjg.jsp` / `sousuo.jsp`，**猜不得**，只能从首页的 `<form action=…>` 里取；
 *   ② 关键词字段名：多数是 `lucenenewssearchkey`，研究生院是 `lucenenewssearchkeyword`（同一套
 *      cms 的不同版本）。字段名弄错时服务端**不报错**，而是安静地返回一张没有检索结果的默认页 ——
 *      实测「研究生院 + 推免/蓝桥杯/转专业」三个词返回的字节数一模一样，就是这么发现的；
 *   ③ 结果的域名范围：多数站只搜自己（`dean.xjtu.edu.cn`…），门户 `www` 搜的是整个 `*.xjtu.edu.cn`
 *      （实测能搜出 `news.xjtu.edu.cn` 的稿件），所以它多一条 `allowHosts`。
 *
 * 编码：所有实测站点都是 **base64(UTF-8)** 放进表单的隐藏字段，页面里
 * `/system/resource/js/base64.js` 开头就写着「文字采用 UTF-8 方式进行 Base64 编码」。
 * 另有"明文关键词"或"GBK base64"的老写法，但**这 20 个站点里一个都没出现**，所以这里不实现
 * （零依赖环境下做 GBK 编码要自带码表，为一个没实测到的分支塞几百行常量不划算）。
 *
 * 表单还必须带 `_lucenesearchtype=1` 与 `searchScope=0`：实测去掉这两个参数后服务端照样 200，
 * 但返回的是一张"没有检索结果"的默认页 —— 属于"看着成功、其实什么都没搜"的坑。
 *
 * 字段（`working: true` 的条目）：
 *   - `host`      站点主机名，同时用作**结果域名白名单**（只留本站域名下的条目）
 *   - `path`      搜索页路径（含 `wbtreeid`，VSB 用它区分站点/栏目）
 *   - `keyField`  关键词字段名（`lucenenewssearchkey` 或 `lucenenewssearchkeyword`）
 *   - `evidence`  实测日期 + 当时的结果条数（以后站点改版，先看这一行还成不成立）
 *   - `origin`    可选，仅测试注入本地假站点时用；默认 `https://<host>`
 *   - `aliases`   可选，**从用户问法里认站点**用的别名（`findCampusSiteForQuery`）。
 *                只写不会误伤的：书院/学院全名 + 通用简称（"彭康""航院"），
 *                **不写**"学院""书院"这种单独出现的通名 —— 那会把任何学院都认成同一个站。
 *   - `columns`   可选，**实测可用**的新闻/通知栏目列表页（相对本站根的路径）。
 *                它是"栏目列表直读"（`readSiteNews`）的兜底清单：正常情况下栏目页从首页锚文本里
 *                现找（站点改版也能跟上），这里这份是首页找不到链接时（JS 渲染的首页、首页抓取
 *                失败）的保底，也在候选排序里排前面（首页链接是按导航顺序排的，主新闻栏目常被
 *                "工作动态/团委动态"挤掉）。**每条都实测过能抽出带日期的条目**，
 *                实测日期与当时读到的最新一条见本表后面的《栏目列表直读实测结论表》。
 * 字段（`working: false` 的条目）：只有 `id/label/host/reason`，运行时**不会发请求**；
 * 留着是为了下次不用重复试 —— 都是 2026-10-13 实测确认打不通或没有检索入口的。
 */
export const CAMPUS_SITE_SEARCH = Object.freeze([
  {
    id: 'dean', label: '教务处', host: 'dean.xjtu.edu.cn',
    aliases: ['教务处', '教务', '教务办', '本科生院'],
    columns: ['jxxx/jxtz2.htm', 'jxxx/jxdt.htm'],
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条、「通知」15 条',
  },
  {
    id: 'gs', label: '研究生院', host: 'gs.xjtu.edu.cn',
    aliases: ['研究生院', '研招办', '研究生招生'],
    columns: ['xwdt.htm', 'tzgg.htm'],
    path: '/ssjgy.jsp?wbtreeid=1111', keyField: 'lucenenewssearchkeyword', working: true,
    evidence: '2026-10-13 实测「转专业」15 条、「通知」17 条（字段名是全表唯一的 keyword 版）',
  },
  {
    id: 'www', label: '学校门户（覆盖整个 *.xjtu.edu.cn）', host: 'www.xjtu.edu.cn',
    aliases: ['学校门户', '交大主页', '学校主页'],
    path: '/soso_2.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey',
    allowHosts: ['xjtu.edu.cn'], working: true,
    evidence: '2026-10-13 实测「转专业」10 条（含 news.xjtu.edu.cn 稿件）；无匹配时会返回一版默认推荐列表',
  },
  {
    id: 'sae', label: '航天航空学院', host: 'sae.xjtu.edu.cn',
    aliases: ['航天航空学院', '航天学院', '航空航天学院', '航院', '航天航空'],
    columns: ['index/zhxw.htm', 'index/tzgg.htm', 'index/xsjz.htm'],
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（标题在 <h3> 里，日期在 <a> 内的 .a-date 块）',
  },
  {
    id: 'math', label: '数学与统计学院', host: 'math.xjtu.edu.cn',
    aliases: ['数学与统计学院', '数学学院', '数学院', '数学系'],
    columns: ['kxyj/kydt.htm'],
    path: '/ssjgy.jsp?wbtreeid=1213', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」18 条、「通知」18 条',
  },
  {
    id: 'news', label: '新闻网', host: 'news.xjtu.edu.cn',
    aliases: ['新闻网', '交大新闻网', '学校新闻'],
    columns: ['zyxw.htm', 'ywjj.htm', 'yxdt/ybdt.htm'],
    path: '/xmb/ssjgg.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」8 条（每条带摘要，链接是 ../info/… 相对路径）',
  },
  {
    id: 'pksy', label: '彭康书院', host: 'pksy.xjtu.edu.cn',
    aliases: ['彭康书院', '彭康'],
    columns: ['sydt/pkxw.htm', 'tzgg.htm'],
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（结果容器写成大写 <UL>）',
  },
  {
    id: 'wen', label: '文治书院', host: 'wen.xjtu.edu.cn',
    aliases: ['文治书院', '文治'],
    columns: ['syxw.htm', 'tzgg.htm'],
    path: '/ssjg.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（日期和标题挤在同一个 <a> 里）',
  },
  {
    id: 'zlsy', label: '宗濂书院', host: 'zlsy.xjtu.edu.cn',
    aliases: ['宗濂书院', '宗濂', '宗濂尚德书院'],
    columns: ['sydt.htm', 'tzgg.htm'],
    path: '/ss.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'nanyang', label: '南洋书院', host: 'nanyang.xjtu.edu.cn',
    aliases: ['南洋书院', '南洋'],
    columns: ['xwtz/syxw.htm', 'xwtz/tzgg.htm'],
    path: '/search.jsp?wbtreeid=1047', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'lizhi', label: '励志书院', host: 'lizhi.xjtu.edu.cn',
    aliases: ['励志书院', '励志'],
    columns: ['xwtz.htm', 'xwtz/zxdt.htm'],
    path: '/sousuo.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'bjb', label: '钱学森学院（拔尖计划）', host: 'bjb.xjtu.edu.cn',
    aliases: ['钱学森学院', '钱学森书院', '拔尖计划', '钱学森班'],
    columns: ['xydt/zhxw.htm', 'xydt/tzgg.htm'],
    path: '/soso.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（钱学森书院的内容也在这里）',
  },
  // ---- 以下站点 2026-10-13 实测打不通/没有检索入口：运行时直接跳过，不做无谓请求 ----
  {
    id: 'library', label: '图书馆', host: 'library.xjtu.edu.cn',
    aliases: ['图书馆', '交大图书馆'], working: false,
    reason: '域名能解析（202.117.24.24）但 http/https 都 20s 超时，疑似仅校园网内可达，本轮无法确认它有没有检索入口',
  },
  {
    id: 'qianxuesen', label: '钱学森书院', host: 'qianxuesen.xjtu.edu.cn', working: false,
    reason: '域名能解析（202.117.3.253）但连接 20s 超时；书院内容实测能从 www.xjtu.edu.cn/bksy/qxssy.htm 与 bjb.xjtu.edu.cn 搜到',
  },
  {
    id: 'sei', label: '软件学院（sei）', host: 'sei.xjtu.edu.cn', working: false,
    reason: '域名能解析（202.117.54.253）但连接 20s 超时，本轮不可达',
  },
  {
    id: 'eie', label: '电子与信息学部', host: 'eie.xjtu.edu.cn', working: false,
    reason: '首页是 JS 渲染的 VSB「AI 网站」模板（jQuery + home.js 往 #app 里注入正文），HTML 里没有搜索表单，直搜抓不到结果；'
      + '但**栏目直读读得到** —— 2026-10-13 实测 `/tzgg.htm` 有 20 条带日期的通知（最新 2026-08-02）。直搜不行不等于栏目不行',
  },
  {
    id: 'cssy', label: '崇实书院', host: 'cssy.xjtu.edu.cn', working: false,
    reason: '站点可达（首页 40KB）但整页没有 <form>、也没有 base64.js，没有可调的站内检索接口；'
      + '但**栏目直读读得到** —— 2026-10-13 实测 `sydt.htm`/`tzgg.htm` 有带日期的条目，只是栏目本身停在 2023-09-07',
  },
  {
    id: 'lms', label: '思源学堂', host: 'lms.xjtu.edu.cn', working: false,
    reason: '整站 302 到 jAccount 单点登录（identity1.xjtu.edu.cn），没有匿名可用的检索接口',
  },
  {
    id: 'ehall', label: '师生服务大厅', host: 'ehall.xjtu.edu.cn', working: false,
    reason: '跳转到 /new/index.html 的 JS 单页应用且需登录，匿名抓不到任何结果',
  },
]);

/**
 * 栏目列表直读（`readSiteNews`）的**实测结论表**（2026-10-13，用本文件的代码真网跑出来的）。
 *
 * 留着它的用途：以后"最近怎么读不到新闻了"，先照这张表复核一遍 ——
 * 每个站的列表页 URL、当时读到的最新日期、以及"是不是可用"。数字变了不一定是坏了
 *（学校假期不发稿很正常），但**最新日期停在几个月前**或**整页抓不到**就要查了。
 *
 * | 站点 | 可用栏目页（相对本站根） | 实测最新 | 说明 |
 * |------|--------------------------|----------|------|
 * | sae  | `index/zhxw.htm`(综合新闻)、`index/tzgg.htm`(通知公告)、`index/xsjz.htm`(学术讲座) | 2026-10-12 | 首页栏目按导航顺序排在"工作动态/团委动态"之后，所以 `columns` 要显式给出；日期拆成 `<span>2026</span><b>10-12</b>` 与 `<b>04</b><span>2026.05</span>` 两种写法 |
 * | dean | `jxxx/jxtz2.htm`(教学通知)、`jxxx/jxdt.htm`(教学动态) | 2026-10-12 | 日期在 `<a>` 后的裸 `<span>2026-09-18</span>` 里；`/tzgg.htm` 在这个站是 **404** |
 * | gs   | `xwdt.htm`(新闻动态)、`tzgg.htm`(通知公告) | 2026-10-12 | 路径短好记，`/xwdt.htm` 全站群只有这个站有 |
 * | news | `zyxw.htm`(主页新闻)、`ywjj.htm`(要闻聚焦)、`yxdt/ybdt.htm`(院部动态) | 2026-10-12 | 日期是 `<a class="y">2026-10</a><a class="r">10</a>` 两段 |
 * | math | `kxyj/kydt.htm`(科研动态) | 2026-10-09 | 首页现找即可 |
 * | pksy | `sydt/pkxw.htm`(书院动态)、`tzgg.htm`(通知公告) | 2026-09-15 | `sydt/xsbg.htm`(学术报告) 实测**空页**（0 条），没进 columns |
 * | wen  | `syxw.htm`(书院新闻)、`tzgg.htm`(通知公告) | 2026-10-08 | 标题在 `<a title="…">` 里、锚文本带日期，所以取 `title` 属性；`tzgg` 停在 2026-05-14 |
 * | zlsy | `sydt.htm`(书院动态)、`tzgg.htm`(通知公告) | 2026-09-29 | `tzgg` 停在 2024-01-03（这个栏目的通知栏很久没更新） |
 * | nanyang | `xwtz/syxw.htm`(新闻通知)、`xwtz/tzgg.htm`(通知公告) | 2026-09-14 | `tzgg` 停在 2025-03-06 |
 * | lizhi | `xwtz.htm`(新闻通知)、`xwtz/zxdt.htm`(最新动态) | 2026-07-23 | `sydj/djtz.htm` 实测空页 |
 * | bjb  | `xydt/zhxw.htm`(新闻信息)、`xydt/tzgg.htm`(通知公告) | 2026-09-30 | `hzjl/jldt.htm` 实测空页 |
 * | www  | **没有可读栏目**（首页是门户，锚文本里没有新闻/通知栏目；`/tzgg.htm`、`/xwdt.htm` 都 404） | — | 门户只适合做"搜全校"，要新闻请走 `news` |
 * | library | **不可达**（首页 8s 超时；`/tzgg.htm`、`/xwdt.htm` 因此未尝试） | — | 与表里 `working:false` 的原因一致：疑似仅校园网内可达；校园网内是否可读**本轮没验证** |
 * | cssy 崇实书院 | `sydt.htm`(书院动态)、`tzgg.htm`、`dyzj/tzgg.htm`（**首页现找**到的） | 2023-09-07 | **`working:false` 只代表"没有检索入口"，不代表读不到栏目**：这个站没有检索表单，但栏目页照样能读；只是它的新闻栏目本身停在 2023-09，读到的就是真实的旧日期 |
 * | eie 电子与信息学部 | `/tzgg.htm`（**通用兜底路径**命中的，20 条） | 2026-08-02 | 又一个"搜索读不到、栏目能读到"的例子：它的首页是 JS 渲染的（没有检索表单），但通知栏目页是标准 VSB 静态页 |
 * | ehall 师生服务大厅 | 无（`/tzgg.htm`、`/xwdt.htm` 都 200 但 0 条带日期的行） | — | JS 单页应用，HTML 里没有列表条目 → **如实报空 + 原因** |
 * | lms 思源学堂 | 无（首页 400，两个兜底页也没有条目） | — | 整站要 jAccount 登录，匿名读不到（与 `working:false` 的原因一致） |
 * | qianxuesen 钱学森书院 / sei 软件学院 | 未探测（域名本身连不上） | — | 与 `working:false` 的原因一致；要内容走 `www`/`bjb` 的搜索 |
 *
 * 诚实说明两句：
 *   ① "最新"= **该站栏目页上列出的最新一条的发布日期**，不是"今天有新闻"；
 *      有些栏目本来就更新慢（pksy 通知停在 2025-11、zlsy 通知停在 2024-01、cssy 新闻停在 2023-09），
 *      这不是抓取坏了 —— `readSiteNews` 会把这些真实日期照原样返回。
 *   ② 全是 JS 渲染的列表页（HTML 里没有条目）读不到，会**返回空 + 每页的原因**，
 *      绝不拿导航链凑数（`ehall` 实测就是这样）。
 */

/** 站内直搜的站点级并发上限：3。再高容易触发站群 WAF，收益也有限。 */
export const CAMPUS_SEARCH_CONCURRENCY = 3;
/** 单个校内站点检索的超时（比公共搜索短：站点自己的检索通常 1–4s 就有响应）。 */
export const CAMPUS_SITE_TIMEOUT_MS = 6_000;

/**
 * 一条结果"凭什么算校内的"——数值越小越优先（campus 档按它排序）：
 *   - `column`  **栏目列表直读**：直接把目标站点自己的新闻/通知栏目页抓下来。条目是校方原文，
 *               而且带**发布日期**（`publishedAt`）。在"最近/最新有什么"这类问法里它排第一。
 *   - `site`    站内站点自己的检索接口命中（校方发布的内容页）
 *   - `domain`  公共结果页给出的链接落在 `*.xjtu.edu.cn`（域名对，但页面可能是转载/跳板）
 *   - `mention` 公网结果的标题/摘要里提到本校（最弱：只是"提到了"，页面本身在校外）
 *   - `web`     其它公网结果（校内档里排在最后）
 *
 * **为什么 `column` 单独占最高一档，而不是和 `site` 并列**：两者回答的不是同一个问题。
 * `site` 回答"站内搜索里谁匹配了关键词"，而真机反馈证明它恰恰在"最近有什么新闻"上失灵 ——
 * VSB 站群的列表页常常没被站内搜索收录、或收录明显滞后（用户问「最近航天学院有什么新闻」，
 * 站内直搜命中的全是 `/info/1035/`、`/info/1093/` 这类招生栏目，学院新闻停在年初）。
 * `column` 回答的是"这个站点此刻最新发布的几条是什么"，**按时间**而不是按关键词，
 * 而且直接读校方栏目页原文。用户问"最近/最新"时后者才是他要的东西。
 * 并列（同分）的话，胜负会退化成"哪个通道先产出"，随站点表顺序漂移，不是个稳定口径。
 */
export const MATCHED_BY_RANK = Object.freeze({ column: 0, site: 1, domain: 2, mention: 3, web: 4 });

/** 取一条结果的档位序号（没有 `matchedBy` 的当公网处理）。 */
export function matchedByRank(item) {
  if (!item || item.scope !== 'campus') return MATCHED_BY_RANK.web;
  return MATCHED_BY_RANK[item.matchedBy ?? 'domain'] ?? MATCHED_BY_RANK.domain;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 2_500;
/** 单个页面最多读多少字符再清洗（防止一个几 MB 的页面把内存吃满）。 */
const MAX_HTML_BYTES = 1_500_000;

/**
 * 结果页解析必须伪装成浏览器：默认 UA（node）会被搜索引擎直接回验证码，
 * 这不是"绕过反爬"，而是拿回和普通浏览器一样的公开结果页 —— 真被拦时我们照样如实报空。
 *
 * **诚实说明**（2026-10-13 实测）：把 UA/Accept/Accept-Language 都换成浏览器那套之后，
 * `baike.baidu.com` 与 `zhuanlan.zhihu.com` 依然回 **403**（裸头与浏览器头一模一样）——
 * 那是对出口 IP 的风控，不是请求头能解决的。加头能改善的是"普通站点把 node 当爬虫"这一类。
 * 另外：**不带 Cookie、不伪造登录态**，这是底线（要登录的内容不该靠抓）。
 */
const BROWSER_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  // 浏览器做文档级导航时一定会带它；不带会显得比浏览器"更可疑"
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
});

/**
 * 搜索引擎的跳转链要带上来源站 Referer。
 * 百度/搜狗/360 的自然结果 href 都是自家跳转链（`/link?url=…`、`/link?m=…`），
 * 这类 URL 直接从别处点过去时对方偶尔会 403；带上来源站的 Referer 就正常了。
 */
const ENGINE_REFERERS = Object.freeze([
  ['baidu.com', 'https://www.baidu.com/'],
  ['sogou.com', 'https://www.sogou.com/'],
  ['so.com', 'https://www.so.com/'],
  ['bing.com', 'https://www.bing.com/'],
]);

/** 该 URL 该带哪个 Referer（不是跳转链就返回空串）。 */
export function defaultReferer(raw) {
  const url = parseUrl(raw);
  if (!url) return '';
  const host = url.hostname.toLowerCase();
  for (const [suffix, referer] of ENGINE_REFERERS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return referer;
  }
  return '';
}

/** 去重时要丢掉的跟踪参数（同一条结果带不带 utm_* 都是同一条）。 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'spm', 'from_source', 'ref', 'referer', 'source_from']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 日志适配：允许三种写法
 *   1. `log(message)` —— 测试里最省事；
 *   2. `log(level, message)` —— chat-service 传进来的 `this.logger`，按"级别 + 正文"两条参数；
 *   3. `{ warn, info, error }` 对象（照 console 的形状）。
 * 用「形参个数」区分 1 与 2：写 `(message) => …` 的只吃第一条，
 * 写 `(level, message) => …` 的两条都要，谁也不会拿到 `undefined`。
 */
function makeLogger(log) {
  if (!log) return noop;
  if (typeof log === 'function') {
    if (log.length >= 2) {
      return (message, level = 'info') => {
        try {
          log(level, `[web-search] ${message}`);
        } catch {
          /* 日志失败绝不能影响检索本身 */
        }
      };
    }
    return (message) => {
      try {
        log(`[web-search] ${message}`);
      } catch {
        /* 同上 */
      }
    };
  }
  if (typeof log === 'object') {
    const fn = log.warn ?? log.info ?? log.debug ?? log.log;
    if (typeof fn === 'function') {
      return (message, level = 'info') => {
        try {
          const target = (level === 'warn' && typeof log.warn === 'function' ? log.warn : fn).bind(log);
          target(`[web-search] ${message}`);
        } catch {
          /* 同上 */
        }
      };
    }
  }
  return noop;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * 把外部传进来的 limit **收敛**到 5–30（而不是抛错）。
 *
 * 为什么运行时收敛、配置项却抛错：配置是用户手填的，填错必须立刻告诉他；
 * 而 limit 可能来自模型生成的工具参数 —— 模型偶尔传 0 或 100，
 * 这时候"少读几页"远好于"整轮对话报错"。
 */
export function normalizeSearchLimit(value, { fallback = SEARCH_LIMIT_DEFAULT } = {}) {
  const base = clampInt(fallback, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  return clampInt(value, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX, base);
}

/** 把值限制在 [min,max]；非法/缺省时用 fallback。 */
function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 超时用 AbortController 而不是 AbortSignal.timeout：后者在部分注入的 fetch 里不可用。 */
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  // 计时器 unref：否则测试进程会被一个待触发的 8s 定时器拖住
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function describeError(error) {
  if (!error) return '未知错误';
  const name = error.name ?? '';
  const message = error.message ?? String(error);
  if (name === 'AbortError' || /aborted|timeout/i.test(message)) return `请求超时或被中断（${message}）`;
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return `域名解析失败（${message}）`;
  if (/ECONNREFUSED/.test(message)) return `连接被拒绝（${message}）`;
  if (/certificate|self-signed/i.test(message)) return `TLS 证书校验失败（${message}）`;
  return message;
}

function parseUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** 该 URL 是否属于校内站点（后缀匹配，含子站）。 */
export function isCampusUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return CAMPUS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 去重用的规范化 URL。
 * 去掉 hash、`www.` 前缀、跟踪参数和末尾斜杠 —— 同一条结果往往以好几种写法出现。
 */
export function canonicalUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || /^utm_/i.test(key)) url.searchParams.delete(key);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.toString();
}

/**
 * 明显的垃圾结果：搜索引擎自己的检索页/站内跳转、静态资源、非 http(s) 链接。
 *
 * 特别说明**百度**：它的自然结果 href 基本都是 `www.baidu.com/link?url=…`，
 * 直接按"站内跳转"丢掉等于百度一路全废。这类链接跟着跳一次就能到真正的目标页
 * （`readPages` 抓正文时本来就会 follow 跳转），所以**保留**；
 * 真正要丢的是回到搜索页自身的链接（`/s?wd=`、`bing.com/search`）。
 */
export function isJunkUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return true;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (/(^|\.)bing\.com$/.test(host) && path.startsWith('/search')) return true;
  if (/(^|\.)baidu\.com$/.test(host) && path.startsWith('/s')) return true;
  if (/(^|\.)google\./.test(host) && path === '/search') return true;
  if (/(^|\.)sogou\.com$/.test(host) && path.startsWith('/web')) return true;
  if (/(^|\.)so\.com$/.test(host) && path.startsWith('/s')) return true;
  if (/\.(?:jpe?g|png|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|eot|mp4|mp3|avi|zip|rar|7z|exe|dmg|apk|pdf)$/i.test(path)) {
    return true;
  }
  return false;
}

/** HTML 实体解码（结果页里的标题/摘要几乎必然带实体）。 */
export function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
    middot: '·', times: '×', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
    deg: '°', plusmn: '±', frac12: '½', bull: '•', dagger: '†', permil: '‰', euro: '€',
    pound: '£', yen: '¥', sect: '§', para: '¶', szlig: 'ß', agrave: 'à', eacute: 'é',
  };
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const lower = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

/** 折叠空白：把连续空白压成一个空格，保留换行（正文分段靠换行）。 */
function collapseWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 结果页摘要这种**单行**文本：连换行也压成空格。 */
function collapseInline(text) {
  return collapseWhitespace(text).replace(/\s*\n\s*/g, ' ').trim();
}

/** 取第一段匹配并清理成纯文本。 */
function firstText(html, regex) {
  const match = regex.exec(String(html ?? ''));
  return match ? stripTitleTags(match[1]) : '';
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '));
}

/**
 * 标题/摘要这类"要给人看的一行文本"：标签**直接删掉**，只有块级标签换成空格。
 *
 * 为什么不能统一用 `stripTags`：它把每个标签都换成空格，而检索结果页普遍会把命中关键词的
 * 每个词单独包一层高亮标签（`<em>`、`<strong>`、`<span class="keywordfontcolor…">`），
 * 于是"本科生转专业"会变成"本科生 转 专业"。真网实测：校内 12 个站点里 11 个的标题带高亮 span，
 * 搜狗/360/Bing 也都用 `<em>` 高亮 —— 用错清洗函数会同时毁掉可读性与相关度计算。
 */
function stripTitleTags(html) {
  const text = String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|ul|ol|table)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return collapseInline(decodeEntities(text));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 统一的一次请求。**永远不 throw**：把失败折叠成 `{ ok:false, error }`，
 * 因为调用方（搜一批页 / 探测一批域名）必须能"一条失败不影响其余"。
 *
 * 请求头默认就是一套浏览器头（见 `BROWSER_HEADERS`）；`referer` 不传时会按 URL 自动判断
 * （搜索引擎跳转链带上来源站，普通站点不带）。**不带 Cookie**，也不伪造登录态。
 */
export async function requestText(fetchImpl, url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = '*/*',
    referer,
  } = options;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, status: 0, url, error: '当前运行环境没有可用的 fetch（Node 版本过低？）' };
  }
  const finalReferer = referer === undefined ? defaultReferer(url) : String(referer ?? '');
  const timer = withTimeout(timeoutMs);
  try {
    const response = await doFetch(url, {
      method,
      headers: {
        ...BROWSER_HEADERS,
        Accept: accept,
        ...(finalReferer ? { Referer: finalReferer } : {}),
        ...headers,
      },
      body,
      redirect: 'follow',
      signal: timer.signal,
    });
    if (!response) return { ok: false, status: 0, url, error: 'fetch 没有返回 Response' };
    const status = Number(response.status ?? 0);
    const contentType = String(response.headers?.get?.('content-type') ?? '');
    let text = '';
    try {
      text = String((await response.text()) ?? '');
    } catch (error) {
      return { ok: false, status, url: response.url || url, contentType, error: `读取响应体失败：${describeError(error)}` };
    }
    if (text.length > MAX_HTML_BYTES) text = text.slice(0, MAX_HTML_BYTES);
    return { ok: Boolean(response.ok), status, url: response.url || url, contentType, body: text };
  } catch (error) {
    return { ok: false, status: 0, url, error: describeError(error) };
  } finally {
    timer.done();
  }
}

// ---------------------------------------------------------------------------
// 结果页解析（无 key 通道）
// ---------------------------------------------------------------------------

/** 广告容器标记：结果页里最稳的"广告位"特征就是这些 class / 属性。 */
const AD_MARKERS = /(?:^|[\s"'=])(?:b_ad|b_algo_ad|ec_ad|data-tuiguang|adtag|ad-icon|result-op)(?:[\s"'=]|$)/i;

/** 反爬/风控页面的特征词。命中就当作"被拦截"，而不是"搜到 0 条"。 */
const BLOCK_MARKERS = [
  '验证码', '安全验证', '请输入验证码', '滑块验证', '人机验证', '访问过于频繁', '异常流量',
  'wappass', 'passport.baidu.com/v2/?login', 'captcha', 'unusual traffic', 'are you a robot',
  'verify you are human', 'enable javascript and cookies', '请求被拦截', '网络不给力',
];

/** 把 HTML 按"结果块起始标签"切开：搜索引擎的结果容器都有稳定 class，比整页 DOM 解析稳。 */
function splitBlocks(html, openRegex) {
  const source = String(html ?? '');
  const matches = [...source.matchAll(openRegex)];
  return matches.map((match, index) => ({
    header: match[0],
    body: source.slice(
      (match.index ?? 0) + match[0].length,
      index + 1 < matches.length ? matches[index + 1].index : source.length,
    ),
  }));
}

function firstAnchor(html) {
  const match = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(String(html ?? ''));
  if (!match) return null;
  return { href: decodeEntities(match[1]).trim(), text: stripTitleTags(match[2]) };
}

/**
 * href → 绝对 URL。
 *
 * **必须有这一步**：搜狗的自然结果 href 是站内相对路径（`/link?url=…`），
 * 不解析就既过不了 `isJunkUrl`（相对 URL 拿不到 host，一律当垃圾），
 * 也没法在 `readPages` 里 follow —— 实测里这一条会让搜狗"整个引擎一条结果都不剩"。
 */
function absolutize(href, baseUrl) {
  const raw = decodeEntities(String(href ?? '')).trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return '';
  }
}

function toResult(anchor, snippet, source, baseUrl = '') {
  if (!anchor?.href || !anchor.text) return null;
  const href = baseUrl ? absolutize(anchor.href, baseUrl) : anchor.href;
  if (!href || isJunkUrl(href)) return null;
  return { title: anchor.text, url: href, snippet: collapseInline(snippet).slice(0, 400), source };
}

/** 解析 Bing 结果页（`<li class="b_algo">…</li>`）。结构变了就返回空数组，由调用方如实报错。 */
export function parseBingResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<p\b[^>]*>([\s\S]*?)<\/p>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'bing-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/** 解析百度结果页（`<div class="result c-container">…</div>`）。 */
export function parseBaiduResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<div[^>]*class=["'][^"']*c-abstract[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<span[^>]*class=["'][^"']*(?:content-right|c-color-text|abstract)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*c-span-last[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'baidu-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/**
 * 解析搜狗结果页（`<div class="vrwrap">…</div>`）。
 *
 * 真网实测（2026-10-13）结构：
 *   `<div class="vrwrap" id="sogou_vr_30000000_wrap_1"><h3 class="vr-title"><a href="/link?url=…">标题</a></h3>
 *    <div class="fz-mid space-txt base-ellipsis clamp2" id="cacheresult_summary_1">摘要</div>`
 * 自然结果的 href 是**站内相对路径** `/link?url=…` 跳转链（和百度 `www.baidu.com/link?url=` 一个套路）：
 * 这种链接必须先解析成绝对 URL 再保留 —— 相对链接过不了 `isJunkUrl`（拿不到 host，会被当成垃圾），
 * `readPages` 也没法 follow 它。实测口径：这一步不做，搜狗会"整个引擎一条结果都不剩"。
 */
export function parseSogouResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<div[^>]*class=["'][^"']*\bvrwrap\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<div[^>]*class=["'][^"']*(?:space-txt|fz-mid|str_info|text-layout)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<div[^>]*id=["']cacheresult_summary_\d+["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'sogou-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/**
 * 解析 360 搜索结果页（`<li class="res-list">…</li>`）。
 *
 * 真网实测（2026-10-13）结构：
 *   `<li class="res-list referer-news-flow"><h3 class="res-title"><a href="https://www.so.com/link?m=…">标题</a></h3>
 *    <p class="res-desc">摘要</p><p class="g-linkinfo"><cite>真实站点</cite></p></li>`
 * 注意两点：① 自然结果是 `so.com/link?m=…` 跳转链（保留，同上）；
 * ② 页面里还有"墨盒卡片"类结果（天气卡等，没有 `res-list` 类），按容器切块时天然不会混进来。
 */
export function parse360Results(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<li[^>]*class=["'][^"']*\bres-list\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<p[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, '360-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/** 各引擎结果块的"结构指纹"：有它才算拿到了真结果页。 */
const STRUCTURE_MARKERS = Object.freeze({
  bing: /b_algo/i,
  baidu: /\bresult\b/i,
  sogou: /\bvrwrap\b/i,
  so360: /\bres-list\b/i,
});

/**
 * 命中反爬/改版特征就返回原因文本，否则 null。
 *
 * 判定顺序刻意是「先看有没有结果块，再看风控特征」：
 * 结构指纹在就已经说明拿到了真结果页，此时页面多短都无所谓
 * （小站点/测试页可能只有几百字节，不能因为短就误判成被拦）。
 */
export function detectAntiBot(engine, status, body) {
  const text = String(body ?? '');
  if (status === 403 || status === 429 || status === 418) return `HTTP ${status}（被拒绝/限流）`;
  if (status >= 500) return `HTTP ${status}（对方服务异常）`;
  const lower = text.toLowerCase();
  for (const marker of BLOCK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return `命中风控页特征「${marker}」`;
  }
  const structure = STRUCTURE_MARKERS[engine];
  if (structure && structure.test(text)) return null;
  return `页面里没有 ${engine} 的结果块（响应 ${text.length} 字节，结构可能已改版或被风控页替换）`;
}

// ---------------------------------------------------------------------------
// 相关度：判断"这一批结果到底有没有答在问题上"
// ---------------------------------------------------------------------------

/**
 * 查询词里的功能词。它们出现在结果里不代表搜到了相关内容 ——
 * 典型的坑是"最近有什么单位来访我们航空航天学院吗"里的"最近/什么/我们/吗"。
 */
const QUERY_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '有', '没', '不', '也', '都', '就', '还', '又',
  '我', '我们', '你', '你们', '他', '他们', '她', '它', '这', '那', '这个', '那个', '这些', '那些',
  '什么', '怎么', '怎样', '如何', '哪些', '哪个', '哪里', '为什么', '多少', '几', '吗', '呢', '吧',
  '啊', '呀', '哦', '请问', '一下', '一个', '可以', '需要', '应该', '以及', '关于', '对于', '如果',
  // 注意「今天 / 明天 / 今年」这类**不**算功能词：它们出现在结果里是实打实的信息
  //（"西安天气预报**今天**"就靠它把无关的旅游攻略压下去），丢了反而降低区分度
  '最近', '现在', '目前', '有没有', '是不是', '能不能', '怎么样',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'why',
]);

/**
 * 把检索词切成"内容词"。
 *
 * 没有分词器（零依赖）时的取舍：
 *   - 按空白/标点切成 token，丢掉整词都是功能词的 token；
 *   - ASCII/数字 token 长度 ≥ 2 才要（单字母没信息量）；
 *   - **中文长 token 再切成 2 字片段**：中文关键词常常整串写在一起（"航空航天学院"），
 *     整串去比对一个字都不能差，切片段才能量出"覆盖了几成"。
 *     片段会跨词边界（"空航"这种），但它是**所有引擎一起被扣分**，不影响引擎之间的比较。
 *
 * @returns {string[]} 去重后的词表（最多 16 个，够用且让 notes 不至于太长）
 */
export function queryTerms(query, { max = 16 } = {}) {
  const tokens = String(query ?? '')
    .toLowerCase()
    // 检索语法（`site:xjtu.edu.cn` / `filetype:pdf` / `intitle:xx`）是**过滤器**，不是内容词。
    // 不摘掉的话它们会变成 site/xjtu/edu/cn 这样的"查询词"，把覆盖率整体拉低 ——
    // campus 档的检索词天生带 `site:xjtu.edu.cn`，实测会被这套算法误判成"引擎答非所问"。
    .replace(/\b(?:site|filetype|inurl|intitle|inanchor|allintext|allintitle)\s*:\s*\S+/gi, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const terms = new Set();
  for (const token of tokens) {
    if (QUERY_STOPWORDS.has(token)) continue;
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2) terms.add(token);
      continue;
    }
    if (token.length <= 3) {
      terms.add(token);
      continue;
    }
    for (let i = 0; i + 2 <= token.length; i += 1) {
      const gram = token.slice(i, i + 2);
      if (!QUERY_STOPWORDS.has(gram)) terms.add(gram);
    }
  }
  return [...terms].slice(0, max);
}

/**
 * 一条结果对查询词的覆盖度 0–1。
 *
 * 权重口径：**命中在标题**里算满分（标题是这条结果在讲什么的最强信号），
 * **只在摘要**里命中打 6 折（摘要常常只是顺带提到），完全没命中算 0 分。
 * 于是"查询词 5 个只命中 1 个"≈0.2，能一眼看出这批结果答非所问。
 */
export function relevanceScore(terms, item = {}) {
  const list = Array.isArray(terms) ? terms : [];
  if (!list.length) return 1; // 查询词全是功能词（例如"最近怎么样"）→ 无从判断，不惩罚
  const title = String(item.title ?? '').toLowerCase();
  const snippet = String(item.snippet ?? '').toLowerCase();
  let hit = 0;
  for (const term of list) {
    if (title.includes(term)) hit += 1;
    else if (snippet.includes(term)) hit += 0.6;
  }
  return Math.min(1, hit / list.length);
}

/** 一批结果的平均覆盖度（**按解析出的全部条目算**，不是只算留下来的那些）。 */
export function averageRelevance(terms, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  const total = list.reduce((sum, item) => sum + relevanceScore(terms, item), 0);
  return total / list.length;
}

/**
 * 免密钥通道选引擎的口径：
 *   - 单引擎平均覆盖度 **≥ 0.5** 就认为"答在问题上了"，立即采用、不再打后面的引擎；
 *   - 低于 0.5 就接着试下一个（最多试 3 个），最后取平均覆盖度最高的那一批；
 *   - 覆盖度为 0 的单条结果**直接丢**（"西安"这类单字命中就是把结果带跑的元凶）。
 */
export const SCRAPE_RELEVANCE_THRESHOLD = 0.5;
export const SCRAPE_MAX_ENGINES = 3;

/**
 * 把查询参数拼到端点上。
 *
 * 端点允许被 `config.searchEndpoints` 覆盖（测试注入本地假服务器、或接自建网关），
 * 而**覆盖值本身可能已经带了参数**（例如 `.../bing?mode=captcha`），
 * 所以统一用 URLSearchParams 追加，而不是字符串拼 `?`。
 */
function withParams(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * 免密钥通道的引擎优先级（2026-10-13 真网实测）。
 *
 * 为什么把 Bing 从第一位挪到第三位：同一条网络下，Bing 的结果页对中文查询给的是**降级结果** ——
 * 实测查询 `西安 天气预报 今天`：Bing（网页与 RSS 都是 10 条）返回的是"西安市_百度百科 / 西安旅游攻略 /
 * 西安市政府 / 百度地图 geocoder"，**一条天气都没有**，而页面标题与搜索框都确认查询词完整送达；
 * 同一时刻搜狗给出"西安天气预报一周,15天…"、360 给出"西安天气预报_15天_45天天气查询…"。
 * 另一组查询"最近有什么单位来访我们航空航天学院吗"也是同样症状（"西安"把结果带跑）。
 * 所以默认按 **搜狗 → 360 → Bing → 百度** 试，并且用相关度而不是固定顺序来决定信谁。
 */
const SCRAPE_ENGINES = Object.freeze([
  {
    id: 'sogou',
    label: '搜狗',
    origin: 'https://www.sogou.com/web',
    params: (query, limit) => ({ query, num: limit }),
    parse: parseSogouResults,
  },
  {
    id: 'so360',
    label: '360 搜索',
    origin: 'https://www.so.com/s',
    params: (query) => ({ q: query }),
    parse: parse360Results,
  },
  {
    id: 'bing',
    label: 'Bing',
    origin: 'https://www.bing.com/search',
    params: (query, limit) => ({ q: query, count: limit, setlang: 'zh-CN', ensearch: '0' }),
    parse: parseBingResults,
  },
  {
    id: 'baidu',
    label: '百度',
    origin: 'https://www.baidu.com/s',
    params: (query, limit) => ({ wd: query, rn: limit }),
    parse: parseBaiduResults,
  },
]);

/** 免密钥通道会按顺序试哪些引擎（导出让调用方/界面能如实说明）。 */
export const SCRAPE_ENGINE_IDS = Object.freeze(SCRAPE_ENGINES.map((engine) => engine.id));

/**
 * 按**相关度**在免密钥通道里选引擎，而不是赌固定顺序里的第一个。
 *
 * 规则（详见 `SCRAPE_RELEVANCE_THRESHOLD` 的注释）：
 *   1. 依次试引擎，每个引擎解析完就按 `title + snippet` 算平均覆盖度；
 *   2. 覆盖度 ≥ 阈值 → 立即采用（省掉后面的请求）；
 *   3. 覆盖度 < 阈值 → 记一条"为什么换引擎"，继续试下一个；
 *   4. 最多试 `SCRAPE_MAX_ENGINES` 个；**但如果这 3 个一条可用结果都没给出来**
 *      （全被拦/全是 0 覆盖度），允许再补试剩下的引擎一次 —— "全空"比"多一次请求"糟得多；
 *   5. 覆盖度为 0 的条目一律丢掉，最后返回平均覆盖度最高的那一批；
 *   6. 最好的那批仍低于阈值时**照样返回**（毕竟是真的抓到的），但 notes 里必须写清相关度偏低，
 *      让模型知道"这次没搜准"，而不是把无关结果当成答案。
 */
async function scrapeSearch({ query, limit, fetchImpl, endpoints = {}, note }) {
  const terms = queryTerms(query);
  const attempts = [];
  let best = null;
  let tried = 0;
  /**
   * 本次允许试几个引擎。正常是 `SCRAPE_MAX_ENGINES`（3）；
   * 到上限时如果**一条可用结果都还没拿到**，就把预算放宽 1 —— "空手而归"比"多一次请求"糟得多。
   * 注意放宽的判定放在每次尝试之后（不管这次是成功还是被拦），否则"三个引擎全被墙"这种
   * 最需要兜底的情况反而轮不到第 4 个引擎。
   */
  let budget = Math.min(SCRAPE_MAX_ENGINES, SCRAPE_ENGINES.length);

  while (tried < budget && tried < SCRAPE_ENGINES.length) {
    const engine = SCRAPE_ENGINES[tried];
    tried += 1;
    // 失败原因**立刻**记一条：如果后面的引擎成功了也不能把前面失败的事实吞掉
    // （用户看到的"为什么最后用的是 360 的结果"必须能在日志里找到答案）
    const fail = (reason) => note(`免密钥通道失败：${reason}`, 'warn');
    const url = withParams(endpoints[engine.id] ?? engine.origin, engine.params(query, limit));
    const response = await requestText(fetchImpl, url, { timeoutMs: DEFAULT_TIMEOUT_MS, accept: 'text/html' });
    if (!response.ok) {
      fail(`${engine.label} 请求失败：${response.error ?? `HTTP ${response.status}`}`);
    } else {
      const blocked = detectAntiBot(engine.id, response.status, response.body);
      if (blocked) {
        fail(`${engine.label} 被反爬/改版挡住：${blocked}`);
      } else {
        let items = [];
        try {
          // baseUrl 传的是**响应最终 URL**：搜狗等引擎的结果 href 是相对路径，必须据此解析成绝对链接
          items = engine.parse(response.body, { baseUrl: response.url || url }) ?? [];
        } catch (error) {
          fail(`${engine.label} 解析结果页时抛错：${error.message}`);
          items = [];
        }
        if (!items.length) {
          fail(`${engine.label} 解析出 0 条（页面结构可能已变化）`);
        } else {
          const scored = items.map((item) => ({ item, score: relevanceScore(terms, item) }));
          const kept = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
          const average = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
          const dropped = items.length - kept.length;
          const hits = terms.length ? `（查询词 ${terms.length} 个，平均覆盖率 ${average.toFixed(2)}）` : '';
          const dropNote = dropped ? `，丢掉 ${dropped} 条覆盖率 0 的结果` : '';
          attempts.push({
            engine: engine.id,
            label: engine.label,
            count: items.length,
            kept: kept.length,
            relevance: Number(average.toFixed(2)),
          });

          if (average >= SCRAPE_RELEVANCE_THRESHOLD && kept.length) {
            note(
              `免密钥通道：结果页解析成功 —— ${engine.label} 给出 ${items.length} 条、平均相关度 ${average.toFixed(2)}${hits}`
              + `${dropNote} → 达到阈值 ${SCRAPE_RELEVANCE_THRESHOLD}，采用它（未配置搜索 API 密钥，走免密钥通道）`,
            );
            return kept;
          }
          note(
            `免密钥通道：${engine.label} 给出 ${items.length} 条，但平均相关度只有 ${average.toFixed(2)}${hits}${dropNote}`
            + ` → 低于阈值 ${SCRAPE_RELEVANCE_THRESHOLD}，换下一个引擎试试`,
            'warn',
          );
          if (!best || average > best.relevance) best = { engine, kept, relevance: average, count: items.length };
        }
      }
    }
    // 到预算了：已经有可用结果就收工，否则放宽 1 再试一个（只放宽一次）
    if (tried >= budget && tried < SCRAPE_ENGINES.length) {
      if (best && best.kept.length) break;
      budget += 1;
      note('免密钥通道：已试的引擎都没给出可用结果 → 再多试一个引擎（最后一搏）');
    }
  }

  if (best && best.kept.length) {
    const perEngine = attempts.map((entry) => `${entry.label} ${entry.relevance.toFixed(2)}`).join(' / ');
    note(
      `免密钥通道：共试了 ${tried} 个引擎（各自相关度：${perEngine}），采用相关度最高的 ${best.engine.label}`
      + `（${best.relevance.toFixed(2)}，共 ${best.count} 条、按相关度保留 ${best.kept.length} 条）。`
      + `**相关度仍低于阈值 ${SCRAPE_RELEVANCE_THRESHOLD}**，这批结果可能答非所问：`
      + '请如实告诉用户"这次没搜准"，可以换个说法再搜，不要硬当成答案。',
      'warn',
    );
    return best.kept;
  }

  note(
    `已尝试免密钥通道（${SCRAPE_ENGINES.slice(0, Math.max(tried, 1)).map((engine) => engine.label).join(' → ')}）都没有取到可用结果 → 返回空数组。`
      + '**这不是「搜到 0 条」，而是「没能取到搜索结果」**：可能被反爬拦截、结果页改版、'
      + '当前网络访问不到这些站点，或者引擎返回的内容与关键词完全对不上（相关度为 0）。',
  );
  return [];
}

// ---------------------------------------------------------------------------
// API 通道（有 key 时优先）
// ---------------------------------------------------------------------------

/**
 * 四家搜索 API 的适配。每家的形状都不一样，但都收敛成 `[{title,url,snippet,source}]`。
 * `endpoints` 允许覆盖 URL —— 测试注入本地假服务器，也方便接自建网关。
 */
const API_PROVIDERS = {
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    endpoint: 'https://api.tavily.com/search',
    build: (query, limit, key) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic', include_answer: false }),
    }),
    parse: (json) =>
      (json?.results ?? []).map((item) => ({ title: item?.title, url: item?.url, snippet: item?.content, source: 'tavily' })),
  },
  brave: {
    id: 'brave',
    label: 'Brave Search',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    build: (query, limit, key) => ({
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }),
    url: (endpoint, query, limit) => withParams(endpoint, { q: query, count: limit }),
    parse: (json) =>
      (json?.web?.results ?? []).map((item) => ({
        title: item?.title,
        url: item?.url,
        snippet: item?.description,
        source: 'brave',
      })),
  },
  serper: {
    id: 'serper',
    label: 'Serper',
    endpoint: 'https://google.serper.dev/search',
    build: (query, limit, key) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: limit }),
    }),
    // Serper 的字段名是 `link`；个别自建网关会回 `url`，两个都认
    parse: (json) =>
      (json?.organic ?? []).map((item) => ({
        title: item?.title,
        url: item?.link ?? item?.url,
        snippet: item?.snippet,
        source: 'serper',
      })),
  },
  bing: {
    id: 'bing',
    label: 'Bing Web Search',
    endpoint: 'https://api.bing.microsoft.com/v7.0/search',
    build: (query, limit, key) => ({
      method: 'GET',
      headers: { Accept: 'application/json', 'Ocp-Apim-Subscription-Key': key },
    }),
    url: (endpoint, query, limit) =>
      withParams(endpoint, { q: query, count: limit, mkt: 'zh-CN', responseFilter: 'Webpages' }),
    parse: (json) =>
      (json?.webPages?.value ?? []).map((item) => ({
        title: item?.name,
        url: item?.url,
        snippet: item?.snippet,
        source: 'bing',
      })),
  },
};

/** 从配置里取出「每个 provider 各自的密钥」。 */
export function normalizeSearchKeys(config = {}) {
  const keys = {};
  const explicit = config.searchApiKeys;
  if (explicit && typeof explicit === 'object') {
    for (const provider of SEARCH_PROVIDERS) {
      const value = String(explicit[provider] ?? '').trim();
      if (value) keys[provider] = value;
    }
  }
  // 单个 `searchApiKey` 是"通用密钥"的简写：
  //   - searchProvider 明确指定了某一家 → 就喂给它；
  //   - 否则（auto / scrape / 没填）→ 喂给优先级最高、且还没有专属密钥的那家。
  const single = String(config.searchApiKey ?? '').trim();
  if (single) {
    const wanted = SEARCH_PROVIDERS.includes(config.searchProvider) ? config.searchProvider : null;
    const target = wanted ?? SEARCH_PROVIDERS.find((provider) => !keys[provider]) ?? SEARCH_PROVIDERS[0];
    if (target && !keys[target]) keys[target] = single;
  }
  return keys;
}

/**
 * 决定这一轮用哪个后端。
 *
 * 规则（用户已拍板的口径）：
 *   - `searchProvider = 'auto'`（默认）：**有 key 就用 API**（按 tavily → brave → serper → bing 优先），
 *     一个 key 都没有就退回解析结果页；
 *   - `searchProvider = 'tavily'|'brave'|'serper'|'bing'`：指定的那家有 key 就用它；
 *     没 key 则退到"其它有 key 的"；再没有就退回结果页，并在 reason 里说明；
 *   - `searchProvider = 'scrape'`：强制只解析结果页（哪怕配了 key）。
 *
 * @returns {{kind:'api'|'scrape', id:string, providers:string[], reason:string}}
 */
export function resolveSearchBackend(config = {}) {
  const wanted = String(config.searchProvider ?? 'auto').trim().toLowerCase();
  const keys = normalizeSearchKeys(config);
  const available = SEARCH_PROVIDERS.filter((provider) => keys[provider]);

  if (wanted === 'scrape') {
    return {
      kind: 'scrape',
      id: 'scrape',
      providers: SCRAPE_ENGINES.map((engine) => engine.id),
      reason: '配置要求只用结果页解析（searchProvider=scrape），不调用搜索 API',
    };
  }

  if (SEARCH_PROVIDERS.includes(wanted)) {
    if (keys[wanted]) {
      return { kind: 'api', id: wanted, providers: [wanted], reason: `使用已配置密钥的 ${API_PROVIDERS[wanted].label}` };
    }
    const fallback = available[0];
    if (fallback) {
      return {
        kind: 'api',
        id: fallback,
        providers: [fallback],
        reason: `指定了 ${wanted} 但没有它的密钥；改用已有密钥的 ${API_PROVIDERS[fallback].label}`,
      };
    }
    return {
      kind: 'scrape',
      id: 'scrape',
      providers: SCRAPE_ENGINES.map((engine) => engine.id),
      reason: `指定了 ${wanted} 但没有配置任何搜索 API 密钥 → 退回解析结果页`,
    };
  }

  if (available.length) {
    return {
      kind: 'api',
      id: available[0],
      providers: [available[0]],
      reason: `自动选择：${API_PROVIDERS[available[0]].label}（检测到已配置密钥）`,
    };
  }

  return {
    kind: 'scrape',
    id: 'scrape',
    providers: SCRAPE_ENGINES.map((engine) => engine.id),
    reason: '没有配置任何搜索 API 密钥 → 解析公共搜索引擎结果页（Bing 优先，失败退百度）',
  };
}

/** 调一家 API。失败返回 `{ items: [], error }`，由上层决定是否降级。 */
async function callApiProvider(provider, { query, limit, key, fetchImpl, endpoints = {} }) {
  const spec = API_PROVIDERS[provider];
  const endpoint = endpoints[provider] ?? spec.endpoint;
  const url = spec.url ? spec.url(endpoint, query, limit) : endpoint;
  const init = spec.build(query, limit, key);
  const response = await requestText(fetchImpl, url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    accept: 'application/json',
  });
  if (!response.ok) {
    return { items: [], error: `${spec.label} 请求失败：${response.error ?? `HTTP ${response.status}`}` };
  }
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (error) {
    return { items: [], error: `${spec.label} 返回的不是合法 JSON（${error.message}），可能被网关/风控拦了` };
  }
  if (json?.error || json?.message) {
    // 上游把错误放在 200 的 body 里（Serper/百度系常见），这里必须当失败处理
    const message = json.error?.message ?? json.error ?? json.message;
    return { items: [], error: `${spec.label} 返回错误：${String(message).slice(0, 200)}` };
  }
  let items = [];
  try {
    items = spec.parse(json) ?? [];
  } catch (error) {
    return { items: [], error: `${spec.label} 结果结构不符合预期（${error.message}）` };
  }
  return { items, error: null };
}

// ---------------------------------------------------------------------------
// 去重 / 过滤
// ---------------------------------------------------------------------------

/**
 * 统一把一条候选收敛成 `{title,url,snippet,source,scope}`，垃圾直接丢掉。
 *
 * `matchedBy`（'column' / 'site' / 'domain' / 'mention'）、`site`（来源站点 id）与
 * `publishedAt`（发布日期，栏目直读才有）是可选字段：
 * **原条目带了才写出去** —— 这几个字段已经在 `dedupeResults` 的既有用例里被
 * `deepStrictEqual` 逐字段比对过，多写一个 `undefined` 键也会让那些断言挂掉。
 */
function normalizeResult(raw, scope) {
  if (!raw) return null;
  const url = String(raw.url ?? '').trim();
  if (!url || isJunkUrl(url)) return null;
  const title = collapseInline(raw.title ?? '');
  if (!title) return null;
  const out = {
    title,
    url,
    snippet: collapseInline(raw.snippet ?? '').slice(0, 400),
    source: String(raw.source ?? 'unknown'),
    scope,
  };
  if (raw.matchedBy) out.matchedBy = String(raw.matchedBy);
  if (raw.site) out.site = String(raw.site);
  // 发布日期必须在这里透传：去重是所有通道的必经之路（campus 档尤其），
  // 漏掉它，"最新这条是几月几号"会在最后一步丢掉，模型就只能含糊其辞。
  if (raw.publishedAt) out.publishedAt = String(raw.publishedAt);
  return out;
}

/** 去重（按 canonicalUrl）+ 过滤。campus 档只保留校内站点。 */
export function dedupeResults(items, { scope } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const normalized = normalizeResult(item, item?.scope ?? scope ?? 'web');
    if (!normalized) continue;
    if (normalized.scope === 'campus' && !isCampusUrl(normalized.url)) continue;
    const key = canonicalUrl(normalized.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校园网探测
// ---------------------------------------------------------------------------

/**
 * 探测校内域名是否可达。
 *
 * **只能判断「可达」**：任何一个探测目标给出响应（哪怕 401/403/302）就算可达；
 * 全部超时/DNS 失败才算不可达。它**不能证明**当前真的在校园网内 ——
 * 校内站点也可能对公网开放（那就谁都能"可达"），反之校园网内的 DNS/代理异常也会误判。
 * 因此返回值里固定带 `caveat`，调用方（以及模型）都不该把它当成网络位置的证明。
 */
export async function detectCampusNetwork({ fetchImpl, probes, timeoutMs = PROBE_TIMEOUT_MS, log } = {}) {
  const warn = makeLogger(log);
  const list = Array.isArray(probes) && probes.length ? probes : CAMPUS_PROBES;
  const settle = await Promise.all(
    list.map(async (probe) => {
      const response = await requestText(fetchImpl, probe.url, { timeoutMs, accept: 'text/html' });
      // 有响应（含 404/403/302）就算可达；`status === 0` 表示压根没连上
      const reachable = response.status > 0;
      return {
        url: probe.url,
        label: probe.label ?? probe.url,
        reachable,
        status: response.status,
        error: reachable ? null : (response.error ?? '无响应'),
      };
    }),
  );

  const reachable = settle.filter((probe) => probe.reachable);
  const unreachable = settle.filter((probe) => !probe.reachable);
  const onCampus = reachable.length > 0;
  const reason = onCampus
    ? `校内站点可达：${reachable.map((probe) => probe.label).join('、')}`
      + (unreachable.length ? `；另有 ${unreachable.length} 个不可达（${unreachable.map((p) => p.label).join('、')}）` : '')
    : `校内站点全部不可达（${unreachable.map((probe) => `${probe.label}: ${probe.error}`).join('；')}）`;
  warn(`campus 探测：${reason}`);

  return {
    onCampus,
    // 字段名直白一点，免得调用方把 onCampus 当成"已确认在校园网"
    onCampusNetwork: onCampus,
    reachable,
    unreachable,
    probes: settle,
    reason,
    caveat: CAMPUS_PROBE_CAVEAT,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 校内站点直搜（campus 档的第一条通道）
// ---------------------------------------------------------------------------

/**
 * base64(UTF-8)。**零依赖**手写：不用 Buffer（这个模块要在只注入了 fetch 的环境里也能跑），
 * 也不用 `btoa`（它吃 latin1，中文直接抛错）。VSB 前端那个 `base64.js` 干的正是这件事 ——
 * 页面注释原文：「文字采用 UTF-8 方式进行 Base64 编码」。
 */
export function base64Utf8(text) {
  const bytes = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : alphabet[b2 & 63];
  }
  return out;
}

/** VSB 命中关键词时会给标题里的关键词套一层高亮 —— 判断"这页到底有没有检索结果"最可靠的信号。 */
const VSB_HIGHLIGHT_RE = /keywordfontcolor\s*\d*|color\s*:\s*#dd4b39/i;
/** 发布日期：`2026-07-31` / `2013.05` / `2026年7月4日` 都认（VSB 各模板写得不一致）。 */
const DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*(?:[-/.月]\s*(\d{1,2})\s*日?)?/;

/** 站点允许出现的结果域名：默认只看自己；门户那种"搜全校"的站点用 `allowHosts` 放宽。 */
function allowedHostsOf(site) {
  const list = Array.isArray(site?.allowHosts) && site.allowHosts.length ? site.allowHosts : [site?.host];
  return list.filter(Boolean).map((host) => String(host).toLowerCase().replace(/^\./, ''));
}

function hostAllowed(host, hosts) {
  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * href → 绝对 URL，并且**必须是本站域名下的内容页**，否则返回 null。
 *
 * 丢掉 `.jsp` 链接是这里最要紧的一条经验：VSB 的导航/入口几乎都是 `xynr.jsp?urltype=…`、
 * `index.jsp` 这类脚本页，而检索结果永远是发布出来的内容页（`info/1095/10422.htm`）。
 * 真网实测：教务处那张"没有检索结果"的空页里有 **147 个 `<li>`**，全是导航 ——
 * 不加这条闸门，"搜不到"会被解析成 147 条假结果。
 */
function resolveAllowedUrl(href, baseUrl, hosts) {
  const raw = String(href ?? '').trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
  let url;
  try {
    url = new URL(decodeEntities(raw), baseUrl || undefined);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!hostAllowed(url.hostname.toLowerCase(), hosts)) return null;
  if (/\.jsp$/i.test(url.pathname)) return null;
  // 静态资源（.xlsx/.pdf/.jpg…）与"搜索站自己的检索页"在这里一起丢掉，
  // 与 dedupeResults 用的是同一套判据，免得两处口径不一致
  if (isJunkUrl(url.toString())) return null;
  return url.toString();
}

/**
 * 锚文本（标题/摘要）走公共的 `stripTitleTags`（定义在小工具区）：
 * 校内站点的标题同样会被高亮 span 切碎，和搜索引擎结果页是同一个坑。
 */

/** 取 `block` 里所有 `<a>`：href、class、以及**优先取 `<h3>/<h2>` 的锚文本**。 */
function extractAnchors(block) {
  const out = [];
  for (const match of String(block ?? '').matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `${match[1]} ${match[3]}`;
    const cls = /class=["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
    const inner = match[4];
    // sae 的模板把日期块也塞在 <a> 里，标题必须取 <h3>，否则会读成"08 201 2012级本科生转专业通知"
    const heading = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner);
    out.push({
      href: match[2],
      cls,
      text: stripTitleTags(heading ? heading[1] : inner),
    });
  }
  return out;
}

/** 结果标题：去掉模板塞进同一段文本里的日期（`2021-05-11 文治书院…` / `转专业指导 2018-11-17`）。 */
function cleanResultTitle(text) {
  const inline = collapseInline(text);
  const stripped = inline
    .replace(/^\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*(?:[-/.月]\s*\d{1,2}\s*日?)?\s*/, '')
    .replace(/\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*(?:[-/.月]\s*\d{1,2}\s*日?)?\s*$/, '');
  return stripped || inline;
}

/** 在一段**已经剥掉标签**的文本里找发布日期；`2013.05` 归一成 `2013-05`。 */
function findDate(text) {
  const match = DATE_RE.exec(String(text ?? ''));
  if (!match) return '';
  const [, year, month, day] = match;
  const mm = String(month).padStart(2, '0');
  return day ? `${year}-${mm}-${String(day).padStart(2, '0')}` : `${year}-${mm}`;
}

/** 页面上所有 `<ul>…</ul>`（大小写不敏感：彭康书院的结果容器就是大写 `<UL>`）。 */
function listBlocks(html) {
  const out = [];
  const open = /<ul\b[^>]*>/gi;
  const close = /<\/ul\s*>/gi;
  for (const match of html.matchAll(open)) {
    close.lastIndex = match.index + match[0].length;
    const end = close.exec(html);
    if (end) out.push(html.slice(match.index, end.index + end[0].length));
  }
  return out;
}

/** 高亮所在的 `<ul>`（大小写不敏感）；取不到返回 null。 */
function enclosingList(html, index) {
  const open = /<ul\b[^>]*>/gi;
  let start = -1;
  for (const match of html.matchAll(open)) {
    if (match.index < index) start = match.index;
    else break;
  }
  if (start < 0) return null;
  const close = /<\/ul\s*>/gi;
  close.lastIndex = index;
  const end = close.exec(html);
  return end ? html.slice(start, end.index + end[0].length) : null;
}

/**
 * 找"结果列表"所在的那段 HTML。两步：
 *   ① 页面里有关键词高亮 → 高亮所在的那个 `<ul>` 就是结果列表（实测 12 个站点全部成立）；
 *   ② 没有高亮（关键词只命中正文，或模板关了高亮）→ 在整页 `<ul>` 里挑**带发布日期条目最多**
 *      的那个。导航菜单不会给每个菜单项配发布日期，所以这条判据简单又稳；
 *      一个都挑不到就返回 null —— 宁可这一站报 0 条，也不把导航菜单当结果交出去。
 */
function pickResultRegion(html) {
  const hit = VSB_HIGHLIGHT_RE.exec(html);
  if (hit) {
    const region = enclosingList(html, hit.index);
    if (region) return region;
  }
  let best = null;
  let bestScore = 0;
  for (const block of listBlocks(html)) {
    let score = 0;
    for (const match of block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      if (findDate(stripTags(match[1]))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 解析一张 VSB 检索结果页 → `[{title,url,snippet}]`。
 *
 * 无依赖、只看结构，所以**站点改版时它会安静地返回 0 条**（上层会如实记一笔"解析出 0 条"），
 * 而不是编出别的东西来。已适配的模板形态（都是实测过的真页面）：
 *   - `<li><a href="info/1092/10425.htm"><i>[综合通知] </i>标题</a><span>2026-07-31</span></li>`（教务处）
 *   - `<li><span class="time">2026-07-31</span><a href="…">标题</a></li>`（研究生院/彭康/励志/数学院…）
 *   - `<li><a href="…"><div class="a-date"><b>08</b><span>2013.05</span></div><div><h3>标题</h3></div></a></li>`（航天学院）
 *   - `<li><div><a class="y">2026年07</a><a class="r">04</a></div><div><a class="bt">标题</a><a class="zy2">摘要…</a></div></li>`（新闻网，带摘要）
 *
 * @param {string} html 结果页 HTML
 * @param {{baseUrl?:string, allowHosts?:string[]}} [options] `baseUrl` 把相对链接变成绝对链接；
 *        `allowHosts` 是**只保留这些域名**的白名单（一般就是站点自己的 host）
 */
export function parseVsbSearchResults(html, { baseUrl = '', allowHosts = [] } = {}) {
  const source = String(html ?? '');
  const hosts = (Array.isArray(allowHosts) ? allowHosts : [allowHosts])
    .filter(Boolean)
    .map((host) => String(host).toLowerCase().replace(/^\./, ''));
  if (!source || !hosts.length) return [];

  const highlighted = VSB_HIGHLIGHT_RE.test(source);
  const region = pickResultRegion(source);
  if (!region) return [];

  const out = [];
  const seen = new Set();
  for (const match of region.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const body = match[1];
    const usable = extractAnchors(body)
      .map((anchor) => ({ ...anchor, abs: resolveAllowedUrl(anchor.href, baseUrl, hosts) }))
      .filter((anchor) => anchor.abs && anchor.text);
    if (!usable.length) continue;

    // 标题锚：优先 class 里带 bt/tit/title 的（新闻网的标题就是 class="bt"），
    // 否则取文字最长的那个（日期锚总是短的）
    const titleAnchor =
      usable.find((anchor) => /(?:^|\s)(?:bt|tit|title)(?:\s|$)/i.test(anchor.cls))
      ?? usable.reduce((best, anchor) => (anchor.text.length > best.text.length ? anchor : best));
    const title = cleanResultTitle(titleAnchor.text);
    if (title.length < 4) continue;

    const date = findDate(stripTags(body));
    // 证据不足就丢：既没有发布日期、整页又没有高亮命中 → 大概率是导航/侧栏，不是检索结果。
    // 这条闸门专治"没搜到却返回一版默认列表"的模板（真网实测：门户 www 对垃圾词返回 10 条无关新闻）
    if (!date && !highlighted) continue;

    const summary = usable
      .filter((anchor) => anchor !== titleAnchor)
      .map((anchor) => collapseInline(anchor.text))
      .filter((line) => line.length >= title.length + 8)
      .sort((a, b) => b.length - a.length)[0];
    const key = canonicalUrl(titleAnchor.abs);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url: titleAnchor.abs,
      snippet: collapseInline(summary || (date ? `发布日期：${date}` : '')).slice(0, 400),
    });
  }
  return out;
}

/** 一张站内检索请求的 body：`lucenenewssearchkey=base64(UTF-8)` + 两个必需参数。 */
export function buildCampusSiteSearchBody(site, query) {
  const params = new URLSearchParams();
  params.set(site?.keyField ?? 'lucenenewssearchkey', base64Utf8(query));
  // 实测：缺这两个参数时服务端照样 200，但返回"没有检索结果"的默认页（看着成功、其实没搜）
  params.set('_lucenesearchtype', '1');
  params.set('searchScope', '0');
  return params.toString();
}

/** 某个站点的检索 URL（`origin` 只在测试注入本地假站点时覆盖）。 */
export function buildCampusSiteSearchUrl(site) {
  return new URL(site?.path ?? '/', site?.origin ?? `https://${site?.host}`).toString();
}

/** 查一个站点。**永远不 throw**：请求/解析失败折叠成 `{ok:false, error}`。 */
async function searchOneCampusSite(site, { query, limit, fetchImpl, timeoutMs, log }) {
  const url = buildCampusSiteSearchUrl(site);
  const base = { id: site.id, label: site.label ?? site.host, host: site.host, url };
  const response = await requestText(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildCampusSiteSearchBody(site, query),
    timeoutMs,
    accept: 'text/html',
  });
  if (!response.ok) {
    const error = response.error ?? `HTTP ${response.status}`;
    log(`站内直搜失败：${base.label}（${base.id}）→ ${error}`, 'warn');
    return { ...base, ok: false, count: 0, items: [], error };
  }
  let parsed = [];
  try {
    parsed = parseVsbSearchResults(response.body, {
      baseUrl: response.url || url,
      allowHosts: allowedHostsOf(site),
    });
  } catch (error) {
    const error2 = `解析结果页时抛错：${error?.message ?? error}`;
    log(`站内直搜失败：${base.label}（${base.id}）→ ${error2}`, 'warn');
    return { ...base, ok: false, count: 0, items: [], error: error2 };
  }
  // 最后一道域名闸门：解析器只保证"属于这个站点"，这里再确认它落在 *.xjtu.edu.cn 内
  const items = parsed
    .filter((item) => isCampusUrl(item.url))
    .slice(0, limit)
    .map((item) => ({ ...item, source: 'campus-site', scope: 'campus', matchedBy: 'site', site: site.id }));
  if (!items.length) log(`站内直搜无结果：${base.label}（${base.id}）解析出 0 条`, 'warn');
  return { ...base, ok: true, count: items.length, parsed: parsed.length, items, error: null };
}

/**
 * 校内站点直搜：并发打一批校内站点自己的检索接口（campus 档的第一条通道）。
 *
 * - **站点之间并发、上限 3**（`CAMPUS_SEARCH_CONCURRENCY`）：既快又不容易被站群 WAF 拦；
 * - **单站点失败完全隔离**：超时/500/解析不到只影响它自己，`sites[i].ok === false` + `error` 说原因；
 * - 结果统一带 `scope:'campus'` + `matchedBy:'site'` + `site:'dean'`，一眼能看出这条是
 *   "站内搜出来的"还是"公网结果里提到本校的"；
 * - `working:false` 的站点（实测打不通/没有检索入口）**不发请求**，只记一笔跳过说明。
 *
 * @param {object} options
 * @param {string} options.query 检索词
 * @param {number} [options.limit] 每个站点最多取几条（收敛到 5–30）
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用本地假站点）
 * @param {Function|object} [options.log] 日志
 * @param {Array} [options.sites] 覆盖站点表（测试用；形状同 `CAMPUS_SITE_SEARCH`）
 * @param {number} [options.concurrency] 并发（收敛到 1–3）
 * @param {number} [options.timeoutMs] 单站点超时
 * @returns {Promise<{query:string, results:Array, sites:Array, notes:string[]}>}
 */
export async function searchCampusSites({
  query,
  limit,
  fetchImpl,
  log,
  sites,
  concurrency,
  timeoutMs = CAMPUS_SITE_TIMEOUT_MS,
} = {}) {
  const warn = makeLogger(log);
  const notes = [];
  const note = (message, level = 'info') => {
    notes.push(message);
    warn(message, level);
  };

  const text = String(query ?? '').trim();
  const list = (Array.isArray(sites) && sites.length ? sites : CAMPUS_SITE_SEARCH)
    .filter((site) => site && site.id && site.host);
  const usable = list.filter((site) => site.working !== false);
  const skipped = list.filter((site) => site.working === false);

  if (!text) {
    note('站内直搜：检索词为空，未发起任何请求');
    return { query: '', results: [], sites: [], notes };
  }
  if (!usable.length) {
    note('站内直搜：配置里没有可用站点，本轮跳过（不代表校内没有内容）');
    return { query: text, results: [], sites: [], notes };
  }

  const perSite = clamp(limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const pool = clamp(concurrency, 1, CAMPUS_SEARCH_CONCURRENCY, CAMPUS_SEARCH_CONCURRENCY);
  const reports = new Array(usable.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= usable.length) return;
      const site = usable[index];
      try {
        reports[index] = await searchOneCampusSite(site, {
          query: text,
          limit: perSite,
          fetchImpl,
          timeoutMs,
          log: warn,
        });
      } catch (error) {
        // searchOneCampusSite 已经吞了绝大多数异常；这里再兜一层，保证"一个站点绝不拖垮整批"
        reports[index] = {
          id: site.id,
          label: site.label ?? site.host,
          host: site.host,
          url: buildCampusSiteSearchUrl(site),
          ok: false,
          count: 0,
          items: [],
          error: `检索时发生未预期错误：${error?.message ?? error}`,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, usable.length) }, () => worker()));

  const settled = reports.filter(Boolean);
  const okSites = settled.filter((report) => report.ok);
  const failed = settled.filter((report) => !report.ok);
  const withHits = okSites.filter((report) => report.items.length);
  const emptySites = okSites.filter((report) => !report.items.length);
  const results = okSites.flatMap((report) => report.items);

  if (results.length) {
    note(`站内直搜命中 ${results.length} 条：${withHits.map((r) => `${r.id} ${r.count} 条`).join('、')}`);
  } else {
    note('站内直搜没有命中任何条目（站点可达但关键词没匹配上，或结果页模板已改版）');
  }
  if (emptySites.length) {
    note(`站内直搜解析出 0 条的站点（可能确实没匹配，也可能模板改版）：${emptySites.map((r) => r.id).join('、')}`);
  }
  for (const report of failed) {
    note(`站内直搜失败：${report.label}（${report.id}）→ ${report.error}`, 'warn');
  }
  if (skipped.length) {
    note(
      `站内直搜跳过 ${skipped.length} 个已知不可用的站点（${skipped.map((site) => site.id).join('、')}）：`
      + '实测打不通或没有检索入口，原因写在 CAMPUS_SITE_SEARCH 表里',
    );
  }

  return { query: text, results, sites: settled, notes };
}

// ---------------------------------------------------------------------------
// 栏目列表直读（campus 档的 ⓪ 条通道：不问站内搜索，直接读校方栏目页）
// ---------------------------------------------------------------------------

/**
 * 这一节解决的是真机上暴露的一个具体问题。
 *
 * 用户问「最近我们航天学院有什么新闻吗」，AI 连着搜了两轮如实回答"学院官网的新闻列表页似乎
 * 没被检索到，命中的多是 `/info/1035/`、`/info/1093/` 这类招生栏目""能搜到的学院新闻只到
 * 2026 年 1 月两条"。根因**不是模型不会搜，而是通道用错了**：
 * `searchCampusSites` 走的是各站点自己的检索接口，而 VSB 站群的新闻/通知**列表页经常没被站内
 * 搜索收录、或者索引明显滞后**；而 `sae.xjtu.edu.cn/index/zhxw.htm` 上明明白白列着最近几个月的
 * 学院新闻（2026-10-10 那条就在上面）。
 *
 * 所以这一通道**不问站内搜索，直接读栏目页**：VSB 的列表页是静态 HTML
 * （`<li><a href="../info/1056/9993.htm"><h3>标题</h3></a><div class="tz-date"><span>2026</span><b>10-10</b></div></li>`），
 * 抓下来就是"最新几条"，而且**带发布日期** —— 这正是"最近有什么"要的东西。
 *
 * 三个设计点：
 *   ① **栏目页不硬编码**：优先从首页锚文本（新闻/要闻/动态/通知/公告/学术/讲座…）里现找，
 *      站点改版、换栏目路径都能跟上；首页找不到（JS 渲染的首页、首页抓取失败）时再退到
 *      `CAMPUS_SITE_SEARCH[i].columns`（逐条实测过的兜底清单）与通用兜底路径。
 *   ② **跨域条目一律丢掉**：与 `searchCampusSites` 同一口径（`allowedHostsOf`）。
 *      导航条、友情链接、"合作单位"常跟新闻列表同页，放松域名就等于让"北大教务处的通知"
 *      混进"校内最新通知"里 —— 那不是"不够精确"，那是**假的**。宁可少几条。
 *   ③ **抽不到发布日期的行一律不当条目**：`extractColumnDate` 返回空就丢，并如实记进
 *      `fetched[].count/rows/dated` 与 `notes`。整页都是 JS 渲染、抽不出日期时返回**空 + 原因**，
 *      绝不把导航链或标题当新闻硬塞 —— "搜不到就说搜不到"是本模块的第一原则。
 *
 * 另外：这里**只读列表页、不抓正文**。列表页已经给了标题+链接+日期，足够回答"最近有什么"；
 * 要读某一篇的正文，模型可以用 `fields.url` 直读那一条（已有能力），不必在这里批量抓。
 */
export const COLUMN_LIMIT_DEFAULT = 10;
/** 单个栏目页的超时：和读正文一个量级，列表页通常 0.3–1.5s 就有响应。 */
export const COLUMN_TIMEOUT_MS = 8_000;
/** 一次最多抓几个候选栏目页（加上首页就是 6 个请求）：再多收益很低，还会把站群 WAF 招来。 */
export const COLUMN_CANDIDATE_MAX = 5;
/** 候选栏目页的并发上限（沿用读正文的口径 4）。 */
export const COLUMN_CONCURRENCY = 4;
/** 站点表里 `columns` 最多先占几个候选位（见下面候选排序的说明）。 */
export const COLUMN_CURATED_MAX = 3;
/** 标题截断长度（列表页标题里有很长的讲座名）。 */
export const COLUMN_TITLE_MAX = 120;

/**
 * 首页上"看起来是栏目入口"的锚文本。实测这些词在各站首页都能命中真正的栏目页
 * （sae 的"综合新闻/通知公告/学术讲座"、dean 的"教学动态/教学通知"、pksy 的"书院动态"…）。
 */
export const COLUMN_LINK_TEXT_RE = /新闻|要闻|动态|通知|公告|学术|讲座|综合新闻/;

/**
 * "这个问法是不是想要最新列表"。
 *
 * 只有命中它才会去读栏目页 —— 否则每一条 campus 检索都要多花 2–6 个请求，
 * 而"转专业学分怎么算"这种问题根本不需要最新列表。
 */
export const NEWS_LIST_QUERY_RE = /最新|最近|近期|新闻|要闻|动态|通知|公告|讲座|活动|资讯/;

/**
 * 通用兜底栏目路径（**这是真网逐站探测的结论，不是照模板猜的**）。
 *
 * 2026-10-13 对 12 个可达站点逐个 GET 了 `/xwdt.htm`、`/xyxw.htm`、`/xwzx.htm`、`/tzgg.htm`、
 * `/news.htm`、`/xwzx/xyxw.htm`、`/index/tzgg.htm`：
 *   - `/tzgg.htm` → **pksy / wen / zlsy / gs 四个站 200**，留下；
 *   - `/xwdt.htm` → **gs 一个站 200**（研究生院"新闻动态"），留下；
 *   - `/xyxw.htm`、`/xwzx.htm`、`/news.htm`、`/xwzx/xyxw.htm` → **12 个站全 404**，删掉；
 *   - `/index/tzgg.htm` → 只有 sae 200（那是它自己的栏目路径，已写进 sae 的 `columns`），不做通用兜底；
 *   - `/info/1056/` 这种"栏目 id 入口" → sae 上 **404**（VSB 的栏目入口是 `.htm` 页，不是目录），不做。
 * 留着 404 的路径不只是浪费请求，还会让 `fetched[]` 里全是噪音，掩盖真正的失败原因。
 */
export const COLUMN_FALLBACK_PATHS = Object.freeze(['/tzgg.htm', '/xwdt.htm']);

/** 明显是导航/翻页的锚文本：带日期的行里出现它们，多半是"更多"这类模板链接，不是条目。 */
const COLUMN_NAV_LABELS = new Set([
  '首页', '主页', '返回', '更多', '更多>', '更多>>', '查看更多', '上一页', '下一页',
  '上一条', '下一条', '列表', '全部', '栏目首页', '网站地图', '联系我们', 'more', 'more>>', '...',
]);

/** VSB 的内容页形状（`info/1056/9993.htm`）：**内容页不是栏目页**，而首页上这两种链接长得一样。 */
const CONTENT_PAGE_RE = /\/info\/\d+\/\d+\.htm$/i;

/** 完整日期：`2026-06-20` / `2026/06/20` / `2026.06.20` / `2026年6月20日` / `[2026-06-20]`。 */
const COLUMN_FULL_DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g;
/** 只到月份：`2026.06` / `2026-06` / `2026年6月`。 */
const COLUMN_YEAR_MONTH_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?/g;
/** 只到月-日：`06-20`（年份在相邻元素里，VSB 的模板都这样拆）。 */
const COLUMN_MONTH_DAY_RE = /(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g;
/** 行内独立出现的 4 位年份（`<span>2026</span><b>10-12</b>` 里的那个 2026）。 */
const COLUMN_BARE_YEAR_RE = /(?<!\d)(20\d{2})(?!\d)/;
/** 一个"日期样"的 token：清洗标题时只在头/尾剥这种 token。 */
const COLUMN_DATE_TOKEN_RE =
  /^(?:\d{4}|\[?\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\]?|\[?\d{1,2}[-/.]\d{1,2}\]?|(?:\d{4}年)?\d{1,2}月(?:\d{1,2}日)?|\d{1,2}日)$/;

const pad2 = (value) => String(value).padStart(2, '0');

/** 月份/日期合法性：专治把"2026-2027学年"这类区间当日期。 */
function monthDayInRange(month, day) {
  if (!Number.isFinite(month) || month < 1 || month > 12) return false;
  if (day === undefined || day === null) return true;
  return Number.isFinite(day) && day >= 1 && day <= 31;
}

/**
 * 从一行文本里抽发布日期，归一成 `YYYY-MM-DD`（只知道月份时是 `YYYY-MM`，**不补 01**：
 * 补了就是在编造"这条是 6 月 1 日发的"）。
 *
 * 支持的写法（都是实测见过的模板形态）：
 *   - `2026-06-20` / `2026/06/20` / `2026.06.20` / `2026年6月20日` / `[2026-06-20]`
 *   - `2026.06`（sae 学术讲座：`<b>05</b><span>2023.09</span>` 去掉日就是它）
 *   - `06-20`（年份在相邻元素里：`<span>2026</span><b>10-12</b>`、`<span class="r">10-08</span><span class="y">2026</span>`）
 *   - `2026-10` + 相邻的 `10`（新闻网 `zyxw.htm`：`<a class="y">2026-10</a><a class="r">10</a>`）
 *
 * 两条"宁可抽不到"的规矩：
 *   ① 只写 `06-20`、行里和页面里都找不到年份 → 返回空（**不猜年份**，猜错了就是编造日期）；
 *   ② 月份/日超范围（`2026-2027学年`）→ 跳过这一段，继续找下一个候选。
 */
export function extractColumnDate(text, { pageYear = '' } = {}) {
  const source = collapseInline(text);
  if (!source) return '';

  for (const match of source.matchAll(COLUMN_FULL_DATE_RE)) {
    const [, year, month, day] = match;
    if (!monthDayInRange(Number(month), Number(day))) continue;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  for (const match of source.matchAll(COLUMN_YEAR_MONTH_RE)) {
    if (!monthDayInRange(Number(match[2]))) continue;
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + match[0].length);
    const day = adjacentDayNumber(before, after);
    return day ? `${match[1]}-${pad2(match[2])}-${pad2(day)}` : `${match[1]}-${pad2(match[2])}`;
  }

  for (const match of source.matchAll(COLUMN_MONTH_DAY_RE)) {
    if (!monthDayInRange(Number(match[1]), Number(match[2]))) continue;
    const year = COLUMN_BARE_YEAR_RE.exec(source)?.[1] || String(pageYear ?? '');
    if (!year) continue;
    return `${year}-${pad2(match[1])}-${pad2(match[2])}`;
  }
  return '';
}

/**
 * `YYYY-MM` 与相邻的裸数字拼成日期（VSB 把年月和"日"拆到两个元素里）。
 * 只看**紧邻**的空白分隔 token，且必须整 token 都是 1–2 位数字（混了别的字就不认）——
 * 松一点就会把"报告人：龚璞林"里的数字当成"日"。
 */
function adjacentDayNumber(before, after) {
  const tail = String(before).trim().split(/\s+/).pop() ?? '';
  const head = String(after).trim().split(/\s+/).shift() ?? '';
  for (const token of [tail, head]) {
    if (token.length > 4 || !/^\d{1,2}$/.test(token)) continue;
    const value = Number(token);
    if (value >= 1 && value <= 31) return value;
  }
  return 0;
}

/** 这个 token 是不是"日期样"（清洗标题用）。 */
function isDateToken(token) {
  const cleaned = String(token ?? '').replace(/^[[(（【]+/, '').replace(/[\])）】]+$/, '');
  return COLUMN_DATE_TOKEN_RE.test(cleaned.trim());
}

/**
 * 列表页的标题清洗：把头/尾的日期 token 剥掉。
 *
 * 为什么需要它：VSB 各模板会把日期塞进 `<a>` 里（"10-08 2026 文治书院…"），不剥的话模型引用出来
 * 就是"10-08 2026 文治书院…"这种糊成一团的标题。只剥**头尾最多 3 个** token，并且
 * **孤立的 1–2 位数字只在紧跟另一个日期 token 时才剥** —— 否则"3 号教学楼停电通知"会被啃掉开头的 3。
 *
 * `publishedAt` 是这一行的发布日期，只用来处理"日期**贴在标题前面且没有空格**"的模板
 * （崇实书院实测：锚文本是 `09-07【2023崇实"崇"你】…`）。**必须要求前缀正好等于这一行的日期**
 * 才剥，否则"10-12月工作安排"这种真标题会被啃成"月工作安排"。
 */
function cleanColumnTitle(raw, publishedAt = '') {
  let tokens = collapseInline(raw).split(' ').filter(Boolean);
  let guard = 0;
  while (tokens.length > 1 && guard < 3 && isDateToken(tokens[0])) {
    if (/^\d{1,2}$/.test(tokens[0]) && !isDateToken(tokens[1] ?? '')) break;
    tokens = tokens.slice(1);
    guard += 1;
  }
  const mmdd = String(publishedAt ?? '').slice(5);
  if (mmdd.length === 5 && tokens.length && tokens[0].startsWith(mmdd)) {
    const rest = tokens[0].slice(mmdd.length).replace(/^[\s:：|\-–—]+/, '');
    if (rest.length >= 6) tokens[0] = rest; // 剥完还得像个标题（"月工作安排"这种就不剥）
  }
  guard = 0;
  while (tokens.length > 1 && guard < 2 && isDateToken(tokens[tokens.length - 1])) {
    if (/^\d{1,2}$/.test(tokens[tokens.length - 1])) break; // "…第十五届 3" 这种不吃
    tokens = tokens.slice(0, -1);
    guard += 1;
  }
  return tokens.join(' ').trim();
}

/**
 * 一行里的 `<a>`：href、`<h1..h4>` 标题、`title` 属性、锚文本。
 *
 * 为什么单独写一份而不是复用 `extractAnchors`：列表页的**锚文本常常带日期**
 * （`<a href=… title="真正的标题"><span class="date">10-08</span>…</a>`，wen 的模板就是这样），
 * 而 `title` 属性在 VSB 模板里几乎总是干净的标题 —— 这个属性 `extractAnchors` 没取。
 */
function columnAnchors(block) {
  const out = [];
  for (const match of String(block ?? '').matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `${match[1]} ${match[3]}`;
    const inner = match[4];
    const heading = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner);
    out.push({
      href: match[2],
      heading: heading ? stripTitleTags(heading[1]) : '',
      titleAttr: stripTitleTags(/title=["']([^"']*)["']/i.exec(attrs)?.[1] ?? ''),
      text: stripTitleTags(inner),
    });
  }
  return out;
}

/** 一个 `<a>` 的"标题候选"：`<h3>` → `title` 属性 → 锚文本，取第一个清洗后够长的。 */
function columnAnchorLabel(anchor, publishedAt = '') {
  for (const candidate of [anchor.heading, anchor.titleAttr, anchor.text]) {
    const cleaned = cleanColumnTitle(candidate, publishedAt);
    if (cleaned.length >= 4) return cleaned;
  }
  return '';
}

/** 模板里的"专用日期块"：`tz-date` / `a-date` / `date` / `time` / `time fr`（VSB 各站都这么标）。 */
const COLUMN_DATE_BLOCK_RE = /<(\w+)\b[^>]*class=["'][^"']*(?:date|time)[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;
/** 日期块**自身元素里**没写全时，往后看多少个字符找（wen 的 `<span class="date">` 里只有"10-08"，年份在下一个 span 里）。 */
const COLUMN_DATE_WINDOW = 160;

/**
 * 一行的发布日期：**先看专用日期块（元素内容 → 紧邻的一小段），再退到整行**。
 *
 * 顺序不是随便定的，真网实测踩过两次：
 *   ① sae「第二届机械与航空航天工程国际会议通知」的发布日是 `tz-date` 块里的 **2026-10-12**，
 *      而摘要正文写着"本次会议将于 **2026年11月2日** 至 3 日举行"；
 *   ② 文治书院那条的发布日是 `date` 块里的 **10-08**，摘要开头却是"**2026年10月7日**下午，文治书院…"。
 * 先扫整行的话，抽出来的是**事情发生的日子**，不是**发布的日子** —— 而"最近有什么"问的正是后者。
 *
 * 所以匹配粒度是"**日期块元素自己的内容**优先，块后面那一小段（160 字符）次之，整行最后"。
 * 元素内容优先这一条也是被真网逼出来的：块后面 160 字符常常已经伸进摘要里了
 *（上面 ① 那 60 来个字的摘要里就藏着 11-02），必须先把块自己读完再往外看。
 */
function columnDateFromRow(row, pageYear) {
  const source = String(row ?? '');
  for (const match of source.matchAll(COLUMN_DATE_BLOCK_RE)) {
    const own = collapseInline(stripTags(match[2]));
    const fromOwn = extractColumnDate(own, { pageYear });
    if (fromOwn) return fromOwn;
    const nearby = collapseInline(stripTags(source.slice(match.index, match.index + COLUMN_DATE_WINDOW)));
    const fromNearby = extractColumnDate(nearby, { pageYear });
    if (fromNearby) return fromNearby;
  }
  return extractColumnDate(collapseInline(stripTags(source)), { pageYear });
}

/** 列表行：先按 `<li>`（VSB 全是 `<ul><li>`），整页没有 `<li>` 才退到 `<tr>` 表格行。 */
function columnRows(html) {
  const rows = [];
  for (const match of String(html ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) rows.push(match[1]);
  if (rows.length) return rows;
  for (const match of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) rows.push(match[1]);
  return rows;
}

/**
 * 解析一张栏目列表页 → `{items, rows, dated}`。
 *
 * `rows`（页面上有多少行）与 `dated`（其中有多少行抽到了日期）是给诊断用的：
 * 全是 JS 渲染的页面 `rows` 很大、`dated` 为 0 —— 报"抽不到日期"比报"没有新闻"诚实得多。
 * 站点改版时这里会安静地返回 0 条（上层如实记一笔），不会编出别的东西来。
 */
function parseColumnRows(html, { baseUrl = '', allowHosts = [], pageYear = '' } = {}) {
  const source = String(html ?? '');
  const hosts = (Array.isArray(allowHosts) ? allowHosts : [allowHosts])
    .filter(Boolean)
    .map((host) => String(host).toLowerCase().replace(/^\./, ''));
  const result = { items: [], rows: 0, dated: 0 };
  if (!source || !hosts.length) return result;

  const rows = columnRows(source);
  result.rows = rows.length;
  const seen = new Set();
  const selfKey = canonicalUrl(baseUrl);
  for (const row of rows) {
    const publishedAt = columnDateFromRow(row, pageYear);
    if (!publishedAt) continue; // 没有发布日期的行**不是条目**（导航/侧栏/JS 占位都落在这里）
    result.dated += 1;
    const usable = columnAnchors(row)
      .map((anchor) => ({ ...anchor, abs: resolveAllowedUrl(anchor.href, baseUrl, hosts) }))
      .filter((anchor) => anchor.abs)
      .map((anchor) => ({ ...anchor, label: columnAnchorLabel(anchor, publishedAt) }))
      .filter((anchor) => anchor.label.length >= 4 && !COLUMN_NAV_LABELS.has(anchor.label.toLowerCase()));
    if (!usable.length) continue;
    // 标题锚取"清洗后最长"的那个：日期锚总是短的（"10-08"），而摘要锚再长也长不过标题锚
    const best = usable.reduce((a, b) => (b.label.length > a.label.length ? b : a));
    const key = canonicalUrl(best.abs);
    if (!key || key === selfKey || seen.has(key)) continue;
    seen.add(key);
    result.items.push({
      title: best.label.slice(0, COLUMN_TITLE_MAX),
      url: best.abs,
      publishedAt,
    });
  }
  return result;
}

/** 对外的列表页解析（只回条目；行数/日期数这类诊断在内部用）。 */
export function parseColumnList(html, options = {}) {
  return parseColumnRows(html, options).items;
}

/** 排序键：只知道月份时按"当月最早"算，免得"2026-10"排到"2026-10-08"前面、把精度当新鲜度。 */
function columnDateSortKey(publishedAt) {
  const text = String(publishedAt ?? '');
  return text.length === 7 ? `${text}-00` : text;
}

/** 首页里的栏目入口：锚文本命中栏目词、同域、且**不是内容页**（`info/1056/9993.htm` 是文章）。 */
function columnLinksFromHome(html, baseUrl, hosts) {
  const out = [];
  for (const match of String(html ?? '').matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `${match[1]} ${match[3]}`;
    const inner = match[4];
    const heading = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner);
    const label = collapseInline(heading ? stripTitleTags(heading[1]) : stripTitleTags(inner));
    const titleAttr = collapseInline(/title=["']([^"']*)["']/i.exec(attrs)?.[1] ?? '');
    const text = label || titleAttr;
    if (!text || !COLUMN_LINK_TEXT_RE.test(text)) continue;
    // 栏目名都很短；长锚文本是"新闻标题 + 日期"（sae 首页那条"…学术讲座暨青年教师座谈会 2026-10-10"），
    // 那是内容页的链接，抓它当列表页只会白花一次请求
    if (text.length > 30) continue;
    const abs = resolveAllowedUrl(match[2], baseUrl, hosts);
    if (!abs || CONTENT_PAGE_RE.test(parseUrl(abs).pathname)) continue;
    out.push({ url: abs, label: text.slice(0, 40) });
  }
  return out;
}

/** 页面级年份：`<title>` 里的 4 位年份 → URL 里的年份（只写月日的行靠它）。 */
function columnPageYear(html, url) {
  const title = firstText(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const fromTitle = COLUMN_BARE_YEAR_RE.exec(title)?.[1];
  if (fromTitle) return fromTitle;
  return /((?:19|20)\d{2})/.exec(String(url ?? ''))?.[1] ?? '';
}

/** 把公开 URL 映射成真正要请求的 URL（只有测试注入 `origin` 时才不同，见 CAMPUS_SITE_SEARCH）。 */
function toColumnFetchUrl(raw, { publicOrigin, fetchOrigin }) {
  if (!fetchOrigin || fetchOrigin === publicOrigin) return raw;
  try {
    const url = new URL(raw);
    if (url.origin === publicOrigin) return new URL(`${url.pathname}${url.search}`, fetchOrigin).toString();
  } catch {
    /* 解析不了就原样发出去，让 requestText 去报错（它的错误信息更有用） */
  }
  return raw;
}

/** 把 `site` 参数（id / 条目对象 / 主机名）解成站点表里的条目。 */
function resolveColumnSite(site, sites) {
  if (site && typeof site === 'object') return site;
  const list = Array.isArray(sites) && sites.length ? sites : CAMPUS_SITE_SEARCH;
  const key = String(site ?? '').trim().toLowerCase();
  if (!key) return null;
  return list.find((entry) => String(entry?.id ?? '').toLowerCase() === key
    || String(entry?.host ?? '').toLowerCase() === key) ?? null;
}

/** 空的栏目直读结果（形状固定，调用方不用做防御）。 */
function emptyColumnResult({
  site = null, label = '', host = '', url = '', notes = [], error = null, fetched = [], home = null,
}) {
  return { site, label, host, url, source: '', items: [], newest: '', fetched, home, notes, error };
}

/** 抓一个候选栏目页。**永远不 throw**：失败折叠成 `{ok:false, count:0, error}`。 */
async function readOneColumnPage(candidate, { hosts, publicOrigin, fetchOrigin, timeoutMs, fetchImpl }) {
  const fetchUrl = toColumnFetchUrl(candidate.url, { publicOrigin, fetchOrigin });
  const report = {
    url: candidate.url,
    label: candidate.label ?? '',
    ok: false,
    status: 0,
    count: 0,
    rows: 0,
    dated: 0,
    items: [],
    error: null,
  };
  const response = await requestText(fetchImpl, fetchUrl, { timeoutMs, accept: 'text/html' });
  report.status = response.status;
  if (!response.ok) {
    report.error = response.error ?? `HTTP ${response.status}`;
    return report;
  }
  // 解析基准 URL 必须是**公开地址**（`../info/1056/9993.htm` 要解到 sae.xjtu.edu.cn 上）；
  // 只有没做测试映射时才用 response.url，那样能跟上真实的 301 跳转
  const baseUrl = fetchOrigin === publicOrigin ? (response.url || candidate.url) : candidate.url;
  let parsed = { items: [], rows: 0, dated: 0 };
  try {
    parsed = parseColumnRows(response.body, {
      baseUrl,
      allowHosts: hosts,
      pageYear: columnPageYear(response.body, baseUrl),
    });
  } catch (error) {
    report.ok = true;
    report.error = `解析栏目页时抛错：${error?.message ?? error}`;
    return report;
  }
  report.ok = true;
  report.rows = parsed.rows;
  report.dated = parsed.dated;
  report.items = parsed.items.map((item) => ({ ...item, source: candidate.url }));
  report.count = report.items.length;
  if (!report.count) {
    report.error = `页面上 ${parsed.rows} 行，其中 ${parsed.dated} 行抽到日期但没拼出可用条目`
      + '（可能是 JS 渲染的列表，或模板已改版）';
  }
  return report;
}

/**
 * 读一个校内站点的新闻/通知栏目列表，返回**按发布日期倒序**的前 `limit` 条。
 *
 * @param {object} options
 * @param {string|object} [options.site] 站点 id（`CAMPUS_SITE_SEARCH` 里的 `id`/`host`）或站点条目对象
 * @param {string} [options.url] 也可以直接给一个入口页 URL（首页）——给 URL 时按该 URL 的域名做白名单
 * @param {number} [options.limit] 最多返回几条（默认 10）
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用本地假站点）
 * @param {Function|object} [options.log] 日志
 * @param {number} [options.timeoutMs] 单个页面的超时（默认 8s）
 * @param {Array} [options.sites] 覆盖站点表（测试用；形状同 `CAMPUS_SITE_SEARCH`）
 * @param {number} [options.candidateLimit] 最多抓几个候选栏目页
 * @param {number} [options.concurrency] 候选页并发（收敛到 1–4）
 * @returns {Promise<{site:string|null,label:string,host:string,url:string,source:string,items:Array,
 *   newest:string,fetched:Array,home:object,notes:string[],error:string|null}>}
 *   `items[i] = {title,url,publishedAt,source}`，`source` 是**抽到它的那个栏目页 URL**（便于核对）；
 *   抓不到就是空 `items` + `error`，并且 `fetched` 里逐页写着失败原因。
 */
export async function readSiteNews({
  site,
  url,
  limit,
  fetchImpl,
  log,
  timeoutMs = COLUMN_TIMEOUT_MS,
  sites,
  candidateLimit,
  concurrency,
} = {}) {
  const warn = makeLogger(log);
  const notes = [];
  const note = (message, level = 'info') => {
    notes.push(message);
    warn(message, level);
  };

  try {
    const entry = resolveColumnSite(site, sites);
    const entryUrl = String(url ?? '').trim();
    if (!entry && !entryUrl) {
      note('栏目直读：既没给 site（站点 id/条目）也没给 url，未发起任何请求', 'warn');
      return emptyColumnResult({ notes, error: '栏目直读需要 site 或 url' });
    }

    const host = entry?.host ? String(entry.host).toLowerCase() : (parseUrl(entryUrl)?.hostname ?? '');
    if (!host) {
      note(`栏目直读：给的入口不是 http(s) URL，无法确定站点域名（${entryUrl}）`, 'warn');
      return emptyColumnResult({ notes, error: '入口 URL 无效（需要 http/https 地址）' });
    }
    const publicOrigin = entry ? `https://${host}` : new URL(entryUrl).origin;
    const fetchOrigin = String(entry?.origin ?? publicOrigin).replace(/\/+$/, '');
    const hosts = entry ? allowedHostsOf(entry) : [host];
    const siteId = entry?.id ?? null;
    const label = entry?.label ?? host;
    const homeUrl = entryUrl || `${publicOrigin}/`;

    const perList = clamp(limit, 1, 50, COLUMN_LIMIT_DEFAULT);
    const cap = clamp(candidateLimit, 1, 12, COLUMN_CANDIDATE_MAX);
    const curatedCap = Math.min(cap, COLUMN_CURATED_MAX);
    const pool = clamp(concurrency, 1, COLUMN_CONCURRENCY, COLUMN_CONCURRENCY);

    // ---- ① 首页：既是"栏目入口清单"的来源，也是判断站点是否可达的那个请求 ----------------
    // 首页抓不到不是致命错误：`columns` 与通用兜底路径照样能试（JS 渲染的首页也属于这一类）
    const homeResponse = await requestText(fetchImpl, toColumnFetchUrl(homeUrl, { publicOrigin, fetchOrigin }), {
      timeoutMs,
      accept: 'text/html',
    });
    const homeBase = fetchOrigin === publicOrigin ? (homeResponse.url || homeUrl) : homeUrl;
    const home = {
      url: homeUrl,
      ok: homeResponse.ok,
      status: homeResponse.status,
      error: homeResponse.ok ? null : (homeResponse.error ?? `HTTP ${homeResponse.status}`),
    };
    if (!home.ok) {
      note(`栏目直读：${label} 首页抓取失败（${home.error}）→ 只用实测过的栏目路径兜底`, 'warn');
    }

    // ---- ② 候选栏目页：站点表里实测过的（最多 3 个）→ 首页现找的 → 通用兜底路径 ----------
    // 为什么把站点表放最前：首页上的栏目链接是**按导航顺序**排的，主新闻栏目常常排在若干个
    // "工作动态/团委动态/工会动态"后面，只按首页顺序取前 5 个会把"综合新闻"挤掉
    //（sae 实测就是这样）。站点表那份是人工核过的"这个站的新闻/通知栏目到底是哪几个"。
    const candidates = [];
    const seen = new Set();
    const homeKey = canonicalUrl(homeUrl);
    const pushCandidate = (raw, from, { self = false } = {}) => {
      const key = canonicalUrl(raw);
      if (!key || seen.has(key)) return;
      // 首页自己默认不当候选（见下面"入口页"那段的理由），除非调用方明确把它当入口页传进来
      if (!self && key === homeKey) return;
      seen.add(key);
      candidates.push({ url: raw, label: from });
    };
    let curated = 0;
    for (const path of entry?.columns ?? []) {
      if (curated >= curatedCap) break;
      const abs = resolveAllowedUrl(path, publicOrigin, hosts);
      if (!abs) continue;
      pushCandidate(abs, '站点表');
      curated += 1;
    }
    // 调用方给的入口**本身就是一页栏目**时（`readSiteNews({url})` 直接指向 `…/zhxw.htm`），
    // 它当然要算一个候选；是站点根（`/`）时不算 —— 把首页当列表页解析会把首页那几块"推荐位"
    // 当成栏目全量条目，那是另一回事。
    const entryPath = parseUrl(homeUrl)?.pathname ?? '';
    if (entryPath && entryPath !== '/') pushCandidate(homeUrl, '入口页', { self: true });
    if (home.ok) {
      // 首页里只找**本站自己**的栏目入口（`[host]`，而不是站点表的 allowHosts）：
      // 门户 `www` 的 allowHosts 是整个 `*.xjtu.edu.cn`（那是给它的"搜全校"用的），
      // 拿它去首页找栏目会走到 `meeting.xjtu.edu.cn`、`news.xjtu.edu.cn` 的首页上，
      // 把别人家的首页当列表页解析出上百条 —— "读这个站点的栏目"就该读它自己的。
      for (const found of columnLinksFromHome(homeResponse.body, homeBase, [host])) {
        pushCandidate(found.url, `首页：${found.label}`);
      }
    }
    for (const path of COLUMN_FALLBACK_PATHS) {
      const abs = resolveAllowedUrl(path, publicOrigin, hosts);
      if (abs) pushCandidate(abs, '通用兜底');
    }
    const list = candidates.slice(0, cap);
    if (!list.length) {
      note(`栏目直读：${label} 首页里没找到栏目入口，也没有可用的兜底路径`, 'warn');
      return emptyColumnResult({
        site: siteId, label, host, url: publicOrigin, notes, home, error: '没有找到任何候选栏目页',
      });
    }

    // 首页**根本连不上**（超时 / DNS 失败 / 拒连，`status === 0`）→ 同一台主机上的栏目页
    // 基本也是同样的下场，不再白等一轮（图书馆实测：不早退要 16s，早退 8s）。
    // 但绝不静默：每个候选页都如实记一条"因为主机不可达所以没试"。
    if (!home.ok && homeResponse.status === 0) {
      const skippedReports = list.map((candidate) => ({
        url: candidate.url,
        label: candidate.label ?? '',
        ok: false,
        status: 0,
        count: 0,
        rows: 0,
        dated: 0,
        items: [],
        error: `未尝试：${label} 首页就不可达（${home.error}），同一主机上的栏目页大概率同样失败`,
      }));
      note(`栏目直读：${label} 主机不可达 → 不再尝试 ${list.length} 个候选栏目页（原因逐页记在 fetched 里）`, 'warn');
      return emptyColumnResult({
        site: siteId, label, host, url: publicOrigin, notes, home, fetched: skippedReports,
        error: `${label} 站点不可达（${home.error}）：${publicOrigin} 上的栏目页抓不到，不代表这个站没有新闻`,
      });
    }

    // ---- ③ 并发抓候选页（上限 4），单个失败只影响它自己 -------------------------------
    const fetched = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        const candidate = list[index];
        try {
          fetched[index] = await readOneColumnPage(candidate, {
            hosts,
            publicOrigin,
            fetchOrigin,
            timeoutMs,
            fetchImpl,
          });
        } catch (error) {
          // readOneColumnPage 已经吞了绝大多数异常；这里再兜一层，保证"一个栏目页绝不拖垮整批"
          fetched[index] = {
            url: candidate.url,
            label: candidate.label ?? '',
            ok: false,
            status: 0,
            count: 0,
            rows: 0,
            dated: 0,
            items: [],
            error: `抓栏目页时发生未预期错误：${error?.message ?? error}`,
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool, list.length) }, () => worker()));

    const reports = fetched.filter(Boolean);
    const okPages = reports.filter((report) => report.ok);
    const failedPages = reports.filter((report) => !report.ok);
    const emptyPages = okPages.filter((report) => !report.count);

    // ---- ④ 合并 + 按日期倒序（同 URL 去重，保留先出现的那条） -------------------------
    const items = [];
    const seenUrl = new Set();
    for (const report of reports) {
      for (const item of report.items) {
        const key = canonicalUrl(item.url);
        if (!key || seenUrl.has(key)) continue;
        seenUrl.add(key);
        items.push(item);
      }
    }
    items.sort((a, b) => columnDateSortKey(b.publishedAt).localeCompare(columnDateSortKey(a.publishedAt)));
    const limited = items.slice(0, perList);
    const newest = limited[0]?.publishedAt ?? '';

    if (limited.length) {
      note(
        `栏目直读（${label}）从 ${okPages.length} 个栏目页读到 ${limited.length} 条带日期的条目`
        + `（原始 ${items.length} 条），最新 ${newest}；来源：`
        + okPages.filter((report) => report.count).map((report) => report.url).join('、'),
      );
    } else {
      const reasons = reports
        .map((report) => `${report.url} → ${report.error ?? '未解析出条目'}`)
        .join('；');
      note(`栏目直读（${label}）没读到任何带日期的条目：${reasons}`, 'warn');
    }
    for (const report of failedPages) {
      note(`栏目直读跳过：${report.url} → ${report.error}`, 'warn');
    }
    if (emptyPages.length && limited.length) {
      note(`栏目直读里有 ${emptyPages.length} 个页面没解析出条目：${emptyPages.map((report) => report.url).join('、')}`);
    }

    return {
      site: siteId,
      label,
      host,
      url: publicOrigin,
      source: limited[0]?.source ?? '',
      items: limited,
      newest,
      fetched: reports.map((report) => ({
        url: report.url,
        label: report.label,
        ok: report.ok,
        count: report.count,
        rows: report.rows,
        dated: report.dated,
        error: report.error,
      })),
      home,
      notes,
      error: limited.length
        ? null
        : `没有从 ${label} 的 ${reports.length} 个候选栏目页里抽到带发布日期的条目（原因逐页写在 fetched 里）`,
    };
  } catch (error) {
    // 对外承诺"永远不 throw"：栏目直读是**加分项**，它出问题不该让整轮校园检索失败
    const message = `栏目直读发生未预期错误：${error?.message ?? error}`;
    note(message, 'warn');
    return emptyColumnResult({ notes, error: message });
  }
}

/**
 * 从问法里认出目标站点（"最近我们**航天航空学院**有什么新闻" → `sae`）。
 *
 * 用 `label` + `aliases` + `host` 做**子串匹配、取最长命中**：
 * "彭康书院"同时命中"彭康书院"(4) 与"彭康"(2)，取长的不容易认错；
 * 别名表里刻意**不写**"学院""书院"这类通名 —— 那会把任何学院都认成同一个站。
 */
export function findCampusSiteForQuery(query, sites) {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return null;
  const list = (Array.isArray(sites) && sites.length ? sites : CAMPUS_SITE_SEARCH)
    .filter((entry) => entry?.id && entry?.host);
  let best = null;
  let bestLength = 0;
  for (const entry of list) {
    const names = [entry.label, ...(Array.isArray(entry.aliases) ? entry.aliases : []), entry.host]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    for (const name of names) {
      if (name.length <= bestLength || !text.includes(name)) continue;
      best = entry;
      bestLength = name.length;
    }
  }
  return best;
}

/** 这个问法是不是"要最新列表"（决定 campus 档要不要多走一次栏目直读）。 */
export function looksLikeNewsQuery(query) {
  return NEWS_LIST_QUERY_RE.test(String(query ?? ''));
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/** campus 档的检索词：加 `site:` 收窄到校内站点（已有 site: 就不重复加）。 */
/**
 * 校内通道的检索词。
 *
 * `site:xjtu.edu.cn` 是**请求**不是**保证** —— 实测（真网，免密钥通道）Bing 的结果页
 * 对 `site:` 基本不认，返回的仍是各校教务处首页，被 `isCampusUrl` 一过滤就全没了，
 * 于是"校内检索"一条校内结果都没有（而公网结果又混在里面，用户看到的是北大/北航）。
 *
 * 所以这里两手都用上：既带 `site:`（对认它的后端有用），也带学校名（对结果页有用，
 * 让搜索引擎至少把西交大的页面排上来），最后仍由 `isCampusUrl` 做**域名级后置过滤**兜底。
 */
export function campusScopedQuery(query, { school = '西安交通大学' } = {}) {
  const text = String(query ?? '').trim();
  if (!text) return text;
  // 调用方（模型/用户）自己写了 site: 就照它说的做，别擅自改词 —— 它可能就是想精确限定域名
  if (/\bsite\s*:/i.test(text)) return text;
  // 只带 site: 在免密钥通道下实测拿不到校内结果（结果页基本不认这个语法），
  // 所以补上学校名让搜索引擎至少把西交大的页面排上来；域名级过滤仍由 isCampusUrl 兜底
  const withSchool = text.includes(school) ? text : `${text} ${school}`;
  return `${withSchool} site:xjtu.edu.cn`;
}

/**
 * 检索网页，返回候选结果。
 *
 * @param {object} options
 * @param {string} options.query 检索词
 * @param {'web'|'campus'} [options.mode='web'] web=校外全网；campus=校内优先（"最近/最新"这类问法先直读校方栏目列表，再站内直搜、公共结果页、mention 兜底）
 * @param {number} [options.limit] 最多返回几条（收敛到 5–30，默认取 `config.searchMaxPages`）
 * @param {object} [options.config] AI 配置切片（searchEnabled/searchMaxPages/searchProvider/searchApiKey/searchApiKeys）
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用本地假服务器）
 * @param {Function|object} [options.log] 日志：函数或 `{warn}` 形状
 * @returns {Promise<Array<{title:string,url:string,snippet:string,source:string,scope:'web'|'campus',
 *   matchedBy?:'column'|'site'|'domain'|'mention', publishedAt?:string}>>}
 */
export async function searchWeb(options = {}) {
  const detailed = await searchWebDetailed(options);
  return detailed.results;
}

/**
 * 与 `searchWeb` 相同，但额外返回诊断信息（后端选择、campus 探测、逐条说明）。
 * 对话层建议用这个：`notes` 可以直接回灌给模型，让它如实说明"为什么没搜到"。
 *
 * 返回值里的 `siteSearch` 与 `columnRead` 分别是**站内直搜**与**栏目列表直读**的报告
 * （逐页 `ok/count/rows/dated/error`）：界面与模型据此说明"这次读了哪些页面、哪一页坏了"。
 */
export async function searchWebDetailed({
  query,
  mode = 'web',
  limit,
  config = {},
  fetchImpl,
  log,
  endpoints,
  probes,
  sites,
  probeCampus = true,
} = {}) {
  const warn = makeLogger(log);
  const notes = [];
  const note = (message, level = 'info') => {
    notes.push(message);
    warn(message, level);
  };

  const text = String(query ?? '').trim();
  const scope = mode === 'campus' ? 'campus' : 'web';
  const max = normalizeSearchLimit(limit, { fallback: config?.searchMaxPages });
  const backend = resolveSearchBackend(config);

  if (!text) {
    note('检索词为空，未发起任何请求（这不是"没有结果"，是"没问问题"）');
    return { query: '', mode: scope, limit: max, backend, campus: null, results: [], notes };
  }
  if (config?.searchEnabled === false) {
    note('设置里的「联网检索」总开关是关闭的（searchEnabled=false），本轮不检索，也不会假装搜到内容');
    return { query: text, mode: scope, limit: max, backend, campus: null, results: [], notes };
  }

  warn(`开始检索：mode=${scope} limit=${max} 后端=${backend.id}（${backend.reason}）`);

  // 没有密钥时把这件事说清楚：用户/模型要知道现在是"免密钥通道"，结果可能更少更糙
  if (backend.kind === 'scrape') note(`未配置搜索 API 密钥，走免密钥通道：${backend.reason}`);

  const apiKeys = normalizeSearchKeys(config);
  const endpointMap = endpoints ?? config?.searchEndpoints ?? {};
  const campusProbeList = probes ?? config?.campusProbes;
  const campusSiteList = sites ?? config?.campusSites;

  // ---- campus 档第 ⓪ 条通道：栏目列表直读 + ① 站内直搜（通道顺序就是优先级） ----------
  // 为什么站内直搜排最前：这是"命中了就必然是校内的东西"的通道 —— 结果直接来自校内站点
  // 自己的检索接口，不可能像公共搜索引擎那样把北大/北航的教务处塞进来。
  // 真网实测（2026-10-13）：12 个站点可直搜，单站 0.3–6.5s，站点级并发 3。
  //
  // 但真机反馈证明它**在"最近有什么新闻"上会失手**（列表页没被站内搜索收录/收录滞后），
  // 所以多一条 ⓪：问法像"要最新列表"、又能从问法里认出目标站点时，**并行**去读那个站点的
  // 栏目列表（`readSiteNews`）。两路并行是为了不把校园档的等待时间再加一份。
  const collected = [];
  let siteSearch = null;
  let columnRead = null;
  let columnSite = null;
  if (scope === 'campus') {
    columnSite = looksLikeNewsQuery(text) ? findCampusSiteForQuery(text, campusSiteList) : null;
    const siteSearchJob = searchCampusSites({
      query: text,
      limit: max,
      fetchImpl,
      log: warn,
      sites: campusSiteList,
    });
    const columnJob = columnSite
      ? readSiteNews({
        site: columnSite,
        sites: campusSiteList,
        limit: COLUMN_LIMIT_DEFAULT,
        fetchImpl,
        log: warn,
      })
      : null;
    // searchCampusSites / readSiteNews 内部已经逐条 log 过，这里只把 notes 收进本轮结果，
    // 避免同一句话打两遍日志
    siteSearch = await siteSearchJob;
    notes.push(...siteSearch.notes);
    if (columnJob) {
      columnRead = await columnJob;
      notes.push(...columnRead.notes);
    } else if (looksLikeNewsQuery(text)) {
      note('问法像"要最新列表"，但没能从检索词里认出具体是哪个站点 → 不做栏目直读（认出站点才读，免得读错站）');
    }

    // 栏目条目排在站内直搜前面入池：同 URL 时去重会保留**先出现的这条**，
    // 而栏目那条带 `publishedAt`（站内直搜的条目没有发布日期）—— 留它可以少丢信息。
    if (columnRead) {
      collected.push(...columnRead.items.map((item) => ({
        title: item.title,
        url: item.url,
        // 列表页已经给了标题+日期，**不再抓正文**（要读正文，模型可以按 fields.url 直读那一条）。
        // snippet 只写清"这条是从哪个栏目页读到的"，供模型和用户核对来源。
        snippet: `来自${columnRead.label ?? columnSite?.label ?? ''}栏目列表：${item.source}`,
        source: 'campus-column',
        scope: 'campus',
        matchedBy: 'column',
        site: columnRead.site ?? undefined,
        publishedAt: item.publishedAt,
      })));
    }
    collected.push(...siteSearch.results);
  }

  // ---- 决定还要跑哪几路公共检索 -------------------------------------------
  const tasks = [];
  if (scope === 'campus') {
    // campus 档第 ② 条通道：公共结果页（`site:` 收窄 + 校名）。它是**覆盖补充** ——
    // 新开的子站、没有检索入口的站、要登录才看得到的站，站内直搜都够不到，仍靠它兜一层。
    tasks.push({ scope: 'campus', query: campusScopedQuery(text) });
  } else {
    tasks.push({ scope: 'web', query: text });
  }

  let campus = null;
  if (scope === 'campus' && probeCampus) {
    campus = await detectCampusNetwork({ fetchImpl, probes: campusProbeList, log: warn });
    if (campus.onCampus) {
      tasks.push({ scope: 'web', query: text });
      note('校内域名可达 → 除校内站点定向检索外，再并走一次公网检索（可达不等于确认在校园网，见 caveat）');
    } else {
      note('校内域名不可达 → 本轮只做校内站点定向检索，不并走公网（可能不在校园网，也可能是探测被拦）');
    }
  }

  // ---- 执行 ---------------------------------------------------------------
  for (const task of tasks) {
    let items = [];
    if (backend.kind === 'api') {
      const provider = backend.providers[0];
      const { items: apiItems, error } = await callApiProvider(provider, {
        query: task.query,
        limit: max,
        key: apiKeys[provider],
        fetchImpl,
        endpoints: endpointMap,
      });
      if (error) {
        // API 挂了要**降级**到免密钥通道，而不是直接空手而归 ——
        // 但必须记下原因，免得用户以为"确实没有结果"。
        note(`${error} → 降级到免密钥通道（结果页解析）`);
        items = await scrapeSearch({ query: task.query, limit: max, fetchImpl, endpoints: endpointMap, note });
      } else {
        items = apiItems;
        note(`${backend.id} 返回 ${items.length} 条候选（scope=${task.scope}）`);
      }
    } else {
      items = await scrapeSearch({ query: task.query, limit: max, fetchImpl, endpoints: endpointMap, log: warn, note });
    }
    for (const item of items ?? []) collected.push({ ...item, scope: task.scope });
  }

  /**
   * 按**相关度**排一次，而不是按"哪个站点先被查"。
   *
   * 这是真机反馈逼出来的：用户问「最近有什么单位来访我们航空航天学院吗」，
   * 站内直搜其实**抓到了**航院那几条（"中国工程物理研究院流体物理研究所来访航天航空学院并做技术交流"），
   * 但 12 个站点共 113 条候选是按 CAMPUS_SITE_SEARCH 的顺序（教务处排第一）截前 10 条的，
   * 于是航院的结果全被教务处的竞赛/学籍通知挤出去 —— 模型看到的就是"只搜到教务处，跟来访无关"。
   *
   * 排序口径：相关度（标题命中权重更高，见 relevanceScore）降序 →
   * 命中来源（栏目直读 > 站内 > 域名 > 文本提到本校）→ 原顺序（稳定，保证同分不抖）。
   *
   * **栏目直读的条目在"新闻类查询"里直接给满分相关**（见 `scoreOf`）。两个理由：
   *   ① 它们不是"碰巧命中关键词"，而是目标站点**当前最新的几条**，用户问的就是这个。
   *      按关键词覆盖率算分反而会把它们压下去：标题里往往没有"最近"这类词，而招生栏目标题里
   *      恰好有"转专业"这种查询词 —— "最新新闻"于是输给"招生通知"，正是真机上出现过的错位；
   *   ② 给满分后它们同分，而 `Array#sort` 是稳定的 ⇒ `readSiteNews` 的**日期倒序被原样保住**，
   *      模型看到的顺序就是时间顺序（若在同分档里再按相关度重排，时间顺序就乱了）。
   * 只有**问法像"要最新列表"且真的读到了栏目条目**时才这样（`columnBoost`）；别的查询
   *（"转专业学分怎么算"）里栏目条目仍按相关度参与排序。
   */
  const terms = queryTerms(text);
  const columnBoost = Boolean(columnRead?.items?.length) && Boolean(columnSite);
  const scoreOf = (item) => (
    columnBoost && item.matchedBy === 'column' ? 1 : relevanceScore(terms, item)
  );
  const ranked = dedupeResults(collected)
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .sort((a, b) => b.score - a.score || matchedByRank(a.item.matchedBy) - matchedByRank(b.item.matchedBy) || a.index - b.index)
    .map((entry) => entry.item);
  const deduped = ranked;

  /**
   * 校内档第 ③ 条通道（兜底分桶）：**把公网结果里真正提到本校的那些算作校内相关**。
   *
   * 真网实测过两次：免密钥通道下 `site:xjtu.edu.cn` 与"带学校名"都拦不住结果页 ——
   * 查「教务处 通知」返回的是北大/北航/北理工的教务处首页，校内桶一条都没有，
   * 而用户要的是"校内的东西"。所以这里按**标题/摘要里有没有出现学校名**再分一次桶：
   *   - 命中的标成 `scope: 'campus'`（表示"与本校相关"），并如实说明它是从公网结果里认出来的；
   *   - 没命中的仍留在 `scope: 'web'`，界面与模型都能分清。
   * 这不是"假装校内命中"：站点级/域名级/文本级命中分别记在 `matchedBy` 里，
   * 界面上会写清这条是怎么被认出来的。
   */
  const SCHOOL_RE = /(西安交通大学|西交大|xjtu)/i;
  let results = deduped;
  if (scope === 'campus') {
    results = results.map((item) => {
      if (item.scope === 'campus') return { ...item, matchedBy: item.matchedBy ?? 'domain' };
      const haystack = `${item.title ?? ''} ${item.snippet ?? ''}`;
      if (!SCHOOL_RE.test(haystack)) return item;
      return { ...item, scope: 'campus', matchedBy: 'mention' };
    });
    // 排序：`matchedBy` column > site > domain > mention > web。`Array#sort` 是稳定的，
    // 所以同一档内保持各通道产出的原有顺序（栏目直读 → 站内直搜 → 公共结果页 → 公网 mention → 其它公网）。
    // 为什么 column 最优先：它是校方栏目页上**当前最新的几条**（还带发布日期）；
    // site 只保证"是校内的、且匹配了关键词"，domain 只是"域名看着像校内的"，
    // mention 更是"标题里提了校名" —— 证据强度依次递减（详见 MATCHED_BY_RANK 的注释）。
    results.sort((a, b) => matchedByRank(a) - matchedByRank(b));
    const count = (name) => results.filter((item) => matchedByRank(item) === MATCHED_BY_RANK[name]).length;
    note(
      `校内档分桶（本次候选 ${results.length} 条）：栏目直读 ${count('column')} 条`
      + ` / 站内直搜 ${count('site')} 条`
      + ` / 公共结果页校内域名 ${count('domain')} 条`
      + ` / 公网提到本校 ${count('mention')} 条`
      + ` / 其它公网 ${count('web')} 条`,
    );
    if (count('mention')) {
      note('其中"公网提到本校"那批是按标题/摘要文本认定的，不是站内页面，引用时要说清来源');
    }
    if (count('column')) {
      note('栏目直读那批带 publishedAt（发布日期）："最新的是哪条"按它回答；要读某一篇正文就用 fields.url 直读那一条');
    }
  }
  if (results.length > max) {
    note(`候选共 ${results.length} 条，按本次上限 ${max} 条返回（余下未带回）`);
  }
  results = results.slice(0, max);

  if (scope === 'campus' && results.length === 0) {
    note('校内档没有拿到任何结果：可能校内站点确实没有相关内容、关键词太窄，或免密钥通道被拦截；请如实告诉用户"没搜到"，不要编造校内链接');
  }
  if (results.length === 0 && collected.length > 0) {
    note(`原始候选 ${collected.length} 条，去重/过滤（广告、站内跳转、非 http 链接）后为空`);
  }

  // `siteSearch`/`columnRead` 分别是站内直搜与栏目列表直读的**诊断报告**（含逐页 ok/count/error），
  // 对话层用它如实解释"哪条通道出了什么问题"，界面也能显示"这次读的是哪个栏目页"
  return {
    query: text, mode: scope, limit: max, backend, campus, siteSearch, columnRead, results, notes,
  };
}

// ---------------------------------------------------------------------------
// 读正文
// ---------------------------------------------------------------------------

/**
 * 正文清洗时要整块丢掉的标签（地图/表单/导航这些不是正文）。
 *
 * **这一版把 `form` 从上面那张表里拿出来了**（原来有它）：博达 VSB 站群的新模板
 * 把**整篇文章包在 `<form name="_newscontent_fromname">` 里** —— 标题目录、发布时间、
 * `<div id="vsb_content">` 全是它的子节点。原来那条"丢掉 form 包括内容"会把正文一起吃掉。
 * 实测证据（2026-10-13，`https://sae.xjtu.edu.cn/info/1024/1173.htm`，页面 23,845 字节）：
 * 带 `form` 时清洗结果 **865 字全是导航**（学校首页/学院概况/师资队伍…，正文一个字没有），
 * 把 `form` 拿掉后同一页清洗出 **1495 字**，`汤铁钢`/`申胜平`/`徐自力` 等正文人名全在。
 * 表单控件本身照旧会被剥成空文本（`<input>`/`<select>`/`<option>` 仍在表里），
 * 所以"丢表单"这个意图不受影响，只是不再把 form 的**内容**（往往就是正文容器）也丢掉。
 */
const DROP_TAGS = 'script|style|noscript|template|svg|canvas|iframe|object|embed|nav|header|footer|aside|button|select|option|dialog';

/**
 * 站内正文容器的开头标记（**先取容器，再清洗**）。
 *
 * 为什么需要它：一类校内页面（博达 VSB 站群的新模板）把正文放在固定的容器里，
 * 但同一页还有**两份完整重复的导航**（PC 一份、移动端一份）与页脚。
 * 只做"整页剥标签 + 逐行去噪"时，导航占的篇幅可能比正文还长、而且长得很像正文行，
 * 模型拿到的仍是一堆菜单。命中容器就等于直接定位到正文区，把这些噪声一次性绕开。
 *
 * 标记只取**语义明确**的绝对路径（`#vsb_content`、`.v_news_content` 等），
 * 故意不写 `.content` 这种大路货 —— 猜错容器比不猜更糟（会把别的区块当正文）。
 */
const CONTENT_CONTAINER_RE = /<(?:div|article|section|td)\b[^>]*\bid\s*=\s*["']?(?:vsb_content(?:_other)?|v_news_content|vsb_content_100|articleContent|article_content|zoom)["']?[^>]*>|<(?:div|article|section|td)\b[^>]*\bclass\s*=\s*["'][^"']*(?:\bv_news_content\b|vsbcontent)[^"']*["'][^>]*>/i;

/**
 * 容器一路不闭合时的兜底上限：超过就认为标记只是"提到"了这些名字，不算容器。
 * 防止把 `id="vsb_content"` 出现在脚本字符串里的整页都当成正文。
 */
const CONTAINER_FALLBACK_CHARS = 200_000;

/** 清洗后短于这个字数就算"没拿到真正文"，触发摘要兜底。 */
export const PAGE_TEXT_MIN_CHARS = 200;

/**
 * 站内 `content.jsp`：**实测结论是"不能用来取正文"，所以没有实现这条通道。**
 *
 * 2026-10-13 真网实测（带浏览器 UA 的 curl，目标页 `https://sae.xjtu.edu.cn/info/1024/1173.htm`）：
 *
 * 1. 整页 HTML 里 `content.jsp` 只出现 **1 次**，在页头的计数脚本里：
 *    `<script type="text/javascript">_jsq_(1024,'/content.jsp',1173,1940881638)</script>`。
 *    它引的 `/system/resource/js/counter.js` 里 `_jsq_` 是 `new Image()` 打点，
 *    参数是 (treeid, pagename, newsid, owner) —— 这是**浏览量计数器**，不是取正文的接口。
 * 2. 按 VSB9 的通用形状请求：
 *    `GET /content.jsp?urltype=news.NewsContentUrl&wbtreeid=1024&wbnewsid=1173`
 *    → **HTTP 200 / 26,775 字节 / `text/html;charset=UTF-8`**，但返回的是**整页 HTML**
 *    （页头页脚 + 两份导航都在：`学校首页` 1 次、`汤铁钢` 4 次），**不是正文片段**。
 * 3. 换成别的参数顺序（`wbtreeid` 提到最前、或去掉 `urltype`）→ HTTP 200 / **101 字节**：
 *    `<html><body><p …>无效的访问地址</p></body></html>`。说明 `urltype` 与参数顺序都强校验，
 *    而校验通过时它只是**把同一个页面又吐了一遍**（与 `.htm` 差 360 字节，去空白后同构）。
 *
 * 结论：正文本来就在 `.htm` 里（`<div id="vsb_content">`），**并不存在"JS 之后才加载正文"**；
 * 只看到导航是 `htmlToText` 把 `<form>` 连内容一起丢掉造成的（见 `DROP_TAGS` 注释）。
 * 所以这里不开任何站内接口通道：少一次请求、少一个会静默变形的猜测，
 * 也不因为猜 URL 形状对站方多打流量。将来真要接，按下面的形状重测再说。
 */
export const VSB_CONTENT_ENDPOINT_SHAPE =
  'content.jsp?urltype=news.NewsContentUrl&wbtreeid=<treeid>&wbnewsid=<newsid>（2026-10-13 实测：返回整页，不是正文片段）';

/** 正文来源标记：容器 / 整页 / meta 摘要。模型侧据此区分"读了全文"与"只看到摘要"。 */
export const PAGE_TEXT_VIA = Object.freeze({
  container: 'container',
  body: 'body',
  meta: 'meta-description',
});

/** 摘要兜底时附给模型的口径：**必须**跟着正文一起回灌，否则模型会把摘要当全文承诺细节。 */
export const META_DESCRIPTION_NOTE =
  '这段是页面摘要（<meta description>），不是正文全文；正文可能由脚本渲染、在图片里或需要登录。'
  + '只允许按摘要里确实出现的信息回答，不要补充摘要之外的细节。';

/**
 * HTML → 纯文本。
 * 顺序很重要：先丢整块标签（连带内容），再把块级标签变成换行，最后才剥剩下的标签 ——
 * 反过来的话 `<script>` 里的代码会被当成正文留下来。
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(new RegExp(`<(${DROP_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi'), ' ');
  // 被截断的页面常常有**没闭合**的 <script>：上面那条配对失败，这里再兜一刀
  text = text.replace(new RegExp(`<(${DROP_TAGS})\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|blockquote|dd|dt|pre|figure)\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  return collapseWhitespace(decodeEntities(text));
}

/** 导航噪声行：菜单项、版权页脚、"上一页下一页"这类。只丢**整行都是噪声**的行。 */
const NOISE_LINE_RE = new RegExp(
  [
    '^(?:首页|主页|返回|返回首页|上一页|下一页|更多|查看更多|登录|注册|退出|搜索|菜单|导航|分享|打印|收藏|订阅|首页\\s*›.*)$',
    '^(?:版权所有|Copyright|©|京ICP|陕ICP|沪ICP|粤ICP|公安备案|增值电信)',
    '(?:Powered by|技术支持|网站地图|联系我们|关于我们|隐私政策|用户协议|免责声明)\\s*$',
  ].join('|'),
  'i',
);

/** 一行里塞了 3 段以上极短片段，基本都是导航条（"首页 | 概况 | 师资 | 招生"）。 */
function looksLikeMenuBar(line) {
  const parts = line.split(/[|·›»>/]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  return parts.every((part) => part.length <= 8);
}

/** 逐行去噪：丢空行、导航行、菜单条，并合并相邻重复行。 */
export function stripNoiseLines(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length < 2) continue;
    if (NOISE_LINE_RE.test(line)) continue;
    if (looksLikeMenuBar(line)) continue;
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** 截断到 `maxChars`，并明确标注"后面还有内容"。 */
export function truncateText(text, maxChars) {
  const source = String(text ?? '');
  const limit = clamp(maxChars, 100, 200_000, READ_MAX_CHARS);
  if (source.length <= limit) return source;
  return `${source.slice(0, limit)}\n…（正文过长，已按设置截断，仅保留前 ${limit} 字）`;
}

/**
 * 从 `openIndex` 处的开始标签起，按**同层 `<div>` 配对**找出容器正文。
 *
 * 为什么不能直接用"第一个 `</div>`"收尾：VSB 的 `#vsb_content` 里嵌了
 * `<div class="v_news_content">` 和若干 `<p>`，第一个 `</div>` 属于内层，
 * 会**把正文截掉一半**（实测 1173 页只留得下开头两段）。
 * 所以这里数同层 div 的进出去配对外层那个，`<script>`/`<form>` 之类的无关标签不参与计数。
 *
 * 一路找不到配对时返回一大段（由调用方按长度闸门丢弃），**不返回 null** ——
 * 因为"没配对"最常见的原因就是页面被截断，这时前半段仍然是能用的正文。
 */
function sliceContainerBody(html, openIndex) {
  const startTag = /^<[a-zA-Z]+/.exec(html.slice(openIndex));
  if (!startTag) return '';
  const bodyStart = html.indexOf('>', openIndex);
  if (bodyStart < 0) return '';
  const tagName = startTag[0].slice(1).toLowerCase();
  // 只有 div 需要配对：`<td>`/`<section>` 这类正文容器里再套同名标签的情况实测没有
  if (tagName !== 'div') return html.slice(bodyStart + 1, bodyStart + 1 + CONTAINER_FALLBACK_CHARS);
  const openRe = /<div\b/gi;
  const closeRe = /<\/div\s*>/gi;
  openRe.lastIndex = bodyStart + 1;
  closeRe.lastIndex = bodyStart + 1;
  let depth = 1;
  for (;;) {
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return html.slice(bodyStart + 1, bodyStart + 1 + CONTAINER_FALLBACK_CHARS);
    if (open && open.index < close.index) {
      depth += 1;
      closeRe.lastIndex = open.index;
      continue;
    }
    depth -= 1;
    // 配对外层容器时收尾：内层的 `</div>` 只是让 depth 减 1，不会提前截断正文
    if (depth === 0) return html.slice(bodyStart + 1, close.index);
    openRe.lastIndex = close.index;
  }
}

/** 取站内正文容器里的 HTML；没有容器就返回 `null`。 */
function extractContentContainer(html) {
  const source = String(html ?? '');
  const match = CONTENT_CONTAINER_RE.exec(source);
  if (!match) return null;
  return sliceContainerBody(source, match.index);
}

/**
 * 取 `<meta name="description">` / `<meta property="og:description">` 的 `content`。
 *
 * 三种写法都要认：`name="description"`（最常见）、`property="og:description"`（分享卡片）、
 * 以及**属性顺序颠倒**（`content` 写在 `name` 前面）与单引号/无引号 ——
 * 校内页面是模板批量生成的，这几种在实测里都出现过。
 */
export function extractMetaDescription(html) {
  const source = String(html ?? '');
  // 先只切出 <meta …> 标签本身，避免把正文里的 "name=description" 误当元信息
  for (const tag of source.match(/<meta\b[^>]*>/gi) ?? []) {
    const names = tag.match(/\b(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi) ?? [];
    const isDescription = names.some((raw) => /description$/i.test(raw.replace(/^[^=]*=\s*["']?/i, '').replace(/["']$/, '').trim()));
    if (!isDescription) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s"'>]+))/i);
    const value = collapseWhitespace(decodeEntities(content?.[1] ?? content?.[2] ?? content?.[3] ?? ''));
    if (value) return value;
  }
  return '';
}

/** 摘要与正文是否在说同一段话（避免把摘要重复拼两遍）。 */
function isSameContent(a, b) {
  const left = collapseWhitespace(a);
  const right = collapseWhitespace(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length < 30) return false;
  // 摘要常是正文的截断版（结尾带省略号），拿前 30 字比对即可
  return longer.includes(shorter.slice(0, 30));
}

/**
 * 一个页面从 HTML 到可给模型看的正文 + **来源标记**。
 *
 * 顺序（也是优先级）：**站内正文容器 → 整页清洗 → meta 摘要兜底**。
 *
 * 为什么要带 `via` / `note`：摘要是"线索"不是"全文"。抓正文的整条链路里，
 * 模型只能看到最终文本，它无法分辨"我读完了全文"和"我只看到了两百字摘要" ——
 * 分不清就会承诺摘要里没有的细节（"会上确定了三项合作"）。所以来源必须**一路传下去**，
 * 让模型自己按摘要的口径作答（`chat-service` 的 web 投影表里带 `textSource` / `note`）。
 *
 * @returns {{text:string, via:'container'|'body'|'meta-description', note:string|null,
 *            usedMeta:boolean, chars:number, containerChars:number, bodyChars:number}}
 */
export function extractPage(html, { maxChars = READ_MAX_CHARS } = {}) {
  const source = String(html ?? '');
  const container = extractContentContainer(source);
  const containerText = container === null ? '' : stripNoiseLines(htmlToText(container));
  // 整页那条永远算一遍：容器可能只是"提到了 vsb_content"（脚本字符串），也可能命中的是导航区
  const bodyText = stripNoiseLines(htmlToText(source));

  /**
   * 容器与整页怎么选：**容器里有文字就用容器**，不按"谁字数多"选。
   *
   * 因为 `#vsb_content` 外的两个导航副本（PC + 移动端）加起来通常比正文还长，
   * 按字数会把导航选回来 —— 那正是这次要修的 bug。容器里有文字就说明这页确实是
   * "正文在容器里"的模板，正文就是容器里的东西。
   *
   * 判断标准取"**非空**"而不是"够长"：短正文也是正文（实测里确实有正文很短的文章页）。
   * 真正的空壳（`<div id="vsb_content"></div>`）清洗后是空串，会自然落到下面的摘要兜底 ——
   * 那才是摘要该出场的时候。
   */
  const useContainer = Boolean(containerText);
  let text = useContainer ? containerText : bodyText;
  let via = useContainer ? PAGE_TEXT_VIA.container : PAGE_TEXT_VIA.body;
  let note = null;

  // 兜底只为"抓不到正文"服务：正文够长时**绝不**用摘要覆盖它
  if (text.length < PAGE_TEXT_MIN_CHARS) {
    const meta = extractMetaDescription(source);
    if (meta) {
      // 摘要与正文说的是同一段话时不叠加（否则同一句话出现两遍，白烧 token）
      const adds = !isSameContent(meta, text);
      text = adds ? `${meta}\n${text}`.trim() : text || meta;
      via = PAGE_TEXT_VIA.meta;
      note = META_DESCRIPTION_NOTE;
    }
  }

  if (!text) {
    return {
      text: '',
      via: PAGE_TEXT_VIA.body,
      note: null,
      usedMeta: false,
      chars: 0,
      containerChars: containerText.length,
      bodyChars: bodyText.length,
    };
  }
  const finalText = truncateText(text, maxChars);
  return {
    text: finalText,
    via,
    note,
    usedMeta: via === PAGE_TEXT_VIA.meta,
    chars: finalText.length,
    containerChars: containerText.length,
    bodyChars: bodyText.length,
  };
}

/**
 * 一个页面从 HTML 到可给模型看的正文（**字符串**，兼容老调用方）。
 *
 * 需要知道"这段是正文还是摘要"时用 `extractPage()`（多返回 `via` / `note`）。
 */
export function extractPageText(html, { maxChars = READ_MAX_CHARS } = {}) {
  return extractPage(html, { maxChars }).text;
}

/**
 * 读一个页面。**永远不 throw**：失败折叠成 `{ ok:false, error }`。
 *
 * 失败条目也照旧带 `via` / `note`（哪怕没有正文）：调用方与测试可以无条件读这两个字段，
 * 少一类"忘了兜 undefined"的形状错误。
 */
async function readOnePage(result, { fetchImpl, maxChars, timeoutMs }) {
  const { title = '', url = '' } = result ?? {};
  const failed = (error) => ({ title, url, ok: false, text: '', via: PAGE_TEXT_VIA.body, note: null, error });
  const response = await requestText(fetchImpl, url, { timeoutMs, accept: 'text/html,application/xhtml+xml' });
  if (!response.ok) {
    return failed(response.error ?? `HTTP ${response.status}`);
  }
  const type = String(response.contentType ?? '').toLowerCase();
  // 非网页正文（PDF/图片/JSON 接口）不硬啃：如实报错，让模型知道"这一页读不了"
  if (type && !/^(?:text\/|application\/(?:xhtml\+xml|xml))/.test(type)) {
    return failed(`不是网页正文（Content-Type: ${type.split(';')[0]}）`);
  }
  const page = extractPage(response.body, { maxChars });
  if (!page.text) {
    return failed('页面没有可提取的正文（可能是纯脚本渲染或空页）');
  }
  // via / note 跟着正文一起回灌：模型必须知道这段是"正文容器里的全文"还是"meta 摘要兜底"
  return { title, url, ok: true, text: page.text, via: page.via, note: page.note, error: null };
}

/**
 * 抓一批网页的正文。
 *
 * - **并发有上限**（默认 3，最大 4）：既避免把目标站打出 429，也避免本地开一堆连接；
 * - **单页失败不影响整批**：失败的那条给 `ok:false` + `error`，其余照常返回，
 *   顺序与入参一致（`Promise.all` 的 map 语义），方便和结果列表对齐；
 * - 每页截断到 `maxChars`（默认 4000 字）。
 *
 * @param {Array<{title?:string,url:string}>} results
 * @param {object} [options]
 * @param {number} [options.limit] 最多读几页（收敛到 1–30）
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.concurrency=3] 并发（收敛到 1–4）
 * @param {number} [options.maxChars=4000]
 * @returns {Promise<Array<{title:string,url:string,ok:boolean,text:string,
 *   via:'container'|'body'|'meta-description',note:string|null,error:string|null}>>}
 *   `via` 说明这段文字是**从哪来的**：`container` 站内正文容器 / `body` 整页清洗 /
 *   `meta-description` meta 摘要兜底（此时 `note` 会给模型一句"这是摘要不是全文"的口径）。
 */
export async function readPages(results, options = {}) {
  const { fetchImpl, concurrency, maxChars = READ_MAX_CHARS, timeoutMs = READ_TIMEOUT_MS, log } = options;
  const warn = makeLogger(log);
  const list = (Array.isArray(results) ? results : []).filter((item) => item && typeof item.url === 'string' && item.url);
  const limit = clamp(options.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_MAX);
  const targets = list.slice(0, limit);
  const pool = clamp(concurrency, 1, READ_CONCURRENCY_MAX, READ_CONCURRENCY_DEFAULT);
  if (!targets.length) return [];

  const out = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      try {
        out[index] = await readOnePage(targets[index], { fetchImpl, maxChars, timeoutMs });
      } catch (error) {
        // readOnePage 已经吞了绝大多数异常；这里再兜一层，保证"绝不拖垮整批"
        out[index] = {
          title: targets[index]?.title ?? '',
          url: targets[index]?.url ?? '',
          ok: false,
          text: '',
          via: PAGE_TEXT_VIA.body,
          note: null,
          error: `读取时发生未预期错误：${error?.message ?? error}`,
        };
      }
      if (!out[index].ok) warn(`读正文失败：${out[index].url} → ${out[index].error}`, 'warn');
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, targets.length) }, () => worker()));
  return out.filter(Boolean);
}

/**
 * 一步到位：搜 → 读 → 返回可回灌给模型的结构。
 * 对话层最省事的接法就是调它（见文件末尾的接线条）。
 */
export async function searchAndRead({
  query,
  mode = 'web',
  limit,
  config = {},
  fetchImpl,
  log,
  endpoints,
  probes,
  read = true,
  concurrency,
  maxChars = READ_MAX_CHARS,
} = {}) {
  const found = await searchWebDetailed({ query, mode, limit, config, fetchImpl, log, endpoints, probes });
  const pages = read
    ? await readPages(found.results, { limit: found.limit, fetchImpl, concurrency, maxChars, log })
    : [];
  return { ...found, pages };
}

// ---------------------------------------------------------------------------
// 工具描述符 + 系统提示词
// ---------------------------------------------------------------------------

/**
 * `web_search` 工具描述符。
 *
 * `mutates: false` —— 检索是只读动作，任何权限档位（auto/manual/strict）都不该拦它；
 * 真正的"写"发生在模型拿到正文之后按草稿协议走。
 */
export const WEB_SEARCH_TOOL = Object.freeze({
  name: 'web_search',
  title: '联网检索',
  description:
    '联网检索网页：先搜到候选结果（标题 / 真实链接 / 摘要），再抓取正文。'
    + '两种模式：web=校外全网（按相关度自动在搜狗/360/Bing/百度之间选引擎）；'
    + 'campus=校内优先（问"最近/最新有什么"时会**同时直读校方栏目列表页**，'
    + '拿到最新几条的标题+链接+发布日期；再直搜校内站点自己的检索接口，再公共结果页，'
    + '最后把提到本校的公网结果并入；每条都标 matchedBy=column|site|domain|mention）。'
    + '返回的都是**真实抓到的**内容；抓不到会明确报错，绝不能凭空写链接。',
  mutates: false,
  params: {
    query: 'string（必填）检索词，中文直接写中文',
    mode: "string?（web=校外全网 / campus=校内；默认 web）",
    limit: `number?（本次最多读几页正文，${SEARCH_LIMIT_MIN}–${SEARCH_LIMIT_MAX}；默认取设置里的「网络搜索最大条数」）`,
  },
});

/** 给系统提示词用的中文说明（`context.search !== 'off'` 时注入）。 */
export const WEB_SEARCH_PROMPT = `【联网检索（web_search）】
- **什么时候该搜**：用户问的是**你不可能知道的最新/本地信息**时——最新政策与通知、教务/学院/研究生院的具体要求、某门课或某位老师的现状、近期新闻、某个网址上写了什么。用户明确说"搜一下""查一下""网上怎么说"时更要搜。
- **什么时候别搜**：纯聊天、写作/翻译/改写、代码与算法、基于本地已有数据（日程/待办/成绩/笔记）能回答的问题。**先看本地数据，本地没有才联网**。
- **怎么用**：需要联网时，按当前对话协议发出一次**联网检索请求**（检索词用关键词组合，别写整句口语；模式按下面那一档）。\n- **用户直接给了网址**（"帮我看看这个页面写了什么 <网址>"）→ **不要再拿网址去搜**（搜索引擎会把 \`https\` 当关键词，返回一堆协议科普文，实测过），改用 \`{"action":"query","target":"web","fields":{"url":"<网址>"}}\` 直接读那一页。系统会真的去搜，并把**搜到的真实链接 + 抓到的正文**回灌给你；你**不能**拿记忆里的内容冒充搜索结果，也不要反复发起同一条检索。
- **必须引用真实 URL**：每个结论后面用 markdown 链接写出它来自哪一条结果，形如 [教务处通知](https://dean.xjtu.edu.cn/xxx)。**只允许引用系统真实返回过的 URL**。
- **绝对不许编造链接、标题、日期或引文**。编一个看起来很像的校内链接，比"没查到"糟糕得多。
- **搜不到就直说**：没有结果或检索失败时，如实告诉用户"这次没搜到 / 检索被拦截了"，可以说明你试过什么（例如"没配置搜索 API 密钥、结果页被反爬挡住"），并给出可行的下一步（换个说法再搜、自己打开某网址、等会儿再试）。**不要**用"根据我的知识"来掩盖一次失败的检索。
- **正文与摘要要分清**：每条结果都带 \`textSource\` —— \`container\`/\`body\` 是**抓到的正文**，\`meta-description\` 表示**只拿到了页面摘要**（此时 \`note\` 会写明"这是摘要，不是正文全文"）。看到 \`meta-description\` 就说"这条只看到标题与摘要"，只按摘要里确实出现的信息回答，**不要补充摘要之外的细节，也不要说"全文里还写了…"**。没有正文（\`ok:false\`）的条目同样如实说明。
- **问"最近/最新有什么"时**：campus 档会**自动同时直读校方栏目列表页**（该站的新闻/通知/讲座栏目），这些条目 \`matchedBy\` 是 \`column\`、**带 \`publishedAt\`（发布日期）**。回答"最新的是哪条""最近有什么"就**按 \`publishedAt\` 排序**说，并把日期写出来（例如"最新的一条是 6 月 20 日的《…》"）；\`publishedAt\` 只有 \`YYYY-MM\` 时说明"只标到月份"，**不要补一个具体日子**。栏目条目只给了标题+链接+日期（没有正文），**不要假装读过正文细节**；需要正文就用 \`{"action":"query","target":"web","fields":{"url":"<那条的 url>"}}\` 直读那一篇（这一步同样会真的去抓，抓不到会如实报错）。
- **校内信息的边界**：campus 档只保证把检索收窄到校内站点，**不等于**登录了校内系统。需要登录才能看到的成绩、作业、课表，仍然要用本地已同步的数据回答，不要假装看到了网页。`;

/** 三档检索开关对应的提示词（可直接替换 prompt.js 里的 SEARCH_NOTES）。 */
export const WEB_SEARCH_MODE_NOTES = Object.freeze({
  off: `【联网检索：关闭】
- 现在没有联网能力：被问到实时信息（最新政策、新闻、别人的主页、赛事比分…）时，
  如实说明你拿不到实时数据，只能按已有知识回答，并提醒可能不是最新的。
- **不要**编造搜索结果、链接或引用，也不要说"我查到了"。`,
  web: `${WEB_SEARCH_PROMPT}
- 当前档位：**校外网（全网检索）**。`,
  campus: `${WEB_SEARCH_PROMPT}
- 当前档位：**校内网（校内优先）**。检索按四条通道依次做：⓪ 问法像"最近/最新有什么"、又能认出站点时，
  **直接读该站的栏目列表页**（新闻/通知/讲座栏目），条目 \`matchedBy: 'column'\` 并带 \`publishedAt\`；
  ① 直接打校内站点自己的检索接口（教务处/研究生院/学院/书院等，命中的必然是校方页面）；
  ② 公共结果页（\`site:\` + 校名收窄）；③ 把公网结果里提到本校的并入。
  每条结果的 \`matchedBy\` 会标明它是怎么被认出来的
  （\`column\` 校方栏目列表直读 / \`site\` 站内直搜 / \`domain\` 校内域名 / \`mention\` 只是提到了校名），
  引用时按这个如实说明来源。**"最近/最新"这类问题按 \`publishedAt\` 排序作答**；
  没有 \`publishedAt\` 的条目不要替它编日期，栏目条目只给了标题+链接+日期、不要假装读过正文。
  **校内域名可达 ≠ 已登录校内系统、也不等于确认在校园网内**，
  涉及需要登录的成绩/作业/课表，仍然用本地已同步的数据回答。`,
});

export default {
  searchWeb,
  searchWebDetailed,
  searchAndRead,
  readPages,
  detectCampusNetwork,
  searchCampusSites,
  readSiteNews,
  parseColumnList,
  extractColumnDate,
  findCampusSiteForQuery,
  looksLikeNewsQuery,
  parseVsbSearchResults,
  buildCampusSiteSearchBody,
  buildCampusSiteSearchUrl,
  base64Utf8,
  matchedByRank,
  resolveSearchBackend,
  normalizeSearchLimit,
  isCampusUrl,
  canonicalUrl,
  isJunkUrl,
  dedupeResults,
  htmlToText,
  stripNoiseLines,
  extractPage,
  extractPageText,
  extractMetaDescription,
  PAGE_TEXT_VIA,
  PAGE_TEXT_MIN_CHARS,
  META_DESCRIPTION_NOTE,
  VSB_CONTENT_ENDPOINT_SHAPE,
  truncateText,
  parseBingResults,
  parseBaiduResults,
  parseSogouResults,
  parse360Results,
  queryTerms,
  relevanceScore,
  averageRelevance,
  defaultReferer,
  detectAntiBot,
  requestText,
  campusScopedQuery,
  CAMPUS_SITE_SEARCH,
  MATCHED_BY_RANK,
  SCRAPE_ENGINE_IDS,
  SCRAPE_RELEVANCE_THRESHOLD,
  SCRAPE_MAX_ENGINES,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_PROMPT,
  WEB_SEARCH_MODE_NOTES,
};
