/** node:sqlite 在 22.13 才去掉实验标志；更低版本整个 CLI 会在模块加载期崩溃 */
export const MIN_NODE = '22.13';

/**
 * 返回不可用原因（中文，可直接展示给用户），版本够用返回 null。
 * 无法解析的版本串不阻断——门槛判断失败不应该把 CLI 一起拦下。
 */
export function nodeVersionProblem(version: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 13)) {
    return `需要 Node ≥ ${MIN_NODE}（当前 ${version}）：node:sqlite 在该版本才可用。请升级 Node 后重试。`;
  }
  return null;
}
