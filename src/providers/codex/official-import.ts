import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import { ImportJobs, type ImportOutcome, type ImportPlan } from '../../core/import-jobs.js';
import { resolveCli } from '../../core/platform.js';
import type { SessionRef } from '../../core/types.js';
import { claudeProjectsDir, encodeClaudeProjectDir } from '../claude/build.js';
import { claudeSessionCwd } from '../claude/index.js';
import { asRecord, connectImportRpc, type ImportRpc, type RpcProfile } from './app-server.js';
import {
  assertCodexDesktopThreadPlacement,
  inspectCodexDesktopProject,
  sameCodexDesktopProject,
  type CodexDesktopProject,
} from './desktop-project.js';
import { CodexProjectBinding } from './project-binding.js';
import { acquireImportTarget, assertImportTarget, assertTargetFile, IMPORT_TARGET_LOCK, inspectImportTarget } from './import-target.js';

const SUPPORTED_VERSION = 'codex-cli 0.153.4';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const execFileAsync = promisify(execFile);
const WARNINGS = [
  'Experimental session-only import; configuration, plugins and permissions are not selected.',
  'Tool records may become text. Attachments and complete content fidelity are not verified.',
  'No desktop opening or model continuation has been verified by this command.',
];

type Dependencies = {
  jobs: ImportJobs;
  home: string;
  codexHome: string;
  version(): Promise<string>;
  findSource(id: string, cwd: string): Promise<SessionRef | null>;
  connect(cwd: string, codexHome: string, profile?: RpcProfile): Promise<ImportRpc>;
  inspectDesktopProject?(codexHome: string, cwd: string): Promise<CodexDesktopProject>;
  assertDesktopThreadPlacement?(codexHome: string, threadId: string, project: CodexDesktopProject): Promise<void>;
};

async function fingerprint(ref: SessionRef): Promise<FileDigest> {
  if (ref.provider !== 'claude' || !UUID.test(ref.sessionId) || !path.isAbsolute(ref.filePath) || !path.isAbsolute(ref.cwd)) {
    throw new Error('Expected a local Claude Code session');
  }
  if (!(await lstat(ref.filePath)).isFile()) throw new Error('Source must be a regular file, not a symlink');
  const digest = await digestFile(ref.filePath);
  if (!digest) throw new Error('Cannot fingerprint the source session');
  return digest;
}

async function assertSource(plan: ImportPlan): Promise<void> {
  const current = await fingerprint(plan.source);
  if (current.sha256 !== plan.digest.sha256 || current.sizeBytes !== plan.digest.sizeBytes) {
    throw new Error('Source changed since preview; prepare and review a new plan');
  }
}

function selectedSession(detected: unknown, plan: ImportPlan): Record<string, unknown> {
  const items = asRecord(detected).items;
  if (!Array.isArray(items)) throw new Error('Codex returned no migration items');
  const matches: Record<string, unknown>[] = [];
  for (const value of items) {
    const item = asRecord(value);
    if (item.itemType !== 'SESSIONS') continue;
    const sessions = asRecord(item.details).sessions;
    if (!Array.isArray(sessions)) throw new Error('Invalid session migration list');
    for (const value of sessions) {
      const session = asRecord(value);
      if (session.path !== plan.source.filePath || session.cwd !== plan.source.cwd) continue;
      if (item.cwd !== null && item.cwd !== undefined && item.cwd !== '' && item.cwd !== plan.source.cwd) {
        throw new Error('Migration scope differs from the confirmed project');
      }
      // Reconstruct an allowlisted payload. Never forward other detected setup.
      matches.push({
        itemType: 'SESSIONS', description: 'Import one confirmed Claude Code session', cwd: item.cwd ?? null,
        details: { sessions: [{ path: session.path, cwd: session.cwd }] },
      });
    }
  }
  if (matches.length !== 1) throw new Error('Codex must detect exactly one matching source session');
  return matches[0]!;
}

function importedTarget(completion: unknown, importId: string, plan: ImportPlan): string {
  const result = asRecord(completion);
  if (result.importId !== importId || !Array.isArray(result.itemTypeResults) || result.itemTypeResults.length !== 1) {
    throw new Error('Unexpected import completion');
  }
  const group = asRecord(result.itemTypeResults[0]);
  if (group.itemType !== 'SESSIONS' || !Array.isArray(group.failures) || group.failures.length !== 0 ||
    !Array.isArray(group.successes) || group.successes.length !== 1) throw new Error('Import reported partial or unexpected results');
  const entry = asRecord(group.successes[0]);
  if (entry.itemType !== 'SESSIONS' || (entry.source != null && entry.source !== plan.source.filePath) ||
    (entry.cwd != null && entry.cwd !== plan.source.cwd) ||
    typeof entry.target !== 'string' || !UUID.test(entry.target)) throw new Error('Import result does not match the confirmed session');
  return entry.target;
}

export class OfficialCodexImport {
  readonly projects: CodexProjectBinding;
  constructor(private deps: Dependencies) { this.projects = new CodexProjectBinding(deps); }

  async prepare(sourceId: string, cwd: string, options: { desktopProject?: boolean } = {}) {
    if (!UUID.test(sourceId) || !path.isAbsolute(cwd)) throw new Error('A Claude session UUID and absolute --cwd are required');
    const version = await this.deps.version();
    if (version !== SUPPORTED_VERSION) throw new Error(`Experimental route currently requires ${SUPPORTED_VERSION}`);
    const source = await this.deps.findSource(sourceId, cwd);
    if (!source || source.sessionId !== sourceId || source.cwd !== cwd) throw new Error('Source session does not match the requested project');
    const plan: ImportPlan = {
      schema: 1, route: 'claude-code-to-codex-official', source, digest: await fingerprint(source),
      cliVersion: version, codexHome: this.deps.codexHome, home: this.deps.home,
      target: await inspectImportTarget(this.deps.codexHome),
      ...(options.desktopProject ? {
        desktopProject: await (this.deps.inspectDesktopProject ?? inspectCodexDesktopProject)(this.deps.codexHome, cwd),
      } : {}),
    };
    const planId = await this.deps.jobs.prepare(plan);
    return this.status(planId);
  }

  async status(planId: string) {
    const plan = await this.deps.jobs.plan(planId);
    const outcome = await this.deps.jobs.outcome(planId);
    const attempted = await this.deps.jobs.attempted(planId);
    return {
      planId, plan, status: outcome?.status ?? (attempted ? 'uncertain' : 'prepared'),
      outcome, warnings: WARNINGS, canConfirm: !attempted && plan.target?.policy === 'official-api-target-v1',
      desktop: outcome?.desktopProject?.visibilityPreflightVerified
        ? 'project-membership-and-visibility-preflight-verified'
        : plan.desktopProject ? 'project-first-preflight' : 'unverified',
      guiAcceptance: 'pending-manual-review', modelContinuation: 'not-run',
      targetLockPath: plan.target ? path.join(plan.target.path, IMPORT_TARGET_LOCK) : undefined,
    };
  }

  async confirm(planId: string) {
    const previous = await this.status(planId);
    if (previous.status === 'imported') return previous;
    if (!previous.plan.target) throw new Error('This plan predates target-scoped protection; review a new preview before importing');
    if (!previous.canConfirm) throw new Error('Import was already attempted; inspect status instead of repeating writes');
    const { plan } = previous;
    const target = plan.target!;
    if (plan.home !== this.deps.home || plan.codexHome !== this.deps.codexHome || plan.cliVersion !== await this.deps.version()) {
      throw new Error('Codex version or home changed since preview');
    }
    await assertSource(plan);
    await assertImportTarget(this.deps.codexHome, target);
    if (plan.desktopProject) await this.assertDesktopProject(plan.desktopProject, plan.source.cwd);
    const lock = await acquireImportTarget(target, planId);
    let rpc: ImportRpc | undefined;
    let claimed = false;
    let finished = false;
    let outcome: ImportOutcome = { status: 'uncertain', code: 'import_outcome_unknown' };
    try {
      rpc = await this.deps.connect(plan.source.cwd, target.path, plan.desktopProject ? 'desktop-import' : 'import');
      const config = asRecord(asRecord(await rpc.request('config/read', { includeLayers: false })).config);
      if (config.sqlite_home != null && (typeof config.sqlite_home !== 'string' ||
        !path.isAbsolute(config.sqlite_home) || await realpath(config.sqlite_home) !== target.path)) {
        throw new Error('Separate native SQLite directories require additional validation; no import submitted');
      }
      if (plan.desktopProject) await this.assertNativeProject(rpc, plan.desktopProject, plan.source.cwd);
      const migrationItem = selectedSession(await rpc.request('externalAgentConfig/detect', {
        includeHome: true, cwds: [plan.source.cwd], maxSessions: 50, maxSessionAgeDays: 30,
      }), plan);
      await assertImportTarget(this.deps.codexHome, target);
      await assertSource(plan);
      if (plan.desktopProject) await this.assertDesktopProject(plan.desktopProject, plan.source.cwd);
      await this.deps.jobs.claim(planId);
      claimed = true;
      const response = asRecord(await rpc.request('externalAgentConfig/import', {
        migrationItems: [migrationItem], source: 'watch-session-import',
      }));
      if (typeof response.importId !== 'string' || !UUID.test(response.importId)) throw new Error('Missing native import ID');
      outcome.importId = response.importId;
      await this.deps.jobs.save(planId, outcome);
      const sessionId = importedTarget(await rpc.completion(response.importId), response.importId, plan);
      // Save the authoritative target even if the following read or source check fails.
      outcome.target = { provider: 'codex', sessionId, cwd: plan.source.cwd, filePath: '' };
      await this.deps.jobs.save(planId, outcome);
      let thread = asRecord(asRecord(await rpc.request('thread/read', { threadId: sessionId, includeTurns: true })).thread);
      if (thread.id !== sessionId || thread.cwd !== plan.source.cwd || typeof thread.path !== 'string' ||
        !path.isAbsolute(thread.path) || !Array.isArray(thread.turns) || thread.turns.length === 0) {
        throw new Error('Native thread metadata does not match the import');
      }
      const targetPath = thread.path;
      await assertTargetFile(target, targetPath);
      if (plan.desktopProject) {
        const turnsBefore = JSON.stringify(thread.turns);
        if (thread.projectId != null && thread.projectId !== plan.desktopProject.nativeProjectId) {
          throw new Error('Imported session unexpectedly belongs to another project');
        }
        if (thread.projectId !== plan.desktopProject.nativeProjectId) {
          await rpc.request('thread/metadata/update', {
            threadId: sessionId,
            projectId: plan.desktopProject.nativeProjectId,
          });
        }
        thread = asRecord(asRecord(await rpc.request('thread/read', { threadId: sessionId, includeTurns: true })).thread);
        if (thread.id !== sessionId || thread.cwd !== plan.source.cwd || thread.path !== targetPath ||
          thread.projectId !== plan.desktopProject.nativeProjectId || JSON.stringify(thread.turns) !== turnsBefore ||
          !await this.listedInProject(rpc, plan.desktopProject.nativeProjectId, sessionId, plan.source.cwd)) {
          throw new Error('Imported session project verification failed');
        }
        await this.assertDesktopProject(plan.desktopProject, plan.source.cwd);
        await (this.deps.assertDesktopThreadPlacement ?? assertCodexDesktopThreadPlacement)(
          this.deps.codexHome,
          sessionId,
          plan.desktopProject,
        );
        outcome.desktopProject = {
          legacyProjectId: plan.desktopProject.legacyProjectId,
          nativeProjectId: plan.desktopProject.nativeProjectId,
          membershipVerified: true,
          visibilityPreflightVerified: true,
        };
      }
      outcome.target.filePath = targetPath;
      await assertSource(plan);
      await assertImportTarget(this.deps.codexHome, target);
      outcome = { ...outcome, status: 'imported', code: undefined, sourceUnchanged: true, nativeRead: 'metadata-only' };
      await this.deps.jobs.save(planId, outcome);
      finished = true;
    } catch (error) {
      if (!claimed) throw error;
      // Any error after submission may hide partial success; retain the claim permanently.
      outcome = { ...outcome, status: 'uncertain', code: 'import_outcome_requires_review' };
      await this.deps.jobs.save(planId, outcome);
    } finally {
      // A submitted but uncertain operation keeps the target locked, even across new plan IDs.
      await rpc?.close();
      if (!claimed || finished) await lock.release();
    }
    return this.status(planId);
  }

  private async assertDesktopProject(expected: CodexDesktopProject, cwd: string): Promise<void> {
    const current = await (this.deps.inspectDesktopProject ?? inspectCodexDesktopProject)(this.deps.codexHome, cwd);
    if (!sameCodexDesktopProject(current, expected)) {
      throw new Error('Codex Desktop project changed since preview; prepare and review a new plan');
    }
  }

  private async assertNativeProject(rpc: ImportRpc, project: CodexDesktopProject, cwd: string): Promise<void> {
    const value = asRecord(asRecord(await rpc.request('project/read', { projectId: project.nativeProjectId })).project);
    if (value.id !== project.nativeProjectId || !Array.isArray(value.roots) ||
      !value.roots.some((root) => asRecord(root).path === cwd)) {
      throw new Error('Codex app-server project no longer matches the desktop project');
    }
  }

  private async listedInProject(rpc: ImportRpc, projectId: string, threadId: string, cwd: string): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = asRecord(await rpc.request('thread/list', {
        projectId, limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}),
      }));
      if (!Array.isArray(result.data)) throw new Error('Invalid project thread list');
      const rows = result.data.map(asRecord);
      if (rows.some((row) => row.projectId !== projectId)) throw new Error('Native project filtering is not supported');
      if (rows.some((row) => row.id === threadId && row.cwd === cwd)) return true;
      if (result.nextCursor == null) return false;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw new Error('Invalid project thread pagination');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new Error('Project thread list exceeds the bounded verification limit');
  }
}

export function createOfficialCodexImport(): OfficialCodexImport {
  const home = homedir();
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(home, '.codex'));
  const db = process.env.WATCH_DB;
  if (db === ':memory:') throw new Error('Official imports require a persistent WATCH_DB location');
  const root = db ? path.resolve(`${db}.imports`) : path.join(home, '.watch', 'imports');
  const executable = resolveCli('codex');
  const env = { ...process.env, CODEX_HOME: codexHome };
  return new OfficialCodexImport({
    jobs: new ImportJobs(root), home, codexHome,
    version: async () => {
      try {
        return (await execFileAsync(executable, ['--version'], { env, timeout: 10_000 })).stdout.trim();
      } catch {
        throw new Error('Cannot determine the installed Codex CLI version');
      }
    },
    findSource: async (id, cwd) => {
      // Scope lookup to one project instead of scanning every Claude transcript.
      const filePath = path.join(claudeProjectsDir(), encodeClaudeProjectDir(cwd), `${id}.jsonl`);
      if (!(await lstat(filePath)).isFile()) return null;
      const canonical = await realpath(filePath);
      return await claudeSessionCwd(canonical) === cwd
        ? { provider: 'claude', sessionId: id, filePath: canonical, cwd }
        : null;
    },
    connect: (cwd, canonicalHome, profile) => connectImportRpc(executable, cwd, { ...env, CODEX_HOME: canonicalHome }, profile),
  });
}
