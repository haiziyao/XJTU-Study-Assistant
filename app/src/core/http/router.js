/**
 * 零依赖微型 HTTP 路由。
 *
 * 只覆盖本项目需要的能力：路径参数、查询串、JSON 请求体、统一错误响应。
 * 后端仅监听 127.0.0.1，因此不做鉴权，但保留 `X-Potato-Token` 透传位置（见 index.js）。
 */

import { ERROR_CODES } from '../../shared/constants.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** 错误文案从常量算出来：不会再出现"实际 12MB、提示 1MB"这种自相矛盾的上限。 */
const MAX_BODY_MB = Math.round(MAX_BODY_BYTES / (1024 * 1024));

/** 业务异常：携带 HTTP 状态码与统一错误码。 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new HttpError(400, ERROR_CODES.BAD_REQUEST, message, details);
  }

  static notFound(message, details) {
    return new HttpError(404, ERROR_CODES.NOT_FOUND, message, details);
  }

  static conflict(message, details) {
    return new HttpError(409, ERROR_CODES.CONFLICT, message, details);
  }

  static notImplemented(message, details) {
    return new HttpError(501, ERROR_CODES.NOT_IMPLEMENTED, message, details);
  }

  /** 需要先登录外部系统（如思源学堂）。 */
  static unauthorized(message, details) {
    return new HttpError(401, ERROR_CODES.UNAUTHORIZED, message, details);
  }

  /** 学校服务器/上游服务出错。 */
  static upstream(message, details) {
    return new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, message, details);
  }
}

/**
 * 允许跨源访问。
 *
 * 服务只监听 127.0.0.1 且没有鉴权，因此放开 CORS 的风险可控，
 * 换来的是「用浏览器直接打开 src/renderer/index.html 调试」这一低成本联调方式。
 */
function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req?.headers?.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Potato-Token,X-File-Name,X-File-Type',
    'Access-Control-Max-Age': '600',
  };
}

export function sendJson(res, status, payload, req) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  });
  res.end(body);
}

export function sendError(res, error, req) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : ERROR_CODES.INTERNAL;
  const payload = {
    ok: false,
    error: { code, message: error.message || '服务内部错误' },
  };
  if (error instanceof HttpError && error.details !== undefined) payload.error.details = error.details;
  if (status >= 500) payload.error.stack = error.stack?.split('\n').slice(0, 5).join('\n');
  sendJson(res, status, payload, req);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 边读边算，超限的这块**不 push**：不会把半个超大 body 留在内存里再报错。
    // 413 + PAYLOAD_TOO_LARGE 而不是 400：超限是"实体太大"，与 transfer 设备服务器同一口径，
    // 前端/反代都能按 code 识别（`{ ok:false, error:{ code, message } }` 外壳不变）。
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体过大（上限 ${MAX_BODY_MB}MB）`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw HttpError.badRequest('请求体不是合法 JSON');
  }
}

/**
 * 把路由模式编译成正则。
 *
 * 支持两种占位：
 *   `:name`  匹配单个路径段（`([^/]+)`），放进 params[name]
 *   `*`      只允许出现在末尾，匹配剩余任意路径（含空串），放进 params.rest
 *            —— 静态资源服务需要它来覆盖任意深度的文件
 */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        names.push('rest');
        return '(.*)';
      }
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}


export function createRouter() {
  const routes = [];

  const register = (method, pattern, handler, options = {}) => {
    routes.push({ method, pattern, handler, rawBody: Boolean(options.rawBody), ...compile(pattern) });
  };

  return {
    get: (p, h) => register('GET', p, h),
    post: (p, h) => register('POST', p, h),
    /** 文件等大请求体由业务路由流式读取，避免先被 JSON 解析器整份载入内存。 */
    postRaw: (p, h) => register('POST', p, h, { rawBody: true }),
    patch: (p, h) => register('PATCH', p, h),
    put: (p, h) => register('PUT', p, h),
    delete: (p, h) => register('DELETE', p, h),
    /** 已注册路由清单，供 /api/v1 自描述使用。 */
    list: () => routes.map((r) => `${r.method} ${r.pattern}`),

    async handle(req, res, options = {}) {
      const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = decodeURIComponent(url.pathname);

      // CORS 预检：让浏览器直接打开测试页面时也能调本机接口
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
      if (!match) {
        sendError(res, HttpError.notFound(`未找到接口 ${req.method} ${pathname}`), req);
        return;
      }
      try {
        const params = {};
        const values = pathname.match(match.regex).slice(1);
        match.names.forEach((name, i) => {
          params[name] = values[i];
        });
        const query = Object.fromEntries(url.searchParams.entries());
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) && !match.rawBody ? await readBody(req) : undefined;
        const result = await match.handler({
          req,
          res,
          params,
          query,
          body,
          url,
          services: options.services,
          broadcast: options.broadcast,
        });
        if (res.writableEnded) return;
        if (result === undefined) {
          sendJson(res, 204, { ok: true }, req);
          return;
        }
        // 非 JSON 响应（如 ICS 导出）：handler 返回 { __raw: { contentType, body } }
        if (result.__raw) {
          const raw = result.__raw;
          res.writeHead(raw.status ?? 200, {
            'Content-Type': raw.contentType ?? 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(raw.body),
            'Cache-Control': 'no-store',
            ...corsHeaders(req),
            ...(raw.headers ?? {}),
          });
          res.end(raw.body);
          return;
        }
        const status = result.__status ?? 200;
        const payload = { ...result };
        delete payload.__status;
        sendJson(res, status, { ok: true, ...payload }, req);
      } catch (error) {
        sendError(res, error, req);
      }
    },
  };
}
