#!/usr/bin/env node
/**
 * 手动、需授权的 Codex 目标级写保护原生验收（默认不随 CI 运行）。
 *
 * 全程隔离 HOME/CODEX_HOME，合成会话，**不发 turn、不调用模型**：
 *   1. 真实 `codex app-server` 通过 `thread/resume` 打开合成线程 → 持有原生 per-thread writer 锁
 *   2. 持有期间 Watch 写入同一线程 → 必须拒绝（`codex_target_busy` + 真实 PID）
 *   3. 被拒绝时目标文件零写入（写入前后 contentFingerprint 一致）
 *   4. 只读预检（`checkOpenInProvider`）在持锁期间返回 writable:false，且零写入
 *   5. 结束 writer 释放锁后同一写入成功；转入计划可执行
 *   6. 协作写锁：Watch 独占原生锁文件期间，另一个 `flock` 必须失败（原子互斥）
 *   7. 释放后可再次取锁；真实 app-server 仍能 `thread/resume`（不破坏原生路径）
 *
 * 用法：npm run validate:codex-writer-guard
 * 退出码 0 = 全部通过；1 = 任一项失败（失败原因打印在 stderr）。
 */
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const record = (name, passed, detail) => {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

const FLOCK_PROBE = [
  'import fcntl, os, sys',
  'fd = os.open(sys.argv[1], os.O_RDWR)',
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  "    print('acquired')",
  'except OSError:',
  "    print('busy')",
].join('\n');

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-codex-writer-guard-')));
const home = path.join(root, 'home');
const codexHome = path.join(home, '.codex');
const cwd = path.join(root, 'proj');
await mkdir(codexHome, { recursive: true });
await mkdir(cwd, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = codexHome;
process.env.WATCH_DB = path.join(root, 'watch.db');
process.env.WATCH_OPENCODE_DB = path.join(root, 'opencode.db');
process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');

const { importTurnsToCodex } = await import('../src/providers/codex/build.ts');
const { threadWriterLockPath, codexAdapter } = await import('../src/providers/codex/index.ts');
const { opencodeAdapter } = await import('../src/providers/opencode/index.ts');
const { checkOpenInProvider, openInProvider, openSession } = await import('../src/open.ts');

const pair = (n, provider) => [
  { role: 'user', text: `GUARD_P${n}`, timestamp: new Date(Date.UTC(2026, 8, 16, 9, n, 0)).toISOString() },
  {
    role: 'assistant',
    text: `GUARD_A${n}`,
    timestamp: new Date(Date.UTC(2026, 8, 16, 9, n, 30)).toISOString(),
    provider,
  },
];

/** 起真实 app-server 并返回 rpc 句柄（只做 initialize/thread/resume，不发 turn） */
async function startAppServer() {
  const child = spawn(
    'codex',
    ['-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', 'app-server', '--listen', 'stdio://'],
    { cwd, env: { ...process.env, HOME: home, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  let nextId = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const rpc = (method, params) => {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const initialized = await rpc('initialize', {
    clientInfo: { name: 'watch_codex_writer_guard', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  return { child, rpc, initialized };
}

async function lsofHolders(lockPath) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-Fpc', '--', lockPath], { timeout: 10_000 });
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)));
  } catch {
    return [];
  }
}

async function flockProbe(lockPath) {
  return execFileAsync('python3', ['-c', FLOCK_PROBE, lockPath], { timeout: 10_000 })
    .then((result) => result.stdout.trim())
    .catch(() => 'error');
}

let appServer;
try {
  const target = await importTurnsToCodex([...pair(1, 'codex'), ...pair(2, 'codex')], cwd);
  // 来源是目标的超集（多一对），使决策落到 reuse 且存在真实增量（否则会规划为“新建”，不触发锁探测）
  const source = await opencodeAdapter.importTurns(
    [...pair(1, 'opencode'), ...pair(2, 'opencode'), ...pair(3, 'opencode')],
    cwd,
  );
  const lockPath = threadWriterLockPath(target.sessionId, codexHome);
  const before = await codexAdapter.contentFingerprint(target);

  appServer = await startAppServer();
  const resumed = await appServer.rpc('thread/resume', { threadId: target.sessionId, cwd });
  record(
    '1 真实 codex 打开线程',
    !appServer.initialized.error && !resumed.error,
    resumed.error ? JSON.stringify(resumed.error).slice(0, 120) : `thread=${target.sessionId}`,
  );

  let holders = [];
  for (let attempt = 0; attempt < 20 && holders.length === 0; attempt++) {
    holders = await lsofHolders(lockPath);
    if (!holders.length) await sleep(500);
  }
  record('2 原生 writer 锁被真实进程持有', holders.length > 0, `holders=${JSON.stringify(holders)}`);

  const blocked = await openSession(target.sessionId, { from: source.sessionId });
  const after = await codexAdapter.contentFingerprint(target);
  record(
    '3 并发写被拒绝并报出真实持有者',
    blocked.ok === false &&
      blocked.blocked?.code === 'codex_target_busy' &&
      (blocked.blocked?.holders ?? []).some((holder) => holders.includes(holder.pid)),
    JSON.stringify(blocked.blocked ?? blocked.error),
  );
  record(
    '4 被拒绝时零写入（指纹一致）',
    before?.sha256 === after?.sha256 && before?.sizeBytes === after?.sizeBytes,
    `sha256=${after?.sha256?.slice(0, 12)}… size=${after?.sizeBytes}`,
  );

  const checked = await checkOpenInProvider(source.sessionId, 'codex');
  const afterCheck = await codexAdapter.contentFingerprint(target);
  record(
    '5 预检报 writable:false 且零写入',
    checked.ok === true && checked.writable === false && afterCheck?.sha256 === after?.sha256,
    `plan=${checked.plan?.kind} turns=${checked.plan?.turnCount} holders=${JSON.stringify(checked.blocked?.holders ?? [])}`,
  );

  appServer.child.kill('SIGKILL');
  appServer = undefined;
  await sleep(1200);
  const released = await openSession(target.sessionId, { from: source.sessionId });
  record('6 释放锁后写入成功', released.ok === true && (released.mergedTurns ?? 0) > 0, `merged=${released.mergedTurns}`);

  // 7) 协作写锁：Watch 独占锁文件期间，竞争 flock 必须 busy；释放后可再次取锁
  const ref = { provider: 'codex', sessionId: target.sessionId, filePath: target.filePath, cwd };
  const guard = await codexAdapter.acquireWriteLock({ ref });
  if (!guard) {
    const { existsSync } = await import('node:fs');
    record(
      '7 协作锁原子互斥',
      false,
      `协作锁不可用（lockExists=${existsSync(lockPath)} lockPath=${lockPath.replace(root, '<ROOT>')} python3=${existsSync('/usr/bin/python3')}）`,
    );
  } else {
    try {
      const guardianHolders = await lsofHolders(lockPath);
      const competing = await flockProbe(lockPath);
      record(
        '7 协作锁原子互斥（Watch 持锁 → 竞争 flock 失败）',
        competing === 'busy' && guardianHolders.includes(guard.holderPid),
        `probe=${competing} holders=${JSON.stringify(guardianHolders)} watchPid=${guard.holderPid}`,
      );
    } finally {
      await guard.release();
    }
    const afterRelease = await flockProbe(lockPath);
    record('8 释放后可再次取锁', afterRelease === 'acquired', `probe=${afterRelease}`);
  }

  // 9) 协作锁语义与原生一致：Watch 持锁期间真实 app-server 必须被拒（active writer）
  const duringGuard = await codexAdapter.acquireWriteLock({ ref });
  if (duringGuard) {
    const duringServer = await startAppServer();
    try {
      const refused = await Promise.race([
        duringServer.rpc('thread/resume', { threadId: target.sessionId, cwd }),
        sleep(7000).then(() => ({ __timeout: true })),
      ]);
      const message = refused.__timeout ? 'timeout' : JSON.stringify(refused.error ?? 'ok');
      record(
        '9 Watch 持协作锁时真实 codex 被拒（active writer）',
        refused.__timeout !== true && /active writer/.test(message),
        message.slice(0, 140),
      );
    } finally {
      duringServer.child.kill('SIGKILL');
      await duringGuard.release();
    }
  } else {
    record('9 Watch 持协作锁时真实 codex 被拒（active writer）', false, '协作锁不可用');
  }

  // 10) 协作锁不破坏原生路径：释放后真实 app-server 仍能打开线程
  const second = await startAppServer();
  try {
    const resumedAgain = await second.rpc('thread/resume', { threadId: target.sessionId, cwd });
    record(
      '10 释放后真实 codex 仍能打开同一线程',
      !resumedAgain.error,
      resumedAgain.error ? JSON.stringify(resumedAgain.error).slice(0, 120) : 'thread/resume ok',
    );
  } finally {
    second.child.kill('SIGKILL');
  }
} catch (error) {
  record('运行', false, error instanceof Error ? error.message : String(error));
} finally {
  appServer?.child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) {
  console.error(`失败：${failed.map((check) => check.name).join('；')}`);
  process.exit(1);
}
