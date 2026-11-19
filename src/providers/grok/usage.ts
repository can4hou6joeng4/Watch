import { iterateFileLines } from '../../core/read-text.js';
import { dirname, join } from 'node:path';
import type { SessionRef, TokenUsage } from '../../core/types.js';
import { escapeControlChars } from '../../core/display.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { describeSessionReadFailure, isMissingPathError } from '../../core/read-text.js';
import { createGrokFailureCounts, readGrokRetryState, readGrokTurnCompleted, type GrokFailureCounts } from './failure.js';

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
 * `updates.jsonl` 的单次扫描结果：逐轮用量 + 上下文压缩次数 + 失败 / 重试计数。
 *
 * 搬运层需要三者（用量挂到 assistant 轮，压缩次数与失败计数写成上下文披露），却只该读一遍文件：
 * 分开读会让同一条会话在大文件上多付一次 IO，也让「文件读不出来」出现多种处理方式。
 * 信息层仍只关心用量，经 `grokUpdateTurnUsages()` 取 `usages`。
 */
/**
 * `updates.jsonl` 里 `sessionUpdate` 的已知类型（第 254 轮）。
 *
 * 本机 24 个 updates.jsonl、13389 条记录的只读采样（只统计类型名与计数）里有 23 种：
 * 对话镜像（user_message_chunk / agent_thought_chunk / agent_message_chunk / tool_call /
 * tool_call_update）、已有读取器（turn_completed / retry_state / compaction_checkpoint）、
 * 以及元数据 / 后台任务 / 记忆整理 / 压缩 / 子代理记账。对话本体以 chat_history.jsonl 为准，
 * 镜像类有意不并入；表外类型按 type 计数并披露。新增已知类型必须先采样或对上游核对。
 */
const KNOWN_GROK_UPDATE_TYPES = new Set([
  'user_message_chunk',
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'turn_completed',
  'retry_state',
  'compaction_checkpoint',
  'task_backgrounded',
  'task_completed',
  'background_tasks',
  'session_recap',
  'plan',
  'memory_dream_queued',
  'memory_dream_started',
  'memory_dream_completed',
  'rewind_marker',
  'auto_compact_started',
  'auto_compact_completed',
  'current_mode_update',
  'image_dropped',
  'subagent_spawned',
  'subagent_finished',
]);

export type GrokUpdateScan = {
  usages: TokenUsage[];
  compactions: number;
  badLines: number;
  failures: GrokFailureCounts;
  /** `rewind_marker` 条数：回退改变 Grok 当前可见的上下文，Watch 不重建投影，只披露。 */
  rewinds: number;
  /** `image_dropped` 条数：Grok 明确丢弃了图片，那些图片不会出现在任何日志里。 */
  imagesDropped: number;
  /** 表外 `sessionUpdate` 类型 → 条数（类型名已转义、截断）。 */
  unknownUpdates: Map<string, number>;
};

export async function grokUpdateScan(updatesPath: string): Promise<GrokUpdateScan | null> {
  const usages: TokenUsage[] = [];
  const failures = createGrokFailureCounts();
  let compactions = 0;
  let badLines = 0;
  let rewinds = 0;
  let imagesDropped = 0;
  const unknownUpdates = new Map<string, number>();
  try {
    // 逐行流式读取：ACP `updates.jsonl` 连流式增量都逐条落盘，整份 `readFile` 在超过
    // V8 字符串上限（约 512 MB）时抛 `Invalid string length`——那会被讲成「读取失败」，
    // 而流式读取没有这个限制；缺失文件仍是「只有 chat 快照」这一档，返回 null
    for await (const line of iterateFileLines(updatesPath)) {
      if (!line.trim()) continue;
      const rec = parseJsonObject(line);
      if (!rec) {
        badLines += 1;
        continue;
      }
      const params = asRecord(rec.params);
      const update = asRecord(params?.update) ?? asRecord(rec.update);
      if (!update) continue;
      const updateType =
        typeof update.sessionUpdate === 'string' && update.sessionUpdate ? update.sessionUpdate : null;
      if (updateType === 'rewind_marker') {
        // 回退会改变 Grok 下一次请求实际携带的上下文；Watch 没有回退投影，只计数披露。
        rewinds += 1;
        continue;
      }
      if (updateType === 'image_dropped') {
        // Grok 自己丢弃的图片不会出现在 chat_history / 任何日志里，只能按事件披露。
        imagesDropped += 1;
        continue;
      }
      if (updateType === 'compaction_checkpoint') {
        // Grok 每次压缩上下文都写一条；摘要正文在会话目录的 compaction_checkpoints/ 旁路文件里，
        // 格式未经验证，这里只计数、不读也不拼进交接（见 parseGrokSession 的披露）。
        compactions += 1;
        continue;
      }
      if (updateType === 'retry_state') {
        // 独立 update 类型（不是 turn_completed 的字段）；`reason` 带完整上游 URL，
        // 只认 `error_type` 这个枚举（见 failure.ts）。
        readGrokRetryState(update, failures);
        continue;
      }
      if (updateType !== 'turn_completed') {
        if (!updateType) {
          unknownUpdates.set('（缺少 sessionUpdate）', (unknownUpdates.get('（缺少 sessionUpdate）') ?? 0) + 1);
        } else if (!KNOWN_GROK_UPDATE_TYPES.has(updateType)) {
          const label = escapeControlChars(updateType.length > 64 ? `${updateType.slice(0, 64)}…` : updateType);
          unknownUpdates.set(label, (unknownUpdates.get(label) ?? 0) + 1);
        }
        continue;
      }
      // 结束原因与用量各读各的：失败轮可能没有 usage，有 usage 的轮次也可能以失败收尾
      readGrokTurnCompleted(update, failures);
      const u = pick(update.usage);
      if (!u) continue;
      usages.push(u);
    }
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new Error(describeSessionReadFailure(updatesPath, error));
  }
  return { usages, compactions, badLines, failures, rewinds, imagesDropped, unknownUpdates };
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
