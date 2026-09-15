import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

test('test environment excludes agent secrets and redirects local data roots', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'watch-test-not-a-real-secret';
  let scope;
  try {
    scope = await createIsolatedEnvironment();
    assert.equal(scope.root, await realpath(scope.root));
    assert.equal(scope.env.HOME, path.join(scope.root, 'home'));
    assert.equal(scope.env.USERPROFILE, scope.env.HOME);
    assert.equal(scope.env.TERM, process.env.TERM);
    assert.equal(scope.env.COLORTERM, process.env.COLORTERM);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY']) {
      assert.equal(scope.env[key], undefined);
    }
    for (const key of [
      'WATCH_DB',
      'WATCH_OPENCODE_DB',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
    ]) {
      assert.ok(scope.env[key]?.startsWith(scope.root + path.sep));
    }
    assert.equal(scope.env.npm_config_offline, 'true');
  } finally {
    await scope?.cleanup();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.ok(scope);
  await assert.rejects(access(scope.root), { code: 'ENOENT' });
});
