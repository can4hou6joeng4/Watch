import { homedir } from 'node:os';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describeWriteFailureReason } from '../../core/atomic.js';
import { isMissingPathError } from '../../core/read-text.js';
import { probeSqliteTables, readSqliteFileHead } from '../../core/sqlite-file.js';
import { escapeControlChars } from '../../core/display.js';

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
    `OpenCode 数据库路径不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(dbPath)}；无法读取或写入会话，请先恢复该路径再重试`,
  );
}

/**
 * SQLite 原文翻成中文，并各给一步对应的处置。
 *
 * 以前所有打开失败都接同一句「可先关闭占用它的 opencode 进程重试；仍不行就备份该文件」——
 * 只有「被占用」那一档适用。`unable to open database file` 在全新机器上其实是**上级目录
 * 还不存在**（写入路径现在会先建目录，读到这一句多半是目录不可写或路径被占住），让人去关
 * 一个没运行的进程、再备份一个不存在的文件，是两步都错的指引。
 */
function describeSqliteFailure(raw: string): { reason: string; hint: string } {
  if (/unable to open database file/i.test(raw)) {
    return {
      reason: '库文件打不开（路径不可用、被占住或权限不足）',
      hint: '先确认该路径的目录存在且可写、没有被同名目录或设备文件占住',
    };
  }
  if (/not a database/i.test(raw)) {
    return {
      reason: '库文件不是有效的 SQLite 数据库（可能已损坏或被替换）',
      hint: '备份该文件后挪走它，让 opencode 重建后再试',
    };
  }
  if (/disk I\/O error/i.test(raw)) {
    return { reason: '库文件读写出错（磁盘或文件系统问题）', hint: '先确认磁盘可用、文件系统没有只读挂载，再重试' };
  }
  if (/database is locked|^database is busy/i.test(raw)) {
    return { reason: '库文件被其它进程占用（正在使用中）', hint: '等占用它的进程结束或先关闭它，再重试' };
  }
  if (/no such table/i.test(raw)) {
    return {
      reason: '库结构不完整（缺少预期的表，可能还没被 opencode 正式初始化）',
      hint: '先用 opencode 正常打开一次该目录，让它把库结构迁移完',
    };
  }
  return { reason: `无法识别的 SQLite 错误：${raw}`, hint: '确认该库文件是否可读，必要时先备份再让 opencode 重建' };
}

/** 打开 / 查询库失败：SQLite 的错误不带 errno，也不说该修哪个路径 */
export function opencodeDbSqliteError(dbPath: string, action: '打开' | '查询', error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const { reason, hint } = describeSqliteFailure(raw);
  return new Error(`无法${action} OpenCode 数据库 ${escapeControlChars(dbPath)}：${reason}——${hint}`);
}

/** 一张都没有就可能不是 opencode 的库；只要命中任意必备表就按 opencode 的库处理 */
const OPENCODE_KNOWN_TABLES = ['project', 'session', 'message', 'part'];

/**
 * OpenCode 2.x 的库布局：`session_v2` + `session_message`（事件日志表）。
 *
 * 依据是第三方会话转换器 cross_agent_session_resumer 的实测记录：它按 sqlite_master
 * 分三档识别，并明确 2.x 的 `session_v2` / `session_message` 是 opencode 自己事件日志的
 * 投影，转换器只读不写。1.x → 2.x 迁移过的库会**同时留着**旧的 session / message / part
 * 表，那些是过时副本，opencode 自己不再读。
 *
 * Watch 的写在 1.x 布局（session / message / part）上验证过，所以写路径看到 2.x 标记必须拒绝
 * ——否则要么把表建进一个 2.x 库（污染），要么写进旧的 1.x 副本（opencode 读不到，却报「转入成功」）。
 *
 * 读路径从 2026-11-11 起支持 2.x，依据仍是该转换器的实测 schema（`session_v2` 带
 * slug / directory / title / time_created / time_updated，`session_message` 带
 * type / seq / time_created / data）。它是第三方记录的 beta 布局、本机没有原生样本，
 * 所以解析只认转换器 fixture 里出现过的 `type`，其余类型原样跳过并把条数写进内容，
 * 不猜含义——见 `parse.ts` 的 `parseOpencodeV2Turns()`。
 */
const OPENCODE_V2_TABLES = ['session_v2', 'session_message'];

function opencodeV2Marker(tables: string[]): string | null {
  const hit = tables.filter((t) => OPENCODE_V2_TABLES.includes(t));
  return hit.length ? hit.join(' / ') : null;
}

/**
 * 读路径（列表 / 反查 / 解析）先判库布局：`v2` 走 `session_v2` + `session_message`，
 * 其余按 1.x 的 `session` / `message` / `part` 处理。
 *
 * 打不开 / 表结构读不出来时一律返回 `v1`：不在这里抢答，交给调用方原有的
 * `opencodeDbSqliteError` 说清（同一个库不该在两条错误路径上给出两种说法）。
 *
 * 迁移过的库同时留着旧 1.x 表，但那是 opencode 自己不再读的过时副本——只要出现 2.x
 * 标记就必须读新表，否则会读到一份「看起来有、实际已经不再更新」的历史。
 */
export type OpencodeLayout = 'v1' | 'v2';

export function detectOpencodeLayout(dbPath: string): OpencodeLayout {
  const probe = probeSqliteTables(dbPath);
  if ('error' in probe) return 'v1';
  return opencodeV2Marker(probe.tables) ? 'v2' : 'v1';
}

/**
 * 写入前准备数据目录：不存在就建，存在就确认可写。
 *
 * `~/.local/share/opencode/` 在从没跑过 opencode 的机器上根本不存在，而 SQLite 只会报
 * `unable to open database file`——旧文案把它解释成「路径被占住或权限不足…先关闭占用它的
 * opencode 进程」，可真正的原因是**上级目录还没建**，用户会跑去关一个根本没运行的进程。
 * 目录存在但不可写时同样是这一句，也同样给不出下一步。
 *
 * 这与 `Store` 构造函数里的 `mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })`
 * 对齐：库该不该存在由调用方判定，目录由我们建；建不出来 / 不可写时这里就带 errno 说清，
 * 不让 SQLite 把文件系统问题揉成一句英文。
 */
export function ensureOpencodeDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    // 0700 与 ~/.watch 一致：这里放的是会话内容，不需要给同机其它用户读
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 目录早就在、只是不可写时 mkdirSync 是空操作，得单独探一次，否则要等到 SQLite 才失败
    accessSync(dir, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // `mkdirSync(recursive)` 撞上「某一级是普通文件」报的是 EEXIST，不是 ENOTDIR；
    // 落到下面的通用分支会变成「写入失败（EEXIST）」，看不出该挪走什么
    if (code === 'EEXIST') {
      throw new Error(
        `无法使用 OpenCode 数据目录：${escapeControlChars(dir)}——路径上的某一级是已存在的文件（不是目录）；` +
          `本次未写入任何内容，先挪走占住它的文件再重试`,
      );
    }
    const reason = describeWriteFailureReason(error);
    if (!reason) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(`无法使用 OpenCode 数据目录：${escapeControlChars(dir)}（${raw}）；本次未写入任何内容`);
    }
    // describeWriteFailureReason 的几条里只有部分带了「本次未写入」，补齐一次别再重复
    throw new Error(
      `无法使用 OpenCode 数据目录——${reason}${reason.includes('本次未写入') ? '' : '；本次未写入任何内容'}`,
    );
  }
}

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
      `OpenCode 数据库路径上已有一个不是有效的 SQLite 数据库的文件：${escapeControlChars(dbPath)}（${head.size} 字节）。为避免把它覆盖成 opencode 的库，本次未写入任何内容；请先备份并挪走这个文件，或改用另一个 WATCH_OPENCODE_DB`,
    );
  }
  // 刚初始化、还没有任何表的库接管不破坏数据（opencode 首次运行前也可能长这样）
  if (head.pageCount === 0) return;

  const probe = probeSqliteTables(dbPath);
  if ('error' in probe) {
    throw new Error(
      `无法确认 OpenCode 数据库是不是 opencode 的库（表结构读不出来）：${escapeControlChars(dbPath)}；` +
        `本次未写入任何内容——先确认该文件可读、并关掉可能占用它的 opencode 进程，再重试`,
    );
  }
  if (probe.tables.length === 0) return;
  // 2.x 先判：「迁移过的库同时还留着旧表」时，旧表能通过下面的已知表检查，写进去 opencode
  // 却读不到——那会变成一次静默失败的交接。所以只要出现 2.x 标记就拒绝，不管旧表在不在。
  const v2 = opencodeV2Marker(probe.tables);
  if (v2) {
    throw new Error(
      `OpenCode 数据库是 2.x 结构（表: ${v2}）：${escapeControlChars(dbPath)}；` +
        `Watch 的写入只在 1.x 布局（session / message / part）上验证过，本次未写入任何内容。` +
        `迁移过来的库可能还留着旧的 1.x 表，那是过时副本，写进去 opencode 也不会读到——` +
        `不要删除或挪走这个库；可以把 WATCH_OPENCODE_DB 指向一个 1.x 布局的库，或等 Watch 支持 2.x 后再试`,
    );
  }
  if (probe.tables.some((t) => OPENCODE_KNOWN_TABLES.includes(t))) return;

  throw new Error(
    `OpenCode 数据库路径上已有一个不是 opencode 的 SQLite 数据库：${escapeControlChars(dbPath)}（表: ${probe.tables.slice(0, 5).join(' / ')}）。` +
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
      throw new Error(`无法确认 OpenCode 数据库路径能否使用：无权限访问（权限问题，不是路径写错）：${escapeControlChars(dbPath)}`);
    }
    throw new Error(
      `无法确认 OpenCode 数据库路径能否使用：读取路径状态失败（${code ?? (error instanceof Error ? error.message : String(error))}）：${escapeControlChars(dbPath)}`,
    );
  }
  if (!info.isFile()) throw opencodeDbNotFileError(dbPath);
  return 'file';
}
