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
      throw new Error('用法：watch import-codex prepare <session-id> --cwd <绝对路径> [--desktop-project] | confirm|status <plan-id> | project-prepare <import-plan-id> --project <project-id> | project-confirm|project-status <association-plan-id>；写操作需要 --experimental（详见 docs/import-codex.md）');
    }
    if (!action!.endsWith('status') && !values.experimental) throw new Error('这条路径需要 --experimental；请先阅读 docs/import-codex.md');
    if (action === 'prepare' && (!values.cwd || !path.isAbsolute(values.cwd))) throw new Error('prepare 需要显式给出绝对路径 --cwd');
    if (action !== 'prepare' && values.cwd) throw new Error('已确认的计划已经绑定工作目录，不要再覆盖');
    if (action !== 'prepare' && values['desktop-project']) throw new Error('--desktop-project 只接受用于 prepare');
    if (action === 'project-prepare' && !values.project) throw new Error('project-prepare 需要显式给出 --project UUID');
    if (action !== 'project-prepare' && values.project) throw new Error('--project 只接受用于 project-prepare');
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
      console.log(`计划: ${result.planId}\n状态: ${result.status}`);
      if ('thread' in result.plan) console.log(`线程: ${result.plan.thread.sessionId}\n项目: ${result.plan.projectName} (${result.plan.projectId})\n目录: ${result.plan.thread.cwd}`);
      else console.log(`来源: ${result.plan.source.sessionId}\n项目目录: ${result.plan.source.cwd}`);
      if ('evidenceScope' in result && result.status === 'associated') console.log('这里只记录关联结果；status 不查询实时项目成员关系。');
      console.log(`Codex 数据目录: ${result.plan.target?.path ?? result.plan.codexHome}`);
      if ('warnings' in result) for (const warning of result.warnings) console.error(`警告: ${warning}`);
      if (result.canConfirm) console.log(`审阅计划后，显式执行：watch import-codex ${action!.startsWith('project-') ? 'project-confirm' : 'confirm'} ${result.planId} --experimental`);
      if (result.outcome && 'target' in result.outcome && result.outcome.target) console.log(`目标: ${result.outcome.target.sessionId}`);
      if (!ok) console.log(`导入可能已部分完成：不要重复执行，也不要删除执行日志或目标锁：${result.targetLockPath ?? 'unknown'}`);
    }
    if (!ok) process.exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : '导入命令失败';
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}
