// Drive the Watch desktop frontend (Vite preview, ?demo=1) through headless Chrome via CDP and capture PNGs.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.OUT_DIR || '/tmp/watch-demo/shots';
const PORT = 9333;
// 固定画布：六张素材尺寸必须一致，否则 README 三列网格里同一行的图片对不齐。
// 只拍视口（不拍整页）：应用是 min-height:100vh + .page-content{flex:1} 布局，
// 页脚会被拉到画布底部，短页面不会留空带；长于画布时下方会被裁切并告警。
const VIEW = { width: 1280, height: 1120 };
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/watch-demo/chrome-profile`, `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const click = async (text, selector = 'button') => evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent && x.innerText.trim().startsWith(${JSON.stringify(text)})); if (!b) return 'missing: ' + ${JSON.stringify(text)}; b.click(); return 'clicked ' + ${JSON.stringify(text)}; })()`);
const shot = async (name) => {
  await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const content = await evalJs('document.documentElement.scrollHeight');
  if (content > VIEW.height + 1) console.warn(`[warn] ${name} 内容 ${content}px 超出画布 ${VIEW.height}px，底部会被裁切`);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name, `${VIEW.width * 2}x${VIEW.height * 2}`, `content=${content}`);
};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });
// 主题确定性：素材不应随宿主机外观变化。先写死亮色再正式载入，01-05 固定为亮色。
await send('Page.navigate', { url: 'http://localhost:1420/?demo=1' }); await sleep(1500);
await evalJs(`localStorage.setItem('watch-theme','light')`);
await send('Page.navigate', { url: 'http://localhost:1420/?demo=1' });
await sleep(2500);
console.log('theme:', await evalJs('document.documentElement.dataset.theme'));
console.log('title:', await evalJs('document.title'), '| h1/h2:', await evalJs('[...document.querySelectorAll("h1,h2")].map(h=>h.innerText).slice(0,6).join(" | ")'));
console.log(await click('载入演示')); await sleep(1200);
await shot('desktop-01-source');
console.log(await click('预览导入计划')); await sleep(1500);
await shot('desktop-02-preview');
console.log('buttons:', await evalJs('[...document.querySelectorAll("button")].filter(b=>b.offsetParent).map(b=>b.innerText.trim()).filter(Boolean).join(" / ")'));
console.log(await click("模拟确认导入")); await sleep(1500);
await shot('desktop-03-imported');
console.log(await click('接力记录')); await sleep(1000);
await shot('desktop-04-history');
console.log(await click('支持路径')); await sleep(1000);
await shot('desktop-05-compat');
// 暗色外观：先写入主题偏好再重新载入演示（App 从 localStorage 读 watch-theme 并写 <html data-theme>）
await evalJs(`localStorage.setItem('watch-theme','dark')`);
await send('Page.navigate', { url: 'http://localhost:1420/?demo=1' });
await sleep(2500);
console.log(await click('载入演示')); await sleep(1200);
console.log('theme:', await evalJs('document.documentElement.dataset.theme'));
await shot('desktop-06-dark');
await evalJs(`localStorage.removeItem('watch-theme')`);
ws.close(); chrome.kill();
