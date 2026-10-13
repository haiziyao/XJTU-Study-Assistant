/**
 * 图片笔记（随手拍）的本地文字识别 —— macOS 自带 Vision 框架。
 *
 * 为什么是这条路：用户在意隐私，**图片绝不离开本机**，所以不接任何云 OCR；
 * 同时仓库约定 Node.js 零运行时依赖，也不引 npm 包。macOS 系统自带的
 * `VNRecognizeTextRequest` 支持简体中文 + 英文，识别在本地 CPU 上做，正好满足两条约束。
 *
 * 结构上分三段，互不耦合：
 *   1. `recognizeImageDataUrl()` / `recognizeFile()` 是**唯一出口**，永远 resolve，
 *      失败也返回 `{ ok:false, reason, message }` —— 上层（笔记服务、AI）不必写 try/catch。
 *   2. Swift 小工具（`vision-ocr.swift`）首次用到时用 `swiftc -O` 编译成
 *      `data/.ocr/vision-ocr` 并复用；编译不了 / 没有 swiftc → `ocr_unavailable`（如实降级）。
 *   3. 识别**串行**执行：Vision 会把 CPU 吃满，并发跑多张只会互相拖慢，还可能让
 *      好几个随手拍同时"卡住"（每个都以为自己在等超时）。队列见 `enqueue()`。
 *
 * 超时口径：单张默认 30s（`timeoutMs` 可调），超时杀进程并如实返回 `timeout`，
 * 不返回半截结果（半截文字混进笔记检索，比没有更坏）。
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 交付约定的编译产物位置：`app/data/.ocr/vision-ocr`（首次使用才编译，之后复用）。 */
export const OCR_ASSET_DIR = path.join('data', '.ocr');
export const OCR_BINARY_NAME = 'vision-ocr';
export const OCR_SOURCE_NAME = 'vision-ocr.swift';
/** 本模块自带的 Swift 源码（相对本文件），随模块一起分发；产物才落在 data/.ocr。 */
const DEFAULT_SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), OCR_SOURCE_NAME);

/** dataUrl 解码上限（20MB）：再大就不是"随手拍"了，下载下来只会把内存和 Vision 一起拖死。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 单张识别的默认超时（30s）。 */
export const DEFAULT_TIMEOUT_MS = 30000;
/** 首次 `swiftc -O` 编译的等待上限：实测冷启动要 40s+，给足但不无限等。 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 60000;
/** 识别语言：简体中文优先，附英文（公式里的变量、英文标注）。 */
export const DEFAULT_LANGUAGES = Object.freeze(['zh-Hans', 'en-US']);
/** 识别文本写回笔记时的长度上限（防止一整页小说般的文本把笔记索引撑爆）。 */
const MAX_TEXT_CHARS = 20000;

/** 队列：同一时刻只跑一张（Vision 吃 CPU）。 */
let pending = 0;
let chain = Promise.resolve();

function enqueue(task) {
  pending += 1;
  const result = chain.then(task, task);
  chain = result.then(() => undefined, () => undefined);
  return result.finally(() => { pending -= 1; });
}

/** 队列里还没跑完的任务数（含正在跑的那张）。给测试和"要不要排队"的判断用。 */
export function queueDepth() { return pending; }

const fail = (reason, message) => ({ ok: false, reason, message: String(message ?? '') });
const isImageType = (type) => /^image\//i.test(String(type ?? ''));

/**
 * 拆 dataUrl：只接受 `data:image/...;base64,....`。
 *
 * 单独抽出来是为了让"为什么这张图没识别"能给出具体原因（不是图片 / 不是 base64 / 空图），
 * 而不是笼统一句"识别失败"。
 */
export function parseImageDataUrl(dataUrl) {
  const raw = String(dataUrl ?? '');
  if (!raw) return fail('bad_image', '附件没有图片数据');
  const comma = raw.indexOf(',');
  if (comma < 0) return fail('bad_image', '附件不是合法的 dataUrl');
  const header = raw.slice(5, comma); // 去掉开头的 "data:"
  const payload = raw.slice(comma + 1);
  const [type, ...flags] = header.split(';').map((part) => part.trim());
  if (!isImageType(type)) return fail('bad_image', `不是图片附件（${type || '未知类型'}），已跳过识别`);
  if (!flags.some((flag) => flag.toLowerCase() === 'base64')) return fail('bad_image', '图片 dataUrl 不是 base64 编码');
  const bytes = Buffer.from(payload, 'base64');
  if (!bytes.length) return fail('bad_image', '图片数据为空或 base64 损坏');
  if (bytes.length > MAX_IMAGE_BYTES) return fail('bad_image', `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，未做识别`);
  return { ok: true, type, bytes };
}

/**
 * 解析小工具的输出（每行一个 JSON 对象，见 vision-ocr.swift）。
 *
 * 刻意容忍非 JSON 行（编译器 warning、系统提示都可能混进 stdout）：
 * 只要有一行解析得出 `text` 就算数，一行都没有才当"没识别到文字"。
 */
export function parseOcrLines(stdout) {
  const lines = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    const text = raw.trim();
    if (!text.startsWith('{')) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    const value = String(parsed?.text ?? '').trim();
    if (!value) continue;
    const confidence = Number(parsed?.confidence);
    lines.push({ text: value, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0 });
  }
  return lines;
}

function truncate(text) {
  const value = String(text ?? '');
  return value.length > MAX_TEXT_CHARS ? { text: value.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: value, truncated: false };
}

/** 跑一个子进程，收集 stdout/stderr，`limitMs` 到点就杀。 */
function runProcess(command, args, { limitMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ spawned: false, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const limit = Number(limitMs);
    const timer = Number.isFinite(limit) && limit > 0
      ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, limit)
      : null;
    timer?.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ spawned: false, error, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ spawned: true, code, stdout, stderr, timedOut });
    });
  });
}

/** `swiftc` / `swift` 是否真的在（在，才谈得上"编译一次"）。 */
export function swiftCompiler() {
  for (const candidate of ['/usr/bin/swiftc', '/usr/bin/swift']) {
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* 试下一个 */ }
  }
  return null;
}

async function fileMtime(target) {
  try { return (await stat(target)).mtimeMs; } catch { return 0; }
}

function isExecutable(target) {
  try { accessSync(target, fsConstants.X_OK); return true; } catch { return false; }
}

/**
 * 保证编译产物存在且不比源码旧（源码改了自动重编，不用手工删缓存）。
 * @returns {Promise<{ok:true, binary:string, compiled:boolean} | {ok:false, message:string}>}
 */
export async function ensureBinary({ assetDir, sourcePath = DEFAULT_SOURCE_PATH, compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS } = {}) {
  const binary = path.join(assetDir, OCR_BINARY_NAME);
  if (!assetDir) return { ok: false, message: '没有可用的数据目录（无法编译 OCR 小工具）' };
  if (isExecutable(binary) && (await fileMtime(binary)) >= (await fileMtime(sourcePath))) {
    return { ok: true, binary, compiled: false };
  }
  const compiler = swiftCompiler();
  if (!compiler) return { ok: false, message: '本机没有 swiftc / swift，无法编译 macOS Vision OCR 小工具' };
  if (!(await fileMtime(sourcePath))) return { ok: false, message: `OCR 源码不存在：${sourcePath}` };
  await mkdir(assetDir, { recursive: true });
  // 模块缓存指到 data/.ocr 下：默认的系统缓存目录在受限沙箱里可能不可写，
  // 那样连 Foundation 都 import 不了（"could not build Objective-C module 'SwiftShims'"）。
  const moduleCache = path.join(assetDir, 'modulecache');
  let outcome;
  try {
    outcome = await runProcess(compiler, [
      '-O',
      '-module-cache-path', moduleCache,
      sourcePath,
      '-o', binary,
    ], { limitMs: compileTimeoutMs });
  } finally {
    // 编完就把缓存删掉：里面有 `.swiftmodule` 等中间产物，实测 220MB+，
    // 而产物本身只有 88KB。删了不影响复用（判断复用只看二进制的 mtime），
    // 真需要重编时再重建一次缓存（代价就是那 45s，本来也要付）。
    await rm(moduleCache, { recursive: true, force: true }).catch(() => {});
  }
  if (!outcome.spawned) return { ok: false, message: `无法启动 ${compiler}：${outcome.error?.message ?? '未知错误'}` };
  if (outcome.timedOut) return { ok: false, message: `编译 OCR 小工具超时（${compileTimeoutMs}ms）` };
  if (outcome.code !== 0 || !isExecutable(binary)) {
    const detail = String(outcome.stderr ?? '').split('\n').filter(Boolean).slice(0, 3).join(' / ');
    return { ok: false, message: `编译 OCR 小工具失败（exit ${outcome.code}）${detail ? `：${detail}` : ''}` };
  }
  return { ok: true, binary, compiled: true };
}

/**
 * 识别一张**本地图片文件**（内部用；dataUrl 会先落成临时文件）。
 *
 * 返回值永远 resolve：
 *   `{ ok:true, text, chars, lines:[{text,confidence}], engine:'macos-vision', durationMs }`
 *   `{ ok:false, reason:'ocr_unavailable'|'no_text'|'bad_image'|'timeout'|'failed', message }`
 */
export async function recognizeFile(absPath, opts = {}) {
  const started = Date.now();
  const assetDir = opts.assetDir;
  const target = String(absPath ?? '');
  if (!target) return fail('bad_image', '没有给出图片路径');
  // 错误信息带路径便于排查，但**必须截断**：调用方可能误传 380 万字符的 dataUrl，
  // 原样写进 message 会把日志和测试输出一起淹掉。
  const label = target.length > 200 ? `${target.slice(0, 200)}…（共 ${target.length} 字符）` : target;
  return enqueue(async () => {
    try {
      if (!(await fileMtime(target))) return fail('bad_image', `图片文件不存在：${label}`);
      const built = await ensureBinary({ assetDir, sourcePath: opts.sourcePath, compileTimeoutMs: opts.compileTimeoutMs });
      if (!built.ok) return fail('ocr_unavailable', built.message);
      const args = [target];
      for (const language of (Array.isArray(opts.languages) && opts.languages.length ? opts.languages : DEFAULT_LANGUAGES)) {
        args.push('--languages', String(language));
      }
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
      const outcome = await runProcess(built.binary, args, { limitMs: timeoutMs });
      if (outcome.timedOut) return fail('timeout', `文字识别超过 ${timeoutMs}ms，已中止`);
      if (!outcome.spawned) return fail('failed', `无法启动识别小工具：${outcome.error?.message ?? '未知错误'}`);
      if (outcome.code !== 0) {
        return fail('failed', `识别失败（exit ${outcome.code}）${String(outcome.stderr ?? '').trim().slice(0, 200)}`);
      }
      const lines = parseOcrLines(outcome.stdout);
      if (!lines.length) return fail('no_text', '这张图里没有识别到文字');
      const { text, truncated } = truncate(lines.map((line) => line.text).join('\n'));
      return {
        ok: true,
        text,
        chars: text.length,
        lines,
        engine: 'macos-vision',
        durationMs: Date.now() - started,
        ...(truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      return fail('failed', error?.message ?? '识别过程中出现未知错误');
    }
  });
}

/**
 * 识别一个 `data:image/*;base64,...` 附件（笔记附件的形态）。
 *
 * 这里做三件事，然后交给 `recognizeFile()`：类型/大小校验 → 落临时文件 → 用完整版删除。
 * 临时文件写在系统 tmp 下、名字带随机段，**用完即删**（图片数据不落在笔记目录里）。
 */
export async function recognizeImageDataUrl(dataUrl, opts = {}) {
  const started = Date.now();
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed.ok) return parsed;
  const assetDir = opts.assetDir;
  let tempPath = null;
  try {
    if (assetDir) await mkdir(assetDir, { recursive: true });
    tempPath = path.join(tmpdir(), `${OCR_BINARY_NAME}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.img`);
    await writeFile(tempPath, parsed.bytes);
    const result = await recognizeFile(tempPath, opts);
    // `durationMs` 按"用户等了多久"算：含落盘，不含排队（排队是并发策略，不是这张图的成本）
    return result.ok ? { ...result, durationMs: Date.now() - started } : result;
  } catch (error) {
    return fail('failed', error?.message ?? '写入临时图片失败');
  } finally {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
  }
}

/** 笔记里挑第一张图片附件（`attachmentsOf` 的形状：`[{name,type,size,dataUrl}]`）。 */
export function firstImageAttachment(attachments) {
  if (!Array.isArray(attachments)) return null;
  return attachments.find((item) => isImageType(item?.type) && typeof item?.dataUrl === 'string' && item.dataUrl) ?? null;
}
