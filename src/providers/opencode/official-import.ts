import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import { ImportJobs, type ImportJobPlan } from '../../core/import-jobs.js';
import { resolveCli } from '../../core/platform.js';
import type { SessionRef, UnifiedTurn } from '../../core/types.js';
import { resolveById } from '../../open.js';
import { getAdapter } from '../registry.js';
import {
  buildOfficialOpenCodeExport,
  inspectOfficialOpenCodeExport,
  normalizeOpenCodeTargetModel,
  SUPPORTED_OPENCODE_EXPORT_VERSION,
  type OfficialOpenCodeExport,
  type OfficialOpenCodeExportSummary,
  type OpenCodeTargetModel,
} from './official-export.js';
import {
  acquireOpenCodeImportTarget,
  inspectOpenCodeImportTarget,
  OPENCODE_IMPORT_TARGET_LOCK,
  type OpenCodeImportTarget,
} from './import-target.js';
import { opencodeNativeDataRoot } from './paths.js';

const execFileAsync = promisify(execFile);
const ROUTE = 'external-to-opencode-official';
const NATIVE_SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BOUND_NATIVE_ENV = [
  'HOME',
  'USERPROFILE',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_FAKE_VCS',
  'OPENCODE_WORKSPACE_ID',
  'OPENCODE_EXPERIMENTAL_WORKSPACES',
  'OPENCODE_DISABLE_CHANNEL_DB',
  'OPENCODE_TEST_HOME',
] as const;
const WARNINGS = [
  'Experimental OpenCode 1.18.29 session-only import; no UI route is enabled.',
  'Target model metadata is explicitly selected and catalog-validated; credentials and successful continuation are not verified.',
  'Interrupted tool calls are retained as failed tool parts; unsupported source internals are not promised.',
  'Web, attached TUI, IDE visibility and native continuation remain unverified.',
];

export type OpenCodeImportPlan = ImportJobPlan & {
  schema: 3;
  route: typeof ROUTE;
  source: SessionRef;
  digest: FileDigest;
  home: string;
  cliVersion: string;
  nativeConfigDigest: string;
  target: OpenCodeImportTarget;
  targetModel: OpenCodeTargetModel;
  modelCatalogDigest: string;
  exportSeed: string;
  exportDigest: string;
  exportSummary: OfficialOpenCodeExportSummary;
};

export type OpenCodeImportOutcome = {
  status: 'imported' | 'uncertain';
  target?: SessionRef;
  code?: string;
  sourceUnchanged?: boolean;
  nativeRead?: 'official-export-exact-messages';
  targetLock?: 'held' | 'released';
};

export type OpenCodeNative = {
  version(): Promise<string>;
  listModels(providerID: string): Promise<string[]>;
  readSession(sessionId: string, cwd: string): Promise<unknown | null>;
  importSession(file: string, cwd: string): Promise<string>;
};

type Dependencies = {
  jobs: ImportJobs;
  home: string;
  targetRoot: string;
  nativeConfigDigest: string;
  native: OpenCodeNative;
  findSource(id: string, cwd: string): Promise<SessionRef | null>;
  parseSource(ref: SessionRef): Promise<UnifiedTurn[]>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function nativeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.OPENCODE_DB) {
    throw new Error('Official OpenCode imports do not support OPENCODE_DB overrides');
  }
  const env: NodeJS.ProcessEnv = {
    ...source,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  delete env.OPENCODE_PRINT_LOGS;
  return env;
}

export function opencodeNativeConfigDigest(source: NodeJS.ProcessEnv = process.env): string {
  const env = nativeEnvironment(source);
  return hash(Object.fromEntries(BOUND_NATIVE_ENV.map((key) => [key, env[key] ?? null])));
}

async function fingerprint(ref: SessionRef): Promise<FileDigest> {
  if (ref.provider === 'opencode' || !path.isAbsolute(ref.cwd) || !path.isAbsolute(ref.filePath)) {
    throw new Error('Expected a non-OpenCode local source session');
  }
  if (!(await lstat(ref.filePath)).isFile()) throw new Error('Source must be a regular file, not a symlink');
  const value = await digestFile(ref.filePath);
  if (!value) throw new Error('Cannot fingerprint the source session');
  return value;
}

async function assertSource(plan: OpenCodeImportPlan): Promise<void> {
  const current = await fingerprint(plan.source);
  if (current.sha256 !== plan.digest.sha256 || current.sizeBytes !== plan.digest.sizeBytes) {
    throw new Error('Source changed since preview; prepare and review a new plan');
  }
}

function seedFor(
  source: SessionRef,
  digest: FileDigest,
  version: string,
  targetModel: OpenCodeTargetModel,
): string {
  return createHash('sha256')
    .update([
      source.provider,
      source.sessionId,
      source.cwd,
      digest.sha256,
      digest.sizeBytes,
      version,
      targetModel.providerID,
      targetModel.modelID,
      targetModel.variant ?? '',
    ].join('\0'))
    .digest('hex');
}

function buildFromPlan(plan: OpenCodeImportPlan, turns: UnifiedTurn[]): OfficialOpenCodeExport {
  return buildOfficialOpenCodeExport(turns, plan.source.cwd, {
    seed: plan.exportSeed,
    sourceProvider: plan.source.provider,
    version: plan.cliVersion,
    sessionId: plan.exportSummary.sessionId,
    targetModel: plan.targetModel,
  });
}

function assertRebuiltExport(plan: OpenCodeImportPlan, value: OfficialOpenCodeExport): void {
  const summary = inspectOfficialOpenCodeExport(value);
  if (hash(value) !== plan.exportDigest || canonical(summary) !== canonical(plan.exportSummary)) {
    throw new Error('Source conversion changed since preview; prepare and review a new plan');
  }
}

function assertNativeExport(
  plan: OpenCodeImportPlan,
  expected: OfficialOpenCodeExport,
  actual: unknown,
): void {
  const summary = inspectOfficialOpenCodeExport(actual);
  const data = actual as OfficialOpenCodeExport;
  if (
    summary.sessionId !== plan.exportSummary.sessionId ||
    summary.directory !== plan.source.cwd ||
    canonical(summary) !== canonical(plan.exportSummary) ||
    hash(data.messages) !== hash(expected.messages)
  ) {
    throw new Error('Native OpenCode export does not match the confirmed import');
  }
}

async function assertBoundTarget(plan: OpenCodeImportPlan, deps: Dependencies): Promise<void> {
  if (plan.nativeConfigDigest !== deps.nativeConfigDigest) {
    throw new Error('OpenCode native configuration changed since preview');
  }
  const current = await inspectOpenCodeImportTarget(deps.targetRoot);
  if (canonical(current) !== canonical(plan.target)) {
    throw new Error('OpenCode target configuration changed since preview');
  }
}

function modelCatalogDigest(models: string[]): string {
  return hash([...models].sort());
}

function assertTargetModelAvailable(target: OpenCodeTargetModel, models: string[]): void {
  if (!models.includes(target.modelID)) {
    throw new Error(`OpenCode target model ${target.providerID}/${target.modelID} is not available in the current catalog`);
  }
}

async function assertBoundModel(plan: OpenCodeImportPlan, deps: Dependencies): Promise<void> {
  const models = await deps.native.listModels(plan.targetModel.providerID);
  assertTargetModelAvailable(plan.targetModel, models);
  if (modelCatalogDigest(models) !== plan.modelCatalogDigest) {
    throw new Error('OpenCode target model catalog changed since preview');
  }
}

export class OfficialOpenCodeImport {
  constructor(private deps: Dependencies) {}

  async prepare(sourceId: string, cwd: string, requestedTargetModel: OpenCodeTargetModel) {
    if (!sourceId || !path.isAbsolute(cwd)) throw new Error('A source session ID and absolute --cwd are required');
    const targetModel = normalizeOpenCodeTargetModel(requestedTargetModel);
    const version = await this.deps.native.version();
    if (version !== SUPPORTED_OPENCODE_EXPORT_VERSION) {
      throw new Error(`Experimental route currently requires OpenCode ${SUPPORTED_OPENCODE_EXPORT_VERSION}`);
    }
    const models = await this.deps.native.listModels(targetModel.providerID);
    assertTargetModelAvailable(targetModel, models);
    const source = await this.deps.findSource(sourceId, cwd);
    if (!source || source.sessionId !== sourceId || source.cwd !== cwd || source.provider === 'opencode') {
      throw new Error('Source session does not match the requested non-OpenCode project');
    }
    const digest = await fingerprint(source);
    const exportSeed = seedFor(source, digest, version, targetModel);
    const value = buildOfficialOpenCodeExport(await this.deps.parseSource(source), cwd, {
      seed: exportSeed,
      sourceProvider: source.provider,
      version,
      targetModel,
    });
    const plan: OpenCodeImportPlan = {
      schema: 3,
      route: ROUTE,
      source,
      digest,
      home: this.deps.home,
      cliVersion: version,
      nativeConfigDigest: this.deps.nativeConfigDigest,
      target: await inspectOpenCodeImportTarget(this.deps.targetRoot),
      targetModel,
      modelCatalogDigest: modelCatalogDigest(models),
      exportSeed,
      exportDigest: hash(value),
      exportSummary: inspectOfficialOpenCodeExport(value),
    };
    const planId = await this.deps.jobs.prepareRoute(plan);
    return this.status(planId);
  }

  async status(planId: string) {
    const plan = await this.deps.jobs.routePlan<OpenCodeImportPlan>(planId, ROUTE, 3);
    const outcome = await this.deps.jobs.routeOutcome<OpenCodeImportOutcome>(planId);
    const attempted = await this.deps.jobs.attempted(planId);
    return {
      planId,
      plan,
      status: outcome?.status ?? (attempted ? 'uncertain' : 'prepared'),
      outcome,
      warnings: WARNINGS,
      canConfirm: !attempted && plan.target.policy === 'opencode-official-target-v1',
      clientVisibility: 'not-run',
      modelContinuation: 'not-run',
      requiresManualReview: outcome?.status === 'uncertain' || outcome?.targetLock === 'held',
      targetLockPath: path.join(plan.target.path, OPENCODE_IMPORT_TARGET_LOCK),
    };
  }

  async confirm(planId: string) {
    const previous = await this.status(planId);
    if (previous.status === 'imported') return previous;
    if (!previous.canConfirm) throw new Error('Import was already attempted; inspect status instead of repeating writes');
    const { plan } = previous;
    if (plan.home !== this.deps.home || plan.cliVersion !== await this.deps.native.version()) {
      throw new Error('OpenCode version or home changed since preview');
    }
    await assertSource(plan);
    await assertBoundTarget(plan, this.deps);
    await assertBoundModel(plan, this.deps);
    const rebuilt = buildFromPlan(plan, await this.deps.parseSource(plan.source));
    assertRebuiltExport(plan, rebuilt);

    const lock = await acquireOpenCodeImportTarget(plan.target, planId);
    let claimed = false;
    let completed = false;
    let tempRoot: string | undefined;
    let outcome: OpenCodeImportOutcome = { status: 'uncertain', code: 'import_outcome_unknown' };
    try {
      if (await this.deps.native.readSession(plan.exportSummary.sessionId, plan.source.cwd)) {
        throw new Error('OpenCode target session ID already exists; no import submitted');
      }
      await assertSource(plan);
      await assertBoundTarget(plan, this.deps);
      await assertBoundModel(plan, this.deps);
      const finalValue = buildFromPlan(plan, await this.deps.parseSource(plan.source));
      assertRebuiltExport(plan, finalValue);

      tempRoot = await mkdtemp(path.join(tmpdir(), 'watch-opencode-import-'));
      const exportFile = path.join(tempRoot, 'session.json');
      await writeFile(exportFile, JSON.stringify(finalValue) + '\n', { mode: 0o600, flag: 'wx' });
      await this.deps.jobs.claim(planId);
      claimed = true;
      await this.deps.jobs.saveRouteOutcome(planId, outcome);

      const importedId = await this.deps.native.importSession(exportFile, plan.source.cwd);
      if (importedId !== plan.exportSummary.sessionId || !NATIVE_SESSION_ID.test(importedId)) {
        throw new Error('OpenCode returned an unexpected imported session ID');
      }
      outcome.target = {
        provider: 'opencode',
        sessionId: importedId,
        cwd: plan.source.cwd,
        filePath: path.join(plan.target.path, 'opencode.db'),
      };
      await this.deps.jobs.saveRouteOutcome(planId, outcome);
      const native = await this.deps.native.readSession(importedId, plan.source.cwd);
      if (!native) throw new Error('Imported OpenCode session is not readable through official export');
      assertNativeExport(plan, finalValue, native);
      await assertSource(plan);
      await assertBoundTarget(plan, this.deps);
      outcome = {
        ...outcome,
        status: 'imported',
        code: 'target_lock_held',
        sourceUnchanged: true,
        nativeRead: 'official-export-exact-messages',
        targetLock: 'held',
      };
      await this.deps.jobs.saveRouteOutcome(planId, outcome);
      completed = true;
      await lock.release();
      outcome = { ...outcome, code: undefined, targetLock: 'released' };
      await this.deps.jobs.saveRouteOutcome(planId, outcome);
      return this.status(planId);
    } catch (error) {
      if (!claimed) throw error;
      try {
        await this.deps.jobs.saveRouteOutcome(planId, outcome);
      } catch {
        // started.json still keeps a crash-safe uncertain claim.
      }
      return this.status(planId);
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      if (!claimed && !completed) await lock.release();
    }
  }
}

export function parseOpenCodeVersion(stdout: string): string {
  const matches = [...stdout.matchAll(/v?(\d+\.\d+\.\d+)/g)];
  const versions = new Set(matches.map((match) => match[1]!));
  const version = [...versions][0];
  if (versions.size !== 1 || !version) throw new Error('Cannot determine the installed OpenCode version');
  return version;
}

export function parseOpenCodeImportOutput(stdout: string): string {
  const match = stdout.trim().match(/^Imported session: (ses_[0-9a-f]{12}[0-9A-Za-z]{14})$/);
  if (!match) throw new Error('OpenCode import did not return one exact target session ID');
  return match[1]!;
}

export function parseOpenCodeModels(stdout: string, providerID: string): string[] {
  const provider = normalizeOpenCodeTargetModel({ providerID, modelID: 'model' }).providerID;
  const prefix = `${provider}/`;
  const lines = stdout
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`OpenCode returned no models for provider ${provider}`);
  const models = lines.map((line) => {
    if (!line.startsWith(prefix)) throw new Error('OpenCode model catalog returned an unexpected provider');
    return normalizeOpenCodeTargetModel({ providerID: provider, modelID: line.slice(prefix.length) }).modelID;
  });
  const unique = [...new Set(models)].sort();
  if (unique.length !== models.length) throw new Error('OpenCode model catalog contains duplicate models');
  return unique;
}

export function isExactOpenCodeSessionNotFound(error: unknown, sessionId: string): boolean {
  const processError = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  if (processError.code !== 1 || processError.killed === true || processError.signal) return false;
  if (String(processError.stdout ?? '').trim()) return false;
  const lines = String(processError.stderr ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length === 2 &&
    lines[0] === `Exporting session: ${sessionId}` &&
    lines[1] === `Error: Session not found: ${sessionId}`
  );
}

export function createOpenCodeNative(
  executable = resolveCli('opencode'),
  sourceEnv: NodeJS.ProcessEnv = process.env,
): OpenCodeNative {
  const env = nativeEnvironment(sourceEnv);
  return {
    version: async () => {
      try {
        const result = await execFileAsync(executable, ['--version'], { env, timeout: 10_000 });
        return parseOpenCodeVersion(result.stdout);
      } catch {
        throw new Error('Cannot determine the installed OpenCode version');
      }
    },
    listModels: async (providerID) => {
      const target = normalizeOpenCodeTargetModel({ providerID, modelID: 'model' });
      try {
        const result = await execFileAsync(executable, ['--pure', 'models', target.providerID], {
          env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
        });
        return parseOpenCodeModels(result.stdout, target.providerID);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('OpenCode ')) throw error;
        throw new Error('OpenCode model catalog lookup failed');
      }
    },
    readSession: async (sessionId, cwd) => {
      try {
        const result = await execFileAsync(executable, ['--pure', 'export', sessionId], {
          cwd, env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
        });
        return JSON.parse(result.stdout) as unknown;
      } catch (error) {
        if (isExactOpenCodeSessionNotFound(error, sessionId)) return null;
        throw new Error('OpenCode official export failed');
      }
    },
    importSession: async (file, cwd) => {
      try {
        const result = await execFileAsync(executable, ['--pure', 'import', file], {
          cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        return parseOpenCodeImportOutput(result.stdout);
      } catch {
        throw new Error('OpenCode official import failed');
      }
    },
  };
}

export function createOfficialOpenCodeImport(): OfficialOpenCodeImport {
  const environment = { ...process.env };
  const home = homedir();
  const db = environment.WATCH_DB;
  if (db === ':memory:') throw new Error('Official imports require a persistent WATCH_DB location');
  const jobsRoot = db ? path.resolve(`${db}.imports`) : path.join(home, '.watch', 'imports');
  const native = createOpenCodeNative(resolveCli('opencode'), environment);
  return new OfficialOpenCodeImport({
    jobs: new ImportJobs(jobsRoot),
    home,
    targetRoot: opencodeNativeDataRoot(environment, home),
    nativeConfigDigest: opencodeNativeConfigDigest(environment),
    native,
    findSource: async (id, cwd) => {
      const found = await resolveById(id, undefined, null);
      return found && found.found.ref.cwd === cwd ? found.found.ref : null;
    },
    parseSource: async (ref) => {
      const adapter = getAdapter(ref.provider);
      if (!adapter || adapter.id === 'opencode') throw new Error('Unsupported OpenCode import source');
      return adapter.parse(ref);
    },
  });
}
