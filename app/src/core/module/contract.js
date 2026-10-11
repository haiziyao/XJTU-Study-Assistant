/**
 * 模块契约（Module Contract）。
 *
 * 一个功能 = `src/modules/<id>/` 下的一个目录，唯一入口是该目录的 `module.js`，
 * 默认导出本文件描述的「模块描述符」。框架（src/core + src/server）只认识描述符，
 * 不认识任何具体模块，因此**新增功能不需要修改框架代码**。
 *
 * 描述符字段
 * ----------
 *   id            必填。小写字母/数字/连字符。同时用作：路由前缀、数据集合归属、
 *                 前端视图 id、WebSocket payload 的 module 字段、测试文件名前缀。
 *   title         必填。展示名。
 *   order         装配顺序，小者先，默认 100。
 *                 跨模块依赖靠它排序：被依赖的模块 order 必须更小
 *                 （例：lms(20) 要写日程，所以必须排在 calendar(10) 之后）。
 *   collections   声明式数据集合，由 JsonStore 自动创建并挂到 `store[collection.name]`：
 *                   [{ name: 'events', file: 'events.json', indexes: [] }]
 *                 name 必填且全局唯一；file 缺省为 kebab-case(name) + '.json'。
 *
 *   createServices(ctx)      返回本模块的服务对象，会被合并进全局 `services`。
 *   restore(ctx)             async；在 `listen()` 之前调用（恢复登录态 / 预热缓存）。
 *   start(ctx)               在 `listen()` 成功后调用（启动定时器 / 订阅）。
 *   stop(ctx)                在 `close()` 时调用（清理定时器）。
 *   registerRoutes(router, ctx)  注册本模块的路由，约定前缀 `${API_PREFIX}/<id>`。
 *   commands                 对话指令扩展点（见 core/commands/command-service.js）。
 *   aiTools                  暴露给 AI Agent 的工具清单，会被聚合进 GET /ai/capabilities。
 *
 * 数据边界（重要）
 * ----------------
 * - **写**别人的数据，必须走对方的服务（例如 lms 同步时调用 `services.schedules.create`），
 *   这样校验、广播、指令日志等副作用不会被绕过。
 * - **读**别人的数据可以直接访问集合（例如 `store.schedules.all()`），代价是要接受对方
 *   的字段约定；若依赖关系较重，请提升为对方服务上的只读方法。
 * - 模块私有文件（会话密钥等）放 `ctx.dataDir`，自行控制权限（如 0600），不要塞进 JsonStore
 *   —— JsonStore 的集合是 0644 的业务数据，语义不同。
 *
 * 各钩子收到的 ctx
 * ----------------
 *   store       JsonStore 实例
 *   broadcast   (message) => void，WebSocket 广播（payload 建议带 module: id）
 *   services    全局服务表（含框架服务与**已经装配好的**其它模块的服务）
 *   own         本模块 createServices 的返回值（createServices 自身收不到）
 *   dataDir     数据目录绝对路径（模块私有文件，如会话密钥，放这里）
 *   options     createServer({ [id]: {...} }) 传入的本模块配置切片
 *   module      本模块的（已规范化的）描述符
 */

/** 契约版本：字段语义变更时递增，便于第三方模块判断兼容性。 */
export const MODULE_API_VERSION = '1.0.0';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const COLLECTION_RE = /^[a-z][A-Za-z0-9]*$/;

/** 模块描述符不合法时抛出，错误信息直接指出是哪个模块的哪个字段。 */
export class ModuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModuleError';
  }
}

const assert = (condition, message) => {
  if (!condition) throw new ModuleError(message);
};

const HOOKS = ['createServices', 'registerRoutes', 'restore', 'start', 'stop'];

/** `lmsCourses` -> `lms-courses`（集合未显式给 file 时的默认文件名）。 */
export function kebabCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * 规范化并校验模块描述符。
 * @param {object} descriptor `module.js` 的默认导出
 * @param {{ sourceDir?: string }} [meta]
 */
export function defineModule(descriptor, { sourceDir } = {}) {
  assert(descriptor && typeof descriptor === 'object', '模块描述符必须是对象（module.js 要有 export default {...}）');

  const { id, title } = descriptor;
  assert(
    typeof id === 'string' && ID_RE.test(id),
    `模块 id 不合法：${JSON.stringify(id)}（要求 ${ID_RE}，例如 "calendar"、"lms"）`,
  );
  assert(typeof title === 'string' && title.trim() !== '', `模块 ${id} 缺少 title`);

  const order = descriptor.order === undefined ? 100 : Number(descriptor.order);
  assert(Number.isFinite(order), `模块 ${id} 的 order 必须是数字`);

  for (const hook of HOOKS) {
    assert(
      descriptor[hook] === undefined || typeof descriptor[hook] === 'function',
      `模块 ${id} 的 ${hook} 必须是函数`,
    );
  }

  assert(descriptor.aiTools === undefined || Array.isArray(descriptor.aiTools), `模块 ${id} 的 aiTools 必须是数组`);

  const specs = descriptor.collections ?? [];
  assert(Array.isArray(specs), `模块 ${id} 的 collections 必须是数组`);
  const seen = new Set();
  const collections = specs.map((spec) => {
    assert(spec && typeof spec === 'object', `模块 ${id} 的 collections 项必须是对象`);
    const { name, file, indexes } = spec;
    assert(
      typeof name === 'string' && COLLECTION_RE.test(name),
      `模块 ${id} 的集合名不合法：${JSON.stringify(name)}（要求 ${COLLECTION_RE}，例如 "lmsCourses"）`,
    );
    assert(!seen.has(name), `模块 ${id} 重复声明了集合 ${name}`);
    seen.add(name);
    assert(file === undefined || typeof file === 'string', `模块 ${id} 的集合 ${name} 的 file 必须是字符串`);
    assert(indexes === undefined || Array.isArray(indexes), `模块 ${id} 的集合 ${name} 的 indexes 必须是数组`);
    return { name, file: file ?? `${kebabCase(name)}.json`, indexes: indexes ?? [], module: id };
  });

  assert(
    descriptor.ui === undefined,
    `模块 ${id}：前端视图请在 src/renderer/views/ 下用 PCModules.register 登记，不要写进后端描述符`,
  );

  return { ...descriptor, apiVersion: MODULE_API_VERSION, id, title, order, collections, sourceDir };
}
