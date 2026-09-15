import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportJobs } from '../src/core/import-jobs.js';
import { IMPORT_TARGET_LOCK } from '../src/providers/codex/import-target.js';
import { OfficialCodexImport } from '../src/providers/codex/official-import.js';
import type { CodexDesktopProject } from '../src/providers/codex/desktop-project.js';
import type { ImportRpc, RpcProfile } from '../src/providers/codex/app-server.js';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

async function fixture(t: TestContext) {
  const env = await createIsolatedEnvironment('watch-import-test-');
  t.after(() => env.cleanup());
  const cwd = path.join(env.root, 'worktree with spaces');
  await mkdir(cwd);
  const source = { provider: 'claude', sessionId: randomUUID(), filePath: path.join(env.root, 'source.jsonl'), cwd };
  await writeFile(source.filePath, JSON.stringify({ cwd, text: 'synthetic import test' }) + '\n');
  const original = await readFile(source.filePath, 'utf8');
  const root = path.join(env.root, 'watch.db.imports');
  const jobs = new ImportJobs(root);
  const targetId: string = randomUUID();
  const nativeImportId = randomUUID();
  const codexHome = path.join(env.home, '.codex');
  const targetFile = path.join(codexHome, 'sessions', 'target.jsonl');
  await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  await writeFile(targetFile, 'synthetic target');
  const calls: { method: string; params: unknown }[] = [];
  let connections = 0;
  let closes = 0;
  const callbacks = {
    beforeDetect: async () => {},
    beforeImport: async () => {},
    sqliteHome: null as string | null,
    detected: { items: [
      { itemType: 'CONFIG', cwd: null, description: 'do not import' },
      { itemType: 'SESSIONS', cwd: null, description: 'sessions', dangerousExtra: 'not-forwarded', details: {
        plugins: [{ marketplaceName: 'do-not-copy', pluginNames: ['unsafe'] }],
        sessions: [
          { path: source.filePath, cwd, title: 'not persisted', extra: 'not-forwarded' },
          { path: '/not-selected/other.jsonl', cwd: '/not-selected' },
        ],
      } },
    ] },
    completed: {
      importId: nativeImportId, itemTypeResults: [{ itemType: 'SESSIONS', failures: [], successes: [
        { itemType: 'SESSIONS', source: source.filePath, cwd, target: targetId },
      ] }],
    },
    thread: { id: targetId, cwd, path: targetFile, projectId: null as string | null, turns: [{ items: [] }] },
  };
  const rpc: ImportRpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'config/read') return { config: { sqlite_home: callbacks.sqliteHome } };
      if (method === 'externalAgentConfig/detect') { await callbacks.beforeDetect(); return callbacks.detected; }
      if (method === 'externalAgentConfig/import') { await callbacks.beforeImport(); return { importId: nativeImportId }; }
      if (method === 'thread/read') return { thread: callbacks.thread };
      if (method === 'project/read') {
        const projectId = (params as { projectId: string }).projectId;
        return { project: { id: projectId, name: 'Fixture project', roots: [{ path: cwd }] } };
      }
      if (method === 'thread/metadata/update') {
        callbacks.thread.projectId = (params as { projectId: string }).projectId;
        return { thread: callbacks.thread };
      }
      if (method === 'thread/list') {
        return { data: callbacks.thread.projectId == null ? [] : [{ id: targetId, cwd, projectId: callbacks.thread.projectId }] };
      }
      throw new Error('unexpected RPC');
    },
    completion: async (id) => { assert.equal(id, nativeImportId); return callbacks.completed; },
    close: async () => { closes++; },
  };
  const profiles: Array<RpcProfile | undefined> = [];
  const deps = {
    jobs, home: env.home, codexHome,
    version: async () => 'codex-cli 0.153.4',
    findSource: async () => source,
    connect: async (_cwd: string, targetHome: string, profile?: RpcProfile) => {
      assert.equal(targetHome, codexHome); connections++; profiles.push(profile); return rpc;
    },
  };
  const service = new OfficialCodexImport(deps);
  const prepare = () => service.prepare(source.sessionId, cwd);
  return { env, cwd, source, original, jobs, root, targetId, calls, callbacks, deps, profiles, service, prepare,
    counts: () => ({ connections, closes, imports: calls.filter((call) => call.method === 'externalAgentConfig/import').length }) };
}

test('prepare is a local preview; repeated preparations share the same immutable plan', async (t) => {
  const f = await fixture(t);
  const a = await f.prepare();
  const b = await f.prepare();
  assert.equal(a.planId, b.planId);
  assert.equal(a.status, 'prepared');
  assert.equal(a.canConfirm, true);
  assert.equal(f.counts().connections, 0);
  assert.equal(f.counts().imports, 0);
  assert.equal(await readFile(f.source.filePath, 'utf8'), f.original);
  assert.equal(JSON.stringify(a).includes('synthetic import test'), false);
});

test('confirm selects exactly one session, saves target, and repeat confirmation never writes again', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'imported');
  assert.equal(result.outcome?.target?.sessionId, f.targetId);
  assert.equal(result.outcome?.nativeRead, 'metadata-only');
  assert.equal(result.desktop, 'unverified');
  assert.equal(result.guiAcceptance, 'pending-manual-review');
  assert.equal(result.modelContinuation, 'not-run');
  assert.deepEqual(f.calls.find((call) => call.method === 'externalAgentConfig/import')!.params, {
    migrationItems: [{ itemType: 'SESSIONS', description: 'Import one confirmed Claude Code session', cwd: null,
      details: { sessions: [{ path: f.source.filePath, cwd: f.cwd }] } }], source: 'watch-session-import',
  });
  assert.deepEqual(await f.service.confirm(planId), result);
  assert.equal((await f.prepare()).canConfirm, false);
  assert.deepEqual(f.counts(), { connections: 1, closes: 1, imports: 1 });
  await assert.rejects(stat(path.join(f.deps.codexHome, IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
  assert.equal(await readFile(f.source.filePath, 'utf8'), f.original);
});

test('desktop project mode requires project-first state and atomically verifies native membership', async (t) => {
  const f = await fixture(t);
  const desktopProject: CodexDesktopProject = {
    policy: 'codex-desktop-project-first-v1',
    legacyProjectId: randomUUID(),
    nativeProjectId: randomUUID(),
    name: 'Fixture project',
    rootPaths: [f.cwd],
  };
  let current = desktopProject;
  const service = new OfficialCodexImport({
    ...f.deps,
    inspectDesktopProject: async () => current,
    assertDesktopThreadPlacement: async () => {},
  });
  const preview = await service.prepare(f.source.sessionId, f.cwd, { desktopProject: true });
  assert.deepEqual(preview.plan.desktopProject, desktopProject);
  assert.equal(preview.desktop, 'project-first-preflight');
  const result = await service.confirm(preview.planId);
  assert.equal(result.status, 'imported');
  assert.deepEqual(result.outcome?.desktopProject, {
    legacyProjectId: desktopProject.legacyProjectId,
    nativeProjectId: desktopProject.nativeProjectId,
    membershipVerified: true,
    visibilityPreflightVerified: true,
  });
  assert.equal(result.desktop, 'project-membership-and-visibility-preflight-verified');
  assert.deepEqual(f.profiles, ['desktop-import']);
  assert.equal(f.callbacks.thread.projectId, desktopProject.nativeProjectId);
  assert.equal(f.calls.filter((call) => call.method === 'thread/metadata/update').length, 1);

  const changed = await fixture(t);
  const changedProject = { ...desktopProject, rootPaths: [changed.cwd] };
  let inspected = changedProject;
  const changedService = new OfficialCodexImport({
    ...changed.deps,
    inspectDesktopProject: async () => inspected,
    assertDesktopThreadPlacement: async () => {},
  });
  const changedPreview = await changedService.prepare(changed.source.sessionId, changed.cwd, { desktopProject: true });
  inspected = { ...changedProject, nativeProjectId: randomUUID() };
  await assert.rejects(changedService.confirm(changedPreview.planId), /changed since preview/);
  assert.equal(changed.counts().imports, 0);

  const excluded = await fixture(t);
  const excludedService = new OfficialCodexImport({
    ...excluded.deps,
    inspectDesktopProject: async () => desktopProject,
    assertDesktopThreadPlacement: async () => { throw new Error('projectless fixture'); },
  });
  const excludedPreview = await excludedService.prepare(excluded.source.sessionId, excluded.cwd, { desktopProject: true });
  const excludedResult = await excludedService.confirm(excludedPreview.planId);
  assert.equal(excludedResult.status, 'uncertain');
  assert.equal(excludedResult.outcome?.target?.sessionId, excluded.targetId);
  assert.equal(excludedResult.outcome?.desktopProject, undefined);
  assert.ok(await stat(path.join(excluded.deps.codexHome, IMPORT_TARGET_LOCK)));
});

test('source changes after preview or during detection prevent any import', async (t) => {
  for (const duringDetection of [false, true]) {
    const f = await fixture(t);
    const { planId } = await f.prepare();
    const change = () => writeFile(f.source.filePath, 'changed');
    if (duringDetection) f.callbacks.beforeDetect = change;
    else await change();
    await assert.rejects(f.service.confirm(planId), /Source changed/);
    assert.equal(f.counts().imports, 0);
    assert.equal(await f.jobs.attempted(planId), false);
  }
});

test('official target guard blocks configuration changes before any native connection', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  await writeFile(path.join(f.deps.codexHome, 'config.toml'), 'changed=true');
  await assert.rejects(f.service.confirm(planId), /configuration changed/);
  assert.equal(f.counts().connections, 0);
  assert.equal(f.counts().imports, 0);
});

test('uncertain import keeps the target locked across different snapshots and journals', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.beforeImport = async () => { throw new Error('submission timed out'); };
  assert.equal((await f.service.confirm(planId)).status, 'uncertain');
  const lock = JSON.parse(await readFile(path.join(f.deps.codexHome, IMPORT_TARGET_LOCK), 'utf8'));
  assert.equal(lock.planId, planId);
  await writeFile(f.source.filePath, 'new source snapshot');
  const other = new OfficialCodexImport({ ...f.deps, jobs: new ImportJobs(path.join(f.env.root, 'other-journal')) });
  const next = await other.prepare(f.source.sessionId, f.cwd);
  assert.notEqual(next.planId, planId);
  await assert.rejects(other.confirm(next.planId), /active or uncertain Watch import/);
  assert.equal(f.counts().imports, 1);
});

test('native storage root overrides block before import and release the target lock', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.sqliteHome = f.env.root;
  await assert.rejects(f.service.confirm(planId), /Separate native SQLite/);
  assert.equal(f.counts().imports, 0);
  assert.equal(f.counts().closes, 1);
  await assert.rejects(stat(path.join(f.deps.codexHome, IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
});

test('native paths escaping the target directory are never accepted', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.thread.path = f.source.filePath;
  assert.equal((await f.service.confirm(planId)).status, 'uncertain');
  assert.ok(await stat(path.join(f.deps.codexHome, IMPORT_TARGET_LOCK)));
});

test('configuration changes during discovery are caught before submission', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.beforeDetect = () => writeFile(path.join(f.deps.codexHome, 'config.toml'), 'changed=true');
  await assert.rejects(f.service.confirm(planId), /configuration changed/);
  assert.equal(f.counts().imports, 0);
  await assert.rejects(stat(path.join(f.deps.codexHome, IMPORT_TARGET_LOCK)), { code: 'ENOENT' });
});

test('simultaneous confirmations acquire at most one persistent import claim', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  const results = await Promise.allSettled([f.service.confirm(planId), f.service.confirm(planId)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.equal(f.counts().imports, 1);
  assert.equal((await f.service.status(planId)).status, 'imported');
});

test('post-submission timeout is persisted as uncertain and cannot be retried after restart', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.beforeImport = async () => { throw new Error('timeout with potentially sensitive diagnostics'); };
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.canConfirm, false);
  assert.equal(JSON.stringify(result).includes('sensitive diagnostics'), false);
  const restarted = new OfficialCodexImport({ ...f.deps, jobs: new ImportJobs(f.root) });
  await assert.rejects(restarted.confirm(planId), /already attempted/);
  assert.equal(f.counts().imports, 1);
});

test('crash claim with no outcome stays uncertain rather than enabling another write', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  await f.jobs.claim(planId);
  assert.equal((await f.service.status(planId)).status, 'uncertain');
  await assert.rejects(f.service.confirm(planId), /already attempted/);
  assert.equal(f.counts().imports, 0);
});

test('unexpected completion or partial success is never reported as successful', async (t) => {
  for (const issue of ['id', 'source', 'target', 'cwd', 'extra-success', 'failure', 'config']) {
    const f = await fixture(t);
    const { planId } = await f.prepare();
    const group = f.callbacks.completed.itemTypeResults[0]!;
    const entry = group.successes[0]!;
    if (issue === 'id') f.callbacks.completed.importId = randomUUID();
    if (issue === 'source') entry.source = '/other-session';
    if (issue === 'target') entry.target = '../../invalid';
    if (issue === 'cwd') entry.cwd = '/other-project';
    if (issue === 'extra-success') group.successes.push({ ...entry });
    if (issue === 'failure') (group.failures as unknown[]).push({ message: 'partial failure' });
    if (issue === 'config') group.itemType = 'CONFIG';
    const result = await f.service.confirm(planId);
    assert.equal(result.status, 'uncertain', issue);
    assert.equal(result.canConfirm, false, issue);
    assert.equal(f.counts().imports, 1);
  }
});

test('retain authoritative target when native read verification fails', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.thread.cwd = '/wrong-directory';
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.outcome?.target?.sessionId, f.targetId);
  assert.equal(result.outcome?.importId, f.callbacks.completed.importId);
});

test('nullable native completion metadata still requires a matching target cwd', async (t) => {
  for (const correctCwd of [true, false]) {
    const f = await fixture(t);
    const { planId } = await f.prepare();
    Object.assign(f.callbacks.completed.itemTypeResults[0]!.successes[0]!, { source: null, cwd: null });
    if (!correctCwd) f.callbacks.thread.cwd = '/wrong-project';
    assert.equal((await f.service.confirm(planId)).status, correctCwd ? 'imported' : 'uncertain');
  }
});

test('source changes after import retain target and require manual review', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  f.callbacks.beforeImport = () => writeFile(f.source.filePath, 'changed while importing');
  const result = await f.service.confirm(planId);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.outcome?.target?.sessionId, f.targetId);
});

test('wrong or duplicate detection cannot import unrelated settings or sessions', async (t) => {
  for (const duplicate of [false, true]) {
    const f = await fixture(t);
    const { planId } = await f.prepare();
    const group = f.callbacks.detected.items[1]!;
    if (duplicate) group.details!.sessions.push({ ...group.details!.sessions[0]! });
    else group.details!.sessions[0]!.path = '/different-source';
    await assert.rejects(f.service.confirm(planId), /exactly one/);
    assert.equal(f.counts().imports, 0);
    assert.equal(f.counts().closes, 1);
  }
});

test('version, cwd and target home are bound to the reviewed plan', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare(f.source.sessionId, 'relative'), /absolute/);
  await assert.rejects(f.service.prepare(f.source.sessionId, '/wrong'), /does not match/);
  const { planId } = await f.prepare();
  const changed = new OfficialCodexImport({ ...f.deps, codexHome: path.join(f.env.root, 'other') });
  await assert.rejects(changed.confirm(planId), /changed since preview/);
  f.deps.version = async () => 'codex-cli 99.0.0';
  await assert.rejects(f.service.confirm(planId), /changed since preview/);
  await assert.rejects(f.prepare(), /requires codex-cli/);
  assert.equal(f.counts().imports, 0);
});

test('tampered plans and traversal IDs fail closed', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  await writeFile(path.join(f.root, result.planId, 'plan.json'), JSON.stringify({ ...result.plan, source: { ...f.source, cwd: '/other' } }));
  await assert.rejects(f.service.confirm(result.planId), /does not match/);
  await assert.rejects(f.service.status('../bad'), /Invalid import plan ID/);
  assert.equal(f.counts().imports, 0);
});

test('plans prepared before target-scoped protection cannot silently acquire new permissions', async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const { target: _target, ...legacy } = prepared.plan;
  const oldPlanId = await f.jobs.prepare(legacy);
  assert.equal((await f.service.status(oldPlanId)).canConfirm, false);
  await assert.rejects(f.service.confirm(oldPlanId), /predates target-scoped/);
  assert.equal(f.counts().imports, 0);
});

test('journal uses private files and status CLI does not start native clients', async (t) => {
  const f = await fixture(t);
  const { planId } = await f.prepare();
  await f.service.confirm(planId);
  if (process.platform !== 'win32') {
    for (const file of ['plan.json', 'started.json', 'outcome.json']) {
      assert.equal((await stat(path.join(f.root, planId, file))).mode & 0o777, 0o600);
    }
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'import-codex', 'status', planId, '--json'], {
    cwd: process.cwd(), env: { ...f.env.env, PATH: '' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const status = JSON.parse(result.stdout);
  assert.equal(status.status, 'imported');
  assert.equal(status.outcome.target.sessionId, f.targetId);
  assert.equal(status.desktop, 'unverified');
});

test('CLI requires explicit experimental confirmation and rejects ambiguous arguments', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['prepare', f.source.sessionId, '--cwd', f.cwd],
    ['confirm', 'missing'],
    ['prepare', f.source.sessionId, '--cwd', 'relative', '--experimental'],
    ['status', 'missing', '--cwd', f.cwd],
    ['status', 'missing', '--from', 'other'],
  ]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'import-codex', ...args, '--json'], {
      cwd: process.cwd(), env: { ...f.env.env, PATH: '' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});
