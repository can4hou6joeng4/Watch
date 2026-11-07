import { readFile, stat } from 'node:fs/promises';

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
