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
