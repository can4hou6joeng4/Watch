import { readFile } from 'node:fs/promises';
import {
  ENCRYPTED_THINKING,
  ensureAssistant,
  extractExecCommand,
  flattenToolOutput,
  normalizeUserText,
  pushEvent,
  stripEmptyEvents,
  summarize,
  WATCH_CONTEXT_DISCLOSURE_PREFIX,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

/**
 * Codex rollout JSONL → 统一时间线（Rich）：
 * - response_item message：user 过滤内部上下文；assistant 最终回复覆盖 turn.text
 * - reasoning / function_call / custom_tool_call / command_execution 挂到 assistant.events
 * - commentary / partial_answer 保留为 text 事件；显式 final_answer 后的阶段文本丢掉；phase 缺省保持旧兼容
 * - 最后停在阶段消息的助手轮标记 incomplete，并计数披露未记录最终答复
 * - compacted：Codex 压缩上下文后的摘要记录，只计数并披露，不并入摘要正文（见 describeCodexCompaction）
 * - 整份文件无 response_item message 时，回退 event_msg；agent_message 共享上述阶段处理
 * - 坏行/空行跳过；丢弃首条 user 之前的记录
 */
export async function parseCodexSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  const fallback: UnifiedTurn[] = [];
  let sawUser = false;
  let sawFallbackUser = false;
  let hasResponseMessages = false;
  const finalized = new WeakSet<UnifiedTurn>();
  const acceptAssistant = (turn: UnifiedTurn, text: string, timestamp: string, p: Record<string, unknown>): void => {
    const isMidTurn = p.phase === 'commentary' || p.phase === 'partial_answer';
    if (isMidTurn && finalized.has(turn)) return;
    // 只跳过带 Watch 标记且与最近结构事件对应的回显；原生同文说明仍须保留。
    const meta = p.internal_chat_message_metadata_passthrough;
    const marked = typeof meta === 'object' && meta !== null &&
      (meta as Record<string, unknown>).watch_generated_commentary === true;
    if (p.phase === 'commentary' && marked && isGeneratedCommentaryMirror(turn, text)) return;
    if (isMidTurn) {
      pushEvent(turn, {
        kind: 'text',
        summary: text.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)
          ? text : summarize(text, p.phase === 'partial_answer' ? '阶段回复' : '过程'),
        detail: text,
        timestamp,
        provider: 'codex',
      });
      turn.incomplete = true;
    } else {
      // 缺省 phase 保持旧正文语义，但不能据此阻断后续明确标记的阶段消息。
      delete turn.incomplete;
    }
    if (p.phase === 'final_answer') finalized.add(turn);
    turn.text = text;
    turn.timestamp = timestamp;
    turn.provider = 'codex';
  };
  const compaction: CodexCompactionCounts = {
    total: 0,
    readable: 0,
    unreadable: 0,
    turnsAtFirst: null,
    fallbackAtFirst: null,
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;
    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
    const payload = r.payload;
    // 顶层 compacted：payload.message 是 Codex 压缩上下文后注入模型的历史摘要，
    // payload.replacement_history 是压缩后的上下文投影。真实 rollout 里 message 常为空
    // （openai/codex#41954、#44363），且压缩前的原始记录可能已被销毁——Watch 不做压缩窗口
    // 投影，应用它只会重复或丢内容，所以只按整份日志计数，循环结束后挂一条披露事件。
    // 摘要正文、replacement_history、metadata 一律不复制。
    if (r.type === 'compacted') {
      compaction.total += 1;
      if (compaction.turnsAtFirst === null) {
        compaction.turnsAtFirst = turns.length;
        compaction.fallbackAtFirst = fallback.length;
      }
      const message =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).message
          : undefined;
      if (typeof message === 'string' && message.trim()) compaction.readable += 1;
      else compaction.unreadable += 1;
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;

    if (r.type === 'response_item' && p.type !== 'message') {
      if (!sawUser) continue;
      const events = processItemToEvents(p, timestamp);
      if (!events.length) continue;
      const last = ensureAssistant(turns, timestamp, 'codex');
      for (const ev of events) pushEvent(last, ev);
      continue;
    }

    if (r.type === 'response_item' && p.type === 'message') {
      const role = typeof p.role === 'string' ? p.role : '';
      const text = flattenCodexContent(p.content);
      if (text.trim() === '') continue;
      if (role === 'user') {
        if (isInternalCodexContext(text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(text));
        if (normalized === null) continue;
        hasResponseMessages = true;
        sawUser = true;
        turns.push({ role: 'user', text: normalized, timestamp });
      } else if (role === 'assistant') {
        if (!sawUser) continue;
        hasResponseMessages = true;
        acceptAssistant(ensureAssistant(turns, timestamp, 'codex'), text, timestamp, p);
      }
      continue;
    }

    if (r.type === 'event_msg') {
      if (p.type === 'token_count') {
        const usage = readTurnUsage(p.info);
        if (usage) {
          // 挂到这一轮最后一条 assistant 上——原生 rollout 里 `token_count` 紧跟在本次模型调用
          // 之后写出，一轮多次调用会各来一条 `last_token_usage`，逐条累加才是该轮真实用量。
          // **不能 `ensureAssistant()`**：那会在没有 assistant 回复的轮（纯 user 记录、
          // 会话开头那条只带 `total_token_usage` 的 token_count）凭空造一个空 turn。
          // 只在**正在用的那条时间线**上找目标：现代 rollout 同时写 response_item 与
          // event_msg（回退时间线会被整份丢弃），跨两条找会把用量挂到一条不会被返回的 turn 上。
          const target = turns.length ? lastAssistantOf(turns) : lastAssistantOf(fallback);
          if (target) target.usage = addUsage(target.usage, usage);
        }
        continue;
      }
      if (p.type === 'user_message' && typeof p.message === 'string') {
        const text = p.message;
        if (text.trim() === '' || isInternalCodexContext(text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(text));
        if (normalized === null) continue;
        sawFallbackUser = true;
        fallback.push({ role: 'user', text: normalized, timestamp });
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        const text = p.message;
        if (!sawFallbackUser || text.trim() === '') continue;
        acceptAssistant(ensureAssistant(fallback, timestamp, 'codex'), text, timestamp, p);
      }
    }
  }
  const active = hasResponseMessages ? turns : fallback;
  // 「压缩点之前有没有对话原文」只能按**最终活动的**时间线判断：混合 wire 时回退时间线会被
  // 整份丢弃，拿它算出来的「有原文」在返回值里并不成立。
  const sawConversationBefore = hasResponseMessages
    ? (compaction.turnsAtFirst ?? 0) > 0
    : (compaction.fallbackAtFirst ?? 0) > 0;
  const disclosure = describeCodexCompaction(compaction, sawConversationBefore);
  if (disclosure && active.length > 0) {
    const last = active[active.length - 1]!;
    pushEvent(last, {
      kind: 'text',
      summary: disclosure,
      detail: disclosure,
      timestamp: last.timestamp,
      provider: 'codex',
    });
  }
  const incomplete = active.filter((turn) => turn.incomplete).length;
  if (incomplete > 0) {
    const last = active[active.length - 1]!;
    const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}Codex 有 ${incomplete} 轮助手回复最后停在 commentary / partial_answer，未记录最终答复；交接保留阶段文本，不能据此认为任务已完成，请在来源核对]`;
    pushEvent(last, { kind: 'text', summary: text, detail: text, timestamp: last.timestamp, provider: 'codex' });
  }
  return stripEmptyEvents(active);
}

type CodexCompactionCounts = {
  /** 顶层 compacted 记录总数 */
  total: number;
  /** payload.message 为非空字符串 */
  readable: number;
  /** message 缺失 / 空 / 非字符串，或 payload 形状不可读 */
  unreadable: number;
  /** 首条压缩记录出现时，两条时间线各自的轮次数（null = 还没遇到 compacted） */
  turnsAtFirst: number | null;
  fallbackAtFirst: number | null;
};

/**
 * 披露文案只说能从日志里证明的事实：
 * - 「压缩点之前有没有对话原文」由解析器在首条 compacted 时按已解析轮次判定，不无条件断言
 *   「保留全量原文」——真实 rollout 可能被重建成只剩 session_meta + compacted；
 * - 只发一条汇总事件：真实会话可能积累几十上百条 compacted，逐条渲染会刷屏；
 * - 摘要正文与 replacement_history 不复制，措辞里也不说「内容已丢失」。
 */
function describeCodexCompaction(counts: CodexCompactionCounts, sawConversationBefore: boolean): string {
  if (counts.total === 0) return '';
  const details: string[] = [];
  if (counts.readable > 0) details.push(`${counts.readable} 条带可读摘要`);
  if (counts.unreadable > 0) details.push(`${counts.unreadable} 条摘要为空或不可读`);
  const shape = sawConversationBefore
    ? '日志在压缩点之前保留了对话原文，交接会包含这些旧内容，可能比 Codex 当前发给模型的上下文更多'
    : '日志在压缩点之前没有对话原文，Watch 也不解析 replacement_history，交接会缺少这段历史';
  return (
    `${WATCH_CONTEXT_DISCLOSURE_PREFIX}Codex 会话日志里有 ${counts.total} 条上下文压缩记录` +
    (details.length > 0 ? `（${details.join('、')}）` : '') +
    `，Watch 没有把摘要并入交接、也没有应用 Codex 的压缩窗口：${shape}；` +
    '需要以 Codex 当前上下文为准时请在原生 Codex 里核对]'
  );
}

/**
 * `token_count` 里的 `info.last_token_usage` 才是**本轮**量。
 *
 * `total_token_usage` 是整条会话的累计（本机只读采样：524 个 rollout、其中 493 个含 3 条以上
 * `token_count` 的文件里它单调不减），拿它当 per-turn 会让第 N 轮记成「前 N 轮之和」，
 * 转入别家后用量虚高数倍。这与 `codexSessionUsage()` 的分工不同：那边要的是会话合计，
 * 所以读累计；这边要的是每一轮的增量，所以读 `last_token_usage`。
 *
 * 0/0 是占位：Watch 的写出侧在没有 `turn.usage` 时仍会写一条 `token_count`
 * （`last_token_usage` / `total_token_usage` 都是 0），把它当成真实用量会让「这条会话没有
 * 用量数据」变成「确实用了 0 token」。判据与 claude / kimi / grok 的读取侧一致。
 */
function readTurnUsage(info: unknown): TokenUsage | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const last = (info as Record<string, unknown>).last_token_usage;
  if (typeof last !== 'object' || last === null) return undefined;
  const u = last as Record<string, unknown>;
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

/** `cached_input_tokens` 是 `input_tokens` 的子集（OpenAI responses 口径），不再相加。 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function addUsage(prev: TokenUsage | undefined, add: TokenUsage): TokenUsage {
  if (!prev) return { inputTokens: add.inputTokens, outputTokens: add.outputTokens };
  return { inputTokens: prev.inputTokens + add.inputTokens, outputTokens: prev.outputTokens + add.outputTokens };
}

function lastAssistantOf(turns: UnifiedTurn[]): UnifiedTurn | undefined {
  const last = turns[turns.length - 1];
  return last && last.role === 'assistant' ? last : undefined;
}

function processItemToEvents(p: Record<string, unknown>, timestamp: string): ProcessEvent[] {
  const base = { timestamp, provider: 'codex' as const };
  switch (p.type) {
    case 'reasoning': {
      const text = reasoningPlaintext(p);
      if (!text) return [];
      return [
        {
          ...base,
          kind: 'thinking',
          summary: text === ENCRYPTED_THINKING ? ENCRYPTED_THINKING : summarize(text, '思考'),
          detail: text,
        },
      ];
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = typeof p.name === 'string' ? p.name : 'tool';
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const raw = p.input ?? p.arguments ?? '';
      const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const detail = name === 'exec' ? extractExecCommand(rawText) : rawText;
      return [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(`${name}: ${detail}`, name),
          detail,
          name,
          callId,
          input: parseToolInput(raw) ?? detail,
        },
      ];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const detail = flattenToolOutput(p.output);
      return [{ ...base, kind: 'tool_result', summary: '工具返回', detail, callId }];
    }
    case 'command_execution': {
      const command = typeof p.command === 'string' ? p.command : '';
      const output = typeof p.aggregated_output === 'string' ? p.aggregated_output : '';
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(command, 'exec'),
          detail: command,
          name: 'exec',
          callId,
          input: command,
        },
      ];
      if (output.trim()) {
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: output, callId });
      }
      return events;
    }
    // 私有 item 也尽量入账，避免 codex→他侧缺过程：本地 shell 调用 / 网页搜索 / 协作者消息
    case 'local_shell_call': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const shellCommand =
        typeof p.shell_command === 'string' && p.shell_command.trim() ? p.shell_command : '';
      const command = shellCommand || (typeof p.command === 'string' ? p.command : '');
      if (!command.trim()) return [];
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(command, 'exec'),
          detail: command,
          name: 'exec',
          callId,
          input: command,
        },
      ];
      const output = typeof p.output === 'string' && p.output.trim() ? p.output : '';
      if (output) {
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: output, callId });
      }
      return events;
    }
    case 'web_search_call': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const query = typeof p.query === 'string' ? p.query : '';
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(query || '网页搜索', 'web_search'),
          detail: query,
          name: 'web_search',
          callId,
          input: { query },
        },
      ];
      const output = typeof p.output === 'string' && p.output.trim() ? p.output : '';
      if (output) {
        events.push({ ...base, kind: 'tool_result', summary: '搜索结果', detail: output, callId });
      }
      return events;
    }
    case 'agent_message': {
      // 协作者/中间消息：不进 turn.text（最终回复由 response_item message 覆盖），只作为中间文本
      const text = flattenCodexContent(p.content);
      if (!text.trim()) return [];
      return [{ ...base, kind: 'text', summary: summarize(text, '过程'), detail: text }];
    }
    default:
      return [];
  }
}

/**
 * Watch 写出侧的 commentary 回显：思考写成 `思考: <detail>`，工具调用写成命令本身
 * （非 exec 为 `<name>: <detail>`，超过 200 字符会截断加 `…`）。这些信息已经由
 * reasoning / custom_tool_call 记录承载，解析时不能再变出一条过程文本——否则
 * Watch → Codex → Watch 每次往返都会多出两倍的中间说明。
 */
function isGeneratedCommentaryMirror(turn: UnifiedTurn, text: string): boolean {
  const event = turn.events?.at(-1);
  if (!event) return false;
  if (event.kind === 'thinking') return text.trim() === `思考: ${(event.detail ?? event.summary).trim()}`;
  if (event.kind !== 'tool_call') return false;
  const detail = event.detail ?? event.summary;
  const shown = event.name === 'exec' ? detail : `${event.name ?? 'tool'}: ${detail}`;
  const clipped = shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
  return text.trim() === clipped.trim();
}

function parseToolInput(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return unwrapLegacyWrappedInput(raw as Record<string, unknown>);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object')
        return unwrapLegacyWrappedInput(parsed as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 兼容历史损坏数据：{input:"{\"file_path\":...}"} → 解出内层对象 */
function unwrapLegacyWrappedInput(obj: Record<string, unknown>): unknown {
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'input' || typeof obj.input !== 'string') return obj;
  try {
    const inner: unknown = JSON.parse(obj.input);
    if (inner && typeof inner === 'object') return inner;
  } catch {
    return obj;
  }
  return obj;
}

function reasoningPlaintext(p: Record<string, unknown>): string | null {
  const summary = p.summary;
  if (Array.isArray(summary)) {
    const texts = summary
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .filter((t) => t.trim() !== '');
    if (texts.length) return texts.join('\n');
  }
  if (typeof p.encrypted_content === 'string' && p.encrypted_content) return ENCRYPTED_THINKING;
  return null;
}

/** content 扁平化（对齐 flatten_codex_content）：string 直取；数组取各项 text，跳过 encrypted_content */
function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item !== 'object' || item === null) return '';
      const b = item as Record<string, unknown>;
      if (b.type === 'encrypted_content') return '';
      return typeof b.text === 'string' ? b.text : '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/** Codex 把 AGENTS.md、环境上下文等内部信息包装成 user 消息，不属于对话（对齐 is_internal_codex_context） */
function isInternalCodexContext(text: string): boolean {
  const trimmed = text.trim();
  const firstLine = (trimmed.split('\n')[0] ?? '').trim().replace(/^#+/, '').trim();
  return (
    (firstLine.startsWith('AGENTS.md instructions') && trimmed.includes('<INSTRUCTIONS>')) ||
    (firstLine === '<environment_context>' && trimmed.includes('</environment_context>')) ||
    (firstLine === '<recommended_plugins>' && trimmed.includes('</recommended_plugins>')) ||
    (firstLine === '<user_instructions>' && trimmed.includes('</user_instructions>'))
  );
}

/** 带附件的用户消息把真实请求包在 `## My request for Codex:` 之后（对齐 strip_codex_request_wrapper） */
function stripCodexRequestWrapper(text: string): string {
  const MARKER = '## My request for Codex:';
  const idx = text.indexOf(MARKER);
  if (idx === -1) return text;
  return text
    .slice(idx + MARKER.length)
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('<image') && !t.startsWith('</image');
    })
    .join('\n')
    .trim();
}
