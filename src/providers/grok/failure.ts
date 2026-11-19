import { clipCodePoints, escapeControlChars } from '../../core/display.js';
import { WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import type { ProcessEvent } from '../../core/types.js';

/**
 * Grok 的失败 / 中止 / 重试记录（2026-11-13，第八十二轮）。
 *
 * 权威日志是同目录 `updates.jsonl`（ACP）：原生 `/resume` 与 session restore 读它，
 * Watch 的写出侧也只往这里写 `turn_completed`。原生在失败时写的是——
 * - `sessionUpdate: "turn_completed"` 且 `stop_reason` 为 `error` / `cancelled` / `end_turn`；
 * `agent_result` 只是短字符串，`usage` 可能缺席。
 * - `sessionUpdate: "retry_state"`，是**独立的 update 类型**（不是 turn_completed 的字段），
 *   出现在某条 `turn_completed` 之前；字段 `type` 为 `retrying` / `failed`，
 *   `error_type` 为 `api` / `http`，另有 `attempt` / `max_retries` / `reason`。
 *
 * 本机 24 条带 `updates.jsonl` 的会话只读采样（只统计类型名、字段名与数量，
 * 未输出或保存任何正文、错误消息或响应体）：`turn_completed` 178 条，`end_turn` 169、
 * `error` 6、`cancelled` 3；`retry_state` 437 条（`api` 280 / `http` 146，`retrying` 431 /
 * `failed` 6），全部 `attempt ≤ max_retries`。
 *
 * **`reason` 不能进披露**：采样里它带完整上游 URL（`https://cli-chat-proxy.grok.com/…`、
 * 第三方网关地址）与 HTTP 状态码，和 Pi 的 `errorMessage` 同一性质。这里只保留
 * `error_type` 这个稳定枚举与次数。
 *
 * Watch 以前只把 `turn_completed` 当用量来源：失败与重试次数整份消失，下游只会说
 * 「最后停在用户消息上，可能被中断或还在生成」——用户主动中止（`cancelled`）与请求失败
 * （`error`）被讲成同一件事，重试过 15 次才放弃的轮次看起来像第一次就断了。
 */
export type GrokFailureCounts = {
  /** `stop_reason: "error"` 的轮次数 */
  errors: number;
  /** `stop_reason: "cancelled"` 的轮次数（用户中止或进程收尾） */
  cancelled: number;
  /** `retry_state` 总条数，全部发生在某个 `turn_completed` 之前 */
  retries: number;
  /** `retry_state.error_type` → 次数（`api` / `http` / 其余原值） */
  retryClasses: Map<string, number>;
  /** `retry_state.type === "failed"`（重试耗尽）的条数 */
  retryFailed: number;
  /** 有重试记录的轮次数（`retry_state` 出现在该轮 `turn_completed` 之前） */
  retryTurns: number;
  /** 重试后仍以 `end_turn` 正常结束的轮次数 */
  retryTurnsRecovered: number;
  /** 重试耗尽（`type: "failed"`）的轮次数 */
  retryTurnsExhausted: number;
  /** 单轮最多的重试次数 */
  maxRetriesInTurn: number;
  /** 末尾没有对应 `turn_completed` 的重试条数（会话在轮次中途被结束） */
  trailingRetries: number;
  /** 当前轮尚未归属的重试条数（扫描内部状态，见 finalizeGrokRetryAttribution） */
  pendingRetries: number;
  /** 当前轮里已耗尽的重试条数（内部状态） */
  pendingRetryFailed: number;
  /** `turn_completed` 总条数：逐轮用量能否挂回按它和助手轮数比对 */
  turnCompletions: number;
  /** 最后一条 `turn_completed` 的 `stop_reason`（由扫描侧填；用于判断尾部是否失败） */
  lastStopReason: string;
  /** 未识别的 `stop_reason` → 次数；`end_turn` 不进这里 */
  unknownStops: Map<string, number>;
};

/** 已知的 `stop_reason`：`end_turn` 是正常结束，不产生任何披露。 */
const KNOWN_STOP_REASONS = new Set(['end_turn', 'error', 'cancelled']);

export function createGrokFailureCounts(): GrokFailureCounts {
  return {
    errors: 0,
    cancelled: 0,
    retries: 0,
    retryClasses: new Map(),
    retryFailed: 0,
    retryTurns: 0,
    retryTurnsRecovered: 0,
    retryTurnsExhausted: 0,
    maxRetriesInTurn: 0,
    trailingRetries: 0,
    pendingRetries: 0,
    pendingRetryFailed: 0,
    turnCompletions: 0,
    lastStopReason: '',
    unknownStops: new Map(),
  };
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** 把当前轮累积的重试归属到这一轮（在读到 `turn_completed` 时调用）。 */
function attributePendingRetries(counts: GrokFailureCounts, stop: string): void {
  if (counts.pendingRetries > 0) {
    counts.retryTurns += 1;
    if (counts.pendingRetries > counts.maxRetriesInTurn) counts.maxRetriesInTurn = counts.pendingRetries;
    if (counts.pendingRetryFailed > 0) counts.retryTurnsExhausted += 1;
    else if (stop === 'end_turn') counts.retryTurnsRecovered += 1;
  }
  counts.pendingRetries = 0;
  counts.pendingRetryFailed = 0;
}

/** 读一条 `turn_completed` 的结束原因；返回是否为失败 / 中止。 */
export function readGrokTurnCompleted(update: Record<string, unknown>, counts: GrokFailureCounts): boolean {
  counts.turnCompletions += 1;
  const stop = typeof update.stop_reason === 'string' ? update.stop_reason : '';
  if (stop) counts.lastStopReason = stop;
  // 重试按「出现在哪条 turn_completed 之前」归属到轮次（第 256 轮）。
  attributePendingRetries(counts, stop);
  if (stop === 'error') {
    counts.errors += 1;
    return true;
  }
  if (stop === 'cancelled') {
    counts.cancelled += 1;
    return true;
  }
  if (stop && !KNOWN_STOP_REASONS.has(stop)) bump(counts.unknownStops, stop);
  return false;
}

/** 最后一条轮次结束记录是否以失败 / 中止收尾。 */
export function grokTailFailed(counts: GrokFailureCounts): boolean {
  return counts.lastStopReason === 'error' || counts.lastStopReason === 'cancelled';
}

/**
 * 读一条 `retry_state`。`reason` 是自由文本、含上游端点，**只认 `error_type` 这个枚举**；
 * `error_type` 缺失或不是字符串时归到「（未标注类型）」。
 */
export function readGrokRetryState(update: Record<string, unknown>, counts: GrokFailureCounts): void {
  counts.retries += 1;
  counts.pendingRetries += 1;
  const kind = typeof update.error_type === 'string' && update.error_type.trim() ? update.error_type.trim() : '（未标注类型）';
  bump(counts.retryClasses, kind);
  if (update.type === 'failed') {
    counts.retryFailed += 1;
    counts.pendingRetryFailed += 1;
  }
}

/** 扫描结束后调用：末尾没有 `turn_completed` 的重试只能算「没有轮次结束记录」，不归属给任何轮。 */
export function finalizeGrokRetryAttribution(counts: GrokFailureCounts): void {
  counts.trailingRetries = counts.pendingRetries;
  counts.pendingRetries = 0;
  counts.pendingRetryFailed = 0;
}

function describeCountMap(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${escapeControlChars(key)} × ${count}`)
    .join('、');
}

/** 会话级失败披露；没有任何失败 / 中止 / 重试 / 未知结束原因时返回 `null`（健康会话不多嘴）。
 *
 * `tailUnanswered` 由调用方核对后传入（最后一个 `turn_completed` 是失败 / 中止**且**
 * 解析结果停在用户轮上）。Grok 的 parse 必须跳过空助手行（重放去重依赖它），所以这里
 * 不能像 Claude / Pi 那样补一个空正文助手轮来承载披露——写回去会被自家 parse 丢掉，
 * Grok → Grok 的 round-trip 会直接失败。改为在披露里点明尾部失败，让读者先看到真原因，
 * 后面的「可能被中断或还在生成」只是兜底句。
 */
export function describeGrokFailures(counts: GrokFailureCounts, tailUnanswered = false): string | null {
  const parts: string[] = [];
  if (counts.errors > 0 || counts.cancelled > 0) {
    const pieces: string[] = [];
    if (counts.errors > 0) pieces.push(`请求失败 ${counts.errors} 轮`);
    if (counts.cancelled > 0) pieces.push(`用户中止 ${counts.cancelled} 轮`);
    parts.push(`Grok 日志记录了 ${pieces.join('、')}`);
  }
  if (tailUnanswered) {
    parts.push('其中最后一轮没有写成助手回复：这一轮以失败 / 中止结束，不是仍在生成');
  }
  if (counts.retries > 0) {
    const failed = counts.retryFailed > 0 ? `，其中 ${counts.retryFailed} 次已耗尽重试` : '';
    let line = `另有 ${counts.retries} 次自动重试（${describeCountMap(counts.retryClasses)}${failed}）`;
    if (counts.retryTurns > 0) {
      const bits = [`单轮最多 ${counts.maxRetriesInTurn} 次`];
      if (counts.retryTurnsRecovered > 0) bits.push(`${counts.retryTurnsRecovered} 轮重试后成功`);
      if (counts.retryTurnsExhausted > 0) bits.push(`${counts.retryTurnsExhausted} 轮以耗尽重试收尾`);
      line += `；这些重试分布在 ${counts.retryTurns} 轮里（${bits.join('，')}）`;
    }
    if (counts.trailingRetries > 0) {
      line += `；末尾另有 ${counts.trailingRetries} 次重试没有对应的轮次结束记录`;
    }
    parts.push(line);
  }
  if (counts.unknownStops.size > 0) {
    parts.push(`另有 ${describeCountMap(counts.unknownStops)} 轮未识别的结束原因，Watch 暂不解析`);
  }
  if (parts.length === 0) return null;
  const tail = counts.errors > 0 || counts.cancelled > 0
    ? '；失败与中止原因以原生日志为准，Watch 不复制上游错误原文；接手前请先在原生 Grok 中确认这些轮次是否需要重试'
    : '';
  return `${parts.join('；')}${tail}`;
}

/** 披露事件；`summary` 截到一行，`detail` 保留全句（findContextDisclosure 优先消费 detail）。 */
export function grokFailureDisclosure(
  counts: GrokFailureCounts,
  timestamp: string,
  tailUnanswered = false,
): ProcessEvent | null {
  const text = describeGrokFailures(counts, tailUnanswered);
  if (!text) return null;
  return {
    kind: 'text',
    timestamp,
    summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${clipCodePoints(text, 120).text}]`,
    detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text}]`,
    provider: 'grok',
    // 结构化标记：`describeUnansweredTail()` 据此把「可能还在生成」换成已确认的失败 / 中止。
    ...(tailUnanswered
      ? { tailFailure: counts.lastStopReason === 'cancelled' ? ('cancelled' as const) : ('error' as const) }
      : {}),
  };
}

/**
 * 逐轮用量对不上时的披露（与失败分开说）。
 *
 * 逐轮用量只在「`turn_completed` 条数 = 助手轮条数」时才挂：数量不等就按顺序硬套会把
 * 第 N 轮的用量挂到别人头上，所以宁可不填。但**不填要说**——否则目标会话里每轮都是 0/0，
 * 而 `watch open` 的 note 还写着「来源 Grok 用量 …（已在对账中携带）」，两处口径互相矛盾。
 */
export function grokUsageMismatchDisclosure(
  turnCompletions: number,
  assistants: number,
  timestamp: string,
): ProcessEvent | null {
  if (turnCompletions === 0 || assistants === 0 || turnCompletions === assistants) return null;
  const text =
    `Grok 日志里有 ${turnCompletions} 条轮次结束记录，但解析出 ${assistants} 个助手轮，数量对不上：` +
    `逐轮用量无法对应，这次交接不携带逐轮用量（会话合计用量仍会单独列出）；` +
    `不按顺序硬套是为了避免把某一轮的用量挂到另一轮头上。`;
  return {
    kind: 'text',
    timestamp,
    summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${clipCodePoints(text, 120).text}]`,
    detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text}]`,
    provider: 'grok',
  };
}
