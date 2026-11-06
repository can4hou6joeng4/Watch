import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, type FileDigest } from './atomic.js';
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

/** An exclusive, persistent claim survives crashes. Never erase it to retry a write. */
export class ImportJobs {
  constructor(private root: string) {}

  private dir(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid import plan ID');
    return path.join(this.root, id);
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
    const plan = JSON.parse(await readFile(path.join(this.dir(id), 'plan.json'), 'utf8')) as T;
    if (importPlanId(plan) !== id || plan.schema !== schema || plan.route !== route) {
      throw new Error('Import plan does not match the confirmed route');
    }
    return plan;
  }

  async saveRouteOutcome<T>(id: string, outcome: T): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  async routeOutcome<T>(id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'outcome.json'), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async projectPlan(id: string): Promise<ProjectBindingPlan> {
    const plan = JSON.parse(await readFile(path.join(this.dir(id), 'plan.json'), 'utf8')) as ProjectBindingPlan;
    if (importPlanId(plan) !== id || plan.schema !== 1 || plan.route !== 'codex-project-association') {
      throw new Error('Project association plan does not match the confirmed ID');
    }
    return plan;
  }

  async saveProject(id: string, outcome: ProjectBindingOutcome): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  async projectOutcome(id: string): Promise<ProjectBindingOutcome | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'outcome.json'), 'utf8')) as ProjectBindingOutcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async plan(id: string): Promise<ImportPlan> {
    const plan = JSON.parse(await readFile(path.join(this.dir(id), 'plan.json'), 'utf8')) as ImportPlan;
    if (importPlanId(plan) !== id || plan.schema !== 1 || plan.route !== 'claude-code-to-codex-official') {
      throw new Error('Import plan does not match the confirmed ID');
    }
    return plan;
  }

  async attempted(id: string): Promise<boolean> {
    try {
      await lstat(path.join(this.dir(id), 'started.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async claim(id: string): Promise<void> {
    await this.exclusive(path.join(this.dir(id), 'started.json'), { startedAt: new Date().toISOString() });
  }

  async save(id: string, outcome: ImportOutcome): Promise<void> {
    await writeFileAtomic(path.join(this.dir(id), 'outcome.json'), JSON.stringify(outcome) + '\n');
  }

  /** 只读汇总全部执行日志的状态；坏目录 / 坏文件逐条跳过，供诊断命令统计 */
  async listSummary(): Promise<{ id: string; route: string; status: ImportJournalStatus }[]> {
    const ids = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    const items: { id: string; route: string; status: ImportJournalStatus }[] = [];
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) continue;
      try {
        const plan = JSON.parse(await readFile(path.join(this.dir(id), 'plan.json'), 'utf8')) as ImportJobPlan;
        if (importPlanId(plan) !== id || typeof plan.route !== 'string') continue;
        // outcome() 只做 JSON.parse，没按 route 校验；未知状态一律当 uncertain，不虚报成功
        const raw = (await this.outcome(id))?.status as string | undefined;
        const status: ImportJournalStatus =
          raw === 'imported' || raw === 'associated'
            ? raw
            : raw || (await this.attempted(id))
              ? 'uncertain'
              : 'prepared';
        items.push({ id, route: plan.route, status });
      } catch {
        continue; // 写了一半或旧格式：跳过，诊断命令不该因一条坏日志整体失败
      }
    }
    return items;
  }

  /**
   * 同一来源会话此前「已导入」的执行日志。重复导入会在 Codex 里多出一份会话，
   * 所以在预览时就提示；坏日志逐条跳过，不影响新的预览与确认。
   * `excludeId` 用来排除当前计划自己（已导入的计划重复看状态不算重复导入）。
   */
  async priorImports(
    source: SessionRef,
    digest: FileDigest,
    excludeId?: string,
  ): Promise<{ id: string; outcome: ImportOutcome; sameContent: boolean }[]> {
    const ids = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    const prior: { id: string; outcome: ImportOutcome; sameContent: boolean }[] = [];
    for (const id of ids) {
      if (id === excludeId || !/^[a-f0-9]{64}$/.test(id)) continue;
      let plan: ImportPlan;
      let outcome: ImportOutcome | null;
      try {
        plan = await this.plan(id);
        outcome = await this.outcome(id);
      } catch {
        continue; // 旧版本或写了一半的日志：跳过即可，不阻塞预览
      }
      if (!outcome || outcome.status !== 'imported') continue;
      if (plan.source.sessionId !== source.sessionId || plan.source.filePath !== source.filePath) continue;
      prior.push({ id, outcome, sameContent: plan.digest.sha256 === digest.sha256 && plan.digest.sizeBytes === digest.sizeBytes });
    }
    return prior;
  }

  async outcome(id: string): Promise<ImportOutcome | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'outcome.json'), 'utf8')) as ImportOutcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
