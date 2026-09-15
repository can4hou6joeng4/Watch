// Replay a real CLI transcript in a browser "terminal" and capture frames → GIF via ffmpeg.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const transcript = JSON.parse(readFileSync('/tmp/watch-demo/transcript.json', 'utf8'));
const FRAMES = '/tmp/watch-demo/frames'; rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true });
const OUT = process.env.OUT || '/tmp/watch-demo/cli-demo.gif';
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// timeline: [{t, html}] cumulative
const TYPE = 38, FPS = 12; let t = 0; const events = []; let html = '';
const push = (ms, add) => { t += ms; html += add; events.push({ t, html }); };
push(0, `<div class="c">$ <span class="dim"># Watch · 值更 — Claude Code → OpenCode 会话接力（隔离环境 · 合成会话 · 真实输出回放）</span></div>`);
push(1400, '');
for (const step of transcript) {
  let typed = '';
  html += '<div class="c">$ <span class="cmd"></span></div>';
  for (const ch of step.label) { typed += ch; html = html.replace(/<span class="cmd">[^<]*<\/span><\/div>$/, `<span class="cmd">${esc(typed)}</span></div>`); push(TYPE, ''); }
  push(Math.min(900, step.ms + 250), `<pre>${esc(step.stdout.replace(/\s+$/, ''))}</pre>`);
  push(2200, '');
}
push(2500, '');
const page = (state) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0b0c0e;color:#e6e6ea;font:15px/1.5 "IBM Plex Mono","SFMono-Regular",Menlo,monospace;width:960px;height:600px;overflow:hidden}
.bar{height:36px;background:#16171f;border-bottom:1px solid #2a2b33;display:flex;align-items:center;gap:8px;padding:0 14px;font-size:12px;color:#9ba1b0}
.bar i{width:12px;height:12px;border-radius:50%;display:inline-block}.term{padding:14px 18px;white-space:pre-wrap;word-break:break-all}
.c{color:#e6e6ea}.cmd{color:#fff;font-weight:600}.dim{color:#8b8d95}pre{margin:2px 0 8px;font:inherit;color:#b9c3bd;white-space:pre-wrap}
</style><div class="bar"><i style="background:#ff5f56"></i><i style="background:#ffbd2e"></i><i style="background:#27c93f"></i><span style="margin-left:8px">watch — zsh — example-api</span></div><div class="term">${state}</div>`;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--remote-debugging-port=9334', '--user-data-dir=/tmp/watch-demo/chrome-profile2', '--window-size=960,600', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); await sleep(1500);
const targets = await (await fetch('http://127.0.0.1:9334/json')).json(); const ws = new WebSocket(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r)); let seq = 0; const pending = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 600, deviceScaleFactor: 2, mobile: false });
const total = events[events.length - 1].t; let frame = 0; let last = null;
for (let now = 0; now <= total; now += 1000 / FPS) {
  let state = events[0].html; for (const e of events) if (e.t <= now) state = e.html;
  if (state !== last) { await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(state)) }); await sleep(60); await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight); document.querySelector(".term").scrollIntoView(false)' }); last = state; }
  const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${FRAMES}/f${String(frame++).padStart(4, '0')}.png`, Buffer.from(r.result.data, 'base64'));
}
ws.close(); chrome.kill();
console.log('frames', frame, 'duration', (total / 1000).toFixed(1) + 's');
const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-vf', 'scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', OUT], { encoding: 'utf8' });
console.log('ffmpeg', ff.status, ff.stderr);
