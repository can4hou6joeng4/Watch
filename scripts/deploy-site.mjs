#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// 1. Load Cloudflare credentials from ~/.env if available
const envFile = path.join(os.homedir(), '.env');
const envVars = { ...process.env };

if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1);
      }
      if (!envVars[key]) {
        envVars[key] = val;
      }
    }
  }
}

const siteDir = path.resolve(process.cwd(), 'site');

if (!fs.existsSync(siteDir) || !fs.existsSync(path.join(siteDir, 'index.html'))) {
  console.error(`[Error] 找不到站点目录或 index.html: ${siteDir}`);
  process.exit(1);
}

if (!envVars.CLOUDFLARE_ACCOUNT_ID && !envVars.CF_ACCOUNT_ID) {
  console.error('[Error] 缺少 Cloudflare 账号 ID。请在 ~/.env 的 [Cloudflare] 段写入 CLOUDFLARE_ACCOUNT_ID（或 CF_ACCOUNT_ID）；该值不写进仓库。');
  process.exit(1);
}

console.log('正在生成双语站点与共享静态资产...');
const build = spawnSync(process.execPath, ['scripts/build-site.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});
if (build.status !== 0) {
  console.error(`[Error] 站点构建失败: ${build.error?.message || build.status}`);
  process.exit(build.status || 1);
}

console.log(`🚀 开始将 ${siteDir} 部署至 Cloudflare Workers (静态资产 + 自定义域 relay.bobochang.cn)...`);

// 用当前 Node 直接执行本地安装的 Wrangler 入口，不经 npx 与 shell：
// shell: true 带参数会触发 Node 的 DEP0190 弃用警告，Windows 上的 npx.cmd 也只能靠 shell 启动。
// wrangler 的 exports 不公开 bin 子路径，因此从 package.json 的 bin 字段定位入口文件。
const require = createRequire(import.meta.url);
let wranglerBin;
try {
  const manifestPath = require.resolve('wrangler/package.json');
  const bin = require(manifestPath).bin;
  const relativeBin = typeof bin === 'string' ? bin : bin?.wrangler;
  if (typeof relativeBin !== 'string' || !relativeBin) throw new Error('package.json 没有 wrangler 的 bin 入口');
  wranglerBin = path.resolve(path.dirname(manifestPath), relativeBin);
  if (!fs.statSync(wranglerBin).isFile()) throw new Error(`入口不是普通文件: ${wranglerBin}`);
} catch (error) {
  console.error(`[Error] 找不到本地安装的 Wrangler（${error?.message || error}）。请先在仓库根运行 npm install。`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [wranglerBin, 'deploy'], {
  cwd: process.cwd(),
  env: envVars,
  stdio: 'inherit'
});

if (result.error) {
  console.error(`\n❌ 无法启动 Wrangler: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`\n❌ 部署失败，退出码: ${result.status}`);
  process.exit(result.status || 1);
}

console.log(`\n✅ 部署完成！已成功部署为 Cloudflare Worker:`);
console.log(`  👉 https://relay.bobochang.cn`);
