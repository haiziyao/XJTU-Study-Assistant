/**
 * 渲染层静态文件服务（框架级）。
 *
 * 原先是一张显式白名单（RENDERER_FILES），**新增一个前端文件就必须改路由代码** ——
 * 与「新增功能 = 新建文件」的目标直接冲突。现在改为按目录提供服务，靠两道防护保证安全：
 *
 *   1. 解析后的真实路径必须仍落在 root 之内（挡掉 `../../` 目录穿越与绝对路径）；
 *   2. 只读取实际存在的普通文件，目录自动补 `index.html`。
 *
 * 顺带支持图片/字体等二进制资源（旧实现以 utf8 读取，只能放行文本）。
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { HttpError } from './router.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeOf = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * 把相对路径解析成 root 内的绝对路径。
 * @returns {string|undefined} 越界时返回 undefined
 */
export function resolveInside(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) return undefined;
  return target;
}

/**
 * 注册静态资源路由：`<prefix>`（裸路径 302 到带斜杠）与 `<prefix>/*`。
 *
 * @param {object} router  core/http/router.js 的实例
 * @param {object} options
 * @param {string} options.root    服务的根目录（绝对路径）
 * @param {string} [options.prefix='/app'] URL 前缀
 */
export function registerStaticRoutes(router, { root, prefix = '/app' }) {
  const base = path.resolve(root);

  const asset = (relative) => {
    let file = resolveInside(base, relative);
    if (!file) throw HttpError.notFound(`静态资源越界: ${relative}`);
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      throw HttpError.notFound(`静态资源不存在: ${relative}`);
    }
    let body;
    try {
      body = readFileSync(file);
    } catch {
      throw HttpError.notFound(`静态资源不存在: ${relative}`);
    }
    return { __raw: { contentType: contentTypeOf(file), body } };
  };

  // 裸路径必须 302 到带斜杠的目录路径：页面内的资源都是相对路径，
  // 否则浏览器会以 `/` 为基准解析成 `/shell/app.js` 而 404。
  router.get(prefix, ({ req }) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    if (pathname === prefix) {
      return {
        __raw: {
          status: 302,
          contentType: 'text/plain; charset=utf-8',
          headers: { Location: `${prefix}/` },
          body: '',
        },
      };
    }
    return asset('index.html');
  });

  router.get(`${prefix}/*`, ({ params }) => asset(params.rest ?? ''));
}
