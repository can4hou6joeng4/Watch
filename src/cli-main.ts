#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { chainsElsewhereHint, chainsSameDirectoryHint, isStoreError, SEARCH_MAX_HITS, SEARCH_SCAN_LIMIT, searchElsewhereHint, searchSameDirectoryHint, Store, defaultDbPath, describeStoreErrorReason, describeStoreOpenFailure } from './core/store.js';
import type { Chain, SearchElsewhere } from './core/store.js';
import { aliasChainGroupWarning, chainNamesOf, chainsElsewhereOf, newChainName, splitChainsElsewhere } from './core/chain-alias.js';
import { describeFindings } from './core/findings.js';
import { adoptedParseFailureWarning, adoptedSessionReadProblemWarning, adoptIntoChain, blockedHint, chainStatus, chainUsage, collectTips, createChainSession, currentChainShiftNote, describeSourceChangedDuringPrompt, emptyChainBindHint, handoff, HandoffBlockedError, HandoffEmptySourceError, HandoffSourceReadError, notCurrentChainWarning, pickLatestTip, rebindHint, snapshotSourceState, sourceChangeSince, sourceDriftFields, storeUnavailableWarning } from './core/handoff.js';
import { reindexCwd, type SearchCoverage } from './core/search.js';
import type { SessionRef } from './core/types.js';
import type { TokenUsage } from './core/types.js';
import {
  buildHandoffPrompt,
  DEFAULT_PROMPT_PROFILE,
  describePromptSourceReadFailure,
  parsePromptProfile,
  PROMPT_PROFILES,
} from './core/handoff-prompt.js';
import { inspectManifestFilesOnDisk } from './core/manifest-disk.js';
import { collectWorkManifest, isEmptyWorkManifest } from './core/work-manifest.js';
import { handleFatal } from './core/fatal.js';
import { getAdapter, listAdapters, listProviders, noSessionHint, unknownProviderMessage } from './providers/registry.js';
import { checkOpenInProvider, LOOKUP_NEXT_STEP, lookupMissHeadline, openInProvider, openSession, resolveById } from './open.js';
import type { LookupMiss } from './open.js';
import { PreflightBlockedError } from './providers/adapter.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { runImportCodex } from './import-codex.js';
import { ImportJobs } from './core/import-jobs.js';
import { officialImportJournalRoot } from './providers/codex/official-import.js';
import { doctorReport } from './core/doctor.js';
import type { StoreFootprint } from './core/doctor.js';
import { CLAUDE_PROJECT_SETTINGS_RELATIVE_PATHS, type ClaudeRetentionProbe } from './providers/claude/retention.js';
import { cwdAliasHint, cwdProblem, describeCwdProblem, describeRecordedCwd, describeRepoBranchNote, describeWorktreeNote, describeWriteCwd, inspectCwd, inspectRepoBranch, inspectWorktree, sameDirectorySync, splitElsewhereByDirectory, type CwdInspection } from './core/cwd.js';
import { escapeControlChars, hasControlChars } from './core/display.js';
import { isoFromEpochMs } from './core/time.js';
import { BOOLEAN_FLAGS, CHAIN_POSITIONAL, COMMAND_LIST, CWD_UNUSED_COMMANDS, FLAGS_BY_COMMAND, HELP_COMMAND_ALIASES, POSITIONAL_BY_COMMAND, VALUE_FLAGS, VERSION_COMMAND_ALIASES, closestCommand, closestFlag, cwdUnusedNote, optionArgs } from './core/cli-commands.js';
import { commandControlWarnings } from './core/terminal-command.js';
import { trimUserKey } from './core/cli-input.js';
import { describeResumeTargetUnfinished, emptySessionsField } from './core/rich.js';
import { compressedCopy, compressedRetryAdvice, describePathReadFailureReason, describeReadFailureOrSelf, describeSessionReadFailureReason, isEmptySessionFileReason, probeSessionReadable, sessionFilePresence } from './core/read-text.js';
import { describeWriteFailureReason } from './core/atomic.js';
import { collectUnattributable, emptiedJson, emptiedSearchNote, emptiedSessionsWarning, unattributableEmptyNote, unattributableJson, unattributableNoPickMessage, unattributablePickWarning, unattributableSearchNote, unattributableWarning } from './core/session-coverage.js';
import type { EmptiedSession } from './core/session-coverage.js';
import { describeSpawnFailure } from './core/platform.js';
import { usageBadLinesDetail, usageSidecarProblem } from './core/usage-integrity.js';
import { describeBadLinesScanFailure, describeZeroTurnReason, scanUnparsableJsonLines, unparsableLinesField, zeroTurnResumeClaim, type BadLinesScan } from './core/jsonl.js';
import { readWatchVersion } from './core/watch-version.js';
import { CAPABILITY_VERIFICATION_NOTE, describeCapabilities, formatCapabilities } from './core/capabilities.js';
import { formatToolCounts, summarizeSessionStructure } from './core/inspect.js';

/**
 * 参数还没解析完就要报用法错误（缺值 / 越界 / 未知 flag）：此时 `--json` 已经能从 argv 看出来。
 * 用法文本始终走 stderr；带 `--json` 时再补一行 JSON 错误，否则 stdout 为空，
 * Rust 桥只能把整段用法当错误文本显示给桌面端。
 */
/** 全局开关只在 `--` 之前找：之后的 token 是位置参数（见 `optionArgs()`） */
const OPTION_ARGS = optionArgs(process.argv.slice(2));
const JSON_REQUESTED = OPTION_ARGS.includes('--json');
/**
 * 用户是来要用法的，不是写错了参数：`--help` 出现在任意位置，或第一个参数是 `help` / `-h`；
 * 命令之后的 `-h` 在参数解析时补记。要用法是成功路径：用法走 stdout、exit 0（`--json` 回
 * `{ ok:true, help }`），这样 `watch --help | less`、`watch --help | grep search` 才拿得到内容，
 * 脚本里的 `watch --help && …` 也不会被当成失败。写错参数仍是 stderr + exit 1。
 */
let helpRequested = OPTION_ARGS.includes('--help') || HELP_COMMAND_ALIASES.includes(process.argv[2] ?? '');

/**
 * `reason` 用来把「哪里不对」讲清楚：只打一整段用法时，用户得自己翻整页才知道
 * 是命令名拼错了、少了 provider，还是 `--limit` 越界。
 */
function usageText(): string {
  return `用法:
  watch --version [--json]                          打印版本号（读 package.json；读不出来给 null）；watch version / -v 同义
  watch --help                                      打印这页用法；watch help / -h 同义
  watch status [--json] [--cwd <path>] [--chain <id|name>]
  watch switch <provider> [--json] [--cwd <path>] [--chain <id|name>]
  watch adopt <provider> [--json] [--cwd <path>] [--chain <id|name>] [--session <id>]
  watch sessions [--json] [--cwd <path>] [--chain <id|name>]
  watch recent [--json] [--cwd <path>] [--limit <n>]
  watch providers [--json]
  watch capabilities [--json]                       各 Agent 的读写能力矩阵（代码事实，不探测本机 CLI）
  watch prompt [<session-id>] [--provider <name>] [--profile minimal|standard|verbose|full] [--last <n>] [--since-compact] [--json]
                                                    摘要交接：把会话渲染成可粘贴给任意 Agent 的 Markdown（降级方案，不写任何文件）
                                                    省略会话 id 时自动挑本目录按修改时间最新的可读会话，并在文档头标明
  watch inspect <session-id> [--provider <name>] [--json]
                                                    只读查看会话元数据、结构及 JSONL 坏行扫描结果
  watch doctor [--json] [--strict] [--cwd <path>]   环境诊断：Agent 检测、本地库、导入日志（不改动原生会话；本地库不存在时会创建 Watch 本地库）
  watch new <provider> [--json] [--cwd <path>] [--chain <id|name>]
  watch chain list|new <name>|rename <id|name> <new>|archive <id|name>|use <id|name> [--json] [--cwd]
  watch search <query> [--json] [--cwd <path>] [--reset-index]   查询词以 - 开头时写成 watch search -- <query>
  watch usage [--json] [--cwd <path>] [--chain <id|name>]
  watch import-codex prepare|confirm|status <id> [--cwd <path>] [--desktop-project] [--experimental] [--json]
  watch import-codex list [--json]                  只读列出执行日志里的导入计划与状态（不连 Codex）
  watch import-codex project-prepare|project-confirm|project-status <plan-id> [--project <project-id>] [--experimental] [--json]
  watch open <session-id> [--from <session-id>] [--provider <name>] [--to <provider>] [--check] [--json]  反查 cwd 并输出 cd + 打开命令；带 --from 先并入旧会话；带 --to 转入指定 provider；带 --check 预检目标（不改动原生会话，可能更新 Watch 本地会话映射库）`;
}

function usage(reason?: string): never {
  // 带着 reason 进来的一定是用法错误（即使命令行里另有 `--help`）：先报错，不当成「要用法」
  if (helpRequested && !reason) {
    if (JSON_REQUESTED) console.log(JSON.stringify({ ok: true, help: usageText() }));
    else console.log(usageText());
    process.exit(0);
  }
  // 用法错误里插值的是命令行原文（拼错的 flag、多给的位置参数、给了两次的取值）：与路径、链名
  // 同属不可信字符串，进终端前转义；下面的 JSON 保留原值（JSON.stringify 自己会编码控制字符）
  if (reason) console.error(`[watch] ${escapeControlChars(reason)}`);
  console.error(usageText());
  if (JSON_REQUESTED) {
    console.log(
      JSON.stringify({
        ok: false,
        error: reason
          ? `用法错误：${reason}（完整用法见 stderr）`
          : '用法错误：参数不完整或不合法（完整用法见 stderr）',
      }),
    );
  }
  process.exit(1);
}

/**
 * 「参数层就能判定的错误」的统一出口：`--json` 只回一行 `{ ok:false, error }`（保留原值），
 * 文本模式先说原因再打印整页用法。以前这段在三处各写一遍，三处都把命令行原文直接拼进 stderr——
 * `watch status $'--ch\x1b[31main'` 会把 ESC 原样送进终端。
 */
function rejectArguments(json: boolean, message: string): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
  usage(message);
}

function fail(json: boolean, message: string, extra?: Record<string, unknown>): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(escapeControlChars(message));
  process.exit(1);
}

/**
 * 失败输出，并把 `--cwd` 的问题拼在前面。
 *
 * 链名与目录都是精确匹配：目录写错时链同样查不到，只说「找不到链: x」会让人去核对名字。
 * `fail()` 立刻 exit，写在它后面的 `cwdIssue` 永远跑不到，所以失败路径必须走这里。
 */
function failWithCwd(json: boolean, cwdIssue: string | null, message: string): never {
  fail(json, cwdIssue ? `${cwdIssue}；${message}` : message);
}

/**
 * 命令级 `catch` 里把异常变成用户面文案：库故障翻成中文（带原因与下一步），其余原样带出。
 *
 * 以前这些 `catch` 一律 `error instanceof Error ? error.message : String(error)`，于是
 * schema 少一列时 `usage` / `chain *` / `open --to` 直接回裸 `no such column: last_used_at`
 * ——用户既看不出是库的问题，也拿不到「先备份再删三件套重建」这条下一步。同一状态下
 * `status` / `doctor` 早就经 `describeStoreErrorReason()` 说了中文，两条口径互相矛盾。
 * 业务结论（「链已归档」「未发现原生会话」「未知的 chain 子命令」）不走翻译，原样保留。
 */
function describeCommandError(error: unknown): string {
  if (isStoreError(error)) return describeStoreOpenFailure(process.env.WATCH_DB ?? defaultDbPath(), error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「只为记下前后对比」的 `findActiveChain`：读不出来就当没有，并披露一次。
 *
 * `switch` / `adopt` / `new` 都在命令级 `try` **之前**读一次当前链（有的还在成功路径末尾
 * 再读一次），用途只有一个——判断「当前链有没有被换走」这条补充说明。可 schema 少一列时
 * （`no such column: last_used_at`）这一读直接抛，`switch` / `adopt` 那次写在 `try` 外面，
 * 异常逃出 `catch` 落到 `main().catch()`：`--json` 下一行 JSON 都没有，Rust 桥只能回
 * 「CLI 无输出, exit=1」；`new` 的那次在 `try` 里，则会把一次**已经写好了会话**的成功
 * 讲成失败。两种都是让一条补充说明毁掉整条命令，所以这里降级成「没有当前链」并披露。
 */
function safeActiveChain(store: Store | null, cwd: string, warnings: string[]): Chain | null {
  if (!store) return null;
  try {
    return store.findActiveChain(cwd);
  } catch (error) {
    warnings.push(
      `无法读取当前链（${describeStoreErrorReason(error)}）；本次操作照常进行，但不会提示「当前链是否被换走」`,
    );
    return null;
  }
}

/** 写入被拒（目标被占用 / TOCTOU）：统一输出 `blocked:*` 结构；未写入任何内容，可重试 */
function failBlocked(error: HandoffBlockedError | PreflightBlockedError, json: boolean): never {
  const block = error instanceof PreflightBlockedError ? error.block : undefined;
  const code = block?.code ?? (error instanceof HandoffBlockedError ? error.code : 'blocked');
  const hint =
    block?.hint ??
    (error instanceof HandoffBlockedError ? (error.hint ?? blockedHint(error.code)) : blockedHint(code));
  const payload = {
    ok: false,
    error: error.message,
    blocked: true,
    code,
    sessionId:
      error instanceof HandoffBlockedError ? (error.sessionId ?? block?.sessionId) : block?.sessionId,
    holders: block?.holders,
    hint,
  };
  if (json) console.log(JSON.stringify(payload));
  else console.error(`[blocked:${code}] ${escapeControlChars(error.message)}\n${escapeControlChars(payload.hint)}`);
  process.exit(1);
}

/** 来源为空的失败输出：除正文外带 `emptySessions` / `unparsableLines`，与 `open --to` 同口径 */
function failEmptySource(error: HandoffEmptySourceError, json: boolean, prefix: string[] = []): never {
  const message = [...prefix, error.message].filter(Boolean).join('；');
  fail(json, message, {
    emptySessions: error.emptySessions,
    ...(error.unparsableLines ? { unparsableLines: error.unparsableLines } : {}),
  });
}

/** 来源读不出来的失败输出：除正文外带可机读的档位、provider 与文件路径 */
function failSourceRead(error: HandoffSourceReadError, json: boolean, prefix: string[] = []): never {
  const message = [...prefix, error.message].filter(Boolean).join('；');
  fail(json, message, { sourceReadFailure: error.sourceReadFailure });
}

/** 最近一次 openStore 失败的原因；供「需要库」的子命令拼进错误文案 */
let lastStoreError: string | null = null;

/**
 * 本次进程用的是 `WATCH_DB=:memory:`：库在**这一次**命令里完全可用（读得到自己刚写的东西），
 * 但 CLI 每条命令都是一个新进程，命令一结束它就没了——下一次 `chain list` / `status` / `switch`
 * 看到的是全新的空库。`:memory:` 本来是给测试用的（两条官方导入路径已明确拒绝它），
 * 其余路径既不拒绝也不说，用户拿到 `ok:true` 只会以为写进磁盘了。
 */
let ephemeralDb = false;

function openStore(): Store | null {
  const dbPath = process.env.WATCH_DB ?? defaultDbPath();
  ephemeralDb = dbPath === ':memory:';
  try {
    lastStoreError = null;
    return new Store(dbPath);
  } catch (error) {
    // SQLite / mkdir 的原文既不指路径也不说下一步，先翻成中文（`chain` / `search` / `doctor` 都会显示它）
    lastStoreError = describeStoreOpenFailure(dbPath, error);
    console.error('[watch] 打开数据库失败，以降级无库模式继续:', lastStoreError);
    return null;
  }
}

/** 裸「无法打开数据库」不指向任何东西：带上实际路径、失败原因与版本门槛 */
function storeUnavailableError(): string {
  const db = process.env.WATCH_DB ?? defaultDbPath();
  // 具体原因已带路径与下一步（权限 / 库损坏 / 被占用 / schema 比本程序新）；此时再补一句 Node 版本
  // 门槛会把人引去查 Node，而这几类失败与 Node 版本无关
  if (lastStoreError) return `无法打开本地库：${lastStoreError}`;
  return `无法打开本地库 ${db}；可检查路径与权限，Node ≥ 22.13 才提供 node:sqlite`;
}

/**
 * `chainRecordState` 是 core 与命令层之间的协调字段：只描述这次链记录写没写成，
 * 失败原因已经在 `warnings` 里。`--json` 不带它——否则脚本会把它当公开契约，
 * 而它只在部分分支出现（空链分支根本没有这个字段）。
 */
function publicResult<T extends { chainRecordState?: unknown }>(result: T): Omit<T, 'chainRecordState'> {
  const { chainRecordState: _internal, ...rest } = result;
  return rest;
}

/**
 * 写操作（new / switch / adopt）成功时「链记录没写成」的结构化出口。
 *
 * 原生会话已经写好、`ok:true` 也成立，但链记录没落库时后续 `status` / `switch` 不认这次绑定——
 * 以前只有中文 warnings 说这件事，脚本与桌面端得解析文案。两个字段都只在异常时出现：
 * - `storeAvailable: false`：本地库没打开（与 status / sessions / usage / recent 同字段）；
 * - `chainRecordFailed: true`：库打开了、也尝试写了，但写入抛错（只读、磁盘满、SQLITE_BUSY…）。
 * 「本来就不需要写」（alreadyAtTarget / unchanged）不属于这两种，不输出任何字段——
 * 这也是不直接公开三态 `chainRecordState` 的原因。
 */
function chainRecordFields(
  store: Store | null,
  state: 'written' | 'failed' | 'not-attempted' | undefined,
): { storeAvailable?: false; chainRecordFailed?: true } {
  return {
    ...(store ? {} : { storeAvailable: false as const }),
    ...(state === 'failed' ? { chainRecordFailed: true as const } : {}),
  };
}

/**
 * `WATCH_DB=:memory:` 的披露文案，`subject` 说明这条命令本来写进去了什么。
 *
 * 这一档与「库打不开」完全不同：库是好的，`ok:true` 也是真的，只是它随进程消失。
 * 以前写路径一个字都不说——`chain new alpha` 回 `{"ok":true,"chain":{…}}`，下一条
 * `chain list` 是 `{"chains":[]}`，与「链丢了 / 库坏了」长得一模一样，用户会去查库文件。
 */
function ephemeralStoreWarning(subject: string): string {
  return (
    `WATCH_DB 指向 :memory:，本地库只存在于本次进程内（不是磁盘上的库）：${subject}——` +
    '命令一结束这份库里的一切就没了，之后 status / chain list / switch 都看不到它；' +
    '要让它保留下来，去掉 WATCH_DB=:memory: 再重跑（缺省写到 ~/.watch/watch.db）'
  );
}

/**
 * `--cwd` 本身不可用时，列表正文那句「没发现」是**假结论**。
 *
 * 各 provider 都按原生记录的 cwd 字符串精确比较，`--cwd` 只做 `path.resolve()`：路径不存在 / 不是目录
 * 时必然全 0。而 `status` / `sessions` / `recent` / `search` 的空结果分支只看得到「零条」，
 * 于是一边警告「路径不对会全部显示 0」，一边在正文里断言「这个目录没会话」并让人「先开聊」——
 * `--cwd` 指向一个不存在的目录时这一步根本做不到，指向一个普通文件时更荒谬（那句警告自己都写着
 * 「结果不代表任何真实项目」）。原因（按 errno 分档）已由 `cwdProblem()` 那条警告说清，
 * 这里只负责把结论改对、给出真正能解决的下一步。
 */
function cwdUnusableConclusion(subject: string, consequence: string): string {
  return (
    `${subject}；但 --cwd 指向的目录不可用（原因见上方警告），${consequence}——` +
    '先确认并修正 --cwd（换成可用的项目目录，或修好它的访问权限）再重试'
  );
}

/**
 * 结构化 `--cwd` 状态的可选字段：健康目录返回空对象，调用方直接展开。
 *
 * 同一组取值（`missing` / `not-directory` / `denied` / `unknown`，后者附 reason）在七个只读
 * 入口与 `new` 的 `--json` 上共用；抽出来是为了不再各写一遍三元表达式，也避免新增出口时漏掉。
 * 与 `prompt --json` 的 `sourceCwd` 同源（各自保留自己的字段名：那边描述来源记录，这边描述 `--cwd`）。
 */
function cwdStateField(probe: CwdInspection): { cwdState?: CwdInspection } {
  return probe.state !== 'ok' ? { cwdState: probe } : {};
}

/**
 * 列表里的时间格式化。
 *
 * 原生记录里的数值时间戳可能越界（单位写错、字段被写坏）：`new Date(ms).toISOString()`
 * 对超出 ECMAScript 范围（±8.64e15 ms）的值抛 `RangeError: Invalid time value`，文本模式
 * 整条列表直接崩溃退出，而同一份数据的 `--json` 只是原样印出数字，看起来完全正常。
 * 越界时给出可读占位，既不中断列表，也不把 1970-01-01 这种伪造时间当成事实。
 */
function fmtTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '时间不可用（记录里的时间戳越界）';
  return date.toISOString();
}

/**
 * 会话内容（预览 / 搜索片段）进终端前的一道。
 *
 * 预览与片段来自原生会话文件，而会话里什么都可能有：用户粘过一段彩色终端输出、agent 读过
 * 一个带 ANSI 的文件、工具输出里有 `/tmp` 下某个程序的进度条。2026-11-08 实测（修复前）把
 * 一条首条消息含 `\u001b[31mPWNED\u001b[0m` 与 `\u001b]0;hacked\u0007` 的 Claude 会话放进去，
 * `watch recent` 的文本输出原样带出 ESC 与 OSC——也就是**会话内容能改写终端**（改颜色、
 * 改窗口标题、清屏），同 `src/core/display.ts` 里链名那一类问题，只是来源更广。
 *
 * 只改显示、不改数据：`--json` 里的 `preview` / `snippet` 仍是原文（`JSON.stringify` 自己
 * 会转义），会话文件一个字节都不动；这里把「显示时转义过」显式说出来，否则用户会以为
 * 原文里就有 `\u001B` 这几个字符。
 */
function pushEscapedContentWarning(
  warnings: string[],
  items: { provider: string; sessionId: string }[],
  kind: string,
): void {
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const item of items) {
    const key = `${item.provider}:${item.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(key);
  }
  if (!hits.length) return;
  warnings.push(
    `有 ${hits.length} 条会话的${kind}含控制字符（ESC / 换行 / 制表符等，多来自粘进对话的终端输出），文本输出里已转义成 \\n、\\u001B 这类可见形式；` +
      `会话文件本身没有被改动（--json 里仍是原文）：${hits.slice(0, 3).join('、')}${hits.length > 3 ? ' 等' : ''}`,
  );
}

/**
 * 行级 `emptyFile`：`previewError` 只给人读，脚本不该解析中文才知道 0 字节。
 * 判据与 `pushPreviewErrorWarning()` 同源；权限 / I/O 失败不出现该字段。
 */
function withEmptyFileFlag<T extends { previewError?: string }>(item: T): T & { emptyFile?: true } {
  return item.previewError && isEmptySessionFileReason(item.previewError) ? { ...item, emptyFile: true } : item;
}

/**
 * 预览读不出来时不能说成「这条会话没有内容」。
 *
 * 各适配器的预览都是从会话文件**再读一遍**取首条用户消息，以前读失败一律 `catch { return null }`，
 * 于是在 `sessions` / `recent` 里与「会话还没有用户消息」长得一模一样：2026-11-08 实测（修复前）
 * 一条 `chmod 000` 的 Claude 会话在 `sessions --json` 里只有 `{ref, updatedAt}`，既无 preview
 * 也无任何警告，文本模式只少一行预览——而这条文件读不出来意味着 `open` / `switch` 去读它时同样
 * 会失败，用户却以为一切都好。适配器现在把原因放进 `previewError`，这里统一披露。
 */
function pushPreviewErrorWarning(
  warnings: string[],
  items: { provider: string; sessionId: string; previewError?: string }[],
): void {
  const hits = items.filter((s) => s.previewError);
  if (!hits.length) return;
  const detail = (list: typeof hits): string =>
    list
      .slice(0, 3)
      .map((s) => `${s.provider}:${escapeControlChars(s.sessionId)}（${s.previewError}）`)
      .join('、') + (list.length > 3 ? ' 等' : '');
  // 下一步按原因分档：0 字节是内容已经没了，改权限 / 换路径都救不回来；
  // 读不出来（权限、路径）才是「先修好再重试」。同一句混着说，两种人都会走错方向。
  const empty = hits.filter((s) => isEmptySessionFileReason(s.previewError!));
  const denied = hits.filter((s) => !isEmptySessionFileReason(s.previewError!));
  if (empty.length) {
    warnings.push(
      `有 ${empty.length} 条会话的文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${detail(empty)}；` +
        `列表照常列出，但 open / switch 读不出任何内容——这些会话没有可恢复的对话，只能从备份恢复；没有备份就只能重新开一次会话（那是另一条会话）`,
    );
  }
  if (denied.length) {
    warnings.push(
      `有 ${denied.length} 条会话的预览读不出来（不是「这条会话没有内容」，是文件没读成）：${detail(denied)}；` +
        `列表照常列出，但 open / switch 读这条会话时同样会失败——先确认该文件可读（权限、路径）再重试`,
    );
  }
}

/**
 * `--limit` 取值不合法时的说法：把取值**加引号并转义控制字符**，让空白看得见。
 *
 * 以前是一句话把原值直接拼进去：`--limit ' 3 '` 回「--limit 需要 1–50 之间的整数，收到:  3 」——
 * 前后各多一个空格，终端上几乎看不出来，用户看到的仍是「3」，只会反复核对一个**完全正确**的数字
 * （与 2026-11-09 那批 `trimUserKey()` 要修的是同一种「看不见的字符」，只是这里选择**拒绝并对齐
 * 生态**而不是归一：`0x10` 与 ` 3` 一样都是「别猜用户的意思」，见下面 `--limit` 分支的注释）。
 *
 * 生态里同类工具都会让取值**在报错里可辨认**：
 * `git rev-list --max-count ' 2 '` → `fatal: ' 2 ': not an integer`；
 * `gh pr list --limit ' 1 '` → `invalid argument " 1 " for "-L, --limit" flag`；
 * `rg -m ' 1 '` → `value is not a valid number: invalid digit found in string`（实测，2026-11-09）。
 *
 * 分档只为「下一步能照抄」：去掉空白就是合法条数时，唯一的问题就是那串空白，直接给出
 * `--limit <n>` 的正确写法；其余（`3x` / `0x10` / 超范围）仍用原来那句，只把值加引号。
 */
function describeLimitValue(raw: string): string {
  const echoed = `"${escapeControlChars(raw)}"`;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (trimmed !== raw && Number.isInteger(n) && n >= 1 && n <= 50) {
    return (
      `--limit 的取值前后有空白字符，收到: ${echoed}；数字两边不能有空格、制表符或换行——` +
      `写成 --limit ${n} 重试`
    );
  }
  return `--limit 需要 1–50 之间的整数，收到: ${echoed}`;
}

/**
 * `--last <n>` 的错误文案。与 `--limit` 同一口径：接受范围写清楚，带空白时直接给出可照抄的写法，
 * 不给「检查一下参数」这种要用户自己猜的话。
 */
function describeLastValue(raw: string): string {
  const echoed = `"${escapeControlChars(raw)}"`;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (trimmed !== raw && Number.isInteger(n) && n >= 1 && n <= 200) {
    return (
      `--last 的取值前后有空白字符，收到: ${echoed}；数字两边不能有空格、制表符或换行——` +
      `写成 --last ${n} 重试`
    );
  }
  return `--last 需要 1–200 之间的整数（保留最近多少个用户轮），收到: ${echoed}`;
}

function parseArgs(argv: string[]): {
  cmd?: string;
  target?: string;
  extra?: string;
  rest: string[];
  json: boolean;
  cwd: string;
  session?: string;
  chain?: string;
  from?: string;
  provider?: string;
  to?: string;
  profile?: string;
  last?: number;
  sinceCompact: boolean;
  resetIndex: boolean;
  check: boolean;
  strict: boolean;
  limit?: number;
  usedFlags: string[];
  cwdGiven: boolean;
  /** 去掉命令名之后的全部位置参数（含 provider / 链名等）：命令层要数「多给了几条」 */
  positional: string[];
} {
  const args = argv.slice(2);
  const json = optionArgs(args).includes('--json');
  let cwd = process.cwd();
  // 是否显式给了 --cwd：`recent` 的映射表分支只在显式指定时才按目录过滤，
  // 否则桌面桥（不传 cwd）会从「这个目录的会话」退化成「只有 CORE_ROOT 的会话」
  let cwdGiven = false;
  let session: string | undefined;
  let chain: string | undefined;
  let from: string | undefined;
  let provider: string | undefined;
  let to: string | undefined;
  let profile: string | undefined;
  let last: number | undefined;
  let sinceCompact = false;
  let resetIndex = false;
  let check = false;
  let strict = false;
  let limit: number | undefined;
  const positional: string[] = [];
  let i = 0;
  /**
   * 每个取值选项第一次出现的原始取值。
   *
   * 以前 `takeValue()` 每次都 `args[++i]` 覆盖过去，同一个选项给两次时**只有后一个留下来**，
   * 前一个被静默丢掉：2026-11-09 实测（修复前）`watch switch codex --cwd …/proj --cwd …/proj-b`
   * 把内容真写进了 `proj-b` 并 exit 0，而用户的命令里写着两个目录、输出里只有后者，看不出自己
   * 写了两遍；`--session nope --session <真实 id>` / `--chain nope --chain 主力` 同样是前者
   * 无声消失。生态里 `clap` 对每个单值选项默认拒绝第二次（`cannot be used multiple times`），
   * 参数库 `flaget` 的「Report a flag given more than once」也把「keep the last value and drop
   * the first one without a trace」列成缺陷（"a deploy tool that must never guess the target
   * environment"）。布尔开关（`--json` / `--check` / `--strict`）重复是幂等的，不在此列。
   */
  const seenValues = new Map<string, string>();
  /** 当前 token 写成 `--flag=值` 时等号后面的部分；空格写法为 undefined */
  let inlineValue: string | undefined;
  /** 已经遇到过 `--`：之后的 token 不再当选项解析 */
  let afterSeparator = false;
  /** 取下一个 token 作为参数值；缺值、误吞下一个 flag、或同一选项给了两次都按用法错误处理 */
  const takeValue = (flag: string): string => {
    let next: string | undefined;
    if (inlineValue !== undefined) {
      // `--chain=foo`：取值就在等号后面，不再吞下一个 token；值以 `--` 开头也照收（这正是等号写法的用处）
      next = inlineValue;
      if (!next) usage(`${flag} 缺少取值（等号后面是空的）；写成 ${flag} <值> 或 ${flag}=<值>`);
    } else {
      next = args[++i];
      if (!next) usage(`${flag} 缺少取值`);
      // 下一个 token 仍是 flag：说明取值漏了，别把它吞成值
      if (next.startsWith('--')) usage(`${flag} 缺少取值（后面跟着 ${next}）`);
    }
    // 同时说出两个值：只说「不能给两次」的话，用户还得回头翻命令才知道自己写了哪两处
    const first = seenValues.get(flag);
    if (first !== undefined) {
      usage(
        `${flag} 给了两次（第一次: ${first}，第二次: ${next}）；同一个参数只给一次——` +
          `只认后一个、前一个会被静默丢掉，去掉多余的那个后重试`,
      );
    }
    seenValues.set(flag, next);
    return next;
  };
  for (i = 0; i < args.length; i++) {
    let a = args[i]!;
    inlineValue = undefined;
    // `--`：选项到此为止，之后全部是位置参数。以前报「未知参数: --」，于是以 `--` 开头的查询词
    // （`watch search -- --experimental`）没有任何写法能搜；`import-codex` 那条路径一直认这个约定。
    if (afterSeparator) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      afterSeparator = true;
      continue;
    }
    // 等号写法：以前 `--chain=foo` 整个落进「未知参数: --chain=foo」，而 `--chain` 明明是认识的参数，
    // 同一个 CLI 的 `import-codex` 又接受 `--cwd=/path`。取值选项拆成名字 + 取值；布尔开关带等号
    // 时说「不接受取值」，不能把 `--json=1` 当成 `--json` 悄悄放行；不认识的名字照旧走未知参数。
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq !== -1) {
      const name = a.slice(2, eq);
      if (VALUE_FLAGS.includes(name)) {
        inlineValue = a.slice(eq + 1);
        a = a.slice(0, eq);
      } else if (BOOLEAN_FLAGS.includes(name)) {
        usage(`--${name} 不接受取值，写成 --${name} 即可`);
      }
    }
    if (a === '--json') continue;
    // `watch status -h`：以前被当成多余的位置参数。`search` 的查询词是自由文本，不拦
    if (a === '-h' && positional[0] !== 'search') {
      helpRequested = true;
      usage();
    }
    if (a === '--check') {
      check = true;
      continue;
    }
    // 只对 doctor 有意义；其它命令由下方 FLAGS_BY_COMMAND 拒绝，不能静默滑进位置参数
    if (a === '--strict') {
      strict = true;
      continue;
    }
    if (a === '--cwd') {
      cwd = takeValue('--cwd');
      cwdGiven = true;
      continue;
    }
    if (a === '--session') {
      session = takeValue('--session');
      continue;
    }
    if (a === '--chain') {
      chain = takeValue('--chain');
      continue;
    }
    if (a === '--from') {
      from = takeValue('--from');
      continue;
    }
    if (a === '--provider') {
      provider = takeValue('--provider');
      continue;
    }
    if (a === '--to') {
      to = takeValue('--to');
      continue;
    }
    if (a === '--profile') {
      profile = takeValue('--profile');
      continue;
    }
    if (a === '--last') {
      const raw = takeValue('--last');
      // 与 --limit 同一口径：只认十进制整数，前后带空白就明说怎么改，不替用户 trim
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        usage(describeLastValue(raw));
      }
      last = n;
      continue;
    }
    if (a === '--since-compact') {
      sinceCompact = true;
      continue;
    }
    if (a === '--reset-index') {
      resetIndex = true;
      continue;
    }
    if (a === '--limit') {
      const raw = takeValue('--limit');
      // Number() 会接受 '0x10'（16）与 ' 3'（3）：用户只想给十进制条数，别猜他的意思
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        usage(describeLimitValue(raw));
      }
      limit = n;
      continue;
    }
    if (a.startsWith('--')) {
      // 未知 flag 不能滑进位置参数：`watch status --chian foo` 会被当成 cwd 之外的多余位置参数静默忽略
      if (a === '--help') usage();
      const near = closestFlag(a);
      // search 的查询词是自由文本：用户很可能就是想搜这个词，给出能照抄的写法
      const asQuery = positional[0] === 'search' ? `；要搜索这个词本身，写成 watch search -- ${a}` : '';
      rejectArguments(json, `未知参数: ${a}${near ? `；最接近的是 ${near}` : ''}${asQuery}`);
    }
    positional.push(a);
  }
  // 命令层校验要区分「给了但被忽略」与「没给」：takeValue 拒绝空值，所以值存在即代表显式给了
  const usedFlags = [
    ...(check ? ['check'] : []),
    ...(strict ? ['strict'] : []),
    ...(session ? ['session'] : []),
    ...(chain ? ['chain'] : []),
    ...(from ? ['from'] : []),
    ...(provider ? ['provider'] : []),
    ...(to ? ['to'] : []),
    ...(profile ? ['profile'] : []),
    ...(last !== undefined ? ['last'] : []),
    ...(sinceCompact ? ['since-compact'] : []),
    ...(resetIndex ? ['reset-index'] : []),
    ...(limit !== undefined ? ['limit'] : []),
  ];
  return {
    cmd: positional[0],
    target: positional[1],
    extra: positional[2],
    rest: positional.slice(2),
    json,
    // 统一绝对路径：各 provider 的 listSessions / findLatestSession 按记录里的字符串精确比较 cwd，
    // `--cwd .` 或尾部带 / 会静默匹配不到任何会话。path.resolve 幂等，不影响桌面桥传来的绝对路径。
    cwd: path.resolve(cwd),
    session,
    chain,
    from,
    provider,
    to,
    profile,
    last,
    sinceCompact,
    resetIndex,
    check,
    strict,
    limit,
    usedFlags,
    cwdGiven,
    positional: positional.slice(1),
  };
}

async function cmdStatus(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  // 路径写错时各 provider 会安静返回空列表，先把原因放进同一条 warnings 通道。
  // 探测结果留到 JSON 出口（`cwdState`）：只给 warnings 时脚本得解析中文才知道 cwd 不可用
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  let result;
  try {
    result = await chainStatus(cwd, listAdapters(), store, chain, lastStoreError ?? undefined);
  } catch (error) {
    // 链名 / 目录都是精确匹配：目录写错时链同样查不到，失败时也要带出路径原因
    failWithCwd(json, cwdIssue, describeCommandError(error));
  }
  if (cwdIssue) result.warnings.push(cwdIssue);
  // 归属那一行坏了的会话不属于任何目录，所以「最新原生会话」里永远不会出现它们。
  // 与 sessions / recent / doctor 共用一条文案：同一件事在四个入口上不能有两套说法
  const unattributableStats = await collectUnattributable(listAdapters());
  for (const stat of unattributableStats) result.warnings.push(unattributableWarning(stat, cwd));
  // 「这个目录没有链」与「一条链都没建过」原本长得一样：链按 cwd 精确分组，--cwd 指错地方
  // 时正文只有「切换链: （空）」，用户会以为链丢了。别处的链要说出来，并给出可照抄的 --cwd
  const elsewhere = result.chains.length ? [] : chainsElsewhereOf(store, cwd);
  // `:memory:` 时这条命令拿到的是全新的空库：上面那句「本目录 0 条链」是结论，而用户上一句
  // 刚跑过 chain new / switch / adopt——不说清库的性质，就只剩「链丢了 / 库坏了」一种读法
  if (ephemeralDb && !result.chains.length) {
    result.warnings.push(ephemeralStoreWarning('本目录的链与链尾都来自这份临时库，它每条命令都是空的'));
  }
  // 同一个目录的另一种写法单独算：说成「其它目录」会让人以为项目根本没有链
  const splitElsewhere = await splitChainsElsewhere(elsewhere, cwd);
  // 零会话 + `--cwd` 是同一个目录的另一种写法（软链 / 大小写）：正文那句「未发现会话」是结论，
  // 而真正的原因是这个写法与原生记录不一致。只在零结果时补，健康目录不多嘴。
  // 上面已经从库里知道这个目录的另一种写法是什么字符串，用它当下一步（realpath 未必匹配原生记录）
  if (!result.tips.length) {
    // 有几家压根没读成时不能给「换一种写法」：零结果是读取失败造成的，换写法修不好权限 / 库。
    // 「归属读不出来」同理——那些文件连属于哪个目录都不知道，换写法也查不到
    const alias = await cwdAliasHint(cwd, splitElsewhere.same[0]?.cwd, [
      ...result.unreadable,
      ...unattributableStats.map((s) => s.provider),
    ]);
    if (alias) result.warnings.push(alias);
  }
  const elsewhereJson = [...splitElsewhere.same, ...splitElsewhere.other];
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      // 每个命令都接受 `--cwd`，省略时就是进程工作目录：--json 里回显它，
      // 脚本 / 桌面端才不用自己记「这次是在哪个目录跑的」。与 sessions / search / doctor 同一字段
      cwd,
      ...result,
      // `ok:true` + `history:[]` 分不清「链确实没有记录」与「库打不开 / switch_events 读失败」。
      // 文本模式已用「（历史读取失败…）」区分，JSON 也要一个显式字段，桌面端才能渲染失败态。
      historyAvailable: Boolean(store) && !result.historyFailed,
      // `historyAvailable: false` 有两档：库根本没打开（链与切换记录都无从读起），
      // 或库打开了、只是 switch_events 读失败。只有中文警告时脚本分不开；与
      // sessions / usage 的 `storeAvailable` 同一字段，缺省即库已打开
      ...(store ? {} : { storeAvailable: false }),
      ...(elsewhereJson.length ? { chainsElsewhere: elsewhereJson } : {}),
      ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
      // 与 `prompt --json` 的 `sourceCwd` 同一组取值：健康目录不出现，脚本据此把
      // 「本目录没有链 / 没有历史」与「这个 --cwd 根本不可用」分开
      ...cwdStateField(cwdProbe),
    }));
    return;
  }
  const { tips, chainTip, chainTipUnusable, chainTipEmpty, chainTipTurns, unreadable, history, historyFailed, lineage, chain: current, warnings } = result;
  for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
  // 链名是用户输入、库里可能留着写入守卫上线前的坏名字：进终端前转义，别把 ESC / 换行打出去
  if (current) console.log(`链: ${escapeControlChars(current.name)}${current.status === 'archived' ? ' [归档]' : ''}  (${escapeControlChars(current.id)})`);
  // 同一目录可能有多条链：只显示当前这条会让文本用户以为没有别的（--json 的 chains 一直是全量）
  const otherChains = result.chains.filter((c) => c.id !== current?.id);
  if (otherChains.length) {
    const active = otherChains.filter((c) => c.status === 'active').length;
    const archived = otherChains.length - active;
    const parts = [active ? `${active} 条活跃` : '', archived ? `${archived} 条归档` : ''].filter(Boolean);
    console.log(`另有 ${otherChains.length} 条链（${parts.join('、')}）；用 --chain <名或 id> 查看`);
  }
  if (!tips.length && chainTip && chainTipUnusable) {
    // 目录里没有可列出的原生会话，但链上明明绑着一个（链尾）：文件被删、被同名目录占住或读不出来。
    // 以前这里照样说「请先在任一受支持的 Agent 里开聊」，上一行警告刚说链尾文件取不到、
    // 下一行就让人去开新会话，用户会照做，原链于是白白断掉。
    // 具体原因已由警告给出（三档措辞不同），这里只指认链尾并给下一步。
    // 排在 `--cwd` 不可用之前：项目目录被删掉、链尾会话文件却还在 ~/.claude 下是最常见的一种，
    // 这时「链尾记录的是谁、该修哪个文件」比「--cwd 写错了」更对症（两句警告都会打出来）
    // 结论也要按压缩副本分档：只剩 `.jsonl.zst` 时文件并没有丢，「恢复该文件」是错的方向，
    // 正确下一步是让原生重新展开（0 字节副本才是从备份恢复）——上方警告已经说对，这里
    // 跟着说错会让同一屏出现两种下一步（第 356 轮）。只在这一分支写错时才 stat 一次。
    const tipCopy = compressedCopy(await sessionFilePresence(chainTip.ref.filePath));
    const tipNext =
      tipCopy === null ? '可先恢复该文件' : tipCopy.kind === 'empty' ? '只能从备份恢复该文件' : '先让它重新展开';
    console.log(
      `未发现可列出的原生会话；链尾记录的是 ${chainTip.provider} 会话 ${escapeControlChars(chainTip.ref.sessionId)}，` +
        `其文件当前不可用（原因见上方警告）——${tipNext}；或者${rebindHint(chainTip.provider)}`,
    );
  } else if (!tips.length && cwdIssue) {
    // 路径本身不可用（不存在 / 不是目录 / 无权访问）：零结果与「这个目录里有没有会话」无关。
    // 以前这里照样说「请先在任一受支持的 Agent 里开聊」，而那个目录根本不存在——
    // 上一行警告刚说「路径不对会全部显示 0」，下一行就让人去开新会话，方向完全错了
    console.log(cwdUnusableConclusion('未发现可列出的原生会话', '本次结果不能说明这个目录里有没有会话'));
  } else if (!tips.length && unreadable.length) {
    // 有几家的原生存储根本没读成：此时「未发现会话」只是「没列出来」，不是「这个目录没聊过」。
    // 上一行警告刚说「无法确认是否存在」，下一行却让人去开新会话，用户会以为旧会话已经没了
    console.log(
      `未发现可列出的原生会话；但 ${unreadable.join(' / ')} 这次没能读取（原因见上方警告），` +
        '无法确认这个目录里是否还有它们的会话——先修好这些存储（权限、路径或库状态）再重试',
    );
  } else if (!tips.length && unattributableStats.length) {
    // 列表里一条都没有，但库外还有读不出归属的文件：这时「请先开聊」是错的下一步
    console.log(unattributableEmptyNote(unattributableStats) as string);
  } else if (!tips.length) {
    console.log(`未发现会话（${noSessionHint()}）`);
  } else {
    console.log(`cwd: ${escapeControlChars(cwd)}`);
    console.log('');
    console.log('最新原生会话:');
    for (const tip of tips.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const mark =
        chainTip && tip.provider === chainTip.provider && tip.ref.sessionId === chainTip.ref.sessionId
          ? ' ← 链尾'
          : '';
      const chainMark = tip.onChain ? ' 🔗' : '';
      // 文件读不出来时必须标在行上：这一行本身就是「最新原生会话」的推荐，读者不会去猜
      // 一条看起来正常的 mtime 背后打不开（原因已由上方警告给出）。
      // 0 字节单列一档：不是权限问题，内容已经丢了，标成「读不出来」会引去查权限。
      const readMark = tip.unreadable
        ? tip.emptyFile
          ? '（文件是空的，内容已丢失，原因见上方警告）'
          : '（文件读不出来，原因见上方警告）'
        : '';
      // 链尾这一行就是「你的链尾」的推荐：0 轮要说出空会话（原因在上方警告里），
      // 有内容时给出轮数，让「链尾还剩多少」在概览里看得见（`chainTipTurns` 只在 parse 成功时存在，
      // 读不出来 / 解析失败时保持沉默，由上面几档警告承担）
      const emptyMark = mark
        ? chainTipEmpty
          ? '（解析出 0 轮，原因见上方警告）'
          : chainTipTurns !== undefined
            ? `（${chainTipTurns} 轮）`
            : ''
        : '';
      console.log(
        `  ${tip.provider.padEnd(8)} ${escapeControlChars(tip.ref.sessionId)}  mtime=${fmtTime(tip.updatedAt)}${chainMark}${mark}${emptyMark}${readMark}`,
      );
      console.log(`           ${escapeControlChars(tip.ref.filePath)}`);
    }
  }
  if (history.length) {
    console.log('');
    console.log('切换链:');
    for (const h of history) {
      const from = h.fromProvider ?? '?';
      console.log(`  ${from} → ${h.toProvider}  (${escapeControlChars(h.toRef.sessionId)})  @ ${fmtTime(h.createdAt)}`);
    }
    // 只报计数与来源：节点 / 边的原值在 --json 的 lineage 里，文本模式不再铺一张图。
    // 没有节点（历史只有读不出来的损坏记录）时整行省略，不说「0 个会话」。
    if (lineage?.nodes.length) {
      console.log(
        `会话血缘: ${lineage.nodes.length} 个已确认会话${lineage.edges.length ? `，${lineage.edges.length} 条切换边` : ''}（只来自本链记录）`,
      );
    }
  } else if (store) {
    console.log('');
    // `history = []` 有两种来源：链真的没有记录，或 `switch_events` 读失败。后者上方已有
    // warning，但正文这句「（空）」是结论，会把脚本 / 用户引向「本目录没有链记录」。
    console.log(historyFailed ? '切换链: （历史读取失败，无法判断有没有记录）' : '切换链: （空）');
    if (!historyFailed) {
      // 上一行是结论：本目录没有链。别处有链时必须接着指路，否则「（空）」会被当成链没了。
      // 「同一个目录的另一种写法」与「确实是别的目录」分开说，两句话的下一步不同
      if (splitElsewhere.same.length) console.log(chainsSameDirectoryHint(splitElsewhere.same));
      if (splitElsewhere.other.length) console.log(chainsElsewhereHint(splitElsewhere.other));
    }
  }
}

async function cmdSwitch(cwd: string, targetId: string, json: boolean, chain?: string): Promise<void> {
  // provider id 是注册表键（`adapters` 里的 `a.id`：claude / codex / pi / kimi / opencode / grok），
  // 六家全是固定小写、无空白——与链名 / 会话 id 同一类「写入侧从不产生首尾空白」的标识符，
  // 所以对它做 `trimUserKey()` 同样**无损**（见 `src/core/cli-input.ts`）。
  // 不归一的话 `switch " claude "` 会回「未知 provider:  claude ；可用: claude / codex / …」——
  // 清单里正含那个名字，而多出来的空白在终端上几乎看不见，用户只会反复核对一串正确的拼写。
  targetId = trimUserKey(targetId);
  const store = openStore();
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  // 写之前先记下当前链：handoff() 经 getOrCreateChainSession() 调 touchChain() 抬高
  // `--chain` 指定那条的 last_used_at，而「当前链」就是按它算的——写完当前链就换人了。
  // 这一读只为事后对比，读不出来不能让整条命令崩在 try 外面（见 safeActiveChain）
  const chainProbe: string[] = [];
  const previousChain = safeActiveChain(store, cwd, chainProbe);
  try {
    const result = await handoff(targetId, cwd, listAdapters(), getAdapter, store, {
      chainId: chain,
      storeError: lastStoreError ?? undefined,
    });
    // 路径不对时 handoff 只会说「没有可接力的会话」，补上真正的原因
    if (cwdIssue) result.warnings.push(cwdIssue);
    // `:memory:` 时链记录随进程消失：会话内容是真的写进了原生文件的，链上却什么都没留下。
    // `alreadyAtTarget` 本来就不写记录，按「这份库里记不到之前的切换」说，别把它讲成刚写过
    if (ephemeralDb) {
      result.warnings.push(
        ephemeralStoreWarning(
          result.alreadyAtTarget
            ? '这份临时库里记录不到之前的切换（每条命令都是全新的空库）'
            : '本次切换的链记录（链尾 / 切换记录）只在这份临时库里',
        ),
      );
    }
    result.warnings.push(...chainProbe, ...commandControlWarnings(result.resumeCommand ?? ''));
    // 显式写了 --chain 却把当前链换走了，是这条命令最该说的一句：用户的动机恰恰是
    // 「这一次操作那条链，别动当前链」，而输出只有「已从 X 交接 → Y」
    const currentChain = safeActiveChain(store, cwd, result.warnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          ...publicResult(result),
          // 同 new / chain 写操作：内容已经写进目标 provider 的原生文件，但 --cwd 不可用时
          // resume 会在进入该目录时失败；目录的事与「交接是否成功」分开披露
          ...cwdStateField(cwdProbe),
          // 交接已经写进原生文件，但链记录没落库：status / 桌面端不会显示这次切换
          ...chainRecordFields(store, result.chainRecordState),
          ...(shiftNote ? { warnings: [...result.warnings, shiftNote], previousChain, currentChain } : {}),
        }),
      );
      return;
    }
    // 警告先打：alreadyAtTarget 分支同样可能带「读库/写链失败」，提前 return 会把它吞掉
    // 走 stderr：stdout 留给结果，重定向 / 管道时警告不该混进正文（与 status / new / usage 一致）
    for (const warning of result.warnings) console.error(`警告: ${escapeControlChars(warning)}`);
    if (result.alreadyAtTarget) {
      // 链记录里可能根本没有链尾（chain new 之后没切过），也可能读不出来：这时一律说
      // 「链尾已在 X」会让人以为链已经绑到 X，而 status 里还是空的
      let resumeContentNote: string | undefined;
      if (result.resumeParseFailed) {
        resumeContentNote = 'Watch 未能核对会话内容，恢复结果待确认（原因见上方警告）';
      } else if (result.resumeTargetEmpty) {
        const scan = result.unparsableLines?.target;
        const detail = scan?.error
          ? '坏行扫描未完成，恢复结果待确认'
          : scan?.count
            ? `文件有 ${scan.count} 行无法解析，请先核对会话文件`
            : '打开的是空会话';
        resumeContentNote = `这条会话解析出 0 轮，${detail}（原因见上方警告）`;
      }
      const openAdvice = resumeContentNote ?? '可直接打开';
      if (result.chainTipState === 'empty') {
        console.log('当前链还没有绑定任何会话（没有可交接的来源，本次未写入链记录）。');
        console.log(
          result.resumeUnreadable
            ? `已找到 ${targetId} 的最新会话，但它的文件现在读不出来（原因见上方警告）；要让链记录指向它，可用 watch adopt ${targetId} --session ${escapeControlChars(result.newRef.sessionId)}`
            : `已找到 ${targetId} 的最新会话，${openAdvice}；要让链记录指向它，可用 watch adopt ${targetId} --session ${escapeControlChars(result.newRef.sessionId)}`,
        );
      } else if (result.chainTipState === 'recorded') {
        // 链尾确实停在这家，但文件读不出来时「直接打开即可」是错的下一步：
        // 用户照抄的 resume 一执行就失败，而原因写在 stderr 的警告里，正文得先对得上
        console.log(
          result.resumeUnreadable
            ? `链尾已在 ${targetId}，但这条会话的文件现在读不出来，直接打开会失败（原因见上方警告）。`
            : `链尾已在 ${targetId}，${resumeContentNote ?? '直接打开即可'}。`,
        );
      } else {
        console.log(
          result.resumeUnreadable
            ? `无法确认链尾（本次未写入链记录），已找到 ${targetId} 的最新会话，但它的文件现在读不出来（原因见上方警告）。`
            : `无法确认链尾（本次未写入链记录），已找到 ${targetId} 的最新会话，${openAdvice}。`,
        );
      }
      console.log(`resume: ${escapeControlChars(result.resumeCommand)}`);
      return;
    }
    // 零增量时，来源 0 轮会跳过目标写入，已有配对会话仍可能被重写。
    // 链记录写入与会话内容写入各有结果。只有前者确认写成后才能报告链尾已更新。
    const chainTailFailed = result.chainRecordState !== 'written';
    const tailFailure =
      result.chainRecordState === 'failed'
        ? '链记录写入失败，原因见上方警告'
        : '本次没有写入链记录，原因见上方警告';
    if (result.turnCount === 0 && result.zeroIncrementReason === 'source-empty') {
      // parse 跳过坏行后截断文件同样解析出 0 轮：这时正文若说「来源会话没有可交接的内容」，
      // 就把「读不出来」讲成了「本来就没有」。与 alreadyAtTarget 分支同一判据：
      // 只在扫描干净时才断言来源真的空着，坏行 / 扫描未完成按实际情况说。
      const sourceScan = result.unparsableLines?.source;
      const sourceEmptyDetail = sourceScan
        ? sourceScan.count > 0
          ? `来源会话文件有 ${sourceScan.count} 行无法解析${sourceScan.error ? '且扫描未完成' : ''}，内容可能被截断`
          : '来源会话坏行扫描未完成，内容是否完整无法确认'
        : null;
      // 0 字节来源是另一种事实：内容已经没了，下一步是备份恢复，不能与「本来就没内容」共用一句。
      // 以前这层分档只在 stderr 警告里，stdout 的结论仍说「没有可交接的内容」。
      if (result.emptySessions?.source === 'zero-byte') {
        console.log(
          chainTailFailed
            ? `本次未写入会话文件（来源会话的文件是空的，内容已丢失，需要从备份恢复）；但链尾未更新（${tailFailure}）`
            : `已切到 ${targetId}（链尾已更新；来源会话的文件是空的（内容已丢失），本次未写入会话文件——如果这条会话本该有内容，先从备份恢复该文件）`,
        );
      } else {
        console.log(
          sourceEmptyDetail
            ? chainTailFailed
              ? `本次未写入会话文件（${sourceEmptyDetail}）；但链尾未更新（${tailFailure}）`
              : `已切到 ${targetId}（链尾已更新；${sourceEmptyDetail}，本次未写入会话文件）`
            : chainTailFailed
              ? `内容已就位：来源会话没有可交接的内容，本次未写入会话文件；但链尾未更新（${tailFailure}）`
              : `已切到 ${targetId}（链尾已更新；来源会话没有可交接的内容，本次未写入会话文件）`,
        );
      }
    } else if (result.turnCount === 0 && result.zeroIncrementReason === 'up-to-date') {
      const contentResult = result.findings?.some(({ code }) => code === 'handoff.rewrite_only')
        ? '本次重写了目标会话，未追加新轮次'
        : '本次未追加新轮次';
      console.log(
        chainTailFailed
          ? `${contentResult}；链尾未更新（${tailFailure}）`
          : `已切到 ${targetId}（链尾已更新；${contentResult}）`,
      );
    } else {
      console.log(
        `已从 ${result.fromProvider} 交接 → ${targetId}（${result.turnCount} 轮` +
          (chainTailFailed ? `；链尾未更新，${tailFailure}）` : '）'),
      );
    }
    // newRef 也可能是复用的既有会话，不能在回切时标成「新会话」。
    console.log(`目标会话: ${escapeControlChars(result.newRef.sessionId)}`);
    console.log(`文件:   ${escapeControlChars(result.newRef.filePath)}`);
    // 结果说明走 stdout（与 warnings 的降级原因分开）：目标原本是条空会话时，
    // 「这 N 轮就是它的全部内容」是事实，不是错误。
    for (const note of result.notes ?? []) console.log(`\n${escapeControlChars(note)}`);
    console.log('');
    console.log(`resume: ${escapeControlChars(result.resumeCommand)}`);
    // 结果说明走 stdout（同 chain new / chain archive 的位置），不是降级警告
    if (shiftNote) console.log(`\n${shiftNote}`);
    // exact 之外的处置（整文件重写、去重跳过等）--json 里一直有，文本模式也要说，否则看不出内容被改写过
    for (const line of describeFindings(result.findings ?? [])) console.error(`说明: ${line}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 「当前链没读成」只在失败原因本身不是库故障时才补：库坏掉时下面那句已经带原因与下一步
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    // 来源为空是「没有可交接的内容」，不是目标不可写：与 open --to 的失败结果给出同样的
    // emptySessions / unparsableLines，脚本不必解析中文才知道是 0 字节还是可读 0 轮。
    if (error instanceof HandoffEmptySourceError) {
      failEmptySource(error, json, [cwdIssue ?? '', probe].filter(Boolean));
    }
    // 来源根本没读成（缺失 / 只剩压缩副本 / 无权限 / 其它）：与空来源分开给档位，
    // 四档的下一步相反，脚本不解析中文也要能选对恢复动作。
    if (error instanceof HandoffSourceReadError) {
      failSourceRead(error, json, [cwdIssue ?? '', probe].filter(Boolean));
    }
    const message = [probe, describeCommandError(error)].filter(Boolean).join('；');
    // 目录本身有问题时，失败原因先说路径，否则「找不到来源会话」会被当成「目录里没东西」
    fail(json, cwdIssue ? `${cwdIssue}；${message}` : message);
  }
}

async function cmdAdopt(
  cwd: string,
  providerId: string,
  json: boolean,
  sessionId?: string,
  chain?: string,
): Promise<void> {
  // `--session` 的首尾空白在这里去掉：下面 `all.find((s) => s.ref.sessionId === sessionId)`
  // 是精确比较，不归一就会「id 一个字符都没抄错、只是从表格里连空格复制了」却回「找不到会话」。
  // 会话 id 是各家 CLI 生成的 UUID，去掉首尾空白不可能指向另一条会话（见 `src/core/cli-input.ts`）
  if (sessionId !== undefined) sessionId = trimUserKey(sessionId);
  // provider id 同理：注册表键固定小写、无空白，归一无损（与 cmdSwitch 同一段论证）
  providerId = trimUserKey(providerId);
  const store = openStore();
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  // 同 switch：adoptIntoChain() 经 getOrCreateChainSession() 抬高目标链的 last_used_at，
  // 而「当前链」就是按它算的。先记下来，写完如实说明当前链是否被换走。
  // 这一读只为事后对比，读不出来不能让整条写命令崩在 try 外面（见 safeActiveChain）
  const chainProbe: string[] = [];
  const previousChain = safeActiveChain(store, cwd, chainProbe);
  try {
    let targetRef: SessionRef | undefined;
    if (sessionId) {
      const adapter = listAdapters().find((a) => a.id === providerId);
      if (!adapter?.listSessions) throw new Error(unknownProviderMessage(providerId));
      const all = await adapter.listSessions(cwd);
      const hit = all.find((s) => s.ref.sessionId === sessionId);
      if (!hit) {
        // 会话确实存在、只是属于另一个目录时，说「在当前目录找不到」会让人以为 id 写错了。
        // findById 是按 id 全局反查，不受 listSessions 的 cwd 过滤与条数上限影响。
        let elsewhere: string | null = null;
        // `--cwd` 只是同一个目录的另一种写法时记在这里：会话就在这个项目里，
        // 说成「另一个目录」会让人以为 id 抄错了或该去别的项目找
        let sameDirAs: string | null = null;
        let lookupError: string | null = null;
        if (adapter.findById) {
          try {
            const found = await adapter.findById(sessionId);
            if (found && found.ref.cwd !== cwd) {
              if (sameDirectorySync(cwd, found.ref.cwd)) sameDirAs = found.ref.cwd;
              else elsewhere = found.ref.cwd;
            }
          } catch (error) {
            // 反查失败不能静默退成「在当前目录找不到会话」：权限、库损坏会被读成 id 写错或会话不存在。
            // 适配器自己写好的中文原因原样保留（`describePathReadFailureReason` 只翻漏网的 fs errno），
            // 否则这里会漏出 `EACCES: permission denied, scandir '…'`——与 resolveById 同一口径
            lookupError = describePathReadFailureReason(error);
          }
        }
        if (sameDirAs) {
          throw new Error(
            `会话 ${escapeControlChars(sessionId)} 在同一个目录的另一种写法下: ${escapeControlChars(sameDirAs)}；adopt 按 cwd 绑定、按字符串精确匹配，` +
              `把 --cwd 换成 ${sameDirAs} 重跑同一条命令（其余参数照旧）。本次未写入任何内容`,
          );
        }
        if (elsewhere) {
          throw new Error(
            `会话 ${escapeControlChars(sessionId)} 属于另一个目录: ${escapeControlChars(elsewhere)}；adopt 按 cwd 绑定，请用 --cwd ${elsewhere}。本次未写入任何内容`,
          );
        }
        // id 属于另一家 provider 时，「在当前目录找不到」会被读成 id 写错：adopt <provider>
        // 只在这家自己的存储里找，provider 写错（或从 sessions 输出里拿错一行）都会走到这里。
        // 只在原 provider 没找到时才跨家反查，正常路径不多付一次扫描。
        //
        // 别家读不出来既不算命中、也不能当成「这家没有」：静默 `continue` 时，最终那句
        // 「在当前目录找不到会话」会被读成「哪一家都没有这个 id」，用户就去核对那串其实
        // 没错的 uuid 了——而真正要修的是那家的目录权限 / 索引。`open --provider` 早就会补
        // 「另有 N 家没能查（…），无法确认它是否属于那些 provider」（findOwnerElsewhere），
        // 这里以前只有一句结论。收集起来，未命中时一并披露。
        const unreadableOthers: string[] = [];
        for (const other of listAdapters()) {
          if (other.id === providerId || !other.findById) continue;
          let found: Awaited<ReturnType<NonNullable<typeof other.findById>>>;
          try {
            found = await other.findById(sessionId);
          } catch (error) {
            unreadableOthers.push(`${other.id} 反查失败：${describePathReadFailureReason(error)}`);
            continue;
          }
          if (found) {
            throw new Error(
              `会话 ${escapeControlChars(sessionId)} 属于 ${other.id}，不是 ${providerId}；请改用 watch adopt ${other.id} --session ${escapeControlChars(sessionId)}${
                found.ref.cwd === cwd
                  ? ''
                  : sameDirectorySync(cwd, found.ref.cwd)
                    ? `（它在同一个目录的另一种写法下: ${escapeControlChars(found.ref.cwd)}，还要把 --cwd 换成 ${escapeControlChars(found.ref.cwd)}）`
                    : `（它属于另一个目录: ${escapeControlChars(found.ref.cwd)}，还要加 --cwd ${escapeControlChars(found.ref.cwd)}）`
              }`,
            );
          }
        }
        // 列表有上限时，更早的会话根本没被枚举到：直接说「找不到」会让用户以为 id 写错了
        const cap = adapter.listSessionsCap;
        const capped = cap !== undefined && all.length >= cap;
        const lookupNote = lookupError
          ? `；按 id 全局反查也失败：${lookupError}——无法确认它是否属于另一个目录，请先确认该会话存储是否可读`
          : '';
        // 别家没查成时同样不能说成「谁都不认识这个 id」：那会把权限 / 索引问题讲成 id 写错
        const othersNote = unreadableOthers.length
          ? `；另有 ${unreadableOthers.length} 家没能查（${unreadableOthers.join('；')}），无法确认它是否属于那些 provider`
          : '';
        // 链 id 也是 UUID，chain list 里就印在同一行：说清它是链并给出链尾绑定，避免反复核对 id
        const chainUse = store?.describeChainIdMisuse(sessionId, cwd) ?? null;
        // 本地库打不开时上面那步根本做不了——而「是不是链 id」恰恰是这条分支唯一需要库才能排除的
        // 可能。静默跳过就只剩一句「找不到会话」，用户照着去核对那串没抄错的 uuid；同一状态下
        // `status` / `chain list` 早就说了库不可用。这里同样披露，并指明这次没核对成的是什么。
        const storeNote = store
          ? ''
          : `；${storeUnavailableWarning('没法核对这个 id 是不是链 id（链 id 与会话 id 都是 UUID，chain list 里印在同一行）', lastStoreError ?? undefined)}`;
        // `adopt` 是四条按 id 反查的路径里唯一没接共用下一步的那条，也是唯一「多说了一个 id、
        // 提示反而更弱」的那条：不给 `--session` 时 `adoptIntoChain()` 走 `adoptNoSessionMessage()`
        // 有完整指引，给了却掉进这里只剩一句事实。它同样是写路径（会写 switch_events、动链尾），
        // 失败时还要说清没有写入——否则用户不知道链有没有被改过。
        throw new Error(
          (chainUse ? `${chainUse}；` : '') +
            (capped
              ? `在当前目录最近 ${all.length} 个会话里找不到: ${escapeControlChars(sessionId)}（${adapter.id} 列表上限 ${cap}，更早的会话不在其中）`
              : `在当前目录找不到会话: ${escapeControlChars(sessionId)}`) +
            `；${LOOKUP_NEXT_STEP}。本次未写入任何内容` +
            lookupNote +
            othersNote +
            storeNote,
        );
      }
      targetRef = hit.ref;
    }
    const result = await adoptIntoChain(
      providerId,
      cwd,
      listAdapters(),
      store,
      targetRef,
      chain,
      lastStoreError ?? undefined,
    );
    if (cwdIssue) result.warnings.push(cwdIssue);
    // 同 switch：`:memory:` 下链记录随进程消失，而 resume 命令是真的、会话文件也是真的
    if (ephemeralDb) {
      result.warnings.push(
        ephemeralStoreWarning(
          result.unchanged
            ? '这份临时库里记录不到之前的接入（每条命令都是全新的空库）'
            : '本次接入的链记录（链尾 / 切换记录）只在这份临时库里',
        ),
      );
    }
    // 与 switch 对齐：接入之后用户下一步就是打开这个会话，resume 命令不能只给 --json
    const adoptedAdapter = listAdapters().find((a) => a.id === result.adoptedRef.provider);
    const resumeCommand = adoptedAdapter ? adoptedAdapter.resumeCommand(result.adoptedRef) : undefined;
    // 链记录这次到底写没写：`unchanged` 时什么都没写（已绑定 / 自动挑到别条链两条空操作分支都会走到
    // 这里），`recordSwitch` 失败或无库时同样没写；只有 written 才能说「已写入」。下面三处警告都会把
    // 这句话原样带出去，接入一条读不出来 / 空着的会话时说错就是假话（第 310 轮）。
    const chainWriteNote =
      result.unchanged
        ? '这条会话本来就在链上，本次没有改动任何链记录'
        : result.chainRecordState === 'written'
          ? '链记录已写入'
          : '本次未写入链记录（原因见上方警告）';
    // adopt 只写链记录、不读会话内容，所以「文件本身读不出来」在这里一点都看不出来：
    // `sessions` / `recent` 会为同一条会话警告「open / switch 读它时同样会失败」，
    // adopt 却回 ok:true 并给出一条一执行就失败的 resume。`stat` 对 `chmod 000` 照常成功
    // （列目录就能接入），因此接入之后单独 open 一次确认它真的读得出来。
    const readProblem = await probeSessionReadable(result.adoptedRef.filePath);
    // 0 字节与「读不出来」必须分档：空文件打得开、只是内容已经没了，resume 打开的是空会话，
    // 不是「一执行就会失败」。以前共用一个「读不出来 + 注定失败」的结论，把空文件讲成了权限问题。
    const emptyFileReason = readProblem && isEmptySessionFileReason(readProblem) ? readProblem : null;
    // 探完再复查一次压缩副本：probe 对原路径缺失只会说「已不存在」，而只剩 .jsonl.zst 时
    // 文件其实还在，下一步是让原生展开 / 从备份恢复，不是修权限（第 355 轮，与 switch 同口径）。
    // 只在探出问题时 stat，健康会话的 adopt 不多一次 IO。
    const readCompressed = readProblem && !emptyFileReason
      ? compressedCopy(await sessionFilePresence(result.adoptedRef.filePath))
      : null;
    if (emptyFileReason) {
      // 与 warning 同一处判定：脚本不必解析中文才知道接入的是空会话
      result.emptySessions = emptySessionsField(null, 'zero-byte').emptySessions;
      result.warnings.push(
        `会话 ${escapeControlChars(result.adoptedRef.sessionId)}（${adoptedAdapter?.displayName ?? result.adoptedRef.provider}）的${emptyFileReason}；` +
          `${chainWriteNote}，本次没有改动会话文件——resume 打开的是空会话，历史内容已经没有了；` +
          `如果它本该有内容，先从备份恢复这个文件（Watch 不会替你重建历史），或用 watch adopt <provider> --session <会话 id> 换成另一条会话`,
      );
    } else if (readProblem) {
      result.warnings.push(
        adoptedSessionReadProblemWarning(
          `会话 ${escapeControlChars(result.adoptedRef.sessionId)}（${adoptedAdapter?.displayName ?? result.adoptedRef.provider}）`,
          readProblem,
          readCompressed,
          chainWriteNote,
          resumeCommand,
        ),
      );
    }
    // 读得出来也不等于「收尾了」：这条会话可能停在做了一半的工具调用上，或最后一句是用户消息。
    // `open <id>` / `switch` / `new <同一家>` 在同样情况下都会说（第 276–280 轮），只有 adopt
    // 不看内容、还顺手打印 resume——用户照着复制，接手的就是那一轮断掉的地方。这里恒为零增量
    // （adopt 不写任何会话内容），两种形状都要说。
    // 文件本身读不出来已由上面那句说清（resume 一执行就失败），不再重复解析一遍。
    if (!readProblem && adoptedAdapter) {
      try {
        const adoptedTurns = await adoptedAdapter.parse(result.adoptedRef);
        for (const warning of describeResumeTargetUnfinished(
          adoptedTurns,
          `目标会话 ${escapeControlChars(result.adoptedRef.sessionId)}（${adoptedAdapter.displayName}）`,
          0,
        )) {
          result.warnings.push(warning);
        }
        // 读得出来、也解析成功，却 0 轮：`watch new` 建出的合法空会话与「内容被清空、只剩占位头」
        // 都长这样。adopt 不打印轮数，不说这一句时，resume 打开的是空会话这件事在输出里看不出来
        // （0 字节那一档已由上面的空文件警告说清，这里不重复）。
        if (adoptedTurns.length === 0) {
          const subject = `会话 ${escapeControlChars(result.adoptedRef.sessionId)}（${adoptedAdapter.displayName}）`;
          const badScan = await scanUnparsableJsonLines(result.adoptedRef.filePath, { allowMissing: false });
          // 与 warning 同一次扫描：脚本不必解析中文才知道 0 轮背后还有几行坏数据
          result.unparsableLines = unparsableLinesField(null, badScan).unparsableLines;
          result.emptySessions = emptySessionsField(null, 'zero-turns').emptySessions;
          result.warnings.push(
            `${subject} 解析出 0 轮（没有可继续的对话）：` +
              describeZeroTurnReason(
                badScan,
                `可能是刚建出来的空会话，也可能内容已被清空`,
                badScan.error
                  ? ''
                  : (badScan.count === 0
                      ? `${chainWriteNote}，本次没有改动会话文件——resume 打开的是空会话；`
                      : `${chainWriteNote}，本次没有改动会话文件；`) +
                    `如果它本该有历史，先在 ${adoptedAdapter.displayName} 里打开它确认，或从备份恢复该文件（Watch 不会替你重建历史）；` +
                    `如果挑错了会话，用 watch adopt ${result.adoptedRef.provider} --session <另一个会话 id> 换绑`,
              ),
          );
        }
      } catch (error) {
        // 解析不了不等于没问题：至少要说成「没能确认」，不能沉默。
        // 探测与解析之间文件可能刚好被压缩（Codex 压缩闲置线程）：这时只报真实错误会
        // 把下一步引成修权限，先复查一次压缩副本再拼文案（第 355 轮）。
        result.warnings.push(
          adoptedParseFailureWarning(
            result.adoptedRef.sessionId,
            compressedCopy(await sessionFilePresence(result.adoptedRef.filePath)),
            error,
          ),
        );
      }
    }
    result.warnings.push(...chainProbe, ...commandControlWarnings(resumeCommand ?? ''));
    // 同 switch：显式 --chain 却把当前链换走了，必须在结果里说（空操作时链没被 touch，
    // previousChain 与 currentChain 相同，自然不冒这句）
    const currentChain = safeActiveChain(store, cwd, result.warnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      // `warnings` 只放降级原因，`note` 放结果说明（同 open 的 warnings / notes 分法）。
      // `replacedRef` 是「打算替换」的那条：unchanged / 写失败 / 无库时替换没有发生，
      // --json 里照发会让脚本以为链已经从它改绑（第 311 轮）。
      const publicAdopt = publicResult(result);
      const publicJson =
        result.unchanged || result.chainRecordState !== 'written'
          ? (() => {
              const { replacedRef: _planned, ...rest } = publicAdopt;
              return rest;
            })()
          : publicAdopt;
      console.log(
        JSON.stringify({
          ok: true,
          ...publicJson,
          // 同 switch：链记录已经写入 / 目标文件已经可用，但 --cwd 不可用时 resume 进不去
          ...cwdStateField(cwdProbe),
          // 同 switch：会话找到了，但绑定没落库——后续切换不会认这条绑定
          ...chainRecordFields(store, result.chainRecordState),
          ...(shiftNote ? { warnings: [...result.warnings, shiftNote], previousChain, currentChain } : {}),
          ...(resumeCommand ? { resumeCommand } : {}),
        }),
      );
      return;
    }
    // 与 switch 一致：警告先打（未写入链记录这类说明不能排在成功之后被漏看），且走 stderr
    for (const warning of result.warnings) console.error(`警告: ${escapeControlChars(warning)}`);
    // 空操作（这条会话本来就绑在这家）时不能打「已接入链」：链上什么都没有变，
    // 而它可能正是用户想修的那件事（链尾还停在另一家）。
    // 链记录写失败 / 无库时同样什么都没变：`replacedRef` 只是打算替换的那条，
    // 说「已接入 / 替换了」会和上面的「链记录失败」互相矛盾（第 310 轮）。
    if (result.unchanged) {
      console.log(`未改动: ${escapeControlChars(result.adoptedRef.sessionId)}`);
      if (result.note) console.log(`  ${escapeControlChars(result.note)}`);
    } else if (result.chainRecordState !== 'written') {
      // 「仍可用下面的命令打开」不能无条件说：文件读不出来时同一份 stderr 里刚说过
      // resume 一执行就失败，空文件时打开的是空会话（第 311 轮）。
      const openNote = emptyFileReason
        ? 'resume 打开的是空会话，原因见上方警告'
        : readProblem
          ? '这条会话的文件现在读不出来，直接打开会失败（原因见上方警告）'
          : '这条会话仍可用下面的命令打开';
      console.log(
        `未接入链: ${escapeControlChars(result.adoptedRef.sessionId)}（链记录没写成，原因见上方警告；${openNote}）`,
      );
      if (result.note) console.log(`  ${escapeControlChars(result.note)}`);
    } else {
      console.log(`已接入链: ${escapeControlChars(result.adoptedRef.sessionId)}`);
      if (result.replacedRef) console.log(`替换了:  ${escapeControlChars(result.replacedRef.sessionId)}`);
      // 没给 --session 时接入的是「按 mtime 挑的最新会话」，这一点不能只在 --json 里
      if (result.note) console.log(`  ${escapeControlChars(result.note)}`);
    }
    if (resumeCommand) {
      console.log('');
      console.log(`resume: ${escapeControlChars(resumeCommand)}`);
    }
    // 结果说明走 stdout（文本 mode 与 --json 的 warnings 同一条文案）
    if (shiftNote) console.log(`\n${shiftNote}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 同 switch：「当前链没读成」只在失败原因本身不是库故障时才补，避免同一件事说两遍
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    const message = [probe, describeCommandError(error)].filter(Boolean).join('；');
    fail(json, cwdIssue ? `${cwdIssue}；${message}` : message);
  }
}

/** `watch open <id> [--from <id>] [--to <provider>]`：反查 cwd 输出可复制打开命令；--from 先并入目标会话，--to 把该会话转入指定 provider 新会话 */
async function cmdOpen(
  targetId: string,
  json: boolean,
  fromId?: string,
  providerId?: string,
  toId?: string,
  check?: boolean,
  cwdGiven = false,
): Promise<void> {
  // `--to` / `--provider` 的取值都是 provider id（注册表键），归一无损：
  // 不归一的话 `open --to " codex "` 与 `open <id> --provider " claude "` 都会回
  // 「未知 provider:  codex ；可用: …」——清单里正含那个名字，肉眼却看不出多出来的空白。
  // 与 cmdSwitch 同一段论证；会话 id（targetId / fromId）的归一在 `src/open.ts` 里做。
  if (providerId !== undefined) providerId = trimUserKey(providerId);
  if (toId !== undefined) toId = trimUserKey(toId);
  // open 按 session id 全局反查，目录由会话自身记录决定；显式给的 --cwd 不参与任何一步。
  // 静默忽略会让人以为「只在某个目录里查」——必须说出来。
  const cwdIgnored = cwdGiven
    ? '--cwd 不参与 open：目录来自会话自身记录（反查是全局的），它只影响 status / sessions / recent 这类按目录枚举的命令'
    : null;
  try {
    // 两个写入方向互斥：--from 是把来源内容并进 <id> 这个目标会话，
    // --to 是把 <id> 的内容转入另一个 provider。同给时按旧行为只跑 --to，
    // 用户会以为 --from 也生效了（它的会话根本没被并入）。
    if (fromId && toId) {
      fail(json, '--from 与 --to 不能同用：--from 是并入 <id> 这个目标会话，--to 是把 <id> 转入 <provider>；请一次只选一个方向');
    }
    // --provider 是「按 id 反查时只查这一家」，而 --to / --check 的来源由 id 全局反查决定。
    // 同用时它不生效，静默忽略会让用户以为已经限定了来源 provider。
    if (providerId && (toId || check)) {
      fail(
        json,
        '--provider 只用于按会话 id 反查（open <id> --provider <provider>）；与 --to / --check 同用不会生效：--to 已指明目标 provider，来源由会话 id 全局反查确定，请去掉 --provider',
      );
    }
    if (check) {
      if (!toId) fail(json, '--check 需要同时指定 --to <provider>');
      if (fromId) fail(json, '--from 不能与 --check 同用：预检只针对 --to <provider>');
      const checked = await checkOpenInProvider(targetId, toId);
      if (cwdIgnored) checked.warnings = [...(checked.warnings ?? []), cwdIgnored];
      if (json) {
        console.log(JSON.stringify(checked));
        // `checked.ok` 只表示「预检这个动作跑通了」，不是「目标可写」——不可写体现在 `writable`
        // 与 `blocked` 上（桌面端也按这两个字段区分 error / blocked）。以前这里只看 `ok`，
        // 于是同一份预检结论在文本模式 exit 1、`--json` 却 exit 0，脚本靠退出码判断就会被骗过。
        process.exit(checked.ok && checked.writable !== false ? 0 : 1);
      }
      if (!checked.ok) fail(false, checked.error ?? '预检失败');
      const target = checked.sessionId ? `${escapeControlChars(checked.sessionId)}` : '（将新建会话）';
      // notes[0] 是给人看的计划描述（复用链上会话 / 并入既有 / 新建）；直接打 kind 会把内部枚举露给用户
      console.log(`预检：${escapeControlChars(checked.notes?.[0] ?? checked.plan?.kind ?? '?')} · 目标 ${escapeControlChars(target)} · ${checked.writable ? '可写入' : '暂不可写'}`);
      // 其余 notes 也是给人看的预检说明；只打 notes[0] 会让文本模式漏掉 JSON 里已有的信息。
      for (const note of checked.notes?.slice(1) ?? []) console.log(`说明: ${escapeControlChars(note)}`);
      // warnings 是降级原因（复用扫描失败、链上配对读不出等），只出现在 --json 里的话，
      // 文本模式的用户看不到「为什么是新建」
      for (const warning of checked.warnings ?? []) console.error(`提示: ${escapeControlChars(warning)}`);
      if (!checked.writable) {
        for (const line of [checked.error, checked.blocked?.hint]) if (line) console.error(escapeControlChars(line));
        process.exit(1);
      }
      return;
    }
    const result = toId
      ? await openInProvider(targetId, toId)
      : await openSession(targetId, { from: fromId, provider: providerId });
    if (result.ok && cwdIgnored) result.warnings = [...(result.warnings ?? []), cwdIgnored];
    if (!result.ok) {
      // 目标被占用等写入拒绝：带上结构化原因，供桌面端/脚本给出可操作提示（未写入任何内容）
      const extra: Record<string, unknown> = {
        ...(result.blocked ? { blocked: true, ...result.blocked } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        // 空来源的失败结果与预检给出同样的会话状态与坏行计数。
        ...(result.emptySessions ? { emptySessions: result.emptySessions } : {}),
        ...(result.unparsableLines ? { unparsableLines: result.unparsableLines } : {}),
        // 反查命中却读不出来时，脚本要知道 id 没写错、哪一家是 0 字节；文本第一句同源
        ...(result.lookupMisses ? { lookupMisses: result.lookupMisses } : {}),
      };
      if (!json) {
        for (const warning of result.warnings ?? []) console.error(`提示: ${escapeControlChars(warning)}`);
      }
      if (!json && result.blocked) {
        // 与 failBlocked 同一格式：文本模式也要给 code 与下一步，不能只在 --json 里有
        console.error(`[blocked:${result.blocked.code}] ${escapeControlChars(result.error ?? '未知错误')}`);
        if (result.blocked.hint) console.error(escapeControlChars(result.blocked.hint));
        process.exit(1);
      }
      fail(json, result.error ?? '未知错误', Object.keys(extra).length ? extra : undefined);
    }
    if (json) {
      console.log(JSON.stringify(result));
      return;
    }
    // 原始命令留在 JSON；文本转义控制字符，交付限制已在 warnings 披露。
    for (const warning of result.warnings ?? []) console.error(`提示: ${escapeControlChars(warning)}`);
    for (const n of result.notes ?? []) console.log(escapeControlChars(n));
    console.log(escapeControlChars(result.cd ?? ''));
    console.log(escapeControlChars(result.resumeCommand ?? ''));
  } catch (error) {
    // 半坏 schema（`REQUIRED_TABLES` 只查表名，缺列只在查询时才炸）下这里是 `open --to` 的
    // 最后一道：裸 `no such column: xxx` 既不说这是库的问题，也给不出版本 / 重建的下一步
    fail(json, describeCommandError(error));
  }
}

async function cmdSessions(cwd: string, json: boolean, chain?: string): Promise<void> {
  const adapters = listAdapters();
  const store = openStore();
  const warnings: string[] = [];
  // 与 status / recent / usage / search 同一口径：探测留到 JSON 出口，文本仍走 warnings
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  if (cwdIssue) warnings.push(cwdIssue);
  // --chain 才按链过滤；不带 flag 时列出该目录全部原生会话（README 的语义）
  // 存 ref（不只 sessionId）：会话没被列出来时还要 stat 它的文件，判断是「太老没进列表」还是「文件已经没了」
  const bound = new Map<string, Map<string, SessionRef>>();
  let chainRow: import('./core/store.js').Chain | null = null;
  if (!store) {
    // 用户明确要按链过滤却打不开库：不说是「已忽略」，列表看起来就像链上会话。
    // 不带 --chain 时同样要披露：列表只来自原生扫描，本地库里的映射与链信息都没参与，
    // 否则降级后的「未发现会话」会被读成「这个目录确实没有会话」——`status` / `usage` / `recent` 都会说明
    // 原因（权限 / 库损坏 / 被占用 / 路径被同名文件占住 / schema 比本程序新）每一档都带路径与
    // 下一步，且与 Node 版本无关：只写「可检查 WATCH_DB 路径与库状态」会把人引去查一个
    // 本来没问题的设置，而 `status` / `usage` 早在同一环境下把真实原因带出来了
    warnings.push(
      chain
        ? storeUnavailableWarning(`--chain ${escapeControlChars(chain)} 过滤已忽略，下面是该目录的全部会话`, lastStoreError ?? undefined)
        : storeUnavailableWarning('会话列表只来自原生存储（本地库里的映射与链信息未参与）', lastStoreError ?? undefined),
    );
  }
  if (store) {
    try {
      chainRow = chain ? store.findActiveChain(cwd, chain) : null;
      if (chainRow) {
        for (const h of store.listSwitchEvents(chainRow.id)) {
          for (const ref of [h.fromProvider && h.fromRef ? h.fromRef : null, h.toRef]) {
            if (!ref) continue;
            const group = bound.get(ref.provider) ?? new Map<string, SessionRef>();
            group.set(ref.sessionId, ref);
            bound.set(ref.provider, group);
          }
        }
        // findActiveChain 按名 / id 查时不看 status：归档链照样能过滤，
        // 但它已不是本目录的当前链，不说明会被当成「现在还在用这条」
        if (chainRow.status === 'archived') {
          warnings.push(`链 ${escapeControlChars(chainRow.name)} 已归档（不再是本目录的当前链），下面按它的绑定过滤`);
        } else {
          // 活跃但非当前链：列出来的会话看着就像「现在这条链的使用情况」
          const notCurrent = notCurrentChainWarning(chainRow, store.findActiveChain(cwd));
          if (notCurrent) warnings.push(notCurrent);
        }
        // 链存在但一条绑定都没有：过滤后必然是空列表，不说原因会被当成「目录里没有会话」
        if (bound.size === 0) {
          warnings.push(`链 ${escapeControlChars(chainRow.name)} 还没有绑定会话：${emptyChainBindHint()}`);
        }
      } else if (chain) {
        // 跨目录的链在这里同样是「找不到」，但指名它在哪个目录，用户才知道该改 --cwd
        warnings.push(`${store.missingChainMessage(cwd, chain)}；已列出该目录全部会话`);
        // 「本目录还没有任何链」在 :memory: 下是假结论：那条链可能刚在上一条命令里建过，
        // 只是它的库随进程消失了。与 status / usage / doctor 同一条披露
        if (ephemeralDb) {
          warnings.push(ephemeralStoreWarning('本目录的链与链尾都来自这份临时库，它每条命令都是空的'));
        }
      }
    } catch (error) {
      // 链查询失败时退化为全量列表，但要说清楚，否则 --chain 的输出会被误读。
      // 「退化」必须真的退化成全量：以前只加警告、`chainRow` 仍是 null 之外的旧值 / `bound` 已填了一部分，
      // 下面 `chainRow ? … : sessions` 会把全部会话滤掉（`chainRow` 有值但 `bound` 为空时尤其明显），
      // stdout 说「未发现会话」、stderr 说「已列出该目录全部会话」——两句互相矛盾
      chainRow = null;
      bound.clear();
      warnings.push(`链查询失败，已列出该目录全部会话：${describeStoreErrorReason(error)}`);
    }
  }
  try {
    const unavailable: string[] = [];
    // 扫描是并发的，但 `unavailable` 是 `--json` 契约里的一项：顺序必须稳定（按适配器注册序），
    // 否则同一份输入两次运行能给出两种数组顺序，调用方与用例都没法断言。先记集合，`Promise.all` 之后再摊平。
    const failedProviders = new Set<string>();
    // 「归属那一行坏了」的条目不属于任何目录，列表里根本不会出现：放在这里披露，
    // 否则「这个目录就这些会话」是一句假结论（doctor 会说明，但用户看的是列表）
    const unattributableStats = await collectUnattributable(adapters);
    for (const stat of unattributableStats) warnings.push(unattributableWarning(stat, cwd));
    const groups = await Promise.all(
      adapters
        .filter((a) => a.listSessions)
        .map(async (a) => {
          // 单个 provider 读失败（opencode 库损坏/被占用等）不拖垮整张列表
          let sessions: Awaited<ReturnType<NonNullable<typeof a.listSessions>>> = [];
          try {
            sessions = await a.listSessions!(cwd);
          } catch (error) {
            failedProviders.add(a.id);
            // 只报 provider id，用户看不出是权限、库损坏还是路径问题，也就无从修
            warnings.push(`${a.id} 会话列表读取失败：${error instanceof Error ? error.message : String(error)}`);
            return { provider: a.id, sessions: [] };
          }
          const ids = bound.get(a.id);
          // --chain 时只保留链上绑定过的会话：没绑定的 provider 不能把自家全部会话混进「这条链」
          const linked = chainRow ? (ids ? sessions.filter((s) => ids.has(s.ref.sessionId)) : []) : sessions;
          // 撞到适配器上限时列表只是「最近 N 个」：不标出来会被当成全集
          const capped = a.listSessionsCap !== undefined && sessions.length >= a.listSessionsCap;
          // 链上绑定了、但这次没被列出来：整组被 filter 掉后看起来就像「这条链没绑定它」。
          // 两种原因必须分开说——文件已经没了（下次切换必然失败，可先 switch 重建），还是只是排在上限之外。
          if (chainRow && ids) {
            const listed = new Set(sessions.map((s) => s.ref.sessionId));
            const missingFiles: string[] = [];
            const compressedFiles: { id: string; note: string; empty: boolean }[] = [];
            const unreadableFiles: { id: string; reason: string }[] = [];
            const occupiedFiles: string[] = [];
            const tooOld: string[] = [];
            for (const [id, ref] of ids) {
              if (listed.has(id)) continue;
              // 与 status / chain list / doctor 共用同一判定：只有 ENOENT / ENOTDIR 才算文件不在，
              // EACCES 等读不出来时状态未知——说成「已不存在」会把人引去重新 adopt（下一次照样读不出来）。
              // 路径被同名目录占住既不算「还在」也不算「没了」：混进 tooOld 会被报成
              // 「不在最近 N 个里（可能属于另一个目录）」，让人去核对 --cwd，而实际要恢复的是这个路径
              const presence = await sessionFilePresence(ref.filePath);
              if (presence.state === 'missing') {
                // 只剩 Codex 压缩副本不算「文件已不存在」：下次切换照样会失败，但下一步不同；
                // 0 字节副本是第三种状态（内容已丢失），下一步是备份恢复而不是重新展开
                const copy = compressedCopy(presence);
                if (copy) compressedFiles.push({ id, note: copy.note, empty: !!presence.emptyCompressed });
                else missingFiles.push(id);
              } else if (presence.state === 'unknown') unreadableFiles.push({ id, reason: presence.reason });
              else if (!presence.isFile) occupiedFiles.push(id);
              else tooOld.push(id);
            }
            if (missingFiles.length) {
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${missingFiles.join('、')} 文件已不存在，本次未列出；下次切换会失败，${rebindHint(a.id)}` +
                  (missingFiles.length > 1 ? `（另有 ${missingFiles.length - 1} 个同样缺失，见上）` : ''),
              );
            }
            if (compressedFiles.length) {
              const hasIntact = compressedFiles.some((c) => !c.empty);
              const hasEmpty = compressedFiles.some((c) => c.empty);
              // 「重新开一次会话」得到的是另一条会话，修不好这条链绑定：给了也会在下次 switch 再撞上。
              // 与缺失档同一口径给 rebindHint（switch 重新绑定 / adopt 指定会话），空文件才谈得上恢复备份。
              const next = hasIntact
                ? hasEmpty
                  ? `——完好的副本先让它重新展开再试；0 字节副本的内容已丢失，只能从备份恢复；${rebindHint(a.id)}`
                  : '——先让它重新展开再试'
                : `——0 字节副本的内容已丢失，只能从备份恢复；${rebindHint(a.id)}`;
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${compressedFiles.map((c) => `${c.id}：${c.note}`).join('；')}，本次未列出；下次切换会失败${next}`,
              );
            }
            if (unreadableFiles.length) {
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${unreadableFiles.map((u) => u.id).join('、')} 文件状态无法确认，本次未列出；首个原因：${unreadableFiles[0]!.reason}；先确认文件是否还在，再决定是否需要重新 adopt`,
              );
            }
            if (occupiedFiles.length) {
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${occupiedFiles.join('、')} 的路径现在不是普通文件（被同名目录或设备文件占住了），本次未列出；先恢复该路径，再决定是否需要重新 adopt`,
              );
            }
            if (tooOld.length) {
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${tooOld.join('、')} 不在最近 ${sessions.length} 个里${capped ? '（已达列表上限）' : '（可能属于另一个目录）'}，本次未列出；可用 watch doctor 或原生 CLI 确认该会话`,
              );
            }
          }
          return {
            provider: a.id,
            sessions: linked,
            ...(capped ? { capped: true } : {}),
          };
        }),
    );
    for (const a of adapters) if (a.listSessions && failedProviders.has(a.id)) unavailable.push(a.id);
    const result = groups.filter((g) => g.sessions.length > 0);
    // 零会话 + `--cwd` 只是同一个目录的另一种写法：正文的「未发现会话」会被当成「真的没聊过」，
    // 而会话可能全记在 realpath 那种写法下（软链 / 大小写），先给可照抄的路径
    if (!result.length) {
      // 与 status 同一口径：有一家没读成时，零结果不是「写法不对」的证据；
      // 「归属读不出来」同理——换一种写法也查不到那些文件，它们连属于哪个目录都不知道
      const alias = await cwdAliasHint(cwd, undefined, [...unavailable, ...unattributableStats.map((s) => s.provider)]);
      if (alias) warnings.push(alias);
    }
    pushEscapedContentWarning(
      warnings,
      result.flatMap((g) =>
        g.sessions
          .filter((s) => Boolean(s.preview))
          .filter((s) => hasControlChars(s.preview as string))
          .map((s) => ({ provider: g.provider, sessionId: s.ref.sessionId })),
      ),
      '预览',
    );
    pushPreviewErrorWarning(
      warnings,
      result.flatMap((g) =>
        g.sessions.map((s) => ({
          provider: g.provider,
          sessionId: s.ref.sessionId,
          ...(s.previewError ? { previewError: s.previewError } : {}),
        })),
      ),
    );
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        cwd,
        // `providers: []` 分不清「这个目录没有会话」与「--cwd 不可用」：后者时所有 provider
        // 都按字符串精确匹配、必然为空。与 status / recent / usage / search 同一字段
        ...cwdStateField(cwdProbe),
        // 库打不开时列表只来自原生扫描（`--chain` 过滤也被忽略）：只有中文 warnings 的话，
        // 脚本会把「已按链过滤」与「过滤根本没生效」当成同一份列表。缺省即库已打开
        ...(store ? {} : { storeAvailable: false }),
        // `--chain` 给了却没用上（本目录没有这条链 / 链查询失败 / 库没打开）：此时上面的
        // `providers` 是全部会话，脚本不能把它当成过滤结果。不带 `--chain` 时不出现
        ...(chain && !chainRow ? { chainFilterApplied: false } : {}),
        // 0 字节的行在 `previewError` 之外另带 `emptyFile`：脚本不用解析中文，
        // 权限 / I/O 失败的行不出现该字段（与 status / chain list / doctor 同口径）
        providers: result.map((group) => ({ ...group, sessions: group.sessions.map(withEmptyFileFlag) })),
        ...(unavailable.length ? { unavailable } : {}),
        ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
    if (!result.length) {
      // `--cwd` 本身不可用时，零结果是路径造成的，不是「这个目录没聊过」：与 status 同一口径，
      // 且排在「哪几家没读成」之前——路径全错时「修好这些存储」不是能解决问题的下一步
      if (cwdIssue) {
        console.log(cwdUnusableConclusion('未发现可列出的原生会话', '本次结果不能说明这个目录里有没有会话'));
      } else if (unavailable.length) {
        console.log(
          `未发现会话；但 ${unavailable.join(' / ')} 没能读取（原因见上方警告），无法确认这个目录里是否还有它们的会话——先修好这些存储再重试`,
        );
      } else {
        // 归属读不出来的那些同样不在任何目录的列表里：空列表不是「这个目录没聊过」的证据
        console.log(unattributableEmptyNote(unattributableStats) ?? `未发现会话（${noSessionHint()}）`);
      }
      if (unavailable.length) console.error(`未读取: ${unavailable.join('、')}（原生存储读取失败）`);
      return;
    }
    for (const g of result) {
      console.log(`${g.provider}${g.capped ? '（已达列表上限，更早的会话未列出）' : ''}:`);
      for (const s of g.sessions) {
        console.log(`  ${escapeControlChars(s.ref.sessionId)}  mtime=${fmtTime(s.updatedAt)}`);
        if (s.preview) console.log(`    ${escapeControlChars(s.preview)}`);
      }
    }
    if (unavailable.length) console.error(`未读取: ${unavailable.join('、')}（原生存储读取失败）`);
  } catch (error) {
    // 查询类命令同样会撞上坏库（`search_index` 缺列、`messages_fts` 缺表…）：
    // 裸 SQLite 原文既不说这是库的问题，也给不出重建的下一步
    fail(json, describeCommandError(error));
  }
}

async function cmdRecent(cwd: string, json: boolean, limit: number = 8, cwdGiven = false): Promise<void> {
  const store = openStore();
  type RecentItem = {
    provider: string;
    sessionId: string;
    cwd: string;
    updatedAt: number;
    preview?: string;
    /** 预览读不出来的原因：缺省不等于「这条会话没有内容」 */
    previewError?: string;
    /** `previewError` 属于 0 字节档：内容已丢失，脚本不必解析中文 */
    emptyFile?: true;
  };
  // 用 Map 而不是数组 + Set：同一会话可能先由映射表命中、再被原生扫描命中，
  // 原生那边的 mtime 与 preview 更准，合并时不能被「先到先得」丢掉（以前映射先入就丢 preview）。
  const merged = new Map<string, RecentItem>();
  const unavailable: string[] = [];
  const warnings: string[] = [];
  // 与 status / sessions / usage / search 同一口径：探测留到 JSON 出口，文本仍走 warnings
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  if (cwdIssue) warnings.push(cwdIssue);

  if (!store) {
    // 只记一个「本地库」看不出为什么：同一份坏库下 `sessions` / `status` / `usage` 都会带出
    // 真实原因（权限 / 库损坏 / 被占用 / 路径被同名文件占住 / schema 比本程序新，各带路径与
    // 下一步）。而 `recent` 的空列表分支还写着「原因见上方警告」——上方必须真有一条。
    unavailable.push('本地库');
    warnings.push(
      storeUnavailableWarning('近期的映射表与链信息未参与，列表只来自原生存储', lastStoreError ?? undefined),
    );
  }
  if (store) {
    try {
      // 显式 --cwd 时映射表也要按目录过滤：原生扫描一直按 cwd 精确匹配，
      // 映射表不过滤会把别的项目的会话混进「这个目录的近期会话」
      const locations = store.listSessionLocations({ limit: limit * 2, ...(cwdGiven ? { cwd } : {}) });
      for (const loc of locations) {
        const key = `${loc.provider}:${loc.sessionId}`;
        try {
          const st = await stat(loc.filePath);
          if (!st.isFile()) {
            // 路径还在，但被同名目录 / 设备文件占住：既不是「已删除」（原生扫描也列不出来），
            // 也不是能用的会话。静默跳过会让它从「近期」里凭空消失
            warnings.push(
              `${loc.provider} 会话 ${escapeControlChars(loc.sessionId)} 的映射记录指向的路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(loc.filePath)}；已跳过映射命中，先恢复该路径再重试`,
            );
            continue;
          }
          merged.set(key, {
            provider: loc.provider,
            sessionId: loc.sessionId,
            cwd: loc.cwd,
            // 用文件 mtime 而不是 last_seen_at：后者是「Watch 上次反查它的时间」，
            // 反复 open 一个老会话会让它排到最前面，和原生扫描的 updatedAt 也不是一回事
            updatedAt: st.mtimeMs,
          });
        } catch (error) {
          // 文件确实没了：交给原生扫描，它还能按目录重新列出来。
          // 但读不出来（EACCES 等）不是「没了」，要披露，否则这条会话会静默消失在「近期」里
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            // 原因要翻成中文：`EACCES: permission denied, stat '…'` 这类原文看不出该修权限还是路径
            warnings.push(
              `${loc.provider} 会话 ${escapeControlChars(loc.sessionId)} 的映射记录无法确认文件状态（${escapeControlChars(loc.filePath)}）：${describeSessionReadFailureReason(error)}；已跳过映射命中，先确认该路径是否可读再重试`,
            );
          }
        }
      }
    } catch (error) {
      // 本地映射读取失败不影响原生扫描，但只记一个「本地库」看不出为什么
      unavailable.push('本地库');
      warnings.push(`本地映射表读取失败：${describeStoreErrorReason(error)}；已只按原生存储扫描`);
    }
  }

  // 原生存储里可能有映射表还没见过的更新会话，所以始终扫一遍；
  // 不能凑够 limit 条就提前收手——那会按 registry 顺序先到先得，把别家更新的会话挤掉。
  const recentAdapters = listAdapters();
  // 归属那一行坏了的条目不属于任何目录，因此不会出现在「近期」里；不说就会被读成「最近没聊过」
  const unattributableStats = await collectUnattributable(recentAdapters);
  for (const stat of unattributableStats) warnings.push(unattributableWarning(stat, cwd));
  // 文本模式靠 warnings 里那句「已达列表上限」说明列表不完整；`--json` 只有 `truncated` / `total`
  // 两个数，脚本分不清「这个目录就这么多会话」与「某一家枚举时就只拿到最近 N 个」——
  // 后者的 total 本身就是低估。与 `search --json` 的 `coverage.capped` 同一口径。
  const cappedProviders: string[] = [];
  for (const adapter of recentAdapters) {
    if (!adapter.listSessions) continue;
    try {
      const sessions = await adapter.listSessions(cwd);
      // 撞上适配器上限时枚举到的只是「最近 N 个」：更早的会话根本没进结果，
      // truncated / total 都会低估，不说明就会被当成「这个目录只有这些会话」
      const cap = adapter.listSessionsCap;
      if (cap !== undefined && sessions.length >= cap) {
        cappedProviders.push(adapter.id);
        // 不承诺「用某命令看全集」：sessions / doctor 同样走这个上限，指过去只会再撞一次
        warnings.push(`${adapter.id} 已达列表上限 ${cap} 个，更早的会话不在「近期」里；这一条列表不完整`);
      }
      for (const s of sessions) {
        // 与映射表重叠时覆盖：原生这边带 preview，顺序也直接来自文件 mtime
        merged.set(`${s.ref.provider}:${s.ref.sessionId}`, {
          provider: s.ref.provider,
          sessionId: s.ref.sessionId,
          cwd: s.ref.cwd,
          updatedAt: s.updatedAt,
          preview: s.preview,
          ...(s.previewError ? { previewError: s.previewError } : {}),
          ...(s.previewError && isEmptySessionFileReason(s.previewError) ? { emptyFile: true as const } : {}),
        });
      }
    } catch (error) {
      // 单家读失败不拖垮列表，但要披露原因（「各 provider 按路径精确比较」这一步出错时尤其看不出）
      unavailable.push(adapter.id);
      warnings.push(`${adapter.id} 会话列表读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const results = [...merged.values()];
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  const final = results.slice(0, limit);
  // 同 status / sessions：零结果时先看 --cwd 是不是同一个目录的另一种写法，
  // 否则「暂无最近会话记录」会被当成「这个目录真的没聊过」
  if (!final.length) {
    // 只算原生存储没读成的那些：本地映射表坏了不影响原生扫描，「这个目录没会话」的结论照样成立。
    // 「归属读不出来」也算扫得不完整：换一种写法同样查不到那些文件（连属于哪个目录都不知道）
    const alias = await cwdAliasHint(cwd, undefined, [
      ...unavailable.filter((id) => id !== '本地库'),
      ...unattributableStats.map((s) => s.provider),
    ]);
    if (alias) warnings.push(alias);
  }
  // 列表被 --limit（默认 8）截断时要说出来，否则用户会把「最近 8 条」当成全部
  const truncated = results.length > final.length;
  pushEscapedContentWarning(
    warnings,
    final.filter((s) => Boolean(s.preview)).filter((s) => hasControlChars(s.preview as string)),
    '预览',
  );
  pushPreviewErrorWarning(warnings, final);

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      // 同 status / usage：回显本次使用的 `--cwd`（省略时是进程工作目录）
      cwd,
      sessions: final,
      ...(truncated ? { truncated: true, total: results.length } : {}),
      ...(cappedProviders.length ? { capped: cappedProviders } : {}),
      // 空列表 + ok:true 分不清「近期没聊过」与「--cwd 不可用」；与 status / sessions / usage / search 同字段
      ...cwdStateField(cwdProbe),
      // 库没打开时 `unavailable` 里是中文「本地库」：脚本不该解析中文，与 status / sessions / usage
      // 统一成 `storeAvailable: false`；`unavailable` 保留（文本与既有脚本仍依赖它）
      ...(store ? {} : { storeAvailable: false }),
      ...(unavailable.length ? { unavailable } : {}),
      ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
      ...(warnings.length ? { warnings } : {}),
    }));
    return;
  }
  for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
  if (unavailable.length) console.error(`未读取: ${unavailable.join('、')}（读取失败，已跳过）`);
  if (truncated) {
    console.error(`提示: 只显示最近 ${final.length} 条，另有 ${results.length - final.length} 条更早的会话未列出（--limit 可调，最大 50）`);
  }
  if (!final.length) {
    // 与 sessions / status 同一口径：`--cwd` 本身不可用时零结果与「近期有没有会话」无关，
    // 先改结论；有来源没读成时才说「暂无记录」会被当成「这个目录真的没聊过」
    if (cwdIssue) {
      console.log(cwdUnusableConclusion('暂无最近会话记录', '本次结果不能说明这个目录近期有没有会话'));
    } else if (unavailable.length) {
      console.log(
        `暂无最近会话记录；但 ${unavailable.join(' / ')} 没能读取（原因见上方警告），无法确认近期是否有它们的会话——先修好这些存储再重试`,
      );
    } else {
      console.log(unattributableEmptyNote(unattributableStats) ?? '暂无最近会话记录');
    }
    return;
  }
  for (const s of final) {
    // 「最近」的价值就在时间与摘要：JSON 一直带 updatedAt / preview，文本模式不能只留 id
    console.log(`  [${s.provider}] ${escapeControlChars(s.sessionId)} (${escapeControlChars(s.cwd)})  mtime=${fmtTime(s.updatedAt)}`);
    if (s.preview) console.log(`    ${escapeControlChars(s.preview)}`);
  }
}

async function cmdProviders(json: boolean, cwdGiven = false): Promise<void> {
  try {
    const providers = await listProviders();
    // 检测只看本机命令在不在，`--cwd` 不参与：显式给了就说出来（同 open / prompt <id>），
    // 否则 `providers --cwd <写错的路径>` 照样 exit 0，看着像「在那个目录下检测过」
    const cwdIgnored = cwdGiven ? cwdUnusedNote('providers') : null;
    if (json) {
      console.log(JSON.stringify({ ok: true, providers, ...(cwdIgnored ? { warnings: [cwdIgnored] } : {}) }));
      return;
    }
    if (cwdIgnored) console.error(`提示: ${cwdIgnored}`);
    console.log('支持的 Agent 与本机检测状态:');
    for (const p of providers) {
      const state = p.available ? '✓ 已就绪' : p.error ? `✗ 检测失败: ${p.error}` : '✗ 未检测到';
      console.log(`  ${p.id.padEnd(10)} ${p.displayName.padEnd(12)} ${state}`);
    }
  } catch (error) {
    // 查询类命令同样会撞上坏库（`search_index` 缺列、`messages_fts` 缺表…）：
    // 裸 SQLite 原文既不说这是库的问题，也给不出重建的下一步
    fail(json, describeCommandError(error));
  }
}

/**
 * 时间戳只在真能解析时返回毫秒。解析不出来时返回 undefined，让调用方省略那一行——
 * 拿 `NaN` 或 0 顶替，会在文档里写出一句看着像事实的假时间（1970）。
 */
function toMillis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `watch prompt [<session-id>]`：摘要交接（降级方案）。
 *
 * 只读：不写任何会话文件、不启动任何 CLI、不碰本地库的会话映射。用途有两条：
 * ① 目标工具根本没有适配器（Antigravity / Cursor / Claude Desktop），写不回原生格式；
 * ② 那家的格式刚漂移，写回去有风险。这时把会话渲染成一份可粘贴的 Markdown，
 * 比「不支持」更有用，但**必须**说清这是降级——文档一旦被复制走就脱离 Watch，
 * 所以降级声明写在正文里，而不是只打在 stderr。
 *
 * 省略会话 id 时按修改时间在本目录里自动挑一条（`--provider` 可把范围收到一家）。
 * 这条挑选与 `status` / `switch` 的「最新会话」同源（`collectTips` + `pickLatestTip`），
 * 并沿用同一套披露：挑不到时不能把「读不出来」讲成「这个目录没会话」；挑到了但
 * 有会话因归属行损坏被跳过时，要说明挑的是「能读出的那些里最新的」。
 */

/** 自动挑选的结果：要么给出会话，要么给出一条能直接拿去 `fail()` 的完整原因。 */
type PromptAutoPick =
  | { adapter: ProviderAdapter; ref: SessionRef; updatedAt: number }
  | { message: string };

async function autoPickPromptSession(
  cwd: string,
  provider: string | undefined,
  warnings: string[],
): Promise<PromptAutoPick> {
  const cwdIssue = await cwdProblem(cwd);
  const adapters = provider ? listAdapters().filter((a) => a.id === provider) : listAdapters();
  if (provider && !adapters[0]?.findLatestSession) {
    // 没有这个方法的适配器只是「不能替人挑」，会话本身可能就在那儿：
    // 说成「没找到会话」会让人白开一条新的
    return { message: `${provider} 不支持自动挑选会话，请显式指定会话 id：watch prompt <session-id> --provider ${provider}` };
  }
  const unreadable: string[] = [];
  const unreadableReasons: { provider: string; reason: string }[] = [];
  const tips = await collectTips(cwd, adapters, warnings, unreadable, unreadableReasons);
  const tip = pickLatestTip(tips);
  // 归属那一行坏了的文件不属于任何目录，`findLatestSession` 只能跳过：零结果与
  // 「挑到的是能读出的那些里最新的」两种情况都要用到这一份统计
  const hidden = await collectUnattributable(adapters);
  const prefix = cwdIssue ? `${cwdIssue}；` : '';

  if (!tip) {
    if (unreadable.length) {
      const detail = unreadableReasons.map((u) => `${u.provider}（${escapeControlChars(u.reason)}）`).join('；');
      return {
        message:
          prefix +
          `无法确认这个目录里有没有可交接的会话：${detail}——这不代表这里没有会话，` +
          '先修好这些会话存储（权限、路径或库状态）再重试，或用 watch prompt <session-id> 显式指定',
      };
    }
    const hiddenNote = unattributableNoPickMessage(hidden);
    if (hiddenNote) {
      return { message: prefix + `${hiddenNote}；改用 watch prompt <session-id> 显式指定会话 id 可以跳过这种挑选` };
    }
    // `--cwd`（或当前目录）可能只是同一个目录的另一种写法：只留「先开一次会话」
    // 会把人引去开新会话，而原来的会话一直躺在另一个写法下面
    const alias = await cwdAliasHint(cwd, undefined, unreadable);
    const scope = provider ? `（provider=${provider}）` : '';
    return {
      message:
        prefix +
        `没有在 ${escapeControlChars(cwd)} 找到可读取的原生会话${scope}` +
        (alias ? `；${alias}` : '') +
        '；若确实是新目录，请先在该目录下开一次会话，或用 watch prompt <session-id> 显式指定',
    };
  }

  if (cwdIssue) warnings.push(cwdIssue);
  // 「按修改时间最新」这句话只在所有会话都读得出归属时成立；否则挑的是子集里的最新，
  // 用户要的可能正是被跳过的那一条
  const pickWarning = unattributablePickWarning(
    hidden,
    '自动挑的会话',
    '你要的可能正是被跳过的那一条（用 watch prompt <session-id> 显式指定会话 id 可以避开这种挑选）',
  );
  if (pickWarning) warnings.push(pickWarning);
  const adapter = getAdapter(tip.provider);
  if (!adapter) return { message: unknownProviderMessage(tip.provider) };
  return { adapter, ref: tip.ref, updatedAt: tip.updatedAt };
}

async function cmdPrompt(
  cwd: string,
  json: boolean,
  sessionId: string | undefined,
  provider: string | undefined,
  profileRaw: string | undefined,
  lastUserTurns: number | undefined,
  sinceCompact: boolean,
  cwdGiven: boolean,
): Promise<void> {
  const profile = profileRaw === undefined ? DEFAULT_PROMPT_PROFILE : parsePromptProfile(profileRaw);
  if (!profile) {
    // 档位是封闭枚举（四个词），写错时把可选值一起给出。
    // 取值已做 trim + 小写归一（`--profile " FULL "` 可用），所以这里只剩真正拼错的情况。
    usage(`--profile 只接受 ${PROMPT_PROFILES.join(' / ')}，收到: ${escapeControlChars(profileRaw ?? '')}`);
  }
  if (provider && !getAdapter(provider)) fail(json, unknownProviderMessage(provider));

  const diagnostics: string[] = [];
  let adapter: ProviderAdapter;
  let foundRef: SessionRef;
  let updatedAt: number;
  let autoPicked = false;
  if (sessionId === undefined || sessionId === '') {
    // 空串也按「没给」处理：`watch prompt ""` 现在会去猜会话 id，而猜出来的东西
    // 与显式给的 id 不是一回事，必须让用户看见（下面的 autoPicked）
    autoPicked = true;
    const pick = await autoPickPromptSession(cwd, provider, diagnostics);
    if ('message' in pick) fail(json, pick.message);
    adapter = pick.adapter;
    foundRef = pick.ref;
    updatedAt = pick.updatedAt;
  } else {
    const misses: LookupMiss[] = [];
    const resolved = await resolveById(sessionId, provider, null, listAdapters(), diagnostics, misses);
    if (!resolved) {
      const headline = lookupMissHeadline('会话', sessionId, misses, provider);
      fail(
        json,
        headline ??
          `未找到会话: ${escapeControlChars(sessionId)}${provider ? `（provider=${provider}）` : ''}。` +
            `请确认 id 正确且对应 CLI 已安装登录。${LOOKUP_NEXT_STEP}`,
      );
    }
    adapter = resolved.adapter;
    foundRef = resolved.found.ref;
    updatedAt = resolved.found.updatedAt;
  }
  const warnings = [...diagnostics];
  const id = escapeControlChars(foundRef.sessionId);
  // 与 open 的「--cwd 不参与 open」同一类误读：显式给了 id 时目录来自会话自身记录，
  // --cwd 一个字节都不参与，静默忽略会让人以为「只在这个目录里找 / 只输出这个目录的内容」
  if (cwdGiven && !autoPicked) {
    warnings.push(
      '--cwd 不参与 prompt <session-id>：会话按 id 全局反查，正文里的目录与路径都来自会话自身记录；它只在不带会话 id、按目录自动挑选时生效',
    );
  }
  if (autoPicked) {
    warnings.push(
      `没有指定会话 id，已按修改时间挑选本目录最新的可读会话（${adapter.id} ${id}）；` +
        '要换别的会话就用 watch prompt <session-id> 显式指定——这次挑的是哪条，文档头也写着',
    );
  }

  // 只读一次来源：解析前后各量一次，用来判断正文代表的是哪一刻（见 describeSourceChangedDuringPrompt）
  const sourceSnapshot = await snapshotSourceState(foundRef.filePath);
  let turns;
  try {
    turns = await adapter.parse(foundRef);
  } catch (error) {
    // 读不出来就不能装作「这条会话是空的」：文档正文会因此变成「没有可展示的内容」，
    // 与「会话确实没聊过」长得一模一样。
    fail(json, `会话 ${id} 读取失败：${await describePromptSourceReadFailure(foundRef.filePath, error)}；未生成任何内容`);
  }

  // 坏行被 `parse` 静默跳过：正文里的记录会缺一段，而读者看不出「少了」。文档要被复制走，
  // 所以这一档既进 warnings（终端里立刻能看到）也进正文（`sourceBadLines`）。
  // 先扫再判 0 轮：文件被截断时 parse 同样返回 0 轮，不能把「可读、只有系统事件 / 元数据」
  // 当成结论——0 轮的原因要看坏行扫描，与 open / switch / doctor 用同一个判据。
  const badSourceScan = await scanUnparsableJsonLines(foundRef.filePath, { allowMissing: false });
  const badSourceLines = badSourceScan.count;

  // 0 轮有三种完全不同的原因：`probeSessionReadable()` 管 0 字节 / 读不出来（与 open / switch 共用），
  // 坏行扫描管「文件在、但内容被截断」，都没有才是合法空会话或格式没认出来。
  // 文档里那句结论必须说清是哪一种：0 字节要从备份恢复，有坏行则先确认文件完整性。
  let emptySourceNote: string | undefined;
  // 0 字节与「可读但没有记录」在 md 里只是两句中文；脚本要分档就得有结构化字段
  // （与 status / sessions / recent / usage / doctor 的 `emptyFile` 同口径）
  let sourceEmptyFile = false;
  if (turns.length === 0) {
    const emptyReason = await probeSessionReadable(foundRef.filePath);
    if (emptyReason) {
      sourceEmptyFile = isEmptySessionFileReason(emptyReason);
      warnings.push(`会话 ${id} 没有可交接的内容：${emptyReason}`);
      emptySourceNote = `${emptyReason}；需要完整内容请先恢复来源文件`;
    } else {
      const hasBadLines = badSourceLines > 0 || Boolean(badSourceScan.error);
      const note = describeZeroTurnReason(
        badSourceScan,
        '来源文件可读，但解析出 0 轮可交接内容（可能只有系统事件 / 元数据，或这一家的记录格式还没被识别）',
        hasBadLines ? '需要完整内容请先恢复来源文件' : undefined,
      );
      warnings.push(`会话 ${id}：${note}`);
      emptySourceNote = note;
    }
  } else if (badSourceLines > 0) {
    // 0 轮时上面那句已连同行数说过，这里不重复同一件事
    warnings.push(
      `来源会话 ${escapeControlChars(foundRef.sessionId)} 有 ${badSourceLines} 行无法解析（截断或损坏），已跳过；文档正文可能缺少这些记录`,
    );
  }
  // 扫描没完成时「0 坏行」不是结论：正文同样要写明这次数不出来（文档脱离 Watch 后 stderr 不跟着走）
  const badSourceScanFailure = describeBadLinesScanFailure(
    badSourceScan,
    `来源会话 ${escapeControlChars(foundRef.sessionId)}`,
    '正文是否缺少记录无法确认——先确认该文件可读，需要完整内容请先恢复来源文件',
  );
  if (badSourceScanFailure && turns.length > 0) warnings.push(badSourceScanFailure);

  let sessionUsage: TokenUsage | null = null;
  // 用量这一行在「没有数字」之外还有两种来路，都必须写进文档：读不出来（`sessionUsage` 抛错），
  // 或用量数据源本身是空的（grok 的 `updates.jsonl` 被截成 0 字节，`sessionUsage` 安静返回 null）。
  // 只打在 stderr 不够——文档会被复制进别家助手，那里的读者会把「读不出来」当成「这家没有用量」。
  let usageNote: string | undefined;
  let usageBadLines = 0;
  let usageBadLinesScanError: string | undefined;
  if (adapter.sessionUsage) {
    try {
      sessionUsage = await adapter.sessionUsage(foundRef);
    } catch (error) {
      const reason = describeReadFailureOrSelf(error);
      usageNote = `用量读取失败（${reason}），这里没有可用数字——这不代表来源会话没有用量`;
      warnings.push(`用量读取失败（${reason}）；文档的用量行已写明这一点`);
    }
    if (sessionUsage === null && !usageNote) {
      const sidecar = await usageSidecarProblem(adapter, foundRef, '来源会话');
      if (sidecar) {
        usageNote = `用量不可用：${sidecar}`;
        warnings.push(sidecar);
      }
    }
    // 坏行让合计**静默偏少**：数字照印，但文档里要括注这是下界。判据与 `watch usage` / `open`
    // 共用 `usageBadLinesDetail()`（同一份扫描同时给出行数与完整警告，不扫第二遍文件）。
    // 内容扫描（`badSourceScan`）刚刚读过同一个文件时直接复用；旁路文件由函数内部挡住。
    const badUsage = await usageBadLinesDetail(adapter, foundRef, '来源会话', { knownScan: badSourceScan });
    if (badUsage) {
      usageBadLines = badUsage.count;
      if (badUsage.scanFailed) usageBadLinesScanError = badUsage.scanError;
      warnings.push(badUsage.reason);
    }
  }

  // 对比读取前后的文件状态。正文、用量与坏行扫描分别读取，stat 无法判定其中各自包含哪些记录。
  const sourceChange = await sourceChangeSince(foundRef.filePath, sourceSnapshot);
  // 与正文同一份判据：把这次 stat 结论传进去，不再让正文函数自己重测一次。
  // sourceChange 现在有三态（changed / unchanged / unverifiable），「量不出来」也要进正文与 warnings，
  // 不能因为旧实现用 null 表示「没变」就把这一档静默掉。
  const sourceDrift = await describeSourceChangedDuringPrompt(
    foundRef.filePath,
    sourceSnapshot,
    `${escapeControlChars(foundRef.sessionId)}（${adapter.displayName}）`,
    sourceChange,
  );
  if (sourceDrift) warnings.push(sourceDrift);

  // 来源记录里的 cwd 现在还在不在：与本次 `--cwd` 无关（那由上面的 cwdIssue 管）。文档会被复制走，
  // 读者照着里面的相对路径与命令动手时，这个目录可能早已不在——这句必须进正文，stderr 不会跟着走。
  // 空字符串不探测：没有可核对的路径，不能把「没记」讲成「现在不存在」。
  let sourceCwdNote: string | undefined;
  // 结构化状态给脚本用：正文的「工作目录状态」一行是给人读的，脚本不该解析它；
  // 只有探测确实不是 ok 时才输出，健康目录不冒字段。
  let sourceCwd: CwdInspection | undefined;
  // 链接工作树和目录状态是两件事：目录还在，但它是 `git worktree add` 建出来的独立工作树时，
  // 文档读者从路径上看不出来，可能回主工作树改同一份文件——必须写进正文（PLAN §5）。
  let sourceWorktreeNote: string | undefined;
  // 探测失败的结构化结论：缺省的 sourceWorktree 不能同时表示「不是工作树」与「没确认」。
  let sourceWorktreeUnknown: string | undefined;
  // 结构化 worktree 字段同样给脚本用；主工作树或分支读不出来时保留 null，不编造。
  let sourceWorktree: { mainWorktree: string | null; branch: string | null } | undefined;
  // 链接工作树的分支已在「工作目录类型」一行里；普通仓库根再补一行当前分支，
  // 文档离开原机后读者能先核对分支再动手（baton / bb-plugin-handoff 同样带分支信息）。
  let sourceBranchNote: string | undefined;
  let sourceBranchUnreadable = false;
  // 结构化字段给脚本用：Markdown 里的分支行是给人读的，脚本不该去解析正文。
  // 链接工作树的情况已在 worktree 说明里，形状不同（主工作树可能读不出来），这里只放普通仓库根。
  let sourceBranch: { branch: string; repoRoot: string } | { detached: true; repoRoot: string } | undefined;
  // 磁盘对照只看会话记录里的目录：目录进不去时整件事不做（见 inspectManifestFilesOnDisk）。
  let recordedCwdUsable = false;
  if (foundRef.cwd.trim()) {
    const recordedProbe = await inspectCwd(foundRef.cwd);
    recordedCwdUsable = recordedProbe.state === 'ok';
    const recordedCwdNote = describeRecordedCwd(recordedProbe, foundRef.cwd);
    if (recordedCwdNote) {
      sourceCwd = recordedProbe;
      sourceCwdNote = recordedCwdNote;
      warnings.push(`来源会话记录的工作目录现在不可用：${recordedCwdNote}`);
    }
    // 目录不在时 `.git` 也无从读，此时探测只会得到「不是 worktree」这个假事实，索性不探
    if (recordedProbe.state === 'ok') {
      const worktreeProbe = await inspectWorktree(foundRef.cwd);
      const worktreeNote = describeWorktreeNote(worktreeProbe);
      if (worktreeNote) {
        sourceWorktreeNote = worktreeNote;
        if (worktreeProbe.state === 'unknown') sourceWorktreeUnknown = worktreeProbe.reason;
        if (worktreeProbe.state === 'worktree') {
          sourceWorktree = { mainWorktree: worktreeProbe.mainWorktree, branch: worktreeProbe.branch };
        }
      } else {
        const branchProbe = await inspectRepoBranch(foundRef.cwd);
        const branchNote = describeRepoBranchNote(branchProbe, foundRef.cwd);
        if (branchNote) {
          sourceBranchNote = branchNote;
          if (branchProbe.state === 'unknown') sourceBranchUnreadable = true;
          else if (branchProbe.state === 'branch') sourceBranch = { branch: branchProbe.branch, repoRoot: branchProbe.repoRoot };
          else if (branchProbe.state === 'detached') sourceBranch = { detached: true, repoRoot: branchProbe.repoRoot };
        }
      }
    }
  }

  // 「改动概览」的磁盘对照：必须在这里做完（要 stat），`buildHandoffPrompt()` 保持纯函数。
  // 清单先汇总一次，同一份同时用于对照与渲染——两份各算一遍会让状态的键与 files 对不上。
  const manifestPreview = collectWorkManifest(turns, foundRef.cwd);
  const manifestDisk = await inspectManifestFilesOnDisk(manifestPreview, foundRef.cwd, recordedCwdUsable);
  if (manifestDisk) {
    const notes: string[] = [];
    if (manifestDisk.missing > 0) notes.push(`${manifestDisk.missing} 个已不在磁盘上`);
    if (manifestDisk.unverified > 0) notes.push(`${manifestDisk.unverified} 个没能核对`);
    if (manifestDisk.outside > 0) notes.push(`${manifestDisk.outside} 个在会话目录之外没有核对`);
    if (manifestDisk.removed > 0) notes.push(`${manifestDisk.removed} 个按补丁已被删除 / 移走`);
    if (notes.length) {
      warnings.push(
        `改动清单的磁盘对照（核对 ${manifestDisk.checked} 个会话目录内的路径）：${notes.join('、')}；` +
          '清单记的是会话里写过什么，不代表文件现在的状态，正文「改动过的文件」已逐条标注',
      );
    }
  }

  const result = buildHandoffPrompt(
    turns,
    {
      providerId: adapter.id,
      providerName: adapter.displayName,
      sessionId: foundRef.sessionId,
      sourcePath: foundRef.filePath,
      cwd: foundRef.cwd,
      // 首条有时间戳的记录当起点：首轮缺时间戳时不能把「后面有时间」讲成「没读到时间戳」。
      // 起点不是第一条、或部分轮次缺时间戳时，`buildHandoffPrompt()` 会在括注与 findings 里说明。
      startedAt: turns.map((turn) => toMillis(turn.timestamp)).find((ms) => ms !== undefined),
      updatedAt,
      // 逐轮时间戳是推定值时要说清来路：grok 的行内没有时间，读到的那个数字是锚点
      ...(adapter.timingNote ? { timeRangeNote: adapter.timingNote } : {}),
      ...(badSourceLines > 0 ? { sourceBadLines: badSourceLines } : {}),
      ...(badSourceScan.error ? { sourceBadLinesScanError: badSourceScan.error } : {}),
      ...(emptySourceNote ? { emptySourceNote } : {}),
      usage: sessionUsage,
      ...(usageNote ? { usageNote } : {}),
      ...(usageBadLines > 0 ? { usageBadLines } : {}),
      ...(usageBadLinesScanError ? { usageBadLinesScanError } : {}),
      // 文档会被复制走：这一条必须写在正文里，stderr 的警告不会跟着文档
      ...(autoPicked ? { autoPicked: true } : {}),
      ...(autoPicked && diagnostics.length ? { sourceSelectionWarnings: diagnostics } : {}),
      // 文档会被复制走：这条也必须进正文，不能只留在 stderr。
      // 「有变化」与「无法核对」分开：前者是结论，后者是「不知道」，标签不能共用
      ...(sourceDrift && sourceChange.kind === 'changed' ? { sourceDriftNote: sourceDrift } : {}),
      ...(sourceDrift && sourceChange.kind === 'unverifiable' ? { sourceDriftUnknownNote: sourceDrift } : {}),
      ...(sourceCwdNote ? { sourceCwdNote } : {}),
      ...(sourceWorktreeNote ? { sourceWorktreeNote } : {}),
      ...(sourceWorktreeUnknown ? { sourceWorktreeUnknown } : {}),
      ...(sourceBranchNote ? { sourceBranchNote } : {}),
      ...(sourceBranchUnreadable ? { sourceBranchUnreadable: true } : {}),
    },
    profile,
    { ...(lastUserTurns !== undefined ? { lastUserTurns } : {}), ...(sinceCompact ? { sinceCompact: true } : {}), manifest: manifestPreview, ...(manifestDisk ? { manifestDisk } : {}) },
  );

  // 隐去凭据是对原文的改写：终端 / 脚本侧也要有一句人话，不能只剩 findings 里的一个代码。
  if (result.credentialsMasked) {
    warnings.push(
      `文档里识别并隐去了 ${result.credentialsMasked.total} 个密钥 / 令牌（按固定格式或固定位置识别：${result.credentialsMasked.kinds
        .map((kind) => `${kind.label} ${kind.count}`)
        .join('、')}），正文里出现的地方以「[已隐去：种类]」标出（被截断或未展开的部分不会出现占位符）；原文仍在源文件里，只认固定格式与固定位置，单独出现的口令与其它形式的敏感内容不会被识别，转交前请自行检查`,
    );
  }

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      sessionId: foundRef.sessionId,
      provider: adapter.id,
      cwd: foundRef.cwd,
      ...(sourceCwd ? { sourceCwd } : {}),
      profile: result.profile,
      ...(lastUserTurns !== undefined ? { lastUserTurns } : {}),
      ...(sinceCompact ? { sinceCompact: true } : {}),
      // 脚本要能区分「按 id 查到的」与「替你猜的」：两者的可信度不一样
      ...(autoPicked ? { autoPicked: true } : {}),
      markdown: result.markdown,
      // 来源是 0 字节（内容已丢失）时的结构化结论：正文里那句中文与 warnings 同源，
      // 但脚本不该解析中文；可读的空会话、坏行截断都不出现该字段
      ...(sourceEmptyFile ? { sourceEmptyFile: true } : {}),
      // 与头部「时间范围」括注同源：脚本不必解析 Markdown 才知道时间是推定值、或只覆盖部分轮次
      ...(adapter.timingNote ? { timeRangeNote: adapter.timingNote } : {}),
      ...(result.timestampNote ? { timestampNote: result.timestampNote } : {}),
      // 两个结构化字段（sourceDrift / sourceDriftUnknown）与 switch / open 共用同一个出口：
      // 脚本不能把缺字段当成「没变化」
      ...sourceDriftFields(sourceChange),
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(sourceWorktree ? { sourceWorktree } : {}),
      ...(sourceWorktreeUnknown ? { sourceWorktreeUnknown } : {}),
      stats: result.stats,
      findings: result.findings,
      // 脚本拿得到结构化的改动清单，不必去解析 Markdown 里的那一节。判定与正文同一把尺：
      // 只有「读不出路径的写入」「被截断的清单」这类计数时也要出现，否则脚本分不清
      // 「没有改动」与「改动读不全」（第 343 轮）。
      ...(!isEmptyWorkManifest(result.manifest) ? {
        manifest: {
          files: result.manifest.files,
          commands: result.manifest.commands,
          ...(result.manifest.omittedFiles ? { omittedFiles: result.manifest.omittedFiles } : {}),
          ...(result.manifest.omittedCommands ? { omittedCommands: result.manifest.omittedCommands } : {}),
          ...(result.manifest.omittedCommandCalls ? { omittedCommandCalls: result.manifest.omittedCommandCalls } : {}),
          ...(result.manifest.unreadableWrites ? { unreadableWrites: result.manifest.unreadableWrites } : {}),
          ...(result.manifest.failedFileWrites ? { failedFileWrites: result.manifest.failedFileWrites } : {}),
        },
      } : {}),
      // 磁盘对照的计数：`files[].disk` 缺省既可能是「都还在」也可能是「没核对」，
      // 脚本只有靠这个字段才能分辨，所以核对过就一定出现（哪怕全是 0）。
      ...(result.manifestDisk ? { manifestDisk: result.manifestDisk } : {}),
      // 隐去凭据的计数（只有种类与个数，不含原文）；没识别到时不出现，不等于文档里没有敏感内容。
      ...(result.credentialsMasked ? { credentialsMasked: result.credentialsMasked } : {}),
      // 明确失败的工具调用单独输出：它们不在成功改动清单里，脚本也不该靠解析正文拿这份信息。
      // 没有任何明确失败结果时整个字段都不出现。
      ...(result.manifest.failedAttemptCalls || result.manifest.unclassifiedFailures ? {
        failedAttempts: result.manifest.failedAttempts,
        ...(result.manifest.omittedFailedAttempts ? { failedAttemptsOmitted: result.manifest.omittedFailedAttempts } : {}),
        ...(result.manifest.omittedFailedAttemptCalls ? { failedAttemptsOmittedCalls: result.manifest.omittedFailedAttemptCalls } : {}),
        ...(result.manifest.unclassifiedFailures ? { failedAttemptsUnclassified: result.manifest.unclassifiedFailures } : {}),
      } : {}),
      ...(warnings.length ? { warnings } : {}),
    }));
    return;
  }
  // stdout 只放文档本身：它正是要被 `> seed.md` 或管道拿走的产物。
  // 诊断一律走 stderr，否则重定向后的文件里会混进「警告: …」。
  for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
  for (const line of describeFindings(result.findings)) console.error(`说明: ${line}`);
  // 清单为空时提一句会被当成「这次没改文件」，而实际可能只是入参形状没识别——
  // 所以只在**清单非空**时提示它有多少条，让用户知道正文里多了一节。
  if (result.stats.manifestFiles > 0 || result.stats.manifestCommands > 0) {
    console.error(
      `说明: 正文「改动概览」列出 ${result.stats.manifestFiles} 个文件、${result.stats.manifestCommands} 条命令` +
        `${result.manifest.truncated ? '（有截断，见该节）' : ''}；这份清单覆盖整条会话，不受档位裁剪影响`,
    );
  }
  if (result.manifest.failedAttemptCalls > 0 || result.manifest.unclassifiedFailures > 0) {
    const listedCalls = result.manifest.failedAttempts.reduce((n, attempt) => n + attempt.count, 0);
    console.error(
      `说明: 正文「失败与中断」按工具、路径与命令列出 ${listedCalls} 次明确失败的调用` +
        `${result.manifest.failedAttemptsTruncated ? '（有截断，见该节）' : ''}；这些失败不计入成功改动清单`,
    );
  }
  // 与正文头部「未闭合的工具调用」同一个数：只给计数，不打印 callId。
  if (result.stats.danglingToolCalls > 0) {
    console.error(
      `说明: 来源记录里有 ${result.stats.danglingToolCalls} 次工具调用没有结果（可能在等待用户审批、仍在运行或已中断）；` +
        '正文元信息与「继续工作」已写明，接手前先核对这些调用是否已经执行',
    );
  }
  if (result.stats.unansweredTail) {
    console.error('说明: 来源会话最后停在用户消息上，没有对应的助手回复；正文已写明，接手前先确认这一步要不要继续');
  }
  if (result.stats.omittedTurns > 0 || result.stats.omittedEvents > 0) {
    console.error(
      `提示: 当前档位（${result.profile}）省略了 ${result.stats.omittedTurns} 轮 / ${result.stats.omittedEvents} 条过程记录；` +
        '要保留更多，用 --profile verbose 或 --profile full 重新生成',
    );
  }
  console.log(result.markdown);
}

/**
 * `watch capabilities`：各适配器在**代码层面**实现了哪些读写能力。
 *
 * 刻意不调 `detect()`：这张表是纯元数据，一条命令内即可返回；「本机装没装 / 能不能起来」
 * 是 `watch providers` 的职责（那一步会 spawn 六次 CLI）。把两件事混在一起，脚本想拿
 * 能力矩阵就得先等六次进程探测，某家 CLI 挂起时还会拖住整张表。
 */
function cmdCapabilities(json: boolean, cwdGiven = false): void {
  const providers = describeCapabilities(listAdapters());
  // 同 providers：能力表与目录无关，显式 `--cwd` 不能被静默吞掉
  const cwdIgnored = cwdGiven ? cwdUnusedNote('capabilities') : null;
  if (!json) {
    if (cwdIgnored) console.error(`提示: ${cwdIgnored}`);
    console.log(formatCapabilities(providers));
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    watch: {
      version: readWatchVersion(),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    providers,
    notes: [CAPABILITY_VERIFICATION_NOTE],
    ...(cwdIgnored ? { warnings: [cwdIgnored] } : {}),
  }));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * 「本地库体积」一栏。三个数各自可能读不出来，逐项说清，不拿 0 冒充空库；
 * 有索引内容时必须点明「可由会话文件重建、但链记录只在库里」——否则最自然的
 * 省空间动作（删库）会把链一起删掉，而这条命令正是用户来查体积的地方。
 */
function describeStoreFootprint(f: StoreFootprint): string {
  if (f.ephemeral) return '临时库（WATCH_DB=:memory:），不落盘：链与索引都随命令结束消失';
  const parts: string[] = [];
  if (f.dbBytes === null) {
    parts.push('读不出来（原因见警告）');
  } else if (f.dbBytes === 0) {
    parts.push('尚未创建（还没有成功写入过本地库）');
  } else {
    // SHM 只是进程共享的临时映射（通常 32 KiB、随连接消失），不算进「占了多少盘」，
    // 否则每次都会有个跟内容无关的固定尾巴；它仍保留在 --json 里供排障
    const side = f.walBytes ? ` · WAL ${formatBytes(f.walBytes)}` : '';
    const total = f.dbBytes + (f.walBytes ?? 0);
    parts.push(`合计 ${formatBytes(total)}（watch.db ${formatBytes(f.dbBytes)}${side}）`);
  }
  if (f.indexSessions === null) {
    parts.push('搜索索引规模未知');
  } else if (f.indexSessions === 0) {
    parts.push('搜索索引为空（没跑过 search，或刚被 --reset-index 清空；下次 search 会重建当前目录）');
  } else {
    parts.push(`搜索索引 ${f.indexRows} 段 / ${f.indexSessions} 个会话 / ${f.indexDirectories} 个目录`);
    // 回收动作必须写在能直接照着敲的地方：doctor 是用户来查体积的入口
    parts.push(
      f.reclaimableBytes
        ? `其中 ${formatBytes(f.reclaimableBytes)} 是删除后未释放的页，可回收（watch search <词> --reset-index 只清索引）`
        : '索引内容可由会话文件重建（watch search <词> --reset-index 只清索引）',
    );
    parts.push('链记录只存在这个库里，删库会一并丢失');
  }
  return parts.join('；');
}

/**
 * 「Claude 会话保留」一栏。
 *
 * 只报用户设置里写了什么，不能说成实际生效值：`cleanupPeriodDays` 的 scope 是 Any file，
 * 项目 / local / managed 设置与 CLI 参数都可能覆盖它。默认值也要说清「官方默认」，
 * 因为用户从没设过时 Watch 并没有读到任何东西。
 */
function describeClaudeRetention(r: ClaudeRetentionProbe): string {
  if (r.state === 'unknown') return `无法确认（${escapeControlChars(r.error ?? '原因未知')}；官方默认 ${r.defaultDays} 天）`;
  if (r.state === 'default') {
    return `用户设置未指定 cleanupPeriodDays。官方默认 ${r.defaultDays} 天，项目或管理设置可能覆盖`;
  }
  return `用户设置 cleanupPeriodDays=${r.configuredDays} 天。实际清理期限取决于 Claude Code 加载的全部设置`;
}

/**
 * 「Claude 项目设置」一栏。
 *
 * 只声明这次探测到的文件与值，不把它讲成「Claude Code 最终用的天数」：CLI `--settings`、
 * 工作树 / 子模块的本地设置与管理设置都可能在其上覆盖。普通 Git 仓库的子目录会额外探测
 * 仓库根目录的 `settings.local.json`，探测范围随探针数量声明。
 */
function describeClaudeProjectRetention(probes: ClaudeRetentionProbe[]): string {
  const found: string[] = [];
  for (const probe of probes) {
    const settingsPath = probe.settingsPath ? escapeControlChars(probe.settingsPath) : '项目设置文件';
    if (probe.state === 'unknown') {
      found.push(`${settingsPath} 无法确认（${escapeControlChars(probe.error ?? '原因未知')}）`);
    } else if (probe.state === 'configured') {
      const low = (probe.configuredDays ?? 0) < probe.defaultDays ? '，低于官方默认' : '';
      found.push(`${settingsPath} cleanupPeriodDays=${probe.configuredDays} 天${low}`);
    }
  }
  if (!found.length) found.push('未指定 cleanupPeriodDays');
  const scope =
    probes.length > CLAUDE_PROJECT_SETTINGS_RELATIVE_PATHS.length
      ? '本次探测了当前目录与仓库根目录的 .claude/ 设置'
      : '本次探测了当前目录的 .claude/ 设置';
  return `${found.join('；')}（${scope}）`;
}

/**
 * `watch inspect <id>` 输出会话元数据与结构统计。
 * 复用只读反查与解析，跳过本地库和原生 CLI。
 */
async function cmdInspect(
  json: boolean,
  sessionId: string | undefined,
  provider: string | undefined,
  cwdGiven = false,
): Promise<void> {
  if (!sessionId) usage('inspect 需要会话 id；先用 watch sessions / watch recent 找到它，例：watch inspect <session-id>');
  if (provider && !getAdapter(provider)) fail(json, unknownProviderMessage(provider));

  const diagnostics: string[] = [];
  const misses: LookupMiss[] = [];
  const resolved = await resolveById(sessionId, provider, null, listAdapters(), diagnostics, misses);
  if (!resolved) {
    const headline = lookupMissHeadline('会话', sessionId, misses, provider);
    fail(
      json,
      headline ??
        `未找到会话: ${escapeControlChars(sessionId)}${provider ? `（provider=${provider}）` : ''}。` +
          `请确认 id 正确且对应 CLI 已安装登录。${LOOKUP_NEXT_STEP}`,
    );
  }
  const adapter = resolved.adapter;
  const foundRef = resolved.found.ref;
  const warnings = [...diagnostics];
  // inspect 按 id 全局反查：显式 `--cwd` 不参与任何一步（同 open / prompt <id>）。
  // 不说的话，`inspect <id> --cwd <另一个项目>` 会被读成「只在那个项目里找」
  const cwdIgnored = cwdGiven ? cwdUnusedNote('inspect') : null;
  if (cwdIgnored) warnings.push(cwdIgnored);
  const id = escapeControlChars(foundRef.sessionId);
  const sharedDatabase = adapter.id === 'opencode';
  const recordedUpdatedAt = sharedDatabase ? isoFromEpochMs(resolved.found.updatedAt) || null : null;
  if (sharedDatabase && recordedUpdatedAt === null) {
    warnings.push(`会话 ${id} 的 OpenCode 更新时间缺失或无效`);
  }

  // 文件状态描述存储容器。OpenCode 的会话更新时间来自数据库里的会话记录。
  let sizeBytes: number | null = null;
  let modifiedAt: string | null = null;
  try {
    const probe = await stat(foundRef.filePath);
    sizeBytes = probe.size;
    modifiedAt = probe.mtime.toISOString();
  } catch (error) {
    const storage = sharedDatabase ? '共享数据库文件' : '会话文件';
    warnings.push(`${storage}的大小与修改时间读取失败（${describeReadFailureOrSelf(error)}）`);
  }

  let turns;
  try {
    turns = await adapter.parse(foundRef);
  } catch (error) {
    fail(json, `会话 ${id} 读取失败：${await describePromptSourceReadFailure(foundRef.filePath, error)}；未生成任何内容`);
  }

  // OpenCode 的数据库可通过环境变量指定任意文件名，格式不能只靠后缀判断。
  // 先扫描再判 0 轮：文件被截断时 parse 同样返回 0 轮，不能把「可读、只有系统事件 / 元数据」
  // 当成结论——与 prompt / open / switch 用同一个判据（describeZeroTurnReason）。
  const badScan = !sharedDatabase && foundRef.filePath.endsWith('.jsonl')
    ? await scanUnparsableJsonLines(foundRef.filePath, { allowMissing: false })
    : null;

  if (turns.length === 0) {
    // 0 轮有三种来路（与 prompt / open 同一判据）：0 字节要恢复来源，可读 0 轮要看是有坏行
    // 还是格式没被识别。`badScan` 为 null（opencode / 非 JSONL）时只说格式。
    const emptyReason = await probeSessionReadable(foundRef.filePath);
    if (emptyReason) {
      warnings.push(`会话 ${id} 没有可展示的内容：${emptyReason}`);
    } else if (badScan) {
      warnings.push(
        `会话 ${id}：${describeZeroTurnReason(
          badScan,
          '来源文件可读，但解析出 0 轮内容（可能只有系统事件 / 元数据，或这一家的记录格式还没被识别）',
          badScan.count > 0 || badScan.error ? '需要完整内容请先恢复来源文件' : undefined,
        )}`,
      );
    } else {
      warnings.push('来源文件可读，但解析出 0 轮内容（可能只有系统事件 / 元数据，或这一家的记录格式还没被识别）');
    }
  } else if (badScan) {
    // 0 轮时上面那句已连同行数说过，这里不重复同一件事
    if (badScan.count > 0) {
      warnings.push(`来源会话 ${id} 有 ${badScan.count} 行无法解析（截断或损坏），结构计数不含这些记录`);
    }
    const failure = describeBadLinesScanFailure(badScan, `来源会话 ${id}`, '先确认该文件可读再重试');
    if (failure) warnings.push(failure);
  }

  let tokenUsage: TokenUsage | null = null;
  let usageNote: string | undefined;
  let usageBadLines = 0;
  let usageBadLinesScanError: string | undefined;
  if (adapter.sessionUsage) {
    try {
      tokenUsage = await adapter.sessionUsage(foundRef);
    } catch (error) {
      usageNote = `用量读取失败（${describeReadFailureOrSelf(error)}）；这不代表来源会话没有用量`;
      warnings.push(usageNote);
    }
    if (tokenUsage === null && !usageNote) {
      const sidecar = await usageSidecarProblem(adapter, foundRef, '来源会话');
      if (sidecar) {
        usageNote = sidecar;
        warnings.push(sidecar);
      }
    }
    // 坏行让合计**静默偏少**：与 `watch usage` / `watch prompt` / `open` 共用同一份扫描与判据。
    // `inspect` 的用途就是回答「读到了什么、少了什么」，用量这一半此前只有内容坏行没有它。
    // 内容扫描（`badScan`）已经读过同一个文件时直接复用：绝大多数 provider 的用量数据源
    // 就是 `ref.filePath`，不必为同一份行再扫一遍整文件；旁路文件由函数内部挡住。
    const badUsage = await usageBadLinesDetail(adapter, foundRef, '来源会话', { knownScan: badScan ?? undefined });
    if (badUsage) {
      usageBadLines = badUsage.count;
      if (badUsage.scanFailed) usageBadLinesScanError = badUsage.scanError;
      warnings.push(badUsage.reason);
    }
  }

  const structure = summarizeSessionStructure(turns);
  // 逐轮时间由适配器推定时（如 Grok），时间范围必须带来源说明，与 prompt 的 timeRangeNote 同源。
  const timeRangeNote = adapter.timingNote && structure.firstTimestamp ? adapter.timingNote : undefined;
  const timestampNote = structure.timestampedTurns < structure.turns
    ? `${structure.timestampedTurns}/${structure.turns} 轮有时间戳`
    : undefined;
  const rangeNotes = [timeRangeNote, timestampNote].filter(Boolean);
  // 会话记录里的工作目录（不是本次进程的 cwd）：文本有 cwdNote，脚本需要的结构化版本
  // 用 `recordedCwdState` 单独命名——`inspect` 不接受 `--cwd`，叫 cwdState 会被读成本次参数
  const recordedCwdProbe = foundRef.cwd ? await inspectCwd(foundRef.cwd) : null;
  const cwdNote = foundRef.cwd && recordedCwdProbe ? describeRecordedCwd(recordedCwdProbe, foundRef.cwd) : null;
  if (cwdNote) warnings.push(cwdNote);

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        session: {
          id: foundRef.sessionId,
          provider: adapter.id,
          filePath: foundRef.filePath,
          sizeBytes,
          modifiedAt,
          storageScope: sharedDatabase ? 'shared-database' : 'session-file',
          ...(sharedDatabase ? { recordedUpdatedAt } : {}),
          recordedCwd: foundRef.cwd || null,
          ...(recordedCwdProbe && recordedCwdProbe.state !== 'ok' ? { recordedCwdState: recordedCwdProbe } : {}),
          ...(cwdNote ? { cwdNote } : {}),
        },
        structure,
        ...(timeRangeNote ? { timeRangeNote } : {}),
        ...(timestampNote ? { timestampNote } : {}),
        badLines: badScan?.count ?? null,
        badLinesStatus: badScan ? (badScan.error ? 'incomplete' : 'complete') : 'not-applicable',
        usage: tokenUsage,
        ...(usageBadLines > 0 ? { usageBadLines } : {}),
        ...(usageBadLinesScanError ? { usageBadLinesScanError } : {}),
        ...(usageNote ? { usageNote } : {}),
        ...(warnings.length ? { warnings } : {}),
      }),
    );
    return;
  }

  for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
  const fileLine = sizeBytes === null ? escapeControlChars(foundRef.filePath) : `${escapeControlChars(foundRef.filePath)}（${formatBytes(sizeBytes)}${modifiedAt ? `，修改于 ${modifiedAt}` : ''}）`;
  console.log(`会话: ${id}（${adapter.id}）`);
  console.log(`${sharedDatabase ? '共享数据库文件' : '文件'}: ${fileLine}`);
  if (sharedDatabase) console.log(`会话更新时间: ${recordedUpdatedAt ?? '不可用'}`);
  if (foundRef.cwd) console.log(`记录的工作目录: ${escapeControlChars(foundRef.cwd)}`);
  console.log(`轮次: ${structure.turns}（user ${structure.userTurns} · assistant ${structure.assistantTurns}）`);
  console.log(
    structure.firstTimestamp && structure.lastTimestamp
      ? `时间范围: ${structure.firstTimestamp} → ${structure.lastTimestamp}${rangeNotes.length ? `（${rangeNotes.join('；')}）` : ''}`
      : `时间范围: 没有可用的时间戳${timestampNote ? `（${timestampNote}）` : ''}`,
  );
  const toolResultNotes = [
    structure.events.failedToolResults ? `失败 ${structure.events.failedToolResults}` : null,
    structure.events.danglingToolCalls ? `未闭合 ${structure.events.danglingToolCalls}` : null,
    structure.events.orphanToolResults ? `孤立结果 ${structure.events.orphanToolResults}` : null,
  ].filter(Boolean);
  console.log(
    `事件: text ${structure.events.text} · thinking ${structure.events.thinking} · tool_call ${structure.events.toolCalls} · tool_result ${structure.events.toolResults}${toolResultNotes.length ? `（${toolResultNotes.join('；')}）` : ''}`,
  );
  console.log(
    structure.tools.length
      ? `工具: ${formatToolCounts(structure.tools)}`
      : '工具: 没有工具调用',
  );
  console.log(`附件: 图片 ${structure.attachments.images} · 文件 ${structure.attachments.files}`);
  if (structure.incompleteTurns) console.log(`未完成轮次: ${structure.incompleteTurns}（来源停在非终态的阶段回复）`);
  if (structure.disclosureEvents) console.log(`上下文披露: ${structure.disclosureEvents} 条事件（仅计数）`);
  if (!badScan) console.log('坏行: 不适用（仅扫描 JSONL 会话）');
  else if (badScan.error) console.log(`坏行: 扫描未完成（已确认 ${badScan.count} 行，原因见警告）`);
  else console.log(`坏行: ${badScan.count}`);
  // 用量数字必须带上下界说明：坏行没计入时「输入/输出」是下界，扫描没完成时连程度都不知道。
  // 与 `watch usage` / `watch prompt` / `open` 同一判据（`usageBadLinesDetail()`）。
  const usageBadNote = [
    usageBadLines > 0 ? `用量数据源有 ${usageBadLines} 行无法解析，这些行没有计入，合计可能偏少` : null,
    usageBadLinesScanError
      ? `用量数据源的坏行无法统计（${escapeControlChars(usageBadLinesScanError)}），合计可能偏少且无法确认程度`
      : null,
  ].filter(Boolean).join('；');
  const usageSuffix = usageBadNote ? `（${usageBadNote}）` : '';
  if (tokenUsage) console.log(`用量: 输入 ${tokenUsage.inputTokens} · 输出 ${tokenUsage.outputTokens}${usageSuffix}`);
  else if (usageNote) console.log(`用量: 不可用（${escapeControlChars(usageNote)}）`);
  else if (!adapter.sessionUsage) console.log('用量: 该 provider 不提供用量记录');
  else console.log(`用量: 没有可读的用量记录${usageSuffix}`);
  console.log('（输出含会话标识、本机路径和工具名。公开前请核对这些字段。）');
}

async function cmdDoctor(cwd: string, json: boolean, strict: boolean): Promise<void> {
  try {
    // `openStore()` 会创建目录、建库并迁移；先记下库文件原来在不在，报告里点名「本次诊断新建」。
    // `:memory:` 不落盘，不算新建。打开失败时说不清文件是怎么留下的，不置这一位。
    const dbPath = process.env.WATCH_DB ?? defaultDbPath();
    const storeFileExisted = dbPath === ':memory:' || existsSync(dbPath);
    const store = openStore();
    let importJobs: ImportJobs | null = null;
    let importsRoot: string | undefined;
    let importJobsError: string | undefined;
    try {
      importsRoot = officialImportJournalRoot();
      importJobs = new ImportJobs(importsRoot);
    } catch (error) {
      importJobsError = process.env.WATCH_DB === ':memory:'
        ? 'WATCH_DB=:memory: 不落盘，没有导入日志'
        : error instanceof Error ? error.message : String(error);
    }
    const report = await doctorReport(cwd, { store, storeError: lastStoreError ?? undefined, importJobs, importJobsError, importsRoot,
      storeCreated: store !== null && !storeFileExisted,
      // 「本目录 0 条链」在 :memory: 下同样是一句结论：排障入口说不出库是临时的，
      // 用户得到的唯一解释就是「你从来没建过链」
      ...(ephemeralDb ? { ephemeralNote: ephemeralStoreWarning('本目录 0 条链来自这份临时库，它每条命令都是空的') } : {}),
    });
    // 退出码与 `open --check` 同一口径：`ok` 只表示「诊断这个动作跑通了」，
    // 检查结论在 `summary` 里。以前 doctor 无论发现什么都 exit 0，CI / 脚本拿它当
    // 健康检查时会被骗过——本地库打不开、链尾全坏，退出码仍是 0。
    // 只有硬失败让默认退出码非零；`--strict` 才把警告也升成非零（与 mcp-doctor /
    // medic 这类诊断 CLI 的约定一致）。
    const failed = report.summary.status === 'fail';
    const strictFailed = strict && report.warnings.length > 0;
    if (json) {
      console.log(JSON.stringify({ ok: true, ...report }));
      if (failed || strictFailed) process.exitCode = 1;
      return;
    }
    const env = report.environment;
    console.log(`诊断 cwd: ${escapeControlChars(report.cwd)}`);
    console.log(`环境: watch ${env.watchVersion ?? '未知版本'} · node ${env.node} · ${env.platform}`);
    console.log(`本地库文件: ${escapeControlChars(env.dbPath)}${report.store.available && report.store.created ? '（本次诊断新建）' : ''}`);
    console.log(`本地库体积: ${describeStoreFootprint(report.storeFootprint)}`);
    console.log(`导入日志目录: ${env.importsRoot ? escapeControlChars(env.importsRoot) : '（不可用）'}`);
    console.log('Agent 检测:');
    for (const p of report.providers) {
      const state = p.available ? '✓ 已就绪' : p.error ? `✗ 检测失败: ${p.error}` : '✗ 未检测到';
      console.log(`  ${p.id.padEnd(10)} ${p.displayName.padEnd(12)} ${state}`);
    }
    console.log(`Claude 会话保留: ${describeClaudeRetention(report.claudeRetention)}`);
    console.log(`Claude 项目设置: ${describeClaudeProjectRetention(report.claudeProjectRetention)}`);
    if (report.storage.length) {
      console.log('会话存储:');
      for (const st of report.storage) {
        // 「连归属都读不出来」的条目不属于任何目录，所以只能挂在全局计数旁边说；
        // 不加这一句，用户看到的「0 个会话」就是结论，而那条会话可能只是被截断了。
        // 位置（工作区分组）与会话文件分开数：一个分组里可能有若干会话，不能并进同一个数字。
        const unattributableBits = [
          ...(st.unattributable ? [`${st.unattributable} 个文件读不出目录归属`] : []),
          ...(st.unattributableLocations
            ? [`${st.unattributableLocations} 个位置读不出来（里面可能还有会话）`]
            : []),
        ];
        const unattributableText = unattributableBits.length
          ? `（另有 ${unattributableBits.join('、')}，未计入）`
          : '';
        const countText =
          st.count === null
            ? `✗ 读取失败: ${st.error}${unattributableText}`
            : st.capped
              ? `≥ ${st.count} 个会话（已达列表上限，实际可能更多${st.unreadable ? `，其中 ${st.unreadable} 条读不出来` : ''}）${unattributableText}`
              : `${st.count} 个会话${st.unreadable ? `（${st.unreadable} 条读不出来）` : ''}${unattributableText}`;
        console.log(`  ${st.provider.padEnd(10)} ${countText}`);
        // 只读存储是「已知且能读」的状态，不进 warnings（--strict 不该因此常红）；
        // 探测失败才是降级，已经在上面的警告里说过，这里只补一行「未确认」
        if (st.writeLimit) {
          console.log(`  写入受限（${escapeControlChars(st.writeLimit.code)}）: ${escapeControlChars(st.writeLimit.reason)}`);
          if (st.writeLimit.hint) console.log(`    ${escapeControlChars(st.writeLimit.hint)}`);
        }
        if (st.writeLimitError) console.log(`  写入能力未确认: ${escapeControlChars(st.writeLimitError)}`);
      }
    }
    if (report.store.available) {
      const compressed = report.store.brokenTips.filter((b) => b.compressedPath && !b.compressedEmpty).length;
      const compressedEmpty = report.store.brokenTips.filter((b) => b.compressedPath && b.compressedEmpty).length;
      const broken = report.store.brokenTips.filter((b) => b.missing && !b.compressedPath).length;
      const unreadable = report.store.brokenTips.filter((b) => b.unreadable).length;
      const unknown = report.store.brokenTips.length - broken - compressed - compressedEmpty - unreadable;
      const drifted = report.store.driftedPairs.length;
      const empty = report.store.emptyTips.length;
      // 摘要里的「链尾是空的」不能把截断文件算成健康空会话：明细行会说坏行，
      // 但只看摘要的人会以为这些链可以继续聊
      const emptyDamaged = report.store.emptyTips.filter(
        (e) => e.badLines && (e.badLines.count > 0 || e.badLines.error),
      ).length;
      console.log(
        `本地库: 可用，本目录 ${report.store.chains} 条链（${report.store.activeChains} 条活跃${broken ? `，${broken} 条链尾缺失` : ''}${compressed ? `，${compressed} 条链尾只剩压缩副本` : ''}${compressedEmpty ? `，${compressedEmpty} 条链尾只剩 0 字节压缩副本（内容已丢失）` : ''}${unreadable ? `，${unreadable} 条链尾读不出来` : ''}${unknown ? `，${unknown} 条链尾状态无法确认` : ''}${drifted ? `，${drifted} 条链尾内容落后于来源` : ''}${empty ? `，${empty} 条链尾是空的（0 轮${emptyDamaged ? `，其中 ${emptyDamaged} 条文件有坏行或扫描未完成` : ''}）` : ''}）`,
      );
      // 上一行是结论：本目录没有链。别处有链时必须接着指路，否则会被当成链丢了 / 没建成功。
      // 「同一个目录的另一种写法」不是「别的目录」：两种说法分开，否则用户会以为链不在这个项目里
      if (!report.store.chains && report.store.chainsElsewhere.length) {
        const sameDir = report.store.chainsElsewhere.filter((r) => r.sameDirectory);
        const otherDir = report.store.chainsElsewhere.filter((r) => !r.sameDirectory);
        if (sameDir.length) console.log(chainsSameDirectoryHint(sameDir));
        if (otherDir.length) console.log(chainsElsewhereHint(otherDir));
      }
      for (const d of report.store.driftedPairs) {
        console.log(
          `  链「${escapeControlChars(d.chainName)}」: ${escapeControlChars(d.from.provider)}:${escapeControlChars(d.from.sessionId)} → ${escapeControlChars(d.to.provider)}:${escapeControlChars(d.to.sessionId)}，缺 ${d.missingTurns}/${d.sourceTurns} 条`,
        );
      }
      // 摘要行只报个数；缺的是哪条链尾必须直接给 provider:sessionId，否则照「可先 watch switch」也无法定位。
      // 读不出来 ≠ 已删除：EACCES 等状态下让人 adopt 等于白换一次绑定
      for (const b of report.store.brokenTips) {
        console.log(
          b.compressedPath
            ? b.compressedEmpty
              ? `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾只剩 0 字节压缩副本（${escapeControlChars(b.compressedPath)}）；内容已丢失，重新展开也拿不回内容——从备份恢复；${rebindHint(b.provider)}`
              : `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾只剩压缩副本（${escapeControlChars(b.compressedPath)}）；本版不读压缩格式——先让它重新展开再重试（若是 Codex 压缩的，在 Codex 里继续该会话即可），或者${rebindHint(b.provider)}`
            : b.missing
            ? `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾文件已不存在（${escapeControlChars(b.filePath)}），${rebindHint(b.provider)}`
            : b.unreadable
              ? b.emptyFile
                ? `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾文件是空的（${escapeControlChars(b.filePath)}，${escapeControlChars(b.error)}）；内容已丢失，resume 没有内容可恢复——先从备份恢复（Watch 不会替你重建历史），或${rebindHint(b.provider)}`
                : `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾文件读不出来（${escapeControlChars(b.filePath)}，${escapeControlChars(b.error)}）；resume 与下次切换都会失败——先修好这个文件（权限或内容），或 watch switch ${b.provider} 重新绑定`
              : `  链「${escapeControlChars(b.chainName)}」: ${escapeControlChars(b.provider)}:${escapeControlChars(b.sessionId)} 链尾文件状态无法确认（${escapeControlChars(b.filePath)}，${escapeControlChars(b.error)}）；先确认文件是否还在，再决定是否需要 adopt`,
        );
      }
      // 摘要里已经报了个数；这里给出是哪条链尾、为什么打开是空的，以及下一步。
      // 不给 provider:sessionId，用户照「watch switch」也无法定位到具体会话
      for (const e of report.store.emptyTips) {
        // 与同一份 doctor 的 warnings 同档：有坏行时不能再说「没聊过属正常」，
        // 更不能把截断文件说成刚建出来的空会话——两者下一步相反
        const damaged = Boolean(e.badLines && (e.badLines.count > 0 || e.badLines.error));
        const detail = e.badLines && damaged
          ? e.badLines.error && !e.badLines.count
            ? '（解析出 0 轮，坏行扫描未完成）'
            : `（解析出 0 轮，文件有 ${e.badLines.count} 行无法解析）`
          : '（解析出 0 轮）';
        const next = damaged
          ? '更可能是文件被截断或损坏，先从备份恢复该文件，或'
          : '如果在原生客户端里还没聊过属正常，否则从备份恢复该文件，或';
        console.log(
          `  链「${escapeControlChars(e.chainName)}」: ${escapeControlChars(e.provider)}:${escapeControlChars(e.sessionId)} 链尾是空的${detail}；${damaged ? 'resume 打开的内容可能不完整' : 'resume 打开就是空会话'}——${next} watch switch ${e.provider} 重新绑定，或 watch chain new <新名字> 另起一条链`,
        );
      }
    } else {
      console.log(`本地库: 不可用（${escapeControlChars(report.store.error)}）`);
    }
    if (report.imports.available) {
      const i = report.imports;
      console.log(`导入日志: ${i.total} 条（imported ${i.imported} / associated ${i.associated} / uncertain ${i.uncertain} / prepared ${i.prepared}）`);
      // 「不要重试」只有配上 planId 才能执行；否则用户只知道有 N 个未知结果，找不到是哪一个
      for (const id of i.uncertainIds) {
        console.log(`  结果未知: ${escapeControlChars(id)}（用 watch import-codex status ${escapeControlChars(id)} 查看；勿重试、勿删日志）`);
      }
      // 逐条行与 JSON 都只保留前 10 条：不说明剩余数量时，用户会以为「结果未知」就只有这 10 个
      if (i.uncertain > i.uncertainIds.length) {
        console.log(`  另有 ${i.uncertain - i.uncertainIds.length} 个结果未知的计划未逐条列出；用 watch import-codex list 查看完整列表`);
      }
      // 读不出来的日志没进 total，不逐条说就只是「总数比实际少」，看不出是哪几份
      for (const j of i.skippedJournals) {
        console.log(`  读取失败（未计入上面的统计）: ${escapeControlChars(j.id)}（${escapeControlChars(j.reason)}）`);
      }
      if (i.skipped > i.skippedJournals.length) {
        console.log(`  另有 ${i.skipped - i.skippedJournals.length} 份读取失败的日志未逐条列出；完整清单与原因见 watch import-codex list --json 的 skipped`);
      }
      // 不是计划目录的条目以前被静默跳过，「共 N 条」与目录里实际有的对不上
      for (const e of i.ignoredEntries) {
        console.log(`  不是计划目录（未计入统计）: ${escapeControlChars(e.name)}（${escapeControlChars(e.reason)}）`);
      }
      if (i.ignored > i.ignoredEntries.length) {
        console.log(`  另有 ${i.ignored - i.ignoredEntries.length} 个非常规条目未逐条列出；完整清单与原因见 watch import-codex list --json 的 ignored`);
      }
    } else {
      console.log(`导入日志: 不可用（${escapeControlChars(report.imports.error)}）`);
    }
    if (report.warnings.length) {
      console.error('警告:');
      // 与其余命令的 warnings 打印点同一口径：报告里的会话 id / 路径来自不可信存储
      for (const w of report.warnings) console.error(`  - ${escapeControlChars(w)}`);
    }
    // 结论行必须在 stdout 最后：`watch doctor | tail -1` 与只看退出码的脚本要拿到同一句话
    const s = report.summary;
    if (failed) {
      console.log(`结论: ${s.failures.length} 项失败（退出码 1）：${s.failures.map((f) => escapeControlChars(f)).join('、')}；先按上面的失败项修复再重试`);
    } else if (strictFailed) {
      console.log(`结论: 通过，有 ${s.warnings} 条警告（--strict 下退出码 1）`);
    } else if (s.warnings > 0) {
      console.log(`结论: 通过，有 ${s.warnings} 条警告；加 --strict 可让警告也返回非零退出码`);
    } else {
      console.log('结论: 通过');
    }
    if (failed || strictFailed) process.exitCode = 1;
  } catch (error) {
    // 查询类命令同样会撞上坏库（`search_index` 缺列、`messages_fts` 缺表…）：
    // 裸 SQLite 原文既不说这是库的问题，也给不出重建的下一步
    fail(json, describeCommandError(error));
  }
}

/**
 * `new` 在不可用目录上仍然成功时的警告。
 *
 * 以前这里直接复用查询类的 `cwdProblem()`：「各 provider …路径不对会全部显示 0」——那是
 * 「列不出会话」的后果，而 `new` 已经把会话写进原生存储、还写了一条链绑定，真正的问题是
 * 打印出来的 resume 命令进不去那个目录。不说会话文件路径的话，用户连「这次多出来的文件
 * 是哪一个」都不知道，更没法清理或挪走。
 */
function newSessionCwdWarning(reason: string, filePath: string): string {
  return (
    `${reason}；会话文件：${escapeControlChars(filePath)}，它绑定的项目目录进不去——打印的 resume 命令会在这里失败。` +
    `先创建 / 修复该目录再 resume，或改用 --cwd 指向正确的项目目录后重跑`
  );
}

/**
 * `chain new` 在不可用目录上仍然成功时的警告。
 *
 * 与 `new` 同一处坑：这个分支复用了查询类的 `cwdProblem()`（「路径不对会全部显示 0」），可这条
 * 命令没有任何列表参与，真正发生的是**一条绑定到这个路径的链记录已经写进本地库**。而且那个说法
 * 在这个场景下并不成立：链按 `--cwd` 原字符串分组、不依赖目录是否存在，所以 `status` /
 * `chain list` 带同一个 `--cwd` 仍然列得出来（2026-11-09 实测），只是那边永远扫不到会话——
 * `switch` 会失败，`new` 建出的会话 resume 也会在进入目录那一步失败。
 * 链的 cwd 在创建时定死、没有「改名 / 移动目录」的命令，所以下一步只能是修好目录或另建一条。
 */
function chainCwdWarning(reason: string, chainName: string): string {
  return (
    `${reason}；链「${escapeControlChars(chainName)}」已经按这个路径写进本地库（链记录不依赖目录存在），` +
    '但那个目录里永远扫不到原生会话：之后带同一个 --cwd 的 status / chain list 能看到这条链、会话却是 0 条，' +
    'switch 会失败，new 建出的会话 resume 也会在进入目录那一步失败。' +
    '先创建 / 恢复该目录，或改用正确的 --cwd 另建一条（链记录的工作目录在创建时定死，没有改名 / 移动的办法；' +
    '旧的那条可用 watch chain archive 归档）'
  );
}

async function cmdNew(cwd: string, providerId: string, json: boolean, chain?: string): Promise<void> {
  // provider id 是注册表键，归一无损（与 cmdSwitch 同一段论证）
  providerId = trimUserKey(providerId);
  const store = openStore();
  const warnings: string[] = [];
  // 与 switch / adopt 同一处根因：两条分支都经 getOrCreateChainSession() → touchChain()
  // 抬高 `--chain` 指定那条链的 last_used_at，而「当前链」就是按它算的。先记下来，写完如实说明。
  // 这一读只为事后对比，读不出来不能让整条写命令崩在 try 外面（见 safeActiveChain）
  const chainProbe: string[] = [];
  const previousChain = safeActiveChain(store, cwd, chainProbe);
  // 「当前链没读成」是这次操作本身的降级原因：两条成功分支都要带出（已有链分支会并进 allWarnings），
  // 失败分支在 catch 里按「原因本身是不是库故障」决定要不要补
  warnings.push(...chainProbe);
  // 目录不可用时 `new` 与查询类命令的后果完全不同：查询只是「列不出会话、显示 0」，
  // 而 `new` 会真的把会话写进原生存储（claude / pi / grok 落在自家目录，kimi 还要在 cwd 里跑一次 CLI），
  // 再往链上写一条绑定；随后打印的 resume 命令会在进入目录这一步失败。
  // 所以两种口径分开生成：失败路径（链查不到 / 抛出异常）仍用查询类的 `cwdIssue` 拼在前面，
  // 成功路径用写入口径，并在会话真的建出来之后补上它的文件路径。
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  const cwdWriteIssue = describeWriteCwd(cwdProbe, cwd);
  // 与 `chain new` 同一处根因：两条成功分支都会把链记录写到这个 `--cwd` 下，而链按字符串分组，
  // 同一个目录换个写法就是另一组。写之前先记下本目录已有的链名，写完之后用差集认出「这次新建的
  // 是哪一条」，交给 `aliasChainGroupWarning()` 与那个写法下的链对账
  const chainsBefore = chainNamesOf(store, cwd);
  const aliasWarnings = async (): Promise<void> => {
    const created = newChainName(chainsBefore, chainNamesOf(store, cwd));
    const issue = await aliasChainGroupWarning(store, cwd, created);
    if (issue) warnings.push(issue);
  };
  if (!store) {
    // 会话本身能建出来，但没有 switch_events：后续 switch 不认这条绑定，必须说明。
    // 原因同样要走 `storeUnavailableWarning()`：只说「未写入链记录」时用户不知道该修权限、
    // 修路径还是换 WATCH_DB，而原因里本来就带着路径与下一步。
    warnings.push(
      storeUnavailableWarning('本次新会话未写入链记录（后续切换不会认同这条绑定）', lastStoreError ?? undefined),
    );
  } else if (ephemeralDb) {
    // `:memory:` 时库是好的、绑定也写进去了，但它随进程消失：会话文件是真的，
    // 链记录却没有。不说的话 `new` 的 ok:true + resume 会被读成「链上已经记好了」
    warnings.push(ephemeralStoreWarning('本次新会话的链记录（链尾 / 切换记录）只在这份临时库里'));
  }
  try {
    let historyLen = 0;
    if (store) {
      const id = store.findActiveChain(cwd, chain)?.id ?? null;
      if (chain && !id) failWithCwd(json, cwdIssue, store.missingChainMessage(cwd, chain));
      // 归档链以前要等建完会话、写完 switch_events 才被拒：原生存储里于是留下一个谁也没绑定的
      // 会话文件（每跑一次多一个），命令还返回 ok:true + 「链记录失败…库操作失败（链已归档）」。
      // 失败原因在第一行就能确定，不能先建会话
      const archived = store.archivedChainName(cwd, chain);
      if (archived) {
        failWithCwd(json, cwdIssue, `链已归档: ${archived}；可 watch chain use ${archived} 恢复，或省略 --chain 用当前链`);
      }
      historyLen = id ? store.listSwitchEvents(id).length : 0;
    }
    // 空链：优先用 nezha 式 createEmptySession 预创建可 resume 的空会话，
    // 不再 exec 发首条消息；由桌面端 PTY 执行 resume 命令后用户直接在 TUI 交互。
    // 没有 createEmptySession 的 provider 才回退到 start（exec 等首条回复，慢）。
    if (historyLen === 0) {
      const adapter = getAdapter(providerId);
      if (!adapter) fail(json, unknownProviderMessage(providerId));
      // 空链也会写原生存储；与已有链交接一样，先检查本家已知的写入限制。
      await adapter.preflight?.({ cwd });
      let ref: import('./core/types.js').SessionRef;
      // 轮数取**实际解析结果**，不写死。createEmptySession 各家写出的占位不同：claude / pi 写一条
      // 占位 user 消息（parse 出 1 轮），codex / grok / opencode 只写 rollout 头或空会话（0 轮）。
      // 以前这里恒为 0，于是同一条刚建好的 claude / pi 会话，`new` 说 0 轮、`chain list` / `status`
      // 的链尾说 1 轮（2026-11-17 实测）——同一份数据两条命令两种结论，用户无从判断哪边对。
      // 解析失败时保持 undefined（JSON 里不出现这个键）并披露，不拿 0 冒充「没有内容」。
      let turnCount: number | undefined;
      // 两个分支都会写原生存储（kimi 还要真跑一次 CLI 建会话）：失败时抛的是 Node 原文，
      // 用户看不出是权限、磁盘还是命令没装。spawn 的 errno 与文件系统同码（都是 ENOENT / EACCES），
      // 所以先按 syscall 认 spawn，再按写盘翻译，剩下的（适配器自己的中文说明）原样带出。
      const create = async <T>(run: Promise<T>): Promise<T> => {
        try {
          return await run;
        } catch (error) {
          const reason = describeSpawnFailure(error) ?? describeWriteFailureReason(error);
          throw reason ? new Error(`新建 ${providerId} 会话失败：${reason}`) : error;
        }
      };
      if (adapter.createEmptySession) {
        ref = await create(adapter.createEmptySession(cwd));
        try {
          turnCount = (await adapter.parse(ref)).length;
        } catch (error) {
          // 会话已经建好：解析失败不能让整条命令报失败，但也不能报 0 轮——那是「没有内容」的说法。
          warnings.push(
            `新会话已创建，但读不出它的内容、无法确认轮数：${describeReadFailureOrSelf(error)}；resume 打开后可以先确认这条会话是否正常`,
          );
        }
      } else if (adapter.start) {
        const started = await create(adapter.start(cwd, '我们开始吧。'));
        ref = started.ref;
        turnCount = 1;
      } else {
        fail(json, `${providerId} 不支持从零开聊`);
      }
      // 这里有两个不同的事实：链行是否已建（`chains` 表）、切换记录是否写成（`switch_events` 表）。
      // `getOrCreateChainSession()` 先建链行再 `recordSwitch()`，后者失败时链行已经提交——
      // 别名组警告讲的是「这个 --cwd 写法下多了一条链」，只要链行写成就是真的（第 310 轮审查：
      // 第 309 轮把门禁挂在 `recordSwitch` 之后，等于把一条真实的两组链警告吞掉了）。
      let chainGroupWritten = false;
      let chainRecordState: 'written' | 'failed' | 'not-attempted' = 'not-attempted';
      if (store) {
        try {
          const id = store.getOrCreateChainSession(cwd, chain);
          chainGroupWritten = true;
          // 把首开聊记录为链的起点，后续 handoff 才能正确判断链尾
          store.recordSwitch(id, null, null, providerId, ref);
          chainRecordState = 'written';
        } catch (error) {
          chainRecordState = 'failed';
          // 会话已经建出来了，不能因为写链失败整条命令报错（用户拿到的 ref 仍可 resume），
          // 但后续 switch 不会认这条绑定，必须说明——否则 status 里看不到它却毫无提示。
          // 措辞分开：链行都没建成时说「链记录失败」，只有切换记录失败时说「切换记录失败」，
          // 免得与随后那条「这次建了链」的别名组警告互相矛盾。
          console.error(
            '[watch] 记录 switch_events 失败，新会话仍已创建:',
            escapeControlChars(describeStoreErrorReason(error)),
          );
          warnings.push(
            (chainGroupWritten ? '切换记录失败' : '链记录失败') +
              `，后续切换不会认这条绑定：${describeStoreErrorReason(error)}`,
          );
        }
      }
      // 会话已经建出来、链绑定也写好了，但目录进不去：与查询类命令不同，这里必须说清
      // 「已经写进去的是什么」以及「resume 会失败」，否则 ok:true + resume 会被读成马上能用
      if (cwdWriteIssue) warnings.push(newSessionCwdWarning(cwdWriteIssue, ref.filePath));
      // 链行写成（无论切换记录是否写成）：同一个目录的另一种写法下若已有链，说明会有两组（见 helper）
      if (chainGroupWritten) await aliasWarnings();
      const resumeCommand = adapter.resumeCommand(ref);
      warnings.push(...commandControlWarnings(resumeCommand));
      // 空链分支同样会 touchChain（getOrCreateChainSession 在建会话之后就跑过）
      const currentChain = safeActiveChain(store, cwd, warnings);
      const shiftNote = currentChainShiftNote(previousChain, currentChain);
      for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            newRef: ref,
            resumeCommand,
            turnCount,
            fromProvider: providerId,
            // 写入已经发生：这里不是「操作被阻止」，而是告诉脚本 resume 会在一个不可用的目录里失败
            ...cwdStateField(cwdProbe),
            // 会话已经建好，但链记录没落库：后续切换不会认这条绑定
            ...chainRecordFields(store, chainRecordState),
            ...(shiftNote ? { previousChain, currentChain } : {}),
            ...(warnings.length || shiftNote ? { warnings: shiftNote ? [...warnings, shiftNote] : warnings } : {}),
          }),
        );
        return;
      }
      console.log(
        `新会话: ${escapeControlChars(ref.sessionId)}${turnCount === undefined ? '' : turnCount === 0 ? '（解析出 0 轮，空会话）' : `（${turnCount} 轮）`}`,
      );
      console.log(`resume: ${escapeControlChars(resumeCommand)}`);
      // 结果说明走 stdout（同 switch / adopt / chain new 的位置），不是降级警告。
      // 0 轮是新会话的正常状态（createEmptySession 只写占位头），说清「打开后直接开聊」，
      // 不让人以为建坏了；解析失败（turnCount 未定义）已由上面的警告说明。
      if (turnCount === 0) {
        console.log(
          `\n这条会话里还没有对话内容；这是新会话的正常状态，resume 打开后在 ${adapter.displayName} 里直接开始对话即可`,
        );
      }
      if (shiftNote) console.log(`\n${shiftNote}`);
      return;
    }

    const result = await createChainSession(providerId, cwd, listAdapters(), getAdapter, store, chain);
    // 链已存在时的表单同样要带出 cwd / 读库 / 交接降级说明，不能只在空链分支打印
    // 先把「另一种写法下已有链」并进 warnings，再由这里统一带出（两条通道共用同一份）。
    // 只有这次真的写了切换记录（written）才谈得上「这次写了链记录」：alreadyAtTarget /
    // 链记录失败时这句是假话（第 309/310 轮）。
    if (result.chainRecordState === 'written') await aliasWarnings();
    const allWarnings = [...warnings, ...result.warnings, ...commandControlWarnings(result.resumeCommand)];
    // 已有链分支可能复用配对会话，也可能新建；无论哪种，只要目录进不去，resume 都会在这一步失败
    if (cwdWriteIssue) allWarnings.push(newSessionCwdWarning(cwdWriteIssue, result.newRef.filePath));
    // createChainSession() 内部同样经 getOrCreateChainSession() 写 last_used_at
    const currentChain = safeActiveChain(store, cwd, allWarnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          ...publicResult(result),
          // 同空链分支：会话与链记录已经写入，但 resume 会在不可用的 --cwd 上失败
          ...cwdStateField(cwdProbe),
          ...chainRecordFields(store, result.chainRecordState),
          ...(shiftNote ? { previousChain, currentChain } : {}),
          ...(allWarnings.length || shiftNote ? { warnings: shiftNote ? [...allWarnings, shiftNote] : allWarnings } : {}),
        }),
      );
      return;
    }
    for (const warning of allWarnings) console.error(`警告: ${escapeControlChars(warning)}`);
    console.log(`新会话: ${escapeControlChars(result.newRef.sessionId)}（${result.turnCount} 轮）`);
    console.log(`resume: ${escapeControlChars(result.resumeCommand)}`);
    if (shiftNote) console.log(`\n${shiftNote}`);
  } catch (error) {
    // 结构化阻断（新建会话需要的原生 CLI 没装等）与 switch 走同一份输出：这两条都是写路径，
    // 脚本 / 桌面端只看 blocked / code，退回一句 error 文本就成了「内部错误」
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 同 switch / adopt：「当前链没读成」只在失败原因本身不是库故障时才补
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    // `new` 经 createChainSession → handoff(forceNew) 与 switch 共用空来源判定：
    // 失败结果同样要带 emptySessions / unparsableLines，脚本不必解析中文
    if (error instanceof HandoffEmptySourceError) {
      failEmptySource(error, json, [cwdIssue ?? '', probe].filter(Boolean));
    }
    // 与 switch 同一档：链尾来源根本没读成时给出可机读的原因，四档恢复动作不同
    if (error instanceof HandoffSourceReadError) {
      failSourceRead(error, json, [cwdIssue ?? '', probe].filter(Boolean));
    }
    const msg = [probe, describeCommandError(error)].filter(Boolean).join('；');
    // 与 switch / adopt 一致：目录本身有问题时先说路径，否则「还没有切换链」会被当成「目录里没东西」
    const message = cwdIssue ? `${cwdIssue}；${msg}` : msg;
    fail(json, message);
  }
}

const CHAIN_SUBCOMMANDS = 'list / new <名字> / rename <名字或 id> <新名字> / archive <名字或 id> / use <名字或 id>';

/**
 * 「这条链在当前 `--cwd` 里找不到」这一类失败，与 `cmdChain` 里其它失败（撞名 / 唯一活跃链 /
 * 未知子命令）**下一步完全不同**，所以要用一个可识别的类型分开。
 *
 * 链按 `--cwd` 的**原字符串**分组，路径写错时会安静地「找不到链」——这一档把 `--cwd` 的原因
 * 拼在前面是有用的，用户据此会去核对路径。而其余几档与会话列表毫无关系：2026-11-09 实测
 * `watch chain lsit --cwd <不存在目录> --json` 的 error 第一句是「--cwd 目录不存在：…路径不对时
 * 不会列出任何会话」，真正的问题是子命令拼错了；`chain archive <唯一活跃链>` 同理，它的下一步是
 * 「先 chain new 建一条」，被前面那句一挤，用户会以为换个 `--cwd` 就能归档。
 */
class ChainLookupError extends Error {}

async function cmdChain(cwd: string, json: boolean, action?: string, a?: string, b?: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, storeUnavailableError());
  // 链名 / cwd 都是精确匹配：路径写错时 rename / archive / use 只会说「找不到链」，
  // 跟 switch / adopt 一样先把路径原因带出来，否则会被当成「这条链不存在」
  // 两种口径分开生成（与 `cmdNew` 同一分法）：`list` 与「找不到链」这一档用查询类的
  // 「不会列出任何会话」，`new` 是写路径，见 `chainCwdWarning()`——它会把链真的建到那个路径下
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  const cwdWriteIssue = describeWriteCwd(cwdProbe, cwd);
  // `:memory:` 时每条命令都是一份全新的库：写进去的链记录随进程消失（见 `ephemeralStoreWarning`）。
  // 四个写分支（new / rename / archive / use）都要带这一句，`list` 的版本在下面单独给。
  const ephemeralWrite = ephemeralDb ? ephemeralStoreWarning('这次写入的链记录只在这份临时库里') : null;
  try {
    if (!action || action === 'list') {
      const chains = store.listChains(cwd);
      // 链按 cwd 精确分组：「本目录没有链」不等于「一条链都没建过」。指向错目录时正文只有
      // 一句「（无链）」，用户会以为链丢了或没建成功——别处的链要说出来
      const rawElsewhere = chains.length ? [] : chainsElsewhereOf(store, cwd);
      // `--cwd` 只是同一个目录的另一种写法时，那些链不属于「其它目录」：分开放，两句话的下一步不同
      const splitElsewhere = await splitChainsElsewhere(rawElsewhere, cwd);
      const elsewhere = [...splitElsewhere.same, ...splitElsewhere.other];
      const warnings = cwdIssue ? [cwdIssue] : [];
      // `:memory:` 下这份库在每条命令里都是新的：正文「（无链）」/ 空清单是结论，
      // 不解释的话会被当成链丢了或没建成功（见 `ephemeralStoreWarning`）
      if (ephemeralDb) warnings.push(ephemeralStoreWarning('本目录的链来自这份临时库，它每条命令都是空的'));
      // 写入守卫（`assertChainNameUsable()`）只拦得住新名字：库里可能留着它上线前建出的
      // 坏名字。文本输出一律转义（`escapeControlChars`），但用户看到 `\u001B` 时得知道
      // 那不是自己打的名字，也知道怎么改掉——不说就等于把名字悄悄改成了另一串字符。
      const legacyBadNames = chains.filter((c) => hasControlChars(c.name));
      if (legacyBadNames.length) {
        warnings.push(
          `有 ${legacyBadNames.length} 条链的名字里含控制字符（换行 / 制表符 / ESC 等），文本输出里已转义成 \\n、\\u001B 这类可见形式；` +
            `它们是写入校验上线前留下的，不会自动改：` +
            `${legacyBadNames.slice(0, 3).map((c) => `${c.id}`).join('、')}${legacyBadNames.length > 3 ? ' 等' : ''}；` +
            `可用 watch chain rename <链 id> <新名字> 改掉`,
        );
      }
      // 链尾 = 最后一条 switch_event 的 toRef。只给名字 + id 时看不出这条链停在哪一家，
      // 也看不出链尾文件是否还在（在的话下次 switch 才接得上，不在就是 doctor 的 brokenTips）
      const tips = new Map<
        string,
        {
          provider: string;
          sessionId: string;
          filePath: string;
          missing: boolean;
          error?: string;
          /** `missing` 且只剩 0 字节压缩副本：内容已丢失，不能标成「只剩压缩副本」 */
          compressedEmpty?: boolean;
          /** 文件在、但读不出来（`chmod 000` 之类）：`missing` 为假也不代表可用 */
          unreadable?: boolean;
          /** `unreadable` 的其中一档：0 字节，内容已丢失，下一步是备份恢复而不是修权限 */
          emptyFile?: boolean;
          /** 链尾解析出的轮数：只在 parse 成功时存在（undefined = 没解析 / 解析失败），不拿 0 冒充 */
          turns?: number;
          /** 0 轮链尾同一次坏行扫描的结果；干净文件不出现，`error` 在场时 `count` 是下界 */
          badLines?: BadLinesScan;
        }
      >();
      // 与 status / doctor 同一口径：链尾文件在、读得出来时再 parse 一次，给出轮数。
      // 链 list 只是一次查询，但「这条链的链尾还剩多少 / 是不是空的」正是选链要看的信息
      const tipAdapters = new Map(listAdapters().map((a) => [a.id, a]));
      for (const c of chains) {
        let last: ReturnType<typeof store.listSwitchEvents>[number] | undefined;
        try {
          last = store.listSwitchEvents(c.id).at(-1);
        } catch (error) {
          warnings.push(`链「${escapeControlChars(c.name)}」的切换记录读不出来：${describeStoreErrorReason(error)}`);
          continue;
        }
        if (!last?.toRef) continue;
        // 与 status / doctor 共用同一判定：只有 ENOENT / ENOTDIR 才算「文件已不存在」。
        // 这里以前只认 ENOENT，ENOTDIR（路径中间那一层被同名文件占住）会被讲成「状态无法确认」，
        // 同一条链在 status 里却写着「已不存在」；原因还会把英文 errno 原文塞进 --json 与 stderr
        const presence = await sessionFilePresence(last.toRef.filePath);
        // 只剩 Codex 压缩副本时 `missing` 仍为真（原路径确实不在、下次切换会失败），
        // 但 `error` 要说清它还在、怎么展开，不能沿用「文件已不存在」的下一步；
        // 0 字节副本是另一种状态（文件在、内容已丢），下一步是备份恢复而不是重新展开
        const copy = compressedCopy(presence);
        const missing = presence.state === 'missing';
        const compressedEmpty = missing && !!presence.emptyCompressed;
        // 同理，`stat` 成功也不代表读得出来：`chmod 000` 的链尾在 chain list 里看着一切正常，
        // 而 resume 与下一次 switch 一读内容就失败（status 走同一个探测，口径一致）
        const readProblem =
          presence.state === 'present' && presence.isFile ? await probeSessionReadable(last.toRef.filePath) : null;
        const tipError = readProblem
          ? readProblem
          : copy
            ? copy.note
            : presence.state === 'unknown'
              ? presence.reason
              : presence.state === 'present' && !presence.isFile
                ? '该路径现在不是普通文件'
                : null;
        const emptyFile = Boolean(readProblem && isEmptySessionFileReason(readProblem));
        let turns: number | undefined;
        const tipAdapter =
          presence.state === 'present' && presence.isFile && !readProblem ? tipAdapters.get(last.toRef.provider) : undefined;
        if (tipAdapter?.parse) {
          try {
            turns = (await tipAdapter.parse(last.toRef)).length;
          } catch {
            // 与 status 的链尾判定同构：具体原因（库缺表、格式损坏、适配器异常）由
            // doctor 与 open / switch 的报错给出，这里不重复；但链尾行不显示轮数只是
            // 沉默——读者无法把它与「有内容但没统计」区分，而这条链尾正是下次切换的
            // 对象。「未能核对」这个事实必须说（第 365 轮，与 status 第 364 轮同口径）。
            if (c.status === 'active') {
              warnings.push(
                `链「${escapeControlChars(c.name)}」的链尾会话 ${last.toRef.provider} ${escapeControlChars(last.toRef.sessionId)} 的内容解析失败，` +
                  `Watch 未能核对它的轮数与收尾状态；打开或切换到它时会给出具体原因`,
              );
            }
          }
        }
        // 0 轮时与那条警告共用一次扫描：--json 也拿到同一份计数 / 扫描错误，不用解析中文
        const tipBadScan = turns === 0
          ? await scanUnparsableJsonLines(last.toRef.filePath, { allowMissing: false })
          : null;
        const tipBadLines = unparsableLinesField(null, tipBadScan).unparsableLines?.target;
        tips.set(c.id, {
          provider: last.toRef.provider,
          sessionId: last.toRef.sessionId,
          filePath: last.toRef.filePath,
          missing,
          ...(tipError ? { error: tipError } : {}),
          ...(compressedEmpty ? { compressedEmpty: true } : {}),
          ...(readProblem ? { unreadable: true } : {}),
          ...(emptyFile ? { emptyFile: true } : {}),
          ...(turns !== undefined ? { turns } : {}),
          ...(tipBadLines ? { badLines: tipBadLines } : {}),
        });
        if (missing && c.status === 'active') {
          warnings.push(
            copy
              ? `链「${escapeControlChars(c.name)}」的链尾会话文件${copy.note}（${last.toRef.provider}:${escapeControlChars(last.toRef.sessionId)}）：下次切换会失败——${compressedRetryAdvice(copy, '再重试')}，或${rebindHint(last.toRef.provider)}`
              : `链「${escapeControlChars(c.name)}」的链尾会话文件已不存在（${last.toRef.provider}:${escapeControlChars(last.toRef.sessionId)}）：下次切换会失败，${rebindHint(last.toRef.provider)}`,
          );
        } else if (readProblem && c.status === 'active') {
          // 读不出来 ≠ 文件没了：不标 missing，也不能当成「一切正常」而不出声。
          // 0 字节单列一档：内容已丢失，让人去「修好这个文件（权限或内容）」只会白查一遍权限
          warnings.push(
            emptyFile
              ? `链「${escapeControlChars(c.name)}」的链尾会话文件是空的（${last.toRef.provider}:${escapeControlChars(last.toRef.sessionId)}）：${readProblem}；` +
                `resume 没有内容可恢复，下次切换也会失败——先从备份恢复该文件（Watch 不会替你重建历史），或 watch adopt ${last.toRef.provider} --session <另一个会话 id> 换绑`
              : `链「${escapeControlChars(c.name)}」的链尾会话文件读不出来（${last.toRef.provider}:${escapeControlChars(last.toRef.sessionId)}）：${readProblem}；` +
                `resume 与下次切换会失败——先修好这个文件（权限或内容），或 watch adopt ${last.toRef.provider} --session <另一个会话 id> 换绑`,
          );
        } else if (tipError && c.status === 'active') {
          // 读不出来 ≠ 文件没了：不标 missing，也不能当成「一切正常」而不出声
          warnings.push(
            `链「${escapeControlChars(c.name)}」的链尾会话文件无法确认是否还在（${last.toRef.provider}:${escapeControlChars(last.toRef.sessionId)}）：${tipError}`,
          );
        } else if (turns === 0 && c.status === 'active') {
          // 与 status 的 chainTipEmpty 同档：parse 跳过坏行，0 轮也可能来自截断 / 损坏，
          // 先把「坏行」与「合法空会话」分开，再决定要不要让人去原生客户端继续聊。
          const subject = `链「${escapeControlChars(c.name)}」的链尾会话 ${last.toRef.provider} ${escapeControlChars(last.toRef.sessionId)}`;
          const badScan = tipBadScan!;
          const badFailure = describeBadLinesScanFailure(
            badScan,
            subject,
            '是否真的只有 0 轮无法确认——先确认该文件可读再重试',
          );
          const confirmedBadLines = badScan.count > 0
            ? `文件里有 ${badScan.count} 行无法解析（截断或损坏），这些内容已被跳过——更可能是文件被截断或损坏，不能当成「刚建出来的空会话」`
            : null;
          if (badFailure) {
            warnings.push([`${subject} 解析出 0 轮`, confirmedBadLines, badFailure].filter(Boolean).join('；'));
          } else {
            const reason = confirmedBadLines ?? '可能刚建出来还没聊过，也可能内容已被清空';
            warnings.push(
              `${subject} 解析出 0 轮（没有可继续的对话）：${reason}；` +
                zeroTurnResumeClaim(badScan, 'resume 打开就是空会话——') +
                `如果它本该有历史，先确认文件是否需要从备份恢复（Watch 不会替你重建历史）`,
            );
          }
        }
      }
      if (json) {
        // 文本模式一直有 `← 当前`，`--json` 却没有任何标记：脚本看 `chains[]` 只能靠
        // lastUsedAt 自己猜（而它只是「上次被用到的时刻」，归档链同样有值）
        const current = store.findActiveChain(cwd);
        console.log(JSON.stringify({
          ok: true,
          cwd,
          chains: chains.map((c) => ({
            ...c,
            ...(current && current.id === c.id ? { current: true } : {}),
            ...(tips.has(c.id) ? { tip: tips.get(c.id) } : {}),
          })),
          // 链按 --cwd 原字符串分组：路径写错时 `chains: []` 看起来就是「没建过链」。
          // 与 status / sessions / recent / usage / search / doctor 同字段，健康目录不出现
          ...cwdStateField(cwdProbe),
          ...(elsewhere.length ? { chainsElsewhere: elsewhere } : {}),
          ...(warnings.length ? { warnings } : {}),
        }));
        return;
      }
      for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
      if (!chains.length) {
        console.log('（无链）');
        if (splitElsewhere.same.length) console.log(chainsSameDirectoryHint(splitElsewhere.same));
        if (splitElsewhere.other.length) console.log(chainsElsewhereHint(splitElsewhere.other));
        return;
      }
      // 「当前」= 活跃链里 last_used_at 最新的一条（与 status / switch 的默认链同一判定）。
      // 以前只给名字 + id：同一目录多条链时看不出哪条在用、哪条最近没动（--json 一直有 lastUsedAt）
      const current = store.findActiveChain(cwd);
      console.log(`链（cwd: ${escapeControlChars(cwd)}）:`);
      for (const c of chains) {
        const mark = c.status === 'archived' ? ' [归档]' : '';
        const here = current && c.id === current.id ? ' ← 当前' : '';
        const tip = tips.get(c.id);
        const tipText = tip
          ? `  → ${tip.provider}:${escapeControlChars(tip.sessionId)}${
              tip.missing
                ? tip.error && !tip.unreadable
                  ? tip.compressedEmpty
                    ? '（链尾只剩 0 字节压缩副本，内容已丢失）'
                    : '（链尾只剩压缩副本）'
                  : '（链尾文件已不存在）'
                : tip.unreadable
                  ? tip.emptyFile
                    ? '（链尾文件是空的，内容已丢失）'
                    : '（链尾文件读不出来）'
                  : tip.error
                    ? '（链尾文件状态无法确认）'
                    : tip.turns === 0
                      ? tip.badLines?.error
                        ? '（解析出 0 轮，坏行扫描未完成）'
                        : tip.badLines
                          ? '（解析出 0 轮，文件有坏行）'
                          : '（解析出 0 轮，空会话）'
                      : tip.turns !== undefined
                        ? `（${tip.turns} 轮）`
                        : ''
            }`
          : '';
        console.log(`  ${escapeControlChars(c.name)}${mark}${here}  ${escapeControlChars(c.id)}  lastUsed=${fmtTime(c.lastUsedAt)}${tipText}`);
      }
      return;
    }
    if (action === 'new') {
      if (!a) throw new Error(`chain new 需要一个链名；可用: ${CHAIN_SUBCOMMANDS}`);
      // 新建链写入 `last_used_at = now`，而「当前链」就是活跃链里 `last_used_at` 最新的一条：
      // 于是 `chain new` 会**静默把当前链换走**。这恰好与这条命令最常见的用途相反——
      // 「先建一条备用放着，以后再说」——建完当前链就变成那条备用的了，
      // 紧接着一次不带 `--chain` 的 `switch` 就把内容交接进这条谁也没打算用的链，
      // 原来那条链上什么都不剩（2026-11-08 实测：`chain new 主力` → `chain new 备用` →
      // `switch codex` 之后 `chain list` 里「备用」是 `← 当前` 并带链尾，「主力」是空的）。
      // 所以先记下原当前链，建完把这件事说出来，并给一条能回去的命令。
      const previous = store.findActiveChain(cwd);
      const chain = store.createChain(cwd, a);
      // 本目录第一条活跃链时没有「被换下的链」，此时不出声（每次建链都弹提示就是假警）
      const switchedFrom = previous && previous.id !== chain.id ? previous : null;
      const switchNote = currentChainShiftNote(switchedFrom, switchedFrom ? chain : null);
      // 与 watch new 同理：路径错了照样建出链，但绑定指向不存在的项目，必须说明。
      // **不能复用查询类的 `cwdIssue`**：那句讲的是「会话列表会是 0」，而这里已经写进了一条链记录，
      // 且这条链之后用同一个 --cwd 照样列得出来——写入口径由 `chainCwdWarning()` 单独给。
      // （cwd 问题走降级警告通道；当前链变更走结果说明通道，见 `chain archive` 的同一分法）
      // `:memory:` 时这条链只活在本次进程内：命令本身成功，但下一次 chain list 就看不到它
      const ephemeralNote = ephemeralWrite;
      const chainCwdIssue = cwdWriteIssue ? chainCwdWarning(cwdWriteIssue, chain.name) : null;
      // 链记录已经写进本地库了：这一步只是补充说明，读不出来也不该让命令失败
      const aliasIssue = await aliasChainGroupWarning(store, cwd, chain.name);
      if (json) {
        const warnings = [
          ...(chainCwdIssue ? [chainCwdIssue] : []),
          ...(aliasIssue ? [aliasIssue] : []),
          ...(switchNote ? [switchNote] : []),
          ...(ephemeralNote ? [ephemeralNote] : []),
        ];
        console.log(
          JSON.stringify({
            ok: true,
            chain,
            ...(switchedFrom ? { previousChain: switchedFrom } : {}),
            // 与 watch new 同理：链记录已经写进本地库并绑定了这个 --cwd 字符串，
            // 但目录不可用时 resume 会在进入时失败。它是「目录不可用」的披露，不是「操作被阻止」。
            // rename / archive / use 的成功输出也带同一字段（链按 --cwd 原字符串分组，
            // 目录没了照样查得到、改得动，脚本仍需要知道这条链绑在一个不可用的路径上）
            ...cwdStateField(cwdProbe),
            ...(warnings.length ? { warnings } : {}),
          }),
        );
      } else {
        if (chainCwdIssue) console.error(`警告: ${chainCwdIssue}`);
        if (aliasIssue) console.error(`警告: ${aliasIssue}`);
        if (ephemeralNote) console.error(`警告: ${ephemeralNote}`);
        console.log(`已创建链: ${escapeControlChars(chain.name)}  (${escapeControlChars(chain.id)})`);
        // 与 `chain rename` / `chain archive` 的提示同一位置：跟在结果下一行，不是降级警告
        if (switchNote) console.log(`  ${switchNote}`);
      }
      return;
    }
    if (action === 'rename') {
      if (!a || !b) throw new Error('chain rename 需要两个位置参数：<链名或 id> <新名字>；例：watch chain rename tui-chain 前端');
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new ChainLookupError(store.missingChainMessage(cwd, a));
      const wasArchived = found.status === 'archived';
      // 改成同一个名字时 UPDATE 写的是同一个值，什么都没变，但以前照样报「已重命名」，
      // 输出与真的改过名一模一样（脚本无法区分）。打这条命令的动机常常是「先把它改成我想要的名字」，
      // 名字本来就对时，明说「没有改动」才让人敢确认结论
      // 比较用的是库里的原值，只有显示才转义：坏名字本来也抄不进参数
      if (found.name === b.trim()) {
        const shown = escapeControlChars(found.name);
        const note =
          `链「${shown}」本来就叫这个名字，本次没有做任何改动` +
          (wasArchived ? `；它是归档状态，可用 watch chain use ${shown} 恢复成当前链` : '');
        if (json) console.log(JSON.stringify({ ok: true, unchanged: true, chain: found, ...cwdStateField(cwdProbe), warnings: [note] }));
        else console.log(`未改动: ${shown}  (${escapeControlChars(found.id)})——${note}`);
        return;
      }
      const chain = store.renameChain(found.id, b);
      // 改名不动 status：给归档链改名后它仍是归档的，而 `switch` / `status` 只认活跃链。
      // 只报「已重命名」会让人以为改名之后就切过去了（改名的动机常常就是这个），
      // 接下来发现 `switch` 仍然忽略它，只会以为改名没生效。
      const renameHint = wasArchived
        ? `这条链是归档状态，改名不会让它变成当前链；可用 watch chain use ${escapeControlChars(chain.name)} 恢复`
        : null;
      const renameWarnings = [renameHint, ephemeralWrite].filter((w): w is string => Boolean(w));
      if (json) {
        console.log(
          JSON.stringify({ ok: true, chain, ...cwdStateField(cwdProbe), ...(renameWarnings.length ? { warnings: renameWarnings } : {}) }),
        );
      } else {
        if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
        console.log(`已重命名: ${escapeControlChars(chain.name)}  (${escapeControlChars(chain.id)})`);
        if (renameHint) console.log(`  ${renameHint}`);
      }
      return;
    }
    if (action === 'archive') {
      if (!a) throw new Error('chain archive 需要一个链名或 id；例：watch chain archive tui-chain');
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new ChainLookupError(store.missingChainMessage(cwd, a));
      // 已是归档状态时 `archiveChain()` 直接 return，什么都没做。
      // 照旧打「已归档」会让用户以为刚刚归档成功，看不出本次是空操作。
      // 领头词与 `chain rename <同名>` 的「未改动:」对齐：补一句说明还不够，
      // 扫一眼就走的读者只会看到行首那个动作词（第 311 轮）。
      if (found.status === 'archived') {
        const shown = escapeControlChars(found.name);
        const note = `链「${shown}」本来就是归档状态，本次没有做任何改动；可用 watch chain use ${shown} 把它恢复成当前链`;
        if (json) console.log(JSON.stringify({ ok: true, unchanged: true, id: found.id, ...cwdStateField(cwdProbe), warnings: [note] }));
        else console.log(`未改动: ${shown}（${note}）`);
        return;
      }
      // 归档**当前链**时，当前链会静默换成另一条活跃链：之后所有不带 `--chain` 的
      // status / switch / new / adopt 都作用在它上面，而输出只有一句「已归档」。
      // 归档自己正在用的那条链，恰好是最需要知道「接下来写进哪条」的时刻。
      const currentBefore = store.findActiveChain(cwd);
      const archivingCurrent = currentBefore?.id === found.id;
      store.archiveChain(found.id);
      // 归档后就地再查一次，拿到真正接手的那条（`lastUsedAt` 最新的活跃链）。
      // `archiveChain()` 在「最后一条活跃链」时已经抛错，所以这里必然还有一条；
      // 仍留一条兜底文案，避免将来守卫放宽时把「没有当前链」说成「换成了某条」。
      const nextCurrent = archivingCurrent ? store.findActiveChain(cwd) : null;
      const currentNote = archivingCurrent
        ? nextCurrent
          ? `当前链已从「${escapeControlChars(found.name)}」换成「${escapeControlChars(nextCurrent.name)}」；之后不带 --chain 的 status / switch / new / adopt 都作用在「${escapeControlChars(nextCurrent.name)}」上（要按名字指定这条链用 watch chain use ${escapeControlChars(nextCurrent.name)}）`
          : `「${escapeControlChars(found.name)}」原本是本目录的当前链，归档后已经没有其它活跃链了；status / switch / new / adopt 需要先用 watch chain new <新名字> 建一条，或 watch chain use ${escapeControlChars(found.name)} 恢复`
        : null;
      const archiveWarnings = [currentNote, ephemeralWrite].filter((w): w is string => Boolean(w));
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            id: found.id,
            ...(nextCurrent ? { currentChain: nextCurrent } : {}),
            ...cwdStateField(cwdProbe),
            ...(archiveWarnings.length ? { warnings: archiveWarnings } : {}),
          }),
        );
      } else {
        if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
        console.log(`已归档: ${escapeControlChars(found.name)}（可用 watch chain use ${escapeControlChars(found.name)} 恢复）`);
        // 与 `chain rename` 对归档链的提示同一位置：跟在结果下一行，不是降级警告
        if (currentNote) console.log(`  ${currentNote}`);
      }
      return;
    }
    if (action === 'use') {
      if (!a) throw new Error('chain use 需要一个链名或 id；例：watch chain use tui-chain');
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new ChainLookupError(store.missingChainMessage(cwd, a));
      // 归档只是「不再是默认链」，链记录与历史都还在：以前这里直接报「链已归档」，
      // 却没有任何命令能把它恢复回来（rename / archive / use 三条路全堵死）
      if (found.status === 'archived') {
        // `restoreChain()` 返回真正落盘的那份（含 touchChain 算出的 lastUsedAt）：
        // 以前这里自己再查一次、查不到还退成 `{ ...found, status: 'active' }`，
        // 报出去的 lastUsedAt 是归档前的旧值
        const restored = store.restoreChain(found.id);
        if (json) {
          console.log(
            JSON.stringify({
              ok: true,
              restored: true,
              chain: restored,
              ...cwdStateField(cwdProbe),
              ...(ephemeralWrite ? { warnings: [ephemeralWrite] } : {}),
            }),
          );
        } else {
          if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
          console.log(`已恢复并设为当前链: ${escapeControlChars(restored.name)}  (${escapeControlChars(restored.id)})`);
        }
        return;
      }
      // 切换之前先看当前链是谁：「本来就在这条链上」与「刚切过来」以前输出一字不差
      // （`--json` 都是 `{ok:true,chain:{…}}`、文本都是「当前链: X」），用户照着自己刚收到的
      // 提示（「要回到原来那条用 watch chain use X」）跑完，看到「当前链: X」会以为切换成功；
      // 若它本来就没离开过，说明他此前那些带 `--chain` 的操作根本没换走当前链——这条信息
      // 恰恰是「为什么我后面的 switch 落到了别的链上」的答案，一个字都没有。
      // `chain rename <同名>` / `chain archive <已归档>` 早已是 `unchanged:true` 加一句说明，
      // 这里对齐，但**不能说成「没有做任何改动」**：`touchChain()` 确实抬高了 last_used_at。
      const previous = store.findActiveChain(cwd);
      const touched = store.touchChain(found.id);
      const unchanged = previous?.id === found.id;
      const note = unchanged
        ? `「${escapeControlChars(found.name)}」本来就是本目录的当前链，本次没有发生切换；` +
          `不带 --chain 的 status / switch / new / adopt 一直作用在它上面（本次只刷新了它的最近使用时间）`
        : null;
      const useWarnings = [note, ephemeralWrite].filter((w): w is string => Boolean(w));
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            ...(unchanged ? { unchanged: true } : {}),
            chain: touched,
            ...cwdStateField(cwdProbe),
            ...(useWarnings.length ? { warnings: useWarnings } : {}),
          }),
        );
      } else {
        if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
        console.log(`当前链: ${escapeControlChars(touched.name)}  (${escapeControlChars(touched.id)})`);
        if (note) console.log(`  ${note}`);
      }
      return;
    }
    // 拼错的子命令（`chain lsit`）以前一律落到通用用法错误「参数不完整或不合法」，
    // 用户看不出是子命令写错、也不知道有哪几个，得自己翻整页用法
    const nearAction = closestCommand(action, Object.keys(CHAIN_POSITIONAL));
    throw new Error(
      `未知的 chain 子命令: ${escapeControlChars(action)}${nearAction ? `；最接近的是 ${nearAction}` : ''}；可用: ${CHAIN_SUBCOMMANDS}`,
    );
  } catch (error) {
    // 链库读写失败（缺列 / 表被改坏）时把原因翻成中文；业务结论（「链已归档」「找不到链」）
    // 原样带出，翻译只会破坏已经写好的下一步
    const message = describeCommandError(error);
    // `--cwd` 的说明只对「这条链在当前 cwd 找不到」有意义（链按 cwd 原字符串分组，路径写错就查不到）。
    // 撞名 / 唯一活跃链 / 未知子命令这些失败与会话列表无关，把「路径不对时不会列出任何会话」拼在
    // 前面会把真正的原因与下一步挤到后面（见 `ChainLookupError` 的注释，2026-11-09 实测）。
    fail(json, error instanceof ChainLookupError && cwdIssue ? `${cwdIssue}；${message}` : message);
  }
}

function rejectUnusedFlags(cmd: string, usedFlags: string[], json: boolean): void {
  const allowed = FLAGS_BY_COMMAND[cmd];
  if (!allowed) return;
  const bad = usedFlags.find((flag) => !allowed.includes(flag));
  if (!bad) return;
  // `--cwd` 对 providers / capabilities 不起作用：兜底文案不能把它列成「支持的参数」
  const supports = allowed.length
    ? allowed.map((flag) => `--${flag}`).join(' / ')
    : cmd in CWD_UNUSED_COMMANDS
      ? '（无，仅 --json）'
      : '（无，仅 --cwd / --json）';
  rejectArguments(json, `--${bad} 不能与 ${cmd} 同用；${cmd} 支持的参数: ${supports}`);
}

function rejectExtraPositionals(cmd: string, positional: string[], json: boolean): void {
  const spec = POSITIONAL_BY_COMMAND[cmd];
  if (!spec) return;
  const max = cmd === 'chain' ? (CHAIN_POSITIONAL[positional[0] ?? ''] ?? Infinity) : spec.max;
  if (positional.length <= max) return;
  const overflow = positional.slice(max);
  rejectArguments(json, `多余的参数: ${overflow.join(' ')}；${cmd} 接受的位置参数: ${spec.hint}`);
}

async function main(): Promise<void> {
  // `--version` 与 `--help` 同属全局开关：放在 parseArgs 与 import-codex 分派之前，
  // 才能让 `watch --version` / `watch status --version` / `watch import-codex --version`
  // 三条位置给出同一个结论。以前它只会落进「未知参数: --version」——用户想确认装的是哪一版，
  // 而唯一带版本号的地方是 `watch doctor` 的「环境: watch x.y.z · node …」（还要能跑通诊断）。
  // 读不出版本时不编一个数：文本说「未知版本」，`--json` 给 `version: null`。
  const first = process.argv[2] ?? '';
  if (OPTION_ARGS.includes('--version') || VERSION_COMMAND_ALIASES.includes(first)) {
    const version = readWatchVersion();
    if (JSON_REQUESTED) {
      console.log(JSON.stringify({ ok: true, version }));
    } else {
      console.log(`watch ${version ?? '未知版本'}`);
    }
    return;
  }
  if (HELP_COMMAND_ALIASES.includes(first)) usage();
  if (first === 'import-codex') {
    await runImportCodex(process.argv.slice(3));
    return;
  }
  const { cmd, target, extra, rest, json, cwd, session, chain, from, provider, to, profile, last, sinceCompact, resetIndex, check, strict, limit, usedFlags, cwdGiven, positional } = parseArgs(process.argv);
  if (cmd) {
    rejectUnusedFlags(cmd, usedFlags, json);
    rejectExtraPositionals(cmd, positional, json);
  }
  if (cmd === 'status') {
    await cmdStatus(cwd, json, chain);
    return;
  }
  if (cmd === 'switch') {
    if (!target) usage('switch 需要指定目标 provider；例：watch switch codex');
    await cmdSwitch(cwd, target, json, chain);
    return;
  }
  if (cmd === 'adopt') {
    if (!target) usage('adopt 需要指定 provider；例：watch adopt codex --session <会话 id>');
    await cmdAdopt(cwd, target, json, session, chain);
    return;
  }
  if (cmd === 'sessions') {
    await cmdSessions(cwd, json, chain);
    return;
  }
  if (cmd === 'recent') {
    await cmdRecent(cwd, json, limit, cwdGiven);
    return;
  }
  if (cmd === 'providers') {
    await cmdProviders(json, cwdGiven);
    return;
  }
  if (cmd === 'capabilities') {
    cmdCapabilities(json, cwdGiven);
    return;
  }
  if (cmd === 'prompt') {
    // 会话 id 可省略：只输入 `watch prompt` 时按本目录最新可读会话自动挑选（与 catchup 的
    // 「不指定就用最近一条」对齐）。自动挑选是替用户做选择，所以文档头会写明这一点。
    await cmdPrompt(cwd, json, target, provider, profile, last, sinceCompact, cwdGiven);
    return;
  }
  if (cmd === 'inspect') {
    await cmdInspect(json, target, provider, cwdGiven);
    return;
  }
  if (cmd === 'doctor') {
    await cmdDoctor(cwd, json, strict);
    return;
  }
  if (cmd === 'new') {
    if (!target) usage('new 需要指定 provider；例：watch new codex');
    await cmdNew(cwd, target, json, chain);
    return;
  }
  if (cmd === 'chain') {
    await cmdChain(cwd, json, target, rest[0] ?? extra, rest[1]);
    return;
  }
  if (cmd === 'search') {
    // 必须先 trim：全是空格的查询词 `filter(Boolean)` 会放行，store 那边再 trim 成空串直接返回零命中，
    // 文本模式于是打「无结果」、--json 带 ok:true——看着像「搜过了没有」，其实一次都没查
    const q = [target, ...rest].filter(Boolean).join(' ').trim();
    if (!q) usage('search 需要查询词；例：watch search 迁移');
    await cmdSearch(cwd, json, q, resetIndex);
    return;
  }
  if (cmd === 'usage') {
    await cmdUsage(cwd, json, chain);
    return;
  }
  if (cmd === 'open') {
    if (!target) usage('open 需要会话 id；例：watch open <会话 id>');
    await cmdOpen(target, json, from, provider, to, check, cwdGiven);
    return;
  }
  // 命令名拼错时参数其实是完整的，说「参数不完整或不合法」会让人去补参数；
  // 与 cmdChain 的「未知的 chain 子命令」保持一致，直接列出可用命令
  if (cmd) {
    // 最接近的那个放在清单前面：十几个命令里逐个比对，不如直接指出差一两个字符的那一个。
    // 只在唯一近邻上给（见 closestCommand），猜不准就只列清单。
    const near = closestCommand(cmd);
    usage(`未知命令: ${escapeControlChars(cmd)}${near ? `；最接近的是 ${near}` : ''}；可用: ${COMMAND_LIST}`);
  }
  usage(`缺少子命令；可用: ${COMMAND_LIST}`);
}

async function cmdUsage(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  // 链名与目录都是精确匹配：目录写错时 `--chain` 同样查不到，失败时也要带出路径原因。
  // 探测留到 JSON 出口：`byProvider: []` + `total: 0` 分不清「没绑定」与「--cwd 不可用」
  const cwdProbe = await inspectCwd(cwd);
  const cwdIssue = describeCwdProblem(cwdProbe, cwd);
  try {
    const result = await chainUsage(cwd, listAdapters(), store, chain, lastStoreError ?? undefined);
    if (cwdIssue) result.warnings.push(cwdIssue);
    // `:memory:` 下 notes 那句「还没建链，或现有链都已归档」是假结论：这条命令拿到的是全新的
    // 空库，上一条命令里建的链早就随那个进程消失了。warning 讲库的性质，notes 讲这份报告
    // 为什么是空的——两者都改，否则同一份输出里既说「还没建链」又说「记录已随进程消失」
    if (ephemeralDb && !result.chain) {
      result.warnings.push(ephemeralStoreWarning('本目录的链与链尾都来自这份临时库，它每条命令都是空的'));
      result.notes = [
        '这份临时库里本目录没有可用的当前链，无用量可统计——之前用 chain new / switch / adopt 写的链记录都只活在各自那一条命令里',
        ...(result.notes ?? []).filter((note) => !note.includes('还没建链')),
      ];
    }
    if (json) {
      // 空报告（byProvider: []）在 --cwd 不可用时也是必然结果：与 status / sessions / recent / search
      // 同一字段，脚本不必解析中文警告。库本身打不开是另一种空：`chain: null` + `total: 0`
      // 与「没有当前链」同形，`storeAvailable: false` 才能把「读不出来」与「确实没有」分开
      console.log(JSON.stringify({
        ok: true,
        // 同 status：`--cwd` 省略时是进程工作目录，回显出来脚本不必自己记
        cwd,
        ...result,
        ...cwdStateField(cwdProbe),
        ...(store ? {} : { storeAvailable: false }),
      }));
      return;
    }
    if (result.chain) {
      console.log(`链: ${escapeControlChars(result.chain.name)}  (${escapeControlChars(result.chain.id)})`);
    } else if (chain) {
      // 本地库不可用时 chainUsage 返回 chain:null——这时连「这条链是否存在」都没查成。
      // 单独印一行「链: keep」与 --json 的 chain:null 矛盾，用户会当成「链在、只是没有用量」
      console.log(`链: ${escapeControlChars(chain)}（未能确认这条链是否存在；原因见警告）`);
    }
    // 警告必须先打：本地库不可用时 byProvider 也是空的，先 return 会把「读不出来」说成「没有绑定会话」
    for (const warning of result.warnings) console.error(`警告: ${escapeControlChars(warning)}`);
    if (!result.byProvider.length) {
      // 说明来自 chainUsage 的 notes，与 --json 同一句（以前只在文本模式里手写，
      // 脚本拿到的是 byProvider: [] + total: 0，分不出「没绑定」和「真的用了 0」）
      for (const note of result.notes ?? []) console.log(note);
      if (result.notes?.length) return;
      // 无库时没有可解释的内容，原因已经在 warnings 里逐条打过
      console.log('（无可统计的用量；原因见上方警告）');
      return;
    }
    // 合计只是「已知用量之和」：读取失败与「原生没有 usage 字段」都不在其中，两种都要说出来
    const missing: string[] = [];
    if (result.totalExcluded) missing.push(`${result.totalExcluded} 个读取失败的会话`);
    // 空会话与「有内容却没记 usage」两档分开：前者还没有任何对话，后者才是统计缺失
    if (result.totalEmptySessions) missing.push(`${result.totalEmptySessions} 个空会话`);
    if (result.totalMissingUsage) missing.push(`${result.totalMissingUsage} 个无 usage 数据的会话`);
    if (result.unsupported?.length) missing.push(`${result.unsupported.join('、')}（适配器不提供用量）`);
    console.log(
      `合计${missing.length ? `（未含 ${missing.join('、')}）` : ''}: in=${result.total.inputTokens}  out=${result.total.outputTokens}`,
    );
    // 合计已把坏行跳过的份额少算了：不说这一句，「未含」那两个计数只覆盖整条读不出的会话，
    // 这个人会把合计量当成完整读数（每行的数字仍印出来，但少了哪几行没人知道）
    const badLineSessions = result.byProvider.filter((item) => item.usageBadLines).length;
    if (badLineSessions) {
      console.log(`  注：${badLineSessions} 个会话的用量数据源有无法解析的行，这些行的用量没计入，合计是下界`);
    }
    // 扫描本身失败是另一档：连「少算了多少」都数不出来，不能说成「没有坏行」
    const badLineUnscanned = result.byProvider.filter((item) => item.usageBadLinesScanError).length;
    if (badLineUnscanned) {
      console.log(`  注：${badLineUnscanned} 个会话的用量数据源坏行无法统计（文件读不出来），合计是下界且程度未知——先确认这些文件可读再重试`);
    }
    // 这些是「内容侧」的事实，与用量坏行/读取失败分列：
    // 内容坏行只说明内容可能不完整——0 轮路径不能当空会话，已读到用量的路径合计照算；
    // 扫描失败时连「坏行有多少」都不知道，必须与确认为坏行的两档分开说。
    // 压缩记录由 zeroTurnProblem 单列；旁路用量完好但内容文件已空时，只提醒内容已丢失。
    const contentBadLineSessions = result.byProvider.filter((item) => item.contentBadLines || item.contentBadLinesScanError);
    const contentBadLineEmptyKnown = contentBadLineSessions.filter(
      (item) => item.usage === null && !item.contentBadLinesScanError,
    ).length;
    const contentBadLineEmptyUnknown = contentBadLineSessions.filter(
      (item) => item.usage === null && item.contentBadLinesScanError,
    ).length;
    const contentBadLineWithUsageKnown = contentBadLineSessions.filter(
      (item) => item.usage !== null && !item.contentBadLinesScanError,
    ).length;
    const contentBadLineWithUsageUnknown = contentBadLineSessions.filter(
      (item) => item.usage !== null && item.contentBadLinesScanError,
    ).length;
    if (contentBadLineEmptyKnown) {
      console.log(`  注：${contentBadLineEmptyKnown} 个会话的内容文件有无法解析的行，0 轮不能当作空会话`);
    }
    if (contentBadLineEmptyUnknown) {
      console.log(`  注：${contentBadLineEmptyUnknown} 个会话的内容文件坏行无法统计，0 轮不能当作空会话；先确认内容文件可读再重试`);
    }
    if (contentBadLineWithUsageKnown) {
      console.log(`  注：${contentBadLineWithUsageKnown} 个会话的内容文件有无法解析的行，内容可能不完整；用量来自旁路文件并已计入合计`);
    }
    if (contentBadLineWithUsageUnknown) {
      console.log(`  注：${contentBadLineWithUsageUnknown} 个会话的内容文件坏行无法统计，内容完整性未知；用量来自旁路文件并已计入合计`);
    }
    const zeroTurnProblemSessions = result.byProvider.filter((item) => item.zeroTurnProblem).length;
    if (zeroTurnProblemSessions) {
      console.log(`  注：${zeroTurnProblemSessions} 个会话解析出 0 轮，但日志显示曾有内容，不是合法空会话`);
    }
    const contentProblemSessions = result.byProvider.filter((item) => item.contentProblem).length;
    if (contentProblemSessions) {
      console.log(`  注：${contentProblemSessions} 个会话的内容文件已空或不可用，对话内容已丢失；用量来自旁路文件并已计入合计`);
    }
    console.log('');
    console.log('按会话:');
    for (const item of result.byProvider) {
      const u = item.usage ?? { inputTokens: 0, outputTokens: 0 };
      // 用「；」拼接而不是嵌套括注：`（读取失败: …（…））` 读起来分不清哪层在解释哪层
      const notes: string[] = [];
      if (item.error) notes.push(`读取失败: ${item.error}`);
      else if (item.emptySession) notes.push('解析出 0 轮的空会话');
      else if (item.zeroTurnProblem) notes.push('解析出 0 轮，但不是合法空会话（见警告）');
      else if (item.contentBadLines || item.contentBadLinesScanError) {
        notes.push(item.usage === null ? '内容文件无法完整解析，0 轮不能当作空会话' : '内容文件无法完整解析');
      } else if (item.usage === null && !item.usageBadLines && !item.usageBadLinesScanError) notes.push('无 usage 字段');
      else if (item.usage === null && (item.usageBadLines || item.usageBadLinesScanError)) notes.push('未读出有效用量');
      if (item.contentBadLines) notes.push(`内容文件另有 ${item.contentBadLines} 行无法解析`);
      if (item.contentBadLinesScanError) notes.push(`内容文件坏行无法统计（${item.contentBadLinesScanError}）`);
      if (item.contentProblem) notes.push(`内容文件: ${item.contentProblem}`);
      if (item.usageBadLines) {
        notes.push(`用量数据源另有 ${item.usageBadLines} 行无法解析，这些行没计入，这个数是下界`);
      }
      if (item.usageBadLinesScanError) {
        notes.push(`用量数据源坏行无法统计（${item.usageBadLinesScanError}），这个数是下界且程度未知`);
      }
      // 坏行扫描错误与内容完整性说明可能带本机路径 / 原始 errno 文案， stdout 没有第二层转义。
      const note = notes.length ? escapeControlChars(`（${notes.join('；')}）`) : '';
      console.log(
        // 打全 id：截成 8 位再省略号就复制不了，接不上 watch adopt --session / 原生 resume
        `  ${item.provider.padEnd(8)} ${escapeControlChars(item.sessionId)}  in=${u.inputTokens}  out=${u.outputTokens}${note}`,
      );
    }
  } catch (error) {
    // 链库读写失败时把原因翻成中文（半坏 schema 下这里是第二条出口），业务结论原样带出
    failWithCwd(json, cwdIssue, describeCommandError(error));
  }
}

/**
 * `--reset-index` 的确认行。
 *
 * 必须说清「清了什么、没动什么、其它目录需要各自重建」：只回一句「已清空」会让人以为
 * 搜索要从零重建全部目录的索引，或者反过来以为链也被清掉了。
 */
function describeIndexReset(info: { rows: number; sessions: number; directories: number; vacuumed: boolean }): string {
  const vacuumText = info.vacuumed ? '库文件已压缩' : '库文件未能压缩（原因见警告）';
  if (info.sessions === 0) {
    return `本地搜索索引本来就是空的（0 段），链与切换记录未受影响；${vacuumText}`;
  }
  return (
    `已清空本地搜索索引：${info.rows} 段 / ${info.sessions} 个会话 / ${info.directories} 个目录（链与切换记录未受影响）；` +
    `本轮重新索引当前目录，其它目录的索引会在各自 search 时重建；${vacuumText}`
  );
}

async function cmdSearch(cwd: string, json: boolean, query: string, resetIndex = false): Promise<void> {
  const store = openStore();
  if (!store) fail(json, storeUnavailableError());
  // 声明在 try 外面：`--reset-index` 成功之后、搜索本身才失败时，失败输出必须带上这件事。
  // 以前 resetInfo 在 try 里，外层的 catch 看不见它——`--json` 回 `{ok:false,error}`，
  // 两张表却已经从 1 行变 0 行，用户只看到「搜索失败」，不知道索引已经被清过
  let resetInfo: ReturnType<Store['resetSearchIndex']> | null = null;
  try {
    const warnings: string[] = [];
    const unavailable: string[] = [];
    const emptied: EmptiedSession[] = [];
    // `--reset-index`：只清搜索索引（全部目录），链与切换记录不动。索引每行都能由会话文件
    // 重建，所以这是唯一一条不丢东西的省空间路径；删库会连链一起丢，doctor 的体积一栏才要把
    // 这两条岔开说。失败时不能半途继续搜索——用户会以为「清过了还搜不到」是索引没建起来。
    if (resetIndex) {
      try {
        resetInfo = store.resetSearchIndex();
      } catch (error) {
        fail(
          json,
          `清空搜索索引失败：${describeStoreErrorReason(error)}；本次未改动链与切换记录，索引按事务回滚，可原样重试`,
        );
      }
      if (!json) console.log(describeIndexReset(resetInfo));
      if (!resetInfo.vacuumed) {
        warnings.push(
          `搜索索引已清空，但库文件没能压缩（${resetInfo.vacuumError}）：VACUUM 需要约等于库大小的临时空间，` +
            `腾出空间后可重跑 watch search <词> --reset-index，否则这些页要等后续写入才被复用`,
        );
      }
    }
    // 探测留到 JSON 出口：零命中 + ok:true 分不清「没聊过」与「--cwd 不可用」
    const cwdProbe = await inspectCwd(cwd);
    const cwdIssue = describeCwdProblem(cwdProbe, cwd);
    if (cwdIssue) warnings.push(cwdIssue);
    // `:memory:` 时索引只活在本次进程内：每次 search 都得从头全量建一遍，
    // 命令结束后也没有任何东西留下来。不说的话只会表现为「搜什么都慢、而且只有本次能搜到」
    if (ephemeralDb) {
      warnings.push(ephemeralStoreWarning('搜索索引建在这份临时库里，命令结束就没了（每次 search 都要重新全量索引）'));
    }
    const coverage: SearchCoverage = { capped: [], incomplete: [] };
    await reindexCwd(cwd, listAdapters(), store, warnings, unavailable, emptied, coverage);
    // 0 字节会话（进程被杀 / 只写了一半 / 磁盘满）索引里一行内容都没有，命中永远为零。
    // 只回「没有匹配」会被读成「那句话没聊过」，而它可能正躺在一条内容已丢失的会话里。
    // `sessions` / `recent` / `doctor` 早已披露这一档，搜索是最后一个沉默的入口。
    if (emptied.length) warnings.push(emptiedSessionsWarning(emptied));
    // 归属读不出来的会话（Codex 是 `session_meta` 首行坏了）不属于任何 cwd，因此永远进不了索引。
    // 搜索恰恰是「我还记得那句话」的入口：只报「无结果」会把「这几条根本没被搜到」讲成「没聊过」
    const unattributableStats = await collectUnattributable(listAdapters());
    for (const stat of unattributableStats) warnings.push(unattributableWarning(stat, cwd));
    // 三种上限各自独立：全局 40 条、单会话 3 条、session id 前缀 10 条；只说「truncated」会混淆是哪一种
    const { hits, truncated, perSessionCapped, idPrefixCapped, candidatesSaturated } = store.searchMessagesWithMeta(query, cwd);
    // 零命中时先把「本目录之外的命中」查出来：它决定下一步给什么，也决定要不要再问 cwdAliasHint。
    // 同一个目录的另一种写法（软链、/var 与 /private/var 这类前缀）在索引里是另一个 cwd 字符串，
    // `searchElsewhere()` 会把它一起返回——那不能说成「其它目录」，而索引行自己的 cwd 就是可直接照抄的
    // 下一步（比 realpath 可靠：索引按那个字符串记，换成 realpath 未必查得到）。
    let sameDirectoryElsewhere: SearchElsewhere[] = [];
    let otherDirectoriesElsewhere: SearchElsewhere[] = [];
    if (!hits.length && !cwdIssue) {
      try {
        const split = await splitElsewhereByDirectory(store.searchElsewhere(query, cwd), cwd);
        sameDirectoryElsewhere = split.sameDirectory;
        otherDirectoriesElsewhere = split.otherDirectories;
      } catch {
        // 补充说明而已：查询失败时正文照常给，真正的库故障已由 openStore / 搜索本身报出
      }
    }
    // 零命中与 status / sessions / recent 同一口径：`--cwd` 可能只是同一个目录的另一种写法，
    // 只留一句「本目录没有匹配」会把「会话在另一个写法下面」讲成「这里没聊过」。
    // 走 `warnings`（不是 notes）：同一件事实在四条命令上必须落在同一个通道。
    // 索引里已经知道这个目录的另一种写法是什么字符串时用它当下一步，与 notes 里那条保持一致
    // （realpath 未必查得到：索引按记录里的原字符串存）
    // 这句说明的前提是「本目录没扫到任何会话」（文案里就这么写）。本目录扫到了会话、只是没搜到这个词时
    // 不能套用：以前只看零命中，于是在软链 / `/var` 这类有别名的目录里，每一次没搜到都被讲成
    // 「本目录没扫到任何会话…换个 --cwd 重试」——会话明明在，换了写法反而一条都查不到。
    // 另一种写法下确有匹配时，下面的 notes 会用索引里记的那个字符串单独指路。
    if (!hits.length && !cwdIssue && !coverage.sessions) {
      // 有一家没读成、达到列表上限、或有一批文件压根没进/未完整进索引时，零命中只说明「没搜到」，不是「写法不对」
      const alias = await cwdAliasHint(cwd, sameDirectoryElsewhere[0]?.cwd, [
        ...unavailable,
        ...coverage.capped,
        ...coverage.incomplete,
        ...unattributableStats.map((s) => s.provider),
        ...emptied.map((r) => r.provider),
      ]);
      if (alias) warnings.push(alias);
    }
    pushEscapedContentWarning(
      warnings,
      // 判定要在「折叠空白之后」的文本上做：多行消息的换行本来就会被折成空格，
      // 按原文判会让几乎每条命中都冒出一条假警告。
      hits.filter((h) => hasControlChars(h.snippet.replace(/\s+/g, ' '))),
      '搜索片段',
    );
    // 零命中不是结论：搜索按 cwd 限定，别处有匹配时必须指路，否则「这个目录没聊过」
    // 与「会话属于另一个目录」在输出里一模一样（README 的用法里 search 从不带 --cwd 时才是全局）
    const notes: string[] = [];
    if (!hits.length) {
      // 「同一个目录的另一种写法」与「确实是别的目录」分开说：两句话的下一步不同
      if (sameDirectoryElsewhere.length) notes.push(searchSameDirectoryHint(sameDirectoryElsewhere, cwd, query));
      if (otherDirectoriesElsewhere.length) notes.push(searchElsewhereHint(otherDirectoriesElsewhere, cwd, query));
      if (unavailable.length) {
        notes.push(
          `本次没有命中，但 ${unavailable.join(' / ')} 的会话列表没能读取（原因见上方警告），搜索没有覆盖到它们——不代表这些 Agent 里没有匹配；先修好这些存储（权限、路径或库状态）再重试`,
        );
      }
      if (coverage.capped.length) {
        notes.push(
          `本次没有命中，但 ${coverage.capped.join(' / ')} 的会话数已达列表上限（原因见上方警告），更早的会话没有进入搜索索引——无法确认它们里面是否有你要找的内容`,
        );
      }
      if (coverage.incomplete.length) {
        notes.push(
          `本次没有命中，但 ${coverage.incomplete.join(' / ')} 有会话未能完整写入搜索索引（原因见上方警告），这部分内容本次没有覆盖到——不代表这个目录里没聊过；按上方提示处理后重跑 search 即可`,
        );
      }
      const unattrNote = unattributableSearchNote(unattributableStats);
      if (unattrNote) notes.push(unattrNote);
      const emptiedNote = emptiedSearchNote(emptied);
      if (emptiedNote) notes.push(emptiedNote);
    }
    if (json) {
      // 覆盖范围的结构化出口：文本模式早就用 capped / incomplete 决定「无结果」能不能下结论，
      // `--json` 以前只有 `unavailable` / `unattributable` / `emptied`，脚本无法分辨
      // 「本目录没有匹配」与「有一家没搜全」。`sessions` 是本次枚举到的会话总数（0 有意义：
      // 这个 cwd 下一条会话都没有）；其余键只在非空时出现，与上面几个可选字段同一约定。
      const coverageJson = {
        ...(coverage.sessions !== undefined ? { sessions: coverage.sessions } : {}),
        ...(coverage.capped.length ? { capped: coverage.capped } : {}),
        ...(coverage.incomplete.length ? { incomplete: coverage.incomplete } : {}),
      };
      console.log(JSON.stringify({
        ok: true,
        query,
        cwd,
        // 零命中 + ok:true 分不清「这个目录没有匹配」与「--cwd 不可用」：与 status / sessions / recent / usage 同字段
        ...cwdStateField(cwdProbe),
        hits,
        ...(Object.keys(coverageJson).length ? { coverage: coverageJson } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(perSessionCapped ? { perSessionCapped: true } : {}),
        ...(idPrefixCapped ? { idPrefixCapped: true } : {}),
        ...(candidatesSaturated ? { candidatesSaturated: true } : {}),
        ...(unavailable.length ? { unavailable } : {}),
        ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
        ...(emptied.length ? { emptied: emptiedJson(emptied) } : {}),
        ...(resetInfo ? { resetIndex: { ...resetInfo } } : {}),
        ...(notes.length ? { notes } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    // 零命中时正文该不该下「本目录没有匹配」的结论：上面任何一档缺口都说明这次没搜全
    const coverageGap =
      unavailable.length > 0 ||
      coverage.capped.length > 0 ||
      coverage.incomplete.length > 0 ||
      emptied.length > 0 ||
      unattributableStats.length > 0;
    for (const warning of warnings) console.error(`警告: ${escapeControlChars(warning)}`);
    if (!hits.length) {
      // 正文先说清范围（搜索只覆盖这一个目录），再说有没有别处线索——
      // 单打一句「无结果」会被当成「这台机器上没有」。
      // `--cwd` 本身不可用时连「这个目录」都不存在：改成说清这次搜索没覆盖到东西，
      // 否则「本目录没有匹配」会被当成「那句话没聊过」（原因已在 warnings 里）。
      // 有会话 / Agent 存储压根没进索引时同样不能说「本目录没有匹配」：那是「没搜全」，
      // 不是「没聊过」。以前首句先下结论、notes 再撤回，读第一行的人已经得到了错误结论
      console.log(
        cwdIssue
          ? cwdUnusableConclusion('无结果', '本次搜索不能说明这个目录里有没有匹配')
          : coverageGap
            ? `无结果：本次没有搜到匹配，但搜索覆盖不完整（只查了 ${escapeControlChars(cwd)}；有会话没能进入搜索索引，原因见上方警告）——这不代表这个目录里没聊过`
            : `无结果：本目录没有匹配（搜索按目录限定，只查了 ${escapeControlChars(cwd)}）`,
      );
      for (const note of notes) console.log(note);
      return;
    }
    for (const h of hits) {
      console.log(`${h.provider}  ${escapeControlChars(h.sessionId)}`);
      console.log(`  ${escapeControlChars(h.snippet.replace(/\s+/g, ' '))}`);
    }
    if (truncated) {
      console.error(
        `提示: 命中数达到上限 ${SEARCH_MAX_HITS} 条，可能还有更多结果未列出（单个会话最多 3 条），可用更具体的关键词缩小范围`,
      );
    }
    if (perSessionCapped) {
      console.error('提示: 单个会话最多显示 3 条命中，命中更多的会话只列出了前 3 条，可用更具体的关键词缩小范围');
    }
    if (idPrefixCapped) {
      console.error('提示: session id 前缀命中超过 10 个，只列出前 10 个，可用更长的 id 前缀缩小范围');
    }
    if (candidatesSaturated) {
      // 与前两条不同：前两条说的是「已取到的结果里截了多少」，这条说「候选集本身可能被别的会话占满了」，
      // 另一些会话的命中压根没进候选，输出里看不到——不披露就会被读成「只在这些会话里出现过」
      console.error(
        `提示: 候选命中超过扫描上限 ${SEARCH_SCAN_LIMIT} 条，可能被单个会话占满，其它会话里的匹配没有进入结果；可用更具体的关键词缩小范围`,
      );
    }
  } catch (error) {
    // 查询类命令同样会撞上坏库（`search_index` 缺列、`messages_fts` 缺表…）：
    // 裸 SQLite 原文既不说这是库的问题，也给不出重建的下一步
    const message = describeCommandError(error);
    if (!resetInfo) fail(json, message);
    // 索引已经清空、搜索才失败：两件事都要说。`--json` 也带 resetIndex，
    // 否则调用方只拿到一个 error，没法知道索引已被清过（下次搜索要从零重建）
    fail(
      json,
      `--reset-index 已执行（${resetInfo.rows} 段 / ${resetInfo.sessions} 个会话 / ${resetInfo.directories} 个目录已清空，链与切换记录未受影响），` +
        `但随后的搜索失败：${message}`,
      { resetIndex: { ...resetInfo } },
    );
  }
}

main().catch((error) => {
  // `--json` 的契约是「成功与失败都向 stdout 输出单行 JSON」：命令级 fail() 之外逃出来的异常
  // 也要遵守，否则 Rust 桥只能回「CLI 无输出, exit=1」。已经写过 stdout 的命令不再补第二行。
  handleFatal(error, {
    json: JSON_REQUESTED,
    bytesWritten: Number(process.stdout.bytesWritten ?? 0),
    // 写完再退出：管道 / 重定向下 process.exit() 会丢掉还没刷出去的缓冲
    writeJson: (line) => process.stdout.write(line, () => process.exit(1)),
    writeError: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });
});
