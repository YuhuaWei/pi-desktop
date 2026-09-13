// preload: 暴露文件路径获取 + 窗口控制
const { contextBridge, webUtils, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('piFile', {
  getPath: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return null; }
  },
});
contextBridge.exposeInMainWorld('piWin', {
  minimize: () => ipcRenderer.send('win-control', 'min'),
  maximize: () => ipcRenderer.send('win-control', 'max'),
  close: () => ipcRenderer.send('win-control', 'close'),
});
