import { readFile } from 'node:fs/promises';
import {
  ensureAssistant,
  normalizeUserText,
  PI_BRANCH_SUMMARY_PREFIX,
  PI_COMPACTION_SUMMARY_PREFIX,
  pushEvent,
  stripEmptyEvents,
  summarize,
  WATCH_CONTEXT_DISCLOSURE_PREFIX,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { isoFromEpochMs } from '../../core/time.js';

export async function parsePiSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let sawUser = false;
  // 整份日志里 context_edit / custom_message 的计数（见循环里的注释）
  const contextEntries: PiContextEntryCounts = {
    removed: 0,
    replaced: 0,
    unknownEdits: 0,
    customMessages: 0,
    customImages: 0,
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

    // pi 把压缩 / 分支摘要写成独立条目（`sessionEntryToContextMessages()` 会把它们注入上下文），
    // 以前只认 `type: 'message'`，整段摘要连同「上下文被压缩过」这件事一起消失。还原成一轮
    // 带来源前缀的用户消息：前缀既防目标助手把机器总结当成用户指令，也是 `--since-compact`
    // 认边界的痕迹。摘要为空时仍留下声明，不把这次压缩吞掉。
    if (r.type === 'compaction' || r.type === 'branch_summary') {
      const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
      const prefix = r.type === 'compaction' ? PI_COMPACTION_SUMMARY_PREFIX : PI_BRANCH_SUMMARY_PREFIX;
      const timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
      turns.push({
        role: 'user',
        text: `${prefix}\n${summary || '（摘要内容为空）'}`,
        timestamp,
      });
      sawUser = true;
      continue;
    }

    // `context_edit` / `custom_message` 会改变 Pi 当前发给模型的上下文，但 Watch 没有做
    // 分支选择与压缩窗口投影，不能安全地应用它们（见 rich.ts 的 `WATCH_CONTEXT_DISCLOSURE_PREFIX`）。
    // 这里只按整个日志计数，循环结束后把一条披露事件挂到最后一条已解析轮次上。
    if (r.type === 'context_edit') {
      const replacement = r.replacement;
      if (replacement === null) contextEntries.removed += 1;
      else if (hasReplacementContent(replacement)) contextEntries.replaced += 1;
      else contextEntries.unknownEdits += 1;
      continue;
    }
    if (r.type === 'custom_message') {
      contextEntries.customMessages += 1;
      contextEntries.customImages += countImageBlocks(r.content);
      continue;
    }

    if (r.type !== 'message') continue;
    const msg = r.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role;
    const timestamp =
      typeof r.timestamp === 'string'
        ? r.timestamp
        : typeof msg.timestamp === 'number'
          ? // 越界数值（1e30 / 单位写错）只让这一条消息失去时间戳，不能让整条会话解析抛错
            isoFromEpochMs(msg.timestamp)
          : '';
    // pi 的 UserMessage.content 类型是 `string | (TextContent | ImageContent)[]`（pi-ai 的 types.ts），
    // 纯字符串以前被 `Array.isArray ? … : []` 折成空数组，整条用户消息连同内容消失。
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    const extracted = extractBlocks(content, timestamp);

    if (role === 'user') {
      const text = normalizeUserText(extracted.text);
      if (!text) continue;
      sawUser = true;
      // 图片块的 attachment 挂在这里，转入支持附件的目标（claude / opencode）时才带得过去。
      turns.push({ role: 'user', text, timestamp, ...(extracted.events.length ? { events: extracted.events } : {}) });
      continue;
    }
    if (role === 'toolResult') {
      if (!sawUser || turns.at(-1)?.role !== 'assistant') continue;
      const last = turns.at(-1)!;
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
      const name = typeof msg.toolName === 'string' ? msg.toolName : undefined;
      pushEvent(last, {
        kind: 'tool_result',
        summary: extracted.text.slice(0, 80) || 'tool result',
        detail: extracted.text || undefined,
        timestamp,
        provider: 'pi',
        name,
        callId,
      });
      continue;
    }
    if (role !== 'assistant') continue;
    if (!sawUser) continue;
    const usage = readPiUsage(msg);

    // Pi build 会把有 tool 的 assistant final text 拆成一条独立 message 跟在 toolResult 后面，
    // 解析时合并回同一个 UnifiedTurn，避免一个回合变成两个 assistant 回合。
    const prev = turns.at(-1);
    if (
      prev?.role === 'assistant' &&
      extracted.events.length === 0 &&
      extracted.text.trim() &&
      (prev.events?.length ?? 0) > 0 &&
      !prev.text.trim()
    ) {
      prev.text = extracted.text;
      if (timestamp) prev.timestamp = timestamp;
      // 写出侧在带工具的轮次里把**同一份** usage 写在这两条 assistant 消息上
      // （pi TUI footer 要求每条 assistant 都带 usage），所以这里覆盖成同一个值，
      // 不会翻倍；原生多轮 API 调用时这条规则等价于「取最后一次调用的用量」，
      // 与 claude 的 parse 一致，不猜中间各次的分摊。
      if (usage) prev.usage = usage;
      continue;
    }

    const last = ensureAssistant(turns, timestamp, 'pi');
    for (const ev of extracted.events) pushEvent(last, ev);
    if (extracted.text.trim()) {
      // 同一助手轮里「说明文字 + 工具调用」之后又来了新的说明文字时，正文只会保留最后一段；
      // 被覆盖的中间说明以前直接从时间线消失（`watch prompt` 少一段、转入 claude / codex
      // 时也少一段），而 round-trip 只比最终正文，拦不住。与 claude parse 同口径：把被覆盖的
      // 正文留成 text 事件，最终正文仍取最后一段。纯流式重复（两段完全相同）不重复记录。
      if (last.text.trim() && last.text !== extracted.text) {
        pushEvent(last, {
          kind: 'text',
          summary: summarize(last.text, '过程'),
          detail: last.text,
          timestamp: last.timestamp,
          provider: 'pi',
        });
      }
      last.text = extracted.text;
    }
    if (timestamp) last.timestamp = timestamp;
    if (usage) last.usage = usage;
  }
  const disclosure = describePiContextEntries(contextEntries);
  if (disclosure && turns.length > 0) {
    const last = turns.at(-1)!;
    pushEvent(last, {
      kind: 'text',
      summary: disclosure,
      detail: disclosure,
      timestamp: last.timestamp,
      provider: 'pi',
    });
  }
  return stripEmptyEvents(turns);
}

type PiContextEntryCounts = {
  /** replacement === null：该条不再贡献上下文 */
  removed: number;
  /** 有字符串 / 数组 content 的替换 */
  replaced: number;
  /** replacement 存在但形状认不出 */
  unknownEdits: number;
  customMessages: number;
  customImages: number;
};

/** 替换载荷是否带可识别的 content（只判形状，不读内容）。 */
function hasReplacementContent(replacement: unknown): boolean {
  if (typeof replacement !== 'object' || replacement === null) return false;
  const content = (replacement as Record<string, unknown>).content;
  return typeof content === 'string' || Array.isArray(content);
}

function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let images = 0;
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'image') images += 1;
  }
  return images;
}

/**
 * 披露文案：只说「日志里有多少条」，不说「当前分支生效多少条」——没有做叶路径投影，
 * 前者是能证明的事实，后者只是猜测。编辑与扩展消息的正文、图片 base64、details 都不复制。
 */
function describePiContextEntries(counts: PiContextEntryCounts): string {
  const parts: string[] = [];
  const edits = counts.removed + counts.replaced + counts.unknownEdits;
  if (edits > 0) {
    const detail: string[] = [];
    if (counts.removed) detail.push(`删除 ${counts.removed} 条`);
    if (counts.replaced) detail.push(`替换 ${counts.replaced} 条`);
    if (counts.unknownEdits) detail.push(`形状无法识别 ${counts.unknownEdits} 条`);
    parts.push(`${edits} 条上下文编辑（${detail.join('、')}）`);
  }
  if (counts.customMessages > 0) {
    parts.push(`${counts.customMessages} 条扩展消息${counts.customImages ? `（含图片 ${counts.customImages} 张）` : ''}`);
  }
  if (parts.length === 0) return '';
  return (
    `${WATCH_CONTEXT_DISCLOSURE_PREFIX}Pi 会话日志里有 ${parts.join(' 和 ')}，` +
    'Watch 没有应用这些编辑、也没有并入扩展内容：本交接保留的是原始日志，' +
    '可能比 Pi 当前发给模型的上下文多出已被删除或改写的旧内容，同时缺少扩展提供的内容；' +
    '需要以 Pi 当前上下文为准时请在原生 Pi 里核对]'
  );
}

/**
 * 从 pi 的 assistant `message.usage` 读真实用量；缺字段或合计为 0 返回 undefined。
 *
 * 字段口径取自 pi 自己的代码（`@earendil-works/pi-coding-agent` 的 `usage-totals.js` /
 * `pi-ai` 的 `calculateCost()`）：`input` 只是**未命中缓存**的增量，`cacheRead` / `cacheWrite`
 * 另计，真实输入是三者之和（与 `claudeSessionUsage()`、ccusage 同一口径）；
 * `cacheWrite1h` 是 `cacheWrite` 的**子集**（1h TTL 那一部分，`calculateCost` 用它只做计价拆分），
 * 再加一次就会凭空多算；`reasoning` 同理已含在 `output` 里。
 *
 * 以前这里从不读 usage，于是 **pi → 任何别家的转入一律写 0/0**，而 `importTurnsToPi()` 一直
 * 把 `turn.usage` 写进 `message.usage`——自己转出的会话反倒能被别家读回用量，反向却不行。
 * 与 claude 缓存两块、codex `last_token_usage`、grok `updates.jsonl` 完全同源。
 *
 * 0/0 是写出侧没有源侧用量时的占位（`pushMessage()` 的兜底），不能当成「确实用了 0 token」。
 */
function readPiUsage(msg: Record<string, unknown>): TokenUsage | undefined {
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  const outputTokens = num(u.output);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

/**
 * 消息内容块 → 文本 + 过程事件。
 *
 * pi-ai 的消息块联合只有 text / thinking / toolCall / image 四种，但「只认识这几种」不等于
 * 「其余可以静默丢」。以前这里没有 image 分支、也没有兜底：图片块连同原始数据消失（只发图片的
 * 用户消息整条不见），未知类型的块同样无声无息——`watch prompt` 与转入的目标会话里都少一段，
 * 而 round-trip 只看 thinking / tool_call / tool_result，拦不住。
 *
 * 图片：占位文本进 `texts`（pi 的写回只搬文本，占位是这条图片在 pi 侧唯一留得下的痕迹），
 * 同时挂一条带 `attachment` 的 text 事件，转入 claude / opencode 时由它们的 build 还原成图片块；
 * pi 自己不还原附件，由 `describeAttachmentLoss()` 按目标能力披露。
 * 未知类型：按类型计数写进正文（与 claude parse 同一口径），让只含未知块的消息仍然成为一轮。
 */
function extractBlocks(
  blocks: unknown[],
  timestamp: string,
): { text: string; events: ProcessEvent[] } {
  const texts: string[] = [];
  const events: ProcessEvent[] = [];
  const unknown = new Map<string, number>();
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      unknown.set('（非对象内容块）', (unknown.get('（非对象内容块）') ?? 0) + 1);
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (type === 'thinking') {
      const thinking = typeof b.thinking === 'string' ? b.thinking : '';
      events.push({
        kind: 'thinking',
        summary: thinking ? summarize(thinking, '思考中…') : '思考中…',
        detail: thinking || undefined,
        timestamp,
        provider: 'pi',
      });
    } else if (type === 'toolCall') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      const callId = typeof b.id === 'string' ? b.id : undefined;
      events.push({
        kind: 'tool_call',
        summary: `${name}`,
        timestamp,
        provider: 'pi',
        name,
        callId,
        input: b.arguments,
      });
    } else if (type === 'image') {
      // 字段口径来自 pi-ai 的 ImageContent：`{ type: 'image', data: base64, mimeType }`
      const media = typeof b.mimeType === 'string' && b.mimeType ? b.mimeType : 'image';
      const placeholder =
        typeof b.data === 'string' ? `[图片：${media}，${b.data.length}B]` : `[图片：${media}]`;
      texts.push(placeholder);
      if (typeof b.data === 'string') {
        events.push({
          kind: 'text',
          summary: placeholder,
          detail: placeholder,
          timestamp,
          provider: 'pi',
          attachment: { kind: 'image', mediaType: media, data: b.data },
        });
      }
    } else if (type === 'text' && b.text == null && typeof b.content === 'string') {
      texts.push(b.content);
    } else {
      const unknownType = typeof type === 'string' && type ? type : '（空类型）';
      unknown.set(unknownType, (unknown.get(unknownType) ?? 0) + 1);
    }
  }
  // 未识别块的占位跟着文本走：`watch prompt` 的文档会被复制走，standard 档位也不展开事件。
  if (unknown.size > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const counts = [...unknown.entries()].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join('、');
    texts.push(
      `[Pi 记录里有 ${total} 个未识别的消息块（${counts}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Pi 里查看]`,
    );
  }
  return { text: texts.join('\n'), events };
}
