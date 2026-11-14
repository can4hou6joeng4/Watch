// 从本地模板渲染 1200×630 分享图；升版后执行，再运行 site:build。
// --check 只核对已生成 PNG 的版本、模板与图片摘要，不启动 Chrome、不写文件。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ogManifestPath, ogTemplates, ogView, sha256, verifyOgImages } from '../lib/site-og.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (process.argv.includes('--check')) {
  verifyOgImages(root, version);
  console.log(`分享图产物校验通过：v${version}，模板与两张 PNG 摘要一致。`);
} else {
  await render();
}

async function render() {
  const work = mkdtempSync(path.join(tmpdir(), 'watch-og-'));
  const profile = path.join(work, 'chrome-profile');
  const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${ogView.width},${ogView.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError;
  chrome.on('error', (error) => { spawnError = error; });
  let ws;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      if (spawnError) throw spawnError;
      if (chrome.exitCode !== null) throw new Error(`Chrome 提前退出：${chrome.exitCode}`);
      try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('等待独立 Chrome 调试端口超时');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10000) })).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('未找到独立 Chrome 页面目标');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome 超时')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('连接 Chrome 失败')); };
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      pending.get(message.id)?.(message);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { ...ogView, deviceScaleFactor: 1, mobile: false });
    const images = [];
    for (const [index, template] of ogTemplates.entries()) {
      const html = readFileSync(path.join(root, template.source), 'utf8');
      if (!html.includes('__WATCH_VERSION__')) throw new Error(`${template.source} 缺少 __WATCH_VERSION__ 占位符`);
      const file = path.join(work, `og-${index}.html`);
      writeFileSync(file, html.replaceAll('__WATCH_VERSION__', version));
      const url = pathToFileURL(file).href;
      await send('Page.navigate', { url });
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) {
        const result = await send('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, returnByValue: true });
        ready = result.result?.result?.value === true;
        if (!ready) await sleep(100);
      }
      if (!ready) throw new Error(`${template.source} 加载超时`);
      const shown = await send('Runtime.evaluate', {
        expression: '(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); return document.querySelector(".foot")?.innerText ?? ""; })()',
        awaitPromise: true, returnByValue: true,
      });
      if (shown.result?.exceptionDetails || !String(shown.result?.result?.value ?? '').includes(`v${version}`)) {
        throw new Error(`${template.source} 页脚版本校验失败，未保存分享图`);
      }
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(shot.result.data, 'base64');
      images.push({ ...template, templateSha256: sha256(html), sha256: sha256(png), png });
    }
    // 两张图都截图成功后再更新产物；中断导致的不一致会被构建校验拒绝。
    for (const image of images) {
      writeFileSync(path.join(root, image.output), image.png);
      console.log(`rendered ${image.output} (${image.png.length} bytes) version=${version}`);
    }
    writeFileSync(path.join(root, ogManifestPath), JSON.stringify({
      version, ...ogView, images: images.map(({ png, ...record }) => record),
    }, null, 2) + '\n');
    verifyOgImages(root, version);
  } finally {
    ws?.close();
    if (chrome.pid && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      await Promise.race([exited, sleep(1500)]);
    }
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.error(`临时目录未清理干净：${work}（${error.code ?? error.message}）`); }
  }
}
