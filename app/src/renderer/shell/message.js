/**
 * 「消息」视图：指令记录（GET /commands/logs）。
 *
 * 属于外壳自带视图而非某个业务模块 —— 指令日志是框架级能力。
 */

(function () {
const messageView = {
  title: '消息',

  render(ctx) {
    ctx.mount.innerHTML = '';
    const bar = mk('div', 'toolbar');
    bar.append(
      mk('div', 'toolbar-title', '指令记录'),
      mk('div', 'spacer'),
      (() => {
        const button = mk('button', 'ghost-btn', '刷新');
        button.type = 'button';
        button.addEventListener('click', () => PC.refresh());
        return button;
      })(),
    );
    ctx.mount.appendChild(bar);

    const list = mk('div', 'log-list');
    ctx.mount.appendChild(list);
    PC.api('/commands/logs?limit=50')
      .then(({ items }) => {
        if (!items?.length) {
          list.appendChild(emptyBox('还没有指令记录。在中间的对话里发一条试试。'));
          return;
        }
        for (const item of [...items].reverse()) {
          const row = mk('div', `log-row${item.ok === false ? ' failed' : ''}`);
          const head = mk('div', 'lr-head');
          head.append(
            mk('span', 'lr-action', `${ACTION_LABEL[item.action] ?? item.action}${TARGET_LABEL[item.target] ?? ''}`),
            mk('span', 'lr-source', item.source ?? 'rules'),
            mk('span', 'lr-time', item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''),
          );
          row.append(head, mk('div', 'lr-text', item.text || '（空）'));
          row.appendChild(
            mk(
              'div',
              'lr-meta',
              `影响 ${item.affectedCount ?? 0} 条${item.confidence !== null && item.confidence !== undefined ? ` · 置信度 ${item.confidence}` : ''}`,
            ),
          );
          list.appendChild(row);
        }
      })
      .catch((error) => list.appendChild(errorBox(error)));
  },
};

window.PCModules.register({
  id: 'message',
  label: '消息',
  icon: '✉',
  order: 70,
  title: messageView.title,
  render: (ctx) => messageView.render(ctx),
});
})();
