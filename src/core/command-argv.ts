/** 三项 POSIX shell 包装可直接展示脚本；有额外参数时必须保留整个 argv。 */
export function isShellScriptArgv(argv: readonly string[]): boolean {
  return argv.length === 3 && /(?:^|[\\/])(?:bash|zsh|sh)$/.test(argv[0]!) && (argv[1] === '-c' || argv[1] === '-lc');
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
