import { stat } from 'node:fs/promises';
import path from 'node:path';
import { escapeControlChars } from '../../core/display.js';
import { describePathReadFailureReason, isMissingPathError } from '../../core/read-text.js';
import { WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';

/**
 * Claude Code 的「转入后台」记录（`continued-in`）。
 *
 * 依据 openai/codex @ e58bf8f5 的 `codex-rs/external-agent-migration`：`records_cla.rs` 在遇到
 * 顶层 `type: "continued-in"` 且 `continuedInSessionId` 非空时**整条会话跳过**，注释写明
 * 「Backgrounding replaces this session with a continuation that includes its history」；
 * `app-server/tests/suite/v2/external_agent_import_sync.rs` 的
 * `backgrounded_session_imports_only_its_continuation` 进一步证明：续接文件是旧文件的完整拷贝
 * 加上之后的对话，旧文件停在转入后台的那一刻。
 *
 * Watch 的立场不同：不替用户跳过整条会话（`open <id>` 是显式指名，静默换 id 会改写用户意图），
 * 但必须披露「你读到的是转入后台之前的快照」。披露做成 `WATCH_CONTEXT_DISCLOSURE_PREFIX` 文本
 * 事件，走既有的 prompt 头部 / handoff warnings / open warnings 管线，不改任何轮次正文
 * （`turnKey` 只由 role + text + callIds 组成，事件不参与增量对齐）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaudeContinuationCounts = {
  /** 带可用续接 id 的 `continued-in` 记录条数 */
  count: number;
  /** type 是 `continued-in` 但 id 缺失 / 为空 / 不是字符串的条数 */
  malformed: number;
  /** 最后一条可用记录的续接会话 id（已 trim）；没有可用记录时为 null */
  sessionId: string | null;
};

export type ClaudeContinuationTarget =
  | { kind: 'present'; filePath: string }
  | { kind: 'missing'; filePath: string }
  | { kind: 'not-file'; filePath: string }
  | { kind: 'unknown'; filePath: string; reason: string }
  | { kind: 'unlocatable' };

/** 从一行已解析记录里取 `continued-in` 事实；不是这类记录返回 null。 */
export function readContinuedInRecord(record: unknown): { sessionId: string | null } | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== 'continued-in') return null;
  const id = typeof r.continuedInSessionId === 'string' ? r.continuedInSessionId.trim() : '';
  return { sessionId: id || null };
}

/**
 * 纯文本扫描（给「不解析对话」的前置检查用，如官方导入的 prepare）：只看 `continued-in`
 * 记录本身，不解析消息内容、不复制任何正文。
 */
export function scanContinuedInRecords(raw: string): ClaudeContinuationCounts {
  const counts: ClaudeContinuationCounts = { count: 0, malformed: 0, sessionId: null };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const continued = readContinuedInRecord(record);
    if (!continued) continue;
    if (continued.sessionId) {
      counts.count += 1;
      counts.sessionId = continued.sessionId;
    } else {
      counts.malformed += 1;
    }
  }
  return counts;
}

async function probeTarget(sessionId: string, filePath: string): Promise<ClaudeContinuationTarget> {
  // 不是 UUID 形状的 id 不能直接拼文件名（可能带 `/` 或控制字符）：只披露，不去猜路径
  if (!UUID.test(sessionId)) return { kind: 'unlocatable' };
  const targetPath = path.join(path.dirname(filePath), `${sessionId}.jsonl`);
  try {
    const info = await stat(targetPath);
    if (!info.isFile()) return { kind: 'not-file', filePath: targetPath };
    return { kind: 'present', filePath: targetPath };
  } catch (error) {
    // 只有「路径不存在」才是 missing；其余读失败不能反过来讲成「没有」
    if (isMissingPathError(error)) return { kind: 'missing', filePath: targetPath };
    return { kind: 'unknown', filePath: targetPath, reason: describePathReadFailureReason(error) };
  }
}

/** 解析完轮次后调用：没有 `continued-in` 记录时返回 null。 */
export async function probeClaudeContinuation(
  counts: ClaudeContinuationCounts,
  filePath: string,
): Promise<{ counts: ClaudeContinuationCounts; target: ClaudeContinuationTarget | null } | null> {
  if (counts.count === 0 && counts.malformed === 0) return null;
  const target = counts.sessionId ? await probeTarget(counts.sessionId, filePath) : null;
  return { counts, target };
}

/**
 * 用户可见的披露文案。只断言能从日志证明的事实：
 * - 旧文件停在转入后台的那一刻（官方导入器的续接测试证明续接文件才含之后的对话）；
 * - 续接文件存在 / 不存在 / 读不出来分档说清，读不出来不写成「没有」；
 * - 不复制任何对话正文。
 */
export function describeClaudeContinuation(state: {
  counts: ClaudeContinuationCounts;
  target: ClaudeContinuationTarget | null;
}): string {
  const { counts, target } = state;
  if (counts.sessionId === null) {
    return (
      `${WATCH_CONTEXT_DISCLOSURE_PREFIX}这条 Claude Code 会话的日志里有 ${counts.malformed} 条转入后台记录` +
      '（continued-in），但都没有可用的续接会话 id；Watch 无法确认后续内容在哪，本文件可能停在转入后台的那一刻，' +
      '之后的进展不在其中]'
    );
  }
  const id = escapeControlChars(counts.sessionId);
  const count =
    counts.count > 1
      ? `日志里有 ${counts.count} 条转入后台记录，最后一次指向续接会话 ${id}`
      : `日志里有一条转入后台记录，指向续接会话 ${id}`;
  let next: string;
  switch (target?.kind) {
    case 'present':
      next =
        `续接会话文件 ${escapeControlChars(target.filePath)} 存在，里面是转出前的完整历史加上之后的对话；` +
        `要交接最新状态请改用那条会话（watch open ${id} / watch prompt ${id}）`;
      break;
    case 'missing':
      next =
        `续接会话文件 ${escapeControlChars(target.filePath)} 现在不存在（可能被移走或删除）；` +
        'Watch 无法确认后续内容在哪，要交接最新状态请先在原生 Claude Code 里确认那条会话';
      break;
    case 'not-file':
      next =
        `续接会话的位置 ${escapeControlChars(target.filePath)} 现在不是普通文件（可能被同名目录或设备文件占住）；` +
        'Watch 无法读取后续内容，先恢复该路径再重试';
      break;
    case 'unknown':
      next = `无法确认续接会话文件 ${escapeControlChars(target.filePath)} 是否存在：${target.reason}；先修好这个路径再重试`;
      break;
    case 'unlocatable':
      next = '记录里的续接会话 id 不是标准 UUID 形状，Watch 没有去定位它的文件；后续内容可能在别的会话里，请先在原生 Claude Code 里核对';
      break;
    default:
      next = 'Watch 无法确认后续内容在哪，请先在原生 Claude Code 里核对';
      break;
  }
  return (
    `${WATCH_CONTEXT_DISCLOSURE_PREFIX}这条 Claude Code 会话被转入后台过：${count}；` +
    `本文件的内容停在转入后台的那一刻，之后的进展不在其中。${next}]`
  );
}
