import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const ogView = { width: 1200, height: 630 };
export const ogTemplates = [
  { source: 'scripts/media/og-zh.html', output: 'site/og.png' },
  { source: 'scripts/media/og-en.html', output: 'site/og-en.png' },
];
export const ogManifestPath = 'scripts/media/og-manifest.json';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 清单由实际截图后生成；同时绑定模板与 PNG，避免只校验新模板却发布旧图片。
export function verifyOgImages(root, version) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, ogManifestPath), 'utf8'));
    if (manifest.version !== version) throw new Error(`渲染版本为 ${manifest.version}，当前版本为 ${version}`);
    if (manifest.width !== ogView.width || manifest.height !== ogView.height) throw new Error('渲染尺寸不匹配');
    for (const template of ogTemplates) {
      const record = manifest.images?.find((item) => item.source === template.source && item.output === template.output);
      if (!record) throw new Error(`${template.output} 缺少渲染记录`);
      if (record.templateSha256 !== sha256(readFileSync(path.join(root, template.source)))) throw new Error(`${template.source} 已变化`);
      const png = readFileSync(path.join(root, template.output));
      if (record.sha256 !== sha256(png)) throw new Error(`${template.output} 摘要不匹配`);
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) !== ogView.width || png.readUInt32BE(20) !== ogView.height) {
        throw new Error(`${template.output} 不是预期的 1200×630 PNG`);
      }
    }
  } catch (error) {
    throw new Error(`[site-og] ${error.message}；升版或改模板后运行 node scripts/media/render-og.mjs，再重新构建站点。`);
  }
}
