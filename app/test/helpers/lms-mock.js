/**
 * 思源学堂 + 统一身份认证的本地 mock 服务器（仅测试用）。
 *
 * 目的：让「登录 → 两步验证 → 拉课程 → 拉活动 → 同步」整条链路可以在
 * 无网络、无真实账号的情况下被完整测试，包括 RSA 密码加密、Cookie 种票、
 * 重定向链、两步验证与失败提示。
 *
 * 它刻意复刻了真实服务端的几个「坑」：
 * - 未登录时业务页面 302 到 /cas/login（而不是返回 401）；
 * - 密码必须用 /cas/jwt/publicKey 的公钥加密、并带 __RSA__ 前缀才接受；
 * - 登录失败返回 200 + el-alert 而不是 4xx。
 */

import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import http from 'node:http';

const SESSION_COOKIE = 'LMS_SESSION=ok';

const LOGIN_HTML = `<!doctype html><html><head><title>统一身份认证</title>
<script>var globalConfig = {"mfaEnabled": true, "locale": "zh"};</script></head>
<body><div id="fm1"><form method="post" action="/cas/login">
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

function homeHtml(user) {
  return `<!doctype html><html><head><title>思源学堂</title></head><body>
<script>
  window.globalData = {
    user: { id: ${user.id}, name: "${user.name}", userNo: "${user.userNo}", role: "Student", orgName: "思源学堂2.0", hasAiAbility: true },
    dept: { id: 12, name: "${user.department}", code: "DX" },
    locale: "zh-CN"
  };
</script></body></html>`;
}

/** 默认数据集：覆盖「未提交作业 / 已提交作业 / 过期作业 / 直播 / 回放 / 资料」。 */
export function defaultDataset() {
  return {
    user: { id: 602, name: '张三', userNo: '2021001', department: '电子与信息学部' },
    courses: [
      {
        id: 1001,
        name: '数据结构',
        course_code: 'COMP2001',
        course_type: 'compulsory',
        credit: '3.0',
        compulsory: true,
        start_date: '2026-09-01',
        end_date: '2027-01-15',
        klass: '计算机2101',
        instructors: [{ id: 9, name: '李老师' }],
        academic_year: { id: 1, code: '2026-2027', name: '2026-2027学年' },
        semester: { id: 1, code: 'autumn', name: '秋季学期', real_name: '2026-2027学年秋季学期' },
        department: { id: 12, name: '电子与信息学部', code: 'DX' },
        course_attributes: { published: true, student_count: 88, teaching_class_name: '数据结构-01班' },
      },
      {
        id: 1002,
        name: '大学英语',
        course_code: 'ENG1001',
        course_type: 'compulsory',
        credit: '2.0',
        start_date: '2026-09-01',
        end_date: '2027-01-15',
        instructors: [{ id: 11, name: '王老师' }],
        academic_year: { id: 1, code: '2026-2027', name: '2026-2027学年' },
        semester: { id: 1, code: 'autumn', name: '秋季学期', real_name: '2026-2027学年秋季学期' },
        department: { id: 12, name: '电子与信息学部', code: 'DX' },
        course_attributes: { published: true, student_count: 40, teaching_class_name: '英语-05班' },
      },
    ],
    activities: {
      1001: [
        { id: 5001, course_id: 1001, type: 'homework', title: '第一次作业：链表', start_time: '2026-10-05T08:00:00+08:00', end_time: '2026-10-14T23:59:00+08:00', published: true, submit_by_group: false },
        { id: 5002, course_id: 1001, type: 'homework', title: '第二次作业：二叉树', start_time: '2026-10-20T08:00:00+08:00', end_time: '2026-11-02T23:59:00+08:00', published: true, submit_by_group: false },
        { id: 5003, course_id: 1001, type: 'homework', title: '开学摸底测验', start_time: '2026-09-01T08:00:00+08:00', end_time: '2026-09-05T23:59:00+08:00', published: true, submit_by_group: false },
        { id: 5004, course_id: 1001, type: 'lecture_live', title: '第 6 周直播课', start_time: '2026-10-13T10:00:00+08:00', end_time: '2026-10-13T11:40:00+08:00', published: true },
        { id: 5005, course_id: 1001, type: 'material', title: '课件：第 6 章', published: true },
        { id: 5007, course_id: 1001, type: 'lesson', title: '第 5 周回放', start_time: '2026-10-06T10:00:00+08:00', end_time: '2026-10-06T11:40:00+08:00', lesson_start: '2026-10-06T10:00:00+08:00', lesson_end: '2026-10-06T11:40:00+08:00', replay_code: 'rc-5007', published: true },
      ],
      1002: [{ id: 5006, course_id: 1002, type: 'homework', title: 'Unit 3 作文', start_time: '2026-10-10T08:00:00+08:00', end_time: '2026-10-18T22:00:00+08:00', published: true, submit_by_group: false }],
    },
    details: {
      5001: { description: '<p>实现单链表并提交源码</p>', user_submit_count: 0, highest_score: 100, lowest_score: 60, average_score: 82 },
      5002: { description: '<p>实现二叉树遍历</p>', user_submit_count: 1, highest_score: 100 },
      5003: { description: '<p>摸底</p>', user_submit_count: 1 },
      5006: { description: '<p>Write a letter</p>', user_submit_count: 0 },
    },
  };
}

export function cloneDataset(dataset = defaultDataset()) {
  return JSON.parse(JSON.stringify(dataset));
}

/**
 * 启动 mock 服务器。
 * @param {object} [options]
 * @param {object} [options.dataset] 课程/活动数据
 * @param {string} [options.username] 学号
 * @param {string} [options.password] 密码
 * @param {string} [options.mfaCode] 两步验证验证码
 */
export async function startMockLms(options = {}) {
  const dataset = cloneDataset(options.dataset ?? defaultDataset());
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const state = {
    username: options.username ?? dataset.user.userNo,
    password: options.password ?? 'pw-123456',
    mfaCode: options.mfaCode ?? '654321',
    needMfa: Boolean(options.needMfa),
    // 模拟「密码对了但会话没建立」的情况：POST 之后仍然停在登录页
    stuckOnLogin: Boolean(options.stuckOnLogin),
    safetyVerify: Boolean(options.safetyVerify),
    safetyIssued: false,
    mfaVerified: false,
    detailFetched: [],
    requests: [],
    /** 每个接口收到过的 Content-Type，用来验证「该用表单的用了表单、该用 JSON 的用了 JSON」。 */
    contentTypes: {},
  };

  let origin = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push(`${req.method} ${url.pathname}`);
      const contentType = req.headers['content-type'] ?? '';
      state.contentTypes[`${req.method} ${url.pathname}`] = contentType;
      const body = contentType.includes('application/json') ? safeJson(raw) : Object.fromEntries(new URLSearchParams(raw));
      route(req, res, url, body, raw);
    });
  });

  function json(res, status, payload, headers = {}) {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(text);
  }

  function html(res, status, text, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(text);
  }

  const loggedIn = (req) => String(req.headers.cookie ?? '').includes(SESSION_COOKIE);

  function route(req, res, url, body, raw) {
    const path = url.pathname;

    // ------------------------------------------------------------ 统一身份认证
    if (path === '/cas/login' && req.method === 'GET') {
      return html(res, 200, LOGIN_HTML);
    }
    if (path === '/cas/jwt/publicKey') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(publicPem);
    }
    if (path === '/cas/mfa/detect' && req.method === 'POST') {
      // 真机行为：只接受 form-urlencoded，传 JSON 会 400 缺参数
      if (String(req.headers['content-type'] ?? '').includes('application/json')) {
        return json(res, 400, {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          message: "Required String parameter 'username' is not present",
          path: '/cas/mfa/detect',
        });
      }
      if (!body.username) return json(res, 400, { status: 400, message: "Required String parameter 'username' is not present" });
      return json(res, 200, { code: 0, data: { state: 'mfa-state-1', need: state.needMfa } });
    }
    if (/^\/cas\/(mfa|sec)\/initByType\/securephone$/.test(path)) {
      if (url.searchParams.get('state') !== 'mfa-state-1' && url.searchParams.get('state') !== 'sec-1') {
        return json(res, 200, { code: 1, message: 'state 不合法' });
      }
      return json(res, 200, { code: 0, data: { gid: 'gid-1', securePhone: '13800008888' } });
    }
    if (path === '/attest/api/guard/securephone/send' && req.method === 'POST') {
      // 真机行为：只接受 JSON，传 form 会 415
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
      // 1x1 PNG：只需要是合法图片，用来验证二进制透传
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7g0dAAAAAElFTkSuQmCC',
        'base64',
      );
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    if (path === '/cas/login' && req.method === 'POST') {
      // 二次认证隐藏表单的提交（同一个地址，带 secState）
      if (body.secState) {
        if (!state.mfaVerified) return html(res, 200, ALERT_HTML('请先完成安全验证'));
        return finishLogin(res);
      }
      if (state.safetyVerify && !state.safetyIssued) {
        state.safetyIssued = true;
        return html(res, 200, SAFETY_HTML);
      }
      if (body.username !== state.username) return html(res, 200, ALERT_HTML('用户名或密码错误'));
      const password = decryptPassword(body.password, privateKey);
      if (password !== state.password) return html(res, 200, ALERT_HTML('用户名或密码错误'));
      if (state.needMfa && !state.mfaVerified) {
        // 真实服务端要求先做两步验证：这里用一个错误提示模拟
        return html(res, 200, ALERT_HTML('未完成两步验证'));
      }
      if (state.stuckOnLogin) return html(res, 200, LOGIN_HTML);
      return finishLogin(res);
    }

    function finishLogin(res) {
      res.writeHead(302, { Location: `${origin}/`, 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` });
      res.end();
    }

    // ------------------------------------------------------------ 思源学堂
    if (path === '/' || path === '') {
      if (!loggedIn(req)) {
        res.writeHead(302, { Location: `${origin}/cas/login?service=${encodeURIComponent(`${origin}/`)}` });
        return res.end();
      }
      return html(res, 200, '<!doctype html><html><head><title>思源学堂</title></head><body>ok</body></html>');
    }
    if (path === '/user/index') {
      if (!loggedIn(req)) {
        res.writeHead(302, { Location: `${origin}/cas/login` });
        return res.end();
      }
      return html(res, 200, homeHtml(dataset.user));
    }
    if (path.startsWith('/api/')) {
      if (!loggedIn(req)) return json(res, 401, { message: 'Unauthenticated.' });
      if (path === '/api/my-courses') return json(res, 200, { courses: dataset.courses });
      const activitiesMatch = path.match(/^\/api\/courses\/(\d+)\/activities$/);
      if (activitiesMatch) {
        const courseId = Number(activitiesMatch[1]);
        return json(res, 200, { activities: dataset.activities[courseId] ?? [] });
      }
      const detailMatch = path.match(/^\/api\/activities\/(\d+)$/);
      if (detailMatch) {
        const activityId = Number(detailMatch[1]);
        const found = findActivity(dataset, activityId);
        if (!found) return json(res, 404, { message: 'not found' });
        state.detailFetched.push(activityId);
        return json(res, 200, { ...found, ...(dataset.details[activityId] ?? {}) });
      }
      const submissionsMatch = path.match(/^\/api\/activities\/(\d+)\/(students|groups)\/(\d+)\/submission_list$/);
      if (submissionsMatch) return json(res, 200, { submissions: [{ id: 1, score: 95, status: 'marked', submitted_at: '2026-10-06T20:00:00+08:00' }] });
      return json(res, 404, { message: `未知接口 ${path}` });
    }

    json(res, 404, { message: `未知路径 ${path}`, raw: raw.slice(0, 80) });
  }

  await new Promise((resolve) => server.listen(Number(options.port ?? 0), '127.0.0.1', resolve));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    state,
    dataset,
    /** 直接改数据，用来测「作业改期 / 作业消失」等场景。 */
    mutate(fn) {
      fn(dataset);
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

function decryptPassword(value, privateKey) {
  if (typeof value !== 'string' || !value.startsWith('__RSA__')) return null;
  try {
    const buffer = Buffer.from(value.slice('__RSA__'.length), 'base64');
    return privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, buffer).toString('utf8');
  } catch {
    return null;
  }
}

function findActivity(dataset, activityId) {
  for (const list of Object.values(dataset.activities)) {
    const found = list.find((item) => Number(item.id) === Number(activityId));
    if (found) return found;
  }
  return null;
}
