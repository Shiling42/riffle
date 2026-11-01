const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');

// one-time migration: annotations/prefs from the old app name (轻阅) to Riffle
try {
  const oldDir = path.join(app.getPath('appData'), '轻阅');
  const curDir = app.getPath('userData');
  if (!fss.existsSync(curDir) && fss.existsSync(oldDir)) fss.cpSync(oldDir, curDir, { recursive: true });
} catch {}

const wins = new Set();
const zOrder = [];      // windows front to back — focus order stands in for the stacking order
let lastFocused = null; // new documents land here as tabs, like a browser's frontmost window
let pendingPaths = []; // files opened (Finder / open-with) before app is ready

// i18n — follows the system language; resolved once the app is ready
const EN = {
  about: 'About Riffle', hide: 'Hide', quit: 'Quit', file: 'File',
  open: 'Open PDF…', newWin: 'New Window', closeWin: 'Close Window', edit: 'Edit',
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  selectAll: 'Select All', view: 'View', fullscreen: 'Full Screen',
  devtools: 'Developer Tools', window: 'Window', minimize: 'Minimize', zoom: 'Zoom',
  openTitle: 'Open PDF', openFail: 'Could not open file',
  print: 'Print…', closeTab: 'Close Tab', reopenTab: 'Reopen Closed Tab',
  nextTab: 'Show Next Tab', prevTab: 'Show Previous Tab',
  closeOthers: 'Close Other Tabs', closeRight: 'Close Tabs to the Right',
  moveToWin: 'Move Tab to New Window', reveal: 'Show in Finder',
};
const ZH = {
  about: '关于 Riffle', hide: '隐藏', quit: '退出', file: '文件',
  open: '打开 PDF…', newWin: '新建窗口', closeWin: '关闭窗口', edit: '编辑',
  undo: '撤销', redo: '重做', cut: '剪切', copy: '拷贝', paste: '粘贴',
  selectAll: '全选', view: '视图', fullscreen: '全屏',
  devtools: '开发者工具', window: '窗口', minimize: '最小化', zoom: '缩放',
  openTitle: '打开 PDF', openFail: '无法打开文件',
  print: '打印…', closeTab: '关闭标签页', reopenTab: '重新打开关闭的标签页',
  nextTab: '显示下一个标签页', prevTab: '显示上一个标签页',
  closeOthers: '关闭其他标签页', closeRight: '关闭右侧标签页',
  moveToWin: '将标签页移到新窗口', reveal: '在访达中显示',
};
let L = EN;

/* run fn once the window's page is ready to receive documents */
function whenLoaded(win, fn) {
  if (!win || win.isDestroyed()) return;
  if (win.ready) fn();
  else win.queue.push(fn);
}

async function sendPdf(win, filePath, activate = true, extra = {}) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('pdf:incoming'); // suppress the empty state right away
    const data = await fs.readFile(filePath);
    if (win.isDestroyed()) return;
    win.webContents.send('pdf:open', { name: path.basename(filePath), path: filePath, data, activate, ...extra });
  } catch (err) {
    if (!win.isDestroyed()) win.webContents.send('pdf:failed');
    dialog.showErrorBox(L.openFail, String(err && err.message || err));
  }
}

function raise(win) {
  const i = zOrder.indexOf(win);
  if (i >= 0) zOrder.splice(i, 1);
  zOrder.unshift(win);
}

/* every page learns how many other windows there are: a lone document shows its
   tab (on approach) only while there is another window it could be carried into */
function sendPeers() {
  for (const w of wins) {
    if (!w.isDestroyed() && w.ready) w.webContents.send('win:peers', wins.size - 1);
  }
}

function createWindow({ incoming = false, near = null, bounds = null, inactive = false } = {}) {
  const opts = {
    width: 1180,
    height: 840,
    minWidth: 460,
    minHeight: 380,
    frame: false,
    show: !inactive,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#f7f6f3',
    title: 'Riffle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  };
  if (bounds) Object.assign(opts, bounds);
  else if (near && !near.isDestroyed()) {
    const [x, y] = near.getPosition();
    opts.x = x + 28;
    opts.y = y + 28;
  }
  const win = new BrowserWindow(opts);
  wins.add(win);
  raise(win);
  win.paths = new Set(); // documents open in this window's tabs — kept in sync by the renderer
  win.ready = false;
  win.queue = [];
  win.chain = Promise.resolve(); // deliveries in order, so tabs line up as the files were chosen
  // a window born mid-drag must not take the keyboard (Esc) from the page carrying it
  if (inactive) win.showInactive();
  else lastFocused = win;

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), incoming ? { query: { incoming: '1' } } : undefined);

  win.webContents.on('did-finish-load', () => {
    win.ready = true;
    win.queue.splice(0).forEach((fn) => fn());
    sendPeers();
  });
  win.on('focus', () => { lastFocused = win; raise(win); });
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen', false));
  win.on('closed', () => {
    wins.delete(win);
    const z = zOrder.indexOf(win);
    if (z >= 0) zOrder.splice(z, 1);
    if (lastFocused === win) lastFocused = null;
    if (drag && drag.src === win) finishDrag(false);
    sendPeers();
  });
  sendPeers();
  return win;
}

function frontWindow() {
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  return [...wins].find((w) => !w.isDestroyed()) || null;
}

function sendCmd(win, name, arg) {
  if (win && !win.isDestroyed()) whenLoaded(win, () => win.webContents.send('cmd', name, arg));
}

/* route a file: an already-open document comes forward; anything else opens
   as a new tab in the given (or frontmost) window */
function openPath(filePath, { win = null, activate = true } = {}) {
  const p = path.resolve(filePath);
  for (const w of wins) {
    if (!w.isDestroyed() && w.paths.has(p)) {
      sendCmd(w, 'tab-activate-path', p);
      if (w.isMinimized()) w.restore();
      w.focus();
      return;
    }
  }
  let target = win && !win.isDestroyed() ? win : frontWindow();
  if (!target) target = createWindow({ incoming: true });
  target.paths.add(p); // optimistic — the renderer's tab list confirms it
  whenLoaded(target, () => { target.chain = target.chain.then(() => sendPdf(target, p, activate)); });
  if (target.isMinimized()) target.restore();
  target.focus();
}

async function openDialog(win) {
  const parent = win && !win.isDestroyed() ? win : null;
  const opts = {
    title: L.openTitle,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  };
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (canceled) return;
  // the first file comes to the front; the rest wait in their tabs
  filePaths.forEach((p, i) => openPath(p, { win: parent, activate: i === 0 }));
}

const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\/|^mailto:/i.test(String(url))) shell.openExternal(url);
});
ipcMain.on('open-path', (e, p, activate = true) => {
  if (typeof p === 'string' && p.toLowerCase().endsWith('.pdf')) {
    openPath(p, { win: senderWin(e), activate: activate !== false });
  }
});
ipcMain.on('tabs:sync', (e, info) => {
  const w = senderWin(e);
  if (w && info && Array.isArray(info.paths)) w.paths = new Set(info.paths.map((p) => path.resolve(p)));
});
ipcMain.on('win:close', (e) => { const w = senderWin(e); if (w) w.close(); });
ipcMain.on('win:minimize', (e) => { const w = senderWin(e); if (w) w.minimize(); });
ipcMain.on('win:fullscreen', (e) => {
  const w = senderWin(e);
  if (w) w.setFullScreen(!w.isFullScreen());
});
ipcMain.on('pdf:request-open', (e) => openDialog(senderWin(e)));
ipcMain.on('reveal', (e, p) => {
  const w = senderWin(e); // only documents open in this window's tabs
  if (w && typeof p === 'string' && w.paths.has(path.resolve(p))) shell.showItemInFolder(p);
});

/* right-click on a tab — a native menu; resolves with the chosen action */
ipcMain.handle('tab:menu', (e, info = {}) => new Promise((resolve) => {
  const pick = (action) => () => resolve(action);
  const items = [
    { label: L.closeTab, click: pick('close') },
    { label: L.closeOthers, enabled: info.count > 1, click: pick('close-others') },
    { label: L.closeRight, enabled: info.index < info.count - 1, click: pick('close-right') },
    { type: 'separator' },
    { label: L.moveToWin, enabled: info.count > 1, click: pick('new-window') },
  ];
  if (info.hasPath) items.push({ type: 'separator' }, { label: L.reveal, click: pick('reveal') });
  Menu.buildFromTemplate(items).popup({
    window: senderWin(e),
    callback: () => setTimeout(() => resolve(null), 100), // dismissed without a choice
  });
}));

/* what a page hands over when a tab leaves it: a path (or, for a document that
   has none, its bytes), where the reader was, and where the cursor held the tab */
function carriedDoc(info = {}) {
  const doc = { name: String(info.name || 'document.pdf'), path: null, data: null, view: info.view || null };
  if (typeof info.path === 'string' && info.path.toLowerCase().endsWith('.pdf')) doc.path = path.resolve(info.path);
  else if (ArrayBuffer.isView(info.data)) doc.data = info.data;
  else return null;
  const off = info.off || {};
  const lim = (v, m) => (Number.isFinite(v) ? Math.max(-m, Math.min(m, v)) : 0);
  doc.off = { x: lim(off.x, 90), y: lim(off.y, 14) };
  return doc;
}

/* hand a document to a window: a new tab, or (land) the slot its strip holds open */
function deliver(win, doc, extra = {}) {
  if (doc.path) win.paths.add(doc.path);
  whenLoaded(win, () => {
    win.chain = win.chain.then(() => {
      if (doc.path) return sendPdf(win, doc.path, true, { view: doc.view, ...extra });
      if (!win.isDestroyed()) {
        win.webContents.send('pdf:open', { name: doc.name, data: doc.data, activate: true, view: doc.view, ...extra });
      }
    });
  });
}

/* a tab moved to a new window from its menu */
ipcMain.on('tab:detach', (e, payload) => {
  const src = senderWin(e);
  const doc = carriedDoc(payload);
  if (!doc) return;
  if (src && doc.path) src.paths.delete(doc.path);
  deliver(createWindow({ incoming: true, near: src }), doc);
});

/* ---------- tabs carried between windows ----------
   Pull a tab out of its strip and it becomes a window under the cursor; carry a
   window by its only tab onto another window's strip and it lands there as a tab.
   The page that saw the press keeps the pointer through the whole gesture and
   reports each move. Main moves the carried window from the real cursor position
   (a page's own screen coordinates lag a window that moves under it) and finds
   the strip below. The top-edge drag strip stays a native window drag — the
   system never says when that one ends, so it can't drop anywhere. */
let drag = null; // { src, mover, torn, grab, doc, target, origin }

const cursor = () => require('electron').screen.getCursorScreenPoint(); // usable once the app is ready
// window coordinates must be plain integers: a press point has fractions, and
// Math.round(-0.3) is -0, which setPosition refuses (a window crossing the screen's edge)
const px = (v) => Math.round(v) || 0;
const alive = (w) => !!w && !w.isDestroyed();
const tell = (w, type) => { if (alive(w)) w.webContents.send('drag', { type }); };
const fromCarrier = (e) => drag && alive(drag.src) && e.sender === drag.src.webContents;

/* the window whose strip lies under p — the topmost, unless one of ours covers it */
function stripAt(p) {
  for (const w of zOrder) {
    if (w === drag.mover || !alive(w) || !w.ready || !w.isVisible() || w.isMinimized() || w.isFullScreen()) continue;
    const b = w.getBounds();
    if (p.x < b.x || p.x >= b.x + b.width) continue;
    const stick = w === drag.target ? 14 : 0; // a strip that has the tab holds on a little longer
    if (p.y >= b.y - 10 - stick && p.y < b.y + 50 + stick) return w;
    if (p.y >= b.y && p.y < b.y + b.height) return null;
  }
  return null;
}

function fade(win, to) {
  clearInterval(win.fadeTimer);
  const from = win.getOpacity();
  let i = 0;
  win.fadeTimer = setInterval(() => {
    i += 1;
    if (!alive(win)) { clearInterval(win.fadeTimer); return; }
    win.setOpacity(from + ((to - from) * i) / 6);
    if (i === 6) clearInterval(win.fadeTimer);
  }, 16);
}

/* over a strip, the carried window steps aside and the strip opens a slot */
function hover(p) {
  const t = stripAt(p);
  if (t !== drag.target) {
    tell(drag.target, 'leave');
    drag.target = t;
    if (alive(drag.mover)) fade(drag.mover, t ? 0 : 1);
  }
  if (t) {
    const b = t.getContentBounds();
    t.webContents.send('drag', { type: 'over', x: p.x - b.x, y: p.y - b.y, name: drag.doc.name, off: drag.doc.off });
  }
}

ipcMain.on('drag:tear', (e, info) => {
  const src = senderWin(e);
  if (!src) return;
  if (drag) finishDrag(true);
  const doc = carriedDoc(info);
  if (!doc || src.isFullScreen()) { tell(src, 'restore'); return; }
  const [w, h] = src.getSize();
  // the new window comes up with its own tab under the cursor (top centre, see #tabStrip)
  const grab = { x: w / 2 - 16 + doc.off.x, y: 27 + doc.off.y };
  const p = cursor();
  const mover = createWindow({
    incoming: true,
    inactive: true,
    bounds: { x: px(p.x - grab.x), y: px(p.y - grab.y), width: w, height: h },
  });
  drag = { src, mover, torn: true, grab, doc, target: null };
  whenLoaded(mover, () => mover.webContents.send('drag', { type: 'held' }));
  deliver(mover, doc);
  hover(p);
});

ipcMain.on('drag:carry', (e, info) => {
  const src = senderWin(e);
  if (!src) return;
  if (drag) finishDrag(true);
  const doc = carriedDoc(info);
  if (!doc || src.isFullScreen()) return;
  const [x, y] = src.getPosition();
  // held where the press landed — the cursor may have moved on by the time this arrives
  const g = (info && info.grab) || {};
  const p = cursor();
  const grab = Number.isFinite(g.x) && Number.isFinite(g.y) ? { x: g.x, y: g.y } : { x: p.x - x, y: p.y - y };
  drag = { src, mover: src, torn: false, grab, doc, target: null, origin: [x, y] };
});

ipcMain.on('drag:move', (e) => {
  if (!fromCarrier(e)) return;
  const p = cursor();
  if (alive(drag.mover)) drag.mover.setPosition(px(p.x - drag.grab.x), px(p.y - drag.grab.y));
  hover(p);
});

ipcMain.on('drag:end', (e, cancel) => {
  if (fromCarrier(e)) finishDrag(!!cancel);
});

function finishDrag(cancel) {
  const d = drag;
  drag = null;
  const target = alive(d.target) ? d.target : null;
  const settle = (w) => { if (alive(w)) { clearInterval(w.fadeTimer); w.setOpacity(1); } };

  if (cancel) { // Esc: everything goes back where it was
    tell(target, 'leave');
    if (d.torn) {
      if (alive(d.mover)) d.mover.destroy();
      tell(d.src, 'restore');
    } else if (alive(d.src)) {
      settle(d.src);
      d.src.setPosition(...d.origin);
    }
    return;
  }

  if (target && target === d.src) { // pulled out, then put back
    tell(d.src, 'return');
    if (alive(d.mover)) d.mover.destroy();
    return;
  }

  if (target) { // lands in another window's strip
    deliver(target, d.doc, { land: true });
    if (d.torn) {
      if (alive(d.mover)) d.mover.destroy();
      tell(d.src, 'gone');
    } else if (alive(d.src)) {
      d.src.close(); // its only document lives over there now
    }
    target.focus();
    return;
  }

  // set down anywhere else: the window stays where it was carried
  settle(d.mover);
  if (d.torn) {
    tell(d.src, 'gone');
    if (alive(d.mover)) {
      whenLoaded(d.mover, () => tell(d.mover, 'free'));
      d.mover.focus();
    }
  }
}

/* print the prepared pages through the system dialog — fitted to the printer's
   printable area (like Chrome's PDF viewer), so nothing is clipped at the edges */
ipcMain.handle('print', (e, opts = {}) => new Promise((resolve) => {
  e.sender.print({
    silent: false,
    printBackground: true,
    margins: { marginType: 'printableArea' },
    landscape: !!opts.landscape,
  }, (success, failureReason) => resolve({ success, reason: failureReason || '' }));
}));

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
        { label: L.open, accelerator: 'CmdOrCtrl+O', click: (_i, w) => openDialog(w) },
        { label: L.newWin, accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: L.reopenTab, accelerator: 'Shift+CmdOrCtrl+T', click: (_i, w) => sendCmd(w || frontWindow(), 'tab-reopen') },
        { type: 'separator' },
        { label: L.print, accelerator: 'CmdOrCtrl+P', click: (_i, w) => sendCmd(w, 'print') },
        { type: 'separator' },
        { label: L.closeTab, accelerator: 'CmdOrCtrl+W', click: (_i, w) => sendCmd(w, 'tab-close') },
        { role: 'close', label: L.closeWin, accelerator: 'Shift+CmdOrCtrl+W' },
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
        { type: 'separator' },
        { label: L.nextTab, accelerator: 'Ctrl+Tab', click: (_i, w) => sendCmd(w, 'tab-step', 1) },
        { label: L.prevTab, accelerator: 'Ctrl+Shift+Tab', click: (_i, w) => sendCmd(w, 'tab-step', -1) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  const cliPdfs = process.argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => a.toLowerCase().endsWith('.pdf'));
  const queued = [...pendingPaths, ...cliPdfs];
  pendingPaths = [];
  if (queued.length) {
    queued.forEach((p, i) => openPath(p, { activate: i === 0 }));
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS convention: the app stays running with no windows
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
