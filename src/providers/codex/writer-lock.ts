import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describeWriteFailureReason } from '../../core/atomic.js';
import { escapeControlChars } from '../../core/display.js';
import { codexDir } from './build.js';

const execFileAsync = promisify(execFile);

/**
 * 锁目录 / 锁文件准备失败（权限、同名文件占位、磁盘满）：与「没有 python3」不同，
 * 这是可修的环境故障，调用方必须把它披露成 warning，而不是当成机制不存在静默降级。
 * `phase` 区分是哪一步失败——目录已存在但不可写时 mkdir 是空操作，失败发生在 helper 打开锁文件。
 */
export class WriterLockDirError extends Error {
  constructor(
    public lockPath: string,
    cause: unknown,
    phase: 'dir' | 'file' = 'dir',
  ) {
    const reason = describeWriteFailureReason(cause) ?? (cause instanceof Error ? cause.message : String(cause));
    super(
      phase === 'dir'
        ? `无法准备 Codex 写锁目录（${escapeControlChars(path.dirname(lockPath))}）：${reason}`
        : `无法准备 Codex 写锁文件（${escapeControlChars(lockPath)}）：${reason}`,
    );
    this.name = 'WriterLockDirError';
  }
}

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
 *
 * 用 `-I` 启动：`python3 -c` 的 `sys.path[0]` 默认是进程 CWD，项目目录里一个同名
 * `fcntl.py` 就能顶替标准库——实测它把 flock 定义成空操作后 helper 仍打印 locked，
 * Watch 会相信「已独占原生锁」而实际什么都没锁；抛错则让 helper 无输出退出、
 * 锁静默消失。`-I` 同时忽略 PYTHON* 环境变量与 user site。
 */
const PY_HELPER = [
  'import errno, fcntl, os, sys',
  'def code(e):',
  '    return errno.errorcode.get(e.errno) or str(e.errno)',
  'path = sys.argv[1]',
  // 打开锁文件失败（目录已存在但不可写 / 同名目录占位 / 磁盘满）必须显式报告：
  // 否则 helper 带着 traceback 退出，stdout 一个字都没有，调用方只能等满超时并把它
  // 当成「机制不可用」——与第 302 轮「目录故障必须披露」的口径相反。errno 一并带出，
  // 让调用方给出真实原因（EMFILE 与 ENOSPC 的下一步完全不同）。
  'try:',
  '    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)',
  'except OSError as e:',
  "    print('unavailable:' + code(e), flush=True)",
  '    sys.exit(4)',
  // flock 的 OSError 不能一律报 busy：EAGAIN/EACCES 是「别人持有」，而 ENOLCK/ENOTSUP
  // （SMB / NFS / exFAT 一类不支持文件锁的挂载）报 busy 会让用户对着「稍后重试」永远重试，
  // 预检还同时说可写——正是仓库修过两次的「预检与写入结论相反」。其余 errno 按可修故障披露。
  'try:',
  '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except OSError as e:',
  '    if e.errno in (errno.EACCES, errno.EAGAIN, getattr(errno, "EWOULDBLOCK", errno.EAGAIN)):',
  "        print('busy', flush=True)",
  '        sys.exit(3)',
  "    print('unavailable:' + code(e), flush=True)",
  '    sys.exit(4)',
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

/** 读取子进程第一行（locked/busy/unavailable）；超时或不可用返回 null */
async function readFirstLine(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  const stdout = child.stdout;
  if (!stdout) return null;
  stdout.setEncoding('utf8');
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      closeChild(child);
      resolve(null);
    }, timeoutMs);
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      resolve(value);
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) done(buffer.slice(0, index).trim());
    };
    const onError = () => done(null);
    // helper 在打印任何东西之前就退出（解释器缺失以外的启动失败、崩溃）时，
    // 只等 stdout 会白等满 5 秒；'close' 一到就用已有输出结算（无输出即 null）。
    const onClose = () => {
      const index = buffer.indexOf('\n');
      done(index >= 0 ? buffer.slice(0, index).trim() : buffer.trim() || null);
    };
    stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

/** helper 报告的 lock errno → 中文原因（真原因在前，下一步才落得住） */
function lockFailureReason(raw: string | null): string {
  const code = (raw ?? '').trim().toUpperCase();
  const detail =
    code === 'EACCES' || code === 'EPERM'
      ? '权限不足（锁目录或锁文件拒绝写入）'
      : code === 'ENOENT'
        ? '锁文件或它的上级目录在准备期间消失'
        : code === 'ENOSPC'
          ? '磁盘空间不足'
          : code === 'EROFS'
            ? '文件系统是只读的'
            : code === 'EISDIR'
              ? '锁路径被同名目录占住了'
              : code === 'EMFILE' || code === 'ENFILE'
                ? '打开的文件数达到上限'
                : code === 'ENOLCK' || code === 'ENOTSUP' || code === 'EOPNOTSUPP'
                  ? '这个文件系统不支持文件锁，协作写锁无法生效'
                  : code
                    ? `失败原因代码 ${code}`
                    : '权限、同名目录占位或磁盘空间不足';
  return `无法创建或打开锁文件：${detail}`;
}

/**
 * 尝试以协作方式取得目标会话的原生 writer 锁。
 * - 返回 guard：已独占持有，写入完成后必须 release()
 * - 返回 undefined：机制不可用（无 python3 / 平台不支持 / helper 无输出就退出）→ 调用方退回「只探测」的旧行为
 * - 抛错：锁已被别的 writer 持有（探测与取锁之间的竞态）→ 调用方应拒绝写入；
 *   `WriterLockDirError` 是可修故障 → 调用方降级为警告后继续写入
 */
export async function acquireThreadWriterLock(lockPath: string): Promise<WriterLockGuard | undefined> {
  // 原生锁文件在 writer 退出时会被删除，所以不能“只在文件存在时取锁”：
  // 按需创建目录/文件后取 flock。实测真实 app-server 会因我们持锁而拒绝
  // `thread/resume`（`thread … already has an active writer`），释放后恢复可打开。
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    // 以前这里静默 `return undefined`：锁目录权限坏了 / 被同名文件占住 / 磁盘满时，
    // 协作写锁整条消失却没有任何警告。抛专用错误让调用方区分「机制不可用」与「可修的降级」。
    throw new WriterLockDirError(lockPath, error);
  }
  const child = spawn('python3', ['-I', '-c', PY_HELPER, lockPath], { stdio: ['pipe', 'pipe', 'ignore'] });
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
  if (first?.startsWith('unavailable')) {
    // 锁文件建不出来 / 文件系统不支持 flock：与 mkdir 失败同一档（可修故障），
    // 不能用「机制不可用」静默吞掉；errno 决定下一步（权限 / 空间 / 换文件系统）。
    const code = first.includes(':') ? first.slice(first.indexOf(':') + 1).trim() : '';
    throw new WriterLockDirError(lockPath, new Error(lockFailureReason(code || null)), 'file');
  }
  if (first) {
    // 非空但认不出的首行（标准库被顶替、解释器包装脚本改写了输出）：同样不能说成
    // 「机制不可用」——那等于放行一次没有任何锁保护的写入且不留痕迹。
    throw new WriterLockDirError(
      lockPath,
      new Error(`锁 helper 输出了无法识别的结果：${escapeControlChars(first)}`),
      'file',
    );
  }
  return undefined; // 无 python3、超时或 helper 无输出就退出：确实无法判定，按机制不可用
}
