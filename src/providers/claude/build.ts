import { access, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFileAtomic, writeFileAtomic } from '../../core/atomic.js';
import { escapeControlChars } from '../../core/display.js';
import { iterateFileLines } from '../../core/read-text.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { claudeBashInput, CLAUDE_THINKING_PREFIX, ENCRYPTED_THINKING, toClaudeToolName, turnHasContent, WATCH_CONTEXT_DISCLOSURE_PREFIX } from '../../core/rich.js';
import { parseClaudeSession } from './parse.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import type { ImportTurnsOpts } from '../adapter.js';

/** Claude Code 项目目录编码：非 ASCII 字母数字一律 → `-`（与 cc-sessions 一致） */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects');
}

type ClaudeIdentity = { model: string; version?: string };

const DEFAULT_IDENTITY: ClaudeIdentity = { model: 'claude-sonnet-4-5' };

/** 从最近会话探测本机 Claude 的 model/version；探测不到用默认（对齐 cc-sessions detect_claude_identity） */
async function detectClaudeIdentity(projectsDir: string): Promise<ClaudeIdentity> {
  const files = await newestJsonlPaths(projectsDir, 10);
  let detectedVersion: string | undefined;
  for (const file of files) {
    let fileVersion: string | undefined;
    try {
      // 只读前 200 行，而且是流式的：这里只为探测 model / version，目标目录里可能躺着
      // 663 MB 的会话（本机实测），整份 readFile 会抛 `Invalid string length` 而被
      // 静默跳过——探测不到身份就退回默认 model，写出的会话与原生不一致。
      let seen = 0;
      for await (const line of iterateFileLines(file)) {
        if (seen >= 200) break;
        seen += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        // JSON 值不一定是消息对象；与正文解析一致跳过，不能让 null 中断身份探测。
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        fileVersion ??= typeof record.version === 'string' ? record.version : undefined;
        if (record.type !== 'assistant') continue;
        const message = record.message as Record<string, unknown> | undefined;
        const model = typeof message?.model === 'string' ? message.model : undefined;
        const messageId = typeof message?.id === 'string' ? message.id : '';
        if (model?.startsWith('claude-') && !generatedOriginLabel(messageId)) {
          return { model, version: fileVersion ?? detectedVersion };
        }
      }
    } catch {
      continue;
    }
    detectedVersion ??= fileVersion;
  }
  return { ...DEFAULT_IDENTITY, version: detectedVersion };
}

/** 按 mtime 倒序取 projects 下的 .jsonl 会话文件（最多 max 个） */
async function newestJsonlPaths(projectsDir: string, max: number): Promise<string[]> {
  const collected: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let entries: string[];
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) collected.push(path.join(dirPath, entry));
    }
  }
  const withMtime = await Promise.all(
    collected.map(async (file) => {
      try {
        return { file, mtime: (await stat(file)).mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    }),
  );
  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((x) => x.file);
}

/** cc-sessions generated_origin_label：转换工具生成的 message id 不作为身份来源 */
function generatedOriginLabel(value: string): boolean {
  const v = value.toLowerCase();
  return ['cc-sessions', 'codex-import', 'external-import', 'external_import', 'external_agent', 'imported'].some(
    (label) => v.includes(label),
  );
}

function newMsgId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/** UnifiedTurn[] → Claude JSONL 行（Rich：thinking / tool_use / tool_result / 最终 text） */
export function buildClaudeLines(
  turns: UnifiedTurn[],
  sessionId: string,
  cwd: string,
  identity: ClaudeIdentity,
  opts?: { parentUuid?: string | null; requireUser?: boolean },
): string[] {
  const lines: string[] = [];
  let parentUuid: string | null = opts?.parentUuid ?? null;
  let lastTimestamp = new Date().toISOString();
  let userCount = 0;

  const baseRecord = (): Record<string, unknown> => {
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      gitBranch: '',
      uuid,
      timestamp: lastTimestamp,
    };
    if (identity.version) record.version = identity.version;
    return record;
  };

  // `message.id` 由调用方按 turn 传入：同一条 assistant 回复按 content block 拆成多行时，
  // 这几行必须共用同一个 id。原生 Claude 就是这样写的（本机 43809 个带 usage 的 message.id
  // 里有 32714 个出现在多行：thinking + text + tool_use 共用一个 id），而 `claudeSessionUsage()`
  // 正是按 id 去重；以前这里每次调用都生成新 id，于是 `emitClaudeEvent()` 挂到每个 block 上的
  // **同一份 turn usage** 被当成 N 条不同消息累加，Watch 自己转出的会话用量虚高 N 倍。
  const assistantMessage = (
    messageId: string,
    content: unknown[],
    stopReason: string | null,
    usage?: TokenUsage,
  ): Record<string, unknown> => ({
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: identity.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
  });

  const push = (record: Record<string, unknown>): void => {
    parentUuid = record.uuid as string;
    lines.push(JSON.stringify(record));
  };

  for (const turn of turns) {
    if (!turnHasContent(turn)) continue;
    if (turn.timestamp) lastTimestamp = turn.timestamp;

    if (turn.role === 'user') {
      userCount += 1;
      const record = baseRecord();
      record.type = 'user';
      const content: unknown[] = [{ type: 'text', text: turn.text }];
      for (const ev of turn.events ?? []) {
        const block = claudeImageBlock(ev);
        if (block) {
          content.push(block);
        } else if (ev.kind === 'text' && ev.attachment && ev.attachment.kind !== 'image') {
          // 非图片附件（如 opencode file part）：claude 无等价块，降级为占位文本，
          // 保证「不无声」——与 expectClaudeRoundTrip 的 user 侧变换对称
          const placeholder = (ev.detail ?? ev.summary ?? '').trim() || '[附件（无描述）]';
          content.push({ type: 'text', text: placeholder });
        }
      }
      record.message = { role: 'user', content };
      push(record);
      continue;
    }

    let lastCallId: string | undefined;
    // 同一条 turn 的所有 assistant 行共用一个 message.id（见 assistantMessage 上方注释）
    const messageId = newMsgId();
    const finalText = turn.text.trim();
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'text' && !ev.attachment && (ev.detail ?? ev.summary).trim() === finalText) continue;
      emitClaudeEvent(ev, {
        baseRecord,
        assistantMessage,
        push,
        lastCallId,
        messageId,
        setLastCallId: (id) => {
          lastCallId = id;
        },
        usage: turn.usage,
      });
    }
    if (turn.text.trim()) {
      const record = baseRecord();
      record.type = 'assistant';
      record.message = assistantMessage(messageId, [{ type: 'text', text: turn.text }], 'end_turn', turn.usage);
      push(record);
    }
  }
  if (userCount === 0 && (opts?.requireUser ?? true)) {
    throw new Error('没有可迁移的用户消息（无法构建可续聊的 Claude 会话）');
  }
  return lines;
}

/**
 * claude 写出侧的受控降级（round-trip 校验的期望模型）：
 * thinking 事件写为 `[思考] <detail>` 文本记录（伪造 thinking 块缺签名会破坏 resume），
 * parse 按同一前缀还原为 thinking 事件，因此期望模型只需丢掉加密/空思考；
 * 全空 turn 也随之消失（对齐 stripEmptyEvents）。
 */
function expectClaudeRoundTrip(turns: UnifiedTurn[]): UnifiedTurn[] {
  const out: UnifiedTurn[] = [];
  for (const t of turns) {
    if (t.role !== 'assistant') {
      // user 侧非图片附件 → 占位文本会进 turn.text（与 build 的降级对称），预测到文本里
      const filePlaces = (t.events ?? [])
        .filter((e) => e.kind === 'text' && e.attachment && e.attachment.kind !== 'image')
        .map((e) => (e.detail ?? e.summary ?? '[附件（无描述）]').trim());
      if (filePlaces.length === 0) {
        out.push(t);
      } else {
        // build 原样写 t.text、parse 按 `\n\n` 拼块；若这里 trim 掉末尾换行，
        // `"你好\n" + 附件` 写出后反解会多出空行，round-trip 会误判失配
        out.push({ ...t, text: [t.text, ...filePlaces].filter(Boolean).join('\n\n') });
      }
      continue;
    }
    const events = (t.events ?? []).filter((e) => {
      if (e.kind !== 'thinking') return true;
      const detail = (e.detail ?? e.summary ?? '').trim();
      return detail.length > 0 && detail !== ENCRYPTED_THINKING;
    });
    if (!t.text.trim() && events.length === 0) continue;
    // build 把「非图片附件」事件写成助手正文行（图片写成 image 块，不占正文）。
    // 正文为空时，反解回来的正文就是最后一条这样的文本；期望必须预测它，否则
    // 一次合法的附件降级会被 round-trip 拒绝（占位明明写进去了，校验却说文本不一致）。
    let expectedText = t.text;
    if (!t.text.trim()) {
      const rows = (t.events ?? [])
        .filter((e) => e.kind === 'text' && !(e.attachment && e.attachment.kind === 'image'))
        .map((e) => (e.detail ?? e.summary ?? '').trim())
        .filter((text) => text && !text.startsWith(WATCH_CONTEXT_DISCLOSURE_PREFIX));
      if (rows.length > 0) expectedText = rows.at(-1)!;
    }
    out.push({ ...t, text: expectedText, events });
  }
  return out;
}

function emitClaudeEvent(
  ev: ProcessEvent,
  ctx: {
    baseRecord: () => Record<string, unknown>;
    assistantMessage: (
      messageId: string,
      content: unknown[],
      stopReason: string | null,
      usage?: TokenUsage,
    ) => Record<string, unknown>;
    push: (record: Record<string, unknown>) => void;
    lastCallId: string | undefined;
    messageId: string;
    setLastCallId: (id: string) => void;
    usage?: TokenUsage;
  },
): void {
  if (ev.kind === 'thinking') {
    const thinking = (ev.detail ?? ev.summary).trim();
    if (!thinking || thinking === ENCRYPTED_THINKING) return;
    const record = ctx.baseRecord();
    record.type = 'assistant';
    // Watch 自己生成的降级思考行必须带标记：`[思考] ` 前缀在原生正文里同样可能出现，
    // 只凭前缀还原会把真正的回复误判成 thinking（正文随之改变、round-trip 也会拒绝）。
    // 标记写在记录顶层（与 message 内字段分开），parser 只认带标记的记录。
    record.watchGeneratedThinking = true;
    record.message = ctx.assistantMessage(ctx.messageId, [{ type: 'text', text: `${CLAUDE_THINKING_PREFIX}${thinking}` }], null, ctx.usage);
    ctx.push(record);
    return;
  }
  if (ev.kind === 'tool_call') {
    const callId = ev.callId || `call_${randomUUID()}`;
    ctx.setLastCallId(callId);
    const name = toClaudeToolName(ev.name ?? 'tool');
    const input =
      name === 'Bash'
        ? claudeBashInput(ev)
        : ev.input && typeof ev.input === 'object'
          ? ev.input
          : { input: ev.detail ?? ev.summary };
    const record = ctx.baseRecord();
    record.type = 'assistant';
    record.message = ctx.assistantMessage(ctx.messageId, [{ type: 'tool_use', id: callId, name, input }], 'tool_use', ctx.usage);
    ctx.push(record);
    return;
  }
  if (ev.kind === 'tool_result') {
    const callId = ev.callId || ctx.lastCallId || `call_${randomUUID()}`;
    const record = ctx.baseRecord();
    record.type = 'user';
    record.message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content: ev.detail ?? ev.summary,
          // 来源标注为失败的结果必须原样写成 `is_error`：以前一律写 false，于是
          // 「失败的 Edit」转入 Claude 后变成成功结果，再读回来时失败事实已经消失。
          is_error: ev.failed === true,
        },
      ],
    };
    ctx.push(record);
    return;
  }
  if (ev.kind === 'text') {
    const block = claudeImageBlock(ev);
    if (block) {
      const record = ctx.baseRecord();
      record.type = 'assistant';
      record.message = ctx.assistantMessage(ctx.messageId, [block], null, ctx.usage);
      ctx.push(record);
      return;
    }
    const text = (ev.detail ?? ev.summary).trim();
    if (!text) return;
    const record = ctx.baseRecord();
    record.type = 'assistant';
    record.message = ctx.assistantMessage(ctx.messageId, [{ type: 'text', text }], null, ctx.usage);
    ctx.push(record);
  }
}

/** 带 attachment 的 text 事件 → 还原原生 image block；非图片附件返回 null */
function claudeImageBlock(ev: ProcessEvent): Record<string, unknown> | null {
  const a = ev.attachment;
  if (!a || a.kind !== 'image') return null;
  if (typeof a.data === 'string') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data: a.data },
    };
  }
  if (typeof a.url === 'string') {
    return { type: 'image', source: { type: 'url', url: a.url } };
  }
  return null;
}

/**
 * 追加前扫描目标：末条 uuid（作 parentUuid）与本文件已登记的调用 ID。
 *
 * 调用 ID 用来挡住「增量里又出现目标已有的调用」：来源在调用之后补到结果时，
 * `turnKey` 里该助手轮的 callIds 会变化，`diffTurns` 会把整轮当作增量再给一次，
 * 直接追加会让同一调用在目标里出现两遍、结果配对随之失真（同一文件里重复 ID 会被
 * parse 判成歧义，后端校验的后缀回退还可能看不出问题）。这里只读、不改通用增量算法。
 */
async function scanClaudeTarget(filePath: string): Promise<{ lastUuid: string | null; callIds: Set<string> }> {
  let lastUuid: string | null = null;
  const callIds = new Set<string>();
  // 流式逐行：目标可能是大会话（本机实测有 663 MB 的一条），整份 readFile 会抛
  // `Invalid string length`——追加前的重复调用检查就会变成「目标读不出来」，写不进去。
  for await (const line of iterateFileLines(filePath)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // 原始行由原子追加完整保留；非对象不提供 uuid，也不能遮住其后的调用 ID。
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.uuid === 'string') lastUuid = record.uuid;
    if (record.type !== 'assistant') continue;
    const content = (record.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string') callIds.add(b.id);
    }
  }
  return { lastUuid, callIds };
}

/**
 * 追加写入的写前拒绝：增量里的 tool_call 一旦重用目标已有的调用 ID 就整次拒绝。
 * 不做 force 覆盖，也不替调用方重算增量——只保住目标文件，说清「本次未写入任何内容」。
 */
function assertNoReplayedCalls(turns: UnifiedTurn[], targetCallIds: Set<string>, filePath: string): void {
  const repeated = new Set<string>();
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (event.kind === 'tool_call' && event.callId && targetCallIds.has(event.callId)) repeated.add(event.callId);
    }
  }
  if (repeated.size === 0) return;
  const ids = [...repeated];
  const shown = ids.slice(0, 3).map((id) => escapeControlChars(id)).join('、');
  const more = ids.length > 3 ? ` 等 ${ids.length} 个` : '';
  throw new Error(
    `拒绝追加：目标会话 ${escapeControlChars(filePath)} 已包含相同的工具调用 ID（${shown}${more}）。` +
      '这些调用已经在目标里出现过，直接追加会重放调用、让结果失去配对；本次未写入任何内容。' +
      '如需确认这些调用在来源里的上下文，可用 watch prompt <来源会话 id> --profile full 查看；或另开一条新会话再交接。',
  );
}

/** 统一时间线 → 原生会话：无 into 则新建；有 into 且文件在则追加；replace 则整文件重写 */
export async function importTurnsToClaude(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${escapeControlChars(cwd)}`);
  }
  const projectsDir = claudeProjectsDir();
  const identity = await detectClaudeIdentity(projectsDir);

  if (into?.filePath && opts?.replace) {
    if (turns.length === 0) return into;
    await mkdir(path.dirname(into.filePath), { recursive: true });
    const lines = buildClaudeLines(turns, into.sessionId, cwd, identity);
    await writeFileAtomic(into.filePath, lines.join('\n') + '\n', {
      backup: true,
      verify: async (tmp) =>
        verifyWrittenTurns({ parse: (p) => parseClaudeSession({ ...into, filePath: p }), filePath: tmp, turns, provider: 'claude', expect: expectClaudeRoundTrip }),
    });
    return into;
  }

  if (into?.filePath) {
    try {
      await access(into.filePath);
      if (turns.length === 0) return into;
      const target = await scanClaudeTarget(into.filePath);
      assertNoReplayedCalls(turns, target.callIds, into.filePath);
      const lines = buildClaudeLines(turns, into.sessionId, cwd, identity, {
        parentUuid: target.lastUuid,
        requireUser: false,
      });
      if (lines.length === 0) return into;
      await appendFileAtomic(into.filePath, lines.join('\n') + '\n', {
        backup: true,
        verify: async (tmp) =>
          verifyWrittenTurns({
            parse: (p) => parseClaudeSession({ ...into, filePath: p }),
            filePath: tmp,
            turns,
            provider: 'claude',
            expect: expectClaudeRoundTrip,
          }),
      });
      return into;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const projectDir = path.join(projectsDir, encodeClaudeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });
  const sessionId = randomUUID();
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = buildClaudeLines(turns, sessionId, cwd, identity);
  await writeFileAtomic(filePath, lines.join('\n') + '\n', {
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseClaudeSession({ provider: 'claude', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'claude',
        expect: expectClaudeRoundTrip,
      }),
  });
  return { provider: 'claude', sessionId, filePath, cwd };
}
