import { createHash } from 'node:crypto';
import path from 'node:path';
import { ImportJobs, type ProjectBindingOutcome, type ProjectBindingPlan } from '../../core/import-jobs.js';
import type { SessionRef } from '../../core/types.js';
import { asRecord, type ImportRpc, type RpcProfile } from './app-server.js';
import { acquireImportTarget, assertImportTarget, assertNativeSqliteHome, assertTargetFile, IMPORT_TARGET_LOCK, inspectImportTarget, type ImportTarget } from './import-target.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Dependencies = {
  jobs: ImportJobs;
  home: string;
  codexHome: string;
  version(): Promise<string>;
  connect(cwd: string, codexHome: string, profile?: RpcProfile): Promise<ImportRpc>;
};

function historyDigest(thread: Record<string, unknown>): string {
  if (!Array.isArray(thread.turns) || thread.turns.length === 0) throw new Error('原生线程历史为空');
  return createHash('sha256').update(JSON.stringify(thread.turns)).digest('hex');
}

// `next` 只在还没 claim 时带「；未提交导入」——`confirm()` 里 claim 之后那次读后复核不能再这么承诺
async function inspectAssociation(rpc: ImportRpc, ref: SessionRef, projectId: string, target: ImportTarget, next = '') {
  const config = asRecord(asRecord(await rpc.request('config/read', { includeLayers: false })).config);
  await assertNativeSqliteHome(config, target, next);
  const project = asRecord(asRecord(await rpc.request('project/read', { projectId })).project);
  if (project.id !== projectId || typeof project.name !== 'string' || !Array.isArray(project.roots) ||
    project.roots.length !== 1 || asRecord(project.roots[0]).path !== ref.cwd) {
    throw new Error('该项目必须只包含被导入会话的工作目录');
  }
  const thread = asRecord(asRecord(await rpc.request('thread/read', { threadId: ref.sessionId, includeTurns: true })).thread);
  if (thread.id !== ref.sessionId || thread.cwd !== ref.cwd || thread.path !== ref.filePath) {
    throw new Error('原生会话身份与导入结果不一致');
  }
  await assertTargetFile(target, ref.filePath);
  if (thread.projectId != null && thread.projectId !== projectId) {
    throw new Error('该会话已属于另一个项目，拒绝迁移');
  }
  return { projectName: project.name, currentProjectId: thread.projectId ?? null, historyDigest: historyDigest(thread) };
}

async function listedInProject(rpc: ImportRpc, projectId: string, ref: SessionRef): Promise<boolean> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = asRecord(await rpc.request('thread/list', { projectId, limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result.data)) throw new Error('项目线程列表格式不对');
    const rows = result.data.map(asRecord);
    if (rows.some((row) => row.projectId !== projectId)) throw new Error('原生 app-server 不支持按项目过滤线程');
    if (rows.some((row) => row.id === ref.sessionId && row.cwd === ref.cwd)) return true;
    if (result.nextCursor == null) return false;
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw new Error('项目线程分页游标异常');
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error('项目线程列表超过验证页数上限');
}

/** Associates an already imported session. This profile cannot import, create projects, or send turns. */
export class CodexProjectBinding {
  constructor(private deps: Dependencies) {}

  async prepare(importId: string, projectId: string) {
    if (!UUID.test(projectId)) throw new Error('需要一个已存在的项目 UUID');
    const importedPlan = await this.deps.jobs.plan(importId);
    const imported = await this.deps.jobs.outcome(importId);
    if (imported?.status !== 'imported' || !imported.target || !importedPlan.target) throw new Error('需要一份已完成的导入');
    const version = await this.deps.version();
    // 三个原因以前合成一句「Codex 数据目录或 CLI 版本与那次完成的导入不一致」：修法完全不同
    // （换版本 / 换回当时那次导入的版本 / 换回当时的 CODEX_HOME），用户无从判断该动哪一个。
    if (version !== 'codex-cli 0.153.4') {
      throw new Error(`后置项目关联只支持 codex-cli 0.153.4，本机检测到 ${version || '（空输出）'}；本次未写入任何内容`);
    }
    if (version !== importedPlan.cliVersion) {
      throw new Error(
        `本机 Codex CLI 版本与那次完成的导入不一致：导入时是 ${importedPlan.cliVersion}，现在是 ${version}；` +
          '先换回该版本的 codex 再重试（本次未写入任何内容）',
      );
    }
    if (this.deps.codexHome !== importedPlan.codexHome) {
      throw new Error(
        `CODEX_HOME 与那次完成的导入不一致：导入时是 ${importedPlan.codexHome}，现在是 ${this.deps.codexHome}；` +
          '用同一个 CODEX_HOME 再重试（本次未写入任何内容）',
      );
    }
    const target = await inspectImportTarget(this.deps.codexHome);
    for (const key of ['path', 'device', 'inode'] as const) {
      if (target[key] !== importedPlan.target[key]) throw new Error('导入时的数据目录已被替换');
    }
    const lock = await acquireImportTarget(target, `project-preview:${importId}`);
    let rpc: ImportRpc | undefined;
    try {
      rpc = await this.deps.connect(imported.target.cwd, target.path, 'project-binding');
      const inspected = await inspectAssociation(rpc, imported.target, projectId, target, '；未提交导入');
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
    if (!previous.canConfirm) throw new Error('这次项目关联已经尝试过；结果未知时不要重复写入');
    const { plan } = previous;
    if (plan.home !== this.deps.home || plan.codexHome !== this.deps.codexHome || plan.cliVersion !== await this.deps.version()) {
      throw new Error('项目关联的环境在预览之后已变化');
    }
    const imported = await this.deps.jobs.outcome(plan.importPlanId);
    if (imported?.status !== 'imported' || JSON.stringify(imported.target) !== JSON.stringify(plan.thread)) {
      throw new Error('那次完成的导入已与本次关联不一致');
    }
    await assertImportTarget(this.deps.codexHome, plan.target);
    const lock = await acquireImportTarget(plan.target, planId);
    let rpc: ImportRpc | undefined;
    let claimed = false;
    let finished = false;
    let outcome: ProjectBindingOutcome = { status: 'uncertain', threadId: plan.thread.sessionId, projectId: plan.projectId };
    try {
      rpc = await this.deps.connect(plan.thread.cwd, plan.target.path, 'project-binding');
      const before = await inspectAssociation(rpc, plan.thread, plan.projectId, plan.target, '；未提交导入');
      if (before.historyDigest !== plan.historyDigest) throw new Error('会话历史在项目预览之后已变化');
      await assertImportTarget(this.deps.codexHome, plan.target);
      await this.deps.jobs.claim(planId);
      claimed = true;
      if (before.currentProjectId !== plan.projectId) {
        await rpc.request('thread/metadata/update', { threadId: plan.thread.sessionId, projectId: plan.projectId });
      }
      // claim 已发生：这里读不出来只能说「无法确认」，不能承诺「未提交导入」
      const after = await inspectAssociation(rpc, plan.thread, plan.projectId, plan.target);
      if (after.currentProjectId !== plan.projectId || after.historyDigest !== plan.historyDigest ||
        !await listedInProject(rpc, plan.projectId, plan.thread)) throw new Error('项目关联验证失败');
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
