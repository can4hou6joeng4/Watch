import { execFile } from 'node:child_process';
import { quoteCommandArg } from '../../core/shell-quote.js';
import { describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { clipCodePoints, escapeControlChars } from '../../core/display.js';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import { describePathReadFailureReason, isMissingPathError, iterateFileLines } from '../../core/read-text.js';
import type { ProviderAdapter, PreflightContext, WriteLimit } from '../adapter.js';
import { PreflightBlockedError, SessionLookupFailureError } from '../adapter.js';
import { acquireThreadWriterLock, probeThreadWriterHolders, threadWriterLockPath, WriterLockDirError, type WriterLockGuard } from './writer-lock.js';
export { threadWriterLockPath };
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { streamCommand } from '../../core/streamCommand.js';
import { codexZeroTurnProblem, parseCodexSession } from './parse.js';
import { codexSessionUsage } from './usage.js';
import {
  CodexConfigError,
  codexDir,
  findRolloutBySessionId,
  importTurnsToCodex,
  parseCodexConfig,
  readModelProvider,
  validateRolloutFilename,
} from './build.js';
import { codexLineToProcessEvents } from './events.js';

const execFileAsync = promisify(execFile);

/** 只将符合日期层级名称的普通文件记为占位故障，其他非目录保持既有过滤规则。 */
function codexDateDirectories(
  entries: import('node:fs').Dirent[],
  parent: string,
  pattern: RegExp,
  errors?: string[],
): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    if (entry.isDirectory()) names.push(entry.name);
    else if (entry.isFile()) {
      errors?.push(`${escapeControlChars(path.join(parent, entry.name))}（日期路径不是目录，被普通文件占住）`);
    }
  }
  return names.sort((a, b) => b.localeCompare(a));
}

/** 按 YYYY/MM/DD 结构扫 rollout，withFileTypes 避免对目录再 stat。
 * `errors` 收集目录 / 文件读不出来的原因：列表与「最新会话」都据此判断结果是完整结论还是「没查成」。
 * `compressed` 收集只有 `.jsonl.zst` 副本的 rollout：Codex 的 `local_thread_store_compression`
 * （上游主线，尚在 UnderDevelopment、默认关闭）把 7 天没写过的会话压成该格式，它们仍是真实会话，
 * 本版 Watch 读不出内容，不能因为扩展名不在名单里就当成「没有这条会话」。 */
async function collectRecentRolloutFiles(
  sessionsRoot: string,
  errors?: string[],
  compressed?: string[],
): Promise<{ filePath: string; mtimeMs: number }[]> {
  const collected: { filePath: string; mtimeMs: number }[] = [];
  let years: string[];
  try {
    years = codexDateDirectories(await readdir(sessionsRoot, { withFileTypes: true }), sessionsRoot, /^\d{4}$/, errors);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 根目录不存在 = 这台机器没用过 codex，空结果就是事实；读不出来则必须记下来
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      errors?.push(`${escapeControlChars(sessionsRoot)}（${describePathReadFailureReason(error)}）`);
    }
    return [];
  }
  for (const y of years) {
    let months: string[];
    try {
      const yearDir = path.join(sessionsRoot, y);
      months = codexDateDirectories(await readdir(yearDir, { withFileTypes: true }), yearDir, /^\d{2}$/, errors);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        errors?.push(`${escapeControlChars(path.join(sessionsRoot, y))}（${describePathReadFailureReason(error)}）`);
      }
      continue;
    }
    for (const m of months) {
      let dus: string[];
      try {
        const monthDir = path.join(sessionsRoot, y, m);
        dus = codexDateDirectories(await readdir(monthDir, { withFileTypes: true }), monthDir, /^\d{2}$/, errors);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          errors?.push(`${escapeControlChars(path.join(sessionsRoot, y, m))}（${describePathReadFailureReason(error)}）`);
        }
        continue;
      }
      for (const d of dus) {
        const dayDir = path.join(sessionsRoot, y, m, d);
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(dayDir, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            errors?.push(`${escapeControlChars(dayDir)}（${describePathReadFailureReason(error)}）`);
          }
          continue;
        }
        const plainNames = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name));
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.startsWith('rollout-')) continue;
          if (entry.name.endsWith('.jsonl.zst')) {
            // 普通副本也在时原生只读普通副本（`should_skip_compressed_sibling`），这里不重复计数。
            if (!plainNames.has(entry.name.slice(0, -'.zst'.length))) compressed?.push(path.join(dayDir, entry.name));
            continue;
          }
          if (!entry.name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, entry.name);
          try {
            collected.push({ filePath, mtimeMs: (await stat(filePath)).mtimeMs });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
              errors?.push(`${escapeControlChars(filePath)}（${describePathReadFailureReason(error)}）`);
            }
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

/** 读 filePath 首个换行前的整行；首行可能超过 4KB（base_instructions 等长字段），不能截断固定字节。
 * readline 的 `'error'` 是异步事件，外层的 try/catch 接不住：没有监听器时 Node 以未捕获异常
 * 直接崩掉整个 CLI（`'close'` 也不保证触发，光等它会把命令挂死）。所以必须自己监听并结算。 */
async function readFirstLine(filePath: string): Promise<string> {
  const stream = createReadStream(filePath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      lines.on('line', (l) => {
        if (!settled) {
          settled = true;
          resolve(l);
        }
      });
      lines.on('close', () => {
        if (!settled) {
          settled = true;
          resolve('');
        }
      });
      lines.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** 读 rollout 首行的 session_meta.cwd，并带出读不出来的原因（`cwd === null` 且 `error` 有值）。
 * `code` 只在「文件读不出来」时给（I/O 错误码），内容层面的问题（空文件 / 首行不是 JSON）不给：
 * 前者说明这个会话可能存在却没查成，后者说明会话文件本身不可用。 */
async function rolloutCwdDetail(
  filePath: string,
): Promise<{ cwd: string | null; error?: string; code?: string }> {
  let first: string;
  try {
    first = await readFirstLine(filePath);
  } catch (error) {
    return {
      cwd: null,
      error: describePathReadFailureReason(error),
      code: (error as NodeJS.ErrnoException).code ?? 'EIO',
    };
  }
  if (!first) return { cwd: null, error: '文件是空的（没有 session_meta 首行）' };
  const record = parseJsonObject(first);
  if (!record) return { cwd: null, error: '首行不是合法 JSON 对象' };
  if (record.type !== 'session_meta') return { cwd: null, error: '首行不是 session_meta 记录' };
  const payload = asJsonObject(record.payload);
  if (!payload || typeof payload.cwd !== 'string' || !payload.cwd) {
    return { cwd: null, error: 'session_meta 缺少 cwd' };
  }
  return { cwd: payload.cwd };
}

/** 在 sessionsRoot 下按 mtime 降序找 cwd 匹配的最新 rollout；目录不存在返回 null */
export async function findLatestCodexRollout(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; warnings?: string[] } | null> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const walkErrors: string[] = [];
  const unreadCwd: string[] = [];
  const files = await collectRecentRolloutFiles(root, walkErrors);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let found: { ref: SessionRef; updatedAt: number } | null = null;
  for (const f of files) {
    const sessionId = sessionIdFromRolloutPath(f.filePath);
    if (!sessionId) continue;
    const { cwd: metaCwd, error: cwdError, code } = await rolloutCwdDetail(f.filePath);
    if (!metaCwd) {
      // 读不出来（EACCES 等）时它可能是本 cwd 的会话，不能当成「不属于这里」直接跳过；
      // 空文件 / 首行不是 JSON 属于会话内容不可用，跳过是既有语义
      if (code) unreadCwd.push(`${escapeControlChars(f.filePath)}（${cwdError ?? code}）`);
      continue;
    }
    if (metaCwd !== cwd) continue;
    found = {
      ref: { provider: 'codex', sessionId, filePath: f.filePath, cwd },
      updatedAt: f.mtimeMs,
    };
    break;
  }
  const incomplete = walkErrors.length + unreadCwd.length;
  if (found) {
    if (!incomplete) return found;
    // 可读候选仍可使用，但扫描故障可能藏着更新的一条，不能把子集中的最新说成全局最新。
    return {
      ...found,
      warnings: [
        `Codex 扫描有 ${incomplete} 个位置读不出来；本次自动挑的是在能读出的会话里按修改时间最新的会话 ${found.ref.sessionId}，` +
          `无法确认它是否为全部会话中最新的一条：${escapeControlChars(walkErrors[0] ?? unreadCwd[0])}；` +
          '先恢复这些位置的可访问性（权限、路径）后重试，或显式指定要使用的会话 id',
      ],
    };
  }
  if (incomplete) {
    // 有位置读不出来时「这个目录没有 Codex 会话」不是结论
    throw new Error(
      `在 ${escapeControlChars(root)} 下没找到属于 ${escapeControlChars(cwd)} 的 Codex 会话，但有 ${incomplete} 个位置读不出来，无法确认是否存在：${escapeControlChars(walkErrors[0] ?? unreadCwd[0])}`,
    );
  }
  return null;
}

/** cwd 下全部 rollout，mtime 降序；preview 取首条用户消息 */
/** `listSessions` 单次上限：超出时只返回最新的这么多条（`watch doctor` 据此把计数标成下限） */
export const CODEX_LIST_LIMIT = 50;

export async function listCodexRollouts(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string; previewError?: string }[]> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const walkErrors: string[] = [];
  const unreadCwd: string[] = [];
  const files = await collectRecentRolloutFiles(root, walkErrors);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const f of files) {
    const sessionId = sessionIdFromRolloutPath(f.filePath);
    if (!sessionId) continue;
    const { cwd: metaCwd, error: cwdError, code } = await rolloutCwdDetail(f.filePath);
    if (!metaCwd) {
      // 读不出来时可能正是本 cwd 的会话：静默跳过会让列表少一条且毫无提示
      if (code) unreadCwd.push(`${escapeControlChars(f.filePath)}（${cwdError ?? code}）`);
      continue;
    }
    if (metaCwd !== cwd) continue;
    items.push({ ref: { provider: 'codex', sessionId, filePath: f.filePath, cwd }, updatedAt: f.mtimeMs });
    if (items.length >= CODEX_LIST_LIMIT) break;
  }
  const incomplete = walkErrors.length + unreadCwd.length;
  if (incomplete) {
    // 静默少列会被读成「这个目录就这些会话」，必须让 sessions / recent / doctor 披露
    throw new Error(
      `列出 Codex 会话时有不完整：有 ${incomplete} 个位置读不出来，列表可能少了几条：${escapeControlChars(walkErrors[0] ?? unreadCwd[0])}`,
    );
  }
  return Promise.all(
    items.map(async (item) => {
      const { text, error } = await codexFirstUserText(item.ref.filePath);
      return { ...item, preview: text ?? undefined, ...(error ? { previewError: error } : {}) };
    }),
  );
}

/**
 * `session_meta` 读不出来的 rollout 条数（空文件 / 首行不是合法 JSON / 首行不是 `session_meta` / 缺 cwd）。
 *
 * 这一档既不是「这个目录没有会话」，也不是「这家存储读不出来」：那个文件的 cwd **就写在读不出的
 * 那一行里**，所以它无法归到任何目录，`listCodexRollouts` / `findLatestCodexRollout` 只能跳过。
 * 跳过之后 `sessions` / `recent` 少一条、`doctor` 的计数少一条，且四条通道一个字都不说——用户会
 * 以为那条会话从来没存在过，可它可能只是被截断、还能从备份恢复（`open <id>` 倒是会说「找到了，
 * 但读不出来」，同一件事在单条反查与列表上两套说法）。
 *
 * 与 `previewError` 的分工：`previewError` 是「列出来了，只是内容读不出来」；这里是「连归属那一行
 * 都没有」。所以走适配器的 `unattributable()`，由 `watch sessions` / `recent` / `status` /
 * `doctor` 汇总披露（文案统一在 `src/core/session-coverage.ts`，`summary` 说明归属写在哪一行）。
 *
 * 目录 / 文件**读不出来**（`EACCES` 等）不算这一档：`listCodexRollouts` 已经会因它抛「有位置读不出来」，
 * 这里再统计一遍只会把同一个问题说两次。sessionsRoot 可注入供单测。
 */
export async function codexUnattributableRollouts(
  sessionsRoot?: string,
): Promise<{
  count: number;
  samples: string[];
  summary: string;
  cause?: string;
  advice?: string;
  kinds?: ('damaged' | 'compressed' | 'compressed-empty')[];
}> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const compressed: string[] = [];
  const files = await collectRecentRolloutFiles(root, undefined, compressed);
  const samples: string[] = [];
  let count = 0;
  for (const f of files) {
    const { cwd: metaCwd, error, code } = await rolloutCwdDetail(f.filePath);
    if (metaCwd || code) continue;
    count += 1;
    if (samples.length < 3) samples.push(`${escapeControlChars(f.filePath)}（${error ?? '原因未知'}）`);
  }
  // summary 直接点名那一行：共用文案不写死 provider 名，但用户需要知道「修的是首行」
  const summary = 'session_meta 首行';
  // 压缩副本要按字节数再分一档：扫描只看扩展名，0 字节的 `.jsonl.zst` 与完好副本的
  // 下一步相反（内容已丢失，展开也拿不回），不能共用「在 Codex 里继续会重新展开」。
  const compressedIntact: string[] = [];
  const compressedEmpty: string[] = [];
  for (const file of compressed) {
    let empty = false;
    try {
      const info = await lstat(file);
      empty = info.isFile() && info.size === 0;
    } catch {
      // 读不到大小不当作 0 字节：仍按「本版不读压缩格式」披露，不能凭空断言内容已丢失
    }
    (empty ? compressedEmpty : compressedIntact).push(file);
  }
  const kinds: ('damaged' | 'compressed' | 'compressed-empty')[] = [];
  if (count > 0) kinds.push('damaged');
  if (compressedIntact.length) kinds.push('compressed');
  if (compressedEmpty.length) kinds.push('compressed-empty');
  if (!compressed.length) return { count, samples, summary, kinds };
  // 压缩副本是另一种原因：文件没有损坏，只是本版不读 `.jsonl.zst`。混用「可能是被截断」会把用户
  // 引去反复查文件内容，必须换掉原因与建议两句话。
  // 混合计数时 advice 要分开说：压缩副本「文件是完好的」，而坏首行那部分可能真的被截断了——
  // 一句「文件本身是完好的」会把后者讲成健康文件，还会丢掉「从备份恢复」的下一步。
  const compressedCount = compressed.length;
  const compressedAdvice = [
    compressedIntact.length
      ? '完好的压缩副本 Watch 没有读取也没有改动，文件还在；在 Codex 里继续该会话会重新展开为 .jsonl（Watch 随后即可列出），不要直接删除或改名'
      : '',
    compressedEmpty.length
      ? `其中 ${compressedEmpty.length} 个同名 .jsonl.zst 是 0 字节（内容已丢失，重新展开也拿不回内容）；Watch 没有读取也没有改动它们，只能从备份恢复或重新开一次会话`
      : '',
  ]
    .filter(Boolean)
    .join('；');
  const compressedSummary = [
    compressedIntact.length ? `${compressedIntact.length} 个只剩完好的 .jsonl.zst 压缩副本` : '',
    compressedEmpty.length ? `${compressedEmpty.length} 个只剩 0 字节 .jsonl.zst 副本（内容已丢失）` : '',
  ]
    .filter(Boolean)
    .join('、');
  const compressedSamples = [
    ...compressedIntact.map((f) => `${escapeControlChars(f)}（只有 .jsonl.zst 压缩副本）`),
    ...compressedEmpty.map((f) => `${escapeControlChars(f)}（只有 0 字节 .jsonl.zst 副本，内容已丢失）`),
  ];
  return {
    count: count + compressedCount,
    samples: [...samples, ...compressedSamples.slice(0, Math.max(0, 3 - samples.length))],
    summary,
    kinds,
    cause: count > 0
      ? `${summary}缺失或损坏，另有 ${compressedCount} 个已被 Codex 压缩为 .jsonl.zst${compressedEmpty.length ? `（其中 ${compressedEmpty.length} 个副本是 0 字节、内容已丢失）` : ''}，本版 Watch 只读取未压缩的 .jsonl`
      : compressedEmpty.length
        ? `这些文件只剩压缩副本：${compressedSummary}。本版 Watch 只读取未压缩的 .jsonl`
        : '这些文件已被 Codex 压缩为 .jsonl.zst，本版 Watch 只读取未压缩的 .jsonl',
    advice: count > 0
      ? `坏首行的那 ${count} 个先把内容确认清楚（可能是被截断），能从备份恢复就别直接删；${compressedAdvice}`
      : compressedAdvice,
  };
}

/** 按原生 session id（rollout 文件名尾部 uuid）全局反查 Codex 会话；sessionsRoot 可注入供单测 */
export async function findCodexSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = sessionsRoot ?? path.join(codexDir(), 'sessions');
  const walkErrors: string[] = [];
  const compressed: string[] = [];
  const filePath = await findRolloutBySessionId(root, sessionId, walkErrors, compressed);
  if (!filePath) {
    // 只有压缩副本时这个会话真实存在（名字里的 id 完全匹配），只是本版读不出内容：
    // 讲成「没有」会把用户引去核对 id 或以为 Codex 没装
    const compressedMatch = compressed.find((f) => f.endsWith(`-${sessionId}.jsonl.zst`));
    if (compressedMatch) {
      // 0 字节副本是「文件在、内容已丢」：不能再说「继续该会话会重新展开」——展开也拿不回内容
      let empty = false;
      try {
        const info = await lstat(compressedMatch);
        empty = info.isFile() && info.size === 0;
      } catch {
        // 读不到大小仍按「本版不读压缩格式」披露，不凭空断言内容已丢失
      }
      throw new SessionLookupFailureError(
        'found-unreadable',
        empty
          ? `找到会话 ${escapeControlChars(sessionId)} 的同名压缩副本 ${escapeControlChars(compressedMatch)}，但它是 0 字节（内容已丢失，重新展开也拿不回内容）：` +
              'Watch 没有读取也没有改动这个文件；只能从备份恢复或重新开一次会话'
          : `找到会话 ${escapeControlChars(sessionId)} 的压缩副本 ${escapeControlChars(compressedMatch)}，但本版 Watch 只读取未压缩的 .jsonl：` +
              'Watch 没有读取也没有改动这个文件；在 Codex 里继续该会话会把它重新展开为 .jsonl，不要直接删除或改名',
      );
    }
    // 有目录读不出来时不能下「没有这个会话」的结论：抛出原因，由 resolveById 记进 diagnostics，
    // 用户才会去查权限 / 路径，而不是怀疑 id 写错或 Codex 没装
    if (walkErrors.length) {
      throw new SessionLookupFailureError(
        'incomplete',
        `在 ${escapeControlChars(root)} 下没找到会话 ${sessionId}，但有 ${walkErrors.length} 个位置读不出来，无法确认它是否存在：${escapeControlChars(walkErrors[0])}`,
      );
    }
    return null;
  }
  // 文件是按名字精确命中的，读不出 cwd 不等于「会话不存在」：抛给 resolveById 记进 diagnostics，
  // 否则用户会去核对 id 或以为 Codex 没装，而不是检查这个文件的权限 / 内容
  const { cwd, error } = await rolloutCwdDetail(filePath);
  if (!cwd) {
    throw new SessionLookupFailureError(
      'found-unreadable',
      `找到 rollout 文件 ${escapeControlChars(filePath)}，但读不出它的工作目录：${error ?? '原因未知'}`,
    );
  }
  const fileRef: SessionRef = { provider: 'codex', sessionId, filePath, cwd };
  return { ref: fileRef, updatedAt: (await stat(filePath).catch(() => undefined))?.mtimeMs ?? 0 };
}

async function codexFirstUserText(filePath: string): Promise<{ text: string | null; error?: string }> {
  try {
    // 逐行流式读取、命中首条用户消息就停：rollout 会累积整条会话的全部事件，预览只需要最前面几条
    for await (const line of iterateFileLines(filePath)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseJsonObject(trimmed);
      if (!record) continue;
      const payload = asJsonObject(record.payload);
      if (!payload) continue;
      let text = '';
      if (record.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
        text = payload.message;
      } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const contentArr = payload.content;
        if (Array.isArray(contentArr)) {
          text = contentArr
            .map((c) => {
              const item = asJsonObject(c);
              return typeof item?.text === 'string' ? item.text : null;
            })
            .filter((t): t is string => t !== null)
            .join(' ');
        }
      }
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean && !clean.startsWith('<environment_context>') && !clean.startsWith('<user_instructions>')) {
        return { text: clipCodePoints(clean, 80).text };
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 刚被删掉算正常；其余读不出来不能当成「这条会话还没有内容」（理由同 claude 适配器）
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: null };
    return { text: null, error: describePathReadFailureReason(error) };
  }
  return { text: null };
}

type CodexProviderCredential = { apiKey?: string; baseUrl?: string };

/**
 * 按 TOML 语义从当前 provider 表选择 api_key/base_url，仅实际顶层字段可作旧配置回退。
 *
 * 只读一次文件并复用 `parseCodexConfig()` 的同一份文档与 provider 判定；不扫描文本行，
 * 避免把别家 provider 或多行字符串正文当成凭据，也不把数字 / 布尔值强转成环境变量。
 * 只有 `ENOENT` / `ENOTDIR` 是「没有配置」；其余读取或解析失败继续抛出，
 * 由 `codexEnv()` 决定回落 auth.json。
 */
async function readProviderCredential(codexHome: string): Promise<CodexProviderCredential> {
  let raw: string;
  try {
    raw = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) return {};
    throw error;
  }
  const { provider, config } = parseCodexConfig(raw);
  const selected = asJsonObject(asJsonObject(config.model_providers)?.[provider]);
  const stringValue = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  return {
    apiKey: stringValue(selected?.api_key) ?? stringValue(config.api_key),
    baseUrl: stringValue(selected?.base_url) ?? stringValue(config.base_url),
  };
}

/**
 * 预检用：Codex 数据目录与 `config.toml` 现在可用吗（不可用就抛 `PreflightBlockedError`）。
 *
 * 先过 `codexDir()` 的目录类型检查，再读一次 `readModelProvider()`——它就是写路径将要用的同一个
 * 事实来源（`model_provider`），所以预检与写入不会对「配置能不能读取和解析」给出相反结论。
 * **不在这里缓存**：预检与写入之间路径仍可能变化，这里只负责「此刻可以继续」，写入路径自己会
 * 再查一次（并同样 fail closed）。
 *
 * 配置文件不存在（`ENOENT` / `ENOTDIR`）由 `readModelProvider()` 返回默认 provider，不阻断——那是
 * 「这台机器没配过」，Codex 自己也会按 openai 处理。数据根或 `sessions` 被文件占住不属于这一档：
 * `codexDir()` 已先把它归为目录故障（`codex_home_unusable`），这里的 `ENOTDIR` 只剩检查之后路径
 * 又被改动的情形。
 */
async function assertCodexConfigReadable(): Promise<void> {
  const limit = await codexStorageWriteLimit();
  if (limit) throw new PreflightBlockedError({ code: limit.code, message: limit.reason, hint: limit.hint });
}

/**
 * 只读探测：先确认 Codex 数据目录可用，再检查配置的读取与解析故障。
 * 目录错误使用独立 code / hint，不能引导用户去修尚未读取的配置文件。
 * `null` = 未发现这些故障，不代表写权限或 writer 锁已检查。
 *
 * `preflight` 与 `writeLimit`（doctor 用）共用这一份判定——与 OpenCode 的
 * `opencodeWriteLimit()` 同一模式，同一件事不能有两条说法。判的只是「写路径能读取并解析配置吗」：
 * writer 锁 / Desktop 进程是**运行时状态**，不是存储属性，`watch doctor` 不该把它印成写入限制。
 *
 * 目录阶段由 `codexDir()` 只读检查数据根与 `sessions` 的路径类型：被文件占住、祖先不是目录或
 * 无法访问都归 `codex_home_unusable`；默认根与 `sessions` 尚未建立（`ENOENT`）不算故障，留给
 * 首次写入创建，显式 `CODEX_HOME` 则要求根目录已存在。
 *
 * 配置可读且合法（含未显式写 `model_provider`）或配置文件不存在（`ENOENT` / `ENOTDIR`）时返回
 * `null`，与写路径使用默认 provider 的约定一致；writer 锁、写权限等条件仍由后续步骤检查。
 */
async function codexStorageWriteLimit(): Promise<WriteLimit | null> {
  let home: string;
  try {
    home = codexDir();
  } catch (error) {
    return {
      code: 'codex_home_unusable',
      reason: error instanceof Error ? error.message : String(error),
      hint: '先按上述原因修正 CODEX_HOME 或恢复数据目录，再重试；数据目录可用之前 Watch 不会写入 Codex 会话，本次未写入任何内容。',
      kind: 'fault',
    };
  }
  try {
    await readModelProvider(home);
    return null;
  } catch (error) {
    return {
      code: error instanceof CodexConfigError ? error.code : 'codex_config_unreadable',
      reason: error instanceof Error ? error.message : String(error),
      hint: error instanceof CodexConfigError && error.code === 'codex_config_invalid'
        ? '修好该文件（或让 Codex 自己重建一次配置）后重试；配置可以读取并解析之前 Watch 不会写入 Codex 会话，确认零写入。'
        : '先检查配置文件及父目录的访问权限、路径和文件类型，恢复可读后重试；配置可以读取并解析之前 Watch 不会写入 Codex 会话，本次未写入任何内容。',
      // 这是可修的故障，不是「Watch 主动只读」：doctor 要把它算进 warnings，--strict 也要能捕获
      kind: 'fault',
    };
  }
}

/**
 * 子进程环境：custom provider 声明了 env_key = "OPENAI_API_KEY" 时 codex 只认环境变量。
 * 优先保留用户已设置的 OPENAI_API_KEY / CODEX_API_KEY；都没有则从 config.toml 当前
 * provider 段读 api_key，最后再 fallback 到 ~/.codex/auth.json。
 */
async function codexEnv(): Promise<NodeJS.ProcessEnv> {
  const codexHome = codexDir();
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return process.env;
  const env = { ...process.env };
  try {
    const cred = await readProviderCredential(codexHome);
    if (cred.apiKey) env.OPENAI_API_KEY = cred.apiKey;
    if (cred.baseUrl) env.OPENAI_BASE_URL = cred.baseUrl;
  } catch {
    // 这里**故意**吞掉读失败并继续走 auth.json（与写路径的 fail closed 不同）：
    // codexEnv() 只决定起子进程时注入哪个 API key，不写任何会话文件；
    // 读不出来时交给 codex 自己用它的配置解析去报错，比我们在这里替它下结论更准。
    // 不要把这条吞错复制到写路径——那里读不出来必须拒绝（见 readModelProvider）。
  }
  if (!env.OPENAI_API_KEY) {
    try {
      const auth = parseJsonObject(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
      if (auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
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
    throw new Error(`codex CLI 调用失败: ${clipCodePoints(detail, 500).text}`);
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
    throw new Error(`codex 输出中找不到最终回复: ${clipCodePoints(stdout, 500).text}`);
  }
  return { stdout, replyText };
}

/** 从 --json 事件流提取错误摘要（turn.failed / error 事件的最后一条 message） */
function eventErrorSummary(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseJsonObject(trimmed);
    if (!event) continue;
    if (event.type === 'turn.failed') {
      const err = asJsonObject(event.error);
      if (typeof err?.message === 'string') last = err.message;
    } else if (event.type === 'error' && typeof event.message === 'string') {
      last = event.message;
    } else if (event.type === 'item.completed') {
      const item = asJsonObject(event.item);
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
    const event = parseJsonObject(trimmed);
    if (!event) continue;
    const item = asJsonObject(event.item);
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
    const event = parseJsonObject(trimmed);
    if (!event) continue;
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

/** 协作写锁：写入前独占原生 per-thread 锁（收窄与原生 writer 的竞态窗口） */
async function acquireCodexWriteLock(
  ctx: { ref?: SessionRef },
): Promise<{ guard?: WriterLockGuard; warning?: string } | undefined> {
  const ref = ctx.ref;
  if (!ref || process.platform !== 'darwin') return undefined;
  // 锁路径依赖数据目录：目录故障在这里原样抛出，不归入下面的「被其他 writer 抢先持有」。
  const lockPath = threadWriterLockPath(ref.sessionId);
  try {
    const guard = await acquireThreadWriterLock(lockPath);
    return guard ? { guard } : undefined;
  } catch (error) {
    // 锁目录建不出来是可修的环境故障，不是「别人正在写」：降级为只探测并披露。
    // 协作锁只是收窄竞态窗口的增强，preflight 已经做过只读探测，写入本身仍可继续。
    if (error instanceof WriterLockDirError) {
      return {
        warning:
          `${error.message}；本次仍会写入，但写入期间无法独占原生 writer 锁——` +
          '若 Codex 正在写同一会话，仍可能互相覆盖；修好该目录（权限、同名文件占位或磁盘空间）后重试可恢复保护',
      };
    }
    // 锁在探测与取锁之间被别的 writer 拿走（或取锁失败）→ 拒绝写入，交由调用方转成结构化 blocked
    throw new PreflightBlockedError({
      code: 'codex_target_busy',
      sessionId: ref.sessionId,
      message: `Codex 会话 ${ref.sessionId} 在写入前被其他 writer 抢先持有，已拒绝写入`,
      hint: '稍后重试；本次未写入任何内容。',
    });
  }
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',

  // 只读探测（doctor 用）：与 preflight 共用 codexStorageWriteLimit()，两者不会给出相反结论
  writeLimit: async (): Promise<WriteLimit | null> => codexStorageWriteLimit(),

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('codex'), ['--version'], { timeout: 10_000 });
      return true;
    } catch (error) {
      if (isCommandMissing(error)) return false;
      throw new Error(describeDetectFailure('codex', error));
    }
  },

  parse: parseCodexSession,
  importTurns: importTurnsToCodex,
  textEventSupport: 'assistant',
  attachmentSupport: 'user-images',
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestCodexRollout,
  listSessions: (cwd) => listCodexRollouts(cwd),
  listSessionsCap: CODEX_LIST_LIMIT,
  // rollout 的 cwd 写在 session_meta 首行里：首行读不出来时它连属于哪个目录都不知道，
  // listSessions 只能跳过。跳过之后四条通道都不说话，所以交给 watch doctor 汇总披露。
  unattributable: () => codexUnattributableRollouts(),

  /**
   * 写入 Codex 侧前的目标级保护。
   * - 有目标会话：以原生 per-thread writer 锁为准，仅当锁被活进程持有才拒绝；
   *   锁文件不存在或只剩陈旧锁（无持有者）则放行，与 Desktop 是否运行无关。
   * - 无目标上下文，或 lsof 不可用：退回旧的 Desktop 进程检查（保守）。
   * 详见 docs/COMPATIBILITY.md 的 Codex 保护说明。
   */
  async preflight(ctx?: PreflightContext): Promise<void> {
    // 配置可读性与平台无关，必须在下面的 darwin 早退之前检查（第一百二十三轮）：
    // 写路径的 `importTurnsToCodex()` 会读 config.toml 的 model_provider，读不出来就 fail closed；
    // 预检不读它的话，`open --to codex --check` 会先说「可写入」、真正执行时再拒绝——
    // 与第二十七轮修过的 opencode 2.x「预检说的与做相反」是同一类缺陷。
    await assertCodexConfigReadable();
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
    // stat 失败不等于「没有锁」：只有 ENOENT 才是「没有 writer 登记，无共享文件可冲突」。
    // 路径被同名文件占住（ENOTDIR）/ 没有权限（EACCES）时读不出来 = 无法判定，按有锁处理；
    // stat 成功但不是普通文件（锁路径本身被同名目录占住）同样是「读不出锁状态」，
    // 以前算成 absent 会直接放行写入
    let lockState: 'absent' | 'present' | 'unreadable' = 'absent';
    try {
      lockState = (await stat(lockPath)).isFile() ? 'present' : 'unreadable';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lockState = 'unreadable';
    }
    if (lockState === 'absent') return; // 无 writer 登记：无共享文件可冲突
    if (lockState === 'unreadable') {
      throw new PreflightBlockedError({
        code: 'codex_lock_unreadable',
        sessionId: ref.sessionId,
        message: `无法读取 Codex 会话 ${ref.sessionId} 的 writer 锁状态（${escapeControlChars(lockPath)}），已保守拒绝写入`,
        hint: '检查该路径的权限，或是否有同名文件占住了 thread-writer-locks 目录后重试；本次未写入任何内容。',
      });
    }
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
      throw new Error(`codex 输出缺少 thread.started: ${clipCodePoints(stdout, 500).text}`);
    }
    return { ref, turn: replyTurn(replyText) };
  },

  /** codex exec resume <id> <text>：续聊并取最终回复 */
  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const { replyText } = await runCodex(['resume', ref.sessionId, text], ref.cwd, onEvent);
    return replyTurn(replyText);
  },

  resumeCommand(ref: SessionRef, windows?: boolean): string {
    return `codex resume ${quoteCommandArg(ref.sessionId, windows)}`;
  },

  findById: findCodexSessionById,

  acquireWriteLock: acquireCodexWriteLock,

  sessionUsage: codexSessionUsage,

  zeroTurnProblem: codexZeroTurnProblem,
};
