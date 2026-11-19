import { execFile } from 'node:child_process';
import { quoteCommandArg } from '../../core/shell-quote.js';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import { describeEmptySessionFile, describePathReadFailureReason, isMissingPathError, iterateFileLines, readTextHeadDetail } from '../../core/read-text.js';
import type { TextHeadDetail } from '../../core/read-text.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import { clipCodePoints, escapeControlChars } from '../../core/display.js';
import { SessionLookupFailureError } from '../adapter.js';
import { directoryWriteChecks } from '../directory-preflight.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { streamCommand } from '../../core/streamCommand.js';
import { parseClaudeSession } from './parse.js';
import { claudeSessionUsage } from './usage.js';
import { claudeConfigDir, claudeProjectsDir, encodeClaudeProjectDir, importTurnsToClaude } from './build.js';
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
      `无法列出 Claude 会话目录 ${escapeControlChars(projectDir)}：${describePathReadFailureReason(error)}`,
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
        `无法读取 Claude 会话文件状态 ${escapeControlChars(filePath)}：${describePathReadFailureReason(error)}`,
      );
    }
  }
  if (!best) return null;
  return {
    ref: { provider: 'claude', sessionId: best.sessionId, filePath: best.filePath, cwd },
    updatedAt: best.updatedAt,
  };
}

export type ClaudeCwdDetail = {
  cwd: string | null;
  error?: string;
  /** 没找到 cwd 时这次到底查了多少：`complete` = 整份文件，`window` = 只有头部窗口 */
  scan?: 'complete' | 'window';
};

/** 读 jsonl 前若干行里 user 消息携带的 cwd（目录名编码不可逆，cwd 只能从文件内容拿）。
 * `error` 区分「文件读不出来」「文件里确实没有 cwd」与「只查了头部窗口、没覆盖到」——
 * 反查 / 官方导入都靠它说话，不能把未检查的范围讲成字段不存在 */
export async function claudeSessionCwdDetail(filePath: string): Promise<ClaudeCwdDetail> {
  let head: TextHeadDetail;
  try {
    // 只读头部：cwd 在记录的最前面几十行里，而真实会话可能大到超过 V8 的字符串上限
    // （本机实测有一条 695 MB，`readFile(..., 'utf8')` 抛 `Invalid string length`，
    // 被讲成「读不出工作目录，先修好这条会话」——文件其实完好，只是不该整份读进内存）。
    head = await readTextHeadDetail(filePath, CWD_HEAD_BYTES);
  } catch (error) {
    return { cwd: null, error: describePathReadFailureReason(error) };
  }
  // 只有真读到 0 字节才是「内容已丢失」：文件非空却一个字符都解码不出来是另一档，
  // 以前按解码后长度判 0 字节，一块坏字节就会被讲成「进程被杀、内容已丢失」
  if (head.bytesRead === 0) return { cwd: null, error: describeEmptySessionFile(filePath) };
  if (head.text.length === 0) {
    return {
      cwd: null,
      error:
        `会话文件不是可解码的 UTF-8 文本（已读到 ${head.bytesRead} 字节，解不出任何字符，` +
        `不是 0 字节）：${escapeControlChars(filePath)}`,
    };
  }
  // 只解析窗口里**完整**的行：窗口末尾半行既解析不了，也不能算「查过」
  const segments = head.text.split('\n');
  const endsWithNewline = head.text.endsWith('\n');
  const completeLines = endsWithNewline || head.truncated ? segments.slice(0, -1) : segments;
  const parsedLines = completeLines.slice(0, CWD_MAX_LINES);
  const cwd = cwdFromClaudeLines(parsedLines);
  if (cwd) return { cwd };
  // 整份文件都读到了、且没有超过「只解析前 60 行」的上限：这才是「文件里确实没有」
  const complete = !head.truncated && completeLines.length <= CWD_MAX_LINES;
  return { cwd: null, error: describeMissingCwd(filePath, completeLines.length, head), scan: complete ? 'complete' : 'window' };
}

/** 没找到 cwd 时如实说明**实际检查了多少**：整份文件、前 60 行、还是只有头部窗口里那几行 */
function describeMissingCwd(filePath: string, totalLines: number, head: TextHeadDetail): string {
  if (head.truncated) {
    if (totalLines === 0) {
      return (
        '文件头部 64 KB 里没有完整的一行（首条记录就超过读取窗口），无法判断有没有 cwd 字段；' +
        '文件更大，窗口之外还有内容'
      );
    }
    if (totalLines <= CWD_MAX_LINES) {
      return `文件头部 64 KB（前 ${totalLines} 行）里没有 cwd 字段；文件更大，窗口之外还有内容`;
    }
    return (
      `文件头部 64 KB 的前 ${CWD_MAX_LINES} 行里没有 cwd 字段（窗口内共 ${totalLines} 行）；` +
      '文件更大，窗口之外还有内容'
    );
  }
  if (totalLines <= CWD_MAX_LINES) return `文件共 ${totalLines} 行，没有 cwd 字段`;
  return `文件共 ${totalLines} 行，前 ${CWD_MAX_LINES} 行里没有 cwd 字段（其余 ${totalLines - CWD_MAX_LINES} 行未解析）`;
}

/**
 * cwd 探测读多少字节。Claude 的首条 user 记录通常在前几 KB 内，64 KB 一般足够；
 * 但它**不保证**覆盖前 60 行——首条记录就超过窗口时只能如实说窗口内没有，不能声称查过 60 行。
 */
const CWD_HEAD_BYTES = 64 * 1024;

/** cwd 探测最多解析多少行（窗口覆盖更多行时也只解析这些） */
const CWD_MAX_LINES = 60;

export async function claudeSessionCwd(filePath: string): Promise<string | null> {
  return (await claudeSessionCwdDetail(filePath)).cwd;
}

function cwdFromClaudeLines(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    // 顶层 null / 数组 / 标量不是记录：以前直接把 JSON.parse 结果当对象读 `rec.cwd`，
    // 首行是 `null` 时 TypeError 会被外层 catch 讲成「路径读不出来」，与真实原因无关。
    const rec = parseJsonObject(line);
    if (!rec) continue;
    if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    const msg = asJsonObject(rec.message);
    if (typeof msg?.cwd === 'string') return msg.cwd;
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
    // 根目录不存在 = 这台机器没用过 Claude Code，按「没有这个会话」处理；
    // 其余（权限 / I/O）读不出来照常抛，原因交给 resolveById 的 diagnostics
    if (isMissingPathError(error)) return null;
    throw new SessionLookupFailureError(
      'incomplete',
      `无法列出 Claude 会话目录 ${escapeControlChars(root)}：${describePathReadFailureReason(error)}`,
    );
  }
  const unreadable: string[] = [];
  const foundButUnreadable: string[] = [];
  const notRegularFile: string[] = [];
  for (const dir of dirs) {
    const filePath = path.join(root, dir, `${sessionId}.jsonl`);
    let st;
    try {
      st = await stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT / ENOTDIR：这个 projectDir 里没有该会话，正常跳过；其余是读不出来，要记下来
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unreadable.push(`${escapeControlChars(filePath)}（${describePathReadFailureReason(error)}）`);
      }
      continue;
    }
    // 路径在但不是普通文件（被同名目录 / 设备文件占住）：会话确实存在，只是读不出来。
    // 静默 continue 会让最终返回 null 变成「这家没有这个会话」，把人引去核对 id
    if (!st.isFile()) {
      notRegularFile.push(escapeControlChars(filePath));
      continue;
    }
    const { cwd, error } = await claudeSessionCwdDetail(filePath);
    if (cwd) return { ref: { provider: 'claude', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    // 文件确实在，只是读不出 cwd：继续找同名副本，但结论不能是「会话不存在」
    foundButUnreadable.push(`${escapeControlChars(filePath)}（${error ?? '原因未知'}）`);
  }
  if (notRegularFile.length) {
    throw new SessionLookupFailureError(
      'found-unreadable',
      `会话 ${sessionId} 的路径现在不是普通文件（被同名目录或设备文件占住了）：${notRegularFile[0]}；无法把它当作会话读取，请先恢复该路径再重试`,
    );
  }
  if (foundButUnreadable.length) {
    throw new SessionLookupFailureError(
      'found-unreadable',
      `找到会话文件 ${foundButUnreadable[0]}，但读不出它的工作目录，无法确认会话 ${sessionId}`,
    );
  }
  if (unreadable.length) {
    throw new SessionLookupFailureError(
      'incomplete',
      `在 ${escapeControlChars(root)} 下没找到会话 ${sessionId}，但有 ${unreadable.length} 个位置读不出来，无法确认它是否存在：${unreadable[0]}`,
    );
  }
  return null;
}

/** cwd 对应 projectDir 下全部 uuid 会话，mtime 降序；preview 取首条用户消息 */
export async function listClaudeSessions(
  cwd: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string; previewError?: string }[]> {
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
      `无法读取 Claude 会话目录 ${escapeControlChars(projectDir)}：${describePathReadFailureReason(error)}`,
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
        `无法读取 Claude 会话文件状态 ${escapeControlChars(filePath)}：${describePathReadFailureReason(error)}`,
      );
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(
    items.slice(0, CLAUDE_LIST_LIMIT).map(async (item) => {
      const { text, error } = await claudeFirstUserText(item.ref.filePath);
      return { ...item, preview: text ?? undefined, ...(error ? { previewError: error } : {}) };
    }),
  );
}

async function claudeFirstUserText(filePath: string): Promise<{ text: string | null; error?: string }> {
  // 0 字节要单独判：流式读取对空文件没有任何行，走到底会说「还没有用户消息」，
  // 而这条文件其实是内容已丢失（open / switch 同样读不了它）。
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 列目录 / stat 到读文件之间被删掉算正常（列表本来就来自一次快照）；其余读不出来不能
    // 当成「这条会话还没有内容」——两者在 sessions / recent 里长得一模一样，而后者意味着
    // open / switch 也读不了它。原因交给调用方披露，适配器只负责不说谎。
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: null };
    return { text: null, error: describePathReadFailureReason(error) };
  }
  // 0 字节不是「还没有用户消息」：内容已经没了，open / switch 同样读不了它
  if (size === 0) return { text: null, error: describeEmptySessionFile(filePath) };
  try {
    // 逐行流式读取，命中首条用户消息就停：整份 readFile 在 >512 MB 的会话上抛
    // `Invalid string length`（本机 663 MB 实测），而预览只需要最前面几条记录。
    for await (const line of iterateFileLines(filePath)) {
      if (!line.trim()) continue;
      const record = parseJsonObject(line);
      if (!record || record.type !== 'user' || record.isMeta === true) continue;
      const message = asJsonObject(record.message);
      // content 数组里可能有 null / 标量：逐项判对象，否则单个 null 元素会让整条
      // 首条用户消息被 catch 吞掉，第二条消息错占预览。
      const text =
        typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? message.content
                .map((b) => asJsonObject(b))
                .filter((b): b is Record<string, unknown> => b !== null)
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join(' ')
            : '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) return { text: clipCodePoints(clean, 80).text };
    }
  } catch (error) {
    // 上面 stat 成功后文件仍可能读不出来（权限、I/O、边读边删），照样不能讲成「没有预览」
    return { text: null, error: describePathReadFailureReason(error) };
  }
  return { text: null };
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
  claudeConfigDir(); // 发送或新建都必须在启动原生进程之前检查目录变量。
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
  ...directoryWriteChecks('claude', claudeProjectsDir),

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('claude'), ['--version'], { timeout: 10_000 });
      return true;
    } catch (error) {
      // 只有「命令不存在」才是没装；装了但起不来要抛出去，让上游报「检测失败」而不是「未检测到」
      if (isCommandMissing(error)) return false;
      throw new Error(describeDetectFailure('claude', error));
    }
  },

  parse: parseClaudeSession,
  importTurns: importTurnsToClaude,
  // 只还原 image block；文件类附件（如 OpenCode 的 file part）没有等价块，build 降级为占位文本
  attachmentSupport: 'images',
  textEventSupport: 'assistant',
  toolFailureSupport: 'assistant',
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

  resumeCommand(ref: SessionRef, windows?: boolean): string {
    return `claude --resume ${quoteCommandArg(ref.sessionId, windows)}`;
  },

  findById: findClaudeSessionById,

  sessionUsage: claudeSessionUsage,
};
