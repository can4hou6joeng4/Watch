import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderAdapter } from '../adapter.js';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import { isMissingPathError } from '../../core/read-text.js';
import type { SessionRef } from '../../core/types.js';
import { parsePiSession } from './parse.js';
import { encodePiProjectDir, importTurnsToPi, piSessionsRoot } from './build.js';

const execFileAsync = promisify(execFile);

export { encodePiProjectDir, piSessionsRoot };

export async function findLatestPiSession(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const all = await listPiSessions(cwd, sessionsRoot);
  return all[0] ?? null;
}

export async function listPiSessions(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = sessionsRoot ?? piSessionsRoot();
  const dir = path.join(root, encodePiProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 这个 cwd 没聊过 = 目录不存在；读不出来要抛出，让 sessions / recent / doctor 披露，
    // 否则权限或路径出错会被讲成「这个目录没聊过」
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new Error(
      `无法读取 Pi 会话目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const sessionId = sessionIdFromName(entry);
      items.push({
        ref: { provider: 'pi', sessionId, filePath, cwd },
        updatedAt: st.mtimeMs,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 列目录到取状态之间被删掉算正常；其余读不出来不能静默跳过——列表因此不完整
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new Error(
        `无法读取 Pi 会话文件状态 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

function sessionIdFromName(name: string): string {
  const base = name.replace(/\.jsonl$/i, '');
  const us = base.lastIndexOf('_');
  return us >= 0 ? base.slice(us + 1) : base;
}

/** 读 jsonl 首条可解析记录拿 cwd（session 头事件带 cwd，目录名编码不可逆）。
 * `error` 区分「文件读不出来」与「内容里没有 cwd」——反查时前者不能说成「会话不存在」 */
async function piSessionCwdDetail(filePath: string): Promise<{ cwd: string | null; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { cwd: null, error: error instanceof Error ? error.message : String(error) };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.cwd === 'string' && rec.cwd) return { cwd: rec.cwd };
    break;
  }
  return { cwd: null, error: '首条可解析记录里没有 cwd 字段' };
}

/** 按原生 session id 全局反查 Pi 会话：扫各 cwd 目录匹配 `<timestamp>_<id>.jsonl`，cwd 从文件头读；sessionsRoot 可注入 */
export async function findPiSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = sessionsRoot ?? piSessionsRoot();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch (error) {
    // 根目录不存在 = 这台机器没用过 Pi，按「没有这个会话」处理；
    // 其余（权限 / I/O）读不出来照常抛，原因交给 resolveById 的 diagnostics
    if (isMissingPathError(error)) return null;
    throw new Error(
      `无法列出 Pi 会话目录 ${root}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unreadable: string[] = [];
  const foundButUnreadable: string[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(path.join(root, dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unreadable.push(`${path.join(root, dir)}（${error instanceof Error ? error.message : String(error)}）`);
      }
      continue;
    }
    const hit = files.find((f) => f.endsWith('.jsonl') && f.slice(0, -'.jsonl'.length).endsWith(`_${sessionId}`));
    if (!hit) continue;
    const filePath = path.join(root, dir, hit);
    let st;
    try {
      st = await stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unreadable.push(`${filePath}（${error instanceof Error ? error.message : String(error)}）`);
      }
      continue;
    }
    const { cwd, error } = await piSessionCwdDetail(filePath);
    if (cwd) return { ref: { provider: 'pi', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    // 文件确实在，只是读不出 cwd：结论不能是「会话不存在」
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

export const piAdapter: ProviderAdapter = {
  id: 'pi',
  displayName: 'Pi',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('pi'), ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },

  parse: parsePiSession,
  importTurns: (turns, cwd, into, opts) => importTurnsToPi(turns, cwd, into, opts),

  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestPiSession,
  listSessions: listPiSessions,

  /** nezha 式启动：预写一条占位 user 消息，让 `pi --session <id>` 进 PTY 后能直接交互 */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    const turn: import('../../core/types.js').UnifiedTurn = {
      role: 'user',
      text: '我们开始吧。',
      timestamp: new Date().toISOString(),
    };
    return importTurnsToPi([turn], cwd);
  },

  async start(): Promise<never> {
    throw new Error('pi 仅支持 TUI resume，请用 watch switch pi');
  },
  async send(): Promise<never> {
    throw new Error('pi 仅支持 TUI resume，请用 watch switch pi');
  },

  resumeCommand(ref: SessionRef): string {
    return `pi --session ${ref.sessionId}`;
  },

  findById: findPiSessionById,
};
