#!/usr/bin/env node
/**
 * 语言包完整性核对（只读）。
 *
 * `WATCH_ALL_LOCALES=1 npm run site:build` 只在某个语言包缺键时才失败，而且一次只报第一条；
 * 源文案改过、语言包没跟上的「孤儿键」则完全不报——翻译占着位置却再也不会被用到。
 * 这个脚本把两边都列出来：每个语言包缺哪些英文源串（构建会失败的原因），
 * 以及哪些键在英文源里已经不存在（说明某处文案改过而译文没跟上）。
 *
 * 不做翻译，也不改文件。全部齐全时 exit 0；任一语言包不齐全时 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { content, defaultLocaleList, locales } from './lib/site-content.mjs';
import { guides } from './lib/site-guides.mjs';
import { collectEnglishStrings, localeGaps, localeTokenIssues } from './lib/site-locales-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = path.join(root, 'scripts/lib/site-locales');
const sampleLimit = Number(process.env.LOCALE_SAMPLE_LIMIT ?? 5);
const english = collectEnglishStrings(content.en, guides);

const files = fs.readdirSync(localeDir).filter((name) => name.endsWith('.json')).sort();
const present = new Set(files.map((name) => name.slice(0, -'.json'.length)));
let incomplete = 0;
let tokenProblem = 0;
for (const file of files) {
  const locale = file.slice(0, -'.json'.length);
  const dictionary = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
  const { missing, orphans, byGuide } = localeGaps(dictionary, english);
  const tokenIssues = localeTokenIssues(dictionary);
  if (tokenIssues.length) tokenProblem += 1;
  const status = missing.length || tokenIssues.length ? 'INCOMPLETE' : 'ok';
  if (missing.length) incomplete += 1;
  console.log(`${locale}: ${status} 源串 ${english.strings.size} · 缺 ${missing.length} · 孤儿键 ${orphans.length} · 记号 ${tokenIssues.length}`);
  for (const [owner, count] of byGuide) console.log(`  缺 ${count} 条 ← ${owner}`);
  for (const text of missing.slice(0, sampleLimit)) console.log(`  · ${JSON.stringify(text.slice(0, 90))}`);
  for (const key of orphans.slice(0, sampleLimit)) console.log(`  ! 孤儿 ${JSON.stringify(key.slice(0, 90))}`);
  for (const issue of tokenIssues.slice(0, sampleLimit)) console.log(`  ⚠ 记号${issue.kind === 'missing' ? '消失' : '多出'} ${JSON.stringify(issue.token)} ← ${JSON.stringify(issue.source.slice(0, 90))}`);
}

// 手写稿（zh / en）没有 JSON 语言包：它们的内容直接写在 site-content.mjs 与 site-guides.mjs 里。
const handWritten = new Set(['zh', 'en']);
const missingPacks = defaultLocaleList.filter((locale) => !handWritten.has(locale) && !present.has(locale));
if (missingPacks.length) {
  incomplete += missingPacks.length;
  console.log(`\n默认发布清单里的 ${missingPacks.join('、')} 没有语言包：构建会因默认语言缺键直接失败，请先补齐或暂时移出 defaultLocaleList。`);
}

// 已登记到 locales 但既没有语言包、也不在默认清单里的语言：构建时整轮跳过，这里明确列出来，
// 避免「注册表里有、站点上没有」这种状态只存在于构建日志里。
const registeredOnly = Object.keys(locales).filter(
  (locale) => !handWritten.has(locale) && !defaultLocaleList.includes(locale) && !present.has(locale)
);
if (registeredOnly.length) {
  console.log(`\n已登记但未发布：${registeredOnly.join('、')}（无语言包，构建时跳过；补齐后可加入 defaultLocaleList）。`);
}

const dormant = [...present].filter((locale) => !defaultLocaleList.includes(locale));
if (dormant.length) {
  console.log(`\n有语言包但未加入默认清单：${dormant.join('、')}（默认构建不包含，WATCH_ALL_LOCALES=1 时才纳入判定）。`);
}

if (incomplete) {
  console.log(`\n${incomplete} 个语言包缺键：WATCH_ALL_LOCALES=1 的构建会跳过它们并打印同样的缺口数；默认清单里的语言缺键会让 site:build 直接失败。`);
}
if (tokenProblem) {
  console.log(`\n${tokenProblem} 个语言包有记号差异：默认清单里的语言会让 site:build 直接失败，其余语言只在构建日志里警告。`);
}
if (incomplete || tokenProblem) process.exit(1);
console.log(`\n全部 ${files.length} 个语言包与英文源一致。`);