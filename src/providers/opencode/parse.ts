import { DatabaseSync } from 'node:sqlite';
import { normalizeUserText, OPENCODE_COMPACTION_SUMMARY_PREFIX, OPENCODE_SYNTHETIC_TEXT_PREFIX, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import { isoFromEpochMs } from '../../core/time.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { detectOpencodeLayout, opencodeDbPath, opencodeDbSqliteError, probeOpencodeDbFile } from './paths.js';

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
 * 1.x 原生会写、但不承载对话内容的记账 part。
 *
 * 依据上游 v1.18.29（16747470f976aca3d362ad730bcd3fe82ecc2c9a）的
 * `packages/opencode/src/session/processor.ts`：`step-start` / `step-finish` 是每个 step 的
 * 起止帧，`patch` 在每次改过文件的 step-finish 与 cleanup 之后写入（`snapshot.patch()` 有
 * 文件差异才写），`snapshot` 同属快照记账。第三方实现 catchup（8280337）与 CASR（fac8916）
 * 也显式忽略这四种。第五十八轮只排除了 step-start / step-finish，于是**任何改过文件的正常
 * 会话**都会带一条「有 N 处未识别」的假披露，还会被 claude / codex 写进目标会话。
 *
 * `compaction` 单独处理：它标记压缩点，正文由紧随其后的 `summary: true` 消息承载（见下方
 * 压缩摘要分支），不是丢失的数据。
 */
const V1_IGNORED_PART_TYPES = new Set(['step-start', 'step-finish', 'patch', 'snapshot']);

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
      // text / reasoning / tool / file 之外的类型（subtask / agent / retry 等）不搬运内容，
      // 但必须把类型与条数交给最后一条 turn 披露，不能让它看起来从未存在。
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
 * 类型集合来自第三方转换器 cross_agent_session_resumer 的 2.x 测试样本
 * （`tests/opencode_v2_test.rs`，session_v2 / session_message 列定义与插入语句它都记了）：
 * user / assistant 是对话，assistant 的 `content` 数组里是 text / reasoning / tool；
 * shell / synthetic / system / compaction / model-switched 是事件。本机没有原生 2.x 样本，
 * 所以只映射这些见过形状的类型，其余原样跳过并把条数写进内容（不猜含义）。
 */
type V2MessageRow = { id: string; type: string; seq: number; time_created: number; data: string };

type V2PartRow = { message_id: string; ordinal: number; type: string; data: string };

type V2ToolState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  content?: unknown;
  error?: { message?: string };
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

type V2MessageData = {
  text?: string;
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
  model?: { providerID?: string; id?: string; modelID?: string };
};

function bumpCount(map: Map<string, number>, key: string): void {
  const k = key.trim() || '（空类型）';
  map.set(k, (map.get(k) ?? 0) + 1);
}

function describeCounts(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} × ${n}`)
    .join('、');
}

function v2ToolResultText(state: V2ToolState | undefined): string | undefined {
  if (state?.error?.message) return state.error.message;
  const content = state?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .filter((t) => t.length > 0);
    if (texts.length) return texts.join('\n');
  }
  if (typeof state?.output === 'string') return state.output;
  if (state?.output !== undefined) return JSON.stringify(state.output);
  return undefined;
}

function v2UserTurn(row: V2MessageRow, data: V2MessageData): UnifiedTurn | null {
  const raw = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
  const normalized = normalizeUserText(raw);
  if (!normalized) return null;
  const time = typeof data.time?.created === 'number' ? data.time.created : row.time_created;
  return { role: 'user', text: normalized, timestamp: isoFromEpochMs(time), provider: 'opencode' };
}

function v2AssistantTurn(
  row: V2MessageRow,
  data: V2MessageData,
  unknown: Map<string, number>,
  parts?: V2ContentItem[],
): UnifiedTurn | null {
  const time = typeof data.time?.created === 'number' ? data.time.created : row.time_created;
  const timestamp = isoFromEpochMs(time);
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
      if (typeof item.text === 'string' && item.text) texts.push(item.text);
    } else if (item.type === 'reasoning') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        events.push({ kind: 'thinking', timestamp, detail: text, summary: text, provider: 'opencode' });
      }
    } else if (item.type === 'tool') {
      const callId = item.id ?? `oc-${crypto.randomUUID()}`;
      const input = item.state?.input ?? {};
      events.push({
        kind: 'tool_call',
        timestamp,
        name: item.name ?? 'tool',
        callId,
        input,
        summary: `${item.name ?? 'tool'} ${JSON.stringify(input).slice(0, 200)}`,
        provider: 'opencode',
      });
      const output = v2ToolResultText(item.state);
      if (output !== undefined) {
        events.push({ kind: 'tool_result', timestamp, callId, detail: output, summary: output.slice(0, 200), provider: 'opencode' });
      }
    } else {
      bumpCount(unknown, `content:${item.type ?? '（空类型）'}`);
    }
  }

  const text = texts.join('\n\n');
  if (!text.trim() && events.length === 0) return null;
  const turn: UnifiedTurn = { role: 'assistant', text, timestamp, provider: 'opencode' };
  if (events.length > 0) turn.events = events;
  return turn;
}

/** 非对话事件 → ProcessEvent[]；返回 null 表示这个 type 不在已记录的样本里 */
function v2AuxEvents(type: string, data: V2MessageData, time: number): ProcessEvent[] | null {
  const timestamp = isoFromEpochMs(time);
  switch (type) {
    case 'shell': {
      const command = typeof data.command === 'string' ? data.command : '';
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
      const summary = typeof data.summary === 'string' ? data.summary : '';
      const recent = typeof data.recent === 'string' ? data.recent : '';
      return [
        {
          kind: 'text',
          timestamp,
          summary: OPENCODE_COMPACTION_SUMMARY_PREFIX,
          detail: [summary, recent ? `（最近对话：${recent}）` : ''].filter(Boolean).join('\n'),
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
    case 'model-switched': {
      const label = [data.model?.providerID, data.model?.id ?? data.model?.modelID].filter(Boolean).join('/');
      return [{ kind: 'text', timestamp, summary: `[模型切换]${label ? ` ${label}` : ''}`, detail: label, provider: 'opencode' }];
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
  const partsByMessage = readV2Parts(db, sessionId, unknown);
  let lastTime = 0;

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

  for (const row of rows) {
    const data = parseJson<V2MessageData>(row.data);
    const time = typeof data?.time?.created === 'number' ? data.time.created : row.time_created;
    if (time > lastTime) lastTime = time;
    if (!data) {
      bumpCount(unknown, `${row.type || '（空类型）'}（data 无法解析）`);
      continue;
    }

    if (row.type === 'user') {
      const turn = v2UserTurn(row, data);
      if (!turn) {
        bumpCount(unknown, 'user（无文本）');
        continue;
      }
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

    const aux = v2AuxEvents(row.type, data, time);
    if (aux === null) bumpCount(unknown, row.type || '（空类型）');
    else attach(aux);
  }

  // 会话以非对话事件收尾时（后面没有 assistant 了），挂到最后一条 turn 上，别让它们消失
  if (pending.length > 0 && turns.length > 0) {
    const last = turns.at(-1)!;
    last.events = [...(last.events ?? []), ...pending];
    pending.length = 0;
  }

  // 未识别的事件类型不能静默消失：把条数与类型写进最后一条 turn 的事件里。
  // 没有任何对话 turn 时无处承载（见边界说明），只能返回 []——这一档等同于「没有可搬运的对话」。
  if (unknown.size > 0 && turns.length > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const last = turns.at(-1)!;
    last.events = [
      ...(last.events ?? []),
      {
        kind: 'text',
        timestamp: isoFromEpochMs(lastTime || Date.now()),
        summary: `[OpenCode 2.x 有 ${total} 条未识别事件，未并入对话]`,
        detail: `${describeCounts(unknown)}；Watch 只按第三方记录的 2.x 测试样本识别 user / assistant / shell / system / synthetic / compaction / model-switched，其余原样跳过，不猜含义`,
        provider: 'opencode',
      },
    ];
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
    const messages = db
      .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(ref.sessionId) as MessageRow[];

    if (messages.length === 0) return [];

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
    let lastTime = 0;
    for (const msg of messages) {
      if (msg.time_created > lastTime) lastTime = msg.time_created;
      const turn = messageToTurn(msg, partsByMessage.get(msg.id) ?? [], turns.at(-1) ?? null, unknown, stats);
      if (turn) turns.push(turn);
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
    // 与 2.x 同一披露面：坏 JSON / 未知类型不能静默消失，把条数与类型写进最后一条 turn。
    // 没有任何可搬运的对话时无处承载（返回 [] 会让调用方按「0 轮」拒绝或披露），这一档
    // 等同于「没有可交接的内容」，边界与 v2 一致。
    if (unknown.size > 0 && turns.length > 0) {
      const total = [...unknown.values()].reduce((a, b) => a + b, 0);
      const last = turns.at(-1)!;
      last.events = [
        ...(last.events ?? []),
        {
          kind: 'text',
          timestamp: isoFromEpochMs(lastTime || Date.now()),
          summary: `[OpenCode 有 ${total} 处未识别或无法解析的数据，未并入对话]`,
          detail:
            `${describeCounts(unknown)}；Watch 只识别 user / assistant 消息与 text / reasoning / tool / file 内容，` +
            'step-start / step-finish / patch / snapshot 是原生步骤与快照记账、compaction 是压缩标记，都不并入对话；其余原样跳过，不猜含义',
          provider: 'opencode',
        },
      ];
    }
    return turns;
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
