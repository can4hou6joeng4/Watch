// `--cwd` 指向的路径是否有问题：各 provider 的 listSessions / findLatestSession 按原生记录的
// 路径字符串精确比较，路径错了只会安静返回 0，看起来像「这个目录没有会话」。查询类命令与
// `watch doctor` 统一用这里的说明做披露，避免同一个坑每处各写一份文案。
import { stat } from 'node:fs/promises';

/**
 * 一个目录现在能不能用。分开说「不存在」与「读不出来」是因为两者下一步完全不同：
 * 前者要恢复 / 改正路径，后者是权限问题，改路径只会白折腾一遍。
 * `not-directory` 是 `stat` 成功但对象不是目录（被同名文件占住）；`missing` 包含 `ENOTDIR`
 * （路径上某一级是文件），对调用方而言都是「这个目录进不去」。
 */
export type CwdInspection =
  | { state: 'ok' }
  | { state: 'not-directory' }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'unknown'; reason: string };

/** 只回答「这个目录能不能进、为什么不能」，文案由调用方按自己的语境拼。 */
export async function inspectCwd(cwd: string): Promise<CwdInspection> {
  try {
    const probe = await stat(cwd);
    return probe.isDirectory() ? { state: 'ok' } : { state: 'not-directory' };
  } catch (error) {
    // 只有 ENOENT / ENOTDIR 才能说「不存在」：EACCES 等读不出来时要说清是权限，
    // 否则权限问题会被讲成路径写错，用户会去改路径而不是修权限
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'denied' };
    return { state: 'unknown', reason: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * 查询类命令（`status` / `sessions` / `recent` / `search` / `usage` / `chain list`）的口径：
 * 路径不对时各 provider 只会安静返回 0 条，所以要说清「下面的 0 不代表目录里真没有会话」。
 */
export function describeCwdProblem(probe: CwdInspection, cwd: string): string | null {
  const tail = '各 provider 按原生记录的路径字符串精确比较，路径不对会全部显示 0';
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `--cwd 指向的不是目录：${cwd}；会话与链都按路径精确匹配，结果不代表任何真实项目`;
    case 'missing':
      return `--cwd 目录不存在：${cwd}；${tail}`;
    case 'denied':
      return `--cwd 目录无权访问：${cwd}（权限问题，不是路径写错）；${tail}`;
    case 'unknown':
      return `--cwd 目录无法访问：${cwd}（${probe.reason}）；${tail}`;
  }
}

/**
 * 写入口径（`watch new`）：这里没有任何列表参与，后果不是「显示 0」，而是**真的在原生存储里
 * 建出一个绑定到这个目录的会话**，打印的 `resume` 命令随后会在进入目录时失败。所以不带上
 * 「全部显示 0」那句——复用它会让用户以为这只是一次「查不到」，而实际已经写进去了东西。
 * 只给出原因前半句，具体的会话文件路径由调用方补（它要等会话建出来才知道）。
 */
export function describeNewSessionCwd(probe: CwdInspection, cwd: string): string | null {
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `--cwd 不是目录（被同名文件占住了）：${cwd}`;
    case 'missing':
      return `--cwd 目录不存在：${cwd}`;
    case 'denied':
      return `--cwd 目录无权访问：${cwd}（权限问题，不是路径写错）`;
    case 'unknown':
      return `--cwd 目录无法访问：${cwd}（${probe.reason}）`;
  }
}

/** 路径有问题时返回一句可直接输出的说明；正常目录返回 null（不做符号链接 / realpath 归因）。 */
export async function cwdProblem(cwd: string): Promise<string | null> {
  return describeCwdProblem(await inspectCwd(cwd), cwd);
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
  const probe = await inspectCwd(cwd);
  const tail = '下面的 cd 命令会在这里失败——先恢复这个目录，或手动 cd 到新位置再执行 resume 命令';
  switch (probe.state) {
    case 'ok':
      return null;
    case 'not-directory':
      return `会话记录的工作目录不是目录（被同名文件占住了）：${cwd}；下面的 cd 命令会失败——先让这个路径重新成为目录`;
    case 'missing':
      return `会话记录的工作目录已不存在：${cwd}（项目可能被移动或删除）；${tail}；会话内容本身仍可读取 / 转入`;
    case 'denied':
      return `会话记录的工作目录无权访问：${cwd}（权限问题，不是被删除）；${tail}`;
    case 'unknown':
      return `无法确认会话记录的工作目录能否进入：${cwd}（${probe.reason}）；${tail}`;
  }
}
