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
  if (!path.isAbsolute(directory)) throw new Error('OpenCode 数据目录必须是绝对路径');
  const canonical = await realpath(directory);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('OpenCode 数据目标必须是目录');
  if (process.platform !== 'win32' && ((info.mode & 0o022n) !== 0n || info.uid !== BigInt(process.getuid!()))) {
    throw new Error('OpenCode 数据目录必须属于当前用户，且不能对组或其他用户可写');
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
    throw new Error('OpenCode 目标目录在预览之后已变化；请重新 prepare');
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
      throw new Error('该 OpenCode 目标上还有进行中或结果未知的 Watch 导入；请先查看它的执行日志再重试');
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
        throw new Error('OpenCode 导入锁在检测期间发生变化；需要人工复核后再继续');
      }
      await unlink(file);
    },
  };
}
