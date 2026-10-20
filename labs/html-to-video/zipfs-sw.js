/* HTML-to-Video Studio - Virtual File System Service Worker
 * 将用户上传的 ZIP/多文件注册为同源虚拟目录（/__vfs__/*），
 * 使 iframe 内页面可加载相对资源且 canvas 不跨域污染。
 */
'use strict';

const VFS_PREFIX = '/__vfs__/';
let vfs = null;          // { "/index.html": Blob, ... } 键为 /开头的小写路径

self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'VFS_SET') {
    vfs = ev.data.files || {};
    ev.ports && ev.ports[0] && ev.ports[0].postMessage({ ok: true, count: Object.keys(vfs).length });
  } else if (ev.data && ev.data.type === 'VFS_CLEAR') {
    vfs = null;
    ev.ports && ev.ports[0] && ev.ports[0].postMessage({ ok: true });
  }
});

self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const idx = url.pathname.indexOf('/__vfs__/');
  if (idx === -1) return;
  e.respondWith((async () => {
    if (!vfs) return new Response('VFS not ready', { status: 503 });
    let p = url.pathname.slice(idx + '/__vfs__'.length); // "/index.html"
    try { p = decodeURIComponent(p); } catch (_) {}
    let entry = vfs[p];
    if (!entry) {
      // 大小写不敏感兜底
      const key = Object.keys(vfs).find(k => k.toLowerCase() === p.toLowerCase());
      if (key) entry = vfs[key];
    }
    if (!entry) return new Response('Not found: ' + p, { status: 404 });
    const type = entry.type || guessType(p);
    /* 对 HTML 注入采集补丁：
     * 1) WebGL 上下文强制 preserveDrawingBuffer=true —— 否则在 rAF 之外读取像素会得到空白，
     *    表现为“动画/游戏画面偶尔整块漆黑”（某些帧有、某些帧没有）。
     * 2) 暴露 window.__MCV 供外部在补绘前主动推进一帧。 */
    if (/text\/html/i.test(type)) {
      try {
        const txt = await entry.text();
        return new Response(injectPatch(txt), { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
      } catch (err) { /* 退化：原样返回 */ }
    }
    return new Response(entry, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  })());
});

const PATCH = `<script>(function(){
  try {
    var P = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, opts){
      try {
        if (typeof type === 'string' && type.indexOf('webgl') === 0) {
          opts = Object.assign({}, opts || {});
          if (opts.preserveDrawingBuffer !== true) opts.preserveDrawingBuffer = true;
          opts.premultipliedAlpha = false;
        }
      } catch (e) {}
      return P.call(this, type, opts);
    };
    window.__MCV = { patched: true, input: 0 };
    /* 统计页面注册的键鼠 / 触摸监听：游戏类页面通常一上来就监听键盘与指针，
     * 逐帧引擎无法产生真实输入，可据此主动提示改用「演示录制」。 */
    try {
      var AEL = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (t, fn, o) {
        try {
          if (typeof t === 'string' && /^(key|pointer|mouse|touch|click)/i.test(t)) window.__MCV.input++;
        } catch (e) {}
        return AEL.call(this, t, fn, o);
      };
    } catch (e) {}
  } catch (e) {}
  /* 演示录制专用：带 __mcv=demo 打开时，给一个“一键全屏”遮罩。
   * 浏览器不允许脚本自动全屏，但用户点一下这个按钮就是合法手势，
   * 切到全屏后录出来的画面不带地址栏/书签栏/任务栏。 */
  try {
    if (location.search.indexOf('__mcv') !== -1) {
      document.addEventListener('DOMContentLoaded', function(){
        var wrap = document.createElement('div');
        wrap.setAttribute('style','position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(8,10,20,.92);font:16px/1.7 system-ui,sans-serif;color:#fff;text-align:center');
        wrap.innerHTML = '<div style="padding:0 24px">'
          + '<div style="font-size:24px;font-weight:700;margin-bottom:10px">进入全屏演示</div>'
          + '<div style="opacity:.78;margin-bottom:20px;max-width:460px">点下面的按钮把页面切到全屏，录下来的画面就只剩内容本身，没有浏览器地址栏和任务栏。按 Esc 可随时退出。</div>'
          + '<button id="__mcv_fs" style="font:inherit;font-weight:600;padding:12px 28px;border:0;border-radius:999px;background:#4f7cff;color:#fff;cursor:pointer">点击进入全屏</button>'
          + '</div>';
        (document.body || document.documentElement).appendChild(wrap);
        var btn = wrap.querySelector('#__mcv_fs');
        btn && btn.addEventListener('click', function(){
          var el = document.documentElement;
          try {
            var p = el.requestFullscreen && el.requestFullscreen();
            if (p && p.then) p.then(function(){ wrap.remove(); }).catch(function(){ wrap.remove(); });
            else setTimeout(function(){ wrap.remove(); }, 200);
          } catch (e) { wrap.remove(); }
        });
      });

      /* 常驻“结束录制”胶囊：直接在本标签页点结束，避免录到“切回 Studio 点停止”
       * 那段别的窗口画面（以前成片尾部会闪一下 Studio 界面）。 */
      document.addEventListener('DOMContentLoaded', function(){
        var stop = document.createElement('button');
        stop.id = '__mcv_stop';
        stop.textContent = '结束录制 · 生成视频';
        stop.setAttribute('style','position:fixed;right:16px;bottom:16px;z-index:2147483647;'
          + 'font:600 13px/1 system-ui,sans-serif;padding:10px 16px;border:1px solid rgba(255,255,255,.35);'
          + 'border-radius:999px;background:rgba(12,16,28,.72);color:#fff;cursor:pointer;opacity:.45;'
          + 'backdrop-filter:blur(6px);transition:opacity .15s');
        stop.addEventListener('mouseenter', function(){ stop.style.opacity = '1'; });
        stop.addEventListener('mouseleave', function(){ stop.style.opacity = '.45'; });
        stop.addEventListener('click', function(){
          stop.textContent = '正在结束…';
          stop.disabled = true;
          var go = function(){
            try {
              if (window.opener && !window.opener.closed && window.opener.__MCV_stopDemo) {
                window.opener.__MCV_stopDemo();
              } else {
                window.postMessage({ __mcv: 'stop-demo' }, '*');
              }
            } catch (e) {}
          };
          /* 先通知 Studio 停止采集，再退出全屏：顺序反了会把“退出全屏 + 切窗口”
             那几帧录进成片尾部。 */
          go();
          if (document.fullscreenElement && document.exitFullscreen) {
            setTimeout(function(){ try { document.exitFullscreen(); } catch (e) {} }, 260);
          }
        });
        (document.body || document.documentElement).appendChild(stop);
      });
    }
  } catch (e) {}
})();<\/script>`;

function injectPatch(html) {
  if (html.indexOf('__MCV') !== -1) return html;
  const m = html.match(/<head[^>]*>/i);
  if (m) {
    const i = html.indexOf(m[0]) + m[0].length;
    return html.slice(0, i) + PATCH + html.slice(i);
  }
  const h = html.match(/<html[^>]*>/i);
  if (h) {
    const i = html.indexOf(h[0]) + h[0].length;
    return html.slice(0, i) + PATCH + html.slice(i);
  }
  return PATCH + html;
}

function guessType(p) {
  const ext = p.split('.').pop().toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
    txt: 'text/plain', md: 'text/markdown', xml: 'text/xml', pdf: 'application/pdf',
    zip: 'application/zip', map: 'application/json'
  };
  return map[ext] || 'application/octet-stream';
}
