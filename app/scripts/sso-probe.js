#!/usr/bin/env node
/**
 * SSO 可行性验证（一次性调研脚本）。
 *
 * 要回答的问题只有一个：**用一套 Cookie 罐登录一次，能不能同时拿到学堂与教务的会话？**
 *
 * 背景：学堂走经典 CAS（`/cas/login?service=…`），教务走 OAuth2
 * （`/cas/oauth2.0/authorize?client_id=1030`）。两套协议理论上共用
 * `login.xjtu.edu.cn` 上的同一个 TGC 票据 cookie，但**没有实测过**。
 * 这决定了全局登录模块的 `ensure(site)` 是"靠 SSO 静默重建"还是
 * "退化为用同一份密码为该站点单独登录"。
 *
 * 用法（凭据只从环境变量读，不落盘、不打印）：
 *   # Windows PowerShell
 *   $env:PC_EHALL_USER='<学号>'; $env:PC_EHALL_PASS='<密码>'; node scripts/sso-probe.js
 *   # macOS / Linux
 *   PC_EHALL_USER='<学号>' PC_EHALL_PASS='<密码>' node scripts/sso-probe.js
 *
 * 输出全部脱敏：只打印"有没有 TGC""返回的是什么状态"，不打印 cookie 值与任何个人信息。
 * 会话票据写系统临时目录，不进仓库。
 *
 * 不入库前请确认：本文件不含任何凭据。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AUTH_STATUS, CasAuth, generateVisitorId } from '../src/modules/lms/cas-auth.js';
import { CookieJar, HttpClient } from '../src/modules/lms/http-client.js';

/** 教务（ehall）成绩应用的业务 URL —— 已知能引出完整 OAuth2 链。 */
const EHALL_LOGIN = 'https://ehall.xjtu.edu.cn/jwapp/sys/cjcx/*default/index.do';
/** 学堂首页 —— 经典 CAS 入口。 */
const LMS_URL = 'https://lms.xjtu.edu.cn';

const CAS_ORIGIN = 'https://login.xjtu.edu.cn';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SESSION_FILE = path.join(os.tmpdir(), 'pc-sso-probe-session.json');

const rule = (title) => console.log(`\n${'═'.repeat(8)} ${title} ${'═'.repeat(8)}`);

/** 只看 cookie 的**名字与域名**，不看值。 */
function cookieIndex(jar) {
  return jar.toJSON().map((cookie) => `${cookie.name}@${cookie.domain}`);
}

/** 这些是"已登录"的强信号（名字固定，值与个人无关）。 */
function ticketReport(jar) {
  const all = jar.toJSON();
  const find = (name) => all.find((cookie) => cookie.name === name) ?? null;
  const tgc = find('TGC');
  return {
    hasTgc: Boolean(tgc),
    tgcDomain: tgc?.domain ?? null,
    hasCastgc: Boolean(find('CASTGC')),
    domains: [...new Set(all.map((cookie) => cookie.domain))],
    count: all.length,
  };
}

async function main() {
  const username = process.env.PC_EHALL_USER?.trim();
  const password = process.env.PC_EHALL_PASS;
  if (!username || !password) {
    console.error('缺少凭据。请先设置 PC_EHALL_USER / PC_EHALL_PASS（不会写进任何文件）。');
    process.exitCode = 2;
    return;
  }

  // ★ 关键：lms 与 academic 将来共用这一个罐子
  const jar = new CookieJar();
  const http = new HttpClient({ userAgent: UA, timeoutMs: 25_000, jar });
  const config = { baseUrl: 'https://ehall.xjtu.edu.cn', casOrigin: CAS_ORIGIN, userAgent: UA, timeoutMs: 25_000 };
  const auth = new CasAuth({ http, config, visitorId: generateVisitorId() });

  rule('1. 用「教务」入口登录（OAuth2 链）');
  const begun = await auth.begin(EHALL_LOGIN);
  console.log('  begin() ->', begun);
  if (begun !== 'login_form') {
    console.log('  ⚠ 没拿到登录表单，可能已有会话。仍继续，但结论需谨慎。');
  }
  const result = await auth.login({ username, password, trustAgent: true });
  console.log('  login() ->', result.status, result.message ?? '');
  if (result.status !== AUTH_STATUS.READY) {
    console.log('  ✗ 教务登录未成功，后面的 SSO 结论无意义。');
    process.exitCode = 1;
    return;
  }

  const afterEhall = ticketReport(jar);
  console.log('\n  登录后罐子里的票据：');
  console.log(`    有 TGC:      ${afterEhall.hasTgc ? `是（域 ${afterEhall.tgcDomain}）` : '否'}`);
  console.log(`    有 CASTGC:   ${afterEhall.hasCastgc ? '是' : '否'}`);
  console.log(`    cookie 总数: ${afterEhall.count}`);
  console.log(`    涉及域名:    ${afterEhall.domains.join(', ')}`);

  if (!afterEhall.hasTgc) {
    console.log('\n  ⚠ 没有 TGC —— 说明这条链拿到的票据不足以驱动其它站点，SSO 不成立。');
  }

  rule('2. ★ 带着同一个罐子去学堂 —— SSO 成立吗');
  const lmsAuth = new CasAuth({ http, config, visitorId: generateVisitorId() });
  const lmsBegin = await lmsAuth.begin(LMS_URL);
  console.log('  begin(lms) ->', lmsBegin);
  console.log('  最终 URL 是否落在 /cas/login:', lmsAuth.lastUrl?.includes('/cas/login') ? '是（需要密码）' : '否');

  const ssoWorks = lmsBegin === AUTH_STATUS.READY;
  console.log(
    `\n  ${ssoWorks ? '★ 成立' : '✗ 不成立'}：` +
      (ssoWorks
        ? '学堂直接返回业务页 —— 共享罐子里的 TGC 生效，无需再输密码。'
        : '学堂仍要求登录 —— 两套协议没有共用票据，ensure() 需要退化为按站点单独登录。'),
  );

  rule('3. 反向再验一次（独立性检查）');
  // 用全新的罐子，先登录学堂，再访问教务 —— 避免被上一步的会话污染结论
  const jar2 = new CookieJar();
  const http2 = new HttpClient({ userAgent: UA, timeoutMs: 25_000, jar: jar2 });
  const lmsAuth2 = new CasAuth({ http: http2, config, visitorId: generateVisitorId() });
  const begun2 = await lmsAuth2.begin(LMS_URL);
  console.log('  新罐子 begin(lms) ->', begun2);
  if (begun2 === 'login_form') {
    const r2 = await lmsAuth2.login({ username, password, trustAgent: true });
    console.log('  新罐子 login(lms) ->', r2.status, r2.message ?? '');
    const t2 = ticketReport(jar2);
    console.log(`  学堂登录后有 TGC: ${t2.hasTgc ? `是（域 ${t2.tgcDomain}）` : '否'}`);
    if (r2.status === AUTH_STATUS.READY) {
      const ehallAuth2 = new CasAuth({ http: http2, config, visitorId: generateVisitorId() });
      const back = await ehallAuth2.begin(EHALL_LOGIN);
      console.log('  再 begin(教务) ->', back);
      console.log(`  ${back === AUTH_STATUS.READY ? '★ 反向也成立' : '✗ 反向不成立'}`);
    }
  } else {
    console.log('  （新罐子也已登录？可能命中了服务端会话，反向后结论需谨慎）');
  }

  rule('4. 结论');
  if (ssoWorks) {
    console.log('  → `ensure(site)` 可以走「共享罐子 + SSO」：登录一次，各站点自动完成认证。');
    console.log('  → 全局登录模块按原设计实现（每站点一个 CasAuth，共享 jar/http）。');
  } else {
    console.log('  → SSO 跨协议不生效。`ensure(site)` 退化为：');
    console.log('     用**同一份密码**为该站点单独走一次 CAS 登录（不保存密码，仅在登录那一刻用）。');
    console.log('  → 其余设计（站点注册表、共享罐子、设置卡、会话落盘）完全不变。');
  }

  // 票据写临时目录（不属于仓库），便于你复查；也在退出前提示它存在
  try {
    await mkdir(path.dirname(SESSION_FILE), { recursive: true });
    await writeFile(
      SESSION_FILE,
      `${JSON.stringify({ savedAt: new Date().toISOString(), cookies: jar.toJSON() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`\n（票据已写 ${SESSION_FILE}，仅本机临时目录；不需要就删掉它）`);
  } catch (error) {
    console.log('\n（票据未落盘：' + error.message + '）');
  }

  console.log('\n排查用的 cookie 名单（只有名字与域名，没有值）：');
  for (const item of cookieIndex(jar)) console.log('  ' + item);
}

await main();
