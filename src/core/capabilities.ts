import type { ProviderAdapter } from '../providers/adapter.js';
import { escapeControlChars } from './display.js';

/**
 * 一条「能力矩阵」行：某个适配器在代码层面实际实现了哪些读写能力。
 *
 * 为什么要有它：`docs/COMPATIBILITY.md` 记录的是**原生验收结论**（哪个平台、哪个版本、
 * 哪条路径真的走通过），而脚本、桌面端与 `watch doctor` 需要的是**可编程事实**——这家
 * 能不能读、能不能写、新建要不要本机 CLI、用量在不在旁路文件。以前这些判断散在
 * `open.ts`（`requiresCliForNewSession`）、`usage-integrity.ts`（`sessionUsagePath`）、
 * 桌面端 `handoff-ui.ts`（resume 命令）与若干 `if (adapter.xxx)` 里，各自硬编码。
 *
 * 边界必须说清：这里全部由适配器实现了哪些可选方法推导，**不是**「原生客户端已验收」。
 * 后者是带日期与版本限定的证据，只能引用 `docs/COMPATIBILITY.md` / `docs/evidence/*`，
 * 不能因为某个方法存在就宣布兼容。所以文本输出与 `notes` 都把这句话写在最前面。
 */
export type ProviderCapability = {
  id: string;
  displayName: string;
  /** 能读原生会话（`parse`）——接口必选；留给将来的只读 / 半实现适配器 */
  read: boolean;
  /** 能把统一时间线写成该家原生会话（`importTurns`） */
  write: boolean;
  /** 能不经模型调用直接建空会话（桌面 PTY 拉起用）；false = 只能走原生 CLI 或先调模型 */
  createEmptySession: boolean;
  /** 新建会话是否**必须**本机已安装并登录该 CLI（当前只有 Kimi） */
  requiresCliForNewSession: boolean;
  /** 写入前有目标级检查（Codex 的 per-thread writer 锁） */
  preflight: boolean;
  /** 写入侧能还原的附件：`none` = 一律只留占位文本（交接时据此披露原始数据丢失） */
  attachments: 'none' | 'images' | 'user-images' | 'all';
  /** 无附件的独立过程文本：`assistant` = 仅助手轮，`none` = 不保留；正文不受此项影响 */
  textEvents: 'none' | 'assistant';
  /** 工具结果的结构化失败标记；与结果正文是否保留独立 */
  toolFailures: 'none' | 'assistant';
  /** 能原子取协作写锁，收窄「探测 → 写入」的竞态窗口 */
  writeLock: boolean;
  /** 能扫 token 用量 */
  sessionUsage: boolean;
  /** 用量读的是旁路文件（grok 的 `updates.jsonl`）而不是 `parse` 读的那份 */
  sessionUsageSidecar: boolean;
  /** 有「连归属都读不出」的统计口径（Codex rollout 的首行 `session_meta`） */
  unattributable: boolean;
  /** `listSessions` 单次上限；缺省表示不截断 */
  listSessionsCap?: number;
};

/** 从适配器实例推导能力。纯函数：不 spawn CLI、不读盘，测试可直接喂假适配器 */
export function describeProviderCapability(a: ProviderAdapter): ProviderCapability {
  return {
    id: a.id,
    displayName: a.displayName,
    read: typeof a.parse === 'function',
    write: typeof a.importTurns === 'function',
    createEmptySession: typeof a.createEmptySession === 'function',
    requiresCliForNewSession: a.requiresCliForNewSession === true,
    preflight: typeof a.preflight === 'function',
    attachments: a.attachmentSupport ?? 'none',
    textEvents: a.textEventSupport ?? 'none',
    toolFailures: a.toolFailureSupport ?? 'none',
    writeLock: typeof a.acquireWriteLock === 'function',
    sessionUsage: typeof a.sessionUsage === 'function',
    sessionUsageSidecar: typeof a.sessionUsagePath === 'function',
    unattributable: typeof a.unattributable === 'function',
    ...(typeof a.listSessionsCap === 'number' ? { listSessionsCap: a.listSessionsCap } : {}),
  };
}

/** 全部已注册适配器的能力矩阵（顺序即注册表顺序） */
export function describeCapabilities(adapters: ProviderAdapter[]): ProviderCapability[] {
  return adapters.map(describeProviderCapability);
}

/**
 * 「能力 ≠ 验收」这句必须随每次输出走。
 *
 * 最容易被误读的一格是 `write: true`：它只说「有 `importTurns` 实现」，不保证这个平台的
 * 原生客户端会接受 Watch 写出的文件。README 与 COMPATIBILITY 已经把两者分开写，
 * 命令行单独一段 JSON 交出去时没有第二个显示层能拦，只能让这条 note 跟着数据一起走。
 */
export const CAPABILITY_VERIFICATION_NOTE =
  '能力取自适配器实现了哪些接口，只说明代码路径存在；某个平台 / 版本的原生客户端是否接受 Watch 写出的会话，仍以 docs/COMPATIBILITY.md 的验收记录为准';

function mark(value: boolean): string {
  return value ? '✓' : '-';
}

/**
 * 文本模式的矩阵。按「读 / 写」一行、「辅助能力」一行分段，避免在中文环境下做列对齐——
 * 中文字符宽度不一致，`padEnd()` 算出来的是字符数不是显示宽度，一排 `│` 会歪。
 */
export function formatCapabilities(rows: ProviderCapability[]): string {
  const lines: string[] = [];
  lines.push('Agent 能力矩阵（代码事实，不是原生验收结论）:');
  if (!rows.length) {
    lines.push('  （注册表里没有任何适配器）');
    return lines.join('\n');
  }
  for (const row of rows) {
    const id = escapeControlChars(row.id);
    const name = escapeControlChars(row.displayName);
    lines.push(`  ${id.padEnd(9)} ${name}`);
    lines.push(
      `            读 ${mark(row.read)} · 写 ${mark(row.write)} · 直接建空会话 ${mark(row.createEmptySession)}` +
        ` · 用量 ${mark(row.sessionUsage)}${row.sessionUsageSidecar ? '（旁路文件）' : '（会话主文件）'}`,
    );
    const aux = [
      `写入前置检查 ${mark(row.preflight)}`,
      `附件 ${row.attachments === 'all' ? '图片与文件' : row.attachments === 'images' ? '仅图片' : row.attachments === 'user-images' ? '仅用户侧图片' : '仅占位'}`,
      `过程文本 ${row.textEvents === 'assistant' ? '仅助手侧' : '不保留'}`,
      `工具失败标记 ${row.toolFailures === 'assistant' ? '仅助手侧' : '不保留'}`,
      `协作写锁 ${mark(row.writeLock)}`,
      `归属统计 ${mark(row.unattributable)}`,
      row.listSessionsCap === undefined ? '列表不截断' : `列表上限 ${row.listSessionsCap}`,
    ];
    if (row.requiresCliForNewSession) aux.push('新建必须本机 CLI');
    lines.push(`            ${aux.join(' · ')}`);
  }
  lines.push(`注意: ${CAPABILITY_VERIFICATION_NOTE}`);
  return lines.join('\n');
}
