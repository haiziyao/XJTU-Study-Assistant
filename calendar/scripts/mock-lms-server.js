/**
 * 本地假思源学堂（mock）—— 离线演示 / 界面联调用，不连学校服务器。
 *
 *   node scripts/mock-lms-server.js                 # 默认 127.0.0.1:4599
 *   node scripts/mock-lms-server.js --port 4600
 *
 * 启动后另开一个终端，把后端的思源学堂地址指过来即可体验完整的登录 → 课程 → 同步流程：
 *
 *   PC_LMS_BASE_URL=http://127.0.0.1:4599 \
 *   PC_LMS_CAS_ORIGIN=http://127.0.0.1:4599 \
 *   PORT=3210 node bin/server.js
 *
 * 演示账号：学号 2021001 / 密码 pw-123456（如需两步验证加 --mfa，验证码见下）。
 */

import { startMockLms } from '../test/helpers/lms-mock.js';

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(readFlag('port', 4599));
const needMfa = args.includes('--mfa');
const safetyVerify = args.includes('--sec');
const password = readFlag('password', 'pw-123456');
const mfaCode = readFlag('code', '654321');

const mock = await startMockLms({ needMfa, safetyVerify, password, mfaCode, port });
console.log('[mock-lms] 假思源学堂已启动');
console.log(`  地址        ${mock.origin}`);
console.log(`  学号/密码   2021001 / ${password}`);
if (needMfa) console.log(`  两步验证    已开启，验证码 ${mfaCode}`);
if (safetyVerify) console.log('  二次认证    已开启（Safety Verify）');
console.log('');
console.log('把后端指向它：');
console.log(`  PC_LMS_BASE_URL=${mock.origin} PC_LMS_CAS_ORIGIN=${mock.origin} node bin/server.js`);

const shutdown = async () => {
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
