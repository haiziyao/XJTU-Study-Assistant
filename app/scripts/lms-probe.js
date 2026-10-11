/**
 * 思源学堂连通性自检（不需要账号密码）。
 *
 * 用途：登录失败时先跑一遍，确认「打不开登录页 / 拿不到公钥 / 学校改版了」
 * 这类环境问题，而不是账号问题。
 *
 *   node scripts/lms-probe.js
 */

import { resolveLmsConfig } from '../src/modules/lms/config.js';
import { CasAuth, extractExecution, extractMfaEnabled, isSafetyVerifyPage } from '../src/modules/lms/cas-auth.js';
import { CookieJar, HttpClient } from '../src/modules/lms/http-client.js';

const config = resolveLmsConfig();
const http = new HttpClient({ userAgent: config.userAgent, timeoutMs: config.timeoutMs, jar: new CookieJar() });
const auth = new CasAuth({ http, config });

const line = (label, value) => console.log(`${label.padEnd(22, ' ')} ${value}`);

console.log('目标：', config.baseUrl, '｜认证：', config.casOrigin);
console.log('—'.repeat(60));

// 1) 手工跟一遍跳转链，把每一跳都打出来（排查学校改版最有用）
try {
  const response = await http.get(config.baseUrl, { follow: true });
  line('最终地址', response.url);
  line('状态码', response.status);
  line('跳转次数', response.redirects.length);
  response.redirects.forEach((url, index) => line(`  第 ${index + 1} 跳`, url));
  line('Cookie 数', http.jar.toJSON().length);
  line('找到 execution', extractExecution(response.text) ? '是' : '否');
  line('mfaEnabled', extractMfaEnabled(response.text));
  line('二次认证页', isSafetyVerifyPage(response.text) ? '是' : '否');
} catch (error) {
  line('打开业务站点失败', error.message);
}

// 2) 公钥 + 加密（只在本机算，不会把密码发出去）
try {
  const encrypted = await auth.encryptPassword('dummy-password-not-sent');
  line('RSA 公钥', auth.rsaPublicKey ? `已获取（${auth.rsaPublicKey.length} 字符）` : '缺失');
  line('加密结果前缀', encrypted.slice(0, 7));
  line('加密结果长度', encrypted.length);
} catch (error) {
  line('获取公钥失败', error.message);
}

// 3) 图形验证码接口（只有失败 3 次后才要求，但接口本身应该可用）
try {
  const captcha = await auth.fetchCaptcha();
  line('验证码图片', `${captcha.bytes.length} 字节（${captcha.contentType}）`);
} catch (error) {
  line('验证码接口失败', error.message);
}

const state = await auth.begin();
line('begin() 结果', state);
console.log('—'.repeat(60));
console.log(state === 'login_form' ? '结论：登录页结构正常，可以尝试在测试窗口里登录。' : `结论：当前状态 ${state}，请检查上面的跳转链。`);
