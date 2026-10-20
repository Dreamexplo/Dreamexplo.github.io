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
  micStream: null,      // 演示录制：麦克风解说流
  audioCtx: null,       // 演示录制：音频混合上下文
  mixDest: null,        // 演示录制：混合后的音频出口
  demoRecorded: false,  // 本次是否演示录制
  voiceFile: null,      // 导入的配音音轨
  origVideoFile: null,  // 导入的原声视频（回声消除用）
  musicFile: null,      // 背景音乐
  cfg: null,            // 本次录制的参数快照（录制中改面板不会污染当前任务）
  previewStream: null,  // 逐帧预览流
  previewTrack: null,
  foFallback: false,    // html2canvas 文字缺失时自动切 foreignObject 渲染
  videoInfo: null,      // 成片信息 {frames, fps, seconds}
};

/* 读取面板参数生成快照。
 * 关键：所有录制/编码流程只读这份快照，不再在渲染中途直接读 DOM。
 * 否则用户一动面板控件（会触发 change → 预览重建），正在跑的录制就会拿到
 * 半截参数、甚至丢掉 iframe 引用，表现就是“一调参数就黑屏”。 */
function readCfg() {
  const el = (id) => document.getElementById(id);
  const val = (id, d) => { const e = el(id); return e ? e.value : d; };
  const on = (id) => { const e = el(id); return e ? !!e.checked : false; };
  const num = (id, d) => { const v = parseFloat(val(id, '')); return Number.isFinite(v) ? v : d; };
  return {
    mode: val('optMode', 'auto'),
    engine: val('optEngine', 'precise'),
    size: val('optSize', '1280x720'),
    fps: Math.max(1, parseInt(val('optFps', '10'), 10) || 10),
    durMode: val('optDuration', 'fixed'),
    fixedSec: num('optDurationSec', 10),
    stopJs: String(val('optStopJs', '') || '').trim(),
    scrollSpeed: num('optScrollSpeed', 150),
    clickSel: String(val('optClickSel', '') || '').trim(),
    waitHidden: String(val('optWaitHidden', '') || '').trim(),
    delay: num('optDelay', 500),
    injectJs: String(val('optInjectJs', '') || '').trim(),
    format: val('optFormat', 'mp4'),
    speed: (() => { const s = num('optSpeed', 1); return s > 0 ? s : 1; })(),
    demoCrop: on('optDemoCrop'),
    sysAudio: on('optAudio'),
    voice: on('optVoice'),
    voiceVol: num('optVoiceVol', 100) / 100,
    sysVol: num('optSysVol', 80) / 100,
    musicVol: num('optMusicVol', 70) / 100,
    origVol: num('optOrigVol', 100) / 100,
    voiceDelay: num('optVoiceDelay', 0),
  };
}

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
  const cw = host.clientWidth, ch = host.clientHeight;
  /* 容器尺寸为 0（移动端地址栏收起、面板折叠、布局切换的瞬间）时不能重算，
     否则 scale 会算成 0，预览区看起来就是“一调面板就黑屏”。 */
  if (cw < 8 || ch < 8) return;
  const k = Math.min(cw / frame.W, ch / frame.H) * 0.96;
  if (!Number.isFinite(k) || k <= 0) return;
  wrap.style.transform = `translate(-50%,-50%) scale(${k})`;
}
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 150));
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStage);
if (window.ResizeObserver) {
  const hostEl = document.querySelector('.preview-body');
  if (hostEl) new ResizeObserver(() => fitStage()).observe(hostEl);
}

/* 只改舞台尺寸，不重建 iframe / 不重载页面：
   面板里调分辨率、调参数时预览始终保持在屏，不会因为重建 iframe 变成黑屏。 */
function resizeStage() {
  if (!frame.wrap) return;
  const [W, H] = currentSize();
  if (!W || !H) return;
  frame.W = W; frame.H = H;
  frame.wrap.style.width = W + 'px';
  frame.wrap.style.height = H + 'px';
  if (frame.iframe) { frame.iframe.width = String(W); frame.iframe.height = String(H); }
  try { frame.win && frame.win.dispatchEvent(new Event('resize')); } catch (e) {}
  fitStage();
}

function currentSize() {
  const v = ($('optSize') && $('optSize').value) || '1280x720';
  const [w, h] = v.split('x').map(Number);
  return [w || 1280, h || 720];
}

/* 移动端 / 触屏设备判定：用于收起桌面专属能力（标签页采集、长时长录制） */
function isMobile() {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) <= 820;
  const ua = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
  return ua || (coarse && small);
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
  await injectPageCompat();
}

/* ---------- 类视频 HTML 页面兼容层（问题 6） ----------
 * 很多“视频式”HTML 页面（全屏 stage + top:50%+translate(-50%,-50%) 居中 +
 * 固定像素字号 + html2canvas 无法解析的现代 CSS）在离屏克隆里会被整体错位、
 * 文字被裁掉或字号被压成 1px，成片里就成了“看不到字”的黑块。
 * 修复方式：在渲染前把这些页面临时切成“静态快照模式”——
 * 1) 去掉影响克隆定位的居中 transform / 固定定位，改为 0 起点布局；
 * 2) 给字号加上不依赖 rem/vw 的兜底；
 * 3) 关闭 html2canvas 不支持的 backdrop-filter 等属性；
 * 4) 渲染结束（finally）立即还原，不影响用户原页面。 */
const COMPAT_LOCK = '__mcv_compat_lock';

function injectPageCompat() {
  return (async () => {
    try {
      const doc = frame.doc, win = frame.win;
      if (!doc) return;
      const st = doc.createElement('style');
      st.id = '__mcv_compat_css';
      st.textContent = `
        /* html2canvas 无法绘制：会导致整页渲染失败或元素消失 */
        *{ -webkit-backdrop-filter:none !important; backdrop-filter:none !important;
           mix-blend-mode:normal !important; }
        /* 旧版 html2canvas 对 8 位色解释错误 */
        html, body{ filter:none !important; }
        /* 文字光栅加固：避免离屏克隆时文字被裁剪/透明化 */
        h1,h2,h3,h4,h5,h6,p,span,div,li,td,th,a,button{
          text-rendering:optimizeLegibility;
          -webkit-font-smoothing:antialiased;
        }
      `;
      (doc.head || doc.documentElement).appendChild(st);
      /* 记录页面自身的输入监听数，供 auto 模式判定交互页 */
      try {
        win.__MCV = win.__MCV || {};
        if (typeof win.__MCV.input !== 'number') win.__MCV.input = 0;
      } catch (e) {}
    } catch (e) {
      console.warn('[compat]', e && e.message);
    }
  })();
}

/* 进入静态快照模式：把“铺满视口 + 居中 transform”的舞台层摊平。
 * 返回 restore()，必须在 finally 中调用。 */
function enterStaticSnapshot(doc, win) {
  const undo = [];
  try {
    if (doc.documentElement && doc.documentElement.hasAttribute(COMPAT_LOCK)) {
      /* 已被其它流程锁定，避免重复叠加 */
    }
    const body = doc.body;
    if (body) {
      const prevOverflow = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = 'visible';
      undo.push(() => { doc.documentElement.style.overflow = prevOverflow; });
      const prevBodyOverflow = body.style.overflow;
      body.style.overflow = 'visible';
      undo.push(() => { body.style.overflow = prevBodyOverflow; });
    }
    /* 关键修复：找到用 left/top 50% + translate(-50%,-50%) 居中的容器，
       这种布局在 html2canvas 的克隆里会整体偏移半屏，文字被裁出画布。 */
    const cands = doc.querySelectorAll('#stage, .stage, #app, .app, #root, .root, [class*="stage"], [class*="wrap"]');
    cands.forEach((el) => {
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return; }
      const t = cs.transform || '';
      const centered = /translate\(-50%,\s*-50%\)/.test(t) || /matrix\(1,\s*0,\s*0,\s*1,\s*-/.test(t);
      const absoluteCentered = (cs.position === 'absolute' || cs.position === 'fixed')
        && /50%/.test(cs.left || '') && /50%/.test(cs.top || '');
      if (!centered && !absoluteCentered) return;
      const prev = el.getAttribute('style') || '';
      el.style.setProperty('left', '0', 'important');
      el.style.setProperty('top', '0', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('position', 'relative', 'important');
      undo.push(() => { el.setAttribute('style', prev); });
    });
    /* 字号兜底：rem/vw 在离屏克隆里解析异常时，强制一个可读下限 */
    const small = [];
    doc.querySelectorAll('body *').forEach((el) => {
      if (el.children.length > 0) return;
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return; }
      const fs = parseFloat(cs.fontSize) || 0;
      if (fs > 0 && fs < 9) {
        small.push([el, el.style.fontSize]);
        el.style.setProperty('font-size', '12px', 'important');
      }
    });
    small.forEach(([el, prev]) => undo.push(() => { el.style.fontSize = prev; }));
    doc.documentElement.setAttribute(COMPAT_LOCK, '1');
    undo.push(() => doc.documentElement.removeAttribute(COMPAT_LOCK));
  } catch (e) {
    console.warn('[static-snapshot]', e && e.message);
  }
  return () => { while (undo.length) { try { undo.pop()(); } catch (e) {} } };
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
/* canvas 上方是否存在可见的 DOM 覆盖层（标题、字幕、按钮、计分板…）。
 * 只录 canvas 像素的“直录”模式会把这类覆盖层整块丢掉，成片里文字就消失了，
 * 所以决定是否直录之前必须先量一下覆盖面积占比。 */
function canvasOverlayRatio(doc, canvas) {
  if (!doc || !canvas) return 0;
  const win = doc.defaultView || window;
  const cr = canvas.getBoundingClientRect();
  if (cr.width < 2 || cr.height < 2) return 0;
  const areaC = cr.width * cr.height;
  let covered = 0;
  doc.querySelectorAll('body *').forEach((el) => {
    if (el === canvas || el.contains(canvas) || canvas.contains(el)) return;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (parseFloat(cs.opacity || '1') < 0.05) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const ix = Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
    const iy = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
    if (ix <= 0 || iy <= 0) return;
    /* 只看“自带视觉内容”的元素：有可见背景、有图片/视频，或直接含可见文字 */
    let visible = false;
    const bg = cs.backgroundColor || '';
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (m) {
      const p = m[1].split(',').map(v => parseFloat(v.trim()));
      if ((p.length > 3 ? p[3] : 1) > 0.05) visible = true;
    }
    if (!visible && cs.backgroundImage && cs.backgroundImage !== 'none') visible = true;
    if (!visible && /^(IMG|VIDEO|SVG|PICTURE)$/.test(el.tagName)) visible = true;
    if (!visible) {
      const direct = Array.prototype.some.call(el.childNodes, (n) =>
        n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0);
      if (direct) visible = true;
    }
    if (!visible) return;
    covered += ix * iy;
  });
  return Math.min(1, covered / areaC);
}

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

/* 相对亮度（0=黑 1=白），用来判断底色深浅，决定要不要给文字兜白色 */
function relLuminance(color) {
  const m = /rgba?\(([^)]+)\)/.exec(color || '');
  let r, g, b;
  if (m) {
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    r = p[0]; g = p[1]; b = p[2];
  } else if (/^#([0-9a-f]{6})$/i.test(color || '')) {
    const h = color.slice(1);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else if (/^#([0-9a-f]{3})$/i.test(color || '')) {
    const h = color.slice(1);
    r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
  } else {
    return null;
  }
  if ([r, g, b].some(v => typeof v !== 'number' || isNaN(v))) return null;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* 把 canvas 当前像素烘焙进 html2canvas 的克隆副本（作为元素背景图）。
 * 为什么必须这么做：html2canvas 拿不到 canvas 的真实像素（克隆里是空白），
 * 原来的做法是“截完图再把 canvas 像素整块盖上去”，但整屏 canvas 会把盖在它上方的
 * DOM 文字（片名、字幕、按钮）一起涂掉 —— 成片就变成“有画面没文字”。
 * 烘焙进克隆后，html2canvas 按 DOM 顺序绘制：先 canvas 图像、再上层的文字，层级正确。
 * 返回成功烘焙的源 canvas 集合，供 paintLiveLayers 跳过（避免重复覆盖）。 */
function bakeCanvasPixels(sourceDoc, clonedDoc, skipSet) {
  const src = Array.from(sourceDoc.querySelectorAll('canvas'));
  const cl = Array.from(clonedDoc.querySelectorAll('canvas'));
  let n = 0;
  for (let i = 0; i < src.length && i < cl.length; i++) {
    const s = src[i], c = cl[i];
    if (!s || !c || s.width < 1 || s.height < 1) continue;
    let url = '';
    try { url = s.toDataURL('image/png'); } catch (e) { url = ''; }   // 跨域污染 → 降级为补绘
    if (!url || url.length < 32) continue;
    try {
      c.style.setProperty('background-image', 'url("' + url + '")', 'important');
      c.style.setProperty('background-size', '100% 100%', 'important');
      c.style.setProperty('background-repeat', 'no-repeat', 'important');
      if (skipSet) skipSet.add(s);
      n++;
    } catch (e) { /* 单个失败不影响整帧 */ }
  }
  return n;
}

/* 渲染一帧（带动画状态烘焙）
 * 注意：必须显式给出 width/height 裁剪区域，否则 html2canvas 会把整篇文档
 * （可能上万像素高）整体栅格化后缩放到视口，画面被纵向压扁。 */
async function renderFrameCanvas(doc, vw, vh, scale, targets, scrollTop, repaint, extra) {
  const opts = extra || {};
  const target = doc.documentElement || doc.body;
  const sy = Math.max(0, scrollTop || 0);
  const bakedCanvases = new WeakSet();
  const base = {
    useCORS: true,
    allowTaint: false,
    backgroundColor: opts.bg || '#000',
    windowWidth: vw,
    windowHeight: vh,
    logging: false,
    onclone: (clonedDoc) => {
      bakeAnimated(doc, clonedDoc, targets);
      /* canvas 像素必须先烘焙进克隆，否则后置补绘会盖住叠在 canvas 上的文字 */
      try { bakeCanvasPixels(doc, clonedDoc, bakedCanvases); } catch (e) {}
      /* 克隆副本里同样关掉 html2canvas 不支持的属性（style 在 onclone 后才会被解析，
         这里再做一次兜底，防止克隆时丢掉 head 里的兼容样式） */
      try {
        const cs = clonedDoc.createElement('style');
        cs.textContent = '*{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;mix-blend-mode:normal!important}';
        (clonedDoc.head || clonedDoc.documentElement).appendChild(cs);
        if (opts.textSafe) {
          const fs = clonedDoc.createElement('style');
          /* 只按底色深浅决定文字兜底色：深底白字、浅底不覆写。
             以前无条件 body{color:#fff} 会把浅色页面的黑字洗成白纸白字。 */
          const bgLum = relLuminance(opts.bg);
          const safeRule = bgLum !== null && bgLum > 0.62 ? '' : 'body{color:#fff!important}';
          fs.textContent = 'body *{filter:none!important;text-shadow:none!important}' + safeRule;
          (clonedDoc.head || clonedDoc.documentElement).appendChild(fs);
        }
      } catch (e) {}
    },
  };
  let out;
  if (opts.fullDoc) {
    /* 静态快照模式（类视频页面）：不裁视口，整篇文档一次性栅格化后由外层缩放，
       避免整屏 stage 的居中 transform 让文字被裁出画布。 */
    const full = doc.documentElement || doc.body;
    const h = Math.max(full.scrollHeight || 0, vh);
    out = await html2canvas(full, Object.assign({}, base, {
      scale: Math.min(scale, Math.max(0.4, 1280 / vw)),
      width: vw, height: h, x: 0, y: 0, scrollX: 0, scrollY: 0,
    }));
  } else {
    out = await html2canvas(target, Object.assign({}, base, {
      scale, width: vw, height: vh, x: 0, y: sy, scrollX: 0, scrollY: sy,
    }));
  }
  /* 补画 canvas / video：先让页面重绘一次，确保能读到 WebGL 的真实像素 */
  try {
    if (typeof repaint === 'function') await repaint();
    else await repaintOnce(doc.defaultView || window);
    const ctx = out.getContext('2d');
    const outScale = out.width / Math.max(1, vw);
    const cssH = opts.fullDoc ? out.height / outScale : vh;
    const n = paintLiveLayers(doc, ctx, { scale: outScale, vw, vh: cssH, skip: bakedCanvases });
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
  const { scale = 1, vw, vh, extraOffset = 0, skip = null } = opt;
  let painted = 0;
  for (const l of listLiveLayers(doc, vw, vh, extraOffset)) {
    if (skip && skip.has(l.el)) continue;   // 已在克隆里烘焙过，再盖一次会遮住上层文字
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

/* 边渲染边落盘的帧序列编码器：帧写进 ffmpeg 虚拟文件系统，不在 JS 内存里囤。
 * 这样长视频不会被内存撑爆、也不会被帧数上限悄悄截断。 */
async function openSeqEncoder(fps) {
  const ffmpeg = await getFFmpeg();
  const pad = (n) => String(n).padStart(5, '0');
  let count = 0;
  return {
    get count() { return count; },
    async write(canvas) {
      const blob = await canvasToJpegBlob(canvas, 0.92);
      const buf = new Uint8Array(await blob.arrayBuffer());
      await ffmpeg.writeFile('mc' + pad(count) + '.jpg', buf);
      count++;
    },
    async finish(onProgress) {
      if (!count) throw new Error('没有可编码的帧');
      await ffmpeg.exec([
        '-y', '-framerate', String(fps), '-i', 'mc%05d.jpg',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', 'mc_out.mp4',
      ]);
      onProgress && onProgress(0.9);
      const data = await ffmpeg.readFile('mc_out.mp4');
      for (let i = 0; i < count; i++) { try { await ffmpeg.deleteFile('mc' + pad(i) + '.jpg'); } catch (e) {} }
      try { await ffmpeg.deleteFile('mc_out.mp4'); } catch (e) {}
      onProgress && onProgress(1);
      return new Blob([data.buffer], { type: 'video/mp4' });
    },
  };
}

/* 成片背景色：页面自身没有不透明底色时（常见于类视频页面 body 透明），
 * 用黑色会把深色文字彻底吃掉 —— 这正是“文字看不见”的另一个原因。
 * 这里读 body/html 的真实背景色，透明则退回白，并保证前景文字有对比度。 */
function resolveFrameBg(doc, win) {
  const parse = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? (isNaN(p[3]) ? 1 : p[3]) : 1 };
  };
  try {
    for (const el of [doc.body, doc.documentElement]) {
      if (!el) continue;
      const c = parse(win.getComputedStyle(el).backgroundColor);
      if (c && c.a >= 0.9) return `rgb(${c.r},${c.g},${c.b})`;
    }
  } catch (e) {}
  return '#ffffff';
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
      /* 内容容器不是“开始”遮罩：里面包着 canvas/video/iframe，或文案很长时，
         当遮罩去点它可能触发跳转、甚至直接打断播放，误判代价很大。 */
      if (el.querySelector('canvas,video,iframe')) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 60) continue;
      /* 文案不像“开始/播放”提示的整屏浮层，多半只是内容层（标题、字幕），别当遮罩点 */
      if (txt && !/(开始|播放|点击|单击|进入|启动|继续|start|play|click|tap|enter)/i.test(txt)) continue;
      let sel = '';
      if (el.id) sel = '#' + el.id;
      else if (el.className && typeof el.className === 'string') sel = '.' + el.className.trim().split(/\s+/)[0];
      return { sel, text: (el.textContent || '').trim().slice(0, 18) };
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function startLiveCanvas(fps, opts = {}) {
  const canvas = pickCanvas(0.12);
  if (!canvas) throw new Error('未找到足够大的 canvas，请改用“滚动”模式或“逐帧”模式');
  await prepareOutputCanvas();

  /* 不再直接 captureStream 只录 canvas —— 那样页面上的文字/HUD/说明全丢，
     正是“类视频页面文字显示不出来”的根因之一。
     改为：DOM 栅格化（含文字） + canvas 真实像素补绘 → 合成到输出画布 → 采集输出画布。 */
  const doc = frame.doc, win = frame.win;
  const vw = frame.W, vh = frame.H;
  const targets = collectBakeTargets(doc);
  const scale = Math.min(1, 1600 / vw);
  const durMode = opts.durMode || 'fixed';
  const fixedSec = opts.fixedSec || 0;
  const stopJs = opts.stopJs || '';
  const stopScroll = false;

  state.stream = frame.outCanvas.captureStream(fps);
  attachPreview(state.stream);
  await attachAudioToStream(state.stream);
  state.recorder = makeRecorder(state.stream);
  if (state.micStream) startAudioMeter();

  const h0 = canvasHealth(canvas);
  const t0 = performance.now();
  let i = 0, lastWarn = 0;

  const loop = async () => {
    if (!state.recording) return;
    const started = performance.now();
    try {
      const shot = await renderFrameCanvas(doc, vw, vh, scale, targets, win.scrollY || 0, null, { bg: resolveFrameBg(doc, win), textSafe: true });
      frame.outCtx.fillStyle = resolveFrameBg(doc, win);
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(shot, 0, 0, vw, vh);
      i++;
      if (i === 45) {
        const h1 = canvasHealth(canvas);
        if (h1 && (h1.blank || (h0 && h1.sig === h0.sig))) {
          state.canvasWarn = state.canvasWarn
            || 'canvas 画面一直是空白/静止：页面很可能停在“点击开始”的遮罩后面。'
            + '请在「播放启动动作」里填遮罩的选择器后重录，或改用「演示录制」自己点开后录。';
          setStatus('?? ' + state.canvasWarn, 'warn');
        }
      }
      if (stopJs && i % 10 === 0) {
        try {
          const done = await evaluate(`(function(){ try { return !!(${stopJs}); } catch(e){ return false; } })()`);
          if (done) { stopRecording(); return; }
        } catch (e) {}
      }
      if (durMode === 'fixed' && fixedSec > 0) {
        const el = (performance.now() - t0) / 1000;
        setProgress(Math.min(0.99, el / fixedSec), `录制中 ${el.toFixed(1)}/${fixedSec}s`);
        if (el >= fixedSec) { stopRecording(); return; }
      } else if (performance.now() - lastWarn > 1000) {
        setStatus(`录制中 ${((performance.now() - t0) / 1000).toFixed(0)}s（点“停止”结束）`);
        lastWarn = performance.now();
      }
    } catch (err) {
      stopRecording();
      setStatus('逐帧渲染错误: ' + err.message, 'err');
      console.error('[canvas-compose]', err);
      return;
    }
    const cost = performance.now() - started;
    setTimeout(loop, Math.max(8, 1000 / fps - cost));
  };
  loop();
  return () => {};
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
  const frameBg = resolveFrameBg(doc, win);
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
    let next = performance.now();
    const loop = () => {
      if (!state.recording) return;
      const p = Math.min(1, (performance.now() - t0) / 1000 / scrollDur);
      const srcY = Math.min(shot.canvas.height - visH, Math.round(maxScroll * p * k));
      frame.outCtx.fillStyle = frameBg;
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(shot.canvas, 0, srcY, shot.canvas.width, visH, 0, 0, vw, vh);
      step++;
      if (opts.onFrame) opts.onFrame(step);
      if (durMode === 'fixed' && fixedSec > 0) {
        setProgress(Math.min(0.99, (performance.now() - t0) / 1000 / fixedSec));
      }
      if (p >= 1) { stopRecording(); return; }
      /* 按“目标时刻”排下一帧，而不是固定等待 1/fps：
         否则每帧渲染耗时会被累加成漂移，成片时长比设定值长。 */
      next += 1000 / fpsInt;
      const wait = Math.max(0, next - performance.now());
      if (wait === 0) next = performance.now();
      setTimeout(loop, wait);
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
      const canvas = await renderFrameCanvas(doc, vw, vh, scale, targets, win.scrollY || 0, null, { bg: frameBg, textSafe: true });
      frame.outCtx.fillStyle = frameBg;
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
    nextAt += 1000 / fpsInt;
    setTimeout(loop, Math.max(0, nextAt - performance.now()));
  };
  let nextAt = performance.now();
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

  const MAX_FRAMES = 10800;   // 6 分钟 @30fps：帧不再驻留内存（逐帧直写 ffmpeg 虚拟盘）
  let capped = false;
  if (total > MAX_FRAMES) { total = MAX_FRAMES; capped = true; }

  const exact = total ? (total / fps) : 0;
  setStatus(`精确逐帧渲染中：${total ? total + ' 帧 / ' + exact.toFixed(2) + 's' : '手动停止'} @ ${fps}fps…`
    + (doScroll ? '（滚动整页）' : ''));
  if (capped) setStatus(`目标时长超过单次上限 ${(MAX_FRAMES / fps).toFixed(0)}s，将按该上限录制（可降低帧率或分段录制）。`, 'warn');
  /* 类视频页面：整屏居中舞台在克隆里会错位，进入静态快照模式再逐帧推进 */
  const restoreCompat = enterStaticSnapshot(doc, win);
  const frameBg = resolveFrameBg(doc, win);
  const clock = installVirtualClock(win);
  const scale = Math.min(1, 1600 / vw);
  const enc = await openSeqEncoder(fps);
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
      }, { bg: frameBg, textSafe: true });
      frame.outCtx.fillStyle = frameBg;
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(canvas, 0, 0, vw, vh);
      if (state.previewTrack) { try { state.previewTrack.requestFrame(); } catch (e) {} }

      /* 帧直接写进 ffmpeg 虚拟盘：内存占用与时长无关，长视频不再被截断 */
      await enc.write(frame.outCanvas);
      i++;

      if (total) setProgress(0.05 + 0.7 * (i / total), `渲染第 ${i}/${total} 帧（${((i / total) * 100).toFixed(0)}%）`);
      else setStatus(`渲染第 ${i} 帧…（点“停止”结束）`);

      /* 停止表达式每帧都判：以前每 10 帧才判一次，最长会多录 10/fps 秒 */
      if (opts.stopJs) {
        try {
          const done = await evaluate(`(function(){ try { return !!(${opts.stopJs}); } catch(e){ return false; } })()`);
          if (done) break;
        } catch (e) {}
      }
      if (i % 2 === 0) await sleep(0);
    }
  } finally {
    clock.restore();
    restoreCompat();
  }

  if (!i) throw new Error('未渲染到任何帧（页面可能为空）');
  if (capped) setStatus(`已达帧数上限 ${MAX_FRAMES}，视频被截断。请降低时长或帧率。`, 'warn');

  setProgress(0.78, `编码 ${i} 帧（ffmpeg.wasm，请稍候）…`);
  const mp4 = await enc.finish((p) => {
    setProgress(0.78 + 0.12 * p, `编码 ${(p * 100).toFixed(0)}%…`);
  });
  state.rawBlob = mp4;
  state.rawMime = 'video/mp4;codecs=avc1';
  state.videoInfo = { frames: i, fps, seconds: i / fps };
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
    backgroundColor: resolveFrameBg(doc, win),
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
  /* 先停采集再停麦克风：顺序反了会让音轨提前结束，尾部丢音 */
  clearInterval(state.stopPoll);
  clearTimeout(state.timer);
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  if (state.stream) state.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  if (state.demoStream) { state.demoStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); state.demoStream = null; }
  setTimeout(() => closeMic(), 300);
  if (state.meterRAF) { cancelAnimationFrame(state.meterRAF); state.meterRAF = null; }
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
    setStatus('? 录制失败：未捕获到有效画面（产物体积为 0）。请检查页面是否有可见内容，或换用其他模式后重试。', 'err');
    setProgress(0, '');
    $('btnDownload').disabled = true;
    state.recording = false;
    setStartDisabled(false);
    if (state.recorder && state.recorder.state !== 'inactive') { try { state.recorder.stop(); } catch (e) {} }
    return;
  }
  const cfg = state.cfg || readCfg();
  const speed = cfg.speed || 1;
  const music = state.musicFile;
  const voiceFile = state.voiceFile;
  const origFile = state.origVideoFile;
  /* 演示录制是整屏/整标签页采集，画面里常带浏览器地址栏、桌面、任务栏。
     勾选“演示画面裁边”时按输出比例居中裁剪再缩放，让成片只保留内容本身。 */
  const [oW, oH] = outputSize();
  const demoCrop = !!(state.demoRecorded && cfg.demoCrop);
  const wantFmt = cfg.format;
  const rawMime = (state.rawMime || state.rawBlob.type || '').toLowerCase();
  const rawIsH264Mp4 = rawMime.includes('mp4') && (rawMime.includes('avc') || rawMime.includes('h264'));
  const rawIsMp4 = rawMime.includes('mp4');

  // 需要 ffmpeg 的情形：要 MP4 但不是原生 H.264、或要 WebM 但原始是 MP4、或要变速、或要混音/配音
  const toWebm = (wantFmt === 'webm' && rawIsMp4);
  const needFfmpeg = (wantFmt === 'mp4' && !rawIsH264Mp4) || toWebm || speed !== 1
    || !!music || !!voiceFile || !!origFile || demoCrop;

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
  let idx = 1;
  const addInput = async (file, prefix) => {
    const name = prefix + extOf(file.name || '');
    await ffmpeg.writeFile(name, new Uint8Array(await file.arrayBuffer()));
    args.push('-i', name);
    return idx++;
  };
  const vVoice = voiceFile ? await addInput(voiceFile, 'voice') : -1;
  const vMusic = music ? await addInput(music, 'bgm') : -1;
  const vOrig = origFile ? await addInput(origFile, 'orig') : -1;

  /* 目标时长：以“设定时长 / 原始时长”为准，最后统一 -t 截断 —— 不管渲染快慢、录制多少帧，
     成片时长都严格等于设定值，这是“时间控制不准”的根治办法。 */
  const durRaw = await probeDuration();
  const durFixed = (cfg.durMode === 'fixed' && cfg.fixedSec > 0) ? cfg.fixedSec : 0;
  const durVideo = durFixed || (durRaw > 0 ? durRaw : 0);
  const durOut = durVideo > 0 ? durVideo / speed : 0;

  const filterParts = [];
  const mapArgs = [];
  const vfChain = [];
  if (demoCrop) {
    // 居中裁剪成目标比例（不改形变），再缩放到目标分辨率
    vfChain.push(`crop=w=min(iw\\,ih*${oW}/${oH}):h=min(ih\\,iw*${oH}/${oW}):x=(iw-ow)/2:y=(ih-oh)/2`);
    vfChain.push(`scale=${oW}:${oH}:flags=bicubic`);
  }
  if (speed !== 1) vfChain.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  if (vfChain.length) {
    filterParts.push(`[0:v:0]${vfChain.join(',')}[v0]`);
    mapArgs.push('-map', '[v0]');
  } else {
    mapArgs.push('-map', '0:v:0');
  }

  /* 音频混音：录进去的解说（麦克风轨）+ 导入的配音 + 背景音乐 + 页面原声，任意组合 */
  const aChains = [];
  const aLabels = [];
  const mk = (spec, label, c) => { aChains.push(`[${spec}]${c.join(',')}[${label}]`); aLabels.push(`[${label}]`); };
  if (hasAudio) {
    const c = [`volume=${(cfg.origVol != null ? cfg.origVol : 1).toFixed(2)}`];
    if (durOut) c.push(`atrim=0:${durOut.toFixed(3)}`);
    c.push('asetpts=PTS-STARTPTS');
    mk('0:a:0', 'araw', c);
  }
  if (vVoice >= 0) {
    const ms = Math.max(0, Math.round((cfg.voiceDelay || 0) * 1000));
    const c = [`volume=${(cfg.voiceVol != null ? cfg.voiceVol : 1).toFixed(2)}`, `adelay=${ms}|${ms}`];
    if (durOut) c.push(`atrim=0:${durOut.toFixed(3)}`);
    c.push('asetpts=PTS-STARTPTS');
    mk(`${vVoice}:a`, 'avoi', c);
  }
  if (vMusic >= 0) {
    const c = [`volume=${(cfg.musicVol != null ? cfg.musicVol : 0.3).toFixed(2)}`];
    if (durOut) c.push('aloop=loop=-1:size=2e9', `atrim=0:${durOut.toFixed(3)}`);
    c.push('asetpts=PTS-STARTPTS');
    mk(`${vMusic}:a`, 'abgm', c);
  }
  if (vOrig >= 0) {
    const c = [`volume=${(cfg.origVol != null ? cfg.origVol : 1).toFixed(2)}`];
    if (durOut) c.push(`atrim=0:${durOut.toFixed(3)}`);
    c.push('asetpts=PTS-STARTPTS');
    mk(`${vOrig}:a`, 'aorg', c);
  }
  if (aLabels.length) {
    if (aLabels.length === 1) filterParts.push(...aChains, `${aLabels[0]}anull[amixd]`);
    else filterParts.push(...aChains, `${aLabels.join('')}amix=inputs=${aLabels.length}:duration=longest:dropout_transition=0:normalize=0[amixd]`);
    if (speed !== 1) filterParts.push(`[amixd]${atempoChain(speed)}[aout]`);
    else filterParts.push('[amixd]anull[aout]');
    mapArgs.push('-map', '[aout]');
  }
  if (filterParts.length) args.push('-filter_complex', filterParts.join(';'));
  if (toWebm) {
    args.push(...mapArgs, '-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '5', '-pix_fmt', 'yuv420p');
  } else {
    args.push(...mapArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vsync', 'vfr');
  }
  if (aLabels.length) args.push('-c:a', toWebm ? 'libvorbis' : 'aac', '-b:a', '160k');
  if (durOut > 0) args.push('-t', durOut.toFixed(3));
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
      setStatus('?? H.264 转码失败，已输出原始编码 MP4（部分播放器可能不兼容）：' + (e.message || e), 'warn');
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
  const base = `? 已生成 ${ext.toUpperCase()}（${fmtSize(state.resultBlob.size)}），点击下载。`;
  const extra = [];
  if (state.blackWarn) {
    extra.push('?? 自检提示：成片中有大量纯黑画面，多半是 canvas / WebGL / iframe 等特殊渲染导致。请改用「演示录制」模式重录，可完整保留游戏与交互画面。');
  }
  if (state.canvasWarn) extra.push('?? ' + state.canvasWarn);
  if (extra.length) setStatus(base + '\n' + extra.join('\n'), 'warn');
  else setStatus(base, 'ok');
}

function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

/* ---------- UI 工具 ---------- */
/* 顶部与底部两个“开始”按钮始终同状态，避免移动端滚到底部时看不到可用按钮 */
function setStartDisabled(v) {
  ['btnStart', 'btnStart2'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = v;
  });
}
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

/* ---------- 解说音频采集与混音（问题 5） ----------
 * 录屏时同步录下用户解说：getUserMedia 拿麦克风 → WebAudio 混音 →
 * 作为一条音轨 addTrack 到录制的视频流上，MediaRecorder 一次录成“画面 + 解说”。
 * 好处：不需要录完再对轨，解说与画面天然同步；也可在录制中实时静音/调音量。 */
async function ensureMicStream() {
  if (state.micStream && state.micStream.getAudioTracks().some(t => t.readyState === 'live')) return state.micStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风采集（需 HTTPS 或 localhost）');
  }
  const s = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  state.micStream = s;
  return s;
}

function closeMic() {
  if (state.micStream) {
    state.micStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    state.micStream = null;
  }
  if (state.audioCtx) {
    try { state.audioCtx.close(); } catch (e) {}
    state.audioCtx = null;
  }
  state.audioMix = null;
}

/* 把麦克风（以及可选的系统/标签页声音）混成一条音轨挂到录制流上。
 * 返回混音后的 MediaStreamAudioDestinationNode，便于录制中实时静音。 */
async function attachAudioToStream(stream, extraTrack) {
  const cfg = state.cfg || {};
  if (!cfg.voice && !extraTrack) return null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('浏览器不支持 WebAudio');
    const ctx = state.audioCtx || new AC();
    state.audioCtx = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    const dest = ctx.createMediaStreamDestination();
    const mix = { ctx, dest, gain: null, sysGain: null };
    if (cfg.voice) {
      const mic = await ensureMicStream();
      const src = ctx.createMediaStreamSource(mic);
      const g = ctx.createGain();
      g.gain.value = (cfg.voiceVol != null ? cfg.voiceVol : 1);
      src.connect(g).connect(dest);
      mix.gain = g;
      /* 防止解说爆音：串一个压限器 */
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4;
        g.disconnect(); g.connect(comp).connect(dest);
        mix.comp = comp;
      } catch (e) {}
    }
    if (extraTrack) {
      const sysSrc = ctx.createMediaStreamSource(new MediaStream([extraTrack]));
      const g2 = ctx.createGain();
      g2.gain.value = (cfg.sysVol != null ? cfg.sysVol : 0.8);
      sysSrc.connect(g2).connect(dest);
      mix.sysGain = g2;
    }
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    state.audioMix = mix;
    return dest.stream;
  } catch (e) {
    setStatus('?? 麦克风不可用，本次只录画面：' + (e.message || e), 'warn');
    return null;
  }
}

/* 录制中的音量表 + 一键静音：让用户确认解说真的录进去了 */
function startAudioMeter() {
  const bar = $('micLevel');
  const btn = $('btnMicMute');
  if (btn && !btn.__bound) {
    btn.__bound = true;
    btn.addEventListener('click', () => {
      const m = state.audioMix;
      if (!m || !m.gain) return;
      m.muted = !m.muted;
      m.gain.gain.value = m.muted ? 0 : (state.cfg.voiceVol != null ? state.cfg.voiceVol : 1);
      btn.textContent = m.muted ? '解说已静音' : '静音解说';
      btn.classList.toggle('muted', !!m.muted);
    });
  }
  const m = state.audioMix;
  if (!bar || !m || !m.ctx) return;
  if (state.meterRAF) cancelAnimationFrame(state.meterRAF);
  let an = null, data = null;
  try {
    an = m.ctx.createAnalyser();
    an.fftSize = 512;
    if (m.gain) m.gain.connect(an);
    data = new Uint8Array(an.frequencyBinCount);
  } catch (e) { return; }
  const tick = () => {
    if (!state.recording) { bar.style.width = '0%'; return; }
    an.getByteFrequencyData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i];
    const v = Math.min(1, (s / data.length) / 90);
    bar.style.width = (v * 100).toFixed(0) + '%';
    state.meterRAF = requestAnimationFrame(tick);
  };
  tick();
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

  const cfg = state.cfg || readCfg();
  const fps = Math.max(24, cfg.fps || 30);
  const withAudio = !!(cfg.sysAudio || cfg.voice);

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
  setStartDisabled(true);
  $('btnStop').disabled = false;
  $('btnDownload').disabled = true;
  setProgress(0, '');

  attachPreview(stream);
  /* 解说同步：麦克风 +（可选）页面声音混成一条音轨，随画面一起录进同一个文件 */
  const sysTrack = withAudio ? stream.getAudioTracks()[0] : null;
  await attachAudioToStream(stream, sysTrack);
  if (state.audioMix) startAudioMeter();
  state.demoSysAudio = !!sysTrack;
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
    state.demoWarn = '? 你选的是“整个屏幕”，成片会包含桌面与其它窗口。想要干净的全屏网页画面，请停止后重来，在弹窗里改选那个标签页 / Chrome 标签页。';
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
    const elapsed = (performance.now() - state.demoStart) / 1000;
    const durTxt = (cfg.durMode === 'fixed' && cfg.fixedSec > 0)
      ? ` / 设定 ${cfg.fixedSec}s`
      : '';
    setStatus(`演示录制中 ${Math.round(elapsed)}s${durTxt}：在新标签页全屏操作，结束后回到本页点“停止”。`
      + (cfg.voice ? '\n?? 解说已开启，说话即可同步录进视频；录制中可点“静音解说”。' : '')
      + (state.demoWarn ? '\n' + state.demoWarn : ''), state.demoWarn ? 'warn' : 'ok');
    /* 设定时长到点自动停止：不再靠用户手动掐点，成片长度才可控 */
    if (cfg.durMode === 'fixed' && cfg.fixedSec > 0 && elapsed >= cfg.fixedSec) {
      setStatus(`已到设定时长 ${cfg.fixedSec}s，自动停止录制。`, 'ok');
      stopRecording();
    }
  }, 250);
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
  /* 参数在“开始”这一刻冻结成快照；之后面板再怎么调都不会影响本次任务 */
  state.cfg = readCfg();
  const cfg = state.cfg;

  /* 演示录制必须在用户点击的同一任务里发起（getDisplayMedia 需要用户手势），
     所以放在任何 await 之前，第一时间打开标签页并申请捕获。 */
  if (cfg.mode === 'demo') {
    await startDemoRecording();
    return;
  }

  setStartDisabled(true);
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
    await waitHidden(cfg.waitHidden);
    if (cfg.injectJs) {
      await evaluate(cfg.injectJs);
    }
    /* 点“播放启动动作”之前先扫一眼：若页面被一层铺满视口的“点击开始”遮罩挡住，
       自动把它的选择器填进启动动作，否则 canvas 直录会拿到 0 字节 / 全黑成片。 */
    if (!cfg.clickSel) {
      const ovPre = findStartOverlay(frame.win, frame.doc, frame.W, frame.H);
      if (ovPre && ovPre.sel) {
        cfg.clickSel = ovPre.sel;
        $('optClickSel').value = ovPre.sel;
        console.info('[auto-click] 检测到开始遮罩', ovPre);
      }
    }
    await clickSel(cfg.clickSel);
    await sleep(cfg.delay);

    const mode = cfg.mode;
    const fps = cfg.fps;
    const durMode = cfg.durMode;
    const fixedSec = cfg.fixedSec;
    const stopJs = cfg.stopJs;
    const scrollSpeed = cfg.scrollSpeed;

    setStatus('开始录制…');

    const engine = cfg.engine;
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
      if (bigCanvas && canvasRatio >= 0.7) {
        /* 直录只看 canvas 像素：只要上面压着可见的标题/字幕/按钮，就会把这些文字丢掉。
           以前用“文字总长度 > 40”判断，短标题（类视频播放页的片名、字幕）判不出来，
           成片就是“有画面没文字”。这里改成按覆盖面积占比判断。 */
        const ovRatio = canvasOverlayRatio(frame.doc, bigCanvas);
        if (ovRatio < 0.02) {
          modeReal = 'canvas';
        } else {
          modeReal = 'dom';
          hint = (hint ? hint + '\n' : '')
            + `canvas 上叠着文字/控件（约占画面 ${Math.round(ovRatio * 100)}%），已改用视口逐帧合成，`
            + '保证画面和文字都在成片里。';
        }
      } else if (anyCanvas && canvasRatio >= 0.12) modeReal = 'dom';
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
    setStartDisabled(false);
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
    setStartDisabled(false);
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
    $('fileBox').hidden = true; setStartDisabled(true);
    setStatus('等待上传 HTML…');
  });
  $('btnStart').addEventListener('click', start);
  if ($('btnStart2')) $('btnStart2').addEventListener('click', start);
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
  if ($('optVoiceFile')) {
    $('optVoiceFile').addEventListener('change', (e) => {
      state.voiceFile = e.target.files[0] || null;
      const h = $('voiceFileHint');
      if (h) h.textContent = state.voiceFile
        ? `已选配音：${state.voiceFile.name}（成片时与原声、音乐混合）`
        : '可上传 mp3 / m4a / wav 解说音轨，成片时与原声、音乐混合';
    });
  }
  if ($('optVoice')) {
    /* 勾选即刻申请麦克风：趁用户手势在手，录制时就不会因为权限弹窗吃掉第一句话 */
    $('optVoice').addEventListener('change', async (e) => {
      if (e.target.checked) {
        try {
          await ensureMicStream();
          const b = $('btnMicMute');
          if (b) b.disabled = false;
        } catch (err) {
          e.target.checked = false;
          setStatus('麦克风不可用：' + (err.message || err) + '（需要 HTTPS 或 localhost，且允许麦克风权限）', 'warn');
        }
      }
    });
  }
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
    /* 麦克风解说只在演示录制时有效；导入配音 / 原声 / 音乐在任何模式都参与成片混音 */
    if ($('optVoice')) {
      $('optVoice').disabled = !demo;
      const row = $('optVoice').closest('.row');
      if (row) row.style.opacity = demo ? '1' : '0.45';
    }
    if ($('btnMicMute')) $('btnMicMute').disabled = !demo || !$('optVoice').checked;
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
    setStartDisabled(false);
  } catch (e) {
    setStatus('解析失败: ' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', initEvents);
