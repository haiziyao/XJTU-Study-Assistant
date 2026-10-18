/**
 * 「日志」视图：**所有人的**更改记录（GET /audit/log）。
 *
 * 与旧「消息」页的区别
 * --------------------
 * 旧版读的是框架的**指令日志** —— 只记录“经过指令系统”的对话/指令，用户在界面上
 * 建待办、改笔记、删记忆都不会出现，所以它回答不了“谁在什么时候改了什么”。
 * 现在读审计日志，每行显示「时间 · 谁 · 模块 · 动作 · 标题/摘要」，AI 的行带 AI 标记。
 *
 * 数据边界：本视图只读。日志是证据，界面与 AI 都没有删除入口 —— 唯一能清掉它的是
 * 用户手动删 `data/audit-log.json`（或 5000 条上限自动丢最旧）。
 *
 * 样式约束：外壳的 CSP 禁 inline style，因此这里只用 `shell.css` 已有的类
 * （toolbar / toolbar-row / seg / log-row / lr-* / empty-box）。≤900px 时靠
 * `toolbar wrap` + `toolbar-row` 自身换行，不新增样式文件。
 */

(function () {
/** actor -> 人话。`ai` 同时是行内标记（AI 的行一眼能认出来）。 */
const ACTOR_LABEL = { user: '用户', ai: 'AI', system: '系统' };

/** 模块 id -> 中文名。认不出的原样显示，宁可露出英文也不猜错。 */
const MODULE_LABEL = {
  todo: '待办',
  schedule: '日程',
  event: '日历事件',
  note: '笔记',
  memory: '记忆',
  calendar: '日历',
  lms: '学堂',
  account: '账号',
  auth: '认证',
  uiprefs: '界面偏好',
  ai: 'AI',
  sync: '同步',
  audit: '日志',
};

/** 审计动作 -> 人话（比指令标签多了 bulk/settings/login 这些审计特有动作）。 */
const ACTION_LABEL_AUDIT = {
  create: '新增',
  update: '修改',
  delete: '删除',
  bulk: '批量操作',
  settings: '改设置',
  login: '登录',
  logout: '退出登录',
  sync: '同步',
  clear: '清空',
  rollback: '回滚',
};

const SOURCE_LABEL = { ui: '界面', api: '接口', chat: 'AI 对话', sync: '多端同步', lms: '学堂同步' };

function timeText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 一行日志。只用已有类名，长标题靠文本自然换行（不写 inline style）。 */
function rowOf(item) {
  const actor = ACTOR_LABEL[item.actor] ?? item.actor ?? '系统';
  const moduleLabel = MODULE_LABEL[item.module] ?? item.module ?? '';
  const actionLabel = ACTION_LABEL_AUDIT[item.action] ?? item.action ?? '';
  const row = mk('div', `log-row${item.actor === 'ai' ? ' log-row-ai' : ''}`);
  const head = mk('div', 'lr-head');
  head.append(
    mk('span', 'lr-meta', timeText(item.at)),
    mk('span', `lr-source${item.actor === 'ai' ? ' lr-source-ai' : ''}`, actor),
    mk('span', 'lr-action', `${moduleLabel} · ${actionLabel}`),
  );
  row.appendChild(head);

  const title = String(item.title ?? '').trim();
  const summary = String(item.summary ?? '').trim();
  row.appendChild(mk('div', 'lr-text', title || summary || '（无标题）'));
  if (title && summary) row.appendChild(mk('div', 'lr-meta', summary));

  const meta = [];
  if (item.source) meta.push(`来源：${SOURCE_LABEL[item.source] ?? item.source}`);
  if (item.targetId) meta.push(`#${item.targetId}`);
  if (meta.length) row.appendChild(mk('div', 'lr-meta', meta.join(' · ')));
  return row;
}

const messageView = {
  title: '日志',

  render(ctx) {
    ctx.mount.innerHTML = '';

    /** 本视图的筛选状态（每次 render 重置为“全部”，与页签语义一致）。 */
    const state = { actor: '', module: '', seq: 0 };

    const bar = mk('div', 'toolbar wrap');
    const countNode = mk('span', 'lr-meta', '');
    const refresh = mk('button', 'ghost-btn', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', () => PC.refresh());
    bar.append(mk('div', 'toolbar-title', '更改日志'), countNode, mk('div', 'spacer'), refresh);

    // 第二行：actor 页签 + 模块下拉。`toolbar-row` 自带 flex-wrap，窄屏不会横向溢出。
    const filters = mk('div', 'toolbar-row');
    const seg = mk('div', 'seg');
    const actorDefs = [
      ['', '全部'],
      ['ai', '只看 AI'],
      ['user', '只看我'],
      ['system', '只看系统'],
    ];
    const actorButtons = actorDefs.map(([value, label]) => {
      const button = mk('button', `seg-btn${value === '' ? ' active' : ''}`, label);
      button.type = 'button';
      button.dataset.actor = value;
      button.setAttribute('aria-pressed', value === '' ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.actor === value) return;
        state.actor = value;
        for (const other of actorButtons) {
          const active = other.dataset.actor === value;
          other.classList.toggle('active', active);
          other.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        load();
      });
      seg.appendChild(button);
      return button;
    });

    const moduleSelect = mk('select', null);
    moduleSelect.setAttribute('aria-label', '按模块筛选');
    moduleSelect.appendChild(option('', '全部模块'));
    moduleSelect.addEventListener('change', () => {
      state.module = moduleSelect.value;
      load();
    });

    filters.append(seg, moduleSelect);
    bar.appendChild(filters);
    ctx.mount.appendChild(bar);

    const list = mk('div', 'log-list');
    ctx.mount.appendChild(list);

    /** 模块下拉的选项来自 stats（顺便显示每个模块的条数），失败不影响主列表。 */
    async function loadModules() {
      try {
        const stats = await PC.api('/audit/stats');
        const modules = Object.entries(stats?.modules ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        moduleSelect.replaceChildren(option('', '全部模块'));
        for (const [id, count] of modules) {
          moduleSelect.appendChild(option(id, `${MODULE_LABEL[id] ?? id} (${count})`));
        }
        moduleSelect.value = state.module;
      } catch {
        // 下拉拿不到计数就不更新；列表本身照常工作
      }
    }

    async function load() {
      const seq = ++state.seq;
      list.replaceChildren(mk('div', 'loading', '加载中…'));
      const params = new URLSearchParams({ limit: '50' });
      if (state.actor) params.set('actor', state.actor);
      if (state.module) params.set('module', state.module);
      try {
        const data = await PC.api(`/audit/log?${params.toString()}`);
        if (seq !== state.seq) return;
        countNode.textContent = `共 ${data.total ?? 0} 条`;
        list.replaceChildren();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
          list.appendChild(emptyBox('还没有任何更改记录'));
          return;
        }
        for (const item of items) list.appendChild(rowOf(item));
      } catch (error) {
        if (seq !== state.seq) return;
        list.replaceChildren(errorBox(error));
      }
    }

    load();
    loadModules();
  },
};

window.PCModules.register({
  id: 'message',
  label: '日志',
  icon: 'clock',
  order: 70,
  title: messageView.title,
  render: (ctx) => messageView.render(ctx),
});
})();
