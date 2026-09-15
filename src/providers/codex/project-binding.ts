import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ImportJobs, type ProjectBindingOutcome, type ProjectBindingPlan } from '../../core/import-jobs.js';
import type { SessionRef } from '../../core/types.js';
import { asRecord, type ImportRpc, type RpcProfile } from './app-server.js';
import { acquireImportTarget, assertImportTarget, assertTargetFile, IMPORT_TARGET_LOCK, inspectImportTarget, type ImportTarget } from './import-target.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Dependencies = {
  jobs: ImportJobs;
  home: string;
  codexHome: string;
  version(): Promise<string>;
  connect(cwd: string, codexHome: string, profile?: RpcProfile): Promise<ImportRpc>;
};

function historyDigest(thread: Record<string, unknown>): string {
  if (!Array.isArray(thread.turns) || thread.turns.length === 0) throw new Error('Native thread history is missing');
  return createHash('sha256').update(JSON.stringify(thread.turns)).digest('hex');
}

async function inspectAssociation(rpc: ImportRpc, ref: SessionRef, projectId: string, target: ImportTarget) {
  const config = asRecord(asRecord(await rpc.request('config/read', { includeLayers: false })).config);
  if (config.sqlite_home != null && (typeof config.sqlite_home !== 'string' || !path.isAbsolute(config.sqlite_home) ||
    await realpath(config.sqlite_home) !== target.path)) {
    throw new Error('Separate native SQLite directories require additional validation');
  }
  const project = asRecord(asRecord(await rpc.request('project/read', { projectId })).project);
  if (project.id !== projectId || typeof project.name !== 'string' || !Array.isArray(project.roots) ||
    project.roots.length !== 1 || asRecord(project.roots[0]).path !== ref.cwd) {
    throw new Error('The project must contain only the imported session working directory');
  }
  const thread = asRecord(asRecord(await rpc.request('thread/read', { threadId: ref.sessionId, includeTurns: true })).thread);
  if (thread.id !== ref.sessionId || thread.cwd !== ref.cwd || thread.path !== ref.filePath) {
    throw new Error('Native session identity differs from the imported result');
  }
  await assertTargetFile(target, ref.filePath);
  if (thread.projectId != null && thread.projectId !== projectId) {
    throw new Error('The session already belongs to another project; refusing to move it');
  }
  return { projectName: project.name, currentProjectId: thread.projectId ?? null, historyDigest: historyDigest(thread) };
}

async function listedInProject(rpc: ImportRpc, projectId: string, ref: SessionRef): Promise<boolean> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = asRecord(await rpc.request('thread/list', { projectId, limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result.data)) throw new Error('Invalid project thread list');
    const rows = result.data.map(asRecord);
    if (rows.some((row) => row.projectId !== projectId)) throw new Error('Native project filtering is not supported');
    if (rows.some((row) => row.id === ref.sessionId && row.cwd === ref.cwd)) return true;
    if (result.nextCursor == null) return false;
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw new Error('Invalid project thread pagination');
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error('Project thread list exceeds the bounded verification limit');
}

/** Associates an already imported session. This profile cannot import, create projects, or send turns. */
export class CodexProjectBinding {
  constructor(private deps: Dependencies) {}

  async prepare(importId: string, projectId: string) {
    if (!UUID.test(projectId)) throw new Error('An existing project UUID is required');
    const importedPlan = await this.deps.jobs.plan(importId);
    const imported = await this.deps.jobs.outcome(importId);
    if (imported?.status !== 'imported' || !imported.target || !importedPlan.target) throw new Error('A completed import is required');
    const version = await this.deps.version();
    if (version !== 'codex-cli 0.153.4' || version !== importedPlan.cliVersion ||
      this.deps.codexHome !== importedPlan.codexHome) throw new Error('Codex data directory or CLI version differs from the completed import');
    const target = await inspectImportTarget(this.deps.codexHome);
    for (const key of ['path', 'device', 'inode'] as const) {
      if (target[key] !== importedPlan.target[key]) throw new Error('The imported data directory was replaced');
    }
    const lock = await acquireImportTarget(target, `project-preview:${importId}`);
    let rpc: ImportRpc | undefined;
    try {
      rpc = await this.deps.connect(imported.target.cwd, target.path, 'project-binding');
      const inspected = await inspectAssociation(rpc, imported.target, projectId, target);
      await assertImportTarget(this.deps.codexHome, target);
      const plan: ProjectBindingPlan = {
        schema: 1, route: 'codex-project-association', importPlanId: importId, thread: imported.target,
        projectId, projectName: inspected.projectName, historyDigest: inspected.historyDigest,
        target, home: this.deps.home, codexHome: this.deps.codexHome, cliVersion: version,
      };
      return this.status(await this.deps.jobs.prepareProject(plan));
    } finally {
      await rpc?.close();
      await lock.release();
    }
  }

  async status(planId: string) {
    const plan = await this.deps.jobs.projectPlan(planId);
    const outcome = await this.deps.jobs.projectOutcome(planId);
    const attempted = await this.deps.jobs.attempted(planId);
    return { planId, plan, status: outcome?.status ?? (attempted ? 'uncertain' : 'prepared'), outcome,
      canConfirm: !attempted, guiAcceptance: 'pending-manual-review', modelContinuation: 'not-run',
      evidenceScope: 'local-receipt',
      targetLockPath: path.join(plan.target.path, IMPORT_TARGET_LOCK) };
  }

  async confirm(planId: string) {
    const previous = await this.status(planId);
    if (previous.status === 'associated') return previous;
    if (!previous.canConfirm) throw new Error('Project association was already attempted; do not repeat an uncertain update');
    const { plan } = previous;
    if (plan.home !== this.deps.home || plan.codexHome !== this.deps.codexHome || plan.cliVersion !== await this.deps.version()) {
      throw new Error('Project association environment changed since preview');
    }
    const imported = await this.deps.jobs.outcome(plan.importPlanId);
    if (imported?.status !== 'imported' || JSON.stringify(imported.target) !== JSON.stringify(plan.thread)) {
      throw new Error('The completed import no longer matches this association');
    }
    await assertImportTarget(this.deps.codexHome, plan.target);
    const lock = await acquireImportTarget(plan.target, planId);
    let rpc: ImportRpc | undefined;
    let claimed = false;
    let finished = false;
    let outcome: ProjectBindingOutcome = { status: 'uncertain', threadId: plan.thread.sessionId, projectId: plan.projectId };
    try {
      rpc = await this.deps.connect(plan.thread.cwd, plan.target.path, 'project-binding');
      const before = await inspectAssociation(rpc, plan.thread, plan.projectId, plan.target);
      if (before.historyDigest !== plan.historyDigest) throw new Error('Session history changed since the project preview');
      await assertImportTarget(this.deps.codexHome, plan.target);
      await this.deps.jobs.claim(planId);
      claimed = true;
      if (before.currentProjectId !== plan.projectId) {
        await rpc.request('thread/metadata/update', { threadId: plan.thread.sessionId, projectId: plan.projectId });
      }
      const after = await inspectAssociation(rpc, plan.thread, plan.projectId, plan.target);
      if (after.currentProjectId !== plan.projectId || after.historyDigest !== plan.historyDigest ||
        !await listedInProject(rpc, plan.projectId, plan.thread)) throw new Error('Project association verification failed');
      await assertImportTarget(this.deps.codexHome, plan.target);
      outcome = { ...outcome, status: 'associated', membershipVerified: true, historyUnchanged: true };
      await this.deps.jobs.saveProject(planId, outcome);
      finished = true;
    } catch (error) {
      if (!claimed) throw error;
      outcome = { ...outcome, status: 'uncertain', code: 'project_association_requires_review' };
      await this.deps.jobs.saveProject(planId, outcome);
    } finally {
      await rpc?.close();
      if (!claimed || finished) await lock.release();
    }
    return this.status(planId);
  }
}
