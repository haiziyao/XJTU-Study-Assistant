/**
 * 同步的**合并口径**（纯函数，逐条可测）。
 *
 * 它从哪来
 * --------
 * 直接沿用「局域网直传」那套已经验过的口径（`src/modules/transfer/`）：
 *   ① 同 id 同内容 → 跳过（幂等，重放不产生第二份）；
 *   ② 同 id 内容不同 → **两条都留**：本机保留自己那条，来的一条另起一个 id 存下来，
 *      并在账本里记下 `alias`（`<原id>-from-<设备短id>`）与 `origin`（设备名）供人追溯；
 *   ③ 不同 id 同名 → 两条都留 + 进「疑似重复」清单交用户决定；
 *   ④ 记忆 key 冲突不做取代（加后缀并存）—— 见 memory 模块自己的 create。
 *
 * 指纹口径也照抄：`fingerprint()` 与传输模块**同一个函数**（`transfer/protocol.js`），
 * 算的是"将要落库的内容字段"，**不含** `id`/`createdAt`/`updatedAt` 这类每次都变的字段
 * （含进去会让重放退化成"又新建一份"，幂等就没了）。
 *
 * 与直传**必须不同**的两点（同步是双向的、而且有"同一台设备的同一条记录"这个概念）
 * ------------------------------------------------------------------------------
 * 1. **id 是身份**。直传是单向导入，本地 id 由模块自己生成，靠账本做"远端 id ↔ 本地 id"
 *    的映射；同步两侧都会互相推，必须收敛到**同一个 id**，否则同一条笔记在两台设备上
 *    会各长一份、下一轮再互相推、无限增殖。所以同步**保留 id**（`id` 就是合并键）。
 * 2. **冲突副本的 id 是确定性的**：`<原id>-h<内容指纹前 8 位>`。直传里副本 id 随机、
 *    alias 只记在账本里；同步里两台设备会各自收到同一个冲突，随机 id 会让它们各存一份，
 *    确定性 id 让两侧收敛到同一条记录上。
 *
 * 绝不用"谁后写谁赢"
 * ------------------
 * 整个决策表里**没有**时间比较：不比较 `updatedAt`，不比较"谁先到"。唯一一次"就地覆盖"
 * （`action: 'updated'`）成立的前提是**账本能证明**"本机这条记录就是对面之前给我的那一版"
 * （同一条记录、同一个 id、同一个内容指纹，且那一版是被对面**正式采纳**而不是塞进冲突副本的）。
 * 也就是说：只有"这一版确实是对方自己的版本的后续"才允许覆盖；只要账本证明不了，
 * 一律走"两条都留"。用时间戳判胜负会在两台设备的钟差、离线编辑、追补同步下**静默吞掉**
 * 一方的编辑 —— 那正是这套口径要避免的事。
 */

import { fingerprint } from '../transfer/protocol.js';

/** 冲突副本 id 的后缀正则：`<原id>-h<8 位指纹>`。 */
export const COPY_ID_RE = /^(.+)-h([0-9a-f]{8})$/;

/** 冲突副本 id：同一条记录的两个不同版本，用内容指纹区分，两侧算出来必须一样。 */
export function copyId(id, hash) {
  return `${String(id)}-h${String(hash).slice(0, 8)}`;
}

/** 副本 id 拆回 `{ parentId, hash }`；不是副本 id 就返回 null。 */
export function parseCopyId(id) {
  const match = COPY_ID_RE.exec(String(id ?? ''));
  return match ? { parentId: match[1], hash: match[2] } : null;
}

/**
 * 记录的内容指纹（口径与传输模块一致：`fingerprint` 是同一个函数）。
 *
 * 输入是 `catalog.project()` 的结果，这里再显式去掉 `id`：
 *   - id 是**身份**，不是内容 —— 冲突副本的 id 是 `<父id>-h<指纹>`，如果把 id 算进指纹，
 *     "本机父记录的指纹"与"远端副本的指纹"永远不相等，"本机已有同内容就不用再存一份"
 *     这条规则就永远命中不了（每次冲突都会在每台设备上多出一份重复内容）；
 *   - `createdAt`/`updatedAt` 在 `project()` 里已经去掉了：它们每台设备都不一样，
 *     算进去会让"重放同一版"退化成"又新建一份"，幂等就没了。
 */
export function contentHash(projected) {
  if (!projected || typeof projected !== 'object') return fingerprint(projected);
  const { id, ...rest } = projected;
  return fingerprint(rest);
}

/**
 * 一条远端记录该怎么落。
 *
 * @param {object} input
 * @param {string} input.id            记录 id（两侧共用同一个 id 空间）
 * @param {string} input.incomingHash  远端这一版的内容指纹
 * @param {string|null} input.localHash 本机同 id 记录的内容指纹（没有这条记录时 null）
 * @param {boolean} input.localExists   本机是否已有同 id 记录
 * @param {Array<{hash:string, localId:string, conflict?:boolean}>} [input.history]
 *   账本里"对面这个 id 之前给过我哪些版本"。`localId` 是**我方**当时落库的 id：
 *   被正式采纳的一版 `localId === id`；被判成冲突而另存副本的一版 `localId === 副本 id`。
 * @param {Array<string>} [input.knownBefore]
 *   **这条记录在这台机器上出现过的所有内容指纹**（跨设备，`versions` 索引）。
 *   用来识别"对面推上来的是本机早就有的旧版本"（见下面规则 ③）。
 * @param {boolean} [input.variantContentPresent]
 *   这是一条**冲突副本**（id 形如 `<父id>-h<指纹>`），而本机手上已经有一条**同内容**的记录
 *   （通常就是那个父 id）→ 说明本机不需要第二份同样的内容。
 * @returns {{action:'skipped'|'added'|'updated'|'conflict', reason?:string}}
 *   - `skipped`：不动（`reason` 说明为什么）
 *   - `added`  ：本机没有 → 按原 id 新增
 *   - `updated`：本机这条就是对面那一版的后续 → 就地更新（**唯一**允许覆盖的分支）
 *   - `conflict`：判断不了 → 两条都留（来的一条存成 `<id>-h<指纹>`）
 */
export function planMerge({ id, incomingHash, localHash = null, localExists = false, history = [], knownBefore = [], variantContentPresent = false } = {}) {
  // ① 重放：这一版对面之前就给过我（内容指纹一样）→ 什么都不做。
  //    这一条是幂等的**第一道**保证：跑第二遍同步时绝大多数记录走到这里。
  if (history.some((entry) => entry?.hash === incomingHash)) return { action: 'skipped', reason: 'replay' };

  // ② 同 id 同内容：来源不同（比如另一台设备把我这条又推回来了）→ 跳过
  if (localExists && localHash === incomingHash) return { action: 'skipped', reason: 'identical' };

  // ③ 陈旧版本：对面推上来的这一版**本机历史上就有过**，而且对面的账本里**没有**本机当前这一版
  //    → 它只是还没同步到（离线很久的设备、刚换过数据目录的设备），不是"改回去了"。
  //    为什么必须有这一条：没有它，一台落后两个版本的设备推一次，就会被判成"同 id 内容不同"
  //    而生成一份冲突副本 —— 那份副本还带着旧内容，等于把用户刚删掉/刚改掉的东西又"复活"一份。
  //    为什么"对面没有本机当前版本"这个条件是必须的：真正的"改回旧版本"（比如撤销编辑、
  //    从回收站恢复）在内容上**与陈旧推送完全一样**，唯一能区分的是"对面见过新版本没有"。
  //    见过 → 它是主动改回去的 → 落到规则 ⑤（就地更新）；没见过 → 陈旧 → 跳过，让它 pull 追上。
  if (localExists && knownBefore.includes(incomingHash) && !history.some((entry) => entry?.hash === localHash)) {
    return { action: 'skipped', reason: 'stale' };
  }

  if (!localExists) {
    // 冲突副本 + 本机已有同内容的那条 → 不需要第二份（否则每次冲突都会在每台设备上多出一份）
    if (variantContentPresent) return { action: 'skipped', reason: 'variant-present' };
    return { action: 'added' };
  }

  // ④ 本机这条的内容 == 对面**正式采纳过**的那一版 → 对面是在更新自己的记录，就地更新。
  //    注意 `entry.localId === id` 这个条件：冲突副本（localId 是副本 id）不算"采纳"，
  //    否则两台设备互相改同一条记录时，后到的那一版会把先到的那一版覆盖掉（静默吞内容）。
  const adopted = history.some((entry) => entry?.hash === localHash && entry?.localId === id && entry?.conflict !== true);
  if (adopted) return { action: 'updated' };

  // ⑤ 判断不了 → 两条都留。这是**默认**分支：宁可多一条让人自己删，也不静默丢掉一方的编辑。
  return { action: 'conflict' };
}

/**
 * 「同名」判定用：把标题/正文归一化（与传输模块 `catalog.js` 里的 `nameOf` 完全一致）。
 * 同步侧的 duplicateKey 全部复用传输模块目录里的函数，这里只在同步新增的集合上用。
 */
export const normalizeName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** 账本保留：每个 (设备, 集合, id) 记最近 8 版（与传输模块同一个量级）。 */
export const HISTORY_LIMIT = 8;

/**
 * 往账本里追加一版，返回新数组（不改原数组，方便调用方决定什么时候落盘）。
 * @param {Array<object>} history
 * @param {{hash:string, localId:string, alias?:string|null, origin?:string|null, conflict?:boolean, at:string}} entry
 */
export function pushHistory(history, entry) {
  return [...(Array.isArray(history) ? history : []), entry].slice(-HISTORY_LIMIT);
}

/** 账本键：`<peerKey>|<collection>|<id>`。`peerKey` 是设备 id（服务端侧）或 `server:<url>`（桌面端侧）。 */
export function ledgerKey(peerKey, collection, id) {
  return `${peerKey}|${collection}|${id}`;
}

/** 「版本」索引键：`<collection>|<id>` —— 跨设备记录"这条记录在本机历史上长什么样"。 */
export function versionKey(collection, id) {
  return `${collection}|${id}`;
}

/** versions 索引里每条记录保留多少个历史指纹（与每设备的 history 同一个量级）。 */
export const VERSION_LIMIT = 8;

/** 往版本索引里追加一个指纹（去重、保序、有上限）。 */
export function pushVersion(list, hash) {
  const current = Array.isArray(list) ? list.filter((item) => item !== hash) : [];
  return [...current, hash].slice(-VERSION_LIMIT);
}

/**
 * 脱敏：报告/日志里绝不能出现 AI key、学堂票据、账号令牌。
 *
 * 为什么要单独一个函数：同步的 report 会带着逐条明细回到页面，页面还会渲染它。
 * 只要有一条路径把 `apiKey` 原样塞进消息里，密钥就会出现在页面、截图、工单里。
 * 所以凡是"把远端给的值写进人看的字符串"的地方，都从这里过一道。
 */
export function redactSecrets(value) {
  const text = String(value ?? '');
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, '***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{6,}=*/gi, '$1***')
    .replace(/("(?:apiKey|searchApiKey|searchApiKeys|password|token|potato_session)"\s*:\s*")[^"]*(")/gi, '$1***$2');
}
