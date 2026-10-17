/**
 * 同步集合目录：**同步哪些集合、每个集合怎么读、怎么写、能不能同步删除**。
 *
 * 一句话：这份目录是"同步范围"的唯一出处 —— 接口 `/sync/status` 的集合清单、
 * push/pull 的实际搬运、面板上的条数与"该集合不支持删除同步"都读它。
 *
 * 三件必须写清楚的事
 * ------------------
 * 1. **写别人的数据走哪条路**。契约（core/module/contract.js）要求"写别人的数据必须走对方
 *    模块自己的服务"。同步在这里有一个绕不开的矛盾：**同步必须保留 id**（id 就是合并键，
 *    理由见 merge.js 顶部），而现有各模块的 `create()` 一律不接受外部指定的 id
 *    （id 由集合层生成）。于是分两类处理：
 *      - **有"就地改"入口的**：能走服务就走服务。`ai-config` 走 `ai.updateConfig()`
 *        （校验 + 落盘 + 重新注册 provider 一步不少）；`lms-credentials` 落的是
 *        `auth-session.json`（凭据文件），写完调 `auth.restore()` 让 auth 模块自己把罐子换过来；
 *      - **其余集合**：直接按 id 写 JsonStore。这里**不是**图省事：模块服务没有
 *        "按 id upsert"的入口，绕过去用 `create()` 只会把同一条记录复制成两份（幂等就没了）。
 *        代价（如实记在 README 与报告里）：模块自己的字段校验/派生字段不会跑一遍。
 *        所以写入一律走 `project()` 的**内容投影**（只搬内容字段，不搬 id/createdAt/updatedAt），
 *        并且写完广播一次 `data_changed`，让页面与各视图像收到模块自己的广播一样刷新。
 * 2. **删除**。只有 `notes` 有软删除（`deletedAt`，见 notes/service.js 的 `remove()`）。
 *    它的删除**随记录本身一起同步**：软删的笔记照样在集合里，`deletedAt` 一推过去，
 *    另一侧列表里就没了、进回收站 —— 这就是"删除能同步"。
 *    其余集合的删除是**硬删除**（记录直接消失），本机无法区分"被删了"与"从未同步过"，
 *    所以**不支持删除同步**（`deleteSync: 'none'`，面板与报告如实标注）。
 *    口径是"不要去改别的模块的删除语义"，所以同步**不会**给它们发明 tombstone 字段。
 * 3. **不同步的**：`academic-*`（成绩/学业）、`lms-*`（学堂课程/活动/元信息）、
 *    传输日志、`account.json`、`ai-usage`。它们**不在这份目录里**，因此也不可能出现在
 *    push/pull 的 body 里（`test/sync.test.js` 有断言：push 出去的 JSON 里不含这些名字）。
 */

import path from 'node:path';

import { COLLECTIONS as TRANSFER_COLLECTIONS } from '../transfer/catalog.js';
import { normalizeName } from './merge.js';
import { PrivateJsonFile, exists } from './private-file.js';

/** 由集合层自己维护、不属于"内容"的字段（指纹与落库时按各自口径处理）。 */
export const VOLATILE_FIELDS = Object.freeze(['id', 'createdAt', 'updatedAt']);

/**
 * 内容投影（**传输用的形状**）：`id` 保留，`createdAt`/`updatedAt` 去掉，其余字段原样搬。
 *
 * 为什么保留 `id`：协议里"按 id 合并"是硬要求（`checkPullShape` 会拒绝没有 id 的记录），
 * 而且 id 就是"同一条记录"的身份。指纹计算时再单独把 id 剔掉（见 `merge.contentHash`）——
 * 传输需要 id，判等不需要 id，两者分开。
 *
 * 为什么是"减法"而不是像直传那样逐个字段列白名单：同步的是**同一个人在另一台设备上的
 * 同一份数据**（不是导入到别人数据里），少搬一个字段（比如笔记的 `ocr`、消息的
 * `usage`）就是那台设备上永久缺一块。白名单每加一个新字段都要回来改，
 * 迟早漏。减法只挡"换台机器就该重新算"的两个时间戳。
 */
export function project(record) {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    out[key] = value;
  }
  return out;
}

/** 软删除判定（只有 notes 有 `deletedAt`）。 */
export const isAlive = (record) => !record?.deletedAt;

/** 复用传输模块的 duplicateKey/title：同一个"同名"口径，不另发明一套。 */
const fromTransfer = (name) => TRANSFER_COLLECTIONS[name] ?? {};
const transferKey = (name) => fromTransfer(name).duplicateKey ?? null;
const transferTitle = (name) => fromTransfer(name).title ?? ((item) => item?.id ?? '（没有标题）');

/**
 * 同步集合清单（顺序 = 面板上的显示顺序 = push body 里的键顺序）。
 *
 * 字段：
 *   name        协议里的集合名（前后端/手机共用这一套名字）
 *   label       中文名（面板、报告）
 *   module      广播 `data_changed` 时用的模块 id（让对应视图刷新）
 *   store       JsonStore 集合名（`kind: 'collection'`）
 *   file        私有 JSON 文件名（`kind: 'file'`，单例）
 *   kind        'collection' | 'file'
 *   secret      `null` | 'aiConfig' | 'lms' —— 敏感集合必须由**每台设备各自**在非网页客户端
 *               里勾选后才参与 push/pull（见 service.js 的 settings）
 *   deleteSync  'soft'（软删除随记录同步）| 'none'（不支持删除同步）| 'file'（单例，没有删除概念）
 *   duplicateKey 「同名」判定（不同 id 同内容/同名 → 两条都留 + 疑似重复清单）
 *   title       结果明细里怎么称呼这条记录
 */
export const SYNC_COLLECTIONS = Object.freeze([
  {
    name: 'notes',
    label: '笔记',
    module: 'notes',
    store: 'notes',
    kind: 'collection',
    secret: null,
    // 唯一支持删除同步的集合：软删除（回收站）本身就是记录上的一个字段
    deleteSync: 'soft',
    duplicateKey: transferKey('notes'),
    title: transferTitle('notes'),
    live: isAlive,
  },
  { name: 'todos', label: '待办', module: 'calendar', store: 'todos', kind: 'collection', secret: null, deleteSync: 'none', duplicateKey: transferKey('todos'), title: transferTitle('todos') },
  { name: 'schedules', label: '日程', module: 'calendar', store: 'schedules', kind: 'collection', secret: null, deleteSync: 'none', duplicateKey: transferKey('schedules'), title: transferTitle('schedules') },
  { name: 'events', label: '事件', module: 'calendar', store: 'events', kind: 'collection', secret: null, deleteSync: 'none', duplicateKey: transferKey('events'), title: transferTitle('events') },
  { name: 'memories', label: '记忆', module: 'memory', store: 'memories', kind: 'collection', secret: null, deleteSync: 'none', duplicateKey: transferKey('memories'), title: transferTitle('memories') },
  { name: 'ai-conversations', label: 'AI 对话', module: 'ai', store: 'aiConversations', kind: 'collection', secret: null, deleteSync: 'none', duplicateKey: transferKey('conversations'), title: transferTitle('conversations') },
  {
    name: 'ai-messages',
    label: 'AI 消息',
    module: 'ai',
    store: 'aiMessages',
    kind: 'collection',
    secret: null,
    deleteSync: 'none',
    // 消息不判"同名"：同一句话问两遍是完全正常的用法（直传同样不做）
    duplicateKey: null,
    title: (item) => String(item?.content ?? '').slice(0, 40) || item?.id || '（空消息）',
  },
  {
    name: 'ai-schedules',
    label: '定时唤醒',
    module: 'ai',
    store: 'aiSchedules',
    kind: 'collection',
    secret: null,
    deleteSync: 'none',
    // 同一个提示词的定时任务建两次，基本可以肯定是重复（`at` 时间不同则保留，见 key）
    duplicateKey: (item) => `${normalizeName(item?.prompt)}@${item?.at ?? ''}`,
    title: (item) => item?.label || String(item?.prompt ?? '').slice(0, 40) || item?.id,
  },
  {
    name: 'ai-config',
    label: 'AI 配置与密钥',
    module: 'ai',
    file: 'ai-config.json',
    kind: 'file',
    // ★ 敏感：默认不同步，只能在非网页客户端里逐台勾选
    secret: 'aiConfig',
    deleteSync: 'file',
    /** 密钥字段：冲突只报"哪个字段不一样"，**绝不回报值**（见 merge.js 的 redactSecrets）。 */
    secretFields: ['apiKey', 'searchApiKey', 'searchApiKeys'],
    title: () => 'AI 配置',
  },
  {
    name: 'lms-credentials',
    label: '学堂登录凭据',
    module: 'auth',
    file: 'auth-session.json',
    kind: 'file',
    // ★ 敏感：默认不同步，只能在非网页客户端里逐台勾选
    secret: 'lms',
    deleteSync: 'file',
    secretFields: ['cookies'],
    title: () => '学堂登录凭据',
  },
]);

/** 名字 → 目录项；未知集合返回 null。 */
export function entryOf(name) {
  return SYNC_COLLECTIONS.find((item) => item.name === String(name ?? '')) ?? null;
}

/** 全部同步集合名。 */
export const SYNC_NAMES = SYNC_COLLECTIONS.map((item) => item.name);

/** 敏感集合名 → 开关名（`{aiConfig: ['ai-config'], lms: ['lms-credentials']}`）。 */
export function secretNames() {
  const out = { aiConfig: [], lms: [] };
  for (const entry of SYNC_COLLECTIONS) if (entry.secret) out[entry.secret].push(entry.name);
  return out;
}

/** 本次同步实际参与的集合（按本机开关裁剪；`syncSecrets` 缺省两项都 false）。 */
export function enabledEntries(syncSecrets = {}) {
  return SYNC_COLLECTIONS.filter((entry) => !entry.secret || syncSecrets?.[entry.secret] === true);
}

/* ================================================================ 读 */

/** 读一个集合的全部记录（`store.<name>.all()` 的只读副本；集合不存在时回空数组）。 */
export function allOf(store, entry) {
  const collection = store?.[entry.store];
  return typeof collection?.all === 'function' ? collection.all() : [];
}

/** 读单个集合的本地记录（`{count, maxUpdatedAt}`，面板用）。 */
export function statsOf(store, entry) {
  const items = allOf(store, entry);
  let maxUpdatedAt = null;
  for (const item of items) {
    const value = item?.updatedAt ?? item?.createdAt ?? null;
    if (value && (!maxUpdatedAt || String(value) > String(maxUpdatedAt))) maxUpdatedAt = value;
  }
  return { count: items.length, maxUpdatedAt };
}

/**
 * 单例文件（`ai-config.json` / `auth-session.json`）读出来变成"一条记录"。
 *
 * 为什么把单例也塞进 `collections: {<name>: [items]}` 这个数组形状：
 * 协议只有这一种形状，为一个单例再发明一套 `singleton: {...}` 会让手机端、
 * 服务端两处都要写分支；数组里恒有 0 或 1 条，处理逻辑一条都不用特判。
 */
export async function readFileEntry(ctx, entry) {
  const single = await readSingleton(ctx, entry);
  return single.record ? [single.record] : [];
}

/**
 * 读单例：返回 `{record, fileExists}`。
 *
 * `fileExists` 单独给出来，是因为**"从没配过"和"配过但都是默认值"必须分得开**：
 * 前者可以整份采用远端配置（换新设备的主路径），后者只能填空白（不能悄悄改掉用户填过的东西）。
 * `record` 里的这个字段是给接收侧看的元信息，写回去之前会被 `planSingletonMerge` 剔掉。
 */
export async function readSingleton({ dataDir, services }, entry) {
  if (entry.name === 'ai-config') {
    // 走 ai 模块自己的配置对象：它已经合并了"环境变量 / 磁盘 / 显式配置"三层，
    // 而且**含 apiKey 原值**（页面拿不到，但同步必须能搬它）
    const config = services?.ai?.config;
    if (!config?.get) return { record: null, fileExists: false };
    const fileExists = await exists(path.join(dataDir, entry.file));
    return { record: { id: entry.name, ...(config.get() ?? {}), __fileExists: fileExists }, fileExists };
  }
  if (entry.name === 'lms-credentials') {
    const file = new PrivateJsonFile(path.join(dataDir, entry.file));
    const saved = await file.read();
    return { record: saved ? { id: entry.name, ...saved } : null, fileExists: Boolean(saved) };
  }
  return { record: null, fileExists: false };
}

/* ================================================================ 写 */

/**
 * 写单例：能走模块自己的入口就走（校验/落盘/广播都归它）。
 *
 *   - `ai-config` → `services.ai.updateConfig(patch)`：它会 `assertAiConfigInput`、
 *     归一化、写 `ai-config.json`（0600）、重新注册 provider、广播 `data_changed`；
 *   - `lms-credentials` → 直接落 `auth-session.json`（凭据文件没有"导入"入口），
 *     写完立刻调 `auth.restore()` 让 auth 模块自己把握在手里的 Cookie 罐换成新的 ——
 *     这样"同步完学堂凭据，这台设备就能用了"是真的成立，而不是只写了个文件。
 */
export async function writeSingleton(ctx, entry, patch, { local = null } = {}) {
  if (entry.name === 'ai-config') {
    const ai = ctx.services?.ai;
    if (typeof ai?.updateConfig !== 'function') throw new Error('ai 模块不可用，无法写入 AI 配置');
    await ai.updateConfig(patch);
    return;
  }
  if (entry.name === 'lms-credentials') {
    const auth = ctx.services?.auth;
    const next = { ...(local ?? {}), ...patch };
    delete next.id;
    delete next.__fileExists;
    if (!next.savedAt) next.savedAt = new Date().toISOString();
    const file = new PrivateJsonFile(path.join(ctx.dataDir, entry.file));
    await file.write(next);
    // 让 auth 模块重新读一遍：它自己决定这份票据还有没有效（过期会按它自己的口径删掉）
    if (typeof auth?.restore === 'function') await auth.restore();
    else throw new Error('auth 模块不可用，无法应用学堂凭据');
    ctx.broadcast?.({ type: 'data_changed', module: 'auth', payload: { target: entry.name, reason: 'sync' } });
    return;
  }
  throw new Error(`${entry.name} 没有写入入口`);
}

/** 按 id upsert 一条集合记录（内容投影 + 保留 id；时间戳由集合层按自己的口径写）。 */
async function upsertCollection({ store, broadcast }, entry, id, projected) {
  const collection = store?.[entry.store];
  if (typeof collection?.get !== 'function') throw new Error(`集合 ${entry.store} 不可用`);
  const existed = Boolean(collection.get(id));
  if (existed) await collection.update(id, projected);
  else await collection.insert({ ...projected, id });
  // 写完广播一次：页面/视图像收到模块自己的广播一样重新拉数据（我们绕过了模块服务，
  // 它不会替我们广播 —— 不广播的话，用户要手动切页才能看到同步来的数据）
  broadcast?.({ type: 'data_changed', module: entry.module, payload: { target: entry.name, reason: 'sync', ids: [id] } });
  return { id, created: !existed };
}

/**
 * 落一条远端记录。
 *
 * @param {object} ctx  `{store, broadcast, dataDir, services}`
 * @param {object} entry 目录项
 * @param {string} id    要落的 id（新增/更新都用它；冲突副本用 `<原id>-h<指纹>`）
 * @param {object} projected 远端的内容投影（`project(record)` 的结果）
 */
export async function writeRecord(ctx, entry, id, projected) {
  if (entry.kind === 'collection') return upsertCollection(ctx, entry, id, projected);
  throw new Error(`${entry.name} 是单例集合，必须走 applySingleton`);
}

/**
 * 删一条（只有 `deleted` 显式清单会走到这里；本机自己不会主动删）。
 *
 * 为什么只允许 `notes`：它的删除是**软删除**（`notes.remove()` 把记录移进回收站），
 * 语义与"同步删除"完全一致，而且**走的还是 notes 模块自己的入口**。
 * 其余集合的 `remove()` 是硬删除：本机无法区分"对面删了"和"对面从来没有过"，
 * 按照口径不为它们发明 tombstone，所以这里**拒绝**执行并在报告里如实说明。
 */
export async function removeRecord({ services }, entry, id) {
  if (entry.deleteSync !== 'soft') return { removed: false, reason: 'unsupported' };
  const notes = services?.notes;
  if (typeof notes?.remove !== 'function') return { removed: false, reason: 'no-service' };
  await notes.remove(id);
  return { removed: true };
}

/**
 * 单例合并：**填空白，绝不覆盖本机已有的非空值**。
 *
 * 为什么不用"谁新用谁"：ai-config 里是 API key 与端点地址，学堂凭据里是学校票据 ——
 * 覆盖错一次，用户面对的是"AI 突然不能用/学堂突然掉线"，而且看不出是谁改的。
 * 所以规则只有三条：
 *   1. 远端有值、本机为空 → 采用（这是"换台新设备把配置带过去"的主路径）；
 *   2. 两边一致 → 什么都不做；
 *   3. 两边都有值但不同 → **保留本机值**，把**字段名**列进冲突清单让用户自己决定
 *      （值一律不回报，见 `secretFields` 与 `redactSecrets`）。
 * 本机连配置文件都没有（`fileExists === false`）→ 整份采用：没有任何东西会被覆盖。
 *
 * @returns {{patch:object, adopted:string[], conflicts:string[], unchanged:string[], wholesale:boolean}}
 */
export function planSingletonMerge({ local, incoming, fileExists = false, secretFields = [] } = {}) {
  const source = incoming ?? {};
  const patch = {};
  const adopted = [];
  const conflicts = [];
  const unchanged = [];
  // `__fileExists` 是本模块自己贴的元信息，不是内容，别写回配置
  const skipKeys = new Set(['id', ...VOLATILE_FIELDS, '__fileExists']);

  if (!fileExists) {
    for (const [key, value] of Object.entries(source)) {
      if (skipKeys.has(key) || isEmpty(value)) continue;
      patch[key] = value;
      adopted.push(key);
    }
    return { patch, adopted, conflicts, unchanged, wholesale: true };
  }

  for (const [key, value] of Object.entries(source)) {
    if (skipKeys.has(key)) continue;
    const mine = local?.[key];
    if (isEmpty(value)) continue;
    if (isEmpty(mine)) {
      patch[key] = value;
      adopted.push(key);
      continue;
    }
    if (sameValue(mine, value)) {
      unchanged.push(key);
      continue;
    }
    // 敏感字段与普通字段在这里的口径完全一样（保留本机值），差别只在报告里是否写值 ——
    // 而这个函数**从不**把值写进 conflicts，所以两边都安全。
    conflicts.push(key);
  }
  return { patch, adopted, conflicts, unchanged, wholesale: false };
}

/** "空"：undefined / null / 空串 / 空数组 / 空对象（`false` 与 `0` 是**有值**）。 */
export function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function sameValue(a, b) {
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/**
 * 单例集合里，这条是不是"空的"（没配过 / 没有票据）→ 不必推、也不必拉。
 *
 * `ai-config` 的判据刻意只看**用户填过的东西**（密钥）与**磁盘上有没有那个文件**：
 * `baseUrl`/`model`/`provider` 这些字段永远有内置默认值（`https://api.deepseek.com/v1`、
 * `deepseek-flash`…），拿它们判"有没有配置"会让每台机器都显示"已配置"，
 * 于是同步第一次跑就会把一堆默认值推来推去、面板上还会写"AI 配置已同步" —— 全是假象。
 */
export function singletonIsEmpty(entry, record) {
  if (!record) return true;
  if (entry.name === 'ai-config') {
    const touched = ['apiKey', 'searchApiKey', 'searchApiKeys'].some((key) => !isEmpty(record[key]));
    return !touched && record.__fileExists !== true;
  }
  if (entry.name === 'lms-credentials') return isEmpty(record.cookies);
  return false;
}
