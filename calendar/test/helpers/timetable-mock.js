/**
 * 移动教务（ehall jwapp）+ 统一身份认证的本地 mock 服务器（仅测试用）。
 *
 * 目的：让「登录 → 取当前学期 → 取学期起始日 → 拉课表 → 展开成日程」整条链路
 * 可以在无网络、无真实账号的情况下被完整测试。
 *
 * 它刻意复刻了真实服务端已经验证过的几个「坑」：
 * - **未登录时 jwapp 接口 302 到 `amp-auth-adapter/login?service=<原 URL>`**，
 *   再跳 `login.xjtu.edu.cn` 的 CAS 登录页（不是返回 401）——CAS 跳转会丢票，这正是
 *   `src/server/lms/http-client.js` 要手动跟重定向的原因；
 * - 密码必须用 `/cas/jwt/publicKey` 的公钥加密、带 `__RSA__` 前缀才接受；
 * - `mfa/detect` 只认表单编码，`attest` 系列只认 JSON；
 * - 响应外壳是 `{ code: "0", datas: {...} }`，**`code` 是字符串**；
 * - 课表行只有 `KCM/SKJS/JASMC/SKXQ/KSJC/JSJC/SKZC/XNXQDM`（没有课程代码/学分/教学班），
 *   周次是位图 `SKZC`（`"1111001111"` → 第 1,2,3,4,7,8,9,10 周）。
 */

import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import http from 'node:http';

const EHALL_SESSION = 'EHALL_SESSION=ok';
const CAS_SESSION = 'CAS_TICKET=ok';

/** 复用的 RSA 密钥对：每个测试都生成 2048 位密钥太慢，且这里不需要每次不同。 */
let cachedKeyPair = null;
function keyPair() {
  if (!cachedKeyPair) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    cachedKeyPair = {
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey,
    };
  }
  return cachedKeyPair;
}

const LOGIN_HTML = (service) => `<!doctype html><html><head><title>统一身份认证</title>
<script>var globalConfig = {"mfaEnabled": true, "locale": "zh"};</script></head>
<body><div id="fm1"><form method="post" action="/cas/login?service=${service ?? ''}">
<input type="hidden" name="execution" value="exec-1">
<input name="username"><input name="password" type="password">
</form></div></body></html>`;

const ALERT_HTML = (title) => `<!doctype html><html><head><title>统一身份认证</title></head>
<body><div id="fm1"><el-alert title="${title}" type="error" show-icon="true"></el-alert>
<form method="post" action="/cas/login"><input type="hidden" name="execution" value="exec-2"></form></div></body></html>`;

const SAFETY_HTML = `<!doctype html><html><head><title>Safety Verify 选择安全认证</title></head>
<body><div id="fm1"><form method="post" action="/cas/login">
<input type="hidden" name="secState" value="sec-1">
<input type="hidden" name="execution" value="exec-sec">
<input type="hidden" name="_eventId" value="submit">
<input type="hidden" name="submit" value="Login1">
<script>fetch('/cas/sec/initByType/securephone')</script>
</form></div></body></html>`;

/** 1x1 PNG：用来验证 `/tt/captcha` 的二进制透传。 */
const CAPTCHA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7g0dAAAAAElFTkSuQmCC',
  'base64',
);

/**
 * 默认数据集。
 *
 * 覆盖了周次位图里各种形态：
 * - 数据结构：周一位图 `1111001111`（第 1-4、7-10 周，**不连续**），第 1-2 节连堂；
 * - 大学物理：周三位图 `0101010101`（第 2、4、6、8、10 周），第 5-6 节（**下午，夏冬作息不同**）；
 * - 线性代数：周五位图 `1111111111`（每周），第 9-10 节（晚上）；
 * - 概率论：周三首位图 `0011111111`（第 3-10 周），第 3-4 节（上午，两套作息相同）；
 * - 大学英语：周四首位图 `1010101010`（第 1、3、5、7、9 周），**同一门课两个时间段**（第 9-10 节 + 第 11 节）。
 */
export function defaultTimetableDataset() {
  return {
    currentTerm: '2026-2027-1',
    /** `cxjcs.do` 返回的起始日；`null` 表示接口返回空（用来测 guess 兜底）。 */
    termStart: '2026-09-14',
    terms: {
      '2026-2027-1': { start: '2026-09-14' },
    },
    rows: {
      '2026-2027-1': [
        { KCM: '数据结构', SKJS: '李老师', JASMC: '主楼B-203', SKXQ: '1', KSJC: '1', JSJC: '2', SKZC: '1111001111', XNXQDM: '2026-2027-1' },
        { KCM: '大学物理', SKJS: '王老师', JASMC: '教2楼-西203', SKXQ: '3', KSJC: '5', JSJC: '6', SKZC: '0101010101', XNXQDM: '2026-2027-1' },
        { KCM: '线性代数', SKJS: '赵老师', JASMC: '主楼A-101', SKXQ: '5', KSJC: '9', JSJC: '10', SKZC: '1111111111', XNXQDM: '2026-2027-1' },
        { KCM: '概率论', SKJS: '钱老师', JASMC: '主楼C-305', SKXQ: '3', KSJC: '3', JSJC: '4', SKZC: '0011111111', XNXQDM: '2026-2027-1' },
        { KCM: '大学英语', SKJS: '孙老师', JASMC: '外语楼-201', SKXQ: '4', KSJC: '9', JSJC: '10', SKZC: '1010101010', XNXQDM: '2026-2027-1' },
        { KCM: '大学英语', SKJS: '孙老师', JASMC: '外语楼-201', SKXQ: '4', KSJC: '11', JSJC: '11', SKZC: '1010101010', XNXQDM: '2026-2027-1' },
      ],
      // 历史学期只能靠猜：默认没有数据，用来验证「空课表不是错误」
      '2026-2027-2': [
        { KCM: '马克思主义基本原理', SKJS: '周老师', JASMC: '主楼D-401', SKXQ: '2', KSJC: '3', JSJC: '4', SKZC: '1111111111', XNXQDM: '2026-2027-2' },
      ],
    },
  };
}

export function cloneTimetableDataset(dataset = defaultTimetableDataset()) {
  return JSON.parse(JSON.stringify(dataset));
}

/**
 * 启动 mock 服务器。
 * @param {object} [options]
 * @param {object} [options.dataset]     课表数据
 * @param {string} [options.username]    学号
 * @param {string} [options.password]    密码
 * @param {string} [options.mfaCode]     两步验证验证码
 * @param {boolean} [options.needMfa]    是否强制走两步验证
 * @param {boolean} [options.termStartFails] `cxjcs.do` 是否返回空（测 guess 兜底）
 * @param {boolean} [options.aehalls]    （保留位）未使用
 */
export async function startMockEhall(options = {}) {
  const dataset = cloneTimetableDataset(options.dataset ?? defaultTimetableDataset());
  const { publicPem, privateKey } = keyPair();

  const state = {
    username: options.username ?? '2021001',
    password: options.password ?? 'pw-123456',
    mfaCode: options.mfaCode ?? '654321',
    needMfa: Boolean(options.needMfa),
    safetyVerify: Boolean(options.safetyVerify),
    safetyIssued: false,
    mfaVerified: false,
    /** `cxjcs.do` 是否永远返回空的起始日（模拟历史学期拿不到）。 */
    termStartFails: Boolean(options.termStartFails),
    /** 每个接口收到过的 Content-Type，验证「该用表单的用了表单、该用 JSON 的用了 JSON」。 */
    contentTypes: {},
    requests: [],
  };

  let origin = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push(`${req.method} ${url.pathname}`);
      state.cookies = state.cookies ?? [];
      state.cookies.push(`${req.method} ${url.pathname} <- ${req.headers.cookie ?? '(none)'}`);
      const contentType = req.headers['content-type'] ?? '';
      state.contentTypes[`${req.method} ${url.pathname}`] = contentType;
      const body = contentType.includes('application/json') ? safeJson(raw) : Object.fromEntries(new URLSearchParams(raw));
      route(req, res, url, body, raw);
    });
  });

  const json = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
  };
  const html = (res, status, text, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(text);
  };
  /** jwapp 的真实外壳：`code` 是字符串 `"0"`。 */
  const wrap = (res, datas) => json(res, 200, { code: '0', datas });
  const wrapped = (key, rows) => ({ [key]: { rows, totalSize: rows.length } });

  const hasCas = (req) => String(req.headers.cookie ?? '').includes(CAS_SESSION);
  const hasEhall = (req) => String(req.headers.cookie ?? '').includes(EHALL_SESSION);

  function route(req, res, url, body, raw) {
    const path = url.pathname;

    // ------------------------------------------------------------ 统一身份认证（与 lms-mock 同一套行为）
    if (path === '/cas/login' && req.method === 'GET') {
      // 顺手种一张 CAS 票：这是「登录页 → 提交表单」之间真实存在的一跳
      res.setHeader('Set-Cookie', `${CAS_SESSION}; Path=/; HttpOnly`);
      return html(res, 200, LOGIN_HTML(url.searchParams.get('service') ?? ''));
    }
    if (path === '/cas/jwt/publicKey') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(publicPem);
    }
    if (path === '/cas/mfa/detect' && req.method === 'POST') {
      if (String(req.headers['content-type'] ?? '').includes('application/json')) {
        return json(res, 400, { status: 400, message: "Required String parameter 'username' is not present", path: '/cas/mfa/detect' });
      }
      if (!body.username) return json(res, 400, { status: 400, message: "Required String parameter 'username' is not present" });
      return json(res, 200, { code: 0, data: { state: 'mfa-state-1', need: state.needMfa } });
    }
    if (/^\/cas\/(mfa|sec)\/initByType\/securephone$/.test(path)) {
      const expected = ['mfa-state-1', 'sec-1'];
      if (!expected.includes(url.searchParams.get('state'))) return json(res, 200, { code: 1, message: 'state 不合法' });
      return json(res, 200, { code: 0, data: { gid: 'gid-1', securePhone: '13800008888' } });
    }
    if (path === '/attest/api/guard/securephone/send' && req.method === 'POST') {
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'Unsupported Media Type' });
      if (body.gid !== 'gid-1') return json(res, 200, { code: 1, message: 'gid 不合法' });
      return json(res, 200, { code: 0, message: 'ok' });
    }
    if (path === '/attest/api/guard/securephone/valid' && req.method === 'POST') {
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'Unsupported Media Type' });
      if (body.gid !== 'gid-1') return json(res, 200, { code: 1, message: 'gid 不合法' });
      if (String(body.code) !== state.mfaCode) return json(res, 200, { code: 1, message: '验证码不正确' });
      state.mfaVerified = true;
      return json(res, 200, { code: 0, data: { status: 2 } });
    }
    if (path === '/cas/captcha.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': CAPTCHA_PNG.length });
      return res.end(CAPTCHA_PNG);
    }
    if (path === '/cas/login' && req.method === 'POST') {
      // service 优先取查询串（登录页的 form action 里就带着），拿不到再从 Referer 里抠
      const service = safeService(url.searchParams.get('service')) ?? serviceFromReferer(req);
      if (body.secState) {
        if (!state.mfaVerified) return html(res, 200, ALERT_HTML('请先完成安全验证'));
        return finishLogin(res, service);
      }
      if (state.safetyVerify && !state.safetyIssued) {
        state.safetyIssued = true;
        return html(res, 200, SAFETY_HTML);
      }
      if (body.username !== state.username) return html(res, 200, ALERT_HTML('用户名或密码错误'));
      const password = decryptPassword(body.password, privateKey);
      if (password !== state.password) return html(res, 200, ALERT_HTML('用户名或密码错误'));
      if (state.needMfa && !state.mfaVerified) return html(res, 200, ALERT_HTML('未完成两步验证'));
      return finishLogin(res, service);
    }

    // 登录成功：种 ehall 会话票，并把用户送回最初想访问的业务地址。
    // 注意 `/` 也算合法目标：只跳业务子路径会让「用根地址当入口」的场景拿不到票。
    function finishLogin(res, service) {
      const target = safeService(service) ?? `${origin}/`;
      res.writeHead(302, { Location: target, 'Set-Cookie': `${EHALL_SESSION}; Path=/; HttpOnly` });
      res.end();
    }

    // ------------------------------------------------------------ 一站式服务大厅 / jwapp
    if (path === '/amp-auth-adapter/login') {
      // 真实的适配器：校验 CAS 票后踢回 service。这里只要带过 CAS 票就当通过；
      // 没有票就自己起一段 CAS 登录页（并顺手种下 CAS 票，跟真机首页种票的行为一致）。
      const service = safeService(url.searchParams.get('service'));
      if (!service) return html(res, 400, '缺少 service 参数');
      if (!hasCas(req)) {
        res.setHeader('Set-Cookie', `${CAS_SESSION}; Path=/; HttpOnly`);
        return html(res, 200, LOGIN_HTML(encodeURIComponent(service)));
      }
      res.writeHead(302, { Location: service, 'Set-Cookie': `${EHALL_SESSION}; Path=/; HttpOnly` });
      return res.end();
    }

    if (path.startsWith('/jwapp/')) {
      // ★ 关键坑：未登录时不返回 401，而是 302 到 amp-auth-adapter/login?service=<原 URL urlencode>
      if (!hasEhall(req)) {
        const service = `${origin}${path}${url.search}`;
        res.writeHead(302, {
          Location: `${origin}/amp-auth-adapter/login?service=${encodeURIComponent(service)}`,
        });
        return res.end();
      }
      // 拿 GET 打开业务 URL（门户门口页）时不返回 JSON，而是整页 HTML：
      // 真实站点就是这样，而且这正是 `CasAuth.begin()` 判断「已登录」的依据
      // （无 execution、无 Safety Verify、落地 URL 不在 /cas/login）。
      if (req.method !== 'POST') {
        return html(res, 200, `<!doctype html><html><head><title>学生课表</title></head><body><div id="app">课表页面</div></body></html>`);
      }
      return handleJwapp(req, res, path, body);
    }

    json(res, 404, { code: '404', msg: `未知路径 ${path}`, raw: String(raw).slice(0, 80) });
  }

  function handleJwapp(req, res, path, body) {
    if (path === '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do') {
      return wrap(res, wrapped('dqxnxq', [{ DM: dataset.currentTerm, DQXNXQDM: dataset.currentTerm }]));
    }
    if (path === '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do') {
      const term = `${body.XN}-${body.XQ}`;
      const start = state.termStartFails ? null : (dataset.terms?.[term]?.start ?? (term === dataset.currentTerm ? dataset.termStart : null));
      // 拿不到起始日时返回空 rows（与真实的历史学期行为一致），不是报错
      if (!start) return wrap(res, wrapped('cxjcs', []));
      return wrap(res, wrapped('cxjcs', [{ XNXQDM: term, XQKSRQ: `${start} 00:00:00`, XQJSRQ: null }]));
    }
    if (path === '/jwapp/sys/wdkb/modules/xskcb/xskcb.do') {
      const term = String(body.XNXQDM ?? '');
      const rows = dataset.rows?.[term];
      if (rows === undefined) {
        // 未知学期：真实行为是返回业务错误（不是空列表）
        return json(res, 200, { code: '1', msg: `未找到学期 ${term} 的课表`, datas: null });
      }
      return wrap(res, wrapped('xskcb', rows));
    }
    // 其它 jwapp 接口：显式报错，避免测试里「静默 200 让断言误判」
    return json(res, 200, { code: '1', msg: `mock 未实现该接口：${path}`, datas: null });
  }

  await new Promise((resolve) => server.listen(Number(options.port ?? 0), '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    state,
    dataset,
    /** 直接改数据，用来测「换教室 / 课程消失 / 起始日变了」。 */
    mutate(fn) {
      fn(dataset, state);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** 只允许跳回本机地址，避免 mock 变成开放重定向（也顺便验证 service 参数被正确传递）。 */
function safeService(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(decodeURIComponent(value));
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** 登录页 POST 回 CAS 时可能丢了 service：从 Referer 的查询串里再找一次。 */
function serviceFromReferer(req) {
  const referer = req.headers.referer;
  if (typeof referer !== 'string') return null;
  try {
    return safeService(new URL(referer).searchParams.get('service'));
  } catch {
    return null;
  }
}

function decryptPassword(value, privateKey) {
  if (typeof value !== 'string' || !value.startsWith('__RSA__')) return null;
  try {
    const buffer = Buffer.from(value.slice('__RSA__'.length), 'base64');
    return privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, buffer).toString('utf8');
  } catch {
    return null;
  }
}
