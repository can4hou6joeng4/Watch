import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from './app-server.js';
import { escapeControlChars } from '../../core/display.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type CodexDesktopProject = {
  policy: 'codex-desktop-project-first-v1';
  legacyProjectId: string;
  nativeProjectId: string;
  name: string;
  rootPaths: string[];
};

/**
 * 状态文件读不出来时的统一说法（`lstat` 与 `readFile` 两处共用）。
 *
 * 只有 `ENOENT` 是「桌面端还没添加这个项目」——这是用户能照着做的下一步。
 * `ENOTDIR` 是路径上某一级被同名文件占住：桌面端根本写不进来，让人去「添加项目」是错的指引；
 * `EACCES` 是权限问题，与内容损坏无关。以前 `lstat` 分支把后两者原样抛出，桌面卡片上只剩
 * 一句 `ENOTDIR: not a directory, lstat '…'`。
 */
function describeStateFileFailure(error: unknown, statePath: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return '找不到 Codex Desktop 的本地项目状态；请先在桌面端把这个目录添加为项目，再导入';
  }
  if (code === 'ENOTDIR') {
    return `Codex Desktop 项目状态路径上的某一级不是目录（被同名文件占住了？）：${escapeControlChars(statePath)}；先修好这个路径，再重新预览`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Codex Desktop 的项目状态文件无权读取（权限或归属变了，不是文件内容坏了）：${escapeControlChars(statePath)}；先确认当前用户能读取它，再重新预览`;
  }
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `Codex Desktop 的项目状态文件读不出来（${reason}）：${escapeControlChars(statePath)}；先确认这个路径可读，再重新预览`;
}

async function readCodexDesktopState(codexHome: string): Promise<Record<string, unknown>> {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  let stat;
  try {
    stat = await lstat(statePath);
  } catch (error) {
    throw new Error(describeStateFileFailure(error, statePath));
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex Desktop 项目状态必须是普通文件');

  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    // 读不出来 ≠ 内容坏了：把 EACCES 说成「无法解析」会让人去查文件内容，而真正要修的是权限
    throw new Error(describeStateFileFailure(error, statePath));
  }

  let state: Record<string, unknown>;
  try {
    state = asRecord(JSON.parse(raw));
  } catch {
    throw new Error(`Codex Desktop 项目状态无法解析（不是合法的 JSON 对象，桌面端可能只写了一半）：${escapeControlChars(statePath)}；在桌面端重新打开该项目后再预览`);
  }
  return state;
}

export async function inspectCodexDesktopProject(codexHome: string, cwd: string): Promise<CodexDesktopProject> {
  const state = await readCodexDesktopState(codexHome);
  const projects = asRecord(state['local-projects']);
  const matches = Object.entries(projects).flatMap(([key, value]) => {
    const project = asRecord(value);
    const rootPaths = Array.isArray(project.rootPaths)
      ? project.rootPaths.filter((root): root is string => typeof root === 'string')
      : [];
    if (!rootPaths.includes(cwd)) return [];
    const id = typeof project.id === 'string' ? project.id : key;
    const name = typeof project.name === 'string' ? project.name : '';
    return UUID.test(id) && name.length > 0 ? [{ legacyProjectId: id, name, rootPaths }] : [];
  });
  if (matches.length !== 1) {
    throw new Error('导入前，该目录必须恰好匹配一个已有的 Codex Desktop 项目');
  }

  const identity = `local:${codexHome}`;
  const mappings = asRecord(asRecord(state['app-server-project-id-by-legacy-project-id-by-host'])[identity]);
  const match = matches[0]!;
  const nativeProjectId = mappings[match.legacyProjectId];
  if (typeof nativeProjectId !== 'string' || !UUID.test(nativeProjectId)) {
    throw new Error('Codex Desktop 还没有把该项目同步到本地 app-server；请在桌面端重新打开该项目后再预览');
  }
  return {
    policy: 'codex-desktop-project-first-v1',
    ...match,
    nativeProjectId,
  };
}

export async function assertCodexDesktopThreadPlacement(
  codexHome: string,
  threadId: string,
  project: CodexDesktopProject,
): Promise<void> {
  if (!UUID.test(threadId)) throw new Error('导入的 Codex 线程 ID 不是合法 UUID');
  const state = await readCodexDesktopState(codexHome);
  const projectless = state['projectless-thread-ids'];
  if (projectless != null && (!Array.isArray(projectless) || projectless.some((id) => typeof id !== 'string'))) {
    throw new Error('无法校验 Codex Desktop 的 projectless 线程状态');
  }
  if ((projectless as string[] | undefined)?.includes(threadId)) {
    throw new Error('Codex Desktop 把导入的线程归为 projectless（无项目）；公开的项目元数据无法让它显示在项目列表里');
  }

  const assignment = asRecord(state['thread-project-assignments'] ?? {})[threadId];
  if (assignment == null) return;
  const value = asRecord(assignment);
  if (value.projectKind !== 'local' || value.projectId !== project.legacyProjectId) {
    throw new Error('Codex Desktop 把导入的线程分配给了另一个项目');
  }
}

export function sameCodexDesktopProject(left: CodexDesktopProject, right: CodexDesktopProject): boolean {
  return left.policy === right.policy && left.legacyProjectId === right.legacyProjectId &&
    left.nativeProjectId === right.nativeProjectId && left.name === right.name &&
    left.rootPaths.length === right.rootPaths.length && left.rootPaths.every((root, index) => root === right.rootPaths[index]);
}
