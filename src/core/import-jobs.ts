import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, type FileDigest } from './atomic.js';
import { escapeControlChars } from './display.js';
import type { SessionRef } from './types.js';
import type { ImportTarget } from '../providers/codex/import-target.js';
import type { CodexDesktopProject } from '../providers/codex/desktop-project.js';

export type ImportPlan = {
  schema: 1;
  route: 'claude-code-to-codex-official';
  source: SessionRef;
  digest: FileDigest;
  cliVersion: string;
  codexHome: string;
  home: string;
  target?: ImportTarget;
  desktopProject?: CodexDesktopProject;
};

export type ImportOutcome = {
  status: 'imported' | 'uncertain';
  importId?: string;
  target?: SessionRef;
  code?: string;
  sourceUnchanged?: boolean;
  nativeRead?: 'metadata-only';
  desktopProject?: {
    legacyProjectId: string;
      nativeProjectId: string;
      membershipVerified: true;
      visibilityPreflightVerified: true;
    };
};

export type ProjectBindingPlan = {
  schema: 1;
  route: 'codex-project-association';
  importPlanId: string;
  thread: SessionRef;
  projectId: string;
  projectName: string;
  historyDigest: string;
  target: ImportTarget;
  home: string;
  codexHome: string;
  cliVersion: string;
};

export type ProjectBindingOutcome = {
  status: 'associated' | 'uncertain';
  threadId: string;
  projectId: string;
  code?: string;
  membershipVerified?: boolean;
  historyUnchanged?: boolean;
};

export type ImportJobPlan = { schema: number; route: string };

export type ImportJournalStatus = 'imported' | 'associated' | 'uncertain' | 'prepared';

export function importPlanId(plan: ImportJobPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/**
 * 读取执行日志文件时的非 ENOENT 失败。裸 `ENOTDIR: not a directory, open '…'` /
 * `EACCES: permission denied` 只会出现在 `watch doctor` 的「读取失败」行里，
 * 既不说是哪一种情况，也不给下一步。这里按常见的 errno 翻成「哪里坏了 + 怎么办」。
 */
function describeReadError(error: unknown, file: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOTDIR') {
    return `日志路径上的某一级不是目录（被同名文件占住了？）：${file}；删掉占用它的文件后重试，或按下面的 id 手动核对`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `没有权限读取执行日志（权限或归属变了？）：${file}`;
  }
  if (code === 'EISDIR') {
    return `该路径是目录而不是日志文件：${file}`;
  }
  return `${error instanceof Error ? error.message : String(error)}：${file}`;
}

/** An exclusive, persistent claim survives crashes. Never erase it to retry a write. */
export class ImportJobs {
  constructor(private root: string) {}

  private dir(id: string): string {
    // 直接跑 CLI 时 id 是人眼从 prepare 输出里复制的：格式不对与「计划不存在」要分开说，
    // 否则用户会去翻日志找一份根本不存在的计划
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error(`导入计划 id 需要 64 位小写十六进制（sha256），收到: ${escapeControlChars(id)}`);
    }
    return path.join(this.root, id);
  }

  /** 文件不存在返回 null（执行日志里「还没写」是正常状态），其它读取失败照常抛出 */
  private async readText(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(describeReadError(error, file));
    }
  }

  /** 写了一半或被外部改动时，裸 SyntaxError 既不说是哪个文件也不说下一步 */
  private parseJson<T>(raw: string, file: string, what: string, hint: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${what}无法解析（可能上次只写了一半，或被外部改动）：${file}；${hint}`);
    }
  }

  private async exclusive(file: string, value: unknown): Promise<void> {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async persistPlan(plan: ImportJobPlan): Promise<string> {
    const id = importPlanId(plan);
    await mkdir(this.dir(id), { recursive: true, mode: 0o700 });
    try {
      await this.exclusive(path.join(this.dir(id), 'plan.json'), plan);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return id;
  }

  async prepare(plan: ImportPlan): Promise<string> {
    const id = await this.persistPlan(plan);
    // Incomplete/tampered plans fail closed, including a concurrent partial write.
    await this.plan(id);
    return id;
  }

  async prepareProject(plan: ProjectBindingPlan): Promise<string> {
    const id = await this.persistPlan(plan);
    await this.projectPlan(id);
    return id;
  }

  async prepareRoute<T extends ImportJobPlan>(plan: T): Promise<string> {
    const id = await this.persistPlan(plan);
    await this.routePlan<T>(id, plan.route, plan.schema);
    return id;
  }

  async routePlan<T extends ImportJobPlan>(id: string, route: string, schema = 1): Promise<T> {
    const file = path.join(this.dir(id), 'plan.json');
    const raw = await this.readText(file);
    if (raw === null) throw new Error(`找不到 ${route} 计划 ${id}：${file} 不存在`);
    const plan = this.parseJson<T>(raw, file, `导入计划 ${id} 的 plan.json `, '可删除该日志目录后重新 prepare（会得到新的计划 id）');
    if (importPlanId(plan) !== id || plan.schema !== schema || plan.route !== route) {
      throw new Error('导入计划与确认的路径不匹配');
    }
    return plan;
  }

  async saveRouteOutcome<T>(id: string, outcome: T): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  async routeOutcome<T>(id: string): Promise<T | null> {
    const file = path.join(this.dir(id), 'outcome.json');
    const raw = await this.readText(file);
    // 还没有结果时返回 null 是正常状态；文件存在但读不出来才是异常
    return raw === null ? null : this.parseJson<T>(raw, file, `导入执行结果 ${id} 的 outcome.json `, '结果以同目录的 started.json 与目标锁为准，不要重复导入，也不要删除日志');
  }

  async projectPlan(id: string): Promise<ProjectBindingPlan> {
    const file = path.join(this.dir(id), 'plan.json');
    const raw = await this.readText(file);
    if (raw === null) {
      throw new Error(`找不到项目关联计划 ${id}：${file} 不存在（计划 id 来自 watch import-codex project-prepare 的输出）`);
    }
    const plan = this.parseJson<ProjectBindingPlan>(raw, file, `项目关联计划 ${id} 的 plan.json `, '可删除该日志目录后重新 prepare（会得到新的计划 id）');
    if (importPlanId(plan) !== id || plan.schema !== 1 || plan.route !== 'codex-project-association') {
      throw new Error('项目关联计划与确认的 id 不匹配');
    }
    return plan;
  }

  async saveProject(id: string, outcome: ProjectBindingOutcome): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  async projectOutcome(id: string): Promise<ProjectBindingOutcome | null> {
    const file = path.join(this.dir(id), 'outcome.json');
    const raw = await this.readText(file);
    return raw === null ? null : this.parseJson<ProjectBindingOutcome>(raw, file, `项目关联结果 ${id} 的 outcome.json `, '结果以同目录的 started.json 与目标锁为准，不要重复导入，也不要删除日志');
  }

  async plan(id: string): Promise<ImportPlan> {
    const file = path.join(this.dir(id), 'plan.json');
    // 裸 ENOENT 只说「没有这个文件」，用户看不出下一句该干嘛
    const raw = await this.readText(file);
    if (raw === null) {
      throw new Error(`找不到导入计划 ${id}：${file} 不存在（计划 id 来自 watch import-codex prepare 的输出）`);
    }
    const plan = this.parseJson<ImportPlan>(raw, file, `导入计划 ${id} 的 plan.json `, '可删除该日志目录后重新 prepare（会得到新的计划 id）');
    if (importPlanId(plan) !== id || plan.schema !== 1 || plan.route !== 'claude-code-to-codex-official') {
      throw new Error(`导入计划与确认的 id 不匹配（plan.json 被改动，或与其他计划混在了一起）：${id}`);
    }
    return plan;
  }

  async attempted(id: string): Promise<boolean> {
    const file = path.join(this.dir(id), 'started.json');
    try {
      await lstat(file);
      return true;
    } catch (error) {
      // 只有 ENOENT 是「还没 claim 过」；ENOTDIR（id 那层被同名文件占住）等读不出来要翻成中文，
      // 否则 status / doctor 只会拿到一句裸 errno，看不出该删哪个文件
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(describeReadError(error, file));
    }
  }

  /**
   * 列执行日志根目录下的条目。只有 ENOENT（还没导入过）是空的；
   * ENOTDIR / EACCES 等读不出来要翻成中文再抛——doctor / status 会把这句话直接显示给用户，
   * 以前抛的是裸 `ENOTDIR: not a directory, scandir '…'`，看不出是哪个路径被什么占住了。
   */
  private async listJournalIds(): Promise<string[]> {
    try {
      return await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(describeReadError(error, this.root));
    }
  }

  async claim(id: string): Promise<void> {
    await this.exclusive(path.join(this.dir(id), 'started.json'), { startedAt: new Date().toISOString() });
  }

  async save(id: string, outcome: ImportOutcome): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  /**
   * 只读汇总全部执行日志的状态。坏目录 / 坏文件逐条跳过（不因一条坏日志整体失败），
   * 但要记进 `skipped`：只报「总数少了」的话，用户不知道少的那些是读不出来还是本来就不存在。
   */
  async listSummary(): Promise<{
    items: { id: string; route: string; status: ImportJournalStatus }[];
    skipped: { id: string; reason: string }[];
  }> {
    const ids = await this.listJournalIds();
    const items: { id: string; route: string; status: ImportJournalStatus }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) continue;
      try {
        // 这里不按 route 分支校验（导入与项目关联共用一份汇总），只确认 id 对得上，
        // 但读取仍走 readText / parseJson：坏日志被跳过时要说清是哪份、下一步做什么
        const file = path.join(this.dir(id), 'plan.json');
        const raw = await this.readText(file);
        if (raw === null) {
          skipped.push({ id, reason: `plan.json 不存在：${file}（日志目录不完整，可删除后重新 prepare）` });
          continue;
        }
        const plan = this.parseJson<ImportJobPlan>(raw, file, '导入日志的 plan.json ', '可删除该日志目录后重新 prepare（会得到新的计划 id）');
        if (importPlanId(plan) !== id) {
          skipped.push({ id, reason: 'plan.json 与目录名不匹配（被改动，或与其他计划混在了一起）' });
          continue;
        }
        if (typeof plan.route !== 'string') {
          skipped.push({ id, reason: 'plan.json 里没有 route 字段（被改动，或来自更早的格式）' });
          continue;
        }
        // outcome() 只做 JSON.parse，没按 route 校验；未知状态一律当 uncertain，不虚报成功
        const outcomeStatus = (await this.outcome(id))?.status as string | undefined;
        const status: ImportJournalStatus =
          outcomeStatus === 'imported' || outcomeStatus === 'associated'
            ? outcomeStatus
            : outcomeStatus || (await this.attempted(id))
              ? 'uncertain'
              : 'prepared';
        items.push({ id, route: plan.route, status });
      } catch (error) {
        // 写了一半或旧格式：跳过，但要说清是这一条读不出来
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { items, skipped };
  }

  /**
   * 同一来源会话此前「已导入」的执行日志。重复导入会在 Codex 里多出一份会话，
   * 所以在预览时就提示；坏日志逐条跳过，不影响新的预览与确认 —— 但必须记进 `skipped`：
   * 静默跳过等于「重复导入检查看起来通过了」，用户会以为没导过，再导一次多出一份。
   * `excludeId` 用来排除当前计划自己（已导入的计划重复看状态不算重复导入）。
   */
  async priorImports(
    source: SessionRef,
    digest: FileDigest,
    excludeId?: string,
  ): Promise<{
    hits: { id: string; outcome: ImportOutcome; sameContent: boolean }[];
    skipped: { id: string; reason: string }[];
  }> {
    const ids = await this.listJournalIds();
    const hits: { id: string; outcome: ImportOutcome; sameContent: boolean }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (id === excludeId || !/^[a-f0-9]{64}$/.test(id)) continue;
      let plan: ImportPlan;
      let outcome: ImportOutcome | null;
      try {
        plan = await this.plan(id);
        outcome = await this.outcome(id);
      } catch (error) {
        // 读不出这一条就说这一条；后面的日志照常检查，不因一条坏日志放弃整次重复导入检查
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!outcome || outcome.status !== 'imported') continue;
      if (plan.source.sessionId !== source.sessionId || plan.source.filePath !== source.filePath) continue;
      hits.push({ id, outcome, sameContent: plan.digest.sha256 === digest.sha256 && plan.digest.sizeBytes === digest.sizeBytes });
    }
    return { hits, skipped };
  }

  async outcome(id: string): Promise<ImportOutcome | null> {
    const file = path.join(this.dir(id), 'outcome.json');
    // 没有 outcome.json 是「还没跑完」的正常状态，不能当成日志损坏
    const raw = await this.readText(file);
    return raw === null ? null : this.parseJson<ImportOutcome>(raw, file, `导入执行结果 ${id} 的 outcome.json `, '结果以同目录的 started.json 与目标锁为准，不要重复导入，也不要删除日志');
  }
}
