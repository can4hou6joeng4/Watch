import type { ProviderAdapter } from '../providers/adapter.js';
import { escapeControlChars } from './display.js';
import { countUnparsableJsonLines } from './jsonl.js';
import { emptySessionFileReasonFromStat, sessionFilePresence } from './read-text.js';
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
  return (await usageBadLinesDetail(adapter, ref, label))?.reason ?? null;
}

/**
 * `usageBadLinesReason()` 的结构化版本：调用方既要那句完整说明，也要**行数**。
 *
 * `watch prompt` 把用量数字写进会被复制走的文档，披露句要短（括注在数字后面），而 stderr 上的
 * 警告要完整（带路径与下一步）——同一份扫描喂两个形状，不能为了短句再扫一遍文件。
 * 判据仍只有 `countUnparsableJsonLines()` 一处。
 */
export async function usageBadLinesDetail(
  adapter: ProviderAdapter,
  ref: SessionRef,
  label: string,
): Promise<{ count: number; reason: string } | null> {
  const filePath = adapter.sessionUsagePath?.(ref) ?? ref.filePath;
  const bad = await countUnparsableJsonLines(filePath);
  if (bad === 0) return null;
  return {
    count: bad,
    reason:
      `${label}的用量数据源 ${escapeControlChars(filePath)} 有 ${bad} 行无法解析（截断或损坏），这些行的用量没有计入：` +
      `合计可能偏少——先确认该文件是否被截断（可从备份恢复），再以原生 CLI 显示的用量为准`,
  };
}

/**
 * 用量来自**旁路文件**时（`sessionUsagePath(ref) !== ref.filePath`），查一次那个文件本身。
 * 没有旁路文件、或旁路文件就是 `ref.filePath`（绝大多数 provider）时返回 `null`。
 *
 * `sessionUsage` 返回 `null` 有两种含义：「这家原生没有用量记录」与「用量文件是空的」。
 * 消费方（`chainUsage()` 与 `open` 的三处）在 `null` 时会 `stat` 一次 `ref.filePath` 分开，
 * 但 grok 的用量在 `updates.jsonl` 而 `ref.filePath` 是 `chat_history.jsonl`——拿后者去判，
 * 健康的历史文件会把「用量文件已被截成 0 字节」照常判成 present + 非 0 字节，
 * 于是整份报告说「1 个无 usage 数据的会话」，把内容已丢失讲成「这家没有用量数据」
 * （两者的下一步相反：没有数据没什么可做，空文件只能从备份恢复）。
 *
 * **旁路文件不存在是正常事实**（grok 的快照 / 更老会话只有 chat_history，没有 updates.jsonl），
 * 这一档必须保持「没有用量记录」，不能冒「文件丢了」——所以只有 `unknown` / 非普通文件 /
 * 0 字节三档返回原因。
 */
export async function usageSidecarProblem(
  adapter: ProviderAdapter,
  ref: SessionRef,
  label: string,
): Promise<string | null> {
  const usagePath = adapter.sessionUsagePath?.(ref);
  if (!usagePath || usagePath === ref.filePath) return null;
  const presence = await sessionFilePresence(usagePath);
  if (presence.state === 'missing') return null;
  if (presence.state === 'unknown') {
    return (
      `${label}的用量数据源 ${escapeControlChars(usagePath)} 状态无法确认：${presence.reason}；` +
      `合计可能偏少——先确认该文件可读再重试`
    );
  }
  if (!presence.isFile) {
    return (
      `${label}的用量数据源 ${escapeControlChars(usagePath)} 现在不是普通文件（被同名目录或设备文件占住了）；` +
      `合计可能偏少——先恢复该路径再重试`
    );
  }
  const emptied = emptySessionFileReasonFromStat(
    { isFile: () => presence.isFile, size: presence.size },
    usagePath,
    '用量数据源',
  );
  if (!emptied) return null;
  return (
    `${label}的${emptied}；合计已经少了它的用量——如果它本该有数据，` +
    `先从备份恢复该文件再重试（Watch 不会替你重建用量）`
  );
}
