# HTML to Video Studio

纯前端 HTML → 视频 Web 应用。部署于 GitHub Pages，用户上传 HTML/ZIP、在面板配置参数、生成并下载视频交付物。所有渲染与转码都在访客浏览器本地完成，文件不上传服务器。

## 在线地址

https://dreamexplo.github.io/labs/html-to-video/

## 功能

- 上传：单个 `.html` 文件，或含资源目录的 `.zip`（自动解析 `index.html`，保留相对路径资源）
- 录制模式：
  - 动画/实时（`live`）：页面有 canvas（WebGL/2D 动画）→ `canvas.captureStream` 高质量录制；纯 DOM 动画 → html2canvas 逐帧
  - 滚动（`scroll`）：整页滚动逐帧录制
  - 自动检测
- 面板设置：分辨率（720p/1080p）、帧率、滚动速度、时长（固定秒数/滚动到底/停止表达式/手动停止）、播放启动动作（点击选择器）、等待加载层隐藏、注入 JS、背景音乐混音、变速、输出格式（MP4/WebM）
- 转码：优先浏览器原生 MP4 录制；需要混音/变速时自动调用 ffmpeg.wasm（单线程，慢但可用）
- 预览：录制过程实时预览输出画面

## 实现原理

```
上传文件 → fflate 解压 ZIP → Service Worker 注册同源虚拟目录(/__vfs__/)
→ iframe 加载用户页面（同源，canvas 不污染）
→ 自动播放动作/注入 → 录制引擎
   ├─ canvas.captureStream(fps)          （WebGL/2D 动画页）
   └─ html2canvas 逐帧 → 输出 canvas     （DOM 动画 / 滚动页）
→ MediaRecorder → webm/mp4
→ ffmpeg.wasm → MP4 封装 / 变速 / 混音
→ Blob 下载
```

## 本地开发

```bash
cd labs/html-to-video
python -m http.server 8800    # 或任意静态服务器
# 打开 http://localhost:8800/
```

注意：Service Worker 需要 `https` 或 `localhost` 环境。第三方库已本地 vendor 化（`vendor/`），运行时不需要外网 CDN。

## 文件结构

```
index.html            面板 UI
css/style.css         样式
js/app.js             主逻辑（文件解析/录制/转码/下载）
zipfs-sw.js           Service Worker 虚拟文件系统
examples/anim.html    演示用 rAF canvas 动画页（30s）
examples/long.html    演示用长页面（滚动模式）
vendor/               html2canvas / fflate / ffmpeg.wasm（本地自持，免 CDN）
```

## 输出编码

- 优先请求原生 `video/mp4;codecs=avc1`（H.264），浏览器支持时直出，几乎零等待
- 浏览器只给 VP9-in-MP4 或 WebM 时，选 MP4 会走 ffmpeg.wasm 转 H.264（`yuv420p`，兼容 QuickTime/剪映等）
- 转码失败且已有可播放 MP4，会以原始编码兜底并提示

## 限制

- 录制的是页面在浏览器中的表现：无头无法捕获页面内音频（与桌面版工具一致），需要配乐请上传背景音乐
- ffmpeg.wasm 单线程转码较慢，长视频建议选 WebM 输出或调低分辨率/帧率
- 用户页面引用的跨域图片若不允许 CORS，会污染 canvas，导致录制黑帧；建议上传内联/同源资源
- 部分页面依赖真实时间/网络接口，录制结果以其在浏览器中的实际表现为准

## 版本

v1.0（2026-10-20）：首个静态部署版，与桌面工具 `html_video_trans` 功能对齐的子集。
