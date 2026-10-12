/**
 * 「对话」页 —— 左栏第一项，AI 中枢。
 *
 * 为什么单独开一页，而不是继续往「设置」里塞：AI 有**四件必须能被用户看见并动手的事**，
 * 它们都不是"设置一次就不管"的配置项，而是每天要用的管理工作台：
 *
 *   1. **对话管理**：历史对话（打开回聊天框 / 新建 / 置顶 / 归档 / 删除）。
 *      对话是 AI 的短期记忆载体，找不到旧对话，等于每次都在从零开始。
 *   2. **记忆管理**：AI 记住的**关于你本人**的事实（跨会话生效）。
 *      这是最需要"可见"的一处 —— 一条错的长期偏好会污染后面每一次对话，
 *      而用户如果看不到它，就永远不知道它存在（接口文档 §10.5 的原话）。
 *   3. **知识库管理**：外部事实（教务处政策语料）。重点不是看文件列表，而是
 *      **检索试跑**：输入一句话，看 AI 实际会拿到哪几篇、哪段原文、哪个链接。
 *      查不到要能当场发现，而不是等模型在回答里含糊其辞。
 *   4. **定时唤醒**：时间 + 提示词，到点让 AI 主动开口（每条任务自己选写到哪个会话）。
 *
 * 与左侧聊天栏的分工：本页**管理**会话，聊天栏**使用**会话。点「打开」会把那条历史
 * 对话加载到左侧聊天框里（经由外壳提供的 `chat` 服务，见 shell/app.js），
 * 本页不自己渲染消息 —— 消息的渲染规则（富文本、推理链、确认卡）只有一处实现。
 *
 * 约定（与其它视图一致）：所有文本走 textContent（等价转义），**不写 inline style**
 * （CSP 的 style-src 'self' 会拦），重画前用 PC.snapshotScroll 保住滚动位置。
 */

(function () {
  const TABS = [
    { id: 'conversations', label: '对话' },
    { id: 'memory', label: '记忆' },
    { id: 'knowledge', label: '知识库' },
    { id: 'schedules', label: '定时' },
  ];

  /** 记忆类型的中文说法：界面上一律说人话，英文枚举只出现在提示里。 */
  const KIND_LABEL = {
    fact: '事实',
    preference: '偏好',
    constraint: '限制',
    decision: '决定',
    episodic: '经历',
  };
  const STATUS_LABEL = { active: '生效中', archived: '已归档', superseded: '已被取代', rejected: '已否决' };
  const REPEAT_LABEL = { daily: '每天', weekly: '每周', once: '只一次' };
  const WEEKDAY_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

  const ui = {
    mount: null,
    tab: 'conversations',
    error: null,
    busy: null,
    /** 各标签页的数据缓存：`null` = 还没拉过（切回来时不重复打请求） */
    conversations: null,
    conversationFilter: 'active',
    conversationQuery: '',
    memory: null,
    memoryQuery: '',
    memoryStatus: 'active',
    memoryForm: null,
    memoryEditing: null,
    knowledge: null,
    knowledgeQuery: '',
    knowledgeHits: null,
    schedules: null,
    scheduleForm: null,
    scheduleConversations: null,
    /** 需要二次确认的删除：存 id，第一次点变文案，第二次才真删（避免弹原生对话框） */
    confirming: null,
  };

  /* ------------------------------------------------------------ 基础件 */

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    const node = mk('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(name, title, onClick) {
    const node = mk('button', 'ch-icon-btn');
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    const svg = window.PCIcons?.svg?.(name, 18);
    if (svg) node.innerHTML = svg;
    else node.textContent = title;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function alertBox(title, message, kind = 'warn') {
    const box = mk('div', `ch-alert ${kind}`);
    box.appendChild(mk('div', 'ch-alert-title', title));
    if (message) box.appendChild(mk('div', 'ch-alert-msg', message));
    return box;
  }

  function empty(text) {
    return mk('div', 'ch-empty', text);
  }

  function field(label, control, hint) {
    const wrap = mk('label', 'ch-field');
    wrap.appendChild(mk('span', 'ch-field-label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(mk('span', 'ch-field-hint', hint));
    return wrap;
  }

  function textInput(value, placeholder, onInput) {
    const input = mk('input', 'ch-input');
    input.type = 'text';
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    if (onInput) input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function select(options, value, onChange) {
    const node = mk('select', 'ch-select');
    for (const item of options) {
      const option = mk('option', null, item.label);
      option.value = item.value;
      node.appendChild(option);
    }
    node.value = value ?? options[0]?.value ?? '';
    if (onChange) node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function textarea(value, placeholder, rows = 3) {
    const node = mk('textarea', 'ch-textarea');
    node.rows = rows;
    node.value = value ?? '';
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  /** ISO → 本地可读（后端给 UTC，直接显示用户对不上时间）。 */
  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 「3 分钟前」这类相对时间：列表里比绝对时间戳更好扫。 */
  function formatRelative(value) {
    if (!value) return '';
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    return formatStamp(value);
  }

  const countText = (n) => Number(n ?? 0).toLocaleString('zh-CN');

  /** 取外壳的 chat 服务：没有它（旧外壳）就如实说明，而不是点了没反应。 */
  function chatService() {
    return window.PCModules?.getService?.('chat') ?? null;
  }

  /* ------------------------------------------------------------ 重画 */

  /** 重画（默认保住滚动位置）。所有动作完成后统一走这里，避免各处手写 paint。 */
  function paint() {
    if (!ui.mount) return;
    const restore = window.PC?.snapshotScroll?.() ?? null;
    const draw = () => {
      ui.mount.textContent = '';
      ui.mount.appendChild(renderTabs());
      if (ui.error) ui.mount.appendChild(alertBox('没能完成', ui.error.message ?? String(ui.error), 'fail'));
      const body = mk('div', 'ch-body');
      const render = {
        conversations: renderConversations,
        memory: renderMemory,
        knowledge: renderKnowledge,
        schedules: renderSchedules,
      }[ui.tab];
      render?.(body);
      ui.mount.appendChild(body);
    };
    draw();
    window.PC?.keepScroll?.(restore, draw);
  }

  function renderTabs() {
    const bar = mk('div', 'ch-tabs');
    bar.setAttribute('role', 'tablist');
    for (const tab of TABS) {
      const node = mk('button', `ch-tab${ui.tab === tab.id ? ' active' : ''}`, tab.label);
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.addEventListener('click', () => {
        if (ui.tab === tab.id) return;
        ui.tab = tab.id;
        ui.error = null;
        // 切标签页要回到顶部：换了一屏内容，停在上一个标签的滚动位置会让人以为页面卡住了
        paint();
        const scroller = ui.mount.closest('.panel-body') ?? ui.mount.parentElement;
        if (scroller) scroller.scrollTop = 0;
        void ensureLoaded(tab.id);
      });
      bar.appendChild(node);
    }
    return bar;
  }

  /**
   * 强制重取某个标签的数据。**每次进入「对话」页都调它** ——
   * 缓存只服务于"同一次停留里来回切标签"，不能跨越一次进入：
   * 否则在别处（对话里让 AI 记住了什么、定时任务跑完）产生的变化，
   * 回到这一页看到的还是进页时那份旧数据，用户会以为操作没生效。
   */
  async function reloadTab(tab = ui.tab) {
    if (tab === 'conversations') return loadConversations();
    if (tab === 'memory') return loadMemory();
    if (tab === 'knowledge') return loadKnowledge();
    if (tab === 'schedules') return loadSchedules();
    return undefined;
  }

  /** 标签页之间切换时用它：已经拉过就不重复打请求（同一次停留里数据不会自己变）。 */
  async function ensureLoaded(tab = ui.tab) {
    if (tab === 'conversations' && ui.conversations === null) return loadConversations();
    if (tab === 'memory' && ui.memory === null) return loadMemory();
    if (tab === 'knowledge' && ui.knowledge === null) return loadKnowledge();
    if (tab === 'schedules' && ui.schedules === null) return loadSchedules();
    return undefined;
  }

  /** 统一动作包装：busy 期间按钮禁用并显示「处理中…」，失败落到 ui.error 而不是静默。 */
  async function run(key, task) {
    ui.busy = key;
    ui.error = null;
    paint();
    try {
      await task();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.busy = null;
      paint();
    }
  }

  /** 二次确认：第一次点改文案，3 秒内再点才执行（比 window.confirm 更不发怵，也不阻塞渲染）。 */
  function confirmThen(key, onConfirm) {
    if (ui.confirming === key) {
      ui.confirming = null;
      return onConfirm();
    }
    ui.confirming = key;
    paint();
    setTimeout(() => {
      if (ui.confirming === key) {
        ui.confirming = null;
        paint();
      }
    }, 3000);
    return undefined;
  }

  /* ============================================================ 1) 对话管理 */

  async function loadConversations() {
    const data = await PC.api('/ai/conversations?archived=all&limit=200');
    ui.conversations = Array.isArray(data?.items) ? data.items : [];
    return ui.conversations;
  }

  function conversationTitle(item) {
    const title = String(item?.title ?? '').trim();
    if (title) return title;
    const preview = String(item?.preview ?? item?.lastMessage ?? '').trim().replace(/\s+/g, ' ');
    return preview ? `${preview.slice(0, 26)}${preview.length > 26 ? '…' : ''}` : '（空对话）';
  }

  function renderConversations(host) {
    const service = chatService();
    const current = service?.currentId?.() ?? null;

    const head = mk('div', 'ch-head');
    const left = mk('div', 'ch-head-left');
    left.appendChild(button('＋ 新建对话', 'primary-btn', () => {
      if (!service) return void PC.toast('这个外壳版本不支持从管理页新建对话，请用聊天栏的「＋」');
      service.newConversation();
      PC.toast('已新建对话，直接在左边说话就行');
      void run('new', async () => {
        await loadConversations();
      });
    }));
    if (current) {
      left.appendChild(button('回到当前对话', 'ghost-btn', () => {
        void run('open', async () => {
          await service.openConversation(current);
          PC.toast('已打开当前对话');
        });
      }));
    }
    head.appendChild(left);

    const right = mk('div', 'ch-head-right');
    right.appendChild(textInput(ui.conversationQuery, '搜索标题/内容…', (value) => {
      ui.conversationQuery = value;
      paint();
    }));
    right.appendChild(
      select(
        [
          { value: 'active', label: '未归档' },
          { value: 'archived', label: '已归档' },
          { value: 'all', label: '全部' },
        ],
        ui.conversationFilter,
        (value) => {
          ui.conversationFilter = value;
          paint();
        },
      ),
    );
    head.appendChild(right);
    host.appendChild(head);

    const all = ui.conversations ?? [];
    const query = ui.conversationQuery.trim().toLowerCase();
    const rows = all
      .filter((item) => {
        if (ui.conversationFilter === 'active' && item.archived) return false;
        if (ui.conversationFilter === 'archived' && !item.archived) return false;
        if (!query) return true;
        return `${item.title ?? ''} ${item.preview ?? ''}`.toLowerCase().includes(query);
      })
      // 置顶在前、其余按更新时间倒序（后端已经排过，这里再兜一次：本地过滤不该打乱顺序）
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

    if (!all.length) {
      host.appendChild(empty('还没有历史对话。点「＋ 新建对话」开始，或者直接在左边的聊天栏说话。'));
      return;
    }
    if (!rows.length) {
      host.appendChild(empty('没有匹配的对话，换个关键词或切换筛选试试。'));
      return;
    }

    const list = mk('div', 'ch-list');
    for (const item of rows) {
      const row = mk('div', `ch-row${item.id === current ? ' current' : ''}`);
      const main = mk('div', 'ch-row-main');
      const titleLine = mk('div', 'ch-row-title');
      if (item.pinned) titleLine.appendChild(mk('span', 'ch-badge pin', '置顶'));
      titleLine.appendChild(mk('span', 'ch-row-name', conversationTitle(item)));
      if (item.id === current) titleLine.appendChild(mk('span', 'ch-badge on', '当前'));
      if (item.archived) titleLine.appendChild(mk('span', 'ch-badge', '已归档'));
      main.appendChild(titleLine);
      const meta = [
        `${countText(item.messageCount ?? 0)} 条消息`,
        item.updatedAt ? `更新于 ${formatRelative(item.updatedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      main.appendChild(mk('div', 'ch-row-meta', meta));
      row.appendChild(main);

      const actions = mk('div', 'ch-row-actions');
      actions.appendChild(
        button('打开', 'ghost-btn', () => {
          if (!service) return void PC.toast('这个外壳版本不支持打开历史对话');
          void run(`open:${item.id}`, async () => {
            await service.openConversation(item.id);
            await loadConversations();
          });
        }),
      );
      actions.appendChild(
        iconButton(item.pinned ? 'pin' : 'pin', item.pinned ? '取消置顶' : '置顶', () => {
          void run(`pin:${item.id}`, async () => {
            await PC.api(`/ai/conversations/${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              body: { pinned: !item.pinned },
            });
            await loadConversations();
          });
        }),
      );
      actions.appendChild(
        iconButton('note', item.archived ? '恢复（取消归档）' : '归档（不删除）', () => {
          void run(`archive:${item.id}`, async () => {
            await PC.api(`/ai/conversations/${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              body: { archived: !item.archived },
            });
            await loadConversations();
            PC.toast(item.archived ? '已恢复到对话列表' : '已归档，可随时恢复');
          });
        }),
      );
      const key = `del:${item.id}`;
      actions.appendChild(
        iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除（不可恢复）', () => {
          if (ui.confirming === key) {
            void run(key, async () => {
              await PC.api(`/ai/conversations/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
              if (item.id === (service?.currentId?.() ?? null)) service.newConversation();
              await loadConversations();
              PC.toast('已删除这条对话');
            });
            return;
          }
          return void confirmThen(key);
        }),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  /* ============================================================ 2) 记忆管理 */

  async function loadMemory() {
    const params = new URLSearchParams();
    if (ui.memoryStatus && ui.memoryStatus !== 'all') params.set('status', ui.memoryStatus);
    if (ui.memoryQuery.trim()) params.set('q', ui.memoryQuery.trim());
    params.set('limit', '300');
    const data = await PC.api(`/memories?${params.toString()}`);
    ui.memory = {
      items: Array.isArray(data?.items) ? data.items : [],
      counts: data?.counts ?? null,
    };
    return ui.memory;
  }

  function memoryForm() {
    const form = ui.memoryForm ?? {
      scope: 'global',
      kind: 'preference',
      key: '',
      text: '',
    };
    ui.memoryForm = form;
    const box = mk('div', 'ch-form');
    box.appendChild(
      field(
        '类型',
        select(
          Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
          form.kind,
          (value) => {
            form.kind = value;
          },
        ),
        '偏好/限制/事实会进每次对话的提示词；经历只在被检索时出现',
      ),
    );
    box.appendChild(
      field(
        '作用范围',
        textInput(form.scope, 'global', (value) => {
          form.scope = value;
        }),
        'global = 跟你本人有关；course:<课程id> / module:<模块id> 只在相关话题里生效',
      ),
    );
    const keyInput = textInput(form.key, '例如 preferred_study_window', (value) => {
      form.key = value;
    });
    box.appendChild(field('稳定键（可留空）', keyInput, '有键才能自动取代旧值，避免同一条记忆越攒越多'));

    const text = textarea(form.text, '用一句完整的话写，例如：我习惯晚上 19:00 之后安排学习任务', 3);
    const counter = mk('span', 'ch-counter', `${(form.text ?? '').length} / 200`);
    text.addEventListener('input', () => {
      form.text = text.value;
      counter.textContent = `${text.value.length} / 200`;
      counter.classList.toggle('over', text.value.length > 200);
    });
    const textWrap = field('内容', text);
    textWrap.appendChild(counter);
    box.appendChild(textWrap);

    const actions = mk('div', 'ch-form-actions');
    actions.appendChild(
      button('保存记忆', 'primary-btn', () => {
        void run('memory:create', async () => {
          const body = {
            scope: form.scope?.trim() || 'global',
            kind: form.kind,
            text: form.text,
            source: 'user',
          };
          if (form.key?.trim()) body.key = form.key.trim();
          // 409（同键已存在）不是失败而是"要你选"：这里明确用 replace 覆盖，并在提示里说明去了哪
          try {
            await PC.api('/memories', { method: 'POST', body });
          } catch (error) {
            const code = error?.payload?.error?.code;
            if (code !== 'CONFLICT') throw error;
            await PC.api('/memories', { method: 'POST', body: { ...body, replace: true } });
            PC.toast('同键记忆已更新为这条新值（旧的转「已被取代」，没有删除）');
          }
          ui.memoryForm = null;
          await loadMemory();
          PC.toast('已记住');
        });
      }),
    );
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.memoryForm = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function renderMemory(host) {
    const head = mk('div', 'ch-head');
    const left = mk('div', 'ch-head-left');
    left.appendChild(
      button('＋ 记住一条', 'primary-btn', () => {
        ui.memoryForm = ui.memoryForm ? null : { scope: 'global', kind: 'preference', key: '', text: '' };
        paint();
      }),
    );
    head.appendChild(left);
    const right = mk('div', 'ch-head-right');
    right.appendChild(
      textInput(ui.memoryQuery, '搜索记忆…', (value) => {
        ui.memoryQuery = value;
      }),
    );
    right.appendChild(
      button('搜索', 'ghost-btn', () => {
        void run('memory:search', () => loadMemory());
      }),
    );
    right.appendChild(
      select(
        [
          { value: 'active', label: '生效中' },
          { value: 'archived', label: '已归档' },
          { value: 'rejected', label: '已否决' },
          { value: 'all', label: '全部' },
        ],
        ui.memoryStatus,
        (value) => {
          ui.memoryStatus = value;
          void run('memory:filter', () => loadMemory());
        },
      ),
    );
    head.appendChild(right);
    host.appendChild(head);

    host.appendChild(
      mk(
        'div',
        'ch-note',
        '记忆是「关于你本人」的长期事实（跨会话生效），每次对话只注入预算内的一部分（默认 8 条 / 600 字，按重要度与新鲜度排）。' +
          '学校规定一类的外部事实属于「知识库」，不要写进这里 —— 两者的过期方式完全不同。',
      ),
    );

    if (ui.memoryForm) host.appendChild(memoryForm());

    const items = ui.memory?.items ?? [];
    const counts = ui.memory?.counts ?? null;
    if (counts) {
      const stats = mk('div', 'ch-stats');
      const pairs = [
        ['生效中', counts.active ?? items.filter((item) => item.status === 'active').length],
        ['已归档', counts.archived ?? 0],
        ['已被取代', counts.superseded ?? 0],
        ['已否决', counts.rejected ?? 0],
      ];
      for (const [label, value] of pairs) {
        const cell = mk('div', 'ch-stat');
        cell.appendChild(mk('div', 'ch-stat-value', countText(value)));
        cell.appendChild(mk('div', 'ch-stat-label', label));
        stats.appendChild(cell);
      }
      host.appendChild(stats);
    }

    if (!items.length) {
      host.appendChild(empty('这个筛选下没有记忆。可以在对话里直接说「记住：我周三下午不方便」，AI 会先提议、你确认后才落库。'));
      return;
    }

    const list = mk('div', 'ch-list');
    for (const item of items) {
      const row = mk('div', 'ch-row');
      const main = mk('div', 'ch-row-main');
      const titleLine = mk('div', 'ch-row-title');
      titleLine.appendChild(mk('span', 'ch-badge kind', KIND_LABEL[item.kind] ?? item.kind ?? '记忆'));
      titleLine.appendChild(mk('span', 'ch-badge', STATUS_LABEL[item.status] ?? item.status ?? ''));
      if (item.key) titleLine.appendChild(mk('span', 'ch-badge key', item.key));
      main.appendChild(titleLine);

      if (ui.memoryEditing === item.id) {
        const edit = textarea(item.text ?? '', '不超过 200 字', 3);
        main.appendChild(edit);
        const tools = mk('div', 'ch-form-actions');
        tools.appendChild(
          button('保存', 'primary-btn', () => {
            void run(`memory:save:${item.id}`, async () => {
              await PC.api(`/memories/${encodeURIComponent(item.id)}`, {
                method: 'PATCH',
                body: { text: edit.value.trim() },
              });
              ui.memoryEditing = null;
              await loadMemory();
              PC.toast('已保存');
            });
          }),
        );
        tools.appendChild(
          button('取消', 'ghost-btn', () => {
            ui.memoryEditing = null;
            paint();
          }),
        );
        main.appendChild(tools);
      } else {
        main.appendChild(mk('div', 'ch-row-text', item.text ?? ''));
      }

      const meta = [
        item.scope ? `范围 ${item.scope}` : '',
        item.useCount ? `用过 ${item.useCount} 次` : '',
        item.lastUsedAt ? `上次命中 ${formatRelative(item.lastUsedAt)}` : '',
        item.reviewAt ? `待复核 ${formatStamp(item.reviewAt)}` : '',
        item.updatedAt ? `更新 ${formatRelative(item.updatedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (meta) main.appendChild(mk('div', 'ch-row-meta', meta));
      row.appendChild(main);

      const actions = mk('div', 'ch-row-actions');
      if (ui.memoryEditing !== item.id) {
        actions.appendChild(
          button('改正', 'ghost-btn', () => {
            ui.memoryEditing = item.id;
            paint();
          }),
        );
      }
      if (item.status === 'active') {
        actions.appendChild(
          button('归档', 'ghost-btn', () => {
            void run(`memory:archive:${item.id}`, async () => {
              await PC.api(`/memories/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { status: 'archived' } });
              await loadMemory();
              PC.toast('已归档：不再进入 AI 的上下文，但随时能恢复');
            });
          }),
        );
      } else if (item.status === 'archived') {
        actions.appendChild(
          button('恢复', 'ghost-btn', () => {
            void run(`memory:restore:${item.id}`, async () => {
              await PC.api(`/memories/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { status: 'active' } });
              await loadMemory();
              // 在「已归档」筛选下点恢复，这一行会立刻从列表消失（它已经不是归档状态了）——
              // 不说一句，用户会以为点空了
              PC.toast('已恢复：重新参与上下文注入');
            });
          }),
        );
      }
      const key = `mem-del:${item.id}`;
      actions.appendChild(
        iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除（不可恢复）', () => {
          if (ui.confirming !== key) return void confirmThen(key);
          return void run(key, async () => {
            await PC.api(`/memories/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            await loadMemory();
            PC.toast('已删除这条记忆');
          });
        }),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  /* ============================================================ 3) 知识库管理 */

  /**
   * 知识库概况 + 自检。
   *
   * **分两步取，不 Promise.all**：自检要把语料里 149 个文件逐个读一遍算哈希（一秒量级），
   * 跟它一起等，用户点开这一页就先看到一片空白/「还没读到语料」——明明索引好好的。
   * 所以先拿概况画出来，自检在后台跑完再补一次。
   */
  async function loadKnowledge() {
    const stats = await PC.api('/knowledge/stats');
    ui.knowledge = { stats, check: ui.knowledge?.check ?? null };
    paint();
    const check = await PC.api('/knowledge/check').catch((error) => ({ error: error.message, problems: [] }));
    ui.knowledge = { stats, check };
    paint();
    return ui.knowledge;
  }

  async function searchKnowledge() {
    const query = ui.knowledgeQuery.trim();
    if (!query) {
      ui.knowledgeHits = null;
      paint();
      return;
    }
    const data = await PC.api(`/knowledge/search?q=${encodeURIComponent(query)}&limit=6`);
    ui.knowledgeHits = { query, items: Array.isArray(data?.items) ? data.items : [], available: data?.available !== false };
  }

  function renderKnowledge(host) {
    const stats = ui.knowledge?.stats ?? null;
    const counts = stats?.counts ?? {};
    const available = stats?.available !== false && Number(counts.documents ?? 0) > 0;

    if (!available) {
      host.appendChild(
        alertBox(
          '还没读到语料',
          `${stats?.reason ?? '没有找到索引'}。语料随仓库发布在 app/knowledge/dean/，缺失时跑一次 node scripts/crawl-dean.js 再点下面的「重新读取索引」。`,
          'fail',
        ),
      );
    } else {
      const statsRow = mk('div', 'ch-stats');
      const pairs = [
        ['栏目', counts.categories ?? 0],
        ['篇目', counts.documents ?? 0],
        ['字数', counts.chars ?? 0],
      ];
      for (const [label, value] of pairs) {
        const cell = mk('div', 'ch-stat');
        cell.appendChild(mk('div', 'ch-stat-value', label === '字数' ? `${(Number(value) / 10000).toFixed(1)} 万` : countText(value)));
        cell.appendChild(mk('div', 'ch-stat-label', label));
        statsRow.appendChild(cell);
      }
      host.appendChild(statsRow);
      host.appendChild(
        mk(
          'div',
          'ch-note',
          `来源 ${stats?.source ?? 'dean.xjtu.edu.cn'} · 生成于 ${formatStamp(stats?.generatedAt)} · 目录 ${stats?.corpusDir ?? ''}`,
        ),
      );
    }

    const tools = mk('div', 'ch-head');
    const left = mk('div', 'ch-head-left');
    left.appendChild(
      button('重新读取索引', 'ghost-btn', () => {
        void run('knowledge:reload', async () => {
          const result = await PC.api('/knowledge/reload', { method: 'POST' });
          await loadKnowledge();
          PC.toast(`已重新读取：${result?.counts?.documents ?? result?.documents ?? '?'} 篇`);
        });
      }),
    );
    left.appendChild(
      button('自检索引与文件', 'ghost-btn', () => {
        void run('knowledge:check', async () => {
          await loadKnowledge();
          const checkError = ui.knowledge?.check?.error ?? null;
    if (checkError) {
      host.appendChild(alertBox('自检没跑成', checkError, 'warn'));
    }
    const problems = ui.knowledge?.check?.problems ?? [];
          PC.toast(problems.length ? `自检发现 ${problems.length} 处不一致` : '自检通过：索引与文件一致');
        });
      }),
    );
    tools.appendChild(left);
    host.appendChild(tools);

    const problems = ui.knowledge?.check?.problems ?? [];
    if (problems.length) {
      host.appendChild(alertBox(`自检发现 ${problems.length} 处不一致`, problems.slice(0, 3).map((item) => item.message ?? JSON.stringify(item)).join('；'), 'warn'));
    }

    // 检索试跑：这一块是「管理」的重点 —— 看得见 AI 实际会拿到什么
    const searchBox = mk('div', 'ch-search');
    const input = textInput(ui.knowledgeQuery, '试一句：转专业要什么条件 / 缓考怎么申请', (value) => {
      ui.knowledgeQuery = value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void run('knowledge:search', () => searchKnowledge());
      }
    });
    searchBox.appendChild(input);
    searchBox.appendChild(
      button('试检索', 'primary-btn', () => {
        void run('knowledge:search', () => searchKnowledge());
      }),
    );
    host.appendChild(searchBox);

    if (ui.knowledgeHits) {
      const { items, query, available: hitAvailable } = ui.knowledgeHits;
      host.appendChild(mk('div', 'ch-subtitle', `「${query}」命中 ${items.length} 篇`));
      if (!hitAvailable) host.appendChild(empty('检索通道未就绪（语料没读到）。'));
      else if (!items.length) host.appendChild(empty('一条都没命中。换个说法，或确认语料里确实有这类文件（可以按标题搜）。'));
      const hits = mk('div', 'ch-list');
      for (const item of items) {
        const row = mk('div', 'ch-row');
        const main = mk('div', 'ch-row-main');
        main.appendChild(mk('div', 'ch-row-name', item.title ?? item.path ?? '（无题）'));
        const meta = [item.categoryName ?? item.category ?? '', item.url ?? ''].filter(Boolean).join(' · ');
        if (meta) main.appendChild(mk('div', 'ch-row-meta', meta));
        const snippet = String(item.snippet ?? '').trim();
        if (snippet) main.appendChild(mk('div', 'ch-row-text', snippet));
        row.appendChild(main);
        if (item.url) {
          const actions = mk('div', 'ch-row-actions');
          actions.appendChild(
            button('打开原文', 'ghost-btn', () => {
              window.open(item.url, '_blank', 'noreferrer');
            }),
          );
          row.appendChild(actions);
        }
        hits.appendChild(row);
      }
      if (items.length) host.appendChild(hits);
    }

    const categories = stats?.categories ?? [];
    if (categories.length) {
      host.appendChild(mk('div', 'ch-subtitle', '栏目'));
      const table = mk('div', 'ch-cats');
      for (const category of categories) {
        const cell = mk('div', 'ch-cat');
        cell.appendChild(mk('span', 'ch-cat-name', category.label ?? category.name ?? category.slug ?? ''));
        cell.appendChild(
          mk('span', 'ch-cat-count', `${countText(category.documents ?? category.count ?? 0)} 篇 · ${countText(category.chars ?? 0)} 字`),
        );
        table.appendChild(cell);
      }
      host.appendChild(table);
    }
  }

  /* ============================================================ 4) 定时唤醒 */

  async function loadSchedules() {
    const [data, conversations] = await Promise.all([
      PC.api('/ai/schedules'),
      PC.api('/ai/conversations?archived=all&limit=200').catch(() => ({ items: [] })),
    ]);
    ui.schedules = Array.isArray(data?.items) ? data.items : [];
    ui.scheduleConversations = Array.isArray(conversations?.items) ? conversations.items : [];
    return ui.schedules;
  }

  function scheduleSummary(task) {
    const repeat = REPEAT_LABEL[task.repeat] ?? task.repeat ?? '';
    if (task.repeat === 'weekly' && Array.isArray(task.weekdays) && task.weekdays.length) {
      return `每${task.weekdays.map((day) => WEEKDAY_LABEL[(Number(day) + 6) % 7] ?? day).join('、')} ${task.at ?? ''}`;
    }
    if (task.repeat === 'once') return `一次 · ${formatStamp(task.at)}`;
    return `${repeat} ${task.at ?? ''}`.trim();
  }

  function scheduleForm() {
    const form = ui.scheduleForm ?? {
      label: '',
      prompt: '',
      repeat: 'daily',
      time: '08:00',
      datetime: '',
      weekdays: [1],
      conversationId: '',
    };
    ui.scheduleForm = form;

    const box = mk('div', 'ch-form');
    box.appendChild(
      field(
        '任务名（可留空）',
        textInput(form.label, '例如 每天早上的计划播报', (value) => {
          form.label = value;
        }),
      ),
    );
    box.appendChild(
      field(
        '重复',
        select(
          [
            { value: 'daily', label: '每天' },
            { value: 'weekly', label: '每周' },
            { value: 'once', label: '只一次' },
          ],
          form.repeat,
          (value) => {
            form.repeat = value;
            paint();
          },
        ),
      ),
    );

    if (form.repeat === 'once') {
      const when = mk('input', 'ch-input');
      when.type = 'datetime-local';
      when.value = form.datetime;
      when.addEventListener('input', () => {
        form.datetime = when.value;
      });
      box.appendChild(field('什么时候', when, '本地时间；过去的时间会被拒绝'));
    } else {
      const at = mk('input', 'ch-input');
      at.type = 'time';
      at.value = form.time;
      at.addEventListener('input', () => {
        form.time = at.value;
      });
      box.appendChild(field('几点', at));
      if (form.repeat === 'weekly') {
        const days = mk('div', 'ch-weekdays');
        for (let day = 1; day <= 7; day += 1) {
          const chip = mk('button', `ch-chip${form.weekdays.includes(day) ? ' on' : ''}`, WEEKDAY_LABEL[day - 1]);
          chip.type = 'button';
          chip.addEventListener('click', () => {
            form.weekdays = form.weekdays.includes(day)
              ? form.weekdays.filter((item) => item !== day)
              : [...form.weekdays, day].sort((a, b) => a - b);
            paint();
          });
          days.appendChild(chip);
        }
        box.appendChild(field('星期几', days, '可多选'));
      }
    }

    const prompt = textarea(form.prompt, '到点要 AI 做的事，例如：用一句话总结今天要交的作业，并排出先后顺序', 3);
    prompt.addEventListener('input', () => {
      form.prompt = prompt.value;
    });
    box.appendChild(field('提示词', prompt, '到点时这句话会作为你的消息发给 AI，回复写进下面选的会话'));

    const options = [{ value: '', label: '新建专用会话「定时唤醒」' }];
    for (const item of ui.scheduleConversations ?? []) {
      options.push({ value: item.id, label: conversationTitle(item) });
    }
    box.appendChild(
      field(
        '写到哪个会话',
        select(options, form.conversationId, (value) => {
          form.conversationId = value;
        }),
        '默认新建一个专用会话，免得打断你正在聊的上下文',
      ),
    );

    const actions = mk('div', 'ch-form-actions');
    actions.appendChild(
      button('创建任务', 'primary-btn', () => {
        void run('schedule:create', async () => {
          let conversationId = form.conversationId;
          if (!conversationId) {
            const created = await PC.api('/ai/conversations', { method: 'POST', body: { title: '定时唤醒' } });
            conversationId = created?.conversation?.id ?? null;
          }
          const body = {
            label: form.label?.trim() || undefined,
            prompt: form.prompt,
            repeat: form.repeat,
            conversationId,
          };
          if (form.repeat === 'once') {
            if (!form.datetime) throw new Error('请选择执行时间');
            body.at = new Date(form.datetime).toISOString();
          } else {
            body.at = form.time;
            if (form.repeat === 'weekly') body.weekdays = form.weekdays;
          }
          await PC.api('/ai/schedules', { method: 'POST', body });
          ui.scheduleForm = null;
          await loadSchedules();
          PC.toast('定时任务已创建');
        });
      }),
    );
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.scheduleForm = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function renderSchedules(host) {
    const head = mk('div', 'ch-head');
    const left = mk('div', 'ch-head-left');
    left.appendChild(
      button('＋ 新建定时任务', 'primary-btn', () => {
        ui.scheduleForm = ui.scheduleForm
          ? null
          : { label: '', prompt: '', repeat: 'daily', time: '08:00', datetime: '', weekdays: [1], conversationId: '' };
        paint();
      }),
    );
    head.appendChild(left);
    host.appendChild(head);

    host.appendChild(
      mk(
        'div',
        'ch-note',
        '到点后由程序（不是浏览器）触发：AI 会把「提示词」当成你说的话回复一次，结果写进指定会话，并记下成功或失败原因。' +
          '程序没在运行时不会补跑 —— 错过的任务在下一次到点时照常执行。',
      ),
    );

    if (ui.scheduleForm) host.appendChild(scheduleForm());

    const items = ui.schedules ?? [];
    if (!items.length) {
      host.appendChild(empty('还没有定时任务。比如「每天 07:30：播报今天的课和最近的 DDL」。'));
      return;
    }

    const list = mk('div', 'ch-list');
    for (const task of items) {
      const row = mk('div', `ch-row${task.enabled === false ? ' off' : ''}`);
      const main = mk('div', 'ch-row-main');
      const titleLine = mk('div', 'ch-row-title');
      titleLine.appendChild(mk('span', 'ch-badge kind', scheduleSummary(task)));
      if (task.enabled === false) titleLine.appendChild(mk('span', 'ch-badge', '已停用'));
      titleLine.appendChild(mk('span', 'ch-row-name', task.label?.trim() || '未命名任务'));
      main.appendChild(titleLine);
      main.appendChild(mk('div', 'ch-row-text', task.prompt ?? ''));
      const target = (ui.scheduleConversations ?? []).find((item) => item.id === task.conversationId);
      const meta = [
        target ? `写入「${conversationTitle(target)}」` : task.conversationId ? '写入指定会话' : '写入新会话',
        task.nextRunAt ? `下次 ${formatStamp(task.nextRunAt)}` : '',
        task.lastRunAt ? `上次 ${formatRelative(task.lastRunAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      main.appendChild(mk('div', 'ch-row-meta', meta));
      if (task.lastError) main.appendChild(mk('div', 'ch-row-error', `上次失败：${task.lastError}`));
      row.appendChild(main);

      const actions = mk('div', 'ch-row-actions');
      actions.appendChild(
        button('现在试跑', 'ghost-btn', () => {
          void run(`schedule:run:${task.id}`, async () => {
            const result = await PC.api(`/ai/schedules/${encodeURIComponent(task.id)}/run`, { method: 'POST' });
            await loadSchedules();
            PC.toast(result?.ok === false ? `试跑失败：${result?.error ?? '未知原因'}` : '已试跑一次，去会话里看结果');
          });
        }),
      );
      actions.appendChild(
        button(task.enabled === false ? '启用' : '停用', 'ghost-btn', () => {
          void run(`schedule:toggle:${task.id}`, async () => {
            await PC.api(`/ai/schedules/${encodeURIComponent(task.id)}`, {
              method: 'PATCH',
              body: { enabled: task.enabled === false },
            });
            await loadSchedules();
          });
        }),
      );
      const key = `sched-del:${task.id}`;
      actions.appendChild(
        iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除任务', () => {
          if (ui.confirming !== key) return void confirmThen(key);
          return void run(key, async () => {
            await PC.api(`/ai/schedules/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
            await loadSchedules();
            PC.toast('已删除定时任务');
          });
        }),
      );
      row.appendChild(actionRowWrap(actions));
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  /** 右对齐动作区在某些行会换行，包一层统一间距（避免每处重复写类名）。 */
  function actionRowWrap(actions) {
    return actions;
  }

  /* ------------------------------------------------------------ 注册 */

  window.PCModules.register({
    id: 'chat',
    label: '对话',
    icon: '💬',
    order: 1,
    title: '对话',
    render(ctx) {
      ui.mount = ctx.mount;
      ui.error = null;
      paint();
      // 每次进入都重取：聊天栏可能在别处换过会话、定时任务可能刚跑过一轮
      void run(`load:${ui.tab}`, () => reloadTab(ui.tab));
    },
  });
})();
