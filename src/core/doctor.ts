import type { ProviderAdapter } from '../providers/adapter.js';
import { listProviders } from '../providers/registry.js';
import type { ProviderInfo } from './types.js';
import type { Chain } from './store.js';
import type { ImportJobs } from './import-jobs.js';

export type DoctorReport = {
  cwd: string;
  providers: ProviderInfo[];
  store: { available: true; chains: number; activeChains: number } | { available: false; error: string };
  imports:
    | { available: true; total: number; imported: number; associated: number; uncertain: number; prepared: number }
    | { available: false; error: string };
  warnings: string[];
};

/** 诊断用的最小 Store 面：只要列出当前 cwd 的链，测试可注入假实现 */
export type DoctorStore = { listChains(cwd: string): Chain[] };

export type DoctorDeps = {
  /** 默认读注册表；测试注入假适配器 */
  adapters?: ProviderAdapter[];
  store: DoctorStore | null;
  storeError?: string;
  importJobs: ImportJobs | null;
  importJobsError?: string;
};

/**
 * 只读环境诊断：各项独立降级，任一失败只记入对应字段或 warnings，不影响其它项。
 * 不写库、不写原生会话、不启动外部 CLI（providers 的 detect 只做 PATH 探测）。
 */
export async function doctorReport(cwd: string, deps: DoctorDeps): Promise<DoctorReport> {
  const warnings: string[] = [];

  const providers = await listProviders(deps.adapters);

  let store: DoctorReport['store'];
  if (!deps.store) {
    store = { available: false, error: deps.storeError ?? '本地库未打开' };
  } else {
    try {
      const chains = deps.store.listChains(cwd);
      store = {
        available: true,
        chains: chains.length,
        activeChains: chains.filter((c) => c.status === 'active').length,
      };
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

  return { cwd, providers, store, imports, warnings };
}
