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

/**
 * 未知 provider 的统一文案。只写「未知 provider: codx」时，用户看不出是拼错、
 * 大小写不对（`Claude`）还是这家没接进来；把可用清单一起给出。
 * `adapters` 传进来是为了与调用方实际使用的适配器表一致（测试注入 / 子集）。
 */
export function unknownProviderMessage(id: string, adapters: ProviderAdapter[] = listAdapters()): string {
  const known = adapters.map((a) => a.id).join(' / ');
  return `未知 provider: ${id}${known ? `；可用: ${known}` : ''}`;
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
