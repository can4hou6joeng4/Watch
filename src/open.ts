import { stat } from 'node:fs/promises';
import { describeWriteFailureReason, type FileDigest } from './core/atomic.js';
import { assertTargetUnchanged, blockedHint, diffTurns, HandoffBlockedError } from './core/handoff.js';
import { describeDanglingToolCalls, describeUnansweredTail, dedupeCallEvents } from './core/rich.js';
import { Store, defaultDbPath, describeStoreErrorReason, describeStoreOpenFailure } from './core/store.js';
import { IS_WIN, stripDevicePrefix } from './core/platform.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './core/types.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { PreflightBlockedError } from './providers/adapter.js';
import { getAdapter, listAdapters, unknownProviderMessage } from './providers/registry.js';
import { countUnparsableJsonLines } from './core/jsonl.js';
import {
  describePathReadFailureReason,
  describeReadFailureOrSelf,
  describeSessionReadFailure,
  describeSessionReadFailureReason,
} from './core/read-text.js';
import { sessionCwdProblem } from './core/cwd.js';

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
    return { code: error.code, hint: blockedHint(error.code) };
  }
  return undefined;
}

/** 映射快返的「文件还在吗」：只有 ENOENT / ENOTDIR 才是「不在了」。
 * `EACCES` 等读不出来的情况照常抛出，由 resolveById 记进 diagnostics —— 把权限问题当成文件被删，
 * 会让人以为是会话丢了，而不是去看目录权限。
 * 路径在但不是普通文件（被同名目录 / 设备文件占住）单独一档：它不能当命中，也不能当「被删」 */
async function probeMappedFile(p: string): Promise<'present' | 'gone' | 'not-file'> {
  try {
    return (await stat(p)).isFile() ? 'present' : 'not-file';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 只有「路径上确实没有东西」算不存在；EACCES 等读不出来照常抛，由调用方记进 diagnostics
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    throw error;
  }
}

/**
 * 映射库可用则打开（默认 ~/.watch/watch.db）；打不开返回 null 降级纯扫描，不阻塞反查。
 *
 * 降级本身是设计（接力照常），但不能静默：打不开意味着这次反查是全盘扫描、命中也不会写回映射，
 * 用户只会觉得「每次都很慢」而不知道本地库坏了。原因经 `describeStoreOpenFailure()` 说清。
 */
function openMappingDb(warnings?: string[]): Store | null {
  const dbPath = process.env.WATCH_DB ?? defaultDbPath();
  try {
    return new Store(dbPath);
  } catch (error) {
    warnings?.push(
      `本地映射库打不开（${describeStoreOpenFailure(dbPath, error)}）；本次反查为全盘扫描，结果也不会写回映射，下次仍需重新扫描`,
    );
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
      // 库查询与「探测映射文件」分开 catch：前者是本地库问题（按库的说法翻），后者是会话
      // 文件问题（按会话文件的说法翻），混成一句会把「文件没权限」讲成「本地库坏了」
      let loc: ReturnType<Store['getSessionLocation']>;
      try {
        loc = store.getSessionLocation(a.id, sessionId);
      } catch (error) {
        diagnostics?.push(`${a.id} 映射读失败：${describeStoreErrorReason(error)}`);
        continue;
      }
      // Windows canonicalize 会给路径加 `\\?\` 前缀，探测其去前缀形式
      const filePath = loc && IS_WIN ? stripDevicePrefix(loc.filePath) : loc?.filePath;
      let state: 'gone' | 'present' | 'not-file';
      try {
        state = loc && filePath ? await probeMappedFile(filePath) : 'gone';
      } catch (error) {
        // 读不出来不能等同「没有这个会话」：记进 diagnostics，全扫也没找到时能说清原因
        diagnostics?.push(
          `${a.id} 会话 ${sessionId} 的映射记录指向的文件状态读不出来（${filePath}）：${describeSessionReadFailureReason(error)}；已改为全盘扫描`,
        );
        continue;
      }
      if (loc && filePath && state === 'present') {
        try {
          store.rememberSessionLocation(a.id, loc, Date.now());
        } catch (error) {
          // 不影响本次反查，但本地库从此一直记得「很久没见」：只要写不进去就一直命中映射、
          // 也不会有任何提示。库坏了要让人知道，别等用户自己感觉到「越用越慢」
          diagnostics?.push(
            `${a.id} 会话 ${sessionId} 的映射刷新失败（${describeStoreErrorReason(error)}）；本次仍从映射命中，但本地库里的时间戳没更新`,
          );
        }
        return {
          adapter: a,
          found: {
            ref: { provider: a.id, sessionId, filePath: loc.filePath, cwd: loc.cwd },
            updatedAt: loc.lastSeenAt,
          },
        };
      }
      if (loc && filePath && state === 'not-file') {
        // 与 `recent` / `sessions --chain` / `search` 索引清理同一档说法：路径被同名目录或
        // 设备文件占住既不是「会话没了」也不是可用文件，全扫也找不到时要能说清原因
        diagnostics?.push(
          `${a.id} 会话 ${sessionId} 的映射记录指向的路径现在不是普通文件（被同名目录或设备文件占住了）：${loc.filePath}；已改为全盘扫描`,
        );
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
          } catch (error) {
            // 同上：写不进去不影响这次打开，但下次仍要重新全盘扫描。不披露就只剩「慢」这一个症状
            diagnostics?.push(
              `${a.id} 会话 ${sessionId} 的映射写入失败（${describeStoreErrorReason(error)}）；本次反查结果未记入本地库，下次 open 仍需重新全盘扫描`,
            );
          }
        }
        return { adapter: a, found };
      }
    } catch (error) {
      // 一家存储读失败不该拖垮反查，但必须披露：否则「没找到」和「没查成」分不清。
      // 这里不假定对象是会话文件（findById 可能死在目录 / 索引 / 库上），所以按路径来说；
      // 适配器自己写好的中文原因原样保留，只有漏网的 fs errno 才翻成中文。
      diagnostics?.push(`${a.id} 反查失败：${describePathReadFailureReason(error)}`);
      continue;
    }
  }
  return null;
}

/**
 * `--provider` 指定的那一家没有这个 id 时，别家可能有：跨家再反查一次，别把
 * 「provider 写错」讲成「id 写错」。`cmdAdopt` 早就是这么做的（会话属于别家会指名），
 * `open` 一直没有，两条路径对同一种参数错误给出两种说法。
 *
 * 只跳过被点名的 provider；别家读不出来既不算命中、也不能当成「这家没有」——
 * 记进 unreadable，没命中时一并披露，不凭空断言「谁都不认识这个 id」。
 */
async function findOwnerElsewhere(
  sessionId: string,
  provider: string,
  adapters: ProviderAdapter[],
): Promise<{ owner: string | null; unreadable: string[] }> {
  const unreadable: string[] = [];
  for (const a of adapters) {
    if (a.id === provider || !a.findById) continue;
    try {
      if (await a.findById(sessionId)) return { owner: a.id, unreadable };
    } catch (error) {
      unreadable.push(`${a.id}（${describePathReadFailureReason(error)}）`);
    }
  }
  return { owner: null, unreadable };
}

/**
 * 读会话文件失败的用户面原因：fs 错误（EACCES / EIO…）说成「读不出来」，
 * 其余保留适配器自己给的说明（内容格式问题本来就是中文）。
 *
 * 用量 / 摘要都是附加信息，失败不阻断打开；但把 `EACCES: permission denied, open '…'`
 * 原样塞进 warnings 会让人以为会话坏了，实际要修的是权限。
 */
function fileReadReason(error: unknown): string {
  return describeReadFailureOrSelf(error);
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
  const warnings: string[] = [];
  const mapping = store ?? openMappingDb(warnings);
  const lookup: string[] = [];
  const target = await resolveById(targetId, provider, mapping, adapters, lookup);
  if (!target) {
    // 映射库打不开也要进「未找到」的说明：否则用户只看到「没找到」，不知道这次是全盘扫描、
    // 也不知道本地库坏了（成功路径走 warnings）
    const detail = [...warnings, ...lookup].length ? `（${[...warnings, ...lookup].join('；')}）` : '';
    // 链 id 与会话 id 都是 UUID，chain list 里还印在同一行：直接说「未找到会话」会让人
    // 去核对那串 id 有没有抄错，而链永远不会被反查命中
    const chainUse = mapping && !provider ? mapping.describeChainIdMisuse(targetId) : null;
    // `--provider` 写错时（id 其实属于别家）单说「未找到会话」会让人去核对那串 id，
    // 而它是对的：跨家反查一次，命中就指名真实 provider 并给出可照抄的下一步。
    const elsewhere = provider ? await findOwnerElsewhere(targetId, provider, adapters) : { owner: null, unreadable: [] };
    if (elsewhere.owner) {
      return {
        ok: false,
        error:
          `会话 ${targetId} 属于 ${elsewhere.owner}，不是 ${provider}；` +
          `请用 watch open ${targetId} --provider ${elsewhere.owner}，或去掉 --provider 按 id 全局反查${detail}`,
      };
    }
    const unchecked = elsewhere.unreadable.length
      ? `另有 ${elsewhere.unreadable.length} 家没能查（${elsewhere.unreadable.join('、')}），无法确认它是否属于那些 provider`
      : '';
    return {
      ok: false,
      error: `${chainUse ? `${chainUse}；` : ''}未找到会话: ${targetId}${provider ? `（provider=${provider}）` : ''}。请确认 id 正确且对应 CLI 已安装登录。${unchecked}${detail}`,
    };
  }
  const notes: string[] = [];
  let merged = 0;
  let sourceUsage: TokenUsage | null = null;
  // 记录的目录可能已被移动 / 删除：会话内容照常可读、转入也能写成，但返回的 cd 会在第一步失败
  const cwdIssue = await sessionCwdProblem(target.found.ref.cwd);
  if (cwdIssue) warnings.push(cwdIssue);

  // 来源与目标是同一个会话：diffTurns 必然为空，旧实现会报「已全部包含在自身中，无需并入」，
  // 看着像成功、实际什么都没做。这是参数错误，直接说清楚。
  if (from && from === targetId) {
    return { ok: false, error: `--from 与 <session-id> 是同一个会话: ${targetId}；请把来源换成另一侧的会话` };
  }

  if (from) {
    const source = await resolveById(from, undefined, mapping, adapters, lookup);
    if (!source) {
      const detail = lookup.length ? `（${lookup.join('；')}）` : '';
      // 来源侧与目标侧是同一件事：链 id 与会话 id 都是 UUID、`chain list` 还把它们印在同一行，
      // 只回「未找到来源会话」会让人反复核对那串抄得没错的 id。目标侧早就认链 id，这里补齐。
      const chainUse = mapping ? mapping.describeChainIdMisuse(from) : null;
      return {
        ok: false,
        error: chainUse
          ? `未找到来源会话: ${from}；${chainUse}${detail}`
          : `未找到来源会话: ${from}。请确认 id 正确，且该会话属于已安装登录的 CLI；可用 watch sessions 或 watch recent 核对会话 id，若它在别的目录请用 watch recent --cwd <目录> 查看${detail}`,
      };
    }
    try {
      // 来源 usage 聚合携带：source 支持 sessionUsage 时读出，跨侧对账展示（写回各 build 仍为零占位）
      if (typeof source.adapter.sessionUsage === 'function') {
        sourceUsage =
          (await source.adapter.sessionUsage(source.found.ref).catch((error: unknown) => {
            // 与目标侧一致：读失败不能和「原生没有 usage」一样静默成 null
            warnings.push(
              `来源 ${source.adapter.displayName} 用量读取失败：${fileReadReason(error)}`,
            );
            return null;
          })) ?? null;
        if (sourceUsage) {
          notes.push(
            `来源 ${source.adapter.displayName} 用量 in=${sourceUsage.inputTokens} out=${sourceUsage.outputTokens}（已在对账中携带）`,
          );
        }
      }
      // 来源 / 目标解析各自捕获：它们都是「读」，让它们落进下面管写入的 catch 会被
      // 说成「并入新内容失败：无权写入」，把读失败讲成写失败、还指向错误的下一步
      let srcTurns: UnifiedTurn[];
      try {
        srcTurns = await source.adapter.parse(source.found.ref);
      } catch (error) {
        return {
          ok: false,
          error: `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）读取失败：${describeReadFailureOrSelf(error)}；本次未写入任何内容`,
        };
      }
      const badSrcLines = await countUnparsableJsonLines(source.found.ref.filePath);
      if (badSrcLines > 0) {
        warnings.push(
          `来源会话 ${source.found.ref.sessionId} 有 ${badSrcLines} 行无法解析（截断或损坏），已跳过；并入内容可能不完整`,
        );
      }
      let dstTurns: UnifiedTurn[];
      try {
        dstTurns = await target.adapter.parse(target.found.ref);
      } catch (error) {
        return {
          ok: false,
          error: `目标会话 ${target.found.ref.sessionId}（${target.adapter.displayName}）读取失败：${describeReadFailureOrSelf(error)}；本次未写入任何内容`,
        };
      }
      warnUnfinishedTurns(
        srcTurns,
        `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）`,
        (msg) => warnings.push(msg),
      );
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
      // 写入被阻断走结构化 blocked（文案已是中文）；其余多半是写盘失败，原文只有英文 errno
      return blocked ? { ok: false, error: raw, blocked } : { ok: false, error: `并入新内容失败: ${describeWriteFailureReason(error) ?? raw}` };
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
            `${target.adapter.displayName} 用量读取失败：${fileReadReason(error)}`,
          );
          return null;
        })) ?? null;
    }
    try {
      const turns = await target.adapter.parse(target.found.ref);
      // 即将 resume 的这个会话本身就停在做了一半的工具调用上：resume 后客户端多半也停在那里
      warnUnfinishedTurns(
        turns,
        `会话 ${target.found.ref.sessionId}（${target.adapter.displayName}）`,
        (msg) => warnings.push(msg),
      );
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
        `会话摘要解析失败，未展示轮次与工具信息：${fileReadReason(error)}`,
      );
    }
  }

  // 反查过程中的降级（映射写不进去、某家存储读不出来）在成功路径同样要说：
  // 只把它们留在「未找到」的错误文案里，一旦找到了就永远看不到——而这些降级恰好
  // 只会在慢下来、扫不全时才被用户察觉
  warnings.push(...lookup);

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
 * 会话没收尾的两种形状，`diffTurns` 与 round-trip 都查不出来——只能主动披露：
 *   1. 工具调用没有结果（中断 / 仍在运行 / resume 重放过半截调用）；
 *   2. 最后停在用户消息上、没有对应的助手回复（用户说完就被打断 / 文件被截断）。
 * 两处文案都在 `rich.ts`，`switch` 用的是同一对函数，措辞不会在 CLI 与桌面端跑偏。
 */
function warnUnfinishedTurns(turns: UnifiedTurn[], label: string, push: (msg: string) => void): void {
  for (const message of [describeDanglingToolCalls(turns, label), describeUnansweredTail(turns, label)]) {
    if (message) push(message);
  }
}

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
    // 与 openSession 同理：这条路径也会被链 id 撞上（`open <链 id> --to codex`）
    const chainUse = mapping ? mapping.describeChainIdMisuse(sourceId) : null;
    return { ok: false, error: `${chainUse ? `${chainUse}；` : ''}未找到会话: ${sourceId}${detail}` };
  }
  const cwd = source.found.ref.cwd;
  // 预检与写入都用这个目录：它不在了要提前说，别等用户照着一句必失败的 cd 去执行
  const cwdIssue = await sessionCwdProblem(cwd);
  if (cwdIssue) diagnostics?.push(cwdIssue);
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
      error: `来源会话 ${sourceId} 读取失败：${describeReadFailureOrSelf(error)}；本次未写入任何内容`,
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
  // 来源停在做了一半的工具调用上：转入后目标会话在那一轮同样不完整，预检与写入都要说
  warnUnfinishedTurns(
    turns,
    `来源会话 ${sourceId}（${source.adapter.displayName}）`,
    (msg) => diagnostics?.push(msg),
  );
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
      // 退回内容匹配 / 新建，并把原因写进 notes，而不是让整个转入抛出去。
      // 原因按 errno 说清楚：权限问题会被「已不存在」引去白换一次绑定。
      diagnostics?.push(
        `链上 ${target.displayName} 会话 ${chainPaired.sessionId} 本次不沿用：${describeSessionReadFailure(
          chainPaired.filePath,
          error,
        )}（改用内容匹配或新建）`,
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
  const unreadableCandidates: string[] = [];
  if (typeof target.listSessions === 'function') {
    try {
      const sessions = await target.listSessions(cwd);
      for (const s of sessions) {
        let destTurns: UnifiedTurn[];
        try {
          destTurns = await target.parse(s.ref);
        } catch (error) {
          parseFailed += 1;
          // 列目录到解析之间被删掉算正常（这条本来也无法复用）；其余读不出来要记原因：
          // 只报「N 个解析失败」会被读成「候选都不匹配」，实际可能是权限问题
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            unreadableCandidates.push(`${s.ref.sessionId}：${describeSessionReadFailure(s.ref.filePath, error)}`);
          }
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
        `目标 ${target.displayName} 会话列表读取失败，未能复用既有会话（将新建）：${describePathReadFailureReason(error)}`,
      );
    }
    if (parseFailed > 0) {
      const detail =
        unreadableCandidates.length > 0
          ? `（读不出来的：${unreadableCandidates[0]}${
              unreadableCandidates.length > 1 ? ` 等 ${unreadableCandidates.length} 个` : ''
            }）`
          : '';
      diagnostics?.push(
        `目标 ${target.displayName} 有 ${parseFailed} 个候选会话解析失败，未参与复用匹配${detail}`,
      );
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
        error: `目标会话 ${reuse.sessionId} 在写入前读取失败，本次未写入任何内容：${describeReadFailureOrSelf(error)}`,
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
  const diagnostics: string[] = [];
  const mapping = store ?? openMappingDb(diagnostics);
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
      // 这条快路径什么都不写：目标 provider 就是来源。少了这句，文本模式只剩 cd 与 resume
      // 两行，看着与一次真的转入一样；而同一个操作的 --check 一直说「来源即目标，直接恢复原会话」
      // （describePlan），预检与执行对同一件事给出两套说法。mergedTurns:0 分不出
      // 「没有内容可并入」与「根本没走转入」
      notes: [describePlan(target, plan)],
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
            `来源 ${source.displayName} 用量读取失败：${fileReadReason(error)}`,
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
      } catch (error) {
        // 与 resolveById 的两处写回一致：不影响这次转入，但本地库从此记不住这条新会话，
        // 下次仍要全盘扫描。不披露就只剩「慢」这一个症状
        warnings.push(
          `转入的 ${providerId} 会话 ${newRef.sessionId} 未记入本地映射（${describeStoreErrorReason(error)}）；不影响本次打开，但下次 open 仍需重新全盘扫描`,
        );
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
    return blocked ? { ok: false, error: raw, blocked } : { ok: false, error: `转入新会话失败: ${describeWriteFailureReason(error) ?? raw}` };
  }
}

/** 预检用的中性描述（写入路径的 note 是过去式，不适用于“尚未写入”的预检） */
/** 新建会话必须调原生 CLI 的 provider，CLI 不可用时给出可操作的结构化阻断（只读判定，不写盘） */
export async function newSessionCliBlock(
  target: ProviderAdapter,
  plan: Pick<OpenPlan, 'kind'>,
): Promise<{ code: string; hint: string; error: string } | undefined> {
  if (plan.kind !== 'new' || !target.requiresCliForNewSession) return undefined;
  let available: boolean;
  try {
    available = await target.detect();
  } catch (error) {
    // 检测本身失败 ≠ 没装：以前 `catch(() => false)` 会把它说成 cli_missing，
    // 用户被引去重装一个可能装着、只是 PATH / 权限 / 配置读不出来的 CLI
    const reason = error instanceof Error ? error.message : String(error);
    return {
      code: 'cli_detect_failed',
      hint: `未写入任何内容；无法确认 ${target.id} CLI 是否可用（${reason}）。先修好检测问题（PATH、权限或客户端配置）再重试。`,
      error: `${target.displayName} CLI 检测失败（不是「未安装」）：${reason}`,
    };
  }
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
  const diagnostics: string[] = [];
  const mapping = store ?? openMappingDb(diagnostics);
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
