import { DatabaseSync } from 'node:sqlite';
import { escapeControlChars } from '../../core/display.js';
import { normalizeUserText, OPENCODE_COMPACTION_SUMMARY_PREFIX, OPENCODE_SYNTHETIC_TEXT_PREFIX, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import { isoFromEpochMs } from '../../core/time.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { detectOpencodeLayout, opencodeDbPath, opencodeDbSqliteError, probeOpencodeDbFile } from './paths.js';
import { describeOpencodeRevert, readOpencodeRevert } from './revert.js';

type MessageRow = {
  id: string;
  time_created: number;
  data: string;
};

type PartRow = {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
};

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type OpencodeMessageData = {
  role?: string;
  time?: { created?: number; completed?: number };
  /** 1.x 压缩摘要消息（compaction.ts 的 processCompaction 写入） */
  summary?: boolean;
  finish?: string;
  error?: unknown;
  parentID?: string;
  model?: { providerID?: string; modelID?: string };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

type OpencodeToolState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
};

type OpencodePartData =
  | { type: 'text'; text?: string; synthetic?: unknown; ignored?: unknown; time?: { start?: number; end?: number } }
  | { type: 'reasoning'; text?: string }
  | {
      type: 'tool';
      callID?: string;
      tool?: string;
      state?: OpencodeToolState;
    }
  | { type: 'file'; mime?: unknown; url?: unknown; filename?: unknown; path?: unknown }
  | { type: string };

function isTextPart(part: OpencodePartData): part is { type: 'text'; text?: string; synthetic?: unknown; ignored?: unknown } {
  return (part as { type: string }).type === 'text';
}

function isReasoningPart(part: OpencodePartData): part is { type: 'reasoning'; text?: string } {
  return (part as { type: string }).type === 'reasoning';
}

function isFilePart(part: OpencodePartData): part is {
  type: 'file';
  mime?: unknown;
  url?: unknown;
  filename?: unknown;
  path?: unknown;
} {
  return (part as { type?: string }).type === 'file';
}

/**
 * file part → attachment text 事件（不搬进 turn.text，避免文本翻倍）。
 * 图片按 MIME 还原为 image，base64 data URI 拆为 data，避免转入 Claude 时被误写成 URL source；
 * 普通文件仍保留 file/url，外部图片链接同样保留 url。占位放 summary/detail，保证展示层可读。
 */
function filePartToEvent(part: OpencodePartData, time: number): ProcessEvent | null {
  if (!isFilePart(part)) return null;
  const mime = typeof part.mime === 'string' && part.mime ? part.mime : 'file';
  const url = typeof part.url === 'string' && part.url ? part.url : undefined;
  const filename = typeof part.filename === 'string' && part.filename ? part.filename : undefined;
  const size = url ? `，约${Math.floor(url.length * 3 / 4)}B` : '';
  const name = filename ? ` ${filename}` : '';
  const placeholder = `[附件：${mime}${size}${name}]`;
  const image = /^image\//i.test(mime);
  const encoded = image && url ? /^data:[^;,]+;base64,([\s\S]*)$/i.exec(url) : null;
  return {
    kind: 'text',
    timestamp: isoFromEpochMs(time),
    summary: placeholder,
    detail: placeholder,
    provider: 'opencode',
    attachment: { kind: image ? 'image' : 'file', mediaType: mime, ...(encoded ? { data: encoded[1]! } : { url }), filename },
  };
}

/**
 * 从 message data.tokens 读真实 usage；缺字段或合计为 0 返回 undefined。
 *
 * OpenCode 存的是一份**非重叠**分解，不是「input / output 两个总数」：
 * `packages/opencode/src/session/session.ts` 的 `getUsage()`（本项目验证基线 1.18.29）在写
 * message 时做减法——
 *
 *   tokens.input     = adjustedInputTokens（已减去 cache read / write）
 *   tokens.output    = outputTokens - reasoningTokens
 *   tokens.reasoning = reasoningTokens
 *   tokens.cache     = { read, write }
 *
 * 上游 `packages/ai/src/schema/events.ts` 把同一件事写成不变式：
 * `nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens = inputTokens`、
 * `reasoningTokens ≤ outputTokens`。所以真实输入是三块求和，真实输出要把 reasoning 加回来。
 *
 * 以前只读 `tokens.input` / `tokens.output`，于是 **opencode → 任何别家的转入都低估用量**
 * （丢掉 cache read/write 的输入与 reasoning 的输出），与 claude 缓存两块、codex
 * `last_token_usage`、grok `updates.jsonl` 的 `turn_completed`、pi `message.usage` 完全同源：
 * 信息层读到了、搬运层没读。
 *
 * 求和不会让 Watch 自转的会话翻倍：`buildAssistantMessageData()` 落的是
 * `tokens: { total, input, output, reasoning: 0, cache: { write: 0, read: 0 } }`，两项都是 0。
 *
 * 已知边界：该减法只出现在较新的 OpenCode 里（本仓库可取到的最早 tag 已是这个语义，本项目只验证
 * 1.18.29）；更早版本写下的会话若 `input` 本就含缓存，求和会偏高。没有按 `session.version` 分档，
 * 因为无法从可取到的版本历史里确定切点，猜错切点会让现代会话静默少算——宁可让极老数据偏高，
 * 也不让当前基线出错。
 *
 * 0/0 是写出侧没有源侧用量时的占位（源侧 `usage` 缺失时仍写全 0），不能当成「确实用了 0 token」。
 */
function messageUsage(data: OpencodeMessageData | null): TokenUsage | undefined {
  const t = data?.tokens;
  if (typeof t?.input !== 'number' || typeof t?.output !== 'number') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = t.input + num(t.cache?.read) + num(t.cache?.write);
  const outputTokens = t.output + num(t.reasoning);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

function isToolPart(part: OpencodePartData): part is {
  type: 'tool';
  callID?: string;
  tool?: string;
  state?: OpencodeToolState;
} {
  return (part as { type: string }).type === 'tool';
}

function partToEvents(part: OpencodePartData, baseTime: number): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  if (isReasoningPart(part)) {
    events.push({
      kind: 'thinking',
      timestamp: isoFromEpochMs(baseTime),
      detail: part.text ?? '',
      summary: part.text ?? '',
      provider: 'opencode',
    });
  } else if (isToolPart(part)) {
    const callId = part.callID ?? `oc-${crypto.randomUUID()}`;
    const input = part.state?.input ?? {};
    // Watch 用合法 error 状态承载来源未记录结果的调用；它并非一次真实失败返回，不能伪造 tool_result。
    const unfinished = part.state?.status === 'error' && part.state.metadata?.watch_unfinished_tool === true;
    events.push({
      kind: 'tool_call',
      timestamp: isoFromEpochMs(baseTime),
      name: part.tool ?? 'tool',
      callId,
      input,
      summary: `${unfinished ? '[未完成工具调用] ' : ''}${part.tool ?? 'tool'} ${JSON.stringify(input).slice(0, 200)}`,
      provider: 'opencode',
    });
    const output = part.state?.status === 'error' && typeof part.state.error === 'string'
      ? `[工具执行失败] ${part.state.error}`
      : part.state?.output;
    if (!unfinished && output !== undefined) {
      events.push({
        kind: 'tool_result',
        timestamp: isoFromEpochMs(baseTime),
        callId,
        detail: typeof output === 'string' ? output : JSON.stringify(output),
        summary: typeof output === 'string' ? output : JSON.stringify(output).slice(0, 200),
        provider: 'opencode',
      });
    }
  }
  return events;
}

/**
 * 1.x 原生会写、但不承载对话内容的记账 / 身份 part。
 *
 * 依据上游 v1.18.29（16747470f976aca3d362ad730bcd3fe82ecc2c9a）：
 * - `step-start` / `step-finish`：`processor.ts` 每个 step 的起止帧；
 * - `patch` / `snapshot`：每次改过文件的 step-finish 与 cleanup 之后写入的变更 / 快照记账；
 * - `agent`：用户选择子代理或命令模板引用产生的身份标记（`name` / `source`）。`prompt.ts`
 *   只在调用模型时临时追加一条 synthetic 指令，日志里没有这段文本；实际委派另由 task
 *   工具 part 记录，`name` 本身不是对话内容；
 * - `subtask`：子代理任务描述符（`prompt` / `description` / `agent` / `model`）。上游在同一个
 *   会话的主循环里取出它并执行，`message-v2` 只给模型一句固定占位；真正的 prompt 同时写在
 *   紧随其后的 task 工具调用入参里，Watch 已按 tool part 保留，不重复搬运描述符；
 * - `retry`：API 重试记账（`attempt` / `error` / `time`），上游不送进模型上下文。
 *
 * 第三方实现里，CASR（fac8916）把 agent 与其它 bookkeeping part 一并跳过，session-migrate
 * （45351ff）把它们保留为 opaque 元信息而不并入对话；catchup（8280337）显式忽略
 * patch / snapshot / step 帧，但 agent / subtask / retry 仍会进它的未知类型警告。这里的
 * 判据是上游语义（不承载对话内容），不以某一家的未知类型表为准。第五十八轮只排除了
 * step-start / step-finish，于是**任何改过文件或调用过子代理的正常会话**都会带一条
 * 「有 N 处未识别」的假披露，还会被 claude / codex 写进目标会话。
 *
 * `compaction` 单独处理：它标记压缩点，正文由紧随其后的 `summary: true` 消息承载（见下方
 * 压缩摘要分支），不是丢失的数据。
 */
const V1_IGNORED_PART_TYPES = new Set([
  'step-start',
  'step-finish',
  'patch',
  'snapshot',
  'agent',
  'subtask',
  'retry',
]);

/** 1.x 解析期间跨消息累计的计数（ignored 文本的披露要按整条会话汇总） */
type V1ParseStats = { ignoredTexts: number };

function messageToTurn(
  msg: MessageRow,
  parts: PartRow[],
  prevTurn: UnifiedTurn | null,
  unknown: Map<string, number>,
  stats: V1ParseStats,
): UnifiedTurn | null {
  const data = parseJson<OpencodeMessageData>(msg.data);
  // 坏 JSON / 非对象 JSON 以前让整条消息连同 parts 一起消失；坏 role 同理。
  // 这两种都不是「这轮没有内容」，必须计数给调用方披露。
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    bumpCount(unknown, 'message（data 无法解析）');
    return null;
  }
  const role = data.role;
  if (role !== 'user' && role !== 'assistant') {
    bumpCount(unknown, `message:${typeof role === 'string' && role ? role : '（缺少 role）'}`);
    return null;
  }

  const baseTime = data?.time?.created ?? msg.time_created;
  const timestamp = isoFromEpochMs(baseTime);

  const textParts: string[] = [];
  const events: ProcessEvent[] = [];
  let hasToolEvents = false;
  let prevSynthetic = false;

  for (const partRow of parts) {
    const part = parseJson<OpencodePartData>(partRow.data);
    // 与 message 同档：坏 JSON 或非对象 JSON 不能静默跳过。`parseJson` 的类型断言不做
    // 形状校验，字符串 / 数字 / 数组都会原样穿过，所以这里按对象重新判定。
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      bumpCount(unknown, 'part（data 无法解析）');
      continue;
    }
    const partType = typeof (part as { type?: unknown }).type === 'string' ? (part as { type: string }).type : '';
    if (!partType) {
      bumpCount(unknown, 'part（空类型）');
      continue;
    }
    if (V1_IGNORED_PART_TYPES.has(partType)) continue;
    // 压缩标记本身没有对话内容；摘要正文在随后的 `summary: true` 助手消息里
    if (partType === 'compaction') continue;
    const partTime = partRow.time_created;
    if (isTextPart(part)) {
      if (part.text) {
        // `ignored: true` 的文本上游不送进模型上下文（message-v2 的 toModelMessages 跳过），
        // 并进正文会让目标看到来源模型从未见过的内容；条数在整条会话上汇总后披露。
        if (part.ignored === true) {
          stats.ignoredTexts += 1;
          continue;
        }
        // `synthetic: true` 是 OpenCode 注入的用户侧内容（MCP / Read 展开、auto-continue 指令，
        // 上游写入点全在 prompt.ts 的 user 消息里），属于模型上下文但不是用户原话：
        // 保留内容，只在每段连续注入前标一次来源。**只标 user 侧**——前缀文案说的是
        // 「不是用户原话」，而助手侧的 synthetic 是 Watch 官方导出写出的过程文本
        // （official-export.ts 的 eventParts），标成「OpenCode 注入」是反向误标。
        const synthetic = role === 'user' && part.synthetic === true;
        textParts.push(synthetic && !prevSynthetic ? `${OPENCODE_SYNTHETIC_TEXT_PREFIX}\n${part.text}` : part.text);
        prevSynthetic = synthetic;
      }
    } else if (isReasoningPart(part) || isToolPart(part) || isFilePart(part)) {
      if (isToolPart(part)) hasToolEvents = true;
      const partEvent = filePartToEvent(part, partTime);
      if (partEvent) events.push(partEvent);
      events.push(...partToEvents(part, partTime));
    } else {
      // 已知记账类型已在上方排除；其余未知类型不猜内容，按类型与条数汇入上下文披露。
      bumpCount(unknown, `part:${partType}`);
    }
  }

  const usage = messageUsage(data);
  const rawText = textParts.join('\n\n');
  if (role === 'user') {
    const normalized = normalizeUserText(rawText);
    if (normalized) {
      textParts.length = 0;
      textParts.push(normalized);
    } else if (events.length === 0) {
      // 仅附件无文本的 user 消息：占位在事件里，保留 turn
      return null;
    }
  }
  const text = textParts.join('\n\n');

  // OpenCode 1.x 的压缩（compaction.ts 的 create / processCompaction）：先写一条只含
  // `compaction` part 的 user 消息，再写一条 `summary: true` 的 assistant 摘要消息。
  // 摘要不是助手对用户说的话——按普通回复处理时，前一轮带工具调用就会被并进那一轮正文
  // （还会顶掉那一轮的真实 usage）；`--since-compact` 也完全认不出来（它只认
  // OPENCODE_COMPACTION_SUMMARY_PREFIX 事件）。这里与 2.x 的 compaction 事件统一形状：
  // 完成的压缩（上游 completedCompactions 判据：summary && finish && !error）写成带前缀的
  // text 事件挂在当前轮次上；未完成 / 出错的压缩没有替换上下文，只保留正文并声明未生效，
  // **不作为压缩边界**（catchup 同样只认 status === "completed"）。
  // 摘要调用本身是一次独立请求，其 usage 不并入前一轮（事件没有用量字段，宁可不记）。
  if (role === 'assistant' && data.summary === true) {
    const completed = Boolean(data.finish) && data.finish !== 'error' && data.error === undefined;
    const summaryEvent: ProcessEvent = completed
      ? {
          kind: 'text',
          timestamp,
          summary: OPENCODE_COMPACTION_SUMMARY_PREFIX,
          detail: text || '（本次压缩没有留下摘要正文）',
          provider: 'opencode',
        }
      : {
          kind: 'text',
          timestamp,
          summary: '[OpenCode 压缩摘要未生效（未完成或出错），上下文未被替换]',
          detail: text,
          provider: 'opencode',
        };
    if (prevTurn) {
      prevTurn.events = [...(prevTurn.events ?? []), ...events, summaryEvent];
      return null;
    }
    return { role, text: '', timestamp, provider: 'opencode', events: [...events, summaryEvent] };
  }

  // OpenCode build 把含工具调用的 assistant turn 拆成两条 message：
  // 1) tool-calls（finish='tool-calls'） 2) 最终文本（finish='stop'）。
  // 解析时合并回同一个 UnifiedTurn，保持 round-trip 稳定。
  if (
    role === 'assistant' &&
    !hasToolEvents &&
    text.trim() &&
    prevTurn?.role === 'assistant' &&
    (prevTurn.events ?? []).some((e) => e.kind === 'tool_call')
  ) {
    prevTurn.text = prevTurn.text ? `${prevTurn.text}\n\n${text}` : text;
    if (events.length > 0) prevTurn.events = [...(prevTurn.events ?? []), ...events];
    if (usage) prevTurn.usage = usage;
    return null;
  }

  const turn: UnifiedTurn = {
    role,
    text,
    timestamp,
    provider: 'opencode',
  };
  if (events.length > 0) turn.events = events;
  if (usage) turn.usage = usage;
  return turn;
}

/* ─────────────────────────── OpenCode 2.x（只读） ─────────────────────────── */

/**
 * 2.x 的 `session_message` 是事件日志：一行一个 `type`，内容整段放在 `data` JSON 里。
 *
 * 类型语义对齐上游 v2.2.7（`fedc6f208aa2bd54c1019227214568083f6380ad`）的
 * `packages/core/src/session/runner/to-llm-message.ts`：user / assistant 是对话
 * （assistant 的 `content` 数组里是 text / reasoning / tool）；shell / synthetic /
 * system / compaction / location-switched / skill 是模型可见事件；
 * agent-switched / idle / model-switched 是纯记账（`V2_IGNORED_MESSAGE_TYPES`）。本机没有原生 2.x
 * 样本，旧构建的形状兼容保留（user.content 字符串回退、无 status 的 compaction），
 * 其余原样跳过并把条数写进内容（不猜含义）。
 */
type V2MessageRow = { id: string; type: string; seq: number; time_created: number; data: string };

type V2PartRow = { message_id: string; ordinal: number; type: string; data: string };

type V2ToolState = {
  status?: string;
  /** streaming 状态是 partial JSON 字符串，其余状态是对象（上游 ToolState 联合） */
  input?: unknown;
  output?: unknown;
  content?: unknown;
  /** 上游 `SessionError.Error`（type / message 必填）；形状在读取处逐项收窄 */
  error?: unknown;
};

/** content 数组的一项：按 `type` 分支读字段；未知类型只用到 `type` */
type V2ContentItem = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  executed?: boolean;
  state?: V2ToolState;
  time?: { created?: number; completed?: number };
};

type V2MessageMetadata = {
  /** 摘要型压缩逐字保留的近期消息起点（session_message.id） */
  keepID?: unknown;
  /** pre-v2.1 的摘要型压缩把保留文本存在这里（session-legacy.ts 从顶层 recent 迁移） */
  recent?: unknown;
  /** shell 的后台执行标记：上游 `metadata.background === true` 不进模型上下文 */
  background?: unknown;
};

type V2MessageData = {
  text?: string;
  /** compaction / shell 的元信息；形状在读取处逐个收窄 */
  metadata?: V2MessageMetadata;
  time?: { created?: number; completed?: number };
  content?: V2ContentItem[] | string;
  command?: string;
  shellID?: string;
  status?: string;
  exit?: number;
  output?: { output?: string } | string;
  summary?: string;
  recent?: string;
  reason?: string;
  /** location-switched 的 Location.Ref：directory 是 AbsolutePath 字符串 */
  location?: { directory?: unknown };
  /** skill 的必填字段：skill 是 ID、name 是 Name、text 是技能正文 */
  skill?: string;
  name?: string;
  /** SessionError.Error（assistant / compaction.failed / tool.state.error 共用形状） */
  error?: { type?: string; message?: string };
  /** user 的附件与技能（上游 Prompt.files / Prompt.skills），形状在解析处逐项收窄 */
  files?: unknown;
  skills?: unknown;
  /** CompactionCompleted：provider 原生压缩的替换窗口在 native.messages（形状由 provider 决定） */
  native?: unknown;
  /** pre-v2.1 的旧记录把同一个窗口存在 providerContext.messages（session-legacy.ts 迁移） */
  providerContext?: unknown;
};

/**
 * 上游 `recent-text.ts` 对保留窗口里单个工具输出的上限：1250 个码点，超出部分截断并标注。
 * 按码点计数，避免把代理对切一半。
 */
const V2_RECENT_TOOL_OUTPUT_MAX_CHARS = 1250;

function truncateV2RecentToolOutput(value: string): string {
  if (value.length <= V2_RECENT_TOOL_OUTPUT_MAX_CHARS) return value;
  let end = 0;
  let kept = 0;
  for (const char of value) {
    if (kept === V2_RECENT_TOOL_OUTPUT_MAX_CHARS) break;
    end += char.length;
    kept++;
  }
  if (end === value.length) return value;
  return `${value.slice(0, end)}\n[truncated]`;
}

/** 上游 `serializeToolContent()`：文本原样、文件只留 mime 与名字（不读附件字节）。 */
function v2RecentToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { type?: unknown; text?: unknown; mime?: unknown; name?: unknown };
    if (entry.type === 'text') {
      if (typeof entry.text === 'string') parts.push(entry.text);
      continue;
    }
    if (entry.type !== 'file') continue;
    const mime = typeof entry.mime === 'string' && entry.mime ? entry.mime : '未知类型';
    const name = typeof entry.name === 'string' && entry.name ? `: ${entry.name}` : '';
    parts.push(`[Attached ${mime}${name}]`);
  }
  return parts.join('\n');
}

/** assistant 消息按上游 `messageToText()`：文本 / 工具调用与结果入文本，reasoning 刻意不送。 */
function v2RecentAssistantText(data: V2MessageData, parts?: V2ContentItem[]): string {
  const inline: V2ContentItem[] =
    typeof data.content === 'string' ? [{ type: 'text', text: data.content }] : Array.isArray(data.content) ? data.content : [];
  // 与上游 withParts() 同一顺序：session_part 行在前，旧构建写在行内的 content 在后。
  const items: V2ContentItem[] = parts?.length ? [...parts, ...inline] : inline;
  const lines: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') {
      lines.push(`[Assistant]: ${typeof item.text === 'string' ? item.text : ''}`);
      continue;
    }
    if (item.type === 'reasoning') continue;
    if (item.type !== 'tool') continue;
    const name = typeof item.name === 'string' && item.name ? item.name : 'tool';
    const rawInput = item.state?.input;
    const input = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
    lines.push(`[Assistant tool call]: ${name}(${input})`);
    if (item.state?.status === 'completed') {
      lines.push(`[Tool result]: ${truncateV2RecentToolOutput(v2RecentToolContent(item.state?.content))}`);
    } else if (item.state?.status === 'error') {
      // 与上游 recent-text.ts 同一投影：[Tool error] 只写 message，不并入 content。
      lines.push(`[Tool error]: ${v2ToolErrorMessageRaw(item.state?.error) ?? ''}`);
    }
  }
  return lines.join('\n');
}

/** 上游 `messageToText()` 的逐类型投影；未知类型与 compaction / system 一样不渲染（模型也看不到）。 */
function v2RecentMessageText(row: V2MessageRow, data: V2MessageData | null, parts?: V2ContentItem[]): string {
  if (!data) return '';
  switch (row.type) {
    case 'compaction':
    case 'system':
      return '';
    case 'user': {
      const skills: string[] = [];
      if (Array.isArray(data.skills)) {
        for (const raw of data.skills) {
          if (!raw || typeof raw !== 'object') continue;
          const skill = raw as { name?: unknown; text?: unknown };
          if (typeof skill.name !== 'string' || typeof skill.text !== 'string') continue;
          skills.push(`[Skill activated: ${skill.name}]\n${skill.text}`);
        }
      }
      const files: string[] = [];
      if (Array.isArray(data.files)) {
        for (const raw of data.files) {
          if (!raw || typeof raw !== 'object') continue;
          const file = raw as { mime?: unknown; name?: unknown; source?: { type?: unknown; uri?: unknown } };
          const mime = typeof file.mime === 'string' ? file.mime : '未知类型';
          const fallback = file.source?.type === 'uri' && typeof file.source.uri === 'string' ? file.source.uri : 'inline attachment';
          const name = typeof file.name === 'string' && file.name ? file.name : fallback;
          files.push(`[Attached ${mime}: ${name}]`);
        }
      }
      return [...skills, `[User]: ${typeof data.text === 'string' ? data.text : ''}`, ...files].join('\n');
    }
    case 'location-switched': {
      const directory = data.location && typeof data.location === 'object' && typeof data.location.directory === 'string' ? data.location.directory : '';
      return directory ? `[User]: The working directory has been changed to ${directory}.` : '';
    }
    case 'assistant':
      return v2RecentAssistantText(data, parts);
    case 'synthetic':
      return `[Synthetic context]: ${typeof data.text === 'string' ? data.text : ''}`;
    case 'skill': {
      const name = typeof data.name === 'string' ? data.name : '';
      const text = typeof data.text === 'string' ? data.text : '';
      return `[Skill activated: ${name}]\n${text}`;
    }
    case 'shell': {
      // 后台 shell 的结果由完成时的 inbox 项单独进入上下文，这里不重复（上游 messageToText 同判据）。
      if (data.metadata?.background === true) return '';
      const command = typeof data.command === 'string' ? data.command : '';
      const output =
        typeof data.output === 'string' ? data.output : typeof data.output?.output === 'string' ? data.output.output : '';
      return `[Shell]: ${command}\n${truncateV2RecentToolOutput(output)}`;
    }
    default:
      return '';
  }
}

/**
 * 摘要型压缩的「保留窗口」：`metadata.keepID` 指向第一条逐字保留的消息，上游
 * `history.ts` 的 `withRecentText()` 从它到压缩记录之间重建文本放进 `<recent-context>`——
 * 这些消息在压缩后**仍然进模型上下文**。不重建会让 `--since-compact` 把它们连同更早的
 * 轮次一起裁掉。keepID 不存在 / 找不到时返回空串（上游同样不重建，模型也看不到）。
 * 形状异常由主解析对同一条记录另行计数，这里不再重复。
 */
function v2KeptRecentTexts(
  rows: V2MessageRow[],
  parsed: (V2MessageData | null)[],
  partsByMessage: Map<string, V2ContentItem[]>,
  unknown: Map<string, number>,
): Map<string, string> {
  const out = new Map<string, string>();
  const indexById = new Map<string, number>();
  rows.forEach((row, index) => indexById.set(row.id, index));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const data = parsed[i];
    if (row.type !== 'compaction' || !data) continue;
    const status = typeof data.status === 'string' ? data.status : 'completed';
    if (status !== 'completed') continue;
    const metadata = data.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
      bumpCount(unknown, 'compaction（metadata 不是对象）');
      continue;
    }
    const keepID = metadata?.keepID;
    if (keepID === undefined) continue;
    if (typeof keepID !== 'string' || !keepID) {
      bumpCount(unknown, 'compaction（keepID 不是字符串）');
      continue;
    }
    const start = indexById.get(keepID);
    if (start === undefined || start >= i) continue;
    const pieces: string[] = [];
    for (let j = start; j < i; j++) {
      const text = v2RecentMessageText(rows[j]!, parsed[j] ?? null, partsByMessage.get(rows[j]!.id));
      if (text) pieces.push(text);
    }
    out.set(row.id, pieces.join('\n\n'));
  }
  return out;
}

/**
 * completed 压缩的 provider 原生替换窗口：返回窗口里的消息条数，没有窗口返回 null。
 * 上游 v2.2.7 的 `compaction.ts` 在 provider 原生压缩成功时写 `text: ""`、窗口放进
 * `native.messages`；`to-llm-message.ts` 用 `decodeNativeWindow` 重放它**而不是** summary，
 * `history.ts` 明确原生窗口对本地转录（boundary "local"）从不作边界——只有生成它的
 * provider / 模型能重放。Watch 只数条数，不复制窗口内容（可能含整段对话与 provider 私有数据）。
 */
function v2NativeWindow(data: V2MessageData, unknown: Map<string, number>): number | null {
  const containers: { label: string; value: unknown }[] = [];
  if (data.native !== undefined) containers.push({ label: 'native', value: data.native });
  if (data.providerContext !== undefined) containers.push({ label: 'providerContext', value: data.providerContext });
  for (const { label, value } of containers) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      bumpCount(unknown, `compaction（${label} 不是对象）`);
      continue;
    }
    const messages = (value as { messages?: unknown }).messages;
    if (messages === undefined) continue;
    if (!Array.isArray(messages)) {
      bumpCount(unknown, `compaction（${label}.messages 不是数组）`);
      continue;
    }
    return messages.length;
  }
  return null;
}

/**
 * 2.x 里「不承载对话内容」的记账类型。上游 v2.2.7 的 `to-llm-message.ts` 对
 * `agent-switched` / `idle` 直接 `return []`（idle 每个回合结束都会写一条）；
 * `model-switched` 只在「当前模型与自己记录的 previous 是同一个模型、且两侧 variant 都能
 * 解析成 effort」时产出一条 **system 角色**的 `Message.effort` 标记（多数 provider 路由在
 * 发送前还会把它丢掉），真正换了 provider / 模型时同样 `return []`——模型上下文里没有
 * 「模型切换」这句话。把它们计成「未识别事件」会让任何健康的 v2 会话都冒假披露；把
 * model-switched 写成助手侧文本更糟：交接时 claude / codex 目标会把它当成上一轮的发言。
 */
const V2_IGNORED_MESSAGE_TYPES = new Set(['agent-switched', 'idle', 'model-switched']);

function bumpCount(map: Map<string, number>, key: string): void {
  const k = key.trim() || '（空类型）';
  map.set(k, (map.get(k) ?? 0) + 1);
}

function describeCounts(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${escapeControlChars(k)} × ${n}`)
    .join('、');
}

/** 未知数据通过统一上下文通道披露；不改正文，不让空正文工具助手轮承载文本。 */
function appendUnknownDisclosure(turns: UnifiedTurn[], summary: string, detail: string): void {
  const carrier = [...turns].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
  if (!carrier) return;
  carrier.events = [
    ...(carrier.events ?? []),
    {
      kind: 'text',
      timestamp: carrier.timestamp,
      summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${summary}]`,
      // findContextDisclosure 优先消费带前缀的 detail，类型与计数也必须跟着进入 warnings / prompt。
      detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${summary}；${detail}]`,
      provider: 'opencode',
    },
  ];
}

/**
 * 工具结果的 `Tool.Content` 联合（text | file）→ 可读正文。
 *
 * 上游 v2.2.7 的 `toolResult` 把 completed 状态的 `state.content` 整体传给模型；只认
 * text 项会让**纯 file 结果**整条 tool_result 消失，调用还会被下游报成「没有结果」。
 * file 项只留可读占位，`uri` 不复制（可能是 data URI，原始载荷会撑爆交接并泄漏进文本）。
 * 形状异常按原因计数，与 content 区其它分支同一口径。
 */
function v2ToolContentText(content: unknown, unknown: Map<string, number>): string | undefined {
  if (typeof content === 'string') return content;
  if (content !== undefined && !Array.isArray(content)) {
    bumpCount(unknown, 'tool:content（不是数组或字符串）');
    return undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      bumpCount(unknown, 'tool:content（非对象）');
      continue;
    }
    const entry = item as { type?: unknown; text?: unknown; mime?: unknown; name?: unknown };
    if (entry.type === 'text') {
      if (typeof entry.text === 'string') {
        if (entry.text) parts.push(entry.text);
      } else {
        bumpCount(unknown, 'tool:content:text（text 不是字符串）');
      }
      continue;
    }
    if (entry.type === 'file') {
      if (typeof entry.mime !== 'string' || !entry.mime) {
        bumpCount(unknown, 'tool:content:file（mime 不是字符串）');
      }
      const mime = typeof entry.mime === 'string' && entry.mime ? entry.mime : '未知类型';
      const name = typeof entry.name === 'string' && entry.name ? `，${entry.name}` : '';
      parts.push(`[文件附件：${mime}${name}]`);
      continue;
    }
    bumpCount(unknown, `tool:content:${typeof entry.type === 'string' && entry.type ? entry.type : '（空类型）'}`);
  }
  return parts.length ? parts.join('\n') : undefined;
}

/** 只取值、不计数：保留窗口投影（与上游 recent-text.ts 同形）不该产生披露条目。 */
function v2ToolErrorMessageRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const message = (raw as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : undefined;
}

/** 上游 `SessionError.Error.message` 是必填字符串；形状异常按原因计数，不静默当没有。 */
function v2ToolErrorMessage(raw: unknown, unknown: Map<string, number>): string | undefined {
  if (raw === undefined) return undefined;
  const message = v2ToolErrorMessageRaw(raw);
  if (message) return message;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bumpCount(unknown, 'tool:error（不是对象）');
  } else if (typeof (raw as { message?: unknown }).message !== 'string') {
    bumpCount(unknown, 'tool:error（message 不是字符串）');
  } else {
    bumpCount(unknown, 'tool:error（message 为空）');
  }
  return undefined;
}

/**
 * 工具结果正文。error 状态在上游是
 * `{ error: state.error, content: state.content ?? [] }`——错误信息与工具失败时已经产生的
 * 输出**一起**进上下文（`ToolStateError.content` 是可选的非空数组）。以前只返回
 * `error.message`，失败前的现场整段消失；现在错误在前、附带内容在后，completed 不变。
 */
function v2ToolResultText(state: V2ToolState | undefined, unknown: Map<string, number>): string | undefined {
  const errorText = v2ToolErrorMessage(state?.error, unknown);
  const contentText = v2ToolContentText(state?.content, unknown);
  if (errorText) {
    return contentText ? `${errorText}\n\n[工具错误附带内容]\n${contentText}` : errorText;
  }
  if (contentText) return contentText;
  if (typeof state?.output === 'string') return state.output;
  if (state?.output !== undefined) return JSON.stringify(state.output);
  return undefined;
}

/** 上游 `attachmentContent()` 只把这几类当图片媒体；其余走文本 / 其它分支。 */
const V2_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * user 消息的 `files` / `skills`（上游 v2.2.7 的 `toLLMMessage` 在 user 分支把它们与
 * `Prompt.text` 一起送进模型上下文）。
 *
 * 以前只读 `text`：附件与技能静默消失，纯附件提问还会被记成「user（无文本）」整轮丢掉。
 * 这里给每个附件产一条带 `attachment` 的 text 事件（与 1.x `filePartToEvent` 同形），
 * 技能产一条 `[技能已激活：name]` 事件。**不复制 inline 的非图片载荷**（text/plain 的
 * base64 可能是整份文件，会撑爆交接）；图片按上游的 4 种 mime 还原 `data`。
 * 形状异常按原因计数，不静默。
 */
function v2UserAttachmentEvents(
  data: V2MessageData,
  timestamp: string,
  unknown: Map<string, number>,
): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  const files = data.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      bumpCount(unknown, 'user:files（不是数组）');
    } else {
      for (const raw of files) {
        if (!raw || typeof raw !== 'object') {
          bumpCount(unknown, 'user:files（非对象）');
          continue;
        }
        const file = raw as { data?: unknown; mime?: unknown; name?: unknown; source?: unknown };
        if (typeof file.mime !== 'string' || !file.mime) {
          bumpCount(unknown, 'user:files（mime 不是字符串）');
          continue;
        }
        const name = typeof file.name === 'string' && file.name ? file.name : undefined;
        const source =
          file.source && typeof file.source === 'object' ? (file.source as { type?: unknown; uri?: unknown }) : undefined;
        const uri = source?.type === 'uri' && typeof source.uri === 'string' ? source.uri : undefined;
        const base64 = typeof file.data === 'string' && file.data ? file.data : undefined;
        const image = V2_IMAGE_MIMES.has(file.mime);
        const placeholder = `[附件：${file.mime}${name ? `，${name}` : ''}]`;
        events.push({
          kind: 'text',
          timestamp,
          summary: placeholder,
          detail: placeholder,
          provider: 'opencode',
          attachment: {
            kind: image ? 'image' : 'file',
            mediaType: file.mime,
            ...(image && base64 ? { data: base64 } : {}),
            ...(!image && uri ? { url: uri } : {}),
            ...(name ? { filename: name } : {}),
          },
        });
      }
    }
  }
  const skills = data.skills;
  if (skills !== undefined) {
    if (!Array.isArray(skills)) {
      bumpCount(unknown, 'user:skills（不是数组）');
    } else {
      for (const raw of skills) {
        if (!raw || typeof raw !== 'object') {
          bumpCount(unknown, 'user:skills（非对象）');
          continue;
        }
        const skill = raw as { name?: unknown; text?: unknown };
        if (typeof skill.name !== 'string' || !skill.name) {
          bumpCount(unknown, 'user:skills（无 name）');
          continue;
        }
        const text = typeof skill.text === 'string' ? skill.text : '';
        events.push({
          kind: 'text',
          timestamp,
          summary: `[技能已激活：${skill.name}] ${text.slice(0, 160)}`.trim(),
          detail: text,
          provider: 'opencode',
        });
      }
    }
  }
  return events;
}

function v2UserTurn(row: V2MessageRow, data: V2MessageData, unknown: Map<string, number>): UnifiedTurn | null {
  const raw = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
  const normalized = normalizeUserText(raw);
  const time = typeof data.time?.created === 'number' ? data.time.created : row.time_created;
  const timestamp = isoFromEpochMs(time);
  const events = v2UserAttachmentEvents(data, timestamp, unknown);
  if (!normalized) {
    // 纯附件 / 纯技能提问：上游 content 由附件与技能文本组成，仍会产出 user 消息。
    // 以前一律按「无文本」跳过，整轮消失；有 events 时保留空正文轮，由写出侧补占位。
    if (events.length > 0) return { role: 'user', text: '', timestamp, provider: 'opencode', events };
    // 上游 User.text 是权威字符串字段；有值但类型不对时，「无文本」会把真实原因盖掉。
    if (data.text !== undefined && typeof data.text !== 'string') {
      bumpCount(unknown, 'user（text 不是字符串）');
    } else if (data.content !== undefined && typeof data.content !== 'string') {
      bumpCount(unknown, 'user（content 不是字符串）');
    } else {
      bumpCount(unknown, 'user（无文本）');
    }
    return null;
  }
  const turn: UnifiedTurn = { role: 'user', text: normalized, timestamp, provider: 'opencode' };
  if (events.length > 0) turn.events = events;
  return turn;
}

/**
 * assistant 消息的错误（上游 `Assistant.error: SessionError.Error`，请求失败时仍写一条
 * assistant 消息）。以前不看它：content 为空的失败轮直接返回 null，整轮消失，下游
 * `describeUnansweredTail` 把「模型调用失败」讲成「用户问了没人答」。
 * 失败是降级事实，走统一上下文披露（`WATCH_CONTEXT_DISCLOSURE_PREFIX`），进 prompt 头部与
 * open / handoff warnings；形状异常按原因计数。
 */
function v2AssistantErrorEvent(
  raw: unknown,
  timestamp: string,
  unknown: Map<string, number>,
): ProcessEvent | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bumpCount(unknown, 'assistant（error 不是对象）');
    return null;
  }
  const err = raw as { type?: unknown; message?: unknown };
  if (typeof err.message !== 'string' || !err.message) {
    bumpCount(unknown, 'assistant（error 缺少 message）');
    return null;
  }
  const label = typeof err.type === 'string' && err.type ? `（${err.type}）` : '';
  return {
    kind: 'text',
    timestamp,
    summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}助手请求失败${label}：${err.message.slice(0, 120)}]`,
    detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}助手请求失败${label}：${err.message}]`,
    provider: 'opencode',
  };
}

/**
 * 工具调用入参。上游 v2.2.7 的 `toolInput()`：streaming 状态的 `input` 是 partial JSON
 * 字符串，先尝试按 JSON 解码、失败保留字符串；其余状态是对象。以前把字符串原样当对象传，
 * summary 被 `JSON.stringify` 双重转义、目标 writer 拿到非对象（claude 会兜底成
 * `{input: <截断的转义串>}`）。这里对任何字符串都尝试解码（坏数据也能尽力恢复），
 * 无法恢复 / 解出来不是对象时按原因计数披露，不伪造形状。
 */
function v2ToolInput(state: V2ToolState | undefined, unknown: Map<string, number>): unknown {
  const raw = state?.input;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    const decoded: unknown = JSON.parse(raw);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) return decoded;
    bumpCount(unknown, 'content:tool（input 不是对象）');
    return decoded;
  } catch {
    bumpCount(unknown, 'content:tool（input 无法解析为对象）');
    return raw;
  }
}

function v2AssistantTurn(
  row: V2MessageRow,
  data: V2MessageData,
  unknown: Map<string, number>,
  parts?: V2ContentItem[],
): UnifiedTurn | null {
  const time = typeof data.time?.created === 'number' ? data.time.created : row.time_created;
  const timestamp = isoFromEpochMs(time);
  // content 只接受字符串或数组；对象 / 数字 / null 以前会被折成空数组并按空回复跳过，
  // 整段内容静默消失。数组里逐项的非对象由下面的 items 循环计数。
  if (data.content !== undefined && typeof data.content !== 'string' && !Array.isArray(data.content)) {
    bumpCount(unknown, 'assistant（content 不是数组或字符串）');
  }
  const inline: V2ContentItem[] =
    typeof data.content === 'string' ? [{ type: 'text', text: data.content }] : Array.isArray(data.content) ? data.content : [];
  // 与上游 withParts() 同一顺序：session_part 行（按 ordinal）在前，旧构建写在行内的 content 在后
  const items: V2ContentItem[] = parts?.length ? [...parts, ...inline] : inline;
  const texts: string[] = [];
  const events: ProcessEvent[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      bumpCount(unknown, 'content:（非对象）');
      continue;
    }
    if (item.type === 'text') {
      if (typeof item.text === 'string') {
        if (item.text) texts.push(item.text);
      } else {
        // 上游 text / reasoning 的 text 都是必填字符串；类型不对时以前直接丢弃，
        // 整段答复或思考消失且没有任何计数。
        bumpCount(unknown, 'content:text（text 不是字符串）');
      }
    } else if (item.type === 'reasoning') {
      if (typeof item.text !== 'string') {
        bumpCount(unknown, 'content:reasoning（text 不是字符串）');
      } else if (item.text) {
        events.push({ kind: 'thinking', timestamp, detail: item.text, summary: item.text, provider: 'opencode' });
      }
    } else if (item.type === 'tool') {
      const callId = item.id ?? `oc-${crypto.randomUUID()}`;
      const input = v2ToolInput(item.state, unknown);
      // summary 直接展示字符串原文，避免 JSON.stringify 对半截 JSON 再加一层转义。
      const inputText = typeof input === 'string' ? input : JSON.stringify(input);
      events.push({
        kind: 'tool_call',
        timestamp,
        name: item.name ?? 'tool',
        callId,
        input,
        summary: `${item.name ?? 'tool'} ${inputText.slice(0, 200)}`,
        provider: 'opencode',
      });
      const output = v2ToolResultText(item.state, unknown);
      if (output !== undefined) {
        events.push({ kind: 'tool_result', timestamp, callId, detail: output, summary: output.slice(0, 200), provider: 'opencode' });
      }
    } else {
      bumpCount(unknown, `content:${item.type ?? '（空类型）'}`);
    }
  }

  // 失败轮即使没有正文、没有过程事件也要保留：否则下游看到「用户问了没人答」，
  // 而真实原因是模型调用失败（错误原因已在事件里）。
  const errorEvent = v2AssistantErrorEvent(data.error, timestamp, unknown);
  if (errorEvent) events.push(errorEvent);

  const text = texts.join('\n\n');
  if (!text.trim() && events.length === 0) return null;
  const turn: UnifiedTurn = { role: 'assistant', text, timestamp, provider: 'opencode' };
  if (events.length > 0) turn.events = events;
  return turn;
}

/** 压缩的会话级披露：原生窗口只计数；摘要不可用时按原因计数，不作为裁剪边界。 */
type V2Compactions = {
  native: { count: number; messages: number };
  unusableSummaries: Map<string, number>;
};

/** 后台 shell：上游 `to-llm-message.ts` 对 `metadata.background === true` 直接 `return []` */
type V2BackgroundShells = { count: number; samples: string[] };

/** 非对话事件 → ProcessEvent[]；空数组 = 已识别但无内容（形状异常已按原因计数）；null = 类型未知 */
function v2AuxEvents(
  type: string,
  data: V2MessageData,
  time: number,
  unknown: Map<string, number>,
  compactions: V2Compactions,
  backgroundShells: V2BackgroundShells,
  keptRecent: string,
): ProcessEvent[] | null {
  const timestamp = isoFromEpochMs(time);
  switch (type) {
    case 'shell': {
      const command = typeof data.command === 'string' ? data.command : '';
      // 上游 to-llm-message.ts：后台 shell 在完成前不进模型上下文（结果完成时另行投递）。
      // 当成普通工具调用会让启动消息出现在对话里、还常因为没有 output 触发
      // 「工具调用没有结果，可能在中断或仍在运行」的假警告。只计数与命令样本，不复制输出。
      if (data.metadata?.background === true) {
        backgroundShells.count += 1;
        if (command && backgroundShells.samples.length < 3) {
          backgroundShells.samples.push(escapeControlChars(command).slice(0, 80));
        }
        return [];
      }
      const callId =
        typeof data.shellID === 'string' && data.shellID ? `oc-shell-${data.shellID}` : `oc-shell-${crypto.randomUUID()}`;
      const events: ProcessEvent[] = [
        {
          kind: 'tool_call',
          timestamp,
          name: 'shell',
          callId,
          input: { command },
          summary: `shell ${command}`.trim(),
          provider: 'opencode',
        },
      ];
      const out = typeof data.output === 'string' ? data.output : data.output?.output;
      if (typeof out === 'string' && out) {
        events.push({ kind: 'tool_result', timestamp, callId, detail: out, summary: out.slice(0, 200), provider: 'opencode' });
      }
      return events;
    }
    case 'compaction': {
      // 上游 v2.2.7 只有 status === 'completed' 的压缩才替换上下文（to-llm-message.ts：
      // `if (message.status !== "completed") return []`）；running / failed 的压缩没有生效，
      // 挂上摘要前缀会让 --since-compact 以「未生效的压缩」为边界裁掉更早的轮次，
      // 而 failed 连 summary 都没有（只有 error），裁掉后摘要正文是空的。
      // 第三方旧样本没有 status 字段：保持按 completed 处理（同一形状兼容）。
      const status = typeof data.status === 'string' ? data.status : 'completed';
      if (status === 'completed') {
        // provider 原生压缩：模型拿到的是 native.messages 窗口而不是 summary（上游写的
        // summary 就是空串）。挂摘要前缀会让 --since-compact 把压缩前的轮次全裁掉，只留一行
        // 没有正文的「压缩摘要」。原生窗口只有原 provider / 模型能重放，Watch 不重放、
        // 不当边界，只在会话级披露里计数（与 Codex compacted 记录同一取舍）。
        const windowSize = v2NativeWindow(data, unknown);
        if (windowSize !== null) {
          compactions.native.count += 1;
          compactions.native.messages += windowSize;
          return [];
        }
        const summary = typeof data.summary === 'string' ? data.summary : '';
        // 保留窗口的来源按上游优先级：keepID 重建 > metadata.recent（pre-v2.1 迁移）>
        // 顶层 recent（更老的第三方样本）。三者都是模型压缩后仍能看到的内容。
        const metadata = data.metadata;
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.recent !== undefined) {
          if (typeof metadata.recent !== 'string') bumpCount(unknown, 'compaction（metadata.recent 不是字符串）');
        }
        const storedRecent = typeof metadata?.recent === 'string' ? metadata.recent : '';
        const legacyRecent = typeof data.recent === 'string' ? data.recent : '';
        const recent = keptRecent || storedRecent || legacyRecent;
        // completed 只证明原生压缩完成，不保证 Watch 拿到了可读摘要。空摘要或只有近期
        // 原话都不足以替代更早的背景；不能写摘要前缀，否则 --since-compact 会误裁历史。
        const usableSummary = summary.trim().length > 0;
        if (!usableSummary) {
          bumpCount(compactions.unusableSummaries, typeof data.summary === 'string' ? 'summary 为空或仅空白' : 'summary 不是字符串');
          if (!recent.trim()) return [];
        }
        return [
          {
            kind: 'text',
            timestamp,
            summary: usableSummary
              ? OPENCODE_COMPACTION_SUMMARY_PREFIX
              : '[OpenCode 压缩记录的近期对话（摘要不可用，不作为裁剪边界）]',
            detail: [usableSummary ? summary : '', recent ? `（最近对话：${recent}）` : ''].filter(Boolean).join('\n'),
            provider: 'opencode',
          },
        ];
      }
      // 与 1.x 的未生效分支同一句：真原因在前（状态），兜底建议在后。
      const reason =
        status === 'failed'
          ? typeof data.error?.message === 'string' && data.error.message
            ? `（失败原因：${data.error.message}）`
            : '（失败原因读不出来）'
          : '（尚未完成）';
      return [
        {
          kind: 'text',
          timestamp,
          summary: `[OpenCode 压缩摘要未生效（状态 ${status}），上下文未被替换]`,
          detail: `${reason}；${typeof data.summary === 'string' ? data.summary : ''}`.trim(),
          provider: 'opencode',
        },
      ];
    }
    case 'location-switched': {
      // 上游把它作为模型可见的 user 消息送入上下文（The working directory has been
      // changed to <directory>）；丢掉它，交接后的助手会在旧目录里继续动手。
      const hasLocation = data.location !== undefined && data.location !== null && typeof data.location === 'object';
      const directory = hasLocation && typeof data.location!.directory === 'string' ? data.location!.directory : '';
      if (!directory) {
        // 上游 Location.Ref.directory 是必填的绝对路径字符串；形状异常不能只计类型名（看不出是坏了）。
        bumpCount(unknown, hasLocation ? 'location-switched（directory 不是字符串）' : 'location-switched（无 location）');
        return [];
      }
      return [
        {
          kind: 'text',
          timestamp,
          summary: `[工作目录已切换] ${directory.slice(0, 200)}`,
          detail: `工作目录已切换到 ${directory}。`,
          provider: 'opencode',
        },
      ];
    }
    case 'skill': {
      // 上游把技能正文作为 user 角色文本送入模型（技能 = 会话内生效的指令），name 用于辨识。
      if (typeof data.name !== 'string' || !data.name) {
        bumpCount(unknown, data.name === undefined ? 'skill（无 name）' : 'skill（name 不是字符串）');
        return [];
      }
      if (typeof data.text !== 'string') {
        bumpCount(unknown, 'skill（text 不是字符串）');
        return [];
      }
      return [
        {
          kind: 'text',
          timestamp,
          summary: `[技能已激活：${data.name}] ${data.text.slice(0, 160)}`.trim(),
          detail: data.text,
          provider: 'opencode',
        },
      ];
    }
    case 'system':
    case 'synthetic': {
      const text = typeof data.text === 'string' ? data.text : '';
      const label = type === 'system' ? '系统事件' : '系统生成事件';
      return [{ kind: 'text', timestamp, summary: `[${label}] ${text.slice(0, 160)}`.trim(), detail: text, provider: 'opencode' }];
    }
    default:
      return null;
  }
}

/**
 * 2.x 的 assistant 内容可能被拆进 `session_part`（migration `20261029002625`，2026-10-29）。
 *
 * `experimental.part_rows` 开启时（local / dev 构建默认开启，release 默认关闭），assistant
 * 每个 part 单独一行，`session_message.data.content` 只留空 envelope；上游读取
 * （packages/core/src/session/history.ts 的 `withParts`）按 `(message_id, ordinal)` 拼回
 * `data.content` 之前再解码。只读 `session_message` 会把这类会话解析成「只有提问、助手一句
 * 没回」——整段回复连同思考与工具调用静默消失。
 *
 * 只对 assistant 行生效（上游同样只处理 assistant）。part 行的 `type` 列是权威值，`data`
 * 里即使有 `type` 也被它覆盖——上游解码就是 `{ ...row.data, type: row.type }`。
 * 2026-10-29 之前的 2.x 库没有这张表：没有表 = 没拆过 part，不是「读不出来」，
 * 所以先查 sqlite_master 再取行，不用 catch 把查询失败讲成「没有」。
 */
function readV2Parts(db: DatabaseSync, sessionId: string, unknown: Map<string, number>): Map<string, V2ContentItem[]> {
  const byMessage = new Map<string, V2ContentItem[]>();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_part'").get();
  if (!table) return byMessage;
  const rows = db
    .prepare('SELECT message_id, ordinal, type, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal')
    .all(sessionId) as V2PartRow[];
  for (const row of rows) {
    const parsed = parseJson<Record<string, unknown>>(row.data);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      bumpCount(unknown, `part:${row.type || '（空类型）'}（data 无法解析）`);
      continue;
    }
    const item = { ...(parsed as unknown as V2ContentItem), type: row.type };
    const list = byMessage.get(row.message_id);
    if (list) list.push(item);
    else byMessage.set(row.message_id, [item]);
  }
  return byMessage;
}

function parseOpencodeV2Turns(db: DatabaseSync, sessionId: string): UnifiedTurn[] {
  const rows = db
    .prepare(
      'SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id',
    )
    .all(sessionId) as V2MessageRow[];
  if (rows.length === 0) return [];

  const turns: UnifiedTurn[] = [];
  // 非对话事件先挂到上一条 turn；上一条还没有时暂存，等下一轮对话出现再挂（不单独造 turn）
  const pending: ProcessEvent[] = [];
  const unknown = new Map<string, number>();
  const compactions: V2Compactions = { native: { count: 0, messages: 0 }, unusableSummaries: new Map() };
  const backgroundShells: V2BackgroundShells = { count: 0, samples: [] };
  const partsByMessage = readV2Parts(db, sessionId, unknown);

  // 事件属于「模型处理这一轮的过程」，优先挂到它之后的 assistant turn；
  // 上一条还是 user（或还没有 turn）时先暂存，别把工具过程挂到用户提问上。
  const attach = (events: ProcessEvent[]): void => {
    if (events.length === 0) return;
    const last = turns.at(-1);
    if (last?.role === 'assistant') last.events = [...(last.events ?? []), ...events];
    else pending.push(...events);
  };
  // 新的 user 轮到达 = 暂存的事件都发生在它之前。必须落回前一条 turn，不能跟着挂到它之后的
  // assistant 上：那样 compaction 会排在这次提问**之后**（`--since-compact` 按事件所在轮次切窗口，
  // 就会把这条提问一起裁掉），阅读顺序也与 seq 相反。只有还没有任何 turn 时才继续暂存。
  const flushPendingToLast = (): void => {
    if (pending.length === 0) return;
    const last = turns.at(-1);
    if (!last) return;
    last.events = [...(last.events ?? []), ...pending];
    pending.length = 0;
  };

  // 行只解析一次：保留窗口重建与主循环共用同一份结果（重复 JSON.parse 没有意义）。
  // 坏 JSON 与合法但非对象的 JSON（null / [] / 42 / "str"）都不是消息。以前后者会被
  // 当成「这条消息没有字段」继续处理：user 记成「无文本」、assistant 直接返回 null，
  // 内容静默消失且类型归属还是错的。两者都按「data 不是对象」计数。
  const parsed = rows.map((row) => {
    const data = parseJson<V2MessageData>(row.data);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : null;
  });
  const keptRecentByRow = v2KeptRecentTexts(rows, parsed, partsByMessage, unknown);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const data = parsed[i];
    if (!data) {
      bumpCount(unknown, `${row.type || '（空类型）'}（data 不是对象）`);
      continue;
    }
    const time = typeof data.time?.created === 'number' ? data.time.created : row.time_created;

    if (row.type === 'user') {
      const turn = v2UserTurn(row, data, unknown);
      if (!turn) continue;
      flushPendingToLast();
      turns.push(turn);
      continue;
    }

    if (row.type === 'assistant') {
      const turn = v2AssistantTurn(row, data, unknown, partsByMessage.get(row.id));
      if (!turn) continue;
      // 与 1.x 相同的一档合并：纯文本的助手消息接在带工具调用的上一条之后，归回同一个 turn
      const prev = turns.at(-1) ?? null;
      const prevHasTool = (prev?.events ?? []).some((e) => e.kind === 'tool_call');
      if (!turn.events && turn.text.trim() && prev?.role === 'assistant' && prevHasTool) {
        prev.text = prev.text ? `${prev.text}\n\n${turn.text}` : turn.text;
        continue;
      }
      if (pending.length > 0) {
        turn.events = [...pending, ...(turn.events ?? [])];
        pending.length = 0;
      }
      turns.push(turn);
      continue;
    }

    const aux = v2AuxEvents(
      row.type,
      data,
      time,
      unknown,
      compactions,
      backgroundShells,
      keptRecentByRow.get(row.id) ?? '',
    );
    if (aux === null) {
      // 记账类型（agent-switched / idle）上游不进模型上下文，正常会话不该因此冒披露。
      if (!V2_IGNORED_MESSAGE_TYPES.has(row.type)) bumpCount(unknown, row.type || '（空类型）');
    } else attach(aux);
  }

  // 会话以非对话事件收尾时（后面没有 assistant 了），挂到最后一条 turn 上，别让它们消失
  if (pending.length > 0 && turns.length > 0) {
    const last = turns.at(-1)!;
    last.events = [...(last.events ?? []), ...pending];
    pending.length = 0;
  }

  // provider 原生压缩：压缩前的原文还在这份日志里（上游的本地转录同样保留），所以交接内容
  // 可能比 OpenCode 当前发给模型的更多；同时说明它不是 --since-compact 的边界，避免头部披露
  // 与正文「没有可用摘要」互相矛盾。只报次数与条数，窗口内容不复制。
  if (compactions.native.count > 0) {
    appendUnknownDisclosure(
      turns,
      `OpenCode 2.x 有 ${compactions.native.count} 次 provider 原生压缩（替换窗口共 ${compactions.native.messages} 条消息），Watch 不重放原生窗口`,
      '压缩前的对话原文仍保留在本次交接里，可能比 OpenCode 当前发给模型的上下文更多；原生窗口只有生成它的 provider / 模型能重放，这些压缩没有可读摘要，不作为 --since-compact 的边界',
    );
  }

  // 空摘要不冒充成功边界，且降级必须在选窗前可见。只在统一披露里汇总原因与次数，
  // 不改轮次正文或增量键；没有对话载体时仍返回 []，由入口的零轮检查处理。
  if (compactions.unusableSummaries.size > 0) {
    const count = [...compactions.unusableSummaries.values()].reduce((sum, n) => sum + n, 0);
    appendUnknownDisclosure(
      turns,
      `OpenCode 2.x 有 ${count} 次已完成压缩没有可读摘要`,
      `${describeCounts(compactions.unusableSummaries)}；这些记录不作为 --since-compact 的边界，仍按现存对话及其他选窗条件生成交接；近期对话不能替代缺失的历史摘要`,
    );
  }

  // 后台 shell 不并入对话（上游在完成前同样不送模型上下文），但用户起过哪些后台命令
  // 对接手的一侧有用：只报个数与前三条命令，不复制输出。正常前台 shell 不触发这条。
  if (backgroundShells.count > 0) {
    appendUnknownDisclosure(
      turns,
      `OpenCode 2.x 有 ${backgroundShells.count} 个后台 shell 命令未并入对话`,
      `上游在命令完成前不把它们送进模型上下文（结果完成时另行投递）${
        backgroundShells.samples.length ? `；命令：${backgroundShells.samples.join('、')}` : ''
      }`,
    );
  }

  // 统一披露必须独立于过程记录展示与选窗；无安全载体时不造新轮次。
  if (unknown.size > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    appendUnknownDisclosure(
      turns,
      `OpenCode 2.x 有 ${total} 条未识别事件，未并入对话`,
      `${describeCounts(unknown)}；Watch 按上游 v2.2.7 的会话消息语义识别 user / assistant / shell / system / synthetic / compaction / location-switched / skill（agent-switched / idle / model-switched 按上游记账忽略），其余原样跳过，不猜含义`,
    );
  }
  return turns;
}

/** 读 SQLite 把 OpenCode session 解析为 UnifiedTurn[] */
export async function parseOpencodeSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const dbPath = ref.filePath || opencodeDbPath();
  // 库文件不存在 = 还没有内容（库被清 / 会话刚建）；但路径被占住、库打不开、查不了
  // 都不是「这个会话是空的」——返回 [] 会让 diffTurns 把目标当成空会话，把来源整段再追加一遍
  if ((await probeOpencodeDbFile(dbPath)) === 'missing') return [];
  const v2 = detectOpencodeLayout(dbPath) === 'v2';
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw opencodeDbSqliteError(dbPath, '打开', error);
  }

  try {
    if (v2) return parseOpencodeV2Turns(db, ref.sessionId);
    // 正文与回退状态必须来自同一个读取快照：先读 message / part、再读 session.revert 之间，
    // 原生 cleanup 可能删掉回退点之后的消息并清掉 revert——那样会返回已回退的正文，却没有任何
    // 「日志含已回退内容」的披露。显式 BEGIN 让这条只读连接从第一次 SELECT 起持有同一快照
    // （WAL 下不阻塞写者），读完再一并结束。
    db.exec('BEGIN');
    let sealed = false;
    try {
      const messages = db
        .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
        .all(ref.sessionId) as MessageRow[];

      if (messages.length === 0) {
        sealed = true;
        return [];
      }

      const parts = db
        .prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id')
        .all(ref.sessionId) as PartRow[];

      const partsByMessage = new Map<string, PartRow[]>();
      for (const part of parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
      }

      const unknown = new Map<string, number>();
      const stats: V1ParseStats = { ignoredTexts: 0 };
      const turns: UnifiedTurn[] = [];
      for (const msg of messages) {
        const turn = messageToTurn(msg, partsByMessage.get(msg.id) ?? [], turns.at(-1) ?? null, unknown, stats);
        if (turn) turns.push(turn);
      }
      // 回退标记登记后、原生 cleanup 之前，库里仍保留已回退的消息。只披露，不猜当前投影；
      // 事件不改正文，避免只新增回退状态时 diffTurns 重放旧轮。空工具助手轮不能承载文本。
      const revert = readOpencodeRevert(db, ref.sessionId);
      if (revert) {
        const carrier = [...turns].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
        if (carrier) {
          const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${describeOpencodeRevert(revert)}]`;
          carrier.events = [...(carrier.events ?? []),
            { kind: 'text', summary: text, detail: text, timestamp: carrier.timestamp, provider: 'opencode' }];
        }
      }
      // ignored 文本是「来源自己没送进模型上下文」的数据：不并入对话，但也不能无声消失。
      // 与 pi / kimi / claude 的上下文披露同一载体（WATCH_CONTEXT_DISCLOSURE_PREFIX 事件），
      // 进 prompt 头部「上下文完整性」、handoff warnings 与 open warnings。
      if (stats.ignoredTexts > 0) {
        const carrier = [...turns].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
        if (carrier) {
          const text =
            `${WATCH_CONTEXT_DISCLOSURE_PREFIX}OpenCode 日志里有 ${stats.ignoredTexts} 段被原生标记为 ignored 的文本没有并入对话；` +
            '上游 OpenCode 不把这类文本送进模型上下文（message-v2 的 toModelMessages 会跳过），Watch 照同一口径处理，' +
            '原文仍保留在 OpenCode 库里，需要时请在原生客户端核对]';
          carrier.events = [
            ...(carrier.events ?? []),
            { kind: 'text', summary: text, detail: text, timestamp: carrier.timestamp, provider: 'opencode' },
          ];
        }
      }
      // 与 2.x 同一披露面：类型与条数进入 prompt 头部 / warnings，不依赖过程记录展开。
      // 无安全载体时不凭空造 turn；零轮仍由调用方拒绝或披露。
      if (unknown.size > 0) {
        const total = [...unknown.values()].reduce((a, b) => a + b, 0);
        appendUnknownDisclosure(
          turns,
          `OpenCode 有 ${total} 处未识别或无法解析的数据，未并入对话`,
          `${describeCounts(unknown)}；Watch 只识别 user / assistant 消息与 text / reasoning / tool / file 内容，` +
            'step-start / step-finish / patch / snapshot / agent / subtask / retry 是原生步骤、快照、子代理与重试记账，compaction 是压缩标记，都不并入对话；其余原样跳过，不猜含义',
        );
      }
      sealed = true;
      return turns;
    } finally {
      try {
        db.exec(sealed ? 'COMMIT' : 'ROLLBACK');
      } catch {
        // 连接随后会关闭；这里不掩盖解析本身的结果或错误
      }
    }
  } catch (error) {
    // 「file is not a database」是在 prepare 时才抛的：打开成功不代表库可用，也要翻成中文
    throw opencodeDbSqliteError(dbPath, '查询', error);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}
