/**
 * 顶层兜底：`main()` 抛出的异常怎么报。
 *
 * 为什么要单独一层：`--json` 的契约是「成功与失败都向 stdout 输出单行 JSON」，Rust 桥与脚本
 * 都按这个契约解析。命令级 `fail()` 之外的异常（例如清单汇总、补充说明的读取逃出了各自的
 * try）以前只 `console.error(error)`，stdout 一个字节都没有——桥那边只能回「CLI 无输出,
 * exit=1」，既拿不到原因，也分不出「命令失败」与「进程崩了」（第 317 轮）。
 *
 * 三条边界：
 * - **已经写过 stdout 的命令不再补第二行**：那一行就是这次的结果，补一句会让「单行 JSON」
 *   变成两行，消费者拿到哪一行全看实现。
 * - 补的那行同样只有一行：错误消息里的换行与 C0 / C1 一律由 `JSON.stringify` 转义。
 * - 非 `Error` 的抛出（字符串、对象）也要有可读文案，不能输出 `{}`。
 *
 * 文本模式原先直接把异常对象交给 `console.error`，Node 会打印带换行的堆栈，消息里的 ESC
 * 也原样进终端（与 `fail()` 的转义口径不一致）。顶层兜底是最后一道终端出口，统一只写一行
 * 转义后的消息；排查仍以 `--json` 的单行错误为准。
 */

import { escapeControlChars } from './display.js';

export type FatalOptions = {
  /** 本次调用是否带 `--json` */
  json: boolean;
  /** 到抛错为止已经写进 stdout 的字节数（`process.stdout.bytesWritten`） */
  bytesWritten: number;
  /** 写一行 JSON（调用方负责在写完后再退出，避免管道下被截断） */
  writeJson: (line: string) => void;
  /** 文本模式的错误输出：已转义成单行，调用方直接写 stderr */
  writeError: (message: string) => void;
  exit: (code: number) => void;
};

/** 非 `Error` 的抛出（字符串、对象）也要有可读文案，不能输出 `{}` */
function fatalMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 返回实际走了哪条通道，便于测试断言，也便于调用方决定是否要额外清理。 */
export function handleFatal(error: unknown, options: FatalOptions): 'json' | 'stderr' {
  if (options.json && options.bytesWritten === 0) {
    options.writeJson(`${JSON.stringify({ ok: false, error: fatalMessage(error) })}\n`);
    options.exit(1);
    return 'json';
  }
  options.writeError(escapeControlChars(fatalMessage(error)));
  options.exit(1);
  return 'stderr';
}
