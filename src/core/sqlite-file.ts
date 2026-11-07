import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * 判断「这个路径上已有的文件是不是我们能接管的 SQLite 库」的公共只读工具。
 *
 * 两处需要它：`core/store.ts` 打开 `watch.db` 之前，`providers/opencode` 往 `opencode.db`
 * 写之前。SQLite 有两种静默接管：不足 100 字节的文件被当成空库直接覆盖，别人的库会被
 * 就地建表 / 改 `user_version`。两者都必须先只看文件头再决定，不能靠 try 打开。
 */

export const SQLITE_MAGIC = 'SQLite format 3\0';

export type SqliteFileHead =
  /** 路径不存在 / 读不出状态：交给 `DatabaseSync` 按既有中文说明报，不在这里抢答 */
  | { kind: 'absent' }
  /** 目录 / 设备文件：同样交给 `DatabaseSync` 报「打不开」 */
  | { kind: 'not-file' }
  | { kind: 'file'; size: number; hasMagic: boolean; userVersion: number; pageCount: number };

/**
 * 只读文件头 100 字节，不打开 SQLite、不产生 `-shm` / `-wal`。
 *
 * `user_version` 在偏移 60、页数在偏移 28，都是大端。
 */
export function readSqliteFileHead(filePath: string): SqliteFileHead {
  let size: number;
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return { kind: 'not-file' };
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return { kind: 'absent' };
    throw error;
  }
  if (size === 0) return { kind: 'file', size, hasMagic: false, userVersion: 0, pageCount: 0 };

  const head = Buffer.alloc(100);
  const fd = openSync(filePath, 'r');
  let read = 0;
  try {
    read = readSync(fd, head, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  return {
    kind: 'file',
    size,
    hasMagic: read === 100 && head.toString('latin1', 0, 16) === SQLITE_MAGIC,
    userVersion: read === 100 ? head.readUInt32BE(60) : 0,
    pageCount: read === 100 ? head.readUInt32BE(28) : 0,
  };
}

/**
 * 只读列出库里的表名（不含 `sqlite_*`）。
 *
 * WAL 模式的库被只读打开时会顺带生成空的 `-shm` / `-wal`，所以只删掉「探之前不存在、
 * 由这次探测生成」的那两个，不在别人的目录里留垃圾。探不出来时把错误交给调用方判断——
 * 「读不出来」不等于「这不是我们的库」。
 */
export function probeSqliteTables(filePath: string): { tables: string[] } | { error: unknown } {
  const companions = [`${filePath}-shm`, `${filePath}-wal`];
  const preexisting = new Set(companions.filter((p) => existsSync(p)));
  try {
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      return { tables: rows.map((r) => r.name) };
    } finally {
      db.close();
    }
  } catch (error) {
    return { error };
  } finally {
    for (const p of companions) {
      if (preexisting.has(p)) continue;
      try {
        unlinkSync(p);
      } catch {
        // 没生成就没什么可删；删不掉也不该盖住本次要报的错
      }
    }
  }
}
