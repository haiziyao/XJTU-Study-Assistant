/**
 * 「设置 → 侧边栏」：自定义左栏的排序与「更多」归属。
 *
 * 为什么放在 shell/ 而不是 views/
 * ----------------------------------
 * 左栏是**外壳自己的**东西（`shell/app.js` 按注册表生成），不属于任何业务模块。
 * 这个文件只做两件事：往「设置」里加一块卡片、弹出那个自定义面板；
 * 真正的重排由外壳通过 `PCModules.getService('sidebar')` 提供 ——
 * 面板不去碰 `state.view` / `state.panelCollapsed`，那会绕过 `syncNavActive()`
 * 那套"高亮 ⇔ 面板可见"的不变式。
 *
 * 交互
 * ----
 * 弹窗分上下两块：拖到上半部 = 常驻左栏，拖到下半部 = 收进「更多」。
 * 拖动用指针事件（鼠标与触摸同一套）；手柄是 `<button>`，**方向键也能挪** ——
 * 既是无障碍要求，也是唯一能在没有真实布局的测试环境里验证的路径。
 * 判定逻辑全在 `PCSidebarLayout`（纯函数、有单测），这里只负责取坐标与套类名。
 */

(function () {
  'use strict';

  /** 两个区的中文名与说明，渲染与提示文案共用一处。 */
  const ZONES = [
    { name: 'main', title: '常驻显示', hint: '拖到这里 = 一直留在左栏' },
    { name: 'more', title: '收进「更多」', hint: '拖到这里 = 收进左栏的「更多」' },
  ];

  /** 视图登记的 emoji 图标 → 内联 SVG；没命中就回退成文本（与左栏同一套）。 */
  function iconNode(icon, size = 18) {
    const node = mk('span', 'sc-icon');
    const svg = window.PCIcons?.svg?.(icon, size);
    if (svg) node.innerHTML = svg;
    else node.textContent = String(icon ?? '');
    return node;
  }

  function rectOf(node) {
    // 测试环境（mini-DOM）没有 getBoundingClientRect；拖动路径本来也走不到那里，
    // 这里退化成全 0 的矩形，保证"取不到几何"时不会抛异常把整个弹窗带崩。
    const rect = node?.getBoundingClientRect?.();
    return rect ? { top: rect.top, bottom: rect.bottom } : { top: 0, bottom: 0 };
  }

  function openDialog(sidebar, trigger) {
    const mask = mk('div', 'modal-mask');
    const box = mk('div', 'modal sc-modal');
    const head = mk('div', 'modal-head');
    const body = mk('div', 'modal-body sc-body');
    const foot = mk('div', 'modal-foot');

    /** 弹窗内的工作副本：所有改动先落这里，再整体交给外壳存盘。 */
    let layout = sidebar.getLayout();
    /** 正在拖的那一项 id（null = 没在拖）。 */
    let dragging = null;

    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      mask.remove();
      trigger?.focus?.();
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') close();
    };

    head.append(mk('div', 'modal-title', '自定义侧边栏'), iconBtn('关闭', '×', close));

    /* ------------------------------------------------------------ 两个分区 */

    const zones = mk('div', 'sc-zones');
    const built = new Map(); // name -> { name, root, list }
    for (const spec of ZONES) {
      const root = mk('div', `sc-zone sc-zone-${spec.name}`);
      root.dataset.zone = spec.name;
      root.append(
        mk('div', 'sc-zone-title', spec.title),
        mk('div', 'sc-zone-hint', spec.hint),
      );
      const list = mk('div', 'sc-list');
      root.appendChild(list);
      zones.appendChild(root);
      built.set(spec.name, { name: spec.name, root, list });
    }

    /* ------------------------------------------- 钉在底部的「设置」（不随滚动） */

    const fixed = mk('div', 'sc-fixed');
    const fixedRow = mk('div', 'sc-row sc-row-fixed');
    const settingsView = sidebar.describe('settings');
    fixedRow.append(
      iconNode(settingsView?.icon ?? '⚙'),
      mk('span', 'sc-label', settingsView?.label ?? '设置'),
      mk('span', 'sc-note', '固定在最下方'),
    );
    fixed.appendChild(fixedRow);

    /* ------------------------------------------------------------------ 渲染 */

    /** 一行 = 图标 + 名字 + 拖动手柄（手柄是按钮，方向键也能挪）。 */
    function rowOf(id) {
      const view = sidebar.describe(id);
      const row = mk('div', 'sc-row');
      row.dataset.id = id;
      row.append(iconNode(view?.icon), mk('span', 'sc-label', view?.label ?? id));

      const handle = mk('button', 'sc-handle');
      handle.type = 'button';
      handle.title = '按住拖动排序（也可以聚焦后用上下方向键）';
      handle.setAttribute('aria-label', `${view?.label ?? id} 拖动排序`);
      handle.append(mk('span', 'sc-grip', '⠿'));
      handle.addEventListener('pointerdown', (event) => startDrag(event, id));
      handle.addEventListener('keydown', (event) => onHandleKeydown(event, id));
      row.appendChild(handle);
      return row;
    }

    function render() {
      for (const spec of ZONES) {
        const slot = built.get(spec.name);
        slot.list.replaceChildren();
        for (const id of layout[spec.name]) slot.list.appendChild(rowOf(id));
        slot.list.dataset.empty = layout[spec.name].length ? '' : '1';
      }
    }

    /** 改一处就立刻生效（外壳重排左栏），不用等「完成」——所见即所得。 */
    function commit(next) {
      layout = next;
      sidebar.apply(layout);
      render();
      // 重画之后原来的手柄已经不在文档里了，把焦点补回同一项，键盘连按才连贯
      focusHandle(dragging ?? document.activeElement?.dataset?.id);
    }

    function focusHandle(id) {
      if (!id) return;
      built.forEach((slot) => {
        const row = slot.list.querySelector?.(`.sc-row[data-id="${id}"]`);
        row?.querySelector?.('.sc-handle')?.focus?.();
      });
    }

    /* -------------------------------------------------------------- 拖动 */

    /** 量出两个区的几何，交给纯函数判定落点。 */
    function measure() {
      return ZONES.map((spec) => {
        const slot = built.get(spec.name);
        const rows = [...slot.list.children]
          // ★ 把正在拖的那一行**排除**：下标是按"剩下的行"算的，
          // 而 move() 也是先摘掉再插入 —— 两边口径一致才不会差一位。
          .filter((row) => row.dataset?.id && row.dataset.id !== dragging)
          .map((row) => ({ id: row.dataset.id, rect: rectOf(row) }));
        return { name: spec.name, rect: rectOf(slot.root), rows };
      });
    }

    function startDrag(event, id) {
      // 手柄是按钮：不拦的话指针事件会被浏览器当成"按住按钮"，进而触发 click
      event.preventDefault?.();
      dragging = id;
      const handle = event.currentTarget;
      // 指针捕获让"拖到窗口外面再松手"也能收到 pointerup（元素自己的 pointerup 会丢）
      try {
        handle?.setPointerCapture?.(event.pointerId);
      } catch {
        /* 不支持捕获就算了：拖到外面松手不会提交，用户再拖一次即可 */
      }
      markDragging(id, true);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    }

    function markDragging(id, on) {
      for (const slot of built.values()) {
        for (const row of slot.list.children) row.classList.toggle('dragging', on && row.dataset?.id === id);
      }
    }

    function clearDropMarks() {
      for (const slot of built.values()) {
        for (const row of slot.list.children) row.classList.remove('drop-before', 'drop-after');
        slot.root.classList.remove('drop-into');
      }
    }

    function onPointerMove(event) {
      if (!dragging) return;
      event.preventDefault?.();
      const hit = window.PCSidebarLayout.dropTarget({ pointerY: event.clientY, zones: measure() });
      clearDropMarks();
      if (!hit) return;
      const slot = built.get(hit.zone);
      slot.root.classList.add('drop-into');
      const rows = [...slot.list.children].filter((row) => row.dataset?.id !== dragging);
      const at = rows[hit.index];
      if (at) at.classList.add('drop-before');
      else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
    }

    function onPointerUp(event) {
      if (!dragging) return finishDrag();
      const id = dragging;
      const hit = window.PCSidebarLayout.dropTarget({ pointerY: event.clientY, zones: measure() });
      finishDrag();
      // 落在两区之外 = 什么都不做（拖歪了不该有副作用）
      if (hit) commit(window.PCSidebarLayout.move(layout, id, hit.zone, hit.index));
    }

    function onPointerCancel() {
      finishDrag();
    }

    function finishDrag() {
      markDragging(dragging, false);
      clearDropMarks();
      dragging = null;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
    }

    /* ------------------------------------------------------------ 键盘移动 */

    /**
     * 方向键在手柄上挪动整行：区内上下移动，到边界再按一次就**跨区**。
     *
     * `move()` 的口径是"先摘掉、再插到第 index 位"，所以区内下移的目标下标是
     * `i + 1`（摘掉自己之后正好落在原位置的后一位），上移是 `i - 1`。
     */
    function onHandleKeydown(event, id) {
      const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (!delta) return;
      event.preventDefault?.();
      const inMain = layout.main.includes(id);
      const zone = inMain ? 'main' : 'more';
      const list = layout[zone];
      const i = list.indexOf(id);
      const j = i + delta;
      if (j >= 0 && j < list.length) {
        commit(window.PCSidebarLayout.move(layout, id, zone, j));
        return;
      }
      // 跨区：往上顶出 main 顶部 → 挪到 more 末尾；往下顶出 more 底部 → 挪到 main 末尾
      if (delta < 0 && zone === 'more') commit(window.PCSidebarLayout.move(layout, id, 'main', layout.main.length));
      else if (delta > 0 && zone === 'main') commit(window.PCSidebarLayout.move(layout, id, 'more', 0));
    }

    /* ---------------------------------------------------------------- 组装 */

    const desc = mk(
      'div',
      'sc-desc',
      '按住行右侧的手柄拖动：拖到上半部常驻显示，拖到下半部收进「更多」。也可以聚焦手柄后用上下方向键移动。',
    );

    const reset = mk('button', 'ghost-btn', '恢复默认');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      sidebar.reset();
      layout = sidebar.getLayout();
      render();
    });

    const done = mk('button', 'primary-btn', '完成');
    done.type = 'button';
    done.addEventListener('click', close);

    body.append(desc, zones, fixed);
    foot.append(reset, mk('span', 'spacer'), done);
    box.append(head, body, foot);
    mask.appendChild(box);
    // 点遮罩关闭（点弹窗本体不关）——与 notes/calendar 的弹层同一套手感
    mask.addEventListener('click', (event) => {
      if (event.target === mask) close();
    });
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKeydown);
    render();
  }

  /* -------------------------------------------------------------- 设置卡片 */

  function renderCard(mount) {
    if (!window.PCModules.getService?.('sidebar')) {
      mount.appendChild(mk('div', 'sc-desc', '左栏还在初始化，稍后重新打开这一页即可自定义。'));
      return;
    }
    const sidebar = window.PCModules.getService('sidebar');

    mount.appendChild(
      mk(
        'div',
        'sc-desc',
        '左栏的图标顺序、以及哪些收进「更多」，都由你决定。设置页里这块只管"看得见的排布"，不影响任何功能本身。',
      ),
    );

    const actions = mk('div', 'sc-actions');
    const open = mk('button', 'primary-btn', '自定义侧边栏');
    open.type = 'button';
    open.addEventListener('click', () => openDialog(sidebar, open));

    const reset = mk('button', 'ghost-btn', '恢复默认');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      sidebar.reset();
      window.PC?.toast?.('左栏已恢复默认排布');
    });

    actions.append(open, reset);
    mount.appendChild(actions);

    // 当前排布的一句话摘要：不打开弹窗也能看出"有没有被改过"
    const layout = sidebar.getLayout();
    const summary = mk('div', 'sc-summary');
    summary.textContent = layout.more.length
      ? `常驻 ${layout.main.length} 项 · 「更多」里 ${layout.more.length} 项（${layout.more.map((id) => sidebar.describe(id)?.label ?? id).join('、')}）`
      : '当前全部常驻，没有收进「更多」的项。';
    mount.appendChild(summary);
  }

  window.PCModules.registerSettingsSection({
    id: 'shell.sidebar',
    title: '侧边栏',
    // 排在中间偏前：它调的是"看得见的排布"，比 AI 接入/账号那些配置更常被翻到
    order: 20,
    render: renderCard,
  });
})();
