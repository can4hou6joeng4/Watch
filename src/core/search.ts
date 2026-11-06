import { stat } from 'node:fs/promises';
import type { Store } from './store.js';
import type { ProviderAdapter } from '../providers/adapter.js';

/**
 * 重建 cwd 下各 provider 的 FTS 索引。
 * 增量：`search_index` 里记录的 mtime + size 未变就跳过解析；单会话 parse 失败保留旧行。
 * 索引里记录的原生文件已不存在时清掉该会话，但 `listSessions` 可能有 50 条上限，
 * 不能拿「本轮列表」当删除依据——只认文件是否还在。
 */
export async function reindexCwd(cwd: string, adapters: ProviderAdapter[], store: Store): Promise<number> {
  let n = 0;
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    let list;
    try {
      list = await adapter.listSessions(cwd);
    } catch {
      continue; // 列目录失败时无法确认会话状态，保留既有索引
    }
    const stats = store.indexedStats(cwd, adapter.id);
    for (const s of list) {
      const st = await stat(s.ref.filePath).catch(() => null);
      if (!st?.isFile()) continue;
      const cached = stats.get(s.ref.sessionId);
      if (cached && cached.filePath === s.ref.filePath && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        continue; // 文件没变，复用既有索引
      }
      try {
        const turns = await adapter.parse(s.ref);
        store.reindexSession({
          cwd,
          sessionId: s.ref.sessionId,
          provider: adapter.id,
          filePath: s.ref.filePath,
          texts: turns.map((t) => t.text),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
        n += 1;
      } catch {
        /* 单文件失败不阻断；不记录游标，下轮重试 */
      }
    }
    for (const indexed of store.indexedSessions(cwd, adapter.id)) {
      const exists = await stat(indexed.filePath).then((st) => st.isFile(), () => false);
      if (!exists) store.removeIndexedSession(cwd, adapter.id, indexed.sessionId);
    }
  }
  return n;
}
