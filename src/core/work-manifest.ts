import path from 'node:path';
import { commandArgv, formatCommandArgv, isPatchArgv, isShellScriptArgv, shellScriptOf } from './command-argv.js';
import { codeFence, inlineCode, singleLineText } from './markdown.js';
import type { ProcessEvent, UnifiedTurn } from './types.js';

/**
 * 「改动概览」：从工具调用参数里汇总**这条会话改过哪些文件、跑过哪些命令**。
 *
 * 为什么需要它：`watch prompt` 的默认档位（minimal / standard）`eventsPerTurn = 0`，
 * 过程记录一条都不展开，正文只剩用户提问与助手最终答复。于是读者看到的是助手自己
 * 叙述的「已修复 handoff.ts，新增 new-guard.ts，测试通过」——**一句自我报告，无从核对**，
 * 也没有任何东西告诉他还有哪些文件被改过、实际跑了什么命令。
 * 同类工具（baton、deja-vu）都把这份清单当成交接的核心内容：摘要可以压缩，但
 * 「改了哪几个文件 / 跑了什么命令」是接手者最需要、又最短的一组事实。
 *
 * 设计约束：
 * - **只读、纯函数**：不读盘、不 spawn、不依赖时间；同一份 turns 永远同一份清单。
 * - **只认参数结构，不按文本猜**：文件路径必须来自明确的路径键（`file_path` / `path` /
 *   `target_file` / `notebook_path`）或 git 风格的补丁标记（`*** Update File: ` 这类
 *   固定前缀，Codex 用它表达改动）；命令必须来自明确的 `command` / `cmd` 键，
 *   或名字明显是执行器的工具。**不从 `summary` / `detail` 里抠路径**——那里是
 *   `Read a.ts` 这样的自由文本，抠出来会把「读过」当成「改过」。
 * - **不复制工具输出**：判断「改过什么」只读 `tool_call` 参数；`tool_result` 只读
 *   `failed` 标记与 `callId`（用来把失败的写入排除掉），**不读 `detail` / `summary`**
 *   ——输出可能很大，也可能含敏感内容。
 * - **成败都要披露**：认得出是写入类工具却拿不到路径时计数，让人知道清单可能不全。
 */

export type WorkManifestFile = {
  /** 相对会话 cwd 的路径（不在 cwd 下时保留原样） */
  path: string;
  /** 写入类调用次数（Write / create 这类整文件写） */
  writes: number;
  /** 编辑类调用次数（Edit / search_replace 这类局部修改） */
  edits: number;
};

export type WorkManifestCommand = {
  command: string;
  /** 同一命令出现过的次数 */
  count: number;
  /** 工具显式声明的工作目录与会话 cwd 不同时给出（codex 的 `workdir`） */
  workdir?: string;
};

/**
 * 一次明确失败的工具调用，按「工具 + 显式路径 + 显式命令」去重。
 *
 * 只来自 `tool_call` 的参数与 `tool_result.failed` 标记：**不读**结果正文、
 * 不从输出文字猜失败，也不把路径从 `summary` / `detail` 里抠出来。
 */
export type FailedAttempt = {
  /** 工具名（`tool_call` 的 `name`）；没有工具名的调用不进列表，另计入 unclassifiedFailures */
  tool: string;
  /** 工具参数里显式给出的路径（相对会话 cwd；cwd 之外保持绝对路径） */
  path?: string;
  /** 工具参数里显式给出的命令；不复制工具输出 */
  command?: string;
  /** 同一 tool + path + command 的失败调用次数 */
  count: number;
};

export type WorkManifest = {
  files: WorkManifestFile[];
  commands: WorkManifestCommand[];
  /** 因上限没列出的文件 / 命令条数 */
  omittedFiles: number;
  omittedCommands: number;
  /** 被略去的命令**调用次数**（比条数更能说明清单少了多少） */
  omittedCommandCalls: number;
  /** 认得出是写入类工具、但参数里读不出文件路径的调用次数（清单可能不全） */
  unreadableWrites: number;
  /** 明确失败的文件写入调用次数；不作为成功改动计入，仍可能已部分写入 */
  failedFileWrites: number;
  /**
   * 明确失败的工具调用（按 tool / path / command 去重）。与 `files` / `commands`
   * 分开：失败调用不是成功改动，失败写入也不会出现在 `files` 里。
   */
  failedAttempts: FailedAttempt[];
  /** 因上限没列出的失败记录条数 */
  omittedFailedAttempts: number;
  /** 被略去的失败记录对应的失败次数（多路径补丁按路径各记一条，可能大于调用数） */
  omittedFailedAttemptCalls: number;
  /** 有明确失败结果、但缺少工具名而无法归类的调用次数 */
  unclassifiedFailures: number;
  /** 可归属的明确失败调用总数（不含 unclassifiedFailures；多路径补丁只算一次） */
  failedAttemptCalls: number;
  /** 确有失败记录、但因上限被截断时为 true */
  failedAttemptsTruncated: boolean;
  /** 确有路径 / 命令被记录、但因上限被截断时为 true */
  truncated: boolean;
};

export type WorkManifestLimits = {
  files: number;
  commands: number;
  /** 失败记录上限；缺省用 DEFAULT_MANIFEST_LIMITS.failedAttempts */
  failedAttempts?: number;
};

export const DEFAULT_MANIFEST_LIMITS: Required<WorkManifestLimits> = { files: 40, commands: 30, failedAttempts: 30 };

/**
 * 明确的路径键。顺序即优先级：同一事件只取第一个命中的。
 *
 * **两种命名都要收**：Claude / Pi / Grok 用 snake_case（`file_path`），OpenCode / Cursor
 * 一系的工具入参是 camelCase（`filePath` / `notebookPath`）。只认一种的后果不是「少列几个
 * 文件」而是**静默误判**：OpenCode 的 `edit` 入参带 `filePath`，snake_case 匹配不上路径，
 * 但 `WRITER_NAME` 认得 `edit`，于是每条真实编辑都被记成「读不出路径的写入」，
 * 清单同时漏掉全部 OpenCode 文件改动并冒一条假降级披露。
 */
const FILE_KEYS = [
  'file_path', 'path', 'target_file', 'notebook_path', 'file', 'filename',
  'filePath', 'notebookPath', 'targetFile',
] as const;

/**
 * 表示「这是个写入 / 编辑」的值键。`content` 也可能是读取工具的入参（很少见），
 * 所以判定要与工具名结合，见 `classify`。
 */
const WRITE_VALUE_KEYS = [
  'content', 'new_string', 'new_source', 'old_string', 'new_str', 'old_str', 'edits', 'replacement', 'text',
  'newString', 'oldString', 'newSource', 'newStr', 'oldStr',
] as const;

const COMMAND_KEYS = ['command', 'cmd'] as const;

/**
 * 名字明显是写入类工具。**只用于「有路径但没有任何写入值键」的情况**：
 * 例如 `Edit` 的入参可能被裁剪到只剩 `file_path`，这时仍应算改过。
 * `todo_write` / `write_stdin` 这类不含路径键的调用根本进不到这一步，不会被误收。
 */
const WRITER_NAME = /(write|edit|create|replace|patch|apply|insert|modify|rename|move)/i;

/**
 * 已知的**文件写入类**工具名（小写精确匹配）。只在这个集合里才把「认不出路径」算成
 * 清单可能不全——泛化的名字正则会把 `todo_write`、`write_stdin`、`memory_remember`
 * 这类同族名字一起收进来，于是**健康会话也会冒出一条假披露**。
 * 新增 provider 时按它的真实工具名补进来，不要放宽成前缀 / 包含匹配。
 */
const KNOWN_FILE_WRITERS = new Set([
  // Claude Code
  'write', 'edit', 'multiedit', 'notebookedit',
  // Pi / Grok / OpenCode / Kimi
  'write_file', 'edit_file', 'search_replace', 'str_replace', 'create_file',
  // Codex
  'apply_patch',
]);

/** 名字是否属于「已知会写文件」的工具（只用于「读不出路径」这一档）。 */
function isKnownFileWriter(name: string): boolean {
  return KNOWN_FILE_WRITERS.has(name.toLowerCase());
}

/** 按来源与 ID 匹配尚未完成的调用；完成后复用 ID 不继承前一次的失败状态。 */
function collectFailedCalls(turns: UnifiedTurn[]): Set<ProcessEvent> {
  const failed = new Set<ProcessEvent>();
  const pending = new Map<string, { call?: ProcessEvent; remaining: number }>();
  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (!event.callId) continue;
      const key = JSON.stringify([event.provider, event.callId]);
      const current = pending.get(key);
      if (event.kind === 'tool_call') {
        // 多个未完成调用撞 ID 时无法唯一配对，全部结果到齐前不重新启用这个 ID。
        pending.set(key, current ? { remaining: current.remaining + 1 } : { call: event, remaining: 1 });
      } else if (event.kind === 'tool_result' && current) {
        if (current.call && event.failed === true) failed.add(current.call);
        current.remaining -= 1;
        if (current.remaining === 0) pending.delete(key);
      }
    }
  }
  return failed;
}

/** 名字明显是执行器：入参是字符串时按命令处理（Codex 的 `exec`） */
const EXEC_NAME = /^(exec|exec_command|bash|shell|sh|run|run_command|run_terminal_command|terminal|powershell|cmd)$/i;

/**
 * Codex 的补丁标记。Codex 把改动写成 git 风格的补丁（可能在 `apply_patch` 的入参里，
 * 也可能作为 heredoc 出现在 `exec_command` 的命令字符串里），这些前缀是固定格式，
 * 按行首匹配不会把普通文本里的同名字样当成补丁。
 */
const PATCH_MARKERS = ['*** Update File: ', '*** Add File: ', '*** Delete File: ', '*** Move to: '] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 工具入参可能是对象，也可能是 JSON 字符串（grok 的 `arguments`）。解不出来就当没有。 */
function inputRecord(event: ProcessEvent): Record<string, unknown> | null {
  const direct = asRecord(event.input);
  if (direct) return direct;
  if (typeof event.input === 'string') {
    try {
      return asRecord(JSON.parse(event.input));
    } catch {
      return null;
    }
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 把路径归一成「相对会话 cwd」的形式；cwd 之外保持绝对路径。 */
export function normalizeManifestPath(raw: string, cwd: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  // 相对路径也要折叠 `./` 与中间的 `..`：直接改文件的工具用绝对路径，补丁标记用相对路径，
  // 同一文件两种写法并存时（`./src/a.ts` 与 `/proj/src/a.ts`）不折叠就会被记成两条改动。
  if (!path.isAbsolute(trimmed)) {
    const normalized = path.normalize(trimmed);
    return normalized || trimmed;
  }
  if (!cwd || !path.isAbsolute(cwd)) return trimmed;
  const rel = path.relative(cwd, trimmed);
  // `path.relative` 在外面前缀不同（Windows 跨盘）时返回绝对路径，这种原样保留。
  // 只有真正的父目录段才表示 cwd 之外：文件名本身可以以 `..` 开头（如 `..foo`）。
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return trimmed;
  return rel;
}

/** 从命令字符串里按固定标记取出补丁涉及的文件路径（Codex 的补丁格式）。 */
export function extractPatchPaths(command: string): string[] {
  const found: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const trimmed = line.trim();
    for (const marker of PATCH_MARKERS) {
      if (trimmed.startsWith(marker)) {
        const target = trimmed.slice(marker.length).trim();
        if (target) found.push(target);
        break;
      }
    }
  }
  return found;
}

/** 单条工具调用的归类结果。`null` = 这条调用不是文件写入也不是命令（搜索 / TODO / 子代理…）。 */
type Classified =
  | { kind: 'file'; path: string; mode: 'write' | 'edit' }
  | { kind: 'patch'; paths: string[] }
  // `scanPatch: false` 表示命令由普通 argv 拼接而来：参数里的补丁标记只是数据，不提取路径。
  // `patchSource` 用于展示成完整 argv、但真正会执行的是另一个脚本的情况：只扫描脚本本身。
  | { kind: 'command'; command: string; workdir?: string; scanPatch?: false; patchSource?: string }
  | { kind: 'unreadable-write' }
  | null;

/**
 * 判定一条工具调用。
 *
 * 顺序很关键：**先看参数形状，再看工具名**。只按名字判定会把 `todo_write` 当成文件写入；
 * 只按形状判定则会把「路径 + text」这种只读入参算成写入。两者都要求，才兼得稳定与准确。
 */
function classify(event: ProcessEvent): Classified {
  if (event.kind !== 'tool_call') return null;
  const name = (event.name ?? '').trim();
  const obj = inputRecord(event);
  const rawInput = typeof event.input === 'string' ? event.input.trim() : '';

  // Codex 的 freeform apply_patch 直接传补丁字符串；它不是 shell 命令。
  if (!obj) {
    if (rawInput && name.toLowerCase() === 'apply_patch') {
      const paths = extractPatchPaths(rawInput);
      if (paths.length > 0) return { kind: 'patch', paths };
    }
    if (rawInput && EXEC_NAME.test(name)) return { kind: 'command', command: rawInput };
    // 入参整个缺失（旧记录、被裁剪的参数）时也要披露：工具名属于已知写入类，
    // 拿不到路径不等于「没写」；`rawInput` 为空不能成为静默跳过的理由。
    if (isKnownFileWriter(name)) return { kind: 'unreadable-write' };
    return null;
  }

  const filePath = firstString(obj, FILE_KEYS);
  const writeValue = firstString(obj, WRITE_VALUE_KEYS);
  // `old_string` 单独出现也说明这是在改文件（replace 类工具的最小入参）
  const hasOld =
    typeof obj.old_string === 'string' ||
    typeof obj.old_str === 'string' ||
    typeof obj.oldString === 'string' ||
    typeof obj.oldStr === 'string';

  // Anthropic 文本编辑器工具把动作放在 `command` 键里，而工具名本身含 `replace`。
  // 不先按子命令分流，`view`（只读）会落到下面按名字的兜底被记成编辑——健康会话里
  // 凭空多出一条「改过这个文件」，与「只读工具不算改动」的约束冲突。
  const editorCommand =
    name.toLowerCase() === 'str_replace_editor' && typeof obj.command === 'string'
      ? obj.command.trim().toLowerCase()
      : '';
  if (editorCommand === 'view') return null;
  if (editorCommand === 'create') {
    // create 的正文在 `file_text`（不在 WRITE_VALUE_KEYS 里），必须单独认成整文件写。
    return filePath ? { kind: 'file', path: filePath, mode: 'write' } : { kind: 'unreadable-write' };
  }

  if (filePath && (writeValue || hasOld)) {
    // 整文件写 vs 局部编辑：有 content / new_source 的算写，其余算编辑
    const isWrite = typeof obj.content === 'string' || typeof obj.new_source === 'string' || typeof obj.newSource === 'string';
    return { kind: 'file', path: filePath, mode: isWrite ? 'write' : 'edit' };
  }
  if (filePath && WRITER_NAME.test(name)) return { kind: 'file', path: filePath, mode: 'edit' };
  if (isKnownFileWriter(name) && !filePath && !COMMAND_KEYS.some((k) => typeof obj[k] === 'string')) {
    // 已知的写入类工具、参数里既没有路径也没有命令：清单可能漏了这条
    return { kind: 'unreadable-write' };
  }

  const command = firstString(obj, COMMAND_KEYS);
  if (command) {
    const workdir = typeof obj.workdir === 'string' && obj.workdir.trim() ? obj.workdir.trim() : undefined;
    return { kind: 'command', command, ...(workdir ? { workdir } : {}) };
  }
  // 旧版 Codex shell（rust-v0.20.0 的 create_shell_tool）把 command 记成 argv 数组；
  // 只认精确名 `shell`，MCP / 其他工具的同名参数不猜。字符串命令键优先（上面已返回）。
  if (name.toLowerCase() === 'shell') {
    const argv = commandArgv(obj.command);
    if (argv) {
      const workdir = typeof obj.workdir === 'string' && obj.workdir.trim() ? obj.workdir.trim() : undefined;
      // 官方 maybe_parse_apply_patch：argv 恰好 [apply_patch, 补丁正文] 时它是补丁，不是 shell 命令。
      if (isPatchArgv(argv)) {
        const paths = extractPatchPaths(argv[1]!);
        // 补丁正文读不出路径时与字符串形式同档：认得出是写入类工具，但清单可能不全。
        if (paths.length > 0) return { kind: 'patch', paths };
        return { kind: 'unreadable-write' };
      }
      // 只有 shell 脚本包装才是「命令里内嵌补丁」；普通 argv 里出现标记只是数据。
      // 带尾随参数时展示必须保留整个 argv，但真正执行的是脚本本身：补丁扫描只认脚本。
      const script = shellScriptOf(argv);
      return {
        kind: 'command',
        command: formatCommandArgv(argv),
        ...(workdir ? { workdir } : {}),
        ...(script === undefined
          ? { scanPatch: false }
          : isShellScriptArgv(argv)
            ? {}
            : { patchSource: script }),
      };
    }
  }
  return null;
}

/** `collectFailedAttempts()` 的结论；与 `WorkManifest` 中同名字段一致。 */
export type FailedAttemptCollection = Pick<
  WorkManifest,
  | 'failedAttempts'
  | 'omittedFailedAttempts'
  | 'omittedFailedAttemptCalls'
  | 'unclassifiedFailures'
  | 'failedAttemptCalls'
  | 'failedAttemptsTruncated'
>;

/**
 * 从已配对的失败调用里汇总「失败与中断」清单。
 *
 * 与 `collectWorkManifest()` 共用同一份 `collectFailedCalls()` 结论：只有
 * `tool_result.failed === true` 且能按来源 + callId 唯一配对的调用才算失败；
 * 未配对的结果、缺失失败标记的旧记录都不猜。只读 `tool_call` 的 `name` / `input`
 * 与结果上的失败标记，**不读** `summary` / `detail`。
 */
function collectFailedAttemptsFromCalls(
  failedCalls: Set<ProcessEvent>,
  turns: UnifiedTurn[],
  cwd: string,
  limit: number,
): FailedAttemptCollection {
  const entries: FailedAttempt[] = [];
  const index = new Map<string, FailedAttempt>();
  let unclassifiedFailures = 0;
  let failedAttemptCalls = 0;

  const add = (tool: string, rawPath: string | undefined, command: string | undefined): void => {
    const normalized = rawPath ? normalizeManifestPath(rawPath, cwd) : undefined;
    const key = JSON.stringify([tool, normalized ?? '', command ?? '']);
    const existing = index.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    const entry: FailedAttempt = {
      tool,
      ...(normalized ? { path: normalized } : {}),
      ...(command ? { command } : {}),
      count: 1,
    };
    index.set(key, entry);
    entries.push(entry);
  };

  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      if (!failedCalls.has(event)) continue;
      const tool = (event.name ?? '').trim();
      if (!tool) {
        // 没有工具名时既不能归到具体工具，也不能编一个名字；只如实计数。
        unclassifiedFailures += 1;
        continue;
      }
      failedAttemptCalls += 1;
      const classified = classify(event);
      if (classified?.kind === 'file') {
        add(tool, classified.path, undefined);
      } else if (classified?.kind === 'patch') {
        // 多文件补丁仍是一次调用；列表按显式路径各记一条便于核对，failedAttemptCalls 只算一次。
        const paths = new Set(classified.paths.map((p) => normalizeManifestPath(p, cwd)).filter(Boolean));
        if (paths.size === 0) add(tool, undefined, undefined);
        else for (const patchPath of paths) add(tool, patchPath, undefined);
      } else if (classified?.kind === 'command') {
        add(tool, undefined, classified.command);
      } else if (classified?.kind === 'unreadable-write') {
        add(tool, undefined, undefined);
      } else {
        // 只读工具等 classify 不归类的调用仍要出现在失败清单里；参数里的显式路径 / 命令
        // 能读到就带上（不猜、不从输出抠），读不到就只写工具名。
        const obj = inputRecord(event);
        const rawPath = obj ? firstString(obj, FILE_KEYS) : undefined;
        const command = obj ? firstString(obj, COMMAND_KEYS) : undefined;
        add(tool, rawPath, command);
      }
    }
  }

  // 与命令清单同一排序：失败次数多的先列，次数相同按首次出现，保证输出稳定。
  const sorted = entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => b.entry.count - a.entry.count || a.order - b.order)
    .map(({ entry }) => entry);
  const kept = sorted.slice(0, Math.max(0, limit));
  const omitted = sorted.slice(kept.length);
  return {
    failedAttempts: kept,
    omittedFailedAttempts: omitted.length,
    omittedFailedAttemptCalls: omitted.reduce((n, entry) => n + entry.count, 0),
    unclassifiedFailures,
    failedAttemptCalls,
    failedAttemptsTruncated: omitted.length > 0,
  };
}

/** 单独汇总失败调用（`collectWorkManifest()` 已包含同一份结论时不必再调）。 */
export function collectFailedAttempts(
  turns: UnifiedTurn[],
  cwd: string,
  limit: number = DEFAULT_MANIFEST_LIMITS.failedAttempts,
): FailedAttemptCollection {
  return collectFailedAttemptsFromCalls(collectFailedCalls(turns), turns, cwd, limit);
}

/**
 * 汇总整条会话的改动清单。
 *
 * **范围是整条会话，不是正文保留的那些轮**：`--last` / 档位会裁掉早期轮次，若清单也跟着裁，
 * 读者会以为这段工作只改了留下来的那几个文件。这一点由渲染侧写明。
 */
export function collectWorkManifest(
  turns: UnifiedTurn[],
  cwd: string,
  limits: WorkManifestLimits = DEFAULT_MANIFEST_LIMITS,
): WorkManifest {
  const files = new Map<string, WorkManifestFile>();
  const commands: WorkManifestCommand[] = [];
  const commandIndex = new Map<string, WorkManifestCommand>();
  let unreadableWrites = 0;
  let failedFileWrites = 0;

  const addFile = (rawPath: string, mode: 'write' | 'edit'): void => {
    const key = normalizeManifestPath(rawPath, cwd);
    if (!key) return;
    const existing = files.get(key);
    if (existing) {
      if (mode === 'write') existing.writes += 1;
      else existing.edits += 1;
      return;
    }
    files.set(key, { path: key, writes: mode === 'write' ? 1 : 0, edits: mode === 'edit' ? 1 : 0 });
  };

  const addCommand = (command: string, workdir?: string): void => {
    const key = `${workdir ?? ''}\u0000${command}`;
    const existing = commandIndex.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const entry: WorkManifestCommand = { command, count: 1, ...(workdir ? { workdir } : {}) };
      commandIndex.set(key, entry);
      commands.push(entry);
    }
  };

  const failedCalls = collectFailedCalls(turns);
  const failedAttempts = collectFailedAttemptsFromCalls(
    failedCalls,
    turns,
    cwd,
    limits.failedAttempts ?? DEFAULT_MANIFEST_LIMITS.failedAttempts,
  );

  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      const classified = classify(event);
      if (!classified) continue;
      const failed = failedCalls.has(event);
      if (classified.kind === 'unreadable-write') {
        if (failed) failedFileWrites += 1;
        else unreadableWrites += 1;
        continue;
      }
      if (classified.kind === 'file') {
        if (failed) failedFileWrites += 1;
        else addFile(classified.path, classified.mode);
        continue;
      }
      if (classified.kind === 'patch') {
        // 多文件补丁仍是一次调用；失败时按调用计数，不把路径数当失败次数。
        if (failed) failedFileWrites += 1;
        else for (const patchPath of classified.paths) addFile(patchPath, 'edit');
        continue;
      }
      // 失败的命令仍运行过；内嵌补丁的文件则不能据此认定成功改动。
      addCommand(classified.command, classified.workdir);
      if (classified.scanPatch === false) continue;
      // 展示用完整 argv 与可扫描脚本不同时，只扫描脚本：尾随参数里的标记只是数据。
      const patchPaths = extractPatchPaths(classified.patchSource ?? classified.command);
      if (failed && patchPaths.length > 0) failedFileWrites += 1;
      else for (const patchPath of patchPaths) addFile(patchPath, 'edit');
    }
  }

  const sortedFiles = [...files.values()].sort(
    (a, b) => b.writes + b.edits - (a.writes + a.edits) || a.path.localeCompare(b.path),
  );
  // 命令按**频次**排，不按首次出现排。真实会话里同一条 `npm test` / `npm run typecheck`
  // 会重复几十次，而长会话的早期命令多半是一次性探查（`ls`、`cat 某个文件`），
  // 对「接手后该跑什么来验证」几乎没有价值。本机只读实测（12 条真实 Claude 会话）：
  // 589 轮那条共 3000+ 条命令，按首现截断只留最早 30 条、漏掉 6568 条。
  // 频次相同时按首次出现顺序，保持输出稳定（同一输入永远同一输出）。
  const sortedCommands = commands
    .map((cmd, index) => ({ cmd, index }))
    .sort((a, b) => b.cmd.count - a.cmd.count || a.index - b.index)
    .map((entry) => entry.cmd);
  const keptFiles = sortedFiles.slice(0, Math.max(0, limits.files));
  const keptCommands = sortedCommands.slice(0, Math.max(0, limits.commands));
  const omittedFiles = sortedFiles.length - keptFiles.length;
  const omittedCommands = sortedCommands.length - keptCommands.length;
  // 被略去的**调用次数**比条数更能说明「这份清单少了多少」：漏 5 条各跑 1 次的命令
  // 与漏 200 条共跑 6000 次的命令，后果差得远。
  const omittedCommandCalls = sortedCommands
    .slice(keptCommands.length)
    .reduce((n, cmd) => n + cmd.count, 0);

  return {
    files: keptFiles,
    commands: keptCommands,
    omittedFiles,
    omittedCommands,
    omittedCommandCalls,
    unreadableWrites,
    failedFileWrites,
    ...failedAttempts,
    truncated: omittedFiles > 0 || omittedCommands > 0,
  };
}

/** 清单是否真的空：空清单不该在正文里占一节，也不该产生「本次省略」之类的噪声。 */
export function isEmptyWorkManifest(manifest: WorkManifest): boolean {
  return (
    manifest.files.length === 0 &&
    manifest.commands.length === 0 &&
    manifest.unreadableWrites === 0 &&
    manifest.failedFileWrites === 0 &&
    manifest.failedAttemptCalls === 0 &&
    manifest.unclassifiedFailures === 0
  );
}

/**
 * 单行化（换行 → 字面 `\n`）会改写原文；每折一行回调一次，供调用方计数披露。
 */
function singleLineCounter(onRewrite?: () => void): (text: string) => string {
  return (text) => {
    const folded = singleLineText(text);
    if (folded !== text) onRewrite?.();
    return folded;
  };
}

/**
 * 把清单渲染成 Markdown 行（不含尾部空行）。调用方负责做转义与计数。
 *
 * 措辞必须点明两件事：① 这是从工具参数汇总的，不是从工具输出；② 它覆盖整条会话，
 * 即使正文只保留了最近几轮。
 *
 * 路径与命令来自工具参数，定界符一律由 `markdown.ts` 按内容选择：固定长度的反引号
 * 会被内容里的反引号截断、``` 会提前闭合围栏、换行能伪造条目（回归见 r97）。
 *
 * `onRewrite`：单行化（换行 → 字面 `\n`）会改写原文，每折一行回调一次，供调用方计数披露；
 * 旧实现里清单折行从不计数（第 281 轮）。
 */
export function renderWorkManifest(manifest: WorkManifest, onRewrite?: () => void): string[] {
  const oneLine = singleLineCounter(onRewrite);
  const lines: string[] = [];
  lines.push('## 改动概览');
  lines.push('');
  lines.push(
    '> 这一节从工具调用参数汇总，**不受档位裁剪影响**，覆盖整条会话（即使正文只保留了部分轮次）；' +
      '只统计参数里写明文件路径的写入 / 编辑与明确的 shell 命令，工具输出不复制。',
  );
  lines.push('');
  // 上限为 0 时成功条目为空、但被省略的条数不为空：只按 `files.length` 决定是否输出，
  // 截断披露会整段消失，正文只剩「没有记录到改动」——把「有、但没列」讲成了「没有」。
  if (manifest.files.length || manifest.omittedFiles > 0) {
    lines.push('### 改动过的文件');
    lines.push('');
    for (const file of manifest.files) {
      const parts: string[] = [];
      if (file.writes) parts.push(`写入 ${file.writes} 次`);
      if (file.edits) parts.push(`编辑 ${file.edits} 次`);
      lines.push(`- ${inlineCode(oneLine(file.path))}（${parts.join('，')}）`);
    }
    if (manifest.omittedFiles > 0) {
      lines.push(`- 另有 ${manifest.omittedFiles} 个文件未列出（超出本节上限）`);
    }
    lines.push('');
  }
  if (manifest.commands.length || manifest.omittedCommands > 0) {
    lines.push('### 运行过的命令');
    lines.push('');
    for (const cmd of manifest.commands) {
      // workdir 来自工具参数，同样可能含反引号 / 换行。
      const suffix = [cmd.count > 1 ? `×${cmd.count}` : '', cmd.workdir ? `在 ${inlineCode(oneLine(cmd.workdir))} 下` : '']
        .filter(Boolean)
        .join('，');
      // 多行命令（heredoc / 链式脚本）放进行内代码会把 Markdown 结构撑破，
      // 改成围栏块；它本来也是「一段脚本」，不是一句命令。围栏长度必须超过内容里
      // 最长的反引号串，否则脚本里的 ``` 会提前闭合并把后面的内容漏成正文。
      if (cmd.command.includes('\n')) {
        const fence = codeFence(cmd.command);
        lines.push(`- 多行命令${suffix ? `（${suffix}）` : ''}：`);
        lines.push('');
        lines.push(`  ${fence}sh`);
        for (const line of cmd.command.split('\n')) lines.push(`  ${line}`);
        lines.push(`  ${fence}`);
      } else {
        // 空脚本（`bash -lc ''`）会执行一次空命令；`inlineCode('')` 没有合法的空跨度，
        // 这里用文字占位，避免清单里出现一个裸 `` 或空白条目。
        const label = cmd.command ? inlineCode(cmd.command) : '（空命令）';
        lines.push(`- ${label}${suffix ? `（${suffix}）` : ''}`);
      }
    }
    if (manifest.omittedCommands > 0) {
      lines.push(
        `- 另有 ${manifest.omittedCommands} 条命令未列出（共执行 ${manifest.omittedCommandCalls} 次，超出本节上限）`,
      );
    }
    lines.push('');
  }
  if (manifest.unreadableWrites > 0) {
    lines.push(
      `- 另有 ${manifest.unreadableWrites} 次写入类工具调用读不出文件路径，未计入上面的清单——这段改动可能不全。`,
    );
    lines.push('');
  }
  if (manifest.failedFileWrites > 0) {
    // 失败可能发生在部分写入之后；默认档位也没有过程记录可供跳转。
    lines.push(
      `- 另有 ${manifest.failedFileWrites} 次文件写入 / 编辑执行失败，未作为成功改动计入上面的清单；文件可能已部分改动，请核对实际内容。`,
    );
    lines.push('');
  }
  // 「没有记录」只适用于上面确实什么都没披露的情况：有截断、读不出路径或失败写入时，
  // 上面几行已经说明了发生过什么，再说一句「没有记录到」会把它们盖掉。
  if (
    !manifest.files.length &&
    !manifest.commands.length &&
    manifest.omittedFiles === 0 &&
    manifest.omittedCommands === 0 &&
    manifest.unreadableWrites === 0 &&
    manifest.failedFileWrites === 0
  ) {
    lines.push('这次会话没有记录到文件改动或命令（或来源工具的入参形状尚未被识别）。');
    lines.push('');
  }
  return lines;
}

/**
 * 渲染「失败与中断」小节（不含尾部空行）。只统计**明确标记失败**的调用，
 * 与成功改动分开：失败写入不进 `files`，这里的条目也不能被读成「改过这个文件」。
 */
export function renderFailedAttempts(manifest: WorkManifest, onRewrite?: () => void): string[] {
  const oneLine = singleLineCounter(onRewrite);
  if (manifest.failedAttemptCalls === 0 && manifest.unclassifiedFailures === 0) return [];
  const lines: string[] = [];
  lines.push('## 失败与中断');
  lines.push('');
  lines.push(
    '> 这一节只统计来源记录里**明确标记失败**的工具结果（按 callId 与工具调用配对），' +
      '不复制工具输出，也不从输出文字推断失败；没有结果的调用没有明确失败标记，不在本节统计。' +
      '它覆盖整条会话，不受档位裁剪影响；失败调用不计入成功改动清单。',
  );
  lines.push('');
  for (const attempt of manifest.failedAttempts) {
    const tool = inlineCode(oneLine(attempt.tool));
    const suffix = `（失败 ${attempt.count} 次）`;
    if (attempt.command?.includes('\n')) {
      // 多行命令与「运行过的命令」同一处理：行进代码会撑破结构，改用围栏块。
      const head = [tool, ...(attempt.path ? [inlineCode(oneLine(attempt.path))] : [])].join('：');
      lines.push(`- ${head} 多行命令${suffix}：`);
      lines.push('');
      const fence = codeFence(attempt.command);
      lines.push(`  ${fence}sh`);
      for (const line of attempt.command.split('\n')) lines.push(`  ${line}`);
      lines.push(`  ${fence}`);
      continue;
    }
    const detail = [attempt.path, attempt.command]
      .filter((value): value is string => Boolean(value))
      .map((value) => inlineCode(oneLine(value)))
      .join('，');
    lines.push(`- ${tool}${detail ? `：${detail}` : ''}${suffix}`);
  }
  if (manifest.omittedFailedAttempts > 0) {
    lines.push(
      `- 另有 ${manifest.omittedFailedAttempts} 条失败记录未列出（共 ${manifest.omittedFailedAttemptCalls} 次，超出本节上限）`,
    );
  }
  if (manifest.unclassifiedFailures > 0) {
    lines.push(
      `- 另有 ${manifest.unclassifiedFailures} 次失败调用缺少工具名，无法归类，未计入上面的清单。`,
    );
  }
  lines.push('');
  return lines;
}
