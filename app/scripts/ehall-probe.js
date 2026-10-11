#!/usr/bin/env node
/**
 * 教务（ehall / jwxt）成绩接口 —— 真机侦察脚本。
 *
 * 目的：把「成绩查询打在哪个路径、返回什么字段」问清楚，避免照着猜的字段名写代码。
 * 它复用思源学堂那套**已在真实站点验证过**的认证与 HTTP 客户端。
 *
 * 用法
 * ----
 *   # Windows PowerShell
 *   $env:PC_EHALL_USER='<学号>'; $env:PC_EHALL_PASS='<密码>'; node scripts/ehall-probe.js
 *   # macOS / Linux
 *   PC_EHALL_USER='<学号>' PC_EHALL_PASS='<密码>' node scripts/ehall-probe.js
 *
 * 不给环境变量则交互式掩码输入。加 `--values` 会打印真实取值（姓名/学号一类键仍自动打码），
 * **那份输出不要粘进任何提交物**。
 *
 * 安全约定
 * --------
 * 1. 凭据只从环境变量或终端读取，**从不写入任何文件**；
 * 2. 会话票据写在系统临时目录（`pc-ehall-probe-session.json`），**不写进仓库**；
 * 3. 默认脱敏输出；`docs/教务成绩接口调研.md` 只记录字段名与结论，不含任何真实值。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 已对本校真实站点验证过的事实（2026 年，逐条实测）
 * ─────────────────────────────────────────────────────────────────────
 * 1. **门户页不能当登录入口**
 *    `/new/index.html?browser=no` 是纯静态 SPA 外壳：未登录也返回 200、0 次跳转、页面里
 *    没有 `execution` 令牌，会让 `CasAuth.begin()` **误判成「已登录」**并跳过登录。
 *    必须拿 **jwapp 业务 URL** 当入口，它会走完整的 4 跳 OAuth2 链落到 CAS 登录页：
 *      jwapp 业务 URL
 *        → ehall.xjtu.edu.cn/amp-auth-adapter/login?service=…
 *        → org.xjtu.edu.cn/openplatform/oauth/authorize?appId=1030&redirectUri=…
 *        → login.xjtu.edu.cn/cas/oauth2.0/authorize?response_type=code&client_id=1030&…
 *        → login.xjtu.edu.cn/cas/login?service=…%2Fcas%2Foauth2.0%2FcallbackAuthorize…
 *    登录成功后 cookie 落在 `.xjtu.edu.cn` 范围内的 ehall 域上。
 *
 * 2. **两个主机**
 *    - `ehall.xjtu.edu.cn` —— 一站式服务大厅（门户、应用中心、`/jsonp/*` 都在这里）
 *    - `jwxt.xjtu.edu.cn`  —— **真正的教务系统**；应用外壳的 `_JW_INIT_CONFIG.indexLogoUrl`
 *      指向它。模块接口在两边都能打，但 jwxt 需要先用一次 GET 建立会话，否则返回 **401**。
 *
 * 3. **模块接口形态**：`POST /jwapp/sys/<appId>/modules/<moduleId>/<action>.do`
 *    响应外壳 `{ code, datas }`，**`code` 是字符串 `"0"`**（不是数字 0）。
 *
 * 4. **403 与 200 的区别 = 应用授权**（对照组实测）：
 *      homeapp   → 200 {"code":"404"}   （动作名不对，但应用可访问）
 *      kcbcx     → 200 {"code":"404"}   （我的课表：已授权）
 *      cjcx      → 403                  （成绩查询：被拒）
 *    即 403 不是登录问题、也不是路径问题，而是**该账号对 cjcx 应用没有数据接口权限**。
 *    门户会为这类应用给出申请入口：
 *      /sys/funauthapp/qxgl.do?min=1&appName=cjcx&appId=…&needFlow=true
 *
 * 5. **门户 API 映射**：`GET /jsonp/constant.json` 返回 `AMPConstant.APIList`（65 项）。
 *    `GET /jsonp/myAppService.json` 返回账号的「我的应用」（`allFavorite.appList`）。
 *    `GET /jsonp/userDesktopInfo.json` 返回账号与桌面。
 *
 * 6. **已知过时的路径**：课表模块文档里的 `/jwapp/sys/wdkb/modules/xskcb/xskcb.do` 用的
 *    `wdkb` 应用**已不存在** —— 现在「我的课表」是 `kcbcx`。上游改 appId 是常态，
 *    所以路径一律集中在 `modules/academic/config.js`，不要散落在业务代码里。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { AUTH_STATUS, CasAuth } from '../src/modules/lms/cas-auth.js';
import { CookieJar, HttpClient } from '../src/modules/lms/http-client.js';
import { resolveLmsConfig } from '../src/modules/lms/config.js';

const EHALL = 'https://ehall.xjtu.edu.cn';
const JWXT = 'https://jwxt.xjtu.edu.cn';
const PORTAL_URL = `${EHALL}/new/index.html?browser=no`;

/**
 * 登录入口：必须是 **jwapp 业务 URL**（见上文事实 1）。
 * 这里用一个稳定的 jwapp 路径即可 —— 它的作用只是把 CAS 链引出来。
 */
const LOGIN_ENTRY = `${EHALL}/jwapp/sys/wdkb/modules/xskcb/xskcb.do`;

/** 已确认存在的教务应用（appId 来自门户 `/jsonp/serviceCenterApp.json`）。 */
const APPS = {
  cjcx: { label: '成绩查询', appId: '4768574631264620', module: 'cjcx' },
  kcbcx: { label: '我的课表', appId: '4770397878132218', module: 'kcbcx' },
  bycjcxXjtu: { label: '本研成绩查询', appId: '5591103004184670', module: 'bycjcxXjtu' },
  xywccx: { label: '学业完成查询', appId: '4980269146247992', module: 'xywccx' },
  homeapp: { label: '（公共应用，对照组）', appId: '', module: 'appcenter' },
};

/** 成绩接口的候选动作名（Wisedu jwapp 常见命名，逐个试）。 */
const GRADES_ACTIONS = [
  'cxXscj.do',
  'cxXscjList.do',
  'cxAllXscj.do',
  'cxXscjByXnXq.do',
  'queryXscj.do',
  'getXscj.do',
  'cxCj.do',
  'cxXsxxcj.do',
];

const SESSION_FILE = path.join(os.tmpdir(), 'pc-ehall-probe-session.json');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SHOW_VALUES = process.argv.includes('--values');

const line = (label, value) => console.log(`${String(label).padEnd(26, ' ')} ${value}`);
const rule = (title) => console.log(`\n${'═'.repeat(10)} ${title} ${'═'.repeat(10)}`);

// ------------------------------------------------------------------ 脱敏

/** 键名像「姓名 / 学号 / 证件 / 手机 / 密码」的一律打码。 */
const SENSITIVE_KEY = /name|xm$|^xm|xh$|^xh|sfzh|zjhm|idcard|phone|sjh|mobile|password|pwd|email|userid|creator/i;

function scalar(key, value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return SENSITIVE_KEY.test(key) ? '<number>' : String(value);
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key) || !SHOW_VALUES) return `<string len=${value.length}>`;
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  return `<${typeof value}>`;
}

/** 把结构压成「字段名 + 类型」的树；数组只看第一项。 */
function describe(value, depth = 0, key = '') {
  const pad = '  '.repeat(depth);
  if (value === null || typeof value !== 'object') return scalar(key, value);
  if (Array.isArray(value)) {
    if (!value.length) return '[] (空数组)';
    return `[ ${value.length} 项 ]\n${pad}  └─ ${describe(value[0], depth + 1, key)}`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{} (空对象)';
  return entries.map(([k, v]) => `${pad}  ${k}: ${describe(v, depth + 1, k)}`).join('\n');
}

// ------------------------------------------------------------------ 交互输入

function ask(question, { mask = false } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error(`需要交互输入「${question}」，但当前不是终端 —— 请把值放进环境变量后重跑`);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      const original = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = (text) => {
        if (text.includes(question)) (original ?? rl.output.write.bind(rl.output))(text);
        else rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// ------------------------------------------------------------------ 登录

async function restoreSession(http) {
  try {
    const info = await stat(SESSION_FILE);
    if (Date.now() - info.mtimeMs > SESSION_MAX_AGE_MS) return false;
    const saved = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    if (!saved?.cookies?.length) return false;
    http.jar = CookieJar.fromJSON(saved.cookies);
    line('复用会话', `是（${saved.cookies.length} 个 cookie）`);
    return true;
  } catch {
    return false;
  }
}

async function saveSession(http) {
  try {
    await mkdir(path.dirname(SESSION_FILE), { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: http.jar.toJSON() }, null, 2), 'utf8');
    line('会话已保存', `（系统临时目录，不进仓库）`);
  } catch (error) {
    line('会话保存失败', error.message);
  }
}

async function login(auth) {
  const state = await auth.begin(LOGIN_ENTRY);
  line('begin()', state);
  if (state === AUTH_STATUS.READY) return true;

  let username = process.env.PC_EHALL_USER?.trim() ?? '';
  let password = process.env.PC_EHALL_PASS ?? '';
  line('凭据来源', username && password ? '环境变量' : '终端输入（掩码）');
  if (!username) username = await ask('学号 / 工号: ');
  if (!password) password = await ask('密码（不回显）: ', { mask: true });

  const result = await auth.login({ username, password, trustAgent: true });
  line('login()', `${result.status}${result.message ? ` — ${result.message}` : ''}`);

  if (result.status === AUTH_STATUS.NEED_MFA) {
    const sent = await auth.sendMfaCode().catch((error) => ({ error: error.message }));
    if (sent.error) {
      line('发送验证码失败', sent.error);
      return false;
    }
    line('验证码已发送至', sent.phoneMasked ?? sent.phone ?? '（未知）');
    await auth.verifyMfaCode(await ask('短信验证码: '));
    const after = await auth.login({});
    line('验证后 login()', after.status);
    return after.status === AUTH_STATUS.READY;
  }

  if (result.status === AUTH_STATUS.NEED_CAPTCHA) {
    const captcha = await auth.fetchCaptcha();
    const file = path.join(os.tmpdir(), 'pc-ehall-captcha.jpg');
    await writeFile(file, Buffer.from(captcha.bytes));
    line('图形验证码', `已存至 ${file}（自己看一眼，不要提交）`);
    const retry = await auth.login({ username, password, captcha: await ask('图形验证码: '), trustAgent: true });
    line('带验证码 login()', retry.status);
    return retry.status === AUTH_STATUS.READY;
  }

  return result.status === AUTH_STATUS.READY;
}

// ------------------------------------------------------------------ jwapp 探测

/** 会话 cookie 是分域的：打 jwxt 之前先 GET 一次，否则会拿到 401。 */
async function warmUp(http, host) {
  try {
    await http.get(`${host}/`, { follow: true });
  } catch {
    /* 预热失败就让后续请求自己暴露问题 */
  }
}

/**
 * POST 一个 jwapp 模块接口并回报结构。
 * @returns {Promise<{state:'ok'|'denied'|'unauth'|'missing'|'error', text:string, datas?:object}>}
 */
async function probeJwapp(http, host, appKey, moduleId, action, fields = {}) {
  await warmUp(http, host);
  const url = `${host}/jwapp/sys/${appKey}/modules/${moduleId}/${action}`;
  let response;
  try {
    response = await http.postForm(url, fields, {
      follow: true,
      headers: {
        Referer: `${host}/jwapp/sys/${appKey}/*default/index.do`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
        Origin: host,
      },
    });
  } catch (error) {
    return { state: 'error', text: `请求失败：${error.message}` };
  }

  if (/\/cas\/login|login\.xjtu\.edu\.cn/.test(response.url)) return { state: 'unauth', text: `被踢回登录页` };
  if (response.status === 401) return { state: 'unauth', text: 'HTTP 401（该主机会话未建立）' };
  if (response.status === 403) return { state: 'denied', text: 'HTTP 403（应用未授权 / 无该接口权限）' };
  if (response.status < 200 || response.status >= 300) return { state: 'error', text: `HTTP ${response.status}` };

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { state: 'error', text: `非 JSON：${response.text.replace(/\s+/g, ' ').slice(0, 90)}` };
  }
  const code = parsed?.code;
  if (String(code) !== '0') return { state: 'missing', text: `code=${JSON.stringify(code)}（${parsed?.msg ?? parsed?.message ?? '无消息'}）` };
  if (!parsed?.datas || typeof parsed.datas !== 'object') return { state: 'missing', text: '缺少 datas 字段' };
  return { state: 'ok', text: `code="0"，datas 键：${Object.keys(parsed.datas).join(', ') || '（无）'}`, datas: parsed.datas };
}

// ------------------------------------------------------------------ 主流程

const lmsConfig = resolveLmsConfig();
const config = {
  baseUrl: EHALL,
  casOrigin: lmsConfig.casOrigin,
  userAgent: lmsConfig.userAgent,
  timeoutMs: Number(process.env.PC_EHALL_TIMEOUT_MS) || 25_000,
};

console.log('教务成绩接口真机侦察');
line('登录入口', LOGIN_ENTRY);
line('教务主机', `${EHALL}（门户） / ${JWXT}（教务）`);
line('端口用态', SHOW_VALUES ? '含真实值（不要提交输出）' : '脱敏（只打字段名与类型）');

const http = new HttpClient({ userAgent: config.userAgent, timeoutMs: config.timeoutMs, jar: new CookieJar() });
const auth = new CasAuth({ http, config });

rule('1. 会话与登录');
const restored = await restoreSession(http);
if (restored) {
  const state = await auth.begin(LOGIN_ENTRY);
  line('复用后 begin()', state);
}
if ((await auth.begin(LOGIN_ENTRY)) !== AUTH_STATUS.READY) {
  let ok = false;
  try {
    ok = await login(auth);
  } catch (error) {
    line('登录中断', error.message);
    process.exitCode = 1;
    process.exit();
  }
  if (!ok) {
    console.log('\n登录未完成。先跑 `node scripts/lms-probe.js` 判断是环境问题还是账号问题。');
    process.exitCode = 1;
    process.exit();
  }
}
await saveSession(http);

rule('2. 应用授权预检（403 还是 200）');
/**
 * 这一步是整份脚本的关键：403 与 200 的差别**不是路径对不对，而是应用有没有授权**。
 * 已实测：项目里课表模块记的 `wdkb` 应用已不存在，现在叫 `kcbcx`。
 */
const preflight = [
  ['homeapp', 'appcenter', 'getAppList.do', EHALL],
  ['kcbcx', 'kcbcx', 'query.do', EHALL],
  ['cjcx', 'cjcx', 'cxXscj.do', EHALL],
];
const verdict = {};
for (const [appKey, moduleId, action, host] of preflight) {
  const out = await probeJwapp(http, host, appKey, moduleId, action);
  verdict[appKey] = out.state;
  const mark = out.state === 'denied' ? '✗' : out.state === 'ok' ? '★' : '·';
  console.log(`  ${mark} ${appKey.padEnd(10)} ${String(out.state).padEnd(9)} ${out.text.slice(0, 80)}`);
}
const cjcxDenied = verdict.cjcx === 'denied';
if (cjcxDenied) {
  console.log('\n  ⚠ 结论：本账号对 cjcx（成绩查询）返回 403，而 homeapp / kcbcx 正常。');
  console.log('    这说明**登录与路径都没问题，是该账号没有 cjcx 的数据接口权限**。');
  console.log('    门户给出的申请入口形如：');
  console.log(`      ${EHALL}/sys/funauthapp/qxgl.do?min=1&appName=cjcx&appId=${APPS.cjcx.appId}&needFlow=true`);
  console.log('    处理方式：用这个账号登录门户 → 打开「成绩查询」→ 按提示申请/开通，然后重跑本脚本。');
}

rule('3. 账号可用的应用（门户 myAppService.json）');
try {
  const mine = await http.json(`${EHALL}/jsonp/myAppService.json`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*' },
  });
  const buckets = mine?.allFavorite?.appList ?? {};
  for (const [bucket, list] of Object.entries(buckets)) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) continue;
    console.log(`  [${bucket}] ${arr.length} 个`);
    for (const app of arr.slice(0, 20)) console.log(`      ${String(app.appName ?? '?').padEnd(16)} appId=${app.appId}`);
  }
} catch (error) {
  line('读取失败', error.message);
}

rule('4. 逐个尝试成绩接口动作');
let hits = 0;
for (const action of GRADES_ACTIONS) {
  const out = await probeJwapp(http, EHALL, 'cjcx', 'cjcx', action);
  const mark = out.state === 'ok' ? '★' : out.state === 'denied' ? '✗' : '·';
  console.log(`  ${mark} ${action.padEnd(20)} ${out.text.slice(0, 90)}`);
  if (out.state !== 'ok') continue;
  hits += 1;
  console.log('      ── datas 结构 ──');
  console.log(
    describe(out.datas)
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  );
}

rule('5. 结论');
if (hits) {
  console.log(`命中 ${hits} 个可用动作。下一步：把动作名与字段名填进 modules/academic/config.js 的 EHALL_PATHS / FIELD_ALIASES。`);
} else if (cjcxDenied) {
  console.log('未命中，且已确认原因是 cjcx 应用未授权（见第 2 步）—— 不是路径问题，先把权限开通再重跑。');
} else {
  console.log('未命中。cjcx 未被拒绝，说明是动作名不对：');
  console.log('  在浏览器登录教务 → 打开成绩查询 → F12 Network 里找 .do 请求，把动作名加进 GRADES_ACTIONS。');
}
