import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import type { ProviderAdapter, PreflightContext } from '../adapter.js';
import { PreflightBlockedError } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { streamCommand } from '../../core/streamCommand.js';
import { parseCodexSession } from './parse.js';
import { codexSessionUsage } from './usage.js';
import {
  codexDir,
  findRolloutBySessionId,
  importTurnsToCodex,
  readModelProvider,
  validateRolloutFilename,
} from './build.js';
import { codexLineToProcessEvents } from './events.js';

const execFileAsync = promisify(execFile);

/** 按 YYYY/MM/DD 结构扫 rollout，withFileTypes 避免对目录再 stat */
async function collectRecentRolloutFiles(
  sessionsRoot: string,
): Promise<{ filePath: string; mtimeMs: number }[]> {
  const collected: { filePath: string; mtimeMs: number }[] = [];
  let years: string[];
  try {
    years = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
  for (const y of years) {
    let months: string[];
    try {
      months = (await readdir(path.join(sessionsRoot, y), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      continue;
    }
    for (const m of months) {
      let dus: string[];
      try {
        dus = (await readdir(path.join(sessionsRoot, y, m), { withFileTypes: true }))
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a));
      } catch {
        continue;
      }
      for (const d of dus) {
        const dayDir = path.join(sessionsRoot, y, m, d);
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(dayDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, entry.name);
          try {
            collected.push({ filePath, mtimeMs: (await stat(filePath)).mtimeMs });
          } catch {
            continue;
          }
        }
      }
    }
  }
  return collected;
}

function sessionIdFromRolloutPath(filePath: string): string | null {
  try {
    validateRolloutFilename(filePath);
  } catch {
    return null;
  }
  const stem = path.basename(filePath, '.jsonl');
  return stem.slice(-36);
}

/** 读取 filePath 的第一行 JSON 记录，返回 session_meta 的 cwd；首行可能超过 4KB（base_instructions 等长字段）
 * 因此不能截断固定字节，须读到首个换行符为止再解析 */
async function rolloutCwd(filePath: string): Promise<string | null> {
  try {
    const lines = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    const first = (await new Promise<string>((resolve) => {
      let settled = false;
      lines.on('line', (l) => {
        if (!settled) {
          settled = true;
          resolve(l);
          lines.close();
        }
      });
      lines.on('close', () => {
        if (!settled) {
          settled = true;
          resolve('');
        }
      });
    })) as string;
    if (!first) return null;
    const record = JSON.parse(first) as Record<string, unknown>;
    if (record.type !== 'session_meta') return null;
    const payload = record.payload as Record<string, unknown> | undefined;
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}

/** 在 sessionsRoot 下按 mtime 降序找 cwd 匹配的最新 rollout；目录不存在返回 null */
export async function findLatestCodexRollout(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const files = await collectRecentRolloutFiles(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const sessionId = sessionIdFromRolloutPath(f.filePath);
    if (!sessionId) continue;
    const metaCwd = await rolloutCwd(f.filePath);
    if (metaCwd !== cwd) continue;
    return {
      ref: { provider: 'codex', sessionId, filePath: f.filePath, cwd },
      updatedAt: f.mtimeMs,
    };
  }
  return null;
}

/** cwd 下全部 rollout，mtime 降序；preview 取首条用户消息 */
export async function listCodexRollouts(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const files = await collectRecentRolloutFiles(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const f of files) {
    const sessionId = sessionIdFromRolloutPath(f.filePath);
    if (!sessionId) continue;
    if ((await rolloutCwd(f.filePath)) !== cwd) continue;
    items.push({ ref: { provider: 'codex', sessionId, filePath: f.filePath, cwd }, updatedAt: f.mtimeMs });
    if (items.length >= 50) break;
  }
  return Promise.all(items.map(async (item) => ({ ...item, preview: (await codexFirstUserText(item.ref.filePath)) ?? undefined })));
}

/** 按原生 session id（rollout 文件名尾部 uuid）全局反查 Codex 会话；sessionsRoot 可注入供单测 */
export async function findCodexSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const filePath = await findRolloutBySessionId(root, sessionId);
  if (!filePath) return null;
  const cwd = await rolloutCwd(filePath);
  if (!cwd) return null;
  const fileRef: SessionRef = { provider: 'codex', sessionId, filePath, cwd };
  return { ref: fileRef, updatedAt: (await stat(filePath).catch(() => undefined))?.mtimeMs ?? 0 };
}

async function codexFirstUserText(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const payload = record.payload as Record<string, unknown> | undefined;
      let text = '';
      if (record.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
        text = payload.message;
      } else if (record.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
        const contentArr = payload.content as Record<string, unknown>[] | undefined;
        if (Array.isArray(contentArr)) {
          text = contentArr
            .filter((c) => typeof c.text === 'string')
            .map((c) => c.text as string)
            .join(' ');
        }
      }
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean && !clean.startsWith('<environment_context>') && !clean.startsWith('<user_instructions>')) {
        return clean.slice(0, 80);
      }
    } catch {
      continue;
    }
  }
  return null;
}

type CodexProviderCredential = { apiKey?: string; baseUrl?: string };

/** 解析 config.toml 里当前选用 provider 的 api_key/base_url（只做简单 key=value/section 解析） */
async function readProviderCredential(codexHome: string): Promise<CodexProviderCredential> {
  let raw: string;
  try {
    raw = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return {};
  }
  const provider = await readModelProvider(codexHome);
  const sectionPrefix = `[model_providers.${provider}]`;
  let inSection = false;
  let topLevelApiKey: string | undefined;
  let topLevelBaseUrl: string | undefined;
  let sectionApiKey: string | undefined;
  let sectionBaseUrl: string | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      inSection = trimmed === sectionPrefix;
      continue;
    }
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (inSection) {
      if (key === 'api_key') sectionApiKey = value;
      else if (key === 'base_url') sectionBaseUrl = value;
    } else {
      if (key === 'api_key') topLevelApiKey = value;
      else if (key === 'base_url') topLevelBaseUrl = value;
    }
  }
  return {
    apiKey: sectionApiKey ?? topLevelApiKey,
    baseUrl: sectionBaseUrl ?? topLevelBaseUrl,
  };
}

/**
 * 子进程环境：custom provider 声明了 env_key = "OPENAI_API_KEY" 时 codex 只认环境变量。
 * 优先保留用户已设置的 OPENAI_API_KEY / CODEX_API_KEY；都没有则从 config.toml 当前
 * provider 段读 api_key，最后再 fallback 到 ~/.codex/auth.json。
 */
async function codexEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return process.env;
  const env = { ...process.env };
  const codexHome = codexDir();
  try {
    const cred = await readProviderCredential(codexHome);
    if (cred.apiKey) env.OPENAI_API_KEY = cred.apiKey;
    if (cred.baseUrl) env.OPENAI_BASE_URL = cred.baseUrl;
  } catch {
    // config.toml 解析失败时继续走 auth.json
  }
  if (!env.OPENAI_API_KEY) {
    try {
      const auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
      if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = auth.OPENAI_API_KEY;
      }
    } catch {
      // auth.json 缺失或损坏时保持原环境，让 codex 自己报错
    }
  }
  return env;
}

type CodexRun = { stdout: string; replyText: string };

/**
 * codex exec ... --json -o <tmp>：逐行流式回调过程事件（onEvent）；
 * 最终回复优先取 -o 落盘文件，为空时回退解析 JSONL 事件流中的最后一条 agent 消息
 */
async function runCodex(args: string[], cwd: string, onEvent?: (e: ProcessEvent) => void): Promise<CodexRun> {
  const outDir = await mkdtemp(path.join(tmpdir(), 'watch-codex-'));
  const outFile = path.join(outDir, 'last-message.txt');
  let stdout = '';
  try {
    const out = await streamCommand(
      'codex',
      ['exec', ...args, '--json', '--skip-git-repo-check', '-o', outFile],
      { cwd, env: await codexEnv(), timeout: 600_000 },
      (line) => {
        if (onEvent) for (const e of codexLineToProcessEvents(line)) onEvent(e);
      },
    );
    stdout = out.stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    // --json 模式下 codex 把错误写进 stdout 事件流（turn.failed / error），stderr 常为空
    const stdoutErr =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? String((error as { stdout: unknown }).stdout)
        : '';
    const detail = stderr.trim() || eventErrorSummary(stdoutErr) || String(error);
    await rm(outDir, { recursive: true, force: true });
    throw new Error(`codex CLI 调用失败: ${detail.slice(0, 500)}`);
  }
  let replyText = '';
  try {
    replyText = (await readFile(outFile, 'utf8')).trim();
  } catch {
    // -o 文件未生成时回退事件流解析
  }
  await rm(outDir, { recursive: true, force: true });
  if (!replyText) {
    replyText = lastAgentMessageFromEvents(stdout);
  }
  if (!replyText) {
    throw new Error(`codex 输出中找不到最终回复: ${stdout.slice(0, 500)}`);
  }
  return { stdout, replyText };
}

/** 从 --json 事件流提取错误摘要（turn.failed / error 事件的最后一条 message） */
function eventErrorSummary(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'turn.failed') {
      const err = event.error as Record<string, unknown> | undefined;
      if (typeof err?.message === 'string') last = err.message;
    } else if (event.type === 'error' && typeof event.message === 'string') {
      last = event.message;
    } else if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'error' && typeof item.message === 'string') last = item.message;
    }
  }
  return last;
}

/** 从 --json 事件流兜底提取最终 agent 消息（兼容 item.completed / agent_message 两种形态） */
function lastAgentMessageFromEvents(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      last = item.text;
    } else if (event.type === 'agent_message' && typeof event.message === 'string') {
      last = event.message;
    }
  }
  return last;
}

/** 从 --json 事件流取 thread.started 的 thread_id（从零开聊时的新会话 id） */
function threadIdFromEvents(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  }
  return null;
}

const replyTurn = (text: string): UnifiedTurn => ({
  role: 'assistant',
  text,
  timestamp: new Date().toISOString(),
  provider: 'codex',
});

/** Codex Desktop / ChatGPT Desktop 可执行文件路径判定（对齐 cc-sessions is_macos_desktop_executable） */
export function isCodexDesktopExecutable(executable: string): boolean {
  const idx = executable.lastIndexOf('/Contents/MacOS/');
  if (idx === -1) return false;
  const bundle = executable.slice(0, idx).split('/').pop() ?? '';
  const binary = executable.slice(idx + '/Contents/MacOS/'.length);
  return (bundle === 'Codex.app' || bundle === 'ChatGPT.app') && (binary === 'Codex' || binary === 'ChatGPT');
}

/**
 * 按原生 per-thread writer 锁定位（`<codexHome>/thread-writer-locks/<thread-id>.lock`，0 字节 flock 文件）。
 * 锁名就是 thread/session id，与 rollout 文件名里的 id 一致。
 */
export function threadWriterLockPath(sessionId: string, codexHome = codexDir()): string {
  return path.join(codexHome, 'thread-writer-locks', `${sessionId}.lock`);
}

type WriterHolder = { pid: number; command: string };

function parseLsofHolders(stdout: string): WriterHolder[] {
  const holders: WriterHolder[] = [];
  let pid: number | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid) {
      holders.push({ pid, command: line.slice(1) });
      pid = undefined;
    }
  }
  return holders;
}

/**
 * 探测 writer 锁的当前持有者。
 * 返回 [] = 无人持有（陈旧锁/进程已退出）；null = 探测不可用（lsof 缺失或异常），调用方应回退。
 */
async function probeThreadWriterHolders(lockPath: string): Promise<WriterHolder[] | null> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-Fpc', '--', lockPath], { timeout: 10_000 });
    return parseLsofHolders(stdout);
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown };
    if (err.code === 1) return []; // lsof: 无匹配
    if (typeof err.stdout === 'string' && err.stdout.trim()) return parseLsofHolders(err.stdout);
    return null;
  }
}

/** Desktop 进程是否在运行（pgrep 不可用等异常按未运行放行，保持旧行为） */
async function desktopProcessRunning(): Promise<boolean> {
  for (const pattern of ['Codex.app/Contents/MacOS/Codex', 'ChatGPT.app/Contents/MacOS/ChatGPT']) {
    try {
      await execFileAsync('pgrep', ['-f', pattern], { timeout: 10_000 });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) continue;
      return false;
    }
  }
  return false;
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('codex'), ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },

  parse: parseCodexSession,
  importTurns: importTurnsToCodex,
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestCodexRollout,
  listSessions: (cwd) => listCodexRollouts(cwd),

  /**
   * 写入 Codex 侧前的目标级保护。
   * - 有目标会话：以原生 per-thread writer 锁为准，仅当锁被活进程持有才拒绝；
   *   锁文件不存在或只剩陈旧锁（无持有者）则放行，与 Desktop 是否运行无关。
   * - 无目标上下文，或 lsof 不可用：退回旧的 Desktop 进程检查（保守）。
   * 详见 docs/COMPATIBILITY.md 的 Codex 保护说明。
   */
  async preflight(ctx?: PreflightContext): Promise<void> {
    if (process.platform !== 'darwin') return; // MVP 只覆盖 macOS，其余平台放行
    if (!ctx) {
      // 未提供任何目标上下文（兼容旧调用）：无法做目标级判定，按进程保守拒绝
      if (!(await desktopProcessRunning())) return;
      throw new PreflightBlockedError({
        code: 'codex_desktop_running',
        message: '检测到 Codex/ChatGPT Desktop 正在运行，请先退出再切换（避免会话目录写入互斥）',
        hint: '未提供目标会话时无法做目标级判定，因此保守拒绝。',
      });
    }
    const ref = ctx.ref;
    // 显式的新建会话（有 ctx、无 ref）：没有可冲突的既有文件，放行
    if (!ref) return;
    const lockPath = threadWriterLockPath(ref.sessionId);
    const lockExists = (await stat(lockPath).catch(() => undefined))?.isFile() ?? false;
    if (!lockExists) return; // 无 writer 登记：无共享文件可冲突
    const holders = await probeThreadWriterHolders(lockPath);
    if (holders?.length) {
      const who = holders.map((h) => `PID ${h.pid} ${h.command}`).join('、');
      throw new PreflightBlockedError({
        code: 'codex_target_busy',
        sessionId: ref.sessionId,
        holders,
        message: `Codex 会话 ${ref.sessionId} 正被其他 writer 持有（${who}），已拒绝写入以免并发损坏`,
        hint: '结束该 writer 进程后重试；本次未写入任何内容。',
      });
    }
    if (holders) return; // 陈旧锁：持有者已退出 → 可写
    if (!(await desktopProcessRunning())) return;
    throw new PreflightBlockedError({
      code: 'codex_target_busy',
      sessionId: ref.sessionId,
      message: `Codex 会话 ${ref.sessionId} 可能正被写入（无法探测 writer 锁，且 Desktop 正在运行），已保守拒绝`,
      hint: '退出 Codex/ChatGPT Desktop 后重试；本次未写入任何内容。',
    });
  },

  /** nezha 式启动：预写 interactive 身份的空 rollout，后续由 PTY 执行 `codex resume <id>` */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    return importTurnsToCodex([], cwd, undefined, undefined, { requireUser: false });
  },

  /** 从零开聊：先写 interactive 身份的 rollout，再用 exec resume 发首条消息，保证 session source 不是 exec */
  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    const ref = await importTurnsToCodex([], cwd, undefined, undefined, { requireUser: false });
    const { stdout, replyText } = await runCodex(['resume', ref.sessionId, text], cwd, onEvent);
    const sessionId = threadIdFromEvents(stdout);
    if (!sessionId) {
      throw new Error(`codex 输出缺少 thread.started: ${stdout.slice(0, 500)}`);
    }
    return { ref, turn: replyTurn(replyText) };
  },

  /** codex exec resume <id> <text>：续聊并取最终回复 */
  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const { replyText } = await runCodex(['resume', ref.sessionId, text], ref.cwd, onEvent);
    return replyTurn(replyText);
  },

  resumeCommand(ref: SessionRef): string {
    return `codex resume ${ref.sessionId}`;
  },

  findById: findCodexSessionById,

  sessionUsage: codexSessionUsage,
};
