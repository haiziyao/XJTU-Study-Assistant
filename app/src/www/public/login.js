/*
 * 公开登录页的脚本：登录 / 注册两个表单 + `/auth/config` 的公开信息。
 *
 * 为什么用 `fetch` 而不是表单直接 POST：
 *   - 接口回的是 JSON（含 `error.code`），直接 POST 会把用户带到一页裸 JSON；
 *   - 提交后要留在本页显示"用户名已存在 / 邀请码无效 / 密码至少 8 位"这类具体原因，
 *     而不是让用户按浏览器后退键。
 *
 * 安全相关的两点：
 *   - 凭据只走**同源请求体**，`credentials: 'same-origin'` 保证会话 Cookie 会被带上；
 *     页面不把密码/令牌写进 localStorage、不写进 URL、也不打日志；
 *   - 这里是纯静态页面，脚本里**没有**任何服务端渲染进去的数据。
 */

(() => {
  'use strict';

  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const panelLogin = document.getElementById('panel-login');
  const panelRegister = document.getElementById('panel-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const errorBox = document.getElementById('error');
  const loginSubmit = document.getElementById('login-submit');
  const registerSubmit = document.getElementById('register-submit');
  const inviteHint = document.getElementById('invite-hint');

  /** 显示一条错误；`null` 表示清空。 */
  function showError(message) {
    if (!message) {
      errorBox.hidden = true;
      errorBox.textContent = '';
      return;
    }
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function selectTab(which) {
    const isLogin = which === 'login';
    tabLogin.classList.toggle('is-active', isLogin);
    tabRegister.classList.toggle('is-active', !isLogin);
    tabLogin.setAttribute('aria-selected', String(isLogin));
    tabRegister.setAttribute('aria-selected', String(!isLogin));
    panelLogin.hidden = !isLogin;
    panelRegister.hidden = isLogin;
    showError(null);
  }

  tabLogin.addEventListener('click', () => selectTab('login'));
  tabRegister.addEventListener('click', () => selectTab('register'));

  /**
   * 统一的 POST：把后端的 `{error:{code,message}}` 变成一句人话。
   * 网络层失败（断网、反代挂了）单独给一句提示 —— 那种情况下 `error.code` 根本不存在。
   */
  async function post(path, body) {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('连不上服务器：请检查网络，或稍后再试。');
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    }
    return payload ?? {};
  }

  /** 提交期间禁用按钮：防止连点造成"注册了两次"这类误伤（服务端也会挡，但没必要让用户撞上去）。 */
  async function withPending(button, label, run) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await run();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  formLogin.addEventListener('submit', (event) => {
    event.preventDefault();
    showError(null);
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    withPending(loginSubmit, '登录中…', async () => {
      try {
        await post('/auth/login', { username, password });
        // 登录成功：会话已经是 HttpOnly Cookie，直接进应用页面
        location.assign('/app/');
      } catch (error) {
        showError(error.message);
      }
    });
  });

  formRegister.addEventListener('submit', (event) => {
    event.preventDefault();
    showError(null);
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const inviteCode = document.getElementById('register-invite').value.trim();
    withPending(registerSubmit, '注册中…', async () => {
      try {
        await post('/auth/register', { username, password, inviteCode });
        location.assign('/app/');
      } catch (error) {
        // 邀请码错了就顺手把注册页留在前台（用户多半是在这一页填错的）
        selectTab('register');
        showError(error.message);
      }
    });
  });

  /** 公开的服务器信息：服务名、版本，以及"注册需要邀请码"这件事。 */
  async function loadConfig() {
    try {
      const response = await fetch('/auth/config', { credentials: 'same-origin' });
      if (!response.ok) return;
      const config = await response.json();
      if (config?.serverName) {
        document.getElementById('server-name').textContent = config.serverName;
        document.title = `${config.serverName} · 登录`;
      }
      if (config?.version) document.getElementById('server-version').textContent = `服务端版 ${config.version}`;
      if (config?.registration === 'invite') {
        inviteHint.hidden = false;
      }
    } catch {
      /* 配置文件拿不到不影响登录表单本身，静默即可 */
    }
  }

  loadConfig();
})();
