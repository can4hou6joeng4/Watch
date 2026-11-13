import { escapeControlChars } from '../../core/display.js';
import { WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import type { ProcessEvent } from '../../core/types.js';

/**
 * Pi 的失败 / 中止记录（2026-11-13，第八十一轮）。
 *
 * 上游契约：`@earendil-works/pi-ai` 的 `AssistantMessage` 带 `stopReason: StopReason`
 * 与 `errorMessage?: string`，`StopReason` 为
 * `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`。
 * `error` 表示这次请求最终失败（pi 自己重试完之后才写），`aborted` 是用户中止或
 * 进程收尾，`length` 是输出被 maxTokens 截断。
 *
 * 本机 29 条真实会话只读采样（未输出、未保留任何正文）：
 * - `stopReason: "error"` 217 条，全部带字符串 `errorMessage`；209 条 content 为空数组，
 *   8 条带 thinking / text / toolCall（失败前已有部分输出）。
 * - `stopReason: "aborted"` 10 条，content 全部为空。
 * - 错误文本以 HTTP 状态码开头 48 条（404 / 429 / 503 等），`Connection …` 118 条，
 *   `Request …` 34 条，`This operation was aborted` 5 条，其余零散。
 * - `errorMessage` 中 44 条含 `{`/`}`、48 条含引号——直接复制进披露会把上游响应片段
 *   带进目标会话，所以这里只保留分类与次数，不保留原文。
 *
 * Watch 以前完全不读这两个字段：空 content 的失败记录被建成空轮，而写入侧
 * （`importTurnsToPi`）与 `assertRoundTrip` 的 wanted 过滤都跳过「无正文且无事件」的轮次，
 * 含失败记录的会话导入 pi 时 round-trip 直接失败（合成复现：期望 3 实得 4）；
 * 失败原因也整份消失，下游只会说「最后停在用户消息上，可能被中断或还在生成」。
 */
export type PiFailureCounts = {
  /** `stopReason: "error"` 的条数（含失败前已有部分输出的记录） */
  errors: number;
  /** 失败前已产生正文 / 思考 / 工具调用的错误记录条数 */
  errorsWithContent: number;
  /** 错误分类 → 次数（`HTTP 429` / `连接错误` / `请求被拒绝` / `请求被中止` / `（未分类）`） */
  errorClasses: Map<string, number>;
  /** `stopReason: "aborted"` 的条数 */
  aborted: number;
  /** 中止的原因分类 → 次数 */
  abortedClasses: Map<string, number>;
  /** `stopReason: "length"`：输出达到长度上限被截断 */
  truncated: number;
  /** `error` / `aborted` 但 `errorMessage` 不是非空字符串 */
  withoutMessage: number;
  /** 未识别的 `stopReason` → 次数；已知终态不进这里 */
  unknownStops: Map<string, number>;
};

/** 已知的 `StopReason` 终态：不产生失败披露。 */
const KNOWN_STOP_REASONS = new Set(['stop', 'toolUse', 'length', 'error', 'aborted', 'pending', 'deferred']);

export function createPiFailureCounts(): PiFailureCounts {
  return {
    errors: 0,
    errorsWithContent: 0,
    errorClasses: new Map(),
    aborted: 0,
    abortedClasses: new Map(),
    truncated: 0,
    withoutMessage: 0,
    unknownStops: new Map(),
  };
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/**
 * 错误文本 → 稳定的分类标签。只认结构，不读语义：
 * HTTP 状态码取数字；连接 / 请求被拒 / 被中止按 pi-ai 自己的固定前缀归类；
 * 其余统一 `（未分类）`——宁可说得少，也不把可能带请求细节的原文带出去。
 */
function classifyFailureMessage(message: string): string {
  const trimmed = message.trim();
  const status = /^(\d{3})\b/.exec(trimmed);
  if (status) return `HTTP ${status[1]}`;
  if (/^connection\b/i.test(trimmed)) return '连接错误';
  if (/^this operation was aborted/i.test(trimmed)) return '请求被中止';
  if (/^request\b/i.test(trimmed)) return '请求被拒绝';
  return '（未分类）';
}

/**
 * 读一条 assistant 消息的结束原因。返回 `null` 表示不是失败类记录。
 * `hasContent` 由调用方从已解析的正文 / 事件判断：失败前已有部分输出时，
 * 这一轮仍会作为助手轮保留，披露里要能看出来。
 */
export function readPiStopReason(
  message: Record<string, unknown>,
  counts: PiFailureCounts,
  hasContent: boolean,
): 'error' | 'aborted' | 'truncated' | null {
  const stop = typeof message.stopReason === 'string' ? message.stopReason : '';
  if (stop === 'error') {
    counts.errors += 1;
    if (hasContent) counts.errorsWithContent += 1;
    const raw = message.errorMessage;
    if (typeof raw === 'string' && raw.trim()) {
      bump(counts.errorClasses, classifyFailureMessage(raw));
    } else {
      counts.withoutMessage += 1;
      bump(counts.errorClasses, '（没有错误说明）');
    }
    return 'error';
  }
  if (stop === 'aborted') {
    counts.aborted += 1;
    const raw = message.errorMessage;
    if (typeof raw === 'string' && raw.trim()) {
      bump(counts.abortedClasses, classifyFailureMessage(raw));
    } else {
      counts.withoutMessage += 1;
      bump(counts.abortedClasses, '（没有错误说明）');
    }
    return 'aborted';
  }
  if (stop === 'length') {
    counts.truncated += 1;
    return 'truncated';
  }
  if (stop && !KNOWN_STOP_REASONS.has(stop)) bump(counts.unknownStops, stop);
  return null;
}

function describeCountMap(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${escapeControlChars(key)} × ${count}`)
    .join('、');
}

/**
 * 会话级失败披露；没有任何失败 / 截断 / 未知结束原因时返回 `null`（健康会话不多嘴）。
 * 只写分类与次数，不复制 `errorMessage` 原文。
 */
export function describePiFailures(counts: PiFailureCounts): string | null {
  const parts: string[] = [];
  if (counts.errors > 0) {
    const partial = counts.errorsWithContent > 0 ? `，其中 ${counts.errorsWithContent} 条失败前已有部分输出` : '';
    parts.push(`Pi 请求失败：日志里有 ${counts.errors} 条记录（${describeCountMap(counts.errorClasses)}${partial}）`);
  }
  if (counts.aborted > 0) {
    parts.push(`${counts.aborted} 条请求被中止（${describeCountMap(counts.abortedClasses)}）`);
  }
  if (counts.truncated > 0) {
    parts.push(`${counts.truncated} 条回复因达到输出长度上限被截断，内容不完整`);
  }
  if (counts.unknownStops.size > 0) {
    parts.push(`另有 ${describeCountMap(counts.unknownStops)} 条未识别的结束原因，Watch 暂不解析`);
  }
  if (parts.length === 0) return null;
  const tail = counts.errors > 0 || counts.aborted > 0
    ? '；失败原因以日志记录为准，接手前请先在原生 Pi 中确认这一轮是否需要重试'
    : '';
  return `${parts.join('；')}${tail}`;
}

/** 披露事件；`summary` 截到一行，`detail` 保留全句（findContextDisclosure 优先消费 detail）。 */
export function piFailureDisclosure(counts: PiFailureCounts, timestamp: string): ProcessEvent | null {
  const text = describePiFailures(counts);
  if (!text) return null;
  return {
    kind: 'text',
    timestamp,
    summary: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text.slice(0, 120)}]`,
    detail: `${WATCH_CONTEXT_DISCLOSURE_PREFIX}${text}]`,
    provider: 'pi',
  };
}
