import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionRef, TokenUsage } from '../../core/types.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { describeSessionReadFailure, isMissingPathError } from '../../core/read-text.js';

/**
 * 用量所在的旁路文件：与 `chat_history.jsonl` 同目录的 `updates.jsonl`。
 *
 * 适配器的 `sessionUsagePath()` 用它，供 `watch usage` / `open` 核对「这个文件里有没有
 * 无法解析的行」——拿 `ref.filePath`（`chat_history.jsonl`）去数会看错对象。
 */
export function grokUpdatesPath(ref: SessionRef): string {
  return join(dirname(ref.filePath), 'updates.jsonl');
}

/**
 * Grok 会话用量（信息层）：累加 `updates.jsonl` 里每条 ACP `turn_completed` 的 `usage`。
 *
 * 用量不在 `chat_history.jsonl`（那是发给模型的原始消息，`parse` 读的那份），而在同目录的
 * `updates.jsonl`——它是原生 `/resume` 与 session restore 的权威日志（grok 内置文档
 * `docs/user-guide/17-sessions.md`），Watch 的写出侧 `buildGrokUpdateLines()` 也正是把
 * `turn.usage` 写进每个 user 轮末尾那条 `turn_completed` 里
 * （`usage: { inputTokens, outputTokens, totalTokens }`）。
 *
 * 以前这个适配器的 `sessionUsage` 是一条常量 `return null`，于是 **Watch 自己转出的** grok 会话
 * 也被报成「原生没有 usage 字段」：`watch usage` 的合计里少了它，`totalMissingUsage` 却把它
 * 算成「没有用量数据」，文本模式还说「未含 N 个无 usage 数据的会话」——把「明明写进去了」
 * 讲成「这家没有」。同族前例：kimi 的 `step.end.usage`（watch 写出侧）读取侧一度只认
 * 原生 `usage.record`，同样把自转会话报成无数据。
 *
 * 这里没有 kimi 那种歧义（同一轮既有 `usage.record` 又有 `step.end`）：写出侧每个 assistant
 * 轮**恰好写一条** `turn_completed`，逐条累加即准确值，无需去重、不会重复计入。
 *
 * 0/0 仍是占位（`turn.usage` 缺失时写出侧落 0/0），与 claude / codex / kimi 同一口径跳过。
 * `updates.jsonl` 不存在是正常事实（只有 chat_history 的快照 / 更老的原生会话），返回 `null`
 * 表示「没有用量记录」；其余读不出来照常抛错，由 `chainUsage` 记成「读取失败」而不是「无数据」。
 */
export async function grokSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  const usages = await grokUpdateTurnUsages(grokUpdatesPath(ref));
  if (!usages || usages.length === 0) return null;
  let input = 0;
  let output = 0;
  for (const u of usages) {
    input += u.inputTokens;
    output += u.outputTokens;
  }
  return { inputTokens: input, outputTokens: output };
}

/**
 * `updates.jsonl` 里每条 ACP `turn_completed` 的用量，**按出现顺序**返回。
 *
 * 信息层（`grokSessionUsage` 求和）与搬运层（`parseGrokSession` 逐轮挂到 assistant 上）
 * 必须读同一份、同一个口径：两边各写一套时，`open --to <provider>` 的 note 会写
 * 「来源 Grok 用量 in=700 out=70（已在对账中携带）」，而写进目标会话的是 0/0——
 * 搬运层根本没读这个文件。这与 claude 缓存两块、codex `last_token_usage` 完全同源。
 *
 * 文件不存在是正常事实（只有 chat_history 的快照 / 更老的原生会话）返回 null；
 * 其余读不出来照常抛错，由 `chainUsage` 记成「读取失败」而不是「无数据」。
 */
export async function grokUpdateTurnUsages(updatesPath: string): Promise<TokenUsage[] | null> {
  const scan = await grokUpdateScan(updatesPath);
  return scan ? scan.usages : null;
}

/**
 * `updates.jsonl` 的单次扫描结果：逐轮用量 + 上下文压缩次数。
 *
 * 搬运层需要两者（用量挂到 assistant 轮，压缩次数写成上下文披露），却只该读一遍文件：
 * 分开读会让同一条会话在大文件上多付一次 IO，也让「文件读不出来」出现两种处理方式。
 * 信息层仍只关心用量，经 `grokUpdateTurnUsages()` 取 `usages`。
 */
export type GrokUpdateScan = { usages: TokenUsage[]; compactions: number; badLines: number };

export async function grokUpdateScan(updatesPath: string): Promise<GrokUpdateScan | null> {
  let raw: string;
  try {
    raw = await readFile(updatesPath, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new Error(describeSessionReadFailure(updatesPath, error));
  }
  const usages: TokenUsage[] = [];
  let compactions = 0;
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseJsonObject(line);
    if (!rec) {
      badLines += 1;
      continue;
    }
    const params = asRecord(rec.params);
    const update = asRecord(params?.update) ?? asRecord(rec.update);
    if (!update) continue;
    if (update.sessionUpdate === 'compaction_checkpoint') {
      // Grok 每次压缩上下文都写一条；摘要正文在会话目录的 compaction_checkpoints/ 旁路文件里，
      // 格式未经验证，这里只计数、不读也不拼进交接（见 parseGrokSession 的披露）。
      compactions += 1;
      continue;
    }
    if (update.sessionUpdate !== 'turn_completed') continue;
    const u = pick(update.usage);
    if (!u) continue;
    usages.push(u);
  }
  return { usages, compactions, badLines };
}

function pick(usage: unknown): TokenUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  // 写出侧用 camelCase（`inputTokens` / `outputTokens`）；同时认 snake_case，
  // 免得将来原生换了字段名就整条静默变成「无用量」
  const input = num(u.inputTokens) ?? num(u.input_tokens);
  const output = num(u.outputTokens) ?? num(u.output_tokens);
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  // **0 不等于「有数据」**：来源 turn 没有用量时写出侧仍写 `{ inputTokens: 0, outputTokens: 0 }`，
  // 把它当成真实用量，`watch usage` 就会把「这条会话没有用量数据」报成「确实用了 0 token」。
  // 判据与 claude / codex / kimi 一致。
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
