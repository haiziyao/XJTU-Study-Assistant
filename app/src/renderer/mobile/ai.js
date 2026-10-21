/**
 * AI 页（手机外壳）。
 *
 * 为什么不在手机侧另写一份对话：桌面那份 `.chat` 里已经跑着流式输出、排队、附件、
 * 计划卡、停止/重试，重写一遍就要把同一套状态再接一次，两边迟早漂移。
 * 这里只做两件事：给它套一个手机外样的顶栏（历史 / 新对话），以及把历史对话做成
 * 新风格的列表页；消息气泡与输入区由 `mobile.css` 重排。
 *
 * 依赖：`mobile/ui.js`（组件）、`mobile/shell.js`（页面栈，见 `window.PCMobileShell`）。
 */
(function () {
  'use strict';

  const root = document.documentElement;
  if (!root?.classList?.contains?.('m-app')) return;

  function chatService() {
    try {
      return window.PCModules?.service?.('chat') ?? null;
    } catch {
      return null;
    }
  }

  function conversationTitle(item) {
    const title = String(item?.title ?? '').trim();
    if (title) return title;
    const preview = String(item?.preview ?? item?.lastMessage ?? '').trim().replace(/\s+/g, ' ');
    if (!preview) return '（空对话）';
    return preview.length > 24 ? `${preview.slice(0, 24)}…` : preview;
  }

  /** 相对时间：列表里只需要"多久以前"，精确到分钟没有意义。 */
  function when(iso) {
    const time = Date.parse(iso ?? '');
    if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const date = new Date(time);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function conversationMeta(item) {
    const count = Number(item?.messageCount ?? 0);
    const parts = [`${count} 条消息`];
    const time = when(item?.updatedAt);
    if (time) parts.push(time);
    return parts.join(' · ');
  }

  /* ------------------------------------------------------------ 历史对话 */

  async function renderHistory(page) {
    const { section, cell, emptyState, skeleton } = window.PCMobileUI;
    page.append(skeleton(5));

    let items = [];
    try {
      const data = await window.PC.api('/ai/conversations?archived=all&limit=200');
      items = Array.isArray(data?.items) ? data.items : [];
    } catch (error) {
      page.replaceChildren(
        emptyState({ icon: 'info', title: '没能读到历史对话', message: error?.message ?? String(error) }),
      );
      return;
    }

    if (!items.length) {
      page.replaceChildren(
        emptyState({ icon: 'history', title: '还没有历史对话', message: '回到 AI 说句话，这里就会出现记录。' }),
      );
      return;
    }

    const service = chatService();
    const currentId = service?.currentId?.() ?? null;
    const box = section({ header: '最近对话' });

    for (const item of items.slice(0, 60)) {
      const current = item.id === currentId;
      box.list.append(
        cell({
          title: conversationTitle(item),
          subtitle: conversationMeta(item),
          value: current ? '当前' : item.archived ? '已归档' : '',
          onClick: async () => {
            if (!service?.openConversation) return;
            try {
              await service.openConversation(item.id);
              window.PCMobileShell?.popPage?.();
            } catch (error) {
              window.PC?.toast?.(error?.message ?? '打开失败');
            }
          },
        }),
      );
    }

    page.replaceChildren(box);
  }

  function openHistory() {
    window.PCMobileShell?.pushPage?.({ title: '历史对话', render: (page) => renderHistory(page) });
  }

  function newChat() {
    const service = chatService();
    if (!service?.newConversation) {
      window.PC?.toast?.('这个外壳版本不支持新建对话');
      return;
    }
    service.newConversation();
    const log = document.querySelector('.chat-log');
    if (log) log.scrollTop = 0;
  }

  /* ------------------------------------------------------------ 顶栏 */

  let subtitle = null;

  /** 模型名/未接入状态就在桌面那份 `#ai-badge` 里，盯着它改文字，不另取一份数据。 */
  function mirrorBadge() {
    const badge = document.getElementById('ai-badge');
    if (!badge || !subtitle) return;
    const paint = () => {
      const text = String(badge.textContent ?? '').trim();
      subtitle.textContent = text || '智学助手';
      subtitle.classList.toggle('is-warn', /未接入|失败|错误/.test(text));
    };
    paint();
    new MutationObserver(paint).observe(badge, { childList: true, characterData: true, subtree: true });
  }

  /** 发送键原本是文字按钮；手机上是圆形图标键。只换内容，节点与点击处理器都不动。 */
  function paintSendIcon() {
    const send = document.getElementById('chat-send');
    if (!send || send.dataset.mIcon) return;
    send.dataset.mIcon = '1';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 19V5.5M6 11.5l6-6 6 6');
    svg.append(path);
    send.replaceChildren(svg);
    send.setAttribute('aria-label', '发送');
    send.setAttribute('title', '发送');
  }

  /** 三个开关型胶囊补上短语：光有图标（地球 / 盾牌 / 画笔）在手机上没人认得。 */
  const CHIP_LABELS = { search: '联网', permission: '权限', draw: '绘图' };

  function decorateControls() {
    const host = document.getElementById('chat-controls');
    if (!host) return;
    for (const btn of host.querySelectorAll('.compose-icon-btn[data-control]')) {
      const label = CHIP_LABELS[btn.dataset.control];
      if (!label || btn.querySelector('.m-ai-chip-label')) continue;
      const span = document.createElement('span');
      span.className = 'm-ai-chip-label';
      span.textContent = label;
      btn.append(span);
    }
    // 没接入模型时上下文圆环与用量就是一个「—」，留着像坏掉的按钮
    for (const wrap of host.querySelectorAll('.compose-select')) {
      const text = String(wrap.textContent ?? '').trim();
      wrap.classList.toggle('m-ai-chip-empty', text === '—');
    }
    if (!host.dataset.mWatch) {
      host.dataset.mWatch = '1';
      // 开关状态变化时 app.js 会整行重画（renderControls），补上的短语要跟着回来
      new MutationObserver(() => decorateControls()).observe(host, { childList: true });
    }
  }

  function buildHead(chat) {
    if (chat.querySelector(':scope > .m-ai-head')) return;
    const { h, iconButton } = window.PCMobileUI;

    subtitle = h('span', { class: 'm-ai-sub', text: '智学助手' });
    const head = h(
      'header',
      { class: 'm-ai-head' },
      h('div', { class: 'm-ai-head-main' }, h('h1', { class: 'm-ai-title', text: 'AI' }), subtitle),
      h(
        'div',
        { class: 'm-ai-actions' },
        iconButton({ icon: 'history', label: '历史对话', onClick: openHistory }),
        iconButton({ icon: 'compose', label: '新对话', onClick: newChat }),
      ),
    );

    chat.prepend(head);
    mirrorBadge();
    paintSendIcon();
    decorateControls();

    // 手机上的占位提示要短：原来那句在 390px 宽会折成三行，把输入区撑得很高
    const input = document.getElementById('chat-input');
    if (input) input.placeholder = '说点什么…';
  }

  /** 外壳切到 AI 标签时调用；重复调用无副作用。 */
  function enter() {
    const chat = document.querySelector('.chat');
    if (!chat) return;
    buildHead(chat);
    paintSendIcon();
    decorateControls();
  }

  window.PCMobileAI = { enter };
})();
