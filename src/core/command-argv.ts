/** 旧版 Codex `shell` 的 `command` 是字符串数组；只接受非空纯字符串数组，其余形状不猜。 */
export function commandArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((v): v is string => typeof v === 'string')) return undefined;
  return value;
}

/**
 * POSIX shell 包装里的脚本：`bash|zsh|sh` + `-c|-lc`。额外 argv 只是脚本的位置参数
 * （`$0`、`$1`…），脚本仍会执行，所以扫描补丁标记时不能要求恰好三项。
 */
export function shellScriptOf(argv: readonly string[]): string | undefined {
  if (argv.length < 3) return undefined;
  if (!/(?:^|[\\/])(?:bash|zsh|sh)$/.test(argv[0]!)) return undefined;
  if (argv[1] !== '-c' && argv[1] !== '-lc') return undefined;
  return argv[2]!;
}

/** 三项 POSIX shell 包装可直接展示脚本；有额外参数时必须保留整个 argv。 */
export function isShellScriptArgv(argv: readonly string[]): boolean {
  return argv.length === 3 && shellScriptOf(argv) !== undefined;
}

/** 旧版 shell 的 apply_patch 直传形式：argv 恰好是 [apply_patch, 补丁正文]（官方 maybe_parse_apply_patch）。 */
export function isPatchArgv(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === 'apply_patch';
}

/** 只生成可读文本，不执行命令；普通 argv 的空参数与 shell 元字符保留引用边界。 */
export function formatCommandArgv(argv: readonly string[]): string {
  if (isShellScriptArgv(argv)) return argv[2]!;
  return argv.map(arg => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
}
