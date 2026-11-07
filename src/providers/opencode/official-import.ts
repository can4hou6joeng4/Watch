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
  'OpenCode 1.18.29 官方导入仍属实验性、只覆盖单会话；没有开启任何 UI 入口。',
  '目标模型元数据由显式指定并在模型目录里校验；凭据与模型能否继续对话未经验证。',
  '被中断的工具调用会保留为失败的 tool part；来源里不受支持的内部结构不作保证。',
  'Web、attach 的 TUI、IDE 可见性与原生继续对话仍未验证。',
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
    throw new Error('OpenCode 官方导入不支持用 OPENCODE_DB 覆盖数据库路径：请先取消该环境变量');
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
    throw new Error(`来源会话必须是本地非 OpenCode 会话（provider=${ref.provider}，路径=${ref.filePath}）`);
  }
  if (!(await lstat(ref.filePath)).isFile()) throw new Error(`来源会话必须是普通文件，不能是符号链接：${ref.filePath}`);
  const value = await digestFile(ref.filePath);
  if (!value) throw new Error(`无法读取来源会话的文件摘要（读不出来或内容为空）：${ref.filePath}；请确认文件仍存在且可读`);
  return value;
}

async function assertSource(plan: OpenCodeImportPlan): Promise<void> {
  const current = await fingerprint(plan.source);
  if (current.sha256 !== plan.digest.sha256 || current.sizeBytes !== plan.digest.sizeBytes) {
    throw new Error('来源会话在预览之后已被改动；请重新 prepare 并审阅新计划（旧计划 id 不再可用）');
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
    throw new Error('来源会话的转换结果在预览之后发生变化；请重新 prepare 并审阅新计划');
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
    throw new Error('OpenCode 返回的原生导出与确认的导入不一致；不要重复导入，先查看执行日志');
  }
}

async function assertBoundTarget(plan: OpenCodeImportPlan, deps: Dependencies): Promise<void> {
  if (plan.nativeConfigDigest !== deps.nativeConfigDigest) {
    throw new Error('OpenCode 的原生环境与配置在预览之后已变化；请重新 prepare');
  }
  const current = await inspectOpenCodeImportTarget(deps.targetRoot);
  if (canonical(current) !== canonical(plan.target)) {
    throw new Error('OpenCode 目标目录或配置在预览之后已变化；请重新 prepare');
  }
}

function modelCatalogDigest(models: string[]): string {
  return hash([...models].sort());
}

function assertTargetModelAvailable(target: OpenCodeTargetModel, models: string[]): void {
  if (!models.includes(target.modelID)) {
    throw new Error(`OpenCode 目标模型 ${target.providerID}/${target.modelID} 不在当前模型目录里；请换成目录中已有的模型`);
  }
}

async function assertBoundModel(plan: OpenCodeImportPlan, deps: Dependencies): Promise<void> {
  const models = await deps.native.listModels(plan.targetModel.providerID);
  assertTargetModelAvailable(plan.targetModel, models);
  if (modelCatalogDigest(models) !== plan.modelCatalogDigest) {
    throw new Error('OpenCode 模型目录在预览之后已变化；请重新 prepare');
  }
}

export class OfficialOpenCodeImport {
  constructor(private deps: Dependencies) {}

  async prepare(sourceId: string, cwd: string, requestedTargetModel: OpenCodeTargetModel) {
    if (!sourceId || !path.isAbsolute(cwd)) throw new Error('需要来源会话 ID 与绝对路径的 --cwd');
    const targetModel = normalizeOpenCodeTargetModel(requestedTargetModel);
    const version = await this.deps.native.version();
    if (version !== SUPPORTED_OPENCODE_EXPORT_VERSION) {
      throw new Error(`当前实验路径要求 OpenCode ${SUPPORTED_OPENCODE_EXPORT_VERSION}，与本机版本不符`);
    }
    const models = await this.deps.native.listModels(targetModel.providerID);
    assertTargetModelAvailable(targetModel, models);
    const source = await this.deps.findSource(sourceId, cwd);
    if (!source || source.sessionId !== sourceId || source.cwd !== cwd || source.provider === 'opencode') {
      throw new Error('来源会话与请求的项目（非 OpenCode 工程）不匹配');
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
    if (!previous.canConfirm) throw new Error('这次导入已经尝试过（已有 started.json）；请用 status 查看结果，不要重复写入');
    const { plan } = previous;
    if (plan.home !== this.deps.home || plan.cliVersion !== await this.deps.native.version()) {
      throw new Error('OpenCode 版本或数据目录在预览之后已变化；请重新 prepare');
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
        throw new Error('目标会话 ID 已存在，本次没有提交导入；请重新 prepare 得到新的计划');
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
        throw new Error('OpenCode 返回的导入会话 ID 不符合预期；不要重复导入，先查看执行日志');
      }
      outcome.target = {
        provider: 'opencode',
        sessionId: importedId,
        cwd: plan.source.cwd,
        filePath: path.join(plan.target.path, 'opencode.db'),
      };
      await this.deps.jobs.saveRouteOutcome(planId, outcome);
      const native = await this.deps.native.readSession(importedId, plan.source.cwd);
      if (!native) throw new Error('导入后的 OpenCode 会话读不出来（官方导出取不到）；不要重复导入，先检查目标库');
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
  if (versions.size !== 1 || !version) throw new Error('无法确定已安装的 OpenCode 版本（opencode --version 没有输出可识别的版本号）');
  return version;
}

export function parseOpenCodeImportOutput(stdout: string): string {
  const match = stdout.trim().match(/^Imported session: (ses_[0-9a-f]{12}[0-9A-Za-z]{14})$/);
  if (!match) throw new Error('OpenCode 导入没有返回唯一的目标会话 ID');
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
  if (lines.length === 0) throw new Error(`OpenCode 模型目录里没有 provider ${provider} 的模型`);
  const models = lines.map((line) => {
    if (!line.startsWith(prefix)) throw new Error('OpenCode 模型目录里出现了非预期的 provider');
    return normalizeOpenCodeTargetModel({ providerID: provider, modelID: line.slice(prefix.length) }).modelID;
  });
  const unique = [...new Set(models)].sort();
  if (unique.length !== models.length) throw new Error('OpenCode 模型目录里有重复的模型条目');
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
        throw new Error('无法确定已安装的 OpenCode 版本（opencode --version 没有输出可识别的版本号）');
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
        throw new Error('OpenCode 模型目录查询失败');
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
        throw new Error('OpenCode 官方导出失败');
      }
    },
    importSession: async (file, cwd) => {
      try {
        const result = await execFileAsync(executable, ['--pure', 'import', file], {
          cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        return parseOpenCodeImportOutput(result.stdout);
      } catch {
        throw new Error('OpenCode 官方导入失败');
      }
    },
  };
}

export function createOfficialOpenCodeImport(): OfficialOpenCodeImport {
  const environment = { ...process.env };
  const home = homedir();
  const db = environment.WATCH_DB;
  if (db === ':memory:') throw new Error('官方导入需要可持久化的 WATCH_DB 路径（不能用 :memory:）');
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
      if (!adapter || adapter.id === 'opencode') throw new Error('不支持的 OpenCode 导入来源');
      return adapter.parse(ref);
    },
  });
}
