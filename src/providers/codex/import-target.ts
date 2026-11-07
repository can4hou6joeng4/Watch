import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { digestFile, type FileDigest } from '../../core/atomic.js';

export type ImportTarget = {
  policy: 'official-api-target-v1';
  path: string;
  device: string;
  inode: string;
  config: FileDigest | null;
};

export const IMPORT_TARGET_LOCK = '.watch-official-import.lock';

export async function inspectImportTarget(directory: string): Promise<ImportTarget> {
  if (!path.isAbsolute(directory)) throw new Error('Codex 数据目录必须是绝对路径');
  const canonical = await realpath(directory);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('Codex 数据目标必须是目录');
  if (process.platform !== 'win32' && ((info.mode & 0o022n) !== 0n || info.uid !== BigInt(process.getuid!()))) {
    throw new Error('Codex 数据目录必须属于当前用户，且不能对组或其他用户可写');
  }
  const configFile = path.join(canonical, 'config.toml');
  let config: FileDigest | null = null;
  try {
    if (!(await lstat(configFile)).isFile()) throw new Error('Codex 配置必须是普通文件，不能是符号链接');
    config = await digestFile(configFile);
    if (!config) throw new Error('无法计算 Codex 配置的指纹');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { policy: 'official-api-target-v1', path: canonical, device: info.dev.toString(), inode: info.ino.toString(), config };
}

export async function assertImportTarget(directory: string, expected: ImportTarget): Promise<void> {
  const current = await inspectImportTarget(directory);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Codex 目标目录或配置在预览之后已变化');
}

export async function assertTargetFile(target: ImportTarget, file: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('原生线程路径必须是绝对路径');
  const resolved = await realpath(file);
  const relative = path.relative(target.path, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
    !(await lstat(resolved)).isFile()) throw new Error('原生线程路径不在已确认的 Codex 数据目录内');
}

/** Serializes Watch submissions across journals; native clients do not honor this lock. */
export async function acquireImportTarget(target: ImportTarget, planId: string): Promise<{ release(): Promise<void> }> {
  await assertImportTarget(target.path, target);
  const file = path.join(target.path, IMPORT_TARGET_LOCK);
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Codex 目标上还有进行中或结果未知的 Watch 导入；请先查看它的执行日志再重试');
    throw error;
  }
  let identity: { dev: bigint; ino: bigint };
  try {
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({ planId, pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    release: async () => {
      // Never remove a replacement lock that may belong to another operation.
      const current = await lstat(file, { bigint: true });
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('导入锁已被改变，需要人工复核');
      }
      await unlink(file);
    },
  };
}
