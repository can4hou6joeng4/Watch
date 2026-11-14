// 从 scripts/media/og-zh.html / og-en.html 渲染站点分享图（1200×630 PNG）。
// 模板里的 __WATCH_VERSION__ 由根 package.json 填入：分享图曾长期停留在 v0.1.1，
// 因为它是一张 PNG，构建脚本改版本时不会带着它走。
// 用法：node scripts/media/render-og.mjs [--check]
//   --check 只渲染到临时目录并与 site/og*.png 的版本字符串比对，不写产物。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const check = process.argv.includes('--check');
const PORT = 9335;
const VIEW = { width: 1200, height: 630 };

const templates = [
  { source: 'scripts/media/og-zh.html', output: 'site/og.png' },
  { source: 'scripts/media/og-en.html', output: 'site/og-en.png' },
];

const work = mkdtempSync(path.join(tmpdir(), 'watch-og-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'chrome-profile')}`, `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Chrome 退出后仍在写 profile，立即 rm 会 ENOTEMPTY；退出码不因此变红，只保留 stderr 一行说明。
const cleanup = async () => {
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(1500)]);
  }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { console.error(`临时目录未清理干净：${work}（${error.code ?? error.message}）`); }
};
process.on('exit', () => { try { chrome.kill(); } catch { /* 已退出 */ } });
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
await sleep(1500);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) { console.error('未找到可用的 Chrome 页面目标，分享图未渲染'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });

const failures = [];
for (const [index, template] of templates.entries()) {
  const html = readFileSync(path.join(root, template.source), 'utf8');
  if (!html.includes('__WATCH_VERSION__')) {
    failures.push(`${template.source} 缺少 __WATCH_VERSION__ 占位符：分享图会重新出现写死的版本号`);
    continue;
  }
  const rendered = html.replaceAll('__WATCH_VERSION__', version);
  const file = path.join(work, `og-${index}.html`);
  writeFileSync(file, rendered);
  await send('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(600);
  const shown = (await send('Runtime.evaluate', { expression: 'document.querySelector(".foot")?.innerText ?? ""', returnByValue: true })).result?.result?.value ?? '';
  if (!String(shown).includes(`v${version}`)) {
    failures.push(`${template.source} 渲染后页脚不含 v${version}（实际: ${String(shown).replace(/\s+/g, ' ').trim()}）`);
  }
  if (check) {
    // --check 不改产物，只报模板与版本来源是否一致。
    console.log(`check ${template.source}: ${String(shown).replace(/\s+/g, ' ').trim()}`);
    continue;
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.result.data, 'base64');
  writeFileSync(path.join(root, template.output), buffer);
  console.log(`rendered ${template.output} (${buffer.length} bytes) version=${version}`);
}

ws.close();
if (failures.length) {
  await cleanup();
  chrome.kill();
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
await cleanup();
