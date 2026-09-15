import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ImportJobs } from '../src/core/import-jobs.js';
import type { SessionRef, UnifiedTurn } from '../src/core/types.js';
import {
  OfficialOpenCodeImport,
  createOpenCodeNative,
  isExactOpenCodeSessionNotFound,
  opencodeNativeConfigDigest,
  parseOpenCodeImportOutput,
  parseOpenCodeModels,
  parseOpenCodeVersion,
  type OpenCodeNative,
} from '../src/providers/opencode/official-import.js';
import { OPENCODE_IMPORT_TARGET_LOCK } from '../src/providers/opencode/import-target.js';
import type { OfficialOpenCodeExport } from '../src/providers/opencode/official-export.js';
import { opencodeNativeDataRoot } from '../src/providers/opencode/paths.js';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

async function fixture(t: TestContext) {
  const env = await createIsolatedEnvironment('watch-opencode-official-');
  t.after(() => env.cleanup());
  const cwd = path.join(env.root, 'project with spaces');
  const targetRoot = path.join(env.home, '.local', 'share', 'opencode');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const source: SessionRef = {
    provider: 'claude',
    sessionId: randomUUID(),
    filePath: path.join(env.root, 'source.jsonl'),
    cwd,
  };
  await writeFile(source.filePath, JSON.stringify({ cwd, marker: 'synthetic source' }) + '\n', { mode: 0o600 });
  const original = await readFile(source.filePath, 'utf8');
  const turns: UnifiedTurn[] = [
    { role: 'user', text: 'Read the fixture', timestamp: '2026-09-08T04:00:00.000Z', provider: 'claude' },
    {
      role: 'assistant', text: 'Fixture read', timestamp: '2026-09-08T04:00:01.000Z', provider: 'claude',
      events: [
        { kind: 'tool_call', summary: 'Read', name: 'Read', callId: 'read-1', input: { file_path: source.filePath }, timestamp: '2026-09-08T04:00:01.100Z', provider: 'claude' },
        { kind: 'tool_result', summary: 'synthetic', detail: 'synthetic result', callId: 'read-1', timestamp: '2026-09-08T04:00:01.200Z', provider: 'claude' },
      ],
    },
  ];
  const sessions = new Map<string, OfficialOpenCodeExport>();
  let version = '1.18.29';
  let models = ['big-pickle', 'muse-spark-1.3-contributor-free'];
  let imports = 0;
  let reads = 0;
  let parses = 0;
  let modelCatalogs = 0;
  let importedFile = '';
  let beforeImport = async () => {};
  let afterRead = async (value: OfficialOpenCodeExport) => value;
  let returnedId: string | undefined;
  const native: OpenCodeNative = {
    version: async () => version,
    listModels: async () => { modelCatalogs += 1; return [...models]; },
    readSession: async (id) => {
      reads += 1;
      const value = sessions.get(id);
      return value ? await afterRead(structuredClone(value)) : null;
    },
    importSession: async (file) => {
      imports += 1;
      importedFile = file;
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      await beforeImport();
      const value = JSON.parse(await readFile(file, 'utf8')) as OfficialOpenCodeExport;
      sessions.set(value.info.id, value);
      return returnedId ?? value.info.id;
    },
  };
  const jobsRoot = path.join(env.root, 'imports');
  const targetModel = { providerID: 'opencode', modelID: 'big-pickle' } as const;
  const deps = {
    jobs: new ImportJobs(jobsRoot),
    home: env.home,
    targetRoot,
    nativeConfigDigest: opencodeNativeConfigDigest(env.env),
    native,
    findSource: async (id: string, requestedCwd: string) => id === source.sessionId && requestedCwd === cwd ? source : null,
    parseSource: async () => { parses += 1; return structuredClone(turns); },
  };
  const service = new OfficialOpenCodeImport(deps);
  return {
    env, cwd, targetRoot, source, original, turns, sessions, jobsRoot, deps, service,
    targetModel,
    setVersion: (value: string) => { version = value; },
    setModels: (value: string[]) => { models = [...value]; },
    setBeforeImport: (value: () => Promise<void>) => { beforeImport = value; },
    setAfterRead: (value: (data: OfficialOpenCodeExport) => OfficialOpenCodeExport | Promise<OfficialOpenCodeExport>) => {
      afterRead = async (data) => value(data);
    },
    setReturnedId: (value: string) => { returnedId = value; },
    counts: () => ({ imports, reads, parses, modelCatalogs }),
    importedFile: () => importedFile,
  };
}

test('OpenCode prepare stores an immutable content-free plan and does not probe sessions', async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  const second = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  assert.equal(first.planId, second.planId);
  assert.equal(first.status, 'prepared');
  assert.equal(first.plan.schema, 3);
  assert.equal(first.canConfirm, true);
  assert.match(first.plan.exportSummary.sessionId, /^ses_/);
  assert.equal(first.plan.exportSummary.sessionId, second.plan.exportSummary.sessionId);
  assert.equal(first.plan.exportSummary.sessionId.includes(f.source.sessionId), false);
  assert.equal(JSON.stringify(first.plan).includes('Read the fixture'), false);
  assert.deepEqual(first.plan.targetModel, f.targetModel);
  assert.match(first.plan.modelCatalogDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first.plan).includes('muse-spark'), false);
  assert.deepEqual(f.counts(), { imports: 0, reads: 0, parses: 2, modelCatalogs: 2 });
});

test('OpenCode confirm imports once, verifies exact messages and removes its temporary file and lock', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'imported');
  assert.equal(result.outcome?.nativeRead, 'official-export-exact-messages');
  assert.equal(result.outcome?.sourceUnchanged, true);
  assert.equal(result.outcome?.targetLock, 'released');
  assert.equal(result.requiresManualReview, false);
  assert.equal(result.outcome?.target?.cwd, f.cwd);
  assert.equal(result.clientVisibility, 'not-run');
  assert.equal(result.modelContinuation, 'not-run');
  assert.deepEqual(f.counts(), { imports: 1, reads: 2, parses: 3, modelCatalogs: 3 });
  assert.deepEqual(await f.service.confirm(planId), result);
  assert.equal(f.counts().imports, 1);
  await assert.rejects(stat(f.importedFile()), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.targetRoot, OPENCODE_IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
  assert.equal(await readFile(f.source.filePath, 'utf8'), f.original);
});

test('OpenCode target collision aborts before claim and releases the target lock', async (t) => {
  const f = await fixture(t);
  const preview = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  const existing = JSON.parse(JSON.stringify({ info: { id: preview.plan.exportSummary.sessionId } })) as OfficialOpenCodeExport;
  f.sessions.set(preview.plan.exportSummary.sessionId, existing);
  await assert.rejects(f.service.confirm(preview.planId), /already exists/);
  assert.equal(f.counts().imports, 0);
  assert.equal(await f.deps.jobs.attempted(preview.planId), false);
  await assert.rejects(stat(path.join(f.targetRoot, OPENCODE_IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
});

test('OpenCode source or version changes before submission fail without an import claim', async (t) => {
  const changedSource = await fixture(t);
  const sourcePlan = await changedSource.service.prepare(
    changedSource.source.sessionId, changedSource.cwd, changedSource.targetModel,
  );
  await writeFile(changedSource.source.filePath, 'changed');
  await assert.rejects(changedSource.service.confirm(sourcePlan.planId), /Source changed/);
  assert.equal(changedSource.counts().imports, 0);
  assert.equal(await changedSource.deps.jobs.attempted(sourcePlan.planId), false);

  const changedVersion = await fixture(t);
  const versionPlan = await changedVersion.service.prepare(
    changedVersion.source.sessionId, changedVersion.cwd, changedVersion.targetModel,
  );
  changedVersion.setVersion('1.18.30');
  await assert.rejects(changedVersion.service.confirm(versionPlan.planId), /version or home changed/);
  assert.equal(changedVersion.counts().imports, 0);
  assert.equal(await changedVersion.deps.jobs.attempted(versionPlan.planId), false);

  const changedConfig = await fixture(t);
  const configPlan = await changedConfig.service.prepare(
    changedConfig.source.sessionId, changedConfig.cwd, changedConfig.targetModel,
  );
  const changedConfigService = new OfficialOpenCodeImport({
    ...changedConfig.deps,
    nativeConfigDigest: opencodeNativeConfigDigest({
      ...changedConfig.env.env,
      OPENCODE_CONFIG_DIR: path.join(changedConfig.env.root, 'other-config'),
    }),
  });
  await assert.rejects(changedConfigService.confirm(configPlan.planId), /native configuration changed/);
  assert.equal(changedConfig.counts().imports, 0);
  assert.equal(await changedConfig.deps.jobs.attempted(configPlan.planId), false);

  const changedTarget = await fixture(t);
  const targetPlan = await changedTarget.service.prepare(
    changedTarget.source.sessionId, changedTarget.cwd, changedTarget.targetModel,
  );
  const otherTarget = path.join(changedTarget.env.root, 'other-opencode-data');
  await mkdir(otherTarget, { mode: 0o700 });
  const changedTargetService = new OfficialOpenCodeImport({ ...changedTarget.deps, targetRoot: otherTarget });
  await assert.rejects(changedTargetService.confirm(targetPlan.planId), /target configuration changed/);
  assert.equal(changedTarget.counts().imports, 0);
  assert.equal(await changedTarget.deps.jobs.attempted(targetPlan.planId), false);

  const changedModels = await fixture(t);
  const modelPlan = await changedModels.service.prepare(
    changedModels.source.sessionId, changedModels.cwd, changedModels.targetModel,
  );
  changedModels.setModels(['big-pickle']);
  await assert.rejects(changedModels.service.confirm(modelPlan.planId), /model catalog changed/);
  assert.equal(changedModels.counts().imports, 0);
  assert.equal(changedModels.counts().reads, 0);
  assert.equal(await changedModels.deps.jobs.attempted(modelPlan.planId), false);

  const missingModel = await fixture(t);
  missingModel.setModels(['muse-spark-1.3-contributor-free']);
  await assert.rejects(
    missingModel.service.prepare(missingModel.source.sessionId, missingModel.cwd, missingModel.targetModel),
    /target model opencode\/big-pickle is not available/,
  );
  assert.equal(missingModel.counts().imports, 0);
});

test('OpenCode post-claim failure stays uncertain, retains the lock and cannot be retried', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  f.setBeforeImport(async () => { throw new Error('synthetic timeout with sensitive detail'); });
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.canConfirm, false);
  assert.equal(JSON.stringify(result).includes('sensitive detail'), false);
  assert.equal(f.counts().imports, 1);
  assert.ok(await stat(path.join(f.targetRoot, OPENCODE_IMPORT_TARGET_LOCK)));
  const restarted = new OfficialOpenCodeImport({ ...f.deps, jobs: new ImportJobs(f.jobsRoot) });
  await assert.rejects(restarted.confirm(planId), /already attempted/);
  assert.equal(f.counts().imports, 1);
});

test('OpenCode native verification and lock finalization failures remain inspectable', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.service.prepare(f.source.sessionId, f.cwd, f.targetModel);
  f.setAfterRead((value) => {
    value.messages[0]!.parts[0]!.text = 'changed by native fixture';
    return value;
  });
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.outcome?.target?.sessionId, result.plan.exportSummary.sessionId);
  assert.equal(result.outcome?.nativeRead, undefined);
  assert.ok(await stat(path.join(f.targetRoot, OPENCODE_IMPORT_TARGET_LOCK)));

  const replaced = await fixture(t);
  const replacedPlan = await replaced.service.prepare(replaced.source.sessionId, replaced.cwd, replaced.targetModel);
  replaced.setAfterRead(async (value) => {
    const lockPath = path.join(replaced.targetRoot, OPENCODE_IMPORT_TARGET_LOCK);
    await unlink(lockPath);
    await writeFile(lockPath, 'replacement\n', { mode: 0o600, flag: 'wx' });
    return value;
  });
  const replacedResult = await replaced.service.confirm(replacedPlan.planId);
  assert.equal(replacedResult.status, 'imported');
  assert.equal(replacedResult.outcome?.code, 'target_lock_held');
  assert.equal(replacedResult.outcome?.targetLock, 'held');
  assert.equal(replacedResult.requiresManualReview, true);
});

test('OpenCode unexpected import ID is uncertain and concurrent confirms submit at most once', async (t) => {
  const wrong = await fixture(t);
  const wrongPlan = await wrong.service.prepare(wrong.source.sessionId, wrong.cwd, wrong.targetModel);
  wrong.setReturnedId('ses_000000000000AAAAAAAAAAAAAA');
  const wrongResult = await wrong.service.confirm(wrongPlan.planId);
  assert.equal(wrongResult.status, 'uncertain');
  assert.equal(wrongResult.outcome?.target, undefined);
  assert.equal(wrong.counts().imports, 1);

  const concurrent = await fixture(t);
  const { planId } = await concurrent.service.prepare(
    concurrent.source.sessionId, concurrent.cwd, concurrent.targetModel,
  );
  const results = await Promise.allSettled([concurrent.service.confirm(planId), concurrent.service.confirm(planId)]);
  assert.ok(results.some((result) => result.status === 'fulfilled' && result.value.status === 'imported'));
  assert.equal(concurrent.counts().imports, 1);
});

test('OpenCode native output parsers accept one exact result and fail closed on ambiguity', () => {
  const id = 'ses_000000000000AAAAAAAAAAAAAA';
  assert.equal(parseOpenCodeVersion('opencode v1.18.29\n'), '1.18.29');
  assert.equal(parseOpenCodeVersion('1.18.29'), '1.18.29');
  assert.throws(() => parseOpenCodeVersion('from 1.18.29 to 1.18.30'), /Cannot determine/);
  assert.equal(parseOpenCodeImportOutput(`Imported session: ${id}\n`), id);
  assert.throws(() => parseOpenCodeImportOutput(`warning\nImported session: ${id}\n`));
  assert.throws(() => parseOpenCodeImportOutput('Imported session: source-id'));
  assert.deepEqual(
    parseOpenCodeModels('opencode/muse-spark-1.3-contributor-free\nopencode/big-pickle\n', 'opencode'),
    ['big-pickle', 'muse-spark-1.3-contributor-free'],
  );
  assert.throws(() => parseOpenCodeModels('', 'opencode'), /returned no models/);
  assert.throws(() => parseOpenCodeModels('anthropic/claude-sonnet\n', 'opencode'), /unexpected provider/);
  assert.throws(() => parseOpenCodeModels('opencode/big-pickle\nopencode/big-pickle\n', 'opencode'), /duplicate/);
  const missing = {
    code: 1,
    stdout: '',
    stderr: `Exporting session: ${id}\n\u001b[91m\u001b[1mError: \u001b[0mSession not found: ${id}\n`,
  };
  assert.equal(isExactOpenCodeSessionNotFound(missing, id), true);
  assert.equal(isExactOpenCodeSessionNotFound({ ...missing, killed: true }, id), false);
  assert.equal(isExactOpenCodeSessionNotFound({ ...missing, code: 'ETIMEDOUT' }, id), false);
  assert.equal(isExactOpenCodeSessionNotFound({ ...missing, stdout: 'partial JSON' }, id), false);
  assert.equal(isExactOpenCodeSessionNotFound({ ...missing, stderr: `${missing.stderr}warning\n` }, id), false);
  assert.throws(
    () => createOpenCodeNative('unused', { OPENCODE_DB: ':memory:' }),
    /do not support OPENCODE_DB overrides/,
  );
});

test('OpenCode official target root ignores the Watch-only database override', async (t) => {
  const env = await createIsolatedEnvironment('watch-opencode-paths-');
  t.after(() => env.cleanup());
  const nativeRoot = opencodeNativeDataRoot(env.env, env.home);
  assert.equal(nativeRoot, path.join(env.env.XDG_DATA_HOME, 'opencode'));
  assert.notEqual(nativeRoot, path.dirname(env.env.WATCH_OPENCODE_DB));
  const first = opencodeNativeConfigDigest({ ...env.env, OPENCODE_CONFIG_CONTENT: 'secret-a' });
  const second = opencodeNativeConfigDigest({ ...env.env, OPENCODE_CONFIG_CONTENT: 'secret-b' });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes('secret-a'), false);
});
