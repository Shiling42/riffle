/* 轻阅 · renderer */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.js', location.href).href;

const $ = (s) => document.querySelector(s);
const scroller = $('#scroller');
const pagesEl = $('#pages');
const body = document.body;

const state = {
  doc: null,
  name: '',
  path: '',               // absolute file path, '' when opened from raw data
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
  shelf: '文稿架', shelfKey: '文稿架 (D)',
  shelfEmpty: '拖入 PDF，即可放到文稿架上；点击卡片随时切换文档',
  pinDoc: '固定 — 不会被自动清理', unpinDoc: '取消固定', removeDoc: '从文稿架移除',
  openNewWin: '在新窗口打开', flipPrev: '封面上一页', flipNext: '封面下一页',
  fileMissing: '找不到文件，可能已被移动或删除',
  lastOpened: (d) => `上次打开：${d}`,
  addDoc: '添加 PDF…', perRow: (n) => `每行 ${n} 张（点击切换）`, tidy: '一键对齐',
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
  shelf: 'DESK', shelfKey: 'Desk (D)',
  shelfEmpty: 'Drop PDFs to keep them on the desk; click a card to switch documents',
  pinDoc: 'Pin — never auto-cleared', unpinDoc: 'Unpin', removeDoc: 'Remove from desk',
  openNewWin: 'Open in new window', flipPrev: 'Previous cover page', flipNext: 'Next cover page',
  fileMissing: 'File not found — it may have been moved or deleted',
  lastOpened: (d) => `Last opened ${d}`,
  addDoc: 'Add PDF…', perRow: (n) => `${n} per row (click to cycle)`, tidy: 'Tidy up',
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
  $('#shelfHandle').title = T.shelfKey;
  $('#shelf header').textContent = T.shelf;
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

const saveAnnots = debounce(() => {
  if (state.fp) localStorage.setItem(`qy:annots:${state.fp}`, JSON.stringify(state.annots));
}, 300);

const savePrefs = debounce(() => {
  if (state.fp) {
    localStorage.setItem(`qy:prefs:${state.fp}`, JSON.stringify({
      mode: state.mode, zoom: state.zoom, page: state.currentPage, trim: state.trim,
    }));
  }
}, 300);

const saveCrops = debounce(() => {
  if (state.fp) localStorage.setItem(`qy:crops:${state.fp}`, JSON.stringify(state.crops));
}, 300);

function loadPersisted() {
  try {
    const a = localStorage.getItem(`qy:annots:${state.fp}`);
    state.annots = a ? JSON.parse(a) : { highlights: [], notes: [] };
    // sweep out empty notes a crashed/quit session may have left behind
    state.annots.notes = (state.annots.notes || []).filter((n) => n.text && n.text.trim());
  } catch { state.annots = { highlights: [], notes: [] }; }
  try {
    const c = localStorage.getItem(`qy:crops:${state.fp}`);
    const arr = c ? JSON.parse(c) : [];
    state.crops = Array.isArray(arr) ? arr : [];
  } catch { state.crops = []; }
  try {
    const p = localStorage.getItem(`qy:prefs:${state.fp}`);
    return p ? JSON.parse(p) : null;
  } catch { return null; }
}

/* ---------------- document loading ---------------- */

const progressEl = $('#progress');

async function openPdf(data, name, path) {
  body.classList.add('loading');
  progressEl.style.transform = 'scaleX(0.05)';
  closeAllPopovers();

  try {
    const task = pdfjsLib.getDocument({ data });
    task.onProgress = ({ loaded, total }) => {
      if (total) progressEl.style.transform = `scaleX(${clamp(loaded / total, 0.05, 1)})`;
    };
    const doc = await task.promise;
    await activateDoc(doc, name || 'document.pdf', path || '');
  } catch (err) {
    console.error('open failed:', err);
    if (err && err.name === 'PasswordException') alertToast(T.pwProtected);
    else alertToast(T.openFail + (err && err.message || err));
  } finally {
    progressEl.style.transform = 'scaleX(1)';
    body.classList.remove('loading');
    setTimeout(() => { progressEl.style.transform = 'scaleX(0)'; }, 600);
  }
}

/* make `doc` the document this window shows; the previous one stays warm on the shelf */
let activateSeq = 0;

async function activateDoc(doc, name, path) {
  const seq = ++activateSeq;
  stashCurrentDoc();
  state.doc = doc;
  state.name = name;
  state.path = path || '';
  state.fp = (doc.fingerprints && doc.fingerprints[0]) || 'unknown';

  const prefs = loadPersisted();
  state.trim = false;
  if (prefs) {
    state.mode = MODES.includes(prefs.mode) ? prefs.mode : 1;
    state.zoom = clamp(prefs.zoom || 1, ZMIN, ZMAX);
    state.trim = !!prefs.trim;
  }

  const warm = liveDocs.get(currentKey());
  if (warm && warm.doc === doc && warm.pageSizes && warm.pageSizes.length === doc.numPages) {
    state.pageSizes = warm.pageSizes;
  } else {
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (seq !== activateSeq) return; // a later switch superseded this one
      const vp = page.getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
      if (i === 1 || i % 20 === 0) {
        progressEl.style.transform = `scaleX(${0.7 + 0.3 * (i / doc.numPages)})`;
      }
    }
    state.pageSizes = sizes;
  }

  $('#fileLabel').textContent = state.name.replace(/\.pdf$/i, '');
  document.title = state.name.replace(/\.pdf$/i, '') + ' — Riffle';
  body.classList.remove('no-doc');

  undoStack.length = 0;
  redoStack.length = 0;
  resetFind();
  resetScrub();
  buildShells();
  syncModeUI();
  syncZoomUI();
  syncTrimUI();
  layout();
  buildToc();
  updateIndicator();
  if (state.trim) sweepCrops();

  if (prefs && prefs.page > 1 && prefs.page <= doc.numPages) {
    scrollToPage(prefs.page, false);
  } else {
    scroller.scrollTop = 0;
  }
  registerShelfEntry(doc, name, state.path);
  if (native.docLoaded) native.docLoaded(); // this window now owns a document
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
  } else {
    const n = state.mode;
    pagesEl.style.gridAutoFlow = 'row';
    state.colW = Math.max(140, Math.floor((scroller.clientWidth / n) * state.zoom));
    pagesEl.style.gridTemplateColumns = `repeat(${n}, ${state.colW}px)`;
  }
  for (let i = 0; i < state.shells.length; i++) applyGeometry(i);

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
  const rec = state.recs[num - 1];
  const shell = state.shells[num - 1];

  if (state.trim && !state.crops[num - 1]) {
    await computeCrop(num);
    applyGeometry(num - 1);
  }
  const epoch = state.layoutEpoch;
  const targetW = Math.round(sheetWidthFor(num));
  if (rec.renderedW === targetW && rec.canvas) return;

  const page = await state.doc.getPage(num);
  if (!state.active.has(num) || state.layoutEpoch !== epoch) return;

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
      if (rec.textW !== targetW) return;
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
  if (state.crops[num - 1]) return state.crops[num - 1];
  const page = await state.doc.getPage(num);
  const { w } = state.pageSizes[num - 1];
  const vp = page.getViewport({ scale: 160 / w });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  try {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  } catch {
    return (state.crops[num - 1] = { x: 0, y: 0, w: 1, h: 1 });
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
  state.crops[num - 1] = crop;
  saveCrops();
  return crop;
}

let sweepToken = 0;

async function sweepCrops() {
  const token = ++sweepToken;
  const fp = state.fp;
  const total = state.doc.numPages;
  // visible pages first, then the rest quietly in the background
  const order = [...state.active];
  for (let i = 1; i <= total; i++) if (!state.active.has(i)) order.push(i);
  for (const num of order) {
    if (token !== sweepToken || state.fp !== fp || !state.trim) return;
    if (!state.crops[num - 1]) {
      await enqueue(num, () => computeCrop(num));
      if (state.active.has(num)) layout();
    }
  }
  if (token === sweepToken && state.fp === fp && state.trim) layout();
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

function resetScrub() {
  scrub.thumbs.clear();
  scrub.order.length = 0;
  scrub.pending.clear();
  scrub.hoverPage = 0;
  scrub.marks = [];
  scrub.history = [];
  centerFade.key = '';
  centerFade.pending = null;
  scrubFly.classList.remove('on');
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
  const fp = state.fp;
  const pr = (async () => {
    const page = await state.doc.getPage(p);
    const { w } = state.pageSizes[p - 1];
    const vp = page.getViewport({ scale: Math.min(wpx, 2000) / w });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
    if (state.fp !== fp) throw new Error('doc changed');
    scrub.thumbs.set(p, c);
    scrub.order.push(p);
    if (scrub.order.length > 24) scrub.thumbs.delete(scrub.order.shift());
    return c;
  })().finally(() => scrub.pending.delete(p));
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
  wakeChrome();
  body.classList.toggle('tl-zone', e.clientX < 170 && e.clientY < 80);
  body.classList.toggle('toc-zone', e.clientX < 44);
  body.classList.toggle('shelf-zone', e.clientX > innerWidth - 44);
  body.classList.toggle('menu-zone', e.clientX > innerWidth - 120 && e.clientY < 80);
  body.classList.toggle('tb-zone',
    e.clientY < 90 && Math.abs(e.clientX - innerWidth / 2) < 280);
  body.classList.toggle('scrub-zone', e.clientY > innerHeight - 64);

  // TOC: expands when the cursor reaches its handle, folds once it moves past the panel
  if (body.classList.contains('toc-open')) {
    if (!tocPinned && e.clientX > 344) toggleToc(false);
  } else if (state.doc && body.classList.contains('toc-zone') &&
             overRect(e, tocHandleBtn.getBoundingClientRect(), 4)) {
    tocPinned = false;
    toggleToc(true);
  }

  // shelf mirrors the TOC on the right edge
  if (body.classList.contains('shelf-open')) {
    if (!shelfPinned && !deskDragging && e.clientX < innerWidth - 360) toggleShelf(false);
  } else if ((state.doc || shelf.items.length) && body.classList.contains('shelf-zone') &&
             overRect(e, shelfHandleBtn.getBoundingClientRect(), 4)) {
    shelfPinned = false;
    toggleShelf(true);
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
document.addEventListener('mouseleave', () => {
  body.classList.remove('ui-active', 'tl-zone', 'toc-zone', 'shelf-zone', 'menu-zone', 'tb-zone', 'scrub-zone');
});

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

async function buildToc() {
  const list = $('#tocList');
  list.innerHTML = '';
  paintScrubTicks([]);
  let outline = null;
  try { outline = await state.doc.getOutline(); } catch {}
  if (!outline || !outline.length) {
    list.innerHTML = `<div class="toc-empty">${T.tocEmpty}</div>`;
    return;
  }
  const markJobs = []; // top-level chapters become notches on the scrubber
  const addItems = (items, level) => {
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'toc-item';
      btn.textContent = item.title || '·';
      btn.style.paddingLeft = 10 + level * 14 + 'px';
      btn.addEventListener('click', async () => {
        const num = await destToPage(item.dest);
        if (num) { scrollToPage(num); btn.dataset.gotoPage = num; }
      });
      resolveTocPage(item, btn);
      list.appendChild(btn);
      if (level === 0) {
        markJobs.push(destToPage(item.dest).then((n) => (n ? { page: n, title: item.title || '' } : null)));
      }
      if (item.items && item.items.length) addItems(item.items, level + 1);
    }
  };
  addItems(outline, 0);
  const fp = state.fp;
  Promise.all(markJobs).then((marks) => {
    if (state.fp === fp) paintScrubTicks(marks.filter(Boolean));
  });
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


async function resolveTocPage(item, btn) {
  const num = await destToPage(item.dest);
  if (num) btn.dataset.page = num;
}

async function destToPage(dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await state.doc.getDestination(d);
    if (!d || !d[0]) return null;
    const idx = await state.doc.getPageIndex(d[0]);
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
let textFp = null;

function normalizeChar(ch) {
  if (ch === '\u00AD') return ''; // soft hyphen
  return ch.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

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
  for (let i = 0; i < concat.length; i++) {
    const ch = concat[i];
    if (ch === '\n') {
      // a hyphen right before a line break joins the split word: "meth-\nod" → "method"
      if (i > 0 && /[-\u2010]/.test(concat[i - 1]) && norm.endsWith(concat[i - 1])) {
        norm = norm.slice(0, -1);
        map.pop();
        continue;
      }
      if (norm && !norm.endsWith(' ')) { norm += ' '; map.push(i); }
      continue;
    }
    const low = normalizeChar(ch);
    if (!low) continue;
    if (/^\s+$/.test(low)) {
      if (norm && !norm.endsWith(' ')) { norm += ' '; map.push(i); }
      continue;
    }
    for (const c of low) { norm += c; map.push(i); }
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
  if (textFp === state.fp && textPromise) return textPromise;
  textFp = state.fp;
  textPromise = (async () => {
    const fp = state.fp;
    const doc = state.doc;
    if (!doc) return;
    for (let i = 1; i <= doc.numPages; i++) {
      if (state.fp !== fp) return;
      if (!pageTexts[i - 1]) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        if (state.fp !== fp) return;
        pageTexts[i - 1] = buildPageText(tc);
      }
    }
  })();
  return textPromise;
}

function resetFind() {
  pageTexts = [];
  textPromise = null;
  textFp = null;
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

/* ---------------- keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);

  if (e.key === 'Escape') {
    closeAllPopovers();
    body.classList.remove('menu-open');
    toggleToc(false);
    toggleShelf(false);
    closeFind();
    pageJump.classList.remove('open');
    if (!typing) setTool('cursor');
    return;
  }

  // ⌃Tab flips to the previously shown document, like alt-tabbing between papers
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const target = docMru.find((k) =>
      k !== currentKey() && (liveDocs.has(k) || shelf.items.some((i) => i.key === k)));
    if (target) switchTo(target);
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
    case 'd': case 'D': shelfPinned = true; toggleShelf(); break;
    case 'v': case 'V': setTool('cursor'); break;
    case 'h': case 'H': setTool('highlight'); break;
    case 'n': case 'N': setTool('note'); break;
  }
});

/* ---------------- document shelf — right edge, a little desk of PDFs ----------------
   Every document that passes through the window lands here as a card.
   Cards can be freely arranged (desktop-style), show a chosen cover page,
   fade grey when untouched for a while, and unpinned ones are cleared
   from the shelf after seven days. Only shelf entries are cleared —
   the files on disk are never touched. */

/* each window is its own workspace — its desk never mixes with another's */
const WSID = new URLSearchParams(location.search).get('ws') || '1';
const SHELF_KEY = 'riffle:shelf:' + WSID;
const STALE_MS = 3 * 864e5;   // untouched this long → faded grey
const EXPIRE_MS = 7 * 864e5;  // untouched this long and unpinned → off the shelf
const LIVE_MAX = 4;           // documents kept parsed in memory
const DESK_PAD = 16, DESK_GAP = 14;
let deskCols = 2; // cards per row, 2–4, remembered per workspace
try { deskCols = clamp(parseInt(localStorage.getItem('riffle:deskcols:' + WSID), 10) || 2, 2, 4); } catch {}

function deskMetrics() {
  const w = (deskEl.clientWidth || 304) - 2 * DESK_PAD;
  const cw = Math.floor((w - (deskCols - 1) * DESK_GAP) / deskCols);
  const th = Math.round(cw * 1.21);
  return { cw, th, ch: th + 36 };
}

function slotRect(i, m) {
  return {
    x: DESK_PAD + (i % deskCols) * (m.cw + DESK_GAP),
    y: DESK_PAD + Math.floor(i / deskCols) * (m.ch + DESK_GAP),
  };
}

const shelfEl = $('#shelf');
const deskEl = $('#shelfDesk');
const shelfHandleBtn = $('#shelfHandle');
const shelf = { items: [] };  // [{key, path, name, fp, pages, lastOpened, pinned, thumbPage, pos}]
const liveDocs = new Map();   // key → {doc, name, path, pageSizes}
const thumbCache = new Map(); // key → {page, url}
const thumbJobs = new Map();
let docMru = [];              // most recently shown first
let shelfPinned = false;      // opened via keyboard — ignore hover-out closing
let deskDragging = false;

const currentKey = () => (state.doc ? (state.path || 'fp:' + state.fp) : '');

function stashCurrentDoc() {
  if (!state.doc) return;
  liveDocs.set(currentKey(), {
    doc: state.doc, name: state.name, path: state.path, pageSizes: state.pageSizes,
  });
}

function loadShelf() {
  try {
    let raw = localStorage.getItem(SHELF_KEY);
    // a desk from before workspaces existed belongs to window 1
    if (raw == null && WSID === '1') raw = localStorage.getItem('riffle:shelf');
    const arr = JSON.parse(raw || '[]');
    shelf.items = Array.isArray(arr) ? arr.filter((i) => i && i.key) : [];
  } catch { shelf.items = []; }
}

const saveShelf = debounce(() => {
  try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf.items)); } catch {}
}, 200);

function dropThumbSnapshot(key) {
  try { localStorage.removeItem('riffle:thumb:' + key); } catch {}
}

/* unpinned entries idle for a week leave the shelf (files on disk stay put) */
function sweepShelf() {
  const now = Date.now();
  const keep = [];
  for (const it of shelf.items) {
    const inUse = it.key === currentKey() || liveDocs.has(it.key);
    if (it.pinned || inUse || now - (it.lastOpened || 0) < EXPIRE_MS) keep.push(it);
    else dropThumbSnapshot(it.key);
  }
  if (keep.length !== shelf.items.length) {
    shelf.items = keep;
    saveShelf();
  }
}

/* keep only a handful of parsed documents in memory; evicted ones reload from disk */
function evictLiveDocs() {
  if (liveDocs.size <= LIVE_MAX) return;
  for (const k of [...docMru].reverse()) {
    if (liveDocs.size <= LIVE_MAX) break;
    if (k === currentKey()) continue;
    const e = liveDocs.get(k);
    if (!e || !e.path) continue; // path-less docs can't be reloaded — keep them
    try { e.doc.destroy(); } catch {}
    liveDocs.delete(k);
  }
}

/* called by activateDoc once a document is on screen */
function registerShelfEntry(doc, name, path) {
  const key = currentKey();
  let it = shelf.items.find((i) => i.key === key) ||
           (path && shelf.items.find((i) => i.fp === state.fp && !i.path)) || null;
  if (it && it.key !== key) { // a data-only entry learned its file path
    dropThumbSnapshot(it.key);
    thumbCache.delete(it.key);
    liveDocs.delete(it.key);
    docMru = docMru.filter((k) => k !== it.key);
    it.key = key;
  }
  if (!it) {
    it = { key, thumbPage: 1, pinned: false, pos: null };
    shelf.items.push(it);
  }
  it.path = path || it.path || '';
  it.name = name;
  it.fp = state.fp;
  it.pages = doc.numPages;
  it.lastOpened = Date.now();
  docMru = [key, ...docMru.filter((k) => k !== key)].slice(0, 20);
  const prev = liveDocs.get(key);
  if (prev && prev.doc !== doc) { try { prev.doc.destroy(); } catch {} }
  liveDocs.set(key, { doc, name, path: it.path, pageSizes: state.pageSizes });
  evictLiveDocs();
  saveShelf();
  renderShelf();
}

/* register a dropped file on the shelf without switching to it */
async function addToShelf(data, name, path) {
  try {
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const fp = (doc.fingerprints && doc.fingerprints[0]) || 'unknown';
    const key = path || 'fp:' + fp;
    if (key === currentKey()) { try { doc.destroy(); } catch {} return; }
    let it = shelf.items.find((i) => i.key === key);
    if (!it) {
      it = { key, thumbPage: 1, pinned: false, pos: null };
      shelf.items.push(it);
    }
    it.path = path || it.path || '';
    it.name = name;
    it.fp = fp;
    it.pages = doc.numPages;
    it.lastOpened = Date.now();
    const prev = liveDocs.get(key);
    if (prev && prev.doc !== doc) { try { prev.doc.destroy(); } catch {} }
    liveDocs.set(key, { doc, name, path: it.path, pageSizes: null });
    if (!docMru.includes(key)) docMru.push(key);
    evictLiveDocs();
    saveShelf();
    renderShelf();
  } catch (err) {
    console.warn('shelf add failed:', err);
  }
}

async function switchTo(key) {
  if (!key || key === currentKey()) return;
  const live = liveDocs.get(key);
  if (live) {
    await activateDoc(live.doc, live.name, live.path);
    return;
  }
  const it = shelf.items.find((i) => i.key === key);
  if (!it || !it.path || !native.readPdf) return;
  body.classList.add('loading');
  try {
    const data = await native.readPdf(it.path);
    await openPdf(data, it.name, it.path);
  } catch {
    body.classList.remove('loading');
    alertToast(T.fileMissing);
  }
}

function removeShelfItem(key) {
  shelf.items = shelf.items.filter((i) => i.key !== key);
  dropThumbSnapshot(key);
  thumbCache.delete(key);
  if (key !== currentKey()) {
    const live = liveDocs.get(key);
    if (live) { try { live.doc.destroy(); } catch {} liveDocs.delete(key); }
    docMru = docMru.filter((k) => k !== key);
  }
  saveShelf();
  renderShelf();
}

/* ----- card thumbnails: the chosen cover page, cached and persisted ----- */

function readSnapshot(key) {
  try {
    const s = localStorage.getItem('riffle:thumb:' + key);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

async function ensureThumb(item, img) {
  const want = clamp(item.thumbPage || 1, 1, item.pages || 1);
  const memo = thumbCache.get(item.key);
  if (memo && memo.page === want) { img.src = memo.url; return; }
  const snap = readSnapshot(item.key);
  if (snap && snap.page === want && snap.url) {
    thumbCache.set(item.key, snap);
    img.src = snap.url;
    return;
  }
  const jobKey = item.key + '@' + want;
  if (thumbJobs.has(jobKey)) return;
  const job = (async () => {
    let doc = null, temp = null;
    const live = liveDocs.get(item.key);
    if (live) doc = live.doc;
    else if (item.key === currentKey()) doc = state.doc;
    else if (item.path && native.readPdf) {
      const data = await native.readPdf(item.path);
      temp = await pdfjsLib.getDocument({ data }).promise;
      doc = temp;
    }
    if (!doc) return;
    try {
      const page = await doc.getPage(clamp(want, 1, doc.numPages));
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 280 / vp0.width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
      const url = c.toDataURL('image/jpeg', 0.7);
      thumbCache.set(item.key, { page: want, url });
      try { localStorage.setItem('riffle:thumb:' + item.key, JSON.stringify({ page: want, url })); } catch {}
      // the card may have been rebuilt while rendering — find its live img
      const live2 = deskEl.querySelector(`.doc-card[data-key="${CSS.escape(item.key)}"] img`);
      if (live2) live2.src = url;
      else if (img.isConnected) img.src = url;
    } finally {
      if (temp) { try { temp.destroy(); } catch {} }
    }
  })().catch(() => {}).finally(() => thumbJobs.delete(jobKey));
  thumbJobs.set(jobKey, job);
}

/* ----- the desk itself ----- */

/* snap cards to the grid without losing the arrangement: read them in
   visual order — rows top to bottom, left to right, like a desktop's
   "align to grid" — then refill the grid in that order */
function tidyDesk() {
  const m = deskMetrics();
  const byY = [...shelf.items].sort((a, b) => (a.pos ? a.pos.y : 0) - (b.pos ? b.pos.y : 0));
  const order = [];
  let row = [], rowY = null;
  const flush = () => {
    row.sort((a, b) => (a.pos ? a.pos.x : 0) - (b.pos ? b.pos.x : 0));
    order.push(...row);
    row = [];
  };
  for (const it of byY) {
    const y = it.pos ? it.pos.y : 0;
    if (rowY === null || y - rowY > m.ch * 0.5) { flush(); rowY = y; }
    row.push(it);
  }
  flush();
  order.forEach((it, i) => { it.pos = slotRect(i, m); });
  saveShelf();
  renderShelf();
}

function setDeskCols(n) {
  deskCols = clamp(n, 2, 4);
  try { localStorage.setItem('riffle:deskcols:' + WSID, String(deskCols)); } catch {}
  syncShelfBar();
  tidyDesk(); // spots from the old grid don't fit the new one
}

function syncShelfBar() {
  $('#shelfCols em').textContent = deskCols;
  $('#shelfCols').title = T.perRow(deskCols);
}

function actionBtn(title, svgPath, cls) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.title = title;
  b.innerHTML = `<svg viewBox="0 0 20 20">${svgPath}</svg>`;
  return b;
}

function renderShelf() {
  body.classList.toggle('shelf-has', shelf.items.length > 0);
  deskEl.innerHTML = '';
  if (!shelf.items.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = T.shelfEmpty;
    deskEl.appendChild(empty);
    return;
  }
  const now = Date.now();
  const m = deskMetrics();
  deskEl.style.setProperty('--card-w', m.cw + 'px');
  deskEl.style.setProperty('--thumb-h', m.th + 'px');
  // a card gets a spot once and keeps it for good — only dragging
  // or "tidy up" moves it, so the arrangement never reshuffles itself
  const taken = shelf.items.filter((i) => i.pos).map((i) => i.pos);
  const freeSlot = () => {
    for (let i = 0; ; i++) {
      const s = slotRect(i, m);
      if (!taken.some((p) => Math.abs(p.x - s.x) < m.cw * 0.6 && Math.abs(p.y - s.y) < m.ch * 0.6)) return s;
    }
  };
  let placed = false;
  for (const it of shelf.items) {
    if (!it.pos) { it.pos = freeSlot(); taken.push(it.pos); placed = true; }
    const pos = it.pos;
    const active = it.key === currentKey();

    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.key = it.key;
    if (active) card.classList.add('active');
    if (it.pinned) card.classList.add('pinned');
    if (!active && now - (it.lastOpened || 0) > STALE_MS) card.classList.add('stale');
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    card.title = T.lastOpened(new Date(it.lastOpened || now).toLocaleDateString());

    const thumb = document.createElement('div');
    thumb.className = 'dc-thumb';
    const img = document.createElement('img');
    img.draggable = false;
    thumb.appendChild(img);

    // reading progress along the bottom edge
    const pages = it.pages || 0;
    if (pages > 1) {
      let readPage = 1;
      try {
        const p = JSON.parse(localStorage.getItem(`qy:prefs:${it.fp}`) || 'null');
        if (p && p.page) readPage = p.page;
      } catch {}
      const prog = document.createElement('div');
      prog.className = 'dc-progress';
      const bar = document.createElement('i');
      bar.style.width = clamp((readPage / pages) * 100, 2, 100) + '%';
      prog.appendChild(bar);
      thumb.appendChild(prog);
    }

    // cover flip: pick which page faces up
    const flip = document.createElement('div');
    flip.className = 'dc-flip';
    const flipNum = document.createElement('em');
    flipNum.textContent = `${clamp(it.thumbPage || 1, 1, pages || 1)}${pages ? ' ∕ ' + pages : ''}`;
    const flipTo = (delta) => {
      it.thumbPage = clamp((it.thumbPage || 1) + delta, 1, pages || 1);
      flipNum.textContent = `${it.thumbPage}${pages ? ' ∕ ' + pages : ''}`;
      saveShelf();
      ensureThumb(it, img);
    };
    const fPrev = actionBtn(T.flipPrev, '<path d="M12 5.5L7.5 10l4.5 4.5"/>');
    const fNext = actionBtn(T.flipNext, '<path d="M8 5.5l4.5 4.5L8 14.5"/>');
    fPrev.addEventListener('click', (e) => { e.stopPropagation(); flipTo(-1); });
    fNext.addEventListener('click', (e) => { e.stopPropagation(); flipTo(1); });
    flip.append(fPrev, flipNum, fNext);
    thumb.appendChild(flip);

    // actions: pin / open in new window / remove
    const acts = document.createElement('div');
    acts.className = 'dc-actions';
    const pinBtn = actionBtn(it.pinned ? T.unpinDoc : T.pinDoc,
      '<path d="M8 3h4l.6 5.2 2 1.8H5.4l2-1.8zM10 10v6.5"/>');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      it.pinned = !it.pinned;
      card.classList.toggle('pinned', it.pinned);
      pinBtn.title = it.pinned ? T.unpinDoc : T.pinDoc;
      saveShelf();
    });
    acts.appendChild(pinBtn);
    if (it.path && native.newWindow) {
      const nw = actionBtn(T.openNewWin, '<path d="M8 4.5H4.5v11h11V12M11.5 4.5h4v4M15.2 4.8L9.5 10.5"/>');
      nw.addEventListener('click', (e) => { e.stopPropagation(); native.newWindow(it.path); });
      acts.appendChild(nw);
    }
    const rm = actionBtn(T.removeDoc, '<path d="M6 6l8 8M14 6l-8 8"/>', 'danger');
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeShelfItem(it.key); });
    acts.appendChild(rm);
    thumb.appendChild(acts);

    const badge = document.createElement('span');
    badge.className = 'dc-pin-badge';
    badge.innerHTML = '<svg viewBox="0 0 20 20"><path d="M8 3h4l.6 5.2 2 1.8H5.4l2-1.8zM10 10v6.5"/></svg>';
    thumb.appendChild(badge);

    const nameEl = document.createElement('div');
    nameEl.className = 'dc-name';
    nameEl.textContent = (it.name || '').replace(/\.pdf$/i, '');

    card.append(thumb, nameEl);
    card.addEventListener('mousedown', (e) => startCardDrag(e, it, card));
    card.addEventListener('click', () => {
      if (card.dataset.dragged) return;
      switchTo(it.key);
    });
    deskEl.appendChild(card);
    ensureThumb(it, img);
  }
  if (placed) saveShelf(); // first-time spots are part of the arrangement
}

/* drag a card anywhere on the desk — its spot is remembered */
function startCardDrag(e, it, card) {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  const startLeft = card.offsetLeft, startTop = card.offsetTop;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    moved = true;
    deskDragging = true;
    card.classList.add('dragging');
    const maxX = Math.max(4, deskEl.clientWidth - card.offsetWidth - 4);
    card.style.left = clamp(startLeft + ev.clientX - sx, 4, maxX) + 'px';
    card.style.top = Math.max(4, startTop + ev.clientY - sy) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    deskDragging = false;
    card.classList.remove('dragging');
    if (moved) {
      it.pos = { x: card.offsetLeft, y: card.offsetTop };
      saveShelf();
      card.dataset.dragged = '1';
      setTimeout(() => { delete card.dataset.dragged; }, 0);
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function toggleShelf(force) {
  const on = force !== undefined ? force : !body.classList.contains('shelf-open');
  if (on) { sweepShelf(); renderShelf(); }
  body.classList.toggle('shelf-open', on);
}

shelfHandleBtn.addEventListener('click', () => {
  shelfPinned = true;
  toggleShelf();
});

$('#shelfAdd').addEventListener('click', () => native.requestOpen());
$('#shelfCols').addEventListener('click', () => setDeskCols(deskCols === 4 ? 2 : deskCols + 1));
$('#shelfTidy').addEventListener('click', tidyDesk);
$('#shelfAdd').title = T.addDoc;
$('#shelfTidy').title = T.tidy;
syncShelfBar();

// tapping back into the document dismisses the shelf
scroller.addEventListener('mousedown', () => {
  if (body.classList.contains('shelf-open')) toggleShelf(false);
});

// other windows share the same shelf — pick up their changes
window.addEventListener('storage', (e) => {
  if (e.key === SHELF_KEY && !deskDragging) {
    loadShelf();
    renderShelf();
  }
});

loadShelf();
sweepShelf();
renderShelf();

/* ---------------- drag & drop ---------------- */

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])].filter((f) => /\.pdf$/i.test(f.name));
  if (!files.length) return;
  // every drop joins this window's shelf; the first file takes the screen
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let p = null;
    try { p = native.pathForFile && native.pathForFile(f); } catch {}
    // read through main when we know the path — it also lifts the file's
    // quarantine flag so later Finder double-clicks open without the warning
    const buf = p && native.readPdf
      ? new Uint8Array(await native.readPdf(p))
      : new Uint8Array(await f.arrayBuffer());
    if (i === 0) await openPdf(buf, f.name, p || '');
    else addToShelf(buf, f.name, p || '');
  }
});

/* ---------------- native events ---------------- */

native.onIncoming && native.onIncoming(() => body.classList.add('loading'));
native.onOpen(({ name, data, path }) => openPdf(data, name, path || ''));

wakeChrome();
