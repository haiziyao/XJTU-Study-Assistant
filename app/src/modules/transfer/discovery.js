/**
 * 局域网直传：UDP 发现（§8.1 的「发现同伴」通道）。
 *
 * 职责只有三件，全部围绕"谁在附近、他怎么收数据"：
 *   1. `potato.find` 广播（每 5 秒一次，**只在「可被发现」打开时**才发）；
 *   2. 收到别人的 `find` → 回一条 `potato.here`（带上设备名/平台/端口/是否允许接收）；
 *   3. 把收到的报文解析成同伴列表，超时（3 个广播周期）就算离线。
 *
 * 为什么 socket 与定时器**都可注入**（照 `modules/ai/schedule.js` 的思路）：
 *   - 测试里绝不能真的往局域网发广播（会打扰同网段的真人设备，CI 上也未必有权建 socket），
 *     注入假 socket 之后，"解析 + 状态机 + 该不该回包"全部可以离线断言；
 *   - 广播循环写成 `tick()` 这种"来一次做一轮"的形状，测试可以直接喂 `now` 推演超时，
 *     不必真的 `await 5 秒`。
 *
 * 与 service.js 的分工：发现通道只认识"同伴"，不认识配对码、token、数据 ——
 * 那些都属于 TCP 8886 上的 HTTP 协议。
 */

import dgram from 'node:dgram';

import {
  BROADCAST_INTERVAL_MS,
  DEFAULT_PORT,
  FIND,
  HERE,
  PEER_TTL_MS,
  TRANSFER_SCHEMA,
  parseDiscoveryMessage,
} from './protocol.js';

/** 真实 socket：UDP4 + 允许地址复用（同一台机器上开两个实例时不必互相踩）。 */
function defaultCreateSocket() {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true });
}

/**
 * @param {object} [options]
 * @param {number}   [options.port]             发现端口（与传输端口同为 8886）
 * @param {string}   [options.broadcastAddress] 广播地址（默认受限广播 255.255.255.255）
 * @param {number}   [options.intervalMs]       广播间隔
 * @param {number}   [options.ttlMs]            同伴多久没消息算离线
 * @param {() => object} [options.info]         本机信息（广播与回包的内容）
 * @param {boolean}  [options.udp]              是否真的开 UDP socket（false = 只保留同伴记账，测试/无网环境用）
 * @param {() => object} [options.createSocket] 可注入的 socket 工厂
 * @param {(socket, packet, target) => void} [options.send] 可注入的发送函数
 * @param {() => number} [options.now]          可注入时钟
 * @param {object}   [options.logger]
 */
export function createDiscovery({
  port = DEFAULT_PORT,
  udp = true,
  broadcastAddress = '255.255.255.255',
  intervalMs = BROADCAST_INTERVAL_MS,
  ttlMs = PEER_TTL_MS,
  info = () => ({}),
  createSocket = defaultCreateSocket,
  send = null,
  now = () => Date.now(),
  logger = console,
} = {}) {
  /** @type {Map<string, object>} 设备 id -> 同伴 */
  const peers = new Map();
  let socket = null;
  let timer = null;
  let enabled = false;
  let error = null;
  let sent = 0;
  let received = 0;

  const selfId = () => String(info()?.id ?? '');

  /** 本机信息 → 广播/回包载荷（字段名就是协议字段名，不做二次加工）。 */
  function packetOf(type) {
    const self = info() ?? {};
    return {
      t: type,
      v: TRANSFER_SCHEMA,
      id: self.id,
      name: self.name,
      ...(type === HERE
        ? {
            platform: self.platform ?? null,
            version: self.version ?? null,
            accepting: self.accepting !== false,
          }
        : {}),
      port: self.port ?? port,
    };
  }

  /** 真发一个包（socket 与发送函数都可注入，测试里只记账不发）。 */
  function sendPacket(packet, target) {
    const raw = Buffer.from(JSON.stringify(packet), 'utf8');
    sent += 1;
    if (typeof send === 'function') {
      send(socket, raw, target);
      return;
    }
    socket?.send?.(raw, 0, raw.length, target.port, target.address, () => {});
  }

  /** 广播「我在这里」（仅"可被发现"打开时）。 */
  function announce() {
    sendPacket(packetOf(FIND), { address: broadcastAddress, port });
  }

  /** 单播回「我在这里，我的情况是这样」。 */
  function reply(target) {
    sendPacket(packetOf(HERE), target);
  }

  /**
   * 记下一个同伴（UDP 发现到的，或手工填 IP 探测到的）。
   *
   * `accepting` 用三态：true / false / **null（对面没说）**。
   * `find` 报文里本来就没有这个字段，把它默认成"能收"会让用户点了发送才发现不行。
   */
  function remember(device, host, via = 'broadcast', at = now()) {
    const id = String(device?.id ?? '').trim();
    if (!id) return null;
    const peer = {
      id,
      name: String(device?.name ?? '').trim() || '未命名设备',
      platform: device?.platform ?? null,
      port: Number(device?.port) || port,
      host: host ?? null,
      accepting: typeof device?.accepting === 'boolean' ? device.accepting : null,
      version: device?.version ?? null,
      via,
      lastSeen: new Date(at).toISOString(),
    };
    peers.set(id, peer);
    return peer;
  }

  /** 处理一条收到的报文；返回解析结果（测试据此断言，不必读内部状态）。 */
  function handleMessage(raw, rinfo = {}) {
    received += 1;
    const message = parseDiscoveryMessage(raw, rinfo.address ?? '');
    if (!message) return null;
    // 自己的广播在某些平台上会回环到自己：认出来直接丢掉，免得"附近设备"里出现本机
    if (message.id === selfId()) return message;

    remember(
      { id: message.id, name: message.name, platform: message.platform, port: message.port, accepting: message.accepting, version: message.version },
      message.host ?? rinfo.address ?? null,
      'broadcast',
    );
    // 对方在找同伴、而本机愿意被发现 → 回一条 here（不回包就等于"隐身"，
    // 但对方仍然能看见我们 —— 因为这一包是他自己广播的）
    if (message.t === FIND && enabled) {
      reply({ address: message.host ?? rinfo.address, port: message.port ?? port });
    }
    return message;
  }

  /** 一轮：广播（可选）+ 过期清理。到点由 `setInterval` 驱动，测试可直接调。 */
  function tick(at = now()) {
    if (enabled) announce();
    let removed = 0;
    for (const [id, peer] of peers) {
      // 手工添加的同伴不过期：跨网段/广播被拦时它就是唯一入口，消失了用户会很困惑
      if (peer.via === 'manual') continue;
      if (at - Date.parse(peer.lastSeen) > ttlMs) {
        peers.delete(id);
        removed += 1;
      }
    }
    return { announced: enabled, removed, peers: peers.size };
  }

  /** 启动监听（HTTP 服务器起来之后调用；重复调用安全）。 */
  function start() {
    if (socket) return api;
    // udp: false —— 不开真 socket，但同伴记账（手工添加 / 注入的假报文）照常可用。
    // 测试必须走这条路：绝不能往真实局域网里发广播。
    if (!udp) {
      if (enabled) startTimer();
      return api;
    }
    try {
      socket = createSocket();
      socket.on?.('message', (raw, rinfo) => {
        try {
          handleMessage(raw, rinfo);
        } catch (err) {
          logger?.warn?.(`[transfer] 丢弃一条无法解析的发现报文：${err?.message ?? err}`);
        }
      });
      socket.on?.('error', (err) => {
        error = err?.message ?? String(err);
        logger?.warn?.(`[transfer] UDP 发现通道出错，已降级（手工填 IP 仍可用）：${error}`);
      });
      socket.bind?.(port, () => {
        // 广播权限要在 bind 之后开；失败只是发不出去，监听照旧
        try {
          socket.setBroadcast?.(true);
        } catch (err) {
          logger?.warn?.(`[transfer] 打开广播权限失败：${err?.message ?? err}`);
        }
      });
      // 监听一建立就先清一次过期表（后端重启后残留的旧同伴不该继续显示）
      if (enabled) startTimer();
    } catch (err) {
      error = err?.message ?? String(err);
      socket = null;
      logger?.warn?.(`[transfer] UDP 发现通道未启动：${error}`);
    }
    return api;
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => tick(), Math.max(1000, intervalMs));
    // unref：广播循环绝不成为"进程为什么还不退出"的原因（node --test 尤其敏感）
    timer.unref?.();
    // 立刻来一轮：用户打开开关后不该等 5 秒才在对面出现
    tick();
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 开关「可被发现」：打开才广播、才回包。 */
  function setEnabled(value) {
    enabled = Boolean(value);
    if (enabled) startTimer();
    else stopTimer();
    return enabled;
  }

  function stop() {
    // 停止 = 彻底不再广播：`enabled` 一并复位，否则"已经 stop 了却还显示在广播"
    //（而且 handles() 会一直报 broadcasting: true，把 stop 的契约测糊掉）
    enabled = false;
    stopTimer();
    const closing = socket;
    socket = null;
    try {
      closing?.close?.();
    } catch {
      /* 已经关了就算了 */
    }
    return api;
  }

  const api = {
    port,
    start,
    stop,
    setEnabled,
    isEnabled: () => enabled,
    tick,
    handleMessage,
    remember,
    forget: (id) => peers.delete(String(id)),
    clear: () => peers.clear(),
    /** 同伴列表：手工添加的排前面（那是用户自己指定过的，优先级更高）。 */
    list: () =>
      [...peers.values()].sort((a, b) => (a.via === b.via ? a.name.localeCompare(b.name) : a.via === 'manual' ? -1 : 1)),
    get: (id) => peers.get(String(id)) ?? null,
    status: () => ({ port, enabled, udp, bound: Boolean(socket), error, sent, received, peers: peers.size }),
  };
  return api;
}
