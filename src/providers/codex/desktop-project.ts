import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from './app-server.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type CodexDesktopProject = {
  policy: 'codex-desktop-project-first-v1';
  legacyProjectId: string;
  nativeProjectId: string;
  name: string;
  rootPaths: string[];
};

async function readCodexDesktopState(codexHome: string): Promise<Record<string, unknown>> {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  let stat;
  try {
    stat = await lstat(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Codex Desktop has no local project state; add this folder in the desktop app before importing');
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex Desktop project state must be a regular file');

  let state: Record<string, unknown>;
  try {
    state = asRecord(JSON.parse(await readFile(statePath, 'utf8')));
  } catch {
    throw new Error('Cannot read Codex Desktop project state');
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
    throw new Error('The cwd must match exactly one existing Codex Desktop project before importing');
  }

  const identity = `local:${codexHome}`;
  const mappings = asRecord(asRecord(state['app-server-project-id-by-legacy-project-id-by-host'])[identity]);
  const match = matches[0]!;
  const nativeProjectId = mappings[match.legacyProjectId];
  if (typeof nativeProjectId !== 'string' || !UUID.test(nativeProjectId)) {
    throw new Error('Codex Desktop has not synchronized this project with the local app-server; reopen the project and retry preview');
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
  if (!UUID.test(threadId)) throw new Error('Invalid imported Codex thread ID');
  const state = await readCodexDesktopState(codexHome);
  const projectless = state['projectless-thread-ids'];
  if (projectless != null && (!Array.isArray(projectless) || projectless.some((id) => typeof id !== 'string'))) {
    throw new Error('Cannot verify Codex Desktop projectless thread state');
  }
  if ((projectless as string[] | undefined)?.includes(threadId)) {
    throw new Error('Codex Desktop classifies the imported thread as projectless; public project metadata cannot make it visible');
  }

  const assignment = asRecord(state['thread-project-assignments'] ?? {})[threadId];
  if (assignment == null) return;
  const value = asRecord(assignment);
  if (value.projectKind !== 'local' || value.projectId !== project.legacyProjectId) {
    throw new Error('Codex Desktop assigns the imported thread to a different project');
  }
}

export function sameCodexDesktopProject(left: CodexDesktopProject, right: CodexDesktopProject): boolean {
  return left.policy === right.policy && left.legacyProjectId === right.legacyProjectId &&
    left.nativeProjectId === right.nativeProjectId && left.name === right.name &&
    left.rootPaths.length === right.rootPaths.length && left.rootPaths.every((root, index) => root === right.rootPaths[index]);
}
