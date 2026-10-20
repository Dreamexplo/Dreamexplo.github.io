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
const frame = { iframe: null, win: null, doc: null, outCanvas: null, outCtx: null, W: 0, H: 0 };

function buildIframe() {
  if (frame.iframe) { frame.iframe.remove(); }
  const [W, H] = currentSize();
  const ifr = document.createElement('iframe');
  ifr.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;border:0;background:#000;`;
  ifr.setAttribute('allow', 'autoplay; fullscreen');
  document.body.appendChild(ifr);
  frame.iframe = ifr;
}

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

function pickCanvas() {
  const canvases = frame.doc.querySelectorAll('canvas');
  for (const c of canvases) {
    const w = c.width || c.clientWidth, h = c.height || c.clientHeight;
    if (w >= frame.W * 0.5 && h >= frame.H * 0.5) return c;
  }
  return canvases[0] || null;
}

function makeRecorder(stream, preferredMime) {
  // 优先 H.264 + MP4（兼容性最好），不支持时退回 WebM
  const candidates = [
    preferredMime,
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ].filter(Boolean);
  let mime = null;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) { mime = c; break; }
  }
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstart = () => { state.rawMime = rec.mimeType || mime || ''; };
  rec.onstop = () => {
    state.rawMime = rec.mimeType || mime || '';
    state.rawBlob = new Blob(chunks, { type: state.rawMime || 'video/webm' });
  };
  rec.start(500);
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
  let scrollY = win.scrollY || 0;
  const totalScroll = Math.max(0, doc.documentElement.scrollHeight - vh);
  const fpsInt = Math.max(1, Math.round(fps));
  const stopScroll = mode === 'scroll';
  const timed = stopScroll && opts.durMode === 'fixed' && opts.fixedSec > 0;
  const fixedSec = opts.fixedSec || 0;
  const t0 = performance.now();
  let step = 0;

  const loop = async () => {
    if (!state.recording) return;
    try {
      const target = doc.documentElement || doc.body;
      const canvas = await html2canvas(target, {
        scale: Math.min(1, 1280 / vw),
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#000',
        windowWidth: vw,
        windowHeight: vh,
        x: stopScroll ? (win.scrollX || 0) : 0,
        y: stopScroll ? scrollY : 0,
        logging: false,
      });
      frame.outCtx.fillStyle = '#000';
      frame.outCtx.fillRect(0, 0, vw, vh);
      frame.outCtx.drawImage(canvas, 0, 0, vw, vh);
      if (opts.onFrame) opts.onFrame(step);
      step++;
      if (stopScroll) {
        if (timed) {
          // 固定时长：按时间轴匀速滚动，保证成片时长等于设定值
          const elapsed = (performance.now() - t0) / 1000;
          scrollY = Math.min(totalScroll, totalScroll * Math.min(1, elapsed / fixedSec));
        } else {
          if (scrollY >= totalScroll - 1) { stopRecording(); return; }
          scrollY = Math.min(totalScroll, scrollY + Math.max(1, Math.round(vh * 0.85)));
        }
        win.scrollTo(0, scrollY);
      }
    } catch (err) {
      stopRecording();
      setStatus('逐帧渲染错误: ' + err.message, 'err');
      console.error('[frame render]', err);
      return;
    }
    setTimeout(loop, Math.max(40, 1000 / fpsInt));
  };
  loop();
  return () => {};
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
  setStatus('加载 ffmpeg.wasm（首次较慢）…');
  const { createFFmpeg } = FFmpeg;
  const ffmpeg = createFFmpeg({
    corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/umd/ffmpeg-core.js',
    log: false,
  });
  await ffmpeg.load();
  state.ffmpeg = ffmpeg;
  return ffmpeg;
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

  // 需要 ffmpeg 的情形：要 MP4 但不是原生 H.264、或要变速、或要混音
  const needFfmpeg = (wantFmt === 'mp4' && !rawIsH264Mp4) || speed !== 1 || !!music;

  if (!needFfmpeg) {
    state.resultBlob = state.rawBlob;
    finish(rawIsMp4 ? 'mp4' : 'webm');
    return;
  }

  const ffmpeg = await getFFmpeg();
  const inExt = rawIsMp4 ? 'mp4' : 'webm';
  ffmpeg.FS.writeFile('input.' + inExt, new Uint8Array(await state.rawBlob.arrayBuffer()));
  const args = ['-y', '-i', 'input.' + inExt];
  if (music) {
    ffmpeg.FS.writeFile('bgm' + extOf(music.name), new Uint8Array(await music.arrayBuffer()));
    args.push('-i', 'bgm' + extOf(music.name));
  }
  const vf = speed !== 1 ? `setpts=${(1 / speed).toFixed(4)}*PTS` : null;
  const af = speed !== 1 ? `atempo=${Math.min(4, speed).toFixed(4)}` : null;

  const filterParts = [];
  const mapArgs = ['-map', '0:v:0'];
  if (music) {
    const vol = (parseFloat($('optMusicVol').value) / 100).toFixed(2);
    const dur = await probeDuration() || 30;
    const musicChain = `[1:a]volume=${vol},aloop=loop=-1:size=2e9,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS`;
    filterParts.push(`[1:a]${musicChain}[a0]`);
    mapArgs.push('-map', '[a0]');
  } else if (af) {
    filterParts.push(`[0:a]${af}[a0]`);
    mapArgs.push('-map', '[a0]');
  }
  if (vf) {
    const vidLabel = '[v0]';
    const src = filterParts.length ? '[0:v:0]' : '0:v:0';
    filterParts.push(`[${src}]${vf}${vidLabel}`);
    args.push('-filter_complex', filterParts.join(';'), '-map', '[v0]');
  } else if (filterParts.length) {
    args.push('-filter_complex', filterParts.join(';'));
  }
  args.push(...mapArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (music || af) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('output.mp4');

  try {
    setProgress(0.5, '转码中（ffmpeg.wasm 单线程较慢，请耐心等待）…');
    await ffmpeg.run(...args);
    setProgress(0.9, '封装输出…');
    const data = ffmpeg.FS.readFile('output.mp4');
    state.resultBlob = new Blob([data.buffer], { type: 'video/mp4' });
    finish('mp4');
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

async function probeDuration() {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(v.duration || 30);
    v.onerror = () => resolve(30);
    v.src = URL.createObjectURL(state.rawBlob);
  });
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

    setStatus('开始录制…');

    let modeReal = mode;
    if (modeReal === 'auto') {
      const hasCanvas = !!pickCanvas();
      const scrollable = (frame.doc.documentElement.scrollHeight > frame.H + 4);
      modeReal = hasCanvas ? 'live' : (scrollable ? 'scroll' : 'live');
      setStatus(`自动判定：${modeReal === 'live' ? (hasCanvas ? '动画(canvas 实时)' : '动画(逐帧)') : '滚动'} 模式`);
    }

    if (modeReal === 'live') {
      // 优先 canvas captureStream；无 canvas 降级逐帧
      if (pickCanvas()) {
        await startLiveCanvas(fps);
      } else {
        await startDomFrame(fps, 'live', { durMode, fixedSec });
      }
    } else {
      await startDomFrame(fps, 'scroll', { durMode, fixedSec });
    }

    // 停止条件
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
    if (durMode === 'auto' && !stopJs && modeReal === 'live') {
      setStatus('自动模式（动画）需要停止表达式或手动停止，已切换为手动停止。', 'warn');
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
  // 等 recorder onstop 落盘
  await sleep(200);
  try {
    await postProcess();
  } catch (e) {
    setStatus('处理失败: ' + e.message, 'err');
  }
  $('btnStart').disabled = false;
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
