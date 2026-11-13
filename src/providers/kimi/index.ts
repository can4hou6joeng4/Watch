import { execFile } from 'node:child_process';
import { describeBrokenCommandStart, describeDetectFailure, isCommandMissing, resolveCli } from '../../core/platform.js';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import { asJsonObject, parseJsonObject } from '../../core/jsonl.js';
import { describeEmptySessionFile, describePathReadFailureReason, isMissingPathError } from '../../core/read-text.js';
import { escapeControlChars } from '../../core/display.js';
import { SessionLookupFailureError } from '../adapter.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import { parseKimiSession, usageFromRecord } from './parse.js';
import {
  encodeKimiWorkspaceDir,
  findKimiSessionDirOnDisk,
  importTurnsToKimi,
  kimidir,
  kimiIndexLoss,
  kimiSessionsRoot,
  kimiUntrackedSessions,
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
    const event = parseJsonObject(trimmed);
    if (!event) continue;
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
      // 同 build.ts：先分清「PATH 里没有 kimi」与「文件在、shebang 解释器不在」
      const broken = describeBrokenCommandStart('kimi');
      if (broken) throw new Error(`kimi CLI 启动失败（不是 PATH 里没有 kimi）：${broken}`);
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
  // 0 字节不是「还没有用户消息」：内容已经没了，open / switch 同样读不了它
  if (raw.length === 0) return { text: null, error: describeEmptySessionFile(filePath) };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const event = parseJsonObject(line);
    if (!event || event.type !== 'turn.prompt') continue;
    const input = event.input;
    if (!Array.isArray(input)) continue;
    for (const block of input) {
      const b = asJsonObject(block);
      if (b?.type === 'text') {
        const text = typeof b.text === 'string' ? b.text : '';
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
    throw new SessionLookupFailureError(
      'incomplete',
      `无法读取 Kimi 会话索引 ${escapeControlChars(idxFile)}：${describePathReadFailureReason(error)}`,
    );
  }
  const unreadable: string[] = [];
  let parseable = 0;
  let unparsable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseJsonObject(line);
    if (!rec) {
      // 非对象 JSON（null / [] / 标量）既不能当有效索引条目，也要和语法坏行同档计入 unparsable，
      // 否则全为非对象行的坏索引会绕过 kimiIndexLoss / unattributable 守卫。
      unparsable += 1;
      continue;
    }
    parseable += 1;
    if (rec.sessionId !== sessionId) continue;
    const sessionDir = typeof rec.sessionDir === 'string' ? rec.sessionDir : '';
    const workDir = typeof rec.workDir === 'string' ? rec.workDir : '';
    if (!sessionDir || !workDir) {
      unreadable.push(`${escapeControlChars(idxFile)} 里该会话缺少 sessionDir / workDir`);
      continue;
    }
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    try {
      const st = await stat(wirePath);
      // 路径在但不是普通文件（被同名目录 / 设备文件占住）：不能返回一个指向目录的 ref，
      // 否则这里报「找到了」，下游 parse / usage 才抛出裸 EISDIR（英文）
      if (!st.isFile()) {
        unreadable.push(`${escapeControlChars(wirePath)} 现在不是普通文件（被同名目录或设备文件占住了）`);
        continue;
      }
      return { ref: { provider: 'kimi', sessionId, filePath: wirePath, cwd: workDir }, updatedAt: st.mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 索引里明确记着这个会话，wire 却没了 / 读不出来：都不是「会话不存在」
      unreadable.push(
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `${escapeControlChars(wirePath)} 不存在（索引里有这条会话，可能已被删除）`
          : `${escapeControlChars(wirePath)}（${describePathReadFailureReason(error)}）`,
      );
      continue;
    }
  }
  if (unreadable.length) {
    throw new SessionLookupFailureError(
      'found-unreadable',
      `Kimi 索引里有会话 ${sessionId}，但读不出它的会话文件，无法确认它是否可用：${escapeControlChars(unreadable[0])}`,
    );
  }
  // 索引里有些行损坏时，这个 id 可能正是随着坏行一起丢掉的那一条：磁盘上有它的目录，
  // 但它属于哪个目录已经不可知（workspaceId 里的 hash 不可逆）。这时同样不能返回 null——
  // 那会让 `open` 说「未找到会话…请确认 id 正确」，而 id 恰恰是抄对的
  if (unparsable > 0) {
    const wirePath = await findKimiSessionDirOnDisk(sessionId);
    if (wirePath) {
      throw new SessionLookupFailureError(
        'incomplete',
        `Kimi 会话索引 ${escapeControlChars(idxFile)} 里有 ${unparsable} 行无法解析，磁盘上存在会话 ${sessionId} 的目录（${escapeControlChars(wirePath)}），` +
          '但它在索引里的那条记录已经损坏，读不出它属于哪个工作目录，因此无法确认它是否可用；' +
          '这不代表这个会话不存在——先确认索引文件能否从备份恢复（别直接删掉它）再重试',
      );
    }
  }
  // 索引里一条记录都解析不出来、磁盘上却还有会话目录：这不是「这家没有这个会话」，是查不了。
  // 返回 null 会让 `open` 说「未找到会话…请确认 id 正确」，而 id 恰恰是抄对的
  const loss = await kimiIndexLoss(idxFile, raw, parseable);
  if (loss) throw new SessionLookupFailureError('incomplete', loss);
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
 * Kimi 会话用量（信息层）：累加 wire.jsonl 里的用量 → inputTokens/outputTokens。
 * input 含 inputOther + inputCacheRead + inputCacheCreation；无用量记录时返回 null（对齐无 usage 语义）。
 *
 * 两种形状都要认：原生把用量记成顶层 `usage.record`，而 Watch 的写出侧
 * （`buildKimiWireLines()`）写在 `context.append_loop_event` → `event.type === 'step.end'`
 * → `event.usage`。以前只认前者，于是 Watch 自己转出的会话一律被报成「无 usage 数据」。
 * 判定规则与 `parse.ts` 一致：**同一轮**里已有 `usage.record` 就以它为准（两种形状同时存在
 * 时不能叠加，否则翻倍）；没有 `usage.record` 时取该轮最后一条 `step.end.usage`
 * （写出侧把同一条 turn 的用量同时挂在多个 step 上，逐条累加会重复计入）。
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
  // 当前这一轮（assistant）的状态：是否已有 usage.record、以及最后一条 step.end 的用量
  let turnHasRecord = false;
  let pendingStepUsage: TokenUsage | null = null;
  const flushTurn = (): void => {
    if (!turnHasRecord && pendingStepUsage) {
      input += pendingStepUsage.inputTokens;
      output += pendingStepUsage.outputTokens;
      saw = true;
    }
    turnHasRecord = false;
    pendingStepUsage = null;
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const r = parseJsonObject(line);
    if (!r) continue;
    if (r.type === 'usage.record') {
      // 原生还会按 step 记 usage（`usageScope: "step"`）。那些是同一轮拆出来的中间量，
      // 计入就会翻倍：ccusage（ccusage/ccusage，19.4k stars）的 kimi 适配器只认
      // `usageScope === "turn"` 的记录，其它一律跳过。这里同样只在「显式写了别的 scope」时跳过，
      // 没有 `usageScope` 的记录照旧累加（历史文件与本地回归的既有形状）。
      if (typeof r.usageScope === 'string' && r.usageScope !== 'turn') continue;
      const usage = asJsonObject(r.usage);
      if (!usage) continue;
      input += toNum(usage.inputOther) + toNum(usage.inputCacheRead) + toNum(usage.inputCacheCreation);
      output += toNum(usage.output);
      saw = true;
      turnHasRecord = true;
      continue;
    }
    if (r.type === 'context.append_loop_event') {
      const e = asJsonObject(r.event);
      if (!e || e.type !== 'step.end') continue;
      const usage = usageFromRecord(asJsonObject(e.usage));
      if (usage) pendingStepUsage = usage;
      continue;
    }
    if (r.type === 'turn.ended' || r.type === 'turn.prompt' || r.type === 'turn.steer') flushTurn();
  }
  flushTurn();
  return saw ? { inputTokens: input, outputTokens: output } : null;
}

export const kimiAdapter: ProviderAdapter = {
  id: 'kimi',
  displayName: 'Kimi',
  toolFailureSupport: 'assistant',

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
  unattributable: kimiUntrackedSessions,

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
