import type { ImportTurnsOpts, ProviderAdapter } from '../providers/adapter.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './types.js';
import { describeStoreErrorReason } from './store.js';
import type { Chain, Store, SwitchRecord } from './store.js';
import { dedupeCallEvents, describeDanglingToolCalls, mergeTurns, shouldReplacePairedSession, unwrapUserQuery } from './rich.js';
import { describeWriteFailureReason, type FileDigest } from './atomic.js';
import { addFinding, type Finding } from './findings.js';
import { countUnparsableJsonLines } from './jsonl.js';
import { describePathReadFailureReason, describeReadFailureOrSelf, sessionFilePresence } from './read-text.js';
import { noSessionHint, unknownProviderMessage } from '../providers/registry.js';

/** 写回被阻断（如 TOCTOU 检测到目标被外部修改）：一票否决，不产生部分写 */
export class HandoffBlockedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HandoffBlockedError';
  }
}

function turnKey(t: UnifiedTurn): string {  const callIds = (t.events ?? [])
    .map((e) => e.callId)
    .filter((id): id is string => Boolean(id))
    .join(',');
  return `${t.role}\n${unwrapUserQuery(t.text).trim()}\n${callIds}`;
}

/** 写入被拒后给用户的下一步：不同 code 的原因完全不同，不能一句「确认停止写入后重试」包打天下 */
export function blockedHint(code: string): string {
  if (code === 'target_missing') return '目标会话文件已不存在，本次未写入任何内容；请重新选择目标会话。';
  if (code === 'target_unreadable') {
    return '目标会话文件读不出来（多为权限或路径问题），本次未写入任何内容；先确认文件状态再重试。';
  }
  if (code === 'target_changed') return '请确认目标会话已停止写入后重试；本次未写入任何内容。';
  if (code === 'cli_missing') return '未写入任何内容；新建该会话需要本机已安装并登录对应 CLI。';
  // 检测本身失败不是「没装」，别让人去重装
  if (code === 'cli_detect_failed') {
    return '未写入任何内容；无法确认目标 CLI 是否可用（检测本身失败），先修好 PATH、权限或客户端配置再重试。';
  }
  return '未写入任何内容；请确认目标会话停止写入后重试。';
}

/**
 * 写前 TOCTOU 校验：目标会话指纹与快照不一致（被外部写入）则拒绝。
 * `action` 只影响错误文案（“已中止本次<action>”）。open / switch 两条写入路径共用。
 */
export async function assertTargetUnchanged(
  adapter: ProviderAdapter,
  ref: SessionRef,
  snapshot: FileDigest | null,
  action = '切换',
): Promise<void> {
  if (!snapshot) return;
  const current = (await adapter.contentFingerprint?.(ref)) ?? null;
  if (current && current.sha256 === snapshot.sha256 && current.sizeBytes === snapshot.sizeBytes) return;
  // 指纹消失有两种完全不同的原因：文件被删 / 被移走，或只是读不出来（权限、I/O）。
  // 两种都同样中止写入（fail closed），但「正在被外部写入，请稍后重试」会让用户一直重试
  // 一个永远不会成功的操作——按实际状态分别说，并给出能落地的一步
  if (!current) {
    const presence = await sessionFilePresence(ref.filePath);
    if (presence.state === 'missing') {
      throw new HandoffBlockedError(
        'target_missing',
        `目标会话文件已不存在：${ref.filePath}；已中止本次${action}（未写入任何内容），请重新选择目标会话`,
      );
    }
    if (presence.state === 'unknown') {
      throw new HandoffBlockedError(
        'target_unreadable',
        `目标会话文件状态无法确认：${presence.reason}；为避免覆盖外部内容，已中止本次${action}（未写入任何内容），请先确认它是否还在再重试`,
      );
    }
    // 走到这里说明 stat 看到路径还在，指纹却是 null：指纹为 null 只可能来自「读不出来」，
    // 不是「内容变了」。以前这条落到 target_changed（「正在被外部写入，请稍后重试」），
    // 用户会对着一个 chmod 000 的文件（或同名目录占位）无限重试——那是修权限 / 恢复路径的事
    if (!presence.isFile) {
      throw new HandoffBlockedError(
        'target_unreadable',
        `目标会话路径现在不是普通文件（被同名目录或设备文件占住了）：${ref.filePath}；已中止本次${action}（未写入任何内容），先恢复该路径再重试`,
      );
    }
    throw new HandoffBlockedError(
      'target_unreadable',
      `目标会话文件读不出来（可能是权限或 I/O 问题）：${ref.filePath}；已中止本次${action}（未写入任何内容），先确认它可读再重试`,
    );
  }
  throw new HandoffBlockedError('target_changed', `目标会话正在被外部写入，已中止本次${action}，请稍后重试`);
}

/** 从 source 里去掉 dest 已有的前缀子序列，只留下待追加增量 */
export function diffTurns(source: UnifiedTurn[], dest: UnifiedTurn[]): UnifiedTurn[] {
  let di = 0;
  const out: UnifiedTurn[] = [];
  for (const t of source) {
    const key = turnKey(t);
    let found = -1;
    for (let i = di; i < dest.length; i++) {
      if (turnKey(dest[i]) === key) {
        found = i;
        break;
      }
    }
    if (found >= 0) di = found + 1;
    else out.push(t);
  }
  return out;
}

/** 把 provider 指定会话（缺省取 mtime 最新）接入链：链上该 provider 的绑定替换为该会话 */
export async function adoptIntoChain(
  providerId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  targetRef?: SessionRef,
  chainId?: string,
): Promise<{ adoptedRef: SessionRef; replacedRef: SessionRef | null; warnings: string[] }> {
  const warnings: string[] = [];
  const adapter = adapters.find((a) => a.id === providerId);
  if (!adapter?.findLatestSession) throw new Error(unknownProviderMessage(providerId, adapters));
  const found = targetRef
    ? { ref: targetRef }
    : await adapter.findLatestSession(cwd);
  if (!found) throw new Error(`${providerId} 未发现可接入的会话`);

  let history: SwitchRecord[] = [];
  if (!store) {
    // 库打不开时接入仍然完成，但没有链记录：下次 switch 不会认这条绑定，必须说明
    warnings.push('本地库不可用，本次接入未写入链记录（后续切换不会认同这条绑定）');
  }
  if (store) {
    try {
      const id = store.findActiveChain(cwd, chainId)?.id ?? null;
      if (chainId && !id) throw new Error(store.missingChainMessage(cwd, chainId));
      history = id ? store.listSwitchEvents(id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
      history = [];
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  }
  if (history.some((h) => h.toProvider === providerId && h.toRef?.sessionId === found.ref.sessionId)) {
    throw new Error('该会话已在链上，无需接入');
  }

  let replaced: SessionRef | null = pairedRef(history, providerId);
  const otherBound = (() => {
    let r: SessionRef | null = null;
    for (const h of history) {
      if (h.fromProvider !== providerId && h.fromRef) r = h.fromRef;
      if (h.toProvider !== providerId && h.toRef) r = h.toRef;
    }
    return r;
  })();

  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, chainId);
      if (!replaced && otherBound) replaced = otherBound;
      store.recordSwitch(id, providerId, replaced, providerId, found.ref);
    } catch (error) {
      console.error('[watch] 记录接入失败:', error);
      warnings.push(`链记录失败: ${describeStoreErrorReason(error)}`);
    }
  }
  return { adoptedRef: found.ref, replacedRef: replaced, warnings };
}

/**
 * 在链上新建另一侧 agent：从链尾内容交接出一个全新会话并绑定。
 * 约束：必须有链；目标不能是链尾 provider（直接 resume 即可）；每个 provider 在链上只能有一个会话。
 */
export async function createChainSession(
  providerId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  resolve: AdapterResolve,
  store?: Store | null,
  chainId?: string,
): Promise<HandoffResult> {
  if (!store) throw new Error('新建会话需要 store（无法记录链绑定）');
  let history: SwitchRecord[] = [];
  try {
    const id = store.findActiveChain(cwd, chainId)?.id ?? null;
    if (chainId && !id) throw new Error(store.missingChainMessage(cwd, chainId));
    history = id ? store.listSwitchEvents(id) : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/找不到链|已归档/.test(message)) throw error;
    // 读库失败不能退成空历史：下面会报「还没有切换链」，把用户引去建一条新链，真实原因丢失
    throw new Error(`读取链记录失败，无法确认当前链状态：${describeStoreErrorReason(error)}`);
  }
  if (!history.length) throw new Error('当前目录还没有切换链，请先执行一次 Switch 建链');
  const tail = history.at(-1)!;
  if (tail.toProvider === providerId) {
    throw new Error(`链尾已是 ${providerId}，直接 resume 即可；要开新对话请先切到另一侧`);
  }
  if (pairedRef(history, providerId)) {
    throw new Error(`${providerId} 已在链上（每个 provider 只能有一个会话）；如需更换请用「接入」或先切走`);
  }
  return handoff(providerId, cwd, adapters, resolve, store, { forceNew: true, chainId });
}

/** 链上该 provider 最近一次出现的原生会话（fromRef 或 toRef） */
export function pairedRef(history: SwitchRecord[], provider: string): SessionRef | null {
  let found: SessionRef | null = null;
  for (const h of history) {
    if (h.fromProvider === provider && h.fromRef) found = h.fromRef;
    if (h.toProvider === provider) found = h.toRef;
  }
  return found;
}

export async function chainUsage(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
): Promise<{
  chain: Chain | null;
  total: TokenUsage;
  /** 读取失败、因而没有计入 total 的会话数：total 只是「已知用量之和」，不是全链上限 */
  totalExcluded: number;
  /** 没有 usage 数据（原生无该字段 / 文件读不出，`sessionUsage` 返回 null）、同样没计入 total 的会话数：不说明会被当成「用量就是这么多」 */
  totalMissingUsage: number;
  byProvider: { provider: string; sessionId: string; usage: TokenUsage | null; error?: string }[];
  /** 链上有绑定、但适配器根本不给用量（未实现 `sessionUsage`，当前 pi / opencode）：不列出来会被当成「这一家没有用量」 */
  unsupported: string[];
  /** 用量读不出来的会话：null 可能是「原生没有 usage」，这里单独说明是真失败 */
  warnings: string[];
}> {
  const empty = { inputTokens: 0, outputTokens: 0 };
  if (!store) {
    // 无库时链与用量都无从判断，不能返回一份看起来「就是 0」的空报告
    return {
      chain: null,
      total: empty,
      totalExcluded: 0,
      totalMissingUsage: 0,
      byProvider: [],
      unsupported: [],
      warnings: ['本地库不可用，无法确定当前链与各家用量（可检查 WATCH_DB 路径与 Node 版本）'],
    };
  }
  const warnings: string[] = [];
  const chain = store.findActiveChain(cwd, chainId);
  if (chainId && !chain) throw new Error(store.missingChainMessage(cwd, chainId));
  // 归档链照样给用量（历史记录有用），但要说清它已不是当前链：
  // `--json` 里虽有 status，文本模式只印名字，容易被当成「现在还在用这条」
  if (chain?.status === 'archived') {
    warnings.push(`链 ${chain.name} 已归档（不再是本目录的当前链），下面的用量是历史记录`);
  }
  const history = chain ? store.listSwitchEvents(chain.id) : [];
  const byProvider: { provider: string; sessionId: string; usage: TokenUsage | null; error?: string }[] = [];
  let total = { ...empty };
  let totalExcluded = 0;
  let totalMissingUsage = 0;
  // 链上绑定了也没法统计的 provider（适配器未实现 sessionUsage，如 pi / opencode）：
  // 直接 continue 会让「按会话」里少一行，用户看成分家没有用量
  const unsupported: string[] = [];
  for (const adapter of adapters) {
    const ref = pairedRef(history, adapter.id);
    if (!ref) continue;
    if (!adapter.sessionUsage) {
      unsupported.push(adapter.id);
      continue;
    }
    let usage: TokenUsage | null = null;
    try {
      usage = await adapter.sessionUsage(ref);
    } catch (error) {
      // 读失败不能和「这家原生格式没有 usage」混为一谈（grok 本机无数据也是 null）；
      // 适配器可能直接把 fs errno 抛出来，按「读不出来」翻成中文再披露
      const msg = describeReadFailureOrSelf(error);
      warnings.push(`${adapter.id} 用量读取失败：${msg}`);
      byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg });
      totalExcluded += 1;
      continue;
    }
    // null 在适配器里同时表示「这家原生没有 usage 字段」与「文件读不出」（各家的读失败被吞成 null）：
    // 再 stat 一次分开，否则 `usage` 的合计会把「链尾文件已经没了」讲成「这些会话没有用量数据」
    if (usage === null) {
      const presence = await sessionFilePresence(ref.filePath);
      // 路径被同名目录 / 设备文件占住（present 但 isFile 为假）既不是「没有 usage 数据」，
      // 也不是可读文件：以前落进 totalMissingUsage，把「读不出内容」讲成「这家原生没有 usage」
      if (presence.state !== 'present' || !presence.isFile) {
        // 只有 ENOENT / ENOTDIR 才能说「不存在」：EACCES 等读不出来时照实说，
        // 否则权限问题会被讲成会话丢了，用户会去重新绑定而不是修权限
        const msg =
          presence.state === 'missing'
            ? `会话文件已不存在：${ref.filePath}`
            : presence.state === 'present'
              ? `该路径现在不是普通文件（被同名目录或设备文件占住了）：${ref.filePath}`
              : presence.reason;
        warnings.push(`${adapter.id} 用量读取失败：${msg}`);
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg });
        totalExcluded += 1;
        continue;
      }
    }
    byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage });
    if (usage === null) totalMissingUsage += 1;
    if (usage) {
      total = {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      };
    }
  }
  return { chain, total, totalExcluded, totalMissingUsage, byProvider, unsupported, warnings };
}

export type ProviderTip = {
  provider: string;
  ref: SessionRef;
  updatedAt: number;
  onChain?: boolean;
};

export type HandoffResult = {
  newRef: SessionRef;
  resumeCommand: string;
  fromProvider: string;
  turnCount: number;
  /** 链尾已经是目标 provider，没有发生真正的内容交接，调用方直接 resume 即可 */
  alreadyAtTarget?: boolean;
  /**
   * alreadyAtTarget 时链记录的实际状态：recorded = 链尾确实停在这家（watch new / 之前的切换写过记录）；
   * empty = 链上还没有任何绑定（chain new 之后没切过）；unknown = 本地库不可用或链历史读不出来。
   * 只有 recorded 才谈得上「链尾已在 X」，其余两档要说明没有可交接的来源、本次未写入链记录。
   */
  chainTipState?: 'recorded' | 'empty' | 'unknown';
  /** 全部 catch-继续路径的降级披露（recordSwitch/parse/rewrite 失败等） */
  warnings: string[];
  /** 内容处置披露（追加/去重/重写计数） */
  findings: Finding[];
};

export type AdapterResolve = (id: string) => ProviderAdapter | undefined;

export async function collectTips(
  cwd: string,
  adapters: ProviderAdapter[],
  warnings?: string[],
): Promise<ProviderTip[]> {
  const tips: ProviderTip[] = [];
  for (const adapter of adapters) {
    if (!adapter.findLatestSession) continue;
    let found;
    try {
      found = await adapter.findLatestSession(cwd);
    } catch (error) {
      // 单个 provider 的原生存储读不出来时跳过，不影响其它家，但要披露；原因按路径说（这里
      // 可能是目录 / 索引 / 库），不能把 `EACCES: permission denied, scandir '…'` 原文交给用户
      warnings?.push(`${adapter.id} 原生会话读取失败，已跳过：${describePathReadFailureReason(error)}`);
      continue;
    }
    if (found) tips.push({ provider: adapter.id, ref: found.ref, updatedAt: found.updatedAt });
  }
  return tips;
}

function pickChainTip(tips: ProviderTip[]): ProviderTip | null {
  if (!tips.length) return null;
  return tips.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}

/** 各 provider 最新会话（标记链上绑定）+ 链尾 + store 历史链 */
export async function chainStatus(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
): Promise<{
  tips: ProviderTip[];
  chainTip: ProviderTip | null;
  history: SwitchRecord[];
  chain: Chain | null;
  chains: Chain[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const allTips = await collectTips(cwd, adapters, warnings);
  let history: SwitchRecord[] = [];
  let chain: Chain | null = null;
  let chains: Chain[] = [];
  if (store) {
    try {
      chains = store.listChains(cwd);
      chain = store.findActiveChain(cwd, chainId);
      if (chainId && !chain) throw new Error(store.missingChainMessage(cwd, chainId));
      // 归档链照样能按名字 / id 查（findActiveChain 不看 status），但 status 文本模式只印链名：
      // 不说清就会被当成「现在还在用这条」，与 sessions --chain / usage 的同一句话对齐
      if (chain?.status === 'archived') {
        warnings.push(`链 ${chain.name} 已归档（不再是本目录的当前链），下面显示的是它的历史记录`);
      }
      history = chain ? store.listSwitchEvents(chain.id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链/.test(error.message)) throw error;
      history = [];
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  } else {
    warnings.push('本地库不可用，链信息与链尾无法显示（只列出原生会话；可检查 WATCH_DB 路径与 Node 版本）');
  }
  // 链尾只以当前链的 switch_events 最后一条为准；不再 fallback 到目录全局最新会话
  let chainTip: ProviderTip | null = null;
  if (history.length) {
    const last = history.at(-1)!;
    chainTip = { provider: last.toProvider, ref: last.toRef, updatedAt: last.createdAt, onChain: true };
    // 链尾指向的会话文件被删/被移走时，status 不能假装一切正常：下次 switch 会在这里失败
    // 只有 ENOENT / ENOTDIR 才能说「已不存在」；EACCES 等读不出来照实说「状态无法确认」，
    // 否则权限问题会被讲成会话丢了，把人引去白换一次绑定
    const tipPresence = await sessionFilePresence(last.toRef.filePath);
    if (tipPresence.state === 'missing') {
      warnings.push(
        `链尾会话文件已不存在：${last.toRef.filePath}（${last.toProvider} ${last.toRef.sessionId}，文件不存在）；下次切换会失败，可先 adopt 该 provider 的新会话`,
      );
    } else if (tipPresence.state === 'present' && !tipPresence.isFile) {
      // 路径还在、只是不是普通文件：说成「文件已不存在」自相矛盾，还会把人引去 adopt；
      // 与 chain list / doctor 的「该路径现在不是普通文件」保持同一说法
      warnings.push(
        `链尾会话文件的路径现在不是普通文件（被同名目录或设备文件占住了）：${last.toRef.filePath}（${last.toProvider} ${last.toRef.sessionId}）；下次切换会失败，先恢复该路径，再决定是否需要 adopt 该 provider 的新会话`,
      );
    } else if (tipPresence.state === 'unknown') {
      warnings.push(
        `链尾会话文件状态无法确认：${last.toProvider} ${last.toRef.sessionId}；${tipPresence.reason}；可能是权限或路径问题，先确认它是否还在，再决定是否需要 adopt`,
      );
    }
  }
  // tips 仍列出同目录全部会话，但用 onChain 标记是否属于当前链；链尾不再 fallback 到游离会话
  const boundIds = new Map<string, Set<string>>();
  for (const h of history) {
    if (h.fromProvider && h.fromRef) {
      boundIds.set(h.fromProvider, (boundIds.get(h.fromProvider) ?? new Set()).add(h.fromRef.sessionId));
    }
    if (h.toRef) {
      boundIds.set(h.toProvider, (boundIds.get(h.toProvider) ?? new Set()).add(h.toRef.sessionId));
    }
  }
  const tips = allTips.map((t) => ({ ...t, onChain: boundIds.get(t.provider)?.has(t.ref.sessionId) ?? false }));
  return { tips, chainTip, history, chain, chains, warnings };
}

/** 把链尾会话转换到 targetId，落 switch_events（store 可选）；opts.forceNew 强制新建目标会话（不追加既有配对） */
export async function handoff(
  targetId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  resolve: AdapterResolve,
  store?: Store | null,
  opts?: { forceNew?: boolean; chainId?: string },
): Promise<HandoffResult> {
  const target = resolve(targetId);
  if (!target) throw new Error(unknownProviderMessage(targetId, adapters));
  const warnings: string[] = [];
  if (!store) {
    // 内容仍会交接，但没有 switch_events：status / 桌面端看不到这次切换，必须说明
    warnings.push('本地库不可用，本次切换未写入链记录（status 与桌面端不会显示这次切换）');
  }
  const findings: Finding[] = [];

  // 先确认 --chain 指得到，再扫会话：目录里恰好没有原生会话时，
  // 后面的「未发现原生会话」会把 --chain 写错说成「这个目录没东西」。
  const chainRow = store && opts?.chainId ? store.findActiveChain(cwd, opts.chainId) : null;
  if (store && opts?.chainId && !chainRow) {
    throw new Error(store.missingChainMessage(cwd, opts.chainId));
  }
  // findActiveChain 按名字 / id 查时不看 status，归档链照样返回；真到写入才由
  // getOrCreateChainSession 报「链已归档」。这里提前拦住，否则空归档链会先撞下面的
  // 「未发现原生会话」，把「链已归档」讲成「目录里没东西」。
  if (chainRow?.status === 'archived') {
    throw new Error(
      `链已归档: ${chainRow.name}；可 watch chain use ${chainRow.name} 恢复，或省略 --chain 用当前链`,
    );
  }

  // 链记录先读：下面「未发现原生会话」要先看一眼链尾是不是指向了一个已被删掉的文件，
  // 否则用户刚切过链、只是链尾文件被删，却被告知「请先在 TUI 里开聊」
  let history: SwitchRecord[] = [];
  let historyFailed = false;
  if (store) {
    try {
      const id = store.findActiveChain(cwd, opts?.chainId)?.id ?? null;
      if (opts?.chainId && !id) throw new Error(store.missingChainMessage(cwd, opts.chainId));
      history = id ? store.listSwitchEvents(id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
      history = [];
      historyFailed = true;
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  }

  const tips = await collectTips(cwd, adapters, warnings);
  const mtimeTip = pickChainTip(tips);
  if (!mtimeTip) {
    const chainTipRef = history.at(-1)?.toRef ?? null;
    if (chainTipRef) {
      // 同样只把 ENOENT / ENOTDIR 当「文件已不存在」：读不出来时要说清是权限还是路径，
      // 不能让人以为会话丢了、急着重新 adopt
      const tipPresence = await sessionFilePresence(chainTipRef.filePath);
      if (tipPresence.state === 'missing') {
        throw new Error(
          `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${chainTipRef.sessionId} 文件已不存在（${chainTipRef.filePath}）：` +
            `可先 watch adopt ${chainTipRef.provider} --session <id> 重新绑定，或在原生 CLI 里新开一个会话`,
        );
      }
      if (tipPresence.state === 'unknown') {
        throw new Error(
          `未发现原生会话；链尾记录的 ${chainTipRef.provider} 会话 ${chainTipRef.sessionId} 状态无法确认：${chainTipRef.filePath}；${tipPresence.reason}` +
            `——可能是权限或路径问题，先确认它是否还在，再决定是否 watch adopt 重新绑定`,
        );
      }
      // 路径被同名目录 / 设备文件占住：两个分支都不进就会落到下面通用的
      // 「请先在…里开聊」，把「路径不可用」讲成「目录里没东西」
      if (tipPresence.state === 'present' && !tipPresence.isFile) {
        throw new Error(
          `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${chainTipRef.sessionId} 的路径现在不是普通文件（被同名目录或设备文件占住了）：${chainTipRef.filePath}` +
            `——先恢复该路径，再决定是否 watch adopt 重新绑定，或在原生 CLI 里新开一个会话`,
        );
      }
    }
    throw new Error(`未发现原生会话，${noSessionHint(adapters)}`);
  }

  let sourceTip: ProviderTip | null = null;
  let into: SessionRef | undefined;
  let destTurns: UnifiedTurn[] = [];
  let destDigest: FileDigest | null = null;

  // TOCTOU 守卫：dest 解析后若被外部修改（指纹不一致），拒绝写回，避免覆盖外部新内容
  const assertDestUnchanged = async (): Promise<void> => {
    if (!into) return;
    await assertTargetUnchanged(target, into, destDigest, '切换');
  };

  if (history.length > 0) {
    // 链绑定：只认 switch_events 里绑定的会话对，同目录其它会话不串线
    let boundOther: SessionRef | null = null;
    for (const h of history) {
      if (h.fromProvider !== targetId && h.fromRef) boundOther = h.fromRef;
      if (h.toProvider !== targetId && h.toRef) boundOther = h.toRef;
    }
    if (boundOther) {
      sourceTip = { provider: boundOther.provider, ref: boundOther, updatedAt: 0, onChain: true };
      const boundTarget = opts?.forceNew ? null : pairedRef(history, targetId);
      if (boundTarget) {
        try {
          destTurns = await target.parse(boundTarget);
          into = boundTarget;
          destDigest = (await target.contentFingerprint?.(boundTarget)) ?? null;
        } catch (error) {
          into = undefined;
          // 「解析失败」把 ENOENT（文件被删）和格式问题讲成同一件事：带上真实原因，
          // 否则用户以为只是格式不认识，不会想到文件已经没了；fs 错误要翻成中文
          warnings.push(
            `目标会话 ${boundTarget.sessionId} 无法沿用（${describeReadFailureOrSelf(error)}），改为新建会话承接内容`,
          );
        }
      }
    }
  }

  if (!sourceTip) {
    const other = tips.find((t) => t.provider !== targetId);
    sourceTip = mtimeTip.provider === targetId ? (other ?? null) : mtimeTip;
    if (!sourceTip) {
      // 这里能确定的只有「没有可交接的来源」。能不能说「链尾已在目标 provider」要看链记录：
      // 链刚建好还没绑过时链尾根本不存在，说成「已在 X」会让人以为链已经指向 X（status 里仍是空链）；
      // 链历史读不出来时更是无从判断，不能把读不出来讲成空链。
      const chainTipRef = history.at(-1)?.toRef ?? null;
      const chainTipState: NonNullable<HandoffResult['chainTipState']> = !store || historyFailed
        ? 'unknown'
        : chainTipRef
          ? chainTipRef.provider === targetId
            ? 'recorded'
            : 'unknown'
          : history.length === 0
            ? 'empty'
            : 'unknown';
      // 优先使用链上绑定的会话，避免同目录存在多个目标
      // provider 会话时打开到非链尾会话（用户看到的就会是“没有历史”）。
      const boundTarget = pairedRef(history, targetId);
      const resumeRef = boundTarget ?? mtimeTip.ref;
      return {
        newRef: resumeRef,
        resumeCommand: target.resumeCommand(resumeRef),
        fromProvider: targetId,
        turnCount: 0,
        alreadyAtTarget: true,
        chainTipState,
        warnings,
        findings,
      };
    }
    if (into === undefined && mtimeTip.provider === targetId) {
      try {
        destTurns = await target.parse(mtimeTip.ref);
        into = mtimeTip.ref;
        destDigest = (await target.contentFingerprint?.(mtimeTip.ref)) ?? null;
      } catch (error) {
        into = undefined;
        warnings.push(
          `目标会话 ${mtimeTip.ref.sessionId} 无法沿用（${describeReadFailureOrSelf(error)}），改为新建会话承接内容`,
        );
      }
    }
  }

  // 目标侧的坏行同样会让 diffTurns 把「已有但解析不出」的内容当缺失、重复追加一遍
  if (into) {
    const badDestLines = await countUnparsableJsonLines(into.filePath);
    if (badDestLines > 0) {
      warnings.push(
        `目标会话 ${into.sessionId}（${target.displayName}）有 ${badDestLines} 行无法解析（截断或损坏）：增量判定可能偏多，可能重复追加既有内容`,
      );
    }
  }

  const source = resolve(sourceTip.provider);
  if (!source) throw new Error(`链尾 provider 未注册: ${sourceTip.provider}`);

  let turns: UnifiedTurn[];
  try {
    turns = await source.parse(sourceTip.ref);
  } catch (error) {
    // 链尾指向的会话文件被删 / 截断时，裸 ENOENT 看不出下一步该做什么（doctor 的 brokenTips 报的正是这种）。
    // 但「读不出来」（EACCES 等）不是「被删」：直接建议 adopt 会让人白换一次绑定，下一次照样失败
    // 这三档（缺失 / 无权限 / 其余）已经把文件路径与下一步说全了，errno 只在「其余」里作为
    // 兜底细节；适配器自己抛的内容格式错误（无 code）仍要带出它写好的中文原因。
    // 以前无论哪种都先拼一遍 `error.message`，用户会看到 `EACCES: permission denied, open '…'`
    // 原文紧跟着同一件事的中文说明。
    const code = (error as NodeJS.ErrnoException).code;
    const gone = code === 'ENOENT' || code === 'ENOTDIR';
    const reason = gone
      ? `文件 ${sourceTip.ref.filePath} 已不存在，而链记录仍指向它：可用 watch adopt 重新绑定，或用 watch sessions 查看该目录还有哪些可接力的会话`
      : code === 'EACCES' || code === 'EPERM'
        ? `文件 ${sourceTip.ref.filePath} 无权读取（权限问题，不是被删除）：先修权限或换一个有权限的路径，再重试`
        : `文件 ${sourceTip.ref.filePath} 读不出来：如果只是格式坏掉可先确认文件内容；确认文件确实没了再 watch adopt 重新绑定`;
    const knownFsError = gone || code === 'EACCES' || code === 'EPERM';
    const detail = knownFsError ? '' : `${describeReadFailureOrSelf(error)}；`;
    throw new Error(
      `来源会话 ${sourceTip.ref.sessionId}（${source.displayName}）读取失败：${detail}${reason}`,
    );
  }
  // 各家 parse 对坏行一律跳过：跳过的内容既不在 turns 里，也不会被 round-trip 查出（两边都按解析结果比），
  // 不主动扫一遍就会把「少了几轮」当成完整交接
  const badSourceLines = await countUnparsableJsonLines(sourceTip.ref.filePath);
  if (badSourceLines > 0) {
    warnings.push(
      `来源会话 ${sourceTip.ref.sessionId}（${source.displayName}）有 ${badSourceLines} 行无法解析（截断或损坏），已跳过；交接内容可能不完整，可在原生 CLI 里打开确认`,
    );
  }
  // 同上，工具调用没有结果（Ctrl-C、用量耗尽、resume 重放过半截）在两处检查里都看不出来：
  // `diffTurns` 只比解析结果，round-trip 只比「写进去的内容」。`switch` 是 CLI 主路径，
  // 不披露就会把「那一轮做了一半」当成完整交接。
  const dangling = describeDanglingToolCalls(
    turns,
    `来源会话 ${sourceTip.ref.sessionId}（${source.displayName}）`,
  );
  if (dangling) warnings.push(dangling);
  // 目标级保护：传入即将写入的会话，Codex 据此检查 per-thread writer 锁（而非只看 Desktop 是否运行）
  await target.preflight?.({ ref: into, cwd });
  // 协作写锁：供应商支持时在写入期间独占原生锁，收窄与原生 writer 的竞态窗口
  const guardedWrite = async (turnsToWrite: UnifiedTurn[], opts?: ImportTurnsOpts): Promise<SessionRef> => {
    const guard = into ? await target.acquireWriteLock?.({ ref: into }) : undefined;
    try {
      // 取锁后再比对指纹：把与原生 writer 的竞态窗口收窄到「快照 → 取锁」之间
      await assertDestUnchanged();
      try {
        return await target.importTurns(turnsToWrite, cwd, into, opts);
      } catch (error) {
        // 写盘失败只有 Node 原文（`EACCES: permission denied, mkdir '…'`），cmdSwitch 会把它
        // 原样放进 `{ ok:false, error }`；换成中文原因，非文件系统错误（round-trip 校验）原样抛
        const reason = describeWriteFailureReason(error);
        throw reason ? new Error(reason) : error;
      }
    } finally {
      await guard?.release();
    }
  };

  const replace = Boolean(into && shouldReplacePairedSession(turns, destTurns));
  let outgoing = replace ? mergeTurns(turns, destTurns) : into ? diffTurns(turns, destTurns) : turns;
  if (!replace && into) {
    const seen = new Set(
      destTurns.flatMap((t) => (t.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id))),
    );
    // 只过滤掉“空文本且全部事件都是已存在的 tool 调用/结果”的回合，
    // 避免把含文本的 assistant turn（其 events 中同时包含 tool_call/tool_result）整轮误删。
    const beforeDedup = outgoing.length;
    outgoing = outgoing.filter((t) => {
      if (t.text.trim()) return true;
      const events = t.events ?? [];
      return events.length === 0 || !events.every((e) => e.callId && seen.has(e.callId));
    });
    const deduped = beforeDedup - outgoing.length;
    if (deduped > 0) addFinding(findings, 'handoff.dedup', 'skipped', deduped);
  }
  if (outgoing.length === 0 && !replace) {
    const resumeRef = into ?? mtimeTip.ref;
    // 目标 session 已包含全部最新内容，无需追加增量；但用户主动切回来时，
    // 仍应把链尾更新为目标 provider，否则桌面端状态会停留在旧 provider。
    // 此外，旧版本写出的 Kimi wire.jsonl 可能存在 stepUuid 不匹配等格式
    // 损坏，导致 Kimi 无法识别历史；对已有目标 session 强制 rewrite 可修复。
    if (into) {
      try {
        await guardedWrite(dedupeCallEvents(turns), { replace: true });
        addFinding(findings, 'handoff.rewrite_only', 'synthesized', 1);
      } catch (error) {
        if (error instanceof HandoffBlockedError) throw error;
        console.error('[watch] 重写目标 session 失败，仍尝试 resume:', error);
        const reason = describeWriteFailureReason(error) ?? (error instanceof Error ? error.message : String(error));
        warnings.push(`重写目标会话失败，目标内容可能未更新: ${reason}`);
      }
    }
    if (store && sourceTip) {
      try {
        const id = store.getOrCreateChainSession(cwd, opts?.chainId);
        store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, resumeRef);
      } catch (error) {
        console.error('[watch] 记录 switch_events 失败，交接仍完成:', error);
        warnings.push(`链记录失败: ${describeStoreErrorReason(error)}`);
      }
    }
    return {
      newRef: resumeRef,
      resumeCommand: target.resumeCommand(resumeRef),
      fromProvider: sourceTip?.provider ?? targetId,
      turnCount: 0,
      warnings,
      findings,
    };
  }

  const newRef = await guardedWrite(dedupeCallEvents(outgoing), replace ? { replace: true } : undefined);
  if (replace) addFinding(findings, 'handoff.rewrite', 'degraded', destTurns.length);
  else addFinding(findings, 'handoff.append', 'exact', outgoing.length);

  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, opts?.chainId);
      store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, newRef);
    } catch (error) {
      console.error('[watch] 记录 switch_events 失败，交接仍完成:', error);
      warnings.push(`链记录失败: ${describeStoreErrorReason(error)}`);
    }
  }

  return {
    newRef,
    resumeCommand: target.resumeCommand(newRef),
    fromProvider: sourceTip.provider,
    turnCount: outgoing.length,
    warnings,
    findings,
  };
}
