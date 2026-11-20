import type { FileDigest } from '../core/atomic.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../core/types.js';

export type ImportTurnsOpts = { replace?: boolean };

/** `preflight` 的目标上下文：告诉适配器即将写入哪个会话（无 ref = 新建/未知目标） */
export type PreflightContext = { ref?: SessionRef; cwd?: string };

/**
 * Watch 已知的存储写入限制，包括布局只读（OpenCode 2.x）与配置读取故障。
 *
 * `preflight` 检查本次写入的具体目标与运行状态；这里只探测存储布局和配置条件，
 * 供 `watch doctor` 提前说明。没有这类限制不代表所有写入条件都已验证。
 * `code` / `reason` / `hint` 与 preflight 抛出的结构化 block 同源，同一件事不能有两套说法。
 */
export type WriteLimit = {
  /** 机器可读原因，如 `opencode_v2_readonly` */
  code: string;
  /** 真原因（哪个存储、什么布局、为什么写不了） */
  reason: string;
  /** 下一步：能照抄的动作 / 不该做的事 */
  hint?: string;
  /**
   * 这一档该怎么看（缺省 `readonly`）：
   *
   * - `readonly`：Watch 主动不支持这种布局（OpenCode 2.x）。它长期成立、用户无法「修好」，
   *   是已知且能读的状态——`watch doctor` 印出来，但不进 warnings，`--strict` 也不因此常红。
   * - `fault`：环境坏了（如 `~/.codex/config.toml` 读不出来）。它是可修的故障，会让每一次
   *   写入都失败，所以必须进 warnings，让 `--strict` 能捕获它。
   *
   * 不设这个字段会把两种性质完全不同的「写不了」合成一句，`--strict` 要么永远红、
   * 要么永远看不见真正的故障。
   */
  kind?: 'readonly' | 'fault';
};

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

  /** 可选：只读探测存储布局与配置的写入限制。不写任何文件、不探测运行中的进程；
   *  返回 null 表示未发现此类限制。doctor 按 kind 决定是否同时警告。 */
  writeLimit?(cwd?: string): Promise<WriteLimit | null>;

  /**
   * 可选：写入侧能还原哪些附件（`ProcessEvent.attachment` 的原始数据）。
   *
   * 缺省 = 一律降级为占位文本（`[图片：image/png，1234B]` 这类），原始数据不落盘。
   * `images` = 两侧的图片块都能还原，文件类附件仍是占位；`user-images` = 只有**用户轮**的
   * 图片能还原（Codex 的 `input_image` 只在 user content 里成立）；`all` = 图片与文件都能带。
   * 判据放在适配器上、由转入路径统一比对来源事件：`assertRoundTrip` 不查 text 事件里的
   * attachment，写坏 / 丢掉在 round-trip 里看不出来，只能靠这份声明主动披露。
   */
  attachmentSupport?: 'images' | 'user-images' | 'all';

  /**
   * 可选：写入侧能保留哪些无附件的 text 事件。缺省 = 不保留；`assistant` = 仅助手轮。
   * 这类中间说明 / 压缩摘要不参与 round-trip 校验，转入路径须按实际写入的轮次披露损失。
   * 附件由 attachmentSupport 单独判定，与轮次正文相同的文本不算损失；上下文披露另进 warnings。
   */
  textEventSupport?: 'assistant';

  /** 助手轮的 tool_result.failed 能按原生字段写回；缺省不保留，交接时按实际载荷披露。 */
  toolFailureSupport?: 'assistant';

  /** 可选：找 cwd 下本 provider 最新的原生会话；没有返回 null。
   * 扫描不完整但仍返回可读候选时，用 warnings 披露范围、计数与原因；调用方必须带出。 */
  findLatestSession?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; warnings?: string[] } | null>;

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
   * `locations` 是「读不出来的容器位置」（如 Kimi 的工作区分组）：里面可能还有未知数量的会话，
   * 不能按会话条数计，也不能把目录路径叫成「会话文件」。不实现 = 本家没有这一档。
   */
  unattributable?(): Promise<{
    count: number;
    samples: string[];
    summary?: string;
    cause?: string;
    advice?: string;
    /**
     * 这一档的原因分类：`damaged` 是归属元数据坏掉（可能要恢复），`compressed` 是只剩
     * 本版不读的完好压缩副本（让原生重新展开即可），`compressed-empty` 是只剩 0 字节压缩副本
     * （文件还在、内容已丢，只能备份恢复或重开会话）。消费方（`adopt` 零结果）据此给不同的
     * 下一步，**不能靠匹配 `advice` 文案**——文案改一个字就会把建议分错档。
     */
    kinds?: ('damaged' | 'compressed' | 'compressed-empty')[];
    locations?: { description: string; count: number; samples: string[] }[];
  }>;

  /**
   * 可选：为目标会话取协作写锁（如 Codex 的原生 per-thread writer 锁）。
   * 写入期间持有它可把「探测 → 写入」之间的竞态窗口收窄为原子取锁。
   * 返回 undefined = 本次不适用（新建会话没有目标，或宿主平台不在 `writeLockPlatforms` 内），调用方退回只探测；
   * `{ guard }` = 已独占持有，写入后必须 release；
   * `{ warning }` = 本平台本应有锁却没取到（锁路径准备失败、helper 不可用或无响应），
   *   调用方应继续写入但把降级事实写进 warnings；
   * 抛 PreflightBlockedError = 已被其他 writer 抢占，调用方应拒绝写入。
   */
  acquireWriteLock?(ctx: {
    ref?: SessionRef;
  }): Promise<{ guard?: { release(): Promise<void>; holderPid?: number }; warning?: string } | undefined>;

  /**
   * 可选：`acquireWriteLock` 实际生效的宿主平台（`process.platform` 取值）。缺省表示不限平台。
   * 能力矩阵用它区分「实现了接口」与「在本机生效」——只看方法是否存在会把一直空返回的平台也报成有锁。
   */
  writeLockPlatforms?: readonly string[];

  /** 可复制的原生恢复命令；会话 id 必须引用。windows 缺省按宿主平台，true 使用 PowerShell。 */
  resumeCommand(ref: SessionRef, windows?: boolean): string;

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
   * 可选：`parse()` 返回 0 轮时，给出「这不是合法空会话」的反证；null = 没有相反证据。
   *
   * 只用于 `watch usage` 的 0 轮归类，不得修改 parse 结果、不伪造轮次。
   * 目前只有 Codex 实现：只剩压缩记录的 rollout 说明压缩前存在过历史，
   * 不能与 `watch new codex` 建出的空会话混为一谈。
   */
  zeroTurnProblem?(ref: SessionRef): Promise<string | null>;

  /**
   * 可选：这家原生记录里的逐轮时间戳**不是真实时间**时，用一句中文说清它是怎么来的。
   *
   * `watch prompt` 会在「时间范围」那一行把它当括注印出来。没有这一项的适配器表示
   * `UnifiedTurn.timestamp` 来自记录本身，调用方照旧只说明两端各取什么。
   */
  readonly timingNote?: string;
}
