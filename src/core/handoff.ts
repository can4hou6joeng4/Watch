import type { ImportTurnsOpts, ProviderAdapter } from '../providers/adapter.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './types.js';
import { chainsElsewhereHint, describeStoreErrorReason, emptyChainBindHint } from './store.js';
import type { Chain, ChainsElsewhere, Store, SwitchRecord } from './store.js';
import { dedupeCallEvents, describeDanglingToolCalls, describeUnansweredTail, mergeTurns, shouldReplacePairedSession, unwrapUserQuery } from './rich.js';
import { describeWriteFailureReason, type FileDigest } from './atomic.js';
import { addFinding, type Finding } from './findings.js';
import { escapeControlChars } from './display.js';
import { countUnparsableJsonLines } from './jsonl.js';
import { cwdAliasHint } from './cwd.js';
import { describePathReadFailureReason, describeReadFailureOrSelf, probeSessionReadable, sessionFilePresence } from './read-text.js';
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
  storeError?: string,
): Promise<{
  adoptedRef: SessionRef;
  replacedRef: SessionRef | null;
  warnings: string[];
  /** 该会话在本次之前就已经绑在链上：目标状态已成立，没有写入任何链记录 */
  unchanged?: boolean;
  /** `unchanged` 时的结果说明，或接入时说明接入的会话是自动挑的（走 stdout；与 `warnings` 的降级原因分开） */
  note?: string;
}> {
  const warnings: string[] = [];
  const adapter = adapters.find((a) => a.id === providerId);
  if (!adapter?.findLatestSession) throw new Error(unknownProviderMessage(providerId, adapters));
  // 归档链以前要等 recordSwitch 才被拒绝，而那时已返回 adoptedRef：用户看到 ok:true，
  // 链上却什么都没写，警告还被包装成「库操作失败」引去查库。原因这里就能确定，先拒绝
  if (store && chainId) {
    const archived = store.archivedChainName(cwd, chainId);
    if (archived) {
      throw new Error(`链已归档: ${archived}；可 watch chain use ${archived} 恢复，或省略 --chain 用当前链`);
    }
  }
  // 没有 --session 时按 mtime 挑「最新会话」。这条兜底路径以前会**静默改绑**：
  // 同目录另一条链刚聊过的会话更新，`adopt claude --chain 默认` 就会把默认链的绑定
  // 换成别条链的会话（2026-11-08 实测 `chain list` 里两条链从此指向同一个 id），
  // 而 `replacedRef` 只写「替换了: <id>」，用户看不出那条会话根本不是自己指定的。
  const autoPicked = !targetRef;
  const found = targetRef
    ? { ref: targetRef }
    : await adapter.findLatestSession(cwd);
  if (!found) {
    // 「这家在这个目录没有会话」同样可能只是 `--cwd` 的写法不同：会话文件在，
    // 只是按另一条路径字符串记录着。这时让人「先开一次会话」会白开一个。
    const alias = await cwdAliasHint(cwd);
    throw new Error(
      adoptNoSessionMessage(providerId, await providersWithSessionsHere(cwd, adapters, providerId), alias),
    );
  }

  let history: SwitchRecord[] = [];
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
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
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
  const bound = pairedRef(history, providerId)?.sessionId === found.ref.sessionId;
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
      ? `未指定 --session，本次自动挑的是按修改时间最新的会话 ${found.ref.sessionId}；要接入指定会话请用 watch adopt ${providerId} --session <会话 id>`
      : '';
    const note = tipElsewhere
      ? `会话 ${found.ref.sessionId} 已经在链上（${providerId} 这一侧绑定的就是它），本次没有写入任何链记录；` +
        `当前链尾停在 ${tail.toProvider}（${tail.toRef.sessionId}），要让 ${providerId} 重新成为当前一侧请用 watch switch ${providerId}（会复用这条会话，不新建）`
      : `会话 ${found.ref.sessionId} 已经在链上，本次没有写入任何链记录（没有需要改动的地方）`;
    // 这是结果说明而不是降级原因（链记录没有写失败，是本来就不需要写），所以走 note：
    // 文本模式打到 stdout，与 `warnings`（stderr，真正的降级）分开
    return {
      adoptedRef: found.ref,
      replacedRef: null,
      warnings,
      unchanged: true,
      note: autoPickedNote ? `${note}；${autoPickedNote}` : note,
    };
  }

  let replaced: SessionRef | null = pairedRef(history, providerId);
  // 没指定 --session、而链上这一家已经绑着另一个会话：这是**静默改绑**，不能做。
  // 同目录另一条链刚聊过的会话更新时，`adopt claude --chain 默认` 会把默认链的绑定换成
  // 别条链的会话（2026-11-08 实测 `chain list` 里两条链从此指向同一个 id），而输出只说
  // 「替换了: <id>」，用户看不出换上去的那条根本没被自己指定过。链只按 cwd 分组，
  // 「最新」与「这条链上的」是两件事。想要换绑就显式给 --session，让选择可见。
  if (autoPicked && replaced) {
    const autoPickedNote =
      `未指定 --session，本次自动挑的是按修改时间最新的会话 ${found.ref.sessionId}；` +
      `但链上 ${providerId} 这一侧现在绑的是 ${replaced.sessionId}，本次没有改动它（自动挑的会话可能属于另一条链或另一段工作）；` +
      `确实要换成最新那条请用 watch adopt ${providerId} --session ${found.ref.sessionId}`;
    return {
      adoptedRef: replaced,
      replacedRef: null,
      warnings,
      unchanged: true,
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
  // 链上这一家原本没绑会话时仍然接入「最新会话」（这是 adopt 的既定语义），
  // 但必须披露它是自动挑的：--json 里只有 id，文本模式也只有一串 uuid，
  // 用户很容易把「挑中的那条」当成自己指定的那条。
  const note = autoPicked
    ? `未指定 --session，本次是按修改时间挑的最新会话 ${found.ref.sessionId}；要接入指定会话请用 watch adopt ${providerId} --session <会话 id>`
    : undefined;
  return { adoptedRef: found.ref, replacedRef: replaced, warnings, ...(note ? { note } : {}) };
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
    const tipPresence = await sessionFilePresence(tail.toRef.filePath);
    const broken =
      tipPresence.state === 'missing'
        ? '文件已不存在'
        : tipPresence.state === 'unknown'
          ? `状态无法确认：${tipPresence.reason}`
          : !tipPresence.isFile
            ? '的路径现在不是普通文件（被同名目录或设备文件占住了）'
            : null;
    if (broken) {
      throw new Error(
        `链尾已是 ${providerId}，但链尾会话 ${tail.toRef.sessionId} ${broken}：${tail.toRef.filePath}；` +
          `本次无法交接也无法 resume——可先恢复该文件，或用 watch chain new <新名字> 另起一条链`,
      );
    }
    // `stat` 成功不等于读得出来：`chmod 000` 的文件 `stat` 照常返回，上面三档全过，
    // 于是这里告诉用户「直接 resume 即可」，而 resume 一打开就失败。同一状态下
    // `sessions` 会说「open / switch 读这条会话时同样会失败」、`open` 会说「找到了，但读不出来」。
    const readProblem = await probeSessionReadable(tail.toRef.filePath);
    if (readProblem) {
      throw new Error(
        `链尾已是 ${providerId}，但链尾会话 ${tail.toRef.sessionId} 的文件现在读不出来：${readProblem}；` +
          `resume 会失败，本次没有新建会话——先修好这个文件（权限或内容）；` +
          `若这个会话不再需要，用 watch chain new <新名字> 另起一条链后再 watch new ${providerId}`,
      );
    }
    throw new Error(`链尾已是 ${providerId}，直接 resume 即可；要开新对话请先切到另一侧`);
  }
  const paired = pairedRef(history, providerId);
  if (paired) {
    // 「先切走」是错的：`switch` 只往 switch_events 追加记录，`pairedRef()` 扫的是整条历史，
    // 切到另一侧再切回来绑定照样在，用户来回几轮只会再撞同一句。
    // 真正能解开的只有两条：换绑（adopt 会替换掉旧会话）或另起一条链。
    // 同时点出被绑着的是哪个会话——`new` 的动机常常是「上次那个好像不对」，不说 id 就只能靠猜。
    throw new Error(
      `${providerId} 已在链上：会话 ${paired.sessionId}（每个 provider 在一条链上只能有一个会话）；` +
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
  byProvider: { provider: string; sessionId: string; usage: TokenUsage | null; error?: string }[];
  /** 链上有绑定、但适配器根本不给用量（未实现 `sessionUsage`，当前 pi）：不列出来会被当成「这一家没有用量」 */
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
  const byProvider: { provider: string; sessionId: string; usage: TokenUsage | null; error?: string }[] = [];
  let total = { ...empty };
  let totalExcluded = 0;
  let totalMissingUsage = 0;
  // 链上绑定了也没法统计的 provider（适配器未实现 sessionUsage，如 pi）：
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
      // 此时「还没建链」会被读成链丢了 / 从来没建成功，必须指出它在哪
      const elsewhere = chainsElsewhereOf(store, cwd);
      notes.push(
        elsewhere.length
          ? `本目录没有可用的当前链，无用量可统计；${chainsElsewhereHint(elsewhere)}`
          : '没有可用的当前链（还没建链，或现有链都已归档），无用量可统计；可先用 watch chain list 查看',
      );
    }
  }
  return { chain, total, totalExcluded, totalMissingUsage, byProvider, unsupported, warnings, notes };
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
  /**
   * alreadyAtTarget 时这条 resume 指向的会话文件现在读不出来（`chmod 000` 之类）。
   *
   * 文本模式据此把「直接打开即可」换成「直接打开会失败」——`warnings` 已经逐条说明原因，
   * 但结论句本身也得改，否则用户复制的那条命令一执行就失败却找不到矛盾在哪。
   */
  resumeUnreadable?: boolean;
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
): Promise<ProviderTip[]> {
  const tips: ProviderTip[] = [];
  for (const adapter of adapters) {
    if (!adapter.findLatestSession) continue;
    let found;
    try {
      found = await adapter.findLatestSession(cwd);
    } catch (error) {
      unreadable?.push(adapter.id);
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
  /** 库打开失败的真实原因；带上它就不再让用户去查 Node 版本 */
  storeError?: string,
): Promise<{
  tips: ProviderTip[];
  chainTip: ProviderTip | null;
  /**
   * 链尾已经绑定、但它的文件现在不可用（不存在 / 不是普通文件 / 状态无法确认）。
   * 文本模式拿不到 warnings 的结构化版本，靠它区分「这个目录真没聊过」与「链尾文件坏了」，
   * 否则 `status` 会在警告之后照样说「请先在任一受支持的 Agent 里开聊」。
   */
  chainTipUnusable: boolean;
  /**
   * 这次根本没读成的 provider（findLatestSession 抛错）。
   * 文本模式靠它区分「这个目录真没聊过」与「有几家没查成」——后者不能给出
   * 「请先在任一受支持的 Agent 里开聊」这类结论性建议。
   */
  unreadable: string[];
  history: SwitchRecord[];
  chain: Chain | null;
  chains: Chain[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const unreadable: string[] = [];
  const allTips = await collectTips(cwd, adapters, warnings, unreadable);
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
      warnings.push(`链历史读取失败，按无链处理：${describeStoreErrorReason(error)}`);
    }
  } else {
    warnings.push(storeUnavailableWarning('链信息与链尾无法显示（只列出原生会话）', storeError));
  }
  // 链尾只以当前链的 switch_events 最后一条为准；不再 fallback 到目录全局最新会话
  let chainTip: ProviderTip | null = null;
  let chainTipUnusable = false;
  if (history.length) {
    const last = history.at(-1)!;
    chainTip = { provider: last.toProvider, ref: last.toRef, updatedAt: last.createdAt, onChain: true };
    // 链尾指向的会话文件被删/被移走时，status 不能假装一切正常：下次 switch 会在这里失败
    // 只有 ENOENT / ENOTDIR 才能说「已不存在」；EACCES 等读不出来照实说「状态无法确认」，
    // 否则权限问题会被讲成会话丢了，把人引去白换一次绑定
    const tipPresence = await sessionFilePresence(last.toRef.filePath);
    if (tipPresence.state === 'missing') {
      chainTipUnusable = true;
      warnings.push(
        `链尾会话文件已不存在：${last.toRef.filePath}（${last.toProvider} ${last.toRef.sessionId}，文件不存在）；下次切换会失败，${rebindHint(last.toProvider)}`,
      );
    } else if (tipPresence.state === 'present' && !tipPresence.isFile) {
      // 路径还在、只是不是普通文件：说成「文件已不存在」自相矛盾，还会把人引去 adopt；
      // 与 chain list / doctor 的「该路径现在不是普通文件」保持同一说法
      chainTipUnusable = true;
      warnings.push(
        `链尾会话文件的路径现在不是普通文件（被同名目录或设备文件占住了）：${last.toRef.filePath}（${last.toProvider} ${last.toRef.sessionId}）；下次切换会失败，先恢复该路径，再决定是否需要 ${rebindHint(last.toProvider)}`,
      );
    } else if (tipPresence.state === 'unknown') {
      chainTipUnusable = true;
      warnings.push(
        `链尾会话文件状态无法确认：${last.toProvider} ${last.toRef.sessionId}；${tipPresence.reason}；可能是权限或路径问题，先确认它是否还在，再决定是否需要 adopt`,
      );
    } else if (tipPresence.isFile) {
      // `stat` 成功不等于读得出来：`chmod 000` 的链尾文件 stat 照常返回，于是
      // `chainTipUnusable` 报 false、warnings 为空，而 resume / 下一次 switch 一读内容就失败。
      // 同一状态下 `sessions` / `open` 都会披露，status 作为总览入口不能替它宣称「可用」。
      const readProblem = await probeSessionReadable(last.toRef.filePath);
      if (readProblem) {
        chainTipUnusable = true;
        warnings.push(
          `链尾会话文件读不出来：${last.toProvider} ${last.toRef.sessionId}；${readProblem}；` +
            `resume 与下一次 switch 都会失败——先修好这个文件（权限或内容），` +
            `或 watch adopt ${last.toProvider} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`,
        );
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
    if (readProblem && !warnedFiles.has(t.ref.filePath)) {
      warnings.push(
        `${t.provider} 的最新会话 ${t.ref.sessionId} 的文件当前读不出来：${readProblem}；` +
          'open / switch 读这条会话时同样会失败——先确认该文件可读（权限、路径）再重试',
      );
    }
    tips.push({
      ...t,
      onChain: boundIds.get(t.provider)?.has(t.ref.sessionId) ?? false,
      ...(readProblem ? { unreadable: true } : {}),
    });
  }
  return { tips, chainTip, chainTipUnusable, unreadable, history, chain, chains, warnings };
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
            `${rebindHint(chainTipRef.provider)}，或在原生 CLI 里新开一个会话`,
        );
      }
      if (tipPresence.state === 'unknown') {
        throw new Error(
          `未发现原生会话；链尾记录的 ${chainTipRef.provider} 会话 ${chainTipRef.sessionId} 状态无法确认：${chainTipRef.filePath}；${tipPresence.reason}` +
            `——可能是权限或路径问题，先确认它是否还在，再决定是否 watch switch ${chainTipRef.provider} 重新绑定`,
        );
      }
      // 路径被同名目录 / 设备文件占住：两个分支都不进就会落到下面通用的
      // 「请先在…里开聊」，把「路径不可用」讲成「目录里没东西」
      if (tipPresence.state === 'present' && !tipPresence.isFile) {
        throw new Error(
          `未发现原生会话；而链尾记录的 ${chainTipRef.provider} 会话 ${chainTipRef.sessionId} 的路径现在不是普通文件（被同名目录或设备文件占住了）：${chainTipRef.filePath}` +
            `——先恢复该路径，再决定是否 watch switch ${chainTipRef.provider} 重新绑定，或在原生 CLI 里新开一个会话`,
        );
      }
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
      // 这条分支以前只回「直接打开即可」+ resume，而它和 status 一样只读元数据：
      // `stat` 对 chmod 000 的文件照常成功，于是同一份文件 new 明确拒绝、status 警告、
      // chain list 标 unreadable、doctor 报失败，只有 switch 替它宣称可用——用户复制的那条
      // resume 一执行就失败。这里探一次真正要 resume 的那条会话（只 open，不读内容）。
      const resumeReadProblem = await probeSessionReadable(resumeRef.filePath);
      if (resumeReadProblem) {
        warnings.push(
          `链尾会话 ${resumeRef.sessionId}（${targetId}）的文件现在读不出来：${resumeReadProblem}；` +
            `下面那条 resume 命令一执行就会失败——先修好这个文件（权限或内容）再重试` +
            `，或 watch adopt ${targetId} --session <另一个会话 id> 换绑，或用 watch chain new <新名字> 另起一条链`,
        );
      }
      return {
        newRef: resumeRef,
        resumeCommand: target.resumeCommand(resumeRef),
        fromProvider: targetId,
        turnCount: 0,
        alreadyAtTarget: true,
        chainTipState,
        ...(resumeReadProblem ? { resumeUnreadable: true } : {}),
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
      ? `文件 ${sourceTip.ref.filePath} 已不存在，而链记录仍指向它：${rebindHint(sourceTip.provider)}，或用 watch sessions 查看该目录还有哪些可接力的会话`
      : code === 'EACCES' || code === 'EPERM'
        ? `文件 ${sourceTip.ref.filePath} 无权读取（权限问题，不是被删除）：先修权限或换一个有权限的路径，再重试`
        : `文件 ${sourceTip.ref.filePath} 读不出来：如果只是格式坏掉可先确认文件内容；确认文件确实没了再 watch switch ${sourceTip.provider} 重新绑定`;
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
  const sourceLabel = `来源会话 ${sourceTip.ref.sessionId}（${source.displayName}）`;
  const dangling = describeDanglingToolCalls(turns, sourceLabel);
  if (dangling) warnings.push(dangling);
  // 「用户说完、模型没回」是同一种中断的另一形状：`diffTurns` 会把这句悬空的问题当成新内容
  // 照常并入目标，round-trip 两边都含它所以校验通过——不主动披露就会把半轮当完整交接。
  const unanswered = describeUnansweredTail(turns, sourceLabel);
  if (unanswered) warnings.push(unanswered);
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
    // 来源会话本身是空的（`watch new` 建出来的 0 轮会话最典型），目标侧也没有可沿用的会话：
    // 没有任何内容可交接。以前这里照样往下走，把 `toProvider` 记成目标、`toRef` 记成**来源**
    // 那个会话，于是同一份结果里 `resumeCommand` 是 `claude --resume <codex 的 id>`（照抄必然失败），
    // `status` 里 `chainTip.provider`（claude）与 `chainTip.ref.provider`（codex）互相矛盾，
    // 文本模式还印「已从 codex 交接 → claude（0 轮）」。同一个操作走 `open <id> --to` 一直
    // 老实拒绝（「没有可转入的内容」），两条路径对同一件事给出两套结论。
    if (!into && turns.length === 0) {
      throw new Error(
        `来源会话 ${sourceTip.ref.sessionId}（${source.displayName}）没有任何可交接的内容（0 轮）：` +
          `本次未写入任何内容，链尾仍在 ${source.displayName}。` +
          `要在 ${target.displayName} 侧从零开新会话，请先另起一条链：watch chain new <新名字> 之后 watch new ${targetId}` +
          `（同一条链上直接 new ${targetId} 仍会走这次空交接）；` +
          `若 ${target.displayName} 侧已有会话，可用 watch adopt ${targetId} --session <会话 id> 接进来`,
      );
    }
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
