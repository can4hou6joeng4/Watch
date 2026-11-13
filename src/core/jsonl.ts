import { escapeControlChars } from './display.js';
import { describePathReadFailureReason, isMissingPathError, iterateFileLines } from './read-text.js';

/**
 * 把任意反序列化值收窄为 JSON 普通对象；顶层 null、数组、标量一律返回 null。
 *
 * 与 `scanUnparsableJsonLines` 共用同一判据，防止调用点把 `null`/`[]`/标量当成有效消息或索引记录。
 */
export function asJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 解析单行 JSON 为普通对象；语法错误或非对象 JSON 值（null/数组/标量）统一返回 null。 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asJsonObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 单行是否计入「无法解析」：非空且不是 JSON 普通对象（语法坏行与 null/数组/标量同判据）。 */
export function isUnparsableJsonLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && parseJsonObject(trimmed) === null;
}

/** `scanUnparsableJsonLines()` 的结果：坏行数与「没扫成」的原因（两者可以同时成立）。 */
export type BadLinesScan = {
  /**
   * 已确认的坏行数。`error` 存在时它不是全文件的计数——出错前读到的行已经数过，
   * 但后面的没读到；调用方可以把两个事实一起说（「已确认 N 行，且未能数完」）。
   */
  count: number;
  /** 扫描没能完成的中文原因（已按 errno 分档）；缺省表示整份文件都扫完了。 */
  error?: string;
};

/**
 * 数一个 JSONL 文件里有多少非空行不是合法 JSON 对象。
 *
 * 各家 `parse` 对坏行一律「跳过继续」：截断的最后一笔、被并发写坏的半行都不会报错，
 * 而 round-trip 校验比对的是「解析后的来源」，跳过的部分在两边都不存在，查不出来。
 * 所以这里单独扫一遍，让调用方把「交接内容可能不完整」披露出去。
 *
 * **必须逐行流式**（2026-11-14，第 88 轮）：以前 `readFile(filePath, 'utf8')` 整份读取，
 * 超过 V8 字符串上限（约 512 MB）时抛 `Invalid string length`，被 `catch` 吞掉后返回 0——
 * 「没扫成」被讲成「没有坏行」，而 r84 的流式 parse 恰恰能正常读这种会话。现在与
 * `iterateFileLines()` 同一条流式路径，峰值内存降到一行。
 *
 * **读失败不抛、也不冒充 0**：文件不存在（`ENOENT` / `ENOTDIR`，grok 的 `updates.jsonl`
 * 缺失属正常事实）返回 0；其余读失败返回 `{ count, error }`，由调用方在 warnings /
 * findings 里披露「坏行无法统计」。这是辅助扫描，抛出去会把 `open` / `prompt` / `doctor` /
 * `search` 整条命令打挂，反而比缺一句披露更糟。只对 `*.jsonl` 有意义：kimi 是单文件 JSON、
 * opencode 是 SQLite，直接返回 0。
 */
export async function scanUnparsableJsonLines(filePath: string): Promise<BadLinesScan> {
  if (!filePath.endsWith('.jsonl')) return { count: 0 };
  let count = 0;
  try {
    for await (const line of iterateFileLines(filePath)) {
      if (isUnparsableJsonLine(line)) count++;
    }
    return { count };
  } catch (error) {
    // 缺失不是「坏行」，也不是故障：调用方自己的 stat / parse 分支负责说清文件去哪了
    if (isMissingPathError(error)) return { count: 0 };
    // 带上路径：这些披露句只给会话 id，不给路径的话「哪个文件读不出来」要靠猜
    return {
      count,
      error: `${describePathReadFailureReason(error)}：${escapeControlChars(filePath)}`,
    };
  }
}

/**
 * `scanUnparsableJsonLines()` 的严格版本：读失败直接抛错。
 *
 * 只给「已经确认文件可读」的调用方与测试用；所有用户面入口都应走 `scan` 并在
 * warnings / findings 里披露 `error`——辅助扫描不该因为一个文件读不出来就终止整条命令。
 */
export async function countUnparsableJsonLines(filePath: string): Promise<number> {
  const scan = await scanUnparsableJsonLines(filePath);
  if (scan.error) {
    throw new Error(`无法统计 ${escapeControlChars(filePath)} 的坏行：${scan.error}`);
  }
  return scan.count;
}

/**
 * 扫描没完成时的披露句；扫完了返回 `null`。
 *
 * `subject` 由调用方带上会话 / 链的标识（不含路径，路径在 `error` 前的场景里已由各处声明）；
 * `consequence` 说明「数不出坏行」在这次操作里意味着什么、下一步做什么——同一句
 * 「无法统计」在交接、增量判定、索引、对账里的后果不一样，不能一处写死。
 */
export function describeBadLinesScanFailure(
  scan: BadLinesScan,
  subject: string,
  consequence: string,
): string | null {
  if (!scan.error) return null;
  return `${subject}的坏行无法统计：${scan.error}；${consequence}`;
}
