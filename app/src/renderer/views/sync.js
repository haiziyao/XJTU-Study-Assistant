/**
 * 「设置 → 多端同步」区块（`PCModules.registerSettingsSection`，order 89）。
 *
 * 这一块只做三件事，全部通过后端接口完成（页面**不**直接访问服务器，理由见 account.js：
 * 跨域 + 会话令牌不该进页面）：
 *   1. 显示状态：当前账号、设备名、上次同步时间、各集合条数；
 *   2. 「立即同步」按钮 → `POST /sync/run`（后端一站式：读本地 → push → pull → 合并）；
 *   3. 敏感数据开关（AI 配置与密钥 / 学堂登录凭据）→ `POST /sync/settings`。
 *
 * 为什么这两个开关**网页版不显示**
 * --------------------------------
 * 用户口径：敏感数据默认不同步，只能在这台设备上由本人逐台勾选，而且网页版不给这个开关。
 * 判定"我是不是网页版"需要两个事实（`location.hostname` 与同源 `/auth/config` 是否可达），
 * 只有渲染层知道；但**判定逻辑只有一处**（后端 `modules/sync/runtime.js`），
 * 这里只把这两个事实带上去问后端要结论（`GET /sync/status?hostname=…&authConfig=…`），
 * 免得前后端各写一套"看起来差不多"的规则、日后悄悄分叉。
 *
 * 退化路径（必须写明，否则"离线时拿到什么结论"就是个谜）：
 *   探测 `/auth/config` 失败（离线 / CSP 拦下 / 环境没有 fetch）时传 `null`，
 *   后端给出 `unknown` —— **按原生客户端处理**，但面板上会写清楚"没验成功"。
 *
 * CSP 禁 inline style：本文件只用 class 与 textContent，一个 `style` 都不写。
 */

(function () {
  const SECTION_ID = 'sync.devices';
  /** 与后端 modules/sync/service.js 的默认口径一致。 */
  const SYNC_TIMEOUT_MS = 4000;

  const ui = {
    mount: null,
    status: null,
    settings: null,
    error: null,
    /** 'run' | 'save' | null */
    busy: null,
    /** 上一次「立即同步」的报告（后端返回的人话报告原样留着） */
    report: null,
    /** 环境事实：hostname + 同源 /auth/config 探测结果（null = 没验成功） */
    facts: { hostname: '', authConfig: null },
    /** 复选框的当前值（重画时从这里恢复，避免"点一下就被重建重置"） */
    form: { aiConfig: false, lms: false },
  };

  /* ------------------------------------------------------------ 工具 */

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function shortId(id) {
    return String(id ?? '').slice(0, 8) || '—';
  }

  /** 错误标题：把后端错误码翻成"该干什么"。 */
  function errorTitle(code) {
    return (
      {
        NOT_LOGGED_IN: '还没登录',
        TOKEN_EXPIRED: '登录已过期',
        SERVER_UNREACHABLE: '连不上服务器',
        SERVER_TIMEOUT: '服务器没响应',
        SYNC_UNAVAILABLE: '这台服务器没有同步接口',
        BAD_SERVER_URL: '服务器地址不对',
        FORBIDDEN: '服务器拒绝了这次同步',
        SECRETS_NOT_ALLOWED_HERE: '网页版不提供敏感数据同步',
        PAYLOAD_TOO_LARGE: '这一批数据太大',
        BAD_RESPONSE: '服务器返回的数据看不懂',
        SERVER_ERROR: '服务器内部错误',
      }[code] ?? '同步没成功'
    );
  }

  /** 报告/错误里的一句话；`error.message` 已经是后端写好的中文人话。 */
  function errorBoxFor(error) {
    const code = error?.code ?? error?.payload?.error?.code ?? null;
    const box = mk('div', 'sync-alert');
    box.appendChild(mk('div', 'sync-alert-title', errorTitle(code)));
    box.appendChild(mk('div', 'sync-alert-msg', error?.message ?? '未知错误'));
    if (code === 'TOKEN_EXPIRED' || code === 'NOT_LOGGED_IN') {
      box.appendChild(mk('div', 'sync-alert-hint', '到上面「账号登录」那一块重新登录之后，再回来点「立即同步」。'));
    }
    if (code === 'SERVER_UNREACHABLE') {
      box.appendChild(mk('div', 'sync-alert-hint', '检查服务器地址与端口（「账号登录」里那一栏），确认对方在跑。'));
    }
    return box;
  }

  function button(className, label, busyLabel, action, onClick) {
    const busy = ui.busy === action;
    const node = mk('button', className, busy ? busyLabel : label);
    node.type = 'button';
    node.disabled = Boolean(ui.busy);
    node.addEventListener('click', onClick);
    return node;
  }

  function kv(label, value) {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value ?? '—'));
    return row;
  }

  /* ------------------------------------------------------------ 环境判定 */

  /**
   * 同源 `/auth/config` 是否可达（`true`/`false`/`null`）。
   *
   * `null` = **没验成功**（离线、被 CSP 拦、环境里没有 fetch）：后端会给出 `unknown`，
   * 按原生客户端处理并在面板里写明。绝不能把"没验成功"当成"不是网页版"或"是网页版"。
   */
  async function probeAuthConfig() {
    if (typeof fetch !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS) : null;
    try {
      const response = await fetch('/auth/config', { credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {}) });
      return Boolean(response?.ok);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function factsQuery() {
    const params = new URLSearchParams();
    if (ui.facts.hostname) params.set('hostname', ui.facts.hostname);
    if (ui.facts.authConfig !== null) params.set('authConfig', ui.facts.authConfig ? '1' : '0');
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  /** 后端要求 POST 的 body 里也带上这两个事实（它自己算结论，不信我们传的结论）。 */
  function factsBody() {
    return {
      hostname: ui.facts.hostname,
      ...(ui.facts.authConfig === null ? {} : { authConfigReachable: ui.facts.authConfig }),
    };
  }

  /* ------------------------------------------------------------ 数据 */

  async function loadStatus() {
    const data = await PC.api(`/sync/status${factsQuery()}`);
    ui.status = data ?? null;
    ui.form.aiConfig = data?.syncSecrets?.aiConfig === true;
    ui.form.lms = data?.syncSecrets?.lms === true;
    return data;
  }

  async function refresh() {
    ui.error = null;
    paint();
    try {
      ui.facts.hostname = String(window.location?.hostname ?? '');
      ui.facts.authConfig = await probeAuthConfig();
      await loadStatus();
    } catch (error) {
      ui.error = error;
    } finally {
      paint();
    }
  }

  /** 跑一个会改状态的动作：置 busy → 请求 → 刷新 → 失败显示人话。 */
  async function run(action, task) {
    if (ui.busy) return;
    ui.busy = action;
    ui.error = null;
    paint();
    try {
      await task();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.busy = null;
      try {
        await loadStatus();
      } catch {
        /* 状态读不到就保持上一次的：错误已经显示在上面了 */
      }
      paint();
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  function accountLine() {
    const account = ui.status?.account ?? null;
    if (!account || !account.connected) {
      const box = mk('div', 'sync-alert is-warn');
      box.appendChild(mk('div', 'sync-alert-title', '还没登录'));
      box.appendChild(mk('div', 'sync-alert-msg', '同步需要先登录服务器：请在上面「账号登录」那一块登录，再回来点「立即同步」。'));
      return box;
    }
    const rows = mk('div', 'sync-kv');
    rows.append(
      kv('账号', `${account.user?.username ?? '（不知道是谁）'}${account.user?.role === 'admin' ? '（管理员）' : ''}`),
      kv('服务器', account.serverUrl || '（同源：和页面同一台服务器）'),
      kv('设备名', ui.status?.deviceName ?? '—'),
      kv('设备标识', shortId(ui.status?.deviceId)),
      kv('上次推送', formatTime(ui.status?.lastPushAt)),
      kv('上次拉取', formatTime(ui.status?.lastPullAt)),
    );
    const wrap = mk('div', 'sync-account');
    wrap.appendChild(rows);
    if (ui.status?.lastError) {
      const box = mk('div', 'sync-alert is-warn');
      box.appendChild(mk('div', 'sync-alert-title', '上次同步失败'));
      box.appendChild(mk('div', 'sync-alert-msg', `${formatTime(ui.status.lastError.at)}：${ui.status.lastError.message}`));
      wrap.appendChild(box);
    }
    return wrap;
  }

  /** 各集合条数（敏感集合额外标注"本机没开同步"）。 */
  function collectionsTable() {
    const collections = ui.status?.collections ?? {};
    const box = mk('div', 'sync-collections');
    for (const [name, info] of Object.entries(collections)) {
      const cell = mk('div', 'sync-collection');
      cell.appendChild(mk('span', 'sync-collection-name', info.label ?? name));
      const count = info.kind === 'file' ? (info.count ? '已配置' : '未配置') : String(info.count ?? 0);
      cell.appendChild(mk('span', 'sync-collection-count', count));
      const marks = [];
      if (info.secret && !info.enabled) marks.push('敏感：本机未开启');
      if (info.deleteSync === 'none') marks.push('不支持删除同步');
      if (marks.length) cell.appendChild(mk('span', 'sync-collection-tag', marks.join(' · ')));
      cell.title = info.secret && !info.enabled ? '这台设备没有开启这项敏感数据同步，服务器上的数据不会被写进来' : '';
      box.appendChild(cell);
    }
    return box;
  }

  /** 「立即同步」+ 上一次的报告（人话数字）。 */
  function syncActions() {
    const box = mk('div', 'sync-actions');
    box.appendChild(
      button('primary-btn', '立即同步', '同步中…', 'run', () => {
        void run('run', async () => {
          const report = await PC.api('/sync/run', { method: 'POST', body: { ...factsBody() } });
          ui.report = report;
          if (report?.skipped === true) {
            // 注意 `=== true`：`skipped` 是**数字**时表示"跳过多少条"（见 reportBox 的说明）
            PC.toast(report.reason === 'no_server' ? '这台机器没有配置要同步的服务器' : '先登录再同步');
          } else if (report?.ok) {
            PC.toast(`同步完成：推了 ${report.pushed} 条，拉了 ${report.pulled} 条`);
          } else {
            PC.toast(`同步没成功：${report?.error?.message ?? '未知原因'}`);
          }
        });
      }),
    );
    box.appendChild(mk('span', 'sync-hint', '启动程序时也会自动同步一次；失败只在下面显示，不打断你。'));
    return box;
  }

  /**
   * 报告：数字 + 清单。字段名是冻结契约，这里只是把它们翻成人话。
   *
   * ⚠️ `skipped` 这一个字段有两种语义（接口冻结，不能改名）：
   *   - `skipped === true`（**布尔**）：这一轮根本没跑（没地址 / 没登录），`reason` 说明为什么；
   *   - `skipped === 0/7/…`（**数字**）：正常跑的轮次里"跳过多少条"。
   * 所以在代码里一律用 `=== true` 判断"没跑"，绝不能写真值判断 —— 否则一个正常的
   * "跳过 7 条"的报告会被显示成"还没有登录，不能同步"。
   */
  function reportBox() {
    const report = ui.report ?? null;
    if (!report) return null;
    if (report.skipped === true) {
      const box = mk('div', 'sync-report');
      const reasons = {
        no_server: '这台机器没有配置服务器，无需同步',
        no_account: '还没有登录，不能同步',
        bad_server: '服务器地址不对，没有发起同步',
      };
      box.appendChild(mk('div', 'sync-report-title', reasons[report.reason] ?? '这一轮没有同步'));
      return box;
    }
    const box = mk('div', 'sync-report');
    box.appendChild(mk('div', 'sync-report-title', report.ok ? `同步完成（用时 ${report.durationMs} ms）` : `同步没成功（用时 ${report.durationMs} ms）`));
    if (!report.ok && report.error) {
      box.appendChild(errorBoxFor(report.error));
    }
    const stats = mk('div', 'sync-stats');
    const cells = [
      ['推了', report.pushed],
      ['拉了', report.pulled],
      ['更新', report.updated],
      ['跳过', report.skipped],
      ['重命名', report.renamed],
      ['删除', report.deleted],
      ['疑似重复', (report.duplicates ?? []).length],
      ['冲突', (report.conflicts ?? []).length],
    ];
    for (const [label, value] of cells) {
      const cell = mk('div', 'sync-stat');
      cell.append(mk('span', 'sync-stat-value', String(value ?? 0)), mk('span', 'sync-stat-label', label));
      stats.appendChild(cell);
    }
    box.appendChild(stats);

    // 「重命名」必须解释清楚：它不是丢数据，而是"同一条记录被两台设备改成了不同内容，
    // 两条都留、来的一条换了个 id"。
    if (report.renamed) {
      box.appendChild(mk('div', 'sync-note', `重命名的 ${report.renamed} 条是「两条都留」的结果：同一条记录在两台设备上被改成了不同的内容，本机这条保留原 id，另一条换了个 id 存下来，哪条都不要请自己删。`));
    }
    if (report.skippedSecrets?.length) {
      box.appendChild(mk('div', 'sync-note is-warn', `本机没有开启这些敏感数据的同步，服务器上的对应数据没有写进本机：${report.skippedSecrets.join('、')}。要同步请在下面勾选。`));
    }
    if (report.unsupportedDeletes?.length) {
      const names = [...new Set(report.unsupportedDeletes.map((item) => item.label ?? item.collection))];
      box.appendChild(mk('div', 'sync-note is-warn', `这些集合不支持删除同步（本机删除不会传播，另一侧删除也不会删本机）：${names.join('、')}。笔记有回收站（软删除），删除会跟着记录一起同步。`));
    }
    box.appendChild(listBox('疑似重复（两条都留，需要你自己决定）', report.duplicates ?? []));
    box.appendChild(listBox('冲突（同一条记录两边改得不一样）', report.conflicts ?? []));
    return box;
  }

  function listBox(title, items) {
    const box = mk('div', 'sync-list');
    box.appendChild(mk('div', 'sync-list-title', `${title}：${items.length} 条`));
    if (!items.length) return box;
    for (const item of items.slice(0, 8)) {
      const row = mk('div', 'sync-list-item');
      const label = item.label ?? item.collection ?? '';
      const origin = item.origin?.name ? `来自 ${item.origin.name}` : '';
      row.appendChild(mk('span', 'sync-list-main', `${label} · ${item.title || item.id || ''}`.trim()));
      row.appendChild(mk('span', 'sync-list-sub', `${item.detail ?? ''}${origin ? `（${origin}）` : ''}`));
      box.appendChild(row);
    }
    if (items.length > 8) box.appendChild(mk('div', 'sync-list-more', `还有 ${items.length - 8} 条，见接口 /api/v1/sync/status 的 lastResult 或后端日志`));
    return box;
  }

  /**
   * 敏感数据开关。
   *
   * 三件事必须写在界面上（用户口径：默认不同步、只能在自己的设备上开、风险要说清）：
   *   - 默认两项都是关的；
   *   - 数据存在**你自己账号的那台服务器**上，只有你自己的账号能读到（服务端版每账号一台
   *     独立实例 + 独立数据目录）；
   *   - 学堂凭据在服务端版**只存不用**（服务端版连学堂模块都不加载）。
   */
  function secretsPanel() {
    const runtime = ui.status?.runtime ?? null;
    const box = mk('div', 'sync-secrets');

    if (runtime?.kind === 'web') {
      const note = mk('div', 'sync-note');
      note.textContent = '网页版不提供敏感数据同步；要同步学堂账号与 API key，请在桌面端或手机 App 的「设置 → 多端同步」里开启。';
      box.appendChild(note);
      return box;
    }

    box.appendChild(mk('div', 'sync-group-title', '敏感数据（默认不同步，只能在这台设备上开）'));
    if (runtime?.kind === 'unknown') {
      box.appendChild(mk('div', 'sync-note is-warn', `没验成功"这是不是网页版"（${runtime.reason}）`));
    }

    const ai = checkbox('sync-secret-ai', '同步 AI 配置与密钥', ui.form.aiConfig, 'aiConfig');
    ai.wrap.appendChild(mk('span', 'sync-hint', '开启后你的 AI key 也会同步到你的服务器（你登录的那台，只有你这个账号能看到）；换新设备时不用再手填一遍。'));
    box.appendChild(ai.wrap);

    const lms = checkbox('sync-secret-lms', '同步思源学堂账号密码', ui.form.lms, 'lms');
    lms.wrap.appendChild(
      mk(
        'span',
        'sync-hint',
        '保存在你自己的服务器上；服务端版不会用它登录（只做存储，服务端版连学堂模块都不加载），桌面端/手机才会用它。程序从不保存密码明文，这里同步的是登录后的会话票据（auth-session.json，0600）。',
      ),
    );
    box.appendChild(lms.wrap);

    const actions = mk('div', 'sync-actions');
    actions.appendChild(
      button('ghost-btn', '保存开关', '保存中…', 'save', () => {
        const next = { aiConfig: ui.form.aiConfig, lms: ui.form.lms };
        void run('save', async () => {
          const result = await PC.api('/sync/settings', { method: 'POST', body: { syncSecrets: next, ...factsBody() } });
          ui.form.aiConfig = result?.syncSecrets?.aiConfig === true;
          ui.form.lms = result?.syncSecrets?.lms === true;
          PC.toast('已保存同步范围');
        });
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function checkbox(id, label, checked, key) {
    const wrap = mk('label', 'sync-secret');
    const box = mk('input', 'sync-secret-box');
    box.type = 'checkbox';
    box.id = id;
    box.checked = Boolean(checked);
    box.disabled = Boolean(ui.busy);
    box.addEventListener('change', () => {
      ui.form[key] = box.checked;
      paint();
    });
    wrap.append(box, mk('span', 'sync-secret-label', label));
    return { wrap, box };
  }

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    if (!ui.status && !ui.error) {
      mount.appendChild(mk('div', 'sync-loading', '正在读取同步状态…'));
      return;
    }
    if (ui.error && !ui.status) {
      mount.appendChild(errorBoxFor(ui.error));
      return;
    }
    if (ui.error) mount.appendChild(errorBoxFor(ui.error));

    const wrap = mk('div', 'sync');
    wrap.appendChild(accountLine());
    if (ui.status?.account?.connected) {
      wrap.appendChild(collectionsTable());
      wrap.appendChild(syncActions());
      const report = reportBox();
      if (report) wrap.appendChild(report);
    } else {
      wrap.appendChild(syncActions());
    }
    wrap.appendChild(secretsPanel());
    mount.appendChild(wrap);
  }

  /** 区块登记。order 89：紧跟在「账号登录」(88) 之后、「AI 接入」附近，符合"先登录再同步"。 */
  window.PCModules.registerSettingsSection({
    id: SECTION_ID,
    title: '多端同步',
    order: 89,
    render(mount) {
      ui.mount = mount;
      paint();
      void refresh();
    },
  });

  /** 给测试用的只读句柄（渲染层结构测试直接读它，不必解析 DOM 文本）。 */
  window.PCSyncView = {
    sectionId: SECTION_ID,
    state: ui,
    probeAuthConfig,
    factsQuery,
    errorTitle,
  };
})();
