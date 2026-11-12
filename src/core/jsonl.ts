import { readFile } from 'node:fs/promises';

/**
 * 把任意反序列化值收窄为 JSON 普通对象；顶层 null、数组、标量一律返回 null。
 *
 * 与 `countUnparsableJsonLines` 共用同一判据，防止调用点把 `null`/`[]`/标量当成有效消息或索引记录。
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

/**
 * 数一个 JSONL 文件里有多少非空行不是合法 JSON 对象。
 *
 * 各家 `parse` 对坏行一律「跳过继续」：截断的最后一笔、被并发写坏的半行都不会报错，
 * 而 round-trip 校验比对的是「解析后的来源」，跳过的部分在两边都不存在，查不出来。
 * 所以这里单独扫一遍，让调用方把「交接内容可能不完整」披露出去。
 *
 * 只对 `*.jsonl` 有意义：kimi 是单文件 JSON、opencode 是 SQLite，直接返回 0。
 */
export async function countUnparsableJsonLines(filePath: string): Promise<number> {
  if (!filePath.endsWith('.jsonl')) return 0;
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    // 读不到文件不在这里报：调用方的 parse 会给出 ENOENT / 截断的具体原因
    return 0;
  }
  let bad = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!parseJsonObject(trimmed)) bad++;
  }
  return bad;
}
