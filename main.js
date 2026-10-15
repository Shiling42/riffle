const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { execFile } = require('child_process');

// one-time migration: annotations/prefs from the old app name (轻阅) to Riffle
try {
  const oldDir = path.join(app.getPath('appData'), '轻阅');
  const curDir = app.getPath('userData');
  if (!fss.existsSync(curDir) && fss.existsSync(oldDir)) fss.cpSync(oldDir, curDir, { recursive: true });
} catch {}

const wins = new Set();
let pendingPaths = []; // files opened (Finder / open-with) before app is ready

// i18n — follows the system language; resolved once the app is ready
const EN = {
  about: 'About Riffle', hide: 'Hide', quit: 'Quit', file: 'File',
  open: 'Open PDF…', newWin: 'New Window', closeWin: 'Close Window', edit: 'Edit',
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  selectAll: 'Select All', view: 'View', fullscreen: 'Full Screen',
  devtools: 'Developer Tools', window: 'Window', minimize: 'Minimize', zoom: 'Zoom',
  openTitle: 'Open PDF', openFail: 'Could not open file',
};
const ZH = {
  about: '关于 Riffle', hide: '隐藏', quit: '退出', file: '文件',
  open: '打开 PDF…', newWin: '新建窗口', closeWin: '关闭窗口', edit: '编辑',
  undo: '撤销', redo: '重做', cut: '剪切', copy: '拷贝', paste: '粘贴',
  selectAll: '全选', view: '视图', fullscreen: '全屏',
  devtools: '开发者工具', window: '窗口', minimize: '最小化', zoom: '缩放',
  openTitle: '打开 PDF', openFail: '无法打开文件',
};
let L = EN;

/* the user chose to open this file — clear the quarantine flag so Finder's
   "could not verify … is free of malware" prompt (shown for downloaded files
   handled by a non-notarized app) doesn't come back on the next double-click */
function dequarantine(p) {
  if (process.platform === 'darwin') {
    execFile('xattr', ['-d', 'com.apple.quarantine', p], () => {});
  }
}

async function sendPdf(win, filePath) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('pdf:incoming'); // suppress the empty state right away
    const data = await fs.readFile(filePath);
    win.webContents.send('pdf:open', { name: path.basename(filePath), data, path: filePath });
    win.docLoaded = true;
    dequarantine(filePath);
  } catch (err) {
    dialog.showErrorBox(L.openFail, String(err && err.message || err));
  }
}

/* each window is its own workspace: lowest free number, so the first window
   after a relaunch is workspace 1 again and finds its own desk */
function nextWorkspace() {
  const used = new Set([...wins].filter((w) => !w.isDestroyed()).map((w) => w.wsid));
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

function createWindow(filePath) {
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 460,
    minHeight: 380,
    titleBarStyle: 'hidden', // native traffic lights exist for fullscreen…
    backgroundColor: '#f7f6f3',
    title: 'Riffle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.wsid = nextWorkspace();
  wins.add(win);
  win.docLoaded = false;

  const query = { ws: String(win.wsid) };
  if (filePath) query.incoming = '1';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });

  win.webContents.on('did-finish-load', () => {
    if (filePath) sendPdf(win, filePath);
    win.docLoaded = !!filePath;
  });

  // …but stay hidden while windowed, where the hover-revealed HTML ones live.
  // In fullscreen the native ones take over and ride the sliding menu bar.
  if (win.setWindowButtonVisibility) win.setWindowButtonVisibility(false);
  win.on('enter-full-screen', () => {
    if (win.setWindowButtonVisibility) win.setWindowButtonVisibility(true);
    win.webContents.send('win:fullscreen', true);
  });
  win.on('leave-full-screen', () => {
    if (win.setWindowButtonVisibility) win.setWindowButtonVisibility(false);
    win.webContents.send('win:fullscreen', false);
  });
  win.on('closed', () => wins.delete(win));
  return win;
}

/* route a file: reuse an empty window, else join the focused window's shelf,
   else open a new window */
function openPath(filePath) {
  const p = path.resolve(filePath);
  const empty = [...wins].find((w) => !w.isDestroyed() && !w.docLoaded);
  if (empty) {
    empty.docLoaded = true;
    if (empty.webContents.isLoading()) {
      empty.webContents.once('did-finish-load', () => sendPdf(empty, p));
    } else {
      sendPdf(empty, p);
    }
    empty.focus();
    return;
  }
  const target = BrowserWindow.getFocusedWindow() ||
    [...wins].find((w) => !w.isDestroyed());
  if (target) {
    sendPdf(target, p);
    target.focus();
  } else {
    createWindow(p);
  }
}

async function openDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: L.openTitle,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (!canceled) filePaths.forEach(openPath);
}

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\/|^mailto:/i.test(String(url))) shell.openExternal(url);
});
ipcMain.on('open-path', (_e, p) => {
  if (typeof p === 'string' && p.toLowerCase().endsWith('.pdf')) openPath(p);
});
ipcMain.on('doc:loaded', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.docLoaded = true;
});
ipcMain.on('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.on('win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('win:fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setFullScreen(!w.isFullScreen());
});
ipcMain.on('pdf:request-open', () => openDialog());

// the renderer's document shelf reopens files on its own
ipcMain.handle('pdf:read', async (_e, p) => {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.pdf')) throw new Error('bad path');
  const data = await fs.readFile(p);
  dequarantine(p);
  return data;
});
ipcMain.on('win:new-with', (_e, p) => {
  if (typeof p === 'string' && p.toLowerCase().endsWith('.pdf')) createWindow(path.resolve(p));
  else createWindow();
});

// macOS: file double-clicked in Finder / dragged onto the Dock icon
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openPath(filePath);
  else pendingPaths.push(filePath);
});

app.whenReady().then(() => {
  if (app.getLocale().toLowerCase().startsWith('zh')) L = ZH;
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: L.about },
        { type: 'separator' },
        { role: 'hide', label: L.hide },
        { role: 'quit', label: L.quit },
      ],
    },
    {
      label: L.file,
      submenu: [
        { label: L.open, accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: L.newWin, accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { role: 'close', label: L.closeWin },
      ],
    },
    {
      label: L.edit,
      submenu: [
        { role: 'undo', label: L.undo },
        { role: 'redo', label: L.redo },
        { type: 'separator' },
        { role: 'cut', label: L.cut },
        { role: 'copy', label: L.copy },
        { role: 'paste', label: L.paste },
        { role: 'selectAll', label: L.selectAll },
      ],
    },
    {
      label: L.view,
      submenu: [
        { role: 'togglefullscreen', label: L.fullscreen },
        { role: 'toggleDevTools', label: L.devtools },
      ],
    },
    {
      label: L.window,
      submenu: [
        { role: 'minimize', label: L.minimize },
        { role: 'zoom', label: L.zoom },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // macOS: right-clicking the Dock icon offers a fresh workspace
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: L.newWin, click: () => createWindow() },
      { label: L.open, click: () => openDialog() },
    ]));
  }

  const cliPdf = process.argv
    .slice(app.isPackaged ? 1 : 2)
    .find((a) => a.toLowerCase().endsWith('.pdf'));
  const queued = [...pendingPaths];
  pendingPaths = [];
  if (queued.length) {
    queued.forEach(openPath);
  } else {
    createWindow(cliPdf ? path.resolve(cliPdf) : undefined);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS convention: the app stays running with no windows
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
