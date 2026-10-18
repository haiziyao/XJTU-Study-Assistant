/**
 * 「传输」页 —— 局域网内**设备之间直传**（§八）。
 *
 * 这一页要回答用户的四个问题，顺序也是照着这个来的：
 *   1. **我这台设备现在是什么状态**：设备名、监听端口、能不能被别的设备发现；
 *   2. **别人怎么才能传给我**：6 位配对码 + 有效期 —— 只有知道你配对码的设备才能传进来；
 *   3. **我要发给谁、发什么**：附近设备（UDP 发现 / 手工填 IP）+ 集合勾选；
 *   4. **传了什么、跳过了什么、有没有疑似重复**：进度、结果明细、传输日志。
 *
 * 约定（与其它视图一致）：`mk()` 建节点、所有文本走 textContent（等价转义）、
 * 不写 inline style（CSP 的 `style-src 'self'` 会拦），重画用 `PC.snapshotScroll` 保住滚动位置。
 *
 * 轮询的取舍：后端没有为传输单独开 WebSocket 事件（外壳的广播由各数据模块自己发），
 * 所以这里每 2 秒拉一次 `/transfer/status`。为了不打扰正在输入的配对码：
 *   - 输入内容存在 `ui.*` 里（重画后原样填回）；
 *   - 状态**没有变化时不重画**（签名比对，排除每跳都在变的倒计时）；
 *   - 重画后把焦点还给原来那个输入框。
 */

(function () {
  /** 默认勾选：所有"接收侧写得进去"的集合（对话/消息收不下，见目录里的原因）。 */
  const DEFAULT_SELECTED = ['memories', 'notes', 'todos', 'schedules', 'events'];

  const PLATFORM_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

  const ui = {
    mount: null,
    data: null,
    signature: null,
    error: null,
    busy: null,
    ticker: null,
    countdownTimer: null,
    countdownNode: null,
    /** 正在填配对码的那台设备（点了「发送」之后展开一行输入）。 */
    target: null,
    codeDraft: '',
    manualDraft: '',
    deviceDraft: null,
    selected: new Set(DEFAULT_SELECTED),
    confirming: null,
  };

  /* ------------------------------------------------------------ 基础件（与 chat-hub 同一套） */

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

  function badge(text, tone = '') {
    return mk('span', `tf-badge${tone ? ` ${tone}` : ''}`, text);
  }

  function empty(text) {
    return mk('div', 'tf-empty', text);
  }

  function alertBox(title, message, tone = '') {
    const box = mk('div', `tf-alert${tone ? ` ${tone}` : ''}`);
    box.appendChild(mk('div', 'tf-alert-title', title));
    if (message) box.appendChild(mk('div', null, message));
    return box;
  }

  function card(title, note) {
    const box = mk('div', 'tf-card');
    const head = mk('div', 'tf-card-head');
    head.appendChild(mk('div', 'tf-card-title', title));
    if (note) head.appendChild(mk('div', 'tf-card-note', note));
    box.appendChild(head);
    return box;
  }

  /** 带焦点标记的输入框：重画后按 `data-tf-focus` 把焦点还回去。 */
  function textInput(value, placeholder, onInput, { focusKey = null, className = '', maxLength = 0 } = {}) {
    const input = mk('input', className);
    input.type = 'text';
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    if (focusKey) input.dataset.tfFocus = focusKey;
    if (onInput) input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function switchRow(title, note, checked, onChange) {
    const label = mk('label', 'tf-switch');
    const input = mk('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    const body = mk('div', 'tf-switch-body');
    body.appendChild(mk('div', 'tf-switch-title', title));
    body.appendChild(mk('div', 'tf-switch-note', note));
    label.append(input, body);
    return label;
  }

  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatMs(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  const platformLabel = (value) => PLATFORM_LABEL[value] ?? (value || '未知系统');

  /* ------------------------------------------------------------ 状态与重画 */

  /** 只看"影响渲染"的部分：倒计时每跳都在变，不能让它触发重画（否则输入框每秒失去焦点）。 */
  function signatureOf(data) {
    const copy = JSON.parse(JSON.stringify(data ?? null));
    if (copy?.code) delete copy.code.remainingMs;
    return JSON.stringify(copy);
  }

  function paint() {
    if (!ui.mount) return;
    const active = document.activeElement;
    const focusKey = active?.dataset?.tfFocus ?? null;
    const caret = typeof active?.selectionStart === 'number' ? active.selectionStart : null;

    const restore = window.PC?.snapshotScroll?.() ?? null;
    const draw = () => {
      ui.mount.textContent = '';
      const content = mk('div', 'view-content');
      renderHead(content);
      renderPrivacy(content);
      if (ui.data) {
        renderPairing(content);
        renderSwitches(content);
        renderGateway(content);
        renderPeers(content);
        renderCollections(content);
        renderProgress(content);
        renderResult(content);
        renderLog(content);
      } else if (!ui.error) {
        content.appendChild(empty('正在读取本机传输状态…'));
      }
      ui.mount.appendChild(content);
    };
    draw();
    restore?.();

    if (focusKey) {
      const node = ui.mount.querySelector(`[data-tf-focus="${focusKey}"]`);
      if (node) {
        node.focus();
        if (caret !== null && typeof node.setSelectionRange === 'function') {
          try {
            node.setSelectionRange(caret, caret);
          } catch {
            /* 不是文本类输入就算了 */
          }
        }
      }
    }
    updateCountdown();
  }

  /** 统一动作包装：busy 期间按钮禁用，失败落到 ui.error（不静默）。 */
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

  /** 二次确认：第一次点改文案，3 秒内再点才执行（删除这类动作不弹原生对话框）。 */
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

  /* ------------------------------------------------------------ 与后端交互 */

  async function load({ silent = false } = {}) {
    const data = await PC.api('/transfer/status');
    const signature = signatureOf(data);
    ui.data = data;
    if (!silent || signature !== ui.signature) {
      ui.signature = signature;
      paint();
    }
  }

  const settings = (patch) => run('settings', async () => {
    await PC.api('/transfer/settings', { method: 'POST', body: patch });
    await load();
  });

  const swapCode = () => run('code', async () => {
    await PC.api('/transfer/code', { method: 'POST' });
    PC.toast('换好了：旧配对码立刻作废');
    await load();
  });

  const addPeer = (host, port) => run('peer', async () => {
    await PC.api('/transfer/peers', { method: 'POST', body: { host, port } });
    ui.manualDraft = '';
    PC.toast('已添加，可以直接给它发数据');
    await load();
  });

  async function sendTo(peer, code) {
    const collections = [...ui.selected];
    if (!collections.length) {
      PC.toast('先勾选至少一类要传的数据');
      return;
    }
    await run('send', async () => {
      const result = await PC.api('/transfer/send', {
        method: 'POST',
        body: { host: peer.host, port: peer.port, code, collections },
      });
      ui.target = null;
      ui.codeDraft = '';
      PC.toast(`传完了：新增 ${result.sent} 条、跳过 ${result.skipped} 条、重命名 ${result.renamed} 条`);
      await load();
    });
  }

  const resolveSuspect = (id, action) => run(`resolve:${id}`, async () => {
    await PC.api('/transfer/result/resolve', { method: 'POST', body: { id, action } });
    PC.toast(action === 'delete' ? '已删除刚收下的那条' : '保留两条，已从清单划掉');
    await load();
  });

  /** 局域网网关开关（默认关；打开后手机上才打得开本程序）。 */
  const setGateway = (enabled) => run('gateway', async () => {
    await PC.api('/transfer/gateway', { method: 'POST', body: { enabled } });
    PC.toast(enabled ? '已打开：手机可以打开本程序了（要输配对码）' : '已关闭：局域网入口立刻失效');
    await load();
  });

  /** 一键注销所有已授权的手机（它们下次要重新输配对码）。 */
  const revokeLanTokens = () => run('revoke', async () => {
    const result = await PC.api('/transfer/gateway/revoke', { method: 'POST', body: {} });
    PC.toast(result.revoked ? `已注销 ${result.revoked} 台设备，它们需要重新输配对码` : '当前没有被授权的设备');
    await load();
  });

  /** 复制：优先用剪贴板 API（失败就提示手动选中，绝不假装成功）。 */
  async function copyText(text, okText) {
    try {
      await navigator.clipboard.writeText(text);
      PC.toast(okText ?? '已复制');
    } catch {
      PC.toast(`复制失败，请手动选中：${text}`);
    }
  }

  /* ------------------------------------------------------------ 各区块 */

  function renderHead(host) {
    const head = mk('div', 'tf-head');
    const data = ui.data;
    head.appendChild(mk('div', 'tf-card-title', '本机'));
    if (data) {
      const running = data.listening;
      head.appendChild(
        badge(running ? `监听 0.0.0.0:${data.port}` : '设备服务器未启动', running ? 'ok' : 'fail'),
      );
      head.appendChild(badge(data.accepting ? '允许接收' : '不接收', data.accepting ? 'ok' : 'warn'));
      head.appendChild(badge(data.discoverable ? '可被发现' : '隐身', data.discoverable ? 'ok' : ''));
    }

    if (data) {
      const right = mk('div', 'tf-head-right');
      right.appendChild(mk('span', 'tf-card-note', '设备名'));
      right.appendChild(
        textInput(
          ui.deviceDraft ?? data.device.name,
          '别人看到的设备名',
          (value) => {
            ui.deviceDraft = value;
          },
          { focusKey: 'deviceName', className: 'tf-device-input', maxLength: 80 },
        ),
      );
      right.appendChild(
        button('保存', 'ghost-btn', () => {
          const name = (ui.deviceDraft ?? data.device.name).trim();
          ui.deviceDraft = null;
          return settings({ deviceName: name });
        }),
      );
      head.appendChild(right);
    }
    host.appendChild(head);

    if (ui.error) {
      const hint = ui.error?.payload?.error?.details?.hint;
      host.appendChild(alertBox('没能完成', `${ui.error.message ?? ui.error}${hint ? `（${hint}）` : ''}`, 'fail'));
    }
    if (ui.data?.error) host.appendChild(alertBox('设备服务器没起来', ui.data.error, 'fail'));
  }

  function renderPrivacy(host) {
    host.appendChild(
      alertBox(
        '这是局域网直传，不走任何服务器',
        '只在局域网内监听，不做任何公网暴露；内容**不加密**（你明确说过不需要），所以同一局域网内、拿到配对码的设备在配对后能看到你勾选传过去的数据。成绩不参与传输；谁在什么时候传了什么，都会记在下面的传输日志里。',
      ),
    );
  }

  function renderPairing(host) {
    const data = ui.data;
    const box = card('配对码', '只有知道你配对码的设备才能往你这里传数据');
    const row = mk('div', 'tf-code-box');

    const codeNode = mk('div', `tf-code${data.code.locked || data.code.remainingMs <= 0 ? ' expired' : ''}`, formatCode(data.code.code));
    row.appendChild(codeNode);

    const meta = mk('div', 'tf-code-meta');
    const countdown = mk('div', 'tf-countdown');
    ui.countdownNode = countdown;
    meta.appendChild(countdown);
    meta.appendChild(mk('div', null, data.code.locked ? '错误次数过多，已临时锁定' : `还能试 ${data.code.attemptsLeft} 次（错 5 次锁 60 秒）`));
    const actions = mk('div', 'tf-head-right');
    actions.appendChild(button(ui.busy === 'code' ? '换一个…' : '换一个', 'ghost-btn', swapCode));
    meta.appendChild(actions);
    row.appendChild(meta);
    box.appendChild(row);
    box.appendChild(
      mk(
        'div',
        'tf-card-note',
        '配对码是一次会话的“进门凭证”：有效期 10 分钟，配对成功后对方拿到 30 分钟有效的令牌，之后每个分片都带着它。想立刻作废就点「换一个」。',
      ),
    );
    host.appendChild(box);
    updateCountdown();
  }

  function formatCode(code) {
    const text = String(code ?? '');
    return text.length === 6 ? `${text.slice(0, 3)} ${text.slice(3)}` : text;
  }

  function updateCountdown() {
    const node = ui.countdownNode;
    const code = ui.data?.code;
    if (!node || !node.isConnected || !code) return;
    if (code.locked) {
      node.textContent = '已锁定，稍后再试';
      return;
    }
    const left = Date.parse(code.expiresAt) - Date.now();
    node.textContent = left > 0 ? `有效期还剩 ${formatMs(left)}` : '已过期，点「换一个」或重新打开本页';
    if (left <= 0) node.classList.add('expired');
  }

  function renderSwitches(host) {
    const data = ui.data;
    const box = card('发现与接收');
    const grid = mk('div', 'tf-grid');
    grid.appendChild(
      switchRow(
        '可被发现（默认关）',
        '打开后每 5 秒向同网段广播一次“我在这里”，别人才会在「附近设备」里看到你。关着也能主动发给别人。',
        data.discoverable,
        (checked) => settings({ discoverable: checked }),
      ),
    );
    grid.appendChild(
      switchRow(
        '允许接收数据',
        '关掉之后任何人（包括刚配对过的）都传不进来，已发出的令牌同时作废。',
        data.accepting,
        (checked) => settings({ accepting: checked }),
      ),
    );
    box.appendChild(grid);
    const discovery = data.discovery ?? {};
    box.appendChild(
      mk(
        'div',
        'tf-card-note',
        discovery.udp === false
          ? '当前实例关掉了 UDP 发现（测试/无网环境）：只能靠手工填 IP:8886 连接。'
          : discovery.bound
            ? `发现通道在 UDP ${discovery.port} 上监听中（已发 ${discovery.sent} 包 / 已收 ${discovery.received} 包）。`
            : `发现通道未启动${discovery.error ? `：${discovery.error}` : ''}——广播被防火墙拦时，直接手工填对方的 IP:8886。`,
      ),
    );
    host.appendChild(box);
  }

  /**
   * 局域网网关：让手机/平板用浏览器打开本程序（iOS 壳与 PWA 的前置入口）。
   *
   * 为什么单独一块、默认关：主服务只监听 127.0.0.1（手机连不上是必然的），网关是把
   * `/app`+`/api`+`/ws` 放到 8886 上对外 —— **这是安全边界的一次外扩**，所以：
   *   - 默认关，必须由用户自己打开；
   *   - 进门要配对码（与直传同一个 6 位码、同一套"错 5 次锁 60 秒"）；
   *   - 风险原话写在卡片里，不粉饰；
   *   - 一键就能注销所有已授权设备 / 关掉整个入口。
   */
  function renderGateway(host) {
    const data = ui.data;
    const gateway = data.gateway ?? { enabled: false, urls: [], tokens: [], tokenCount: 0, entry: '' };
    const box = card('手机 / 平板打开本程序', gateway.enabled ? `已授权 ${gateway.tokenCount} 台设备` : '默认关');

    box.appendChild(
      switchRow(
        '允许手机/平板在局域网内打开本程序（默认关）',
        '打开后，同一局域网内、拿到配对码的设备可以访问你本机的数据（成绩/笔记/对话）。关掉立即全部失效，已进门的设备要重新输码。',
        gateway.enabled,
        (checked) => setGateway(checked),
      ),
    );

    if (!gateway.enabled) {
      box.appendChild(
        mk(
          'div',
          'tf-card-note',
          '主服务只听 127.0.0.1（只有本机打得开），所以手机直接开 http://电脑IP:3210/app 一定连不上。要用手机，就在这里打开网关：它把这个入口放到局域网可达的 8886 上，并且仍然要配对码。',
        ),
      );
      host.appendChild(box);
      return;
    }

    const urls = gateway.urls ?? [];
    if (!urls.length) {
      box.appendChild(alertBox('没找到局域网地址', '这台机器现在没有非回环的 IPv4 地址（可能没连 Wi-Fi）。连上网络后重新打开本页。', 'warn'));
    } else {
      const list = mk('div', 'tf-list');
      for (const url of urls) {
        const row = mk('div', 'tf-lan-row');
        row.appendChild(mk('code', 'tf-lan-url', url));
        row.appendChild(button('复制', 'ghost-btn', () => copyText(url, '地址已复制，用手机浏览器打开')));
        list.appendChild(row);
      }
      box.appendChild(list);
    }

    box.appendChild(
      mk(
        'div',
        'tf-card-note',
        '手机做法：Safari 打开上面的地址 → 输入本页显示的 6 位配对码 → 进入后再「分享 → 添加到主屏幕」，桌面上就有一个像 App 一样的图标。',
      ),
    );
    box.appendChild(mk('div', 'tf-card-note', `一台设备输一次码可连续用 30 分钟（Cookie 到期后重新输码即可）。现在有 ${gateway.tokenCount} 台设备被授权。`));

    // 已授权设备：只显示"能认出是谁"的信息（完整令牌不出现在任何接口响应里）
    const tokens = gateway.tokens ?? [];
    if (tokens.length) {
      const list = mk('div', 'tf-list');
      for (const session of tokens) {
        const row = mk('div', 'tf-log-row');
        const main = mk('div', 'tf-log-main');
        main.appendChild(mk('div', 'tf-log-title', session.label));
        main.appendChild(mk('div', 'tf-log-meta', `令牌 ${session.id}… · 到期 ${formatStamp(session.expiresAt)}`));
        row.appendChild(main);
        list.appendChild(row);
      }
      box.appendChild(list);
    }

    const actions = mk('div', 'tf-head-right');
    actions.appendChild(
      button(ui.busy === 'revoke' ? '注销中…' : '全部注销', 'ghost-btn', () => {
        if (!tokens.length) return void PC.toast('当前没有被授权的设备');
        return revokeLanTokens();
      }),
    );
    box.appendChild(actions);

    box.appendChild(
      alertBox(
        '安全边界（照实说）',
        '只监听局域网、不出公网，内容也不加密 —— 配对码就是门票：同一局域网里拿到配对码的人，能看到成绩、笔记与对话。公共 Wi-Fi（咖啡厅/酒店/学校开放网络）下不建议打开；用完就关掉，或点上面的「全部注销」。',
        'warn',
      ),
    );

    host.appendChild(box);
  }

  function renderPeers(host) {
    const data = ui.data;
    const box = card('附近设备', data.peers.length ? `${data.peers.length} 台` : null);
    if (!data.peers.length) {
      box.appendChild(empty('还没发现别的设备。让对方打开「可被发现」，或手工填对方的 IP:8886。'));
    }
    const list = mk('div', 'tf-list');
    for (const peer of data.peers) list.appendChild(renderPeerRow(peer));
    box.appendChild(list);

    // 手工添加：跨网段 / 广播被拦时的唯一入口
    const form = mk('div', 'tf-peer-form');
    form.appendChild(mk('span', null, '手工添加'));
    form.appendChild(
      textInput(ui.manualDraft, '192.168.1.8:8886', (value) => {
        ui.manualDraft = value;
      }, { focusKey: 'manual', className: 'tf-device-input' }),
    );
    form.appendChild(
      button(ui.busy === 'peer' ? '连接中…' : '添加', 'ghost-btn', () => {
        const raw = ui.manualDraft.trim();
        if (!raw) return void PC.toast('先填对方地址，例如 192.168.1.8:8886');
        const [host, port] = raw.split(':');
        return addPeer(host.trim(), port ? Number(port) : undefined);
      }),
    );
    form.appendChild(mk('span', 'tf-card-note', '会先连一次确认地址没写错'));
    box.appendChild(form);
    host.appendChild(box);
  }

  function renderPeerRow(peer) {
    const row = mk('div', 'tf-peer');
    const main = mk('div', 'tf-peer-main');
    main.appendChild(mk('div', 'tf-peer-name', peer.name));
    const meta = [`${platformLabel(peer.platform)} · ${peer.host ?? '?'}:${peer.port}`];
    if (peer.via === 'manual') meta.push('手工添加');
    main.appendChild(mk('div', 'tf-peer-meta', meta.join(' · ')));
    row.appendChild(main);

    const actions = mk('div', 'tf-peer-actions');
    actions.appendChild(
      peer.accepting === false
        ? badge('对方不接收', 'fail')
        : peer.accepting === true
          ? badge('可以接收', 'ok')
          : badge('未确认', 'warn'),
    );
    actions.appendChild(
      button('发送', 'primary-btn', () => {
        ui.target = ui.target === peer.id ? null : peer.id;
        ui.codeDraft = '';
        paint();
      }),
    );
    row.appendChild(actions);

    const wrap = mk('div', 'tf-list');
    wrap.appendChild(row);
    if (ui.target === peer.id) wrap.appendChild(renderSendForm(peer));
    return wrap;
  }

  function renderSendForm(peer) {
    const form = mk('div', 'tf-peer-form');
    form.appendChild(mk('span', null, `输入「${peer.name}」页面上显示的 6 位配对码`));
    const input = textInput(ui.codeDraft, '6 位数字', (value) => {
      ui.codeDraft = value.replace(/\D/g, '').slice(0, 6);
    }, { focusKey: 'pairCode', className: 'tf-device-input', maxLength: 6 });
    form.appendChild(input);
    form.appendChild(
      button(ui.busy === 'send' ? '传输中…' : `发送（${ui.selected.size} 类）`, 'primary-btn', () => {
        if (ui.codeDraft.length !== 6) return void PC.toast('配对码是 6 位数字，在对方「传输」页上');
        return sendTo(peer, ui.codeDraft);
      }),
    );
    form.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.target = null;
        ui.codeDraft = '';
        paint();
      }),
    );
    return form;
  }

  function renderCollections(host) {
    const data = ui.data;
    const box = card('要传的集合', `已勾选 ${ui.selected.size} 类`);
    const grid = mk('div', 'tf-collections');
    for (const entry of data.catalog) {
      const label = mk('label', `tf-collection${entry.sendable === false ? ' disabled' : ''}`);
      const input = mk('input');
      input.type = 'checkbox';
      input.disabled = entry.sendable === false;
      input.checked = ui.selected.has(entry.name);
      input.addEventListener('change', () => {
        if (input.checked) ui.selected.add(entry.name);
        else ui.selected.delete(entry.name);
        paint();
      });
      const body = mk('div', 'tf-collection-body');
      body.appendChild(mk('div', 'tf-collection-label', entry.label));
      if (entry.sendable === false) body.appendChild(mk('div', 'tf-collection-note', entry.reason));
      else if (!entry.importable) body.appendChild(mk('div', 'tf-collection-note', `能发，但对方收不下：${entry.reason}`));
      else if (entry.reason) body.appendChild(mk('div', 'tf-collection-note', entry.reason));
      label.append(input, body);
      grid.appendChild(label);
    }
    box.appendChild(grid);
    box.appendChild(
      mk('div', 'tf-card-note', '传输是手动触发的：只有你点了「发送」才会读这些数据；接收方那边按各自的模块规则落库（同一批重发不会重复写入）。'),
    );
    host.appendChild(box);
  }

  function renderProgress(host) {
    const data = ui.data;
    const { outgoing, incoming } = data.progress;
    if (!outgoing && !incoming.length) return;
    const box = card('进度');
    const list = mk('div', 'tf-list');

    if (outgoing) {
      const row = mk('div', 'tf-progress-row');
      const batches = outgoing.batches ?? { index: 0, total: 0 };
      row.appendChild(mk('strong', null, '发送 →'));
      row.appendChild(
        mk(
          'span',
          null,
          `${outgoing.peer?.name ?? outgoing.peer?.host ?? '对方'} · 第 ${batches.index}/${batches.total} 批 · 已传 ${outgoing.sent} 条 · 跳过 ${outgoing.skipped} 条 · 重命名 ${outgoing.renamed} 条`,
        ),
      );
      row.appendChild(badge(outgoing.status === 'failed' ? '失败' : outgoing.status === 'done' ? '已完成' : '传输中', outgoing.status === 'failed' ? 'fail' : outgoing.status === 'done' ? 'ok' : 'warn'));
      list.appendChild(row);
      if (outgoing.error) list.appendChild(alertBox('发送失败', outgoing.error, 'fail'));
    }
    for (const state of incoming) {
      const row = mk('div', 'tf-progress-row');
      row.appendChild(mk('strong', null, '接收 ←'));
      row.appendChild(
        mk(
          'span',
          null,
          `${state.from?.name ?? '未知设备'} · 第 ${state.chunks.received}/${state.chunks.total} 批 · 新增 ${state.items.added} 条 · 跳过 ${state.items.skipped} 条 · 重命名 ${state.items.renamed} 条`,
        ),
      );
      row.appendChild(badge(state.status === 'done' ? '已完成' : '接收中', state.status === 'done' ? 'ok' : 'warn'));
      list.appendChild(row);
    }
    box.appendChild(list);
    host.appendChild(box);
  }

  function renderResult(host) {
    const result = ui.data.lastResult;
    const suspects = ui.data.suspects ?? [];
    if (!result && !suspects.length) return;
    const box = card('最近一次传输的结果');

    if (result) {
      const summary = result.summary ?? {};
      const added = summary.added ?? summary.sent ?? 0;
      const stats = mk('div', 'tf-stats');
      const stat = (label, value, tone) => {
        const node = mk('div', `tf-stat${tone ? ` ${tone}` : ''}`);
        node.appendChild(mk('div', 'tf-stat-value', value));
        node.appendChild(mk('div', 'tf-stat-label', label));
        return node;
      };
      stats.appendChild(stat(result.direction === 'out' ? '成功发出' : '成功收下', added, 'ok'));
      stats.appendChild(stat('跳过（已有）', summary.skipped ?? 0));
      stats.appendChild(stat('重命名并存', summary.renamed ?? 0, (summary.renamed ?? 0) ? 'warn' : ''));
      stats.appendChild(stat('记忆冲突', summary.conflicts ?? 0, (summary.conflicts ?? 0) ? 'warn' : ''));
      stats.appendChild(stat('失败', summary.errors ?? 0, (summary.errors ?? 0) ? 'fail' : ''));
      box.appendChild(stats);
      box.appendChild(
        mk(
          'div',
          'tf-card-note',
          `${result.direction === 'out' ? '发给' : '来自'} ${result.peer?.name ?? '?'} · ${formatStamp(result.at)} · ` +
            `${Object.entries(result.collections ?? {}).map(([name, count]) => `${name} ${count}`).join(' / ') || '没有数据'} · ` +
            `${Math.round((result.durationMs ?? 0) / 100) / 10} 秒`,
        ),
      );

      const noteworthy = (result.items ?? []).filter((item) => item.action !== 'added' || item.truncated);
      if (noteworthy.length) {
        const list = mk('div', 'tf-list');
        for (const item of noteworthy.slice(0, 40)) list.appendChild(renderResultItem(item));
        box.appendChild(mk('div', 'tf-card-note', '逐条的跳过 / 重命名 / 失败原因：'));
        box.appendChild(list);
      }
    }

    if (suspects.length) {
      box.appendChild(mk('div', 'tf-card-note', `疑似重复 / 冲突 ${suspects.length} 条 —— 两条都留着，删哪条由你定：`));
      const list = mk('div', 'tf-list');
      for (const suspect of suspects) list.appendChild(renderSuspect(suspect));
      box.appendChild(list);
    }
    host.appendChild(box);
  }

  function renderResultItem(item) {
    const row = mk('div', 'tf-item');
    const body = mk('div', 'tf-item-body');
    body.appendChild(mk('div', 'tf-item-title', item.title || item.remoteId));
    const tone = item.action === 'failed' ? 'fail' : item.action === 'renamed' || item.truncated ? 'warn' : '';
    const parts = [`${item.label ?? item.collection} · ${ACTION_LABEL[item.action] ?? item.action}`];
    if (item.alias) parts.push(`新 id 后缀 ${item.alias}`);
    if (item.origin) parts.push(`来自 ${item.origin}`);
    if (item.reason) parts.push(item.reason);
    if (item.note) parts.push(item.note);
    body.appendChild(mk('div', 'tf-item-meta', parts.join(' · ')));
    row.appendChild(body);
    row.appendChild(badge(ACTION_LABEL[item.action] ?? item.action, tone));
    return row;
  }

  const ACTION_LABEL = { added: '已收下', skipped: '跳过', renamed: '重命名并存', conflict: '记忆冲突', failed: '失败' };

  function renderSuspect(suspect) {
    const row = mk('div', 'tf-item');
    const body = mk('div', 'tf-item-body');
    body.appendChild(mk('div', 'tf-item-title', `${suspect.label}：${suspect.title || suspect.remoteId}`));
    const parts = [`来自 ${suspect.origin?.name ?? '未知设备'} · ${formatStamp(suspect.at)}`];
    if (suspect.kind === 'duplicate') parts.push(`本机已有一条「${suspect.existingTitle}」`);
    if (suspect.alias) parts.push(`新 id 后缀 ${suspect.alias}`);
    if (suspect.detail) parts.push(suspect.detail);
    body.appendChild(mk('div', 'tf-item-meta', parts.join(' · ')));
    row.appendChild(body);

    const actions = mk('div', 'tf-item-actions');
    const key = `suspect:${suspect.id}`;
    actions.appendChild(
      button(ui.confirming === key ? '再点一次确认删除' : '删除本机这条', 'ghost-btn', () => {
        if (ui.confirming === key) return resolveSuspect(suspect.id, 'delete');
        return void confirmThen(key);
      }),
    );
    actions.appendChild(button('保留', 'ghost-btn', () => resolveSuspect(suspect.id, 'keep')));
    row.appendChild(actions);
    return row;
  }

  function renderLog(host) {
    const logs = ui.data.log ?? [];
    const box = card('传输日志', `最近 ${logs.length} 条`);
    if (!logs.length) {
      box.appendChild(empty('还没有传输记录。传过一次之后，这里会写清谁在什么时候传了什么、成功/跳过各几条。'));
      host.appendChild(box);
      return;
    }
    const list = mk('div', 'tf-list');
    for (const entry of logs) {
      const row = mk('div', 'tf-log-row');
      const main = mk('div', 'tf-log-main');
      const direction = entry.direction === 'in' ? '收到' : '发出';
      main.appendChild(mk('div', 'tf-log-title', `${direction} · ${entry.peer?.name ?? '未知设备'}`));
      const collections = Object.entries(entry.collections ?? {}).map(([name, count]) => `${name} ${count}`).join(' / ') || '无数据';
      const summary = entry.summary ?? {};
      const bits = [`新增 ${summary.added ?? summary.sent ?? 0}`, `跳过 ${summary.skipped ?? 0}`];
      if (summary.renamed) bits.push(`重命名 ${summary.renamed}`);
      if (summary.conflicts) bits.push(`冲突 ${summary.conflicts}`);
      if (summary.errors) bits.push(`失败 ${summary.errors}`);
      main.appendChild(mk('div', 'tf-log-meta', `${formatStamp(entry.at)} · ${collections} · ${bits.join(' · ')}`));
      row.appendChild(main);
      row.appendChild(badge(entry.status === 'ok' ? '成功' : entry.status === 'partial' ? '部分失败' : '失败', entry.status === 'ok' ? 'ok' : entry.status === 'partial' ? 'warn' : 'fail'));
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(mk('div', 'tf-card-note', '日志同时落在本机数据目录的 transfer-log.json（仅本用户可读），最多保留 200 条。'));
    host.appendChild(box);
  }

  /* ------------------------------------------------------------ 轮询 */

  function startTimers() {
    stopTimers();
    // 2 秒拉一次状态：进度、日志、附近设备都会跟着变；没有变化时不重画（见 signatureOf）
    ui.ticker = setInterval(() => {
      if (!ui.mount || !ui.mount.isConnected) return stopTimers();
      if (ui.busy) return undefined;
      return void load({ silent: true }).catch(() => {});
    }, 2000);
    ui.ticker.unref?.();
    // 倒计时单独 1 秒一跳：只改那一个文本节点，不重画整页
    ui.countdownTimer = setInterval(updateCountdown, 1000);
    ui.countdownTimer.unref?.();
    return undefined;
  }

  function stopTimers() {
    if (ui.ticker) clearInterval(ui.ticker);
    if (ui.countdownTimer) clearInterval(ui.countdownTimer);
    ui.ticker = null;
    ui.countdownTimer = null;
  }

  /* ------------------------------------------------------------ 登记 */

  window.PCModules.register({
    id: 'transfer',
    label: '传输',
    icon: 'transfer',
    order: 66,
    title: '传输',
    render(ctx) {
      ui.mount = ctx.mount;
      ui.error = null;
      ui.deviceDraft = null;
      paint();
      void run('load', async () => {
        await load();
        startTimers();
      });
    },
  });
})();
