import { stat } from 'node:fs/promises';
import type { FileDigest } from './core/atomic.js';
import { assertTargetUnchanged, diffTurns, HandoffBlockedError } from './core/handoff.js';
import { dedupeCallEvents } from './core/rich.js';
import { Store, defaultDbPath } from './core/store.js';
import { IS_WIN, stripDevicePrefix } from './core/platform.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './core/types.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { PreflightBlockedError } from './providers/adapter.js';
import { getAdapter, listAdapters, unknownProviderMessage } from './providers/registry.js';
import { countUnparsableJsonLines } from './core/jsonl.js';

/** `watch open` 的返回协议：桌面 GUI 通过 CLI `--json` 消费 */
export type SessionSummary = {
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  firstUserPrompt?: string;
  lastUserPrompt?: string;
  lastAssistantReply?: string;
  hasThinking: boolean;
  hasTools: boolean;
  hasAttachments: boolean;
  /** 会话里出现过的工具名，最多 5 个（展示上限） */
  toolNames: string[];
  /** 去重后的工具总数；大于 toolNames.length 时说明列表被截断 */
  toolCount: number;
};

export type OpenSessionResult = {
  ok: boolean;
  error?: string;
  provider?: string;
  cwd?: string;
  sessionId?: string;
  filePath?: string;
  cd?: string;
  resumeCommand?: string;
  command?: string;
  mergedTurns?: number;
  /** --from 来源会话的 token 用量（source 支持时才携带；用于跨侧对账展示） */
  sourceUsage?: TokenUsage | null;
  /** 当前反查会话的 token 用量 */
  usage?: TokenUsage | null;
  /** 会话切面遥测摘要（轮次、首尾片段、思考/工具调用标识） */
  summary?: SessionSummary | null;
  /** 结果说明（做了什么：已并入 N 轮 / 无需并入 / 返回链上会话…），文本模式打 stdout */
  notes?: string[];
  /**
   * 降级原因（读取失败、复用扫描失败、链上配对读不出…）：说明「为什么是这个结果」，
   * 不是结果本身。文本模式一律打到 stderr，避免和可复制的结果行混在 stdout。
   */
  warnings?: string[];
  /** 目标被占用等写入拒绝：结构化原因（未写入任何内容，可重试） */
  blocked?: {
    code: string;
    sessionId?: string;
    holders?: { pid: number; command: string }[];
    hint?: string;
  };
  /** 点击前预检（`--check`）：本次转入会落到哪种目标、是否可写 */
  writable?: boolean;
  plan?: { kind: 'resume' | 'chain' | 'reuse' | 'new'; turnCount: number };
};

/** 把写入拒绝异常转成结构化 blocked（其余错误返回 undefined） */
function blockedFrom(error: unknown): OpenSessionResult['blocked'] | undefined {
  if (error instanceof PreflightBlockedError) {
    const { code, sessionId, holders, hint } = error.block;
    return { code, sessionId, holders, hint };
  }
  if (error instanceof HandoffBlockedError) {
    return { code: error.code, hint: '请确认目标会话已停止写入后重试；本次未写入任何内容。' };
  }
  return undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 映射库可用则打开（默认 ~/.watch/watch.db）；打不开返回 null 降级纯扫描，不阻塞反查 */
function openMappingDb(): Store | null {
  try {
    return new Store(process.env.WATCH_DB ?? defaultDbPath());
  } catch {
    return null;
  }
}

/**
 * 按原生 session id 全局反查；providerId 指定时只在对应 provider 里查。
 * store 提供时：先查本地映射表快返（记住的 cwd/filePath 且文件仍在），
 * miss 才全盘扫描各 provider 原生库，命中即写回映射，下次免扫。
 */
export async function resolveById(
  sessionId: string,
  providerId?: string,
  store?: Store | null,
  adapters: ProviderAdapter[] = listAdapters(),
  diagnostics?: string[],
): Promise<{ adapter: ProviderAdapter; found: { ref: SessionRef; updatedAt: number } } | null> {
  const candidates = providerId
    ? ([getAdapter(providerId)].filter((a): a is ProviderAdapter => Boolean(a)) ?? [])
    : adapters.filter((a) => typeof a.findById === 'function');
  if (providerId && !candidates.length) return null;

  if (store) {
    for (const a of candidates) {
      try {
        const loc = store.getSessionLocation(a.id, sessionId);
        // Windows canonicalize 会给路径加 `\\?\` 前缀，探测其去前缀形式
        const filePath = loc && IS_WIN ? stripDevicePrefix(loc.filePath) : loc?.filePath;
        if (loc && filePath && (await fileExists(filePath))) {
          try {
            store.rememberSessionLocation(a.id, loc, Date.now());
          } catch {
            /* 映射刷新失败不影响反查 */
          }
          return {
            adapter: a,
            found: {
              ref: { provider: a.id, sessionId, filePath: loc.filePath, cwd: loc.cwd },
              updatedAt: loc.lastSeenAt,
            },
          };
        }
      } catch {
        /* 映射读失败继续全扫 */
      }
    }
  }

  for (const a of candidates) {
    if (!a.findById) continue;
    try {
      const found = await a.findById(sessionId);
      if (found) {
        if (store) {
          try {
            store.rememberSessionLocation(a.id, found.ref);
          } catch {
            /* 写失败不影响反查 */
          }
        }
        return { adapter: a, found };
      }
    } catch (error) {
      // 一家存储读失败不该拖垮反查，但必须披露：否则「没找到」和「没查成」分不清
      diagnostics?.push(`${a.id} 反查失败：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
  return null;
}

/** POSIX 单引号包裹（含单引号转义），供拼接可复制的 cd / command */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号包裹（单引号双写转义），Windows 下拼接可复制的 cd */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

/** 拼接可复制的 cd：isWin=true 用 PowerShell，其它用 POSIX。纯函数供单测两平台 */
export function buildCdFor(cwd: string, isWin: boolean): string {
  return isWin ? `Set-Location -LiteralPath ${psQuote(cwd)}` : `cd ${shellQuote(cwd)}`;
}

/** 拼接可复制的完整命令（cd → resume）。Windows：`;` 分隔；POSIX：`&&` */
export function buildCommandFor(cd: string, resumeCommand: string, isWin: boolean): string {
  return isWin ? `${cd}; ${resumeCommand}` : `${cd} && ${resumeCommand}`;
}

const buildCd = (cwd: string): string => buildCdFor(cwd, IS_WIN);
const buildCommand = (cd: string, resumeCommand: string): string => buildCommandFor(cd, resumeCommand, IS_WIN);

/**
 * 反查 session id 出 cwd 与打开命令；opts.from 指定来源会话时，先把来源增量并入目标会话再输出。
 * 不抛异常，失败以 { ok:false, error } 返回。
 */
export async function openSession(
  targetId: string,
  opts?: { from?: string; provider?: string },
  store?: Store | null,
  adapters: ProviderAdapter[] = listAdapters(),
): Promise<OpenSessionResult> {
  const { from, provider } = opts ?? {};
  // --provider 拼错（如 Claude / codx）时 resolveById 会一家都不查就返回 null，
  // 报「未找到会话」会让人以为会话没了；先在注册表里确认这家存在。
  if (provider && !adapters.some((a) => a.id === provider)) {
    return {
      ok: false,
      error: unknownProviderMessage(provider, adapters),
    };
  }
  const mapping = store ?? openMappingDb();
  const lookup: string[] = [];
  const target = await resolveById(targetId, provider, mapping, adapters, lookup);
  if (!target) {
    const detail = lookup.length ? `（${lookup.join('；')}）` : '';
    return {
      ok: false,
      error: `未找到会话: ${targetId}${provider ? `（provider=${provider}）` : ''}。请确认 id 正确且对应 CLI 已安装登录。${detail}`,
    };
  }
  const notes: string[] = [];
  const warnings: string[] = [];
  let merged = 0;
  let sourceUsage: TokenUsage | null = null;

  if (from) {
    const source = await resolveById(from, undefined, mapping, adapters, lookup);
    if (!source) {
      const detail = lookup.length ? `（${lookup.join('；')}）` : '';
      return { ok: false, error: `未找到来源会话: ${from}${detail}` };
    }
    try {
      // 来源 usage 聚合携带：source 支持 sessionUsage 时读出，跨侧对账展示（写回各 build 仍为零占位）
      if (typeof source.adapter.sessionUsage === 'function') {
        sourceUsage =
          (await source.adapter.sessionUsage(source.found.ref).catch((error: unknown) => {
            // 与目标侧一致：读失败不能和「原生没有 usage」一样静默成 null
            warnings.push(
              `来源 ${source.adapter.displayName} 用量读取失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })) ?? null;
        if (sourceUsage) {
          notes.push(
            `来源 ${source.adapter.displayName} 用量 in=${sourceUsage.inputTokens} out=${sourceUsage.outputTokens}（已在对账中携带）`,
          );
        }
      }
      const srcTurns = await source.adapter.parse(source.found.ref);
      const badSrcLines = await countUnparsableJsonLines(source.found.ref.filePath);
      if (badSrcLines > 0) {
        warnings.push(
          `来源会话 ${source.found.ref.sessionId} 有 ${badSrcLines} 行无法解析（截断或损坏），已跳过；并入内容可能不完整`,
        );
      }
      const dstTurns = await target.adapter.parse(target.found.ref);
      const badDstLines = await countUnparsableJsonLines(target.found.ref.filePath);
      if (badDstLines > 0) {
        warnings.push(
          `目标会话 ${target.found.ref.sessionId} 有 ${badDstLines} 行无法解析（截断或损坏）：增量判定可能偏多，可能重复追加既有内容`,
        );
      }
      // 写前快照：与 handoff 一致，写入前再比一次（目标被外部写入则中止）
      const dstDigest = (await target.adapter.contentFingerprint?.(target.found.ref)) ?? null;
      const outgoing = diffTurns(srcTurns, dstTurns);
      if (outgoing.length === 0) {
        notes.push(`${from} 的内容已全部包含在 ${targetId} 中，无需并入`);
      } else {
        const dedup = dedupeCallEvents(outgoing);
        await target.adapter.preflight?.({ ref: target.found.ref, cwd: target.found.ref.cwd });
        const guard = await target.adapter.acquireWriteLock?.({ ref: target.found.ref });
        try {
          await assertTargetUnchanged(target.adapter, target.found.ref, dstDigest, '并入');
          const newRef = await target.adapter.importTurns(dedup, target.found.ref.cwd, target.found.ref);
          merged = dedup.length;
          notes.push(`已把 ${from} 的 ${merged} 轮新内容并入 ${target.adapter.displayName} 会话 ${newRef.sessionId}`);
          target.found = { ref: newRef, updatedAt: 0 };
        } finally {
          await guard?.release();
        }
      }
    } catch (error) {
      const blocked = blockedFrom(error);
      const raw = error instanceof Error ? error.message : String(error);
      return blocked ? { ok: false, error: raw, blocked } : { ok: false, error: `并入新内容失败: ${raw}` };
    }
  }
  let usage: TokenUsage | null = null;
  let summary: SessionSummary | null = null;
  if (!from) {
    if (typeof target.adapter.sessionUsage === 'function') {
      usage =
        (await target.adapter.sessionUsage(target.found.ref).catch((error: unknown) => {
          // 「原生没有 usage」与「读取失败」都是 null，后者必须说明
          warnings.push(
            `${target.adapter.displayName} 用量读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        })) ?? null;
    }
    try {
      const turns = await target.adapter.parse(target.found.ref);
      const userTurns = turns.filter((t) => t.role === 'user' && t.text.trim());
      const assistantTurns = turns.filter(
        (t) => t.role === 'assistant' && (t.text.trim() || (t.events?.length ?? 0) > 0),
      );
      const hasThinking = turns.some((t) => t.events?.some((e) => e.kind === 'thinking'));
      const toolEvents = turns.flatMap((t) => (t.events ?? []).filter((e) => e.kind === 'tool_call'));
      const hasAttachments = turns.some((t) => t.events?.some((e) => Boolean(e.attachment)));
      const allToolNames = Array.from(
        new Set(toolEvents.map((e) => (e.summary || '').split(' ')[0]).filter(Boolean)),
      );
      summary = {
        turnCount: turns.length,
        userTurnCount: userTurns.length,
        assistantTurnCount: assistantTurns.length,
        firstUserPrompt: userTurns.at(0)?.text.slice(0, 160),
        lastUserPrompt: userTurns.at(-1)?.text.slice(0, 160),
        lastAssistantReply: assistantTurns.at(-1)?.text.slice(0, 240),
        hasThinking,
        hasTools: toolEvents.length > 0,
        hasAttachments,
        // 只展示前 5 个，同时带上总数，桌面端才能说「等 N 种」而不是把截断当成全部
        toolNames: allToolNames.slice(0, 5),
        toolCount: allToolNames.length,
      };
    } catch (error) {
      // 摘要只是附加信息，解析失败不阻断打开，但不能让用户以为这个会话没有内容
      warnings.push(
        `会话摘要解析失败，未展示轮次与工具信息：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const cd = buildCd(target.found.ref.cwd);
  const resumeCommand = target.adapter.resumeCommand(target.found.ref);
  return {
    ok: true,
    provider: target.adapter.id,
    cwd: target.found.ref.cwd,
    sessionId: target.found.ref.sessionId,
    filePath: target.found.ref.filePath,
    cd,
    resumeCommand,
    command: buildCommand(cd, resumeCommand),
    mergedTurns: merged,
    sourceUsage,
    usage,
    summary,
    notes,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 在 cwd 的链记录里找来源会话所属链的另一侧配对会话（取 createdAt 最新）；不在链上返回 null */
function findChainPaired(
  store: Store,
  sourceProvider: string,
  sourceSessionId: string,
  targetProvider: string,
  cwd: string,
): SessionRef | null {
  let pair: SessionRef | null = null;
  let at = -1;
  for (const c of store.listChains(cwd)) {
    for (const h of store.listSwitchEvents(c.id)) {
      const isSource =
        (h.fromProvider === sourceProvider && h.fromRef?.sessionId === sourceSessionId) ||
        (h.toProvider === sourceProvider && h.toRef?.sessionId === sourceSessionId);
      if (!isSource) continue;
      const cand =
        h.fromProvider === targetProvider ? h.fromRef : h.toProvider === targetProvider ? h.toRef : null;
      if (cand && h.createdAt > at) {
        pair = cand;
        at = h.createdAt;
      }
    }
  }
  return pair;
}

/** 转入计划：只读解析的结果（不写入任何内容） */
export type OpenPlan = {
  kind: 'resume' | 'chain' | 'reuse' | 'new';
  /** resume/chain/reuse 时的目标会话；new 时为空 */
  targetRef?: SessionRef;
  /** 待写入增量；为空表示无需写入（直接打开既有会话） */
  turns: UnifiedTurn[];
  merged: number;
  /** 解析时抓的目标指纹（TOCTOU 用）；new 时为 null */
  snapshot: FileDigest | null;
  note?: string;
};

type PlannedOpen =
  | { ok: true; adapter: ProviderAdapter; sourceRef: SessionRef; sourceProvider: string; cwd: string; plan: OpenPlan }
  | { ok: false; error: string };

/**
 * 目标会话里的坏行会被 parse 跳过，于是 `diffTurns(来源, 目标)` 把「已有但解析不出」的内容
 * 当成缺失、再追加一遍；round-trip 也查不出来（比对的是解析结果）。只能在这里主动披露。
 */
async function warnTargetBadLines(
  ref: SessionRef,
  target: ProviderAdapter,
  diagnostics?: string[],
): Promise<void> {
  const bad = await countUnparsableJsonLines(ref.filePath);
  if (bad > 0) {
    diagnostics?.push(
      `目标会话 ${ref.sessionId}（${target.displayName}）有 ${bad} 行无法解析（截断或损坏）：增量判定可能偏多，可能重复追加既有内容`,
    );
  }
}

/**
 * 只读解析「把 sourceId 转入 providerId」会落到哪个目标会话、需要写多少轮。
 * 决策顺序与旧实现一致：属主即目标（resume）→ 链上配对 → 内容复用 → 新建。
 */
async function planOpenInProvider(
  sourceId: string,
  providerId: string,
  mapping: Store | null,
  diagnostics?: string[],
): Promise<PlannedOpen> {
  // 先校验目标 provider：拼错时再怎么说「未找到会话」都跑偏了，
  // 用户会去查会话 id，而不是回头看 --to 的拼写。
  const target = getAdapter(providerId);
  if (!target) return { ok: false, error: unknownProviderMessage(providerId) };
  // 反查失败原因只在「真的没找到」时报；命中了就别拿别家存储的毛病打扰用户
  const lookup: string[] = [];
  const source = await resolveById(sourceId, undefined, mapping, undefined, lookup);
  if (!source) {
    const detail = lookup.length ? `（${lookup.join('；')}）` : '';
    return { ok: false, error: `未找到会话: ${sourceId}${detail}` };
  }
  const cwd = source.found.ref.cwd;
  const sourceRef = source.found.ref;
  const sourceProvider = source.adapter.id;
  const base = { ok: true as const, adapter: target, sourceRef, sourceProvider, cwd };

  // 属主即目标：无需转化，直接 resume
  if (sourceProvider === providerId) {
    return { ...base, plan: { kind: 'resume', targetRef: sourceRef, turns: [], merged: 0, snapshot: null } };
  }

  let turns: UnifiedTurn[];
  try {
    turns = await source.adapter.parse(sourceRef);
  } catch (error) {
    // 解析不了来源就没有可转入的内容；按错误返回，别让异常穿透到 openInProvider 的调用方
    return {
      ok: false,
      error: `来源会话 ${sourceId} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // parse 跳过坏行不会报错，round-trip 也比的是解析结果：不扫一遍就会把「少了几轮」当完整转入
  const badSourceLines = await countUnparsableJsonLines(sourceRef.filePath);
  if (badSourceLines > 0) {
    diagnostics?.push(
      `来源会话 ${sourceId} 有 ${badSourceLines} 行无法解析（截断或损坏），已跳过；转入内容可能不完整`,
    );
  }
  const outgoing = dedupeCallEvents(turns);
  if (outgoing.length === 0) return { ok: false, error: `来源会话 ${sourceId} 没有可转入的内容` };

  // 决策 1：来源在链上 → 回链上另一侧配对会话并并入增量；
  // 但目标 provider 的链上「最新配对」不一定对应该输入（同链会分叉出多条线），
  // 必须先做内容校验：配对确实承接了来源主要内容（缺失<一半）才落回，否则退到内容匹配。
  const chainPaired = mapping ? findChainPaired(mapping, sourceProvider, sourceId, providerId, cwd) : null;
  if (chainPaired) {
    let pairTurns: UnifiedTurn[] | null = null;
    try {
      pairTurns = await target.parse(chainPaired);
    } catch (error) {
      // 链上配对会话的文件可能已被删掉或截断（doctor 的 brokenTips 报的正是这种情况）：
      // 退回内容匹配 / 新建，并把原因写进 notes，而不是让整个转入抛出去
      diagnostics?.push(
        `链上 ${target.displayName} 会话 ${chainPaired.sessionId} 读取失败，本次不沿用（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (pairTurns) {
      const delta = dedupeCallEvents(diffTurns(turns, pairTurns));
      if (delta.length < turns.length / 2) {
        await warnTargetBadLines(chainPaired, target, diagnostics);
        const snapshot = (await target.contentFingerprint?.(chainPaired)) ?? null;
        return {
          ...base,
          plan: {
            kind: 'chain',
            targetRef: chainPaired,
            turns: delta,
            merged: delta.length,
            snapshot,
            note:
              delta.length === 0
                ? `回到链上 ${target.displayName} 会话 ${chainPaired.sessionId}，无需并入`
                : `已把 ${source.adapter.displayName} 的新增 ${delta.length} 轮并入链上 ${target.displayName} 会话 ${chainPaired.sessionId}`,
          },
        };
      }
    }
  }

  // 决策 2：游离会话 → 内容匹配复用「包含来源主要部分」的既有目标会话；
  // 取缺失最少且更新时间最新的候选，完全包含直接开回来，部分缺失补增量，找不到才新建。
  let reuse: SessionRef | undefined;
  let reuseMissing = Infinity;
  let reuseAt = -1;
  let parseFailed = 0;
  if (typeof target.listSessions === 'function') {
    try {
      const sessions = await target.listSessions(cwd);
      for (const s of sessions) {
        let destTurns: UnifiedTurn[];
        try {
          destTurns = await target.parse(s.ref);
        } catch {
          parseFailed += 1;
          continue;
        }
        const missing = diffTurns(turns, destTurns);
        // 缺失少于来源一半才认为同源；多个候选时取缺失最少、更新最新者
        if (
          missing.length < turns.length / 2 &&
          (missing.length < reuseMissing || (missing.length === reuseMissing && s.updatedAt > reuseAt))
        ) {
          reuse = s.ref;
          reuseMissing = missing.length;
          reuseAt = s.updatedAt;
        }
      }
    } catch (error) {
      // 扫不动只能新建：会多出一份会话，必须说明原因，而不是让用户以为 「本该复用却新建」
      diagnostics?.push(
        `目标 ${target.displayName} 会话列表读取失败，未能复用既有会话（将新建）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parseFailed > 0) {
      diagnostics?.push(`目标 ${target.displayName} 有 ${parseFailed} 个候选会话解析失败，未参与复用匹配`);
    }
  }
  if (reuse) {
    let destinationTurns: UnifiedTurn[];
    try {
      // 扫描时刚解析成功过；这里再读失败说明文件正被并发改写（半截写入 / 被删），
      // 不能悄悄退成新建（会多出一份重复会话），按错误返回让用户重试
      destinationTurns = await target.parse(reuse);
    } catch (error) {
      return {
        ok: false,
        error: `目标会话 ${reuse.sessionId} 在写入前读取失败，本次未写入任何内容：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    await warnTargetBadLines(reuse, target, diagnostics);
    const delta = dedupeCallEvents(diffTurns(turns, destinationTurns));
    const snapshot = (await target.contentFingerprint?.(reuse)) ?? null;
    return {
      ...base,
      plan: {
        kind: 'reuse',
        targetRef: reuse,
        turns: delta,
        merged: delta.length,
        snapshot,
        note:
          delta.length === 0
            ? `已在 ${target.displayName} 找到包含全部内容的既有会话 ${reuse.sessionId}，直接打开，无需新建`
            : `已把 ${source.adapter.displayName} 的新增 ${delta.length} 轮并入既有 ${target.displayName} 会话 ${reuse.sessionId}`,
      },
    };
  }
  return {
    ...base,
    plan: {
      kind: 'new',
      turns: outgoing,
      merged: outgoing.length,
      snapshot: null,
      note: `已把 ${source.adapter.displayName} 的 ${outgoing.length} 轮内容转入 ${target.displayName} 新会话`,
    },
  };
}

/** 写入前的目标级保护：preflight（Codex 会查原生 writer 锁）+ 协作写锁 + TOCTOU 指纹比对 */
async function guardedImport(
  adapter: ProviderAdapter,
  ref: SessionRef | undefined,
  snapshot: FileDigest | null,
  turns: UnifiedTurn[],
  cwd: string,
): Promise<SessionRef> {
  await adapter.preflight?.({ ref, cwd });
  // 协作锁：若供应商支持，写入期间独占原生 writer 锁，把竞态窗口收窄为原子取锁
  const guard = ref ? await adapter.acquireWriteLock?.({ ref }) : undefined;
  try {
    if (ref) await assertTargetUnchanged(adapter, ref, snapshot, '转入');
    return await adapter.importTurns(turns, cwd, ref);
  } finally {
    await guard?.release();
  }
}

/**
 * 把来源会话内容直接转入指定 provider 的会话，返回可 resume 命令。
 * 桌面端点非属主 agent 卡时使用：属性即目标时等价 openSession 快路径，不做转化。
 * 不抛异常，失败以 { ok:false, error } 返回。
 */
export async function openInProvider(
  sourceId: string,
  providerId: string,
  store?: Store | null,
): Promise<OpenSessionResult> {
  const mapping = store ?? openMappingDb();
  const diagnostics: string[] = [];
  const planned = await planOpenInProvider(sourceId, providerId, mapping, diagnostics);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { adapter: target, sourceRef, sourceProvider, cwd, plan } = planned;

  const cliBlock = await newSessionCliBlock(target, plan);
  if (cliBlock) {
    return { ok: false, error: cliBlock.error, blocked: { code: cliBlock.code, hint: cliBlock.hint } };
  }

  if (plan.kind === 'resume') {
    const resumeCommand = target.resumeCommand(sourceRef);
    const cd = buildCd(cwd);
    return {
      ok: true,
      provider: providerId,
      cwd,
      sessionId: sourceRef.sessionId,
      filePath: sourceRef.filePath,
      cd,
      resumeCommand,
      command: buildCommand(cd, resumeCommand),
      mergedTurns: 0,
      ...(diagnostics.length ? { warnings: [...diagnostics] } : {}),
    };
  }

  const notes: string[] = [];
  const warnings: string[] = [...diagnostics];
  try {
    const source = getAdapter(sourceProvider);
    let sourceUsage: TokenUsage | null = null;
    if (typeof source?.sessionUsage === 'function') {
      sourceUsage =
        (await source.sessionUsage(sourceRef).catch((error: unknown) => {
          warnings.push(
            `来源 ${source.displayName} 用量读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        })) ?? null;
      if (sourceUsage) {
        notes.push(
          `来源 ${source.displayName} 用量 in=${sourceUsage.inputTokens} out=${sourceUsage.outputTokens}（已在对账中携带）`,
        );
      }
    }
    const newRef =
      plan.turns.length > 0 ? await guardedImport(target, plan.targetRef, plan.snapshot, plan.turns, cwd) : plan.targetRef;
    if (!newRef) return { ok: false, error: '转入目标会话失败: 未获得可用的目标会话引用' };
    if (plan.note) notes.push(plan.note);
    if (mapping) {
      try {
        mapping.rememberSessionLocation(providerId, newRef, Date.now());
      } catch {
        /* location remember failure does not block transfer */
      }
    }
    const resumeCommand = target.resumeCommand(newRef);
    const cd = buildCd(cwd);
    return {
      ok: true,
      provider: providerId,
      cwd,
      sessionId: newRef.sessionId,
      filePath: newRef.filePath,
      cd,
      resumeCommand,
      command: buildCommand(cd, resumeCommand),
      mergedTurns: plan.merged,
      sourceUsage,
      notes,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    const blocked = blockedFrom(error);
    const raw = error instanceof Error ? error.message : String(error);
    return blocked ? { ok: false, error: raw, blocked } : { ok: false, error: `转入新会话失败: ${raw}` };
  }
}

/** 预检用的中性描述（写入路径的 note 是过去式，不适用于“尚未写入”的预检） */
/** 新建会话必须调原生 CLI 的 provider，CLI 不可用时给出可操作的结构化阻断（只读判定，不写盘） */
export async function newSessionCliBlock(
  target: ProviderAdapter,
  plan: Pick<OpenPlan, 'kind'>,
): Promise<{ code: string; hint: string; error: string } | undefined> {
  if (plan.kind !== 'new' || !target.requiresCliForNewSession) return undefined;
  const available = await target.detect().catch(() => false);
  if (available) return undefined;
  return {
    code: 'cli_missing',
    hint: `未写入任何内容；新建 ${target.displayName} 会话需要本机已安装并登录 ${target.id} CLI。`,
    error: `${target.displayName} 未检测到：新建 ${target.id} 会话需要本机已安装并登录 ${target.id} CLI`,
  };
}

function describePlan(target: ProviderAdapter, plan: OpenPlan): string {
  const turnText = plan.turns.length === 0 ? '无需并入' : `写入 ${plan.turns.length} 轮`;
  switch (plan.kind) {
    case 'resume':
      return '来源即目标，直接恢复原会话';
    case 'chain':
      return `将回到链上 ${target.displayName} 会话 ${plan.targetRef?.sessionId}（${turnText}）`;
    case 'reuse':
      return `将并入既有 ${target.displayName} 会话 ${plan.targetRef?.sessionId}（${turnText}）`;
    default:
      return `将新建 ${target.displayName} 会话（${turnText}）`;
  }
}

/**
 * 点击前预检（只读）：解析转入会落到哪种目标，并用目标级保护探测是否可写；不写入任何内容。
 * `writable:false` + `blocked` 表示现在点「转入」会被拒绝。
 */
export async function checkOpenInProvider(
  sourceId: string,
  providerId: string,
  store?: Store | null,
): Promise<OpenSessionResult> {
  const mapping = store ?? openMappingDb();
  const diagnostics: string[] = [];
  const planned = await planOpenInProvider(sourceId, providerId, mapping, diagnostics);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { adapter: target, cwd, plan } = planned;
  const base: OpenSessionResult = {
    ok: true,
    provider: target.id,
    cwd,
    sessionId: plan.targetRef?.sessionId,
    filePath: plan.targetRef?.filePath,
    notes: [describePlan(target, plan)],
    ...(diagnostics.length ? { warnings: [...diagnostics] } : {}),
    writable: true,
    plan: { kind: plan.kind, turnCount: plan.turns.length },
  };
  // 空来源也会新建会话（Kimi 要真跑一次 CLI），所以 CLI 判定不能放在 turns===0 之后
  const cliBlock = await newSessionCliBlock(target, plan);
  if (cliBlock) {
    return {
      ...base,
      writable: false,
      blocked: { code: cliBlock.code, hint: cliBlock.hint },
      error: cliBlock.error,
    };
  }
  if (plan.turns.length === 0) return base; // 无需写入（直接打开既有会话）
  try {
    await target.preflight?.({ ref: plan.targetRef, cwd });
  } catch (error) {
    const blocked = blockedFrom(error);
    if (blocked) {
      return {
        ...base,
        writable: false,
        blocked,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
  return base;
}
