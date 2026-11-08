// 跨平台辅助：路径归一化、大小写不敏感比较、外部 CLI 的启动失败判定。
// 模式参考 trellis-card 的 src-tauri/src/platform.rs（to_posix / path_eq_ignore_case /
// strip_device_prefix / normalize_path）。纯字符串函数不做文件系统调用；`resolveCli()` 与
// `findExecutableOnPath()` 例外（前者调 where.exe，后者只在命令启动失败后查一次 PATH）。
import { platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

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
 * 在 PATH 上找一个**确实存在**的可执行文件，找到返回绝对路径，否则 null。
 *
 * 只用于区分「命令不存在」与「命令在、但它的 shebang 解释器不存在」——libuv 的 `uv_spawn`
 * 对这两种情况都返回 `ENOENT`，错误对象逐字节相同（`syscall: 'spawn kimi'`、`path: 'kimi'`），
 * 光看错误分不出来。同类问题见 nodejs/node#10008、cli/cli#2213、golang/go#12301。
 *
 * 判定故意保守：只认普通文件（`isFile()`），目录 / 设备文件即使同名也不算「装了」；
 * 任何 stat 失败都当「这一项没有」，继续看下一个 PATH 目录。返回 null 就是「找不到」，
 * 调用方据此保留原来的「没装」文案——查不出来时不能反过来讲成「坏了」。
 */
export function findExecutableOnPath(cmd: string): string | null {
  if (!cmd) return null;
  const dirs = cmd.includes('/') || (IS_WIN && cmd.includes('\\'))
    ? // 调用方给的是路径（Windows 的 resolveCli 会返回 where.exe 的绝对路径），只查这一个
      ['']
    : (process.env.PATH ?? process.env.Path ?? '').split(delimiter);
  // Windows 的可执行命令带扩展名，spawn 不带 shell 时不走 PATHEXT，这里自己补一遍
  const exts = IS_WIN
    ? ['', ...((process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = isAbsolute(cmd) || !dir ? cmd + ext : join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return resolve(candidate);
      } catch {
        // 这一项没有（ENOENT / ENOTDIR / EACCES 都一样）：继续找
      }
    }
  }
  return null;
}

/**
 * `detect()` 语义下「真的没装」的唯一判据：spawn 阶段 `ENOENT`，**且命令在 PATH 上找不到**。
 *
 * 六家适配器的 `detect()` 以前都是 `try { execFile(cli, ['--version']) } catch { return false }`，
 * 把「装了但起不来」（非零退出、没有执行权限、超时）一起讲成「未检测到」——用户会去重装
 * 一个其实装着、只是暂时坏了的 CLI，而 `broken` / `cli_detect_failed` 那一整套
 * （`listProviders()` 的 `error`、`watch providers` 的「检测失败」、`doctor` 的警告、
 * 桌面端 `providerDetectFailures()`）成了永远走不到的死代码。
 *
 * `ENOENT` 本身还不够：命令文件在、但 `#!` 解释器（`#!/usr/bin/env node`）不存在时，
 * libuv 同样报 `ENOENT`，错误对象与「命令不在 PATH 上」一模一样。所以要再查一次 PATH——
 * 文件在就说明这个 ENOENT 来自解释器，属于「装了但坏了」。
 */
export function isCommandMissing(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { syscall?: string };
  if (err?.code !== 'ENOENT' || typeof err.syscall !== 'string' || !err.syscall.startsWith('spawn')) return false;
  const cmd = err.syscall.slice('spawn'.length).trim() || (typeof err.path === 'string' ? err.path : '');
  // 命令文件在 PATH 上确实存在 → ENOENT 来自它的解释器 / 加载器，不是「没装」
  if (cmd && findExecutableOnPath(cmd)) return false;
  return true;
}

/**
 * 命令在 PATH 上、但 `execve` 直接失败时的中文说明（`ENOENT` 来自 shebang 解释器 / 动态加载器）。
 * 不是这种情形返回 null，调用方仍按「没装」处理。
 */
export function describeBrokenCommandStart(cmd: string): string | null {
  const found = findExecutableOnPath(cmd);
  if (!found) return null;
  return `${cmd} 已安装（${found}），但一启动就失败：命令文件在，它的 shebang 解释器（如 #!/usr/bin/env node 指向的程序）却不存在——修好这个文件或重新安装该 CLI，不是缺安装`;
}

/** `detect()` 抛错时的中文原因：措辞要让人分清「没装」与「装了但坏了」 */
export function describeDetectFailure(name: string, error: unknown): string {
  const err0 = error as NodeJS.ErrnoException & { syscall?: string };
  // 先单独认这一档：命令在、但 shebang 解释器不在（错误对象与「没装」完全相同）
  if (err0?.code === 'ENOENT' && typeof err0.syscall === 'string' && err0.syscall.startsWith('spawn')) {
    const cmd = err0.syscall.slice('spawn'.length).trim() || (typeof err0.path === 'string' ? err0.path : name);
    const broken = describeBrokenCommandStart(cmd);
    if (broken) return broken;
  }
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
