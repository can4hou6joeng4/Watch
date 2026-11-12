import { DatabaseSync } from 'node:sqlite';
import { escapeControlChars } from '../../core/display.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { PreflightBlockedError } from '../adapter.js';
import { opencodeDbPath, opencodeDbSqliteError, probeOpencodeDbFile } from './paths.js';

export type OpencodeRevert = { kind: 'active'; messageID: string; partID?: string } | { kind: 'unreadable' };

/**
 * 1.x 的 session.revert 是 JSON 文本。上游 v1.18.29 的 revert.ts 先登记回退点，
 * cleanup 才删除回退点及其之后的消息（有 partID 时保留该条消息、从该片段起删）；
 * 这段窗口内不能把库里的历史当成当前有效上下文。
 * 旧最小布局可能没有 session 表或 revert 列；查询失败仍抛错，不当作「没有回退」。
 */
export function readOpencodeRevert(db: DatabaseSync, sessionId: string): OpencodeRevert | null {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'revert')) return null;
  const row = db.prepare('SELECT revert FROM session WHERE id = ?').get(sessionId);
  const raw = row?.revert;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === 'null')) return null;
  const value = typeof raw === 'string' ? parseJsonObject(raw) : null;
  if (!value || typeof value.messageID !== 'string' || !value.messageID.trim() ||
      (value.partID !== undefined && (typeof value.partID !== 'string' || !value.partID.trim()))) {
    return { kind: 'unreadable' };
  }
  return { kind: 'active', messageID: value.messageID, ...(typeof value.partID === 'string' ? { partID: value.partID } : {}) };
}

/** 只披露，不裁剪正文、不复制 snapshot / diff；由既有上下文披露通道进入 prompt 和 warnings。 */
export function describeOpencodeRevert(state: OpencodeRevert): string {
  const reason = state.kind === 'active'
    ? `OpenCode 会话有 1 处尚未清理的回退标记（消息 ${escapeControlChars(state.messageID)}${state.partID ? `，消息片段 ${escapeControlChars(state.partID)}` : ''}）`
    : 'OpenCode 会话有 1 处回退状态无法解析，不能确认回退边界';
  return `${reason}；Watch 未按回退状态裁剪日志，本交接可能包含已回退的旧消息或消息片段，` +
    '不等同于 OpenCode 当前有效上下文；请在原生 OpenCode 中核对后再继续';
}

/** 预检与事务内共用：追加会被原生 cleanup 删除，replace 又不能擅自消除回退状态。 */
export function assertOpencodeTargetNotReverted(db: DatabaseSync, sessionId: string): void {
  const state = readOpencodeRevert(db, sessionId);
  if (!state) return;
  throw new PreflightBlockedError({
    code: state.kind === 'active' ? 'opencode_target_reverted' : 'opencode_revert_unreadable',
    message: `OpenCode 目标会话 ${escapeControlChars(sessionId)}${state.kind === 'active' ? '有尚未清理的回退标记，原生清理可能删除追加内容' : '的回退状态无法解析，不能确认写入是否安全'}；本次未写入任何内容`,
    hint: '本次未写入任何内容；请在原生 OpenCode 中核对并处理回退状态，或选择另一条目标会话。不要直接删除数据库或手工清除回退字段。',
    sessionId,
  });
}

/** 写路径以配置的数据库为准，预检只读；事务内还要再次检查，防止预检之后状态改变。 */
export async function checkOpencodeTargetRevert(sessionId: string): Promise<void> {
  const dbPath = opencodeDbPath();
  if (await probeOpencodeDbFile(dbPath) === 'missing') return;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw opencodeDbSqliteError(dbPath, '打开', error);
  }
  try {
    assertOpencodeTargetNotReverted(db, sessionId);
  } catch (error) {
    if (error instanceof PreflightBlockedError) throw error;
    throw opencodeDbSqliteError(dbPath, '查询', error);
  } finally {
    db.close();
  }
}
