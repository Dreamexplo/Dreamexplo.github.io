/* HTML-to-Video Studio - 主逻辑
 * 链路：上传文件 → 构建同源虚拟目录(SW) → iframe 加载用户页面 →
 *       自动播放/注入 → Canvas captureStream 或 html2canvas 逐帧 →
 *       MediaRecorder 录制 → 原生 mp4 或 ffmpeg.wasm 转码 → 下载
 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  files: null,          // { path: File/Blob }
  entry: null,          // 入口路径，如 "/index.html"
  recorder: null,
  stream: null,
  timer: null,
  stopPoll: null,
  recording: false,
  rawBlob: null,        // 录制原始 blob (webm/mp4)
  rawMime: '',          // 录制实际 mime（含 codecs）
  resultBlob: null,     // 最终下载 blob
  ffmpeg: null,
  swReady: false,
};

/* ---------- 文件收集 ---------- */
async function collectFiles(entries) {
  const files = {};
  let entry = null;

  const addFile = (path, blob) => {
    const p = (path.startsWith('/') ? path : '/' + path).replace(/\\/g, '/');
    files[p] = blob;
  };

  for (const f of entries) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.zip')) {
      const zipData = new Uint8Array(await f.arrayBuffer());
      const unzipped = fflate.unzipSync(zipData);
      for (const [p, data] of Object.entries(unzipped)) {
        if (data.length === 0) continue;
        const type = guessMime(p);
        addFile(p, new Blob([data.buffer], { type }));
      }
    } else {
      addFile(f.name, f);
    }
  }

  // 确定入口：用户显式给的 .html 优先；否则 index.html；否则第一个 html
  const htmls = Object.keys(files).filter(p => /\.html?$/i.test(p));
  const explicit = entries.filter(e => /\.html?$/i.test(e.name)).map(e => '/' + e.name.replace(/\\/g,'/'));
  entry = explicit[0]
    || htmls.find(p => p.toLowerCase().endsWith('/index.html'))
    || htmls.find(p => p.toLowerCase().endsWith('/index.htm'))
    || htmls[0] || '/index.html';
  if (!files[entry]) {
    // 兜底：入口不存在则找任意 html 或报错
    const anyHtml = htmls[0];
    if (!anyHtml) throw new Error('未找到 HTML 入口文件');
    entry = anyHtml;
  }
  return { files, entry };
}

/* ---------- Service Worker 虚拟目录 ---------- */
async function setupVFS() {
  if (!('serviceWorker' in navigator)) throw new Error('当前环境不支持 Service Worker（需 https 或 localhost）');
  const reg = await navigator.serviceWorker.register('zipfs-sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  const sw = reg.active || navigator.serviceWorker.controller;
  await new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev) => ev.data.ok ? resolve() : reject(new Error('VFS 设置失败'));
    sw.postMessage({ type: 'VFS_SET', files: state.files }, [ch.port2]);
  });
  state.swReady = true;
}

/* ---------- 录制 ---------- */
const frame = { iframe: null, wrap: null, win: null, doc: null, outCanvas: null, outCtx: null, W: 0, H: 0 };

/* iframe 必须位于可见区域并真实渲染，否则 canvas 不出帧、rAF 被节流；
   这里放进右侧预览面板，按容器尺寸等比缩放显示。 */
function buildIframe() {
  if (frame.wrap) { frame.wrap.remove(); frame.wrap = null; }
  if (frame.iframe) { frame.iframe.remove(); }
  const [W, H] = currentSize();
  const ifr = document.createElement('iframe');
  ifr.style.cssText = 'position:absolute;left:0;top:0;border:0;background:#000;';
  ifr.width = String(W); ifr.height = String(H);
  ifr.setAttribute('allow', 'autoplay; fullscreen');
  const wrap = document.createElement('div');
  wrap.id = 'stageWrap';
  wrap.style.cssText = `position:absolute;left:50%;top:50%;width:${W}px;height:${H}px;transform-origin:center center;`;
  wrap.appendChild(ifr);
  const host = document.querySelector('.preview-body') || document.body;
  host.appendChild(wrap);
  frame.iframe = ifr; frame.wrap = wrap; frame.W = W; frame.H = H;
  fitStage();
  $('previewEmpty').hidden = true;
}

function fitStage() {
  const wrap = frame.wrap;
  if (!wrap) return;
  const host = wrap.parentElement;
  if (!host) return;
  const k = Math.min(host.clientWidth / frame.W, host.clientHeight / frame.H) * 0.96 || 0.3;
  wrap.style.transform = `translate(-50%,-50%) scale(${k})`;
}
window.addEventListener('resize', fitStage);

function currentSize() {
  return $('optSize').value.split('x').map(Number);
}

async function loadUserPage() {
  buildIframe();
  const [W, H] = currentSize();
  frame.W = W; frame.H = H;
  await new Promise((resolve, reject) => {
    frame.iframe.onload = () => resolve();
    frame.iframe.onerror = () => reject(new Error('用户页面加载失败'));
    frame.iframe.src = './__vfs__' + state.entry;
    setTimeout(() => reject(new Error('用户页面加载超时(20s)')), 20000);
  });
  frame.win = frame.iframe.contentWindow;
  frame.doc = frame.iframe.contentDocument;
}

async function waitHidden(sel, timeout = 15000) {
  if (!sel) return;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hidden = await evaluate(`document.querySelector(${JSON.stringify(sel)}) === null || getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display === 'none'`);
    if (hidden) return;
    await sleep(300);
  }
  // 不强制失败：加载层可能早已不存在
}

async function clickSel(sel) {
  if (!sel) return;
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('click 选择器不存在: ${sel.replace(/'/g,"\\'")}'); el.click(); return true; })()`);
}

async function evaluate(js) {
  return frame.win.eval(js);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function prepareOutputCanvas() {
  frame.outCanvas = document.createElement('canvas');
  frame.outCanvas.width = frame.W; frame.outCanvas.height = frame.H;
  frame.outCtx = frame.outCanvas.getContext('2d');
}

/* 只有“铺满视口”的 canvas 才适合直录：小于 70% 视口的 canvas 往往只是背景层/图表，
   直录会丢掉整页 DOM 内容（此前 auto 模式误判为 canvas 页面的主要原因）。 */
function pickCanvas() {
  if (!frame.doc) return null;
  const vw = frame.W, vh = frame.H;
  const win = frame.win || window;
  let best = null, bestArea = 0;
  for (const c of frame.doc.querySelectorAll('canvas')) {
    const cs = win.getComputedStyle(c);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.05) continue;
    const r = c.getBoundingClientRect();
    const w = Math.min(r.width, vw), h = Math.min(r.height, vh);
    if (w <= 0 || h <= 0) continue;
    const area = w * h;
    if (area > bestArea) { bestArea = area; best = c; }
  }
  if (best && bestArea >= vw * vh * 0.7) return best;
  return null;
}

/* canvas 之外是否还有可见 DOM 文案（标题/按钮等）。有则不能只录 canvas 层。 */
function hasDomText(doc) {
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  let n = 0, txt = '';
  while (walker.nextNode()) {
    const t = walker.currentNode.nodeValue.trim();
    if (!t) continue;
    const p = walker.currentNode.parentElement;
    if (!p) continue;
    const tag = p.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    const cs = (p.ownerDocument.defaultView || window).getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    txt += t; n++;
    if (txt.length > 40) return true;
  }
  return false;
}

/* 页面是否存在时间轴动效（CSS animation / transition / WAAPI） */
function hasMotion(doc) {
  try { return (doc.getAnimations ? doc.getAnimations().length : 0) > 0; } catch (e) { return false; }
}

/* ---------- 保留动画当前视觉状态（关键修复） ----------
 * html2canvas 会把文档克隆到离屏副本再绘制，克隆副本里的 CSS 动画/过渡会从头重放，
 * 因此逐帧截到的永远是动画起始帧 —— 这就是“视频里没有动效”的根因。
 * 这里在 onclone 里把源文档当前时刻的计算样式（transform/opacity/filter/...）写入克隆节点，
 * 并停掉克隆副本的动画，保证每一帧截到的就是该时刻的真实画面。 */
const BAKE_PROPS = [
  'transform', 'transform-origin', 'transform-box', 'opacity', 'filter', 'backdrop-filter',
  'box-shadow', 'background-color', 'background-position', 'border-radius',
  'visibility', 'clip-path', 'translate', 'rotate', 'scale', 'color',
  'width', 'height', 'left', 'top', 'right', 'bottom',
];

function tagAnimatedTargets(doc) {
  const map = new Map();          // id -> 源元素
  const anims = [];
  try { anims.push(...(doc.getAnimations ? doc.getAnimations() : [])); } catch (e) {}
  let idx = 0;
  for (const a of anims) {
    try {
      const el = a.effect && a.effect.target;
      if (!el || !el.setAttribute) continue;
      if (!el.hasAttribute('data-mcv')) {
        el.setAttribute('data-mcv', String(idx));
        map.set(String(idx), el);
        idx++;
      }
    } catch (e) {}
  }
  return { anims, map };
}

function collectBakeTargets(doc) {
  const map = new Map();
  doc.querySelectorAll('[data-mcv]').forEach(el => map.set(el.getAttribute('data-mcv'), el));
  return map;
}

function bakeAnimated(sourceDoc, clonedDoc, targets) {
  const nodes = clonedDoc.querySelectorAll('[data-mcv]');
  if (!nodes.length) return;
  const srcWin = sourceDoc.defaultView || window;
  nodes.forEach(node => {
    const src = targets.get(node.getAttribute('data-mcv'));
    if (!src || !src.isConnected) return;
    let cs;
    try { cs = srcWin.getComputedStyle(src); } catch (e) { return; }
    for (const prop of BAKE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (!v || v === 'auto' || v === 'none' || v === 'normal') continue;
      try { node.style.setProperty(prop, v); } catch (e) {}
    }
    try {
      node.style.setProperty('animation', 'none', 'important');
      node.style.setProperty('transition', 'none', 'important');
    } catch (e) {}
    // 伪元素动画无法烘焙，直接静默隐藏动画层（避免重复绘制起点状态）
  });
}

/* 渲染一帧（带动画状态烘焙）
 * 注意：必须显式给出 width/height 裁剪区域，否则 html2canvas 会把整篇文档
 * （可能上万像素高）整体栅格化后缩放到视口，画面被纵向压扁。 */
async function renderFrameCanvas(doc, vw, vh, scale, targets, scrollTop) {
  const target = doc.documentElement || doc.body;
  const sy = Math.max(0, scrollTop || 0);
  return html2canvas(target, {
    scale,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#000',
    windowWidth: vw,
    windowHeight: vh,
    width: vw,
    height: vh,
    x: 0,
    y: sy,
    scrollX: 0,
    scrollY: sy,
    logging: false,
    onclone: (clonedDoc) => bakeAnimated(doc, clonedDoc, targets),
  });
}

function canvasToJpegBlob(canvas, q) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('帧编码失败')), 'image/jpeg', q);
    } catch (e) { reject(e); }
  });
}

/* 虚拟时钟：接管 iframe 内的 rAF / 时间源，让 JS 动画随“帧序号”推进而非真实时间，
   这样即使一帧要渲染几百毫秒，输出视频的动画节奏也是准的、不丢帧。 */
function installVirtualClock(win) {
  const q = new Map();
  let nid = 0;
  const origNow = win.performance.now.bind(win.performance);
  const origRAF = win.requestAnimationFrame;
  const origCAF = win.cancelAnimationFrame;
  const dateBase = win.Date.now();
  win.__mcNow = 0;
  win.requestAnimationFrame = (cb) => { q.set(++nid, cb); return nid; };
  win.cancelAnimationFrame = (id) => { q.delete(id); };
  try { win.performance.now = () => win.__mcNow; } catch (e) {}
  try { win.Date.now = () => dateBase + win.__mcNow; } catch (e) {}
  return {
    tick(t) {
      win.__mcNow = t;
      const pending = Array.from(q.values());
      q.clear();
      for (const cb of pending) { try { cb(t); } catch (e) { console.warn('[page rAF]', e); } }
    },
    restore() {
      try { win.requestAnimationFrame = origRAF; } catch (e) {}
      try { win.cancelAnimationFrame = origCAF; } catch (e) {}
      try { win.performance.now = origNow; } catch (e) {}
    },
  };
}

/* 逐帧渲染 → ffmpeg 图片序列编码，帧率恒定，与渲染耗时解耦 */
async function encodeFramesToMp4(frames, fps, onProgress) {
  const ffmpeg = await getFFmpeg();
  const pad = (n) => String(n).padStart(5, '0');
  for (let i = 0; i < frames.length; i++) {
    await ffmpeg.writeFile('mc' + pad(i) + '.jpg', frames[i]);
    if (i % 20 === 0) onProgress && onProgress(i / frames.length);
  }
  await ffmpeg.exec([
    '-y', '-framerate', String(fps), '-i', 'mc%05d.jpg',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'mc_out.mp4',
  ]);
  const data = await ffmpeg.readFile('mc_out.mp4');
  for (let i = 0; i < frames.length; i++) { try { await ffmpeg.deleteFile('mc' + pad(i) + '.jpg'); } catch (e) {} }
  try { await ffmpeg.deleteFile('mc_out.mp4'); } catch (e) {}
  return new Blob([data.buffer], { type: 'video/mp4' });
}

/* 兼容性预检：把逐帧引擎抓不到的内容提前告诉用户 */
function scanCompat(doc) {
  const issues = [];
  const vids = doc.querySelectorAll('video').length;
  if (vids) issues.push(`<video> × ${vids}（html2canvas 画不出视频画面）`);
  const ifrs = doc.querySelectorAll('iframe').length;
  if (ifrs) issues.push(`<iframe> × ${ifrs}（子文档内容不会被截取）`);
  let ximg = 0;
  doc.querySelectorAll('img').forEach(img => {
    try {
      const u = new URL(img.currentSrc || img.src, doc.baseURI);
      if (u.protocol.startsWith('http') && u.origin !== location.origin && !img.crossOrigin) ximg++;
    } catch (e) {}
  });
  if (ximg) issues.push(`跨域图片 × ${ximg}（缺 CORS 会空白）`);
  return issues;
}

function mimeSupported(list) {
  for (const c of list) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) {} }
  return '';
}

function makeRecorder(stream) {
  // 统一用 WebM 录制：各浏览器实现稳定、时长准确；
  // 需要 MP4 时由 ffmpeg.wasm 在本机转码（不上传云端）。避免 mp4 直录在部分环境静默 0 帧的问题。
  const mime = mimeSupported(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
  const chunks = [];
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstart = () => { state.rawMime = rec.mimeType || mime || ''; };
  rec.onstop = () => {
    state.rawMime = rec.mimeType || mime || '';
    state.rawBlob = new Blob(chunks, { type: state.rawMime || 'video/webm' });
    setTimeout(finishPipeline, 250);
  };
  rec.start(500);
  state.recorder = rec;
  return rec;
}

/* 三种录制器 */
async function startLiveCanvas(fps, onFrame) {
  const canvas = pickCanvas();
  if (!canvas) throw new Error('未找到足够大的 canvas，请改用“滚动”模式或“逐帧”模式');
  state.stream = canvas.captureStream(fps);
  state.recorder = makeRecorder(state.stream);
  attachPreview(state.stream);
  return () => { /* canvas 模式由时间/手动/表达式控制 */ };
}

async function startDomFrame(fps, mode, opts = {}) {
  await prepareOutputCanvas();
  state.stream = frame.outCanvas.captureStream(fps);
  state.recorder = makeRecorder(state.stream);
  attachPreview(state.stream);

  const win = frame.win;
  const vw = frame.W, vh = frame.H;
  const doc = frame.doc;
  const fpsInt = Math.max(1, Math.round(fps));
  const stopScroll = mode === 'scroll';
  const timed = stopScroll && opts.durMode === 'fixed' && opts.fixedSec > 0;
  const fixedSec = opts.fixedSec || 0;
  const t0 = performance.now();
  let step = 0;

  /* 滚动模式：整页先快照成一张大图，再按时间轴切视口 —— 位置精确、帧率稳定 */
  if (stopScroll) {
    const shot = await snapshotFullPage(win, doc, vw);
    const logicalH = shot.logicalH;
    const k = shot.canvas.height / logicalH;   // 快照缩放比
    const maxScroll = Math.max(0, logicalH - vh);
    const pxPerSec = opts.scrollSpeed || 150;
    const scrollDur = timed ? fixedSec : Math.max(2, maxScroll / pxPerSec);
    const visH = Math.min(shot.canvas.height, Math.round(vh * k));
    const loop = () => {
      if (!state.recording) return;
      const p = Math.min(1, (performance.now() - t0) / 1000 / scrollDur);
      const srcY = Math.min(shot.canvas.height - visH, Math.round(maxScroll * p * k));
      frame.outCtx.fillStyle = '#000';
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(shot.canvas, 0, srcY, shot.canvas.width, visH, 0, 0, vw, vh);
      step++;
      if (opts.onFrame) opts.onFrame(step);
      if (p >= 1) { stopRecording(); return; }
      setTimeout(loop, 1000 / fpsInt);
    };
    loop();
    return () => {};
  }

  /* 动画 / DOM 逐帧：每帧重新截取当前视口（带动画状态烘焙，避免克隆文档重放动画） */
  const targets = collectBakeTargets(doc);
  const scale = Math.min(1, 1600 / vw);
  const loop = async () => {
    if (!state.recording) return;
    const started = performance.now();
    try {
      const canvas = await renderFrameCanvas(doc, vw, vh, scale, targets);
      frame.outCtx.fillStyle = '#000';
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(canvas, 0, 0, vw, vh);
      if (opts.onFrame) opts.onFrame(step);
      step++;
    } catch (err) {
      stopRecording();
      setStatus('逐帧渲染错误: ' + err.message, 'err');
      console.error('[frame render]', err);
      return;
    }
    const cost = performance.now() - started;
    setTimeout(loop, Math.max(10, 1000 / fpsInt - cost));
  };
  loop();
  return () => {};
}

/* ---------- 精确逐帧引擎 ----------
 * 与实时录制的区别：
 * 1) 用虚拟时钟控制 CSS 动画 / rAF 动画，按“帧序号”推进，不依赖渲染速度；
 * 2) 每帧烘焙动画状态后再截图，克隆文档不会从头重放；
 * 3) 先存帧，最后用 ffmpeg 按固定帧率合成 —— 帧率恒定、时长精确、不丢帧。 */
async function startPrecise(fps, opts = {}) {
  const doc = frame.doc, win = frame.win;
  if (!doc) throw new Error('页面未加载');
  const vw = frame.W, vh = frame.H;
  await prepareOutputCanvas();

  // 预览：把渲染出的帧推到预览区
  try {
    state.previewStream = frame.outCanvas.captureStream(0);
    state.previewTrack = state.previewStream.getVideoTracks()[0];
    attachPreview(state.previewStream);
  } catch (e) { /* 预览失败不影响录制 */ }

  const { anims, map } = tagAnimatedTargets(doc);
  anims.forEach(a => { try { a.pause(); } catch (e) {} });

  // 计算总帧数
  let total = 0;
  const durMode = opts.durMode || 'auto';
  const doScroll = !!opts.scroll;
  const maxScroll = Math.max(0, (doc.documentElement.scrollHeight || 0) - vh);
  const scrollSpeed = Math.max(20, opts.scrollSpeed || 150);
  if (durMode === 'fixed') {
    total = Math.max(1, Math.round((opts.fixedSec || 10) * fps));
  } else if (doScroll) {
    // 滚动模式：按滚动速度把整页走完（懒加载/视差/滚动触发动画都会真实发生）
    total = Math.max(1, Math.ceil(maxScroll / scrollSpeed * fps));
  } else if (durMode === 'auto' && !opts.stopJs) {
    let maxMs = 0;
    for (const a of anims) {
      try {
        const timing = a.effect.getComputedTiming();
        if (Number.isFinite(timing.endTime)) maxMs = Math.max(maxMs, timing.endTime);
      } catch (e) {}
    }
    total = Math.round(Math.max(4000, maxMs || 10000) / 1000 * fps);
  } else if (durMode === 'manual') {
    total = 0;   // 手动停止
  }

  const MAX_FRAMES = 1800;
  let capped = false;
  if (total > MAX_FRAMES) { total = MAX_FRAMES; capped = true; }

  setStatus(`精确逐帧渲染中：${total ? total + ' 帧' : '手动停止'} @ ${fps}fps…` + (doScroll ? '（滚动整页）' : ''));
  const clock = installVirtualClock(win);
  const scale = Math.min(1, 1600 / vw);
  const frames = [];
  let i = 0;

  try {
    while (state.recording) {
      if (total && i >= total) break;
      const t = (i * 1000) / fps;

      let sy = 0;
      if (doScroll) {
        sy = Math.min(maxScroll, (i / fps) * scrollSpeed);
        try { win.scrollTo(0, sy); } catch (e) {}
        await sleep(0);   // 让滚动触发的 IntersectionObserver / 懒加载执行
      }

      clock.tick(t);
      for (const a of anims) { try { a.currentTime = t; } catch (e) {} }
      if (i % 10 === 0) {
        doc.querySelectorAll('video').forEach(v => {
          try { v.pause(); if (v.readyState >= 1 && Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration, t / 1000); } catch (e) {}
        });
      }

      const canvas = await renderFrameCanvas(doc, vw, vh, scale, map, sy);
      frame.outCtx.fillStyle = '#000';
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(canvas, 0, 0, vw, vh);
      if (state.previewTrack) { try { state.previewTrack.requestFrame(); } catch (e) {} }

      const blob = await canvasToJpegBlob(frame.outCanvas, 0.9);
      frames.push(new Uint8Array(await blob.arrayBuffer()));
      i++;

      if (total) setProgress(0.05 + 0.7 * (i / total), `渲染第 ${i}/${total} 帧（${((i / total) * 100).toFixed(0)}%）`);
      else setStatus(`渲染第 ${i} 帧…（点“停止”结束）`);

      if (opts.stopJs && i % 10 === 0) {
        try {
          const done = await evaluate(`(function(){ try { return !!(${opts.stopJs}); } catch(e){ return false; } })()`);
          if (done) break;
        } catch (e) {}
      }
      if (i % 2 === 0) await sleep(0);
    }
  } finally {
    clock.restore();
  }

  if (!frames.length) throw new Error('未渲染到任何帧（页面可能为空）');
  if (capped) setStatus(`已达帧数上限 ${MAX_FRAMES}，视频被截断。请降低时长或帧率。`, 'warn');

  setProgress(0.78, `编码 ${frames.length} 帧（ffmpeg.wasm，请稍候）…`);
  const mp4 = await encodeFramesToMp4(frames, fps, (p) => {
    setProgress(0.78 + 0.12 * p, `写入帧 ${(p * 100).toFixed(0)}%…`);
  });
  state.rawBlob = mp4;
  state.rawMime = 'video/mp4;codecs=avc1';
  if (state.previewTrack) { try { state.previewTrack.stop(); } catch (e) {} }
  finishPipeline();
}

/* 整页快照：一次性渲染整篇文档，供滚动模式切片；超大页面自动降采样 */
async function snapshotFullPage(win, doc, vw) {
  const target = doc.documentElement || doc.body;
  const logicalH = Math.max(target.scrollHeight, target.offsetHeight, doc.body ? doc.body.scrollHeight : 0, 720);
  let scale = Math.min(1, 1280 / vw);
  const MAX_PX = 28e6;
  while (logicalH * vw * scale * scale > MAX_PX && scale > 0.15) scale *= 0.85;
  const canvas = await html2canvas(target, {
    scale,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#000000',
    windowWidth: vw,
    windowHeight: logicalH,
    width: vw,
    height: logicalH,
    x: 0,
    y: 0,
    logging: false,
  });
  return { canvas, logicalH };
}

/* ---------- 停止 ---------- */
function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  clearInterval(state.stopPoll);
  clearTimeout(state.timer);
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  setStatus('录制完成，处理中…');
}

/* ---------- ffmpeg.wasm 后处理 ---------- */
async function getFFmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  setStatus('加载 ffmpeg.wasm（约 32MB，首次较慢）…');
  if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) throw new Error('ffmpeg 库未加载（vendor/ffmpeg/ffmpeg.js）');
  if (!window.FFmpegUtil || !window.FFmpegUtil.toBlobURL) throw new Error('ffmpeg util 未加载（vendor/ffmpeg/util.js）');
  const { FFmpeg } = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;
  // 全部本地 vendor 化：核心/worker 同源加载，不依赖 CDN，也不要求 SharedArrayBuffer
  const base = new URL('vendor/ffmpeg/', document.baseURI).href;
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => { console.debug('[ffmpeg]', message); });
  ffmpeg.on('progress', ({ progress, time }) => {
    if (progress > 0 && progress <= 1) {
      setProgress(0.4 + Math.min(0.5, progress * 0.5), `转码中 ${(progress * 100).toFixed(0)}%`);
    }
  });
  const coreURL = await toBlobURL(base + 'core.js', 'text/javascript');
  const wasmURL = await toBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });
  state.ffmpeg = ffmpeg;
  return ffmpeg;
}

/* 输入的录制文件是否含音频轨（无音轨时禁止对音频做滤镜） */
async function hasAudioTrack(ffmpeg, name) {
  let buf = '';
  const h = ({ message }) => { buf += message + '\n'; };
  ffmpeg.on('log', h);
  try { await ffmpeg.exec(['-hide_banner', '-i', name]); } catch (_) {}
  try { ffmpeg.off('log', h); } catch (_) {}
  return /Stream #\d+:\d+.*Audio:/.test(buf);
}

/* atempo 单次只接受 0.5~2，超出范围需要串联 */
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push('atempo=' + s.toFixed(4));
  return parts.join(',');
}

async function postProcess() {
  if (!state.rawBlob || state.rawBlob.size < 1024) {
    setStatus('❌ 录制失败：未捕获到有效画面（产物体积为 0）。请检查页面是否有可见内容，或换用其他模式后重试。', 'err');
    setProgress(0, '');
    $('btnDownload').disabled = true;
    state.recording = false;
    $('btnStart').disabled = false;
    if (state.recorder && state.recorder.state !== 'inactive') { try { state.recorder.stop(); } catch (e) {} }
    return;
  }
  const speed = parseFloat($('optSpeed').value) || 1;
  const music = state.musicFile;
  const wantFmt = $('optFormat').value;
  const rawMime = (state.rawMime || state.rawBlob.type || '').toLowerCase();
  const rawIsH264Mp4 = rawMime.includes('mp4') && (rawMime.includes('avc') || rawMime.includes('h264'));
  const rawIsMp4 = rawMime.includes('mp4');

  // 需要 ffmpeg 的情形：要 MP4 但不是原生 H.264、或要 WebM 但原始是 MP4、或要变速、或要混音
  const toWebm = (wantFmt === 'webm' && rawIsMp4);
  const needFfmpeg = (wantFmt === 'mp4' && !rawIsH264Mp4) || toWebm || speed !== 1 || !!music;

  if (!needFfmpeg) {
    state.resultBlob = state.rawBlob;
    finish(rawIsMp4 ? 'mp4' : 'webm');
    return;
  }

  const ffmpeg = await getFFmpeg();
  const inExt = rawIsMp4 ? 'mp4' : 'webm';
  await ffmpeg.writeFile('input.' + inExt, new Uint8Array(await state.rawBlob.arrayBuffer()));
  const hasAudio = await hasAudioTrack(ffmpeg, 'input.' + inExt);
  const args = ['-y', '-i', 'input.' + inExt];
  if (music) {
    const bgmName = 'bgm' + extOf(music.name);
    await ffmpeg.writeFile(bgmName, new Uint8Array(await music.arrayBuffer()));
    args.push('-i', bgmName);
  }
  const vf = speed !== 1 ? `setpts=${(1 / speed).toFixed(4)}*PTS` : null;
  const af = speed !== 1 && hasAudio ? atempoChain(speed) : null;

  const filterParts = [];
  const mapArgs = [];
  if (vf) {
    filterParts.push(`[0:v:0]${vf}[v0]`);
    mapArgs.push('-map', '[v0]');
  } else {
    mapArgs.push('-map', '0:v:0');
  }
  if (music) {
    const vol = (parseFloat($('optMusicVol').value) / 100).toFixed(2);
    // 背景音乐循环铺满 → 变调同步 → 按“变速后时长”截断（WebM 需 seek hack 才能取到时长）
    const rawDur = await probeDuration();
    const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
    const chain = [`volume=${vol}`];
    if (dur) chain.push('aloop=loop=-1:size=2e9', `atrim=0:${dur.toFixed(3)}`);
    chain.push('asetpts=PTS-STARTPTS');
    if (speed !== 1) chain.push(atempoChain(speed));
    if (dur) chain.push(`atrim=0:${(dur / speed).toFixed(3)}`);
    filterParts.push(`[1:a]${chain.join(',')}[a0]`);
    mapArgs.push('-map', '[a0]', '-shortest');
  } else if (af) {
    filterParts.push(`[0:a]${af}[a0]`);
    mapArgs.push('-map', '[a0]');
  } else if (hasAudio) {
    mapArgs.push('-map', '0:a?');
  }
  if (filterParts.length) args.push('-filter_complex', filterParts.join(';'));
  if (toWebm) {
    args.push(...mapArgs, '-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '5', '-pix_fmt', 'yuv420p');
  } else {
    args.push(...mapArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vsync', 'vfr');
  }
  if (music || af || hasAudio) args.push('-c:a', toWebm ? 'libvorbis' : 'aac', '-b:a', '128k');
  const outName = toWebm ? 'output.webm' : 'output.mp4';
  args.push(outName);

  try {
    setProgress(0.85, '转码中（ffmpeg.wasm 单线程较慢，请耐心等待）…');
    await ffmpeg.exec(args);
    setProgress(0.95, '封装输出…');
    const data = await ffmpeg.readFile(outName);
    state.resultBlob = new Blob([data.buffer], { type: toWebm ? 'video/webm' : 'video/mp4' });
    finish(toWebm ? 'webm' : 'mp4');
  } catch (e) {
    if (!music && speed === 1 && rawIsMp4) {
      // 转码失败但已有可直接播放的 MP4
      state.resultBlob = state.rawBlob;
      finish('mp4');
      setStatus('⚠️ H.264 转码失败，已输出原始编码 MP4（部分播放器可能不兼容）：' + (e.message || e), 'warn');
    } else {
      throw e;
    }
  }
}

function extOf(name) { const m = /\.\w+$/.exec(name); return m ? m[0].toLowerCase() : '.mp3'; }

function isMp4Blob(blob) { return (blob.type || '').startsWith('video/mp4'); }

/* 读取录制文件真实时长；WebM 常返回 Infinity，需 seek 到极值触发浏览器计算时长 */
async function probeDuration() {
  if (!state.rawBlob) return 0;
  const url = URL.createObjectURL(state.rawBlob);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  v.src = url;
  await new Promise((r) => {
    v.onloadedmetadata = r;
    v.onerror = r;
    setTimeout(r, 4000);
  });
  let d = v.duration;
  if (!Number.isFinite(d) || d <= 0) {
    await new Promise((r) => {
      v.onseeked = r;
      v.onerror = r;
      setTimeout(r, 4000);
      try { v.currentTime = 1e101; } catch (_) { r(); }
    });
    d = v.duration;
  }
  URL.revokeObjectURL(url);
  return (Number.isFinite(d) && d > 0) ? d : 0;
}

function finish(ext) {
  setProgress(1, '完成');
  $('btnDownload').disabled = false;
  setStatus(`✅ 已生成 ${ext.toUpperCase()}（${fmtSize(state.resultBlob.size)}），点击下载。`, 'ok');
}

function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

/* ---------- UI 工具 ---------- */
function setStatus(msg, cls) {
  const el = $('statusBar');
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function setProgress(p, text) {
  const wrap = $('progressWrap');
  wrap.hidden = false;
  $('progressBar').style.width = (p * 100).toFixed(1) + '%';
  if (text) setStatus(text);
}
function attachPreview(stream) {
  const v = $('preview');
  v.srcObject = stream;
  v.muted = true;
  v.hidden = false;
  $('previewEmpty').style.display = 'none';
}

function guessMime(p) {
  const ext = p.split('.').pop().toLowerCase();
  const map = { html:'text/html', htm:'text/html', js:'text/javascript', mjs:'text/javascript', css:'text/css', json:'application/json', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon', mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', mp4:'video/mp4', webm:'video/webm', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', wasm:'application/wasm', txt:'text/plain', md:'text/markdown', pdf:'application/pdf' };
  return map[ext] || 'application/octet-stream';
}

/* ---------- 主流程 ---------- */
async function start() {
  if (!state.files || !state.entry) { setStatus('请先上传 HTML 文件', 'err'); return; }
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('btnDownload').disabled = true;
  state.recording = true;

  try {
    if (!state.swReady) await setupVFS();
    setStatus('加载用户页面…');
    await loadUserPage();
    await waitHidden($('optWaitHidden').value.trim());
    if ($('optInjectJs').value.trim()) {
      await evaluate($('optInjectJs').value);
    }
    await clickSel($('optClickSel').value.trim());
    await sleep(parseInt($('optDelay').value) || 0);

    const mode = $('optMode').value;
    const fps = parseInt($('optFps').value) || 10;
    const durMode = $('optDuration').value;
    const fixedSec = parseFloat($('optDurationSec').value) || 10;
    const stopJs = $('optStopJs').value.trim();
    const scrollSpeed = parseFloat($('optScrollSpeed').value) || 150;

    setStatus('开始录制…');

    const engine = ($('optEngine') && $('optEngine').value) || 'precise';
    const bigCanvas = pickCanvas();
    const scrollable = (frame.doc.documentElement.scrollHeight > frame.H + 4);
    const motion = hasMotion(frame.doc);

    // 兼容性预检
    const issues = scanCompat(frame.doc);
    if (issues.length) console.warn('[compat]', issues);

    let modeReal = mode;
    if (modeReal === 'auto') {
      if (bigCanvas && !hasDomText(frame.doc)) modeReal = 'canvas';
      else if (scrollable) modeReal = 'scroll';
      else modeReal = 'dom';
      const label = modeReal === 'canvas' ? '动画（canvas 直录）'
        : modeReal === 'scroll' ? '整页滚动' : '动画（视口内）';
      const engLabel = modeReal === 'canvas' ? '实时直录' : (engine === 'fast' ? '实时' : '精确逐帧');
      setStatus(`自动判定：${label}｜引擎：${engLabel}` + (issues.length ? `\n兼容性提示：${issues.join('；')}` : ''), issues.length ? 'warn' : ''); 
    }

    if (engine === 'precise' && modeReal !== 'canvas') {
      // 精确逐帧：CSS/rAF 动画按帧推进 + 状态烘焙 + 固定帧率合成，动效完整不丢帧
      await startPrecise(fps, { durMode, fixedSec, stopJs, scroll: modeReal === 'scroll', scrollSpeed });
    } else if (modeReal === 'scroll') {
      await startDomFrame(fps, 'scroll', { durMode, fixedSec, scrollSpeed });
    } else if (modeReal === 'canvas' && bigCanvas) {
      await startLiveCanvas(fps);
    } else {
      await startDomFrame(fps, 'live', { durMode, fixedSec, scrollSpeed });
    }

    // 精确引擎自行处理时长与停止表达式，无需外部计时
    const selfTimed = (engine === 'precise' && modeReal !== 'canvas');
    if (!selfTimed) {
      if (stopJs) {
        state.stopPoll = setInterval(async () => {
          try {
            const done = await evaluate(`(function(){ try { return !!(${stopJs}); } catch(e){ return false; } })()`);
            if (done) stopRecording();
          } catch (_) {}
        }, 500);
      }
      if (durMode === 'fixed') {
        state.timer = setTimeout(stopRecording, fixedSec * 1000);
      }
      if (durMode === 'auto' && !stopJs && modeReal !== 'scroll') {
        setStatus('自动模式（动画）需要停止表达式或手动停止，已切换为手动停止。', 'warn');
      }
    }
  } catch (e) {
    state.recording = false;
    setStatus('录制失败: ' + e.message, 'err');
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;
  }
}

async function onStop() {
  stopRecording();
  $('btnStop').disabled = true;
  // 兜底：若 recorder 已 inactive 未触发 onstop，这里直接接管后处理
  await sleep(300);
  if (state.rawBlob) finishPipeline();
}

/* 录制结束后的统一收尾（幂等，避免定时停止/手动停止重复触发） */
let pipelineRunning = false;
async function finishPipeline() {
  if (pipelineRunning) return;
  if (!state.rawBlob) return;
  pipelineRunning = true;
  try {
    await postProcess();
  } catch (e) {
    setStatus('处理失败: ' + (e.message || e), 'err');
  } finally {
    pipelineRunning = false;
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;
  }
}

/* ---------- 事件绑定 ---------- */
function initEvents() {
  const dz = $('dropZone');
  dz.addEventListener('click', () => $('fileInput').click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
    handleFiles([...e.dataTransfer.files]);
  });
  $('fileInput').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
  $('btnRemoveFiles').addEventListener('click', () => {
    state.files = null; state.entry = null; state.swReady = false;
    $('fileBox').hidden = true; $('btnStart').disabled = true;
    setStatus('等待上传 HTML…');
  });
  $('btnStart').addEventListener('click', start);
  $('btnStop').addEventListener('click', onStop);
  $('btnDownload').addEventListener('click', () => {
    if (!state.resultBlob) return;
    const ext = state.resultBlob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(state.resultBlob);
    a.download = `html2video_${Date.now()}.${ext}`;
    a.click();
  });
  $('optMusic').addEventListener('change', (e) => { state.musicFile = e.target.files[0] || null; });
  $('optDuration').addEventListener('change', (e) => {
    $('optDurationSec').disabled = e.target.value !== 'fixed';
  });
}

async function handleFiles(files) {
  try {
    setStatus('解析文件…');
    const { files: fmap, entry } = await collectFiles(files);
    state.files = fmap; state.entry = entry; state.swReady = false;
    $('fileBox').hidden = false;
    const list = Object.keys(fmap);
    $('fileList').textContent = `${list.length} 个文件 · 入口 ${entry}` + (list.length > 8 ? `\n${list.slice(0, 8).join('\n')}\n…等` : '\n' + list.join('\n'));
    setStatus(`就绪：入口 ${entry}。可开始录制。`, 'ok');
    $('btnStart').disabled = false;
  } catch (e) {
    setStatus('解析失败: ' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', initEvents);
