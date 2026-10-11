// 设置页前端逻辑

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const models = await fetch('/api/models').then((r) => r.json());
  let decorations = { characters: [] };
  try {
    decorations = await fetch('/api/decorations').then((r) => r.json());
  } catch (e) {}

  $('api_key').value = cfg.api_key || '';
  $('base_url').value = cfg.base_url || '';
  $('temperature').value = cfg.temperature ?? 0.7;
  $('max_tokens').value = cfg.max_tokens ?? 4096;
  $('max_context').value = cfg.max_context ?? 32768;
  $('font_size').value = cfg.font_size ?? 14;
  $('math_scale').value = cfg.math_scale ?? 100;
  $('show_mood').checked = cfg.show_mood !== false;
  $('draw_mode').checked = cfg.draw_mode !== false;
  $('thinking').value = cfg.thinking || 'enabled';
  $('effort').value = cfg.effort || 'high';
  $('balance_mode').value = cfg.balance_mode || 'floating';
  $('balance_warn_threshold').value = cfg.balance_warn_threshold ?? 25;
  $('balance_danger_threshold').value = cfg.balance_danger_threshold ?? 10;

  const modelSel = $('model');
  (models.models || ['deepseek-flash', 'deepseek-v4-pro']).forEach((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    modelSel.appendChild(o);
  });
  modelSel.value = cfg.model || 'deepseek-flash';

  // 角色下拉
  const charSel = $('balance_character');
  const chars = decorations.characters || [];
  chars.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.name;
    charSel.appendChild(o);
  });
  const current = cfg.balance_character || (chars[0] ? chars[0].name : '');
  charSel.value = current;
}

async function save() {
  const status = $('status');
  const body = {
    api_key: $('api_key').value.trim(),
    base_url: $('base_url').value.trim(),
    model: $('model').value,
    thinking: $('thinking').value,
    effort: $('effort').value,
    temperature: parseFloat($('temperature').value) || 0.7,
    max_tokens: parseInt($('max_tokens').value, 10) || 4096,
    max_context: parseInt($('max_context').value, 10) || 32768,
    font_size: parseInt($('font_size').value, 10) || 14,
    math_scale: parseInt($('math_scale').value, 10) || 100,
    show_mood: $('show_mood').checked,
    draw_mode: $('draw_mode').checked,
    balance_mode: $('balance_mode').value,
    balance_character: $('balance_character').value,
    balance_warn_threshold: parseFloat($('balance_warn_threshold').value),
    balance_danger_threshold: parseFloat($('balance_danger_threshold').value),
  };
  // 阈值校验: 若为 NaN 或顺序颠倒则提示
  if (isNaN(body.balance_warn_threshold) || isNaN(body.balance_danger_threshold)) {
    status.textContent = '❌ 阈值必须是数字';
    status.style.color = '#c0392b';
    return;
  }
  if (body.balance_warn_threshold < body.balance_danger_threshold) {
    status.textContent = '❌ 警告阈值不能小于危险阈值';
    status.style.color = '#c0392b';
    return;
  }
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status.textContent = '✅ 已保存';
    status.style.color = '#27ae60';
    setTimeout(() => (status.textContent = ''), 2000);
  } catch (e) {
    status.textContent = '❌ 保存失败: ' + e;
    status.style.color = '#c0392b';
  }
}

// ---------------------------------------------------------------- 账户
let currentUser = null;

async function loadAccount() {
  try {
    const data = await fetch('/api/auth/me').then((r) => r.json());
    currentUser = data.user;
    if (!currentUser) {
      location.href = '/login';
      return;
    }
    if (currentUser.role === 'admin') {
      $('user-admin').style.display = '';
      $('invite-admin').style.display = '';
      await loadUsers();
      await loadInvites();
    }
  } catch (e) {}
}

async function loadUsers() {
  try {
    const data = await fetch('/api/auth/users').then((r) => r.json());
    renderUsers(data.users || []);
  } catch (e) {}
}

function renderUsers(users) {
  const table = $('user-table');
  table.innerHTML = '';
  const header = document.createElement('tr');
  header.innerHTML = '<th>用户名</th><th>角色</th><th>操作</th>';
  table.appendChild(header);
  users.forEach((u) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = u.username;
    const roleTd = document.createElement('td');
    roleTd.textContent = u.role === 'admin' ? '管理员' : '用户';
    const opTd = document.createElement('td');
    if (currentUser && u.id !== currentUser.id) {
      const del = document.createElement('button');
      del.className = 'icon';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', () => deleteUser(u.id, u.username));
      opTd.appendChild(del);
    } else {
      opTd.textContent = '当前账号';
    }
    tr.appendChild(nameTd);
    tr.appendChild(roleTd);
    tr.appendChild(opTd);
    table.appendChild(tr);
  });
}

async function changePassword() {
  const oldPwd = $('old_password').value;
  const newPwd = $('new_password').value;
  const st = $('pwd-status');
  st.textContent = '';
  if (!oldPwd || !newPwd) {
    st.textContent = '请填写原密码和新密码';
    return;
  }
  try {
    const resp = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
    });
    const data = await resp.json();
    if (data.ok) {
      st.textContent = '✅ 密码已修改';
      st.style.color = '#27ae60';
      $('old_password').value = '';
      $('new_password').value = '';
    } else {
      st.textContent = '❌ ' + (data.error || '修改失败');
      st.style.color = '#c0392b';
    }
  } catch (e) {
    st.textContent = '❌ 修改失败: ' + e;
    st.style.color = '#c0392b';
  }
}

async function createUser() {
  const username = $('new-user-name').value.trim();
  const password = $('new-user-pwd').value;
  const role = $('new-user-role').value;
  const st = $('admin-status');
  st.textContent = '';
  if (!username || !password) {
    st.textContent = '请填写用户名和密码';
    return;
  }
  try {
    const resp = await fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const data = await resp.json();
    if (data.ok) {
      st.textContent = '✅ 已创建用户 ' + username;
      st.style.color = '#27ae60';
      $('new-user-name').value = '';
      $('new-user-pwd').value = '';
      await loadUsers();
    } else {
      st.textContent = '❌ ' + (data.error || '创建失败');
      st.style.color = '#c0392b';
    }
  } catch (e) {
    st.textContent = '❌ 创建失败: ' + e;
    st.style.color = '#c0392b';
  }
}

async function deleteUser(id, name) {
  if (!confirm('确定删除用户 ' + name + '？该用户的所有数据将被删除。')) return;
  try {
    await fetch('/api/auth/users/' + id, { method: 'DELETE' });
    await loadUsers();
  } catch (e) {}
}

// ---------------------------------------------------------------- 邀请码
async function loadInvites() {
  try {
    const data = await fetch('/api/auth/invites').then((r) => r.json());
    renderInvites(data.invites || []);
  } catch (e) {}
}

function renderInvites(invites) {
  const table = $('invite-table');
  table.innerHTML = '';
  const header = document.createElement('tr');
  header.innerHTML = '<th>邀请码</th><th>备注</th><th>状态</th><th>操作</th>';
  table.appendChild(header);
  invites.forEach((inv) => {
    const tr = document.createElement('tr');
    const codeTd = document.createElement('td');
    codeTd.textContent = inv.code;
    codeTd.style.fontFamily = 'monospace';
    const noteTd = document.createElement('td');
    noteTd.textContent = inv.note || '—';
    const statusTd = document.createElement('td');
    if (inv.used_by) {
      statusTd.textContent = '已使用';
      statusTd.style.color = '#8a94a3';
    } else {
      statusTd.textContent = '未使用';
      statusTd.style.color = '#27ae60';
    }
    const opTd = document.createElement('td');
    const copy = document.createElement('button');
    copy.className = 'icon';
    copy.textContent = '⧉';
    copy.title = '复制';
    copy.addEventListener('click', () => copyInvite(inv.code));
    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => deleteInvite(inv.id));
    opTd.appendChild(copy);
    opTd.appendChild(del);
    tr.appendChild(codeTd);
    tr.appendChild(noteTd);
    tr.appendChild(statusTd);
    tr.appendChild(opTd);
    table.appendChild(tr);
  });
}

async function copyInvite(code) {
  const st = $('invite-status');
  try {
    await navigator.clipboard.writeText(code);
    st.textContent = '✅ 已复制 ' + code;
    st.style.color = '#27ae60';
    setTimeout(() => (st.textContent = ''), 2000);
  } catch (e) {
    st.textContent = '❌ 复制失败，请手动复制';
    st.style.color = '#c0392b';
  }
}

async function createInvites() {
  const count = parseInt($('invite-count').value, 10) || 1;
  const note = $('invite-note').value.trim();
  const st = $('invite-status');
  st.textContent = '';
  try {
    const resp = await fetch('/api/auth/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, note }),
    });
    const data = await resp.json();
    if (data.ok) {
      st.textContent = '✅ 已生成: ' + (data.codes || []).join(', ');
      st.style.color = '#27ae60';
      $('invite-note').value = '';
      await loadInvites();
    } else {
      st.textContent = '❌ ' + (data.error || '生成失败');
      st.style.color = '#c0392b';
    }
  } catch (e) {
    st.textContent = '❌ 生成失败: ' + e;
    st.style.color = '#c0392b';
  }
}

async function deleteInvite(id) {
  if (!confirm('确定删除该邀请码？')) return;
  try {
    await fetch('/api/auth/invites/' + id, { method: 'DELETE' });
    await loadInvites();
  } catch (e) {}
}

$('save').addEventListener('click', save);
$('back').addEventListener('click', () => (location.href = '/'));
$('change-pwd').addEventListener('click', changePassword);
$('add-user').addEventListener('click', createUser);
$('gen-invites').addEventListener('click', createInvites);

load();
loadAccount();
