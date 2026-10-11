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
  status: null,
  statusLoading: false,
  statusError: null,
  courses: null,
  coursesBusy: false,
  coursesError: null,
  activities: null,
  activitiesBusy: false,
  activitiesError: null,
  activityType: '',
  activityCourseId: '',
  /** 学期筛选（空 = 全部学期） */
  semesterFilter: '',
  /**
   * 分组折叠状态。三处各记一份，互不干扰：
   *   semesterToggle       活动卡：学期层（key = 学期键）
   *   groupToggle          活动卡：学期里的课程层（key = 课程键）
   *   courseSemesterToggle 课程卡：学期层
   * 没记录过的走"自适应默认"（见 lmsGroupExpandedIn）；`*All` 是「全部展开/收起」的覆盖。
   */
  semesterToggle: new Map(),
  semestersAll: null,
  groupToggle: new Map(),
  groupsAll: null,
  courseSemesterToggle: new Map(),
  courseSemestersAll: null,
  /** 只记住学号（方便切走再切回来），明文密码不留在内存里。 */
  username: '',
  loginError: null,
  mfaSent: false,
  mfaPhoneMasked: null,
  mfaError: null,
  /** 同步选项：默认值保持后端默认语义（见 lmsSyncBody 的注释）。 */
  options: {
    includePast: false,
    includeSubmitted: false,
    includeLesson: false,
    includeCourseRange: false,
    pruneStale: false,
  },
  preview: null,
  previewBusy: false,
  previewError: null,
  selected: new Set(),
  applyBusy: false,
  applyResult: null,
  applyError: null,
  /** 自动同步设置（POST /lms/settings）的忙碌态与错误。 */
  autoSyncBusy: false,
  autoSyncError: null,
  /** 当前这一次渲染出来的节点，用于不重画的原地更新（勾选 / 计数 / 设置项）。 */
  refs: { syncCount: null, syncButton: null, syncBoxes: [], autoSync: null },
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

/** 同步请求体：界面勾选项 ↔ 后端选项的唯一映射点。 */
function lmsSyncBody(extra) {
  const options = lmsUi.options;
  return {
    // 后端默认只关心作业 + 直播；勾选「导入课程回放」后再把 lesson 加进 types
    types: ['homework', 'lecture_live'].concat(options.includeLesson ? ['lesson'] : []),
    includePast: options.includePast,
    // 后端语义：skipSubmitted=true 表示「已提交的作业不导入」，和界面上的勾选正好相反
    skipSubmitted: !options.includeSubmitted,
    // 后端默认把已提交的作业直接建成「已完成」，保持默认
    markSubmittedDone: true,
    includeCourseRange: options.includeCourseRange,
    pruneStale: options.pruneStale,
    ...extra,
  };
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
  lmsUi.preview = null;
  lmsUi.selected = new Set();
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
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
    lmsUi.preview = null;
    lmsUi.selected = new Set();
    lmsUi.applyResult = null;
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

/* --------------------------------------------------------------- 同步 */

async function lmsPreviewSync() {
  if (lmsUi.previewBusy) return;
  lmsUi.previewBusy = true;
  lmsUi.previewError = null;
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
  lmsPaint();
  try {
    const data = await PC.api('/lms/sync/preview', { method: 'POST', body: lmsSyncBody({}) });
    lmsUi.preview = data;
    // 默认只勾选会真正写库的条目，跳过/失效交给用户自己决定
    lmsUi.selected = new Set(
      (data.items ?? []).filter((item) => item.action === 'create' || item.action === 'update').map((item) => item.key),
    );
  } catch (error) {
    lmsUi.previewError = error.message;
    lmsUi.preview = null;
    lmsUi.selected = new Set();
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.previewBusy = false;
    lmsPaint();
  }
}

async function lmsApplySync() {
  if (lmsUi.applyBusy) return;
  const keys = [...lmsUi.selected];
  if (!keys.length) {
    lmsUi.applyError = '请先勾选要同步的条目';
    lmsPaint();
    return;
  }
  lmsUi.applyBusy = true;
  lmsUi.applyError = null;
  lmsPaint();
  try {
    const result = await PC.api('/lms/sync/apply', { method: 'POST', body: lmsSyncBody({ keys }) });
    lmsUi.applyResult = result;
    lmsUi.preview = null; // 落库后旧的预览已经过期，清掉避免误点
    lmsUi.selected = new Set();
    PC.toast(`同步完成：新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0}`);
    try {
      lmsUi.status = await PC.api('/lms/status'); // 刷新已同步条数 / 上次同步时间
    } catch {
      /* 状态刷新失败不影响同步结果展示 */
    }
  } catch (error) {
    lmsUi.applyError = error.message;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.applyBusy = false;
    lmsPaint();
  }
}

function lmsSelectAll(checked) {
  lmsUi.selected = new Set();
  if (checked) for (const item of lmsUi.preview?.items ?? []) lmsUi.selected.add(item.key);
  for (const { input, key } of lmsUi.refs.syncBoxes) input.checked = lmsUi.selected.has(key);
  lmsUpdateSyncFoot();
}

/** 只原地更新「已选 N 条 / 同步选中 N 条」，避免勾选时重画导致列表滚动位置丢失。 */
function lmsUpdateSyncFoot() {
  const count = lmsUi.selected.size;
  const { syncButton, syncCount } = lmsUi.refs;
  if (syncCount && syncCount.isConnected) syncCount.textContent = `已选 ${count} 条`;
  if (syncButton && syncButton.isConnected) {
    syncButton.textContent = lmsUi.applyBusy ? '同步中…' : `同步选中 ${count} 条`;
    syncButton.disabled = lmsUi.applyBusy || count === 0;
  }
}

/** 后端现在保证每条预览条目都带 kind（skip/stale 的 payload 为 null），这里再留一层兜底。 */
function lmsItemKind(item) {
  if (item.kind === 'event') return '日历事件';
  if (item.kind === 'schedule') return '日程';
  if (item.payload?.startDate !== undefined) return '日历事件';
  if (item.payload?.date) return '日程';
  return null;
}

function lmsItemWhen(item) {
  const payload = item.payload;
  if (payload) {
    if (payload.date) {
      const time = payload.allDay ? '全天' : `${payload.startTime ?? ''}${payload.endTime ? `–${payload.endTime}` : ''}`;
      return `${payload.date} ${time}`.trim();
    }
    if (payload.startDate) {
      const same = !payload.endDate || payload.endDate === payload.startDate;
      return `${payload.startDate}${same ? '' : ` ~ ${payload.endDate}`} 全天`;
    }
  }
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  if (start || end) return [start, end].filter(Boolean).join(' → ');
  return '';
}

function lmsSyncRow(item) {
  const row = mk('label', 'lms-sync-row');
  const box = mk('input');
  box.type = 'checkbox';
  box.checked = lmsUi.selected.has(item.key);
  box.addEventListener('change', () => {
    if (box.checked) lmsUi.selected.add(item.key);
    else lmsUi.selected.delete(item.key);
    lmsUpdateSyncFoot();
  });
  lmsUi.refs.syncBoxes.push({ input: box, key: item.key });

  const main = mk('div', 'lms-sync-main');
  const title = mk('div', 'lms-row-title');
  title.append(
    mk('span', `lms-badge ${item.action ?? ''}`.trim(), LMS_ACTION_LABEL[item.action] ?? item.action ?? '条目'),
    mk('span', null, item.title ?? item.key),
  );
  main.appendChild(title);

  const meta = [
    item.courseName,
    item.typeLabel ?? (item.type ? LMS_ACTIVITY_LABEL[item.type] ?? item.type : null),
    lmsItemKind(item),
    item.submitted ? '已提交' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) main.appendChild(mk('div', 'lms-row-meta', meta));

  const when = lmsItemWhen(item);
  if (when) main.appendChild(mk('div', 'lms-row-meta', when));

  const detail = item.action === 'update' && item.changes?.length ? `变更：${item.changes.join('、')}` : item.reason;
  if (detail) main.appendChild(mk('div', 'lms-row-meta', detail));

  row.append(box, main);
  return row;
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
    render: () => semester.courses.map((course) => lmsCourseRow(course)),
  });
}

function lmsCourseRow(course) {
  const row = mk('div', 'lms-row');
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

  return row;
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
function lmsVisibleActivities() {
  let items = lmsUi.activities?.items ?? [];
  if (lmsUi.activityType) {
    // 「网课」页签命中直播 + 回放两种类型，其余页签精确匹配
    const types = LMS_TYPE_MATCH[lmsUi.activityType] ?? [lmsUi.activityType];
    items = items.filter((item) => types.includes(item.type));
  }
  if (lmsUi.activityCourseId) {
    items = items.filter((item) => String(item.courseId) === String(lmsUi.activityCourseId));
  }
  if (lmsUi.semesterFilter) {
    // 活动本身不带学期，得从课程表查（查不到算「未知学期」，与分组口径一致）
    const index = lmsCourseSemesterIndex();
    items = items.filter((item) => (index.get(String(item.courseId))?.key ?? '__none__') === lmsUi.semesterFilter);
  }
  return items;
}

/** 筛选结果少于这么多条时，分组默认全部展开（小列表没必要再点一次）。 */
const LMS_GROUP_AUTO_EXPAND = 12;

/** 某条活动的排序用时间戳（取结束时间，没结束就用开始时间）。 */
function lmsActivityStamp(item) {
  const raw = String(item?.endTime || item?.startTime || '').trim();
  return raw || '';
}

/**
 * 作业的提交状态是不是"已知"。
 *
 * 活动列表接口**不返回**提交状态（`userSubmitCount`），它是补拉活动详情才有的字段，
 * 而且一次预览最多补拉 40 条。所以"没有这个字段"≠"没提交" —— 是**还没查**。
 * 这里必须分开：把它们混成"未提交"就是在骗用户。
 */
function lmsSubmitKnown(item) {
  return item?.userSubmitCount !== undefined && item?.userSubmitCount !== null;
}

/** 明确未提交（查过了，确实是 0）。 */
function lmsSubmitPending(item) {
  return lmsSubmitKnown(item) && Number(item.userSubmitCount) === 0;
}

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

/** 一组活动的统计：明确未提交数、还没查过的条数、最近时间。 */
function lmsActivityStats(items) {
  let pending = 0;
  let unknown = 0;
  let latest = '';
  for (const item of items) {
    if (item.type === 'homework') {
      if (lmsSubmitPending(item)) pending += 1;
      else if (!lmsSubmitKnown(item)) unknown += 1;
    }
    const stamp = lmsActivityStamp(item);
    if (stamp > latest) latest = stamp;
  }
  return { pending, unknown, latest };
}

/** 一组活动再按课程分一层（组内按"最近有活动"排前面）。 */
function lmsActivityCourseGroups(items) {
  const courses = new Map();
  for (const item of items) {
    const key = item.courseId != null && item.courseId !== '' ? String(item.courseId) : `name:${item.courseName ?? ''}`;
    if (!courses.has(key)) courses.set(key, { key, name: item.courseName || '（未标注课程）', items: [] });
    courses.get(key).items.push(item);
  }
  return [...courses.values()]
    .map((group) => ({ ...group, ...lmsActivityStats(group.items) }))
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name, 'zh'));
}

/**
 * 把当前筛选结果按 **学期 → 课程** 两级分组。
 *
 * 课程缓存里查不到的（比如课程刷新过、活动还是旧的）落到「未知学期」，
 * 不硬塞进某个学期 —— 分组错了比不分组更糟。
 */
function lmsActivitySemesterGroups() {
  const index = lmsCourseSemesterIndex();
  const semesters = new Map();
  for (const item of lmsVisibleActivities()) {
    const found = index.get(String(item.courseId));
    const key = found?.key ?? '__none__';
    if (!semesters.has(key)) {
      semesters.set(key, { key, label: found?.label ?? '未知学期', items: [], rank: '' });
    }
    semesters.get(key).items.push(item);
  }
  const list = [...semesters.values()];
  for (const semester of list) {
    semester.courses = lmsActivityCourseGroups(semester.items);
    Object.assign(semester, lmsActivityStats(semester.items));
    semester.rank = lmsSemesterRank(
      semester.latest,
      semester.courses.map((group) => ({ endDate: group.latest })),
    );
  }
  return list.sort(lmsSemesterSort);
}

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

/** 换页签 / 换过滤 / 整体展开收起时重置折叠状态（别把上一批的折叠继承过来）。 */
function lmsResetGroupState({ keep } = {}) {
  if (keep !== 'semestersAll') lmsUi.semestersAll = null;
  if (keep !== 'groupsAll') lmsUi.groupsAll = null;
  if (keep !== 'courseSemestersAll') lmsUi.courseSemestersAll = null;
  lmsUi.semesterToggle = new Map();
  lmsUi.groupToggle = new Map();
  lmsUi.courseSemesterToggle = new Map();
}

/** 活动卡：一个学期（里面是按课程分的组）。 */
function lmsSemesterSection(semester, isNewest, totalItems) {
  const expanded = lmsGroupExpandedIn(lmsUi.semesterToggle, lmsUi.semestersAll, semester.key, {
    isNewest,
    // 学期层看整批：14 条以上就只展开最新那个学期，先给概览
    smallEnough: totalItems <= LMS_GROUP_AUTO_EXPAND,
  });
  return lmsCollapsibleGroup({
    label: semester.label,
    level: 1,
    tags: lmsGroupTags({
      count: semester.items.length,
      pending: semester.pending,
      unknown: semester.unknown,
      latest: semester.latest,
    }),
    expanded,
    onToggle: (next) => {
      lmsUi.semesterToggle.set(semester.key, next);
      lmsUi.semestersAll = null;
      lmsPaint();
    },
    render: () => semester.courses.map((course) => lmsCourseSection(course, semester)),
  });
}

/** 活动卡：学期里的一个课程组。 */
function lmsCourseSection(group, semester) {
  const expanded = lmsGroupExpandedIn(lmsUi.groupToggle, lmsUi.groupsAll, group.key, {
    smallEnough: semester.items.length <= LMS_GROUP_AUTO_EXPAND,
  });
  return lmsCollapsibleGroup({
    label: group.name,
    level: 2,
    tags: lmsGroupTags({
      count: group.items.length,
      pending: group.pending,
      unknown: group.unknown,
      latest: group.latest,
    }),
    expanded,
    onToggle: (next) => {
      lmsUi.groupToggle.set(group.key, next);
      lmsUi.groupsAll = null;
      lmsPaint();
    },
    // 组内不再重复显示课程名（表头已经写了）
    render: () => group.items.map((item) => lmsActivityRow(item, { showCourse: false })),
  });
}

function lmsActivitiesCard() {
  const card = mk('div', 'card');
  const visible = lmsVisibleActivities();
  const semesters = lmsActivitySemesterGroups();
  const courseCount = new Set(visible.map((item) => String(item.courseId ?? item.courseName))).size;

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '活动'));
  head.appendChild(mk('span', 'lms-hint', `${visible.length} 条 · ${semesters.length} 个学期 · ${courseCount} 门课`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新活动', '刷新中…', lmsUi.activitiesBusy, () => void lmsLoadActivities(true)));
  card.appendChild(head);

  const filters = mk('div', 'lms-filters');
  const seg = mk('div', 'seg');
  for (const [value, label] of LMS_TYPE_TABS) {
    const button = mk('button', `seg-btn${lmsUi.activityType === value ? ' active' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (lmsUi.activityType === value) return;
      lmsUi.activityType = value;
      lmsResetGroupState();
      lmsPaint();
    });
    seg.appendChild(button);
  }
  filters.appendChild(seg);

  // 学期筛选：课程多的时候这是主要的导航方式
  const semesterSelect = mk('select');
  semesterSelect.appendChild(option('', '全部学期', !lmsUi.semesterFilter));
  for (const semester of lmsSemesterOptions()) {
    semesterSelect.appendChild(option(semester.key, semester.label, semester.key === lmsUi.semesterFilter));
  }
  semesterSelect.addEventListener('change', () => {
    lmsUi.semesterFilter = semesterSelect.value;
    // 换了学期，原来选中的课程可能根本不在这个学期里
    lmsUi.activityCourseId = '';
    lmsResetGroupState();
    lmsPaint();
  });
  filters.appendChild(semesterSelect);

  // 只看课程：选项跟着学期筛选走，免得在几十门课里翻
  const courseSelect = mk('select');
  courseSelect.appendChild(option('', '只看课程：全部', !lmsUi.activityCourseId));
  for (const course of lmsUi.courses?.items ?? []) {
    if (lmsUi.semesterFilter && lmsSemesterKey(course.semester) !== lmsUi.semesterFilter) continue;
    courseSelect.appendChild(
      option(String(course.id), course.name ?? String(course.id), String(course.id) === String(lmsUi.activityCourseId)),
    );
  }
  courseSelect.addEventListener('change', () => {
    lmsUi.activityCourseId = courseSelect.value;
    lmsResetGroupState();
    lmsPaint();
  });
  filters.appendChild(courseSelect);

  if (semesters.length > 1) {
    filters.appendChild(
      lmsAllToggleButton({
        expanded: lmsEverythingExpanded(lmsUi.semestersAll, visible.length),
        onClick: () => {
          lmsUi.semestersAll = !lmsEverythingExpanded(lmsUi.semestersAll, visible.length);
          lmsResetGroupState({ keep: 'semestersAll' });
          lmsPaint();
        },
      }),
    );
  }
  card.appendChild(filters);

  if (lmsUi.activitiesError) card.appendChild(mk('div', 'lms-error', `活动加载失败：${lmsUi.activitiesError}`));

  if (lmsUi.activities === null || (lmsUi.activitiesBusy && !(lmsUi.activities?.items ?? []).length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!visible.length) {
    const any = (lmsUi.activities?.items ?? []).length > 0;
    card.appendChild(emptyBox(any ? '当前筛选条件下没有活动。' : '还没有活动缓存，点「刷新活动」拉取。'));
    return card;
  }

  // 传总数进去：学期层用**整批**条数判断"要不要默认全展开"，
  // 课程层才用"这个学期自己的条数"—— 两层判据不同，见 lmsGroupExpandedIn 的注释
  semesters.forEach((semester, index) =>
    card.appendChild(lmsSemesterSection(semester, index === 0, visible.length)),
  );
  if (lmsUi.activities?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.activities.fetchedAt)}`));
  }
  return card;
}

function lmsActivityRow(item, { showCourse = true } = {}) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[item.type] ?? item.type ?? '活动'));
  // 只在"确实查到已提交"时打标；没查到就什么都不说（别把未知标成未提交，也别标成已提交）
  if (lmsSubmitKnown(item) && Number(item.userSubmitCount) > 0) title.appendChild(mk('span', 'tag submitted', '已提交'));
  if (item.published === false) title.appendChild(mk('span', 'tag late', '未发布'));
  row.appendChild(title);

  if (showCourse && item.courseName) row.appendChild(mk('div', 'lms-row-meta', item.courseName));
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(
    mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'),
  );
  return row;
}

function lmsApplyResultBox(result) {
  const box = mk('div', 'lms-result');
  box.appendChild(mk('div', 'lms-row-title', '同步结果'));
  box.appendChild(
    mk(
      'div',
      'lms-row-meta',
      `新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0} · 删除 ${result.removed ?? 0}` +
        ` · 跳过 ${result.skipped ?? 0} · 失败 ${(result.errors ?? []).length}`,
    ),
  );
  if (result.lastSyncAt) box.appendChild(mk('div', 'lms-row-meta', `最近同步：${lmsFormatStamp(result.lastSyncAt)}`));
  for (const error of (result.errors ?? []).slice(0, 10)) {
    const text = `${error.key ?? ''} ${error.message ?? ''}`.trim();
    if (text) box.appendChild(mk('div', 'lms-error', text));
  }
  return box;
}

function lmsSyncCard(ready) {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '同步到日历'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(mk('span', 'lms-hint', '先预览，勾选后再写入'));
  card.appendChild(head);

  const checks = mk('div', 'lms-checks');
  const optionRow = (key, label, hint) => {
    const wrap = mk('label', 'check-field');
    const input = mk('input');
    input.type = 'checkbox';
    input.checked = Boolean(lmsUi.options[key]);
    input.addEventListener('change', () => {
      lmsUi.options[key] = input.checked;
    });
    wrap.append(input, mk('span', null, hint ? `${label}（${hint}）` : label));
    checks.appendChild(wrap);
  };
  optionRow('includePast', '包含过期内容');
  optionRow('includeSubmitted', '包含已提交作业', '默认不导入');
  optionRow('includeLesson', '导入网课回放');
  optionRow('includeCourseRange', '整学期课程做成日历事件', '整段日期内都会显示');
  optionRow('pruneStale', '同步时清理失效记录', '删除学堂已下架的条目');
  card.appendChild(checks);

  const actions = mk('div', 'lms-actions');
  const preview = mk('button', 'primary-btn', lmsUi.previewBusy ? '预览中…' : '预览同步');
  preview.type = 'button';
  preview.disabled = !ready || lmsUi.previewBusy;
  preview.addEventListener('click', () => void lmsPreviewSync());
  actions.appendChild(preview);
  if (!ready) actions.appendChild(mk('span', 'lms-hint', '登录后才能预览与同步'));
  card.appendChild(actions);

  if (lmsUi.previewError) card.appendChild(mk('div', 'lms-error', `预览失败：${lmsUi.previewError}`));

  const summary = lmsUi.preview?.summary;
  if (lmsUi.preview) {
    const sum = mk('div', 'lms-summary');
    for (const [key, label] of [
      ['create', '新建'],
      ['update', '更新'],
      ['skip', '跳过'],
      ['stale', '失效'],
    ]) {
      sum.appendChild(statPill(label, summary?.[key] ?? 0));
    }
    sum.appendChild(mk('span', 'lms-hint', `共 ${summary?.total ?? (lmsUi.preview.items ?? []).length} 条`));
    card.appendChild(sum);

    const list = mk('div', 'lms-sync-list');
    const items = lmsUi.preview.items ?? [];
    if (!items.length) list.appendChild(emptyBox('没有需要同步的条目。'));
    for (const item of items) list.appendChild(lmsSyncRow(item));
    card.appendChild(list);

    const foot = mk('div', 'lms-actions');
    const all = mk('button', 'ghost-btn', '全选');
    all.type = 'button';
    const none = mk('button', 'ghost-btn', '全不选');
    none.type = 'button';
    all.addEventListener('click', () => lmsSelectAll(true));
    none.addEventListener('click', () => lmsSelectAll(false));
    const count = mk('span', 'lms-hint', `已选 ${lmsUi.selected.size} 条`);
    const apply = mk('button', 'primary-btn', lmsUi.applyBusy ? '同步中…' : `同步选中 ${lmsUi.selected.size} 条`);
    apply.type = 'button';
    apply.disabled = lmsUi.applyBusy || lmsUi.selected.size === 0;
    apply.addEventListener('click', () => void lmsApplySync());
    lmsUi.refs.syncCount = count;
    lmsUi.refs.syncButton = apply;
    foot.append(all, none, mk('div', 'spacer'), count, apply);
    card.appendChild(foot);
  }

  if (lmsUi.applyError) card.appendChild(mk('div', 'lms-error', `同步失败：${lmsUi.applyError}`));
  if (lmsUi.applyResult) card.appendChild(lmsApplyResultBox(lmsUi.applyResult));
  return card;
}

/** 整体重画：所有文本都经 textContent 写入（等价于 escapeHtml），不使用 innerHTML 拼接。 */
function lmsPaint() {
  const mount = lmsUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  lmsUi.refs = { syncCount: null, syncButton: null, syncBoxes: [], autoSync: null };

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
  content.appendChild(lmsStatusCard());
  if (lmsUi.status && !ready) content.appendChild(lmsUi.status.status === 'need_mfa' ? lmsMfaCard() : lmsLoginCard());
  if (ready) {
    content.appendChild(lmsCoursesCard());
    content.appendChild(lmsActivitiesCard());
  }
  if (lmsUi.status) content.appendChild(lmsSyncCard(ready));

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
