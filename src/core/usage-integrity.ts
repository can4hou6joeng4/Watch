import type { ProviderAdapter } from '../providers/adapter.js';
import { countUnparsableJsonLines } from './jsonl.js';
import type { SessionRef } from './types.js';

/**
 * 用量数据源里有无法解析的行时，给出一句「合计可能偏少」的说明；没有坏行返回 `null`。
 *
 * 各家 `sessionUsage` 都是逐行解析会话文件（grok 读的是同目录的 `updates.jsonl`，见适配器的
 * `sessionUsagePath()`），坏行一律 `continue` 跳过：被截断的最后一笔、被并发写坏的半行都不报错，
 * 于是 `watch usage` 的合计**静默偏少**，`open` 摘要里的 `usage` 与桌面端同样跟着少——两条通道
 * 都分不出「少算了」与「本来就这么多」。
 *
 * 内容这一侧早已披露过：`handoff()`（来源 / 目标）、`planOpenInProvider`、`openSession --from`
 * 都用 `countUnparsableJsonLines()` 说过「有 N 行无法解析，交接内容可能不完整」。这里补的是同一条
 * 线上**最后没接上的一半**：内容披露了，用量没有。判据仍是那一个函数，不另写一套扫描。
 *
 * opencode 是 SQLite（非 `.jsonl`），`countUnparsableJsonLines()` 直接返回 0，不会冒这句；
 * 文件不存在 / 读不出来也返回 0——那一档由调用方的错分支与 0 字节检查各自说清，不在这里重复。
 */
export async function usageBadLinesReason(
  adapter: ProviderAdapter,
  ref: SessionRef,
  label: string,
): Promise<string | null> {
  const filePath = adapter.sessionUsagePath?.(ref) ?? ref.filePath;
  const bad = await countUnparsableJsonLines(filePath);
  if (bad === 0) return null;
  return (
    `${label}的用量数据源 ${filePath} 有 ${bad} 行无法解析（截断或损坏），这些行的用量没有计入：` +
    `合计可能偏少——先确认该文件是否被截断（可从备份恢复），再以原生 CLI 显示的用量为准`
  );
}
