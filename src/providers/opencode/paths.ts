import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isMissingPathError } from '../../core/read-text.js';
import { probeSqliteTables, readSqliteFileHead } from '../../core/sqlite-file.js';

export function opencodeDbPath(): string {
  if (process.env.WATCH_OPENCODE_DB) return process.env.WATCH_OPENCODE_DB;
  return path.join(opencodeNativeDataRoot(), 'opencode.db');
}

export function opencodeSessionsRoot(): string {
  return path.dirname(opencodeDbPath());
}

/** Data root used by the real OpenCode CLI; WATCH_OPENCODE_DB is Watch-only. */
export function opencodeNativeDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'opencode');
}

/**
 * 库路径存在但不是普通文件（被同名目录 / 设备文件占住）。
 *
 * 直接交给 SQLite 只会得到 `disk I/O error` / `unable to open database file` 这类原文，
 * 用户看不出要修的是哪个路径，甚至会以为库坏了。
 */
export function opencodeDbNotFileError(dbPath: string): Error {
  return new Error(
    `OpenCode 数据库路径不是普通文件（被同名目录或设备文件占住了）：${dbPath}；无法读取或写入会话，请先恢复该路径再重试`,
  );
}

/** SQLite 原文翻成中文：库打不开 / 不是数据库 / 被占用 / 磁盘错误各说一句，看不出原因时才带原文 */
function describeSqliteFailure(raw: string): string {
  if (/unable to open database file/i.test(raw)) return '库文件打不开（路径不可用、被占住或权限不足）';
  if (/not a database/i.test(raw)) return '库文件不是有效的 SQLite 数据库（可能已损坏或被替换）';
  if (/disk I\/O error/i.test(raw)) return '库文件读写出错（磁盘或文件系统问题）';
  if (/database is locked|^database is busy/i.test(raw)) return '库文件被其它进程占用（正在使用中）';
  if (/no such table/i.test(raw)) return '库结构不完整（缺少预期的表，可能还没被 opencode 正式初始化）';
  return `无法识别的 SQLite 错误：${raw}`;
}

/** 打开 / 查询库失败：SQLite 的错误不带 errno，也不说该修哪个路径 */
export function opencodeDbSqliteError(dbPath: string, action: '打开' | '查询', error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  return new Error(
    `无法${action} OpenCode 数据库 ${dbPath}：${describeSqliteFailure(raw)}——可先关闭占用它的 opencode 进程重试；` +
      '仍不行就备份该文件，让 opencode 重建后再试',
  );
}

/** 一张都没有就可能不是 opencode 的库；只要命中任意必备表就按 opencode 的库处理 */
const OPENCODE_KNOWN_TABLES = ['project', 'session', 'message', 'part'];

/**
 * 往 `opencode.db` 写之前，先确认这个文件是 opencode 的库。
 *
 * SQLite 有两种静默接管，与 `watch.db` 那套守卫同源（见 `core/sqlite-file.ts`）：
 * - 1～99 字节的任意文件被当成空库，`CREATE TABLE` 直接把原内容覆盖掉；
 * - 别人的 SQLite 库（只有 bookmarks 之类）会被 `ensureMinimalSchema` 就地建出四张表，
 *   对方的库结构就此被改（实测 `bookmarks` 行还在，但多了 project / session / message / part）。
 * 两种以前都是「转入成功」静默完成。这里只读文件头，不打开 SQLite、不产生 -wal / -shm。
 */
export function assertUsableOpencodeDb(dbPath: string): void {
  const head = readSqliteFileHead(dbPath);
  // 没有库 / 目录 / 设备文件：交给 DatabaseSync 与既有中文说明
  if (head.kind !== 'file' || head.size === 0) return;

  if (!head.hasMagic) {
    throw new Error(
      `OpenCode 数据库路径上已有一个不是有效的 SQLite 数据库的文件：${dbPath}（${head.size} 字节）。为避免把它覆盖成 opencode 的库，本次未写入任何内容；请先备份并挪走这个文件，或改用另一个 WATCH_OPENCODE_DB`,
    );
  }
  // 刚初始化、还没有任何表的库接管不破坏数据（opencode 首次运行前也可能长这样）
  if (head.pageCount === 0) return;

  const probe = probeSqliteTables(dbPath);
  if ('error' in probe) {
    throw new Error(
      `无法确认 OpenCode 数据库是不是 opencode 的库（表结构读不出来）：${dbPath}；` +
        `本次未写入任何内容——可先关闭占用它的 opencode 进程再重试，仍不行就确认该文件是否可读`,
    );
  }
  if (probe.tables.length === 0) return;
  if (probe.tables.some((t) => OPENCODE_KNOWN_TABLES.includes(t))) return;

  throw new Error(
    `OpenCode 数据库路径上已有一个不是 opencode 的 SQLite 数据库：${dbPath}（表: ${probe.tables.slice(0, 5).join(' / ')}）。` +
      `为避免把 opencode 的表写进别人的库，本次未写入任何内容；请改用另一个 WATCH_OPENCODE_DB；` +
      `如果这其实是 opencode 的库损坏了，先备份，再挪走它让 opencode 重建`,
  );
}

/**
 * 打开数据库前先确认路径：`missing` 交给调用方按各自语义处理（没有库 / 没有会话），
 * `file` 才继续打开。路径被占住、`stat` 读不出来都抛中文错误，不把「无法判定」留到
 * SQLite 层变成一句英文原文。
 */
export async function probeOpencodeDbFile(dbPath: string): Promise<'missing' | 'file'> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dbPath);
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`无法确认 OpenCode 数据库路径能否使用：无权限访问（权限问题，不是路径写错）：${dbPath}`);
    }
    throw new Error(
      `无法确认 OpenCode 数据库路径能否使用：读取路径状态失败（${code ?? (error instanceof Error ? error.message : String(error))}）：${dbPath}`,
    );
  }
  if (!info.isFile()) throw opencodeDbNotFileError(dbPath);
  return 'file';
}
