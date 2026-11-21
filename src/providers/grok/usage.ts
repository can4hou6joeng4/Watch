import { iterateFileLines } from '../../core/read-text.js';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import type { SessionRef, TokenUsage } from '../../core/types.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { formatUnknownTypeCounts } from '../../core/rich.js';
import { describeSessionReadFailure, isMissingPathError } from '../../core/read-text.js';
import {
  createGrokFailureCounts,
  finalizeGrokRetryAttribution,
  readGrokRetryState,
  readGrokTurnCompleted,
  type GrokFailureCounts,
} from './failure.js';

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

export type GrokCheckpointStatus = 'read' | 'missing' | 'unsafe' | 'unreadable' | 'bad' | 'oversize';

/** 最后一条 `compaction_checkpoint` 的检查点文件读取结果；只有 `read` 才带快照规模。 */
export type GrokCheckpointLast = {
  status: GrokCheckpointStatus;
  /** `compacted_history` 的条数（Grok 压缩后重建、模型当时可见的上下文） */
  messages?: number;
  /** 快照里的 role → 条数（role 缺失计「（缺 role）」） */
  roles?: Map<string, number>;
  schemaVersion?: number;
};

/** `updates.jsonl` 里全部 `compaction_checkpoint` 的汇总（第 257 轮）。 */
export type GrokCheckpointScan = {
  total: number;
  read: number;
  missing: number;
  unsafe: number;
  unreadable: number;
  bad: number;
  oversize: number;
  last: GrokCheckpointLast | null;
};

/** 检查点 JSON 体积上限：只需要 `compacted_history` 的规模，不解析超大文件。 */
const GROK_CHECKPOINT_SIZE_LIMIT = 16 * 1024 * 1024;

function emptyCheckpointScan(): GrokCheckpointScan {
  return { total: 0, read: 0, missing: 0, unsafe: 0, unreadable: 0, bad: 0, oversize: 0, last: null };
}

/**
 * 读一个压缩检查点文件，只保留规模信息（`compacted_history` 条数与 role 计数），
 * 不复制摘要正文，也不把它拼进交接。
 *
 * `checkpoint_file` 是不可信输入：必须是相对路径、解析后仍落在本会话的
 * `compaction_checkpoints/` 目录里，绝对路径与 `..` 逃逸一律拒绝（不读）。
 */
async function readGrokCheckpoint(sessionDir: string, file: unknown): Promise<GrokCheckpointLast> {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0') || isAbsolute(file)) return { status: 'unsafe' };
  const root = join(sessionDir, 'compaction_checkpoints');
  const abs = resolve(sessionDir, file);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { status: 'unsafe' };
  try {
    // lstat 不跟随符号链接：检查点应是原生写出的普通文件，符号链接一律不算可读
    // （与 Grok `.cwd` 的处理同口径，避免指向 FIFO / 设备文件）。
    const st = await lstat(abs);
    if (!st.isFile()) return { status: 'unreadable' };
    if (st.size > GROK_CHECKPOINT_SIZE_LIMIT) return { status: 'oversize' };
    const rec = parseJsonObject(await readFile(abs, 'utf8'));
    if (!rec) return { status: 'bad' };
    const history = rec.compacted_history;
    if (!Array.isArray(history)) return { status: 'bad' };
    const roles = new Map<string, number>();
    for (const item of history) {
      const rec2 = asRecord(item);
      const role = rec2 && typeof rec2.role === 'string' && rec2.role ? rec2.role : '（缺 role）';
      // 存原文：转义、截断与有界汇总统一在披露渲染时做（formatUnknownTypeCounts）。
      roles.set(role, (roles.get(role) ?? 0) + 1);
    }
    return {
      status: 'read',
      messages: history.length,
      roles,
      ...(typeof rec.schema_version === 'number' ? { schemaVersion: rec.schema_version } : {}),
    };
  } catch (error) {
    return { status: isMissingPathError(error) ? 'missing' : 'unreadable' };
  }
}

/** 披露用的检查点规模说明；没有检查点时返回空串。 */
export function describeGrokCheckpoints(scan: GrokCheckpointScan): string {
  if (scan.total === 0) return '';
  const lastLabels: Record<GrokCheckpointStatus, string> = {
    read: '可读',
    missing: '文件缺失',
    unsafe: '路径不安全',
    unreadable: '读取失败',
    bad: '内容无法解析',
    oversize: '文件体积过大',
  };
  const parts: string[] = [];
  if (scan.last?.status === 'read' && scan.last.messages !== undefined) {
    // role 来自检查点文件，是不可信字符串；条数也可能任意多（损坏或第三方改写），
    // 与其它未知类型披露同一口径有界展示。
    const roles = formatUnknownTypeCounts(scan.last.roles ?? new Map<string, number>());
    parts.push(
      `最近一次压缩留下的上下文快照可读：压缩后重建的上下文有 ${scan.last.messages} 条记录` +
      (roles ? `（${roles}）` : '') +
      '；快照内容只统计规模，没有并入交接',
    );
  } else if (scan.last) {
    parts.push(`最近一次压缩的上下文快照不可读（${lastLabels[scan.last.status]}）`);
  }
  const failures: string[] = [];
  if (scan.missing) failures.push(`文件缺失 ${scan.missing}`);
  if (scan.unsafe) failures.push(`路径不安全 ${scan.unsafe}`);
  if (scan.unreadable) failures.push(`读取失败 ${scan.unreadable}`);
  if (scan.bad) failures.push(`内容无法解析 ${scan.bad}`);
  if (scan.oversize) failures.push(`文件体积过大 ${scan.oversize}`);
  if (failures.length > 0 && (scan.read > 0 || failures.length > 1 || scan.total > 1)) {
    parts.push(`检查点文件合计 ${scan.total} 个，其中 ${failures.join('、')}`);
  }
  return parts.join('；');
}

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
  /** 压缩检查点文件的可读性与快照规模（第 257 轮，只读不移交）。 */
  checkpoints: GrokCheckpointScan;
  /**
   * 原生标记为失败的工具调用 ID（第 333 轮）：ACP `tool_call_update` 的 `status` 是结构化
   * 枚举（`completed` / `failed`），失败不必从输出文字猜。ID 与 `chat_history.jsonl` 的
   * `tool_result.tool_call_id` 对应，由 parse 侧按 ID 标记；对不上的是子代理、压缩前或
   * 没写进对话记录的调用，parse 会披露个数，不按位置硬套。
   */
  failedToolCalls: Set<string>;
  /** `status: failed` 但缺 `toolCallId` 的更新条数：永远无法对应到结果，单独披露。 */
  failedToolCallsWithoutId: number;
};

export async function grokUpdateScan(updatesPath: string): Promise<GrokUpdateScan | null> {
  const usages: TokenUsage[] = [];
  const failures = createGrokFailureCounts();
  let compactions = 0;
  let badLines = 0;
  let rewinds = 0;
  let imagesDropped = 0;
  const unknownUpdates = new Map<string, number>();
  const checkpoints = emptyCheckpointScan();
  const failedToolCalls = new Set<string>();
  let failedToolCallsWithoutId = 0;
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
        // Grok 每次压缩上下文都写一条，检查点文件在会话目录的 compaction_checkpoints/ 里。
        // 这里只读规模（compacted_history 条数与 role 计数）用于披露，不复制快照正文、
        // 也不把它拼进交接；文件缺失 / 路径不安全 / 读不出来都要有计数，不能静默当「没有」。
        compactions += 1;
        checkpoints.total += 1;
        const result = await readGrokCheckpoint(dirname(updatesPath), update.checkpoint_file);
        checkpoints[result.status] += 1;
        checkpoints.last = result;
        continue;
      }
      if (updateType === 'tool_call_update') {
        // ACP 的工具调用状态（第 333 轮）：`status` 是原生枚举，`failed` 是明确的结构化
        // 失败标记（本机 24 个 updates.jsonl 采样：completed 3391 / failed 70）。只收集，
        // 不在这里标记——结果事件在 chat_history.jsonl 里，按 ID 对应由 parse 侧完成。
        if (update.status === 'failed') {
          if (typeof update.toolCallId === 'string' && update.toolCallId) failedToolCalls.add(update.toolCallId);
          else failedToolCallsWithoutId += 1;
        }
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
          // 存原文：转义与截断统一在披露渲染时做（formatUnknownTypeCounts），
          // 避免先转义后截断切出半截转义序列。
          unknownUpdates.set(updateType, (unknownUpdates.get(updateType) ?? 0) + 1);
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
  // 末尾没有 turn_completed 的重试单独计数，不归属给任何轮（第 256 轮）。
  finalizeGrokRetryAttribution(failures);
  return { usages, compactions, badLines, failures, rewinds, imagesDropped, unknownUpdates, checkpoints, failedToolCalls, failedToolCallsWithoutId };
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
