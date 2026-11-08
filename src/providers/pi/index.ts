import { execFile } from 'node:child_process';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SessionLookupFailureError } from '../adapter.js';
import type { ProviderAdapter } from '../adapter.js';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import {
  describePathReadFailureReason,
  describeSessionReadFailure,
  isMissingPathError,
} from '../../core/read-text.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
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
      `无法读取 Pi 会话目录 ${dir}：${describePathReadFailureReason(error)}`,
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
        `无法读取 Pi 会话文件状态 ${filePath}：${describePathReadFailureReason(error)}`,
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
    return { cwd: null, error: describePathReadFailureReason(error) };
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
    throw new SessionLookupFailureError(
      'incomplete',
      `无法列出 Pi 会话目录 ${root}：${describePathReadFailureReason(error)}`,
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
        unreadable.push(`${path.join(root, dir)}（${describePathReadFailureReason(error)}）`);
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
        unreadable.push(`${filePath}（${describePathReadFailureReason(error)}）`);
      }
      continue;
    }
    const { cwd, error } = await piSessionCwdDetail(filePath);
    if (cwd) return { ref: { provider: 'pi', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    // 文件确实在，只是读不出 cwd：结论不能是「会话不存在」
    foundButUnreadable.push(`${filePath}（${error ?? '原因未知'}）`);
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
      `在 ${root} 下没找到会话 ${sessionId}，但有 ${unreadable.length} 个位置读不出来，无法确认它是否存在：${unreadable[0]}`,
    );
  }
  return null;
}

/**
 * 信息层：链上这条 pi 会话一共用了多少 token。
 *
 * 口径刻意与搬运层复用同一个 `parsePiSession()`，而不是直接累加每条 assistant 消息的
 * `message.usage`：
 * ① `readPiUsage()` 已按 pi 自己的口径把缓存两块加回输入（`input + cacheRead + cacheWrite`，
 *    `cacheWrite1h` 是 `cacheWrite` 的子集不重复加），两条路径共用一份折算，不会再分叉；
 * ② `importTurnsToPi()` 在带工具的轮次里把**同一份** usage 写在两条 assistant 消息上
 *    （tool-call 一条、final text 一条，pi TUI footer 要求每条都带），直接按消息累加会翻倍，
 *    而 parse 已把它们合并成一个 turn、用量只留一份；
 * ③ 0/0 占位在 `readPiUsage()` 里已被丢弃，不会把「源侧没有用量」算成真实 0 token。
 *
 * 已知边界：原生一轮里发生多次 API 调用时，parse 的合并规则取**最后一次调用**的用量
 * （与 claude 的 parse 一致，见 `parse.ts` 的注释），这里同样如此。宁可少算，也不用
 * 「usage 完全相同就当成重复」这种启发式去猜——真正的多次调用可以有任意数值。
 * 这样信息层与搬运层始终是同一份数字：`watch usage` 说用了多少，转出去就是多少。
 *
 * 没有 assistant usage 时返回 null（表示「原生没有用量记录」），读不出来照常抛出——
 * 与另外五家 `sessionUsage` 的约定一致，`chainUsage()` 会据此区分 `totalMissingUsage`
 * 与读取失败。
 */
async function piSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let turns: UnifiedTurn[];
  try {
    turns = await parsePiSession(ref);
  } catch (error) {
    // 读不出来不等于「原生没有 usage 字段」：按会话文件的口径翻成中文再抛，交给 chainUsage / open 披露
    throw new Error(describeSessionReadFailure(ref.filePath, error));
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let saw = false;
  for (const turn of turns) {
    if (!turn.usage) continue;
    saw = true;
    inputTokens += turn.usage.inputTokens;
    outputTokens += turn.usage.outputTokens;
  }
  return saw ? { inputTokens, outputTokens } : null;
}

export const piAdapter: ProviderAdapter = {
  id: 'pi',
  displayName: 'Pi',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('pi'), ['--version'], { timeout: 10_000 });
      return true;
    } catch (error) {
      if (isCommandMissing(error)) return false;
      throw new Error(describeDetectFailure('pi', error));
    }
  },

  parse: parsePiSession,
  importTurns: (turns, cwd, into, opts) => importTurnsToPi(turns, cwd, into, opts),

  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestPiSession,
  listSessions: listPiSessions,
  sessionUsage: piSessionUsage,

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
