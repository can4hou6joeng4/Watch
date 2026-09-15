import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const usage = 'Usage: npm run validate:opencode-client -- /absolute/native-report.json <local-tui|web|attached-tui> --confirm-client-start';
const commandKeys = {
  'local-tui': 'localTui',
  web: 'web',
  'attached-tui': 'attachedTui',
};
const allowedEnvironment = new Set([
  'PATH', 'TERM', 'COLORTERM', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TEMP', 'TMP', 'WATCH_DB', 'WATCH_OPENCODE_DB',
  'npm_config_cache', 'npm_config_offline', 'LANG', 'NO_COLOR', 'FORCE_COLOR',
  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH',
]);
const isolatedPaths = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TEMP', 'TMP', 'WATCH_DB', 'WATCH_OPENCODE_DB', 'npm_config_cache',
];

function record(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function inside(root, value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value === root || value.startsWith(root + path.sep), `${label} must stay inside the retained root`);
}

export async function loadOpenCodeValidationClient(reportFile, mode) {
  assert.ok(path.isAbsolute(reportFile), 'The OpenCode native report path must be absolute');
  assert.ok(Object.hasOwn(commandKeys, mode), 'Unknown OpenCode validation client mode');
  const reportPath = await realpath(reportFile);
  assert.equal((await lstat(reportPath)).isFile(), true, 'The OpenCode native report must be a regular file');
  const report = record(JSON.parse(await readFile(reportPath, 'utf8')), 'native report');
  assert.equal(report.route, 'watch-opencode-official-native-probe', 'Unexpected native report route');
  assert.equal(report.acceptance, 'passed', 'The native import must pass before starting validation clients');
  assert.equal(report.isolatedRootRetained, true, 'The native report must retain its isolated root');
  const root = await realpath(report.isolatedRoot);
  assert.equal((await lstat(root)).isDirectory(), true, 'The isolated root is unavailable');
  inside(root, report.cwd, 'Native report cwd');
  assert.equal(await realpath(report.cwd), report.cwd, 'Native report cwd must be canonical and available');

  const executable = await realpath(report.executable);
  assert.equal(executable, report.executable, 'OpenCode executable path changed since native validation');
  assert.equal((await lstat(executable)).isFile(), true, 'OpenCode executable is unavailable');
  assert.equal(await sha256File(executable), report.executableSha256, 'OpenCode executable changed since native validation');

  const environment = record(report.manualEnvironment, 'manual environment');
  for (const [key, value] of Object.entries(environment)) {
    assert.ok(allowedEnvironment.has(key), `Manual environment contains unsupported key ${key}`);
    assert.equal(typeof value, 'string', `Manual environment ${key} must be a string`);
  }
  for (const key of isolatedPaths) inside(root, environment[key], `Manual environment ${key}`);
  assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(environment.OPENCODE_DISABLE_MODELS_FETCH, '1');
  assert.equal(environment.npm_config_offline, 'true');

  const origin = new URL(record(report.manualServer, 'manual server').origin);
  assert.equal(origin.protocol, 'http:', 'Manual server must use HTTP');
  assert.equal(origin.hostname, '127.0.0.1', 'Manual server must use exact IPv4 loopback');
  assert.equal(origin.pathname, '/');
  assert.equal(origin.search, '');
  assert.equal(origin.hash, '');
  const port = Number(origin.port);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65_535, 'Manual server must use an explicit valid port');
  const expected = {
    localTui: ['--pure', '--session', report.targetSessionId],
    web: ['--pure', 'web', '--hostname', '127.0.0.1', '--port', String(port)],
    attachedTui: [
      '--pure', 'attach', origin.origin, '--dir', report.cwd, '--session', report.targetSessionId,
    ],
  };
  const commands = record(report.manualCommands, 'manual commands');
  const command = record(commands[commandKeys[mode]], `manual command ${mode}`);
  assert.equal(command.executable, executable, 'Manual command executable differs from the validated binary');
  assert.equal(command.cwd, report.cwd, 'Manual command cwd differs from the validated cwd');
  assert.deepEqual(command.args, expected[commandKeys[mode]], 'Manual command arguments differ from the allowed validation route');
  return { executable, args: command.args, cwd: command.cwd, env: environment };
}

export async function runOpenCodeValidationClient(reportFile, mode) {
  const command = await loadOpenCodeValidationClient(reportFile, mode);
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: 'inherit',
  });
  const forward = (signal) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      'confirm-client-start': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  assert.equal(positionals.length, 2, usage);
  assert.equal(values['confirm-client-start'], true, `Starting a validation client requires explicit confirmation. ${usage}`);
  assert.ok(path.isAbsolute(positionals[0]), 'The OpenCode native report path must be absolute');
  process.exitCode = await runOpenCodeValidationClient(positionals[0], positionals[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
