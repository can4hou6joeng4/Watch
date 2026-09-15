// 把桌面截图 PNG 转成无损 WebP，供 README 与官网直接引用。
//
// 目标宽度怎么定：README 三列网格里每格约 320 CSS px，2× DPR 只需 640 px；取 960 px 仍保留
// 3 倍余量，同时覆盖官网媒体区的显示尺寸。shoot-desktop.mjs 产出 2560×2240（1280×1120 @2x），
// 原样引用等于像素浪费十几倍——六张 PNG 约 1.5 MB，降到 960 宽无损 WebP 后约 0.2 MB。
//
// 用法：
//   node scripts/media/optimize-assets.mjs                      # 处理 assets/ 下的 desktop-*.png
//   node scripts/media/optimize-assets.mjs /tmp/watch-demo/newshots --out assets --prune
//   node scripts/media/optimize-assets.mjs --width 1280         # 需要更大尺寸时显式指定
//
// 依赖 cwebp（libwebp）：macOS 可用 brew install webp。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const prune = args.includes('--prune');
const width = Number(flag('width', '960'));
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const srcDir = path.resolve(positional[0] ?? path.join(root, 'assets'));
const outDir = path.resolve(flag('out', srcDir));
if (!Number.isFinite(width) || width <= 0) {
  console.error('[optimize-assets] --width 需要正整数');
  process.exit(1);
}

const kb = (p) => statSync(p).size / 1024;
const files = readdirSync(srcDir).filter((f) => /^desktop-.*\.png$/.test(f)).sort();
if (!files.length) {
  console.error(`[optimize-assets] ${srcDir} 下没有 desktop-*.png`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let before = 0;
let after = 0;
for (const file of files) {
  const src = path.join(srcDir, file);
  const out = path.join(outDir, file.replace(/\.png$/, '.webp'));
  try {
    execFileSync('cwebp', ['-lossless', '-z', '9', '-resize', String(width), '0', '-quiet', src, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    console.error(`[optimize-assets] cwebp 失败（需要 libwebp 的 cwebp）：${error.message}`);
    process.exit(1);
  }
  const b = kb(src);
  const a = kb(out);
  before += b;
  after += a;
  console.log(`  ${file}  ${b.toFixed(0)} KB → ${path.basename(out)} @${width}px  ${a.toFixed(0)} KB`);
  if (prune) rmSync(src, { force: true });
}
console.log(`  合计 ${before.toFixed(0)} KB → ${after.toFixed(0)} KB（${(100 - (after / before) * 100).toFixed(0)}% 更小）${prune ? '，已删除源 PNG' : ''}`);
