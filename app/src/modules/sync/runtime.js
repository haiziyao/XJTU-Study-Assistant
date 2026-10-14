/**
 * 运行环境判定：现在这套界面跑在**网页版**（公网服务器上的 `/app/`）还是**原生客户端**
 * （桌面 Electron / iOS / Android / 手机上的局域网 App）上。
 *
 * 为什么必须有这个判定（而不是"看着像网页就禁掉"）
 * ------------------------------------------------
 * 敏感数据（AI key、学堂登录凭据）**默认不同步**，只能在非网页客户端里由用户逐台勾选。
 * 网页版不给这个开关。要做到这一点，"我是不是网页版"必须有一个**可测、写在代码里**的口径，
 * 而不是靠平台字符串或用户代理猜 —— 猜错的两个方向都很糟：把桌面端误判成网页（用户永远
 * 开不了同步），或把网页版误判成桌面端（在公网页面上给出"同步 API key"的复选框）。
 *
 * 口径（两段式，顺序不能反）
 * --------------------------
 *   1. **回环或私有网段** → `native`。局域网里的手机、`127.0.0.1` 上的桌面端都在这一档，
 *      它们本来就是"用户自己的设备"，与公网无关；
 *   2. 其余（公网域名 / 公网 IP）→ 看**同源 `/auth/config` 是否可达**：
 *      可达 = 这是本项目**服务端版宿主**发出来的页面 → `web`；
 *      不可达 = 不是宿主发的页面（自建反代只转发了 `/app`、Electron 直开文件、
 *      或者用户自己搭的静态托管）→ `native`。
 *   3. 拿不到同源探测结果（fetch 被 CSP 拦、离线、宿主 404 之外的怪响应）→ `unknown`：
 *      **按 native 处理**（不拦用户自己的设备），但报告里如实写明"没验成功"。
 *
 * 谁提供这两个事实
 * ----------------
 * `hostname` 与"同源 `/auth/config` 是否可达"**只有渲染层知道**（页面的 `location`、
 * 页面的同源 fetch）。后端侧的 Host 头不可信也不用信：服务端版宿主把 `/api/**`
 * 反代给每用户实例时会把 Host 改写成 `127.0.0.1:<随机端口>`、并剥掉凭据头
 * （见 `src/www/proxy.js` 的 `forwardRequestHeaders`），所以后端**看不出**页面来自公网。
 * 于是渲染层只上报这两个**原始事实**，判定本身仍然只在这一处做（单一出处：
 * 谁都不许自己拼 `'web'` 字符串）。
 *
 * 渲染层的退化
 * ------------
 * `views/sync.js` 在拿不到 `/auth/config` 结果时把 `hasSameOriginAuthConfig` 传 `null`
 * （= 未知），此时结论是 `unknown` 而不是 `native`/`web` —— 这一条在面板上有明确说明。
 */

/** 回环主机名（含 IPv6 的 `::1` 与 `*.localhost`）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

/** 去掉端口、方括号、末尾的点，转小写；非法输入回空串。 */
export function normalizeHostname(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return '';
  let host = raw;
  // `[::1]:3210` / `[::1]` → `::1`
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) host = bracketed[1];
  else if (host.includes(':') && !host.includes('::') && /:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(':'));
  return host.replace(/\.+$/, '');
}

/** `192.168.0.0/16`、`10/8`、`172.16/12` 这些"私有网段"判定（外加链路本地与 CGNAT）。 */
export function isPrivateHostname(input) {
  const host = normalizeHostname(input);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost')) return true;
  // 纯主机名（不带点）= 局域网里的机器名（`mypc`、`ipad`），按"自己的设备"处理
  if (!host.includes('.') && !host.includes(':')) return true;
  // `.local`（mDNS）、`.lan`、`.home` 都是局域网后缀
  if (/\.(local|lan|home|internal)$/.test(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true; // 回环
    if (a === 10) return true; // 10/8
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10（Tailscale 一类）
    return false;
  }
  // IPv6：唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
  return false;
}

/**
 * 环境判定的**纯函数**（真值表在 `test/sync-runtime.test.js` 里逐条钉住）。
 *
 * @param {object} input
 * @param {string} input.hostname 页面的 `location.hostname`
 * @param {boolean|null} [input.hasSameOriginAuthConfig]
 *   同源 `/auth/config` 是否返回 200；`true`/`false`/`null`（没验成功）
 * @returns {'web'|'native'|'unknown'}
 */
export function detectRuntimeKind({ hostname, hasSameOriginAuthConfig } = {}) {
  const host = normalizeHostname(hostname);
  if (!host) return 'unknown';
  // ① 回环 / 私有网段：用户自己的设备，与公网无关，不再看探测结果
  if (isPrivateHostname(host)) return 'native';
  // ② 公网地址 + 同源 /auth/config 可达 = 服务端版宿主发出来的页面
  if (hasSameOriginAuthConfig === true) return 'web';
  // ③ 公网地址 + 明确不可达 = 不是宿主发的页面（自建静态托管 / 直开文件）
  if (hasSameOriginAuthConfig === false) return 'native';
  // ④ 没验成功：按 native 处理，但如实标记未知
  return 'unknown';
}

/**
 * 给人看的解释（面板与 `/sync/run` 的报告都用它）。
 *
 * @returns {{kind:'web'|'native'|'unknown', reason:string, hostname:string, hasSameOriginAuthConfig:boolean|null}}
 */
export function explainRuntime({ hostname, hasSameOriginAuthConfig } = {}) {
  const host = normalizeHostname(hostname);
  const probed = hasSameOriginAuthConfig === true ? true : hasSameOriginAuthConfig === false ? false : null;
  const kind = detectRuntimeKind({ hostname: host, hasSameOriginAuthConfig: probed });
  const shown = host || '（拿不到主机名）';
  let reason;
  if (kind === 'web') {
    reason = `${shown} 是公网地址，且同源 /auth/config 可达 —— 判定为网页版，不提供敏感数据同步开关。`;
  } else if (kind === 'native' && isPrivateHostname(host)) {
    reason = `${shown} 是回环/私有网段地址 —— 判定为你自己的设备（桌面端或局域网里的手机）。`;
  } else if (kind === 'native') {
    reason = `${shown} 是公网地址，但同源 /auth/config 不可达 —— 不是服务端版宿主发的页面，按原生客户端处理。`;
  } else {
    reason = `拿不到 ${shown} 的同源 /auth/config 探测结果（可能离线或被 CSP 拦下），无法确认是不是网页版：按原生客户端处理，但请在开启敏感数据同步前自己确认。`;
  }
  return { kind, reason, hostname: host, hasSameOriginAuthConfig: probed };
}

/** 敏感数据同步是否允许在这个环境里开启（`unknown` 放行，理由见文件头）。 */
export function secretsAllowed(kind) {
  return kind !== 'web';
}
