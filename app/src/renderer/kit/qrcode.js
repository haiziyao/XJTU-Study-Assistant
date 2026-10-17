/* 固定 Version 3-L 的轻量二维码编码器：足够容纳局域网 HTTPS 地址，不联网、不引依赖。 */
(function () {
  'use strict';
  const VERSION = 3;
  const SIZE = 29;
  const DATA_BYTES = 55;
  const ECC_BYTES = 15;

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      if ((y >>> i) & 1) z ^= x;
    }
    return z;
  }

  function generator(degree) {
    let result = [1];
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      const next = Array(result.length + 1).fill(0);
      for (let j = 0; j < result.length; j += 1) {
        next[j] ^= result[j];
        next[j + 1] ^= gfMultiply(result[j], root);
      }
      result = next;
      root = gfMultiply(root, 2);
    }
    return result;
  }

  function codewords(text) {
    const bytes = [...new TextEncoder().encode(text)];
    if (bytes.length > 53) throw new Error('二维码内容过长');
    const bits = [0, 1, 0, 0];
    for (let i = 7; i >= 0; i -= 1) bits.push((bytes.length >>> i) & 1);
    for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
    for (let i = 0; i < 4 && bits.length < DATA_BYTES * 8; i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
    for (let pad = 0; data.length < DATA_BYTES; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    const gen = generator(ECC_BYTES);
    const remainder = Array(ECC_BYTES).fill(0);
    for (const byte of data) {
      const factor = byte ^ remainder.shift();
      remainder.push(0);
      for (let i = 0; i < ECC_BYTES; i += 1) remainder[i] ^= gfMultiply(gen[i + 1], factor);
    }
    return [...data, ...remainder];
  }

  function formatBits(mask = 0) {
    const data = (1 << 3) | mask; // L = 01
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function matrix(text) {
    const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    const set = (x, y, value) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) modules[y][x] = Boolean(value); };
    const finder = (cx, cy) => {
      for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) {
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    };
    finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
    for (let i = 8; i < SIZE - 8; i += 1) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    // 预留两份格式信息区域。
    for (let i = 0; i <= 5; i += 1) set(8, i, false);
    set(8, 7, false); set(8, 8, false); set(7, 8, false);
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, false);
    for (let i = 0; i < 8; i += 1) set(SIZE - 1 - i, 8, false);
    for (let i = 8; i < 15; i += 1) set(8, SIZE - 15 + i, false);
    set(8, SIZE - 8, true);

    const bits = [];
    for (const byte of codewords(text)) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
    let index = 0;
    let upward = true;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      for (let step = 0; step < SIZE; step += 1) {
        const y = upward ? SIZE - 1 - step : step;
        for (let offset = 0; offset < 2; offset += 1) {
          const x = right - offset;
          if (modules[y][x] !== null) continue;
          const bit = index < bits.length ? bits[index] : 0;
          modules[y][x] = Boolean(bit ^ (((x + y) & 1) === 0)); // mask 0
          index += 1;
        }
      }
      upward = !upward;
    }

    const format = formatBits(0);
    const bit = (i) => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(SIZE - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, SIZE - 15 + i, bit(i));
    set(8, SIZE - 8, true);
    return modules;
  }

  function svg(text, scale = 6) {
    const modules = matrix(String(text));
    const quiet = 4;
    const size = SIZE + quiet * 2;
    const paths = [];
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if (modules[y][x]) paths.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    return `<svg class="tf-qr-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" role="img" aria-label="手机版访问二维码"><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join('')}" fill="#111"/></svg>`;
  }

  window.PCQRCode = { matrix, svg };
})();
