import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDataDirectory, providerDirectoryFromEnv } from '../../core/provider-directory.js';
import { describePathReadFailureReason } from '../../core/read-text.js';
import { escapeControlChars } from '../../core/display.js';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { parseJsonObject } from '../../core/jsonl.js';
import { readTextOrEmpty } from '../../core/read-text.js';
import { assistantOnlyIncrementReason, assistantTurnTextForWrite, toolInputAsRecord, userTurnTextForWrite } from '../../core/rich.js';
import { expectAttachmentPlaceholders, verifyWrittenTurns } from '../../core/verify.js';
import { parsePiSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

/**
 * Pi 配置目录：官方 `getAgentDir()` 优先读 `PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`。
 * 按原生规则展开 `~` 与 `~/`（win32 另认 `~\`），其余要求绝对路径。
 */
export function piAgentDirFrom(home: string): string {
  return providerDirectoryFromEnv('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'), home);
}

/** Pi sessions 的布局来源：环境变量 / 设置文件 / 默认目录。 */
export type PiSessionsLayout = {
  root: string;
  /** true = 原生显式目录，文件直接平铺；false = `<root>/<encoded-cwd>` 分组 */
  flat: boolean;
  source: 'env' | 'settings' | 'default';
};

type PiSettingsLayer =
  | { kind: 'absent' }
  | { kind: 'ok'; path: string; hasKey: boolean; value: unknown };

/**
 * 读取一层 Pi 设置（全局 `<agent-dir>/settings.json` 或项目 `<cwd>/.pi/settings.json`）。
 *
 * 原生 `loadFromStorage` 对缺失 / 0 字节文件按 `{}` 处理；JSON 解析失败时该层也按 `{}`
 * 继续，并在运行诊断里给出警告。Watch 没有设置层的警告通道，因此解析失败会直接拒绝
 * 本次解析——不能让一个坏掉的设置悄悄退回默认目录，再把结果讲成「这个项目没有会话」。
 * 不照搬原生 `FileSettingsStorage.withLock`：只读解析不取锁，也不建文件。
 */
function piSettingsLayer(filePath: string): PiSettingsLayer {
  let raw: string;
  try {
    // 设备文件 / FIFO 不能交给同步读取，否则一次只读列表也可能永久阻塞。
    const info = statSync(filePath);
    if (!info.isFile()) throw new Error('该路径不是普通设置文件');
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    throw new Error(
      `无法读取 Pi 设置文件 ${escapeControlChars(filePath)}：${code === 'ENOTDIR' ? '路径上的某一级不是目录（被文件占住）' : describePathReadFailureReason(error)}；` +
        '无法确认 Pi 实际使用的会话目录，本次没有按默认目录继续，也不会把它当成「没有会话」。先恢复该文件的可读性后重试',
    );
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.length === 0) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Pi 设置文件 ${escapeControlChars(filePath)} 不是有效的 JSON；` +
        '原生会忽略这一层并继续，但 Watch 无法确认这一层是否本来要覆盖会话目录，本次没有按默认目录继续。' +
        '请修好该文件（或临时移走）后重试',
    );
  }
  // 原生不校验设置对象的 schema；非对象展开后不提供任何键，按空层处理。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'ok', path: filePath, hasKey: false, value: undefined };
  }
  const hasKey = Object.prototype.hasOwnProperty.call(parsed, 'sessionDir');
  return { kind: 'ok', path: filePath, hasKey, value: (parsed as Record<string, unknown>).sessionDir };
}

/** 与原生一致的 `~` 展开：只认 `~` / `~/`，win32 另认 `~\`；其余路径保留空白。 */
function expandPiHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return join(home, value.slice(2));
  }
  return value;
}

/**
 * 把设置里的 `sessionDir` 解析成绝对目录；falsy 值（缺省 / null / false / 0 / 空串）
 * 表示未设置，与原生 `getSessionDir()` 的 truthy 判定一致。
 *
 * 相对路径不能按 Watch 的 cwd 绝对化：原生由实际进程 cwd 解释，两者可能不同。
 * 已存在的非目录与读取失败照常抛出；不存在的目录留给写入创建（与原生 create 一致）。
 */
function resolvePiSessionDirValue(value: unknown, sourcePath: string, home: string): string | null {
  if (!value) return null;
  if (typeof value !== 'string') {
    throw new Error(
      `Pi 设置 ${escapeControlChars(sourcePath)} 里的 sessionDir 不是字符串（实际是 ${Array.isArray(value) ? 'array' : typeof value}）；` +
        '原生会在启动时因此报错。请改为绝对路径字符串后重试',
    );
  }
  let dir = value;
  if (dir.startsWith('file://')) {
    try {
      dir = fileURLToPath(dir);
    } catch {
      throw new Error(
        `Pi 设置 ${escapeControlChars(sourcePath)} 里的 sessionDir 是无法解析的 file:// URL：${escapeControlChars(value)}；请改为绝对路径后重试`,
      );
    }
  }
  dir = expandPiHome(dir, home);
  const currentDriveRoot = process.platform === 'win32' && /^[\\/](?![\\/])/.test(dir);
  if (!dir || !isAbsolute(dir) || currentDriveRoot) {
    throw new Error(
      `Pi 设置 ${escapeControlChars(sourcePath)} 里的 sessionDir 需要绝对路径，收到：${escapeControlChars(value)}；` +
        '原生会按 Pi 进程的工作目录解释相对路径，Watch 与 Pi 的启动目录可能不同，不能猜成同一个位置。请改为完整绝对路径后重试',
    );
  }
  // 不存在的目录仍交给首次写入创建（与原生 create 一致）；已存在的非目录与读取失败必须提前暴露。
  let info;
  try {
    info = statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return dir;
    if (code === 'ENOTDIR') {
      throw new Error(
        `Pi 设置中的 sessionDir 指向的路径有一级不是目录（被文件占住）：${escapeControlChars(dir)}；` +
          `来源：${escapeControlChars(sourcePath)}。请恢复该路径或修改设置后重试`,
      );
    }
    throw new Error(
      `无法读取 Pi 设置中的 sessionDir 指向的路径 ${escapeControlChars(dir)}：${describePathReadFailureReason(error)}；` +
        `来源：${escapeControlChars(sourcePath)}。请先恢复路径的可访问性后重试`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      `Pi 设置中的 sessionDir 指向的不是目录（被文件占住）：${escapeControlChars(dir)}；` +
        `来源：${escapeControlChars(sourcePath)}。请恢复该路径或修改设置后重试`,
    );
  }
  return dir;
}

/**
 * 解析 Pi 会话根：`--session-dir`（单次参数，Watch 看不到）→ `PI_CODING_AGENT_SESSION_DIR`
 * → 设置 `sessionDir`（项目覆盖全局，空串也算覆盖）→ `<agent-dir>/sessions`。
 *
 * 项目设置只在提供 cwd 时读取；全局按 id 反查没有 cwd，只能看到全局设置与默认目录。
 * 注入的 `sessionsRoot` 不经过这里，仍保持项目分组语义。
 */
export function piSessionsLayoutFrom(home: string, cwd?: string): PiSessionsLayout {
  const sessionDir = providerDirectoryFromEnv('PI_CODING_AGENT_SESSION_DIR', '', home);
  if (sessionDir) return { root: sessionDir, flat: true, source: 'env' };

  // 项目层有 sessionDir（含空串）就是最终值，不必再读全局；只有项目层未提供时才看全局。
  const projectLayer: PiSettingsLayer = cwd
    ? piSettingsLayer(join(cwd, '.pi', 'settings.json'))
    : { kind: 'absent' };
  let chosen: { path: string; value: unknown } | null = null;
  if (projectLayer.kind === 'ok' && projectLayer.hasKey) {
    chosen = { path: projectLayer.path, value: projectLayer.value };
  } else {
    const globalLayer = piSettingsLayer(join(piAgentDirFrom(home), 'settings.json'));
    if (globalLayer.kind === 'ok' && globalLayer.hasKey) {
      chosen = { path: globalLayer.path, value: globalLayer.value };
    }
  }
  if (chosen) {
    const resolved = resolvePiSessionDirValue(chosen.value, chosen.path, home);
    if (resolved) return { root: resolved, flat: true, source: 'settings' };
  }

  const agentDir = piAgentDirFrom(home);
  // 默认根也可能被普通文件占住；显式变量已在 providerDirectoryFromEnv 检查过类型。
  assertDataDirectory(agentDir, 'Pi 配置目录');
  const sessions = join(agentDir, 'sessions');
  assertDataDirectory(sessions, 'Pi 会话目录');
  return { root: sessions, flat: false, source: 'default' };
}

export function piSessionsRootFrom(home: string): string {
  return piSessionsLayoutFrom(home).root;
}

export function piSessionsRoot(): string {
  return piSessionsLayoutFrom(homedir()).root;
}

export function piSessionsLayout(cwd?: string): PiSessionsLayout {
  return piSessionsLayoutFrom(homedir(), cwd);
}

/** 原生显式 sessionDir 直接存放文件；默认根与注入的 sessionsRoot 仍按项目分组。 */
export function piSessionDirectory(cwd: string, sessionsRoot?: string): string {
  if (sessionsRoot !== undefined) return join(sessionsRoot, encodePiProjectDir(cwd));
  const layout = piSessionsLayout(cwd);
  return layout.flat ? layout.root : join(layout.root, encodePiProjectDir(cwd));
}

/** 按 Pi 原生规则编码已解析的 cwd：移除首个分隔符，其余分隔符与冒号转为连字符。 */
export function encodePiProjectDir(cwd: string): string {
  const inner = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return `--${inner}--`;
}

function nid(): string {
  return randomBytes(4).toString('hex');
}

/**
 * 写后校验的期望（`verifyWrittenTurns` 的 `expectToolCall`）：与写入共用同一派生。
 * 带块级标记的包装值会被 parser 还原成来源原值；缺省 / null 写出的空对象与回读一致。
 */
export function expectPiToolCall(ev: ProcessEvent): { name: unknown; input: unknown } {
  const wrapped = toolInputAsRecord(ev.input, 'input');
  return { name: ev.name ?? 'tool', input: wrapped.wrapped ? ev.input : wrapped.record };
}

export async function importTurnsToPi(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  sessionsRoot?: string,
): Promise<SessionRef> {
  if (into && !opts?.replace) {
    const reason = assistantOnlyIncrementReason(turns);
    if (reason) throw new Error(reason);
  }
  if (!turns.some((t) => t.role === 'user' && userTurnTextForWrite(t).trim())) {
    throw new Error('没有可迁移的用户消息');
  }
  const dir = piSessionDirectory(cwd, sessionsRoot);
  await mkdir(dir, { recursive: true });

  let sessionId = into?.sessionId ?? randomUUID();
  let filePath = into?.filePath ?? join(dir, `${isoFileStamp()}_${sessionId}.jsonl`);
  let parentId: string | null = null;
  // 既有行按原文保留（异常行不丢、不重写），新行才 JSON.stringify。
  // 以前追加分支对每一行裸 JSON.parse 后再整体重写：`null` / `[]` / 半截行会直接抛
  // SyntaxError 让整次追加失败，合法行也被压缩格式。
  const pieces: string[] = [];
  let hasSessionHeader = false;

  if (into && !opts?.replace) {
    const existing = await readTextOrEmpty(into.filePath);
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue;
      pieces.push(line);
      const rec = parseJsonObject(line);
      if (!rec) continue;
      if (rec.type === 'session') hasSessionHeader = true;
      // 只认真正解析得出的对象 id：坏行不遮住它之前最后一条合法消息
      if (typeof rec.id === 'string') parentId = rec.id;
    }
    sessionId = into.sessionId;
    filePath = into.filePath;
  } else if (into && opts?.replace) {
    const existing = await readTextOrEmpty(into.filePath);
    // 不能用 `includes('"type":"session"')`：普通消息的文本 / 嵌套对象里出现同一子串会被误认成头
    const headerLine = existing.split('\n').find((l) => parseJsonObject(l)?.type === 'session');
    if (headerLine) {
      const h = parseJsonObject(headerLine)!;
      pieces.push(headerLine);
      hasSessionHeader = true;
      if (typeof h.id === 'string') parentId = h.id;
    }
    filePath = into.filePath;
    sessionId = into.sessionId;
  }

  if (!hasSessionHeader) {
    const ts = new Date().toISOString();
    pieces.push(JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: ts, cwd }));
    parentId = sessionId;
  }

  for (const turn of turns) {
    if (turn.role === 'user') {
      parentId = pushMessage(pieces, parentId, 'user', turn.timestamp, [{ type: 'text', text: userTurnTextForWrite(turn) }]);
      continue;
    }
    const content: unknown[] = [];
    // 只搬正文：纯附件助手轮用占位文本兜底，否则这一轮写出空内容、原始数据也一并消失
    const bodyText = assistantTurnTextForWrite(turn);
    const hasToolEvents = turn.events?.some((e) => e.kind === 'tool_call' || e.kind === 'tool_result') ?? false;
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'thinking') {
        content.push({ type: 'thinking', thinking: ev.detail ?? ev.summary });
      } else if (ev.kind === 'tool_call') {
        // pi-ai 的 `ToolCall.arguments` 是 JsonObject：字符串（exec 调用脚本、自由文本补丁）、
        // 数组等一律包成 `{ input: 原值 }`（Pi 自由文本工具的原生形状）并加块级标记，
        // 解析侧认标记才还原。上游四条 API 转换路径都只取固定字段，块上的额外键不会进模型请求。
        const wrapped = toolInputAsRecord(ev.input, 'input');
        content.push({
          type: 'toolCall',
          id: ev.callId ?? nid(),
          name: ev.name ?? 'tool',
          arguments: wrapped.record,
          ...(wrapped.wrapped ? { watchWrappedInput: true } : {}),
        });
      }
    }
    // 没有工具调用时，把 final text 直接放在 assistant 消息里；
    // 有工具调用时，为了避免 Pi TUI 把 final text 显示在 toolResult 消息之前，
    // 先只发 thinking/toolCall，再把 final text 作为一条独立 assistant 消息跟在 toolResult 后面。
    if (!hasToolEvents && bodyText.trim()) content.push({ type: 'text', text: bodyText });
    const assistantMsgId = pushMessage(pieces, parentId, 'assistant', turn.timestamp, content, undefined, turn.usage);
    parentId = assistantMsgId;
    let toolResultIndex = 0;
    for (const ev of turn.events ?? []) {
      if (ev.kind !== 'tool_result') continue;
      const baseMs = Date.parse(ev.timestamp || turn.timestamp) || Date.now();
      // 确保 tool_result message 时间严格晚于 assistant message，避免 Pi TUI 排序错乱
      const shifted = new Date(baseMs + 1000 + toolResultIndex * 100).toISOString();
      toolResultIndex += 1;
      parentId = pushMessage(pieces, parentId, 'toolResult', shifted, [
        { type: 'text', text: ev.detail ?? ev.summary },
      ], ev);
    }
    if (hasToolEvents && bodyText.trim()) {
      const finalTs = new Date((Date.parse(turn.timestamp) || Date.now()) + 2000 + toolResultIndex * 100).toISOString();
      parentId = pushMessage(pieces, parentId, 'assistant', finalTs, [{ type: 'text', text: bodyText }], undefined, turn.usage);
    }
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, pieces.join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parsePiSession({ provider: 'pi', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'pi',
        expect: expectAttachmentPlaceholders,
        expectToolCall: expectPiToolCall,
      }),
  });
  return { provider: 'pi', sessionId, filePath, cwd };
}

function pushMessage(
  out: string[],
  parentId: string | null,
  role: string,
  timestamp: string,
  content: unknown[],
  ev?: ProcessEvent,
  usage?: TokenUsage,
): string {
  const id = nid();
  const ts = timestamp || new Date().toISOString();
  const message: Record<string, unknown> = { role, content, timestamp: Date.parse(ts) || Date.now() };
  if (role === 'toolResult' && ev) {
    if (ev.callId) {
      message.toolCallId = ev.callId;
      message.toolName = ev.name ?? 'tool';
    }
    // 失败事实独立于调用身份；缺少 ID 的结果也必须保留明确的原生标记。
    if (ev.failed === true) message.isError = true;
  }
  if (role === 'assistant') {
    // pi TUI footer 要求 assistant 消息必须带 usage，否则渲染时 uncaughtException 退出；
    // 有源侧真实 usage 时写入，否则仍以 0 占位兜底
    message.usage = {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    };
    message.provider = 'pi';
  }
  out.push(
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: ts,
      message,
    }),
  );
  return id;
}

function isoFileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}
