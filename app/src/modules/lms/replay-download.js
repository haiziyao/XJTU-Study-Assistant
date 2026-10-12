/**
 * 课程回放下载器。
 *
 * 为什么放后端而不是渲染进程：视频直链要带录播站的票据和学堂的登录 Cookie，
 * 前端（渲染进程）既拿不到会话，也会被 CSP 挡住跨域大文件；后端还能边下边写盘，
 * 不必把几百 MB 读进内存。
 *
 * 行为约定：
 * - 落盘路径：`<downloadDir>/<课程名>/<活动标题>/<标签>[_体积].mp4`，非法字符替换掉；
 * - 先写 `<文件>.part`，下完再改名 —— 中途失败/取消不会留下半个"看起来正常"的 mp4；
 * - 进度：边写边记字节数，节流广播（默认 500ms 一次），前端也可以轮询 `list()`；
 * - 同一个视频重复点下载会复用正在跑的任务，不会同时下两份。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from '../../core/http/router.js';

/** 文件名里不能出现的字符（把 Windows 的限制也一并考虑进来）。 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 路径分段安全化：去非法字符、去首尾空白与点、限长。 */
export function sanitizeSegment(value, fallback = '未命名') {
  const text = String(value ?? '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return text || fallback;
}

/** 人类可读体积（1024 进制），用在文件名与界面上。 */
export function humanSize(bytes) {
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

/** 找一个不冲突的文件名：`x.mp4` 已存在就试 `x (2).mp4`。 */
async function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let index = 1; index < 100; index += 1) {
    const candidate = index === 1 ? target : path.join(dir, `${base} (${index})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

/** 去掉内部字段（AbortController / 计时器）后再交给前端。 */
function publicJob(job) {
  return {
    id: job.id,
    activityId: job.activityId,
    courseName: job.courseName,
    title: job.title,
    label: job.label,
    labelText: job.labelText,
    fileName: job.fileName,
    path: job.path,
    status: job.status,
    bytes: job.bytes,
    total: job.total,
    speed: job.speed,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    percent: job.total ? Math.min(100, Math.round((job.bytes / job.total) * 100)) : null,
  };
}

export class ReplayDownloader {
  /**
   * @param {object} options
   * @param {import('./http-client.js').HttpClient} options.http 复用登录 Cookie 的客户端
   * @param {string} options.downloadDir 下载根目录
   * @param {(event: object) => void} [options.broadcast] WebSocket 广播
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.progressIntervalMs] 进度广播节流间隔
   */
  constructor({ http, downloadDir, broadcast = () => {}, log = () => {}, progressIntervalMs = 500 } = {}) {
    this.http = http;
    this.downloadDir = downloadDir;
    this.broadcast = broadcast;
    this.log = log;
    this.progressIntervalMs = progressIntervalMs;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.seq = 0;
  }

  /** 全部任务（新→旧），给前端轮询。 */
  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map(publicJob);
  }

  get(id) {
    const job = this.jobs.get(String(id));
    return job ? publicJob(job) : null;
  }

  /** 正在跑的任务数（前端据此决定还要不要继续轮询）。 */
  get activeCount() {
    return [...this.jobs.values()].filter((job) => job.status === 'running').length;
  }

  /** 清掉已结束的任务记录（**不删文件**）。 */
  clearFinished() {
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running') this.jobs.delete(id);
    }
    return this.list();
  }

  /**
   * 开始下载一个回放视频。
   *
   * @param {object} options
   * @param {object} options.video 归一化过的回放视频（normalizeReplayVideo 的结果）
   * @param {string} [options.courseName] 课程名（做目录）
   * @param {string} [options.title] 活动标题（做目录）
   * @param {string|number} [options.activityId]
   */
  start({ video, courseName, title, activityId } = {}) {
    const url = video?.downloadUrl || video?.playUrl;
    if (!url) throw HttpError.badRequest('这个回放没有可下载的地址');
    const labelText = video.labelText || '视频';

    // 同一个视频（活动 + 标签 + 地址）已经在跑就不再开一个
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.status === 'running' &&
        String(job.activityId ?? '') === String(activityId ?? '') &&
        job.labelText === labelText &&
        job.url === url,
    );
    if (existing) return publicJob(existing);

    const id = `dl-${++this.seq}-${Date.now().toString(36)}`;
    const dir = path.join(
      this.downloadDir,
      sanitizeSegment(courseName, '未命名课程'),
      sanitizeSegment(title, '未命名活动'),
    );
    const sizeText = humanSize(video.size);
    const fileName = `${sanitizeSegment(labelText, '视频')}${sizeText ? `_${sizeText}` : ''}.mp4`;

    const controller = new AbortController();
    const job = {
      id,
      activityId: activityId ?? null,
      courseName: courseName ?? null,
      title: title ?? null,
      label: video.label ?? null,
      labelText,
      fileName,
      dir,
      path: path.join(dir, fileName),
      url,
      status: 'running',
      bytes: 0,
      total: Number.isFinite(Number(video.size)) && Number(video.size) > 0 ? Number(video.size) : null,
      speed: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      controller,
      lastBroadcastAt: 0,
      lastBytesAt: Date.now(),
      lastBytes: 0,
    };
    this.jobs.set(id, job);
    this.#emit(job);
    this.#run(job).catch((error) => this.log(`[lms] 回放下载异常：${error?.message ?? error}`));
    return publicJob(job);
  }

  /** 取消一个正在跑的任务（`.part` 会删掉）。 */
  cancel(id) {
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (job.status === 'running') job.controller.abort();
    return publicJob(job);
  }

  /** 取消全部（进程退出时用）。 */
  cancelAll() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort();
    }
  }

  async #run(job) {
    await mkdir(job.dir, { recursive: true });
    job.path = await uniquePath(job.path);
    job.fileName = path.basename(job.path);
    const partPath = `${job.path}.part`;

    try {
      const response = await this.http.stream(job.url, {
        signal: job.controller.signal,
        headers: { Accept: '*/*' },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`下载地址返回 HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('下载地址没有返回内容');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) job.total = length;

      // 边传边记账：把 Web ReadableStream 挂上进度后交给 pipeline 写文件
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        job.bytes += chunk.length;
        this.#tick(job);
      });
      await pipeline(source, createWriteStream(partPath));
      await rename(partPath, job.path);
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      if (!job.total) job.total = job.bytes;
      job.speed = 0;
      this.#emit(job);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => {});
      const aborted = job.controller.signal.aborted || error?.name === 'AbortError';
      job.status = aborted ? 'cancelled' : 'failed';
      job.error = aborted ? null : (error?.message ?? String(error));
      job.finishedAt = new Date().toISOString();
      job.speed = 0;
      this.#emit(job);
    }
  }

  /** 进度节流：按间隔广播，避免一秒钟几百条 WebSocket 消息。 */
  #tick(job) {
    const now = Date.now();
    if (now - job.lastBroadcastAt < this.progressIntervalMs) return;
    const elapsed = (now - job.lastBytesAt) / 1000;
    if (elapsed > 0.2) {
      job.speed = Math.max(0, Math.round((job.bytes - job.lastBytes) / elapsed));
      job.lastBytes = job.bytes;
      job.lastBytesAt = now;
    }
    this.#emit(job);
  }

  #emit(job) {
    job.lastBroadcastAt = Date.now();
    this.broadcast({
      type: 'data_changed',
      payload: { target: 'lms-download', action: job.status, download: publicJob(job) },
    });
  }
}
