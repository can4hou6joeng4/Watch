import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizePath } from './platform.js';
import { probeSqliteTables, readSqliteFileHead } from './sqlite-file.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from './types.js';

const SCHEMA_VERSION = 6;
const REQUIRED_TABLES = ['sessions', 'turns', 'switch_events', 'turn_events', 'chains', 'messages_fts', 'search_index'] as const;
const FTS_TEXT_LIMIT = 8192;
/** 搜索返回的命中上限；单个会话最多占 MAX_PER_SESSION 条，避免一场对话淹没其它会话 */
const MAX_HITS = 40;
/** 命中数撞到 MAX_HITS 只说明「至少这么多」：调用方据此披露结果被截断 */
export const SEARCH_MAX_HITS = MAX_HITS;
const MAX_PER_SESSION = 3;
/** SQL 先多取一些再按会话截断，否则 LIMIT 会在截断前就把其它会话切掉 */
const SCAN_LIMIT = 200;

export type SearchHit = {
  sessionId: string;
  provider: string;
  cwd: string;
  filePath: string;
  snippet: string;
};

/** 搜索结果 + 三种硬上限是否真的截掉了命中（逐项独立，不能互相冒充） */
export type SearchResult = {
  hits: SearchHit[];
  /** 全局 40 条上限截掉了命中 */
  truncated: boolean;
  /** 某会话命中超过 3 条、只保留前 3 条 */
  perSessionCapped: boolean;
  /** 查询像 session id 时，前缀命中触碰 LIMIT 10 */
  idPrefixCapped: boolean;
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
 * 打开本地库失败的说明：带路径、原因与下一步。
 *
 * 这些字符串会原样进 `chain` / `search` 的 `{ ok:false, error }`、stderr 的降级提示与
 * `watch doctor` 的「本地库: 不可用（…）」，所以先翻成中文再抛给上层。
 */
export function describeStoreOpenFailure(dbPath: string, error: unknown): string {
  const reason = describeStoreErrorReason(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return `${reason}：${dbPath}；先确认 ${dirname(dbPath)} 可写，再重试`;
  if (code === 'ENOTDIR') return `${reason}：${dbPath}；先删掉占用它的文件再重试`;
  if (code === 'EEXIST') return `${reason}：${dbPath}；先删掉或挪走占住它的文件，让 watch 重建目录与库`;
  if (code === 'EISDIR') return `${reason}：${dbPath}；先把它挪走，让 watch 重新建库`;
  const raw = error instanceof Error ? error.message : String(error);
  // 打开前文件头检查的两句已带路径与下一步，再拼一次路径就是同一件事说两遍
  if (/^本地库路径上已有一个/.test(raw)) return raw;
  if (/not a database|malformed/i.test(raw)) {
    return `${reason}：${dbPath}；可先备份，再删掉 watch.db / watch.db-wal / watch.db-shm 让它重建（链记录会随之丢失）`;
  }
  if (/unable to open database file/i.test(raw)) return `${reason}：${dbPath}；先确认该路径可用，再重试`;
  if (/disk I\/O error/i.test(raw)) return `${reason}：${dbPath}；先确认磁盘可用，再重试`;
  if (/no such table|no such column|has no column named/i.test(raw)) {
    return `${reason}：${dbPath}；可先备份，再删掉 watch.db / watch.db-wal / watch.db-shm 让它重建（链记录会随之丢失）`;
  }
  if (/database is locked|database is busy|SQLITE_BUSY/i.test(raw)) return `${reason}：${dbPath}；等它结束或关掉后重试`;
  if (/本地库 schema 版本 \d+ 比本程序支持的 \d+ 更新/.test(raw)) {
    return `${reason}：${dbPath}；请升级 Watch 后再试——旧版本继续写会破坏新版本的数据，临时想让旧版本可用可换一个 WATCH_DB`;
  }
  return `${reason}：${dbPath}`;
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
        `本地库路径上已有一个不是有效的 SQLite 数据库的文件：${dbPath}（${head.size} 字节）。为避免把它覆盖成 Watch 的库，本次未写入任何内容；请先备份并挪走这个文件，或改用另一个 WATCH_DB`,
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
        `本地库路径上已有一个不是 Watch 的 SQLite 数据库：${dbPath}（user_version=0，${detail}）。` +
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
    // v4: switch_events 标记 Watch 写出版本（对原生工具零副作用，仅存 Watch 侧）
    this.db.exec("ALTER TABLE switch_events ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'v1'");
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

  reindexSession(opts: {
    cwd: string;
    sessionId: string;
    provider: string;
    filePath: string;
    texts: string[];
    /** 提供时记录增量游标：下次 `mtimeMs + size` 未变即跳过重新 parse */
    mtimeMs?: number;
    size?: number;
  }): void {
    opts = { ...opts, cwd: normalizePath(opts.cwd) };
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
      this.recordIndexedSession(opts.cwd, opts.provider, opts.sessionId, opts.filePath, opts.mtimeMs, opts.size);
    }
  }

  /** 记录某会话已索引到哪个文件版本（mtime + size），供下一轮跳过未变化的文件 */
  recordIndexedSession(
    cwd: string,
    provider: string,
    sessionId: string,
    filePath: string,
    mtimeMs: number,
    size: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO search_index (cwd, provider, session_id, file_path, mtime_ms, size)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(cwd, provider, session_id) DO UPDATE SET
           file_path = excluded.file_path,
           mtime_ms = excluded.mtime_ms,
           size = excluded.size`,
      )
      .run(this.normCwd(cwd), provider, sessionId, filePath, mtimeMs, size);
  }

  /** 某 provider/cwd 的索引游标，按 session id 索引 */
  indexedStats(cwd: string, provider: string): Map<string, { filePath: string; mtimeMs: number; size: number }> {
    const rows = this.db
      .prepare('SELECT session_id, file_path, mtime_ms, size FROM search_index WHERE cwd=? AND provider=?')
      .all(this.normCwd(cwd), provider) as {
        session_id: string;
        file_path: string;
        mtime_ms: number;
        size: number;
      }[];
    return new Map(
      rows.map((row) => [row.session_id, { filePath: row.file_path, mtimeMs: row.mtime_ms, size: row.size }]),
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
    const q = query.trim();
    if (!q) return { hits: [], truncated: false, perSessionCapped: false, idPrefixCapped: false };
    const normalized = cwd ? this.normCwd(cwd) : undefined;
    // 顺手支持按原生 session id（或其前缀）找会话：用户手里常只有 id，正文里搜不到
    const byId = this.searchSessionIdPrefix(q, normalized);
    const capped = capPerSession([...byId.hits, ...this.searchIndexText(q, normalized)]);
    return { hits: capped.hits, truncated: capped.truncated, perSessionCapped: capped.perSessionCapped, idPrefixCapped: byId.capped };
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

  private searchIndexText(query: string, cwd?: string): SearchHit[] {
    cwd = cwd ? this.normCwd(cwd) : undefined;
    const q = query.trim();
    if (!q) return [];
    // trigram 分词最短要 3 个字符；更短的查询（中文两字词如「登录」）退化为 LIKE 子串匹配
    if ([...q].length < 3) return this.searchShort(q, cwd);
    const match = `"${q.replace(/"/g, ' ')}"`;
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
    // 截断统一在 searchMessagesWithMeta 里做，这里只负责取候选
    return rows.map((r) => ({
      sessionId: r.session_id,
      provider: r.provider,
      cwd: r.cwd,
      filePath: r.file_path,
      snippet: r.snippet,
    }));
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
   */
  missingChainMessage(cwd: string, chainId: string): string {
    const base = `找不到链: ${chainId}`;
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
    if (!hit || hit.cwd === normalized) return base;
    const status = hit.status === 'archived' ? '（已归档）' : '';
    return `${base}——链「${hit.name}」${status}属于另一个目录: ${hit.cwd}；请用 --cwd ${hit.cwd}`;
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

  createChain(cwd: string, name: string): Chain {
    cwd = this.normCwd(cwd);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
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
      throw uniqueChainName(error, trimmed);
    }
    return this.mustChain(id);
  }

  renameChain(id: string, name: string): Chain {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
    const existing = this.mustChain(id);
    try {
      this.db.prepare('UPDATE chains SET name=? WHERE id=?').run(trimmed, id);
    } catch (error) {
      throw uniqueChainName(error, trimmed);
    }
    return { ...existing, name: trimmed };
  }

  archiveChain(id: string): void {
    const chain = this.mustChain(id);
    if (chain.status === 'archived') return;
    const active = this.db
      .prepare("SELECT COUNT(*) AS n FROM chains WHERE cwd=? AND status='active'")
      .get(chain.cwd) as { n: number };
    if (active.n <= 1) throw new Error('不能归档最后一条链');
    this.db.prepare("UPDATE chains SET status='archived' WHERE id=?").run(id);
  }

  /**
   * 取消归档：`chain use <已归档链>` 用它恢复成当前链。
   * 归档只是「不再是默认链」，链记录与 switch_events 都还在，没有理由不可逆。
   */
  restoreChain(id: string): void {
    const chain = this.mustChain(id);
    if (chain.status === 'active') return;
    this.db.prepare("UPDATE chains SET status='active' WHERE id=?").run(id);
    this.touchChain(id);
  }

  touchChain(id: string): void {
    const chain = this.mustChain(id);
    const at = Math.max(Date.now(), chain.lastUsedAt + 1);
    this.db.prepare('UPDATE chains SET last_used_at=? WHERE id=?').run(at, id);
  }

  /** 纯 CLI 场景：选定或创建链，挂 switch_events */
  getOrCreateChainSession(cwd: string, chainId?: string): string {
    const found = this.findActiveChain(cwd, chainId);
    if (found) {
      if (found.status === 'archived') {
        throw new Error(`链已归档: ${found.name}；可 watch chain use ${found.name} 恢复成当前链`);
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
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 20);
  const end = Math.min(text.length, at + q.length + 20);
  return `${start > 0 ? '…' : ''}${text.slice(start, at)}[${text.slice(at, at + q.length)}]${text.slice(at + q.length, end)}${end < text.length ? '…' : ''}`;
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

function uniqueChainName(error: unknown, name: string): Error {
  const msg = error instanceof Error ? error.message : String(error);
  if (/UNIQUE|unique/i.test(msg)) return new Error(`链名已存在: ${name}`);
  return error instanceof Error ? error : new Error(msg);
}
