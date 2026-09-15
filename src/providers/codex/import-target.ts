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
  if (!path.isAbsolute(directory)) throw new Error('Codex data directory must be absolute');
  const canonical = await realpath(directory);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('Codex data target must be a directory');
  if (process.platform !== 'win32' && ((info.mode & 0o022n) !== 0n || info.uid !== BigInt(process.getuid!()))) {
    throw new Error('Codex data directory must be owned by the current user and not writable by others');
  }
  const configFile = path.join(canonical, 'config.toml');
  let config: FileDigest | null = null;
  try {
    if (!(await lstat(configFile)).isFile()) throw new Error('Codex config must be a regular file, not a symlink');
    config = await digestFile(configFile);
    if (!config) throw new Error('Cannot fingerprint Codex config');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { policy: 'official-api-target-v1', path: canonical, device: info.dev.toString(), inode: info.ino.toString(), config };
}

export async function assertImportTarget(directory: string, expected: ImportTarget): Promise<void> {
  const current = await inspectImportTarget(directory);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Codex target directory or configuration changed since preview');
}

export async function assertTargetFile(target: ImportTarget, file: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('Native thread path must be absolute');
  const resolved = await realpath(file);
  const relative = path.relative(target.path, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
    !(await lstat(resolved)).isFile()) throw new Error('Native thread path is outside the confirmed Codex data directory');
}

/** Serializes Watch submissions across journals; native clients do not honor this lock. */
export async function acquireImportTarget(target: ImportTarget, planId: string): Promise<{ release(): Promise<void> }> {
  await assertImportTarget(target.path, target);
  const file = path.join(target.path, IMPORT_TARGET_LOCK);
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Codex target has an active or uncertain Watch import; inspect its journal before retrying');
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
        throw new Error('Import lock changed; manual review is required');
      }
      await unlink(file);
    },
  };
}
