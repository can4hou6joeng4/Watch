import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codexDir } from './build.js';

const execFileAsync = promisify(execFile);

/** 原生 per-thread writer 锁路径：`<codexHome>/thread-writer-locks/<thread-id>.lock`（0 字节 flock 文件） */
export function threadWriterLockPath(sessionId: string, codexHome = codexDir()): string {
  return path.join(codexHome, 'thread-writer-locks', `${sessionId}.lock`);
}

export type WriterHolder = { pid: number; command: string };

export function parseLsofHolders(stdout: string): WriterHolder[] {
  const holders: WriterHolder[] = [];
  let pid: number | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid) {
      holders.push({ pid, command: line.slice(1) });
      pid = undefined;
    }
  }
  return holders;
}

/**
 * 探测 writer 锁的当前持有者。
 * 返回 [] = 无人持有（陈旧锁/进程已退出）；null = 探测不可用（lsof 缺失或异常），调用方应回退。
 */
export async function probeThreadWriterHolders(lockPath: string): Promise<WriterHolder[] | null> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-Fpc', '--', lockPath], { timeout: 10_000 });
    return parseLsofHolders(stdout);
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown };
    if (err.code === 1) return []; // lsof: 无匹配
    if (typeof err.stdout === 'string' && err.stdout.trim()) return parseLsofHolders(err.stdout);
    return null;
  }
}

/**
 * 协作写锁 helper：用 python3 的 `fcntl.flock(LOCK_EX | LOCK_NB)` 持有原生锁文件。
 *
 * Node 没有 flock API，而 macOS 没有 `flock(1)`；python3 随 macOS/多数 Linux 自带。
 * 持有期间原生 writer（codex 进程）无法取得同一把锁，从而把「探测 → 写入」之间的
 * 竞态窗口收窄为「原子取锁」。helper 退出（正常或被杀）由内核自动释放锁。
 */
const PY_HELPER = [
  'import fcntl, os, sys',
  'path = sys.argv[1]',
  'fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)',
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except OSError:',
  "    print('busy', flush=True)",
  '    sys.exit(3)',
  "print('locked', flush=True)",
  'sys.stdin.buffer.read()',
  'fcntl.flock(fd, fcntl.LOCK_UN)',
].join('\n');

export type WriterLockGuard = { release(): Promise<void>; holderPid?: number };

function closeChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}

/** 读取子进程第一行（locked/busy）；超时或不可用返回 null */
async function readFirstLine(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  const stdout = child.stdout;
  if (!stdout) return null;
  stdout.setEncoding('utf8');
  return new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => {
      closeChild(child);
      resolve(null);
    }, timeoutMs);
    const done = (value: string | null) => {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) done(buffer.slice(0, index).trim());
    };
    const onError = () => done(null);
    stdout.on('data', onData);
    child.once('error', onError);
  });
}

/**
 * 尝试以协作方式取得目标会话的原生 writer 锁。
 * - 返回 guard：已独占持有，写入完成后必须 release()
 * - 返回 undefined：机制不可用（无 python3 / 平台不支持）→ 调用方退回「只探测」的旧行为
 * - 抛错：锁已被别的 writer 持有（探测与取锁之间的竞态）→ 调用方应拒绝写入
 */
export async function acquireThreadWriterLock(lockPath: string): Promise<WriterLockGuard | undefined> {
  // 原生锁文件在 writer 退出时会被删除，所以不能“只在文件存在时取锁”：
  // 按需创建目录/文件后取 flock。实测真实 app-server 会因我们持锁而拒绝
  // `thread/resume`（`thread … already has an active writer`），释放后恢复可打开。
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    return undefined;
  }
  const child = spawn('python3', ['-c', PY_HELPER, lockPath], { stdio: ['pipe', 'pipe', 'ignore'] });
  const first = await readFirstLine(child, 5_000);
  if (first === 'locked') {
    return {
      holderPid: child.pid,
      release: async () => {
        try {
          child.stdin?.end();
        } catch {
          /* ignore */
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            closeChild(child);
            resolve();
          }, 3_000);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }
  closeChild(child);
  if (first === 'busy') throw new Error('writer lock is held by another process');
  return undefined; // 无 python3 或超时：机制不可用
}
