import { realpath, stat } from 'node:fs/promises';
import type { ProviderAdapter } from '../providers/adapter.js';
import { listAdapters, listProviders } from '../providers/registry.js';
import type { ProviderInfo } from './types.js';
import type { Chain, ChainsElsewhere } from './store.js';
import type { ImportJobs } from './import-jobs.js';
import { defaultDbPath, describeStoreErrorReason } from './store.js';
import { diffTurns, rebindHint } from './handoff.js';
import type { SessionRef } from './types.js';
import { readWatchVersion } from './watch-version.js';
import { cwdProblem, splitElsewhereByDirectory } from './cwd.js';
import { escapeControlChars } from './display.js';
import { countUnparsableJsonLines } from './jsonl.js';
import { describeSessionReadFailureReason, isEmptySessionFileReason, isFileSystemErrorCode, probeSessionReadable } from './read-text.js';

export type BrokenTip = {
  chainId: string;
  chainName: string;
  provider: string;
  sessionId: string;
  filePath: string;
  error: string;
  /** true = 文件确认不在（ENOENT / ENOTDIR）；false = 读不出来，无法确认是否还在 */
  missing: boolean;
  /**
   * true = 文件在、是普通文件，但打不开（`chmod 000` 之类）。
   *
   * `stat` 成功不代表读得出来，所以这一档既不能进 `missing`（文件没丢），也不能当成
   * 健康链尾（`resume` 与下次切换一读内容就失败）。`status` / `chain list` / `new`
   * 对同一状态都会披露，`doctor` 作为排障入口必须给出同一档结论。
   */
  unreadable?: boolean;
};

/** 报告来源：贴到 issue 里要能定位「哪一版、什么环境、看的是哪个库」 */
export type DoctorEnvironment = {
  watchVersion: string | null;
  node: string;
  platform: string;
  dbPath: string;
  importsRoot: string | null;
};

/** 链尾与来源的内容对账：`missingTurns > 0` 说明目标会话比来源少了记录 */
export type DriftedPair = {
  chainId: string;
  chainName: string;
  from: { provider: string; sessionId: string };
  to: { provider: string; sessionId: string };
  missingTurns: number;
  sourceTurns: number;
};

/** 每家 Agent 的原生会话列表可读性：`count` 为 null 表示读取失败 */
export type StorageProbe = {
  provider: string;
  count: number | null;
  error?: string;
  /** 计数已达适配器 `listSessionsCap`：实际会话数只会更多，不能当精确总数用 */
  capped?: boolean;
  /**
   * 文件列得出来、但预览读不出来（`chmod 000` 之类）的会话数。
   *
   * `count` 只说明「目录里有几条」，`stat` 对读不出来的文件照常成功，所以不加这一档时
   * doctor 会对一条 open / switch 必然失败的会话报告“N 个会话”，看起来一切正常。
   */
  unreadable?: number;
  /**
   * 连「属于哪个 cwd」都读不出来、因而没有进任何目录列表的条目数（目前只有 Codex 的
   * `session_meta` 坏掉的 rollout）。
   *
   * 与 `unreadable` 的区别：那一档知道会话 id 与路径、只是内容读不出；这一档连归属都没有，
   * `sessions` / `recent` 里根本不会出现，四条通道都不说话，用户会以为它从来没存在过。
   */
  unattributable?: number;
};

export type DoctorReport = {
  cwd: string;
  environment: DoctorEnvironment;
  providers: ProviderInfo[];
  storage: StorageProbe[];
  store:
    | {
        available: true;
        chains: number;
        activeChains: number;
        /**
         * 本地库里属于其它目录的链（本目录没有链时才有内容）。
         * 「本目录 0 条链」是结论：不指出它在哪，用户会以为链丢了或没建成功。
         */
        chainsElsewhere: ChainsElsewhere[];
        brokenTips: BrokenTip[];
        driftedPairs: DriftedPair[];
      }
    | { available: false; error: string };
  imports:
    | {
        available: true;
        total: number;
        imported: number;
        associated: number;
        uncertain: number;
        prepared: number;
        /** 结果未知的计划 id（最多 10 个）：文本模式要能直接照着跑 status，不能只报个数 */
        uncertainIds: string[];
        /** 读不出来被跳过的日志条数：不计入上面的统计，否则用户只会看到总数凭空少了 */
        skipped: number;
        /** 被跳过的日志与原因（最多 10 个）：只说「有 N 条读不出」同样没法排查 */
        skippedJournals: { id: string; reason: string }[];
      }
    | { available: false; error: string };
  warnings: string[];
  /**
   * 结论性汇总：doctor 是排障入口，脚本 / CI 需要一个不靠解析中文文本的判断。
   *
   * 只有 `fail` 让默认退出码非零——「警告」是已经披露的降级（内容漂移、单条会话读不出来、
   * uncertain 计划…），把它们也变成红灯会让一次平常的排障在 CI 里失败；`--strict` 才升级。
   * `failures` 逐条列出硬问题（Watch 现在确实做不成某件事），不是只给个数。
   */
  summary: DoctorSummary;
};

export type DoctorSummary = {
  status: 'ok' | 'warn' | 'fail';
  /** 硬问题：本地库不可用 / 某家会话列表读不出来 / 链尾不可用 / CLI 装了但起不来 */
  failures: string[];
  /** 与 `warnings` 长度一致，方便只读 summary 的调用方判断有没有降级 */
  warnings: number;
};

/** 诊断用的最小 Store 面：列出当前 cwd 的链、读某条链的切换记录；测试可注入假实现 */
export type DoctorStore = {
  listChains(cwd: string): Chain[];
  /** 列出其它目录的链（可选：注入的假 Store 可以不给，报告里就是空数组） */
  chainsElsewhere?(cwd: string): ChainsElsewhere[];
  listSwitchEvents?(chainId: string): {
    fromRef?: SessionRef | null;
    toRef?: SessionRef | null;
  }[];
};

export type DoctorDeps = {
  /** 默认读注册表；测试注入假适配器 */
  adapters?: ProviderAdapter[];
  store: DoctorStore | null;
  storeError?: string;
  importJobs: ImportJobs | null;
  importJobsError?: string;
  /** 执行日志根目录（供报告标注路径）；不传则报告记为 null */
  importsRoot?: string;
  /** 测试可覆盖；默认读当前进程与 package.json */
  environment?: DoctorEnvironment;
};

type PathPresence =
  | { state: 'present' }
  | { state: 'unreadable'; reason: string }
  | { state: 'missing'; code: string }
  | { state: 'unknown'; reason: string };

/**
 * 只有 ENOENT / ENOTDIR 才算「文件不在」。EACCES / EIO 等读不出来时不能说成已删除，
 * 否则权限问题会被讲成「下次切换会失败，先 adopt」，把人引去白换一次绑定。
 * 路径存在但不是普通文件（被同名目录 / 设备文件占住）同样不是「还在」：说成 present
 * 会让后面的 parse 抛出裸 `EISDIR: illegal operation on a directory, read`，
 * 而 `type: 'present'` 也不该用来表示「读不出内容」——`watch chain list` 对同一状态
 * 说的是「该路径现在不是普通文件」，两处要一致。
 */
async function pathPresence(filePath: string): Promise<PathPresence> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      // `stat` 对 `chmod 000` 照常成功：文件在、是普通文件，但内容读不出来。
      // 只按 `stat` 判 present 会让 doctor 对一条 resume 必然失败的链尾保持沉默。
      const readProblem = await probeSessionReadable(filePath);
      if (readProblem) return { state: 'unreadable', reason: readProblem };
      return { state: 'present' };
    }
    return { state: 'unknown', reason: '该路径现在不是普通文件（被同名目录或设备文件占住了）' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing', code };
    return { state: 'unknown', reason: describeSessionReadFailureReason(error) };
  }
}

function resolveEnvironment(importsRoot: string | null): DoctorEnvironment {
  return {
    watchVersion: readWatchVersion(),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    dbPath: process.env.WATCH_DB ?? defaultDbPath(),
    importsRoot,
  };
}

/**
 * 只读环境诊断：各项独立降级，任一失败只记入对应字段或 warnings，不影响其它项。
 * 不写库、不写原生会话、不启动外部 CLI（providers 的 detect 只做 PATH 探测）。
 */
export async function doctorReport(cwd: string, deps: DoctorDeps): Promise<DoctorReport> {
  const warnings: string[] = [];
  // 硬问题与 warnings 分开记：这不是同一种东西。警告是「已经降级但说清楚了」，
  // 失败是「Watch 现在做不成某件事」——只有后者该让 exit code 非零
  const failures: string[] = [];
  const environment = deps.environment ?? resolveEnvironment(deps.importsRoot ?? null);

  // 路径本身错了，下面每项都会安静地返回 0，看起来像「一切正常」——先把它说清楚
  const cwdIssue = await cwdProblem(cwd);
  if (cwdIssue) warnings.push(cwdIssue);
  // 符号链接是另一类「路径没写错但匹配不到」：provider 按原生记录的字符串精确比较，
  // 用另一写法打开过的会话不会出现在这里。先记下 realpath，等扫完会话再决定要不要提醒。
  let realCwd: string | null = null;
  if (!cwdIssue) {
    try {
      const real = await realpath(cwd);
      if (real !== cwd) realCwd = real;
    } catch {
      /* stat 已经成功；realpath 失败不额外报，避免同一路径报两次 */
    }
  }

  const adapters = deps.adapters ?? listAdapters();
  const providers = await listProviders(adapters);

  // 原生会话列表只读；与 detect（只看 PATH）互补：装了但存储读不出，比「没装」更需要解释
  const storage: StorageProbe[] = [];
  // 列得出、但预览读不出来的会话。链尾由下面的 brokenTips 单独说（更具体、带下一步），
  // 这里收集是为了覆盖「不是链尾、却同样打不开」的那一类
  const unreadableSessions: { provider: string; sessionId: string; filePath: string; reason: string }[] = [];
  // 连归属都读不出来、因而没进任何目录列表的条目。它不属于任何 cwd，所以只能在全局诊断里说
  const unattributableStats: { provider: string; displayName: string; count: number; samples: string[] }[] = [];
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    try {
      const listed = await adapter.listSessions(cwd);
      const capped = adapter.listSessionsCap !== undefined && listed.length >= adapter.listSessionsCap;
      const unreadable = listed.filter((item) => item.previewError);
      for (const item of unreadable) {
        unreadableSessions.push({
          provider: adapter.id,
          sessionId: item.ref.sessionId,
          filePath: item.ref.filePath,
          reason: item.previewError as string,
        });
      }
      // 补充说明而已：这一步自己失败不当故障（真正的存储故障已由上面 catch 记进 failures）
      let unattributable: number | undefined;
      if (adapter.unattributable) {
        try {
          const stats = await adapter.unattributable();
          if (stats.count > 0) {
            unattributable = stats.count;
            unattributableStats.push({
              provider: adapter.id,
              displayName: adapter.displayName,
              count: stats.count,
              samples: stats.samples,
            });
          }
        } catch {
          // 读不出来已经由 listSessions 那条通道说清（或本家本来就没有这一档）
        }
      }
      storage.push({
        provider: adapter.id,
        count: listed.length,
        ...(capped ? { capped: true } : {}),
        ...(unreadable.length ? { unreadable: unreadable.length } : {}),
        ...(unattributable ? { unattributable } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storage.push({ provider: adapter.id, count: null, error: message });
      warnings.push(`${adapter.displayName} 会话列表读取失败：${message}`);
      failures.push(`${adapter.displayName} 会话列表读不出来`);
    }
  }

  if (realCwd && storage.length > 0 && storage.every((s) => s.count === 0)) {
    warnings.push(
      `--cwd 是符号链接（realpath: ${realCwd}），且本目录没扫到任何会话；各 provider 按原生记录的路径字符串精确比较，若曾在另一写法下开过会话，换该路径重跑 watch doctor`,
    );
  }

  let store: DoctorReport['store'];
  if (!deps.store) {
    store = { available: false, error: deps.storeError ?? '本地库未打开' };
    failures.push('本地库不可用');
    // 只写「未打开」看不出是权限、库损坏还是被占用；doctor 是排障入口，原因必须带出来
    if (deps.storeError) warnings.push(`本地库不可用，无法列出链与做内容对账：${deps.storeError}`);
  } else {
    try {
      const chains = deps.store.listChains(cwd);
      const activeChains = chains.filter((c) => c.status === 'active');
      const brokenTips: BrokenTip[] = [];
      const listEvents = deps.store.listSwitchEvents?.bind(deps.store);
      for (const chain of activeChains) {
        if (!listEvents) break;
        let tip: { provider: string; sessionId: string; filePath: string } | null | undefined;
        try {
          tip = listEvents(chain.id).at(-1)?.toRef;
        } catch (error) {
          // SQLite 的原文（`database is locked` / `no such table`）既不说是哪一类故障也不给下一步，
          // 与 handoff.ts / open.ts 的同类警告保持一致，统一翻成中文
          warnings.push(`链「${escapeControlChars(chain.name)}」的切换记录读取失败：${describeStoreErrorReason(error)}`);
          failures.push(`链「${escapeControlChars(chain.name)}」的切换记录读不出来`);
          continue;
        }
        if (!tip) continue;
        const tipPresence = await pathPresence(tip.filePath);
        if (tipPresence.state !== 'present') {
          const unreadable = tipPresence.state === 'unreadable';
          const missing = tipPresence.state === 'missing';
          const error = missing ? tipPresence.code : tipPresence.reason;
          brokenTips.push({
            chainId: chain.id,
            chainName: chain.name,
            provider: tip.provider,
            sessionId: tip.sessionId,
            filePath: tip.filePath,
            error,
            missing,
            ...(unreadable ? { unreadable: true } : {}),
          });
          failures.push(
            `链「${escapeControlChars(chain.name)}」的链尾不可用（${missing ? '文件已不存在' : unreadable ? '读不出来' : '文件状态无法确认'}）`,
          );
          if (missing) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件已不存在：${tip.filePath}（${tip.provider}）；下次切换会失败，${rebindHint(tip.provider)}`,
            );
          } else if (unreadable) {
            // 「读不出来」既不是「文件丢了」也不是「无法确认它还在」：文件明明白白在，
            // 只是内容读不出来。说成「已不存在」会把人引去重新绑定，说成「状态无法确认」
            // 又会让人以为可能是路径问题——两处都修不好一个权限。
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件读不出来：${tip.filePath}（${tip.provider}）；${error}；resume 与下次切换都会失败——先修好这个文件（权限或内容），或 watch switch ${tip.provider} 重新绑定，或 watch chain new <新名字> 另起一条链`,
            );
          } else {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾会话文件状态无法确认：${tip.filePath}（${tip.provider}）；${error}；先确认它是否还在、是否是普通文件，再决定是否 adopt`,
            );
          }
        }
      }
      // 内容对账：链尾文件还在，不代表它也还在内容上承接来源（手动改过、客户端截断、resume 重写都会让两者漂移）
      const driftedPairs: DriftedPair[] = [];
      const adapterById = new Map(adapters.map((a) => [a.id, a]));
      for (const chain of activeChains) {
        if (!listEvents) break;
        let last: { fromRef?: SessionRef | null; toRef?: SessionRef | null } | undefined;
        try {
          last = listEvents(chain.id).at(-1);
        } catch {
          continue; // 上面已按链警告过读取失败
        }
        const from = last?.fromRef;
        const to = last?.toRef;
        if (!from || !to) continue; // 链起点没有来源，无从对账
        const fromAdapter = adapterById.get(from.provider);
        const toAdapter = adapterById.get(to.provider);
        if (!fromAdapter?.parse || !toAdapter?.parse) continue;
        // 文件确认不在已有 brokenTips / 专门警告，别再让 parse 抛 ENOENT 重复报一次；
        // 但「读不出来」要单独说，`continue` 静默跳过会被当成「对账通过」
        const toPresence = await pathPresence(to.filePath);
        if (toPresence.state === 'missing') continue;
        // 链尾读不出来已经在上面 brokenTips / 链尾警告里说过一遍（含「先修好这个文件」的下一步），
        // 这里再补一句「未做内容对账」只是同一件事讲两遍，反而把真正可执行的建议淹没
        if (toPresence.state === 'unreadable') continue;
        if (toPresence.state === 'unknown') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的链尾会话文件状态无法确认：${to.filePath}（${to.provider}）；读不出来（${toPresence.reason}），本次未做内容对账`,
          );
          continue;
        }
        const fromPresence = await pathPresence(from.filePath);
        if (fromPresence.state === 'missing') {
          warnings.push(`链「${escapeControlChars(chain.name)}」的来源会话文件已不存在：${from.filePath}（${from.provider}）；链尾仍在，但无法再做内容对账`);
          continue;
        }
        // 来源会话读不出来：链尾没问题，但这一条链的内容对账做不成，来源侧也打不开
        if (fromPresence.state === 'unreadable') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话文件读不出来：${from.filePath}（${from.provider}）；${fromPresence.reason}；本次未做内容对账——先修好这个文件（权限或内容），再重跑 watch doctor`,
          );
          continue;
        }
        if (fromPresence.state === 'unknown') {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话文件状态无法确认：${from.filePath}（${from.provider}）；读不出来（${fromPresence.reason}），本次未做内容对账`,
          );
          continue;
        }
        // parse 对坏行一律跳过：两边都坏时 diffTurns 可能「看起来对齐」，实际上内容已经丢了，
        // 内容对账（只比解析结果）永远查不出来，只能在这里主动报
        const [fromBad, toBad] = await Promise.all([
          countUnparsableJsonLines(from.filePath),
          countUnparsableJsonLines(to.filePath),
        ]);
        if (fromBad > 0) {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的来源会话 ${from.sessionId}（${from.provider}）有 ${fromBad} 行无法解析（截断或损坏）：切换时这些内容会被跳过`,
          );
        }
        if (toBad > 0) {
          warnings.push(
            `链「${escapeControlChars(chain.name)}」的链尾会话 ${to.sessionId}（${to.provider}）有 ${toBad} 行无法解析（截断或损坏）：内容对账与增量判定可能不准`,
          );
        }
        try {
          const [fromTurns, toTurns] = await Promise.all([fromAdapter.parse(from), toAdapter.parse(to)]);
          const missingTurns = diffTurns(fromTurns, toTurns).length;
          if (missingTurns > 0) {
            driftedPairs.push({
              chainId: chain.id,
              chainName: chain.name,
              from: { provider: from.provider, sessionId: from.sessionId },
              to: { provider: to.provider, sessionId: to.sessionId },
              missingTurns,
              sourceTurns: fromTurns.length,
            });
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的链尾比来源少 ${missingTurns} 条记录（来源 ${fromTurns.length} 条）：若切换后又在来源侧继续聊过属正常，下次切换会补齐；否则可能是目标会话被改动或截断，可用 switch / adopt 重新对齐`,
            );
          }
        } catch (error) {
          // parse 顺带把文件读进来：EACCES / EIO / EMFILE 这类 fs 错误是「读不出来」，
          // 不是「内容对不上」。原样塞进警告只剩一句英文 errno（`EACCES: permission denied, open '…'`），
          // 用户既看不出该修权限还是该查内容，也不知道这一项其实没做成。
          if (isFileSystemErrorCode((error as NodeJS.ErrnoException).code)) {
            warnings.push(
              `链「${escapeControlChars(chain.name)}」的内容对账未进行：${describeSessionReadFailureReason(error)}；先确认来源 / 链尾会话文件是否可读，再重跑 watch doctor`,
            );
          } else {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`链「${escapeControlChars(chain.name)}」的内容对账失败：${message}`);
          }
        }
      }
      // 本目录没有链时，本地库里别的目录的链是排障的关键线索：
      // 「本目录 0 条链」是结论，不指出它在哪就会被当成链丢了 / 没建成功
      let chainsElsewhere: ChainsElsewhere[] = [];
      if (!chains.length && deps.store.chainsElsewhere) {
        try {
          const rows = deps.store.chainsElsewhere(cwd);
          // 链按 --cwd 精确分组：同一个目录的另一种写法（软链、/var 与 /private/var）在这里
          // 也会落进「别处」。排障入口把那些说成「其它目录」会让人以为链丢了，标注出来
          const split = await splitElsewhereByDirectory(rows, cwd);
          chainsElsewhere = [
            ...split.sameDirectory.map((r) => ({ ...r, sameDirectory: true })),
            ...split.otherDirectories,
          ];
        } catch {
          // 补充说明而已：库读不出来时正文照常给，真正的库故障已由 listChains 那条处理
        }
      }
      store = {
        available: true,
        chains: chains.length,
        activeChains: activeChains.length,
        chainsElsewhere,
        brokenTips,
        driftedPairs,
      };
    } catch (error) {
      const reason = describeStoreErrorReason(error);
      store = { available: false, error: reason };
      warnings.push(`本地库读取失败：${reason}`);
      failures.push('本地库读取失败');
    }
  }

  // 非链尾的「文件在、读不出来」会话：`storage` 的计数看不出这一档，`sessions` / `recent`
  // 早已会警告，doctor 作为排障入口不能说「claude 2 个会话」就完事——那两条 open / switch
  // 一读内容就失败。链尾已经在 brokenTips 里逐条说过（带链名与下一步），这里只报剩下的，
  // 同一份报告不把同一条文件讲两遍
  const tipFiles = new Set(store.available ? store.brokenTips.map((tip) => tip.filePath) : []);
  const unreadableBeyondTips = unreadableSessions.filter((item) => !tipFiles.has(item.filePath));
  // 与 sessions / recent 的 pushPreviewErrorWarning() 同一分档：0 字节是内容已经没了，
  // 「先确认这些文件可读（权限、路径）」对它不成立，照着做只会白检查一遍权限。
  const sample = (list: typeof unreadableBeyondTips): string =>
    list
      .slice(0, 3)
      .map((item) => `${item.provider}:${item.sessionId}（${item.reason}）`)
      .join('、') + (list.length > 3 ? ` 等 ${list.length} 条` : '');
  const emptyFiles = unreadableBeyondTips.filter((item) => isEmptySessionFileReason(item.reason));
  const deniedFiles = unreadableBeyondTips.filter((item) => !isEmptySessionFileReason(item.reason));
  if (emptyFiles.length > 0) {
    warnings.push(
      `有 ${emptyFiles.length} 条会话文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${sample(emptyFiles)}；` +
        `列得出来，但 open / switch 读不出任何内容——只能重新开一次会话或从备份恢复`,
    );
  }
  if (deniedFiles.length > 0) {
    warnings.push(
      `有 ${deniedFiles.length} 条会话文件读不出来（列得出来，但 open / switch 读内容时会失败）：${sample(deniedFiles)}；` +
        `先确认这些文件可读（权限、路径）再重试`,
    );
  }

  // 连归属都读不出来、因此一条目录列表里都不会出现的条目：不说就会被读成「这台机器上没有这条会话」，
  // 而它可能只是被截断，还能从备份恢复（open <id> 会说「找到了，但读不出来」，列表上却什么都没有）
  for (const stat of unattributableStats) {
    warnings.push(
      `${stat.displayName} 有 ${stat.count} 个会话文件读不出目录归属（session_meta 首行缺失或损坏），` +
        `因此不会出现在任何目录的会话列表里：${stat.samples.join('、')}${stat.count > stat.samples.length ? ` 等 ${stat.count} 个` : ''}；` +
        `这不代表它们不存在——先确认这些文件的内容（可能是被截断），能从备份恢复就别直接删`,
    );
  }

  let imports: DoctorReport['imports'];
  if (!deps.importJobs) {
    imports = { available: false, error: deps.importJobsError ?? '导入日志目录不可用' };
  } else {
    try {
      const { items, skipped } = await deps.importJobs.listSummary();
      const count = (status: string) => items.filter((i) => i.status === status).length;
      imports = {
        available: true,
        total: items.length,
        imported: count('imported'),
        associated: count('associated'),
        uncertain: count('uncertain'),
        prepared: count('prepared'),
        // 「不要重试」只有配上 planId 才可执行
        uncertainIds: items.filter((i) => i.status === 'uncertain').map((i) => i.id).slice(0, 10),
        skipped: skipped.length,
        skippedJournals: skipped.slice(0, 10),
      };
      if (imports.uncertain > 0) {
        warnings.push(`有 ${imports.uncertain} 个导入/关联计划结果未知（uncertain）：不要重试，也不要删除其执行日志`);
      }
      // 被跳过的日志不进 total：只报「共 N 条」会被读成「这些就是全部」，坏的那几份就此消失。
      // 原因已逐条在 skippedJournals 里，警告只给 id，别把同一段长文案印两遍
      if (imports.skipped > 0) {
        const ids = imports.skippedJournals.map((j) => j.id.slice(0, 8)).join('、');
        warnings.push(
          `有 ${imports.skipped} 份导入日志读不出来，已跳过（不计入上面的统计）：${ids}${imports.skipped > 10 ? ' 等' : ''}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      imports = { available: false, error: message };
      warnings.push(`导入日志读取失败：${message}`);
    }
  }

  for (const p of providers) {
    if (p.error) {
      warnings.push(`${p.displayName} 检测失败：${p.error}`);
      failures.push(`${p.displayName} 检测失败（装了但起不来）`);
    }
  }

  const summary: DoctorSummary = {
    status: failures.length ? 'fail' : warnings.length ? 'warn' : 'ok',
    failures,
    warnings: warnings.length,
  };
  return { cwd, environment, providers, storage, store, imports, warnings, summary };
}
