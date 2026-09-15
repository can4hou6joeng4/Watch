import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { directoryDigest } from '../scripts/lib/directory-digest.mjs';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

test('native probe snapshot excludes only root runtime temp and detects persistent changes', async (t) => {
  const scope = await createIsolatedEnvironment('watch-probe-snapshot-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.home, '.codex');
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  await mkdir(path.join(root, 'sessions', 'tmp'), { recursive: true });
  await writeFile(path.join(root, 'config.toml'), 'synthetic=true');
  const baseline = await directoryDigest(root, ['tmp']);
  await writeFile(path.join(root, 'tmp', 'runtime-data'), 'temporary');
  assert.equal(await directoryDigest(root, ['tmp']), baseline);
  await writeFile(path.join(root, 'sessions', 'tmp', 'transcript'), 'persisted');
  assert.notEqual(await directoryDigest(root, ['tmp']), baseline);
});

test('native probe snapshot hashes symlink targets without following them', { skip: process.platform === 'win32' }, async (t) => {
  const scope = await createIsolatedEnvironment('watch-probe-symlinks-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.root, 'data');
  await mkdir(root);
  const external = path.join(scope.root, 'external');
  await writeFile(external, 'original');
  await symlink(external, path.join(root, 'link'));
  await symlink(root, path.join(root, 'loop'));
  const baseline = await directoryDigest(root);
  await writeFile(external, 'changed but not part of the snapshot');
  assert.equal(await directoryDigest(root), baseline);
});

test('source-only native fixture never creates a private Codex rollout', async (t) => {
  const scope = await createIsolatedEnvironment('watch-probe-source-');
  t.after(() => scope.cleanup());
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/fixtures/codex-native.ts'], {
    cwd: process.cwd(), env: { ...scope.env, WATCH_VALIDATION_ROOT: scope.root, WATCH_VALIDATION_SOURCE_ONLY: '1' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const fixture = JSON.parse(result.stdout);
  assert.equal(fixture.sourceOnly, true);
  assert.equal(fixture.target.filePath, '');
  assert.ok(fixture.sourcePath.startsWith(scope.home + path.sep));
  assert.ok((await readFile(fixture.sourcePath, 'utf8')).includes(fixture.resultMarker));
  await assert.rejects(readdir(path.join(scope.home, '.codex')), { code: 'ENOENT' });
});
