import { stat } from 'node:fs/promises';
import type { Store } from './store.js';
import type { ProviderAdapter } from '../providers/adapter.js';

/**
 * 重建 cwd 下各 provider 的 FTS 索引。
 * 增量：`search_index` 里记录的 mtime + size 未变就跳过解析；单会话 parse 失败保留旧行。
 * 索引里记录的原生文件已不存在时清掉该会话，但 `listSessions` 可能有 50 条上限，
 * 不能拿「本轮列表」当删除依据——只认文件是否还在。
 * 列目录 / 解析失败只跳过并写进可选的 `warnings`，不静默吞掉。
 */
export async function reindexCwd(
  cwd: string,
  adapters: ProviderAdapter[],
  store: Store,
  warnings?: string[],
): Promise<number> {
  let n = 0;
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    let list;
    try {
      list = await adapter.listSessions(cwd);
    } catch (error) {
      // 列目录失败时无法确认会话状态，保留既有索引；但要披露，否则搜索结果会静默缺一家
      warnings?.push(
        `${adapter.id} 会话列表读取失败，本次未更新其索引：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const stats = store.indexedStats(cwd, adapter.id);
    // listSessions 有上限时，更早的会话本轮根本不会被枚举到，索引里也就永远没有它们——
    // 不说清楚，「搜不到」会被当成「没聊过」
    const cap = adapter.listSessionsCap;
    if (cap !== undefined && list.length >= cap) {
      warnings?.push(
        `${adapter.id} 会话数达到列表上限 ${cap}，本次只索引最近的 ${cap} 个会话，更早的会话搜不到`,
      );
    }
    let failed = 0;
    let firstError = '';
    let unreadable = 0;
    let firstUnreadable = '';
    for (const s of list) {
      let st;
      try {
        st = await stat(s.ref.filePath);
      } catch (error) {
        // 列表里有、stat 不到：ENOENT 是这一瞬间被删掉，交给下面的清理；
        // 其余（ENOTDIR / EACCES / EIO…）不能当成没事跳过 —— 这一轮就没更新它，必须披露
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          unreadable += 1;
          firstUnreadable ||= `${s.ref.filePath}（${error instanceof Error ? error.message : String(error)}）`;
        }
        continue;
      }
      if (!st.isFile()) continue;
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
      } catch (error) {
        /* 单文件失败不阻断；不记录游标，下轮重试 */
        failed += 1;
        firstError ||= error instanceof Error ? error.message : String(error);
      }
    }
    if (failed > 0) {
      warnings?.push(`${adapter.id} 有 ${failed} 个会话解析失败，索引未更新（首个错误：${firstError}）`);
    }
    if (unreadable > 0) {
      warnings?.push(`${adapter.id} 有 ${unreadable} 个会话读不出文件状态，索引未更新（首个：${firstUnreadable}）`);
    }
    let keepFailed = 0;
    let firstKeepError = '';
    for (const indexed of store.indexedSessions(cwd, adapter.id)) {
      let gone = false;
      try {
        gone = !(await stat(indexed.filePath)).isFile();
      } catch (error) {
        // 只有 ENOENT 才算「文件已不存在」。权限 / 路径错误下删索引，等于把「读不到」
        // 当成「没有聊过」：搜索结果会静默变少，权限恢复后还得重新全量解析
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          keepFailed += 1;
          firstKeepError ||= `${indexed.filePath}（${error instanceof Error ? error.message : String(error)}）`;
          continue;
        }
        gone = true;
      }
      if (gone) store.removeIndexedSession(cwd, adapter.id, indexed.sessionId);
    }
    if (keepFailed > 0) {
      warnings?.push(
        `${adapter.id} 有 ${keepFailed} 个已索引会话读不出文件状态，索引保留未清理（首个：${firstKeepError}）`,
      );
    }
  }
  return n;
}
