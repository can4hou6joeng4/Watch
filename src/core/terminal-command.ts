import { hasControlChars } from './display.js';

/** shell 引用只能保护分词；键入型终端还会先解释 Ctrl-C / Ctrl-U 等按键。 */
export function terminalTextProblem(...values: string[]): string | null {
  return values.some(hasControlChars)
    ? '内容含控制字符（换行、制表符、ESC 等），终端可能把它们解释为按键或控制序列；请核对会话 ID 与工作目录，改用不含控制字符的值'
    : null;
}

/** 在任何剪贴板 / 终端 API 调用前检查，拒绝时不把原始内容拼进错误。 */
export function assertTerminalTextSafe(...values: string[]): void {
  const problem = terminalTextProblem(...values);
  if (problem) throw new Error(`${problem}；已停止起航和复制`);
}

/** JSON 保留原值，文本命令转义展示；两条通道都要披露交付限制。 */
export function commandControlWarnings(...commands: string[]): string[] {
  const problem = terminalTextProblem(...commands);
  return problem ? [`恢复命令${problem}；文本输出已转义，仅供核对，不能直接复制执行；JSON 命令字段保留原值，也不能直接交给终端或剪贴板`] : [];
}
