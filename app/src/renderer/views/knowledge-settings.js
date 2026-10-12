/**
 * 「设置 → 知识库」卡片。
 *
 * 这里管的是**外部知识**：教务处政策语料（`app/knowledge/dean/`，148 篇校规的原文与索引），
 * 是"学校怎么规定的"；跟「记忆」区块（关于**你本人**的偏好，≤200 字/条、每条都进提示词）
 * 是两件完全不同的事，只是共用同一条上下文注入管道。界面上的说明文字要把这条界线说清楚，
 * 否则用户会以为"我聊过的偏好"和"学校规定"是一锅的。
 *
 * 关于"更新语料"（**为什么按钮不联网抓取**）：
 *   抓教务处是"替用户访问外部站点"，服务端刻意**不提供抓取接口**（见 docs/接口文档.md §14.3），
 *   联网这件事必须由用户**显式跑脚本**触发：`node scripts/crawl-dean.js`。
 *   所以这个区块只做两件事：把**本地**索引重新读一遍（`POST /knowledge/reload`，跑完脚本不用重启进程），
 *   以及自检索引与文件是否对得上（`GET /knowledge/check`）。
 *   界面上**不放任何"从网上下载"的按钮** —— 否则等于绕开那条边界，用户也不知道程序偷偷访问了哪里。
 *
 * 与其它视图一致：所有文本经 textContent 写入（等价于转义），不用 innerHTML 拼接，
 * 也**不写 inline style**（CSP 的 style-src 'self' 会拦）。
 */

(function () {
  const SECTION_ID = 'knowledge';

  const ui = {
    mount: null,
    stats: null,
    error: null,
    /** 正在进行的动作：'reload' | 'check'，用来禁用按钮并改文案 */
    busy: null,
    /** 自检结果：`{ ok, problems }`，null = 还没查过 */
    check: null,
  };

  /* ------------------------------------------------------------ 取数 */

  async function loadStats() {
    // 后端还没装配该模块、或语料缺失时都会走 catch，界面只报"读不到"，不影响设置页其它卡片
    ui.stats = await PC.api('/knowledge/stats');
    return ui.stats;
  }

  async function refresh() {
    ui.error = null;
    paint();
    try {
      await loadStats();
    } catch (error) {
      ui.error = error;
    } finally {
      paint();
    }
  }

  /* ------------------------------------------------------------ 动作 */

  async function withBusy(key, fn) {
    ui.busy = key;
    ui.error = null;
    paint();
    try {
      await fn();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.busy = null;
      paint();
    }
  }

  /**
   * 重新读取本地索引（跑完 `node scripts/crawl-dean.js` 之后用它，不必重启后端）。
   *
   * 它只读磁盘上已经抓好的 `knowledge/dean/index.json` —— **不发任何外部网络请求**，
   * 这也是它跟"更新语料"的区别所在。查过的问题列表作废（索引换了，旧结论不再成立）。
   */
  const doReload = () =>
    withBusy('reload', async () => {
      ui.check = null;
      const result = await PC.api('/knowledge/reload', { method: 'POST', body: {} });
      // reload 会顺带回一份新 stats（见接口文档 §14.3）；只回了 { ok: true }（或干脆没回）时
      // 必须再查一次 /knowledge/stats —— 否则概况行会被一份空 stats 冲成"—"，
      // 用户刚跑完抓取脚本，最想看的就是"现在到底有多少篇"。
      const fresh = result?.counts ? result : null;
      ui.stats = fresh ?? (await loadStats());
      const ok = ui.stats?.available !== false;
      PC.toast?.(ok ? `已重新读取索引：${countText(ui.stats?.counts)}` : '索引已重新读取，但语料仍不可用');
      // 仍不可用（抓取脚本还没跑通）就整块重来一次：重试路径本身要能再点，
      // 也让"原因"跟着最新状态走。能用时不用重画 —— withBusy 的 finally 已经 paint 过了，
      // 再 refresh 一次只会白白多打一次接口。
      if (!ok) await refresh();
    });

  /** 自检：索引里记的篇目与磁盘上的文件是否一致（与 `crawl-dean.js --check` 同一套判据）。 */
  const doCheck = () =>
    withBusy('check', async () => {
      const result = await PC.api('/knowledge/check');
      ui.check = { ok: result?.ok !== false, problems: Array.isArray(result?.problems) ? result.problems : [] };
      PC.toast?.(ui.check.ok ? '自检通过：索引与文件一致' : `自检发现 ${ui.check.problems.length} 个问题`);
    });

  /* ------------------------------------------------------------ 渲染 */

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    if (ui.error) mount.appendChild(errorBox(ui.error));

    const stats = ui.stats;
    if (!stats) {
      if (!ui.error) mount.appendChild(mk('div', 'kv-val', '正在读取知识库状态…'));
      return;
    }

    mount.appendChild(summaryRow(stats));
    // 语料缺失时如实说明原因，并把"下一步做什么"直接给出来；available 时不铺这一块
    if (stats.available === false) mount.appendChild(missingBox(stats));
    mount.appendChild(categoryTable(stats));

    mount.appendChild(actions());

    if (ui.check) mount.appendChild(checkBox(ui.check));

    mount.appendChild(note());
  }

  /** 概况一行：可不可用 + 栏目/篇数/字符 + 来源 + 生成时间。 */
  function summaryRow(stats) {
    const row = mk('div', 'kb-summary');
    const available = stats.available !== false;
    row.appendChild(mk('span', `kb-badge ${available ? 'is-ok' : 'is-off'}`, available ? '语料已就绪' : '语料不可用'));

    const counts = stats.counts ?? {};
    row.appendChild(mk('span', 'kb-count', countText(counts)));
    if (stats.source) row.appendChild(mk('span', 'kb-source', `来源 ${stats.source}`));
    if (stats.generatedAt) row.appendChild(mk('span', 'kb-stamp', `生成于 ${formatStamp(stats.generatedAt)}`));

    const reload = mk('button', 'ghost-btn kb-btn-sm', ui.busy === 'reload' ? '读取中…' : '刷新');
    reload.type = 'button';
    reload.disabled = Boolean(ui.busy);
    reload.addEventListener('click', () => void refresh());
    row.appendChild(reload);
    return row;
  }

  /** 语料缺失（`available: false`）时的提示块：原因 + 下一步命令。 */
  function missingBox(stats) {
    const box = mk('div', 'kb-alert');
    box.appendChild(mk('div', 'kb-alert-title', '还没读到语料'));
    box.appendChild(mk('div', 'kb-alert-msg', stats.reason ?? '知识库目录里没有可用的索引。'));
    box.appendChild(
      mk('div', 'kb-hint', '下一步：在 app/ 目录下跑这条命令抓取语料（抓完回到这里点「重新读取索引」，不用重启）：'),
    );
    // 命令单独一行、等宽字体，方便整行选中复制
    box.appendChild(mk('code', 'kb-command', 'node scripts/crawl-dean.js'));
    return box;
  }

  /** 栏目表：一行一个栏目（label / 篇数 / 字符数）。 */
  function categoryTable(stats) {
    const wrap = mk('div', 'kb-table-wrap');
    const list = Array.isArray(stats.categories) ? stats.categories : [];
    if (!list.length) {
      wrap.appendChild(mk('div', 'kb-empty', '索引里还没有任何栏目。'));
      return wrap;
    }

    const table = mk('table', 'kb-table');
    const thead = mk('thead');
    const headRow = mk('tr');
    for (const [text, cls] of [['栏目', 'kb-col-label'], ['篇数', 'kb-num'], ['字符数', 'kb-num']]) {
      headRow.appendChild(mk('th', cls, text));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = mk('tbody');
    for (const category of list) {
      const row = mk('tr');
      row.appendChild(mk('td', 'kb-col-label', category.label ?? category.slug ?? '—'));
      row.appendChild(mk('td', 'kb-num', String(category.count ?? 0)));
      row.appendChild(mk('td', 'kb-num', String(category.chars ?? 0)));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /** 两个按钮：重新读取索引 / 自检。两者都只碰本机文件，不联网。 */
  function actions() {
    const row = mk('div', 'kb-actions');

    const reload = mk('button', 'ghost-btn', ui.busy === 'reload' ? '读取中…' : '重新读取索引');
    reload.type = 'button';
    reload.disabled = Boolean(ui.busy);
    reload.title = '跑完 scripts/crawl-dean.js 之后点这里，让后端重读本地索引（不联网）';
    reload.addEventListener('click', () => void doReload());
    row.appendChild(reload);

    const check = mk('button', 'ghost-btn', ui.busy === 'check' ? '检查中…' : '自检');
    check.type = 'button';
    check.disabled = Boolean(ui.busy);
    check.title = '核对索引里记的篇目和磁盘上的文件是否一一对应';
    check.addEventListener('click', () => void doCheck());
    row.appendChild(check);

    return row;
  }

  /** 自检结果：通过就一句话，不通过就把 problems 列出来（最多 20 条，剩下只报条数）。 */
  function checkBox(result) {
    if (result.ok) {
      return mk('div', 'kb-note ok', '自检通过：索引与文件一致。');
    }
    const box = mk('div', 'kb-alert');
    box.appendChild(mk('div', 'kb-alert-title', `自检发现问题（${result.problems.length} 条）`));
    const limit = 20;
    for (const problem of result.problems.slice(0, limit)) {
      box.appendChild(mk('div', 'kb-problem', String(problem)));
    }
    if (result.problems.length > limit) {
      box.appendChild(mk('div', 'kb-hint', `…还有 ${result.problems.length - limit} 条，跑 node scripts/crawl-dean.js --check 可以看全。`));
    }
    return box;
  }

  /**
   * 给用户看的说明。
   *
   * 刻意不用"语料""索引""检索"这些术语：用户要知道的是三件事 ——
   * 这里装的是学校政策原文、它跟"关于我的记忆"不是一回事、引用时能点回原文核对。
   */
  function note() {
    const box = mk('div', 'kb-note');
    const lines = [
      '这里是学校政策与规章的原文（培养方案、学籍管理、课程考核、校历等），由程序从教务处网站抓下来放在本机，供助手在回答时引用。',
      '它跟「记忆」是两回事：记忆记的是关于你自己的偏好（比如你习惯晚上学习），这里放的是学校的规定，谁都不改一个字。',
      '助手引用某条政策时会给出来源链接，你可以点回去核对原文；政策会修订，链接上的日期是这一版的发布时间。',
      '有一部分篇目的正文在图片或附件里（例如校历、部分流程图），这些只能按标题搜到、搜不到正文 —— 点链接看原文。',
      '更新语料靠跑抓取脚本（node scripts/crawl-dean.js），程序不会替你在后台访问教务处网站；抓完点上面的「重新读取索引」即可生效。',
    ];
    for (const line of lines) box.appendChild(mk('div', 'kb-note-line', line));
    return box;
  }

  /* ------------------------------------------------------------ 小工具 */

  /** 时间戳 → 本地可读（后端给的是 ISO 字符串，直接显示会是一串 UTC，用户对不上）。 */
  function formatStamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 「18 栏 / 148 篇 / 11.5 万字」—— 字符数上万之后按万字说，否则一长串数字没人读得出量级。 */
  function countText(counts) {
    if (!counts) return '—';
    const wan = (n) => `${Math.round((n / 10000) * 10) / 10} 万`;
    return [
      counts.categories ? `${counts.categories} 栏` : '',
      counts.documents ? `${counts.documents} 篇` : '',
      counts.chars ? `${counts.chars >= 10000 ? wan(counts.chars) : counts.chars}字` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  window.PCModules.registerSettingsSection({
    id: SECTION_ID,
    title: '知识库',
    /**
     * 60：排在「统一身份认证」（10，position: top）之后、笔记接入（50）之后的常规档里。
     * 用 order 51 会跟别人的区块挤在一起，取 60 留出空档，后面再加模块也不用改这里。
     */
    order: 60,
    render(mount) {
      ui.mount = mount;
      paint();
      void refresh();
    },
  });
})();
