/**
 * 「一个 CAS + 两个业务站点」的本地 mock（仅测试用）。
 *
 * 为什么需要它：`lms-mock` 与 `ehall-mock` 各自是**独立**的单源服务，
 * 没法验证「登录 A 站点后 B 站点也能用」这件事 —— 而那正是全局认证的核心。
 * 本文件把学校真实的三方关系缩小复刻出来：
 *
 *   一个 CAS（模拟 login.xjtu.edu.cn + Keycloak 的 TGC）
 *     ├─ 站点 a（模拟思源学堂，经典 CAS）
 *     └─ 站点 b（模拟教务，OAuth2 风格）
 *
 * **SSO 的关键机制在这里是被真实实现的**，不是假装：
 *   1. CAS 登录成功 → 在 `/` 上种 `TGC` cookie；
 *   2. 之后访问站点 b 时没有它自己的会话 → 302 到 `/cas/login?service=…`；
 *   3. CAS **看到 TGC 就直接发 ticket**（不再要密码）→ 302 回站点 b 带 `?ticket=ST-n`；
 *   4. 站点 b 校验 ticket → 种下自己的会话 cookie → 302 回干净 URL → 200。
 *
 * 于是「共享 Cookie 罐 ⇒ 登录一次两边都通」在测试里是被**强制执行**的：
 * 如果有人把共享罐改成各自一个，这些用例会立刻红。
 *
 * `requiresPassword: true` 的站点用来模拟"SSO 对它不生效"，
 * 验证降级路径（只能单独登录）。
 */

import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import http from 'node:http';

const LOGIN_HTML = `<!doctype html><html><head><title>登录 - 西安交通大学统一身份认证网关</title>
<script>var globalConfig = {"mfaEnabled": true, "locale": "zh"};</script></head>
<body><div id="fm1"><form method="post" action="/cas/login">
<input type="hidden" name="execution" value="exec-1">
<input name="username"><input name="password" type="password">
</form></div></body></html>`;

const ALERT_HTML = (title) => `<!doctype html><html><head><title>统一身份认证</title></head>
<body><div id="fm1"><el-alert title="${title}" type="error" show-icon="true"></el-alert>
<form method="post" action="/cas/login"><input type="hidden" name="execution" value="exec-2"></form></div></body></html>`;

const businessHtml = (site, user) => `<!doctype html><html><head><title>${site.title}</title></head>
<body><h1>${site.title}</h1><p>已登录：${user}</p></body></html>`;

/**
 * @param {object} [options]
 * @param {boolean} [options.siteBRequiresPassword] 让站点 b 不接受 SSO（模拟协议不兼容）
 * @param {boolean} [options.needMfa] 登录时要求短信验证码
 */
export async function startMockSso(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /** 两个业务站点。路径是它们各自的「登录入口」。 */
  const sites = {
    a: { id: 'a', title: '站点A（模拟思源学堂）', path: '/site-a/', cookie: 'SESSION_A' },
    b: { id: 'b', title: '站点B（模拟教务）', path: '/site-b/', cookie: 'SESSION_B' },
  };
  if (options.siteBRequiresPassword) sites.b.requiresPassword = true;

  const state = {
    requests: [],
    /** 已签发的 TGC */
    tgc: null,
    /** 已签发但未使用的 ticket */
    tickets: new Map(),
    ticketSeq: 0,
    /** 密码登录成功次数 —— 断言「SSO 没有再要一次密码」时用它 */
    passwordLogins: 0,
    /** 因 TGC 而免密发 ticket 的次数 —— 这就是 SSO 生效的直接证据 */
    ssoTickets: 0,
    mfaSent: false,
    mfaVerified: false,
    username: options.username ?? '2024001',
    password: options.password ?? 'secret-pass',
    /** 账号信息页里的姓名，用来断言"登录后姓名显示出来了"。 */
    displayName: options.displayName ?? '张三',
  };

  const origin = { value: '' };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, origin.value || 'http://127.0.0.1');
      const path = url.pathname;
      state.requests.push(`${req.method} ${path}`);

      // 真机上这两种 content-type 都存在：CAS 登录表单是 form-urlencoded，
      // 而短信验证码那两个端点（send / valid）收的是 JSON。
      // 只解 form 会让 `body.code` 永远是 undefined，表现为"验证码不正确"。
      const contentType = String(req.headers['content-type'] ?? '');
      let body;
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = {};
        }
      } else {
        body = Object.fromEntries(new URLSearchParams(raw).entries());
      }
      const cookies = parseCookies(req.headers.cookie);
      const hasTgc = Boolean(cookies.TGC) && cookies.TGC === state.tgc;

      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(payload));
      };
      const html = (code, text, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'text/html;charset=UTF-8', ...headers });
        res.end(text);
      };
      const redirect = (location, headers = {}) => {
        res.writeHead(302, { Location: location, ...headers });
        res.end();
      };

      // ------------------------------------------------------------ 学堂的账号信息页
      // `LmsApi.userInfo()` 打的是 `${baseUrl}/user/index`，并从页面里解析 user/dept 的 JS 对象。
      // 加上它是为了让「从设置页登录后，学堂页能不能显示姓名」这件事可测 ——
      // 那是"模块本地状态没跟共享认证同步"的又一个表现（曾经显示成"未获取到姓名"）。
      if (path === `${sites.a.path}user/index`) {
        if (cookies[sites.a.cookie] !== 'ok') {
          return redirect(`${origin.value}/cas/login?service=${encodeURIComponent(sites.a.path)}`);
        }
        return html(
          200,
          `<!doctype html><html><head><title>思源学堂</title></head><body><script>
    window.globalData = {
      user: { id: 9001, name: "${state.displayName}", userNo: "${state.username}", role: "Student", orgName: "思源学堂2.0", hasAiAbility: true },
      dept: { id: 12, name: "测试学院", code: "DX" },
      locale: "zh-CN"
    };
  </script></body></html>`,
        );
      }

      // ------------------------------------------------------------ 业务站点
      // 按路径匹配站点时**容忍尾斜杠**：真实配置里的 URL 常被去掉尾斜杠
      // （resolveLmsConfig 就会 replace(/\/+$/, '')），而 mock 的 path 是带斜杠的。
      // 不归一的话 `/site-a` 匹配不上 `/site-a/`，会掉到下面的 CAS 分支拿到 404，
      // 而 404 页面没有登录表单，`begin()` 会把它当成"业务页"→ 误判成已登录。
      const normalized = path.endsWith('/') ? path : `${path}/`;
      const site = Object.values(sites).find(
        (item) => normalized === item.path || normalized.startsWith(item.path),
      );
      if (site) {
        if (cookies[site.cookie] === 'ok') {
          return html(200, businessHtml(site, state.username));
        }
        // 带 ticket 回来：校验并发自己站点的会话
        const ticket = url.searchParams.get('ticket');
        if (ticket && state.tickets.has(ticket)) {
          state.tickets.delete(ticket);
          return redirect(site.path, { 'Set-Cookie': `${site.cookie}=ok; Path=/` });
        }
        // 没有本会话：看能不能靠 CAS 的 TGC 免密换票（这就是 SSO）
        if (hasTgc && !site.requiresPassword) {
          state.ticketSeq += 1;
          const fresh = `ST-${state.ticketSeq}`;
          state.tickets.set(fresh, { site: site.id, via: 'tgc' });
          state.ssoTickets += 1;
          const back = new URL(`${origin.value}${site.path}`);
          back.searchParams.set('ticket', fresh);
          return redirect(back.href);
        }
        // 否则去登录
        return redirect(`${origin.value}/cas/login?service=${encodeURIComponent(site.path)}`);
      }

      // ------------------------------------------------------------ CAS
      if (path === '/cas/login' && req.method === 'GET') return html(200, LOGIN_HTML);
      if (path === '/cas/jwt/publicKey') {
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
        return res.end(publicKey);
      }
      if (path === '/cas/mfa/detect' && req.method === 'POST') {
        if (String(req.headers['content-type'] ?? '').includes('application/json')) {
          return json(400, { timestamp: Date.now(), status: 400, message: "Required String parameter 'username' is not present" });
        }
        if (!body.username) return json(400, { status: 400, message: "Required String parameter 'username' is not present" });
        if (options.needMfa && !state.mfaVerified) {
          return json(200, { code: 0, data: { state: 'mfa-state-1', need: true } });
        }
        return json(200, { code: 0, data: { state: 'mfa-state-1', need: false } });
      }
      if (/^\/cas\/(mfa|sec)\/initByType\/securephone$/.test(path)) {
        return json(200, { code: 0, data: { gid: 'gid-1', securePhone: '13800008888' } });
      }
      if (path === '/attest/api/guard/securephone/send' && req.method === 'POST') {
        state.mfaSent = true;
        return json(200, { code: 0, message: 'ok' });
      }
      if (path === '/attest/api/guard/securephone/valid' && req.method === 'POST') {
        if (String(body.code) !== (options.mfaCode ?? '123456')) return json(200, { code: 1, message: '验证码不正确' });
        state.mfaVerified = true;
        return json(200, { code: 0, data: { status: 2 } });
      }
      if (path === '/cas/captcha.jpg') {
        // 1x1 PNG：只需要是合法图片，用来验证二进制透传（`__raw`）没被 JSON 包一层
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7g0dAAAAAElFTkSuQmCC',
          'base64',
        );
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        return res.end(png);
      }
      if (path === '/cas/login' && req.method === 'POST') {
        if (options.needMfa && !state.mfaVerified) return html(200, ALERT_HTML('未完成两步验证'));
        let password = body.password ?? '';
        if (password.startsWith('__RSA__')) {
          try {
            password = privateDecrypt(
              { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
              Buffer.from(password.slice('__RSA__'.length), 'base64'),
            ).toString('utf8');
          } catch {
            return html(200, ALERT_HTML('用户名或密码错误'));
          }
        }
        if (body.username !== state.username || password !== state.password) {
          return html(200, ALERT_HTML('用户名或密码错误'));
        }
        state.passwordLogins += 1;
        state.tgc = `TGC-${state.passwordLogins}`;
        // 真实 CAS 的行为：登录成功后**签发一张 service 专属的 ticket**，
        // 并把 ticket 拼在 service 后面跳回去；由目标站点校验 ticket 后才种自己的会话。
        // 少了这一步，`requiresPassword` 的站点永远登不进去（它会一直看到登录页）。
        const service = url.searchParams.get('service') ?? '/';
        state.ticketSeq += 1;
        const ticket = `ST-${state.ticketSeq}`;
        state.tickets.set(ticket, { site: 'cas-login', via: 'password' });
        const target = new URL(service.startsWith('http') ? service : `${origin.value}${service}`);
        target.searchParams.set('ticket', ticket);
        return redirect(target.href, { 'Set-Cookie': `TGC=${state.tgc}; Path=/; HttpOnly` });
      }

      return json(404, { code: '404' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  origin.value = `http://127.0.0.1:${port}`;

  return {
    origin: origin.value,
    state,
    sites,
    /** 站点 a 的登录 URL（业务入口） */
    get siteAUrl() {
      return `${origin.value}${sites.a.path}`;
    },
    get siteBUrl() {
      return `${origin.value}${sites.b.path}`;
    },
    /** 直接给 auth 模块用的配置 */
    config(extra = {}) {
      return { casOrigin: origin.value, ...extra };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}
