import { execFile } from 'node:child_process';
import { quoteCommandArg } from '../../core/shell-quote.js';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import type { ProviderAdapter, ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import {
  createEmptyGrokSession,
  findGrokSessionById,
  findLatestGrokSession,
  importTurnsToGrok,
  listGrokSessions,
} from './build.js';
import { parseGrokSession } from './parse.js';
import { grokSessionUsage, grokUpdatesPath } from './usage.js';

export { findGrokSessionById };

const execFileAsync = promisify(execFile);

export const grokAdapter: ProviderAdapter = {
  id: 'grok',
  displayName: 'Grok',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('grok'), ['--version'], { timeout: 10_000 });
      return true;
    } catch (error) {
      if (isCommandMissing(error)) return false;
      throw new Error(describeDetectFailure('grok', error));
    }
  },

  parse(ref: SessionRef): Promise<UnifiedTurn[]> {
    return parseGrokSession(ref);
  },

  importTurns(turns: UnifiedTurn[], cwd: string, into?: SessionRef, opts?: ImportTurnsOpts): Promise<SessionRef> {
    return importTurnsToGrok(turns, cwd, into, opts);
  },
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },

  async createEmptySession(cwd: string): Promise<SessionRef> {
    return createEmptyGrokSession(cwd);
  },

  async start(): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    throw new Error('Grok 适配器暂不支持 headless start，请使用 TUI resume');
  },

  async send(): Promise<UnifiedTurn> {
    throw new Error('Grok 适配器暂不支持 headless send，请使用 TUI resume');
  },

  async findLatestSession(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
    return findLatestGrokSession(cwd);
  },

  async listSessions(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
    return listGrokSessions(cwd);
  },

  findById: findGrokSessionById,

  resumeCommand(ref: SessionRef, windows?: boolean): string {
    return `grok -r ${quoteCommandArg(ref.sessionId, windows)}`;
  },

  sessionUsage: grokSessionUsage,

  /** 用量在旁路文件 `updates.jsonl`，不是 `parse` 读的 `chat_history.jsonl` */
  sessionUsagePath: grokUpdatesPath,
  // `chat_history.jsonl` 行内没有逐轮时间戳（见 parse.ts 的 `grokAnchorMs()`）：逐轮时间由
  // summary.json 的 created_at 按行 +1ms 推定，缺摘要时锚定会话文件的 mtime。
  // 不说的话，`watch prompt` 的「时间范围」会被读成这段对话的真实起止。
  timingNote:
    'Grok 的记录行内没有逐轮时间戳：这里的时间由 summary.json 的创建时间按顺序推定，' +
    '缺这份摘要时取会话文件的修改时间，不是逐轮的真实时间',
};
