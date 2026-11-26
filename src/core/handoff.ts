import type { ImportTurnsOpts, ProviderAdapter } from '../providers/adapter.js';
import { stat } from 'node:fs/promises';
import type { SessionRef, TokenUsage, UnifiedTurn } from './types.js';
import { chainsElsewhereHint, chainsSameDirectoryHint, describeStoreErrorReason, emptyChainBindHint } from './store.js';
import type { Chain, ChainsElsewhere, Store, SwitchRecord } from './store.js';
import { contentLossField, contextDisclosuresField, type ContextDisclosures, type ContextDisclosuresField, emptySessionsField, sourceUnfinishedField, type SourceUnfinished, targetUnfinishedField, type TargetUnfinished, type TargetUnfinishedField, countAttachmentLoss, countBashControlLoss, countTextEventLoss, countToolFailureLoss, type ContentLoss, dedupeCallEvents, describeAttachmentLoss, describeBashControlLoss, describeTextEventLoss, describeToolFailureLoss, describeDanglingToolCalls, describeUnansweredTail, describeResumeTargetUnfinished, findContextDisclosure, mergeTurns, shouldReplacePairedSession, turnIdentityKey, type EmptySessions } from './rich.js';
import { describeWriteFailureReason, type FileDigest } from './atomic.js';
import { addFinding, type Finding } from './findings.js';
import { describeInferredTimeWrite } from './time.js';
import { escapeControlChars } from './display.js';
import { describeBadLinesScanFailure, describeZeroTurnReason, lineageFromHistory, scanUnparsableJsonLines, unparsableLinesField, zeroTurnResumeClaim, type BadLinesScan, type LineageGraph, type UnparsableLines } from './jsonl.js';
import { usageBadLinesDetail, usageContentBadLinesDetail, usageContentFileProblem, usageSidecarProblem } from './usage-integrity.js';
import { cwdAliasHint, splitElsewhereByDirectory } from './cwd.js';
import { compressedCopy, compressedRetryAdvice, describePathReadFailureReason, describeReadFailureOrSelf, emptySessionFileReasonFromStat, isEmptySessionFileReason, isMissingPathError, probeSessionReadable, sessionFilePresence, type CompressedCopyNote } from './read-text.js';
import { noSessionHint, unknownProviderMessage } from '../providers/registry.js';
import { collectUnattributable, unattributableNoPickMessage, unattributablePickWarning } from './session-coverage.js';
import { sessionIdCommandProblem } from './shell-quote.js';

/** 写回被阻断（如 TOCTOU 检测到目标被外部修改）：一票否决，不产生部分写 */
export class HandoffBlockedError extends Error {
  constructor(
    public code: string,
    message: string,
    /**
     * 覆盖 `blockedHint(code)` 的下一步：同一 `target_missing` 下，「原文件被删」与
     * 「只剩压缩副本（完好 / 0 字节）」的下一步相反，凭 code 分不出来。
     */
    public hint?: string,
    /** 被阻断时已经确认的会话 id（`new` 的链尾不可用等），供 `--json` 直接指认是哪一条 */
    public sessionId?: string,
  ) {
    super(message);
    this.name = 'HandoffBlockedError';
  }
}

/**
 * 来源会话没有可交接的内容（0 字节或解析出 0 轮），本次未写入任何内容。
 *
 * 与 `HandoffBlockedError` 分开：这一档不是「目标不可写」，而是来源本身为空；`--json`
 * 需要带上 `open --to` 同款的 `emptySessions` / `unparsableLines`，脚本不必解析中文。
 */
export class HandoffEmptySourceError extends Error {
  constructor(
    message: string,
    public emptySessions: EmptySessions,
    public unparsableLines?: UnparsableLines,
  ) {
    super(message);
    this.name = 'HandoffEmptySourceError';
  }
}

/** 来源会话读不出来的档位：下一步分别是恢复文件 / 让原生展开副本 / 修权限 / 确认内容 */
export type SourceReadFailureState = 'missing' | 'compressed' | 'denied' | 'unreadable';

/**
 * 来源会话读不出来（`switch` / `new` 的链尾来源），本次未写入任何内容。
 *
 * 与 `HandoffEmptySourceError` 分开——那一档是「读到了但没有内容」，这一档是「根本没读成」；
 * 与 `HandoffBlockedError` 也不同，不是目标不可写。`--json` 需要可机读的档位与文件，
 * 否则脚本只能解析中文才知道该恢复文件、让原生展开副本，还是先修权限。
 */
export class HandoffSourceReadError extends Error {
  readonly sourceReadFailure: Pick<SessionRef, 'provider' | 'sessionId' | 'filePath'> & (
    | { state: Exclude<SourceReadFailureState, 'compressed'> }
    // `intact` 表示非零字节。副本是否可解压仍需由原生客户端确认。
    | { state: 'compressed'; compressedKind: CompressedCopyNote['kind'] }
  );

  constructor(
    message: string,
    { provider, sessionId, filePath }: SessionRef,
    state: Exclude<SourceReadFailureState, 'compressed'>,
    copy?: CompressedCopyNote | null,
  ) {
    super(message);
    this.name = 'HandoffSourceReadError';
    this.sourceReadFailure = copy
      ? { state: 'compressed', provider, sessionId, filePath, compressedKind: copy.kind }
      : { state, provider, sessionId, filePath };
  }
}

function turnKey(t: UnifiedTurn): string {
  return turnIdentityKey(t);
}

/** 写入被拒后给用户的下一步：不同 code 的原因完全不同，不能一句「确认停止写入后重试」包打天下 */
export function blockedHint(code: string): string {
  if (code === 'target_missing') return '目标会话文件已不存在，本次未写入任何内容；请重新选择目标会话。';
  if (code === 'target_unreadable') {
    return '目标会话文件读不出来（多为权限或路径问题），本次未写入任何内容；先确认文件状态再重试。';
  }
  if (code === 'target_changed') return '请确认目标会话已停止写入后重试；本次未写入任何内容。';
  if (code === 'cli_missing') return '未写入任何内容；新建该会话需要本机已安装并登录对应 CLI：装好后先运行一次它，确认能正常启动并完成登录，再重试同一条命令。';
  // 检测本身失败不是「没装」，别让人去重装
  if (code === 'cli_detect_failed') {
    return '未写入任何内容；无法确认目标 CLI 是否可用（检测本身失败），先修好 PATH、权限或客户端配置再重试。';
  }
  return '未写入任何内容；请确认目标会话停止写入后重试。';
}

/**
 * 链上绑定的会话文件已经不可用（被删 / 路径被占 / 读不出来）时的下一步。
 *
 * 这里**不能**建议 `adopt --session <那个 id>`：`adopt` 按原生存储反查会话，
 * 文件没了就反查不到，照抄只会得到「在当前目录找不到会话: <同一个 id>」——
 * 把人送回同一个死胡同（2026-11-08 实测三处提示全部如此，包括刚把真实 id 填进去的那版）。
 * 真能修复绑定的是 `watch switch <provider>`：找不到可沿用的目标会话时会新建一个承接内容
 * 并让链尾跟过去。`adopt` 仍然有用，但只能配**另一个还存在的**会话 id，所以显式标成占位符。
 */
export function rebindHint(provider: string, providerLabel = provider): string {
  return (
    `可先 watch switch ${provider} 重新绑定（找不到可沿用的 ${providerLabel} 会话时会新建一个承接内容）；` +
    `若要用 adopt 指定别的会话，需要那个会话的文件还在：watch adopt ${provider} --session <会话 id>`
  );
}

/**
 * `--chain <活跃但非当前链>` 时的说明（`status` / `usage` / `sessions --chain` 共用）。
 *
 * 归档链早就有自己的警告（「已归档，不再是本目录的当前链」），但**活跃**的非当前链一句都说没有：
 * `chain new A` → `chain new B` 之后当前链是 B，`watch status --chain A` 与 `watch status`
 * 的输出只差一个链名，用户看完 A 接着跑不带 `--chain` 的 `watch switch codex`，以为接在 A 上，
 * 实际写的是 B 的 `switch_events`（2026-11-08 实测：B 的链尾跟过去了、A 原封不动）。
 * 预检与执行之间隔着一条看不见的链，正是本项目反复在修的那一类。
 *
 * 当前链按 `findActiveChain(cwd)` 的判定（活跃链里 last_used_at 最新的一条），与
 * `chain list` 的 `← 当前` 标记同一口径。
 */
export function notCurrentChainWarning(chain: Chain, current: Chain | null): string | null {
  if (chain.status !== 'active') return null; // 归档链有自己那句，不重复
  if (current && current.id === chain.id) return null;
  const currentLabel = current
    ? `当前链是 ${escapeControlChars(current.name)}`
    : '本目录当前没有活跃链（现有链都已归档或还没建链）';
  // 链名是用户输入、历史库里可能有控制字符，拼进终端文案前统一转义（见 display.ts）
  const shown = escapeControlChars(chain.name);
  return (
    `链 ${shown} 不是本目录的当前链（${currentLabel}）；` +
    `不带 --chain 的 status / switch / new / adopt 都作用在当前链上，本次输出的只有 ${shown}——` +
    `要切到它：watch chain use ${shown}`
  );
}

/**
 * 写命令把「当前链」换成另一条时的说明（`switch --chain` / `adopt --chain` / `chain new` 共用）。
 *
 * 「当前链」= 活跃链里 `last_used_at` 最新的一条（`findActiveChain(cwd)` 不带 key，与
 * `chain list` 的 `← 当前` 同一口径）。三条写路径都会经 `touchChain()` 抬高目标链的
 * `last_used_at`（`getOrCreateChainSession()` 命中既有链时 / `createChain()` 建链时），
 * 于是**当前链被静默换走**，而输出只报「已切换 / 已接入 / 已创建链」。
 *
 * `switch <p> --chain A` / `adopt <p> --session <id> --chain A` 尤其该说：用户显式写了
 * `--chain A`，动机恰恰是「这一次操作 A，别动当前链」。实测当前链是 B 时跑完这两条，
 * `chain list` 里 A 变成 `← 当前`，一整段输出一个字都没提（2026-11-08）；此后所有不带
 * `--chain` 的 `switch` / `new` / `adopt` 都作用在 A 上。而只读的 `status --chain A`
 * 早就会警告「链 A 不是本目录的当前链」，写命令反而把它变成当前链却不吭声。
 */
/**
 * `adopt <provider>`（不给 `--session`）在这家于本目录一个会话都没有时的下一步。
 *
 * 以前只回一句「<provider> 未发现可接入的会话」——是事实，但把用户留在原地：既没说要先在
 * 这家开一次会话，也没指出本目录里哪一家**有**会话、可以直接 `adopt`（2026-11-08 实测：
 * 目录里明明躺着一条 claude 会话，codex 这条命令只吐出那一句就 exit 1）。
 *
 * 这里可以放心给具体下一步：各家的 `findLatestSession` 只在「这家在这个 cwd 确实没有会话」
 * 时返回 `null`，读不出来会抛「…但 N 个位置读不出来，无法确认是否存在」走另一条路，
 * 所以不会把读失败讲成「没有会话」。
 *
 * `availableHere` 是别家在本目录真实列出来的 provider（列不出来的一律不计），只用来给一条
 * 能立刻照抄的命令；一家都没有时不给空清单。
 */
export function adoptNoSessionMessage(
  providerId: string,
  availableHere: string[] = [],
  aliasHint: string | null = null,
): string {
  const elseWhere =
    availableHere.length > 0
      ? `本目录现在可接入的有: ${availableHere.join(' / ')}——可直接 watch adopt ${availableHere[0]} --session <会话 id> 接入；`
      : '';
  // 已知 `--cwd` 只是同一个目录的另一种写法时，「若它其实在别的目录」这句是错的方向：
  // 会话不在别处，就在同一个目录的另一个写法下面。换成 realpath 那句，其余照旧。
  const next = aliasHint
    ? `${aliasHint}；换成该路径后仍然没有，再先在该家的原生 CLI 里开一次会话，` +
      `用 watch adopt ${providerId} --session <会话 id> 接入（会话 id 可用 watch sessions 确认）`
    : `要接入 ${providerId}，先在该家的原生 CLI 里开一次会话，再用 watch adopt ${providerId} --session <会话 id> 接入` +
      `（会话 id 可用 watch sessions 或原生 CLI 确认）；若它其实在别的目录，用 --cwd <那个目录> 重跑`;
  return `${providerId} 在这个目录还没有会话（只会接入 cwd 与 --cwd 一致的会话）；${elseWhere}${next}`;
}

/**
 * adopt 接入后「会话文件读不出来 / 只剩压缩副本」这条警告（第 355 轮）。
 *
 * `probeSessionReadable()` 对原路径缺失只会说「会话文件已不存在」，而 adopt 此时已经把链
 * 改绑、用户下一步就是复制它打印的 resume：只剩 `.jsonl.zst` 时文件其实还在（Codex 压缩
 * 闲置线程），下一步是「让原生展开」而不是「修权限」，0 字节副本又是「从备份恢复」——
 * 三档的下一步相反，不能共用一句。与 switch / status / chain list 同口径（第 275–284、349 轮）。
 *
 * 措辞交给调用点拼不行：这三档在 `--json` 的 `warnings` 与文本模式里各出现一次，两处必须
 * 逐字相同；抽成纯函数是为了能按副本档位直接断言（race 场景没法从 CLI 端到端复现）。
 */
export function adoptedSessionReadProblemWarning(
  subject: string,
  readProblem: string,
  copy: CompressedCopyNote | null,
  chainWriteNote: string,
  resumeCommand: string | undefined,
): string {
  // 占位符与同一命令里的空文件分支（cli-main.ts）保持一致：用户刚跑过 watch adopt <provider>，
  // 这里再印一遍具体 provider 只是噪音。
  const switchHint = `用 watch adopt <provider> --session <会话 id> 换成另一条会话`;
  if (!copy) {
    return (
      `${subject}的会话文件现在读不出来：${readProblem}；${chainWriteNote}，本次没有改动会话文件——但 ` +
      `${resumeCommand ? `resume 命令（${resumeCommand}）` : '打开这条会话'}一执行就会失败，先修好这个文件再打开，或${switchHint}`
    );
  }
  // 不承诺 resume 一定失败：副本完好时原生客户端通常会重新展开（`copy.note` 已带这个前提），
  // 展开成功恰恰是用户要的结果；只有 0 字节副本才是内容已丢、resume 打不开。
  return (
    `${subject}的文件${copy.note}；${chainWriteNote}，本次没有改动会话文件——` +
    (copy.kind === 'empty'
      ? `内容已丢失，下面那条 resume 打不开它；只能从备份恢复或重新开一次会话（那是另一条会话），或${switchHint}`
      : `下面那条 resume 交给原生客户端执行，原生通常会把压缩线程重新展开，展开后 Watch 才能读到它——先不要删除或改名副本；` +
        `如果它不是原生压缩（例如你自己归档的副本），resume 会失败，先恢复原文件，或${switchHint}`)
  );
}

/**
 * adopt 接入后解析抛错时那条警告（第 355 轮）。
 *
 * `probeSessionReadable()` 探过「读得出来」，但解析与探测之间文件可能刚好被压缩（Codex
 * 压缩闲置线程）。只报真实错误会说成「文件不可读」，下一步被引成修权限；这里按压缩副本
 * 分档，与 `chainUsage()` / `watch prompt` 的同名分支同一取舍（第 352–353 轮）。
 */
export function adoptedParseFailureWarning(
  sessionId: string,
  copy: CompressedCopyNote | null,
  error: unknown,
): string {
  return (
    `无法确认接进来的会话 ${escapeControlChars(sessionId)} 是否停在做了一半的一轮上：${copy ? copy.note : describeReadFailureOrSelf(error)}；` +
    (copy ? compressedRetryAdvice(copy, '再确认一次') : `resume 之前先确认这个会话文件可读`)
  );
}

/** 别家在本目录确实有会话的 provider；列不出来的一律跳过（这条只是补充说明，不能盖掉主错误） */
async function providersWithSessionsHere(
  cwd: string,
  adapters: ProviderAdapter[],
  exclude: string,
): Promise<string[]> {
  const hits: string[] = [];
  for (const other of adapters) {
    if (other.id === exclude || !other.listSessions) continue;
    try {
      const list = await other.listSessions(cwd);
      if (list.length > 0) hits.push(other.id);
    } catch {
      // 读不出来的那一家不能写成「没有会话」，这里只是不列为可接入项
    }
  }
  return hits;
}

export function currentChainShiftNote(
  previous: Pick<Chain, 'id' | 'name'> | null,
  next: Pick<Chain, 'id' | 'name'> | null,
): string | null {
  if (!previous || !next || previous.id === next.id) return null;
  const from = escapeControlChars(previous.name);
  const to = escapeControlChars(next.name);
  return (
    `当前链已从「${from}」换成「${to}」；` +
    `之后不带 --chain 的 status / switch / new / adopt 都作用在「${to}」上` +
    `（要回到原来那条用 watch chain use ${from}）`
  );
}

/**
 * 链上一条绑定都没有时的下一步（`usage` / `sessions --chain` 共用）。
 *
 * 实现在 `store.ts`：`describeChainIdMisuse()` 也要用同一句，而 `handoff.ts` 本就依赖
 * `store.ts`，反向依赖会成环。这里原样再导出，既有调用点不用改。
 */
export { emptyChainBindHint };

/** Claude / Codex 找不到要追加的目标时会新建会话，并返回不同的 id。 */
export function describeVanishedTarget(into: SessionRef, written: SessionRef, providerName: string): string | null {
  if (written.sessionId === into.sessionId) return null;
  return (
    `目标会话在写入前被移走或删除（原 id ${escapeControlChars(into.sessionId)}），本次改为新建 ${escapeControlChars(providerName)} 会话 ${escapeControlChars(written.sessionId)}；` +
    '新会话只包含这次准备追加的内容，原目标里更早的历史没有并入。若要找回，请检查原文件或备份。'
  );
}

/**
 * `describeVanishedTarget()` 的结构化出口（switch / open --from / open --to 共用）：
 * 目标在写入前被移走，适配器改为新建会话时给 `targetRecreated: { previousSessionId }`。
 * 结果里的 `sessionId` / `newRef` 已经是新会话；这个字段说的是「原本要并入的那条没并成」，
 * 只有中文警告时脚本会把新会话当成既有目标（里面只有这次追加的内容）。id 保留原值，不转义。
 */
export type TargetRecreatedField = { targetRecreated?: { previousSessionId: string } };

export function targetRecreatedField(into: SessionRef | null | undefined, written: SessionRef): TargetRecreatedField {
  if (!into || written.sessionId === into.sessionId) return {};
  return { targetRecreated: { previousSessionId: into.sessionId } };
}

/**
 * `watch new` 空链分支：provider 创建会话时生成的新 ID 无法拼进恢复命令。
 * 此时会话文件已经写入、链记录也可能已写，结果必须说明「写入已经发生」，
 * 不能退成普通的创建失败（用户会以为没有留下任何东西）。
 */
export function describeCreatedSessionWithoutCommand(
  sessionId: string,
  problem: string,
  chainRecordState: 'written' | 'failed' | 'not-attempted',
): string {
  const chainState =
    chainRecordState === 'written' ? '已写入' : chainRecordState === 'failed' ? '写入失败' : '未尝试';
  return (
    `会话已创建 ${escapeControlChars(sessionId)}，但没有生成恢复命令：${problem}；` +
    `这次写入已经发生（链记录${chainState}）——请用 watch sessions 查看该会话`
  );
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
  if (!snapshot) {
    // 快照缺失不等于「没有变化」：适配器根本没有指纹能力时（opencode 走 SQLite 事务）
    // 本来就不在这一层守卫；声明了能力却拿不到快照，必须分清「目标已经不在了」与
    // 「读不出来」——直接放行会让只写权限（0200）、同名目录占位或瞬时 I/O 错误
    // 把整条 TOCTOU 守卫静默跳过。
    if (!adapter.contentFingerprint) return;
    const presence = await sessionFilePresence(ref.filePath);
    // 目标确实不在：写入会新建会话，由调用方的「目标消失」披露路径说明旧历史没并入
    if (presence.state === 'missing') return;
    const detail =
      presence.state === 'unknown'
        ? `文件状态无法确认（${presence.reason}）`
        : presence.isFile
          ? `文件存在但读不出内容（可能是权限或 I/O 问题）：${escapeControlChars(ref.filePath)}`
          : `路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(ref.filePath)}`;
    throw new HandoffBlockedError(
      'target_unreadable',
      `目标会话${detail}；规划时没有取到写前校验用的内容快照，无法确认期间是否被外部修改，已中止本次${action}（未写入任何内容），先确认它可读再重试`,
    );
  }
  const current = (await adapter.contentFingerprint?.(ref)) ?? null;
  if (current && current.sha256 === snapshot.sha256 && current.sizeBytes === snapshot.sizeBytes) return;
  // 指纹消失有两种完全不同的原因：文件被删 / 被移走，或只是读不出来（权限、I/O）。
  // 两种都同样中止写入（fail closed），但「正在被外部写入，请稍后重试」会让用户一直重试
  // 一个永远不会成功的操作——按实际状态分别说，并给出能落地的一步
  if (!current) {
    const presence = await sessionFilePresence(ref.filePath);
    if (presence.state === 'missing') {
      // Codex 压缩过的 rollout：原路径不在、`.jsonl.zst` 在。说成「已不存在」会让人重新绑定，
      // 而会话还在，只是本版不读压缩格式
      const copy = compressedCopy(presence);
      throw new HandoffBlockedError(
        'target_missing',
        copy
          ? `目标会话文件${copy.note}；已中止本次${action}（未写入任何内容）——${compressedRetryAdvice(copy, '再重试')}`
          : `目标会话文件已不存在：${escapeControlChars(ref.filePath)}；已中止本次${action}（未写入任何内容），请重新选择目标会话`,
        copy ? `本次未写入任何内容；${compressedRetryAdvice(copy, '再重试')}，或重新选择目标会话。` : undefined,
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
        `目标会话路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(ref.filePath)}；已中止本次${action}（未写入任何内容），先恢复该路径再重试`,
      );
    }
    throw new HandoffBlockedError(
      'target_unreadable',
      `目标会话文件读不出来（可能是权限或 I/O 问题）：${escapeControlChars(ref.filePath)}；已中止本次${action}（未写入任何内容），先确认它可读再重试`,
    );
  }
  throw new HandoffBlockedError('target_changed', `目标会话正在被外部写入，已中止本次${action}，请稍后重试`);
}

/**
 * 来源侧快照：交接开始时记下文件大小与修改时间，写完之后再比一次。
 *
 * 目标侧有 TOCTOU 守卫（`assertTargetUnchanged`），来源侧一直只是「读一次」。用户在原生 CLI 里
 * 继续对话、或另一条命令正往这条会话追加时，读到的是开始那一刻的内容，而结果只说「已从 X 交接
 * → Y（N 轮）」——读者会当成整条会话都搬过去了。这里**不拦截**（内容已经写进去、不该回滚），
 * 只把「差了一段」说出来，并给出能落地的一步：再执行一次同一条命令，`diffTurns` 会把新增部分
 * 当增量补上。
 *
 * 用 stat 而不是内容指纹：这里只需要「有没有变」，不必证明内容一定不同，省一次全文件读取。
 * 代价是同一时间戳精度内等长改写会漏报——漏报只是少一句提示，不会说出错的结论。
 *
 * 但 `stat` **失败**时不能沿用「漏报只是少一句话」：读取后文件被删 / 被目录占住 / 权限变了，
 * 这一档连「有没有变」都不知道，静默等于向读者断言「没变过」。三态由 `probeSourceState()`
 * 区分，`sourceChangeSince()` 把「量不出来」单独成档并给出原因。
 */
export type SourceStateSnapshot = { size: number; mtimeMs: number };

/** stat 来源文件的三态：ok / 现在不存在 / 量不出来（权限、I/O、被同名目录占住） */
export type SourceStateProbe =
  | { state: 'ok'; snapshot: SourceStateSnapshot }
  | { state: 'missing'; reason: string }
  | { state: 'unreadable'; reason: string };

export async function probeSourceState(filePath: string): Promise<SourceStateProbe> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      return { state: 'unreadable', reason: '它现在不是普通文件（被同名目录或设备文件占住了）' };
    }
    return { state: 'ok', snapshot: { size: st.size, mtimeMs: st.mtimeMs } };
  } catch (error) {
    const reason = describePathReadFailureReason(error);
    return isMissingPathError(error)
      ? { state: 'missing', reason: `它现在不存在了：${reason}` }
      : { state: 'unreadable', reason: `读不出它的文件状态：${reason}` };
  }
}

export async function snapshotSourceState(filePath: string): Promise<SourceStateSnapshot | null> {
  const probe = await probeSourceState(filePath);
  return probe.state === 'ok' ? probe.snapshot : null;
}

/** 结构化来源漂移：只有 stat 得到的字节数与方向，不含会话正文 */
export type SourceChangeSince = { from: number; to: number; growth: boolean };

/**
 * 来源文件在读取前后有没有变。**「量不出来」是独立一档，不是「没有变化」**：
 * 读取后来源被删、被换成目录、或权限变了时 stat 会失败，旧实现 `return null`
 * 把这一档和「逐字节相同」压成同一个结论，结果只说「已交接 N 轮」——
 * 读者会当成期间没有被写入。这里不猜方向（不编造 growth），只把「没量成」说清楚。
 */
export type SourceChangeProbe =
  | ({ kind: 'changed' } & SourceChangeSince)
  | { kind: 'unchanged' }
  | { kind: 'unverifiable'; reason: string };

export async function sourceChangeSince(
  filePath: string,
  before: SourceStateSnapshot | null,
): Promise<SourceChangeProbe> {
  if (!before) {
    return {
      kind: 'unverifiable',
      reason: '读取前没能取到它的文件状态（可能是权限、I/O 问题，或它当时已经不在）',
    };
  }
  const after = await probeSourceState(filePath);
  if (after.state !== 'ok') {
    return { kind: 'unverifiable', reason: `读取后再量时${after.reason}` };
  }
  const { size, mtimeMs } = after.snapshot;
  if (size === before.size && mtimeMs === before.mtimeMs) return { kind: 'unchanged' };
  return { kind: 'changed', from: before.size, to: size, growth: size > before.size };
}

/**
 * `--json` 的结构化出口（switch / open --from / open --to / prompt 共用，字段同名同形状）：
 * - `sourceDrift`：期间被写入过，给出 stat 得到的字节数与方向；
 * - `sourceDriftUnknown`：量不出来（读取后被删 / 被换 / 权限变了），附原因。
 * 未变化、或这次根本没交接内容时两个字段都不出现——只有中文警告的话，脚本与桌面端分不出
 * 「没变」和「变化没有带上」。
 */
export type SourceDriftFields = {
  sourceDrift?: SourceChangeSince;
  sourceDriftUnknown?: string;
};

export function sourceDriftFields(change: SourceChangeProbe): SourceDriftFields {
  if (change.kind === 'changed') {
    return { sourceDrift: { from: change.from, to: change.to, growth: change.growth } };
  }
  if (change.kind === 'unverifiable') return { sourceDriftUnknown: change.reason };
  return {};
}

export async function describeSourceChangedDuringHandoff(
  filePath: string,
  before: SourceStateSnapshot | null,
  label: string,
  action = '交接',
  change?: SourceChangeProbe,
): Promise<string | null> {
  // 调用方已经量过一次时复用同一份结论：再量一次可能得到不同结果，
  // 于是 `--json` 的结构化字段与警告各说一套（与 describeSourceChangedDuringPrompt 同一条）。
  const actual = change ?? (await sourceChangeSince(filePath, before));
  if (actual.kind === 'unchanged') return null;
  if (actual.kind === 'unverifiable') {
    return (
      `无法确认来源会话 ${label} 在这次${action}期间有没有被写入（${actual.reason}）：` +
      '转过去的是开始读取时的内容，之后若有新增记录不会带上——先确认来源文件仍在且可读，再执行一次同一条命令核对'
    );
  }
  const { from, to, growth } = actual;
  // 增长与改写/截断的下一步不一样：前者再执行一次就能补齐；后者要先确认文件本身没坏
  // （内容变了的那部分不会被 diff 当成增量，重跑也补不回来）
  if (growth) {
    return (
      `来源会话 ${label} 在这次${action}期间被写入过（${from} → ${to} 字节，新增约 ${to - from} 字节）：` +
      `转过去的是开始读取时的内容，之后新增的记录没有带上——再执行一次同一条命令会把新增部分作为增量补齐`
    );
  }
  const detail = to < from ? `少了约 ${from - to} 字节` : '内容被改写（大小不变）';
  return (
    `来源会话 ${label} 在这次${action}期间被写入过（${from} → ${to} 字节，${detail}）：` +
    `转过去的是读取时看到的内容；先确认来源文件没有被损坏，再重新执行同一条命令（被改写的那部分不会被当成增量补齐）`
  );
}

/**
 * `watch prompt` 的对应说法：这条路径**不写**任何文件，所以没有「增量补齐」这一步——
 * 重跑只是按更新后的记录重渲染一份新文档，已经复制走的那份不会被修正。
 * 文档会被复制进别家助手，那里没有 stderr，所以这句话必须进正文。
 */
export async function describeSourceChangedDuringPrompt(
  filePath: string,
  before: SourceStateSnapshot | null,
  label: string,
  change?: SourceChangeProbe,
): Promise<string | null> {
  // 调用方已经量过一次时复用同一份结论：再量一次可能得到不同结果，
  // 于是 `--json` 的结构化字段与正文各说一套。undefined 才表示「这里自己量」。
  const actual = change === undefined ? await sourceChangeSince(filePath, before) : change;
  if (actual.kind === 'unchanged') return null;
  if (actual.kind === 'unverifiable') {
    // 量不出来同样是「不能确认」，不能在文档里留白让读者当成没变过
    return `来源会话 ${label} 在读取前后的文件状态无法核对（${actual.reason}），无法确认正文是否已包含全部记录。` +
      '如需核对当前记录，请重新执行一次 watch prompt；已生成的文档不会更新。';
  }
  const { from, to, growth } = actual;
  const prefix = `来源会话 ${label} 在读取前后的文件状态有变化（${from} → ${to} 字节`;
  if (growth) {
    return `${prefix}，增加了 ${to - from} 字节），无法确认正文已包含哪些新增记录。` +
      '重新执行一次 watch prompt 会按当时读到的记录重渲染，已生成的文档不会更新。';
  }
  if (to < from) {
    return `${prefix}，减少了 ${from - to} 字节），正文可能与当前记录不同。` +
      '先核对来源文件，再用 watch prompt 重新生成。若旧记录已丢失，重渲染无法恢复。';
  }
  // 大小相同只说明 mtime 变了，单独调整时间戳也会触发。
  return `${prefix}，修改时间变化），仅凭文件状态无法确认内容是否变化。` +
    '如需核对当前记录，请重新执行 watch prompt。';
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

/**
 * `recordSwitch()` 失败时的警告文案。
 *
 * `getOrCreateChainSession()` 与 `recordSwitch()` 是两次独立提交：空库上第一条链由前者
 * 建出来并已落库，后者再失败时，库里已经多了一条没有任何切换记录的链——旧文案只说
 * 「链记录失败」，用户 `chain list` 时凭空看到一条「默认」，会以为是自己弄坏的。
 * 失败后只读地确认一次：链在、且没有任何切换记录时，把这件事说出来。
 */
function chainRecordFailureWarning(store: Store, cwd: string, chainId: string | undefined, error: unknown): string {
  const reason = describeStoreErrorReason(error);
  let emptyChain: string | null = null;
  try {
    const chain = store.findActiveChain(cwd, chainId);
    if (chain && store.listSwitchEvents(chain.id).length === 0) emptyChain = chain.name;
  } catch {
    // 链状态本身也读不出来：真正的原因已在 reason 里，不再叠第二句
  }
  if (!emptyChain) return `链记录失败: ${reason}`;
  return (
    `链记录失败: ${reason}；链「${escapeControlChars(emptyChain)}」本身已经在本地库里（建链是单独一次提交），` +
    `但这条链上没有任何切换记录——本次切换没有记到链上（链尾没有切换）；重跑同一条命令即可补上`
  );
}

/** 把 provider 指定会话（缺省取 mtime 最新）接入链：链上该 provider 的绑定替换为该会话 */
export async function adoptIntoChain(
  providerId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  targetRef?: SessionRef,
  chainId?: string,
  storeError?: string,
): Promise<{
  adoptedRef: SessionRef;
  replacedRef: SessionRef | null;
  warnings: string[];
  /** 该会话在本次之前就已经绑在链上：目标状态已成立，没有写入任何链记录 */
  unchanged?: boolean;
  /** `unchanged` 时的结果说明，或接入时说明接入的会话是自动挑的（走 stdout；与 `warnings` 的降级原因分开） */
  note?: string;
  /** 该会话解析出 0 轮时对文件的坏行扫描（与调用方的 0 轮警告同一次扫描）；健康会话缺省 */
  unparsableLines?: UnparsableLines;
  /** 接入时这条会话本身是空的（0 字节或解析出 0 轮），与对应警告同一处判定；有内容时缺省 */
  emptySessions?: EmptySessions;
  /**
   * 这次有没有把链绑定 / 切换记录写进去（同 `HandoffResult.chainRecordState`）：
   * `unchanged`、本地库不可用都是 not-attempted，`recordSwitch` 抛错是 failed。
   * 调用方不得在 failed / not-attempted 时说「链记录已写入」。内部协调字段，不进 `--json`。
   */
  chainRecordState?: 'written' | 'failed' | 'not-attempted';
}> {
  const warnings: string[] = [];
  const adapter = adapters.find((a) => a.id === providerId);
  if (!adapter?.findLatestSession) throw new Error(unknownProviderMessage(providerId, adapters));
  // 归档链以前要等 recordSwitch 才被拒绝，而那时已返回 adoptedRef：用户看到 ok:true，
  // 链上却什么都没写，警告还被包装成「库操作失败」引去查库。原因这里就能确定，先拒绝
  if (store && chainId) {
    const archived = store.archivedChainName(cwd, chainId);
    if (archived) {
      // archivedChainName() 已经转义过链名（见其注释），这里不再二次转义
      throw new Error(`链已归档: ${archived}；可 watch chain use ${archived} 恢复，或省略 --chain 用当前链`);
    }
  }
  // 没有 --session 时按 mtime 挑「最新会话」。这条兜底路径以前会**静默改绑**：
  // 同目录另一条链刚聊过的会话更新，`adopt claude --chain 默认` 就会把默认链的绑定
  // 换成别条链的会话（2026-11-08 实测 `chain list` 里两条链从此指向同一个 id），
  // 而 `replacedRef` 只写「替换了: <id>」，用户看不出那条会话根本不是自己指定的。
  const autoPicked = !targetRef;
  const found: { ref: SessionRef; warnings?: string[] } | null = targetRef
    ? { ref: targetRef }
    : await adapter.findLatestSession(cwd);
  if (!found) {
    // 这一家里「可列出的会话」是 0，但磁盘上可能还有**读不出目录归属**的会话文件
    // （Codex 的 `session_meta` 首行 0 字节 / 半截 JSON）：`findLatestSession` 只能跳过它们，
    // 于是照 `adoptNoSessionMessage()` 说「在这个目录还没有会话」就是一句假结论，
    // 与 `sessions` / `doctor` 早已披露的 unattributable 自相矛盾。
    const hiddenStats = await collectUnattributable([adapter]);
    const hiddenNote = unattributableNoPickMessage(hiddenStats);
    const available = await providersWithSessionsHere(cwd, adapters, providerId);
    const others = available.length
      ? `；本目录现在可列出的有: ${available.join(' / ')}——可直接 watch adopt ${available[0]} --session <会话 id> 接入`
      : '';
    if (hiddenNote) {
      // 下一步按结构化原因分档，不靠匹配 advice 文案：压缩副本要先让原生展开、
      // 0 字节副本只能备份恢复、坏首行要先恢复；三者都不能直接说「用 adopt --session 接入」。
      // 混合档保留「或开一条新的」备选；只有完好压缩副本时那条是相反指引（新会话不会展开原会话）。
      const kinds = new Set(hiddenStats.flatMap((st) => st.kinds ?? []));
      const compressed = kinds.has('compressed');
      const compressedEmpty = kinds.has('compressed-empty');
      const empty = kinds.has('empty');
      const damaged = kinds.has('damaged');
      // 0 字节未压缩 / 压缩副本的内容都已丢，下一步同样是备份恢复（或另开新会话），
      // 不能沿用坏首行那种「先确认是否截断、修好后接入」的说法。
      const lost = compressedEmpty || empty;
      // 0 字节压缩副本内容已丢：能做的只有从备份恢复（或放弃它、另开新会话），
      // 不能沿用「展开后」——展开一个 0 字节副本拿不回任何内容。
      const recovery = compressed
        ? damaged || lost
          ? '恢复或展开后'
          : '展开后'
        : lost
          ? damaged
            ? '恢复或重开会话后'
            : '从备份恢复后'
          : damaged
            ? '恢复后'
            : '按上面的建议处理后再';
      throw new Error(
        `${hiddenNote}；${recovery}确认是你要的那条，用 watch adopt ${providerId} --session <会话 id> 接入` +
          (compressed && !damaged ? '' : '；或先在原生 CLI 里开一次新会话，再用 watch adopt 把它接入') +
          others,
      );
    }
    // 「这家在这个目录没有会话」同样可能只是 `--cwd` 的写法不同：会话文件在，
    // 只是按另一条路径字符串记录着。这时让人「先开一次会话」会白开一个。
    const alias = await cwdAliasHint(cwd);
    throw new Error(adoptNoSessionMessage(providerId, available, alias));
  }

  // 「按修改时间最新的会话」这句话只在**所有会话都读得出归属**时成立：这一档的文件不属于
  // 任何目录，`findLatestSession` 只能跳过，于是挑出来的是「在能读出的那些里最新」。
  // 2026-11-09 实测（隔离 HOME，codex 一条 10:00 的健康 rollout + 一条 11:00 被截成 0 字节的）：
  // `adopt codex` 接入了 10:00 那条，note 却写着「本次是按修改时间挑的最新会话 5677…」，
  // `warnings` 一个字都不提被跳过的那条——而同一状态下 `sessions` 已经带出 unattributable
  // 与点名路径的警告。自动挑选是在替用户做选择，说错就等于让他接错会话。
  const selectionWarnings = found.warnings ?? [];
  warnings.push(...selectionWarnings);
  const hiddenPicks = autoPicked ? await collectUnattributable([adapter]) : [];
  const pickedLabel = hiddenPicks.length || selectionWarnings.length ? '在能读出的会话里按修改时间最新' : '按修改时间最新';
  if (autoPicked) {
    const pickWarning = unattributablePickWarning(
      hiddenPicks,
      '自动挑的会话',
      '你要接的可能正是被跳过的那一条（用 --session 显式指定会话 id 可以避开这种挑选）',
    );
    if (pickWarning) warnings.push(pickWarning);
  }

  let history: SwitchRecord[] = [];
  let historyFailed = false;
  if (!store) {
    // 库打不开时接入仍然完成，但没有链记录：下次 switch 不会认这条绑定，必须说明。
    // 原因同样要带出（`storeError` 来自 `cli-main.ts` 的 `lastStoreError`）：只说「库不可用」
    // 时用户不知道该修权限、修路径还是换 WATCH_DB，而原因里本来就带着路径与下一步。
    warnings.push(storeUnavailableWarning('本次接入未写入链记录（后续切换不会认同这条绑定）', storeError));
  }
  if (store) {
    try {
      const id = store.findActiveChain(cwd, chainId)?.id ?? null;
      if (chainId && !id) throw new Error(store.missingChainMessage(cwd, chainId));
      history = id ? store.listSwitchEvents(id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
      history = [];
      historyFailed = true;
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  }
  // 历史读不出来时，`replaced` 必为 null，下面「自动挑的会话不得静默改绑」的守卫会失效：
  // 链上原本绑着谁已无从得知，按 mtime 挑出来的会话可能属于另一条链或另一段工作。
  // 显式给了 --session 才放行（那是用户自己的选择），并保留上面那条读取失败警告。
  if (historyFailed && autoPicked) {
    throw new Error(
      `链历史读取失败，无法确认链上 ${providerId} 当前绑定的会话；未指定 --session 时不会按最新会话自动改绑（本次未写入任何内容）。` +
        `请用 watch adopt ${providerId} --session <会话 id> 显式指定要接入的会话，或修好本地库后重试`,
    );
  }
  // 「这家已经绑着这个会话」只看 `toRef` 是不够的：`switch codex` 之后 claude 的绑定留在
  // `fromRef` 上（链上每个 provider 只有一个会话），旧判据会把这种情况当成一次真的换绑，
  // `recordSwitch` 于是写下 `claude → claude`（`fromRef` 与 `toRef` 是同一个会话）的自指记录
  // 并成为链尾（2026-11-08 实测：`new claude` → `chain new A` → `switch codex --chain A`
  // → `adopt claude --chain A` 得到 `replacedRef` 与 `adoptedRef` 完全相同的 JSON，
  // 文本模式印「替换了: <和上一行一样的 id>」）。判据是「这家**当前**绑的就是它」，
  // 用 `pairedRef()`：它按整条历史取最后一次出现，正好等于链上这一家的当前绑定。
  // 不能改成「历史上出现过就算」——`adopt <provider> --session <更早的会话>` 正是
  // `new` 的报错里给出的换绑办法，那条更早的会话通常以 `fromRef` 出现过。
  const currentBinding = pairedRef(history, providerId);
  const bound = currentBinding?.sessionId === found.ref.sessionId;
  // cmdAdopt 会为实际返回的会话生成恢复命令；拒绝须早于建链、改绑和写切换记录。
  // 自动挑到另一条会话时会保留原绑定，因此校验返回的绑定，不按被放弃的候选误拒绝。
  // 拒绝时不能只抛适配器守卫的短句：这里还没有任何副作用，要说清「没有写入」与换绑路径
  //（与 `watch new` / `watch switch` 的只读分支同一口径，第 608 轮）。
  const adoptTarget = autoPicked && currentBinding ? currentBinding : found.ref;
  const adoptProblem = sessionIdCommandProblem(adoptTarget.sessionId);
  if (adoptProblem) {
    throw new Error(
      `无法接入 ${providerId} 的会话 ${escapeControlChars(adoptTarget.sessionId)}：${adoptProblem}；` +
        `本次未写入任何内容（会话文件与链记录都没有改动）——` +
        (autoPicked ? '这次未指定 --session，是自动挑到了它；' : '') +
        `用 watch sessions 查看可接入的会话，再用 watch adopt ${providerId} --session <会话 id> 显式指定`,
    );
  }
  if (bound) {
    // 目标状态本来就成立（这家已经绑着这个会话）——这是空操作，不是失败。以前一律抛
    // 「该会话已在链上，无需接入」让 cmdAdopt 以 exit 1 结束：脚本会把空操作当接入失败，
    // 而 `chain rename <同名>` / `chain archive <已归档>` 早就是 `unchanged:true` 的成功返回。
    //
    // 更常见的问题是这句话在**链尾停在另一家**时误导人：此时 adopt 的动机几乎都是
    // 「让这一家重新成为当前一侧」，而真正能做这件事的是 `watch switch <provider>`
    // （会复用这条已绑定的会话，不新建）。只回「无需接入」，用户再试几遍还是同一句。
    const tail = history.at(-1);
    const tipElsewhere = tail && tail.toProvider !== providerId;
    // 这条会话是「按 mtime 挑出来的」，不是用户指定的：note 里那句「没有需要改动的地方」
    // 只在用户确实想接它时成立。说明它是自动挑的，并给出显式写法，用户才有机会纠正。
    const autoPickedNote = autoPicked
      ? `未指定 --session，本次自动挑的是${pickedLabel}的会话 ${escapeControlChars(found.ref.sessionId)}；要接入指定会话请用 watch adopt ${providerId} --session <会话 id>`
      : '';
    const note = tipElsewhere
      ? `会话 ${escapeControlChars(found.ref.sessionId)} 已经在链上（${providerId} 这一侧绑定的就是它），本次没有写入任何链记录；` +
        `当前链尾停在 ${tail.toProvider}（${escapeControlChars(tail.toRef.sessionId)}），要让 ${providerId} 重新成为当前一侧请用 watch switch ${providerId}（会复用这条会话，不新建）`
      : `会话 ${escapeControlChars(found.ref.sessionId)} 已经在链上，本次没有写入任何链记录（没有需要改动的地方）`;
    // 这是结果说明而不是降级原因（链记录没有写失败，是本来就不需要写），所以走 note：
    // 文本模式打到 stdout，与 `warnings`（stderr，真正的降级）分开
    return {
      adoptedRef: found.ref,
      replacedRef: null,
      warnings,
      unchanged: true,
      // 空操作：本次没有写任何链记录，调用方不得说「链记录已写入」
      chainRecordState: 'not-attempted',
      note: autoPickedNote ? `${note}；${autoPickedNote}` : note,
    };
  }

  let replaced: SessionRef | null = currentBinding;
  // 没指定 --session、而链上这一家已经绑着另一个会话：这是**静默改绑**，不能做。
  // 同目录另一条链刚聊过的会话更新时，`adopt claude --chain 默认` 会把默认链的绑定换成
  // 别条链的会话（2026-11-08 实测 `chain list` 里两条链从此指向同一个 id），而输出只说
  // 「替换了: <id>」，用户看不出换上去的那条根本没被自己指定过。链只按 cwd 分组，
  // 「最新」与「这条链上的」是两件事。想要换绑就显式给 --session，让选择可见。
  if (autoPicked && replaced) {
    const autoPickedNote =
      `未指定 --session，本次自动挑的是${pickedLabel}的会话 ${escapeControlChars(found.ref.sessionId)}；` +
      `但链上 ${providerId} 这一侧现在绑的是 ${escapeControlChars(replaced.sessionId)}，本次没有改动它（自动挑的会话可能属于另一条链或另一段工作）；` +
      `确实要换成自动挑到的这一条请用 watch adopt ${providerId} --session ${escapeControlChars(found.ref.sessionId)}`;
    return {
      adoptedRef: replaced,
      replacedRef: null,
      warnings,
      unchanged: true,
      // 自动挑到的会话与链上绑定不一致，本次没有改动：同样没写链记录
      chainRecordState: 'not-attempted',
      note: autoPickedNote,
    };
  }
  const otherBound = (() => {
    let r: SessionRef | null = null;
    for (const h of history) {
      if (h.fromProvider !== providerId && h.fromRef) r = h.fromRef;
      if (h.toProvider !== providerId && h.toRef) r = h.toRef;
    }
    return r;
  })();

  let chainRecordState: 'written' | 'failed' | 'not-attempted' = 'not-attempted';
  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, chainId);
      // `otherBound` 是另一家的会话：`fromProvider` 必须跟着 ref 走，否则会写下
      // 「codex → codex、fromRef 却是 claude 会话」的自指记录，链配对从此对不上。
      let replacedFrom = providerId;
      if (!replaced && otherBound) {
        replaced = otherBound;
        replacedFrom = otherBound.provider;
      }
      store.recordSwitch(id, replacedFrom, replaced, providerId, found.ref);
      chainRecordState = 'written';
    } catch (error) {
      // 不直接转储 Error 对象：堆栈与英文 errstr 在 `--json` 下只会干扰，
      // 真原因（含触发器 RAISE 的文案）已由 describeStoreErrorReason 翻进警告
      chainRecordState = 'failed';
      warnings.push(chainRecordFailureWarning(store, cwd, chainId, error));
    }
  }
  // 链上这一家原本没绑会话时仍然接入「最新会话」（这是 adopt 的既定语义），
  // 但必须披露它是自动挑的：--json 里只有 id，文本模式也只有一串 uuid，
  // 用户很容易把「挑中的那条」当成自己指定的那条。
  const note = autoPicked
    ? `未指定 --session，本次挑的是${pickedLabel}的会话 ${escapeControlChars(found.ref.sessionId)}；要接入指定会话请用 watch adopt ${providerId} --session <会话 id>`
    : undefined;
  return { adoptedRef: found.ref, replacedRef: replaced, warnings, chainRecordState, ...(note ? { note } : {}) };
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
    // 「直接 resume 即可」只在链尾文件真的还在时成立。文件被删 / 被同名目录占住 / 读不出来时
    // 照旧这么说，用户会在原生 CLI 里撞一个更含糊的错误；同一条链上 `switch` 早就分三档说清了。
    // `new` 在链尾已是同一家时并未写盘，但文件不可用与「健康、可直接 resume」是两种结论；
    // 前四档沿用 blocked 通道，让 --json 的 blocked / code / sessionId 与 switch 同口径。
    const tipId = tail.toRef.sessionId;
    const tipBlocked = (code: string, message: string, hint: string): never => {
      throw new HandoffBlockedError(code, message, hint, tipId);
    };
    const tipPresence = await sessionFilePresence(tail.toRef.filePath);
    const compressedTip = compressedCopy(tipPresence);
    if (compressedTip) {
      // 0 字节副本不能沿用「重新开一次会话再重试」：链尾仍指向这条副本，重试会再次撞上同一处；
      // 只能备份恢复后再试，或另起一条链。完好副本则先让原生展开。
      tipBlocked(
        'target_missing',
        `链尾已是 ${providerId}，但链尾会话 ${escapeControlChars(tipId)} 的文件${compressedTip.note}；` +
          (compressedTip.kind === 'empty'
            ? `本次无法交接也无法 resume——从备份恢复后再试，或用 watch chain new <新名字> 另起一条链`
            : `本次无法交接也无法 resume——${compressedTip.advice}，再重试，或用 watch chain new <新名字> 另起一条链`),
        compressedTip.kind === 'empty'
          ? '本次未写入任何内容；0 字节压缩副本无法恢复内容，从备份恢复或另起一条链。'
          : '本次未写入任何内容；先让原生客户端重新展开该会话，再重试同一条命令。',
      );
    }
    const broken =
      tipPresence.state === 'missing'
        ? '文件已不存在'
        : tipPresence.state === 'unknown'
          ? `状态无法确认：${tipPresence.reason}`
          : !tipPresence.isFile
            ? '的路径现在不是普通文件（被同名目录或设备文件占住了）'
            : null;
    if (broken) {
      tipBlocked(
        tipPresence.state === 'missing' ? 'target_missing' : 'target_unreadable',
        `链尾已是 ${providerId}，但链尾会话 ${escapeControlChars(tipId)} ${broken}：${escapeControlChars(tail.toRef.filePath)}；` +
          `本次无法交接也无法 resume——可先恢复该文件，或用 watch chain new <新名字> 另起一条链`,
        tipPresence.state === 'missing'
          ? `本次未写入任何内容。可从备份恢复原文件，用 watch adopt ${providerId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链。`
          : '本次未写入任何内容；先恢复该路径（权限或同名目录占位），或 watch chain new <新名字> 另起一条链。',
      );
    }
    // `stat` 成功不等于读得出来：`chmod 000` 的文件 `stat` 照常返回，上面三档全过，
    // 于是这里告诉用户「直接 resume 即可」，而 resume 一打开就失败。同一状态下
    // `sessions` 会说「open / switch 读这条会话时同样会失败」、`open` 会说「找到了，但读不出来」。
    const readProblem = await probeSessionReadable(tail.toRef.filePath);
    if (readProblem) {
      // 0 字节不是权限问题：内容已经没了，让人去「修好这个文件」只会白查一遍权限
      const emptyTip = isEmptySessionFileReason(readProblem);
      tipBlocked(
        'target_unreadable',
        emptyTip
          ? `链尾已是 ${providerId}，但链尾会话 ${escapeControlChars(tipId)} 的文件是空的：${readProblem}；` +
            `resume 没有内容可恢复，本次没有新建会话——先从备份恢复该文件（Watch 不会替你重建历史）；` +
            `若这个会话不再需要，用 watch chain new <新名字> 另起一条链后再 watch new ${providerId}`
          : `链尾已是 ${providerId}，但链尾会话 ${escapeControlChars(tipId)} 的文件现在读不出来：${readProblem}；` +
            `resume 会失败，本次没有新建会话——先修好这个文件（权限或内容）；` +
            `若这个会话不再需要，用 watch chain new <新名字> 另起一条链后再 watch new ${providerId}`,
        emptyTip
          ? '本次未写入任何内容；先从备份恢复链尾文件（Watch 不会替你重建历史），或另起一条链。'
          : '本次未写入任何内容；先修好链尾文件的权限或内容，或另起一条链。',
      );
    }
    // 「直接 resume 即可」还隐含一个前提：这条会话本身是收尾的。同一条会话改用 `open <id>`
    // 单独打开、或用 `switch <同一家>` 时都会说「有 N 次工具调用没有结果」/「最后停在用户消息上」，
    // 只有 `new` 什么都不看——而且连会话 id 都不给（用户还得再跑一次 `watch status` 才找得到）。
    // 解析失败也不能当成「没问题」：`probeSessionReadable` 只证明打得开，不代表读得出内容。
    const tipAdapter = resolve(providerId);
    let tipUnfinished: string[] = [];
    // 「直接 resume 即可」还隐含第二个前提：这条会话有内容。`watch new codex` / `watch new grok`
    // 建出来的合法空会话与「内容被清空、只剩占位头」都解析出 0 轮、文件却可读，以前照样建议
    // resume——用户打开进去什么也没有，而 `open <同一个 id>` / `switch <同一家>` 从 v0.1.84/86
    // 起都已在说这件事。解析失败（读不出内容）走下面的 tipUnfinished，不猜轮数。
    let tipEmpty = false;
    let tipEmptyScan: BadLinesScan | null = null;
    if (tipAdapter) {
      try {
        const tipTurns = await tipAdapter.parse(tail.toRef);
        tipEmpty = tipTurns.length === 0;
        if (tipEmpty) {
          // 与 status / chain list / doctor 同档：parse 跳过坏行，0 轮也可能是文件截断；
          // parse 后文件消失也必须报「扫描未完成」，不能当合法空会话。
          tipEmptyScan = await scanUnparsableJsonLines(tail.toRef.filePath, { allowMissing: false });
        }
        tipUnfinished = describeResumeTargetUnfinished(
          tipTurns,
          // 前半句刚印过会话 id，这里不再重复一遍
          `链尾会话（${tipAdapter.displayName}）`,
          0,
        );
      } catch (error) {
        // 前面几档刚确认过文件存在且打得开，这里的真实原因在 error 里；解析前一刻被压缩的
        // 竞态下，正确的下一步是让原生重新展开，而「先确认这个会话文件可读」会引去查权限。
        const copy = compressedCopy(await sessionFilePresence(tail.toRef.filePath));
        tipUnfinished = [
          `但读不出它的内容，无法确认它是否停在做了一半的一轮上：` +
            `${copy?.note ?? describeReadFailureOrSelf(error)}；` +
            (copy ? compressedRetryAdvice(copy, '再 resume') : '先确认这个会话文件可读再 resume'),
        ];
      }
    }
    // 链尾 ID 来自链记录（可能是旧版本 adopt 写入的文件名 / 索引 ID），不保证能拼进恢复命令。
    // 这是只读分支：拒绝生成命令是对的，但不能让适配器守卫的短句取代下面这条完整结论
    //（「直接 resume 即可」/ 0 轮 / 未完成都依赖同一句事实），所以就地降级成说明。
    const resumeProblem = sessionIdCommandProblem(tail.toRef.sessionId);
    const resume = resumeProblem
      ? `无法生成恢复命令：${resumeProblem}`
      : tipAdapter
        ? tipAdapter.resumeCommand(tail.toRef)
        : `resume 会话 ${escapeControlChars(tail.toRef.sessionId)}`;
    const display = tipAdapter?.displayName ?? providerId;
    throw new Error(
      `链尾已是 ${providerId}：会话 ${escapeControlChars(tail.toRef.sessionId)}（${resume}），` +
        (tipEmpty
          ? (() => {
              const scan = tipEmptyScan ?? { count: 0 };
              const reason = describeZeroTurnReason(
                scan,
                '可能是刚建出来的空会话，也可能内容已被清空',
                // 扫描没扫完时不能断言打开的是空会话；失败原因本身已给出下一步。
                // 有坏行时同理：文件被截断仍可能解析出 0 轮，只保留恢复建议
                zeroTurnResumeClaim(scan, '直接 resume 打开的是空会话。') +
                  (scan.error
                    ? ''
                    : `如果它本该有内容，先在 ${display} 里打开它确认，或从备份恢复该文件` +
                      `（Watch 不会替你重建历史）；要开新对话请先切到另一侧`),
              );
              return `但这条会话解析出 0 轮（没有可继续的对话）：${reason}`;
            })()
          : `直接 resume 即可；要开新对话请先切到另一侧`) +
        (tipUnfinished.length ? `。注意：${tipUnfinished.join('；')}` : '') +
        // 这条分支从不写会话文件也不写链记录；tipEmpty 分支已在正文说过「本次没有新建会话」，
        // 非空分支原来只说「直接 resume 即可」，用户看不出这次 new 有没有留下东西。
        (tipEmpty ? '' : '；本次未写入任何内容'),
    );
  }
  const paired = pairedRef(history, providerId);
  if (paired) {
    // 「先切走」是错的：`switch` 只往 switch_events 追加记录，`pairedRef()` 扫的是整条历史，
    // 切到另一侧再切回来绑定照样在，用户来回几轮只会再撞同一句。
    // 真正能解开的只有两条：换绑（adopt 会替换掉旧会话）或另起一条链。
    // 同时点出被绑着的是哪个会话——`new` 的动机常常是「上次那个好像不对」，不说 id 就只能靠猜。
    throw new Error(
      `${providerId} 已在链上：会话 ${escapeControlChars(paired.sessionId)}（每个 provider 在一条链上只能有一个会话）；` +
        `没有交接任何内容，也没有新建会话。` +
        `要换绑请用「接入」：watch adopt ${providerId} --session <另一个会话 id>；` +
        `要在新的一侧另开一段请先建链：watch chain new <新名字> 之后重跑 watch new ${providerId}`,
    );
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

/**
 * 无库时的统一警告。
 *
 * 调用方（`cli-main.ts` 的 `openStore()`）已经拿到了打开失败的真实原因——权限、库损坏、
 * 被另一个 watch 占用、schema 比本程序新，每一种都自带路径与下一步，且与 Node 版本无关。
 * 旧文案一律补一句「可检查 WATCH_DB 路径与 Node 版本」，会把人引去查 Node，与
 * `storeUnavailableError()` 早就改过的规则矛盾（见 `cli-main.ts` 那条注释）。
 * 只有真的拿不到原因（直接传 `null` store 的调用方）才退回那句通用提示。
 */
export function storeUnavailableWarning(subject: string, storeError?: string): string {
  if (storeError) return `本地库不可用，${subject}：${storeError}`;
  return `本地库不可用，${subject}（可检查 WATCH_DB 路径与 Node 版本）`;
}

/**
 * 本目录没有链时，本地库里其它目录的链（`usage` 的说明用）。
 * 这条查询只是**补充说明**：库读不出来就当没有，用量报告本身不该因为它一起失败。
 */
function chainsElsewhereOf(store: Store, cwd: string): ChainsElsewhere[] {
  try {
    return store.chainsElsewhere(cwd);
  } catch {
    return [];
  }
}

export async function chainUsage(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
  /** 库打开失败的真实原因；带上它就不再让用户去查 Node 版本 */
  storeError?: string,
): Promise<{
  chain: Chain | null;
  total: TokenUsage;
  /** 读取失败、因而没有计入 total 的会话数：total 只是「已知用量之和」，不是全链上限 */
  totalExcluded: number;
  /** 没有 usage 数据（原生无该字段 / 文件读不出，`sessionUsage` 返回 null）、同样没计入 total 的会话数：不说明会被当成「用量就是这么多」 */
  totalMissingUsage: number;
  /**
   * 文件在、非 0 字节、可读，但解析出 0 轮的合法空会话数（`watch new codex` / `grok` / `opencode`
   * 建出来的就是这种）：它们同样没有用量，但「还没有对话内容」与「有内容却没记 usage」下一步不同，
   * 不能再混进 `totalMissingUsage` 说成「无 usage 数据的会话」。
   */
  totalEmptySessions: number;
  byProvider: {
    provider: string;
    sessionId: string;
    usage: TokenUsage | null;
    error?: string;
    /**
     * 该会话的用量数据源里有几行无法解析（这些行的用量没计入，印出来的数字是**下界**）。
     *
     * 以前只有一条链级警告，读者要在几百行警告里自己把「偏少」对回具体的会话行；
     * 而按会话那几行照旧印 `in=… out=…`，看起来与完整读数一模一样。只在 `usage !== null`
     * 时带这项：用量本来就是 `null` 的会话，数字都不存在，谈不上「偏少」。
     */
    usageBadLines?: number;
    /**
     * 坏行扫描没完成（用量数据源读不出来）时的原因。与 `usageBadLines` 可以同时出现；
     * 它说明「合计是下界」这件事本身都没确认，不能按「没有坏行」显示。
     */
    usageBadLinesScanError?: string;
    /**
     * 已确认是合法空会话（主文件在、非 0 字节、无坏行、解析 0 轮、
     * 且适配器没有给出相反证据）：`usage: null` 不是统计缺失，而是还没有对话内容。
     */
    emptySession?: true;
    /** 内容文件有无法解析的行：内容可能不完整；`usage === null` 时解析 0 轮不能当作空会话 */
    contentBadLines?: number;
    /** 内容文件坏行没扫完：连「内容是否完整 / 是不是空会话」都无法确认 */
    contentBadLinesScanError?: string;
    /** 适配器给出的「0 轮但不是合法空会话」反证（如 Codex 只剩压缩记录） */
    zeroTurnProblem?: string;
    /** 用量来自旁路文件、已计入合计，但 `parse()` 读的内容文件已空 / 不可用 */
    contentProblem?: string;
    /**
     * 主文件是 0 字节：内容已丢失。与权限 / I/O 读取失败相反，下一步是备份恢复
     * （Watch 不会替用户重建历史），脚本不必解析中文 `error` 来分档。
     */
    emptyFile?: true;
    /**
     * 内容解析抛错、因而不确定是不是空会话（同时计入 `totalExcluded`，`error` 里是同一句话）。
     *
     * 与「用量读完、但内容文件已空 / 缺失 / 不可用」的 `contentProblem` 不是一回事：那档有数字，丢的是内容本身；
     * 这一档连是不是空会话都不知道。脚本不该靠解析中文文案分辨两者（第 316 轮）。
     */
    contentUnreadable?: true;
  }[];
  /** 链上有绑定、但适配器根本不给用量（未实现 `sessionUsage`；当前六家都已实现，留给将来新增的适配器）：不列出来会被当成「这一家没有用量」 */
  unsupported: string[];
  /** 用量读不出来的会话：null 可能是「原生没有 usage」，这里单独说明是真失败 */
  warnings: string[];
  /**
   * 结果说明（与 `warnings` 的降级原因分开，同 `open` 的 notes / warnings 分法）。
   *
   * `byProvider: []` + `total: 0` 在 `--json` 里同时表示「链上还没有绑定会话」「没有可用的
   * 当前链」与「确实用了 0 token」，不说明就会被脚本当成后者——文本模式一直有这句解释，
   * 但不进结构，桌面端与脚本读不到（sblattj/agentic-coding-harness 的同类教训：
   * 未知要标成 unknown，不能静默当成 0）。空数组表示「无需说明」。
   */
  notes: string[];
}> {
  const empty = { inputTokens: 0, outputTokens: 0 };
  if (!store) {
    // 无库时链与用量都无从判断，不能返回一份看起来「就是 0」的空报告
    return {
      chain: null,
      total: empty,
      totalExcluded: 0,
      totalMissingUsage: 0,
      totalEmptySessions: 0,
      byProvider: [],
      unsupported: [],
      warnings: [storeUnavailableWarning('无法确定当前链与各家用量', storeError)],
      notes: [],
    };
  }
  const warnings: string[] = [];
  const chain = store.findActiveChain(cwd, chainId);
  if (chainId && !chain) throw new Error(store.missingChainMessage(cwd, chainId));
  // 归档链照样给用量（历史记录有用），但要说清它已不是当前链：
  // `--json` 里虽有 status，文本模式只印名字，容易被当成「现在还在用这条」
  if (chain?.status === 'archived') {
    warnings.push(`链 ${escapeControlChars(chain.name)} 已归档（不再是本目录的当前链），下面的用量是历史记录`);
  } else if (chain && chainId) {
    // 活跃但非当前链：与「已归档」同一类误导，而且更隐蔽（状态栏里一点异常都没有）
    const notCurrent = notCurrentChainWarning(chain, store.findActiveChain(cwd));
    if (notCurrent) warnings.push(notCurrent);
  }
  const history = chain ? store.listSwitchEvents(chain.id) : [];
  const byProvider: {
    provider: string;
    sessionId: string;
    usage: TokenUsage | null;
    error?: string;
    usageBadLines?: number;
    usageBadLinesScanError?: string;
    /**
     * 已确认是合法空会话（主文件在、非 0 字节、无坏行、解析 0 轮、
     * 且适配器没有给出相反证据）：`usage: null` 不是统计缺失，而是还没有对话内容。
     */
    emptySession?: true;
    /** 内容文件有无法解析的行：内容可能不完整；`usage === null` 时解析 0 轮不能当作空会话 */
    contentBadLines?: number;
    /** 内容文件坏行没扫完：连「内容是否完整 / 是不是空会话」都无法确认 */
    contentBadLinesScanError?: string;
    /** 适配器给出的「0 轮但不是合法空会话」反证（如 Codex 只剩压缩记录） */
    zeroTurnProblem?: string;
    /** 用量来自旁路文件、已计入合计，但 `parse()` 读的内容文件已空 / 不可用 */
    contentProblem?: string;
    /**
     * 主文件是 0 字节：内容已丢失。与权限 / I/O 读取失败相反，下一步是备份恢复
     * （Watch 不会替用户重建历史），脚本不必解析中文 `error` 来分档。
     */
    emptyFile?: true;
    /**
     * 内容解析抛错、因而不确定是不是空会话（同时计入 `totalExcluded`，`error` 里是同一句话）。
     *
     * 与「用量读完、但内容文件已空 / 缺失 / 不可用」的 `contentProblem` 不是一回事：那档有数字，丢的是内容本身；
     * 这一档连是不是空会话都不知道。脚本不该靠解析中文文案分辨两者（第 316 轮）。
     */
    contentUnreadable?: true;
  }[] = [];
  let total = { ...empty };
  let totalExcluded = 0;
  let totalMissingUsage = 0;
  let totalEmptySessions = 0;
  // 链上绑定了也没法统计的 provider（适配器未实现 sessionUsage；当前六家都有）：
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
      // 适配器可能直接把 fs errno 抛出来，按「读不出来」翻成中文再披露。
      // Codex 的 `sessionUsage` 对缺失文件是**抛错**而非返回 null，压缩副本只会走到这里：
      // 原路径不在、同名 .zst 在时要说「文件还在」，不能沿用「已不存在」。
      const raw = describeReadFailureOrSelf(error);
      const copy = compressedCopy(await sessionFilePresence(ref.filePath));
      const msg = copy ? `会话文件${copy.note}` : raw;
      warnings.push(`${adapter.id} 用量读取失败：${msg}`);
      byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg });
      totalExcluded += 1;
      continue;
    }
    // null 在适配器里同时表示「这家原生没有 usage 字段」与「文件读不出」（各家的读失败被吞成 null）：
    // 再 stat 一次分开，否则 `usage` 的合计会把「链尾文件已经没了」讲成「这些会话没有用量数据」
    // 用量数据源里有坏行时，`sessionUsage` 一律 `continue` 跳过：合计静默偏少，而这份报告
    // 分不出「少算了」与「本来就这么多」。内容那一侧（`handoff()` / `open`）早已用
    // `scanUnparsableJsonLines()` 披露过，这里补的是同一条线上没接上的一半。
    // 必须在判空会话**之前**算：全行损坏的文件 `parse` 同样返回 0 轮，先判空会把
    // 「读不出内容」讲成「本来就是空会话」，还会把那两行坏行数一起吞掉。
    const badUsage = await usageBadLinesDetail(adapter, ref, `${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}`);
    if (usage === null) {
      const presence = await sessionFilePresence(ref.filePath);
      // 路径被同名目录 / 设备文件占住（present 但 isFile 为假）既不是「没有 usage 数据」，
      // 也不是可读文件：以前落进 totalMissingUsage，把「读不出内容」讲成「这家原生没有 usage」
      if (presence.state !== 'present' || !presence.isFile) {
        // 只有 ENOENT / ENOTDIR 才能说「不存在」：EACCES 等读不出来时照实说，
        // 否则权限问题会被讲成会话丢了，用户会去重新绑定而不是修权限
        const copy = compressedCopy(presence);
        const msg =
          copy
            ? `会话文件${copy.note}`
            : presence.state === 'missing'
            ? `会话文件已不存在：${escapeControlChars(ref.filePath)}`
            : presence.state === 'present'
              ? `该路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(ref.filePath)}`
              : presence.reason;
        warnings.push(`${adapter.id} 用量读取失败：${msg}`);
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg });
        totalExcluded += 1;
        continue;
      }
      // 「文件在、是普通文件、却是 0 字节」是这条链上最容易误报的一档：`sessionUsage` 读到的
      // 是空串、返回 null，与「这家原生没有 usage 字段」逐字相同，于是整份报告会说成
      // 「合计（未含 0 个读取失败的会话、1 个无 usage 数据的会话）」——把「内容已经没了」
      // （进程被杀 / 只写了一半 / 磁盘满）讲成「这条会话没有用量数据」，两者的下一步还相反：
      // 没有用量数据没什么可做，空文件只能从备份恢复、历史也补不回来。
      // open / switch / status / chain list / doctor / sessions / recent / adopt 都已披露这一档，
      // 判据复用 `emptySessionFileReasonFromStat()`，不另写一句。
      const emptied = emptySessionFileReasonFromStat(
        { isFile: () => presence.isFile, size: presence.size },
        ref.filePath,
      );
      if (emptied) {
        const msg =
          `${emptied}；这条会话的历史与用量都已经没了——如果它本该有内容，先从备份恢复该文件再重试` +
          `（Watch 不会替你重建历史）`;
        warnings.push(`${adapter.id} 用量读取失败：${msg}`);
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg, emptyFile: true });
        totalExcluded += 1;
        continue;
      }
      // 「文件在、不是 0 字节、却解析出 0 轮」**不必然**是合法空会话：
      // `watch new codex` / `grok` / `opencode` 建出的空会话当然是；但 grok 内容文件有半行截断时
      // parse 也返回 0 轮，Codex 只剩压缩记录时同样如此。判据必须四个证据同时成立：
      // 文件可读 + 用量数据源无坏行 + 内容文件无坏行 + 适配器没有「曾有对话」的反证。
      // 空会话的旁路文件为空是正常形状（grok 新建的 `updates.jsonl` 就是 0 字节），
      // 所以这一档要**先于**旁路检查判定，否则会把正常的新会话报成「用量数据源内容已丢失」。
      // 解析失败既不是「空会话」，也不是「这家原生没有 usage 字段」：只把 parsedZero 置 false，
      // 流程会落到下面的 totalMissingUsage，报告说成「N 个无 usage 数据的会话」——把「内容读不出来」
      // 讲成「本来就没有用量」，两者的下一步还相反（前者要修可读性，后者无事可做，第 315 轮审计）。
      let parsedZero = false;
      if (!badUsage) {
        try {
          parsedZero = (await adapter.parse(ref)).length === 0;
        } catch (error) {
          // 同一函数上方的 usage 读取分支已经按压缩副本分档；这里 parse 再抛错时若沿用
          // 「会话文件已不存在」，同一个文件在报告里会出现两种说法，还把「让原生展开」
          // 引成「修可读性」（第 353 轮）。
          const copy = compressedCopy(await sessionFilePresence(ref.filePath));
          const msg =
            `会话内容读取失败：${copy?.note ?? describeReadFailureOrSelf(error)}；` +
            (copy ? `${compressedRetryAdvice(copy, '再跑一次 watch usage')}；` : '') +
            '无法确认它是不是空会话，也没有可用的用量数据';
          warnings.push(`${adapter.id} ${msg}`);
          byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: msg, contentUnreadable: true });
          totalExcluded += 1;
          continue;
        }
      }
      let contentBad: Awaited<ReturnType<typeof usageContentBadLinesDetail>> = null;
      if (parsedZero) contentBad = await usageContentBadLinesDetail(adapter, ref, `${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}`, { zeroTurn: true });
      let zeroTurnProblem: string | undefined;
      if (parsedZero && !badUsage && !contentBad) {
        try {
          zeroTurnProblem = (await adapter.zeroTurnProblem?.(ref)) ?? undefined;
        } catch (error) {
          zeroTurnProblem = `无法确认它是不是合法空会话：${describeReadFailureOrSelf(error)}`;
        }
      }
      const emptySession = parsedZero && !badUsage && !contentBad && !zeroTurnProblem;
      if (emptySession) {
        totalEmptySessions += 1;
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, emptySession: true });
        continue;
      }
      if (contentBad) {
        const detail = {
          provider: adapter.id,
          sessionId: ref.sessionId,
          usage: null,
          ...(contentBad.count ? { contentBadLines: contentBad.count } : {}),
          ...(contentBad.scanFailed ? { contentBadLinesScanError: contentBad.scanError } : {}),
        };
        if (contentBad.scanFailed) {
          warnings.push(`${adapter.id} 用量读取失败：${contentBad.reason}`);
          byProvider.push({ ...detail, error: contentBad.reason });
          totalExcluded += 1;
          continue;
        }
        warnings.push(contentBad.reason);
        byProvider.push(detail);
        continue;
      }
      if (zeroTurnProblem) {
        warnings.push(`${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}：${zeroTurnProblem}`);
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, zeroTurnProblem });
        continue;
      }
      // 用量来自旁路文件时（grok 的 `updates.jsonl`），`ref.filePath` 是另一份文件：
      // 拿后者去判会把「用量文件被截成 0 字节」照常判成 present + 有内容，
      // 于是整份报告说「1 个无 usage 数据的会话」——内容已丢失被讲成「这家没有用量数据」
      const sidecar = await usageSidecarProblem(adapter, ref, `${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}`);
      if (sidecar) {
        warnings.push(`${adapter.id} 用量读取失败：${sidecar}`);
        byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage: null, error: sidecar });
        totalExcluded += 1;
        continue;
      }
    }
    if (badUsage) warnings.push(badUsage.reason);
    let contentProblem: string | undefined;
    let nowContentBad: Awaited<ReturnType<typeof usageContentBadLinesDetail>> = null;
    if (usage !== null) {
      nowContentBad = await usageContentBadLinesDetail(adapter, ref, `${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}`);
      if (nowContentBad) {
        // usage === null 的分支会在上面推警告；这里补的是「用量已读到」的路径。
        // 扫描失败也必须披露：字段本身能说明原因，但文本与只看 warnings 的调用方
        // 不能把「坏行数未知」读成「没有坏行」。
        warnings.push(nowContentBad.reason);
      }
      contentProblem = (await usageContentFileProblem(adapter, ref, `${adapter.id} 会话 ${escapeControlChars(ref.sessionId)}`)) ?? undefined;
      if (contentProblem) warnings.push(contentProblem);
    }
    byProvider.push({
      provider: adapter.id,
      sessionId: ref.sessionId,
      usage,
      // 即使当前一条都未读出有效数字（usage === null），只要文件里存在坏行也要保留行数，
      // 否则消费方会把「全行损坏读不出」当成「原生无 usage 字段」
      ...(badUsage ? { usageBadLines: badUsage.count } : {}),
      ...(badUsage?.scanFailed ? { usageBadLinesScanError: badUsage.scanError } : {}),
      ...(nowContentBad?.count ? { contentBadLines: nowContentBad.count } : {}),
      ...(nowContentBad?.scanFailed ? { contentBadLinesScanError: nowContentBad.scanError } : {}),
      ...(contentProblem ? { contentProblem } : {}),
    });
    if (usage === null && !badUsage) totalMissingUsage += 1;
    if (usage) {
      total = {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      };
    }
  }
  // 结果说明只回答「为什么这份报告是空的」，与 warnings 的降级原因分开放
  const notes: string[] = [];
  if (!byProvider.length) {
    if (unsupported.length) {
      notes.push(`链上有绑定（${unsupported.join('、')}），但这些适配器不提供用量数据`);
    } else if (chain && history.length === 0) {
      notes.push(`这条链还没有绑定任何会话，没有可统计的用量；${emptyChainBindHint()}`);
    } else if (chain) {
      // 有切换记录却没有一条统计得出来（绑定的 provider 已不在适配器列表里）
      notes.push('链上有切换记录，但没有可统计的会话（绑定的 provider 可能未注册）；未统计任何用量');
    } else {
      // 没有当前链有两种来源：还没建链，或现有链都已归档——别把后者说成「没有链」。
      // 还有第三种更容易被误读的：本目录没有链，链躺在别的目录里（链按 cwd 精确分组），
      // 此时「还没建链」会被读成链丢了 / 从来没建成功，必须指出它在哪。
      // 「别的目录」要按 realpath 分辨：`--cwd` 只是同一个目录的另一种写法时，说「其它目录」是错的
      const elsewhere = chainsElsewhereOf(store, cwd);
      if (!elsewhere.length) {
        notes.push('没有可用的当前链（还没建链，或现有链都已归档），无用量可统计；可先用 watch chain list 查看');
      } else {
        const split = await splitElsewhereByDirectory(elsewhere, cwd);
        const parts: string[] = [];
        if (split.sameDirectory.length) parts.push(chainsSameDirectoryHint(split.sameDirectory));
        if (split.otherDirectories.length) parts.push(chainsElsewhereHint(split.otherDirectories));
        notes.push(`本目录没有可用的当前链，无用量可统计；${parts.join('；')}`);
      }
    }
  }
  return { chain, total, totalExcluded, totalMissingUsage, totalEmptySessions, byProvider, unsupported, warnings, notes };
}

export type ProviderTip = {
  provider: string;
  ref: SessionRef;
  updatedAt: number;
  onChain?: boolean;
  /**
   * 文件列得出来、但读不出来（`chmod 000` 之类）。
   *
   * `updatedAt` / `filePath` 都只是元数据，`stat` 对读不出来的文件照常成功，所以不加这一档时
   * `status` 会把一条 open / switch 必然失败的会话当成「最新原生会话」正常展示。
   */
  unreadable?: boolean;
  /**
   * `unreadable` 的其中一档：文件是 0 字节，内容已经丢失。
   *
   * `probeSessionReadable()` 对 0 字节同样返回非空原因（resume 已没有内容可恢复），但下一步与
   * 权限 / I/O 失败相反——后者要修可读性，0 字节只能从备份恢复或另开一条会话。文本模式与
   * `--json` 都要能区分这两种情况，不再从中文原因里猜。
   */
  emptyFile?: boolean;
};

/**
 * 「这次什么都没写」之后，链尾现在停在哪——三种事实必须分开说：
 * 链上有绑定（说清是谁）/ 这条链还没有绑定（没有链尾需要保留）/ 链历史读不出来（无从判断）。
 * 以前一律写成「链尾仍在 <来源 provider>」：来源是按 mtime 兜底挑的时候，它根本不是链尾；
 * 空链与库故障时这句话更是编的（`alreadyAtTarget` 分支早就按 chainTipState 分了三档）。
 */
/**
 * 「来源 0 轮」时下一步按四种事实分档：链上已有链尾（同链 new 仍会撞这次空交接，只能另起一条）、
 * 链还是空的（直接 new 就是它的第一条绑定，另起一条纯属多余）、库不可用（链记录写不进去）、
 * 链历史读不出来（是否写进去无法确认）。以前前两种之外都用「请先另起一条链」——空链上照着
 * 做的人会凭空多出一条链；后来库不可用与历史读失败又合成一档说「原因见上方警告」，
 * 而走到这里的 throw 路径根本没有「上方警告」，历史读失败也不是库不可用（第 345 轮）。
 */
function zeroTurnNextStep(args: {
  target: ProviderAdapter;
  targetId: string;
  store?: Store | null;
  history: SwitchRecord[];
  historyFailed: boolean;
}): string {
  const { target, targetId, store, history, historyFailed } = args;
  const adoptHint = `若 ${target.displayName} 侧已有会话，可用 watch adopt ${targetId} --session <会话 id> 接进来`;
  if (!store) {
    return `要在 ${target.displayName} 侧从零开新会话：watch new ${targetId}（本地库不可用，这次交接写不进链记录）；${adoptHint}`;
  }
  if (historyFailed) {
    return `要在 ${target.displayName} 侧从零开新会话：watch new ${targetId}（链历史读取失败，这次交接是否写进链记录无法确认）；${adoptHint}`;
  }
  if (!history.at(-1)?.toRef) {
    return `要在 ${target.displayName} 侧从零开新会话，直接 watch new ${targetId} 即可（新会话就是这条链的第一条绑定）；${adoptHint}`;
  }
  return (
    `要在 ${target.displayName} 侧从零开新会话，请先另起一条链：watch chain new <新名字> 之后 watch new ${targetId}` +
    `（同一条链上直接 new ${targetId} 仍会走这次空交接）；${adoptHint}`
  );
}

function chainTipAfterNoWrite(args: {
  history: SwitchRecord[];
  historyFailed: boolean;
  store?: Store | null;
  adapters: ProviderAdapter[];
}): string {
  const { history, historyFailed, store, adapters } = args;
  if (!store) return '本次未写入任何内容（本地库不可用，无法确认链尾状态）';
  if (historyFailed) return '本次未写入任何内容（链历史读取失败，无法确认链尾状态）';
  const tip = history.at(-1)?.toRef ?? null;
  if (!tip) return '本次未写入任何内容（这条链还没有绑定任何会话，没有链尾需要保留）';
  const name = adapters.find((a) => a.id === tip.provider)?.displayName ?? tip.provider;
  return `本次未写入任何内容，链尾未变（仍是 ${name} 会话 ${escapeControlChars(tip.sessionId)}）`;
}

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
  /** 目标会话在写入前被移走，本次改为新建：newRef 是新会话，原 id 在这里；旧历史没有并入 */
  targetRecreated?: { previousSessionId: string };
  /** 来源会话在交接期间被写入过（stat 字节数与方向），与 `watch prompt --json` 同字段 */
  sourceDrift?: SourceChangeSince;
  /** 来源会话在交接期间「量不出来」有没有变化，附原因；与 sourceDrift 互斥 */
  sourceDriftUnknown?: string;
  /**
   * 来源 / 目标会话文件里有无法解析的行（被 parse 跳过），或坏行扫描没完成：来源侧 = 交接内容
   * 可能不完整，目标侧 = 增量判定可能偏多、重复追加。两侧都干净时不输出。
   */
  unparsableLines?: UnparsableLines;
  /**
   * 带不到目标的内容按类别计数（附件 / 过程文本 / 工具失败标记 / Bash 执行条件），与对应的
   * 中文 warnings 同一处取数：附件与 Bash 执行条件按来源会话计，过程文本与失败标记按本次
   * 实际写入的内容计。四类都没有时不输出。
   */
  contentLoss?: ContentLoss;
  /**
   * 来源会话没收尾（见 `SourceUnfinished`）：有工具调用没有结果，或最后停在用户消息上。
   * 与对应的两句中文 warnings 同一处判定；交接照常成功，接手的一侧看到的那一轮是做了一半的。
   * 两种形状都没有时不输出。
   */
  sourceUnfinished?: SourceUnfinished;
  /**
   * 结果里那条 resume 指向的目标会话自己没收尾（见 `targetUnfinishedField`）：与来源那一侧
   * 各说各的。工具调用没有结果一直算；最后停在用户消息上只在这次没并入内容时算。
   * 目标是这次新建的（含旧目标被移走后改为新建）时不输出——那条会话里只有本次写入的内容。
   */
  targetUnfinished?: TargetUnfinished;
  /**
   * 解析器对来源 / 目标会话做的上下文完整性声明条数（见 `ContextDisclosures`），与对应的
   * warnings 同一处取数：来源一侧在读出来源后给；目标一侧在结果里那条 resume 落在既有目标
   * 会话上时给（alreadyAtTarget、零增量、追加），新建的目标没有。没有声明时不输出。
   */
  contextDisclosures?: ContextDisclosures;
  /**
   * 这次到底有没有把链绑定 / 切换记录写进去：
   * - written：写成了；
   * - failed：尝试过但抛错（库只读、磁盘满、SQLITE_BUSY 等），`warnings` 里已有一条
   *   「链记录失败」——调用方不得再按「链尾已更新 / 这次写了链记录」措辞生成结论；
   * - not-attempted：本次没有写（alreadyAtTarget 直接返回、本地库不可用、无需改动）。
   *
   * 之所以要三态而不是布尔：`alreadyAtTarget` 与「写失败」都会让「链尾已更新」成为假话，
   * 但下一步不同——前者本来就不需要写，后者要按警告里的原因处理。内部协调字段，不进 `--json`。
   */
  chainRecordState?: 'written' | 'failed' | 'not-attempted';
  /**
   * 这条 resume 指向的会话文件现在读不出来（`chmod 000` 之类）。
   *
   * alreadyAtTarget 时文本模式据此把「直接打开即可」换成「直接打开会失败」——`warnings` 已经逐条说明原因，
   * 但结论句本身也得改，否则用户复制的那条命令一执行就失败却找不到矛盾在哪。
   * 零增量返回既有目标的恢复命令时也设置该字段，原因与换绑建议由 `warnings` 给出。
   */
  resumeUnreadable?: boolean;
  /** 恢复同家会话时仅找到压缩副本。`intact` 表示非零字节，`empty` 表示 0 字节。 */
  resumeCompressed?: CompressedCopyNote['kind'];
  /** 文件探测通过，但 Watch 未能解析要恢复的会话内容。 */
  resumeParseFailed?: boolean;
  /**
   * alreadyAtTarget 时这条 resume 指向的会话解析出 0 轮（文件可读、不是 0 字节）。
   *
   * `watch new codex` / `watch new grok` 建出的合法空会话与「内容被清空、只剩占位头」都长这样：
   * 后者在正文说「直接打开即可」等于替一条空会话背书（打开进去什么也没有）。文本模式据此
   * 把结论改成「直接打开的是空会话」，`warnings` 里另有完整说明与下一步。
   */
  resumeTargetEmpty?: boolean;
  /**
   * `turnCount` 为 0（零增量，且非 alreadyAtTarget）时的两种来源：
   * `source-empty` = 来源解析出 0 轮（合法的空会话，或只剩占位头 / 内容被清空），
   * `up-to-date` = 目标已包含来源全部内容，本次未追加。文本模式据此给出准确结论，
   * 不再一律印「已从 X 交接 → Y（0 轮）」。
   */
  zeroIncrementReason?: 'source-empty' | 'up-to-date';
  /**
   * 零增量时报告空来源与空目标，同家恢复或向既有会话写入前也报告空目标。
   * `zero-byte` 表示文件 0 字节，`zero-turns` 表示可读文件解析出 0 轮。
   * 字段与警告复用同一次检查，取值与 `open` / `adopt` 一致。
   */
  emptySessions?: EmptySessions;
  /**
   * 结果说明（与 `warnings` 的降级原因分开，同 `open` 的 notes / warnings 分法）。
   *
   * 目前只有一条：目标会话解析出 0 轮（可读、不是 0 字节）时说明「本次并入的 N 轮
   * 就是它的全部内容」。`open --from` 从 v0.1.82 起就在 notes 层说这句；`switch` 是
   * 首条链最常用的入口，同样的话以前只有「已从 X 交接 → Y（N 轮）」，看不出目标原本是空的。
   * 放在 notes 而不是 warnings：`watch new` 之后第一次切到那条空会话是正常路径，
   * 不该每次都冒一条降级警告。
   */
  notes?: string[];
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
  /** 收集「这一家根本没读成」的 provider id：调用方要据此判断能否下「这个目录没有会话」的结论 */
  unreadable?: string[],
  /**
   * 同上，但要原因。`handoff()` 零结果时是直接 throw，`warnings` 到不了用户手里，
   * 所以它得把原因内联进错误文案——否则用户只看到「没有会话」，一点线索都没有。
   */
  unreadableReasons?: { provider: string; reason: string }[],
): Promise<ProviderTip[]> {
  const tips: ProviderTip[] = [];
  for (const adapter of adapters) {
    if (!adapter.findLatestSession) continue;
    let found;
    try {
      found = await adapter.findLatestSession(cwd);
    } catch (error) {
      const reason = describePathReadFailureReason(error);
      unreadable?.push(adapter.id);
      unreadableReasons?.push({ provider: adapter.id, reason });
      // 单个 provider 的原生存储读不出来时跳过，不影响其它家，但要披露；原因按路径说（这里
      // 可能是目录 / 索引 / 库），不能把 `EACCES: permission denied, scandir '…'` 原文交给用户
      warnings?.push(`${adapter.id} 原生会话读取失败，已跳过：${escapeControlChars(reason)}`);
      continue;
    }
    if (found) {
      warnings?.push(...(found.warnings ?? []));
      tips.push({ provider: adapter.id, ref: found.ref, updatedAt: found.updatedAt });
    }
  }
  return tips;
}

/** 按 mtime 挑最新的一条；`watch prompt` 不带会话 id 时的自动挑选也走这里，避免两处各写一份比较 */
export function pickLatestTip(tips: ProviderTip[]): ProviderTip | null {
  if (!tips.length) return null;
  return tips.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}

/** 各 provider 最新会话（标记链上绑定）+ 链尾 + store 历史链 */
export async function chainStatus(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
  /** 库打开失败的真实原因；带上它就不再让用户去查 Node 版本 */
  storeError?: string,
): Promise<{
  tips: ProviderTip[];
  /**
   * 链尾；文件在、但读不出来时与 `tips[]` 同口径带 `unreadable`，0 字节另带 `emptyFile`。
   * 脚本只读这个对象渲染链尾时，不必再去 `tips[]` 里找同一条会话。
   */
  chainTip: ProviderTip | null;
  /**
   * 链尾已经绑定、但它的文件现在不可用（不存在 / 不是普通文件 / 状态无法确认）。
   * 文本模式拿不到 warnings 的结构化版本，靠它区分「这个目录真没聊过」与「链尾文件坏了」，
   * 否则 `status` 会在警告之后照样说「请先在任一受支持的 Agent 里开聊」。
   */
  chainTipUnusable: boolean;
  /**
   * 链尾会话文件可读、parse 成功却解析出 0 轮（合法空会话 / 内容被清空只剩占位头）。
   * 文本模式在 `← 链尾` 那一行旁边标出来；与 `chainTipUnusable` 分开：文件本身没问题，
   * 只是没有可继续的对话。
   */
  chainTipEmpty: boolean;
  /**
   * 链尾会话解析出的轮数；`undefined` 表示没解析成功（文件不可读 / 适配器未注册 / parse 抛错）。
   * 0 与 `chainTipEmpty` 同时为真；与它分开是因为文本模式要用不同的说法。
   */
  chainTipTurns?: number;
  /**
   * 链尾解析出 0 轮时确认的坏行数（扫描未完成时附 `error`，此时 `count` 是下界）。
   * 只在 `chainTipEmpty` 为真、且真有坏行或扫描失败时给出；与 warnings 里那句
   * 「N 行无法解析」来自同一次扫描，脚本不用再解析中文才知道 0 轮是不是文件损坏造成的。
   */
  chainTipBadLines?: BadLinesScan;
  /**
   * 这次根本没读成的 provider（findLatestSession 抛错）。
   * 文本模式靠它区分「这个目录真没聊过」与「有几家没查成」——后者不能给出
   * 「请先在任一受支持的 Agent 里开聊」这类结论性建议。
   */
  unreadable: string[];
  history: SwitchRecord[];
  /** 链历史读失败：`history` 为空不代表链真的没有记录，文本与 JSON 都不得把它讲成空链 */
  historyFailed: boolean;
  /**
   * 只读血缘图：节点是历史中确认过的 provider:sessionId，边来自 switch_events。
   * `undefined` 表示库打不开或历史读失败，不能与空图（这条链确实没有记录）混淆；
   * 不猜被删会话、不写盘。
   */
  lineage?: LineageGraph;
  chain: Chain | null;
  chains: Chain[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const unreadable: string[] = [];
  const allTips = await collectTips(cwd, adapters, warnings, unreadable);
  let history: SwitchRecord[] = [];
  let historyFailed = false;
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
        warnings.push(`链 ${escapeControlChars(chain.name)} 已归档（不再是本目录的当前链），下面显示的是它的历史记录`);
      } else if (chain && chainId) {
        // 活跃但非当前链：不及时说明，用户会把这份 status 当成「不带 --chain 也会作用在这条链上」
        const notCurrent = notCurrentChainWarning(chain, store.findActiveChain(cwd));
        if (notCurrent) warnings.push(notCurrent);
      }
      history = chain ? store.listSwitchEvents(chain.id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链/.test(error.message)) throw error;
      history = [];
      historyFailed = true;
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  } else {
    warnings.push(storeUnavailableWarning('链信息与链尾无法显示（只列出原生会话）', storeError));
  }
  // 只读血缘图必须与 history 的读取结果同源：库打不开 / 读失败时是 undefined，
  // 不能返回空图冒充「没有历史」。没有链时 history 为空数组，空图是准确结论。
  // 节点只来自已确认的 fromRef/toRef，不是对摘要的猜测。
  const lineage = store && !historyFailed ? lineageFromHistory(history) : undefined;
  if (lineage?.skipped) {
    // 派生结果少了记录仍是降级：不披露的话，--json 的 nodes / edges 会被当成完整血缘。
    // 记录本身仍在 history 里，下一步是核对库内容，而不是删掉这条链。
    warnings.push(
      `链历史里有 ${lineage.skipped} 条切换记录的会话引用不完整或损坏，血缘图已跳过这些记录（节点 / 边可能不完整）；切换记录本身仍保留在 history 里`,
    );
  }
  // 链尾只以当前链的 switch_events 最后一条为准；不再 fallback 到目录全局最新会话
  let chainTip: ProviderTip | null = null;
  let chainTipUnusable = false;
  // 链尾文件可读、parse 成功却解析出 0 轮：`watch new codex` / `watch new grok` 建出的
  // 合法空会话与「内容被清空、只剩占位头」都是这个形状。上面四档只判「文件在不在 / 是不是
  // 普通文件 / 读不读得出来」，0 轮的一条照样被标成 `← 链尾` 推荐给用户，照抄 resume 打开
  // 的是空会话。v0.1.84–v0.1.88 把 open / switch / new 各分支补齐后，`status` 是最后一个
  // 会说「这就是你的链尾」却不说它是空的入口。
  let chainTipEmpty = false;
  // 链尾解析出的轮数：`status` 的 `← 链尾` 那一行直接显示它。0 轮时与 `chainTipEmpty`
  // 同时为真，文本模式换成「解析出 0 轮」的说明；有内容时用户能一眼看到链尾还剩多少。
  // 只在 parse 成功时给值（undefined = 没解析 / 解析失败），不拿 0 冒充
  let chainTipTurns: number | undefined;
  let chainTipBadLines: BadLinesScan | undefined;
  if (history.length) {
    const last = history.at(-1)!;
    chainTip = { provider: last.toProvider, ref: last.toRef, updatedAt: last.createdAt, onChain: true };
    // 链尾指向的会话文件被删/被移走时，status 不能假装一切正常：下次 switch 会在这里失败
    // 只有 ENOENT / ENOTDIR 才能说「已不存在」；EACCES 等读不出来照实说「状态无法确认」，
    // 否则权限问题会被讲成会话丢了，把人引去白换一次绑定
    const tipPresence = await sessionFilePresence(last.toRef.filePath);
    if (tipPresence.state === 'missing') {
      chainTipUnusable = true;
      const copy = compressedCopy(tipPresence);
      warnings.push(
        copy
          ? `链尾会话文件${copy.note}（${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}）；下次切换会失败——${compressedRetryAdvice(copy, '再重试')}，或${rebindHint(last.toProvider)}`
          : `链尾会话文件已不存在：${escapeControlChars(last.toRef.filePath)}（${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}，文件不存在）；下次切换会失败，${rebindHint(last.toProvider)}`,
      );
    } else if (tipPresence.state === 'present' && !tipPresence.isFile) {
      // 路径还在、只是不是普通文件：说成「文件已不存在」自相矛盾，还会把人引去 adopt；
      // 与 chain list / doctor 的「该路径现在不是普通文件」保持同一说法
      chainTipUnusable = true;
      warnings.push(
        `链尾会话文件的路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(last.toRef.filePath)}（${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}）；下次切换会失败，先恢复该路径，再决定是否需要 ${rebindHint(last.toProvider)}`,
      );
    } else if (tipPresence.state === 'unknown') {
      chainTipUnusable = true;
      warnings.push(
        `链尾会话文件状态无法确认：${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}；${tipPresence.reason}；可能是权限或路径问题，先确认它是否还在，再决定是否需要 adopt`,
      );
    } else if (tipPresence.isFile) {
      // `stat` 成功不等于读得出来：`chmod 000` 的链尾文件 stat 照常返回，于是
      // `chainTipUnusable` 报 false、warnings 为空，而 resume / 下一次 switch 一读内容就失败。
      // 同一状态下 `sessions` / `open` 都会披露，status 作为总览入口不能替它宣称「可用」。
      const readProblem = await probeSessionReadable(last.toRef.filePath);
      if (readProblem) {
        chainTipUnusable = true;
        const tipEmptyFile = isEmptySessionFileReason(readProblem);
        // `chainTip` 是脚本渲染链尾那一行的入口；同一份文件在 `tips[]` 里已带
        // `unreadable` / `emptyFile`，这里不带就会让两个字段对同一条会话给出相反印象
        chainTip = { ...chainTip, unreadable: true, ...(tipEmptyFile ? { emptyFile: true } : {}) };
        // 0 字节与权限 / I/O 失败都会让 resume 失败，但下一步相反：修可读性救不回已经丢失的
        // 内容，照着「先修好这个文件（权限或内容）」做只会白查一遍权限（与 doctor 的 emptyTips
        // / sessions 的 pushPreviewErrorWarning 同一分档）。
        warnings.push(
          tipEmptyFile
            ? `链尾会话文件是空的：${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}；${readProblem}；` +
              `resume 已经没有任何内容可恢复，下一次 switch 也会失败——先从备份恢复该文件（Watch 不会替你重建历史），` +
              `或 watch adopt ${last.toProvider} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`
            : `链尾会话文件读不出来：${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}；${readProblem}；` +
              `resume 与下一次 switch 都会失败——先修好这个文件（权限或内容），` +
              `或 watch adopt ${last.toProvider} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`,
        );
      } else {
        // 读得出来不等于有内容：0 轮（合法空会话 / 内容被清空只剩占位头）时下面那条
        // `← 链尾` 的 resume 打开的是空会话，必须在概览里就说出。parse 失败走本函数末尾的
        // catch：只说「未能核对」这个事实，具体原因留给 open / switch 的预检（第 364 轮）
        const tipAdapter = adapters.find((a) => a.id === last.toProvider);
        if (tipAdapter) {
          try {
            const turns = await tipAdapter.parse(last.toRef);
            chainTipTurns = turns.length;
            if (turns.length === 0) {
              chainTipEmpty = true;
              // parse 会跳过坏行：文件末尾被截断、整份 JSONL 损坏时也会解析出 0 轮，
              // 与合法空会话同形。先说清有没有坏行，避免把「文件坏了」讲成
              // 「刚建出来还没聊过 / 内容被清空」。
              const subject = `链尾会话 ${last.toProvider} ${escapeControlChars(last.toRef.sessionId)}`;
              const badScan = await scanUnparsableJsonLines(last.toRef.filePath, { allowMissing: false });
              // 与 warnings 同一次扫描：坏行数和扫描失败原因都按 `unparsableLinesField` 的
              // 同一口径输出，干净文件不给出字段（0 轮不等于文件损坏）
              chainTipBadLines = unparsableLinesField(null, badScan).unparsableLines?.target;
              warnings.push(
                `${subject} 解析出 0 轮（没有可继续的对话）：` +
                  describeZeroTurnReason(
                    badScan,
                    '可能是刚建出来的空会话，也可能内容已被清空',
                    badScan.error
                      ? ''
                      : zeroTurnResumeClaim(badScan, `按这个链尾 resume 打开的是空会话——`) +
                        `如果它本该有历史，先在 ${tipAdapter.displayName} 里打开它确认，或从备份恢复该文件（Watch 不会替你重建历史）`,
                  ),
              );
            }
          } catch {
            // 文件读得出来、内容却解析不了（库缺表、格式损坏、适配器异常）：`← 链尾`
            // 这一行仍会把这条会话推荐给用户，不显示轮数只是沉默——读者无法把它与
            // 「有内容但没统计」区分，而 resume 落在这条会话上。具体原因不在这里重复
            // （open / switch 的预检会给出），但「未能核对」这个事实必须说（第 364 轮）。
            warnings.push(
              `链尾会话 ${last.toProvider} ${escapeControlChars(last.toRef.sessionId)} 的内容解析失败，` +
                `Watch 未能核对它的轮数与收尾状态；打开或切换到它时会给出具体原因`,
            );
          }
        }
      }
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
  // `findLatestSession` 只说明「目录里有这条会话」，`stat` 对 `chmod 000` 的文件照常成功，
  // 于是 `status` 会把一条 open / switch 一读内容就失败的会话当成「最新原生会话」正常展示。
  // 链尾读不出来上面已经逐档说过（带链名与下一步），这里只报其余 tip，同一份文件不重复警告；
  // `tips[].unreadable` 这条事实照常带出，文本模式也照常标出
  const warnedFiles = new Set<string>();
  if (chainTipUnusable && chainTip) warnedFiles.add(chainTip.ref.filePath);
  const tips: ProviderTip[] = [];
  for (const t of allTips) {
    const readProblem = await probeSessionReadable(t.ref.filePath);
    const emptyFile = Boolean(readProblem && isEmptySessionFileReason(readProblem));
    if (readProblem && !warnedFiles.has(t.ref.filePath)) {
      // 0 字节与权限 / I/O 失败的下一步相反：内容已丢失，只能备份恢复或另开一条会话
      warnings.push(
        emptyFile
          ? `${t.provider} 的最新会话 ${escapeControlChars(t.ref.sessionId)} 的文件是空的：${readProblem}；` +
            'open 会拒绝它，按它 resume 也没有内容可恢复——先从备份恢复该文件（Watch 不会替你重建历史），或在原生 CLI 里另开一个会话'
          : `${t.provider} 的最新会话 ${escapeControlChars(t.ref.sessionId)} 的文件当前读不出来：${readProblem}；` +
            'open / switch 读这条会话时同样会失败——先确认该文件可读（权限、路径）再重试',
      );
    }
    tips.push({
      ...t,
      onChain: boundIds.get(t.provider)?.has(t.ref.sessionId) ?? false,
      ...(readProblem ? { unreadable: true } : {}),
      ...(emptyFile ? { emptyFile: true } : {}),
    });
  }
  return { tips, chainTip, chainTipUnusable, chainTipEmpty, chainTipTurns, ...(chainTipBadLines ? { chainTipBadLines } : {}), unreadable, history, historyFailed, ...(lineage ? { lineage } : {}), chain, chains, warnings };
}

/** 把链尾会话转换到 targetId，落 switch_events（store 可选）；opts.forceNew 强制新建目标会话（不追加既有配对） */
export async function handoff(
  targetId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  resolve: AdapterResolve,
  store?: Store | null,
  opts?: { forceNew?: boolean; chainId?: string; storeError?: string },
): Promise<HandoffResult> {
  const target = resolve(targetId);
  if (!target) throw new Error(unknownProviderMessage(targetId, adapters));
  const warnings: string[] = [];
  if (!store) {
    // 内容仍会交接，但没有 switch_events：status / 桌面端看不到这次切换，必须说明。
    // 原因同样要带出（`opts.storeError` 由 `cmdSwitch` 传 `lastStoreError`）：只说「库不可用」
    // 时用户不知道该修什么，而原因里本来就带着路径与下一步。
    warnings.push(storeUnavailableWarning('本次切换未写入链记录（status 与桌面端不会显示这次切换）', opts?.storeError));
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
    const shown = escapeControlChars(chainRow.name);
    throw new Error(`链已归档: ${shown}；可 watch chain use ${shown} 恢复，或省略 --chain 用当前链`);
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

  // 零结果时下面要判断「这个目录到底有没有会话」，所以要看这一轮谁压根没读成：
  // 读不出来 ≠ 没有，原因也要留住（throw 之后 `warnings` 到不了调用方手里）
  const unreadableTips: string[] = [];
  const unreadableReasons: { provider: string; reason: string }[] = [];
  const tips = await collectTips(cwd, adapters, warnings, unreadableTips, unreadableReasons);
  const mtimeTip = pickLatestTip(tips);
  if (!mtimeTip) {
    const chainTipRef = history.at(-1)?.toRef ?? null;
    if (chainTipRef) {
      // 同样只把 ENOENT / ENOTDIR 当「文件已不存在」：读不出来时要说清是权限还是路径，
      // 不能让人以为会话丢了、急着重新 adopt
      const tipPresence = await sessionFilePresence(chainTipRef.filePath);
      if (tipPresence.state === 'missing') {
        const copy = compressedCopy(tipPresence);
        throw new HandoffSourceReadError(
          copy
            ? `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${escapeControlChars(chainTipRef.sessionId)} 的文件${copy.note}：` +
                `${compressedRetryAdvice(copy, '再重试')}，或${rebindHint(chainTipRef.provider)}`
            : `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${escapeControlChars(chainTipRef.sessionId)} 文件已不存在（${escapeControlChars(chainTipRef.filePath)}）：` +
                `${rebindHint(chainTipRef.provider)}，或在原生 CLI 里新开一个会话`,
          chainTipRef,
          'missing',
          copy,
        );
      }
      if (tipPresence.state === 'unknown') {
        throw new Error(
          `未发现原生会话；链尾记录的 ${chainTipRef.provider} 会话 ${escapeControlChars(chainTipRef.sessionId)} 状态无法确认：${escapeControlChars(chainTipRef.filePath)}；${tipPresence.reason}` +
            `——可能是权限或路径问题，先确认它是否还在，再决定是否 watch switch ${chainTipRef.provider} 重新绑定`,
        );
      }
      // 路径被同名目录 / 设备文件占住：两个分支都不进就会落到下面通用的
      // 「请先在…里开聊」，把「路径不可用」讲成「目录里没东西」
      if (tipPresence.state === 'present' && !tipPresence.isFile) {
        throw new Error(
          `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${escapeControlChars(chainTipRef.sessionId)} 的路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(chainTipRef.filePath)}` +
            `——先恢复该路径，再决定是否 watch switch ${chainTipRef.provider} 重新绑定，或在原生 CLI 里新开一个会话`,
        );
      }
    }
    // 这一轮有几家压根没读成：零结果只说明「没列出来」，不能据此说「这个目录没有会话」，
    // 更不能给「换个 --cwd 写法」或「先开一次会话」这种下一步（换写法修不好权限 / 库的问题）。
    // `handoff()` 是 throw 出去的，下面 `warnings` 里那几条「读不出来」的原因用户根本拿不到，
    // 所以这里把原因内联进错误文案——2026-11-09 实测（修复前，隔离 HOME，claude / codex 两家
    // 存储 chmod 000）`watch switch codex --json` 的 error 只有「未发现原生会话；…把 --cwd 换成
    // /private/var/… 重试…请先在任一受支持的 Agent 里开聊」，一个字都没提那两次读取失败。
    if (unreadableTips.length) {
      const detail = unreadableReasons.map((u) => `${u.provider}（${escapeControlChars(u.reason)}）`).join('；');
      throw new Error(
        `无法确认这个目录里有没有可交接的会话：${detail}——这不代表这里没有会话，` +
          `先修好这些会话存储（权限、路径或库状态）再重试；本次未写入任何内容`,
      );
    }
    // 这一档与「读不出来」不同：文件读得出来，只是归属那一行坏了（Codex 的 `session_meta`
    // 首行 0 字节 / 半截 JSON），`findLatestSession` / `listSessions` 只能跳过它们。
    // 零结果是「没列出来」，不是「这里没有会话」——照原句给「请先在…开聊」会让人白开一个，
    // 而磁盘上那条可能正是要交接的。`warnings` 到不了调用方（这里是 throw），原因内联。
    const hiddenNote = unattributableNoPickMessage(await collectUnattributable(adapters));
    if (hiddenNote) {
      throw new Error(`${hiddenNote}；本次未写入任何内容`);
    }
    // 按字符串比较确实没有会话时，`--cwd` 仍可能只是同一个目录的另一种写法（软链 / 前缀 / 大小写）：
    // 只留「请先开聊」会把人引去开新会话，而原来的会话一直躺在另一个写法下面。
    // 与 status / sessions / recent 同一口径，零结果时才补这句（健康目录不多一遍 realpath）。
    const alias = await cwdAliasHint(cwd);
    const hint = noSessionHint(adapters);
    // 已知还有另一种写法时不能先说「请先开聊」再纠正：那句话是错的下一步，
    // 摆在最前面就会有人照着做。把它降级成「若确实是新目录」的补充分支。
    throw new Error(
      alias ? `未发现原生会话；${alias}；若确实是新目录，${hint}` : `未发现原生会话，${hint}`,
    );
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

  // 与 `describeResumeTargetUnfinished()` 的三处警告同一处赋值
  let targetUnfinished: TargetUnfinishedField = {};
  let resumeTargetContext: ContextDisclosuresField = {};
  // 零增量 / 追加两条分支里那条既有目标会话自己的声明；新建或旧目标被移走时保持 null
  let disclosedTargetTurns: UnifiedTurn[] | null = null;
  // 目标自己的上下文差异（OpenCode 回退标记、压缩记录等）不属于增量：resume 的就是这条会话，
  // 与 `open --from` / `--to` 复用同一口径——与来源同文时 warnings 只留一条。
  const discloseTargetContext = (turnsOfTarget: UnifiedTurn[]): void => {
    const context = findContextDisclosure(turnsOfTarget);
    if (context && !warnings.includes(context.summary)) warnings.push(context.summary);
    disclosedTargetTurns = turnsOfTarget;
  };

  // 文件可打开后仍需解析正文，才能确认是空会话、存在对话，还是内容无法核对。
  const checkResumeTarget = async (
    ref: SessionRef,
    readProblemReported: boolean,
  ): Promise<'parsed' | 'empty' | 'failed'> => {
    const subject = `目标会话 ${escapeControlChars(ref.sessionId)}（${target.displayName}）`;
    let resumeTurns: UnifiedTurn[];
    try {
      resumeTurns = await target.parse(ref);
    } catch (error) {
      // 读不出来不能静默返回 false：这条会话正是用户要 resume 的那一条，而「没有未完成轮次」
      // 与「读不出来所以没查」在 warnings 里不能长得一样。
      // 调用方（alreadyAtTarget 分支）刚推过的可读性警告已按文件形态给过原因与下一步：
      // 再复述一次 errno 会在压缩副本这件事上给出相反的下一步（「先确认文件可读」vs
      // 「让原生重新展开」），这里只补它没说的那一半——断点无法确认。
      if (readProblemReported) {
        warnings.push(
          `${subject} 读不出内容，无法确认它是否停在做了一半的一轮上（文件读不出来的原因见上一条警告）`,
        );
        return 'failed';
      }
      const copy = compressedCopy(await sessionFilePresence(ref.filePath));
      warnings.push(
        `${subject} 读不出内容，无法确认它是否停在做了一半的一轮上：` +
          `${copy?.note ?? describeReadFailureOrSelf(error)}；` +
          (copy ? compressedRetryAdvice(copy, '再 resume') : '先确认这个会话文件可读再 resume'),
      );
      return 'failed';
    }
    warnings.push(...describeResumeTargetUnfinished(resumeTurns, subject, 0));
    targetUnfinished = targetUnfinishedField(resumeTurns, 0);
    // 上下文完整性披露（转入后台 / context_edit / compacted）与 `open` 同一口径：
    // 用户复制的是这条 resume 命令，而这份日志的差异不会出现在链记录或 resume 命令里。
    const context = findContextDisclosure(resumeTurns);
    if (context) warnings.push(context.summary);
    resumeTargetContext = contextDisclosuresField(null, resumeTurns);
    return resumeTurns.length === 0 ? 'empty' : 'parsed';
  };

  let chainBoundToTarget = false;
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
          // 指纹必须早于 parse：两者之间被外部追加时，快照会含新内容而 destTurns 是旧的，
          // 按旧内容算出的增量会重复追加，写前比对却看不出差异（与 open --from 同一规则）
          destDigest = (await target.contentFingerprint?.(boundTarget)) ?? null;
          destTurns = await target.parse(boundTarget);
          into = boundTarget;
        } catch (error) {
          into = undefined;
          destDigest = null;
          // 「解析失败」把 ENOENT（文件被删）、压缩副本（原路径不在、同名 .zst 在）与格式问题
          // 讲成同一件事：压缩时文件还在，下一步是让原生展开，而不是重建历史
          const copy = compressedCopy(await sessionFilePresence(boundTarget.filePath));
          warnings.push(
            copy
              ? `目标会话 ${escapeControlChars(boundTarget.sessionId)} ${copy.note}；本次改为新建 ${target.displayName} 会话承接内容`
              : `目标会话 ${escapeControlChars(boundTarget.sessionId)} 无法沿用（${describeReadFailureOrSelf(error)}），改为新建会话承接内容`,
          );
        }
      }
    } else if (pairedRef(history, targetId)) {
      // 链上已显式绑定过 targetId（如 adopt / new 之后），且没有别的 provider 上链：
      // 不能再落入同目录其它 provider 的 mtime 兜底，否则游离会话会覆盖或污染链上绑定
      chainBoundToTarget = true;
    }
  }

  if (!sourceTip) {
    if (!chainBoundToTarget) {
      const other = tips.find((t) => t.provider !== targetId);
      sourceTip = mtimeTip.provider === targetId ? (other ?? null) : mtimeTip;
    }
    // 自动挑来源时同样只能说「在能读出的那些里最新」：这一档的文件不属于任何目录，
    // `findLatestSession` 会跳过它们，而用户要交接的可能正是被跳过的那一条。
    // 只看**同一家**的统计：别家读不出归属的文件与这次交接无关，说出来只是噪音。
    if (sourceTip) {
      const pickedProvider = sourceTip.provider;
      const hiddenPicks = (await collectUnattributable(adapters)).filter((s) => s.provider === pickedProvider);
      const pickWarning = unattributablePickWarning(
        hiddenPicks,
        '交接的来源',
        `你要交接的可能正是被跳过的那一条（可用 watch adopt ${pickedProvider} --session <会话 id> 显式绑定）`,
      );
      if (pickWarning) warnings.push(pickWarning);
    }
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
      // 这条分支从不写会话文件或链记录，拒绝生成命令是对的；但适配器守卫的短句会取代
      // 「链尾已是目标 / 文件能不能读 / 是不是空会话」这些已经查到的事实，所以就地降级成完整结论
      //（与 `watch new <同家>` 的只读分支同一口径，第 605 轮）。
      const resumeRefProblem = sessionIdCommandProblem(resumeRef.sessionId);
      if (resumeRefProblem) {
        throw new Error(
          `链尾已是 ${targetId}：会话 ${escapeControlChars(resumeRef.sessionId)} 无法生成恢复命令：${resumeRefProblem}；` +
            `本次未写入任何内容——请用 watch sessions 查看该会话，` +
            `如果挑错了会话，用 watch adopt ${targetId} --session <另一个会话 id> 换绑`,
        );
      }
      // 这条分支以前只回「直接打开即可」+ resume，而它和 status 一样只读元数据：
      // `stat` 对 chmod 000 的文件照常成功，于是同一份文件 new 明确拒绝、status 警告、
      // chain list 标 unreadable、doctor 报失败，只有 switch 替它宣称可用——用户复制的那条
      // resume 一执行就失败。这里探一次真正要 resume 的那条会话（只 open，不读内容）。
      const resumeReadProblem = await probeSessionReadable(resumeRef.filePath);
      // `probeSessionReadable()` 对原路径缺失只会说「已不存在」；只剩 .zst 时文件其实还在，
      // 这一步的下一步（让原生展开）与「被删」相反，必须单独说
      const resumeCompressed = resumeReadProblem
        ? compressedCopy(await sessionFilePresence(resumeRef.filePath))
        : null;
      const resumeEmptyFile = Boolean(resumeReadProblem && isEmptySessionFileReason(resumeReadProblem));
      if (resumeReadProblem) {
        warnings.push(
          resumeCompressed
            ? `链尾会话 ${escapeControlChars(resumeRef.sessionId)}（${targetId}）的文件${resumeCompressed.note}；下面那条 resume 命令一执行就会失败——` +
              (resumeCompressed.kind === 'empty'
                ? `从备份恢复后再试，或 watch adopt ${targetId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`
                : `${resumeCompressed.advice}，再重试，或 watch adopt ${targetId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`)
            : resumeEmptyFile
              ? `链尾会话 ${escapeControlChars(resumeRef.sessionId)}（${targetId}）的文件是空的：${resumeReadProblem}；` +
                `下面那条 resume 没有内容可恢复——先从备份恢复该文件（Watch 不会替你重建历史）再重试` +
                `，或 watch adopt ${targetId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`
              : `链尾会话 ${escapeControlChars(resumeRef.sessionId)}（${targetId}）的文件现在读不出来：${resumeReadProblem}；` +
                `下面那条 resume 命令一执行就会失败——先修好这个文件（权限或内容）再重试` +
                `，或 watch adopt ${targetId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`,
        );
      }
      const resumeTargetStatus = await checkResumeTarget(resumeRef, Boolean(resumeReadProblem));
      // 文件探测已披露 0 字节等读取故障。下面的两档只记录探测通过后的解析结果。
      const resumeParseFailed = !resumeReadProblem && resumeTargetStatus === 'failed';
      const resumeTargetReadableEmpty = !resumeReadProblem && resumeTargetStatus === 'empty';
      let resumeTargetBadLines: UnparsableLines | undefined;
      if (resumeTargetReadableEmpty) {
        // 与 status / chain list / doctor / new 同档：parse 跳过坏行，0 轮也可能是截断文件。
        const subject = `目标会话 ${escapeControlChars(resumeRef.sessionId)}（${target.displayName}）`;
        const badScan = await scanUnparsableJsonLines(resumeRef.filePath, { allowMissing: false });
        resumeTargetBadLines = unparsableLinesField(null, badScan).unparsableLines;
        warnings.push(
          `${subject} 解析出 0 轮（没有可继续的对话）：` +
            describeZeroTurnReason(
              badScan,
              `可能是刚建出来的空会话，也可能内容已被清空`,
              badScan.error
                ? ''
                : zeroTurnResumeClaim(badScan, `下面这条 resume 打开的是空会话——`) +
                  `如果它本该有历史，先在 ${target.displayName} 里打开它确认，或从备份恢复该文件（Watch 不会替你重建历史）；` +
                  `如果挑错了会话，用 watch adopt ${targetId} --session <另一个会话 id> 换绑`,
            ),
        );
      }
      const resumeEmptyKind = resumeReadProblem && isEmptySessionFileReason(resumeReadProblem)
        ? 'zero-byte'
        : resumeTargetReadableEmpty
          ? 'zero-turns'
          : null;
      return {
        newRef: resumeRef,
        resumeCommand: target.resumeCommand(resumeRef),
        fromProvider: targetId,
        turnCount: 0,
        alreadyAtTarget: true,
        chainTipState,
        // 这条分支从不写链记录：调用方不得据此说「这次写了链记录」（第 310 轮）
        chainRecordState: 'not-attempted',
        ...(resumeReadProblem ? { resumeUnreadable: true } : {}),
        ...(resumeCompressed ? { resumeCompressed: resumeCompressed.kind } : {}),
        ...(resumeParseFailed ? { resumeParseFailed: true } : {}),
        ...(resumeTargetReadableEmpty ? { resumeTargetEmpty: true } : {}),
        ...(resumeTargetBadLines ? { unparsableLines: resumeTargetBadLines } : {}),
        ...emptySessionsField(null, resumeEmptyKind),
        ...targetUnfinished,
        ...resumeTargetContext,
        warnings,
        findings,
      };
    }
    if (into === undefined && mtimeTip.provider === targetId) {
      try {
        // 与链绑定分支同一顺序：先指纹再 parse
        destDigest = (await target.contentFingerprint?.(mtimeTip.ref)) ?? null;
        destTurns = await target.parse(mtimeTip.ref);
        into = mtimeTip.ref;
      } catch (error) {
        into = undefined;
        destDigest = null;
        const copy = compressedCopy(await sessionFilePresence(mtimeTip.ref.filePath));
        warnings.push(
          copy
            ? `目标会话 ${escapeControlChars(mtimeTip.ref.sessionId)} ${copy.note}；本次改为新建 ${target.displayName} 会话承接内容`
            : `目标会话 ${escapeControlChars(mtimeTip.ref.sessionId)} 无法沿用（${describeReadFailureOrSelf(error)}），改为新建会话承接内容`,
        );
      }
    }
  }

  // 只校验最终沿用的既有目标，不拦只读来源；放在解析失败的兜底 catch 外，拒绝不能退成新建。
  // 零增量也可能重写目标或只改链尾，必须早于这些副作用，不能等末端 resumeCommand 才拒绝。
  // 新目标的 ID 由 provider 写入时生成，仍由适配器的末端守卫校验。
  // 拒绝时链记录与目标文件都没有动过：守卫短句要带上这两条事实，用户才知道不用回查链
  //（与上面 `new` 的只读分支同一口径，第 608 轮）。目标可能来自链绑定，也可能是按
  // 修改时间挑中的会话，文案不假定它是哪一种。
  if (into) {
    const intoProblem = sessionIdCommandProblem(into.sessionId);
    if (intoProblem) {
      throw new Error(
        `要切换到 ${targetId} 需要复用会话 ${escapeControlChars(into.sessionId)}，但它无法生成恢复命令：${intoProblem}；` +
          `本次未写入任何内容（会话文件与链记录都没有改动）——用 watch adopt ${targetId} --session <另一个会话 id> 换绑，` +
          '或从 watch sessions 里挑一条不以 \'-\' 开头的会话',
      );
    }
  }

  // 目标侧的坏行同样会让 diffTurns 把「已有但解析不出」的内容当缺失、重复追加一遍
  let destBadScan: BadLinesScan = { count: 0 };
  let destBadScanFailure: string | null = null;
  if (into) {
    destBadScan = await scanUnparsableJsonLines(into.filePath, { allowMissing: false });
    if (destBadScan.count > 0) {
      warnings.push(
        `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）有 ${destBadScan.count} 行无法解析（截断或损坏）：增量判定可能偏多，可能重复追加既有内容`,
      );
    }
    destBadScanFailure = describeBadLinesScanFailure(
      destBadScan,
      `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）`,
      '增量判定是否偏多无法确认——先确认该文件可读再重试',
    );
    if (destBadScanFailure) warnings.push(destBadScanFailure);
  }

  const source = resolve(sourceTip.provider);
  if (!source) throw new Error(`链尾 provider 未注册: ${escapeControlChars(sourceTip.provider)}`);

  // 来源侧没有守卫（目标侧才是 TOCTOU 保护的对象）：快照取在 parse 之前，
  // 写完之后再比一次，期间被追加的那一段要披露，不能被讲成「整条会话都交接了」
  const srcSnapshot = await snapshotSourceState(sourceTip.ref.filePath);
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
    // 原路径缺失时先分清「被删」与「只剩同名 .zst 压缩副本」：后者文件还在、
    // 让原生继续一次就会展开，rebind 反而会丢掉这条会话的历史
    const copy = gone ? compressedCopy(await sessionFilePresence(sourceTip.ref.filePath)) : null;
    const reason = copy
      ? `文件${copy.note}；链记录仍指向它——${compressedRetryAdvice(copy, '再重试')}，或${rebindHint(sourceTip.provider)}`
      : gone
      ? `文件 ${escapeControlChars(sourceTip.ref.filePath)} 已不存在，而链记录仍指向它：${rebindHint(sourceTip.provider)}，或用 watch sessions 查看该目录还有哪些可接力的会话`
      : code === 'EACCES' || code === 'EPERM'
        ? `文件 ${escapeControlChars(sourceTip.ref.filePath)} 无权读取（权限问题，不是被删除）：先修权限或换一个有权限的路径，再重试`
        : `文件 ${escapeControlChars(sourceTip.ref.filePath)} 读不出来：如果只是格式坏掉可先确认文件内容；确认文件确实没了再 watch switch ${sourceTip.provider} 重新绑定`;
    const knownFsError = gone || code === 'EACCES' || code === 'EPERM';
    const detail = knownFsError ? '' : `${describeReadFailureOrSelf(error)}；`;
    const state = gone ? 'missing' : knownFsError ? 'denied' : 'unreadable';
    throw new HandoffSourceReadError(
      `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）读取失败：${detail}${reason}`,
      sourceTip.ref,
      state,
      copy,
    );
  }
  // 各家 parse 对坏行一律跳过：跳过的内容既不在 turns 里，也不会被 round-trip 查出（两边都按解析结果比），
  // 不主动扫一遍就会把「少了几轮」当成完整交接
  const sourceBadScan = await scanUnparsableJsonLines(sourceTip.ref.filePath, { allowMissing: false });
  if (sourceBadScan.count > 0) {
    warnings.push(
      `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）有 ${sourceBadScan.count} 行无法解析（截断或损坏），已跳过；交接内容可能不完整，可在原生 CLI 里打开确认`,
    );
  }
  const sourceBadScanFailure = describeBadLinesScanFailure(
    sourceBadScan,
    `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）`,
    '交接内容是否完整无法确认——先确认该文件可读再重试，可在原生 CLI 里打开确认',
  );
  if (sourceBadScanFailure) warnings.push(sourceBadScanFailure);
  // Pi 的上下文编辑 / 扩展消息、Codex 的压缩记录会造成来源上下文差异。
  // 披露事件可能随增量被裁掉，目标也不一定保留，必须单独进入 warnings。
  const contextDisclosure = findContextDisclosure(turns);
  if (contextDisclosure) warnings.push(contextDisclosure.summary);
  // 同上，工具调用没有结果（Ctrl-C、用量耗尽、resume 重放过半截）在两处检查里都看不出来：
  // `diffTurns` 只比解析结果，round-trip 只比「写进去的内容」。`switch` 是 CLI 主路径，
  // 不披露就会把「那一轮做了一半」当成完整交接。
  const sourceLabel = `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）`;
  const dangling = describeDanglingToolCalls(turns, sourceLabel);
  if (dangling) warnings.push(dangling);
  // 「用户说完、模型没回」是同一种中断的另一形状：`diffTurns` 会把这句悬空的问题当成新内容
  // 照常并入目标，round-trip 两边都含它所以校验通过——不主动披露就会把半轮当完整交接。
  const unanswered = describeUnansweredTail(turns, sourceLabel);
  if (unanswered) warnings.push(unanswered);
  // 附件原始数据不参与 round-trip（attachment 挂在 text 事件上），目标写不进去时也不会有任何一处报错：
  // 目标会话照常可读、校验照常通过，只是图片 / 文件没了。交接前按目标自报的能力主动披露。
  const attachmentLoss = describeAttachmentLoss(turns, target);
  if (attachmentLoss) warnings.push(attachmentLoss);
  // Bash 类工具的工作目录 / 超时 / 后台标记会被目标重建掉（Claude 与 Codex 的写入侧会重新派生入参）：
  // 命令本身照常写入，但这几项执行条件不会，主动披露避免下一跳把历史当成「没设过」。
  const bashControlLoss = describeBashControlLoss(turns, target);
  if (bashControlLoss) warnings.push(bashControlLoss);
  // 与上面两句警告同一处取数；过程文本 / 失败标记要等真的写入后才知道（见 guardedWrite）
  const lossCounts = {
    attachments: countAttachmentLoss(turns, target),
    bashControls: countBashControlLoss(turns, target),
    textEvents: 0,
    toolFailures: 0,
  };
  // 目标级保护：传入即将写入的会话，Codex 据此检查 per-thread writer 锁（而非只看 Desktop 是否运行）
  await target.preflight?.({ ref: into, cwd });
  // 协作写锁：供应商支持时在写入期间独占原生锁，收窄与原生 writer 的竞态窗口
  const guardedWrite = async (turnsToWrite: UnifiedTurn[], opts?: ImportTurnsOpts): Promise<SessionRef> => {
    const lock = into ? await target.acquireWriteLock?.({ ref: into }) : undefined;
    // 锁路径准备失败等可修故障：降级为只探测，但必须披露，不能把「没有锁」讲成「有保护」
    if (lock?.warning) warnings.push(lock.warning);
    const guard = lock?.guard;
    try {
      // 取锁后再比对指纹：把与原生 writer 的竞态窗口收窄到「快照 → 取锁」之间
      await assertDestUnchanged();
      try {
        // 按实际写入的内容计数，也覆盖零增量但整份重写目标的分支。
        const textLoss = describeTextEventLoss(turnsToWrite, target);
        const failureLoss = describeToolFailureLoss(turnsToWrite, target);
        const written = await target.importTurns(turnsToWrite, cwd, into, opts);
        if (textLoss) warnings.push(textLoss);
        if (failureLoss) warnings.push(failureLoss);
        lossCounts.textEvents = countTextEventLoss(turnsToWrite, target);
        lossCounts.toolFailures = countToolFailureLoss(turnsToWrite, target);
        return written;
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

  // 目标能力参与对账：写不进去的事件（用户侧文本 / 同文助手文本 / 不支持的附件）不算「缺过程事件」，
  // 否则每次交接都会判成需要整份重写（第九十三轮）。
  const replace = Boolean(into && shouldReplacePairedSession(turns, destTurns, target));
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
    // 0 轮有两种形状：`watch new` 建出来的合法空会话（各适配器都写了占位内容，文件非空），
    // 与会话文件被截成 0 字节（进程被杀 / 只写了一半 / 磁盘满，内容已经丢了）。两者都落到
    // 「没有可交接的内容」，但下一步相反：前者可以另起一条链从零开新会话，后者只能从备份恢复。
    // 只探 `turns.length === 0` 的情形——有内容时文件是否空着已无意义，也不该多一次 open。
    const emptySourceFile = turns.length === 0 ? await probeSessionReadable(sourceTip.ref.filePath) : null;
    const emptiedSourceFile = emptySourceFile && isEmptySessionFileReason(emptySourceFile) ? emptySourceFile : null;
    // 来源会话本身是空的（`watch new` 建出来的 0 轮会话最典型），目标侧也没有可沿用的会话：
    // 没有任何内容可交接。以前这里照样往下走，把 `toProvider` 记成目标、`toRef` 记成**来源**
    // 那个会话，于是同一份结果里 `resumeCommand` 是 `claude --resume <codex 的 id>`（照抄必然失败），
    // `status` 里 `chainTip.provider`（claude）与 `chainTip.ref.provider`（codex）互相矛盾，
    // 文本模式还印「已从 codex 交接 → claude（0 轮）」。同一个操作走 `open <id> --to` 一直
    // 老实拒绝（「没有可转入的内容」），两条路径对同一件事给出两套结论。
    if (!into && turns.length === 0) {
      // 0 字节不是「这条会话本来就没内容」：内容已经没了，下一步是恢复备份而不是开新会话。
      // 以前两种形状共用同一句「没有任何可交接的内容（0 轮）」，而 sessions / recent / doctor /
      // status / chain list 从 283 轮起都已经会说「0 字节，内容已丢失」——只有真正要 resume 的
      // 这条路径把「内容丢了」讲成「本来就没有」。
      const tipAfter = chainTipAfterNoWrite({ history, historyFailed, store, adapters });
      // throw 之后 `warnings` 到不了调用方：这次运行里已经算出的坏行数 / 坏行扫不成
      // 必须内联，否则「0 轮」就只剩「本来就没有内容」这一种解释——而这正是把
      // 「读不出来」讲成「没有」。第 345 轮审计（0 字节那一档此前已单列）。
      const zeroTurnFacts =
        sourceBadScan.count > 0
          ? `该文件里有 ${sourceBadScan.count} 行无法解析（截断或损坏），内容可能是被截断而不只是「本来就没有」`
          : sourceBadScanFailure
            ? `该文件的坏行无法统计，内容是否被截断无法确认`
            : null;
      const lead = emptiedSourceFile
        ? `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）的${emptiedSourceFile}；` +
          `没有任何可交接的内容（0 轮），${tipAfter}。` +
          `如果这条会话本该有内容，先从备份恢复该文件（Watch 不会替你重建历史）再重试；`
        : `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）没有任何可交接的内容（0 轮）：` +
          `${zeroTurnFacts ? `${zeroTurnFacts}。` : ''}${tipAfter}。` +
          // 有坏行 / 扫描未完成时不能再追加「可能已被清空」：同一句里刚说过更可能是截断
          (sourceBadScan.count > 0 || sourceBadScan.error
            ? `如果这条会话本该有内容，先在 ${source.displayName} 里打开它确认文件完整性，或从备份恢复该文件（Watch 不会替你重建历史）。`
            : `如果这条会话本该有内容，先在 ${source.displayName} 里打开它确认（可能已被清空），或从备份恢复该文件（Watch 不会替你重建历史）。`);
      throw new HandoffEmptySourceError(
        lead +
          zeroTurnNextStep({ target, targetId, store, history, historyFailed }),
        { source: emptiedSourceFile ? 'zero-byte' : 'zero-turns' },
        unparsableLinesField(sourceBadScan, null).unparsableLines,
      );
    }
    const resumeRef = into ?? mtimeTip.ref;
    // 零增量分支同样要分档：目标已包含全部内容时结果里只有 `turnCount:0`，而 0 轮既可能是
    // 「来源本来就没内容」也可能是「来源文件被截成 0 字节」——后者内容已经丢了，一句不提
    // 就等于替一次内容丢失宣称「无需交接」。
    if (into && emptiedSourceFile) {
      warnings.push(
        `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）的${emptiedSourceFile}；` +
          `这次没有任何内容可交接，目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）未被改动` +
          `——如果这条会话本该有内容，先从备份恢复该文件再重试（Watch 不会替你重建历史）`,
      );
    }
    // 来源 0 轮、文件却不是 0 字节：合法空会话（`watch new` / `adopt` 进来的新会话）与
    // 「内容被清空、只剩占位头」两种形状都落在这里。以前既不拒绝也不披露，直接回 ok +
    // turnCount:0，文本模式还印「已从 X 交接 → Y（0 轮）」——与「来源 0 轮必须拒绝或披露」相悖。
    // 有 `into` 时不能拒绝（用户就是要切到目标那一侧），所以披露；目标同样不改动。
    //
    // 这条披露里的「只把链尾切到 X」依赖下面 recordSwitch 的结果：写失败 / 无库时链尾根本
    // 没切。先攒着，等 chainRecordState 定下来再按三态推（第 311 轮）。
    let zeroTurnDisclosure:
      | { head: string; targetName: string; targetLabel: string; sourceName: string; sourceProvider: string }
      | null = null;
    // 零增量时 resume 命中的就是既有目标：先探一次它现在的文件状态。
    // 0 字节 / 可读 0 轮进入 `emptySessions.target`；缺失或读不出来必须披露，
    // 不能让一条可能打不开的 resume 看起来与健康恢复一样（与 alreadyAtTarget 同口径）。
    let zeroIncrementTargetKind: 'zero-byte' | 'zero-turns' | null = null;
    let zeroIncrementTargetUnreadable = false;
    const targetPresence = into ? await probeSessionReadable(into.filePath) : null;
    if (into) {
      const targetZeroByte = Boolean(targetPresence && isEmptySessionFileReason(targetPresence));
      if (targetZeroByte) {
        warnings.push(
          `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）的${targetPresence}；` +
            `它原有的历史已经没了，这条 resume 打开的是空会话——先从备份恢复那次丢失的内容（Watch 不会替你重建历史）`,
        );
      } else if (targetPresence) {
        // 解析成功过、探测时却不见了或读不出来（被移走 / 权限变化）：这次不写入，但 resume 仍指向它
        zeroIncrementTargetUnreadable = true;
        warnings.push(
          `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）的${targetPresence}；` +
            `这次没有可写入的增量，但这条 resume 仍指向它，可能无法打开——${rebindHint(targetId)}`,
        );
      } else if (destTurns.length === 0) {
        // 坏行 / 扫描未完成时，0 轮更可能是截断而非空会话：与来源侧同一规则，
        // 「打开的是空会话」只能出现在干净扫描之后。
        const targetScanDirty = destBadScan.count > 0 || Boolean(destBadScan.error);
        warnings.push(
          targetScanDirty
            ? `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）解析出 0 轮：` +
              `${describeZeroTurnReason(destBadScan, '可能已被清空')}；这次 resume 打开的不一定是空会话`
            : `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）解析出 0 轮；` +
              `这条 resume 打开的是空会话——如果它本该有内容，先在原生 CLI 里打开确认（可能已被清空），或从备份恢复该文件（Watch 不会替你重建历史）`,
        );
      }
      zeroIncrementTargetKind = targetZeroByte
        ? 'zero-byte'
        : targetPresence
          ? null
          : destTurns.length === 0
            ? 'zero-turns'
            : null;
    }
    if (into && turns.length === 0) {
      if (!emptiedSourceFile) {
        const subject = `来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）`;
        const reason = sourceBadScan.count > 0
          ? `文件里有 ${sourceBadScan.count} 行无法解析（截断或损坏），这些内容已被跳过——更可能是文件被截断或损坏，不能当成「刚建出来的空会话」`
          : sourceBadScanFailure ?? '可能已被清空';
        zeroTurnDisclosure = {
          head:
            `${subject} 解析出 0 轮，没有可接力的对话：${reason}` +
            `${sourceBadScanFailure ? `；${sourceBadScanFailure}` : ''}；`,
          targetName: target.displayName,
          targetLabel: `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）`,
          sourceName: source.displayName,
          sourceProvider: sourceTip.provider,
        };
      }
      // 目标也可能同时是空会话（两边都没内容）：这次 resume 打开的就是它，
      // 不能只说「目标未被改动」。非零增量分支有一模一样的披露（`emptiedTarget`）。
      // 一次探测同时决定警告与 `emptySessions.target`；只有「现在读得出且非 0 字节」
      // 才能按解析结果报 `zero-turns`，读不出来（缺失 / 权限）时不下空会话结论。
      const targetPresence = await probeSessionReadable(into.filePath);
      const targetZeroByte = Boolean(targetPresence && isEmptySessionFileReason(targetPresence));
      if (targetZeroByte) {
        warnings.push(
          `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）的${targetPresence}；` +
            `它原有的历史已经没了，这条 resume 打开的是空会话——先从备份恢复那次丢失的内容（Watch 不会替你重建历史）`,
        );
      } else if (!targetPresence && destTurns.length === 0) {
        // 坏行 / 扫描未完成时，0 轮更可能是截断而非空会话：与来源侧同一规则，
        // 「打开的是空会话」只能出现在干净扫描之后。
        const targetScanDirty = destBadScan.count > 0 || Boolean(destBadScan.error);
        warnings.push(
          targetScanDirty
            ? `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）解析出 0 轮：` +
              `${describeZeroTurnReason(destBadScan, '可能已被清空')}；这次 resume 打开的不一定是空会话`
            : `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）解析出 0 轮；` +
              `这条 resume 打开的是空会话——如果它本该有内容，先在原生 CLI 里打开确认（可能已被清空），或从备份恢复该文件（Watch 不会替你重建历史）`,
        );
      }
      zeroIncrementTargetKind = targetZeroByte
        ? 'zero-byte'
        : !targetPresence && destTurns.length === 0
          ? 'zero-turns'
          : null;
    }
    // 这次零增量：目标会话已包含全部内容，结果里那条 resume 落在 `into` 自己身上。
    // 它停在做了一半的一轮上时要说——与 `open` 的目标侧同一口径（`merged = 0`，两种形状都说）。
    if (into) {
      warnings.push(
        ...describeResumeTargetUnfinished(destTurns, `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）`, 0),
      );
      targetUnfinished = targetUnfinishedField(destTurns, 0);
      discloseTargetContext(destTurns);
    }
    // 目标 session 已包含全部最新内容，无需追加增量；但用户主动切回来时，
    // 仍应把链尾更新为目标 provider，否则桌面端状态会停留在旧 provider。
    // 此外，旧版本写出的 Kimi wire.jsonl 可能存在 stepUuid 不匹配等格式
    // 损坏，导致 Kimi 无法识别历史；对已有目标 session 强制 rewrite 可修复。
    const notes: string[] = [];
    if (into) {
      let rewroteTarget = false;
      try {
        // 来源 0 轮时没有可对账的内容：不重写目标。以前 `guardedWrite(空 turns, {replace:true})`
        // 恰好是空操作，这条契约（「空来源不改动目标」）由既有回归锁住；换用 mergeTurns 后
        // 载荷变成目标自己的轮次，重写会换掉目标文件的 uuid——没有收益，只有数据搅动。
        if (turns.length > 0) {
          // 重写载荷不能是来源轮次：零增量只说明「来源是目标的子序列」，目标可能承接之后
          // 又在原生 CLI 里继续聊过（目标独有的轮次根本不参与 diffTurns 比较）。用来源整份
          // 覆盖会把它们静默删掉，而结果只有 `turnCount: 0`。mergeTurns 保留目标独有轮次、
          // 并在来源过程事件更全时取来源那份——与非零增量的 replace 分支是同一份载荷。
          await guardedWrite(dedupeCallEvents(mergeTurns(turns, destTurns)), { replace: true });
          rewroteTarget = true;
          addFinding(findings, 'handoff.rewrite_only', 'synthesized', 1);
        }
      } catch (error) {
        if (error instanceof HandoffBlockedError) throw error;
        const reason = describeWriteFailureReason(error) ?? (error instanceof Error ? error.message : String(error));
        // 原因可能是上游 errno 文案或路径，终端出口统一转义；Error 对象本身会带堆栈与裸 ESC
        console.error('[watch] 重写目标 session 失败，仍尝试 resume:', escapeControlChars(reason));
        warnings.push(`重写目标会话失败，目标内容可能未更新: ${reason}`);
      }
      // 零增量不等于零写入：rewrite_only 会整份重写目标，来源的推定时间按原值留在那里。
      // 这里按来源轮数披露，不用 mergeTurns 后的总数（目标独有轮次的时间来自目标自己）。
      if (rewroteTarget && source.timingNote && turns.length > 0) {
        notes.push(describeInferredTimeWrite(source.timingNote, turns.length));
      }
    }
    let chainRecordState: 'written' | 'failed' | 'not-attempted' = 'not-attempted';
    if (store && sourceTip) {
      try {
        const id = store.getOrCreateChainSession(cwd, opts?.chainId);
        store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, resumeRef);
        chainRecordState = 'written';
      } catch (error) {
        chainRecordState = 'failed';
        warnings.push(chainRecordFailureWarning(store, cwd, opts?.chainId, error));
      }
    }
    // 来源 0 轮的披露推迟到这里：链尾到底切没切，要看上面 recordSwitch 的结果。
    // 写失败 / 无库时它仍必须出现（0 轮披露不能丢），但只能讲「链尾没有切到」。
    if (zeroTurnDisclosure) {
      const d = zeroTurnDisclosure;
      const chainTail =
        chainRecordState === 'written'
          ? `本次只把链尾切到 ${d.targetName}`
          : chainRecordState === 'failed'
            ? `本次链记录写入失败，链尾没有切到 ${d.targetName}`
            : `本次没有写入链记录（本地库不可用），链尾没有切到 ${d.targetName}`;
      warnings.push(
        `${d.head}${chainTail}，${d.targetLabel}未被改动` +
          `——如果这条会话本该有内容，先在 ${d.sourceName} 里打开它确认，或从备份恢复该文件（Watch 不会替你重建历史）；` +
          `如果只是挑错了会话，用 watch adopt ${d.sourceProvider} --session <另一个会话 id> 换绑`,
      );
    }
    return {
      newRef: resumeRef,
      resumeCommand: target.resumeCommand(resumeRef),
      fromProvider: sourceTip?.provider ?? targetId,
      turnCount: 0,
      zeroIncrementReason: turns.length === 0 ? 'source-empty' : 'up-to-date',
      ...(zeroIncrementTargetUnreadable ? { resumeUnreadable: true } : {}),
      // 来源一侧按解析 / 抽查结果分档；目标一侧只在上面确认它是空会话时报告
      ...emptySessionsField(
        turns.length === 0 ? (emptiedSourceFile ? 'zero-byte' : 'zero-turns') : null,
        zeroIncrementTargetKind,
      ),
      ...(notes.length ? { notes } : {}),
      chainRecordState,
      ...unparsableLinesField(sourceBadScan, destBadScan),
      ...contentLossField(lossCounts),
      ...sourceUnfinishedField(turns),
      ...targetUnfinished,
      ...contextDisclosuresField(turns, disclosedTargetTurns),
      warnings,
      findings,
    };
  }

  // 目标会话被截成 0 字节时（进程被杀 / 只写了一半 / 磁盘满），`parse` 只得到 0 轮，
  // 增量于是等于「来源的全部内容」，与「目标还是个空壳」逐字相同。以前这里直接写进去，
  // 结果里只有「已从 X 交接 → Y（N 轮）」，用户不知道 Y 侧原有的历史已经没了——而
  // `open <目标> --from <来源>` 对同一形状早已披露（`zeroByteSessionReason`），`switch`
  // 又是 resume 命令最常被复制的地方，不能比它更安静。必须在 `guardedWrite` **之前**探：
  // 写完之后文件就不再是 0 字节了。
  const emptiedTargetFile = into && destTurns.length === 0 ? await probeSessionReadable(into.filePath) : null;
  const emptiedTarget =
    emptiedTargetFile && isEmptySessionFileReason(emptiedTargetFile) ? emptiedTargetFile : null;

  const newRef = await guardedWrite(dedupeCallEvents(outgoing), replace ? { replace: true } : undefined);
  // provider 写入时生成的新 ID 只有事后才知道，它同样必须能拼进恢复命令。目标文件已经写入，
  // 不能等到末端 `target.resumeCommand(newRef)` 才暴露成普通失败——那会让用户以为这次交接没写成。
  // 在链记录之前拒绝：链尾不指向一个生成不出命令的 ID，用户还能从结果里知道写入已经发生。
  const newRefProblem = sessionIdCommandProblem(newRef.sessionId);
  if (newRefProblem) {
    throw new Error(
      `目标会话已写入 ${escapeControlChars(newRef.sessionId)}，但没有生成恢复命令：${newRefProblem}；` +
        `这次写入已经发生，链记录没有更新——请用 watch 查看该会话`,
    );
  }
  const vanished = into && !replace ? describeVanishedTarget(into, newRef, target.displayName) : null;
  if (vanished) warnings.push(vanished);
  const targetEmptyKind = into && !vanished && destTurns.length === 0 && outgoing.length > 0
    ? (emptiedTarget ? 'zero-byte' : 'zero-turns')
    : null;
  // 期间来源被追加：交接的内容只到读取那一刻。只在真的写入了内容时说（`outgoing` 为空时
  // 这句「交接的是…」会与「已全部包含」自相矛盾）
  let driftFields: SourceDriftFields = {};
  if (outgoing.length > 0) {
    const change = await sourceChangeSince(sourceTip.ref.filePath, srcSnapshot);
    driftFields = sourceDriftFields(change);
    const drift = await describeSourceChangedDuringHandoff(
      sourceTip.ref.filePath,
      srcSnapshot,
      `${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）`,
      '交接',
      change,
    );
    if (drift) warnings.push(drift);
  }
  if (emptiedTarget && into) {
    warnings.push(
      `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）的${emptiedTarget}；` +
        `它原有的历史已经没了，本次并入的只有来源会话 ${escapeControlChars(sourceTip.ref.sessionId)}（${source.displayName}）的 ${outgoing.length} 轮内容` +
        `——如果这条会话本该有更早的历史，先从备份恢复那次丢失的内容（Watch 不会替你重建历史）`,
    );
  }
  // 目标解析出 0 轮、文件却不是 0 字节：可能是刚建出来的空会话（本次并入就是它的第一批内容），
  // 也可能是内容被清空只剩占位头的会话。与 `open <目标> --from <来源>` 同一句口径（notes 层，
  // 不是 warning）：首条链「new 一个空会话再切过去」是正常路径，不该每次都冒降级警告；
  // 但「本该有更早历史」的人得知道这条会话现在只有这 N 轮。
  const notes: string[] = [];
  // replace 分支的 outgoing 是 mergeTurns 的整份载荷，目标独有轮次的时间来自目标自己，
  // 不能算成「来源按原值写入」；只有来源轮数才带 source.timingNote。
  const inferredTimeTurnCount = replace ? turns.length : outgoing.length;
  if (source.timingNote && inferredTimeTurnCount > 0) {
    // 推定时间按原值写进目标记录：结果说明里不说来路，读者会把目标里的时间戳当真实发生时间。
    notes.push(describeInferredTimeWrite(source.timingNote, inferredTimeTurnCount));
  }
  if (into && targetEmptyKind === 'zero-turns') {
    // `parse` 跳过坏行：解析出 0 轮不等于文件里只有这次并入的内容。坏行在（或扫不成）时
    // 断言「就是它的全部内容」正是把「读不出来」讲成「没有」（第 345 轮审计）。
    const zeroDestRest =
      destBadScan.count > 0
        ? `文件里有 ${destBadScan.count} 行无法解析（截断或损坏），本次并入的 ${outgoing.length} 轮不能算作它的全部内容`
        : destBadScanFailure
          ? `坏行扫描未能完成，无法确认本次并入的 ${outgoing.length} 轮是否已包含它的全部内容`
          : `本次并入的 ${outgoing.length} 轮就是它的全部内容`;
    notes.push(
      `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）解析出 0 轮（没有可复用的对话）：${zeroDestRest}` +
        `——如果它本该有更早的历史，先从备份恢复该文件再重试（Watch 不会替你重建历史）`,
    );
  }
  if (vanished) addFinding(findings, 'handoff.target_recreated', 'degraded', 1);
  else if (replace) addFinding(findings, 'handoff.rewrite', 'degraded', destTurns.length);
  else addFinding(findings, 'handoff.append', 'exact', outgoing.length);
  // 追加之后最后一条 turn 已是并入的内容，「最后停在用户消息上」不再成立（merged > 0 只报
  // 工具调用没有结果这条 —— 它并入多少轮都不会闭合）。上面来源侧那条说的是另一条会话。
  if (into && !vanished) {
    warnings.push(
      ...describeResumeTargetUnfinished(
        destTurns,
        `目标会话 ${escapeControlChars(into.sessionId)}（${target.displayName}）`,
        outgoing.length,
      ),
    );
    targetUnfinished = targetUnfinishedField(destTurns, outgoing.length);
    discloseTargetContext(destTurns);
  }

  let chainRecordState: 'written' | 'failed' | 'not-attempted' = 'not-attempted';
  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, opts?.chainId);
      store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, newRef);
      chainRecordState = 'written';
    } catch (error) {
      console.error(
        '[watch] 记录 switch_events 失败，交接仍完成:',
        escapeControlChars(describeStoreErrorReason(error)),
      );
      chainRecordState = 'failed';
      // 建链与写记录是两次提交：空库上建出来的链已在库里，失败后 chain list 会凭空多
      // 一条没有任何切换记录的「默认」。零增量分支从第 311 轮起就用这个函数，追加分支
      // 漏掉了（第 345 轮审计）。
      warnings.push(chainRecordFailureWarning(store, cwd, opts?.chainId, error));
    }
  }

  return {
    newRef,
    resumeCommand: target.resumeCommand(newRef),
    fromProvider: sourceTip.provider,
    turnCount: outgoing.length,
    ...(notes.length ? { notes } : {}),
    chainRecordState,
    ...(vanished ? targetRecreatedField(into, newRef) : {}),
    ...driftFields,
    ...emptySessionsField(null, targetEmptyKind),
    ...unparsableLinesField(sourceBadScan, destBadScan),
    ...contentLossField(lossCounts),
    ...sourceUnfinishedField(turns),
    ...targetUnfinished,
    ...contextDisclosuresField(turns, disclosedTargetTurns),
    warnings,
    findings,
  };
}
