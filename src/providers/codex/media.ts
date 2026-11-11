import type { ProcessEvent } from '../../core/types.js';

/** 用户消息在记录里没有任何可读正文时的兜底；parse 与 round-trip 期望共用同一句。 */
export const CODEX_EMPTY_USER_TEXT = '[本条用户消息在 Codex 记录里没有可读的文字正文]';

/**
 * Codex `response_item.message.content` 里的媒体引用（官方 `ImageReference` / `AudioReference`：
 * `{ image_url }` | `{ file_id }`、`{ audio_url }` | `{ file_id }`）。
 *
 * parse 与 build 必须共用这一份判定，否则 write→parse 的 round-trip 会在占位文本上分叉：
 * 「这里有张图、数据带得走」与「只有不透明引用、读不到原图」是两种结论，披露也必须不同。
 * `file_id` 是 Codex 自己的不透明句柄，rollout 里没有原始数据，Watch 无从解析。
 */
export type CodexMediaRef =
  | { kind: 'inline'; mediaType: string; data: string }
  | { kind: 'url'; url: string }
  /** 记录里有这一项，但原始数据不可达（file_id / 非 data URI 的其它链接 / 缺字段） */
  | { kind: 'unreadable'; placeholder: string };

type MediaKind = 'image' | 'audio';

const LABEL: Record<MediaKind, string> = { image: '图片', audio: '音频' };

/** data URI → mediaType + base64；不是 base64 data URI 返回 null（http(s) 走 url 分支） */
export function parseDataUri(uri: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(uri);
  return m ? { mediaType: m[1]!, data: m[2]! } : null;
}

function fromUrl(raw: string, media: MediaKind, field: string): CodexMediaRef {
  const inline = parseDataUri(raw);
  if (inline) return { kind: 'inline', mediaType: inline.mediaType, data: inline.data };
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', url: raw };
  return {
    kind: 'unreadable',
    placeholder: `[${LABEL[media]}：记录里的 ${field} 不是 data URI 或 http(s) 链接，Watch 读不到原始数据]`,
  };
}

/**
 * 官方 content item → 媒体引用；`null` 表示这一项根本不是可识别的媒体项。
 *
 * `file_id` 分支刻意不产事件：把不透明句柄写进 attachment 会让 `describeAttachmentLoss()`
 * 以为「图片带过去了」，实际目标侧只拿到一个它在自己机器上解析不了的 id。
 */
export function codexMediaRefFromContentItem(
  b: Record<string, unknown>,
  media: MediaKind,
): CodexMediaRef | null {
  const field = media === 'image' ? 'image_url' : 'audio_url';
  const raw = b[field];
  if (media === 'image' ? b.type !== 'input_image' : b.type !== 'input_audio') return null;
  if (typeof raw === 'string' && raw) return fromUrl(raw, media, field);
  const idField = 'file_id' in b && typeof b.file_id === 'string' && b.file_id;
  if (idField) {
    return {
      kind: 'unreadable',
      placeholder: `[${LABEL[media]}：Codex 只记录了 file_id 引用，原始数据不在 rollout 里]`,
    };
  }
  return { kind: 'unreadable', placeholder: `[${LABEL[media]}（记录里没有可读的引用字段）]` };
}

/** 统一时间线的 attachment → 媒体引用（build 侧）；无数据可写时返回 null。 */
export function codexMediaRefFromAttachment(a: ProcessEvent['attachment']): CodexMediaRef | null {
  if (!a) return null;
  if (a.data) return { kind: 'inline', mediaType: a.mediaType ?? 'image', data: a.data };
  if (a.url) {
    const media: MediaKind = a.kind === 'image' ? 'image' : 'audio';
    const inline = parseDataUri(a.url);
    if (inline) return { kind: 'inline', mediaType: inline.mediaType, data: inline.data };
    if (/^https?:\/\//i.test(a.url)) return { kind: 'url', url: a.url };
  }
  return null;
}

export function codexMediaPlaceholder(ref: CodexMediaRef, media: MediaKind): string {
  if (ref.kind === 'unreadable') return ref.placeholder;
  if (ref.kind === 'inline') return `[${LABEL[media]}：${ref.mediaType}，${ref.data.length}B]`;
  return media === 'image' ? '[图片：image（外部链接）]' : '[音频（外部链接）]';
}

/** 解析侧事件：inline / url 才挂 attachment，unreadable 只留正文占位。 */
export function codexMediaAttachment(ref: CodexMediaRef, media: MediaKind): NonNullable<ProcessEvent['attachment']> | null {
  if (ref.kind === 'inline') {
    return media === 'image'
      ? { kind: 'image', mediaType: ref.mediaType, data: ref.data }
      : { kind: 'file', mediaType: ref.mediaType, data: ref.data };
  }
  if (ref.kind === 'url') {
    return media === 'image'
      ? { kind: 'image', mediaType: 'image', url: ref.url }
      : { kind: 'file', url: ref.url, filename: 'audio' };
  }
  return null;
}

/**
 * 写出侧 content item。Codex 的 `input_image` / `input_audio` 都只接受 URL 形状，
 * 所以只有 inline（重新拼成 data URI）与 http(s) 两种能写；`unreadable` 返回 null。
 */
export function codexMediaContentItem(ref: CodexMediaRef, media: MediaKind): Record<string, unknown> | null {
  const field = media === 'image' ? 'image_url' : 'audio_url';
  if (ref.kind === 'inline') return { type: media === 'image' ? 'input_image' : 'input_audio', [field]: `data:${ref.mediaType};base64,${ref.data}` };
  if (ref.kind === 'url') return { type: media === 'image' ? 'input_image' : 'input_audio', [field]: ref.url };
  return null;
}

/**
 * 用户轮附件 → Codex content item，或写不进去时的降级文本。
 *
 * **只写 `input_image`**：官方 `ContentItem` 虽然也有 `input_audio`，但 CLI 没有暴露任何音频
 * 入口（`--image` 有、`--audio` 没有），运行时还要目标模型声明支持音频才会真正消费它。
 * Watch 不替目标模型做这个判断，也不写一条自己没验证过的块类型；音频与其它文件附件
 * 一律落成正文说明，由 `describeAttachmentLoss()` 按目标能力披露（读入侧仍会识别
 * `input_audio` 并作为 file 附件过链，转去 OpenCode 时能带过去）。
 * build 与 `expectCodexRoundTrip` 共用这一函数，写出的文本与 round-trip 期望才不会分叉。
 */
export function codexUserMediaContent(
  attachment: NonNullable<ProcessEvent['attachment']>,
): { item: Record<string, unknown> } | { note: string } {
  if (attachment.kind !== 'image') {
    const label = attachment.filename ?? attachment.mediaType ?? '未知类型';
    return {
      note: `[文件附件 ${label} 没有写入 Codex：写入侧只还原图片块，没有通用文件块]`,
    };
  }
  const ref = codexMediaRefFromAttachment(attachment);
  const item = ref ? codexMediaContentItem(ref, 'image') : null;
  if (item) return { item };
  return { note: '[图片附件没有写入 Codex：原始数据不是 base64 或 http(s) 链接]' };
}

/** 写不进去的附件在正文里的降级文本（供 round-trip 期望复用）；能写出时返回 null。 */
export function codexUserMediaNote(attachment: NonNullable<ProcessEvent['attachment']>): string | null {
  const content = codexUserMediaContent(attachment);
  return 'note' in content ? content.note : null;
}

/**
 * 用户轮 → 写出的 content 组成（`texts` 为 `input_text` 块，`items` 为媒体块）。
 *
 * **写出与 round-trip 期望必须共用这一份**：parse 把多个 `input_text` 块按 `\n\n` 拼回正文、
 * 把媒体块反解成带 attachment 的 text 事件（不并进正文）；只要两侧都从同一函数派生，
 * 期望文本就不会与真读回来的文本分叉。正文为空时补附件占位（不够再补
 * `CODEX_EMPTY_USER_TEXT`），否则纯图片轮写出的内容里没有任何文本，parse 侧只会给占位。
 */
export function codexUserTurnContent(turn: {
  role: string;
  text: string;
  events?: ProcessEvent[];
}): { texts: string[]; items: Record<string, unknown>[] } {
  const texts: string[] = [];
  const items: Record<string, unknown>[] = [];
  if (turn.role !== 'user') return { texts, items };
  if (turn.text.trim()) texts.push(turn.text);
  const attachments = (turn.events ?? []).filter((e) => e.kind === 'text' && e.attachment);
  for (const ev of attachments) {
    const media = codexUserMediaContent(ev.attachment!);
    if ('item' in media) items.push(media.item);
    else texts.push(media.note);
  }
  if (texts.length === 0) {
    const placeholders = attachments
      .map((e) => codexUserMediaPlaceholder(e.attachment!))
      .filter((p): p is string => p !== null);
    texts.push(placeholders.join('\n') || CODEX_EMPTY_USER_TEXT);
  }
  return { texts, items };
}

/**
 * 附件在「正文为空」时用作正文的占位。与 parse 的 `emptyUserTurnText` 同一口径：
 * 写得出原生块 → 图片占位；写不出 → 与 note 同文（build 作为 input_text 写入）。
 */
export function codexUserMediaPlaceholder(attachment: NonNullable<ProcessEvent['attachment']>): string | null {
  const content = codexUserMediaContent(attachment);
  if ('note' in content) return content.note;
  const ref = codexMediaRefFromAttachment(attachment);
  return ref ? codexMediaPlaceholder(ref, 'image') : null;
}
