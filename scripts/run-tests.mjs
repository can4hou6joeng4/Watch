import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIsolatedEnvironment } from './lib/isolated-environment.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const isolated = await createIsolatedEnvironment();
const args = process.argv.slice(2);
const testArgs = args.length ? args : (await readdir(path.join(repo, 'tests')))
  .filter((file) => file.endsWith('.test.ts')).sort().map((file) => `tests/${file}`);
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
