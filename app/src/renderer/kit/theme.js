/** Appearance preferences shared by the shell and the standalone note editor. */
(function () {
  'use strict';
  const KEY = 'zhixue.appearance';
  const MODES = ['system', 'light', 'dark'];
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  let mode = 'system';
  try {
    const saved = window.localStorage?.getItem(KEY);
    if (MODES.includes(saved)) mode = saved;
  } catch { /* Appearance still works when storage is unavailable. */ }

  function resolved() { return mode === 'system' ? (media?.matches ? 'dark' : 'light') : mode; }
  function apply() {
    const theme = resolved();
    document.documentElement?.setAttribute?.('data-theme', theme);
    const button = document.getElementById('theme-toggle');
    if (button) {
      const label = theme === 'light' ? '☾ 夜间模式' : '☀ 白天模式';
      button.textContent = button.dataset?.compact === 'true' ? (theme === 'light' ? '☾' : '☀') : label;
      button.title = `当前为${theme === 'light' ? '白天' : '夜间'}模式，点击切换`;
      button.setAttribute('aria-label', label);
    }
    const select = document.getElementById('appearance-mode');
    if (select) select.value = mode;
    const editorSelect = document.getElementById('editor-appearance');
    if (editorSelect) editorSelect.value = mode;
  }
  function setMode(value) {
    if (!MODES.includes(value)) return;
    mode = value;
    try { window.localStorage?.setItem(KEY, mode); } catch { /* Optional preference. */ }
    apply();
  }
  window.PCTheme = { apply, setMode, resolved, getMode: () => mode, toggle: () => setMode(resolved() === 'light' ? 'dark' : 'light') };
  apply(); // Apply before CSS/first paint to avoid a flash of the wrong theme.
  media?.addEventListener?.('change', () => { if (mode === 'system') apply(); });
  window.addEventListener?.('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    mode = MODES.includes(event.newValue) ? event.newValue : 'system';
    apply();
  });

  function install() {
    document.getElementById('theme-toggle')?.addEventListener('click', window.PCTheme.toggle);
    document.getElementById('editor-appearance')?.addEventListener('change', (event) => setMode(event.target.value));
    window.PCModules?.registerSettingsSection({
      id: 'appearance', title: '外观', order: 1, position: 'top',
      render(mount) {
        const label = document.createElement('label');
        label.className = 'appearance-setting';
        const text = document.createElement('span'); text.textContent = '颜色模式';
        const select = document.createElement('select');
        select.id = 'appearance-mode'; select.setAttribute('aria-label', '颜色模式');
        for (const [value, name] of [['system', '跟随系统'], ['light', '白天模式'], ['dark', '夜间模式']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = name;
          select.appendChild(option);
        }
        select.value = mode; select.addEventListener('change', () => setMode(select.value));
        label.append(text, select); mount.appendChild(label);
        const hint = document.createElement('p'); hint.className = 'appearance-hint';
        hint.textContent = '记住你的选择，笔记编辑页也会使用同一配色。'; mount.appendChild(hint);
      },
    });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
