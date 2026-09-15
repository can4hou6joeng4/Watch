import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

export type OpenCodeImportTarget = {
  policy: 'opencode-official-target-v1';
  path: string;
  device: string;
  inode: string;
};

export const OPENCODE_IMPORT_TARGET_LOCK = '.watch-opencode-official-import.lock';

export async function inspectOpenCodeImportTarget(directory: string): Promise<OpenCodeImportTarget> {
  if (!path.isAbsolute(directory)) throw new Error('OpenCode data directory must be absolute');
  const canonical = await realpath(directory);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('OpenCode data target must be a directory');
  if (process.platform !== 'win32' && ((info.mode & 0o022n) !== 0n || info.uid !== BigInt(process.getuid!()))) {
    throw new Error('OpenCode data directory must be owned by the current user and not writable by others');
  }
  return {
    policy: 'opencode-official-target-v1',
    path: canonical,
    device: info.dev.toString(),
    inode: info.ino.toString(),
  };
}

export async function assertOpenCodeImportTarget(expected: OpenCodeImportTarget): Promise<void> {
  const current = await inspectOpenCodeImportTarget(expected.path);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('OpenCode target directory changed since preview');
  }
}

/** Serializes Watch submissions. OpenCode itself does not honor this lock. */
export async function acquireOpenCodeImportTarget(
  target: OpenCodeImportTarget,
  planId: string,
): Promise<{ release(): Promise<void> }> {
  await assertOpenCodeImportTarget(target);
  const file = path.join(target.path, OPENCODE_IMPORT_TARGET_LOCK);
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('OpenCode target has an active or uncertain Watch import; inspect its journal before retrying');
    }
    throw error;
  }
  let identity: { dev: bigint; ino: bigint; birthtimeNs: bigint; size: bigint };
  try {
    await handle.writeFile(JSON.stringify({ planId, pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    identity = {
      dev: info.dev,
      ino: info.ino,
      birthtimeNs: info.birthtimeNs,
      size: info.size,
    };
  } finally {
    await handle.close();
  }
  return {
    release: async () => {
      const current = await lstat(file, { bigint: true });
      if (
        !current.isFile()
        || current.dev !== identity.dev
        || current.ino !== identity.ino
        || current.birthtimeNs !== identity.birthtimeNs
        || current.size !== identity.size
      ) {
        throw new Error('OpenCode import lock changed; manual review is required');
      }
      await unlink(file);
    },
  };
}
