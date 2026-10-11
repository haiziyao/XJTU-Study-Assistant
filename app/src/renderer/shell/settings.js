/**
 * 「设置」视图：运行信息、AI 接入状态、主题色板，以及 ICS 导出。
 *
 * 属于外壳自带视图（固定在左栏底部），展示的是框架级信息。
 */

(function () {
const settingsView = {
  title: '设置',

  render(ctx) {
    ctx.mount.innerHTML = '';
    const wrap = mk('div', 'settings');

    const card = (title, rows) => {
      const box = mk('div', 'card');
      box.appendChild(mk('div', 'card-title', title));
      const body = mk('div', 'card-body');
      for (const [label, value] of rows) {
        const line = mk('div', 'kv');
        line.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value ?? '—'));
        body.appendChild(line);
      }
      box.appendChild(body);
      return box;
    };

    const info = PC.state.info ?? {};
    wrap.appendChild(
      card('运行信息', [
        ['接口地址', PC.state.apiBase],
        ['推送通道', PC.state.wsUrl],
        ['数据目录', info.dataDir],
        ['应用版本', info.appVersion],
        ['平台', info.platform],
      ]),
    );

    const ai = PC.state.ai ?? {};
    wrap.appendChild(aiCard(ai));

    const themeCard = mk('div', 'card');
    themeCard.appendChild(mk('div', 'card-title', '主题色板'));
    const swatches = mk('div', 'swatches');
    for (const name of ['blue', 'green', 'orange', 'red', 'purple']) {
      const dot = mk('span', `swatch sw-${name}`, name);
      swatches.appendChild(dot);
    }
    themeCard.appendChild(swatches);
    const exportBtn = mk('button', 'ghost-btn', '导出 ICS 日历文件');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', exportIcs);
    themeCard.appendChild(exportBtn);
    wrap.appendChild(themeCard);

    // 追加：各模块登记的设置区块（目前只有日历模块的「日程分类」）
    renderModuleSections(wrap);

    ctx.mount.appendChild(wrap);
  },
};

/* ------------------------------------------------------------------ AI 接入 */

/**
 * AI 配置卡片：状态 / 密钥 / 模型 / 接口地址 / 会话管理。
 *
 * 两条规矩：
 *   1. **密钥只进不出**：输入框永远从空开始，已保存的只显示末四位（`keyHint`），
 *      保存时也只提交用户真正敲进去的值；
 *   2. 卡片先按已知状态同步渲染，再异步拉 `/ai/status` 补全 —— 拉取失败也只是少几行字，
 *      不影响设置页其它区块。
 */
function aiCard(ai) {
  const box = mk('div', 'card');
  box.appendChild(mk('div', 'card-title', 'AI 接入'));

  const state = mk('div', 'kv-list');
  const stateRows = {
    status: kv('状态', ai.available ? `已配置（${ai.provider ?? 'provider'}）` : '未配置，走本地规则解析'),
    model: kv('模型', '读取中…'),
    baseUrl: kv('接口地址', '读取中…'),
    chat: kv('对话', '读取中…'),
    draw: kv('绘图', '读取中…'),
  };
  for (const row of Object.values(stateRows)) state.appendChild(row.node);
  box.appendChild(state);

  const form = mk('div', 'ai-form');
  const keyInput = input({ type: 'password', placeholder: 'API Key（例如 sk-…）', autocomplete: 'off' });
  const modelInput = input({ type: 'text', placeholder: '模型，留空不改（默认 deepseek-chat）' });
  const baseInput = input({ type: 'text', placeholder: '接口地址，留空不改（OpenAI 兼容端点）' });
  const drawBox = mk('input');
  drawBox.type = 'checkbox';
  drawBox.id = 'ai-draw-mode';
  drawBox.checked = true;
  const drawField = field('绘图', drawBox);
  drawField.appendChild(mk('span', 'ai-hint', '允许用 ```svg 画函数图/示意图（关掉后说「画个图」也能临时触发）'));
  form.append(
    field('密钥', keyInput),
    field('模型', modelInput),
    field('接口地址', baseInput),
    drawField,
  );

  const actions = mk('div', 'ai-actions');
  const save = mk('button', 'primary-btn', '保存');
  save.type = 'button';
  const clear = mk('button', 'ghost-btn', '清除密钥');
  clear.type = 'button';
  const fresh = mk('button', 'ghost-btn', '新对话');
  fresh.type = 'button';
  const wipe = mk('button', 'ghost-btn', '清空全部会话');
  wipe.type = 'button';
  actions.append(save, clear, fresh, wipe);
  form.appendChild(actions);
  form.appendChild(
    mk('div', 'ai-hint', '密钥只存在本机 data/ai-config.json（0600），接口只回显末四位。保存后对话立刻改用模型。'),
  );
  box.appendChild(form);

  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      const body = { drawMode: drawBox.checked };
      if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
      if (modelInput.value.trim()) body.model = modelInput.value.trim();
      if (baseInput.value.trim()) body.baseUrl = baseInput.value.trim();
      await PC.api('/ai/config', { method: 'POST', body });
      keyInput.value = '';
      PC.toast('已保存 AI 配置');
      PC.refresh();
      await PC.refreshAi?.();
    } catch (error) {
      PC.toast(`保存失败：${error.message}`);
    } finally {
      save.disabled = false;
      save.textContent = '保存';
    }
  });

  clear.addEventListener('click', async () => {
    if (!window.confirm('清除本机保存的 API Key？清除后对话回到本地规则解析。')) return;
    try {
      await PC.api('/ai/config', { method: 'DELETE' });
      PC.toast('已清除密钥');
      PC.refresh();
      await PC.refreshAi?.();
    } catch (error) {
      PC.toast(`清除失败：${error.message}`);
    }
  });

  fresh.addEventListener('click', () => {
    PC.state.conversationId = null;
    PC.toast('下一条消息会开一个新会话');
  });

  wipe.addEventListener('click', async () => {
    if (!window.confirm('删除本机全部 AI 会话与消息？这一步不可撤销。')) return;
    try {
      const result = await PC.api('/ai/conversations', { method: 'DELETE' });
      PC.state.conversationId = null;
      PC.toast(`已清空 ${result.conversations ?? 0} 个会话、${result.messages ?? 0} 条消息`);
      PC.refresh();
    } catch (error) {
      PC.toast(`清空失败：${error.message}`);
    }
  });

  // 异步补全：状态、模型名、会话数
  void (async () => {
    try {
      const [status, conversations] = await Promise.all([
        PC.api('/ai/status'),
        PC.api('/ai/conversations'),
      ]);
      const config = status.config ?? {};
      stateRows.status.set(status.configured ? `已配置${config.keyHint ? `（${config.keyHint}）` : ''}` : '未配置，走本地规则解析');
      stateRows.model.set(config.model ?? '—');
      stateRows.baseUrl.set(config.baseUrl ?? '—');
      stateRows.chat.set(`${status.conversations ?? 0} 个会话 · ${status.messages ?? 0} 条消息`);
      stateRows.draw.set(config.drawMode !== false ? '已开启（```svg）' : '已关闭（说「画个图」仍可触发）');
      drawBox.checked = config.drawMode !== false;
      keyInput.placeholder = config.hasKey ? `API Key（已保存 ${config.keyHint}，留空不改）` : 'API Key（例如 sk-…）';
      modelInput.placeholder = `模型，留空不改（当前 ${config.model ?? '—'}）`;
      baseInput.placeholder = `接口地址，留空不改（当前 ${config.baseUrl ?? '—'}）`;
      wipe.disabled = !(status.conversations > 0);
      for (const [key, row] of Object.entries(stateRows)) {
        if (key === 'status') row.node.classList.toggle('kv-ok', Boolean(status.configured));
      }
    } catch (error) {
      stateRows.model.set('读取失败');
      stateRows.baseUrl.set(error.message);
    }
  })();

  return box;
}

/** 一行键值（与设置页其它卡片同款样式，但值可以后填）。 */
function kv(label, value) {
  const node = mk('div', 'kv');
  const val = mk('span', 'kv-val', value ?? '—');
  node.append(mk('span', 'kv-key', label), val);
  return { node, set: (text) => { val.textContent = text ?? '—'; } };
}

function input({ type, placeholder, autocomplete }) {
  const node = mk('input');
  node.type = type;
  node.placeholder = placeholder;
  if (autocomplete) node.autocomplete = autocomplete;
  node.className = 'ai-input';
  return node;
}

function field(label, control) {
  const wrap = mk('label', 'ai-field');
  wrap.append(mk('span', 'ai-field-label', label), control);
  return wrap;
}

async function exportIcs() {
  try {
    const response = await fetch(`${PC.state.apiBase}/ics`);
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'potato-calendar.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    PC.toast('已导出 ICS');
  } catch (error) {
    PC.toast(`导出失败：${error.message}`);
  }
}

/**
 * 追加：渲染各模块登记的设置区块（见 kit/registry.js 的 registerSettingsSection）。
 * 没有任何模块登记时，settingsSections() 为空数组，下方循环一次都不执行 —— 行为与以前完全一致。
 */
function renderModuleSections(host) {
  const sections = window.PCModules.settingsSections?.() ?? [];
  for (const section of sections) {
    const card = mk('div', 'card');
    card.appendChild(mk('div', 'card-title', section.title));
    const body = mk('div', 'card-body');
    card.appendChild(body);
    host.appendChild(card);
    try {
      section.render(body);
    } catch (error) {
      body.appendChild(mk('div', 'eb-msg', `区块渲染失败：${error.message}`));
    }
  }
}

window.PCModules.register({
  id: 'settings',
  label: '设置',
  icon: '⚙',
  order: 1000,
  slot: 'bottom',
  title: settingsView.title,
  render: (ctx) => settingsView.render(ctx),
});
})();
