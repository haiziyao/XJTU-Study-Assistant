/**
 * 局域网直传：协议常量与纯函数（契约见 docs/AI中枢-实施进度与契约.md §八）。
 *
 * 为什么把这些单独放一层：
 * - **可测**：分片、内容指纹、UDP 报文解析全是纯计算，测试可以喂任意输入，
 *   不必真的开 socket、真的等 5 秒广播（§8.1 的协议一旦写错，只有对拍才能发现）；
 * - **单一出处**：`2 MB`、`8886`、`6 位码`、`10 分钟`、`30 分钟` 这些数字同时被
 *   service / 前端 / README 提到，散落在各处必然有一天对不上。
 *
 * 协议形状（§8.1，**不要另发明一套**）：
 *   UDP 8886：`{"t":"potato.find","v":1,"id":…,"name":…,"port":8886}`
 *             同伴回 `{"t":"potato.here",…}`（多带 platform / version / accepting）
 *   TCP 8886：HTTP/1.1 —— `GET /info`、`POST /pair`、`POST /transfer`、`GET /progress`
 *   bundle  ：`{ bundleId, schema, from, createdAt, collections, counts }`
 *   分片    ：单批 ≤ 2 MB，超了在同一个 bundleId 上带 `chunk: { index, total, bundleId }`
 */

import { createHash } from 'node:crypto';

/** bundle 结构版本：字段语义变化时递增，对面据此判断能不能收。 */
export const TRANSFER_SCHEMA = 1;

/** 发现通道的两种报文（`t` 字段）。 */
export const FIND = 'potato.find';
export const HERE = 'potato.here';

/** 默认端口：发现（UDP）与传数据（TCP）共用同一个 8886（§8.1）。 */
export const DEFAULT_PORT = 8886;

/** 单批上限 2 MB：超过就把批次切开（单条本身就超标的独占一批，见 buildChunks）。 */
export const CHUNK_BYTES = 2 * 1024 * 1024;

/** 配对码：6 位、10 分钟有效、最多错 5 次锁 60 秒。 */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 60 * 1000;
/** 配对成功后拿到的 token：30 分钟有效，后续每个分片都带着它。 */
export const TOKEN_TTL_MS = 30 * 60 * 1000;

/** 广播间隔 5 秒（§8.1）；同伴信息 3 个周期没刷新就当离线。 */
export const BROADCAST_INTERVAL_MS = 5 * 1000;
export const PEER_TTL_MS = 3 * BROADCAST_INTERVAL_MS;

/** 设备服务器请求体上限：一批最多 2 MB，留足余量给「单条超标独占一批」的情况。 */
export const MAX_DEVICE_BODY_BYTES = 16 * 1024 * 1024;

/** 传输日志保留条数（内存 + `data/transfer-log.json`，见 service.js 的说明）。 */
export const LOG_LIMIT = 200;
/** 幂等账本保留条数：超了从头丢（最老的记录被重放时会退化成"再写一份"，不会丢数据）。 */
export const LEDGER_LIMIT = 5000;

/**
 * 稳定序列化：对象键排序后展开。
 *
 * 为什么不用 `JSON.stringify` 直接算指纹：集合里的字段顺序取决于写入路径
 * （模块 A 先写 title 还是先写 body），同一份内容序列化出来可能不同字节，
 * 于是"同 id 同内容应跳过"会退化成"每次都新建一份" —— 幂等就没了。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 内容指纹（sha1 十六进制，取前 16 位足够区分本地数据量级的内容）。 */
export function fingerprint(value) {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16);
}

/** 设备短 id：`-from-<短id>` 后缀用，取 id 前 6 位（去掉 uuid 里的连字符）。 */
export function shortDeviceId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'device';
}

/**
 * 把一批条目切成 ≤ `limit` 字节的批次。
 *
 * 规则（§8.1「单批 ≤ 2 MB，超了分片」）：
 * - 贪心装箱：一条放不下当前批就封存当前批、另起一批；
 * - **单条本身就超过上限时独占一批**（`oversized: true`）。不这么做的话，
 *   它永远进不了任何一批，用户会看到"有一条怎么也传不过去"却没有任何提示；
 *   独占一批至少能把数据送到，接收端按自己的上限处理（例如笔记模块会截断到 20 万字，
 *   截断这件事由接收端如实回报，见 service.js）。
 *
 * @param {object} base 公共字段（bundleId / schema / from / createdAt）
 * @param {Array<{ collection: string, item: object }>} entries
 * @param {number} [limit]
 * @returns {Array<{ collections: Record<string, object[]>, bytes: number, count: number, oversized: boolean }>}
 */
export function buildChunks(base, entries, limit = CHUNK_BYTES) {
  const sizeOf = (collections) => Buffer.byteLength(JSON.stringify({ ...base, collections }), 'utf8');
  const chunks = [];
  /** @type {Record<string, object[]>} */
  let current = {};

  const seal = (collections) => {
    const bytes = sizeOf(collections);
    chunks.push({
      collections,
      bytes,
      count: Object.values(collections).reduce((sum, list) => sum + list.length, 0),
      oversized: bytes > limit,
    });
  };

  for (const { collection, item } of entries) {
    const next = { ...current, [collection]: [...(current[collection] ?? []), item] };
    if (sizeOf(next) <= limit) {
      current = next;
      continue;
    }
    if (Object.keys(current).length) seal(current);
    const alone = { [collection]: [item] };
    // 单条超标：独占一批（会在结果里标 oversized，让用户知道这批为什么大）
    if (sizeOf(alone) > limit) {
      seal(alone);
      current = {};
      continue;
    }
    current = alone;
  }
  if (Object.keys(current).length) seal(current);
  return chunks;
}

/**
 * 解析一条 UDP 报文。
 *
 * 只认协议里写明的两种 `t`、`v === 1`、且带非空 `id` 的报文；其余（别人的广播、
 * 半截包、HTML 探测）一律返回 `null` —— 局域网上什么都有，解析层必须能把噪音挡在外面。
 *
 * @param {Buffer|string} raw
 * @param {string} [host] 报文来源地址（UDP 头里的，比报文自称的可信）
 * @returns {null|{ t: string, v: number, id: string, name: string, platform: string|null, port: number, accepting: boolean|null, version: string|null }}
 */
export function parseDiscoveryMessage(raw, host = '') {
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.t !== FIND && payload.t !== HERE) return null;
  if (Number(payload.v) !== TRANSFER_SCHEMA) return null;
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id || id.length > 128) return null;

  const port = Number(payload.port);
  return {
    t: payload.t,
    v: TRANSFER_SCHEMA,
    id,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 80) : '未命名设备',
    platform: typeof payload.platform === 'string' ? payload.platform.slice(0, 40) : null,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    // `null` = 对面没说（`find` 报文里没有这个字段），界面上显示"未知"，不要瞎猜成"可以收"
    accepting: typeof payload.accepting === 'boolean' ? payload.accepting : null,
    version: typeof payload.version === 'string' ? payload.version.slice(0, 40) : null,
    host: host || null,
  };
}

/** 一组集合里各有多少条（bundle.counts，也是界面上"要传多少条"的来源）。 */
export function countItems(collections = {}) {
  const counts = {};
  for (const [name, list] of Object.entries(collections)) counts[name] = Array.isArray(list) ? list.length : 0;
  return counts;
}

/** 校验一批集合名是否都认识（发送端选集合时用，防止把任意键塞进 bundle）。 */
export function pickCollections(names, known) {
  const out = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (!known.includes(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
