// 打包产物运行期依赖检查：核对 esbuild 目标架构，以及核心声明的 TOML 解析器与许可文件。
// 只读检查 bundle 资源，不执行被检查的二进制；参数为目标根目录（含 watch-core）。
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('用法: node scripts/verify-bundle-runtime.mjs <含 watch-core 的目录>');
  process.exit(2);
}

// esbuild 按 process.platform / os.arch() 选包，宿主架构与安装包目标必须一致。
function expectedEsbuildPackage(platform, arch) {
  const keys = {
    'darwin arm64': '@esbuild/darwin-arm64',
    'darwin x64': '@esbuild/darwin-x64',
    'linux x64': '@esbuild/linux-x64',
    'linux arm64': '@esbuild/linux-arm64',
    'win32 x64': '@esbuild/win32-x64',
    'win32 arm64': '@esbuild/win32-arm64',
  };
  return keys[`${platform} ${arch}`] ?? null;
}

const target = process.argv[3] ?? process.platform + '/' + process.arch;
const [platform, arch] = target.split('/');
const wanted = expectedEsbuildPackage(platform, arch);// 允许传安装包资源根（含 watch-core）或直接传 watch-core / 仓库根两种布局。
const inner = path.join(root, 'watch-core');
const core = await exists(path.join(inner, 'node_modules')) ? inner : root;
const esbuildRoot = path.join(core, 'node_modules', 'esbuild');
const optionalRoot = path.join(core, 'node_modules', '@esbuild');
const problems = [];
const facts = {};

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}
try {
  const version = JSON.parse(await readFile(path.join(esbuildRoot, 'package.json'), 'utf8')).version;
  facts.esbuildVersion = version;
  // `watch --version` / `doctor` 经 src/core/watch-version.ts 读 watch-core/package.json；
  // 打包资源漏了它，安装包就只能报「未知版本」（0.1.26 修复）。
  try {
    const corePackage = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
    const coreVersion = corePackage.version;
    facts.corePackageVersion = typeof coreVersion === 'string' ? coreVersion : null;
    if (typeof coreVersion !== 'string') problems.push('watch-core/package.json 缺少 version 字段');
    // 历史安装包可能没有该依赖；声明过就必须随包交付，不能依赖构建机的 node_modules。
    const expectedTomlVersion = corePackage.dependencies?.['smol-toml'];
    if (expectedTomlVersion) {
      try {
        const tomlRoot = path.join(core, 'node_modules', 'smol-toml');
        const tomlPackage = JSON.parse(await readFile(path.join(tomlRoot, 'package.json'), 'utf8'));
        facts.tomlVersion = tomlPackage.version;
        if (tomlPackage.version !== expectedTomlVersion) problems.push('smol-toml 版本与 watch-core 声明的固定版本不一致');
        for (const filename of ['dist/index.js', 'LICENSE']) {
          if (!(await stat(path.join(tomlRoot, filename))).isFile()) problems.push(`smol-toml/${filename} 不是普通文件`);
        }
      } catch (error) {
        problems.push(`smol-toml 运行期依赖或许可文件不完整：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    problems.push(`缺少 watch-core/package.json（运行期 --version / doctor 会报未知版本）：${error instanceof Error ? error.message : String(error)}`);
  }
  const bins = await readdir(path.join(esbuildRoot, 'bin')).catch(() => []);
  facts.esbuildBinEntries = bins;
  const packages = await readdir(optionalRoot).catch(() => []);
  facts.optionalPackages = packages.sort();
  // esbuild 的 lib/main.js 在运行期解析 @esbuild/<platform>/bin/esbuild，
  // 但 npm 装依赖时按安装机架构选择；交叉构建必须显式补装目标包。
  if (wanted) {
    if (!packages.includes(wanted.replace('@esbuild/', ''))) {
      problems.push(`缺少目标架构依赖 ${wanted}（存在: ${facts.optionalPackages.join(', ') || '无'}）`);
    } else if (!(await exists(path.join(optionalRoot, wanted.replace('@esbuild/', ''), 'bin', 'esbuild'))) &&
               !(await exists(path.join(optionalRoot, wanted.replace('@esbuild/', ''), 'esbuild.exe')))) {
      problems.push(`${wanted} 目录存在但缺少可执行文件`);
    }
  }
  const downloaded = (await readdir(path.join(esbuildRoot, 'lib')).catch(() => [])).filter((name) => name.startsWith('downloaded-'));
  facts.downloadedFallbacks = downloaded;
  if (!wanted && downloaded.length === 0) {
    facts.note = `未登记平台 ${target}：只记录现有包，无法判断运行期可执行文件`;
  }
} catch (error) {
  problems.push(`读取 esbuild 运行期依赖失败：${error instanceof Error ? error.message : String(error)}`);
}

const report = { target, expectedPackage: wanted, ...facts, problems };
console.log(JSON.stringify(report, null, 2));
if (problems.length) process.exit(1);
