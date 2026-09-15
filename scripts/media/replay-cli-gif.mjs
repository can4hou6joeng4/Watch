// Replay the tracked CLI transcript in a browser "terminal" and capture frames → GIF via ffmpeg.
// 画布与 App 截图一致（1280×1120 @2x），并使用 App 的亮色令牌，使整套素材风格统一。
// 输入是仓库内的 assets/cli-transcript.json（由隔离环境下运行 run-demo-cli.sh 中的四条命令录制）。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TRANSCRIPT = process.env.TRANSCRIPT || path.join(root, 'assets', 'cli-transcript.json');
const VIEW = { width: 1280, height: 1120 };
const FRAMES = process.env.FRAMES || '/tmp/watch-demo/frames';
const OUT = process.env.OUT || '/tmp/watch-demo/cli-demo.gif';

const transcript = JSON.parse(readFileSync(TRANSCRIPT, 'utf8'));
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// timeline: [{t, html}] cumulative
const TYPE = 38;
const FPS = 12;
let t = 0;
const events = [];
let html = '';
const push = (ms, add) => { t += ms; html += add; events.push({ t, html }); };

push(0, '<div class="c">$ <span class="dim"># Watch · 值更 — Claude Code → OpenCode 会话接力（隔离环境 · 合成会话 · 真实输出回放）</span></div>');
push(1400, '');
for (const step of transcript) {
  let typed = '';
  html += '<div class="c">$ <span class="cmd"></span></div>';
  for (const ch of step.label) {
    typed += ch;
    html = html.replace(/<span class="cmd">[^<]*<\/span><\/div>$/, `<span class="cmd">${esc(typed)}</span></div>`);
    push(TYPE, '');
  }
  push(Math.min(900, step.ms + 250), `<pre>${esc(step.stdout.replace(/\s+$/, ''))}</pre>`);
  push(2200, '');
}
push(2500, '');

// 亮色终端：配色取自 desktop/src/App.css 的 :root 令牌
const page = (state) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f6f7f8;color:#24282b;font:16px/1.6 "IBM Plex Mono","SFMono-Regular",Menlo,monospace;width:${VIEW.width}px;height:${VIEW.height}px;overflow:hidden}
.bar{height:44px;background:#ffffff;border-bottom:1px solid #e3e6e8;display:flex;align-items:center;gap:9px;padding:0 18px;font-size:13px;color:#8a9297}
.bar i{width:12px;height:12px;border-radius:50%;display:inline-block}
.term{padding:22px 26px;white-space:pre-wrap;word-break:break-all}
.c{color:#24282b}.cmd{color:#16694f;font-weight:600}.dim{color:#8a9297}pre{margin:3px 0 10px;font:inherit;color:#565f64;white-space:pre-wrap}
</style><div class="bar"><i style="background:#ff5f56"></i><i style="background:#ffbd2e"></i><i style="background:#27c93f"></i><span style="margin-left:9px">watch — zsh — example-api</span></div><div class="term">${state}</div>`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--remote-debugging-port=9334', '--user-data-dir=/tmp/watch-demo/chrome-profile2', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
const targets = await (await fetch('http://127.0.0.1:9334/json')).json();
const ws = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: false });

const total = events[events.length - 1].t;
let frame = 0;
let last = null;
for (let now = 0; now <= total; now += 1000 / FPS) {
  let state = events[0].html;
  for (const e of events) if (e.t <= now) state = e.html;
  if (state !== last) {
    await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(state)) });
    await sleep(60);
    await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight); document.querySelector(".term").scrollIntoView(false)' });
    last = state;
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${FRAMES}/f${String(frame++).padStart(4, '0')}.png`, Buffer.from(r.result.data, 'base64'));
}
ws.close();
chrome.kill();
console.log('frames', frame, 'duration', (total / 1000).toFixed(1) + 's', 'canvas', `${VIEW.width}x${VIEW.height}`);

const ff = spawnSync('ffmpeg', [
  '-y', '-v', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`,
  '-vf', `scale=${VIEW.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
  OUT,
], { encoding: 'utf8' });
console.log('ffmpeg', ff.status, ff.stderr);
console.log('out', OUT);
