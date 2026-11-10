import type { FileDigest } from '../core/atomic.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../core/types.js';

export type ImportTurnsOpts = { replace?: boolean };

/** `preflight` 的目标上下文：告诉适配器即将写入哪个会话（无 ref = 新建/未知目标） */
export type PreflightContext = { ref?: SessionRef; cwd?: string };

/** `preflight` 拒绝写入时携带的结构化原因（CLI / 桌面据此给出可操作提示） */
export type PreflightBlock = {
  /** 机器可读原因，如 `codex_target_busy` / `codex_desktop_running` */
  code: string;
  message: string;
  /** 给用户的下一步操作建议；同时明确"未写入任何内容" */
  hint?: string;
  sessionId?: string;
  /** 占用目标会话的 writer 进程（探测到时） */
  holders?: { pid: number; command: string }[];
};

/**
 * 「新建会话需要原生 CLI，但这台机器上没有」的统一阻断。
 *
 * 同一个前置条件以前有四种说法：`open --to` / `--check` 走 `newSessionCliBlock()` 给结构化
 * `blocked` + `code=cli_missing` + `hint`，而 `new` / `switch` 拿到的是适配器里抛的裸
 * 「找不到 kimi 命令：…」——没有 `blocked`、不说「未写入任何内容」、也不给下一步。
 * 桌面端与脚本只看 `.blocked` / `.code`，这两条写路径的失败于是只能当内部错误处理。
 * 文案只写这一份：`newSessionCliBlock()` 与各适配器（当前是 kimi 的 `createRealKimiSession`）
 * 都从这里取，改口径只改一处。
 */
export function cliMissingBlock(providerId: string, displayName: string): PreflightBlock {
  return {
    code: 'cli_missing',
    message: `${displayName} 未检测到：新建 ${providerId} 会话需要本机已安装并登录 ${providerId} CLI`,
    // 「已安装并登录」不是用户能直接执行的动作：补一步可照做的确认（先跑一次看它能不能起来、要不要登录），
    // 否则用户装完就重试，仍然只看到同一句「未检测到」。
    hint: `未写入任何内容；新建 ${displayName} 会话需要本机已安装并登录 ${providerId} CLI：装好后先运行一次 ${providerId}，确认它能正常启动并完成登录，再重试同一条命令。`,
  };
}

/**
 * 「CLI 装了但检测不出来」的阻断（与 `cli_missing` 必须分开）。
 *
 * 检测失败 ≠ 没装：PATH 里没有命令是没装，而权限、`--version` 非零退出、超时、shebang
 * 解释器不存在都是「装着、但起不来」。两种情况都报 `cli_missing`，用户会去重装一个装着的
 * CLI。文案同样只写这一份：`open.ts` 的 `newSessionCliBlock()` 与适配器（当前是 kimi 的
 * `createRealKimiSession`）都从这里取。
 */
export function cliDetectFailedBlock(providerId: string, displayName: string, reason: string): PreflightBlock {
  return {
    code: 'cli_detect_failed',
    message: `${displayName} CLI 检测失败（不是「未安装」）：${reason}`,
    hint: `未写入任何内容；无法确认 ${providerId} CLI 是否可用（${reason}）。先修好检测问题（PATH、权限或客户端配置）再重试。`,
  };
}

/** 适配器拒绝写入（目标被占用等）。调用方应把它转成结构化输出，不要当作内部错误 */
export class PreflightBlockedError extends Error {
  readonly block: PreflightBlock;
  constructor(block: PreflightBlock) {
    super(block.message);
    this.name = 'PreflightBlockedError';
    this.block = block;
  }
}

/**
 * `findById` 的「没查成」与「没有这个会话」必须分开，而「没查成」里还有两种结论。
 *
 * 返回 `null` = 这家确实没有这个 id；抛错 = 查不了。可抛错的消息以前只被
 * `resolveById` 拼进「未找到会话: <id>。请确认 id 正确…」后面的括号里，于是两种完全
 * 不同的处境都被第一句讲成「id 写错了」：
 *
 *   - `found-unreadable`：按 id **命中了**会话文件 / 索引条目，只是读不出来（权限、内容
 *     缺失、路径被同名目录占住）。id 是对的，要修的是那个文件；用户照着第一句去核对
 *     一串没写错的 uuid，只会白折腾。
 *   - `incomplete`：目录 / 索引 / 库本身读不出来，压根没查全。这时既不能说「没有」，也
 *     不能说「有」——只能说「无法确认」。
 *
 * 两种都不能以「未找到会话」开头：`resolveById` 把结构化结论交给 `open` 的三条路径
 * （`open <id>` / `open <id> --from` / `open <id> --to`，含 `--check`）改写第一句。
 * 新增适配器抛 `findById` 失败时照这两种选一个，不要抛裸 `Error`——裸 Error 只能落回
 * 「未找到会话」的括号里。
 */
export type SessionLookupFailureKind = 'found-unreadable' | 'incomplete';

/** 见 `SessionLookupFailureKind`：消息原样保留（已是中文），额外带一个机器可读的 kind */
export class SessionLookupFailureError extends Error {
  readonly kind: SessionLookupFailureKind;
  constructor(kind: SessionLookupFailureKind, message: string) {
    super(message);
    this.name = 'SessionLookupFailureError';
    this.kind = kind;
  }
}

/**
 * Provider 适配器：每家 CLI 一个实现。
 * 新增 Provider = 新增 providers/<name>/ 目录 + registry 注册一行。
 */
export interface ProviderAdapter {
  readonly id: string; // 'claude' | 'codex' | ...
  readonly displayName: string;

  /** 本机 CLI 已安装且已登录？ */
  detect(): Promise<boolean>;

  /** 原生会话 → 统一时间线（Rich：user + assistant 最终回复 + thinking/tools） */
  parse(ref: SessionRef): Promise<UnifiedTurn[]>;

  /**
   * 统一时间线 → 原生会话。
   * `into` 有且文件在：把 turns 追加进该会话（不新建）；否则 create-if-absent。
   * `opts.replace`：按同一 sessionId 整文件重写（补过程事件，避免工具排在最终回复之后）。
   */
  importTurns(turns: UnifiedTurn[], cwd: string, into?: SessionRef, opts?: ImportTurnsOpts): Promise<SessionRef>;

  /** 可选：会话内容指纹（写回 TOCTOU 检测用）；不实现 = 跳过检测（如 opencode 共享 db） */
  contentFingerprint?(ref: SessionRef): Promise<FileDigest | null>;

  /** 从零开聊：CLI 起新会话发首条消息，返回新会话引用与 agent 最终回复。onEvent 接收过程事件（仅展示） */
  start(cwd: string, text: string, onEvent?: (e: ProcessEvent) => void): Promise<{ ref: SessionRef; turn: UnifiedTurn }>;

  /** 在当前会话中发送一条用户消息，返回 agent 最终回复。onEvent 接收过程事件（仅展示） */
  send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn>;

  /**
   * 可选：创建一个可直接被原生 CLI `resume` 的空会话（无 exec 发首条消息）。
   * 桌面端按 nezha 方式交互启动时，空链不再调用 start，而是走这里拿到 ref 后
   * 直接 `codex resume <id>` / `pi --session <id>` 进 PTY。
   */
  createEmptySession?(cwd: string): Promise<SessionRef>;

  /**
   * 可选：新建会话必须调用原生 CLI（无 CLI 只能追加既有会话，如 Kimi）。
   * `open --check` 据此在只读预检阶段判 CLI 是否可用，避免报告「可写」后实际必然失败。
   */
  requiresCliForNewSession?: boolean;

  /** 可选：写入该 Provider 前的检查。传入目标会话时会做目标级判定（如 Codex 的 per-thread writer 锁）；
   *  不传 ctx 时保持保守语义。不通过则抛 PreflightBlockedError（结构化）或其他 Error。 */
  preflight?(ctx?: PreflightContext): Promise<void>;

  /** 可选（TUI 交接用）：找 cwd 下本 provider 最新的原生会话；没有返回 null */
  findLatestSession?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number } | null>;

  /** 可选（桌面壳用）：列 cwd 下本 provider 的原生会话，mtime 降序。
   *  `preview` 缺省既表示「这条会话还没有可展示的内容」，也可能是「预览读不出来」——后者必须
   *  用 `previewError` 说明原因，否则用户看到的是一模一样的空列表行，而那条会话其实打不开。 */
  listSessions?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string; previewError?: string }[]>;

  /** 可选：`listSessions` 单次最多返回条数。声明后 `watch doctor` 会把「恰好等于上限」的计数
   *  标成下限（`capped`），否则会把截断后的列表当成精确总数展示。 */
  listSessionsCap?: number;

  /**
   * 可选：本家存储里「连一行都列不出来」的条目数。
   *
   * 与 `listSessions` 的 `previewError` 互补：那是「已经列出来了，只是内容读不出来」；这一档是
   * 「会话归属的那部分元数据就读不出来」，因此**连属于哪个 cwd 都不知道**，`listSessions` /
   * `findLatestSession` 只能跳过。跳过后 `sessions` / `recent` 少一条、`doctor` 的计数少一条，
   * 而所有通道都不说话——用户会以为那条会话从来没存在过，可它可能只是被截断、还能从备份恢复。
   * 目前只有 Codex 有这一档（rollout 的 cwd 写在 `session_meta` 首行里）。`watch sessions` /
   * `recent` / `status` / `doctor` 都会披露（文案统一在 `src/core/session-coverage.ts`）；
   * `summary` 说明归属写在哪一行（如「session_meta 首行」），用于不写死 provider 名的共用文案。
   * 不实现 = 本家没有这一档。
   */
  unattributable?(): Promise<{ count: number; samples: string[]; summary?: string }>;

  /**
   * 可选：为目标会话取协作写锁（如 Codex 的原生 per-thread writer 锁）。
   * 写入期间持有它可把「探测 → 写入」之间的竞态窗口收窄为原子取锁。
   * 返回 undefined = 机制不可用（无 helper/平台不支持），调用方退回只探测；
   * 抛 PreflightBlockedError = 已被其他 writer 抢占，调用方应拒绝写入。
   */
  acquireWriteLock?(ctx: { ref?: SessionRef }): Promise<{ release(): Promise<void>; holderPid?: number } | undefined>;

  /** 展示用：回到原生 CLI 继续的命令，如 `claude --resume <id>` */
  resumeCommand(ref: SessionRef): string;

  /** 可选（`watch open` 用）：按原生 session id 全局反查会话（不限 cwd）；找不到返回 null */
  findById?(sessionId: string): Promise<{ ref: SessionRef; updatedAt: number } | null>;

  /** 可选：扫描原生文件的 token 用量（不全量 parse 时间线） */
  sessionUsage?(ref: SessionRef): Promise<TokenUsage | null>;

  /**
   * 可选：`sessionUsage()` 实际读的那个文件；缺省是 `ref.filePath`。
   * grok 的用量在**旁路文件** `updates.jsonl`（不是 `parse` 读的 `chat_history.jsonl`），
   * 不声明它的话，调用方核对「这个文件里有没有无法解析的行」会看错对象。
   */
  sessionUsagePath?(ref: SessionRef): string;

  /**
   * 可选：这家原生记录里的逐轮时间戳**不是真实时间**时，用一句中文说清它是怎么来的。
   *
   * `watch prompt` 会在「时间范围」那一行把它当括注印出来。没有这一项的适配器表示
   * `UnifiedTurn.timestamp` 来自记录本身，调用方照旧只说明两端各取什么。
   */
  readonly timingNote?: string;
}
