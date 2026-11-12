import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { cwdControlCharsNote, sameDirectorySync } from './cwd.js';
import { escapeControlChars } from './display.js';
import { normalizePath } from './platform.js';
import { probeSqliteTables, readSqliteFileHead } from './sqlite-file.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from './types.js';

/**
 * 链上一条绑定都没有时的下一步（`usage` / `sessions --chain` / `describeChainIdMisuse` 共用）。
 *
 * 这里**不能**把 `watch switch` 与 `adopt` 并列成「都能绑定」：空链上 `switch`
 * 只在同目录还有**另一家**的会话时才 `recordSwitch`；目录里只有一家时它走
 * `alreadyAtTarget` 分支，自己都印「本次未写入链记录」，链仍然空着——用户照
 * 「先用 watch switch 绑定」执行完，再查 `sessions --chain` 还是同一句空链提示
 * （2026-11-08 实测）。无条件能写入绑定的只有 `adopt`，所以先给 adopt，并把
 * switch 的前提写出来。
 *
 * 定义在 `store.ts` 而不是 `handoff.ts`：`describeChainIdMisuse()` 也要用，而
 * `handoff.ts` 已经 import 了 `store.ts`，反向依赖会成环。`handoff.ts` 原样再导出。
 */
export function emptyChainBindHint(): string {
  return (
    '用 watch adopt <provider> --session <会话 id> 把一个已有会话接进这条链（会直接写入链尾）；' +
    'watch switch 只有在同目录还有另一家的会话时才会写入绑定'
  );
}

/** 一个「链在别处」的目录。`sameDirectory` 只在它其实是**同一个目录的另一种写法**时出现（见 `splitElsewhereByDirectory`）。 */
export type ChainsElsewhere = {
  cwd: string;
  total: number;
  active: number;
  lastUsedAt: number;
  sameDirectory?: boolean;
};

/**
 * 本目录没有链、本地库里却有别的目录的链时的下一步（`chain list` / `status` 共用）。
 *
 * 链按 cwd 精确分组，可「本目录没有链」与「一条链都没建过」原本长得一模一样：
 * 2026-11-08 实测在 `a/` 建了链、在 `b/` 里查，`watch chain list` 只回一句「（无链）」、
 * `status` 的结尾只印「切换链: （空）」，`--json` 里也没有任何线索——两句都是**结论**，
 * 用户会以为链丢了或没建成功，而它一直躺在库里，只是 `--cwd` 指错了目录。
 * `missingChainMessage()` 早就为「`--chain x` 在别的目录」指过路，可**不带 `--chain`**
 * 的这两条才是最常走的入口。
 *
 * 与 `emptyChainBindHint()` 同理定义在 `store.ts`：调用方只有 CLI 两处，但文案里的
 * 目录清单要跟 `ChainsElsewhere` 的结构绑在一起。
 */
export function chainsElsewhereHint(rows: ChainsElsewhere[]): string {
  const shown = rows
    .slice(0, 3)
    .map((r) => `${escapeControlChars(r.cwd)}（${r.total} 条${r.active ? `，${r.active} 条活跃` : ''}）`)
    .join('、');
  const more = rows.length > 3 ? ` 等 ${rows.length} 个目录` : '';
  return (
    `本目录没有链，但本地库里还有属于其它目录的链（链按目录分组，--cwd 不同就一条都看不到）：${shown}${more}；` +
    '要查看用 watch chain list --cwd <那个目录>，或在本目录用 watch chain new <名字> 建一条'
  );
}

/**
 * 「别处的链」里其实有**同一个目录的另一种写法**（软链、`/var` 与 `/private/var` 这类前缀、大小写）。
 *
 * 这一档不能说成「属于其它目录」：链就在这个目录里，只是按原生记录的那个字符串才查得到。
 * 下一步取记录里的**原写法**（不是 realpath）——链按 `--cwd` 精确匹配，换成 realpath 照样一条都看不到。
 */
export function chainsSameDirectoryHint(rows: ChainsElsewhere[]): string {
  const shown = rows
    .slice(0, 3)
    .map((r) => `${escapeControlChars(r.cwd)}（${r.total} 条${r.active ? `，${r.active} 条活跃` : ''}）`)
    .join('、');
  const more = rows.length > 3 ? ` 等 ${rows.length} 个写法` : '';
  const target = rows[0]!.cwd;
  const typed = escapeControlChars(target);
  return (
    `本目录没有链，但本地库里同一个目录的另一种写法下有链（链按 --cwd 精确匹配，写法不同就一条都看不到）：${shown}${more}；` +
    `把 --cwd 换成 ${typed} 重跑同一条命令（其余参数照旧），或用 watch chain list --cwd ${typed} 查看` +
    cwdControlCharsNote(target)
  );
}


const SCHEMA_VERSION = 7;
const REQUIRED_TABLES = ['sessions', 'turns', 'switch_events', 'turn_events', 'chains', 'messages_fts', 'search_index'] as const;
const FTS_TEXT_LIMIT = 8192;
/** 搜索返回的命中上限；单个会话最多占 MAX_PER_SESSION 条，避免一场对话淹没其它会话 */
const MAX_HITS = 40;
/** 命中数撞到 MAX_HITS 只说明「至少这么多」：调用方据此披露结果被截断 */
export const SEARCH_MAX_HITS = MAX_HITS;
const MAX_PER_SESSION = 3;
/** SQL 先多取一些再按会话截断，否则 LIMIT 会在截断前就把其它会话切掉 */
const SCAN_LIMIT = 200;
/** 候选扫描上限；`candidatesSaturated` 披露的正是这个数字（CLI 提示文案直接引用） */
export const SEARCH_SCAN_LIMIT = SCAN_LIMIT;

export type SearchHit = {
  sessionId: string;
  provider: string;
  cwd: string;
  filePath: string;
  snippet: string;
};

export type SearchElsewhere = { cwd: string; hits: number };

/**
 * 本目录零命中、索引里别的目录有匹配时的下一步（`search` 共用）。
 *
 * 与 `chainsElsewhereHint()` 同一位置、同一思路：文案跟结构绑在一起，调用点只负责打印。
 */
export function searchElsewhereHint(rows: SearchElsewhere[], cwd: string, query: string): string {
  const shown = rows
    .slice(0, 3)
    .map((r) => `${escapeControlChars(r.cwd)}（${r.hits} 条）`)
    .join('、');
  const more = rows.length > 3 ? ` 等 ${rows.length} 个目录` : '';
  return (
    `本地搜索索引里其它目录有匹配：${shown}${more}；` +
    `搜索按目录限定（--cwd ${escapeControlChars(cwd)} 只查这一条），要看那个目录里的命中，用 watch search ${escapeControlChars(query)} --cwd <那个目录>`
  );
}

/**
 * 零命中的那一份里其实有**同一个目录的另一种写法**（软链、`/var` 与 `/private/var` 这类前缀、大小写）。
 *
 * 与 `chainsSameDirectoryHint()` 同一档：说成「其它目录」是错的，而 `cwdAliasHint()` 给的 realpath
 * 也未必是索引里记录的那个写法——这里用索引行自己的 `cwd` 作为下一步，能直接照抄。
 */
export function searchSameDirectoryHint(rows: SearchElsewhere[], cwd: string, query: string): string {
  const shown = rows
    .slice(0, 3)
    .map((r) => `${escapeControlChars(r.cwd)}（${r.hits} 条）`)
    .join('、');
  const more = rows.length > 3 ? ` 等 ${rows.length} 个写法` : '';
  const target = rows[0]!.cwd;
  const typed = escapeControlChars(target);
  return (
    `本地搜索索引里，同一个目录的另一种写法下有匹配：${shown}${more}；` +
    `搜索按 --cwd 精确匹配（${escapeControlChars(cwd)} 一条都查不到），把 --cwd 换成 ${typed} 重跑：watch search ${escapeControlChars(query)} --cwd ${typed}` +
    cwdControlCharsNote(target)
  );
}

/** 搜索结果 + 三种硬上限是否真的截掉了命中（逐项独立，不能互相冒充） */
export type SearchResult = {
  hits: SearchHit[];
  /** 全局 40 条上限截掉了命中 */
  truncated: boolean;
  /** 某会话命中超过 3 条、只保留前 3 条 */
  perSessionCapped: boolean;
  /** 查询像 session id 时，前缀命中触碰 LIMIT 10 */
  idPrefixCapped: boolean;
  /**
   * 候选集撞上 `SCAN_LIMIT` 且**其它会话的命中进不来**（一个话多的会话占满了候选）。
   *
   * `truncated` 只说明「按结果上限截掉了」，`perSessionCapped` 只说「某个会话超过 3 条」——
   * 两种都不覆盖这一档：FTS 只取前 200 行，某个索引了很多工具输出的会话可以全部占满，
   * 另一个只有一条命中的会话根本没被看到；而最终 hits 只有 3 条、两个标志都是 false，
   * 输出看着像「就这些」。一旦候选饱和，就必须告诉调用方结果不完整。
   */
  candidatesSaturated?: boolean;
};

export type Chain = {
  id: string;
  cwd: string;
  name: string;
  status: 'active' | 'archived';
  lastUsedAt: number;
  createdAt: number;
};

export type SessionLocation = {
  provider: string;
  sessionId: string;
  cwd: string;
  filePath: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
};

export type StoredSession = {
  id: string;
  title: string;
  cwd: string;
  provider: string | null;
  ref: SessionRef | null;
  nextSeq: number;
};

export type SwitchRecord = {
  id: string;
  sessionId: string;
  fromProvider: string | null;
  toProvider: string;
  fromRef: SessionRef | null;
  toRef: SessionRef;
  createdAt: number;
  schemaVersion?: string;
};

export const CHAIN_SESSION_TITLE = 'tui-chain';

export const defaultDbPath = (): string => join(homedir(), '.watch', 'watch.db');

/**
 * 本地库相关失败的原因（不带路径与下一步）：SQLite 与文件系统的原文既不说该修哪个路径，
 * 也不说下一步。打开失败用 `describeStoreOpenFailure()`，查询 / 读写失败单独拼上下文用这个。
 */
export function describeStoreErrorReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return '无权访问库文件或其所在目录（权限问题，不是路径写错）';
  if (code === 'ENOTDIR') return '库路径上的某一级不是目录（被同名文件占住了）';
  if (code === 'EEXIST') return '库路径上的某一级是已存在的文件（不是目录）';
  if (code === 'EISDIR') return '库路径是一个目录，不是文件';
  const raw = error instanceof Error ? error.message : String(error);
  if (/unable to open database file/i.test(raw)) return '库文件打不开（路径不可用、被同名目录占住或权限不足）';
  if (/not a database|malformed/i.test(raw)) return '库文件不是有效的 SQLite 数据库（可能已损坏或被替换）';
  if (/disk I\/O error/i.test(raw)) return '库文件读写出错（磁盘或文件系统问题）';
  // schema 被外部改动 / 迁移只做了一半：表还在（REQUIRED_TABLES 只查表名）但列没了，查询时才炸。
  // 原文是 `no such column: session_id`，既不说是库的问题也不说下一步
  if (/no such table|no such column|has no column named/i.test(raw)) {
    return '库结构不完整（缺少表或列，可能只迁移了一半或被外部改动过）';
  }
  if (/database is locked|database is busy|SQLITE_BUSY/i.test(raw)) return '库文件被其它进程占用（另一个 watch 正在使用）';
  // 打开前的文件头检查自己抛的三句（已是完整中文说明），原样带出
  if (/^本地库路径上已有一个/.test(raw)) return raw;
  // 已是完整的中文说明（含两个版本号），原样带出，别降级成「库操作失败（…）」
  if (/本地库 schema 版本 \d+ 比本程序支持的 \d+ 更新/.test(raw)) return raw;
  return `库操作失败（${code ?? raw}）`;
}

/**
 * 这个错误是不是**本地库读写失败**（而不是业务结论）。
 *
 * 命令级 `catch` 里两者混在一个 `error.message` 上：SQLite 的
 * `no such column: last_used_at` 既不说这是库的问题，也不给下一步，而
 * 「链已归档」「未发现原生会话」这类已经是写好的中文结论，翻译反而会破坏它。
 * 判定只看 SQLite 自己的错误码与几句话——`describeStoreErrorReason()` 认得的那些。
 */
export function isStoreError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^ERR_SQLITE_|^SQLITE_/.test(code)) return true;
  const raw = error instanceof Error ? error.message : String(error);
  return /no such table|no such column|has no column named|not a database|malformed|disk I\/O error|unable to open database file|database is (locked|busy)/i.test(
    raw,
  );
}

/**
 * 打开本地库失败的说明：带路径、原因与下一步。
 *
 * 这些字符串会原样进 `chain` / `search` 的 `{ ok:false, error }`、stderr 的降级提示与
 * `watch doctor` 的「本地库: 不可用（…）」，所以先翻成中文再抛给上层。
 */
export function describeStoreOpenFailure(dbPath: string, error: unknown): string {
  const reason = describeStoreErrorReason(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return `${reason}：${escapeControlChars(dbPath)}；先确认 ${escapeControlChars(dirname(dbPath))} 可写，再重试`;
  if (code === 'ENOTDIR') return `${reason}：${escapeControlChars(dbPath)}；先删掉占用它的文件再重试`;
  if (code === 'EEXIST') return `${reason}：${escapeControlChars(dbPath)}；先删掉或挪走占住它的文件，让 watch 重建目录与库`;
  if (code === 'EISDIR') return `${reason}：${escapeControlChars(dbPath)}；先把它挪走，让 watch 重新建库`;
  const raw = error instanceof Error ? error.message : String(error);
  // 打开前文件头检查的两句已带路径与下一步，再拼一次路径就是同一件事说两遍
  if (/^本地库路径上已有一个/.test(raw)) return raw;
  if (/not a database|malformed/i.test(raw)) {
    return `${reason}：${escapeControlChars(dbPath)}；可先备份，再删掉 watch.db / watch.db-wal / watch.db-shm 让它重建（链记录会随之丢失）`;
  }
  if (/unable to open database file/i.test(raw)) return `${reason}：${escapeControlChars(dbPath)}；先确认该路径可用，再重试`;
  if (/disk I\/O error/i.test(raw)) return `${reason}：${escapeControlChars(dbPath)}；先确认磁盘可用，再重试`;
  if (/no such table|no such column|has no column named/i.test(raw)) {
    return `${reason}：${escapeControlChars(dbPath)}；可先备份，再删掉 watch.db / watch.db-wal / watch.db-shm 让它重建（链记录会随之丢失）`;
  }
  if (/database is locked|database is busy|SQLITE_BUSY/i.test(raw)) return `${reason}：${escapeControlChars(dbPath)}；等它结束或关掉后重试`;
  if (/本地库 schema 版本 \d+ 比本程序支持的 \d+ 更新/.test(raw)) {
    return `${reason}：${escapeControlChars(dbPath)}；请升级 Watch 后再试——旧版本继续写会破坏新版本的数据，临时想让旧版本可用可换一个 WATCH_DB`;
  }
  return `${reason}：${escapeControlChars(dbPath)}`;
}

/**
 * 打开前先看一眼目标文件是不是「自己的库」。
 *
 * SQLite 有两种静默接管：
 * - 不足 100 字节的文件被当成空库，原内容直接被建库覆盖（1 字节的文件实测会被写成 118KB 的库）；
 * - 别的程序的 SQLite 库（user_version=0、页数>0）会被 Watch 在里面建出七张表并把
 *   user_version 改成 6，对方按版本号做的迁移就此错位。
 * 两种以前都是 `已创建链: a` 静默成功。这里只读文件头，不打开 SQLite、不产生 -wal / -shm。
 */
function assertUsableStoreFile(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const head = readSqliteFileHead(dbPath);
  // 没有库 / 目录 / 设备文件都交给 DatabaseSync，那里已有中文说明
  if (head.kind !== 'file' || head.size === 0) return;

  if (!head.hasMagic) {
    throw Object.assign(
      new Error(
        `本地库路径上已有一个不是有效的 SQLite 数据库的文件：${escapeControlChars(dbPath)}（${head.size} 字节）。为避免把它覆盖成 Watch 的库，本次未写入任何内容；请先备份并挪走这个文件，或改用另一个 WATCH_DB`,
      ),
      { code: 'EWATCHNOTSQLITE' },
    );
  }
  // user_version 为 0 有两种可能，光看头分不清：别的程序的库，或 Watch 自己第一次建库时被杀在半路。
  // 只有这一档才去只读打开看表名。
  if (head.userVersion !== 0 || head.pageCount === 0) return;

  const probe = probeSqliteTables(dbPath);
  const tables = 'tables' in probe ? probe.tables : [];
  // 半途建库的 Watch 库至少已经落下部分表；一张 Watch 的表都没有才判成别人的库
  const known = tables.filter((t) => (REQUIRED_TABLES as readonly string[]).includes(t));
  if ('error' in probe || known.length === 0) {
    const detail =
      'error' in probe
        ? `表结构读不出来：${describeStoreErrorReason(probe.error)}`
        : `表: ${tables.slice(0, 5).join(' / ') || '（没有任何表）'}`;
    throw Object.assign(
      new Error(
        `本地库路径上已有一个不是 Watch 的 SQLite 数据库：${escapeControlChars(dbPath)}（user_version=0，${detail}）。` +
          `为避免把 Watch 的表写进别人的库、改掉它的 user_version，本次未写入任何内容；` +
          `请改用另一个 WATCH_DB（默认 ~/.watch/watch.db）；如果这其实是 Watch 的库损坏了，先备份，再删掉 watch.db / watch.db-wal / watch.db-shm 让它重建`,
      ),
      { code: 'EWATCHFOREIGN' },
    );
  }
}

/**
 * 本地单库持久化（node:sqlite 同步 API，与 router 串行队列匹配）。
 * 迁移：PRAGMA user_version 步进，每版幂等（参考 hapi hub/src/store）。
 * 写库失败由调用方（router）兜底，store 内部不吞错。
 */
export class Store {
  private readonly db: DatabaseSync;

  /** cwd 库键归一（Windows 反斜杠/`\\?\` 前缀统一），保证同一目录不同写法命中同一行 */
  private normCwd(cwd: string): string {
    return normalizePath(cwd);
  }

  constructor(dbPath: string = defaultDbPath()) {
    assertUsableStoreFile(dbPath);
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    // busy_timeout 必须是第一条：另一进程正在重建 wal-index（只剩 -wal 没有 -shm）时，
    // journal_mode 会撞 SQLITE_BUSY_RECOVERY，没装 busy handler 就直接抛 database is locked
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    if (dbPath !== ':memory:') {
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // wal/shm 可能尚未生成
        }
      }
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = row.user_version;
    // 版本号是「装过更新版本的 Watch 后又降级」的唯一线索：迁移只会往上走，旧版本没有回退迁移，
    // 照常打开就会拿旧 schema 的理解写新版本的库（列含义可能已变），且此处没有任何提示。
    if (version > SCHEMA_VERSION) {
      throw new Error(`本地库 schema 版本 ${version} 比本程序支持的 ${SCHEMA_VERSION} 更新（多半是装过更新版本的 Watch）`);
    }
    const steps: Record<number, () => void> = {
      0: () => this.createV1(),
      1: () => this.migrateV2(),
      2: () => this.migrateV3(),
      3: () => this.migrateV4(),
      4: () => this.migrateV5(),
      5: () => this.migrateV6(),
      6: () => this.migrateV7(),
    };
    while (version < SCHEMA_VERSION) {
      const step = steps[version];
      if (!step) throw new Error(`watch.db schema 版本 ${version} 无迁移路径`);
      step();
      version += 1;
      this.db.prepare(`PRAGMA user_version = ${version}`).run();
    }
    for (const t of REQUIRED_TABLES) {
      const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!found) throw new Error(`watch.db 缺少必需表: ${t}`);
    }
  }

  private createV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        provider TEXT,
        ref_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        provider TEXT,
        ts TEXT NOT NULL,
        meta_json TEXT,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS switch_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_provider TEXT,
        to_provider TEXT NOT NULL,
        from_ref TEXT,
        to_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_switch_session ON switch_events(session_id, created_at);

      CREATE TABLE IF NOT EXISTS turn_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('thinking','tool_call','tool_result','text')),
        summary TEXT NOT NULL,
        detail TEXT,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_events ON turn_events(session_id, turn_seq);
    `);
  }

  private migrateV2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chains (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        last_used_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (cwd, name)
      );
      CREATE INDEX IF NOT EXISTS idx_chains_cwd ON chains(cwd, status);
    `);
    this.db.exec(`
      INSERT INTO chains (id, cwd, name, status, last_used_at, created_at)
      SELECT id, cwd, '默认', 'active', updated_at, created_at
      FROM sessions
      WHERE title = '${CHAIN_SESSION_TITLE}'
        AND id NOT IN (SELECT id FROM chains)
    `);
  }

  private migrateV4(): void {
    // v4: switch_events 标记 Watch 写出版本（对原生工具零副作用，仅存 Watch 侧）。
    // 必须先查列再加：`PRAGMA user_version` 在每步之后才写，ALTER 成功、版本号没落盘时
    // （进程被杀 / 库被别的工具抬过一次）下次打开会重跑这一步，裸 ALTER 直接抛
    // `duplicate column name`——整个本地库从此打不开。与 migrateV7 同一守卫。
    const cols = this.db.prepare('PRAGMA table_info(switch_events)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'schema_version')) {
      this.db.exec("ALTER TABLE switch_events ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'v1'");
    }
  }

  private migrateV5(): void {
    // v5: 启动器持久化的 session id ↔ cwd 映射。`watch open <id>` 反查命中即 upsert，
    // 下次同 id 直接快返（file_path 仍在时），不再全盘扫描各 provider 原生库。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_locations (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        file_path TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_locations_cwd ON session_locations(cwd, last_seen_at);
    `);
  }

  private migrateV6(): void {
    // v6: 搜索索引的增量游标（mtime + size）。文件没变就不重新 parse；升级后首轮会全量建一次。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_index (
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (cwd, provider, session_id)
      );
    `);
  }

  private migrateV7(): void {
    // v7: 记录每个已索引会话里有几行无法解析。搜索索引只会收进 `parse()` 能解出的轮次，
    // 被截断的半行从此搜不到；只在本轮重新解析时数一遍，下一条命令就说不出来了（文件没变就跳过），
    // 用户看到的只是「无结果」。落在游标行上，未变化的会话也能照常披露。
    const cols = this.db.prepare('PRAGMA table_info(search_index)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'bad_lines')) {
      this.db.exec('ALTER TABLE search_index ADD COLUMN bad_lines INTEGER NOT NULL DEFAULT 0');
    }
  }

  private migrateV3(): void {
    const ddl = (tokenizer: string) => `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        provider UNINDEXED,
        cwd UNINDEXED,
        file_path UNINDEXED,
        tokenize = '${tokenizer}'
      );
    `;
    try {
      this.db.exec(ddl('trigram'));
    } catch {
      this.db.exec(ddl('unicode61 remove_diacritics 2'));
    }
  }

  /** 启动器反查成功后写入/刷新 id ↔ cwd 映射。命中已存在记录时 hits+1，first_seen_at 保留 */
  rememberSessionLocation(provider: string, ref: SessionRef, seenAt: number = Date.now()): void {
    ref = { ...ref, cwd: normalizePath(ref.cwd) };
    this.db
      .prepare(
        `INSERT INTO session_locations (provider, session_id, cwd, file_path, first_seen_at, last_seen_at, hits)
         VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(provider, session_id) DO UPDATE SET
           cwd = excluded.cwd,
           file_path = excluded.file_path,
           last_seen_at = excluded.last_seen_at,
           hits = hits + 1`,
      )
      .run(provider, ref.sessionId, ref.cwd, ref.filePath, seenAt, seenAt);
  }

  getSessionLocation(provider: string, sessionId: string): SessionLocation | null {
    const row = this.db
      .prepare('SELECT * FROM session_locations WHERE provider=? AND session_id=?')
      .get(provider, sessionId) as SessionLocationRow | undefined;
    return row ? rowToSessionLocation(row) : null;
  }

  listSessionLocations(opts?: { cwd?: string; limit?: number }): SessionLocation[] {
    const { cwd: rawCwd, limit = 50 } = opts ?? {};
    const cwd = rawCwd ? this.normCwd(rawCwd) : undefined;
    const rows = cwd
      ? (this.db
          .prepare('SELECT * FROM session_locations WHERE cwd=? ORDER BY last_seen_at DESC LIMIT ?')
          .all(cwd, limit) as SessionLocationRow[])
      : (this.db.prepare('SELECT * FROM session_locations ORDER BY last_seen_at DESC LIMIT ?').all(limit) as SessionLocationRow[]);
    return rows.map(rowToSessionLocation);
  }

  /**
   * 按 id 前缀在本地映射里找候选：反查失败时回答「是不是只抄了前半截」。
   *
   * 只查 `session_locations`（Watch 反查过的会话），所以「没有候选」**不代表**这台机器上没有——
   * 文案必须带上这句，否则又是一句把「没记过」讲成「不存在」的假结论。
   * 长度 < 4 或带路径分隔符的输入直接返回空：那不是前缀，是一次写错。
   */
  findSessionIdsByPrefix(prefix: string, limit = 3): { provider: string; sessionId: string; cwd: string }[] {
    const p = prefix.trim();
    if (p.length < 4 || !/^[0-9A-Za-z_][0-9A-Za-z_-]*$/.test(p)) return [];
    // `_` 是 LIKE 的单字符通配符，而 OpenCode 的 id 正以 `ses_` 开头：不转义就会把
    // `ses_abc` 匹配成 `ses1abc…` 这类无关 id，给出错误的「完整 id」
    const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT provider, session_id, cwd FROM session_locations WHERE session_id LIKE ? ESCAPE '\\' ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(like, limit) as { provider: string; session_id: string; cwd: string }[];
    return rows.map((row) => ({ provider: row.provider, sessionId: row.session_id, cwd: row.cwd }));
  }

  reindexSession(opts: {
    cwd: string;
    sessionId: string;
    provider: string;
    filePath: string;
    texts: string[];
    /** 提供时记录增量游标：下次 `mtimeMs + size` 未变即跳过重新 parse */
    mtimeMs?: number;
    size?: number;
    /** 原生文件里有几行无法解析（这些行的内容不在索引里）；只在写游标时记录 */
    badLines?: number;
  }): void {
    opts = { ...opts, cwd: normalizePath(opts.cwd) };
    // 先删后插：磁盘满 / 库只读时插到一半失败，旧索引已被删掉、游标也没更新，
    // 这一轮 search 就会少掉整整一条会话，而用户看到的只是「无结果」。
    // 整段放进事务，失败时旧索引原样保留——最该保住旧内容的时刻正是写不进去的时刻。
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages_fts WHERE session_id=? AND cwd=?').run(opts.sessionId, opts.cwd);
      const ins = this.db.prepare(
        'INSERT INTO messages_fts (text, session_id, provider, cwd, file_path) VALUES (?,?,?,?,?)',
      );
      for (const raw of opts.texts) {
        const text = raw.replace(/\s+/g, ' ').trim().slice(0, FTS_TEXT_LIMIT);
        if (text.length < 2) continue;
        ins.run(text, opts.sessionId, opts.provider, opts.cwd, opts.filePath);
      }
      if (typeof opts.mtimeMs === 'number' && typeof opts.size === 'number') {
        this.recordIndexedSession(
          opts.cwd,
          opts.provider,
          opts.sessionId,
          opts.filePath,
          opts.mtimeMs,
          opts.size,
          opts.badLines ?? 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 库文件里可被 `VACUUM` 回收的字节数（freelist × page_size）。
   *
   * 只报文件大小会骗人：SQLite 删除行时**不缩文件**，只把页还给 freelist。
   * `watch search` 清掉已删除会话的索引后，体积往往一点没变，用户会以为清理没生效。
   * 读不出来返回 null（不拿 0 冒充「没有可回收空间」）。
   */
  reclaimableBytes(): number | null {
    try {
      const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      const free = (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
      return pageSize * free;
    } catch {
      return null;
    }
  }

  /**
   * 清空搜索索引（`messages_fts` + `search_index`），再 `VACUUM` 把空间还给文件系统。
   *
   * 只动索引：链、切换记录、会话映射都不碰——索引的每一行都能由原生会话文件重建，
   * 所以这是唯一一条不丢东西的省空间路径（删库会连链一起丢）。`VACUUM` 单独兜底：
   * 它需要约等于库大小的临时空间，磁盘满时正是最可能失败的一步，此时索引已经清空，
   * 只披露「空间要等后续写入复用」而不是把整次操作报成失败。
   */
  resetSearchIndex(): {
    rows: number;
    sessions: number;
    directories: number;
    vacuumed: boolean;
    vacuumError?: string;
  } {
    const before = this.indexFootprint();
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM messages_fts');
      this.db.exec('DELETE FROM search_index');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    let vacuumed = false;
    let vacuumError: string | undefined;
    try {
      this.db.exec('VACUUM');
      vacuumed = true;
    } catch (error) {
      vacuumError = describeStoreErrorReason(error);
    }
    // WAL 里的旧页不 checkpoint 就还在文件里：VACUUM 之后不截断，体积照样不降
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 非 WAL 模式或连接不可用；是否真的变小由 doctor 的体积一栏对照 */
    }
    return { ...before, vacuumed, ...(vacuumError ? { vacuumError } : {}) };
  }

  /**
   * 本地库自己的数据规模：搜索索引的文本段数与覆盖范围。
   *
   * `watch doctor` 拿它配 `stat` 出来的文件体积回答「这个工具自己占了多大地方」——
   * v22 起索引里还有工具调用与返回记录，增长比过去快，而此前唯一可能的答案是用户自己去 `ls`。
   * 只是观察值，不做阈值判断：多少算大取决于用户自己的磁盘。
   */
  indexFootprint(): { rows: number; sessions: number; directories: number } {
    const rows = this.db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number };
    const sessions = this.db
      .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT cwd) AS d FROM search_index')
      .get() as { n: number; d: number };
    return { rows: rows.n, sessions: sessions.n, directories: sessions.d };
  }

  /** 记录某会话已索引到哪个文件版本（mtime + size），供下一轮跳过未变化的文件 */
  recordIndexedSession(
    cwd: string,
    provider: string,
    sessionId: string,
    filePath: string,
    mtimeMs: number,
    size: number,
    badLines = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO search_index (cwd, provider, session_id, file_path, mtime_ms, size, bad_lines)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(cwd, provider, session_id) DO UPDATE SET
           file_path = excluded.file_path,
           mtime_ms = excluded.mtime_ms,
           size = excluded.size,
           bad_lines = excluded.bad_lines`,
      )
      .run(this.normCwd(cwd), provider, sessionId, filePath, mtimeMs, size, badLines);
  }

  /** 某 provider/cwd 的索引游标，按 session id 索引 */
  indexedStats(
    cwd: string,
    provider: string,
  ): Map<string, { filePath: string; mtimeMs: number; size: number; badLines: number }> {
    const rows = this.db
      .prepare('SELECT session_id, file_path, mtime_ms, size, bad_lines FROM search_index WHERE cwd=? AND provider=?')
      .all(this.normCwd(cwd), provider) as {
        session_id: string;
        file_path: string;
        mtime_ms: number;
        size: number;
        bad_lines: number;
      }[];
    return new Map(
      rows.map((row) => [
        row.session_id,
        { filePath: row.file_path, mtimeMs: row.mtime_ms, size: row.size, badLines: row.bad_lines },
      ]),
    );
  }

  /** 某 provider/cwd 已建索引的会话及其原生文件路径（用于核对文件是否还在） */
  indexedSessions(cwd: string, provider: string): { sessionId: string; filePath: string }[] {
    const rows = this.db
      .prepare(
        'SELECT session_id, MIN(file_path) AS file_path FROM messages_fts WHERE cwd=? AND provider=? GROUP BY session_id',
      )
      .all(this.normCwd(cwd), provider) as { session_id: string; file_path: string }[];
    return rows.map((row) => ({ sessionId: row.session_id, filePath: row.file_path }));
  }

  /** 删除单个会话在本 provider/cwd 下的全部索引行 */
  removeIndexedSession(cwd: string, provider: string, sessionId: string): void {
    const normalized = this.normCwd(cwd);
    this.db.prepare('DELETE FROM messages_fts WHERE cwd=? AND provider=? AND session_id=?').run(normalized, provider, sessionId);
    this.db.prepare('DELETE FROM search_index WHERE cwd=? AND provider=? AND session_id=?').run(normalized, provider, sessionId);
  }

  searchMessages(query: string, cwd?: string): SearchHit[] {
    return this.searchMessagesWithMeta(query, cwd).hits;
  }

  /**
   * 与 `searchMessages` 同源，但把「结果被截断」的原因一并带出：
   * 全局 40 条、单会话 3 条、session id 前缀 10 条都是硬上限，消费方不能把截断当成全部。
   */
  searchMessagesWithMeta(query: string, cwd?: string): SearchResult {
    const q = normalizeQueryWhitespace(query);
    if (!q) return { hits: [], truncated: false, perSessionCapped: false, idPrefixCapped: false };
    const normalized = cwd ? this.normCwd(cwd) : undefined;
    // 顺手支持按原生 session id（或其前缀）找会话：用户手里常只有 id，正文里搜不到
    const byId = this.searchSessionIdPrefix(q, normalized);
    const text = this.searchIndexText(q, normalized);
    const capped = capPerSession([...byId.hits, ...text.hits]);
    return {
      hits: capped.hits,
      truncated: capped.truncated,
      perSessionCapped: capped.perSessionCapped,
      idPrefixCapped: byId.capped,
      // 候选集撞上 SCAN_LIMIT：可能还有别的会话命中没被读到（见 SearchResult.candidatesSaturated）
      ...(text.saturated ? { candidatesSaturated: true } : {}),
    };
  }

  /**
   * 本目录没命中时，索引里**别的目录**有没有匹配（按目录聚合，命中多的在前）。
   *
   * 搜索按 cwd 限定，于是「这个目录没聊过」与「这条会话属于另一个目录」在输出里一模一样：
   * 2026-11-08 实测会话在 `a/`、在 `b/` 里搜，只回一句「无结果」——结论式文案，用户会以为
   * 真没有，而同一句 `watch search … --cwd a` 立刻能搜到。`chainsElsewhere()` 是同一个思路
   * 在链上的版本。
   *
   * 只用来补一句说明：查不出来时调用方应当照常给结果，不能因为这条补充查询失败而遮住命中。
   */
  searchElsewhere(query: string, cwd: string): SearchElsewhere[] {
    // 与 searchMessagesWithMeta 同一套空白归一：两处口径不一致时，「本目录搜不到」的补充
    // 查询会与主查询给出不同的结论（一个说别处有、一个说别处也没有）
    const q = normalizeQueryWhitespace(query);
    if (!q) return [];
    const normalized = this.normCwd(cwd);
    const counts = new Map<string, number>();
    const bump = (rows: { cwd: string }[]) => {
      for (const row of rows) counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
    };
    // 与 searchMessagesWithMeta 同一套判定：id 前缀 + 正文（短词退 LIKE），否则「本目录能搜到、
    // 别处搜不到」会变成假结论
    if (/^[0-9a-f][0-9a-f-]{3,63}$/i.test(q)) {
      bump(
        this.db
          .prepare('SELECT cwd FROM search_index WHERE cwd<>? AND session_id LIKE ? LIMIT 50')
          .all(normalized, `${q.toLowerCase()}%`) as { cwd: string }[],
      );
    }
    // 短语与主查询同一套构造（引号替换后再折叠空白），否则「本目录 0 条、别处有」的
    // 补充说明会在带引号 / 空白的查询上与主查询给出不同结论
    const phrase = [...q].length < 3 ? null : ftsPhrase(q);
    const textRows = (phrase === null
      ? this.db
          .prepare(
            `SELECT cwd FROM messages_fts WHERE cwd<>? AND text LIKE ? ESCAPE '\\' LIMIT ${SCAN_LIMIT}`,
          )
          .all(normalized, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      : this.db
          .prepare(`SELECT cwd FROM messages_fts WHERE cwd<>? AND messages_fts MATCH ? LIMIT ${SCAN_LIMIT}`)
          .all(normalized, phrase)) as { cwd: string }[];
    bump(textRows);
    return [...counts.entries()]
      .map(([dir, hits]) => ({ cwd: dir, hits }))
      .sort((a, b) => b.hits - a.hits);
  }

  /** 查询形如 session id 时，按 `search_index` 里的 id 前缀命中（uuid 片段即可；`reindexCwd` 总会写游标） */
  private searchSessionIdPrefix(q: string, cwd?: string): { hits: SearchHit[]; capped: boolean } {
    if (!/^[0-9a-f][0-9a-f-]{3,63}$/i.test(q)) return { hits: [], capped: false };
    const like = `${q.toLowerCase()}%`;
    const sql = cwd
      ? `SELECT session_id, provider, cwd, file_path FROM search_index WHERE cwd=? AND session_id LIKE ? LIMIT 10`
      : `SELECT session_id, provider, cwd, file_path FROM search_index WHERE session_id LIKE ? LIMIT 10`;
    const rows = (
      cwd ? this.db.prepare(sql).all(cwd, like) : this.db.prepare(sql).all(like)
    ) as { session_id: string; provider: string; cwd: string; file_path: string }[];
    return {
      // 撞到 LIMIT 10 时前缀命中只是「至少这么多」
      capped: rows.length >= 10,
      hits: rows.map((r) => ({
        sessionId: r.session_id,
        provider: r.provider,
        cwd: r.cwd,
        filePath: r.file_path,
        snippet: `会话 ${r.session_id}`,
      })),
    };
  }

  private searchIndexText(query: string, cwd?: string): { hits: SearchHit[]; saturated: boolean } {
    cwd = cwd ? this.normCwd(cwd) : undefined;
    const q = normalizeQueryWhitespace(query);
    if (!q) return { hits: [], saturated: false };
    // trigram 分词最短要 3 个字符；更短的查询（中文两字词如「登录」）退化为 LIKE 子串匹配
    if ([...q].length < 3) return { hits: this.searchShort(q, cwd), saturated: false };
    // 索引写入时正文被 `\s+` 折成单个空格；查询侧不做同样的归一，「按原文粘贴」的多行
    // 片段（`foo\n  bar`）会被当成一个含换行的短语，命中 0 条——而正文里明明有 `foo bar`。
    // 归一必须在包引号**之前**做，且保留用户自己的引号语义（内部引号仍按原有规则换成空格）。
    const match = ftsPhrase(q);
    if (match === null) return { hits: [], saturated: false };
    const sql = cwd
      ? `SELECT session_id, provider, cwd, file_path, snippet(messages_fts, 0, '[', ']', '…', 10) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? AND cwd=? LIMIT ${SCAN_LIMIT}`
      : `SELECT session_id, provider, cwd, file_path, snippet(messages_fts, 0, '[', ']', '…', 10) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? LIMIT ${SCAN_LIMIT}`;
    const rows = (
      cwd ? this.db.prepare(sql).all(match, cwd) : this.db.prepare(sql).all(match)
    ) as {
      session_id: string;
      provider: string;
      cwd: string;
      file_path: string;
      snippet: string;
    }[];
    // 截断统一在 searchMessagesWithMeta 里做，这里只负责取候选；撞上 LIMIT 说明候选可能不全
    return {
      hits: rows.map((r) => ({
        sessionId: r.session_id,
        provider: r.provider,
        cwd: r.cwd,
        filePath: r.file_path,
        snippet: r.snippet,
      })),
      saturated: rows.length >= SCAN_LIMIT,
    };
  }

  /** 不足 3 字符的查询：FTS5 trigram 无法命中，直接对索引文本做子串匹配 */
  private searchShort(q: string, cwd?: string): SearchHit[] {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const sql = cwd
      ? `SELECT session_id, provider, cwd, file_path, text FROM messages_fts WHERE cwd=? AND text LIKE ? ESCAPE '\\' LIMIT ${SCAN_LIMIT}`
      : `SELECT session_id, provider, cwd, file_path, text FROM messages_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ${SCAN_LIMIT}`;
    const rows = (
      cwd ? this.db.prepare(sql).all(cwd, like) : this.db.prepare(sql).all(like)
    ) as {
      session_id: string;
      provider: string;
      cwd: string;
      file_path: string;
      text: string;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      provider: r.provider,
      cwd: r.cwd,
      filePath: r.file_path,
      snippet: excerpt(r.text, q),
    }));
  }

  /** 首开聊：建 session 行 + 首轮 user/assistant + 首轮过程事件，返回 session id */
  createSession(cwd: string, provider: string, ref: SessionRef, turns: [UnifiedTurn, UnifiedTurn], events: ProcessEvent[] = []): string {
    cwd = this.normCwd(cwd);
    const id = randomUUID();
    const now = Date.now();
    const title = turns[0].text.replace(/\s+/g, ' ').slice(0, 50);
    this.db.prepare(
      'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,?,?,?,0)',
    ).run(id, title, cwd, provider, JSON.stringify(ref), now, now);
    this.appendTurns(id, turns, events);
    return id;
  }

  /**
   * 追加一轮消息（send 成功路径）：user+assistant 两条 turns + 本轮过程事件，更新 updated_at。
   * 单事务保证成对完整；seq 取 sessions.next_seq 并推进。
   */
  appendTurns(sessionId: string, turns: UnifiedTurn[], events: ProcessEvent[]): void {
    this.db.exec('BEGIN');
    try {
      const row = this.db.prepare('SELECT next_seq FROM sessions WHERE id=?').get(sessionId) as
        | { next_seq: number }
        | undefined;
      if (!row) throw new Error(`session 不存在: ${sessionId}`);
      let seq = row.next_seq;
      const insTurn = this.db.prepare(
        'INSERT INTO turns (id, session_id, seq, role, text, provider, ts) VALUES (?,?,?,?,?,?,?)',
      );
      let assistantSeq = -1;
      for (const t of turns) {
        insTurn.run(randomUUID(), sessionId, seq, t.role, t.text, t.provider ?? null, t.timestamp);
        if (t.role === 'assistant') assistantSeq = seq;
        seq += 1;
      }
      if (events.length && assistantSeq >= 0) {
        const insEvent = this.db.prepare(
          'INSERT INTO turn_events (id, session_id, turn_seq, kind, summary, detail, ts) VALUES (?,?,?,?,?,?,?)',
        );
        for (const e of events) {
          insEvent.run(randomUUID(), sessionId, assistantSeq, e.kind, e.summary, e.detail ?? null, e.timestamp);
        }
      }
      this.db.prepare('UPDATE sessions SET next_seq=?, updated_at=? WHERE id=?').run(seq, Date.now(), sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 切换成功：记审计 + 更新当前指向；连续完全相同的记录不重复落库 */
  recordSwitch(sessionId: string, fromProvider: string | null, fromRef: SessionRef | null, toProvider: string, toRef: SessionRef | null): void {
    this.db.exec('BEGIN');
    try {
      const last = this.db
        .prepare(
          'SELECT from_provider, from_ref, to_provider, to_ref FROM switch_events WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(sessionId) as
        | { from_provider: string | null; from_ref: string | null; to_provider: string; to_ref: string }
        | undefined;
      const fromJson = fromRef ? JSON.stringify(fromRef) : null;
      const toJson = toRef ? JSON.stringify(toRef) : null;
      if (
        last &&
        last.from_provider === fromProvider &&
        last.from_ref === fromJson &&
        last.to_provider === toProvider &&
        last.to_ref === toJson
      ) {
        this.db.exec('ROLLBACK');
        return;
      }
      this.db.prepare(
        'INSERT INTO switch_events (id, session_id, from_provider, to_provider, from_ref, to_ref, created_at, schema_version) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        sessionId,
        fromProvider,
        toProvider,
        fromJson,
        toJson,
        Date.now(),
        'v1',
      );
      this.db.prepare('UPDATE sessions SET provider=?, ref_json=?, updated_at=? WHERE id=?').run(
        toProvider,
        toRef ? JSON.stringify(toRef) : null,
        Date.now(),
        sessionId,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** start 后回写 ref（createSession 已带 ref；此方法留给未来 ref 变更场景） */
  updateRef(sessionId: string, provider: string, ref: SessionRef): void {
    this.db.prepare('UPDATE sessions SET provider=?, ref_json=?, updated_at=? WHERE id=?').run(
      provider,
      JSON.stringify(ref),
      Date.now(),
      sessionId,
    );
  }

  /** server 启动恢复：同 cwd 最近更新的 session（排除 CLI 链会话行） */
  loadLatestSession(cwd: string): StoredSession | null {
    cwd = this.normCwd(cwd);
    const row = this.db
      .prepare(
        "SELECT id, title, cwd, provider, ref_json, next_seq FROM sessions WHERE cwd=? AND title != ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(cwd, CHAIN_SESSION_TITLE) as
      | { id: string; title: string; cwd: string; provider: string | null; ref_json: string | null; next_seq: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      provider: row.provider,
      ref: row.ref_json ? (JSON.parse(row.ref_json) as SessionRef) : null,
      nextSeq: row.next_seq,
    };
  }

  /** 已有 CLI 链会话则返回 id，否则 null（status 只读，不创建） */
  findChainSession(cwd: string): string | null {
    return this.findActiveChain(cwd)?.id ?? null;
  }

  findActiveChain(cwd: string, chainId?: string): Chain | null {
    cwd = this.normCwd(cwd);
    if (chainId) {
      // 写入侧 `createChain()` / `renameChain()` 都先 trim 再入库，库里不可能有首尾带空白的链名，
      // 所以这里 trim 是无损归一化（不会指向另一条链）；不 trim 的话 `chain list` 里印出来的名字
      // 连空格一起抄回来就「找不到链」，而报错清单里正列着那个名字——见 `src/core/cli-input.ts`
      chainId = chainId.trim();
      const byId = this.db.prepare('SELECT * FROM chains WHERE id=?').get(chainId) as ChainRow | undefined;
      if (byId && byId.cwd === cwd) return rowToChain(byId);
      const byName = this.db
        .prepare('SELECT * FROM chains WHERE cwd=? AND name=?')
        .get(cwd, chainId) as ChainRow | undefined;
      return byName ? rowToChain(byName) : null;
    }
    const row = this.db
      .prepare("SELECT * FROM chains WHERE cwd=? AND status='active' ORDER BY last_used_at DESC LIMIT 1")
      .get(cwd) as ChainRow | undefined;
    return row ? rowToChain(row) : null;
  }

  /**
   * `--chain <名或 id>` 在当前目录找不到时的补充说明。
   *
   * 链按 cwd 精确匹配：在 A 目录建的链，拿到 B 目录下用只会得到「找不到链」，
   * 用户会去核对名字有没有打错，其实该查的是 `--cwd`。
   * 这里跨目录找同名 / 同 id 的链，命中就说明它在哪个目录。
   *
   * 跨目录也不命中时，用户还剩两种打错：拼错 / 看清了大小写，或把另一条链的名字记混了。
   * 只说「找不到链: nope」时，明明目录里躺着 `alpha` / `beta`，用户也看不出该不该改名重试
   * ——与 `unknownProviderMessage()` 修过的是同一件事。所以带上本目录的可用链名；
   * 大小写只差一个字母时单独点出来（链名是大小写敏感的精确匹配，`Alpha` 与 `alpha` 是两条链，
   * 光列清单还不够，用户会以为自己已经打对了）。
   */
  missingChainMessage(cwd: string, chainId: string): string {
    // 与 `findActiveChain()` 同一处归一化：能解析到的名字根本走不到这里，
    // 走到这里时也要用 trim 后的值来措辞与比对——否则报错内容会是「找不到链:  nope 」，
    // 用户看不出自己打的名字与清单里那个差在哪（首尾空白在终端里根本看不见）
    chainId = chainId.trim();
    // 链名与 cwd 都要过转义：两者都直接进终端，而 `chain use $'x\e[31m'` 这种输入里的 ESC
    // 会真的改掉终端颜色（`--json` 里由 JSON.stringify 转义，不受影响）
    const base = `找不到链: ${escapeControlChars(chainId)}`;
    const normalized = this.normCwd(cwd);
    const byId = this.db.prepare('SELECT id, cwd, name, status FROM chains WHERE id=?').get(chainId) as
      | { id: string; cwd: string; name: string; status: string }
      | undefined;
    const hit =
      byId ??
      (this.db.prepare('SELECT id, cwd, name, status FROM chains WHERE name=?').all(chainId) as {
        id: string;
        cwd: string;
        name: string;
        status: string;
      }[])[0];
    if (hit && hit.cwd !== normalized) {
      const status = hit.status === 'archived' ? '（已归档）' : '';
      // 「属于另一个目录」是一句断言：`--cwd` 只是同一个目录的另一种写法时（软链、
      // `/var` 与 `/private/var` 这类前缀、大小写），链就在这个项目里，说成别处会让人
      // 以为链丢了、或以为该去另一个项目找。下一步不变——链按 `--cwd` 精确匹配，
      // 只有换成记录里的原字符串才查得到。
      if (sameDirectorySync(cwd, hit.cwd)) {
        const typed = escapeControlChars(hit.cwd);
        return (
          `${base}——链「${escapeControlChars(hit.name)}」${status}在同一个目录的另一种写法下: ${typed}；` +
          `把 --cwd 换成 ${typed} 重跑同一条命令（其余参数照旧）——链按 --cwd 原字符串匹配，写法不同就一条都看不到` +
          cwdControlCharsNote(hit.cwd)
        );
      }
      return (
        `${base}——链「${escapeControlChars(hit.name)}」${status}属于另一个目录: ${escapeControlChars(hit.cwd)}；` +
        `请用 --cwd ${escapeControlChars(hit.cwd)}` +
        cwdControlCharsNote(hit.cwd)
      );
    }
    // 本目录里一条链都没有：没有可列的清单，也不该暗示「你有别的链可选」，
    // 但「没有链」本身是另一种错——不是名字打错，而是还没有可用的链，要给建第一条的办法。
    const local = this.listChains(cwd);
    if (local.length === 0) {
      return (
        `${base}——本目录还没有任何链（--chain 只能指向已存在的链，不会顺手新建）；` +
        `可先用 watch chain new <名字> 建一条，或直接 watch new <provider> 让它在默认链上开一次`
      );
    }
    // listChains 按状态与最近使用时间排，文案里再按名字排一次，同一份状态每次说法一致
    // 名字要进终端：库里可能存着写入守卫上线前的坏名字，显示时转义（见 display.ts）
    const names = local.map((c) => escapeControlChars(c.name)).sort((a, b) => a.localeCompare(b));
    let message = `${base}；本目录的链: ${names.join(' / ')}`;
    // 链名精确匹配、大小写敏感：`Alpha` 不会落到 `alpha`，不点出来用户只会反复重打同一个词
    const cased = names.find((n) => n !== chainId && n.toLowerCase() === chainId.toLowerCase());
    if (cased) message += `——注意大小写：链名区分大小写，应为 ${cased}`;
    return message;
  }

  /**
   * 这个 id 是不是本地库里的某条链。
   *
   * 链 id 与原生会话 id 都是 UUID，`chain list` 文本模式还把链 id 印在同一行，
   * 复制到 `watch open` / `watch adopt --session` 里完全看不出区别。链不是会话，
   * 永远不会被反查命中——只回「未找到会话」会让人反复核对那串 id 有没有抄错，
   * 而真正该做的是回到 `watch status` / `chain list` 取链上绑定的会话 id。
   * 命中时带上链名、状态与链尾绑定，让用户能确认自己复制的是哪一行。
   */
  describeChainIdMisuse(id: string, cwd?: string, storeError?: string | null): string | null {
    let row: { id: string; cwd: string; name: string; status: string } | undefined;
    try {
      row = this.db.prepare('SELECT id, cwd, name, status FROM chains WHERE id=?').get(id) as
        | { id: string; cwd: string; name: string; status: string }
        | undefined;
    } catch (error) {
      // 库读不出来不能断言「这不是链」：附上原因，别让人以为 id 抄错了
      const reason = describeStoreErrorReason(error);
      return `${id} 是不是链没能确认（本地库读不出来：${reason}）`;
    }
    if (!row) return null;
    const status = row.status === 'archived' ? '已归档' : '活跃';
    let tip = '';
    try {
      const events = this.listSwitchEvents(row.id);
      const tipRef = events.length ? events[events.length - 1].toRef : null;
      tip = tipRef
        ? `；它当前停在这条链尾的 ${tipRef.provider} 会话 ${tipRef.sessionId}`
        : `；这条链上还没有绑定任何会话——${emptyChainBindHint()}`;
    } catch {
      // 链尾只是补充说明，读不出来不影响「这是链不是会话」这条结论
    }
    // 「它属于目录 X」是一句断言：`--cwd` 只是同一个目录的另一种写法（软链、`/var` 与
    // `/private/var` 这类前缀、大小写）时，链就在用户当前的目录里，说成别处会让人以为
    // 该去另一个项目找——而 `chain list --cwd <link>` 在同一次运行里已经把它认成
    // `sameDirectory: true`，两条命令会互相矛盾。下一步不变：链按记录里的原字符串匹配，
    // 只有换成它才查得到。
    let where = '';
    if (cwd && this.normCwd(cwd) !== row.cwd) {
      const typed = escapeControlChars(row.cwd);
      where = sameDirectorySync(cwd, row.cwd)
        ? `（这条链记录在同一个目录的另一种写法下: ${typed}，不是你这次的 --cwd——要看它请把 --cwd 换成 ${typed}）`
        : `（它属于另一个目录 ${typed}，不是你这次的 --cwd）`;
      where += cwdControlCharsNote(row.cwd);
    }
    return `这个 id 是链「${escapeControlChars(row.name)}」（${status}）的 id，不是会话 id${where}${tip}；要打开会话请用 watch status --cwd <目录> 或 watch chain list 里链尾的实际会话 id`;
  }

  listChains(cwd: string): Chain[] {
    cwd = this.normCwd(cwd);
    const rows = this.db
      .prepare(
        `SELECT * FROM chains WHERE cwd=? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_used_at DESC`,
      )
      .all(cwd) as ChainRow[];
    return rows.map(rowToChain);
  }

  /**
   * 本地库里属于**其它目录**的链（按最近使用倒序）。
   *
   * `listChains(cwd)` 只认这一条 cwd，于是「这个目录还没建过链」与「一条链都没有」
   * 在调用方看来没有区别。两者要区别对待：前者该指出链在哪、怎么用 `--cwd` 过去。
   */
  chainsElsewhere(cwd: string): ChainsElsewhere[] {
    const normalized = this.normCwd(cwd);
    // 不用 `as ChainsElsewhere[]`：`sameDirectory` 是调用方按真实路径判出来的（不是列），
    // 带一个 boolean 字段后整个类型就不再是 SQLOutputValue 的取值集合，`as` 会被 TS 拒掉
    return this.db
      .prepare(
        `SELECT cwd, COUNT(*) AS total, SUM(CASE status WHEN 'active' THEN 1 ELSE 0 END) AS active, MAX(last_used_at) AS lastUsedAt
           FROM chains WHERE cwd<>? GROUP BY cwd ORDER BY lastUsedAt DESC`,
      )
      .all(normalized)
      .map((row) => {
        const r = row as { cwd: string; total: number; active: number; lastUsedAt: number };
        return { cwd: r.cwd, total: r.total, active: r.active, lastUsedAt: r.lastUsedAt };
      });
  }

  createChain(cwd: string, name: string): Chain {
    cwd = this.normCwd(cwd);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
    assertChainNameUsable(trimmed);
    const id = randomUUID();
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,NULL,?,?,0)',
        )
        .run(id, CHAIN_SESSION_TITLE, cwd, null, now, now);
      this.db
        .prepare('INSERT INTO chains (id, cwd, name, status, last_used_at, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, cwd, trimmed, 'active', now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw uniqueChainName(error, trimmed, () => this.chainNameHolder(cwd, trimmed));
    }
    return this.mustChain(id);
  }

  renameChain(id: string, name: string): Chain {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
    // 名字有问题属于参数错误，先于「这条链在不在」报出来：否则 id 也写错时，
    // 用户先撞「找不到链」，改对 id 之后才看到链名的问题，要多改一轮
    assertChainNameUsable(trimmed);
    const existing = this.mustChain(id);
    try {
      this.db.prepare('UPDATE chains SET name=? WHERE id=?').run(trimmed, id);
    } catch (error) {
      // 改自己名字不算冲突；只有别的链占着这个名字才需要给下一步
      throw uniqueChainName(error, trimmed, () => {
        const holder = this.chainNameHolder(existing.cwd, trimmed);
        return holder && holder.id !== id ? holder : undefined;
      });
    }
    return { ...existing, name: trimmed };
  }

  /** 本目录里占用该名字的链（含归档链）。给 `uniqueChainName()` 查冲突对象用。 */
  chainNameHolder(cwd: string, name: string): Chain | undefined {
    const row = this.db
      .prepare('SELECT * FROM chains WHERE cwd=? AND name=?')
      .get(this.normCwd(cwd), name) as ChainRow | undefined;
    return row ? rowToChain(row) : undefined;
  }

  archiveChain(id: string): void {
    const chain = this.mustChain(id);
    if (chain.status === 'archived') return;
    const active = this.db
      .prepare("SELECT COUNT(*) AS n FROM chains WHERE cwd=? AND status='active'")
      .get(chain.cwd) as { n: number };
    if (active.n <= 1) {
      // 只说「不能归档最后一条链」有两个问题：不回显是哪条，而且本目录已有归档链时这句是错的
      // （`chain list` 里明明列着多条，用户会以为库坏了）。说清只统计活跃链，并给两条真实出路。
      const archived = this.db
        .prepare("SELECT COUNT(*) AS n FROM chains WHERE cwd=? AND status='archived'")
        .get(chain.cwd) as { n: number };
      const scope = archived.n
        ? `本目录只统计活跃链（另有 ${archived.n} 条已归档的链，但归档不参与默认选择）`
        : '本目录还没有别的链';
      throw new Error(
        `不能归档「${escapeControlChars(chain.name)}」：它是本目录唯一的活跃链，归档后 status / switch 就没有默认可用的链了；` +
          `${scope}。可先 watch chain new <新名字> 建一条，或 watch chain use ${escapeControlChars(chain.name)} 确认它在用`,
      );
    }
    this.db.prepare("UPDATE chains SET status='archived' WHERE id=?").run(id);
  }

  /**
   * 取消归档：`chain use <已归档链>` 用它恢复成当前链。
   * 归档只是「不再是默认链」，链记录与 switch_events 都还在，没有理由不可逆。
   *
   * 返回恢复后的链记录（含 `touchChain()` 真正写进去的 `lastUsedAt`），理由同 `touchChain()`：
   * 调用方回报什么就必须是写进去的那个，不能自己再取一次 `Date.now()`。
   */
  restoreChain(id: string): Chain {
    const chain = this.mustChain(id);
    if (chain.status === 'active') return chain; // 已经是活跃链：空操作，不动 last_used_at
    this.db.prepare("UPDATE chains SET status='active' WHERE id=?").run(id);
    return this.touchChain(id);
  }

  /**
   * 抬高 `last_used_at`，**返回落盘后的链记录**。
   *
   * 写入的值是 `max(Date.now(), lastUsedAt + 1)`——防的是「同一毫秒内连点两次，第二条不生效」。
   * 因此它**不等于**调用方自己取的 `Date.now()`：库里若已有值大于当前时钟（系统时钟被回拨过，
   * 或另一台机器 / 另一次运行写入过），落盘的是「库里值 + 1」，而调用方手里的 `Date.now()`
   * 会明显偏小。以前 `cmdChain` 的 `chain use` 正是回报 `{ ...found, lastUsedAt: Date.now() }`，
   * 于是 `--json` 给出一个库里根本不存在的时刻，与 `chain list` 同一份数据两个值
   * （2026-11-09 实测库里放一个晚 6 小时的值，回报 20:03:45 vs 落盘 02:03:45+1d）。
   * 回报什么就必须是写进去的那个，所以这里把新记录返回给调用方，别让它们再自己造一份。
   */
  touchChain(id: string): Chain {
    const chain = this.mustChain(id);
    const at = Math.max(Date.now(), chain.lastUsedAt + 1);
    this.db.prepare('UPDATE chains SET last_used_at=? WHERE id=?').run(at, id);
    return { ...chain, lastUsedAt: at };
  }

  /**
   * 写入类命令（`new` / `adopt` / `switch`）在动手之前确认 `--chain` 可用。
   *
   * `findActiveChain` 按名字 / id 查时不看 status，归档链照样返回；真到写 `switch_events`
   * 才由 `getOrCreateChainSession()` 拒绝。对 `switch` 已经是「先拦住再干活」，但 `new` / `adopt`
   * 以前把活干完才撞上这道墙：`new` 会在原生存储里留下一个谁也没绑定的会话文件
   * （再跑一次又多一个），然后返回 `ok:true` 加一条「链记录失败: 库操作失败（链已归档: …）」的警告
   * —— 用户看到的是成功，链上却什么也没有，还把一句业务判断包装成了数据库故障。
   * 失败原因在第一行就能确定，不该先建会话。
   *
   * `chainId` 为空（用当前链）时只做「链存在则必须活跃」这一半：没有链是正常的，
   * 由各命令自己走建链路径。返回归档链的名字，供调用方拼文案；可用则返回 null。
   */
  archivedChainName(cwd: string, chainId?: string): string | null {
    if (!chainId) return null;
    const found = this.findActiveChain(cwd, chainId);
    if (!found) throw new Error(this.missingChainMessage(cwd, chainId));
    // 返回的名字会拼进用户面错误（`链已归档: …`），转义后交给调用方
    return found.status === 'archived' ? escapeControlChars(found.name) : null;
  }

  /** 纯 CLI 场景：选定或创建链，挂 switch_events */
  getOrCreateChainSession(cwd: string, chainId?: string): string {
    const found = this.findActiveChain(cwd, chainId);
    if (found) {
      if (found.status === 'archived') {
        const shown = escapeControlChars(found.name);
        throw new Error(`链已归档: ${shown}；可 watch chain use ${shown} 恢复成当前链`);
      }
      this.touchChain(found.id);
      return found.id;
    }
    if (chainId) throw new Error(this.missingChainMessage(cwd, chainId));
    return this.createChain(cwd, '默认').id;
  }

  private mustChain(id: string): Chain {
    const row = this.db.prepare('SELECT * FROM chains WHERE id=?').get(id) as ChainRow | undefined;
    if (!row) throw new Error(`找不到链: ${id}`);
    return rowToChain(row);
  }

  listSwitchEvents(sessionId: string): SwitchRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, from_provider, to_provider, from_ref, to_ref, created_at, schema_version FROM switch_events WHERE session_id=? ORDER BY created_at ASC',
      )
      .all(sessionId) as unknown as {
      id: string;
      session_id: string;
      from_provider: string | null;
      to_provider: string;
      from_ref: string | null;
      to_ref: string;
      created_at: number;
      schema_version: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      fromProvider: r.from_provider,
      toProvider: r.to_provider,
      fromRef: r.from_ref ? (JSON.parse(r.from_ref) as SessionRef) : null,
      toRef: JSON.parse(r.to_ref) as SessionRef,
      schemaVersion: r.schema_version ?? undefined,
      createdAt: r.created_at,
    }));
  }

  loadTurns(sessionId: string): UnifiedTurn[] {
    const rows = this.db
      .prepare('SELECT role, text, provider, ts FROM turns WHERE session_id=? ORDER BY seq')
      .all(sessionId) as unknown as { role: 'user' | 'assistant'; text: string; provider: string | null; ts: string }[];
    return rows.map((r) => ({
      role: r.role,
      text: r.text,
      timestamp: r.ts,
      ...(r.provider ? { provider: r.provider } : {}),
    }));
  }

  /** 过程事件按 turn_seq 分组（turn_seq = assistant turn 的 seq = timeline 下标） */
  loadEventsByTurn(sessionId: string): Record<number, ProcessEvent[]> {
    const rows = this.db
      .prepare('SELECT turn_seq, kind, summary, detail, ts FROM turn_events WHERE session_id=? ORDER BY turn_seq, ts')
      .all(sessionId) as unknown as { turn_seq: number; kind: ProcessEvent['kind']; summary: string; detail: string | null; ts: string }[];
    const out: Record<number, ProcessEvent[]> = {};
    for (const r of rows) {
      (out[r.turn_seq] ??= []).push({
        kind: r.kind,
        summary: r.summary,
        ...(r.detail ? { detail: r.detail } : {}),
        timestamp: r.ts,
        provider: '',
      });
    }
    return out;
  }
}

/** 为短查询生成带方括号高亮的片段（FTS5 的 snippet() 只在 MATCH 路径可用） */
/** 按 (provider, sessionId) 截断到 MAX_PER_SESSION 条，再取前 MAX_HITS 条；保持原有排序 */
function capPerSession(hits: SearchHit[]): Pick<SearchResult, 'hits' | 'truncated' | 'perSessionCapped'> {
  const seen = new Map<string, number>();
  const out: SearchHit[] = [];
  let perSessionCapped = false;
  let truncated = false;
  for (const hit of hits) {
    const key = `${hit.provider}\u0000${hit.sessionId}`;
    const n = seen.get(key) ?? 0;
    if (n >= MAX_PER_SESSION) {
      perSessionCapped = true;
      continue;
    }
    if (out.length >= SEARCH_MAX_HITS) {
      truncated = true;
      break;
    }
    seen.set(key, n + 1);
    out.push(hit);
  }
  return { hits: out, truncated, perSessionCapped };
}

function excerpt(text: string, q: string): string {
  // 索引里的文本是折叠过空白的；查询同样归一后再找位置，否则多行片段永远对不上、只能退成
  // 「取开头 80 字符」，高亮消失、片段看似无关
  const needle = normalizeQueryWhitespace(q);
  const hay = text.toLowerCase();
  const at = hay.indexOf(needle.toLowerCase());
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 20);
  const end = Math.min(text.length, at + needle.length + 20);
  return `${start > 0 ? '…' : ''}${text.slice(start, at)}[${text.slice(at, at + needle.length)}]${text.slice(at + needle.length, end)}${end < text.length ? '…' : ''}`;
}

/**
 * 查询侧与索引写入侧对齐的空白归一（2026-11-12，第五十三轮）。
 *
 * `reindexSession()` 写入时把正文 `\s+` 折成单个空格；查询侧以前只 `trim()`，
 * 于是「按原文粘贴」的多行片段（`foo\n    bar`）会被当成含换行的短语去 MATCH，
 * 命中 0 条——索引里明明白白存着 `foo bar`。`searchShort` 的 LIKE 与
 * `excerpt()` 的高亮位置同理：不归一就永远对不上。
 *
 * 只折叠空白，不改其它字符：用户显式写的引号仍按原有规则（MATCH 路径把内部引号替换成空格），
 * 单引号 / 反斜杠也不动——SQL 参数是绑定值，不需要转义。
 */
function normalizeQueryWhitespace(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

/**
 * 把归一后的查询包成 FTS5 短语。引号先换成空格，否则 `"他说 "hello world""` 会在短语
 * 内部再出现引号（`fts5: syntax error`）；替换完还要再归一一次，因为 `a" b` 换出的
 * 连续空格会让短语变成 `"a  b"`——FTS5 短语按字面匹配，前导 / 尾随 / 连续空格都算字符，
 * 实测 `" hello world "` 命中 0 条而 `"hello world"` 命中 1 条。折叠不出内容时返回 null
 * （调用方按「无结果」处理，且不要拿空短语去 MATCH——`""` 是语法错误）。
 */
function ftsPhrase(query: string): string | null {
  const inner = query.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  return inner ? `"${inner}"` : null;
}

type SessionLocationRow = {
  provider: string;
  session_id: string;
  cwd: string;
  file_path: string;
  first_seen_at: number;
  last_seen_at: number;
  hits: number;
};

function rowToSessionLocation(row: SessionLocationRow): SessionLocation {
  return {
    provider: row.provider,
    sessionId: row.session_id,
    cwd: row.cwd,
    filePath: row.file_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    hits: row.hits,
  };
}

type ChainRow = {
  id: string;
  cwd: string;
  name: string;
  status: 'active' | 'archived';
  last_used_at: number;
  created_at: number;
};

function rowToChain(row: ChainRow): Chain {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    status: row.status,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * 链名会原样进终端：`chain list` 的每一行、`status` 的「链: …」、`usage`、`sessions --chain`，
 * 以及十几条警告里的「链「…」」。它还会被当成 `--chain <名字>` 参数抄回去。
 *
 * 控制字符在这里不只是排版问题（2026-11-08 实测，修复前）：
 * ```
 * $ watch chain new $'a\nb' …            → {"ok":true,"name":"a\nb"}      exit 0
 * $ watch chain list                     → 名字折成两行，表格错位
 * $ watch chain new $'\e[31mRED\e[0m' …  → {"ok":true,"name":"\u001b[31mRED…"}  exit 0
 * $ watch chain list                     → ^[[31mRED^[[0m 真的进了终端
 * ```
 * ESC 序列能改颜色、改标题、清屏（终端转义注入），换行 / 制表符让列表错行，抄回去的
 * `--chain` 也对不上。显示层清洗会把名字改成另一串字符，用户更认不出来，所以在写库前就拒绝。
 *
 * 只拒控制字符（C0 U+0000–U+001F、DEL U+007F、C1 U+0080–U+009F）：中文、空格、标点都照常可用。
 */
function assertChainNameUsable(name: string): void {
  const bad: string[] = [];
  let position = 0;
  for (const char of name) {
    position += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      bad.push(`第 ${position} 个字符是「${describeControlChar(code)}」`);
    }
  }
  if (!bad.length) return;
  const shown = bad.slice(0, 3).join('、');
  const more = bad.length > 3 ? `等 ${bad.length} 处` : '';
  throw new Error(
    `链名不能包含控制字符：${shown}${more}；换行 / 制表符会让 chain list 的表格错行，` +
      `ESC 这类转义序列还会改写终端显示（颜色 / 标题 / 清屏）。去掉这些字符后重试`,
  );
}

function describeControlChar(code: number): string {
  switch (code) {
    case 0x00:
      return 'NUL（U+0000）';
    case 0x09:
      return '制表符 \\t（U+0009）';
    case 0x0a:
      return '换行 \\n（U+000A）';
    case 0x0d:
      return '回车 \\r（U+000D）';
    case 0x1b:
      return 'ESC 终端转义（U+001B）';
    default: {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `控制字符 \\u${hex}（U+${hex}）`;
    }
  }
}

/**
 * 撞上 UNIQUE(chains.name) 时把 SQLite 的原文换成可执行的中文。
 *
 * 链名在 cwd 内唯一，**归档的链也占着名字**（UNIQUE 约束不看 status）。用户刚
 * `chain archive beta` 完、想重新建一条同名链，看到「链名已存在: beta」只会以为库坏了：
 * `chain list` 里它明明标着 `[归档]`，名字却回收不了。所以冲突对象要查出来，按它现在的
 * 状态给下一步——归档链能 `chain use` 恢复（等于重新启用那一条），在用的链只能换名。
 *
 * `findHolder` 由调用方注入：只有它知道本目录与当前链 id（改自己名字撞自己不算冲突）。
 */
function uniqueChainName(error: unknown, name: string, findHolder?: () => Chain | undefined): Error {
  const msg = error instanceof Error ? error.message : String(error);
  if (!/UNIQUE|unique/i.test(msg)) return error instanceof Error ? error : new Error(msg);
  const base = `链名已存在: ${name}`;
  const holder = findHolder?.();
  if (!holder) return new Error(base);
  if (holder.status === 'archived') {
    return new Error(
      `${base}——这条链已归档（不再参与 status / switch 的默认选择），但归档只表示「不是当前链」，` +
        `名字仍被占用；可用 watch chain use ${escapeControlChars(holder.name)} 把它恢复成当前链，或换一个名字`,
    );
  }
  return new Error(
    `${base}——这条链正在使用中；可用 watch chain rename ${escapeControlChars(holder.name)} <新名字> 先给它改名，或换一个名字`,
  );
}
