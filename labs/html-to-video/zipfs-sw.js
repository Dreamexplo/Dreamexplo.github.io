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
    return new Response(entry, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  })());
});

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
