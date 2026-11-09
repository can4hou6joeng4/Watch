import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import { sameDirectorySync } from '../../core/cwd.js';
import { ImportJobs, type ImportOutcome, type ImportPlan } from '../../core/import-jobs.js';
import { resolveCli } from '../../core/platform.js';
import { describePathReadFailureReason, isEmptySessionFileReason, isMissingPathError } from '../../core/read-text.js';
import type { SessionRef } from '../../core/types.js';
import { claudeProjectsDir, encodeClaudeProjectDir } from '../claude/build.js';
import { claudeSessionCwdDetail } from '../claude/index.js';
import { asRecord, connectImportRpc, type ImportRpc, type RpcProfile } from './app-server.js';
import {
  assertCodexDesktopThreadPlacement,
  inspectCodexDesktopProject,
  sameCodexDesktopProject,
  type CodexDesktopProject,
} from './desktop-project.js';
import { CodexProjectBinding } from './project-binding.js';
import { acquireImportTarget, assertImportTarget, assertNativeSqliteHome, assertTargetFile, IMPORT_TARGET_LOCK, inspectImportTarget } from './import-target.js';

const SUPPORTED_VERSION = 'codex-cli 0.153.4';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const execFileAsync = promisify(execFile);
// 用户面文案与仓库其余命令一致用中文：桌面端把它们直接显示在卡片下方，英文会显得像另一个人写的
const WARNINGS = [
  '实验性导入：只导入这一个会话，不选择配置、插件与权限。',
  '工具记录可能降级为文本；附件与完整内容一致性未验证。',
  '本命令未验证桌面端打开或模型继续。',
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
    throw new Error('来源必须是本地 Claude Code 会话');
  }
  let info;
  try {
    info = await lstat(ref.filePath);
  } catch (error) {
    // 这个函数在 prepare 与 confirm 里都要跑：前者还没写盘，后者可能在导入已提交之后（L248 那次复核）。
    // 所以这里只说「这一次没查成」，**不**承诺「本次未写入任何内容」——那句话在后者是假话。
    throw new Error(
      isMissingPathError(error)
        ? `来源会话文件已不存在：${ref.filePath}（预览拿到路径之后被删除或移动了）；请确认这条会话还在，再重新 prepare`
        : `无法读取来源会话文件 ${ref.filePath}：${describePathReadFailureReason(error)}；先修好它的权限或恢复路径，再重新 prepare`,
    );
  }
  if (!info.isFile()) throw new Error(`来源会话必须是普通文件，不能是符号链接：${ref.filePath}`);
  const digest = await digestFile(ref.filePath);
  if (!digest) throw new Error('无法计算来源会话的指纹');
  return digest;
}

async function assertSource(plan: ImportPlan): Promise<void> {
  const current = await fingerprint(plan.source);
  if (current.sha256 !== plan.digest.sha256 || current.sizeBytes !== plan.digest.sizeBytes) {
    throw new Error('来源会话在预览之后已变化；请重新 prepare 并审阅新计划');
  }
}

/**
 * `prepare()` 反查失败时的补充诊断：这个 id 的会话到底在不在别处。
 *
 * 导入按 `encodeClaudeProjectDir(cwd)` 与会话记录里的 cwd 做**字符串**精确比较，于是
 * `--cwd` 只是同一个目录的另一种写法（软链接、`/var` 与 `/private/var` 这类前缀、大小写）时
 * 也一条都找不到，而旧文案只有一句「来源会话不属于指定的项目目录…或确认 --cwd 与当初开这个
 * 会话的工作目录一致后重试」——用户会去核对 `watch sessions --cwd` 与那个字符串一致（它确实
 * 一致），或怀疑自己抄错了会话 id。仓库其余命令（`chain list` / `status` / `adopt` / `switch`）
 * 遇到同一件事都会说「同一个目录的另一种写法」并给出记录里的原字符串，这条写路径此前是唯一
 * 静默的一处。
 *
 * 只做诊断、不改判定：别名这一档仍然失败，因为下方 `findSource` 拿到的 `cwd` 要写进计划并按
 * 原字符串匹配，替用户改写成 realpath 会让计划与原生存储对不上（与 `chain` 一族同一条约定）。
 */
type ElsewhereSession =
  | { kind: 'same-directory'; cwd: string; filePath: string }
  | { kind: 'misplaced'; cwd: string; filePath: string; expectedPath: string }
  | { kind: 'other-directory'; cwd: string; filePath: string }
  | { kind: 'unreadable'; filePath: string; reason: string }
  | { kind: 'none' };

/**
 * 在 `~/.claude/projects` 下逐个项目目录找这个 id 的会话文件。
 *
 * `home` 由调用方从 `deps.home` 传进来，**不要**在这里调 `claudeProjectsDir()`：注入假 deps 的
 * 单测会因此扫到真实 HOME，违反「自动测试不得读取真实 Agent 历史」。
 * 任何读不出来的地方都返回 `{ kind: 'none' }`——诊断读不到时只能沿用原句，不能反过来断言
 * 「别处一定没有」。
 */
async function locateClaudeSessionElsewhere(
  home: string,
  sessionId: string,
  cwd: string,
): Promise<ElsewhereSession> {
  const projectsRoot = path.join(home, '.claude', 'projects');
  let projects: string[];
  try {
    projects = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { kind: 'none' };
  }
  const hits: { filePath: string; cwd: string | null; error?: string }[] = [];
  for (const project of projects) {
    const filePath = path.join(projectsRoot, project, `${sessionId}.jsonl`);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
    } catch {
      continue; // 这个项目目录里没有这个 id（或读不出来）：不是本函数要下的结论
    }
    const detail = await claudeSessionCwdDetail(filePath);
    hits.push({ filePath, cwd: detail.cwd, error: detail.error });
  }
  // 「记录里的 cwd 就是这次给的字符串」但文件躺在别的项目目录：CLI 只按编码路径找，所以同样找不到
  const exact = hits.find((hit) => hit.cwd === cwd);
  if (exact) {
    return {
      kind: 'misplaced',
      cwd,
      filePath: exact.filePath,
      expectedPath: path.join(projectsRoot, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`),
    };
  }
  const same = hits.find((hit) => hit.cwd !== null && sameDirectorySync(hit.cwd, cwd));
  if (same) return { kind: 'same-directory', cwd: same.cwd!, filePath: same.filePath };
  const other = hits.find((hit) => hit.cwd !== null);
  if (other) return { kind: 'other-directory', cwd: other.cwd!, filePath: other.filePath };
  const broken = hits[0];
  if (!broken) return { kind: 'none' };
  return {
    kind: 'unreadable',
    filePath: broken.filePath,
    reason: broken.error ?? '读不出它的工作目录（原因未知）',
  };
}

/**
 * 反查失败时的用户面文案。
 *
 * `none` 逐字保留原句（`tests/cli-import-codex-path-errors.test.ts` 的「来源被删」一档依赖它）；
 * 其余各档换成「到底在哪、下一步是什么」——别名这一档必须**替换**而不是追加，否则同一句里先说
 * 「不属于这个项目」再说「就在同一个目录」，自相矛盾。
 */
function notInProjectMessage(sourceId: string, cwd: string, found: ElsewhereSession): string {
  const what =
    `来源会话不属于指定的项目目录：在 ${cwd} 下没有找到 id 为 ${sourceId} 的 Claude Code 会话` +
    '（导入按目录定位，只在这个项目的会话目录里找）';
  switch (found.kind) {
    case 'same-directory':
      return (
        `来源会话就在同一个目录的另一种写法下（不是「不属于这个项目」）：这个 id 的会话记录的工作目录是 ` +
        `${found.cwd}（${found.filePath}），而 --cwd 给的是 ${cwd}；导入按路径字符串精确匹配` +
        '（符号链接、/var 与 /private/var 这类前缀、大小写都会一条都找不到）——' +
        `把 --cwd 换成 ${found.cwd} 重跑同一条命令（其余参数照旧）——本次未写入任何内容`
      );
    case 'misplaced':
      return (
        `${what}；这个 id 的会话文件确实记录着工作目录 ${cwd}，只是它不在按这个路径编码出来的项目目录里：` +
        `${found.filePath}（那里应该是 ${found.expectedPath}）——把它移回该位置再重试——本次未写入任何内容`
      );
    case 'other-directory':
      return (
        `${what}；这个 id 的会话记录的工作目录是 ${found.cwd}，不是这次的 ${cwd}（${found.filePath}）——` +
        `要导入它请把 --cwd 换成 ${found.cwd} 重跑，或确认是不是抄错了会话 id——本次未写入任何内容`
      );
    case 'unreadable':
      return (
        `${what}；但按这个 id 在 ${found.filePath} 找到了会话文件，只是读不出它记录的工作目录：` +
        `${found.reason}——无法判断它是否属于 ${cwd}，先确认这个文件可读再重试——本次未写入任何内容`
      );
    case 'none':
      return (
        `${what}；可用 watch sessions --cwd ${cwd} 核对会话 id，` +
        '或确认 --cwd 与当初开这个会话的工作目录一致后重试——本次未写入任何内容'
      );
  }
}

function selectedSession(detected: unknown, plan: ImportPlan): Record<string, unknown> {
  const items = asRecord(detected).items;
  if (!Array.isArray(items)) throw new Error('Codex 没有返回可迁移项');
  const matches: Record<string, unknown>[] = [];
  for (const value of items) {
    const item = asRecord(value);
    if (item.itemType !== 'SESSIONS') continue;
    const sessions = asRecord(item.details).sessions;
    if (!Array.isArray(sessions)) throw new Error('Codex 返回的会话迁移列表格式不对');
    for (const value of sessions) {
      const session = asRecord(value);
      if (session.path !== plan.source.filePath || session.cwd !== plan.source.cwd) continue;
      if (item.cwd !== null && item.cwd !== undefined && item.cwd !== '' && item.cwd !== plan.source.cwd) {
        throw new Error('迁移范围与已确认的项目不一致');
      }
      // Reconstruct an allowlisted payload. Never forward other detected setup.
      matches.push({
        itemType: 'SESSIONS', description: 'Import one confirmed Claude Code session', cwd: item.cwd ?? null,
        details: { sessions: [{ path: session.path, cwd: session.cwd }] },
      });
    }
  }
  if (matches.length !== 1) throw new Error('Codex 必须恰好识别出一个匹配的来源会话');
  return matches[0]!;
}

function importedTarget(completion: unknown, importId: string, plan: ImportPlan): string {
  const result = asRecord(completion);
  if (result.importId !== importId || !Array.isArray(result.itemTypeResults) || result.itemTypeResults.length !== 1) {
    throw new Error('导入完成回执的结构不符合预期');
  }
  const group = asRecord(result.itemTypeResults[0]);
  if (group.itemType !== 'SESSIONS' || !Array.isArray(group.failures) || group.failures.length !== 0 ||
    !Array.isArray(group.successes) || group.successes.length !== 1) throw new Error('导入回执显示部分成功或结果异常');
  const entry = asRecord(group.successes[0]);
  if (entry.itemType !== 'SESSIONS' || (entry.source != null && entry.source !== plan.source.filePath) ||
    (entry.cwd != null && entry.cwd !== plan.source.cwd) ||
    typeof entry.target !== 'string' || !UUID.test(entry.target)) throw new Error('导入结果与已确认的会话不一致');
  return entry.target;
}

export class OfficialCodexImport {
  readonly projects: CodexProjectBinding;
  constructor(private deps: Dependencies) { this.projects = new CodexProjectBinding(deps); }

  async prepare(sourceId: string, cwd: string, options: { desktopProject?: boolean } = {}) {
    // 两件事分开说：--cwd 是否绝对路径这条在 runImportCodex 里已先拦过，到这里多半是来源 id 写错，
    // 合成一句「需要 Claude 会话 UUID 与绝对路径 --cwd」会把人引去核对一个本来没问题的路径。
    if (!UUID.test(sourceId)) throw new Error(`来源会话 id 需要 Claude 会话 UUID（8-4-4-4-12 位十六进制），收到: ${sourceId}；可用 watch sessions --cwd <目录> 核对`);
    if (!path.isAbsolute(cwd)) throw new Error(`--cwd 需要绝对路径，收到: ${cwd}`);
    const version = await this.deps.version();
    if (version !== SUPPORTED_VERSION) throw new Error(`实验性导入路径目前只支持 ${SUPPORTED_VERSION}`);
    const source = await this.deps.findSource(sourceId, cwd);
    // `findSource` 已经把「读不出来」单独抛出，所以到这里 source 为 null 是「这个项目目录里没有」；
    // 但「没有」还有两种形状：会话真的在别的目录，以及 `--cwd` 只是同一个目录的另一种写法
    // （软链 / 大小写 / `/var` 前缀）——后者下「不属于这个项目」是假话，交给 `locateClaudeSessionElsewhere()`
    // 分档说清「它在哪、下一步抄什么」。
    if (!source || source.sessionId !== sourceId || source.cwd !== cwd) {
      throw new Error(
        notInProjectMessage(sourceId, cwd, await locateClaudeSessionElsewhere(this.deps.home, sourceId, cwd)),
      );
    }
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
    // 先看这份来源是否已导入过：重复导入会在 Codex 里多出一份会话，预览阶段就要说清
    const prior = await this.deps.jobs
      .priorImports(plan.source, plan.digest, planId)
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const warnings = [
      ...WARNINGS,
      ...('error' in prior
        ? [`读取导入执行日志失败，已跳过重复导入检查：${prior.error}`]
        : [
            ...prior.hits.map((p) =>
              p.sameContent
                ? `这个会话此前已导入到 Codex 线程 ${p.outcome.target?.sessionId ?? 'unknown'}（计划 ${p.id.slice(0, 8)}）；再次导入会在 Codex 里多出一份会话。`
                : `这个会话此前以不同内容导入过（计划 ${p.id.slice(0, 8)}，线程 ${p.outcome.target?.sessionId ?? 'unknown'}），来源此后已经变化。`,
            ),
            // 读不出来的那几份没法判断是不是同一个来源：不能说成「确认没导过」
            ...(prior.skipped.length
              ? [
                  `有 ${prior.skipped.length} 份导入执行日志读不出来，无法确认是否重复导入：${prior.skipped
                    .map((s) => `${s.id.slice(0, 8)}（${s.reason}）`)
                    .join('；')}`,
                ]
              : []),
          ]),
    ];
    return {
      planId, plan, status: outcome?.status ?? (attempted ? 'uncertain' : 'prepared'),
      outcome, warnings, canConfirm: !attempted && plan.target?.policy === 'official-api-target-v1',
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
    if (!previous.plan.target) throw new Error('这份计划早于目标级保护；请重新预览后再导入');
    if (!previous.canConfirm) throw new Error('这次导入已经尝试过；请用 status 查看结果，不要重复写入');
    const { plan } = previous;
    const target = plan.target!;
    if (plan.home !== this.deps.home || plan.codexHome !== this.deps.codexHome || plan.cliVersion !== await this.deps.version()) {
      throw new Error('Codex 版本或数据目录在预览之后已变化');
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
      // 这一步在 claim 之前，所以可以说「未提交导入」；读不出来时只会说「无法确认」，不会谎称一致 / 不一致
      await assertNativeSqliteHome(config, target, '；未提交导入');
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
      if (typeof response.importId !== 'string' || !UUID.test(response.importId)) throw new Error('Codex 没有返回原生导入 ID');
      outcome.importId = response.importId;
      await this.deps.jobs.save(planId, outcome);
      const sessionId = importedTarget(await rpc.completion(response.importId), response.importId, plan);
      // Save the authoritative target even if the following read or source check fails.
      outcome.target = { provider: 'codex', sessionId, cwd: plan.source.cwd, filePath: '' };
      await this.deps.jobs.save(planId, outcome);
      let thread = asRecord(asRecord(await rpc.request('thread/read', { threadId: sessionId, includeTurns: true })).thread);
      if (thread.id !== sessionId || thread.cwd !== plan.source.cwd || typeof thread.path !== 'string' ||
        !path.isAbsolute(thread.path) || !Array.isArray(thread.turns) || thread.turns.length === 0) {
        throw new Error('原生线程元数据与本次导入不一致');
      }
      const targetPath = thread.path;
      await assertTargetFile(target, targetPath);
      if (plan.desktopProject) {
        const turnsBefore = JSON.stringify(thread.turns);
        if (thread.projectId != null && thread.projectId !== plan.desktopProject.nativeProjectId) {
          throw new Error('导入的会话意外属于另一个项目');
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
          throw new Error('导入会话的项目归属验证失败');
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
      throw new Error('Codex Desktop 项目在预览之后已变化；请重新 prepare 并审阅新计划');
    }
  }

  private async assertNativeProject(rpc: ImportRpc, project: CodexDesktopProject, cwd: string): Promise<void> {
    const value = asRecord(asRecord(await rpc.request('project/read', { projectId: project.nativeProjectId })).project);
    if (value.id !== project.nativeProjectId || !Array.isArray(value.roots) ||
      !value.roots.some((root) => asRecord(root).path === cwd)) {
      throw new Error('Codex app-server 的项目已与桌面项目不一致');
    }
  }

  private async listedInProject(rpc: ImportRpc, projectId: string, threadId: string, cwd: string): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = asRecord(await rpc.request('thread/list', {
        projectId, limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}),
      }));
      if (!Array.isArray(result.data)) throw new Error('项目线程列表格式不对');
      const rows = result.data.map(asRecord);
      if (rows.some((row) => row.projectId !== projectId)) throw new Error('原生 app-server 不支持按项目过滤线程');
      if (rows.some((row) => row.id === threadId && row.cwd === cwd)) return true;
      if (result.nextCursor == null) return false;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw new Error('项目线程分页游标异常');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new Error('项目线程列表超过验证页数上限');
  }
}

/** 执行日志根目录；官方导入与只读诊断（`watch doctor`）共用同一套推导，改规则只改这里 */
export function officialImportJournalRoot(home = homedir()): string {
  const db = process.env.WATCH_DB;
  if (db === ':memory:') throw new Error('官方导入需要可持久化的 WATCH_DB 路径（不能用 :memory:）');
  return db ? path.resolve(`${db}.imports`) : path.join(home, '.watch', 'imports');
}

export function createOfficialCodexImport(): OfficialCodexImport {
  const home = homedir();
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(home, '.codex'));
  const root = officialImportJournalRoot(home);
  const executable = resolveCli('codex');
  const env = { ...process.env, CODEX_HOME: codexHome };
  return new OfficialCodexImport({
    jobs: new ImportJobs(root), home, codexHome,
    version: async () => {
      try {
        return (await execFileAsync(executable, ['--version'], { env, timeout: 10_000 })).stdout.trim();
      } catch {
        throw new Error('无法确定本机安装的 Codex CLI 版本');
      }
    },
    findSource: async (id, cwd) => {
      // Scope lookup to one project instead of scanning every Claude transcript.
      const filePath = path.join(claudeProjectsDir(), encodeClaudeProjectDir(cwd), `${id}.jsonl`);
      let info;
      try {
        // 用 `stat` 而不是 `lstat`：这里只看「按这个 id 找得到的是一个能读的会话文件吗」，
        // 符号链接指向的真实文件照样算（下面 `realpath` 会统一到规范路径）。`fingerprint()` 刻意用
        // `lstat` 拒绝符号链接是另一件事——那里要保证重算的摘要是同一个文件，不是同一个链接。
        info = await stat(filePath);
      } catch (error) {
        // 这个目录里没有这个会话是正常的一档（ENOENT / ENOTDIR）：与 `findById` 同一条约定——
        // 只有「找不到」才返回 null。其余是「没查成」，不能返回 null 冒充「这家没有这个会话」，
        // 那会被 prepare() 讲成「不属于指定的项目目录」
        if (isMissingPathError(error)) return null;
        throw new Error(
          `无法确认来源会话 ${id} 是否存在：${describePathReadFailureReason(error)}；本次未写入任何内容`,
        );
      }
      // 路径被同名目录 / 设备文件占住时同样不能返回 null：这个 id 是对的，只是文件被换掉了
      if (!info.isFile()) {
        throw new Error(
          `来源会话 ${id} 的路径现在不是普通文件：${filePath}（被同名目录或设备文件占住了）；` +
            '先恢复该路径再重试——本次未写入任何内容',
        );
      }
      const canonical = await realpath(filePath);
      const detail = await claudeSessionCwdDetail(canonical);
      if (detail.cwd === cwd) return { provider: 'claude', sessionId: id, filePath: canonical, cwd };
      // 内容读得出来、只是不属于这个目录：这才是真正的「不属于指定的项目目录」
      if (detail.cwd !== null) return null;
      // 读不出来（0 字节 / 权限 / 缺 cwd 字段）：claude 侧已经算好了中文原因，原样抛出。
      // 以前这里用 claudeSessionCwd() 丢掉 error，三种完全不同的处境一起塌缩成上面那句假结论。
      // 下一步按档分开：0 字节是内容已经没了（只能从备份恢复），格式 / 权限问题才是「先修好再重试」。
      // `error` 在类型上是可选的（cwd 为 null 时它实际一定存在），兜底一句，免得把 `undefined` 拼进文案。
      const reason = detail.error ?? '读不出它的工作目录（原因未知）';
      const next = isEmptySessionFileReason(reason)
        ? '如果这条会话本该有内容，先从备份恢复该文件（Watch 不会替你重建历史）再重试——本次未写入任何内容'
        : '先确认这个文件的内容可以读取再重试——本次未写入任何内容';
      throw new Error(`无法读取来源会话 ${id} 的内容：${reason}；${next}`);
    },
    connect: (cwd, canonicalHome, profile) => connectImportRpc(executable, cwd, { ...env, CODEX_HOME: canonicalHome }, profile),
  });
}
