// 把桌面截图 PNG 转成无损 WebP（默认 1280 宽），供 README 与官网直接引用。
//
// 为什么：shoot-desktop.mjs 产出 2560×2240（1280×1120 @2x），而 README 三列网格里每格只有
// 约 320 CSS px（2× DPR ≈ 640 px）。原样引用等于线性 4 倍、像素 16 倍的浪费——六张 PNG 合计
// 约 1.5 MB，转成 1280 宽无损 WebP 后约 0.4 MB，肉眼无差异。
//
// 用法：
//   node scripts/media/optimize-assets.mjs              # 处理 assets/ 下的 desktop-*.png，保留 PNG
//   node scripts/media/optimize-assets.mjs --prune      # 转换后删除源 PNG（仓库只留 WebP）
//   node scripts/media/optimize-assets.mjs <dir>        # 处理指定目录（例如 shoot-desktop 的输出目录）
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const prune = args.includes('--prune');
const positional = args.filter((a) => !a.startsWith('--'));
const srcDir = positional.length ? path.resolve(positional[0]) : path.join(root, 'assets');
const WIDTH = 1280;

const kb = (p) => statSync(p).size / 1024;
const files = readdirSync(srcDir).filter((f) => /^desktop-.*\.png$/.test(f)).sort();
if (!files.length) {
  console.error(`[optimize-assets] ${srcDir} 下没有 desktop-*.png`);
  process.exit(1);
}

let before = 0;
let after = 0;
for (const file of files) {
  const src = path.join(srcDir, file);
  const out = path.join(srcDir, file.replace(/\.png$/, '.webp'));
  try {
    execFileSync('cwebp', ['-lossless', '-z', '9', '-resize', String(WIDTH), '0', '-quiet', src, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    console.error(`[optimize-assets] cwebp 失败（需要 libwebp 的 cwebp，macOS 可用 brew install webp）：${error.message}`);
    process.exit(1);
  }
  const b = kb(src);
  const a = kb(out);
  before += b;
  after += a;
  console.log(`  ${file}  ${b.toFixed(0)} KB → ${path.basename(out)}  ${a.toFixed(0)} KB`);
  if (prune) rmSync(src, { force: true });
}
console.log(`  合计 ${before.toFixed(0)} KB → ${after.toFixed(0)} KB（${(100 - (after / before) * 100).toFixed(0)}% 更小）${prune ? '，已删除源 PNG' : ''}`);
