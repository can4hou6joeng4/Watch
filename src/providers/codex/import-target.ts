import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { describeWriteFailureReason, digestFile, type FileDigest } from '../../core/atomic.js';
import { describePathReadFailureReason, isFileSystemErrorCode, isMissingPathError } from '../../core/read-text.js';
import { escapeControlChars } from '../../core/display.js';

export type ImportTarget = {
  policy: 'official-api-target-v1';
  path: string;
  device: string;
  inode: string;
  config: FileDigest | null;
};

export const IMPORT_TARGET_LOCK = '.watch-official-import.lock';

// 这条路径上全是写操作（要建导入日志、拿目标锁、让 Codex 写原生线程），所以每一处路径失败都要
// 说清「本次未写入任何内容」，并按 errno 分档：不存在 / 读不出来 / 不是普通文件 / 写不进去的
// 下一步完全不同。以前这些 `realpath` / `lstat` / `open` 都是裸调用，`<CODEX_HOME>` 不存在这台
// 常见状态（还没运行过 Codex）会直接把英文原文抛给桌面卡片：
//   2026-11-09 实测：{"ok":false,"error":"ENOENT: no such file or directory, realpath '…/home/.codex'"}
function missingTargetDirectory(directory: string): Error {
  return new Error(
    `Codex 数据目录不存在：${escapeControlChars(directory)}（这台机器可能还没运行过 Codex，数据目录尚未创建）；` +
      '先启动一次 Codex 让它建出该目录，或用 CODEX_HOME 指向已有的数据目录后重试——本次未写入任何内容',
  );
}

function unreadableTargetDirectory(directory: string, error: unknown): Error {
  return new Error(
    `无法读取 Codex 数据目录 ${escapeControlChars(directory)}：${describePathReadFailureReason(error)}；` +
      '先确认该目录可访问（权限、路径）再重试——本次未写入任何内容',
  );
}

/** 规范化并 stat 目标目录。两次文件系统调用分开守卫：`realpath` 会先撞「不存在」，`lstat` 则可能刚被删。 */
async function inspectTargetDirectory(directory: string): Promise<{ canonical: string; info: BigIntStats }> {
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    throw isMissingPathError(error) ? missingTargetDirectory(directory) : unreadableTargetDirectory(directory, error);
  }
  try {
    return { canonical, info: await lstat(canonical, { bigint: true }) };
  } catch (error) {
    throw isMissingPathError(error) ? missingTargetDirectory(directory) : unreadableTargetDirectory(directory, error);
  }
}

export async function inspectImportTarget(directory: string): Promise<ImportTarget> {
  if (!path.isAbsolute(directory)) throw new Error(`Codex 数据目录必须是绝对路径：${escapeControlChars(directory)}`);
  const { canonical, info } = await inspectTargetDirectory(directory);
  if (!info.isDirectory()) {
    throw new Error(
      `Codex 数据目标必须是目录：${escapeControlChars(canonical)}（该路径现在不是目录，可能被同名文件或设备文件占住了）；` +
        '先恢复该路径再重试——本次未写入任何内容',
    );
  }
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
    // 只有 ENOENT 才是「还没有配置」（Codex 首次运行才写）：不能拿 `isMissingPathError()` 放行，
    // 那样 ENOTDIR 会被当成「没有配置」，TOCTOU 指纹悄悄少一项
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      config = null;
    } else if (isFileSystemErrorCode(code)) {
      throw new Error(
        `无法读取 Codex 配置 ${escapeControlChars(configFile)}：${describePathReadFailureReason(error)}；` +
          '先修好这个文件（权限、路径）再重试——本次未写入任何内容',
      );
    } else {
      // 「必须是普通文件」「无法计算指纹」这类是自己写好的中文说明，原样带出
      throw error;
    }
  }
  return { policy: 'official-api-target-v1', path: canonical, device: info.dev.toString(), inode: info.ino.toString(), config };
}

export async function assertImportTarget(directory: string, expected: ImportTarget): Promise<void> {
  const current = await inspectImportTarget(directory);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Codex 目标目录或配置在预览之后已变化');
}

export async function assertTargetFile(target: ImportTarget, file: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error(`原生线程路径必须是绝对路径：${escapeControlChars(file)}`);
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `原生线程路径已不存在：${escapeControlChars(file)}（导入结果里给出的路径现在找不到了，可能刚被移动或删除）；` +
          '先确认 Codex 数据目录里这份线程是否还在，再决定是否重新导入——本次未写入任何内容',
      );
    }
    throw new Error(
      `无法读取原生线程路径 ${escapeControlChars(file)}：${describePathReadFailureReason(error)}；` +
        '先确认该路径可访问再重试——本次未写入任何内容',
    );
  }
  const relative = path.relative(target.path, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `原生线程路径不在已确认的 Codex 数据目录内：${escapeControlChars(resolved)}（已确认的目录是 ${escapeControlChars(target.path)}）；` +
        '这次导入不会写到别处——本次未写入任何内容',
    );
  }
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `原生线程路径已不存在：${escapeControlChars(resolved)}（导入结果里给出的路径现在找不到了，可能刚被移动或删除）；本次未写入任何内容`,
      );
    }
    throw new Error(
      `无法读取原生线程路径 ${escapeControlChars(resolved)}：${describePathReadFailureReason(error)}；` +
        '先确认该路径可访问再重试——本次未写入任何内容',
    );
  }
  if (!info.isFile()) {
    throw new Error(
      `原生线程路径现在不是普通文件：${escapeControlChars(resolved)}（可能被同名目录或设备文件占住了）；` +
        '先恢复该路径再重试——本次未写入任何内容',
    );
  }
}

/**
 * Codex 配置里的 `sqlite_home` 必须就是已确认的目标目录。
 *
 * 这条判定的结论是「两者是同一个目录」。`realpath` 一旦抛错（目录被删、没权限、路径被同名文件
 * 占住），结论根本无从成立：`ENOENT` 既不能证明一致，也不能证明不一致。以前它是裸调用，英文原文
 * 直接冒到 `confirm`——而这一步在 `jobs.claim()` **之前**，`claimed` 还是 false，`catch` 里
 * `if (!claimed) throw error` 会把 Node 原文放进 `{ ok:false, error }` 与桌面卡片：
 *   2026-11-09 实测：{"ok":false,"error":"ENOENT: no such file or directory, realpath '…/gone-sqlite'"}
 *
 * `next` 由调用点按阶段给：还没 claim 时可以说「；未提交导入」，已 claim 之后（`project-binding`
 * 那次读后复核）不能这么说——那时写入可能已经发生。
 */
export async function assertNativeSqliteHome(
  config: Record<string, unknown>,
  target: ImportTarget,
  next = '',
): Promise<void> {
  const home = config.sqlite_home;
  if (home == null) return;
  const mismatch = () => new Error(`原生 SQLite 目录与确认的目标不一致，需要额外验证${next}`);
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw mismatch();
  let canonical: string;
  try {
    canonical = await realpath(home);
  } catch (error) {
    throw new Error(
      `无法确认原生 SQLite 目录 ${escapeControlChars(home)}：${describePathReadFailureReason(error)}；` +
        'Codex 的配置声明它用这个目录存会话，但读不到它，所以无法判断它是否就是本次导入的目标——' +
        `先恢复该目录（或修正 Codex 配置里的 sqlite_home）再重试${next}`,
    );
  }
  if (canonical !== target.path) throw mismatch();
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
    // 拿不到锁就是没写进去：这里不能说「本次未写入任何内容」——难说，但锁本身就是写操作的一部分，
    // 只有 `open` 失败才保证什么都没建立，所以给下一步而不是给「未写入」的承诺
    const reason = describeWriteFailureReason(error);
    if (reason) throw new Error(`无法在 Codex 数据目录里创建导入锁 ${escapeControlChars(file)}：${reason}`);
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
      let current;
      try {
        current = await lstat(file, { bigint: true });
      } catch (error) {
        // 「读不出来」与「已经不存在」在结论上没区别：都不能确认这把锁还是我们持有的那把
        if (isMissingPathError(error)) throw new Error('导入锁已被改变，需要人工复核：锁文件已不存在（可能被外部删除或被替换）');
        throw new Error(`导入锁已被改变，需要人工复核：无法读取锁文件 ${escapeControlChars(file)}（${describePathReadFailureReason(error)}）`);
      }
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('导入锁已被改变，需要人工复核');
      }
      await unlink(file);
    },
  };
}
