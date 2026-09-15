import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createIsolatedEnvironment } from './lib/isolated-environment.mjs';
import { directoryDigest } from './lib/directory-digest.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'official-import': { type: 'boolean' }, 'watch-importer': { type: 'boolean' }, 'shared-reader': { type: 'boolean' }, 'desktop-project': { type: 'boolean' }, 'project-binding': { type: 'boolean' }, 'recreate-project': { type: 'boolean' }, 'expect-text-tools': { type: 'boolean' }, report: { type: 'string' } },
});
assert.ok(positionals.length <= 1, 'At most one Codex executable path is accepted');
const watchImporter = values['watch-importer'] ?? false;
const sharedReader = values['shared-reader'] ?? false;
const desktopProject = values['desktop-project'] ?? false;
const projectBinding = values['project-binding'] ?? false;
const recreateProject = values['recreate-project'] ?? false;
assert.ok(!recreateProject || projectBinding, 'Project recreation requires the isolated project-binding probe');
assert.ok(!projectBinding || watchImporter, 'Project binding requires the Watch importer probe');
assert.ok(!desktopProject || watchImporter, 'Desktop project mode requires the Watch importer probe');
assert.ok(!(desktopProject && projectBinding), 'Choose project-first import or legacy post-import project binding');
assert.ok(!sharedReader || watchImporter, 'The concurrent native reader is only supported with the Watch importer');
assert.ok(!(watchImporter && values['official-import']), 'Choose the Watch wrapper or the direct official API probe');
assert.ok(!watchImporter || positionals.length === 0, 'The Watch wrapper uses the codex executable resolved from PATH');
const officialImport = watchImporter || (values['official-import'] ?? false);
const expectTextTools = values['expect-text-tools'] ?? false;
assert.ok(!expectTextTools || officialImport, 'Text-tool expectations are only valid for the official import probe');
const executable = positionals[0] ?? 'codex';
const reportPath = values.report ? path.resolve(repo, values.report) : null;
assert.ok(!reportPath || reportPath.startsWith(path.join(repo, 'docs', 'evidence') + path.sep), 'Reports must be generated under docs/evidence/');
const isolated = await createIsolatedEnvironment('watch-native-probe-');
let child;
let closed;
let lines;
const pending = new Map();
const importCompletions = new Map();
let importWaiter;
let requestId = 0;
let diagnostics = '';
let fixtureData;
let blockedByGuard = false;
let desktopProjectFixture;
const report = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: release(), route: watchImporter ? 'watch-official-import-wrapper' : officialImport ? 'official-session-import' : 'watch-converter', acceptance: 'not-run', nativeRead: 'not-run', nativeResume: 'not-run', nativeTools: 'not-run', desktopUI: 'not-run', modelContinuation: 'not-run', sourceUnchanged: false };

function desktopProcessRunning() {
  if (process.platform !== 'darwin') return null;
  const processes = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 5_000 });
  if (processes.status !== 0) return null;
  return processes.stdout.split('\n').some((line) => /\/(Codex|ChatGPT)\.app\/Contents\/MacOS\/(Codex|ChatGPT)$/.test(line.trim()));
}
report.desktopProcessRunningAtStart = desktopProcessRunning();

async function runWatch(args, env) {
  const processGroup = process.platform !== 'win32';
  const cli = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'import-codex', ...args, '--json'], {
    cwd: repo, env, detached: processGroup, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let timedOut = false;
  const stop = (signal) => {
    try {
      if (processGroup && cli.pid) process.kill(-cli.pid, signal);
      else cli.kill(signal);
    } catch { /* the owned child may already have closed */ }
  };
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, 180_000);
  const forceKill = setTimeout(() => stop('SIGKILL'), 182_000);
  cli.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 1024 * 1024) stop('SIGTERM');
  });
  cli.stderr.resume();
  try {
    const code = await new Promise((resolve, reject) => {
      cli.once('error', () => reject(new Error('Cannot start the Watch CLI')));
      cli.once('close', (code) => resolve(code));
    });
    assert.ok(!timedOut, 'Watch CLI timed out; its import outcome is uncertain');
    const output = stdout.trim().split('\n');
    assert.equal(output.length, 1, 'Expected one CLI JSON response');
    return { code, result: JSON.parse(output[0]) };
  } finally {
    clearTimeout(timer);
    clearTimeout(forceKill);
  }
}

function rpc(method, params) {
  // Imports require an explicit invocation flag; prompts and tool approvals are never allowed.
  const methods = ['initialize', 'thread/start', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/resume'];
  if (officialImport && !watchImporter) methods.push('externalAgentConfig/detect', 'externalAgentConfig/import');
  if (projectBinding || desktopProject) methods.push('project/create', 'project/read');
  if (recreateProject) methods.push('project/delete');
  assert.ok(methods.includes(method));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: timed out`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function startNativeReader(env) {
  assert.ok(!child, 'The native reader is already running');
  child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: isolated.root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => child.once('close', resolve));
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  const rejectAll = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once('error', rejectAll);
  child.stdin.on('error', rejectAll);
  child.once('close', () => rejectAll(new Error('Codex app-server closed')));
  lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === 'externalAgentConfig/import/completed') {
        importCompletions.set(message.params.importId, message.params);
        importWaiter?.(message.params);
      }
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Offline probe refuses server requests' } }) + '\n');
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(String(message.error.message).slice(0, 1500)));
      else request.resolve(message.result);
    } catch (error) {
      rejectAll(error);
    }
  });
  await rpc('initialize', { clientInfo: { name: 'watch_native_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
}

try {
  const codexHome = path.join(isolated.home, '.codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(codexHome, 'config.toml'), [
    'model = "watch-validation-model"',
    'model_provider = "watch_validation"',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    '[analytics]',
    'enabled = false',
    '[feedback]',
    'enabled = false',
    '[model_providers.watch_validation]',
    'name = "Watch offline validation"',
    'base_url = "http://127.0.0.1:9"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n'), { mode: 0o600 });
  const env = { ...isolated.env, WATCH_VALIDATION_ROOT: isolated.root,
    ...(watchImporter ? { WATCH_VALIDATION_SOURCE_ONLY: '1' } : {}) };
  const version = spawnSync(executable, ['--version'], { cwd: isolated.root, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.status, 0, version.error?.message ?? 'Cannot read Codex version');
  report.cliVersion = version.stdout.trim();
  const fixture = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/fixtures/codex-native.ts'], {
    cwd: repo, env, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(fixture.status, 0, fixture.error?.message ?? fixture.stderr);
  const data = JSON.parse(fixture.stdout.trim());
  assert.ok(watchImporter ? data.sourceOnly && data.target.filePath === '' : data.target.filePath.startsWith(isolated.home + path.sep));
  assert.ok(data.sourcePath.startsWith(isolated.root + path.sep));
  fixtureData = data;
  report.sourceSessionId = data.sourceId;
  report.sourceSha256 = data.sourceDigest;
  report.sourceUnchanged = data.sourceUnchanged;
  let rollout = watchImporter ? [] : (await readFile(data.target.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  report.lifecycleRecordCount = rollout.filter((row) => ['item_started', 'item_completed'].includes(row.payload.type)).length;

  if (sharedReader || desktopProject) {
    await startNativeReader(env);
    const initial = await rpc('thread/list', { limit: 100 });
    assert.equal(initial.data.length, 0, 'Expected an empty isolated native store');
    if (sharedReader) report.sharedReader = { connectedBeforeImport: true, sameCodexHome: true, targetVisibleAfterImport: false };
  }

  if (desktopProject) {
    const native = (await rpc('project/create', {
      idempotencyKey: randomUUID(), name: 'Watch project-first fixture', roots: [{ path: data.target.cwd }],
    })).project;
    const legacyProjectId = randomUUID();
    await writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'local-projects': {
        [legacyProjectId]: { id: legacyProjectId, name: 'Watch project-first fixture', rootPaths: [data.target.cwd] },
      },
      'app-server-project-id-by-legacy-project-id-by-host': {
        [`local:${codexHome}`]: { [legacyProjectId]: native.id },
      },
      'thread-project-assignments': {},
      'projectless-thread-ids': [],
    }) + '\n', { mode: 0o600 });
    desktopProjectFixture = { legacyProjectId, nativeProjectId: native.id };
    report.desktopProject = { status: 'prepared-before-import', ...desktopProjectFixture };
  }

  if (watchImporter) {
    const implementation = createHash('sha256');
    for (const file of ['src/import-codex.ts', 'src/core/import-jobs.ts', 'src/providers/codex/official-import.ts',
      'src/providers/codex/app-server.ts', 'src/providers/codex/index.ts', 'scripts/validate-codex-native.mjs',
      'src/providers/codex/import-target.ts', 'src/providers/codex/desktop-project.ts', 'src/providers/codex/project-binding.ts',
      'scripts/fixtures/codex-native.ts', 'scripts/lib/isolated-environment.mjs', 'scripts/lib/directory-digest.mjs']) {
      implementation.update(file).update('\0').update(await readFile(path.join(repo, file)));
    }
    report.implementationSha256 = implementation.digest('hex');
    report.watchCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    report.codexDataExclusions = ['tmp'];
    const before = await directoryDigest(codexHome, report.codexDataExclusions);
    const configBefore = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const prepareArgs = ['prepare', data.sourceId, '--cwd', data.target.cwd,
      ...(desktopProject ? ['--desktop-project'] : []), '--experimental'];
    const prepare = await runWatch(prepareArgs, env);
    assert.equal(prepare.code, 0, prepare.result.error);
    assert.equal(prepare.result.status, 'prepared');
    assert.equal(prepare.result.plan.source.filePath, data.sourcePath);
    assert.equal(prepare.result.plan.codexHome, codexHome);
    assert.equal(prepare.result.plan.target?.path, codexHome);
    if (desktopProject) {
      assert.equal(prepare.result.desktop, 'project-first-preflight');
      assert.equal(prepare.result.plan.desktopProject.legacyProjectId, desktopProjectFixture.legacyProjectId);
      assert.equal(prepare.result.plan.desktopProject.nativeProjectId, desktopProjectFixture.nativeProjectId);
    }
    report.wrapper = { prepare: 'passed', confirm: 'not-run', status: 'not-run', retry: 'not-run', planId: prepare.result.planId };
    const confirm = await runWatch(['confirm', prepare.result.planId, '--experimental'], env);
    const status = await runWatch(['status', prepare.result.planId], env);
    assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), configBefore, 'Configuration changed');
    report.configurationUnchanged = true;
    report.wrapper.status = status.result.status;
    report.wrapper.outcomeCode = status.result.outcome?.code;
    if (confirm.code !== 0) {
      report.wrapper.confirm = 'failed';
      if (typeof confirm.result.error === 'string' && confirm.result.error.includes('检测到 Codex/ChatGPT Desktop 正在运行')) {
        assert.equal(status.result.status, 'prepared');
        assert.equal(status.result.canConfirm, true);
        assert.equal(status.result.outcome, null);
        assert.equal(await directoryDigest(codexHome, report.codexDataExclusions), before, 'Guard failed to prevent changes to isolated Codex data');
        report.wrapper.confirm = 'blocked-before-submission';
        report.targetPersistentDataUnchanged = true;
        report.importSubmitted = false;
        blockedByGuard = true;
      }
      throw new Error(confirm.result.error ?? 'Watch importer did not complete; inspect the journal before retrying');
    }
    assert.equal(confirm.result.status, 'imported');
    if (desktopProject) {
      assert.equal(confirm.result.desktop, 'project-membership-and-visibility-preflight-verified');
      assert.equal(confirm.result.guiAcceptance, 'pending-manual-review');
      assert.equal(confirm.result.outcome.desktopProject.nativeProjectId, desktopProjectFixture.nativeProjectId);
      assert.equal(confirm.result.outcome.desktopProject.membershipVerified, true);
      assert.equal(confirm.result.outcome.desktopProject.visibilityPreflightVerified, true);
    }
    assert.deepEqual(status.result, confirm.result, 'CLI status differs from confirmed outcome');
    data.target = confirm.result.outcome.target;
    assert.ok(data.target.filePath.startsWith(codexHome + path.sep));
    if (desktopProject) {
      const thread = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
      const members = await rpc('thread/list', {
        projectId: desktopProjectFixture.nativeProjectId, limit: 100, useStateDbOnly: true,
      });
      const state = JSON.parse(await readFile(path.join(codexHome, '.codex-global-state.json'), 'utf8'));
      assert.equal(thread.thread.projectId, desktopProjectFixture.nativeProjectId);
      assert.ok(members.data.some((entry) => entry.id === data.target.sessionId));
      assert.ok(!(state['projectless-thread-ids'] ?? []).includes(data.target.sessionId));
      const assignment = (state['thread-project-assignments'] ?? {})[data.target.sessionId];
      assert.ok(assignment == null || assignment.projectId === desktopProjectFixture.legacyProjectId);
      report.desktopProject = {
        status: 'passed-project-first-technical-preflight', ...desktopProjectFixture,
        nativeMembership: true, projectlessExcluded: false, conflictingPrivateAssignment: false,
        guiAcceptance: 'pending-manual-review', modelContinuation: 'not-run',
      };
    }
    if (sharedReader) {
      assert.equal(child.exitCode, null, 'Concurrent native reader exited');
      const observed = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
      assert.equal(observed.thread.cwd, data.target.cwd);
      assert.ok(JSON.stringify(observed.thread.turns).includes(data.resultMarker));
      report.sharedReader.targetVisibleAfterImport = true;
    }
    const importedDataDigest = await directoryDigest(codexHome, report.codexDataExclusions);
    const retry = await runWatch(['confirm', prepare.result.planId, '--experimental'], env);
    assert.equal(retry.code, 0);
    assert.deepEqual(retry.result, confirm.result, 'Repeated confirmation did not return the original result');
    assert.equal(await directoryDigest(codexHome, report.codexDataExclusions), importedDataDigest, 'Repeated confirmation changed target data');
    report.wrapper.confirm = 'passed';
    report.wrapper.retry = 'same-result-no-target-write';
    report.importSubmitted = true;
    rollout = (await readFile(data.target.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  }

  if (!child) await startNativeReader(env);
  if (officialImport && !watchImporter) {
    const detected = await rpc('externalAgentConfig/detect', { includeHome: true, cwds: [data.target.cwd], maxSessions: 10, maxSessionAgeDays: 30 });
    const sessions = detected.items.filter((item) => item.itemType === 'SESSIONS');
    const group = sessions.find((item) => item.details?.sessions?.some((session) => session.path === data.sourcePath));
    assert.ok(group, 'Official detection did not find the isolated Claude fixture');
    const session = group.details.sessions.find((entry) => entry.path === data.sourcePath);
    const configBefore = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const imported = await rpc('externalAgentConfig/import', {
      migrationItems: [{ ...group, details: { sessions: [session] } }], source: 'watch-native-probe',
    });
    assert.equal(typeof imported.importId, 'string');
    const complete = importCompletions.get(imported.importId) ?? await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { importWaiter = undefined; reject(new Error('Official import completion timed out')); }, 30_000);
      importWaiter = (result) => {
        if (result.importId !== imported.importId) return;
        clearTimeout(timeout);
        importWaiter = undefined;
        resolve(result);
      };
    });
    const results = complete.itemTypeResults;
    assert.ok(results.every((result) => result.itemType === 'SESSIONS'));
    assert.equal(results.flatMap((result) => result.failures).length, 0, 'Official import reported failures');
    const successes = results.flatMap((result) => result.successes);
    assert.equal(successes.length, 1, 'Official import did not report exactly one session');
    report.officialImport = { completed: true, successCount: successes.length, target: successes[0].target?.replaceAll(isolated.root, '<temporary>') };
    assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), configBefore, 'Session import changed configuration');
    report.configurationUnchanged = true;
    const list = await rpc('thread/list', { limit: 100 });
    const target = list.data.find((thread) => thread.id === successes[0].target || thread.path === successes[0].target);
    assert.ok(target, 'Cannot map official import result to a native thread');
    data.target = { ...data.target, sessionId: target.id, filePath: target.path };
    rollout = (await readFile(data.target.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  }
  report.serializedPayloadTypes = [...new Set(rollout.map((row) => `${row.type}:${row.payload?.type ?? ''}`))];
  report.serializedToolResultPresent = JSON.stringify(rollout).includes(data.resultMarker);
  report.targetSessionId = data.target.sessionId;
  const control = await rpc('thread/start', { cwd: data.target.cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(control.thread.cwd, data.target.cwd);
  report.nativeControl = 'started-without-model-call';
  const read = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
  assert.equal(read.thread.id, data.target.sessionId);
  assert.equal(read.thread.cwd, data.target.cwd);
  assert.ok(JSON.stringify(read.thread.turns).includes(data.marker), 'Native history is missing the fixture marker');
  report.nativeRead = 'passed';
  const resumed = await rpc('thread/resume', { threadId: data.target.sessionId, cwd: data.target.cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(resumed.thread.id, data.target.sessionId);
  assert.equal(resumed.thread.cwd, data.target.cwd);
  assert.ok(JSON.stringify(resumed.thread.turns).includes(data.marker));
  report.nativeResume = 'passed';
  report.nativeResumeItemTypes = [...new Set(resumed.thread.turns.flatMap((turn) => turn.items ?? []).map((item) => item.type))];
  const page = await rpc('thread/turns/list', { threadId: data.target.sessionId, limit: 100, itemsView: 'full' });
  const expectedIds = rollout.filter((row) => row.payload.type === 'task_started').map((row) => row.payload.turn_id);
  report.nativeTurnIdsMatch = (page.data ?? page.turns).every((turn) => expectedIds.includes(turn.id));
  report.nativeTurnCount = (page.data ?? page.turns).length;
  const nativeItems = (page.data ?? page.turns).flatMap((turn) => turn.items ?? []);
  report.nativeItemTypes = [...new Set(nativeItems.map((item) => item.type))];
  report.nativeTools = 'failed';
  const tool = nativeItems.find((item) => item.id === 'watch-probe-read' && ['dynamicToolCall', 'mcpToolCall', 'commandExecution'].includes(item.type));
  const nativeHistory = JSON.stringify(nativeItems);
  report.nativeToolArgumentsPresent = nativeHistory.includes(data.argumentMarker);
  report.nativeToolResultPresent = nativeHistory.includes(data.resultMarker);
  report.nativeToolRepresentation = tool ? 'structured' : report.nativeToolArgumentsPresent && report.nativeToolResultPresent ? 'text' : 'missing';
  if (expectTextTools) {
    assert.equal(report.nativeToolRepresentation, 'text', 'Official importer no longer matches the declared text-tool representation');
    report.nativeTools = 'passed-with-text-degradation';
    report.acceptance = 'passed-native-text-history-only';
  } else {
    assert.ok(tool, 'Native structured tool history is missing; text-only history requires an explicit expectation');
    assert.ok(report.nativeToolArgumentsPresent, 'Native tool arguments are missing');
    assert.ok(report.nativeToolResultPresent, 'Native tool output is missing or truncated');
    report.nativeTools = 'passed';
    report.acceptance = 'passed-native-history-only';
  }
  if (projectBinding) {
    report.projectBinding = { status: 'not-run' };
    const project = (await rpc('project/create', {
      idempotencyKey: randomUUID(), name: 'Watch isolated project binding', roots: [{ path: data.target.cwd }],
    })).project;
    assert.equal(typeof project.id, 'string');
    const before = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
    const beforeHistory = createHash('sha256').update(JSON.stringify(before.thread.turns)).digest('hex');
    const byCwd = await rpc('thread/list', { cwd: data.target.cwd, limit: 100, useStateDbOnly: true });
    const byProjectBefore = await rpc('thread/list', { projectId: project.id, limit: 100, useStateDbOnly: true });
    assert.ok(byCwd.data.some((thread) => thread.id === data.target.sessionId));
    assert.ok(!byProjectBefore.data.some((thread) => thread.id === data.target.sessionId));
    const preview = await runWatch(['project-prepare', report.wrapper.planId, '--project', project.id, '--experimental'], env);
    assert.equal(preview.code, 0, preview.result.error);
    assert.equal(preview.result.status, 'prepared');
    const bound = await runWatch(['project-confirm', preview.result.planId, '--experimental'], env);
    assert.equal(bound.code, 0, bound.result.error);
    assert.equal(bound.result.status, 'associated');
    const boundStatus = await runWatch(['project-status', preview.result.planId], env);
    assert.deepEqual(boundStatus.result, bound.result);
    const beforeRetry = await directoryDigest(codexHome, ['tmp']);
    const repeated = await runWatch(['project-confirm', preview.result.planId, '--experimental'], env);
    assert.deepEqual(repeated.result, bound.result);
    assert.equal(await directoryDigest(codexHome, ['tmp']), beforeRetry);
    const after = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
    const byProjectAfter = await rpc('thread/list', { projectId: project.id, limit: 100, useStateDbOnly: true });
    assert.equal(after.thread.projectId, project.id);
    assert.equal(after.thread.cwd, data.target.cwd);
    assert.ok(byProjectAfter.data.some((thread) => thread.id === data.target.sessionId));
    assert.equal(createHash('sha256').update(JSON.stringify(after.thread.turns)).digest('hex'), beforeHistory);
    report.projectBinding = { status: 'passed-native-project-membership', projectId: project.id,
      foundByCwdBefore: true, foundByProjectBefore: false, foundByProjectAfter: true,
      historyUnchanged: true, cwdUnchanged: true, associationPlanId: preview.result.planId,
      cliPreviewConfirmStatus: 'passed', repeatedConfirmation: 'same-result-no-target-write' };
    if (recreateProject) {
      // Only this project's ID, created above inside the disposable Codex home, may be deleted.
      await rpc('project/delete', { projectId: project.id });
      const unassigned = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
      assert.equal(unassigned.thread.projectId, null);
      assert.equal(createHash('sha256').update(JSON.stringify(unassigned.thread.turns)).digest('hex'), beforeHistory);
      const replacement = (await rpc('project/create', {
        idempotencyKey: randomUUID(), name: 'Watch recreated project', roots: [{ path: data.target.cwd }],
      })).project;
      assert.notEqual(replacement.id, project.id);
      const empty = await rpc('thread/list', { projectId: replacement.id, limit: 100, useStateDbOnly: true });
      assert.ok(!empty.data.some((thread) => thread.id === data.target.sessionId));
      const newPreview = await runWatch(['project-prepare', report.wrapper.planId, '--project', replacement.id, '--experimental'], env);
      assert.equal(newPreview.code, 0, newPreview.result.error);
      const rebound = await runWatch(['project-confirm', newPreview.result.planId, '--experimental'], env);
      assert.equal(rebound.code, 0, rebound.result.error);
      assert.equal(rebound.result.status, 'associated');
      const reloaded = await rpc('thread/read', { threadId: data.target.sessionId, includeTurns: true });
      const visible = await rpc('thread/list', { projectId: replacement.id, limit: 100, useStateDbOnly: true });
      assert.equal(reloaded.thread.projectId, replacement.id);
      assert.ok(visible.data.some((thread) => thread.id === data.target.sessionId));
      assert.equal(createHash('sha256').update(JSON.stringify(reloaded.thread.turns)).digest('hex'), beforeHistory);
      report.projectRecreation = { status: 'passed-native-reassociation', previousProjectId: project.id,
        replacementProjectId: replacement.id, deletionClearedAssociation: true,
        sameFolderNewProjectInitiallyEmpty: true, originalSessionReassociated: true,
        historyUnchanged: true, sessionReimported: false };
    }
  }
} catch (error) {
  report.acceptance = blockedByGuard ? 'blocked-write-guard' : 'failed';
  report.error = (error instanceof Error ? error.message : String(error)).replaceAll(isolated.root, '<temporary>');
  report.nativeDiagnostics = diagnostics.split('\n').filter((line) => /rollout|deserializ|failed/i.test(line))
    .join('\n').replaceAll(isolated.root, '<temporary>').slice(0, 2500);
  process.exitCode = 1;
} finally {
  for (const request of pending.values()) request.reject(new Error('Probe stopped'));
  pending.clear();
  lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await closed;
    clearTimeout(kill);
  }
  if (fixtureData) {
    const after = await readFile(fixtureData.sourcePath, 'utf8').catch(() => '');
    report.sourceUnchanged = createHash('sha256').update(after).digest('hex') === fixtureData.sourceDigest;
    if (!report.sourceUnchanged) {
      report.acceptance = 'failed';
      report.error = 'Source fixture changed during native verification';
      process.exitCode = 1;
    }
  }
  await isolated.cleanup();
  report.temporaryDataRemoved = true;
  report.desktopProcessRunningAtEnd = desktopProcessRunning();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
}
