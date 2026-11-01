const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleFullscreen: () => ipcRenderer.send('win:fullscreen'),
  requestOpen: () => ipcRenderer.send('pdf:request-open'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openPath: (p, activate = true) => ipcRenderer.send('open-path', p, activate),
  syncTabs: (info) => ipcRenderer.send('tabs:sync', info),
  tabMenu: (info) => ipcRenderer.invoke('tab:menu', info),
  detachTab: (payload) => ipcRenderer.send('tab:detach', payload),
  dragTear: (info) => ipcRenderer.send('drag:tear', info),
  dragCarry: (info) => ipcRenderer.send('drag:carry', info),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: (cancel) => ipcRenderer.send('drag:end', !!cancel),
  onDrag: (cb) => ipcRenderer.on('drag', (_e, msg) => cb(msg)),
  onPeers: (cb) => ipcRenderer.on('win:peers', (_e, n) => cb(n)),
  reveal: (p) => ipcRenderer.send('reveal', p),
  print: (opts) => ipcRenderer.invoke('print', opts),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onIncoming: (cb) => ipcRenderer.on('pdf:incoming', () => cb()),
  onOpen: (cb) => ipcRenderer.on('pdf:open', (_e, payload) => cb(payload)),
  onOpenFailed: (cb) => ipcRenderer.on('pdf:failed', () => cb()),
  onCommand: (cb) => ipcRenderer.on('cmd', (_e, name, arg) => cb(name, arg)),
  onFullscreen: (cb) => ipcRenderer.on('win:fullscreen', (_e, v) => cb(v)),
});
