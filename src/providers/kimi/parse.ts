import { ToolResultPairing } from '../../core/tool-pairing.js';
import { iterateFileLines } from '../../core/read-text.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import { clipCodePoints } from '../../core/display.js';
import { isoFromEpochMs } from '../../core/time.js';
import { ensureAssistant, formatUnknownTypeCounts, KIMI_COMPACTION_SUMMARY_PREFIX, normalizeUserText, pushEvent, stripEmptyEvents, summarize, unknownTypeLabel, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

/**
 * Kimi wire.jsonl → UnifiedTurn[]
 *
 * 关键事件（协议 1.4/1.5）：
 * - turn.prompt / turn.steer，origin.kind = 'user' → user turn
 * - context.append_loop_event
 *   - content.part type=text → assistant text
 *   - content.part type=think → thinking event
 *   - tool.call → tool_call event
 *   - tool.result → tool_result event
 * - turn.ended → assistant turn 结束
 *
 * - context.append_message → 旧格式消息回退；现代用户回声以已接受的 turn.prompt 为准
 * - context.apply_compaction → 有可读摘要时还原带来源前缀的用户轮，否则只披露、不设裁剪边界
 *
 * 跳过：llm.*、permission.*、plugin.*、token_counting.*、interaction.* 等内部事件
 * （KNOWN_KIMI_TOP_LEVEL_TYPES 逐条登记已知类型，表外类型计数披露）。
 *
 * 逐行流式读取（`iterateFileLines()`），不整份 `readFile`：wire.jsonl 连流式增量（`llm.*`）
 * 都逐条落盘，长会话可以超过 V8 字符串上限（约 512 MB），整份读取会抛 `Invalid string length`
 * ——同一个文件流式却能正常解析（第八十四轮 Claude 大会话的同一形状）。
 */
const END_REASON_LABELS: Record<string, string> = {
  cancelled: '用户中止',
  failed: '请求失败',
  blocked: '被阻止',
  '（缺 reason）': '缺少结束原因',
};

/**
 * wire.jsonl 的持久化记录类型（协议 1.5）。上游 `packages/agent-core-v2/docs/wire-manifest.d.ts`
 * 列出 67 种（生成自 EVENT2_REGISTRY，min_protocol_version 1.5）；`metadata` 是日志头部行
 * （`{"type":"metadata","protocol_version",…}`），`goal.account_usage` / `goal.continuation`
 * 是协议 ≤1.3 的旧类型（v1.3→v1.4 迁移并入 `goal.update`）。
 *
 * Watch 解析 turn.prompt / turn.steer / context.append_message / context.append_loop_event /
 * context.apply_compaction / usage.record / turn.ended；`context.clear` / `context.undo` 另有
 * 计数披露（它们改变模型上下文，但 Watch 不重建上下文投影）。其余都是有意的记账记录：
 * 计划 / 模式、工具注册、子代理与后台任务生命周期、MCP、权限、LLM 请求追踪、文件检查点、
 * 定时任务、记账与用量明细——它们不构成对话轮次，也不带需要并入的用户 / 助手正文。
 * 表外类型由 parseKimiSession() 按 type 计数披露：Kimi 新增内容型记录时不能静默丢掉。
 */
const KNOWN_KIMI_TOP_LEVEL_TYPES = new Set([
  'metadata',
  // 更早的头部绑定形状（不在 1.5 清单里）：build.ts 的 HEADER_TYPES 会原样保留它，
  // 解析侧必须同样认识，否则 Watch 改写过的旧日志会被自己的披露当成未知记录。
  'runtime.set_binding',
  'changeNotifier.snapshot', 'config.update',
  'context.append_loop_event', 'context.append_message', 'context.apply_compaction',
  'context.clear', 'context.undo',
  'cron.add', 'cron.cursor', 'cron.delete',
  'environment.set_binding',
  'file_history.checkpoint', 'file_history.tracked',
  'forked',
  'full_compaction.begin', 'full_compaction.cancel', 'full_compaction.complete',
  'goal.account_usage', 'goal.clear', 'goal.continuation', 'goal.create', 'goal.update',
  'interaction.request', 'interaction.resolved',
  'interruptionReminder.recorded', 'interruptionReminder.requested',
  'llm.request', 'llm.tools_snapshot',
  'mcp.server_failed', 'mcp.server_failure_resolved', 'mcp.tools_discovered',
  'permission.record_approval_result', 'permission.set_mode',
  'plan_mode.cancel', 'plan_mode.enter', 'plan_mode.exit', 'plan.revision',
  'plugin.session_start',
  'profile.bind',
  'prompt.aborted', 'prompt.completed', 'prompt.steered',
  'subagent.cancelled', 'subagent.completed', 'subagent.failed', 'subagent.spawned', 'subagent.started',
  'swarm_mode.enter', 'swarm_mode.exit',
  'task.started', 'task.terminated',
  'token_counting.measured', 'token_counting.rebased', 'token_counting.truncated', 'token_counting.turn_recorded',
  'tool_select.initialized', 'tool_select.tools_changed',
  'tools.register_user_tool', 'tools.reset_active_tools', 'tools.set_active_tools',
  'tools.unregister_user_tool', 'tools.update_store',
  'tower_mode.enter', 'tower_mode.exit',
  'turn.cancel', 'turn.ended', 'turn.prompt', 'turn.steer',
  'usage.record',
]);

/** 未知顶层类型的清单展示：有界、转义，防止记录里的类型名把控制字符带进终端。 */
function kimiTypeCounts(counts: Map<string, number>): string {
  const entries = [...counts];
  const shown = entries.slice(0, 8).map(([type, n]) => `${unknownTypeLabel(type, 60)}×${n}`);
  if (entries.length > 8) shown.push(`另有 ${entries.length - 8} 种`);
  return shown.join('、');
}

export async function parseKimiSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const turns: UnifiedTurn[] = [];
  const pairing = new ToolResultPairing(turns, 'kimi', 'Kimi');
  let state: 'idle' | 'user' | 'assistant' = 'idle';
  // 1.4 的 turn.prompt 才是用户输入的权威记录；出现之后，append_message 里的用户消息
  // 只是同一句提问的回声（可能缺附件占位），再收一次就会变成连续两个用户轮。
  let sawTurnPrompt = false;
  const loopTextTurns = new Set<UnifiedTurn>();
  let unreadableCompactions = 0;
  // 旧格式（1.0）里 Watch 没有解析的记录：非 user / assistant 的消息，以及带 toolCalls 的助手消息。
  // 这些记录里的工具调用不会进入交接，必须计数披露，不能让人以为旧日志已被完整还原。
  let unsupportedLegacy = 0;
  // 已接受的 turn.prompt 正文：用来判断 1.4 日志里被跳过的用户 append_message 是不是回声。
  // 正常 1.4 日志里回声与 prompt 同文，不冒披露；对不上号的才说明「可能有用户消息没并入」。
  const promptUserTexts = new Set<string>();
  let unmatchedLegacyUsers = 0;
  // content.part 里认不出的片段类型按 turn 计数，循环结束后统一写进正文（见下方注释）
  const unknownParts = new Map<UnifiedTurn, Map<string, number>>();
  // 认不出的 loop 事件类型（以及 tool.call / tool.result 的坏形状）按类型聚合一次。
  // 不能逐条计数：流式 delta 也走 context.append_loop_event，正常会话会被刷满；
  // 也正因如此以前完全不计——新出现的内容类事件就连痕迹都没有。聚合后一条披露。
  const unknownLoopEvents = new Map<string, number>();
  // 顶层记录类型：表外类型按 type 计数（与 Pi / Codex / Claude 同口径）；缺 type 与
  // type 不是字符串分开点名，避免把人引向错误的核对方向。
  const unknownTopLevel = new Map<string, number>();
  // context.clear / context.undo 不改变日志本身，却改变模型当时可见的上下文：Watch 不重建
  // 上下文投影，交接保留日志原文（可能比当时上下文更多），按次数与撤销条数披露。
  let contextClears = 0;
  let contextUndos = 0;
  let contextUndoItems = 0;
  // 顶层 `turn.ended` 的 `reason`（上游 TurnEndReason：completed / cancelled / failed /
  // blocked）以前只用来把 state 归零，失败 / 中止 / 权限阻止与正常完成同形。
  // 按原因计数而不是保留 `error.message`：那是 KimiErrorPayload，可能带上游响应片段。
  const endReasons = new Map<string, number>();
  let unrecognizedEndReasonCount = 0;
  let lastNonCompletedReason = '';
  let tailEndedFailed = false;
  let tailEventSeq = 0;
  let failureEventSeq = 0;

  for await (const line of iterateFileLines(ref.filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const r = parseJsonObject(trimmed);
    if (!r) continue;
    const type = r.type;
    const time = typeof r.time === 'number' ? r.time : undefined;
    // 越界数值（1e30 / 单位写错）只让这一条记录失去时间戳，不能让整条会话解析抛错
    const timestamp = time ? isoFromEpochMs(time) : '';
    if (typeof type !== 'string' || type === '' || !KNOWN_KIMI_TOP_LEVEL_TYPES.has(type)) {
      const label = typeof type === 'string' && type !== ''
        ? type
        : type === undefined ? '（缺 type）' : '（type 不是字符串）';
      unknownTopLevel.set(label, (unknownTopLevel.get(label) ?? 0) + 1);
      continue;
    }

    if (type === 'turn.prompt' || type === 'turn.steer') {
      const extracted = extractUserInput(r, timestamp);
      if (extracted === null) continue;
      const normalized = normalizeUserText(extracted.text);
      if (normalized === null) continue;
      sawTurnPrompt = true;
      promptUserTexts.add(normalized);
      turns.push({
        role: 'user',
        text: normalized,
        timestamp,
        ...(extracted.events.length ? { events: extracted.events } : {}),
      });
      tailEventSeq += 1;
      state = 'user';
      continue;
    }

    if (type === 'context.append_message') {
      // Kimi 1.0 的助手回复（以及迁移过来的旧日志）只有这条记录；1.4 把可见文本流成
      // `context.append_loop_event`。以前这里一律当 turn.prompt 的重复跳过，于是 1.0 会话
      // 只剩提问、模型看起来从没回答过（上游 catchup 明确写了 assistant records only
      // occur on 1.0 logs）。助手消息作为回退读取；用户消息只在 origin 缺省（1.0）或
      // origin.kind = "user" 时接受，并跳过系统注入 / system-reminder。
      const message = asRecord(r.message);
      const role = asString(message?.role);
      if (role !== 'user' && role !== 'assistant') {
        // 旧格式附录里还有 role 为 tool 之类的消息，Watch 没有解析它们——计数披露，
        // 不能让人把「工具历史不在交接里」误当成「旧日志本来就没有工具调用」。
        unsupportedLegacy += 1;
        continue;
      }
      const legacyToolCalls = Array.isArray(message?.toolCalls)
        ? message.toolCalls.length
        : Array.isArray(message?.tool_calls)
          ? message.tool_calls.length
          : 0;
      if (legacyToolCalls > 0) unsupportedLegacy += 1;
      const extracted = extractAppendMessage(message);
      const body = extracted.text.trim() ? extracted.text : '';
      if (!body && extracted.unknown.size === 0) continue;
      const text = [body, unknownBlockNote(extracted.unknown)].filter(Boolean).join('\n\n');
      if (role === 'assistant') {
        const last = ensureAssistant(turns, timestamp, 'kimi');
        // 1.4 日志可能两者并存：同一段回答不能因回退读取再写一遍
        if (loopTextTurns.has(last) && last.text === text) continue;
        last.text = last.text ? `${last.text}\n\n${text}` : text;
        tailEventSeq += 1;
        state = 'assistant';
        continue;
      }
      const origin = message?.origin ?? r.origin;
      if (origin !== undefined && promptOriginKind(origin) !== 'user') continue;
      // 1.4 的用户消息回声以 turn.prompt 为准（含图片占位）；不能因正文不完全同文就再收一轮。
      if (sawTurnPrompt) {
        const echo = body ? normalizeUserText(body) : null;
        if (echo !== null && !promptUserTexts.has(echo)) unmatchedLegacyUsers += 1;
        continue;
      }
      const normalized = normalizeUserText(text);
      if (normalized === null) continue;
      turns.push({ role: 'user', text: normalized, timestamp });
      tailEventSeq += 1;
      state = 'user';
      continue;
    }

    if (type === 'context.append_loop_event') {
      const event = asRecord(r.event);
      if (!event) {
        // 合法 JSON 但不是对象：这条 loop 事件无法读取，不能连计数都没有。
        unknownLoopEvents.set('（event 非对象）', (unknownLoopEvents.get('（event 非对象）') ?? 0) + 1);
        continue;
      }

      if (event.type === 'tool.result') {
        const result = asRecord(event.result);
        const output = result?.output ?? '';
        const detail = typeof output === 'string' ? output : JSON.stringify(output);
        pairing.result({
          kind: 'tool_result', summary: detail ? summarize(detail, '工具返回') : '工具返回',
          detail, timestamp, provider: 'kimi',
          callId: asString(event.toolCallId) ?? asString(event.parentUuid) ?? undefined,
          ...(result?.isError === true ? { failed: true } : {}),
        });
        continue;
      }
      // loop 事件属于 assistant turn；若当前刚进入 user，则创建 assistant
      if (state === 'user' || state === 'idle') {
        state = 'assistant';
      }
      if (state !== 'assistant') continue;

      const last = ensureAssistant(turns, timestamp, 'kimi');
      tailEventSeq += 1;
      processLoopEvent(
        event,
        last,
        timestamp,
        (partType) => {
          const counts = unknownParts.get(last) ?? new Map<string, number>();
          counts.set(partType, (counts.get(partType) ?? 0) + 1);
          unknownParts.set(last, counts);
        },
        (key) => unknownLoopEvents.set(key, (unknownLoopEvents.get(key) ?? 0) + 1),
        pairing,
      );
      if (event.type === 'content.part' && asRecord(event.part)?.type === 'text') loopTextTurns.add(last);
      continue;
    }

    if (type === 'context.apply_compaction') {
      // 官方 contextEvents.ts 同时接受 summary / contextSummary 字符串与旧版消息对象。
      // 只有可读摘要才能作 --since-compact 的起点；空摘要只披露，避免切掉仍可用的历史。
      const message = extractAppendMessage(asRecord(r.summary));
      const summary = [r.contextSummary, r.summary, message.text]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!summary) {
        unreadableCompactions += 1;
        continue;
      }
      turns.push({
        role: 'user',
        text: `${KIMI_COMPACTION_SUMMARY_PREFIX}\n${summary}${unknownBlockNote(message.unknown) ? `\n\n${unknownBlockNote(message.unknown)}` : ''}`,
        timestamp,
      });
      tailEventSeq += 1;
      state = 'user';
      continue;
    }

    if (type === 'usage.record') {
      // 原生 kimi 把用量记成独立 usage.record 事件，归属最后一次 assistant 回复
      const usage = usageFromRecord(asRecord(r.usage));
      if (usage && turns.at(-1)?.role === 'assistant') turns.at(-1)!.usage = usage;
      continue;
    }

    if (type === 'turn.ended') {
      state = 'idle';
      const rawReason = r.reason;
      const rawLabel =
        typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : '（缺 reason）';
      const reason = unknownTypeLabel(rawLabel, 64);
      const known = ['completed', 'cancelled', 'failed', 'blocked'].includes(rawLabel);
      // 缺 reason 与未识别类型分开点名（与 Pi 的 type 形状分档同口径）；completed 不计数，
      // 健康日志不能冒出假警告。
      if (reason === '（缺 reason）' || (known && reason !== 'completed')) {
        endReasons.set(reason, (endReasons.get(reason) ?? 0) + 1);
      }
      if (!known && reason !== '（缺 reason）') unrecognizedEndReasonCount += 1;
      if (reason !== 'completed') {
        lastNonCompletedReason = reason;
        failureEventSeq = tailEventSeq;
        tailEndedFailed = true;
      } else {
        tailEndedFailed = false;
      }
      continue;
    }

    if (type === 'context.clear') {
      contextClears += 1;
      continue;
    }
    if (type === 'context.undo') {
      contextUndos += 1;
      const count = typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0
        ? Math.floor(r.count)
        : 0;
      contextUndoItems += count;
      continue;
    }
  }

  // 未识别的 content.part 类型跟着文本走（与 claude / pi / grok 同一口径）：正文会被
  // `watch prompt` 复制走、也作为文本转入目标会话，standard 档位不展开事件。
  for (const [turn, counts] of unknownParts) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const shown = formatUnknownTypeCounts(counts);
    const note = `[Kimi 记录里有 ${total} 个未识别的消息片段（${shown}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Kimi 里查看]`;
    turn.text = [turn.text, note].filter((s) => s.trim()).join('\n\n');
  }
  const disclose = (text: string, event?: Partial<ProcessEvent>): void => {
    const carrier = [...turns].reverse().find((turn) => turn.role === 'user' || turn.text.trim());
    if (!carrier) return;
    const note = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text}]`;
    pushEvent(carrier, {
      kind: 'text',
      summary: clipCodePoints(note, 120).text,
      detail: note,
      timestamp: carrier.timestamp,
      provider: 'kimi',
      ...event,
    });
  };
  // `turn.ended` 的失败 / 中止 / 阻止是会话收尾事实。只披露稳定原因与次数，
  // 不复制 `error.message`（上游错误对象可能带请求片段）。
  const endNoteParts: string[] = [];
  if (endReasons.size > 0) {
    // endReasons 只会有 `（缺 reason）` 与三个已知非完成原因（completed 不计数），最多 4 项，
    // 不需要 8 项上限；未识别的原因只按条数计入 unrecognizedEndReasonCount，不展示原文。
    const shown = [...endReasons.entries()]
      .map(([reason, count]) => `${END_REASON_LABELS[reason] ?? unknownTypeLabel(reason, 64)} × ${count}`)
      .join('、');
    endNoteParts.push(`Kimi 日志里的轮次以非正常原因结束（${shown}）`);
  }
  if (unrecognizedEndReasonCount > 0) {
    endNoteParts.push(`另有 ${unrecognizedEndReasonCount} 条未识别的结束原因，Watch 暂不解析`);
  }
  if (endNoteParts.length > 0) {
    endNoteParts.push('接手前请先在原生 Kimi 中确认这些轮次是否需要重试；Watch 不复制上游错误原文');
  }
  // Kimi 的 parse 不能凭空造空助手轮（写出侧会把无正文无事件的轮次跳过，round-trip 失败），
  // 与 Grok 同口径：用结构化 tailFailure 改写下游「可能还在生成」的兜底句。
  const tailUnanswered = tailEndedFailed && failureEventSeq === tailEventSeq && turns.at(-1)?.role === 'user';
  if (endNoteParts.length > 0) {
    const tail = tailUnanswered && lastNonCompletedReason
      ? `；最后一轮以${END_REASON_LABELS[lastNonCompletedReason] ?? '请求失败'}结束，不是仍在生成`
      : '';
    disclose(
      `${endNoteParts.join('；')}${tail}`,
      tailUnanswered
        ? { tailFailure: lastNonCompletedReason === 'cancelled' ? 'cancelled' : 'error' }
        : undefined,
    );
  }
  if (unknownLoopEvents.size > 0) {
    const total = [...unknownLoopEvents.values()].reduce((a, b) => a + b, 0);
    const shown = [...unknownLoopEvents.entries()].map(([t, n]) => (n > 1 ? `${t} × ${n}` : `${t} × 1`)).join('、');
    disclose(`Kimi 日志里有 ${total} 个未识别或无法解析的 loop 事件（${shown}），Watch 暂不解析：其中的内容没有并入交接，需要时请在原生 Kimi 中查看`);
  }
  if (unreadableCompactions > 0) {
    disclose(`Kimi 有 ${unreadableCompactions} 条 context.apply_compaction 记录没有可读摘要；这部分摘要未并入交接，也不作为 --since-compact 的裁剪边界，请在原生 Kimi 中核对。`);
  }
  if (unsupportedLegacy > 0) {
    disclose(`Kimi 旧格式日志里有 ${unsupportedLegacy} 条 context.append_message 记录 Watch 暂不解析（非 user / assistant 消息，或带工具调用的助手消息）；这些记录里的工具调用没有并入交接，需要时请在原生 Kimi 中核对。`);
  }
  if (unmatchedLegacyUsers > 0) {
    disclose(`Kimi 日志里有 ${unmatchedLegacyUsers} 条旧格式用户消息（context.append_message）没能对应到任何 turn.prompt 记录，可能没有被并入交接；需要时请在原生 Kimi 中核对。`);
  }
  // 未识别的顶层记录类型只计数、不猜测语义：无法确认其中是否包含对话内容，也不能把它们的
  // 字段当正文并入。披露是提示而不是解析支持——读者需要时回来源核对。
  if (unknownTopLevel.size > 0) {
    const total = [...unknownTopLevel.values()].reduce((a, b) => a + b, 0);
    disclose(`Kimi 日志里有 ${total} 条未识别的顶层记录（${kimiTypeCounts(unknownTopLevel)}），Watch 暂不解析：无法确认其中是否包含对话内容，这些记录没有并入交接，需要时请在原生 Kimi 中核对`);
  }
  if (contextClears > 0 || contextUndos > 0) {
    const parts: string[] = [];
    if (contextClears > 0) parts.push(`${contextClears} 次上下文清理（context.clear）`);
    if (contextUndos > 0) {
      parts.push(`${contextUndos} 次撤销${contextUndoItems > 0 ? `（共 ${contextUndoItems} 条消息）` : ''}`);
    }
    disclose(`Kimi 日志里有 ${parts.join('与 ')}，Watch 不重建上下文投影：交接保留日志原文，可能比模型当时的上下文更多，需要时请在原生 Kimi 中核对`);
  }
  pairing.finish();
  return stripEmptyEvents(turns);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * kimi usage 形状（usage.record 与 step.end.usage 共用）：input 含缓存读/建。
 * 导出给 `kimiSessionUsage()` 复用——用量统计与 parse 必须认同一套形状，否则 Watch
 * 自己写出的 `step.end.usage` 会在 `watch usage` 里整段消失。
 */
export function usageFromRecord(usage: Record<string, unknown> | null): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = num(usage.inputOther) + num(usage.inputCacheRead) + num(usage.inputCacheCreation);
  const output = num(usage.output);
  if (input === 0 && output === 0) return undefined;
  return { inputTokens: input, outputTokens: output };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return asJsonObject(value);
}

/** `context.append_message.message`（1.0 / 迁移日志）的 content 块 → 文本与未识别块计数 */
function extractAppendMessage(message: Record<string, unknown> | null): {
  text: string;
  unknown: Map<string, number>;
} {
  const unknown = new Map<string, number>();
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) {
      unknown.set('（非对象内容块）', (unknown.get('（非对象内容块）') ?? 0) + 1);
      continue;
    }
    if (b.type === 'text') {
      const text = asString(b.text);
      if (text) parts.push(text);
      continue;
    }
    const key = asString(b.type) ?? '（空类型）';
    unknown.set(key, (unknown.get(key) ?? 0) + 1);
  }
  return { text: parts.join('\n'), unknown };
}

function unknownBlockNote(counts: Map<string, number>): string {
  if (counts.size === 0) return '';
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const shown = [...counts.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join('、');
  return `[Kimi 记录里有 ${total} 个未识别的消息块（${shown}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Kimi 里查看]`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 官方当前协议用字符串 origin，旧版协议用 { kind }；两者都只接受显式 user。 */
function promptOriginKind(origin: unknown): string | null {
  return typeof origin === 'string' ? origin : asString(asRecord(origin)?.kind);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : '')).filter((s) => s !== '');
}

/**
 * 从 turn.prompt / turn.steer 提取用户输入。
 *
 * Kimi wire 的 prompt part（kimi-code `klient` schemas）只有三种：`text` / `image_url` /
 * `video_url`，后两者是 `{ imageUrl | videoUrl: { url } }`。以前这里只收 `text`，图片与视频
 * 连同原始数据一起消失——纯图片提问会让整条 user 轮不见，助手回复因此成为首轮，转入
 * claude 时还会被「首条 user 之前跳过」的规则连带丢掉，而命令照报成功。
 *
 * 可还原的媒体挂成 `attachment`（转入 claude / opencode 时能写回）；写不出原样的至少把
 * 占位写进正文，未知类型按 `type×n` 计数——与 pi / codex / grok 的用户侧同一口径。
 */
function extractUserInput(
  r: Record<string, unknown>,
  timestamp: string,
): { text: string; events: ProcessEvent[] } | null {
  if (promptOriginKind(r.origin) !== 'user') return null;
  const input = r.input;
  if (!Array.isArray(input)) return null;
  const parts: string[] = [];
  const events: ProcessEvent[] = [];
  const unknown = new Map<string, number>();
  for (const block of input) {
    const b = asRecord(block);
    if (!b) {
      unknown.set('（非对象输入块）', (unknown.get('（非对象输入块）') ?? 0) + 1);
      continue;
    }
    if (b.type === 'text') {
      const text = asString(b.text);
      if (text) parts.push(text);
      continue;
    }
    if (b.type === 'image_url') {
      const url = asString(asRecord(b.imageUrl)?.url);
      if (!url) {
        unknown.set('image_url（缺少地址）', (unknown.get('image_url（缺少地址）') ?? 0) + 1);
        continue;
      }
      const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      const placeholder = dataUri
        ? `[图片：${dataUri[1] || 'image'}，${dataUri[2]!.length}B]`
        : `[图片：${url}]`;
      parts.push(placeholder);
      const attachment = dataUri
        ? { kind: 'image' as const, mediaType: dataUri[1] || 'image', data: dataUri[2]! }
        : { kind: 'image' as const, url };
      events.push({ kind: 'text', summary: placeholder, detail: placeholder, timestamp, provider: 'kimi', attachment });
      continue;
    }
    if (b.type === 'video_url') {
      const url = asString(asRecord(b.videoUrl)?.url);
      if (!url) {
        unknown.set('video_url（缺少地址）', (unknown.get('video_url（缺少地址）') ?? 0) + 1);
        continue;
      }
      // 视频没有目标侧可还原的通用块：按文件附件挂出去，交接时由 describeAttachmentLoss 披露。
      const placeholder = `[视频：${url}]`;
      parts.push(placeholder);
      events.push({ kind: 'text', summary: placeholder, detail: placeholder, timestamp, provider: 'kimi', attachment: { kind: 'file', url } });
      continue;
    }
    const key = asString(b.type) ?? '（空类型）';
    unknown.set(key, (unknown.get(key) ?? 0) + 1);
  }
  if (unknown.size > 0) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const shown = [...unknown.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join('、');
    parts.push(
      `[Kimi 记录里有 ${total} 个未识别的输入片段（${shown}），Watch 暂不解析：这部分原始内容没有并入交接，需要时请在原生 Kimi 里查看]`,
    );
  }
  return parts.length > 0 ? { text: parts.join('\n'), events } : null;
}

/**
 * 已知但不需要搬运的 loop 事件族：llm.* 是模型流式增量、permission / plugin /
 * token_counting / interaction 是客户端内部状态，逐条计数会在每个正常会话上产生假披露。
 * step.begin 是 Watch 自己写出的步骤标记（step.end 由下面读取用量）。其余类型一律进入
 * 一次性聚合披露；新增已知内部类型时在这里补，不要靠“反正也没人看”静默跳过。
 */
const IGNORED_LOOP_EVENT = /^(?:llm|permission|plugin|token_counting|interaction)\./;

function processLoopEvent(
  event: Record<string, unknown>,
  turn: UnifiedTurn,
  timestamp: string,
  onUnknownPart: (partType: string) => void,
  onUnknownEvent: (key: string) => void,
  pairing: ToolResultPairing,
): void {
  const loopType = asString(event.type);
  if (!loopType) {
    onUnknownEvent('（空类型）');
    return;
  }
  if (loopType === 'step.begin' || IGNORED_LOOP_EVENT.test(loopType)) return;
  const base = { timestamp, provider: 'kimi' as const };

  // 我们 build 把用量写在 step.end 的 usage 字段（最后一个 step 覆盖前一个）
  if (loopType === 'step.end') {
    const usage = usageFromRecord(asRecord(event.usage));
    if (usage) turn.usage = usage;
    return;
  }

  if (loopType === 'content.part') {
    const part = asRecord(event.part);
    if (!part) {
      onUnknownPart('（无 part 字段）');
      return;
    }
    const partType = asString(part.type);
    if (partType === 'text') {
      const text = asString(part.text);
      if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
      return;
    }
    if (partType === 'think') {
      const think = asString(part.think);
      if (!think) return;
      pushEvent(turn, {
        ...base,
        kind: 'thinking',
        summary: summarize(think, '思考中…'),
        detail: think,
      });
      return;
    }
    // 认不出的片段类型（图片等）以前在这里直接 return：内容连同原始数据无声消失。
    // 只把 `content.part` 的**片段类型**计数写进正文；未知的 loop 事件类型聚合到另一条披露。
    onUnknownPart(partType ?? '（空类型）');
    return;
  }

  if (loopType === 'tool.call') {
    const name = asString(event.name);
    const callId = asString(event.toolCallId) ?? asString(event.uuid);
    if (!name || !callId) {
      // 缺 name 只是显示降级，缺 callId 则无法与结果配对；两者都不该整条消失。
      const missing = [!name ? 'name' : '', !callId ? 'callId' : ''].filter(Boolean).join(' / ');
      onUnknownEvent(`tool.call（缺少 ${missing}）`);
      return;
    }
    // `args` 是上游的 unknown：原生解析失败时会存字符串（补丁正文、半截 JSON 等）。
    // 与 claude parser 同一口径——字符串原样展示，不再套一层 JSON 引号与转义；其余仍序列化。
    const detail = typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {});
    pairing.call(turn, {
      ...base,
      kind: 'tool_call',
      summary: summarize(`${name}: ${detail}`, name),
      detail,
      name,
      callId,
      input: event.args ?? {},
    });
    return;
  }

  // 未知事件类型：内容可能承载了计划、文件编辑或新工具状态，不能静默丢。
  onUnknownEvent(loopType);
}
