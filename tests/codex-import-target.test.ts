import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireImportTarget, assertImportTarget, assertTargetFile, IMPORT_TARGET_LOCK, inspectImportTarget } from '../src/providers/codex/import-target.js';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';
import { codexAdapter } from '../src/providers/codex/index.js';

test('official target binding detects replaced directories even when the path is unchanged', async (t) => {
  const scope = await createIsolatedEnvironment('watch-target-binding-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.home, '.codex');
  await mkdir(root, { mode: 0o700 });
  const target = await inspectImportTarget(root);
  await rename(root, `${root}-old`);
  await mkdir(root, { mode: 0o700 });
  await assert.rejects(assertImportTarget(root, target), /changed since preview/);
});

test('official target lock serializes aliases to the same canonical directory', { skip: process.platform === 'win32' }, async (t) => {
  const scope = await createIsolatedEnvironment('watch-target-alias-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.home, '.codex');
  const alias = path.join(scope.root, 'alias');
  await mkdir(root, { mode: 0o700 });
  await symlink(root, alias);
  const a = await inspectImportTarget(root);
  const b = await inspectImportTarget(alias);
  assert.deepEqual(a, b);
  const lock = await acquireImportTarget(a, 'first');
  await assert.rejects(acquireImportTarget(b, 'second'), /active or uncertain/);
  await lock.release();
  const next = await acquireImportTarget(b, 'second');
  await next.release();
});

test('official target rejects config symlinks and native file path escapes', { skip: process.platform === 'win32' }, async (t) => {
  const scope = await createIsolatedEnvironment('watch-target-paths-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.home, '.codex');
  await mkdir(root, { mode: 0o700 });
  const outside = path.join(scope.root, 'outside');
  await writeFile(outside, 'synthetic');
  const target = await inspectImportTarget(root);
  await symlink(outside, path.join(root, 'session-link'));
  await assert.rejects(assertTargetFile(target, path.join(root, 'session-link')), /outside/);
  await symlink(outside, path.join(root, 'config.toml'));
  await assert.rejects(inspectImportTarget(root), /regular file/);
});

test('lock release never removes a replacement owned by another operation', async (t) => {
  const scope = await createIsolatedEnvironment('watch-target-lock-');
  t.after(() => scope.cleanup());
  const root = path.join(scope.home, '.codex');
  await mkdir(root, { mode: 0o700 });
  const target = await inspectImportTarget(root);
  const lock = await acquireImportTarget(target, 'first');
  const lockPath = path.join(root, IMPORT_TARGET_LOCK);
  await rename(lockPath, `${lockPath}-old`);
  await writeFile(lockPath, 'replacement');
  await assert.rejects(lock.release(), /lock changed/);
  assert.equal(await readFile(lockPath, 'utf8'), 'replacement');
});

test('legacy direct-file Codex preflight still blocks a detected desktop process', { skip: process.platform !== 'darwin' }, async (t) => {
  const scope = await createIsolatedEnvironment('watch-legacy-preflight-');
  t.after(() => scope.cleanup());
  await writeFile(path.join(scope.root, 'pgrep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = scope.root;
    await assert.rejects(codexAdapter.preflight!(), /Desktop 正在运行/);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
