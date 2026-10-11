/**
 * 极简 WebSocket 服务端（RFC 6455 文本帧子集，零依赖）。
 *
 * 用途：向后端 -> 前端单向推送提醒与数据变更事件；同时接受前端发来的
 * `{type:"ping"}` 心跳与 `{type:"subscribe"}` 过滤设置。
 * 不支持分片消息与扩展协商，超出范围的能力在接入真实前端框架前无需实现。
 */

import { createHash } from 'node:crypto';
import { WS_MESSAGE_TYPES } from '../../shared/constants.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/** 解码客户端发来的单帧（客户端帧必带掩码）。 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask;
  if (masked) {
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode: buffer[0] & 0x0f, payload };
}

export class WebSocketHub {
  constructor({ path: wsPath = '/ws' } = {}) {
    this.path = wsPath;
    /** @type {Set<import('node:net').Socket>} */
    this.clients = new Set();
    /** @type {Set<(message: object) => void>} 进程内订阅者（Electron 主进程用来弹系统通知）。 */
    this.subscribers = new Set();
  }

  /** 订阅广播消息（不依赖 WebSocket 连接，供主进程使用）。 */
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** 是否应当由本 Hub 处理该升级请求。 */
  matches(req) {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    return url.pathname === this.path;
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n'),
    );
    socket.setNoDelay(true);
    this.clients.add(socket);
    this.send(socket, { type: WS_MESSAGE_TYPES.READY, payload: { clients: this.clients.size } });

    socket.on('data', (chunk) => {
      const frame = decodeFrame(chunk);
      if (!frame) return;
      if (frame.opcode === 0x8) {
        this.close(socket);
        return;
      }
      if (frame.opcode !== 0x1) return;
      try {
        const message = JSON.parse(frame.payload.toString('utf8'));
        if (message?.type === 'ping') this.send(socket, { type: 'pong', payload: { ts: Date.now() } });
      } catch {
        /* 忽略非法消息 */
      }
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  send(socket, message) {
    try {
      socket.write(encodeFrame(JSON.stringify(message)));
    } catch {
      this.clients.delete(socket);
    }
  }

  close(socket) {
    try {
      socket.write(encodeFrame(Buffer.alloc(0), 0x8));
      socket.end();
    } catch {
      /* 忽略 */
    }
    this.clients.delete(socket);
  }

  /** 广播一条消息给所有已连接前端。 */
  broadcast(message) {
    const enriched = { ts: new Date().toISOString(), ...message };
    for (const socket of [...this.clients]) this.send(socket, enriched);
    for (const listener of [...this.subscribers]) {
      try {
        listener(enriched);
      } catch (error) {
        console.error('[ws] 订阅者处理失败:', error.message);
      }
    }
    return this.clients.size;
  }

  get size() {
    return this.clients.size;
  }
}
