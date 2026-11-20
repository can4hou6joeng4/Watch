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
import { content } from './lib/site-content.mjs';
import { guides } from './lib/site-guides.mjs';
import { collectEnglishStrings, localeGaps } from './lib/site-locales-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = path.join(root, 'scripts/lib/site-locales');
const sampleLimit = Number(process.env.LOCALE_SAMPLE_LIMIT ?? 5);
const english = collectEnglishStrings(content.en, guides);

const files = fs.readdirSync(localeDir).filter((name) => name.endsWith('.json')).sort();
let incomplete = 0;
for (const file of files) {
  const locale = file.slice(0, -'.json'.length);
  const dictionary = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
  const { missing, orphans, byGuide } = localeGaps(dictionary, english);
  const status = missing.length ? 'INCOMPLETE' : 'ok';
  if (missing.length) incomplete += 1;
  console.log(`${locale}: ${status} 源串 ${english.strings.size} · 缺 ${missing.length} · 孤儿键 ${orphans.length}`);
  for (const [owner, count] of byGuide) console.log(`  缺 ${count} 条 ← ${owner}`);
  for (const text of missing.slice(0, sampleLimit)) console.log(`  · ${JSON.stringify(text.slice(0, 90))}`);
  for (const key of orphans.slice(0, sampleLimit)) console.log(`  ! 孤儿 ${JSON.stringify(key.slice(0, 90))}`);
}

if (incomplete) {
  console.log(`\n${incomplete} / ${files.length} 个语言包不齐全：WATCH_ALL_LOCALES=1 的构建会跳过它们并打印同样的缺口数。`);
  process.exit(1);
}
console.log(`\n全部 ${files.length} 个语言包与英文源一致。`);