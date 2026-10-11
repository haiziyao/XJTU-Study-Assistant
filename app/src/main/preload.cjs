/**
 * 预加载脚本（CommonJS，Electron 沙箱外的最小桥）。
 *
 * 只暴露两件事：
 * - getInfo(): 后端实际监听地址与主题令牌；
 * - onReminder(): 主进程侧的提醒回调（渲染层可自行选择用 WebSocket 或这里的推送）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('potatoCalendar', {
  getInfo: () => ipcRenderer.invoke('potato:info'),
  onReminder: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('potato:reminder', listener);
    return () => ipcRenderer.removeListener('potato:reminder', listener);
  },
  platform: process.platform,
});
