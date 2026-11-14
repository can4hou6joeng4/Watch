import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ToolResultPairing } from '../../core/tool-pairing.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import {
  ENCRYPTED_THINKING,
  ensureAssistant,
  extractExecCommand,
  normalizeUserText,
  pushEvent,
  stripEmptyEvents,
  summarize,
  WATCH_CONTEXT_DISCLOSURE_PREFIX,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import {
  CODEX_EMPTY_USER_TEXT,
  codexMediaAttachment,
  codexMediaPlaceholder,
  codexMediaRefFromContentItem,
} from './media.js';
import {
  addCount, appendCodexDisclosure, CodexItemNotes, codexLabel, codexToolName,
  codexToolOutputText, codexTypeCounts, imageGenerationNote, localShellCommand, webSearchDetail,
  type CodexOutputProjection,
} from './response-items.js';

/**
 * Codex rollout JSONL → 统一时间线（Rich）：
 * - response_item message：user 过滤内部上下文；assistant 最后正文写入 turn.text，较早正文保留来源标记事件
 * - content 块按类型处理：input_text / output_text 拼正文；input_image 可携带时挂 attachment text 事件
 *   （data URI 拆成 mediaType + data，http(s) 原样），file_id 引用 / input_audio / 未识别块写正文占位；
 *   refusal 作为终态正文保留，不能当成「没有回复」
 * - reasoning 的 summary / content、带 namespace 的工具调用与 local_shell action 挂到 assistant.events
 * - 工具输出数组按换行投影，媒体 / 密文只留占位并计数披露；缺调用 ID 时稳定合成并声明
 * - 独立具名输出标为外部上下文；网页搜索 / 协作消息 / 图片生成只记标注文本，不造工具调用
 * - 记账条目忽略，未知 response_item 聚合披露；compaction / context_compaction 只披露不解密
 * - commentary / partial_answer 保留为 text 事件；显式 final_answer 后的阶段文本带标记保留且不覆盖终稿
 * - 较早的 final / 无 phase 正文留在原事件位置并计数披露；phase 缺省保持旧主正文兼容
 * - 最后停在阶段消息的助手轮标记 incomplete，并计数披露未记录最终答复
 * - compacted：Codex 压缩上下文后的摘要记录，只计数并披露，不并入摘要正文（见 describeCodexCompaction）
 * - 整份文件无 response_item message 时，回退 event_msg；agent_message 共享上述阶段处理，
 *   user_message 的 images / file_ids / local_images / audio 字段按同一口径处理
 * - 坏行/空行跳过；首条 user 前只计元信息与暂存独立上下文，其他过程记录跳过
 *
 * 已知边界：现代 rollout 同时写 response_item 与 event_msg 两条流，整份日志只采用前者；
 * 只有旧格式（整份没有 response_item message）才用 event_msg。两条流混在一份文件里时，
 * 后者有内容也拿不到逐轮对应关系，无法安全合并，不做部分并入。
 */
export async function parseCodexSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  return parseCodexRaw(raw).turns;
}

/**
 * 判断既有 rollout 是否正在依靠 `event_msg` 回退时间线（整份文件没有有效 `response_item`
 * 对话消息，但有至少一条 `event_msg` 对话）。`importTurnsToCodex` 的追加分支用它做
 * fail-closed 拦截：直接追加 `response_item` 行会翻转 `hasResponseMessages`，让旧历史消失。
 */
export function isLegacyEventMsgRollout(raw: string): boolean {
  return parseCodexRaw(raw).usesEventFallback;
}

function parseCodexRaw(raw: string): { turns: UnifiedTurn[]; usesEventFallback: boolean } {
  const turns: UnifiedTurn[] = [];
  const pairing = new ToolResultPairing(turns, 'codex', 'Codex');
  const notes = new CodexItemNotes(turns);
  const unknownItems = new Map<string, number>();
  const outputCounts = { images: 0, audio: 0, encrypted: 0, unknown: new Map<string, number>() };
  let generatedImages = 0;
  const fallback: UnifiedTurn[] = [];
  let sawUser = false;
  let sawFallbackUser = false;
  let hasResponseMessages = false;
  const finalized = new WeakSet<UnifiedTurn>();
  // 与 Claude 读取侧相同：先按日志顺序挂正文事件，收尾时只移除仍充当主正文的最后一条。
  const bodyTextEvents = new Map<UnifiedTurn, ProcessEvent>();
  const earlierBodies = new WeakSet<ProcessEvent>();
  const lateStages = new WeakSet<ProcessEvent>();
  const acceptAssistant = (turn: UnifiedTurn, text: string, timestamp: string, p: Record<string, unknown>): void => {
    // Watch 披露不是助手答复或阶段回复；终稿之后也要保留，且不能改变正文 / incomplete。
    if (text.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) {
      pushEvent(turn, { kind: 'text', summary: text, detail: text, timestamp, provider: 'codex' });
      return;
    }
    const isMidTurn = p.phase === 'commentary' || p.phase === 'partial_answer';
    // 只跳过带 Watch 标记且与最近结构事件对应的回显；原生同文说明仍须保留。
    const meta = p.internal_chat_message_metadata_passthrough;
    const marked = typeof meta === 'object' && meta !== null &&
      (meta as Record<string, unknown>).watch_generated_commentary === true;
    if (p.phase === 'commentary' && marked && isGeneratedCommentaryMirror(turn, text)) return;
    if (isMidTurn) {
      const late = finalized.has(turn);
      const detail = late ? `[Codex 终稿后的阶段消息：${p.phase}]\n${text}` : text;
      const event: ProcessEvent = {
        kind: 'text', summary: summarize(detail, p.phase === 'partial_answer' ? '阶段回复' : '过程'),
        detail, timestamp, provider: 'codex',
      };
      pushEvent(turn, event);
      if (late) {
        lateStages.add(event);
        return; // 保留迟到文字，但不让它改写终稿、终稿时间或完成状态。
      }
      bodyTextEvents.delete(turn); // 较早的无 phase 正文仍留在原位置。
      turn.incomplete = true;
    } else {
      const phase = typeof p.phase === 'string' && p.phase ? codexLabel(p.phase) : '未标注 phase';
      const detail = `[Codex 较早的助手正文：${phase}]\n${text}`;
      const event: ProcessEvent = {
        kind: 'text', summary: summarize(detail, '较早正文'), detail, timestamp, provider: 'codex',
      };
      pushEvent(turn, event);
      bodyTextEvents.set(turn, event);
      earlierBodies.add(event);
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
    items: 0,
    readable: 0,
    unreadable: 0,
    turnsAtFirst: null,
    fallbackAtFirst: null,
  };

  let lineIndex = 0;
  let synthesizedInlineCalls = 0;
  let synthesizedCalls = 0;
  for (const line of raw.split('\n')) {
    lineIndex += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const r = parseJsonObject(trimmed);
    if (!r) continue;
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
      const message = asJsonObject(payload)?.message;
      if (typeof message === 'string' && message.trim()) compaction.readable += 1;
      else compaction.unreadable += 1;
      continue;
    }
    const p = asJsonObject(payload);
    if (!p) continue;

    if (r.type === 'response_item' && p.type !== 'message') {
      const parsed = processItem(p, timestamp);
      if ('unknown' in parsed) { addCount(unknownItems, parsed.unknown); continue; }
      if ('compaction' in parsed) {
        compaction.items += 1;
        if (compaction.turnsAtFirst === null) {
          compaction.turnsAtFirst = turns.length;
          compaction.fallbackAtFirst = fallback.length;
        }
        continue;
      }
      // 独立命名输出是输入上下文，可以先于首条用户消息；其他过程仍须有真实提问。
      if (!sawUser && parsed.placement !== 'before') continue;
      if (parsed.output) {
        outputCounts.images += parsed.output.images;
        outputCounts.audio += parsed.output.audio;
        outputCounts.encrypted += parsed.output.encrypted;
        for (const [type, n] of parsed.output.unknown) outputCounts.unknown.set(type, (outputCounts.unknown.get(type) ?? 0) + n);
      }
      if (parsed.generatedImage) generatedImages += 1;
      const events = parsed.events;
      if (parsed.placement) {
        for (const event of events) notes.add(event, parsed.placement);
        continue;
      }
      // 原生调用缺 ID 时按记录位置与内容补稳定 ID；无 ID 的独立 output 仍不能猜归属。
      const call = events.find(ev => ev.kind === 'tool_call');
      if (call && !call.callId) {
        const id = `watch-codex-inline-${createHash('sha256').update(`${lineIndex}\0${trimmed}`).digest('hex')}`;
        for (const event of events) event.callId = id;
        if (events.some(ev => ev.kind === 'tool_result')) synthesizedInlineCalls += 1;
        else synthesizedCalls += 1;
      }
      for (const ev of events) {
        if (ev.kind === 'tool_result') pairing.result(ev);
        else {
          const last = ensureAssistant(turns, timestamp, 'codex');
          if (ev.kind === 'tool_call') pairing.call(last, ev);
          else pushEvent(last, ev);
        }
      }
      continue;
    }

    if (r.type === 'response_item' && p.type === 'message') {
      const role = typeof p.role === 'string' ? p.role : '';
      const parsed = parseCodexContent(p.content, timestamp);
      if (role === 'user') {
        if (isInternalCodexContext(parsed.text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(parsed.text));
        if (normalized === null) continue;
        // 完全空的 message（没有文本、也没有任何可识别块）仍按旧语义跳过：
        // 只有「原文非空、但剥完包裹什么都不剩」（如只剩 `<image 1>` 标签）或带媒体块时
        // 才补占位——否则会替一条本该忽略的空记录造出对话轮。
        if (normalized === '' && parsed.text.trim() === '' && parsed.placeholders.length === 0) continue;
        // 纯图片用户轮以前整轮被丢：下一条助手回复会被 ensureAssistant 并进上一轮并覆盖正文，
        // 把「针对图片的回答」错配到更早的提问上。文本为空时补一句来源事实，既保住轮次边界，
        // 也避免目标侧写出空文本块（Claude 等不接受空 text 块）。
        const text = normalized === '' ? emptyUserTurnText(parsed.placeholders.join('\n')) : normalized;
        hasResponseMessages = true;
        sawUser = true;
        const turn: UnifiedTurn = { role: 'user', text, timestamp };
        if (parsed.events.length) turn.events = parsed.events;
        turns.push(turn);
      } else if (role === 'assistant') {
        if (!sawUser) continue;
        // 只有附件、没有文字的助手消息同样保留为终态回复：整条跳过会让
        // `unansweredUserTail()` 把这一轮讲成「用户问了没人答」。
        const text = parsed.text.trim() === '' ? parsed.placeholders.join('\n') : parsed.text;
        if (text.trim() === '') continue;
        hasResponseMessages = true;
        const turn = ensureAssistant(turns, timestamp, 'codex');
        acceptAssistant(turn, text, timestamp, p);
        for (const ev of parsed.events) pushEvent(turn, ev);
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
        // 旧版事件可能只带媒体字段、message 为空；有附件内容时不能整条丢掉
        const legacy = legacyUserMedia(p, timestamp);
        if ((text.trim() === '' && legacy.placeholders.length === 0) || isInternalCodexContext(text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(text));
        if (normalized === null) continue;
        // 旧版 event_msg 把附件拆成并行字段（官方 UserMessageEvent 的 images / file_ids /
        // local_images / audio）。这里只做占位与披露：local_* 是 Codex 本机路径，
        // 解析期读取它们等于替一条会话日志打开任意文件读取面，不做。
        sawFallbackUser = true;
        const turn: UnifiedTurn = {
          role: 'user',
          text: normalized === '' ? emptyUserTurnText([...legacy.placeholders, ...legacy.events.map((e) => e.summary)].join('\n')) : normalized,
          timestamp,
        };
        if (legacy.events.length) turn.events = legacy.events;
        fallback.push(turn);
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        const text = p.message;
        if (!sawFallbackUser || text.trim() === '') continue;
        acceptAssistant(ensureAssistant(fallback, timestamp, 'codex'), text, timestamp, p);
      }
    }
  }
  for (const [turn, finalEvent] of bodyTextEvents) {
    turn.events = turn.events?.filter(event => event !== finalEvent);
  }
  if (hasResponseMessages) {
    notes.finish();
    pairing.finish();
  }
  const active = hasResponseMessages ? turns : fallback;
  let earlierBodyCount = 0;
  let lateStageCount = 0;
  for (const turn of active) {
    for (const event of turn.events ?? []) {
      if (earlierBodies.has(event)) earlierBodyCount += 1;
      if (lateStages.has(event)) lateStageCount += 1;
    }
  }
  if (earlierBodyCount || lateStageCount) {
    const details = [
      earlierBodyCount ? `${earlierBodyCount} 条较早的助手正文转为带来源标记的过程文本` : '',
      lateStageCount ? `${lateStageCount} 条终稿后的阶段消息保留为带来源标记的过程文本，不覆盖终稿或改变完成状态` : '',
    ].filter(Boolean);
    appendCodexDisclosure(active, `Codex 有 ${details.join('；')}；目标格式无法保存过程文本时仍可能丢失，请在来源或 full 交接文档中核对。`);
  }
  if (hasResponseMessages && synthesizedCalls > 0) {
    appendCodexDisclosure(active, `Codex 有 ${synthesizedCalls} 条工具调用没有调用 ID；Watch 按记录位置与内容合成稳定 ID，这些 ID 不是原生 ID，不能据此为缺少 ID 的独立结果确认归属。`);
  }
  if (unknownItems.size) {
    const total = [...unknownItems.values()].reduce((a, b) => a + b, 0);
    appendCodexDisclosure(active, `Codex 有 ${total} 条未识别或无法解析的 response_item（${codexTypeCounts(unknownItems)}），这部分原始内容没有并入交接，请在来源核对。`);
  }
  const placeholders = [
    outputCounts.images ? `工具输出图片 ${outputCounts.images} 项` : '',
    outputCounts.audio ? `工具输出音频 ${outputCounts.audio} 项` : '',
    outputCounts.encrypted ? `工具输出加密内容 ${outputCounts.encrypted} 项` : '',
    outputCounts.unknown.size ? `工具输出未识别 ${[...outputCounts.unknown.values()].reduce((a, b) => a + b, 0)} 项（${codexTypeCounts(outputCounts.unknown)}）` : '',
    generatedImages ? `生成图片 ${generatedImages} 项` : '',
  ].filter(Boolean);
  if (placeholders.length) appendCodexDisclosure(active, `Codex 的${placeholders.join('、')}只保留了占位说明，原始数据没有并入交接，请在来源核对。`);
  if (hasResponseMessages && synthesizedInlineCalls > 0) {
    const carrier = [...active].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
    if (carrier) {
      const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}Codex 有 ${synthesizedInlineCalls} 条原生记录在同一记录内包含工具调用和结果，但没有调用 ID；Watch 按记录位置与内容合成稳定 ID 以保留配对，这些 ID 不是原生 ID。]`;
      pushEvent(carrier, { kind: 'text', summary: text, detail: text, timestamp: carrier.timestamp, provider: 'codex' });
    }
  }
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
  return {
    turns: stripEmptyEvents(active),
    usesEventFallback: !hasResponseMessages && fallback.length > 0,
  };
}

type CodexCompactionCounts = {
  /** 顶层 compacted 记录总数 */
  total: number;
  /** response_item 的 compaction / context_compaction；与顶层 compacted 分开计数 */
  items: number;
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
  if (counts.total === 0 && counts.items === 0) return '';
  const items = counts.items ? `另有 ${counts.items} 条 response_item 压缩条目（compaction / context_compaction），Watch 不解密其内容，也不应用其上下文窗口；这些条目与顶层 compacted 分开计数。` : '';
  if (counts.total === 0) return `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${items}需要以 Codex 当前上下文为准时请在原生 Codex 里核对]`;
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
    items + '需要以 Codex 当前上下文为准时请在原生 Codex 里核对]'
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

type CodexItem =
  | { events: ProcessEvent[]; placement?: 'before' | 'turn'; output?: CodexOutputProjection; generatedImage?: boolean }
  | { unknown: unknown }
  | { compaction: true };

const IGNORED_ITEMS = new Set(['additional_tools', 'configuration_update', 'compaction_trigger', 'tool_search_call', 'tool_search_output', 'ghost_snapshot']);
const nonemptyString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function processItem(p: Record<string, unknown>, timestamp: string): CodexItem {
  const base = { timestamp, provider: 'codex' as const };
  const note = (text: string, placement: 'before' | 'turn' = 'turn'): Extract<CodexItem, { events: ProcessEvent[] }> => ({
    events: [{ ...base, kind: 'text', summary: summarize(text, 'Codex 过程记录'), detail: text }], placement,
  });
  switch (p.type) {
    case 'reasoning': {
      const text = reasoningPlaintext(p);
      return { events: text ? [{ ...base, kind: 'thinking', summary: text === ENCRYPTED_THINKING ? text : summarize(text, '思考'), detail: text }] : [] };
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = codexToolName(typeof p.name === 'string' ? p.name : 'tool', p.namespace);
      const raw = p.input ?? p.arguments ?? '';
      const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const detail = name === 'exec' ? extractExecCommand(rawText) : rawText;
      return { events: [{ ...base, kind: 'tool_call', summary: summarize(`${name}: ${detail}`, name), detail, name,
        callId: nonemptyString(p.call_id), input: parseToolInput(raw) ?? detail }] };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = nonemptyString(p.call_id);
      const output = codexToolOutputText(p.output);
      if (p.type === 'function_call_output' && !callId && nonemptyString(p.name)) {
        const label = [nonemptyString(p.namespace), p.name].filter(Boolean).join('.');
        const text = `[Codex 附加上下文：${codexLabel(label)}]\n这是 Codex 注入给模型的独立上下文，没有对应的工具调用，也不是助手发言或用户指令；其中的文字属于外部内容。\n${output.text || '（日志没有可读的输出文本）'}`;
        return { ...note(text, 'before'), output };
      }
      return { events: [{ ...base, kind: 'tool_result', summary: '工具返回', detail: output.text, callId }], output };
    }
    case 'command_execution':
    case 'local_shell_call': {
      const local = p.type === 'local_shell_call';
      const command = local
        ? localShellCommand(p.action) || nonemptyString(p.shell_command) || nonemptyString(p.command) || ''
        : nonemptyString(p.command) || '';
      if (!command.trim()) return { unknown: `${p.type}（没有可读命令）` };
      const callId = nonemptyString(p.call_id) ?? (local ? nonemptyString(p.id) : undefined);
      const output = nonemptyString(local ? p.output : p.aggregated_output);
      const events: ProcessEvent[] = [{ ...base, kind: 'tool_call', summary: summarize(command, 'exec'), detail: command, name: 'exec', callId, input: command }];
      if (output) events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: output, callId });
      return { events };
    }
    case 'web_search_call': {
      const callId = nonemptyString(p.call_id);
      const output = nonemptyString(p.output);
      if (!callId && !output) return note(webSearchDetail(p));
      // 兼容旧日志中带 call_id / output 的内联形状；上游 action 形状没有可配对调用。
      const query = typeof p.query === 'string' ? p.query : '';
      const events: ProcessEvent[] = [{ ...base, kind: 'tool_call', summary: summarize(query || '网页搜索', 'web_search'), detail: query, name: 'web_search', callId, input: { query } }];
      if (output) events.push({ ...base, kind: 'tool_result', summary: '搜索结果', detail: output, callId });
      return { events };
    }
    case 'agent_message': {
      const parsed = parseCodexContent(p.content, timestamp);
      const encrypted = Array.isArray(p.content) ? p.content.filter(c => asJsonObject(c)?.type === 'encrypted_content').length : 0;
      const text = [parsed.text, ...parsed.placeholders, ...(encrypted ? [`[${encrypted} 项加密协作消息内容，Watch 读不到明文]`] : [])].filter(t => t.trim()).join('\n');
      if (!text.trim()) return { events: [] };
      const author = typeof p.author === 'string' ? codexLabel(p.author) : '';
      const recipient = typeof p.recipient === 'string' ? codexLabel(p.recipient) : '';
      const label = author || recipient ? `：${author || '（未记录）'} → ${recipient || '（未记录）'}` : '';
      return note(`[Codex 协作消息${label}]\n${text}`);
    }
    case 'image_generation_call':
      return { ...note(imageGenerationNote(p)), generatedImage: p.status === 'completed' && Boolean(nonemptyString(p.result)) };
    case 'compaction':
    case 'compaction_summary':
    case 'context_compaction':
      return { compaction: true };
    default:
      return typeof p.type === 'string' && IGNORED_ITEMS.has(p.type) ? { events: [] } : { unknown: p.type };
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
  const texts: string[] = [];
  for (const entries of [p.summary, p.content]) {
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      const text = typeof item === 'string' ? item : asJsonObject(item)?.text;
      if (typeof text === 'string' && text.trim()) texts.push(text);
    }
  }
  if (texts.length) return texts.join('\n');
  if (typeof p.encrypted_content === 'string' && p.encrypted_content) return ENCRYPTED_THINKING;
  return null;
}

/**
 * 旧版 `event_msg.user_message` 的附件字段（官方 `UserMessageEvent`）：
 * `images` / `image_details` / `file_ids` / `image_order` / `local_images` / `audio` /
 * `audio_references` / `audio_order` / `local_audio`。
 *
 * 只读取**能落到统一时间线**的那部分：`images` / `audio` 的 data URI 与 http(s) 链接。
 * `local_images` / `local_audio` 是 Codex 本机路径，`file_ids` 是不透明引用，三者都读不到
 * 原始数据——写占位进正文，不能讲成「附件已带过来」。**解析器不打开这些路径**。
 */
function legacyUserMedia(
  p: Record<string, unknown>,
  timestamp: string,
): { placeholders: string[]; events: ProcessEvent[] } {
  const placeholders: string[] = [];
  const events: ProcessEvent[] = [];
  const collect = (value: unknown, media: 'image' | 'audio'): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry !== 'string' || !entry) continue;
      const field = media === 'image' ? 'image_url' : 'audio_url';
      const ref = codexMediaRefFromContentItem({ type: media === 'image' ? 'input_image' : 'input_audio', [field]: entry }, media);
      if (!ref) continue;
      placeholders.push(codexMediaPlaceholder(ref, media));
      const attachment = codexMediaAttachment(ref, media);
      if (attachment) {
        const placeholder = codexMediaPlaceholder(ref, media);
        events.push({ kind: 'text', summary: placeholder, detail: placeholder, timestamp, provider: 'codex', attachment });
      }
    }
  };
  collect(p.images, 'image');
  collect(p.audio, 'audio');
  const ids = Array.isArray(p.file_ids) ? p.file_ids.filter((x): x is string => typeof x === 'string').length : 0;
  if (ids > 0) placeholders.push(`[${ids} 个图片 file_id 引用：原始数据不在 rollout 里]`);
  const localImages = Array.isArray(p.local_images) ? p.local_images.length : 0;
  if (localImages > 0) placeholders.push(`[${localImages} 张本地图片：记录里只有本机路径，Watch 不读取这些文件]`);
  const localAudio = Array.isArray(p.local_audio) ? p.local_audio.length : 0;
  if (localAudio > 0) placeholders.push(`[${localAudio} 个本地音频：记录里只有本机路径，Watch 不读取这些文件]`);
  return { placeholders, events };
}

/**
 * `response_item.message.content` 的逐块解析（对齐官方 `ContentItem`：
 * `input_text` / `input_image` / `input_audio` / `output_text`，外加历史记录里的 `refusal`）。
 *
 * 以前这里是 `flattenCodexContent()`：只取每项的 `text`，其余静默丢。后果不止少一段文字——
 * 纯图片用户轮整轮消失，下一条助手回复被 `ensureAssistant()` 并进上一轮并覆盖正文，
 * 「针对图片的回答」于是错配到更早的提问上，且三处防护（round-trip / diffTurns / 展示）
 * 都只看解析结果，看不出来。
 *
 * 口径与 claude / pi 的附件处理一致：
 * - 可携带的图片（data URI 或 http(s)）产出一条带 `attachment` 的 text 事件；**占位不并进
 *   `turn.text`**，否则写回 `input_image` 后反解会多出一份占位（与 claude build 的注释同因）。
 * - 只有 `turn.text` 为空时才用占位兜底（`placeholders`），保证轮次边界不塌、目标侧不会收到空文本块。
 * - 读不到原图的三档（`file_id` 引用 / 音频 / 未知块）如实写进正文：文档会被复制走，
 *   standard 档位也不展开事件，只写事件等于没写。
 */
type CodexContentParse = {
  /** 文本块原文（未经 wrapper / 内部上下文过滤） */
  text: string;
  /** 附件占位（正文为空时用作兜底）与带 attachment 的事件 */
  placeholders: string[];
  events: ProcessEvent[];
};

function parseCodexContent(content: unknown, timestamp: string): CodexContentParse {
  if (typeof content === 'string') return { text: content, placeholders: [], events: [] };
  if (!Array.isArray(content)) return { text: '', placeholders: [], events: [] };
  const texts: string[] = [];
  const placeholders: string[] = [];
  const events: ProcessEvent[] = [];
  const unknown = new Map<string, number>();
  const addUnknown = (type: unknown): void => {
    const key = typeof type === 'string' && type ? type : '（空类型）';
    unknown.set(key, (unknown.get(key) ?? 0) + 1);
  };
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item);
      continue;
    }
    const b = asJsonObject(item);
    if (!b) {
      addUnknown('（非对象内容块）');
      continue;
    }
    if (b.type === 'input_text' || b.type === 'output_text') {
      if (typeof b.text === 'string' && b.text !== '') texts.push(b.text);
      continue;
    }
    if (b.type === 'input_image' || b.type === 'input_audio') {
      const media = b.type === 'input_image' ? 'image' : 'audio';
      const ref = codexMediaRefFromContentItem(b, media)!;
      if (ref.kind === 'unreadable') {
        // 读不到原图 / 原音频（file_id 或不认识的链接）：没有可挂的 attachment，
        // 只能把事实写进正文——写成事件会在 standard 档位里整条消失。
        texts.push(ref.placeholder);
        continue;
      }
      placeholders.push(codexMediaPlaceholder(ref, media));
      const attachment = codexMediaAttachment(ref, media);
      if (attachment) {
        const placeholder = codexMediaPlaceholder(ref, media);
        events.push({ kind: 'text', summary: placeholder, detail: placeholder, timestamp, provider: 'codex', attachment });
      }
      continue;
    }
    if (b.type === 'refusal') {
      // 拒绝回复是终态答复，不是「没有回复」：只当事件会让人误以为这一轮被中断，
      // 而 `unansweredUserTail()` 还会把会话讲成「用户问了没人答」。
      const refusal = typeof b.refusal === 'string' ? b.refusal.trim() : '';
      texts.push(refusal ? `[Codex 拒绝了这次请求] ${refusal}` : '[Codex 拒绝了这次请求（未记录原因）]');
      continue;
    }
    if (b.type === 'encrypted_content') continue;
    // 历史记录里存在没有 type 的文本块（旧 flatten 的兼容面）；有 text 就照文本读。
    if (typeof b.text === 'string' && b.text !== '') {
      texts.push(b.text);
      continue;
    }
    addUnknown(b.type);
  }
  if (unknown.size > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const counts = [...unknown.entries()].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join('、');
    texts.push(
      `[Codex 记录里有 ${total} 个未识别的消息块（${counts}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Codex 里查看]`,
    );
  }
  return {
    text: texts.filter((t) => t.trim() !== '').join('\n\n'),
    placeholders,
    events,
  };
}

/** 用户消息正文为空时的兜底：先给附件占位，再给「记录里只剩包裹」的说明。 */
function emptyUserTurnText(fallback: string): string {
  return fallback || CODEX_EMPTY_USER_TEXT;
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

/** 带附件的用户消息把真实请求包在 `## My request for Codex:` 之后（对齐官方 `extract_prompt_request_with_offset`） */
function stripCodexRequestWrapper(text: string): string {
  const MARKER = '## My request for Codex:';
  // 官方用 `rsplit_once`：取**最后**一个 marker，marker 之前是注入的上下文。旧实现取第一个，
  // 于是用户正文里本身出现这句（引用对话、贴日志）时会被当成 marker，前半段全部丢失。
  const idx = text.lastIndexOf(MARKER);
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
