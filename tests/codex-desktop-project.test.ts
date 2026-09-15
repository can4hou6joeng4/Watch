import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';
import {
  assertCodexDesktopThreadPlacement,
  inspectCodexDesktopProject,
  sameCodexDesktopProject,
} from '../src/providers/codex/desktop-project.js';

test('desktop project preflight binds one exact cwd to its synchronized app-server project', async (t) => {
  const env = await createIsolatedEnvironment('watch-desktop-project-');
  t.after(() => env.cleanup());
  const codexHome = path.join(env.home, '.codex');
  const cwd = path.join(env.root, 'project with spaces');
  const legacyProjectId = randomUUID();
  const nativeProjectId = randomUUID();
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      [legacyProjectId]: { id: legacyProjectId, name: 'Fixture', rootPaths: [cwd], createdAt: 1, updatedAt: 1 },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      [`local:${codexHome}`]: { [legacyProjectId]: nativeProjectId },
    },
  }));

  const result = await inspectCodexDesktopProject(codexHome, cwd);
  assert.deepEqual(result, {
    policy: 'codex-desktop-project-first-v1', legacyProjectId, nativeProjectId, name: 'Fixture', rootPaths: [cwd],
  });
  assert.equal(sameCodexDesktopProject(result, { ...result }), true);
  assert.equal(sameCodexDesktopProject(result, { ...result, nativeProjectId: randomUUID() }), false);
});

test('desktop placement preflight rejects projectless and conflicting private assignments', async (t) => {
  const env = await createIsolatedEnvironment('watch-desktop-placement-');
  t.after(() => env.cleanup());
  const codexHome = path.join(env.home, '.codex');
  const cwd = path.join(env.root, 'project');
  const legacyProjectId = randomUUID();
  const project = {
    policy: 'codex-desktop-project-first-v1' as const,
    legacyProjectId,
    nativeProjectId: randomUUID(),
    name: 'Fixture',
    rootPaths: [cwd],
  };
  const threadId = randomUUID();
  await mkdir(codexHome, { recursive: true });
  const statePath = path.join(codexHome, '.codex-global-state.json');
  const writeState = (projectless: unknown, assignment?: unknown) => writeFile(statePath, JSON.stringify({
    'projectless-thread-ids': projectless,
    'thread-project-assignments': assignment === undefined ? {} : { [threadId]: assignment },
  }));

  await writeState([], undefined);
  await assert.doesNotReject(assertCodexDesktopThreadPlacement(codexHome, threadId, project));
  await writeState([], { projectKind: 'local', projectId: legacyProjectId });
  await assert.doesNotReject(assertCodexDesktopThreadPlacement(codexHome, threadId, project));
  await writeState([threadId], undefined);
  await assert.rejects(assertCodexDesktopThreadPlacement(codexHome, threadId, project), /projectless/);
  await writeState([], { projectKind: 'local', projectId: randomUUID() });
  await assert.rejects(assertCodexDesktopThreadPlacement(codexHome, threadId, project), /different project/);
  await writeState('invalid', undefined);
  await assert.rejects(assertCodexDesktopThreadPlacement(codexHome, threadId, project), /Cannot verify/);
});

test('desktop project preflight rejects missing, ambiguous, unsynchronized, and symlinked state', async (t) => {
  for (const issue of ['missing', 'ambiguous', 'unsynchronized', 'symlink'] as const) {
    const env = await createIsolatedEnvironment(`watch-desktop-project-${issue}-`);
    t.after(() => env.cleanup());
    const codexHome = path.join(env.home, '.codex');
    const cwd = path.join(env.root, 'project');
    const first = randomUUID();
    const second = randomUUID();
    const native = randomUUID();
    await mkdir(codexHome, { recursive: true });
    if (issue === 'missing') {
      await assert.rejects(inspectCodexDesktopProject(codexHome, cwd), /add this folder/);
      continue;
    }
    const state = {
      'local-projects': {
        [first]: { id: first, name: 'First', rootPaths: [cwd] },
        ...(issue === 'ambiguous' ? { [second]: { id: second, name: 'Second', rootPaths: [cwd] } } : {}),
      },
      'app-server-project-id-by-legacy-project-id-by-host': {
        [`local:${codexHome}`]: issue === 'unsynchronized' ? {} : { [first]: native, [second]: native },
      },
    };
    const statePath = path.join(codexHome, '.codex-global-state.json');
    if (issue === 'symlink') {
      const target = path.join(env.root, 'state.json');
      await writeFile(target, JSON.stringify(state));
      await import('node:fs/promises').then(({ symlink }) => symlink(target, statePath));
    } else {
      await writeFile(statePath, JSON.stringify(state));
    }
    await assert.rejects(inspectCodexDesktopProject(codexHome, cwd));
  }
});
