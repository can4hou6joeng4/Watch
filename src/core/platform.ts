// 跨平台辅助：路径归一化、大小写不敏感比较。
// 模式参考 trellis-card 的 src-tauri/src/platform.rs（to_posix / path_eq_ignore_case /
// strip_device_prefix / normalize_path）。工具函数只做字符串变换/比较，不做文件系统调用。
import { platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export const IS_WIN = platform() === 'win32';

/** 反斜杠统一为正斜杠，仅用于持久化键与字符串比较。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 去掉 Windows 设备路径前缀 `\\?\`（canonicalize 返回）；UNC 形式还原为普通 UNC 路径。 */
export function stripDevicePrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/**
 * canonicalize 语义的键归一：先去设备前缀，再统一正反斜杠。
 * 顺序不能反：`toPosix` 会把 `\\?\` 变成 `//?/`，此前缀不再匹配，前缀会留在键里。
 */
export function normalizePath(p: string): string {
  return toPosix(stripDevicePrefix(p));
}

/** 剥尾部 `/`/`\` 后做大小写不敏感比较（Windows 文件系统不区分大小写），其余平台精确比较。 */
export function cwdEq(a: string, b: string): boolean {
  const na = normalizePath(a).replace(/\/+$/, '');
  const nb = normalizePath(b).replace(/\/+$/, '');
  return IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
const cliCache = new Map<string, string>();

/**
 * 启动外部 CLI 失败的原因。spawn 错误带的是 `code: 'ENOENT'` / `'EACCES'`，与文件系统同码，
 * 直接交给 `describeWriteFailureReason()` 会被讲成「目标路径的上级目录不存在」——而这里真正缺的是
 * 那个命令本身。判据是 Node 挂在 spawn 错误上的 `syscall: 'spawn <cmd>'`；非 spawn 错误返回 null，
 * 由调用方走自己的翻译（如写盘失败）。
 */
export function describeSpawnFailure(error: unknown): string | null {
  const err = error as NodeJS.ErrnoException & { syscall?: string };
  const syscall = err?.syscall;
  if (typeof syscall !== 'string' || !syscall.startsWith('spawn')) return null;
  const cmd = syscall.slice('spawn'.length).trim() || err.path || '目标命令';
  switch (err.code) {
    case 'ENOENT':
      return `无法启动 ${cmd}：命令不存在（确认它已安装，且在 PATH 中）`;
    case 'EACCES':
    case 'EPERM':
      return `无法启动 ${cmd}：没有执行权限（检查该文件的权限，不是缺少安装）`;
    case 'ENOEXEC':
      return `无法启动 ${cmd}：文件存在但不是可执行格式（脚本缺少 shebang 或解释器，不是缺少安装）`;
    default:
      return `无法启动 ${cmd}（${err.code ?? '未知错误'}）`;
  }
}

/**
 * `detect()` 语义下「真的没装」的唯一判据：spawn 阶段 `ENOENT`（命令不在 PATH 里）。
 *
 * 六家适配器的 `detect()` 以前都是 `try { execFile(cli, ['--version']) } catch { return false }`，
 * 把「装了但起不来」（非零退出、没有执行权限、超时）一起讲成「未检测到」——用户会去重装
 * 一个其实装着、只是暂时坏了的 CLI，而 `broken` / `cli_detect_failed` 那一整套
 * （`listProviders()` 的 `error`、`watch providers` 的「检测失败」、`doctor` 的警告、
 * 桌面端 `providerDetectFailures()`）成了永远走不到的死代码。
 */
export function isCommandMissing(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { syscall?: string };
  return err?.code === 'ENOENT' && typeof err.syscall === 'string' && err.syscall.startsWith('spawn');
}

/** `detect()` 抛错时的中文原因：措辞要让人分清「没装」与「装了但坏了」 */
export function describeDetectFailure(name: string, error: unknown): string {
  const spawnReason = describeSpawnFailure(error);
  if (spawnReason) return spawnReason;
  const err = error as { code?: unknown; killed?: boolean; signal?: string | null; stderr?: string };
  // execFile 的 timeout / kill：没有退出码，只有 killed + signal
  if (err?.killed || (typeof err?.signal === 'string' && err.signal)) {
    return `${name} --version 超时或被终止${err?.signal ? `（信号 ${err.signal}）` : ''}——CLI 已安装但没有正常响应，先确认这个命令能直接在终端里跑完，不是没装`;
  }
  if (typeof err?.code === 'number') {
    const tail = String(err.stderr ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return `${name} --version 退出码 ${err.code}${tail ? `（CLI 输出：${tail}）` : ''}——CLI 已安装但启动失败，检查配置或登录状态，不是没装`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${name} --version 执行失败：${message}`;
}

/**
 * 解析 CLI 可执行名。Windows 上 npm 全局命令是 .cmd/.ps1 shim，
 * spawn/execFile 不带 shell 不走 PATHEXT，需用 where 解析出绝对路径
 * （优先 .exe/.cmd；.ps1 无法直接执行，跳过）。其它平台返回原名交给 PATH。
 */
export function resolveCli(name: string): string {
  if (!IS_WIN) return name;
  const hit = cliCache.get(name);
  if (hit) return hit;
  let resolved = name;
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    resolved = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? name;
  } catch {
    // where 失败保持原名，让调用方拿到原始 ENOENT
  }
  cliCache.set(name, resolved);
  return resolved;
}
