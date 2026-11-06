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
  } catch {
    return `--cwd 目录不存在或无法访问：${cwd}；各 provider 按原生记录的路径字符串精确比较，路径不对会全部显示 0`;
  }
}
