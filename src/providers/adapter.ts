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

  /** 可选：写入该 Provider 前的检查。传入目标会话时会做目标级判定（如 Codex 的 per-thread writer 锁）；
   *  不传 ctx 时保持保守语义。不通过则抛 PreflightBlockedError（结构化）或其他 Error。 */
  preflight?(ctx?: PreflightContext): Promise<void>;

  /** 可选（TUI 交接用）：找 cwd 下本 provider 最新的原生会话；没有返回 null */
  findLatestSession?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number } | null>;

  /** 可选（桌面壳用）：列 cwd 下本 provider 的原生会话，mtime 降序 */
  listSessions?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]>;

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
}
