import { readFile } from 'node:fs/promises';

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
 * 只读路径（用量统计、摘要）读取失败时的中文说明：按 errno 分开说。
 *
 * 只有 `ENOENT` / `ENOTDIR` 能说「已不存在」，`EACCES` / `EPERM` 是权限问题（先修权限，
 * 不要去重新绑定或换会话），其余带上 code / 原文。读不出来不等于「这家原生没有这项数据」。
 */
export function describeSessionReadFailure(filePath: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return `会话文件已不存在：${filePath}`;
  if (code === 'EACCES' || code === 'EPERM') return `会话文件无权读取（权限问题，不是被删除）：${filePath}`;
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `会话文件读不出来（${reason}）：${filePath}`;
}
