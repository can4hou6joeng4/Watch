import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { streamCommand } from '../../core/streamCommand.js';
import { parseClaudeSession } from './parse.js';
import { claudeSessionUsage } from './usage.js';
import { claudeProjectsDir, encodeClaudeProjectDir, importTurnsToClaude } from './build.js';
import { claudeLineToProcessEvents, claudeResultFromStream } from './events.js';

const execFileAsync = promisify(execFile);

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** `listSessions` 单次上限：超出时只返回最新的这么多条（`watch doctor` 据此把计数标成下限） */
export const CLAUDE_LIST_LIMIT = 50;

/** 找 cwd 对应 projectDir 下 mtime 最新的 uuid 会话；目录不存在返回 null。projectsRoot 可注入供单测 */
export async function findLatestClaudeSession(
  cwd: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = projectsRoot ?? claudeProjectsDir();
  const projectDir = path.join(root, encodeClaudeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 这个 cwd 没聊过 = 目录不存在（null 是事实）；读不出来必须抛出，
    // 否则「权限 / 路径出错」会被讲成「这个目录没有会话」
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(
      `无法列出 Claude 会话目录 ${projectDir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let best: { filePath: string; sessionId: string; updatedAt: number } | null = null;
  for (const entry of entries) {
    if (!UUID_JSONL.test(entry)) continue;
    const filePath = path.join(projectDir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const updatedAt = st.mtimeMs;
      if (!best || updatedAt > best.updatedAt) {
        best = { filePath, sessionId: entry.replace(/\.jsonl$/i, ''), updatedAt };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 与 listClaudeSessions 同一规则：只有文件确实不在才跳过，读不出来要抛出
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new Error(
        `无法读取 Claude 会话文件状态 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!best) return null;
  return {
    ref: { provider: 'claude', sessionId: best.sessionId, filePath: best.filePath, cwd },
    updatedAt: best.updatedAt,
  };
}

/** 读 jsonl 前若干行里 user 消息携带的 cwd（目录名编码不可逆，cwd 只能从文件内容拿）。
 * `error` 区分「文件读不出来」与「内容里就没有 cwd」——反查时前者不能说成「会话不存在」 */
export async function claudeSessionCwdDetail(
  filePath: string,
): Promise<{ cwd: string | null; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { cwd: null, error: error instanceof Error ? error.message : String(error) };
  }
  const cwd = cwdFromClaudeRaw(raw);
  return cwd ? { cwd } : { cwd: null, error: '前 60 行里没有 cwd 字段' };
}

export async function claudeSessionCwd(filePath: string): Promise<string | null> {
  return (await claudeSessionCwdDetail(filePath)).cwd;
}

function cwdFromClaudeRaw(raw: string): string | null {
  for (const line of raw.split('\n').slice(0, 60)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    const msg = rec.message;
    if (typeof msg === 'object' && msg !== null && typeof (msg as { cwd?: unknown }).cwd === 'string') {
      return (msg as { cwd: string }).cwd;
    }
  }
  return null;
}

/**
 * 按原生 session id（UUID）全局反查 Claude 会话：扫各 cwd 的 projectDir，命中 uuid 文件后
 * 从文件内容读回 cwd。projectsRoot 可注入供单测。
 */
export async function findClaudeSessionById(
  sessionId: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  if (!UUID_JSONL.test(`${sessionId}.jsonl`)) return null;
  const root = projectsRoot ?? claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch (error) {
    // 扫不了根目录时不能返回 null（= 没有这个会话）：原因要交给 resolveById 的 diagnostics
    throw new Error(
      `无法列出 Claude 会话目录 ${root}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unreadable: string[] = [];
  const foundButUnreadable: string[] = [];
  for (const dir of dirs) {
    const filePath = path.join(root, dir, `${sessionId}.jsonl`);
    let st;
    try {
      st = await stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT / ENOTDIR：这个 projectDir 里没有该会话，正常跳过；其余是读不出来，要记下来
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unreadable.push(`${filePath}（${error instanceof Error ? error.message : String(error)}）`);
      }
      continue;
    }
    if (!st.isFile()) continue;
    const { cwd, error } = await claudeSessionCwdDetail(filePath);
    if (cwd) return { ref: { provider: 'claude', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    // 文件确实在，只是读不出 cwd：继续找同名副本，但结论不能是「会话不存在」
    foundButUnreadable.push(`${filePath}（${error ?? '原因未知'}）`);
  }
  if (foundButUnreadable.length) {
    throw new Error(`找到会话文件 ${foundButUnreadable[0]}，但读不出它的工作目录，无法确认会话 ${sessionId}`);
  }
  if (unreadable.length) {
    throw new Error(
      `在 ${root} 下没找到会话 ${sessionId}，但有 ${unreadable.length} 个位置读不出来，无法确认它是否存在：${unreadable[0]}`,
    );
  }
  return null;
}

/** cwd 对应 projectDir 下全部 uuid 会话，mtime 降序；preview 取首条用户消息 */
export async function listClaudeSessions(
  cwd: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = projectsRoot ?? claudeProjectsDir();
  const projectDir = path.join(root, encodeClaudeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 目录不存在 = 这个 cwd 没聊过；读不出来要抛出，让 sessions / recent / doctor 披露
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new Error(
      `无法读取 Claude 会话目录 ${projectDir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const entry of entries) {
    if (!UUID_JSONL.test(entry)) continue;
    const filePath = path.join(projectDir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      items.push({
        ref: { provider: 'claude', sessionId: entry.replace(/\.jsonl$/i, ''), filePath, cwd },
        updatedAt: st.mtimeMs,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 列目录到取状态之间被删掉算正常；其余读不出来（EACCES 等）不能静默跳过——
      // 整个目录都 stat 不出来时会被读成「这个 cwd 没聊过」
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new Error(
        `无法读取 Claude 会话文件状态 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(
    items.slice(0, CLAUDE_LIST_LIMIT).map(async (item) => ({
      ...item,
      preview: (await claudeFirstUserText(item.ref.filePath)) ?? undefined,
    })),
  );
}

async function claudeFirstUserText(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== 'user' || record.isMeta === true) continue;
      const message = record.message as Record<string, unknown> | undefined;
      const text =
        typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? (message.content as Record<string, unknown>[])
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join(' ')
            : '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) return clean.slice(0, 80);
    } catch {
      continue;
    }
  }
  return null;
}
/**
 * claude -p --output-format stream-json --verbose：逐行流式吐出过程事件（onEvent），
 * result 事件取最终回复与 session_id
 */
async function runClaude(
  args: string[],
  cwd: string,
  onEvent?: (e: ProcessEvent) => void,
): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    const out = await streamCommand(
      'claude',
      ['-p', ...args, '--output-format', 'stream-json', '--verbose'],
      { cwd, timeout: 600_000 },
      (line) => {
        if (onEvent) for (const e of claudeLineToProcessEvents(line)) onEvent(e);
      },
    );
    stdout = out.stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).slice(0, 500)
        : String(error);
    throw new Error(`claude CLI 调用失败: ${stderr}`);
  }
  const result = claudeResultFromStream(stdout);
  if (!result) {
    throw new Error(`claude 输出缺少 result 事件: ${stdout.slice(0, 500)}`);
  }
  if (result.is_error === true || typeof result.result !== 'string') {
    throw new Error(`claude 会话出错: ${stdout.slice(0, 500)}`);
  }
  return result;
}

const replyTurn = (text: string): UnifiedTurn => ({
  role: 'assistant',
  text,
  timestamp: new Date().toISOString(),
  provider: 'claude',
});

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('claude'), ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },

  parse: parseClaudeSession,
  importTurns: importTurnsToClaude,
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestClaudeSession,
  listSessions: (cwd) => listClaudeSessions(cwd),
  listSessionsCap: CLAUDE_LIST_LIMIT,

  /** nezha 式启动：预写一条占位 user 消息，`claude --resume <id>` 进 PTY 后可直接交互（不经 exec 等首条回复） */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    return importTurnsToClaude(
      [{ role: 'user', text: '我们开始吧。', timestamp: new Date().toISOString() }],
      cwd,
    );
  },

  /** 从零开聊：claude -p（不带 --resume）起新会话，从 result 事件取 session_id，文件路径可确定性推导 */
  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    const result = await runClaude([text], cwd, onEvent);
    const sessionId = result.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`claude 输出缺少 session_id: ${JSON.stringify(result).slice(0, 500)}`);
    }
    const ref: SessionRef = {
      provider: 'claude',
      sessionId,
      filePath: path.join(claudeProjectsDir(), encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`),
      cwd,
    };
    return { ref, turn: replyTurn(result.result as string) };
  },

  /** claude -p --resume stream-json，result 事件的 result 字段为最终回复 */
  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const result = await runClaude([text, '--resume', ref.sessionId], ref.cwd, onEvent);
    return replyTurn(result.result as string);
  },

  resumeCommand(ref: SessionRef): string {
    return `claude --resume ${ref.sessionId}`;
  },

  findById: findClaudeSessionById,

  sessionUsage: claudeSessionUsage,
};
