/**
 * Claude Code 的顶层 `attachment` 记录里，哪些是**真正的用户发言**。
 *
 * 依据 [Heeler 的 transcript 格式研究](https://github.com/ZingerLittleBee/Heeler/blob/main/docs/research/claude-code-transcript-format.md)：
 * 轮次进行中用户再次输入时，Claude Code 把这条消息写成一个
 * `attachment.type === 'queued_command'` 的顶层记录（`prompt`、`source_uuid`、`commandMode`、
 * `origin`、`imagePasteIds`），而不是一条 `type: 'user'` 记录；渲染给模型时包在
 * `<system-reminder>The user sent a new message while you were working: …</system-reminder>` 里。
 * SDK 的规则是「存在 `uuid == source_uuid` 的 user 记录时跳过这条附件」。
 *
 * 2026-11-12 本机只读采样（60 份真实 transcript，只看类型与字段）：19 条
 * `origin.kind === 'human'` 的 `queued_command` 没有对应 user 记录，其中多数文本只在
 * 这条附件里出现（少数「命中」是压缩摘要的转述，不是同一条消息）。Watch 以前把整类记录当
 * 未知类型丢掉，结果是**用户说过的话不在交接里**，而紧随其后的助手回复会被
 * `ensureAssistant()` 并进上一轮——读者看到助手回答了一个从未出现的问题。
 *
 * 只认人写的消息：`origin.kind === 'task-notification'`（后台任务完成）与其它
 * `commandMode` 是机器输入，做成用户轮会伪造用户发言。
 */

export type ClaudeQueuedPrompt = {
  text: string;
  timestamp: string;
  /** 用于对账的 user 记录 uuid；附件里可能没有 */
  sourceUuid: string | null;
  /** 随消息粘贴的图片数（记录里只有编号，没有图片数据） */
  imageCount: number;
};

const INLINE_IMAGE_PLACEHOLDER = /\[Image #\d+\]/g;

/** 从一行已解析记录里取「用户中途发来的消息」；不是这类记录返回 null。 */
export function readQueuedUserPrompt(record: unknown): ClaudeQueuedPrompt | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.type !== 'attachment' || r.isSidechain === true) return null;
  const a = r.attachment;
  if (typeof a !== 'object' || a === null) return null;
  const att = a as Record<string, unknown>;
  if (att.type !== 'queued_command') return null;
  const origin = att.origin;
  if (typeof origin !== 'object' || origin === null) return null;
  if ((origin as Record<string, unknown>).kind !== 'human') return null;
  // `commandMode: 'prompt'` 是人输入的提示；别的值（如 `task-notification`）是机器投递
  if (att.commandMode !== 'prompt') return null;
  const text = typeof att.prompt === 'string' ? att.prompt.trim() : '';
  const ids = Array.isArray(att.imagePasteIds) ? att.imagePasteIds.length : 0;
  const placeholders = text.match(INLINE_IMAGE_PLACEHOLDER)?.length ?? 0;
  const imageCount = Math.max(ids, placeholders);
  // 正文与图片都没有时没有任何可交接的内容，不造空轮
  if (!text && imageCount === 0) return null;
  return {
    text,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    sourceUuid: typeof att.source_uuid === 'string' && att.source_uuid ? att.source_uuid : null,
    imageCount,
  };
}

/**
 * 图片原图不在日志里（只有编号）：正文后面补一句，避免目标助手把 `[Image #N]` 当成
 * 真实可见的图片。措辞只说记录里有什么，不断言图片丢失的原因。
 */
export function describeQueuedImages(count: number): string {
  return `[这条消息在发送时带有 ${count} 张图片：会话记录里只有图片编号，没有图片数据，Watch 无法把它们带进交接；需要图片内容请回原生 Claude Code 查看]`;
}
