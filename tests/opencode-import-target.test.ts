import assert from 'node:assert/strict';
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  acquireOpenCodeImportTarget,
  assertOpenCodeImportTarget,
  inspectOpenCodeImportTarget,
  OPENCODE_IMPORT_TARGET_LOCK,
} from '../src/providers/opencode/import-target.js';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

async function targetFixture(t: TestContext) {
  const env = await createIsolatedEnvironment('watch-opencode-target-');
  t.after(() => env.cleanup());
  const root = path.join(env.root, 'opencode-data');
  await mkdir(root, { mode: 0o700 });
  return { env, root, target: await inspectOpenCodeImportTarget(root) };
}

test('OpenCode target identity detects a directory replacement at the same path', async (t) => {
  const f = await targetFixture(t);
  await rename(f.root, `${f.root}-old`);
  await mkdir(f.root, { mode: 0o700 });
  await assert.rejects(assertOpenCodeImportTarget(f.target), /changed since preview/);
});

test('OpenCode target rejects directories writable by other users', { skip: process.platform === 'win32' }, async (t) => {
  const f = await targetFixture(t);
  await chmod(f.root, 0o777);
  await assert.rejects(inspectOpenCodeImportTarget(f.root), /not writable by others/);
});

test('OpenCode target lock serializes Watch plans and never removes a replacement lock', async (t) => {
  const f = await targetFixture(t);
  const first = await acquireOpenCodeImportTarget(f.target, 'a'.repeat(64));
  await assert.rejects(
    acquireOpenCodeImportTarget(f.target, 'b'.repeat(64)),
    /active or uncertain Watch import/,
  );
  const lockPath = path.join(f.root, OPENCODE_IMPORT_TARGET_LOCK);
  await unlink(lockPath);
  await writeFile(lockPath, 'replacement\n', { mode: 0o600, flag: 'wx' });
  await assert.rejects(first.release(), /lock changed/);
  assert.equal(await stat(lockPath).then(() => true), true);
});
