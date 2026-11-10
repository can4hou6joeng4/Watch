import { DatabaseSync } from 'node:sqlite';
import { normalizeUserText } from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { assertReadableOpencodeDb, opencodeDbPath, opencodeDbSqliteError, probeOpencodeDbFile } from './paths.js';

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
  model?: { providerID?: string; modelID?: string };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

type OpencodePartData =
  | { type: 'text'; text?: string; time?: { start?: number; end?: number } }
  | { type: 'reasoning'; text?: string }
  | {
      type: 'tool';
      callID?: string;
      tool?: string;
      state?: {
        status?: string;
        input?: Record<string, unknown>;
        output?: unknown;
      };
    }
  | { type: 'file'; mime?: unknown; url?: unknown; filename?: unknown; path?: unknown }
  | { type: string };

function isTextPart(part: OpencodePartData): part is { type: 'text'; text?: string } {
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
 * file part → attachment text 事件（不搬进 turn.text，避免文本翻倍；也不拆 base64——
 * url 本身就是 data URI，数据随 attachment.url 过链，opencode build 可还原 file part）。
 * 占位文本放 event summary/detail，保证任何展示层可读。
 */
function filePartToEvent(part: OpencodePartData, time: number): ProcessEvent | null {
  if (!isFilePart(part)) return null;
  const mime = typeof part.mime === 'string' && part.mime ? part.mime : 'file';
  const url = typeof part.url === 'string' && part.url ? part.url : undefined;
  const filename = typeof part.filename === 'string' && part.filename ? part.filename : undefined;
  const size = url ? `，约${Math.floor(url.length * 3 / 4)}B` : '';
  const name = filename ? ` ${filename}` : '';
  const placeholder = `[附件：${mime}${size}${name}]`;
  return {
    kind: 'text',
    timestamp: new Date(time).toISOString(),
    summary: placeholder,
    detail: placeholder,
    provider: 'opencode',
    attachment: { kind: 'file', mediaType: mime, url, filename },
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
  state?: { status?: string; input?: Record<string, unknown>; output?: unknown };
} {
  return (part as { type: string }).type === 'tool';
}

function partToEvents(part: OpencodePartData, baseTime: number): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  if (isReasoningPart(part)) {
    events.push({
      kind: 'thinking',
      timestamp: new Date(baseTime).toISOString(),
      detail: part.text ?? '',
      summary: part.text ?? '',
      provider: 'opencode',
    });
  } else if (isToolPart(part)) {
    const callId = part.callID ?? `oc-${crypto.randomUUID()}`;
    const input = part.state?.input ?? {};
    events.push({
      kind: 'tool_call',
      timestamp: new Date(baseTime).toISOString(),
      name: part.tool ?? 'tool',
      callId,
      input,
      summary: `${part.tool ?? 'tool'} ${JSON.stringify(input).slice(0, 200)}`,
      provider: 'opencode',
    });
    if (part.state?.output !== undefined) {
      events.push({
        kind: 'tool_result',
        timestamp: new Date(baseTime).toISOString(),
        callId,
        detail: typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output),
        summary: typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output).slice(0, 200),
        provider: 'opencode',
      });
    }
  }
  return events;
}

function messageToTurn(
  msg: MessageRow,
  parts: PartRow[],
  prevTurn: UnifiedTurn | null,
): UnifiedTurn | null {
  const data = parseJson<OpencodeMessageData>(msg.data);
  const role = data?.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const baseTime = data?.time?.created ?? msg.time_created;
  const timestamp = new Date(baseTime).toISOString();

  const textParts: string[] = [];
  const events: ProcessEvent[] = [];
  let hasToolEvents = false;

  for (const partRow of parts) {
    const part = parseJson<OpencodePartData>(partRow.data);
    if (!part) continue;
    const partTime = partRow.time_created;
    if (isTextPart(part)) {
      if (part.text) textParts.push(part.text);
    } else {
      if (isToolPart(part)) hasToolEvents = true;
      const partEvent = filePartToEvent(part, partTime);
      if (partEvent) events.push(partEvent);
      events.push(...partToEvents(part, partTime));
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

/** 读 SQLite 把 OpenCode session 解析为 UnifiedTurn[] */
export async function parseOpencodeSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const dbPath = ref.filePath || opencodeDbPath();
  // 库文件不存在 = 还没有内容（库被清 / 会话刚建）；但路径被占住、库打不开、查不了
  // 都不是「这个会话是空的」——返回 [] 会让 diffTurns 把目标当成空会话，把来源整段再追加一遍
  if ((await probeOpencodeDbFile(dbPath)) === 'missing') return [];
  assertReadableOpencodeDb(dbPath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw opencodeDbSqliteError(dbPath, '打开', error);
  }

  try {
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

    const turns: UnifiedTurn[] = [];
    for (const msg of messages) {
      const turn = messageToTurn(msg, partsByMessage.get(msg.id) ?? [], turns.at(-1) ?? null);
      if (turn) turns.push(turn);
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
