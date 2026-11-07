// `--cwd` 指向的路径是否有问题：各 provider 的 listSessions / findLatestSession 按原生记录的
// 路径字符串精确比较，路径错了只会安静返回 0，看起来像「这个目录没有会话」。查询类命令与
// `watch doctor` 统一用这里的说明做披露，避免同一个坑每处各写一份文案。
import { stat } from 'node:fs/promises';

/** 路径有问题时返回一句可直接输出的说明；正常目录返回 null（不做符号链接 / realpath 归因）。 */
export async function cwdProblem(cwd: string): Promise<string | null> {
  try {
    const probe = await stat(cwd);
    if (!probe.isDirectory()) {
      return `--cwd 指向的不是目录：${cwd}；会话与链都按路径精确匹配，结果不代表任何真实项目`;
    }
    return null;
  } catch (error) {
    // 只有 ENOENT / ENOTDIR 才能说「不存在」：EACCES 等读不出来时把原因写清楚，
    // 否则权限问题会被讲成路径写错，用户会去改 --cwd 而不是修权限
    const code = (error as NodeJS.ErrnoException).code;
    const tail = '各 provider 按原生记录的路径字符串精确比较，路径不对会全部显示 0';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return `--cwd 目录不存在：${cwd}；${tail}`;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return `--cwd 目录无权访问：${cwd}（权限问题，不是路径写错）；${tail}`;
    }
    const reason = code ?? (error instanceof Error ? error.message : String(error));
    return `--cwd 目录无法访问：${cwd}（${reason}）；${tail}`;
  }
}

/**
 * 会话记录里的工作目录还能不能进。
 *
 * `open` 返回的 `cd … && <resume>` 与原生 resume 都在这个目录里执行；目录被删 / 被移动后，
 * 会话内容本身读得出来、转入也照样写成功，但命令会在第一步 `cd` 就失败。以前这种情况
 * 只有一句成功的 resume 命令，用户会以为是 CLI 或会话坏了。原因按 errno 分开说：
 * 权限问题不是「被删除」，别把人引去重建目录。
 */
export async function sessionCwdProblem(cwd: string): Promise<string | null> {
  try {
    const probe = await stat(cwd);
    if (!probe.isDirectory()) {
      return `会话记录的工作目录不是目录（被同名文件占住了）：${cwd}；下面的 cd 命令会失败——先让这个路径重新成为目录`;
    }
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const tail = '下面的 cd 命令会在这里失败——先恢复这个目录，或手动 cd 到新位置再执行 resume 命令';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return `会话记录的工作目录已不存在：${cwd}（项目可能被移动或删除）；${tail}；会话内容本身仍可读取 / 转入`;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return `会话记录的工作目录无权访问：${cwd}（权限问题，不是被删除）；${tail}`;
    }
    const reason = code ?? (error instanceof Error ? error.message : String(error));
    return `无法确认会话记录的工作目录能否进入：${cwd}（${reason}）；${tail}`;
  }
}
