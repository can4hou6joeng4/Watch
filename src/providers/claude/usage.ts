import { readFile } from 'node:fs/promises';
import type { SessionRef, TokenUsage } from '../../core/types.js';
import { describeSessionReadFailure } from '../../core/read-text.js';

export async function claudeSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let raw: string;
  try {
    raw = await readFile(ref.filePath, 'utf8');
  } catch (error) {
    // 读不出来不等于「这家原生没有 usage 字段」：交给调用方按原因披露（chainUsage / open 都会写进 warnings）
    throw new Error(describeSessionReadFailure(ref.filePath, error));
  }
  let input = 0;
  let output = 0;
  let hit = false;
  // 同一条 assistant 回复按 content block 拆成多行写进 jsonl（thinking / text / tool_use 各一行），
  // **每一行都带同一份完整 usage**，逐行累加会把一条消息算 2～4 次。实测 39005 条里同一
  // `message.id` 的 usage 逐字相同（0 条不同），所以按首份去重是无损的。
  // 没有 `message.id` 的记录（如顶层的 `result.usage`）照旧各自累加——那本来就是不同的计数。
  const seenMessageIds = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = rec.message as Record<string, unknown> | undefined;
    const u = pick(rec.usage) ?? pick(message?.usage);
    if (!u) continue;
    const messageId = typeof message?.id === 'string' && message.id ? message.id : null;
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    hit = true;
    input += u.inputTokens;
    output += u.outputTokens;
  }
  return hit ? { inputTokens: input, outputTokens: output } : null;
}

function pick(usage: unknown): TokenUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  // `input_tokens` 只是**未命中缓存的增量**，真实输入量是三块之和：未命中 + 写入缓存 + 命中缓存。
  // ccusage（ccusage/ccusage，19.4k stars）把这三块分成 Input / Cache Create / Cache Read 三列
  // 展示（README: "Tracks and displays cache creation and cache read tokens separately"），
  // 本仓库的 kimi 适配器也早就是这个口径（`inputOther + inputCacheRead + inputCacheCreation`）。
  // 本机只读采样：47 个 Claude 会话里漏掉 cache 两块会让输入量只有真实值的 1/42.6。
  // 注意 `cache_creation` 是 `{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` 分档明细，
  // 它的合计已由 `cache_creation_input_tokens` 给出，**不能**再加一遍。
  const cacheCreate = num(u.cache_creation_input_tokens) ?? 0;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const inputTokens = (input ?? 0) + cacheCreate + cacheRead;
  const outputTokens = output ?? 0;
  // **0 不等于「有数据」**：`buildClaudeLines()` 给每一行都写
  // `usage: { input_tokens: turn.usage?.inputTokens ?? 0, ... }`——来源 turn 没有用量时
  // 落成 0/0 占位。把它当成真实用量，`watch usage` 就会把「这条会话没有用量数据」报成
  // 「确实用了 0 token」（`usage: {0,0}`，且 `totalMissingUsage` 不计数、合计里少了提示）。
  // 判据与 kimi 的 `usageFromRecord()`（0/0 → undefined）以及 `phuryn/claude-usage`（2292★）
  // 的 `scanner.py`（"Only record turns that have actual token usage"）一致。
  // 注意按**合计**判：只有缓存命中的记录 input/output 都是 0，但 cache 两块非零，不能被误丢。
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
