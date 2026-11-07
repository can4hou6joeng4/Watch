import { realpath, stat } from 'node:fs/promises';
import type { ProviderAdapter } from '../providers/adapter.js';
import { listAdapters, listProviders } from '../providers/registry.js';
import type { ProviderInfo } from './types.js';
import type { Chain } from './store.js';
import type { ImportJobs } from './import-jobs.js';
import { defaultDbPath, describeStoreErrorReason } from './store.js';
import { diffTurns } from './handoff.js';
import type { SessionRef } from './types.js';
import { readWatchVersion } from './watch-version.js';
import { cwdProblem } from './cwd.js';
import { countUnparsableJsonLines } from './jsonl.js';
import { describeSessionReadFailureReason, isFileSystemErrorCode } from './read-text.js';

export type BrokenTip = {
  chainId: string;
  chainName: string;
  provider: string;
  sessionId: string;
  filePath: string;
  error: string;
  /** true = 文件确认不在（ENOENT / ENOTDIR）；false = 读不出来，无法确认是否还在 */
  missing: boolean;
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
};

export type DoctorReport = {
  cwd: string;
  environment: DoctorEnvironment;
  providers: ProviderInfo[];
  storage: StorageProbe[];
  store:
    | { available: true; chains: number; activeChains: number; brokenTips: BrokenTip[]; driftedPairs: DriftedPair[] }
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
};

/** 诊断用的最小 Store 面：列出当前 cwd 的链、读某条链的切换记录；测试可注入假实现 */
export type DoctorStore = {
  listChains(cwd: string): Chain[];
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
    if (info.isFile()) return { state: 'present' };
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
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    try {
      const listed = await adapter.listSessions(cwd);
      const capped = adapter.listSessionsCap !== undefined && listed.length >= adapter.listSessionsCap;
      storage.push({ provider: adapter.id, count: listed.length, ...(capped ? { capped: true } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storage.push({ provider: adapter.id, count: null, error: message });
      warnings.push(`${adapter.displayName} 会话列表读取失败：${message}`);
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
          warnings.push(`链「${chain.name}」的切换记录读取失败：${describeStoreErrorReason(error)}`);
          continue;
        }
        if (!tip) continue;
        const tipPresence = await pathPresence(tip.filePath);
        if (tipPresence.state !== 'present') {
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
          });
          if (missing) {
            warnings.push(
              `链「${chain.name}」的链尾会话文件已不存在：${tip.filePath}（${tip.provider}）；下次切换会失败，可先 adopt 该 provider 的新会话`,
            );
          } else {
            warnings.push(
              `链「${chain.name}」的链尾会话文件状态无法确认：${tip.filePath}（${tip.provider}）；${error}；先确认它是否还在、是否是普通文件，再决定是否 adopt`,
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
        if (toPresence.state === 'unknown') {
          warnings.push(
            `链「${chain.name}」的链尾会话文件状态无法确认：${to.filePath}（${to.provider}）；读不出来（${toPresence.reason}），本次未做内容对账`,
          );
          continue;
        }
        const fromPresence = await pathPresence(from.filePath);
        if (fromPresence.state === 'missing') {
          warnings.push(`链「${chain.name}」的来源会话文件已不存在：${from.filePath}（${from.provider}）；链尾仍在，但无法再做内容对账`);
          continue;
        }
        if (fromPresence.state === 'unknown') {
          warnings.push(
            `链「${chain.name}」的来源会话文件状态无法确认：${from.filePath}（${from.provider}）；读不出来（${fromPresence.reason}），本次未做内容对账`,
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
            `链「${chain.name}」的来源会话 ${from.sessionId}（${from.provider}）有 ${fromBad} 行无法解析（截断或损坏）：切换时这些内容会被跳过`,
          );
        }
        if (toBad > 0) {
          warnings.push(
            `链「${chain.name}」的链尾会话 ${to.sessionId}（${to.provider}）有 ${toBad} 行无法解析（截断或损坏）：内容对账与增量判定可能不准`,
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
              `链「${chain.name}」的链尾比来源少 ${missingTurns} 条记录（来源 ${fromTurns.length} 条）：若切换后又在来源侧继续聊过属正常，下次切换会补齐；否则可能是目标会话被改动或截断，可用 switch / adopt 重新对齐`,
            );
          }
        } catch (error) {
          // parse 顺带把文件读进来：EACCES / EIO / EMFILE 这类 fs 错误是「读不出来」，
          // 不是「内容对不上」。原样塞进警告只剩一句英文 errno（`EACCES: permission denied, open '…'`），
          // 用户既看不出该修权限还是该查内容，也不知道这一项其实没做成。
          if (isFileSystemErrorCode((error as NodeJS.ErrnoException).code)) {
            warnings.push(
              `链「${chain.name}」的内容对账未进行：${describeSessionReadFailureReason(error)}；先确认来源 / 链尾会话文件是否可读，再重跑 watch doctor`,
            );
          } else {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`链「${chain.name}」的内容对账失败：${message}`);
          }
        }
      }
      store = { available: true, chains: chains.length, activeChains: activeChains.length, brokenTips, driftedPairs };
    } catch (error) {
      const reason = describeStoreErrorReason(error);
      store = { available: false, error: reason };
      warnings.push(`本地库读取失败：${reason}`);
    }
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
    if (p.error) warnings.push(`${p.displayName} 检测失败：${p.error}`);
  }

  return { cwd, environment, providers, storage, store, imports, warnings };
}
