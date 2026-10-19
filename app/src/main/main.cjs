/**
 * Electron 主进程（CommonJS）。
 *
 * 为什么用 .cjs 而不是 ESM：
 * 在 ESM 下 `import ... from 'electron'` 会被 Node 的 ESM 解析器指向 node_modules 里的
 * npm 包（它导出的是二进制路径字符串），导致 `app`/`BrowserWindow` 为 undefined。
 * 主进程用 CommonJS + `require('electron')` 才能稳定拿到内置 API；
 * 需要用到 ESM 的业务模块（后端、共享常量）时用动态 `import()` 加载。
 *
 * 职责边界（刻意保持很薄）：
 * 1. 在同进程内启动 Node.js 后端，并把实际端口通过 IPC 告诉渲染层；
 * 2. 打开测试窗口（正式 UI 由 AI 智学主程序提供）；
 * 3. 订阅后端广播，把提醒转成系统通知。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron');

const CURRENT_DIR = __dirname;
const RENDERER_ENTRY = path.join(CURRENT_DIR, '..', 'renderer', 'index.html');
/** 启动日志：GUI 方式（open / 双击）启动时看不到 stdout，落盘方便排查。 */
const LOG_FILE = path.join(CURRENT_DIR, '..', '..', 'data', 'electron-main.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((item) => (item instanceof Error ? `${item.message}\n${item.stack}` : typeof item === 'string' ? item : JSON.stringify(item)))
    .join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* 忽略日志写入失败 */
  }
  console.log(line.trim());
}

/**
 * 崩溃与退出诊断。
 *
 * 背景：GUI 方式启动看不到 stdout，主进程一旦「静默退出」就完全无从查起
 * （现象是窗口一闪即逝、日志停在最后一条里程碑）。这里把所有非正常退出路径都记进日志，
 * 让下一次启动能直接指出是谁结束了进程。
 */
process.on('uncaughtException', (error) => {
  log('[main] !! 未捕获异常:', error);
});
process.on('unhandledRejection', (reason) => {
  log('[main] !! 未处理的 Promise 拒绝:', reason instanceof Error ? reason : new Error(String(reason)));
});

/** 渲染进程 / 子进程异常退出（崩溃时为 reason='crashed'，被系统杀死为 'killed'）。 */
app.on('render-process-gone', (_event, _contents, details) => {
  log(`[main] !! 渲染进程退出: reason=${details?.reason} exitCode=${details?.exitCode}`);
});
app.on('child-process-gone', (_event, details) => {
  log(`[main] !! 子进程退出: type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`);
});

/** ESM 模块缓存（后端与共享常量）。 */
let esm;
let backend;
let backendInfo;
let mainWindow;

/**
 * 数据目录优先级：
 * 1. 环境变量 POTATO_DATA_DIR；
 * 2. 应用根目录下的 data-dir.txt（由 scripts/run-electron-macos.sh 写入，
 *    用于让打包进 Electron.app 的测试窗口与项目共用同一份数据）；
 * 3. 缺省（应用根目录/data）。
 */
function resolveDataDir() {
  if (process.env.POTATO_DATA_DIR) return process.env.POTATO_DATA_DIR;
  try {
    const marker = fs.readFileSync(path.join(CURRENT_DIR, '..', '..', 'data-dir.txt'), 'utf8').trim();
    if (marker) return marker;
  } catch {
    /* 没有覆盖文件时走默认值 */
  }
  return undefined;
}

/**
 * 思源学堂接入配置（可选）。
 *
 * 默认连学校线上站点；如果需要指向 webvpn 或本地假站点（离线演示），
 * 只要在数据目录（或应用根目录）放一个 lms-config.json：
 *   { "baseUrl": "http://127.0.0.1:4599", "casOrigin": "http://127.0.0.1:4599" }
 * 注意：GUI 启动（open / 双击）不会继承终端里的环境变量，所以用文件而不是环境变量。
 */
function resolveLmsOptions(dataDir) {
  const candidates = [
    process.env.POTATO_LMS_CONFIG,
    dataDir ? path.join(dataDir, 'lms-config.json') : null,
    path.join(CURRENT_DIR, '..', '..', 'lms-config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        log();
        return { config: parsed };
      }
    } catch {
      /* 不存在或格式错误就忽略，继续用线上配置 */
    }
  }
  return undefined;
}

/** 加载 ESM 业务模块（只加载一次）。 */
async function loadEsm() {
  if (!esm) {
    const [server, constants, theme] = await Promise.all([
      import('../server/index.js'),
      import('../shared/constants.js'),
      import('../shared/theme.js'),
    ]);
    esm = { createServer: server.createServer, constants, theme: theme.THEME };
  }
  return esm;
}

/** 端口被占用时依次递增重试，最多 10 个端口。 */
async function startBackend() {
  const { createServer, constants } = await loadEsm();
  const dataDir = resolveDataDir();
  backend = await createServer({ dataDir, lms: resolveLmsOptions(dataDir) });
  const candidates = Array.from({ length: 10 }, (_, index) => constants.DEFAULT_PORT + index);
  let lastError;
  for (const port of candidates) {
    try {
      backendInfo = await backend.listen({ host: constants.DEFAULT_HOST, port });
      return backendInfo;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
      console.warn(`[main] 端口 ${port} 已被占用，尝试下一个端口`);
    }
  }
  throw lastError ?? new Error('无法启动后端服务');
}

/** 提醒 -> 系统通知。 */
function wireNotifications() {
  backend.hub.subscribe((message) => {
    if (message.type !== 'reminder') return;
    const { title, startTime, offsetMinutes, allDay } = message.payload ?? {};
    if (!Notification.isSupported()) return;
    const when = allDay ? '全天' : startTime ?? '';
    new Notification({
      title: '日程提醒',
      body: `${when} ${title}${offsetMinutes ? `（提前 ${offsetMinutes} 分钟）` : ''}`.trim(),
    }).show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    title: 'AI 智学 · 日历与待办（测试窗口）',
    backgroundColor: esm?.theme?.background?.base ?? '#1b1b1f',
    webPreferences: {
      preload: path.join(CURRENT_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(RENDERER_ENTRY);

  // 窗口生命周期全部留痕：窗口「一闪即逝」时，这几条能直接指出是加载失败、渲染崩溃还是被关闭
  mainWindow.webContents.on('did-finish-load', () => log('[main] 页面加载完成'));
  mainWindow.webContents.on('preload-error', (_event, file, error) => log(`[main] !! preload 出错 ${file}:`, error));
  mainWindow.on('unresponsive', () => log('[main] !! 窗口无响应'));
  mainWindow.on('closed', () => {
    log(`[main] 窗口已关闭（剩余窗口 ${BrowserWindow.getAllWindows().length} 个）`);
  });

  // 测试窗口里的外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * 让用户挑一个文件夹（系统原生对话框）。
 *
 * 为什么必须放在主进程：渲染层是浏览器环境，`<input type="file" webkitdirectory>`
 * 拿到的是**浏览器自己的沙箱路径**，后端（另一个进程）根本访问不了那个目录；
 * 而回放下载是**后端**写盘，所以路径只能由主进程用系统对话框问用户要。
 *
 * 返回 `{ canceled, path }`：`canceled` 为真时调用方不该改动现有设置。
 */
ipcMain.handle('potato:pickDirectory', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: typeof options?.title === 'string' && options.title ? options.title : '选择文件夹',
    // createDirectory：让用户能在对话框里直接新建目录（Windows / macOS 都支持）
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof options?.defaultPath === 'string' && options.defaultPath ? options.defaultPath : undefined,
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true, path: null };
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('potato:info', async () => {
  if (!esm) await loadEsm();
  return {
    appVersion: app.getVersion(),
    apiPrefix: esm.constants.API_PREFIX,
    wsPath: esm.constants.WS_PATH,
    baseUrl: backendInfo ? `http://${backendInfo.host}:${backendInfo.port}${esm.constants.API_PREFIX}` : null,
    wsUrl: backendInfo ? `ws://${backendInfo.host}:${backendInfo.port}${esm.constants.WS_PATH}` : null,
    dataDir: backend?.dataDir ?? null,
    theme: esm.theme,
  };
});

app.whenReady().then(async () => {
  log('[main] app ready，开始启动后端');
  try {
    const info = await startBackend();
    log(`[main] 后端已启动: ${info.baseUrl}（数据目录 ${backend.dataDir}）`);
    wireNotifications();
  } catch (error) {
    log('[main] 后端启动失败:', error);
    await loadEsm().catch((loadError) => log('[main] ESM 加载失败:', loadError));
  }
  createWindow();
  log('[main] 测试窗口已创建');
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => log(`[main] 页面加载失败 ${code} ${description}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  log(`[main] window-all-closed：窗口数=0，即将退出（窗口是否已销毁: ${mainWindow?.isDestroyed?.() ?? 'n/a'}）`);
  await backend?.close().catch(() => {});
  app.quit();
});

app.on('before-quit', async () => {
  log('[main] before-quit');
  await backend?.close().catch(() => {});
});

app.on('will-quit', () => {
  log('[main] will-quit，进程即将结束');
});
