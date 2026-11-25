import path from 'node:path';
import type { ProcessEvent, UnifiedTurn } from './types.js';
import { commandArgv, formatCommandArgv } from './command-argv.js';
import { clipCodePoints, clipCodePointsToWidth, escapeControlChars, hasControlChars } from './display.js';

/**
 * 未知类型 / 角色的展示名：先按原文码点截到 `limit` 再加省略号，然后转义控制字符。
 * 类型名来自会话文件，属于不可信字符串：不转义会把 ESC / CSI 带进目标会话与警告，不截断
 * 会让一条披露被单个超长类型撑爆。先截断再转义，避免把 `\u001B` 这类转义序列从中间切开
 * （先转义后截断会留下 `\u001` 这样的半截序列）。
 */
export function unknownTypeLabel(value: string, limit = 64): string {
  const clipped = clipCodePoints(value, limit);
  return escapeControlChars(clipped.truncated ? `${clipped.text}…` : value);
}

/**
 * 「type×n」有界汇总（未知块 / 片段正文占位与上下文披露共用）：最多展示 8 种，余量写
 * 「另有 N 种」；计数为 1 时只显示类型名。类型名经 `unknownTypeLabel()` 转义与截断。
 * 不做上限时，损坏日志里的类型名集合能把一行披露撑成巨串。
 */
export function formatUnknownTypeCounts(counts: Map<string, number>, limit = 64): string {
  const entries = [...counts.entries()];
  const shown = entries
    .slice(0, 8)
    .map(([type, n]) => {
      const label = unknownTypeLabel(type, limit);
      return n > 1 ? `${label}×${n}` : label;
    });
  if (entries.length > 8) shown.push(`另有 ${entries.length - 8} 种`);
  return shown.join('、');
}

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
 * OpenCode 1.x 的 `synthetic: true` 文本 part 是它自己注入的用户侧内容：MCP 资源展开、
 * `Called the Read tool with the following input: …` 与读到的文件内容、压缩之后的
 * auto-continue 指令（`Continue if you have next steps…`）等。上游 `message-v2.ts` 把它们
 * 送进模型上下文，所以交接不能丢；但它们**不是用户原话**，原样并进 turn.text 会让
 * `watch prompt` 与目标助手把机器注入当成用户指令（与 Claude 压缩摘要同一类误读）。
 * 前缀写在文本里而不是元信息里：文档会被复制走、转入目标会话的也是这段文本本身。
 * 连续的 synthetic 片段只标一次，避免同一段注入内容被前缀切碎。
 */
export const OPENCODE_SYNTHETIC_TEXT_PREFIX = '[OpenCode 注入内容（由 OpenCode 自动生成，不是用户原话）]';

/**
 * OpenCode 工具失败结果在正文里的前缀。
 *
 * 原生把工具失败记成 `state.status === 'error'` + `state.error`（不是一条输出），
 * `parse.ts` 为了不丢原因把它拼成 `[工具执行失败] <原因>`。写出侧必须**先把已经带上的
 * 这层前缀剥掉**再写回 `state.error`，否则每次 OpenCode → 别家 → OpenCode 往返都会再叠一层，
 * 目标里的失败原因变成 `[工具执行失败] [工具执行失败] …`。
 */
export const OPENCODE_TOOL_FAILURE_PREFIX = '[工具执行失败] ';

/**
 * OpenCode 1.x 里「来源没有记录结果」的工具调用，摘要以这段标记开头（`parse.ts` 写、
 * `watch prompt` 渲染工具行时要先跳过它再判断摘要是否已带工具名）。
 */
export const OPENCODE_UNFINISHED_TOOL_PREFIX = '[未完成工具调用] ';

/** 两条 OpenCode 写出路径共用，避免把显示前缀重复写入原生 error 字段。 */
export function stripToolFailurePrefix(text: string): string {
  let out = text.trim();
  while (out.startsWith(OPENCODE_TOOL_FAILURE_PREFIX)) {
    out = out.slice(OPENCODE_TOOL_FAILURE_PREFIX.length).trim();
  }
  return out;
}

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
 * Kimi 的 `context.apply_compaction` 是顶层 wire 记录，`summary` 是 Kimi 生成的历史摘要。
 * 与 Pi 的 `compaction` 条目同一口径：还原成带前缀的用户轮，前缀同时是
 * `watch prompt --since-compact` 认边界的唯一痕迹。摘要为空时也保留「压缩过」的声明，
 * 不能把整条记录丢掉。
 */
export const KIMI_COMPACTION_SUMMARY_PREFIX = '[Kimi 上下文压缩摘要：由 Kimi 生成，不是用户原话]';

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

/**
 * 身份 / 配对比较用的正文：`unwrapUserQuery` 之后再去掉 synthetic 来源前缀行。
 *
 * 第六十二轮给 OpenCode 注入文本加前缀后，同一轮的正文比旧版多一行——
 * `diffTurns` / `mergeTurns` 会把这轮当成新增，已经交接过一次的 OpenCode 会话
 * 会被整段重放。前缀只标注「这段是谁生成的」，不改变「用户说了什么」，
 * 所以对齐时两侧都剥掉（旧库里没有这行，剥完两版一致）。
 */
function comparableBody(text: string): string {
  const unwrapped = unwrapUserQuery(text);
  if (!unwrapped.includes(OPENCODE_SYNTHETIC_TEXT_PREFIX)) return unwrapped.trim();
  return unwrapped
    .split('\n')
    .filter((line) => line !== OPENCODE_SYNTHETIC_TEXT_PREFIX)
    .join('\n')
    .trim();
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

/** Watch 为合法复用 ID 生成的稳定后缀；对账时折回原始 ID，避免把已写入的重映射当成新增。 */
const WATCH_REMAPPED_CALL_ID = /__watch_dup_\d+$/;

function canonicalCallId(callId: string): string {
  return callId.replace(WATCH_REMAPPED_CALL_ID, '');
}

/** 事件种类 + callId：call 与 result 必须分开身份，不能只按裸 callId 排序。 */
function callEventIdentities(t: UnifiedTurn): string[] {
  return (t.events ?? [])
    .filter((e) => (e.kind === 'tool_call' || e.kind === 'tool_result') && e.callId)
    .map((e) => `${e.kind}:${canonicalCallId(e.callId!)}`);
}

/** 纯附件轮的稳定内容身份：原始数据优先，其次 url / 文件名 / 占位文本。 */
function attachmentIdentities(t: UnifiedTurn): string[] {
  return (t.events ?? [])
    .filter((e) => e.attachment)
    .map((e) => {
      const a = e.attachment!;
      const raw = a.data ?? a.url ?? a.filename;
      return JSON.stringify({
        kind: a.kind,
        mediaType: a.mediaType ?? '',
        data: a.data ?? '',
        url: a.url ?? '',
        filename: a.filename ?? '',
        placeholder: raw ? '' : (e.detail ?? e.summary ?? '').trim(),
      });
    })
    .sort();
}

function isMultisetSubset(subset: string[], superset: string[]): boolean {
  const counts = new Map<string, number>();
  for (const item of superset) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of subset) {
    const left = counts.get(item) ?? 0;
    if (left === 0) return false;
    counts.set(item, left - 1);
  }
  return true;
}

/**
 * 两轮能否对齐。与单一 `textKey` 不同，这里能表达「一侧缺事件」：
 * 双方都有调用身份时必须有一侧是另一侧的多重子集，才能按文本补全；
 * 双方调用身份完全不同（同正文但各说各的工具）时不得误配，否则一侧独有工具历史会被覆盖。
 */
export function turnsPair(a: UnifiedTurn, b: UnifiedTurn): boolean {
  if (a.role !== b.role) return false;
  const aBody = comparableBody(a.text);
  const bBody = comparableBody(b.text);
  if (aBody !== bBody) return false;
  if (!aBody) {
    const aAtt = attachmentIdentities(a);
    const bAtt = attachmentIdentities(b);
    if ((aAtt.length > 0 || bAtt.length > 0) && aAtt.join('\u0000') !== bAtt.join('\u0000')) return false;
  }
  const aCalls = callEventIdentities(a);
  const bCalls = callEventIdentities(b);
  if (aCalls.length === 0 || bCalls.length === 0) return true;
  return isMultisetSubset(aCalls, bCalls) || isMultisetSubset(bCalls, aCalls);
}

/**
 * 增量对齐使用的轮次身份：正文 + 按 `kind:callId` 规范化的调用多重集。
 * 只排序裸 callId 会把「call A + result A」与「call A + call A」混为同一轮；
 * 同阶段内允许目标格式重排（Grok 把所有 call 集中写在 result 之前）。
 * 纯附件轮没有正文，必须把附件内容纳入身份，否则不同图片会被当成同一轮。
 */
export function turnIdentityKey(t: UnifiedTurn): string {
  const body = comparableBody(t.text);
  const calls = callEventIdentities(t).sort();
  const attachments = body ? [] : attachmentIdentities(t);
  return JSON.stringify([t.role, body, calls, attachments]);
}

export function textKey(t: UnifiedTurn): string {
  const body = comparableBody(t.text);
  // 空正文轮如果只按 role+text 匹配，所有工具轮 / 纯附件轮都会撞成同一把键；
  // 有正文的轮仍保留「缺事件侧照文本补全」语义（turnsPair 负责子集判断）。
  if (!body) {
    const calls = callEventIdentities(t).sort();
    const attachments = attachmentIdentities(t);
    if (calls.length > 0 || attachments.length > 0) {
      return JSON.stringify([t.role, body, calls, attachments]);
    }
  }
  return `${t.role}\n${body}`;
}

/**
 * 配对轮的事件选择：不能用「事件数组更长」单独决定覆盖方向。
 * 目标有、来源没有的调用 / 结果必须保留；来源有、目标没有的调用则取来源那份。
 * 调用覆盖关系相同（或双方都没有调用）时才按事件数量取更全的一份。
 */
function mergePairedTurn(source: UnifiedTurn, dest: UnifiedTurn): UnifiedTurn {
  const sourceCalls = callEventIdentities(source);
  const destCalls = callEventIdentities(dest);
  const sourceCoversDest = isMultisetSubset(destCalls, sourceCalls);
  const destCoversSource = isMultisetSubset(sourceCalls, destCalls);
  let useSource: boolean;
  if (sourceCoversDest && destCoversSource) {
    useSource = (source.events?.length ?? 0) > (dest.events?.length ?? 0);
  } else if (sourceCoversDest) {
    useSource = true;
  } else if (destCoversSource) {
    useSource = false;
  } else {
    useSource = (source.events?.length ?? 0) > (dest.events?.length ?? 0);
  }
  return useSource ? { ...dest, events: source.events } : dest;
}

/**
 * 按文本对齐合并：保留 dest 独有回合，source 过程事件更全则覆盖到对应 dest 回合，
 * 再接上 source 未匹配的中间缺口与后缀。匹配点之前的 source 轮必须原样保留——
 * 否则「某轮只是缺事件」触发的整份重写会顺手吞掉来源里真正新增的中间问答。
 */
export function mergeTurns(source: UnifiedTurn[], dest: UnifiedTurn[]): UnifiedTurn[] {
  let si = 0;
  const out: UnifiedTurn[] = [];
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (turnsPair(source[i]!, d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      for (let i = si; i < found; i++) out.push(source[i]!);
      out.push(mergePairedTurn(source[found]!, d));
      si = found + 1;
    } else {
      out.push(d);
    }
  }
  for (let i = si; i < source.length; i++) out.push(source[i]!);
  return out;
}

/**
 * 目标写入侧的事件承载能力（对账用）。字段与适配器的能力声明同名同义，
 * 与 `describeTextEventLoss()` / `describeAttachmentLoss()` 是同一套口径——
 * 披露说「写不进去」的事件，在这里也不能算成「重写一次就能补上」。
 */
export interface EventCarryCaps {
  textEventSupport?: 'assistant';
  attachmentSupport?: 'images' | 'user-images' | 'all';
}

/**
 * 事件写进目标后能否被反解回来。三条丢弃是结构性的，与具体 provider 无关：
 * - 无附件的文本事件：六家的写入侧都不写用户侧；助手侧只有声明 `textEventSupport`
 *   的目标才写。以前按「事件数组更长」硬比，这类事件会让计数**永远** > 0。
 * - 与正文同文的助手文本事件：build 主动跳过（写了 parse 也会当最终正文去重）。
 * - 附件事件：按目标 `attachmentSupport` 判定；不支持的种类只留占位文本，事件本身不落盘。
 * 空 / 加密思考所有 build 都丢；其余 thinking 与工具调用 / 结果六家都能写出并反解，
 * 所以仍按「重写一次就能补上」计数。
 */
function isEventCarriable(turn: UnifiedTurn, ev: ProcessEvent, caps: EventCarryCaps): boolean {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_result') return true;
  if (ev.kind === 'thinking') {
    const text = (ev.detail ?? ev.summary).trim();
    return text.length > 0 && text !== ENCRYPTED_THINKING;
  }
  if (ev.kind !== 'text') return true;
  if (ev.attachment) {
    const support = caps.attachmentSupport ?? 'none';
    if (support === 'all') return true;
    if (support === 'images') return ev.attachment.kind === 'image';
    if (support === 'user-images') return turn.role === 'user' && ev.attachment.kind === 'image';
    return false;
  }
  if (turn.role !== 'assistant' || caps.textEventSupport !== 'assistant') return false;
  const text = (ev.detail ?? ev.summary).trim();
  return text.length > 0 && text !== turn.text.trim();
}

function carriableEventCount(turn: UnifiedTurn, caps: EventCarryCaps | undefined): number {
  const events = turn.events ?? [];
  // 未提供目标能力时保持旧口径（按全部事件计）：只有测试与不写盘的只读路径会走到这里。
  if (!caps) return events.length;
  return events.filter((ev) => isEventCarriable(turn, ev, caps)).length;
}

/**
 * 按 turnsPair 对齐后，**dest 回合缺少 source 过程事件**的回合数。
 *
 * `diffTurns` 用轮次身份（正文 + 调用身份）对齐：一轮同文本、但来源多出 thinking /
 * 过程文本（都不带 callId）的回复会被判成「目标已包含」而跳过，过程事件静默消失。
 * 这里是同一件事的计数版——`handoff` 用它决定是否整份重写；`open --from` 不能重写
 * （目标格式可能存不下这些事件，重写会在每次 `--from` 时反复发生），但必须据此披露。
 *
 * **只数目标写得出的事件**：用户侧文本事件、与正文同文的助手文本事件、目标不支持的
 * 附件种类都不会因为「重写一次」而出现，按原始事件数比较会让计数永久 > 0，
 * 于是每次交接都判成「缺过程事件」并整份重写（2026-11-14 第九十三轮，probe 复现）。
 */
export function countPairedTurnsMissingEvents(
  source: UnifiedTurn[],
  dest: UnifiedTurn[],
  target?: EventCarryCaps,
): number {
  if (dest.length === 0) return 0;
  let si = 0;
  let count = 0;
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (turnsPair(source[i]!, d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      if (carriableEventCount(source[found]!, target) > carriableEventCount(d, target)) count += 1;
      si = found + 1;
    }
  }
  return count;
}

/** 对齐后的 dest 回合缺 source 的过程事件 → 必须整文件重写，不能追加到最终回复后面 */
export function shouldReplacePairedSession(
  source: UnifiedTurn[],
  dest: UnifiedTurn[],
  target?: EventCarryCaps,
): boolean {
  return countPairedTurnsMissingEvents(source, dest, target) > 0;
}

export function toClaudeToolName(name: string): string {
  const n = name.toLowerCase();
  if (n === 'exec' || n === 'shell' || n === 'local_shell' || n === 'shell_command') return 'Bash';
  return name;
}

export function toCodexToolName(name: string): string {
  if (name === 'Bash' || name === 'bash') return 'exec';
  // 空 / 纯空白不是合法工具名（原生不会产生）：原样写进 `custom_tool_call.name` 会留下空串，
  // 与 OpenCode 第 263 轮的 `opencodeToolName()` 同口径归一为 `tool`。parse 侧的
  // `codexToolName()` 同步归一，否则写后校验的期望与回读不一致。
  return name.trim() ? name : 'tool';
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

/**
 * 写进 Claude `Bash` 的入参；调用方已按 `toClaudeToolName()` 确认目标工具是 `Bash`。
 *
 * `command` 两种来源形状都要认：字符串，以及旧版 Codex `shell` 的 argv 数组
 * （`{ command: ["bash", "-lc", "…"], workdir }`）。不认数组就会落到最后的来源原文兜底，
 * 把整段入参 JSON 文本当成命令写进去，下一跳再照着这段 JSON 去执行。
 * argv 按 `formatCommandArgv()` 还原成命令文本：三项 shell 包装取脚本本身，其余逐项按
 * shell 单引号规则引用。
 *
 * `timeout` / `run_in_background` 是 Claude Bash 的原生字段（timeout 是毫秒，上限 600000）：
 * 来源同样是 Claude 时按原值保留；Pi bash 的 `timeout` 是秒（pi-ai 1.5.2 `bash.js` 的
 * `resolveTimeoutMs()` 按 ×1000 转毫秒），能换算出整数毫秒并落在值域内时承载；
 * 其它来源的同名字段单位无法确认（旧版 Codex `shell` 的 `timeout`），不猜、不写，
 * 由 `describeBashControlLoss()` 披露。
 * `workdir` / `env` 在 Claude Bash 里没有位置，同样走披露。
 */
export function claudeBashInput(event: ProcessEvent): {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
} {
  const input = event.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const argv = commandArgv(obj.command);
    const command = typeof obj.command === 'string' ? obj.command : argv ? formatCommandArgv(argv) : undefined;
    if (command !== undefined) {
      const timeout = claudeCarriedBashTimeout(event, obj.timeout);
      return {
        command,
        description: typeof obj.description === 'string' ? obj.description : event.summary,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(obj.run_in_background === true ? { run_in_background: true } : {}),
      };
    }
  }
  const raw = typeof input === 'string' ? input : (event.detail ?? event.summary);
  return { command: extractExecCommand(raw) };
}

/**
 * Claude Bash 的 `timeout` 值域：毫秒、[1000, 600000]（Claude Code 2.1.325 的 Bash schema
 * 写明 "Optional timeout in milliseconds (max … for a foreground command)"）。越界不夹取：
 * 夹取会改变来源语义，交给 `describeBashControlLoss()` 披露。
 */
export function claudeBashTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1000 || value > 600_000) return undefined;
  return value;
}

/**
 * Claude `Bash` 目标能承载的 `timeout`（毫秒）：Claude 来源按原值校验；
 * Pi 来源的秒值能换算出整数毫秒且落在 Claude 值域内才承载（`0.5` 秒 → 500 毫秒会被拒，
 * `1.5` 秒 → 1500 毫秒可以）；其它来源单位无法确认，不猜。
 */
export function claudeCarriedBashTimeout(event: ProcessEvent, value: unknown): number | undefined {
  if (event.provider === 'claude') return claudeBashTimeout(value);
  if (event.provider !== 'pi') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value * 1000;
  if (!Number.isInteger(ms)) return undefined;
  return claudeBashTimeout(ms);
}

/**
 * Pi `bash` 目标能承载的 `timeout`（秒）：pi-ai 1.5.2 的 bash schema 写明
 * "Timeout in seconds"、`resolveTimeoutMs()` 按 value × 1000 转毫秒，值域 finite > 0
 * 且不超过 2147483.647 秒（`MAX_TIMEOUT_MS` 2^31−1 毫秒）。Claude 来源的毫秒值 ÷ 1000
 * 换算成秒（Claude 的上限 600000 毫秒 → 600 秒，必在 Pi 值域内）；其余来源不换算。
 */
export function piBashTimeoutFromClaude(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value / 1000;
}

/**
 * Codex `custom_tool_call.input` 的文本；`codexName` 是 `toCodexToolName()` 之后的工具名。
 *
 * 只有 `exec` 取命令本身（随后由 writer 包成调用脚本）。其它工具必须拿到完整入参：
 * - 入参里有 `command` 键不等于它是 shell——`str_replace_editor` 的 `command` 是子命令名，
 *   MCP 远程执行类工具的 `command` 旁边还有主机 / 会话；只写 `command` 会把其余键全丢掉。
 * - 事件没有 `detail` 不等于没有入参——Pi / OpenCode 的解析结果只带结构化 `input`，
 *   退回 `summary` 得到的是工具名或 200 字符摘要。
 * 顺序：字符串入参 → exec 的 `command`（字符串，或旧版 `shell` 的 argv 数组，与
 * `claudeBashInput()` 同一套还原）→ 来源原文 `detail`（键序与数字写法按来源保留）→
 * 结构化入参序列化 → 最后才是单行摘要。round-trip 不比 input / detail，这里错了自校验查不出来。
 * exec 没有可用命令时（如 Pi `argumentsError` 的 `{}`）保留入参原文：它会在下一跳立刻报语法
 * 错误，而退回 summary 只有工具名（`cmd:"bash"` 会起交互式 shell），更糟。
 */
export function codexToolInput(event: ProcessEvent, codexName: string): string {
  const input = event.input;
  if (typeof input === 'string') return input;
  if (codexName === 'exec' && input && typeof input === 'object' && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
    const argv = commandArgv(command);
    if (argv) return formatCommandArgv(argv);
  }
  if (typeof event.detail === 'string') return event.detail;
  // JSON.stringify 对函数 / symbol 等不可序列化的值返回 undefined，此时仍退回摘要。
  const serialized: unknown = input === undefined || input === null ? undefined : JSON.stringify(input);
  return typeof serialized === 'string' ? serialized : event.summary;
}

/**
 * 目标原生字段只接受「字符串键对象」时用：Pi 的 `toolCall.arguments` 是 pi-ai `JsonObject`，
 * OpenCode 1.x 的 `state.input` 是 `Record<string, any>`。Codex 来源里 `exec` 的命令、
 * `apply_patch` 的自由文本补丁、解析不了的 JSON 参数都是字符串，原样写进去不符合目标的原生类型，
 * 而 Watch 自己回读照样认得、round-trip 又不比入参，所以查不出来。
 *
 * 对象原样返回；缺省 / null 沿用既有口径写空对象；其余值包成 `{ [key]: 原值 }` 并报 `wrapped`。
 * 包装必须可逆且不靠猜：调用方要在入参**之外**写下自己的标记，解析侧确认标记后才经
 * `unwrapMarkedToolInput()` 还原——`{ input: "…" }` 本身就是 Pi 自由文本工具的原生形状。
 */
export function toolInputAsRecord(input: unknown, key: string): { record: Record<string, unknown>; wrapped: boolean } {
  if (input === undefined || input === null) return { record: {}, wrapped: false };
  if (typeof input === 'object' && !Array.isArray(input)) return { record: input as Record<string, unknown>, wrapped: false };
  return { record: { [key]: input }, wrapped: true };
}

/**
 * 还原 `toolInputAsRecord()` 的包装。只在调用方已确认 Watch 自己的标记后调用；
 * 形状不是「恰好一个 `key` 键、内层不是对象」时原样返回——那不是 writer 会写出的东西。
 */
export function unwrapMarkedToolInput(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== key) return value;
  const inner = (value as Record<string, unknown>)[key];
  return toolInputAsRecord(inner, key).wrapped ? inner : value;
}

export function summarize(text: string, fallback: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return fallback;
  // 总宽 80 码点（含省略号）：恰 80 码点的行原样保留，更长的取前 79 码点 + `…`。
  return clipCodePointsToWidth(line, 80);
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
      // 目标只保留一条回复时，后续独立轮次的真实用量不能凭空消失。
      if (t.usage) {
        prev.usage = {
          inputTokens: (prev.usage?.inputTokens ?? 0) + t.usage.inputTokens,
          outputTokens: (prev.usage?.outputTokens ?? 0) + t.usage.outputTokens,
        };
      }
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

type CallOccurrence = {
  baseId: string;
  call: ProcessEvent;
  results: ProcessEvent[];
  index: number;
  newId: string | null;
  drop: boolean;
};

/** 调用 / 结果的可比较载荷；时间戳不参与，重放副本可能带着不同的写入时间。 */
function callPayload(event: ProcessEvent): string {
  return JSON.stringify({
    kind: event.kind,
    name: event.name ?? '',
    input: event.input ?? null,
    summary: event.summary,
    detail: event.detail ?? '',
  });
}

function occurrenceFingerprint(occ: CallOccurrence): string {
  return JSON.stringify([callPayload(occ.call), occ.results.map(callPayload)]);
}

function remappedCallId(baseId: string, index: number, used: Set<string>): string {
  let n = index + 1;
  let candidate = `${baseId}__watch_dup_${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${baseId}__watch_dup_${n}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 会话级 callId 去重：完全相同的调用 + 结果视为一次重放，只保留首次出现。
 *
 * 同一 callId 完成后再发起**另一次内容不同的调用**不是重放——直接删掉会让第二轮真实
 * 工具历史静默消失。目标又普遍要求同一会话内 callId 唯一，因此这种复用把整组
 * call/result 稳定重映射到新 ID（同一输入每次得到同一个新 ID），而不是删除。
 * 无 callId 的事件不参与。
 */
export function dedupeCallEvents(turns: UnifiedTurn[]): UnifiedTurn[] {
  const byId = new Map<string, CallOccurrence[]>();
  const eventLabels: Array<CallOccurrence | null> = [];
  const all: CallOccurrence[] = [];
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      let label: CallOccurrence | null = null;
      if (event.kind === 'tool_call' && event.callId) {
        const list = byId.get(event.callId) ?? [];
        const occ: CallOccurrence = {
          baseId: event.callId,
          call: event,
          results: [],
          index: list.length,
          newId: null,
          drop: false,
        };
        list.push(occ);
        byId.set(event.callId, list);
        all.push(occ);
        label = occ;
      } else if (event.kind === 'tool_result' && event.callId) {
        const list = byId.get(event.callId);
        if (list?.length) {
          // 结果按未配对调用先进先出；同一调用有多条结果时都挂在最后一条出现上。
          const occ = list.find((item) => item.results.length === 0) ?? list.at(-1)!;
          occ.results.push(event);
          label = occ;
        }
      }
      eventLabels.push(label);
    }
  }

  const used = new Set(byId.keys());
  for (const occ of all) {
    const prior = byId.get(occ.baseId)!.slice(0, occ.index);
    if (prior.length === 0) continue;
    const fingerprint = occurrenceFingerprint(occ);
    if (occ.results.length === 0) {
      // 同一条调用被重复登记（Claude 行内重复 tool_use、resume 重放）仍然收敛，
      // 但只有调用载荷相同才算；内容不同说明是另一组待完成调用，下面走重映射。
      if (prior.some((item) => callPayload(item.call) === callPayload(occ.call))) occ.drop = true;
      else occ.newId = remappedCallId(occ.baseId, occ.index, used);
    } else if (prior.some((item) => occurrenceFingerprint(item) === fingerprint)) {
      occ.drop = true;
    } else {
      occ.newId = remappedCallId(occ.baseId, occ.index, used);
    }
  }

  let changed = false;
  let eventIndex = 0;
  const out = turns.map((turn) => {
    if (!turn.events?.length) return turn;
    let turnChanged = false;
    const events: ProcessEvent[] = [];
    for (const event of turn.events) {
      const occ = eventLabels[eventIndex++];
      if (occ?.drop) {
        changed = true;
        turnChanged = true;
        continue;
      }
      if (occ?.newId) {
        changed = true;
        turnChanged = true;
        events.push(event.callId === occ.newId ? event : { ...event, callId: occ.newId });
      } else {
        events.push(event);
      }
    }
    return turnChanged ? { ...turn, events } : turn;
  });
  return changed ? out : turns;
}

/**
 * 有工具调用、却没有对应结果的 callId（按出现顺序去重）。
 *
 * 中断（Ctrl-C、用量耗尽）、工具还在跑、或 resume 重放了半截调用都会留下这种回合：
 * 内容照常可读，`diffTurns` 只比解析结果、round-trip 只比「写进去的内容」，两处都看不出
 * 那一轮是做了一半的。交接前必须主动披露，否则接手的一侧会以为任务停在这里就完了。
 */
export function danglingToolCalls(turns: readonly UnifiedTurn[]): string[] {
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

/** 按 callId 找得到结果、却找不到调用的条目；常见于压缩后残留，不代表会话不可用。 */
export function orphanToolResults(turns: readonly UnifiedTurn[]): string[] {
  const called = new Set<string>();
  const finished = new Set<string>();
  for (const t of turns) {
    for (const e of t.events ?? []) {
      if (!e.callId) continue;
      if (e.kind === 'tool_call') called.add(e.callId);
      else if (e.kind === 'tool_result') finished.add(e.callId);
    }
  }
  return [...finished].filter((id) => !called.has(id));
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
  // callId 来自会话文件，和会话 id / 路径一样是不可信字符串：警告会被桌面端与终端展示，
  // 先转义再拼，避免 ESC / 换行把一条披露折成多条或改写终端（第 418 轮）。
  const shown = dangling.slice(0, 3).map((id) => escapeControlChars(id)).join(', ');
  return `${escapeControlChars(label)}有 ${dangling.length} 次工具调用没有结果（callId: ${shown}${dangling.length > 3 ? ' 等' : ''}），可能在等待用户审批、仍在运行或已中断：${next}`;
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

/** 只搬正文的目标写进会话的实际文本：原正文 + 附件占位（没有附件时就是原正文） */
export function userTurnTextForWrite(turn: UnifiedTurn): string {
  const places = attachmentPlaceholders(turn);
  if (places.length === 0) return turn.text;
  return [turn.text.trim(), ...places].filter(Boolean).join('\n\n');
}

/**
 * 助手轮同一投影。pi / kimi / grok 的 build 只搬 `turn.text`，纯附件助手轮
 * （例如 opencode 的 file part）以前写成空内容：`describeAttachmentLoss()` 承诺的
 * 「只留占位文本」在助手侧没有落地，grok 甚至因整轮不写而 round-trip 拒绝。
 */
export const assistantTurnTextForWrite = userTurnTextForWrite;

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

/** 带不到目标的附件数（图片 / 文件类分开计）；`describeAttachmentLoss()` 与 `--json` 的 `contentLoss` 共用 */
export type AttachmentLossCount = { images: number; files: number };

export function countAttachmentLoss(
  turns: UnifiedTurn[],
  target: { attachmentSupport?: 'images' | 'user-images' | 'all' },
): AttachmentLossCount {
  const support = target.attachmentSupport ?? 'none';
  const count: AttachmentLossCount = { images: 0, files: 0 };
  if (support === 'all') return count;
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (!event.attachment) continue;
      const image = event.attachment.kind === 'image';
      // `images` = 图片块能还原、文件类附件不能；`user-images` 再收窄到用户轮
      if (support === 'images' && image) continue;
      if (support === 'user-images' && turn.role === 'user' && image) continue;
      if (image) count.images += 1;
      else count.files += 1;
    }
  }
  return count;
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
  const { images, files } = countAttachmentLoss(turns, target);
  const total = images + files;
  if (total === 0) return null;
  const kinds = [images ? `${images} 张图片` : '', files ? `${files} 个文件附件` : ''].filter(Boolean).join('、');
  const keptNote =
    support === 'images'
      ? `${target.displayName} 只还原图片块，文件类附件只留占位文本`
      : support === 'user-images'
        ? `${target.displayName} 只还原用户轮的图片块，助手轮图片与文件类附件只留占位文本`
        : `${target.displayName} 的写入侧不还原附件的原始数据，只留占位文本`;
  return (
    `来源会话有 ${total} 个附件（${kinds}）不会随这次交接保留：${keptNote}（如「[图片：image/png，1234B]」），` +
    `原始数据不落盘，也无法从目标会话里恢复；需要这些附件时先在来源里另存，或转到 OpenCode（图片与文件都能带）`
  );
}

/** 目标不保存的独立过程文本条数；`describeTextEventLoss()` 与 `--json` 的 `contentLoss` 共用 */
export function countTextEventLoss(
  turns: UnifiedTurn[],
  target: { textEventSupport?: 'assistant' },
): number {
  let lost = 0;
  for (const turn of turns) {
    if (turn.role === 'assistant' && target.textEventSupport === 'assistant') continue;
    for (const event of turn.events ?? []) {
      if (event.kind !== 'text' || event.attachment || event.summary.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX)) continue;
      const text = (event.detail ?? event.summary).trim();
      if (text && text !== turn.text.trim()) lost += 1;
    }
  }
  return lost;
}

/**
 * 无附件的过程文本不参与 round-trip 校验；按本次实际写入的轮次与目标能力披露。
 * 附件走 describeAttachmentLoss，上下文披露另进 warnings；正文已经包含的同文事件不重复报损失。
 */
export function describeTextEventLoss(
  turns: UnifiedTurn[],
  target: { displayName: string; textEventSupport?: 'assistant' },
): string | null {
  const lost = countTextEventLoss(turns, target);
  if (lost === 0) return null;
  const reason = target.textEventSupport === 'assistant'
    ? `${target.displayName} 只保存助手侧的过程文本，这些用户侧记录不会写入`
    : `${target.displayName} 不保存这些独立的中间文本`;
  return `来源会话有 ${lost} 条过程文本不会随这次交接保留：${reason}；这些中间说明或压缩摘要无法从目标会话恢复，需要时请在来源会话里核对，或用 watch prompt <来源会话 id> --profile full 查看`;
}

/** 不会作为原生状态写入目标的工具失败标记条数；`describeToolFailureLoss()` 与 `contentLoss` 共用 */
export function countToolFailureLoss(
  turns: UnifiedTurn[],
  target: { toolFailureSupport?: 'assistant' },
): number {
  let lost = 0;
  for (const turn of turns) {
    if (turn.role === 'assistant' && target.toolFailureSupport === 'assistant') continue;
    for (const event of turn.events ?? []) {
      if (event.kind === 'tool_result' && event.failed === true) lost += 1;
    }
  }
  return lost;
}

/** 失败标记不参与 round-trip 对账；按实际写入载荷披露，不复制结果正文或猜测错误文字。 */
export function describeToolFailureLoss(
  turns: UnifiedTurn[],
  target: { displayName: string; toolFailureSupport?: 'assistant' },
): string | null {
  const lost = countToolFailureLoss(turns, target);
  if (lost === 0) return null;
  const name = escapeControlChars(target.displayName);
  const scope = target.toolFailureSupport === 'assistant' ? `。${name} 只保留助手轮工具结果的原生失败状态` : '';
  return `这次交接有 ${lost} 条工具结果的失败标记不会作为原生状态写入 ${name}${scope}。如果目标输出仍有退出码，可据此核对。也可查看来源会话确认结果`;
}

/** Bash 类工具入参里代表「执行时限」的键；Codex exec 没有对应字段，Claude Bash 的 `timeout` 是毫秒。 */
const BASH_TIMEOUT_KEYS = ['timeout', 'timeout_ms'] as const;
/** 来源侧表示「放到后台跑」的标记（Claude `run_in_background`、Grok `is_background` / `background`）。 */
const BASH_BACKGROUND_KEYS = ['run_in_background', 'is_background', 'background'] as const;

/**
 * 来源给出、可以放心写进目标原生字段的工作目录：绝对路径且不含控制字符。
 *
 * 其余形状（相对路径、空串、控制字符）不猜：Codex 的 `workdir` 与进程 cwd 的解析规则绑定，
 * 相对值写进去就换了语义；控制字符会随脚本进入目标记录。带不过去时由
 * `describeBashControlLoss()` 披露，不静默换成目标 cwd 假装保留了。
 */
export function usableBashWorkdir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (hasControlChars(value)) return undefined;
  return path.isAbsolute(value) ? value : undefined;
}

function hasBashTimeout(obj: Record<string, unknown>): boolean {
  return BASH_TIMEOUT_KEYS.some((key) => {
    const value = obj[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  });
}

export type BashControlLossCount = { workdirs: number; timeouts: number; backgrounds: number };

/**
 * Bash 类工具调用的控制字段（工作目录 / 超时 / 后台运行）在目标格式里放不下时的计数与披露。
 *
 * 只有两种目标的写入侧会**重新派生** Bash 入参，其余（Pi / Kimi / Grok / OpenCode）原样保存
 * 结构化入参，字段自然不会损失，计数全为 0、披露返回 null：
 * - Codex 的 `exec`：`codexToolInput()` 只留命令，`wrapExecInput()` 重建
 *   `tools.exec_command({cmd, workdir, …})` 脚本。它没有超时 / 后台字段（`yield_time_ms`
 *   是等待窗口，不是命令时限）；来源明确给出的绝对路径工作目录会写进 `workdir`，带不过去的才算损失。
 * - Claude 的 `Bash`：`claudeBashInput()` 写 command / description，并保留 Claude 自己的
 *   毫秒 `timeout`（值域内）与 `run_in_background`。它的 Bash 入参没有工作目录字段；其它来源的
 *   超时单位无法确认（旧版 Codex `shell` 的 `timeout`、Pi bash 的秒），不猜、不写。
 *
 * 这些字段影响「这条命令当时是怎么跑的」，下一跳会照着历史判断，所以丢的时候必须说出来。
 */
export function countBashControlLoss(
  turns: UnifiedTurn[],
  target: { id?: string },
): BashControlLossCount {
  const id = target.id ?? '';
  let workdirs = 0;
  let timeouts = 0;
  let backgrounds = 0;
  if (id !== 'codex' && id !== 'claude') return { workdirs, timeouts, backgrounds };
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (event.kind !== 'tool_call') continue;
      const input = event.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
      const obj = input as Record<string, unknown>;
      const name = event.name ?? 'tool';
      if (id === 'codex') {
        if (toCodexToolName(name) !== 'exec') continue;
        if (hasBashTimeout(obj)) timeouts += 1;
        if (BASH_BACKGROUND_KEYS.some((key) => obj[key] === true)) backgrounds += 1;
        if (typeof obj.workdir === 'string' && obj.workdir.trim() && !usableBashWorkdir(obj.workdir)) workdirs += 1;
      } else {
        if (toClaudeToolName(name) !== 'Bash') continue;
        if (typeof obj.workdir === 'string' && obj.workdir.trim()) workdirs += 1;
        // 能承载的超时（Claude 原值 / Pi 秒换算）不算损失。
        const carried = claudeCarriedBashTimeout(event, obj.timeout) !== undefined;
        if (!carried && hasBashTimeout(obj)) timeouts += 1;
      }
    }
  }
  return { workdirs, timeouts, backgrounds };
}

/** 上面那份计数的中文披露；`--json` 的 `contentLoss.bashControls` 用的是同一份计数 */
export function describeBashControlLoss(
  turns: UnifiedTurn[],
  target: { id?: string; displayName: string },
): string | null {
  const id = target.id ?? '';
  const { workdirs, timeouts, backgrounds } = countBashControlLoss(turns, target);
  const parts = [
    workdirs ? `${workdirs} 个工作目录` : '',
    timeouts ? `${timeouts} 个超时设置` : '',
    backgrounds ? `${backgrounds} 个后台运行标记` : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const display = escapeControlChars(target.displayName);
  const reason = id === 'codex'
    ? `${display} 的 exec 脚本用 tools.exec_command 重建，它没有超时 / 后台字段（yield_time_ms 只是等待窗口），工作目录只带绝对路径`
    : `${display} 的 Bash 入参没有工作目录字段，超时只保留能确认单位的毫秒值（Claude 来源按原值、Pi 来源按秒换算，范围 1000–600000），其它来源的单位或越界值无法确认`;
  return (
    `来源会话有 ${parts.join('、')}不会随这次交接写进目标：${reason}；` +
    `这些调用的命令本身照常写入，需要当时的执行条件时请回来源会话核对`
  );
}

/**
 * 写入目标时带不过去的内容，按类别计数（`switch` / `open --from` / `open --to` 的 `--json` 共用）。
 *
 * 四类损失各自早有一句中文 warnings，但都不参与 round-trip 校验——目标照常可读、命令照常成功，
 * 脚本读到的只是一次普通的「已交接 N 轮」。字段与警告同源于上面四个 `count*`，同一处取数：
 * 警告出现时字段必出现，计数为 0 的类别不输出，四类都是 0 时整个字段不输出。
 */
export type ContentLoss = {
  /** 原始数据带不过去、目标侧只剩占位文本的附件 */
  attachments?: AttachmentLossCount;
  /** 目标不保存的独立过程文本（中间说明 / 压缩摘要） */
  textEvents?: number;
  /** 不会作为原生失败状态写入目标的工具结果 */
  toolFailures?: number;
  /** Bash 类调用里目标放不下的执行条件（工作目录 / 超时 / 后台运行标记） */
  bashControls?: BashControlLossCount;
};
export type ContentLossField = { contentLoss?: ContentLoss };

export function contentLossField(counts: {
  attachments?: AttachmentLossCount | null;
  textEvents?: number | null;
  toolFailures?: number | null;
  bashControls?: BashControlLossCount | null;
}): ContentLossField {
  const loss: ContentLoss = {};
  const a = counts.attachments;
  if (a && a.images + a.files > 0) loss.attachments = { images: a.images, files: a.files };
  if (counts.textEvents && counts.textEvents > 0) loss.textEvents = counts.textEvents;
  if (counts.toolFailures && counts.toolFailures > 0) loss.toolFailures = counts.toolFailures;
  const b = counts.bashControls;
  if (b && b.workdirs + b.timeouts + b.backgrounds > 0) {
    loss.bashControls = { workdirs: b.workdirs, timeouts: b.timeouts, backgrounds: b.backgrounds };
  }
  return Object.keys(loss).length ? { contentLoss: loss } : {};
}

/** 四类损失都按同一批轮次计数时的入口（`open --to` 的预检与执行：计划写入的就是这一批） */
export function contentLossOf(
  turns: UnifiedTurn[],
  target: {
    id?: string;
    attachmentSupport?: 'images' | 'user-images' | 'all';
    textEventSupport?: 'assistant';
    toolFailureSupport?: 'assistant';
  },
): ContentLossField {
  if (turns.length === 0) return {};
  return contentLossField({
    attachments: countAttachmentLoss(turns, target),
    textEvents: countTextEventLoss(turns, target),
    toolFailures: countToolFailureLoss(turns, target),
    bashControls: countBashControlLoss(turns, target),
  });
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

/**
 * 悬空尾轮是否由来源日志明确标成失败 / 中止。供交接文档与 `describeUnansweredTail()` 共用，
 * 避免两处各自翻 `tailFailure` 时对同一个标记给出相反结论。
 */
export function unansweredTailFailure(turns: UnifiedTurn[]): 'error' | 'cancelled' | null {
  const confirmed = unansweredUserTail(turns)?.events?.find((e) => e.kind === 'text' && e.tailFailure)?.tailFailure;
  return confirmed ?? null;
}

/**
 * 「来源会话没收尾」的结构化形式，与 `describeDanglingToolCalls()` / `describeUnansweredTail()`
 * 两句中文警告同一处判定（`switch` / `open --from` / `open --to` 共用）：
 * - `danglingToolCalls`：有调用、没有结果的工具调用数（按 callId 去重，覆盖整条会话）；
 * - `unansweredTail`：最后停在用户消息上、没有助手回复——值是来源日志给的结束方式
 *   （`cancelled` / `error`），日志没标明时为 `unknown`（可能被中断，也可能还在生成）。
 * 命名与 `prompt --json` 的 `stats.danglingToolCalls` / `stats.unansweredTailReason` 一致。
 * 两种形状都没有时不输出：字段缺省 = 按这两条判据来源已收尾，不代表任务本身做完了。
 */
export type SourceUnfinished = {
  danglingToolCalls?: number;
  unansweredTail?: 'cancelled' | 'error' | 'unknown';
};
export type SourceUnfinishedField = { sourceUnfinished?: SourceUnfinished };

export function sourceUnfinishedField(turns: UnifiedTurn[]): SourceUnfinishedField {
  const unfinished: SourceUnfinished = {};
  const dangling = danglingToolCalls(turns).length;
  if (dangling > 0) unfinished.danglingToolCalls = dangling;
  if (unansweredUserTail(turns)) unfinished.unansweredTail = unansweredTailFailure(turns) ?? 'unknown';
  return Object.keys(unfinished).length ? { sourceUnfinished: unfinished } : {};
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
  const clippedTail = clipCodePoints(full, 40);
  const preview = clippedTail.truncated ? `${clippedTail.text}…` : full;
  // 来源日志已经写明失败 / 中止时，不能再说「可能还在生成」——两句话并列会自相矛盾。
  // 标记由解析器的失败披露事件携带（`ProcessEvent.tailFailure`），只改这一句，不压掉警告。
  const confirmed = unansweredTailFailure(turns);
  const reason = confirmed
    ? `这一轮在来源日志里以${confirmed === 'cancelled' ? '中止' : '失败'}结束（不是仍在生成）`
    : '这一轮可能被中断或还在生成';
  return `${escapeControlChars(label)}最后停在用户消息上（「${escapeControlChars(preview)}」），没有对应的助手回复：${reason}，${next}`;
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

/**
 * 首条用户消息之前的助手记录 / 过程记录：Watch 的对话从首条用户消息开始，这些记录不成轮。
 * 只给计数文案（不含披露前缀与收尾括号），没有任何计数时返回 null；不复制正文。
 */
export function preUserRecordsNote(label: string, assistant: number, process: number): string | null {
  const parts = [
    assistant > 0 ? `${assistant} 条助手记录` : '',
    process > 0 ? `${process} 条过程记录` : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${label} 日志在首条用户消息之前有 ${parts.join('、')}，Watch 的对话从首条用户消息开始：这些记录没有并入交接，请在来源核对。`;
}
