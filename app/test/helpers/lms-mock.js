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

/* ------------------------------------------------------------ 相对日期工具 */

/**
 * 活动日期一律**相对今天**生成，不再写死具体日期。
 *
 * 为什么必须这样：同步计划按「今天」过滤过期条目（`!includePast && date < today`），
 * 而 `runAutoSyncOnce` 用的是真实时钟 —— 写死的日期一旦变成过去时，
 * 「未提交的作业 / 直播会建出日程」这类用例就会在某个日历日之后**永久变红**，
 * 与代码是否被改坏无关。相对日期让用例在任何一天跑都成立。
 *
 * 偏移量在此集中定义，供 test/lms.test.js 引用（断言不再抄字面日期）。
 */
export const ACTIVITY_DAY_OFFSETS = {
  /** 未提交、未来截止的作业 -> 待办。 */
  homework: 1,
  /** 已提交的作业：未来截止，但默认因「已提交」被跳过。 */
  submittedHomework: 8,
  /** 已过期的作业：默认被跳过，勾选「包含过期」才进来。 */
  expiredHomework: -10,
  /** 未来的直播：有起止时刻 -> 时段日程。 */
  lectureLive: 2,
  /** 过去的回放：默认被跳过，勾选后才作为时段日程进来。 */
  lesson: -4,
  /** 修改截止日时往后挪的天数（相对 activity 5001 原本的截止日）。 */
  homeworkPostpone: 2,
};

/** 今天（本机时区）的 `YYYY-MM-DD`。 */
function dayKey(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 生成「今天 + offsetDays」的 `YYYY-MM-DD HH:MM:SS`（思源学堂返回的本地时间格式）。 */
export function activityDateTime(offsetDays, time) {
  return `${dayKey(offsetDays)} ${time}`;
}

/** 生成「今天 + offsetDays」的 `YYYY-MM-DD`（同步后写进待办/日程的日期）。 */
export function activityDate(offsetDays) {
  return dayKey(offsetDays);
}

/** 生成「今天 + offsetDays」的北京时间 ISO 串，如 `2026-10-15T23:59:00+08:00`。 */
export function activityIso(offsetDays, time) {
  return `${dayKey(offsetDays)}T${time}+08:00`;
}

/** 活动 5001（未提交作业）的截止日；改期用例要基于它往后挪，不能另写字面量。 */
export const HOMEWORK_DEADLINE_DATE = activityDate(ACTIVITY_DAY_OFFSETS.homework);

/** 默认数据集：覆盖「未提交作业 / 已提交作业 / 过期作业 / 直播 / 回放 / 资料」。 */
export function defaultDataset() {
  const home = ACTIVITY_DAY_OFFSETS.homework;
  const expired = ACTIVITY_DAY_OFFSETS.expiredHomework;
  const submitted = ACTIVITY_DAY_OFFSETS.submittedHomework;
  const live = ACTIVITY_DAY_OFFSETS.lectureLive;
  const lesson = ACTIVITY_DAY_OFFSETS.lesson;
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
        { id: 5001, course_id: 1001, type: 'homework', title: '第一次作业：链表', start_time: activityIso(home - 9, '08:00:00'), end_time: activityIso(home, '23:59:00'), published: true, submit_by_group: false },
        { id: 5002, course_id: 1001, type: 'homework', title: '第二次作业：二叉树', start_time: activityIso(submitted - 1, '08:00:00'), end_time: activityIso(submitted, '23:59:00'), published: true, submit_by_group: false },
        { id: 5003, course_id: 1001, type: 'homework', title: '开学摸底测验', start_time: activityIso(expired - 4, '08:00:00'), end_time: activityIso(expired, '23:59:00'), published: true, submit_by_group: false },
        { id: 5004, course_id: 1001, type: 'lecture_live', title: '第 6 周直播课', start_time: activityIso(live, '10:00:00'), end_time: activityIso(live, '11:40:00'), published: true },
        { id: 5005, course_id: 1001, type: 'material', title: '课件：第 6 章', published: true },
        { id: 5007, course_id: 1001, type: 'lesson', title: '第 5 周回放', start_time: activityIso(lesson, '10:00:00'), end_time: activityIso(lesson, '11:40:00'), lesson_start: activityIso(lesson, '10:00:00'), lesson_end: activityIso(lesson, '11:40:00'), replay_code: 'rc-5007', published: true },
      ],
      1002: [{ id: 5006, course_id: 1002, type: 'homework', title: 'Unit 3 作文', start_time: activityIso(live, '08:00:00'), end_time: activityIso(live + 3, '22:00:00'), published: true, submit_by_group: false }],
    },
    details: {
      5001: {
        description: '<p>实现单链表并提交源码</p>',
        user_submit_count: 0,
        highest_score: 100,
        lowest_score: 60,
        average_score: 82,
        // 附件挂在详情里（学堂就是这么分的）：一个是可下载的 PDF，一个老师关掉了下载
        uploads: [
          { id: 9001, name: '作业要求.pdf', size: 2048, type: 'application/pdf', allow_download: true, reference_id: 71 },
          { id: 9002, name: '评分细则.docx', size: 4096, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', allow_download: false },
        ],
      },
      5002: { description: '<p>实现二叉树遍历</p>', user_submit_count: 1, highest_score: 100 },
      5003: { description: '<p>摸底</p>', user_submit_count: 1 },
      5006: { description: '<p>Write a letter</p>', user_submit_count: 0 },
      // 资料类活动：详情里带附件，资料板块就靠这个
      5005: {
        description: '<p>第 6 章课件</p>',
        uploads: [{ id: 9003, name: '第6章-树与二叉树.pptx', size: 8192, type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', allow_download: true }],
      },
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
    /** 回放三步链路的调用痕迹（验证真的走了三步，而不是某一步被跳过）。 */
    playerUrlFetched: [],
    embedTokenFetched: [],
    capturesFetched: [],
    /** 附件 blob 被取过哪些 id（验证后端是**代取**而不是把学校地址直接甩给浏览器）。 */
    blobFetched: [],
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
    // ---------------------------------------------------------------- 录播站（RMS）
    if (path === '/rms/api/v1/auth/embed-token') {
      const token = url.searchParams.get('token') ?? '';
      if (!token.startsWith('tk-')) return json(res, 401, { message: 'bad token' });
      state.embedTokenFetched.push(token);
      // ★ 真实接口返回的是 `{ data: "<票据字符串>" }` —— 票据**就在 data 上**，不是 data.token。
      //   这里必须照真实形状来：之前 mock 回的是 `{ token }`，于是代码里"取 data.token"
      //   的错误写法在测试里一直是绿的，真机上却每一路回放都取不到票据。
      return json(res, 200, { data: `bearer-${token}` });
    }
    const capturesMatch = path.match(/^\/rms\/api\/embed\/lesson-activities\/captures\/([\w-]+)$/);
    if (capturesMatch) {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer bearer-')) {
        return json(res, 401, { message: 'missing bearer' });
      }
      // ★ 真实接口要求带 lesson_activity_id；漏了按非法请求处理。
      //   照真实行为来，漏传才会在这里就暴露，而不是到用户机器上才失败。
      if (!url.searchParams.get('lesson_activity_id')) {
        return json(res, 400, { message: 'missing lesson_activity_id' });
      }
      const code = capturesMatch[1];
      state.capturesFetched.push(code);
      const video = options.replayVideo ?? {
        label: 'INSTRUCTOR',
        size: 1024,
        download_url: `${origin}/rms/media/${code}-instructor.mp4`,
      };
      return json(res, 200, {
        lesson_videos: [
          { ...video, is_best_audio: true },
          {
            label: 'ENCODER',
            size: 512,
            download_url: `${origin}/rms/media/${code}-encoder.mp4`,
          },
        ],
      });
    }
    // 视频本体：真实可下（内容可预测，测试里断言字节）
    const mediaMatch = path.match(/^\/rms\/media\/([\w-]+)\.mp4$/);
    if (mediaMatch) {
      const payload = Buffer.alloc(Number(options.mediaBytes ?? 64), mediaMatch[1].includes('encoder') ? 0x45 : 0x49);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
      // 慢速模式：先发个头再慢慢发正文字节，用来测"下载中"的进度/取消/去重
      const delay = Number(options.mediaDelayMs ?? 0);
      if (delay > 0) {
        const half = Math.floor(payload.length / 2);
        res.write(payload.subarray(0, half));
        setTimeout(() => res.end(payload.subarray(half)), delay);
        return undefined;
      }
      return res.end(payload);
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

      /**
       * 附件字节（`GET /api/uploads/{id}/blob`）。
       *
       * 真实站点上这条要 CAS cookie，所以我们的后端**代取**再转发 ——
       * mock 这里回一段可识别的字节，测试就能验证"转发的确实是这个文件"。
       * 9009 故意做成"不存在"，用来测 404 分支。
       */
      const blobMatch = path.match(/^\/api\/uploads\/(\d+)\/blob$/);
      if (blobMatch) {
        const uploadId = Number(blobMatch[1]);
        if (uploadId === 9009) return json(res, 404, { message: 'upload not found' });
        state.blobFetched.push(uploadId);
        const payload = Buffer.from(`blob-of-${uploadId}`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(payload.length) });
        return res.end(payload);
      }

      // 回放第一步：lms 给一个带 token 的播放地址（回放的视频不在 lms 上）
      const playerMatch = path.match(/^\/api\/lessons\/(\d+)\/player-url$/);
      if (playerMatch) {
        const lessonId = Number(playerMatch[1]);
        const activity = findActivity(dataset, lessonId);
        if (!activity) return json(res, 404, { message: 'not found' });
        // 只有回放（lesson）才有播放地址；拿作业去换应该 404
        if (activity.type !== 'lesson') return json(res, 404, { message: 'not a lesson' });
        state.playerUrlFetched.push(lessonId);
        const replayCode = activity.replay_code ?? `rc-${lessonId}`;
        // 走 rmsBaseUrl（测试里指向同一个 mock 的 /rms 前缀）
        return json(res, 200, {
          player_url: `${origin}/rms/embed?token=tk-${lessonId}&replay_code=${replayCode}&from_page=course`,
        });
      }
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
