import { open, readFile, stat } from 'node:fs/promises';

/**
 * 读文本；文件不存在按空串处理（新建分支依赖这个语义）。
 *
 * 其它读取失败（权限、路径是目录、I/O）必须抛出：调用方都是「读既有历史 → 追加/重写」的
 * 写入路径，把读失败当成空串会让后续写入用「只有新内容」覆盖掉原历史，且 round-trip
 * 校验只看新内容，查不出来。
 */
export async function readTextOrEmpty(filePath: string, label = '既有会话文件'): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取${label}失败：${message}（未写入，避免用空内容覆盖既有历史）`);
  }
}

/**
 * 路径不存在（`ENOENT` / `ENOTDIR`）。
 *
 * 全局反查（`findById`）把扫描根目录的失败当异常抛出，是为了不把权限 / I/O 问题讲成
 * 「这个会话不存在」；但原生会话根目录在从未用过该 Agent 的机器上本来就不存在，
 * 那是正常事实、不是故障。两者都返回 `null`/空结果时，用户看到的才是干净的「没找到」。
 */
export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 只读路径（用量统计、摘要）读取失败时的中文说明：按 errno 分开说。
 *
 * 只有 `ENOENT` / `ENOTDIR` 能说「已不存在」，`EACCES` / `EPERM` 是权限问题（先修权限，
 * 不要去重新绑定或换会话），其余带上 code / 原文。读不出来不等于「这家原生没有这项数据」。
 */
export function describeSessionReadFailure(filePath: string, error: unknown): string {
  return `${describeSessionReadFailureReason(error)}：${filePath}`;
}

/**
 * 同上，但不带路径。调用方已经在前文给过路径时用它，避免同一句话里出现两次路径
 * （`watch doctor` 的「链尾会话文件状态无法确认：<路径>；<原因>」就是这种）。
 */
export function describeSessionReadFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return '会话文件已不存在';
  if (code === 'EACCES' || code === 'EPERM') return '会话文件无权读取（权限问题，不是被删除）';
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `会话文件读不出来（${reason}）`;
}

/**
 * 「路径 / 目录读不出来」的简要中文原因，用来拼在「无法读取 X 目录 <路径>：<原因>」这类消息里。
 *
 * 与 `describeSessionReadFailureReason()` 的区别：这里不假定对象是会话文件（可能是目录、
 * 数据库、索引），措辞按路径来说，避免把「读不出目录」讲成「会话文件读不出来」。
 * 适配器以前直接把 `error.message` 拼进用户面文案，`sessions` / `recent` / `doctor` 的
 * warnings 里就会出现 `EACCES: permission denied, scandir '…'` 这类英文原文。
 */
export function describePathReadFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return '路径不存在（可能刚被移动或删除）';
  if (code === 'EACCES' || code === 'EPERM') return '无权读取（权限问题，不是路径写错）';
  if (code === 'EISDIR') return '该路径是目录，不是文件';
  if (code) return `读取失败（${code}）`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Node 文件系统错误的 `code`（`EACCES` / `EISDIR` / `EIO`…）。
 *
 * 用来区分「文件读不出来」与「文件读出来了但内容解析不了」：前者要说权限 / 路径，
 * 后者才该说内容。只认 `E` + 大写的形状，别把适配器自己造的错误码（如 `parse_failed`）误判成 fs 错误。
 */
export function isFileSystemErrorCode(code: unknown): code is string {
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
}

/**
 * 「读不出来」的原因：文件系统错误按 errno 说中文，其余保留适配器 / 业务自己的说明。
 *
 * `parse` / `sessionUsage` / `listSessions` 既可能因权限 / 路径抛 fs 错误（原文是
 * `EACCES: permission denied, open '…'`），也可能自己抛出已经写好的中文错误（格式坏、
 * 库打不开）。统一走这里，就不会出现「把权限问题讲成格式问题」或半句英文 errno。
 */
export function describeReadFailureOrSelf(error: unknown): string {
  return isFileSystemErrorCode((error as NodeJS.ErrnoException).code)
    ? describeSessionReadFailureReason(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

export type SessionFilePresence =
  | { state: 'present'; isFile: boolean }
  | { state: 'missing' }
  | { state: 'unknown'; reason: string };

/**
 * `stat` 一次会话文件，判断它「确实不在了」还是「只是读不出来」。
 *
 * 只有 `ENOENT` / `ENOTDIR` 是 missing；`EACCES` / `EIO` 等返回 unknown 并给出原因，
 * 调用方必须把这类当成「状态无法确认」，不能讲成「文件已被删除」——否则权限问题
 * 会被读成会话丢了，人会去重新绑定或重建，而不是修权限。
 */
export async function sessionFilePresence(filePath: string): Promise<SessionFilePresence> {
  try {
    const info = await stat(filePath);
    return { state: 'present', isFile: info.isFile() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    return { state: 'unknown', reason: describeSessionReadFailure(filePath, error) };
  }
}

/**
 * 「这条会话是空的（0 字节）」的说明。`probeSessionReadable()`、各家预览与 cwd 解析共用同一句，
 * 不想在四五个地方各写一遍——措辞不一致时同一个状态在 `open` / `sessions` / `doctor` 上会有三种说法。
 *
 * 0 字节不是「这条会话还没有内容」：进程被杀 / 只写了一半 / 磁盘满都会留下这种文件，而合法的
 * 空会话（`new` 建出来的）每家都写了占位内容，不会是 0 字节（见 `src/providers/CLAUDE.md`）。
 */
export function describeEmptySessionFile(filePath: string): string {
  return `会话文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${filePath}`;
}

/**
 * 列表路径用：这次 `stat` 拿到的会话文件是不是「空的」。
 *
 * claude / codex / kimi 的预览都要把会话文件读一遍，0 字节在那里顺手就能发现（`raw.length === 0`）。
 * pi / grok 的预览不读会话内容——pi 干脆没有预览，grok 的标题来自 `summary.json`——于是
 * **同一个状态在 `open` 与 `sessions` 上说法相反**：`open` 会说「会话文件是空的…内容已丢失」，
 * 列表与 `doctor` 却把这条会话算成正常的一条、`warnings` 一个字都没有。判据放在这里，
 * 两家的列表在已经拿到的 `stat` 上判一次即可，不必各写一句（措辞分叉正是本文件开头要避免的）。
 *
 * 只按 `isFile() && size === 0` 判：目录 / 设备文件走 `sessionFilePresence()` 那一档，
 * 两处不重复下结论。
 */
export function emptySessionFileReasonFromStat(
  info: { isFile(): boolean; size: number },
  filePath: string,
): string | undefined {
  return info.isFile() && info.size === 0 ? describeEmptySessionFile(filePath) : undefined;
}

/**
 * 这条原因是不是「会话文件是空的」那一档。
 *
 * 0 字节与读不出来（权限、路径）都会进 `previewError` 与 doctor 的 unreadable 汇总，但下一步
 * 相反：权限要修权限，空文件的内容已经没了，只能重新开一次会话或从备份恢复。警告文案按它分档。
 */
export function isEmptySessionFileReason(reason: string): boolean {
  return reason.includes('会话文件是空的');
}

/**
 * 只读探一次「这个会话文件现在读得出来吗」：`open` 一下外加一次 `fstat`，不读内容。
 *
 * `stat` 成功不代表读得出来（`chmod 000` 的文件 `stat` 照常返回），所以只 `stat` /
 * 只列目录的路径（如 `adopt` 写链记录）会显得一切正常，而它打印的 resume 命令
 * 一执行就失败。返回 `null` 表示读得出来，否则是中文原因（已带路径）。
 *
 * **`open` 成功也不代表有内容可恢复**：进程被杀 / 只写了一半 / 磁盘满时，会话文件会被
 * 截成 0 字节，`open` 依然成功。claude / codex / pi 的 cwd 来自文件内容，`findById` 会报
 * 「找到了，但读不出来：…（会话文件是空的…）」；grok 的 cwd 来自目录名、kimi 来自索引，
 * 一条 0 字节的文件照样反查得到，`open` 的四条分支（摘要、`--from` 的来源与目标、
 * `--to` 同家快路径、`--to` 的空来源）得自己探这一下。`switch` 的链尾、`new` 的同家拒绝、
 * `status` 的链尾与 tips、`chain list` 的 tip、`doctor` 的 pathPresence、`adopt` 也共用它；
 * 漏了任何一处都会替一条空文件宣称「可以直接打开」。判据放在这里而不是各调用点各写一遍。
 */
export async function probeSessionReadable(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    // 只有普通文件才按字节数判；目录 / 设备文件走原来的「打得开就算读得出」，
    // 它们的「不是普通文件」由 sessionFilePresence() 单独说，两处不重复下结论
    if (info.isFile() && info.size === 0) {
      return describeEmptySessionFile(filePath);
    }
    return null;
  } catch (error) {
    // 这里只报「读不出来」：文件确实不在时也要说清，否则用户会去反复试 resume
    if (isMissingPathError(error)) return `会话文件已不存在：${filePath}`;
    return describeSessionReadFailure(filePath, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}
