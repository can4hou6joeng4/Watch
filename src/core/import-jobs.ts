import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
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

  async outcome(id: string): Promise<ImportOutcome | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'outcome.json'), 'utf8')) as ImportOutcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
