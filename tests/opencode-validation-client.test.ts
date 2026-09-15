import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-opencode-client-runner-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project with spaces');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const executable = path.join(root, 'opencode');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'client-run.json'), JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.HOME,
  parentSecret: process.env.WATCH_TEST_PARENT_SECRET || null,
}) + '\\n');
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  const executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const targetSessionId = 'ses_000000000000AAAAAAAAAAAAAA';
  const origin = 'http://127.0.0.1:4096';
  const manualEnvironment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: process.env.TERM ?? 'xterm-256color',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    WATCH_DB: path.join(root, 'watch.db'),
    WATCH_OPENCODE_DB: path.join(root, 'opencode.db'),
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_offline: 'true',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  await mkdir(manualEnvironment.TMPDIR, { recursive: true });
  const manualCommands = {
    localTui: { cwd, executable, args: ['--pure', '--session', targetSessionId] },
    web: { cwd, executable, args: ['--pure', 'web', '--hostname', '127.0.0.1', '--port', '4096'] },
    attachedTui: {
      cwd,
      executable,
      args: ['--pure', 'attach', origin, '--dir', cwd, '--session', targetSessionId],
    },
  };
  const reportFile = path.join(root, 'native-report.json');
  const report = {
    route: 'watch-opencode-official-native-probe',
    acceptance: 'passed',
    isolatedRootRetained: true,
    isolatedRoot: root,
    cwd,
    executable,
    executableSha256,
    targetSessionId,
    manualEnvironment,
    manualCommands,
    manualServer: { origin },
  };
  await writeFile(reportFile, JSON.stringify(report));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, reportFile, report, marker: path.join(cwd, 'client-run.json') };
}

function run(args: string[]) {
  return spawnSync(process.execPath, ['scripts/run-opencode-validation-client.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, WATCH_TEST_PARENT_SECRET: 'must-not-reach-client' },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('OpenCode validation client runner requires confirmation before binary execution', async (t) => {
  const f = await fixture(t);
  const result = run([f.reportFile, 'web']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires explicit confirmation/);
  const unknown = run([f.reportFile, 'toString', '--confirm-client-start']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown OpenCode validation client mode/);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('OpenCode validation client runner uses one validated command and replaces the parent environment', async (t) => {
  const f = await fixture(t);
  const result = run([f.reportFile, 'web', '--confirm-client-start']);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(await readFile(f.marker, 'utf8'));
  assert.deepEqual(observed.args, f.report.manualCommands.web.args);
  assert.equal(observed.home, f.report.manualEnvironment.HOME);
  assert.equal(observed.parentSecret, null);
});

test('OpenCode validation client runner rejects a tampered command before binary execution', async (t) => {
  const f = await fixture(t);
  f.report.manualCommands.web.args.push('--unexpected');
  await writeFile(f.reportFile, JSON.stringify(f.report));
  const result = run([f.reportFile, 'web', '--confirm-client-start']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /arguments differ/);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });

  f.report.manualCommands.web.args.pop();
  f.report.manualServer.origin = 'http://0.0.0.0:4097';
  await writeFile(f.reportFile, JSON.stringify(f.report));
  const changedOrigin = run([f.reportFile, 'web', '--confirm-client-start']);
  assert.notEqual(changedOrigin.status, 0);
  assert.match(changedOrigin.stderr, /exact IPv4 loopback/);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
