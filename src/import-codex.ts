import path from 'node:path';
import { parseArgs } from 'node:util';
import { createOfficialCodexImport } from './providers/codex/official-import.js';

const IMPORT_BOOLEAN_FLAGS = new Set(['json', 'experimental', 'desktop-project']);
const IMPORT_VALUE_FLAGS = new Set(['cwd', 'project']);
const IMPORT_USAGE_HINT = '--json --experimental --cwd <绝对路径> --project <UUID> --desktop-project（详见 docs/import-codex.md）';
/** 六条子命令：拼错时要照着这张表报「可用」，与 `cmdChain` 的写法一致 */
const IMPORT_ACTIONS = [
  'prepare',
  'confirm',
  'status',
  'project-prepare',
  'project-confirm',
  'project-status',
] as const;
/** 每条子命令缺位置参数时的说法：落到整页用法要用户自己找是哪一条写错 */
const IMPORT_POSITIONAL_HINT: Record<string, string> = {
  prepare: 'prepare 需要一个 Claude 会话 UUID；例：watch import-codex prepare <session-id> --cwd /绝对路径 --experimental',
  confirm: 'confirm 需要一个导入计划 id（watch import-codex prepare 的输出）；例：watch import-codex confirm <plan-id> --experimental',
  status: 'status 需要一个导入计划 id（watch import-codex prepare 的输出）；例：watch import-codex status <plan-id>',
  'project-prepare': 'project-prepare 需要一个导入计划 id 与 --project <UUID>；例：watch import-codex project-prepare <plan-id> --project <uuid> --experimental',
  'project-confirm': 'project-confirm 需要一个项目关联计划 id；例：watch import-codex project-confirm <plan-id> --experimental',
  'project-status': 'project-status 需要一个项目关联计划 id；例：watch import-codex project-status <plan-id>',
};

/**
 * 先按白名单自查一遍参数，再把结果交给 `parseArgs`。
 *
 * 直接让 `parseArgs` 报错会把 Node 的英文原文塞给用户（`Unknown option '--desktop'` /
 * `Option '--cwd' argument is ambiguous.\nDid you forget …`），与这条路径 2026-11-07 起
 * 统一中文的文案不一致，也看不出正确写法。措辞与 `cli-main.ts` 的「未知参数: …」
 * 「--cwd 缺少取值（后面跟着 …）」保持一致。
 */
function validateImportArgs(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') return; // 之后都是位置参数，交给 parseArgs
    if (!arg.startsWith('-') || arg === '-') continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const name = flag.replace(/^-+/, '');
    if (IMPORT_VALUE_FLAGS.has(name)) {
      if (inline !== undefined) continue;
      const next = args[i + 1];
      // 下一个 token 仍是 flag：说明取值漏了，别把它吞成值
      if (next === undefined) throw new Error(`${flag} 缺少取值；可用: ${IMPORT_USAGE_HINT}`);
      if (next.startsWith('-')) throw new Error(`${flag} 缺少取值（后面跟着 ${next}）；可用: ${IMPORT_USAGE_HINT}`);
      i += 1;
      continue;
    }
    if (IMPORT_BOOLEAN_FLAGS.has(name) && flag.startsWith('--')) {
      if (inline === undefined) continue;
      throw new Error(`${flag} 不接受取值，写成 ${flag} 即可；可用: ${IMPORT_USAGE_HINT}`);
    }
    throw new Error(`未知参数: ${arg}；可用: ${IMPORT_USAGE_HINT}`);
  }
}

export async function runImportCodex(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    validateImportArgs(args);
    let parsed;
    try {
      parsed = parseArgs({
        args, allowPositionals: true, strict: true,
        options: { json: { type: 'boolean' }, experimental: { type: 'boolean' }, cwd: { type: 'string' }, project: { type: 'string' }, 'desktop-project': { type: 'boolean' } },
      });
    } catch (error) {
      // 兜底：白名单没覆盖到的解析错误（如 Node 版本差异）同样不能把英文原文抛给用户
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
        throw new Error(`参数不合法（${code}）；可用: ${IMPORT_USAGE_HINT}`);
      }
      throw error;
    }
    const { values, positionals } = parsed;
    const [action, id] = positionals;
    // 子命令拼错与「少给位置参数」以前落到同一条整页用法：用户得逐字比对六条子命令才知道
    // `prepr` 是 `prepare` 打错，还是确实少给了一个参数。两种分开说，与 `cmdChain` 对齐。
    if (action && !(IMPORT_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `未知的 import-codex 子命令: ${action}；可用: ${IMPORT_ACTIONS.join(' / ')}（详见 docs/import-codex.md）`,
      );
    }
    if (!action) {
      throw new Error(
        `缺少 import-codex 子命令；可用: ${IMPORT_ACTIONS.join(' / ')}（详见 docs/import-codex.md）`,
      );
    }
    if (!id) {
      throw new Error(IMPORT_POSITIONAL_HINT[action] ?? `import-codex ${action} 需要一个位置参数`);
    }
    if (positionals.length > 2) {
      throw new Error(
        `import-codex ${action} 只需要一个位置参数，多给了 ${positionals.length - 2} 个: ${positionals.slice(2).join(' ')}；可用: ${IMPORT_USAGE_HINT}`,
      );
    }
    // 写操作同时缺多个参数时只报一个，会让人改两轮才走到终点：一次说全，
    // 但「只缺一个」时仍各说各的，不把已经给对的参数一起指认
    if (action === 'prepare' || action === 'project-prepare') {
      const missing: string[] = [];
      if (!values.experimental) missing.push('--experimental（写操作必须显式确认）');
      if (action === 'project-prepare') {
        if (!values.project) missing.push('--project <UUID>');
      } else if (!values.cwd || !path.isAbsolute(values.cwd)) {
        missing.push(
          values.cwd ? `--cwd 需要绝对路径，收到: ${values.cwd}` : '--cwd <绝对路径>',
        );
      }
      if (missing.length) {
        const example = action === 'prepare'
          ? `watch import-codex prepare ${id} --cwd /绝对路径 --experimental`
          : `watch import-codex project-prepare ${id} --project <uuid> --experimental`;
        throw new Error(`${action} 缺少必需的参数：${missing.join('、')}；例：${example}`);
      }
    } else if (!values.experimental && action !== 'status' && action !== 'project-status') {
      // 只剩 confirm / project-confirm 走到这里：只缺 --experimental 一项，谈不上「改两轮」，
      // 但仍要给一句可以直接照着敲的写法——「请先阅读 docs/import-codex.md」等于没说下一步
      throw new Error(
        `${action} 需要 --experimental（写操作必须显式确认）；例：watch import-codex ${action} ${id} --experimental`,
      );
    }
    // 参数用错子命令时说「参数用错」，不能说计划状态：`status` 是只读的，连计划都还没找到，
    // 旧文案「已确认的计划已经绑定工作目录，不要再覆盖」把用户的注意力引去查导入日志 / 目标锁。
    // 每条都指名「哪个子命令不接受哪个参数」并给出可照抄的下一步。
    if (action !== 'prepare' && values.cwd) {
      throw new Error(
        `import-codex ${action} 不接受 --cwd（只有 prepare 用它绑定工作目录，其他子命令的计划在 prepare 时就已确定目录）；去掉 --cwd 重跑：watch import-codex ${action} ${id}`,
      );
    }
    if (action !== 'prepare' && values['desktop-project']) {
      throw new Error(
        `import-codex ${action} 不接受 --desktop-project（只有 prepare 接受）；去掉它重跑：watch import-codex ${action} ${id}`,
      );
    }
    if (action !== 'project-prepare' && values.project) {
      throw new Error(
        `import-codex ${action} 不接受 --project（只有 project-prepare 接受）；要按项目导入请改用 watch import-codex project-prepare ${id} --project <UUID> --experimental，否则去掉 --project 重跑`,
      );
    }
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
