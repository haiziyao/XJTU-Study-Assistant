// 登录页逻辑
const $ = (id) => document.getElementById(id);

async function checkSession() {
  try {
    const resp = await fetch('/api/auth/me');
    const data = await resp.json();
    if (data.user) location.href = '/';
  } catch (e) {}
}

function switchTab(tab) {
  const isLogin = tab === 'login';
  $('tab-login').classList.toggle('active', isLogin);
  $('tab-register').classList.toggle('active', !isLogin);
  $('form-login').style.display = isLogin ? '' : 'none';
  $('form-register').style.display = isLogin ? 'none' : '';
  $('error').textContent = '';
  $('reg-error').textContent = '';
}

async function login() {
  const username = $('username').value.trim();
  const password = $('password').value;
  const err = $('error');
  err.textContent = '';
  if (!username || !password) {
    err.textContent = '请输入用户名和密码';
    return;
  }
  const btn = $('login');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (data.ok) {
      location.href = '/';
    } else {
      err.textContent = data.error || '登录失败';
    }
  } catch (e) {
    err.textContent = '网络错误: ' + e;
  } finally {
    btn.disabled = false;
  }
}

async function register() {
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  const inviteCode = $('reg-invite').value.trim();
  const err = $('reg-error');
  err.textContent = '';
  if (!username || !password || !inviteCode) {
    err.textContent = '请填写用户名、密码和邀请码';
    return;
  }
  const btn = $('register');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, invite_code: inviteCode }),
    });
    const data = await resp.json();
    if (data.ok) {
      location.href = '/';
    } else {
      err.textContent = data.error || '注册失败';
    }
  } catch (e) {
    err.textContent = '网络错误: ' + e;
  } finally {
    btn.disabled = false;
  }
}

$('tab-login').addEventListener('click', () => switchTab('login'));
$('tab-register').addEventListener('click', () => switchTab('register'));
$('login').addEventListener('click', login);
$('register').addEventListener('click', register);
$('username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('password').focus();
});
$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
$('reg-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('reg-password').focus();
});
$('reg-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('reg-invite').focus();
});
$('reg-invite').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') register();
});

checkSession();
