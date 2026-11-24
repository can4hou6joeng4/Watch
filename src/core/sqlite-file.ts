import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { clipCodePoints, escapeControlChars } from './display.js';

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

/** 表名清单在错误文案里最多列几个、每个多长（表名来自别人的库，长度与字符集都不受我们控制） */
const SHOWN_TABLE_NAMES = 5;
const SHOWN_TABLE_NAME_CHARS = 40;

/**
 * 把 `sqlite_master` 里的表名渲染成错误文案里的一小段。
 *
 * 表名来自**别人的** SQLite 库：可以是任意文本（含 ESC / C1 / 极长的名字），条数也没有上限。
 * 以前两处调用点各自 `tables.slice(0, 5).join(...)`——`store.ts` 逐项转义了但没有截断，
 * `opencode/paths.ts` 连转义都没有，一句「表: …」就能把控制字符带进终端、或把警告撑成巨串。
 * 先按原文码点截断、再转义（反过来会把 `\u001B` 切成半截序列），条数超出的写「另有 N 个」。
 */
export function describeSqliteTableNames(tables: readonly unknown[]): string {
  if (!tables.length) return '（没有任何表）';
  // 非字符串不走 `String()`：那会调用对象自己的 toString，表名清单不值得为它冒一次抛错
  const names = tables.map((t) => (typeof t === 'string' ? t : '（非文本表名）'));
  const shown = names
    .slice(0, SHOWN_TABLE_NAMES)
    .map((name) => escapeControlChars(clipCodePoints(name, SHOWN_TABLE_NAME_CHARS).text));
  const rest = names.length - shown.length;
  return shown.join(' / ') + (rest > 0 ? ` / 另有 ${rest} 个` : '');
}
