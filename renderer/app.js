/* 轻阅 · renderer */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.js', location.href).href;

/* Chinese (and Japanese/Korean) papers often use CID fonts that aren't embedded —
   STSong-Light, SimSun… pdf.js needs its character maps to turn their codes into
   glyphs; without them every CJK character renders blank and the text layer is empty.
   The standard font data covers non-embedded Base-14 fonts the same way. */
const PDF_OPTS = {
  cMapUrl: new URL('../node_modules/pdfjs-dist/cmaps/', location.href).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', location.href).href,
};

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller');
const pagesEl = $('#pages');
const body = document.body;

const state = {
  doc: null,
  name: '',
  fp: '',                 // document fingerprint, keys persistence
  mode: 1,                // 1 | 2 | 3 columns, or 'h' — horizontal filmstrip
  zoom: 1,
  layoutEpoch: 0,
  tool: 'cursor',         // cursor | highlight | note
  color: '#FFDE5C',
  annots: { highlights: [], notes: [] },
  pageSizes: [],          // [{w,h}] at pdf scale 1
  shells: [],             // page container elements
  recs: [],               // per-page render state {canvas, renderedW, task, textW}
  active: new Set(),      // page numbers near the viewport
  colW: 0,
  currentPage: 1,
  trim: false,            // auto-trim white margins
  crops: [],              // per-page content box {x,y,w,h} normalized, null = unknown
};

body.classList.add('no-doc');
if (new URLSearchParams(location.search).has('incoming')) body.classList.add('loading');

const MODES = [1, 2, 3, 'h'];
const ZMIN = 0.25, ZMAX = 5;

/* ---------------- i18n — follows the system language ---------------- */

const ZH = (navigator.language || 'en').toLowerCase().startsWith('zh');
const T = ZH ? {
  openPdf: '打开 PDF…', viewMode: '浏览模式', zoom: '缩放', trim: '裁剪白边',
  fitW: '适应宽度', fitH: '适应高度',
  modes: ['单栏', '双栏', '三栏', '横向 · 无缝'],
  toc: '目录', tocKey: '目录 (T)', tocEmpty: '此文档没有内嵌目录',
  dropHere: '将 PDF 拖到这里', orPress: '或按 <kbd>⌘O</kbd> 打开文件', choose: '选择文件',
  read: '阅读 (V)', highlight: '高亮 (H)', note: '批注 (N)',
  delHl: '删除高亮', delNote: '删除批注', notePh: '写点什么…', noteTitle: '批注',
  gotoPage: '跳转页面', zoomIn: '放大', zoomOut: '缩小',
  close: '关闭', minimize: '最小化', fullscreen: '全屏', menu: '菜单',
  openFail: '无法打开文件：',
  opening: '正在打开…',
  findPh: '在文档中查找', findPrev: '上一个 (⇧↩)', findNext: '下一个 (↩)',
  findMore: (n) => `还有 ${n} 处未列出`,
  lpPage: (n) => `第 ${n} 页`, pwProtected: '受密码保护的 PDF 暂不支持',
  newTab: '在新标签页中打开 (⌘T)', closeTab: '关闭标签页 (⌘W)',
  tabPage: (p, n) => `第 ${p} 页 · 共 ${n} 页`,
  print: '打印…', printTitle: '打印', pages: '页面',
  rangeAll: '全部', rangeCurrent: '当前页', rangeCustom: '范围', rangePh: '如 1-5, 8, 11-',
  printAnnots: '高亮与批注', printTrim: '裁剪白边', printTrimSub: '放大正文，更易阅读',
  cancel: '取消', printGo: '打印…',
  pageCount: (n) => `共 ${n} 页`, plusNotes: ' + 批注页', badRange: '页码范围无效',
  preparing: (i, n) => `正在准备 ${i} / ${n}…`, notesTitle: '批注', printFail: '打印失败：',
} : {
  openPdf: 'Open PDF…', viewMode: 'VIEW', zoom: 'Zoom', trim: 'Trim margins',
  fitW: 'Fit width', fitH: 'Fit height',
  modes: ['Single column', 'Two columns', 'Three columns', 'Horizontal · seamless'],
  toc: 'CONTENTS', tocKey: 'Contents (T)', tocEmpty: 'No outline in this document',
  dropHere: 'Drop a PDF here', orPress: 'or press <kbd>⌘O</kbd> to open', choose: 'Choose file',
  read: 'Read (V)', highlight: 'Highlight (H)', note: 'Note (N)',
  delHl: 'Delete highlight', delNote: 'Delete note', notePh: 'Write something…', noteTitle: 'Note',
  gotoPage: 'Go to page', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
  close: 'Close', minimize: 'Minimize', fullscreen: 'Full screen', menu: 'Menu',
  openFail: 'Could not open file: ',
  opening: 'Opening…',
  findPh: 'Find in document', findPrev: 'Previous (⇧↩)', findNext: 'Next (↩)',
  findMore: (n) => `${n} more not listed`,
  lpPage: (n) => `p. ${n}`, pwProtected: 'Password-protected PDFs are not supported yet',
  newTab: 'Open PDF in new tab (⌘T)', closeTab: 'Close tab (⌘W)',
  tabPage: (p, n) => `Page ${p} of ${n}`,
  print: 'Print…', printTitle: 'Print', pages: 'Pages',
  rangeAll: 'All', rangeCurrent: 'Current', rangeCustom: 'Range', rangePh: 'e.g. 1-5, 8, 11-',
  printAnnots: 'Highlights & notes', printTrim: 'Trim margins', printTrimSub: 'Larger text on paper',
  cancel: 'Cancel', printGo: 'Print…',
  pageCount: (n) => (n === 1 ? '1 page' : `${n} pages`), plusNotes: ' + notes', badRange: 'Invalid page range',
  preparing: (i, n) => `Preparing ${i} of ${n}…`, notesTitle: 'Notes', printFail: 'Could not print: ',
};

function applyI18n() {
  $('#menuOpen span').textContent = T.openPdf;
  $('.menu-label').textContent = T.viewMode;
  document.querySelectorAll('#modeSeg button').forEach((b, i) => { b.title = T.modes[i]; });
  $('.menu-row.static > span').textContent = T.zoom;
  $('#zoomIn').title = T.zoomIn;
  $('#zoomOut').title = T.zoomOut;
  $('#fitW').title = T.fitW;
  $('#fitH').title = T.fitH;
  $('#menuTrim span').textContent = T.trim;
  $('#tocHandle').title = T.tocKey;
  $('#toc header').textContent = T.toc;
  $('#empty p').textContent = T.dropHere;
  $('#empty .sub').innerHTML = T.orPress;
  $('#emptyOpen').textContent = T.choose;
  const toolTitles = { cursor: T.read, highlight: T.highlight, note: T.note };
  document.querySelectorAll('#toolbar .tool').forEach((b) => { b.title = toolTitles[b.dataset.tool]; });
  $('#hlDelete').title = T.delHl;
  $('#noteDelete').title = T.delNote;
  $('#noteText').placeholder = T.notePh;
  $('#pageIndicator').title = T.gotoPage;
  $('#btnClose').title = T.close;
  $('#btnMin').title = T.minimize;
  $('#btnFull').title = T.fullscreen;
  $('#menuBtn').title = T.menu;
  $('#loadingHint').textContent = T.opening;
  $('#findInput').placeholder = T.findPh;
  $('#findPrev').title = T.findPrev;
  $('#findNext').title = T.findNext;
  $('#findClose').title = T.close;
  $('#tabNew').title = T.newTab;
  $('#menuPrint span').textContent = T.print;
  $('#psTitle').textContent = T.printTitle;
  $('#psPagesLabel').textContent = T.pages;
  const rangeLabels = { all: T.rangeAll, current: T.rangeCurrent, custom: T.rangeCustom };
  document.querySelectorAll('#psRange button').forEach((b) => { b.textContent = rangeLabels[b.dataset.range]; });
  $('#psCustom').placeholder = T.rangePh;
  $('#psAnnots span').textContent = T.printAnnots;
  $('#psTrim span').firstChild.textContent = T.printTrim;
  $('#psTrim small').textContent = T.printTrimSub;
  $('#psCancel').textContent = T.cancel;
  $('#psGo').textContent = T.printGo;
}
applyI18n();
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/* ---------------- undo / redo (annotation actions, ⌘Z / ⇧⌘Z) ---------------- */

const undoStack = [];
const redoStack = [];

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function doUndo() {
  const e = undoStack.pop();
  if (!e) return;
  e.undo();
  redoStack.push(e);
}

function doRedo() {
  const e = redoStack.pop();
  if (!e) return;
  e.redo();
  undoStack.push(e);
}

/* ---------------- persistence ---------------- */

/* debounced per key, so each document's writes stay its own even when tabs
   switch mid-debounce; flushPersist() writes everything pending right away */
const persistTimers = new Map(); // key -> { timer, value }

function persist(key, value) {
  const prev = persistTimers.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    persistTimers.delete(key);
    writeStore(key, value());
  }, 300);
  persistTimers.set(key, { timer, value });
}

function writeStore(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

function flushPersist() {
  for (const [key, { timer, value }] of persistTimers) {
    clearTimeout(timer);
    writeStore(key, value());
  }
  persistTimers.clear();
}
window.addEventListener('beforeunload', flushPersist);

function saveAnnots() {
  const annots = state.annots;
  if (state.fp) persist(`qy:annots:${state.fp}`, () => annots);
}

function savePrefs() {
  const v = { mode: state.mode, zoom: state.zoom, page: state.currentPage, trim: state.trim };
  if (state.fp) persist(`qy:prefs:${state.fp}`, () => v);
}

/* a freshly opened document's remembered annotations, trim boxes and view */
function loadPersisted(tab) {
  const read = (kind) => {
    try { return JSON.parse(localStorage.getItem(`qy:${kind}:${tab.fp}`)); } catch { return null; }
  };
  const a = read('annots');
  tab.annots = {
    highlights: (a && Array.isArray(a.highlights)) ? a.highlights : [],
    // sweep out empty notes a crashed/quit session may have left behind
    notes: ((a && Array.isArray(a.notes)) ? a.notes : []).filter((n) => n.text && n.text.trim()),
  };
  const c = read('crops');
  tab.crops = Array.isArray(c) ? c : [];
  const p = read('prefs');
  const n = tab.doc.numPages;
  tab.view = {
    // never seen before: keep the layout you are reading in now
    mode: p && MODES.includes(p.mode) ? p.mode : state.mode,
    zoom: clamp((p && p.zoom) || state.zoom || 1, ZMIN, ZMAX),
    trim: !!(p && p.trim),
    page: p && p.page > 1 && p.page <= n ? p.page : 1,
    anchor: null,
  };
}

/* a document carried in from another window keeps the exact place it was read at */
function carryView(tab, v) {
  const n = tab.doc.numPages;
  const page = (p) => Number.isInteger(p) && p >= 1 && p <= n;
  if (MODES.includes(v.mode)) tab.view.mode = v.mode;
  if (Number.isFinite(v.zoom)) tab.view.zoom = clamp(v.zoom, ZMIN, ZMAX);
  if (typeof v.trim === 'boolean') tab.view.trim = v.trim;
  if (page(v.page)) tab.view.page = v.page;
  const a = v.anchor;
  if (a && page(a.page) && Number.isFinite(a.f)) {
    tab.view.anchor = { page: a.page, f: a.f, cross: Number.isFinite(a.cross) ? a.cross : 0 };
  }
}

/* ---------------- document loading ---------------- */

const progressEl = $('#progress');
let openQueue = Promise.resolve();

/* every document opens as a tab: it takes its place in the strip at once (at a
   given slot, for one carried in from another window) and loads in its turn,
   one at a time, in arrival order */
function openPdf(data, name, path = null, activate = true, { at = null, view = null } = {}) {
  const dup = path && tabs.find((t) => t.path === path);
  if (dup) { // already open here — just bring it forward
    if (activate) { activateTab(dup); flashTabs(); }
    if (!tabs.some((t) => t.loading)) body.classList.remove('loading');
    return dup;
  }
  const tab = newTab(name, path);
  tabs.splice(at == null ? tabs.length : clamp(at, 0, tabs.length), 0, tab);
  renderTabs();
  flashTabs(1600); // a new arrival announces itself (no-op while it is the only tab)
  openQueue = openQueue.then(() => loadTab(tab, data, activate, view)).catch(() => {});
  return tab;
}

async function loadTab(tab, data, activate, view) {
  if (tab.closed) return; // closed while it waited its turn
  body.classList.add('loading');
  progressEl.style.transform = 'scaleX(0.05)';

  try {
    const task = pdfjsLib.getDocument({ data, ...PDF_OPTS });
    tab.task = task;
    task.onProgress = ({ loaded, total }) => {
      if (total) progressEl.style.transform = `scaleX(${clamp(loaded / total, 0.05, 1)})`;
    };
    const doc = await task.promise;
    tab.task = null;
    tab.doc = doc;
    tab.fp = (doc.fingerprints && doc.fingerprints[0]) || 'unknown';

    // the very same document under another name — keep a single tab
    const twin = tabs.find((t) => t !== tab && !t.loading && t.fp === tab.fp);
    if (twin) {
      dropTab(tab);
      if (activate) { activateTab(twin); flashTabs(); }
      return;
    }

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (tab.closed) return;
      const vp = page.getViewport({ scale: 1 });
      tab.pageSizes.push({ w: vp.width, h: vp.height });
      if (i === 1 || i % 20 === 0) {
        progressEl.style.transform = `scaleX(${0.7 + 0.3 * (i / doc.numPages)})`;
      }
    }
    loadPersisted(tab);
    if (view) carryView(tab, view);
    tab.loading = false;
    if (activate || !activeTab) activateTab(tab);
    else { renderTabs(); syncTabs(); }
  } catch (err) {
    if (tab.closed) return; // closed while it was still opening
    console.error('open failed:', err);
    dropTab(tab);
    if (err && err.name === 'PasswordException') alertToast(T.pwProtected);
    else alertToast(T.openFail + (err && err.message || err));
  } finally {
    progressEl.style.transform = 'scaleX(1)';
    if (!tabs.some((t) => t.loading)) body.classList.remove('loading');
    setTimeout(() => { progressEl.style.transform = 'scaleX(0)'; }, 600);
  }
}

/* forget a tab that never finished opening */
function dropTab(tab) {
  tab.closed = true;
  const i = tabs.indexOf(tab);
  if (i >= 0) tabs.splice(i, 1);
  if (tab.doc) tab.doc.destroy().catch(() => {});
  renderTabs();
  syncTabs();
}

/* ---------------- tabs — many documents, one window ---------------- */
/* Every document opens as a tab instead of a new window. The strip stays out of
   sight while you read and slides in only when the cursor comes near it (or for a
   moment after a switch from the keyboard). Each tab keeps its whole reading
   state — view, position, undo history, search index — so switching is instant. */

const tabs = [];
let activeTab = null;
const closedTabs = [];       // paths, most recent last — ⇧⌘T brings them back
const tabStrip = $('#tabStrip');
const tabList = $('#tabList');
const tabEls = new Map();    // tab id → element, reused so a drag survives re-renders
let dragTab = null;          // the tab being dragged to a new place
let plucked = null;          // { tab, index } — pulled out of the strip, on its way to another window
let landing = null;          // { el, index, off } — the slot held open for a tab carried in
let peers = 0;               // other Riffle windows
const listPad = parseFloat(getComputedStyle(tabList).paddingLeft) || 0; // room for shadows, not for tabs

/* the strip is there (on approach) once a second document is open — here, or in
   another window this window's tab could be carried into */
const stripOn = () => tabs.length + (plucked ? 1 : 0) > 1 || (tabs.length > 0 && peers > 0);

function newTab(name, path) {
  return {
    id: uid(), name: name || 'document.pdf', path: path || null,
    doc: null, task: null, fp: '', pageSizes: [], loading: true, closed: false,
    view: null, annots: null, crops: null,
    undo: [], redo: [], pageTexts: [], scrubHistory: [], tocNodes: null, marks: null,
    thumb: null, cleanupTimer: null,
  };
}

const tabTitle = (t) => t.name.replace(/\.pdf$/i, '');
const tabById = (id) => tabs.find((t) => t.id === id);

function activateTab(tab) {
  if (!tab || tab.loading || tab.closed) return;
  if (tab !== activeTab) {
    closePrint();
    if (activeTab) stashTab(activeTab);
    activeTab = tab;
    clearTimeout(tab.cleanupTimer);
    showTab(tab);
  }
  renderTabs();
  syncTabs();
}

/* park the outgoing document, remembering exactly where the reader was */
function stashTab(t) {
  closeAllPopovers(); // also commits an open note edit to the undo history
  closeFind();
  flushPersist();
  t.view = currentView();
  t.undo = undoStack.splice(0);
  t.redo = redoStack.splice(0);
  t.pageTexts = pageTexts;
  t.scrubHistory = scrub.history || [];
  t.thumb = null; // the hover card re-renders where you left off
  sweepToken++;
  // a parked document gives back the worker's page caches after a while
  clearTimeout(t.cleanupTimer);
  t.cleanupTimer = setTimeout(() => {
    if (t !== activeTab && t.doc) t.doc.cleanup().catch(() => {});
  }, 30000);
}

function showTab(t) {
  state.doc = t.doc;
  state.name = t.name;
  state.fp = t.fp;
  state.pageSizes = t.pageSizes;
  state.mode = t.view.mode;
  state.zoom = t.view.zoom;
  state.trim = t.view.trim;
  state.annots = t.annots;
  state.crops = t.crops;
  state.currentPage = t.view.page;
  undoStack.push(...t.undo);
  redoStack.push(...t.redo);
  t.undo = [];
  t.redo = [];

  $('#fileLabel').textContent = tabTitle(t);
  document.title = tabTitle(t) + ' — Riffle';
  body.classList.remove('no-doc');

  resetFind();
  pageTexts = t.pageTexts; // text index survives the round trip
  resetScrub(t.scrubHistory);
  buildShells();
  syncModeUI();
  syncZoomUI();
  syncTrimUI();
  layout();
  buildToc();
  if (state.trim) sweepCrops();

  if (t.view.anchor) restoreAnchor(t.view.anchor);
  else if (t.view.page > 1) scrollToPage(t.view.page, false);
  else { scroller.scrollTop = 0; scroller.scrollLeft = 0; }
  updateIndicator();
}

const currentView = () => ({
  mode: state.mode, zoom: state.zoom, trim: state.trim, page: state.currentPage, anchor: viewAnchor(),
});

/* reading position as page + fraction — survives a resized window */
function viewAnchor() {
  const el = state.shells[state.currentPage - 1];
  if (!el) return null;
  if (state.mode === 'h') {
    return { page: state.currentPage, f: (scroller.scrollLeft - el.offsetLeft) / el.offsetWidth, cross: scroller.scrollTop };
  }
  return { page: state.currentPage, f: (scroller.scrollTop - el.offsetTop) / el.offsetHeight, cross: scroller.scrollLeft };
}

function restoreAnchor(a) {
  const el = state.shells[a.page - 1];
  if (!el) return;
  if (state.mode === 'h') {
    scroller.scrollLeft = el.offsetLeft + a.f * el.offsetWidth;
    scroller.scrollTop = a.cross || 0;
  } else {
    scroller.scrollTop = el.offsetTop + a.f * el.offsetHeight;
    scroller.scrollLeft = a.cross || 0;
  }
}

function closeTab(tab, { remember = true } = {}) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.closed = true;
  hideTabCard();
  const wasActive = tab === activeTab;
  if (wasActive) {
    closePrint();
    closeAllPopovers();
    closeFind();
    flushPersist();
    undoStack.length = 0;
    redoStack.length = 0;
    activeTab = null;
  }
  tabs.splice(i, 1);
  if (remember && tab.path && !tab.loading) {
    closedTabs.push(tab.path);
    if (closedTabs.length > 30) closedTabs.shift();
  }
  if (wasActive) {
    // like a browser: the neighbour on the right steps in, else the one on the left
    const next = tabs.slice(i).find((t) => !t.loading) ||
                 tabs.slice(0, i).reverse().find((t) => !t.loading);
    if (next) activateTab(next);
    else if (tabs.length) clearView(); // only documents still opening are left
    else { native.close(); return; }   // the last tab takes the window with it
  }
  clearTimeout(tab.cleanupTimer);
  if (tab.task) tab.task.destroy();
  else if (tab.doc) tab.doc.destroy().catch(() => {});
  renderTabs();
  syncTabs();
}

/* nothing readable left on screen (a tab is still opening) */
function clearView() {
  if (renderIO) renderIO.disconnect();
  if (releaseIO) releaseIO.disconnect();
  for (const r of state.recs) if (r.task) { try { r.task.cancel(); } catch {} }
  pagesEl.innerHTML = '';
  state.shells = [];
  state.recs = [];
  state.active.clear();
  state.doc = null;
  state.fp = '';
  state.name = '';
  $('#tocList').innerHTML = '';
  resetScrub();
  paintScrubTicks([]);
  document.title = 'Riffle';
  body.classList.add('no-doc');
}

function stepTab(d) {
  const ready = tabs.filter((t) => !t.loading);
  if (ready.length < 2) return;
  const i = ready.indexOf(activeTab);
  activateTab(ready[(i + d + ready.length) % ready.length]);
  flashTabs();
}

function reopenClosedTab() {
  while (closedTabs.length) {
    const p = closedTabs.pop();
    if (!tabs.some((t) => t.path === p)) { native.openPath(p, true); return; }
  }
}

async function moveToNewWindow(t) {
  if (tabs.length < 2 || t.loading) return;
  const payload = await carried(t, t === activeTab ? currentView() : t.view);
  closeTab(t, { remember: false });
  native.detachTab(payload);
}

/* what goes along with a tab to another window (the bytes only for a document
   that has no file of its own) */
async function carried(t, view, off = null) {
  const info = { name: t.name, path: t.path, view, off };
  if (!t.path) info.data = await t.doc.getData();
  return info;
}

function syncTabs() {
  native.syncTabs({ paths: tabs.filter((t) => t.path).map((t) => t.path) });
}

const slotEl = (i) => (tabs[i] && tabEls.get(tabs[i].id)) || null;

function renderTabs() {
  body.classList.toggle('has-tabs', stripOn());
  for (const [id, el] of tabEls) {
    if (!tabById(id)) { el.remove(); tabEls.delete(id); }
  }
  if (landing) landing.el.remove(); // the tabs line up first, then the held slot goes back in
  tabs.forEach((t, i) => {
    let el = tabEls.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = t.id;
      el.setAttribute('role', 'tab');
      el.innerHTML = '<span class="tab-title"></span><button class="tab-x" tabindex="-1">' +
        '<svg viewBox="0 0 20 20"><path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/></svg></button>';
      tabEls.set(t.id, el);
    }
    el.classList.toggle('on', t === activeTab);
    el.setAttribute('aria-selected', String(t === activeTab));
    el.classList.toggle('loading', !!t.loading);
    el.querySelector('.tab-title').textContent = tabTitle(t);
    el.querySelector('.tab-x').title = T.closeTab;
    if (tabList.children[i] !== el) tabList.insertBefore(el, tabList.children[i] || null);
  });
  if (landing) tabList.insertBefore(landing.el, slotEl(landing.index));
  // keep the active tab in view when the strip overflows
  const on = activeTab && tabEls.get(activeTab.id);
  if (on && !dragTab) {
    const l = on.offsetLeft, r = l + on.offsetWidth;
    if (l < tabList.scrollLeft) tabList.scrollLeft = l;
    else if (r > tabList.scrollLeft + tabList.clientWidth) tabList.scrollLeft = r - tabList.clientWidth;
  }
}

/* proximity reveal — the decision lives in the global mousemove handler */
function setTabsShown(on) {
  if (body.classList.contains('tabs-show') === on) return;
  body.classList.toggle('tabs-show', on);
  if (!on) hideTabCard();
}

let tabsFlashTimer = null;
function flashTabs(ms = 1300) {
  if (tabs.length < 2) return;
  body.classList.add('tabs-flash');
  clearTimeout(tabsFlashTimer);
  tabsFlashTimer = setTimeout(() => {
    body.classList.remove('tabs-flash');
    if (!body.classList.contains('tabs-show')) hideTabCard();
  }, ms);
}

/* neighbours glide into their new places instead of jumping (FLIP) */
function glide(change) {
  const before = new Map([...tabList.children].map((el) => [el, el.offsetLeft]));
  change();
  for (const el of tabList.children) {
    const x0 = before.get(el);
    if (x0 === undefined || el.classList.contains('dragging') || el.classList.contains('landing')) continue;
    const dx = x0 - el.offsetLeft;
    if (!dx) continue;
    el.style.transition = 'none';
    el.style.transform = `translateX(${dx}px)`;
    void el.offsetWidth;
    el.style.transition = '';
    el.style.transform = '';
  }
}

/* a tab set down mid-air glides the last bit into its slot */
function settleFrom(el, left) {
  const dx = el ? left - el.getBoundingClientRect().left : 0;
  if (!dx) return;
  el.style.transition = 'none';
  el.style.transform = `translateX(${dx}px)`;
  void el.offsetWidth;
  el.style.transition = '';
  el.style.transform = '';
}

/* press to switch (like a browser) and drag sideways to reorder. Pull a tab out
   of the strip and it becomes a window under the cursor; a window's only tab
   carries the window itself. Either way, set it down on another window's strip
   and it lands there as a tab. */
tabList.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tab');
  if (!el || e.button !== 0 || e.target.closest('.tab-x') || dragTab || plucked) return;
  const t = tabById(el.dataset.id);
  if (!t) return;
  e.preventDefault();
  activateTab(t);
  try { tabList.setPointerCapture(e.pointerId); } catch {} // the gesture may well leave the window
  const x0 = e.clientX, y0 = e.clientY;
  const box = el.getBoundingClientRect();
  const grab = x0 - box.left;
  const off = { x: x0 - (box.left + box.width / 2), y: y0 - (box.top + box.height / 2) }; // cursor vs. tab centre
  let phase = 'press';  // press → slide (reorder here) → carry (main moves a window) → done
  let handover = null;  // settles once main knows what is being carried
  const loose = () => !t.loading && !body.classList.contains('fullscreen');
  const naturalLeft = () => tabList.getBoundingClientRect().left + el.offsetLeft - tabList.scrollLeft;

  const slide = (ev) => {
    const lr = tabList.getBoundingClientRect();
    const centre = ev.clientX - grab + el.offsetWidth / 2;
    let idx = 0; // how many other tabs sit left of the dragged tab's centre
    for (const o of tabs) {
      if (o === t) continue;
      const oe = tabEls.get(o.id);
      if (centre > lr.left + oe.offsetLeft - tabList.scrollLeft + oe.offsetWidth / 2) idx++;
    }
    const cur = tabs.indexOf(t);
    if (idx !== cur) glide(() => { tabs.splice(cur, 1); tabs.splice(idx, 0, t); renderTabs(); });
    const left = clamp(ev.clientX - grab, lr.left + listPad, lr.right - listPad - el.offsetWidth); // drawn on the strip
    el.style.transform = `translateX(${left - naturalLeft()}px)`;
  };
  // well above or below the strip, or past the window's sides
  const pulledOut = (ev) => {
    const r = tabStrip.getBoundingClientRect();
    return ev.clientY < r.top - 30 || ev.clientY > r.bottom + 30 || ev.clientX < 0 || ev.clientX > innerWidth;
  };

  const onMove = (ev) => {
    if (phase === 'press') {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (tabs.length === 1 && !loose()) return; // nothing to reorder, and it can't leave
      dragTab = t;
      hideTabCard();
      el.classList.add('dragging');
      if (tabs.length === 1) { phase = 'carry'; handover = carryWindow(t, off, { x: x0, y: y0 }); return; }
      phase = 'slide';
    }
    if (phase === 'slide') {
      if (!loose() || !pulledOut(ev)) { slide(ev); return; }
      phase = 'carry';
      el.classList.remove('dragging');
      el.style.transform = '';
      handover = tearOff(t, off);
      return;
    }
    if (phase === 'carry') native.dragMove();
  };
  const finish = async (ev, cancel = false) => {
    if (phase === 'done') return;
    const was = phase;
    phase = 'done';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    tabList.removeEventListener('lostpointercapture', finish);
    window.removeEventListener('keydown', onKey, true);
    if (was === 'press') return;
    dragTab = null;
    el.classList.remove('dragging');
    el.style.transform = '';
    if (was === 'slide') { syncTabs(); return; }
    // the strip stays only if the cursor came to rest on it
    const r = tabStrip.getBoundingClientRect();
    setTabsShown(ev.clientY >= 0 && ev.clientY < r.bottom + 18 && ev.clientX >= 0 && ev.clientX <= innerWidth);
    await handover;
    native.dragEnd(cancel);
  };
  const onKey = (ev) => { // Esc puts everything back
    if (ev.key !== 'Escape' || phase !== 'carry') return;
    ev.preventDefault();
    ev.stopPropagation();
    finish({ clientX: -1, clientY: -1 }, true);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  tabList.addEventListener('lostpointercapture', finish);
  window.addEventListener('keydown', onKey, true);
});

/* the tab leaves the strip; main brings it up in a window of its own under the cursor */
async function tearOff(t, off) {
  pluckTab(t);
  try { native.dragTear(await carried(t, t.view, off)); }
  catch { unpluck(null); }
}

/* this window's only tab: the whole window goes along, held where it was pressed */
async function carryWindow(t, off, grab) {
  closeAllPopovers(); // commits a note being written
  flushPersist();     // whoever takes the document over reads its notes from storage
  try { native.dragCarry({ ...(await carried(t, currentView(), off)), grab }); } catch {}
}

/* out of the strip without closing — on its way elsewhere, but it may yet come back */
function pluckTab(t) {
  const i = tabs.indexOf(t);
  hideTabCard();
  if (t === activeTab) {
    closePrint();
    stashTab(t); // its view, notes and undo history go with it
    activeTab = null;
  }
  plucked = { tab: t, index: i };
  glide(() => { tabs.splice(i, 1); renderTabs(); });
  const next = tabs.slice(i).find((o) => !o.loading) || tabs.slice(0, i).reverse().find((o) => !o.loading);
  if (next) activateTab(next);
  else clearView();
  syncTabs();
}

/* back in the strip: at the slot it was set down in, or (Esc) where it was */
function unpluck(at) {
  if (!plucked) return;
  const { tab, index } = plucked;
  plucked = null;
  glide(() => { tabs.splice(clamp(at == null ? index : at, 0, tabs.length), 0, tab); renderTabs(); });
  activateTab(tab);
}

/* it lives in another window now */
function letGo() {
  if (!plucked) return;
  const { tab } = plucked;
  plucked = null;
  tab.closed = true;
  clearTimeout(tab.cleanupTimer);
  if (tab.doc) tab.doc.destroy().catch(() => {});
  renderTabs(); // a lone tab with no other window keeps no strip
}

/* a tab carried over from another window: this strip holds a slot open under the
   cursor, the carried tab riding in it while the neighbours make room */
function landingOver({ x, name, off }) {
  if (!landing) {
    const el = document.createElement('div');
    el.className = 'tab landing';
    el.innerHTML = '<span class="tab-title"></span>';
    el.firstChild.textContent = String(name || '').replace(/\.pdf$/i, '');
    landing = { el, index: -1, off: off && Number.isFinite(off.x) ? off.x : 0 };
    hideTabCard();
    body.classList.add('tab-landing');
  }
  const { el } = landing;
  const centre = x - landing.off;
  let lr = tabList.getBoundingClientRect();
  let idx = 0;
  for (const t of tabs) {
    const te = tabEls.get(t.id);
    if (te && centre > lr.left + te.offsetLeft - tabList.scrollLeft + te.offsetWidth / 2) idx++;
  }
  if (idx !== landing.index) {
    const fresh = landing.index < 0;
    landing.index = idx;
    glide(() => tabList.insertBefore(el, slotEl(idx)));
    if (fresh) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease' });
    lr = tabList.getBoundingClientRect();
  }
  const left = clamp(centre - el.offsetWidth / 2, lr.left + listPad, lr.right - listPad - el.offsetWidth); // never past the strip's ends
  el.style.transform = `translateX(${left - (lr.left + el.offsetLeft - tabList.scrollLeft)}px)`;
}

function landingLeave() {
  if (!landing) return;
  const { el } = landing;
  landing = null;
  glide(() => el.remove());
  body.classList.remove('tab-landing');
}

/* the slot the carried tab was set down in, and where on screen it was let go */
function takeLanding() {
  if (!landing) return null;
  const { el, index } = landing;
  const left = el.getBoundingClientRect().left;
  landing = null;
  el.remove();
  body.classList.remove('tab-landing');
  return { index, left };
}

tabList.addEventListener('click', (e) => {
  const x = e.target.closest('.tab-x');
  if (x) closeTab(tabById(x.closest('.tab').dataset.id));
});

// middle-click closes, as in every browser
tabList.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
tabList.addEventListener('auxclick', (e) => {
  const el = e.button === 1 && e.target.closest('.tab');
  if (el) closeTab(tabById(el.dataset.id));
});

tabList.addEventListener('contextmenu', async (e) => {
  const el = e.target.closest('.tab');
  const t = el && tabById(el.dataset.id);
  if (!t) return;
  e.preventDefault();
  hideTabCard();
  const index = tabs.indexOf(t);
  const act = await native.tabMenu({ index, count: tabs.length, hasPath: !!t.path });
  if (!tabs.includes(t)) return;
  if (act === 'close') closeTab(t);
  else if (act === 'close-others') {
    activateTab(t);
    tabs.filter((o) => o !== t).forEach((o) => closeTab(o));
  } else if (act === 'close-right') {
    const right = tabs.slice(tabs.indexOf(t) + 1);
    if (right.includes(activeTab)) activateTab(t);
    right.forEach((o) => closeTab(o));
  } else if (act === 'new-window') moveToNewWindow(t);
  else if (act === 'reveal' && t.path) native.reveal(t.path);
});

$('#tabNew').addEventListener('click', () => native.requestOpen());

// a wheel scrolls an overflowing strip sideways
tabList.addEventListener('wheel', (e) => {
  if (tabList.scrollWidth <= tabList.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  e.preventDefault();
  tabList.scrollLeft += e.deltaY;
}, { passive: false });

/* hover card — the full name, how far in you are, and (for a parked tab) a
   peek at the page you left off on: hover a while for the first card, then
   it follows the cursor along the strip instantly */
const tabCard = $('#tabCard');
const tcPaper = tabCard.querySelector('.tc-paper');
const tcCanvas = tcPaper.querySelector('canvas');
const CARD_W = 248;
let cardTab = null, cardTimer = null, cardToken = 0;

tabList.addEventListener('mouseover', (e) => {
  const el = e.target.closest('.tab');
  const t = el && tabById(el.dataset.id);
  if (!t || t === cardTab || dragTab) return;
  clearTimeout(cardTimer);
  if (tabCard.classList.contains('open')) showTabCard(t, el);
  else cardTimer = setTimeout(() => showTabCard(t, el), 420);
});
tabStrip.addEventListener('mouseleave', hideTabCard);

function cardBox(t, page) {
  const { w, h } = t.pageSizes[page - 1];
  const c = t.view && t.view.trim ? t.crops[page - 1] : null;
  const box = c && c.w > 0 && c.h > 0 && (c.w < 1 || c.h < 1) ? c : null;
  return { w, h, box };
}

async function showTabCard(t, el) {
  if (dragTab || !tabs.includes(t)) return;
  cardTab = t;
  const token = ++cardToken;
  const n = t.doc ? t.doc.numPages : 0;
  const page = t === activeTab ? state.currentPage : (t.view ? t.view.page : 1);
  $('#tcName').textContent = tabTitle(t);
  $('#tcPage').textContent = t.loading ? T.opening : T.tabPage(page, n);
  tabCard.style.setProperty('--p', n ? (page / n) * 100 + '%' : '0%');
  const peek = t !== activeTab && !t.loading;
  tabCard.classList.toggle('has-page', peek);
  tcPaper.classList.remove('ready');
  if (peek) { // reserve the page's shape now — it fills in without a jump
    const { w, h, box } = cardBox(t, page);
    const aw = w * (box ? box.w : 1), ah = h * (box ? box.h : 1);
    const pw = Math.min(CARD_W - 24, (360 * aw) / ah); // a tall page stays under 360px
    tcPaper.style.width = Math.round(pw) + 'px';
    tcPaper.style.height = Math.round((pw * ah) / aw) + 'px';
  }
  const r = el.getBoundingClientRect();
  tabCard.style.left = clamp(r.left, 10, innerWidth - CARD_W - 10) + 'px';
  tabCard.style.top = tabStrip.getBoundingClientRect().bottom + 8 + 'px';
  tabCard.classList.add('open');
  if (!peek) return;
  const c = await tabThumb(t, page).catch(() => null);
  if (token !== cardToken || !c) return;
  blit(tcCanvas, c);
  tcPaper.classList.add('ready');
}

function hideTabCard() {
  clearTimeout(cardTimer);
  cardToken++;
  cardTab = null;
  tabCard.classList.remove('open');
}

/* the page a parked tab was left on, as it looked in the reader (trim included) */
async function tabThumb(t, page) {
  if (t.thumb && t.thumb.page === page) return t.thumb.canvas;
  const { w, box } = cardBox(t, page);
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  const scale = ((CARD_W - 24) * dpr) / (w * (box ? box.w : 1));
  const pg = await t.doc.getPage(page);
  const vp = pg.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box ? vp.width * box.w : vp.width));
  c.height = Math.max(1, Math.round(box ? vp.height * box.h : vp.height));
  await pg.render({
    canvasContext: c.getContext('2d', { alpha: false }),
    viewport: vp,
    transform: box ? [1, 0, 0, 1, -box.x * vp.width, -box.y * vp.height] : null,
  }).promise;
  t.thumb = { page, canvas: c };
  return c;
}

let toastTimer = null;
function alertToast(msg) {
  // minimal, non-blocking error surface
  const el = $('#fileLabel');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.textContent = state.name.replace(/\.pdf$/i, '');
  }, 4000);
}

/* ---------------- page shells & layout ---------------- */

let renderIO = null;
let releaseIO = null;

function buildShells() {
  if (renderIO) renderIO.disconnect();
  if (releaseIO) releaseIO.disconnect();
  // the previous document's renders stop here, and never hold up this one's
  for (const r of state.recs) if (r.task) { try { r.task.cancel(); } catch {} }
  renderChain = new Map();
  pagesEl.innerHTML = '';
  state.shells = [];
  state.recs = [];
  state.active.clear();

  renderIO = new IntersectionObserver(onRenderIO, { root: scroller, rootMargin: '130%' });
  releaseIO = new IntersectionObserver(onReleaseIO, { root: scroller, rootMargin: '450%' });

  const n = state.doc.numPages;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= n; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = i;
    el.innerHTML = `<div class="sheet"><div class="textLayer"></div><div class="layer hl-layer"></div><div class="layer find-layer"></div><div class="layer link-layer"></div><div class="layer note-layer"></div></div>`;
    frag.appendChild(el);
    state.shells.push(el);
    state.recs.push({ canvas: null, renderedW: 0, task: null, textW: 0 });
    renderIO.observe(el);
    releaseIO.observe(el);
    paintHighlights(i, el);
    paintNotes(i, el);
  }
  pagesEl.appendChild(frag);
}

function pageCrop(num) {
  const c = state.trim && state.crops[num - 1];
  return (c && c.w > 0 && c.h > 0 && (c.w < 1 || c.h < 1)) ? c : null;
}

/* CSS width the full page sheet should have for page `num` under the current view */
function sheetWidthFor(num) {
  const { w, h } = state.pageSizes[num - 1];
  const crop = pageCrop(num);
  if (state.mode === 'h') {
    const shellH = Math.round(scroller.clientHeight * state.zoom);
    const sheetH = crop ? shellH / crop.h : shellH;
    return sheetH * (w / h);
  }
  return crop ? state.colW / crop.w : state.colW;
}

function positionSheet(sheet, sheetW, sheetH, crop) {
  if (crop) {
    sheet.style.width = sheetW + 'px';
    sheet.style.height = sheetH + 'px';
    sheet.style.left = -crop.x * sheetW + 'px';
    sheet.style.top = -crop.y * sheetH + 'px';
  } else {
    sheet.style.width = '100%';
    sheet.style.height = '100%';
    sheet.style.left = '0';
    sheet.style.top = '0';
  }
}

/* size one page shell and position its inner sheet so only the content box shows */
function applyGeometry(i) {
  const { w, h } = state.pageSizes[i];
  const el = state.shells[i];
  const sheet = el.firstElementChild;
  const crop = pageCrop(i + 1);
  if (state.mode === 'h') {
    const shellH = Math.round(scroller.clientHeight * state.zoom);
    const sheetH = crop ? shellH / crop.h : shellH;
    const sheetW = sheetH * (w / h);
    el.style.height = shellH + 'px';
    el.style.width = Math.round(crop ? sheetW * crop.w : sheetW) + 'px';
    positionSheet(sheet, sheetW, sheetH, crop);
  } else {
    const colW = state.colW;
    el.style.width = colW + 'px';
    const sheetW = crop ? colW / crop.w : colW;
    const sheetH = sheetW * (h / w);
    el.style.height = Math.round(crop ? sheetH * crop.h : sheetH) + 'px';
    positionSheet(sheet, sheetW, sheetH, crop);
  }
}

function layout(skipRender = false) {
  if (!state.doc) return;
  state.layoutEpoch++;
  const horiz = state.mode === 'h';
  pagesEl.classList.toggle('horizontal', horiz);
  pagesEl.classList.toggle('flush', !horiz && state.mode > 1);
  scroller.classList.toggle('h-mode', horiz);
  if (horiz) {
    pagesEl.style.gridTemplateColumns = 'none';
    pagesEl.style.gridAutoFlow = 'column';
    for (let i = 0; i < state.shells.length; i++) applyGeometry(i);
  } else {
    const n = state.mode;
    pagesEl.style.gridAutoFlow = 'row';
    // a second pass if the new height brought (or took away) the scrollbar —
    // settle the column width now rather than in a visible relayout later
    for (let pass = 0; pass < 2; pass++) {
      const cw = scroller.clientWidth;
      state.colW = Math.max(140, Math.floor((cw / n) * state.zoom));
      pagesEl.style.gridTemplateColumns = `repeat(${n}, ${state.colW}px)`;
      for (let i = 0; i < state.shells.length; i++) applyGeometry(i);
      if (scroller.clientWidth === cw) break;
    }
  }

  if (!skipRender) for (const p of state.active) queueRender(p);
  updateIndicator();
}

const relayout = debounce(layout, 140);
new ResizeObserver(() => { if (state.doc) relayout(); }).observe(scroller);

function onRenderIO(entries) {
  for (const en of entries) {
    const num = +en.target.dataset.page;
    if (en.isIntersecting) {
      state.active.add(num);
      queueRender(num);
    } else {
      state.active.delete(num);
    }
  }
}

function onReleaseIO(entries) {
  for (const en of entries) {
    if (!en.isIntersecting) releasePage(+en.target.dataset.page);
  }
}

/* ---------------- rendering ---------------- */

const MAX_CANVAS_W = 4200; // cap device pixels per page width

let renderChain = new Map(); // page -> promise, serializes per-page pdf.js work

function enqueue(num, fn) {
  const prev = renderChain.get(num) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  renderChain.set(num, next);
  return next;
}

function queueRender(num) {
  return enqueue(num, () => renderPage(num));
}

async function renderPage(num) {
  if (!state.doc || !state.active.has(num)) return;
  const doc = state.doc; // a tab switch mid-render leaves this one behind
  const rec = state.recs[num - 1];
  const shell = state.shells[num - 1];

  if (state.trim && !state.crops[num - 1]) {
    await computeCrop(num);
    if (state.doc !== doc) return;
    applyGeometry(num - 1);
  }
  const epoch = state.layoutEpoch;
  const targetW = Math.round(sheetWidthFor(num));
  if (rec.renderedW === targetW && rec.canvas) return;

  const page = await doc.getPage(num);
  if (state.doc !== doc || !state.active.has(num) || state.layoutEpoch !== epoch) return;

  const { w } = state.pageSizes[num - 1];
  const cssScale = targetW / w;
  const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  const deviceScale = Math.min(cssScale * dpr, MAX_CANVAS_W / w);
  const vp = page.getViewport({ scale: deviceScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });

  if (rec.task) { try { rec.task.cancel(); } catch {} }
  const task = page.render({ canvasContext: ctx, viewport: vp });
  rec.task = task;

  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('render failed p' + num, err);
    return;
  }
  if (rec.task !== task) return; // superseded

  const sheet = shell.firstElementChild;
  if (rec.canvas) rec.canvas.remove();
  sheet.prepend(canvas);
  rec.canvas = canvas;
  rec.renderedW = targetW;
  shell.classList.add('rendered');

  if (!rec.links) {
    rec.links = true; // fetch once per page
    page.getAnnotations().then((annots) => {
      rec.links = annots.filter((a) => a.subtype === 'Link');
      paintLinks(num);
    }).catch(() => { rec.links = null; });
  }

  // text layer at CSS scale (enables selection & text-anchored highlights)
  if (rec.textW !== targetW) {
    rec.textW = targetW;
    try {
      const textContent = await page.getTextContent();
      if (rec.textW !== targetW || state.doc !== doc) return;
      const tl = shell.querySelector('.textLayer');
      tl.innerHTML = '';
      tl.style.setProperty('--scale-factor', String(cssScale)); // pdf.js 3.x sizes spans with this
      const textDivs = [];
      await pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: tl,
        viewport: page.getViewport({ scale: cssScale }),
        textDivs,
      }).promise;
      fitTextSpans(textContent, textDivs, cssScale);
      rec.textDivs = textDivs;
      paintFind(num);
    } catch (err) {
      if (!(err && err.name === 'RenderingCancelledException')) console.warn('textLayer p' + num, err);
    }
  }
}

/* ---------------- white margin auto-trim ---------------- */

async function computeCrop(num) {
  // bound to this document: a tab switch mid-scan must not cross the streams
  const crops = state.crops, doc = state.doc, fp = state.fp;
  if (crops[num - 1]) return crops[num - 1];
  const { w } = state.pageSizes[num - 1];
  const page = await doc.getPage(num);
  const vp = page.getViewport({ scale: 160 / w });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  try {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  } catch {
    return (crops[num - 1] = { x: 0, y: 0, w: 1, h: 1 });
  }
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const W = c.width, H = c.height;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let crop = { x: 0, y: 0, w: 1, h: 1 };
  if (maxX >= 0) {
    const padX = W * 0.012, padY = H * 0.012;
    const x0 = Math.max(0, minX - padX), y0 = Math.max(0, minY - padY);
    const x1 = Math.min(W, maxX + 1 + padX), y1 = Math.min(H, maxY + 1 + padY);
    const box = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
    if (box.w < 0.985 || box.h < 0.985) crop = box; // ignore negligible trims
  }
  crops[num - 1] = crop;
  persist(`qy:crops:${fp}`, () => crops);
  return crop;
}

let sweepToken = 0;

async function sweepCrops() {
  const token = ++sweepToken;
  const doc = state.doc;
  const total = doc.numPages;
  // visible pages first, then the rest quietly in the background
  const order = [...state.active];
  for (let i = 1; i <= total; i++) if (!state.active.has(i)) order.push(i);
  for (const num of order) {
    if (token !== sweepToken || state.doc !== doc || !state.trim) return;
    if (!state.crops[num - 1]) {
      await enqueue(num, () => computeCrop(num));
      if (state.doc === doc && state.active.has(num)) layout();
    }
  }
  if (token === sweepToken && state.doc === doc && state.trim) layout();
}

async function setTrim(on) {
  if (state.trim === on) return;
  state.trim = on;
  syncTrimUI();
  savePrefs();
  layout();
  if (on) sweepCrops();
}

function syncTrimUI() {
  $('#trimSwitch').classList.toggle('on', state.trim);
}

/* Stretch each text span to the exact width the PDF declares for it.
   Browser font metrics never quite match the PDF's, and pdf.js's own
   canvas-measure correction can disagree with real DOM rendering — this
   makes selection, search highlights and copied-text hitboxes glyph-accurate. */
function fitTextSpans(textContent, textDivs, cssScale) {
  const items = textContent.items;
  if (textDivs.length !== items.length) return; // unexpected structure — leave as is
  const jobs = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const div = textDivs[k];
    if (!it || !it.str || !it.width || !div || div.textContent !== it.str) continue;
    const rect = div.getBoundingClientRect(); // batched reads first
    if (rect.width < 0.5) continue;
    const cur = div.style.transform;
    const m = /scaleX\(([\d.]+)\)/.exec(cur);
    const curScale = m ? parseFloat(m[1]) : 1;
    const natural = rect.width / (curScale || 1);
    // rect.width includes ancestor scaling (none here beyond the page itself)
    const target = it.width * cssScale;
    if (natural > 0.5) jobs.push([div, target / natural]);
  }
  for (const [div, sx] of jobs) {
    div.style.transform = `scaleX(${sx.toFixed(5)})`;
  }
}

function releasePage(num) {
  const rec = state.recs[num - 1];
  const shell = state.shells[num - 1];
  if (!rec || !rec.canvas) return;
  if (rec.task) { try { rec.task.cancel(); } catch {} }
  rec.canvas.remove();
  rec.canvas = null;
  rec.renderedW = 0;
  rec.textW = 0;
  rec.textDivs = null;
  shell.classList.remove('rendered');
  shell.querySelector('.textLayer').innerHTML = '';
  shell.querySelector('.find-layer').innerHTML = '';
}

/* ---------------- view controls ---------------- */

function setMode(m) {
  if (!MODES.includes(m) || m === state.mode) return;
  const anchor = state.currentPage;
  state.mode = m;
  syncModeUI();
  layout();
  scrollToPage(anchor, false);
  savePrefs();
}

function syncModeUI() {
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === String(state.mode));
  });
}

/* zoom anchored at a viewport point: cheap relayout now, sharp re-render when idle */
let rerenderTimer = null;

function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    for (const p of state.active) queueRender(p);
  }, 160);
}

function zoomAt(z, cx, cy) {
  z = clamp(z, ZMIN, ZMAX);
  if (!state.doc || Math.abs(z - state.zoom) < 1e-4) return;
  // pin the content point under the cursor, measured on the real geometry —
  // exact even across the centered/overflowing transition
  const before = pagesEl.getBoundingClientRect();
  const fx = (cx - before.left) / before.width;
  const fy = (cy - before.top) / before.height;
  state.zoom = z;
  layout(true); // canvases stretch via CSS for now — keeps the gesture fluid
  const after = pagesEl.getBoundingClientRect();
  scroller.scrollLeft += (after.left + fx * after.width) - cx;
  scroller.scrollTop += (after.top + fy * after.height) - cy;
  syncZoomUI();
  scheduleRerender();
  savePrefs();
}

function setZoom(z) {
  zoomAt(z, scroller.clientWidth / 2, scroller.clientHeight / 2);
}

/* fit the current page's visible content box to the window */
function fitZoom(kind) {
  if (!state.doc) return;
  const num = state.currentPage;
  const { w, h } = state.pageSizes[num - 1];
  const crop = pageCrop(num);
  const aspect = (w * (crop ? crop.w : 1)) / (h * (crop ? crop.h : 1));
  let z;
  if (state.mode === 'h') {
    z = kind === 'height' ? 1 : scroller.clientWidth / (scroller.clientHeight * aspect);
  } else {
    const availPer = scroller.clientWidth / state.mode;
    z = kind === 'width' ? 1 : (scroller.clientHeight * aspect) / availPer;
  }
  setZoom(z);
  scrollToPage(num, false);
}

function syncZoomUI() {
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

/* trackpad pinch (arrives as ctrl+wheel) and ⌘+wheel */
scroller.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const f = Math.exp(-clamp(e.deltaY, -32, 32) * 0.0058);
    zoomAt(state.zoom * f, e.clientX, e.clientY);
    return;
  }
  // filmstrip mode: a plain vertical wheel drives the horizontal scroll
  if (state.mode === 'h' && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    scroller.scrollLeft += e.deltaY;
  }
}, { passive: false });

function scrollToPage(num, smooth = true) {
  const el = state.shells[num - 1];
  if (!el) return;
  const horiz = state.mode === 'h';
  el.scrollIntoView({
    behavior: smooth ? 'smooth' : 'auto',
    block: horiz ? 'nearest' : 'start',
    inline: horiz ? 'start' : 'nearest',
  });
}

/* scroll so a point (ratios of the full page) sits comfortably in view */
function scrollToPageAt(num, yRatio, xRatio = 0) {
  const shell = state.shells[num - 1];
  if (!shell) return;
  const crop = pageCrop(num);
  let ry = yRatio, rx = xRatio;
  if (crop) { ry = (ry - crop.y) / crop.h; rx = (rx - crop.x) / crop.w; }
  ry = clamp(ry, 0, 1);
  rx = clamp(rx, 0, 1);
  if (state.mode === 'h') {
    scroller.scrollLeft = shell.offsetLeft + rx * shell.offsetWidth - scroller.clientWidth * 0.4;
  } else {
    scroller.scrollTop = shell.offsetTop + ry * shell.offsetHeight - scroller.clientHeight * 0.3;
  }
}

/* ---------------- page indicator ---------------- */

const indicator = $('#pageIndicator');

function updateIndicator() {
  if (!state.doc) return;
  const horiz = state.mode === 'h';
  const span = horiz ? scroller.clientWidth : scroller.clientHeight;
  const line = (horiz ? scroller.scrollLeft : scroller.scrollTop) + span * 0.35;
  let current = 1;
  for (let i = 0; i < state.shells.length; i++) {
    const pos = horiz ? state.shells[i].offsetLeft : state.shells[i].offsetTop;
    if (pos <= line) current = i + 1;
    else if (pos > line + span) break;
  }
  state.currentPage = current;
  indicator.textContent = `${current} ∕ ${state.doc.numPages}`;
  const N = state.doc.numPages;
  $('#scrubCur').style.left = (N > 1 ? ((current - 1) / (N - 1)) * 100 : 0) + '%';
  markTocActive(current);
}

let scrollRaf = false;
scroller.addEventListener('scroll', () => {
  if (!scrollRaf) {
    scrollRaf = true;
    requestAnimationFrame(() => {
      scrollRaf = false;
      updateIndicator();
      savePrefs();
    });
  }
  closeAllPopovers();
}, { passive: true });

/* ---------------- page scrubber — hover to skim, click to jump ---------------- */

const scrubTrack = $('#scrubTrack');
const scrubFly = $('#scrubFly');
const scrubCurEl = $('#scrubCur');
const scrubGhost = $('#scrubGhost');
const sfSlots = [
  { wrap: scrubFly.querySelector('.sf-prev'), canvas: scrubFly.querySelector('.sf-prev canvas') },
  { wrap: scrubFly.querySelector('.sf-cur'), canvas: scrubFly.querySelector('.sf-cur canvas') },
  { wrap: scrubFly.querySelector('.sf-next'), canvas: scrubFly.querySelector('.sf-next canvas') },
];

const scrub = { thumbs: new Map(), order: [], pending: new Map(), hoverPage: 0 };
let scrubRenderTimer = null;

/* preview sizing: width target bounded by the window's height budget,
   so a page never grows taller than the window */
function scrubSizes() {
  const narrow = innerWidth < 1280; // single big page unless the window is truly wide
  const maxH = Math.max(220, innerHeight - 120);
  const ps = state.pageSizes[(scrub.hoverPage || 1) - 1] || { w: 612, h: 792 };
  const centerW = Math.min(innerWidth * (narrow ? 0.85 : 0.38), maxH * (ps.w / ps.h));
  return { narrow, centerW, sideW: centerW * 0.79 };
}

/* render resolution follows the actual display width, capped for memory */
function thumbRenderW() {
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  return Math.min(Math.floor(scrubSizes().centerW * dpr), 1600);
}

/* a different document on screen: fresh thumbnail cache, its own breadcrumbs */
function resetScrub(history = []) {
  scrub.thumbs.clear();
  scrub.order.length = 0;
  scrub.pending.clear();
  scrub.hoverPage = 0;
  scrub.marks = [];
  scrub.history = history;
  centerFade.key = '';
  centerFade.pending = null;
  scrubFly.classList.remove('on');
  // the last document's beads leave at once — they don't belong to this track
  scrubTrack.querySelectorAll('.scrub-echo').forEach((el) => el.remove());
  paintEchoes();
}

/* last two clicks linger as grey beads — each keeps its spot, ages by fading */
function paintEchoes() {
  const N = state.doc ? state.doc.numPages : 0;
  const wanted = new Map();
  if (N >= 2) {
    if (scrub.history[0]) wanted.set(scrub.history[0], 'is-new');
    if (scrub.history[1]) wanted.set(scrub.history[1], 'is-old');
  }
  for (const el of scrubTrack.querySelectorAll('.scrub-echo')) {
    const pg = +el.dataset.page;
    if (wanted.has(pg)) {
      el.className = 'scrub-echo ' + wanted.get(pg); // ages: fades lighter, shrinks a touch
      wanted.delete(pg);
    } else if (!el.classList.contains('is-gone')) {
      el.className = 'scrub-echo is-gone';           // fades away, then leaves the DOM
      setTimeout(() => el.remove(), 900);
    }
  }
  for (const [pg, cls] of wanted) {
    const el = document.createElement('div');
    el.className = 'scrub-echo';
    el.dataset.page = pg;
    el.style.left = ((pg - 1) / (N - 1)) * 100 + '%';
    scrubTrack.insertBefore(el, scrubCurEl);
    void el.offsetWidth;                              // enter: scale/fade in
    el.className = 'scrub-echo ' + cls;
  }
}

function pushClickHistory(p) {
  if (!scrub.history) scrub.history = [];
  if (scrub.history[0] === p) return;
  scrub.history.unshift(p);
  scrub.history.length = Math.min(scrub.history.length, 2);
  paintEchoes();
}

function renderThumb(p) {
  return renderThumbAt(p, thumbRenderW());
}

function renderThumbAt(p, wpx) {
  const cached = scrub.thumbs.get(p);
  if (cached && cached.width >= wpx * 0.9) return Promise.resolve(cached);
  if (scrub.pending.has(p)) return scrub.pending.get(p);
  const doc = state.doc;
  const { w } = state.pageSizes[p - 1];
  const pr = (async () => {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: Math.min(wpx, 2000) / w });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
    if (state.doc !== doc) throw new Error('doc changed');
    scrub.thumbs.set(p, c);
    scrub.order.push(p);
    if (scrub.order.length > 24) scrub.thumbs.delete(scrub.order.shift());
    return c;
  })().finally(() => { if (scrub.pending.get(p) === pr) scrub.pending.delete(p); });
  scrub.pending.set(p, pr);
  return pr;
}

function blit(cv, src) {
  cv.width = src.width;
  cv.height = src.height;
  cv.getContext('2d').drawImage(src, 0, 0);
}

function blankFor(pp) {
  const { w, h } = state.pageSizes[pp - 1];
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = Math.round(160 * (h / w));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/* centre page swaps as a soft 130ms dissolve — no motion, easy on the eyes */
const centerFade = { key: '', pending: null, timer: null };

function blitCenter(src, pp, soft = true) {
  const A = sfSlots[1].canvas;
  const B = scrubFly.querySelector('.sf-fade');
  const key = pp + '@' + src.width;
  if (key === centerFade.key) return;
  centerFade.key = key;
  if (!soft) { // sweeping: hard flip, no lag
    clearTimeout(centerFade.timer);
    centerFade.pending = null;
    blit(A, src);
    B.style.transition = 'none';
    B.style.opacity = '0';
    return;
  }
  if (centerFade.pending) blit(A, centerFade.pending); // commit the mid-fade frame
  centerFade.pending = src;
  blit(B, src);
  B.style.transition = 'none';
  B.style.opacity = '0';
  void B.offsetWidth;
  B.style.transition = 'opacity 0.13s linear';
  B.style.opacity = '1';
  clearTimeout(centerFade.timer);
  centerFade.timer = setTimeout(() => {
    blit(A, src);
    centerFade.pending = null;
    B.style.transition = 'none';
    B.style.opacity = '0';
  }, 150);
}

function drawScrubSlots(p, allowRender) {
  const N = state.doc.numPages;
  const { narrow, centerW, sideW } = scrubSizes();
  document.documentElement.style.setProperty('--sf-center', centerW + 'px');
  document.documentElement.style.setProperty('--sf-side', sideW + 'px');
  [p - 1, p, p + 1].forEach((pp, i) => {
    const { wrap, canvas } = sfSlots[i];
    if (pp < 1 || pp > N || (narrow && i !== 1)) { wrap.classList.add('off'); return; }
    wrap.classList.remove('off');
    const need = thumbRenderW() * 0.9;
    const cached = scrub.thumbs.get(pp);
    if (cached) {
      if (i === 1) blitCenter(cached, pp, true);   // sharp: gentle dissolve
      else blit(canvas, cached);
    } else {
      if (i === 1) blitCenter(blankFor(pp), pp, false); // clean paper while it renders
      else blit(canvas, blankFor(pp));
    }
    // render on rest, plus up to two in flight mid-sweep
    if ((!cached || cached.width < need) && (allowRender || scrub.pending.size < 2)) {
      if (cached && cached.width < need) {
        scrub.thumbs.delete(pp);
        const idx = scrub.order.indexOf(pp);
        if (idx >= 0) scrub.order.splice(idx, 1);
      }
      renderThumb(pp).then(() => {
        if (scrub.hoverPage && Math.abs(scrub.hoverPage - pp) <= 1) {
          drawScrubSlots(scrub.hoverPage, false);
        }
      }).catch(() => {});
    }
  });
}

function pageFromTrackX(clientX) {
  const r = scrubTrack.getBoundingClientRect();
  const f = clamp((clientX - r.left) / r.width, 0, 1);
  const N = state.doc.numPages;
  return N > 1 ? 1 + Math.round(f * (N - 1)) : 1;
}

scrubTrack.addEventListener('mousemove', (e) => {
  if (!state.doc) return;
  const p = pageFromTrackX(e.clientX);
  const r = scrubTrack.getBoundingClientRect();
  scrubGhost.style.left = clamp(e.clientX - r.left, 0, r.width) + 'px';

  scrubFly.classList.add('on');
  const changed = scrub.hoverPage !== p;
  scrub.hoverPage = p;
  if (changed) {
    $('#sfNum').textContent = p;
    drawScrubSlots(p, false);          // cached pages appear instantly
    clearTimeout(scrubRenderTimer);    // render only once the sweep rests
    scrubRenderTimer = setTimeout(() => drawScrubSlots(p, true), 60);
  }
});

scrubTrack.addEventListener('mouseleave', () => {
  scrubFly.classList.remove('on');
  scrub.hoverPage = 0;
  clearTimeout(scrubRenderTimer);
});

scrubTrack.addEventListener('click', (e) => {
  if (!state.doc) return;
  const p = pageFromTrackX(e.clientX);
  pushClickHistory(state.currentPage); // the place you LEFT becomes the breadcrumb
  scrollToPage(p, false);
});

/* page jump */
const pageJump = $('#pageJump');
const pageJumpInput = pageJump.querySelector('input');
indicator.addEventListener('click', () => {
  if (!state.doc) return;
  pageJump.classList.add('open');
  $('#pageJumpTotal').textContent = ` ∕ ${state.doc.numPages}`;
  pageJumpInput.value = state.currentPage;
  pageJumpInput.focus();
  pageJumpInput.select();
});
pageJump.addEventListener('submit', (e) => {
  e.preventDefault();
  const n = clamp(parseInt(pageJumpInput.value, 10) || state.currentPage, 1, state.doc.numPages);
  pageJump.classList.remove('open');
  scrollToPage(n);
});
pageJumpInput.addEventListener('blur', () => pageJump.classList.remove('open'));

/* ---------------- chrome show / hide ---------------- */

let idleTimer = null;

function wakeChrome() {
  body.classList.add('ui-active');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => body.classList.remove('ui-active'), 2400);
}

const overRect = (e, r, pad) =>
  e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
  e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;

let menuDwell = null;

window.addEventListener('mousemove', (e) => {
  if (body.classList.contains('print-open')) return; // the sheet is modal — nothing stirs beneath
  clearTimeout(tabsLeaveTimer);
  wakeChrome();
  if (dragTab) { setTabsShown(true); return; } // a tab in hand: the strip stays, nothing else stirs
  const multi = body.classList.contains('has-tabs');
  body.classList.toggle('tl-zone', e.clientX < 170 && e.clientY < 80);
  body.classList.toggle('toc-zone', e.clientX < 44);
  body.classList.toggle('menu-zone', e.clientX > innerWidth - 120 && e.clientY < 80);
  // with tabs the toolbar sits lower, under the strip — its zone reaches further down
  body.classList.toggle('tb-zone',
    e.clientY < (multi ? 130 : 90) && Math.abs(e.clientX - innerWidth / 2) < 280);
  body.classList.toggle('scrub-zone', e.clientY > innerHeight - 64);

  // tabs: slide in as the cursor nears the strip (its box is laid out even while
  // hidden); stay out of the way of search and the contents panel
  if (multi) {
    const r = tabStrip.getBoundingClientRect();
    const near = e.clientY < r.bottom + 18 && e.clientX > r.left - 64 && e.clientX < r.right + 64;
    setTabsShown(near && !body.classList.contains('find-open') && !body.classList.contains('toc-open'));
  } else {
    setTabsShown(false);
  }

  // TOC: expands when the cursor reaches its handle, folds once it moves past the panel
  if (body.classList.contains('toc-open')) {
    if (!tocPinned && e.clientX > 344) toggleToc(false);
  } else if (state.doc && body.classList.contains('toc-zone') &&
             overRect(e, tocHandleBtn.getBoundingClientRect(), 4)) {
    tocPinned = false;
    toggleToc(true);
  }

  // menu: opens only after a moment of dwell on the button; folds quickly on leave
  const onBtn = overRect(e, menuBtn.getBoundingClientRect(), 6);
  if (body.classList.contains('menu-open')) {
    const r = menuPanel.getBoundingClientRect();
    const nearPanel = e.clientX >= r.left - 12 && e.clientX <= r.right + 12 && e.clientY <= r.bottom + 12;
    if (!nearPanel && !onBtn) body.classList.remove('menu-open');
  } else if (onBtn && !body.classList.contains('find-open')) {
    if (!menuDwell) {
      menuDwell = setTimeout(() => { menuDwell = null; body.classList.add('menu-open'); }, 150);
    }
  } else if (menuDwell) {
    clearTimeout(menuDwell);
    menuDwell = null;
  }
});
document.addEventListener('mouseleave', (e) => {
  if (dragTab) return; // a tab carried out of the window — its strip waits for it
  body.classList.remove('ui-active', 'tl-zone', 'toc-zone', 'menu-zone', 'tb-zone', 'scrub-zone');
  // leaving across the top edge may only mean the cursor slipped into the
  // window's drag strip — give the tabs a moment before they fold away
  clearTimeout(tabsLeaveTimer);
  if (e.clientY > 30) setTabsShown(false);
  else tabsLeaveTimer = setTimeout(() => setTabsShown(false), 1200);
});
let tabsLeaveTimer = null;

/* window controls */
$('#btnClose').addEventListener('click', () => native.close());
$('#btnMin').addEventListener('click', () => native.minimize());
$('#btnFull').addEventListener('click', () => native.toggleFullscreen());
native.onFullscreen((v) => body.classList.toggle('fullscreen', v));

/* ---------------- menu ---------------- */

const menuBtn = $('#menuBtn');
const menuPanel = $('#menuPanel');

document.addEventListener('click', (e) => {
  if (body.classList.contains('menu-open') &&
      !e.target.closest('#menuPanel') && !e.target.closest('#menuBtn')) {
    body.classList.remove('menu-open');
  }
});

$('#menuOpen').addEventListener('click', () => {
  body.classList.remove('menu-open');
  native.requestOpen();
});
$('#menuPrint').addEventListener('click', () => {
  body.classList.remove('menu-open');
  openPrint();
});
$('#emptyOpen').addEventListener('click', () => native.requestOpen());

document.querySelectorAll('#modeSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    const m = b.dataset.mode === 'h' ? 'h' : +b.dataset.mode;
    setMode(m);
  });
});

$('#zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.15));
$('#zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.15));
$('#fitW').addEventListener('click', () => fitZoom('width'));
$('#fitH').addEventListener('click', () => fitZoom('height'));

$('#menuTrim').addEventListener('click', () => setTrim(!state.trim));

/* hover open/close for the TOC lives in the mousemove handler (position-based —
   the handle slides away on open, so element enter/leave events would oscillate) */
const tocHandleBtn = $('#tocHandle');
let tocPinned = false; // opened via keyboard — ignore hover-out closing

// tapping back into the document dismisses the TOC
scroller.addEventListener('mousedown', () => {
  if (body.classList.contains('toc-open')) toggleToc(false);
});

/* grab-to-pan: dragging bare paper moves the view (text still selects normally) */
scroller.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || state.tool !== 'cursor' || !state.doc) return;
  if (e.target.closest('.textLayer span, .hl, .note-pin, .plink, .popover')) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  const st = scroller.scrollTop, sl = scroller.scrollLeft;
  let panning = false;
  const onMove = (ev) => {
    if (!panning && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    panning = true;
    body.classList.add('panning');
    scroller.scrollTop = st - (ev.clientY - sy);
    scroller.scrollLeft = sl - (ev.clientX - sx);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    body.classList.remove('panning');
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

function toggleToc(force) {
  body.classList.toggle('toc-open', force);
}

/* ---------------- table of contents ---------------- */

let tocToken = 0;

async function buildToc() {
  const list = $('#tocList');
  const tab = activeTab;
  const doc = state.doc;
  const token = ++tocToken;
  // built once per document — switching tabs just puts its list back
  if (tab && tab.tocNodes) {
    list.replaceChildren(...tab.tocNodes);
    paintScrubTicks(tab.marks || []);
    markTocActive(state.currentPage);
    return;
  }
  list.innerHTML = '';
  paintScrubTicks([]);
  let outline = null;
  try { outline = await doc.getOutline(); } catch {}
  if (token !== tocToken) return; // another tab came forward meanwhile
  if (!outline || !outline.length) {
    list.innerHTML = `<div class="toc-empty">${T.tocEmpty}</div>`;
    if (tab) { tab.tocNodes = [...list.childNodes]; tab.marks = []; }
    return;
  }
  const markJobs = []; // top-level chapters become notches on the scrubber
  const addItems = (items, level) => {
    for (const item of items) {
      const btn = document.createElement('button');
      const title = fixTitle(item.title);
      btn.className = 'toc-item';
      btn.textContent = title || '·';
      btn.style.paddingLeft = 10 + level * 14 + 'px';
      btn.addEventListener('click', async () => {
        const num = await destToPage(item.dest, doc);
        if (num && state.doc === doc) { scrollToPage(num); btn.dataset.gotoPage = num; }
      });
      resolveTocPage(item, btn, doc);
      list.appendChild(btn);
      if (level === 0) {
        markJobs.push(destToPage(item.dest, doc).then((n) => (n ? { page: n, title: title || '' } : null)));
      }
      if (item.items && item.items.length) addItems(item.items, level + 1);
    }
  };
  addItems(outline, 0);
  if (tab) tab.tocNodes = [...list.childNodes];
  Promise.all(markJobs).then((marks) => {
    const found = marks.filter(Boolean);
    if (tab) tab.marks = found;
    if (state.doc === doc) paintScrubTicks(found);
  });
}

/* Bookmarks written by some Chinese tools hold raw GBK (or BOM-less UTF-8)
   bytes, which pdf.js reads as PDFDocEncoding — "µÚÒ»ÕÂ" instead of "第一章".
   Map the characters back to bytes and re-decode, but only when the result
   is clearly CJK; genuine Latin titles are left untouched. */
const PDFDOC_HIGH = '\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203a\u2212\u2030' +
  '\u201e\u201c\u201d\u2018\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160\u0178\u017d' +
  '\u0131\u0142\u0153\u0161\u017e'; // bytes 0x80–0x9E

function fixTitle(s) {
  if (!s || /[\u3400-\u9fff]/.test(s)) return s;
  const bytes = [];
  let high = 0;
  for (const ch of s) {
    let b = ch.charCodeAt(0);
    if (b > 0xff) {
      const k = PDFDOC_HIGH.indexOf(ch);
      if (k >= 0) b = 0x80 + k;
      else if (ch === '\u20ac') b = 0xa0;
      else return s; // a real Unicode title
    }
    if (b >= 0x80) high++;
    bytes.push(b);
  }
  if (high < 2) return s;
  const buf = Uint8Array.from(bytes);
  const cjk = (t) => (t.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/g) || []).length;
  try { // UTF-8 is self-checking: three high bytes per CJK character
    const out = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (cjk(out) * 3 >= high * 0.9) return out;
  } catch {}
  // GBK: high bytes come in pairs, at least two characters in a row —
  // a lone "é" or "öß" between Latin letters is just a European title
  let run = 0, longest = 0, odd = false;
  for (const b of [...buf, 0]) {
    if (b >= 0x80) { run++; continue; }
    if (run % 2) odd = true;
    longest = Math.max(longest, run);
    run = 0;
  }
  if (odd || longest < 4) return s;
  try {
    const out = new TextDecoder('gb18030', { fatal: true }).decode(buf);
    if (cjk(out) * 2 >= high * 0.9) return out;
  } catch {}
  return s;
}

function paintScrubTicks(marks) {
  const el = $('#scrubTicks');
  el.innerHTML = '';
  scrub.marks = [...marks].sort((a, b) => a.page - b.page);
  if (!state.doc || state.doc.numPages < 2 || !marks.length) return;
  const N = state.doc.numPages;
  const seen = new Set();
  for (const m of scrub.marks) {
    if (seen.has(m.page)) continue;
    seen.add(m.page);
    const t = document.createElement('div');
    t.className = 'scrub-tick';
    t.style.left = ((m.page - 1) / (N - 1)) * 100 + '%';
    el.appendChild(t);
  }
}


async function resolveTocPage(item, btn, doc) {
  const num = await destToPage(item.dest, doc);
  if (num) btn.dataset.page = num;
}

async function destToPage(dest, doc = state.doc) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await doc.getDestination(d);
    if (!d || !d[0]) return null;
    const idx = await doc.getPageIndex(d[0]);
    return idx + 1;
  } catch { return null; }
}

function markTocActive(pageNum) {
  const items = document.querySelectorAll('.toc-item[data-page]');
  let best = null;
  for (const it of items) {
    if (+it.dataset.page <= pageNum) best = it;
  }
  items.forEach((it) => it.classList.toggle('active', it === best));
}

/* ---------------- find in document (⌘F) ---------------- */
/* Built for research papers: case/diacritic-insensitive, joins words
   hyphenated across line breaks, and treats missing inter-word spaces in
   the PDF text stream as elastic. */

const findInput = $('#findInput');
const findCount = $('#findCount');
const findResults = $('#findResults');

state.find = { open: false, matches: [], current: -1, pending: false };
let pageTexts = [];      // per page: {items, concat, cumStarts, norm, map}
let textPromise = null;
let textDoc = null;      // the document pageTexts/textPromise belong to

function normalizeChar(ch) {
  if (ch === '\u00AD') return ''; // soft hyphen
  return ch.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/* Chinese/Japanese/Korean script, incl. CJK punctuation and full-width forms */
const isCJK = (ch) => /[\u2e80-\u2fdf\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch);

function buildPageText(tc) {
  const items = [];
  const cumStarts = [];
  const nlPos = []; // concat indices of synthetic newlines (absent from the DOM text)
  let concat = '';
  for (const it of tc.items) {
    const str = it.str || '';
    cumStarts.push(concat.length);
    items.push({ str, x: it.transform[4], y: it.transform[5], h: it.height || 0 });
    concat += str;
    if (it.hasEOL) { nlPos.push(concat.length); concat += '\n'; }
  }
  let norm = '';
  const map = [];
  let gap = -1;   // a pending word gap (its concat index) — emitted once we see what follows
  let prev = '';  // the last character that made it into norm
  for (let i = 0; i < concat.length; i++) {
    const ch = concat[i];
    if (ch === '\n') {
      // a hyphen right before a line break joins the split word: "meth-\nod" → "method"
      if (gap < 0 && i > 0 && /[-\u2010]/.test(concat[i - 1]) && norm.endsWith(concat[i - 1])) {
        norm = norm.slice(0, -1);
        map.pop();
        continue;
      }
      if (norm && gap < 0) gap = i;
      continue;
    }
    const low = normalizeChar(ch);
    if (!low) continue;
    if (/^\s+$/.test(low)) {
      if (norm && gap < 0) gap = i;
      continue;
    }
    // CJK text has no word spaces: a line break or stray gap between two
    // ideographs is layout, not a word boundary — "注意\n力" still finds 注意力
    if (gap >= 0 && !(isCJK(prev) && isCJK(ch))) { norm += ' '; map.push(gap); }
    gap = -1;
    for (const c of low) { norm += c; map.push(i); }
    prev = ch;
  }
  return { items, concat, cumStarts, nlPos, norm, map };
}

/* concat offset → DOM text offset (synthetic newlines don't exist in the DOM) */
function toDomOffset(pt, c) {
  const a = pt.nlPos;
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < c) lo = mid + 1; else hi = mid;
  }
  return c - lo;
}

function ensureAllText() {
  if (textDoc === state.doc && textPromise) return textPromise;
  const doc = state.doc;
  const texts = pageTexts; // this document's index — it travels with its tab
  textDoc = doc;
  textPromise = (async () => {
    if (!doc) return;
    for (let i = 1; i <= doc.numPages; i++) {
      if (state.doc !== doc) return;
      if (!texts[i - 1]) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        texts[i - 1] = buildPageText(tc);
      }
    }
  })();
  return textPromise;
}

function resetFind() {
  pageTexts = [];
  textPromise = null;
  textDoc = null;
  state.find.matches = [];
  state.find.current = -1;
  closeFind();
  findResults.innerHTML = '';
  findResults.classList.remove('has');
  findCount.textContent = '';
}

function openFind() {
  if (!state.doc) return;
  const sel = String(window.getSelection() || '').trim().replace(/\s+/g, ' ');
  body.classList.add('find-open');
  state.find.open = true;
  if (sel && sel.length <= 120) findInput.value = sel;
  findInput.focus();
  findInput.select();
  ensureAllText();
  if (findInput.value.trim()) runSearch();
}

function closeFind() {
  if (!state.find.open && !body.classList.contains('find-open')) return;
  body.classList.remove('find-open');
  state.find.open = false;
  state.find.matches = [];
  state.find.current = -1;
  hideFindPeek();
  for (const p of state.active) paintFind(p);
  findInput.blur();
}

async function runSearch() {
  const raw = findInput.value;
  state.find.pending = true;
  updateFindUI();
  await ensureAllText();
  if (!state.find.open || findInput.value !== raw || !state.doc) return;
  state.find.pending = false;

  // normalize the query the same way as the page text
  let q = '';
  for (const ch of raw) {
    const low = normalizeChar(ch);
    if (!low) continue;
    q += /^\s+$/.test(low) ? ' ' : low;
  }
  q = q.replace(/\s+/g, ' ').trim();

  state.find.matches = [];
  state.find.current = -1;

  if (q) {
    // spaces are elastic: PDFs often drop or add spaces between text chunks
    const pattern = new RegExp(
      [...q].map((c) => (c === ' ' ? '[ ]?' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(''),
      'g'
    );
    for (let p = 1; p <= state.doc.numPages; p++) {
      const pt = pageTexts[p - 1];
      if (!pt || !pt.norm) continue;
      let m;
      while ((m = pattern.exec(pt.norm))) {
        if (!m[0].length) { pattern.lastIndex++; continue; }
        state.find.matches.push({
          page: p,
          start: pt.map[m.index],
          end: pt.map[m.index + m[0].length - 1] + 1,
        });
        if (state.find.matches.length >= 5000) break;
      }
      if (state.find.matches.length >= 5000) break;
    }
  }

  buildFindResults();
  for (const p of state.active) paintFind(p);
  if (state.find.matches.length) {
    let init = state.find.matches.findIndex((mt) => mt.page >= state.currentPage);
    if (init < 0) init = 0;
    goToMatch(init);
  } else {
    updateFindUI();
  }
}

const runSearchDebounced = debounce(runSearch, 200);

function paintFind(num) {
  const shell = state.shells[num - 1];
  if (!shell) return;
  const layer = shell.querySelector('.find-layer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!state.find.open || !state.find.matches.length) return;
  const rec = state.recs[num - 1];
  const pt = pageTexts[num - 1];
  if (!rec || !rec.textDivs || !pt) return;
  const sheet = shell.firstElementChild;
  const sr = sheet.getBoundingClientRect();
  if (!sr.width || !sr.height) return;

  // index the text layer's text nodes by global character offset — robust
  // against any span/br structure renderTextLayer produces
  const tl = shell.querySelector('.textLayer');
  const nodes = [];
  let acc = 0;
  const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.textContent.length;
    if (len) nodes.push({ node: n, start: acc, end: acc + len });
    acc += len;
  }
  if (!nodes.length) return;

  const locate = (off) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].end <= off) lo = mid + 1; else hi = mid;
    }
    return nodes[lo];
  };

  state.find.matches.forEach((mt, idx) => {
    if (mt.page !== num) return;
    const gs = toDomOffset(pt, mt.start);
    const ge = Math.min(toDomOffset(pt, mt.end), acc);
    if (ge <= gs) return;
    const a = locate(gs);
    const b = locate(ge - 1);
    const range = document.createRange();
    range.setStart(a.node, clamp(gs - a.start, 0, a.node.textContent.length));
    range.setEnd(b.node, clamp(ge - b.start, 0, b.node.textContent.length));
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const d = document.createElement('div');
      d.className = 'find-hit' + (idx === state.find.current ? ' current' : '');
      d.style.left = ((r.left - sr.left) / sr.width) * 100 + '%';
      d.style.top = ((r.top - sr.top) / sr.height) * 100 + '%';
      d.style.width = (r.width / sr.width) * 100 + '%';
      d.style.height = (r.height / sr.height) * 100 + '%';
      layer.appendChild(d);
    }
  });
}

function goToMatch(i) {
  const M = state.find.matches;
  if (!M.length) return;
  state.find.current = ((i % M.length) + M.length) % M.length;
  const mt = M[state.find.current];

  // jump using the text item's PDF-space position — no need to wait for a render
  const pt = pageTexts[mt.page - 1];
  let itemIdx = 0;
  for (let i = 0; i < pt.cumStarts.length; i++) {
    if (pt.cumStarts[i] <= mt.start) itemIdx = i; else break;
  }
  const item = pt.items[itemIdx];
  if (item) {
    const { w, h } = state.pageSizes[mt.page - 1];
    scrollToPageAt(mt.page, 1 - (item.y + item.h) / h, item.x / w);
  }

  for (const p of state.active) paintFind(p);
  updateFindUI();
  syncFindResultsActive();
}

const FIND_ROWS_MAX = 300;

function buildFindResults() {
  findResults.innerHTML = '';
  const M = state.find.matches;
  findResults.classList.toggle('has', M.length > 0);
  M.slice(0, FIND_ROWS_MAX).forEach((mt, idx) => {
    const pt = pageTexts[mt.page - 1];
    const clean = (t) => t.replace(/[\n\u00AD]+/g, ' ');
    const s = Math.max(0, mt.start - 44);
    const e = Math.min(pt.concat.length, mt.end + 60);
    const row = document.createElement('button');
    row.className = 'find-row';
    row.dataset.idx = idx;
    const em = document.createElement('em');
    em.textContent = mt.page;
    const span = document.createElement('span');
    span.append((s > 0 ? '…' : '') + clean(pt.concat.slice(s, mt.start)));
    const b = document.createElement('b');
    b.textContent = clean(pt.concat.slice(mt.start, mt.end));
    span.append(b, clean(pt.concat.slice(mt.end, e)) + (e < pt.concat.length ? '…' : ''));
    row.append(em, span);
    row.addEventListener('mouseenter', () => showFindPeek(mt));
    row.addEventListener('click', () => { hideFindPeek(); goToMatch(idx); });
    findResults.appendChild(row);
  });
  if (M.length > FIND_ROWS_MAX) {
    const more = document.createElement('div');
    more.className = 'find-more';
    more.textContent = T.findMore(M.length - FIND_ROWS_MAX);
    findResults.appendChild(more);
  }
}

function syncFindResultsActive() {
  findResults.querySelectorAll('.find-row').forEach((r) => {
    const on = +r.dataset.idx === state.find.current;
    r.classList.toggle('active', on);
    if (on) r.scrollIntoView({ block: 'nearest' });
  });
}

function updateFindUI() {
  const M = state.find.matches;
  if (state.find.pending) findCount.textContent = '…';
  else if (!findInput.value.trim()) findCount.textContent = '';
  else findCount.textContent = M.length ? `${state.find.current + 1} ∕ ${M.length}` : '0';
}

findInput.addEventListener('input', () => runSearchDebounced());
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    goToMatch(state.find.current + (e.shiftKey ? -1 : 1));
  }
});
/* hover peek: the hovered result shown in place on its page */
const findPeek = $('#findPeek');
const fpCanvas = findPeek.querySelector('canvas');
const fpBand = findPeek.querySelector('.fp-band');
let fpToken = 0;

async function showFindPeek(mt) {
  const token = ++fpToken;
  const num = mt.page;
  const crop = await computeCrop(num).catch(() => null) || { x: 0, y: 0, w: 1, h: 1 };
  if (token !== fpToken || !state.find.open) return;
  const { w, h } = state.pageSizes[num - 1];

  // placement first: beside the results when there is room, else a wide
  // card underneath the expanded list
  const rr = findResults.getBoundingClientRect();
  const roomR = innerWidth - rr.right - 24;
  const roomL = rr.left - 24;
  const sideRoom = Math.max(roomR, roomL);
  let clipW, clipH, px, py;
  if (sideRoom >= 340) {
    clipW = Math.max(260, Math.min(880, Math.floor(innerWidth * 0.52), sideRoom));
    clipH = Math.min(Math.floor(innerHeight * 0.72), 760);
    px = roomR >= roomL ? rr.right + 14 : rr.left - clipW - 14;
    px = clamp(px, 10, innerWidth - clipW - 10);
    py = clamp(rr.top, 12, Math.max(12, innerHeight - clipH - 40));
  } else {
    clipW = Math.min(innerWidth - 24, 880);
    py = rr.bottom + 12;
    clipH = Math.max(160, Math.min(Math.floor(innerHeight * 0.62), innerHeight - py - 14));
    if (py + clipH > innerHeight - 12) py = Math.max(12, innerHeight - clipH - 12);
    px = Math.round((innerWidth - clipW) / 2);
  }
  const cssWfull = clipW / crop.w;
  const fullH = cssWfull * (h / w);

  // the matched line's position on the page
  const pt = pageTexts[num - 1];
  let yTop = crop.y, lineH = 18;
  if (pt) {
    let itemIdx = 0;
    for (let i = 0; i < pt.cumStarts.length; i++) {
      if (pt.cumStarts[i] <= mt.start) itemIdx = i; else break;
    }
    const item = pt.items[itemIdx];
    yTop = 1 - (item.y + item.h) / h;
    lineH = Math.max(12, item.h * (cssWfull / w) * 1.8);
  }
  const minY = crop.y * fullH;
  const maxY = Math.max(minY, (crop.y + crop.h) * fullH - clipH);
  const offY = clamp(yTop * fullH - clipH * 0.38, minY, maxY);

  const needW = Math.ceil((clipW / crop.w) * clamp(window.devicePixelRatio || 1, 1, 2));
  const src = await renderThumbAt(num, needW).catch(() => null);
  if (!src || token !== fpToken || !state.find.open) return;

  findPeek.style.width = clipW + 'px';
  findPeek.querySelector('.fp-clip').style.height = clipH + 'px';
  fpCanvas.width = src.width;
  fpCanvas.height = src.height;
  fpCanvas.getContext('2d').drawImage(src, 0, 0);
  fpCanvas.style.width = cssWfull + 'px';
  fpCanvas.style.height = fullH + 'px';
  fpCanvas.style.left = -crop.x * cssWfull + 'px';
  fpCanvas.style.top = -offY + 'px';
  fpBand.style.top = (yTop * fullH - offY - lineH * 0.22) + 'px';
  fpBand.style.height = lineH + 'px';
  $('#fpPage').textContent = T.lpPage(num);

  findPeek.style.left = px + 'px';
  findPeek.style.top = py + 'px';
  findPeek.classList.add('open');
}

function hideFindPeek() {
  fpToken++;
  findPeek.classList.remove('open');
}

findResults.addEventListener('mouseleave', hideFindPeek);

// a click anywhere outside the find UI dismisses it
document.addEventListener('click', (e) => {
  if (state.find.open && !e.target.closest('#findWrap')) closeFind();
});

$('#findPrev').addEventListener('click', () => goToMatch(state.find.current - 1));
$('#findNext').addEventListener('click', () => goToMatch(state.find.current + 1));
$('#findClose').addEventListener('click', () => closeFind());

/* ---------------- hyperlinks & destination preview ---------------- */

const linkPreview = $('#linkPreview');
const lpCanvas = linkPreview.querySelector('canvas');
const lpClip = linkPreview.querySelector('.lp-clip');
let lpTarget = null;   // { page, yRatio }
let lpToken = 0;

function paintLinks(num) {
  const shell = state.shells[num - 1];
  const rec = state.recs[num - 1];
  if (!shell || !rec || !Array.isArray(rec.links)) return;
  const layer = shell.querySelector('.link-layer');
  layer.innerHTML = '';
  const { w, h } = state.pageSizes[num - 1];
  for (const a of rec.links) {
    if (!a.rect) continue;
    const [x1, y1, x2, y2] = a.rect;
    const div = document.createElement('div');
    div.className = 'plink';
    div.style.left = (Math.min(x1, x2) / w) * 100 + '%';
    div.style.top = ((h - Math.max(y1, y2)) / h) * 100 + '%';
    div.style.width = (Math.abs(x2 - x1) / w) * 100 + '%';
    div.style.height = (Math.abs(y2 - y1) / h) * 100 + '%';
    if (a.url) {
      div.title = a.url;
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        native.openExternal(a.url);
      });
    } else if (a.dest) {
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        showLinkPreview(a.dest, e.clientX, e.clientY);
      });
    }
    layer.appendChild(div);
  }
}

/* dest array → { pageNum, yRatio } (yRatio measured from the page top) */
async function resolveDest(dest) {
  let d = dest;
  if (typeof d === 'string') d = await state.doc.getDestination(d);
  if (!d || !d[0]) return null;
  const idx = await state.doc.getPageIndex(d[0]);
  const pageNum = idx + 1;
  const { h } = state.pageSizes[idx];
  const kind = d[1] && d[1].name;
  let top = null;
  if (kind === 'XYZ') top = typeof d[3] === 'number' ? d[3] : null;
  else if (kind === 'FitH' || kind === 'FitBH') top = typeof d[2] === 'number' ? d[2] : null;
  return { pageNum, yRatio: top == null ? 0 : clamp(1 - top / h, 0, 1) };
}

let lpZoom = 1, lpOffX = 0, lpOffY = 0, lpBaseW = 0;
let lpCrop = null, lpPageNum = 0, lpClipW = 440, lpClipH = 320;

async function showLinkPreview(dest, cx, cy) {
  const token = ++lpToken;
  const target = await resolveDest(dest).catch(() => null);
  if (!target || token !== lpToken) return;
  lpTarget = { page: target.pageNum, yRatio: target.yRatio };

  const num = target.pageNum;
  // frame the content box, not the whole sheet — margins add nothing here
  const crop = await computeCrop(num).catch(() => null) || { x: 0, y: 0, w: 1, h: 1 };
  if (token !== lpToken) return;
  const { w, h } = state.pageSizes[num - 1];

  lpClipW = Math.min(1200, Math.floor(innerWidth * 0.68));
  lpClipH = Math.min(880, Math.floor(innerHeight * 0.58));
  linkPreview.style.width = lpClipW + 'px';
  lpClip.style.height = lpClipH + 'px';

  lpCrop = crop;
  lpPageNum = num;
  lpZoom = 1;
  lpBaseW = lpClipW / crop.w;
  const H = lpBaseW * (h / w);
  lpOffX = crop.x * lpBaseW;
  lpOffY = target.yRatio * H - lpClipH * 0.33; // target sits a third down — context above and below

  await lpRender(token);
  if (token !== lpToken) return;
  applyLpTransform();

  $('#lpPage').textContent = T.lpPage(num);
  let px = clamp(cx - lpClipW / 2, 12, innerWidth - lpClipW - 12);
  let py = cy + 16;
  if (py + lpClipH > innerHeight - 12) py = cy - lpClipH - 16;
  linkPreview.style.left = px + 'px';
  linkPreview.style.top = Math.max(12, py) + 'px';
  linkPreview.classList.add('open');
}

async function lpRender(token) {
  const { w } = state.pageSizes[lpPageNum - 1];
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  const scale = Math.min((lpBaseW * lpZoom / w) * dpr, 3600 / w);
  const page = await state.doc.getPage(lpPageNum);
  if (token !== lpToken) return;
  const vp = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  try {
    await page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp }).promise;
  } catch { return; }
  if (token !== lpToken) return;
  lpCanvas.width = off.width;
  lpCanvas.height = off.height;
  lpCanvas.getContext('2d').drawImage(off, 0, 0);
}

function applyLpTransform() {
  const { w, h } = state.pageSizes[lpPageNum - 1];
  const W = lpBaseW * lpZoom;
  const H = W * (h / w);
  const minX = lpCrop.x * W, maxX = Math.max(minX, (lpCrop.x + lpCrop.w) * W - lpClipW);
  const minY = lpCrop.y * H, maxY = Math.max(minY, (lpCrop.y + lpCrop.h) * H - lpClipH);
  lpOffX = clamp(lpOffX, minX, maxX);
  lpOffY = clamp(lpOffY, minY, maxY);
  lpCanvas.style.width = W + 'px';
  lpCanvas.style.height = H + 'px';
  lpCanvas.style.left = -lpOffX + 'px';
  lpCanvas.style.top = -lpOffY + 'px';
}

const lpSharpen = debounce(() => {
  if (linkPreview.classList.contains('open')) lpRender(lpToken);
}, 240);

function closeLinkPreview() {
  lpToken++;
  linkPreview.classList.remove('open');
  lpTarget = null;
}

lpClip.addEventListener('click', () => {
  if (!lpTarget) return;
  scrollToPageAt(lpTarget.page, lpTarget.yRatio);
  closeLinkPreview();
});

/* wheel pans the peek window; pinch (or ⌘+wheel) zooms around the pointer */
lpClip.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!linkPreview.classList.contains('open')) return;
  if (e.ctrlKey || e.metaKey) {
    const rect = lpClip.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const z = clamp(lpZoom * Math.exp(-clamp(e.deltaY, -32, 32) * 0.0058), 0.5, 4);
    const k = z / lpZoom;
    if (k === 1) return;
    lpZoom = z;
    lpOffX = (lpOffX + px) * k - px;
    lpOffY = (lpOffY + py) * k - py;
    applyLpTransform();
    lpSharpen();
  } else {
    lpOffX += e.deltaX;
    lpOffY += e.deltaY;
    applyLpTransform();
  }
}, { passive: false });

/* ---------------- tools ---------------- */

function setTool(t) {
  state.tool = t;
  body.classList.remove('tool-highlight', 'tool-note', 'tool-active');
  if (t !== 'cursor') {
    body.classList.add('tool-' + t, 'tool-active');
  }
  document.querySelectorAll('#toolbar .tool').forEach((b) => {
    b.classList.toggle('on', b.dataset.tool === t);
  });
}

document.querySelectorAll('#toolbar .tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

document.querySelectorAll('#swatches .swatch').forEach((b) => {
  b.addEventListener('click', () => {
    state.color = b.dataset.color;
    document.querySelectorAll('#swatches .swatch').forEach((s) => s.classList.toggle('on', s === b));
  });
});

/* ---------------- highlights ---------------- */

function paintHighlights(num, shell) {
  shell = shell || state.shells[num - 1];
  if (!shell) return;
  const layer = shell.querySelector('.hl-layer');
  layer.innerHTML = '';
  for (const h of state.annots.highlights) {
    if (h.page !== num) continue;
    for (const r of h.rects) {
      const div = document.createElement('div');
      div.className = 'hl';
      div.style.left = r.x * 100 + '%';
      div.style.top = r.y * 100 + '%';
      div.style.width = r.w * 100 + '%';
      div.style.height = r.h * 100 + '%';
      div.style.background = h.color;
      div.dataset.group = h.group;
      layer.appendChild(div);
    }
  }
}

function repaintGroup(group) {
  const pages = new Set(state.annots.highlights.filter((h) => h.group === group).map((h) => h.page));
  for (const p of pages) paintHighlights(p);
}

scroller.addEventListener('mouseup', () => {
  if (state.tool !== 'highlight') return;
  setTimeout(createHighlightFromSelection, 0);
});

function createHighlightFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const text = sel.toString().trim();

  const rects = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    rects.push(...sel.getRangeAt(i).getClientRects());
  }

  const group = uid();
  const touched = new Set();

  for (const num of state.active) {
    const shell = state.shells[num - 1];
    const pr = shell.getBoundingClientRect();          // visible clip
    const sr = shell.firstElementChild.getBoundingClientRect(); // full page sheet
    let pageRects = [];
    for (const r of rects) {
      if (r.width < 2 || r.height < 2) continue;
      const ix = Math.max(r.left, pr.left);
      const iy = Math.max(r.top, pr.top);
      const ax = Math.min(r.right, pr.right);
      const ay = Math.min(r.bottom, pr.bottom);
      if (ax - ix < 2 || ay - iy < 2) continue;
      if ((ax - ix) * (ay - iy) < r.width * r.height * 0.5) continue;
      pageRects.push({
        x: clamp((ix - sr.left) / sr.width, 0, 1),
        y: clamp((iy - sr.top) / sr.height, 0, 1),
        w: clamp((ax - ix) / sr.width, 0, 1),
        h: clamp((ay - iy) / sr.height, 0, 1),
      });
    }
    pageRects = mergeLineRects(pageRects);
    if (pageRects.length) {
      state.annots.highlights.push({
        id: uid(), group, page: num, color: state.color, rects: pageRects,
        text: text.slice(0, 400), created: Date.now(),
      });
      touched.add(num);
    }
  }

  if (touched.size) {
    const created = state.annots.highlights
      .filter((h) => h.group === group)
      .map((h) => ({ ...h, rects: h.rects.map((r) => ({ ...r })) }));
    const pages = [...touched];
    pushUndo({
      undo: () => {
        state.annots.highlights = state.annots.highlights.filter((h) => h.group !== group);
        for (const p of pages) paintHighlights(p);
        saveAnnots();
      },
      redo: () => {
        state.annots.highlights.push(...created.map((h) => ({ ...h, rects: h.rects.map((r) => ({ ...r })) })));
        for (const p of pages) paintHighlights(p);
        saveAnnots();
      },
    });
    for (const p of touched) paintHighlights(p);
    saveAnnots();
    sel.removeAllRanges();
  }
}

/* one clean rect per text line — overlapping fragments would double-tint */
function mergeLineRects(rects) {
  const rows = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y)) {
    const row = rows.find((q) =>
      Math.min(q.y + q.h, r.y + r.h) - Math.max(q.y, r.y) > 0.5 * Math.min(q.h, r.h));
    if (row) {
      const x2 = Math.max(row.x + row.w, r.x + r.w);
      const y2 = Math.max(row.y + row.h, r.y + r.h);
      row.x = Math.min(row.x, r.x);
      row.y = Math.min(row.y, r.y);
      row.w = x2 - row.x;
      row.h = y2 - row.y;
    } else {
      rows.push({ ...r });
    }
  }
  return rows;
}

/* highlight popover */
const hlPopover = $('#hlPopover');
let hlCurrentGroup = null;

pagesEl.addEventListener('click', (e) => {
  if (state.tool === 'note') return;
  // the text layer sits above highlights — hit-test through the stack
  let hl = e.target.closest('.hl');
  if (!hl) {
    hl = document.elementsFromPoint(e.clientX, e.clientY)
      .find((el) => el.classList && el.classList.contains('hl'));
  }
  if (!hl) return;
  e.stopPropagation();
  hlCurrentGroup = hl.dataset.group;
  const g = state.annots.highlights.find((h) => h.group === hlCurrentGroup);
  hlPopover.querySelectorAll('.swatch').forEach((s) => {
    s.classList.toggle('on', g && s.dataset.color === g.color);
  });
  openPopover(hlPopover, e.clientX, e.clientY);
});

hlPopover.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    const group = hlCurrentGroup;
    const before = state.annots.highlights
      .filter((h) => h.group === group)
      .map((h) => ({ id: h.id, color: h.color }));
    const after = b.dataset.color;
    state.annots.highlights.forEach((h) => {
      if (h.group === group) h.color = after;
    });
    pushUndo({
      undo: () => {
        for (const p of before) {
          const h = state.annots.highlights.find((x) => x.id === p.id);
          if (h) h.color = p.color;
        }
        repaintGroup(group);
        saveAnnots();
      },
      redo: () => {
        state.annots.highlights.forEach((h) => { if (h.group === group) h.color = after; });
        repaintGroup(group);
        saveAnnots();
      },
    });
    hlPopover.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === b));
    repaintGroup(group);
    saveAnnots();
  });
});

$('#hlDelete').addEventListener('click', () => {
  const group = hlCurrentGroup;
  const removed = state.annots.highlights
    .filter((h) => h.group === group)
    .map((h) => ({ ...h, rects: h.rects.map((r) => ({ ...r })) }));
  const pages = [...new Set(removed.map((h) => h.page))];
  state.annots.highlights = state.annots.highlights.filter((h) => h.group !== group);
  pushUndo({
    undo: () => {
      state.annots.highlights.push(...removed.map((h) => ({ ...h, rects: h.rects.map((r) => ({ ...r })) })));
      for (const p of pages) paintHighlights(p);
      saveAnnots();
    },
    redo: () => {
      state.annots.highlights = state.annots.highlights.filter((h) => h.group !== group);
      for (const p of pages) paintHighlights(p);
      saveAnnots();
    },
  });
  for (const p of pages) paintHighlights(p);
  saveAnnots();
  closeAllPopovers();
});

/* ---------------- sticky notes ---------------- */

function paintNotes(num, shell) {
  shell = shell || state.shells[num - 1];
  if (!shell) return;
  const layer = shell.querySelector('.note-layer');
  layer.innerHTML = '';
  for (const n of state.annots.notes) {
    if (n.page !== num) continue;
    const pin = document.createElement('button');
    pin.className = 'note-pin';
    pin.style.left = n.x * 100 + '%';
    pin.style.top = n.y * 100 + '%';
    pin.dataset.id = n.id;
    pin.title = n.text ? n.text.slice(0, 80) : T.noteTitle;
    pin.addEventListener('mousedown', (e) => startPinDrag(e, n, pin));
    layer.appendChild(pin);
  }
}

const notePopover = $('#notePopover');
const noteText = $('#noteText');
let noteCurrent = null;

pagesEl.addEventListener('click', (e) => {
  const pin = e.target.closest('.note-pin');
  if (pin) {
    e.stopPropagation();
    if (pin.dataset.dragged) return; // that click was the end of a drag
    const note = state.annots.notes.find((n) => n.id === pin.dataset.id);
    if (note) openNote(note, pin);
    return;
  }
  if (state.tool !== 'note') return;
  const shell = e.target.closest('.page');
  if (!shell || e.target.closest('.hl')) return;
  e.stopPropagation(); // the same click must not reach the close-popovers handler
  const sr = shell.querySelector('.sheet').getBoundingClientRect();
  const note = {
    id: uid(),
    page: +shell.dataset.page,
    x: clamp((e.clientX - sr.left) / sr.width, 0, 1),
    y: clamp((e.clientY - sr.top) / sr.height, 0, 1),
    text: '',
    created: Date.now(),
  };
  state.annots.notes.push(note);
  pushUndo({
    undo: () => {
      if (noteCurrent && noteCurrent.id === note.id) closeAllPopovers();
      state.annots.notes = state.annots.notes.filter((n) => n.id !== note.id);
      paintNotes(note.page);
      saveAnnots();
    },
    redo: () => {
      state.annots.notes.push(note);
      paintNotes(note.page);
      saveAnnots();
    },
  });
  saveAnnots();
  paintNotes(note.page);
  const newPin = state.shells[note.page - 1].querySelector(`.note-pin[data-id="${note.id}"]`);
  openNote(note, newPin);
});

/* drag a pin to move the note; a still click keeps opening the popover */
function startPinDrag(e, note, pin) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const shell = state.shells[note.page - 1];
  const sr = shell.querySelector('.sheet').getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const ox = note.x, oy = note.y;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
    moved = true;
    pin.dataset.dragged = '1';
    note.x = clamp(ox + (ev.clientX - startX) / sr.width, 0, 1);
    note.y = clamp(oy + (ev.clientY - startY) / sr.height, 0, 1);
    pin.style.left = note.x * 100 + '%';
    pin.style.top = note.y * 100 + '%';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) return;
    const nx = note.x, ny = note.y;
    pushUndo({
      undo: () => { note.x = ox; note.y = oy; paintNotes(note.page); saveAnnots(); },
      redo: () => { note.x = nx; note.y = ny; paintNotes(note.page); saveAnnots(); },
    });
    saveAnnots();
    setTimeout(() => { delete pin.dataset.dragged; }, 0);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

let noteOpenSnapshot = null; // text at popover open — one undo entry per edit session

function openNote(note, pin) {
  // moving on from an untouched note discards it — no stray pins left behind
  if (noteCurrent && noteCurrent !== note && !noteCurrent.text.trim()) {
    removeNote(noteCurrent);
  }
  noteCurrent = note;
  noteOpenSnapshot = { id: note.id, text: note.text || '' };
  // repaints may have replaced the pin element — resolve a live one by id
  const shell = state.shells[note.page - 1];
  const livePin = shell && shell.querySelector(`.note-pin[data-id="${note.id}"]`);
  if (livePin) pin = livePin;
  noteText.value = note.text || '';
  const d = new Date(note.created);
  $('#noteDate').textContent =
    `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  document.querySelectorAll('.note-pin.open').forEach((p) => p.classList.remove('open'));
  if (pin) pin.classList.add('open');
  const r = pin ? pin.getBoundingClientRect() : { right: innerWidth / 2, top: innerHeight / 2 };
  openPopover(notePopover, r.right + 10, r.top - 8, true);
  noteText.focus();
}

noteText.addEventListener('input', () => {
  if (!noteCurrent) return;
  noteCurrent.text = noteText.value;
  saveAnnots();
});

$('#noteDelete').addEventListener('click', () => {
  if (!noteCurrent) return;
  const snap = { ...noteCurrent };
  removeNote(noteCurrent);
  if (snap.text && snap.text.trim()) {
    pushUndo({
      undo: () => { state.annots.notes.push({ ...snap }); paintNotes(snap.page); saveAnnots(); },
      redo: () => {
        state.annots.notes = state.annots.notes.filter((n) => n.id !== snap.id);
        paintNotes(snap.page);
        saveAnnots();
      },
    });
  }
  closeAllPopovers();
});

function removeNote(note) {
  state.annots.notes = state.annots.notes.filter((n) => n.id !== note.id);
  saveAnnots();
  paintNotes(note.page);
  noteCurrent = null;
}

/* ---------------- popovers ---------------- */

function openPopover(el, x, y, anchorLeft = false) {
  el.classList.add('open');
  const w = el.offsetWidth, h = el.offsetHeight;
  let px = anchorLeft ? x : x - w / 2;
  let py = y + 14;
  if (py + h > innerHeight - 12) py = y - h - 14;
  px = clamp(px, 10, innerWidth - w - 10);
  py = clamp(py, 10, innerHeight - h - 10);
  el.style.left = px + 'px';
  el.style.top = py + 'px';
}

function closeAllPopovers() {
  // an empty note disappears when closed — nothing half-written left behind
  if (noteCurrent && !noteCurrent.text.trim() && notePopover.classList.contains('open')) {
    removeNote(noteCurrent);
  } else if (noteCurrent && noteOpenSnapshot && noteOpenSnapshot.id === noteCurrent.id &&
             noteOpenSnapshot.text !== noteCurrent.text) {
    const n = noteCurrent, before = noteOpenSnapshot.text, after = n.text;
    pushUndo({
      undo: () => { n.text = before; paintNotes(n.page); saveAnnots(); },
      redo: () => { n.text = after; paintNotes(n.page); saveAnnots(); },
    });
  }
  noteOpenSnapshot = null;
  noteCurrent = null;
  hlCurrentGroup = null;
  document.querySelectorAll('.popover.open').forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('.note-pin.open').forEach((p) => p.classList.remove('open'));
  closeLinkPreview();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.hl') &&
      !e.target.closest('.note-pin') && !e.target.closest('#linkPreview')) {
    closeAllPopovers();
  }
});

/* ---------------- print (⌘P) ---------------- */
/* A small sheet drops in: which pages, whether your highlights and notes come
   along, whether to trim the margins for bigger text on paper — beside a live
   preview of the sheet of paper that you can riffle by sweeping across it.
   ↩ renders the pages sharp (300 dpi for a paper's worth of pages) and hands
   them to the system print dialog, which owns printer, copies, duplex and
   Save as PDF. */

const printSheet = $('#printSheet');
const printRoot = $('#printRoot');
const psPaper = printSheet.querySelector('.ps-paper');
const psCanvas = psPaper.querySelector('canvas');
const psCustom = $('#psCustom');
const printState = { range: 'all', custom: '', annots: true, trim: false, token: 0, idx: 0, cache: new Map(), tab: null };
const PRINT_MAX_PX = 5000;               // longest side of one page bitmap
const PREVIEW_W = 148, PREVIEW_H = 200;  // the preview paper's box
const TRIM_MARGIN = 0.4 * 72;            // pt — trimmed content stays off the paper's edge

const hasPrintableAnnots = () =>
  state.annots.highlights.length > 0 || state.annots.notes.some((n) => n.text && n.text.trim());
const printAnnotsOn = () => printState.annots && hasPrintableAnnots();

function openPrint() {
  if (!state.doc || body.classList.contains('print-open') || body.classList.contains('print-busy')) return;
  closeAllPopovers();
  closeFind();
  toggleToc(false);
  hideTabCard();
  body.classList.remove('menu-open', 'tl-zone', 'toc-zone', 'menu-zone', 'tb-zone', 'scrub-zone', 'tabs-show');
  printState.cache.clear();
  printState.idx = 0;
  if (printState.tab !== activeTab) { // a page range belongs to its document; the toggles carry over
    printState.tab = activeTab;
    printState.range = 'all';
    printState.custom = '';
  }
  printSheet.classList.toggle('no-annots', !hasPrintableAnnots());
  $('#psDoc').textContent = tabTitle(activeTab);
  psCustom.value = printState.custom;
  body.classList.add('print-open');
  syncPrintUI();
}

function closePrint() {
  if (!body.classList.contains('print-open') && !body.classList.contains('print-busy')) return;
  printState.token++; // stops a preparation in flight
  body.classList.remove('print-open', 'print-busy');
  psCustom.blur();
}

/* "1-5, 8, 11-" → [1,2,3,4,5,8,11…n]; Chinese punctuation welcome; null if invalid */
function parseRange(str, n) {
  const parts = str.replace(/\s*[-\u2013\u2014~\uff5e]\s*/g, '-').split(/[\s,\uff0c\u3001;\uff1b]+/).filter(Boolean);
  if (!parts.length) return null;
  const pages = new Set();
  for (const part of parts) {
    const m = /^(\d*)-(\d*)$/.exec(part);
    let a, b;
    if (m && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; } // "-5" from 1, "11-" to the end
    else if (/^\d+$/.test(part)) a = b = +part;
    else return null;
    if (a < 1 || a > n || b < a) return null;
    for (let p = a; p <= Math.min(b, n); p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

function printPages() {
  const n = state.doc.numPages;
  if (printState.range === 'current') return [state.currentPage];
  if (printState.range === 'custom') return parseRange(printState.custom, n);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/* notes with something written, in reading order — their numbers mark the
   pins on the page and the entries of the notes appendix */
function printNotes(pages) {
  const set = new Set(pages);
  return state.annots.notes
    .filter((n) => set.has(n.page) && n.text && n.text.trim())
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
const noteNumbers = (pages) => new Map(printNotes(pages).map((n, i) => [n.id, i + 1]));

function syncPrintUI() {
  printSheet.querySelectorAll('#psRange button').forEach((b) => {
    b.classList.toggle('on', b.dataset.range === printState.range);
  });
  printSheet.classList.toggle('custom', printState.range === 'custom');
  $('#psAnnots .switch').classList.toggle('on', printState.annots);
  $('#psTrim .switch').classList.toggle('on', printState.trim);
  const pages = printPages();
  const typed = printState.custom.trim() !== '';
  psCustom.classList.toggle('bad', printState.range === 'custom' && typed && !pages);
  const notes = pages && printAnnotsOn() ? printNotes(pages).length : 0;
  $('#psSummary').textContent = pages
    ? T.pageCount(pages.length) + (notes ? T.plusNotes : '')
    : (typed ? T.badRange : '');
  $('#psGo').disabled = !pages;
  printState.idx = pages ? clamp(printState.idx, 0, pages.length - 1) : 0;
  drawPrintPreview();
}

let psToken = 0;

async function drawPrintPreview() {
  const token = ++psToken;
  const pages = printPages();
  psPaper.classList.toggle('multi', !!pages && pages.length > 1);
  if (!pages || !pages.length) {
    psPaper.classList.add('empty');
    $('#psBadge').textContent = '';
    return;
  }
  const num = pages[printState.idx];
  $('#psBadge').textContent = pages.length > 1
    ? `${T.lpPage(num)} · ${printState.idx + 1}/${pages.length}`
    : T.lpPage(num);
  // the paper takes the first printed page's size, as it will on the printer
  const paper = state.pageSizes[pages[0] - 1];
  const k = Math.min(PREVIEW_W / paper.w, PREVIEW_H / paper.h);
  const pw = Math.round(paper.w * k), ph = Math.round(paper.h * k);
  psPaper.style.width = pw + 'px';
  psPaper.style.height = ph + 'px';
  const annots = printAnnotsOn();
  const key = [num, annots, printState.trim, pages[0], pages.length, printState.range].join('|');
  let sheet = printState.cache.get(key);
  if (!sheet) {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const content = await renderPrintPage(num, {
      width: pw * dpr, annots, trim: printState.trim, noteNums: annots ? noteNumbers(pages) : null,
    }).catch(() => null);
    if (!content || token !== psToken) return;
    sheet = layOnPaper(content, pw * dpr, ph * dpr, paper, printState.trim);
    printState.cache.set(key, sheet);
  }
  if (token !== psToken) return;
  psPaper.classList.remove('empty');
  blit(psCanvas, sheet);
}

/* the page as it lands on paper — the same rules as the print stylesheet:
   a page fills the sheet; trimmed content is scaled up inside a margin */
function layOnPaper(content, W, H, paper, trimmed) {
  const c = document.createElement('canvas');
  c.width = Math.round(W);
  c.height = Math.round(H);
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const m = trimmed ? TRIM_MARGIN * (c.width / paper.w) : 0;
  const s = Math.min((c.width - 2 * m) / content.width, (c.height - 2 * m) / content.height);
  const dw = content.width * s, dh = content.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(content, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  return c;
}

/* one page as a bitmap for paper: rendered with the print intent (form fields
   and print-only annotations included), your highlights multiplied in like real
   ink, numbered note pins on top — cut to its content box when trimming */
async function renderPrintPage(num, opt) {
  const doc = state.doc;
  const { w, h } = state.pageSizes[num - 1];
  let box = { x: 0, y: 0, w: 1, h: 1 };
  if (opt.trim) {
    const c = await computeCrop(num).catch(() => null);
    if (c && c.w > 0 && c.h > 0 && (c.w < 1 || c.h < 1)) box = c;
  }
  const rw = w * box.w, rh = h * box.h; // the printed region, in points
  let scale = opt.dpi
    ? (opt.dpi / 72) * Math.min(opt.fit.w / rw, opt.fit.h / rh) // dpi as it lands on paper
    : opt.width / rw;
  scale = Math.min(scale, PRINT_MAX_PX / rw, PRINT_MAX_PX / rh);
  const page = await doc.getPage(num);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rw * scale));
  canvas.height = Math.max(1, Math.round(rh * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  const dx = box.x * vp.width, dy = box.y * vp.height;
  await page.render({
    canvasContext: ctx,
    viewport: vp,
    intent: 'print',
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    transform: dx || dy ? [1, 0, 0, 1, -dx, -dy] : null,
  }).promise;
  if (opt.annots) {
    ctx.save();
    ctx.translate(-dx, -dy);
    paintPrintAnnots(ctx, num, vp.width, vp.height, scale, opt.noteNums);
    ctx.restore();
  }
  return canvas;
}

/* W×H: the full page in pixels; k: pixels per point */
function paintPrintAnnots(ctx, num, W, H, k, noteNums) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply'; // a true highlighter — the ink stays black
  for (const hl of state.annots.highlights) {
    if (hl.page !== num) continue;
    ctx.fillStyle = hl.color;
    for (const r of hl.rects) ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
  }
  ctx.restore();
  if (!noteNums) return;
  for (const n of state.annots.notes) {
    const label = noteNums.get(n.id);
    if (n.page !== num || !label) continue;
    const x = n.x * W, y = n.y * H, r = 6.5 * k;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f7b944';
    ctx.fill();
    ctx.lineWidth = 1.1 * k;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#3b2700';
    ctx.font = `600 ${(label > 9 ? 6.4 : 7.6) * k}px -apple-system, "Helvetica Neue", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label), x, y + 0.3 * k);
  }
}

/* the notes, spelled out after the last page */
function buildNotesPage(notes) {
  const sec = document.createElement('section');
  sec.className = 'print-notes';
  const h = document.createElement('h1');
  h.textContent = T.notesTitle;
  const doc = document.createElement('div');
  doc.className = 'pn-doc';
  doc.textContent = tabTitle(activeTab);
  const ol = document.createElement('ol');
  notes.forEach((n, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'pn-num';
    num.textContent = i + 1;
    const entry = document.createElement('div');
    const pg = document.createElement('div');
    pg.className = 'pn-page';
    pg.textContent = T.lpPage(n.page);
    const text = document.createElement('div');
    text.className = 'pn-text';
    text.textContent = n.text.trim();
    entry.append(pg, text);
    li.append(num, entry);
    ol.appendChild(li);
  });
  sec.append(h, doc, ol);
  return sec;
}

/* render the selection into a print job: a sheet per page, then the notes */
async function preparePrint(job, urls, pages, token) {
  const annots = printAnnotsOn();
  const notes = annots ? printNotes(pages) : [];
  const nums = new Map(notes.map((n, i) => [n.id, i + 1]));
  const dpi = pages.length <= 40 ? 300 : pages.length <= 150 ? 200 : 150; // sharp, within memory
  const paper = state.pageSizes[pages[0] - 1];
  const fit = printState.trim
    ? { w: paper.w - 2 * TRIM_MARGIN, h: paper.h - 2 * TRIM_MARGIN }
    : paper;
  $('#printPageStyle').textContent = `@page { size: ${paper.w}pt ${paper.h}pt; margin: 0; }`;
  printRoot.replaceChildren(job);
  for (let i = 0; i < pages.length; i++) {
    if (token !== printState.token) return false;
    $('#psSummary').textContent = T.preparing(i + 1, pages.length);
    progressEl.style.transform = `scaleX(${(i + 0.5) / pages.length})`;
    const c = await renderPrintPage(pages[i], { dpi, fit, annots, trim: printState.trim, noteNums: nums });
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    c.width = c.height = 0; // let the big bitmap go at once
    if (!blob) throw new Error(T.lpPage(pages[i]));
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const sheet = document.createElement('div');
    sheet.className = 'print-page' + (printState.trim ? ' trimmed' : '');
    const img = new Image();
    img.src = url;
    sheet.appendChild(img);
    job.appendChild(sheet);
    await img.decode().catch(() => {});
  }
  if (notes.length) job.appendChild(buildNotesPage(notes));
  progressEl.style.transform = 'scaleX(1)';
  return token === printState.token;
}

async function runPrint() {
  if (!body.classList.contains('print-open') || body.classList.contains('print-busy')) return;
  const pages = printPages();
  if (!pages || !pages.length) return;
  const token = ++printState.token;
  body.classList.add('print-busy');
  const job = document.createElement('div');
  job.className = 'print-job';
  const urls = [];
  try {
    if (!(await preparePrint(job, urls, pages, token))) return;
    body.classList.remove('print-open'); // the system dialog takes it from here —
    await new Promise((r) => setTimeout(r, 240)); // once the sheet has faded (printing freezes the page)
    if (token !== printState.token) return;
    const paper = state.pageSizes[pages[0] - 1];
    const res = await native.print({ landscape: paper.w > paper.h });
    if (res && !res.success && res.reason && !/cancel/i.test(res.reason)) alertToast(T.printFail + res.reason);
  } catch (err) {
    console.error('print failed:', err);
    alertToast(T.printFail + (err && err.message || err));
  } finally {
    job.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    if (token === printState.token) body.classList.remove('print-open', 'print-busy');
    progressEl.style.transform = 'scaleX(0)';
  }
}

$('#printVeil').addEventListener('click', closePrint);
$('#psCancel').addEventListener('click', closePrint);
$('#psGo').addEventListener('click', runPrint);
printSheet.querySelectorAll('#psRange button').forEach((b) => {
  b.addEventListener('click', () => {
    printState.range = b.dataset.range;
    printState.idx = 0;
    syncPrintUI();
    if (printState.range === 'custom') { psCustom.focus(); psCustom.select(); }
  });
});
psCustom.addEventListener('input', () => {
  printState.custom = psCustom.value;
  printState.idx = 0;
  syncPrintUI();
});
$('#psAnnots').addEventListener('click', () => { printState.annots = !printState.annots; syncPrintUI(); });
$('#psTrim').addEventListener('click', () => { printState.trim = !printState.trim; syncPrintUI(); });

// sweep across the paper to riffle through what will print
psPaper.addEventListener('mousemove', (e) => {
  const pages = printPages();
  if (!pages || pages.length < 2) return;
  const r = psPaper.getBoundingClientRect();
  const idx = clamp(Math.floor(((e.clientX - r.left) / r.width) * pages.length), 0, pages.length - 1);
  if (idx !== printState.idx) { printState.idx = idx; drawPrintPreview(); }
});

/* ---------------- keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);

  // the print sheet is modal: ↩ prints, Esc backs out, the reader underneath stays put
  if (body.classList.contains('print-open')) {
    if (e.key === 'Escape') { e.preventDefault(); closePrint(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPrint(); }
    return;
  }

  // tabs: ⌘1–⌘8 pick, ⌘9 the last, ⇧⌘[ ⇧⌘] or ⌥⌘← ⌥⌘→ step, ⌘T opens a new one
  // (⌃Tab, ⌘W, ⇧⌘T and ⌘P come through the app menu)
  if (e.metaKey && !e.ctrlKey) {
    if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const t = e.key === '9' ? tabs[tabs.length - 1] : tabs[+e.key - 1];
      if (t) { activateTab(t); flashTabs(); }
      return;
    }
    if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      stepTab(e.code === 'BracketRight' ? 1 : -1);
      return;
    }
    if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      stepTab(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (!e.shiftKey && !e.altKey && e.code === 'KeyT') {
      e.preventDefault();
      native.requestOpen();
      return;
    }
  }

  if (e.key === 'Escape') {
    closeAllPopovers();
    hideTabCard();
    body.classList.remove('menu-open');
    toggleToc(false);
    closeFind();
    pageJump.classList.remove('open');
    if (!typing) setTool('cursor');
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); openFind(); }
    else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      if (state.find.matches.length) goToMatch(state.find.current + (e.shiftKey ? -1 : 1));
    }
    if (typing) return; // native text-field undo/zoom stay untouched
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(state.zoom * 1.15); }
    else if (e.key === '-') { e.preventDefault(); setZoom(state.zoom / 1.15); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (e.key === 'z') { e.preventDefault(); doUndo(); }
    else if (e.key === 'Z') { e.preventDefault(); doRedo(); }
    return;
  }
  if (typing) return;

  // reading keys — the document scrolls without needing focus
  const horiz = state.mode === 'h';
  const pageStep = (horiz ? scroller.clientWidth : scroller.clientHeight) * 0.9;
  const step = (amt) => {
    if (horiz) scroller.scrollLeft += amt;
    else scroller.scrollTop += amt;
  };
  if (e.key === 'ArrowDown') { e.preventDefault(); step(76); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); step(-76); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); scrollToPage(Math.min(state.currentPage + 1, state.doc ? state.doc.numPages : 1)); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); scrollToPage(Math.max(state.currentPage - 1, 1)); return; }
  if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); step(pageStep); return; }
  if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); step(-pageStep); return; }
  if (e.key === 'Home') { e.preventDefault(); if (state.doc) scrollToPage(1, false); return; }
  if (e.key === 'End') { e.preventDefault(); if (state.doc) scrollToPage(state.doc.numPages, false); return; }

  switch (e.key) {
    case '1': setMode(1); break;
    case '2': setMode(2); break;
    case '3': setMode(3); break;
    case '4': setMode('h'); break;
    case 't': case 'T': tocPinned = true; toggleToc(); break;
    case 'v': case 'V': setTool('cursor'); break;
    case 'h': case 'H': setTool('highlight'); break;
    case 'n': case 'N': setTool('note'); break;
  }
});

/* ---------------- drag & drop ---------------- */

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  body.classList.add('dragging');
  flashTabs(900); // the strip shows where the drop will land: a new tab
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])].filter((f) => /\.pdf$/i.test(f.name));
  // every dropped PDF becomes a tab in this window; the first comes to the front
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let p = null;
    try { p = native.pathForFile && native.pathForFile(f); } catch {}
    if (p) native.openPath(p, i === 0); // main checks it isn't open elsewhere already
    else openPdf(new Uint8Array(await f.arrayBuffer()), f.name, null, i === 0);
  }
});

/* ---------------- native events ---------------- */

native.onIncoming && native.onIncoming(() => body.classList.add('loading'));
native.onOpen(({ name, data, path, activate, view, land }) => {
  const slot = land ? takeLanding() : null; // carried in from another window: into the slot it was set down in
  const t = openPdf(data, name, path || null, activate !== false, { at: slot && slot.index, view });
  if (slot) {
    settleFrom(tabEls.get(t.id), slot.left);
    setTabsShown(true);
  }
});
native.onDrag((m) => {
  if (m.type === 'over') landingOver(m);
  else if (m.type === 'leave') landingLeave();
  else if (m.type === 'return') { // pulled out, then set back down in its own strip
    const slot = takeLanding();
    const t = plucked && plucked.tab;
    unpluck(slot && slot.index);
    if (slot && t) settleFrom(tabEls.get(t.id), slot.left);
    setTabsShown(true);
  } else if (m.type === 'restore') unpluck(null);
  else if (m.type === 'gone') letGo();
  else if (m.type === 'held') body.classList.add('tab-held'); // a new window carried by its tab
  else if (m.type === 'free') { body.classList.remove('tab-held'); setTabsShown(true); }
});
native.onPeers((n) => { peers = n; renderTabs(); });
native.onOpenFailed(() => {
  if (!tabs.some((t) => t.loading)) body.classList.remove('loading');
});
native.onCommand((cmd, arg) => {
  if (cmd === 'tab-close') {
    if (activeTab) closeTab(activeTab);
    else if (tabs.length) closeTab(tabs[tabs.length - 1]);
    else native.close();
  } else if (cmd === 'tab-step') stepTab(arg);
  else if (cmd === 'tab-reopen') reopenClosedTab();
  else if (cmd === 'tab-activate-path') {
    const t = tabs.find((x) => x.path === arg);
    if (t) { activateTab(t); flashTabs(); }
  } else if (cmd === 'print') {
    if (body.classList.contains('print-open')) runPrint(); // ⌘P twice: straight on to the dialog
    else openPrint();
  }
});

syncTabs(); // a fresh page holds no tabs — main's bookkeeping starts clean too
wakeChrome();
