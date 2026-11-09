import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { escapeControlChars } from './display.js';
import { isFileSystemErrorCode } from './read-text.js';

export type FileDigest = { sha256: string; sizeBytes: number };

/**
 * 写盘失败的说明：`writeFileAtomic` / `appendFileAtomic` 与各家 `importTurns` 抛出的
 * 就是 Node 原文（`EACCES: permission denied, mkdir '…'`），直接拼进 `{ ok:false, error }`
 * 只剩一句英文 errno——用户看不出是权限、磁盘满了还是哪个路径被占住，而这恰恰是唯一
 * 需要照着做的一类错误。
 *
 * 只翻译文件系统错误（`code` 是已知 fs errno）；round-trip 校验失败、写入被阻断这类业务
 * 错误返回 null，由调用方原样带出——否则「内容校验没过」会被讲成「没有权限」。
 * `path` 来自 errno 自带的 `error.path`（可能是 tmp 文件），一起带出才好定位。
 */
export function describeWriteFailureReason(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  if (!isFileSystemErrorCode(code)) return null;
  const rawPath = (error as NodeJS.ErrnoException).path;
  const where = rawPath ? `：${escapeControlChars(rawPath)}` : '';
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `无权写入${where}（权限问题，不是路径写错；确认该目录可写、且不属于其它用户）`;
    case 'EROFS':
      return `目标位于只读文件系统${where}；换一个可写的 HOME / 数据目录后重试`;
    case 'ENOSPC':
    case 'EDQUOT':
      return `磁盘空间不足或超出配额${where}；清理空间后重试（本次未写入任何内容）`;
    case 'EMFILE':
    case 'ENFILE':
      return `打开的文件过多${where}；关掉其它程序或稍后重试（本次未写入任何内容）`;
    case 'EISDIR':
      return `目标是目录而不是文件${where}；先把它挪走再重试（本次未写入任何内容）`;
    case 'ENOTDIR':
      return `路径上的某一级不是目录${where}（被同名文件占住了？）；恢复该路径后重试`;
    case 'ENOENT':
      return `目标路径的上级目录不存在${where}（可能在写入过程中被移动或删除）；确认目录还在再重试`;
    case 'EBUSY':
      return `目标文件正被占用${where}；退出可能正在写它的程序后重试（本次未写入任何内容）`;
    default:
      return `写入失败（${code}）${where}；本次未写入任何内容，可据上面的路径排查`;
  }
}

/** 文件内容指纹；文件不存在返回 null（TOCTOU 检测用） */
export async function digestFile(filePath: string): Promise<FileDigest | null> {
  let raw: Buffer;
  let info;
  try {
    [raw, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  } catch {
    return null;
  }
  return { sha256: createHash('sha256').update(raw).digest('hex'), sizeBytes: info.size };
}

/**
 * 原子写文件：写同目录 tmp → fsync → verify 回调 → 可选 backup → rename。
 * 任一步失败都会清理 tmp 并重抛，原文件从未被触碰。
 * - `backup`：rename 前把原文件复制为 `<file>.bak`（单代，覆盖上一代）
 * - `verify`：tmp 落盘后、rename 前回调（round-trip 自校验）；抛错则零写盘
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  opts?: { backup?: boolean; verify?: (tmpPath: string) => Promise<void> },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.watch-tmp-${randomUUID()}`;
  try {
    let mode: number | undefined;
    try {
      mode = (await stat(filePath)).mode & 0o777;
    } catch {
      mode = undefined; // 新文件
    }
    const handle = await open(tmpPath, 'w', mode ?? 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (opts?.verify) await opts.verify(tmpPath);
    if (opts?.backup) {
      try {
        await copyFile(filePath, `${filePath}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 原子追加文件：将原文件复制到同目录 tmp（若原文件不存在则新建 tmp）→ append extraContent → fsync → verify 回调 → 可选 backup → rename。
 * 任一步失败都会清理 tmp 并重抛，原文件从未被触碰。
 * - `backup`：rename 前把原文件复制为 `<file>.bak`（单代，覆盖上一代）
 * - `verify`：tmp 落盘后、rename 前回调；抛错则零写盘
 */
export async function appendFileAtomic(
  filePath: string,
  extraContent: string,
  opts?: { backup?: boolean; verify?: (tmpPath: string) => Promise<void> },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.watch-tmp-${randomUUID()}`;
  try {
    let originalExists = false;
    let mode: number | undefined;

    try {
      const s = await stat(filePath);
      mode = s.mode & 0o777;
      originalExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mode = undefined;
    }

    if (originalExists) {
      // 末尾没有换行时先补一个：原生文件被截断（进程被杀）后末尾常缺 \n，
      // 直接追加会把两行 JSON 粘成一行，既有最后一条与新追加的第一条一起失效。
      let needsNewline = false;
      try {
        const handle = await open(filePath, 'r');
        try {
          const { size } = await handle.stat();
          if (size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            needsNewline = last[0] !== 0x0a;
          }
        } finally {
          await handle.close();
        }
      } catch {
        // 读不出末尾字节就不做判断，保持原来的纯追加行为
      }
      await copyFile(filePath, tmpPath);
      const handle = await open(tmpPath, 'a');
      try {
        await handle.writeFile(needsNewline ? `\n${extraContent}` : extraContent, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      const handle = await open(tmpPath, 'w', mode ?? 0o600);
      try {
        await handle.writeFile(extraContent, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    if (opts?.verify) await opts.verify(tmpPath);
    if (opts?.backup && originalExists) {
      try {
        await copyFile(filePath, `${filePath}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

