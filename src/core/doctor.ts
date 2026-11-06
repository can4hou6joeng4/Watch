import { stat } from 'node:fs/promises';
import type { ProviderAdapter } from '../providers/adapter.js';
import { listAdapters, listProviders } from '../providers/registry.js';
import type { ProviderInfo } from './types.js';
import type { Chain } from './store.js';
import type { ImportJobs } from './import-jobs.js';
import { defaultDbPath } from './store.js';
import { diffTurns } from './handoff.js';
import type { SessionRef } from './types.js';
import { readWatchVersion } from './watch-version.js';

export type BrokenTip = {
  chainId: string;
  chainName: string;
  provider: string;
  sessionId: string;
  filePath: string;
  error: string;
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
    | { available: true; total: number; imported: number; associated: number; uncertain: number; prepared: number }
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
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

  let store: DoctorReport['store'];
  if (!deps.store) {
    store = { available: false, error: deps.storeError ?? '本地库未打开' };
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
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`链「${chain.name}」的切换记录读取失败：${message}`);
          continue;
        }
        if (!tip) continue;
        try {
          await stat(tip.filePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          brokenTips.push({
            chainId: chain.id,
            chainName: chain.name,
            provider: tip.provider,
            sessionId: tip.sessionId,
            filePath: tip.filePath,
            error: message,
          });
          warnings.push(
            `链「${chain.name}」的链尾会话文件已不存在：${tip.filePath}（${tip.provider}）；下次切换会失败，可先 adopt 该 provider 的新会话`,
          );
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
        // 文件缺失已有 brokenTips / 专门警告，别再让 parse 抛 ENOENT 重复报一次
        if (!(await exists(to.filePath))) continue;
        if (!(await exists(from.filePath))) {
          warnings.push(`链「${chain.name}」的来源会话文件已不存在：${from.filePath}（${from.provider}）；链尾仍在，但无法再做内容对账`);
          continue;
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
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`链「${chain.name}」的内容对账失败：${message}`);
        }
      }
      store = { available: true, chains: chains.length, activeChains: activeChains.length, brokenTips, driftedPairs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store = { available: false, error: message };
      warnings.push(`本地库读取失败：${message}`);
    }
  }

  let imports: DoctorReport['imports'];
  if (!deps.importJobs) {
    imports = { available: false, error: deps.importJobsError ?? '导入日志目录不可用' };
  } else {
    try {
      const items = await deps.importJobs.listSummary();
      const count = (status: string) => items.filter((i) => i.status === status).length;
      imports = {
        available: true,
        total: items.length,
        imported: count('imported'),
        associated: count('associated'),
        uncertain: count('uncertain'),
        prepared: count('prepared'),
      };
      if (imports.uncertain > 0) {
        warnings.push(`有 ${imports.uncertain} 个导入/关联计划结果未知（uncertain）：不要重试，也不要删除其执行日志`);
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
