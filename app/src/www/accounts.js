/**
 * 服务端版（公开网页）的**账号库**：用户、会话、邀请码。
 *
 * 为什么在宿主层自己写一份，而不是复用 `src/modules/auth/**`：
 *   那个模块是「学校统一身份认证（Keycloak/CAS）的客户端」——它**不持有**用户密码，
 *   只保存学校发的票据；而服务端版要的是「这台服务器自己的账号」：密码哈希、会话令牌、
 *   邀请码，语义完全不同。两者共存（`/auth/**` 是宿主自己的账号接口，`/api/v1/auth/**`
 *   是校内统一认证），互不干扰。
 *
 * 口径照 `dschat 2/app/auth.py`（已上线验证过的一套），只换语言不换参数：
 *   - PBKDF2-SHA256、12 万次迭代、每用户独立 salt（16 字节）；
 *   - 会话令牌 32 字节随机（64 位 hex），30 天有效；
 *   - 邀请码形如 `K7Q3-M9XW`，字符集去掉 0/O/1/I 这些看着像的；
 *   - 密码校验用恒定时间比较（`crypto.timingSafeEqual`）。
 *
 * 为什么迭代次数是 12 万而不是更高：这是一个学习助理，登录延迟要能忍（约 100ms 量级），
 * 而 12 万次在该量级下对离线爆破已经有足够成本；真要更强，用户该做的是别复用密码。
 *
 * 数据落在 `data-www/` 三个文件里（0600），**绝不存明文密码**：
 *   users.json    `{items:[{id, username, passwordHash, salt, role, createdAt}]}`
 *   invites.json  `{items:[{id, code, role, createdAt, createdBy, usedBy, usedAt}]}`
 *   sessions.json `{items:[{token, userId, createdAt, expiresAt, lastSeenAt, ua, ip}]}`
 *
 * 为什么 `sessions.json` 里存的是**令牌原文**而不是哈希：会话表本来就是"谁在线"的账本，
 * 文件权限已经是 0600、和密码哈希同处一个目录，拿到它的攻击者本来就已经拿到了整个数据目录；
 * 存哈希只会让"按令牌查会话"退化成"逐个哈希比对"，换不来实际安全增益。
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HttpError } from '../core/http/router.js';

/* ---------------------------------------------------------------- 常量（口径唯一出处） */

/** PBKDF2 迭代次数（与 dschat 一致）。 */
export const PBKDF2_ITERATIONS = 120_000;
/** 派生密钥长度（字节）；SHA-256 输出 32 字节。 */
const KEY_BYTES = 32;
/** 每用户 salt 长度（字节）。 */
const SALT_BYTES = 16;
/** 会话有效期：30 天。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 会话令牌长度：32 字节（hex 编码后 64 个字符）。 */
const TOKEN_BYTES = 32;
/** 用户 id 长度：16 字节（hex）。 */
const USER_ID_BYTES = 16;
/** 邀请码字符集：去掉 0/O/1/I/L 等易混字符。 */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 登录失败容忍次数与锁定时长（与传输模块的配对码口径一致：错 5 次锁 60 秒）。 */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 60 * 1000;
/** 用户名允许的形状：3–32 位，字母/数字/下划线/短横线/点。 */
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
/** 密码最短长度。 */
export const PASSWORD_MIN_LENGTH = 8;

/** 登录失败计数表的清理间隔：过期的锁定记录不清理就是一条缓慢增长的内存泄漏。 */
const ATTEMPT_SWEEP_MS = 10 * 60 * 1000;

/* ---------------------------------------------------------------- 纯函数（可单测） */

/** 生成一个 hex 随机串。 */
const hex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * PBKDF2-SHA256 派生。
 *
 * 用 `pbkdf2Sync` 而不是异步版：登录/注册都是**低频**动作，一次 100ms 量级的同步计算
 * 换来的是"不存在并发写 salt 的窗口"，比异步更不容易写错；它也仍然远低于一次
 * 学校接口请求的耗时。
 */
export function hashPassword(password, saltHex) {
  const salt = saltHex ?? hex(SALT_BYTES);
  return { salt, hash: pbkdf2(password, salt) };
}

/** 单独拆出来便于"未知用户也走一次等价开销"（见 AccountStore#login）。 */
function pbkdf2(password, saltHex) {
  return pbkdf2Sync(
    Buffer.from(String(password ?? ''), 'utf8'),
    Buffer.from(String(saltHex), 'hex'),
    PBKDF2_ITERATIONS,
    KEY_BYTES,
    'sha256',
  ).toString('hex');
}

/**
 * 恒定时间比较两个字符串。
 *
 * 长度不同直接 `false`：长度不是秘密（令牌/哈希长度都是固定的公开常量），
 * 而 `timingSafeEqual` 对不等长入参会**抛异常**，所以必须先挡一道。
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 校验密码是否匹配（恒定时间比较）。 */
export function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  try {
    return safeEqual(pbkdf2(password, saltHex), hashHex);
  } catch {
    return false;
  }
}

/** 新会话令牌：32 字节随机（hex）。 */
export const newSessionToken = () => hex(TOKEN_BYTES);
/** 新用户 id：16 字节随机（hex）。 */
export const newUserId = () => hex(USER_ID_BYTES);

/** 新邀请码：`K7Q3-M9XW`（两段 4 位，字符集已去掉易混字符）。 */
export function newInviteCode() {
  const pick = () => INVITE_ALPHABET[randomBytes(1)[0] % INVITE_ALPHABET.length];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}`;
}

/** 邀请码归一化：用户可能小写输入或漏了短横线，统一成"大写 + 保留短横线"。 */
export const normalizeInviteCode = (code) => String(code ?? '').trim().toUpperCase();

/** 用户名归一化：去空白；大小写**不**折叠（保留用户输入的显示形式，查重另做）。 */
export const normalizeUsername = (username) => String(username ?? '').trim();

/** 对外暴露的用户对象：**绝不**带 salt / passwordHash。 */
export const publicUser = (user) =>
  user ? { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } : null;

/* ---------------------------------------------------------------- 账号库 */

export class AccountStore {
  /**
   * @param {object} options
   * @param {string} options.dir        账号库目录（`data-www`）
   * @param {object} [options.logger]
   * @param {() => number} [options.now] 注入时钟（测试用）
   */
  constructor({ dir, logger = console, now = Date.now } = {}) {
    this.dir = path.resolve(dir);
    this.logger = logger;
    this.now = now;

    /** @type {Map<string, object>} userId -> user */
    this.users = new Map();
    /** @type {Map<string, object>} inviteId -> invite */
    this.invites = new Map();
    /** @type {Map<string, object>} token -> session */
    this.sessions = new Map();
    /** @type {Map<string, {fails:number, lockedUntil:number, lastFailAt:number}>} `${ip}|${username}` */
    this.attempts = new Map();

    this.#dirty = { sessions: false };
    this.#flushTimer = null;
    this.#sweepTimer = null;
  }

  #dirty;
  #flushTimer;
  #sweepTimer;

  file(name) {
    return path.join(this.dir, name);
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const [users, invites, sessions] = await Promise.all([
      this.#load('users.json'),
      this.#load('invites.json'),
      this.#load('sessions.json'),
    ]);
    for (const user of users) this.users.set(user.id, user);
    for (const invite of invites) this.invites.set(invite.id, invite);
    const now = this.now();
    let expired = 0;
    for (const session of sessions) {
      // 过期的会话在启动时就丢掉：一个"永远在线的幽灵会话"比一个明确的 401 难查得多
      if (!session?.token || !session?.userId) continue;
      if (Number(session.expiresAt) <= now) {
        expired += 1;
        continue;
      }
      this.sessions.set(session.token, session);
    }
    if (expired) this.#dirty.sessions = true;
    this.#sweepTimer = setInterval(() => this.#sweepAttempts(), ATTEMPT_SWEEP_MS);
    this.#sweepTimer.unref?.();
    this.#scheduleFlush();
    return this;
  }

  async #load(name) {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed?.items ?? [];
      return items.filter((item) => item && typeof item === 'object');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      // 损坏的账号库**不能**静默重建：那等于把所有人的账号抹掉。备份原件后以空库启动，
      // 让用户至少还能从备份里人工恢复（与 core/store/json-store.js 同一套取舍）。
      const backup = `${this.file(name)}.corrupt-${this.now()}`;
      await fs.rename(this.file(name), backup).catch(() => {});
      this.logger?.error?.(`[www] ${name} 解析失败（${error.message}），已备份到 ${backup}`);
      return [];
    }
  }

  /** 原子写：先写临时文件再 rename，进程被杀不会留下半截 JSON。权限 0600。 */
  async #persist(name, items) {
    const target = this.file(name);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, target);
  }

  /**
   * 会话的 `lastSeenAt` 每次请求都在变，**不能**每次请求都落盘：
   * 前端一次打开页面就是几十个请求，那样磁盘会被没意义地写爆。
   * 于是内存里先改，攒 1 秒再写一次（写失败也不影响当前会话的判定 —— 内存是权威）。
   */
  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush().catch((error) => this.logger?.error?.(`[www] 会话落盘失败：${error.message}`));
    }, 1000);
    this.#flushTimer.unref?.();
  }

  async flush() {
    if (!this.#dirty.sessions) return;
    this.#dirty.sessions = false;
    await this.#persist('sessions.json', [...this.sessions.values()]);
  }

  async close() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#flushTimer = null;
    this.#sweepTimer = null;
    await this.flush().catch(() => {});
  }

  /* -------------------------------------------------------------- 用户与注册 */

  userCount() {
    return this.users.size;
  }

  /** 按用户名找（不区分大小写；对用户更友好，也避免"Alice / alice"两个孪生账号）。 */
  #findByUsername(username) {
    const wanted = normalizeUsername(username).toLowerCase();
    for (const user of this.users.values()) if (user.username.toLowerCase() === wanted) return user;
    return null;
  }

  getUser(id) {
    return this.users.get(id) ?? null;
  }

  /**
   * 注册。
   *
   * **第一个注册的用户自动成为管理员**，为什么：
   *   这是个"自己部署给自己和朋友用"的程序，没有任何带外的账号创建通道（没有命令行、
   *   没有配置文件、也没有第二个管理员可以批准）。如果不让第一个注册者当管理员，
   *   一台新部署的服务器会**永远发不出邀请码**，等于谁也进不来。
   *   此后所有注册都必须持邀请码，"第一个"这个窗口只在空库时存在一次。
   *
   * @returns {Promise<{user: object, token: string}>}
   */
  async register({ username, password, inviteCode, ip = null, ua = null } = {}) {
    const name = normalizeUsername(username);
    if (!name) throw HttpError.badRequest('用户名不能为空');
    if (!USERNAME_PATTERN.test(name)) {
      throw HttpError.badRequest('用户名需为 3–32 位，只能用字母、数字、下划线、短横线或点');
    }
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
      throw HttpError.badRequest(`密码至少 ${PASSWORD_MIN_LENGTH} 位`);
    }
    if (this.#findByUsername(name)) {
      throw new HttpError(409, 'USER_EXISTS', `用户名「${name}」已被占用`);
    }

    const first = this.users.size === 0;
    let invite = null;
    if (!first) {
      invite = this.#claimInvite(inviteCode);
    }

    const { salt, hash } = hashPassword(password);
    const user = {
      id: newUserId(),
      username: name,
      passwordHash: hash,
      salt,
      role: first ? 'admin' : 'user',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.users.set(user.id, user);
    if (invite) {
      invite.usedBy = user.id;
      invite.usedAt = new Date(this.now()).toISOString();
    }
    await this.#persist('users.json', [...this.users.values()]);
    if (invite) await this.#persist('invites.json', [...this.invites.values()]);

    const session = await this.#issueSession(user, { ip, ua });
    this.logger?.log?.(`[www] 新用户 ${user.username}（${user.role}）注册成功${first ? '：空库的第一位注册者即管理员' : ''}`);
    return { user: publicUser(user), token: session.token };
  }

  /** 认领一个邀请码：不存在 / 已用掉都算「无效」。 */
  #claimInvite(rawCode) {
    const code = normalizeInviteCode(rawCode);
    if (!code) throw new HttpError(403, 'INVITE_INVALID', '需要邀请码：本服务不开放自由注册，请向管理员索取');
    for (const invite of this.invites.values()) {
      if (invite.code !== code) continue;
      if (invite.usedBy) throw new HttpError(403, 'INVITE_INVALID', '这个邀请码已经被使用过了（邀请码是一次性的）');
      return invite;
    }
    throw new HttpError(403, 'INVITE_INVALID', '邀请码无效');
  }

  /* -------------------------------------------------------------- 登录与限速 */

  #attemptKey(ip, username) {
    return `${ip ?? '-'}|${normalizeUsername(username).toLowerCase()}`;
  }

  #sweepAttempts() {
    const now = this.now();
    for (const [key, entry] of this.attempts) {
      // 锁定已过 + 最后一次失败也已过窗口 → 整条丢掉（记分是要"最近连续失败"，不是终身累计）
      if (entry.lockedUntil <= now && now - entry.lastFailAt > LOGIN_LOCKOUT_MS) this.attempts.delete(key);
    }
  }

  /**
   * 登录。
   *
   * 限速口径：**同一个 IP + 同一个用户名**连续错 5 次 → 锁 60 秒（第 5 次就返回 429）。
   * 为什么要限速、又为什么按"IP+用户名"分桶：
   *   - 不限速的话，一个公网端口上的登录接口就是一台免费的密码猜测机；
   *   - 只按 IP 分桶会误伤（同一间宿舍/NAT 出口的人互相拖累），只按用户名分桶则等于
   *     给攻击者一个"锁死别人账号"的按钮；两者一起当键，是这两者之间最不坏的选择。
   */
  async login({ username, password, ip = null, ua = null } = {}) {
    const name = normalizeUsername(username);
    if (!name || typeof password !== 'string' || !password) {
      throw HttpError.badRequest('用户名和密码都不能为空');
    }
    const key = this.#attemptKey(ip, name);
    const now = this.now();
    const entry = this.attempts.get(key);
    if (entry && entry.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
      throw new HttpError(429, 'RATE_LIMITED', `密码连续错误 ${LOGIN_MAX_ATTEMPTS} 次，已锁定 ${retryAfterSeconds} 秒`, {
        locked: true,
        retryAfterSeconds,
      });
    }

    const user = this.#findByUsername(name);
    // 用户不存在时也走一次等价的 PBKDF2：否则"响应快 = 用户不存在"就是一个账号枚举口子
    const ok = user
      ? verifyPassword(password, user.salt, user.passwordHash)
      : (verifyPassword(password, '00'.repeat(SALT_BYTES), '00'.repeat(KEY_BYTES)), false);

    if (!ok) {
      const fails = (entry?.fails ?? 0) + 1;
      const locked = fails >= LOGIN_MAX_ATTEMPTS;
      this.attempts.set(key, {
        fails: locked ? 0 : fails,
        lockedUntil: locked ? now + LOGIN_LOCKOUT_MS : 0,
        lastFailAt: now,
      });
      // 日志里**只**留用户名与来源 IP，密码一个字都不记（也不做长度/前缀提示）
      this.logger?.warn?.(`[www] 登录失败：${name} @ ${ip ?? '-'}${locked ? `（连续 ${LOGIN_MAX_ATTEMPTS} 次，锁定 ${LOGIN_LOCKOUT_MS / 1000} 秒）` : ''}`);
      if (locked) {
        throw new HttpError(429, 'RATE_LIMITED', `密码连续错误 ${LOGIN_MAX_ATTEMPTS} 次，已锁定 ${LOGIN_LOCKOUT_MS / 1000} 秒`, {
          locked: true,
          retryAfterSeconds: LOGIN_LOCKOUT_MS / 1000,
        });
      }
      throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或密码不对');
    }

    this.attempts.delete(key);
    const session = await this.#issueSession(user, { ip, ua });
    return { user: publicUser(user), token: session.token };
  }

  async #issueSession(user, { ip = null, ua = null } = {}) {
    const now = this.now();
    const session = {
      token: newSessionToken(),
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: new Date(now).toISOString(),
      ua: ua ? String(ua).slice(0, 120) : null,
      ip: ip ?? null,
    };
    this.sessions.set(session.token, session);
    this.#dirty.sessions = true;
    await this.flush();
    return session;
  }

  /**
   * 用令牌换会话（恒定时间比较）。
   *
   * 为什么**扫完整个表**再返回、中途不 `break`：一旦"命中即返回"，请求耗时就与
   * "令牌在表中的位置"相关；虽然 32 字节随机令牌本来就猜不出来，但把这类相关性
   * 留在鉴权路径上没有收益 —— 扫表的代价在"一台服务器几十个会话"的量级下可以忽略。
   */
  findSession(token) {
    const raw = String(token ?? '').trim();
    if (!raw) return null;
    const target = Buffer.from(raw, 'utf8');
    let found = null;
    for (const session of this.sessions.values()) {
      const candidate = Buffer.from(session.token, 'utf8');
      const same = candidate.length === target.length && timingSafeEqual(candidate, target);
      if (same && !found) found = session;
    }
    if (!found) return null;
    if (Number(found.expiresAt) <= this.now()) {
      this.sessions.delete(found.token);
      this.#dirty.sessions = true;
      this.#scheduleFlush();
      return null;
    }
    found.lastSeenAt = new Date(this.now()).toISOString();
    this.#dirty.sessions = true;
    this.#scheduleFlush();
    return found;
  }

  /** 令牌 -> `{user, session}`；令牌无效或过期一律 `null`（调用方负责回 401）。 */
  authenticate(token) {
    const session = this.findSession(token);
    if (!session) return null;
    const user = this.users.get(session.userId);
    if (!user) {
      // 用户被删了但会话还在：顺手清掉，别让它继续换出一个 `null` 用户
      this.sessions.delete(session.token);
      this.#dirty.sessions = true;
      this.#scheduleFlush();
      return null;
    }
    return { user, session };
  }

  /** 退出登录：服务端**真的**把会话删掉（只清 Cookie 是假退出）。 */
  async logout(token) {
    const removed = this.sessions.delete(String(token ?? '').trim());
    if (removed) {
      this.#dirty.sessions = true;
      await this.flush();
    }
    return removed;
  }

  /**
   * 改密码：校验当前密码 → 写新哈希 → **作废该用户除当前会话外的全部会话**。
   *
   * 为什么必须踢掉其它会话：改密码的用户诉求通常是"我怀疑别人在用我的号"，
   * 如果旧设备上的会话还活着，改密码就只是给攻击者加了一道无关紧要的门。
   * 当前会话保留，是为了不让用户改完密码立刻被自己踢下线。
   */
  async changePassword({ token, currentPassword, newPassword } = {}) {
    const auth = this.authenticate(token);
    if (!auth) throw new HttpError(401, 'UNAUTHORIZED', '需要先登录');
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LENGTH) {
      throw HttpError.badRequest(`新密码至少 ${PASSWORD_MIN_LENGTH} 位`);
    }
    if (!verifyPassword(currentPassword ?? '', auth.user.salt, auth.user.passwordHash)) {
      throw new HttpError(401, 'BAD_CREDENTIALS', '当前密码不对');
    }
    const { salt, hash } = hashPassword(newPassword);
    auth.user.salt = salt;
    auth.user.passwordHash = hash;
    auth.user.passwordChangedAt = new Date(this.now()).toISOString();
    let revoked = 0;
    for (const [key, session] of this.sessions) {
      if (session.userId !== auth.user.id) continue;
      if (key === auth.session.token) continue;
      this.sessions.delete(key);
      revoked += 1;
    }
    await this.#persist('users.json', [...this.users.values()]);
    this.#dirty.sessions = true;
    await this.flush();
    this.logger?.log?.(`[www] ${auth.user.username} 修改了密码，已作废 ${revoked} 个其它会话`);
    return { revoked, user: publicUser(auth.user) };
  }

  /* -------------------------------------------------------------- 邀请码（管理员专属） */

  /** 发一个邀请码。角色先固定为 `user`：管理员权限不该通过邀请码"顺手"扩散。 */
  async createInvite(actor) {
    if (actor?.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '只有管理员能发邀请码');
    const invite = {
      id: newUserId(),
      code: newInviteCode(),
      role: 'user',
      createdAt: new Date(this.now()).toISOString(),
      createdBy: actor.id,
    };
    this.invites.set(invite.id, invite);
    await this.#persist('invites.json', [...this.invites.values()]);
    return invite;
  }

  /** 邀请码列表：给管理页看的形状（含 created_at / used_by 两份命名，见 README 的说明）。 */
  listInvites(actor) {
    if (actor?.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '只有管理员能看邀请码');
    return [...this.invites.values()]
      .slice()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((invite) => ({
        id: invite.id,
        code: invite.code,
        role: invite.role,
        used: Boolean(invite.usedBy),
        createdAt: invite.createdAt,
        created_at: invite.createdAt,
        createdBy: invite.createdBy,
        created_by: invite.createdBy,
        usedBy: invite.usedBy ?? null,
        used_by: invite.usedBy ?? null,
        usedAt: invite.usedAt ?? null,
        used_at: invite.usedAt ?? null,
      }));
  }

  async deleteInvite(actor, id) {
    if (actor?.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '只有管理员能删邀请码');
    const invite = this.invites.get(String(id ?? ''));
    if (!invite) throw HttpError.notFound('邀请码不存在');
    this.invites.delete(invite.id);
    await this.#persist('invites.json', [...this.invites.values()]);
    return invite;
  }

  /** 会话统计（诊断用，不含令牌原文）。 */
  stats() {
    return {
      users: this.users.size,
      admins: [...this.users.values()].filter((user) => user.role === 'admin').length,
      invites: this.invites.size,
      unusedInvites: [...this.invites.values()].filter((invite) => !invite.usedBy).length,
      sessions: this.sessions.size,
      lockedKeys: [...this.attempts.values()].filter((entry) => entry.lockedUntil > this.now()).length,
    };
  }
}
