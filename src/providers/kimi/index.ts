import { execFile } from 'node:child_process';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import { describePathReadFailureReason, isMissingPathError } from '../../core/read-text.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { parseKimiSession } from './parse.js';
import {
  encodeKimiWorkspaceDir,
  importTurnsToKimi,
  kimidir,
  kimiSessionsRoot,
  listKimiSessionsByCwd,
} from './build.js';
import { describeSessionReadFailure } from '../../core/read-text.js';

const execFileAsync = promisify(execFile);

/** `listSessions` 单次上限：超出时只返回最新的这么多条（`watch doctor` 据此把计数标成下限） */
export const KIMI_LIST_LIMIT = 50;

export { encodeKimiWorkspaceDir, kimiSessionsRoot };

/** 从 stream-json 输出中提取 session_id 与最终 assistant 文本 */
function parseStreamJson(stdout: string): { sessionId?: string; text: string } {
  let sessionId: string | undefined;
  let text = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.role === 'meta' && event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      sessionId = event.session_id;
    } else if (event.role === 'assistant' && typeof event.content === 'string') {
      text = event.content;
    }
  }
  return { sessionId, text };
}

async function runKimi(args: string[], cwd: string): Promise<{ stdout: string; text: string }> {
  let stdout: string;
  try {
    const out = await execFileAsync(resolveCli('kimi'), [...args, '--output-format', 'stream-json'], {
      cwd,
      timeout: 600_000,
    });
    stdout = out.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
    if (err.code === 'ENOENT') {
      throw new Error('找不到 kimi code：当前进程 PATH 中没有 kimi 命令');
    }
    const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const detail = (pick(err.stderr) || pick(err.stdout) || err.message || String(error)).slice(0, 500);
    throw new Error(`kimi CLI 调用失败: ${detail}`);
  }
  const parsed = parseStreamJson(stdout);
  if (!parsed.text) {
    throw new Error(`kimi 输出中找不到 assistant 回复: ${stdout.slice(0, 500)}`);
  }
  return { stdout, text: parsed.text };
}

function refFromSessionId(sessionId: string, cwd: string): SessionRef {
  const workspaceId = encodeKimiWorkspaceDir(cwd);
  const filePath = path.join(kimiSessionsRoot(), workspaceId, sessionId, 'agents', 'main', 'wire.jsonl');
  return { provider: 'kimi', sessionId, filePath, cwd };
}

/** 取 wire.jsonl 首条用户消息作为预览 */
async function firstUserText(filePath: string): Promise<{ text: string | null; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 刚被删掉算正常；其余读不出来不能当成「这条会话还没有内容」（理由同 claude 适配器）
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: null };
    return { text: null, error: describePathReadFailureReason(error) };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'turn.prompt') continue;
    const input = event.input;
    if (!Array.isArray(input)) continue;
    for (const block of input) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
        const text = typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '';
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean) return { text: clean.slice(0, 80) };
      }
    }
  }
  return { text: null };
}

export async function findLatestKimiSession(
  cwd: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const all = await listKimiSessionsByCwd(cwd);
  const first = all[0];
  if (!first) return null;
  return {
    ref: { provider: 'kimi', sessionId: first.sessionId, filePath: path.join(first.sessionDir, 'agents', 'main', 'wire.jsonl'), cwd },
    updatedAt: first.updatedAt,
  };
}

export async function listKimiSessions(
  cwd: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string; previewError?: string }[]> {
  const all = await listKimiSessionsByCwd(cwd);
  return Promise.all(
    all.slice(0, KIMI_LIST_LIMIT).map(async (item) => {
      const wirePath = path.join(item.sessionDir, 'agents', 'main', 'wire.jsonl');
      const { text, error } = await firstUserText(wirePath);
      return {
        ref: {
          provider: 'kimi',
          sessionId: item.sessionId,
          filePath: wirePath,
          cwd,
        },
        updatedAt: item.updatedAt,
        preview: text ?? undefined,
        ...(error ? { previewError: error } : {}),
      };
    }),
  );
}

/**
 * 按原生 session id 全局反查 Kimi 会话：遍历 session_index.jsonl 匹配 sessionId，
 * 拿 workDir 作为 cwd。indexPath 可注入供单测（默认 ~/.kimi-code/session_index.jsonl）。
 */
export async function findKimiSessionById(
  sessionId: string,
  indexPath?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const idxFile = indexPath ?? path.join(kimidir(), 'session_index.jsonl');
  let raw: string;
  try {
    raw = await readFile(idxFile, 'utf8');
  } catch (error) {
    // 索引不存在 = 这台机器没用过 Kimi（或从未建过会话），按「没有这个会话」处理；
    // 其余（权限 / I/O）读不出来照常抛，原因交给 resolveById 的 diagnostics
    if (isMissingPathError(error)) return null;
    throw new Error(
      `无法读取 Kimi 会话索引 ${idxFile}：${describePathReadFailureReason(error)}`,
    );
  }
  const unreadable: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.sessionId !== sessionId) continue;
    const sessionDir = typeof rec.sessionDir === 'string' ? rec.sessionDir : '';
    const workDir = typeof rec.workDir === 'string' ? rec.workDir : '';
    if (!sessionDir || !workDir) {
      unreadable.push(`${idxFile} 里该会话缺少 sessionDir / workDir`);
      continue;
    }
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    try {
      const st = await stat(wirePath);
      // 路径在但不是普通文件（被同名目录 / 设备文件占住）：不能返回一个指向目录的 ref，
      // 否则这里报「找到了」，下游 parse / usage 才抛出裸 EISDIR（英文）
      if (!st.isFile()) {
        unreadable.push(`${wirePath} 现在不是普通文件（被同名目录或设备文件占住了）`);
        continue;
      }
      return { ref: { provider: 'kimi', sessionId, filePath: wirePath, cwd: workDir }, updatedAt: st.mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 索引里明确记着这个会话，wire 却没了 / 读不出来：都不是「会话不存在」
      unreadable.push(
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `${wirePath} 不存在（索引里有这条会话，可能已被删除）`
          : `${wirePath}（${describePathReadFailureReason(error)}）`,
      );
      continue;
    }
  }
  if (unreadable.length) {
    throw new Error(`Kimi 索引里有会话 ${sessionId}，但读不出它的会话文件，无法确认它是否可用：${unreadable[0]}`);
  }
  return null;
}

const replyTurn = (text: string): UnifiedTurn => ({
  role: 'assistant',
  text,
  timestamp: new Date().toISOString(),
  provider: 'kimi',
});

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Kimi 会话用量（信息层）：累加 wire.jsonl 里全部 `usage.record` → inputTokens/outputTokens。
 * input 含 inputOther + inputCacheRead + inputCacheCreation；无记录时返回 null（对齐无 usage 语义）。
 */
export async function kimiSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let raw: string;
  try {
    raw = await readFile(ref.filePath, 'utf8');
  } catch (error) {
    // 读不出来不等于「这家原生没有 usage 字段」：交给调用方按原因披露（chainUsage / open 都会写进 warnings）
    throw new Error(describeSessionReadFailure(ref.filePath, error));
  }
  let input = 0;
  let output = 0;
  let saw = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'usage.record') continue;
    const u = r.usage;
    if (typeof u !== 'object' || u === null) continue;
    const usage = u as Record<string, unknown>;
    input += toNum(usage.inputOther) + toNum(usage.inputCacheRead) + toNum(usage.inputCacheCreation);
    output += toNum(usage.output);
    saw = true;
  }
  return saw ? { inputTokens: input, outputTokens: output } : null;
}

export const kimiAdapter: ProviderAdapter = {
  id: 'kimi',
  displayName: 'Kimi',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('kimi'), ['--version'], { timeout: 10_000 });
      return true;
    } catch (error) {
      if (isCommandMissing(error)) return false;
      throw new Error(describeDetectFailure('kimi', error));
    }
  },

  // 新建会话真跑 `kimi -p .`（决策 A：fail-closed，不做离线自建会话）
  requiresCliForNewSession: true,
  parse: parseKimiSession,
  importTurns: importTurnsToKimi,
  sessionUsage: kimiSessionUsage,
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestKimiSession,
  listSessions: listKimiSessions,
  listSessionsCap: KIMI_LIST_LIMIT,

  /** nezha 式启动：新建真实会话并截断，返回可直接 `kimi -r` 的 ref */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    return importTurnsToKimi([], cwd);
  },

  /** 从零开聊：kimi -p text；用 stream-json 取 session_id 与回复 */
  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    const { stdout, text: replyText } = await runKimi(['-p', text], cwd);
    const parsed = parseStreamJson(stdout);
    if (!parsed.sessionId) {
      throw new Error(`kimi 输出缺少 session.resume_hint: ${stdout.slice(0, 500)}`);
    }
    if (onEvent) {
      // stream-json 当前不输出细粒度过程事件；如有需要后续可扩展
    }
    return { ref: refFromSessionId(parsed.sessionId, cwd), turn: replyTurn(replyText) };
  },

  /** 在当前会话中发送一条消息 */
  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const { text: replyText } = await runKimi(['-r', ref.sessionId, '-p', text], ref.cwd);
    if (onEvent) {
      // 同上
    }
    return replyTurn(replyText);
  },

  resumeCommand(ref: SessionRef): string {
    return `kimi -r ${ref.sessionId}`;
  },

  findById: findKimiSessionById,
};
