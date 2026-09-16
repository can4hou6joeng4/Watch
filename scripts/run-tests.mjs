import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIsolatedEnvironment } from './lib/isolated-environment.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

// tests/ 不随版本库分发（本地保留）：CI 只跑类型检查、前端构建与 Rust 测试。
// 任何参数都会整体替换默认文件表，所以定向运行仍可用。
let testArgs = args;
if (!testArgs.length) {
  let files = [];
  try {
    files = (await readdir(path.join(repo, 'tests'))).filter((file) => file.endsWith('.test.ts')).sort();
  } catch {
    // 目录缺失：下面给出明确提示
  }
  if (!files.length) {
    console.error(
      '本地测试套件不在版本库中。请在包含 tests/ 的工作区运行 npm test，或用 npm test -- <file> 指定测试文件。',
    );
    process.exit(1);
  }
  testArgs = files.map((file) => `tests/${file}`);
}

const isolated = await createIsolatedEnvironment();
try {
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testArgs], {
    cwd: repo, env: isolated.env, stdio: 'inherit',
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} finally {
  await isolated.cleanup();
}
