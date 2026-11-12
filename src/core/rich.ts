import type { ProcessEvent, UnifiedTurn } from './types.js';

export const ENCRYPTED_THINKING = '思考中…（加密）';

/**
 * Claude 写出侧的 thinking 降级前缀：Claude 原生 thinking 块必须带 signature，
 * Watch 伪造会直接破坏 `claude --resume`，因此只能写成带此前缀的普通文本记录。
 * build 写、parse 读同一常量，保证 Watch 自己的往返不丢 thinking。
 */
export const CLAUDE_THINKING_PREFIX = '[思考] ';

/**
 * Claude Code 在压缩上下文时，会把压缩摘要写成一条 `type: "user"` + `isCompactSummary: true`
 * 的记录（实测 SSE 版本的字段也一致）。它在时间线上长得和用户消息一模一样：`role` 是 user、
 * 内容是一大段叙述。不标出来时，这段由模型 / 客户端生成的摘要会在 `watch prompt` 文档与转入
 * 目标会话的记录里都变成「用户说过的话」——目标助手据此把机器总结当成用户指令，而原文作者
 * 根本没写过这段。
 *
 * 标在**正文里**而不是元信息里：prompt 文档会被复制走，转入目标会话的也是这段文本本身，
 * 只有跟着文本走才到得了读者眼前。措辞不写「原始记录已删除」——Claude Code 的会话文件仍保留
 * 压缩前的轮次，这里只声明这段文字的来源。
 */
export const CLAUDE_COMPACT_SUMMARY_PREFIX = '[Claude Code 上下文压缩摘要：由 Claude Code 生成，不是用户原话]';

/**
 * OpenCode 2.x 的压缩摘要是 `session_message.type = "compaction"` 事件，`parse` 把它写成
 * 挂在轮次上的文本事件（`kind: 'text'`）。前缀与 Claude 侧同一用途：既是给读者看的来源声明，
 * 也是 `watch prompt --since-compact` 认边界的唯一痕迹（不猜文本形状）。
 */
export const OPENCODE_COMPACTION_SUMMARY_PREFIX = '[压缩摘要（由 OpenCode 生成，不是用户原话）]';

/**
 * Pi 的压缩摘要不是一条 message，而是会话文件里独立的 `type: "compaction"` 条目
 * （`summary` / `firstKeptEntryId` / `tokensBefore`），pi 自己会把它作为摘要消息注入上下文。
 * Watch 以前只解析 `type: "message"`，整段摘要无声消失——转入别家后，压缩前的原文还在，
 * 但 pi 当时的总结没了。这里把它还原成一轮带前缀的用户消息，前缀同时是
 * `watch prompt --since-compact` 认边界的唯一痕迹（与 Claude / OpenCode 同口径）。
 */
export const PI_COMPACTION_SUMMARY_PREFIX = '[Pi 上下文压缩摘要：由 Pi 生成，不是用户原话]';

/**
 * Pi 的 `type: "branch_summary"` 条目：用户切换分支时，pi 为被放弃的那条分支生成的总结，
 * 同样作为摘要消息进入上下文。标的理由与压缩摘要一致——它不是用户说过的话，但属于上下文。
 */
export const PI_BRANCH_SUMMARY_PREFIX = '[Pi 分支摘要：由 Pi 生成，不是用户原话；总结的是另一条分支]';

/**
 * Pi 的 `context_edit` / `custom_message` 条目不在 `parsePiSession()` 的还原范围内，但读者必须知道
 * 「这份交接的上下文与 Pi 现在发给模型的不一致」。披露以 **text 事件**挂在最后一轮上，而不是
 * 改写任何轮次的正文：`turnKey`（`handoff.ts`）只由 role + text + callIds 组成，事件不参与
 * 增量对齐——来源会话继续增长时，旧轮次的键不会因为计数变化而漂移（否则 `diffTurns` 会把旧轮次
 * 当成新增内容重复追加）。事件在各目标的写入侧去向不同：claude / codex 的 build 会把 text
 * 事件写成 assistant / commentary 文本，pi / grok / kimi / opencode 的 build 会丢弃，不能只靠
 * 事件把披露带进目标会话，所以 `buildHandoffPrompt()` 在选窗之前单独把它翻成正文的一行，
 * `handoff()` 同时把它放进 warnings。
 */
export const WATCH_CONTEXT_DISCLOSURE_PREFIX = '[Watch 交接披露：';

/** 汇总各轮独立的上下文披露；转存的旧声明不能遮住来源后来新增的声明。 */
export function findContextDisclosure(turns: UnifiedTurn[]): ProcessEvent | null {
  const messages = new Set<string>();
  let last: ProcessEvent | null = null;
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (event.kind !== 'text' || !event.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) continue;
      last = event;
      const text = event.detail?.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX) ? event.detail : event.summary;
      for (const message of text.split(/\n(?=\[Watch 交接披露：)/)) messages.add(message);
    }
  }
  if (!last) return null;
  const text = [...messages].join('\n');
  return { ...last, summary: text, detail: text };
}

export function turnHasContent(t: UnifiedTurn): boolean {
  return t.text.trim() !== '' || (t.events?.length ?? 0) > 0;
}

/** 解开 <user_query>...</user_query> 包裹（cc-sessions unwrap_user_query） */
export function unwrapUserQuery(text: string): string {
  const trimmed = text.trim();
  const m = /^<user_query>([\s\S]*)<\/user_query>$/.exec(trimmed);
  const inner = m?.[1]?.trim();
  return inner ? inner : text;
}

/** 判断是否为系统提醒消息（Kimi/Codex 会把 system-reminder 塞进 user prompt） */
export function isSystemReminder(text: string): boolean {
  const trimmed = text.trim();
  return /^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(trimmed);
}

/** 规范化用户消息文本：解包 user_query、过滤 system-reminder */
/** 剥离消息前部的 CLI 注入上下文块（Grok 的 user_info/rules、各家 system-reminder 等），返回剩余正文 */
function stripInjectedBlocks(text: string): string {
  let out = text;
  for (;;) {
    const m = /^\s*<(system-reminder|user_info|rules|environment_details|available_tools)>[\s\S]*?<\/\1>\s*/i.exec(out);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out.trim();
}

export function normalizeUserText(text: string): string | null {
  if (isSystemReminder(text)) return null;
  // Grok 真实输入形如 "<user_info>…</user_info>\n\n<rules>…</rules>\n\n<user_query>输入</user_query>"，
  // 先剥前缀注入块再解包，只留用户真正输入
  const unwrapped = unwrapUserQuery(stripInjectedBlocks(text));
  return unwrapped.trim();
}

export function textKey(t: UnifiedTurn): string {
  const body = unwrapUserQuery(t.text).trim();
  // 空正文助手工具轮如果只按 role+text 匹配，所有工具轮都会撞成同一把键而把 dest 独有轮误配给 source，
  // 从而丢掉 source 轮或覆盖 dest 独有轮；有正文的轮仍不拼 callId，保留「缺事件侧照文本补全」语义
  if (t.role === 'assistant' && !body) {
    const callIds = [...new Set((t.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id)))];
    if (callIds.length > 0) return `${t.role}\n\n${callIds.join(',')}`;
  }
  return `${t.role}\n${body}`;
}

/**
 * 按文本对齐合并：保留 dest 独有回合，source 过程事件更全则覆盖到对应 dest 回合，
 * 再接上 source 未匹配后缀。
 */
export function mergeTurns(source: UnifiedTurn[], dest: UnifiedTurn[]): UnifiedTurn[] {
  let si = 0;
  const out: UnifiedTurn[] = [];
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (textKey(source[i]!) === textKey(d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      const s = source[found]!;
      out.push((s.events?.length ?? 0) > (d.events?.length ?? 0) ? { ...d, events: s.events } : d);
      si = found + 1;
    } else {
      out.push(d);
    }
  }
  for (let i = si; i < source.length; i++) out.push(source[i]!);
  return out;
}

/**
 * 按 textKey 对齐后，**dest 回合缺少 source 过程事件**的回合数。
 *
 * `diffTurns` 用 turnKey（role + 文本 + callId）对齐：一轮同文本、但来源多出 thinking /
 * 过程文本（都不带 callId）的回复会被判成「目标已包含」而跳过，过程事件静默消失。
 * 这里是同一件事的计数版——`handoff` 用它决定是否整份重写；`open --from` 不能重写
 * （目标格式可能存不下这些事件，重写会在每次 `--from` 时反复发生），但必须据此披露。
 */
export function countPairedTurnsMissingEvents(source: UnifiedTurn[], dest: UnifiedTurn[]): number {
  if (dest.length === 0) return 0;
  let si = 0;
  let count = 0;
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (textKey(source[i]!) === textKey(d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      if ((source[found]!.events?.length ?? 0) > (d.events?.length ?? 0)) count += 1;
      si = found + 1;
    }
  }
  return count;
}

/** 对齐后的 dest 回合缺 source 的过程事件 → 必须整文件重写，不能追加到最终回复后面 */
export function shouldReplacePairedSession(source: UnifiedTurn[], dest: UnifiedTurn[]): boolean {
  return countPairedTurnsMissingEvents(source, dest) > 0;
}

export function toClaudeToolName(name: string): string {
  const n = name.toLowerCase();
  if (n === 'exec' || n === 'shell' || n === 'local_shell' || n === 'shell_command') return 'Bash';
  return name;
}

export function toCodexToolName(name: string): string {
  if (name === 'Bash' || name === 'bash') return 'exec';
  return name;
}

export function flattenToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item !== 'object' || item === null) return '';
        const o = item as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if ('content' in o) return flattenToolOutput(o.content);
        return '';
      })
      .join('');
  }
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}

/** 只认调用脚本的起始形状，shell 命令里提到 tools.exec_command 不等于已经包装。 */
export function isCodexExecScript(input: string): boolean {
  return /^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*(?:await\s+)?|await\s+)?tools\.exec_command\s*\(/.test(input);
}

/** 从已识别的 Codex exec 脚本中解码 JSON 字符串；无法解码时保留原脚本。 */
export function extractExecCommand(input: string): string {
  if (!isCodexExecScript(input)) return input;
  const cmds: string[] = [];
  const re = /tools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    try {
      cmds.push(JSON.parse(m[1]!) as string);
    } catch {
      return input; // 非 JSON 的 JS 字符串不猜解码，保留完整脚本供核对。
    }
  }
  return cmds.length ? cmds.join('\n') : input;
}

export function claudeBashInput(event: ProcessEvent): { command: string; description?: string } {
  const input = event.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') {
      return {
        command: obj.command,
        description: typeof obj.description === 'string' ? obj.description : event.summary,
      };
    }
  }
  const raw = typeof input === 'string' ? input : (event.detail ?? event.summary);
  return { command: extractExecCommand(raw) };
}

export function codexToolInput(event: ProcessEvent): string {
  if (typeof event.input === 'string') return event.input;
  if (event.input && typeof event.input === 'object' && !Array.isArray(event.input)) {
    const obj = event.input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
  }
  return event.detail ?? event.summary;
}

export function summarize(text: string, fallback: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * 合并连续 assistant 轮：部分 provider 的原生模型没有「连续 assistant 轮」概念
 * （grok parse 的 ensureAssistant 会把连续 assistant 行并回上一轮），导入这类目标前
 * 先在时间线侧收敛，否则写回全量、parse 合并导致 round-trip 不对称。
 * 文本按 parse 的拼接约定用空行连接，events 保持先后顺序。
 */
export function mergeConsecutiveAssistant(turns: UnifiedTurn[]): UnifiedTurn[] {
  const out: UnifiedTurn[] = [];
  for (const t of turns) {
    const prev = out.at(-1);
    if (t.role === 'assistant' && prev?.role === 'assistant') {
      prev.text = [prev.text, t.text].filter((s) => s.trim()).join('\n\n');
      if (t.events?.length) prev.events = [...(prev.events ?? []), ...t.events];
    } else {
      out.push({ ...t, events: t.events ? [...t.events] : undefined });
    }
  }
  return out;
}

export function stripEmptyEvents(turns: UnifiedTurn[]): UnifiedTurn[] {
  for (const t of turns) {
    if (t.events && t.events.length === 0) delete t.events;
  }
  return turns;
}

/**
 * 会话级 callId 去重：同一 callId 语义上就是一次调用，只保留首次出现。
 * resume 重放/fork 会让同一调用跨代再现（grok 尤甚，重复还会随链路切换在目标
 * 会话里持续增殖），且「写回全量、parse 去重」会让 round-trip 校验不对称——
 * 因此在导入边界统一收敛，无 callId 的事件不参与。
 */
export function dedupeCallEvents(turns: UnifiedTurn[]): UnifiedTurn[] {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  return turns.map((t) => {
    if (!t.events?.length) return t;
    let changed = false;
    const kept = t.events.filter((e) => {
      if (e.kind !== 'tool_call' && e.kind !== 'tool_result') return true;
      if (!e.callId) return true;
      const seen = e.kind === 'tool_call' ? seenCalls : seenResults;
      if (seen.has(e.callId)) {
        changed = true;
        return false;
      }
      seen.add(e.callId);
      return true;
    });
    return changed ? { ...t, events: kept } : t;
  });
}

/**
 * 有工具调用、却没有对应结果的 callId（按出现顺序去重）。
 *
 * 中断（Ctrl-C、用量耗尽）、工具还在跑、或 resume 重放了半截调用都会留下这种回合：
 * 内容照常可读，`diffTurns` 只比解析结果、round-trip 只比「写进去的内容」，两处都看不出
 * 那一轮是做了一半的。交接前必须主动披露，否则接手的一侧会以为任务停在这里就完了。
 */
export function danglingToolCalls(turns: UnifiedTurn[]): string[] {
  const called = new Set<string>();
  const finished = new Set<string>();
  for (const t of turns) {
    for (const e of t.events ?? []) {
      if (!e.callId) continue;
      if (e.kind === 'tool_call') called.add(e.callId);
      else if (e.kind === 'tool_result') finished.add(e.callId);
    }
  }
  return [...called].filter((id) => !finished.has(id));
}

/**
 * 交接前的披露文案（`open` 与 `switch` 共用一份措辞）：没有未完成的调用时返回 null。
 * `label` 由调用方给（「来源会话 <id>（<provider>）」/「会话 <id>（<provider>）」），
 * 两条路径各写一套会让同一件事在桌面端和 CLI 里说法不一致。
 *
 * `next` 只换最后那句后果 / 下一步，默认是「交接」的口径。**目标会话即将被 resume** 时
 * 没有交接发生（`open --from` 零增量、`open --to` 复用既有会话），照说「交接后那一轮不完整」
 * 会让人以为刚写进了一份不完整的内容——那种情况由调用方换一句。
 */
export function describeDanglingToolCalls(
  turns: UnifiedTurn[],
  label: string,
  next = '交接后那一轮不完整，先在原生 CLI 里确认再继续',
): string | null {
  const dangling = danglingToolCalls(turns);
  if (dangling.length === 0) return null;
  const shown = dangling.slice(0, 3).join(', ');
  return `${label}有 ${dangling.length} 次工具调用没有结果（callId: ${shown}${dangling.length > 3 ? ' 等' : ''}），可能在中断或仍在运行：${next}`;
}

/**
 * 目标格式没有附件块时，用户轮里每个附件在正文里留下的占位行（`[图片：image/png，1234B]`）。
 *
 * pi / kimi / grok 的 build 只搬 `turn.text`——纯图片用户轮的正文是空串，写出去后
 * parse 直接跳过这一轮（三家都要求 user 轮有正文），round-trip 于是报「turn 数不一致」
 * 把整次交接拒掉。按既有约定（codex 的 `CODEX_EMPTY_USER_TEXT`、claude 的非图片附件占位），
 * 占位要写进正文：`describeAttachmentLoss()` 已经承诺「只留占位文本」，那就得真的留下。
 *
 * 只取没进过正文的那部分——`turn.text` 里已经含同一行占位时不重复追加
 * （pi / claude 的 parse 把占位写进了正文）。
 */
export function attachmentPlaceholders(turn: UnifiedTurn): string[] {
  const out: string[] = [];
  for (const ev of turn.events ?? []) {
    if (ev.kind !== 'text' || !ev.attachment) continue;
    const text = (ev.detail ?? ev.summary ?? '').trim();
    if (!text || turn.text.includes(text)) continue;
    out.push(text);
  }
  return out;
}

/** 用户轮写进目标正文的实际文本：原正文 + 附件占位（没有附件时就是原正文） */
export function userTurnTextForWrite(turn: UnifiedTurn): string {
  const places = attachmentPlaceholders(turn);
  if (places.length === 0) return turn.text;
  return [turn.text.trim(), ...places].filter(Boolean).join('\n\n');
}

/**
 * 只有助手轮、没有用户轮的增量：pi / kimi / grok 的格式把助手回复挂在用户提问下，
 * 无法单独追加（claude / codex / opencode 可以）。必须报**这个**原因，而不是
 * 「没有可迁移的用户消息」——来源会话明明有用户消息，只是这次的增量里没有。
 *
 * 返回 `null` 表示可以写；否则给出面向用户的原因（各 build 在 into 分支直接抛）。
 */
export function assistantOnlyIncrementReason(turns: UnifiedTurn[]): string | null {
  const hasUser = turns.some((t) => t.role === 'user' && (t.text.trim() !== '' || attachmentPlaceholders(t).length > 0));
  const hasAssistant = turns.some((t) => t.role === 'assistant' && turnHasContent(t));
  if (hasUser || !hasAssistant) return null;
  return (
    '这次增量里只有助手回复、没有用户提问：pi / kimi / grok 的会话格式把助手回复挂在提问下面，' +
    '无法单独追加一条回复。请改用 watch open <来源会话 id> --to <其他 provider> 转到支持单独追加的 ' +
    'claude / codex / opencode，或先在来源里补一条提问后再交接'
  );
}

/**
 * 交接时附件能否跟着走。`assertRoundTrip` 只比 thinking / tool_call / tool_result，
 * `attachment` 挂在 text 事件上、不参与校验，于是「图片只留了占位文本」这条路径
 * 在三处防护里都看不出来：目标会话照常可读、round-trip 照常通过，只有原始数据没了。
 *
 * 判定用适配器自报的 `attachmentSupport`（缺省 = 一家都不带），文案同时说清
 * 「丢的是什么、目标侧还剩什么、要带附件该去哪里」，不写成「部分内容未同步」这种空话。
 */
export function describeAttachmentLoss(
  turns: UnifiedTurn[],
  target: { displayName: string; attachmentSupport?: 'images' | 'user-images' | 'all' },
): string | null {
  const support = target.attachmentSupport ?? 'none';
  if (support === 'all') return null;
  const lost = turns.flatMap((t) =>
    (t.events ?? []).filter((e) => {
      if (!e.attachment) return false;
      // `images` = 图片块能还原、文件类附件不能；`user-images` 再收窄到用户轮
      if (support === 'images') return e.attachment.kind !== 'image';
      if (support === 'user-images') return !(t.role === 'user' && e.attachment.kind === 'image');
      return true;
    }),
  );
  if (lost.length === 0) return null;
  const images = lost.filter((e) => e.attachment?.kind === 'image').length;
  const files = lost.length - images;
  const kinds = [images ? `${images} 张图片` : '', files ? `${files} 个文件附件` : ''].filter(Boolean).join('、');
  const keptNote =
    support === 'images'
      ? `${target.displayName} 只还原图片块，文件类附件只留占位文本`
      : support === 'user-images'
        ? `${target.displayName} 只还原用户轮的图片块，助手轮图片与文件类附件只留占位文本`
        : `${target.displayName} 的写入侧不还原附件的原始数据，只留占位文本`;
  return (
    `来源会话有 ${lost.length} 个附件（${kinds}）不会随这次交接保留：${keptNote}（如「[图片：image/png，1234B]」），` +
    `原始数据不落盘，也无法从目标会话里恢复；需要这些附件时先在来源里另存，或转到 OpenCode（图片与文件都能带）`
  );
}

/**
 * 无附件的过程文本不参与 round-trip 校验；按本次实际写入的轮次与目标能力披露。
 * 附件走 describeAttachmentLoss，上下文披露另进 warnings；正文已经包含的同文事件不重复报损失。
 */
export function describeTextEventLoss(
  turns: UnifiedTurn[],
  target: { displayName: string; textEventSupport?: 'assistant' },
): string | null {
  let lost = 0;
  for (const turn of turns) {
    if (turn.role === 'assistant' && target.textEventSupport === 'assistant') continue;
    for (const event of turn.events ?? []) {
      if (event.kind !== 'text' || event.attachment || event.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) continue;
      const text = (event.detail ?? event.summary).trim();
      if (text && text !== turn.text.trim()) lost += 1;
    }
  }
  if (lost === 0) return null;
  const reason = target.textEventSupport === 'assistant'
    ? `${target.displayName} 只保存助手侧的过程文本，这些用户侧记录不会写入`
    : `${target.displayName} 不保存这些独立的中间文本`;
  return `来源会话有 ${lost} 条过程文本不会随这次交接保留：${reason}；这些中间说明或压缩摘要无法从目标会话恢复，需要时请在来源会话里核对，或用 watch prompt <来源会话 id> --profile full 查看`;
}

/**
 * 会话最后停在用户这一侧：用户说了话，没有对应的助手回复就断了。
 *
 * 这是「工具调用没有结果」之外的另一种中断形状（Ctrl-C、用量耗尽、进程被杀、文件被截断）：
 * `parse` 会如实解析出那条 user 记录，`diffTurns` 把它当新内容照常并入目标，round-trip
 * 两边都含这一轮所以校验通过——`danglingToolCalls` 只按 callId 看，三处防护都看不出
 * 「这一轮其实没有发生」。接手的一侧会看到一句悬空的问题，而输出看起来像一次完整交接。
 *
 * **保守判定，宁少报不误报**：只看最后一条 turn 的 role，且要求它有实际文本。
 * 仅含 `tool_result` 的 user 记录在 parse 阶段已并进 assistant.events，不会落成 user turn；
 * 空文本也说明不了什么（各家可能写占位记录），不据此下结论。
 */
export function unansweredUserTail(turns: UnifiedTurn[]): UnifiedTurn | null {
  const last = turns.at(-1);
  if (!last || last.role !== 'user') return null;
  if (!last.text.trim()) return null;
  return last;
}

/** 与 `describeDanglingToolCalls` 同一套披露口径（含可替换的结尾那句），未闭合时返回 null。 */
export function describeUnansweredTail(
  turns: UnifiedTurn[],
  label: string,
  next = '交接后接手的一侧会看到一句悬空的问题，先在原生 CLI 里确认再继续',
): string | null {
  const tail = unansweredUserTail(turns);
  if (!tail) return null;
  const full = tail.text.trim().replace(/\s+/g, ' ');
  const preview = full.length > 40 ? `${full.slice(0, 40)}…` : full;
  return `${label}最后停在用户消息上（「${preview}」），没有对应的助手回复：这一轮可能被中断或还在生成，${next}`;
}

/**
 * **即将被 resume 的那条会话**自己没收尾时的披露（`open` 与 `switch` 共用一份措辞）。
 *
 * 与「来源会话没收尾」不是一回事：这里没有交接发生，用户复制的是 resume 命令，
 * 接手的就是这一轮断掉的会话，结尾那句要按「即将 resume」说，不能写成「交接后」。
 *
 * 判定分两档，都不误报：
 * - 工具调用没有结果：它在会话中途，**这次并入多少轮都不会闭合**，所以一直说；
 * - 最后停在用户消息上：`merged > 0` 时最后一条 turn 已不是它，「最后停在用户消息上」
 *   会变成假话，所以只在这轮**零增量**（也就是「直接打开」）时说。
 */
export function describeResumeTargetUnfinished(
  turns: UnifiedTurn[],
  label: string,
  merged: number,
): string[] {
  const out: string[] = [];
  const dangling = describeDanglingToolCalls(
    turns,
    label,
    '即将 resume 的这条会话里那一轮仍是断的——先在原生 CLI 里确认或收尾再继续',
  );
  if (dangling) out.push(dangling);
  if (merged > 0) return out;
  const tail = describeUnansweredTail(
    turns,
    label,
    '即将 resume 时接手的一侧同样会看到一句悬空的问题——先在原生 CLI 里确认或收尾再继续',
  );
  if (tail) out.push(tail);
  return out;
}

export function ensureAssistant(turns: UnifiedTurn[], timestamp: string, provider: string): UnifiedTurn {  const last = turns.at(-1);
  if (last?.role === 'assistant') return last;
  const created: UnifiedTurn = { role: 'assistant', text: '', timestamp, provider, events: [] };
  turns.push(created);
  return created;
}

export function pushEvent(turn: UnifiedTurn, event: ProcessEvent): void {
  turn.events = [...(turn.events ?? []), event];
}
