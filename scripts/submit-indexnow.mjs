#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildIndexNowUrlList } from './lib/indexnow-urls.mjs';

const siteUrl = 'https://relay.bobochang.cn';
const host = new URL(siteUrl).hostname;
const siteDir = path.resolve(process.cwd(), 'site');
const sitemapPath = path.join(siteDir, 'sitemap.xml');
const submit = process.argv.slice(2).includes('--submit');

if (!fs.existsSync(sitemapPath)) {
  console.error(`[Error] 找不到已构建的 sitemap: ${sitemapPath}`);
  process.exit(1);
}

const keyFiles = fs.readdirSync(siteDir).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name));
if (keyFiles.length !== 1) {
  console.error(`[Error] site/ 必须且只能包含一个 32 位十六进制 IndexNow key 文件，当前找到 ${keyFiles.length} 个`);
  process.exit(1);
}

const extraFiles = ['llms.txt', 'llms-full.txt', 'sitemap.xml'];
for (const name of extraFiles) {
  if (!fs.existsSync(path.join(siteDir, name))) {
    console.error(`[Error] IndexNow URL 清单所需文件不存在: site/${name}`);
    process.exit(1);
  }
}

let urlList;
try {
  urlList = buildIndexNowUrlList({
    sitemapXml: fs.readFileSync(sitemapPath, 'utf8'),
    siteUrl,
    extraPaths: extraFiles.map((name) => `/${name}`),
  });
} catch (error) {
  console.error(`[Error] 无法从 sitemap 构造 IndexNow URL 清单: ${error.message}`);
  process.exit(1);
}

const keyFile = keyFiles[0];
const key = keyFile.slice(0, -4);
if (!submit) {
  console.log(`IndexNow 清单验证通过，共 ${urlList.length} 个同源 URL；未发送网络请求。`);
  console.log('获得独立提交授权后，运行: npm run site:indexnow -- --submit');
  process.exit(0);
}

let response;
try {
  response = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation: `${siteUrl}/${keyFile}`, urlList }),
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  console.error(`[Error] IndexNow 请求失败: ${error.message}`);
  process.exit(1);
}

if (!response.ok) {
  const detail = (await response.text()).trim().slice(0, 500);
  console.error(`[Error] IndexNow 返回 HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  process.exit(1);
}

console.log(`IndexNow 已提交 ${urlList.length} 个同源 URL，状态 ${response.status}`);
