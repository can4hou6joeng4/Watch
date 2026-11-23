import { danglingToolCalls, WATCH_CONTEXT_DISCLOSURE_PREFIX } from './rich.js';
import type { UnifiedTurn } from './types.js';

/** 统计适配器解析出的轮次、过程事件与附件，不输出事件正文。 */

export type SessionStructure = {
  /** 消息轮数（user + assistant） */
  turns: number;
  userTurns: number;
  assistantTurns: number;
  /** 可用时间戳的范围；没有任何可解析时间戳时为 null */
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** 计入范围的轮数；时间戳缺失或不可解析的轮次不计入 */
  timestampedTurns: number;
  events: {
    /** 中间说明（commentary） */
    text: number;
    thinking: number;
    toolCalls: number;
    toolResults: number;
    /** 明确失败的 tool_result（不代表没有副作用） */
    failedToolResults: number;
    /** tool_call 按 callId 找不到对应 tool_result 的次数；可能中断或仍在运行，不等于数据丢失 */
    danglingToolCalls: number;
  };
  /** 解析结果中带交接披露标记的事件数。披露详情可能含源记录中的命令样本。 */
  disclosureEvents: number;
  attachments: { images: number; files: number };
  /** 来源明确停在非终态的阶段回复 */
  incompleteTurns: number;
  /** 工具名计数（只统计 tool_call，按次数降序、同次数按名字排序；不含入参） */
  tools: { name: string; count: number }[];
};

export function summarizeSessionStructure(turns: readonly UnifiedTurn[]): SessionStructure {
  const events = { text: 0, thinking: 0, toolCalls: 0, toolResults: 0, failedToolResults: 0, danglingToolCalls: 0 };
  const attachments = { images: 0, files: 0 };
  const tools = new Map<string, number>();
  let userTurns = 0;
  let assistantTurns = 0;
  let incompleteTurns = 0;
  let disclosureEvents = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let timestampedTurns = 0;
  for (const turn of turns) {
    if (turn.role === 'user') userTurns += 1;
    else assistantTurns += 1;
    if (turn.incomplete) incompleteTurns += 1;
    const stamp = Date.parse(turn.timestamp);
    if (Number.isFinite(stamp)) {
      first = Math.min(first, stamp);
      last = Math.max(last, stamp);
      timestampedTurns += 1;
    }
    for (const event of turn.events ?? []) {
      switch (event.kind) {
        case 'text':
          if (event.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) disclosureEvents += 1;
          else events.text += 1;
          break;
        case 'thinking':
          events.thinking += 1;
          break;
        case 'tool_call':
          events.toolCalls += 1;
          tools.set(event.name ?? '(未标注)', (tools.get(event.name ?? '(未标注)') ?? 0) + 1);
          break;
        case 'tool_result':
          events.toolResults += 1;
          if (event.failed) events.failedToolResults += 1;
          break;
        default:
          // ProcessEvent.kind 是封闭枚举；真有新种类时上面的 switch 会漏计数，
          // 但这里不猜测名称——类型检查会先拦下来。
          break;
      }
      if (event.attachment) {
        if (event.attachment.kind === 'image') attachments.images += 1;
        else attachments.files += 1;
      }
    }
  }
  events.danglingToolCalls = danglingToolCalls(turns).length;
  return {
    turns: turns.length,
    userTurns,
    assistantTurns,
    firstTimestamp: Number.isFinite(first) ? new Date(first).toISOString() : null,
    lastTimestamp: Number.isFinite(last) ? new Date(last).toISOString() : null,
    timestampedTurns,
    events,
    disclosureEvents,
    attachments,
    incompleteTurns,
    tools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
