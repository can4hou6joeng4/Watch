import type { ProviderAdapter } from './adapter.js';
import type { ProviderInfo } from '../core/types.js';
import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import { piAdapter } from './pi/index.js';
import { kimiAdapter } from './kimi/index.js';
import { opencodeAdapter } from './opencode/index.js';
import { grokAdapter } from './grok/index.js';

/** Provider 注册表：UI 下拉从这里读；新增 Provider 只加一行 */
const adapters: ProviderAdapter[] = [
  claudeAdapter,
  codexAdapter,
  piAdapter,
  kimiAdapter,
  opencodeAdapter,
  grokAdapter,
];

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

export function listAdapters(): ProviderAdapter[] {
  return [...adapters];
}

/** `overrides` 只给测试注入假适配器用；默认读注册表 */
export async function listProviders(overrides?: ProviderAdapter[]): Promise<ProviderInfo[]> {
  return Promise.all(
    (overrides ?? adapters).map(async (a) => {
      try {
        return { id: a.id, displayName: a.displayName, available: await a.detect() };
      } catch (error) {
        // 一家检测抛错不能拖垮整张表；把原因带出去，和「没装」区分开
        return {
          id: a.id,
          displayName: a.displayName,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
