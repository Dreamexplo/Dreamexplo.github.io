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
  demoTab: null,        // 演示录制：承载用户页面的新标签页
  demoStream: null,     // 演示录制：捕获流
  demoStart: 0,
  blackWarn: false,     // 产物疑似黑屏
  canvasWarn: '',       // canvas 空白/静止（可能被开始遮罩挡住）
  demoWarn: '',         // 演示录制：捕获源选择不当（整屏/窗口）
  demoFocusBack: false, // 演示录制：待转码完成后把焦点拉回 Studio
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

/* 目标输出尺寸：逐帧模式用 frame.W/H，演示模式按下拉框解析 */
function outputSize() {
  if (frame.W && frame.H) return [frame.W, frame.H];
  const [w, h] = String($('optSize').value || '1280x720').split('x').map(Number);
  return [w || 1280, h || 720];
}

async function prepareOutputCanvas() {
  frame.outCanvas = document.createElement('canvas');
  frame.outCanvas.width = frame.W; frame.outCanvas.height = frame.H;
  frame.outCtx = frame.outCanvas.getContext('2d');
}

/* 只有“铺满视口”的 canvas 才适合直录：小于 70% 视口的 canvas 往往只是背景层/图表，
   直录会丢掉整页 DOM 内容（此前 auto 模式误判为 canvas 页面的主要原因）。 */
function pickCanvas(minRatio) {
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
  if (best && bestArea >= vw * vh * (minRatio || 0.7)) return best;
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
async function renderFrameCanvas(doc, vw, vh, scale, targets, scrollTop, repaint) {
  const target = doc.documentElement || doc.body;
  const sy = Math.max(0, scrollTop || 0);
  const out = await html2canvas(target, {
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
  /* 补画 canvas / video：先让页面重绘一次，确保能读到 WebGL 的真实像素 */
  try {
    if (typeof repaint === 'function') await repaint();
    else await repaintOnce(doc.defaultView || window);
    const ctx = out.getContext('2d');
    const n = paintLiveLayers(doc, ctx, { scale, vw, vh });
    if (n) console.debug('[live-layer] 补绘', n, '个实时元素');
  } catch (e) {
    console.warn('[live-layer] 补绘失败', e && e.message);
  }
  return out;
}

/* ---------- 活层补绘：修复 html2canvas 无法渲染 canvas / WebGL / video 造成的黑块 ----------
 * html2canvas 栅格化时，canvas、video 这类“实时像素源”只能拿到空白（尤其 WebGL 画面），
 * 结果是页面其它部分正常、唯独动画/游戏画面一片黑。这里在截图完成后，把真实元素的
 * 当前像素按其在页面中的位置、尺寸、叠放层级补画到帧上。 */
function listLiveLayers(doc, vw, vh, extraOffset) {
  const win = doc.defaultView || window;
  const layers = [];
  const order = new Map();
  let seq = 0;
  doc.querySelectorAll('*').forEach((el) => order.set(el, seq++));

  const push = (el, kind) => {
    let cs;
    try { cs = win.getComputedStyle(el); } catch (e) { return; }
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return;
    if (parseFloat(cs.opacity || '1') < 0.02) return;
    if (kind === 'video' && el.readyState < 2) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    /* 视口外跳过（整页模式下 vh 传整页高度，坐标系换成文档坐标） */
    if (r.bottom + extraOffset < 0 || r.top + extraOffset > vh || r.right < 0 || r.left > vw) return;
    const zi = parseInt(cs.zIndex, 10);
    layers.push({
      el, kind, cs,
      x: r.left, y: r.top + extraOffset, w: r.width, h: r.height,
      z: Number.isFinite(zi) ? zi : 0,
      order: order.get(el) || 0,
    });
  };

  doc.querySelectorAll('canvas').forEach((el) => push(el, 'canvas'));
  doc.querySelectorAll('video').forEach((el) => push(el, 'video'));

  /* 先按 z-index，再按 DOM 顺序，近似真实叠放 */
  layers.sort((a, b) => (a.z - b.z) || (a.order - b.order));
  return layers;
}

function paintLiveLayers(doc, ctx, opt) {
  const { scale = 1, vw, vh, extraOffset = 0 } = opt;
  let painted = 0;
  for (const l of listLiveLayers(doc, vw, vh, extraOffset)) {
    const dx = l.x * scale;
    const dy = l.y * scale;
    const dw = l.w * scale;
    const dh = l.h * scale;
    try {
      const fit = l.cs.objectFit;
      const nw = l.el.videoWidth || l.el.width || 0;
      const nh = l.el.videoHeight || l.el.height || 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      ctx.clip();
      if (nw && nh && (fit === 'cover' || fit === 'contain') && l.kind === 'video') {
        const k = fit === 'cover' ? Math.max(dw / nw, dh / nh) : Math.min(dw / nw, dh / nh);
        const w2 = nw * k;
        const h2 = nh * k;
        ctx.drawImage(l.el, dx + (dw - w2) / 2, dy + (dh - h2) / 2, w2, h2);
      } else {
        ctx.drawImage(l.el, dx, dy, dw, dh);
      }
      ctx.restore();
      painted++;
    } catch (e) {
      /* 跨域污染或元素已失效时跳过，不阻塞整帧 */
      console.warn('[live-layer]', l.kind, e && e.message);
    }
  }
  return painted;
}

/* 让页面重新绘制一次后再读取像素 —— WebGL 未开启 preserveDrawingBuffer 时，
 * 只有在绘制后的同一任务内 drawImage 才能拿到真实画面，否则是一片空白。 */
function repaintOnce(win) {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (done) return; done = true; resolve(); };
    try {
      win.requestAnimationFrame(() => fire());
    } catch (e) { fire(); return; }
    setTimeout(fire, 160);
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

function makeRecorder(stream, bitrate) {
  // 统一用 WebM 录制：各浏览器实现稳定、时长准确；
  // 需要 MP4 时由 ffmpeg.wasm 在本机转码（不上传云端）。避免 mp4 直录在部分环境静默 0 帧的问题。
  const mime = mimeSupported(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']);
  const chunks = [];
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate || 6_000_000 } : undefined);
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
/* 采样 canvas 缩略图：判断是否空白 / 是否完全没变化。
 * 很多游戏与动画页会先盖一层“点击开始”的遮罩，canvas 在点击前一直是空的，
 * 直接录就会得到 0 字节或纯黑成片，这里提前识别并给出可操作的建议。 */
function canvasHealth(canvas) {
  try {
    const s = 32;
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(canvas, 0, 0, s, s);
    const d = cx.getImageData(0, 0, s, s).data;
    let solid = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) solid++;
      sum += d[i] + d[i + 1] + d[i + 2] + d[i + 3];
    }
    return { blank: solid === 0, sig: `${sum}:${solid}` };
  } catch (e) { return null; }
}

/* 找一个铺满视口的“开始/点击进入”遮罩层，返回可填进「播放启动动作」的选择器 */
function findStartOverlay(win, doc, vw, vh) {
  try {
    const area = Math.max(1, vw * vh);
    const list = doc.querySelectorAll('div,section,button,a,span');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const r = el.getBoundingClientRect();
      if (r.width * r.height < area * 0.8) continue;
      const cs = win.getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      let sel = '';
      if (el.id) sel = '#' + el.id;
      else if (el.className && typeof el.className === 'string') sel = '.' + el.className.trim().split(/\s+/)[0];
      return { sel, text: (el.textContent || '').trim().slice(0, 18) };
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function startLiveCanvas(fps, onFrame) {
  const canvas = pickCanvas();
  if (!canvas) throw new Error('未找到足够大的 canvas，请改用“滚动”模式或“逐帧”模式');
  state.stream = canvas.captureStream(fps);
  state.recorder = makeRecorder(state.stream);
  attachPreview(state.stream);

  /* 1.5s 后回看 canvas 是否还空着 / 一动不动 */
  const h0 = canvasHealth(canvas);
  setTimeout(() => {
    if (!state.recording) return;
    const h1 = canvasHealth(canvas);
    if (!h1) return;
    if (h1.blank || (h0 && h1.sig === h0.sig)) {
      state.canvasWarn = state.canvasWarn
        || 'canvas 画面一直是空白/静止：页面很可能停在“点击开始”的遮罩后面。'
        + '请在「播放启动动作」里填遮罩的选择器后重录，或改用「演示录制」自己点开后录。';
      setStatus('⚠ ' + state.canvasWarn, 'warn');
    }
  }, 1500);

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
      /* 不传 repaint：走默认 repaintOnce 让页面真实重绘一帧，再补绘 canvas / video 像素 */
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

      const canvas = await renderFrameCanvas(doc, vw, vh, scale, map, sy, () => {
        /* 虚拟时钟下同步重绘一帧：页面 rAF 回调执行完立即补绘，能读到 WebGL 真实像素 */
        clock.tick(t);
        for (const a of anims) { try { a.currentTime = t; } catch (e) {} }
      });
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
  /* 整页快照同样需要补画 canvas / video，否则滚动模式整片黑 */
  try {
    await repaintOnce(win);
    const ctx = canvas.getContext('2d');
    paintLiveLayers(doc, ctx, {
      scale,
      vw,
      vh: logicalH,
      extraOffset: win.scrollY || 0,
    });
  } catch (e) {
    console.warn('[snapshot live-layer]', e && e.message);
  }
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
  if (state.demoStream) { state.demoStream.getTracks().forEach(t => t.stop()); state.demoStream = null; }
  /* 演示录制的页面标签页保留不动：用户可能还想继续玩，工具只负责停止采集 */
  if (state.demoRecorded) {
    /* 焦点回 Studio 放到转码完成后再做（见 finish），否则切窗口那几帧会被录进尾部 */
    state.demoFocusBack = true;
  }
  state.demoTab = null;
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
  /* 演示录制是整屏/整标签页采集，画面里常带浏览器地址栏、桌面、任务栏。
     勾选“演示画面裁边”时按输出比例居中裁剪再缩放，让成片只保留内容本身。 */
  const [oW, oH] = outputSize();
  const demoCrop = !!(state.demoRecorded && $('optDemoCrop') && $('optDemoCrop').checked);
  const wantFmt = $('optFormat').value;
  const rawMime = (state.rawMime || state.rawBlob.type || '').toLowerCase();
  const rawIsH264Mp4 = rawMime.includes('mp4') && (rawMime.includes('avc') || rawMime.includes('h264'));
  const rawIsMp4 = rawMime.includes('mp4');

  // 需要 ffmpeg 的情形：要 MP4 但不是原生 H.264、或要 WebM 但原始是 MP4、或要变速、或要混音
  const toWebm = (wantFmt === 'webm' && rawIsMp4);
  const needFfmpeg = (wantFmt === 'mp4' && !rawIsH264Mp4) || toWebm || speed !== 1 || !!music || demoCrop;

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
  const vfChain = [];
  if (demoCrop) {
    // 居中裁剪成目标比例（不改形变），再缩放到目标分辨率
    vfChain.push(`crop=w=min(iw\\,ih*${oW}/${oH}):h=min(ih\\,iw*${oH}/${oW}):x=(iw-ow)/2:y=(ih-oh)/2`);
    vfChain.push(`scale=${oW}:${oH}:flags=bicubic`);
  }
  if (speed !== 1) vfChain.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  const vf = vfChain.length ? vfChain.join(',') : null;
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
  /* 演示录制在演示页点的“结束”：录制已停，这时再把焦点拉回 Studio 才安全 */
  if (state.demoFocusBack) {
    state.demoFocusBack = false;
    try { window.focus(); } catch (_) {}
  }
  const base = `✅ 已生成 ${ext.toUpperCase()}（${fmtSize(state.resultBlob.size)}），点击下载。`;
  const extra = [];
  if (state.blackWarn) {
    extra.push('⚠️ 自检提示：成片中有大量纯黑画面，多半是 canvas / WebGL / iframe 等特殊渲染导致。请改用「演示录制」模式重录，可完整保留游戏与交互画面。');
  }
  if (state.canvasWarn) extra.push('⚠️ ' + state.canvasWarn);
  if (extra.length) setStatus(base + '\n' + extra.join('\n'), 'warn');
  else setStatus(base, 'ok');
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

/* ---------- 演示录制 ----------
 * 场景：游戏、可交互 Demo、需要键盘/鼠标输入或真实时钟的复杂页面。
 * 逐帧引擎对这类页面无能为力（虚拟时钟会冻结游戏循环、输入无法产生），
 * 因此改成：真正打开页面 → 采集标签页画面 → 用户亲手玩/演示 → 完成后转码。
 * 好处：WebGL、canvas、iframe、音视频、键鼠交互全部原样保留，分辨率跟随真实窗口（可 F11 全屏）。 */
async function startDemoRecording() {
  if (!state.files || !state.entry) { setStatus('请先上传 HTML 文件', 'err'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setStatus('当前浏览器不支持屏幕/标签页录制（需要 Chrome / Edge 桌面版）。', 'err');
    return;
  }
  if (!state.swReady) { setStatus('虚拟目录尚未就绪，请稍候再点开始（或重新上传文件）。', 'err'); return; }

  const fps = Math.max(24, parseInt($('optFps').value) || 30);
  const withAudio = !!($('optAudio') && $('optAudio').checked);

  /* 关键顺序：window.open 与 getDisplayMedia 必须处在同一个用户点击任务里，
     否则弹窗被拦截、或捕获授权因“缺少用户手势”直接失败。 */
  let tab = null;
  try {
    tab = window.open('./__vfs__' + state.entry + '?__mcv=demo', '_blank');
  } catch (e) { tab = null; }
  if (!tab) {
    setStatus('新标签页被浏览器拦截：请允许本站弹出窗口后重试。', 'err');
    return;
  }
  state.demoTab = tab;

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      /* 优先引导用户选“标签页”：这样录到的就是纯网页画面，天然就是全屏、没有地址栏。
         排除当前 Studio 页，避免误选自己；允许录制中切换共享源。 */
      video: {
        frameRate: { ideal: fps, max: 60 },
        displaySurface: 'browser',
      },
      audio: withAudio,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });
  } catch (e) {
    try { tab.close(); } catch (_) {}
    state.demoTab = null;
    setStatus('未获得录制授权（' + (e && e.message ? e.message : e) + '）。提示：在弹出的选择器里选刚打开的那个标签页。', 'err');
    return;
  }

  state.recording = true;
  state.demoStream = stream;
  state.demoRecorded = true;
  state.demoStart = performance.now();
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('btnDownload').disabled = true;
  setProgress(0, '');

  attachPreview(stream);
  makeRecorder(stream, 12_000_000);

  /* 授权完成后尽量把演示标签页提到前面：用户不必再手动切换，
     录到的开头就不会是本 Studio 的界面。 */
  try { if (state.demoTab && state.demoTab.focus) state.demoTab.focus(); } catch (_) {}

  const vt = stream.getVideoTracks()[0];
  if (vt) vt.addEventListener('ended', () => { if (state.recording) stopRecording(); });

  /* 用户可能误选“整个屏幕”：录到的会带桌面和别的窗口，裁边也救不回来。
     这里读 displaySurface 给一次明确提示，计时状态里一直挂着。 */
  let surface = '';
  try {
    const vs = vt && vt.getSettings ? vt.getSettings() : {};
    surface = vs.displaySurface || '';
  } catch (_) {}
  if (surface === 'monitor') {
    state.demoWarn = '⚠ 你选的是“整个屏幕”，成片会包含桌面与其它窗口。想要干净的全屏网页画面，请停止后重来，在弹窗里改选那个标签页 / Chrome 标签页。';
  } else if (surface === 'window') {
    state.demoWarn = '提示：你选的是“窗口”，画面里会有浏览器标题栏。想要纯净全屏画面，可停止后改选那个标签页。';
  } else {
    state.demoWarn = '';
  }

  /* 演示页里的“结束录制”胶囊会调这个函数：用户在新标签页直接结束，
     不用切回 Studio，成片尾部不会闪进本页界面。 */
  window.__MCV_stopDemo = () => { if (state.recording) stopRecording(); };
  window.addEventListener('message', (e) => {
    if (e && e.data && e.data.__mcv === 'stop-demo' && state.recording) stopRecording();
  });

  setStatus('演示录制中：切到新标签页，先点页面上的“进入全屏”按钮，再正常播放 / 点击 / 游玩；结束后回到本页点“停止”。'
    + (state.demoWarn ? '\n' + state.demoWarn : ''), state.demoWarn ? 'warn' : 'ok');
  state.timer = setInterval(() => {
    const s = Math.round((performance.now() - state.demoStart) / 1000);
    setStatus(`演示录制中 ${s}s：在新标签页全屏操作，结束后回到本页点“停止”。`
      + (state.demoWarn ? '\n' + state.demoWarn : ''), state.demoWarn ? 'warn' : 'ok');
  }, 1000);
}

/* ---------- 产物黑屏自检 ----------
 * 录制/编码后抽若干帧统计暗像素比例：整片接近纯黑时明确告警并给出替代方案，
 * 避免用户拿到一个“看起来成功、实际全黑”的视频。 */
async function detectBlackFrames(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let done = false;
    const cleanup = (val) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch (_) {}
      resolve(val);
    };
    setTimeout(() => cleanup(null), 8000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    v.onerror = () => cleanup(null);
    v.onloadedmetadata = async () => {
      try {
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        if (!dur) return cleanup(null);
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        const ctx = c.getContext('2d');
        const samples = 6;
        let dark = 0, counted = 0;
        for (let i = 0; i < samples; i++) {
          const t = Math.min(dur - 0.05, dur * (i + 0.5) / samples);
          await new Promise((res) => {
            const onSeeked = () => { v.removeEventListener('seeked', onSeeked); res(); };
            v.addEventListener('seeked', onSeeked);
            setTimeout(res, 1200);
            try { v.currentTime = Math.max(0, t); } catch (e) { res(); }
          });
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0, n = 0;
          for (let p = 0; p < d.length; p += 4) {
            sum += (d[p] + d[p + 1] + d[p + 2]) / 3;
            n++;
          }
          const mean = sum / Math.max(1, n);
          if (mean < 12) dark++;
          counted++;
        }
        cleanup({ darkRatio: counted ? dark / counted : 0, samples: counted });
      } catch (e) { cleanup(null); }
    };
  });
}

/* ---------- 主流程 ---------- */
async function start() {
  if (!state.files || !state.entry) { setStatus('请先上传 HTML 文件', 'err'); return; }

  /* 演示录制必须在用户点击的同一任务里发起（getDisplayMedia 需要用户手势），
     所以放在任何 await 之前，第一时间打开标签页并申请捕获。 */
  if ($('optMode').value === 'demo') {
    await startDemoRecording();
    return;
  }

  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('btnDownload').disabled = true;
  state.recording = true;
  state.blackWarn = false;
  state.canvasWarn = '';
  state.demoRecorded = false;

  try {
    if (!state.swReady) await setupVFS();
    setStatus('加载用户页面…');
    await loadUserPage();
    await waitHidden($('optWaitHidden').value.trim());
    if ($('optInjectJs').value.trim()) {
      await evaluate($('optInjectJs').value);
    }
    /* 点“播放启动动作”之前先扫一眼：若页面被一层铺满视口的“点击开始”遮罩挡住，
       自动把它的选择器填进启动动作，否则 canvas 直录会拿到 0 字节 / 全黑成片。 */
    if (!($('optClickSel').value || '').trim()) {
      const ovPre = findStartOverlay(frame.win, frame.doc, frame.W, frame.H);
      if (ovPre && ovPre.sel) {
        $('optClickSel').value = ovPre.sel;
        console.info('[auto-click] 检测到开始遮罩', ovPre);
      }
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
    const bigCanvas = pickCanvas();            // 铺满视口 → 可以直录
    const anyCanvas = pickCanvas(0.12);        // 只要有一定面积的 canvas，就必须走视口逐帧 + 补绘
    const scrollable = (frame.doc.documentElement.scrollHeight > frame.H + 4);
    const motion = hasMotion(frame.doc);

    // 兼容性预检
    const issues = scanCompat(frame.doc);
    if (issues.length) console.warn('[compat]', issues);

    let modeReal = mode;
    let hint = '';
    if (modeReal === 'auto') {
      /* canvas 面积占比：游戏/动画页的 canvas 往往只占视口一部分（周围有 HUD、按钮、说明），
         以前会被判成“整页滚动”，整页快照只能截一帧静态图，看起来就是黑屏/不动。
         现在只要存在大 canvas 就走视口逐帧（逐帧时 canvas 会被真实补绘），保证画面是活的。 */
      let canvasRatio = 0;
      if (anyCanvas) {
        const r = anyCanvas.getBoundingClientRect();
        canvasRatio = (r.width * r.height) / Math.max(1, frame.W * frame.H);
      }
      if (bigCanvas && canvasRatio >= 0.7 && !hasDomText(frame.doc)) modeReal = 'canvas';
      else if (anyCanvas && canvasRatio >= 0.12) modeReal = 'dom';
      else if (scrollable) modeReal = 'scroll';
      else modeReal = 'dom';
      if (anyCanvas && modeReal !== 'canvas') {
        hint = '检测到 canvas 动画区：已自动补绘真实画面；若页面需要点击/键盘操作，请改用「演示录制」模式。';
      }
      /* 页面注册了大量键鼠监听 → 典型游戏/交互 Demo，逐帧录制只会得到静止画面 */
      let inputHits = 0;
      try {
        inputHits = (frame.win && frame.win.__MCV && frame.win.__MCV.input) || 0;
      } catch (e) { /* 跨域访问限制忽略 */ }
      if (inputHits >= 2) {
        hint = (hint ? hint + '\n' : '')
          + `这个页面注册了 ${inputHits} 处键鼠/触摸监听，属于交互型页面（游戏 / 可操作 Demo）：`
          + '逐帧录制无法产生真实输入，建议改用「演示录制」，自己点着玩、全程真实录下来。';
      }
      /* 铺满视口的“点击开始”遮罩：直接录只会得到静止/空白画面 */
      const ov = findStartOverlay(frame.win, frame.doc, frame.W, frame.H);
      if (ov && ov.sel) {
        const cur = ($('optClickSel').value || '').trim();
        if (!cur) {
          $('optClickSel').value = ov.sel;
          hint = (hint ? hint + '\n' : '')
            + `页面有一层"${ov.text || '开始'}…"遮罩铺满画面，已自动把「播放启动动作」填为 ${ov.sel}；`
            + '录制时会先点它再开始。若点了没反应，改用「演示录制」自己点开再录。';
        } else {
          hint = (hint ? hint + '\n' : '')
            + `页面有一层铺满画面的遮罩（${ov.sel}），如果录出来是静态画面，把「播放启动动作」改成它。`;
        }
      }
      const label = modeReal === 'canvas' ? '动画（canvas 直录）'
        : modeReal === 'scroll' ? '整页滚动' : '动画（视口内）';
      const engLabel = modeReal === 'canvas' ? '实时直录' : (engine === 'fast' ? '实时' : '精确逐帧');
      setStatus(`自动判定：${label}｜引擎：${engLabel}`
        + (issues.length ? `\n兼容性提示：${issues.join('；')}` : '')
        + (hint ? `\n${hint}` : ''), (issues.length || hint) ? 'warn' : '');
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
    clearInterval(state.timer);
    /* 成片黑屏自检：只做提示，不阻塞产物 */
    try {
      const chk = await detectBlackFrames(state.rawBlob);
      if (chk && chk.darkRatio >= 0.85) state.blackWarn = true;
      console.debug('[black-check]', chk);
    } catch (e) { console.warn('[black-check]', e && e.message); }
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

  /* 演示模式：不走逐帧引擎，把只对逐帧生效的设置置灰，避免误解 */
  const syncModeUI = () => {
    const demo = $('optMode').value === 'demo';
    ['optEngine', 'optDuration', 'optClickSel', 'optWaitHidden', 'optDelay',
      'optInjectJs', 'optStopJs', 'optScrollSpeed'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = demo;
    });
    /* 分辨率决定了成片比例，演示模式照样要能选（裁边会按它对齐） */
    $('optDurationSec').disabled = demo || $('optDuration').value !== 'fixed';
    if ($('optDemoCrop')) {
      $('optDemoCrop').disabled = !demo;
      $('optDemoCrop').closest('.check').style.opacity = demo ? '1' : '0.45';
    }
    if ($('optAudio')) {
      $('optAudio').disabled = !demo;
      $('optAudio').closest('.check').style.opacity = demo ? '1' : '0.45';
    }
    if (demo) {
      setStatus('演示录制：点“开始录制”会新开一个标签页并请求录制授权——在弹窗里选“这个标签页 / Chrome 标签页”，然后在新页面点“进入全屏”，再正常播放/游玩，结束回到本页点“停止”。', 'ok');
    }
  };
  $('optMode').addEventListener('change', syncModeUI);
  syncModeUI();
}

async function handleFiles(files) {
  try {
    setStatus('解析文件…');
    const { files: fmap, entry } = await collectFiles(files);
    state.files = fmap; state.entry = entry; state.swReady = false;
    $('fileBox').hidden = false;
    const list = Object.keys(fmap);
    $('fileList').textContent = `${list.length} 个文件 · 入口 ${entry}` + (list.length > 8 ? `\n${list.slice(0, 8).join('\n')}\n…等` : '\n' + list.join('\n'));
    /* 上传后立刻准备好虚拟目录：演示录制要在点击瞬间同步打开新标签页，
       不能等到点“开始”时再 await，否则会丢掉用户手势。 */
    try {
      await setupVFS();
    } catch (e) {
      console.warn('[vfs]', e && e.message);
    }
    setStatus(`就绪：入口 ${entry}。可开始录制。` + (state.swReady ? '' : '（虚拟目录初始化失败，演示录制不可用）'), state.swReady ? 'ok' : 'warn');
    $('btnStart').disabled = false;
  } catch (e) {
    setStatus('解析失败: ' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', initEvents);
