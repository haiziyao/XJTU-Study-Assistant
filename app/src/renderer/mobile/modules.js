/**
 * 「我的」里那些功能的手机页。
 *
 * 旧做法是把桌面视图整块塞进手机外壳（`renderViewInto`）：桌面版的三段式页签、
 * 侧栏工具栏在 390px 宽下会被压成细条，用户点进去看到的就是「另一个应用的缩略图」。
 * 这里为常用功能各写一屏手机页，统一用 `mobile/ui.js` 的组件：
 *   番茄钟 / 通知 / 课表 / 思源学堂 / 学业 / 传输 / 设置。
 * 只读接口原样复用，重活（导入、登录、批量同步的参数）仍然留给电脑端。
 */
(function () {
  'use strict';

  const root = document.documentElement;
  if (!root?.classList?.contains?.('m-app')) return;

  const UI = window.PCMobileUI;
  const Logic = window.PCMobileLogic;
  if (!UI || !Logic) return;

  const { h, icon, iconButton, cell, section, tag, emptyState, errorState, skeleton, button, segmented, iconBadge } = UI;
  const api = (path, options) => window.PC.api(path, options);

  function minutes(sec) {
    return Math.max(0, Math.round((Number(sec) || 0) / 60));
  }

  function mmss(sec) {
    const total = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function pageTitle(title, subtitle) {
    return h(
      'header',
      { class: 'm-page-head' },
      h('h1', { class: 'm-page-title', text: title }),
      subtitle ? h('p', { class: 'm-page-sub', text: subtitle }) : null,
    );
  }

  /* ============================================================ 番茄钟 */

  async function pomodoroPage(host, ctx) {
    host.append(skeleton(4));
    let status = null;
    let timer = null;
    let busy = false;

    const phaseText = () => {
      if (!status) return '正在读取…';
      if (status.phase === 'study') return status.running ? '专注中' : '已暂停';
      if (status.phase === 'break') return status.running ? '休息中' : '休息暂停';
      return '准备开始';
    };

    const remaining = () => {
      if (!status) return 0;
      if (status.running && status.endsAt) {
        const left = (Date.parse(status.endsAt) - Date.now()) / 1000;
        return Math.max(0, Math.min(Number(status.totalSec) || left, left));
      }
      return Math.max(0, Number(status.remainingSec) || 0);
    };

    async function act(path, body) {
      if (busy) return;
      busy = true;
      try {
        status = await api(path, { method: 'POST', body: body ?? {} });
        paint();
      } catch (error) {
        window.PC.toast?.(error?.message ?? '操作失败');
      } finally {
        busy = false;
      }
    }

    function paint() {
      if (!host.isConnected) return;
      const total = Math.max(1, Number(status?.totalSec) || 1);
      const left = remaining();
      const ratio = Math.max(0, Math.min(1, left / total));

      const ring = h(
        'div',
        { class: 'm-pomo-ring' },
        h(
          'div',
          { class: 'm-pomo-inner' },
          h('strong', { class: 'm-pomo-time', text: mmss(left) }),
          h('span', { class: 'm-pomo-phase', text: phaseText() }),
        ),
      );
      ring.style.setProperty('--m-pomo-progress', String(ratio * 360));

      const controls = h('div', { class: 'm-pomo-controls' });
      const idle = !status || (!status.running && status.phase === 'idle');
      if (idle) {
        controls.append(button({ label: '开始专注', icon: 'clock', variant: 'filled', size: 'lg', block: true, onClick: () => act('/pomodoro/start') }));
      } else {
        if (status.running) {
          controls.append(button({ label: '暂停', icon: 'pause', variant: 'tinted', size: 'lg', onClick: () => act('/pomodoro/pause') }));
        } else {
          controls.append(button({ label: '继续', icon: 'clock', variant: 'filled', size: 'lg', onClick: () => act('/pomodoro/resume') }));
        }
        controls.append(button({ label: '结束', icon: 'stop', variant: 'plain', size: 'lg', onClick: () => act('/pomodoro/stop') }));
      }

      const today = status?.today ?? {};
      const stats = section({ header: '今天' });
      stats.list.append(
        cell({ leading: iconBadge('clock', 'red'), title: '专注时长', value: `${minutes(today.studySec)} 分钟`, chevron: false }),
        cell({ leading: iconBadge('checkCircle', 'green'), title: '完成轮次', value: `${Number(today.sessions) || 0} 轮`, chevron: false }),
        cell({ leading: iconBadge('sun', 'orange'), title: '休息时长', value: `${minutes(today.breakSec)} 分钟`, chevron: false }),
      );

      const config = status?.config ?? {};
      const rules = section({ header: '节奏', footer: '在电脑端的番茄钟设置里可以改时长与自动开始。' });
      rules.list.append(
        cell({ title: '专注', value: `${Number(config.studyMin) || 45} 分钟`, chevron: false }),
        cell({ title: '休息', value: `${Number(config.breakMin) || 15} 分钟`, chevron: false }),
        cell({ title: '自动开始下一轮', value: config.autoStartNext ? '开' : '关', chevron: false }),
      );

      const task = status?.taskTitle
        ? section({ header: '本轮任务', children: [cell({ title: status.taskTitle, subtitle: '来自待办', chevron: false })] })
        : null;

      // 注意不能用 replaceChildren(..., null, ...)：null 会被转成文本 “null” 插进页面。
      const blocks = [h('div', { class: 'm-pomo-stage' }, ring, controls)];
      if (task) blocks.push(task);
      blocks.push(stats, rules);
      host.replaceChildren(...blocks);
    }

    try {
      status = await api('/pomodoro/status');
    } catch (error) {
      host.replaceChildren(errorState({ message: error?.message ?? '读取失败', onRetry: () => pomodoroPage(host, ctx) }));
      return;
    }
    if (!host.isConnected) return;
    paint();

    timer = setInterval(() => {
      if (!host.isConnected) {
        clearInterval(timer);
        return;
      }
      if (!status?.running) return;
      const time = host.querySelector('.m-pomo-time');
      const ring = host.querySelector('.m-pomo-ring');
      if (time) time.textContent = mmss(remaining());
      if (ring) ring.style.setProperty('--m-pomo-progress', String((remaining() / Math.max(1, status.totalSec)) * 360));
      if (remaining() <= 0) {
        clearInterval(timer);
        api('/pomodoro/status')
          .then((next) => {
            status = next;
            paint();
          })
          .catch(() => {});
      }
    }, 1000);
  }

  /* ============================================================ 通知 */

  async function notificationsPage(host, ctx) {
    host.append(skeleton(5));
    let items = [];
    let stats = null;
    let syncing = false;

    const syncButton = iconButton({ icon: 'refresh', label: '同步通知', onClick: () => sync() });
    ctx?.setAppbar?.({ title: '通知', back: true, right: syncButton });

    async function sync() {
      if (syncing) return;
      syncing = true;
      syncButton.disabled = true;
      window.PC.toast?.('正在同步…');
      try {
        const res = await api('/notifications/sync', { method: 'POST', body: {} });
        const added = Number(res?.inserted ?? res?.added ?? 0);
        window.PC.toast?.(added ? `新增 ${added} 条通知` : '同步完成');
        await load();
      } catch (error) {
        window.PC.toast?.(error?.message ?? '同步失败');
      } finally {
        syncing = false;
        syncButton.disabled = false;
      }
    }

    async function load() {
      const [list, st] = await Promise.all([
        api('/notifications?limit=60').catch(() => ({ items: [] })),
        api('/notifications/status').catch(() => null),
      ]);
      items = Array.isArray(list?.items) ? list.items : [];
      stats = st?.stats ?? null;
      paint();
    }

    function openReader(item) {
      const body = h('div', { class: 'm-notif-reader' }, h('p', { class: 'm-muted', text: '正在读取正文…' }));
      const view = UI.sheet({ title: item.title || '通知', content: body, cancelLabel: '关闭' });
      api(`/notifications/content?id=${encodeURIComponent(item.id)}`)
        .then((res) => {
          body.replaceChildren();
          const text = String(res?.text ?? '').trim();
          if (text) body.append(h('p', { text }));
          else body.append(h('p', { class: 'm-muted', text: '这条通知没有可读正文，可以在电脑端打开原文。' }));
        })
        .catch((error) => {
          body.replaceChildren(h('p', { class: 'm-muted', text: error?.message ?? '正文读取失败' }));
        });
      return view;
    }

    function paint() {
      if (!host.isConnected) return;
      const head = section({ header: '概况' });
      head.list.append(
        cell({ leading: iconBadge('bell', 'teal'), title: '已收录', value: `${Number(stats?.total) || 0} 条`, chevron: false }),
        cell({ leading: iconBadge('flag', 'orange'), title: '已固定', value: `${Number(stats?.pinned) || 0} 条`, chevron: false }),
        cell({
          leading: iconBadge('clock', 'blue'),
          title: '上次同步',
          value: stats?.lastSyncAt ? Logic.relativeTime(stats.lastSyncAt) : '还没同步',
          chevron: false,
        }),
      );

      host.replaceChildren(head);
      if (!items.length) {
        host.append(
          emptyState({
            icon: 'bell',
            title: '还没有通知',
            message: '点右上角刷新，从教务处、学生处等站点抓取最新公告。',
          }),
        );
        return;
      }

      const list = section({ header: `最近 ${items.length} 条` });
      for (const item of items) {
        const when = item.publishedAt ? Logic.relativeTime(item.publishedAt) : '';
        list.list.append(
          cell({
            title: item.title || '(无标题)',
            subtitle: [item.siteLabel ?? item.siteId ?? '', when].filter(Boolean).join(' · '),
            meta: item.pinned ? tag('已固定', 'orange') : null,
            onClick: () => openReader(item),
          }),
        );
      }
      host.append(list);
    }

    load().catch((error) => {
      host.replaceChildren(errorState({ message: error?.message ?? '读取失败', onRetry: () => notificationsPage(host, ctx) }));
    });
  }

  /* ============================================================ 课表 */

  const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  function weekDaysText(days) {
    if (!Array.isArray(days) || !days.length) return '';
    return days
      .map((day) => `周${WEEK_LABELS[(Number(day) || 1) - 1] ?? day}`)
      .join('、');
  }

  async function timetablePage(host, ctx) {
    host.append(skeleton(4));
    const [status, imported, today] = await Promise.all([
      api('/timetable/status').catch(() => null),
      api('/timetable/imported').catch(() => null),
      api(`/calendar?from=${Logic.todayKey()}&to=${Logic.todayKey()}`).catch(() => null),
    ]);
    if (!host.isConnected) return;

    const courses = Array.isArray(imported?.courses) ? imported.courses : [];
    const todayClasses = (today?.days?.[0]?.imported ?? []).slice();

    const body = h('div');

    const head = section({ header: '概况' });
    head.list.append(
      cell({ leading: iconBadge('calendar', 'purple'), title: '学期', value: [status?.currentTerm, imported?.term].filter(Boolean)[0] || '未选择', chevron: false }),
      cell({ leading: iconBadge('grid', 'indigo'), title: '已导入课程', value: `${courses.length} 门`, chevron: false }),
      cell({ leading: iconBadge('calendar', 'blue'), title: '本周节次', value: `${Number(imported?.total) || 0} 节`, chevron: false }),
    );
    body.append(head);

    if (todayClasses.length) {
      const todayList = section({ header: '今天' });
      for (const item of todayClasses) {
        todayList.list.append(cell({ title: item.title || '课程', subtitle: [item.location, item.startTime].filter(Boolean).join(' · '), chevron: false }));
      }
      body.append(todayList);
    }

    if (!courses.length) {
      body.append(
        emptyState({
          icon: 'grid',
          title: '还没有导入课表',
          message: '在电脑端打开「课表导入」，选好学期导入后，这里和日历都会同步显示。',
        }),
      );
    } else {
      const list = section({ header: `${courses.length} 门课程` });
      for (const course of courses) {
        const periods = Array.isArray(course.periodRange)
          ? `第 ${course.periodRange[0]}–${course.periodRange[1]} 节`
          : '';
        const subtitle = [weekDaysText(course.weekDays), periods, course.weeksText].filter(Boolean).join(' · ');
        list.list.append(
          cell({
            title: course.name || '未命名课程',
            subtitle: subtitle || `${Number(course.count) || 0} 次课`,
            lines: 2,
            chevron: false,
          }),
        );
      }
      body.append(list);
    }

    host.replaceChildren(body);
  }

  /* ============================================================ 思源学堂 */

  async function lmsPage(host, ctx) {
    host.append(skeleton(4));
    const status = await api('/lms/status').catch(() => null);
    const loggedIn = status?.status === 'ready';
    const courses = loggedIn ? await api('/lms/courses').catch(() => null) : null;
    if (!host.isConnected) return;

    const items = Array.isArray(courses?.items) ? courses.items : [];
    const body = h('div');
    const account = section({ header: '账号' });
    account.list.append(
      cell({
        leading: iconBadge(loggedIn ? 'checkCircle' : 'person', loggedIn ? 'green' : 'gray'),
        title: loggedIn ? '已登录' : '未登录',
        subtitle: loggedIn ? status?.user?.name || status?.user?.username || '思源学堂' : '在电脑端的「思源学堂」里登录一次，手机会共用这个会话。',
        lines: 2,
        chevron: false,
      }),
      cell({ leading: iconBadge('grid', 'orange'), title: '已缓存课程', value: `${Number(status?.cache?.courses) || 0} 门`, chevron: false }),
      cell({ leading: iconBadge('list', 'blue'), title: '已同步到日历', value: `${Number(status?.synced?.schedules) || 0} 节`, chevron: false }),
      cell({ leading: iconBadge('checkCircle', 'green'), title: '已同步作业', value: `${Number(status?.synced?.todos) || 0} 条`, chevron: false }),
    );
    body.append(account);

    if (!loggedIn) {
      body.append(
        emptyState({
          icon: 'graduation',
          title: '登录后就能在手机上看课程',
          message: '课堂回放与作业下载仍然建议在电脑上操作；手机上先看课程和待办。',
        }),
      );
    } else if (!items.length) {
      body.append(emptyState({ icon: 'grid', title: '还没有课程缓存', message: '在电脑端刷新一次课程列表。' }));
    } else {
      const list = section({ header: `${items.length} 门课程` });
      for (const course of items) {
        const teacher = course.teacher || course.teacherName || '';
        const term = course.semester?.name || course.term || '';
        list.list.append(
          cell({
            title: course.name || '未命名课程',
            subtitle: [teacher, term].filter(Boolean).join(' · ') || '思源学堂',
            chevron: false,
          }),
        );
      }
      body.append(list);
    }

    host.replaceChildren(body);
  }

  /* ============================================================ 学业 */

  async function academicPage(host, ctx) {
    host.append(skeleton(4));
    const status = await api('/academic/status').catch(() => null);
    if (!host.isConnected) return;

    const loggedIn = Boolean(status?.loggedIn);
    const gpa = status?.gpa;
    const weighted = status?.weightedAverage;
    const credits = status?.totalCredits;
    const total = Number(status?.grades?.total) || 0;

    const stats = h('div', { class: 'm-home-stats m-stats-flat' });
    const tile = (label, value) => h('div', { class: 'm-home-stat' }, h('strong', { class: 'm-home-stat-value', text: value }), h('span', { class: 'm-home-stat-label', text: label }));
    stats.append(
      tile('GPA', gpa == null ? '—' : Number(gpa).toFixed(2)),
      tile('加权', weighted == null ? '—' : Number(weighted).toFixed(1)),
      tile('学分', credits == null ? '—' : String(credits)),
    );

    const body = h('div');
    body.append(stats);

    const account = section({ header: '同步' });
    account.list.append(
      cell({
        leading: iconBadge(loggedIn ? 'checkCircle' : 'person', loggedIn ? 'green' : 'gray'),
        title: loggedIn ? '已登录教务' : '未登录教务',
        subtitle: loggedIn ? '数据来自最近一次同步' : '在电脑端的「学业」里登录并同步一次。',
        lines: 2,
        chevron: false,
      }),
      cell({ leading: iconBadge('chart', 'purple'), title: '成绩记录', value: `${total} 条`, chevron: false }),
      cell({ leading: iconBadge('clock', 'blue'), title: '上次同步', value: status?.lastSyncAt ? Logic.relativeTime(status.lastSyncAt) : '还没同步', chevron: false }),
    );
    body.append(account);

    const terms = Array.isArray(status?.grades?.terms) ? status.grades.terms : [];
    if (terms.length) {
      const list = section({ header: '学期' });
      for (const term of terms) {
        list.list.append(
          cell({
            title: typeof term === 'string' ? term : term.name || term.term || '学期',
            chevron: false,
          }),
        );
      }
      body.append(list);
    } else {
      body.append(
        emptyState({
          icon: 'chart',
          title: loggedIn ? '还没有成绩数据' : '先登录再同步',
          message: loggedIn ? '在电脑端点一次同步，手机上就能看到统计。' : '成绩涉及隐私，手机端只读展示，不保存登录凭据。',
        }),
      );
    }

    host.replaceChildren(body);
  }

  /* ============================================================ 传输 */

  async function transferPage(host, ctx) {
    host.append(skeleton(3));
    let status = await api('/transfer/status').catch(() => null);
    if (!host.isConnected) return;

    async function refreshCode() {
      try {
        await api('/transfer/code', { method: 'POST', body: {} });
        status = await api('/transfer/status');
        paint();
        window.PC.toast?.('已生成新配对码');
      } catch (error) {
        window.PC.toast?.(error?.message ?? '生成失败');
      }
    }

    function paint() {
      if (!host.isConnected) return;
      const code = status?.code?.code ?? '------';
      const leftSec = Math.max(0, Math.round((Number(status?.code?.remainingMs) || 0) / 1000));
      const card = h(
        'div',
        { class: 'm-transfer-card' },
        h('span', { class: 'm-transfer-label', text: '配对码' }),
        h('strong', { class: 'm-transfer-code', text: code }),
        h('span', { class: 'm-transfer-expiry', text: leftSec ? `${Math.ceil(leftSec / 60)} 分钟内有效` : '已过期，点下面换一个' }),
        button({ label: '换一个配对码', icon: 'refresh', variant: 'tinted', size: 'md', block: true, onClick: refreshCode }),
      );

      const device = section({ header: '这台电脑' });
      device.list.append(
        cell({ leading: iconBadge('grid', 'blue'), title: status?.device?.name || '未命名设备', subtitle: status?.device?.platform || '', chevron: false }),
        cell({ leading: iconBadge('globe', status?.listening ? 'green' : 'red'), title: '接收服务', value: status?.listening ? `端口 ${status?.port} 已就绪` : '未启动', chevron: false }),
      );

      const urls = Array.isArray(status?.gateway?.urls) ? status.gateway.urls : [];
      const address = section({ header: '局域网地址', footer: '手机和电脑连同一个 Wi-Fi 时才能打开。' });
      if (urls.length) for (const url of urls.slice(0, 3)) address.list.append(cell({ title: url, chevron: false, onClick: () => window.open?.(url, '_blank') }));
      else address.list.append(cell({ title: '还没有可用地址', subtitle: '确认电脑已连上网络', chevron: false }));

      const peers = Array.isArray(status?.peers) ? status.peers : [];
      const peerSection = section({ header: '附近设备' });
      if (peers.length) {
        for (const peer of peers.slice(0, 6)) {
          peerSection.list.append(cell({ title: peer.name || peer.deviceName || '设备', subtitle: peer.platform || '', chevron: false }));
        }
      } else {
        peerSection.list.append(cell({ title: '没有发现其它设备', subtitle: '在另一台设备上打开传输页，输入上面的配对码。', lines: 2, chevron: false }));
      }

      host.replaceChildren(card, device, address, peerSection);
    }

    paint();
  }

  /* ============================================================ 设置 */

  async function settingsPage(host, ctx) {
    host.append(skeleton(4));
    let username = '';
    try {
      const res = await fetch('/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (res.ok) username = (await res.json())?.user?.username ?? '';
    } catch {
      // 桌面端没有 /auth/me，用本地状态
    }
    if (!host.isConnected) return;

    const mode = window.PCTheme?.getMode?.() ?? 'light';
    const appearance = section({ header: '外观' });
    appearance.list.append(
      cell({
        title: '主题',
        accessory: segmented({
          size: 'sm',
          items: [
            { value: 'system', label: '系统' },
            { value: 'light', label: '白天' },
            { value: 'dark', label: '夜间' },
          ],
          value: mode,
          onChange: (value) => window.PCTheme?.setMode?.(value),
        }),
        chevron: false,
      }),
    );

    const account = section({ header: '账号与服务器' });
    account.list.append(
      cell({ leading: iconBadge('person', 'blue'), title: username || window.PC.state.user?.username || '本机账号', subtitle: '只在这个服务器有效', chevron: false }),
      cell({ leading: iconBadge('globe', 'green'), title: '服务器', value: location.host, chevron: false }),
    );

    const about = section({ header: '关于', footer: '导入课表、登录教务、多端同步这些重活仍建议在电脑端完成。' });
    about.list.append(
      cell({ leading: iconBadge('info', 'gray'), title: '版本', value: '手机外壳 v2', chevron: false }),
    );

    host.replaceChildren(appearance, account, about);
  }

  /* ============================================================ 分发 */

  const PAGES = {
    pomodoro: pomodoroPage,
    notifications: notificationsPage,
    timetable: timetablePage,
    lms: lmsPage,
    academic: academicPage,
    transfer: transferPage,
    settings: settingsPage,
  };

  /**
   * 把某个模块画进 `host`。返回 true 表示这一屏由手机页接管；
   * 没写的模块返回 false，由调用方给一个干净的占位，而不是塞桌面三栏视图。
   */
  function mount(viewId, host, ctx = {}) {
    const render = PAGES[viewId];
    if (!render) {
      host.append(
        emptyState({
          icon: 'info',
          title: '手机版还没有这个页面',
          message: '这个功能需要较大的屏幕，先在电脑端使用。',
        }),
      );
      return false;
    }
    ctx.setAppbar?.({ title: ctx.title || viewId, back: true });
    render(host, ctx).catch((error) => {
      host.replaceChildren(errorState({ message: error?.message ?? '打开失败', onRetry: () => mount(viewId, host, ctx) }));
    });
    return true;
  }

  window.PCMobileModules = { mount, has: (id) => Boolean(PAGES[id]) };
})();
