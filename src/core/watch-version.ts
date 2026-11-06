import { readFileSync } from 'node:fs';

/**
 * 读仓库 / 安装包根目录的 package.json 版本；读不出返回 null。
 * 诊断输出要能定位到「哪一版产生的报告」，读不到也不能因此失败。
 */
export function readWatchVersion(moduleUrl: string = import.meta.url): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', moduleUrl), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}
