/**
 * 成长模块的错误语义。
 *
 * 源项目自己定义了 `badRequest(code, message, details)` / `notFound(code, message)`，
 * 错误码是前端与 Agent 用来区分「字段写错了 / 日期非法 / 还没录状态」的唯一依据。
 * XJTU 的 `HttpError.badRequest()` 会把 code 固定成 BAD_REQUEST，所以这里直接构造
 * `HttpError(status, code, message, details)`，**保留源项目的错误码**。
 */

import { HttpError } from '../../core/http/router.js';

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);

export const notFound = (code, message) => new HttpError(404, code, message);

/** 只有「内部错误」才用 500；业务错误一律显式状态码。 */
export const serverError = (code, message, details) => new HttpError(500, code, message, details);
