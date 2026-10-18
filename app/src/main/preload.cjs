/**
 * 预加载脚本（CommonJS，Electron 沙箱外的最小桥）。
 *
 * 只暴露三件事：
 * - getInfo(): 后端实际监听地址与主题令牌；
 * - onReminder(): 主进程侧的提醒回调（渲染层可自行选择用 WebSocket 或这里的推送）；
 * - pickDirectory(): 系统原生的「选择文件夹」对话框（回放下载目录用）。
 *   浏览器环境里没有它 —— 渲染层据此决定要不要显示「浏览…」按钮。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('potatoCalendar', {
  getInfo: () => ipcRenderer.invoke('potato:info'),
  onReminder: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('potato:reminder', listener);
    return () => ipcRenderer.removeListener('potato:reminder', listener);
  },
  /** 返回 `{ canceled, path }`；`canceled` 为真时调用方不该改动现有设置。 */
  pickDirectory: (options) => ipcRenderer.invoke('potato:pickDirectory', options),
  platform: process.platform,
});
