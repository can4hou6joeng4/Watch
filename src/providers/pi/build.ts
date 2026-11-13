import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { readTextOrEmpty } from '../../core/read-text.js';
import { assistantOnlyIncrementReason, assistantTurnTextForWrite, userTurnTextForWrite } from '../../core/rich.js';
import { expectAttachmentPlaceholders, verifyWrittenTurns } from '../../core/verify.js';
import { parsePiSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

export function piSessionsRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/** `/Users/foo/bar` → `--Users-foo-bar--`（与本机 pi 目录一致） */
export function encodePiProjectDir(cwd: string): string {
  const inner = cwd.replace(/^\//, '').replaceAll('/', '-');
  return `--${inner}--`;
}

function nid(): string {
  return randomBytes(4).toString('hex');
}

export async function importTurnsToPi(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  sessionsRoot?: string,
): Promise<SessionRef> {
  if (into && !opts?.replace) {
    const reason = assistantOnlyIncrementReason(turns);
    if (reason) throw new Error(reason);
  }
  if (!turns.some((t) => t.role === 'user' && userTurnTextForWrite(t).trim())) {
    throw new Error('没有可迁移的用户消息');
  }
  const root = sessionsRoot ?? piSessionsRoot();
  const dir = join(root, encodePiProjectDir(cwd));
  await mkdir(dir, { recursive: true });

  let sessionId = into?.sessionId ?? randomUUID();
  let filePath = into?.filePath ?? join(dir, `${isoFileStamp()}_${sessionId}.jsonl`);
  let parentId: string | null = null;
  // 既有行按原文保留（异常行不丢、不重写），新行才 JSON.stringify。
  // 以前追加分支对每一行裸 JSON.parse 后再整体重写：`null` / `[]` / 半截行会直接抛
  // SyntaxError 让整次追加失败，合法行也被压缩格式。
  const pieces: string[] = [];
  let hasSessionHeader = false;

  if (into && !opts?.replace) {
    const existing = await readTextOrEmpty(into.filePath);
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue;
      pieces.push(line);
      const rec = parseJsonObject(line);
      if (!rec) continue;
      if (rec.type === 'session') hasSessionHeader = true;
      // 只认真正解析得出的对象 id：坏行不遮住它之前最后一条合法消息
      if (typeof rec.id === 'string') parentId = rec.id;
    }
    sessionId = into.sessionId;
    filePath = into.filePath;
  } else if (into && opts?.replace) {
    const existing = await readTextOrEmpty(into.filePath);
    // 不能用 `includes('"type":"session"')`：普通消息的文本 / 嵌套对象里出现同一子串会被误认成头
    const headerLine = existing.split('\n').find((l) => parseJsonObject(l)?.type === 'session');
    if (headerLine) {
      const h = parseJsonObject(headerLine)!;
      pieces.push(headerLine);
      hasSessionHeader = true;
      if (typeof h.id === 'string') parentId = h.id;
    }
    filePath = into.filePath;
    sessionId = into.sessionId;
  }

  if (!hasSessionHeader) {
    const ts = new Date().toISOString();
    pieces.push(JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: ts, cwd }));
    parentId = sessionId;
  }

  for (const turn of turns) {
    if (turn.role === 'user') {
      parentId = pushMessage(pieces, parentId, 'user', turn.timestamp, [{ type: 'text', text: userTurnTextForWrite(turn) }]);
      continue;
    }
    const content: unknown[] = [];
    // 只搬正文：纯附件助手轮用占位文本兜底，否则这一轮写出空内容、原始数据也一并消失
    const bodyText = assistantTurnTextForWrite(turn);
    const hasToolEvents = turn.events?.some((e) => e.kind === 'tool_call' || e.kind === 'tool_result') ?? false;
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'thinking') {
        content.push({ type: 'thinking', thinking: ev.detail ?? ev.summary });
      } else if (ev.kind === 'tool_call') {
        content.push({
          type: 'toolCall',
          id: ev.callId ?? nid(),
          name: ev.name ?? 'tool',
          arguments: ev.input ?? {},
        });
      }
    }
    // 没有工具调用时，把 final text 直接放在 assistant 消息里；
    // 有工具调用时，为了避免 Pi TUI 把 final text 显示在 toolResult 消息之前，
    // 先只发 thinking/toolCall，再把 final text 作为一条独立 assistant 消息跟在 toolResult 后面。
    if (!hasToolEvents && bodyText.trim()) content.push({ type: 'text', text: bodyText });
    const assistantMsgId = pushMessage(pieces, parentId, 'assistant', turn.timestamp, content, undefined, turn.usage);
    parentId = assistantMsgId;
    let toolResultIndex = 0;
    for (const ev of turn.events ?? []) {
      if (ev.kind !== 'tool_result') continue;
      const baseMs = Date.parse(ev.timestamp || turn.timestamp) || Date.now();
      // 确保 tool_result message 时间严格晚于 assistant message，避免 Pi TUI 排序错乱
      const shifted = new Date(baseMs + 1000 + toolResultIndex * 100).toISOString();
      toolResultIndex += 1;
      parentId = pushMessage(pieces, parentId, 'toolResult', shifted, [
        { type: 'text', text: ev.detail ?? ev.summary },
      ], ev);
    }
    if (hasToolEvents && bodyText.trim()) {
      const finalTs = new Date((Date.parse(turn.timestamp) || Date.now()) + 2000 + toolResultIndex * 100).toISOString();
      parentId = pushMessage(pieces, parentId, 'assistant', finalTs, [{ type: 'text', text: bodyText }], undefined, turn.usage);
    }
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, pieces.join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parsePiSession({ provider: 'pi', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'pi',
        expect: expectAttachmentPlaceholders,
      }),
  });
  return { provider: 'pi', sessionId, filePath, cwd };
}

function pushMessage(
  out: string[],
  parentId: string | null,
  role: string,
  timestamp: string,
  content: unknown[],
  ev?: ProcessEvent,
  usage?: TokenUsage,
): string {
  const id = nid();
  const ts = timestamp || new Date().toISOString();
  const message: Record<string, unknown> = { role, content, timestamp: Date.parse(ts) || Date.now() };
  if (role === 'toolResult' && ev?.callId) {
    message.toolCallId = ev.callId;
    message.toolName = ev.name ?? 'tool';
    // 失败标记必须写回：pi 原生每条 toolResult 都带 `isError`（本机 1571 条里 30 条为
    // true），漏写会让失败结果在目标侧变成成功，再读回来时「哪次写入没生效」已经查不到。
    if (ev.failed === true) message.isError = true;
  }
  if (role === 'assistant') {
    // pi TUI footer 要求 assistant 消息必须带 usage，否则渲染时 uncaughtException 退出；
    // 有源侧真实 usage 时写入，否则仍以 0 占位兜底
    message.usage = {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    };
    message.provider = 'pi';
  }
  out.push(
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: ts,
      message,
    }),
  );
  return id;
}

function isoFileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}
