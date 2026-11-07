#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SEARCH_MAX_HITS, Store, defaultDbPath } from './core/store.js';
import { describeFindings } from './core/findings.js';
import { adoptIntoChain, chainStatus, chainUsage, collectTips, createChainSession, handoff, HandoffBlockedError } from './core/handoff.js';
import { reindexCwd } from './core/search.js';
import type { SessionRef } from './core/types.js';
import { getAdapter, listAdapters, listProviders, unknownProviderMessage } from './providers/registry.js';
import { checkOpenInProvider, openInProvider, openSession } from './open.js';
import { PreflightBlockedError } from './providers/adapter.js';
import { runImportCodex } from './import-codex.js';
import { ImportJobs } from './core/import-jobs.js';
import { officialImportJournalRoot } from './providers/codex/official-import.js';
import { doctorReport } from './core/doctor.js';
import { cwdProblem } from './core/cwd.js';

/**
 * 参数还没解析完就要报用法错误（缺值 / 越界 / 未知 flag）：此时 `--json` 已经能从 argv 看出来。
 * 用法文本始终走 stderr；带 `--json` 时再补一行 JSON 错误，否则 stdout 为空，
 * Rust 桥只能把整段用法当错误文本显示给桌面端。
 */
const JSON_REQUESTED = process.argv.includes('--json');

/**
 * `reason` 用来把「哪里不对」讲清楚：只打一整段用法时，
 * `--limit 51` 与「少给了子命令」在 `--json` 下是同一句「参数不完整或不合法」。
 */
function usage(reason?: string): never {
  if (reason) console.error(`[watch] ${reason}`);
  console.error(`用法:
  watch status [--json] [--cwd <path>] [--chain <id|name>]
  watch switch <provider> [--json] [--cwd <path>] [--chain <id|name>]
  watch adopt <provider> [--json] [--cwd <path>] [--chain <id|name>] [--session <id>]
  watch sessions [--json] [--cwd <path>] [--chain <id|name>]
  watch recent [--json] [--cwd <path>] [--limit <n>]
  watch providers [--json]
  watch doctor [--json] [--cwd <path>]   只读环境诊断：Agent 检测、本地库、导入日志（不写盘）
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
    hint: block?.hint ?? '未写入任何内容；请确认目标会话停止写入后重试。',
  };
  if (json) console.log(JSON.stringify(payload));
  else console.error(`[blocked:${code}] ${error.message}\n${payload.hint}`);
  process.exit(1);
}

/** 最近一次 openStore 失败的原因；供「需要库」的子命令拼进错误文案 */
let lastStoreError: string | null = null;

function openStore(): Store | null {
  try {
    lastStoreError = null;
    return new Store(process.env.WATCH_DB ?? defaultDbPath());
  } catch (error) {
    lastStoreError = error instanceof Error ? error.message : String(error);
    console.error('[watch] 打开数据库失败，以降级无库模式继续:', lastStoreError);
    return null;
  }
}

/** 裸「无法打开数据库」不指向任何东西：带上实际路径、失败原因与版本门槛 */
function storeUnavailableError(): string {
  const db = process.env.WATCH_DB ?? defaultDbPath();
  return `无法打开本地库 ${db}${lastStoreError ? `（${lastStoreError}）` : ''}；可检查路径与权限，Node ≥ 22.13 才提供 node:sqlite`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
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
  check: boolean;
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
  let check = false;
  let limit: number | undefined;
  const positional: string[] = [];
  let i = 0;
  /** 取下一个 token 作为参数值；缺值或误吞了下一个 flag 都按用法错误处理 */
  const takeValue = (flag: string): string => {
    const next = args[++i];
    if (!next) usage(`${flag} 缺少取值`);
    // 下一个 token 仍是 flag：说明取值漏了，别把它吞成值
    if (next.startsWith('--')) usage(`${flag} 缺少取值（后面跟着 ${next}）`);
    return next;
  };
  for (i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') continue;
    if (a === '--check') {
      check = true;
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
    if (a === '--limit') {
      const raw = takeValue('--limit');
      // Number() 会接受 '0x10'（16）与 ' 3'（3）：用户只想给十进制条数，别猜他的意思
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        usage(`--limit 需要 1–50 之间的整数，收到: ${raw}`);
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
    ...(session ? ['session'] : []),
    ...(chain ? ['chain'] : []),
    ...(from ? ['from'] : []),
    ...(provider ? ['provider'] : []),
    ...(to ? ['to'] : []),
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
    check,
    limit,
    usedFlags,
    cwdGiven,
    positional: positional.slice(1),
  };
}

async function cmdStatus(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  let result;
  try {
    result = await chainStatus(cwd, listAdapters(), store, chain);
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
  }
  // 路径写错时各 provider 会安静返回空列表，先把原因放进同一条 warnings 通道
  const cwdIssue = await cwdProblem(cwd);
  if (cwdIssue) result.warnings.push(cwdIssue);
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  const { tips, chainTip, history, chain: current, warnings } = result;
  for (const warning of warnings) console.error(`警告: ${warning}`);
  if (current) console.log(`链: ${current.name}  (${current.id})`);
  // 同一目录可能有多条链：只显示当前这条会让文本用户以为没有别的（--json 的 chains 一直是全量）
  const otherChains = result.chains.filter((c) => c.id !== current?.id);
  if (otherChains.length) {
    const active = otherChains.filter((c) => c.status === 'active').length;
    const archived = otherChains.length - active;
    const parts = [active ? `${active} 条活跃` : '', archived ? `${archived} 条归档` : ''].filter(Boolean);
    console.log(`另有 ${otherChains.length} 条链（${parts.join('、')}）；用 --chain <名或 id> 查看`);
  }
  if (!tips.length) {
    console.log('未发现会话（请先在 Claude Code 或 Codex TUI 开聊）');
  } else {
    console.log(`cwd: ${cwd}`);
    console.log('');
    console.log('最新原生会话:');
    for (const tip of tips.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const mark =
        chainTip && tip.provider === chainTip.provider && tip.ref.sessionId === chainTip.ref.sessionId
          ? ' ← 链尾'
          : '';
      const chainMark = tip.onChain ? ' 🔗' : '';
      console.log(`  ${tip.provider.padEnd(8)} ${tip.ref.sessionId}  mtime=${fmtTime(tip.updatedAt)}${chainMark}${mark}`);
      console.log(`           ${tip.ref.filePath}`);
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
  }
}

async function cmdSwitch(cwd: string, targetId: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  const cwdIssue = await cwdProblem(cwd);
  try {
    const result = await handoff(targetId, cwd, listAdapters(), getAdapter, store, { chainId: chain });
    // 路径不对时 handoff 只会说「没有可接力的会话」，补上真正的原因
    if (cwdIssue) result.warnings.push(cwdIssue);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    // 警告先打：alreadyAtTarget 分支同样可能带「读库/写链失败」，提前 return 会把它吞掉
    // 走 stderr：stdout 留给结果，重定向 / 管道时警告不该混进正文（与 status / new / usage 一致）
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    if (result.alreadyAtTarget) {
      console.log(`链尾已在 ${targetId}，直接打开即可。`);
      console.log(`resume: ${result.resumeCommand}`);
      return;
    }
    console.log(`已从 ${result.fromProvider} 交接 → ${targetId}（${result.turnCount} 轮）`);
    console.log(`新会话: ${result.newRef.sessionId}`);
    console.log(`文件:   ${result.newRef.filePath}`);
    console.log('');
    console.log(`resume: ${result.resumeCommand}`);
    // exact 之外的处置（整文件重写、去重跳过等）--json 里一直有，文本模式也要说，否则看不出内容被改写过
    for (const line of describeFindings(result.findings ?? [])) console.error(`说明: ${line}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    const message = error instanceof Error ? error.message : String(error);
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
  const store = openStore();
  const cwdIssue = await cwdProblem(cwd);
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
        if (adapter.findById) {
          try {
            const found = await adapter.findById(sessionId);
            if (found && found.ref.cwd !== cwd) elsewhere = found.ref.cwd;
          } catch {
            /* 反查失败退回原文案：不能因为补充说明把主错误也丢了 */
          }
        }
        if (elsewhere) {
          throw new Error(
            `会话 ${sessionId} 属于另一个目录: ${elsewhere}；adopt 按 cwd 绑定，请用 --cwd ${elsewhere}`,
          );
        }
        // 列表有上限时，更早的会话根本没被枚举到：直接说「找不到」会让用户以为 id 写错了
        const cap = adapter.listSessionsCap;
        const capped = cap !== undefined && all.length >= cap;
        throw new Error(
          capped
            ? `在当前目录最近 ${all.length} 个会话里找不到: ${sessionId}（${adapter.id} 列表上限 ${cap}，更早的会话不在其中，可用 watch sessions 或原生 CLI 确认真实 id）`
            : `在当前目录找不到会话: ${sessionId}`,
        );
      }
      targetRef = hit.ref;
    }
    const result = await adoptIntoChain(providerId, cwd, listAdapters(), store, targetRef, chain);
    if (cwdIssue) result.warnings.push(cwdIssue);
    // 与 switch 对齐：接入之后用户下一步就是打开这个会话，resume 命令不能只给 --json
    const adoptedAdapter = listAdapters().find((a) => a.id === result.adoptedRef.provider);
    const resumeCommand = adoptedAdapter ? adoptedAdapter.resumeCommand(result.adoptedRef) : undefined;
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result, ...(resumeCommand ? { resumeCommand } : {}) }));
      return;
    }
    // 与 switch 一致：警告先打（未写入链记录这类说明不能排在成功之后被漏看），且走 stderr
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    console.log(`已接入链: ${result.adoptedRef.sessionId}`);
    if (result.replacedRef) console.log(`替换了:  ${result.replacedRef.sessionId}`);
    if (resumeCommand) {
      console.log('');
      console.log(`resume: ${resumeCommand}`);
    }
  } catch (error) {
    if (error instanceof HandoffBlockedError || error instanceof PreflightBlockedError) failBlocked(error, json);
    const message = error instanceof Error ? error.message : String(error);
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
    if (check) {
      if (!toId) fail(json, '--check 需要同时指定 --to <provider>');
      if (fromId) fail(json, '--from 不能与 --check 同用：预检只针对 --to <provider>');
      const checked = await checkOpenInProvider(targetId, toId);
      if (cwdIgnored) checked.warnings = [...(checked.warnings ?? []), cwdIgnored];
      if (json) {
        console.log(JSON.stringify(checked));
        process.exit(checked.ok ? 0 : 1);
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
    fail(json, error instanceof Error ? error.message : String(error));
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
  if (!store && chain) {
    // 用户明确要按链过滤却打不开库：不说是「已忽略」，列表看起来就像链上会话
    warnings.push(`本地库不可用，--chain ${chain} 过滤已忽略，下面是该目录的全部会话`);
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
        // 链存在但一条绑定都没有：过滤后必然是空列表，不说原因会被当成「目录里没有会话」
        if (bound.size === 0) {
          warnings.push(`链 ${chainRow.name} 还没有绑定会话（可用 watch switch / adopt 先绑定）`);
        }
      } else if (chain) {
        // 跨目录的链在这里同样是「找不到」，但指名它在哪个目录，用户才知道该改 --cwd
        warnings.push(`${store.missingChainMessage(cwd, chain)}；已列出该目录全部会话`);
      }
    } catch (error) {
      // 链查询失败时退化为全量列表，但要说清楚，否则 --chain 的输出会被误读
      warnings.push(`链查询失败，已列出该目录全部会话：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const unavailable: string[] = [];
    const groups = await Promise.all(
      adapters
        .filter((a) => a.listSessions)
        .map(async (a) => {
          // 单个 provider 读失败（opencode 库损坏/被占用等）不拖垮整张列表
          let sessions: Awaited<ReturnType<NonNullable<typeof a.listSessions>>> = [];
          try {
            sessions = await a.listSessions!(cwd);
          } catch {
            unavailable.push(a.id);
            return { provider: a.id, sessions: [] };
          }
          const ids = bound.get(a.id);
          // --chain 时只保留链上绑定过的会话：没绑定的 provider 不能把自家全部会话混进「这条链」
          const linked = chainRow ? (ids ? sessions.filter((s) => ids.has(s.ref.sessionId)) : []) : sessions;
          // 撞到适配器上限时列表只是「最近 N 个」：不标出来会被当成全集
          const capped = a.listSessionsCap !== undefined && sessions.length >= a.listSessionsCap;
          // 链上绑定了、但这次没被列出来：整组被 filter 掉后看起来就像「这条链没绑定它」。
          // 两种原因必须分开说——文件已经没了（下次切换必然失败，可先 adopt），还是只是排在上限之外。
          if (chainRow && ids) {
            const listed = new Set(sessions.map((s) => s.ref.sessionId));
            const missingFiles: string[] = [];
            const tooOld: string[] = [];
            for (const [id, ref] of ids) {
              if (listed.has(id)) continue;
              const alive = await stat(ref.filePath).then(() => true, () => false);
              (alive ? tooOld : missingFiles).push(id);
            }
            if (missingFiles.length) {
              warnings.push(
                `链 ${chainRow.name} 绑定的 ${a.id} 会话 ${missingFiles.join('、')} 文件已不存在，本次未列出；下次切换会失败，可先 watch adopt ${a.id} --session <id> 重新绑定`,
              );
            }
            if (tooOld.length) {
              warnings.push(
                `链 ${chainRow.name} 绑定的 ${a.id} 会话 ${tooOld.join('、')} 不在最近 ${sessions.length} 个里${capped ? '（已达列表上限）' : '（可能属于另一个目录）'}，本次未列出；可用 watch doctor 或原生 CLI 确认该会话`,
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
    const result = groups.filter((g) => g.sessions.length > 0);
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        cwd,
        providers: result,
        ...(unavailable.length ? { unavailable } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    for (const warning of warnings) console.error(`警告: ${warning}`);
    if (!result.length) {
      console.log('未发现会话');
      if (unavailable.length) console.error(`未读取: ${unavailable.join('、')}（原生存储读取失败）`);
      return;
    }
    for (const g of result) {
      console.log(`${g.provider}${g.capped ? '（已达列表上限，更早的会话未列出）' : ''}:`);
      for (const s of g.sessions) {
        console.log(`  ${s.ref.sessionId}  mtime=${fmtTime(s.updatedAt)}`);
        if (s.preview) console.log(`    ${s.preview}`);
      }
    }
    if (unavailable.length) console.error(`未读取: ${unavailable.join('、')}（原生存储读取失败）`);
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
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
  };
  // 用 Map 而不是数组 + Set：同一会话可能先由映射表命中、再被原生扫描命中，
  // 原生那边的 mtime 与 preview 更准，合并时不能被「先到先得」丢掉（以前映射先入就丢 preview）。
  const merged = new Map<string, RecentItem>();
  const unavailable: string[] = [];
  const warnings: string[] = [];
  const cwdIssue = await cwdProblem(cwd);
  if (cwdIssue) warnings.push(cwdIssue);

  if (!store) unavailable.push('本地库');
  if (store) {
    try {
      // 显式 --cwd 时映射表也要按目录过滤：原生扫描一直按 cwd 精确匹配，
      // 映射表不过滤会把别的项目的会话混进「这个目录的近期会话」
      const locations = store.listSessionLocations({ limit: limit * 2, ...(cwdGiven ? { cwd } : {}) });
      for (const loc of locations) {
        const key = `${loc.provider}:${loc.sessionId}`;
        try {
          const st = await stat(loc.filePath);
          if (!st.isFile()) continue;
          merged.set(key, {
            provider: loc.provider,
            sessionId: loc.sessionId,
            cwd: loc.cwd,
            // 用文件 mtime 而不是 last_seen_at：后者是「Watch 上次反查它的时间」，
            // 反复 open 一个老会话会让它排到最前面，和原生扫描的 updatedAt 也不是一回事
            updatedAt: st.mtimeMs,
          });
        } catch {
          // 文件没了或读不到：交给原生扫描，它还能按目录重新列出来
        }
      }
    } catch {
      // 本地映射读取失败不影响原生扫描
      unavailable.push('本地库');
    }
  }

  // 原生存储里可能有映射表还没见过的更新会话，所以始终扫一遍；
  // 不能凑够 limit 条就提前收手——那会按 registry 顺序先到先得，把别家更新的会话挤掉。
  for (const adapter of listAdapters()) {
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
        });
      }
    } catch {
      // 单家读失败不拖垮列表，但要披露
      unavailable.push(adapter.id);
    }
  }

  const results = [...merged.values()];
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  const final = results.slice(0, limit);
  // 列表被 --limit（默认 8）截断时要说出来，否则用户会把「最近 8 条」当成全部
  const truncated = results.length > final.length;

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      sessions: final,
      ...(truncated ? { truncated: true, total: results.length } : {}),
      ...(unavailable.length ? { unavailable } : {}),
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
    console.log('暂无最近会话记录');
    return;
  }
  for (const s of final) {
    // 「最近」的价值就在时间与摘要：JSON 一直带 updatedAt / preview，文本模式不能只留 id
    console.log(`  [${s.provider}] ${s.sessionId} (${s.cwd})  mtime=${fmtTime(s.updatedAt)}`);
    if (s.preview) console.log(`    ${s.preview}`);
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
    fail(json, error instanceof Error ? error.message : String(error));
  }
}

async function cmdDoctor(cwd: string, json: boolean): Promise<void> {
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
    const report = await doctorReport(cwd, { store, importJobs, importJobsError, importsRoot });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...report }));
      return;
    }
    const env = report.environment;
    console.log(`诊断 cwd: ${report.cwd}`);
    console.log(`环境: watch ${env.watchVersion ?? '未知版本'} · node ${env.node} · ${env.platform}`);
    console.log(`本地库文件: ${env.dbPath}`);
    console.log(`导入日志目录: ${env.importsRoot ?? '（不可用）'}`);
    console.log('Agent 检测:');
    for (const p of report.providers) {
      const state = p.available ? '✓ 已就绪' : p.error ? `✗ 检测失败: ${p.error}` : '✗ 未检测到';
      console.log(`  ${p.id.padEnd(10)} ${p.displayName.padEnd(12)} ${state}`);
    }
    if (report.storage.length) {
      console.log('会话存储:');
      for (const st of report.storage) {
        const countText =
          st.count === null
            ? `✗ 读取失败: ${st.error}`
            : st.capped
              ? `≥ ${st.count} 个会话（已达列表上限，实际可能更多）`
              : `${st.count} 个会话`;
        console.log(`  ${st.provider.padEnd(10)} ${countText}`);
      }
    }
    if (report.store.available) {
      const broken = report.store.brokenTips.length;
      const drifted = report.store.driftedPairs.length;
      console.log(
        `本地库: 可用，本目录 ${report.store.chains} 条链（${report.store.activeChains} 条活跃${broken ? `，${broken} 条链尾缺失` : ''}${drifted ? `，${drifted} 条链尾内容落后于来源` : ''}）`,
      );
      for (const d of report.store.driftedPairs) {
        console.log(
          `  链「${d.chainName}」: ${d.from.provider}:${d.from.sessionId} → ${d.to.provider}:${d.to.sessionId}，缺 ${d.missingTurns}/${d.sourceTurns} 条`,
        );
      }
      // 摘要行只报个数；缺的是哪条链尾必须直接给 provider:sessionId，否则照「可先 adopt」也无法定位
      for (const b of report.store.brokenTips) {
        console.log(
          `  链「${b.chainName}」: ${b.provider}:${b.sessionId} 链尾文件已不存在（${b.filePath}），可先 adopt 该 provider 的新会话`,
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
    } else {
      console.log(`导入日志: 不可用（${report.imports.error}）`);
    }
    if (report.warnings.length) {
      console.error('警告:');
      for (const w of report.warnings) console.error(`  - ${w}`);
    }
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
  }
}

async function cmdNew(cwd: string, providerId: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  const warnings: string[] = [];
  // 目录不存在也能把会话建出来，但绑定指向一个不存在的项目，resume 时必然进不去
  const cwdIssue = await cwdProblem(cwd);
  if (cwdIssue) warnings.push(cwdIssue);
  if (!store) {
    // 会话本身能建出来，但没有 switch_events：后续 switch 不认这条绑定，必须说明
    warnings.push('本地库不可用，本次新会话未写入链记录（后续切换不会认同这条绑定）');
  }
  try {
    let historyLen = 0;
    if (store) {
      const id = store.findActiveChain(cwd, chain)?.id ?? null;
      if (chain && !id) fail(json, store.missingChainMessage(cwd, chain));
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
      if (adapter.createEmptySession) {
        ref = await adapter.createEmptySession(cwd);
      } else if (adapter.start) {
        const started = await adapter.start(cwd, '我们开始吧。');
        ref = started.ref;
        turnCount = 1;
      } else {
        fail(json, `${providerId} 不支持从零开聊`);
      }
      if (store) {
        const id = store.getOrCreateChainSession(cwd, chain);
        // 把首开聊记录为链的起点，后续 handoff 才能正确判断链尾
        store.recordSwitch(id, null, null, providerId, ref);
      }
      const resumeCommand = adapter.resumeCommand(ref);
      for (const warning of warnings) console.error(`警告: ${warning}`);
      if (json) {
        console.log(JSON.stringify({ ok: true, newRef: ref, resumeCommand, turnCount, fromProvider: providerId, ...(warnings.length ? { warnings } : {}) }));
        return;
      }
      console.log(`新会话: ${ref.sessionId}`);
      console.log(`resume: ${resumeCommand}`);
      return;
    }

    const result = await createChainSession(providerId, cwd, listAdapters(), getAdapter, store, chain);
    // 链已存在时的表单同样要带出 cwd / 读库 / 交接降级说明，不能只在空链分支打印
    const allWarnings = [...warnings, ...result.warnings];
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result, ...(allWarnings.length ? { warnings: allWarnings } : {}) }));
      return;
    }
    for (const warning of allWarnings) console.error(`警告: ${warning}`);
    console.log(`新会话: ${result.newRef.sessionId}（${result.turnCount} 轮）`);
    console.log(`resume: ${result.resumeCommand}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // 与 switch / adopt 一致：目录本身有问题时先说路径，否则「还没有切换链」会被当成「目录里没东西」
    const message = cwdIssue ? `${cwdIssue}；${msg}` : msg;
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exit(1);
  }
}

async function cmdChain(cwd: string, json: boolean, action?: string, a?: string, b?: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, storeUnavailableError());
  // 链名 / cwd 都是精确匹配：路径写错时 rename / archive / use 只会说「找不到链」，
  // 跟 switch / adopt 一样先把路径原因带出来，否则会被当成「这条链不存在」
  const cwdIssue = await cwdProblem(cwd);
  try {
    if (!action || action === 'list') {
      const chains = store.listChains(cwd);
      const warnings = cwdIssue ? [cwdIssue] : [];
      // 链尾 = 最后一条 switch_event 的 toRef。只给名字 + id 时看不出这条链停在哪一家，
      // 也看不出链尾文件是否还在（在的话下次 switch 才接得上，不在就是 doctor 的 brokenTips）
      const tips = new Map<string, { provider: string; sessionId: string; filePath: string; missing: boolean }>();
      for (const c of chains) {
        let last: ReturnType<typeof store.listSwitchEvents>[number] | undefined;
        try {
          last = store.listSwitchEvents(c.id).at(-1);
        } catch (error) {
          warnings.push(`链「${c.name}」的切换记录读不出来：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!last?.toRef) continue;
        const missing = !(await stat(last.toRef.filePath).then(() => true, () => false));
        tips.set(c.id, {
          provider: last.toRef.provider,
          sessionId: last.toRef.sessionId,
          filePath: last.toRef.filePath,
          missing,
        });
        if (missing && c.status === 'active') {
          warnings.push(
            `链「${c.name}」的链尾会话文件已不存在（${last.toRef.provider}:${last.toRef.sessionId}）：下次切换会失败，可先 watch adopt ${last.toRef.provider} --session <id> 重新绑定`,
          );
        }
      }
      if (json) {
        console.log(JSON.stringify({
          ok: true,
          cwd,
          chains: chains.map((c) => ({ ...c, ...(tips.has(c.id) ? { tip: tips.get(c.id) } : {}) })),
          ...(warnings.length ? { warnings } : {}),
        }));
        return;
      }
      for (const warning of warnings) console.error(`警告: ${warning}`);
      if (!chains.length) {
        console.log('（无链）');
        return;
      }
      // 「当前」= 活跃链里 last_used_at 最新的一条（与 status / switch 的默认链同一判定）。
      // 以前只给名字 + id：同一目录多条链时看不出哪条在用、哪条最近没动（--json 一直有 lastUsedAt）
      const current = store.findActiveChain(cwd);
      console.log(`链（cwd: ${cwd}）:`);
      for (const c of chains) {
        const mark = c.status === 'archived' ? ' [归档]' : '';
        const here = current && c.id === current.id ? ' ← 当前' : '';
        const tip = tips.get(c.id);
        const tipText = tip
          ? `  → ${tip.provider}:${tip.sessionId}${tip.missing ? '（链尾文件已不存在）' : ''}`
          : '';
        console.log(`  ${c.name}${mark}${here}  ${c.id}  lastUsed=${fmtTime(c.lastUsedAt)}${tipText}`);
      }
      return;
    }
    if (action === 'new') {
      if (!a) usage();
      const chain = store.createChain(cwd, a);
      // 与 watch new 同理：路径错了照样建出链，但绑定指向不存在的项目，必须说明
      if (json) console.log(JSON.stringify({ ok: true, chain, ...(cwdIssue ? { warnings: [cwdIssue] } : {}) }));
      else {
        if (cwdIssue) console.error(`警告: ${cwdIssue}`);
        console.log(`已创建链: ${chain.name}  (${chain.id})`);
      }
      return;
    }
    if (action === 'rename') {
      if (!a || !b) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(store.missingChainMessage(cwd, a));
      const chain = store.renameChain(found.id, b);
      if (json) console.log(JSON.stringify({ ok: true, chain }));
      else console.log(`已重命名: ${chain.name}  (${chain.id})`);
      return;
    }
    if (action === 'archive') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(store.missingChainMessage(cwd, a));
      store.archiveChain(found.id);
      if (json) console.log(JSON.stringify({ ok: true, id: found.id }));
      else console.log(`已归档: ${found.name}`);
      return;
    }
    if (action === 'use') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(store.missingChainMessage(cwd, a));
      if (found.status === 'archived') throw new Error(`链已归档: ${found.name}`);
      store.touchChain(found.id);
      if (json) console.log(JSON.stringify({ ok: true, chain: { ...found, lastUsedAt: Date.now() } }));
      else console.log(`当前链: ${found.name}  (${found.id})`);
      return;
    }
    usage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(json, cwdIssue ? `${cwdIssue}；${message}` : message);
  }
}

/**
 * 每个命令真正消费的参数。`parseArgs` 只挡未知 flag（白名单是全局的），
 * `--chain` 给 `recent`、`--session` 给 `status` 这类「认识但不吃」的组合以前被静默忽略，
 * 用户会以为已经按链过滤 / 指定了会话。`--cwd` / `--json` 全局有效，不参与校验。
 */
const FLAGS_BY_COMMAND: Record<string, string[]> = {
  status: ['chain'],
  switch: ['chain'],
  adopt: ['chain', 'session'],
  sessions: ['chain'],
  recent: ['limit'],
  providers: [],
  doctor: [],
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
  if (process.argv[2] === 'import-codex') {
    await runImportCodex(process.argv.slice(3));
    return;
  }
  const { cmd, target, extra, rest, json, cwd, session, chain, from, provider, to, check, limit, usedFlags, cwdGiven, positional } = parseArgs(process.argv);
  if (cmd) {
    rejectUnusedFlags(cmd, usedFlags, json);
    rejectExtraPositionals(cmd, positional, json);
  }
  if (cmd === 'status') {
    await cmdStatus(cwd, json, chain);
    return;
  }
  if (cmd === 'switch') {
    if (!target) usage();
    await cmdSwitch(cwd, target, json, chain);
    return;
  }
  if (cmd === 'adopt') {
    if (!target) usage();
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
  if (cmd === 'doctor') {
    await cmdDoctor(cwd, json);
    return;
  }
  if (cmd === 'new') {
    if (!target) usage();
    await cmdNew(cwd, target, json, chain);
    return;
  }
  if (cmd === 'chain') {
    await cmdChain(cwd, json, target, rest[0] ?? extra, rest[1]);
    return;
  }
  if (cmd === 'search') {
    const q = [target, ...rest].filter(Boolean).join(' ');
    if (!q) usage();
    await cmdSearch(cwd, json, q);
    return;
  }
  if (cmd === 'usage') {
    await cmdUsage(cwd, json, chain);
    return;
  }
  if (cmd === 'open') {
    if (!target) usage();
    await cmdOpen(target, json, from, provider, to, check, cwdGiven);
    return;
  }
  usage();
}

async function cmdUsage(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  try {
    const result = await chainUsage(cwd, listAdapters(), store, chain);
    const cwdIssue = await cwdProblem(cwd);
    if (cwdIssue) result.warnings.push(cwdIssue);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (result.chain) {
      console.log(`链: ${result.chain.name}  (${result.chain.id})`);
    } else if (chain) {
      console.log(`链: ${chain}`);
    }
    // 警告必须先打：本地库不可用时 byProvider 也是空的，先 return 会把「读不出来」说成「没有绑定会话」
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    if (!result.byProvider.length) {
      if (result.unsupported?.length) {
        // 链上有绑定、只是这家适配器不给用量：说成「无链」会把有链的工作当成没链
        console.log(`链上有绑定（${result.unsupported.join('、')}），但这些适配器不提供用量数据`);
        return;
      }
      console.log(result.warnings.length ? '（无可统计的用量；原因见上方警告）' : '无链或该链无绑定会话');
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
    const msg = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
}

async function cmdSearch(cwd: string, json: boolean, query: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, storeUnavailableError());
  try {
    const warnings: string[] = [];
    const cwdIssue = await cwdProblem(cwd);
    if (cwdIssue) warnings.push(cwdIssue);
    await reindexCwd(cwd, listAdapters(), store, warnings);
    // 三种上限各自独立：全局 40 条、单会话 3 条、session id 前缀 10 条；只说「truncated」会混淆是哪一种
    const { hits, truncated, perSessionCapped, idPrefixCapped } = store.searchMessagesWithMeta(query, cwd);
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        query,
        cwd,
        hits,
        ...(truncated ? { truncated: true } : {}),
        ...(perSessionCapped ? { perSessionCapped: true } : {}),
        ...(idPrefixCapped ? { idPrefixCapped: true } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
      return;
    }
    for (const warning of warnings) console.error(`警告: ${warning}`);
    if (!hits.length) {
      console.log('无结果');
      return;
    }
    for (const h of hits) {
      console.log(`${h.provider}  ${h.sessionId}`);
      console.log(`  ${h.snippet.replace(/\s+/g, ' ')}`);
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
    fail(json, error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
