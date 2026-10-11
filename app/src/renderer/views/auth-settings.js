/**
 * 「设置 → 统一身份认证」卡片。
 *
 * 这是**全程序唯一的登录入口**。各业务模块（思源学堂、学业情况…）不再自己提供密码表单，
 * 它们只需要在这里被登录一次 —— 共享的 Cookie 罐会带着 CAS 票据替它们完成各自的站点认证。
 *
 * 界面要如实说清三件事，否则用户会困惑：
 *   1. 整体是否已登录、用的哪个账号；
 *   2. **逐站点**是否就绪（学堂 ✓ / 教务 ✓）—— 因为"登录成功但某个站点没通"是真实存在的状态
 *      （SSO 对该站点不适用、或该账号在那个系统里没有权限）；
 *   3. 需要两步验证 / 图形验证码时，现在轮到用户做什么。
 *
 * 与其它视图一致：所有文本经 textContent 写入（等价于转义），不用 innerHTML 拼接。
 */

(function () {
  const ui = {
    mount: null,
    loading: false,
    busy: null,
    error: null,
    status: null,
    /** 登录表单的临时输入；**不落任何地方**，提交后就地清空密码 */
    form: { username: '', password: '', captcha: '' },
    mfaCode: '',
    mfaSent: false,
  };

  /* ------------------------------------------------------------ 取数 */

  async function loadStatus() {
    ui.status = await PC.api('/auth/status');
    if (ui.status?.loggedIn && ui.status.username) ui.form.username = ui.status.username;
    return ui.status;
  }

  async function refresh() {
    ui.loading = true;
    ui.error = null;
    paint();
    try {
      await loadStatus();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.loading = false;
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

  const doLogin = () =>
    withBusy('login', async () => {
      const username = ui.form.username.trim();
      if (!username || !ui.form.password) {
        ui.error = new Error('请填写学号与密码');
        return;
      }
      const result = await PC.api('/auth/login', {
        method: 'POST',
        body: { username, password: ui.form.password, captcha: ui.form.captcha || undefined },
      });
      // 密码用完即弃：不论成功与否都不留在内存里
      ui.form.password = '';
      ui.form.captcha = '';
      ui.status = result?.sites ? result : await loadStatus();
      if (result?.status === 'error') ui.error = new Error(result.error ?? '登录失败');
      await loadStatus();
    });

  const doSendMfa = () =>
    withBusy('mfa-send', async () => {
      const result = await PC.api('/auth/mfa/send', { method: 'POST', body: {} });
      ui.mfaSent = true;
      ui.status = result?.status ?? (await loadStatus());
      await loadStatus();
    });

  const doVerifyMfa = () =>
    withBusy('mfa-verify', async () => {
      const code = ui.mfaCode.trim();
      if (!code) {
        ui.error = new Error('请填写短信验证码');
        return;
      }
      const result = await PC.api('/auth/mfa/verify', { method: 'POST', body: { code } });
      ui.mfaCode = '';
      ui.mfaSent = false;
      if (result?.status === 'error') ui.error = new Error(result.error ?? '验证失败');
      await loadStatus();
    });

  const doLogout = () =>
    withBusy('logout', async () => {
      await PC.api('/auth/logout', { method: 'POST', body: {} });
      ui.mfaSent = false;
      ui.mfaCode = '';
      await loadStatus();
    });

  /** 让某个站点重新走一次认证（SSO 能救回来就静默救回）。 */
  const doEnsure = (siteId) =>
    withBusy(`ensure:${siteId}`, async () => {
      const outcome = await PC.api(`/auth/sites/${encodeURIComponent(siteId)}/ensure`, {
        method: 'POST',
        body: { revalidate: true },
      });
      if (outcome && outcome.ok === false) {
        ui.error = new Error(outcome.reason ?? '该站点仍不可用');
      }
      await loadStatus();
    });

  /* ------------------------------------------------------------ 渲染 */

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    if (ui.loading && !ui.status) {
      mount.appendChild(mk('div', 'kv-val', '正在读取登录状态…'));
      return;
    }

    if (ui.error) mount.appendChild(errorBox(ui.error));

    const status = ui.status ?? { loggedIn: false, sites: [] };
    mount.appendChild(summaryRow(status));
    mount.appendChild(siteList(status));

    if (!status.loggedIn) {
      if (status.mfa) mount.appendChild(mfaPanel(status));
      else mount.appendChild(loginPanel(status));
    } else {
      mount.appendChild(loggedInActions(status));
    }

    const note = mk('div', 'auth-note');
    note.appendChild(
      mk(
        'span',
        null,
        '学堂与教务用的是同一个学校账号：这里登录一次，两边都会自动完成认证。密码只发给学校，本程序不保存。',
      ),
    );
    mount.appendChild(note);
  }

  function summaryRow(status) {
    const row = mk('div', 'auth-summary');
    const badge = mk('span', `auth-badge ${status.loggedIn ? 'is-ok' : 'is-off'}`, status.loggedIn ? '已登录' : '未登录');
    row.appendChild(badge);
    if (status.loggedIn && status.username) {
      row.appendChild(mk('span', 'auth-user', status.username));
    }
    if (status.readyCount !== undefined && status.siteCount) {
      row.appendChild(mk('span', 'auth-count', `${status.readyCount}/${status.siteCount} 个站点就绪`));
    }
    const reload = mk('button', 'ghost-btn small', ui.loading ? '刷新中…' : '刷新状态');
    reload.type = 'button';
    reload.disabled = Boolean(ui.busy);
    reload.addEventListener('click', () => void refresh());
    row.appendChild(reload);
    return row;
  }

  function siteList(status) {
    const wrap = mk('div', 'auth-sites');
    const sites = status.sites ?? [];
    if (!sites.length) {
      wrap.appendChild(
        mk('div', 'kv-val', '还没有模块接入统一认证。等思源学堂 / 学业情况接入后，这里会逐个显示它们的认证状态。'),
      );
      return wrap;
    }
    for (const site of sites) {
      const item = mk('div', 'auth-site');
      item.appendChild(mk('span', `auth-dot ${site.ready ? 'is-ok' : 'is-off'}`));
      item.appendChild(mk('span', 'auth-site-name', site.label ?? site.id));

      const detail = site.ready
        ? site.optimistic
          ? '已就绪（沿用上次会话）'
          : site.lastOkAt
            ? `已就绪 · ${formatStamp(site.lastOkAt)}`
            : '已就绪'
        : (site.reason ?? '未登录');
      item.appendChild(mk('span', 'auth-site-state', detail));

      const retry = mk('button', 'ghost-btn small', ui.busy === `ensure:${site.id}` ? '连接中…' : '重新连接');
      retry.type = 'button';
      retry.disabled = Boolean(ui.busy);
      retry.addEventListener('click', () => void doEnsure(site.id));
      item.appendChild(retry);
      wrap.appendChild(item);
    }
    return wrap;
  }

  function loginPanel(status) {
    const panel = mk('div', 'auth-form');

    const user = mk('input', 'auth-input');
    user.type = 'text';
    user.placeholder = '学号 / 工号';
    user.autocomplete = 'username';
    user.value = ui.form.username;
    user.addEventListener('input', () => {
      ui.form.username = user.value;
    });
    panel.appendChild(field('账号', user));

    const pass = mk('input', 'auth-input');
    pass.type = 'password';
    pass.placeholder = '密码';
    pass.autocomplete = 'current-password';
    pass.addEventListener('input', () => {
      ui.form.password = pass.value;
    });
    pass.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void doLogin();
    });
    panel.appendChild(field('密码', pass, '只发往学校统一身份认证，本程序不保存'));

    if (status.captchaRequired) {
      const captchaRow = mk('div', 'auth-captcha');
      const img = mk('img', 'auth-captcha-img');
      img.src = `${PC.state.apiBase}/auth/captcha?t=${Date.now()}`;
      img.alt = '图形验证码';
      img.addEventListener('click', () => {
        img.src = `${PC.state.apiBase}/auth/captcha?t=${Date.now()}`;
      });
      captchaRow.appendChild(img);
      const input = mk('input', 'auth-input');
      input.type = 'text';
      input.placeholder = '图形验证码';
      input.addEventListener('input', () => {
        ui.form.captcha = input.value;
      });
      captchaRow.appendChild(input);
      panel.appendChild(field('图形验证码', captchaRow, '点击图片可刷新'));

      const sendCode = mk('button', 'ghost-btn', '改为发送短信验证码');
      sendCode.type = 'button';
      sendCode.disabled = Boolean(ui.busy);
      sendCode.addEventListener('click', () => void doSendMfa());
      panel.appendChild(sendCode);
    }

    const actions = mk('div', 'auth-actions');
    const submit = mk('button', 'primary-btn', ui.busy === 'login' ? '登录中…' : '登录');
    submit.type = 'button';
    submit.disabled = Boolean(ui.busy);
    submit.addEventListener('click', () => void doLogin());
    actions.appendChild(submit);
    panel.appendChild(actions);

    return panel;
  }

  function mfaPanel(status) {
    const panel = mk('div', 'auth-form');
    const phone = status.mfa?.phoneMasked;
    panel.appendChild(
      mk('div', 'kv-val', phone ? `需要两步验证，验证码已发送至 ${phone}` : '需要两步验证，请先获取短信验证码'),
    );

    if (!ui.mfaSent) {
      const send = mk('button', 'ghost-btn', ui.busy === 'mfa-send' ? '发送中…' : '发送验证码');
      send.type = 'button';
      send.disabled = Boolean(ui.busy);
      send.addEventListener('click', () => void doSendMfa());
      panel.appendChild(send);
    }

    const code = mk('input', 'auth-input');
    code.type = 'text';
    code.placeholder = '6 位短信验证码';
    code.autocomplete = 'one-time-code';
    code.value = ui.mfaCode;
    code.addEventListener('input', () => {
      ui.mfaCode = code.value;
    });
    code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void doVerifyMfa();
    });
    panel.appendChild(field('短信验证码', code));

    const actions = mk('div', 'auth-actions');
    const verify = mk('button', 'primary-btn', ui.busy === 'mfa-verify' ? '验证中…' : '完成验证');
    verify.type = 'button';
    verify.disabled = Boolean(ui.busy);
    verify.addEventListener('click', () => void doVerifyMfa());
    actions.appendChild(verify);
    panel.appendChild(actions);

    return panel;
  }

  function loggedInActions(status) {
    const actions = mk('div', 'auth-actions');
    const logout = mk('button', 'ghost-btn', ui.busy === 'logout' ? '退出中…' : '退出登录');
    logout.type = 'button';
    logout.disabled = Boolean(ui.busy);
    logout.addEventListener('click', () => void doLogout());
    actions.appendChild(logout);
    if (status.readyCount < status.siteCount) {
      actions.appendChild(
        mk('span', 'auth-count', '有站点尚未就绪 —— 可点上方的「重新连接」单独重试'),
      );
    }
    return actions;
  }

  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  window.PCModules.registerSettingsSection({
    id: 'auth.account',
    title: '统一身份认证',
    // 10：排在日历（日程分类）之后、笔记接入（50）之前 —— 登录是各模块的前置条件，靠前更合理
    order: 10,
    render(mount) {
      ui.mount = mount;
      paint();
      void refresh();
    },
  });
})();
