/**
 * 全局统一身份认证服务：一处登录，各模块自动完成自己的站点认证。
 *
 * 为什么能这样
 * ------------
 * 学校的统一认证底层是 Keycloak，`login.xjtu.edu.cn` 是它的 CAS 门面。学堂（经典 CAS）
 * 与教务（OAuth2）**共用同一个 `TGC` 票据 cookie** —— 这一点由 `scripts/sso-probe.js`
 * 在真机上双向验证过。所以只要**共享一个 Cookie 罐**：登录一次拿到 TGC，
 * 其余站点再访问时会被 CAS 用 TGC 自动换取本站点会话，全程不需要密码。
 *
 * 三个关键设计
 * ------------
 * 1. **共享罐子 + 共享 HTTP，但每个站点一个 `CasAuth`。**
 *    `CasAuth` 是有状态的（postUrl/execution/username/encrypted/safety），两个站点共用一个
 *    会互相覆盖；而 Cookie 必须共享，否则 SSO 无从谈起。
 *
 * 2. **`ensure(siteId)` 是各模块唯一的入口。**
 *    模块不再自己判断登录态，而是问一句「我这个站点能用吗」：
 *    能用就干活，不能用就告诉用户去设置里登录。SSO 生效时它是静默的。
 *
 * 3. **乐观恢复 + 显式失效。**
 *    重启后只要罐子里还有该站点的 cookie 就**先当作可用**（省掉每次启动都验一遍的开销）；
 *    真正的失效会在模块第一次业务请求时暴露，模块调 `invalidate()` 让下一次 `ensure()`
 *    走完整的 `begin()` 验证。这与各模块原有的行为一致
 *    （lms/service.js 的注释：「先乐观地认为已登录，真正的失效会在第一次业务请求时被发现」）。
 *
 * ⚠️ 本文件从 `../lms/` 引入三个**共享基础设施**（cas-auth / http-client / secret-store）。
 * 它们只是恰好放在 lms 目录下 —— academic 模块也一直这么引用。方向上是 auth 依赖它们，
 * 不是依赖 lms 模块（auth 的 order=5，早于 lms=20，不存在服务级依赖）。
 * 将来若要彻底理顺，可把这三个文件移到 `src/shared/`，但那会让本次 diff 变大，故留作后续。
 */

import path from 'node:path';

import { AUTH_STATUS, CasAuth, generateVisitorId } from '../lms/cas-auth.js';
import { CookieJar, HttpClient } from '../lms/http-client.js';
import { JsonFile } from '../lms/secret-store.js';
import { AUTH_ERROR, AuthError, resolveAuthConfig } from './config.js';

/**
 * 旧版各模块自己写的会话文件 —— 由**该模块自己**在切换到本模块时声明认领
 * （`auth.adoptLegacySession('lms-session.json')`）。
 *
 * 为什么必须由模块声明、而不是这里写死一份清单：迁移会**删除**旧文件。
 * 如果 auth 一上线就去删，而那些模块还在读自己的文件（切换是分步进行的），
 * 它们会突然变成"未登录" —— 这在测试里表现为 lms 的会话持久化用例直接挂掉。
 * 谁切换、谁认领，责任清晰，也让每一步提交都能独立通过测试。
 */

export class AuthService {
  constructor({ store, broadcast = () => {}, services = {}, dataDir = '.', options = {}, config } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.dataDir = dataDir;
    this.config = resolveAuthConfig(config ?? options);

    /** ★ 共享的 Cookie 罐：SSO 的全部秘密都在这里。 */
    this.jar = new CookieJar();
    /** ★ 共享的 HTTP 客户端：各模块直接用它发业务请求。 */
    this.http = new HttpClient({
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      jar: this.jar,
    });
    this.visitorId = generateVisitorId();

    /** 会话票据是凭据 → 单独文件 + 0600。只放 cookie 与站点就绪标记，不放密码/PII。 */
    this.sessionFile = new JsonFile(path.join(this.dataDir, 'auth-session.json'));

    /** @type {Map<string, object>} 站点注册表，键 = 模块自己给的 id */
    this.sites = new Map();
    /** @type {Set<Function>} 登录态变化的订阅者（模块用它决定要不要清缓存/重新同步） */
    this.listeners = new Set();
    /** @type {string[]} 需要从旧会话文件迁移过来的文件名（由各模块认领） */
    this.legacySessionFiles = [];

    this.state = {
      status: 'anonymous',
      /** 只存在内存里用于显示，不落盘 */
      username: null,
      mfa: null,
      captchaRequired: false,
      error: null,
      /** 正在等 MFA/验证码的那个站点 */
      pendingSite: null,
    };
    this.restored = false;
  }

  // ================================================================ 站点注册

  /**
   * 注册一个需要认证的站点。各模块在自己的 `createServices` 里调用。
   *
   * 允许逐站点覆盖 `casOrigin` / `timeoutMs` —— 测试里两个 mock 站点是不同的服务，
   * 真实环境两个站点则共用同一个 CAS。
   */
  registerSite({ id, label, loginUrl, casOrigin, userAgent, timeoutMs } = {}) {
    if (!id || !loginUrl) throw new AuthError('registerSite 需要 id 与 loginUrl', { code: AUTH_ERROR.NO_SITE });
    const existing = this.sites.get(id);
    if (existing) return existing;

    const siteConfig = {
      casOrigin: casOrigin ?? this.config.casOrigin,
      userAgent: userAgent ?? this.config.userAgent,
      timeoutMs: timeoutMs ?? this.config.timeoutMs,
    };
    const site = {
      id,
      label: label ?? id,
      loginUrl,
      config: siteConfig,
      casAuth: new CasAuth({ http: this.http, config: siteConfig, visitorId: this.visitorId }),
      ready: false,
      /** 是否只是"根据罐子里的 cookie 乐观认定"（还没被 begin() 验过） */
      optimistic: false,
      reason: null,
      lastOkAt: null,
      /** 同站点的并发 ensure 复用同一个 Promise */
      inflight: null,
    };
    this.sites.set(id, site);
    // 恢复会话在前、注册站点在后是常见顺序（auth 的 restore 跑在各模块 createServices 之后），
    // 所以这里补一次乐观判定，避免"刚恢复完却被当成未登录"。
    if (this.restored) this.#markOptimisticIfPossible(site);
    return site;
  }

  /** 该站点是否已注册。 */
  hasSite(id) {
    return this.sites.has(id);
  }

  /**
   * 认领一个旧版会话文件：下次 `restore()` 时把它的 cookie 并进共享罐，然后**删除**它。
   * 各模块在**切换到本模块的那一次提交里**调用（见文件头说明）。
   */
  adoptLegacySession(fileName) {
    if (typeof fileName !== 'string' || !fileName.trim()) return this;
    if (!this.legacySessionFiles.includes(fileName)) this.legacySessionFiles.push(fileName);
    return this;
  }

  // ================================================================ 状态

  /** 单个站点的对外状态。 */
  siteStatus(id) {
    const site = this.sites.get(id);
    if (!site) return { id, registered: false, ready: false };
    return {
      id: site.id,
      label: site.label,
      registered: true,
      ready: site.ready,
      optimistic: site.optimistic,
      reason: site.reason,
      lastOkAt: site.lastOkAt,
    };
  }

  /** 全局状态（给 `/auth/status` 与设置卡）。 */
  status() {
    const sites = [...this.sites.values()].map((site) => this.siteStatus(site.id));
    const readyCount = sites.filter((site) => site.ready).length;
    return {
      status: this.state.status,
      loggedIn: readyCount > 0,
      username: this.state.username,
      mfa: this.state.mfa,
      captchaRequired: this.state.captchaRequired,
      error: this.state.error,
      siteCount: sites.length,
      readyCount,
      sites,
    };
  }

  /** 各模块的 `status()` 可以嵌进去，省得自己拼。 */
  summaryFor(siteId) {
    const site = this.siteStatus(siteId);
    return {
      ready: site.ready,
      needsLogin: site.registered && !site.ready,
      reason: site.reason,
      lastOkAt: site.lastOkAt,
      global: { status: this.state.status, username: this.state.username },
    };
  }

  // ================================================================ 会话恢复 / 迁移

  /** 进程启动时调用（在各模块 createServices 之后、restore 之前由装配层触发）。 */
  async restore() {
    this.restored = true;
    const saved = await this.sessionFile.read();
    if (saved?.cookies?.length) {
      const savedAt = Date.parse(saved.savedAt ?? '');
      const tooOld = Number.isFinite(savedAt) && Date.now() - savedAt > this.config.sessionMaxAgeMs;
      if (tooOld) {
        await this.sessionFile.remove();
      } else {
        this.#loadCookies(saved.cookies);
        const sites = saved.sites ?? {};
        for (const site of this.sites.values()) {
          if (sites[site.id]?.lastOkAt) site.lastOkAt = sites[site.id].lastOkAt;
          this.#markOptimisticIfPossible(site);
        }
        return this.status();
      }
    }

    // 没有新会话文件：尝试从旧版各模块的会话文件迁移
    const migrated = await this.#migrateLegacySessions();
    if (migrated) return this.status();

    return this.status();
  }

  /**
   * 把各模块认领的旧会话文件里的 cookie 合并进共享罐。
   *
   * 迁移后**删除旧文件**：它们装的是同一批会话票据，留着既是重复的凭据副本、
   * 又会在下次启动时造成"到底该信哪个"的困惑。迁移是单向的。
   */
  async #migrateLegacySessions() {
    if (!this.legacySessionFiles.length) return false;
    const merged = [];
    let found = false;
    for (const name of this.legacySessionFiles) {
      const file = new JsonFile(path.join(this.dataDir, name));
      const saved = await file.read();
      if (!saved?.cookies?.length) continue;
      found = true;
      for (const cookie of saved.cookies) merged.push(cookie);
    }
    if (!found) return false;

    this.#loadCookies(merged);
    for (const site of this.sites.values()) this.#markOptimisticIfPossible(site);
    await this.#persist();
    for (const name of this.legacySessionFiles) {
      await new JsonFile(path.join(this.dataDir, name)).remove();
    }
    console.log(`[auth] 已把旧会话文件迁移为 auth-session.json（合并 ${merged.length} 条 cookie，旧文件已删除）`);
    return true;
  }

  /** 载入 cookie 到共享罐；替换实例后要同步给 http（CasAuth 持有的是 http，不受影响）。 */
  #loadCookies(cookies) {
    this.jar = CookieJar.fromJSON(cookies);
    this.http.jar = this.jar;
  }

  /** 罐子里还有该站点的 cookie 就先当作可用。 */
  #markOptimisticIfPossible(site) {
    if (site.ready) return;
    if (!this.#jarHasCookiesFor(site.loginUrl)) return;
    site.ready = true;
    site.optimistic = true;
    site.reason = null;
    // 同步 CasAuth 自己的标志：它后面的 login() 会先看 hasLogin，
    // 不同步的话会出现"站点 ready 但 CasAuth 认为没登录"的割裂状态。
    site.casAuth.hasLogin = true;
  }

  #jarHasCookiesFor(url) {
    try {
      return this.jar.header(url).length > 0;
    } catch {
      return false;
    }
  }

  // ================================================================ 登录

  /** 选一个站点做密码登录入口：显式指定 > 配置的 primarySite > 第一个注册的。 */
  #pickSite(siteId) {
    if (siteId) {
      const site = this.sites.get(siteId);
      if (!site) throw new AuthError(`站点 ${siteId} 未注册`, { code: AUTH_ERROR.UNKNOWN_SITE, status: 404 });
      return site;
    }
    if (this.config.primarySite) {
      const site = this.sites.get(this.config.primarySite);
      if (site) return site;
    }
    return [...this.sites.values()][0] ?? null;
  }

  #requireSite(siteId) {
    const site = this.#pickSite(siteId);
    if (!site) {
      throw new AuthError('没有任何已注册的站点 —— auth 模块的 order 必须小于需要它的业务模块', {
        code: AUTH_ERROR.NO_SITE,
        status: 500,
      });
    }
    return site;
  }

  /**
   * 登录。
   *
   * @param {object} input
   * @param {string} [input.siteId] 从哪个站点进入（不传则用 primarySite）
   */
  async login({ username, password, captcha, trustAgent = true, siteId } = {}) {
    const site = this.#requireSite(siteId);
    if (!username || !password) {
      throw new AuthError('需要账号与密码', { code: AUTH_ERROR.NEED_CREDENTIALS, status: 400 });
    }
    this.state.error = null;
    try {
      if (!site.casAuth.postUrl && !site.casAuth.hasLogin) {
        const started = await site.casAuth.begin(site.loginUrl);
        if (started === AUTH_STATUS.READY) {
          this.#markReady(site);
          return this.#afterPasswordLogin(site, username);
        }
      }
      const result = await site.casAuth.login({ username, password, captcha, trustAgent });
      return this.#handleAuthResult(site, result, username);
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error.message;
      throw error instanceof AuthError
        ? error
        : new AuthError(`登录失败：${error.message}`, { code: AUTH_ERROR.NETWORK, status: 502 });
    }
  }

  async sendMfaCode() {
    const site = this.#requireSite(this.state.pendingSite);
    const result = await site.casAuth.sendMfaCode();
    this.state.mfa = { ...(this.state.mfa ?? {}), phoneMasked: result.phoneMasked, sent: true };
    return { ...result, sent: true, status: this.status() };
  }

  async verifyMfaCode(code) {
    const site = this.#requireSite(this.state.pendingSite);
    await site.casAuth.verifyMfaCode(code);
    const result = await site.casAuth.login({});
    return this.#handleAuthResult(site, result, this.state.username ?? undefined);
  }

  async captcha() {
    const site = this.#requireSite(this.state.pendingSite);
    return site.casAuth.fetchCaptcha();
  }

  #handleAuthResult(site, result, username) {
    switch (result?.status) {
      case AUTH_STATUS.READY:
        this.#markReady(site);
        return this.#afterPasswordLogin(site, username);
      case AUTH_STATUS.NEED_MFA:
        this.state.status = 'need_mfa';
        this.state.pendingSite = site.id;
        this.state.mfa = { phone: result.phone ?? null, sent: false };
        return { status: this.state.status, mfa: this.state.mfa, site: this.siteStatus(site.id) };
      case AUTH_STATUS.NEED_CAPTCHA:
        this.state.status = 'need_captcha';
        this.state.pendingSite = site.id;
        this.state.captchaRequired = true;
        return { status: this.state.status, captchaRequired: true, site: this.siteStatus(site.id) };
      default:
        this.state.status = 'error';
        this.state.error = result?.message ?? '登录失败';
        return { status: this.state.status, error: this.state.error, site: this.siteStatus(site.id) };
    }
  }

  /**
   * 密码登录成功之后：记住用户名、落盘、广播，并**尽力为其余站点做 SSO**。
   *
   * 「尽力」是刻意的：某个站点连不上不该让已经成功的登录变成失败 ——
   * 它是独立部署时就可能连不通，用户至少有一个站点可用。
   */
  async #afterPasswordLogin(site, username) {
    this.state.status = 'ready';
    this.state.mfa = null;
    this.state.captchaRequired = false;
    this.state.error = null;
    this.state.pendingSite = null;
    if (username) this.state.username = username;

    const others = [];
    for (const candidate of this.sites.values()) {
      if (candidate.id === site.id) continue;
      try {
        const outcome = await this.ensure(candidate.id, { revalidate: true });
        others.push({ id: candidate.id, ok: outcome.ok, reason: outcome.reason ?? null });
      } catch (error) {
        others.push({ id: candidate.id, ok: false, reason: error.message });
      }
    }

    await this.#persist();
    this.#emit({ type: 'login', siteId: site.id });
    return { ...this.status(), sso: others };
  }

  async logout() {
    this.jar.clear();
    for (const site of this.sites.values()) {
      site.casAuth.reset();
      site.ready = false;
      site.optimistic = false;
      site.reason = null;
      site.lastOkAt = null;
      site.inflight = null;
    }
    this.state.status = 'anonymous';
    this.state.username = null;
    this.state.mfa = null;
    this.state.captchaRequired = false;
    this.state.error = null;
    this.state.pendingSite = null;
    await this.sessionFile.remove();
    this.#emit({ type: 'logout' });
    return this.status();
  }

  // ================================================================ ensure —— 各模块的入口

  /**
   * 确保某个站点可用。
   *
   * @param {string} siteId
   * @param {object} [options]
   * @param {boolean} [options.revalidate] 忽略乐观状态，强制走一次完整验证
   * @returns {Promise<{ok:boolean, needsLogin:boolean, reason:string|null, site:object}>}
   */
  async ensure(siteId, { revalidate = false } = {}) {
    const site = this.sites.get(siteId);
    if (!site) {
      return { ok: false, needsLogin: true, reason: `站点 ${siteId} 未注册`, site: this.siteStatus(siteId) };
    }
    // 乐观可用且没被要求复验 → 直接用（省掉每次业务调用前的一次往返）。
    // 判据只用 site.ready 而**不看 casAuth.hasLogin**：后者只在"这个 CasAuth 亲自登录过"
    // 时为真，而重启后的乐观恢复并没有经过它，用它会让缓存永远不命中。
    // 真正的失效由 invalidate() 打回（它同时会 reset CasAuth），语义是自洽的。
    if (site.ready && !revalidate) {
      return { ok: true, needsLogin: false, reason: null, site: this.siteStatus(siteId), cached: true };
    }
    if (site.inflight) return site.inflight;
    site.inflight = this.#verify(site).finally(() => {
      site.inflight = null;
    });
    return site.inflight;
  }

  /** 走一次完整验证：访问站点，看是业务页（SSO 生效）还是登录页（需要密码）。 */
  async #verify(site) {
    let begun;
    try {
      begun = await site.casAuth.begin(site.loginUrl);
    } catch (error) {
      const reason = `访问${site.label}失败：${error.message}`;
      this.#markNeedsLogin(site, reason);
      return { ok: false, needsLogin: true, reason, site: this.siteStatus(site.id) };
    }

    if (begun === AUTH_STATUS.READY) {
      this.#markReady(site);
      return { ok: true, needsLogin: false, reason: null, site: this.siteStatus(site.id) };
    }
    const reason =
      begun === 'login_form'
        ? `${site.label}的登录票据已过期，请重新登录`
        : begun === AUTH_STATUS.NEED_MFA
          ? `${site.label}需要两步验证`
          : `${site.label}认证失败${site.casAuth.alert ? `：${site.casAuth.alert}` : ''}`;
    this.#markNeedsLogin(site, reason);
    return { ok: false, needsLogin: true, reason, site: this.siteStatus(site.id) };
  }

  /**
   * 模块在业务请求发现 401/403 时调用：把该站点打回"待验证"，
   * 下一次 `ensure()` 会走完整验证（SSO 能救回来就静默救回）。
   */
  invalidate(siteId, reason = null) {
    const site = this.sites.get(siteId);
    if (!site) return this.siteStatus(siteId);
    site.ready = false;
    site.optimistic = false;
    site.reason = reason;
    site.casAuth.reset();
    return this.siteStatus(siteId);
  }

  #markReady(site) {
    const first = !site.ready;
    site.ready = true;
    site.optimistic = false;
    site.reason = null;
    site.lastOkAt = new Date().toISOString();
    if (first) this.#emit({ type: 'site-ready', siteId: site.id });
  }

  #markNeedsLogin(site, reason) {
    const wasReady = site.ready;
    site.ready = false;
    site.optimistic = false;
    site.reason = reason;
    if (wasReady) this.#emit({ type: 'site-lost', siteId: site.id, reason });
  }

  // ================================================================ 订阅 / 落盘

  /** 模块订阅登录态变化（例如登出时清掉自己的缓存）。返回取消订阅函数。 */
  onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event, this.status());
      } catch (error) {
        console.warn(`[auth] 订阅者抛错（已忽略）：${error.message}`);
      }
    }
    try {
      this.broadcast({ type: 'data_changed', module: 'auth', reason: event.type });
    } catch {
      /* 广播失败不影响认证本身 */
    }
  }

  async #persist() {
    const sites = {};
    for (const site of this.sites.values()) {
      if (site.lastOkAt) sites[site.id] = { lastOkAt: site.lastOkAt };
    }
    await this.sessionFile.write({
      savedAt: new Date().toISOString(),
      cookies: this.jar.toJSON(),
      sites,
    });
  }

  /** 登录成功/SSO 成功后把最新票据落盘（模块也可在会话被刷新后主动调）。 */
  async persist() {
    await this.#persist();
    return this.status();
  }
}
