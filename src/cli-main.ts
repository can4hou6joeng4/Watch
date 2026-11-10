#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { chainsElsewhereHint, chainsSameDirectoryHint, isStoreError, SEARCH_MAX_HITS, searchElsewhereHint, searchSameDirectoryHint, Store, defaultDbPath, describeStoreErrorReason, describeStoreOpenFailure } from './core/store.js';
import type { Chain, ChainsElsewhere, SearchElsewhere } from './core/store.js';
import { describeFindings } from './core/findings.js';
import { adoptIntoChain, blockedHint, chainStatus, chainUsage, collectTips, createChainSession, currentChainShiftNote, emptyChainBindHint, handoff, HandoffBlockedError, notCurrentChainWarning, rebindHint, storeUnavailableWarning } from './core/handoff.js';
import { reindexCwd } from './core/search.js';
import type { SessionRef } from './core/types.js';
import type { TokenUsage } from './core/types.js';
import {
  buildHandoffPrompt,
  DEFAULT_PROMPT_PROFILE,
  parsePromptProfile,
  PROMPT_PROFILES,
} from './core/handoff-prompt.js';
import { getAdapter, listAdapters, listProviders, noSessionHint, unknownProviderMessage } from './providers/registry.js';
import { checkOpenInProvider, LOOKUP_NEXT_STEP, lookupMissHeadline, openInProvider, openSession, resolveById } from './open.js';
import type { LookupMiss } from './open.js';
import { PreflightBlockedError } from './providers/adapter.js';
import { runImportCodex } from './import-codex.js';
import { ImportJobs } from './core/import-jobs.js';
import { officialImportJournalRoot } from './providers/codex/official-import.js';
import { doctorReport } from './core/doctor.js';
import { cwdAliasHint, cwdControlCharsNote, cwdProblem, describeCwdProblem, describeWriteCwd, inspectCwd, sameDirectorySync, splitElsewhereByDirectory } from './core/cwd.js';
import { escapeControlChars, hasControlChars } from './core/display.js';
import { trimUserKey } from './core/cli-input.js';
import { describeResumeTargetUnfinished } from './core/rich.js';
import { describePathReadFailureReason, describeReadFailureOrSelf, describeSessionReadFailureReason, isEmptySessionFileReason, probeSessionReadable, sessionFilePresence } from './core/read-text.js';
import { describeWriteFailureReason } from './core/atomic.js';
import { collectUnattributable, emptiedJson, emptiedSearchNote, emptiedSessionsWarning, unattributableEmptyNote, unattributableJson, unattributableSearchNote, unattributableWarning } from './core/session-coverage.js';
import type { EmptiedSession } from './core/session-coverage.js';
import { describeSpawnFailure } from './core/platform.js';
import { readWatchVersion } from './core/watch-version.js';
import { CAPABILITY_VERIFICATION_NOTE, describeCapabilities, formatCapabilities } from './core/capabilities.js';

/**
 * 参数还没解析完就要报用法错误（缺值 / 越界 / 未知 flag）：此时 `--json` 已经能从 argv 看出来。
 * 用法文本始终走 stderr；带 `--json` 时再补一行 JSON 错误，否则 stdout 为空，
 * Rust 桥只能把整段用法当错误文本显示给桌面端。
 */
const JSON_REQUESTED = process.argv.includes('--json');

/**
 * `reason` 用来把「哪里不对」讲清楚：只打一整段用法时，用户得自己翻整页才知道
 * 是命令名拼错了、少了 provider，还是 `--limit` 越界。
 */
function usage(reason?: string): never {
  if (reason) console.error(`[watch] ${reason}`);
  console.error(`用法:
  watch --version [--json]                          打印版本号（读 package.json；读不出来给 null）
  watch status [--json] [--cwd <path>] [--chain <id|name>]
  watch switch <provider> [--json] [--cwd <path>] [--chain <id|name>]
  watch adopt <provider> [--json] [--cwd <path>] [--chain <id|name>] [--session <id>]
  watch sessions [--json] [--cwd <path>] [--chain <id|name>]
  watch recent [--json] [--cwd <path>] [--limit <n>]
  watch providers [--json]
  watch capabilities [--json]                       各 Agent 的读写能力矩阵（代码事实，不探测本机 CLI）
  watch prompt <session-id> [--provider <name>] [--profile minimal|standard|verbose|full] [--last <n>] [--json]
                                                    摘要交接：把会话渲染成可粘贴给任意 Agent 的 Markdown（降级方案，不写任何文件）
  watch doctor [--json] [--strict] [--cwd <path>]   只读环境诊断：Agent 检测、本地库、导入日志（不写盘）
  watch new <provider> [--json] [--cwd <path>] [--chain <id|name>]
  watch chain list|new <name>|rename <id|name> <new>|archive <id|name>|use <id|name> [--json] [--cwd]
  watch search <query> [--json] [--cwd <path>]
  watch usage [--json] [--cwd <path>] [--chain <id|name>]
  watch import-codex prepare|confirm|status <id> [--cwd <path>] [--desktop-project] [--experimental] [--json]
  watch import-codex project-prepare|project-confirm|project-status <plan-id> [--project <project-id>] [--experimental] [--json]
  watch open <session-id> [--from <session-id>] [--provider <name>] [--to <provider>] [--check] [--json]  反查 cwd 并输出 cd + 打开命令；带 --from 先并入旧会话；带 --to 把该会话内容转入指定 provider 的新会话；带 --check 只做点击前预检（不写入）`);
  if (JSON_REQUESTED) {
    const help = process.argv.includes('--help');
    console.log(
      JSON.stringify({
        ok: false,
        error: help
          ? '已打印用法到 stderr（--json 模式下不输出结果）'
          : reason
            ? `用法错误：${reason}（完整用法见 stderr）`
            : '用法错误：参数不完整或不合法（完整用法见 stderr）',
      }),
    );
  }
  process.exit(1);
}

function fail(json: boolean, message: string, extra?: Record<string, unknown>): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(message);
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
  const payload = {
    ok: false,
    error: error.message,
    blocked: true,
    code,
    sessionId: block?.sessionId,
    holders: block?.holders,
    hint: block?.hint ?? blockedHint(code),
  };
  if (json) console.log(JSON.stringify(payload));
  else console.error(`[blocked:${code}] ${error.message}\n${payload.hint}`);
  process.exit(1);
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

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
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
      .map((s) => `${s.provider}:${s.sessionId}（${s.previewError}）`)
      .join('、') + (list.length > 3 ? ' 等' : '');
  // 下一步按原因分档：0 字节是内容已经没了，改权限 / 换路径都救不回来；
  // 读不出来（权限、路径）才是「先修好再重试」。同一句混着说，两种人都会走错方向。
  const empty = hits.filter((s) => isEmptySessionFileReason(s.previewError!));
  const denied = hits.filter((s) => !isEmptySessionFileReason(s.previewError!));
  if (empty.length) {
    warnings.push(
      `有 ${empty.length} 条会话的文件是空的（0 字节，进程被杀或只写了一半，内容已丢失）：${detail(empty)}；` +
        `列表照常列出，但 open / switch 读不出任何内容——这些会话没有可恢复的对话，只能重新开一次会话或从备份恢复`,
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
  check: boolean;
  strict: boolean;
  limit?: number;
  usedFlags: string[];
  cwdGiven: boolean;
  /** 去掉命令名之后的全部位置参数（含 provider / 链名等）：命令层要数「多给了几条」 */
  positional: string[];
} {
  const args = argv.slice(2);
  const json = args.includes('--json');
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
  /** 取下一个 token 作为参数值；缺值、误吞下一个 flag、或同一选项给了两次都按用法错误处理 */
  const takeValue = (flag: string): string => {
    const next = args[++i];
    if (!next) usage(`${flag} 缺少取值`);
    // 下一个 token 仍是 flag：说明取值漏了，别把它吞成值
    if (next.startsWith('--')) usage(`${flag} 缺少取值（后面跟着 ${next}）`);
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
    const a = args[i]!;
    if (a === '--json') continue;
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
      const message = `未知参数: ${a}`;
      if (json) {
        console.log(JSON.stringify({ ok: false, error: message }));
        process.exit(1);
      }
      console.error(`[watch] ${message}`);
      usage();
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
    check,
    strict,
    limit,
    usedFlags,
    cwdGiven,
    positional: positional.slice(1),
  };
}

/**
 * 本目录一条链都没有时，本地库里其它目录的链。
 *
 * 这条查询只是**补充说明**：库读不出来就当没有（`chain list` / `status` 的正文不该因为
 * 它一起失败），真正的库故障已经由别处的警告说清。
 */
function chainsElsewhereOf(store: Store | null, cwd: string): ChainsElsewhere[] {
  if (!store) return [];
  try {
    return store.chainsElsewhere(cwd);
  } catch {
    return [];
  }
}

/**
 * 「别处的链」按真实路径分成「同一个目录的另一种写法」与「确实是别的目录」。
 *
 * 链按 `--cwd` 精确匹配，同一目录换个写法在库里就是两个 cwd，于是 `chainsElsewhere()`
 * 会把它们一起返回；只说「属于其它目录」是错的，`--json` 里也要能分辨，因此给那一档
 * 行加上 `sameDirectory: true`（其余行保持原样，不新增字段）。
 */
async function splitChainsElsewhere(
  rows: ChainsElsewhere[],
  cwd: string,
): Promise<{ same: ChainsElsewhere[]; other: ChainsElsewhere[] }> {
  const split = await splitElsewhereByDirectory(rows, cwd);
  return {
    same: split.sameDirectory.map((r) => ({ ...r, sameDirectory: true })),
    other: split.otherDirectories,
  };
}

/** 读这个 cwd 下的链名；读不出来返回 null（补充说明不该让写命令失败）。 */
function chainNamesOf(store: Store | null, cwd: string): string[] | null {
  if (!store) return null;
  try {
    return store.listChains(cwd).map((chain) => chain.name);
  } catch {
    return null;
  }
}

/**
 * 逐条比出这次新建的链名。读不出来（任一侧为 null）或一次新增了多条时返回 null——
 * 名字只是用来把说明指向那条链，判不出来就退回不带名字的说法，不猜。
 */
function newChainName(before: string[] | null, after: string[] | null): string | null {
  if (!before || !after) return null;
  const added = after.filter((name) => !before.includes(name));
  return added.length === 1 ? added[0] : null;
}

/**
 * 写入侧（`chain new` / `new`）在「同一个目录的另一种写法」下已经有链时，必须说明这件事。
 *
 * 链按 `--cwd` 的**原字符串**分组，而同一个物理目录可以有很多种写法（软链、`/var` 与
 * `/private/var` 这类前缀、名字大小写）。读路径（`chain list` / `status` / `usage` / `doctor` /
 * `search` / `switch` / `adopt` / `chain use`）早已会指出「同一个目录的另一种写法下有链」，
 * 但**写路径一直没有覆盖**：2026-11-09 实测（隔离 HOME，`<tmp>/proj-real` 软链成
 * `<tmp>/proj-link`）先 `chain new 主力 --cwd <real>`、再 `chain new 主力 --cwd <link>`，两次都是
 * `ok:true` 且 `warnings` 一个字都没有——同一个项目里于是有了两条都叫「主力」的链，`chain list`
 * 在两边各自标「← 当前」，之后不带 `--cwd` 的 switch / new / adopt 只作用在用户当前那条写法对应的
 * 那一组上。`watch new claude --cwd <link>` 同样静默建出第二组「默认」链。
 *
 * 下一步只给「换成记录里的原字符串重跑」这一个真实可用的动作：绝不建议
 * `watch chain archive <刚建的名字>`——`archiveChain()` 拒绝归档本目录唯一的活跃链，而刚建出来的
 * 这条往往正是那唯一一条，等于给了一条注定失败的命令。
 */
async function aliasChainGroupWarning(
  store: Store | null,
  cwd: string,
  createdName: string | null,
): Promise<string | null> {
  if (!store) return null;
  const { same } = await splitChainsElsewhere(chainsElsewhereOf(store, cwd), cwd);
  if (!same.length) return null;
  const groups: string[] = [];
  const collisions: string[] = [];
  let total = 0;
  const shownCwd = escapeControlChars(cwd);
  for (const row of same) {
    total += row.total;
    const names = chainNamesOf(store, row.cwd) ?? [];
    if (createdName && names.includes(createdName)) collisions.push(row.cwd);
    const shown = names.slice(0, 3).map((name) => `「${escapeControlChars(name)}」`).join(' / ');
    const rowCwd = escapeControlChars(row.cwd);
    groups.push(shown ? `${rowCwd} 下有 ${shown}${names.length > 3 ? ` 等 ${names.length} 条` : ''}` : `${rowCwd} 下有 ${row.total} 条链（名字读不出来）`);
  }
  const created = createdName
    ? `在 ${shownCwd} 下建了链「${escapeControlChars(createdName)}」`
    : `在 ${shownCwd} 下写了链记录`;
  const collision = collisions.length
    ? `；两个写法下都有「${escapeControlChars(createdName!)}」，但它们不是同一条链`
    : '';
  const moreGroup = same.length > 3 ? ` 等 ${same.length} 个写法` : '';
  const target = escapeControlChars(same[0].cwd);
  return (
    `${shownCwd} 和 ${same.slice(0, 3).map((r) => escapeControlChars(r.cwd)).join('、')}${moreGroup} 是同一个目录的另一种写法` +
    '（链按 --cwd 的原字符串分组，两种写法在本地库里是两个目录、互相看不到）。' +
    `这次${created}，而那个写法下已经有 ${total} 条链（${groups.join('；')}）${collision}。` +
    `同一个项目里现在有两组链：之后不带 --cwd 的 status / switch / new / adopt 只作用在当前这条 --cwd 对应的那一组上。` +
    `要接着用原来那一组，把 --cwd 换成 ${target} 重跑同一条命令（其余参数照旧）` +
    '——链记录的工作目录在创建时定死，没有改名 / 移动的办法' +
    cwdControlCharsNote(cwd)
  );
}

async function cmdStatus(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  // 路径写错时各 provider 会安静返回空列表，先把原因放进同一条 warnings 通道
  const cwdIssue = await cwdProblem(cwd);
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
      ...result,
      ...(elsewhereJson.length ? { chainsElsewhere: elsewhereJson } : {}),
      ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
    }));
    return;
  }
  const { tips, chainTip, chainTipUnusable, unreadable, history, chain: current, warnings } = result;
  for (const warning of warnings) console.error(`警告: ${warning}`);
  // 链名是用户输入、库里可能留着写入守卫上线前的坏名字：进终端前转义，别把 ESC / 换行打出去
  if (current) console.log(`链: ${escapeControlChars(current.name)}${current.status === 'archived' ? ' [归档]' : ''}  (${current.id})`);
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
    console.log(
      `未发现可列出的原生会话；链尾记录的是 ${chainTip.provider} 会话 ${chainTip.ref.sessionId}，` +
        `其文件当前不可用（原因见上方警告）——可先恢复该文件，或 ${rebindHint(chainTip.provider)}`,
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
      // 一条看起来正常的 mtime 背后打不开（原因已由上方警告给出）
      const readMark = tip.unreadable ? '（文件读不出来，原因见上方警告）' : '';
      console.log(
        `  ${tip.provider.padEnd(8)} ${tip.ref.sessionId}  mtime=${fmtTime(tip.updatedAt)}${chainMark}${mark}${readMark}`,
      );
      console.log(`           ${escapeControlChars(tip.ref.filePath)}`);
    }
  }
  if (history.length) {
    console.log('');
    console.log('切换链:');
    for (const h of history) {
      const from = h.fromProvider ?? '?';
      console.log(`  ${from} → ${h.toProvider}  (${h.toRef.sessionId})  @ ${fmtTime(h.createdAt)}`);
    }
  } else if (store) {
    console.log('');
    console.log('切换链: （空）');
    // 上一行是结论：本目录没有链。别处有链时必须接着指路，否则「（空）」会被当成链没了。
    // 「同一个目录的另一种写法」与「确实是别的目录」分开说，两句话的下一步不同
    if (splitElsewhere.same.length) console.log(chainsSameDirectoryHint(splitElsewhere.same));
    if (splitElsewhere.other.length) console.log(chainsElsewhereHint(splitElsewhere.other));
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
  const cwdIssue = await cwdProblem(cwd);
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
    result.warnings.push(...chainProbe);
    // 显式写了 --chain 却把当前链换走了，是这条命令最该说的一句：用户的动机恰恰是
    // 「这一次操作那条链，别动当前链」，而输出只有「已从 X 交接 → Y」
    const currentChain = safeActiveChain(store, cwd, result.warnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          ...result,
          ...(shiftNote ? { warnings: [...result.warnings, shiftNote], previousChain, currentChain } : {}),
        }),
      );
      return;
    }
    // 警告先打：alreadyAtTarget 分支同样可能带「读库/写链失败」，提前 return 会把它吞掉
    // 走 stderr：stdout 留给结果，重定向 / 管道时警告不该混进正文（与 status / new / usage 一致）
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    if (result.alreadyAtTarget) {
      // 链记录里可能根本没有链尾（chain new 之后没切过），也可能读不出来：这时一律说
      // 「链尾已在 X」会让人以为链已经绑到 X，而 status 里还是空的
      if (result.chainTipState === 'empty') {
        console.log('当前链还没有绑定任何会话（没有可交接的来源，本次未写入链记录）。');
        console.log(
          result.resumeUnreadable
            ? `已找到 ${targetId} 的最新会话，但它的文件现在读不出来（原因见上方警告）；要让链记录指向它，可用 watch adopt ${targetId} --session ${result.newRef.sessionId}`
            : `已找到 ${targetId} 的最新会话，可直接打开；要让链记录指向它，可用 watch adopt ${targetId} --session ${result.newRef.sessionId}`,
        );
      } else if (result.chainTipState === 'recorded') {
        // 链尾确实停在这家，但文件读不出来时「直接打开即可」是错的下一步：
        // 用户照抄的 resume 一执行就失败，而原因写在 stderr 的警告里，正文得先对得上
        console.log(
          result.resumeUnreadable
            ? `链尾已在 ${targetId}，但这条会话的文件现在读不出来，直接打开会失败（原因见上方警告）。`
            : `链尾已在 ${targetId}，直接打开即可。`,
        );
      } else {
        console.log(
          result.resumeUnreadable
            ? `无法确认链尾（本次未写入链记录），已找到 ${targetId} 的最新会话，但它的文件现在读不出来（原因见上方警告）。`
            : `无法确认链尾（本次未写入链记录），已找到 ${targetId} 的最新会话，可直接打开。`,
        );
      }
      console.log(`resume: ${result.resumeCommand}`);
      return;
    }
    console.log(`已从 ${result.fromProvider} 交接 → ${targetId}（${result.turnCount} 轮）`);
    console.log(`新会话: ${result.newRef.sessionId}`);
    console.log(`文件:   ${escapeControlChars(result.newRef.filePath)}`);
    console.log('');
    console.log(`resume: ${result.resumeCommand}`);
    // 结果说明走 stdout（同 chain new / chain archive 的位置），不是降级警告
    if (shiftNote) console.log(`\n${shiftNote}`);
    // exact 之外的处置（整文件重写、去重跳过等）--json 里一直有，文本模式也要说，否则看不出内容被改写过
    for (const line of describeFindings(result.findings ?? [])) console.error(`说明: ${line}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 「当前链没读成」只在失败原因本身不是库故障时才补：库坏掉时下面那句已经带原因与下一步
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    const message = [probe, describeCommandError(error)].filter(Boolean).join('；');
    // 目录本身有问题时，失败原因先说路径，否则「找不到来源会话」会被当成「目录里没东西」
    if (json) {
      console.log(JSON.stringify({ ok: false, error: cwdIssue ? `${cwdIssue}；${message}` : message }));
    } else {
      console.error(cwdIssue ? `${cwdIssue}；${message}` : message);
    }
    process.exit(1);
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
  const cwdIssue = await cwdProblem(cwd);
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
    // adopt 只写链记录、不读会话内容，所以「文件本身读不出来」在这里一点都看不出来：
    // `sessions` / `recent` 会为同一条会话警告「open / switch 读它时同样会失败」，
    // adopt 却回 ok:true 并给出一条一执行就失败的 resume。`stat` 对 `chmod 000` 照常成功
    // （列目录就能接入），因此接入之后单独 open 一次确认它真的读得出来。
    const readProblem = await probeSessionReadable(result.adoptedRef.filePath);
    if (readProblem) {
      result.warnings.push(
        `接入了会话 ${result.adoptedRef.sessionId}（${adoptedAdapter?.displayName ?? result.adoptedRef.provider}），但它的会话文件现在读不出来：${readProblem}；` +
          `链记录已写入，本次没有改动会话文件——但 ${
            resumeCommand ? `resume 命令（${resumeCommand}）` : '打开这条会话'
          }一执行就会失败，先修好这个文件再打开，或用 watch adopt <provider> --session <会话 id> 换成另一条会话`,
      );
    }
    // 读得出来也不等于「收尾了」：这条会话可能停在做了一半的工具调用上，或最后一句是用户消息。
    // `open <id>` / `switch` / `new <同一家>` 在同样情况下都会说（第 276–280 轮），只有 adopt
    // 不看内容、还顺手打印 resume——用户照着复制，接手的就是那一轮断掉的地方。这里恒为零增量
    // （adopt 不写任何会话内容），两种形状都要说。
    // 文件本身读不出来已由上面那句说清（resume 一执行就失败），不再重复解析一遍。
    if (!readProblem && adoptedAdapter) {
      try {
        for (const warning of describeResumeTargetUnfinished(
          await adoptedAdapter.parse(result.adoptedRef),
          `目标会话 ${result.adoptedRef.sessionId}（${adoptedAdapter.displayName}）`,
          0,
        )) {
          result.warnings.push(warning);
        }
      } catch (error) {
        // 解析不了不等于没问题：至少要说成「没能确认」，不能沉默
        result.warnings.push(
          `无法确认接进来的会话 ${result.adoptedRef.sessionId} 是否停在做了一半的一轮上：${describeReadFailureOrSelf(error)}；` +
            `resume 之前先确认这个会话文件可读`,
        );
      }
    }
    result.warnings.push(...chainProbe);
    // 同 switch：显式 --chain 却把当前链换走了，必须在结果里说（空操作时链没被 touch，
    // previousChain 与 currentChain 相同，自然不冒这句）
    const currentChain = safeActiveChain(store, cwd, result.warnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      // `warnings` 只放降级原因，`note` 放结果说明（同 open 的 warnings / notes 分法）
      console.log(
        JSON.stringify({
          ok: true,
          ...result,
          ...(shiftNote ? { warnings: [...result.warnings, shiftNote], previousChain, currentChain } : {}),
          ...(resumeCommand ? { resumeCommand } : {}),
        }),
      );
      return;
    }
    // 与 switch 一致：警告先打（未写入链记录这类说明不能排在成功之后被漏看），且走 stderr
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    // 空操作（这条会话本来就绑在这家）时不能打「已接入链」：链上什么都没有变，
    // 而它可能正是用户想修的那件事（链尾还停在另一家）
    if (result.unchanged) {
      console.log(`未改动: ${result.adoptedRef.sessionId}`);
      if (result.note) console.log(`  ${result.note}`);
    } else {
      console.log(`已接入链: ${result.adoptedRef.sessionId}`);
      if (result.replacedRef) console.log(`替换了:  ${result.replacedRef.sessionId}`);
      // 没给 --session 时接入的是「按 mtime 挑的最新会话」，这一点不能只在 --json 里
      if (result.note) console.log(`  ${result.note}`);
    }
    if (resumeCommand) {
      console.log('');
      console.log(`resume: ${resumeCommand}`);
    }
    // 结果说明走 stdout（文本 mode 与 --json 的 warnings 同一条文案）
    if (shiftNote) console.log(`\n${shiftNote}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 同 switch：「当前链没读成」只在失败原因本身不是库故障时才补，避免同一件事说两遍
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    const message = [probe, describeCommandError(error)].filter(Boolean).join('；');
    if (json) console.log(JSON.stringify({ ok: false, error: cwdIssue ? `${cwdIssue}；${message}` : message }));
    else console.error(cwdIssue ? `${cwdIssue}；${message}` : message);
    process.exit(1);
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
      const target = checked.sessionId ? `${checked.sessionId}` : '（将新建会话）';
      // notes[0] 是给人看的计划描述（复用链上会话 / 并入既有 / 新建）；直接打 kind 会把内部枚举露给用户
      console.log(`预检：${checked.notes?.[0] ?? checked.plan?.kind ?? '?'} · 目标 ${target} · ${checked.writable ? '可写入' : '暂不可写'}`);
      // warnings 是降级原因（复用扫描失败、链上配对读不出等），只出现在 --json 里的话，
      // 文本模式的用户看不到「为什么是新建」
      for (const warning of checked.warnings ?? []) console.error(`提示: ${warning}`);
      if (!checked.writable) {
        for (const line of [checked.error, checked.blocked?.hint]) if (line) console.error(line);
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
      const extra = result.blocked ? { blocked: true, ...result.blocked } : undefined;
      if (!json && result.blocked) {
        // 与 failBlocked 同一格式：文本模式也要给 code 与下一步，不能只在 --json 里有
        console.error(`[blocked:${result.blocked.code}] ${result.error ?? '未知错误'}`);
        if (result.blocked.hint) console.error(result.blocked.hint);
        process.exit(1);
      }
      fail(json, result.error ?? '未知错误', extra);
    }
    if (json) {
      console.log(JSON.stringify(result));
      return;
    }
    // 降级原因走 stderr（与 switch / status 同一通道），stdout 只留结果行与可复制的 cd / resume
    for (const warning of result.warnings ?? []) console.error(`提示: ${warning}`);
    for (const n of result.notes ?? []) console.log(n);
    console.log(result.cd);
    console.log(result.resumeCommand);
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
  const cwdIssue = await cwdProblem(cwd);
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
        ? storeUnavailableWarning(`--chain ${chain} 过滤已忽略，下面是该目录的全部会话`, lastStoreError ?? undefined)
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
      // 链查询失败时退化为全量列表，但要说清楚，否则 --chain 的输出会被误读
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
              if (presence.state === 'missing') missingFiles.push(id);
              else if (presence.state === 'unknown') unreadableFiles.push({ id, reason: presence.reason });
              else if (!presence.isFile) occupiedFiles.push(id);
              else tooOld.push(id);
            }
            if (missingFiles.length) {
              warnings.push(
                `链 ${escapeControlChars(chainRow.name)} 绑定的 ${a.id} 会话 ${missingFiles.join('、')} 文件已不存在，本次未列出；下次切换会失败，${rebindHint(a.id)}` +
                  (missingFiles.length > 1 ? `（另有 ${missingFiles.length - 1} 个同样缺失，见上）` : ''),
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
        providers: result,
        ...(unavailable.length ? { unavailable } : {}),
        ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    for (const warning of warnings) console.error(`警告: ${warning}`);
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
        console.log(`  ${s.ref.sessionId}  mtime=${fmtTime(s.updatedAt)}`);
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
  };
  // 用 Map 而不是数组 + Set：同一会话可能先由映射表命中、再被原生扫描命中，
  // 原生那边的 mtime 与 preview 更准，合并时不能被「先到先得」丢掉（以前映射先入就丢 preview）。
  const merged = new Map<string, RecentItem>();
  const unavailable: string[] = [];
  const warnings: string[] = [];
  const cwdIssue = await cwdProblem(cwd);
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
              `${loc.provider} 会话 ${loc.sessionId} 的映射记录指向的路径现在不是普通文件（被同名目录或设备文件占住了）：${escapeControlChars(loc.filePath)}；已跳过映射命中，先恢复该路径再重试`,
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
              `${loc.provider} 会话 ${loc.sessionId} 的映射记录无法确认文件状态（${escapeControlChars(loc.filePath)}）：${describeSessionReadFailureReason(error)}；已跳过映射命中，先确认该路径是否可读再重试`,
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
  for (const adapter of recentAdapters) {
    if (!adapter.listSessions) continue;
    try {
      const sessions = await adapter.listSessions(cwd);
      // 撞上适配器上限时枚举到的只是「最近 N 个」：更早的会话根本没进结果，
      // truncated / total 都会低估，不说明就会被当成「这个目录只有这些会话」
      const cap = adapter.listSessionsCap;
      if (cap !== undefined && sessions.length >= cap) {
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
      sessions: final,
      ...(truncated ? { truncated: true, total: results.length } : {}),
      ...(unavailable.length ? { unavailable } : {}),
      ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
      ...(warnings.length ? { warnings } : {}),
    }));
    return;
  }
  for (const warning of warnings) console.error(`警告: ${warning}`);
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
    console.log(`  [${s.provider}] ${s.sessionId} (${escapeControlChars(s.cwd)})  mtime=${fmtTime(s.updatedAt)}`);
    if (s.preview) console.log(`    ${escapeControlChars(s.preview)}`);
  }
}

async function cmdProviders(json: boolean): Promise<void> {
  try {
    const providers = await listProviders();
    if (json) {
      console.log(JSON.stringify({ ok: true, providers }));
      return;
    }
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
 * `watch prompt <session-id>`：摘要交接（降级方案）。
 *
 * 只读：不写任何会话文件、不启动任何 CLI、不碰本地库的会话映射。用途有两条：
 * ① 目标工具根本没有适配器（Antigravity / Cursor / Claude Desktop），写不回原生格式；
 * ② 那家的格式刚漂移，写回去有风险。这时把会话渲染成一份可粘贴的 Markdown，
 * 比「不支持」更有用，但**必须**说清这是降级——文档一旦被复制走就脱离 Watch，
 * 所以降级声明写在正文里，而不是只打在 stderr。
 */
async function cmdPrompt(
  json: boolean,
  sessionId: string,
  provider: string | undefined,
  profileRaw: string | undefined,
  lastUserTurns: number | undefined,
): Promise<void> {
  const profile = profileRaw === undefined ? DEFAULT_PROMPT_PROFILE : parsePromptProfile(profileRaw);
  if (!profile) {
    // 档位是封闭枚举（四个词），写错时把可选值一起给出。
    // 取值已做 trim + 小写归一（`--profile " FULL "` 可用），所以这里只剩真正拼错的情况。
    usage(`--profile 只接受 ${PROMPT_PROFILES.join(' / ')}，收到: ${escapeControlChars(profileRaw ?? '')}`);
  }
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
  const { adapter, found } = resolved;
  const warnings = [...diagnostics];
  const id = escapeControlChars(found.ref.sessionId);

  let turns;
  try {
    turns = await adapter.parse(found.ref);
  } catch (error) {
    // 读不出来就不能装作「这条会话是空的」：文档正文会因此变成「没有可展示的内容」，
    // 与「会话确实没聊过」长得一模一样。
    fail(json, `会话 ${id} 读取失败：${describeReadFailureOrSelf(error)}；未生成任何内容`);
  }

  // 0 轮有两种完全不同的原因，`probeSessionReadable()` 是判据的唯一入口（与 open / switch 共用）。
  if (turns.length === 0) {
    const emptyReason = await probeSessionReadable(found.ref.filePath);
    if (emptyReason) warnings.push(`会话 ${id} 没有可交接的内容：${emptyReason}`);
  }

  let sessionUsage: TokenUsage | null = null;
  if (adapter.sessionUsage) {
    try {
      sessionUsage = await adapter.sessionUsage(found.ref);
    } catch (error) {
      warnings.push(`用量读取失败（${describeReadFailureOrSelf(error)}）；文档里的用量写成「没有可读的用量记录」`);
    }
  }

  const result = buildHandoffPrompt(
    turns,
    {
      providerId: adapter.id,
      providerName: adapter.displayName,
      sessionId: found.ref.sessionId,
      sourcePath: found.ref.filePath,
      cwd: found.ref.cwd,
      // 首条记录的时间当起点：文档里要给出时间范围，但只在真读到时间戳时写
      startedAt: toMillis(turns[0]?.timestamp),
      updatedAt: found.updatedAt,
      usage: sessionUsage,
    },
    profile,
    { ...(lastUserTurns !== undefined ? { lastUserTurns } : {}) },
  );

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      sessionId: found.ref.sessionId,
      provider: adapter.id,
      cwd: found.ref.cwd,
      profile: result.profile,
      ...(lastUserTurns !== undefined ? { lastUserTurns } : {}),
      markdown: result.markdown,
      stats: result.stats,
      findings: result.findings,
      ...(warnings.length ? { warnings } : {}),
    }));
    return;
  }
  // stdout 只放文档本身：它正是要被 `> seed.md` 或管道拿走的产物。
  // 诊断一律走 stderr，否则重定向后的文件里会混进「警告: …」。
  for (const warning of warnings) console.error(`警告: ${warning}`);
  for (const line of describeFindings(result.findings)) console.error(`说明: ${line}`);
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
function cmdCapabilities(json: boolean): void {
  const providers = describeCapabilities(listAdapters());
  if (!json) {
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
  }));
}

async function cmdDoctor(cwd: string, json: boolean, strict: boolean): Promise<void> {
  try {
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
    console.log(`本地库文件: ${escapeControlChars(env.dbPath)}`);
    console.log(`导入日志目录: ${env.importsRoot ? escapeControlChars(env.importsRoot) : '（不可用）'}`);
    console.log('Agent 检测:');
    for (const p of report.providers) {
      const state = p.available ? '✓ 已就绪' : p.error ? `✗ 检测失败: ${p.error}` : '✗ 未检测到';
      console.log(`  ${p.id.padEnd(10)} ${p.displayName.padEnd(12)} ${state}`);
    }
    if (report.storage.length) {
      console.log('会话存储:');
      for (const st of report.storage) {
        // 「连归属都读不出来」的条目不属于任何目录，所以只能挂在全局计数旁边说；
        // 不加这一句，用户看到的「0 个会话」就是结论，而那条会话可能只是被截断了
        const unattributableText = st.unattributable
          ? `（另有 ${st.unattributable} 个文件读不出目录归属，未计入）`
          : '';
        const countText =
          st.count === null
            ? `✗ 读取失败: ${st.error}${unattributableText}`
            : st.capped
              ? `≥ ${st.count} 个会话（已达列表上限，实际可能更多${st.unreadable ? `，其中 ${st.unreadable} 条读不出来` : ''}）${unattributableText}`
              : `${st.count} 个会话${st.unreadable ? `（${st.unreadable} 条读不出来）` : ''}${unattributableText}`;
        console.log(`  ${st.provider.padEnd(10)} ${countText}`);
      }
    }
    if (report.store.available) {
      const broken = report.store.brokenTips.filter((b) => b.missing).length;
      const unreadable = report.store.brokenTips.filter((b) => b.unreadable).length;
      const unknown = report.store.brokenTips.length - broken - unreadable;
      const drifted = report.store.driftedPairs.length;
      console.log(
        `本地库: 可用，本目录 ${report.store.chains} 条链（${report.store.activeChains} 条活跃${broken ? `，${broken} 条链尾缺失` : ''}${unreadable ? `，${unreadable} 条链尾读不出来` : ''}${unknown ? `，${unknown} 条链尾状态无法确认` : ''}${drifted ? `，${drifted} 条链尾内容落后于来源` : ''}）`,
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
          `  链「${escapeControlChars(d.chainName)}」: ${d.from.provider}:${d.from.sessionId} → ${d.to.provider}:${d.to.sessionId}，缺 ${d.missingTurns}/${d.sourceTurns} 条`,
        );
      }
      // 摘要行只报个数；缺的是哪条链尾必须直接给 provider:sessionId，否则照「可先 watch switch」也无法定位。
      // 读不出来 ≠ 已删除：EACCES 等状态下让人 adopt 等于白换一次绑定
      for (const b of report.store.brokenTips) {
        console.log(
          b.missing
            ? `  链「${escapeControlChars(b.chainName)}」: ${b.provider}:${b.sessionId} 链尾文件已不存在（${escapeControlChars(b.filePath)}），${rebindHint(b.provider)}`
            : b.unreadable
              ? `  链「${escapeControlChars(b.chainName)}」: ${b.provider}:${b.sessionId} 链尾文件读不出来（${escapeControlChars(b.filePath)}，${b.error}）；resume 与下次切换都会失败——先修好这个文件（权限或内容），或 watch switch ${b.provider} 重新绑定`
              : `  链「${escapeControlChars(b.chainName)}」: ${b.provider}:${b.sessionId} 链尾文件状态无法确认（${escapeControlChars(b.filePath)}，${b.error}）；先确认文件是否还在，再决定是否需要 adopt`,
        );
      }
    } else {
      console.log(`本地库: 不可用（${report.store.error}）`);
    }
    if (report.imports.available) {
      const i = report.imports;
      console.log(`导入日志: ${i.total} 条（imported ${i.imported} / associated ${i.associated} / uncertain ${i.uncertain} / prepared ${i.prepared}）`);
      // 「不要重试」只有配上 planId 才能执行；否则用户只知道有 N 个未知结果，找不到是哪一个
      for (const id of i.uncertainIds) {
        console.log(`  结果未知: ${id}（用 watch import-codex status ${id} 查看；勿重试、勿删日志）`);
      }
      // 读不出来的日志没进 total，不逐条说就只是「总数比实际少」，看不出是哪几份
      for (const j of i.skippedJournals) {
        console.log(`  读取失败（未计入上面的统计）: ${j.id}（${j.reason}）`);
      }
    } else {
      console.log(`导入日志: 不可用（${report.imports.error}）`);
    }
    if (report.warnings.length) {
      console.error('警告:');
      for (const w of report.warnings) console.error(`  - ${w}`);
    }
    // 结论行必须在 stdout 最后：`watch doctor | tail -1` 与只看退出码的脚本要拿到同一句话
    const s = report.summary;
    if (failed) {
      console.log(`结论: ${s.failures.length} 项失败（退出码 1）：${s.failures.join('、')}；先按上面的失败项修复再重试`);
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
      let ref: import('./core/types.js').SessionRef;
      let turnCount = 0;
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
      } else if (adapter.start) {
        const started = await create(adapter.start(cwd, '我们开始吧。'));
        ref = started.ref;
        turnCount = 1;
      } else {
        fail(json, `${providerId} 不支持从零开聊`);
      }
      if (store) {
        try {
          const id = store.getOrCreateChainSession(cwd, chain);
          // 把首开聊记录为链的起点，后续 handoff 才能正确判断链尾
          store.recordSwitch(id, null, null, providerId, ref);
        } catch (error) {
          // 会话已经建出来了，不能因为写链失败整条命令报错（用户拿到的 ref 仍可 resume），
          // 但后续 switch 不会认这条绑定，必须说明——否则 status 里看不到它却毫无提示
          console.error('[watch] 记录 switch_events 失败，新会话仍已创建:', error);
          warnings.push(`链记录失败，后续切换不会认这条绑定：${describeStoreErrorReason(error)}`);
        }
      }
      // 会话已经建出来、链绑定也写好了，但目录进不去：与查询类命令不同，这里必须说清
      // 「已经写进去的是什么」以及「resume 会失败」，否则 ok:true + resume 会被读成马上能用
      if (cwdWriteIssue) warnings.push(newSessionCwdWarning(cwdWriteIssue, ref.filePath));
      // 这次在 `--cwd` 下写出了链记录：同一个目录的另一种写法下若已有链，说明会有两组（见 helper）
      await aliasWarnings();
      const resumeCommand = adapter.resumeCommand(ref);
      // 空链分支同样会 touchChain（getOrCreateChainSession 在建会话之后就跑过）
      const currentChain = safeActiveChain(store, cwd, warnings);
      const shiftNote = currentChainShiftNote(previousChain, currentChain);
      for (const warning of warnings) console.error(`警告: ${warning}`);
      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            newRef: ref,
            resumeCommand,
            turnCount,
            fromProvider: providerId,
            ...(shiftNote ? { previousChain, currentChain } : {}),
            ...(warnings.length || shiftNote ? { warnings: shiftNote ? [...warnings, shiftNote] : warnings } : {}),
          }),
        );
        return;
      }
      console.log(`新会话: ${ref.sessionId}`);
      console.log(`resume: ${resumeCommand}`);
      // 结果说明走 stdout（同 switch / adopt / chain new 的位置），不是降级警告
      if (shiftNote) console.log(`\n${shiftNote}`);
      return;
    }

    const result = await createChainSession(providerId, cwd, listAdapters(), getAdapter, store, chain);
    // 链已存在时的表单同样要带出 cwd / 读库 / 交接降级说明，不能只在空链分支打印
    // 先把「另一种写法下已有链」并进 warnings，再由这里统一带出（两条通道共用同一份）
    await aliasWarnings();
    const allWarnings = [...warnings, ...result.warnings];
    // 已有链分支可能复用配对会话，也可能新建；无论哪种，只要目录进不去，resume 都会在这一步失败
    if (cwdWriteIssue) allWarnings.push(newSessionCwdWarning(cwdWriteIssue, result.newRef.filePath));
    // createChainSession() 内部同样经 getOrCreateChainSession() 写 last_used_at
    const currentChain = safeActiveChain(store, cwd, allWarnings);
    const shiftNote = currentChainShiftNote(previousChain, currentChain);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          ...result,
          ...(shiftNote ? { previousChain, currentChain } : {}),
          ...(allWarnings.length || shiftNote ? { warnings: shiftNote ? [...allWarnings, shiftNote] : allWarnings } : {}),
        }),
      );
      return;
    }
    for (const warning of allWarnings) console.error(`警告: ${warning}`);
    console.log(`新会话: ${result.newRef.sessionId}（${result.turnCount} 轮）`);
    console.log(`resume: ${result.resumeCommand}`);
    if (shiftNote) console.log(`\n${shiftNote}`);
  } catch (error) {
    // 结构化阻断（新建会话需要的原生 CLI 没装等）与 switch 走同一份输出：这两条都是写路径，
    // 脚本 / 桌面端只看 blocked / code，退回一句 error 文本就成了「内部错误」
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    // 同 switch / adopt：「当前链没读成」只在失败原因本身不是库故障时才补
    const probe = !isStoreError(error) && chainProbe.length ? chainProbe.join('；') : '';
    const msg = [probe, describeCommandError(error)].filter(Boolean).join('；');
    // 与 switch / adopt 一致：目录本身有问题时先说路径，否则「还没有切换链」会被当成「目录里没东西」
    const message = cwdIssue ? `${cwdIssue}；${msg}` : msg;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exit(1);
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
          /** 文件在、但读不出来（`chmod 000` 之类）：`missing` 为假也不代表可用 */
          unreadable?: boolean;
        }
      >();
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
        const missing = presence.state === 'missing';
        // 同理，`stat` 成功也不代表读得出来：`chmod 000` 的链尾在 chain list 里看着一切正常，
        // 而 resume 与下一次 switch 一读内容就失败（status 走同一个探测，口径一致）
        const readProblem =
          presence.state === 'present' && presence.isFile ? await probeSessionReadable(last.toRef.filePath) : null;
        const tipError = readProblem
          ? readProblem
          : presence.state === 'unknown'
            ? presence.reason
            : presence.state === 'present' && !presence.isFile
              ? '该路径现在不是普通文件'
              : null;
        tips.set(c.id, {
          provider: last.toRef.provider,
          sessionId: last.toRef.sessionId,
          filePath: last.toRef.filePath,
          missing,
          ...(tipError ? { error: tipError } : {}),
          ...(readProblem ? { unreadable: true } : {}),
        });
        if (missing && c.status === 'active') {
          warnings.push(
            `链「${escapeControlChars(c.name)}」的链尾会话文件已不存在（${last.toRef.provider}:${last.toRef.sessionId}）：下次切换会失败，${rebindHint(last.toRef.provider)}`,
          );
        } else if (readProblem && c.status === 'active') {
          // 读不出来 ≠ 文件没了：不标 missing，也不能当成「一切正常」而不出声
          warnings.push(
            `链「${escapeControlChars(c.name)}」的链尾会话文件读不出来（${last.toRef.provider}:${last.toRef.sessionId}）：${readProblem}；` +
              `resume 与下次切换会失败——先修好这个文件（权限或内容），或 watch adopt ${last.toRef.provider} --session <另一个会话 id> 换绑`,
          );
        } else if (tipError && c.status === 'active') {
          // 读不出来 ≠ 文件没了：不标 missing，也不能当成「一切正常」而不出声
          warnings.push(
            `链「${escapeControlChars(c.name)}」的链尾会话文件无法确认是否还在（${last.toRef.provider}:${last.toRef.sessionId}）：${tipError}`,
          );
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
          ...(elsewhere.length ? { chainsElsewhere: elsewhere } : {}),
          ...(warnings.length ? { warnings } : {}),
        }));
        return;
      }
      for (const warning of warnings) console.error(`警告: ${warning}`);
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
          ? `  → ${tip.provider}:${tip.sessionId}${
              tip.missing
                ? '（链尾文件已不存在）'
                : tip.unreadable
                  ? '（链尾文件读不出来）'
                  : tip.error
                    ? '（链尾文件状态无法确认）'
                    : ''
            }`
          : '';
        console.log(`  ${escapeControlChars(c.name)}${mark}${here}  ${c.id}  lastUsed=${fmtTime(c.lastUsedAt)}${tipText}`);
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
            ...(warnings.length ? { warnings } : {}),
          }),
        );
      } else {
        if (chainCwdIssue) console.error(`警告: ${chainCwdIssue}`);
        if (aliasIssue) console.error(`警告: ${aliasIssue}`);
        if (ephemeralNote) console.error(`警告: ${ephemeralNote}`);
        console.log(`已创建链: ${escapeControlChars(chain.name)}  (${chain.id})`);
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
        if (json) console.log(JSON.stringify({ ok: true, unchanged: true, chain: found, warnings: [note] }));
        else console.log(`未改动: ${shown}  (${found.id})——${note}`);
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
          JSON.stringify({ ok: true, chain, ...(renameWarnings.length ? { warnings: renameWarnings } : {}) }),
        );
      } else {
        if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
        console.log(`已重命名: ${escapeControlChars(chain.name)}  (${chain.id})`);
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
      if (found.status === 'archived') {
        const shown = escapeControlChars(found.name);
        const note = `链「${shown}」本来就是归档状态，本次没有做任何改动；可用 watch chain use ${shown} 把它恢复成当前链`;
        if (json) console.log(JSON.stringify({ ok: true, unchanged: true, id: found.id, warnings: [note] }));
        else console.log(`已归档: ${shown}（${note}）`);
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
              ...(ephemeralWrite ? { warnings: [ephemeralWrite] } : {}),
            }),
          );
        } else {
          if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
          console.log(`已恢复并设为当前链: ${escapeControlChars(restored.name)}  (${restored.id})`);
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
            ...(useWarnings.length ? { warnings: useWarnings } : {}),
          }),
        );
      } else {
        if (ephemeralWrite) console.error(`警告: ${ephemeralWrite}`);
        console.log(`当前链: ${escapeControlChars(touched.name)}  (${touched.id})`);
        if (note) console.log(`  ${note}`);
      }
      return;
    }
    // 拼错的子命令（`chain lsit`）以前一律落到通用用法错误「参数不完整或不合法」，
    // 用户看不出是子命令写错、也不知道有哪几个，得自己翻整页用法
    throw new Error(`未知的 chain 子命令: ${action}；可用: ${CHAIN_SUBCOMMANDS}`);
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

/**
 * 每个命令真正消费的参数。`parseArgs` 只挡未知 flag（白名单是全局的），
 * `--chain` 给 `recent`、`--session` 给 `status` 这类「认识但不吃」的组合以前被静默忽略，
 * 用户会以为已经按链过滤 / 指定了会话。`--cwd` / `--json` 全局有效，不参与校验。
 */
/** 顶层命令清单：命令名拼错时要能列出可用的那几个（`import-codex` 在 parseArgs 之前就分派了，单独标注） */
const COMMANDS = 'status / switch / adopt / sessions / recent / providers / doctor / new / chain / search / usage / open';

const FLAGS_BY_COMMAND: Record<string, string[]> = {
  status: ['chain'],
  switch: ['chain'],
  adopt: ['chain', 'session'],
  sessions: ['chain'],
  recent: ['limit'],
  providers: [],
  capabilities: [],
  prompt: ['provider', 'profile', 'last'],
  doctor: ['strict'],
  new: ['chain'],
  chain: [],
  search: [],
  usage: ['chain'],
  open: ['from', 'provider', 'to', 'check'],
};

function rejectUnusedFlags(cmd: string, usedFlags: string[], json: boolean): void {
  const allowed = FLAGS_BY_COMMAND[cmd];
  if (!allowed) return;
  const bad = usedFlags.find((flag) => !allowed.includes(flag));
  if (!bad) return;
  const supports = allowed.length ? allowed.map((flag) => `--${flag}`).join(' / ') : '（无，仅 --cwd / --json）';
  const message = `--${bad} 不能与 ${cmd} 同用；${cmd} 支持的参数: ${supports}`;
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
  console.error(`[watch] ${message}`);
  usage();
}

/**
 * 每个命令接受的位置参数（命令名之后）。`rejectUnusedFlags` 只管 `--flag`；
 * `watch recent 3`（本意是 `--limit 3`）、`watch status foo` 这类多给的位置参数
 * 以前被静默吞掉、照样 exit 0，用户会以为参数生效了。`search` 不限：查询词本身就是位置参数。
 */
const POSITIONAL_BY_COMMAND: Record<string, { max: number; hint: string }> = {
  status: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  switch: { max: 1, hint: '<provider>' },
  adopt: { max: 1, hint: '<provider>（会话用 --session 传）' },
  sessions: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  recent: { max: 0, hint: '无位置参数（条数用 --limit 传）' },
  providers: { max: 0, hint: '无位置参数' },
  doctor: { max: 0, hint: '无位置参数（目录用 --cwd 传）' },
  new: { max: 1, hint: '<provider>' },
  chain: { max: Infinity, hint: '<list|new|rename|archive|use> [名字或 id] [新名字]' },
  usage: { max: 0, hint: '无位置参数' },
  open: { max: 1, hint: '<session-id>' },
};

/** `chain` 各子命令吃的位置参数个数；未知子命令交给 cmdChain 自己报错，这里不拦 */
const CHAIN_POSITIONAL: Record<string, number> = { list: 1, new: 2, rename: 3, archive: 2, use: 2 };

function rejectExtraPositionals(cmd: string, positional: string[], json: boolean): void {
  const spec = POSITIONAL_BY_COMMAND[cmd];
  if (!spec) return;
  const max = cmd === 'chain' ? (CHAIN_POSITIONAL[positional[0] ?? ''] ?? Infinity) : spec.max;
  if (positional.length <= max) return;
  const overflow = positional.slice(max);
  const message = `多余的参数: ${overflow.join(' ')}；${cmd} 接受的位置参数: ${spec.hint}`;
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
  console.error(`[watch] ${message}`);
  usage();
}

async function main(): Promise<void> {
  // `--version` 与 `--help` 同属全局开关：放在 parseArgs 与 import-codex 分派之前，
  // 才能让 `watch --version` / `watch status --version` / `watch import-codex --version`
  // 三条位置给出同一个结论。以前它只会落进「未知参数: --version」——用户想确认装的是哪一版，
  // 而唯一带版本号的地方是 `watch doctor` 的「环境: watch x.y.z · node …」（还要能跑通诊断）。
  // 读不出版本时不编一个数：文本说「未知版本」，`--json` 给 `version: null`。
  if (process.argv.slice(2).includes('--version')) {
    const version = readWatchVersion();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: true, version }));
    } else {
      console.log(`watch ${version ?? '未知版本'}`);
    }
    return;
  }
  if (process.argv[2] === 'import-codex') {
    await runImportCodex(process.argv.slice(3));
    return;
  }
  const { cmd, target, extra, rest, json, cwd, session, chain, from, provider, to, profile, last, check, strict, limit, usedFlags, cwdGiven, positional } = parseArgs(process.argv);
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
    await cmdProviders(json);
    return;
  }
  if (cmd === 'capabilities') {
    cmdCapabilities(json);
    return;
  }
  if (cmd === 'prompt') {
    if (!target) usage('prompt 需要指定会话 id；例：watch prompt <session-id> --profile standard');
    await cmdPrompt(json, target, provider, profile, last);
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
    await cmdSearch(cwd, json, q);
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
  if (cmd) usage(`未知命令: ${cmd}；可用: ${COMMANDS} / import-codex`);
  usage(`缺少子命令；可用: ${COMMANDS} / import-codex`);
}

async function cmdUsage(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  // 链名与目录都是精确匹配：目录写错时 `--chain` 同样查不到，失败时也要带出路径原因
  const cwdIssue = await cwdProblem(cwd);
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
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (result.chain) {
      console.log(`链: ${escapeControlChars(result.chain.name)}  (${result.chain.id})`);
    } else if (chain) {
      // 本地库不可用时 chainUsage 返回 chain:null——这时连「这条链是否存在」都没查成。
      // 单独印一行「链: keep」与 --json 的 chain:null 矛盾，用户会当成「链在、只是没有用量」
      console.log(`链: ${chain}（未能确认这条链是否存在；原因见警告）`);
    }
    // 警告必须先打：本地库不可用时 byProvider 也是空的，先 return 会把「读不出来」说成「没有绑定会话」
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
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
    if (result.totalMissingUsage) missing.push(`${result.totalMissingUsage} 个无 usage 数据的会话`);
    if (result.unsupported?.length) missing.push(`${result.unsupported.join('、')}（适配器不提供用量）`);
    console.log(
      `合计${missing.length ? `（未含 ${missing.join('、')}）` : ''}: in=${result.total.inputTokens}  out=${result.total.outputTokens}`,
    );
    console.log('');
    console.log('按会话:');
    for (const item of result.byProvider) {
      const u = item.usage ?? { inputTokens: 0, outputTokens: 0 };
      const note = item.error
        ? `（读取失败: ${item.error}）`
        : item.usage === null
          ? '（无 usage 字段）'
          : '';
      console.log(
        // 打全 id：截成 8 位再省略号就复制不了，接不上 watch adopt --session / 原生 resume
        `  ${item.provider.padEnd(8)} ${item.sessionId}  in=${u.inputTokens}  out=${u.outputTokens}${note}`,
      );
    }
  } catch (error) {
    // 链库读写失败时把原因翻成中文（半坏 schema 下这里是第二条出口），业务结论原样带出
    failWithCwd(json, cwdIssue, describeCommandError(error));
  }
}

async function cmdSearch(cwd: string, json: boolean, query: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, storeUnavailableError());
  try {
    const warnings: string[] = [];
    const unavailable: string[] = [];
    const emptied: EmptiedSession[] = [];
    const cwdIssue = await cwdProblem(cwd);
    if (cwdIssue) warnings.push(cwdIssue);
    // `:memory:` 时索引只活在本次进程内：每次 search 都得从头全量建一遍，
    // 命令结束后也没有任何东西留下来。不说的话只会表现为「搜什么都慢、而且只有本次能搜到」
    if (ephemeralDb) {
      warnings.push(ephemeralStoreWarning('搜索索引建在这份临时库里，命令结束就没了（每次 search 都要重新全量索引）'));
    }
    await reindexCwd(cwd, listAdapters(), store, warnings, unavailable, emptied);
    // 0 字节会话（进程被杀 / 只写了一半 / 磁盘满）索引里一行内容都没有，命中永远为零。
    // 只回「没有匹配」会被读成「那句话没聊过」，而它可能正躺在一条内容已丢失的会话里。
    // `sessions` / `recent` / `doctor` 早已披露这一档，搜索是最后一个沉默的入口。
    if (emptied.length) warnings.push(emptiedSessionsWarning(emptied));
    // 归属读不出来的会话（Codex 是 `session_meta` 首行坏了）不属于任何 cwd，因此永远进不了索引。
    // 搜索恰恰是「我还记得那句话」的入口：只报「无结果」会把「这几条根本没被搜到」讲成「没聊过」
    const unattributableStats = await collectUnattributable(listAdapters());
    for (const stat of unattributableStats) warnings.push(unattributableWarning(stat, cwd));
    // 三种上限各自独立：全局 40 条、单会话 3 条、session id 前缀 10 条；只说「truncated」会混淆是哪一种
    const { hits, truncated, perSessionCapped, idPrefixCapped } = store.searchMessagesWithMeta(query, cwd);
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
    if (!hits.length && !cwdIssue) {
      // 有一家没读成、或有一批文件压根没进索引时，零命中只说明「没搜到」，不是「写法不对」
      const alias = await cwdAliasHint(cwd, sameDirectoryElsewhere[0]?.cwd, [
        ...unavailable,
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
      const unattrNote = unattributableSearchNote(unattributableStats);
      if (unattrNote) notes.push(unattrNote);
      const emptiedNote = emptiedSearchNote(emptied);
      if (emptiedNote) notes.push(emptiedNote);
    }
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        query,
        cwd,
        hits,
        ...(truncated ? { truncated: true } : {}),
        ...(perSessionCapped ? { perSessionCapped: true } : {}),
        ...(idPrefixCapped ? { idPrefixCapped: true } : {}),
        ...(unavailable.length ? { unavailable } : {}),
        ...(unattributableStats.length ? { unattributable: unattributableJson(unattributableStats) } : {}),
        ...(emptied.length ? { emptied: emptiedJson(emptied) } : {}),
        ...(notes.length ? { notes } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    for (const warning of warnings) console.error(`警告: ${warning}`);
    if (!hits.length) {
      // 正文先说清范围（搜索只覆盖这一个目录），再说有没有别处线索——
      // 单打一句「无结果」会被当成「这台机器上没有」。
      // `--cwd` 本身不可用时连「这个目录」都不存在：改成说清这次搜索没覆盖到东西，
      // 否则「本目录没有匹配」会被当成「那句话没聊过」（原因已在 warnings 里）
      console.log(
        cwdIssue
          ? cwdUnusableConclusion('无结果', '本次搜索不能说明这个目录里有没有匹配')
          : `无结果：本目录没有匹配（搜索按目录限定，只查了 ${escapeControlChars(cwd)}）`,
      );
      for (const note of notes) console.log(note);
      return;
    }
    for (const h of hits) {
      console.log(`${h.provider}  ${h.sessionId}`);
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
  } catch (error) {
    // 查询类命令同样会撞上坏库（`search_index` 缺列、`messages_fts` 缺表…）：
    // 裸 SQLite 原文既不说这是库的问题，也给不出重建的下一步
    fail(json, describeCommandError(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
