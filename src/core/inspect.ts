import { WATCH_CONTEXT_DISCLOSURE_PREFIX } from './rich.js';
import type { UnifiedTurn } from './types.js';

/**
 * 会话结构视图（第 403 轮）：只统计形状，不复制正文。
 *
 * `watch prompt` 的产物带着对话原文，用户想把「这条会话 Watch 到底读到了什么」贴进 issue 时
 * 没法直接用它；`watch inspect` 用同一份解析结果只回答计数问题：多少轮、有哪些事件、附件几张、
 * 哪些工具被调用、坏行几条、用量多少。正文、工具入参 / 输出、附件数据一律不出现——这是它可以
 * 被安全分享的原因，也是它与 `prompt` / `sessions` 的分工。
 *
 * 纯函数：输入是适配器 `parse` 的结果，不读盘、不联网。
 */

export type SessionStructure = {
  /** 消息轮数（user + assistant） */
  turns: number;
  userTurns: number;
  assistantTurns: number;
  /** 可用时间戳的范围；没有任何可解析时间戳时为 null */
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  events: {
    /** 中间说明（commentary） */
    text: number;
    thinking: number;
    toolCalls: number;
    toolResults: number;
    /** 明确失败的 tool_result（不代表没有副作用） */
    failedToolResults: number;
  };
  attachments: { images: number; files: number };
  /** 来源明确停在非终态的阶段回复 */
  incompleteTurns: number;
  /** 工具名计数（只统计 tool_call，按次数降序、同次数按名字排序；不含入参） */
  tools: { name: string; count: number }[];
};

export function summarizeSessionStructure(turns: readonly UnifiedTurn[]): SessionStructure {
  const events = { text: 0, thinking: 0, toolCalls: 0, toolResults: 0, failedToolResults: 0 };
  const attachments = { images: 0, files: 0 };
  const tools = new Map<string, number>();
  let userTurns = 0;
  let assistantTurns = 0;
  let incompleteTurns = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const turn of turns) {
    if (turn.role === 'user') userTurns += 1;
    else assistantTurns += 1;
    if (turn.incomplete) incompleteTurns += 1;
    const stamp = Date.parse(turn.timestamp);
    if (Number.isFinite(stamp)) {
      first = Math.min(first, stamp);
      last = Math.max(last, stamp);
    }
    for (const event of turn.events ?? []) {
      switch (event.kind) {
        case 'text':
          // Watch 自己的披露事件不计入来源的 text 事件：它们只描述缺口，由 inspect 的
          // `disclosures` 单独列出（否则一条未识别记录会同时抬高「事件」并出现在披露里）。
          if (!event.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) events.text += 1;
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
  return {
    turns: turns.length,
    userTurns,
    assistantTurns,
    firstTimestamp: Number.isFinite(first) ? new Date(first).toISOString() : null,
    lastTimestamp: Number.isFinite(last) ? new Date(last).toISOString() : null,
    events,
    attachments,
    incompleteTurns,
    tools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
