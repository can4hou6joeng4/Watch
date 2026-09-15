import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';

async function fakeOpenCode(
  t: TestContext,
  options: { writeDatabase?: boolean; returnDifferentId?: boolean } = {},
): Promise<string> {
  const { writeDatabase = true, returnDifferentId = false } = options;
  const root = await mkdtemp(path.join(tmpdir(), 'watch-fake-opencode-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, 'opencode');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.WATCH_TEST_PARENT_SECRET) {
  process.stderr.write('parent environment leaked into fake OpenCode\\n');
  process.exit(3);
}
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('opencode v1.18.29\\n');
  process.exit(0);
}
if (args[0] === '--pure' && args[1] === 'models' && args[2] === 'opencode') {
  process.stdout.write('opencode/big-pickle\\nopencode/muse-spark-1.3-contributor-free\\n');
  process.exit(0);
}
const root = path.join(process.env.XDG_DATA_HOME, 'opencode');
const sessions = path.join(root, 'fake-sessions');
if (args[0] === '--pure' && args[1] === 'export') {
  const id = args[2];
  const file = path.join(sessions, id + '.json');
  if (!fs.existsSync(file)) {
    process.stderr.write('Exporting session: ' + id + '\\nError: Session not found: ' + id + '\\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}
if (args[0] === '--pure' && args[1] === 'import') {
  const value = JSON.parse(fs.readFileSync(args[2], 'utf8'));
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessions, value.info.id + '.json'), JSON.stringify(value) + '\\n', { mode: 0o600 });
  if (${writeDatabase}) fs.writeFileSync(path.join(root, 'opencode.db'), 'fake sqlite fixture\\n', { mode: 0o600 });
  const importedId = ${returnDifferentId} ? 'ses_000000000000AAAAAAAAAAAAAA' : value.info.id;
  process.stdout.write('Imported session: ' + importedId + '\\n');
  process.exit(0);
}
process.stderr.write('unsupported fake OpenCode invocation\\n');
process.exit(2);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return realpath(executable);
}

function runValidator(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/validate-opencode-native.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function nativeArgs(executable: string, ...extra: string[]): string[] {
  return [
    executable,
    '--target-provider', 'opencode',
    '--target-model', 'big-pickle',
    ...extra,
  ];
}

test('OpenCode native validator requires explicit confirmation before executing a binary', async (t) => {
  const executable = await fakeOpenCode(t);
  const result = runValidator(nativeArgs(executable));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires explicit confirmation/);
  assert.equal(result.stdout, '');
});

test('OpenCode native validator exercises import, exact export, retry and collision in isolation', async (t) => {
  const executable = await fakeOpenCode(t);
  const result = runValidator(nativeArgs(executable, '--confirm-native-import'));
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.acceptance, 'passed');
  assert.equal(report.cliVersion, '1.18.29');
  assert.equal(report.nativeRead, 'official-export-exact-messages');
  assert.equal(report.repeatConfirmation, 'no-second-import');
  assert.equal(report.targetCollision, 'blocked-before-claim');
  assert.equal(report.calls.imports, 1);
  assert.equal(report.calls.modelCatalogs, 5);
  assert.deepEqual(report.targetModel, { providerID: 'opencode', modelID: 'big-pickle' });
  assert.equal(report.isolatedRootRetained, false);
  assert.equal(report.clientVisibility, 'not-run');
  assert.equal(report.modelCalled, false);
});

test('OpenCode native validator retains the isolated target after a post-submit assertion failure', async (t) => {
  const executable = await fakeOpenCode(t, { writeDatabase: false });
  const result = runValidator(nativeArgs(executable, '--confirm-native-import'));
  assert.notEqual(result.status, 0);
  const match = result.stderr.match(/retained for review: (.+)\n/);
  assert.ok(match, result.stderr);
  const retainedRoot = match[1]!;
  assert.equal((await stat(retainedRoot)).isDirectory(), true);
  await rm(retainedRoot, { recursive: true, force: true });
});

test('OpenCode native validator reports uncertain and retains state for an unexpected imported ID', async (t) => {
  const executable = await fakeOpenCode(t, { returnDifferentId: true });
  const result = runValidator(nativeArgs(executable, '--confirm-native-import'));
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.acceptance, 'uncertain');
  assert.equal(report.targetLock, 'held-or-unknown');
  assert.equal((await stat(report.isolatedRoot)).isDirectory(), true);
  await rm(report.isolatedRoot, { recursive: true, force: true });
});

test('OpenCode native validator keep report can read the target without another import', async (t) => {
  const executable = await fakeOpenCode(t);
  const result = runValidator(
    nativeArgs(executable, '--confirm-native-import', '--keep'),
    { WATCH_TEST_PARENT_SECRET: 'must-not-reach-native-client' },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.isolatedRootRetained, true);
  assert.equal((await stat(report.isolatedRoot)).isDirectory(), true);
  assert.equal(report.manualCommands.officialExport.executable, executable);
  assert.deepEqual(report.manualCommands.officialExport.args, ['--pure', 'export', report.targetSessionId]);
  assert.deepEqual(report.manualCommands.localTui.args, ['--pure', '--session', report.targetSessionId]);
  assert.deepEqual(report.manualCommands.web.args, [
    '--pure', 'web', '--hostname', '127.0.0.1', '--port', '4096',
  ]);
  assert.deepEqual(report.manualCommands.attachedTui.args, [
    '--pure', 'attach', report.manualServer.origin,
    '--dir', report.manualCommands.attachedTui.cwd,
    '--session', report.targetSessionId,
  ]);
  assert.equal(report.manualServer.healthUrl, `${report.manualServer.origin}/global/health`);
  assert.equal(report.manualServer.sessionUrl, `${report.manualServer.origin}/session/${report.targetSessionId}`);
  assert.equal(report.manualServer.messagesUrl, `${report.manualServer.sessionUrl}/message`);
  assert.equal(report.manualServer.providerUrl, `${report.manualServer.origin}/provider`);
  assert.equal(report.manualEnvironment.WATCH_TEST_PARENT_SECRET, undefined);
  assert.ok(report.manualEnvironment.XDG_STATE_HOME.startsWith(report.isolatedRoot + path.sep));
  assert.equal(report.manualEnvironment.FORCE_COLOR, '0');

  const exported = spawnSync(
    report.manualCommands.officialExport.executable,
    report.manualCommands.officialExport.args,
    {
      cwd: report.manualCommands.officialExport.cwd,
      env: report.manualEnvironment,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).info.id, report.targetSessionId);
  await rm(report.isolatedRoot, { recursive: true, force: true });
});
