import { stat } from 'node:fs/promises';
import type { Store } from './store.js';
import type { ProviderAdapter } from '../providers/adapter.js';
import type { EmptiedSession } from './session-coverage.js';
import { escapeControlChars } from './display.js';
import {
  describePathReadFailureReason,
  describeSessionReadFailureReason,
  isEmptySessionFileReason,
  isFileSystemErrorCode,
} from './read-text.js';

/**
 * 重建 cwd 下各 provider 的 FTS 索引。
 * 增量：`search_index` 里记录的 mtime + size 未变就跳过解析；单会话 parse 失败保留旧行。
 * 索引里记录的原生文件已不存在时清掉该会话，但 `listSessions` 可能有 50 条上限，
 * 不能拿「本轮列表」当删除依据——只认文件是否还在。
 * 列目录 / 解析失败只跳过并写进可选的 `warnings`，不静默吞掉。
 *
 * `unavailable`（可选）收集这轮**压根没读成**的 provider：调用方拿它把「没有匹配」与
 * 「这一家没查成」分开——只有 warnings 字符串时，正文那句「无结果」照样会被当成结论。
 *
 * `emptied`（可选）收集列表里**文件是 0 字节**的会话：索引里一行内容都没有，命中永远为零。
 * 判定用列表已经给出的 `previewError`（各家列会话时判过，判据与 `describeEmptySessionFile()` 同源），
 * 不在这里再 `stat` 一次，也不把「读不出来」（权限）混进这一档——两者下一步相反。
 */
export async function reindexCwd(
  cwd: string,
  adapters: ProviderAdapter[],
  store: Store,
  warnings?: string[],
  unavailable?: string[],
  emptied?: EmptiedSession[],
): Promise<number> {
  let n = 0;
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    let list;
    try {
      list = await adapter.listSessions(cwd);
    } catch (error) {
      // 列目录失败时无法确认会话状态，保留既有索引；但要披露，否则搜索结果会静默缺一家
      unavailable?.push(adapter.id);
      warnings?.push(
        `${adapter.id} 会话列表读取失败，本次未更新其索引：${describePathReadFailureReason(error)}`,
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
    let occupied = 0;
    let firstOccupied = '';
    for (const s of list) {
      // 0 字节的会话在列表里是「正常的一条」（各家按 `previewError` 说明它空了），索引里却
      // 一行内容都没有：搜索永远命中不了它。放在 `cached` 跳过之前——文件被截断后 size 变了
      // 会被重新解析一遍，但披露的是「这个目录有几条空会话」，与是否本轮重新索引无关。
      if (s.previewError && isEmptySessionFileReason(s.previewError)) {
        emptied?.push({ provider: adapter.id, sessionId: s.ref.sessionId, filePath: s.ref.filePath });
      }
      let st;
      try {
        st = await stat(s.ref.filePath);
      } catch (error) {
        // 列表里有、stat 不到：ENOENT 是这一瞬间被删掉，交给下面的清理；
        // 其余（ENOTDIR / EACCES / EIO…）不能当成没事跳过 —— 这一轮就没更新它，必须披露
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          unreadable += 1;
          firstUnreadable ||= `${escapeControlChars(s.ref.filePath)}（${describePathReadFailureReason(error)}）`;
        }
        continue;
      }
      // 路径在、但被同名目录 / 设备文件占住：既不是「已删除」，也读不出内容。
      // 静默 `continue` 会让这一轮索引不生效且没人知道——与 `doctor` / `chain list` 的说法保持一致
      if (!st.isFile()) {
        occupied += 1;
        firstOccupied ||= s.ref.filePath;
        continue;
      }
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
        // parse 顺带把文件读进来：EACCES / EIO 是「读不出来」，不是「内容格式不对」，
        // 反过来讲会让人去查文件内容而不是权限；适配器自己抛的内容错误本来已是中文，原样保留
        firstError ||= isFileSystemErrorCode((error as NodeJS.ErrnoException).code)
          ? describeSessionReadFailureReason(error)
          : error instanceof Error
            ? error.message
            : String(error);
      }
    }
    if (failed > 0) {
      warnings?.push(`${adapter.id} 有 ${failed} 个会话解析失败，索引未更新（首个错误：${firstError}）`);
    }
    if (unreadable > 0) {
      warnings?.push(`${adapter.id} 有 ${unreadable} 个会话读不出文件状态，索引未更新（首个：${firstUnreadable}）`);
    }
    if (occupied > 0) {
      warnings?.push(
        `${adapter.id} 有 ${occupied} 个会话路径不是普通文件（被同名目录或设备文件占住了），本次未更新其索引（首个：${firstOccupied}）`,
      );
    }
    let keepFailed = 0;
    let firstKeepError = '';
    let keepOccupied = 0;
    let firstKeepOccupied = '';
    for (const indexed of store.indexedSessions(cwd, adapter.id)) {
      let gone = false;
      try {
        const st = await stat(indexed.filePath);
        // 路径被同名目录 / 设备文件占住，不等于「会话已被删除」：按 gone 删索引会让搜索结果
        // 静默变少，而用户看到的只是「这个目录没聊过」。保留旧行并披露
        if (!st.isFile()) {
          keepOccupied += 1;
          firstKeepOccupied ||= indexed.filePath;
          continue;
        }
      } catch (error) {
        // 只有 ENOENT 才算「文件已不存在」。权限 / 路径错误下删索引，等于把「读不到」
        // 当成「没有聊过」：搜索结果会静默变少，权限恢复后还得重新全量解析
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          keepFailed += 1;
          firstKeepError ||= `${escapeControlChars(indexed.filePath)}（${describePathReadFailureReason(error)}）`;
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
    if (keepOccupied > 0) {
      warnings?.push(
        `${adapter.id} 有 ${keepOccupied} 个已索引会话的路径不是普通文件（被同名目录或设备文件占住了），索引保留未清理（首个：${firstKeepOccupied}）；恢复该路径后重新 search 即可对齐`,
      );
    }
  }
  return n;
}
