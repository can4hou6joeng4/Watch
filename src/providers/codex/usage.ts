import { readFile } from 'node:fs/promises';
import type { SessionRef, TokenUsage } from '../../core/types.js';
import { describeSessionReadFailure } from '../../core/read-text.js';

export async function codexSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let raw: string;
  try {
    raw = await readFile(ref.filePath, 'utf8');
  } catch (error) {
    // 读不出来不等于「这家原生没有 usage 字段」：交给调用方按原因披露（chainUsage / open 都会写进 warnings）
    throw new Error(describeSessionReadFailure(ref.filePath, error));
  }
  let last: TokenUsage | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // JSON 语法有效不等于消息对象有效：顶层 null / 数组 / 标量只跳过该行，
    // 其余有效累计继续读取；入口按共用坏行计数披露下界（与 Claude 用量同一档）。
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    const payload = rec.payload as Record<string, unknown> | undefined;
    const kind = payload?.type ?? rec.type;
    if (kind !== 'token_count') continue;
    const info = (payload?.info ?? rec.info) as Record<string, unknown> | undefined;
    const total = info?.total_token_usage ?? payload?.total_token_usage;
    const u = pick(total);
    if (u) last = u;
  }
  return last;
}

function pick(usage: unknown): TokenUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  // **0 不等于「有数据」**：`buildCodexLines()` 的 `closeTurn()` 在没有真实用量时仍会写一条
  // `token_count`（`input_tokens` / `output_tokens` 都是 0，只有 `total_tokens` 是可读内容的
  // 估算下界）。把它当成真实用量，`watch usage` 就会把「这条会话没有用量数据」报成
  // 「确实用了 0 token」，`totalMissingUsage` 也不计数。判据与 claude / kimi 两侧一致。
  // 逐条扫描 + 只保留最后一条非零的累计：Watch 写出的文件里，之后那些没有用量的 turn
  // 不会让累计倒退，所以这里跳过 0/0 不会丢掉前面已经累计到的真实用量。
  if (inputTokens === 0 && outputTokens === 0) return null;
  return { inputTokens, outputTokens };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
