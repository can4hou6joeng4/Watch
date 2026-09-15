import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAIN_SESSION_TITLE, Store, migrateLegacyDb } from '../src/core/store.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../src/core/types.js';

const ref = (provider: string, id = 's1'): SessionRef => ({
  provider,
  sessionId: id,
  filePath: `/tmp/${provider}-${id}.jsonl`,
  cwd: '/a/b',
});

const turn = (role: 'user' | 'assistant', text: string, provider?: string, seq = 0): UnifiedTurn => ({
  role,
  text,
  timestamp: `2026-08-21T06:00:0${seq}.000Z`,
  ...(provider ? { provider } : {}),
});

const evt = (summary: string): ProcessEvent => ({
  kind: 'tool_call',
  summary,
  timestamp: '2026-08-21T06:00:01.000Z',
  provider: 'claude',
});

test('store: createSession + loadLatestSession 按 cwd 过滤取最新', () => {
  const store = new Store(':memory:');
  store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '第一问'), turn('assistant', '第一答', 'claude')]);
  const other = store.createSession('/x/y', 'codex', ref('codex', 's2'), [turn('user', '别的项目'), turn('assistant', '答', 'codex')]);
  assert.equal(store.loadLatestSession('/x/y')?.id, other);
  const s = store.loadLatestSession('/a/b');
  assert.ok(s);
  assert.equal(s.provider, 'claude');
  assert.equal(s.title, '第一问');
  assert.deepEqual(s.ref, ref('claude'));
  assert.equal(s.nextSeq, 2);
  assert.equal(store.loadLatestSession('/none'), null);
});

test('store: appendTurns 推进 seq，loadTurns 保序，事件按 turn_seq 分组', () => {
  const store = new Store(':memory:');
  const id = store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问1'), turn('assistant', '答1', 'claude')], [evt('Bash: ls')]);
  store.appendTurns(id, [turn('user', '问2', undefined, 2), turn('assistant', '答2', 'claude', 3)], [evt('Read: a.ts'), evt('Grep: foo')]);
  const turns = store.loadTurns(id);
  assert.deepEqual(turns.map((t) => t.text), ['问1', '答1', '问2', '答2']);
  const events = store.loadEventsByTurn(id);
  assert.deepEqual(Object.keys(events).sort(), ['1', '3']);
  assert.equal(events[1][0].summary, 'Bash: ls');
  assert.equal(events[3].length, 2);
  assert.equal(store.loadLatestSession('/a/b')?.nextSeq, 4);
});

test('store: recordSwitch 记审计并更新当前指向', () => {
  const store = new Store(':memory:');
  const id = store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问'), turn('assistant', '答', 'claude')]);
  store.recordSwitch(id, 'claude', ref('claude'), 'codex', ref('codex', 'imported'));
  const s = store.loadLatestSession('/a/b');
  assert.equal(s?.provider, 'codex');
  assert.deepEqual(s?.ref, ref('codex', 'imported'));
});

test('store: 迁移幂等——同库重开不报错、数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-store-'));
  const dbPath = join(dir, 't.db');
  try {
    const s1 = new Store(dbPath);
    s1.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问'), turn('assistant', '答', 'claude')]);
    const s2 = new Store(dbPath); // 重开同一文件，迁移应幂等
    assert.equal(s2.loadLatestSession('/a/b')?.title, '问');
    assert.equal(s2.loadTurns(s2.loadLatestSession('/a/b')!.id).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store v2: 同 cwd 多链、重名拒绝、禁止归档最后一条', () => {
  const store = new Store(':memory:');
  const a = store.createChain('/proj', '修 bug');
  const b = store.createChain('/proj', '写新功能');
  assert.notEqual(a.id, b.id);
  assert.equal(store.listChains('/proj').length, 2);
  assert.equal(store.findActiveChain('/proj', '修 bug')?.id, a.id);
  store.touchChain(b.id);
  assert.equal(store.findActiveChain('/proj')?.id, b.id);
  assert.throws(() => store.createChain('/proj', '修 bug'), /链名已存在/);
  store.archiveChain(a.id);
  assert.equal(store.findActiveChain('/proj')?.id, b.id);
  assert.equal(store.listChains('/proj').filter((c) => c.status === 'active').length, 1);
  assert.throws(() => store.archiveChain(b.id), /最后一条/);
  assert.throws(() => store.getOrCreateChainSession('/proj', a.id), /已归档/);
});

test('store v2: 旧 tui-chain 迁为默认链且 switch_events 仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-v1-'));
  const dbPath = join(dir, 't.db');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL,
        provider TEXT, ref_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, provider TEXT, ts TEXT NOT NULL,
        meta_json TEXT, UNIQUE (session_id, seq)
      );
      CREATE TABLE switch_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_provider TEXT, to_provider TEXT NOT NULL, from_ref TEXT, to_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE turn_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL
      );
    `);
    const chainId = 'chain-old';
    raw.prepare(
      'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,NULL,?,?,0)',
    ).run(chainId, CHAIN_SESSION_TITLE, '/old', null, 1, 2);
    raw.prepare(
      'INSERT INTO switch_events (id, session_id, from_provider, to_provider, from_ref, to_ref, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'ev1',
      chainId,
      'claude',
      'codex',
      JSON.stringify(ref('claude')),
      JSON.stringify(ref('codex', 'imported')),
      3,
    );
    raw.close();

    const store = new Store(dbPath);
    const chain = store.findActiveChain('/old');
    assert.ok(chain);
    assert.equal(chain.name, '默认');
    assert.equal(chain.id, chainId);
    assert.equal(store.listSwitchEvents(chainId).length, 1);
    assert.equal(store.listSwitchEvents(chainId)[0].toProvider, 'codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store v3: FTS 中文与代码片段按 cwd 隔离', () => {
  const store = new Store(':memory:');
  store.reindexSession({
    cwd: '/proj/a',
    sessionId: 's1',
    provider: 'claude',
    filePath: '/tmp/s1.jsonl',
    texts: ['修一下登录态过期', 'const token = refresh()'],
  });
  store.reindexSession({
    cwd: '/proj/b',
    sessionId: 's2',
    provider: 'codex',
    filePath: '/tmp/s2.jsonl',
    texts: ['修一下登录态过期'],
  });
  const zh = store.searchMessages('登录态', '/proj/a');
  assert.equal(zh.length, 1);
  assert.equal(zh[0].sessionId, 's1');
  const code = store.searchMessages('refresh()', '/proj/a');
  assert.ok(code.length >= 1);
  const other = store.searchMessages('登录态', '/proj/b');
  assert.equal(other[0].sessionId, 's2');
  assert.equal(store.searchMessages('登录态', '/none').length, 0);
});

test('migrateLegacyDb: 新库不存在且旧库存在时复制 db 与 -wal（不复制 -shm），旧库保留；新库已存在或旧库缺失则不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-legacy-'));
  const legacy = join(dir, 'old', 'tongbu.db');
  const target = join(dir, 'new', 'watch.db');
  try {
    // 旧库缺失：什么都不做
    assert.equal(migrateLegacyDb(target, legacy), false);
    assert.equal(existsSync(target), false);

    // 造一个带数据的旧库；WAL 模式下刚写入的链还在 -wal 里未 checkpoint，迁移必须连 wal 一起带走
    const old = new Store(legacy);
    const chain = old.createChain('/proj', '旧链');
    assert.ok(existsSync(`${legacy}-wal`));
    assert.equal(migrateLegacyDb(target, legacy), true);
    assert.ok(existsSync(target));
    assert.ok(existsSync(`${target}-wal`));
    assert.equal(existsSync(`${target}-shm`), false, '-shm 不应被复制');
    assert.ok(existsSync(legacy), '旧库应保留作回退');

    // 新库可直接打开且数据在
    const fresh = new Store(target);
    assert.equal(fresh.findActiveChain('/proj', '旧链')?.id, chain.id);

    // 新库已存在：不再覆盖
    old.createChain('/proj', '迁移后才建的链');
    assert.equal(migrateLegacyDb(target, legacy), false);
    assert.equal(new Store(target).listChains('/proj').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 测试用：拿到 Store 私有的连接句柄（关闭连接 / 跑 PRAGMA） */
const rawDb = (s: Store): DatabaseSync => (s as unknown as { db: DatabaseSync }).db;

test('migrateLegacyDb: 目标旁孤儿 -wal/-shm 先清掉、不回放到迁入的库上；0 字节壳文件视为不存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-legacy-orphan-'));
  const legacy = join(dir, 'old', 'tongbu.db');
  const target = join(dir, 'new', 'watch.db');
  const foreign = join(dir, 'other', 'other.db');
  try {
    // 旧库：写入后关闭连接，SQLite 会 checkpoint 并删掉 -wal（模拟 tongbu 正常退出，没有 -wal 可覆盖孤儿）
    const old = new Store(legacy);
    const chain = old.createChain('/proj', '旧链');
    rawDb(old).close();
    assert.equal(existsSync(`${legacy}-wal`), false);

    // 另一条谱系的库保持打开，其 -wal 里有未 checkpoint 的帧；冒充成目标旁的孤儿 -wal/-shm
    const other = new Store(foreign);
    for (let i = 0; i < 3; i++) other.createChain('/other', `串库 ${i}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(`${foreign}-wal`, `${target}-wal`);
    copyFileSync(`${foreign}-shm`, `${target}-shm`);
    // 再留一个 0 字节壳（DatabaseSync 打开即建文件，构造中途失败会留下它）
    writeFileSync(target, '');

    assert.equal(migrateLegacyDb(target, legacy), true);
    assert.equal(existsSync(`${target}-shm`), false);
    const fresh = new Store(target);
    const check = rawDb(fresh).prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(check.integrity_check, 'ok');
    assert.equal(fresh.findActiveChain('/proj', '旧链')?.id, chain.id);
    assert.equal(fresh.listChains('/other').length, 0, '孤儿 WAL 里的链不该出现');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyDb: 复制中途失败则清掉半成品并返回 false，目标要么完整要么不存在', () => {
  // root 无视文件权限、Windows chmod 不阻止读，两种环境下都造不出 EACCES
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'watch-legacy-fail-'));
  const legacy = join(dir, 'old', 'tongbu.db');
  const target = join(dir, 'new', 'watch.db');
  try {
    const old = new Store(legacy);
    old.createChain('/proj', '旧链');
    assert.ok(existsSync(`${legacy}-wal`));
    chmodSync(`${legacy}-wal`, 0o000);
    assert.equal(migrateLegacyDb(target, legacy), false);
    for (const p of [target, `${target}-wal`, `${target}-shm`]) assert.equal(existsSync(p), false, `不应残留: ${p}`);
  } finally {
    try {
      chmodSync(`${legacy}-wal`, 0o600);
    } catch {
      /* 已被清理 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
