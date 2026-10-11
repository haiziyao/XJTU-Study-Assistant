// DeepSeek Chat 待办事项前端逻辑

const $ = (id) => document.getElementById(id);

let todos = [];
let currentFilter = 'all';   // all / active / completed
let currentSort = 'default'; // default / priority / due / created
let editingId = null;        // 正在编辑的待办 id

const PRIORITY = {
  high: { label: '高', cls: 'high' },
  medium: { label: '中', cls: 'medium' },
  low: { label: '低', cls: 'low' },
};

// ---------------------------------------------------------------- 工具
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { msg = (await resp.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return resp.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isOverdue(t) {
  return !!t.due_date && !t.completed && t.due_date < todayStr();
}

// ---------------------------------------------------------------- 数据
async function loadTodos() {
  const data = await api('GET', '/api/todos');
  todos = data.todos || [];
  render();
}

function filteredTodos() {
  let list = todos.slice();
  if (currentFilter === 'active') list = list.filter((t) => !t.completed);
  else if (currentFilter === 'completed') list = list.filter((t) => t.completed);
  return list;
}

function sortedTodos(list) {
  const rank = { high: 0, medium: 1, low: 2 };
  const dueOf = (t) => t.due_date || '9999-12-31';
  const a = list.slice();
  if (currentSort === 'priority') {
    a.sort((x, y) => rank[x.priority] - rank[y.priority] || dueOf(x).localeCompare(dueOf(y)));
  } else if (currentSort === 'due') {
    a.sort((x, y) => dueOf(x).localeCompare(dueOf(y)));
  } else if (currentSort === 'created') {
    a.sort((x, y) => x.created_at - y.created_at);
  }
  // 未完成永远排在已完成之前 (稳定排序保留上面的次序)
  a.sort((x, y) => (x.completed ? 1 : 0) - (y.completed ? 1 : 0));
  return a;
}

// ---------------------------------------------------------------- 渲染
function render() {
  const list = sortedTodos(filteredTodos());
  const listEl = $('todo-list');
  listEl.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'todo-empty';
    empty.textContent = currentFilter === 'completed' ? '还没有已完成的待办' : '暂无待办事项 🎉';
    listEl.appendChild(empty);
  }
  list.forEach((t) => listEl.appendChild(renderTodo(t)));
  renderStats();
}

function renderStats() {
  const total = todos.length;
  const done = todos.filter((t) => t.completed).length;
  const pending = total - done;
  $('stats').textContent = `共 ${total} 项 · 未完成 ${pending} · 已完成 ${done}`;
}

function renderTodo(t) {
  const item = document.createElement('div');
  item.className = 'todo-item' + (t.completed ? ' completed' : '') + (isOverdue(t) ? ' overdue' : '');
  item.dataset.id = t.id;

  const check = document.createElement('button');
  check.className = 'todo-check';
  check.textContent = t.completed ? '✓' : '';
  check.title = t.completed ? '标记为未完成' : '标记为已完成';
  check.addEventListener('click', () => toggleTodo(t));
  item.appendChild(check);

  const body = document.createElement('div');
  body.className = 'todo-body';

  const top = document.createElement('div');
  top.className = 'todo-top';

  const title = document.createElement('span');
  title.className = 'todo-title';
  title.textContent = t.title;
  top.appendChild(title);

  const badge = document.createElement('span');
  const p = PRIORITY[t.priority] || PRIORITY.medium;
  badge.className = 'todo-priority ' + p.cls;
  badge.textContent = p.label;
  top.appendChild(badge);

  if (t.due_date) {
    const due = document.createElement('span');
    due.className = 'todo-due' + (isOverdue(t) ? ' overdue' : '');
    due.textContent = '⏰ ' + t.due_date + (isOverdue(t) ? '（已逾期）' : '');
    top.appendChild(due);
  }

  body.appendChild(top);

  if (t.notes) {
    const notes = document.createElement('div');
    notes.className = 'todo-notes';
    notes.textContent = t.notes;
    body.appendChild(notes);
  }

  item.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'todo-actions';

  const edit = document.createElement('button');
  edit.className = 'icon';
  edit.textContent = '✎';
  edit.title = '编辑';
  edit.addEventListener('click', () => openEdit(t));

  const del = document.createElement('button');
  del.className = 'icon';
  del.textContent = '✕';
  del.title = '删除';
  del.addEventListener('click', () => deleteTodo(t));

  actions.appendChild(edit);
  actions.appendChild(del);
  item.appendChild(actions);

  return item;
}

// ---------------------------------------------------------------- 操作
async function addTodo() {
  const title = $('new-title').value.trim();
  if (!title) {
    $('new-title').focus();
    return;
  }
  const body = {
    title,
    priority: $('new-priority').value,
    due_date: $('new-due').value || null,
  };
  await api('POST', '/api/todos', body);
  $('new-title').value = '';
  $('new-due').value = '';
  $('new-title').focus();
  await loadTodos();
}

async function toggleTodo(t) {
  await api('PATCH', '/api/todos/' + t.id, { completed: !t.completed });
  await loadTodos();
}

async function deleteTodo(t) {
  if (!confirm('确定删除该待办？')) return;
  await api('DELETE', '/api/todos/' + t.id);
  await loadTodos();
}

function openEdit(t) {
  editingId = t.id;
  $('edit-title').value = t.title || '';
  $('edit-notes').value = t.notes || '';
  $('edit-priority').value = t.priority || 'medium';
  $('edit-due').value = t.due_date || '';
  $('todo-modal').style.display = 'flex';
  $('edit-title').focus();
}

function closeEdit() {
  editingId = null;
  $('todo-modal').style.display = 'none';
}

async function saveEdit() {
  const title = $('edit-title').value.trim();
  if (!title) {
    $('edit-title').focus();
    return;
  }
  await api('PATCH', '/api/todos/' + editingId, {
    title,
    notes: $('edit-notes').value.trim(),
    priority: $('edit-priority').value,
    due_date: $('edit-due').value || null,
  });
  closeEdit();
  await loadTodos();
}

// ---------------------------------------------------------------- 账户
async function loadUser() {
  try {
    const data = await api('GET', '/api/auth/me');
    if (!data.user) {
      location.href = '/login';
    }
  } catch (e) {}
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  location.href = '/login';
}

// ---------------------------------------------------------------- 初始化
function init() {
  $('add-todo').addEventListener('click', addTodo);
  $('new-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    }
  });

  document.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      render();
    });
  });

  $('sort').addEventListener('change', (e) => {
    currentSort = e.target.value;
    render();
  });

  $('edit-save').addEventListener('click', saveEdit);
  $('edit-cancel').addEventListener('click', closeEdit);
  $('todo-modal-close').addEventListener('click', closeEdit);
  $('todo-modal').addEventListener('click', (e) => {
    if (e.target === $('todo-modal')) closeEdit();
  });

  $('logout').addEventListener('click', logout);

  loadUser();
  loadTodos();
}

init();
