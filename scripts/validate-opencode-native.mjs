import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { digestFile } from '../src/core/atomic.ts';
import { ImportJobs } from '../src/core/import-jobs.ts';
import {
  OfficialOpenCodeImport,
  createOpenCodeNative,
  opencodeNativeConfigDigest,
} from '../src/providers/opencode/official-import.ts';
import { inspectOfficialOpenCodeExport } from '../src/providers/opencode/official-export.ts';
import { OPENCODE_IMPORT_TARGET_LOCK } from '../src/providers/opencode/import-target.ts';
import { createIsolatedEnvironment } from './lib/isolated-environment.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: npm run validate:opencode-native -- /absolute/path/to/opencode --confirm-native-import --target-provider <id> --target-model <id> [--target-variant <id>] [--server-port <port>] [--keep] [--report docs/evidence/<file>.json]';

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeReport(reportPath, report) {
  if (!reportPath) return;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      'confirm-native-import': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      keep: { type: 'boolean' },
      report: { type: 'string' },
      'server-port': { type: 'string' },
      'target-model': { type: 'string' },
      'target-provider': { type: 'string' },
      'target-variant': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  assert.equal(positionals.length, 1, usage);
  assert.equal(values['confirm-native-import'], true, `Native import requires explicit confirmation. ${usage}`);
  assert.ok(path.isAbsolute(positionals[0]), 'The OpenCode executable path must be absolute');
  assert.ok(values['target-provider'] && values['target-model'], `Native validation requires an explicit target model. ${usage}`);
  const targetModel = {
    providerID: values['target-provider'],
    modelID: values['target-model'],
    ...(values['target-variant'] ? { variant: values['target-variant'] } : {}),
  };
  const serverPort = values['server-port'] === undefined ? 4096 : Number(values['server-port']);
  assert.ok(Number.isInteger(serverPort) && serverPort >= 1 && serverPort <= 65_535, 'The validation server port is invalid');
  const manualServerOrigin = `http://127.0.0.1:${serverPort}`;

  const executable = await realpath(positionals[0]);
  const executableInfo = await lstat(executable);
  assert.ok(executableInfo.isFile(), 'The OpenCode executable must resolve to a regular file');
  if (process.platform !== 'win32') assert.ok((executableInfo.mode & 0o111) !== 0, 'The OpenCode file is not executable');
  const executableSha256 = await sha256File(executable);

  const reportPath = values.report ? path.resolve(repo, values.report) : null;
  assert.ok(
    !reportPath || (reportPath.startsWith(path.join(repo, 'docs', 'evidence') + path.sep) && reportPath.endsWith('.json')),
    'Reports must be new JSON files under docs/evidence/',
  );

  const isolated = await createIsolatedEnvironment('watch-opencode-native-');
  const keepRequested = values.keep ?? false;
  const manualEnvironment = {
    ...isolated.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  let retain = keepRequested;
  let report;
  try {
    const cwd = path.join(isolated.root, 'project with spaces');
    const targetRoot = path.join(isolated.env.XDG_DATA_HOME, 'opencode');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });

    const source = {
      provider: 'claude',
      sessionId: randomUUID(),
      filePath: path.join(isolated.root, 'synthetic-source.jsonl'),
      cwd,
    };
    await writeFile(source.filePath, JSON.stringify({
      sessionId: source.sessionId,
      cwd,
      marker: 'WATCH_OPENCODE_NATIVE_SYNTHETIC_20260909',
    }) + '\n', { mode: 0o600, flag: 'wx' });
    const sourceDigest = await digestFile(source.filePath);
    assert.ok(sourceDigest, 'Cannot fingerprint the synthetic source');

    const longResult = `WATCH_OPENCODE_TOOL_RESULT_${'x'.repeat(768)}`;
    const turns = [
      {
        role: 'user',
        text: 'Inspect the isolated OpenCode acceptance fixture.',
        timestamp: '2026-09-09T01:00:00.000Z',
        provider: 'claude',
      },
      {
        role: 'assistant',
        text: 'The isolated fixture is readable.',
        timestamp: '2026-09-09T01:00:01.000Z',
        provider: 'claude',
        usage: { inputTokens: 32, outputTokens: 12 },
        events: [
          {
            kind: 'thinking',
            summary: 'Inspect fixture',
            detail: 'Use only the synthetic source.',
            timestamp: '2026-09-09T01:00:01.100Z',
            provider: 'claude',
          },
          {
            kind: 'tool_call',
            summary: 'Read',
            name: 'Read',
            callId: 'watch-read-1',
            input: { file_path: source.filePath },
            timestamp: '2026-09-09T01:00:01.200Z',
            provider: 'claude',
          },
          {
            kind: 'tool_result',
            summary: 'Synthetic result',
            detail: longResult,
            callId: 'watch-read-1',
            timestamp: '2026-09-09T01:00:01.300Z',
            provider: 'claude',
          },
        ],
      },
      {
        role: 'user',
        text: 'Record an interrupted tool without running it.',
        timestamp: '2026-09-09T01:00:02.000Z',
        provider: 'claude',
      },
      {
        role: 'assistant',
        text: 'The interrupted tool is retained as an error.',
        timestamp: '2026-09-09T01:00:03.000Z',
        provider: 'claude',
        events: [
          {
            kind: 'tool_call',
            summary: 'Bash',
            name: 'Bash',
            callId: 'watch-interrupted-1',
            input: { command: 'printf synthetic' },
            timestamp: '2026-09-09T01:00:03.100Z',
            provider: 'claude',
          },
        ],
      },
    ];

    const counts = { versions: 0, modelCatalogs: 0, reads: 0, imports: 0 };
    const baseNative = createOpenCodeNative(executable, isolated.env);
    const native = {
      version: async () => { counts.versions += 1; return baseNative.version(); },
      listModels: async (providerID) => { counts.modelCatalogs += 1; return baseNative.listModels(providerID); },
      readSession: async (id, directory) => { counts.reads += 1; return baseNative.readSession(id, directory); },
      importSession: async (file, directory) => { counts.imports += 1; return baseNative.importSession(file, directory); },
    };
    const dependencies = (jobsRoot) => ({
      jobs: new ImportJobs(jobsRoot),
      home: isolated.home,
      targetRoot,
      nativeConfigDigest: opencodeNativeConfigDigest(isolated.env),
      native,
      findSource: async (id, requestedCwd) => id === source.sessionId && requestedCwd === cwd ? source : null,
      parseSource: async () => structuredClone(turns),
    });

    const service = new OfficialOpenCodeImport(dependencies(path.join(isolated.root, 'imports')));
    const prepared = await service.prepare(source.sessionId, cwd, targetModel);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.canConfirm, true);
    assert.equal(prepared.clientVisibility, 'not-run');
    assert.equal(JSON.stringify(prepared.plan).includes(longResult), false, 'The import plan must not persist session content');

    retain = true;
    const confirmed = await service.confirm(prepared.planId);
    if (confirmed.status === 'uncertain') {
      retain = true;
      report = {
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        route: 'watch-opencode-official-native-probe',
        acceptance: 'uncertain',
        executable,
        executableSha256,
        isolatedRoot: isolated.root,
        targetSessionId: confirmed.plan.exportSummary.sessionId,
        targetModel: confirmed.plan.targetModel,
        targetLock: confirmed.outcome?.targetLock ?? 'held-or-unknown',
        modelCalled: false,
      };
      await writeReport(reportPath, report);
      console.log(JSON.stringify(report));
      process.exitCode = 2;
      return;
    }

    assert.equal(confirmed.status, 'imported');
    assert.equal(confirmed.outcome?.nativeRead, 'official-export-exact-messages');
    assert.equal(confirmed.outcome?.targetLock, 'released');
    assert.equal(confirmed.outcome?.sourceUnchanged, true);
    assert.equal(counts.imports, 1);
    const repeated = await service.confirm(prepared.planId);
    assert.deepEqual(repeated, confirmed);
    assert.equal(counts.imports, 1, 'Repeated confirmation submitted another import');

    const targetSessionId = confirmed.outcome.target.sessionId;
    const nativeExport = await native.readSession(targetSessionId, cwd);
    assert.ok(nativeExport, 'Official export cannot read the imported session');
    const summary = inspectOfficialOpenCodeExport(nativeExport);
    assert.equal(summary.sessionId, targetSessionId);
    assert.equal(summary.directory, cwd);
    assert.equal(summary.partTypes.tool, 2);
    assert.equal(JSON.stringify(nativeExport).includes(longResult), true);
    assert.equal((await stat(path.join(targetRoot, 'opencode.db'))).isFile(), true);
    await assert.rejects(stat(path.join(targetRoot, OPENCODE_IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
    assert.deepEqual(await digestFile(source.filePath), sourceDigest);

    const collisionService = new OfficialOpenCodeImport(dependencies(path.join(isolated.root, 'collision-imports')));
    const collision = await collisionService.prepare(source.sessionId, cwd, targetModel);
    assert.equal(collision.plan.exportSummary.sessionId, targetSessionId);
    await assert.rejects(collisionService.confirm(collision.planId), /already exists/);
    assert.equal(await collisionService.status(collision.planId).then((value) => value.status), 'prepared');
    assert.equal(counts.imports, 1, 'Collision preflight submitted another import');
    await assert.rejects(stat(path.join(targetRoot, OPENCODE_IMPORT_TARGET_LOCK)), { code: 'ENOENT' });

    report = {
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      route: 'watch-opencode-official-native-probe',
      acceptance: 'passed',
      cliVersion: confirmed.plan.cliVersion,
      executable,
      executableSha256,
      sourceSessionId: source.sessionId,
      sourceSha256: sourceDigest.sha256,
      sourceUnchanged: true,
      cwd,
      targetSessionId,
      targetModel: confirmed.plan.targetModel,
      modelMetadata: 'provider-catalog-validated',
      exportSummary: summary,
      calls: counts,
      repeatConfirmation: 'no-second-import',
      targetCollision: 'blocked-before-claim',
      targetLock: 'released',
      nativeRead: 'official-export-exact-messages',
      clientVisibility: 'not-run',
      modelContinuation: 'not-run',
      modelCalled: false,
      isolatedRootRetained: keepRequested,
      ...(keepRequested ? {
        isolatedRoot: isolated.root,
        manualEnvironment,
        manualCommands: {
          officialExport: { cwd, executable, args: ['--pure', 'export', targetSessionId] },
          localTui: { cwd, executable, args: ['--pure', '--session', targetSessionId] },
          web: {
            cwd,
            executable,
            args: ['--pure', 'web', '--hostname', '127.0.0.1', '--port', String(serverPort)],
          },
          attachedTui: {
            cwd,
            executable,
            args: ['--pure', 'attach', manualServerOrigin, '--dir', cwd, '--session', targetSessionId],
          },
        },
        manualServer: {
          origin: manualServerOrigin,
          healthUrl: `${manualServerOrigin}/global/health`,
          sessionsUrl: `${manualServerOrigin}/session`,
          sessionUrl: `${manualServerOrigin}/session/${targetSessionId}`,
          messagesUrl: `${manualServerOrigin}/session/${targetSessionId}/message`,
          providerUrl: `${manualServerOrigin}/provider`,
        },
      } : {}),
    };
    if (!keepRequested) {
      await isolated.cleanup();
      retain = false;
    }
    await writeReport(reportPath, report);
    console.log(JSON.stringify(report));
  } catch (error) {
    if (retain) console.error(`The isolated OpenCode target was retained for review: ${isolated.root}`);
    throw error;
  } finally {
    if (!retain && !report) await isolated.cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
