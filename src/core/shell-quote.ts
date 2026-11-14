/**
 * 可复制命令里的引用。两个用途：
 * - 拼接 `cd <cwd> && <resume 命令>`（`open` / `handoff` 输出，用户会直接粘进终端）；
 * - 各适配器 `resumeCommand()` 里的会话 id。
 *
 * 会话 id 不是永远取自 UUID 字段：Pi 的 id 来自文件名、Kimi 的来自索引、Grok 的来自目录名，
 * 都可能是被改过 / 手工造出来的字符串。不引用的话 `pi --session id;touch X` 会在用户粘贴时
 * 执行第二条命令，而 `open` 正是唯一会直接印出 resume 命令的地方（它说的每条结论都要有对应披露）。
 */

/** 两种 shell 共用的保守字符集；PowerShell 的 @、逗号等也必须引用。 */
const SAFE = /^[A-Za-z0-9_.:/-]+$/;

/** 不需要引号就原样输出；否则按目标终端引用。Windows 使用 PowerShell。 */
export function quoteCommandArg(value: string, windows = process.platform === 'win32'): string {
  return SAFE.test(value) ? value : windows ? psQuote(value) : shellQuote(value);
}

/** POSIX 单引号包裹（含单引号转义）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 把 ASCII 与 U+2018–U+201B 都当成单引号，逐个双写并保留原字符。 */
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
}
