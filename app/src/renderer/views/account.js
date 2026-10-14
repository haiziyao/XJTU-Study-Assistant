/**
 * 「设置 → 账号登录」区块。
 *
 * 这一块解决的是**身份**，不是数据：登录之后服务器知道"你是谁"，但**不做任何同步**。
 * 界面上必须把这件事说清楚（见下方 SYNC_NOTE）—— 否则用户会以为登录完笔记就上云了，
 * 那种误解比没有同步功能本身更危险。
 *
 * 为什么要经过本机后端（而不是页面直接 fetch 服务器）
 * --------------------------------------------------
 * 页面在 `http://127.0.0.1:3210`，公开服务端在 `http://localhost:8866`，**跨域**；
 * 而服务端版故意不发 CORS 头。会话令牌又是 `HttpOnly` Cookie，本来就该只待在 HTTP 层。
 * 所以这里只调 `/account/**`（我们自己的后端），由后端持令牌去跟服务器说话 ——
 * 页面上**永远拿不到令牌**。
 *
 * 注册方式与其它设置区块一致（见 kit/registry.js）：`PCModules.registerSettingsSection`，
 * 外壳负责给卡片，这里只管卡片内部。文本一律 textContent，不写 inline style（CSP 会拦），
 * 颜色只用主题令牌。
 */

(function () {
  const SECTION_ID = 'account.login';
  /** 与后端 modules/account/service.js 的 DEFAULT_SERVER_URL 保持一致。 */
  const DEFAULT_SERVER_URL = 'http://localhost:8866';
  /** placeholder 里的示例：公网服务端长什么样（与后端错误文案里的示例同一个地址）。 */
  const EXAMPLE_SERVER_URL = 'https://study.xjtuwhy.com';
  /** 输入框下方那句提示（后端会替用户补协议，这里告诉他该写哪种）。 */
  const SERVER_HINT = '国内服务器请填 https://；本机开发填 http://localhost:8866';

  /** 当前已渲染的输入框引用（paint 重建时被覆盖）。 */
  const formInputs = { serverUrl: null, username: null, password: null, inviteCode: null };

  /** 面板状态。`status === null` 表示还没读到（首次渲染时的加载态）。 */
  const ui = {
    mount: null,
    status: null,
    error: null,
    /** 正在进行的动作：'login' | 'register' | 'probe' | 'logout' | null */
    busy: null,
    /** 上一次探测结果（`/account/probe`） */
    probe: null,
    /** 注册表单是否展开 */
    showRegister: false,
    /** 退出登录的两步确认（不用 window.confirm：那会阻塞渲染进程，样式也不受控） */
    confirmLogout: false,
    /**
     * 表单里用户已经敲进去的内容。
     *
     * **必须存一份**：本区块的 `paint()` 是整块重建 DOM 的，而 `run()` 在发请求**之前**
     * 会先 paint 一次（把按钮切成"登录中…"并禁用）。若不定住这些值，
     * 用户刚填的用户名/密码会在点下按钮的瞬间被重建清空 —— 真机上表现为
     * 「点了登录却说用户名和密码都要填」。（这个 bug 就是真机验证抓出来的，
     * DOM 桩上因为时序不同没暴露。）
     */
    form: { serverUrl: '', username: '', password: '', inviteCode: '' },
  };

  /** 从已渲染的输入框里把值收进 `ui.form`（paint 前调用，重建后据此还原）。 */
  function captureForm() {
    for (const [key, node] of Object.entries(formInputs)) {
      if (node) ui.form[key] = node.value;
    }
  }

  /** 建一个输入框，并把它登记进 `formInputs` 以便下次 paint 前取值。 */
  function boundInput(key, className, options) {
    const node = input(className, options);
    formInputs[key] = node;
    return node;
  }

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function input(className, { type = 'text', placeholder, autocomplete, value } = {}) {
    const node = mk('input', className);
    node.type = type;
    if (placeholder) node.placeholder = placeholder;
    if (autocomplete) node.autocomplete = autocomplete;
    if (value !== undefined) node.value = value;
    return node;
  }

  /** 一行键值，与设置页其它卡片同款。 */
  function kv(label, value) {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value ?? '—'));
    return row;
  }

  function field(labelText, control, hint) {
    const wrap = mk('label', 'acct-field');
    wrap.appendChild(mk('span', 'acct-field-label', labelText));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(mk('span', 'acct-field-hint', hint));
    return wrap;
  }

  /**
   * 错误提示。
   *
   * 后端已经把错误码翻成了中文人话（`error.message`），这里**原样显示**即可。
   * 标题按错误码换个说法：`BAD_SERVER_URL`（地址格式不对）与 `NOT_POTATO_SERVER`
   * （地址能打开但不是智学服务端）最容易被误读成"网络坏了"，直接写在标题上，
   * 用户一眼就知道该改哪里。认不出来的仍用通用标题。
   */
  function errorBox(error) {
    const titles = {
      BAD_SERVER_URL: '服务器地址不对',
      NOT_POTATO_SERVER: '这个地址不是「AI 智学」的服务端',
      REDIRECT_REFUSED: '服务器要求跳到别处，已停下',
    };
    // 外壳的 PC.api 抛的是普通 Error：错误码在 `payload.error.code` 里（也可能被测试桩直接放在 code 上）
    const code = error?.code ?? error?.payload?.error?.code ?? null;
    const box = mk('div', 'acct-alert');
    box.appendChild(mk('div', 'acct-alert-title', titles[code] ?? '没成功'));
    box.appendChild(mk('div', 'acct-alert-msg', error?.message ?? '未知错误'));
    return box;
  }

  /** 按钮：进行中禁用并换成"登录中…"这类进行时文案。 */
  function button(className, label, busyLabel, onClick, action) {
    const busy = ui.busy === action;
    const node = mk('button', className, busy ? busyLabel : label);
    node.type = 'button';
    node.disabled = Boolean(ui.busy);
    node.addEventListener('click', onClick);
    return node;
  }

  /** 把后端返回的 loginAt（ISO）显示成本地时间，读不出来就原样显示。 */
  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  /* ------------------------------------------------------------ 数据 */

  async function loadStatus() {
    const data = await PC.api('/account');
    ui.status = {
      connected: Boolean(data?.connected),
      serverUrl: data?.serverUrl ?? '',
      user: data?.user ?? null,
      loginAt: data?.loginAt ?? null,
    };
    return ui.status;
  }

  async function refresh() {
    ui.error = null;
    paint();
    try {
      await loadStatus();
    } catch (error) {
      ui.error = error;
    } finally {
      paint();
    }
  }

  /** 跑一个会改状态的动作：置 busy -> 请求 -> 刷新面板 -> 失败显示人话。 */
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
        /* 状态读不到就保持上一次的，错误已经显示在上面了 */
      }
      paint();
    }
  }

  /* ------------------------------------------------------------ 未登录 */

  function loginForm() {
    const box = mk('div', 'acct-form');
    const serverUrl = boundInput('serverUrl', 'acct-input', {
      // placeholder 用公网示例：绝大多数用户填的是"别人给的服务器"，本机开发是少数
      placeholder: EXAMPLE_SERVER_URL,
      autocomplete: 'off',
      // 默认填上次/默认地址，但**用户改过就以用户为准**（重画不能把它抹掉）
      value: ui.form.serverUrl || ui.status?.serverUrl || DEFAULT_SERVER_URL,
    });
    const username = boundInput('username', 'acct-input', { placeholder: '用户名', autocomplete: 'username', value: ui.form.username });
    const password = boundInput('password', 'acct-input', { type: 'password', placeholder: '密码', autocomplete: 'current-password', value: ui.form.password });

    box.append(
      field('服务器地址', serverUrl, SERVER_HINT),
      field('用户名', username),
      field('密码', password),
    );

    const actions = mk('div', 'acct-actions');
    const login = button('primary-btn', '登录', '登录中…', () => {
      // 先把当前输入收进 ui.form：run() 会立刻重画一次（按钮变"登录中…"），
      // 直接读 DOM 节点会读到重建后的空值 —— 这正是之前真机上"用户名和密码都要填"的根因。
      // 用 formInputs 里的**当前**节点，而不是闭包捕获的旧节点：
      // run() 会立刻重画一次，闭包里的节点那时已经被丢弃（值读出来是空的）。
      const payload = {
        serverUrl: (formInputs.serverUrl?.value ?? '').trim(),
        username: (formInputs.username?.value ?? '').trim(),
        password: formInputs.password?.value ?? '',
      };
      captureForm();
      void run('login', async () => {
        const result = await PC.api('/account/login', { method: 'POST', body: payload });
        // 把**后端归一化（含跳转）之后的地址**报给用户：他填 `http://…` 被 301 到 https 时，
        // 下次照着这句填就不用再挨一次跳转
        const where = result?.serverUrl ? `（服务器 ${result.serverUrl}）` : '';
        PC.toast(`已登录：${result?.user?.username ?? payload.username}${where}`);
      });
    }, 'login');
    actions.appendChild(login);

    const probe = button('ghost-btn', '测试连接', '测试中…', () => {
      const target = (formInputs.serverUrl?.value ?? '').trim() || ui.status?.serverUrl || DEFAULT_SERVER_URL;
      void run('probe', async () => {
        // probe 永远返回 200（不可达也是 reachable:false），所以不用 try/catch 分支处理
        ui.probe = await PC.api(`/account/probe?serverUrl=${encodeURIComponent(target)}`);
      });
    }, 'probe');
    actions.appendChild(probe);

    const toggle = mk('button', 'ghost-btn', ui.showRegister ? '收起注册' : '用邀请码注册');
    toggle.type = 'button';
    toggle.disabled = Boolean(ui.busy);
    toggle.addEventListener('click', () => {
      ui.showRegister = !ui.showRegister;
      paint();
    });
    actions.appendChild(toggle);
    box.appendChild(actions);

    if (ui.probe) box.appendChild(probeResult(ui.probe));
    if (ui.showRegister) box.appendChild(registerForm(ui.form.serverUrl, ui.form.username));
    return box;
  }

  /** 「测试连接」的结果：地址 / 服务器名 / 版本 / 该服务器上 LMS 不可用。 */
  function probeResult(result) {
    const box = mk('div', `acct-probe ${result.reachable ? 'is-ok' : 'is-off'}`);
    if (!result.reachable) {
      box.appendChild(mk('div', 'acct-probe-line', result.error || '连不上这个服务器：检查地址与端口，确认对方在跑'));
      box.appendChild(mk('div', 'acct-probe-note', '写地址可以不写协议：域名按 https:// 试，本机（localhost / 127.0.0.1）按 http:// 试。'));
      return box;
    }
    box.appendChild(mk('div', 'acct-probe-line is-ok', `服务器可达：${result.serverName ?? '（没报名字）'}${result.version ? ` · 版本 ${result.version}` : ''}`));
    if (result.serverUrl) {
      // 显示**归一化之后的地址**（后端可能补了协议、也可能跟过 http→https 跳转）：
      // 用户下次直接填这个，就不会再踩"301 把 POST 变 GET"那一脚
      box.appendChild(mk('div', 'acct-probe-note is-ok', `地址已确认：${result.serverUrl}（下次就填这个）`));
    }
    if (result.features && result.features.lms === false) {
      // 如实说明：服务端版出于凭据托管的考虑不提供学堂同步，这不是"还没做"
      box.appendChild(mk('div', 'acct-probe-line warn', '该服务器上思源学堂不可用（服务端版不代持学校账号密码，桌面端才有学堂同步）'));
    }
    if (result.firstUserBecomesAdmin) {
      box.appendChild(mk('div', 'acct-probe-note', '这台服务器第一个注册的账号会成为管理员；之后注册需要管理员发的邀请码。'));
    }
    return box;
  }

  /** 注册表单：用户名 / 密码 / 邀请码。 */
  function registerForm(serverUrlValue, usernameValue) {
    const box = mk('div', 'acct-register');
    box.appendChild(mk('div', 'acct-group-title', '用邀请码注册'));

    const serverUrl = boundInput('serverUrl', 'acct-input', { placeholder: EXAMPLE_SERVER_URL, value: ui.form.serverUrl || serverUrlValue || DEFAULT_SERVER_URL, autocomplete: 'off' });
    const username = boundInput('username', 'acct-input', { placeholder: '用户名（3–32 位字母/数字/._-）', autocomplete: 'username', value: ui.form.username || usernameValue || '' });
    const password = boundInput('password', 'acct-input', { type: 'password', placeholder: '密码（至少 8 位）', autocomplete: 'new-password', value: ui.form.password });
    const inviteCode = boundInput('inviteCode', 'acct-input', { placeholder: '邀请码', autocomplete: 'off', value: ui.form.inviteCode });

    box.append(
      field('服务器地址', serverUrl, SERVER_HINT),
      field('用户名', username),
      field('密码', password, '服务端只存密码的哈希，不存明文。'),
      field('邀请码', inviteCode, '找服务器管理员要；一次性使用。'),
    );

    const actions = mk('div', 'acct-actions');
    actions.appendChild(
      button('primary-btn', '注册并登录', '注册中…', () => {
        const payload = {
          serverUrl: (formInputs.serverUrl?.value ?? '').trim(),
          username: (formInputs.username?.value ?? '').trim(),
          password: formInputs.password?.value ?? '',
          inviteCode: (formInputs.inviteCode?.value ?? '').trim(),
        };
        captureForm();
        void run('register', async () => {
          const result = await PC.api('/account/register', { method: 'POST', body: payload });
          const where = result?.serverUrl ? `（服务器 ${result.serverUrl}）` : '';
          PC.toast(`已注册并登录：${result?.user?.username ?? payload.username}${where}`);
        });
      }, 'register'),
    );
    box.appendChild(actions);
    return box;
  }

  /* ------------------------------------------------------------ 已登录 */

  function connectedPanel() {
    const status = ui.status;
    const user = status.user ?? {};
    const box = mk('div', 'acct-connected');

    const head = mk('div', 'acct-summary');
    head.appendChild(mk('span', 'acct-badge is-ok', '已登录'));
    const who = `已登录：${user.username ?? '（不知道是谁）'}${user.role === 'admin' ? '（管理员）' : ''}`;
    head.appendChild(mk('span', 'acct-user', who));
    box.appendChild(head);

    const list = mk('div', 'acct-kv');
    list.append(
      kv('服务器地址', status.serverUrl || '（同源：和页面同一台服务器）'),
      kv('登录时间', formatTime(status.loginAt)),
    );
    if (user.role) list.appendChild(kv('角色', user.role === 'admin' ? '管理员' : '普通用户'));
    box.appendChild(list);

    const actions = mk('div', 'acct-actions');
    if (ui.confirmLogout) {
      actions.appendChild(
        button('danger-btn', '确认退出登录', '退出中…', () => {
          ui.confirmLogout = false;
          void run('logout', async () => {
            await PC.api('/account/logout', { method: 'POST', body: {} });
            ui.probe = null;
            PC.toast('已退出登录');
          });
        }, 'logout'),
      );
      const cancel = mk('button', 'ghost-btn', '取消');
      cancel.type = 'button';
      cancel.disabled = Boolean(ui.busy);
      cancel.addEventListener('click', () => {
        ui.confirmLogout = false;
        paint();
      });
      actions.appendChild(cancel);
    } else {
      actions.appendChild(
        button('ghost-btn', '退出登录', '退出中…', () => {
          // 两步确认：退出本身不危险，但"点了没反应"会让人反复点，所以先问一句
          ui.confirmLogout = true;
          paint();
        }, 'logout'),
      );
    }
    box.appendChild(actions);

    box.appendChild(mk('div', 'acct-note', SYNC_NOTE));
    return box;
  }

  /**
   * 必须诚实的一句话：现在**没有任何同步**。
   *
   * 登录只解决身份（服务器知道你是谁）。跨设备数据同步的合并规则还没定，
   * 所以既不会自动上传，也不会覆盖本地数据。等规则定了再改这句话，别提前许诺。
   */
  const SYNC_NOTE =
    '登录只解决身份；跨设备数据同步的合并规则还没定，暂不会自动上传或覆盖你的本地数据。';

  /* ------------------------------------------------------------ 渲染 */

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    // **先收值、再重建**：用户敲进去的内容不能因为一次重画就没了（详见 ui.form 的说明）
    captureForm();
    mount.innerHTML = '';

    if (!ui.status) {
      if (ui.error) mount.appendChild(errorBox(ui.error));
      else mount.appendChild(mk('div', 'acct-loading', '正在读取登录状态…'));
      return;
    }

    if (ui.error) mount.appendChild(errorBox(ui.error));

    if (ui.status.connected) {
      mount.appendChild(connectedPanel());
      return;
    }

    mount.appendChild(
      mk(
        'div',
        'acct-note',
        '登录后这台服务器知道"你是谁"。账号是服务端版的账号，和学校统一身份认证是两回事 —— 学校账号仍然只在「统一身份认证」那块登录。',
      ),
    );
    mount.appendChild(loginForm());
  }

  /** 区块登记。order 88：紧挨「AI 接入」，在账号相关的设置里靠前。 */
  window.PCModules.registerSettingsSection({
    id: SECTION_ID,
    title: '账号登录',
    order: 88,
    render(mount) {
      ui.mount = mount;
      paint();
      void refresh();
    },
  });
})();
