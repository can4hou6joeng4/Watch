#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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

const result = spawnSync('npx', [
  'wrangler',
  'deploy'
], {
  cwd: process.cwd(),
  env: envVars,
  stdio: 'inherit',
  shell: true
});

if (result.status !== 0) {
  console.error(`\n❌ 部署失败，退出码: ${result.status}`);
  process.exit(result.status || 1);
}

console.log(`\n✅ 部署完成！已成功部署为 Cloudflare Worker:`);
console.log(`  👉 https://relay.bobochang.cn`);

// 3. IndexNow：通知 Bing / Yandex 等已变更的 URL（key 文件由 site/<key>.txt 提供）
const keyFile = fs.readdirSync(siteDir).find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
if (keyFile) {
  const key = keyFile.slice(0, -4);
  const host = 'relay.bobochang.cn';
  const urlList = [`https://${host}/`, `https://${host}/en/`, `https://${host}/llms.txt`, `https://${host}/sitemap.xml`];
  try {
    const response = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${keyFile}`, urlList }),
    });
    console.log(`📣 IndexNow 已提交 ${urlList.length} 个 URL，状态 ${response.status}`);
  } catch (error) {
    console.error(`[Warn] IndexNow 提交失败（不影响部署）: ${error.message}`);
  }
} else {
  console.error('[Warn] site/ 下没有 IndexNow key 文件，跳过提交');
}
