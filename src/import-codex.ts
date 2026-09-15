import path from 'node:path';
import { parseArgs } from 'node:util';
import { createOfficialCodexImport } from './providers/codex/official-import.js';

export async function runImportCodex(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: { json: { type: 'boolean' }, experimental: { type: 'boolean' }, cwd: { type: 'string' }, project: { type: 'string' }, 'desktop-project': { type: 'boolean' } },
    });
    const [action, id] = positionals;
    if (positionals.length !== 2 || !id || !['prepare', 'confirm', 'status', 'project-prepare', 'project-confirm', 'project-status'].includes(action!)) {
      throw new Error('Usage: watch import-codex prepare <session-id> --cwd <path> [--desktop-project] | confirm|status <plan-id> or project-prepare <import-plan-id> --project <project-id> | project-confirm|project-status <association-plan-id>; writes require --experimental');
    }
    if (!action!.endsWith('status') && !values.experimental) throw new Error('This route requires --experimental; review docs/import-codex.md first');
    if (action === 'prepare' && (!values.cwd || !path.isAbsolute(values.cwd))) throw new Error('prepare requires an explicit absolute --cwd');
    if (action !== 'prepare' && values.cwd) throw new Error('The confirmed plan already binds the cwd; do not override it');
    if (action !== 'prepare' && values['desktop-project']) throw new Error('--desktop-project is only accepted by prepare');
    if (action === 'project-prepare' && !values.project) throw new Error('project-prepare requires an explicit --project UUID');
    if (action !== 'project-prepare' && values.project) throw new Error('--project is only accepted by project-prepare');
    const service = createOfficialCodexImport();
    const result = action === 'prepare'
      ? await service.prepare(id, values.cwd!, { desktopProject: values['desktop-project'] })
      : action === 'confirm' ? await service.confirm(id)
        : action === 'project-prepare' ? await service.projects.prepare(id, values.project!)
          : action === 'project-confirm' ? await service.projects.confirm(id)
            : action === 'project-status' ? await service.projects.status(id) : await service.status(id);
    const ok = result.status !== 'uncertain';
    if (json) console.log(JSON.stringify({ ok, ...result }));
    else {
      console.log(`Plan: ${result.planId}\nStatus: ${result.status}`);
      if ('thread' in result.plan) console.log(`Thread: ${result.plan.thread.sessionId}\nProject: ${result.plan.projectName} (${result.plan.projectId})\nDirectory: ${result.plan.thread.cwd}`);
      else console.log(`Source: ${result.plan.source.sessionId}\nProject: ${result.plan.source.cwd}`);
      if ('evidenceScope' in result && result.status === 'associated') console.log('Recorded association result; live project membership is not queried by status.');
      console.log(`Codex data: ${result.plan.target?.path ?? result.plan.codexHome}`);
      if ('warnings' in result) for (const warning of result.warnings) console.log(`Warning: ${warning}`);
      if (result.canConfirm) console.log(`Review the plan, then explicitly run: watch import-codex ${action!.startsWith('project-') ? 'project-confirm' : 'confirm'} ${result.planId} --experimental`);
      if (result.outcome && 'target' in result.outcome && result.outcome.target) console.log(`Target: ${result.outcome.target.sessionId}`);
      if (!ok) console.log(`Import may have partially completed. Do not repeat it or delete its journal or target lock: ${result.targetLockPath ?? 'unknown'}`);
    }
    if (!ok) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import command failed';
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}
