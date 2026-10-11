/**
 * 教务（ehall）+ 统一身份认证的本地 mock 服务器（仅测试用）。
 *
 * 它**刻意复刻了那个让排查花了很久的坑**：成绩接口在没做授权握手时返回 403。
 *
 * 具体是这样实现的：mock 维护一个「当前有效的 `_WEU` 值」，
 *   - `getAppConfig` 发一个 `_WEU`；
 *   - `cxjwggbbdqx` **轮换**它（换新值）；
 *   - `xscjcx.do` 校验请求带的 `_WEU` 必须等于**当前**值，否则 403。
 *
 * 于是「不握手就拿不到数据」这件事在测试里是被**强制执行**的，而不是靠注释声明 ——
 * 哪天有人图省事把握手删了，测试会立刻红。
 *
 * 同时复刻了真实服务端的其它几个行为：
 * - 未登录时 jwapp 页面 302 到 `/cas/login?service=...`（不是 401）；
 * - 密码必须用 `/cas/jwt/publicKey` 的公钥加密并带 `__RSA__` 前缀；
 * - 登录失败返回 200 + 错误提示，而不是 4xx；
 * - 成绩响应的成功码是**字符串** `"0"`。
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

/** 成绩应用外壳：真实页面里 `window._JW_INIT_CONFIG` 带 appId，握手要用它。 */
const appPageHtml = (appId) => `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>成绩查询</title></head>
<body><script>
window._JW_INIT_CONFIG = {"appname":"cjcx","appId":"${appId}","contextPath":"/jwapp","userid":"10001"};
</script></body></html>`;

/**
 * 默认成绩数据：字段名与真实教务**完全一致**（见 docs/教务成绩接口调研.md 第 4 节），
 * 覆盖几种形态：学校给了绩点 / 只给分数要换算 / 等级制无绩点 / 无效成绩 / 零学分。
 */
export function defaultGrades() {
  return [
    {
      WID: 'WID-0001',
      KCM: '高等数学',
      KCH: 'MATH1001',
      XF: 5,
      XFJD: 4,
      ZCJ: 92,
      XNXQDM: '2024-2025-1',
      XNXQDM_DISPLAY: '2024-2025学年第一学期',
      KCXZDM: '01',
      KCXZDM_DISPLAY: '必修',
      KCLBDM: '15',
      KCLBDM_DISPLAY: '公共基础课',
      KSLXDM_DISPLAY: '闭卷',
      XS: 80,
      SFYX: '1',
      SFYX_DISPLAY: '是',
      SFJG: '1',
      SFJG_DISPLAY: '是',
      QMCJ: '92',
      QMCJ_DISPLAY: '92',
    },
    {
      WID: 'WID-0002',
      KCM: '大学物理',
      KCH: 'PHYS1001',
      XF: 3,
      XFJD: 3.3,
      ZCJ: 84,
      XNXQDM: '2024-2025-1',
      XNXQDM_DISPLAY: '2024-2025学年第一学期',
      KCXZDM: '01',
      KCXZDM_DISPLAY: '必修',
      SFYX: '1',
      SFJG: '1',
    },
    {
      // 学校没给 XFJD，只能靠换算表（66 分 → 1.5）
      WID: 'WID-0003',
      KCM: '工程制图',
      KCH: 'ME1002',
      XF: 2,
      XFJD: null,
      ZCJ: 66,
      XNXQDM: '2024-2025-2',
      XNXQDM_DISPLAY: '2024-2025学年第二学期',
      KCXZDM_DISPLAY: '必修',
      SFYX: '1',
    },
    {
      // 等级制：既没有分数也没有绩点 → 默认不纳入
      WID: 'WID-0004',
      KCM: '形势与政策',
      KCH: 'POL1001',
      XF: 1,
      XFJD: null,
      ZCJ: null,
      DJCJMC: '优秀',
      XNXQDM: '2024-2025-2',
      XNXQDM_DISPLAY: '2024-2025学年第二学期',
      KCXZDM_DISPLAY: '必修',
      SFYX: '1',
      // 等级制也有通过标记 —— 所以它算"已修学分"，只是进不了学分绩
      SFJG: '1',
      SFJG_DISPLAY: '是',
    },
    {
      // 无效成绩（被撤销/不计入）→ 统计时必须忽略
      WID: 'WID-0005',
      KCM: '已撤销课程',
      KCH: 'XXX0001',
      XF: 2,
      XFJD: 0,
      ZCJ: 30,
      XNXQDM: '2024-2025-2',
      KCXZDM_DISPLAY: '选修',
      SFYX: '0',
      SFYX_DISPLAY: '否',
    },
  ];
}

export async function startMockEhall(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicPem = publicKey;

  const state = {
    requests: [],
    /** 当前有效的 _WEU；握手轮换它。 */
    weu: null,
    /** 已签发过的 _WEU 历史，用于诊断。 */
    weuHistory: [],
    appConfigCalls: 0,
    appInitCalls: 0,
    gradeCalls: 0,
    /** 强制成绩接口返回指定状态（测 403/401/500）。 */
    failNextGradeWith: null,
    /** 用一段自定义响应替换成绩响应（测非 JSON / code!=0 / 结构变化）。 */
    gradeOverride: null,
    /** 丢掉 rows 路径，模拟上游改版。 */
    omitRows: false,
    /** 让成绩接口只认"第一次握手之前"的 _WEU，用来测握手过期后的自动重试。 */
    rotateOnGradeCall: false,
    /** 无论怎么握手都判 403 —— 用来测"重试也没用"时的错误信息。 */
    alwaysInvalidWeu: false,
    username: options.username ?? '2024001',
    password: options.password ?? 'secret-pass',
    /** 是否要求两步验证（默认否，交给学堂模块的测试去覆盖 MFA 细节）。 */
    needMfa: options.needMfa === true,
  };

  const grades = options.grades ?? defaultGrades();
  const appId = options.appId ?? '4768574631264620';
  const origin = { value: '' };
  // 从 options 接到 state 上（这些开关由测试在运行中途改）
  if (options.alwaysInvalidWeu) state.alwaysInvalidWeu = true;

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
      const setCookie = (value) => ({ 'Set-Cookie': value });

      // ---------------------------------------------------------- 统一身份认证
      if (path === '/cas/login' && req.method === 'GET') return html(200, LOGIN_HTML);
      if (path === '/cas/jwt/publicKey') {
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
        return res.end(publicPem);
      }
      // CasAuth 每次登录前都会探测两步验证（登录页里 mfaEnabled 为真时）。
      // 少了这个端点它会抛「两步验证探测失败」，所以必须实现 —— 真机也有这一步。
      if (path === '/cas/mfa/detect' && req.method === 'POST') {
        // 真机行为：只接受 form-urlencoded，传 JSON 会 400 缺参数
        if (String(req.headers['content-type'] ?? '').includes('application/json')) {
          return json(400, {
            timestamp: Date.now(),
            status: 400,
            message: "Required String parameter 'username' is not present",
            path: '/cas/mfa/detect',
          });
        }
        if (!body.username) return json(400, { status: 400, message: "Required String parameter 'username' is not present" });
        return json(200, { code: 0, data: { state: 'mfa-state-1', need: state.needMfa } });
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
        // 真机行为：登录成功 302 回业务地址，并把会话票种在业务域上
        const service = url.searchParams.get('service') ?? `${origin.value}/`;
        res.writeHead(302, {
          Location: service,
          ...setCookie(`${SERVICE_SESSION}; Path=/; HttpOnly`),
        });
        return res.end();
      }

      // ---------------------------------------------------------- 未登录拦截
      const loginRedirect = () => {
        res.writeHead(302, {
          Location: `${origin.value}/cas/login?service=${encodeURIComponent(`${origin.value}${path}`)}`,
        });
        res.end();
      };
      if (path.startsWith('/jwapp/') && !loggedIn) return loginRedirect();

      // ---------------------------------------------------------- 成绩应用
      if (path === '/jwapp/sys/cjcx/*default/index.do' && req.method === 'GET') {
        return html(200, appPageHtml(appId));
      }

      // 第 2 步：授权握手 —— 登记授权并首次下发 _WEU
      if (path === `/jwapp/sys/funauthapp/api/getAppConfig/cjcx-${appId}.do`) {
        state.appConfigCalls += 1;
        state.weu = `weu-${state.weuHistory.length + 1}`;
        state.weuHistory.push(state.weu);
        res.writeHead(200, {
          'Content-Type': 'application/json;charset=UTF-8',
          ...setCookie(`_WEU=${state.weu}; Path=/jwapp/`),
        });
        return res.end(
          JSON.stringify({
            APP_ID: appId,
            MODULES: [{ route: 'cjcx', title: '成绩查询', range: '1' }],
            schoolID: '10698',
          }),
        );
      }

      // 第 3 步：应用初始化 —— **轮换** _WEU（真实服务端确实会换值）
      if (path === '/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do' && req.method === 'POST') {
        state.appInitCalls += 1;
        if (body.SFQY !== '1' || !body.APP) return json(200, { code: '1', msg: '参数不全' });
        state.weu = `weu-${state.weuHistory.length + 1}`;
        state.weuHistory.push(state.weu);
        res.writeHead(200, {
          'Content-Type': 'application/json;charset=UTF-8',
          ...setCookie(`_WEU=${state.weu}; Path=/jwapp/`),
        });
        return res.end(JSON.stringify({ code: '0', datas: { cxjwggbbdqx: { rows: [] } } }));
      }

      // 第 4 步：成绩查询 —— ★ 强制校验握手
      if (path === '/jwapp/sys/cjcx/modules/cjcx/xscjcx.do' && req.method === 'POST') {
        state.gradeCalls += 1;
        if (state.failNextGradeWith) {
          const status = state.failNextGradeWith;
          state.failNextGradeWith = null;
          res.writeHead(status, { 'Content-Type': 'text/html;charset=UTF-8' });
          return res.end(`<html><head><title>${status}</title></head><body>${status}</body></html>`);
        }
        // 没有 _WEU、或 _WEU 不是当前值 → 403（与真机行为一致）
        if (state.alwaysInvalidWeu || !cookies._WEU || cookies._WEU !== state.weu) {
          res.writeHead(403, { 'Content-Type': 'text/html;charset=UTF-8' });
          return res.end('<html><head><title>403</title></head><body>403 Forbidden</body></html>');
        }
        if (state.gradeOverride !== null) {
          res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
          return res.end(String(state.gradeOverride));
        }
        const datas = { xscjcx: { totalSize: grades.length, pageSize: 999 } };
        if (!state.omitRows) datas.xscjcx.rows = grades;
        if (state.rotateOnGradeCall) {
          // 查完就换值，模拟"会话握手过期"，用于测自动重握手
          state.weu = `weu-${state.weuHistory.length + 1}`;
          state.weuHistory.push(state.weu);
          res.setHeader('Set-Cookie', `_WEU=${state.weu}; Path=/jwapp/`);
        }
        return json(200, { code: '0', datas });
      }

      return json(404, { code: '404' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  origin.value = `http://127.0.0.1:${port}`;

  return {
    origin: origin.value,
    baseUrl: origin.value,
    state,
    grades,
    appId,
    /** 直接给 academic 模块的 config 用。 */
    config() {
      return {
        baseUrl: origin.value,
        loginUrl: `${origin.value}/jwapp/sys/cjcx/*default/index.do`,
        casOrigin: origin.value,
        // mock 是单源服务，CAS 与业务同源
        app: {
          name: 'cjcx',
          id: appId,
          indexPath: '/jwapp/sys/cjcx/*default/index.do',
          gradePath: '/jwapp/sys/cjcx/modules/cjcx/xscjcx.do',
          appInitPath: '/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do',
          appConfigPath: (name, id) => `/jwapp/sys/funauthapp/api/getAppConfig/${name}-${id}.do`,
        },
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
