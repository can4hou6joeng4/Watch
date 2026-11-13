import { escapeControlChars } from '../../core/display.js';
import { WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import type { ProcessEvent } from '../../core/types.js';

/**
 * Claude Code 的失败记录（2026-11-13，第八十轮）。
 *
 * 本机 64 条真实会话只读采样（未保留任何正文）确认两族形状，都可以在没有助手回复的情况下
 * 结束一轮对话：
 *
 * ① 顶层 `system` + `subtype: "api_error"`（59 条）：`error.status` 是 HTTP 状态码
 *    （503 49 条、429 10 条），`retryAttempt` / `maxRetries` 记录重试进度，44 条会话
 *    以「用户轮 + 尾部 api_error」收尾，其中 2 条走到 10/10 重试耗尽。
 * ② `type: "assistant"` + `isApiErrorMessage: true`（269 条）：`message.model` 是
 *    `"<synthetic>"`，正文以 `API Error: …` 开头，usage 全 0。259 条后接下一次提问、
 *    10 条在会话末尾；按「助手正文取最后一条非空」的旧规则，236 轮里这句错误行成了
 *    「最终答复」，29 轮还覆盖了真正的回复。
 *
 * 两族都不复制错误正文：读者需要知道「这一轮失败、原因类别是什么」，不需要把上游
 * 的响应体搬进目标会话（`formatted` / `message` 里可能带请求细节）。
 */

export type ClaudeFailureCounts = {
  /** `system` / `api_error` 记录条数 */
  apiErrors: number;
  /** `error.status` → 次数；缺失记 `（无状态码）` */
  apiStatuses: Map<string, number>;
  /** `retryAttempt === maxRetries` 的条数（真正耗尽） */
  exhausted: number;
  /** `isApiErrorMessage: true` 的 assistant 记录条数 */
  synthetics: number;
  /** `apiErrorStatus` → 次数 */
  syntheticStatuses: Map<string, number>;
  /** 未识别的 `system.subtype` → 次数；已知记账子类型不进这里 */
  unknownSystem: Map<string, number>;
};

/** 已知的 `system` 记账子类型：与失败无关，也不需要披露。 */
const KNOWN_SYSTEM_SUBTYPES = new Set([
  'turn_duration',
  'compact_boundary',
  'scheduled_task_fire',
  'away_summary',
  'local_command',
  'informational',
  'model_refusal_fallback',
]);

export function createClaudeFailureCounts(): ClaudeFailureCounts {
  return {
    apiErrors: 0,
    apiStatuses: new Map(),
    exhausted: 0,
    synthetics: 0,
    syntheticStatuses: new Map(),
    unknownSystem: new Map(),
  };
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** 读一条 `system` 记录；返回是否为 `api_error`。未知子类型按类型计数。 */
export function readClaudeSystemRecord(record: Record<string, unknown>, counts: ClaudeFailureCounts): boolean {
  const subtype = typeof record.subtype === 'string' ? record.subtype : '';
  if (subtype !== 'api_error') {
    if (!subtype) bump(counts.unknownSystem, '（无子类型）');
    else if (!KNOWN_SYSTEM_SUBTYPES.has(subtype)) bump(counts.unknownSystem, subtype);
    return false;
  }
  counts.apiErrors += 1;
  const error = record.error;
  const status = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as { status?: unknown }).status
    : undefined;
  bump(counts.apiStatuses, typeof status === 'number' ? String(status) : '（无状态码）');
  const attempt = typeof record.retryAttempt === 'number' ? record.retryAttempt : null;
  const max = typeof record.maxRetries === 'number' ? record.maxRetries : null;
  if (attempt !== null && max !== null && attempt >= max) counts.exhausted += 1;
  return true;
}

/** 读一条 `isApiErrorMessage` 记录（`apiErrorStatus` 是 HTTP 状态码）。 */
export function recordClaudeSyntheticError(record: Record<string, unknown>, counts: ClaudeFailureCounts): void {
  counts.synthetics += 1;
  const status = record.apiErrorStatus;
  bump(counts.syntheticStatuses, typeof status === 'number' ? String(status) : '（无状态码）');
}

function describeCountMap(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${escapeControlChars(key)} × ${count}`)
    .join('、');
}

/**
 * 会话级失败披露；没有任何失败记录时返回 `null`（健康会话不多嘴）。
 * 只写数量、状态码与重试进度，不复制 `error.message` / `formatted` / 错误正文。
 */
export function describeClaudeFailures(counts: ClaudeFailureCounts): string | null {
  const parts: string[] = [];
  if (counts.apiErrors > 0) {
    const exhausted = counts.exhausted > 0 ? `，其中 ${counts.exhausted} 条已重试耗尽` : '';
    parts.push(
      `Claude API 请求失败：日志里有 ${counts.apiErrors} 条记录（HTTP 状态：${describeCountMap(counts.apiStatuses)}${exhausted}）`,
    );
  }
  if (counts.synthetics > 0) {
    parts.push(
      `${counts.synthetics} 条助手记录是 Claude Code 写下的机器错误行（HTTP 状态：${describeCountMap(counts.syntheticStatuses)}），` +
        '已按失败保留，没有被当作助手回复',
    );
  }
  if (counts.unknownSystem.size > 0) {
    parts.push(`另有 ${describeCountMap(counts.unknownSystem)} 条未识别的 system 记账记录，Watch 暂不解析`);
  }
  if (parts.length === 0) return null;
  const tail = counts.apiErrors > 0 || counts.synthetics > 0
    ? '；失败原因以日志记录为准，接手前请先在原生 Claude Code 中确认这一轮是否需要重试'
    : '';
  return `${parts.join('；')}${tail}`;
}

/** 披露事件；`summary` 截到一行，`detail` 保留全句（findContextDisclosure 优先消费 detail）。 */
export function claudeFailureDisclosure(counts: ClaudeFailureCounts, timestamp: string): ProcessEvent | null {
  const text = describeClaudeFailures(counts);
  if (!text) return null;
  return {
    kind: 'text',
    timestamp,
    summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text.slice(0, 120)}]`,
    detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text}]`,
    provider: 'claude',
  };
}
