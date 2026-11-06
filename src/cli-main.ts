#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SEARCH_MAX_HITS, Store, defaultDbPath } from './core/store.js';
import { describeFindings } from './core/findings.js';
import { adoptIntoChain, chainStatus, chainUsage, collectTips, createChainSession, handoff, HandoffBlockedError } from './core/handoff.js';
import { reindexCwd } from './core/search.js';
import type { SessionRef } from './core/types.js';
import { getAdapter, listAdapters, listProviders } from './providers/registry.js';
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

function usage(): never {
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
        error: help ? '已打印用法到 stderr（--json 模式下不输出结果）' : '用法错误：参数不完整或不合法（完整用法见 stderr）',
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
} {
  const args = argv.slice(2);
  const json = args.includes('--json');
  let cwd = process.cwd();
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
  const takeValue = (): string => {
    const next = args[++i];
    if (!next || next.startsWith('--')) usage();
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
      cwd = takeValue();
      continue;
    }
    if (a === '--session') {
      session = takeValue();
      continue;
    }
    if (a === '--chain') {
      chain = takeValue();
      continue;
    }
    if (a === '--from') {
      from = takeValue();
      continue;
    }
    if (a === '--provider') {
      provider = takeValue();
      continue;
    }
    if (a === '--to') {
      to = takeValue();
      continue;
    }
    if (a === '--limit') {
      const raw = takeValue();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 50) usage();
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
      if (!adapter?.listSessions) throw new Error(`未知 provider: ${providerId}`);
      const all = await adapter.listSessions(cwd);
      const hit = all.find((s) => s.ref.sessionId === sessionId);
      if (!hit) {
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
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    // 与 switch 一致：警告先打（未写入链记录这类说明不能排在成功之后被漏看），且走 stderr
    for (const warning of result.warnings) console.error(`警告: ${warning}`);
    console.log(`已接入链: ${result.adoptedRef.sessionId}`);
    if (result.replacedRef) console.log(`替换了:  ${result.replacedRef.sessionId}`);
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
): Promise<void> {
  try {
    if (check) {
      if (!toId) fail(json, '--check 需要同时指定 --to <provider>');
      const checked = await checkOpenInProvider(targetId, toId);
      if (json) {
        console.log(JSON.stringify(checked));
        process.exit(checked.ok ? 0 : 1);
      }
      if (!checked.ok) fail(false, checked.error ?? '预检失败');
      const target = checked.sessionId ? `${checked.sessionId}` : '（将新建会话）';
      console.log(`预检：${checked.plan?.kind ?? '?'} · 目标 ${target} · ${checked.writable ? '可写入' : '暂不可写'}`);
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
    if (!result.ok) {
      // 目标被占用等写入拒绝：带上结构化原因，供桌面端/脚本给出可操作提示（未写入任何内容）
      const extra = result.blocked ? { blocked: true, ...result.blocked } : undefined;
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
  // 按链过滤：只显示当前链 switch_events 里绑定过的会话
  const bound = new Map<string, Set<string>>();
  if (!store && chain) {
    // 用户明确要按链过滤却打不开库：不说是「已忽略」，列表看起来就像链上会话
    warnings.push(`本地库不可用，--chain ${chain} 过滤已忽略，下面是该目录的全部会话`);
  }
  if (store) {
    try {
      const chainRow = chain ? store.findActiveChain(cwd, chain) : store.findActiveChain(cwd);
      if (chainRow) {
        for (const h of store.listSwitchEvents(chainRow.id)) {
          if (h.fromProvider && h.fromRef) {
            bound.set(h.fromProvider, (bound.get(h.fromProvider) ?? new Set()).add(h.fromRef.sessionId));
          }
          if (h.toRef) {
            bound.set(h.toProvider, (bound.get(h.toProvider) ?? new Set()).add(h.toRef.sessionId));
          }
        }
      } else if (chain) {
        warnings.push(`未找到链 ${chain}（cwd=${cwd}），已列出该目录全部会话`);
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
          // 撞到适配器上限时列表只是「最近 N 个」：不标出来会被当成全集
          const capped = a.listSessionsCap !== undefined && sessions.length >= a.listSessionsCap;
          return {
            provider: a.id,
            sessions: ids ? sessions.filter((s) => ids.has(s.ref.sessionId)) : sessions,
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

async function cmdRecent(cwd: string, json: boolean, limit: number = 8): Promise<void> {
  const store = openStore();
  type RecentItem = {
    provider: string;
    sessionId: string;
    cwd: string;
    updatedAt: number;
    preview?: string;
  };
  const results: RecentItem[] = [];
  const seen = new Set<string>();
  const unavailable: string[] = [];
  const warnings: string[] = [];
  const cwdIssue = await cwdProblem(cwd);
  if (cwdIssue) warnings.push(cwdIssue);

  if (!store) unavailable.push('本地库');
  if (store) {
    try {
      const locations = store.listSessionLocations({ limit: limit * 2 });
      for (const loc of locations) {
        if (results.length >= limit) break;
        const key = `${loc.provider}:${loc.sessionId}`;
        if (seen.has(key)) continue;
        try {
          const st = await stat(loc.filePath);
          if (st.isFile()) {
            seen.add(key);
            results.push({
              provider: loc.provider,
              sessionId: loc.sessionId,
              cwd: loc.cwd,
              updatedAt: loc.lastSeenAt || st.mtimeMs,
            });
          }
        } catch {
          // File not found or inaccessible
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
      for (const s of sessions) {
        const key = `${s.ref.provider}:${s.ref.sessionId}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            provider: s.ref.provider,
            sessionId: s.ref.sessionId,
            cwd: s.ref.cwd,
            updatedAt: s.updatedAt,
            preview: s.preview,
          });
        }
      }
    } catch {
      // 单家读失败不拖垮列表，但要披露
      unavailable.push(adapter.id);
    }
  }

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
    console.log(`  [${s.provider}] ${s.sessionId} (${s.cwd})`);
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
      if (chain && !id) fail(json, `找不到链: ${chain}`);
      historyLen = id ? store.listSwitchEvents(id).length : 0;
    }
    // 空链：优先用 nezha 式 createEmptySession 预创建可 resume 的空会话，
    // 不再 exec 发首条消息；由桌面端 PTY 执行 resume 命令后用户直接在 TUI 交互。
    // 没有 createEmptySession 的 provider 才回退到 start（exec 等首条回复，慢）。
    if (historyLen === 0) {
      const adapter = getAdapter(providerId);
      if (!adapter) fail(json, `未知 provider: ${providerId}`);
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
      if (json) {
        console.log(JSON.stringify({ ok: true, cwd, chains, ...(warnings.length ? { warnings } : {}) }));
        return;
      }
      for (const warning of warnings) console.error(`警告: ${warning}`);
      if (!chains.length) {
        console.log('（无链）');
        return;
      }
      for (const c of chains) {
        const mark = c.status === 'archived' ? ' [归档]' : '';
        console.log(`  ${c.name}${mark}  ${c.id}`);
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
      if (!found) throw new Error(`找不到链: ${a}`);
      const chain = store.renameChain(found.id, b);
      if (json) console.log(JSON.stringify({ ok: true, chain }));
      else console.log(`已重命名: ${chain.name}  (${chain.id})`);
      return;
    }
    if (action === 'archive') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(`找不到链: ${a}`);
      store.archiveChain(found.id);
      if (json) console.log(JSON.stringify({ ok: true, id: found.id }));
      else console.log(`已归档: ${found.name}`);
      return;
    }
    if (action === 'use') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(`找不到链: ${a}`);
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

async function main(): Promise<void> {
  if (process.argv[2] === 'import-codex') {
    await runImportCodex(process.argv.slice(3));
    return;
  }
  const { cmd, target, extra, rest, json, cwd, session, chain, from, provider, to, check, limit } = parseArgs(process.argv);
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
    await cmdRecent(cwd, json, limit);
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
    await cmdOpen(target, json, from, provider, to, check);
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
      console.log(result.warnings.length ? '（无可统计的用量；原因见上方警告）' : '无链或该链无绑定会话');
      return;
    }
    // 合计只是「已知用量之和」：读取失败与「原生没有 usage 字段」都不在其中，两种都要说出来
    const missing: string[] = [];
    if (result.totalExcluded) missing.push(`${result.totalExcluded} 个读取失败的会话`);
    if (result.totalMissingUsage) missing.push(`${result.totalMissingUsage} 个无 usage 数据的会话`);
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
        `  ${item.provider.padEnd(8)} ${item.sessionId.slice(0, 8)}…  in=${u.inputTokens}  out=${u.outputTokens}${note}`,
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
