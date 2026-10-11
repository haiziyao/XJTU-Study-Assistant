/**
 * 西安交通大学统一身份认证（login.xjtu.edu.cn，2025-07 之后的新认证系统）。
 *
 * 流程（与官方网页一致，按状态机拆开，方便前端一步步引导用户）：
 *   1. GET 业务站点 -> 302 到 /cas/login?service=... ，页面里带 execution 隐藏域；
 *   2. GET /cas/jwt/publicKey 拿 RSA 公钥，密码用 RSA/PKCS1v1.5 加密后加 `__RSA__` 前缀；
 *   3. POST /cas/mfa/detect 探测是否需要两步验证（返回 state / need）；
 *   4. POST 登录表单（携带 execution / fpVisitorId / mfaState ...）；
 *   5. 如果服务端要求二次认证，则走安全手机验证码：initByType -> send -> valid，然后回到第 4 步；
 *   6. 登录失败 3 次后服务端要求图形验证码 /cas/captcha.jpg。
 *
 * 注意：本文件只负责认证，不认识任何业务接口；业务在 api.js。
 */

import { createHash, constants as cryptoConstants, publicEncrypt } from 'node:crypto';
import os from 'node:os';

import { HttpError } from './http-client.js';

export const AUTH_STATUS = Object.freeze({
  READY: 'ready',
  NEED_MFA: 'need_mfa',
  NEED_CAPTCHA: 'need_captcha',
  NEED_ACCOUNT_CHOICE: 'need_account_choice',
  FAIL: 'fail',
});

/** 连续失败几次后服务端会要求图形验证码（与官方前端行为一致）。 */
const CAPTCHA_THRESHOLD = 3;

/** 从 HTML 中取隐藏域的值，属性顺序两种写法都兼容。 */
export function inputValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<input[^>]*name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i'),
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*name=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function extractExecution(html) {
  return inputValue(html, 'execution');
}

/** 页面里的 globalConfig.mfaEnabled，拿不到时按「需要」处理（保守）。 */
export function extractMfaEnabled(html) {
  const match = html.match(/["']?mfaEnabled["']?\s*:\s*(true|false|["']true["']|["']false["'])/i);
  if (!match) return true;
  return /true/i.test(match[1]);
}

/** 是否为二次认证（Safety Verify）页面。 */
export function isSafetyVerifyPage(html) {
  if (!html) return false;
  const hasSecState = inputValue(html, 'secState') !== null;
  const hasExecution = extractExecution(html) !== null;
  const hasEvent = inputValue(html, '_eventId') !== null;
  if (!(hasSecState && hasExecution && hasEvent)) return false;
  return (
    /Safety\s*Verify/i.test(html) ||
    /\\?\/cas\\?\/sec\\?\/initByType/.test(html) ||
    html.includes('选择安全认证') ||
    html.includes('二次认证')
  );
}

/** 页面里的错误提示（el-alert 或传统 #msg 容器）。 */
export function extractAlert(html) {
  if (!html) return null;
  const alertTag = html.match(/<el-alert[^>]*>/i);
  if (alertTag) {
    const title = alertTag[0].match(/title=["']([^"']+)["']/i);
    if (title) return title[1].trim();
  }
  const msg = html.match(/<div[^>]*id=["']msg["'][^>]*>([\s\S]*?)<\/div>/i);
  if (msg) {
    const text = msg[1].replace(/<[^>]+>/g, '').trim();
    if (text) return text;
  }
  return null;
}

/** 手机号脱敏展示：138****8888。 */
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 7) return phone ?? null;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * 生成类似 FingerprintJS 的稳定设备标识（32 位十六进制）。
 * 只上传哈希，不上传任何原始系统信息。
 */
export function generateVisitorId() {
  let cpu = '';
  try {
    cpu = os.cpus()?.[0]?.model ?? '';
  } catch {
    cpu = '';
  }
  const facts = [os.platform(), os.arch(), os.hostname(), cpu, os.release()].join('|');
  return createHash('sha256').update(facts).digest('hex').slice(0, 32);
}

export class CasAuth {
  /**
   * @param {object} options
   * @param {import('./http-client.js').HttpClient} options.http
   * @param {object} options.config 见 config.js
   * @param {string} [options.visitorId] 设备标识（测试时可固定）
   */
  constructor({ http, config, visitorId = generateVisitorId() }) {
    this.http = http;
    this.config = config;
    this.visitorId = visitorId;
    this.reset();
  }

  reset() {
    this.postUrl = null;
    this.execution = null;
    this.mfaEnabled = true;
    this.failCount = 0;
    this.username = null;
    this.encrypted = null;
    this.captcha = '';
    this.hasLogin = false;
    this.alreadyAuthenticated = false;
    this.alert = null;
    this.rsaPublicKey = null;
    this.mfa = null;
    this.safety = null;
    this.lastUrl = null;
  }

  get casOrigin() {
    return this.config.casOrigin;
  }

  /** 打开业务站点，读取登录页上下文。返回 AUTH_STATUS 之一。 */
  async begin(loginUrl = this.config.baseUrl) {
    const response = await this.http.get(loginUrl, { follow: true, headers: { Accept: 'text/html,application/xhtml+xml' } });
    this.lastUrl = response.url;
    this.execution = extractExecution(response.text);
    this.mfaEnabled = extractMfaEnabled(response.text);
    this.postUrl = response.url;
    this.alert = extractAlert(response.text);

    // 已经登录过（Cookie 还有效）：目标站点直接返回业务页面
    if (!this.execution && !isSafetyVerifyPage(response.text) && !response.url.includes('/cas/login')) {
      this.alreadyAuthenticated = true;
      return AUTH_STATUS.READY;
    }
    if (isSafetyVerifyPage(response.text)) {
      this.#enterSafetyVerify(response);
      return AUTH_STATUS.NEED_MFA;
    }
    if (this.execution) return 'login_form';
    return AUTH_STATUS.FAIL;
  }

  /** 是否需要图形验证码。 */
  get captchaRequired() {
    return this.failCount >= CAPTCHA_THRESHOLD;
  }

  /**
   * 登录状态机的驱动器：首次传账号密码，之后（MFA 验证完）无参调用继续流程。
   * @returns {Promise<{status:string, message?:string, mfa?:object}>}
   */
  async login({ username, password, captcha, trustAgent = true } = {}) {
    if (this.hasLogin) {
      return { status: AUTH_STATUS.READY, message: '已经登录' };
    }
    if (this.alreadyAuthenticated) {
      this.hasLogin = true;
      return { status: AUTH_STATUS.READY };
    }
    // 二次认证页面已经返回，先完成安全手机验证再提交隐藏表单
    if (this.safety) {
      if (!this.safety.verified) return this.#mfaResult();
      return this.#finishSafetyVerify();
    }
    if (!this.postUrl) {
      const started = await this.begin();
      if (started === AUTH_STATUS.READY) {
        this.hasLogin = true;
        return { status: AUTH_STATUS.READY };
      }
      if (!this.postUrl) {
        throw new HttpError('无法打开统一身份认证登录页（网络异常或学校服务不可用）', { url: this.config.casOrigin });
      }
    }

    if (username || password) {
      if (!username || !password) {
        return { status: AUTH_STATUS.FAIL, message: '账号和密码必须同时提供' };
      }
      this.username = username;
      this.encrypted = await this.encryptPassword(password);
      this.captcha = captcha ?? '';
    } else if (!this.username || !this.encrypted) {
      return { status: AUTH_STATUS.FAIL, message: '首次登录必须提供账号和密码' };
    }
    if (captcha) this.captcha = captcha;

    if (this.captchaRequired && !this.captcha) {
      return { status: AUTH_STATUS.NEED_CAPTCHA, message: '登录失败次数较多，请输入图形验证码' };
    }

    // 每次都要重新探测两步验证：上次 need=false 只代表上一次的密码是错的
    if (this.mfaEnabled && !this.hasLogin && !(this.mfa && this.mfa.required)) {
      const detect = await this.#detectMfa();
      if (detect) return detect;
    }

    const form = {
      username: this.username,
      password: this.encrypted,
      execution: this.execution ?? '',
      _eventId: 'submit',
      submit1: 'Login1',
      fpVisitorId: this.visitorId,
      captcha: this.captcha,
      currentMenu: '1',
      failN: String(this.failCount),
      mfaState: this.mfa?.state ?? '',
      geolocation: '',
      trustAgent: this.mfa?.required ? (trustAgent ? 'true' : 'false') : '',
    };

    const response = await this.http.postForm(this.postUrl, form, {
      follow: true,
      headers: { Referer: this.postUrl, Origin: this.casOrigin },
    });
    return this.#processLoginResponse(response);
  }

  /** 发送安全手机验证码，返回脱敏手机号。 */
  async sendMfaCode() {
    if (!this.mfa) throw new HttpError('当前不需要两步验证');
    const phone = await this.#initSecurePhone();
    const response = await this.http.postJson(
      `${this.casOrigin}/attest/api/guard/securephone/send`,
      { gid: this.mfa.gid },
      { headers: { Referer: this.postUrl ?? this.casOrigin, Origin: this.casOrigin } },
    );
    const data = this.#parseJson(response, '发送验证码');
    if (data.code !== 0) throw new HttpError(`发送验证码失败：${data.message ?? data.code}`);
    return { phone, phoneMasked: maskPhone(phone) };
  }

  /** 校验短信验证码；成功后调用 login() 继续登录流程。 */
  async verifyMfaCode(code) {
    if (!this.mfa?.gid) throw new HttpError('请先发送验证码');
    if (!code) throw new HttpError('验证码不能为空');
    const response = await this.http.postJson(
      `${this.casOrigin}/attest/api/guard/securephone/valid`,
      { gid: this.mfa.gid, code: String(code) },
      { headers: { Referer: this.postUrl ?? this.casOrigin, Origin: this.casOrigin } },
    );
    const data = this.#parseJson(response, '校验验证码');
    if (data.code !== 0) throw new HttpError(data.message ?? '验证码不正确');
    const status = data?.data?.status;
    if (status !== undefined && status !== null && status !== 2 && status !== '2') {
      throw new HttpError(data.message ?? '验证码不正确');
    }
    this.mfa.verified = true;
    if (this.safety) this.safety.verified = true;
    return { ok: true };
  }

  /** 获取图形验证码图片（PNG/JPEG 二进制）。 */
  async fetchCaptcha() {
    const response = await this.http.get(`${this.casOrigin}/cas/captcha.jpg`, {
      headers: { Referer: this.postUrl ?? this.casOrigin, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    });
    return { bytes: response.bytes, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
  }

  /** 用服务端公钥加密密码，返回 `__RSA__<base64>`。 */
  async encryptPassword(password) {
    if (!this.rsaPublicKey) {
      const response = await this.http.get(`${this.casOrigin}/cas/jwt/publicKey`, {
        headers: { Referer: this.postUrl ?? this.casOrigin, Accept: 'text/plain,*/*' },
      });
      this.rsaPublicKey = response.text.trim();
      if (!this.rsaPublicKey.includes('BEGIN')) {
        throw new HttpError('获取 RSA 公钥失败（返回内容不是 PEM）', { url: `${this.casOrigin}/cas/jwt/publicKey` });
      }
    }
    const encrypted = publicEncrypt(
      { key: this.rsaPublicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(password, 'utf8'),
    );
    return `__RSA__${encrypted.toString('base64')}`;
  }

  async #detectMfa() {
    // 注意编码：这个接口只认表单（实测传 JSON 会 400 缺参数），
    // 而下面 attest 系列接口相反，只认 JSON（传表单会 415）。
    const response = await this.http.postForm(
      `${this.casOrigin}/cas/mfa/detect`,
      {
        username: this.username,
        password: this.encrypted,
        fpVisitorId: this.visitorId,
        loginType: 'passwordLogin',
      },
      { headers: { Referer: this.postUrl, Origin: this.casOrigin } },
    );
    const data = this.#parseJson(response, '两步验证探测');
    const state = data?.data?.state;
    const need = Boolean(data?.data?.need);
    if (!state) {
      throw new HttpError(`两步验证探测失败：服务端返回 ${JSON.stringify(data).slice(0, 200)}`);
    }
    this.mfa = { flow: 'mfa', state, required: need, gid: null, phone: null, verified: false };
    if (need) return this.#mfaResult();
    return null;
  }

  #mfaResult() {
    return {
      status: AUTH_STATUS.NEED_MFA,
      mfa: {
        flow: this.mfa?.flow ?? 'mfa',
        required: true,
        phoneMasked: this.mfa?.phone ? maskPhone(this.mfa.phone) : null,
        sent: Boolean(this.mfa?.phone),
      },
      message: '需要两步验证，请获取并输入短信验证码',
    };
  }

  async #initSecurePhone() {
    const flow = this.mfa?.flow ?? 'mfa';
    const response = await this.http.get(
      `${this.casOrigin}/cas/${flow}/initByType/securephone?state=${encodeURIComponent(this.mfa.state ?? '')}`,
      { headers: { Referer: this.postUrl ?? this.casOrigin, Accept: 'application/json, text/plain, */*' } },
    );
    const data = this.#parseJson(response, '获取绑定手机');
    if (data.code !== 0) throw new HttpError(data.message ?? '获取绑定手机号失败');
    this.mfa.gid = data?.data?.gid ?? null;
    this.mfa.phone = data?.data?.securePhone ?? null;
    if (!this.mfa.gid) throw new HttpError('服务端没有返回 gid，无法发送验证码');
    return this.mfa.phone;
  }

  #enterSafetyVerify(response) {
    const secState = inputValue(response.text, 'secState');
    if (!secState) throw new HttpError('二次认证页面缺少 secState 字段');
    this.safety = {
      url: response.url,
      secState,
      execution: extractExecution(response.text),
      eventId: inputValue(response.text, '_eventId') ?? 'submit',
      submit: inputValue(response.text, 'submit') ?? 'Login1',
      verified: false,
    };
    this.failCount = 0;
    // 二次认证也用安全手机验证码，只是接口前缀不同
    this.mfa = { flow: 'sec', state: secState, required: true, gid: null, phone: null, verified: false };
  }

  async #finishSafetyVerify() {
    const safety = this.safety;
    const response = await this.http.postForm(
      safety.url,
      {
        secState: safety.secState,
        execution: safety.execution ?? '',
        _eventId: safety.eventId,
        geolocation: '',
        fpVisitorId: this.visitorId,
        submit: safety.submit,
      },
      { follow: true, headers: { Referer: safety.url, Origin: this.casOrigin } },
    );
    this.safety = null;
    return this.#processLoginResponse(response);
  }

  #processLoginResponse(response) {
    if (response.status === 401) {
      this.failCount += 1;
      return { status: AUTH_STATUS.FAIL, message: '登录失败：用户名或密码错误', needCaptcha: this.captchaRequired };
    }
    if (response.status >= 400) {
      throw new HttpError(`登录请求返回 HTTP ${response.status}`, { status: response.status, url: response.url });
    }
    const alert = extractAlert(response.text);
    if (alert) {
      this.failCount += 1;
      this.alert = alert;
      return { status: AUTH_STATUS.FAIL, message: `登录失败：${alert}`, needCaptcha: this.captchaRequired };
    }
    if (isSafetyVerifyPage(response.text)) {
      this.#enterSafetyVerify(response);
      return this.#mfaResult();
    }
    // 还停在登录页且带 execution：属于「没报错但也没登进去」，最常见的是会话/参数问题
    if (response.url.includes('/cas/login') && extractExecution(response.text)) {
      this.failCount += 1;
      return { status: AUTH_STATUS.FAIL, message: '登录未完成，请检查账号、密码或稍后重试', needCaptcha: this.captchaRequired };
    }
    this.failCount = 0;
    this.hasLogin = true;
    return { status: AUTH_STATUS.READY };
  }

  #parseJson(response, action) {
    try {
      return JSON.parse(response.text);
    } catch {
      throw new HttpError(`${action}时服务端返回了无法解析的内容`, { status: response.status, url: response.url, body: response.text.slice(0, 200) });
    }
  }
}
