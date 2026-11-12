import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureAssistant, normalizeUserText, pushEvent, stripEmptyEvents, summarize, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { grokUpdateScan } from './usage.js';

type ChatLine =
  | { type: 'system'; content: string }
  | { type: 'user'; content: unknown }
  | {
      type: 'assistant';
      content?: string;
      tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
      model_id?: string;
    }
  | { type: 'tool_result'; tool_call_id?: string; content?: unknown }
  | {
      type: 'reasoning';
      id?: string;
      summary?: Array<{ type?: string; text?: string }>;
      encrypted_content?: string;
      status?: string;
    }
  | { type: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return asJsonObject(value);
}

/**
 * 消息 `content` → 文本 + 未识别块的计数。
 *
 * grok 的 user / assistant `content` 既可能是字符串，也可能是内容块数组。以前只有
 * `extractUserText()` 处理 user 侧且只认 `type: 'text'` 的块，其余块（图片等）连同内容
 * 一起消失；assistant 侧更直接——`typeof r.content === 'string' ? … : ''`，一条数组形状的
 * 回复会被当成空文本，如果它同时没有 tool_calls，整条回复就此不见。`watch prompt` 与转入的
 * 目标会话里都少一段，而 round-trip 只比 thinking / tool_call / tool_result，拦不住。
 *
 * 未知块按 `type×n` 计数写进正文（与 claude / pi 同一口径），让只含未知块的消息仍然成为一轮。
 * `null` / `undefined` 是正常的「这条消息没有文本」（带 tool_calls 的 assistant 行就是如此），
 * 不计数。
 */
function extractContent(content: unknown): { text: string; unknown: Map<string, number> } {
  const unknown = new Map<string, number>();
  if (typeof content === 'string') return { text: content, unknown };
  if (!Array.isArray(content)) return { text: '', unknown };
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
      continue;
    }
    const type = b && typeof b.type === 'string' && b.type ? b.type : '（非对象内容块）';
    unknown.set(type, (unknown.get(type) ?? 0) + 1);
  }
  return { text: parts.join('\n'), unknown };
}

function unknownBlockNote(unknown: Map<string, number>): string {
  if (unknown.size === 0) return '';
  const total = [...unknown.values()].reduce((a, b) => a + b, 0);
  const counts = [...unknown.entries()].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join('、');
  return `[Grok 记录里有 ${total} 个未识别的消息块（${counts}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Grok 里查看]`;
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw ?? {};
}

function parseToolOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export async function parseGrokSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let sawUser = false;
  // 会话级按 callId 去重：CLI 会在行内重复登记调用，resume 重放还会让同一调用跨代再现，
  // 同一 callId 语义上就是一次调用，只保留首次
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  // chat_history.jsonl 行内无时间戳；用同目录 summary.json 的真实 created_at 做会话锚点，
  // 行程内单调 +1ms 递增，避免历史消息被打上 `now()` 造成的重放漂移。
  const anchor = await grokAnchorMs(ref.filePath);
  // 先把可解析的行收齐：锚点若来自文件 mtime，它代表「文件最后一次被写」——
  // 也就是**最后一条记录**的位置，必须知道行数才能把时间铺在它之前（见 grokAnchorMs）
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const r = parseJsonObject(line);
    if (r) records.push(r);
  }
  const base = anchor === null ? null : anchor.fromMtime ? anchor.ms - (records.length - 1) : anchor.ms;

  for (let lineIndex = 0; lineIndex < records.length; lineIndex += 1) {
    const r = records[lineIndex];
    const type = typeof r.type === 'string' ? r.type : '';
    const timestamp = grokTimestamp(base, lineIndex);

    if (type === 'user') {
      const extractedContent = extractContent(r.content);
      const text = normalizeUserText(
        [extractedContent.text, unknownBlockNote(extractedContent.unknown)].filter(Boolean).join('\n\n'),
      );
      if (!text) continue;
      sawUser = true;
      turns.push({ role: 'user', text, timestamp });
      continue;
    }

    if (type === 'assistant') {
      if (!sawUser) continue;
      const extractedContent = extractContent(r.content);
      const content = [extractedContent.text, unknownBlockNote(extractedContent.unknown)]
        .filter(Boolean)
        .join('\n\n');
      const toolCalls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      // 重放行可能整行只有已出现过的调用：不建空助手轮，否则后面会留下一个
      // 没有任何 tool_call 的轮次，写入侧无法配对（见下方 tool_result 分支）。
      const freshCalls = toolCalls.filter((tc) => {
        const id = typeof asRecord(tc)?.id === 'string' ? (asRecord(tc)!.id as string) : undefined;
        return !(id && seenCallIds.has(id));
      });
      if (!content.trim() && freshCalls.length === 0) continue;

      // Grok 把 tool_calls 和最终文本拆成两条 assistant 行；
      // 解析时合并回同一个 UnifiedTurn，保持 round-trip 稳定。
      if (content.trim() && toolCalls.length === 0) {
        const prev = turns.at(-1);
        if (
          prev?.role === 'assistant' &&
          (prev.events ?? []).some((e) => e.kind === 'tool_call')
        ) {
          prev.text = prev.text ? `${prev.text}\n\n${content}` : content;
          continue;
        }
      }

      const assistant = ensureAssistant(turns, timestamp, 'grok');
      if (content.trim()) assistant.text = content;
      for (const tc of freshCalls) {
        const t = asRecord(tc);
        if (!t) continue;
        const name = typeof t.name === 'string' ? t.name : 'tool';
        const callId = typeof t.id === 'string' ? t.id : undefined;
        // 同一行里也可能重复登记同一调用（Grok CLI 的真实形态），只留首个
        if (callId && seenCallIds.has(callId)) continue;
        if (callId) seenCallIds.add(callId);
        pushEvent(assistant, {
          kind: 'tool_call',
          name,
          callId,
          input: parseToolArguments(t.arguments),
          summary: `${name}: ${typeof t.arguments === 'string' ? t.arguments.slice(0, 200) : JSON.stringify(t.arguments ?? {}).slice(0, 200)}`,
          detail: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}),
          timestamp,
          provider: 'grok',
        });
      }
      continue;
    }

    if (type === 'tool_result') {
      if (!sawUser) continue;
      const callId = typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined;
      // 重放历史里同一调用的 result 也会跨代再现，同 id 只留首个
      if (callId && seenResultIds.has(callId)) continue;
      // 结果按 callId 挂回真正发起调用的轮次：重放行被去重后，最后一条 assistant 可能
      // 根本不含这个调用（甚至已被跳过而当前是 user 轮），挂上去就是一个孤儿结果。
      const owner = callId
        ? [...turns].reverse().find(
            (t) => t.role === 'assistant' && (t.events ?? []).some((e) => e.kind === 'tool_call' && e.callId === callId),
          )
        : undefined;
      const last = owner ?? (turns.at(-1)?.role === 'assistant' ? turns.at(-1) : undefined);
      if (!last) continue;
      if (callId) seenResultIds.add(callId);
      const output = parseToolOutput(r.content);
      pushEvent(last, {
        kind: 'tool_result',
        callId,
        summary: summarize(output, '工具返回'),
        detail: output,
        timestamp,
        provider: 'grok',
      });
      continue;
    }

    if (type === 'reasoning') {
      if (!sawUser) continue;
      const last = ensureAssistant(turns, timestamp, 'grok');
      const summaryParts = Array.isArray(r.summary)
        ? r.summary
            .map((s) => {
              const rec = asRecord(s);
              return typeof rec?.text === 'string' ? rec.text : '';
            })
            .filter(Boolean)
            .join('\n')
        : '';
      const text = summaryParts || (r.encrypted_content ? '思考中…（加密）' : '思考中…');
      pushEvent(last, {
        kind: 'thinking',
        summary: summarize(text, '思考中…'),
        detail: text,
        timestamp,
        provider: 'grok',
      });
      continue;
    }
  }

  return attachGrokSidecars(ref.filePath, stripEmptyEvents(turns));
}

/**
 * 把同目录 `updates.jsonl` 里的逐轮用量挂回 assistant 轮，并披露上下文压缩次数。
 *
 * 用量不在 `chat_history.jsonl`（本函数读的那份），而在 `updates.jsonl`——原生 `/resume`
 * 与 session restore 的权威日志，写出侧 `buildGrokUpdateLines()` 也把 `turn.usage` 写在那里。
 * 以前这里从不填 `turn.usage`，于是 **grok → 任何别家的转入一律写 0/0**，而同一次 `open`
 * 的 note 还写着「来源 Grok 用量 in=… out=…（已在对账中携带）」——信息层读了、搬运层没读。
 * 与 codex `token_count` / claude 缓存两块完全同源。
 *
 * **数量对不上就不挂**：`turn_completed` 与 assistant 轮一一对应（写出侧每轮恰好一条），
 * 数量不等说明有一侧被截断或重放，按顺序硬套会把第 N 轮的用量挂到别人头上——宁可不填，
 * 也不能编一个看似合理却错位的数（同 pi 不猜多 assistant 轮的既有取舍）。
 *
 * **`compaction_checkpoint` 只披露、不还原**：它表示 Grok 压缩过上下文，摘要正文在旁路
 * `compaction_checkpoints/` 文件里，格式未验证。直接读并拼进交接，会把未经验证的内容当成
 * Grok 的原话；完全不说是更糟的方向——用户会以为目标会话拿到了 Grok 当前的全部上下文。
 * 披露写成 `WATCH_CONTEXT_DISCLOSURE_PREFIX` 事件，由 `findContextDisclosure()` 汇入
 * prompt 头部、handoff warnings 与 open 三处。
 *
 * 读不出来同样不挂且不抛：用量是辅助数据，`updates.jsonl` 坏了不该让可读的内容交接失败；
 * 信息层 `grokSessionUsage()` 会在 `usage` / `open` 的 `warnings` 里单独报这个读取失败。
 */
async function attachGrokSidecars(chatPath: string, turns: UnifiedTurn[]): Promise<UnifiedTurn[]> {
  // 不让纯工具轮的空正文被披露文本替换；有真实用户轮或非空助手正文才挂载声明。
  const carrier = [...turns].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
  const disclose = (message: string): void => {
    if (!carrier) return;
    const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${message}]`;
    pushEvent(carrier, { kind: 'text', summary: text, detail: text, timestamp: carrier.timestamp, provider: 'grok' });
  };
  let scan: Awaited<ReturnType<typeof grokUpdateScan>>;
  try {
    scan = await grokUpdateScan(join(dirname(chatPath), 'updates.jsonl'));
  } catch (error) {
    disclose(`Grok 的 updates.jsonl 读取失败，无法确认上下文压缩记录与逐轮用量；本次仅保留 chat_history.jsonl 中可读的对话。${error instanceof Error ? error.message : String(error)}`);
    return turns;
  }
  if (!scan) return turns;
  if (scan.usages.length > 0) {
    const assistants = turns.filter((t) => t.role === 'assistant');
    if (assistants.length === scan.usages.length) {
      for (let i = 0; i < assistants.length; i++) assistants[i].usage = scan.usages[i];
    }
  }
  // 坏行本身已经由用量层（`usageBadLines`）在 prompt 头部 / open / handoff / usage 四处披露，
  // 这里不再单独重复一句；但坏行可能吞掉 compaction_checkpoint，压缩计数就只是下界——
  // 那句话必须挂在压缩披露里，不能把「读到 N 次」讲成「一共 N 次」。
  if (scan.compactions > 0) {
    disclose(
      `Grok 的 updates.jsonl 记录了 ${scan.compactions} 次上下文压缩（compaction_checkpoint）` +
      (scan.badLines > 0 ? `；另有 ${scan.badLines} 行无法解析，实际压缩次数可能更多` : '') +
      `；Watch 的解析以 chat_history.jsonl 为准，压缩摘要与压缩后重建的上下文没有并入这次交接：` +
      `目标会话看到的可能是压缩前的历史，与 Grok 当前实际使用的上下文不一致，需要精确续接时请在原生 Grok 中核对。`,
    );
  }
  return turns;
}

async function readGrokCreatedAt(filePath: string): Promise<string | null> {
  try {
    const summary = parseJsonObject(await readFile(join(dirname(filePath), 'summary.json'), 'utf8'));
    return typeof summary?.created_at === 'string' && summary.created_at ? summary.created_at : null;
  } catch {
    return null;
  }
}

/**
 * 会话锚点（毫秒）：优先 `summary.json` 的 `created_at`，缺失 / 解析不了时退回会话文件的修改时间。
 *
 * 退回 mtime 而不是 `now()`（2026-11-10）：行内没有逐轮时间戳，`now()` 会让**同一条会话每次解析
 * 都得到不同的时间**——`watch prompt` 的「时间范围」于是声称这段对话发生在你执行命令的那一刻，
 * `open --to` / `switch` 写进目标会话的也是那一刻；重复执行两次，目标时间戳还会跟着漂移。
 * mtime 是真实的磁盘事实（`listGrokSessions()` 给 `updatedAt` 的兜底同样是它），稳定、可复现。
 *
 * 两种锚点的**方向相反**，调用方必须区分：`created_at` 是会话**开始**的时间，逐行 +1ms 往后铺；
 * mtime 是文件**最后一次被写**的时间（≈最后一条记录），往前铺 `- (行数-1)`。否则首条记录
 * 比 updatedAt 还晚 1ms，`watch prompt` 会把这一小段倒挂报成「起始时间不可用，可能是占位值」——
 * 又是一个没验证过的原因。
 */
async function grokAnchorMs(filePath: string): Promise<{ ms: number; fromMtime: boolean } | null> {
  const created = await readGrokCreatedAt(filePath);
  if (created) {
    const t = Date.parse(created);
    if (!Number.isNaN(t)) return { ms: t, fromMtime: false };
  }
  try {
    return { ms: (await stat(filePath)).mtimeMs, fromMtime: true };
  } catch {
    // 文件都 stat 不到时 `readFile` 早已抛错，这里只是兜底
    return null;
  }
}

function grokTimestamp(anchor: number | null, index: number): string {
  if (anchor === null) return isoTimestamp();
  return new Date(anchor + index).toISOString();
}

function isoTimestamp(): string {
  return new Date().toISOString();
}
