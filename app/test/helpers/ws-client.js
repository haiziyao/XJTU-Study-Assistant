/**
 * 极简 WebSocket 客户端（测试用）。
 *
 * 为什么不用全局 `WebSocket`：那是 Node ≥ 21 才有的，而 package.json 声明的引擎是 ≥ 20。
 * 这里只实现测试需要的部分：握手 + 读文本帧（服务端帧不带掩码，解析很直接）。
 * 需要发帧时也只发「带掩码的文本帧」（协议规定客户端必须掩码）。
 */

import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, mask, masked]);
}

/** 从缓冲区里尽可能多地把完整帧解出来，返回 [消息数组, 剩余缓冲]。 */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (buffer.length - cursor < length) break;
    const payload = buffer.subarray(cursor, cursor + length);
    if (opcode === 0x1) messages.push(payload.toString('utf8'));
    offset = cursor + length;
  }
  return [messages, buffer.subarray(offset)];
}

/**
 * 连上 `/ws`，把收到的每条消息按 JSON 解析后推进 `messages`。
 * @returns {Promise<{messages: object[], send: (obj: object) => void, close: () => void, waitFor: (fn, timeoutMs?) => Promise<object>}>}
 */
export function connectWs({ port, path = '/ws', host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect(port, host);
    let buffer = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    const client = {
      messages,
      socket,
      send(message) {
        socket.write(encodeClientFrame(JSON.stringify(message)));
      },
      close() {
        socket.destroy();
      },
      /** 等一条满足条件的消息（已在缓冲里的也会命中）。 */
      waitFor(predicate, timeoutMs = 5000) {
        const existing = messages.find((item) => predicate(item));
        if (existing) return Promise.resolve(existing);
        return new Promise((resolveWait, rejectWait) => {
          const timer = setTimeout(() => {
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
            rejectWait(new Error(`等消息超时（${timeoutMs}ms），已收到 ${JSON.stringify(messages.slice(-5))}`));
          }, timeoutMs);
          const entry = {
            predicate,
            resolve: (message) => {
              clearTimeout(timer);
              resolveWait(message);
            },
          };
          waiters.push(entry);
        });
      },
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!client.handshaked) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('utf8');
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        if (!head.includes(accept)) return reject(new Error(`WebSocket 握手失败：${head}`));
        client.handshaked = true;
        buffer = buffer.subarray(end + 4);
      }
      const [decoded, rest] = decodeFrames(buffer);
      buffer = rest;
      for (const text of decoded) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        messages.push(parsed);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(parsed)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(parsed);
          }
        }
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });

    // 握手完成（收到 ready）后再交给调用方
    client
      .waitFor((message) => message.type === 'ready', 3000)
      .then(() => resolve(client))
      .catch(reject);
  });
}
