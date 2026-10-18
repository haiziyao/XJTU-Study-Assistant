/**
 * 「设置 → 对话设置」卡片：联网检索这一块的开关、服务、密钥与**最大条数**。
 *
 * 为什么单独一块而不是塞进「AI 接入」：
 *   - 密钥是**接入**（能不能用模型），联网是**行为**（模型能不能出网、出去读多少东西）。
 *     两者出问题时排查路径完全不同：密钥错了整段对话不可用，检索被反爬只有联网相关的回答会退化。
 *   - 「网络搜索最大条数」是用户明确要的一个旋钮（5–30）：它直接决定一次问答读几个网页 ——
 *     读得多结论更全但更慢、也更费 token，读得少快但可能漏。放在设置里让人自己权衡。
 *
 * 「上下文上限」是这一块唯一一个**不影响行为、只影响读数**的旋钮：它只当"上下文用量"百分比的分母。
 * 真正的窗口截断仍然按「最近若干轮 + 滚动摘要」走（见 modules/ai/chat-service.js），
 * 所以它旁边那句说明必须写清这件事 —— 否则用户会以为调大它就能让模型记住更多。
 *
 * 「试一下」是这一块最重要的按钮：联网检索最容易出现"看起来配好了、其实被拦了"的情况，
 * 所以这里直接把**诊断信息**摊开（用了哪个后端、校内域名通不通、每条为什么没抓到正文），
 * 而不是只回一句"没搜到"。它和对话里走同一个适配器，这里能搜到，对话里就能搜到。
 *
 * 约定与其它区块一致：文本一律 textContent，不写 inline style（CSP 会拦），颜色只用主题令牌。
 */

(function () {
  const SECTION_ID = 'chat.settings';
  const PROVIDER_LABEL = {
    auto: '自动（有 key 用官方）',
    deepseek: 'DeepSeek 官方搜索（推荐，需 API key / 5 元每千次）',
    scrape: '只用免密钥通道（解析 Bing / 百度结果页）',
    tavily: 'Tavily',
    brave: 'Brave Search',
    serper: 'Serper（Google）',
    bing: 'Bing Web Search',
  };

  const ui = {
    mount: null,
    config: null,
    error: null,
    busy: null,
    /** 试搜：`{ query, mode, result, error }` */
    probe: null,
  };

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function notice(title, message, kind = 'warn') {
    const box = mk('div', `kb-alert cs-alert ${kind}`);
    box.appendChild(mk('div', 'kb-alert-title', title));
    if (message) box.appendChild(mk('div', 'kb-alert-msg', message));
    return box;
  }

  async function loadConfig() {
    const data = await PC.api('/ai/config');
    ui.config = data?.config ?? null;
    return ui.config;
  }

  async function refresh() {
    ui.error = null;
    paint();
    try {
      await loadConfig();
    } catch (error) {
      ui.error = error;
    } finally {
      paint();
    }
  }

  async function save(body) {
    ui.busy = 'save';
    ui.error = null;
    paint();
    try {
      await PC.api('/ai/config', { method: 'POST', body });
      await loadConfig();
      PC.toast('已保存对话设置');
      await PC.refreshAi?.();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.busy = null;
      paint();
    }
  }

  function field(label, control, hint) {
    const wrap = mk('label', 'cs-field');
    wrap.appendChild(mk('span', 'cs-field-label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(mk('span', 'cs-field-hint', hint));
    return wrap;
  }

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.textContent = '';

    if (ui.error) mount.appendChild(notice('没能完成', ui.error.message ?? String(ui.error), 'fail'));

    if (!ui.config) {
      mount.appendChild(mk('div', 'cs-loading', '正在读取配置…'));
      return;
    }
    const config = ui.config;

    // ---------------------------------------------------------- 上下文
    mount.appendChild(mk('div', 'cs-group-title', '上下文'));

    // 多一个 cs-context-window：这一块有两个数字输入（上限 / 搜索条数），测试与样式都要能指名道姓
    const contextWindow = mk('input', 'cs-input cs-number cs-context-window');
    contextWindow.type = 'number';
    contextWindow.min = '8000';
    contextWindow.max = '2000000';
    contextWindow.step = '1000';
    contextWindow.value = String(config.contextWindow ?? 1000000);
    mount.appendChild(
      field(
        '上下文上限（token）',
        contextWindow,
        '默认 1,000,000。它**只作为「上下文用量」百分比的分母**（对话输入框上方那个圆环），' +
          '不改变窗口截断规则：送进模型的历史仍然是最近若干轮，更早的内容由滚动摘要带着。',
      ),
    );

    // ---------------------------------------------------------- 联网检索
    mount.appendChild(mk('div', 'cs-group-title', '联网检索'));

    const enabled = mk('input');
    enabled.type = 'checkbox';
    enabled.checked = config.searchEnabled !== false;
    enabled.id = 'cs-search-enabled';
    const enabledField = field('允许联网检索', enabled, '关掉后模型不会出网（也不会有"我搜了一下"这种话）');
    mount.appendChild(enabledField);

    const provider = mk('select', 'cs-select');
    for (const [value, label] of Object.entries(PROVIDER_LABEL)) {
      const option = mk('option', null, label);
      option.value = value;
      provider.appendChild(option);
    }
    provider.value = PROVIDER_LABEL[config.searchProvider] ? config.searchProvider : 'auto';
    mount.appendChild(
      field(
        '搜索服务',
        provider,
        '自动：有「AI 接入」里的 DeepSeek API key 就用官方搜索（一次请求带回全文），没有就解析结果页。'
          + '计费：Search / Fetch 各 5 元/1000 次**成功**请求（失败或空结果不计费），QPS 各 5（账号粒度）；'
          + '所以「一次 search + need_content」比「search + 逐页 Fetch」便宜得多。',
      ),
    );

    const needContent = mk('input');
    needContent.type = 'checkbox';
    needContent.checked = config.searchNeedContent !== false;
    needContent.id = 'cs-search-need-content';
    mount.appendChild(
      field(
        '检索时直接取回全文（need_content）',
        needContent,
        '默认开：一次 Search 就把每条的正文一起带回来，省掉逐页 Fetch 的 N 次计费与往返。'
          + '关掉后只拿标题/摘要/来源，读到正文的条数会变少。',
      ),
    );

    const key = mk('input', 'cs-input');
    key.type = 'password';
    key.autocomplete = 'off';
    key.placeholder = config.searchApiKey
      ? `已保存（${config.searchApiKey}），留空不改`
      : 'API Key（DeepSeek 官方复用「AI 接入」里的密钥；Tavily / Brave / Serper / Bing 填这里）';
    mount.appendChild(
      field(
        '搜索 API 密钥',
        key,
        'DeepSeek 官方搜索默认用「AI 接入」里配置的 key（同一账号、同一份账单）；'
          + '只有把「搜索服务」显式选成 DeepSeek 时，这里填的 key 才会覆盖它（自建代理常用）。'
          + '留空表示不改动，输入 - 表示清除已保存的密钥。',
      ),
    );

    const pages = mk('input', 'cs-input cs-number');
    pages.type = 'number';
    pages.min = '5';
    pages.max = '30';
    pages.step = '1';
    pages.value = String(config.searchMaxPages ?? 8);
    const pagesHint = mk('span', 'cs-field-hint', '允许 AI 一次性读取的最大网页数量：5–30（默认 8）。读得越多结论越全，但更慢、更费 token。');
    const pagesField = field('网络搜索最大条数', pages, null);
    pagesField.appendChild(pagesHint);
    mount.appendChild(pagesField);

    /**
     * 「一次提问最多检索几次」= 一个回合内的检索**预算**（后端 `searchRetryMax`，默认 3、范围 1–6）。
     *
     * 为什么它和上面那个"最大条数"是两回事、还紧挨着放：
     *   - 最大条数管**一次**检索读几个网页（一次读多还是读少）；
     *   - 这个数字管**一次提问最多发起几次**检索（最多试几回）。
     * 两者都会让回答更全，但代价不同：前者每次更慢，后者是"反复查"的整体耗时。
     * 文案要写清"用完就不再发起新检索，模型会按已有结果收尾"——
     * 否则用户会以为调大它模型就会一直查下去，或者调小之后"它怎么不查了"。
     */
    const retry = mk('input', 'cs-input cs-number cs-search-retry');
    retry.type = 'number';
    retry.min = '1';
    retry.max = '6';
    retry.step = '1';
    retry.value = String(config.searchRetryMax ?? 3);
    mount.appendChild(
      field(
        '一次提问最多检索几次',
        retry,
        '1–6（默认 3）。用完就不再发起新检索，模型会按已有结果收尾：调大更可能查到，但一次提问会更慢。',
      ),
    );

    const actions = mk('div', 'cs-actions');
    const saveBtn = mk('button', 'primary-btn', ui.busy === 'save' ? '保存中…' : '保存');
    saveBtn.type = 'button';
    saveBtn.disabled = ui.busy === 'save';
    saveBtn.addEventListener('click', () => {
      const value = Number(pages.value);
      if (!Number.isInteger(value) || value < 5 || value > 30) {
        ui.error = new Error('网络搜索最大条数必须是 5–30 之间的整数');
        paint();
        return;
      }
      // 前端先拦一道（后端 assertAiConfigInput 也会拦）：范围与 config.js 的
      // CONTEXT_WINDOW_MIN/MAX 一致，改一边记得改另一边
      const windowValue = Number(contextWindow.value);
      if (!Number.isInteger(windowValue) || windowValue < 8000 || windowValue > 2000000) {
        ui.error = new Error('上下文上限必须是 8000–2000000 之间的整数（token）');
        paint();
        return;
      }
      const body = {
        contextWindow: windowValue,
        searchEnabled: enabled.checked,
        searchProvider: provider.value,
        searchMaxPages: value,
        searchNeedContent: needContent.checked,
      };
      // 同上：范围与 config.js 的 SEARCH_RETRY_MIN/MAX（1–6）一致，改一边记得改另一边
      const retryValue = Number(retry.value);
      if (!Number.isInteger(retryValue) || retryValue < 1 || retryValue > 6) {
        ui.error = new Error('一次提问最多检索几次必须是 1–6 之间的整数');
        paint();
        return;
      }
      body.searchRetryMax = retryValue;
      const typed = key.value.trim();
      if (typed === '-') body.searchApiKey = '';
      else if (typed) body.searchApiKey = typed;
      void save(body);
    });
    actions.appendChild(saveBtn);
    mount.appendChild(actions);

    // ---------------------------------------------------------- 试一下
    mount.appendChild(mk('div', 'cs-group-title', '试一下'));

    const probe = ui.probe ?? { query: '', mode: 'web' };
    ui.probe = probe;
    const row = mk('div', 'cs-probe');
    const queryInput = mk('input', 'cs-input');
    queryInput.type = 'text';
    queryInput.placeholder = '例如：西安交通大学 转专业 条件';
    queryInput.value = probe.query ?? '';
    queryInput.addEventListener('input', () => {
      probe.query = queryInput.value;
    });
    queryInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void runProbe();
    });
    const modeSelect = mk('select', 'cs-select cs-mode');
    for (const [value, label] of [
      ['web', '从校外网搜索'],
      ['campus', '从校内网搜索'],
    ]) {
      const option = mk('option', null, label);
      option.value = value;
      modeSelect.appendChild(option);
    }
    modeSelect.value = probe.mode ?? 'web';
    modeSelect.addEventListener('change', () => {
      probe.mode = modeSelect.value;
    });
    const probeBtn = mk('button', 'ghost-btn', ui.busy === 'probe' ? '检索中…' : '试检索');
    probeBtn.type = 'button';
    probeBtn.disabled = ui.busy === 'probe';
    probeBtn.addEventListener('click', () => void runProbe());
    row.append(queryInput, modeSelect, probeBtn);
    mount.appendChild(row);

    async function runProbe() {
      const text = String(probe.query ?? '').trim();
      if (!text) {
        ui.error = new Error('先写一句要搜的内容');
        paint();
        return;
      }
      ui.busy = 'probe';
      ui.error = null;
      probe.result = null;
      probe.error = null;
      paint();
      try {
        probe.result = await PC.api('/ai/search/test', {
          method: 'POST',
          body: { query: text, mode: probe.mode ?? 'web' },
        });
      } catch (error) {
        probe.error = error;
      } finally {
        ui.busy = null;
        paint();
      }
    }

    if (probe.error) {
      mount.appendChild(notice('检索失败', probe.error.message ?? String(probe.error), 'fail'));
    }
    if (probe.result) mount.appendChild(renderProbe(probe.result));
    if (!probe.result && !probe.error) {
      mount.appendChild(
        mk('div', 'cs-field-hint', '提示：这一步会真的联网。想验证"能不能搜到"就用它；结果与对话里完全一致。'),
      );
    }
  }

  function renderProbe(result) {
    const box = mk('div', 'cs-probe-result');
    const backend = result.backend ?? {};
    const backendLabel = backend.kind === 'api'
      ? `API（${(backend.providers ?? []).join('、')}）`
      : backend.kind === 'deepseek'
        ? 'DeepSeek 官方搜索（Search / Fetch）'
        : '免密钥通道（解析结果页）';
    const lines = [
      `后端：${backendLabel} · ${backend.reason ?? ''}`,
      `上限：${result.limit} 个网页 · 搜到 ${result.count} 条 · 读到正文 ${result.read} 篇${result.mode === 'campus' ? ' · 校内通道' : ''}`,
    ];
    if (result.campus) {
      lines.push(
        `校内探测：${result.campus.onCampus ? '校内域名可达（已并走公网检索）' : '校内域名不可达（只做校内站点定向）'}`,
      );
    }
    // 官方通道的诊断：欠费 / key 无效 / 限流都要在界面上说清楚，不能只显示"没搜到"
    if (result.deepseek) {
      const info = result.deepseek;
      lines.push(
        info.error
          ? `DeepSeek：${info.error.code} · ${info.error.message}${info.campusHit ? '' : '（已尝试降级抓取）'}`
          : `DeepSeek：成功 ${info.count} 条（尝试 ${info.attempts} 次，${info.elapsedMs}ms；`
            + `rerank_score ≥ 1.5 的 ${info.premium} 条、authority ≥ 3 的 ${info.highAuthority} 条）`,
      );
    }
    for (const line of lines) box.appendChild(mk('div', 'cs-probe-line', line));
    for (const note of result.notes ?? []) box.appendChild(mk('div', 'cs-probe-note', `· ${note}`));

    if (!result.count) {
      box.appendChild(
        mk(
          'div',
          'cs-probe-line warn',
          '一条都没搜到。常见原因：没配密钥且结果页被反爬挡住 / 检索词太窄 / 网络不可达。换个说法再试，或填一个搜索 API 密钥。',
        ),
      );
      return box;
    }

    const list = mk('div', 'cs-hits');
    for (const item of result.items ?? []) {
      const hit = mk('div', 'cs-hit');
      hit.appendChild(mk('div', 'cs-hit-title', item.title || item.url));
      hit.appendChild(mk('div', 'cs-hit-url', item.url));
      if (item.snippet) hit.appendChild(mk('div', 'cs-hit-snippet', item.snippet));
      // 官方字段逐条摊开：rerank_score / authority / date / 来源 —— 用户能自己判断这条可不可信
      const facts = [];
      if (Number.isFinite(item.rerankScore)) facts.push(`rerank_score ${item.rerankScore.toFixed(2)}${item.rerankScore >= 1.5 ? '（优质）' : ''}`);
      if (Number.isFinite(item.authority)) facts.push(`authority ${item.authority}${item.authority >= 3 ? '（高权威）' : ''}`);
      if (item.date || item.publishedAt) facts.push(`date ${item.date ?? item.publishedAt}`);
      if (item.siteName) facts.push(`来源 ${item.siteName}`);
      if (item.textSource) facts.push(`正文 ${item.textSource}`);
      if (facts.length) hit.appendChild(mk('div', 'cs-hit-meta', facts.join(' · ')));
      hit.appendChild(
        mk(
          'div',
          'cs-hit-meta',
          item.ok && item.chars
            ? `读到正文 ${item.chars} 字${item.chars > item.text.length ? `（回灌模型时截到 ${item.text.length} 字）` : ''}`
            : `没抓到正文${item.error ? `：${item.error}` : ''}`,
        ),
      );
      list.appendChild(hit);
    }
    box.appendChild(list);
    return box;
  }

  window.PCModules.registerSettingsSection({
    id: SECTION_ID,
    title: '对话设置',
    // 61：紧挨「知识库」（60）—— 两块都是"AI 能看到什么"的设置，放在一起才找得到
    order: 61,
    render(mount) {
      ui.mount = mount;
      paint();
      void refresh();
    },
  });
})();
