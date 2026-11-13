import { pushEvent, WATCH_CONTEXT_DISCLOSURE_PREFIX } from './rich.js';
import type { ProcessEvent, UnifiedTurn } from './types.js';

type UnpairedReason = 'missing' | 'unknown' | 'ambiguous';
const REASONS: Record<UnpairedReason, string> = {
  missing: '缺少调用 ID',
  unknown: '未找到对应的未完成调用',
  ambiguous: '调用 ID 对应多个未完成调用',
};

/** 按原始记录顺序配对，不能在解析结束后凭轮次位置猜测结果归属。 */
export class ToolResultPairing {
  private readonly pending = new Map<string, UnifiedTurn | null>();
  private readonly unpaired: { event: ProcessEvent; reason: UnpairedReason; index: number }[] = [];

  constructor(
    private readonly turns: UnifiedTurn[],
    private readonly provider: string,
    private readonly displayName: string,
  ) {}

  call(turn: UnifiedTurn, event: ProcessEvent): void {
    pushEvent(turn, event);
    if (event.callId) this.pending.set(event.callId, this.pending.has(event.callId) ? null : turn);
  }

  result(event: ProcessEvent): boolean {
    let reason: UnpairedReason = 'missing';
    if (event.callId) {
      const owner = this.pending.get(event.callId);
      this.pending.delete(event.callId);
      if (owner) {
        pushEvent(owner, event);
        return true;
      }
      reason = owner === null ? 'ambiguous' : 'unknown';
    }
    this.unpaired.push({ event, reason, index: this.turns.length - 1 });
    return false;
  }

  finish(): void {
    if (this.unpaired.length === 0) return;
    // 用户轮或有正文的助手轮才是安全载体，避免标记变成一条伪造的助手最终答复。
    // 固定在结果出现位置及其之前，后续增量不会把旧载荷搬到新的尾轮再写一遍。
    const firstCarrier = this.turns.find((turn) => turn.role === 'user' || turn.text.trim());
    if (!firstCarrier) {
      throw new Error(`${this.displayName} 日志中有 ${this.unpaired.length} 条工具结果无法确认调用归属，且没有用户消息或非空助手正文可安全保留标记；请先在来源文件或原生客户端中核对，Watch 未把这些结果当作已配对结果。`);
    }
    let previous: UnifiedTurn | undefined;
    const carriers = this.turns.map((turn) => {
      if (turn.role === 'user' || turn.text.trim()) previous = turn;
      return previous;
    });
    const counts = { missing: 0, unknown: 0, ambiguous: 0 };
    for (const { event, reason, index } of this.unpaired) {
      counts[reason] += 1;
      // 极旧日志可能在首条对话之前记录结果；使用第一条安全对话，仍不伪造助手轮。
      const carrier = carriers[index] ?? firstCarrier;
      const summary = `[${this.displayName} 未配对工具结果：${REASONS[reason]}]`;
      const id = event.callId ? `\n调用 ID：${JSON.stringify(event.callId)}` : '';
      const failure = event.failed === true ? '\n原生标记为失败' : '';
      pushEvent(carrier, {
        kind: 'text', summary, detail: `${summary}${id}${failure}\n${event.detail ?? event.summary}`,
        timestamp: event.timestamp, provider: this.provider,
      });
    }
    const carrier = carriers.at(-1)!;
    const parts = [
      counts.missing ? `缺少调用 ID ${counts.missing} 条` : '',
      counts.unknown ? `未找到未完成调用 ${counts.unknown} 条` : '',
      counts.ambiguous ? `调用 ID 重复 ${counts.ambiguous} 条` : '',
    ].filter(Boolean).join('、');
    const text = `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${this.displayName} 日志中有 ${this.unpaired.length} 条工具结果无法确认调用归属（${parts}），已作为带标记的过程文本保留，不计作已配对结果；可用 watch prompt <来源会话 id> --profile full 查看记录，完整原文请在来源文件或原生客户端中核对。]`;
    pushEvent(carrier, { kind: 'text', summary: text, detail: text, timestamp: carrier.timestamp, provider: this.provider });
  }
}
