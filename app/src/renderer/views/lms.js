/**
 * 思源学堂视图：登录 / 验证码 / 短信与二次认证 / 课程与活动 / 同步预览与应用 / 自动同步设置。
 *
 * 视图内的会话状态只保存在本文件的闭包里（后端才是唯一数据源），
 * 所有类名以 `lms-` 为前缀，样式见同目录 lms.css。
 */

(function () {
/**
 * 视图内的会话态。
 *
 * 刻意不写进 PC.state：学堂的登录态、课程、活动全部由后端持有，
 * 前端只需要记住「最近一次拿到的 status / 课程 / 活动 / 同步预览」这些渲染素材。
 * 所有交互都只改这一份数据，再 lmsPaint() 整体重画，避免 DOM 与数据不一致。
 *
 * 注意：这里不保存密码。登录表单的失败分支全部原地更新（见 lmsLoginCard），
 * 只有登录态真正前进（已登录 / 需要两步验证）时才重画。
 */
const lmsUi = {
  mount: null,
  /** 当前页：`home`（首页：账号状态 + 课程） 或 `course`（课程页）。 */
  page: 'home',
  /** 课程页正在看哪门课。 */
  courseId: null,
  /** 课程页数据（课程信息 + 该课活动分组），来自 GET /lms/courses/:id。 */
  coursePage: null,
  courseBusy: false,
  courseError: null,
  status: null,
  statusLoading: false,
  statusError: null,
  courses: null,
  coursesBusy: false,
  coursesError: null,
  /**
   * 活动缓存。首页只用它算"这门课有多少作业/网课"（课程行下面那行分布），
   * 课程页的内容走 `/lms/courses/:id`。
   */
  activities: null,
  activitiesBusy: false,
  activitiesError: null,
  /** 课程卡的学期折叠：key → true/false；`courseSemestersAll` 是「全部展开/收起」的覆盖。 */
  courseSemesterToggle: new Map(),
  courseSemestersAll: null,
  /** 只记住学号（方便切走再切回来），明文密码不留在内存里。 */
  username: '',
  loginError: null,
  mfaSent: false,
  mfaPhoneMasked: null,
  mfaError: null,
  /** 自动同步设置（在账号状态卡里）的忙碌态与错误。 */
  autoSyncBusy: false,
  autoSyncError: null,
  /** 回放：已取到的视频列表（按活动 id 缓存）与展开/忙碌状态。 */
  replays: new Map(),
  replayOpen: null,
  replayBusy: false,
  replayError: null,
  /** 课程页各分节的折叠状态（key = `${courseId}:${kind}`，默认展开）。 */
  sectionToggle: new Map(),
  /** 下载任务列表（轮询 GET /lms/downloads）、落盘目录、轮询定时器。 */
  downloads: null,
  downloadDir: null,
  downloadTimer: null,
  /** 这一屏渲染出来的下载状态节点（按任务 id），用于轮询时原地更新、不整屏重画。 */
  downloadNodes: new Map(),
  /** 上一次看到的任务状态，用来判断"刚跑完"要补一次重画。 */
  downloadStatus: new Map(),
  /** 当前这一次渲染出来的节点，用于不重画的原地更新（自动同步那一行）。 */
  refs: { autoSync: null },
};

const LMS_STATUS_LABEL = {
  anonymous: '未登录',
  need_mfa: '需要两步验证',
  need_captcha: '需要图形验证码',
  ready: '已登录',
  error: '登录异常',
};

/**
 * 活动类型页签。
 *
 * 「网课」= 直播 + 回放 + 在线视频（见 LMS_TYPE_MATCH），都是学堂里同一门课的形态，
 * 所以左栏不再单开一个「网课」入口 —— 网课就长在思源学堂里，每一行仍标注具体是哪种。
 * 后端 `/lms/activities?type=online` 用的是同一套划分（modules/lms/config.js）。
 */
const LMS_TYPE_TABS = [
  ['', '全部'],
  ['homework', '作业'],
  ['online', '网课'],
  ['material', '资料'],
];

/**
 * 分组默认全展开的阈值：这一层不超过 12 条就展开（小列表直接看内容），
 * 超了就收起先看概览。课程卡的学期分组、课程页的分节都用它。
 */
const LMS_GROUP_AUTO_EXPAND = 12;

/** 页签值 -> 命中的底层类型；不在表里就按 type 精确匹配。 */
const LMS_TYPE_MATCH = {
  online: ['lecture_live', 'lesson', 'online_video'],
};

const LMS_ACTIVITY_LABEL = {
  homework: '作业',
  lecture_live: '直播',
  lesson: '课程回放',
  material: '资料',
  course: '课程',
  // 下面这些是实测真实账号里出现、不参与同步的类型。**必须和后端 config.js 的
  // ACTIVITY_TYPE_LABEL 保持一致**，否则列表里会冒出裸英文（online_video 就漏过一次）。
  page: '课程页面',
  forum: '讨论',
  web_link: '外部链接',
  online_video: '在线视频',
  questionnaire: '问卷',
  exam: '考试',
  unknown: '其它',
};

const LMS_ACTION_LABEL = { create: '新建', update: '更新', skip: '跳过', stale: '失效' };

const lmsView = {
  title: '思源学堂',

  render(ctx) {
    lmsUi.mount = ctx.mount;
    lmsPaint();
  },
};

/* --------------------------------------------------------------- 小工具 */

/**
 * 时间展示：思源学堂返回的是不带时区的 ISO 串（`2026-10-14T23:59:00`），
 * 直接按字面量切片最稳，避免 `new Date()` 把它当 UTC 而串到前一天。
 * 只保留到分钟，并把 T 换成空格。
 */
function lmsFormatTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (match) return match[2] ? `${match[1]} ${match[2]}` : match[1];
  return lmsFormatStamp(text);
}

/** 后端生成的 `lastSyncAt` / `fetchedAt` 是带 Z 的 ISO，按本地时间展示。 */
function lmsFormatStamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return (
    `${date.getFullYear()}-${PCUtil.pad2(date.getMonth() + 1)}-${PCUtil.pad2(date.getDate())}` +
    ` ${PCUtil.pad2(date.getHours())}:${PCUtil.pad2(date.getMinutes())}`
  );
}

/** 顶部工具条按钮：忙碌态由数据驱动，重画后自动恢复。 */
function lmsActionButton(label, busyLabel, busy, handler) {
  const button = mk('button', 'ghost-btn', busy ? busyLabel : label);
  button.type = 'button';
  button.disabled = Boolean(busy);
  button.addEventListener('click', () => handler());
  return button;
}

function lmsUserText(status) {
  const user = status?.user;
  if (!user) return '未登录';
  const name = user.name || '（未获取到姓名）';
  const no = user.userNo ? `（${user.userNo}）` : '';
  return `${name}${no}${user.department ? ` · ${user.department}` : ''}`;
}

function lmsStatusPill(status) {
  const kind = status === 'ready' ? 'ready' : status === 'error' ? 'error' : status === 'anonymous' ? '' : 'warn';
  return mk('span', `lms-pill ${kind}`.trim(), LMS_STATUS_LABEL[status] ?? status ?? '未知');
}

/**
 * 载入图形验证码。
 *
 * Electron 用 file:// 载入页面时 CSP 的 `img-src 'self' data:` 不放行 http://127.0.0.1，
 * 所以 <img> 一旦加载失败就退回「fetch → data URL」（connect-src 与 img 的 data: 都是放行的）。
 */
function lmsLoadCaptcha(img, note) {
  const url = `${PC.state.apiBase}/lms/captcha?t=${Date.now()}`;
  if (note) note.textContent = '';
  img.onerror = () => {
    img.onerror = null;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`验证码接口返回 ${response.status}`);
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('验证码图片解码失败'));
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => {
        img.src = String(dataUrl);
      })
      .catch((error) => {
        if (note) note.textContent = `验证码加载失败：${error.message}`;
      });
  };
  img.src = url;
}

/* --------------------------------------------------------------- 数据加载 */

/**
 * 业务接口返回 401：学堂登录态已经失效（后端此时已清掉票据），
 * 顺手把状态刷新一次，界面就会退回登录表单，而不是停在一个已经不能用的页面上。
 */
function lmsCheckAuthLost(error) {
  if (error?.status === 401) void lmsLoadStatus();
}

async function lmsLoadStatus({ manual = false } = {}) {
  if (lmsUi.statusLoading) return;
  lmsUi.statusLoading = true;
  lmsUi.statusError = null;
  if (manual) lmsPaint();
  try {
    lmsUi.status = await PC.api('/lms/status');
  } catch (error) {
    lmsUi.statusError = error.message;
  } finally {
    lmsUi.statusLoading = false;
    lmsPaint();
  }
}

async function lmsLoadCourses(refresh) {
  if (lmsUi.coursesBusy) return;
  lmsUi.coursesBusy = true;
  lmsUi.coursesError = null;
  lmsPaint();
  try {
    lmsUi.courses = await PC.api(`/lms/courses${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    lmsUi.coursesError = error.message;
    // 置空对象而不是 null：避免每次重画都自动重试，把失败的接口刷爆
    lmsUi.courses = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.coursesBusy = false;
    lmsPaint();
  }
}

async function lmsLoadActivities(refresh) {
  if (lmsUi.activitiesBusy) return;
  lmsUi.activitiesBusy = true;
  lmsUi.activitiesError = null;
  lmsPaint();
  try {
    // 不传 type：后端在 refresh=1 时并不做类型过滤，统一由前端过滤，行为才一致
    lmsUi.activities = await PC.api(`/lms/activities${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    lmsUi.activitiesError = error.message;
    lmsUi.activities = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.activitiesBusy = false;
    lmsPaint();
  }
}

/** 重画后按需补数据：只有「还没拿过」才自动拉，避免反复请求。 */
function lmsMaybeLoad() {
  if (!lmsUi.status) {
    if (!lmsUi.statusLoading) void lmsLoadStatus();
    return;
  }
  if (lmsUi.status.status !== 'ready') return;
  if (lmsUi.courses === null && !lmsUi.coursesBusy) void lmsLoadCourses(false);
  if (lmsUi.activities === null && !lmsUi.activitiesBusy) void lmsLoadActivities(false);
}

/* --------------------------------------------------------------- 登录 / 验证 */

function lmsOnLoggedIn() {
  lmsUi.loginError = null;
  lmsUi.mfaSent = false;
  lmsUi.mfaPhoneMasked = null;
  lmsUi.mfaError = null;
  lmsUi.courses = null;
  lmsUi.coursesError = null;
  lmsUi.activities = null;
  lmsUi.activitiesError = null;
  lmsUi.coursePage = null;
  lmsUi.replays = new Map();
  lmsUi.replayOpen = null;
  lmsUi.autoSyncError = null;
  PC.toast('已登录思源学堂');
  lmsPaint();
}

async function lmsLogout() {
  try {
    const status = await PC.api('/lms/logout', { method: 'POST', body: {} });
    lmsUi.status = status;
    lmsUi.courses = null;
    lmsUi.activities = null;
    lmsUi.coursePage = null;
    lmsUi.replays = new Map();
    lmsUi.replayOpen = null;
    lmsUi.loginError = null;
    lmsUi.mfaSent = false;
    lmsUi.mfaPhoneMasked = null;
    lmsUi.mfaError = null;
    lmsUi.autoSyncError = null;
    PC.toast('已退出思源学堂');
  } catch (error) {
    lmsUi.statusError = error.message;
  }
  lmsPaint();
}

/**
 * 保存自动同步设置：两个字段一起传（后端 updateSettings 也支持只传其中一个）。
 * 成功后用返回的 status 刷新状态卡片，失败（400 校验 / 401 未登录）走卡片里的错误条。
 */
async function lmsSaveAutoSync(enabled, intervalHours) {
  lmsUi.autoSyncBusy = true;
  lmsUi.autoSyncError = null;
  const controls = lmsUi.refs.autoSync;
  if (controls) {
    controls.toggle.disabled = true;
    controls.hours.disabled = true;
  }
  try {
    const status = await PC.api('/lms/settings', {
      method: 'POST',
      body: { autoSync: enabled, autoSyncIntervalHours: intervalHours },
    });
    lmsUi.status = status;
    PC.toast(enabled ? `已开启自动同步：每 ${intervalHours} 小时` : '已关闭自动同步');
  } catch (error) {
    lmsUi.autoSyncError = error.message;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.autoSyncBusy = false;
    lmsPaint();
  }
}

async function lmsSendMfa(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '发送中…';
  lmsUi.mfaError = null;
  try {
    const result = await PC.api('/lms/mfa/send', { method: 'POST', body: {} });
    if (result.status) lmsUi.status = result.status;
    lmsUi.mfaSent = true;
    lmsUi.mfaPhoneMasked = result.phoneMasked ?? lmsUi.mfaPhoneMasked;
    PC.toast('验证码已发送');
  } catch (error) {
    lmsUi.mfaError = error.message;
  }
  if (button.isConnected) {
    button.disabled = false;
    button.textContent = label;
  }
  lmsPaint();
}

/** 登录卡片：失败分支全部原地更新，保住用户已经输入的密码。 */
function lmsLoginCard() {
  const status = lmsUi.status;
  const card = mk('div', 'card');

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', status?.status === 'need_captcha' ? '登录（需要图形验证码）' : '登录思源学堂'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(mk('span', 'lms-hint', '统一身份认证的学号 / 工号'));
  card.appendChild(head);

  const form = mk('div', 'lms-form');

  const username = mk('input');
  username.type = 'text';
  username.placeholder = '学号 / 用户名';
  username.autocomplete = 'username';
  username.value = lmsUi.username;
  username.addEventListener('input', () => {
    lmsUi.username = username.value;
  });
  form.appendChild(field('学号 / 用户名', username));

  const password = mk('input');
  password.type = 'password';
  password.placeholder = '密码';
  password.autocomplete = 'current-password';
  form.appendChild(field('密码', password));

  const captchaField = mk('div', 'field hidden');
  captchaField.appendChild(mk('span', 'field-label', '图形验证码'));
  const captchaRow = mk('div', 'lms-captcha');
  const captchaInput = mk('input');
  captchaInput.type = 'text';
  captchaInput.placeholder = '验证码';
  captchaInput.autocomplete = 'off';
  const captchaImg = mk('img');
  captchaImg.alt = '图形验证码';
  captchaImg.title = '点击刷新验证码';
  const captchaReload = mk('button', 'ghost-btn', '换一张');
  captchaReload.type = 'button';
  const captchaNote = mk('span', 'lms-hint', '');
  captchaRow.append(captchaInput, captchaImg, captchaReload);
  captchaField.append(captchaRow, captchaNote);
  form.appendChild(captchaField);

  const error = mk('div', 'lms-error');
  const setError = (text) => {
    lmsUi.loginError = text || null;
    error.textContent = text || '';
    error.classList.toggle('hidden', !text);
  };
  form.appendChild(error);

  const actions = mk('div', 'lms-actions');
  const submit = mk('button', 'primary-btn', '登录');
  submit.type = 'button';
  actions.append(submit, mk('span', 'lms-hint', '回车即可提交'));
  form.appendChild(actions);
  card.appendChild(form);

  let captchaOn = Boolean(status?.captchaRequired) || status?.status === 'need_captcha';
  const reloadCaptcha = () => lmsLoadCaptcha(captchaImg, captchaNote);
  const showCaptcha = () => {
    captchaOn = true;
    captchaField.classList.remove('hidden');
    reloadCaptcha();
  };
  captchaReload.addEventListener('click', reloadCaptcha);
  captchaImg.addEventListener('click', reloadCaptcha);
  if (captchaOn) showCaptcha();

  setError(
    status?.status === 'need_captcha'
      ? status.error ?? '请输入图形验证码'
      : status?.status === 'error'
        ? status.error ?? '登录失败'
        : lmsUi.loginError,
  );

  const doSubmit = async () => {
    if (submit.disabled) return;
    const name = username.value.trim();
    const secret = password.value;
    const code = captchaInput.value.trim();
    if (!name) {
      setError('请填写学号 / 用户名');
      username.focus();
      return;
    }
    if (!secret) {
      setError('请填写密码');
      password.focus();
      return;
    }
    if (captchaOn && !code) {
      setError('请填写图形验证码');
      captchaInput.focus();
      return;
    }
    setError(null);
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      const next = await PC.api('/lms/login', {
        method: 'POST',
        body: { username: name, password: secret, captcha: captchaOn ? code : undefined },
      });
      lmsUi.status = next;
      if (next.status === 'ready') {
        lmsOnLoggedIn(); // 重画后本卡片会被替换，finally 里不再动 DOM
        return;
      }
      if (next.status === 'need_mfa') {
        lmsUi.mfaSent = Boolean(next.mfa?.sent);
        lmsUi.mfaPhoneMasked = next.mfa?.phoneMasked ?? null;
        lmsUi.mfaError = null;
        lmsPaint();
        return;
      }
      // 连续失败会要求图形验证码：原地把验证码行加出来，密码不用重输
      if (next.captchaRequired && !captchaOn) showCaptcha();
      if (next.status === 'need_captcha') {
        reloadCaptcha();
        captchaInput.value = '';
      }
      setError(next.error ?? '登录失败');
    } catch (err) {
      setError(err.message);
    } finally {
      if (submit.isConnected) {
        submit.disabled = false;
        submit.textContent = '登录';
      }
    }
  };

  submit.addEventListener('click', () => void doSubmit());
  for (const input of [username, password, captchaInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void doSubmit();
      }
    });
  }
  return card;
}

/** 两步验证卡片（短信验证码 / Safety Verify 二次认证共用）。 */
function lmsMfaCard() {
  const status = lmsUi.status;
  const flow = status?.mfa?.flow === 'sec' ? 'sec' : 'mfa';
  const sendLabel = flow === 'sec' ? '发送验证码' : '发送短信验证码';
  const sent = lmsUi.mfaSent || Boolean(status?.mfa?.sent);
  const phone = lmsUi.mfaPhoneMasked ?? status?.mfa?.phoneMasked ?? null;

  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.append(
    mk('div', 'card-title', '两步验证'),
    mk('div', 'spacer'),
    mk('span', 'lms-pill warn', flow === 'sec' ? '二次认证' : '短信验证'),
  );
  card.appendChild(head);

  const error = mk('div', 'lms-error');
  const setError = (text) => {
    lmsUi.mfaError = text || null;
    error.textContent = text || '';
    error.classList.toggle('hidden', !text);
  };

  if (!sent) {
    card.appendChild(
      mk(
        'div',
        'lms-hint',
        flow === 'sec' ? '学校要求二次认证：先获取验证码，再输入收到的 6 位数字。' : '学校要求短信验证：先获取验证码，再输入收到的 6 位数字。',
      ),
    );
    const actions = mk('div', 'lms-actions');
    const send = mk('button', 'primary-btn', sendLabel);
    send.type = 'button';
    send.addEventListener('click', () => void lmsSendMfa(send));
    actions.appendChild(send);
    card.appendChild(actions);
    setError(lmsUi.mfaError);
    card.appendChild(error);
    return card;
  }

  card.appendChild(mk('div', 'lms-hint', phone ? `验证码已发送至 ${phone}` : '验证码已发送，请查看手机'));
  const form = mk('div', 'lms-form');
  const code = mk('input');
  code.type = 'text';
  code.inputMode = 'numeric';
  code.maxLength = 6;
  code.placeholder = '6 位验证码';
  code.autocomplete = 'one-time-code';
  form.appendChild(field('验证码', code));

  const actions = mk('div', 'lms-actions');
  const verify = mk('button', 'primary-btn', '提交验证码');
  verify.type = 'button';
  const resend = mk('button', 'ghost-btn', '重新发送');
  resend.type = 'button';
  actions.append(verify, resend);
  form.appendChild(actions);
  form.appendChild(error);
  setError(lmsUi.mfaError);
  card.appendChild(form);

  const doVerify = async () => {
    const value = code.value.trim();
    if (!/^\d{6}$/.test(value)) {
      setError('请输入 6 位数字验证码');
      code.focus();
      return;
    }
    setError(null);
    verify.disabled = true;
    verify.textContent = '校验中…';
    try {
      const next = await PC.api('/lms/mfa/verify', { method: 'POST', body: { code: value } });
      lmsUi.status = next;
      if (next.status === 'ready') {
        lmsOnLoggedIn();
        return;
      }
      setError(next.error ?? '验证码校验失败');
    } catch (err) {
      setError(err.message);
    } finally {
      if (verify.isConnected) {
        verify.disabled = false;
        verify.textContent = '提交验证码';
      }
    }
  };
  verify.addEventListener('click', () => void doVerify());
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void doVerify();
    }
  });
  resend.addEventListener('click', () => void lmsSendMfa(resend));
  requestAnimationFrame(() => code.focus());
  return card;
}

/* --------------------------------------------------------------- 卡片 */

function lmsStatusCard() {
  const card = mk('div', 'card');
  const status = lmsUi.status;

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '账号状态'));
  head.appendChild(mk('div', 'spacer'));
  if (status) head.appendChild(lmsStatusPill(status.status));
  card.appendChild(head);

  const body = mk('div', 'card-body');
  const kv = (key, value) => {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', key), mk('span', 'kv-val', value ?? '—'));
    body.appendChild(row);
  };

  if (!status) {
    kv('状态', lmsUi.statusLoading ? '读取中…' : '未知');
  } else {
    kv('账号', lmsUserText(status));
    if (status.status === 'need_mfa') {
      kv('验证方式', status.mfa?.flow === 'sec' ? '二次认证（Safety Verify）' : '短信验证码');
      kv('手机号', lmsUi.mfaPhoneMasked ?? status.mfa?.phoneMasked ?? '尚未发送');
    }
    kv('上次同步', status.lastSyncAt ? lmsFormatStamp(status.lastSyncAt) : '尚未同步');
    kv('已同步', `日程 ${status.synced?.schedules ?? 0} 条 · 事件 ${status.synced?.events ?? 0} 条`);
    kv('本地缓存', `课程 ${status.cache?.courses ?? 0} 门 · 活动 ${status.cache?.activities ?? 0} 条`);
    kv(
      '缓存时间',
      `课程 ${status.cache?.lastCoursesAt ? lmsFormatStamp(status.cache.lastCoursesAt) : '—'}` +
        ` · 活动 ${status.cache?.lastActivitiesAt ? lmsFormatStamp(status.cache.lastActivitiesAt) : '—'}`,
    );
    kv('服务地址', status.baseUrl ?? '—');
    if (status.error) kv('最近错误', status.error);
  }
  card.appendChild(body);

  if (lmsUi.statusError) card.appendChild(mk('div', 'lms-error', `状态读取失败：${lmsUi.statusError}`));
  card.appendChild(lmsAutoSyncRow(status));

  if (status && status.status !== 'anonymous') {
    const actions = mk('div', 'lms-actions');
    const out = mk('button', 'ghost-btn', '退出登录');
    out.type = 'button';
    out.addEventListener('click', () => void lmsLogout());
    actions.append(mk('div', 'spacer'), out);
    card.appendChild(actions);
  }
  return card;
}

/**
 * 自动同步设置行（POST /lms/settings）。
 *
 * 未登录时置灰而不是隐藏：设置本身是持久的，置灰能让用户知道它在哪、为什么不能用。
 * 任何一次改动都把 autoSync 与 autoSyncIntervalHours 一起提交；成功后用返回的 status 刷新卡片。
 */
function lmsAutoSyncRow(status) {
  const autoSync = status?.autoSync ?? {};
  const ready = status?.status === 'ready';
  const disabled = !ready || lmsUi.autoSyncBusy;

  const box = mk('div', 'lms-autosync');
  const toggleLabel = mk('label', 'check-field');
  const toggle = mk('input', 'lms-autosync-toggle');
  toggle.type = 'checkbox';
  toggle.checked = Boolean(autoSync.enabled);
  toggle.disabled = disabled;
  toggleLabel.append(toggle, mk('span', null, '自动同步'));

  const hoursWrap = mk('span', 'lms-hours');
  const hours = mk('input', 'lms-autosync-hours');
  hours.type = 'number';
  hours.min = '1';
  hours.max = '168';
  hours.step = '1';
  hours.title = '自动同步间隔（1~168 小时）';
  hours.value = String(Number(autoSync.intervalHours) > 0 ? Number(autoSync.intervalHours) : 6);
  hours.disabled = disabled;
  hoursWrap.append(hours, mk('span', 'lms-hint', '小时'));

  box.append(
    toggleLabel,
    hoursWrap,
    mk('span', 'lms-hint', `最近自动同步：${autoSync.lastRunAt ? lmsFormatStamp(autoSync.lastRunAt) : '尚未执行'}`),
    mk('span', 'lms-hint', ready ? '改动即时生效 · 默认关闭' : '登录后可用 · 默认关闭'),
  );
  lmsUi.refs.autoSync = { toggle, hours };

  const apply = () => {
    if (disabled) return;
    const raw = Number(hours.value);
    if (!Number.isFinite(raw) || raw < 1 || raw > 168) {
      lmsUi.autoSyncError = '自动同步间隔需为 1~168 小时';
      lmsPaint();
      return;
    }
    void lmsSaveAutoSync(toggle.checked, raw);
  };
  toggle.addEventListener('change', apply);
  hours.addEventListener('change', apply);

  const wrap = mk('div', 'lms-autosync-block');
  wrap.appendChild(box);
  wrap.appendChild(mk('div', 'lms-hint', '自动同步只新建与更新记录，不会删除任何日程（默认关闭）。'));
  if (lmsUi.autoSyncError) wrap.appendChild(mk('div', 'lms-error', `自动同步设置失败：${lmsUi.autoSyncError}`));
  return wrap;
}

function lmsCoursesCard() {
  const card = mk('div', 'card');
  const items = lmsUi.courses?.items ?? [];
  const semesters = lmsSemesterOptions();

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '课程'));
  if (lmsUi.courses?.count) {
    // 学期数一起报出来 —— 课程多的时候它就是"按学期分"的那一层
    head.appendChild(
      mk('span', 'lms-hint', `${lmsUi.courses.count} 门 · ${semesters.length} 个学期`),
    );
  }
  head.appendChild(mk('div', 'spacer'));
  if (semesters.length > 1) {
    head.appendChild(
      lmsAllToggleButton({
        expanded: lmsEverythingExpanded(lmsUi.courseSemestersAll, items.length),
        onClick: () => {
          lmsUi.courseSemestersAll = !lmsEverythingExpanded(lmsUi.courseSemestersAll, items.length);
          lmsResetGroupState({ keep: 'courseSemestersAll' });
          lmsPaint();
        },
      }),
    );
  }
  head.appendChild(lmsActionButton('刷新课程', '刷新中…', lmsUi.coursesBusy, () => void lmsLoadCourses(true)));
  card.appendChild(head);

  if (lmsUi.coursesError) card.appendChild(mk('div', 'lms-error', `课程加载失败：${lmsUi.coursesError}`));

  if (lmsUi.courses === null || (lmsUi.coursesBusy && !items.length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    card.appendChild(emptyBox('还没有课程缓存，点「刷新课程」从思源学堂拉取。'));
    return card;
  }

  // 课程也按学期分（新学期在前，最新那个默认展开）
  semesters.forEach((semester, index) =>
    card.appendChild(lmsCourseSemesterSection(semester, index === 0, items.length)),
  );
  if (lmsUi.courses?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.courses.fetchedAt)}`));
  }
  return card;
}

/** 课程卡里的一个学期分组。 */
function lmsCourseSemesterSection(semester, isNewest, totalCourses) {
  const expanded = lmsGroupExpandedIn(lmsUi.courseSemesterToggle, lmsUi.courseSemestersAll, semester.key, {
    isNewest,
    smallEnough: totalCourses <= LMS_GROUP_AUTO_EXPAND,
  });
  return lmsCollapsibleGroup({
    label: semester.label,
    level: 1,
    tags: [mk('span', 'lms-hint', `${semester.courses.length} 门`)],
    expanded,
    onToggle: (next) => {
      lmsUi.courseSemesterToggle.set(semester.key, next);
      lmsUi.courseSemestersAll = null;
      lmsPaint();
    },
    render: () => semester.courses.map((course) => lmsCourseRow(course, { clickable: true })),
  });
}

function lmsCourseRow(course, { clickable = false } = {}) {
  const row = mk('div', clickable ? 'lms-row lms-row-clickable' : 'lms-row');
  if (clickable) {
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.title = '打开课程页';
    const open = () => lmsOpenCourse(course.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, course.name ?? '（未命名课程）'));
  if (course.courseCode) title.appendChild(mk('span', 'tag', course.courseCode));
  if (course.compulsory) title.appendChild(mk('span', 'tag', '必修'));
  row.appendChild(title);

  const teachers = (course.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course.semester?.realName || course.semester?.name || course.semester?.label;
  const meta1 = [
    teachers ? `教师：${teachers}` : null,
    course.credit ? `学分：${course.credit}` : null,
    semester ? `学期：${semester}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta1) row.appendChild(mk('div', 'lms-row-meta', meta1));

  const klass = course.teachingClassName || course.klass;
  const range = course.startDate || course.endDate ? `${course.startDate ?? '?'} ~ ${course.endDate ?? '?'}` : null;
  const meta2 = [klass ? `教学班：${klass}` : null, range].filter(Boolean).join(' · ');
  if (meta2) row.appendChild(mk('div', 'lms-row-meta', meta2));

  // 这门课缓存里有多少活动（按类型分）—— "按课程分类"的另一半：
  // 课程列表也能一眼看出哪门课有东西待办
  const counts = lmsCourseActivityCounts(course.id);
  if (counts) row.appendChild(mk('div', 'lms-row-meta lms-course-counts', counts));
  if (clickable) row.appendChild(mk('div', 'lms-row-more', '进入课程页 ›'));

  return row;
}

/**
 * 作业的提交状态是不是"已知"。
 *
 * 活动列表接口**不返回**提交状态（`userSubmitCount`），它是补拉活动详情才有的字段，
 * 而且一次预览最多补拉 40 条。所以"没有这个字段"≠"没提交" —— 是**还没查**。
 * 两者必须分开：混在一起就是在骗用户。
 */
function lmsSubmitKnown(item) {
  return item?.userSubmitCount !== undefined && item?.userSubmitCount !== null;
}

/** 明确未提交（查过了，确实是 0）。 */
function lmsSubmitPending(item) {
  return lmsSubmitKnown(item) && Number(item.userSubmitCount) === 0;
}

/** 某门课在活动缓存里的分布，形如「作业 3（未提交 2） · 网课 12 · 资料 5」。 */
function lmsCourseActivityCounts(courseId) {
  const items = (lmsUi.activities?.items ?? []).filter((item) => String(item.courseId) === String(courseId));
  if (!items.length) return '';
  const homework = items.filter((item) => item.type === 'homework');
  const online = items.filter((item) => (LMS_TYPE_MATCH.online ?? []).includes(item.type));
  const others = items.filter((item) => item.type !== 'homework' && !(LMS_TYPE_MATCH.online ?? []).includes(item.type));
  const pending = homework.filter(lmsSubmitPending).length;
  const unknown = homework.filter((item) => !lmsSubmitKnown(item)).length;
  const detail = [pending ? `未提交 ${pending}` : null, unknown ? `未查 ${unknown}` : null].filter(Boolean).join(' · ');
  return [
    homework.length ? `作业 ${homework.length}${detail ? `（${detail}）` : ''}` : null,
    online.length ? `网课 ${online.length}` : null,
    others.length ? `其它 ${others.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 活动列表：类型与课程都在前端过滤（后端 refresh 时不做类型过滤）。 */
/* ------------------------------------------------------------------ 学期 */

/** 学期的身份：优先 id，其次 code，最后 label（同一学期必须落到同一个键上）。 */
function lmsSemesterKey(semester) {
  if (!semester) return '__none__';
  if (semester.id !== null && semester.id !== undefined) return `id:${semester.id}`;
  if (semester.code) return `code:${semester.code}`;
  const label = lmsSemesterLabel(semester);
  return label === '未知学期' ? '__none__' : `label:${label}`;
}

/** 学期怎么显示：接口已经把 real_name / name / code 归一成 label 了。 */
function lmsSemesterLabel(semester) {
  return semester?.label || semester?.realName || semester?.name || semester?.code || '未知学期';
}

/** 课程 id → 所属学期。活动只带 courseId，学期信息得从课程表查。 */
function lmsCourseSemesterIndex() {
  const index = new Map();
  for (const course of lmsUi.courses?.items ?? []) {
    index.set(String(course.id), {
      key: lmsSemesterKey(course.semester),
      label: course.semester ? lmsSemesterLabel(course.semester) : '未知学期',
    });
  }
  return index;
}

/**
 * 学期之间怎么排：**新学期在前**。
 *
 * 依据优先用学期内最晚的活动时间，其次课程起止日期，最后退化到学期 code
 * （`2026-1` 这种字符串直接比大小也够用）。都没有的（「未知学期」）永远排最后。
 */
function lmsSemesterRank(latestActivity, courses) {
  if (latestActivity) return latestActivity;
  let latest = '';
  for (const course of courses ?? []) {
    const stamp = String(course.endDate || course.startDate || '');
    if (stamp > latest) latest = stamp;
  }
  if (latest) return latest;
  for (const course of courses ?? []) {
    const code = String(course.semester?.code ?? '');
    if (code > latest) latest = code;
  }
  return latest;
}

function lmsSemesterSort(a, b) {
  if (a.key === '__none__') return 1;
  if (b.key === '__none__') return -1;
  return b.rank.localeCompare(a.rank) || a.label.localeCompare(b.label, 'zh');
}

/** 课程列表里出现过的所有学期（新学期在前）—— 学期下拉的选项。 */
function lmsSemesterOptions() {
  const semesters = new Map();
  for (const course of lmsUi.courses?.items ?? []) {
    const key = lmsSemesterKey(course.semester);
    if (!semesters.has(key)) {
      semesters.set(key, {
        key,
        label: course.semester ? lmsSemesterLabel(course.semester) : '未知学期',
        rank: '',
        courses: [],
      });
    }
    semesters.get(key).courses.push(course);
  }
  const list = [...semesters.values()];
  for (const semester of list) semester.rank = lmsSemesterRank('', semester.courses);
  return list.sort(lmsSemesterSort);
}

/* ------------------------------------------------------------------ 分组 */

/**
 * 分组展开与否。三档优先：**手动点过 > 全部展开/收起 > 自适应默认**。
 *
 * 自适应默认：这一层不超过 12 条就展开（小列表直接看内容），超了就收起（先看概览）。
 * 两层的"这一层"判据不同，故意的：
 *   - **学期层**看**整批**条数 —— 大账号（上千条）进来只展开最新学期，先看概览；
 *   - **课程层**看**这个学期自己**的条数 —— 展开一个小学期时，里面的课直接铺开。
 * 学期层还额外保证**最新学期一定展开**，否则大账号第一眼是一片折叠标题。
 */
function lmsGroupExpandedIn(map, allOverride, key, { isNewest = false, smallEnough = true } = {}) {
  const explicit = map.get(key);
  if (explicit !== undefined) return explicit;
  if (allOverride !== null) return allOverride;
  return smallEnough || isNewest;
}

/** 分组表头上的小标记：条数 / 未提交 / 未查 / 最近时间。 */
function lmsGroupTags({ count, pending = 0, unknown = 0, latest = '' }) {
  const tags = [mk('span', 'lms-hint', `${count} 条`)];
  if (pending) tags.push(mk('span', 'tag late', `未提交 ${pending}`));
  if (unknown) {
    const tag = mk('span', 'lms-hint', `未查 ${unknown}`);
    tag.title = '活动列表不含作业提交状态；「预览同步」时会补拉详情，那时才知道交没交';
    tags.push(tag);
  }
  if (latest) tags.push(mk('span', 'lms-hint lms-group-latest', `最近 ${lmsFormatTime(latest)}`));
  return tags;
}

/**
 * 通用可折叠分组：表头（箭头 + 标题 + 标记）+ 内容。
 *
 * 三处共用（活动卡的学期层、学期里的课程层、课程卡的学期层），免得三份各写一遍还长歪。
 * `render` 只在展开时调用 —— 活动上千条时这一步很关键。
 */
function lmsCollapsibleGroup({ label, level = 1, tags = [], expanded, onToggle, render }) {
  const box = mk('div', `lms-group lms-group-l${level}`);
  const head = mk('button', 'lms-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  head.appendChild(mk('span', 'lms-group-caret', expanded ? '▾' : '▸'));
  head.appendChild(mk('span', 'lms-group-name', label));
  for (const tag of tags) if (tag) head.appendChild(tag);
  head.addEventListener('click', () => onToggle(!expanded));
  box.appendChild(head);
  if (expanded) {
    const body = mk('div', `lms-list lms-group-body lms-group-body-l${level}`);
    for (const child of render()) body.appendChild(child);
    box.appendChild(body);
  }
  return box;
}

/** 「全部展开 / 全部收起」按钮（一层状态，按钮文案跟着实际状态走）。 */
function lmsAllToggleButton({ expanded, onClick }) {
  const button = mk('button', 'ghost-btn lms-group-all', expanded ? '全部收起' : '全部展开');
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** 当前是否"整体展开"（决定按钮文案）。 */
function lmsEverythingExpanded(override, total) {
  if (override !== null) return override;
  return total <= LMS_GROUP_AUTO_EXPAND;
}

/** 课程卡的「全部展开/收起」：清掉逐个点过的记录（`keep` 的那个覆盖值留着）。 */
function lmsResetGroupState({ keep } = {}) {
  if (keep !== 'courseSemestersAll') lmsUi.courseSemestersAll = null;
  lmsUi.courseSemesterToggle = new Map();
}

/* --------------------------------------------------------------- 课程页 */

/** 打开某门课的课程页（首页课程行点一下走这里）。 */
function lmsOpenCourse(courseId) {
  lmsUi.page = 'course';
  lmsUi.courseId = String(courseId);
  lmsUi.coursePage = null;
  lmsUi.courseError = null;
  lmsUi.replayOpen = null;
  lmsUi.replayError = null;
  lmsUi.sectionToggle = new Map();
  lmsPaint();
}

/** 回首页（课程页左上角返回键）。 */
function lmsBackHome() {
  lmsUi.page = 'home';
  lmsUi.courseId = null;
  lmsUi.coursePage = null;
  lmsUi.courseError = null;
  lmsStopDownloadPolling();
  lmsPaint();
}

/** 课程页数据：后端 `GET /lms/courses/:id` 读本地缓存，`refresh=1` 时先拉这门课的活动。 */
async function lmsLoadCoursePage({ refresh = false } = {}) {
  if (!lmsUi.courseId || lmsUi.courseBusy) return;
  lmsUi.courseBusy = true;
  lmsUi.courseError = null;
  if (refresh) lmsUi.coursePage = null;
  lmsPaint();
  try {
    if (refresh) {
      await PC.api('/lms/activities/refresh', { method: 'POST', body: { courseIds: [Number(lmsUi.courseId)] } });
    }
    lmsUi.coursePage = await PC.api(`/lms/courses/${encodeURIComponent(lmsUi.courseId)}`);
  } catch (error) {
    lmsUi.courseError = error.message ?? String(error);
  } finally {
    lmsUi.courseBusy = false;
    lmsPaint();
  }
}

/** 重画后按需补课程页数据。 */
function lmsMaybeLoadCourse() {
  if (lmsUi.coursePage === null && !lmsUi.courseBusy) void lmsLoadCoursePage();
}

/** 某个分节是否展开（默认展开 —— 课程页一共就几节，全收起反而要多点）。 */
function lmsSectionExpanded(kind, fallback = true) {
  const explicit = lmsUi.sectionToggle.get(`${lmsUi.courseId}:${kind}`);
  return explicit === undefined ? fallback : explicit;
}

/** 课程页的一个分节（标题 + 计数 + 可折叠内容）。 */
function lmsCourseSection({ kind, title, hint, items, renderItem, defaultExpanded = true }) {
  return lmsCollapsibleGroup({
    label: title,
    level: 1,
    tags: [mk('span', 'lms-hint', `${items.length} 条${hint ? ` · ${hint}` : ''}`)],
    expanded: lmsSectionExpanded(kind, defaultExpanded),
    onToggle: (next) => {
      lmsUi.sectionToggle.set(`${lmsUi.courseId}:${kind}`, next);
      lmsPaint();
    },
    render: () => {
      const list = mk('div', 'lms-list');
      for (const item of items) list.appendChild(renderItem(item));
      return [list];
    },
  });
}

/** 课程信息：教师 / 学分 / 学期 / 教学班 / 起止 / 必修。 */
function lmsCourseInfoBody(course) {
  const box = mk('div', 'lms-info');
  const teachers = (course.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course.semester?.label || course.semester?.realName || course.semester?.name;
  const rows = [
    ['课程代码', course.courseCode],
    ['教师', teachers],
    ['学分', course.credit],
    ['学期', semester],
    ['教学班', course.teachingClassName || course.klass],
    ['起止', course.startDate || course.endDate ? `${course.startDate ?? '?'} ~ ${course.endDate ?? '?'}` : null],
    ['类型', course.compulsory ? '必修' : null],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  for (const [label, value] of rows) {
    const line = mk('div', 'lms-info-row');
    line.append(mk('span', 'lms-info-key', label), mk('span', 'lms-info-val', String(value)));
    box.appendChild(line);
  }
  if (!rows.length) box.appendChild(mk('div', 'lms-hint', '学堂没有给出这门课的更多信息'));
  return box;
}

/** 活动行（作业/资料/直播共用）：标题 + 时间 + 提交状态。 */
function lmsCourseActivityRow(item) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[item.type] ?? item.type ?? '活动'));
  if (lmsSubmitKnown(item) && Number(item.userSubmitCount) > 0) title.appendChild(mk('span', 'tag submitted', '已提交'));
  if (lmsSubmitKnown(item) && Number(item.userSubmitCount) === 0) title.appendChild(mk('span', 'tag late', '未提交'));
  if (item.published === false) title.appendChild(mk('span', 'tag', '未发布'));
  row.appendChild(title);
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'));
  return row;
}

/** 体积文案（1024 进制），和后端 humanSize 保持一致的口径。 */
function lmsSizeText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 100 || unit === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)}${units[unit]}`;
}

/** 找一个回放视频对应的下载任务（按 活动 + 标签 匹配）。 */
function lmsJobFor(activityId, video) {
  return (lmsUi.downloads?.items ?? []).find(
    (job) => String(job.activityId ?? '') === String(activityId ?? '') && job.labelText === (video.labelText || '视频'),
  );
}

function lmsDownloadText(job) {
  if (job.status === 'running') {
    const percent = job.percent === null || job.percent === undefined ? '…' : `${job.percent}%`;
    const speed = job.speed ? ` · ${lmsSizeText(job.speed)}/s` : '';
    return `下载中 ${percent}${speed}`;
  }
  if (job.status === 'done') return `已保存（${lmsSizeText(job.total ?? job.bytes)}）`;
  if (job.status === 'cancelled') return '已取消';
  return `失败：${job.error ?? '未知原因'}`;
}

/** 下载状态节点（渲染时记进 downloadNodes，轮询时原地改文字，不整屏重画）。 */
function lmsDownloadStatus(job) {
  const node = mk('span', `lms-download-status is-${job.status}`, lmsDownloadText(job));
  if (job.path) node.title = job.path;
  lmsUi.downloadNodes.set(job.id, node);
  lmsUi.downloadStatus.set(job.id, job.status);
  return node;
}

/** 回放分节里的一行：一个回放活动 + 取到的视频 + 下载按钮/进度。 */
function lmsReplayRow(item) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', '课程回放'));
  row.appendChild(title);

  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'));

  const actions = mk('div', 'lms-row-actions');
  const busy = lmsUi.replayBusy && String(lmsUi.replayOpen) === String(item.id);
  const button = mk('button', 'ghost-btn', busy ? '取视频…' : lmsUi.replays.has(String(item.id)) ? '重新取视频' : '取视频');
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', () => void lmsLoadReplays(item));
  actions.appendChild(button);
  row.appendChild(actions);

  const videos = lmsUi.replays.get(String(item.id));
  if (videos) {
    const list = mk('div', 'lms-replay-videos');
    if (!videos.length) list.appendChild(mk('div', 'lms-hint', '这次回放没有可下载的视频'));
    for (const video of videos) {
      const line = mk('div', 'lms-replay-video');
      line.appendChild(mk('span', 'lms-replay-name', `${video.labelText}${video.sizeText ? ` · ${video.sizeText}` : ''}`));
      if (video.isBestAudio) line.appendChild(mk('span', 'tag', '音质更好'));
      const job = lmsJobFor(item.id, video);
      if (job) {
        line.appendChild(lmsDownloadStatus(job));
        if (job.status === 'running') {
          const cancel = mk('button', 'ghost-btn', '取消');
          cancel.type = 'button';
          cancel.addEventListener('click', () => void lmsCancelDownload(job.id));
          line.appendChild(cancel);
        }
      } else {
        const download = mk('button', 'ghost-btn', '下载');
        download.type = 'button';
        download.addEventListener('click', () => void lmsStartDownload(item, video));
        line.appendChild(download);
      }
      list.appendChild(line);
    }
    row.appendChild(list);
  }
  if (lmsUi.replayError && String(lmsUi.replayOpen) === String(item.id)) {
    row.appendChild(mk('div', 'lms-error', lmsUi.replayError));
  }
  return row;
}

/** 取一次回放的视频列表（后端去学堂与录播站换票据，注意别把地址打日志）。 */
async function lmsLoadReplays(item) {
  if (lmsUi.replayBusy) return;
  lmsUi.replayBusy = true;
  lmsUi.replayOpen = item.id;
  lmsUi.replayError = null;
  lmsPaint();
  try {
    const data = await PC.api(`/lms/activities/${encodeURIComponent(item.id)}/replays`);
    lmsUi.replays.set(String(item.id), data.videos ?? []);
  } catch (error) {
    lmsUi.replayError = error.message ?? String(error);
  } finally {
    lmsUi.replayBusy = false;
    lmsPaint();
  }
}

async function lmsStartDownload(item, video) {
  try {
    await PC.api('/lms/downloads', {
      method: 'POST',
      body: {
        activityId: item.id,
        video: {
          downloadUrl: video.downloadUrl,
          playUrl: video.playUrl,
          label: video.label,
          labelText: video.labelText,
          size: video.size,
        },
      },
    });
    PC.toast?.(`开始下载：${item.title ?? '回放'}`);
    await lmsRefreshDownloads();
    lmsStartDownloadPolling();
  } catch (error) {
    lmsUi.replayError = error.message ?? String(error);
  }
  lmsPaint();
}

async function lmsCancelDownload(id) {
  try {
    await PC.api(`/lms/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  } catch (error) {
    PC.toast?.(`取消失败：${error.message}`);
  }
  await lmsRefreshDownloads();
  lmsPaint();
}

async function lmsRefreshDownloads() {
  try {
    const data = await PC.api('/lms/downloads');
    lmsUi.downloads = data;
    lmsUi.downloadDir = data.downloadDir ?? lmsUi.downloadDir;
    return data;
  } catch {
    return null;
  }
}

/**
 * 下载进度轮询：只在有任务在跑时开着。
 *
 * 更新策略：**原地改文字**（节点在渲染时记进 `downloadNodes`）。否则每 800ms 整屏重画，
 * 列表会闪、折叠状态和滚动位置也保不住。任务从"跑着"变成终态时补一次重画 ——
 * 那一刻按钮要从「取消」变回「下载」。
 */
function lmsStartDownloadPolling() {
  if (lmsUi.downloadTimer) return;
  lmsUi.downloadTimer = setInterval(async () => {
    const data = await lmsRefreshDownloads();
    if (!data) return;
    let finished = false;
    for (const job of data.items) {
      if (lmsUi.downloadStatus.get(job.id) === 'running' && job.status !== 'running') finished = true;
      lmsUi.downloadStatus.set(job.id, job.status);
      const node = lmsUi.downloadNodes.get(job.id);
      if (node) {
        node.textContent = lmsDownloadText(job);
        node.className = `lms-download-status is-${job.status}`;
      }
    }
    if (!data.active) {
      lmsStopDownloadPolling();
      if (finished) lmsPaint();
    }
  }, 800);
}

function lmsStopDownloadPolling() {
  if (lmsUi.downloadTimer) {
    clearInterval(lmsUi.downloadTimer);
    lmsUi.downloadTimer = null;
  }
}

/** 课程页整屏：返回键 + 课程信息 + 回放（可下载）+ 作业/资料/直播。 */
function lmsCourseView() {
  const wrap = mk('div', 'lms-course');
  const page = lmsUi.coursePage;
  const course = page?.course;

  const bar = mk('div', 'lms-course-bar');
  const back = mk('button', 'ghost-btn lms-back', '← 返回');
  back.type = 'button';
  back.addEventListener('click', lmsBackHome);
  bar.appendChild(back);
  bar.appendChild(mk('div', 'card-title', course?.name ?? '课程'));
  if (course?.courseCode) bar.appendChild(mk('span', 'tag', course.courseCode));
  if (course?.compulsory) bar.appendChild(mk('span', 'tag', '必修'));
  bar.appendChild(mk('div', 'spacer'));
  if (lmsUi.downloadDir) bar.appendChild(mk('span', 'lms-hint', `下载到 ${lmsUi.downloadDir}`));
  bar.appendChild(
    lmsActionButton('刷新本课活动', '刷新中…', lmsUi.activitiesBusy, () => void lmsLoadCoursePage({ refresh: true })),
  );
  wrap.appendChild(bar);

  if (lmsUi.courseError) wrap.appendChild(mk('div', 'lms-error', `课程页加载失败：${lmsUi.courseError}`));
  if (!page) {
    wrap.appendChild(mk('div', 'loading', lmsUi.courseBusy ? '加载中…' : '没有数据，点「刷新本课活动」'));
    return wrap;
  }

  // 1) 课程信息
  wrap.appendChild(
    lmsCollapsibleGroup({
      label: '课程信息',
      level: 1,
      tags: [mk('span', 'lms-hint', course?.semester?.label || course?.semester?.name || '')],
      expanded: lmsSectionExpanded('info'),
      onToggle: (next) => {
        lmsUi.sectionToggle.set(`${lmsUi.courseId}:info`, next);
        lmsPaint();
      },
      render: () => [lmsCourseInfoBody(course)],
    }),
  );

  // 2) 课程回放（第一个可用功能：可下载）
  const replays = page.groups?.replay ?? [];
  if (replays.length) {
    wrap.appendChild(
      lmsCourseSection({ kind: 'replay', title: '课程回放', items: replays, renderItem: lmsReplayRow, hint: '可下载' }),
    );
  }

  // 3) 作业 / 资料 / 直播 / 其它
  const sections = [
    ['homework', '作业', page.groups?.homework ?? []],
    ['material', '资料', page.groups?.material ?? []],
    ['live', '直播', page.groups?.live ?? []],
    ['other', '其它', page.groups?.other ?? []],
  ];
  for (const [kind, title, items] of sections) {
    if (!items.length) continue;
    wrap.appendChild(lmsCourseSection({ kind, title, items, renderItem: lmsCourseActivityRow }));
  }
  if (!replays.length && !sections.some(([, , items]) => items.length)) {
    wrap.appendChild(emptyBox('这门课在本地缓存里还没有活动，点「刷新本课活动」拉一次。'));
  }
  return wrap;
}

/** 整体重画：所有文本都经 textContent 写入（等价于 escapeHtml），不使用 innerHTML 拼接。 */
function lmsPaint() {
  const mount = lmsUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  lmsUi.refs = { autoSync: null };

  const bar = mk('div', 'toolbar');
  bar.appendChild(mk('div', 'toolbar-title', '账号与同步'));
  bar.appendChild(mk('div', 'spacer'));
  const reload = mk('button', 'ghost-btn', lmsUi.statusLoading ? '刷新中…' : '刷新状态');
  reload.type = 'button';
  reload.disabled = lmsUi.statusLoading;
  reload.addEventListener('click', () => void lmsLoadStatus({ manual: true }));
  bar.appendChild(reload);
  mount.appendChild(bar);

  const content = mk('div', 'view-content');
  mount.appendChild(content);

  const ready = lmsUi.status?.status === 'ready';
  if (lmsUi.page === 'course' && ready) {
    // 课程页：单独一屏，左上角返回首页
    content.appendChild(lmsCourseView());
    lmsMaybeLoadCourse();
    return;
  }
  content.appendChild(lmsStatusCard());
  if (lmsUi.status && !ready) content.appendChild(lmsUi.status.status === 'need_mfa' ? lmsMfaCard() : lmsLoginCard());
  if (ready) content.appendChild(lmsCoursesCard());

  lmsMaybeLoad();
}

/* ------------------------------------------------------------------ 登记到外壳 */

window.PCModules.register({
  id: 'lms',
  label: '思源学堂',
  icon: '🎓',
  order: 30,
  title: lmsView.title,
  render: (ctx) => lmsView.render(ctx),
});
})();
