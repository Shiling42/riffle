const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleFullscreen: () => ipcRenderer.send('win:fullscreen'),
  requestOpen: () => ipcRenderer.send('pdf:request-open'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openPath: (p) => ipcRenderer.send('open-path', p),
  readPdf: (p) => ipcRenderer.invoke('pdf:read', p),
  newWindow: (p) => ipcRenderer.send('win:new-with', p || null),
  docLoaded: () => ipcRenderer.send('doc:loaded'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onIncoming: (cb) => ipcRenderer.on('pdf:incoming', () => cb()),
  onOpen: (cb) => ipcRenderer.on('pdf:open', (_e, payload) => cb(payload)),
  onFullscreen: (cb) => ipcRenderer.on('win:fullscreen', (_e, v) => cb(v)),
});
