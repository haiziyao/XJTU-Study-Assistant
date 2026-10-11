/**
 * 前端模块注册表（classic script，无构建步骤）。
 *
 * 视图文件在被加载时调用 `PCModules.register(...)` 自我登记，外壳（shell/app.js）据此
 * 构建左侧功能栏。**新增前端功能 = 新建一个 views/<id>.js + 在 index.html 加一行 script**，
 * 不需要修改外壳代码，也不会和别人的改动冲突。
 *
 * 视图描述符
 * ----------
 *   id       必填。与后端模块 id 保持一致，同时作为导航项、面板标题与 state.view 的键
 *   label    左栏显示名
 *   icon     左栏图标（单字符或 emoji）
 *   order    左栏排序，小者在前（默认 100）
 *   slot     'main'（默认，左栏上部）| 'bottom'（左栏底部，如「设置」）
 *   title    右侧面板标题，缺省等于 label
 *   render({ mount, api, state, toast, refresh })  渲染函数；mount 是已清空的面板容器
 *
 * 同名 id **后注册者覆盖先注册者** —— 这样「规划中的占位页」与「真实实现」可以共存：
 * shell/planned.js 先登记占位，真正的 views/<id>.js 后登记即自动接管。
 *
 * 设置页区块（registerSettingsSection）
 * ----------
 * 模块可以往「设置」视图里加自己的一块 UI，不需要改外壳的设置页代码：
 *   window.PCModules.registerSettingsSection({ id, title, order, render(mount) });
 * 外壳（shell/settings.js）只负责按 order 依次调用 render(mount)，不关心内容。
 *
 * 跨模块能力
 * ----------
 * 视图之间不要直接互相引用，改用 service()/getService()：
 *   window.PCModules.service('editor', openEditor);          // 提供方
 *   window.PCModules.getService('editor')?.({ target: 'schedule' });  // 使用方
 */

window.PCModules = (function () {
  /** @type {Map<string, object>} */
  const views = new Map();
  /** @type {Map<string, unknown>} */
  const services = new Map();
  /** @type {Map<string, object>} 设置页区块，按 order 升序渲染 */
  const sections = new Map();

  return {
    /** 登记一个视图。 */
    register(descriptor) {
      if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id) {
        throw new Error('PCModules.register: id 必填');
      }
      if (typeof descriptor.render !== 'function') {
        throw new Error(`PCModules.register: ${descriptor.id} 缺少 render 函数`);
      }
      views.set(descriptor.id, {
        order: 100,
        slot: 'main',
        ...descriptor,
        title: descriptor.title ?? descriptor.label ?? descriptor.id,
      });
      return descriptor.id;
    },

    get(id) {
      return views.get(id);
    },

    /** 按 order 升序返回全部已登记视图（同 order 按 id 字典序，保证顺序稳定）。 */
    list() {
      return [...views.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    },

    has(id) {
      return views.has(id);
    },

    /**
     * 登记一个设置页区块（模块自带 UI，外壳只负责按顺序摆位置）。
     * @param {object} descriptor
     * @param {string} descriptor.id     唯一 id（如 `calendar.categories`）
     * @param {string} descriptor.title  区块标题
     * @param {number} [descriptor.order] 排序，小者在前（默认 100）
     * @param {(mount: HTMLElement) => void} descriptor.render 渲染函数，mount 是已清空的卡片容器
     */
    registerSettingsSection(descriptor) {
      if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id) {
        throw new Error('PCModules.registerSettingsSection: id 必填');
      }
      if (typeof descriptor.render !== 'function') {
        throw new Error(`PCModules.registerSettingsSection: ${descriptor.id} 缺少 render 函数`);
      }
      sections.set(descriptor.id, { order: 100, ...descriptor });
      return descriptor.id;
    },

    /** 按 order 升序返回全部设置页区块（同 order 按 id 字典序，保证顺序稳定）。 */
    settingsSections() {
      return [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    },

    /** 提供一项跨模块能力。 */
    service(name, value) {
      services.set(name, value);
      return value;
    },

    getService(name) {
      return services.get(name);
    },
  };
})();
