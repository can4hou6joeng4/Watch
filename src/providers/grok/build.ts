import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { mergeConsecutiveAssistant } from '../../core/rich.js';
import { parseGrokSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

export function grokSessionsRoot(): string {
  return path.join(homedir(), '.grok', 'sessions');
}

/** `/Users/foo/bar` → `%2FUsers%2Ffoo%2Fbar`（与 Grok 会话目录一致） */
export function encodeGrokProjectDir(cwd: string): string {
  return encodeURIComponent(cwd);
}

type ChatLine =
  | { type: 'system'; content: string }
  | { type: 'user'; content: Array<{ type: 'text'; text: string }>; synthetic_reason?: string }
  | {
      type: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; name: string; arguments: string }>;
      model_id?: string;
      model_fingerprint?: string;
      reasoning_effort?: string;
    }
  | { type: 'tool_result'; tool_call_id: string; content: string }
  | { type: 'reasoning'; id: string; summary: Array<{ type: 'summary_text'; text: string }>; encrypted_content?: string; status?: string }
  | { type: string };

function defaultModelId(): string {
  return 'grok-4.5-build-free';
}

type GrokIdentity = {
  modelId: string;
  agentName: string;
  reasoningEffort: string;
  sandboxProfile: string;
};

const DEFAULT_IDENTITY: GrokIdentity = {
  modelId: defaultModelId(),
  agentName: 'grok-build',
  reasoningEffort: 'high',
  sandboxProfile: 'off',
};

/** ACP 事件 id 形态：uuid + '-' + 1 位（与原生 updates.jsonl 一致） */
function acpEventId(): string {
  return `${randomUUID()}-0`;
}

/**
 * 一行 ACP 会话更新。`updates.jsonl` 是原生 `/resume` 与 session restore 的权威会话日志
 * （见 grok 内置文档 docs/user-guide/17-sessions.md），只写 chat_history.jsonl 会让原生
 * 打开/恢复时看不到任何对话。timestamp 为 epoch 秒，_meta.agentTimestampMs 为毫秒。
 */
function acpLine(sessionId: string, update: Record<string, unknown>, atMs: number): string {
  const ms = Number.isFinite(atMs) ? atMs : Date.now();
  return JSON.stringify({
    timestamp: Math.floor(ms / 1000),
    method: 'session/update',
    params: { sessionId, update, _meta: { eventId: acpEventId(), agentTimestampMs: ms } },
  });
}

function systemLine(): ChatLine {
  return {
    type: 'system',
    content:
      'You are Grok, an interactive CLI assistant. Help the user with software engineering tasks.',
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function hashCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

function slugFromCwd(cwd: string): string {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20) || 'workspace';
  return `${base}-${hashCwd(cwd).slice(0, 8)}`;
}

async function readChatLines(filePath: string): Promise<ChatLine[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  const lines: ChatLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as ChatLine);
    } catch {
      // ignore malformed
    }
  }
  return lines;
}

async function readSummary(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 本机最近的 grok 会话 summary.json（按 mtime 降序）；用于探测原生身份 */
async function newestSummaryPaths(sessionsRoot: string, max: number): Promise<string[]> {
  let cwdDirs: import('node:fs').Dirent[];
  try {
    cwdDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { file: string; mtime: number }[] = [];
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(path.join(sessionsRoot, cwdDir.name));
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      const file = path.join(sessionsRoot, cwdDir.name, sessionId, 'summary.json');
      const mtime = (await stat(file).catch(() => undefined))?.mtimeMs;
      if (mtime !== undefined) found.push({ file, mtime });
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((x) => x.file);
}

/**
 * 从本机最近的 grok 会话探测身份（model / agent / effort / sandbox）。
 * 原生 `/resume` 会读这些字段；硬编码一个本机不存在的 model id 会让会话与当前配置不一致。
 * 探测不到就退回默认值，不阻断写入。
 */
async function detectGrokIdentity(sessionsRoot: string): Promise<GrokIdentity> {
  for (const file of await newestSummaryPaths(sessionsRoot, 5)) {
    const summary = await readSummary(file);
    if (!summary) continue;
    const modelId = typeof summary.current_model_id === 'string' ? summary.current_model_id.trim() : '';
    if (!modelId) continue;
    const pick = (key: keyof GrokIdentity, fallback: string): string => {
      const value = summary[key === 'modelId' ? 'current_model_id' : key === 'agentName' ? 'agent_name' : key === 'reasoningEffort' ? 'reasoning_effort' : 'sandbox_profile'];
      return typeof value === 'string' && value.trim() ? value.trim() : fallback;
    };
    return {
      modelId,
      agentName: pick('agentName', DEFAULT_IDENTITY.agentName),
      reasoningEffort: pick('reasoningEffort', DEFAULT_IDENTITY.reasoningEffort),
      sandboxProfile: pick('sandboxProfile', DEFAULT_IDENTITY.sandboxProfile),
    };
  }
  return { ...DEFAULT_IDENTITY };
}

export async function findLatestGrokSession(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
  const all = await listGrokSessions(cwd, sessionsRoot);
  return all[0] ?? null;
}

export async function listGrokSessions(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = sessionsRoot ?? grokSessionsRoot();
  const dir = path.join(root, encodeGrokProjectDir(cwd));
  let entries: string[] = [];
  try {
    entries = (await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const items: { ref: SessionRef; updatedAt: number; preview?: string }[] = [];
  for (const id of entries) {
    const summaryPath = path.join(dir, id, 'summary.json');
    const summary = await readSummary(summaryPath);
    const updatedAtRaw =
      summary?.updated_at ?? summary?.last_active_at ?? summary?.created_at;
    let updatedAt = 0;
    if (typeof updatedAtRaw === 'string') {
      updatedAt = Date.parse(updatedAtRaw) || 0;
    } else if (typeof updatedAtRaw === 'number') {
      updatedAt = updatedAtRaw;
    }
    if (!updatedAt) {
      // 旧版 Grok 会话目录没有 summary.json，用 chat_history.jsonl mtime 兜底，否则排序全 0 不稳定
      updatedAt = (await stat(path.join(dir, id, 'chat_history.jsonl')).catch(() => undefined))?.mtimeMs ?? 0;
    }
    const preview =
      typeof summary?.generated_title === 'string'
        ? summary.generated_title
        : typeof summary?.session_summary === 'string'
          ? summary.session_summary
          : undefined;
    items.push({
      ref: { provider: 'grok', sessionId: id, filePath: path.join(dir, id, 'chat_history.jsonl'), cwd },
      updatedAt,
      preview,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/**
 * 按原生 session id 全局反查 Grok 会话：遍历各 cwd 的编码目录，命中 <id>/ 即解码出 cwd
 * （目录名 URL 编码可逆）；summary.json 里若声明了 cwd 则以其为准。sessionsRoot 可注入供单测。
 */
export async function findGrokSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
  const root = sessionsRoot ?? grokSessionsRoot();
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let dirCwd: string;
    try {
      dirCwd = decodeURIComponent(d.name);
    } catch {
      continue;
    }
    const sessionDir = path.join(root, d.name, sessionId);
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    try {
      const st = await stat(chatPath);
      if (!st.isFile()) continue;
      const summary = await readSummary(path.join(sessionDir, 'summary.json'));
      const info = summary?.info;
      const summaryCwd = typeof info === 'object' && info !== null ? (info as { cwd?: unknown }).cwd : undefined;
      const cwd = typeof summaryCwd === 'string' && summaryCwd ? summaryCwd : dirCwd;
      const preview =
        typeof summary?.generated_title === 'string'
          ? summary.generated_title
          : typeof summary?.session_summary === 'string'
            ? summary.session_summary
            : undefined;
      return {
        ref: { provider: 'grok', sessionId, filePath: chatPath, cwd },
        updatedAt: st.mtimeMs,
        preview,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** 在 Grok sessions 目录下建一个可 resume 的空会话 */
export async function createEmptyGrokSession(cwd: string, sessionsRoot?: string): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  const sessionId = randomUUID();
  const root = sessionsRoot ?? grokSessionsRoot();
  const identity = await detectGrokIdentity(root);
  const dir = path.join(root, encodeGrokProjectDir(cwd), sessionId);
  await mkdir(dir, { recursive: true });
  const now = isoNow();
  const chatPath = path.join(dir, 'chat_history.jsonl');
  const summaryPath = path.join(dir, 'summary.json');
  await writeFile(chatPath, JSON.stringify(systemLine()) + '\n', 'utf8');
  // 空 updates.jsonl：原生靠它识别可恢复会话（缺失时 sessions/export 会当成找不到）
  await writeFile(path.join(dir, 'updates.jsonl'), '', 'utf8');
  const summary = {
    info: { id: sessionId, cwd },
    session_summary: `Imported - ${now}`,
    created_at: now,
    updated_at: now,
    num_messages: 1,
    num_chat_messages: 0,
    current_model_id: identity.modelId,
    next_trace_turn: 1,
    chat_format_version: 1,
    request_id: randomUUID(),
    grok_home: path.join(homedir(), '.grok'),
    last_active_at: now,
    generated_title: `Imported - ${now}`,
    agent_name: identity.agentName,
    sandbox_profile: identity.sandboxProfile,
    reasoning_effort: identity.reasoningEffort,
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return { provider: 'grok', sessionId, filePath: chatPath, cwd };
}

function toolInputString(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input ?? '{}');
  }
}

function toolOutputString(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function buildAssistantLine(text: string, toolCalls: ProcessEvent[], modelId: string): ChatLine {
  const line: ChatLine = {
    type: 'assistant',
    content: text,
    model_id: modelId,
    reasoning_effort: 'high',
  };
  if (toolCalls.length > 0) {
    (line as { tool_calls?: Array<{ id: string; name: string; arguments: string }> }).tool_calls =
      toolCalls.map((ev) => ({
        id: ev.callId || `call_${randomUUID()}`,
        name: ev.name || 'tool',
        arguments: toolInputString(ev.input),
      }));
  }
  return line;
}

function buildToolResultLine(ev: ProcessEvent): ChatLine {
  return {
    type: 'tool_result',
    tool_call_id: ev.callId || 'unknown',
    content: toolOutputString(ev.detail ?? ev.summary ?? ''),
  };
}

function buildReasoningLine(ev: ProcessEvent): ChatLine {
  return {
    type: 'reasoning',
    id: `rs_${randomUUID()}`,
    summary: [{ type: 'summary_text', text: ev.detail ?? ev.summary ?? '思考中…' }],
    status: 'completed',
  };
}

/** updates.jsonl 的非空行（原样保留，用于追加） */
async function readRawLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line.trim() !== '');
}

function countUserChunks(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.includes('"sessionUpdate":"user_message_chunk"')) count += 1;
  }
  return count;
}

/**
 * UnifiedTurn[] → ACP 会话更新流行（updates.jsonl）。
 * 与 chat_history.jsonl 写同一份内容：chat 是发给 model 的原始消息，updates 才是原生恢复用的日志。
 * 每个 user 轮以 user_message_chunk 起、turn_completed 收尾，assistant 侧写思考/工具/文本。
 */
export function buildGrokUpdateLines(
  turns: UnifiedTurn[],
  sessionId: string,
  modelId: string,
  startPromptIndex: number,
  fallbackMs: number,
): string[] {
  const lines: string[] = [];
  let promptIndex = startPromptIndex;
  let drift = 0;
  const at = (timestamp: string): number => {
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) ? ms : fallbackMs + (drift += 1000);
  };

  for (const turn of turns) {
    if (!turn.text.trim() && (turn.events?.length ?? 0) === 0) continue;
    const ms = at(turn.timestamp);
    if (turn.role === 'user') {
      lines.push(
        acpLine(
          sessionId,
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: turn.text },
            _meta: { modelId, promptIndex },
          },
          ms,
        ),
      );
      promptIndex += 1;
      continue;
    }

    const events = turn.events ?? [];
    for (const ev of events) {
      if (ev.kind !== 'thinking') continue;
      const text = (ev.detail ?? ev.summary ?? '').trim();
      if (!text) continue;
      lines.push(
        acpLine(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }, ms),
      );
    }

    const resultByCallId = new Map<string, ProcessEvent>();
    for (const ev of events) {
      if (ev.kind === 'tool_result' && ev.callId) resultByCallId.set(ev.callId, ev);
    }
    for (const ev of events) {
      if (ev.kind !== 'tool_call') continue;
      const callId = ev.callId || `call_${randomUUID()}`;
      const name = ev.name || 'tool';
      const rawInput =
        typeof ev.input === 'string' ? ev.input : (ev.input ?? { input: toolInputString(ev.input) });
      const toolMeta = { version: 1, name, kind: 'other', namespace: 'grok_build', label: name, read_only: false };
      lines.push(
        acpLine(
          sessionId,
          { sessionUpdate: 'tool_call', toolCallId: callId, title: name, rawInput, _meta: { 'x.ai/tool': toolMeta } },
          ms,
        ),
      );
      const result = resultByCallId.get(callId);
      resultByCallId.delete(callId);
      lines.push(
        acpLine(
          sessionId,
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            kind: 'other',
            title: name,
            locations: [],
            rawInput,
            ...(result ? { rawOutput: toolOutputString(result.detail ?? result.summary ?? '') } : {}),
            _meta: { 'x.ai/tool': toolMeta },
          },
          ms,
        ),
      );
    }

    if (turn.text.trim()) {
      lines.push(
        acpLine(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.text } }, ms),
      );
    }

    const inputTokens = turn.usage?.inputTokens ?? 0;
    const outputTokens = turn.usage?.outputTokens ?? 0;
    lines.push(
      acpLine(
        sessionId,
        {
          sessionUpdate: 'turn_completed',
          prompt_id: randomUUID(),
          stop_reason: 'end_turn',
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        },
        ms,
      ),
    );
  }
  return lines;
}

/** 把 UnifiedTurn[] 写成 Grok chat_history.jsonl */
export async function importTurnsToGrok(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  sessionsRoot?: string,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  if (!turns.some((t) => t.role === 'user' && t.text.trim())) {
    throw new Error('没有可迁移的用户消息');
  }
  // grok 格式无「连续 assistant 轮」概念（parse 的 ensureAssistant 会并回上一轮），
  // 导入前先合并，保证写回内容能被自家 parse 对称还原
  turns = mergeConsecutiveAssistant(turns);

  const ref = into ?? (await createEmptyGrokSession(cwd, sessionsRoot));
  const chatPath = ref.filePath;
  const updatesPath = path.join(path.dirname(chatPath), 'updates.jsonl');
  const summaryPath = path.join(path.dirname(chatPath), 'summary.json');
  const identity = await detectGrokIdentity(sessionsRoot ?? grokSessionsRoot());
  const modelId = identity.modelId;

  let existing: ChatLine[] = [];
  if (into && !opts?.replace) {
    existing = await readChatLines(chatPath);
  }
  if (opts?.replace) {
    existing = [systemLine()];
  }
  if (existing.length === 0) {
    existing = [systemLine()];
  }

  const system = existing.find((l) => (l as { type?: string }).type === 'system') ?? systemLine();
  const kept = opts?.replace ? [system] : existing;

  const out: ChatLine[] = [...kept];
  let chatMsgCount = out.filter((l) => ['user', 'assistant'].includes((l as { type?: string }).type || '')).length;

  for (const turn of turns) {
    // 全空 turn（无文本无事件）写回后会被 parse 与后继合并成非空轮，与 verify 的输入侧
    // 过滤不对称，round-trip 会误报——与 verifyWrittenTurns 的 wanted 过滤保持一致
    if (!turn.text.trim() && (turn.events?.length ?? 0) === 0) continue;
    if (turn.role === 'user') {
      out.push({ type: 'user', content: [{ type: 'text', text: turn.text }] });
      chatMsgCount += 1;
      continue;
    }

    const thinkingEvents: ProcessEvent[] = [];
    const toolCalls: ProcessEvent[] = [];
    const toolResults: ProcessEvent[] = [];
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'thinking') thinkingEvents.push(ev);
      else if (ev.kind === 'tool_call') toolCalls.push(ev);
      else if (ev.kind === 'tool_result') toolResults.push(ev);
    }

    for (const ev of thinkingEvents) {
      out.push(buildReasoningLine(ev));
    }

    if (toolCalls.length > 0) {
      // Grok TUI 期望 tool_calls 所在的 assistant 行 content 为空，
      // 最终文本单独作为下一条 assistant 行跟在 tool_result 后面。
      out.push(buildAssistantLine('', toolCalls, modelId));
      chatMsgCount += 1;

      // tool_result 按 callId 紧随对应 tool_call 之后
      const resultByCallId = new Map<string, ProcessEvent>();
      for (const ev of toolResults) {
        if (ev.callId) resultByCallId.set(ev.callId, ev);
      }
      for (const ev of toolCalls) {
        const result = ev.callId ? resultByCallId.get(ev.callId) : undefined;
        if (result) {
          out.push(buildToolResultLine(result));
          resultByCallId.delete(ev.callId!);
        }
      }
      // 未配对的 tool_result 也补上，避免丢信息
      for (const ev of resultByCallId.values()) {
        out.push(buildToolResultLine(ev));
      }

      if (turn.text.trim()) {
        out.push(buildAssistantLine(turn.text, [], modelId));
        chatMsgCount += 1;
      }
    } else {
      out.push(buildAssistantLine(turn.text, [], modelId));
      chatMsgCount += 1;
    }
  }

  await writeFileAtomic(chatPath, out.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseGrokSession({ ...ref, filePath: p }),
        filePath: tmp,
        turns,
        provider: 'grok',
      }),
  });

  // ACP 日志：原生 /resume 与 session restore 读这里；追加时保留既有行（与 chat_history 对称）
  const existingUpdates = opts?.replace ? [] : await readRawLines(updatesPath);
  const updateLines = buildGrokUpdateLines(turns, ref.sessionId, modelId, countUserChunks(existingUpdates), Date.now());
  const nextUpdates = [...existingUpdates, ...updateLines];
  if (updateLines.length > 0 || opts?.replace) {
    await writeFileAtomic(updatesPath, nextUpdates.join('\n') + (nextUpdates.length ? '\n' : ''), {
      backup: Boolean(into?.filePath),
    });
  }

  const summary = (await readSummary(summaryPath)) ?? {
    info: { id: ref.sessionId, cwd },
    session_summary: `Imported - ${isoNow()}`,
    created_at: isoNow(),
  };
  const now = isoNow();
  summary.updated_at = now;
  summary.last_active_at = now;
  summary.num_messages = out.length;
  summary.num_chat_messages = chatMsgCount;
  summary.current_model_id = modelId;
  summary.grok_home = path.join(homedir(), '.grok');
  // 身份字段只在缺失时补：已有原生会话的 agent_name / effort 属于它自己的创建者，不覆盖
  if (typeof summary.agent_name !== 'string' || !summary.agent_name) summary.agent_name = identity.agentName;
  if (typeof summary.reasoning_effort !== 'string' || !summary.reasoning_effort) {
    summary.reasoning_effort = identity.reasoningEffort;
  }
  if (typeof summary.sandbox_profile !== 'string' || !summary.sandbox_profile) {
    summary.sandbox_profile = identity.sandboxProfile;
  }
  if (!summary.info || typeof summary.info !== 'object') {
    summary.info = { id: ref.sessionId, cwd };
  } else {
    (summary.info as Record<string, unknown>).id = ref.sessionId;
    (summary.info as Record<string, unknown>).cwd = cwd;
  }
  // summary 由 chat 派生、可再生：chat 写成功后再写，半写窗口内 chat 始终完整
  await writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));

  return ref;
}
