import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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
  let reason: string;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      reason = `无权写入${where}（权限问题，不是路径写错；确认该目录可写、且不属于其它用户）`;
      break;
    case 'EROFS':
      reason = `目标位于只读文件系统${where}；换一个可写的 HOME / 数据目录后重试`;
      break;
    case 'ENOSPC':
    case 'EDQUOT':
      reason = `磁盘空间不足或超出配额${where}；清理空间后重试（本次未写入任何内容）`;
      break;
    case 'EMFILE':
    case 'ENFILE':
      reason = `打开的文件过多${where}；关掉其它程序或稍后重试（本次未写入任何内容）`;
      break;
    case 'EISDIR':
      reason = `目标是目录而不是文件${where}；先把它挪走再重试（本次未写入任何内容）`;
      break;
    case 'ENOTDIR':
      reason = `路径上的某一级不是目录${where}（被同名文件占住了？）；恢复该路径后重试`;
      break;
    case 'ENOENT':
      reason = `目标路径的上级目录不存在${where}（可能在写入过程中被移动或删除）；确认目录还在再重试`;
      break;
    case 'EBUSY':
      reason = `目标文件正被占用${where}；退出可能正在写它的程序后重试（本次未写入任何内容）`;
      break;
    default:
      reason = `写入失败（${code}）${where}；本次未写入任何内容，可据上面的路径排查`;
  }
  // 备份回滚失败时，主文件仍然没动，但上一代 .bak 可能已被覆盖，不能只报发布失败。
  const rollback = (error as { watchRollbackFailure?: string }).watchRollbackFailure;
  return rollback ? `${reason}；${rollback}` : reason;
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

/** 独占创建备份副本并同步后替换目录项，不沿已有 .bak 链接覆盖其它文件。 */
async function backupFileAtomic(filePath: string): Promise<void> {
  const backupPath = `${filePath}.bak`;
  const tmpPath = path.join(path.dirname(filePath), `.watch-tmp-${randomUUID()}`);
  // EXCL 防止临时名冲突时覆盖既有文件；复制失败后的清理由 copyFile 尝试完成。
  try {
    await copyFile(filePath, tmpPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // 新文件没有旧内容可备份
    throw error;
  }
  // 复制完成后的任何失败都必须抛出，不能把临时副本消失误当成新文件。
  try {
    const mode = (await stat(tmpPath)).mode & 0o777;
    // Windows 同步需要写句柄；先给本次私有副本所有者读写权限，再恢复源权限位。
    await chmod(tmpPath, mode | 0o600);
    const handle = await open(tmpPath, 'r+');
    try {
      await chmod(tmpPath, mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, backupPath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

type BackupRollback = {
  path: string;
  restore: () => Promise<void>;
  discard: () => Promise<void>;
};

/**
 * 覆盖 `.bak` 前先把上一代备份挪到同目录暂名。主文件最终 rename 失败时，
 * 必须能把 `.bak` 恢复成原样——此前先把新备份发布、再写主文件，失败会让唯一的旧备份被覆盖。
 * `rename` 本身就替换目录项，不沿 `.bak` 的符号链接写别处。
 */
async function stageBackupRollback(filePath: string): Promise<BackupRollback | null> {
  const backupPath = `${filePath}.bak`;
  const rollbackPath = `${backupPath}.watch-rollback-${randomUUID()}`;
  let existing;
  try {
    existing = await lstat(backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // 还没有旧备份
    throw error;
  }
  // 目录 / 设备文件不能当作单代备份挪走再丢弃：先拒绝，保留原来的失败语义。
  // 符号链接可以暂存，backupFileAtomic 仍会用新文件替换链接本身而不沿链接写别处。
  if (!existing.isFile() && !existing.isSymbolicLink()) {
    throw Object.assign(new Error(`备份路径不是普通文件：${escapeControlChars(backupPath)}`), {
      code: 'EISDIR',
      path: backupPath,
    });
  }
  try {
    await rename(backupPath, rollbackPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return {
    path: rollbackPath,
    restore: () => rename(rollbackPath, backupPath),
    discard: () => rm(rollbackPath, { force: true }),
  };
}

function annotateRollbackFailure(error: unknown, restoreError: unknown, rollbackPath: string): unknown {
  if (!(error instanceof Error)) return error;
  const reason =
    describeWriteFailureReason(restoreError) ??
    escapeControlChars(restoreError instanceof Error ? restoreError.message : String(restoreError));
  return Object.assign(error, {
    watchRollbackFailure:
      `旧备份恢复失败（${reason}）：${escapeControlChars(rollbackPath)}；` +
      `原会话未改动，但上一代备份可能已被覆盖`,
  });
}

/**
 * 原子写文件：写同目录 tmp → fsync → verify 回调 → 可选 backup → rename。
 * 任一步失败都会清理 tmp 并重抛，原文件与既有 `.bak` 逐字节不变；
 * backup 阶段失败时旧备份先回滚，回滚自身失败会写进错误说明。
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
    // 临时文件先按 0600 创建：源文件可能是 0200（只写）或 0444（只读），
    // 用源权限位创建会让 verify 读不了、后续也改不了；发布前再恢复源权限位。
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (opts?.verify) await opts.verify(tmpPath);
    let rollback: BackupRollback | null = null;
    if (opts?.backup) {
      rollback = await stageBackupRollback(filePath);
      try {
        await backupFileAtomic(filePath);
      } catch (error) {
        if (rollback) {
          try {
            await rollback.restore();
          } catch (restoreError) {
            throw annotateRollbackFailure(error, restoreError, rollback.path);
          }
        }
        throw error;
      }
    }
    try {
      if (mode !== undefined) await chmod(tmpPath, mode);
      await rename(tmpPath, filePath);
    } catch (error) {
      if (rollback) {
        try {
          await rollback.restore();
        } catch (restoreError) {
          throw annotateRollbackFailure(error, restoreError, rollback.path);
        }
      }
      throw error;
    }
    // 主文件已发布，回滚副本只是暂名，清理失败不改变会话内容；不能把成功报成失败。
    if (rollback) await rollback.discard().catch(() => {});
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 原子追加文件：将原文件复制到同目录 tmp（若原文件不存在则新建 tmp）→ append extraContent → fsync → verify 回调 → 可选 backup → rename。
 * 任一步失败都会清理 tmp 并重抛，原文件与既有 `.bak` 逐字节不变；
 * backup 阶段失败时旧备份先回滚，回滚自身失败会写进错误说明。
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
      await copyFile(filePath, tmpPath);
      // copyFile 会保留源权限位；0444 / 0200 的源文件会让 'a' 打开或 verify 读取失败。
      // 先给本次私有副本补上读写位，发布前再恢复源权限位。
      if (mode !== undefined) await chmod(tmpPath, mode | 0o600);
      // 末尾没有换行时先补一个：原生文件被截断（进程被杀）后末尾常缺 \n，
      // 直接追加会把两行 JSON 粘成一行，既有最后一条与新追加的第一条一起失效。
      // 判断做在本次私有副本上，不再读源文件：源文件在 stat 之后被别的进程改写时，
      // 旧写法会按改之前的内容决定补不补换行，与随后复制到的内容对不上。
      let needsNewline = false;
      const probe = await open(tmpPath, 'r');
      try {
        const { size } = await probe.stat();
        if (size > 0) {
          const last = Buffer.alloc(1);
          const { bytesRead } = await probe.read(last, 0, 1, size - 1);
          if (bytesRead !== 1) {
            // 用非 errno 的业务 code：`describeWriteFailureReason()` 会把任何 E* 翻成通用
            // 「写入失败（E…）」，把这条具体诊断盖掉
            throw Object.assign(new Error(`无法读取追加副本的末尾字节（${escapeControlChars(tmpPath)}），已中止写入；原文件与既有备份未改动，可重试`), {
              code: 'EWATCHTAILPROBE',
              path: tmpPath,
            });
          }
          needsNewline = last[0] !== 0x0a;
        }
      } finally {
        await probe.close();
      }
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
    let rollback: BackupRollback | null = null;
    if (opts?.backup && originalExists) {
      rollback = await stageBackupRollback(filePath);
      try {
        await backupFileAtomic(filePath);
      } catch (error) {
        if (rollback) {
          try {
            await rollback.restore();
          } catch (restoreError) {
            throw annotateRollbackFailure(error, restoreError, rollback.path);
          }
        }
        throw error;
      }
    }
    try {
      if (mode !== undefined) await chmod(tmpPath, mode);
      await rename(tmpPath, filePath);
    } catch (error) {
      if (rollback) {
        try {
          await rollback.restore();
        } catch (restoreError) {
          throw annotateRollbackFailure(error, restoreError, rollback.path);
        }
      }
      throw error;
    }
    // 同上：发布成功后清理暂名失败不改写会话内容，不回滚已完成的写入。
    if (rollback) await rollback.discard().catch(() => {});
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

