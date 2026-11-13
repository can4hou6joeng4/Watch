import path from 'node:path';
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
 * - **不复制工具输出**：只用 `tool_call` 事件，`tool_result` 一律不看（输出可能很大，
 *   也可能含敏感内容）。
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

export type WorkManifest = {
  files: WorkManifestFile[];
  commands: WorkManifestCommand[];
  /** 因上限没列出的文件 / 命令条数 */
  omittedFiles: number;
  omittedCommands: number;
  /** 认得出是写入类工具、但参数里读不出文件路径的调用次数（清单可能不全） */
  unreadableWrites: number;
  /** 确有路径 / 命令被记录、但因上限被截断时为 true */
  truncated: boolean;
};

export type WorkManifestLimits = {
  files: number;
  commands: number;
};

export const DEFAULT_MANIFEST_LIMITS: WorkManifestLimits = { files: 40, commands: 30 };

/** 明确的路径键。顺序即优先级：同一事件只取第一个命中的。 */
const FILE_KEYS = ['file_path', 'path', 'target_file', 'notebook_path', 'file', 'filename'] as const;

/**
 * 表示「这是个写入 / 编辑」的值键。`content` 也可能是读取工具的入参（很少见），
 * 所以判定要与工具名结合，见 `classify`。
 */
const WRITE_VALUE_KEYS = ['content', 'new_string', 'new_source', 'old_string', 'new_str', 'old_str', 'edits', 'replacement', 'text'] as const;

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

/** 名字明显是执行器：入参是字符串时按命令处理（Codex 的 `exec`） */
const EXEC_NAME = /^(exec|exec_command|bash|shell|sh|run|run_command|run_terminal_command|terminal|powershell|cmd)$/i;

/**
 * Codex 的补丁标记。Codex 把改动写成 git 风格的补丁（可能在 `apply_patch` 的入参里，
 * 也可能作为 heredoc 出现在 `exec_command` 的命令字符串里），三种前缀是固定格式，
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
  if (!path.isAbsolute(trimmed)) return trimmed;
  if (!cwd || !path.isAbsolute(cwd)) return trimmed;
  const rel = path.relative(cwd, trimmed);
  // `path.relative` 在外面前缀不同（Windows 跨盘）时返回绝对路径，这种原样保留
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return trimmed;
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
  | { kind: 'command'; command: string; workdir?: string }
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

  // 纯字符串入参：只有名字明显是执行器时才算命令（Codex 的 exec 传的是脚本）
  if (!obj) {
    if (rawInput && EXEC_NAME.test(name)) return { kind: 'command', command: rawInput };
    if (rawInput && isKnownFileWriter(name)) return { kind: 'unreadable-write' };
    return null;
  }

  const filePath = firstString(obj, FILE_KEYS);
  const writeValue = firstString(obj, WRITE_VALUE_KEYS);
  // `old_string` 单独出现也说明这是在改文件（replace 类工具的最小入参）
  const hasOld = typeof obj.old_string === 'string' || typeof obj.old_str === 'string';

  if (filePath && (writeValue || hasOld)) {
    // 整文件写 vs 局部编辑：有 content / new_source 的算写，其余算编辑
    const isWrite = typeof obj.content === 'string' || typeof obj.new_source === 'string';
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
  return null;
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
    // 命令里内嵌的补丁同样算改动：Codex 常把 `apply_patch` 写进 heredoc
    for (const patchPath of extractPatchPaths(command)) addFile(patchPath, 'edit');
  };

  for (const turn of turns) {
    for (const event of turn.events ?? []) {
      const classified = classify(event);
      if (!classified) continue;
      if (classified.kind === 'unreadable-write') {
        unreadableWrites += 1;
        continue;
      }
      if (classified.kind === 'file') {
        addFile(classified.path, classified.mode);
        continue;
      }
      addCommand(classified.command, classified.workdir);
    }
  }

  const sortedFiles = [...files.values()].sort(
    (a, b) => b.writes + b.edits - (a.writes + a.edits) || a.path.localeCompare(b.path),
  );
  const keptFiles = sortedFiles.slice(0, Math.max(0, limits.files));
  const keptCommands = commands.slice(0, Math.max(0, limits.commands));
  const omittedFiles = sortedFiles.length - keptFiles.length;
  const omittedCommands = commands.length - keptCommands.length;

  return {
    files: keptFiles,
    commands: keptCommands,
    omittedFiles,
    omittedCommands,
    unreadableWrites,
    truncated: omittedFiles > 0 || omittedCommands > 0,
  };
}

/** 清单是否真的空：空清单不该在正文里占一节，也不该产生「本次省略」之类的噪声。 */
export function isEmptyWorkManifest(manifest: WorkManifest): boolean {
  return manifest.files.length === 0 && manifest.commands.length === 0 && manifest.unreadableWrites === 0;
}

/**
 * 把清单渲染成 Markdown 行（不含尾部空行）。调用方负责做转义与计数。
 *
 * 措辞必须点明两件事：① 这是从工具参数汇总的，不是从工具输出；② 它覆盖整条会话，
 * 即使正文只保留了最近几轮。
 */
export function renderWorkManifest(manifest: WorkManifest): string[] {
  const lines: string[] = [];
  lines.push('## 改动概览');
  lines.push('');
  lines.push(
    '> 这一节从工具调用参数汇总，**不受档位裁剪影响**，覆盖整条会话（即使正文只保留了部分轮次）；' +
      '只统计参数里写明文件路径的写入 / 编辑与明确的 shell 命令，工具输出不复制。',
  );
  lines.push('');
  if (manifest.files.length) {
    lines.push('### 改动过的文件');
    lines.push('');
    for (const file of manifest.files) {
      const parts: string[] = [];
      if (file.writes) parts.push(`写入 ${file.writes} 次`);
      if (file.edits) parts.push(`编辑 ${file.edits} 次`);
      lines.push(`- \`${file.path}\`（${parts.join('，')}）`);
    }
    if (manifest.omittedFiles > 0) {
      lines.push(`- 另有 ${manifest.omittedFiles} 个文件未列出（超出本节上限）`);
    }
    lines.push('');
  }
  if (manifest.commands.length) {
    lines.push('### 运行过的命令');
    lines.push('');
    for (const cmd of manifest.commands) {
      const suffix = [cmd.count > 1 ? `×${cmd.count}` : '', cmd.workdir ? `在 ${cmd.workdir} 下` : '']
        .filter(Boolean)
        .join('，');
      // 多行命令（heredoc / 链式脚本）放进行内代码会把 Markdown 结构撑破，
      // 改成围栏块；它本来也是「一段脚本」，不是一句命令。
      if (cmd.command.includes('\n')) {
        lines.push(`- 多行命令${suffix ? `（${suffix}）` : ''}：`);
        lines.push('');
        lines.push('  ```sh');
        for (const line of cmd.command.split('\n')) lines.push(`  ${line}`);
        lines.push('  ```');
      } else {
        lines.push(`- \`${cmd.command}\`${suffix ? `（${suffix}）` : ''}`);
      }
    }
    if (manifest.omittedCommands > 0) {
      lines.push(`- 另有 ${manifest.omittedCommands} 条命令未列出（超出本节上限）`);
    }
    lines.push('');
  }
  if (manifest.unreadableWrites > 0) {
    lines.push(
      `- 另有 ${manifest.unreadableWrites} 次写入类工具调用读不出文件路径，未计入上面的清单——这段改动可能不全。`,
    );
    lines.push('');
  }
  if (!manifest.files.length && !manifest.commands.length) {
    lines.push('这次会话没有记录到文件改动或命令（或来源工具的入参形状尚未被识别）。');
    lines.push('');
  }
  return lines;
}
