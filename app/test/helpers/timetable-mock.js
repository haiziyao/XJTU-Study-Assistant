/**
 * 教务课表（`jwapp/sys/wdkb`）+ 统一身份认证的本地 mock（仅测试用，零真实外网）。
 *
 * 它刻意复刻真机上会踩的几件事：
 * 1. **未登录时 jwapp 接口 302 到 `/cas/login?service=…`**（不是 401）——
 *    所以「未登录被误判成没有课」这条缺陷会在测试里被强制执行；
 * 2. 登录页带 `execution` 与 `mfaEnabled`，密码必须用 `/cas/jwt/publicKey` 的公钥加密
 *    并带 `__RSA__` 前缀（与 ehall-mock 同一套 CAS 行为）；
 * 3. 三个业务接口都是 `POST` + `x-www-form-urlencoded`，响应外壳 `{code:"0",datas}`，
 *    **`code` 是字符串**；
 * 4. 课表行字段名严格使用真实拼音缩写（`KCM` / `SKJS` / `JASMC` / `SKXQ` / `KSJC` /
 *    `JSJC` / `SKZC` / `XNXQDM`），大小写敏感。
 *
 * 另外提供几个测试开关：
 * - `state.failNextTimetableWith = 500`（下一次课表请求返回 HTTP 500）；
 * - `state.timetableOverride = '<html>…'`（用任意响应替换课表响应，测非 JSON）；
 * - `state.timetableCode = '1'` + `state.timetableMessage`（测业务错误码）；
 * - `state.termStart = null`（模拟历史学期取不到起始日 → 上层走本地推断）。
 */

import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import http from 'node:http';

const SERVICE_SESSION = 'EHALL_SESSION=ok';

const LOGIN_HTML = `<!doctype html><html><head><title>登录 - 西安交通大学统一身份认证网关</title>
<script>var globalConfig = {"mfaEnabled": true, "locale": "zh"};</script></head>
<body><div id="fm1"><form method="post" action="/cas/login">
<input type="hidden" name="execution" value="exec-1">
<input name="username"><input name="password" type="password">
</form></div></body></html>`;

const ALERT_HTML = (title) => `<!doctype html><html><head><title>统一身份认证</title></head>
<body><div id="fm1"><el-alert title="${title}" type="error" show-icon="true"></el-alert>
<form method="post" action="/cas/login"><input type="hidden" name="execution" value="exec-2"></form></div></body></html>`;

/** 已登录时业务地址返回的普通业务页（无 execution → CAS 状态机判定 READY）。 */
const BUSINESS_HTML = `<!doctype html><html><head><title>我的课表</title></head>
<body><div id="wdkb-app">课表</div></body></html>`;

/**
 * 默认课表行：**真实数据形状**（全大写拼音字段名），覆盖
 * 「相邻同名可合并」「不连续不合并」「周次跨段」「只有后半段周次」四种形态。
 *
 * 学期：2026-2027-1，起始日 2026-09-07（周一）。
 */
export function defaultTimetableRows() {
  return [
    // 高等数学：周一 1-2 与 3-4，同周次 → 合并成 1-4
    {
      KCM: '高等数学',
      SKJS: '张老师',
      JASMC: '主A-101',
      SKXQ: '1',
      KSJC: '1',
      JSJC: '2',
      SKZC: '111111110000000000',
      XNXQDM: '2026-2027-1',
      XNXQDM_DISPLAY: '2026-2027学年第一学期',
      KCH: 'MATH1001',
    },
    {
      KCM: '高等数学',
      SKJS: '张老师',
      JASMC: '主A-101',
      SKXQ: '1',
      KSJC: '3',
      JSJC: '4',
      SKZC: '111111110000000000',
      XNXQDM: '2026-2027-1',
      XNXQDM_DISPLAY: '2026-2027学年第一学期',
      KCH: 'MATH1001',
    },
    // 大学物理：周一 5-6（与高等数学 1-4 之间没有空档，但课程名不同 → 不合并）
    {
      KCM: '大学物理',
      SKJS: '李老师',
      JASMC: '主B-203',
      SKXQ: '1',
      KSJC: '5',
      JSJC: '6',
      SKZC: '111111111111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'PHYS1001',
    },
    // 线性代数：周一 1-2 与 5-6，同名同周但**不连续** → 保持两条
    {
      KCM: '线性代数',
      SKJS: '王老师',
      JASMC: '主C-305',
      SKXQ: '1',
      KSJC: '1',
      JSJC: '2',
      SKZC: '111111111111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'MATH2001',
    },
    {
      KCM: '线性代数',
      SKJS: '王老师',
      JASMC: '主C-305',
      SKXQ: '1',
      KSJC: '5',
      JSJC: '6',
      SKZC: '111111111111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'MATH2001',
    },
    // 程序设计：周三 1-2，周次 1-8 + 10-16（跨段 → 两条日程）
    {
      KCM: '程序设计',
      SKJS: '赵老师',
      JASMC: '计B-202',
      SKXQ: '3',
      KSJC: '1',
      JSJC: '2',
      SKZC: '111111110111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'CS1001',
    },
    // 大学英语：周二 3-4，1-16 周
    {
      KCM: '大学英语',
      SKJS: '钱老师',
      JASMC: '外语楼-401',
      SKXQ: '2',
      KSJC: '3',
      JSJC: '4',
      SKZC: '111111111111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'ENG1001',
    },
    // 实验课：周四 9-10，只有 10-16 周（untilWeek=8 时整门课被截掉 → skipped）
    {
      KCM: '物理实验',
      SKJS: '孙老师',
      JASMC: '实验楼-101',
      SKXQ: '4',
      KSJC: '9',
      JSJC: '10',
      SKZC: '000000000111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'PHYS1002',
    },
    // 体育：周五 7-8，1-16 周
    {
      KCM: '体育',
      SKJS: '周老师',
      JASMC: '田径场',
      SKXQ: '5',
      KSJC: '7',
      JSJC: '8',
      SKZC: '111111111111111100',
      XNXQDM: '2026-2027-1',
      KCH: 'PE1001',
    },
  ];
}

export async function startMockTimetable(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const state = {
    requests: [],
    /** 三个接口的调用计数（断言「预览 + 导入只拉一次」等）。 */
    timetableCalls: 0,
    currentTermCalls: 0,
    termStartCalls: 0,
    /** 最近一次 cxjcs 收到的 XN / XQ。 */
    lastTermStartQuery: null,
    /** 下一次课表请求直接返回这个 HTTP 状态。 */
    failNextTimetableWith: null,
    /** 用一段任意文本替换课表响应（测非 JSON / HTML）。 */
    timetableOverride: null,
    /** 强制业务码（默认 "0"）。 */
    timetableCode: '0',
    timetableMessage: null,
    /** 丢掉 rows 字段（测上游结构变化）。 */
    omitRows: false,
    username: options.username ?? '2024001',
    password: options.password ?? 'secret-pass',
    currentTerm: options.currentTerm ?? '2026-2027-1',
    termStart: options.termStart === undefined ? '2026-09-07' : options.termStart,
    rows: options.rows ?? defaultTimetableRows(),
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

      const form = new URLSearchParams(raw);
      const body = Object.fromEntries(form.entries());
      const cookies = parseCookies(req.headers.cookie);
      const loggedIn = cookies.EHALL_SESSION === 'ok';

      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(payload));
      };
      const html = (code, text, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'text/html;charset=UTF-8', ...headers });
        res.end(text);
      };

      // ---------------------------------------------------------- 统一身份认证
      if (path === '/cas/login' && req.method === 'GET') return html(200, LOGIN_HTML);
      if (path === '/cas/jwt/publicKey') {
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
        return res.end(publicKey);
      }
      // CasAuth 在 `mfaEnabled` 为真时会先探测两步验证（真机同样如此）。
      if (path === '/cas/mfa/detect' && req.method === 'POST') {
        if (!body.username) return json(400, { status: 400, message: "Required String parameter 'username' is not present" });
        return json(200, { code: 0, data: { state: 'mfa-state-1', need: false } });
      }
      if (path === '/cas/login' && req.method === 'POST') {
        if (body.username !== state.username) return html(200, ALERT_HTML('用户名或密码错误'));
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
        if (password !== state.password) return html(200, ALERT_HTML('用户名或密码错误'));
        const service = url.searchParams.get('service') ?? `${origin.value}/`;
        res.writeHead(302, {
          Location: service,
          'Set-Cookie': `${SERVICE_SESSION}; Path=/; HttpOnly`,
        });
        return res.end();
      }

      // ---------------------------------------------------------- 未登录拦截
      if (path.startsWith('/jwapp/') && !loggedIn) {
        res.writeHead(302, {
          Location: `${origin.value}/cas/login?service=${encodeURIComponent(`${origin.value}${path}`)}`,
        });
        return res.end();
      }

      // ------------------------------------------------ 课表应用（wdkb，三个接口）
      const isWdkb = path.startsWith('/jwapp/sys/wdkb/');

      // 登录后 GET 业务地址：CAS 状态机靠「不是登录页」判定 READY。
      if (isWdkb && req.method === 'GET') return html(200, BUSINESS_HTML);

      if (path === '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do' && req.method === 'POST') {
        state.currentTermCalls += 1;
        const rows = state.currentTerm ? [{ DM: state.currentTerm }] : [];
        return json(200, { code: '0', datas: { dqxnxq: { rows } } });
      }

      if (path === '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do' && req.method === 'POST') {
        state.termStartCalls += 1;
        state.lastTermStartQuery = { XN: body.XN ?? null, XQ: body.XQ ?? null };
        const rows = state.termStart ? [{ XQKSRQ: `${state.termStart} 00:00:00` }] : [];
        return json(200, { code: '0', datas: { cxjcs: { rows } } });
      }

      if (path === '/jwapp/sys/wdkb/modules/xskcb/xskcb.do' && req.method === 'POST') {
        state.timetableCalls += 1;
        if (state.failNextTimetableWith) {
          const status = state.failNextTimetableWith;
          state.failNextTimetableWith = null;
          res.writeHead(status, { 'Content-Type': 'text/html;charset=UTF-8' });
          return res.end(`<html><head><title>${status}</title></head><body>${status} Forbidden</body></html>`);
        }
        if (state.timetableOverride !== null) return html(200, String(state.timetableOverride));
        if (state.timetableCode !== '0') {
          return json(200, { code: state.timetableCode, msg: state.timetableMessage ?? '<b>业务错误</b>', datas: null });
        }
        if (state.omitRows) return json(200, { code: '0', datas: { xskcb: {} } });
        return json(200, { code: '0', datas: { xskcb: { totalSize: state.rows.length, rows: state.rows } } });
      }

      return json(404, { code: '404', msg: `unknown ${path}` });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  origin.value = `http://127.0.0.1:${port}`;

  return {
    origin: origin.value,
    baseUrl: origin.value,
    state,
    rows: state.rows,
    /** 直接给 timetable 模块的配置（`{config: mock.config()}`）。 */
    config() {
      return {
        baseUrl: origin.value,
        loginUrl: `${origin.value}/jwapp/sys/wdkb/modules/xskcb/xskcb.do`,
        casOrigin: origin.value,
        timeoutMs: 5000,
        totalWeeks: 18,
        shortTermWeeks: 8,
      };
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
