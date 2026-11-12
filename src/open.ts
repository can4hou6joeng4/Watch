import { stat } from 'node:fs/promises';
import { describeWriteFailureReason, type FileDigest } from './core/atomic.js';
import { assertTargetUnchanged, blockedHint, describeSourceChangedDuringHandoff, diffTurns, HandoffBlockedError, snapshotSourceState, type SourceStateSnapshot } from './core/handoff.js';
import { describeAttachmentLoss, describeTextEventLoss, describeDanglingToolCalls, describeUnansweredTail, describeResumeTargetUnfinished, dedupeCallEvents, findContextDisclosure, countPairedTurnsMissingEvents } from './core/rich.js';
import { Store, defaultDbPath, describeStoreErrorReason, describeStoreOpenFailure } from './core/store.js';
import { IS_WIN, normalizePath, stripDevicePrefix } from './core/platform.js';
import { trimUserKey } from './core/cli-input.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './core/types.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { cliDetectFailedBlock, cliMissingBlock, PreflightBlockedError, SessionLookupFailureError } from './providers/adapter.js';
import type { SessionLookupFailureKind } from './providers/adapter.js';
import { getAdapter, listAdapters, unknownProviderMessage } from './providers/registry.js';
import { countUnparsableJsonLines } from './core/jsonl.js';
import { usageBadLinesReason, usageSidecarProblem } from './core/usage-integrity.js';
import { collectUnattributable, unattributablePickWarning } from './core/session-coverage.js';
import {
  describePathReadFailureReason,
  describeReadFailureOrSelf,
  describeSessionReadFailure,
  describeSessionReadFailureReason,
  isEmptySessionFileReason,
  probeSessionReadable,
} from './core/read-text.js';
import { sessionCwdProblem } from './core/cwd.js';
import { escapeControlChars } from './core/display.js';

/**
 * 按 id 反查不到会话时的「下一步」，所有按 id 反查的路径共用
 * （`open <id>` / `open --from` / `open <id> --to` / `adopt --session`）。
 *
 * 各写一句的结果是 `open <id> --to <provider>` 只剩一句「未找到会话: <id>」：用户既没有
 * 办法核对那串 id，也不知道这次到底有没有写入，而它偏偏是唯一会真往目标 provider 写内容的
 * 那条。同一句话写多遍也是本仓库反复修过的维护陷阱——改一处漏几处，下次还会再分叉。
 * `adopt --session` 是最晚归位的一处（它同样是写路径，会写 switch_events、动链尾）。
 */
export const LOOKUP_NEXT_STEP =
  '可用 watch sessions 或 watch recent 核对会话 id，若它在别的目录请用 watch recent --cwd <目录> 查看';

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

/** 反查里一家「没查成」的结构化结论：见 `SessionLookupFailureKind` */
export type LookupMiss = { provider: string; kind: SessionLookupFailureKind; reason: string };

/**
 * 「未找到会话」这句结论只在**每家都确实没有这个 id** 时才成立。
 *
 * 适配器按 id 命中文件却读不出来（`found-unreadable`）、或者目录 / 索引 / 库整片读不出来
 * 压根没查全（`incomplete`）时，它抛出的原因以前只被拼进「未找到会话: <id>。请确认 id 正确…」
 * 后面的括号里——第一句就把人引去核对一串没写错的 uuid，或者引去重装一个装着的 CLI。
 * 这里按两种处境改写第一句，三条按 id 反查的路径（`open <id>` / `--from` / `--to`）共用。
 *
 * 返回 null = 各家都干净地没有这个会话，调用方保留原来的「未找到」文案。
 */
export function lookupMissHeadline(
  subject: string,
  id: string,
  misses: LookupMiss[],
  providerId?: string,
): string | null {
  const scope = providerId ? `（--provider ${providerId} 已限定在这一家）` : '';
  const found = misses.filter((m) => m.kind === 'found-unreadable');
  if (found.length) {
    const list = found.map((m) => `${m.provider}：${m.reason}`).join('；');
    return (
      `${subject} ${id} 找到了，但读不出来${scope}：${list}。` +
      '这不是 id 写错——先修好这条会话再重试（权限、路径是否还是普通文件、文件内容是否损坏），' +
      '或用原生 CLI 确认它还能不能打开'
    );
  }
  const incomplete = misses.filter((m) => m.kind === 'incomplete');
  if (incomplete.length) {
    const list = incomplete.map((m) => `${m.provider}：${m.reason}`).join('；');
    return `无法确认${subject} ${id} 是否存在${scope}：${list}。先把这些会话存储修到可读再重试`;
  }
  return null;
}

/**
 * 按原生 session id 全局反查；providerId 指定时只在对应 provider 里查。
 * store 提供时：先查本地映射表快返（记住的 cwd/filePath 且文件仍在），
 * miss 才全盘扫描各 provider 原生库，命中即写回映射，下次免扫。
 *
 * `lookupMisses` 收集「没查成」的结构化结论（见 `LookupMiss`）：失败原因进 `diagnostics`
 * 是给人看的，`lookupMisses` 是给调用方改第一句结论用的——两者不能互相替代。
 */
export async function resolveById(
  sessionId: string,
  providerId?: string,
  store?: Store | null,
  adapters: ProviderAdapter[] = listAdapters(),
  diagnostics?: string[],
  lookupMisses?: LookupMiss[],
): Promise<{ adapter: ProviderAdapter; found: { ref: SessionRef; updatedAt: number } } | null> {
  // 会话 id 一律是各家 CLI 生成的 UUID，不会以空白开头结尾；而命令行里的首尾空白在终端里
  // 看不见（从 `watch sessions` / `chain list` 的表格里连空格复制、`$(…)` 带出换行都很常见）。
  // 归一化在这里做一次，`open " <id> "` / `--from` / `--to` / `adopt --session` 四条路径全覆盖；
  // 不 trim 就会「id 一个字没抄错，却回未找到会话」——见 `src/core/cli-input.ts`
  sessionId = sessionId.trim();
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
          `${a.id} 会话 ${sessionId} 的映射记录指向的文件状态读不出来（${escapeControlChars(filePath ?? '')}）：${describeSessionReadFailureReason(error)}；已改为全盘扫描`,
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
          `${a.id} 会话 ${sessionId} 的映射记录指向的路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(loc.filePath)}；已改为全盘扫描`,
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
      const reason = describePathReadFailureReason(error);
      diagnostics?.push(`${a.id} 反查失败：${reason}`);
      // 同一份原因再记一条结构化结论：调用方要据它决定第一句说「未找到」还是「找到了但读不出来」。
      // 只认适配器显式抛出的 kind——裸 Error 分不出「按 id 命中了文件」与「目录没读成」。
      if (error instanceof SessionLookupFailureError) {
        lookupMisses?.push({ provider: a.id, kind: error.kind, reason });
      }
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

/**
 * 解析出 0 轮时再探一次文件：0 字节是内容已丢失，与「这条会话本来就没有内容」是两回事。
 *
 * 只有 cwd 不来自文件内容的适配器会带着一条 0 字节的文件走到 `open` 的这几条分支上
 * （grok 从目录名解出 cwd、kimi 从索引读），claude / codex / pi 在 `findById` 就因为读不出
 * cwd 抛 `found-unreadable` 了——于是同一个状态在 `open <id>` 上被讲成「没有可转入的内容」
 * 或干脆什么都不说，而 `sessions` / `status` / `switch` 从 275–284 轮起都会说「0 字节，内容已丢失」。
 * 判据仍只有一处（`probeSessionReadable()` + `isEmptySessionFileReason()`）。
 */
/**
 * 「未找到会话」时能直接照着改的下一步：路径当成了 id、或者只抄了 id 的前半截。
 *
 * 这两种都是抄写问题，不是「会话没了」：给一句「确认 id 正确」等于让用户对着同一串东西
 * 再看一遍。前缀命中只能查本地映射（Watch 反查过的会话），所以文案必须说明它不完整，
 * 不能把「没记过」讲成「只有这些」。
 */
function idTypoHint(mapping: Store | null, raw: string): string | null {
  if (raw.includes('/') || raw.includes('\\')) {
    return (
      '你给的是路径，不是 session id：watch open 只认各家 CLI 生成的会话 id' +
      '（Claude Code / Codex 是 uuid，OpenCode 以 ses_ 开头），先按 watch sessions 里那一行 id 来开'
    );
  }
  if (!mapping) return null;
  let hits: { provider: string; sessionId: string; cwd: string }[];
  try {
    hits = mapping.findSessionIdsByPrefix(raw, 3);
  } catch {
    // 映射读不出来不改变「未找到」这个结论，正文已有的库提示足够
    return null;
  }
  if (!hits.length) return null;
  const list = hits
    .map((h) => `${h.sessionId}（${h.provider}，${escapeControlChars(h.cwd)}）`)
    .join('；');
  return (
    `你给的更像前缀：本地映射里有 ${hits.length} 个会话 id 以它开头——${list}；` +
    'watch open 要完整 id，可直接照抄上面这个。映射只记 Watch 反查过的会话，可能还有别的'
  );
}

async function zeroByteSessionReason(ref: SessionRef): Promise<string | null> {
  const reason = await probeSessionReadable(ref.filePath);
  return reason && isEmptySessionFileReason(reason) ? reason : null;
}

/** POSIX 单引号包裹（含单引号转义），供拼接可复制的 cd / command */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号包裹（单引号双写转义），Windows 下拼接可复制的 cd */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

/**
 * 拼接可复制的 cd：isWin=true 用 PowerShell，其它用 POSIX。纯函数供单测两平台。
 *
 * Windows PowerShell 的 `Set-Location` 默认产生 **non-terminating** 错误：目标目录被删 /
 * 无权访问时，紧随其后的 resume 命令仍会执行，Agent 于是在原目录里启动，而 Watch 已经
 * 报「恢复命令已生成」。`-ErrorAction Stop` 把它升级成终止错误，`$?` 判断再显式退出，
 * 确保目录切换成功之前不会启动 Agent（桌面端 `handoff-ui.ts` 的 buildCommand 同规则）。
 */
export function buildCdFor(cwd: string, isWin: boolean): string {
  return isWin
    ? `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction Stop; if (-not $?) { exit 1 }`
    : `cd ${shellQuote(cwd)}`;
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
  const { from: rawFrom, provider } = opts ?? {};
  // 会话 id 的首尾空白在这里就去掉（见 `src/core/cli-input.ts`）：下面的 `from === targetId` 判断、
  // 以及所有回显 `targetId` / `from` 的报错都该用归一后的值——否则「同一个会话」会被判成两个不同 id，
  // 报错里也会印出一串带空白、看着像抄错的 uuid
  targetId = trimUserKey(targetId);
  const from = rawFrom === undefined ? undefined : trimUserKey(rawFrom);
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
  const misses: LookupMiss[] = [];
  const target = await resolveById(targetId, provider, mapping, adapters, lookup, misses);
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
          `会话 ${escapeControlChars(targetId)} 属于 ${elsewhere.owner}，不是 ${provider}；` +
          `请用 watch open ${escapeControlChars(targetId)} --provider ${elsewhere.owner}，或去掉 --provider 按 id 全局反查${detail}`,
      };
    }
    const unchecked = elsewhere.unreadable.length
      ? `另有 ${elsewhere.unreadable.length} 家没能查（${elsewhere.unreadable.join('、')}），无法确认它是否属于那些 provider`
      : '';
    // 有一家按 id 命中了文件却读不出来（或压根没查全）时，「未找到会话…请确认 id 正确」
    // 就是错的第一句：id 往往是对的，要修的是那个文件 / 那个目录。
    const headline = lookupMissHeadline('会话', targetId, misses, provider);
    if (headline) {
      // 原因已经在第一句里逐家说过，这里只补映射库打不开这类不进 misses 的说明
      const extra = warnings.length ? `（${warnings.join('；')}）` : '';
      return {
        ok: false,
        error: `${chainUse ? `${chainUse}；` : ''}${headline}${unchecked ? `。${unchecked}` : ''}${extra}`,
      };
    }
    // 抄写问题（拿路径当 id、只抄了前缀）单独给下一步：这一档 id 确实不存在，
    // 但「确认 id 正确」帮不上忙——用户需要的是去哪儿把那串完整 id 找回来
    const typo = idTypoHint(mapping, targetId);
    return {
      ok: false,
      error: `${chainUse ? `${chainUse}；` : ''}未找到会话: ${escapeControlChars(targetId)}${provider ? `（provider=${provider}）` : ''}。${typo ? `${typo}。` : ''}请确认 id 正确且对应 CLI 已安装登录。${LOOKUP_NEXT_STEP}${unchecked ? `。${unchecked}` : ''}${detail}`,
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
    return { ok: false, error: `--from 与 <session-id> 是同一个会话: ${escapeControlChars(targetId)}；请把来源换成另一侧的会话` };
  }

  if (from) {
    const beforeSource = lookup.length;
    const srcMisses: LookupMiss[] = [];
    const source = await resolveById(from, undefined, mapping, adapters, lookup, srcMisses);
    if (!source) {
      const detail = lookup.length ? `（${lookup.join('；')}）` : '';
      // 来源侧与目标侧是同一件事：链 id 与会话 id 都是 UUID、`chain list` 还把它们印在同一行，
      // 只回「未找到来源会话」会让人反复核对那串抄得没错的 id。目标侧早就认链 id，这里补齐。
      const chainUse = mapping ? mapping.describeChainIdMisuse(from) : null;
      // 来源那家按 id 命中了文件却读不出来（或压根没查全）时，「未找到来源会话…请确认 id 正确」
      // 是错的第一句——它与目标侧共用同一套改写
      const headline = lookupMissHeadline('来源会话', from, srcMisses);
      if (headline) {
        // 来源侧原因已逐家写在第一句里，这里只补目标侧那几家（如果有）的说明
        const prior = lookup.slice(0, beforeSource);
        const extra = prior.length ? `（${prior.join('；')}）` : '';
        return {
          ok: false,
          error: `${chainUse ? `${chainUse}；` : ''}${headline}${extra}；本次未写入任何内容`,
        };
      }
      // 与目标侧同一套抄写提示：来源侧同样会拿到路径或半截 id
      const typo = idTypoHint(mapping, from);
      return {
        ok: false,
        error: chainUse
          ? `未找到来源会话: ${escapeControlChars(from)}；${chainUse}${typo ? `；${typo}` : ''}${detail}`
          : `未找到来源会话: ${escapeControlChars(from)}。${typo ? `${typo}。` : ''}请确认 id 正确，且该会话属于已安装登录的 CLI；${LOOKUP_NEXT_STEP}${detail}`,
      };
    }
    // 来源快照：parse 之前取、写完之后再比（下面那个 catch 会提前返回，所以声明在它外面）
    let srcSnapshot: SourceStateSnapshot | null = null;
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
        // 合计里少算了坏行那一部分：不说明的话，这个数会被当成来源的真实用量
        const badUsage = await usageBadLinesReason(
          source.adapter,
          source.found.ref,
          `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）`,
        );
        if (badUsage) warnings.push(badUsage);
        // 用量来自旁路文件时，`usage === null` 还可能是「用量文件被截成 0 字节」：
        // 与「原生没有用量记录」逐字相同，不说就会被当成这条会话真的没有用量
        const sidecar = await usageSidecarProblem(
          source.adapter,
          source.found.ref,
          `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）`,
        );
        if (sidecar) warnings.push(sidecar);
      }
      // 来源 / 目标解析各自捕获：它们都是「读」，让它们落进下面管写入的 catch 会被
      // 说成「并入新内容失败：无权写入」，把读失败讲成写失败、还指向错误的下一步
      // 快照要在 parse 之前取：来源侧没有 TOCTOU 守卫，用户在原生 CLI 里继续说话、
      // 或另一条命令正在追加时，读到的是这一刻的内容，而结果只说「已并入 N 轮」
      srcSnapshot = await snapshotSourceState(source.found.ref.filePath);
      let srcTurns: UnifiedTurn[];
      try {
        srcTurns = await source.adapter.parse(source.found.ref);
      } catch (error) {
        return {
          ok: false,
          error: `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）读取失败：${describeReadFailureOrSelf(error)}；本次未写入任何内容`,
        };
      }
      // 整份来源的上下文差异不随增量裁剪；即使没有新轮次，也不能丢掉这条声明。
      const contextDisclosure = findContextDisclosure(srcTurns);
      if (contextDisclosure) warnings.push(contextDisclosure.summary);
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
      // 目标自身的上下文差异（OpenCode 回退标记 / Pi context_edit / Codex compacted 等）不在
      // 增量里：零增量时结论会变成「内容已全部包含」，不单独读一遍就会把目标的差异盖掉。
      // 两侧同文（同一家、同计数的整份日志披露）只留一条，避免 warnings 里整段重复。
      const targetContextDisclosure = findContextDisclosure(dstTurns);
      if (targetContextDisclosure && !warnings.includes(targetContextDisclosure.summary)) {
        warnings.push(targetContextDisclosure.summary);
      }
      // 解析出 0 轮不代表「这条会话本来就没有内容」：grok / kimi 这类 cwd 不来自文件内容的
      // 适配器会带着一条 0 字节的文件一路走到这里。以前 0 字节来源只得到一句「内容已全部包含在
      // 目标中，无需并入」——看着像一次真的并入，实际来源的历史早就没了。
      const sourceZeroByte = srcTurns.length === 0 ? await zeroByteSessionReason(source.found.ref) : null;
      const targetZeroByte = dstTurns.length === 0 ? await zeroByteSessionReason(target.found.ref) : null;
      if (sourceZeroByte && targetZeroByte) {
        // 两条独立的「0 字节」警告会自相矛盾：一边说目标未被改动、没有可并入的内容，
        // 一边说「本次并入的只有来源的内容」——而来源同样是空的，实际什么都没写。
        warnings.push(
          `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）与目标会话 ${escapeControlChars(targetId)}（${target.adapter.displayName}）` +
            `的文件都是空的（内容已丢失）：这次没有任何可并入的内容，目标也不会被写入——两条会话的历史都需要从各自的备份恢复（Watch 不会替你们重建）`,
        );
      } else {
        if (sourceZeroByte) {
          warnings.push(
            `来源会话 ${source.found.ref.sessionId}（${source.adapter.displayName}）的${sourceZeroByte}；` +
              `这次没有任何可并入的内容，目标会话 ${escapeControlChars(targetId)} 未被改动——如果这条会话本该有内容，先从备份恢复该文件再重试（Watch 不会替你重建历史）`,
          );
        }
        if (targetZeroByte) {
          warnings.push(
            `目标会话 ${escapeControlChars(targetId)}（${target.adapter.displayName}）的${targetZeroByte}；` +
              `它原有的历史已经没了，本次并入的只有来源的内容——如果目标会话本该有内容，先从备份恢复该文件再重试（Watch 不会替你重建历史）`,
          );
        }
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
      // `diffTurns` 按 role + 文本 + callId 对齐：目标已有一段同文本、但没有来源那份思考 /
      // 过程文本的回复时，这一轮被判成「已包含」而跳过——过程事件静默消失，`notes` 还会说
      // 「内容已全部包含」。这条路径不做整份重写（目标格式未必存得下这些事件，且每次
      // `--from` 都会重演一次），但必须披露有多少轮只并入了文本。
      const missingEvents = countPairedTurnsMissingEvents(srcTurns, dstTurns);
      if (missingEvents > 0) {
        warnings.push(
          `目标会话 ${escapeControlChars(targetId)}（${target.adapter.displayName}）已有 ${missingEvents} 轮与来源同文本的回复，` +
            `但缺少来源里的过程事件（思考 / 过程文本 / 工具调用等）：这些轮次按文本对齐被判为「已包含」，对应过程事件不会写进目标` +
            `；需要完整过程记录时可用 watch prompt ${escapeControlChars(from)} --profile full 查看来源原文`,
        );
      }
      // 与 switch 同一口径：附件原始数据不进 round-trip，目标侧不支持时只会静默剩下占位文本
      const attachmentLoss = describeAttachmentLoss(srcTurns, target.adapter);
      if (attachmentLoss) warnings.push(attachmentLoss);
      // 目标就是这条即将 resume 的会话：它自己没收尾要说，与来源那一侧各说各的
      warnResumeTargetUnfinished(dstTurns, `目标会话 ${escapeControlChars(targetId)}（${target.adapter.displayName}）`, outgoing.length, (msg) =>
        warnings.push(msg),
      );
      if (outgoing.length === 0) {
        notes.push(
          sourceZeroByte
            ? `${escapeControlChars(from)} 的会话文件是空的（内容已丢失），没有可并入的内容`
            : `${escapeControlChars(from)} 的内容已全部包含在 ${escapeControlChars(targetId)} 中，无需并入`,
        );
      } else {
        const dedup = dedupeCallEvents(outgoing);
        // 工作目录要在写入之前取：`importTurns` 之后 `target.found` 会换成它返回的 ref
        const sourceCwd = source.found.ref.cwd;
        const targetCwd = target.found.ref.cwd;
        await target.adapter.preflight?.({ ref: target.found.ref, cwd: target.found.ref.cwd });
        const guard = await target.adapter.acquireWriteLock?.({ ref: target.found.ref });
        try {
          await assertTargetUnchanged(target.adapter, target.found.ref, dstDigest, '并入');
          const textLoss = describeTextEventLoss(dedup, target.adapter);
          const newRef = await target.adapter.importTurns(dedup, target.found.ref.cwd, target.found.ref);
          if (textLoss) warnings.push(textLoss);
          merged = dedup.length;
          notes.push(`已把 ${escapeControlChars(from)} 的 ${merged} 轮新内容并入 ${target.adapter.displayName} 会话 ${newRef.sessionId}`);
          // 两个会话记录的工作目录不同：内容来自另一个项目，却写进了这一侧的会话。
          // 项目目录被移动 / 改名时这是对的（旧记录里的 cwd 已失效），但更常见的成因是 id 抄错。
          // 以前这里零披露——`--json` 连 warnings 都没有，用户不会发现自己刚把别处的项目并了进来。
          if (normalizePath(sourceCwd) !== normalizePath(targetCwd)) {
            warnings.push(
              `来源会话 ${escapeControlChars(from)}（${source.adapter.displayName}）记录的工作目录是 ${escapeControlChars(sourceCwd)}，与目标会话 ${escapeControlChars(targetId)} 的 ${escapeControlChars(targetCwd)} 不同：这 ${merged} 轮内容现在在目标那一侧，resume 后会在 ${escapeControlChars(targetCwd)} 里继续` +
                `；若只是抄错了会话 id，先核对来源会话是否本来就该并进来——要把某个会话带到它自己那个目录继续，用 watch open <会话 id> --to <provider>（目标会在来源目录里新建）`,
            );
          }
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
    // 写完了再比一次来源：期间被追加的话，并进去的只是开始那一刻的内容。
    // 只在真的并入了内容时说——一句都没并时这句「并进去的是…」会自相矛盾。
    if (merged > 0) {
      const drift = await describeSourceChangedDuringHandoff(
        source.found.ref.filePath,
        srcSnapshot,
        `${source.found.ref.sessionId}（${source.adapter.displayName}）`,
        '并入',
      );
      if (drift) warnings.push(drift);
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
      // 摘要里的 usage 同样是合计：坏行被跳过时这一项会静默偏少
      const badUsage = await usageBadLinesReason(
        target.adapter,
        target.found.ref,
        `会话 ${target.found.ref.sessionId}（${target.adapter.displayName}）`,
      );
      if (badUsage) warnings.push(badUsage);
      const sidecar = await usageSidecarProblem(
        target.adapter,
        target.found.ref,
        `会话 ${target.found.ref.sessionId}（${target.adapter.displayName}）`,
      );
      if (sidecar) warnings.push(sidecar);
    }
    try {
      const turns = await target.adapter.parse(target.found.ref);
      // 纯打开也会返回 resume 命令，必须携带未完成或上下文差异的完整声明。
      const contextDisclosure = findContextDisclosure(turns);
      if (contextDisclosure) warnings.push(contextDisclosure.summary);
      // 0 轮不一定是「这条会话本来就没内容」（grok / kimi 的 cwd 不来自文件内容，0 字节也能走到这里）：
      // 不探一次，`open` 就会对着一条内容已经丢了的会话打印一条看起来完全正常的 resume
      if (turns.length === 0) {
        const empty = await zeroByteSessionReason(target.found.ref);
        if (empty) {
          warnings.push(
            `会话 ${target.found.ref.sessionId}（${target.adapter.displayName}）的${empty}；` +
              `下面这条 resume 命令虽然能打开它，但历史内容已经没有了——如果它本该有内容，先从备份恢复这个文件（Watch 不会替你重建历史）`,
          );
        }
      }
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

/**
 * 规划失败时把规划阶段收集到的说明（通常是「本地映射库打不开」这类降级原因）附到错误后面。
 *
 * 成功路径一直带 `warnings`（`openInProvider` / `checkOpenInProvider` 都从同一个
 * `diagnostics` 数组取），失败分支却是 `return { ok:false, error: planned.error }`，
 * 整个数组被丢掉：同一个陌生 id、同一份坏库，`watch open <id>` 会说「（本地映射库打不开…）」，
 * `watch open <id> --to codex` 一个字都不提——而后者正是要走映射快路径的那条。
 * 用与 `openSession` 同一格式 `（…；…）`，空数组时原样返回，不多出空括号。
 */
function attachDiagnostics(error: string, diagnostics: string[]): string {
  return diagnostics.length ? `${error}（${diagnostics.join('；')}）` : error;
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
  | {
      ok: true;
      adapter: ProviderAdapter;
      sourceRef: SessionRef;
      sourceProvider: string;
      cwd: string;
      /** 来源快照基线，取在读取来源内容之前；resume 快路径不写文件，用不到但一并带上 */
      sourceSnapshot: SourceStateSnapshot | null;
      plan: OpenPlan;
    }
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
 * **目标**会话是即将被 resume 的那一条（`--from` 并入既有会话、`--to` 复用或链上配对），
 * 可它自己停在做了一半的一轮上时，以前一句都不提——`open <同一个 id>` 单独打开时明明会说
 * （那里 label 是「会话 …（…）」），同一条会话换个入口就两种说法。
 *
 * 判定分两档，都不误报：
 * - 工具调用没有结果：它在会话中途，**这次并入多少轮都不会闭合**，所以一直说；
 * - 最后停在用户消息上：并入增量之后最后一条 turn 已不是它，「最后停在用户消息上」会变成假话，
 *   所以只在这轮**零增量**（也就是「直接打开」）时说。
 *
 * 结尾那句也换掉：这里没有交接发生，说「交接后那一轮不完整」会让人以为刚写进了坏内容。
 */
function warnResumeTargetUnfinished(
  turns: UnifiedTurn[],
  label: string,
  merged: number,
  push: (msg: string) => void,
): void {
  for (const message of describeResumeTargetUnfinished(turns, label, merged)) push(message);
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

/** 链上/复用配对后，提示目标会话同文本轮次里未携带的来源过程事件（与 `--from` 口径一致） */
function warnPairedMissingEvents(
  sourceTurns: UnifiedTurn[],
  targetTurns: UnifiedTurn[],
  targetRef: SessionRef,
  target: ProviderAdapter,
  sourceId: string,
  diagnostics?: string[],
): void {
  const missingEvents = countPairedTurnsMissingEvents(sourceTurns, targetTurns);
  if (missingEvents > 0) {
    diagnostics?.push(
      `目标会话 ${escapeControlChars(targetRef.sessionId)}（${target.displayName}）已有 ${missingEvents} 轮与来源同文本的回复，` +
        `但缺少来源里的过程事件（思考 / 过程文本 / 工具调用等）：这些轮次按文本对齐被判为「已包含」，对应过程事件不会写进目标` +
        `；需要完整过程记录时可用 watch prompt ${escapeControlChars(sourceId)} --profile full 查看来源原文`,
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
  // `resolveById` 内部也会归一，但这条路径的报错要回显 `sourceId`（「未找到来源会话: …」）、
  // 还要拿它去查 `describeChainIdMisuse()`，都得是省掉首尾空白的那个值
  sourceId = trimUserKey(sourceId);
  // 先校验目标 provider：拼错时再怎么说「未找到会话」都跑偏了，
  // 用户会去查会话 id，而不是回头看 --to 的拼写。
  const target = getAdapter(providerId);
  if (!target) return { ok: false, error: unknownProviderMessage(providerId) };
  // 反查失败原因只在「真的没找到」时报；命中了就别拿别家存储的毛病打扰用户
  const lookup: string[] = [];
  const misses: LookupMiss[] = [];
  const source = await resolveById(sourceId, undefined, mapping, undefined, lookup, misses);
  if (!source) {
    const detail = lookup.length ? `（${lookup.join('；')}）` : '';
    // 与 openSession 同理：这条路径也会被链 id 撞上（`open <链 id> --to codex`）
    const chainUse = mapping ? mapping.describeChainIdMisuse(sourceId) : null;
    // 来源那家按 id 命中了文件却读不出来（或压根没查全）时，「未找到来源会话…请确认 id 正确」
    // 是错的第一句：id 往往是对的，要修的是那个文件 / 那个目录
    const headline = lookupMissHeadline('来源会话', sourceId, misses);
    if (headline) {
      return { ok: false, error: `${chainUse ? `${chainUse}；` : ''}${headline}；本次未写入任何内容` };
    }
    // 这是**来源**那一侧：命令还给了 --to <provider>，只说「未找到会话」看不出是哪一侧没找到，
    // 更看不出这次有没有已经往目标写进去（决策顺序里来源先解析，所以确实什么都没写）
    const typo = idTypoHint(mapping, sourceId);
    return {
      ok: false,
      error: `${chainUse ? `${chainUse}；` : ''}未找到来源会话: ${escapeControlChars(sourceId)}${detail}。${typo ? `${typo}。` : ''}请确认 id 正确且该会话属于已安装登录的 CLI；${LOOKUP_NEXT_STEP}。本次未写入任何内容`,
    };
  }
  const cwd = source.found.ref.cwd;
  // 预检与写入都用这个目录：它不在了要提前说，别等用户照着一句必失败的 cd 去执行
  const cwdIssue = await sessionCwdProblem(cwd);
  if (cwdIssue) diagnostics?.push(cwdIssue);
  const sourceRef = source.found.ref;
  const sourceProvider = source.adapter.id;
  // 来源快照基线必须在**任何内容读取之前**取：来源侧没有 TOCTOU 守卫，规划期间用户在原生 CLI
  // 里继续说话、或另一条命令正在追加时，新增轮次既不会转过去、也检测不到。以前这句在
  // `planOpenInProvider` 返回之后才取（规划里已经 parse 过来源），把追加后的状态当成了基线，
  // 写完后比对永远相同；`--from` 那条路径一直是 parse 之前取（见本文件 srcSnapshot 处）。
  const sourceSnapshot = await snapshotSourceState(sourceRef.filePath);
  const base = { ok: true as const, adapter: target, sourceRef, sourceProvider, cwd, sourceSnapshot };

  // 属主即目标：无需转化，直接 resume
  if (sourceProvider === providerId) {
    // 这条快路径要 resume 的就是来源会话自己，可它以前既不解析也不披露：同一条会话改用
    // `open <id>` 单独打开时明明会说「有 N 次工具调用没有结果」，带上 `--to <同一个 provider>`
    // 就变成一句「来源即目标，直接恢复原会话」——用户从 `--check` 到执行都拿不到任何线索。
    // `diagnostics` 同时喂给预检与写入，所以 `--check` 也会提前说。
    try {
      const ownTurns = await source.adapter.parse(sourceRef);
      // 上下文完整性（被转入后台 / Pi context_edit / Codex compacted）是整份日志的差异，
      // 单开 `open <id>` 会披露，这条「来源即目标」的快路径同样不能省——resume 的就是它。
      const ownContext = findContextDisclosure(ownTurns);
      if (ownContext) diagnostics?.push(ownContext.summary);
      // 这条快路径要 resume 的就是来源会话自己：0 轮时同样探一次，否则一条 0 字节的会话
      // 会得到「来源即目标，直接恢复原会话」而没有任何「内容已丢失」的说明
      if (ownTurns.length === 0) {
        const empty = await zeroByteSessionReason(sourceRef);
        if (empty) {
          diagnostics?.push(
            `目标会话 ${sourceRef.sessionId}（${target.displayName}）的${empty}；` +
              `这次要 resume 的就是它，历史内容已经没有了——如果它本该有内容，先从备份恢复这个文件再重试（Watch 不会替你重建历史）`,
          );
        }
      }
      warnResumeTargetUnfinished(ownTurns, `目标会话 ${sourceRef.sessionId}（${target.displayName}）`, 0, (msg) =>
        diagnostics?.push(msg),
      );
    } catch (error) {
      // 解析不了不等于没问题：这次 resume 落在这条会话上，至少要说明「没能确认」
      diagnostics?.push(
        `目标会话 ${sourceRef.sessionId}（${target.displayName}）读取失败：${describeReadFailureOrSelf(error)}；` +
          `无法确认它是否停在做了一半的一轮上（这次要 resume 的就是它）`,
      );
    }
    return { ...base, plan: { kind: 'resume', targetRef: sourceRef, turns: [], merged: 0, snapshot: null } };
  }

  let turns: UnifiedTurn[];
  try {
    turns = await source.adapter.parse(sourceRef);
  } catch (error) {
    // 解析不了来源就没有可转入的内容；按错误返回，别让异常穿透到 openInProvider 的调用方
    return {
      ok: false,
      error: `来源会话 ${escapeControlChars(sourceId)} 读取失败：${describeReadFailureOrSelf(error)}；本次未写入任何内容`,
    };
  }
  // 来源上下文的差异属于整份日志：复用目标时不能让 diffTurns 把披露一起裁掉。
  const contextDisclosure = findContextDisclosure(turns);
  if (contextDisclosure) diagnostics?.push(contextDisclosure.summary);
  // parse 跳过坏行不会报错，round-trip 也比的是解析结果：不扫一遍就会把「少了几轮」当完整转入
  const badSourceLines = await countUnparsableJsonLines(sourceRef.filePath);
  if (badSourceLines > 0) {
    diagnostics?.push(
      `来源会话 ${escapeControlChars(sourceId)} 有 ${badSourceLines} 行无法解析（截断或损坏），已跳过；转入内容可能不完整`,
    );
  }
  const outgoing = dedupeCallEvents(turns);
  // 来源停在做了一半的工具调用上：转入后目标会话在那一轮同样不完整，预检与写入都要说
  warnUnfinishedTurns(
    turns,
    `来源会话 ${escapeControlChars(sourceId)}（${source.adapter.displayName}）`,
    (msg) => diagnostics?.push(msg),
  );
  if (outgoing.length === 0) {
    // 0 字节来源在这句话里曾是同一句「没有可转入的内容」：看不出内容已经丢了，也不说这次
    // 到底有没有写入（确实是零写入，但必须说出来），更不给下一步——而 handoff 那边的同一种
    // 状态从 284 轮起已经会说「0 字节，内容已丢失」+ 两条可照抄的路径。
    const empty = await zeroByteSessionReason(sourceRef);
    const lead = empty
      ? `来源会话 ${escapeControlChars(sourceId)}（${source.adapter.displayName}）的${empty}；没有可转入的内容（0 轮）。` +
        `本次未写入任何内容——如果这条会话本该有内容，先从备份恢复该文件（Watch 不会替你重建历史）再重试`
      : `来源会话 ${escapeControlChars(sourceId)} 没有可转入的内容（0 轮）；本次未写入任何内容`;
    return {
      ok: false,
      error:
        // 「请先另起一条链」在还没有链、或链尾不是这条 0 轮会话时都是错的下一步：
        // `watch new` 自己会建默认链，只有链尾正卡在这条 0 轮会话时才会撞上同一句拒绝（实测）
        `${lead}。要从零在 ${target.displayName} 侧开新会话，直接 watch new ${providerId} 即可（本目录还没有链时会先建一条）；` +
        `若当前链的链尾正是这条 0 轮会话，先 watch chain new <新名字> 再 watch new ${providerId}；` +
        `若 ${target.displayName} 侧已有会话，可用 watch adopt ${providerId} --session <会话 id> 接进来`,
    };
  }

  // 决策 1：来源在链上 → 回链上另一侧配对会话并并入增量；
  // 但目标 provider 的链上「最新配对」不一定对应该输入（同链会分叉出多条线），
  // 必须先做内容校验：配对确实承接了来源主要内容（缺失<一半）才落回，否则退到内容匹配。
  const chainPaired = mapping ? findChainPaired(mapping, sourceProvider, sourceId, providerId, cwd) : null;
  if (chainPaired) {
    let pairTurns: UnifiedTurn[] | null = null;
    // 0 字节的配对目标 parse 会返回 0 轮，delta 等于全部来源轮次，于是静默落进内容复用/新建：
    // 用户只看到「已转入新会话」，不知道链上原本那一条的历史已经没了、链绑定仍指向它。
    const pairedEmpty = await zeroByteSessionReason(chainPaired);
    if (pairedEmpty) {
      diagnostics?.push(
        `链上 ${target.displayName} 会话 ${chainPaired.sessionId} 的${pairedEmpty}；这次不沿用这条空会话（改用内容匹配或新建），` +
          `但链绑定仍指向它——若它本该有内容，先从备份恢复该文件，否则之后的 switch 还会落回这条空会话`,
      );
    } else {
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
    }
    if (pairTurns) {
      const delta = dedupeCallEvents(diffTurns(turns, pairTurns));
      if (delta.length < turns.length / 2) {
        await warnTargetBadLines(chainPaired, target, diagnostics);
        warnPairedMissingEvents(turns, pairTurns, chainPaired, target, sourceId, diagnostics);
        // 复用后 resume 的就是这条会话：它自己的断点要披露，与来源那一侧分开说
        warnResumeTargetUnfinished(
          pairTurns,
          `目标会话 ${chainPaired.sessionId}（${target.displayName}）`,
          delta.length,
          (msg) => diagnostics?.push(msg),
        );
        const pairContext = findContextDisclosure(pairTurns);
        if (pairContext) diagnostics?.push(pairContext.summary);
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
  // 撞上 listSessionsCap 时枚举到的只是「最近 N 个」：更早的会话根本没参与复用匹配，
  // 复用失败不等于「确实没有可复用的」，而后果是多出一份重复会话
  let scanCappedAt = 0;
  const unreadableCandidates: string[] = [];
  if (typeof target.listSessions === 'function') {
    try {
      const sessions = await target.listSessions(cwd);
      const cap = target.listSessionsCap;
      if (cap !== undefined && sessions.length >= cap) scanCappedAt = cap;
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
    warnPairedMissingEvents(turns, destinationTurns, reuse, target, sourceId, diagnostics);
    const delta = dedupeCallEvents(diffTurns(turns, destinationTurns));
    // 复用后 resume 的就是这条会话：目标自己的上下文差异（OpenCode 回退标记等）不属于增量，
    // 零增量时同样要说，否则「内容已全部包含」会成为唯一结论；与来源同文时只留一条。
    const reuseContext = findContextDisclosure(destinationTurns);
    if (reuseContext && !(diagnostics ?? []).includes(reuseContext.summary)) diagnostics?.push(reuseContext.summary);
    // 复用后 resume 的就是这条会话：它自己的断点要披露，与来源那一侧分开说
    warnResumeTargetUnfinished(destinationTurns, `目标会话 ${reuse.sessionId}（${target.displayName}）`, delta.length, (msg) =>
      diagnostics?.push(msg),
    );
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
  // 只在本轮真的会新建时披露：已经复用成功说明上限不影响结论，多喊一句就是假警。
  // 文案要说清「不是没有」，以及后果（多一份会话）——否则「新建」看起来像正常决策。
  if (scanCappedAt > 0) {
    diagnostics?.push(
      `${target.displayName} 在 ${escapeControlChars(cwd)} 的会话已达列表上限 ${scanCappedAt} 个，本次只在最近 ${scanCappedAt} 个里找可复用的既有会话` +
        `（更早的会话没参与匹配，无法确认其中是否已有能承接这些内容的会话）；本次将新建一份，项目里可能因此多出一份重复会话——` +
        `若记得那条会话，可用 watch open <它的会话 id> 直接打开，或先在原生 CLI 里确认后再决定是否删掉这一份`,
    );
  }
  // 同一处后果还有另一半：这一档的会话文件不属于任何目录，`listSessions` 只能跳过它们，
  // 复用扫描根本看不到。与「撞列表上限」同一类（本次要多建一份重复会话），那一档已披露，
  // 这一档以前一个字都不说。
  const hiddenCandidates = unattributablePickWarning(
    await collectUnattributable([target]),
    '目标会话的复用匹配',
    '目标这一侧可能因此多出一份重复会话，而被跳过的那条文件里可能正有能承接这些内容的会话',
  );
  if (hiddenCandidates) diagnostics?.push(hiddenCandidates);
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
  if (!planned.ok) return { ok: false, error: attachDiagnostics(planned.error, diagnostics) };
  const { adapter: target, sourceRef, sourceProvider, cwd, plan, sourceSnapshot: srcSnapshot } = planned;
  // 来源快照的基线在 `planOpenInProvider` 读取来源之前就取好了（见那里的注释）：
  // 这里只负责写完之后再比一次，期间（含规划阶段）被追加的话都能报出来

  const cliBlock = await newSessionCliBlock(target, plan);
  if (cliBlock) {
    return {
      ok: false,
      error: cliBlock.error,
      blocked: { code: cliBlock.code, hint: cliBlock.hint },
      ...(diagnostics.length ? { warnings: [...diagnostics] } : {}),
    };
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
      // 坏行被跳过时这个合计数同样偏少：与 `--to` 的来源侧同一句
      if (source) {
        const badUsage = await usageBadLinesReason(
          source,
          sourceRef,
          `来源会话 ${sourceRef.sessionId}（${source.displayName}）`,
        );
        if (badUsage) warnings.push(badUsage);
        const sidecar = await usageSidecarProblem(
          source,
          sourceRef,
          `来源会话 ${sourceRef.sessionId}（${source.displayName}）`,
        );
        if (sidecar) warnings.push(sidecar);
      }
    }
    if (plan.turns.length > 0) {
      // 附件的原始数据不会进目标：与 `switch` / `--from` 共用一句，避免三处各写一套
      const attachmentLoss = describeAttachmentLoss(plan.turns, target);
      if (attachmentLoss) warnings.push(attachmentLoss);
      const textLoss = describeTextEventLoss(plan.turns, target);
      if (textLoss) warnings.push(textLoss);
    }
    const newRef =
      plan.turns.length > 0 ? await guardedImport(target, plan.targetRef, plan.snapshot, plan.turns, cwd) : plan.targetRef;
    if (!newRef) {
      return {
        ok: false,
        error: '转入目标会话失败: 未获得可用的目标会话引用',
        ...(warnings.length ? { warnings } : {}),
      };
    }
    if (plan.note) notes.push(plan.note);
    // 真的转入了内容才谈得上「转过去的是哪一刻的」：resume 快路径在上面已经返回
    if (plan.turns.length > 0) {
      const drift = await describeSourceChangedDuringHandoff(
        sourceRef.filePath,
        srcSnapshot,
        `${sourceRef.sessionId}（${source?.displayName ?? sourceProvider}）`,
        '转入',
      );
      if (drift) warnings.push(drift);
    }
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
    const msg = blocked ? raw : `转入新会话失败: ${describeWriteFailureReason(error) ?? raw}`;
    return {
      ok: false,
      error: msg,
      ...(blocked ? { blocked } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
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
    const block = cliDetectFailedBlock(target.id, target.displayName, reason);
    return { code: block.code, hint: block.hint ?? '', error: block.message };
  }
  if (available) return undefined;
  // 文案与 new / switch 共用一份：同一件事（CLI 没装）四条写路径不许各说各的
  const block = cliMissingBlock(target.id, target.displayName);
  return { code: block.code, hint: block.hint ?? '', error: block.message };
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
  if (!planned.ok) return { ok: false, error: attachDiagnostics(planned.error, diagnostics) };
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
  // 与执行使用同一份计划和计数；目标预检拒绝写入时，不把它说成内容损失。
  const attachmentLoss = describeAttachmentLoss(plan.turns, target);
  if (attachmentLoss) base.warnings = [...(base.warnings ?? []), attachmentLoss];
  const textLoss = describeTextEventLoss(plan.turns, target);
  if (textLoss) base.warnings = [...(base.warnings ?? []), textLoss];
  return base;
}
