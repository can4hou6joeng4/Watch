import { readFile } from 'node:fs/promises';
import {
  CLAUDE_COMPACT_SUMMARY_PREFIX,
  CLAUDE_THINKING_PREFIX,
  ENCRYPTED_THINKING,
  ensureAssistant,
  flattenToolOutput,
  pushEvent,
  stripEmptyEvents,
  summarize,
  unwrapUserQuery,
  WATCH_CONTEXT_DISCLOSURE_PREFIX,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { describeClaudeContinuation, probeClaudeContinuation, readContinuedInRecord, type ClaudeContinuationCounts } from './continuation.js';
import { describeQueuedImages, readQueuedUserPrompt } from './queued.js';

/**
 * Claude JSONL → 统一时间线（Rich）：
 * - 跳过 isMeta/isSidechain、custom-title/ai-title、未知 type、坏行
 * - thinking / tool_use 挂到当前助手轮；tool_result 按调用 ID 回到对应助手轮，未配对结果保留并披露
 * - 仅含 tool_result 的 user 记录不当作用户消息
 * - 同一 user turn 内多条 assistant 合并：过程事件累积，文本留最后一条非空
 * - assistant 的 `[思考] …` 记录（build 的 thinking 降级形态）还原成 thinking 事件
 * - `isCompactSummary` 的 user 记录在正文前加来源前缀（它由 Claude Code 生成，不是用户原话）
 * - 未识别的 content block 不整块静默跳过：按类型计数写进正文，只含未知块的记录仍保留为一轮
 * - `continued-in`（会话被转入后台）按整份日志计数，续接文件存在性分档披露，不静默换 id
 * - 顶层 `attachment` 里的 `queued_command`（用户中途发来的消息）**当场**还原成用户轮：
 *   它没有对应的 user 记录，丢掉会让助手回复看起来在回答一个没人问过的问题；
 *   插在日志里的原位置才能让「助手续写」成为它的回复；工具结果另按调用 ID 配对
 * - 丢弃首条 user 之前的记录
 */
export async function parseClaudeSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let sawUser = false;
  const lastTextEvents = new Map<UnifiedTurn, ProcessEvent>();
  const continuation: ClaudeContinuationCounts = { count: 0, malformed: 0, sessionId: null };
  // 用户中途发来的消息（顶层 attachment / queued_command）：当场插成用户轮，之后到达的助手记录
  // 经 `ensureAssistant()` 另起一轮，就是这条插话的续写。推迟到循环结束后再插会排到续写**之后**
  // （错序），末轮还会变成没有回复的用户消息，`describeUnansweredTail()` 据此误报「没人答」。
  // 工具调用的归属独立于用户插话；null 表示未完成调用重复使用同一 ID，不能唯一配对。
  const pendingCalls = new Map<string, UnifiedTurn | null>();
  const unpaired: { event: ProcessEvent; reason: string }[] = [];
  const queued: { turn: UnifiedTurn; sourceUuid: string | null }[] = [];
  const userUuids = new Set<string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // 转入后台记录顺手计数（`continued-in` 不在 user / assistant 分支里，以前被当未知类型丢掉）
    const continued = readContinuedInRecord(record);
    if (continued) {
      if (continued.sessionId) {
        continuation.count += 1;
        continuation.sessionId = continued.sessionId;
      } else {
        continuation.malformed += 1;
      }
      continue;
    }
    // 用户中途发来的消息：还原成用户轮，否则助手接下来那段回复在交接里没有提问对象
    const queuedPrompt = readQueuedUserPrompt(record);
    if (queuedPrompt) {
      if (!sawUser) continue;
      const withImages = queuedPrompt.imageCount > 0
        ? `${queuedPrompt.text}${queuedPrompt.text ? '\n\n' : ''}${describeQueuedImages(queuedPrompt.imageCount)}`
        : queuedPrompt.text;
      const queuedTurn: UnifiedTurn = { role: 'user', text: withImages, timestamp: queuedPrompt.timestamp };
      turns.push(queuedTurn);
      queued.push({ turn: queuedTurn, sourceUuid: queuedPrompt.sourceUuid });
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;
    const type = r.type;
    if (type !== 'user' && type !== 'assistant') continue;
    if (r.isMeta === true || r.isSidechain === true) continue;

    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
    const content = (r.message as Record<string, unknown> | undefined)?.content;
    const extracted = extractRich(content, timestamp, type, r.watchGeneratedThinking === true);
    if (!extracted) continue;
    const { text, onlyToolResult, events } = extracted;

    if (type === 'user') {
      if (onlyToolResult) {
        if (!sawUser) continue; // 首条主线用户消息之前的记录仍跳过。
        for (const event of events) mountToolResult(event, pendingCalls, unpaired);
        continue;
      }
      sawUser = true;
      // 只有实际保留为主线用户轮的记录才能替代排队消息；被过滤的记录不能让用户发言消失。
      if (typeof r.uuid === 'string') userUuids.add(r.uuid);
      // 压缩摘要不是用户说的话，但它在记录里就是一条 role=user 的行。前缀必须跟着文本走：
      // prompt 文档会被复制走、转入目标会话的也是这段文本，元信息到不了读者那里。
      const userText = unwrapUserQuery(text);
      const userTurn: UnifiedTurn = {
        role: 'user',
        text: r.isCompactSummary === true ? `${CLAUDE_COMPACT_SUMMARY_PREFIX}\n${userText}` : userText,
        timestamp,
      };
      const userEvents = events.filter((event) => event.kind !== 'tool_result');
      if (userEvents.length) userTurn.events = userEvents;
      turns.push(userTurn);
      // 混有用户正文的记录也逐项配对工具结果，不能留在用户轮后被目标写入器忽略。
      for (const event of events) {
        if (event.kind === 'tool_result') mountToolResult(event, pendingCalls, unpaired);
      }
    } else {
      if (!sawUser) continue;
      const last = ensureAssistant(turns, timestamp, 'claude');
      for (const event of events) {
        pushEvent(last, event);
        if (event.kind === 'tool_call' && event.callId) {
          pendingCalls.set(event.callId, pendingCalls.has(event.callId) ? null : last);
        }
      }
      if (text.trim()) {
        const event: ProcessEvent = {
          kind: 'text',
          summary: text.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX) ? text : summarize(text, '过程'),
          detail: text,
          timestamp,
          provider: 'claude',
        };
        pushEvent(last, event);
        lastTextEvents.set(last, event);
        last.text = text;
      }
      if (timestamp) last.timestamp = timestamp;
      const usage = readUsage(r.message);
      if (usage) last.usage = usage;
    }
  }
  // 先去重并合并助手轮，再只移除合并后的最终正文事件；此前各段正文仍需保留为过程文本。
  dropDuplicatedQueuedTurns(turns, queued, userUuids, lastTextEvents);
  for (const [turn, finalEvent] of lastTextEvents) {
    if (!finalEvent.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) {
      turn.events = turn.events?.filter((event) => event !== finalEvent);
    }
  }
  const stripped = stripEmptyEvents(turns);
  const disclosureContext = [...stripped].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
  if (unpaired.length > 0 && disclosureContext) {
    // 空正文助手轮写出 text 事件后，回读会把事件当正文；只挂到真实用户轮或非空助手轮。
    for (const { event, reason } of unpaired) {
      const summary = `[Claude 未配对工具结果：${reason}]`;
      const id = event.callId ? `\n调用 ID：${JSON.stringify(event.callId)}` : '';
      pushEvent(disclosureContext, {
        kind: 'text', summary, detail: `${summary}${id}\n${event.detail ?? event.summary}`,
        timestamp: event.timestamp, provider: event.provider,
      });
    }
    const reasons = [
      `缺少调用 ID ${unpaired.filter((item) => !item.event.callId).length} 条`,
      `未找到未完成调用 ${unpaired.filter((item) => item.reason === '未找到对应的未完成调用').length} 条`,
      `调用 ID 重复 ${unpaired.filter((item) => item.reason === '调用 ID 对应多个未完成调用').length} 条`,
    ]
      .filter((item) => !item.endsWith(' 0 条'))
      .join('、');
    const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}Claude 日志中有 ${unpaired.length} 条工具结果无法确认调用归属（${reasons}），已作为带标记的过程文本保留，不计作已配对结果；可用 watch prompt <来源会话 id> --profile full 查看记录，完整原文请在来源文件或原生 Claude Code 中核对。]`;
    pushEvent(disclosureContext, { kind: 'text', summary: text, detail: text, timestamp: disclosureContext.timestamp, provider: 'claude' });
  }
  const detected = await probeClaudeContinuation(continuation, ref.filePath);
  if (detected && disclosureContext) {
    const text = describeClaudeContinuation(detected);
    pushEvent(disclosureContext, { kind: 'text', summary: text, detail: text, timestamp: disclosureContext.timestamp, provider: 'claude' });
  }
  return stripped;
}

/** 只按唯一的未完成调用配对；无法确认归属时暂存原文，结束后挂到可安全写回的轮次。 */
function mountToolResult(
  event: ProcessEvent,
  pendingCalls: Map<string, UnifiedTurn | null>,
  unpaired: { event: ProcessEvent; reason: string }[],
): void {
  let reason: string;
  if (event.callId) {
    const target = pendingCalls.get(event.callId);
    pendingCalls.delete(event.callId);
    if (target) {
      pushEvent(target, event);
      return;
    }
    reason = target === null ? '调用 ID 对应多个未完成调用' : '未找到对应的未完成调用';
  } else {
    reason = '缺少调用 ID';
  }
  unpaired.push({ event, reason });
}

/**
 * 中途消息的去重：只有日志中实际形成主线用户轮的 `uuid == source_uuid` 记录才能替代附件。
 * 分支、meta、无法解析或纯工具结果的 user 记录没有保留用户发言，不能据此移除插话。
 *
 * 插入是在日志原位当场做的，去重时移除冗余用户轮，再按主循环语义合并相邻助手轮。
 * 合并前不得移除各段的最终文本事件；更新最终正文的事件引用后，统一清理，才能保留中间说明。
 */
function dropDuplicatedQueuedTurns(
  turns: UnifiedTurn[],
  queued: { turn: UnifiedTurn; sourceUuid: string | null }[],
  userUuids: Set<string>,
  lastTextEvents: Map<UnifiedTurn, ProcessEvent>,
): void {
  for (const item of queued) {
    if (!item.sourceUuid || !userUuids.has(item.sourceUuid)) continue;
    const index = turns.indexOf(item.turn);
    if (index < 0) continue;
    turns.splice(index, 1);
    const prev = turns[index - 1];
    const next = turns[index];
    if (prev?.role === 'assistant' && next?.role === 'assistant') {
      for (const ev of next.events ?? []) pushEvent(prev, ev);
      if (next.text.trim()) prev.text = next.text;
      const finalEvent = lastTextEvents.get(next);
      if (finalEvent) lastTextEvents.set(prev, finalEvent);
      lastTextEvents.delete(next);
      if (next.timestamp) prev.timestamp = next.timestamp;
      if (next.usage) prev.usage = next.usage;
      if (next.incomplete) prev.incomplete = true;
      turns.splice(index, 1);
    }
  }
}

/**
 * 从 claude message 读真实 usage；缺字段或全 0 返回 undefined（避免把 0 占位当真实值）。
 *
 * 输入量口径必须与 `claudeSessionUsage()`（`usage.ts` 的 `pick()`）一致：`input_tokens` 只是
 * **未命中缓存**的增量，真实输入是「未命中 + 写入缓存 + 命中缓存」三块之和（ccusage 口径）。
 * 两边各算一套时，`open --to <provider>` 的 note 会写「来源 Claude Code 用量 in=370 out=30
 * （已在对账中携带）」，而写进目标会话的是 300/30——**搬运层丢掉了缓存那两块**，note 却让人
 * 以为带过去了。纯缓存命中的会话（明文两块都是 0、`cache_read` 非零）更是被 0/0 判据直接丢掉，
 * 转入别家后变成「这条会话没有用量」。与 codex 侧同源：信息层与搬运层读的不是同一份口径。
 */
function readUsage(message: unknown): TokenUsage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const hasBase = typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number';
  if (!hasBase && cacheCreate === 0 && cacheRead === 0) return undefined;
  const inputTokens = (typeof u.input_tokens === 'number' ? u.input_tokens : 0) + cacheCreate + cacheRead;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  // 按**合计**判 0：只有缓存命中的记录 input/output 都是 0，但缓存两块非零，不能被误丢。
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

function extractRich(
  content: unknown,
  timestamp: string,
  role: 'user' | 'assistant',
  watchGeneratedThinking = false,
): { text: string; onlyToolResult: boolean; events: ProcessEvent[] } | null {
  let blocks: unknown[];
  if (typeof content === 'string') {
    blocks = [{ type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    blocks = content;
  } else {
    return null;
  }
  const parts: string[] = [];
  const events: ProcessEvent[] = [];
  // 未识别的 content block（`document` / `server_tool_use` / 新版本新增的类型）以前走 switch 的
  // 隐式 default，**整个块连同内容一起消失**：文档里少一段、转入目标会话时也少一段，而
  // `watch prompt` / `open` 看起来完全正常。OpenCode 2.x 早就按「计数 + 写进内容」处理同类情况，
  // 这里对齐。
  const unknown = new Map<string, number>();
  let sawVisible = false;
  let onlyToolResult = true;
  const base = { timestamp, provider: 'claude' as const };

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text !== '') {
          // build 把 thinking 写成 `[思考] <detail>` 文本（伪造 thinking 块缺 signature 会让
          // `claude --resume` 报错）。这里只还原 **带 `watchGeneratedThinking` 标记** 的记录，
          // 否则「Claude → 其他 Agent」会静默丢掉思考内容；**不能只凭前缀**：原生助手正文
          // 完全可能以 `[思考] ` 开头，那种回复会被误判成 thinking 事件、正文随之改变。
          // 旧版 Watch 写出的无标记记录按普通文本保留（内容不丢，只是不再还原成 thinking）。
          if (role === 'assistant' && watchGeneratedThinking && b.text.startsWith(CLAUDE_THINKING_PREFIX)) {
            const thinking = b.text.slice(CLAUDE_THINKING_PREFIX.length).trim();
            if (thinking) {
              sawVisible = true;
              onlyToolResult = false;
              events.push({ ...base, kind: 'thinking', summary: summarize(thinking, '思考'), detail: thinking });
              break;
            }
          }
          parts.push(b.text);
          sawVisible = true;
          onlyToolResult = false;
        }
        break;
      case 'thinking': {
        sawVisible = true;
        onlyToolResult = false;
        const thinking = typeof b.thinking === 'string' ? b.thinking : '';
        const detail = thinking.trim() ? thinking : ENCRYPTED_THINKING;
        events.push({
          ...base,
          kind: 'thinking',
          summary: thinking.trim() ? summarize(thinking, '思考') : ENCRYPTED_THINKING,
          detail,
        });
        break;
      }
      case 'redacted_thinking':
        sawVisible = true;
        onlyToolResult = false;
        events.push({ ...base, kind: 'thinking', summary: ENCRYPTED_THINKING, detail: ENCRYPTED_THINKING });
        break;
      case 'tool_use': {
        sawVisible = true;
        onlyToolResult = false;
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const callId = typeof b.id === 'string' ? b.id : undefined;
        const input = b.input;
        const detail = typeof input === 'string' ? input : JSON.stringify(input ?? {});
        events.push({
          ...base,
          kind: 'tool_call',
          summary: summarize(detail, name),
          detail,
          name,
          callId,
          input,
        });
        break;
      }
      case 'tool_result': {
        sawVisible = true;
        const callId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
        const detail = flattenToolOutput(b.content);
        events.push({
          ...base,
          kind: 'tool_result',
          summary: '工具返回',
          detail,
          callId,
        });
        break;
      }
      case 'image': {
        // 图像的「存在性占位文本」只进事件（summary/detail），不进 turn.text：
        // 否则写回还原 image block 后反解会生成两份占位（文本倍增，round-trip 对不上）。
        // attachment 携带原始数据，同侧 build 还原 image block；跨侧不支持时降级为仅事件摘要。
        sawVisible = true;
        onlyToolResult = false;
        const src =
          typeof b.source === 'object' && b.source !== null ? (b.source as Record<string, unknown>) : undefined;
        const media = typeof src?.media_type === 'string' && src.media_type ? src.media_type : 'image';
        const placeholder = (() => {
          if (typeof src?.data === 'string') return `[图片：${media}，${src.data.length}B]`;
          if (typeof src?.url === 'string') return `[图片：${media}（外部链接）]`;
          return `[图片：${media}]`;
        })();
        const attachment =
          typeof src?.data === 'string'
            ? { kind: 'image' as const, mediaType: media, data: src.data }
            : typeof src?.url === 'string'
              ? { kind: 'image' as const, mediaType: media, url: src.url }
              : undefined;
        if (attachment) {
          events.push({ ...base, kind: 'text', summary: placeholder, detail: placeholder, attachment });
        }
        break;
      }
      default: {
        const unknownType = typeof b.type === 'string' && b.type ? b.type : '（空类型）';
        unknown.set(unknownType, (unknown.get(unknownType) ?? 0) + 1);
        break;
      }
    }
  }
  // 未识别块的占位写进正文而不是只进事件：正文会被 `watch prompt` 复制走、也会作为文本转入
  // 目标会话，只有跟着文本走才到得了读者眼前。写成占位也让它所在的 user / assistant 记录不被
  // 当成「空记录」丢掉（只含未知块的 user 消息正是最容易整条消失的一档）。
  if (unknown.size > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const counts = [...unknown.entries()].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join('、');
    parts.push(
      `[Claude 记录里有 ${total} 个未识别的消息块（${counts}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Claude Code 里查看]`,
    );
    sawVisible = true;
    onlyToolResult = false;
  }
  const text = parts
    .filter((p) => p.trim() !== '')
    .join('\n\n');
  if (!sawVisible) return null;
  return { text, onlyToolResult, events };
}


