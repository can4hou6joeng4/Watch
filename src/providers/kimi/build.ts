import { execFile } from 'node:child_process';
import { describeBrokenCommandStart, resolveCli } from '../../core/platform.js';
import { escapeControlChars } from '../../core/display.js';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { inspectCwd, type CwdInspection } from '../../core/cwd.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { describePathReadFailureReason } from '../../core/read-text.js';
import { assistantOnlyIncrementReason, assistantTurnTextForWrite, userTurnTextForWrite } from '../../core/rich.js';
import { expectAttachmentPlaceholders, verifyWrittenTurns } from '../../core/verify.js';
import { parseKimiSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import { cliDetectFailedBlock, cliMissingBlock, PreflightBlockedError } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

const execFileAsync = promisify(execFile);

const HEADER_TYPES = new Set(['metadata', 'runtime.set_binding', 'profile.bind', 'permission.set_mode']);

export function kimiSessionsRoot(): string {
  return path.join(homedir(), '.kimi-code', 'sessions');
}

/** Kimi workspaceId：wd_<sanitized-name>_<sha256(cwd).slice(0,12)> */
export function encodeKimiWorkspaceDir(cwd: string): string {
  const base = path.basename(cwd);
  let name = base
    .replace(/[^a-zA-Z0-9.-]/g, '')
    .toLowerCase()
    .slice(0, 40);
  if (!name) name = 'workspace';
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return `wd_${name}_${hash}`;
}

export function kimidir(): string {
  return path.join(homedir(), '.kimi-code');
}

/**
 * 磁盘上真实存在的 Kimi 会话目录（数到 `agents/main/wire.jsonl` 为止）。
 *
 * 用来分辨两种「索引里查不到会话」：真没用过 Kimi（目录也是空的），与索引被截断 / 损坏
 * （会话目录还在，只是没人记得它们属于哪个目录）。读不出来的目录**不计入**——查不出来就不能
 * 反过来断言「磁盘上确实还有会话」。
 *
 * `workspaceId` 是 `wd_<name>_<sha256(cwd) 前 12 位>`，**不可逆**：从目录名推不回 cwd。
 * 所以这一档只能披露「有这些会话、但归属丢了」，不能替它们猜目录。
 */
async function scanKimiSessionDirs(): Promise<{ sessionId: string; wirePath: string }[]> {
  const root = kimiSessionsRoot();
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { sessionId: string; wirePath: string }[] = [];
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let sessions: Dirent[];
    try {
      sessions = await readdir(path.join(root, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const wirePath = path.join(root, ws.name, s.name, 'agents', 'main', 'wire.jsonl');
      try {
        const st = await stat(wirePath);
        if (st.isFile()) found.push({ sessionId: s.name, wirePath });
      } catch {
        // 没有 wire.jsonl 的目录不是会话；读不出来同样不计入
      }
    }
  }
  return found;
}

async function countKimiSessionDirs(): Promise<number> {
  return (await scanKimiSessionDirs()).length;
}

/** 磁盘上是否有这个 sessionId 的会话目录（索引坏了时用来区分「没这条」与「归属丢了」） */
export async function findKimiSessionDirOnDisk(sessionId: string): Promise<string | null> {
  const hit = (await scanKimiSessionDirs()).find((d) => d.sessionId === sessionId);
  return hit ? hit.wirePath : null;
}

/**
 * 「索引确实有无法解析的行、磁盘上还有没被登记成会话的目录」时的说明；`null` = 不是这一档。
 *
 * 索引被截断最常见的样子不是整份变空，而是**最后一行写了一半**：那一条会话的归属随坏行一起丢掉，
 * 它从所有目录的列表里消失，而 `listSessions` 仍然返回一份看起来正常的列表、`doctor` 也报一个
 * 看起来正常的条数。这一档与「索引整份没了」（`kimiIndexLoss()` 直接抛错）不同：列表还有内容，
 * 属于降级而不是做不成，所以走 `ProviderAdapter.unattributable` 通道（与 Codex 归属行坏掉同构，
 * `sessions` / `recent` / `status` / `doctor` / `search` 共用 `session-coverage.ts` 的文案）。
 *
 * **只在索引确实有坏行时才报**：`importTurnsToKimi()` 不写 `session_index.jsonl`，它转出的会话
 * 目录本来就不在索引里；索引健康时把那些说成「因损坏丢失」是假警。
 */
export async function kimiUntrackedSessions(): Promise<{
  count: number;
  samples: string[];
  summary?: string;
}> {
  const none = { count: 0, samples: [] as string[] };
  const indexPath = path.join(kimidir(), 'session_index.jsonl');
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    // 索引不存在 = 没用过 Kimi；读不出来已由 `listSessions` / `findById` 自己的通道说过
    return none;
  }
  const indexed = new Set<string>();
  let unparsable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseJsonObject(line);
    if (!rec) {
      // 合法 JSON 的 null / 数组 / 标量同样不是索引记录；不计数会让 collectUnattributable / unattributable 静默漏报。
      unparsable += 1;
      continue;
    }
    if (typeof rec.sessionId === 'string') indexed.add(rec.sessionId);
  }
  if (unparsable === 0) return none;
  const untracked = (await scanKimiSessionDirs()).filter((d) => !indexed.has(d.sessionId));
  if (untracked.length === 0) return none;
  return {
    count: untracked.length,
    samples: untracked.slice(0, 3).map((d) => d.wirePath),
    summary: '会话索引里对应的记录',
  };
}

/**
 * 「索引在、却一条可解析记录都没有，而磁盘上还有会话目录」时的说明；`null` = 不是这一档。
 *
 * 判据只有一处：`listKimiSessionsByCwd()`（列表 / `findLatestSession`）与 `findKimiSessionById()`
 * （按 id 反查）都要区分「没用过 Kimi」与「索引已经没了」，两边各写一套必然跑偏。
 */
export async function kimiIndexLoss(
  indexPath: string,
  raw: string,
  parseable: number,
): Promise<string | null> {
  if (parseable > 0) return null;
  const onDisk = await countKimiSessionDirs();
  if (onDisk === 0) return null;
  const what =
    raw.trim().length === 0
      ? '文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）'
      : '全部行都无法解析（截断或损坏，内容已丢失）';
  return (
    `Kimi 会话索引 ${escapeControlChars(indexPath)} 里没有任何可解析的记录：${what}，` +
    `而 ${escapeControlChars(kimiSessionsRoot())} 下还有 ${onDisk} 个会话目录——这些会话无法归属到任何目录，` +
    '因此不会出现在任何目录的会话列表里，按 id 也查不到；这不代表它们不存在，' +
    '先确认索引文件能否从备份恢复（别直接删掉它）再重试'
  );
}

/**
 * 通过 session_index.jsonl 把 workDir 映射到 session 目录。
 * 该文件由 Kimi 维护，比扫描目录更可靠。
 */
export async function listKimiSessionsByCwd(
  cwd: string,
): Promise<{ sessionId: string; sessionDir: string; updatedAt: number }[]> {
  const indexPath = path.join(kimidir(), 'session_index.jsonl');
  const items: { sessionId: string; sessionDir: string; updatedAt: number }[] = [];
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 索引不存在 = 这台机器没用过 kimi；读不出来要抛出交给调用方披露，
    // 否则「索引损坏 / 没权限」会被讲成「这个目录没聊过」
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new Error(
      `无法读取 Kimi 会话索引 ${escapeControlChars(indexPath)}：${describePathReadFailureReason(error)}`,
    );
  }
  let parseable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseJsonObject(line);
    if (!rec) continue;
    parseable += 1;
    if (rec.workDir !== cwd) continue;
    const sessionDir = typeof rec.sessionDir === 'string' ? rec.sessionDir : '';
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';
    if (!sessionDir || !sessionId) continue;
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    try {
      const st = await stat(wirePath);
      // 同名目录 / 设备文件不是会话：claude / pi / grok 的列表同样按 isFile() 过滤。
      // 以前只 stat 就 push，列表里会多出打不开的一条，findLatest 还会把它当最新来源
      if (!st.isFile()) continue;
      items.push({ sessionId, sessionDir, updatedAt: st.mtimeMs });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // wire 已删（索引陈旧）就跳过；其余读不出来不能静默丢——列表会少掉一条却毫无提示
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new Error(
        `无法读取 Kimi 会话文件状态 ${escapeControlChars(wirePath)}：${describePathReadFailureReason(error)}`,
      );
    }
  }
  // 索引读得出来、却一条记录都解析不出来时，「这个目录没有 Kimi 会话」是句结论而不是事实：
  // 先看磁盘上还有没有会话目录（有就是索引被截断 / 损坏，得说「查不了」）
  const loss = await kimiIndexLoss(indexPath, raw, parseable);
  if (loss) throw new Error(loss);
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/**
 * 新建会话前目标目录不可用时的说法。按 `inspectCwd()` 的分档各说一句：
 * 「不存在」让人去核对路径，「无权访问」让人去修权限，把两者混成一句
 * 「不存在或不是目录」会让权限问题被当成路径写错，白改一遍 `--cwd`。
 */
function describeUnusableTargetCwd(cwd: string, probe: Exclude<CwdInspection, { state: 'ok' }>): string {
  const tail = '新建 Kimi 会话需要在目标目录里运行 kimi CLI';
  switch (probe.state) {
    case 'missing':
      return `目标工作目录不存在（路径上的某一级可能被同名文件占住）：${escapeControlChars(cwd)}；${tail}`;
    case 'not-directory':
      return `目标工作目录不是目录（被同名文件占住了）：${escapeControlChars(cwd)}；${tail}`;
    case 'denied':
      return `目标工作目录无权访问（权限问题，不是路径写错）：${escapeControlChars(cwd)}；${tail}`;
    case 'unknown':
      return `无法确认目标工作目录能否使用（${probe.reason}）：${escapeControlChars(cwd)}；${tail}`;
  }
}

/**
 * 新建一个真实的 Kimi 会话（用最小提示词），然后截断 wire.jsonl 到只剩头部事件。
 * 返回 sessionId 与 wire.jsonl 路径。
 * 依赖原生 CLI 登记会话目录与 `session_index.jsonl`；需要已登录，且会产生一次模型调用。
 */
async function createRealKimiSession(cwd: string): Promise<{ sessionId: string; filePath: string }> {
  // 目录不可用与「PATH 里没有 kimi」在 spawn 层都是 ENOENT，先分开判定再给准确报错。
  // 这里以前是 `catch { cwdUsable = false }`，EACCES（父目录不可搜索 / 权限被收走）会被讲成
  // 「不存在或不是目录」——用户会去核对路径，而真正要修的是权限
  const probe = await inspectCwd(cwd);
  if (probe.state !== 'ok') {
    throw new Error(describeUnusableTargetCwd(cwd, probe));
  }

  let stdout: string;
  try {
    const out = await execFileAsync(resolveCli('kimi'), ['-p', '.', '--output-format', 'stream-json'], {
      cwd,
      timeout: 120_000,
    });
    stdout = out.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
    if (err.code === 'ENOENT') {
      // ENOENT 有两种：PATH 里没有 kimi（真的没装），与「文件在、shebang 解释器不在」
      // （libuv 对两者报同一个 errno）。后者说成 cli_missing 会把用户引去重装一个装着的 CLI。
      const broken = describeBrokenCommandStart('kimi');
      if (broken) throw new PreflightBlockedError(cliDetectFailedBlock('kimi', 'Kimi', broken));
      // 与 `open --to` / `--check` 走同一份阻断：CLI 没装是**预期内的前置条件不满足**，
      // 不是内部错误。以前这里抛裸 Error，`new` / `switch` 只能回一句「找不到 kimi 命令」，
      // 既没有 blocked / code，也不说「未写入任何内容」——同一件事四条写路径两种口径
      throw new PreflightBlockedError(cliMissingBlock('kimi', 'Kimi'));
    }
    const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const detail = (pick(err.stderr) || pick(err.stdout) || err.message || String(error)).slice(0, 500);
    throw new Error(`kimi 新建会话失败: ${detail}`);
  }

  const sessionId = extractSessionIdFromStream(stdout);
  if (!sessionId) {
    throw new Error(`kimi 输出缺少 session.resume_hint: ${stdout.slice(0, 500)}`);
  }

  const workspaceId = encodeKimiWorkspaceDir(cwd);
  const filePath = path.join(kimiSessionsRoot(), workspaceId, sessionId, 'agents', 'main', 'wire.jsonl');

  // 截断到头部事件，去掉刚才的 dummy prompt 产生的对话
  await truncateToHeader(filePath);

  return { sessionId, filePath };
}

function extractSessionIdFromStream(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseJsonObject(trimmed);
    if (!event) continue;
    if (event.role === 'meta' && event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      return event.session_id;
    }
  }
  return null;
}

async function truncateToHeader(filePath: string): Promise<void> {
  const raw = await readFile(filePath, 'utf8');
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const event = parseJsonObject(line);
    if (!event) continue;
    if (HEADER_TYPES.has(typeof event.type === 'string' ? event.type : '')) {
      lines.push(line);
    }
  }
  await writeFileAtomic(filePath, lines.join('\n') + (lines.length ? '\n' : ''), { backup: true });
}

/** wire.jsonl 的非空行（保持原顺序，含头部与历史事件）；文件缺失时按裸 ENOENT 抛出 */
async function readWireLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    // 追加 / replace 都要先读既有 wire：读不出来就整次拒绝，绝不能用「只有新内容」覆盖历史。
    // 与 pi / grok 的 readTextOrEmpty 同一套中文分档，不能把裸 EISDIR / EACCES 抛给用户
    throw new Error(
      `读取既有 Kimi 会话文件失败：${describePathReadFailureReason(error)}（${escapeControlChars(filePath)}）；未写入，避免用空内容覆盖既有历史`,
    );
  }
  return raw.split('\n').filter((line) => line.trim() !== '');
}

function isHeaderLine(line: string): boolean {
  const event = parseJsonObject(line);
  return event !== null && HEADER_TYPES.has(typeof event.type === 'string' ? event.type : '');
}

/**
 * 追加时从**已经读进内存的**既有行里取下一个 turn id。
 *
 * 以前这里自己再 `readFileSync` 一次并 `catch { ignore }`：既多读一遍，又在两次读取之间
 * 文件被删 / 权限变化时静默退回 0——新 turn 的 id 会与内存里那份前缀撞车。直接用 existingLines，
 * 与真正写出的前缀永远是同一份内容；坏行跳过（`parseJsonObject` 返回 null），不退回 0。
 */
function nextTurnId(lines: string[]): number {
  let maxTurn = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = parseJsonObject(line);
    if (!event) continue;
    if (event.type === 'turn.ended') {
      const turnId = typeof event.turnId === 'number' ? event.turnId : -1;
      if (turnId > maxTurn) maxTurn = turnId;
    }
  }
  return maxTurn + 1;
}

function tsMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/** kimi step.end 的 usage 形状：有源侧真实用量时写入，否则 0 占位 */
function kimiUsage(turn: UnifiedTurn): { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number } {
  return {
    inputOther: turn.usage?.inputTokens ?? 0,
    output: turn.usage?.outputTokens ?? 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
}

/** 把 UnifiedTurn[] 写成 Kimi wire.jsonl 尾部事件 */
export function buildKimiWireLines(turns: UnifiedTurn[], startTurnId: number): string[] {
  const lines: string[] = [];
  let turnId = startTurnId;

  // 把各 turn 时间戳规整为严格递增：同源导入常把所有 turn 打成同一时刻，
  // Kimi 会把它当成同一轮，导致历史丢失。每轮至少错开 1 秒。
  let lastTurnTime = 0;
  const turnTimes: number[] = [];
  for (const turn of turns) {
    let t = tsMs(turn.timestamp);
    if (t <= lastTurnTime) t = lastTurnTime + 1000;
    turnTimes.push(t);
    lastTurnTime = t;
  }

  // 同一 step 内相邻事件的时间间隔。Kimi 原生通常为 0–2ms；这里用 100ms
  // 确保即使 Kimi 按毫秒级时间排序，最终文本也严格落在 tool/thinking 之后。
  const EVENT_DT = 100;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const t = turnTimes[i]!;

    if (turn.role === 'user') {
      const userText = userTurnTextForWrite(turn);
      const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      lines.push(
        JSON.stringify({
          type: 'turn.prompt',
          agentId: 'main',
          input: [{ type: 'text', text: userText }],
          origin: { kind: 'user' },
          time: t,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_message',
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: userText }],
            toolCalls: [],
            origin: { kind: 'user' },
            id: msgId,
          },
          time: t + 1,
        }),
      );
      continue;
    }

    const turnIdStr = String(turnId);
    const events = turn.events ?? [];
    // 只搬正文的目标由这里决定实际写什么：纯附件助手轮必须留下占位文本，
    // 否则 describeAttachmentLoss 的「只留占位」承诺在助手侧落空。
    const bodyText = assistantTurnTextForWrite(turn);
    const hasText = bodyText.trim().length > 0;
    const hasEvents = events.length > 0;

    const hasToolCalls = events.some((e) => e.kind === 'tool_call');

    // Step 1：thinking / tool.call / tool.result。
    // Kimi TUI 在同一个 step 内会把所有 content.part 排在 tool.call 之前，
    // 因此最终文本必须放在独立的 step 2，才能显示在工具调用之后。
    if (hasEvents) {
      const stepUuid1 = randomUUID();
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: { type: 'step.begin', uuid: stepUuid1, turnId: turnIdStr, step: 1 },
          time: t,
        }),
      );
      for (let i = 0; i < events.length; i++) {
        lines.push(...eventToWireLines(events[i]!, turnIdStr, stepUuid1, t + 2 + i * EVENT_DT));
      }
      const step1EndTime = t + 2 + events.length * EVENT_DT;
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'step.end',
            uuid: stepUuid1,
            turnId: turnIdStr,
            step: 1,
            finishReason: hasToolCalls ? 'tool_use' : 'end_turn',
            usage: kimiUsage(turn),
          },
          time: step1EndTime,
        }),
      );
    }

    // Step 2：最终回复文本（如果有）。
    let finalEndTime = t + 2 + events.length * EVENT_DT;
    if (hasText) {
      const textStartTime = finalEndTime + EVENT_DT;
      const stepUuid2 = randomUUID();
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: { type: 'step.begin', uuid: stepUuid2, turnId: turnIdStr, step: hasEvents ? 2 : 1 },
          time: textStartTime,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turnIdStr,
            step: hasEvents ? 2 : 1,
            stepUuid: stepUuid2,
            part: { type: 'text', text: bodyText },
          },
          time: textStartTime + 1,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'step.end',
            uuid: stepUuid2,
            turnId: turnIdStr,
            step: hasEvents ? 2 : 1,
            finishReason: 'end_turn',
            usage: kimiUsage(turn),
          },
          time: textStartTime + 2,
        }),
      );
      finalEndTime = textStartTime + 3;
    }

    lines.push(
      JSON.stringify({
        type: 'turn.ended',
        agentId: 'main',
        turnId,
        reason: 'completed',
        durationMs: 1,
        time: finalEndTime,
      }),
    );

    turnId += 1;
  }

  return lines;
}

function eventToWireLines(ev: ProcessEvent, turnId: string, stepUuid: string, time: number): string[] {
  const t = time;
  if (ev.kind === 'thinking') {
    const think = ev.detail ?? ev.summary;
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'content.part',
          uuid: randomUUID(),
          turnId,
          step: 1,
          stepUuid,
          part: { type: 'think', think },
        },
        time: t,
      }),
    ];
  }

  if (ev.kind === 'tool_call') {
    const callUuid = randomUUID();
    const callId = ev.callId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.call',
          uuid: callUuid,
          turnId,
          step: 1,
          stepUuid,
          toolCallId: callId,
          name: ev.name ?? 'tool',
          args: ev.input ?? {},
        },
        time: t,
      }),
    ];
  }

  if (ev.kind === 'tool_result') {
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.result',
          parentUuid: randomUUID(),
          turnId,
          step: 1,
          stepUuid,
          toolCallId: ev.callId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          result: { output: ev.detail ?? ev.summary ?? '', ...(ev.failed === true ? { isError: true } : {}) },
        },
        time: t,
      }),
    ];
  }

  return [];
}

/** UnifiedTurn[] → Kimi wire.jsonl；无 into 时新建真实会话，再重写历史 */
export async function importTurnsToKimi(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${escapeControlChars(cwd)}`);
  }
  if (into && !opts?.replace) {
    const reason = assistantOnlyIncrementReason(turns);
    if (reason) throw new Error(reason);
  }

  let filePath: string;
  let sessionId: string;

  if (into?.filePath) {
    filePath = into.filePath;
    sessionId = into.sessionId;
  } else {
    const created = await createRealKimiSession(cwd);
    filePath = created.filePath;
    sessionId = created.sessionId;
  }

  const existingLines = await readWireLines(filePath);
  const startTurnId = opts?.replace ? 0 : nextTurnId(existingLines);

  // replace：保留已有头部、用 turns 重写整段历史。
  // 追加：必须保留既有 wire 行再写增量；只写头部+增量会让 Kimi 丢掉全部旧历史。
  const prefix = opts?.replace ? existingLines.filter(isHeaderLine) : existingLines;
  const bodyLines = buildKimiWireLines(turns, startTurnId);
  await writeFileAtomic(filePath, [...prefix, ...bodyLines].join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseKimiSession({ provider: 'kimi', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'kimi',
        expect: expectAttachmentPlaceholders,
      }),
  });

  return { provider: 'kimi', sessionId, filePath, cwd };
}
